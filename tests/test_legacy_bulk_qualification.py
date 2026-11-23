import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("report_budget", ROOT / "scripts/deploy/qualify-legacy-bulk-release.py")
budget = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(budget)


class BudgetHandoff(unittest.TestCase):
    def test_installed_payload_is_exact(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            files = {}
            for name in ["legacy-cli.mjs","completion.json","delivery.json"]:
                (p/name).write_text(name)
                files[name] = budget.sha(p/name)
            budget.write(p/"deployment.json", {"entry":"legacy-cli.mjs","files":files})
            self.assertEqual(budget.verify_install(p,files)["files"],files)
            (p/"unlisted").touch()
            with self.assertRaisesRegex(ValueError,"Uncatalogued"):
                budget.verify_install(p)
            (p/"unlisted").unlink()
            (p/"legacy-cli.mjs").write_text("different executable")
            with self.assertRaisesRegex(ValueError,"differs"):
                budget.verify_install(p)

    def test_paused_prestart_preserves_unrelated_release_and_refuses_drift(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp); prev="a"*40; rev="b"*40; unit="report-test@bulk.service"
            (p/"progress").mkdir(); (p/"run-migration.py").write_text("original")
            budget.write(p/"scope.json",{"version":1,"sourceInstance":"worker"})
            budget.write(p/"progress/checkpoint.json",{"binding":"binding"})
            sources={}
            for revision in (prev,rev):
                d=p/"operator"/revision;d.mkdir(parents=True)
                for name in ("legacy-cli.mjs","delivery.json","completion.json"): (d/name).write_text(name)
                files={f.name:budget.sha(f) for f in d.iterdir()}
                sources[revision]={"sourceRevision":revision,"entry":"legacy-cli.mjs","files":files,"sourceDigest":"source","deliveryReceipt":revision}
                budget.write(d/"deployment.json", sources[revision])
            old=dict(normalSlots=1,normalCapBytes=budget.CAP,singleUnit=unit,operatorDelivery=prev,
                     expectedInstalledManifestSha256=budget.sha(p/"operator"/prev/"deployment.json"))
            policy=dict(qualifiedReleases={prev:old},capBytes=budget.CAP,rows=128,normalPages=16,
                        scopeSha256=budget.hash_json(budget.read(p/"scope.json")),sourceBinding="binding",canonicalWrapperSha256=budget.sha(p/"run-migration.py"))
            budget.write(p/"policy.json",policy);(p/"lock").touch()
            args=SimpleNamespace(state=p,policy=p/"policy.json",lock=p/"lock",wave=p/"release",roles=["hub","worker"],
                                 checkout=p,previous=prev,revision=rev,exercise_replay=False,register=True)
            marker={"sourceRevision":rev,"sourceTreeSha256":"tree"}
            for role in args.roles:budget.write(p/("release-runtime-"+role+".json"),{"manifest":marker})
            delivered={"receipt_id":rev,"run_id":"run"}
            active=["active"]
            def command(*argv):
                if argv[0]=="devcoordinator2":return json.dumps({"ok":True,"data":delivered}).encode()
                if argv[0]=="systemctl":return active[0].encode()
                if argv[0]=="ssh":return json.dumps(marker).encode()
                self.assertEqual(argv[0],"node")
                updated=budget.read(args.policy)
                updated["qualifiedReleases"]["c"*40]={"another":"authorized append"}
                budget.write(args.policy,updated)
                return json.dumps({"sha256":argv[-1]}).encode()
            with patch.object(budget,"command",side_effect=command),patch.object(budget,"package",return_value=(delivered,"tree",sources[rev])),patch.object(budget,"measure",return_value={"members":14}) as measure:
                with self.assertRaisesRegex(ValueError,"paused pre-start"):
                    budget.qualify(args)
                active[0]="inactive"
                self.assertTrue(budget.qualify(args)["registered"])
                current=budget.read(args.policy)
                self.assertIn("c"*40,current["qualifiedReleases"])
                self.assertEqual(current["qualifiedReleases"][rev]["normalSlots"],1)
                active[0]="active";before=measure.call_count
                self.assertTrue(budget.qualify(args)["registered"])
                self.assertEqual(measure.call_count,before)
                budget.write(p/"progress/checkpoint.json",{"binding":"another"})
                with self.assertRaisesRegex(ValueError,"checkpoint"):
                    budget.qualify(args)

if __name__=="__main__":
    unittest.main()
