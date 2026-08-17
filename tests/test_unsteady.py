"""Unit tests for URANS force-history + Strouhal extraction (no OpenFOAM needed)."""
import math
import signal
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from airfoilfoam import pipeline
from airfoilfoam.cancellation import JobCancelled
from airfoilfoam.postprocess.unsteady import (
    CleanCycleAudit,
    CycleAudit,
    FINAL_CLEAN_CYCLE_MAX_PERIODS,
    FINAL_CLEAN_CYCLE_MINIMUM,
    FAST_CLEAN_CYCLE_MAX_PERIODS,
    FAST_CLEAN_CYCLE_MINIMUM,
    ForceHistory,
    additional_periods_for_clean_suffix,
    audit_period_cycles,
    clean_cycle_recovery_exhausted,
    clean_cycle_continuation_max_periods,
    clean_periodic_tail,
    required_clean_cycle_count,
    dominant_frequency,
    estimate_period,
    force_history,
    integer_period_window,
    period_window_stats,
    shedding_frequency_band,
    stable_two_period_window,
    strouhal,
    with_clean_cycle_recovery_progress,
)
from airfoilfoam.postprocess.images import find_all_vtus, select_vtus
from airfoilfoam.models import CaseSpec, FailureDisposition
from airfoilfoam.openfoam.runner import (
    DeterministicMeshError,
    HardSolverError,
    InfrastructureError,
    InsufficientMpiSlotsError,
    RunResult,
)
from airfoilfoam.pipeline import (
    CaseOutcome,
    TransientResult,
    UransQuality,
    _run_full_urans_replacement,
    _run_transient_attempt,
    evaluate_urans_quality,
    _finalize_outcome,
    refined_transient_timing,
    should_abort_rans_sweep_for_urans,
    solve_polar_marched,
)


def test_dominant_frequency_recovers_known_tone():
    f = 2.0  # Hz
    n = 600
    times = [i * 0.01 for i in range(n)]  # 6 s, dt = 0.01
    values = [0.75 + 0.05 * math.sin(2 * math.pi * f * t) for t in times]
    got = dominant_frequency(times, values)
    # FFT bin spacing here is ~1/6 Hz; recovered peak should be within a bin or two.
    assert abs(got - f) < 0.35


def test_dominant_frequency_handles_degenerate_input():
    assert dominant_frequency([0, 1, 2], [1, 1, 1]) == 0.0  # too few samples
    assert dominant_frequency([0.0] * 16, [0.0] * 16) == 0.0  # zero span / flat


def test_strouhal_formula():
    assert strouhal(2.0, 1.0, 20.0) == 0.1
    assert strouhal(5.0, 0.5, 10.0) == 0.25
    assert strouhal(2.0, 1.0, 0.0) == 0.0  # guard against zero speed


def test_period_window_stats_snaps_only_integer_boundary_roundoff():
    """Producer emits exact N for arithmetic ULP noise, not a short window."""
    period = 0.1
    # Binary64 represents 0.3 / 0.1 a few ULPs below three on CPython.
    times = np.linspace(0.0, 0.3, 61)
    phase = 2.0 * np.pi * times / period
    cl = 0.8 + 0.05 * np.sin(phase)
    cd = 0.02 + 0.002 * np.sin(phase)
    cm = -0.04 + 0.003 * np.sin(phase)
    exact = period_window_stats(times, cl, cd, cm, period)
    assert exact is not None
    assert exact.periods_retained == 3.0

    # A physically shorter span well outside four ULPs remains fractional.
    short_times = np.linspace(0.0, 0.3 - 1e-10, 61)
    short_phase = 2.0 * np.pi * short_times / period
    short = period_window_stats(
        short_times,
        0.8 + 0.05 * np.sin(short_phase),
        0.02 + 0.002 * np.sin(short_phase),
        -0.04 + 0.003 * np.sin(short_phase),
        period,
    )
    assert short is not None
    assert short.periods_retained < 3.0


def test_thick_section_wake_scale_corroborates_high_frequency_period():
    """MUST-CATCH: the AH81K144WFKLAPPE 0° production class.

    Its clean tail repeats at about 1,076 Hz.  That is outside the legacy
    chord-only 30–300 Hz band, but its measured t/c=0.22 makes St_t=0.394:
    a physically plausible thickness-scale wake.  Both independent halves
    agree to much better than 1%, so it must not be called numerical merely
    because the section is thick.
    """
    speed = 30.0
    chord = 0.05
    thickness_ratio = 0.22
    frequency = 1075.7
    times = np.linspace(0.0, 0.02, 10_001)
    lift = -0.448 + 0.0042 * np.sin(2.0 * math.pi * frequency * times)

    legacy = estimate_period(
        times,
        lift,
        speed=speed,
        chord=chord,
        alpha_deg=0.0,
    )
    geometry_aware = estimate_period(
        times,
        lift,
        speed=speed,
        chord=chord,
        alpha_deg=0.0,
        section_thickness_ratio=thickness_ratio,
    )
    band = shedding_frequency_band(
        speed,
        chord,
        alpha_deg=0.0,
        section_thickness_ratio=thickness_ratio,
    )

    assert legacy is None
    assert band is not None
    assert band[0] == pytest.approx(30.0)
    assert band[1] == pytest.approx(1363.636, rel=1e-4)
    assert geometry_aware is not None
    assert not geometry_aware.ambiguous
    assert geometry_aware.period_s == pytest.approx(1.0 / frequency, rel=0.01)
    assert geometry_aware.first_half_s == pytest.approx(
        geometry_aware.second_half_s, rel=0.01
    )


def test_thick_section_clean_tail_excludes_late_corrupt_prefix(tmp_path):
    """A geometry-scale wake still uses the strict clean-suffix contract."""
    speed = 30.0
    chord = 0.05
    frequency = 1075.7
    path = tmp_path / "coefficient.dat"
    lines = [
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) "
        "CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    ]
    times = np.linspace(0.0, 0.05, 25_001)
    for t in times:
        if t < 0.03:
            # Corruption extends beyond the legacy 40% discard boundary.
            cl = -0.25 + 0.18 * math.sin(2.0 * math.pi * 71.0 * t)
            cd = 0.06 + 0.025 * math.cos(2.0 * math.pi * 47.0 * t)
        else:
            cl = -0.448 + 0.0042 * math.sin(2.0 * math.pi * frequency * t)
            cd = 0.0327 + 0.00018 * math.cos(
                2.0 * math.pi * frequency * t + 0.2
            )
        lines.append(
            f"{t:.12g} {cd:.12g} 0 0 {cl:.12g} 0 0 "
            "0.099 0 0 0 0 0"
        )
    path.write_text("\n".join(lines) + "\n")

    history = force_history(
        path,
        speed,
        chord,
        discard_fraction=0.4,
        target_cycles=3,
        alpha_deg=0.0,
        section_thickness_ratio=0.22,
    )

    assert history.period_s == pytest.approx(1.0 / frequency, rel=0.01)
    assert history.retained_cycles == 3
    assert history.window_start is not None
    assert history.window_start > 0.045
    assert min(history.cl) > -0.46
    assert max(history.cl) < -0.43


def _write_coeff(path, f, n=600, dt=0.01, cl0=0.75, cd0=0.30):
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    for i in range(n):
        t = i * dt
        cl = cl0 + 0.05 * math.sin(2 * math.pi * f * t)
        cd = cd0 + 0.01 * math.sin(2 * math.pi * f * t + 0.7)
        cm = -0.10
        row = [t, cd, 0.0, 0.0, cl, 0.0, 0.0, cm, 0.0, 0.0, 0.0, 0.0, 0.0]
        lines.append(" ".join(f"{v:.6g}" for v in row))
    path.write_text("\n".join(lines) + "\n")


def _write_coeff_with_late_startup_burst(path: Path) -> None:
    """Prod-shaped URANS history: a clean wake follows a late startup burst.

    The burst deliberately extends beyond the legacy 40% discard boundary.
    It is not part of the converged wake and must remain only in immutable raw
    evidence, never in the published/certified force window.
    """
    lines = [
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) "
        "CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    ]
    samples = 10_001
    for i in range(samples):
        t = 2.0 * i / (samples - 1)
        cl = 0.4 + 0.05 * math.sin(2 * math.pi * 10.0 * t)
        cd = 0.03 + 0.006 * math.sin(2 * math.pi * 10.0 * t + 0.5)
        cm = -0.05 + 0.003 * math.sin(2 * math.pi * 10.0 * t + 0.9)
        if 0.8 <= t <= 1.16:
            envelope = math.sin(math.pi * (t - 0.8) / 0.36) ** 2
            cl += 2.0 * envelope * math.sin(2 * math.pi * 211.0 * t)
            cd += 1.0 * envelope * math.sin(2 * math.pi * 162.47 * t)
            cm += 0.6 * envelope * math.sin(2 * math.pi * 253.2 * t)
        row = [t, cd, 0.0, 0.0, cl, 0.0, 0.0, cm, 0.0, 0.0, 0.0, 0.0, 0.0]
        lines.append(" ".join(f"{value:.12g}" for value in row))
    path.write_text("\n".join(lines) + "\n")


def test_force_history_from_coefficient_dat(tmp_path):
    f = 2.0
    coeff = tmp_path / "coefficient.dat"
    _write_coeff(coeff, f, n=600, dt=0.01)
    hist = force_history(coeff, speed=20.0, chord=1.0, discard_fraction=0.4, max_points=400)

    # The exported window is the final integer number of measured periods.
    assert hist.retained_cycles == 7
    assert hist.period_s == pytest.approx(0.5, rel=0.03)
    assert hist.t[-1] - hist.t[0] == pytest.approx(7 * hist.period_s)
    assert hist.samples > 300
    assert len(hist.cl) <= 400 and len(hist.cl) > 100
    assert len(hist.t) == len(hist.cl) == len(hist.cd)

    assert abs(hist.cl_mean - 0.75) < 0.01
    assert abs(hist.cd_mean - 0.30) < 0.01
    assert hist.cl_rms > 0.02  # oscillation amplitude ~0.05/sqrt(2)

    # measured Strouhal: f c / U = 2 * 1 / 20 = 0.1
    assert abs(hist.strouhal - 0.1) < 0.03
    assert hist.shedding_freq_hz > 0


def test_force_history_publishes_only_clean_periods_after_late_startup_burst(
    tmp_path: Path,
):
    """MUST-CATCH: startup corruption after 40% cannot poison a clean tail."""
    coeff = tmp_path / "coefficient.dat"
    _write_coeff_with_late_startup_burst(coeff)

    hist = force_history(
        coeff,
        speed=20.0,
        chord=1.0,
        discard_fraction=0.4,
        target_cycles=3,
    )

    assert hist.period_s == pytest.approx(0.1, rel=0.03)
    assert hist.retained_cycles == 3
    assert hist.window_start is not None and hist.window_start >= 1.69
    assert max(hist.cl) < 0.46
    assert min(hist.cl) > 0.34


def test_clean_periodic_tail_finds_short_suffix_after_long_corrupt_history():
    """MUST-CATCH: continuation history length cannot hide a clean final wake.

    The former shortest candidate was 2.5% of the complete trajectory. After
    many same-case continuations that can still include dozens of corrupt
    startup cycles even though the final five periods are clean and sufficient
    for certification.
    """
    dt = 0.001
    end = 40.0
    period = 0.125
    clean_start = end - 5.5 * period
    times = np.arange(0.0, end + dt / 2.0, dt)
    cl = 0.4 + 0.18 * np.sin(2.0 * math.pi * 1.3 * times) + 0.004 * times
    cd = 0.04 + 0.08 * np.sin(2.0 * math.pi * 1.7 * times + 0.3) + 0.001 * times
    cm = -0.03 + 0.06 * np.sin(2.0 * math.pi * 0.9 * times + 0.8) - 0.001 * times
    clean = times >= clean_start
    cl[clean] = 0.4 + 0.05 * np.sin(2.0 * math.pi * 8.0 * times[clean])
    cd[clean] = 0.03 + 0.006 * np.sin(
        2.0 * math.pi * 8.0 * times[clean] + 0.5
    )
    cm[clean] = -0.05 + 0.003 * np.sin(
        2.0 * math.pi * 8.0 * times[clean] + 0.9
    )

    tail = clean_periodic_tail(
        times,
        cl,
        cd,
        cm,
        speed=20.0,
        chord=1.0,
        required_cycles=4.5,
    )

    assert tail is not None
    assert tail.estimate.period_s == pytest.approx(period, rel=0.03)
    assert tail.series[0][0] >= clean_start
    assert tail.series[0][-1] - tail.series[0][0] == pytest.approx(
        4.5 * period,
        rel=0.03,
    )
    assert max(tail.series[1]) < 0.46
    assert min(tail.series[1]) > 0.34


def _clean_cycle_series(
    *,
    period: float = 0.2,
    cycles: int = 7,
    dt: float = 0.001,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """A resolved three-channel periodic wake for clean-cycle fixtures."""
    times = np.arange(0.0, cycles * period + dt / 2.0, dt)
    phase = 2.0 * math.pi * times / period
    return (
        times,
        0.70 + 0.08 * np.sin(phase),
        0.030 + 0.010 * np.sin(phase + 0.6),
        -0.050 + 0.004 * np.sin(phase + 1.1),
    )


def test_clean_cycle_audit_discards_a_broken_early_period_but_certifies_suffix():
    """MUST-CATCH: an old startup impulse cannot poison a clean final wake."""
    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period)
    # One isolated early solver step, intentionally much larger than the
    # waveform so the hard impulse gate—not a changed physical mean—owns it.
    cl[np.argmin(abs(times - 0.11))] = 4.0

    audit = audit_period_cycles(
        times,
        cl,
        cd,
        cm,
        period,
        fidelity="fast",
        required_cycles=3,
    )

    assert audit.certified
    assert audit.required_clean_cycles == FAST_CLEAN_CYCLE_MINIMUM
    assert audit.cycles[0].disposition == "hard_corrupt"
    assert "impulsive discontinuity" in audit.cycles[0].hard_reasons
    assert audit.terminal_clean_cycles >= 3


def test_clean_cycle_audit_selects_only_the_fixed_publication_window():
    """Extra clean tail evidence must not silently widen FAST's mean window."""
    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period, cycles=7)
    audit = audit_period_cycles(
        times,
        cl,
        cd,
        cm,
        period,
        fidelity="fast",
        required_cycles=3,
    )

    assert audit.certified
    assert audit.terminal_clean_cycles >= 5
    assert audit.terminal_clean_start == pytest.approx(0.0)
    # The exact published coefficients use only the last three clean cycles;
    # the older clean tail remains audited provenance, not an implicit average.
    assert audit.selected_start == pytest.approx(0.8)


def test_clean_cycle_audit_requires_a_contiguous_terminal_suffix():
    """MUST-CATCH: a broken last period requests recovery, not publication."""
    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period)
    cl[np.argmin(abs(times - 1.31))] = 4.0

    audit = audit_period_cycles(
        times,
        cl,
        cd,
        cm,
        period,
        fidelity="fast",
        required_cycles=3,
    )

    assert not audit.certified
    assert audit.terminal_clean_cycles == 0
    assert audit.cycles[-1].disposition == "hard_corrupt"
    # This fixture already contains seven measured FAST periods. A damaged
    # final period earns one bounded three-period repair chunk; the v2 finite
    # ceiling leaves enough room without weakening the clean-suffix gate.
    assert additional_periods_for_clean_suffix(
        audit, fidelity="fast", required_cycles=3
    ) == 3


def test_clean_tail_does_not_normalise_away_a_terminal_nonfinite_sample():
    """MUST-CATCH: a NaN in the final cycle cannot be interpolated away.

    ``clean_periodic_tail`` needs a normalised series for period estimation,
    but that normalisation must not turn a raw terminal defect into a smooth
    gap-free waveform.  The raw row stays immutable; the certification view
    simply rejects its owning period and asks the controller for recovery.
    """
    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period)
    cl[np.argmin(abs(times - 1.31))] = math.nan
    frames = np.arange(0.0, times[-1] + 0.0005, 0.005)

    tail = clean_periodic_tail(
        times,
        cl,
        cd,
        cm,
        speed=20.0,
        chord=1.0,
        required_cycles=3,
        fidelity="fast",
        frame_times=frames,
        min_frames_per_cycle=20,
    )

    assert tail is None


def test_clean_cycle_audit_detects_a_single_step_at_the_20_sample_floor():
    """The minimum write cadence must not create an impulse blind spot."""
    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period, dt=0.01)
    cl[np.argmin(abs(times - 1.31))] = 4.0

    audit = audit_period_cycles(
        times,
        cl,
        cd,
        cm,
        period,
        fidelity="fast",
        required_cycles=3,
    )

    assert audit.cycles[-1].samples >= 20
    assert "impulsive discontinuity" in audit.cycles[-1].hard_reasons


def _period_boundary_sample_series(
    *,
    interior_samples: tuple[int, int, int],
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Three 1-second cycles with exact shared time boundaries.

    The 58-row variant was the old false-pass shape: inclusive adjacent
    windows counted each boundary twice and reported 20 samples in all three
    cycles. The 60-row shape independently owns exactly 20 rows per cycle.
    """
    times: list[float] = [0.0]
    for cycle, count in enumerate(interior_samples):
        times.extend(
            cycle + (index + 1) / (count + 1)
            for index in range(count)
        )
        if cycle < 2:
            times.append(float(cycle + 1))
    times.append(3.0)
    raw = np.asarray(sorted(set(times)), dtype=float)
    phase = 2.0 * math.pi * raw
    return (
        raw,
        0.70 + 0.08 * np.sin(phase),
        0.030 + 0.010 * np.sin(phase + 0.6),
        -0.050 + 0.004 * np.sin(phase + 1.1),
    )


def test_clean_cycle_sample_floor_does_not_double_count_shared_period_boundaries():
    """MUST-CATCH: 58 distinct rows cannot certify three 20-sample cycles."""
    sparse = _period_boundary_sample_series(interior_samples=(18, 18, 18))
    sparse_audit = audit_period_cycles(
        *sparse,
        1.0,
        fidelity="fast",
        required_cycles=3,
        min_frames_per_cycle=0,
    )
    assert [cycle.samples for cycle in sparse_audit.cycles] == [19, 19, 20]
    assert not sparse_audit.certified
    assert all(
        "samples " in reason
        for cycle in sparse_audit.cycles[:2]
        for reason in cycle.hard_reasons
        if reason.startswith("samples ")
    )

    resolved = _period_boundary_sample_series(interior_samples=(19, 19, 18))
    resolved_audit = audit_period_cycles(
        *resolved,
        1.0,
        fidelity="fast",
        required_cycles=3,
        min_frames_per_cycle=0,
    )
    assert [cycle.samples for cycle in resolved_audit.cycles] == [20, 20, 20]
    assert resolved_audit.certified


def test_clean_cycle_audit_catches_cm_only_nonrepeatable_cycle():
    """Cl/Cd can be smooth while a moment coefficient is still unsettled."""
    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period)
    final = times >= 1.2
    # Double only the Cm waveform in the final cycle. It stays continuous at
    # the endpoints, so it must be a soft repeatability verdict rather than a
    # manufactured sharp-step false positive.
    cm[final] = -0.050 + 0.008 * np.sin(
        2.0 * math.pi * times[final] / period + 1.1
    )

    audit = audit_period_cycles(
        times,
        cl,
        cd,
        cm,
        period,
        fidelity="fast",
        required_cycles=3,
    )

    assert not audit.certified
    assert audit.cycles[-1].disposition == "settling_outlier"
    assert any(reason.startswith("cm ") for reason in audit.cycles[-1].soft_reasons)
    assert audit.cycles[-1].cl_shape_error < 0.02
    assert audit.cycles[-1].cd_shape_error < 0.02


def test_clean_cycle_audit_marks_an_isolated_high_frequency_burst_hard():
    """A smooth high-frequency numerical burst is not a resolved wake shape."""
    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period)
    middle = (times >= 0.6) & (times <= 0.8)
    # The burst is continuous at cycle boundaries and has no one-row jump.
    # It therefore exercises the independent spectral hard-corruption guard.
    cl[middle] += 0.05 * np.sin(2.0 * math.pi * 18.0 * times[middle] / period)

    audit = audit_period_cycles(
        times,
        cl,
        cd,
        cm,
        period,
        fidelity="fast",
        required_cycles=3,
    )

    burst = audit.cycles[3]
    assert burst.disposition == "hard_corrupt"
    assert "cl high-frequency burst" in burst.hard_reasons
    # Later clean cycles remain valid; an old burst cannot force a needless
    # same-case rerun once a contiguous terminal certificate exists.
    assert audit.certified


def test_clean_cycle_audit_requires_frames_in_every_selected_cycle():
    """Twenty frames in one period cannot subsidize an empty neighbour."""
    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period)
    # Six well-resolved cycles and a deliberately sparse final one.
    frames = np.concatenate(
        (
            np.arange(0.0, 1.2, 0.005),
            np.array([1.23, 1.31, 1.39]),
        )
    )

    audit = audit_period_cycles(
        times,
        cl,
        cd,
        cm,
        period,
        fidelity="fast",
        required_cycles=3,
        frame_times=frames,
        min_frames_per_cycle=20,
    )

    assert not audit.certified
    assert audit.cycles[-1].disposition == "hard_corrupt"
    assert any(reason.startswith("frames ") for reason in audit.cycles[-1].hard_reasons)


def test_clean_cycle_floors_and_adaptive_guard_chunk_are_tier_specific():
    assert required_clean_cycle_count(fidelity="fast", required_cycles=2.0) == 3
    assert required_clean_cycle_count(fidelity="full", required_cycles=3.0) == 5
    assert FAST_CLEAN_CYCLE_MINIMUM == 3
    assert FINAL_CLEAN_CYCLE_MINIMUM == 5

    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period, cycles=3)
    audit = audit_period_cycles(
        times,
        cl,
        cd,
        cm,
        period,
        fidelity="full",
        required_cycles=3,
    )
    assert audit.terminal_clean_cycles == 3
    assert not audit.certified
    assert additional_periods_for_clean_suffix(
        audit, fidelity="full", required_cycles=3
    ) == 2
    assert additional_periods_for_clean_suffix(
        audit, fidelity="fast", required_cycles=3, borderline=True
    ) == 3


def test_clean_cycle_recovery_uses_only_the_adaptive_emergency_tier_caps():
    """The short v1 ceilings cannot terminate otherwise progressing evidence."""
    period = 0.2

    def audit_for(*, cycles: int, fidelity: str):
        times, cl, cd, cm = _clean_cycle_series(period=period, cycles=cycles)
        return audit_period_cycles(
            times,
            cl,
            cd,
            cm,
            period,
            fidelity=fidelity,
            required_cycles=3,
        )

    assert FAST_CLEAN_CYCLE_MAX_PERIODS == 18
    assert FINAL_CLEAN_CYCLE_MAX_PERIODS == 27
    # The former FAST=9 / FINAL=12 contract would abandon both trajectories
    # before the v2 controller's bounded clean-tail search completes.
    assert not clean_cycle_recovery_exhausted(audit_for(cycles=7, fidelity="fast"), fidelity="fast")
    assert not clean_cycle_recovery_exhausted(audit_for(cycles=9, fidelity="fast"), fidelity="fast")
    assert clean_cycle_recovery_exhausted(audit_for(cycles=18, fidelity="fast"), fidelity="fast")
    assert not clean_cycle_recovery_exhausted(audit_for(cycles=12, fidelity="full"), fidelity="full")
    assert clean_cycle_recovery_exhausted(audit_for(cycles=27, fidelity="full"), fidelity="full")


def test_same_case_continuation_caps_require_explicit_v2_lineage():
    """The current controller can collect 18/27 periods only when its exact
    source carried the reducer's v2 authority. Missing provenance is
    deliberately indistinguishable from the historical v1 contract."""

    assert clean_cycle_continuation_max_periods("precalc") == 9
    assert clean_cycle_continuation_max_periods("full") == 12
    assert (
        clean_cycle_continuation_max_periods(
            "precalc", policy_version="adaptive-clean-tail-v2"
        )
        == 18
    )
    assert (
        clean_cycle_continuation_max_periods(
            "full", policy_version="adaptive-clean-tail-v2"
        )
        == 27
    )


def test_clean_cycle_recovery_cap_uses_authenticated_physical_progress_not_tail_length():
    """A short candidate tail must not reset FINAL's finite emergency ceiling."""
    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period, cycles=3)
    tail_audit = audit_period_cycles(
        times,
        cl,
        cd,
        cm,
        period,
        fidelity="full",
        required_cycles=5,
    )
    assert len(tail_audit.cycles) == 3
    progressed = with_clean_cycle_recovery_progress(
        tail_audit,
        origin_time=0.0,
        latest_time=12.0 * period,
    )
    assert progressed is not None
    assert progressed.physical_periods == 12
    assert not clean_cycle_recovery_exhausted(progressed, fidelity="full")
    assert (
        additional_periods_for_clean_suffix(
            progressed,
            fidelity="full",
            required_cycles=5,
        )
        == 2
    )
    exhausted = replace(progressed, measured_periods=27)
    assert clean_cycle_recovery_exhausted(exhausted, fidelity="full")
    assert additional_periods_for_clean_suffix(
        exhausted, fidelity="full", required_cycles=5
    ) == 0


@pytest.mark.parametrize(
    ("fidelity", "required_cycles", "measured_periods", "expected"),
    [
        ("fast", 3, 17, 1),
        ("full", 5, 26, 1),
        ("fast", 3, 18, 0),
        ("full", 5, 27, 0),
    ],
)
def test_empty_cycle_audit_still_honors_authenticated_remaining_period_cap(
    fidelity: str,
    required_cycles: int,
    measured_periods: int,
    expected: int,
):
    """A cadence-less audit cannot bypass the physical FAST/FINAL ceiling."""
    audit = CleanCycleAudit(
        period_s=0.2,
        phase_samples=96,
        cycles=(),
        terminal_clean_cycles=0,
        required_clean_cycles=required_cycles,
        template_cycles=0,
        shape_error=math.inf,
        measured_periods=measured_periods,
    )

    assert additional_periods_for_clean_suffix(
        audit,
        fidelity=fidelity,
        required_cycles=required_cycles,
    ) == expected


@pytest.mark.parametrize(
    ("fidelity", "cycles", "required_cycles", "expected"),
    [
        # A newly corrupt terminal period normally earns three periods, but
        # the cap is physical: FAST 17/18 and FINAL 26/27 have only one period
        # left to measure before the reducer must emit a critical exhaustion.
        ("fast", 17, 3, 1),
        ("full", 26, 5, 1),
        ("fast", 18, 3, 0),
        ("full", 27, 5, 0),
    ],
)
def test_clean_cycle_recovery_chunk_never_crosses_remaining_tier_cap(
    fidelity: str,
    cycles: int,
    required_cycles: int,
    expected: int,
):
    period = 0.2
    times, cl, cd, cm = _clean_cycle_series(period=period, cycles=cycles)
    # Break a sample well inside the final period so the audit owns an actual
    # terminal corrupt cycle rather than a fabricated end-point ambiguity.
    final_midpoint = (cycles - 0.45) * period
    cl[np.argmin(abs(times - final_midpoint))] = 4.0
    audit = audit_period_cycles(
        times,
        cl,
        cd,
        cm,
        period,
        fidelity=fidelity,
        required_cycles=required_cycles,
    )

    assert len(audit.cycles) == cycles
    assert not audit.cycles[-1].clean
    assert additional_periods_for_clean_suffix(
        audit,
        fidelity=fidelity,
        required_cycles=required_cycles,
    ) == expected


def test_legacy_fast_boundary_continues_first_clean_cycle_one_period_at_a_time():
    """MUST-CATCH: production reached its first clean suffix after period 9."""

    def cycle(index: int, *, soft: bool = False) -> CycleAudit:
        return CycleAudit(
            index=index,
            start=float(index),
            end=float(index + 1),
            samples=206,
            frames=28,
            phase_gap=0.01,
            phase_shift_bins=0,
            cl_mean=0.7,
            cd_mean=0.035,
            cm_mean=-0.08,
            cl_shape_error=0.01,
            cd_shape_error=0.01,
            cm_shape_error=0.01,
            cl_amplitude_deviation=0.01,
            cd_amplitude_deviation=0.01,
            cm_amplitude_deviation=0.01,
            cl_high_frequency=0.0,
            cd_high_frequency=0.0,
            cm_high_frequency=0.0,
            soft_reasons=("settling shape",) if soft else (),
        )

    audit = CleanCycleAudit(
        period_s=1.0,
        phase_samples=96,
        cycles=(cycle(0, soft=True), cycle(1)),
        terminal_clean_cycles=1,
        required_clean_cycles=3,
        template_cycles=1,
        shape_error=0.01,
        measured_periods=13,
    )
    assert not clean_cycle_recovery_exhausted(audit, fidelity="fast")
    assert additional_periods_for_clean_suffix(
        audit, fidelity="fast", required_cycles=3
    ) == 1


def test_legacy_fast_boundary_replaces_a_soft_terminal_outlier():
    """MUST-CATCH: three clean cycles before one soft outlier earn a repair tail."""

    clean = _clean_cycle_series(period=0.2, cycles=4)
    audit = audit_period_cycles(
        *clean,
        0.2,
        fidelity="fast",
        required_cycles=3,
    )
    softened = replace(
        audit.cycles[-1],
        soft_reasons=("cl shape error 0.157; cd shape error 0.185",),
    )
    production_shape = replace(
        audit,
        cycles=(*audit.cycles[:-1], softened),
        terminal_clean_cycles=0,
        measured_periods=14,
    )
    assert not clean_cycle_recovery_exhausted(production_shape, fidelity="fast")
    assert additional_periods_for_clean_suffix(
        production_shape, fidelity="fast", required_cycles=3
    ) == 3


def test_clean_periodic_tail_promotes_an_alternating_half_cycle_to_its_vector_repeat():
    """A T/2 harmonic lock must not reject a wake that repeats every 2T."""
    half_period = 0.2
    times = np.arange(0.0, 2.0 + 0.0005, 0.001)
    cycle = np.floor((times + 1e-9) / half_period).astype(int)
    amplitude = np.where(cycle % 2 == 0, 0.08, 0.12)
    phase = 2.0 * math.pi * times / half_period
    cl = 0.70 + amplitude * np.sin(phase)
    cd = 0.030 + 0.125 * amplitude * np.sin(phase + 0.6)
    cm = -0.050 + 0.050 * amplitude * np.sin(phase + 1.1)

    # The scalar Cl tracker reasonably sees the strong half-period harmonic.
    # The vector cycle audit must then test 2T and choose the actual repeat.
    initial = estimate_period(times, cl, speed=25.0, chord=1.0)
    assert initial is not None
    assert initial.period_s == pytest.approx(half_period, rel=0.02)

    tail = clean_periodic_tail(
        times,
        cl,
        cd,
        cm,
        speed=25.0,
        chord=1.0,
        required_cycles=3,
        fidelity="fast",
    )

    assert tail is not None
    assert tail.cadence_adjusted
    assert tail.estimate.period_s == pytest.approx(2.0 * half_period, rel=0.02)
    assert tail.clean_cycles >= 3


def test_integer_period_window_uses_final_whole_periods():
    window = integer_period_window([0.0, 0.1, 1.0, 2.0, 3.95, 4.0], period_s=0.5, discard_fraction=0.4, target_cycles=7)

    assert window is not None
    assert window.cycles == 4
    assert window.end == pytest.approx(4.0)
    assert window.start == pytest.approx(2.0)


def test_stable_two_period_window_accepts_two_matching_periods_with_frames(tmp_path: Path):
    coeff = tmp_path / "coefficient.dat"
    _write_coeff(coeff, f=5.0, n=500, dt=0.002)
    frame_times = [0.6 + i * (0.4 / 40) for i in range(41)]

    result = stable_two_period_window(
        coeff,
        speed=25.0,
        chord=1.0,
        frame_times=frame_times,
        min_frames_per_cycle=20,
    )

    assert result.ok
    assert result.stable
    assert result.cycles == 2
    assert result.period_s == pytest.approx(0.2, rel=0.03)
    assert result.frames_per_cycle >= 20


def test_stable_two_period_window_requires_animation_frames(tmp_path: Path):
    coeff = tmp_path / "coefficient.dat"
    _write_coeff(coeff, f=5.0, n=500, dt=0.002)

    result = stable_two_period_window(
        coeff,
        speed=25.0,
        chord=1.0,
        frame_times=[0.6, 0.8, 1.0],
        min_frames_per_cycle=20,
    )

    assert not result.ok
    assert result.stable
    assert "frames/cycle" in result.reason


def test_stable_two_period_window_uses_clean_tail_after_late_startup_burst(
    tmp_path: Path,
):
    """The live early-stop monitor must not be poisoned by discarded startup."""
    coeff = tmp_path / "coefficient.dat"
    _write_coeff_with_late_startup_burst(coeff)
    frame_times = [1.8 + i * (0.2 / 60) for i in range(61)]

    result = stable_two_period_window(
        coeff,
        speed=20.0,
        chord=1.0,
        frame_times=frame_times,
        discard_fraction=0.4,
        min_frames_per_cycle=20,
    )

    assert result.ok
    assert result.stable
    assert result.period_s == pytest.approx(0.1, rel=0.03)
    assert result.window_start is not None and result.window_start >= 1.79
    assert result.frames_per_cycle >= 20


def test_stable_two_period_window_rejects_impulsive_candidate(tmp_path: Path):
    """A one-step jump can look phase-similar after amplitude normalization.

    It is corrupt numerical evidence, not a repeatable physical period, and
    must not release the conservative startup timestep or certify early stop.
    """
    coeff = tmp_path / "coefficient.dat"
    times = np.arange(0.0, 1.002, 0.002)
    period = 0.2

    def cl_at(t: float) -> float:
        wave = 0.7 + 0.08 * math.sin(2.0 * math.pi * t / period)
        return 3.7 if abs(t - 0.7) < 1e-12 else wave

    lines = [
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) "
        "CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    ]
    for t in times:
        row = [
            t,
            0.03,
            0.0,
            0.0,
            cl_at(float(t)),
            0.0,
            0.0,
            -0.05,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        ]
        lines.append(" ".join(f"{value:.12g}" for value in row))
    coeff.write_text("\n".join(lines) + "\n")
    frame_times = [0.6 + i * (0.4 / 60) for i in range(61)]

    result = stable_two_period_window(
        coeff,
        speed=25.0,
        chord=1.0,
        frame_times=frame_times,
        min_frames_per_cycle=20,
    )

    assert not result.ok
    assert not result.stable
    assert "impulsive discontinuity" in result.reason


def test_stable_two_period_window_does_not_classify_restart_seam_as_impulse(
    tmp_path: Path,
):
    """A known OpenFOAM restart boundary is not a new physical solver impulse.

    The live monitor must keep the ordinary period-similarity gate in charge at
    a continuation seam instead of arming expensive numerical recovery. The
    final clean-tail selector remains strict and will not publish this
    deliberately unsettled two-period window.
    """
    header = (
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) "
        "CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    )
    period = 0.2

    def rows(start: float, end: float, mean_shift: float) -> list[str]:
        output = [header]
        for t in np.arange(start, end + 0.0005, 0.001):
            cl = 0.7 + mean_shift + 0.08 * math.sin(2.0 * math.pi * t / period)
            cd = 0.03 + 0.4 * mean_shift + 0.01 * math.sin(
                2.0 * math.pi * t / period + 0.7
            )
            row = [
                t,
                cd,
                0.0,
                0.0,
                cl,
                0.0,
                0.0,
                -0.05,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
            ]
            output.append(" ".join(f"{value:.12g}" for value in row))
        return output

    first = tmp_path / "forceCoeffs1" / "0" / "coefficient.dat"
    second = tmp_path / "forceCoeffs1" / "0.6" / "coefficient.dat"
    first.parent.mkdir(parents=True)
    second.parent.mkdir(parents=True)
    first_rows = rows(0.0, 0.599, 0.0)
    second_rows = rows(0.6, 0.8, 0.08)
    first.write_text("\n".join(first_rows) + "\n")
    second.write_text("\n".join(second_rows) + "\n")

    # A flattened history has no restart provenance and therefore correctly
    # treats the same mean jump as an unexplained impulse.
    flattened = tmp_path / "flattened.dat"
    flattened.write_text(
        "\n".join(first_rows + second_rows[1:]) + "\n"
    )
    frame_times = [0.4 + i * (0.4 / 80) for i in range(81)]
    strict = stable_two_period_window(
        flattened,
        speed=25.0,
        chord=1.0,
        frame_times=frame_times,
        min_frames_per_cycle=20,
    )
    segmented = stable_two_period_window(
        [first, second],
        speed=25.0,
        chord=1.0,
        frame_times=frame_times,
        min_frames_per_cycle=20,
    )

    assert not strict.ok
    assert "impulsive discontinuity" in strict.reason
    assert not segmented.ok
    assert "impulsive discontinuity" not in segmented.reason
    assert "periods differ" in segmented.reason


def _history(t0, t1, st=0.6634408650015379, n=400, cl_rms=0.05, cd_rms=0.01):
    ts = [t0 + (t1 - t0) * i / (n - 1) for i in range(n)]
    return ForceHistory(
        t=ts,
        cl=[0.7] * n,
        cd=[0.3] * n,
        cm=[-0.1] * n,
        cl_mean=0.7,
        cl_rms=cl_rms,
        cd_mean=0.3,
        cd_rms=cd_rms,
        cm_mean=-0.1,
        cm_rms=0.0,
        shedding_freq_hz=st * 7.303255616469686,
        strouhal=st,
        samples=n,
        period_s=1.0 / (st * 7.303255616469686) if st else None,
        retained_cycles=7 if st else None,
        window_start=t0,
        window_end=t1,
    )


def _make_time_dirs(case_dir, times):
    for t in times:
        (case_dir / f"{t:.12g}").mkdir(parents=True, exist_ok=True)


def test_urans_quality_flags_current_sparse_animation_case(tmp_path):
    speed = 7.303255616469686
    hist = _history(221.01577688779508, 224.1077570847098)
    times = [220.0 + (224.1077570847098 - 220.0) * i / 48 for i in range(49)]
    times.append(224.1077570847098)
    _make_time_dirs(tmp_path, times)

    quality = evaluate_urans_quality(tmp_path, hist, speed=speed, chord=1.0)

    assert not quality.ok
    assert quality.can_refine
    assert quality.retained_cycles > 7
    assert quality.frames_per_cycle < 20
    assert "frames/cycle" in quality.reason


def test_urans_quality_passes_after_dense_refined_frames(tmp_path):
    speed = 7.303255616469686
    st = 0.6634408650015379
    period = 1.0 / (st * speed)
    hist = _history(10.0, 10.0 + 7.0 * period, st=st)
    times = [hist.t[0] + (hist.t[-1] - hist.t[0]) * i / 140 for i in range(141)]
    _make_time_dirs(tmp_path, times)

    quality = evaluate_urans_quality(tmp_path, hist, speed=speed, chord=1.0)

    assert quality.ok
    assert not quality.can_refine
    assert quality.retained_cycles == pytest.approx(7.0)
    assert quality.frames_per_cycle >= 20


def test_urans_frame_write_cadence_is_separate_from_quality_gate():
    assert pipeline.URANS_MIN_FRAMES_PER_CYCLE == pytest.approx(20.0)
    assert pipeline.URANS_FRAME_WRITE_PER_CYCLE == pytest.approx(30.0)


def test_refined_transient_timing_uses_measured_period():
    period = 0.2063864970944712
    timing = refined_transient_timing(
        measured_period_s=period,
        original_run_time_s=4.1077570847098,
        original_delta_t=0.00013692523615699336,
        discard_fraction=0.25,
    )

    assert timing.write_interval == pytest.approx(period / pipeline.URANS_FRAME_WRITE_PER_CYCLE)
    assert timing.delta_t == pytest.approx(min(0.00013692523615699336, period / 5000))
    assert timing.run_time_s >= (7 * period) / 0.75
    assert timing.max_delta_t <= timing.write_interval


def test_refined_transient_timing_can_use_safer_write_cadence():
    measured_period = 0.6384676775739064
    cadence_period = 1.0 / (0.75 * 7.5)
    timing = refined_transient_timing(
        measured_period_s=measured_period,
        original_run_time_s=1.0666666666666667,
        original_delta_t=0.00005333333333333333,
        discard_fraction=0.4,
        cadence_period_s=cadence_period,
    )

    assert timing.write_interval == pytest.approx(
        measured_period / pipeline.URANS_FRAME_WRITE_PER_CYCLE
    )
    assert timing.run_time_s >= (7 * measured_period) / 0.6
    assert (timing.run_time_s / timing.write_interval) == pytest.approx(
        round(timing.run_time_s / timing.write_interval)
    )


def test_urans_quality_missing_strouhal_does_not_refine(tmp_path):
    # Flat force history with no strouhal AND no fluctuation: a physically
    # steady (no-shedding) URANS. It must resolve as a valid steady-mean point,
    # never as a refinable shedding case (auto-refining it triggers the
    # degenerate refined-copy crash).
    hist = _history(0.0, 4.3, st=0.0, cl_rms=0.0, cd_rms=0.0)

    quality = evaluate_urans_quality(tmp_path, hist, speed=10.0, chord=1.0)

    assert quality.ok
    assert quality.no_shedding
    assert not quality.can_refine
    assert quality.measured_period_s is None
    assert "no vortex shedding" in quality.reason


def test_vtu_selector_returns_final_retained_window(tmp_path):
    vtk = tmp_path / "VTK"
    period = 0.2
    final_time = 12.0
    start = final_time - 7 * period
    for i in range(240):
        t = 8.0 + (final_time - 8.0) * i / 239
        d = vtk / f"transient_{t:.6f}"
        d.mkdir(parents=True)
        (d / "internal.vtu").write_text("")

    selected = select_vtus(find_all_vtus(tmp_path), start_time=start, end_time=final_time, max_frames=140)
    selected_times = [float(p.parent.name.split("_")[-1]) for p in selected]

    assert len(selected) <= 140
    assert selected_times[0] >= start
    assert selected_times[-1] <= final_time
    assert selected_times[-1] - selected_times[0] == pytest.approx(7 * period, rel=0.03)


def test_vtu_selector_uses_physical_time_for_foam_index_dirs(tmp_path):
    vtk = tmp_path / "VTK"
    for index, t in enumerate((606.0, 606.5, 607.0), start=2000):
        d = vtk / f"case_{index}"
        d.mkdir(parents=True)
        (d / "internal.vtu").write_text(
            f"<?xml version='1.0'?>\n<!-- time='{t}' index='{index}' -->\n"
        )

    selected = select_vtus(find_all_vtus(tmp_path), start_time=606.4, end_time=607.1)

    assert [p.parent.name for p in selected] == ["case_2001", "case_2002"]


def _rans_outcome(
    aoa,
    *,
    converged=True,
    error=None,
    cl=0.4,
    cd=0.02,
    failure_disposition=FailureDisposition.none,
):
    return CaseOutcome(
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=aoa),
        reynolds=666_666,
        cl=cl,
        cd=cd,
        converged=converged,
        error=error,
        failure_disposition=failure_disposition,
    )


def test_core_rans_failure_aborts_whole_sweep_for_urans():
    hard = FailureDisposition.hard_solver
    assert should_abort_rans_sweep_for_urans(
        3.0, _rans_outcome(3.0, converged=False, failure_disposition=hard)
    )
    assert should_abort_rans_sweep_for_urans(
        0.0, _rans_outcome(0.0, error="solver diverged", failure_disposition=hard)
    )
    assert should_abort_rans_sweep_for_urans(
        5.0, _rans_outcome(5.0, cd=-0.01, failure_disposition=hard)
    )
    assert should_abort_rans_sweep_for_urans(
        2.0, _rans_outcome(2.0, cl=math.nan, failure_disposition=hard)
    )


def test_rans_abort_rule_is_limited_to_attached_core_range():
    hard = FailureDisposition.hard_solver
    assert not should_abort_rans_sweep_for_urans(
        -1.0, _rans_outcome(-1.0, converged=False, failure_disposition=hard)
    )
    assert not should_abort_rans_sweep_for_urans(
        6.0, _rans_outcome(6.0, converged=False, failure_disposition=hard)
    )
    assert not should_abort_rans_sweep_for_urans(3.0, _rans_outcome(3.0, converged=True))


@pytest.mark.parametrize(
    "disposition",
    [FailureDisposition.deterministic_mesh, FailureDisposition.infrastructure],
)
def test_core_non_solver_failure_does_not_abort_whole_sweep(disposition):
    """FALSE-POSITIVE GUARD: rejected evidence in the attached range is not
    itself permission to spend a whole polar of URANS. Mesh and execution
    failures remain repair/retry work even when the point has no coefficients."""
    outcome = _rans_outcome(
        2.0,
        converged=False,
        # Deliberately solver-looking text: policy must use the typed field,
        # not accidentally promote because a launcher/mesh message contains
        # words such as "solver" or "diverged".
        error="simpleFoam solver diverged before force evidence",
        cl=None,
        cd=None,
        failure_disposition=disposition,
    )
    assert not should_abort_rans_sweep_for_urans(2.0, outcome)


def test_failure_disposition_serializes_on_engine_polar_point():
    from airfoilfoam.jobs import _outcome_to_point

    outcome = _rans_outcome(
        2.0,
        converged=False,
        failure_disposition=FailureDisposition.hard_solver,
    )
    payload = _outcome_to_point("engine-job", "polar/a0", outcome).model_dump(mode="json")

    assert payload["failure_disposition"] == "hard_solver"


def test_whole_polar_urans_replacement_reuses_shared_mesh(tmp_path, monkeypatch):
    from airfoilfoam import physics
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    shared_mesh = tmp_path / "mesh"
    seen_meshes = []

    def fake_run_case(
        case_dir,
        airfoil,
        spec,
        fluid,
        roughness,
        mesh_params,
        solver_params,
        mesher,
        runner,
        n_proc=1,
        render_images=True,
        solver_timeout=7200,
        mesh_dir=None,
        cancel_check=None,
        phase_progress=None,
        case_slug=None,
        media_budget_s=None,
    ):
        seen_meshes.append(mesh_dir)
        assert solver_params.force_transient
        assert solver_params.transient_auto_refine
        assert solver_params.urans_fidelity.value == "precalc"
        return CaseOutcome(
            spec=spec,
            reynolds=physics.reynolds(spec.speed, spec.chord, fluid.nu),
            cl=0.1 * spec.aoa_deg,
            cd=0.02,
            cl_cd=(0.1 * spec.aoa_deg) / 0.02,
            unsteady=True,
            converged=True,
            fidelity=f"urans_{solver_params.urans_fidelity.value}",
        )

    monkeypatch.setattr(pipeline, "run_case", fake_run_case)
    fluid = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
    points = _run_full_urans_replacement(
        tmp_path / "polar",
        shared_mesh,
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=fluid,
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=None,
        runner=None,
        aoas=[0.0, 2.0, 4.0],
    )

    assert len(points) == 3
    assert seen_meshes == [shared_mesh, shared_mesh, shared_mesh]
    assert all(p.outcome.unsteady for p in points)
    assert all(p.outcome.fidelity == "urans_precalc" for p in points)


@pytest.mark.parametrize(
    "failure",
    [
        RunResult(
            command="mpirun --use-hwthread-cpus -np 8 simpleFoam -parallel",
            returncode=124,
            stdout="Command timed out after 1200s",
            timed_out=True,
        ),
        RunResult(
            command="mpirun --use-hwthread-cpus -np 8 simpleFoam -parallel",
            returncode=1,
            stdout=(
                "There are not enough slots available in the system to satisfy "
                "the 8 slots that were requested"
            ),
        ),
        InsufficientMpiSlotsError(requested=8, available=4),
        DeterministicMeshError("checkMesh deterministic gate: negative-volume cells"),
    ],
    ids=[
        "solver-command-timeout",
        "openmpi-runtime-slot-refusal",
        "declared-capacity-refusal",
        "deterministic-mesh",
    ],
)
def test_marched_execution_or_mesh_failure_is_retained_but_never_promoted(
    tmp_path, monkeypatch, failure
):
    """MUST-CATCH: production-shaped timeout, MPI-capacity and deterministic
    mesh failures at 2 degrees stay evidence-only and cannot trigger the
    expensive whole-polar fallback."""
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    def fake_cold(*_args, **_kwargs):
        if isinstance(failure, BaseException):
            raise failure
        return failure

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(
        pipeline,
        "_run_full_urans_replacement",
        lambda *_args, **_kwargs: pytest.fail("non-solver failure must not promote"),
    )

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "shared-mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=SimpleNamespace(patches=lambda _resolved: {}),
        runner=None,
        aoas=[2.0, 6.0],
        render_images=False,
    )

    assert not result.promoted_to_urans
    assert result.points == []
    assert len(result.attempts) == 2
    first = result.attempts[0].outcome
    expected = (
        FailureDisposition.deterministic_mesh
        if isinstance(failure, DeterministicMeshError)
        else FailureDisposition.infrastructure
    )
    assert first.failure_disposition == expected


def test_marched_watchdog_divergence_is_hard_solver_failure_and_promotes(tmp_path, monkeypatch):
    """MUST-CATCH: a numerical divergence condemnation is aerodynamic/numerical
    solver evidence, unlike a timeout or launcher failure, so it promotes when
    it occurs in the inclusive 0..5 degree range."""
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    def fake_cold(polar_dir, *_args, **_kwargs):
        pipeline.write_divergence_condemnation(
            polar_dir,
            "simpleFoam residuals and force coefficients diverged monotonically",
        )
        return RunResult(
            command="simpleFoam",
            returncode=143,
            stdout="watchdog terminated divergent solver",
            timed_out=False,
        )

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_run_full_urans_replacement", lambda *_a, **_k: [])

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "shared-mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=SimpleNamespace(patches=lambda _resolved: {}),
        runner=None,
        aoas=[2.0, 6.0],
        render_images=False,
    )

    assert result.promoted_to_urans
    assert len(result.attempts) == 1
    assert result.attempts[0].outcome.failure_disposition == FailureDisposition.hard_solver


def test_sigfpe_is_hard_solver_evidence_but_other_signals_remain_infrastructure(tmp_path):
    """MUST-CATCH: the production-shaped simpleFoam SIGFPE is numerical
    evidence; a generic process signal with the same log wording is not."""
    with pytest.raises(HardSolverError, match="SIGFPE"):
        pipeline._checked_solver_result(
            tmp_path,
            RunResult(
                command="simpleFoam",
                returncode=-signal.SIGFPE,
                stdout="FOAM FATAL ERROR: Floating point exception",
            ),
        )

    with pytest.raises(InfrastructureError):
        pipeline._checked_solver_result(
            tmp_path,
            RunResult(
                command="simpleFoam",
                returncode=-signal.SIGTERM,
                stdout="FOAM FATAL ERROR: Floating point exception",
            ),
        )


def test_marched_sweep_cancellation_is_not_promoted_to_urans(tmp_path, monkeypatch):
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    def fake_cold(*_args, **_kwargs):
        raise JobCancelled("cancelled")

    def fake_urans(*_args, **_kwargs):
        raise AssertionError("cancelled RANS must not trigger URANS promotion")

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_run_full_urans_replacement", fake_urans)

    with pytest.raises(JobCancelled):
        solve_polar_marched(
            tmp_path / "polar",
            tmp_path / "mesh",
            airfoil=SimpleNamespace(),
            chord=1.0,
            speed=10.0,
            fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
            roughness=RoughnessParams(),
            resolved=MeshParams(),
            solver_params=SolverParams(),
            mesher=SimpleNamespace(patches=lambda _resolved: {}),
            runner=SimpleNamespace(),
            aoas=[0.0, 2.0],
        )


def test_force_transient_rejects_missing_frame_track(tmp_path, monkeypatch):
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams
    from airfoilfoam.openfoam.runner import HardSolverError

    class FakeRunner:
        def application(self, *_args, **_kwargs):
            return SimpleNamespace(ok=True, check=lambda: None)

    avg = SimpleNamespace(cl=0.45, cd=0.08, cm=-0.02, cl_cd=5.625, cl_std=0.01, cd_std=0.002, cm_std=0.001)

    def fake_transient(case_dir, *_args, **_kwargs):
        return TransientResult(
            avg=avg,
            case_dir=case_dir,
            force_history=None,
            quality=UransQuality(ok=True, can_refine=False, reason="ok"),
            start_time=0.0,
            end_time=1.0,
            run_time=1.0,
        )

    monkeypatch.setattr(pipeline, "_run_transient", fake_transient)
    outcome = CaseOutcome(spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=0.0), reynolds=666_666)

    with pytest.raises(HardSolverError, match="no integer-period frame track"):
        _finalize_outcome(
            tmp_path,
            outcome,
            airfoil=SimpleNamespace(name="unit airfoil", contour=[]),
            resolved=MeshParams(),
            spec=outcome.spec,
            fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
            roughness=RoughnessParams(),
            solver_params=SolverParams(force_transient=True, write_images=[]),
            runner=FakeRunner(),
            n_proc=1,
            render_images=False,
            solver_timeout=7200,
        )

    assert outcome.unsteady
    assert not outcome.converged
    assert outcome.cl == pytest.approx(0.45)
    assert outcome.cd == pytest.approx(0.08)


def test_transient_attempt_accepts_force_coefficients_under_zero_folder(tmp_path, monkeypatch):
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, RoughnessParams, SolverParams

    written_solver_params = []

    class FakeCaseBuilder:
        def __init__(self, *args, **_kwargs):
            self.solver_params = args[6]

        def write_transient(self, *_args, **_kwargs):
            written_solver_params.append(self.solver_params)

    class FakeRunner:
        def solver(self, case_dir, *_args, **_kwargs):
            coeff = case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            coeff.parent.mkdir(parents=True, exist_ok=True)
            rows = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
            for i in range(20):
                t = 0.01 * (i + 1)
                rows.append(f"{t:.4f} 0.020 0 0 0.500 0 0 -0.010 0 0 0 0 0")
            coeff.write_text("\n".join(rows) + "\n")
            return SimpleNamespace(ok=True, stdout="pimple ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=0.0),
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(),
        runner=FakeRunner(),
        n_proc=1,
        timeout=120,
        run_time=0.2,
        delta_t=0.001,
    )

    assert result is not None
    assert result.avg.cl == pytest.approx(0.5)
    assert result.avg.cd == pytest.approx(0.02)
    assert written_solver_params
    assert written_solver_params[0].transient_max_courant == pytest.approx(
        pipeline.URANS_STARTUP_MAX_COURANT
    )


def test_finalizer_archives_first_pass_failure_before_propagating(
    tmp_path, monkeypatch
):
    """MUST-CATCH: a terminal automatic URANS failure still reaches the
    immutable evidence archiver before the batch records its critical result."""

    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    captured: dict[str, object] = {}

    def failed_transient(case_dir, *_args, subdir="transient", **_kwargs):
        failed = (
            Path(case_dir)
            / subdir
            / pipeline.URANS_NUMERICAL_RECOVERY_DIR
            / "v2"
            / "event_001"
            / "pass_1_numerical"
        )
        failed.mkdir(parents=True)
        (failed / "failure.json").write_text('{"classification":"numerical"}\n')
        raise HardSolverError("version-2 conservative retry exhausted")

    def capture_archive(case_dir, post_dir, outcome, **kwargs):
        captured["case_dir"] = Path(case_dir)
        captured["post_dir"] = Path(post_dir)
        captured["outcome"] = outcome
        captured["failure_exists"] = (
            Path(post_dir)
            / pipeline.URANS_NUMERICAL_RECOVERY_DIR
            / "v2"
            / "event_001"
            / "pass_1_numerical"
            / "failure.json"
        ).is_file()

    monkeypatch.setattr(pipeline, "_run_transient", failed_transient)
    monkeypatch.setattr(pipeline, "_archive_case_evidence", capture_archive)
    spec = CaseSpec(chord=1.0, speed=10.0, aoa_deg=15.0)
    outcome = CaseOutcome(spec=spec, reynolds=666_666)

    with pytest.raises(HardSolverError, match="conservative retry exhausted"):
        _finalize_outcome(
            tmp_path,
            outcome,
            airfoil=SimpleNamespace(name="unit", contour=[]),
            resolved=MeshParams(),
            spec=spec,
            fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
            roughness=RoughnessParams(),
            solver_params=SolverParams(force_transient=True, write_images=[]),
            runner=SimpleNamespace(),
            n_proc=1,
            render_images=False,
            solver_timeout=7200,
        )

    assert captured["post_dir"] == tmp_path / "transient"
    assert captured["failure_exists"] is True
    assert outcome.unsteady and not outcome.converged
    assert outcome.fidelity == "urans_full"


def test_transient_attempt_early_stop_retains_gate_minimum_periods(tmp_path, monkeypatch):
    """Early stop fires only after URANS_STABLE_RETAINED_CYCLES (+margin)
    periods of certified-stable data exist past the FIRST stable window start,
    so early-stopped points retain >= the node acceptance gate (5 periods) —
    never the old 2-period stop the classifier deterministically rejected."""
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, RoughnessParams, SolverParams

    period = 0.2  # f = 5 Hz

    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, case_dir, *_args, **_kwargs):
            system = case_dir / "system"
            system.mkdir(parents=True, exist_ok=True)
            (system / "controlDict").write_text(
                "stopAt endTime;\nendTime 3;\nwriteInterval 0.1;\nmaxDeltaT 0.1;\nrunTimeModifiable true;\n"
            )

    class FakeRunner:
        def solver(self, case_dir, *_args, monitor=None, **_kwargs):
            coeff = case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            coeff.parent.mkdir(parents=True, exist_ok=True)

            def grow_to(t_end: float) -> None:
                n = int(round(t_end / 0.002))
                _write_coeff(coeff, f=5.0, n=n, dt=0.002, cl0=0.7, cd0=0.2)
                i = 0
                while 0.6 + i * 0.005 <= t_end + 1e-9:
                    (case_dir / f"{0.6 + i * 0.005:.6f}").mkdir(parents=True, exist_ok=True)
                    i += 1

            # First poll: stable two-period window detected (window start
            # ~t=0.8) but retention target not reached -> NO stop yet.
            grow_to(1.2)
            if monitor is not None:
                monitor()
            assert not (case_dir / "urans_early_stop.json").exists()
            # Data accumulates past stable_since + (5 + 0.5) periods -> stop.
            grow_to(2.2)
            if monitor is not None:
                monitor()
            return SimpleNamespace(ok=True, stdout="pimple ok")

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)
    tcase = tmp_path / "transient"
    (tcase / "0").mkdir(parents=True)

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=CaseSpec(chord=1.0, speed=25.0, aoa_deg=0.0),
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(),
        runner=FakeRunner(),
        n_proc=1,
        timeout=120,
        run_time=3.0,
        delta_t=0.001,
    )

    assert result is not None
    assert result.early_stopped
    marker = pipeline._read_early_stop_marker(tcase)
    assert marker is not None
    # retain_from = start of the FIRST certified-stable window.
    assert isinstance(marker.get("retain_from"), float)
    assert result.force_history is not None
    # Retention floor: the early stop must never retain fewer whole periods
    # than the node gate (packages/core FRAME_TRACK_MIN_PERIODS = 5).
    assert result.force_history.retained_cycles == int(pipeline.URANS_STABLE_RETAINED_CYCLES)
    assert result.force_history.retained_cycles >= 5
    assert result.quality.ok
    assert result.quality.retained_cycles == pytest.approx(
        pipeline.URANS_STABLE_RETAINED_CYCLES, rel=0.05
    )
    assert "early-stop target met" in result.quality.reason


def test_marched_core_rans_failure_stops_rans_and_promotes_full_urans(tmp_path, monkeypatch):
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True

        def __init__(self, stdout: str):
            self.stdout = stdout

        def check(self):
            return self

    rans_aoas = []
    shared_mesh = tmp_path / "shared-mesh"
    requested_aoas = [-1.0, 0.0, 1.0, 2.0, 6.0]

    def fake_cold(*args, **kwargs):
        spec = args[5]
        rans_aoas.append(spec.aoa_deg)
        return FakeRunResult("Time = 1\nSIMPLE solution converged in 1 iterations\n")

    def fake_warm(_polar_dir, spec, *_args, **_kwargs):
        rans_aoas.append(spec.aoa_deg)
        if spec.aoa_deg == 2.0:
            return FakeRunResult("Time = 2\n")
        return FakeRunResult("Time = 2\nSIMPLE solution converged in 1 iterations\n")

    def fake_finalize(_case_dir, outcome, *_args, **_kwargs):
        outcome.cl = 0.1 * outcome.spec.aoa_deg
        outcome.cd = 0.02
        outcome.cm = 0.0
        outcome.cl_cd = outcome.cl / outcome.cd

    def fake_full_urans(
        polar_dir,
        mesh_dir,
        _airfoil,
        chord,
        speed,
        _fluid,
        _roughness,
        _resolved,
        _solver_params,
        _mesher,
        _runner,
        aoas,
        **_kwargs,
    ):
        assert mesh_dir == shared_mesh
        assert list(aoas) == sorted(requested_aoas)
        points = []
        for i, aoa in enumerate(sorted(aoas)):
            outcome = CaseOutcome(
                spec=CaseSpec(chord=chord, speed=speed, aoa_deg=aoa),
                reynolds=666_666,
                cl=0.2 * aoa,
                cd=0.03,
                cm=0.0,
                cl_cd=(0.2 * aoa) / 0.03,
                unsteady=True,
                converged=True,
            )
            points.append(pipeline.StoredCaseOutcome(slug=f"{polar_dir.name}/urans_a{i}", outcome=outcome))
        return points

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_solve_warm", fake_warm)
    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)
    monkeypatch.setattr(pipeline, "_run_full_urans_replacement", fake_full_urans)

    result = solve_polar_marched(
        tmp_path / "polar",
        shared_mesh,
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=FakeMesher(),
        runner=None,
        aoas=requested_aoas,
        render_images=False,
    )

    # The primary RANS sweep starts at the 0-degree attached-flow anchor;
    # the +2-degree hard failure still promotes the exact original request.
    assert rans_aoas == [0.0, 1.0, 2.0]
    assert result.promoted_to_urans
    assert "switching the whole polar to URANS" in result.abort_reason
    assert [p.outcome.spec.aoa_deg for p in result.attempts] == [0.0, 1.0, 2.0]
    assert [p.outcome.spec.aoa_deg for p in result.points] == sorted(requested_aoas)
    assert all(p.outcome.unsteady for p in result.points)


def test_primary_rans_zero_anchor_restores_only_accepted_fields(tmp_path, monkeypatch):
    """MUST-CATCH A18: branch order and rejected-state recovery are explicit.

    The first negative point starts from the saved 0-degree fields.  When -2
    is rejected, -3 restores the last accepted negative field (-1), rather
    than continuing the rejected latestTime.  Stable output labels still use
    the original sorted-AoA positions.
    """
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True

        def __init__(self, stdout: str):
            self.stdout = stdout

        def check(self):
            return self

    calls = []
    restores = []
    phases = []
    published = []

    def fake_cold(*args, **_kwargs):
        calls.append(("cold", args[5].aoa_deg))
        return FakeRunResult("Time = 1\nSIMPLE solution converged in 1 iterations\n")

    def fake_warm(_polar_dir, spec, *_args, **_kwargs):
        calls.append(("warm", spec.aoa_deg))
        stdout = "Time = 2\n"
        if spec.aoa_deg != -2.0:
            stdout += "SIMPLE solution converged in 1 iterations\n"
        return FakeRunResult(stdout)

    def fake_finalize(_case_dir, outcome, *_args, **_kwargs):
        outcome.cl = 0.1 * outcome.spec.aoa_deg
        outcome.cd = 0.02
        outcome.cm = 0.0
        outcome.cl_cd = outcome.cl / outcome.cd

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_solve_warm", fake_warm)
    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)
    monkeypatch.setattr(
        pipeline,
        "_snapshot_steady_march_state",
        lambda _polar_dir, name: Path(name),
    )
    monkeypatch.setattr(
        pipeline,
        "_restore_steady_march_state",
        lambda _polar_dir, checkpoint: restores.append(checkpoint.name) or True,
    )
    monkeypatch.setattr(
        pipeline,
        "_publish_steady_seed",
        lambda *_args: published.append(_args[5].aoa_deg),
    )

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(transient_fallback=False, write_images=[]),
        mesher=FakeMesher(),
        runner=None,
        aoas=[-3.0, -2.0, -1.0, 0.0, 1.0, 2.0],
        render_images=False,
        phase_progress=lambda _phase, aoa, slug, *_args: phases.append((aoa, slug)),
    )

    assert calls == [
        ("cold", 0.0),
        ("warm", 1.0),
        ("warm", 2.0),
        ("warm", -1.0),
        ("warm", -2.0),
        ("warm", -3.0),
    ]
    assert restores == ["zero", "last"]
    # Only non-negative accepted steady points may enter the shared seed cache.
    assert published == [0.0, 1.0, 2.0]
    assert phases == [
        (0.0, "polar/a3"),
        (1.0, "polar/a4"),
        (2.0, "polar/a5"),
        (-1.0, "polar/a2"),
        (-2.0, "polar/a1"),
        (-3.0, "polar/a0"),
    ]
    assert [item.outcome.spec.aoa_deg for item in result.attempts] == [0.0, 1.0, 2.0, -1.0, -2.0, -3.0]
    assert [item.outcome.spec.aoa_deg for item in result.points] == [-3.0, -2.0, -1.0, 0.0, 1.0, 2.0]
    assert not next(item.outcome for item in result.points if item.outcome.spec.aoa_deg == -2.0).converged


def test_steady_march_checkpoint_restores_accepted_case_without_touching_evidence(tmp_path):
    """A checkpoint replaces mutable fields/dictionaries, never archived AoA evidence."""
    polar_dir = tmp_path / "polar"
    (polar_dir / "300").mkdir(parents=True)
    (polar_dir / "300" / "U").write_text("accepted U\n")
    (polar_dir / "system").mkdir()
    (polar_dir / "system" / "controlDict").write_text("accepted dictionaries\n")
    evidence = polar_dir / "a3" / "evidence"
    evidence.mkdir(parents=True)
    (evidence / "manifest.json").write_text("immutable evidence\n")

    checkpoint = pipeline._snapshot_steady_march_state(polar_dir, "last")
    assert checkpoint is not None

    (polar_dir / "300" / "U").write_text("rejected U\n")
    (polar_dir / "600").mkdir()
    (polar_dir / "600" / "U").write_text("rejected later U\n")
    (polar_dir / "system" / "controlDict").write_text("rejected fallback dictionaries\n")
    (polar_dir / "postProcessing").mkdir()
    (polar_dir / "postProcessing" / "stale").write_text("stale\n")
    (polar_dir / "processor0").mkdir()

    assert pipeline._restore_steady_march_state(polar_dir, checkpoint)
    assert (polar_dir / "300" / "U").read_text() == "accepted U\n"
    assert not (polar_dir / "600").exists()
    assert (polar_dir / "system" / "controlDict").read_text() == "accepted dictionaries\n"
    assert not (polar_dir / "postProcessing").exists()
    assert not (polar_dir / "processor0").exists()
    assert (evidence / "manifest.json").read_text() == "immutable evidence\n"


def test_marched_primary_rans_honors_profile_iterations_and_short_timeout(tmp_path, monkeypatch):
    """The PRIMARY steady RANS stage runs the profile's full n_iterations
    budget (the worker-side rans_max_iterations cap is scoped to URANS-init
    steady stages; 2026-07-07 gate incident: profile n_iterations=3000 ran
    with controlDict endTime 600) while still using the short RANS wall-clock
    timeout; the promoted URANS replacement keeps the guard timeout."""
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True

        def __init__(self, stdout: str):
            self.stdout = stdout

        def check(self):
            return self

    rans_timeouts = []
    rans_iterations = []
    urans_timeout = None

    def fake_cold(*args, **_kwargs):
        rans_timeouts.append(args[10])
        rans_iterations.append(args[8].n_iterations)
        return FakeRunResult("Time = 1\nSIMPLE solution converged in 1 iterations\n")

    def fake_warm(*args, **_kwargs):
        rans_timeouts.append(args[4])
        rans_iterations.append(args[2].n_iterations)
        return FakeRunResult("Time = 2\n")

    def fake_finalize(_case_dir, outcome, *_args, **_kwargs):
        outcome.cl = 0.1
        outcome.cd = 0.02
        outcome.cm = 0.0
        outcome.cl_cd = 5.0

    def fake_full_urans(*_args, **kwargs):
        nonlocal urans_timeout
        urans_timeout = kwargs["solver_timeout"]
        return []

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_solve_warm", fake_warm)
    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)
    monkeypatch.setattr(pipeline, "_run_full_urans_replacement", fake_full_urans)

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(n_iterations=3000),
        mesher=FakeMesher(),
        runner=None,
        aoas=[0.0, 1.0],
        render_images=False,
        solver_timeout=7200,
        rans_solver_timeout=123,
        rans_max_iterations=456,
    )

    assert result.promoted_to_urans
    assert rans_timeouts == [123, 123]
    # MUST-CATCH (gate incident): the worker cap (456 here, 600 in prod) must
    # NOT shrink the primary steady budget below the profile's n_iterations.
    assert rans_iterations == [3000, 3000]
    assert urans_timeout == 7200


def test_rejected_non_core_rans_with_force_data_ships_honest_points(tmp_path, monkeypatch):
    """MUST-CATCH (2026-07-07 ladder-gate incident, job a2379532): a
    non-converged steady RANS point that produced REAL force data ships as an
    honest point (converged=false) instead of silently vanishing into the
    attempts bucket — a fully-non-converged (e.g. single-point) job must never
    ship points=[] / "All cases failed" when force data exists."""
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True
        stdout = "Time = 1\n"

        def check(self):
            return self

    def fake_cold(*_args, **_kwargs):
        return FakeRunResult()

    def fake_warm(*_args, **_kwargs):
        return FakeRunResult()

    def fake_finalize(_case_dir, outcome, *_args, **_kwargs):
        outcome.cl = 0.2
        outcome.cd = 0.02
        outcome.cm = 0.0
        outcome.cl_cd = 10.0
        outcome.converged = False

    monkeypatch.setattr(pipeline, "_solve_cold_marched", fake_cold)
    monkeypatch.setattr(pipeline, "_solve_warm", fake_warm)
    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)
    monkeypatch.setattr(pipeline, "_publish_steady_seed", lambda *a, **k: pytest.fail(
        "a rejected (non-converged) steady point must never publish a warm-start seed"
    ))

    accepted_flags = []

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=FakeMesher(),
        runner=None,
        aoas=[-1.0, 6.0],
        render_images=False,
        outcome_progress=lambda _stored, accepted: accepted_flags.append(accepted),
    )

    assert not result.promoted_to_urans
    # Honest points ship (converged=false) AND stay in attempts as evidence.
    assert [p.outcome.spec.aoa_deg for p in result.points] == [-1.0, 6.0]
    assert all(not p.outcome.converged for p in result.points)
    assert all(p.outcome.error is None for p in result.points)
    assert [p.outcome.spec.aoa_deg for p in result.attempts] == [-1.0, 6.0]
    # Each outcome is recorded first as an attempt, then as an accepted point.
    assert accepted_flags == [False, True, False, True]


def test_missing_coefficient_evidence_is_infrastructure_and_never_promotes(
    tmp_path, monkeypatch
):
    """MUST-CATCH: a true crash (no coefficient data at all — _finalize_outcome
    raises) keeps the pre-existing behavior: evidence-only attempt with a
    truthful error, honestly ABSENT from the polar points."""
    from airfoilfoam import pipeline
    from airfoilfoam.models import FluidProperties, MeshParams, RoughnessParams, SolverParams
    from airfoilfoam.openfoam.runner import OpenFOAMError

    class FakeMesher:
        def patches(self, resolved):
            return {}

    class FakeRunResult:
        ok = True
        stdout = "Time = 1\n"

        def check(self):
            return self

    monkeypatch.setattr(pipeline, "_solve_cold_marched", lambda *a, **k: FakeRunResult())
    monkeypatch.setattr(pipeline, "_solve_warm", lambda *a, **k: FakeRunResult())

    def fake_finalize(_case_dir, _outcome, *_args, **_kwargs):
        raise OpenFOAMError("forceCoeffs produced no coefficient.dat")

    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)

    result = solve_polar_marched(
        tmp_path / "polar",
        tmp_path / "mesh",
        airfoil=None,
        chord=1.0,
        speed=10.0,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        resolved=MeshParams(),
        solver_params=SolverParams(),
        mesher=FakeMesher(),
        runner=None,
        aoas=[2.0, 6.0],
        render_images=False,
    )

    assert not result.promoted_to_urans
    assert result.points == []
    assert len(result.attempts) == 2
    assert all(
        item.outcome.failure_disposition == FailureDisposition.infrastructure
        for item in result.attempts
    )
    assert all("no coefficient.dat" in item.outcome.error for item in result.attempts)
