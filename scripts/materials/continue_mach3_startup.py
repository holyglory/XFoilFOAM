import argparse
from dataclasses import asdict
import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import re
import shutil
from uuid import uuid4

from airfoilfoam.config import Settings
from airfoilfoam.material_domain import material_domain_failure
from airfoilfoam.models import PolarRequest
from airfoilfoam.openfoam.budget import BudgetedRunner
from airfoilfoam.openfoam.dialects import find_force_coefficient_files
from airfoilfoam.openfoam.execution import configure_flow_execution
from airfoilfoam.openfoam.rans_hold import root_entry
from airfoilfoam.openfoam.runner import get_runner
from airfoilfoam.pipeline import _set_control_dict_entries
from airfoilfoam.postprocess.forces import _strict_data_rows, analyze_rans_hold, RANS_HOLD_REQUIRED_SAMPLES
from airfoilfoam.postprocess.residuals import parse_local_steady_convergence
from scripts.materials.inspect_rae_extrema import inspect
from scripts.materials.reproduce_mach3_failure import diagnostic_request
from scripts.materials.validate_polar_uncertainty import reject_constant, unique_object


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def member(root, name):
    relative = PurePosixPath(name)
    if relative.is_absolute() or relative.as_posix() != name or ".." in relative.parts or "\\" in name:
        raise ValueError("Checkpoint member is outside its declared relative scope")
    path = root
    for part in relative.parts:
        path = path / part
        if path.is_symlink():
            raise ValueError("Checkpoint member must not follow a symlink")
    if not path.is_file():
        raise ValueError("Checkpoint member is missing")
    return path


def load_checkpoint(source, expected_sha256, geometry, material):
    source = Path(source)
    if source.is_symlink() or digest(member(source, "manifest.json")) != expected_sha256:
        raise ValueError("Checkpoint manifest differs from its pinned identity")
    manifest = json.loads((source / "manifest.json").read_bytes(), object_pairs_hook=unique_object, parse_constant=reject_constant)
    if (manifest.get("kind") != "mach3-diagnostic-last-state-subset-v1" or manifest.get("accepted_cfd") is not False
            or type(manifest.get("coordinate")) is not int or manifest["coordinate"] != 50):
        raise ValueError("Only the exact unaccepted50-step diagnostic checkpoint is supported")
    report_path = member(source, "source-report.json")
    if digest(report_path) != manifest["source_report_sha256"]:
        raise ValueError("Checkpoint source report changed")
    report = json.loads(report_path.read_bytes(), object_pairs_hook=unique_object, parse_constant=reject_constant)
    original = diagnostic_request(geometry, material, "cold", 0.25)
    expected = original.model_dump(mode="json")
    expected["solver"]["n_iterations"] = 50
    if (report.get("kind") != "mach3-local-startup-fields-v1" or report.get("production_evidence") is not False
            or report.get("outcome") != "short_diagnostic_completed" or report.get("native_returncode") != 0
            or report.get("material_error") is not None or report.get("frame_errors") != []
            or report.get("original_request") != original.model_dump(mode="json") or report.get("request") != expected):
        raise ValueError("Checkpoint is not the unchanged material-valid source case")
    if [frame["coordinate"] for frame in report["frames"]] != list(range(1, 51)):
        raise ValueError("Checkpoint lacks its complete startup coordinate history")
    expected_members = dict(report["input_sha256"])
    expected_members.update({"50/" + name: checksum for name, checksum in report["frames"][-1]["field_sha256"].items()})
    expected_members["log.rhoCentralFoam"] = report["solver_log_sha256"]
    if manifest.get("files") != expected_members:
        raise ValueError("Checkpoint membership differs from the source receipt")
    required = {"50/" + name for name in ("U", "T", "p", "rho", "k", "omega", "nut", "alphat", "rDeltaT", "uniform/time")}
    required.update({"constant/polyMesh/" + name for name in ("points", "faces", "owner", "neighbour", "boundary")})
    required.update({"system/controlDict", "system/fvSchemes", "system/fvSolution", "constant/thermophysicalProperties", "constant/numericalExecution.json"})
    if not required <= expected_members.keys():
        raise ValueError("Checkpoint lacks required mesh, material or restart fields")
    for name, checksum in expected_members.items():
        if not name.startswith(("0/", "50/", "constant/", "system/")) and name != "log.rhoCentralFoam":
            raise ValueError("Checkpoint contains an unrelated member")
        if digest(member(source, name)) != checksum:
            raise ValueError("Checkpoint member checksum differs")
    control = (source / "system/controlDict").read_text()
    clock = (source / "50/uniform/time").read_text()
    if (float(root_entry(control, "deltaT")) != 1 or float(root_entry(control, "endTime")) != 50
            or float(root_entry(control, "maxCo")) != 0.25
            or any(float(root_entry(clock, name)) != value for name, value in (("value", 50), ("index", 50), ("deltaT", 1), ("deltaT0", 1)))
            or "localEuler" not in (source / "system/fvSchemes").read_text()):
        raise ValueError("Checkpoint changes the local iteration clock or source stepping")
    consumed = report.get("solver_active_seconds")
    if isinstance(consumed, bool) or not isinstance(consumed, (int, float)) or not math.isfinite(consumed) or not 0 < consumed < 900:
        raise ValueError("Checkpoint has no valid remaining original solver budget")
    return manifest, report, original, 900 - consumed


def prepare_continuation(source, destination, expected_sha256, geometry, material, courant):
    if isinstance(courant, bool) or courant not in (0.25, 0.5):
        raise ValueError("Only fixed or restored local Courant is supported")
    if Path(source).is_symlink():
        raise ValueError("Checkpoint source must not follow a symlink")
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Source checkpoint and new run must be separate")
    manifest, report, original, remaining = load_checkpoint(source, expected_sha256, geometry, material)
    destination.mkdir(parents=True, exist_ok=False)
    for name, checksum in manifest["files"].items():
        target = destination / ("source-log.rhoCentralFoam" if name == "log.rhoCentralFoam" else name)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(member(source, name), target)
        if digest(target) != checksum:
            raise ValueError("Copied checkpoint differs from its source")
    shutil.copyfile(source / "manifest.json", destination / "source-manifest.json")
    shutil.copyfile(source / "source-report.json", destination / "source-report.json")
    payload = original.model_dump(mode="json")
    payload["solver"]["transient_max_courant"] = 4.0 if courant == 0.5 else 0.25
    request = PolarRequest.model_validate(payload)
    _set_control_dict_entries(destination / "system/controlDict", {
        "startFrom": "latestTime", "endTime": request.solver.n_iterations,
        "maxCo": courant, "writeInterval": 100, "purgeWrite": 2,
    })
    changed = [name for name, checksum in manifest["files"].items()
               if name != "log.rhoCentralFoam" and digest(destination / name) != checksum]
    if changed != ["system/controlDict"]:
        raise ValueError("Continuation changed more than the declared control dictionary")
    return manifest, report, request, remaining


def force_summary(directory):
    files = find_force_coefficient_files(directory)
    if not files:
        return None
    if len(files) != 1:
        raise ValueError("Continuation force history is ambiguous")
    header, rows = _strict_data_rows(files[0])
    moment = "CmPitch" if "CmPitch" in header else "Cm"
    if not rows or not {"Time", "Cl", "Cd", moment} <= set(header):
        raise ValueError("Continuation has no complete force columns")
    if any(len(row) != len(header) or not all(math.isfinite(value) for value in row) for row in rows):
        raise ValueError("Continuation force history contains invalid data")
    coordinate = header.index("Time")
    if any(not row[coordinate].is_integer() or not 50 <= row[coordinate] <= 5000 for row in rows):
        raise ValueError("Continuation history includes initial or out-of-scope data")
    if any(right[coordinate] <= left[coordinate] for left, right in zip(rows, rows[1:])):
        raise ValueError("Continuation force coordinates are not strictly increasing")
    new_rows = [row for row in rows if row[coordinate] > 50]
    sample = new_rows[-50:]
    coefficients = {name: math.fsum(row[header.index(column)] for row in sample) / len(sample)
                    for name, column in (("cl", "Cl"), ("cd", "Cd"), ("cm", moment))} if sample else None
    hold = analyze_rans_hold(files[0]) if len(new_rows) >= RANS_HOLD_REQUIRED_SAMPLES else None
    return {"source_sha256": digest(files[0]), "samples": len(new_rows), "initial_samples": len(rows) - len(new_rows),
            "coefficients": coefficients, "force_hold": None if hold is None else asdict(hold)}


def run(source, destination, expected_sha256, geometry, material, courant):
    directory = Path(destination) / str(uuid4())
    manifest, prior, request, remaining = prepare_continuation(source, directory, expected_sha256, geometry, material, courant)
    settings = Settings(data_dir=directory / "data", cache_dir=directory / "cache", cpu_token_state_path=directory / "tokens.json")
    if settings.evidence_bucket:
        raise ValueError("This diagnostic must not upload evidence")
    runner = get_runner(settings)
    configure_flow_execution(runner, request)
    budgeted = BudgetedRunner(runner, remaining)
    spec = request.cases()[0]
    budgeted.begin_case(spec)
    report = {"kind": "mach3-local-step-continuation-v1", "production_evidence": False, "airfoil_polar_validation": False,
              "source_manifest_sha256": expected_sha256, "source_report_sha256": manifest["source_report_sha256"],
              "source_coordinate": 50, "requested_end_coordinate": 5000, "local_courant": courant,
              "prior_active_seconds": prior["solver_active_seconds"], "remaining_active_seconds": remaining,
              "request": request.model_dump(mode="json"), "outcome": "incomplete"}
    (directory / "protocol.json").write_text(json.dumps(report, indent=2, allow_nan=False))
    try:
        solved = budgeted.solver(directory, "rhoCentralFoam", 1, timeout=remaining, restart=True)
        (directory / "log.rhoCentralFoam").write_text(solved.stdout)
        failure = material_domain_failure(directory, solved)
        report["native_returncode"] = solved.returncode
        report["timed_out"] = solved.timed_out
        report["material_error"] = None if failure is None else str(failure)
        report["solver_log_sha256"] = digest(directory / "log.rhoCentralFoam")
        report["local_convergence"] = asdict(parse_local_steady_convergence(solved.stdout, request.solver.convergence_tolerance))
        coordinates = [float(value) for value in re.findall(r"^Time = (\S+)", solved.stdout, re.M)]
        if any(not value.is_integer() or not 50 < value <= 5000 for value in coordinates):
            raise ValueError("Native continuation violated its original iteration scope")
        report["last_log_coordinate"] = coordinates[-1] if coordinates else None
        report["new_update_count"] = len(coordinates)
        report["forces"] = force_summary(directory)
        saved = sorted(int(path.name) for path in directory.iterdir() if path.is_dir() and path.name.isdigit() and 50 < int(path.name) <= 5000)
        report["last_saved_state"] = inspect(directory, coordinate=saved[-1], chord=spec.chord) if saved else None
        report["solver_active_seconds"] = budgeted.consumed(spec)
        report["total_active_seconds"] = prior["solver_active_seconds"] + report["solver_active_seconds"]
        report["outcome"] = "observed_native_failure" if not solved.ok or failure is not None else "observed_native_completion"
        load_checkpoint(source, expected_sha256, geometry, material)
        return directory, report
    except Exception as error:
        report["outcome"] = "incomplete_diagnostics"
        report["diagnostic_error"] = str(error)
        raise
    finally:
        (directory / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--manifest-sha256", required=True)
    parser.add_argument("--coordinates", type=Path, required=True)
    parser.add_argument("--material", type=Path, required=True)
    parser.add_argument("--courant", type=float, choices=(0.25, 0.5), required=True)
    args = parser.parse_args()
    directory, report = run(args.source, args.destination, args.manifest_sha256, args.coordinates, args.material, args.courant)
    print(json.dumps({"report": str(directory / "report.json"), "outcome": report["outcome"],
                      "native_returncode": report["native_returncode"], "material_error": report["material_error"],
                      "local_convergence": report["local_convergence"], "last_log_coordinate": report["last_log_coordinate"],
                      "total_active_seconds": report["total_active_seconds"], "airfoil_polar_validation": False}))
