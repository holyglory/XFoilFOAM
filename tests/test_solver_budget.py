from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
import threading

import pytest
from pydantic import ValidationError

from airfoilfoam.models import CaseSpec, PolarRequest, ResourceParams, SolverCaseAllocation
from airfoilfoam.openfoam.budget import BudgetedRunner, begin_case_budget, case_solver_seconds, case_solver_budget
from airfoilfoam.openfoam.runner import InfrastructureError, InsufficientMpiSlotsError, RunResult, Runner


class Clock:
    def __init__(self):
        self.local = threading.local()

    def now(self):
        return getattr(self.local, "elapsed", 0.0)

    def advance(self, duration):
        self.local.elapsed = self.now() + duration


class TimedRunner(Runner):
    def __init__(self, clock):
        self.clock = clock
        self.settings = SimpleNamespace(resolved_worker_cpu_budget=lambda: 4)
        self.commands = []
        self.duration = 4.0
        self.error = None
        self.preparation_fails = False

    def run(self, case_dir, command, timeout=7200, monitor=None):
        self.commands.append((command, timeout, monitor))
        preparation = command.startswith(("decomposePar", "reconstructPar", "potentialFoam"))
        duration = 100.0 if preparation else self.duration
        self.clock.advance(min(duration, timeout))
        if not preparation and self.error:
            raise self.error
        if preparation and self.preparation_fails:
            return RunResult(command, 1, "preparation failed")
        timed_out = duration > timeout
        return RunResult(command, 124 if timed_out else 0, command, timed_out)


@pytest.fixture
def budget(monkeypatch):
    clock = Clock()
    monkeypatch.setattr("airfoilfoam.openfoam.budget.time.monotonic", clock.now)
    inner = TimedRunner(clock)
    return BudgetedRunner(inner, 10), inner


def case(alpha=0):
    return CaseSpec(chord=1, speed=30, aoa_deg=alpha)


def test_initialization_retries_and_transient_share_one_budget(budget, tmp_path):
    runner, inner = budget
    spec = case()
    begin_case_budget(runner, spec)
    assert runner.solver(tmp_path, "simpleFoam", 1).ok
    begin_case_budget(runner, spec)
    assert runner.solver(tmp_path, "simpleFoam", 1).ok
    assert runner.solver(tmp_path, "pimpleFoam", 1).timed_out
    assert case_solver_seconds(runner, spec) == 10
    assert [command[1] for command in inner.commands] == [10, 6, 2]
    count = len(inner.commands)
    assert runner.solver(tmp_path, "pimpleFoam", 1).timed_out
    assert len(inner.commands) == count
    assert case_solver_seconds(runner, case(1)) is None
    begin_case_budget(runner, case(1))
    assert runner.solver(tmp_path, "simpleFoam", 1).ok
    assert case_solver_seconds(runner, case(1)) == 4


def test_solver_exception_still_charges_elapsed_time(budget, tmp_path):
    runner, inner = budget
    runner.begin_case(case())
    inner.error = InfrastructureError("lost process connection")
    with pytest.raises(InfrastructureError, match="lost process"):
        runner.solver(tmp_path, "simpleFoam", 1)
    assert runner.consumed(case()) == 4
    inner.error = None
    assert runner.solver(tmp_path, "simpleFoam", 1, timeout=1).timed_out
    assert runner.consumed(case()) == 5


def test_budget_acknowledgement_comes_only_from_actual_case_enforcement(budget, tmp_path):
    runner, inner = budget
    assert case_solver_budget(inner, case()) is None
    assert case_solver_budget(runner, case()) is None
    runner.begin_case(case())
    assert case_solver_budget(runner, case()).model_dump() == {
        "version": 1, "scope": "physical_case_v1", "limit_seconds": 10, "exhausted": False,
    }
    for attempt in range(3):
        runner.solver(tmp_path, "simpleFoam", 1)
    assert case_solver_budget(runner, case()).exhausted
    commands = len(inner.commands)
    runner.solver(tmp_path, "pimpleFoam", 1)
    assert len(inner.commands) == commands
    runner.begin_case(case(2))
    assert runner.solver(tmp_path, "simpleFoam", 1).ok
    assert not case_solver_budget(runner, case(2)).exhausted
    assert case_solver_budget(runner, case()).exhausted


def test_live_measurement_does_not_wait_for_the_active_solver(monkeypatch, tmp_path):
    clock = {"now": 20.0}
    monkeypatch.setattr("airfoilfoam.openfoam.budget.time.monotonic", lambda: clock["now"])
    entered = threading.Event()
    release = threading.Event()

    class BlockingRunner(Runner):
        settings = SimpleNamespace(resolved_worker_cpu_budget=lambda: 1)

        def run(self, case_dir, command, timeout=7200, monitor=None):
            entered.set()
            if not release.wait(timeout=5):
                raise RuntimeError("isolated solver fixture was not released")
            return RunResult(command, 0, "")

    runner = BudgetedRunner(BlockingRunner(), 10)
    assert runner.snapshot() == []

    def solve():
        runner.begin_case(case())
        return runner.solver(tmp_path, "simpleFoam", 1)

    with ThreadPoolExecutor(max_workers=2) as executor:
        solver = executor.submit(solve)
        try:
            assert entered.wait(timeout=2)
            clock["now"] = 24.25
            observed = executor.submit(runner.snapshot).result(timeout=1)
            assert observed == [{"chord": 1.0, "speed": 30.0, "aoa_deg": 0.0,
                                 "solver_active_seconds": 4.25, "limit_seconds": 10.0, "solver_running": True}]
            assert runner.consumed(case()) == 0
        finally:
            release.set()
        assert solver.result(timeout=2).ok
    assert runner.snapshot()[0] == {**observed[0], "solver_running": False}
    assert runner.consumed(case()) == 4.25


def test_mpi_only_charges_solver_not_mesh_decomposition_or_reconstruction(budget, tmp_path):
    runner, inner = budget
    runner.begin_case(case())
    monitor = object()
    result = runner.solver(tmp_path, "rhoPimpleFoam", 4, restart=True, monitor=monitor)
    assert result.ok
    assert runner.consumed(case()) == 4
    assert inner.commands == [
        ("decomposePar -latestTime -force", 7200, None),
        ("mpirun --allow-run-as-root --bind-to none --use-hwthread-cpus -np 4 rhoPimpleFoam -parallel", 10, monitor),
        ("reconstructPar -latestTime", 7200, None),
    ]
    assert "reconstructPar" in result.stdout
    runner.application(tmp_path, "potentialFoam")
    assert runner.consumed(case()) == 4


def test_mpi_preparation_failure_and_capacity_guard_do_not_charge_solver(budget, tmp_path):
    runner, inner = budget
    runner.begin_case(case())
    with pytest.raises(InsufficientMpiSlotsError):
        runner.solver(tmp_path, "rhoPimpleFoam", 5)
    assert inner.commands == []
    inner.preparation_fails = True
    assert not runner.solver(tmp_path, "rhoPimpleFoam", 2).ok
    assert runner.consumed(case()) == 0
    assert len(inner.commands) == 1


def test_parallel_case_threads_keep_distinct_case_ownership(budget, tmp_path):
    runner, inner = budget
    barrier = threading.Barrier(2)

    def solve(alpha):
        spec = case(alpha)
        runner.begin_case(spec)
        barrier.wait(timeout=5)
        for attempt in range(alpha + 1):
            runner.solver(tmp_path, "simpleFoam", 1)
        return runner.consumed(spec)

    with ThreadPoolExecutor(max_workers=2) as executor:
        assert list(executor.map(solve, [0, 1])) == [4, 8]


def test_budget_requires_scope_and_finite_timeout(budget, tmp_path):
    runner, inner = budget
    with pytest.raises(InfrastructureError, match="ownership"):
        runner.solver(tmp_path, "simpleFoam", 1)
    runner.begin_case(case())
    for timeout in [0, -1, float("nan"), float("inf")]:
        with pytest.raises(ValueError, match="timeout"):
            runner.solver(tmp_path, "simpleFoam", 1, timeout=timeout)
    assert inner.commands == []


@pytest.mark.parametrize("seconds", [0, -1, 43201, float("nan"), float("inf")])
def test_budget_contract_rejects_invalid_limits(budget, seconds):
    with pytest.raises(ValueError):
        BudgetedRunner(budget[1], seconds)
    with pytest.raises(ValidationError):
        ResourceParams(case_solver_budget_seconds=seconds)


def test_legacy_runner_remains_unbudgeted(budget, tmp_path):
    inner = budget[1]
    begin_case_budget(inner, case())
    assert case_solver_seconds(inner, case()) is None
    assert inner.solver(tmp_path, "simpleFoam", 1, timeout=42).ok
    assert inner.commands[0][1] == 42
    assert ResourceParams().case_solver_budget_seconds is None


def test_distinct_allocations_preserve_fresh_budget_and_shared_recovery_ownership(budget, tmp_path):
    inner = budget[1]
    allocations = [SolverCaseAllocation(chord=1, speed=30, aoa_deg=0, limit_seconds=6),
                   SolverCaseAllocation(chord=1, speed=30, aoa_deg=1, limit_seconds=10)]
    runner = BudgetedRunner(inner, case_allocations=allocations)
    allocations[0].limit_seconds = 100
    assert runner.snapshot() == []
    runner.begin_case(case())
    assert runner.solver(tmp_path, "simpleFoam", 1).ok
    runner.begin_case(case())
    assert runner.solver(tmp_path, "pimpleFoam", 1).timed_out
    assert case_solver_budget(runner, case()).limit_seconds == 6
    assert case_solver_budget(runner, case()).exhausted
    runner.begin_case(case(1))
    assert runner.solver(tmp_path, "pimpleFoam", 1).ok
    assert case_solver_budget(runner, case(1)).limit_seconds == 10
    assert not case_solver_budget(runner, case(1)).exhausted
    assert [command[1] for command in inner.commands] == [6, 2, 10]
    assert [entry["limit_seconds"] for entry in runner.snapshot()] == [6, 10]
    assert [entry["solver_active_seconds"] for entry in runner.snapshot()] == [6, 4]
    with pytest.raises(InfrastructureError, match="no exact solver budget allocation"):
        runner.begin_case(case(2))
    with pytest.raises(InfrastructureError, match="no physical-case ownership"):
        runner.solver(tmp_path, "pimpleFoam", 1)
    assert len(inner.commands) == 3


def test_allocation_request_is_exact_bounded_and_explicitly_versioned():
    allocation = {"chord": 1, "speed": 30, "aoa_deg": 0, "limit_seconds": 6}
    payload = {"airfoil": {"name": "request-contract", "coordinates": "validated separately"},
               "chord_lengths": [1], "speeds": [30], "aoa": {"angles": [0, 1]},
               "resources": {"case_solver_allocations": [allocation, {**allocation, "aoa_deg": 1, "limit_seconds": 10}]},
               "expected_solver_budget_version": 2}
    request = PolarRequest.model_validate(payload)
    assert request.resources.case_solver_budget_seconds is None
    assert [entry.limit_seconds for entry in request.resources.case_solver_allocations] == [6, 10]
    with pytest.raises(ValidationError, match="expected_solver_budget_version"):
        PolarRequest.model_validate({**payload, "expected_solver_budget_version": None})
    for allocations in [[allocation], [allocation, allocation],
                        [allocation, {**allocation, "aoa_deg": 2}],
                        [allocation, {**allocation, "aoa_deg": 1, "speed": 30.000000001}]]:
        with pytest.raises(ValidationError):
            PolarRequest.model_validate({**payload, "resources": {"case_solver_allocations": allocations}})
    with pytest.raises(ValidationError, match="not both"):
        ResourceParams(case_solver_budget_seconds=10, case_solver_allocations=[allocation])
    for allocations in [[], [allocation] * 513]:
        with pytest.raises(ValidationError):
            ResourceParams(case_solver_allocations=allocations)


@pytest.mark.parametrize("field,value", [("chord", 0), ("speed", -1), ("aoa_deg", float("nan")),
                                         ("limit_seconds", 0), ("limit_seconds", 43201),
                                         ("limit_seconds", float("inf")), ("limit_seconds", True)])
def test_allocations_reject_invalid_physical_or_budget_values(field, value):
    payload = {"chord": 1, "speed": 30, "aoa_deg": 0, "limit_seconds": 6}
    with pytest.raises(ValidationError):
        SolverCaseAllocation.model_validate({**payload, field: value})


def test_runner_rejects_duplicate_or_ambiguous_allocations(budget):
    allocation = SolverCaseAllocation(chord=1, speed=30, aoa_deg=0, limit_seconds=6)
    for kwargs in [{}, {"case_allocations": []}, {"case_allocations": [allocation, allocation]},
                   {"per_case_seconds": 10, "case_allocations": [allocation]}]:
        with pytest.raises(ValueError):
            BudgetedRunner(budget[1], **kwargs)


def test_real_outcome_duration_is_preserved_without_inventing_coefficients():
    from airfoilfoam.jobs import _outcome_to_point
    from airfoilfoam.pipeline import CaseOutcome

    outcome = CaseOutcome(spec=case(), reynolds=100000, solver_active_seconds=7.25)
    point = _outcome_to_point("budget-test", "case", outcome)
    assert point.solver_active_seconds == 7.25
    assert point.cl is None and point.cd is None and point.cm is None
    assert point.solver_budget is None


def test_actual_guard_acknowledgement_survives_point_serialization(budget, tmp_path):
    from airfoilfoam.jobs import _outcome_to_point
    from airfoilfoam.pipeline import CaseOutcome

    runner, inner = budget
    runner.begin_case(case())
    inner.duration = 20
    runner.solver(tmp_path, "rhoPimpleFoam", 1)
    outcome = CaseOutcome(spec=case(), reynolds=100000, solver_active_seconds=case_solver_seconds(runner, case()),
                          solver_budget=case_solver_budget(runner, case()))
    point = _outcome_to_point("budget-test", "case", outcome)
    assert point.solver_budget.exhausted
    assert point.solver_budget.limit_seconds == point.solver_active_seconds == 10
    assert point.cl is None and point.cd is None and point.cm is None
