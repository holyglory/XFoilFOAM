import argparse
import json
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4

from .config import Settings
from .models import PolarRequest
from .openfoam.dialects import OPENCFD_2606


def verify_control(base_url: str, coordinates: Path, token: str) -> dict:
    if not token:
        raise RuntimeError("The private control credential is required")

    def call(path, payload=None):
        request = Request(
            base_url.rstrip("/") + path,
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST" if payload is not None else "GET",
        )
        with urlopen(request, timeout=15) as response:
            return json.load(response)

    ready_deadline = time.monotonic() + 60
    while True:
        try:
            call("/health")
            break
        except (HTTPError, URLError):
            if time.monotonic() >= ready_deadline:
                raise
            time.sleep(0.1)
    job_id = str(uuid4())
    request = PolarRequest.model_validate({
        "execution_id": job_id,
        "expected_engine": OPENCFD_2606.identity.model_dump(mode="json"),
        "expected_execution_pool": OPENCFD_2606.queue_name,
        "airfoil": {"name": "AG24 isolated execution-control verification", "coordinates": coordinates.read_text()},
        "chord_lengths": [1], "speeds": [30], "aoa": {"angles": [12]},
        "fluid": {"density": 1.225, "dynamic_viscosity": 1.7894e-5},
        "mesh": {"n_surface": 140, "n_radial": 60, "n_wake": 50, "target_y_plus": 40},
        "solver": {"flow_solver_family": "simpleFoam", "n_iterations": 5000,
                   "convergence_tolerance": 1e-12, "write_images": []},
        "resources": {"policy": "auto", "cpu_budget": 1, "case_concurrency": 1, "case_solver_budget_seconds": 60},
    })
    report = {"kind": "live-worker-control-verification", "job_id": job_id,
              "aerodynamic_result_claimed": False, "outcome": "failed"}
    try:
        submitted = call("/polars", request.model_dump(mode="json"))
        if submitted.get("job_id") != job_id:
            raise RuntimeError("The control canary did not retain its exact execution identity")
        deadline = time.monotonic() + 60
        while True:
            status = call(f"/jobs/{job_id}")
            if status.get("job_id") != job_id:
                raise RuntimeError("The control canary received another job's status")
            cases = (status.get("solver_budget_progress") or {}).get("cases", [])
            if status.get("state") == "running" and any(case.get("solver_running") and case.get("solver_active_seconds", 0) >= 0.2 for case in cases):
                break
            if time.monotonic() >= deadline or status.get("state") in {"completed", "failed", "cancelled"}:
                raise RuntimeError("The control canary did not observe an occupied real CFD slot")
            time.sleep(0.1)
        report["busy_status"] = status
        started = time.monotonic()
        inspection = call(f"/jobs/{job_id}/execution-stop-proof", {})
        report["inspection_seconds"] = time.monotonic() - started
        if inspection.get("job_id") != job_id or inspection.get("execution_stopped") is not False:
            raise RuntimeError("A running CFD job received an invalid execution-stop verdict")
        after = call(f"/jobs/{job_id}")
        if after.get("job_id") != job_id or after.get("state") != "running" or not any(case.get("solver_running") for case in (after.get("solver_budget_progress") or {}).get("cases", [])):
            raise RuntimeError("The inspection did not finish while the CFD slot remained occupied")
        report["inspection_while_busy"] = inspection
        report["outcome"] = "passed"
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        try:
            started = time.monotonic()
            report["cancellation"] = call(f"/jobs/{job_id}/cancel", {
                "expected_engine": OPENCFD_2606.identity.model_dump(mode="json"),
                "expected_execution_pool": OPENCFD_2606.queue_name,
            })
            deadline = time.monotonic() + 60
            while True:
                proof = call(f"/jobs/{job_id}/execution-stop-proof", {})
                if proof.get("execution_stopped") is True:
                    if proof.get("job_id") != job_id or proof.get("producer_stopped") is not True or proof.get("namespace_verified") is not True or proof.get("remaining") != [] or proof.get("error") is not None:
                        raise RuntimeError("Incomplete native execution-stop proof")
                    report["stop_proof"] = proof
                    break
                if time.monotonic() >= deadline:
                    raise RuntimeError("The control canary could not prove physical cancellation")
                time.sleep(0.1)
            report["cancellation_seconds"] = time.monotonic() - started
        except Exception as error:
            report["outcome"] = "failed"
            report["cleanup_error"] = str(error)
            raise
        finally:
            print(json.dumps(report, allow_nan=False), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", required=True)
    parser.add_argument("--coordinates", type=Path, required=True)
    args = parser.parse_args()
    verify_control(args.api, args.coordinates, Settings().control_plane_token or "")


if __name__ == "__main__":
    main()
