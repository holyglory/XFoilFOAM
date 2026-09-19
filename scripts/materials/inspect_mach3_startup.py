import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
from uuid import uuid4

from airfoilfoam.airfoil import Airfoil
from airfoilfoam.config import Settings
from airfoilfoam.material_domain import material_domain_failure
from airfoilfoam.meshing.blockmesh import BlockMeshCGrid
from airfoilfoam.models import PolarRequest
from airfoilfoam.openfoam.budget import BudgetedRunner
from airfoilfoam.openfoam.dialects import dialect_for_runner
from airfoilfoam.openfoam.execution import configure_flow_execution
from airfoilfoam.openfoam.rans_hold import root_entry
from airfoilfoam.openfoam.runner import get_runner
from airfoilfoam.pipeline import _case_builder, _run_transient_mesh_qa_gate, _set_control_dict_entries, resolve_mesh_params
from airfoilfoam.postprocess.residuals import parse_local_steady_convergence
from scripts.materials.inspect_rae_extrema import inspect
from scripts.materials.reproduce_mach3_failure import diagnostic_request, MATERIAL_SHA256, POINTS_SHA256


def startup_request(coordinates, material, courant):
    if isinstance(courant, bool) or courant not in (4.0, 0.25):
        raise ValueError("Only the original and reduced local Courant comparison is supported")
    original = diagnostic_request(coordinates, material, "cold", courant)
    payload = original.model_dump(mode="json")
    payload["solver"]["n_iterations"] = 50
    return original, PolarRequest.model_validate(payload)


def preserve_early_frames(directory):
    directory = Path(directory)
    control = directory / "system/controlDict"
    original = control.read_text()
    if (float(root_entry(original, "deltaT")) != 1 or float(root_entry(original, "endTime")) != 50
            or "localEuler" not in (directory / "system/fvSchemes").read_text()):
        raise ValueError("Early-field diagnostic requires the unmodified local iteration clock")
    protected = [directory / relative for relative in ("0/U", "0/p", "0/T", "constant/thermophysicalProperties")]
    before = {path: path.read_bytes() for path in protected}
    _set_control_dict_entries(control, {"writeInterval": 1, "purgeWrite": 0})
    updated = control.read_text()
    if any(path.read_bytes() != content for path, content in before.items()):
        raise ValueError("Diagnostic output changed physical input fields")
    if any(root_entry(updated, name) != root_entry(original, name) for name in ("deltaT", "endTime", "maxCo", "maxDeltaT")):
        raise ValueError("Diagnostic output changed numerical stepping")


def measured_frames(directory, chord):
    directory = Path(directory)
    candidates = []
    for child in directory.iterdir():
        if not child.is_dir():
            continue
        try:
            coordinate = float(child.name)
        except ValueError:
            continue
        if coordinate == 0:
            continue
        if not coordinate.is_integer() or not 1 <= coordinate <= 50 or int(coordinate) in candidates:
            raise ValueError("Field coordinate differs from the bounded local iteration horizon")
        candidates.append(int(coordinate))
    frames, errors = [], []
    for coordinate in sorted(candidates):
        try:
            measured = inspect(directory, coordinate=coordinate, chord=chord)
            state = directory / str(coordinate)
            members = sorted(path for path in state.rglob("*") if path.is_file())
            if any(path.is_symlink() for path in members):
                raise ValueError("Retained field members must not follow external links")
            measured["field_sha256"] = {path.relative_to(state).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                                        for path in members}
            frames.append(measured)
        except (ValueError, OSError) as error:
            errors.append({"coordinate": coordinate, "error": str(error)})
    return frames, errors


def run(coordinates, material, destination, courant):
    original, request = startup_request(coordinates, material, courant)
    directory = Path(destination) / str(uuid4())
    directory.mkdir(parents=True, exist_ok=False)
    settings = Settings(data_dir=directory / "data", cache_dir=directory / "cache", cpu_token_state_path=directory / "tokens.json")
    if settings.evidence_bucket:
        raise ValueError("Startup field study must not upload evidence")
    runner = get_runner(settings)
    configure_flow_execution(runner, request)
    budgeted = BudgetedRunner(runner, 900)
    spec = request.cases()[0]
    budgeted.begin_case(spec)
    report = {"kind": "mach3-local-startup-fields-v1", "production_evidence": False, "airfoil_polar_validation": False,
              "outcome": "incomplete", "source_geometry_sha256": POINTS_SHA256, "source_material_sha256": MATERIAL_SHA256,
              "original_request": original.model_dump(mode="json"), "request": request.model_dump(mode="json"),
              "differences": ["isolated cold start at13degrees", "50iteration diagnostic horizon", "save every early field", "no result publication"],
              "frames": [], "frame_errors": []}
    if courant == 0.25:
        report["differences"].append("reduced local Courant target0.25 instead of0.5")
    (directory / "protocol.json").write_text(json.dumps(report, indent=2, allow_nan=False))
    try:
        airfoil = Airfoil.from_contour(request.airfoil.name, request.airfoil.points)
        mesh = resolve_mesh_params(request.mesh, spec, request.fluid)
        report["resolved_mesh"] = mesh.model_dump(mode="json")
        mesher = BlockMeshCGrid()
        builder = _case_builder(budgeted, airfoil, mesher.patches(mesh), mesh, spec, request.fluid, request.roughness,
                                request.solver, dialect=dialect_for_runner(budgeted))
        builder.write(directory)
        mesher.write_inputs(directory, airfoil, mesh, spec.chord)
        meshed = budgeted.application(directory, "blockMesh", timeout=120)
        (directory / "log.blockMesh").write_text(meshed.stdout)
        meshed.check()
        warnings = []
        quality = _run_transient_mesh_qa_gate(directory, budgeted, warnings)
        if quality is None:
            raise ValueError("No complete mesh quality verdict")
        report["mesh_quality"] = asdict(quality)
        report["mesh_warnings"] = warnings
        preserve_early_frames(directory)
        inputs = [path for folder in ("0", "system", "constant") for path in (directory / folder).rglob("*") if path.is_file()]
        report["input_sha256"] = {path.relative_to(directory).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(inputs)}
        solved = budgeted.solver(directory, "rhoCentralFoam", 1, timeout=900)
        (directory / "log.rhoCentralFoam").write_text(solved.stdout)
        failure = material_domain_failure(directory, solved)
        report["native_returncode"] = solved.returncode
        report["material_error"] = None if failure is None else str(failure)
        report["local_convergence"] = asdict(parse_local_steady_convergence(solved.stdout, request.solver.convergence_tolerance))
        report["frames"], report["frame_errors"] = measured_frames(directory, spec.chord)
        report["solver_active_seconds"] = budgeted.consumed(spec)
        report["solver_log_sha256"] = hashlib.sha256(solved.stdout.encode()).hexdigest()
        report["outcome"] = "solver_failed_with_retained_frames" if not solved.ok or failure is not None else "short_diagnostic_completed"
        if not report["frames"] or report["frame_errors"]:
            raise ValueError("Early field collection is missing or incomplete")
        return directory, report
    except Exception as error:
        report["outcome"] = "incomplete_diagnostics"
        report["diagnostic_error"] = str(error)
        raise
    finally:
        (directory / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--coordinates", type=Path, required=True)
    parser.add_argument("--material", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--courant", type=float, choices=(4.0, 0.25), required=True)
    arguments = parser.parse_args()
    directory, report = run(arguments.coordinates, arguments.material, arguments.destination, arguments.courant)
    print(json.dumps({"report": str(directory / "report.json"), "outcome": report["outcome"],
                      "native_returncode": report["native_returncode"], "frames": len(report["frames"]),
                      "material_error": report["material_error"], "airfoil_polar_validation": False}))
