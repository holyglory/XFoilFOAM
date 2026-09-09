from __future__ import annotations

import json
import math
import os
import re
import stat
import tempfile
from dataclasses import replace
from pathlib import Path
from uuid import uuid4

from ..material_domain import check_material_domain
from ..postprocess.forces import RANS_HOLD_REQUIRED_SAMPLES, analyze_rans_hold
from ..postprocess.residuals import parse_convergence
from .budget import BudgetedRunner
from .dialects import dialect_for_runner, find_force_coefficient_files
from .runner import InfrastructureError


HOLD_MARKER = "XFOILFOAM_RANS_HOLD_CONTINUATION"


def atomic_dictionary(path, text):
    path = Path(path)
    mode = stat.S_IMODE(path.stat().st_mode)
    descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.hold-")
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def root_entry(text, name, value=None):
    pattern = rf"(?m)^{re.escape(name)}[ \t]+([^;\r\n]+);"
    matches = list(re.finditer(pattern, text))
    if len(matches) != 1:
        raise InfrastructureError(f"RANS hold requires one generated root {name} entry")
    if value is None:
        return matches[0].group(1).strip()
    return re.sub(pattern, lambda _match: f"{name} {value};", text)


def hold_dictionaries(control, solution, end, steps):
    if not re.search(r"\bSIMPLE\s*\{", solution) or re.search(r"\bPIMPLE\s*\{", solution):
        raise InfrastructureError("RANS hold requires a steady SIMPLE dictionary")
    updated_solution, count = re.subn(r"\bresidualControl\s*\{[^{}]*\}", "residualControl {}", solution)
    if count != 1:
        raise InfrastructureError("RANS hold requires one flat generated residual control")
    updated_control = control
    for name, value in {"startFrom": "latestTime", "stopAt": "endTime", "endTime": end,
                        "writeControl": "runTime", "writeInterval": steps, "purgeWrite": 3}.items():
        updated_control = root_entry(updated_control, name, value)
    return updated_control, updated_solution


def latest_iteration(directory):
    values = []
    for child in Path(directory).iterdir():
        if not child.is_dir():
            continue
        try:
            value = float(child.name)
        except ValueError:
            continue
        if math.isfinite(value) and value >= 0 and value.is_integer() and (child / "U").is_file():
            values.append(int(value))
    return max(values) if values else None


def complete_rans_hold(directory, result, runner, parameters, spec, n_proc, timeout, cancel_check=None):
    if not isinstance(runner, BudgetedRunner):
        return result
    family = dialect_for_runner(runner).steady_solver_command
    if (family not in {"simpleFoam", "rhoSimpleFoam"}
            or parameters.force_transient or not result.ok or not parse_convergence(result.stdout).converged):
        return result
    directory = Path(directory)
    check_material_domain(directory, result)
    coefficients = find_force_coefficient_files(directory)
    if not coefficients:
        return result
    analysis = analyze_rans_hold(coefficients[-1])
    if analysis is not None and analysis.certified:
        return result
    current = latest_iteration(directory)
    if current is None:
        return result
    control_path = directory / "system/controlDict"
    solution_path = directory / "system/fvSolution"
    control = control_path.read_text()
    solution = solution_path.read_text()
    maximum = float(root_entry(control, "endTime"))
    if not math.isfinite(maximum) or not maximum.is_integer() or maximum < current:
        raise InfrastructureError("RANS hold has no finite remaining iteration allocation")
    history = result.stdout
    try:
        while current < maximum:
            if cancel_check:
                cancel_check()
            limit = runner.limit(spec)
            consumed = runner.consumed(spec)
            if limit is None or consumed is None or consumed >= limit:
                break
            steps = min(RANS_HOLD_REQUIRED_SAMPLES, int(maximum) - current)
            if steps < RANS_HOLD_REQUIRED_SAMPLES:
                break
            updated_control, updated_solution = hold_dictionaries(control, solution, current + steps, steps)
            evidence = directory / "system/ransHold" / str(uuid4())
            evidence.mkdir(parents=True, exist_ok=False)
            (evidence / "controlDict").write_text(updated_control)
            (evidence / "fvSolution").write_text(updated_solution)
            request = {"version": 1, "kind": "bounded-rans-hold", "start_iteration": current,
                       "requested_end_iteration": current + steps, "maximum_iteration": int(maximum),
                       "aoa_deg": spec.aoa_deg, "speed": spec.speed, "chord": spec.chord}
            (evidence / "request.json").write_text(json.dumps(request, allow_nan=False) + "\n")
            atomic_dictionary(control_path, updated_control)
            atomic_dictionary(solution_path, updated_solution)
            if cancel_check:
                cancel_check()
            continued = runner.solver(directory, family, n_proc, timeout=min(timeout, limit - consumed), restart=True)
            (directory / f"log.ransHold.{evidence.name}").write_text(continued.stdout)
            history += f"\n{HOLD_MARKER} {json.dumps(request, allow_nan=False)}\n" + continued.stdout
            result = replace(continued, stdout=history)
            check_material_domain(directory, continued)
            if cancel_check:
                cancel_check()
            if not continued.ok:
                break
            reached = latest_iteration(directory)
            if reached != current + steps:
                raise InfrastructureError("RANS hold did not retain its exact bounded continuation fields")
            current = reached
            coefficients = find_force_coefficient_files(directory)
            analysis = analyze_rans_hold(coefficients[-1]) if coefficients else None
            if analysis is not None and analysis.certified:
                break
        return result
    finally:
        atomic_dictionary(control_path, control)
        atomic_dictionary(solution_path, solution)
