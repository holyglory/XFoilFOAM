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
from airfoilfoam.case.compressible import CompressibleCaseBuilder
from airfoilfoam.jobs import execute_job
from airfoilfoam.models import PolarRequest
from airfoilfoam.meshing.base import register_mesher
from airfoilfoam.meshing.blockmesh import BlockMeshCGrid, FINITE_EDGE_TOPOLOGY
from airfoilfoam.openfoam.potential_initialization import velocity_internal_entry
from airfoilfoam.openfoam.rans_hold import latest_iteration, root_entry
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
from scripts.materials.replay_precise_state import bounded_gradients


def replay_request(path, expected_sha256, *, anchor_zero=False, finite_edge_mesh=False, precise_startup=False):
    if type(anchor_zero) is not bool:
        raise ValueError("The zero-anchor comparison must be explicit")
    if type(finite_edge_mesh) is not bool or (finite_edge_mesh and anchor_zero):
        raise ValueError("The finite-edge comparison requires the original multi-angle sweep")
    if type(precise_startup) is not bool or (precise_startup and (anchor_zero or finite_edge_mesh)):
        raise ValueError("Precise startup must retain its sealed angle and mesh")
    content = Path(path).read_bytes()
    if not re.fullmatch(r"[0-9a-f]{64}", expected_sha256) or hashlib.sha256(content).hexdigest() != expected_sha256:
        raise ValueError("The retained production request changed")
    source = json.loads(content)
    source_job = str(UUID(source["source_job"]))
    original = PolarRequest.model_validate(source["engine_request"])
    if precise_startup:
        if (source.get("source_kind") != "sealed-precise-recipe-not-executed"
                or not re.fullmatch(r"[0-9a-f]{64}", source.get("source_recipe_sha256", ""))
                or original.solver.flow_solver_family != "rhoCentralFoam"
                or not original.solver.force_transient or original.solver.urans_fidelity != "full"
                or original.solver.momentum_scheme != "linearUpwind"
                or len(original.aoa.expand()) != 1):
            raise ValueError("Precise startup requires its sealed full transient recipe")
    elif original.solver.flow_solver_family != "rhoCentralFoam" or original.solver.force_transient or original.solver.momentum_scheme != "upwind":
        raise ValueError("This replay requires the production density-based fast recipe")
    if original.fluid.gas is None or original.flow_state is None:
        raise ValueError("The production replay requires its actual gas and flow state")
    payload = original.model_dump(mode="json")
    for key in ("execution_id", "expected_engine", "expected_execution_pool", "expected_mesh_recovery_version"):
        payload[key] = None
    payload["resources"].update(cpu_budget=1, solver_processes=1, case_concurrency=1)
    if precise_startup:
        payload["resources"].update(case_solver_budget_seconds=900, case_solver_allocations=None)
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


def copy_local_initial_fields(source, destination):
    source, destination = Path(source), Path(destination)
    fields = ("U", "p", "T", "k", "omega", "nut", "alphat")
    if any(not (source / name).is_file() or (source / name).is_symlink() for name in fields):
        raise ValueError("The local initializer lacks a complete primitive/turbulence state")
    if any(path.is_dir() and path.name.replace(".", "", 1).isdigit() and float(path.name) != 0
           for path in destination.iterdir()):
        raise ValueError("The initializer cannot overwrite an existing physical-time trajectory")
    copied_fields = fields + (("rho",) if (source / "rho").is_file() and not (source / "rho").is_symlink() else ())
    hashes = {}
    for name in copied_fields:
        content = (source / name).read_bytes()
        (destination / "0" / name).write_bytes(content)
        hashes[name] = hashlib.sha256(content).hexdigest()
    return hashes


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
    parser.add_argument("--precise-startup", action="store_true")
    parser.add_argument("--precise-local-initializer", action="store_true")
    parser.add_argument("--bounded-reconstruction", action="store_true")
    arguments = parser.parse_args()
    if arguments.precise_startup and (arguments.quiescent_start or arguments.early_fields or arguments.startup_courant is not None):
        raise ValueError("Precise startup cannot use a fast-path numerical override")
    if arguments.precise_local_initializer and not arguments.precise_startup:
        raise ValueError("The local initial-guess study requires the precise startup recipe")
    if arguments.bounded_reconstruction and not arguments.precise_startup:
        raise ValueError("Bounded reconstruction comparison requires the precise recipe")
    source_job, original, request = replay_request(arguments.request, arguments.sha256, anchor_zero=arguments.anchor_zero,
                                                   finite_edge_mesh=arguments.finite_edge_mesh, precise_startup=arguments.precise_startup)
    if arguments.finite_edge_mesh:
        register_mesher(BlockMeshCGrid(topology=FINITE_EDGE_TOPOLOGY))
    destination = arguments.destination / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    driver_source = Path(__file__).read_bytes()
    (destination / "replay-driver.py").write_bytes(driver_source)
    source_bytes = arguments.request.read_bytes()
    if hashlib.sha256(source_bytes).hexdigest() != arguments.sha256:
        raise ValueError("The source request changed before execution")
    (destination / "source-request.json").write_bytes(source_bytes)
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
        "source_kind": json.loads(source_bytes).get("source_kind", "stored-production-request"),
        "diagnostic_completed": False,
    }
    if arguments.precise_startup:
        report["differences"].append("900second startup diagnostic ceiling; not completion of the original precise allocation")
    if arguments.anchor_zero:
        report["differences"].append("zero-degree starting-anchor diagnostic instead of the original requested angles")
    if arguments.finite_edge_mesh:
        report["differences"].append("explicit finite-edge-central-wake-v1 body-fitted mesh; original physical contour retained")
    original_solve = pipeline.solve_cold_steady
    original_native_solver = LocalRunner.solver
    original_prepare = pipeline._prepare_transient_case
    original_transient_attempt = pipeline._run_transient_attempt
    original_schemes = CompressibleCaseBuilder._write_fv_schemes
    captures = []
    capture_errors = []
    initializations = []
    pending_initializations = {}

    def write_bounded_schemes(builder, turbulence):
        original_schemes(builder, turbulence)
        if builder.solver_family == "rhoCentralFoam" and builder.solver.momentum_scheme != "upwind":
            schemes = builder._p("system", "fvSchemes")
            schemes.write_text(bounded_gradients(schemes.read_text(), "minmod-all"))

    def prepare_with_local_initial_guess(directory, airfoil, resolved, spec, fluid, roughness, solver, runner, processes, timeout, **kwargs):
        mesh, patches = original_prepare(directory, airfoil, resolved, spec, fluid, roughness, solver, runner, processes, timeout, **kwargs)
        initializer = Path(directory).with_name(Path(directory).name + "-local-initialization")
        shutil.copytree(directory, initializer)
        local_solver = solver.model_copy(update={"force_transient": False, "transient_fallback": False, "momentum_scheme": "upwind"})
        pipeline._case_builder(runner, airfoil, patches, mesh, spec, fluid, roughness, local_solver, n_proc=processes).write(initializer)
        started = local_startup.solve_cold_steady(initializer, runner, local_solver, processes, timeout, cancel_check=kwargs.get("cancel_check"))
        started.check()
        coordinate = latest_iteration(initializer)
        if coordinate is None or coordinate <= 0:
            raise ValueError("The local initializer retained no real state")
        fields = copy_local_initial_fields(initializer / str(coordinate), directory)
        pending_initializations[str(directory)] = (initializer / str(coordinate), fields)
        target_hashes = {name: hashlib.sha256((directory / "0" / name).read_bytes()).hexdigest() for name in fields}
        if target_hashes != fields:
            raise ValueError("The local initializer did not reach the transient zero-time state")
        initializations.append({"directory": str(initializer), "iteration": coordinate,
                                "field_sha256": fields, "target_field_sha256": target_hashes,
                                "purpose": "numerical_initial_guess_only", "accepted_cfd": False})
        return mesh, patches

    def attempt_with_local_initial_guess(*args, **kwargs):
        if pending_initializations:
            tcase = str(args[0])
            source = pending_initializations.pop(tcase, None)
            if source is not None:
                source_dir, expected = source
                copied = copy_local_initial_fields(source_dir, Path(tcase))
                if copied != expected:
                    raise ValueError("The transient initial state changed during handoff")
        return original_transient_attempt(*args, **kwargs)

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
    precise_initialization = patch.object(pipeline, "_prepare_transient_case", prepare_with_local_initial_guess) if arguments.precise_local_initializer else nullcontext()
    precise_attempt = patch.object(pipeline, "_run_transient_attempt", attempt_with_local_initial_guess) if arguments.precise_local_initializer else nullcontext()
    reconstruction = patch.object(CompressibleCaseBuilder, "_write_fv_schemes", write_bounded_schemes) if arguments.bounded_reconstruction else nullcontext()
    if arguments.quiescent_start:
        report["differences"].append("quiescent internal velocity initial guess only; physical boundaries, pressure and temperature unchanged")
    if arguments.early_fields:
        report["differences"].append("retain every first-phase iteration and snapshot failed startup fields; no stepping or physical changes")
    if arguments.startup_courant is not None:
        report["differences"].append(f"startup Courant{arguments.startup_courant} for the existing50updates; original continuation ceiling and full horizon retained")
    if arguments.precise_local_initializer:
        report["differences"].append("isolated same-mesh upwind local-steady initial guess for original iteration allocation, then original high-order physical-time solve; one shared diagnostic budget")
    if arguments.bounded_reconstruction:
        report["differences"].append("Minmod/MinmodV bounded higher-order reconstruction instead of vanLeer/vanLeerV; original equations, gradients and physical fields retained")
    try:
        with initialization, output_capture, startup_control, precise_initialization, precise_attempt, reconstruction:
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
        report["initializations"] = initializations
        (destination / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
        print(json.dumps({"report": str(destination / "report.json"), "source_job": source_job,
                          "diagnostic_completed": report["diagnostic_completed"],
                          "case_outcomes": report.get("case_outcomes", []), "error": report.get("error")}), flush=True)


if __name__ == "__main__":
    main()
