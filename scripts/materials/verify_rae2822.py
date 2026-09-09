import argparse
import hashlib
import json
import re
import sys
import xml.etree.ElementTree as xml
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
from rae2822_reference import load_reference, selig_coordinates


RAE_TIERS = {"fast": (84, 52, 40, 1500, 1e-4), "precise": (128, 80, 64, 3000, 1e-5), "refined": (256, 160, 128, 6000, 1e-5)}


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


def run(reference_directory, material_path, destination, tier, transonic=False, wall_functions=False, uniform_start=False):
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
    from airfoilfoam.postprocess.forces import parse_force_coefficients, parse_y_plus
    from airfoilfoam.postprocess.residuals import parse_convergence
    from airfoilfoam.thermodynamics import ThermodynamicState

    reference = load_reference(reference_directory)
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
                   "momentum_scheme": "linearUpwind", "turbulent_prandtl": 0.85, "n_iterations": dimensions[3],
                   "convergence_tolerance": dimensions[4], "write_images": []},
    })
    runner = get_runner(Settings())
    configure_flow_execution(runner, request)
    budgeted = BudgetedRunner(runner, 600)
    spec = request.cases()[0]
    budgeted.begin_case(spec)
    report = {"kind": "rae2822-transonic-pressure-validation", "tier": tier, "production_evidence": False,
              "accuracy_certified": False, "outcome": "failed", "reference": reference["provenance"],
              "experimental_transonic_pressure": transonic,
              "experimental_wall_functions": wall_functions,
              "velocity_initialization": "uniform-freestream" if uniform_start else "velocity-only-potential",
              "resolved_reynolds": density * speed * spec.chord / viscosity,
              "request": request.model_dump(mode="json")}
    try:
        airfoil = Airfoil.from_contour("RAE 2822", parse_airfoil(request.airfoil.coordinates))
        mesh = resolve_mesh_params(request.mesh, spec, request.fluid)
        mesher = BlockMeshCGrid()
        patches = mesher.patches(mesh)
        builder = _case_builder(budgeted, airfoil, patches, mesh, spec, request.fluid, request.roughness, request.solver)
        builder.write(destination)
        if transonic:
            configure_transonic_pressure(destination / "system/fvSolution")
        _set_control_dict_entries(destination / "system/controlDict", {"writeInterval": 100, "purgeWrite": 2})
        report["benchmark_output_policy"] = {"write_interval_iterations": 100, "retained_field_times": 2}
        mesher.write_inputs(destination, airfoil, mesh, spec.chord)
        meshed = budgeted.application(destination, "blockMesh", timeout=120)
        (destination / "log.blockMesh").write_text(meshed.stdout)
        meshed.check()
        warnings = []
        verdict = _run_transient_mesh_qa_gate(destination, budgeted, warnings)
        if verdict is None:
            raise ValueError("Mesh quality is unavailable")
        report["mesh_quality"] = asdict(verdict)
        report["mesh_warnings"] = warnings
        if not uniform_start:
            initialized = initialize_compressible_velocity(destination, budgeted, patches, dialect_for_runner(runner).potential_foam_command)
            (destination / "log.potentialFoam").write_text(initialized.stdout)
            initialized.check()
        solved = budgeted.solver(destination, "rhoSimpleFoam", 1, timeout=600)
        (destination / "log.rhoSimpleFoam").write_text(solved.stdout)
        check_material_domain(destination, solved)
        if not solved.timed_out:
            solved.check()
        report["budget_exhausted"] = solved.timed_out
        report["convergence"] = asdict(parse_convergence(solved.stdout))
        histories = find_force_coefficient_files(destination)
        if not histories:
            raise ValueError("No measured force coefficients")
        report["force_coefficients"] = asdict(parse_force_coefficients(histories[-1]))
        converted = runner.application(destination, "foamToVTK -latestTime -ascii -no-internal -patches '(airfoil)' -fields '(p)'", timeout=120)
        (destination / "log.foamToVTK").write_text(converted.stdout)
        converted.check()
        surfaces = list((destination / "VTK").rglob("airfoil.vtp"))
        if len(surfaces) != 1:
            raise ValueError(f"Expected one latest airfoil pressure surface, found {len(surfaces)}")
        report["pressure_iteration"] = pressure_iteration(surfaces[0])
        computed = wall_pressure(surfaces[0], spec.chord, state.pressure_pa, density, speed, reference["coordinates"])
        report["pressure_comparison"] = compare_pressure(computed, reference["pressure"])
        report["pressure_surface"] = {"path": str(surfaces[0].relative_to(destination)),
            "sha256": hashlib.sha256(surfaces[0].read_bytes()).hexdigest(), "samples": computed}
        wall_result = runner.application(destination, dialect_for_runner(runner).y_plus_command, timeout=120)
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
        report["outcome"] = "measured_converged" if report["convergence"]["converged"] else "measured_unconverged"
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        report["active_seconds"] = budgeted.consumed(spec)
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
    parser.add_argument("--wall-functions", action="store_true")
    parser.add_argument("--uniform-start", action="store_true")
    arguments = parser.parse_args()
    run(arguments.reference, arguments.material, arguments.destination, arguments.tier, arguments.transonic, arguments.wall_functions, arguments.uniform_start)
