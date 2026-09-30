"""Isolated real OpenFOAM integration smoke; never publishes polar evidence."""

import argparse
import hashlib
import json
import math
import re
import shlex
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

from .airfoil import Airfoil, parse_airfoil
from .config import Settings
from .material_domain import check_material_domain
from .meshing.blockmesh import BlockMeshCGrid, FINITE_EDGE_TOPOLOGY
from .meshing.cartesian2d import Cartesian2DExternalMesh
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


def run_canary(family, mach, coordinates_path, case_dir, runner, gas=None, *, maximum_courant=0.2,
               momentum_scheme="linearUpwind", limited_nonorthogonal=False, save_every_step=False,
               first_order_startup=False, finite_edge_mesh=False, tadmor_flux=False,
               minmod_reconstruction=False, energy_probe=None, density_farfield=False):
    if maximum_courant not in (0.05, 0.2) or momentum_scheme not in {"linearUpwind", "upwind"}:
        raise ValueError("Unsupported isolated startup comparison")
    if first_order_startup and (family != "rhoCentralFoam" or momentum_scheme != "linearUpwind" or limited_nonorthogonal or tadmor_flux or minmod_reconstruction):
        raise ValueError("The startup handoff requires the unchanged high-order density recipe")
    if (tadmor_flux or minmod_reconstruction) and (family != "rhoCentralFoam" or momentum_scheme != "linearUpwind"):
        raise ValueError("The flux comparison requires the high-order density recipe")
    if energy_probe is not None and family != "rhoCentralFoam":
        raise ValueError("The energy probe implements only the pinned density solver")
    if density_farfield and (family != "rhoPimpleFoam" or mach < 1.2):
        raise ValueError("Matched density far-field inputs require a supersonic pressure-solver comparison")
    solver_command = family if energy_probe is None else shlex.quote(str(Path(energy_probe).resolve(strict=True)))
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
                   "n_iterations": 50, "transient_max_courant": maximum_courant,
                   "momentum_scheme": momentum_scheme, "write_images": []},
    })
    configure_flow_execution(runner, request)
    budgeted = BudgetedRunner(runner, 300 if first_order_startup else 120)
    spec = request.cases()[0]
    budgeted.begin_case(spec)
    airfoil = Airfoil.from_contour("ag24", parse_airfoil(coordinates))
    mesh = resolve_mesh_params(MeshParams(n_surface=140, n_radial=60, n_wake=50, target_y_plus=40,
                                          farfield_radius_chords=18, wake_length_chords=12), spec, request.fluid)
    mesher = Cartesian2DExternalMesh() if airfoil.has_finite_trailing_edge else BlockMeshCGrid()
    if finite_edge_mesh:
        mesher = BlockMeshCGrid(topology=FINITE_EDGE_TOPOLOGY)
    mesh = mesh.model_copy(update={"mesher": mesher.name})
    builder = _case_builder(budgeted, airfoil, mesher.patches(mesh), mesh, spec, request.fluid,
                            request.roughness, request.solver, dialect=dialect_for_runner(budgeted))
    builder.write(case_dir)
    if density_farfield:
        builder.solver_family = "rhoCentralFoam"
        builder._write_zero(builder._turbulence())
        builder.solver_family = family
    mesher.write_inputs(case_dir, airfoil, mesh, spec.chord)
    mesh_command = "cartesian2DMesh" if isinstance(mesher, Cartesian2DExternalMesh) else "blockMesh"
    meshed = budgeted.application(case_dir, mesh_command, timeout=120)
    (case_dir / f"log.{mesh_command}").write_text(meshed.stdout)
    meshed.check()
    quality_warnings = []
    mesh_qa = _run_transient_mesh_qa_gate(case_dir, budgeted, quality_warnings)
    if mesh_qa is None:
        raise RuntimeError("Numerical canary requires a complete mesh quality verdict")
    if family != "rhoSimpleFoam":
        builder.write_transient(case_dir, 0, 1e-6, 1e-8, write_interval=1e-7, max_delta_t=1e-7)
    if limited_nonorthogonal:
        scheme_path = case_dir / "system/fvSchemes"
        original = scheme_path.read_text()
        changed, laplacians = re.subn(r"(\blaplacianSchemes\s*\{\s*default\s+)Gauss linear corrected(\s*;\s*\})", r"\g<1>Gauss linear limited 0.5\2", original)
        changed, gradients = re.subn(r"(\bsnGradSchemes\s*\{\s*default\s+)corrected(\s*;\s*\})", r"\g<1>limited 0.5\2", changed)
        if laplacians != 1 or gradients != 1:
            raise ValueError("The startup comparison requires the exact generated correction blocks")
        scheme_path.write_text(changed)
    if save_every_step:
        _set_control_dict_entries(case_dir / "system/controlDict", {"writeControl":"timeStep", "writeInterval":1, "purgeWrite":0})
    if tadmor_flux or minmod_reconstruction:
        scheme_path = case_dir / "system/fvSchemes"
        schemes = scheme_path.read_text()
        replacements = {"fluxScheme": ("Kurganov", "Tadmor")} if tadmor_flux else {}
        if minmod_reconstruction:
            replacements.update({"reconstruct(rho)": ("vanLeer", "Minmod"),
                                 "reconstruct(T)": ("vanLeer", "Minmod"),
                                 "reconstruct(U)": ("vanLeerV", "MinmodV")})
        for entry, (original, selected) in replacements.items():
            schemes, count = re.subn(r"(?m)^(\s*" + re.escape(entry) + r"\s+)" + original + r"(\s*;)",
                                     lambda match: match[1] + selected + match[2], schemes)
            if count != 1:
                raise ValueError(f"The comparison requires the exact generated {entry}")
        scheme_path.write_text(schemes)
    protocol = {"maximum_courant":maximum_courant,"momentum_scheme":momentum_scheme,
                "limited_nonorthogonal":limited_nonorthogonal,"save_every_step":save_every_step,
                "first_order_startup":first_order_startup, "finite_edge_mesh":finite_edge_mesh,
                "tadmor_flux":tadmor_flux, "minmod_reconstruction":minmod_reconstruction}
    protocol["density_farfield"] = density_farfield
    if energy_probe is not None:
        protocol["energy_probe_sha256"] = hashlib.sha256(Path(energy_probe).read_bytes()).hexdigest()
    (case_dir / "startup-comparison.json").write_text(json.dumps(protocol, allow_nan=False) + "\n")
    if first_order_startup:
        (case_dir / "fvSchemes.requested").write_bytes((case_dir / "system/fvSchemes").read_bytes())
        builder.solver = request.solver.model_copy(update={"momentum_scheme":"upwind"})
        builder._write_fv_schemes(builder._turbulence())
        (case_dir / "fvSchemes.startup").write_bytes((case_dir / "system/fvSchemes").read_bytes())
    startup = None
    if family == "rhoCentralFoam":
        timestep = acoustic_startup_step(case_dir, budgeted, request.solver.transient_max_courant)
        _set_control_dict_entries(case_dir / "system/controlDict", {"deltaT": timestep})
        startup = json.loads((case_dir / "acoustic-startup.json").read_text())
    solved = budgeted.solver(case_dir, solver_command, 1, timeout=120)
    (case_dir / f"log.{family}").write_text(solved.stdout)
    check_material_domain(case_dir, solved)
    solved.check()
    if startup is not None:
        verify_startup_courant(solved.stdout, startup)
    initial_startup = None
    if first_order_startup:
        if "End" not in solved.stdout or "Time =" not in solved.stdout:
            raise RuntimeError("The first-order startup did not complete")
        (case_dir / f"log.{family}.startup").write_text(solved.stdout)
        initial_startup = startup
        (case_dir / "acoustic-startup.initial.json").write_bytes((case_dir / "acoustic-startup.json").read_bytes())
        (case_dir / "system/fvSchemes").write_bytes((case_dir / "fvSchemes.requested").read_bytes())
        _set_control_dict_entries(case_dir / "system/controlDict", {"startFrom":"latestTime", "endTime":1e-5})
        timestep = acoustic_startup_step(case_dir, budgeted, maximum_courant)
        _set_control_dict_entries(case_dir / "system/controlDict", {"deltaT":timestep})
        startup = json.loads((case_dir / "acoustic-startup.json").read_text())
        solved = budgeted.solver(case_dir, solver_command, 1, timeout=300)
        (case_dir / f"log.{family}").write_text(solved.stdout)
        check_material_domain(case_dir, solved)
        solved.check()
    if startup is not None:
        verify_startup_courant(solved.stdout, startup)
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
               "initial_first_order_startup": initial_startup,
               "gas_model": gas.model_dump(mode="json"),
               "mesher": {"name": mesher.name, "cache_version": mesher.cache_version},
               "startup_comparison": protocol,
               "force_samples": len(rows), "solver_active_seconds": budgeted.consumed(spec),
               "mesh_quality": asdict(mesh_qa), "quality_warnings": quality_warnings,
               "converged_polar_validated": False}
    (case_dir / "receipt.json").write_text(json.dumps(receipt, allow_nan=False) + "\n")
    return receipt


def verify_startup_courant(stdout, startup):
    measured = re.search(r"Mean and max Courant Numbers =\s+\S+\s+(\S+)", stdout)
    if measured is None or not math.isfinite(float(measured[1])) or float(measured[1]) > startup["maximum_courant"] * (1 + 1e-8):
        raise RuntimeError("The native first-step Courant ceiling was not respected")
    startup["measured_first_courant"] = float(measured[1])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--family", choices=["rhoSimpleFoam", "rhoPimpleFoam", "rhoCentralFoam"], required=True)
    parser.add_argument("--mach", type=float, required=True)
    parser.add_argument("--coordinates", type=Path, required=True)
    parser.add_argument("--case-dir", type=Path, required=True)
    parser.add_argument("--material-fixture", type=Path)
    parser.add_argument("--maximum-courant", type=float, choices=[0.05, 0.2], default=0.2)
    parser.add_argument("--momentum-scheme", choices=["linearUpwind", "upwind"], default="linearUpwind")
    parser.add_argument("--limited-nonorthogonal", action="store_true")
    parser.add_argument("--save-every-step", action="store_true")
    parser.add_argument("--first-order-startup", action="store_true")
    parser.add_argument("--finite-edge-mesh", action="store_true")
    parser.add_argument("--tadmor-flux", action="store_true")
    parser.add_argument("--minmod-reconstruction", action="store_true")
    parser.add_argument("--energy-probe", type=Path)
    parser.add_argument("--density-farfield", action="store_true")
    args = parser.parse_args()
    material = source_material_for_canary(args.material_fixture) if args.material_fixture else None
    receipt = run_canary(args.family, args.mach, args.coordinates, args.case_dir / str(uuid4()), get_runner(Settings()), gas=material,
                         maximum_courant=args.maximum_courant, momentum_scheme=args.momentum_scheme,
                         limited_nonorthogonal=args.limited_nonorthogonal, save_every_step=args.save_every_step,
                         first_order_startup=args.first_order_startup, finite_edge_mesh=args.finite_edge_mesh,
                         tadmor_flux=args.tadmor_flux, minmod_reconstruction=args.minmod_reconstruction,
                         energy_probe=args.energy_probe, density_farfield=args.density_farfield)
    print(json.dumps(receipt, allow_nan=False), flush=True)


if __name__ == "__main__":
    main()
