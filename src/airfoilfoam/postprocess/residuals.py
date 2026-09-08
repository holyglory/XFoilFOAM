"""Parse solver convergence/residual information from simpleFoam log output."""
from __future__ import annotations

import re
import json
import math
from collections import deque
from dataclasses import dataclass
from typing import Optional

_CONVERGED = re.compile(r"SIMPLE solution converged in (\d+) iterations")
_TIME = re.compile(r"^Time = (\d+)")
_INITIAL_RES = re.compile(r"Solving for (\w+), Initial residual = ([0-9.eE+-]+)")


@dataclass
class ConvergenceInfo:
    converged: bool
    iterations: Optional[int]
    final_residual: Optional[float]


def parse_convergence(log: str) -> ConvergenceInfo:
    converged = False
    iterations: Optional[int] = None
    last_time: Optional[int] = None
    residuals: dict[str, float] = {}

    for line in log.splitlines():
        m = _CONVERGED.search(line)
        if m:
            converged = True
            iterations = int(m.group(1))
        m = _TIME.match(line.strip())
        if m:
            last_time = int(m.group(1))
        m = _INITIAL_RES.search(line)
        if m:
            residuals[m.group(1)] = float(m.group(2))

    if iterations is None:
        iterations = last_time
    # Report the worst of the velocity/pressure initial residuals at the last step.
    candidates = [residuals[k] for k in ("p", "Ux", "Uy") if k in residuals]
    final_residual = max(candidates) if candidates else None
    return ConvergenceInfo(converged=converged, iterations=iterations, final_residual=final_residual)


def parse_local_steady_convergence(log: str, tolerance: float) -> ConvergenceInfo:
    if not math.isfinite(tolerance) or tolerance <= 0:
        raise ValueError("Local steady tolerance must be finite and positive")
    samples = deque(maxlen=100)
    certificate = None
    for line in log.splitlines():
        if line.startswith("XFOILFOAM_LOCAL_STEADY_RESIDUAL "):
            if certificate is not None:
                raise ValueError("Local steady execution continued after certification")
            fields = line.split()[1:]
            if len(fields) != 6:
                raise ValueError("Incomplete conserved-field residual sample")
            iteration = int(fields[0])
            values = [float(value) for value in fields[1:]]
            if iteration <= 0 or any(not math.isfinite(value) or value < 0 for value in values):
                raise ValueError("Invalid conserved-field residual sample")
            if samples and iteration != samples[-1][0] + 1:
                samples.clear()
            samples.append((iteration, max(values)))
        if line.startswith("XFOILFOAM_LOCAL_STEADY_CONVERGED "):
            if certificate is not None:
                raise ValueError("Duplicate local steady certificate")
            certificate = json.loads(line.split(" ", 1)[1])
    if certificate is None:
        return ConvergenceInfo(False, samples[-1][0] if samples else None, samples[-1][1] if samples else None)
    if not isinstance(certificate, dict) or certificate.get("version") != 2 or certificate.get("coordinate_kind") != "iteration":
        raise ValueError("Invalid local steady certificate")
    if any(type(certificate.get(key)) is not int for key in ("version", "iteration", "consecutive_steps")):
        raise ValueError("Local steady certificate requires exact integer counters")
    if len(samples) != 100 or certificate.get("iteration") != samples[-1][0] or certificate.get("consecutive_steps") != 100:
        raise ValueError("Local steady certificate has no sustained residual window")
    declared = certificate.get("tolerance")
    maximum = certificate.get("maximum_window_residual")
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in (declared, maximum)):
        raise ValueError("Nonfinite local steady certificate")
    observed = max(value for _, value in samples)
    if declared <= 0 or declared > tolerance * (1 + 1e-8) or maximum < 0 or maximum > declared or observed > declared or not math.isclose(observed, maximum, rel_tol=1e-5, abs_tol=1e-14):
        raise ValueError("Local steady residuals do not meet the requested tolerance")
    return ConvergenceInfo(True, samples[-1][0], observed)
