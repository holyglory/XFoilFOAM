import argparse
import hashlib
import json
import math
import re
import shutil
import sys
from dataclasses import asdict
from pathlib import Path
from uuid import uuid4

from airfoilfoam.config import Settings
from airfoilfoam.openfoam.foam_dict import Raw, dimensions, write_foam_dict
from airfoilfoam.openfoam.runner import get_runner

sys.path.insert(0, str(Path(__file__).parent))
from oblique_shock import NASA_WEDGE_REFERENCE, weak_oblique_shock


REFERENCE_MACH = 2.5
REFERENCE_ANGLE = 15.0
REFERENCE_GAMMA = 1.4
REFERENCE_GAS_CONSTANT = 287.05
REFERENCE_PRESSURE = 14.7 * 6894.757293168
REFERENCE_TEMPERATURE = 520.0 * 5 / 9
REFERENCE_LENGTH = 0.3048


def write_case(directory, cells, recipe, mach=REFERENCE_MACH, physical_time=False):
    if cells < 16 or cells > 256 or cells % 2:
        raise ValueError("The benchmark requires an even resolution from16 through256")
    if mach not in [2, 2.5, 3]:
        raise ValueError("This benchmark covers the declared Mach2,2.5,3 cases")
    reference = weak_oblique_shock(mach, REFERENCE_ANGLE, REFERENCE_GAMMA)
    speed = mach * math.sqrt(REFERENCE_GAMMA * REFERENCE_GAS_CONSTANT * REFERENCE_TEMPERATURE)
    length = REFERENCE_LENGTH
    height = max(length, 1.25 * length * math.tan(math.radians(reference.shock_angle_deg)))
    thickness = 0.01
    rise = length * math.tan(math.radians(REFERENCE_ANGLE))
    vertices = [(-length / 2, 0, 0), (0, 0, 0), (0, height, 0), (-length / 2, height, 0),
                (-length / 2, 0, thickness), (0, 0, thickness), (0, height, thickness), (-length / 2, height, thickness),
                (length, rise, 0), (length, height, 0), (length, rise, thickness), (length, height, thickness)]
    vertex_text = "(" + " ".join(f"({position[0]} {position[1]} {position[2]})" for position in vertices) + ")"
    boundary = """(
inlet { type patch; faces ((0 4 7 3)); }
farfield { type patch; faces ((3 7 6 2) (2 6 11 9)); }
outlet { type patch; faces ((8 9 11 10)); }
symmetry { type symmetryPlane; faces ((0 1 5 4)); }
wedge { type wall; faces ((1 8 10 5)); }
frontAndBack { type empty; faces ((0 3 2 1) (4 5 6 7) (1 2 9 8) (5 10 11 6)); }
)"""
    write_foam_dict(directory / "system/blockMeshDict", "dictionary", "blockMeshDict", {
        "scale": 1, "vertices": Raw(vertex_text),
        "blocks": Raw(f"(hex (0 1 2 3 4 5 6 7) ({cells // 2} {cells} 1) simpleGrading (1 1 1) hex (1 8 9 2 5 10 11 6) ({cells} {cells} 1) simpleGrading (1 1 1))"),
        "edges": [], "boundary": Raw(boundary), "mergePatchPairs": [],
    })
    probes = [(-0.1, 0.1, thickness / 2)] + [
        (position, position * (math.tan(math.radians(REFERENCE_ANGLE)) + math.tan(math.radians(reference.shock_angle_deg))) / 2, thickness / 2)
        for position in [0.12, 0.2, 0.28]
    ] + [(0.15, 0.27, thickness / 2)]
    write_foam_dict(directory / "system/controlDict", "dictionary", "controlDict", {
        "application": "rhoCentralFoam", "startFrom": "startTime", "startTime": 0,
        "stopAt": "endTime", "endTime": 10 * length / speed if physical_time else 3000,
        "deltaT": 1e-8 if physical_time else 1,
        "adjustTimeStep": "yes" if physical_time else "no", "maxCo": 0.49 if physical_time else 0.5, "maxDeltaT": length / speed,
        "rDeltaTSmoothingCoeff": 0.02, "writeControl": "timeStep", "writeInterval": 1000,
        "purgeWrite": 2, "writeFormat": "ascii", "writePrecision": 12,
        "runTimeModifiable": "false",
        "functions": {"shockProbes": {
            "type": "probes", "libs": [Raw('"libsampling.so"')], "writeControl": "timeStep", "writeInterval": 10,
            "fields": ["p", "rho", "T", "U"],
            "probeLocations": Raw("(" + " ".join(f"({point[0]} {point[1]} {point[2]})" for point in probes) + ")"),
        }},
    })
    for name in ["fvSchemes", "fvSolution"]:
        source = Path(recipe) / name
        provenance = json.loads((Path(recipe) / "provenance.json").read_text())
        if provenance.get("kind") != "application-generated-numerical-recipe" or hashlib.sha256(source.read_bytes()).hexdigest() != provenance.get("files", {}).get(name):
            raise ValueError("The captured numerical recipe checksum is invalid")
        content = source.read_text()
        if "#" in content or (name == "fvSchemes" and not all(value in content for value in ["localEuler", "Kurganov", "upwind"])):
            raise ValueError("The benchmark requires the captured application local-time/upwind recipe")
        if physical_time and name == "fvSchemes":
            (directory / "system" / name).write_text(content.replace("localEuler", "Euler"))
        else:
            shutil.copyfile(source, directory / "system" / name)
    write_foam_dict(directory / "constant/thermophysicalProperties", "dictionary", "thermophysicalProperties", {
        "thermoType": {"type": "hePsiThermo", "mixture": "pureMixture", "transport": "const", "thermo": "hConst",
                       "equationOfState": "perfectGas", "specie": "specie", "energy": "sensibleInternalEnergy"},
        "mixture": {"specie": {"molWeight": 8314.47006650545 / REFERENCE_GAS_CONSTANT},
                    "thermodynamics": {"Cp": REFERENCE_GAMMA * REFERENCE_GAS_CONSTANT / (REFERENCE_GAMMA - 1), "Hf": 0},
                    "transport": {"mu": 0, "Pr": 0.71}},
    })
    write_foam_dict(directory / "constant/turbulenceProperties", "dictionary", "turbulenceProperties", {"simulationType": "laminar"})
    for name, value, dims in [("p", REFERENCE_PRESSURE, dimensions(1, -1, -2, 0, 0, 0, 0)),
                              ("T", REFERENCE_TEMPERATURE, dimensions(0, 0, 0, 1, 0, 0, 0)),
                              ("U", f"({speed} 0 0)", dimensions(0, 1, -1, 0, 0, 0, 0))]:
        uniform = Raw(f"uniform {value}")
        write_foam_dict(directory / "0" / name, "volVectorField" if name == "U" else "volScalarField", name, {
            "dimensions": dims, "internalField": uniform,
            "boundaryField": {
                "inlet": {"type": "fixedValue", "value": uniform}, "farfield": {"type": "fixedValue", "value": uniform},
                "outlet": {"type": "zeroGradient"}, "symmetry": {"type": "symmetryPlane"},
                "wedge": {"type": "slip" if name == "U" else "zeroGradient"}, "frontAndBack": {"type": "empty"},
            },
        })
    return reference, probes


def read_probe_rows(path, width):
    rows = []
    for line in Path(path).read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        values = [float(value) for value in re.findall(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?", line)]
        if len(values) != width + 1 or not all(math.isfinite(value) for value in values):
            raise ValueError("Malformed or unavailable native probe values")
        if rows and values[0] <= rows[-1][0]:
            raise ValueError("Probe iteration coordinates are not strictly increasing")
        rows.append(values)
    if len(rows) < 30:
        raise ValueError("Insufficient saved probe history for stationarity checking")
    return rows


def compare_properties(observed, reference, relative_tolerance=0.03):
    expected = {"pressure_ratio": reference.pressure_ratio, "density_ratio": reference.density_ratio,
                "temperature_ratio": reference.temperature_ratio, "mach_downstream": reference.mach_downstream}
    if set(observed) != set(expected):
        raise ValueError("Missing or unexpected physical comparison channels")
    errors = {}
    for name, target in expected.items():
        values = observed[name]
        if len(values) != 3 or any(not math.isfinite(value) or value <= 0 for value in values):
            raise ValueError("Expected three real finite downstream probe values")
        errors[name] = max(abs(value / target - 1) for value in values)
    return {"relative_errors": errors, "passed": max(errors.values()) <= relative_tolerance, "tolerance": relative_tolerance}


def conservation_errors(pressure_ratio, density_ratio, temperature_ratio, velocity, reference):
    if len(velocity) != 3 or any(not math.isfinite(value) for value in velocity):
        raise ValueError("The conservation check requires a finite velocity vector")
    if any(not math.isfinite(value) or value <= 0 for value in [pressure_ratio, density_ratio, temperature_ratio]):
        raise ValueError("The conservation check requires positive physical ratios")
    upstream_density = REFERENCE_PRESSURE / (REFERENCE_GAS_CONSTANT * REFERENCE_TEMPERATURE)
    upstream_speed = reference.mach_upstream * math.sqrt(reference.gamma * REFERENCE_GAS_CONSTANT * REFERENCE_TEMPERATURE)
    beta = math.radians(reference.shock_angle_deg)
    upstream_normal = upstream_speed * math.sin(beta)
    downstream_normal = velocity[0] * math.sin(beta) - velocity[1] * math.cos(beta)
    heat_capacity = reference.gamma * REFERENCE_GAS_CONSTANT / (reference.gamma - 1)
    return {
        "normal_mass": abs(density_ratio * downstream_normal / upstream_normal - 1),
        "normal_momentum": abs((pressure_ratio * REFERENCE_PRESSURE + density_ratio * upstream_density * downstream_normal ** 2)
                               / (REFERENCE_PRESSURE + upstream_density * upstream_normal ** 2) - 1),
        "total_energy": abs((heat_capacity * REFERENCE_TEMPERATURE * temperature_ratio + sum(value ** 2 for value in velocity) / 2)
                            / (heat_capacity * REFERENCE_TEMPERATURE + upstream_speed ** 2 / 2) - 1),
        "direction_degrees": abs(math.degrees(math.atan2(velocity[1], velocity[0])) - reference.deflection_deg),
        "out_of_plane": abs(velocity[2]) / upstream_speed,
        "entropy_change_over_R": math.log(pressure_ratio) - reference.gamma * math.log(density_ratio),
    }


def analyze_case(directory, reference, coordinate_kind="iteration"):
    if coordinate_kind not in ["iteration", "physical_time"]:
        raise ValueError("Unknown numerical time coordinate")
    folder = directory / "postProcessing/shockProbes/0"
    histories = {name: read_probe_rows(folder / name, 15 if name == "U" else 5) for name in ["p", "rho", "T", "U"]}
    coordinates = [row[0] for row in histories["p"]]
    if any([row[0] for row in rows] != coordinates for rows in histories.values()):
        raise ValueError("Native field probes do not share the same saved iterations")
    means = {name: [sum(row[column] for row in rows[-20:]) / 20 for column in range(1, len(rows[-1]))] for name, rows in histories.items()}
    upstream_density = REFERENCE_PRESSURE / (REFERENCE_GAS_CONSTANT * REFERENCE_TEMPERATURE)
    observed = {"pressure_ratio": [], "density_ratio": [], "temperature_ratio": [], "mach_downstream": []}
    conservation = []
    for probe in [1, 2, 3]:
        observed["pressure_ratio"].append(means["p"][probe] / REFERENCE_PRESSURE)
        observed["density_ratio"].append(means["rho"][probe] / upstream_density)
        observed["temperature_ratio"].append(means["T"][probe] / REFERENCE_TEMPERATURE)
        velocity = math.sqrt(sum(value ** 2 for value in means["U"][3 * probe:3 * probe + 3]))
        observed["mach_downstream"].append(velocity / math.sqrt(REFERENCE_GAMMA * REFERENCE_GAS_CONSTANT * means["T"][probe]))
        conservation.append(conservation_errors(observed["pressure_ratio"][-1], observed["density_ratio"][-1],
            observed["temperature_ratio"][-1], means["U"][3 * probe:3 * probe + 3], reference))
    stability = max((max(row[probe + 1] for row in histories["p"][-20:]) - min(row[probe + 1] for row in histories["p"][-20:])) / REFERENCE_PRESSURE for probe in [1, 2, 3])
    comparison = compare_properties(observed, reference)
    upstream_error = max(abs(means["p"][probe] / REFERENCE_PRESSURE - 1) for probe in [0, 4])
    scales = {"p": REFERENCE_PRESSURE, "rho": upstream_density, "T": REFERENCE_TEMPERATURE,
              "U": reference.mach_upstream * math.sqrt(reference.gamma * REFERENCE_GAS_CONSTANT * REFERENCE_TEMPERATURE)}
    variations = {}
    for name, rows in histories.items():
        columns = [probe * 3 + axis + 1 for probe in [1, 2, 3] for axis in range(3)] if name == "U" else [2, 3, 4]
        variations[name] = max((max(row[column] for row in rows[-20:]) - min(row[column] for row in rows[-20:])) / scales[name] for column in columns)
    conserved = all(max(row[name] for name in ["normal_mass", "normal_momentum", "total_energy"]) <= 0.03
                    and row["direction_degrees"] <= 1 and row["out_of_plane"] <= 1e-6
                    and row["entropy_change_over_R"] > 0 for row in conservation)
    return {**comparison, "observed": observed, "pressure_window_variation": stability, "upstream_pressure_error": upstream_error,
            "conservation": conservation, "field_window_variation": variations,
            "last_coordinate": coordinates[-1], "coordinate_kind": coordinate_kind,
            "passed": comparison["passed"] and conserved and max(variations.values()) < 0.005 and upstream_error < 0.005}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--recipe", type=Path, required=True)
    parser.add_argument("--cells", type=int, default=64)
    parser.add_argument("--mach", type=float, choices=[2, 2.5, 3], default=2.5)
    parser.add_argument("--physical-time", action="store_true")
    args = parser.parse_args()
    directory = args.destination / str(uuid4())
    directory.mkdir(parents=True, exist_ok=False)
    report = {"kind": "inviscid-oblique-shock-verification", "source": NASA_WEDGE_REFERENCE,
              "cells_parameter": args.cells, "mach": args.mach,
              "reference_kind": "NASA tabulated case" if args.mach == 2.5 else "NASA shock-equation extension",
              "coordinate_kind": "physical_time" if args.physical_time else "iteration",
              "target_courant": 0.49 if args.physical_time else 0.5, "measured_courant_ceiling": 0.5,
              "airfoil_polar_validation": False, "outcome": "failed"}
    try:
        reference, probes = write_case(directory, args.cells, args.recipe, args.mach, args.physical_time)
        report["analytic_reference"] = asdict(reference)
        report["probes"] = probes
        runner = get_runner(Settings())
        for command, timeout in [("blockMesh", 30), ("checkMesh", 30), ("rhoCentralFoam", 300)]:
            result = runner.application(directory, command, timeout=timeout)
            (directory / f"log.{command}").write_text(result.stdout)
            result.check()
        pattern = r"Mean and max Courant Numbers =\s+\S+\s+(\S+)" if args.physical_time else r"Courant Numbers:\s+min = \S+,\s+average = \S+,\s+max = (\S+)"
        courants = [float(value) for value in re.findall(pattern, result.stdout)]
        finite_courants = [value for value in courants if math.isfinite(value)]
        report["maximum_courant"] = max(finite_courants) if finite_courants else None
        report["courant_sample_count"] = len(courants)
        report["courant_valid"] = bool(courants) and all(math.isfinite(value) and 0 <= value <= 0.5 * (1 + 1e-5) for value in courants)
        report["comparison"] = analyze_case(directory, reference, report["coordinate_kind"])
        if not report["courant_valid"]:
            raise RuntimeError("The native run did not preserve the declared Courant ceiling")
        if not report["comparison"]["passed"]:
            raise RuntimeError("Computed shock properties or stationarity miss the declared verification thresholds")
        report["outcome"] = "passed"
    except Exception as error:
        report["error"] = str(error)
        raise
    finally:
        (directory / "report.json").write_text(json.dumps(report, allow_nan=False) + "\n")
        print(json.dumps({"kind": report["kind"], "outcome": report["outcome"], "report": str(directory / "report.json"),
                          "comparison": report.get("comparison"), "airfoil_polar_validation": False}), flush=True)


if __name__ == "__main__":
    main()
