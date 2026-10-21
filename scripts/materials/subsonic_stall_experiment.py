"""Bounded source-bound subsonic stall experiment planning and execution."""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping, Sequence
from uuid import uuid4


OUTCOME_ID = "p10f9c0ef9d2f7efc"
PLAN_KIND = "bounded-subsonic-stall-experiment-v1"
DEFAULT_SNAPSHOT = Path(
    ".codex-artifacts/subsonic-stall-repair-20261009/production-request-snapshot.jsonl"
)
DEFAULT_MANIFEST = DEFAULT_SNAPSHOT.with_name("request-manifest.json")
DEFAULT_MATERIAL = Path("tests/fixtures/air-thermophysics-audit.json")
EXPECTED_SNAPSHOT_SHA256 = "822de4bbdf1780b79a9805d9c48a5708716b55ef0465fee06fdc33c01da5dfb1"
EXPECTED_SNAPSHOT_BYTES = 8624
EXPECTED_MATERIAL_SHA256 = "fc174fc87eb50300a2e5412bcc86e5b334bb7ba20a3645c365b0e55f81013766"
REFERENCE_TEMPERATURE_K = 288.15
REFERENCE_PRESSURE_PA = 101325.0
COORDINATOR_CHECK_NAME = "bounded-native-experiment"
COORDINATOR_RUNTIME_ENV = (
    "DEVCOORDINATOR_RUN_ID",
    "DEVCOORDINATOR_CHECK_NAME",
    "DEVCOORDINATOR_CHECK_SCRATCH",
    "DEVCOORDINATOR_SHARED_ARTIFACTS",
    "DEVCOORDINATOR_DIAGNOSTICS_DIR",
    "DEVCOORDINATOR_EVIDENCE_DIR",
    "DEVCOORDINATOR_DIAGNOSTIC_FD",
)
PROTECTED_WRITE_ENV = (
    "AIRFOILFOAM_CONTROL_PLANE_TOKEN",
    "AIRFOILFOAM_EVIDENCE_BUCKET",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_APPLICATION_CREDENTIALS_JSON",
    "CLOUDSDK_AUTH_ACCESS_TOKEN",
)
CONTROLLER_FIELDS = (
    "execution_id",
    "expected_engine",
    "expected_execution_pool",
    "expected_mesh_recovery_version",
    "expected_urans_recovery_version",
    "expected_urans_initialization_version",
    "expected_solver_budget_version",
    "expected_local_time_step_version",
)
EXPECTED_PROFILES = {
    "e332": {
        "source_job": "50b9cfe1-55cd-49c2-ba02-367136d7f9dc",
        "speed_mps": 30.0,
        "name": "E332",
        "stall_basis": "Observed stall or no-progress begins near 15 degrees AoA.",
        "angles": {
            "attached": (0.0, 5.0, 10.0),
            "stall_onset": (15.0,),
            "stalled": (20.0,),
        },
    },
    "e432": {
        "source_job": "2bedd5c3-4292-42ef-9044-f8080736cf36",
        "speed_mps": 90.0,
        "name": "E432",
        "stall_basis": "Observed stall or no-progress begins near 8 to 9 degrees AoA.",
        "angles": {
            "attached": (0.0, 5.0),
            "stall_onset": (8.0, 9.0),
            "stalled": (15.0, 20.0),
        },
    },
}
EXPECTED_MESH = {
    "mesher": "blockmesh-cgrid",
    "n_surface": 130,
    "n_radial": 80,
    "n_wake": 60,
    "span_chords": 0.1,
    "target_y_plus": 1,
    "wake_length_chords": 12,
    "farfield_radius_chords": 15,
}
EXPECTED_AOA = [float(value) for value in range(-5, 21)]


class ExperimentError(ValueError):
    """Raised when an exact input or isolation contract is not satisfied."""


@dataclass(frozen=True)
class SnapshotRecord:
    profile: str
    source_job: str
    row: Mapping[str, Any]
    request: Any


@dataclass(frozen=True)
class MaterialBinding:
    gas: Any
    state: Any
    sha256: str
    source_audit_sha256: str


def _canonical_bytes(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _sha256_path(path: Path) -> str:
    return _sha256_bytes(path.read_bytes())


def _read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise ExperimentError(f"Expected a JSON object in {path}")
    return value


def _assert_exact_request(profile: str, row: Mapping[str, Any], request: Any, manifest: Mapping[str, Any]) -> None:
    expected = EXPECTED_PROFILES.get(profile)
    if expected is None:
        raise ExperimentError(f"Unexpected retained profile {profile!r}")
    if row.get("source_job") != expected["source_job"] or row.get("engine_job_id") != expected["source_job"]:
        raise ExperimentError(f"{profile} source job identity changed")
    if row.get("runtime_build_id") != manifest.get("runtime_build_id"):
        raise ExperimentError(f"{profile} runtime build identity changed")
    if row.get("application_source_sha256") != manifest.get("application_source_sha256"):
        raise ExperimentError(f"{profile} application source identity changed")
    if request.airfoil.name.upper() != expected["name"]:
        raise ExperimentError(f"{profile} airfoil identity changed")
    if request.aoa.expand() != EXPECTED_AOA:
        raise ExperimentError(f"{profile} AoA sweep changed")
    if request.chord_lengths != [1.0] or request.speeds != [expected["speed_mps"]]:
        raise ExperimentError(f"{profile} physical speed or chord changed")
    for field, value in EXPECTED_MESH.items():
        if getattr(request.mesh, field) != value:
            raise ExperimentError(f"{profile} mesh field {field} changed")
    solver = request.solver
    for field, value in {
        "flow_solver_family": "simpleFoam",
        "force_transient": False,
        "transient_fallback": False,
        "momentum_scheme": "linearUpwind",
        "n_iterations": 3000,
        "convergence_tolerance": 1e-5,
        "transient_max_courant": 4.0,
    }.items():
        if getattr(solver, field) != value:
            raise ExperimentError(f"{profile} solver field {field} changed")
    if request.fluid.density != 1.2250159925164 or request.fluid.nu != 0.000014665638853861052:
        raise ExperimentError(f"{profile} source material transport changed")
    if request.roughness.sand_grain_height != 0 or request.roughness.roughness_constant != 0.5:
        raise ExperimentError(f"{profile} roughness changed")
    if request.solver.turbulence.model.value != "kOmegaSST":
        raise ExperimentError(f"{profile} turbulence model changed")
    if request.solver.turbulence.intensity != 0.001 or request.solver.turbulence.viscosity_ratio != 10:
        raise ExperimentError(f"{profile} turbulence inputs changed")


def load_snapshot(
    snapshot_path: Path = DEFAULT_SNAPSHOT,
    manifest_path: Path | None = None,
) -> tuple[tuple[SnapshotRecord, ...], dict[str, Any]]:
    """Load and authenticate the two retained exact production requests."""
    from airfoilfoam.models import PolarRequest

    snapshot_path = Path(snapshot_path)
    manifest_path = Path(manifest_path) if manifest_path is not None else snapshot_path.with_name("request-manifest.json")
    source = snapshot_path.read_bytes()
    manifest = _read_json(manifest_path)
    file_record = manifest.get("files", {}).get(snapshot_path.name)
    if not isinstance(file_record, dict):
        raise ExperimentError("The request manifest does not authenticate the retained snapshot")
    actual_sha = _sha256_bytes(source)
    if (
        len(source) != file_record.get("bytes")
        or actual_sha != file_record.get("sha256")
        or len(source) != EXPECTED_SNAPSHOT_BYTES
        or actual_sha != EXPECTED_SNAPSHOT_SHA256
    ):
        raise ExperimentError("The retained production request snapshot changed")
    records: list[SnapshotRecord] = []
    for line_number, line in enumerate(source.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as error:
            raise ExperimentError(f"Invalid request snapshot JSON at line {line_number}") from error
        if not isinstance(row, dict) or not isinstance(row.get("profile"), str):
            raise ExperimentError(f"Invalid request snapshot row at line {line_number}")
        profile = row["profile"]
        request = PolarRequest.model_validate(row.get("engine_request"))
        _assert_exact_request(profile, row, request, manifest)
        records.append(SnapshotRecord(profile, row["source_job"], row, request))
    if {record.profile for record in records} != set(EXPECTED_PROFILES) or len(records) != 2:
        raise ExperimentError("The retained snapshot must contain exactly E332 and E432")
    return tuple(sorted(records, key=lambda record: record.profile)), manifest


def load_material(material_path: Path = DEFAULT_MATERIAL) -> MaterialBinding:
    """Load the source-derived material needed by an explicit compressible control."""
    from airfoilfoam.numerical_canary import source_material_for_canary
    from airfoilfoam.thermodynamics import ThermodynamicState

    material_path = Path(material_path)
    material = _read_json(material_path)
    material_sha256 = _sha256_path(material_path)
    if material_sha256 != EXPECTED_MATERIAL_SHA256:
        raise ExperimentError("The source-derived control material fixture changed")
    if material.get("installed") is not False or material.get("kind") != "source-derived-native-material-regression":
        raise ExperimentError("The rhoPimple control requires an isolated source-derived material fixture")
    gas = source_material_for_canary(material_path)
    state = ThermodynamicState(temperature_k=REFERENCE_TEMPERATURE_K, pressure_pa=REFERENCE_PRESSURE_PA)
    return MaterialBinding(
        gas=gas,
        state=state,
        sha256=material_sha256,
        source_audit_sha256=str(material.get("source_audit_sha256", "")),
    )


def selected_angles(profile: str) -> dict[str, tuple[float, ...]]:
    """Return the fixed attached, onset, and representative stalled selections."""
    if profile not in EXPECTED_PROFILES:
        raise ExperimentError(f"Unknown profile {profile!r}")
    return {category: tuple(angles) for category, angles in EXPECTED_PROFILES[profile]["angles"].items()}


def _isolated_payload(payload: Mapping[str, Any], angles: Sequence[float]) -> dict[str, Any]:
    isolated = copy.deepcopy(dict(payload))
    isolated["aoa"] = {"angles": [float(angle) for angle in angles]}
    for field in CONTROLLER_FIELDS:
        if field in isolated:
            isolated[field] = None
    resources = dict(isolated.get("resources", {}))
    resources.update(cpu_budget=1, case_concurrency=1, solver_processes=1)
    isolated["resources"] = resources
    solver = dict(isolated["solver"])
    solver.update(write_images=[], frame_fields=[])
    isolated["solver"] = solver
    return isolated


def _material_matches_request(record: SnapshotRecord, material: MaterialBinding) -> None:
    density = material.gas.density(material.state)
    dynamic_viscosity = material.gas.dynamic_viscosity(material.state.temperature_k)
    expected_dynamic_viscosity = record.request.fluid.density * record.request.fluid.nu
    if not math.isclose(density, record.request.fluid.density, rel_tol=1e-9, abs_tol=1e-12):
        raise ExperimentError(f"{record.profile} material density does not match the retained request")
    if not math.isclose(dynamic_viscosity, expected_dynamic_viscosity, rel_tol=1e-9, abs_tol=1e-12):
        raise ExperimentError(f"{record.profile} material viscosity does not match the retained request")


def _request_digest(request: Any) -> str:
    return _sha256_bytes(_canonical_bytes(request.model_dump(mode="json")))


def _make_run(
    record: SnapshotRecord,
    material: MaterialBinding,
    categories: Mapping[str, Sequence[float]],
    angles: Sequence[float],
    solver_family: str,
) -> dict[str, Any]:
    from airfoilfoam.models import PolarRequest
    from airfoilfoam.openfoam.dialects import OPENCFD_2606_IDENTITY, get_openfoam_dialect

    payload = _isolated_payload(record.row["engine_request"], angles)
    payload["expected_engine"] = OPENCFD_2606_IDENTITY.model_dump(mode="json")
    payload["expected_execution_pool"] = get_openfoam_dialect(OPENCFD_2606_IDENTITY).queue_name
    control_changes: dict[str, Any] = {}
    if solver_family == "simpleFoam":
        request = PolarRequest.model_validate(payload)
    elif solver_family == "rhoPimpleFoam":
        _material_matches_request(record, material)
        payload["fluid"] = {
            **dict(payload["fluid"]),
            "gas": material.gas.model_dump(mode="json"),
        }
        payload["flow_state"] = material.state.model_dump(mode="json")
        payload["solver"] = {
            **dict(payload["solver"]),
            "flow_solver_family": "rhoPimpleFoam",
            "force_transient": True,
            "transient_fallback": False,
            "turbulent_prandtl": 0.85,
        }
        control_changes = {
            "solver.flow_solver_family": "rhoPimpleFoam",
            "solver.force_transient": True,
            "solver.turbulent_prandtl": 0.85,
            "fluid.gas": "source-derived material fixture",
            "flow_state": {"temperature_k": REFERENCE_TEMPERATURE_K, "pressure_pa": REFERENCE_PRESSURE_PA},
        }
        request = PolarRequest.model_validate(payload)
    else:
        raise ExperimentError(f"Unsupported experiment solver family {solver_family}")
    run_id = f"{record.profile}-{solver_family}-selected-angles"
    return {
        "run_id": run_id,
        "comparison_group": record.profile,
        "profile": record.profile,
        "source_job": record.source_job,
        "aoas": [float(angle) for angle in angles],
        "angle_categories": {category: [float(angle) for angle in values] for category, values in categories.items()},
        "expected_behavior": "attached-onset-stalled matrix",
        "solver_family": solver_family,
        "control_changes": control_changes,
        "isolation_overrides": {
            "controller_fields_cleared": list(CONTROLLER_FIELDS),
            "resources": {"cpu_budget": 1, "case_concurrency": 1, "solver_processes": 1},
            "solver_output": {"write_images": [], "frame_fields": []},
        },
        "source_request_sha256": _sha256_bytes(_canonical_bytes(record.row["engine_request"])),
        "request_sha256": _request_digest(request),
        "request": request.model_dump(mode="json"),
        "production_evidence": False,
        "accepted_cfd": False,
        "polar_validated": False,
    }


def build_experiment_plan(
    snapshot_path: Path = DEFAULT_SNAPSHOT,
    material_path: Path = DEFAULT_MATERIAL,
    manifest_path: Path | None = None,
) -> dict[str, Any]:
    """Build the immutable bounded case matrix without launching a solver."""
    records, manifest = load_snapshot(snapshot_path, manifest_path)
    material = load_material(material_path)
    runs: list[dict[str, Any]] = []
    selection: dict[str, dict[str, list[float]]] = {}
    for record in records:
        categories = selected_angles(record.profile)
        selection[record.profile] = {category: list(angles) for category, angles in categories.items()}
        angles = tuple(angle for values in categories.values() for angle in values)
        for solver_family in ("simpleFoam", "rhoPimpleFoam"):
            runs.append(_make_run(record, material, categories, angles, solver_family))
    source_bytes = Path(snapshot_path).read_bytes()
    material_payload = _read_json(Path(material_path))
    plan = {
        "kind": PLAN_KIND,
        "version": 1,
        "outcome_id": OUTCOME_ID,
        "production_write": False,
        "native_solver_started": False,
        "accepted_cfd": False,
        "polar_validated": False,
        "execution_policy": {
            "native_solver": "governed-only",
            "coordinator_admission": "single-check",
            "job_order": "sequential",
            "max_concurrent_jobs": 1,
            "remote_upload": False,
            "control_plane_write": False,
            "campaign_database_write": False,
            "diagnostic_artifacts_only": True,
        },
        "source_snapshot": {
            "path_name": Path(snapshot_path).name,
            "bytes": len(source_bytes),
            "sha256": _sha256_bytes(source_bytes),
            "manifest_sha256": _sha256_path(
                Path(manifest_path) if manifest_path is not None else Path(snapshot_path).with_name("request-manifest.json")
            ),
            "application_source_sha256": manifest["application_source_sha256"],
            "runtime_build_id": manifest["runtime_build_id"],
            "profiles": [record.profile for record in records],
            "source_jobs": [record.source_job for record in records],
        },
        "material_binding": {
            "sha256": material.sha256,
            "source_audit_sha256": material.source_audit_sha256,
            "installed": material_payload.get("installed"),
            "reference_temperature_k": REFERENCE_TEMPERATURE_K,
            "reference_pressure_pa": REFERENCE_PRESSURE_PA,
            "thermodynamic_limits_k": {
                "minimum": material.gas.nasa7.minimum_temperature_k,
                "maximum": material.gas.nasa7.maximum_temperature_k,
            },
            "limits_changed": False,
        },
        "selection": selection,
        "bounds": {
            "profiles": len(records),
            "physical_angles": sum(sum(len(angles) for angles in groups.values()) for groups in selection.values()),
            "solver_families": 2,
            "planned_cases": len(runs),
            "max_cases_per_profile": 2,
        },
        "stall_basis": {profile: EXPECTED_PROFILES[profile]["stall_basis"] for profile in selection},
        "runs": runs,
    }
    if len(runs) != 4:
        raise ExperimentError(f"Unexpected bounded experiment size: {len(runs)}")
    return plan


def _assert_destination_isolated(destination: Path) -> None:
    resolved = destination.resolve(strict=False)
    for protected in (Path("/data/airfoilfoam"), Path("/opt/airfoils-pro")):
        if resolved == protected or protected in resolved.parents:
            raise ExperimentError(f"Diagnostic output cannot be written below {protected}")


def assert_no_production_write(
    destination: Path,
    environ: Mapping[str, str] | None = None,
    settings: Any | None = None,
) -> None:
    """Fail closed when credentials or storage point at a production writer."""
    _assert_destination_isolated(Path(destination))
    environ = os.environ if environ is None else environ
    present = [name for name in PROTECTED_WRITE_ENV if environ.get(name)]
    if present:
        raise ExperimentError(f"Production write credentials are present: {', '.join(present)}")
    if settings is None:
        return
    if settings.evidence_bucket or settings.control_plane_token or settings.evidence_remote_only:
        raise ExperimentError("Isolated experiment settings contain evidence publication credentials")
    destination = Path(destination).resolve()
    paths = [settings.data_dir, settings.cache_dir, settings.cpu_token_state_path]
    if settings.evidence_hydration_cache_dir is not None:
        paths.append(settings.evidence_hydration_cache_dir)
    for value in paths:
        if value is None:
            continue
        path = Path(value).resolve(strict=False)
        if path != destination and destination not in path.parents:
            raise ExperimentError(f"Isolated storage escapes the diagnostic output: {path}")


def _assert_governed_native_execution(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    environ = os.environ if environ is None else environ
    missing = [name for name in COORDINATOR_RUNTIME_ENV if not environ.get(name)]
    if missing:
        missing_names = ", ".join(missing)
        raise ExperimentError(
            "Native execution requires a DevCoordinator governed check with injected runtime metadata; "
            f"missing {missing_names}"
        )
    if environ["DEVCOORDINATOR_CHECK_NAME"] != COORDINATOR_CHECK_NAME:
        raise ExperimentError(
            "Native execution must run from the bounded-native-experiment coordinator check"
        )
    try:
        os.fstat(int(environ["DEVCOORDINATOR_DIAGNOSTIC_FD"]))
    except (OSError, ValueError) as error:
        raise ExperimentError(
            "Native execution requires the coordinator-injected diagnostic descriptor"
        ) from error
    return {name: environ[name] for name in COORDINATOR_RUNTIME_ENV}


def _write_exclusive(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("xb") as target:
            target.write(content)
    except FileExistsError as error:
        raise ExperimentError(f"Immutable artifact already exists: {path}") from error


def _write_json(path: Path, value: Any) -> None:
    _write_exclusive(path, (json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8"))


def write_plan_artifact(
    plan: Mapping[str, Any],
    destination: Path,
    snapshot_path: Path = DEFAULT_SNAPSHOT,
    manifest_path: Path | None = None,
    material_path: Path = DEFAULT_MATERIAL,
) -> dict[str, Any]:
    """Write a new immutable plan artifact and authenticated input copies."""
    destination = Path(destination)
    assert_no_production_write(destination)
    if destination.exists():
        raise ExperimentError(f"Immutable artifact destination already exists: {destination}")
    destination.mkdir(parents=True, exist_ok=False)
    manifest_path = Path(manifest_path) if manifest_path is not None else Path(snapshot_path).with_name("request-manifest.json")
    _write_json(destination / "experiment-plan.json", plan)
    _write_exclusive(destination / "inputs/production-request-snapshot.jsonl", Path(snapshot_path).read_bytes())
    _write_exclusive(destination / "inputs/request-manifest.json", Path(manifest_path).read_bytes())
    _write_exclusive(destination / "inputs/material.json", Path(material_path).read_bytes())
    files = {}
    for path in sorted(destination.rglob("*")):
        if path.is_file():
            files[path.relative_to(destination).as_posix()] = {
                "bytes": path.stat().st_size,
                "sha256": _sha256_path(path),
            }
    artifact_manifest = {
        "kind": "immutable-subsonic-stall-diagnostic-artifact-v1",
        "outcome_id": OUTCOME_ID,
        "production_write": False,
        "files": files,
    }
    _write_json(destination / "artifact-manifest.json", artifact_manifest)
    manifest_bytes = (destination / "artifact-manifest.json").read_bytes()
    _write_exclusive(destination / "artifact-manifest.sha256", (_sha256_bytes(manifest_bytes) + "\n").encode("ascii"))
    return {
        "destination": str(destination),
        "plan_sha256": _sha256_path(destination / "experiment-plan.json"),
        "manifest_sha256": _sha256_path(destination / "artifact-manifest.json"),
        "planned_cases": plan["bounds"]["planned_cases"],
    }


def execute_governed_plan(plan: Mapping[str, Any], destination: Path) -> dict[str, Any]:
    """Execute the plan through the existing engine job path after governance checks."""
    coordinator_runtime = _assert_governed_native_execution()
    destination = Path(destination)
    assert_no_production_write(destination)
    if not (destination / "experiment-plan.json").is_file():
        raise ExperimentError("The immutable plan artifact must be written before native execution")
    expected_plan = (json.dumps(plan, indent=2, sort_keys=True, allow_nan=False) + "\n").encode("utf-8")
    if (destination / "experiment-plan.json").read_bytes() != expected_plan:
        raise ExperimentError("The sealed experiment plan changed before native execution")
    from airfoilfoam.config import Settings
    from airfoilfoam.jobs import execute_job
    from airfoilfoam.models import PolarRequest
    from airfoilfoam.provenance import application_source_sha256
    from airfoilfoam.storage import JobStore
    from scripts.materials.reproduce_mach3_failure import authenticate_archives, summarize_outcomes

    engine_data = destination / "engine-data"
    settings = Settings(
        data_dir=engine_data,
        cache_dir=destination / "engine-cache",
        cpu_token_state_path=destination / "cpu-tokens.json",
        evidence_bucket=None,
        control_plane_token=None,
        evidence_remote_only=False,
        engine_application_source_sha256=application_source_sha256(Path(__file__).resolve().parents[2]),
        build_id="isolated-subsonic-stall-experiment",
    )
    assert_no_production_write(destination, settings=settings)
    store = JobStore(settings)
    run_reports: list[dict[str, Any]] = []
    for ordinal, run in enumerate(plan["runs"], start=1):
        job_id = str(uuid4())
        request = PolarRequest.model_validate(run["request"])
        report: dict[str, Any] = {
            "kind": "subsonic-stall-diagnostic-run-v1",
            "run_id": run["run_id"],
            "ordinal": ordinal,
            "job_id": job_id,
            "profile": run["profile"],
            "source_job": run["source_job"],
            "aoas": run["aoas"],
            "angle_categories": run["angle_categories"],
            "solver_family": run["solver_family"],
            "source_request_sha256": run["source_request_sha256"],
            "request_sha256": run["request_sha256"],
            "production_evidence": False,
            "accepted_cfd": False,
            "polar_validated": False,
        }
        try:
            store.create(job_id, request)
            result = execute_job(job_id, request, store=store, settings=settings)
            report.update(
                {
                    "solver_state": result.state.value,
                    "solver_message": result.message,
                    "case_outcomes": summarize_outcomes(result),
                }
            )
            try:
                report["archive_proofs"] = authenticate_archives(store.job_dir(job_id))
            except Exception as error:
                report["archive_proof_error"] = f"{type(error).__name__}: {error}"
        except Exception as error:
            report["diagnostic_error"] = f"{type(error).__name__}: {error}"
        report_path = destination / "runs" / f"{ordinal:03d}-{run['run_id']}.json"
        _write_json(report_path, report)
        run_reports.append(report)
    overall = {
        "kind": "subsonic-stall-diagnostic-report-v1",
        "outcome_id": OUTCOME_ID,
        "native_solver_started": True,
        "production_write": False,
        "production_evidence": False,
        "accepted_cfd": False,
        "polar_validated": False,
        "coordinator_execution": {
            "run_id": coordinator_runtime["DEVCOORDINATOR_RUN_ID"],
            "check_name": coordinator_runtime["DEVCOORDINATOR_CHECK_NAME"],
            "runtime_metadata": "executor-injected",
        },
        "execution_policy": dict(plan["execution_policy"]),
        "plan_sha256": _sha256_path(destination / "experiment-plan.json"),
        "execution_runtime": settings.engine_runtime_identity().model_dump(mode="json"),
        "planned_cases": len(run_reports),
        "failed_diagnostics": sum("diagnostic_error" in report for report in run_reports),
        "runs": [{key: report.get(key) for key in ("run_id", "job_id", "profile", "aoas", "solver_family", "solver_state", "diagnostic_error")} for report in run_reports],
    }
    _write_json(destination / "execution-report.json", overall)
    _write_exclusive(destination / "execution-report.sha256", (_sha256_path(destination / "execution-report.json") + "\n").encode("ascii"))
    execution_files = {}
    for path in sorted([*destination.glob("runs/*.json"), destination / "execution-report.json", destination / "execution-report.sha256"]):
        execution_files[path.relative_to(destination).as_posix()] = {
            "bytes": path.stat().st_size,
            "sha256": _sha256_path(path),
        }
    _write_json(
        destination / "execution-manifest.json",
        {
            "kind": "immutable-subsonic-stall-execution-manifest-v1",
            "outcome_id": OUTCOME_ID,
            "production_write": False,
            "files": execution_files,
        },
    )
    _write_exclusive(
        destination / "execution-manifest.sha256",
        (_sha256_path(destination / "execution-manifest.json") + "\n").encode("ascii"),
    )
    return overall


def main() -> None:
    parser = argparse.ArgumentParser(description="Plan or execute the governed subsonic stall diagnostic")
    parser.add_argument("--mode", choices=("plan", "execute"), default="plan")
    parser.add_argument("--snapshot", type=Path, default=DEFAULT_SNAPSHOT)
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--material", type=Path, default=DEFAULT_MATERIAL)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    plan = build_experiment_plan(arguments.snapshot, arguments.material, arguments.manifest)
    if arguments.mode == "execute":
        _assert_governed_native_execution()
    receipt = write_plan_artifact(plan, arguments.output, arguments.snapshot, arguments.manifest, arguments.material)
    if arguments.mode == "execute":
        receipt["execution"] = execute_governed_plan(plan, arguments.output)
    print(json.dumps(receipt, sort_keys=True), flush=True)


if __name__ == "__main__":
    main()
