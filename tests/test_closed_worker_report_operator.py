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
            source = {"facts":{}}
            def peer(_args,role,message,_program):
                op,seq=message["op"],message["key"]["sequence"]
                operations.append((seq,role,op))
                if seq==3:
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

if __name__ == "__main__":
    unittest.main()
