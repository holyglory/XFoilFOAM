import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import re
import shutil
import time
from uuid import uuid4

from airfoilfoam.airfoil import Airfoil, parse_airfoil
from airfoilfoam.config import Settings
from airfoilfoam.material_domain import check_material_domain
from airfoilfoam.meshing.blockmesh import BlockMeshCGrid
from airfoilfoam.models import PolarRequest
from airfoilfoam.openfoam.budget import BudgetedRunner
from airfoilfoam.openfoam.dialects import find_force_coefficient_files
from airfoilfoam.openfoam.execution import configure_flow_execution
from airfoilfoam.openfoam.runner import get_runner
from airfoilfoam.pipeline import _case_builder, _run_transient_mesh_qa_gate, resolve_mesh_params

try:
    from .rae2822_mapping import authenticated_retained_source
    from .rae2822_reference import load_reference
    from .rae2822_unsteady import physical_window, validate_held_report, weighted_pressure_mean
    from .verify_rae2822_hold import checkpoint_signatures
    from .verify_rae2822 import benchmark_time_budget, compare_pressure, pressure_iteration, reconstruct_timed_out_parallel_case, wall_pressure
except ImportError:
    from rae2822_mapping import authenticated_retained_source
    from rae2822_reference import load_reference
    from rae2822_unsteady import physical_window, validate_held_report, weighted_pressure_mean
    from verify_rae2822_hold import checkpoint_signatures
    from verify_rae2822 import benchmark_time_budget, compare_pressure, pressure_iteration, reconstruct_timed_out_parallel_case, wall_pressure


def configure_unsteady_case(builder, directory, window, pressure_advection="upwind"):
    if pressure_advection not in {"upwind", "vanLeer"}:
        raise ValueError("Unsupported reference pressure-advection scheme")
    builder.write_transient(directory, 0, window["end_time"], window["initial_delta_t"],
                            window["write_interval"], window["maximum_delta_t"])
    for relative, pattern, replacement in [
        ("constant/thermophysicalProperties", r"\benergy\s+sensibleInternalEnergy\s*;", "energy sensibleEnthalpy;"),
        ("system/fvSchemes", r"div\(phi,e\)", "div(phi,h)"),
        ("system/fvSolution", r"(?m)^(\s*)e(\s+[-+\d.eE]+\s*;)", r"\1h\2"),
    ]:
        path = Path(directory) / relative
        content, count = re.subn(pattern, replacement, path.read_text())
        if count != 1:
            raise ValueError("Unsteady enthalpy conversion differs from the exact generated dictionary")
        path.write_text(content)
    if pressure_advection == "vanLeer":
        path = Path(directory) / "system/fvSchemes"
        content, count = re.subn(r"(div\(phid,p\)\s+)Gauss upwind;", r"\g<1>Gauss vanLeer;", path.read_text())
        if count != 1:
            raise ValueError("Pressure comparison requires one exact implicit pressure-advection entry")
        path.write_text(content)


def run(source, destination, reference_directory, time_budget_seconds=600, pressure_advection="upwind"):
    if pressure_advection not in {"upwind", "vanLeer"}:
        raise ValueError("Unsupported reference pressure-advection scheme")
    source, manifest_bytes, manifest, verified, held = authenticated_retained_source(source)
    histories = find_force_coefficient_files(source)
    if not histories:
        raise ValueError("Held reference has no coefficient history")
    coordinate = validate_held_report(held, histories[-1])
    checkpoint = checkpoint_signatures(source, coordinate)
    if any(verified.get(path) != digest for path, digest in checkpoint.items()):
        raise ValueError("Held checkpoint is not authenticated by its retained manifest")
    reference = load_reference(reference_directory)
    if reference["provenance"] != held["reference"] or held["energy_form"] != "sensibleEnthalpy":
        raise ValueError("Unsteady reference must preserve the exact source and enthalpy recipe")
    raw_request = json.loads(json.dumps(held["request"]))
    raw_request["solver"].update(flow_solver_family="rhoPimpleFoam", force_transient=True,
                                  transient_fallback=False, momentum_scheme="linearUpwind")
    request = PolarRequest.model_validate(raw_request)
    if len(request.cases()) != 1:
        raise ValueError("Unsteady reference requires one exact physical case")
    spec = request.cases()[0]
    window = physical_window(spec.chord, spec.speed)
    budget = benchmark_time_budget(time_budget_seconds)
    runner = get_runner(Settings())
    configure_flow_execution(runner, request)
    processes = 4
    if processes > runner.settings.resolved_worker_cpu_budget():
        raise ValueError("Unsteady reference MPI request exceeds available capacity")
    budgeted = BudgetedRunner(runner, budget)
    budgeted.begin_case(spec)
    destination = Path(destination).resolve() / str(uuid4())
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Unsteady reference must preserve its source")
    destination.mkdir(parents=True, exist_ok=False)
    report = {"kind": "rae2822-physical-unsteady-reference", "outcome": "failed", "production_evidence": False,
              "accuracy_certified": False, "statistical_certification": False, "request": request.model_dump(mode="json"),
              "source_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(), "source_revision": manifest.get("sourceRevision"),
              "source_fields_iteration": coordinate, "seed_active_seconds": held["accumulated_active_seconds"],
              "reference": reference["provenance"], "physical_window": window, "time_budget_seconds": budget,
              "time_discretization": "Euler", "spatial_transport": "linearUpwind limited", "energy_form": "sensibleEnthalpy",
              "pressure_advection": pressure_advection,
              "initial_step_policy": "native_compressibleCourantNo_and_setInitialDeltaT_before_time_loop"}
    started = time.monotonic()
    try:
        airfoil = Airfoil.from_contour("RAE2822", parse_airfoil(request.airfoil.coordinates))
        mesh = resolve_mesh_params(request.mesh, spec, request.fluid)
        patches = BlockMeshCGrid().patches(mesh)
        builder = _case_builder(budgeted, airfoil, patches, mesh, spec, request.fluid, request.roughness, request.solver, n_proc=processes)
        builder.write(destination)
        configure_unsteady_case(builder, destination, window, pressure_advection)
        if hashlib.sha256((destination / "constant/thermophysicalProperties").read_bytes()).hexdigest() != verified.get("constant/thermophysicalProperties"):
            raise ValueError("Unsteady material dictionary differs from the held source")
        copied = {}
        for relative, digest in verified.items():
            path = Path(relative)
            if relative.startswith("constant/polyMesh/") or relative == "constant/thermophysicalProperties":
                target = destination / path
            elif path.parent == Path(str(coordinate)):
                target = destination / "0" / path.name
            else:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / path, target)
            if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
                raise ValueError("Unsteady initialization changed its exact held source bytes")
            copied[str(target.relative_to(destination))] = {"source": relative, "sha256": digest}
        if any(f"0/{name}" not in copied for name in ("U", "p", "T", "k", "omega", "rho", "phi")):
            raise ValueError("Unsteady initialization is incomplete")
        report["initialization"] = copied
        warnings = []
        quality = _run_transient_mesh_qa_gate(destination, budgeted, warnings)
        if quality is None:
            raise ValueError("Unsteady mesh quality is unavailable")
        report["mesh_quality"] = asdict(quality)
        report["mesh_warnings"] = warnings
        result = budgeted.solver(destination, "rhoPimpleFoam", processes, timeout=budget)
        (destination / "log.rhoPimpleFoam").write_text(result.stdout)
        report["native_returncode"] = result.returncode
        report["budget_exhausted"] = result.timed_out
        check_material_domain(destination, result)
        if not result.timed_out:
            result.check()
        reconstruct_timed_out_parallel_case(runner, destination, result, processes)
        logged = [float(value) for value in re.findall(r"(?m)^Time = ([0-9.eE+-]+)\s*$", result.stdout)]
        report["last_logged_time"] = max(logged) if logged else None
        for command in ("reconstructPar -noZero -fields '(p)'", "foamToVTK -noZero -ascii -no-internal -patches '(airfoil)' -fields '(p)'"):
            exported = runner.application(destination, command, timeout=180)
            (destination / f"log.{command.split()[0]}").write_text(exported.stdout)
            exported.check()
        frames = []
        for path in sorted((destination / "VTK").rglob("airfoil.vtp")):
            timestamp = pressure_iteration(path)
            pressure = wall_pressure(path, spec.chord, request.flow_state.pressure_pa, request.fluid.density,
                                     spec.speed, reference["coordinates"])
            frames.append((timestamp, pressure))
        report["saved_pressure_frames"] = len(frames)
        report["last_saved_time"] = max((frame[0] for frame in frames), default=None)
        mean = weighted_pressure_mean(frames, window)
        report["comparison_window"] = {key: value for key, value in mean.items() if key != "mean"}
        report["pressure_comparison"] = compare_pressure(mean["mean"], reference["pressure"]) if mean["available"] else None
        report["outcome"] = "measured_unsteady_uncertified" if mean["available"] else "insufficient_developed_history"
        if authenticated_retained_source(source)[3] != verified:
            raise ValueError("Held source changed during the physical-time run")
    except Exception as error:
        report["outcome"] = "failed"
        report["error"] = str(error)
        raise
    finally:
        report["active_seconds"] = budgeted.consumed(spec)
        report["accumulated_active_seconds"] = held["accumulated_active_seconds"] + report["active_seconds"]
        report["elapsed_seconds"] = time.monotonic() - started
        (destination / "report.json").write_text(json.dumps(report, allow_nan=False) + "\n")
        print(json.dumps({"kind": report["kind"], "outcome": report["outcome"], "report": str(destination / "report.json"),
                          "active_seconds": report["active_seconds"], "accuracy_certified": False}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--time-budget-seconds", type=float, default=600)
    parser.add_argument("--pressure-advection", choices=["upwind", "vanLeer"], default="upwind")
    arguments = parser.parse_args()
    run(arguments.source, arguments.destination, arguments.reference, arguments.time_budget_seconds, arguments.pressure_advection)
