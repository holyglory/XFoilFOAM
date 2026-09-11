from copy import copy
from dataclasses import asdict, replace
import hashlib
import json
import math
from pathlib import Path

from airfoilfoam.postprocess.residuals import parse_local_steady_convergence


def configure_density_reference(directory, builder):
    directory = Path(directory)
    if directory.is_symlink() or any((directory / name).is_symlink() for name in ("0", "constant", "system")):
        raise ValueError("Density comparison cannot follow shared case links")
    if directory.resolve() != builder._case_dir.resolve():
        raise ValueError("Density reference must own the exact fresh case")
    mach = builder.spec.speed / builder.gas.speed_of_sound(builder.state)
    if not math.isfinite(mach) or not 0.3 <= mach < 1.2:
        raise ValueError("This isolated density comparison requires a transonic reference")
    if builder.solver_family != "rhoSimpleFoam" or builder.solver.force_transient:
        raise ValueError("Density comparison requires the original steady pressure reference")
    if any(path.name not in {"0", "constant", "system"} for path in directory.iterdir()):
        raise ValueError("Density comparison requires a fresh case before execution")
    identity_path = directory / "constant/numericalExecution.json"
    if json.loads(identity_path.read_text()).get("solver_family") != "rhoSimpleFoam":
        raise ValueError("Density comparison cannot replace an existing numerical experiment")
    protected = [*sorted((directory / "0").iterdir()), *sorted((directory / "constant").iterdir())]
    protected = [path for path in protected if path != identity_path]
    if not protected or any(not path.is_file() or path.is_symlink() for path in protected):
        raise ValueError("Density comparison requires complete untouched initial and material files")
    before = {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest() for path in protected}
    if "sensibleInternalEnergy" not in (directory / "constant/thermophysicalProperties").read_text():
        raise ValueError("Density reference requires the unchanged internal-energy gas model")
    experimental = copy(builder)
    experimental.solver_family = "rhoCentralFoam"
    experimental.local_steady = True
    experimental.dialect = replace(builder.dialect, steady_solver_command="rhoCentralFoam",
                                   control_solver_value_steady="rhoCentralFoam")
    experimental._write_system(experimental._turbulence())
    experimental._write_numerical_execution()
    after = {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest() for path in protected}
    if before != after:
        raise ValueError("Density comparison changed the protected physical reference")
    execution = json.loads(identity_path.read_text())
    execution.update({"experiment": "rae2822-transonic-density-v1", "production_admission": False,
                      "flux_scheme": "Kurganov",
                      "reconstruction_schemes": {field: "upwind" if builder.solver.momentum_scheme == "upwind" else scheme
                                                 for field, scheme in (("rho", "vanLeer"), ("U", "vanLeerV"), ("T", "vanLeer"))},
                      "preserved_physical_files": before, "mach": mach,
                      "boundary_recipe": "unchanged-transonic-freestream",
                      "steady_acceptance_certificate": "native_v2_stored_rates_with_force_window"})
    identity_path.write_text(json.dumps(execution, sort_keys=True, allow_nan=False) + "\n")
    return execution


def density_reference_convergence(log, tolerance, force_stable):
    if type(force_stable) is not bool:
        raise ValueError("Density convergence requires a measured force-window verdict")
    rates = parse_local_steady_convergence(log, tolerance)
    return {**asdict(rates), "converged": rates.converged and force_stable,
            "native_rate_certificate": rates.converged, "force_window_stable": force_stable,
            "interpretation": "native_density_rates_and_force_window"}
