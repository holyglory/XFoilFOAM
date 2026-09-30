import argparse
from contextlib import nullcontext
import hashlib
import json
from pathlib import Path
import re
import shutil
from uuid import UUID, uuid4
from unittest.mock import patch

import airfoilfoam
from airfoilfoam import pipeline
from airfoilfoam.config import Settings
from airfoilfoam.jobs import execute_job
from airfoilfoam.models import PolarRequest
from airfoilfoam.meshing.base import register_mesher
from airfoilfoam.meshing.blockmesh import BlockMeshCGrid, FINITE_EDGE_TOPOLOGY
from airfoilfoam.openfoam.potential_initialization import velocity_internal_entry
from airfoilfoam.openfoam.rans_hold import root_entry
from airfoilfoam.openfoam.runner import LocalRunner
from airfoilfoam.openfoam import local_startup
from airfoilfoam.storage import JobStore
from scripts.materials.reproduce_mach3_failure import (
    authenticate_archives,
    collect_diagnostics,
    diagnostic_source_identity,
    native_image_fingerprints,
    summarize_outcomes,
)
from scripts.materials.inspect_mach3_startup import preserve_early_frames


def replay_request(path, expected_sha256, *, anchor_zero=False, finite_edge_mesh=False):
    if type(anchor_zero) is not bool:
        raise ValueError("The zero-anchor comparison must be explicit")
    if type(finite_edge_mesh) is not bool or (finite_edge_mesh and anchor_zero):
        raise ValueError("The finite-edge comparison requires the original multi-angle sweep")
    content = Path(path).read_bytes()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or hashlib.sha256(content).hexdigest() != expected_sha256:
        raise ValueError("The retained production request changed")
    source = json.loads(content)
    source_job = str(UUID(source["source_job"]))
    original = PolarRequest.model_validate(source["engine_request"])
    if original.solver.flow_solver_family != "rhoCentralFoam" or original.solver.force_transient or original.solver.momentum_scheme != "upwind":
        raise ValueError("This replay requires the production density-based fast recipe")
    if original.fluid.gas is None or original.flow_state is None:
        raise ValueError("The production replay requires its actual gas and flow state")
    payload = original.model_dump(mode="json")
    for key in ("execution_id", "expected_engine", "expected_execution_pool", "expected_mesh_recovery_version"):
        payload[key] = None
    payload["resources"].update(cpu_budget=1, solver_processes=1, case_concurrency=1)
    payload["solver"].update(write_images=[], frame_fields=[])
    if anchor_zero:
        payload["aoa"] = {"angles": [0]}
    if finite_edge_mesh:
        if len(original.aoa.expand()) < 2:
            raise ValueError("The finite-edge comparison requires the original multi-angle sweep")
        payload["mesh"]["mesher"] = "blockmesh-cgrid-finite-edge"
    return source_job, original, PolarRequest.model_validate(payload)


def initialize_quiescent_velocity(directory):
    directory = Path(directory)
    velocity = directory / "0/U"
    original = velocity.read_bytes()
    text, entry = velocity_internal_entry(original)
    if entry[1] != "uniform":
        raise ValueError("Quiescent initialization must not replace a carried field")
    protected = {name: (directory / name).read_bytes() for name in ("0/p", "0/T", "constant/thermophysicalProperties")}
    updated = (text[:entry.start()] + "internalField uniform (0 0 0);" + text[entry.end():]).encode()
    evidence = directory / "system/quiescentInitialization" / str(uuid4())
    evidence.mkdir(parents=True, exist_ok=False)
    (evidence / "U.original").write_bytes(original)
    (evidence / "U.applied").write_bytes(updated)
    staged = directory / "0" / f".U-{evidence.name}"
    staged.write_bytes(updated)
    staged.replace(velocity)
    if any((directory / name).read_bytes() != content for name, content in protected.items()):
        raise ValueError("Quiescent initialization changed protected physical fields")
    receipt = {"kind": "isolated-quiescent-initial-velocity-v1", "aerodynamic_evidence": False,
               "original_sha256": hashlib.sha256(original).hexdigest(),
               "applied_sha256": hashlib.sha256(updated).hexdigest(),
               "protected_sha256": {name: hashlib.sha256(content).hexdigest() for name, content in protected.items()}}
    (evidence / "receipt.json").write_text(json.dumps(receipt, allow_nan=False) + "\n")
    return receipt


def retain_failed_startup(directory, destination):
    directory = Path(directory)
    frames = sorted(path for path in directory.iterdir() if path.is_dir() and path.name.isdigit() and int(path.name) > 0)
    if not frames or any(int(path.name) > 50 for path in frames):
        return None
    destination = Path(destination) / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    for source in [directory / name for name in ("0", "constant", "system")] + frames:
        shutil.copytree(source, destination / source.name)
    for source in directory.iterdir():
        if source.is_file() and (source.name.startswith("log.") or source.name == "material-domain-diagnostic.json"):
            shutil.copyfile(source, destination / source.name)
    files = sorted(path for path in destination.rglob("*") if path.is_file())
    receipt = {"kind": "failed-fast-startup-field-snapshot-v1", "coordinate_kind": "iteration",
               "production_evidence": False, "frames": sorted(int(path.name) for path in frames),
               "input_case": str(directory),
               "files": {path.relative_to(destination).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in files}}
    (destination / "capture.json").write_text(json.dumps(receipt, allow_nan=False) + "\n")
    return str(destination)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--anchor-zero", action="store_true")
    parser.add_argument("--quiescent-start", action="store_true")
    parser.add_argument("--finite-edge-mesh", action="store_true")
    parser.add_argument("--early-fields", action="store_true")
    parser.add_argument("--startup-courant", type=float, choices=[0.1, 0.05])
    arguments = parser.parse_args()
    source_job, original, request = replay_request(arguments.request, arguments.sha256, anchor_zero=arguments.anchor_zero,
                                                   finite_edge_mesh=arguments.finite_edge_mesh)
    if arguments.finite_edge_mesh:
        register_mesher(BlockMeshCGrid(topology=FINITE_EDGE_TOPOLOGY))
    destination = arguments.destination / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    driver_source = Path(__file__).read_bytes()
    (destination / "replay-driver.py").write_bytes(driver_source)
    settings = Settings(
        data_dir=destination / "data", cache_dir=destination / "cache",
        cpu_token_state_path=destination / "cpu-tokens.json",
        **diagnostic_source_identity(Path(airfoilfoam.__file__).resolve().parents[2], airfoilfoam.__file__),
        **native_image_fingerprints(),
    )
    if settings.evidence_bucket or settings.control_plane_token:
        raise ValueError("The isolated replay must not have production publication credentials")
    store = JobStore(settings)
    job_id = str(uuid4())
    store.create(job_id, request)
    report = {
        "kind": "source-bound-production-numerical-replay-v1", "source_job": source_job,
        "source_sha256": arguments.sha256, "driver_sha256": hashlib.sha256(driver_source).hexdigest(),
        "local_job": job_id, "production_evidence": False, "physical_validation": False,
        "original_request": original.model_dump(mode="json"), "effective_request": request.model_dump(mode="json"),
        "execution_runtime": settings.engine_runtime_identity().model_dump(mode="json"),
        "differences": ["current source-preserving engine code", "isolated identity and empty cache",
                        "one solver process", "no rendered media or publication"],
        "diagnostic_completed": False,
    }
    if arguments.anchor_zero:
        report["differences"].append("zero-degree starting-anchor diagnostic instead of the original requested angles")
    if arguments.finite_edge_mesh:
        report["differences"].append("explicit finite-edge-central-wake-v1 body-fitted mesh; original physical contour retained")
    original_solve = pipeline.solve_cold_steady
    original_native_solver = LocalRunner.solver
    captures = []
    capture_errors = []

    def solver_with_early_fields(runner, directory, command, processes, *args, **kwargs):
        if command == "rhoCentralFoam":
            control = (Path(directory) / "system/controlDict").read_text()
            if root_entry(control, "startFrom") == "startTime" and float(root_entry(control, "endTime")) == 50:
                preserve_early_frames(directory)
        return original_native_solver(runner, directory, command, processes, *args, **kwargs)

    def solve_with_initial_guess(directory, *args, **kwargs):
        if arguments.quiescent_start and not kwargs.get("seeded", False):
            initialize_quiescent_velocity(directory)
        try:
            return original_solve(directory, *args, **kwargs)
        finally:
            if arguments.early_fields:
                try:
                    captured = retain_failed_startup(directory, destination / "early-fields")
                    if captured:
                        captures.append(captured)
                except Exception as capture_error:
                    capture_errors.append(f"{type(capture_error).__name__}: {capture_error}")

    initialization = patch.object(pipeline, "solve_cold_steady", solve_with_initial_guess) if arguments.quiescent_start or arguments.early_fields else nullcontext()
    output_capture = patch.object(LocalRunner, "solver", solver_with_early_fields) if arguments.early_fields else nullcontext()
    startup_control = patch.object(local_startup, "STARTUP_COURANT", arguments.startup_courant) if arguments.startup_courant is not None else nullcontext()
    if arguments.quiescent_start:
        report["differences"].append("quiescent internal velocity initial guess only; physical boundaries, pressure and temperature unchanged")
    if arguments.early_fields:
        report["differences"].append("retain every first-phase iteration and snapshot failed startup fields; no stepping or physical changes")
    if arguments.startup_courant is not None:
        report["differences"].append(f"startup Courant{arguments.startup_courant} for the existing50updates; original continuation ceiling and full horizon retained")
    try:
        with initialization, output_capture, startup_control:
            result = execute_job(job_id, request, store=store, settings=settings)
        report.update(solver_state=result.state.value, solver_message=result.message,
                      case_outcomes=summarize_outcomes(result),
                      material_diagnostics=collect_diagnostics(store.job_dir(job_id)),
                      archive_proofs=authenticate_archives(store.job_dir(job_id)))
        if not report["case_outcomes"]:
            raise RuntimeError("The production replay produced no actual case outcome")
        if capture_errors:
            raise RuntimeError("Startup field capture failed; physical case outcomes remain retained")
        report["diagnostic_completed"] = True
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"
        raise
    finally:
        report["early_captures"] = captures
        report["capture_errors"] = capture_errors
        (destination / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        print(json.dumps({"report": str(destination / "report.json"), "source_job": source_job,
                          "diagnostic_completed": report["diagnostic_completed"],
                          "case_outcomes": report.get("case_outcomes", []), "error": report.get("error")}), flush=True)


if __name__ == "__main__":
    main()
