import math
import os
import re
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam.models import SolverParams
from airfoilfoam.openfoam.budget import BudgetedRunner
from airfoilfoam.openfoam.dialects import OPENCFD_2606, find_force_coefficient_files
from airfoilfoam.openfoam.rans_hold import HOLD_MARKER, atomic_dictionary, complete_rans_hold, hold_dictionaries
from airfoilfoam.openfoam.runner import InfrastructureError, RunResult
from airfoilfoam.postprocess.forces import analyze_rans_hold
from airfoilfoam.pipeline import CaseOutcome, _rans_hold_certificate_from_raw, _steady_seed_accepted


CONTROL = "startFrom startTime;\nstopAt endTime;\nendTime 500;\nwriteControl timeStep;\nwriteInterval 500;\npurgeWrite 3;\nfunctions { forceCoeffs1 { writeInterval 1; } }\n"
SOLUTION = "solvers { p { solver GAMG; } }\nSIMPLE { nNonOrthogonalCorrectors 1; residualControl { p 1e-4; U 1e-4; } }\n"


def coefficient_file(directory, start, iterations, steady=True):
    path = directory / "postProcessing/forceCoeffs1" / str(start) / "coefficient.dat"
    path.parent.mkdir(parents=True, exist_ok=True)
    rows = ["# Time Cd Cl CmPitch"]
    for iteration in iterations:
        moment = -0.03 if steady else -0.03 + 0.01 * math.sin(iteration)
        rows.append(f"{iteration} 0.02 0.5 {moment}")
    path.write_text("\n".join(rows) + "\n")
    return path


class HoldingRunner:
    flow_dialect = OPENCFD_2606
    settings = SimpleNamespace(engine_identity=lambda: OPENCFD_2606.identity)
    external_paths_visible = True

    def __init__(self, steady=True, timed_out=False):
        self.calls = []
        self.steady = steady
        self.timed_out = timed_out

    def solver(self, directory, app, n_proc, timeout, restart=False, monitor=None):
        assert "residualControl {}" in (directory / "system/fvSolution").read_text()
        control = (directory / "system/controlDict").read_text()
        assert "startFrom latestTime;" in control
        assert "forceCoeffs1 { writeInterval 1; }" in control
        end = int(re.search(r"(?m)^endTime (\d+);", control)[1])
        current = max(int(path.name) for path in directory.iterdir() if path.is_dir() and path.name.isdigit())
        self.calls.append({"start": current, "end": end, "restart": restart, "timeout": timeout})
        if self.timed_out:
            return RunResult(app, 124, "Time = 101\n", timed_out=True)
        stored_end = end if "writeControl runTime;" in control else (end // 200) * 200
        target = directory / str(stored_end)
        target.mkdir()
        (target / "U").write_text("retained test field")
        coefficient_file(directory, current, range(current + 1, end + 1), self.steady)
        log = "".join(f"\nTime = {iteration}\n" for iteration in range(current + 1, end + 1))
        return RunResult(app, 0, log)


def fixture(directory, *, steady=True, timed_out=False, current=100, end=500):
    (directory / "system").mkdir()
    (directory / "system/controlDict").write_text(CONTROL.replace("endTime 500;", f"endTime {end};"))
    (directory / "system/fvSolution").write_text(SOLUTION)
    (directory / str(current)).mkdir()
    (directory / str(current) / "U").write_text("retained test field")
    original = coefficient_file(directory, 0, range(1, current + 1), False)
    inner = HoldingRunner(steady, timed_out)
    runner = BudgetedRunner(inner, 10)
    spec = SimpleNamespace(chord=1, speed=30, aoa_deg=2)
    runner.begin_case(spec)
    initial = RunResult("simpleFoam", 0, f"\nTime = {current}\nSIMPLE solution converged in {current} iterations\n")
    return inner, runner, spec, initial, original


def test_native_convergence_is_followed_by_real_hold_samples_and_settings_are_restored(tmp_path):
    inner, runner, spec, initial, original = fixture(tmp_path)
    original_bytes = original.read_bytes()
    result = complete_rans_hold(tmp_path, initial, runner, SolverParams(), spec, 1, 10)
    assert result.ok and HOLD_MARKER in result.stdout
    assert inner.calls == [{"start": 100, "end": 300, "restart": True, "timeout": 10}]
    analysis = analyze_rans_hold(find_force_coefficient_files(tmp_path)[-1])
    assert analysis.certified and analysis.sample_count == 200
    assert (analysis.start_iteration, analysis.end_iteration) == (101, 300)
    assert original.read_bytes() == original_bytes
    assert (tmp_path / "system/controlDict").read_text() == CONTROL
    assert (tmp_path / "system/fvSolution").read_text() == SOLUTION
    assert len(list(tmp_path.glob("log.ransHold.*"))) == 1


def test_unsettled_moment_cannot_get_a_certificate_or_exceed_iteration_cap(tmp_path):
    inner, runner, spec, initial, _ = fixture(tmp_path, steady=False)
    complete_rans_hold(tmp_path, initial, runner, SolverParams(), spec, 1, 10)
    assert [entry["end"] for entry in inner.calls] == [300, 500]
    assert not analyze_rans_hold(find_force_coefficient_files(tmp_path)[-1]).certified


def test_warm_iteration_origin_and_insufficient_remaining_iterations_are_preserved(tmp_path):
    inner, runner, spec, initial, _ = fixture(tmp_path, current=900, end=1250)
    complete_rans_hold(tmp_path, initial, runner, SolverParams(), spec, 1, 10)
    assert inner.calls[0]["end"] == 1100
    assert (tmp_path / "system/controlDict").read_text() == CONTROL.replace("endTime 500;", "endTime 1250;")


def test_non_aligned_checkpoint_does_not_repeat_already_solved_iterations(tmp_path):
    inner, runner, spec, initial, _original = fixture(tmp_path, current=772, end=1500)
    complete_rans_hold(tmp_path, initial, runner, SolverParams(), spec, 1, 10)
    assert [(entry["start"], entry["end"]) for entry in inner.calls] == [(772, 972)]
    assert (tmp_path / "972/U").is_file()


@pytest.mark.parametrize("skip", ["forced-urans", "failed", "not-converged", "budget", "iteration-cap"])
def test_no_unearned_or_out_of_scope_hold_execution(tmp_path, skip):
    inner, runner, spec, initial, _ = fixture(tmp_path, end=150 if skip == "iteration-cap" else 500)
    parameters = SolverParams(force_transient=skip == "forced-urans")
    if skip == "failed":
        initial.returncode = 1
    if skip == "not-converged":
        initial.stdout = "Time = 100\n"
    if skip == "budget":
        runner.consumed = lambda _spec: 10
    assert complete_rans_hold(tmp_path, initial, runner, parameters, spec, 1, 10) is initial
    assert inner.calls == []


def test_timeout_and_cancellation_restore_complete_dictionaries(tmp_path):
    inner, runner, spec, initial, _ = fixture(tmp_path, timed_out=True)
    result = complete_rans_hold(tmp_path, initial, runner, SolverParams(), spec, 1, 10)
    assert result.timed_out and result.returncode == 124
    assert (tmp_path / "system/controlDict").read_text() == CONTROL
    assert (tmp_path / "system/fvSolution").read_text() == SOLUTION
    with pytest.raises(RuntimeError, match="cancelled"):
        complete_rans_hold(tmp_path, initial, runner, SolverParams(), spec, 1, 10,
            lambda: (_ for _ in ()).throw(RuntimeError("cancelled")))
    assert len(inner.calls) == 1


def test_hold_dictionary_preflight_refuses_ambiguous_or_transient_settings():
    with pytest.raises(InfrastructureError, match="one generated root"):
        hold_dictionaries(CONTROL + "endTime 600;\n", SOLUTION, 300, 200)
    with pytest.raises(InfrastructureError, match="steady SIMPLE"):
        hold_dictionaries(CONTROL, SOLUTION.replace("SIMPLE", "PIMPLE"), 300, 200)


def test_existing_certificate_and_density_based_mode_do_not_start_hold_work(tmp_path):
    inner, runner, spec, initial, original = fixture(tmp_path, current=200)
    coefficient_file(tmp_path, 0, range(1, 201), True)
    assert complete_rans_hold(tmp_path, initial, runner, SolverParams(), spec, 1, 10) is initial
    coefficient_file(tmp_path, 0, range(1, 201), False)
    inner.flow_dialect = replace(OPENCFD_2606, steady_solver_command="rhoCentralFoam")
    assert complete_rans_hold(tmp_path, initial, runner, SolverParams(), spec, 1, 10) is initial
    assert inner.calls == []


def test_dictionary_replacement_keeps_original_visible_until_complete_publish(tmp_path, monkeypatch):
    path = tmp_path / "controlDict"
    path.write_text(CONTROL)
    path.chmod(0o640)
    expected, _solution = hold_dictionaries(CONTROL, SOLUTION, 300, 200)
    replace_file = os.replace
    observations = []

    def publish(source, target):
        observations.append(Path(target).read_text())
        assert Path(source).read_text() == expected
        replace_file(source, target)
        observations.append(Path(target).read_text())

    monkeypatch.setattr(os, "replace", publish)
    atomic_dictionary(path, expected)
    assert observations == [CONTROL, expected]
    assert path.stat().st_mode & 0o777 == 0o640


def test_cancellation_after_preparation_does_not_start_a_solver(tmp_path):
    inner, runner, spec, initial, _original = fixture(tmp_path)
    checks = []

    def cancel():
        checks.append(True)
        if len(checks) == 2:
            raise RuntimeError("cancelled after preparation")

    with pytest.raises(RuntimeError, match="after preparation"):
        complete_rans_hold(tmp_path, initial, runner, SolverParams(), spec, 1, 10, cancel)
    assert inner.calls == []
    assert (tmp_path / "system/controlDict").read_text() == CONTROL
    assert (tmp_path / "system/fvSolution").read_text() == SOLUTION


def test_warm_start_requires_held_rans_and_does_not_relabel_provisional_points(tmp_path):
    _, _, spec, _, _original = fixture(tmp_path, current=200)
    outcome = CaseOutcome(spec=spec, reynolds=2000000, n_cells=100, cl=0.5, cd=0.02,
                          cm=-0.03, converged=True, method_key="openfoam.rans", fidelity="rans")
    assert not _steady_seed_accepted(outcome)
    assert outcome.converged
    coefficient_file(tmp_path, 0, range(1, 201), True)
    outcome.rans_hold_certificate = _rans_hold_certificate_from_raw(find_force_coefficient_files(tmp_path)[-1])
    assert _steady_seed_accepted(outcome)
    outcome.method_key = "openfoam.urans"
    assert not _steady_seed_accepted(outcome)
    outcome.method_key = "openfoam.rans"
    outcome.error = "invalid source"
    assert not _steady_seed_accepted(outcome)
