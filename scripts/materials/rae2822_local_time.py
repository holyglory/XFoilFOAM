import json
import hashlib
import math
from pathlib import Path
import re
import shutil

from airfoilfoam.openfoam.foam_dict import write_foam_dict

try:
    from .rae2822_mapping import authenticated_retained_source
except ImportError:
    from rae2822_mapping import authenticated_retained_source


def continuation_end_iteration(start, allowance, requested=None):
    if type(start) is not int or type(allowance) is not int or start <= 0 or allowance <= 0:
        raise ValueError("Continuation needs a positive exact start and iteration allowance")
    target = start + allowance if requested is None else requested
    if type(target) is not int or not start < target <= start + allowance:
        raise ValueError("Continuation target must advance within its iteration allowance")
    return target


def restore_local_pressure_state(source, destination, request, execution):
    destination = Path(destination).resolve()
    source = Path(source).resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Experimental continuation needs separate source and target")
    source, manifest_bytes, manifest, verified, report = authenticated_retained_source(source)
    coordinate = report.get("pressure_iteration")
    active = report.get("active_seconds")
    if (report.get("outcome") != "measured_uncertified" or report.get("error") is not None
            or report.get("actual_execution") != execution or report.get("request") != request
            or report.get("experimental_local_time_pressure") is not True
            or report.get("numerical_stability", {}).get("pressure_limited_iterations") != 0):
        raise ValueError("Experimental continuation source is failed or incompatible")
    if (isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)) or not math.isfinite(coordinate)
            or coordinate <= 0 or not float(coordinate).is_integer() or isinstance(active, bool)
            or not isinstance(active, (int, float)) or not math.isfinite(active) or active <= 0):
        raise ValueError("Experimental continuation has no exact coordinate or measured cost")
    coordinate = int(coordinate)
    previous_cost = report.get("accumulated_active_seconds", active)
    if isinstance(previous_cost, bool) or not isinstance(previous_cost, (int, float)) or not math.isfinite(previous_cost) or previous_cost < active:
        raise ValueError("Experimental continuation accumulated cost is invalid")
    for name in ("system/fvSchemes", "system/fvSolution", "system/controlDict", "constant/thermophysicalProperties", "constant/turbulenceProperties", "constant/numericalExecution.json"):
        if name not in verified or hashlib.sha256((destination / name).read_bytes()).hexdigest() != verified[name]:
            raise ValueError("Experimental continuation dictionaries differ")
    time_name = str(coordinate)
    required = [f"{time_name}/{name}" for name in ("U", "p", "T", "k", "omega", "rho", "phi", "rDeltaT")]
    required += [f"constant/polyMesh/{name}" for name in ("points", "faces", "owner", "neighbour", "boundary")]
    if any(name not in verified for name in required):
        raise ValueError("Experimental continuation is missing authenticated state")
    trees = ("constant/polyMesh", time_name)
    if any((destination / name).exists() for name in trees):
        raise ValueError("Experimental continuation target is occupied")
    copied = {name: signature for name, signature in verified.items() if any(name.startswith(tree + "/") for tree in trees)}
    for tree in trees:
        paths = list((source / tree).rglob("*"))
        if any(path.is_symlink() for path in paths):
            raise ValueError("Experimental continuation tree contains a symbolic link")
        actual = {str(path.relative_to(source)) for path in paths if path.is_file()}
        if actual != {name for name in copied if name.startswith(tree + "/")}:
            raise ValueError("Experimental continuation tree has unauthenticated members")
    for tree in trees:
        shutil.copytree(source / tree, destination / tree)
    if any(hashlib.sha256((destination / name).read_bytes()).hexdigest() != signature for name, signature in copied.items()):
        raise ValueError("Experimental continuation copied state differs")
    if authenticated_retained_source(source)[1] != manifest_bytes:
        raise ValueError("Experimental continuation source manifest changed")
    return {"kind": "uncertified_local_iteration_continuation", "source": str(source), "coordinate": coordinate,
            "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(), "source_revision": manifest.get("sourceRevision"),
            "report_sha256": verified["report.json"], "prior_active_seconds": previous_cost, "members": copied}


def configure_local_time_pressure(directory, chord, speed, pressure_advection="upwind"):
    if pressure_advection not in ("upwind", "vanLeer"):
        raise ValueError("Unsupported experimental pressure-advection scheme")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in (chord, speed)):
        raise ValueError("Local pressure time scale requires finite physical chord and speed")
    directory = Path(directory)
    schemes_path = directory / "system/fvSchemes"
    original = schemes_path.read_text()
    schemes, count = re.subn(r"(\bddtSchemes\s*\{\s*default\s+)steadyState(\s*;\s*\})", r"\g<1>localEuler\2", original)
    if count != 1 or "div(phi,h)" not in schemes:
        raise ValueError("Local pressure study requires the generated enthalpy steady schemes")
    schemes, count = re.subn(r"(div\(phid,p\)\s+)Gauss upwind(\s*;)",
                             lambda match: f"{match[1]}Gauss {pressure_advection}{match[2]}", schemes)
    if count != 1:
        raise ValueError("Expected one generated pressure-advection entry")
    schemes = schemes.replace("bounded Gauss upwind", "Gauss upwind")
    schemes = schemes.replace("bounded Gauss linearUpwind limited", "Gauss linearUpwind limited")
    pressure = {"solver": "GAMG", "smoother": "GaussSeidel", "tolerance": 1e-7, "relTol": 0.01}
    transport = {"solver": "PBiCGStab", "preconditioner": "DILU", "tolerance": 1e-8, "relTol": 0.01}
    solution = {
        "solvers": {"p": pressure, "pFinal": {**pressure, "relTol": 0},
                    "rho": {"solver": "diagonal"}, "rhoFinal": {"solver": "diagonal"},
                    '"(U|h|k|omega)"': transport, '"(U|h|k|omega)Final"': {**transport, "relTol": 0}},
        "PIMPLE": {"momentumPredictor": "yes", "nOuterCorrectors": 3, "nCorrectors": 2,
                   "nNonOrthogonalCorrectors": 1, "transonic": "yes", "consistent": "no",
                   "pMinFactor": 0.1, "pMaxFactor": 2, "maxCo": 0.5, "maxDeltaT": chord / speed,
                   "rDeltaTSmoothingCoeff": 0.02, "rDeltaTDampingCoeff": 0.2},
        "relaxationFactors": {"fields": {"p": 0.3}, "equations": {"p": 1, "pFinal": 1, "U": 0.7, "h": 0.7, "k": 0.5, "omega": 0.5}},
    }
    write_foam_dict(directory / "system/fvSolution", "dictionary", "fvSolution", solution)
    schemes_path.write_text(schemes)
    execution = {"version": 1, "solver_family": "rhoPimpleFoam", "time_coordinate": "local_pseudo_time_iterations",
                 "physical_time_history": False, "steady_acceptance_certificate": "unavailable_experimental",
                 "local_max_courant": 0.5, "maximum_local_step_seconds": chord / speed}
    (directory / "constant/numericalExecution.json").write_text(json.dumps(execution, allow_nan=False) + "\n")
    return execution
