import argparse
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from airfoilfoam.config import Settings
from airfoilfoam.jobs import execute_job
from airfoilfoam.models import PolarRequest
from airfoilfoam.storage import JobStore


SOURCE_SIGNATURE = "826bedd8ece8dccafffff8d760b32ccef9e6190b02185afc2c993fc8eee067fe"
SOURCE_EXPORT_SIGNATURE = "76d5203b511ae5af723d0166af4f7e6ca4fdb975413edfa198e227ad96e93217"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--iterations", type=int, choices=[50, 1500], default=50)
    args = parser.parse_args()
    original = args.request.read_bytes()
    if hashlib.sha256(original).hexdigest() != SOURCE_SIGNATURE:
        raise ValueError("The retained production request does not match")
    source = json.loads(original)
    source["execution_id"] = None
    source["solver"].update(n_iterations=args.iterations, write_images=[], frame_fields=[], rans_failure_policy="continue")
    source["resources"].update(cpu_budget=1, solver_processes=1)
    request = PolarRequest.model_validate(source)
    destination = args.destination / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    settings = Settings(data_dir=destination / "data", cache_dir=destination / "cache",
                        cpu_token_state_path=destination / "cpu-tokens.json")
    if settings.evidence_bucket:
        raise ValueError("The isolated initialization probe must not upload results")
    store = JobStore(settings)
    job_id = str(uuid4())
    store.create(job_id, request)
    result = execute_job(job_id, request, store=store, settings=settings)
    outcomes = [{"alpha": point.aoa_deg, "collection": collection, "failure_disposition": point.failure_disposition,
                 "error": point.error.splitlines()[0] if point.error else None, "converged": point.converged}
                for polar in result.polars for collection in ("points", "attempts") for point in getattr(polar, collection)]
    root = store.job_dir(job_id)
    receipts = []
    for path in root.rglob("pressure-initialization.json"):
        if "evidence" in path.relative_to(root).parts:
            continue
        receipt = json.loads(path.read_text())
        if receipt["version"] == 3 and path.parent.name != receipt["attempt_directory"]:
            continue
        if receipt["version"] == 3:
            for name, expected in receipt["protected_sha256"].items():
                if hashlib.sha256((path.parent / "original" / name).read_bytes()).hexdigest() != expected:
                    raise ValueError("Protected physical initialization snapshot differs")
            applied = (path.parent / "U.applied").read_bytes()
            original_velocity = (path.parent / "U.freestream").read_bytes()
            if applied.split(b"boundaryField", 1)[1] != original_velocity.split(b"boundaryField", 1)[1]:
                raise ValueError("Auxiliary boundary conditions leaked into the physical CFD field")
            if hashlib.sha256(applied).hexdigest() != receipt["velocity_sha256"]:
                raise ValueError("Applied velocity identity differs")
        receipts.append({"path": str(path.relative_to(root)), **receipt})
    report = {"kind": "pressure-initialization-production-reproduction", "source_job": "527fc7c9-7eaf-4d52-a23f-dc6b6b774bb3",
              "source_sha256": SOURCE_SIGNATURE, "local_job": job_id,
              "source_export_sha256": SOURCE_EXPORT_SIGNATURE,
              "fixture_change": "one trailing newline added to the exact retained production JSON export",
              "differences": [f"{args.iterations} CFD iterations after initialization", "serial CPU allocation", "no rendered media", "isolated empty cache", "diagnostic continues to the second angle after rejected CFD; production promotion policy is unchanged"],
              "airfoil_polar_validation": False, "outcomes": outcomes, "initialization_receipts": receipts}
    (destination / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"report": str(destination / "report.json"), "outcomes": outcomes,
                      "initializations": len(receipts), "airfoil_polar_validation": False}), flush=True)
    if not outcomes:
        raise RuntimeError("No native case was attempted")


if __name__ == "__main__":
    main()
