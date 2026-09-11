import argparse
from dataclasses import asdict
import hashlib
import json
import math
from pathlib import Path
import shutil
import time
from uuid import uuid4

from airfoilfoam.config import Settings
from airfoilfoam.models import PolarRequest
from airfoilfoam.openfoam.budget import BudgetedRunner
from airfoilfoam.openfoam.dialects import find_force_coefficient_files
from airfoilfoam.openfoam.execution import configure_flow_execution
from airfoilfoam.openfoam.rans_hold import complete_rans_hold, latest_iteration, root_entry
from airfoilfoam.openfoam.runner import RunResult, get_runner
from airfoilfoam.postprocess.forces import analyze_rans_hold
from airfoilfoam.postprocess.residuals import parse_convergence

try:
    from .rae2822_mapping import authenticated_retained_source
except ImportError:
    from rae2822_mapping import authenticated_retained_source


def remaining_allocation(report, log, coordinate, maximum):
    summary = parse_convergence(log)
    solver = report.get("request", {}).get("solver", {})
    if (report.get("kind") != "rae2822-transonic-pressure-validation" or report.get("production_evidence") is not False
            or report.get("outcome") != "measured_converged" or report.get("convergence", {}).get("converged") is not True
            or report.get("budget_exhausted") is not False or not summary.converged
            or report.get("experimental_local_time_pressure", False) or report.get("experimental_density_local_time", False)
            or solver.get("force_transient") is not False or solver.get("flow_solver_family") != "rhoSimpleFoam"):
        raise ValueError("Hold continuation requires an authenticated converged steady pressure reference")
    if (type(coordinate) is not int or type(maximum) is not int or coordinate <= 0 or maximum <= coordinate
            or report.get("pressure_iteration") != coordinate or summary.iterations != coordinate
            or solver.get("n_iterations") != maximum):
        raise ValueError("Hold continuation must retain the original exact iteration ceiling")
    total, used = report.get("time_budget_seconds"), report.get("active_seconds")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (total, used)):
        raise ValueError("Hold continuation requires measured finite solver cost")
    if not 0 <= used < total <= 3600 or maximum - coordinate < 200:
        raise ValueError("The original reference has no remaining hold allocation")
    return {"original_limit_seconds": total, "prior_active_seconds": used,
            "remaining_seconds": total - used, "start_iteration": coordinate, "maximum_iteration": maximum}


def checkpoint_signatures(directory, coordinate):
    if type(coordinate) is not int or coordinate <= 0:
        raise ValueError("Held checkpoint requires an exact positive iteration")
    signatures = {}
    for name in ("U", "p", "T", "k", "omega", "rho", "phi"):
        relative = f"{coordinate}/{name}"
        path = Path(directory) / relative
        if not path.is_file() or path.is_symlink() or path.stat().st_size == 0:
            raise ValueError("Held reference lacks a complete checkpoint")
        signatures[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    return signatures


def run(source, destination):
    source, manifest_bytes, manifest, verified, original = authenticated_retained_source(source)
    coordinate = latest_iteration(source)
    control = (source / "system/controlDict").read_text()
    maximum = float(root_entry(control, "endTime"))
    if not math.isfinite(maximum) or not maximum.is_integer():
        raise ValueError("Reference iteration ceiling is not exact")
    source_log = (source / "log.rhoSimpleFoam").read_text()
    allocation = remaining_allocation(original, source_log, coordinate, int(maximum))
    required = ["report.json", "log.rhoSimpleFoam", "system/controlDict", "system/fvSolution", "constant/thermophysicalProperties"]
    required += [f"constant/polyMesh/{name}" for name in ("points", "faces", "owner", "neighbour", "boundary")]
    required += [f"{coordinate}/{name}" for name in ("U", "p", "T", "k", "omega", "rho", "phi")]
    if any(name not in verified for name in required):
        raise ValueError("Hold source lacks authenticated mesh, fields or solver proof")
    if any(name in verified for name in ("source-report.json", "source-retention.json", "source-log.rhoSimpleFoam")):
        raise ValueError("Hold source conflicts with reserved provenance filenames")
    request = PolarRequest.model_validate(original["request"])
    if len(request.cases()) != 1:
        raise ValueError("Reference hold requires one exact physical case")
    processes = original["execution_resources"]["mpi_processes"]
    runner = get_runner(Settings())
    if type(processes) is not int or not 1 <= processes <= runner.settings.resolved_worker_cpu_budget():
        raise ValueError("Reference hold MPI count exceeds its worker budget")
    configure_flow_execution(runner, request)
    spec = request.cases()[0]
    budgeted = BudgetedRunner(runner, allocation["remaining_seconds"])
    budgeted.begin_case(spec)
    destination = Path(destination).resolve() / str(uuid4())
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Reference hold must not alter its retained source")
    destination.mkdir(parents=True, exist_ok=False)
    for relative, digest in verified.items():
        target = destination / ("source-report.json" if relative == "report.json" else relative)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, target)
        if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
            raise ValueError("Copied hold source differs from its authenticated bytes")
    (destination / "source-retention.json").write_bytes(manifest_bytes)
    (destination / "source-log.rhoSimpleFoam").write_text(source_log)
    started = time.monotonic()
    report = {"kind": "rae2822-rans-hold-reference", "production_evidence": False,
              "accuracy_certified": False, "eligible_urans_seed": False, "outcome": "failed",
              "source_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
              "source_report_sha256": verified["report.json"], "source_revision": manifest.get("sourceRevision"),
              "request": original["request"], "reference": original["reference"],
              "energy_form": original["experimental_energy_form"], "allocation": allocation}
    try:
        result = complete_rans_hold(destination, RunResult("rhoSimpleFoam", 0, source_log), budgeted,
                                    request.solver, spec, processes, allocation["remaining_seconds"])
        (destination / "log.rhoSimpleFoam").write_text(result.stdout)
        histories = find_force_coefficient_files(destination)
        hold = analyze_rans_hold(histories[-1]) if histories else None
        end = latest_iteration(destination)
        report["fields_iteration"] = end
        report["initial_numerical_convergence"] = original["convergence"]
        report["force_hold"] = asdict(hold) if hold else None
        report["native_returncode"] = result.returncode
        report["timed_out"] = result.timed_out
        report["eligible_urans_seed"] = bool(result.ok and hold and hold.certified and end == hold.end_iteration)
        if report["eligible_urans_seed"]:
            report["checkpoint_sha256"] = checkpoint_signatures(destination, end)
        report["outcome"] = "held_reference" if report["eligible_urans_seed"] else "hold_unavailable"
        for name in ("system/controlDict", "system/fvSolution"):
            if hashlib.sha256((destination / name).read_bytes()).hexdigest() != verified[name]:
                raise ValueError("Hold procedure did not restore the original dictionaries")
        if authenticated_retained_source(source)[3] != verified:
            raise ValueError("Retained source changed during hold continuation")
    except Exception as error:
        report["eligible_urans_seed"] = False
        report["outcome"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        report["active_seconds"] = budgeted.consumed(spec)
        report["accumulated_active_seconds"] = allocation["prior_active_seconds"] + report["active_seconds"]
        report["elapsed_seconds"] = time.monotonic() - started
        (destination / "report.json").write_text(json.dumps(report, allow_nan=False) + "\n")
        print(json.dumps({"kind": report["kind"], "outcome": report["outcome"], "report": str(destination / "report.json"),
                          "eligible_urans_seed": report["eligible_urans_seed"], "active_seconds": report["active_seconds"]}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    arguments = parser.parse_args()
    run(arguments.source, arguments.destination)
