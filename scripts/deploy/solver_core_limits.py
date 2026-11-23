"""Worker-private RLIMIT_CORE inspection and reversible soft-limit changes (Linux)."""
from __future__ import annotations

import json
import os
from pathlib import Path
import resource
import select
import sys


def _entry(pid: int):
    directory = Path("/proc") / str(pid)
    fields = (directory / "stat").read_text().rsplit(")", 1)[1].split()
    if fields[0] in ("Z", "X"):
        raise ProcessLookupError(pid)
    return {
        "pid": pid, "parent": int(fields[1]), "start": int(fields[19]),
        "name": (directory / "comm").read_text().strip(),
        "cgroup": (directory / "cgroup").read_text(),
        "namespace": os.readlink(directory / "ns/pid"),
    }


def inspect_tree(root: int):
    leader = _entry(root)
    children: dict[int, list[int]] = {}
    for item in Path("/proc").iterdir():
        if not item.name.isdecimal() or int(item.name) in {root, os.getpid()}:
            continue
        try:
            fields = (item / "stat").read_text().rsplit(")", 1)[1].split()
        except (FileNotFoundError, ProcessLookupError):
            continue
        children.setdefault(int(fields[1]), []).append(int(item.name))
    rows = []
    queue = [root]
    visited = set()
    while queue:
        pid = queue.pop()
        if pid in visited:
            continue
        visited.add(pid)
        try:
            row = _entry(pid)
            if (row["cgroup"], row["namespace"]) != (leader["cgroup"], leader["namespace"]):
                continue
            queue.extend(children.get(pid, []))
            core = resource.prlimit(pid, resource.RLIMIT_CORE)
            nofile = resource.prlimit(pid, resource.RLIMIT_NOFILE)
            if _entry(pid)["start"] != row["start"]:
                continue
        except (FileNotFoundError, ProcessLookupError):
            continue
        rows.append({**row, "core": list(core), "nofile": list(nofile)})
    return leader, rows


def change_tree(root: int, expected: dict, records: list[dict], *, restore: bool):
    leader, current = inspect_tree(root)
    for key in ("pid", "start", "namespace", "cgroup"):
        if leader[key] != expected[key]:
            raise RuntimeError("solver worker leader changed")
    originals = {(row["pid"], row["start"]): row for row in records}
    changed, held = [], []
    for row in current:  # ancestor first; newly forked children inherit the soft limit
        pid = row["pid"]
        old = originals.get((pid, row["start"]))
        if old is None:
            continue
        if (row["namespace"], row["cgroup"]) != (old["namespace"], old["cgroup"]):
            held.append({"pid": pid, "reason": "namespace or cgroup changed"})
            continue
        try:
            handle = os.pidfd_open(pid)
            try:
                death = select.poll()
                death.register(handle, select.POLLIN)
                if death.poll(0) or _entry(pid)["start"] != old["start"]:
                    continue
                soft, hard = resource.prlimit(pid, resource.RLIMIT_CORE)
                target = old["core"][0] if restore else 0
                if hard != old["core"][1] or soft not in (old["core"][0], 0):
                    held.append({"pid": pid, "reason": "current soft or hard limit changed independently"})
                    continue
                if soft != target:
                    previous = resource.prlimit(pid, resource.RLIMIT_CORE, (target, hard))
                    if previous != (soft, hard):
                        raise RuntimeError("worker resource limits raced")
                if death.poll(0):
                    continue
                if resource.prlimit(pid, resource.RLIMIT_CORE) != (target, hard):
                    raise RuntimeError("worker core-limit readback differs")
                if list(resource.prlimit(pid, resource.RLIMIT_NOFILE)) != old["nofile"]:
                    raise RuntimeError("worker nofile readback differs")
                changed.append({"pid": pid, "start": old["start"], "before": soft, "after": target, "hard": hard})
            finally:
                os.close(handle)
        except (FileNotFoundError, ProcessLookupError):
            continue
    return {"verified": changed, "held": held}


def inside(request):
    leader, rows = inspect_tree(1)
    if not any(row["name"] == "celery" for row in rows):
        raise RuntimeError("the target PID namespace is not running a Celery worker")
    policy = os.getenv("AIRFOILFOAM_SOLVER_CORE_SOFT_BYTES", "0")
    if policy != "0" and request["action"] != "inspect":
        raise RuntimeError("explicit worker diagnostic core policy is configured")
    if request["action"] == "inspect":
        return {"leader": leader, "rows": rows, "configuredSoftBytes": policy}
    if request["action"] not in ("disable", "restore"):
        raise ValueError("unknown core-limit action")
    return change_tree(1, request["leader"], request["rows"], restore=request["action"] == "restore")


if __name__ == "__main__":
    print(json.dumps(inside(json.loads(sys.argv[1])), separators=(",", ":")))
