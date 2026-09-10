import json
import math
from pathlib import Path
import re

from airfoilfoam.openfoam.foam_dict import write_foam_dict


def configure_local_time_pressure(directory, chord, speed):
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in (chord, speed)):
        raise ValueError("Local pressure time scale requires finite physical chord and speed")
    directory = Path(directory)
    schemes_path = directory / "system/fvSchemes"
    original = schemes_path.read_text()
    schemes, count = re.subn(r"(\bddtSchemes\s*\{\s*default\s+)steadyState(\s*;\s*\})", r"\g<1>localEuler\2", original)
    if count != 1 or "div(phi,h)" not in schemes:
        raise ValueError("Local pressure study requires the generated enthalpy steady schemes")
    schemes = schemes.replace("bounded Gauss upwind", "Gauss upwind")
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
