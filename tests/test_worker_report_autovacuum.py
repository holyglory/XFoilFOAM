"""Exercise the production queries and transaction against a disposable PostgreSQL."""
from contextlib import contextmanager
from decimal import Decimal
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import unquote, urlsplit

SCRIPT = Path(__file__).resolve().parents[1] / "scripts/deploy/worker-report-reclamation.py"
spec = importlib.util.spec_from_file_location("worker_report_reclamation", SCRIPT)
maintenance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(maintenance)
CASE = os.environ.get("HZ_REPORT_AUTOVACUUM_TEST_DB") == "1"


@unittest.skipUnless(CASE, "run the worker-report-native-reclamation disposable PostgreSQL case")
class WorkerAutovacuumTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db = unquote(urlsplit(os.environ["DATABASE_URL"]).path[1:])
        if not db or not os.environ.get("PGHOST") or not os.environ.get("PGPORT"):
            raise ValueError("Disposable PostgreSQL target required")
        cls.psql = ["psql", "-XwqAt", "-v", "ON_ERROR_STOP=1", "-d", db]
        names = cls.sql("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY relname")
        if names.strip() != "progressive_worker_reports":
            raise ValueError("Expected the disposal fixture's single empty-schema report table")
        cls.sql("""INSERT INTO public.progressive_worker_reports (id,report)
            SELECT 1,jsonb_build_object('value',string_agg(md5(n::text),'')) FROM generate_series(1,4000) AS n""")

    @classmethod
    def sql(cls, statement, readonly=False):
        return subprocess.run(cls.psql, input=statement, text=True, check=True, capture_output=True, timeout=15,
            env={**os.environ, "PGOPTIONS": f"-c default_transaction_read_only={'on' if readonly else 'off'} -c statement_timeout=5000 -c lock_timeout=500"}).stdout

    def setUp(self):
        self.sql("""ALTER TABLE public.progressive_worker_reports RESET (
            autovacuum_vacuum_scale_factor,toast.autovacuum_vacuum_scale_factor,
            autovacuum_vacuum_threshold,autovacuum_vacuum_cost_delay,toast.autovacuum_vacuum_cost_delay,
            autovacuum_vacuum_cost_limit,autovacuum_enabled,fillfactor)""")
        self.writes = 0

    def session(self, statement, write):
        self.writes += int(write)
        return [json.loads(line) for line in self.sql(statement, not write).splitlines() if line]

    def run_policy(self, scale="0.02", apply=False):
        return maintenance.worker_autovacuum(maintenance.scale_factor(scale), apply, self.session)

    def test_default_preview_apply_and_repeat_preserve_data_and_native_files(self):
        self.sql("""ALTER TABLE public.progressive_worker_reports SET (fillfactor=85,
            autovacuum_vacuum_cost_delay=7,autovacuum_vacuum_cost_limit=123,autovacuum_vacuum_threshold=17)""")
        before = self.sql("SELECT encode(sha256(convert_to(report::text,'UTF8')),'hex') FROM public.progressive_worker_reports")
        preview = self.run_policy()
        self.assertEqual(preview["plannedChanges"], {"heap": "0.02"})
        self.assertEqual(self.writes, 0)
        self.assertEqual(preview["before"]["heap"]["currentScale"], .2)
        applied = self.run_policy(apply=True)
        self.assertTrue(applied["changed"])
        for kind in ("heap", "toast"):
            pre, post = applied["before"][kind], applied["after"][kind]
            self.assertEqual((pre["oid"], pre["filenode"]), (post["oid"], post["filenode"]))
            self.assertEqual((post["currentScale"], post["effectiveCostDelayMs"], post["effectiveCostLimit"]), (.02, 7, 123))
        self.assertEqual(applied["after"]["toast"]["options"], {})
        self.sql("VACUUM (TRUNCATE FALSE) public.progressive_worker_reports")
        self.assertEqual(self.sql("SELECT encode(sha256(convert_to(report::text,'UTF8')),'hex') FROM public.progressive_worker_reports"), before)
        self.assertFalse(self.run_policy(apply=True)["changed"])
        self.assertEqual(self.writes, 1)

    def test_lower_factors_and_separate_toast_settings_survive(self):
        self.sql("""ALTER TABLE public.progressive_worker_reports SET (autovacuum_vacuum_scale_factor=0.005,
            autovacuum_enabled='f',toast.autovacuum_vacuum_cost_delay=3)""")
        receipt = self.run_policy(apply=True)
        self.assertEqual(receipt["plannedChanges"], {"toast": "0.02"})
        self.assertFalse(receipt["after"]["heap"]["ordinaryAutovacuumEnabled"])
        self.assertEqual(receipt["after"]["heap"]["currentScale"], .005)
        self.assertEqual(receipt["after"]["toast"]["effectiveCostDelayMs"], 3)
        self.assertEqual(receipt["after"]["toast"]["currentScale"], .02)
        self.sql("ALTER TABLE public.progressive_worker_reports SET (toast.autovacuum_vacuum_scale_factor=0.001)")
        self.assertFalse(self.run_policy(apply=True)["changed"])
        self.assertEqual(self.writes, 1)

    def test_two_explicit_settings_and_custom_ceiling(self):
        self.sql("""ALTER TABLE public.progressive_worker_reports SET (autovacuum_vacuum_scale_factor=0.04,
            toast.autovacuum_vacuum_scale_factor=0.08,toast.autovacuum_vacuum_cost_delay=5)""")
        result = self.run_policy("0.012", True)
        self.assertEqual(result["plannedChanges"], {"heap": "0.012", "toast": "0.012"})
        self.assertEqual(result["after"]["toast"]["effectiveCostDelayMs"], 5)
        self.assertEqual(self.run_policy()["plannedChanges"], {})

    def test_existing_receipt_fails_before_any_remote_operation(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "receipt.json"
            out.write_text("original")
            with patch.object(sys, "argv", [str(SCRIPT), "--autovacuum", "worker", "--apply", "--output", str(out)]), \
                 patch.object(maintenance, "worker_autovacuum") as dispatch:
                with self.assertRaises(FileExistsError):
                    maintenance.main()
                dispatch.assert_not_called()
            self.assertEqual(out.read_text(), "original")

    def test_different_operator_changes_policy_between_plan_and_apply(self):
        def change_before_apply(statement, write):
            if write:
                self.sql("ALTER TABLE public.progressive_worker_reports SET (autovacuum_vacuum_scale_factor=0.001)")
            return self.session(statement, write)
        with self.assertRaises(subprocess.CalledProcessError) as stale:
            maintenance.worker_autovacuum(Decimal("0.02"), True, change_before_apply)
        self.assertIn("policy changed", stale.exception.stderr)
        self.assertEqual(self.run_policy()["before"]["heap"]["currentScale"], .001)

    def test_contended_apply_and_readonly_repeat(self):
        with self.locked():
            with self.assertRaises(subprocess.CalledProcessError) as locked:
                self.run_policy(apply=True)
            self.assertIn("could not obtain lock", locked.exception.stderr)
        self.assertTrue(self.run_policy("0.01", True)["changed"])
        with self.locked():
            self.assertFalse(self.run_policy("0.02", True)["changed"])

    @contextmanager
    def locked(self):
        p = subprocess.Popen(self.psql, stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        try:
            p.stdin.write("BEGIN; LOCK TABLE ONLY public.progressive_worker_reports IN SHARE UPDATE EXCLUSIVE MODE; SELECT 'held';\n")
            p.stdin.flush()
            self.assertEqual(p.stdout.readline().strip(), "held")
            yield
        finally:
            p.communicate("ROLLBACK;\n", timeout=10)

    def test_role_and_arg_validation(self):
        for args in [["--autovacuum", "hub"], ["--measure", "worker", "--apply"], ["--autovacuum", "worker", "--scale-factor", "NaN"],
                     ["--autovacuum", "worker", "--scale-factor", "-1"]]:
            result = subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 2)
        self.assertEqual(maintenance.scale_factor("2e-2"), Decimal(".02"))


@unittest.skipUnless(CASE, "requires the isolated report-relation case")
class WorkerReturnCheckTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        db = unquote(urlsplit(os.environ["DATABASE_URL"]).path[1:])
        if not db or not os.environ.get("PGHOST") or not os.environ.get("PGPORT"):
            raise ValueError("Isolated PostgreSQL target required")
        cls.psql = ["psql", "-XwqAt", "-v", "ON_ERROR_STOP=1", "-d", db]
        existing = cls.sql("SELECT relname FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' ORDER BY 1")
        if existing.strip() != "progressive_worker_reports":
            raise ValueError("Expected only the disposable report table")
        cls.sql("""ALTER TABLE public.progressive_worker_reports ADD COLUMN archived_at timestamptz,
            ADD COLUMN result_payload_hash text, ADD COLUMN acknowledged_at timestamptz,
            ADD COLUMN content_signature text;
            CREATE TABLE public.sim_jobs (status text);
            CREATE TABLE public.progressive_worker_evidence_delivery_claims (claim_expires_at timestamptz);
            CREATE TABLE public.sync_sweep_promises (status text, "expiresAt" timestamptz);
            INSERT INTO public.sim_jobs VALUES ('running'),('ingesting');
            INSERT INTO public.sync_sweep_promises VALUES ('active',now()+interval '1 hour');
            INSERT INTO public.progressive_worker_evidence_delivery_claims VALUES(now()+interval '1 hour');
            INSERT INTO public.progressive_worker_reports(id,report,acknowledged_at)
            VALUES (42,'{"sequence":42,"unknown":null,"result":{"science":9007199254740993001,"polars":[{"cl":1.00,"cd":0.005}]}}',now());
            UPDATE public.progressive_worker_reports SET content_signature=encode(sha256(convert_to(report::text,'UTF8')),'hex');
        """)

    @classmethod
    def sql(cls, statement, readonly=False):
        return subprocess.run(cls.psql, input=statement, text=True, check=True, capture_output=True, timeout=15,
            env={**os.environ, "PGOPTIONS": f"-c default_transaction_read_only={'on' if readonly else 'off'} -c statement_timeout=5000"}).stdout

    def session(self, statement, write):
        self.assertFalse(write)
        try:
            return maintenance.json_rows(self.sql(statement, True))
        except subprocess.CalledProcessError as error:
            self.fail(error.stderr)

    def host(self, role, command):
        self.assertEqual(role, "worker")
        self.assertEqual(command[:2], ["python3", "-c"])
        paths = json.loads(command[-1])
        return json.dumps({
            "devices": {"1": {"source":"/dev/data","mount":"/data","sizeBytes":10000000,"freeBytes":8000000},
                        "2": {"source":"/dev/wal","mount":"/wal","sizeBytes":4000000,"freeBytes":3000000}},
            "files": {k: "2" if k=="wal" and self.split_wal else "1" for k in paths},
            "services": {"postgres":[{"id":"pg","state":"running","startedAt":"start","restarts":0}],
                "worker":[{"id":"engine","state":"running","startedAt":"original","restarts":2}],
                "api":[{"id":"api","state":"exited","startedAt":"old","restarts":0}],
                "node-api":[{"id":"ingress","state":"running","startedAt":"start","restarts":0}],"media-repair":[]}
        })

    def test_check_preserves_scientific_metadata_and_exact_service_states(self):
        identity = """SELECT id,acknowledged_at::text,result_payload_hash,content_signature,report::text
            FROM public.progressive_worker_reports ORDER BY id"""
        data = self.sql(identity)
        self.split_wal = False
        before = maintenance.worker_return_check(live_values=True, session=self.session, host=self.host)
        self.sql("VACUUM (TRUNCATE FALSE) public.progressive_worker_reports")
        after = maintenance.worker_return_check(before, True, self.session, self.host)
        self.assertEqual(data, self.sql(identity))
        self.assertEqual(after["liveValues"], before["liveValues"])
        self.assertEqual(after["liveValues"]["inline"]["rows"], 2)
        self.assertTrue(after["change"]["samePhysicalFile"])
        self.assertTrue(after["change"]["sameIndexFiles"])
        self.assertTrue(after["change"]["sameServiceStates"])
        self.assertEqual(after["serviceStates"]["api"][0]["state"], "exited")
        self.assertEqual(after["serviceStates"]["media-repair"], [])
        self.assertEqual(after["change"]["liveValueMarginDeltaBytes"], 0)
        self.assertEqual(after["tail"]["heap"]["visibleTailUpperBoundBytes"], 0)
        if after["toastReadable"]:
            self.assertTrue(0 < after["tail"]["toast"]["probedBlocks"] <= 32)
        else:
            self.assertEqual(after["tail"]["toast"]["status"], "no-existing-read-access")
        self.assertTrue(after["ingress"]["liveClaims"])
        self.assertEqual(after["ingress"]["runningJobs"], 1)
        self.assertEqual(after["freeMinusCurrentAllocationBytes"], 8000000-after["totalBytes"])
        with self.assertRaisesRegex(ValueError, "physical files"):
            maintenance.worker_return_check({**before,"toastFilenode":0}, session=self.session, host=self.host)

    def test_split_storage_and_real_allocation_signal(self):
        self.split_wal = True
        prior = maintenance.worker_return_check(session=self.session, host=self.host)
        self.assertIsNone(prior["freeMinusCurrentAllocationBytes"])
        self.assertNotIn("liveValues",prior)
        prior["totalBytes"] += 8192
        after = maintenance.worker_return_check(prior, session=self.session, host=self.host)
        self.assertEqual(after["change"]["relationFileDecreaseBytes"], 8192)
        self.assertIn("relation-allocation-fell",after["reviewSignals"])
        self.assertEqual(after["fileVolumes"]["wal"]["source"],"/dev/wal")
        self.assertNotIn("available-space-crossed-current-allocation",after["reviewSignals"])

    def test_budget_crossing_only_requests_review_on_the_same_physical_volume(self):
        self.split_wal = False
        old = maintenance.worker_return_check(session=self.session, host=self.host)
        old["postgresFilesystem"]["freeBytes"] = 10000
        result = maintenance.worker_return_check(old, session=self.session, host=self.host, review_free_bytes=50000)
        self.assertIn("specified-review-budget-reached",result["reviewSignals"])
        self.assertTrue(result["reviewBudgetCovered"])
        self.assertTrue(result["change"]["sameServiceStates"])
        self.split_wal = True
        split = maintenance.worker_return_check(old, session=self.session, host=self.host, review_free_bytes=50000)
        self.assertIsNone(split["reviewBudgetCovered"])
        self.assertNotIn("specified-review-budget-reached",split["reviewSignals"])

    def test_real_empty_tail_shrinks_and_retained_original_survives(self):
        self.split_wal = False
        original = self.sql("SELECT id,report::text,content_signature,acknowledged_at::text FROM public.progressive_worker_reports WHERE id IN (1,42) ORDER BY id")
        self.sql("""ALTER TABLE public.progressive_worker_reports SET (autovacuum_enabled=false);
            INSERT INTO public.progressive_worker_reports(id,report)
              SELECT 1000000+n,jsonb_build_object('padding',repeat(md5(n::text),16)) FROM generate_series(1,8192) AS n;
            DELETE FROM public.progressive_worker_reports WHERE id>1000000;""")
        try:
            before = maintenance.worker_return_check(session=self.session,host=self.host)
            self.assertIsNone(before["tail"]["heap"]["visibleTailUpperBoundBytes"])
            self.sql("VACUUM (TRUNCATE TRUE, INDEX_CLEANUP ON) public.progressive_worker_reports")
            after = maintenance.worker_return_check(before,session=self.session,host=self.host)
            self.assertGreater(before["heapBytes"], after["heapBytes"])
            self.assertEqual(after["change"]["relationFileDecreaseBytes"], before["totalBytes"]-after["totalBytes"])
            self.assertIn("relation-allocation-fell",after["reviewSignals"])
            self.assertTrue(after["change"]["samePhysicalFile"])
            self.assertEqual(after["change"]["changedServices"],[])
            self.assertEqual(self.sql("SELECT id,report::text,content_signature,acknowledged_at::text FROM public.progressive_worker_reports WHERE id IN (1,42) ORDER BY id"), original)
        finally:
            self.sql("ALTER TABLE public.progressive_worker_reports RESET (autovacuum_enabled)")

    def test_changed_container_identity_is_reported_without_restoring_a_replacement(self):
        self.split_wal = False
        prior = maintenance.worker_return_check(session=self.session,host=self.host)
        prior["serviceStates"]["api"][0]["id"] = "previous-api"
        after = maintenance.worker_return_check(prior,session=self.session,host=self.host)
        self.assertEqual(after["change"]["changedServices"],["api"])
        self.assertIn("service-state-changed",after["reviewSignals"])
        self.assertEqual(after["serviceStates"]["api"],[{"id":"api","state":"exited","startedAt":"old","restarts":0}])

    def test_check_has_no_write_or_hub_entrypoint(self):
        for args in (["--return-check","worker","--apply"],["--return-check","hub"],["--autovacuum","worker","--live-values"]):
            p = subprocess.run([sys.executable,str(SCRIPT),*args], capture_output=True, timeout=4)
            self.assertEqual(p.returncode,2)


if __name__ == "__main__":
    if not CASE:
        raise SystemExit("Use the isolated worker-report-native-reclamation check")
    unittest.main()
