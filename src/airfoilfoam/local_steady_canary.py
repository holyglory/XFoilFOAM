import argparse
import json
import re
import math
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

from .airfoil import Airfoil, parse_airfoil
from .config import Settings
from .material_domain import check_material_domain
from .meshing.blockmesh import BlockMeshCGrid
from .models import PolarRequest
from .numerical_canary import source_material_for_canary
from .openfoam.budget import BudgetedRunner
from .openfoam.dialects import find_force_coefficient_files
from .openfoam.execution import configure_flow_execution
from .openfoam.runner import get_runner
from .pipeline import _case_builder, _run_transient_mesh_qa_gate, resolve_mesh_params
from .postprocess.forces import parse_force_coefficients
from .postprocess.residuals import parse_local_steady_convergence
from .thermodynamics import ThermodynamicState


def run_local_steady_canary(coordinates, material, destination, *, iterations=1500, budget_seconds=300, target_y_plus=1, momentum_scheme="linearUpwind"):
    destination = Path(destination) / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    gas = source_material_for_canary(material)
    state = ThermodynamicState(temperature_k=288.15, pressure_pa=101325)
    request = PolarRequest.model_validate({
        "airfoil": {"name": "AG24 local steady verification", "coordinates": Path(coordinates).read_text()},
        "chord_lengths": [1.1235], "speeds": [1020], "aoa": {"angles": [-2]},
        "fluid": {"density": gas.density(state), "dynamic_viscosity": gas.dynamic_viscosity(state.temperature_k), "gas": gas.model_dump()},
        "flow_state": state.model_dump(),
        "mesh": {"n_surface": 169, "n_radial": 40, "n_wake": 40, "target_y_plus": target_y_plus,
                 "farfield_radius_chords": 18, "wake_length_chords": 12},
        "solver": {"flow_solver_family": "rhoCentralFoam", "force_transient": False, "transient_fallback": False,
                   "momentum_scheme": momentum_scheme,
                   "turbulent_prandtl": 0.85, "n_iterations": iterations, "convergence_tolerance": 1e-4,
                   "transient_max_courant": 0.5, "write_images": []},
    })
    raw_runner = get_runner(Settings())
    configure_flow_execution(raw_runner, request)
    runner = BudgetedRunner(raw_runner, budget_seconds)
    spec = request.cases()[0]
    runner.begin_case(spec)
    report = {"kind": "local-pseudo-time-execution-verification", "coordinate_kind": "iteration",
              "aerodynamic_accuracy_validated": False, "production_installed": False,
              "request": request.model_dump(mode="json"), "outcome": "failed"}
    try:
        airfoil = Airfoil.from_contour("AG24", parse_airfoil(request.airfoil.coordinates))
        mesh = resolve_mesh_params(request.mesh, spec, request.fluid)
        mesher = BlockMeshCGrid()
        builder = _case_builder(runner, airfoil, mesher.patches(mesh), mesh, spec, request.fluid, request.roughness, request.solver)
        builder.write(destination)
        mesher.write_inputs(destination, airfoil, mesh, spec.chord)
        meshed = runner.application(destination, "blockMesh", timeout=120)
        (destination / "log.blockMesh").write_text(meshed.stdout)
        meshed.check()
        warnings = []
        verdict = _run_transient_mesh_qa_gate(destination, runner, warnings)
        if verdict is None:
            raise RuntimeError("Local steady canary requires real mesh quality evidence")
        report["mesh_quality"] = asdict(verdict)
        report["quality_warnings"] = warnings
        result = runner.solver(destination, "rhoCentralFoam", 1, timeout=budget_seconds)
        (destination / "log.rhoCentralFoam").write_text(result.stdout)
        check_material_domain(destination, result)
        courant = [float(value) for value in re.findall(r"Courant Numbers:\s+min = \S+,\s+average = \S+,\s+max = (\S+)", result.stdout)]
        if not courant or any(not math.isfinite(value) or value < 0 or value > 0.5 * (1 + 1e-5) for value in courant):
            raise RuntimeError("Local pseudo-time did not preserve the selected central Courant ceiling")
        report["maximum_measured_courant"] = max(courant)
        if not result.ok and not result.timed_out:
            result.check()
        convergence = parse_local_steady_convergence(result.stdout, request.solver.convergence_tolerance)
        if convergence.iterations is None or convergence.iterations < 20:
            raise RuntimeError("Fewer than twenty real numerical iterations were observed")
        coefficients = find_force_coefficient_files(destination)
        if not coefficients:
            raise RuntimeError("No real coefficient history was produced")
        report["coefficients"] = asdict(parse_force_coefficients(coefficients[-1]))
        report["convergence"] = asdict(convergence)
        report["budget_exhausted"] = result.timed_out
        report["outcome"] = "execution_verified"
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        report["solver_active_seconds"] = runner.consumed(spec)
        (destination / "report.json").write_text(json.dumps(report, allow_nan=False) + "\n")
        print(json.dumps({"kind": report["kind"], "outcome": report["outcome"], "report": str(destination / "report.json"),
                          "convergence": report.get("convergence"), "solver_active_seconds": report["solver_active_seconds"],
                          "aerodynamic_accuracy_validated": False}), flush=True)
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--coordinates", type=Path, required=True)
    parser.add_argument("--material", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--iterations", type=int, default=1500)
    parser.add_argument("--budget-seconds", type=int, default=300)
    parser.add_argument("--target-y-plus", type=float, default=1)
    parser.add_argument("--momentum-scheme", choices=["linearUpwind", "upwind"], default="linearUpwind")
    arguments = parser.parse_args()
    run_local_steady_canary(arguments.coordinates, arguments.material, arguments.destination,
        iterations=arguments.iterations, budget_seconds=arguments.budget_seconds, target_y_plus=arguments.target_y_plus,
        momentum_scheme=arguments.momentum_scheme)


if __name__ == "__main__":
    main()
