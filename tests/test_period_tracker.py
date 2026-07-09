"""Hardened URANS period tracker (prod incident 2026-07-07, airfoils.pro).

Two identical naca-0012 alpha=15 precalc solves (U=25 m/s, c=0.1 m) measured
wildly different periods: the unconstrained autocorrelation tracker locked
onto a ~0.12 s sub-harmonic / low-frequency modulation of the broadband
post-stall signal instead of the 0.0338 s shedding fundamental (St 0.118).
Retained-cycle counts collapsed ~4x, the continuation budget guard projected
impossible hours, and honest work was rejected {insufficient-periods} —
precalc acceptance became a lottery exactly at the deep-stall angles that
need URANS.

These fixtures are shaped like the prod breakage, not like the fix:
1. physical Strouhal band [0.05, 0.5] restricts the period search;
2. within the band the highest-frequency peak within SUBHARMONIC_PEAK_TOLERANCE
   of the strongest peak wins (a strong 1/2 or 1/4 sub-harmonic never
   displaces the fundamental);
3. half-window disagreement > PERIOD_AMBIGUITY_TOLERANCE flags "period
   ambiguous" and the conservative SHORTER period feeds the budget math;
4. callers without flow context keep the legacy unconstrained behavior.
"""
import math
import re
from types import SimpleNamespace

import numpy as np
import pytest

from airfoilfoam import pipeline
from airfoilfoam.models import (
    CaseSpec,
    FluidProperties,
    MeshParams,
    RoughnessParams,
    SolverParams,
)
from airfoilfoam.pipeline import (
    CaseOutcome,
    TransientResult,
    UransQuality,
    _finalize_outcome,
)
from airfoilfoam.postprocess.unsteady import (
    PERIOD_AMBIGUITY_TOLERANCE,
    SHEDDING_STROUHAL_BAND,
    SUBHARMONIC_PEAK_TOLERANCE,
    ForceHistory,
    dominant_frequency,
    estimate_period,
    force_history,
    is_no_shedding,
    measure_period,
    shedding_frequency_band,
    shedding_period_band,
    stable_two_period_window,
)

# Prod flow context: naca-0012, U=25 m/s, c=0.1 m.
PROD_U = 25.0
PROD_C = 0.1
PROD_T0 = 0.0338  # measured run-1 shedding period (St 0.118)
PROD_TSUB = 4 * PROD_T0  # ~0.135 s modulation the run-2 tracker locked onto

POSTSTALL_U = 25.0
POSTSTALL_C = 1.0
POSTSTALL_ALPHA = 15.0
POSTSTALL_FREQ = 17.6
POSTSTALL_PERIOD = 1.0 / POSTSTALL_FREQ


# --------------------------------------------------------------------------- #
# Band plumbing pin: real request numbers
# --------------------------------------------------------------------------- #


def test_band_from_prod_request_contains_fundamental_excludes_subharmonic():
    band = shedding_period_band(PROD_U, PROD_C)
    assert band == pytest.approx((0.008, 0.08))
    assert band[0] < PROD_T0 < band[1]  # 0.0338 s fundamental inside
    assert PROD_TSUB > band[1]  # ~0.135 s sub-harmonic excluded
    freq_band = shedding_frequency_band(PROD_U, PROD_C)
    assert freq_band == pytest.approx((12.5, 125.0))
    assert freq_band[0] == pytest.approx(SHEDDING_STROUHAL_BAND[0] * PROD_U / PROD_C)


def test_band_requires_flow_context_explicit_legacy_otherwise():
    assert shedding_period_band(None, PROD_C) is None
    assert shedding_period_band(PROD_U, None) is None
    assert shedding_period_band(0.0, PROD_C) is None
    assert shedding_period_band(PROD_U, 0.0) is None
    assert shedding_period_band(math.nan, PROD_C) is None
    assert shedding_frequency_band(None, None) is None


def test_projected_height_band_widens_high_alpha_only():
    old_freq = shedding_frequency_band(POSTSTALL_U, POSTSTALL_C)
    low_alpha = shedding_frequency_band(POSTSTALL_U, POSTSTALL_C, alpha_deg=2.0)
    high_alpha = shedding_frequency_band(POSTSTALL_U, POSTSTALL_C, alpha_deg=POSTSTALL_ALPHA)

    assert low_alpha == pytest.approx(old_freq)
    assert old_freq == pytest.approx((1.25, 12.5))
    assert high_alpha[0] == pytest.approx(old_freq[0])
    assert high_alpha[1] == pytest.approx(
        SHEDDING_STROUHAL_BAND[1]
        * POSTSTALL_U
        / (POSTSTALL_C * math.sin(math.radians(POSTSTALL_ALPHA)))
    )
    assert high_alpha[0] < POSTSTALL_FREQ < high_alpha[1]


def _chord_st_070_poststall(seed: int = 3) -> tuple[np.ndarray, np.ndarray]:
    rng = np.random.default_rng(seed)
    t = np.linspace(0.0, 0.8, 5113)
    cl = (
        0.7
        + 0.1 * np.sin(2 * np.pi * POSTSTALL_FREQ * t + 0.3)
        + rng.normal(0.0, 0.006, t.size)
    )
    return t, cl


def test_projected_height_band_measures_chord_st_070_poststall_signal(tmp_path):
    """MUST-CATCH: c=1, U=25, alpha=15 sheds at 17.6 Hz. Chord St=0.70 is
    outside the old high-frequency ceiling, but projected-height St_h is valid."""
    t, cl = _chord_st_070_poststall()
    old_band = shedding_period_band(POSTSTALL_U, POSTSTALL_C, alpha_deg=2.0)
    high_alpha_band = shedding_period_band(
        POSTSTALL_U,
        POSTSTALL_C,
        alpha_deg=POSTSTALL_ALPHA,
    )

    assert measure_period(t, cl, period_band=old_band) is None
    assert estimate_period(t, cl, speed=POSTSTALL_U, chord=POSTSTALL_C, alpha_deg=2.0) is None

    measured = measure_period(t, cl, period_band=high_alpha_band)
    estimate = estimate_period(
        t,
        cl,
        speed=POSTSTALL_U,
        chord=POSTSTALL_C,
        alpha_deg=POSTSTALL_ALPHA,
    )

    assert measured == pytest.approx(POSTSTALL_PERIOD, rel=0.03)
    assert estimate is not None and not estimate.ambiguous
    assert estimate.period_s == pytest.approx(POSTSTALL_PERIOD, rel=0.03)

    coeff = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    _write_coeff_rows(coeff, t, cl)
    hist = force_history(
        coeff,
        POSTSTALL_U,
        POSTSTALL_C,
        discard_fraction=0.0,
        alpha_deg=POSTSTALL_ALPHA,
    )
    assert hist.period_s == pytest.approx(POSTSTALL_PERIOD, rel=0.03)
    assert hist.shedding_freq_hz == pytest.approx(POSTSTALL_FREQ, rel=0.03)

    frame_start = float(t[-1]) - 2.0 * POSTSTALL_PERIOD
    frame_times = [frame_start + i * (2.0 * POSTSTALL_PERIOD / 60.0) for i in range(61)]
    stable = stable_two_period_window(
        coeff,
        speed=POSTSTALL_U,
        chord=POSTSTALL_C,
        alpha_deg=POSTSTALL_ALPHA,
        frame_times=frame_times,
        min_frames_per_cycle=20,
    )
    assert stable.ok
    assert stable.period_s == pytest.approx(POSTSTALL_PERIOD, rel=0.03)


def test_projected_height_band_noise_only_still_has_no_period():
    rng = np.random.default_rng(11)
    t = np.linspace(0.0, 0.8, 5113)
    cl = 0.7 + rng.normal(0.0, 0.05, t.size)
    band = shedding_period_band(POSTSTALL_U, POSTSTALL_C, alpha_deg=POSTSTALL_ALPHA)

    assert measure_period(t, cl, period_band=band) is None
    assert (
        estimate_period(
            t,
            cl,
            speed=POSTSTALL_U,
            chord=POSTSTALL_C,
            alpha_deg=POSTSTALL_ALPHA,
        )
        is None
    )


# --------------------------------------------------------------------------- #
# MUST-CATCH: broadband post-stall signal (run-1 / run-2 instability)
# --------------------------------------------------------------------------- #


def _broadband_poststall(t: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Shedding fundamental + 1/4-frequency modulation at comparable amplitude
    + noise — the deep-stall lift-signal shape that broke prod, NOT a shape
    derived from the tracker implementation."""
    return (
        0.65
        + 0.40 * np.sin(2 * np.pi * t / PROD_T0)
        + 0.40 * np.sin(2 * np.pi * t / PROD_TSUB + 1.1)
        + rng.normal(0.0, 0.08, t.size)
    )


def _window_sampling(t0: float, t1: float, n: int, seed: int):
    """Adaptive-dt-like non-uniform sampling of one analysis window."""
    rng = np.random.default_rng(seed)
    dt = rng.uniform(0.8, 1.2, n)
    t = t0 + (t1 - t0) * np.cumsum(dt) / np.sum(dt)
    return t, _broadband_poststall(t, rng)


def test_broadband_poststall_locks_shedding_band_on_both_window_samplings():
    """The run-1/run-2 lottery reproduced and killed: two DIFFERENT window
    samplings of the same physics must agree on the in-band fundamental."""
    t_a, cl_a = _window_sampling(0.0, 0.55, 2200, seed=7)
    t_b, cl_b = _window_sampling(0.12, 1.20, 3600, seed=21)
    band = shedding_period_band(PROD_U, PROD_C)

    # The legacy unconstrained tracker locks the ~0.135 s sub-harmonic on
    # these windows — the exact prod failure (period estimate moved ~4x).
    legacy_a = measure_period(t_a, cl_a)
    legacy_b = measure_period(t_b, cl_b)
    assert legacy_a is not None and legacy_a > 3.0 * PROD_T0
    assert legacy_b is not None and legacy_b > 3.0 * PROD_T0

    got_a = measure_period(t_a, cl_a, period_band=band)
    got_b = measure_period(t_b, cl_b, period_band=band)
    assert got_a == pytest.approx(PROD_T0, rel=0.08)
    assert got_b == pytest.approx(PROD_T0, rel=0.08)
    # Both samplings agree: the acceptance lottery is gone.
    assert abs(got_a - got_b) / max(got_a, got_b) < 0.10

    # And the full flow-context estimator agrees and is NOT ambiguous.
    est_a = estimate_period(t_a, cl_a, speed=PROD_U, chord=PROD_C)
    est_b = estimate_period(t_b, cl_b, speed=PROD_U, chord=PROD_C)
    assert est_a is not None and not est_a.ambiguous
    assert est_b is not None and not est_b.ambiguous
    assert est_a.period_s == pytest.approx(PROD_T0, rel=0.08)
    assert est_b.period_s == pytest.approx(PROD_T0, rel=0.08)


def test_fft_window_restricted_to_band_recovers_fundamental():
    """The FFT path (force_history / quality-evaluation period chain) must
    search only the physical frequency window."""
    t = np.linspace(0.0, 1.2, 6000)
    cl = _broadband_poststall(t, np.random.default_rng(3))
    legacy = dominant_frequency(t, cl)
    assert legacy == pytest.approx(1.0 / PROD_TSUB, rel=0.05)  # sub-harmonic wins unbanded
    banded = dominant_frequency(t, cl, freq_band=shedding_frequency_band(PROD_U, PROD_C))
    assert banded == pytest.approx(1.0 / PROD_T0, rel=0.05)


def test_force_history_strouhal_stays_in_band_on_broadband_signal(tmp_path):
    """history.strouhal / period_s back evaluate_urans_quality's retained-cycle
    count: on the prod-shaped signal they must reflect the fundamental."""
    # Seed 3: the legacy global-argmax FFT locks the ~0.135 s sub-harmonic on
    # this sampling (other seeds flip to the fundamental — the prod lottery).
    t = np.linspace(0.0, 1.2, 6000)
    cl = _broadband_poststall(t, np.random.default_rng(3))
    coeff = tmp_path / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    _write_coeff_rows(coeff, t, cl)

    hist = force_history(coeff, PROD_U, PROD_C, discard_fraction=0.0)

    assert hist.period_s == pytest.approx(PROD_T0, rel=0.05)
    assert hist.strouhal == pytest.approx(PROD_C / (PROD_T0 * PROD_U), rel=0.05)
    assert SHEDDING_STROUHAL_BAND[0] <= hist.strouhal <= SHEDDING_STROUHAL_BAND[1]


# --------------------------------------------------------------------------- #
# Rule 2: in-band sub-harmonic dominance resolves to the fundamental
# --------------------------------------------------------------------------- #


def test_subharmonic_dominant_peak_within_band_resolves_to_fundamental():
    """A 1/2 sub-harmonic whose autocorrelation peak DOMINATES (the T/2T
    lottery regime) must not displace the shedding fundamental when the
    fundamental's peak is within SUBHARMONIC_PEAK_TOLERANCE of it."""
    fundamental = 0.02  # St 0.4 at U=25, c=0.1 — in band
    sub = 2 * fundamental  # St 0.2 — ALSO in band: rule 1 cannot save this one
    t = np.linspace(0.0, 0.6, 4000)
    rng = np.random.default_rng(5)
    cl = (
        0.7
        + 0.10 * np.sin(2 * np.pi * t / fundamental)
        + 0.03 * np.sin(2 * np.pi * t / sub + 0.4)
        + rng.normal(0.0, 0.005, t.size)
    )
    band = shedding_period_band(PROD_U, PROD_C)

    # Legacy: the sub-harmonic autocorrelation peak (~1.0 vs ~0.84) wins.
    assert measure_period(t, cl) == pytest.approx(sub, rel=0.02)
    # Rule 2: highest-frequency in-band peak within 80% of the max wins.
    assert measure_period(t, cl, period_band=band) == pytest.approx(fundamental, rel=0.02)
    est = estimate_period(t, cl, speed=PROD_U, chord=PROD_C)
    assert est is not None and not est.ambiguous
    assert est.period_s == pytest.approx(fundamental, rel=0.02)
    assert 0 < SUBHARMONIC_PEAK_TOLERANCE < 1  # documented tolerance sanity pin


# --------------------------------------------------------------------------- #
# Unchanged behaviors: clean periodic, no flow context, no-shedding
# --------------------------------------------------------------------------- #


def test_clean_periodic_signal_unchanged_with_and_without_band():
    rng = np.random.default_rng(42)
    period = 0.25
    dt = rng.uniform(0.8, 1.2, 3000) * (period / 100.0)
    t = np.cumsum(dt)
    cl = 0.7 + 0.08 * np.sin(2 * np.pi * t / period) + rng.normal(0.0, 0.02, t.size)

    legacy = measure_period(t, cl)
    banded = measure_period(t, cl, period_band=(0.05, 0.5))

    assert legacy == pytest.approx(period, rel=0.03)
    assert banded == pytest.approx(legacy, rel=1e-6)  # identical peak, same refinement


def test_estimator_without_flow_context_keeps_legacy_behavior():
    """Explicit legacy path: no speed/chord => no band => the estimator returns
    exactly what the unconstrained tracker returns (sub-harmonic and all)."""
    t = np.linspace(0.0, 1.2, 6000)
    cl = _broadband_poststall(t, np.random.default_rng(9))
    legacy = measure_period(t, cl)
    est = estimate_period(t, cl)
    assert legacy is not None and est is not None
    assert est.period_s == pytest.approx(legacy, rel=1e-9) or est.ambiguous


def test_no_shedding_flat_signal_yields_no_period_and_no_shedding_untouched():
    t = np.linspace(0.0, 2.0, 2000)
    rng = np.random.default_rng(1)
    cl = 0.011 + rng.normal(0.0, 1e-5, t.size)
    assert estimate_period(t, cl, speed=PROD_U, chord=PROD_C) is None
    hist = ForceHistory(
        t=list(t), cl=list(cl), cd=[0.02] * t.size, cm=[0.0] * t.size,
        cl_mean=0.011, cl_rms=1e-5, cd_mean=0.02, cd_rms=0.0, cm_mean=0.0,
        cm_rms=0.0, shedding_freq_hz=0.0, strouhal=0.0, samples=int(t.size),
    )
    assert is_no_shedding(hist)  # amplitude-based early exit untouched


# --------------------------------------------------------------------------- #
# Out-of-band honesty: genuinely long-period phenomena (bluff-body-like
# St < 0.05) must grade as NO LOCK — never a silently wrong in-band period
# (verification 2026-07-07: pre-fix the band search minted a band-edge 0.0799 s
# from FFT leakage on the clean signal and a 0.0117 s noise-wiggle period on
# the noisy one, and dominant out-of-band modulation dragged the in-band
# autocorrelation ripple ~30-36% short).
# --------------------------------------------------------------------------- #


def test_out_of_band_phenomenon_clean_yields_no_lock_not_band_edge():
    """MUST-CATCH: St 0.04 -> T=0.100 s, outside the [0.008, 0.08] s band. The
    FFT leakage skirt at the band edge must not be reported as a period."""
    t_out = PROD_C / (0.04 * PROD_U)
    t = np.linspace(0.2, 1.6, 5600)
    cl = 0.8 + 0.30 * np.sin(2 * np.pi * t / t_out + 0.7)
    band = shedding_period_band(PROD_U, PROD_C)
    assert measure_period(t, cl, period_band=band) is None
    assert estimate_period(t, cl, speed=PROD_U, chord=PROD_C) is None
    # The phenomenon is real — the legacy unconstrained tracker resolves it.
    assert measure_period(t, cl) == pytest.approx(t_out, rel=0.02)


def test_out_of_band_phenomenon_noisy_cannot_mint_in_band_period():
    """MUST-CATCH: noise wiggles on the sloping in-band autocorrelation of a
    genuinely out-of-band signal minted a ~0.0117 s 'period' (8.5x short) on
    this exact fixture (seed 5) pre-fix."""
    t_out = PROD_C / (0.04 * PROD_U)
    for seed in (5, 6):
        rng = np.random.default_rng(seed)
        t = np.linspace(0.2, 1.6, 5600)
        cl = 0.8 + 0.30 * np.sin(2 * np.pi * t / t_out + 0.7) + rng.normal(0.0, 0.08, t.size)
        assert estimate_period(t, cl, speed=PROD_U, chord=PROD_C) is None, f"seed {seed}"


def test_dominant_out_of_band_modulation_never_ships_slope_dragged_period():
    """MUST-CATCH: at modulation/fundamental amplitude ratio ~2 the in-band
    autocorrelation ripple rides the modulation's correlation slope and was
    dragged ~30-36% short of the fundamental (unflagged) pre-fix. Honest
    outcomes: the fundamental, an ambiguity flag, or no lock — never an
    unflagged far-off value."""
    for seed in (11, 12, 13):
        rng = np.random.default_rng(seed)
        t = np.linspace(0.3, 1.5, 5000)
        cl = (
            0.7
            + 0.10 * np.sin(2 * np.pi * t / PROD_T0 + 0.4)
            + 0.20 * np.sin(2 * np.pi * t / PROD_TSUB + 1.3)
            + rng.normal(0.0, 0.03, t.size)
        )
        est = estimate_period(t, cl, speed=PROD_U, chord=PROD_C)
        assert (
            est is None
            or est.ambiguous
            or est.period_s == pytest.approx(PROD_T0, rel=0.12)
        ), f"seed {seed}: unflagged off-fundamental period {est.period_s}"


def test_low_st_shedding_near_band_edge_still_resolves():
    """False-positive guard: legitimate thick-airfoil shedding at St 0.055-0.06
    sits near the long-period band edge and must still lock cleanly."""
    for st in (0.055, 0.06):
        t_true = PROD_C / (st * PROD_U)
        rng = np.random.default_rng(7)
        t = np.linspace(0.2, 0.2 + 40 * t_true, 6000)
        cl = 0.8 + 0.25 * np.sin(2 * np.pi * t / t_true + 0.3) + rng.normal(0.0, 0.04, t.size)
        est = estimate_period(t, cl, speed=PROD_U, chord=PROD_C)
        assert est is not None and not est.ambiguous
        assert est.period_s == pytest.approx(t_true, rel=0.02)


# --------------------------------------------------------------------------- #
# Rule 3: half-window stability check
# --------------------------------------------------------------------------- #


def test_ambiguous_period_flags_and_uses_conservative_shorter_estimate():
    t = np.linspace(0.0, 0.8, 6000)
    cl = np.where(
        t < 0.4,
        0.7 + 0.1 * np.sin(2 * np.pi * t / 0.02),
        0.7 + 0.1 * np.sin(2 * np.pi * t / 0.03),
    )
    est = estimate_period(t, cl, speed=PROD_U, chord=PROD_C)
    assert est is not None
    assert est.ambiguous
    assert est.first_half_s == pytest.approx(0.02, rel=0.03)
    assert est.second_half_s == pytest.approx(0.03, rel=0.05)
    # abs(p1 - p2) / max > 30% -> the SHORTER period is the risk-averse choice
    # for retained-cycle counting and budget projection.
    assert est.period_s == pytest.approx(0.02, rel=0.03)
    assert est.period_s == min(est.first_half_s, est.second_half_s)
    rel_diff = abs(est.first_half_s - est.second_half_s) / max(
        est.first_half_s, est.second_half_s
    )
    assert rel_diff > PERIOD_AMBIGUITY_TOLERANCE


def test_stable_period_is_not_flagged_ambiguous():
    t = np.linspace(0.0, 0.8, 6000)
    cl = 0.7 + 0.1 * np.sin(2 * np.pi * t / 0.02)
    est = estimate_period(t, cl, speed=PROD_U, chord=PROD_C)
    assert est is not None and not est.ambiguous
    assert est.period_s == pytest.approx(0.02, rel=0.02)


# --------------------------------------------------------------------------- #
# Pipeline plumbing: continuation budget guard (the prod rejection path)
# --------------------------------------------------------------------------- #


def _composite_history(t0: float, t1: float, fundamental: float, sub: float, n: int = 900):
    ts = np.linspace(t0, t1, n)
    cl = (
        0.7
        + 0.25 * np.sin(2 * np.pi * ts / fundamental)
        + 0.25 * np.sin(2 * np.pi * ts / sub + 0.9)
    )
    return ForceHistory(
        t=[float(x) for x in ts],
        cl=[float(x) for x in cl],
        cd=[0.05] * n,
        cm=[-0.02] * n,
        cl_mean=0.7,
        cl_rms=0.18,
        cd_mean=0.05,
        cd_rms=0.0,
        cm_mean=-0.02,
        cm_rms=0.0,
        shedding_freq_hz=1.0 / sub,  # what the OLD unconstrained FFT reported
        strouhal=1.0 / (sub * 10.0),
        samples=n,
        period_s=sub,  # the old-world sub-harmonic lock, must be ignored
        retained_cycles=1,
        window_start=t0,
        window_end=t1,
    )


def test_continuation_budget_uses_in_band_period_and_ships_honest_point(tmp_path, monkeypatch):
    """MUST-CATCH (prod run-2 shape): the merged Cl history carries a strong
    out-of-band sub-harmonic. The old tracker measured the ~4x period, the
    budget guard projected impossible hours and rejected the point
    {insufficient-periods}. The band-constrained tracker must size the
    continuation off the fundamental and let the honest point complete."""
    fundamental = 0.55  # St 0.18 at U=10, c=1 — in band [0.2, 2.0]
    sub = 4 * fundamental  # 2.2 s — St 0.045, OUT of band
    calls: list[dict] = []
    spans = [5.0, 6.5]

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(tcase, *_args, run_time=None, coeff_start_time=None, refined=False, **_kwargs):
        k = len(calls)
        calls.append({"run_time": run_time, "refined": refined})
        end = spans[min(k, len(spans) - 1)]
        (tcase / f"{end:.10g}").mkdir(exist_ok=True)
        last = k >= len(spans) - 1
        return TransientResult(
            avg=SimpleNamespace(cl=0.7, cd=0.05, cm=-0.02, cl_cd=14.0, cl_std=0.18, cd_std=0.0, cm_std=0.0),
            case_dir=tcase,
            force_history=_composite_history(0.0, end, fundamental, sub),
            quality=UransQuality(
                ok=last,
                can_refine=not last,
                reason="URANS quality target met." if last else "retained cycles 5.45 < 7.00",
                measured_period_s=sub,  # old-world FFT value on the record
                retained_cycles=end * 0.6 / fundamental,
            ),
            start_time=0.0 if k == 0 else spans[k - 1],
            end_time=end,
            run_time=end if k == 0 else end - spans[k - 1],
            wall_seconds=3000.0,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)

    result = pipeline._run_transient(
        tmp_path / "case",
        airfoil=None,
        resolved=None,
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0),
        fluid=None,
        roughness=None,
        solver_params=SolverParams(),
        runner=None,
        n_proc=1,
        timeout=7200,
    )

    # Old tracker: sub-harmonic lock (period 2.2 s) -> retained 5*0.6/2.2 ~
    # 1.36 of 7 periods -> chunk_sim ~ 20.7 simulated s -> ~12400 projected
    # wall s > 0.8 * 7200: budget-rejected {insufficient-periods}, no chunk.
    # New tracker: in-band period ~0.55 s -> retained ~5.5 -> chunk ~1 s ->
    # ~640 wall s: the continuation runs and the point completes honestly.
    assert len(calls) == 2
    assert result is not None
    assert result.quality.ok
    assert "(budget)" not in result.quality.reason
    # The chunk was sized off an IN-BAND period: the sub-harmonic sizing would
    # have needed ~20.7 simulated s (and would never have been launched).
    assert calls[1]["run_time"] is not None
    assert 0.0 < calls[1]["run_time"] < 3.0


# --------------------------------------------------------------------------- #
# Pipeline plumbing: frame-track assembly (single source of truth)
# --------------------------------------------------------------------------- #


def _write_coeff_rows(path, times, cl, cd=0.05, cm=-0.02):
    """cl is either a callable of t or a same-length sequence of values."""
    path.parent.mkdir(parents=True, exist_ok=True)
    values = [cl(t) for t in times] if callable(cl) else list(cl)
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    for t, v in zip(times, values):
        lines.append(f"{t:.8g} {cd:.6g} 0 0 {v:.8g} 0 0 {cm:.6g} 0 0 0 0 0")
    path.write_text("\n".join(lines) + "\n")


class _FakeRunner:
    def application(self, *_args, **_kwargs):
        return SimpleNamespace(ok=True, check=lambda: None)


def _finalize_with_series(tmp_path, monkeypatch, cl_fn, *, period_s, t0=600.0, t1=612.0, n=2400):
    tcase = tmp_path / "transient"
    coeff = tcase / "postProcessing" / "forceCoeffs1" / "600" / "coefficient.dat"
    ts = np.linspace(t0, t1, n)
    _write_coeff_rows(coeff, ts, cl_fn)
    hist = ForceHistory(
        t=[float(x) for x in ts], cl=[float(cl_fn(x)) for x in ts],
        cd=[0.05] * n, cm=[-0.02] * n,
        cl_mean=0.75, cl_rms=0.05, cd_mean=0.05, cd_rms=0.0, cm_mean=-0.02, cm_rms=0.0,
        shedding_freq_hz=1.0 / period_s, strouhal=1.0 / (period_s * 10.0), samples=n,
        period_s=period_s, retained_cycles=7, window_start=t0, window_end=t1,
    )
    transient = TransientResult(
        avg=SimpleNamespace(cl=99.0, cd=99.0, cm=99.0, cl_cd=1.0, cl_std=9.0, cd_std=9.0, cm_std=9.0),
        case_dir=tcase,
        force_history=hist,
        quality=UransQuality(
            ok=True, can_refine=False, reason="URANS quality target met.",
            measured_period_s=period_s,
        ),
        start_time=t0,
        end_time=t1,
        run_time=t1 - t0,
        coeff_paths=[coeff],
    )
    monkeypatch.setattr(pipeline, "_run_transient", lambda case_dir, *a, **k: transient)
    outcome = CaseOutcome(spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0), reynolds=666_666)
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
    )
    return outcome


def test_frame_track_period_ignores_out_of_band_subharmonic(tmp_path, monkeypatch):
    """MUST-CATCH: the frame-track stats (single source of truth for the point
    coefficients and Strouhal) must window on the in-band fundamental even
    when a comparable-amplitude out-of-band modulation rides the signal."""
    fundamental = 0.6  # St 0.167 at U=10, c=1 — in band [0.2, 2.0]
    sub = 4 * fundamental  # 2.4 s — St 0.042, out of band

    def cl_fn(t):
        return (
            0.75
            + 0.05 * math.sin(2 * math.pi * t / fundamental)
            + 0.05 * math.sin(2 * math.pi * t / sub + 0.9)
        )

    outcome = _finalize_with_series(tmp_path, monkeypatch, cl_fn, period_s=fundamental)

    ft = outcome.frame_track
    assert ft is not None
    assert ft.period_s == pytest.approx(fundamental, rel=0.05)
    assert outcome.strouhal == pytest.approx(1.0 / (fundamental * 10.0), rel=0.05)
    assert outcome.cl == pytest.approx(0.75, abs=0.02)
    assert not any("period ambiguous" in w for w in outcome.quality_warnings)


def test_frame_track_ambiguous_period_warns_and_uses_shorter(tmp_path, monkeypatch):
    """Rule 3 end to end: a period drifting >30% between the retained window's
    halves ships a 'period ambiguous' quality warning with both values and
    windows the stats on the conservative shorter period."""
    switch = 608.4  # midpoint of the retained (post-discard) window

    def cl_fn(t):
        if t < switch:
            return 0.75 + 0.05 * math.sin(2 * math.pi * t / 0.5)
        phase = 2 * math.pi * switch / 0.5
        return 0.75 + 0.05 * math.sin(phase + 2 * math.pi * (t - switch) / 0.75)

    outcome = _finalize_with_series(tmp_path, monkeypatch, cl_fn, period_s=0.5)

    ft = outcome.frame_track
    assert ft is not None
    warnings = [w for w in outcome.quality_warnings if "period ambiguous" in w]
    assert len(warnings) == 1
    # Both measured half-window values are disclosed in the warning.
    disclosed = [float(m) for m in re.findall(r"(\d+\.\d+)s", warnings[0])]
    assert len(disclosed) == 3  # first half, second half, chosen shorter
    assert disclosed[0] == pytest.approx(0.5, rel=0.05)
    assert disclosed[1] == pytest.approx(0.75, rel=0.05)
    assert "shorter" in warnings[0]
    assert disclosed[2] == min(disclosed[0], disclosed[1])
    assert ft.period_s == pytest.approx(0.5, rel=0.05)  # conservative shorter period
