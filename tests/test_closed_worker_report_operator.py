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
            observed=[];lost=[True]
            def rpc(_args,role,m,_peer):
                op=m["op"];n=len(m["items"]);observed.append((op,role,n))
                if op=="source":return {"rows":[{"source":{"facts":{"byteSize":20}},"stored":10} for _ in range(n)]}
                if op=="hub":return {"rows":[{"science":{}} for _ in range(n)]}
                if op=="publish":return {"pins":[{"generation":"1"} for _ in range(n)],"deltaMembers":2}
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
                controller.run(args)
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

    def test_exact_same_execution_keys_can_span_unowned_sequence_numbers(self):
        import io
        from closed_worker_report_pages import adjacent
        job="1"*36; keys=[dict(executionId=j,sequence=s,signature="b"*64) for j,s in ((job,3),(job,7),(job,9),("2"*36,10))]
        stream=io.BytesIO(b"".join(controller.compact(k)+b"\n"for k in keys))
        self.assertEqual(len(adjacent(stream,4,lambda k:None)),1)
        self.assertEqual([k for k,_ in adjacent(stream,4,lambda k:None,allow_gaps=True)],keys[:3])
        self.assertEqual(stream.tell(),0)

if __name__ == "__main__":
    unittest.main()
