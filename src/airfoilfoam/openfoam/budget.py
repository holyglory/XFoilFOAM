"""Per-physical-case solver budgets shared by initialization and recovery calls."""

from __future__ import annotations

import math
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from ..models import CaseSolverBudget, SolverBudgetProgress, SolverCaseAllocation
from .runner import InfrastructureError, InsufficientMpiSlotsError, RunResult, Runner


@dataclass
class _CaseBudget:
    limit_seconds: float
    consumed: float = 0.0
    started_at: float | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)
    execution_lock: threading.Lock = field(default_factory=threading.Lock)


class BudgetedRunner(Runner):
    def __init__(self, inner: Runner, per_case_seconds: float | None = None,
                 *, case_allocations: list[SolverCaseAllocation] | None = None):
        if (per_case_seconds is None) == (case_allocations is None):
            raise ValueError("Specify one shared case budget or exact case allocations")
        if per_case_seconds is not None and (not math.isfinite(per_case_seconds) or not 0 < per_case_seconds <= 43200):
            raise ValueError("A solver case budget must be finite, positive and at most twelve hours")
        self._allocations: dict[tuple[float, float, float], float] | None = None
        if case_allocations is not None:
            if not 1 <= len(case_allocations) <= 512:
                raise ValueError("Expected between one and 512 solver case allocations")
            self._allocations = {}
            for value in case_allocations:
                allocation = SolverCaseAllocation.model_validate(value.model_dump())
                key = (allocation.chord, allocation.speed, allocation.aoa_deg)
                if key in self._allocations:
                    raise ValueError("Solver case allocations must have unique physical identities")
                self._allocations[key] = allocation.limit_seconds
        self.inner = inner
        self.settings = inner.settings
        self.external_paths_visible = inner.external_paths_visible
        self.per_case_seconds = per_case_seconds
        self._cases: dict[tuple[float, float, float], _CaseBudget] = {}
        self._cases_lock = threading.Lock()
        self._thread = threading.local()

    def __getattr__(self, name):
        return getattr(self.inner, name)

    def begin_case(self, spec) -> None:
        self._thread.current = None
        key = (float(spec.chord), float(spec.speed), float(spec.aoa_deg))
        if not all(math.isfinite(value) for value in key):
            raise ValueError("Solver budget identity requires a finite physical case")
        limit = self.per_case_seconds if self._allocations is None else self._allocations.get(key)
        if limit is None:
            raise InfrastructureError("Physical case has no exact solver budget allocation")
        with self._cases_lock:
            self._thread.current = self._cases.setdefault(key, _CaseBudget(limit_seconds=limit))

    def limit(self, spec) -> float | None:
        key = (float(spec.chord), float(spec.speed), float(spec.aoa_deg))
        with self._cases_lock:
            budget = self._cases.get(key)
        return budget.limit_seconds if budget is not None else None

    def consumed(self, spec) -> float | None:
        key = (float(spec.chord), float(spec.speed), float(spec.aoa_deg))
        with self._cases_lock:
            budget = self._cases.get(key)
        if budget is None:
            return None
        with budget.lock:
            return budget.consumed

    def snapshot(self) -> list[dict[str, float | bool]]:
        with self._cases_lock:
            cases = sorted(self._cases.items())
        snapshots = []
        for (chord, speed, alpha), budget in cases:
            with budget.lock:
                running = budget.started_at is not None
                active = budget.consumed + (max(0.0, time.monotonic() - budget.started_at) if running else 0.0)
                snapshots.append({"chord": chord, "speed": speed, "aoa_deg": alpha,
                                  "solver_active_seconds": active, "limit_seconds": budget.limit_seconds,
                                  "solver_running": running})
        return snapshots

    def run(self, case_dir, command, timeout=7200, monitor=None) -> RunResult:
        return self.inner.run(case_dir, command, timeout=timeout, monitor=monitor)

    def progress(self, job_id: str) -> SolverBudgetProgress:
        cases = self.snapshot()
        return SolverBudgetProgress(version=1, job_id=job_id, observed_at=datetime.now(timezone.utc), cases=cases)

    def solver(self, case_dir: Path, app: str, n_proc: int, timeout=7200, restart=False, monitor=None) -> RunResult:
        budget = getattr(self._thread, "current", None)
        if budget is None:
            raise InfrastructureError("Budgeted solver has no physical-case ownership")
        if not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("Solver invocation timeout must be finite and positive")
        with budget.execution_lock:
            with budget.lock:
                remaining = budget.limit_seconds - budget.consumed
            if remaining <= 0:
                return RunResult(app, 124, "Active solver budget exhausted; no new solver process was launched", timed_out=True)
            preparation = ""
            if n_proc > 1:
                available = int(self.settings.resolved_worker_cpu_budget())
                if n_proc > available:
                    raise InsufficientMpiSlotsError(requested=n_proc, available=available)
                command = "decomposePar -latestTime -force" if restart else "decomposePar -force"
                decomposed = self.inner.application(case_dir, command, timeout=timeout)
                if not decomposed.ok:
                    return decomposed
                preparation = decomposed.stdout
            started = time.monotonic()
            with budget.lock:
                budget.started_at = started
            try:
                if n_proc <= 1:
                    result = self.inner.solver(case_dir, app, n_proc, timeout=min(timeout, remaining), restart=restart, monitor=monitor)
                else:
                    result = self.inner.run(case_dir, f"mpirun --allow-run-as-root --use-hwthread-cpus -np {n_proc} {app} -parallel",
                                            timeout=min(timeout, remaining), monitor=monitor)
            finally:
                with budget.lock:
                    budget.consumed += max(0.0, time.monotonic() - started)
                    budget.started_at = None
            if n_proc > 1:
                result.stdout = preparation + "\n" + result.stdout
                if result.ok:
                    reconstructed = self.inner.application(case_dir, "reconstructPar -latestTime", timeout=timeout)
                    result.stdout += "\n" + reconstructed.stdout
                    if not reconstructed.ok:
                        result.returncode = reconstructed.returncode
                        result.timed_out = reconstructed.timed_out
            return result


def begin_case_budget(runner, spec) -> None:
    if isinstance(runner, BudgetedRunner):
        runner.begin_case(spec)


def case_solver_seconds(runner, spec) -> float | None:
    return runner.consumed(spec) if isinstance(runner, BudgetedRunner) else None


def case_solver_budget(runner, spec) -> CaseSolverBudget | None:
    if not isinstance(runner, BudgetedRunner):
        return None
    consumed = runner.consumed(spec)
    if consumed is None:
        return None
    limit = runner.limit(spec)
    return CaseSolverBudget(version=1, scope="physical_case_v1", limit_seconds=limit, exhausted=consumed >= limit)
