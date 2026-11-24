"""Exercise the trusted controller's saved boundary independently from its PostgreSQL integration."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("closed_report_controller", ROOT / "scripts/deploy/archive-closed-worker-reports.py")
controller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(controller)


class ClosedReportOperator(unittest.TestCase):
    def test_rotating_high_byte_owners_keeps_original_rows_and_ordinary_turns_after_restart(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            normal, hi, other = [f"{i:08}-1111-4111-8111-111111111111" for i in (1,2,3)]
            rows = [(normal,n) for n in range(3,9)] + [(hi,n) for n in range(3,8)] + [(other,n) for n in range(3,7)]
            keys = [dict(executionId=j,sequence=n,signature="a"*64) for j,n in rows]
            source = root/"keys.jsonl"
            source.write_bytes(b"".join(controller.compact(k)+b"\n" for k in keys))
            scope = root/"scope.json"
            controller.durable(scope,dict(version=1,sourceInstance=hi,solverId=normal,
                                          executions=[dict(executionId=normal,reportAfter=0,reportHighWater=1)]))
            args = SimpleNamespace(keys=source, keys_sha256=controller.digest(source.read_bytes()),apply=True,
                frozen_scope=scope,frozen_sha256=controller.digest(controller.compact(json.loads(scope.read_bytes()))),
                state=root/"state",runtime_revision="b"*40,hz_host="hz",hz_api="api",hz_sweeper="worker",
                hub_host="hub",hub_sweeper="svc",limit=1,page_members=1)
            writes, lost = [], []
            def peer(_args, role, message, _program):
                op, key = message["op"], message["key"]
                identity = key["executionId"], key["sequence"]
                if op == "source":
                    return dict(source={"facts":{}},stored=1200,archivedBundle=None)
                if op in ("cloud","hub"):
                    return dict(science={})
                if op == "publish":
                    return dict(**key, generation=str(key["sequence"]), reportByteSize=18*1024**2)
                if op == "settle":
                    writes.append(identity)
                    return dict(outcome="retired")
                if op == "read" and role=="api" and message["committed"] and identity==(hi,5) and not lost:
                    lost.append(identity)
                    raise OSError("postcommit retry")
                return dict(storedFieldBytes=100)
            with patch.object(controller,"run_peer",side_effect=peer), patch.object(controller.subprocess,"check_output",return_value=b"runtime"):
                controller.run(args)
                hint=root/"priority"
                controller.durable(hint,dict(version=2,inventory=args.keys_sha256,blockMembers=2,
                    owners=[dict(executionId=hi,ranges=[[3,6]],firstSequence=5),dict(executionId=other,ranges=[[3,6]])]))
                args.priority_turn, args.priority_turn_sha256 = hint, controller.digest(hint.read_bytes())
                with self.assertRaisesRegex(OSError,"postcommit retry"):
                    controller.run(args)
                hint.unlink()
                controller.run(args)
                p=json.loads((args.state/"progress.json").read_bytes())
                order=p["sourceOrder"]
                self.assertEqual((order["priorityKeys"],order["ordinaryKeys"]),(8,6))
                with source.open("rb") as fp:
                    v=controller.OrderedInventory(fp,order["spans"],order["sizes"])
                    v.seek(p["after"])
                    self.assertEqual(v.page_limit(4,p["lastPriorityMember"]),1)
                for _ in rows:
                    controller.run(args)
                self.assertEqual(writes,[(normal,3),(hi,5),(hi,6),(normal,4),(normal,5),(other,3),(other,4),
                    (normal,6),(normal,7),(hi,3),(hi,4),(normal,8),(hi,7),(other,5),(other,6)])
                self.assertCountEqual(writes,rows)
                p=json.loads((args.state/"progress.json").read_bytes())
                self.assertEqual((p["completed"],p["after"]),(len(rows),source.stat().st_size))
                from closed_worker_report_fair_order import fair_order
                next_hint = dict(blockMembers=2, owners=[dict(executionId=hi,ranges=[[3,6]],firstSequence=3),
                                                       dict(executionId=other,ranges=[[3,6]])])
                with source.open("rb") as fp:
                    for _ in range(8):
                        fp.readline()
                    offset=fp.tell()
                    replacement=fair_order(fp,[[offset,source.stat().st_size]],[[0,offset]],next_hint,
                                           "qualified",lambda k: controller.check_key(k,{}),start_ordinary=True)
                    self.assertEqual(replacement["priorityStarts"],{})
                    self.assertTrue(replacement["startsWithOrdinary"])
                    reader=controller.OrderedInventory(fp,replacement["spans"],replacement["sizes"])
                    reader.seek(offset)
                    remaining=[json.loads(reader.readline(2049)) for _ in rows[8:]]
                    self.assertEqual(remaining,[keys[i] for i in (10,8,9,11,12,13,14)])

    def test_priority_turn_recovers_the_same_writer_and_conserves_the_displaced_keys(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            job = "11111111-1111-4111-8111-111111111111"
            keys = [dict(executionId=job,sequence=n,signature="a"*64) for n in range(3,11)]
            lines = [controller.compact(key)+b"\n" for key in keys]
            source = root/"keys.jsonl"
            source.write_bytes(b"".join(lines))
            scope = root/"scope.json"
            controller.durable(scope, dict(version=1,sourceInstance=job,solverId=job,
                                           executions=[dict(executionId=job,reportAfter=0,reportHighWater=2)]))
            args = SimpleNamespace(keys=source, keys_sha256=controller.digest(source.read_bytes()),
                                   frozen_scope=scope,frozen_sha256=controller.digest(controller.compact(json.loads(scope.read_bytes()))),
                                   state=root/"state",runtime_revision="b"*40,hz_host="hz",hz_api="api",hz_sweeper="worker",
                                   hub_host="hub",hub_sweeper="svc",limit=1,apply=True,page_members=1)
            published, settled, lost = [], [], set()
            def peer(_args, role, message, _program):
                if message["op"] == "discover-worker":
                    if message["after"]["sequence"]:
                        return dict(keys=[],scanned=0,last=None)
                    return dict(keys=[dict(keys[-1],sequence=11)],scanned=1,last=dict(executionId=job,sequence=11))
                if message["op"] == "discover-hub":
                    return dict(keys=message["keys"])
                op, n = message["op"], message["key"]["sequence"]
                if op == "source":
                    return dict(source={"facts":{}},stored=2000,archivedBundle=None)
                if op in ("hub", "cloud"):
                    return dict(science={})
                if op == "publish":
                    published.append(n)
                    return dict(generation=str(n))
                if op == "settle":
                    settled.append(n)
                    return dict(outcome="retired")
                if op == "read" and role == "api" and message["committed"] and n in (3,7) and n not in lost:
                    lost.add(n)
                    raise OSError("post-commit read lost")
                return dict(storedFieldBytes=100)

            def hint(indices, corrupt=False):
                values = [{"key":keys[i], "byteSize":18*1024**2} for i in indices]
                if corrupt:
                    values[0] = dict(key=dict(keys[indices[0]], signature="c"*64))
                file = root/"hint.json"
                controller.durable(file,dict(version=1,inventory=args.keys_sha256,keys=values,
                                             offset=sum(map(len,lines[:indices[0]]))))
                args.priority_turn = file
                args.priority_turn_sha256 = controller.digest(file.read_bytes())

            with patch.object(controller,"run_peer",side_effect=peer),patch.object(controller.subprocess,"check_output",return_value=b"runtime"):
                with self.assertRaisesRegex(OSError,"post-commit"):
                    controller.run(args)
                hint([4,5])
                controller.run(args)
                self.assertEqual(published, [3])
                hint([4,5], corrupt=True)
                with self.assertRaisesRegex(ValueError,"different from the signed inventory"):
                    controller.run(args)
                hint([4,5])
                with self.assertRaisesRegex(OSError,"post-commit"):
                    controller.run(args)
                progress = json.loads((args.state/"progress.json").read_bytes())
                self.assertIn("sourceOrderSha256",progress["binding"])
                self.assertEqual(progress["pending"]["key"],keys[4])
                with source.open("rb") as f:
                    view = controller.OrderedInventory(f,progress["sourceOrder"]["spans"],progress["sourceOrder"]["sizes"])
                    view.seek(progress["after"])
                    self.assertEqual(view.page_limit(4),1)
                    self.assertEqual(view.tell(), progress["after"])
                args.priority_turn.unlink()
                controller.run(args)
                controller.run(args)
                args.priority_turn = None
                hint([7])
                for _ in range(6):
                    controller.run(args)
                self.assertEqual(published,[3,7,8,10,4,5,6,9])
                self.assertEqual(settled,published)
                final = json.loads((args.state/"progress.json").read_bytes())
                self.assertEqual((final["completed"],final["after"]),(len(keys),sum(map(len,lines))))
                self.assertEqual(source.read_bytes(), b"".join(lines))
                args.priority_turn.unlink()
                args.discover_after_seed, args.scan_rows, args.discovery_interval = True, 2, 900
                for _ in range(3):
                    controller.run(args)
                self.assertEqual(published, [3,7,8,10,4,5,6,9,11])
                self.assertEqual(settled, published)
                self.assertEqual(json.loads((args.state/"discovery/cursor.json").read_bytes())["pass"], 2)

    def test_pending_generation_holds_and_postcommit_replay(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            job = "11111111-1111-4111-8111-111111111111"
            scope = {"version":1,"sourceInstance":job,"solverId":job,
                     "executions":[{"executionId":job,"reportAfter":0,"reportHighWater":2}]}
            frozen = root / "scope.json"
            frozen.write_bytes(controller.compact(scope))
            keys = [{"executionId":job,"sequence":n,"signature":"a"*64} for n in (3,4,5)]
            with self.assertRaisesRegex(ValueError,"frozen operator"):
                controller.check_key(dict(keys[0],sequence=2),{job:scope["executions"][0]})
            inventory = root / "keys.jsonl"
            inventory.write_bytes(b"".join(controller.compact(k)+b"\n" for k in keys))
            args = SimpleNamespace(runtime_revision="a"*40,hz_host="worker",hub_host="hub",hz_api="api",hz_sweeper="sweeper",
                                   hub_sweeper="sweeper",apply=True,limit=3,frozen_scope=frozen,frozen_sha256=controller.digest(frozen.read_bytes()),
                                   keys=inventory,keys_sha256=controller.digest(inventory.read_bytes()),state=root/"state")
            operations = []
            lose = [True]
            later = [False]
            source = {"facts":{}}
            def peer(_args,role,message,_program):
                op,seq=message["op"],message["key"]["sequence"]
                operations.append((seq,role,op))
                if seq==3 and not later[0]:
                    return {"held":"unsettled earlier scientific receipt"}
                if op=="source":
                    return {"source":source,"stored":900,"archivedBundle":None}
                if op=="hub":
                    return {"science":{}}
                if op=="publish":
                    return {"generation":str(seq)}
                if op=="cloud":
                    return {"science":{}}
                if op=="settle":
                    return {"outcome":"retired"}
                if seq==4 and role=="api" and message["committed"] and lose[0]:
                    lose[0]=False
                    raise OSError("post-commit connection lost")
                return {"storedFieldBytes":100}
            with patch.object(controller,"run_peer",side_effect=peer),patch.object(controller.subprocess,"check_output",return_value=b"runtime"):
                with self.assertRaisesRegex(OSError,"post-commit"):
                    controller.run(args)
                p=json.loads((args.state/"progress.json").read_text())
                self.assertEqual((p["completed"],p["held"],p["archived"]),(1,1,0))
                self.assertEqual(p["pending"]["pin"]["generation"],"4")
                self.assertEqual(p["pending"]["settled"]["outcome"],"retired")
                controller.run(args)
                p=json.loads((args.state/"progress.json").read_text())
                self.assertEqual((p["completed"],p["held"],p["archived"],p["pending"]),(3,1,2,None))
                for seq in (4,5):
                    self.assertEqual(operations.count((seq,"worker","publish")),1)
                    self.assertEqual(operations.count((seq,"worker","settle")),1)
                self.assertEqual(json.loads((args.state/"receipts/00000001.json").read_text())["committedStoredFieldBytes"],100)
                held_path=args.state/"receipts/00000000.json"
                original=held_path.read_bytes()
                args.recheck_held_index=0;later[0]=True
                controller.run(args)
                controller.run(args)
                self.assertEqual(held_path.read_bytes(),original)
                self.assertEqual(operations.count((3,"worker","publish")),1)
                resolved=list((args.state/"rechecks").glob("*/resolution.json"))
                self.assertEqual(len(resolved),1)
                self.assertEqual(json.loads(resolved[0].read_bytes())["outcome"],"retired")
                with self.assertRaisesRegex(ValueError,"inventory changed"):
                    controller.run(SimpleNamespace(**{**vars(args),"keys_sha256":"0"*64}))

    def test_finished_inventory_discovers_new_closed_keys_and_resumes_one_page(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);job="11111111-1111-4111-8111-111111111111"
            seed={"executionId":job,"sequence":5,"signature":"a"*64}
            frozen={"version":1,"sourceInstance":job,"solverId":job,
                    "executions":[{"executionId":job,"reportAfter":0,"reportHighWater":2}]}
            scope=root/"scope.json";scope.write_bytes(controller.compact(frozen))
            keys=root/"seed.jsonl";keys.write_bytes(controller.compact(seed)+b"\n")
            args=SimpleNamespace(runtime_revision="a"*40,hz_host="hz",hub_host="hub",hz_api="api",hz_sweeper="sweeper",
                    hub_sweeper="sweeper",apply=True,limit=1,frozen_scope=scope,frozen_sha256=controller.digest(scope.read_bytes()),
                    keys=keys,keys_sha256=controller.digest(keys.read_bytes()),state=root/"state",
                    scan_rows=4,discovery_interval=900,discover_after_seed=True)
            selected=[];discovery=[]
            def rpc(_args,role,m,_program):
                op=m["op"]
                if op=="discover-worker":
                    discovery.append(m["after"]["sequence"])
                    if m["after"]["sequence"]==0:
                        return {"scanned":4,"keys":[dict(seed,sequence=n) for n in (2,6,7,8)],"last":{"executionId":job,"sequence":8}}
                    return {"scanned":0,"last":None,"keys":[]}
                if op=="discover-hub":
                    self.assertEqual([k["sequence"] for k in m["keys"]],[6,7,8])
                    return {"keys":m["keys"][1:]}
                if op=="source":
                    selected.append(m["key"]["sequence"])
                    return {"held":"scientific evidence still required"}
                self.fail(f"Unexpected write {op}")
            with patch.object(controller,"run_peer",side_effect=rpc),patch.object(controller.subprocess,"check_output",return_value=b"runtime"):
                for _ in range(5):
                    controller.run(args)
                self.assertEqual(selected,[5,7,8])
                self.assertEqual(discovery,[0,8])
                final=json.loads((args.state/"discovery/cursor.json").read_bytes())
                self.assertEqual((final["pass"],final["held"],final["archived"],final["page"]),(2,2,0,None))
                self.assertTrue((args.state/"discovery/pass-000001.json").is_file())

    def test_group_resumes_committed_generation_before_visiting_next_key(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);job="11111111-1111-4111-8111-111111111111"
            frozen={"version":1,"sourceInstance":job,"solverId":job,"executions":[{"executionId":job,"reportHighWater":1}]}
            scope=root/"scope.json";scope.write_bytes(controller.compact(frozen))
            keys=[{"executionId":job,"sequence":n,"signature":"a"*64} for n in (3,4,5)]
            inventory=root/"keys.jsonl";inventory.write_bytes(b"".join(controller.compact(k)+b"\n" for k in keys))
            account=root/"account";account.write_text("fixture@fixture.iam.gserviceaccount.com")
            args=SimpleNamespace(runtime_revision="a"*40,hz_host="worker",hub_host="hub",hz_api="api",hz_sweeper="sweeper",hub_sweeper="sweeper",
               apply=True,limit=3,frozen_scope=scope,frozen_sha256=controller.digest(scope.read_bytes()),keys=inventory,keys_sha256=controller.digest(inventory.read_bytes()),
               state=root/"state",page_members=3,hub_account_file=account)
            observed=[];lost=[True];hub_stopped=[False]
            def rpc(_args,role,m,_peer):
                op=m["op"];n=len(m["items"]);observed.append((op,role,n))
                if op=="source":return {"rows":[{"source":{"facts":{"byteSize":20}},"stored":10} for _ in range(n)]}
                if op=="hub":return {"rows":[{"science":{}} for _ in range(n)]}
                if op=="publish":return {"pins":[dict(generation="1",storedSha256="b"*64,**k) for k in keys],"deltaMembers":2}
                if op=="cloud" and hub_stopped[0]:
                    error = controller.ReadPeerStopped("hub")
                    error.keys = [x["key"] for x in m["items"]]
                    raise error
                if op=="cloud":return {"rows":[{"science":{}} for _ in range(n)],"generationDownloads":1}
                if op=="settle":return {"rows":[{"outcome":"retired"} for _ in range(n)]}
                if role=="api" and m["committed"] and lost[0]:
                    lost[0]=False
                    raise OSError("post-commit loss")
                return {"rows":[{"storedFieldBytes":2} for _ in range(n)]}
            with patch.object(controller,"run_peer",side_effect=rpc),patch.object(controller.subprocess,"check_output",return_value=b"runtime"):
                with self.assertRaisesRegex(OSError,"post-commit"):
                    controller.run(args)
                self.assertEqual(json.loads((args.state/"progress.json").read_bytes())["after"],0)
                args.page_members=1;args.limit=1
                hub_stopped[0] = True
                args.pause_file, args.reuse_read_passes = root/"pause", 1
                snapshot = (args.state/"progress.json").read_bytes()
                def restored(pause, delay):
                    self.assertEqual((pause, delay), (args.pause_file, 10))
                    self.assertEqual((args.state/"progress.json").read_bytes(), snapshot)
                    self.assertFalse((args.state/"receipts/00000000.page.json").exists())
                    hub_stopped[0] = False
                    return True
                with patch.object(controller,"wait_for_read_peer",side_effect=restored) as wait:
                    controller.run_invocations(args)
                self.assertEqual(wait.call_count, 1)
                result=json.loads((args.state/"progress.json").read_bytes())
                self.assertEqual((result["completed"],result["archived"],result["after"]),(3,3,inventory.stat().st_size))
                self.assertEqual(observed.count(("publish","worker",3)),1)
                self.assertEqual(observed.count(("settle","worker",3)),1)
                self.assertEqual(json.loads((args.state/"receipts/00000000.page.json").read_bytes())["keys"],keys)

    def test_changed_scientific_rule_replays_the_complete_held_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            state=Path(tmp); receipts=state/"receipts";receipts.mkdir()
            bind={"inventory":"original"};keys=[{"executionId":"11111111-1111-4111-8111-111111111111",
                                                 "sequence":n,"signature":"b"*64} for n in (8,9)]
            old=[]
            for n,key in enumerate(keys):
                file=receipts/f"{n:08d}.json"
                controller.durable(file,{"key":key,"binding":bind,"settled":{"outcome":"held"}})
                old.append(file.read_bytes())
            args=SimpleNamespace(state=state,recheck_held_through=2)
            calls=[]
            def process(sub):
                calls.append(sub.keys_sha256)
                self.assertFalse(sub.discover_after_seed)
                self.assertIsNone(sub.recheck_held_through)
                self.assertEqual([json.loads(x)for x in sub.keys.read_bytes().splitlines()],keys)
                sub.state.mkdir(exist_ok=True);(sub.state/"receipts").mkdir(exist_ok=True)
                if len(calls)==1:
                    controller.durable(sub.state/"progress.json",{"after":0,"group":{"verified":False}})
                else:
                    controller.durable(sub.state/"receipts/00000000.page.json",dict(keys=keys,settled=[{"outcome":"retired"} for _ in keys]))
                    controller.durable(sub.state/"progress.json",{"after":sub.keys.stat().st_size,"archived":2,"completed":2,"group":None})
            invoke=lambda:controller.revisit_prefix(args,2,{"completed":2},bind,process,controller.durable,controller.compact,controller.require)
            self.assertTrue(invoke())
            self.assertTrue(invoke())
            self.assertFalse(invoke())
            self.assertEqual(len(set(calls)),1)
            results=[json.loads(f.read_bytes()) for f in (state/"rechecks").glob("*/resolution.json")]
            self.assertEqual(len(results),2)
            self.assertEqual(len({r["receiptSha256"] for r in results}),1)
            self.assertEqual(old,[(receipts/f"{n:08d}.json").read_bytes()for n in (0,1)])

    def test_read_session_refuses_mutations_and_incomplete_frames(self):
        import os
        import closed_worker_report_host as host
        for role in host.ROLE_READS:
            for op in ("settle","publish"):
                with self.assertRaisesRegex(ValueError,"write"):
                    host.allowed(role,{"op":op})
        with self.assertRaisesRegex(ValueError,"Wrong native reader"):
            host.allowed("api",{"op":"read","reader":"sweeper"})
        for frame in [b'{}',b'{}\n{}\n',b'123456789\n']:
            r,w=os.pipe()
            with os.fdopen(w,"wb") as writer:writer.write(frame)
            with os.fdopen(r,"rb") as reader, self.assertRaises((EOFError,ValueError)):
                host.receive(reader,8,1)

    def test_sessions_keep_original_writer_and_pause_after_current_pass(self):
        with tempfile.TemporaryDirectory() as temp:
            marker=Path(temp)/"pause"
            args=SimpleNamespace(reuse_read_passes=4,pause_file=marker,apply=True,measure_rpc=None,
                                runtime_revision="a"*40,hz_host="hz",hub_host="hub",hz_sweeper="h",hz_api="a",hub_sweeper="s")
            calls=[]
            def one_pass(parameters):
                for op in ("source","publish","settle"):
                    self.assertEqual(controller.run_peer(parameters,"worker",{"op":op},"test"),op)
                calls.append(1)
                if len(calls)==2:marker.touch()
            with patch.object(controller,"run",side_effect=one_pass),patch.object(controller,"ReportReadSessions") as sessions,patch.object(controller,"single_request") as cold:
                sessions.return_value.ask.side_effect=lambda a,r,m,s:{"value":m["op"]}
                cold.side_effect=lambda a,r,m,s:{"value":m["op"]}
                controller.run_invocations(args)
                self.assertEqual(len(calls),2)
                self.assertEqual([c.args[2]["op"] for c in cold.call_args_list],["publish","settle"]*2)
                self.assertEqual(sessions.return_value.ask.call_count,2)
                sessions.return_value.close.assert_called_once()

    def test_expired_read_session_reopens_once_and_keeps_source_refusals(self):
        import closed_worker_report_sessions as sessions
        from unittest.mock import Mock
        with patch.object(sessions,"ReportReadSession") as factory:
            pool=sessions.ReportReadSessions()
            first=Mock()
            second=Mock()
            factory.side_effect=[first,second]
            first.ask.side_effect=sessions.ReadTransportLost("idle timeout")
            second.ask.return_value={"value":"fresh"}
            self.assertEqual(pool.ask(None,"hub",{"op":"cloud"},"source"),{"value":"fresh"})
            first.close.assert_called_once()
            second.ask.side_effect=RuntimeError("source refused (75)")
            with self.assertRaisesRegex(RuntimeError,"75"):
                pool.ask(None,"hub",{"op":"cloud"},"source")
            self.assertEqual(factory.call_count,2)
            with self.assertRaises(ValueError):
                pool.ask(None,"worker",{"op":"publish"},"source")
            pool.close()

    def test_only_the_unchanged_stopped_reader_has_an_availability_exit(self):
        from unittest.mock import MagicMock
        import closed_worker_report_host as host
        import closed_worker_report_sessions as sessions
        revision, container = "a"*40, "b"*64
        with patch.object(host.Path, "read_bytes", return_value=json.dumps({"sourceRevision":revision}).encode()), \
             patch.object(host.subprocess, "check_output") as inspect:
            inspect.return_value = f"{container} start false exited"
            with self.assertRaises(SystemExit) as stopped:
                host.current_container(revision, "hub", [container,"start"])
            self.assertEqual(stopped.exception.code, host.READ_CONTAINER_STOPPED)
            for rev, lease in [(revision,["c"*64,"start"]), ("d"*40,[container,"start"])]:
                with self.assertRaises(SystemExit) as changed:
                    host.current_container(rev, "hub", lease)
                self.assertEqual(changed.exception.code, 75)
            inspect.return_value = "malformed"
            with self.assertRaises(ValueError):
                host.current_container(revision, "hub")
        session = sessions.ReportReadSession.__new__(sessions.ReportReadSession)
        session.child, session.count = MagicMock(), 0
        with patch.object(sessions,"send"), patch.object(sessions,"receive",return_value=None) as receive:
            session.child.wait.return_value = host.READ_CONTAINER_STOPPED
            with self.assertRaises(sessions.ReadPeerStopped):
                session.ask("hub", {"op":"cloud"})
            session.child.wait.return_value = 65
            with self.assertRaisesRegex(RuntimeError, r"refused \(65\)"):
                session.ask("hub", {"op":"cloud"})
            receive.return_value = {"n":3,"error":"signed source mismatch"}
            with self.assertRaisesRegex(RuntimeError,"signed source mismatch"):
                session.ask("hub", {"op":"cloud"})

    def test_stopped_reader_requires_the_settled_exact_source_and_respects_pause(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            args=SimpleNamespace(apply=True, state=root, limit=16)
            key={"executionId":"1"*36,"sequence":4,"signature":"b"*64}
            pin=dict(key, generation="9", storedSha256="c"*64)
            error=controller.ReadPeerStopped("api")
            error.keys=[key]
            pending=dict(key=key,pin=pin)
            j=root/"progress.json"
            j.write_text(json.dumps({"pending":pending}))
            self.assertIsNone(controller.committed_read_retry(args,error))
            pending["settled"]={"outcome":"retired"}
            j.write_text(json.dumps({"pending":pending}))
            retry=controller.committed_read_retry(args,error)
            self.assertEqual((retry.limit,retry.retry_checkpoint_sha256),(1,controller.digest(j.read_bytes())))
            error.keys=[dict(key,sequence=5)]
            self.assertIsNone(controller.committed_read_retry(args,error))
            pause=root/"pause"
            pause.touch()
            self.assertFalse(controller.wait_for_read_peer(pause,60))

    def test_exact_same_execution_keys_can_span_unowned_sequence_numbers(self):
        import io
        from closed_worker_report_pages import adjacent
        job="1"*36; keys=[dict(executionId=j,sequence=s,signature="b"*64) for j,s in ((job,3),(job,7),(job,9),("2"*36,10))]
        stream=io.BytesIO(b"".join(controller.compact(k)+b"\n"for k in keys))
        self.assertEqual(len(adjacent(stream,4,lambda k:None)),1)
        self.assertEqual([k for k,_ in adjacent(stream,4,lambda k:None,allow_gaps=True)],keys[:3])
        self.assertEqual(stream.tell(),0)

    def test_existing_result_keeps_its_ordinary_order_across_changed_neighbors(self):
        from closed_worker_report_pages import dictionary_prefix
        old = {"knownResult": True, "resultMeta": {"sha256":"a"*64, "byteSize":100}}
        new = {"knownResult": False, "resultMeta": {"sha256":"b"*64, "byteSize":110}}
        other = {"knownResult": False, "resultMeta": {"sha256":"c"*64, "byteSize":120}}
        self.assertEqual(dictionary_prefix([old, old, new]), [old, old])
        self.assertEqual(dictionary_prefix([new, old, old]), [new])
        self.assertEqual(dictionary_prefix([new, other]), [new, other])
        self.assertEqual(dictionary_prefix([]), [])

    def test_wider_page_needs_the_pinned_scope_runtime_and_matching_sources(self):
        import hashlib
        from closed_worker_report_pages import qualified_width, fits_wide_page
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/"limits.json"
            binding={"inventory":"one","frozen":"two","solver":"three"}
            runtime={"reader":"a"*64}
            runtime_digest=hashlib.sha256(json.dumps(runtime,sort_keys=True,separators=(",",":")).encode()).hexdigest()
            limits=dict(maxMemberBytes=20,maxPageBytes=150,maxPointSources=2,maxResultBytes=12,maxEnvelopeBytes=8)
            peer="b"*64
            evidence=Path(tmp)/"live-comparison.json"
            evidence.write_bytes(controller.compact(dict(qualifiedSmallEnvelope=True,scopedSource=binding,comparisonGroupBytes=150,populationPerGeneration=[8,8])))
            config=dict(maxKeysPerInvocation=16,qualificationReceipt=str(evidence),version=1,binding=binding,runtimeSha256=runtime_digest,peerSha256=peer,ordinaryMembers=4,wideMembers=8,
                        qualificationReceiptSha256=controller.digest(evidence.read_bytes()),**limits)
            p.write_bytes(controller.compact(config))
            args=SimpleNamespace(width_qualification=p,width_qualification_sha256=controller.digest(p.read_bytes()),page_members=4,limit=16)
            self.assertEqual(qualified_width(args,binding,runtime,peer),limits)
            self.assertIsNone(qualified_width(args,dict(binding,inventory="prospective"),runtime,peer))
            self.assertIsNone(qualified_width(args,binding,{},peer))
            self.assertIsNone(qualified_width(args,binding,runtime,"d"*64))
            p.write_bytes(b"{}")
            self.assertIsNone(qualified_width(args,binding,runtime,peer))
            p.unlink()
            self.assertIsNone(qualified_width(args,binding,runtime,peer))
            def item(size=16, result="e", points=1):
                return dict(resultMeta={"sha256":result*64,"byteSize":8},source={"facts":{"points":[None]*points,"byteSize":size}})
            rows=[item() for _ in range(8)]
            self.assertTrue(fits_wide_page(rows,limits))
            self.assertTrue(fits_wide_page(rows[:4],limits,prefix=True))
            self.assertFalse(fits_wide_page(rows[:7],limits))
            no_share = [dict(r, resultMeta=dict(r["resultMeta"],byteSize=1)) for r in rows]
            self.assertFalse(fits_wide_page(no_share,limits))
            self.assertFalse(fits_wide_page(rows[:4],dict(limits,maxPageBytes=80),prefix=True))
            for changed in (item(size=21),item(result="f"),item(points=3)):
                self.assertFalse(fits_wide_page([*rows[:-1],changed],limits))
            self.assertFalse(fits_wide_page([item(size=20)for _ in range(8)],limits))

    def test_controller_widens_only_the_measured_four_plus_four_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp); job="44444444-4444-4444-8444-444444444444"
            frozen={"version":1,"sourceInstance":job,"solverId":job,"executions":[{"executionId":job,"reportHighWater":1}]}
            scope=root/"scope.json";scope.write_bytes(controller.compact(frozen))
            keys=[dict(executionId=job,sequence=n,signature="a"*64) for n in range(3,19)]
            source=root/"keys.jsonl";source.write_bytes(b"".join(controller.compact(k)+b"\n" for k in keys))
            account=root/"account";account.write_text("test")
            args=SimpleNamespace(runtime_revision="a"*40,hz_host="hz",hub_host="hub",hz_api="api",hz_sweeper="worker",hub_sweeper="hub-worker",
                apply=True,limit=16,keys=source,keys_sha256=controller.digest(source.read_bytes()),frozen_scope=scope,
                frozen_sha256=controller.digest(scope.read_bytes()),state=root/"state",page_members=4,hub_account_file=account,
                width_qualification=root/"width.json",same_execution_pages=True)
            calls=[]
            def rpc(_args,role,m,_peer):
                items=m["items"];seq=[v["key"]["sequence"] for v in items]
                self.assertEqual(m["key"],items[0]["key"])
                calls.append((m["op"],seq))
                if m["op"]=="source":
                    rows=[]
                    for n in seq:
                        # The next eight exceed the qualified size. Their second half must be read only once.
                        size=16 if n<11 else 160
                        rows.append(dict(stored=size,source={"facts":{"byteSize":size,"points":[{}]}},resultMeta={"sha256":"b"*64,"byteSize":size-4}))
                    return {"rows":rows}
                if m["op"]=="hub":return {"rows":[{"science":{}} for _ in items]}
                if m["op"]=="publish":return {"pins":[{"generation":str(seq[0])}for _ in items],"deltaMembers":len(items)-1}
                if m["op"]=="cloud":return {"rows":[{"science":{}}for _ in items],"generationDownloads":1}
                if m["op"]=="settle":return {"rows":[{"outcome":"retired"}for _ in items]}
                return {"rows":[{"storedFieldBytes":5}for _ in items]}
            with patch.object(controller.subprocess,"check_output",return_value=b"runtime"),patch.object(controller,"run_peer",side_effect=rpc):
                _s,_ranges,binding,runtime,peer=controller.inputs(args)
                evidence=root/"qualified.json"
                evidence.write_bytes(controller.compact(dict(qualifiedSmallEnvelope=True,scopedSource=binding,comparisonGroupBytes=144,populationPerGeneration=[8])))
                policy=dict(version=1,binding=binding,ordinaryMembers=4,wideMembers=8,maxMemberBytes=20,maxPageBytes=144,maxKeysPerInvocation=16,
                      maxPointSources=1,maxResultBytes=16,maxEnvelopeBytes=5,qualificationReceipt=str(evidence),qualificationReceiptSha256=controller.digest(evidence.read_bytes()),
                      runtimeSha256=controller.digest(json.dumps(runtime,sort_keys=True,separators=(",",":")).encode()),
                      peerSha256=controller.digest(peer.encode()))
                args.width_qualification.write_bytes(controller.compact(policy))
                args.width_qualification_sha256=controller.digest(args.width_qualification.read_bytes())
                controller.run(args)
                self.assertEqual([seq for op,seq in calls if op=="source"],[list(range(n,n+4)) for n in (3,7,11,15)])
                self.assertEqual([len(seq) for op,seq in calls if op=="publish"],[8,4,4])
                self.assertEqual(json.loads((args.state/"progress.json").read_bytes())["archived"],16)
                receipts=[json.loads(p.read_bytes()) for p in sorted((args.state/"receipts").glob("*.json"))]
                self.assertEqual([r.get("widthQualificationSha256") for r in receipts],[args.width_qualification_sha256,None,None])

if __name__ == "__main__":
    unittest.main()
