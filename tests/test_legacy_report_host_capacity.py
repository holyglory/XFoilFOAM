"""A matched normal resource window and a cache-heavy PostgreSQL trial."""

from copy import deepcopy
from datetime import datetime, timedelta, timezone
import importlib.util
from pathlib import Path
import unittest

MODULE = (
    Path(__file__).resolve().parents[1]
    / "scripts/deploy/legacy_report_host_capacity.py"
)
spec = importlib.util.spec_from_file_location("report_capacity", MODULE)
capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capacity)
MIB = 1024**2


def sample(second, engine_cores=81, pg_cores=11, pg_mib=32 * 1024, cache_mib=27 * 1024):
    stamp = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=second)

    def service(cpu):
        return {
            "bytes": 1024 * MIB,
            "maxBytes": "max",
            "highBytes": "max",
            "cpuStat": {"usage_usec": cpu * second * 1_000_000, "throttled_usec": 0},
            "events": dict.fromkeys(["oom", "oom_kill", "high", "max"], 0),
            "memoryPressure": {"full": {"avg10": 0.0}},
        }

    components = {
        name: service(cpu)
        for name, cpu in [
            ("postgres", pg_cores),
            ("worker", engine_cores),
            ("sweeper", 3),
            ("node-api", 1),
        ]
    }
    components["postgres"].update(
        bytes=pg_mib * MIB,
        file=(cache_mib + 1024) * MIB,
        inactiveFile=cache_mib * MIB,
        shmem=1024 * MIB,
        anon=1024 * MIB,
    )
    return {
        "at": stamp.isoformat(),
        "hostMemory": {"MemFree": 3072 * MIB, "MemAvailable": 95 * 1024 * MIB},
        "hostIO": {"full": {"avg10": 0.0}},
        "hostMemoryPressure": {"full": {"avg10": 0.0}},
        "services": components,
    }


class HostBudget(unittest.TestCase):
    def test_matched_solver_progress_and_pressure(self):
        self.normal = capacity.baseline([sample(i) for i in range(8)])
        a = sample(10, pg_mib=42 * 1024, cache_mib=37 * 1024)
        b = sample(11, pg_mib=42 * 1024, cache_mib=37 * 1024)

        def check(current, signed=True):
            return capacity.assess(
                a,
                current,
                self.normal,
                pair_reserve_mib=3072,
                min_available_mib=16384,
                signed_progress=signed,
            )

        large_cache = check(b)
        self.assertTrue(large_cache["admit"])
        self.assertEqual(large_cache["pg"]["workingSetMiB"], 5 * 1024)
        self.assertEqual(large_cache["hostFreeMiB"], 3072)
        self.assertEqual(large_cache["hostAvailableMiB"], 95 * 1024)
        self.assertIn("signed_progress", check(b, False)["reasons"])

        for reason, path, value in [
            (
                "solver_cpu_below_normal",
                ("services", "worker", "cpuStat", "usage_usec"),
                830_000_000,
            ),
            ("pg_cpu", ("services", "postgres", "cpuStat", "usage_usec"), 160_000_000),
            (
                "postgres_highBytes",
                ("services", "postgres", "highBytes"),
                42 * 1024 * MIB,
            ),
            (
                "postgres_maxBytes",
                ("services", "postgres", "maxBytes"),
                42 * 1024 * MIB,
            ),
            (
                "postgres_memory_events",
                ("services", "postgres", "events", "oom_kill"),
                1,
            ),
            (
                "pg_memory_pressure",
                ("services", "postgres", "memoryPressure", "full", "avg10"),
                2,
            ),
            (
                "worker_cpu_throttled",
                ("services", "worker", "cpuStat", "throttled_usec"),
                400_000,
            ),
            ("host_memory_margin", ("hostMemory", "MemAvailable"), 3000 * MIB),
        ]:
            current = deepcopy(b)
            field = current
            for key in path[:-1]:
                field = field[key]
            field[path[-1]] = value
            with self.subTest(reason=reason):
                self.assertIn(reason, check(current)["reasons"])
        del b["services"]["postgres"]["inactiveFile"]
        self.assertEqual(
            check(b), {"admit": False, "reasons": ["capacity_unavailable"]}
        )


if __name__ == "__main__":
    unittest.main()
