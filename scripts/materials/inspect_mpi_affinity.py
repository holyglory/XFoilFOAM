from collections import Counter
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path


SOLVERS = {"rhoPimpleFoam", "rhoSimpleFoam", "rhoCentralFoam", "simpleFoam", "pimpleFoam"}


def parse_cpu_list(value):
    result = set()
    for item in value.split(","):
        bounds = item.strip().split("-")
        if len(bounds) not in (1, 2) or any(not bound.isdigit() for bound in bounds):
            raise ValueError("Invalid CPU affinity list")
        first, last = int(bounds[0]), int(bounds[-1])
        if not 0 <= first <= last < 65536:
            raise ValueError("Invalid CPU affinity range")
        result.update(range(first, last + 1))
    return sorted(result)


def observe_solver_affinity(proc_root="/proc"):
    groups = {}
    unavailable = 0
    for path in Path(proc_root).iterdir():
        if not path.name.isdigit():
            continue
        try:
            solver = (path / "comm").read_text().strip()
            if solver not in SOLVERS:
                continue
            entries = dict(line.split(":", 1) for line in (path / "status").read_text().splitlines() if ":" in line)
            affinity = tuple(parse_cpu_list(entries["Cpus_allowed_list"].strip()))
            group = hashlib.sha256((path / "cgroup").read_bytes()).hexdigest()[:16]
            key = (group, solver)
            groups.setdefault(key, Counter())[affinity] += 1
        except (FileNotFoundError, PermissionError, KeyError, ValueError):
            unavailable += 1
    observations = []
    for (group, solver), counts in sorted(groups.items()):
        observations.append({"group": group, "solver": solver, "processes": sum(counts.values()),
                             "allowed_cpu_union": sorted({cpu for cpus in counts for cpu in cpus}),
                             "rank_affinities": [{"cpus": list(cpus), "processes": count} for cpus, count in sorted(counts.items())]})
    return {"kind": "read_only_solver_cpu_affinity", "as_of": datetime.now(timezone.utc).isoformat(),
            "groups": observations, "unavailable_process_reads": unavailable,
            "interpretation": "Allowed CPUs are observed placement constraints, not measured utilization or proof of contention."}


if __name__ == "__main__":
    print(json.dumps(observe_solver_affinity()))
