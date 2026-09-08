"""Isolated real OpenFOAM integration smoke; never publishes polar evidence."""

import argparse
import json
import math
import re
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

from .airfoil import Airfoil, parse_airfoil
from .config import Settings
from .material_domain import check_material_domain
from .meshing.blockmesh import BlockMeshCGrid
from .models import MeshParams, PolarRequest
from .openfoam.budget import BudgetedRunner
from .openfoam.acoustic_startup import acoustic_startup_step
from .openfoam.dialects import dialect_for_runner, find_force_coefficient_files
from .openfoam.execution import configure_flow_execution
from .openfoam.runner import get_runner
from .pipeline import _case_builder, _run_transient_mesh_qa_gate, _set_control_dict_entries, resolve_mesh_params
from .postprocess.forces import _strict_data_rows
from .thermodynamics import GasThermodynamics, ThermodynamicState
from .transport import PolynomialTransport


def source_material_for_canary(fixture_path):
    fixture = json.loads(Path(fixture_path).read_text())
    if fixture.get("kind") != "source-derived-native-material-regression" or fixture.get("installed") is not False:
        raise ValueError("The material canary requires an explicitly isolated source-derived fixture")
    transport = PolynomialTransport.model_validate(fixture["transport"])
    return GasThermodynamics(gas_constant=fixture["gas_constant"], heat_capacity_model="nasa7", nasa7=fixture["calorics"],
        transport_model="polynomial", polynomial_transport=transport, reference_temperature_k=288.15,
        reference_dynamic_viscosity=transport.dynamic_viscosity(288.15),
        provenance=f"Isolated source-derived canary, audit {fixture['source_audit_sha256']}; not installed as catalog data")


def run_canary(family, mach, coordinates_path, case_dir, runner, gas=None):
    coordinates = Path(coordinates_path).read_text()
    case_dir = Path(case_dir)
    case_dir.mkdir(parents=True, exist_ok=False)
    gas = gas if gas is not None else GasThermodynamics(
        gas_constant=287.05, heat_capacity_cp=1005, transport_model="sutherland",
        reference_dynamic_viscosity=1.7894e-5, reference_temperature_k=288.15,
        sutherland_temperature_k=110.4, provenance="isolated calorically-perfect-air numerical smoke definition",
    )
    state = ThermodynamicState(temperature_k=288.15, pressure_pa=101325)
    request = PolarRequest.model_validate({
        "airfoil": {"name": "ag24", "coordinates": coordinates},
        "chord_lengths": [1], "speeds": [mach * gas.speed_of_sound(state)], "aoa": {"angles": [0]},
        "fluid": {"density": gas.density(state), "dynamic_viscosity": gas.dynamic_viscosity(state.temperature_k), "gas": gas.model_dump()},
        "flow_state": state.model_dump(),
        "solver": {"flow_solver_family": family, "force_transient": family != "rhoSimpleFoam", "turbulent_prandtl": 0.85,
                   "n_iterations": 50, "transient_max_courant": 0.2, "write_images": []},
    })
    configure_flow_execution(runner, request)
    budgeted = BudgetedRunner(runner, 120)
    spec = request.cases()[0]
    budgeted.begin_case(spec)
    airfoil = Airfoil.from_contour("ag24", parse_airfoil(coordinates))
    mesh = resolve_mesh_params(MeshParams(n_surface=140, n_radial=60, n_wake=50, target_y_plus=40,
                                          farfield_radius_chords=18, wake_length_chords=12), spec, request.fluid)
    mesher = BlockMeshCGrid()
    builder = _case_builder(budgeted, airfoil, mesher.patches(mesh), mesh, spec, request.fluid,
                            request.roughness, request.solver, dialect=dialect_for_runner(budgeted))
    builder.write(case_dir)
    mesher.write_inputs(case_dir, airfoil, mesh, spec.chord)
    meshed = budgeted.application(case_dir, "blockMesh", timeout=120)
    (case_dir / "log.blockMesh").write_text(meshed.stdout)
    meshed.check()
    quality_warnings = []
    mesh_qa = _run_transient_mesh_qa_gate(case_dir, budgeted, quality_warnings)
    if mesh_qa is None:
        raise RuntimeError("Numerical canary requires a complete mesh quality verdict")
    if family != "rhoSimpleFoam":
        builder.write_transient(case_dir, 0, 1e-6, 1e-8, write_interval=1e-7, max_delta_t=1e-7)
    startup = None
    if family == "rhoCentralFoam":
        timestep = acoustic_startup_step(case_dir, budgeted, request.solver.transient_max_courant)
        _set_control_dict_entries(case_dir / "system/controlDict", {"deltaT": timestep})
        startup = json.loads((case_dir / "acoustic-startup.json").read_text())
    solved = budgeted.solver(case_dir, family, 1, timeout=120)
    (case_dir / f"log.{family}").write_text(solved.stdout)
    check_material_domain(case_dir, solved)
    solved.check()
    if startup is not None:
        measured = re.search(r"Mean and max Courant Numbers =\s+\S+\s+(\S+)", solved.stdout)
        if measured is None or not math.isfinite(float(measured[1])) or float(measured[1]) > startup["maximum_courant"] * (1 + 1e-8):
            raise RuntimeError("The native first-step Courant ceiling was not respected")
        startup["measured_first_courant"] = float(measured[1])
    if "End" not in solved.stdout or "Time =" not in solved.stdout:
        raise RuntimeError("The actual numerical solver did not finish its integration smoke")
    force_files = find_force_coefficient_files(case_dir)
    if not force_files:
        raise RuntimeError("The real solver produced no force coefficients")
    header, rows = _strict_data_rows(force_files[-1])
    if not header or rows is None or len(rows) < 3 or not all(math.isfinite(value) for row in rows for value in row):
        raise RuntimeError("The solver did not retain at least three finite force samples")
    if not (case_dir / "constant/aerodynamicReference.json").is_file() or (case_dir / "constant/transportProperties").exists():
        raise RuntimeError("Compressible reference metadata does not match the executed case")
    receipt = {"kind": "integration_smoke_only", "family": family, "mach": mach,
               "acoustic_startup": startup,
               "gas_model": gas.model_dump(mode="json"),
               "force_samples": len(rows), "solver_active_seconds": budgeted.consumed(spec),
               "mesh_quality": asdict(mesh_qa), "quality_warnings": quality_warnings,
               "converged_polar_validated": False}
    (case_dir / "receipt.json").write_text(json.dumps(receipt, allow_nan=False) + "\n")
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--family", choices=["rhoSimpleFoam", "rhoPimpleFoam", "rhoCentralFoam"], required=True)
    parser.add_argument("--mach", type=float, required=True)
    parser.add_argument("--coordinates", type=Path, required=True)
    parser.add_argument("--case-dir", type=Path, required=True)
    parser.add_argument("--material-fixture", type=Path)
    args = parser.parse_args()
    material = source_material_for_canary(args.material_fixture) if args.material_fixture else None
    receipt = run_canary(args.family, args.mach, args.coordinates, args.case_dir / str(uuid4()), get_runner(Settings()), gas=material)
    print(json.dumps(receipt, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
