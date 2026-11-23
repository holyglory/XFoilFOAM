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

if __name__ == "__main__":
    unittest.main()
