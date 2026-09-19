from dataclasses import replace
import json
from types import SimpleNamespace

import pytest

from airfoilfoam.models import SolverParams
from airfoilfoam.openfoam import local_startup
from airfoilfoam.openfoam.budget import BudgetedRunner
from airfoilfoam.openfoam.dialects import OPENCFD_2606
from airfoilfoam.openfoam.rans_hold import root_entry
from airfoilfoam.openfoam.runner import InfrastructureError, MaterialDomainError, RunResult
from airfoilfoam.postprocess.residuals import parse_local_steady_convergence


CONTROL = "application rhoCentralFoam;\nstartFrom startTime;\nstartTime 0;\nstopAt endTime;\nendTime 5000;\ndeltaT 1;\nadjustTimeStep no;\nmaxCo 0.5;\nmaxDeltaT 0.001;\nwriteControl timeStep;\nwriteInterval 100;\npurgeWrite 3;\n"


def checkpoint(directory, end=50):
    state = directory / str(end)
    state.mkdir(exist_ok=True)
    for name in ("U", "p", "T", "rho", "k", "omega", "nut", "alphat", "rDeltaT"):
        (state / name).write_text("synthetic unit-test field")
    (state / "uniform").mkdir(exist_ok=True)
    (state / "uniform/time").write_text(f"value {end};\nindex {end};\ndeltaT 1;\ndeltaT0 1;\n")


class StartupRunner:
    flow_dialect = replace(OPENCFD_2606, steady_solver_command="rhoCentralFoam")
    settings = SimpleNamespace(engine_identity=lambda: OPENCFD_2606.identity)
    external_paths_visible = True

    def __init__(self, failure=None, state_change=None):
        self.calls = []
        self.failure = failure
        self.state_change = state_change

    def solver(self, directory, app, n_proc, timeout, restart=False, monitor=None):
        control = (directory / "system/controlDict").read_text()
        end = int(float(root_entry(control, "endTime")))
        self.calls.append({"end": end, "courant": float(root_entry(control, "maxCo")), "restart": restart,
                           "clock": float(root_entry(control, "deltaT")), "timeout": timeout, "n_proc": n_proc})
        if self.failure is not None and len(self.calls) == self.failure[0]:
            return self.failure[1]
        checkpoint(directory, end)
        if self.state_change is not None and not restart:
            self.state_change(directory)
        return RunResult(app, 0, f"Time = {end}\nXFOILFOAM_LOCAL_STEADY_RESIDUAL {end} 1 1 1 1 1\n")


def fixture(directory, **runner_options):
    (directory / "system").mkdir()
    (directory / "system/controlDict").write_text(CONTROL)
    (directory / "system/fvSchemes").write_text("ddtSchemes { default localEuler; }\n")
    (directory / "0").mkdir()
    for name in ("U", "p", "T"):
        (directory / "0" / name).write_text("unaltered physical input")
    return StartupRunner(**runner_options), SolverParams(n_iterations=5000)


def test_two_stages_share_original_clock_budget_and_keep_raw_settings(tmp_path):
    inner, parameters = fixture(tmp_path)
    runner = BudgetedRunner(inner, 900)
    spec = SimpleNamespace(chord=0.1, speed=1021.025, aoa_deg=13)
    runner.begin_case(spec)
    result = local_startup.solve_cold_steady(tmp_path, runner, parameters, 1, 900)
    assert result.ok
    assert [(call["end"], call["courant"], call["restart"], call["clock"]) for call in inner.calls] == [
        (50, 0.25, False, 1), (5000, 0.5, True, 1)]
    assert 0 < inner.calls[1]["timeout"] <= 900
    assert runner.limit(spec) == 900 and runner.consumed(spec) > 0
    assert result.stdout.count("XFOILFOAM_LOCAL_STEADY_RESIDUAL") == 2
    assert not parse_local_steady_convergence(result.stdout, parameters.convergence_tolerance).converged
    assert (tmp_path / "system/controlDict").read_text() == CONTROL
    assert all((tmp_path / "0" / name).read_text() == "unaltered physical input" for name in ("U", "p", "T"))
    records = list(tmp_path.glob("system/localSteadyStartup/*"))
    assert len(records) == 1
    assert json.loads((records[0] / "receipt.json").read_text())["continuation_launched"]
    request = json.loads((records[0] / "request.json").read_text())
    assert request["maximum_iteration"] == 5000 and not request["physical_time_history"]
    assert len(list(tmp_path.glob("log.localSteadyStartup.*"))) == 1
    assert len(list(tmp_path.glob("log.localSteadyContinuation.*"))) == 1


@pytest.mark.parametrize("mode", ["seeded", "pressure", "transient", "smaller_courant"])
def test_existing_other_execution_paths_are_not_split(tmp_path, mode):
    runner, parameters = fixture(tmp_path)
    if mode == "pressure":
        runner.flow_dialect = replace(OPENCFD_2606, steady_solver_command="rhoSimpleFoam")
    if mode == "transient":
        parameters = parameters.model_copy(update={"force_transient": True})
    if mode == "smaller_courant":
        (tmp_path / "system/controlDict").write_text(root_entry(CONTROL, "maxCo", 0.1))
    local_startup.solve_cold_steady(tmp_path, runner, parameters, 1, 900, seeded=mode == "seeded")
    assert len(runner.calls) == 1 and runner.calls[0]["end"] == 5000
    assert not (tmp_path / "system/localSteadyStartup").exists()


def test_short_request_does_not_gain_more_iterations(tmp_path):
    runner, parameters = fixture(tmp_path)
    original = root_entry(CONTROL, "endTime", 50)
    (tmp_path / "system/controlDict").write_text(original)
    result = local_startup.solve_cold_steady(tmp_path, runner, parameters.model_copy(update={"n_iterations": 50}), 1, 900)
    assert result.ok and len(runner.calls) == 1 and runner.calls[0]["end"] == 50
    assert (tmp_path / "system/controlDict").read_text() == original


@pytest.mark.parametrize("stage", [1, 2])
@pytest.mark.parametrize("failure", [RunResult("rhoCentralFoam", 1, "native failure"),
                                     RunResult("rhoCentralFoam", 124, "native timeout", timed_out=True)])
def test_failure_or_timeout_is_not_hidden_and_still_restores_settings(tmp_path, stage, failure):
    runner, parameters = fixture(tmp_path, failure=(stage, failure))
    result = local_startup.solve_cold_steady(tmp_path, runner, parameters, 1, 900)
    assert result.returncode == failure.returncode and result.timed_out == failure.timed_out
    assert "native" in result.stdout and len(runner.calls) == stage
    assert (tmp_path / "system/controlDict").read_text() == CONTROL


@pytest.mark.parametrize("change", ["missing", "clock", "future"])
def test_invalid_restart_state_never_launches_continuation(tmp_path, change):
    def alter(directory):
        if change == "missing":
            (directory / "50/rDeltaT").unlink()
        elif change == "clock":
            (directory / "50/uniform/time").write_text("value 50;\nindex 3;\ndeltaT 1;\ndeltaT0 1;\n")
        else:
            checkpoint(directory, 400)
    runner, parameters = fixture(tmp_path, state_change=alter)
    with pytest.raises(InfrastructureError, match="continuation fields|iteration clock"):
        local_startup.solve_cold_steady(tmp_path, runner, parameters, 1, 900)
    assert len(runner.calls) == 1
    assert (tmp_path / "system/controlDict").read_text() == CONTROL


def test_cancel_between_stages_preserves_first_log_and_restores_control(tmp_path):
    runner, parameters = fixture(tmp_path)
    def cancel():
        if runner.calls:
            raise RuntimeError("cancelled by unit-test owner")
    with pytest.raises(RuntimeError, match="cancelled"):
        local_startup.solve_cold_steady(tmp_path, runner, parameters, 1, 900, cancel_check=cancel)
    assert len(runner.calls) == 1 and len(list(tmp_path.glob("log.localSteadyStartup.*"))) == 1
    assert (tmp_path / "system/controlDict").read_text() == CONTROL


def test_elapsed_time_cannot_reset_the_original_allocation(tmp_path, monkeypatch):
    runner, parameters = fixture(tmp_path)
    ticks = iter((0, 901, 902))
    monkeypatch.setattr(local_startup.time, "monotonic", lambda: next(ticks))
    result = local_startup.solve_cold_steady(tmp_path, runner, parameters, 1, 900)
    assert result.timed_out and result.returncode == 124 and len(runner.calls) == 1
    assert (tmp_path / "system/controlDict").read_text() == CONTROL


@pytest.mark.parametrize("stage", [1, 2])
def test_material_rejection_stops_at_its_own_stage(tmp_path, stage, monkeypatch):
    runner, parameters = fixture(tmp_path)
    def reject(directory, result):
        if len(runner.calls) == stage:
            raise MaterialDomainError("retained material-domain test failure")
    monkeypatch.setattr(local_startup, "check_material_domain", reject)
    with pytest.raises(MaterialDomainError):
        local_startup.solve_cold_steady(tmp_path, runner, parameters, 1, 900)
    assert len(runner.calls) == stage
    assert (tmp_path / "system/controlDict").read_text() == CONTROL


@pytest.mark.parametrize("name,value", [("deltaT", "0.01"), ("endTime", "5050"), ("startTime", "50"),
                                      ("startFrom", "latestTime"), ("adjustTimeStep", "yes"), ("maxCo", "nan")])
def test_invalid_original_controls_fail_before_solving(tmp_path, name, value):
    runner, parameters = fixture(tmp_path)
    changed = root_entry(CONTROL, name, value)
    (tmp_path / "system/controlDict").write_text(changed)
    with pytest.raises(InfrastructureError):
        local_startup.solve_cold_steady(tmp_path, runner, parameters, 1, 900)
    assert not runner.calls
    assert (tmp_path / "system/controlDict").read_text() == changed
