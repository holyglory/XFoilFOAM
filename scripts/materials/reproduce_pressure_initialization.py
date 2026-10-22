import argparse
import hashlib
import json
import math
import os
import subprocess
from pathlib import Path
from uuid import uuid4

from airfoilfoam.config import Settings
from airfoilfoam.capabilities import MESH_RECOVERY_VERSION
from airfoilfoam.jobs import execute_job
from airfoilfoam.models import PolarRequest
from airfoilfoam.openfoam.dialects import OPENCFD_2606, OPENCFD_2606_IDENTITY
from airfoilfoam.storage import JobStore


SOURCE_SIGNATURE = "826bedd8ece8dccafffff8d760b32ccef9e6190b02185afc2c993fc8eee067fe"
SOURCE_EXPORT_SIGNATURE = "76d5203b511ae5af723d0166af4f7e6ca4fdb975413edfa198e227ad96e93217"
PINNED_WORKER_IMAGE = "sha256:d0a5fd5f9723be5c92d7713df3d12b89675045477d6dbed8924f5e598e51ab46"


def _candidate_application_source_sha256() -> str:
    candidate_root = Path("/candidate")
    source_root = candidate_root / "src"
    image_pyproject = Path("/app/pyproject.toml")
    if not source_root.is_dir() or not image_pyproject.is_file():
        raise RuntimeError("candidate source mount or image pyproject is unavailable")
    paths = [("pyproject.toml", image_pyproject)]
    paths.extend(
        (path.relative_to(candidate_root).as_posix(), path)
        for path in source_root.rglob("*")
        if path.is_file()
        and "__pycache__" not in path.parts
        and ".serena" not in path.parts
        and not any(part.endswith(".egg-info") for part in path.parts)
        and path.suffix not in {".pyc", ".pyo"}
    )
    digest = hashlib.sha256()
    for relative, path in sorted(paths):
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def _native_runtime_identity() -> dict[str, object]:
    command = r'''
source /usr/lib/openfoam/openfoam2606/etc/bashrc >/dev/null 2>&1
printf 'wm_project_version=%s\n' "$WM_PROJECT_VERSION"
printf 'package_version=%s\n' "$(dpkg-query -W -f='${Version}' openfoam2606)"
for solver in rhoSimpleFoam simpleFoam; do
    path="$(command -v "$solver")"
    printf '%s_path=%s\n' "$solver" "$path"
    printf '%s_sha256=%s\n' "$solver" "$(sha256sum "$path" | cut -d ' ' -f 1)"
done
printf 'package_sha256=%s\n' "$(cat /etc/airfoilfoam-engine-package-sha256 2>/dev/null || true)"
printf 'recorded_binary_sha256=%s\n' "$(cat /etc/airfoilfoam-engine-binary-sha256 2>/dev/null || true)"
'''
    output = subprocess.check_output(["bash", "-lc", command], text=True)
    identity: dict[str, object] = {}
    for line in output.splitlines():
        key, value = line.split("=", 1)
        identity[key] = value
    identity["configured_worker_queue"] = os.environ.get("AIRFOILFOAM_CELERY_QUEUE")
    identity["configured_numerics_revision"] = os.environ.get("AIRFOILFOAM_ENGINE_NUMERICS_REVISION")
    return identity


def _finite_converged(point: object) -> bool:
    return bool(getattr(point, "converged", False)) and getattr(point, "error", None) is None and all(
        isinstance(value, (int, float)) and math.isfinite(float(value))
        for value in (getattr(point, "cl", None), getattr(point, "cd", None), getattr(point, "cm", None))
    )


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
    historical_expected_engine = source.get("expected_engine")
    historical_expected_execution_pool = source.get("expected_execution_pool")
    historical_mesh_recovery_version = source.get("expected_mesh_recovery_version")
    source["expected_engine"] = OPENCFD_2606_IDENTITY.model_dump(mode="json")
    source["expected_execution_pool"] = OPENCFD_2606.queue_name
    source["expected_mesh_recovery_version"] = MESH_RECOVERY_VERSION
    candidate_source_sha256 = _candidate_application_source_sha256()
    native_identity = _native_runtime_identity()
    request = PolarRequest.model_validate(source)
    destination = args.destination / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    settings = Settings(
        data_dir=destination / "data", cache_dir=destination / "cache",
        cpu_token_state_path=destination / "cpu-tokens.json",
        engine_numerics_revision=OPENCFD_2606_IDENTITY.numerics_revision,
        engine_adapter_contract_version=OPENCFD_2606_IDENTITY.adapter_contract_version,
        celery_queue=OPENCFD_2606.queue_name,
        engine_image_digest=PINNED_WORKER_IMAGE,
        engine_application_source_sha256=candidate_source_sha256,
        engine_package_sha256=native_identity.get("package_sha256") or None,
        engine_binary_sha256=native_identity["rhoSimpleFoam_sha256"],
    )
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
    requested_angles = sorted({case.aoa_deg for case in request.cases()})
    finite_converged_angles = sorted({point.aoa_deg for polar in result.polars for point in polar.points if _finite_converged(point)})
    report = {"kind": "pressure-initialization-production-reproduction", "source_job": "527fc7c9-7eaf-4d52-a23f-dc6b6b774bb3",
              "source_sha256": SOURCE_SIGNATURE, "local_job": job_id,
              "source_export_sha256": SOURCE_EXPORT_SIGNATURE,
              "candidate_application_source_sha256": candidate_source_sha256,
              "source_identity": {"request_expected_engine": historical_expected_engine,
                                  "effective_expected_engine": request.expected_engine.model_dump(mode="json"),
                                  "request_expected_execution_pool": historical_expected_execution_pool,
                                  "effective_expected_execution_pool": request.expected_execution_pool,
                                  "request_expected_mesh_recovery_version": historical_mesh_recovery_version,
                                  "effective_expected_mesh_recovery_version": request.expected_mesh_recovery_version,
                                  "worker_image_digest": PINNED_WORKER_IMAGE,
                                  "native_runtime": native_identity},
              "fixture_change": "one trailing newline added to the exact retained production JSON export",
              "differences": [f"{args.iterations} CFD iterations after initialization", "serial CPU allocation", "no rendered media", "isolated empty cache", "diagnostic continues to the second angle after rejected CFD; production promotion policy is unchanged"],
              "airfoil_polar_validation": False,
              "native_acceptance": {"requested_angles": requested_angles,
                                    "finite_converged_angles": finite_converged_angles,
                                    "all_requested_angles_accepted": finite_converged_angles == requested_angles},
              "outcomes": outcomes, "initialization_receipts": receipts}
    (destination / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"report": str(destination / "report.json"), "outcomes": outcomes,
                      "initializations": len(receipts), "airfoil_polar_validation": False}), flush=True)
    if not outcomes:
        raise RuntimeError("No native case was attempted")
    if finite_converged_angles != requested_angles:
        raise RuntimeError(
            "Native reproduction did not produce finite converged coefficients for every requested angle"
        )


if __name__ == "__main__":
    main()
