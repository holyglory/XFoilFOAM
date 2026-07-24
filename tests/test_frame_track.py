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
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from airfoilfoam import pipeline
from airfoilfoam.config import Settings
from airfoilfoam.evidence_store import EvidenceStoreError, RemoteEvidencePointer
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
from airfoilfoam.openfoam.runner import HardSolverError, OpenFOAMError
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
    PeriodEstimate,
    coefficient_series,
    estimate_period,
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
    assert [f.value for f in sp.frame_fields] == ["vorticity", "velocity_magnitude", "pressure"]
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


def test_period_estimate_missing_half_is_ambiguous():
    """A full-window cadence cannot certify a signal absent from one half.

    The first half oscillates outside the physical shedding band while the
    second half has a clean in-band 0.5 s cadence.  The combined window still
    yields that cadence, reproducing the fail-open shape that previously
    labelled the estimate stable when one corroborating half was missing.
    """

    t = np.linspace(0.0, 4.0, 4001)
    cl = np.where(
        t < 2.0,
        np.sin(2.0 * np.pi * 10.0 * t),
        np.sin(2.0 * np.pi * 2.0 * t),
    )

    estimate = estimate_period(t, cl, speed=10.0, chord=1.0, min_cycles=2.0)

    assert estimate is not None
    assert estimate.period_s == pytest.approx(0.5, rel=0.01)
    assert estimate.first_half_s is None
    assert estimate.second_half_s == pytest.approx(0.5, rel=0.01)
    assert estimate.ambiguous


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


def test_coefficient_series_restart_segment_owns_its_nominal_start_boundary(tmp_path):
    """MUST-CATCH: OpenFOAM may emit one numerically inconsistent force row
    at a chunk's terminal ``endTime`` before opening the next restart segment.

    The next segment directory is named by that exact restart time, so it owns
    the boundary.  Keeping the older terminal row minted a false periodic
    impulse train in production (20-32C/Re~102k/alpha=2) and made an otherwise
    flat preliminary trajectory fail the stationarity gate forever.
    """

    f1 = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    f2 = tmp_path / "postProcessing" / "forceCoeffs1" / "1" / "coefficient.dat"
    _write_coeff_rows(
        f1,
        [0.97, 0.98, 0.99, 1.0],
        lambda t: 9.0 if t == 1.0 else 0.7,
    )
    # A real OpenFOAM restart may either repeat the exact start time or write
    # its first force row a few solver steps later.  The newer segment is the
    # authoritative owner in both cases.
    _write_coeff_rows(f2, [1.0, 1.001, 1.002], lambda _t: 0.7)

    t, cl, _cd, _cm = coefficient_series([f1, f2])

    assert np.all(np.diff(t) > 0)
    assert t.tolist() == pytest.approx([0.97, 0.98, 0.99, 1.0, 1.001, 1.002])
    assert cl.tolist() == pytest.approx([0.7] * 6)


def test_coefficient_series_header_only_restart_owns_its_boundary(tmp_path):
    """MUST-CATCH: a newly opened restart segment owns its nominal boundary
    before its first force row is written.  Otherwise the prior segment's
    inconsistent terminal row survives until a later segment becomes parseable.
    """

    f1 = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    f2 = tmp_path / "postProcessing" / "forceCoeffs1" / "1" / "coefficient.dat"
    f3 = tmp_path / "postProcessing" / "forceCoeffs1" / "2" / "coefficient.dat"
    _write_coeff_rows(
        f1,
        [0.98, 0.99, 1.0, 1.01],
        lambda t: 99.0 if t >= 1.0 else 0.7,
    )
    f2.parent.mkdir(parents=True, exist_ok=True)
    f2.write_text(
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)\n"
    )
    _write_coeff_rows(f3, [2.0, 2.01], lambda _t: 0.7)

    t, cl, _cd, _cm = coefficient_series([f1, f2, f3])

    assert t.tolist() == pytest.approx([0.98, 0.99, 2.0, 2.01])
    assert cl.tolist() == pytest.approx([0.7] * 4)


def test_coefficient_series_keeps_real_samples_before_restart_boundary(tmp_path):
    """False-positive guard: seam ownership removes only rows at/after the
    next segment's nominal start, never a genuine sample immediately before it.
    """

    f1 = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    f2 = tmp_path / "postProcessing" / "forceCoeffs1" / "1" / "coefficient.dat"
    _write_coeff_rows(f1, [0.998, 0.999, 1.0], lambda t: t)
    _write_coeff_rows(f2, [1.0005, 1.001], lambda t: t)

    t, cl, _cd, _cm = coefficient_series([f1, f2])

    assert t.tolist() == pytest.approx([0.998, 0.999, 1.0005, 1.001])
    assert cl.tolist() == pytest.approx(t.tolist())


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


def test_precalc_attempt_grades_established_oscillation_before_returning(tmp_path, monkeypatch):
    """Production-shaped must-catch: cycles and frames already satisfy their
    bars, but the per-cycle means still relax monotonically. The attempt must
    return refinable/nonstationary so the same-case continuation loop sees it;
    discovering this only later in _finalize_outcome is too late."""

    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, *_args, **_kwargs):
            pass

    period = 0.5

    class FakeRunner:
        def solver(self, case_dir, *_args, **_kwargs):
            coeff = (
                case_dir
                / "postProcessing"
                / "forceCoeffs1"
                / "0"
                / "coefficient.dat"
            )
            times = np.linspace(0.0, 2.5, 2501)
            _write_coeff_rows(
                coeff,
                times,
                lambda t: 0.7
                + 0.08 * math.sin(2 * math.pi * t / period)
                + 0.12 * (t / times[-1]),
            )
            # Dense real field states: frame cadence itself passes, isolating
            # the late-stationarity defect.
            for t in np.linspace(0.0, 2.5, 151):
                (case_dir / f"{t:.8g}").mkdir(exist_ok=True)
            return SimpleNamespace(ok=True, stdout="pimple ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.0,
        ),
        runner=FakeRunner(),
        n_proc=1,
        timeout=120,
        run_time=2.5,
        delta_t=0.001,
        coeff_start_time=0.0,
    )

    assert result is not None
    assert result.quality.retained_cycles >= 3.0
    assert result.quality.frames_per_cycle >= pipeline.URANS_MIN_FRAMES_PER_CYCLE
    assert not result.quality.ok
    assert result.quality.can_refine
    assert "not stationary" in result.quality.reason
    assert "established-oscillation" in result.quality.reason


def test_precalc_frame_density_matches_exported_last_three_periods(tmp_path):
    """A long sparse startup is outside the published player once the last
    three whole periods are dense. The attempt gate must grade that exact real
    export window instead of diluting it with frames users never receive."""

    period = 0.5
    coeff = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    times = np.linspace(0.0, 3.5, 3501)
    _write_coeff_rows(
        coeff,
        times,
        lambda t: 0.7 + 0.08 * math.sin(2 * math.pi * t / period),
    )
    # First four periods: two frames/period. Last three periods: thirty/period.
    frame_times = {*np.linspace(0.0, 2.0, 9), *np.linspace(2.0, 3.5, 91)}
    for t in sorted(frame_times):
        (tmp_path / f"{t:.8g}").mkdir(exist_ok=True)

    quality = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        [coeff],
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.0,
        ),
        UransQuality(
            ok=True,
            can_refine=False,
            reason="URANS quality target met.",
            measured_period_s=period,
        ),
        early_stopped=False,
    )

    assert quality.ok
    assert quality.retained_cycles >= 5.0
    assert quality.retained_frame_count == pytest.approx(91, abs=2)
    assert quality.frames_per_cycle >= pipeline.URANS_FRAME_WRITE_PER_CYCLE


def _grade_precalc_trailing_signal(
    tmp_path: Path,
    *,
    period: float,
    times: np.ndarray,
    cl_at,
    frame_times,
) -> UransQuality:
    """Exercise the live preliminary grader with byte-backed coefficient rows.

    The long prefix remains in the immutable force history; only the final
    certification verdict is expected to use the settled trailing window.
    """

    coeff = (
        tmp_path
        / "postProcessing"
        / "forceCoeffs1"
        / "0"
        / "coefficient.dat"
    )
    _write_coeff_rows(coeff, times, cl_at)
    for t in frame_times:
        (tmp_path / f"{float(t):.10g}").mkdir(exist_ok=True)
    return pipeline._grade_precalc_established_oscillation(
        tmp_path,
        [coeff],
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.0,
        ),
        _accepted_precalc_quality(period),
        early_stopped=False,
    )


def _write_restart_signal(
    tmp_path: Path,
    times: np.ndarray,
    cl_at,
    *,
    segment_count: int,
) -> list[Path]:
    """Write one byte-backed force history split like OpenFOAM restarts."""

    paths: list[Path] = []
    for indices in np.array_split(np.arange(times.size), segment_count):
        segment_times = times[indices]
        path = (
            tmp_path
            / "postProcessing"
            / "forceCoeffs1"
            / f"{float(segment_times[0]):.10g}"
            / "coefficient.dat"
        )
        _write_coeff_rows(path, segment_times, cl_at)
        paths.append(path)
    return paths


def _segment_local_apparent_flat_quality(span_s: float) -> UransQuality:
    return UransQuality(
        ok=False,
        can_refine=False,
        no_shedding=False,
        reason=(
            "URANS quality could not be measured: "
            f"{pipeline.URANS_APPARENT_FLAT_OBSERVATION_MARKER} {span_s:.7g}s, "
            "below the physical slow-shedding observation horizon."
        ),
        measured_period_s=None,
        retained_cycles=0.0,
        retained_frame_count=0,
        frames_per_cycle=0.0,
    )


@pytest.mark.parametrize(
    ("segment_count", "end_time", "sample_count", "period", "aoa_deg"),
    [
        (11, 0.132188, 43_213, 0.003593869, 20.0),
        (19, 0.184610, 60_361, 0.003159720, 19.0),
    ],
)
def test_precalc_segment_local_false_flat_yields_to_credible_merged_history(
    tmp_path,
    segment_count,
    end_time,
    sample_count,
    period,
    aoa_deg,
):
    """MUST-CATCH: a local restart verdict cannot hide merged shedding.

    These two production-shaped histories retain roughly 26k and 36k real
    post-startup samples across many restart segments.  A stale/local
    apparent-flat grade is replaced only after the merged halves independently
    corroborate shedding and the existing trailing 4.5-cycle gate certifies
    the final trajectory.
    """

    times = np.linspace(0.0, end_time, sample_count)
    cl_at = lambda t: 1.02 + 0.02 * math.sin(2 * math.pi * float(t) / period)
    paths = _write_restart_signal(
        tmp_path,
        times,
        cl_at,
        segment_count=segment_count,
    )
    for t in np.arange(
        end_time - 5.0 * period,
        end_time + period / 60.0,
        period / pipeline.URANS_FRAME_WRITE_PER_CYCLE,
    ):
        (tmp_path / f"{float(t):.10g}").mkdir(exist_ok=True)

    solver = SolverParams(
        force_transient=True,
        urans_fidelity="precalc",
        urans_min_periods=3,
        transient_discard_fraction=0.4,
    )
    spec = CaseSpec(chord=0.05, speed=30.0, aoa_deg=aoa_deg)
    retained = pipeline.discard_startup(
        *coefficient_series(paths),
        fraction=solver.transient_discard_fraction,
    )
    merged_estimate = estimate_period(
        retained[0],
        retained[1],
        speed=spec.speed,
        chord=spec.chord,
        alpha_deg=spec.aoa_deg,
    )
    assert retained[0].size >= 25_000
    assert merged_estimate is not None and not merged_estimate.ambiguous

    prior = _segment_local_apparent_flat_quality(end_time - float(times[-3_500]))
    quality = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        paths,
        spec,
        solver,
        prior,
        early_stopped=False,
    )

    assert quality is not prior
    assert quality.ok, quality.reason
    assert quality.measured_period_s == pytest.approx(period, rel=0.03)
    assert quality.retained_cycles >= 3.0
    assert quality.frames_per_cycle >= pipeline.URANS_MIN_FRAMES_PER_CYCLE


@pytest.mark.parametrize("signal_kind", ["tiny-ripple", "short", "noise"])
def test_precalc_apparent_flat_override_remains_fail_closed_without_credible_shedding(
    tmp_path,
    signal_kind,
):
    """False-positive guards for the narrow merged-history override.

    A perfectly periodic but amplitude-flat numerical ripple, fewer than two
    independently measurable half windows, and broadband noise must all retain
    the original acquisition verdict.  Spectral shape alone is not physical
    shedding evidence.
    """

    period = 0.0035
    if signal_kind == "short":
        times = np.linspace(0.0, 3.5 * period, 3_000)
        values = 1.0 + 0.02 * np.sin(2 * np.pi * times / period)
    else:
        times = np.linspace(0.0, 0.08, 12_000)
        if signal_kind == "tiny-ripple":
            values = 1.0 + 0.001 * np.sin(2 * np.pi * times / period)
        else:
            values = 1.0 + 0.02 * np.random.default_rng(411).standard_normal(
                times.size
            )
    paths = _write_restart_signal(
        tmp_path,
        times,
        lambda t: float(np.interp(float(t), times, values)),
        segment_count=5,
    )
    spec = CaseSpec(chord=0.05, speed=30.0, aoa_deg=18.0)
    estimate = estimate_period(
        times,
        values,
        speed=spec.speed,
        chord=spec.chord,
        alpha_deg=spec.aoa_deg,
    )
    if signal_kind == "tiny-ripple":
        # This is the dangerous case: correlation is impeccable, but the
        # amplitude is still below the physical no-shedding floor.
        assert estimate is not None and not estimate.ambiguous
        merged = pipeline.compute_force_history(
            paths,
            spec.speed,
            spec.chord,
            0.0,
            target_cycles=3,
            alpha_deg=spec.aoa_deg,
        )
        assert pipeline.is_no_shedding(merged)
    elif signal_kind == "short":
        assert estimate is not None and estimate.ambiguous
    else:
        assert estimate is None or estimate.ambiguous

    prior = _segment_local_apparent_flat_quality(float(times[-1] - times[0]))
    quality = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        paths,
        spec,
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.0,
        ),
        prior,
        early_stopped=False,
    )

    assert quality is prior
    assert not quality.ok
    assert quality.measured_period_s is None


def test_precalc_merged_false_flat_nonstationary_tail_keeps_restartable_continuation(
    tmp_path,
    monkeypatch,
):
    """A credible merged period may still need more SAME-case integration.

    Once the local false-flat marker is displaced, an honestly drifting tail
    must enter measured-period continuation.  If the emergency chunk cap is
    reached, the exact durable-continuation marker and saved latest-time state
    survive; the controller must not fall back to a fresh solve.
    """

    period = 0.2
    end_time = 5.0
    times = np.linspace(0.0, end_time, 15_001)

    def cl_at(t):
        return (
            0.8
            + 0.20 * float(t) / end_time
            + 0.08 * math.sin(2 * math.pi * float(t) / period)
        )

    paths = _write_restart_signal(
        tmp_path,
        times,
        cl_at,
        segment_count=7,
    )
    for t in np.arange(0.0, end_time + period / 60.0, period / 30.0):
        (tmp_path / f"{float(t):.10g}").mkdir(exist_ok=True)
    solver = SolverParams(
        force_transient=True,
        urans_fidelity="precalc",
        urans_min_periods=3,
        transient_discard_fraction=0.0,
    )
    spec = CaseSpec(chord=1.0, speed=10.0, aoa_deg=18.0)
    graded = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        paths,
        spec,
        solver,
        _segment_local_apparent_flat_quality(0.7),
        early_stopped=False,
    )
    assert not graded.ok and graded.can_refine
    assert graded.measured_period_s == pytest.approx(period, rel=0.03)
    assert "not stationary" in graded.reason
    assert not pipeline._quality_needs_period_acquisition(graded, solver)
    assert pipeline._quality_allows_more_integration(
        graded, float(solver.urans_min_periods)
    )

    first = TransientResult(
        avg=SimpleNamespace(cl=0.9, cd=0.05, cm=-0.02, cl_cd=18.0),
        case_dir=tmp_path,
        force_history=_history_over(0.0, end_time, period),
        quality=graded,
        start_time=0.0,
        end_time=end_time,
        run_time=end_time,
        wall_seconds=0.0,
        coeff_paths=paths,
    )
    calls: list[float] = []

    def keep_drifting(tcase, *_args, run_time=None, **_kwargs):
        start = pipeline._latest_time(tcase)
        end = start + float(run_time)
        (tcase / f"{end:.10g}").mkdir(exist_ok=True)
        calls.append(end)
        return TransientResult(
            avg=first.avg,
            case_dir=tcase,
            force_history=_history_over(0.0, end, period),
            quality=graded,
            start_time=start,
            end_time=end,
            run_time=float(run_time),
            wall_seconds=0.001,
            coeff_paths=paths,
        )

    monkeypatch.setattr(pipeline, "_run_transient_attempt", keep_drifting)
    result = pipeline._extend_transient_until_periods(
        tmp_path,
        first,
        0.0,
        None,
        None,
        {},
        spec,
        None,
        None,
        solver,
        None,
        1,
        14_400,
        period / 5000.0,
    )

    assert len(calls) == pipeline.URANS_CONTINUATION_MAX_CHUNKS
    assert pipeline.URANS_CONTINUATION_REQUIRED_MARKER in result.quality.reason
    assert "restartable saved case state" in result.quality.reason
    assert (tmp_path / f"{calls[-1]:.10g}").is_dir()


def test_precalc_trailing_certification_replaces_relaxing_startup(tmp_path):
    """MUST-CATCH: a long startup must not vote forever after a real 4.5-cycle
    settled tail exists.

    The full immutable trace has eight one-directionally relaxing cycles, so
    grading all post-discard cycles rejects it.  The final 4.5 cycles are a
    clean established oscillation with dense fields and are the preliminary
    certification evidence promised by the same-case extension contract.
    """

    period = 0.5
    settled_at = 8.0 * period
    end = settled_at + 4.5 * period
    times = np.linspace(0.0, end, 12_501)

    def cl_at(t):
        baseline = 0.7 + 0.18 * min(float(t) / settled_at, 1.0)
        return baseline + 0.08 * math.sin(2 * math.pi * float(t) / period)

    quality = _grade_precalc_trailing_signal(
        tmp_path,
        period=period,
        times=times,
        cl_at=cl_at,
        frame_times=np.arange(0.0, end + 1e-9, period / 30.0),
    )

    assert quality.ok, quality.reason
    assert quality.retained_cycles >= 3.0
    assert quality.frames_per_cycle >= pipeline.URANS_MIN_FRAMES_PER_CYCLE


def test_precalc_trailing_certification_requires_full_4p5_cycle_floor(tmp_path):
    """False-positive guard: three accepted-tier cycles are not enough for
    the two independent period halves plus the existing half-cycle margin."""

    period = 0.5
    end = 4.4 * period
    times = np.linspace(0.0, end, 4_401)
    quality = _grade_precalc_trailing_signal(
        tmp_path,
        period=period,
        times=times,
        cl_at=lambda t: 0.8 + 0.08 * math.sin(2 * math.pi * float(t) / period),
        frame_times=np.arange(0.0, end + 1e-9, period / 30.0),
    )

    assert not quality.ok
    assert quality.can_refine
    assert "4.5" in quality.reason
    assert "certification" in quality.reason


@pytest.mark.parametrize("tail_kind", ["drifting", "growing"])
def test_precalc_trailing_certification_rejects_unsettled_tail(
    tmp_path,
    tail_kind,
):
    """False-positive guards: trailing-window scope never relaxes the existing
    trend or bounded-amplitude gates."""

    period = 0.5
    head = 4.0 * period
    end = head + 4.5 * period
    times = np.linspace(0.0, end, 8_501)

    def cl_at(t):
        tail_x = max(0.0, float(t) - head)
        mean = 0.8 + (
            0.12 * tail_x / (4.5 * period)
            if tail_kind == "drifting"
            else 0.0
        )
        amplitude = 0.05 + (
            0.12 * tail_x / (4.5 * period)
            if tail_kind == "growing"
            else 0.0
        )
        return mean + amplitude * math.sin(2 * math.pi * float(t) / period)

    quality = _grade_precalc_trailing_signal(
        tmp_path,
        period=period,
        times=times,
        cl_at=cl_at,
        frame_times=np.arange(0.0, end + 1e-9, period / 30.0),
    )

    assert not quality.ok
    assert quality.can_refine
    assert "not stationary" in quality.reason
    if tail_kind == "drifting":
        assert "trend" in quality.reason or "drift" in quality.reason
    else:
        assert "amplitude growing" in quality.reason


def test_precalc_trailing_certification_rejects_ambiguous_tail_period(
    tmp_path,
    monkeypatch,
):
    """False-positive guard: a full-history cadence may locate the tail, but
    only independently corroborated trailing halves may certify it."""

    period = 0.5
    end = 8.0 * period
    times = np.linspace(0.0, end, 8_001)
    calls = 0

    def full_then_ambiguous(*args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return PeriodEstimate(
                period_s=period,
                ambiguous=False,
                first_half_s=period,
                second_half_s=period,
            )
        return PeriodEstimate(
            period_s=period,
            ambiguous=True,
            first_half_s=None,
            second_half_s=period,
        )

    monkeypatch.setattr(pipeline, "estimate_period", full_then_ambiguous)
    quality = _grade_precalc_trailing_signal(
        tmp_path,
        period=period,
        times=times,
        cl_at=lambda t: 0.8 + 0.08 * math.sin(2 * math.pi * float(t) / period),
        frame_times=np.arange(0.0, end + 1e-9, period / 30.0),
    )

    assert calls >= 2
    assert not quality.ok
    assert quality.can_refine
    assert "period unstable" in quality.reason


def test_precalc_trailing_certification_keeps_dense_field_gate(tmp_path):
    """False-positive guard: a stable aerodynamic tail without the required
    real field cadence remains a same-case remediation, not an accepted point."""

    period = 0.5
    end = 6.0 * period
    times = np.linspace(0.0, end, 6_001)
    quality = _grade_precalc_trailing_signal(
        tmp_path,
        period=period,
        times=times,
        cl_at=lambda t: 0.8 + 0.08 * math.sin(2 * math.pi * float(t) / period),
        frame_times=np.arange(0.0, end + 1e-9, period / 8.0),
    )

    assert not quality.ok
    assert quality.can_refine
    assert "frames/cycle" in quality.reason


def _accepted_precalc_quality(period: float) -> UransQuality:
    return UransQuality(
        ok=True,
        can_refine=False,
        reason="URANS quality target met.",
        measured_period_s=period,
        retained_cycles=3.0,
        retained_frame_count=90,
        frames_per_cycle=30.0,
    )


def _precalc_grade_fixture(tmp_path, period: float):
    coeff = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    # Five cycles clear the shared 4.5-cycle live/final certification floor so
    # tests below reach the specific ambiguity/error branches they advertise.
    times = np.linspace(0.0, 2.5, 2501)
    _write_coeff_rows(
        coeff,
        times,
        lambda t: 0.7 + 0.08 * math.sin(2 * math.pi * t / period),
    )
    return (
        [coeff],
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.0,
        ),
    )


def test_precalc_live_grade_rejects_missing_half_period(tmp_path, monkeypatch):
    """The live precalc gate must consume the half-window ambiguity verdict."""

    period = 0.5
    coeff_paths, spec, solver = _precalc_grade_fixture(tmp_path, period)
    for t in np.linspace(0.0, 2.0, 121):
        (tmp_path / f"{t:.8g}").mkdir(exist_ok=True)
    monkeypatch.setattr(
        pipeline,
        "estimate_period",
        lambda *_args, **_kwargs: PeriodEstimate(
            period_s=period,
            ambiguous=True,
            first_half_s=None,
            second_half_s=period,
        ),
    )

    quality = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        coeff_paths,
        spec,
        solver,
        _accepted_precalc_quality(period),
        early_stopped=False,
    )

    assert not quality.ok
    assert quality.can_refine
    assert "not stationary" in quality.reason
    assert "period" in quality.reason


def test_precalc_stationarity_grading_exception_fails_closed(tmp_path, monkeypatch):
    """A new-tier precalc must not retain a prior ``ok=True`` grade when its
    mandatory established-oscillation verdict raises unexpectedly."""

    period = 0.5
    coeff_paths, spec, solver = _precalc_grade_fixture(tmp_path, period)

    def raise_stats_error(*_args, **_kwargs):
        raise RuntimeError("synthetic stationarity failure")

    monkeypatch.setattr(pipeline, "period_window_stats", raise_stats_error)

    quality = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        coeff_paths,
        spec,
        solver,
        _accepted_precalc_quality(period),
        early_stopped=False,
    )

    assert not quality.ok
    assert quality.can_refine
    assert "established-oscillation stationarity verdict unavailable" in quality.reason
    assert "grading error" in quality.reason


def test_precalc_missing_stationarity_stats_fails_closed(tmp_path, monkeypatch):
    """``period_window_stats`` returning no whole-period verdict is likewise
    unavailable evidence, never permission to finalize a previously-ok row."""

    period = 0.5
    coeff_paths, spec, solver = _precalc_grade_fixture(tmp_path, period)
    monkeypatch.setattr(pipeline, "period_window_stats", lambda *_args, **_kwargs: None)

    quality = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        coeff_paths,
        spec,
        solver,
        _accepted_precalc_quality(period),
        early_stopped=False,
    )

    assert not quality.ok
    assert quality.can_refine
    assert "established-oscillation stationarity verdict unavailable" in quality.reason
    assert "no whole-period statistics" in quality.reason


def test_precalc_unavailable_stationarity_without_valid_period_is_not_refinable(
    tmp_path, monkeypatch
):
    """Fail-closed does not itself authorize continuation when there is no
    measured cadence from which a safe same-case chunk can be sized."""

    period = 0.5
    coeff_paths, spec, solver = _precalc_grade_fixture(tmp_path, period)
    monkeypatch.setattr(pipeline, "estimate_period", lambda *_args, **_kwargs: None)
    prior = _accepted_precalc_quality(period)
    prior.measured_period_s = None

    quality = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        coeff_paths,
        spec,
        solver,
        prior,
        early_stopped=False,
    )

    assert not quality.ok
    assert not quality.can_refine
    assert "established-oscillation stationarity verdict unavailable" in quality.reason
    assert "no corroborated shedding period" in quality.reason


def test_precalc_prior_fft_period_cannot_replace_missing_corroborated_estimate(
    tmp_path, monkeypatch
):
    """An FFT-only history period may size continuation, never certify stability.

    This is the exact fail-open shape from the adversarial review: the prior
    force-history grade carries a finite spectral period, but the stricter
    autocorrelation/corroboration estimator returns None. The stationarity
    grader must fail closed without calling period_window_stats under a period
    it could not corroborate.
    """

    period = 0.5
    coeff_paths, spec, solver = _precalc_grade_fixture(tmp_path, period)
    monkeypatch.setattr(pipeline, "estimate_period", lambda *_args, **_kwargs: None)

    def forbidden_stats(*_args, **_kwargs):
        raise AssertionError("uncorroborated FFT period reached stationarity stats")

    monkeypatch.setattr(pipeline, "period_window_stats", forbidden_stats)
    prior = _accepted_precalc_quality(period)

    quality = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        coeff_paths,
        spec,
        solver,
        prior,
        early_stopped=False,
    )

    assert not quality.ok
    assert quality.can_refine
    assert quality.measured_period_s == pytest.approx(period)
    assert "established-oscillation stationarity verdict unavailable" in quality.reason
    assert "no corroborated shedding period" in quality.reason
    assert "grading error" not in quality.reason


def test_full_fidelity_does_not_enter_precalc_stationarity_grader(
    tmp_path, monkeypatch
):
    """Default/full requests keep their established legacy grading path."""

    original = _accepted_precalc_quality(0.5)

    def forbidden(*_args, **_kwargs):
        raise AssertionError("precalc grader called for full fidelity")

    monkeypatch.setattr(pipeline, "period_window_stats", forbidden)
    result = pipeline._grade_precalc_established_oscillation(
        tmp_path,
        [],
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        SolverParams(),
        original,
        early_stopped=False,
    )

    assert result is original


@pytest.mark.parametrize("drifting", [False, True])
def test_full_live_grade_applies_strict_stationarity_before_finalization(
    tmp_path,
    monkeypatch,
    drifting,
):
    """MUST-CATCH: seven dense periods are not sufficient for a verified
    point when their mean is still moving.  The strict verdict must reach the
    live quality controller, while a clean full-tier limit cycle still passes.
    """

    period = 0.5
    end = 7.0 * period
    coeff = (
        tmp_path
        / "postProcessing"
        / "forceCoeffs1"
        / "0"
        / "coefficient.dat"
    )
    times = np.linspace(0.0, end, 3501)
    _write_coeff_rows(
        coeff,
        times,
        lambda t: (
            0.7
            + 0.08 * math.sin(2 * math.pi * t / period)
            + (0.16 * t / end if drifting else 0.0)
        ),
    )
    monkeypatch.setattr(
        pipeline,
        "estimate_period",
        lambda *_args, **_kwargs: PeriodEstimate(
            period_s=period,
            ambiguous=False,
            first_half_s=period,
            second_half_s=period,
        ),
    )
    original = UransQuality(
        ok=True,
        can_refine=False,
        reason="URANS quality target met.",
        measured_period_s=period,
        retained_cycles=7.0,
        retained_frame_count=210,
        frames_per_cycle=30.0,
    )

    quality = pipeline._grade_full_strict_stationarity(
        tmp_path,
        [coeff],
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        SolverParams(
            force_transient=True,
            urans_fidelity="full",
            transient_discard_fraction=0.0,
        ),
        original,
        early_stopped=False,
    )

    assert quality.ok is (not drifting)
    assert quality.can_refine is drifting
    if drifting:
        assert quality.reason.startswith(
            "URANS window not stationary: Cl drift"
        )
        assert "exceeds tolerance 0.05 over 7 whole periods" in quality.reason
    else:
        assert quality is original


def test_full_transient_attempt_routes_strict_drift_to_live_controller(
    tmp_path,
    monkeypatch,
):
    """Integration pin: the real attempt path must not stop at the ordinary
    periods/frames grade and defer strict drift discovery to finalization.
    """

    period = 0.5
    end = 7.0 * period

    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, *_args, **_kwargs):
            pass

    class FakeRunner:
        def solver(self, case_dir, *_args, **_kwargs):
            coeff = (
                case_dir
                / "postProcessing"
                / "forceCoeffs1"
                / "0"
                / "coefficient.dat"
            )
            times = np.linspace(0.0, end, 3501)
            _write_coeff_rows(
                coeff,
                times,
                lambda t: (
                    0.7
                    + 0.08 * math.sin(2 * math.pi * t / period)
                    + 0.16 * t / end
                ),
            )
            for t in np.linspace(0.0, end, 211):
                (case_dir / f"{t:.8g}").mkdir(exist_ok=True)
            return SimpleNamespace(ok=True, stdout="pimple ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    monkeypatch.setattr(
        pipeline,
        "estimate_period",
        lambda *_args, **_kwargs: PeriodEstimate(
            period_s=period,
            ambiguous=False,
            first_half_s=period,
            second_half_s=period,
        ),
    )
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(
            force_transient=True,
            urans_fidelity="full",
            transient_discard_fraction=0.0,
        ),
        runner=FakeRunner(),
        n_proc=1,
        timeout=120,
        run_time=end,
        delta_t=period / 5000.0,
        coeff_start_time=0.0,
    )

    assert result is not None
    assert not result.quality.ok and result.quality.can_refine
    assert result.quality.reason.startswith(
        "URANS window not stationary: Cl drift"
    )


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


def _install_continuation_fakes(
    monkeypatch,
    *,
    period,
    spans,
    wall_seconds,
    quality_ok_at_end=True,
    failure_reason=None,
    failure_frames_per_cycle=0.0,
):
    """Fake attempts: attempt k extends the case to cumulative ``spans[k]``
    seconds and returns the merged history over [0, spans[k]]."""
    calls: list[dict] = []

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(
        tcase,
        *_args,
        run_time=None,
        delta_t=None,
        write_interval=None,
        max_delta_t=None,
        coeff_start_time=None,
        refined=False,
        **_kwargs,
    ):
        k = len(calls)
        calls.append(
            {
                "case": tcase.name,
                "run_time": run_time,
                "delta_t": delta_t,
                "write_interval": write_interval,
                "max_delta_t": max_delta_t,
                "coeff_start_time": coeff_start_time,
                "refined": refined,
            }
        )
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
                reason=(
                    "URANS quality target met."
                    if ok
                    else failure_reason
                    or f"retained cycles {end / period:.2f} < 7.00"
                ),
                measured_period_s=period,
                retained_cycles=end / period,
                frames_per_cycle=failure_frames_per_cycle,
            ),
            start_time=0.0 if k == 0 else spans[k - 1],
            end_time=end,
            run_time=end if k == 0 else end - spans[k - 1],
            wall_seconds=wall_seconds,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)
    return calls


def test_fresh_transient_startup_caps_first_chunk_max_delta_t(tmp_path, monkeypatch):
    period = pipeline.physics.shedding_period(
        10.0,
        1.0,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    )
    calls = _install_continuation_fakes(
        monkeypatch,
        period=period,
        spans=[2.0],
        wall_seconds=1.0,
    )

    result = _run_transient_for_test(tmp_path / "case", SolverParams(urans_min_periods=3))

    assert result is not None
    assert pipeline.STARTUP_MAX_DELTA_T_FACTOR == 2.0
    initial_delta_t = period / 5000.0
    assert calls[0]["delta_t"] == pytest.approx(initial_delta_t)
    assert calls[0]["max_delta_t"] == pytest.approx(
        pipeline.STARTUP_MAX_DELTA_T_FACTOR * initial_delta_t
    )
    assert calls[0]["write_interval"] is None


def test_precalc_initial_chunk_uses_tier_target_not_profile_cycle_count(tmp_path, monkeypatch):
    """Precalc is a three-period preliminary tier, so a profile's legacy
    ten-cycle horizon must not make its first chunk integrate ten guessed
    periods before the measured-period controller can take over."""

    period = pipeline.physics.shedding_period(
        10.0,
        1.0,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    )
    calls = _install_continuation_fakes(
        monkeypatch,
        period=period,
        spans=[6.0 * period],
        wall_seconds=1.0,
    )
    solver = SolverParams(
        force_transient=True,
        urans_fidelity="precalc",
        urans_min_periods=3,
        transient_cycles=17,
        transient_discard_fraction=0.4,
    )

    result = _run_transient_for_test(tmp_path / "case", solver)

    assert result is not None
    # (3 required retained periods + 0.6 whole-cycle safety) / 60% retained.
    assert calls[0]["run_time"] == pytest.approx(6.0 * period)
    # The period is not known yet, so the very first chunk must already use
    # the physical slow-edge acquisition cadence.  Leaving this as ``None``
    # delegates to a generic renderer-oriented default and defeats the
    # controller's bounded-write promise before the first continuation.
    assert calls[0]["write_interval"] == pytest.approx(
        pipeline._period_acquisition_write_interval(period)
    )


def test_full_initial_chunk_keeps_profile_cycle_count(tmp_path, monkeypatch):
    period = pipeline.physics.shedding_period(
        10.0,
        1.0,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    )
    calls = _install_continuation_fakes(
        monkeypatch,
        period=period,
        spans=[13.0 * period],
        wall_seconds=1.0,
    )
    solver = SolverParams(
        force_transient=True,
        urans_fidelity="full",
        transient_cycles=13,
    )

    result = _run_transient_for_test(tmp_path / "case", solver)

    assert result is not None
    assert calls[0]["run_time"] == pytest.approx(13.0 * period)


def test_precalc_acquires_slow_plausible_period_in_same_case(tmp_path, monkeypatch):
    """At real St=0.1 the six-guess fast first chunk spans only 1.2 real
    cycles before startup discard, so declaring a missing period terminal would
    create a review. The controller must acquire more data in bounded same-case
    chunks until the physical period can lock."""

    guess = pipeline.physics.shedding_period(
        10.0,
        1.0,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    )
    actual_period = 5.0 * guess  # St=0.1 vs the St=0.5 initial guess.
    calls: list[dict] = []

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(
        tcase,
        *_args,
        run_time=None,
        write_interval=None,
        max_delta_t=None,
        coeff_start_time=None,
        refined=False,
        **_kwargs,
    ):
        start = pipeline._latest_time(tcase)
        end = start + float(run_time)
        (tcase / f"{end:.10g}").mkdir(exist_ok=True)
        locked = end + 1e-9 >= 20.0 * guess
        calls.append(
            {
                "run_time": run_time,
                "write_interval": write_interval,
                "max_delta_t": max_delta_t,
                "coeff_start_time": coeff_start_time,
                "refined": refined,
            }
        )
        return TransientResult(
            avg=SimpleNamespace(
                cl=0.7,
                cd=0.05,
                cm=-0.02,
                cl_cd=14.0,
                cl_std=0.07,
                cd_std=0.0,
                cm_std=0.0,
            ),
            case_dir=tcase,
            force_history=(
                _history_over(0.0, end, actual_period) if locked else None
            ),
            quality=UransQuality(
                ok=locked,
                can_refine=False,
                reason=(
                    "URANS quality target met."
                    if locked
                    else "URANS quality could not be measured: missing or flat shedding history."
                ),
                measured_period_s=actual_period if locked else None,
                retained_cycles=3.0 if locked else 0.0,
                frames_per_cycle=30.0 if locked else 0.0,
            ),
            start_time=start,
            end_time=end,
            run_time=float(run_time),
            wall_seconds=0.0,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_cycles=10,
            transient_discard_fraction=0.4,
        ),
        timeout=4 * 3600,
    )

    assert result is not None and result.quality.ok
    assert [call["run_time"] / guess for call in calls] == pytest.approx(
        [6.0, 4.0, 10.0]
    )
    assert all(not call["refined"] for call in calls)
    assert calls[1]["coeff_start_time"] == pytest.approx(0.0)
    assert calls[2]["coeff_start_time"] == pytest.approx(0.0)
    assert calls[1]["write_interval"] == pytest.approx(
        pipeline._period_acquisition_write_interval(guess)
    )
    assert calls[2]["max_delta_t"] == pytest.approx(
        pipeline._period_acquisition_write_interval(guess)
    )


def test_period_acquisition_cadence_is_bounded_at_slow_edge():
    """Unknown-period acquisition must not write ~300 states/slow cycle.

    With the current St=[0.05, 0.5] band a slow-edge period spans ten initial
    guesses.  The acquisition cadence records 30 states across that physical
    period; after a credible lock the live monitor owns measured-period / 30.
    """
    guess = pipeline.physics.shedding_period(
        10.0,
        1.0,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    )
    interval = pipeline._period_acquisition_write_interval(guess)
    slow_period = 1.0 / (pipeline.SHEDDING_STROUHAL_BAND[0] * 10.0)

    assert interval == pytest.approx(slow_period / pipeline.URANS_FRAME_WRITE_PER_CYCLE)
    horizon = pipeline._period_acquisition_horizons(
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            transient_discard_fraction=0.4,
        )
    )[-1] * guess
    assert horizon / interval == pytest.approx(111.0)


def test_period_acquisition_boundary_undershoot_keeps_one_guess_of_forward_progress(
    tmp_path,
    monkeypatch,
):
    """MUST-CATCH: an OpenFOAM end-time undershoot must not create a no-op.

    Production angle 12 reached about 19.5 of the 20 guessed-period boundary.
    Repeatedly asking for only the fractional remainder left the final force
    sample just below that boundary and eventually produced no measurable
    same-case advance.  The next acquisition chunk must own at least one full
    initial guess so it crosses the boundary and can select the later physical
    slow-edge horizon on the following grade.
    """

    guess = pipeline.physics.shedding_period(
        30.0,
        0.05,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    )
    tcase = tmp_path / "transient"
    span = 19.5 * guess
    (tcase / f"{span:.12g}").mkdir(parents=True)
    first = TransientResult(
        avg=None,
        case_dir=tcase,
        force_history=None,
        quality=UransQuality(
            ok=False,
            can_refine=False,
            reason=(
                "URANS quality could not be measured: missing or flat "
                "shedding history."
            ),
        ),
        start_time=0.0,
        end_time=span,
        run_time=span,
        wall_seconds=1.0,
    )
    calls: list[float] = []

    def fake_attempt(tcase, *_args, run_time=None, **_kwargs):
        chunk = float(run_time or 0.0)
        calls.append(chunk)
        end = pipeline._latest_time(tcase) + chunk
        (tcase / f"{end:.12g}").mkdir()
        return TransientResult(
            avg=None,
            case_dir=tcase,
            force_history=None,
            quality=UransQuality(
                ok=True,
                can_refine=False,
                reason="URANS quality target met.",
                measured_period_s=guess,
                retained_cycles=3.0,
                frames_per_cycle=30.0,
            ),
            start_time=span,
            end_time=end,
            run_time=chunk,
            wall_seconds=1.0,
        )

    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)
    result = pipeline._extend_transient_until_periods(
        tcase,
        first,
        0.0,
        None,
        None,
        {},
        CaseSpec(chord=0.05, speed=30.0, aoa_deg=12.0),
        None,
        None,
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.4,
        ),
        None,
        1,
        4 * 3600,
        guess / 5000.0,
    )

    assert result.quality.ok
    assert calls == pytest.approx([guess])


def test_precalc_period_acquisition_respects_budget_without_inventing_period(
    tmp_path, monkeypatch
):
    guess = pipeline.physics.shedding_period(
        10.0,
        1.0,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    )
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)
    (tcase / f"{6.0 * guess:.10g}").mkdir()
    first = TransientResult(
        avg=None,
        case_dir=tcase,
        force_history=None,
        quality=UransQuality(
            ok=False,
            can_refine=False,
            reason="URANS quality could not be measured: missing or flat shedding history.",
        ),
        start_time=0.0,
        end_time=6.0 * guess,
        run_time=6.0 * guess,
        wall_seconds=10_000.0,
    )
    attempted = False

    def fail_if_attempted(*_args, **_kwargs):
        nonlocal attempted
        attempted = True
        raise AssertionError("budget guard should stop before acquisition chunk")

    monkeypatch.setattr(pipeline, "_run_transient_attempt", fail_if_attempted)
    result = pipeline._extend_transient_until_periods(
        tcase,
        first,
        0.0,
        None,
        None,
        {},
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        None,
        None,
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.4,
        ),
        None,
        1,
        4 * 3600,
        guess / 5000.0,
    )

    assert not attempted
    assert pipeline.URANS_BUDGET_STOP_MARKER in result.quality.reason
    assert result.quality.measured_period_s is None


def test_fresh_chunk_monitor_switches_to_frame_write_cadence(tmp_path, monkeypatch):
    tcase = tmp_path / "transient"
    (tcase / "system").mkdir(parents=True)
    (tcase / "system" / "controlDict").write_text(
        "writeInterval 0.1;\nmaxDeltaT 0.1;\nrunTimeModifiable false;\n"
    )
    period = 0.6

    monkeypatch.setattr(pipeline, "_transient_coeff_selection", lambda *_args, **_kwargs: [tmp_path / "coefficient.dat"])
    monkeypatch.setattr(
        pipeline,
        "stable_two_period_window",
        lambda *_args, **_kwargs: pipeline.StablePeriodResult(
            ok=True,
            reason="two stable periods with sufficient frames",
            stable=True,
            period_s=period,
            window_start=0.6,
            window_end=1.0,
            cycles=2,
            frame_count=60,
            frames_per_cycle=30.0,
        ),
    )

    monitor = pipeline._make_urans_monitor(tcase, CaseSpec(chord=1.0, speed=10.0, aoa_deg=8.0))
    monitor()

    control = (tcase / "system" / "controlDict").read_text()
    assert pipeline.URANS_FRAME_WRITE_PER_CYCLE == pytest.approx(30.0)
    assert pipeline.URANS_MIN_FRAMES_PER_CYCLE == pytest.approx(20.0)
    assert f"writeInterval {period / pipeline.URANS_FRAME_WRITE_PER_CYCLE:.12g};" in control
    assert f"maxDeltaT {period / pipeline.URANS_FRAME_WRITE_PER_CYCLE:.12g};" in control


def test_live_monitor_releases_startup_courant_only_after_repeatable_periods(
    tmp_path,
    monkeypatch,
):
    """The startup Co cap stays until the physical tail repeats, then restores
    the configured throughput ceiling without restarting the same case."""
    tcase = tmp_path / "transient"
    (tcase / "system").mkdir(parents=True)
    (tcase / "system" / "controlDict").write_text(
        "maxCo 1;\nwriteInterval 0.1;\nmaxDeltaT 0.1;\n"
        "runTimeModifiable true;\n"
    )
    (tcase / "1").mkdir()
    verdicts = iter(
        [
            pipeline.StablePeriodResult(
                ok=False,
                reason="startup still settling",
                stable=False,
                period_s=0.2,
            ),
            pipeline.StablePeriodResult(
                ok=True,
                reason="two stable periods with sufficient frames",
                stable=True,
                period_s=0.2,
                window_start=0.6,
                window_end=1.0,
                cycles=2,
                frame_count=60,
                frames_per_cycle=30.0,
            ),
        ]
    )
    monkeypatch.setattr(
        pipeline,
        "_transient_coeff_selection",
        lambda *_args, **_kwargs: [tmp_path / "coefficient.dat"],
    )
    monkeypatch.setattr(
        pipeline,
        "stable_two_period_window",
        lambda *_args, **_kwargs: next(verdicts),
    )
    solver = SolverParams(
        force_transient=True,
        urans_fidelity="precalc",
        transient_max_courant=4.0,
    )
    monitor = pipeline._make_urans_monitor(
        tcase,
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=8.0),
        solver_params=solver,
        settled_max_courant=solver.transient_max_courant,
    )

    monitor()
    assert "maxCo 1;" in (tcase / "system" / "controlDict").read_text()

    monitor()
    assert "maxCo 4;" in (tcase / "system" / "controlDict").read_text()


def test_live_monitor_keeps_startup_courant_until_period_frames_are_publishable(
    tmp_path,
    monkeypatch,
):
    """A force-only cadence match must not release the startup timestep.

    Production can momentarily repeat an impulsive startup shape before enough
    field states exist to prove two usable periods.  ``stable=True`` without
    the complete frame-density verdict is therefore only a cadence hint, not
    permission to raise maxCo.
    """
    tcase = tmp_path / "transient"
    (tcase / "system").mkdir(parents=True)
    (tcase / "system" / "controlDict").write_text(
        "maxCo 1;\nwriteInterval 0.1;\nmaxDeltaT 0.1;\n"
        "runTimeModifiable true;\n"
    )
    (tcase / "1").mkdir()
    monkeypatch.setattr(
        pipeline,
        "_transient_coeff_selection",
        lambda *_args, **_kwargs: [tmp_path / "coefficient.dat"],
    )
    monkeypatch.setattr(
        pipeline,
        "stable_two_period_window",
        lambda *_args, **_kwargs: pipeline.StablePeriodResult(
            ok=False,
            reason="frames/cycle 3.00 < 20.00",
            stable=True,
            period_s=0.2,
            window_start=0.6,
            window_end=1.0,
            cycles=2,
            frame_count=6,
            frames_per_cycle=3.0,
        ),
    )
    solver = SolverParams(
        force_transient=True,
        urans_fidelity="precalc",
        transient_max_courant=4.0,
    )
    monitor = pipeline._make_urans_monitor(
        tcase,
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=8.0),
        solver_params=solver,
        settled_max_courant=solver.transient_max_courant,
    )

    monitor()

    control = (tcase / "system" / "controlDict").read_text()
    assert "maxCo 1;" in control
    assert "maxCo 4;" not in control
    assert "maxDeltaT 0.1;" in control


def test_live_control_dict_update_is_atomic_and_preserves_force_function(
    tmp_path, monkeypatch
):
    """OpenFOAM must never observe a truncated live controlDict.

    OpenCFD 2606 reloads ``runTimeModifiable`` dictionaries while pimpleFoam is
    active.  A truncate-and-rewrite update can be observed between those two
    operations, causing the live ``forceCoeffs`` function object to disappear
    while the solver continues.  The replacement file must be complete before
    it atomically becomes the live dictionary.
    """
    control = tmp_path / "controlDict"
    original = (
        "application pimpleFoam;\n"
        "endTime 1;\n"
        "writeInterval 0.1;\n"
        "functions\n"
        "{\n"
        "    forceCoeffs1\n"
        "    {\n"
        "        type forceCoeffs;\n"
        "    }\n"
        "}\n"
    )
    control.write_text(original)
    real_replace = pipeline.os.replace
    replacements = []

    def tracked_replace(source, destination):
        source = Path(source)
        destination = Path(destination)
        staged = source.read_text()
        # The old complete dictionary remains live until replacement.
        assert destination.read_text() == original
        assert "forceCoeffs1" in staged
        assert "writeInterval 0.02;" in staged
        replacements.append((source, destination))
        real_replace(source, destination)

    monkeypatch.setattr(pipeline.os, "replace", tracked_replace)

    pipeline._set_control_dict_entries(control, {"writeInterval": 0.02})

    assert len(replacements) == 1
    assert replacements[0][1] == control
    assert "forceCoeffs1" in control.read_text()
    assert "writeInterval 0.02;" in control.read_text()
    assert not list(tmp_path.glob(".controlDict.*.tmp"))


@pytest.mark.parametrize(
    ("fidelity", "min_periods", "expected_certification_cycles"),
    [("precalc", 3, 4.5), ("full", 7, 5.5)],
)
def test_early_stop_retention_is_fidelity_aware(
    tmp_path,
    monkeypatch,
    fidelity,
    min_periods,
    expected_certification_cycles,
):
    tcase = tmp_path / fidelity
    (tcase / "system").mkdir(parents=True)
    (tcase / "system" / "controlDict").write_text(
        "stopAt endTime;\nendTime 1;\nwriteInterval 0.1;\nmaxDeltaT 0.1;\nrunTimeModifiable true;\n"
    )
    (tcase / "1").mkdir()
    period = 0.5
    monkeypatch.setattr(
        pipeline,
        "_transient_coeff_selection",
        lambda *_args, **_kwargs: [tmp_path / "coefficient.dat"],
    )
    monkeypatch.setattr(
        pipeline,
        "stable_two_period_window",
        lambda *_args, **_kwargs: pipeline.StablePeriodResult(
            ok=True,
            reason="two stable periods with sufficient frames",
            stable=True,
            period_s=period,
            window_start=0.0,
            window_end=1.0,
            cycles=2,
            frame_count=60,
            frames_per_cycle=30.0,
        ),
    )
    solver = SolverParams(
        force_transient=True,
        urans_fidelity=fidelity,
        urans_min_periods=min_periods,
    )
    pipeline.write_march_budget_marker(
        tcase,
        end_t=1.0,
        budget_s=4321.0,
        wall_start=123.0,
    )

    monitor = pipeline._make_urans_monitor(
        tcase,
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=8.0),
        solver_params=solver,
    )
    monitor()

    control = (tcase / "system" / "controlDict").read_text()
    expected_end = expected_certification_cycles * period
    assert f"endTime {expected_end:.12g};" in control
    march = pipeline.read_march_budget_marker(tcase)
    assert march == {
        "end_t": pytest.approx(expected_end),
        "budget_s": pytest.approx(4321.0),
        "wall_start": pytest.approx(123.0),
    }


def test_precalc_early_stop_tolerates_monitor_period_undercut_and_is_accepted(
    tmp_path, monkeypatch
):
    """The live precalc stop span must satisfy its own final period check.

    The live two-period monitor and the final autocorrelation grader estimate
    the same physical cadence independently.  A small monitor under-estimate
    must not leave the final grader with fewer than two real periods in either
    half, otherwise a stable case repeatedly early-stops, rejects its marker,
    and starts another continuation chunk.
    """

    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, *_args, **_kwargs):
            pass

    period = 0.5
    monitor_period = 0.98 * period
    certification_cycles = 4.5
    certified_span = certification_cycles * monitor_period

    class FakeRunner:
        def solver(self, case_dir, *_args, **_kwargs):
            coeff = (
                case_dir
                / "postProcessing"
                / "forceCoeffs1"
                / "0"
                / "coefficient.dat"
            )
            times = np.linspace(0.0, certified_span, 2401)
            _write_coeff_rows(
                coeff,
                times,
                lambda t: 0.7 + 0.08 * math.sin(2 * math.pi * t / period),
            )
            for t in np.linspace(0.0, certified_span, 140):
                (case_dir / f"{t:.8g}").mkdir(exist_ok=True)
            pipeline._write_early_stop_marker(
                case_dir,
                pipeline.StablePeriodResult(
                    ok=True,
                    reason="two stable periods with sufficient frames",
                    stable=True,
                    period_s=monitor_period,
                    window_start=certified_span - 2.0 * monitor_period,
                    window_end=certified_span,
                    cycles=2,
                    frame_count=61,
                    frames_per_cycle=30.5,
                ),
                retain_from=0.0,
            )
            return SimpleNamespace(ok=True, stdout="pimple ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)
    solver = SolverParams(
        force_transient=True,
        urans_fidelity="precalc",
        urans_min_periods=3,
        transient_discard_fraction=0.0,
    )

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=solver,
        runner=FakeRunner(),
        n_proc=1,
        timeout=120,
        run_time=certified_span,
        delta_t=0.001,
        coeff_start_time=0.0,
    )

    assert pipeline._early_stop_certification_cycles(solver) == pytest.approx(
        certification_cycles
    )
    assert result is not None and result.early_stopped
    assert result.quality.ok
    assert not result.quality.can_refine
    assert result.quality.measured_period_s == pytest.approx(period, rel=0.01)
    assert result.quality.retained_cycles >= 3.0
    assert "early-stop target met" in result.quality.reason


def test_continuation_period_uses_full_merged_evidence_not_cropped_history(
    tmp_path,
):
    """Continuation cadence must use the same merged window as live grading.

    A preliminary ``ForceHistory`` intentionally keeps only the final three
    periods.  Its independent halves can never satisfy the two-period
    estimator floor, so using it for cadence produces a deterministic
    "half-window estimates unavailable" warning even when the merged restart
    evidence is long and settled.
    """

    period = 0.5
    first = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    second = (
        tmp_path
        / "postProcessing"
        / "forceCoeffs1"
        / "2.5"
        / "coefficient.dat"
    )
    _write_coeff_rows(
        first,
        np.linspace(0.0, 2.5, 1501),
        lambda t: 0.7 + 0.08 * math.sin(2 * math.pi * t / period),
    )
    _write_coeff_rows(
        second,
        np.linspace(2.5, 5.0, 1501),
        lambda t: 0.7 + 0.08 * math.sin(2 * math.pi * t / period),
    )
    cropped = _history_over(3.5, 5.0, period)
    cropped_estimate = estimate_period(
        cropped.t,
        cropped.cl,
        speed=10.0,
        chord=1.0,
        alpha_deg=15.0,
    )
    assert cropped_estimate is not None and cropped_estimate.ambiguous
    assert cropped_estimate.first_half_s is None
    assert cropped_estimate.second_half_s is None

    result = TransientResult(
        avg=SimpleNamespace(),
        case_dir=tmp_path,
        force_history=cropped,
        quality=UransQuality(
            ok=False,
            can_refine=True,
            reason="URANS window not stationary",
            measured_period_s=period,
        ),
        start_time=0.0,
        end_time=5.0,
        run_time=5.0,
        coeff_paths=[first, second],
    )
    merged_estimate = pipeline._continuation_period_estimate(
        tmp_path,
        result,
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            transient_discard_fraction=0.4,
        ),
    )

    assert merged_estimate is not None
    assert not merged_estimate.ambiguous
    assert merged_estimate.first_half_s == pytest.approx(period, rel=0.02)
    assert merged_estimate.second_half_s == pytest.approx(period, rel=0.02)


def test_same_case_chunks_share_one_monotonic_tier_deadline(tmp_path, monkeypatch):
    """A slowing continuation cannot receive a fresh full tier timeout.

    The first continuation gets only the four seconds left on the common
    deadline.  Once the fake chunk consumes five seconds, no second chunk is
    launched and the saved case is graded with the pinned budget-stop marker.
    """
    period = 0.5
    clock = [100.0]
    monkeypatch.setattr(pipeline.time, "monotonic", lambda: clock[0])
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)
    (tcase / "1").mkdir()
    first = TransientResult(
        avg=SimpleNamespace(
            cl=0.7,
            cd=0.05,
            cm=-0.02,
            cl_cd=14.0,
            cl_std=0.07,
            cd_std=0.0,
            cm_std=0.0,
        ),
        case_dir=tcase,
        force_history=_history_over(0.0, 1.0, period),
        quality=UransQuality(
            ok=False,
            can_refine=True,
            reason="retained cycles 1.20 < 3.00",
            measured_period_s=period,
            retained_cycles=1.2,
            frames_per_cycle=30.0,
        ),
        start_time=0.0,
        end_time=1.0,
        run_time=1.0,
        wall_seconds=0.0,
    )
    timeouts: list[float] = []

    def fake_attempt(case_dir, *_args, timeout=None, run_time=None, **_kwargs):
        # `_run_transient_attempt` receives its legacy solver timeout
        # positionally; the deadline is the new keyword-only controller input.
        effective_timeout = timeout if timeout is not None else _args[-1]
        timeouts.append(float(effective_timeout))
        start = pipeline._latest_time(case_dir)
        end = start + float(run_time)
        (case_dir / f"{end:.10g}").mkdir()
        clock[0] += 5.0
        return TransientResult(
            avg=first.avg,
            case_dir=case_dir,
            force_history=_history_over(0.0, end, period),
            quality=UransQuality(
                ok=False,
                can_refine=True,
                reason="URANS window not stationary",
                measured_period_s=period,
                retained_cycles=3.0,
                frames_per_cycle=30.0,
            ),
            start_time=start,
            end_time=end,
            run_time=float(run_time),
            wall_seconds=5.0,
        )

    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)
    result = pipeline._extend_transient_until_periods(
        tcase,
        first,
        0.0,
        None,
        None,
        {},
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        None,
        None,
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.4,
        ),
        None,
        1,
        10.0,
        period / 5000.0,
        deadline=104.0,
    )

    assert timeouts == pytest.approx([4.0])
    assert pipeline.URANS_BUDGET_STOP_MARKER in result.quality.reason


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
    # chunk sized to close the deficit PLUS the whole-cycle safety margin:
    # quality counts INTEGER cycles, so exact-target sizing graded prod
    # naca-4412 −15° span ~2.8 as "2.00 < 3.00" twice.
    assert calls[1]["run_time"] == pytest.approx((4 + 0.6 - 1.2) * period / 0.6, rel=0.05)
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


def test_continuation_extends_underretained_sparse_nonstationary_window(tmp_path, monkeypatch):
    """Prod shape: precalc retained 2.00/3.00 cycles at 19.5 frames/cycle and
    then reported the established-oscillation window as not stationary. That is
    still a measurable shedding window; another continuation chunk fixes both
    retained cycles and the field-write cadence when budget allows."""

    period = 0.5
    spans = [1.0, 1.5]
    calls: list[dict] = []

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(
        tcase,
        *_args,
        run_time=None,
        write_interval=None,
        max_delta_t=None,
        coeff_start_time=None,
        refined=False,
        **_kwargs,
    ):
        k = len(calls)
        calls.append(
            {
                "run_time": run_time,
                "write_interval": write_interval,
                "max_delta_t": max_delta_t,
                "coeff_start_time": coeff_start_time,
                "refined": refined,
            }
        )
        end = spans[min(k, len(spans) - 1)]
        (tcase / f"{end:.10g}").mkdir(exist_ok=True)
        ok = k >= 1
        return TransientResult(
            avg=SimpleNamespace(cl=0.7, cd=0.05, cm=-0.02, cl_cd=14.0, cl_std=0.07, cd_std=0.0, cm_std=0.0),
            case_dir=tcase,
            force_history=_history_over(0.0, end, period),
            quality=UransQuality(
                ok=ok,
                can_refine=False,
                reason=(
                    "URANS quality target met."
                    if ok
                    else (
                        "retained cycles 2.00 < 3.00; frames/cycle 19.50 < 20.00; "
                        "URANS window not stationary (precalc established-oscillation test): "
                        "only 2 whole cycles retained"
                    )
                ),
                measured_period_s=period,
                retained_cycles=end / period,
                retained_frame_count=60 if ok else 39,
                frames_per_cycle=20.0 if ok else 19.5,
            ),
            start_time=0.0 if k == 0 else spans[k - 1],
            end_time=end,
            run_time=end if k == 0 else end - spans[k - 1],
            wall_seconds=10.0,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.0,
        ),
        timeout=4 * 3600,
    )

    assert len(calls) == 2
    # The sparse published window is replaced by three dense measured-cadence
    # periods in one same-case chunk (also covers the 3-period target deficit).
    assert calls[1]["run_time"] == pytest.approx(
        pipeline.URANS_FRAME_SPAN_PERIODS * period, rel=0.01
    )
    assert calls[1]["write_interval"] == pytest.approx(
        period / pipeline.URANS_FRAME_WRITE_PER_CYCLE,
        rel=0.01,
    )
    assert calls[1]["max_delta_t"] == pytest.approx(
        period / pipeline.URANS_FRAME_WRITE_PER_CYCLE,
        rel=0.01,
    )
    assert result is not None
    assert result.quality.ok


@pytest.mark.parametrize(
    ("first_reason", "frames_per_cycle", "expected_chunk_periods"),
    [
        ("frames/cycle 10.67 < 20.00", 10.67, 3.0),
        (
            "URANS window not stationary (precalc established-oscillation test): "
            "cycle means trend upward monotonically",
            30.0,
            3.0,
        ),
    ],
)
def test_precalc_continues_same_case_after_period_target_for_sparse_or_nonstationary_window(
    tmp_path,
    monkeypatch,
    first_reason,
    frames_per_cycle,
    expected_chunk_periods,
):
    """Production had 25 rejected precalc rows with >=3 periods. Fifteen were
    sparse and all were nonstationary, but the retained-period break prevented
    a dense same-case continuation and sent them toward terminal review."""

    period = 0.5
    spans = [2.0, 2.5]
    calls: list[dict] = []

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(
        tcase,
        *_args,
        run_time=None,
        write_interval=None,
        max_delta_t=None,
        coeff_start_time=None,
        refined=False,
        **_kwargs,
    ):
        k = len(calls)
        calls.append(
            {
                "run_time": run_time,
                "write_interval": write_interval,
                "max_delta_t": max_delta_t,
                "coeff_start_time": coeff_start_time,
                "refined": refined,
            }
        )
        end = spans[min(k, len(spans) - 1)]
        (tcase / f"{end:.10g}").mkdir(exist_ok=True)
        # The relaxing signal clears only after a meaningful newly measured
        # tail. The former one-period extension must not pass this must-catch.
        ok = (
            k >= 1
            and float(run_time or 0.0)
            >= 0.99 * expected_chunk_periods * period
        )
        return TransientResult(
            avg=SimpleNamespace(
                cl=0.7,
                cd=0.05,
                cm=-0.02,
                cl_cd=14.0,
                cl_std=0.07,
                cd_std=0.0,
                cm_std=0.0,
            ),
            case_dir=tcase,
            force_history=_history_over(0.0, end, period),
            quality=UransQuality(
                ok=ok,
                can_refine=not ok,
                reason="URANS quality target met." if ok else first_reason,
                measured_period_s=period,
                retained_cycles=end / period,
                retained_frame_count=round(frames_per_cycle * end / period),
                frames_per_cycle=30.0 if ok else frames_per_cycle,
            ),
            start_time=0.0 if k == 0 else spans[k - 1],
            end_time=end,
            run_time=end if k == 0 else end - spans[k - 1],
            wall_seconds=10.0,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.0,
        ),
        timeout=4 * 3600,
    )

    assert len(calls) == 2
    assert not calls[1]["refined"]
    assert calls[1]["coeff_start_time"] == pytest.approx(0.0)
    assert calls[1]["run_time"] == pytest.approx(expected_chunk_periods * period)
    assert calls[1]["write_interval"] == pytest.approx(
        period / pipeline.URANS_FRAME_WRITE_PER_CYCLE
    )
    assert calls[1]["max_delta_t"] == pytest.approx(
        period / pipeline.URANS_FRAME_WRITE_PER_CYCLE
    )
    assert result is not None and result.quality.ok


def test_full_strict_drift_gets_measured_same_case_tail_before_refinement(
    tmp_path,
    monkeypatch,
):
    """A target-satisfied full run that misses the strict mean-drift gate is
    normal corrective integration, not a completed attempt or a copied fresh
    trajectory.  Three measured periods must be added to the same case first.
    """

    period = 0.5
    calls = _install_continuation_fakes(
        monkeypatch,
        period=period,
        spans=[4.0, 5.5],
        wall_seconds=1.0,
        failure_reason=(
            "URANS window not stationary: Cl drift 0.091 exceeds tolerance "
            "0.05 over 8 whole periods"
        ),
    )

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            force_transient=True,
            urans_fidelity="full",
            transient_discard_fraction=0.0,
        ),
        timeout=43_200,
    )

    assert len(calls) == 2
    assert calls[1]["refined"] is False
    assert calls[1]["coeff_start_time"] == pytest.approx(0.0)
    assert calls[1]["run_time"] == pytest.approx(
        pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS * period
    )
    assert calls[1]["write_interval"] == pytest.approx(
        period / pipeline.URANS_FRAME_WRITE_PER_CYCLE
    )
    assert result is not None and result.quality.ok


@pytest.mark.parametrize(
    "failure_reason",
    [
        (
            "URANS strict stationarity verdict unavailable: grading error "
            "(ValueError); prior force-history grade: URANS quality target met."
        ),
        (
            "URANS strict stationarity verdict unavailable: no whole-period "
            "statistics; prior force-history grade: URANS quality target met."
        ),
    ],
)
def test_full_strict_unavailable_gets_same_case_tail_before_refinement(
    tmp_path,
    monkeypatch,
    failure_reason,
):
    """A transient strict-grader disagreement is a request for more evidence,
    not permission to discard a target-satisfied trajectory and copy a fresh
    refined child."""

    period = 0.5
    calls = _install_continuation_fakes(
        monkeypatch,
        period=period,
        spans=[4.0, 5.5],
        wall_seconds=1.0,
        failure_reason=failure_reason,
    )

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            force_transient=True,
            urans_fidelity="full",
            transient_discard_fraction=0.0,
        ),
        timeout=43_200,
    )

    assert len(calls) == 2
    assert all(call["case"] == "transient" for call in calls)
    assert all(call["refined"] is False for call in calls)
    assert calls[1]["run_time"] == pytest.approx(
        pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS * period
    )
    assert result is not None and result.quality.ok


def test_full_strict_drift_on_refined_pass_is_extended_before_return(
    tmp_path,
    monkeypatch,
):
    """A cadence-driven copied refinement has its own live strict verdict.
    If that verdict still drifts, the refined case itself must continue rather
    than escaping directly to the finalizer as rejected evidence.
    """

    period = pipeline.physics.shedding_period(
        10.0,
        1.0,
        strouhal=pipeline.TRANSIENT_INITIAL_STROUHAL,
    )
    calls: list[dict[str, object]] = []

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(
        tcase,
        *_args,
        run_time=None,
        coeff_start_time=None,
        refined=False,
        **_kwargs,
    ):
        index = len(calls)
        start = pipeline._latest_time(tcase)
        end = start + float(run_time)
        (tcase / f"{end:.10g}").mkdir(exist_ok=True)
        calls.append(
            {
                "case": Path(tcase).name,
                "refined": refined,
                "run_time": run_time,
                "coeff_start_time": coeff_start_time,
            }
        )
        if index == 0:
            quality = UransQuality(
                ok=False,
                can_refine=True,
                reason="frames/cycle 10.00 < 20.00",
                measured_period_s=period,
                retained_cycles=8.0,
                frames_per_cycle=10.0,
            )
        elif index == 1:
            quality = UransQuality(
                ok=False,
                can_refine=True,
                reason=(
                    "URANS window not stationary: Cl drift 0.083 exceeds "
                    "tolerance 0.05 over 8 whole periods"
                ),
                measured_period_s=period,
                retained_cycles=8.0,
                frames_per_cycle=30.0,
            )
        else:
            quality = UransQuality(
                ok=True,
                can_refine=False,
                reason="URANS quality target met.",
                measured_period_s=period,
                retained_cycles=11.0,
                frames_per_cycle=30.0,
            )
        return TransientResult(
            avg=SimpleNamespace(
                cl=0.7,
                cd=0.05,
                cm=-0.02,
                cl_cd=14.0,
                cl_std=0.07,
                cd_std=0.0,
                cm_std=0.0,
            ),
            case_dir=Path(tcase),
            force_history=_history_over(0.0, end, period),
            quality=quality,
            start_time=start,
            end_time=end,
            run_time=float(run_time),
            refined=refined,
            wall_seconds=1.0,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            force_transient=True,
            urans_fidelity="full",
            transient_discard_fraction=0.0,
        ),
        timeout=43_200,
    )

    assert [(call["case"], call["refined"]) for call in calls] == [
        ("transient", False),
        ("transient_refined", True),
        ("transient_refined", True),
    ]
    assert calls[2]["run_time"] == pytest.approx(
        pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS * period
    )
    assert result is not None and result.refined and result.quality.ok


def test_persistent_full_strict_drift_stays_restartable_without_copied_rerun(
    tmp_path,
    monkeypatch,
):
    """The emergency bound is not permission to discard a full trajectory.
    Preserve the same-case checkpoint for the durable final recovery lane.
    """

    period = 0.5
    calls = _install_continuation_fakes(
        monkeypatch,
        period=period,
        spans=[
            4.0
            + i * pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS * period
            for i in range(pipeline.URANS_CONTINUATION_MAX_CHUNKS + 1)
        ],
        wall_seconds=1.0,
        quality_ok_at_end=False,
        failure_reason=(
            "URANS window not stationary: Cl drift 0.083 exceeds tolerance "
            "0.05 over 8 whole periods"
        ),
        failure_frames_per_cycle=30.0,
    )

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            force_transient=True,
            urans_fidelity="full",
            transient_discard_fraction=0.0,
        ),
        timeout=43_200,
    )

    assert len(calls) == 1 + pipeline.URANS_CONTINUATION_MAX_CHUNKS
    assert all(call["refined"] is False for call in calls)
    assert result is not None and not result.quality.ok
    assert pipeline.URANS_CONTINUATION_REQUIRED_MARKER in result.quality.reason
    assert "restartable saved case state" in result.quality.reason


def test_precalc_slow_relaxation_can_settle_after_legacy_24_chunk_cap(
    tmp_path,
    monkeypatch,
):
    """MUST-CATCH: the emergency guard must not preempt the wall budget.

    The production A63A108C/AoA 18 retry still had a monotonically relaxing
    retained context after 24 continuation chunks, while its latest certified
    tail was already locally stable and most of the tier budget remained.  A
    later same-case chunk can clear that honest stationarity gate; stopping at
    the legacy cap manufactures a terminal quality failure from healthy CFD.
    """

    period = 0.5
    settling_call = 27
    calls = _install_continuation_fakes(
        monkeypatch,
        period=period,
        spans=[
            2.0 + i * pipeline.URANS_NONSTATIONARY_EXTENSION_PERIODS * period
            for i in range(settling_call)
        ],
        wall_seconds=1.0,
        quality_ok_at_end=True,
        failure_reason=(
            "URANS window not stationary (precalc established-oscillation test): "
            "cycle means trend downward monotonically"
        ),
        failure_frames_per_cycle=30.0,
    )

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.4,
        ),
        timeout=14_400,
    )

    assert len(calls) == settling_call
    assert result is not None and result.quality.ok
    assert pipeline.URANS_CONTINUATION_REQUIRED_MARKER not in result.quality.reason


def test_same_case_extension_stops_after_one_chunk_without_physical_progress(
    tmp_path,
    monkeypatch,
):
    """MUST-CATCH: a successful process exit that advances neither saved
    simulated time nor force history cannot consume all 24 continuation chunks.
    """

    period = 0.5
    calls = 0

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(tcase, *_args, run_time=None, **_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            (tcase / "4").mkdir(exist_ok=True)
        history = _history_over(0.0, 4.0, period)
        return TransientResult(
            avg=SimpleNamespace(
                cl=0.7,
                cd=0.05,
                cm=-0.02,
                cl_cd=14.0,
                cl_std=0.07,
                cd_std=0.0,
                cm_std=0.0,
            ),
            case_dir=Path(tcase),
            force_history=history,
            quality=UransQuality(
                ok=False,
                can_refine=True,
                reason="URANS window not stationary",
                measured_period_s=period,
                retained_cycles=4.0,
                frames_per_cycle=30.0,
            ),
            start_time=0.0 if calls == 1 else 4.0,
            end_time=4.0,
            run_time=float(run_time or 0.0),
            wall_seconds=1.0,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            force_transient=True,
            urans_fidelity="full",
            transient_discard_fraction=0.0,
        ),
        timeout=43_200,
    )

    assert calls == 2
    assert result is not None and not result.quality.ok
    assert pipeline.URANS_CONTINUATION_REQUIRED_MARKER in result.quality.reason
    assert "no measurable simulated-time or force-history advance" in result.quality.reason


def test_sparse_only_tail_adds_three_periods_without_reapplying_startup_discard(
    tmp_path, monkeypatch
):
    """Once aerodynamics are retained, only three new dense periods are needed.

    The 40% startup discard is global over the coefficient history; it does not
    apply to replacement of the final media tail. The old math divided the
    three-period tail by 0.6 and scheduled five unnecessary periods.
    """
    period = 0.5
    calls = _install_continuation_fakes(
        monkeypatch,
        period=period,
        spans=[3.0, 4.5],
        wall_seconds=1.0,
        failure_reason="frames/cycle 10.00 < 20.00",
        failure_frames_per_cycle=10.0,
    )

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.4,
        ),
        timeout=4 * 3600,
    )

    assert len(calls) == 2
    assert calls[1]["run_time"] == pytest.approx(
        pipeline.URANS_FRAME_SPAN_PERIODS * period
    )
    assert result is not None and result.quality.ok


@pytest.mark.parametrize(
    ("failure_reason", "frames_per_cycle", "expects_continuation"),
    [
        (
            "URANS window not stationary (precalc established-oscillation test)",
            30.0,
            True,
        ),
        ("frames/cycle 10.00 < 20.00", 10.0, False),
    ],
)
def test_precalc_same_case_continuation_is_bounded_without_copied_refine(
    tmp_path,
    monkeypatch,
    failure_reason,
    frames_per_cycle,
    expects_continuation,
):
    """If dense same-case chunks cannot clear the quality gate, stop at the
    controller's existing bound; never discard that trajectory for a separate
    ``transient_refined`` rerun."""

    period = 0.5
    calls = _install_continuation_fakes(
        monkeypatch,
        period=period,
        spans=[
            2.0 + i * period
            for i in range(pipeline.URANS_CONTINUATION_MAX_CHUNKS + 1)
        ],
        wall_seconds=1.0,
        quality_ok_at_end=False,
        failure_reason=failure_reason,
        failure_frames_per_cycle=frames_per_cycle,
    )

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(
            force_transient=True,
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.0,
        ),
        timeout=4 * 3600,
    )

    assert len(calls) == 1 + pipeline.URANS_CONTINUATION_MAX_CHUNKS
    assert all(not call["refined"] for call in calls)
    assert result is not None and not result.quality.ok
    assert (
        pipeline.URANS_CONTINUATION_REQUIRED_MARKER in result.quality.reason
    ) is expects_continuation
    assert ("frame-recorder remediation" in result.quality.reason) is (
        not expects_continuation
    )
    assert pipeline.URANS_BUDGET_STOP_MARKER not in result.quality.reason
    assert (
        f"{pipeline.URANS_CONTINUATION_MAX_CHUNKS}-chunk emergency safety cap"
        in result.quality.reason
    )


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
            raise HardSolverError("pimpleFoam diverged: SIGFPE in GAMG at t=1.31")
        return fake(*args, **kwargs)

    monkeypatch.setattr(pipeline, "_run_transient_attempt", crash_on_chunk)
    result = _run_transient_for_test(tmp_path / "case", SolverParams(), timeout=7200)

    assert result is not None
    assert not result.quality.ok and not result.quality.can_refine
    assert "numerical recovery failed after retaining 1.2 of 7 periods" in result.quality.reason
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

    result = _run_transient_for_test(
        tmp_path / "case",
        SolverParams(force_transient=True, urans_fidelity="precalc"),
    )

    assert calls == [False]  # no continuation, no refine
    assert result is not None
    assert result.quality.no_shedding


# --------------------------------------------------------------------------- #
# Frame targeting: all written states in the retained player window up to cap
# --------------------------------------------------------------------------- #


def test_frame_target_times_cover_last_three_periods_at_frame_write_cadence():
    targets = frame_target_times(window_end=10.0, period_s=0.5, whole_periods=7)

    assert len(targets) == 90  # 30 * min(3, 7)
    assert targets[-1] == pytest.approx(10.0)
    assert min(targets) > 10.0 - 3 * 0.5  # start phase excluded (no duplicate)
    steps = np.diff(targets)
    assert np.allclose(steps, steps[0])
    assert steps[0] == pytest.approx(0.5 / 30)


def test_frame_target_times_cap_and_short_run_behaviour():
    assert len(frame_target_times(1.0, 0.01, 7, span_periods=7)) == 120  # 30*7 -> capped
    assert len(frame_target_times(1.0, 0.4, 2)) == 60  # K=2 -> 2 periods
    assert len(frame_target_times(1.0, 0.4, 1)) == 30  # K=1 -> 1 period
    assert frame_target_times(1.0, 0.0, 3) == []
    assert frame_target_times(1.0, 0.4, 0) == []


def test_frame_target_times_use_every_written_state_up_to_cap():
    period = 0.5
    window_end = 10.0
    start = window_end - 3 * period
    written = [start + (i + 1) * period / pipeline.URANS_FRAME_WRITE_PER_CYCLE for i in range(90)]

    targets = frame_target_times(window_end, period, 7, written_times=written)

    assert len(targets) == 90
    assert targets == pytest.approx(written)
    assert nearest_vtu_indices(written, targets) == list(range(90))


def test_frame_target_times_evenly_caps_dense_written_states():
    period = 0.5
    window_end = 10.0
    start = window_end - 3 * period
    written = [start + (i + 1) * (3 * period) / 150 for i in range(150)]

    targets = frame_target_times(window_end, period, 7, written_times=written)

    assert len(targets) == FRAME_TRACK_MAX_FRAMES
    assert targets[0] == pytest.approx(written[0])
    assert targets[-1] == pytest.approx(written[-1])
    assert nearest_vtu_indices(written, targets) == sorted(set(nearest_vtu_indices(written, targets)))


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


def test_finalize_rejects_missing_half_period_without_format_error(tmp_path, monkeypatch):
    """Final frame-track grading fails closed and records a safe diagnostic."""

    period = 0.5
    transient = _fake_transient_with_series(tmp_path, period=period)
    monkeypatch.setattr(
        pipeline,
        "estimate_period",
        lambda *_args, **_kwargs: PeriodEstimate(
            period_s=period,
            ambiguous=True,
            first_half_s=None,
            second_half_s=period,
        ),
    )

    outcome = _finalize_with(
        tmp_path,
        transient,
        monkeypatch,
        solver_params=SolverParams(
            force_transient=True,
            write_images=[],
            urans_fidelity="precalc",
            urans_min_periods=3,
            transient_discard_fraction=0.0,
        ),
    )

    assert outcome.frame_track is not None
    assert not outcome.frame_track.stationary
    assert any(
        "period ambiguous" in warning.lower() and "unavailable" in warning.lower()
        for warning in outcome.quality_warnings
    )


def test_finalize_does_not_mark_uncorroborated_fallback_period_stationary(
    tmp_path, monkeypatch
):
    """Live and final precalc grading must fail closed on the same evidence.

    The force-history FFT period may size a continuation, but when the
    autocorrelation/half-window estimator returns ``None`` it is not a stable
    period verdict.  Finalization used to fall back to that FFT period and pass
    ``period_stable=True``, contradicting the live gate and publishing a false
    ``frame_track.stationary=true``.
    """

    period = 0.5
    transient = _fake_transient_with_series(tmp_path, period=period)
    monkeypatch.setattr(pipeline, "estimate_period", lambda *_args, **_kwargs: None)
    archived: dict[str, CaseOutcome] = {}
    monkeypatch.setattr(
        pipeline,
        "_archive_case_evidence",
        lambda _case_dir, _post_dir, outcome, **_kwargs: archived.setdefault(
            "outcome", outcome
        ),
    )

    with pytest.raises(
        HardSolverError,
        match="certification window unavailable during finalization",
    ):
        _finalize_with(
            tmp_path,
            transient,
            monkeypatch,
            solver_params=SolverParams(
                force_transient=True,
                write_images=[],
                urans_fidelity="precalc",
                urans_min_periods=3,
                transient_discard_fraction=0.0,
            ),
        )

    outcome = archived["outcome"]
    assert outcome.frame_track is not None
    assert outcome.frame_track.period_s == pytest.approx(period)
    assert not outcome.frame_track.stationary
    assert not outcome.converged
    assert any(
        "certification window unavailable" in warning.lower()
        for warning in outcome.quality_warnings
    )
    assert any("not stationary" in warning.lower() for warning in outcome.quality_warnings)


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


def _publish_as_verified_remote(publication, _settings):
    pointer = RemoteEvidencePointer(
        bucket="airfoils-pro-storage-bucket",
        object_key=(
            "solver-evidence/v1/sha256/"
            f"{publication.archive.stored_sha256[:2]}/"
            f"{publication.archive.stored_sha256}.tar.zst"
        ),
        generation=1_752_612_345_678_901,
        stored_sha256=publication.archive.stored_sha256,
        stored_size=publication.archive.stored_size,
        tar_sha256=publication.archive.tar_sha256,
        tar_size=publication.archive.tar_size,
        crc32c="AAAAAA==",
        zstd_level=publication.archive.zstd_level,
        created_at="2026-07-15T20:50:14+00:00",
    )
    publication.pointer_path.write_text(
        json.dumps(pointer.to_dict(), sort_keys=True), encoding="utf-8"
    )
    return replace(publication, pointer=pointer)


def test_remote_evidence_removes_raw_but_retains_archive_until_database_ack(
    tmp_path, monkeypatch
):
    case_dir = tmp_path / "case"
    (case_dir / "system").mkdir(parents=True)
    (case_dir / "system" / "controlDict").write_text("application simpleFoam;\n")
    outcome = CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=0.0), reynolds=666_666
    )
    settings = Settings(
        data_dir=tmp_path,
        evidence_bucket="airfoils-pro-storage-bucket",
        evidence_remote_only=True,
        control_plane_token="test-control-plane-token-32-bytes-minimum",
    )
    monkeypatch.setattr(pipeline, "get_settings", lambda: settings)
    monkeypatch.setattr(
        pipeline, "publish_evidence_archive", _publish_as_verified_remote
    )
    monkeypatch.setattr(
        pipeline,
        "verify_remote_evidence_restore",
        lambda *_args: "archive+manifest+all-members-restore:1",
    )
    _archive_case_evidence(case_dir, case_dir, outcome)

    bundle = next(
        artifact for artifact in outcome.evidence_artifacts if artifact.kind == "engine_bundle"
    )
    assert bundle.metadata["storageBackend"] == "gcs"
    assert bundle.metadata["generation"] == "1752612345678901"
    assert (
        bundle.metadata["localEvidenceDisposition"]
        == "remote-copy-plus-local-archive-pending-database-ack"
    )
    assert bundle.metadata["rawLocalEvidenceDisposition"] == "removed"
    assert bundle.metadata["localArchiveRetainedUntilDatabaseAck"] is True
    assert not (case_dir / "evidence" / "openfoam").exists()
    assert (case_dir / "evidence" / "engine_evidence.tar.zst").is_file()
    assert (case_dir / "evidence" / "engine_evidence.remote.json").is_file()
    assert (case_dir / "evidence" / "evidence_manifest.json").is_file()


def test_remote_member_restore_failure_preserves_raw_and_local_archive(
    tmp_path, monkeypatch
):
    case_dir = tmp_path / "case"
    (case_dir / "system").mkdir(parents=True)
    (case_dir / "system" / "controlDict").write_text(
        "application simpleFoam;\n"
    )
    outcome = CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=0.0),
        reynolds=666_666,
    )
    settings = Settings(
        data_dir=tmp_path,
        evidence_bucket="airfoils-pro-storage-bucket",
        evidence_remote_only=True,
        control_plane_token="test-control-plane-token-32-bytes-minimum",
    )
    monkeypatch.setattr(pipeline, "get_settings", lambda: settings)
    monkeypatch.setattr(
        pipeline, "publish_evidence_archive", _publish_as_verified_remote
    )
    monkeypatch.setattr(
        pipeline,
        "verify_remote_evidence_restore",
        lambda *_args: (_ for _ in ()).throw(
            EvidenceStoreError("manifest member missing from archive")
        ),
    )

    _archive_case_evidence(case_dir, case_dir, outcome)

    bundle = next(
        artifact
        for artifact in outcome.evidence_artifacts
        if artifact.kind == "engine_bundle"
    )
    assert bundle.metadata["rawLocalEvidenceDisposition"] == "retained"
    assert (case_dir / "evidence" / "openfoam").is_dir()
    assert (case_dir / "evidence" / "engine_evidence.tar.zst").is_file()
    assert any("raw cleanup pending" in warning for warning in outcome.quality_warnings)


def test_completed_solve_survives_remote_publish_failure_with_local_evidence(
    tmp_path, monkeypatch
):
    """A GCS outage after CFD completion must not turn the solve into failure.

    Exercise the normal finalization path (including coefficient finalization,
    evidence collection, manifest generation, and real tar.zst creation), not
    only the archive helper in isolation.  The retained package is the durable
    input for a later migration retry, while the unpacked source remains
    immediately usable for evidence rendering.
    """
    settings = Settings(
        data_dir=tmp_path,
        evidence_bucket="airfoils-pro-storage-bucket",
        evidence_remote_only=True,
        control_plane_token="test-control-plane-token-32-bytes-minimum",
    )
    monkeypatch.setattr(pipeline, "get_settings", lambda: settings)
    monkeypatch.setattr(
        pipeline,
        "publish_evidence_archive",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            EvidenceStoreError("simulated GCS credentials outage")
        ),
    )
    transient = _fake_transient_with_series(tmp_path, period=0.5)

    outcome = _finalize_with(tmp_path, transient, monkeypatch)

    assert outcome.cl == pytest.approx(0.75, abs=1e-3)
    assert outcome.frame_track is not None
    bundle = next(
        artifact for artifact in outcome.evidence_artifacts if artifact.kind == "engine_bundle"
    )
    assert bundle.metadata["localEvidenceDisposition"] == "volume"
    assert (tmp_path / "evidence" / "engine_evidence.tar.zst").is_file()
    assert (tmp_path / "evidence" / "openfoam").is_dir()
    assert (tmp_path / "evidence" / "evidence_manifest.json").is_file()
    assert not (tmp_path / "evidence" / "engine_evidence.remote.json").exists()
    assert any(
        "remote evidence archival pending" in warning
        for warning in outcome.quality_warnings
    )


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


def test_precalc_finalizer_reuses_live_trailing_certification_window(
    tmp_path, monkeypatch
):
    """MUST-CATCH: live acceptance and publication use one exact tail.

    The complete merged trajectory deliberately averages to 0.828264 because
    it retains a long lower-mean startup.  Its final 4.5-cycle certification
    horizon is a stationary limit cycle centred on 0.88.  Recomputing the full
    post-discard history in ``_finalize_outcome`` used to replace the accepted
    live value and emit a contradictory non-stationary warning.
    """

    period = 0.5
    solver_params = SolverParams(
        force_transient=True,
        write_images=[],
        urans_fidelity="precalc",
        urans_min_periods=3,
        transient_discard_fraction=0.0,
    )
    transient = _fake_transient_with_series(tmp_path, period=period)
    coeff = transient.coeff_paths[0]
    ts = np.linspace(600.0, 606.0, 2401)
    startup_mean = 0.7972224
    settled_at = 603.75
    _write_coeff_rows(
        coeff,
        ts,
        lambda t: (
            startup_mean if t < settled_at else 0.88
        )
        + 0.05 * math.sin(2 * math.pi * t / period),
    )
    # The live gate grades field density over the same exported last-three-
    # period player window.  These are real saved-state directories.
    for t in np.linspace(604.5, 606.0, 91):
        (transient.case_dir / f"{float(t):.10g}").mkdir(exist_ok=True)

    t_all, cl_all, cd_all, cm_all = coefficient_series([coeff])
    full_stats = period_window_stats(
        t_all,
        cl_all,
        cd_all,
        cm_all,
        period,
        established_oscillation=True,
    )
    assert full_stats is not None
    assert full_stats.cl.mean == pytest.approx(0.828264, abs=3e-4)
    assert not full_stats.stationary

    quality = pipeline._grade_precalc_established_oscillation(
        transient.case_dir,
        [coeff],
        CaseSpec(chord=1.0, speed=10.0, aoa_deg=12.0),
        solver_params,
        UransQuality(
            ok=True,
            can_refine=False,
            reason="URANS quality target met.",
            measured_period_s=period,
        ),
        early_stopped=False,
    )
    assert quality.ok, quality.reason

    outcome = _finalize_with(
        tmp_path,
        replace(transient, quality=quality),
        monkeypatch,
        solver_params=solver_params,
    )

    assert outcome.cl == pytest.approx(0.88, abs=2e-3)
    assert outcome.frame_track is not None
    assert outcome.frame_track.stationary
    assert outcome.frame_track.window.t_start >= settled_at - 1e-6
    assert not any(
        "not stationary" in warning.lower()
        for warning in outcome.quality_warnings
    )


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
    import zstandard as _zstandard

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
    with (case_dir / "evidence" / "engine_evidence.tar.zst").open("rb") as compressed:
        with _zstandard.ZstdDecompressor().stream_reader(
            compressed, read_across_frames=True
        ) as raw_tar:
            with _tarfile.open(fileobj=raw_tar, mode="r|") as tar:
                names = [member.name for member in tar]
    assert not any(n == "frames" or n.startswith("frames/") for n in names)
    # The manifest itself still ships in the bundle.
    assert "evidence_manifest.json" in names
