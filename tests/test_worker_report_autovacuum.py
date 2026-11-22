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


if __name__ == "__main__":
    if not CASE:
        raise SystemExit("Use the isolated worker-report-native-reclamation check")
    unittest.main()
