import argparse
import json
import re
import sys


def verify(queue, build, source_sha256, expected_workers=1):
    if not re.fullmatch(r"[0-9a-f]{64}", source_sha256) or not build:
        raise ValueError("The numerical handoff requires an exact source and build")
    if (not isinstance(queue, dict) or queue.get("inspection_errors") != {} or "worker_runtime_error" not in queue or "worker_queues_error" not in queue
            or queue["worker_runtime_error"] is not None or queue["worker_queues_error"] is not None):
        raise ValueError("The worker inventory is incomplete")
    workers = queue.get("worker_queues")
    if type(expected_workers) is not int or expected_workers < 1 or not isinstance(workers, list) or len(workers) != expected_workers:
        raise ValueError("The corrected worker inventory is missing")
    selected = []
    seen = set()
    for worker in workers:
        if not isinstance(worker, dict):
            raise ValueError("The worker inventory contains an invalid entry")
        name = worker.get("worker")
        if not isinstance(name, str) or not name or name in seen:
            raise ValueError("The worker inventory has missing or duplicate identities")
        seen.add(name)
        runtime = worker.get("engine") or {}
        if not isinstance(runtime, dict) or not runtime.get("distribution") or not isinstance(worker.get("queues"), list):
            raise ValueError("The worker runtime or queue identity is missing")
        if runtime.get("distribution") != "opencfd":
            if worker.get("execution_pool") == "openfoam-opencfd-2606-numerics-2" or "openfoam-opencfd-2606-numerics-2" in worker.get("queues", []):
                raise ValueError("An unrelated runtime consumes the corrected execution route")
            continue
        if (runtime.get("family") != "openfoam" or runtime.get("version") != "2606" or runtime.get("numerics_revision") != "2"
                or runtime.get("adapter_contract_version") != 1 or runtime.get("build_id") != build
                or runtime.get("application_source_sha256") != source_sha256
                or worker.get("execution_pool") != "openfoam-opencfd-2606-numerics-2"
                or worker.get("queues") != ["openfoam-opencfd-2606-numerics-2"]):
            raise ValueError("A live worker differs from the corrected source or execution route")
        selected.append(name)
    if not selected:
        raise ValueError("No live corrected OpenCFD worker was observed")
    return {"numerics_revision": "2", "workers": len(selected), "build_id": build, "application_source_sha256": source_sha256}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--build", required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--expected-workers", type=int, required=True)
    arguments = parser.parse_args()
    print(json.dumps(verify(json.load(sys.stdin), arguments.build, arguments.source_sha256, arguments.expected_workers)))


if __name__ == "__main__":
    main()
