from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from airfoilfoam.control_canary import verify_control
from airfoilfoam.openfoam.dialects import OPENCFD_2606


def validate_cancellation(identity, result):
    if result.get("job_id") != identity or result.get("cancelled") is not True:
        raise RuntimeError("Cancellation did not acknowledge its exact identity")
    proof = result.get("stop_proof") or {}
    if (result.get("execution_stopped") is not True or proof.get("job_id") != identity
            or proof.get("execution_stopped") is not True or proof.get("producer_stopped") is not True
            or proof.get("namespace_verified") is not True or proof.get("remaining") != []
            or proof.get("error") is not None or proof.get("ownership_basis") != "never_started_cancellation_fence"):
        raise RuntimeError("Never-started cancellation has no real complete stop proof")
    return proof


def verify():
    origin = "http://127.0.0.1:8000"
    token = os.environ["AIRFOILFOAM_CONTROL_PLANE_TOKEN"]
    directory = Path("/verification-output") / str(uuid4())
    directory.mkdir(parents=True, exist_ok=False)
    report = {"kind": "isolated-concurrent-control-verification-v1", "outcome": "incomplete",
              "production_mutated": False, "aerodynamic_result_claimed": False, "health_samples": []}

    def request(path, payload=None, timeout=30):
        started = time.monotonic()
        value = Request(origin + path, data=None if payload is None else json.dumps(payload).encode(),
                        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
                        method="GET" if payload is None else "POST")
        with urlopen(value, timeout=timeout) as response:
            body = json.load(response)
        return body, time.monotonic() - started

    try:
        deadline = time.monotonic() + 60
        while True:
            try:
                queue, _ = request("/queue", timeout=10)
                if queue.get("worker_queues") and not queue.get("worker_queues_error"):
                    break
            except (HTTPError, URLError):
                pass
            if time.monotonic() >= deadline:
                raise RuntimeError("The isolated gateway and worker did not become ready")
            time.sleep(1)
        identities = [str(uuid4()) for _ in range(19)]
        payload = {"expected_engine": OPENCFD_2606.identity.model_dump(mode="json"),
                   "expected_execution_pool": OPENCFD_2606.queue_name}
        def cancel(identity):
            result, elapsed = request(f"/jobs/{identity}/cancel", payload, timeout=60)
            proof = validate_cancellation(identity, result)
            return {"job_id": identity, "elapsed_seconds": elapsed, "stop_proof": proof}
        with ThreadPoolExecutor(max_workers=19) as executor:
            futures = [executor.submit(cancel, identity) for identity in identities]
            while not all(future.done() for future in futures):
                health, elapsed = request("/health", timeout=3)
                if health.get("status") != "ok":
                    raise RuntimeError("Concurrent cancellation made health unavailable")
                report["health_samples"].append(elapsed)
                time.sleep(0.2)
            report["cancellations"] = [future.result() for future in futures]
        report["busy_native_control"] = verify_control(origin, Path("/fixture/ag24.dat"), token)
        report["outcome"] = "passed"
        return report
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        (directory / "report.json").write_text(json.dumps(report, allow_nan=False, indent=2))
        print(json.dumps({"report": str(directory / "report.json"), "outcome": report["outcome"],
                          "cancellations": len(report.get("cancellations", [])),
                          "health_samples": len(report["health_samples"]),
                          "maximum_health_seconds": max(report["health_samples"], default=None),
                          "error": report.get("error")}), flush=True)


if __name__ == "__main__":
    verify()
