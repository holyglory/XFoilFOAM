"""Oscillating-steady averaging (task #30, R1) + steady_history contract.

Pins the steady_history serialization shape (drift fails tests on BOTH
runtimes — the node side pins the same shape, same pattern as frame_track) and
validates the detector against realistic failure shapes: a decaying-startup
bounded limit cycle is accepted with window-averaged coefficients and the FULL
history shipped; a growing (unbounded) oscillation, a drifting mean and an
over-large oscillation all stay on the not-converged escalation path — with
the history STILL shipped for analysis. Classic pointwise-converged solves
ship steady_history=null. No OpenFOAM needed.
"""
import json
import math
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from airfoilfoam import pipeline
from airfoilfoam.jobs import _outcome_to_point
from airfoilfoam.models import (
    STEADY_HISTORY_MAX_SAMPLES,
    CaseSpec,
    FluidProperties,
    MeshParams,
    PolarPoint,
    RoughnessParams,
    SolverParams,
    SteadyHistory,
    SteadyHistoryWindow,
)
from airfoilfoam.pipeline import CaseOutcome, _finalize_outcome
from airfoilfoam.postprocess.forces import (
    OSCILLATING_MEAN_REL_TOL,
    analyze_steady_oscillation,
    force_is_steady,
)

HEADER = "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"


def _write_steady_coeffs(path: Path, cl_fn, cd_fn, cm_fn=lambda i: -0.02, n=1200):
    """A steady SIMPLE coefficient.dat: Time column = iteration count."""
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [HEADER]
    for i in range(1, n + 1):
        lines.append(
            f"{i} {cd_fn(i):.8g} 0 0 {cl_fn(i):.8g} 0 0 {cm_fn(i):.8g} 0 0 0 0 0"
        )
    path.write_text("\n".join(lines) + "\n")


def _bounded_oscillation(path: Path, n=1200):
    """Realistic post-separation SIMPLE force history: decaying startup
    transient into a BOUNDED limit cycle (shaped like real solver breakage,
    not like the detector's implementation)."""
    _write_steady_coeffs(
        path,
        cl_fn=lambda i: 1.1 + 0.4 * math.exp(-i / 150.0) + 0.05 * math.sin(2 * math.pi * i / 37.0),
        cd_fn=lambda i: 0.045 + 0.02 * math.exp(-i / 150.0) + 0.004 * math.sin(2 * math.pi * i / 37.0 + 1.0),
        n=n,
    )


def _case_coeff_path(case_dir: Path) -> Path:
    return case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"


class _FakeRunner:
    def application(self, *_args, **_kwargs):
        return SimpleNamespace(ok=True, check=lambda: None)


def _finalize_steady(case_dir, monkeypatch, *, transient_result="forbid", solver_params=None):
    """Run _finalize_outcome on an UNCONVERGED steady case with the transient
    fallback either forbidden (accepted oscillating steady must NOT escalate)
    or stubbed to a failing attempt."""
    calls = {"transient": 0}

    def fake_transient(*_args, **_kwargs):
        calls["transient"] += 1
        if transient_result == "forbid":
            raise AssertionError("accepted oscillating steady must not escalate to URANS")
        return None

    monkeypatch.setattr(pipeline, "_run_transient", fake_transient)
    outcome = CaseOutcome(spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=13.0), reynolds=666_666)
    _finalize_outcome(
        case_dir,
        outcome,
        airfoil=SimpleNamespace(name="unit airfoil", contour=[]),
        resolved=MeshParams(),
        spec=outcome.spec,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=solver_params or SolverParams(transient_fallback=True, write_images=[]),
        runner=_FakeRunner(),
        n_proc=1,
        render_images=False,
        solver_timeout=7200,
    )
    return outcome, calls


# --------------------------------------------------------------------------- #
# Contract pin: exact key set + JSON types (node mirror pins the same shape)
# --------------------------------------------------------------------------- #

STEADY_HISTORY_KEYS = {"iterations", "cl", "cd", "cm", "window", "mean_stable", "note"}


def test_steady_history_contract_pin_exact_keys_and_types():
    outcome = CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=13.0),
        reynolds=666_666,
        converged=True,
        steady_history=SteadyHistory(
            iterations=[1, 2, 3],
            cl=[1.0, 1.1, 1.05],
            cd=[0.04, 0.05, 0.045],
            cm=[-0.02, -0.02, -0.02],
            window=SteadyHistoryWindow(start_iter=2, end_iter=3),
            mean_stable=True,
            note="converged (oscillating steady, averaged over last 400 iterations; amplitude ±0.05 Cl, ±0.004 Cd)",
        ),
    )
    point = _outcome_to_point("job-1", "c1_u10_a13", outcome)
    data = json.loads(point.model_dump_json())["steady_history"]

    assert set(data) == STEADY_HISTORY_KEYS
    assert set(data["window"]) == {"start_iter", "end_iter"}
    assert all(isinstance(i, int) for i in data["iterations"])
    for ch in ("cl", "cd", "cm"):
        assert all(isinstance(v, float) for v in data[ch])
        assert len(data[ch]) == len(data["iterations"]) <= STEADY_HISTORY_MAX_SAMPLES
    assert isinstance(data["window"]["start_iter"], int)
    assert isinstance(data["window"]["end_iter"], int)
    assert isinstance(data["mean_stable"], bool)
    assert isinstance(data["note"], str)


def test_steady_history_defaults_to_null_on_polar_point():
    assert PolarPoint(aoa_deg=1.0).steady_history is None
    assert json.loads(PolarPoint(aoa_deg=1.0).model_dump_json())["steady_history"] is None


# --------------------------------------------------------------------------- #
# Acceptance: bounded oscillation -> window average + history, NO escalation
# --------------------------------------------------------------------------- #


def test_bounded_oscillating_steady_is_averaged_and_ships_history(tmp_path, monkeypatch):
    case_dir = tmp_path / "case"
    _bounded_oscillation(_case_coeff_path(case_dir))
    # The fixture genuinely fails the CLASSIC pointwise force plateau (this is
    # the class of case the detector exists for, not a re-test of that path).
    assert not force_is_steady(_case_coeff_path(case_dir))

    outcome, calls = _finalize_steady(case_dir, monkeypatch, transient_result="forbid")

    assert calls["transient"] == 0  # accepted -> never escalated
    assert outcome.converged
    assert not outcome.unsteady
    assert outcome.fidelity == "rans"
    assert outcome.error is None
    # Window average over the last 400 iterations (decay tail is ~0 there).
    assert outcome.cl == pytest.approx(1.1, abs=5e-3)
    assert outcome.cd == pytest.approx(0.045, abs=1e-3)
    assert outcome.cm == pytest.approx(-0.02, abs=1e-3)
    assert outcome.cl_cd == pytest.approx(outcome.cl / outcome.cd)
    sh = outcome.steady_history
    assert sh is not None
    assert sh.mean_stable
    assert sh.note.startswith("converged (oscillating steady, averaged over last 400 iterations")
    assert "amplitude" in sh.note
    assert sh.note in outcome.quality_warnings
    # The ENTIRE history ships (from iteration 1), window = last 400 iters.
    assert sh.iterations[0] == 1
    assert sh.iterations[-1] == 1200
    assert sh.window.start_iter == 801
    assert sh.window.end_iter == 1200
    assert len(sh.iterations) == len(sh.cl) == len(sh.cd) == len(sh.cm) == 1200


def test_custom_window_field_drives_detection(tmp_path, monkeypatch):
    case_dir = tmp_path / "case"
    _bounded_oscillation(_case_coeff_path(case_dir), n=250)  # too short for N=400

    outcome, _ = _finalize_steady(
        case_dir,
        monkeypatch,
        transient_result="none",
        solver_params=SolverParams(transient_fallback=True, write_images=[]),
    )
    assert not outcome.converged  # short history is never certified
    assert outcome.steady_history is not None
    assert not outcome.steady_history.mean_stable
    assert "250 of 400" in outcome.steady_history.note

    # An explicit smaller window certifies a settled 250-iteration history.
    case2 = tmp_path / "case2"
    _write_steady_coeffs(
        _case_coeff_path(case2),
        cl_fn=lambda i: 1.1 + 0.4 * math.exp(-i / 30.0) + 0.05 * math.sin(2 * math.pi * i / 8.0),
        cd_fn=lambda i: 0.045 + 0.004 * math.sin(2 * math.pi * i / 8.0 + 1.0),
        n=250,
    )
    outcome2, _ = _finalize_steady(
        case2,
        monkeypatch,
        transient_result="forbid",
        solver_params=SolverParams(
            transient_fallback=True, write_images=[], steady_oscillation_window=80
        ),
    )
    assert outcome2.converged
    assert outcome2.steady_history is not None and outcome2.steady_history.mean_stable
    assert outcome2.steady_history.window.end_iter == 250
    assert outcome2.steady_history.window.start_iter == 171


# --------------------------------------------------------------------------- #
# Rejection: unbounded/drifting signals escalate — history STILL shipped
# --------------------------------------------------------------------------- #


def test_growing_oscillation_still_fails_and_ships_history(tmp_path, monkeypatch):
    """MUST-CATCH: divergence-in-progress — amplitude grows exponentially while
    the mean stays put. The window means agree, so a mean-only detector would
    falsely accept; the bounded-amplitude guard must reject it."""
    case_dir = tmp_path / "case"
    _write_steady_coeffs(
        _case_coeff_path(case_dir),
        cl_fn=lambda i: 1.0 + 0.01 * math.exp(i / 260.0) * math.sin(2 * math.pi * i / 25.0),
        cd_fn=lambda i: 0.05 + 0.001 * math.exp(i / 260.0) * math.sin(2 * math.pi * i / 25.0 + 1.0),
    )

    outcome, calls = _finalize_steady(case_dir, monkeypatch, transient_result="none")

    assert calls["transient"] == 1  # escalation attempted (stub failed it)
    assert not outcome.converged
    sh = outcome.steady_history
    assert sh is not None
    assert not sh.mean_stable
    assert "growing" in sh.note
    assert len(sh.iterations) == 1200  # history preserved for analysis


def test_drifting_mean_still_fails_and_ships_history(tmp_path, monkeypatch):
    """MUST-CATCH: an unconverged ramping mean (classic slow SIMPLE drift)
    must not be blessed as 'oscillating steady'."""
    case_dir = tmp_path / "case"
    _write_steady_coeffs(
        _case_coeff_path(case_dir),
        cl_fn=lambda i: 0.8 + 0.4 * i / 1200.0 + 0.03 * math.sin(2 * math.pi * i / 37.0),
        cd_fn=lambda i: 0.05 + 0.002 * math.sin(2 * math.pi * i / 37.0),
    )

    outcome, _ = _finalize_steady(case_dir, monkeypatch, transient_result="none")

    assert not outcome.converged
    assert outcome.steady_history is not None
    assert not outcome.steady_history.mean_stable
    assert "means differ" in outcome.steady_history.note


def test_oversized_oscillation_is_not_blessed_as_steady(tmp_path, monkeypatch):
    """MUST-CATCH: a massive stationary oscillation (deep-stall shedding seen
    by SIMPLE) has stable means but is not honestly 'steady with a ripple'."""
    case_dir = tmp_path / "case"
    _write_steady_coeffs(
        _case_coeff_path(case_dir),
        cl_fn=lambda i: 0.9 + 1.4 * math.sin(2 * math.pi * i / 25.0),
        cd_fn=lambda i: 0.3 + 0.4 * math.sin(2 * math.pi * i / 25.0 + 1.0),
    )

    outcome, _ = _finalize_steady(case_dir, monkeypatch, transient_result="none")

    assert not outcome.converged
    assert outcome.steady_history is not None
    assert not outcome.steady_history.mean_stable
    assert "amplitude" in outcome.steady_history.note


# --------------------------------------------------------------------------- #
# Classic convergence: steady_history stays null (both classic accept paths)
# --------------------------------------------------------------------------- #


def test_classic_residual_converged_ships_null_history(tmp_path, monkeypatch):
    case_dir = tmp_path / "case"
    _write_steady_coeffs(_case_coeff_path(case_dir), cl_fn=lambda i: 0.9, cd_fn=lambda i: 0.02)
    monkeypatch.setattr(
        pipeline, "_run_transient", lambda *a, **k: pytest.fail("converged case escalated")
    )
    outcome = CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=4.0), reynolds=666_666, converged=True
    )
    _finalize_outcome(
        case_dir,
        outcome,
        airfoil=SimpleNamespace(name="unit airfoil", contour=[]),
        resolved=MeshParams(),
        spec=outcome.spec,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(transient_fallback=True, write_images=[]),
        runner=_FakeRunner(),
        n_proc=1,
        render_images=False,
        solver_timeout=7200,
    )
    assert outcome.converged
    assert outcome.steady_history is None
    assert json.loads(_outcome_to_point("j", "s", outcome).model_dump_json())["steady_history"] is None


def test_force_plateau_convergence_ships_null_history(tmp_path, monkeypatch):
    """The force_is_steady plateau path is CLASSIC pointwise convergence: no
    oscillating-averaging note, no steady_history."""
    case_dir = tmp_path / "case"
    _write_steady_coeffs(_case_coeff_path(case_dir), cl_fn=lambda i: 0.9, cd_fn=lambda i: 0.02)

    outcome, calls = _finalize_steady(case_dir, monkeypatch, transient_result="forbid")

    assert calls["transient"] == 0
    assert outcome.converged
    assert outcome.steady_history is None
    assert outcome.quality_warnings == []


# --------------------------------------------------------------------------- #
# Detector unit behaviour: downsampling + direct analysis edge cases
# --------------------------------------------------------------------------- #


def test_steady_history_downsampled_to_contract_cap(tmp_path, monkeypatch):
    case_dir = tmp_path / "case"
    _bounded_oscillation(_case_coeff_path(case_dir), n=6000)

    outcome, _ = _finalize_steady(case_dir, monkeypatch, transient_result="forbid")

    sh = outcome.steady_history
    assert sh is not None and sh.mean_stable
    assert len(sh.iterations) <= STEADY_HISTORY_MAX_SAMPLES
    assert len(sh.iterations) > 1000  # still a dense series, not a stub
    assert sh.iterations[0] == 1 and sh.iterations[-1] == 6000  # endpoints kept
    assert sh.window == SteadyHistoryWindow(start_iter=5601, end_iter=6000)


def test_analyze_steady_oscillation_empty_and_headerless_files(tmp_path):
    empty = tmp_path / "coefficient.dat"
    empty.write_text("# Time Cd Cd(f) Cd(r) Cl\n")
    assert analyze_steady_oscillation(empty) is None

    headerless = tmp_path / "raw.dat"
    rows = "\n".join(
        f"{i} {0.05 + 0.001 * math.sin(i / 5):.6g} 0 0 {1.0 + 0.02 * math.sin(2 * math.pi * i / 37):.6g} 0 0 -0.02 0 0 0 0 0"
        for i in range(1, 501)
    )
    headerless.write_text(rows + "\n")
    analysis = analyze_steady_oscillation(headerless, window=400)
    assert analysis is not None
    assert analysis.mean_stable  # documented v2406 column order fallback works


def test_analyze_mean_tolerance_boundary_is_two_percent():
    assert OSCILLATING_MEAN_REL_TOL == pytest.approx(0.02)


def test_flat_noise_floor_history_is_accepted_without_growth_false_positive(tmp_path):
    """False-positive guard: near-machine-noise flat channels (tiny random
    wiggle) must not trip the growth/amplitude guards through a ~0 first-half
    peak-to-peak denominator."""
    rng = np.random.default_rng(7)
    path = tmp_path / "coefficient.dat"
    noise = rng.normal(0.0, 1e-9, 1200)
    lines = [HEADER]
    for i in range(1, 1201):
        lines.append(f"{i} {0.02 + noise[i - 1]:.12g} 0 0 {0.5 + noise[i - 1]:.12g} 0 0 -0.02 0 0 0 0 0")
    path.write_text("\n".join(lines) + "\n")

    analysis = analyze_steady_oscillation(path, window=400)

    assert analysis is not None
    assert analysis.mean_stable
