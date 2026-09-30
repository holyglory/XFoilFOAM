import hashlib
import json
from pathlib import Path
from uuid import uuid4

import airfoilfoam
from airfoilfoam.config import Settings
from airfoilfoam.jobs import execute_job
from airfoilfoam.models import PolarRequest
from airfoilfoam.provenance import application_source_sha256
from airfoilfoam.storage import JobStore


def main():
    source_root = Path("/baseline")
    expected_source = "2503ff74b56acc3a2eaff6d74ca87a230b5add1898787bf01dfc397302d686b3"
    if Path(airfoilfoam.__file__).resolve() != source_root / "src/airfoilfoam/__init__.py":
        raise ValueError("The diagnostic did not load the actual production adapter")
    if application_source_sha256(source_root) != expected_source:
        raise ValueError("The baseline source differs from the live production fingerprint")
    source = Path("/fixture/request.json").read_bytes()
    if hashlib.sha256(source).hexdigest() != "04e24159cd6d79db3955a9a5f385e3e7159b4408c2d16d99e38b2a9c542953ed":
        raise ValueError("The precise campaign request changed")
    payload = json.loads(source)["engine_request"]
    for name in ("execution_id", "expected_engine", "expected_execution_pool", "expected_mesh_recovery_version"):
        payload[name] = None
    payload["solver"].update(write_images=[], frame_fields=[])
    payload["resources"].update(cpu_budget=1, solver_processes=1, case_concurrency=1, case_solver_budget_seconds=900)
    request = PolarRequest.model_validate(payload)
    destination = Path("/canary-output/mach3-production-baseline") / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "driver.py").write_bytes(Path(__file__).read_bytes())
    (destination / "source-request.json").write_bytes(source)
    settings = Settings(data_dir=destination / "data", cache_dir=destination / "cache",
                        cpu_token_state_path=destination / "cpu-tokens.json", engine_application_source_sha256=expected_source,
                        engine_source_revision="383b2fca24765384010d18609df954cfe30be72b", build_id="isolated-production-baseline")
    if settings.evidence_bucket or settings.control_plane_token:
        raise ValueError("The baseline must not publish production data")
    store = JobStore(settings)
    job = str(uuid4())
    store.create(job, request)
    report = {"kind": "exact-production-engine-baseline-v1", "production_evidence": False,
              "source_sha256": expected_source, "request": request.model_dump(mode="json"), "job": job}
    try:
        result = execute_job(job, request, store=store, settings=settings)
        report["state"] = result.state.value
        report["outcomes"] = [
            {"collection": collection, "alpha": point.aoa_deg, "error": point.error,
             "disposition": point.failure_disposition, "converged": point.converged,
             "cl": point.cl, "solver_active_seconds": point.solver_active_seconds}
            for polar in result.polars for collection in ("points", "attempts") for point in getattr(polar, collection)
        ]
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        (destination / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        print(json.dumps({"report": str(destination / "report.json"), "state": report.get("state"),
                          "outcomes": report.get("outcomes"), "error": report.get("error")}), flush=True)


if __name__ == "__main__":
    main()
