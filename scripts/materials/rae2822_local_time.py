import json
import hashlib
import math
from pathlib import Path
import re
import shutil
from dataclasses import asdict

from airfoilfoam.openfoam.foam_dict import Raw, _render_entries, write_foam_dict
from airfoilfoam.postprocess.residuals import parse_local_steady_convergence

try:
    from .rae2822_mapping import authenticated_retained_source
except ImportError:
    from rae2822_mapping import authenticated_retained_source


def continuation_end_iteration(start, allowance, requested=None, research_allowance=None):
    if type(start) is not int or type(allowance) is not int or start <= 0 or allowance <= 0:
        raise ValueError("Continuation needs a positive exact start and iteration allowance")
    if research_allowance is not None:
        if type(research_allowance) is not int or not 1 <= research_allowance <= 30000:
            raise ValueError("Explicit research allowance must be an integer from1through30000")
        allowance = research_allowance
    target = start + allowance if requested is None else requested
    if type(target) is not int or not start < target <= start + allowance:
        raise ValueError("Continuation target must advance within its iteration allowance")
    return target


def attach_pressure_steady_detector(directory, references, tolerance, energy_field="h"):
    required = {"referenceDensity", "referenceSpeed", "referenceLength", "referenceSpecificEnergy",
                "referenceTurbulenceEnergy", "referenceTurbulenceFrequency"}
    if set(references) != required or energy_field not in {"h", "e"}:
        raise ValueError("Pressure detector requires exact physical references and energy field")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0
           for value in [*references.values(), tolerance]):
        raise ValueError("Pressure detector references and tolerance must be finite and positive")
    path = Path(directory) / "system/controlDict"
    original = path.read_text()
    matches = list(re.finditer(r"\bfunctions\s*\{", original))
    if len(matches) != 1 or re.search(r"\bpressureSteadyConvergence\b", original):
        raise ValueError("Pressure detector requires one fresh function-object dictionary")
    config = {"type": "xfoilfoamSteadyConvergence",
              "libs": [Raw('"/opt/xfoilfoam-thermophysics/lib/libxfoilfoamSteadyConvergence.so"')],
              "executeControl": "timeStep", "executeInterval": 1, "conservedFields": "primitive", "energyField": energy_field,
              **references, "tolerance": tolerance, "consecutiveSteps": 100}
    body = "\n" + "\n".join(_render_entries({"pressureSteadyConvergence": config}, 4)) + "\n"
    position = matches[0].end()
    path.write_text(original[:position] + body + original[position:])
    return {"conserved_fields": "primitive", "energy_field": energy_field, "references": references,
            "tolerance": tolerance, "consecutive_steps": 100, "force_window_samples": 200}


def pressure_steady_convergence(log, tolerance, force_stable, stability, energy_field="h"):
    if type(force_stable) is not bool or energy_field not in {"h", "e"}:
        raise ValueError("Pressure convergence requires an observed force-window verdict")
    sources = {tuple(line.split()[1:]) for line in log.splitlines() if line.startswith("XFOILFOAM_LOCAL_STEADY_FIELD_SOURCE ")}
    if sources != {("primitive", energy_field)}:
        raise ValueError("Native primitive-field capability is not proven")
    rates = parse_local_steady_convergence(log, tolerance)
    clear = (stability.get("available") is True and type(stability.get("window_iterations")) is int
             and stability["window_iterations"] >= 200 and type(stability.get("pressure_limited_iterations")) is int
             and stability["pressure_limited_iterations"] == 0)
    return {**asdict(rates), "converged": rates.converged and force_stable and clear,
            "native_rate_certificate": rates.converged, "force_window_stable": force_stable, "pressure_window_clear": clear,
            "interpretation": "native_local_iteration_rates_and_force_window"}


def attach_pressure_energy_output(directory):
    path = Path(directory) / "system/controlDict"
    original = path.read_text()
    matches = list(re.finditer(r"\bfunctions\s*\{", original))
    if len(matches) != 1 or re.search(r"\bpressureEnergySnapshots\b", original):
        raise ValueError("Energy snapshots require one fresh function-object dictionary")
    config = {"type": "writeObjects", "libs": [Raw('"libutilityFunctionObjects.so"')],
              "objects": ["h"], "writeOption": "anyWrite", "writeControl": "timeStep", "writeInterval": 1}
    body = "\n" + "\n".join(_render_entries({"pressureEnergySnapshots": config}, 4)) + "\n"
    position = matches[0].end()
    path.write_text(original[:position] + body + original[position:])


def configure_low_re_k_wall(directory):
    path = Path(directory) / "0/k"
    original = path.read_text()
    patches = list(re.finditer(r"\bairfoil\s*\{([^{}]*)\}", original))
    if len(patches) != 1:
        raise ValueError("Low-Re k study requires one exact airfoil boundary")
    patch = patches[0]
    changed, count = re.subn(r"\btype\s+kqRWallFunction\s*;", "type kLowReWallFunction;", patch[1])
    if count != 1:
        raise ValueError("Low-Re k study requires the original zero-gradient wrapper")
    path.write_text(original[:patch.start(1)] + changed + original[patch.end(1):])


def normalized_continuation_control(text, start_from, end_iteration):
    if start_from not in {"startTime", "latestTime"} or type(end_iteration) is not int or end_iteration <= 0:
        raise ValueError("Invalid recorded continuation control window")
    for key, expected in (("startFrom", start_from), ("endTime", str(end_iteration))):
        matches = list(re.finditer(rf"(?m)^({key}[ \t]+)([^;\n]+)(;[ \t]*)$", text))
        if len(matches) != 1 or matches[0][2].strip() != expected:
            raise ValueError("Continuation control window differs from its recorded allocation")
        match = matches[0]
        text = text[:match.start(2)] + f"<{key}>" + text[match.end(2):]
    return text


def continuation_controls_match(source_text, target_text, report, request):
    if source_text == target_text:
        return True
    previous = report.get("experimental_continuation")
    if not isinstance(previous, dict) or previous.get("kind") != "uncertified_local_iteration_continuation":
        return False
    original_limit = request["solver"]["n_iterations"]
    source_limit = report.get("continuation_target_iteration")
    return normalized_continuation_control(source_text, "latestTime", source_limit) == normalized_continuation_control(target_text, "startTime", original_limit)


def limit_sst_gradients(directory):
    path = Path(directory) / "system/fvSchemes"
    original = path.read_text()
    blocks = list(re.finditer(r"\bgradSchemes\s*\{([^{}]*)\}", original))
    if len(blocks) != 1:
        raise ValueError("SST gradient study requires one gradient dictionary")
    block = blocks[0]
    if (not re.search(r"\blimited\s+cellLimited Gauss linear 1\s*;", block[1])
            or not re.search(r"\bgrad\(U\)\s+\$limited\s*;", block[1])
            or re.search(r"\bgrad\((?:k|omega)\)", block[1])):
        raise ValueError("SST gradient study requires the original velocity-only limiter")
    additions = "\n    grad(k)         $limited;\n    grad(omega)     $limited;\n"
    updated = original[:block.end(1)] + additions + original[block.end(1):]
    path.write_text(updated)
    return {"before_sha256": hashlib.sha256(original.encode()).hexdigest(), "after_sha256": hashlib.sha256(updated.encode()).hexdigest(),
            "fields": ["k", "omega"], "scheme": "cellLimited Gauss linear 1", "acceptance_threshold_changed": False}


def tighten_pressure_inner_solves(directory):
    path = Path(directory) / "system/fvSolution"
    original = path.read_text()
    changed, absolute = re.subn(r"\btolerance\s+(?:1e-07|1e-08)\s*;", "tolerance 1e-12;", original)
    changed, relative = re.subn(r"\brelTol\s+(?:0\.01|0)\s*;", "relTol 0;", changed)
    if absolute != 4 or relative != 4:
        raise ValueError("Tighter inner solves require four original pressure/transport solver entries")
    path.write_text(changed)
    return {"before_sha256": hashlib.sha256(original.encode()).hexdigest(), "after_sha256": hashlib.sha256(changed.encode()).hexdigest(),
            "absolute_tolerance": 1e-12, "relative_tolerance": 0, "acceptance_threshold_changed": False}


def restore_local_pressure_state(source, destination, request, execution):
    destination = Path(destination).resolve()
    source = Path(source).resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Experimental continuation needs separate source and target")
    source, manifest_bytes, manifest, verified, report = authenticated_retained_source(source)
    coordinate = report.get("pressure_iteration")
    active = report.get("active_seconds")
    if (report.get("outcome") != "measured_uncertified" or report.get("error") is not None
            or report.get("experimental_low_re_k_wall", False) is not False
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
        if name not in verified:
            raise ValueError("Experimental continuation dictionaries differ")
        if name == "system/controlDict":
            matches = continuation_controls_match((source / name).read_text(), (destination / name).read_text(), report, request)
        else:
            matches = hashlib.sha256((destination / name).read_bytes()).hexdigest() == verified[name]
        if not matches:
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


def configure_local_time_pressure(directory, chord, speed, pressure_advection="upwind", maximum_courant=0.5, step_smoothing=0.02):
    if step_smoothing not in (0.02, 0.2):
        raise ValueError("Local pressure smoothing study supports only0.02and0.2")
    if maximum_courant not in (0.5, 0.8):
        raise ValueError("Local pressure Courant study supports only0.5and0.8")
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
                   "pMinFactor": 0.1, "pMaxFactor": 2, "maxCo": maximum_courant, "maxDeltaT": chord / speed,
                   "rDeltaTSmoothingCoeff": step_smoothing, "rDeltaTDampingCoeff": 0.2},
        "relaxationFactors": {"fields": {"p": 0.3}, "equations": {"p": 1, "pFinal": 1, "U": 0.7, "h": 0.7, "k": 0.5, "omega": 0.5}},
    }
    write_foam_dict(directory / "system/fvSolution", "dictionary", "fvSolution", solution)
    schemes_path.write_text(schemes)
    execution = {"version": 1, "solver_family": "rhoPimpleFoam", "time_coordinate": "local_pseudo_time_iterations",
                 "physical_time_history": False, "steady_acceptance_certificate": "unavailable_experimental",
                 "local_max_courant": maximum_courant, "maximum_local_step_seconds": chord / speed}
    (directory / "constant/numericalExecution.json").write_text(json.dumps(execution, allow_nan=False) + "\n")
    return execution
