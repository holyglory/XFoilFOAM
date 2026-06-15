"""Parse solver convergence/residual information from simpleFoam log output."""
from __future__ import annotations

import re
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
