import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import time
import xml.etree.ElementTree as xml
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from rae2822_reference import load_reference, selig_coordinates
from solver_stability import solver_stability
from rae2822_grid import write_nasa_grid
from rae2822_mapping import map_verified_initial_fields
from rae2822_local_time import attach_pressure_energy_output, attach_pressure_steady_detector, configure_local_time_pressure, configure_low_re_k_wall, continuation_end_iteration, limit_sst_gradients, pressure_steady_convergence, restore_local_pressure_state, tighten_pressure_inner_solves
from mpi_binding_experiment import configure_unbound_mpi
from rae2822_density import configure_density_reference, density_reference_convergence


RAE_TIERS = {"fast": (84, 52, 40, 1500, 1e-4), "precise": (128, 80, 64, 3000, 1e-5), "refined": (256, 160, 128, 6000, 1e-5)}


def benchmark_processes(requested, available):
    if type(requested) is not int or type(available) is not int or not 1 <= requested <= available:
        raise ValueError("Benchmark processes must be positive integers within the worker CPU budget")
    return requested


def reconstruct_timed_out_parallel_case(runner, destination, solved, processes):
    if processes > 1 and solved.timed_out:
        reconstructed = runner.application(destination, "reconstructPar -latestTime", timeout=120)
        (destination / "log.reconstructPar").write_text(reconstructed.stdout)
        reconstructed.check()


def benchmark_time_budget(value=600):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not np.isfinite(value) or not 0 < value <= 3600:
        raise ValueError("Benchmark time budget must be finite, positive and at most 3600 seconds")
    return float(value)


def configure_limited_nonorthogonal(path):
    original = Path(path).read_text()
    patterns = [
        (r"(\blaplacianSchemes\s*\{\s*default\s+)Gauss linear corrected(\s*;\s*\})", r"\g<1>Gauss linear limited 0.5\2"),
        (r"(\bsnGradSchemes\s*\{\s*default\s+)corrected(\s*;\s*\})", r"\g<1>limited 0.5\2"),
    ]
    changed = original
    for pattern, replacement in patterns:
        changed, count = re.subn(pattern, replacement, changed)
        if count != 1:
            raise ValueError("Expected exact generated Laplacian and surface-normal correction blocks")
    Path(path).write_text(changed)


def benchmark_momentum_scheme(first_order=False):
    if not isinstance(first_order, bool):
        raise ValueError("Transport order must be an explicit benchmark choice")
    return "upwind" if first_order else "linearUpwind"


def benchmark_mesh(tier, wall_functions=False):
    if not isinstance(wall_functions, bool):
        raise ValueError("Wall treatment must be an explicit benchmark choice")
    dimensions = RAE_TIERS[tier]
    return {"n_surface": dimensions[0], "n_radial": dimensions[1], "n_wake": dimensions[2],
            "target_y_plus": 40 if wall_functions else 1, "farfield_radius_chords": 15, "wake_length_chords": 12}


def wall_pressure(path, chord, pressure, density, speed, coordinates):
    piece = xml.parse(path).getroot().find("./PolyData/Piece")
    if piece is None:
        raise ValueError("Expected an actual VTK airfoil surface")

    def values(location, width=1, integer=False):
        element = piece.find(location)
        if element is None or element.get("format") != "ascii":
            raise ValueError(f"Missing ASCII surface field: {location}")
        array = np.array([float(value) for value in (element.text or "").split()])
        if array.size == 0 or not np.isfinite(array).all() or array.size % width:
            raise ValueError("Malformed surface data")
        if integer:
            if np.any(array != np.floor(array)):
                raise ValueError("Surface connectivity is not integral")
            array = array.astype(int)
        return array.reshape((-1, width)) if width > 1 else array

    points = values("./Points/DataArray", 3)
    connectivity = values("./Polys/DataArray[@Name='connectivity']", integer=True)
    offsets = values("./Polys/DataArray[@Name='offsets']", integer=True)
    pressures = values("./CellData/DataArray[@Name='p']")
    if len(pressures) != len(offsets) or offsets[-1] != len(connectivity):
        raise ValueError("Pressure samples do not match the surface cells")
    if np.any(connectivity < 0) or np.any(connectivity >= len(points)) or np.any(np.diff(np.r_[0, offsets]) < 3):
        raise ValueError("Invalid surface polygon topology")
    if any(not np.isfinite(value) or value <= 0 for value in [chord, pressure, density, speed]):
        raise ValueError("Missing physical pressure reference")
    contour = np.asarray(coordinates)
    leading = int(np.argmin(contour[:, 0]))
    upper = contour[:leading + 1][::-1]
    lower = contour[leading:]
    result = {"upper": [], "lower": []}
    start = 0
    for index, end in enumerate(offsets):
        centre = points[connectivity[start:end]].mean(axis=0) / chord
        start = end
        if not 0 <= centre[0] <= 1:
            raise ValueError("Exported pressure is not on the reference airfoil")
        camber = (np.interp(centre[0], upper[:, 0], upper[:, 1]) + np.interp(centre[0], lower[:, 0], lower[:, 1])) / 2
        surface = "upper" if centre[1] >= camber else "lower"
        coefficient = (pressures[index] - pressure) / (0.5 * density * speed ** 2)
        result[surface].append([float(centre[0]), float(coefficient)])
    for surface in result:
        result[surface].sort()
        if len(result[surface]) < 2:
            raise ValueError("Both airfoil surfaces require real pressure samples")
    return result


def compare_pressure(computed, measured):
    result = {}
    for surface in ("upper", "lower"):
        source = np.asarray(computed[surface], dtype=float)
        reference = np.asarray(measured[surface], dtype=float)
        if source.ndim != 2 or source.shape[1] != 2 or not np.isfinite(source).all() or np.any(np.diff(source[:, 0]) <= 0):
            raise ValueError("Computed pressure coordinates must be finite and strictly increasing")
        estimate = np.interp(reference[:, 0], source[:, 0], source[:, 1], left=np.nan, right=np.nan)
        covered = np.isfinite(estimate)
        if np.count_nonzero(covered) < 2:
            raise ValueError("No bracketed pressure comparison is available")
        errors = estimate[covered] - reference[covered, 1]
        result[surface] = {"measured_samples": len(reference), "compared_samples": int(covered.sum()),
            "excluded_extrapolations": int((~covered).sum()), "cp_rmse": float(np.sqrt(np.mean(errors ** 2))),
            "cp_maximum_absolute_error": float(np.max(np.abs(errors))),
            "samples": np.column_stack((reference[covered, 0], reference[covered, 1], estimate[covered])).tolist()}
    return result


def pressure_iteration(path):
    element = xml.parse(path).getroot().find("./PolyData/FieldData/DataArray[@Name='TimeValue']")
    if element is None or element.get("format") != "ascii":
        raise ValueError("Pressure export has no recorded solution coordinate")
    values = (element.text or "").split()
    if len(values) != 1:
        raise ValueError("Pressure export has an ambiguous solution coordinate")
    coordinate = float(values[0])
    if not np.isfinite(coordinate) or coordinate <= 0:
        raise ValueError("Initial or invalid pressure field is not calculated evidence")
    return coordinate


def configure_transonic_pressure(path):
    text = Path(path).read_text()
    changed, count = re.subn(r"\btransonic\s+no\s*;", "transonic yes;", text)
    if count != 1:
        raise ValueError("Expected one generated disabled transonic pressure option")
    Path(path).write_text(changed)


def configure_density_relaxation(path, factor):
    if isinstance(factor, bool) or not isinstance(factor, (int, float)) or not np.isfinite(factor) or not 0 < factor <= 1:
        raise ValueError("Density relaxation must be finite and in (0, 1]")
    original = Path(path).read_text()
    changed, count = re.subn(r"(\bfields\s*\{[^{}]*\brho\s+)0\.01(\s*;)",
                             lambda match: f"{match[1]}{factor:g}{match[2]}", original)
    if count != 1:
        raise ValueError("Expected one generated density field relaxation")
    Path(path).write_text(changed)


def configure_consistent_pressure(path):
    original = Path(path).read_text()
    changed, count = re.subn(r"\bconsistent\s+no\s*;", "consistent yes;", original)
    if count != 1:
        raise ValueError("Expected one generated disabled consistent pressure option")
    Path(path).write_text(changed)


def configure_enthalpy_energy(directory):
    directory = Path(directory)
    updates = []
    for relative, pattern, replacement, expected in [
        ("constant/thermophysicalProperties", r"\benergy\s+sensibleInternalEnergy\s*;", "energy sensibleEnthalpy;", 1),
        ("system/fvSchemes", r"div\(phi,e\)", "div(phi,h)", 1),
        ("system/fvSolution", r"(?m)^(\s*)e(\s+[-+\d.eE]+\s*;)", r"\1h\2", 2),
    ]:
        path = directory / relative
        original = path.read_text()
        updated, count = re.subn(pattern, replacement, original)
        if count != expected:
            raise ValueError(f"Enthalpy experiment requires exact generated energy settings: {relative}")
        updates.append((path, updated))
    for path, updated in updates:
        path.write_text(updated)


def configure_pressure_equation_relaxation(path, factor=1):
    if not isinstance(factor, (int, float)) or not np.isfinite(factor) or not 0 < factor <= 1:
        raise ValueError("Pressure equation relaxation must be in (0, 1]")
    path = Path(path)
    original = path.read_text()
    matches = list(re.finditer(r"\bequations\s*\{([^{}]*)\}", original))
    if len(matches) != 1 or re.search(r"\bp(?:Final)?\s+", matches[0][1]):
        raise ValueError("Expected one generated equation block without pressure relaxation")
    match = matches[0]
    replacement = f"equations {{{match[1]}\n        p {factor:g};\n        pFinal {factor:g};\n    }}"
    path.write_text(original[:match.start()] + replacement + original[match.end():])


def configure_pressure_krylov(path):
    path = Path(path)
    original = path.read_text()
    names = []

    def replace(match):
        names.append(match[1])
        body, solvers = re.subn(r"\bsolver\s+GAMG\s*;", "solver PBiCGStab;", match[2])
        body, preconditioners = re.subn(r"\bsmoother\s+GaussSeidel\s*;", "preconditioner DILU;", body)
        if solvers != 1 or preconditioners != 1:
            raise ValueError("Expected generated pressure GAMG settings")
        return f"{match[1]} {{{body}}}"

    updated = re.sub(r"\b(p|pFinal)\s*\{([^{}]*)\}", replace, original)
    if sorted(names) != ["p", "pFinal"]:
        raise ValueError("Expected exactly p and pFinal pressure solvers")
    path.write_text(updated)


def configure_upwind_energy(path):
    path = Path(path)
    original = path.read_text()
    updated, count = re.subn(r"(div\(phi,(?:e|h|K|Ekp)\)\s+)bounded Gauss linearUpwind limited;", r"\1bounded Gauss upwind;", original)
    if count != 3 or len(re.findall(r"div\(phi,U\)\s+bounded Gauss linearUpwind limited;", original)) != 1:
        raise ValueError("Expected exact higher-order momentum and three energy transport entries")
    path.write_text(updated)


def restore_verified_donor(source, destination, request, enthalpy, transonic, consistent_pressure=False, density_relaxation=None):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Donor and fresh result must be separate sibling scopes")
    report_bytes = (source / "report.json").read_bytes()
    report = json.loads(report_bytes)
    expected = json.loads(json.dumps(request))
    expected["solver"]["momentum_scheme"] = "upwind"
    coordinate = report.get("pressure_iteration")
    if (report.get("outcome") != "measured_converged" or report.get("convergence", {}).get("converged") is not True
            or report.get("request") != expected or report.get("experimental_transonic_pressure") != transonic
            or report.get("experimental_consistent_pressure", False) != consistent_pressure
            or report.get("experimental_density_relaxation") != density_relaxation
            or report.get("experimental_energy_form") != ("sensibleEnthalpy" if enthalpy else "sensibleInternalEnergy")
            or not isinstance(coordinate, (int, float)) or not np.isfinite(coordinate) or coordinate <= 0 or not float(coordinate).is_integer()):
        raise ValueError("Donor does not match the converged physical and numerical setup")
    time_name = str(int(coordinate))
    for field in ["U", "p", "T", "k", "omega", "rho", "phi"]:
        if not (source / time_name / field).is_file():
            raise ValueError(f"Donor lacks the stored {field} field")
    for member in ["points", "faces", "owner", "neighbour", "boundary"]:
        if not (source / "constant/polyMesh" / member).is_file():
            raise ValueError(f"Donor lacks the stored mesh {member}")
    trees = [Path("constant/polyMesh"), Path(time_name)]
    members = []
    for tree in trees:
        if not (source / tree).is_dir() or (destination / tree).exists():
            raise ValueError("Donor mesh/fields are missing or the fresh destination is occupied")
        for path in sorted((source / tree).rglob("*")):
            if path.is_symlink():
                raise ValueError("Donor members must be retained regular files")
            if path.is_file():
                members.append({"path": str(path.relative_to(source)), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    for tree in trees:
        shutil.copytree(source / tree, destination / tree)
    for member in members:
        if hashlib.sha256((destination / member["path"]).read_bytes()).hexdigest() != member["sha256"]:
            raise ValueError("Copied donor field checksum mismatch")
    return {"source": str(source), "report_sha256": hashlib.sha256(report_bytes).hexdigest(), "coordinate": coordinate, "members": members}


def run(reference_directory, material_path, destination, tier, transonic=False, wall_functions=False, uniform_start=False, enthalpy=False, first_order=False, donor=None, upwind_energy=False, pressure_krylov=False, pressure_equation_relaxation=None, time_budget_seconds=600, limited_nonorthogonal=False, reference_grid=None, mesh_only=False, consistent_pressure=False, processes=1, density_relaxation=None, mapped_donor=None, local_time_pressure=False, resume_local_pressure=None, pressure_advection="upwind", unbound_mpi=False, resume_to_iteration=None, native_steady_check=False, snapshot_audit=False, local_max_courant=0.5, local_step_smoothing=0.02, low_re_k_wall=False, research_iteration_allowance=None, tight_inner_solves=False, sst_gradient_limiter=False, density_local_time=False):
    started_at = time.monotonic()
    if density_local_time and (not uniform_start or any([
        enthalpy, donor, mapped_donor, resume_local_pressure, local_time_pressure, transonic,
        consistent_pressure, upwind_energy, pressure_krylov, pressure_equation_relaxation is not None,
        density_relaxation is not None, native_steady_check, snapshot_audit, reference_grid, mesh_only,
        limited_nonorthogonal, low_re_k_wall, tight_inner_solves, sst_gradient_limiter,
    ])):
        raise ValueError("Density reference requires a fresh uniform internal-energy case without other experiments")
    if sst_gradient_limiter and not local_time_pressure:
        raise ValueError("SST gradient experiment requires local-time pressure solving")
    if tight_inner_solves and (not local_time_pressure or not native_steady_check):
        raise ValueError("Tighter inner solves require the native-checked local-pressure experiment")
    if research_iteration_allowance is not None:
        if not resume_local_pressure or not native_steady_check or resume_to_iteration is None:
            raise ValueError("Extended research allowance requires a native-checked continuation and exact target")
        continuation_end_iteration(1, 1, research_allowance=research_iteration_allowance)
    if low_re_k_wall and (not local_time_pressure or wall_functions or donor or mapped_donor or resume_local_pressure):
        raise ValueError("Low-Re k wall study requires a fresh wall-resolved local-pressure case")
    if local_step_smoothing != 0.02 and not local_time_pressure:
        raise ValueError("Local smoothing experiment cannot change physical-time settings")
    if local_max_courant != 0.5 and not local_time_pressure:
        raise ValueError("Local Courant experiment cannot change physical-time settings")
    if snapshot_audit and (not native_steady_check or not resume_local_pressure or resume_to_iteration is None):
        raise ValueError("Snapshot audit requires an explicit native-check continuation target")
    if native_steady_check and not local_time_pressure:
        raise ValueError("Native pressure-rate checking requires local-time pressure solving")
    if resume_to_iteration is not None and not resume_local_pressure:
        raise ValueError("An exact continuation target requires a retained local-pressure source")
    if pressure_advection != "upwind" and not local_time_pressure:
        raise ValueError("Pressure-advection experiment requires local-time pressure coupling")
    if resume_local_pressure and (not local_time_pressure or donor or mapped_donor or reference_grid or mesh_only):
        raise ValueError("Experimental continuation requires only the local pressure recipe")
    if local_time_pressure and (not enthalpy or not uniform_start or donor or mapped_donor or transonic or consistent_pressure or density_relaxation is not None or pressure_equation_relaxation is not None or pressure_krylov or upwind_energy):
        raise ValueError("Local pressure study requires its explicit uniform enthalpy recipe without other solver overrides")
    if mapped_donor and (donor or reference_grid or not uniform_start):
        raise ValueError("Mapped donor requires a new generated mesh and no other initializer")
    if transonic and density_relaxation is not None:
        raise ValueError("Transonic native pressure correction bypasses density relaxation")
    time_budget_seconds = benchmark_time_budget(time_budget_seconds)
    from airfoilfoam.airfoil import Airfoil, parse_airfoil
    from airfoilfoam.config import Settings
    from airfoilfoam.material_domain import check_material_domain
    from airfoilfoam.meshing.blockmesh import BlockMeshCGrid
    from airfoilfoam.models import PolarRequest
    from airfoilfoam.numerical_canary import source_material_for_canary
    from airfoilfoam.openfoam.budget import BudgetedRunner
    from airfoilfoam.openfoam.dialects import dialect_for_runner, find_force_coefficient_files
    from airfoilfoam.openfoam.execution import configure_flow_execution
    from airfoilfoam.openfoam.potential_initialization import initialize_compressible_velocity
    from airfoilfoam.openfoam.runner import get_runner
    from airfoilfoam.pipeline import _case_builder, _run_transient_mesh_qa_gate, _set_control_dict_entries, resolve_mesh_params
    from airfoilfoam.postprocess.forces import force_is_steady, parse_force_coefficients, parse_y_plus
    from airfoilfoam.postprocess.residuals import parse_convergence
    from airfoilfoam.thermodynamics import ThermodynamicState

    reference = load_reference(reference_directory)
    if reference_grid and (donor or wall_functions):
        raise ValueError("Published wall-resolved reference grid cannot be combined with donor or wall-function spacing")
    momentum_scheme = benchmark_momentum_scheme(first_order)
    conditions = reference["conditions"]
    destination = Path(destination) / str(uuid4())
    destination.mkdir(parents=True, exist_ok=False)
    gas = source_material_for_canary(material_path)
    state = ThermodynamicState(temperature_k=conditions["temperature_k"], pressure_pa=conditions["pressure_pa"])
    speed = conditions["mach"] * gas.speed_of_sound(state)
    density = gas.density(state)
    viscosity = gas.dynamic_viscosity(state.temperature_k)
    dimensions = RAE_TIERS[tier]
    request = PolarRequest.model_validate({
        "airfoil": {"name": "RAE 2822 NASA Study 1 isolated validation", "coordinates": selig_coordinates(reference)},
        "chord_lengths": [conditions["chord_m"]], "speeds": [speed], "aoa": {"angles": [conditions["alpha_deg"]]},
        "fluid": {"density": density, "dynamic_viscosity": viscosity, "gas": gas.model_dump()}, "flow_state": state.model_dump(),
        "mesh": benchmark_mesh(tier, wall_functions),
        "solver": {"flow_solver_family": "rhoSimpleFoam", "force_transient": False, "transient_fallback": False,
                   "momentum_scheme": momentum_scheme, "turbulent_prandtl": 0.85, "n_iterations": dimensions[3],
                   "convergence_tolerance": dimensions[4], "write_images": []},
    })
    runner = get_runner(Settings())
    if unbound_mpi:
        configure_unbound_mpi(runner)
    available_processes = int(runner.settings.resolved_worker_cpu_budget())
    processes = benchmark_processes(processes, available_processes)
    configure_flow_execution(runner, request)
    budgeted = BudgetedRunner(runner, time_budget_seconds)
    spec = request.cases()[0]
    budgeted.begin_case(spec)
    report = {"kind": "rae2822-transonic-pressure-validation", "tier": tier, "production_evidence": False,
              "time_budget_seconds": time_budget_seconds,
              "execution_resources": {"mpi_processes": processes, "worker_cpu_budget": available_processes,
                                      "mpi_binding_environment_request": os.environ.get("OMPI_MCA_hwloc_base_binding_policy"),
                                      "mpi_binding_command_line": "none" if unbound_mpi else None},
              "experimental_nonorthogonal_correction": "limited 0.5" if limited_nonorthogonal else "corrected",
              "accuracy_certified": False, "outcome": "failed", "reference": reference["provenance"],
              "experimental_transonic_pressure": transonic,
              "experimental_consistent_pressure": consistent_pressure,
              "experimental_density_relaxation": density_relaxation,
              "experimental_local_time_pressure": local_time_pressure,
              "experimental_density_local_time": density_local_time,
              "experimental_pressure_advection": pressure_advection,
              "experimental_time_step_smoothing": local_step_smoothing,
              "experimental_low_re_k_wall": low_re_k_wall,
              "velocity_initialization": "resumed-local-pressure-state" if resume_local_pressure else "mapped-converged-donor" if mapped_donor else "verified-donor" if donor else "uniform-freestream" if uniform_start else "velocity-only-potential",
              "experimental_energy_form": "sensibleEnthalpy" if enthalpy else "sensibleInternalEnergy",
              "experimental_momentum_scheme": momentum_scheme,
              "experimental_energy_transport": "upwind" if upwind_energy else momentum_scheme,
              "experimental_pressure_solver": "PBiCGStab" if pressure_krylov else "GAMG",
              "experimental_pressure_equation_relaxation": pressure_equation_relaxation,
              "resolved_reynolds": density * speed * spec.chord / viscosity,
              "request": request.model_dump(mode="json")}
    try:
        airfoil = Airfoil.from_contour("RAE 2822", parse_airfoil(request.airfoil.coordinates))
        mesh = resolve_mesh_params(request.mesh, spec, request.fluid)
        mesher = BlockMeshCGrid()
        patches = mesher.patches(mesh)
        builder = _case_builder(budgeted, airfoil, patches, mesh, spec, request.fluid, request.roughness, request.solver, n_proc=processes)
        builder.write(destination)
        if low_re_k_wall:
            configure_low_re_k_wall(destination)
        if limited_nonorthogonal:
            configure_limited_nonorthogonal(destination / "system/fvSchemes")
        if enthalpy:
            configure_enthalpy_energy(destination)
        if upwind_energy:
            configure_upwind_energy(destination / "system/fvSchemes")
        if transonic:
            configure_transonic_pressure(destination / "system/fvSolution")
        if consistent_pressure:
            configure_consistent_pressure(destination / "system/fvSolution")
        if density_relaxation is not None:
            configure_density_relaxation(destination / "system/fvSolution", density_relaxation)
        if pressure_krylov:
            configure_pressure_krylov(destination / "system/fvSolution")
        if pressure_equation_relaxation is not None:
            configure_pressure_equation_relaxation(destination / "system/fvSolution", pressure_equation_relaxation)
        _set_control_dict_entries(destination / "system/controlDict", {"writeInterval": 100, "purgeWrite": 2})
        application = "rhoPimpleFoam" if local_time_pressure else "rhoSimpleFoam"
        if local_time_pressure:
            report["actual_execution"] = configure_local_time_pressure(destination, spec.chord, spec.speed, pressure_advection, local_max_courant, local_step_smoothing)
            _set_control_dict_entries(destination / "system/controlDict", {"application": application, "deltaT": 1, "adjustTimeStep": "no"})
        if native_steady_check:
            from airfoilfoam import physics

            turbulent_energy = physics.freestream_k(spec.speed, request.solver.turbulence.intensity)
            references = {"referenceDensity": density, "referenceSpeed": spec.speed, "referenceLength": spec.chord,
                          "referenceSpecificEnergy": gas.heat_capacity_at(state.temperature_k) * state.temperature_k + 0.5 * spec.speed ** 2,
                          "referenceTurbulenceEnergy": turbulent_energy,
                          "referenceTurbulenceFrequency": physics.freestream_omega(turbulent_energy, request.fluid.nu, request.solver.turbulence.viscosity_ratio)}
            report["native_steady_detector"] = attach_pressure_steady_detector(destination, references, request.solver.convergence_tolerance)
            report["actual_execution"]["steady_acceptance_certificate"] = "native_v2_primitive_rates_with_force_window"
            (destination / "constant/numericalExecution.json").write_text(json.dumps(report["actual_execution"]) + "\n")
        if density_local_time:
            report["actual_execution"] = configure_density_reference(destination, builder)
            application = "rhoCentralFoam"
        report["benchmark_output_policy"] = {"write_interval_iterations": 100, "retained_field_times": 2}
        if resume_local_pressure:
            report["experimental_continuation"] = restore_local_pressure_state(resume_local_pressure, destination, report["request"], report["actual_execution"])
            report["continuation_target_iteration"] = continuation_end_iteration(report["experimental_continuation"]["coordinate"], dimensions[3], resume_to_iteration, research_iteration_allowance)
            if research_iteration_allowance is not None:
                report["research_execution_allocation"] = {"additional_iterations": research_iteration_allowance,
                                                           "solver_seconds_ceiling": time_budget_seconds, "campaign_budget_changed": False}
            _set_control_dict_entries(destination / "system/controlDict", {
                "startFrom": "latestTime", "endTime": report["continuation_target_iteration"],
            })
            if snapshot_audit:
                if report["continuation_target_iteration"] - report["experimental_continuation"]["coordinate"] > 250:
                    raise ValueError("Snapshot audit is limited to250new iterations")
                attach_pressure_energy_output(destination)
                _set_control_dict_entries(destination / "system/controlDict", {"writeInterval": 1, "writePrecision": 17})
                report["benchmark_output_policy"] = {"write_interval_iterations": 1, "retained_field_times": 2,
                                                       "write_precision": 17, "explicit_energy_field": "h", "purpose": "conserved_rate_audit"}
        elif donor:
            report["donor"] = restore_verified_donor(donor, destination, request.model_dump(mode="json"), enthalpy, transonic, consistent_pressure, density_relaxation)
            _set_control_dict_entries(destination / "system/controlDict", {
                "startFrom": "latestTime", "endTime": int(report["donor"]["coordinate"]) + dimensions[3],
            })
        elif reference_grid:
            report["reference_grid"] = write_nasa_grid(reference_grid, destination, spec.chord, mesh.span_chords)
        else:
            mesher.write_inputs(destination, airfoil, mesh, spec.chord)
            meshed = budgeted.application(destination, "blockMesh", timeout=120)
            (destination / "log.blockMesh").write_text(meshed.stdout)
            meshed.check()
        warnings = []
        if tight_inner_solves:
            report["inner_solve_experiment"] = tighten_pressure_inner_solves(destination)
        if sst_gradient_limiter:
            report["sst_gradient_experiment"] = limit_sst_gradients(destination)
        verdict = _run_transient_mesh_qa_gate(destination, budgeted, warnings)
        if verdict is None:
            raise ValueError("Mesh quality is unavailable")
        report["mesh_quality"] = asdict(verdict)
        report["mesh_warnings"] = warnings
        if mesh_only:
            report["outcome"] = "mesh_verified_only"
            return
        if mapped_donor:
            settings = {key: value for key, value in report.items() if key.startswith("experimental_")}
            report["mapped_initialization"] = map_verified_initial_fields(runner, mapped_donor, destination,
                                                                          report["request"], settings)
        if not uniform_start and not donor:
            initialized = initialize_compressible_velocity(destination, budgeted, patches, dialect_for_runner(runner).potential_foam_command)
            (destination / "log.potentialFoam").write_text(initialized.stdout)
            initialized.check()
        solved = budgeted.solver(destination, application, processes, timeout=time_budget_seconds, restart=bool(donor or resume_local_pressure))
        (destination / f"log.{application}").write_text(solved.stdout)
        reconstruct_timed_out_parallel_case(runner, destination, solved, processes)
        report["numerical_stability"] = solver_stability(solved.stdout.splitlines())
        check_material_domain(destination, solved)
        if not solved.timed_out:
            solved.check()
        report["budget_exhausted"] = solved.timed_out
        report["convergence"] = asdict(parse_convergence(solved.stdout))
        if local_time_pressure:
            report["convergence"]["converged"] = False
            report["convergence"]["interpretation"] = "no_native_steady_certificate"
        histories = find_force_coefficient_files(destination)
        if not histories:
            raise ValueError("No measured force coefficients")
        if native_steady_check:
            report["convergence"] = pressure_steady_convergence(solved.stdout, request.solver.convergence_tolerance,
                                                                 force_is_steady(histories[-1]), report["numerical_stability"])
        if density_local_time:
            report["convergence"] = density_reference_convergence(solved.stdout, request.solver.convergence_tolerance,
                                                                   force_is_steady(histories[-1]))
        report["force_coefficients"] = asdict(parse_force_coefficients(histories[-1]))
        converted = runner.application(destination, "foamToVTK -latestTime -ascii -no-internal -patches '(airfoil)' -fields '(p)'", timeout=120)
        (destination / "log.foamToVTK").write_text(converted.stdout)
        converted.check()
        surfaces = list((destination / "VTK").rglob("airfoil.vtp"))
        if len(surfaces) != 1:
            raise ValueError(f"Expected one latest airfoil pressure surface, found {len(surfaces)}")
        report["pressure_iteration"] = pressure_iteration(surfaces[0])
        if donor and report["pressure_iteration"] <= report["donor"]["coordinate"]:
            raise ValueError("Refinement did not publish a newly calculated pressure field")
        if resume_local_pressure and report["pressure_iteration"] <= report["experimental_continuation"]["coordinate"]:
            raise ValueError("Experimental continuation did not publish newly calculated fields")
        computed = wall_pressure(surfaces[0], spec.chord, state.pressure_pa, density, speed, reference["coordinates"])
        report["pressure_comparison"] = compare_pressure(computed, reference["pressure"])
        report["pressure_surface"] = {"path": str(surfaces[0].relative_to(destination)),
            "sha256": hashlib.sha256(surfaces[0].read_bytes()).hexdigest(), "samples": computed}
        wall_command = f"{application} -postProcess -func yPlus -latestTime" if local_time_pressure or density_local_time else dialect_for_runner(runner).y_plus_command
        wall_result = runner.application(destination, wall_command, timeout=120)
        (destination / "log.yPlus").write_text(wall_result.stdout)
        wall_result.check()
        wall_files = sorted(destination.glob("postProcessing/yPlus/*/yPlus.dat"))
        if not wall_files:
            raise ValueError("Wall resolution has no measured yPlus artifact")
        average, maximum = parse_y_plus(wall_files[-1])
        if any(value is None or not np.isfinite(value) or value <= 0 for value in (average, maximum)):
            raise ValueError("Wall resolution has invalid measured yPlus")
        report["wall_resolution"] = {"target_y_plus": request.mesh.target_y_plus, "average": average, "maximum": maximum,
            "path": str(wall_files[-1].relative_to(destination)), "sha256": hashlib.sha256(wall_files[-1].read_bytes()).hexdigest()}
        report["outcome"] = "measured_uncertified" if local_time_pressure or density_local_time else "measured_converged" if report["convergence"]["converged"] else "measured_unconverged"
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        report["active_seconds"] = budgeted.consumed(spec)
        if "experimental_continuation" in report:
            report["accumulated_active_seconds"] = report["experimental_continuation"]["prior_active_seconds"] + report["active_seconds"]
        report["elapsed_seconds"] = time.monotonic() - started_at
        (destination / "report.json").write_text(json.dumps(report, allow_nan=False) + "\n")
        print(json.dumps({"kind": report["kind"], "tier": tier, "outcome": report["outcome"],
            "convergence": report.get("convergence"), "active_seconds": report["active_seconds"],
            "report": str(destination / "report.json"), "accuracy_certified": False}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", required=True)
    parser.add_argument("--material", required=True)
    parser.add_argument("--destination", required=True)
    parser.add_argument("--tier", choices=["fast", "precise", "refined"], required=True)
    parser.add_argument("--transonic", action="store_true")
    parser.add_argument("--consistent-pressure", action="store_true")
    parser.add_argument("--processes", type=int, default=1)
    parser.add_argument("--density-relaxation", type=float)
    parser.add_argument("--wall-functions", action="store_true", help="Use target yPlus40 spacing instead of yPlus1; the blended wall boundary types are unchanged")
    parser.add_argument("--uniform-start", action="store_true")
    parser.add_argument("--enthalpy", action="store_true")
    parser.add_argument("--first-order", action="store_true")
    parser.add_argument("--donor")
    parser.add_argument("--mapped-donor")
    parser.add_argument("--local-time-pressure", action="store_true")
    parser.add_argument("--resume-local-pressure")
    parser.add_argument("--pressure-advection", choices=["upwind", "vanLeer"], default="upwind")
    parser.add_argument("--unbound-mpi", action="store_true")
    parser.add_argument("--resume-to-iteration", type=int)
    parser.add_argument("--native-steady-check", action="store_true")
    parser.add_argument("--snapshot-audit", action="store_true")
    parser.add_argument("--local-max-courant", type=float, choices=[0.5, 0.8], default=0.5)
    parser.add_argument("--local-step-smoothing", type=float, choices=[0.02, 0.2], default=0.02)
    parser.add_argument("--low-re-k-wall", action="store_true")
    parser.add_argument("--research-iteration-allowance", type=int)
    parser.add_argument("--tight-inner-solves", action="store_true")
    parser.add_argument("--sst-gradient-limiter", action="store_true")
    parser.add_argument("--density-local-time", action="store_true")
    parser.add_argument("--upwind-energy", action="store_true")
    parser.add_argument("--pressure-krylov", action="store_true")
    parser.add_argument("--pressure-equation-relaxation", nargs="?", const=1, type=float)
    parser.add_argument("--time-budget-seconds", type=float, default=600)
    parser.add_argument("--reference-grid", type=Path)
    parser.add_argument("--mesh-only", action="store_true")
    parser.add_argument("--limited-nonorthogonal", action="store_true")
    arguments = parser.parse_args()
    run(arguments.reference, arguments.material, arguments.destination, arguments.tier, arguments.transonic, arguments.wall_functions, arguments.uniform_start, arguments.enthalpy, arguments.first_order, arguments.donor, arguments.upwind_energy, arguments.pressure_krylov, arguments.pressure_equation_relaxation, arguments.time_budget_seconds, arguments.limited_nonorthogonal, arguments.reference_grid, arguments.mesh_only, arguments.consistent_pressure, arguments.processes, arguments.density_relaxation, arguments.mapped_donor, arguments.local_time_pressure, arguments.resume_local_pressure, arguments.pressure_advection, arguments.unbound_mpi, arguments.resume_to_iteration, arguments.native_steady_check, arguments.snapshot_audit, arguments.local_max_courant, arguments.local_step_smoothing, arguments.low_re_k_wall, arguments.research_iteration_allowance, arguments.tight_inner_solves, arguments.sst_gradient_limiter, arguments.density_local_time)
