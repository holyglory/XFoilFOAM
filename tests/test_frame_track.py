"""URANS recording contract (task #23).

Pins the frame_track serialization shape (drift fails tests on BOTH runtimes —
the node side pins the same shape in packages/engine-client/src/frame-track.ts),
and validates the machinery behind it: autocorrelation period tracking on noisy
signals, integer-period time-weighted stats (phase bias killed), stationarity
both ways, continuation-until-N-periods with honest budget grading, frame
count/cap/time alignment, and frame_track=null for no-shedding steady points.
No OpenFOAM needed.
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
    FRAME_IMAGE_ARTIFACT_KIND,
    FRAME_TRACK_MAX_FRAMES,
    CaseSpec,
    FluidProperties,
    FrameChannelStats,
    FrameSample,
    FrameTrack,
    FrameTrackStats,
    FrameTrackWindow,
    ImageField,
    MeshParams,
    PolarPoint,
    RoughnessParams,
    SolverParams,
)
from airfoilfoam.openfoam.runner import OpenFOAMError
from airfoilfoam.pipeline import (
    CaseOutcome,
    TransientResult,
    UransQuality,
    _archive_case_evidence,
    _finalize_outcome,
    _run_transient_attempt,
)
from airfoilfoam.postprocess.images import nearest_vtu_indices, render_frame_track_images
from airfoilfoam.postprocess.unsteady import (
    ForceHistory,
    coefficient_series,
    frame_coefficients,
    frame_target_times,
    measure_period,
    period_window_stats,
)


# --------------------------------------------------------------------------- #
# Contract pin: exact key set + JSON types (node mirror: frame-track.ts)
# --------------------------------------------------------------------------- #

TOP_KEYS = {
    "period_s", "periods_retained", "stationary", "drift_frac",
    "window", "stats", "fields", "frames", "image_pattern",
}


def _sample_frame_track() -> FrameTrack:
    def ch(mean):
        return FrameChannelStats(mean=mean, std=0.05, min=mean - 0.1, max=mean + 0.1)

    return FrameTrack(
        period_s=0.2,
        periods_retained=7.3,
        stationary=True,
        drift_frac=0.012,
        window=FrameTrackWindow(t_start=1.0, t_end=2.4),
        stats=FrameTrackStats(cl=ch(0.71), cd=ch(0.021), cm=ch(-0.01)),
        fields=["vorticity", "velocity_magnitude"],
        frames=[
            FrameSample(i=0, t=1.0, cl=0.7, cd=0.02, cm=-0.01),
            FrameSample(i=1, t=1.05, cl=0.72, cd=0.021, cm=-0.011),
        ],
        image_pattern="frames/{field}/f{i04}.png",
    )


def test_frame_track_contract_pin_exact_keys_and_types():
    outcome = CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=12.0),
        reynolds=666_666,
        unsteady=True,
        converged=True,
        frame_track=_sample_frame_track(),
    )
    point = _outcome_to_point("job-1", "c1_u10_a12", outcome)
    data = json.loads(point.model_dump_json())["frame_track"]

    assert set(data) == TOP_KEYS
    assert set(data["window"]) == {"t_start", "t_end"}
    assert set(data["stats"]) == {"cl", "cd", "cm"}
    for coeff in ("cl", "cd", "cm"):
        assert set(data["stats"][coeff]) == {"mean", "std", "min", "max"}
        assert all(isinstance(data["stats"][coeff][k], float) for k in ("mean", "std", "min", "max"))
    assert isinstance(data["period_s"], float)
    assert isinstance(data["periods_retained"], float)
    assert isinstance(data["stationary"], bool)
    assert isinstance(data["drift_frac"], float)
    assert isinstance(data["fields"], list) and all(isinstance(f, str) for f in data["fields"])
    assert isinstance(data["frames"], list) and len(data["frames"]) <= FRAME_TRACK_MAX_FRAMES
    for frame in data["frames"]:
        assert set(frame) == {"i", "t", "cl", "cd", "cm"}
        assert isinstance(frame["i"], int)
        assert all(isinstance(frame[k], float) for k in ("t", "cl", "cd", "cm"))
    assert data["image_pattern"] == "frames/{field}/f{i04}.png"


def test_frame_track_defaults_to_null_on_polar_point():
    assert PolarPoint(aoa_deg=1.0).frame_track is None
    data = json.loads(PolarPoint(aoa_deg=1.0).model_dump_json())
    assert data["frame_track"] is None


def test_solver_profile_frame_track_fields():
    sp = SolverParams()
    assert sp.urans_min_periods == 7
    assert sp.urans_drift_tolerance == pytest.approx(0.05)
    assert [f.value for f in sp.frame_fields] == ["vorticity", "velocity_magnitude"]
    custom = SolverParams(urans_min_periods=3, urans_drift_tolerance=0.1, frame_fields=["pressure"])
    assert custom.urans_min_periods == 3
    assert custom.frame_fields == [ImageField.pressure]


# --------------------------------------------------------------------------- #
# Period tracking (autocorrelation) on noisy shedding-like signals
# --------------------------------------------------------------------------- #


def test_measure_period_tracks_noisy_nonuniform_shedding_signal():
    rng = np.random.default_rng(42)
    period = 0.25
    # Adaptive-timestep-like NON-uniform sampling plus measurement noise at
    # 25% of the oscillation amplitude — realistic pimpleFoam Cl history.
    dt = rng.uniform(0.8, 1.2, 3000) * (period / 100.0)
    t = np.cumsum(dt)
    cl = 0.7 + 0.08 * np.sin(2 * np.pi * t / period) + rng.normal(0.0, 0.02, t.size)

    got = measure_period(t, cl)

    assert got is not None
    assert got == pytest.approx(period, rel=0.03)


def test_measure_period_rejects_flat_short_and_subcycle_signals():
    assert measure_period([0.0, 1.0, 2.0], [1.0, 1.0, 1.0]) is None  # too few samples
    t = np.linspace(0.0, 1.0, 200)
    assert measure_period(t, np.ones_like(t)) is None  # flat
    t = np.linspace(0.0, 0.3, 100)  # only 1.2 cycles of a 0.25 s period
    assert measure_period(t, np.sin(2 * np.pi * t / 0.25)) is None


# --------------------------------------------------------------------------- #
# Integer-period time-weighted stats: phase bias killed, min/max, stationarity
# --------------------------------------------------------------------------- #


def _biased_phase_series(period=0.5, cycles=7.37, n=4000):
    """Non-uniformly sampled sine over a NON-integer number of periods: the
    plain sample mean is biased both by the fractional final period and by the
    sampling-density skew."""
    total = cycles * period
    u = np.linspace(0.0, 1.0, n)
    t = total * u**1.3  # denser sampling early (adaptive-dt shape)
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / period)
    cd = 0.05 + 0.01 * np.sin(2 * np.pi * t / period + 0.9)
    cm = -0.02 + 0.005 * np.sin(2 * np.pi * t / period + 1.7)
    return t, cl, cd, cm


def test_integer_period_weighted_mean_matches_analytic_value():
    period = 0.5
    t, cl, cd, cm = _biased_phase_series(period=period)
    naive = float(np.mean(cl))
    assert abs(naive - 0.7) > 2e-3  # the biased-phase fixture really is biased

    stats = period_window_stats(t, cl, cd, cm, period)

    assert stats is not None
    assert stats.whole_periods == 7
    assert stats.periods_retained == pytest.approx(7.37, rel=0.01)
    assert stats.window_end - stats.window_start == pytest.approx(7 * period)
    # Time-weighted trapezoidal mean over whole periods kills the phase bias.
    assert stats.cl.mean == pytest.approx(0.7, abs=5e-4)
    assert stats.cd.mean == pytest.approx(0.05, abs=1e-4)
    assert stats.cm.mean == pytest.approx(-0.02, abs=1e-4)
    assert abs(stats.cl.mean - 0.7) < abs(naive - 0.7)
    # std of a sinusoid = amplitude / sqrt(2); min/max span the oscillation.
    assert stats.cl.std == pytest.approx(0.1 / math.sqrt(2), rel=0.02)
    assert stats.cl.min == pytest.approx(0.6, abs=5e-3)
    assert stats.cl.max == pytest.approx(0.8, abs=5e-3)


def test_stationarity_flag_true_for_repeatable_periods():
    period = 0.5
    t = np.linspace(0.0, 4.0, 4001)
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / period)
    stats = period_window_stats(t, cl, np.full_like(t, 0.05), np.full_like(t, -0.02), period)

    assert stats is not None
    assert stats.stationary
    assert stats.drift_frac < 0.01


def test_stationarity_flag_false_for_drifting_mean():
    period = 0.5
    t = np.linspace(0.0, 4.0, 4001)
    # Same oscillation on a ramping mean (unconverged startup shape): halves
    # differ by ~0.075 -> drift_frac ~0.11 > default 0.05 tolerance.
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / period) + 0.15 * (t / t[-1])
    stats = period_window_stats(t, cl, np.full_like(t, 0.05), np.full_like(t, -0.02), period)

    assert stats is not None
    assert not stats.stationary
    assert stats.drift_frac > 0.05


def test_alpha0_symmetric_near_zero_mean_is_judgeable_and_stationary():
    """MUST-PASS (prod 2026-07-07 structural gap): a symmetric airfoil at
    alpha=0 has mean cl ~ 0, so the old |mean(cl)| drift denominator made such
    points fail stationarity FOREVER (femto-drift / ~0). With the denominator
    floor max(|mean|, retained rms, 0.05) a clean periodic near-zero signal
    passes."""
    period = 0.5
    t = np.linspace(0.0, 3.5, 3501)  # 7 whole periods
    rng = np.random.default_rng(3)
    # tiny symmetric shedding around zero + numerical noise (prod alpha=0 shape)
    cl = 0.03 * np.sin(2 * np.pi * t / period) + 1e-5 * rng.standard_normal(t.size)
    stats = period_window_stats(t, cl, np.full_like(t, 0.008), np.zeros_like(t), period)

    assert stats is not None
    assert abs(stats.cl.mean) < 5e-3  # genuinely near-zero mean
    assert stats.stationary
    assert stats.drift_frac < 0.05


def test_drifting_near_zero_signal_still_fails_stationarity():
    """The floor must not grant amnesty: a near-zero signal whose mean RAMPS
    (unconverged transient) still fails via the rms/absolute-floor scale."""
    period = 0.5
    t = np.linspace(0.0, 3.5, 3501)
    cl = 0.03 * np.sin(2 * np.pi * t / period) + 0.12 * (t / t[-1]) - 0.06
    stats = period_window_stats(t, cl, np.full_like(t, 0.008), np.zeros_like(t), period)

    assert stats is not None
    assert abs(stats.cl.mean) < 0.05  # still a near-zero-mean case
    assert not stats.stationary
    assert stats.drift_frac > 0.05


def test_period_window_stats_requires_one_whole_period():
    t = np.linspace(0.0, 0.4, 100)
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / 0.5)
    assert period_window_stats(t, cl, cl, cl, 0.5) is None
    assert period_window_stats(t, cl, cl, cl, 0.0) is None


# --------------------------------------------------------------------------- #
# Merged restart segments (continuation writes one coefficient.dat per chunk)
# --------------------------------------------------------------------------- #


def _write_coeff_rows(path: Path, times, cl_fn, cd=0.05, cm=-0.02):
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    for t in times:
        lines.append(
            f"{t:.8g} {cd:.6g} 0 0 {cl_fn(t):.8g} 0 0 {cm:.6g} 0 0 0 0 0"
        )
    path.write_text("\n".join(lines) + "\n")


def test_coefficient_series_merges_restart_segments(tmp_path):
    f1 = tmp_path / "postProcessing" / "forceCoeffs1" / "600" / "coefficient.dat"
    f2 = tmp_path / "postProcessing" / "forceCoeffs1" / "603" / "coefficient.dat"
    _write_coeff_rows(f1, np.linspace(600.0, 603.0, 301), lambda t: 0.7)
    # restart segment overlaps its seam sample at t=603
    _write_coeff_rows(f2, np.linspace(603.0, 606.0, 301), lambda t: 0.7)

    t, cl, cd, cm = coefficient_series([f1, f2])

    assert t[0] == pytest.approx(600.0)
    assert t[-1] == pytest.approx(606.0)
    assert np.all(np.diff(t) > 0)  # seam duplicate dropped, strictly increasing
    assert t.size == 601
    assert cl.size == cd.size == cm.size == t.size


def test_transient_attempt_merges_only_transient_segments(tmp_path, monkeypatch):
    """MUST-CATCH: the steady-init coefficient history (pseudo-time iteration
    counts under forceCoeffs1/0) must never contaminate the merged transient
    force signal, while genuine restart segments must merge."""

    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, *_args, **_kwargs):
            pass

    period = 0.5

    class FakeRunner:
        def solver(self, case_dir, *_args, **_kwargs):
            pp = case_dir / "postProcessing" / "forceCoeffs1"
            # steady-init rows: iteration "times" 1..600 with absurd cl=99
            _write_coeff_rows(pp / "0" / "coefficient.dat", np.arange(1.0, 601.0), lambda t: 99.0)
            # two transient restart segments from t=600
            wave = lambda t: 0.7 + 0.1 * math.sin(2 * math.pi * t / period)  # noqa: E731
            _write_coeff_rows(pp / "600" / "coefficient.dat", np.linspace(600.0, 603.0, 600), wave)
            _write_coeff_rows(pp / "603" / "coefficient.dat", np.linspace(603.0, 606.0, 600), wave)
            return SimpleNamespace(ok=True, stdout="pimple ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "600").mkdir(parents=True)

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=8.0),
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(),
        runner=FakeRunner(),
        n_proc=1,
        timeout=120,
        run_time=6.0,
        delta_t=0.001,
        coeff_start_time=600.0,
    )

    assert result is not None
    assert [p.parent.name for p in result.coeff_paths] == ["600", "603"]
    # merged window spans both segments; steady cl=99 rows never leak in
    assert result.avg.cl == pytest.approx(0.7, abs=0.02)
    assert result.force_history is not None
    assert result.force_history.t[-1] == pytest.approx(606.0)
    assert max(result.force_history.cl) < 1.0


# --------------------------------------------------------------------------- #
# Continuation until N whole periods + honest budget grading
# --------------------------------------------------------------------------- #


def _history_over(t0, t1, period, n=600):
    ts = np.linspace(t0, t1, n)
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * ts / period)
    return ForceHistory(
        t=[float(x) for x in ts],
        cl=[float(x) for x in cl],
        cd=[0.05] * n,
        cm=[-0.02] * n,
        cl_mean=0.7,
        cl_rms=0.07,
        cd_mean=0.05,
        cd_rms=0.0,
        cm_mean=-0.02,
        cm_rms=0.0,
        shedding_freq_hz=1.0 / period,
        strouhal=1.0 / (period * 10.0),
        samples=n,
        period_s=period,
        retained_cycles=max(1, int((t1 - t0) / period)),
        window_start=t0,
        window_end=t1,
    )


def _install_continuation_fakes(monkeypatch, *, period, spans, wall_seconds, quality_ok_at_end=True):
    """Fake attempts: attempt k extends the case to cumulative ``spans[k]``
    seconds and returns the merged history over [0, spans[k]]."""
    calls: list[dict] = []

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(tcase, *_args, run_time=None, coeff_start_time=None, refined=False, **_kwargs):
        k = len(calls)
        calls.append({"run_time": run_time, "coeff_start_time": coeff_start_time, "refined": refined})
        end = spans[min(k, len(spans) - 1)]
        (tcase / f"{end:.10g}").mkdir(exist_ok=True)
        last = k >= len(spans) - 1
        ok = quality_ok_at_end and last
        return TransientResult(
            avg=SimpleNamespace(cl=0.7, cd=0.05, cm=-0.02, cl_cd=14.0, cl_std=0.07, cd_std=0.0, cm_std=0.0),
            case_dir=tcase,
            force_history=_history_over(0.0, end, period),
            quality=UransQuality(
                ok=ok,
                can_refine=not ok,
                reason="URANS quality target met." if ok else f"retained cycles {end / period:.2f} < 7.00",
                measured_period_s=period,
                retained_cycles=end / period,
            ),
            start_time=0.0 if k == 0 else spans[k - 1],
            end_time=end,
            run_time=end if k == 0 else end - spans[k - 1],
            wall_seconds=wall_seconds,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)
    return calls


def _run_transient_for_test(tmp_path, solver_params, timeout=7200):
    return pipeline._run_transient(
        tmp_path,
        airfoil=None,
        resolved=None,
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=8.0),
        fluid=None,
        roughness=None,
        solver_params=solver_params,
        runner=None,
        n_proc=1,
        timeout=timeout,
    )


def test_continuation_extends_until_min_whole_periods_retained(tmp_path, monkeypatch):
    # period 0.5s, discard 0.4, target 4 periods -> needs ~3.33s simulated.
    # First attempt covers 1.0s (retained 1.2); one continuation chunk of
    # ~2.33s must follow, reusing the SAME case (restart continuation).
    period = 0.5
    calls = _install_continuation_fakes(
        monkeypatch, period=period, spans=[1.0, 1.0 + 7.0 / 3.0], wall_seconds=1.0
    )
    solver = SolverParams(urans_min_periods=4)

    result = _run_transient_for_test(tmp_path / "case", solver)

    assert len(calls) == 2
    assert not calls[1]["refined"]  # a continuation chunk, not a refined rerun
    assert calls[0]["coeff_start_time"] == pytest.approx(0.0)
    assert calls[1]["coeff_start_time"] == pytest.approx(0.0)  # merged history anchor
    # chunk sized to close the deficit: (4 - 1.2) * 0.5 / 0.6
    assert calls[1]["run_time"] == pytest.approx((4 - 1.2) * period / 0.6, rel=0.05)
    assert result is not None
    assert result.quality.ok
    # the returned result grades the WHOLE merged window
    assert result.start_time == pytest.approx(0.0)
    assert result.run_time == pytest.approx(1.0 + 7.0 / 3.0, rel=0.01)
    assert result.wall_seconds == pytest.approx(2.0)


def test_continuation_budget_stop_grades_retained_periods_honestly(tmp_path, monkeypatch):
    # Base pass: 1.0 simulated s burned 3000 wall s. Default target 7 periods
    # needs a ~4.83s chunk -> projected ~14500 wall s >> 0.8 * 7200 budget:
    # the guard must stop WITHOUT launching the chunk and grade honestly.
    period = 0.5
    calls = _install_continuation_fakes(
        monkeypatch, period=period, spans=[1.0, 99.0], wall_seconds=3000.0, quality_ok_at_end=False
    )

    result = _run_transient_for_test(tmp_path / "case", SolverParams(), timeout=7200)

    assert len(calls) == 1  # no chunk launched
    assert result is not None
    assert not result.quality.ok
    assert not result.quality.can_refine  # a refined pass would blow the same budget
    assert "retained 1.2 of 7 periods (budget)" in result.quality.reason
    # Cross-runtime recall pin: the budget-stop grade carries the continuable
    # marker the node predicate matches by substring (urans-quality.ts).
    assert pipeline.URANS_BUDGET_STOP_MARKER in result.quality.reason


def test_continuation_chunk_timeout_keeps_grade_and_marks_continuable(tmp_path, monkeypatch):
    # Real breakage shape (amendment C recall): the second chunk is killed by
    # the wall clock with nothing gradable IN THAT CHUNK. The already-graded
    # window must survive, and — because a timeout (unlike a crash) leaves the
    # previous chunk's fields saved and restartable — the grade must carry the
    # pinned continuable marker so the UI can offer CONTINUE.
    period = 0.5
    calls = _install_continuation_fakes(
        monkeypatch, period=period, spans=[1.0], wall_seconds=1.0, quality_ok_at_end=False
    )
    fake = pipeline._run_transient_attempt

    def timeout_on_chunk(*args, **kwargs):
        if calls:
            raise pipeline.TransientTimeoutError(
                "URANS transient timed out after 7200s at t=1.6 of 4.8s (dt collapsed to 1e-06)"
            )
        return fake(*args, **kwargs)

    monkeypatch.setattr(pipeline, "_run_transient_attempt", timeout_on_chunk)
    result = _run_transient_for_test(tmp_path / "case", SolverParams(), timeout=7200)

    assert result is not None
    assert not result.quality.ok and not result.quality.can_refine
    assert "continuation chunk failed after retaining 1.2 of 7 periods" in result.quality.reason
    assert pipeline.URANS_BUDGET_STOP_MARKER in result.quality.reason


def test_continuation_chunk_crash_does_not_claim_continuable(tmp_path, monkeypatch):
    # False-positive guard: a chunk that CRASHED (divergence/solver error, not
    # a timeout) must keep the honest partial grade WITHOUT the continuable
    # marker — resuming a diverged case would integrate garbage.
    period = 0.5
    calls = _install_continuation_fakes(
        monkeypatch, period=period, spans=[1.0], wall_seconds=1.0, quality_ok_at_end=False
    )
    fake = pipeline._run_transient_attempt

    def crash_on_chunk(*args, **kwargs):
        if calls:
            raise OpenFOAMError("pimpleFoam diverged: sigFpe in GAMG at t=1.31")
        return fake(*args, **kwargs)

    monkeypatch.setattr(pipeline, "_run_transient_attempt", crash_on_chunk)
    result = _run_transient_for_test(tmp_path / "case", SolverParams(), timeout=7200)

    assert result is not None
    assert not result.quality.ok and not result.quality.can_refine
    assert "continuation chunk failed after retaining 1.2 of 7 periods" in result.quality.reason
    assert pipeline.URANS_BUDGET_STOP_MARKER not in result.quality.reason


def test_continuation_respects_no_shedding_early_exit(tmp_path, monkeypatch):
    calls: list[bool] = []

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(tcase, *_args, refined=False, **_kwargs):
        calls.append(refined)
        (tcase / "1.0").mkdir(exist_ok=True)
        return TransientResult(
            avg=SimpleNamespace(cl=0.01, cd=0.02, cm=0.0, cl_cd=0.5, cl_std=0.0, cd_std=0.0, cm_std=0.0),
            case_dir=tcase,
            force_history=_history_over(0.0, 1.0, 0.5),
            quality=UransQuality(ok=True, can_refine=False, no_shedding=True, reason="no vortex shedding"),
            start_time=0.0,
            end_time=1.0,
            run_time=1.0,
            wall_seconds=5.0,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    result = _run_transient_for_test(tmp_path / "case", SolverParams())

    assert calls == [False]  # no continuation, no refine
    assert result is not None
    assert result.quality.no_shedding


# --------------------------------------------------------------------------- #
# Frame targeting: ~24/period over last min(3, K) periods, cap, alignment
# --------------------------------------------------------------------------- #


def test_frame_target_times_cover_last_three_periods_at_24_per_period():
    targets = frame_target_times(window_end=10.0, period_s=0.5, whole_periods=7)

    assert len(targets) == 72  # 24 * min(3, 7)
    assert targets[-1] == pytest.approx(10.0)
    assert min(targets) > 10.0 - 3 * 0.5  # start phase excluded (no duplicate)
    steps = np.diff(targets)
    assert np.allclose(steps, steps[0])
    assert steps[0] == pytest.approx(0.5 / 24)


def test_frame_target_times_cap_and_short_run_behaviour():
    assert len(frame_target_times(1.0, 0.01, 7, span_periods=7)) == 120  # 24*7 -> capped
    assert len(frame_target_times(1.0, 0.4, 2)) == 48  # K=2 -> 2 periods
    assert len(frame_target_times(1.0, 0.4, 1)) == 24  # K=1 -> 1 period
    assert frame_target_times(1.0, 0.0, 3) == []
    assert frame_target_times(1.0, 0.4, 0) == []


def test_nearest_vtu_indices_align_and_deduplicate():
    vtu_times = [0.0, 0.1, 0.2, 0.3]
    targets = [0.09, 0.11, 0.19, 0.31, 0.9]
    # 0.09 and 0.11 both snap to frame 1 (dedup); 0.9 snaps to the last frame
    # which is already used by 0.31 (dedup again).
    assert nearest_vtu_indices(vtu_times, targets) == [1, 2, 3]
    assert nearest_vtu_indices([], targets) == []


def test_frame_coefficients_interpolate_at_exact_frame_times():
    t = [0.0, 1.0, 2.0]
    cl = [0.0, 1.0, 2.0]
    cd = [0.0, 0.5, 1.0]
    cm = [0.0, -1.0, -2.0]

    samples = frame_coefficients([0.5, 1.5], t, cl, cd, cm)

    assert samples == [
        (0, 0.5, 0.5, 0.25, -0.5),
        (1, 1.5, 1.5, 0.75, -1.5),
    ]


# --------------------------------------------------------------------------- #
# Real 640px frame rendering from VTU evidence (matplotlib, no OpenFOAM)
# --------------------------------------------------------------------------- #


def _write_vtu_sequence(root: Path, times: list[float]) -> None:
    """Small extruded 2D grid with a U field, in the prod foamToVTK layout
    (index-named dirs + .series time map)."""
    import meshio

    xs = np.linspace(-1.0, 2.0, 9)
    ys = np.linspace(-1.0, 1.0, 7)
    xx, yy = np.meshgrid(xs, ys)
    layer = np.column_stack([xx.ravel(), yy.ravel()])
    pts = np.vstack(
        [
            np.column_stack([layer, np.zeros(len(layer))]),
            np.column_stack([layer, np.full(len(layer), 0.1)]),
        ]
    )
    vtk = root / "VTK"
    series = {"file-series-version": "1.0", "files": []}
    for i, t in enumerate(times):
        u = np.column_stack(
            [10.0 + np.sin(pts[:, 0] * 3.0 + t * 50.0), pts[:, 1] * 0.5, np.zeros(len(pts))]
        )
        mesh = meshio.Mesh(pts, [("vertex", np.arange(len(pts)).reshape(-1, 1))], point_data={"U": u})
        d = vtk / f"transient_{i}"
        d.mkdir(parents=True, exist_ok=True)
        meshio.write(d / "internal.vtu", mesh)
        series["files"].append({"name": f"transient_{i}.vtm", "time": t})
    (vtk / "transient.vtm.series").write_text(json.dumps(series))


def test_render_frame_track_images_writes_640px_pngs(tmp_path):
    import matplotlib.image as mpimg

    times = [0.0, 0.01, 0.02, 0.03, 0.04, 0.05]
    _write_vtu_sequence(tmp_path, times)
    contour = np.array([[0.4, -0.05], [0.6, -0.05], [0.6, 0.05], [0.4, 0.05], [0.4, -0.05]])
    out = tmp_path / "frames"

    frame_times, rendered = render_frame_track_images(
        tmp_path,
        out,
        contour,
        chord=1.0,
        fields=[ImageField.velocity_magnitude, ImageField.turbulent_kinetic_energy],
        target_times=[0.011, 0.029, 0.051],
        freestream_speed=10.0,
        zoom_chords=0.5,
    )

    # k is absent from the VTUs: reported by omission, never invented.
    assert rendered == ["velocity_magnitude"]
    assert frame_times == pytest.approx([0.01, 0.03, 0.05])
    pngs = sorted((out / "velocity_magnitude").glob("*.png"))
    assert [p.name for p in pngs] == ["f0000.png", "f0001.png", "f0002.png"]
    img = mpimg.imread(pngs[0])
    assert img.shape[1] == 640  # contract: 640px-wide frames


# --------------------------------------------------------------------------- #
# _finalize_outcome: single source of truth + no-shedding null + evidence kind
# --------------------------------------------------------------------------- #


class _FakeRunner:
    def application(self, *_args, **_kwargs):
        return SimpleNamespace(ok=True, check=lambda: None)


def _fake_transient_with_series(tmp_path, *, period=0.5, no_shedding=False):
    """A TransientResult backed by a REAL merged coefficient series so the
    frame-track stats path runs for real."""
    tcase = tmp_path / "transient"
    coeff = tcase / "postProcessing" / "forceCoeffs1" / "600" / "coefficient.dat"
    ts = np.linspace(600.0, 606.0, 1200)  # 12 periods; 7.2 retained post-discard
    if no_shedding:
        _write_coeff_rows(coeff, ts, lambda t: 0.011)
    else:
        _write_coeff_rows(coeff, ts, lambda t: 0.75 + 0.05 * math.sin(2 * math.pi * t / period))
    hist = _history_over(602.4, 606.0, period)
    avg = SimpleNamespace(cl=99.0, cd=99.0, cm=99.0, cl_cd=1.0, cl_std=9.0, cd_std=9.0, cm_std=9.0)
    quality = UransQuality(
        ok=True,
        can_refine=False,
        reason="URANS quality target met." if not no_shedding else "no vortex shedding",
        measured_period_s=None if no_shedding else period,
        no_shedding=no_shedding,
    )
    return TransientResult(
        avg=avg,
        case_dir=tcase,
        force_history=None if no_shedding else hist,
        quality=quality,
        start_time=600.0,
        end_time=606.0,
        run_time=6.0,
        coeff_paths=[coeff],
    )


def _finalize_with(tmp_path, transient, monkeypatch, solver_params=None):
    monkeypatch.setattr(pipeline, "_run_transient", lambda case_dir, *a, **k: transient)
    outcome = CaseOutcome(spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=12.0), reynolds=666_666)
    _finalize_outcome(
        tmp_path,
        outcome,
        airfoil=SimpleNamespace(name="unit airfoil", contour=[]),
        resolved=MeshParams(),
        spec=outcome.spec,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=solver_params or SolverParams(force_transient=True, write_images=[]),
        runner=_FakeRunner(),
        n_proc=1,
        render_images=False,
        solver_timeout=7200,
    )
    return outcome


def test_point_coefficients_are_frame_track_stats_means(tmp_path, monkeypatch):
    period = 0.5
    transient = _fake_transient_with_series(tmp_path, period=period)

    outcome = _finalize_with(tmp_path, transient, monkeypatch)

    ft = outcome.frame_track
    assert ft is not None
    # single source of truth: the placeholder avg (cl=99) must NOT survive
    assert outcome.cl == pytest.approx(0.75, abs=1e-3)
    assert outcome.cl == ft.stats.cl.mean
    assert outcome.cd == ft.stats.cd.mean
    assert outcome.cm == ft.stats.cm.mean
    assert outcome.cl_std == ft.stats.cl.std
    assert ft.period_s == pytest.approx(period, rel=0.02)
    # measured St = c / (T U)
    assert outcome.strouhal == pytest.approx(1.0 / (ft.period_s * 10.0))
    assert ft.periods_retained == pytest.approx(7.2, rel=0.03)
    assert ft.window.t_end - ft.window.t_start == pytest.approx(7 * ft.period_s, rel=0.01)
    assert ft.stationary
    # media rendering disabled -> frames honestly empty, never invented
    assert ft.frames == []
    assert ft.fields == []
    assert ft.image_pattern == "frames/{field}/f{i04}.png"
    # serialized through the job layer intact
    point = _outcome_to_point("job", "slug", outcome)
    data = json.loads(point.model_dump_json())["frame_track"]
    assert set(data) == TOP_KEYS


def test_non_stationary_window_gets_quality_warning(tmp_path, monkeypatch):
    period = 0.5
    transient = _fake_transient_with_series(tmp_path, period=period)
    coeff = transient.coeff_paths[0]
    ts = np.linspace(600.0, 606.0, 1200)
    # drifting mean: ramps by 0.4 across the run (way past 5% tolerance)
    _write_coeff_rows(
        coeff, ts,
        lambda t: 0.75 + 0.05 * math.sin(2 * math.pi * t / period) + 0.4 * (t - 600.0) / 6.0,
    )

    outcome = _finalize_with(tmp_path, transient, monkeypatch)

    assert outcome.frame_track is not None
    assert not outcome.frame_track.stationary
    assert any("not stationary" in w for w in outcome.quality_warnings)


def test_no_shedding_point_ships_frame_track_null(tmp_path, monkeypatch):
    transient = _fake_transient_with_series(tmp_path, no_shedding=True)

    outcome = _finalize_with(tmp_path, transient, monkeypatch)

    assert not outcome.unsteady  # steady-equivalent point
    assert outcome.frame_track is None
    assert outcome.cl == pytest.approx(99.0)  # time-averaged path untouched
    data = json.loads(_outcome_to_point("job", "slug", outcome).model_dump_json())
    assert data["frame_track"] is None


def test_evidence_archive_ships_frame_pngs_with_pinned_kind(tmp_path):
    case_dir = tmp_path / "case"
    (case_dir / "system").mkdir(parents=True)
    (case_dir / "system" / "controlDict").write_text("application pimpleFoam;\n")
    frames = case_dir / "frames" / "vorticity"
    frames.mkdir(parents=True)
    (frames / "f0000.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    outcome = CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=12.0), reynolds=666_666, unsteady=True
    )

    _archive_case_evidence(case_dir, case_dir, outcome)

    frame_artifacts = [a for a in outcome.evidence_artifacts if a.kind == FRAME_IMAGE_ARTIFACT_KIND]
    assert len(frame_artifacts) == 1
    art = frame_artifacts[0]
    assert art.kind == "frame_image"  # literal pinned cross-runtime
    assert art.role == "frame_image"
    assert art.path == "evidence/frames/vorticity/f0000.png"
    assert art.mime_type == "image/png"
    manifest = json.loads((case_dir / "evidence" / "evidence_manifest.json").read_text())
    assert any(e["path"] == "frames/vorticity/f0000.png" for e in manifest["files"])


def test_early_stopped_point_stats_exclude_startup_via_marker(tmp_path, monkeypatch):
    """F1 regression (adversarial review, 2026-07): early-stopped runs must
    window the frame-track stats to the certified-stable tail recorded by the
    early-stop marker. The old zero-discard path windowed the startup
    transient into the time-weighted means (+~9% Cl bias in the probe) and
    tripped the stationarity drift check, so every early-stopped point was
    biased AND classifier-rejected."""
    from dataclasses import replace as dc_replace

    period = 0.5
    transient = _fake_transient_with_series(tmp_path, period=period)
    coeff = transient.coeff_paths[0]
    ts = np.linspace(600.0, 606.0, 1200)
    # Startup transient: a large decaying offset before t=602, clean limit
    # cycle after — shaped like a real URANS start, not like the fix.
    _write_coeff_rows(
        coeff,
        ts,
        lambda t: 0.75
        + 0.05 * math.sin(2 * math.pi * t / period)
        + (0.6 * (602.0 - t) / 2.0 if t < 602.0 else 0.0),
    )
    (transient.case_dir / "urans_early_stop.json").write_text(
        json.dumps({"retain_from": 602.0, "period_s": period, "reason": "test"})
    )

    outcome = _finalize_with(tmp_path, dc_replace(transient, early_stopped=True), monkeypatch)

    ft = outcome.frame_track
    assert ft is not None
    # Unbiased mean over the certified-stable tail only.
    assert outcome.cl == pytest.approx(0.75, abs=2e-3)
    assert ft.stationary
    assert ft.window.t_start >= 602.0 - 1e-6
    # Early-stopped evidence retains at least the node acceptance gate
    # (packages/core FRAME_TRACK_MIN_PERIODS = 5) worth of periods.
    assert ft.periods_retained >= 5.0
    assert pipeline.URANS_STABLE_RETAINED_CYCLES >= 5.0  # cross-runtime parity pin


def test_multi_aoa_image_subdir_pattern_pin(tmp_path, monkeypatch):
    """F7 pin: multi-AoA polar jobs namespace each case under a{i}/ — the
    shipped image_pattern must carry that prefix (production payload shape),
    not only the bare single-case literal."""
    period = 0.5
    transient = _fake_transient_with_series(tmp_path, period=period)
    monkeypatch.setattr(pipeline, "_run_transient", lambda case_dir, *a, **k: transient)
    outcome = CaseOutcome(spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=12.0), reynolds=666_666)
    _finalize_outcome(
        tmp_path,
        outcome,
        airfoil=SimpleNamespace(name="unit airfoil", contour=[]),
        resolved=MeshParams(),
        spec=outcome.spec,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True, write_images=[]),
        runner=_FakeRunner(),
        n_proc=1,
        render_images=False,
        solver_timeout=7200,
        image_subdir="a2",
    )
    assert outcome.frame_track is not None
    assert outcome.frame_track.image_pattern == "a2/frames/{field}/f{i04}.png"


def test_frame_artifacts_carry_field_and_index_and_tar_excludes_frames(tmp_path):
    """F5/F8: frame PNG artifacts are stamped with field + metadata.frameIndex
    at the source (no downstream filename re-parsing), and the evidence tar
    bundle EXCLUDES the incompressible frames/ tree (it tripled per-point
    frame volume; frames ship as individual artifacts)."""
    import tarfile as _tarfile

    case_dir = tmp_path / "case"
    (case_dir / "system").mkdir(parents=True)
    (case_dir / "system" / "controlDict").write_text("application pimpleFoam;\n")
    frames = case_dir / "frames" / "vorticity"
    frames.mkdir(parents=True)
    (frames / "f0007.png").write_bytes(b"\x89PNG\r\n\x1a\nfake")
    outcome = CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=12.0), reynolds=666_666, unsteady=True
    )

    _archive_case_evidence(case_dir, case_dir, outcome)

    frame_artifacts = [a for a in outcome.evidence_artifacts if a.kind == FRAME_IMAGE_ARTIFACT_KIND]
    assert len(frame_artifacts) == 1
    art = frame_artifacts[0]
    assert art.field == "vorticity"
    assert art.metadata["frameIndex"] == 7
    manifest = json.loads((case_dir / "evidence" / "evidence_manifest.json").read_text())
    assert manifest["bundleExcludes"] == ["frames"]
    with _tarfile.open(case_dir / "evidence" / "openfoam_evidence.tar.gz") as tar:
        names = tar.getnames()
    assert not any(n == "frames" or n.startswith("frames/") for n in names)
    # The manifest itself still ships in the bundle.
    assert "evidence_manifest.json" in names
