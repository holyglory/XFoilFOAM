from __future__ import annotations

from dataclasses import replace
import json
import math
from pathlib import Path
import time
from uuid import uuid4

from ..material_domain import check_material_domain
from ..postprocess.residuals import parse_local_steady_convergence
from .dialects import dialect_for_runner
from .rans_hold import atomic_dictionary, latest_iteration, root_entry
from .runner import InfrastructureError, RunResult


STARTUP_ITERATIONS = 50
STARTUP_COURANT = 0.25


def solve_cold_steady(directory, runner, parameters, n_proc, timeout, *, seeded=False, cancel_check=None):
    directory = Path(directory)
    family = dialect_for_runner(runner).steady_solver_command
    if seeded or family != "rhoCentralFoam" or parameters.force_transient:
        return runner.solver(directory, family, n_proc, timeout=timeout)
    control_path = directory / "system/controlDict"
    original = control_path.read_text()
    courant = float(root_entry(original, "maxCo"))
    if not math.isfinite(courant) or courant <= 0:
        raise InfrastructureError("Local steady startup requires a positive finite Courant limit")
    if courant <= STARTUP_COURANT:
        return runner.solver(directory, family, n_proc, timeout=timeout)
    maximum = float(root_entry(original, "endTime"))
    if (not math.isfinite(maximum) or not maximum.is_integer() or maximum != parameters.n_iterations
            or float(root_entry(original, "deltaT")) != 1 or float(root_entry(original, "startTime")) != 0
            or root_entry(original, "startFrom") != "startTime" or root_entry(original, "adjustTimeStep") != "no"
            or "localEuler" not in (directory / "system/fvSchemes").read_text()):
        raise InfrastructureError("Local steady startup requires the original bounded iteration clock")
    if not math.isfinite(timeout) or timeout <= 0:
        raise InfrastructureError("Local steady startup requires a positive finite time allocation")
    end = min(STARTUP_ITERATIONS, int(maximum))
    startup = original
    for name, value in {"maxCo": STARTUP_COURANT, "endTime": end, "writeControl": "timeStep",
                        "writeInterval": end}.items():
        startup = root_entry(startup, name, value)
    continuation = root_entry(original, "startFrom", "latestTime")
    evidence = directory / "system/localSteadyStartup" / str(uuid4())
    evidence.mkdir(parents=True, exist_ok=False)
    for name, content in (("original.controlDict", original), ("startup.controlDict", startup),
                          ("continuation.controlDict", continuation)):
        (evidence / name).write_text(content)
    request = {"version": 1, "kind": "bounded-local-steady-startup", "time_coordinate": "iteration",
               "start_iteration": 0, "startup_end_iteration": end, "maximum_iteration": int(maximum),
               "startup_courant": STARTUP_COURANT, "continuation_courant": courant,
               "maximum_seconds": timeout, "physical_time_history": False}
    (evidence / "request.json").write_text(json.dumps(request, allow_nan=False) + "\n")
    receipt = {"version": 1, "continuation_launched": False, "outcome": "incomplete"}
    started = time.monotonic()
    try:
        if cancel_check:
            cancel_check()
        atomic_dictionary(control_path, startup)
        result = runner.solver(directory, family, n_proc, timeout=timeout)
        (directory / f"log.localSteadyStartup.{evidence.name}").write_text(result.stdout)
        receipt.update(startup_returncode=result.returncode, startup_timed_out=result.timed_out)
        check_material_domain(directory, result)
        if cancel_check:
            cancel_check()
        if not result.ok:
            receipt["outcome"] = "startup_failed"
            return result
        converged = parse_local_steady_convergence(result.stdout, parameters.convergence_tolerance).converged
        if maximum == end or converged:
            receipt["outcome"] = "startup_finished_request"
            return result
        state = directory / str(end)
        required = ("U", "p", "T", "rho", "k", "omega", "nut", "alphat", "rDeltaT", "uniform/time")
        if latest_iteration(directory) != end or any(not (state / name).is_file() for name in required):
            raise InfrastructureError("Local steady startup did not retain its exact continuation fields")
        clock = (state / "uniform/time").read_text()
        if any(float(root_entry(clock, name)) != value for name, value in
               (("value", end), ("index", end), ("deltaT", 1), ("deltaT0", 1))):
            raise InfrastructureError("Local steady startup checkpoint changed the iteration clock")
        remaining = timeout - max(0.0, time.monotonic() - started)
        if remaining <= 0:
            receipt["outcome"] = "time_allocation_exhausted"
            return RunResult(family, 124, result.stdout + "\nLocal steady startup exhausted the original time allocation", timed_out=True)
        atomic_dictionary(control_path, continuation)
        if cancel_check:
            cancel_check()
        receipt["continuation_launched"] = True
        continued = runner.solver(directory, family, n_proc, timeout=remaining, restart=True)
        (directory / f"log.localSteadyContinuation.{evidence.name}").write_text(continued.stdout)
        receipt.update(continuation_returncode=continued.returncode, continuation_timed_out=continued.timed_out)
        check_material_domain(directory, continued)
        if cancel_check:
            cancel_check()
        receipt["outcome"] = "native_completion" if continued.ok else "continuation_failed"
        return replace(continued, stdout=result.stdout + "\nXFOILFOAM_LOCAL_STEADY_STARTUP "
                       + json.dumps(request, allow_nan=False) + "\n" + continued.stdout)
    finally:
        receipt["elapsed_seconds"] = max(0.0, time.monotonic() - started)
        try:
            (evidence / "receipt.json").write_text(json.dumps(receipt, allow_nan=False) + "\n")
        finally:
            atomic_dictionary(control_path, original)
