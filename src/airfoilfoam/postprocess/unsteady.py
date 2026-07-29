"""Unsteady (URANS) post-processing: force time-history + measured Strouhal.

The transient (pimpleFoam) fallback already time-averages the forces for the mean
Cl/Cd. This module additionally keeps the *time series* (for the Cl(t)/Cd(t) force
monitors in the UI) and measures the vortex-shedding Strouhal number from the FFT of
the lift signal — replacing the fixed St=0.2 estimate with the real spectral peak.
"""
from __future__ import annotations

from dataclasses import dataclass, replace
import math
from pathlib import Path
from typing import Sequence

import numpy as np

from .forces import OSCILLATING_AMPLITUDE_GROWTH_MAX, _data_rows


@dataclass
class ForceHistory:
    t: list[float]
    cl: list[float]
    cd: list[float]
    cm: list[float]
    cl_mean: float
    cl_rms: float
    cd_mean: float
    cd_rms: float
    cm_mean: float
    cm_rms: float
    shedding_freq_hz: float
    strouhal: float
    samples: int
    period_s: float | None = None
    retained_cycles: int | None = None
    window_start: float | None = None
    window_end: float | None = None


@dataclass(frozen=True)
class ForceHistoryTransportStatistics:
    """Time-weighted statistics from the bounded force-history witness.

    ``ForceHistory`` retains source-window statistics calculated before its
    arrays are downsampled for transport.  These values intentionally describe
    the *transported* arrays instead, so a consumer can bind a certificate to
    the exact witness it receives without treating a lossy projection as raw
    source evidence.
    """

    cl_mean: float
    cl_rms: float
    cd_mean: float
    cd_rms: float
    cm_mean: float
    cm_rms: float


@dataclass(frozen=True)
class PeriodWindow:
    start: float
    end: float
    cycles: int
    period_s: float


@dataclass(frozen=True)
class StablePeriodResult:
    ok: bool
    reason: str
    stable: bool = False
    period_s: float | None = None
    window_start: float | None = None
    window_end: float | None = None
    cycles: int = 0
    frame_count: int = 0
    frames_per_cycle: float = 0.0
    similarity: float | None = None
    mean_drift: float | None = None
    clean_cycles: int = 0
    required_clean_cycles: int = 0


# --------------------------------------------------------------------------- #
# Clean-cycle certification v3
# --------------------------------------------------------------------------- #
#
# A credible shedding period is only a cadence candidate.  A physical URANS
# mean must be backed by a *contiguous terminal suffix* of individually clean
# cycles; otherwise a damaged startup period, restart overshoot, or one bad
# adaptive step can leak into the average merely because a whole-window FFT
# happened to find the right frequency.  These values deliberately live in
# post-processing rather than the API: the exact per-cycle audit is a
# deterministic interpretation of immutable coefficient/field evidence.

#: Versioned in result evidence by the caller when this interpretation is
#: persisted.  Keeping the reducer version here makes the numerical policy
#: discoverable to tests and prevents a future threshold change from silently
#: looking like the same certification.
CLEAN_CYCLE_CERTIFICATION_VERSION = "clean-cycle-v3"

#: Phase-grid resolution used for the median template and every per-cycle
#: comparison.  This is intentionally fixed: a cycle cannot improve its score
#: merely because a sparse write cadence happened to reduce comparison detail.
CLEAN_CYCLE_PHASE_SAMPLES = 96

#: Tier-specific minimum *contiguous clean terminal* cycles.  Two cycles are
#: sufficient to request a safer write cadence in the live monitor, but are
#: never a publishable FAST/FULL certification window.
FAST_CLEAN_CYCLE_MINIMUM = 3
FINAL_CLEAN_CYCLE_MINIMUM = 5

#: Recovery limits are expressed in *measured physical periods*, not solver
#: chunks.  A terminal corruption gets one three-period repair opportunity;
#: after that, each continuation must earn one more clean period at a time.
#: These caps prevent an unbounded retry loop while still leaving enough
#: evidence to recover from a damaged startup tail.
FAST_CLEAN_CYCLE_MAX_PERIODS = 9
FINAL_CLEAN_CYCLE_MAX_PERIODS = 12

#: The clean-cycle rules compare all three force coefficients.  These are the
#: existing engineering repeatability budgets, used for a cycle-mean outlier
#: rather than inventing a denominator which collapses near zero lift/drag.
_CYCLE_MEAN_ABS_BUDGET = {"cl": 0.02, "cd": 0.002, "cm": 0.01}
_CYCLE_MEAN_REL_BUDGET = {"cl": 0.03, "cd": 0.05, "cm": 0.05}

CLEAN_CYCLE_MIN_SAMPLES = 20
CLEAN_CYCLE_MAX_PHASE_GAP = 0.10
CLEAN_CYCLE_MAX_PHASE_SHIFT_BINS = 4
CLEAN_CYCLE_MAX_SHAPE_NRMSE = 0.12
CLEAN_CYCLE_MAX_AMPLITUDE_DEVIATION = 0.30
CLEAN_CYCLE_HIGH_FREQUENCY_START_BIN = 9
CLEAN_CYCLE_HIGH_FREQUENCY_FRACTION = 0.05


@dataclass(frozen=True)
class CycleAudit:
    """Evidence-backed quality verdict for one whole URANS cycle.

    ``hard_reasons`` mean the cycle is structurally unusable (missing samples
    or frames, a phase hole, an isolated force impulse, or a numerical burst).
    ``soft_reasons`` mean it is a physically plausible but non-repeatable
    settling/outlier cycle.  Both are excluded from the selected suffix, but
    keeping the distinction lets the continuation controller choose whether to
    add periods or first tighten numerics.
    """

    index: int
    start: float
    end: float
    samples: int
    frames: int | None
    phase_gap: float
    phase_shift_bins: int
    cl_mean: float
    cd_mean: float
    cm_mean: float
    cl_shape_error: float
    cd_shape_error: float
    cm_shape_error: float
    cl_amplitude_deviation: float
    cd_amplitude_deviation: float
    cm_amplitude_deviation: float
    cl_high_frequency: float
    cd_high_frequency: float
    cm_high_frequency: float
    hard_reasons: tuple[str, ...] = ()
    soft_reasons: tuple[str, ...] = ()

    @property
    def hard(self) -> bool:
        return bool(self.hard_reasons)

    @property
    def clean(self) -> bool:
        return not self.hard_reasons and not self.soft_reasons

    @property
    def disposition(self) -> str:
        if self.hard_reasons:
            return "hard_corrupt"
        if self.soft_reasons:
            return "settling_outlier"
        return "clean"


@dataclass(frozen=True)
class CleanCycleAudit:
    """All cycle verdicts for one candidate cadence and its terminal suffix."""

    period_s: float
    phase_samples: int
    cycles: tuple[CycleAudit, ...]
    terminal_clean_cycles: int
    required_clean_cycles: int
    template_cycles: int
    shape_error: float
    cadence_adjusted: bool = False
    # ``cycles`` describes the candidate evidence suffix supplied to this
    # classifier.  It is deliberately not a runtime budget counter: the live
    # pipeline may discard a settling prefix and an archived reducer may only
    # inspect a short terminal tail.  Keep measured same-case progress
    # separately so an unclean tail cannot reset the 9/12-period recovery
    # ceiling merely by shrinking the audit input.
    measured_periods: int = 0
    recovery_origin_time: float | None = None
    recovery_latest_time: float | None = None

    @property
    def certified(self) -> bool:
        return self.terminal_clean_cycles >= self.required_clean_cycles

    @property
    def physical_periods(self) -> int:
        """Whole measured same-case periods represented by this audit.

        Older/in-memory audit constructors only know their classified cycles;
        use that as the conservative baseline.  A trusted transient marker
        may later raise this count, but never lower it.
        """
        try:
            measured = int(self.measured_periods)
        except (TypeError, ValueError):
            measured = 0
        return max(len(self.cycles), max(0, measured))

    @property
    def terminal_clean_start(self) -> float | None:
        """First cycle in the entire contiguous clean terminal suffix."""
        if self.terminal_clean_cycles <= 0:
            return None
        return self.cycles[-self.terminal_clean_cycles].start

    @property
    def selected_start(self) -> float | None:
        """First cycle in the exact published clean-period window.

        ``terminal_clean_cycles`` deliberately records all clean evidence at
        the end of the trajectory.  The public reduction, however, owns only
        the fidelity-required final 3/5 cycles so newer clean cycles do not
        silently widen a previously defined averaging window.  Keeping those
        two concepts separate makes the certificate read naturally as
        ``3 selected of N terminal-clean cycles``.
        """
        if self.terminal_clean_cycles < self.required_clean_cycles:
            return None
        return self.cycles[-self.required_clean_cycles].start


def clean_cycle_minimum(
    fidelity: str | None = None,
    *,
    minimum_cycles: int | None = None,
) -> int:
    """Return the configured FAST/FULL terminal clean-cycle floor.

    ``precalc``/``fast`` are FAST URANS; ``full``/``final`` are FINAL URANS.
    Unknown/legacy callers use the FAST floor so adding certification does not
    silently raise a legacy monitor's requested horizon.  A caller may raise,
    but never lower, the chosen floor with ``minimum_cycles``.
    """
    key = (fidelity or "").strip().lower().replace("_", "-")
    if key in {"candidate", "live", "monitor"}:
        # Live two-period inspection controls write cadence only; it is not a
        # publishable FAST/FULL result and therefore has its own explicit
        # candidate floor.
        base = 2
    elif key in {"full", "final", "urans-full", "urans-final"}:
        base = FINAL_CLEAN_CYCLE_MINIMUM
    else:
        base = FAST_CLEAN_CYCLE_MINIMUM
    if minimum_cycles is None:
        return base
    try:
        requested = int(minimum_cycles)
    except (TypeError, ValueError):
        requested = base
    return max(base, requested)


def required_clean_cycle_count(
    *,
    fidelity: str | None = None,
    required_cycles: float = 0.0,
    minimum_cycles: int | None = None,
) -> int:
    """Return the clean-cycle floor compatible with an exact output window."""
    try:
        horizon = float(required_cycles)
    except (TypeError, ValueError):
        horizon = 0.0
    horizon_floor = int(math.ceil(horizon - 1e-12)) if horizon > 0 else 0
    return max(clean_cycle_minimum(fidelity, minimum_cycles=minimum_cycles), horizon_floor)


def clean_cycle_max_periods(fidelity: str | None = None) -> int:
    """Maximum measured periods allowed for automatic clean-tail recovery."""
    key = (fidelity or "").strip().lower().replace("_", "-")
    if key in {"full", "final", "urans-full", "urans-final"}:
        return FINAL_CLEAN_CYCLE_MAX_PERIODS
    return FAST_CLEAN_CYCLE_MAX_PERIODS


def clean_cycle_recovery_exhausted(
    audit: CleanCycleAudit | None,
    *,
    fidelity: str | None = None,
) -> bool:
    """Return whether automatic recovery reached this tier's explicit cap.

    A long clean suffix is useful provenance, not a reason to abandon a
    recoverable result early.  FAST may collect through nine audited periods
    and FINAL through twelve; only those explicit ceilings make the automatic
    recovery path terminal.
    """
    return bool(
        audit is not None
        and audit.physical_periods >= clean_cycle_max_periods(fidelity)
    )


def with_clean_cycle_recovery_progress(
    audit: CleanCycleAudit | None,
    *,
    origin_time: float | None,
    latest_time: float | None,
) -> CleanCycleAudit | None:
    """Attach trusted same-case physical progress to an immutable audit.

    Cycle selection intentionally works on a trailing candidate, so its
    ``cycles`` count is not proof of how much physical URANS has already run.
    Controllers that own a verified transient-start marker call this helper to
    cap continuation from the whole same-case trajectory.  Unknown or malformed
    marker data leaves the audit unchanged rather than inventing progress.
    """
    if audit is None:
        return None
    try:
        origin = float(origin_time) if origin_time is not None else math.nan
        latest = float(latest_time) if latest_time is not None else math.nan
        period = float(audit.period_s)
    except (TypeError, ValueError):
        return audit
    if (
        not math.isfinite(origin)
        or not math.isfinite(latest)
        or not math.isfinite(period)
        or period <= 0.0
        or latest < origin
    ):
        return audit
    measured = int(math.floor((latest - origin) / period + 1e-9))
    return replace(
        audit,
        measured_periods=max(audit.physical_periods, measured),
        recovery_origin_time=origin,
        recovery_latest_time=latest,
    )


def additional_periods_for_clean_suffix(
    audit: CleanCycleAudit | None,
    *,
    fidelity: str | None = None,
    required_cycles: float = 0.0,
    minimum_cycles: int | None = None,
    borderline: bool = False,
    maximum_chunk_periods: int = 3,
) -> int:
    """Bound the next automatic continuation chunk for clean-cycle recovery.

    A damaged terminal cycle gets a three-period recovery chunk; a merely
    short clean suffix asks only for the missing number of cycles, capped at
    three.  ``borderline`` intentionally adds three guard periods after a
    barely-passing suffix so the controller can decide on real new evidence.
    The helper does not schedule work itself.
    """
    target = required_clean_cycle_count(
        fidelity=fidelity,
        required_cycles=required_cycles,
        minimum_cycles=minimum_cycles,
    )
    cap = max(1, int(maximum_chunk_periods))
    if audit is None or not audit.cycles:
        return cap
    # The FAST/FINAL ceiling is a physical-period ceiling, not merely a
    # classifier threshold checked after the next pimpleFoam chunk completes.
    # A terminal impulse at FAST period 8 or FINAL period 11 therefore has
    # room for exactly one more period, even though a newly corrupted tail
    # would ordinarily earn a three-period repair chunk.  Without this clamp
    # the runner can integrate past the advertised 9/12-period limit before
    # the next audit has a chance to terminalize it.
    remaining = max(0, clean_cycle_max_periods(fidelity) - audit.physical_periods)
    cap = min(cap, remaining)
    if cap <= 0:
        return 0
    if audit.terminal_clean_cycles < target:
        final_is_clean = audit.cycles[-1].clean
        if not final_is_clean:
            return cap
        # Once the first post-corruption clean suffix has been captured, grow
        # it one physical period at a time.  Repeated three-period chunks were
        # the source of the visibly noisy first retained period: they blurred
        # the diagnosis and wrote unnecessary transient state.
        if any(not cycle.clean for cycle in audit.cycles):
            return 1
        return min(cap, max(1, target - audit.terminal_clean_cycles))
    return cap if borderline else 0


# --------------------------------------------------------------------------- #
# Physical shedding band + sub-harmonic preference (prod 2026-07-07 incident:
# the unconstrained period tracker locked onto a low-frequency sub-harmonic /
# modulation of a broadband post-stall signal, collapsing retained-cycle counts
# and making the continuation budget guard reject honest precalc work).
# --------------------------------------------------------------------------- #

#: Plausible vortex-shedding Strouhal window for airfoil/bluff-body wakes.
#: Post-stall airfoil shedding measures St ~ 0.1-0.2 on the chord, cylinder-like
#: wakes sit near 0.2, and even exotic separated cases stay inside [0.05, 0.5].
#: Spectral content below the band is modulation / sub-harmonic beating, above
#: it is harmonics or numerical noise — neither is the shedding fundamental.
SHEDDING_STROUHAL_BAND: tuple[float, float] = (0.05, 0.5)

#: Above this projected-height ratio, separated/post-stall shedding is measured
#: against the airfoil's projected frontal height ``c*sin(|alpha|)``. Below it,
#: keep the chord-based band: attached low-alpha cases retain the existing
#: acceptance/rejection behavior instead of widening the high-frequency side.
SHEDDING_PROJECTED_HEIGHT_FLOOR = 0.15

#: Sub-harmonic preference tolerance: within the physical band the HIGHEST-
#: frequency peak whose autocorrelation (or in-band FFT magnitude) is at least
#: this fraction of the strongest in-band peak wins. 0.8 because a genuine
#: shedding fundamental keeps >= ~80% of a strong 1/2- or 1/4-sub-harmonic
#: peak's correlation under comparable-amplitude modulation (the lottery regime
#: where two window samplings flip between T and 2T), while spurious noise
#: peaks fall well below 80% of the true peak. When modulation is so dominant
#: that the fundamental's peak drops under 80%, the signal genuinely repeats
#: only at the longer period and the stability check + conservative shorter
#: period (see ``estimate_period``) guard the budget math instead.
SUBHARMONIC_PEAK_TOLERANCE = 0.8

#: A missing half-window estimate, or two half-window estimates differing by
#: more than this fraction (relative to the larger one), flags the period as
#: AMBIGUOUS. When both exist, the conservative SHORTER period is used for
#: retained-cycle counting and budget projection (shorter period => more
#: retained cycles => the projection can never inflate the required
#: continuation hours off an accidental sub-harmonic lock). A lone full-window
#: estimate may size continuation but cannot certify stationarity.
PERIOD_AMBIGUITY_TOLERANCE = 0.30

#: Minimum cycles required by each independent period estimate.  The
#: full-window estimate and BOTH half-window corroboration estimates use this
#: same floor, so an early-stop certification window must span at least twice
#: this many periods before it can possibly be judged unambiguous.
PERIOD_ESTIMATE_MIN_CYCLES = 2.0

#: An in-band spectral peak is CREDIBLE only when it reaches at least this
#: fraction of the strongest spectral magnitude anywhere in the spectrum (DC
#: excluded). A genuinely out-of-band phenomenon (bluff-body-like St < 0.05)
#: leaves only its Hanning leakage skirt (~3% sidelobes) and the noise floor
#: inside the band; locking a period onto those minted a silently wrong
#: near-band-edge estimate. Below this fraction the honest answer is "no
#: measurable in-band period" (None), which the callers grade as no lock —
#: never a fabricated period. A real shedding line more than ~20x weaker than
#: an out-of-band modulation line is likewise reported as no lock rather than
#: guessed.
IN_BAND_CREDIBILITY_FRACTION = 0.05

#: The refined autocorrelation lag must not undercut the credibility-gated
#: in-band FFT line's period by more than this fraction. When a strong
#: out-of-band modulation dominates, the in-band autocorrelation ripple peaks
#: ride the modulation's steep correlation slope and get dragged toward
#: SHORTER lags (measured ~30-36% short at modulation/fundamental amplitude
#: ratio ~2), while genuine modulated-shedding refinement stays within a few
#: percent of the line. A dragged lag falls back to the FFT line period
#: (corroborated by the repeat correlation, else None). Asymmetric on purpose:
#: an autocorrelation period LONGER than the FFT line is legitimate (rule 2
#: may certify a strong in-band harmonic while the signal's true repeat is the
#: full period) and stays trusted.
AC_FFT_UNDERCUT_TOLERANCE = 0.25


def _shedding_reference_length(
    chord: float,
    alpha_deg: "float | None",
    section_thickness_ratio: "float | None" = None,
) -> float:
    projected_ratio = 0.0
    try:
        if alpha_deg is not None:
            projected_ratio = abs(math.sin(math.radians(float(alpha_deg))))
    except (TypeError, ValueError):
        projected_ratio = 0.0
    try:
        thickness_ratio = (
            float(section_thickness_ratio)
            if section_thickness_ratio is not None
            else 0.0
        )
    except (TypeError, ValueError):
        thickness_ratio = 0.0
    if math.isfinite(thickness_ratio) and 0 < thickness_ratio <= 1:
        projected_ratio = max(projected_ratio, thickness_ratio)
    if (
        not math.isfinite(projected_ratio)
        or projected_ratio <= SHEDDING_PROJECTED_HEIGHT_FLOOR
    ):
        return chord
    return chord * projected_ratio


def shedding_period_band(
    speed: "float | None",
    chord: "float | None",
    st_band: tuple[float, float] = SHEDDING_STROUHAL_BAND,
    *,
    alpha_deg: "float | None" = None,
    section_thickness_ratio: "float | None" = None,
) -> "tuple[float, float] | None":
    """Physically plausible shedding-period window [s] for the flow context:
    St in ``st_band`` => period in [H/(St_max U), c/(St_min U)] where ``H`` is
    chord for attached/low-alpha cases and projected height for separated
    high-alpha cases. The low-frequency side remains chord-based so the
    sub-harmonic/undercut guards keep their previous safety boundary; high alpha
    only widens the high-frequency ceiling.

    Returns None (no constraint — explicit legacy behavior) when the flow
    context is missing or unusable.
    """
    try:
        u = float(speed) if speed is not None else 0.0
        c = float(chord) if chord is not None else 0.0
    except (TypeError, ValueError):
        return None
    if not (math.isfinite(u) and math.isfinite(c)) or u <= 0 or c <= 0:
        return None
    lo, hi = float(st_band[0]), float(st_band[1])
    if not (0 < lo < hi):
        return None
    length = _shedding_reference_length(
        c,
        alpha_deg,
        section_thickness_ratio,
    )
    return (length / (hi * u), c / (lo * u))


def shedding_frequency_band(
    speed: "float | None",
    chord: "float | None",
    st_band: tuple[float, float] = SHEDDING_STROUHAL_BAND,
    *,
    alpha_deg: "float | None" = None,
    section_thickness_ratio: "float | None" = None,
) -> "tuple[float, float] | None":
    """Frequency-domain twin of :func:`shedding_period_band`: [St_min U / c,
    St_max U / H] in Hz, or None without flow context."""
    band = shedding_period_band(
        speed,
        chord,
        st_band,
        alpha_deg=alpha_deg,
        section_thickness_ratio=section_thickness_ratio,
    )
    if band is None:
        return None
    p_lo, p_hi = band
    return (1.0 / p_hi, 1.0 / p_lo)


def dominant_frequency(
    times: "np.ndarray | list[float]",
    values: "np.ndarray | list[float]",
    freq_band: "tuple[float, float] | None" = None,
    peak_tolerance: float = SUBHARMONIC_PEAK_TOLERANCE,
) -> float:
    """Dominant oscillation frequency [Hz] of a (possibly non-uniformly sampled)
    signal, via the peak of its FFT magnitude (DC excluded).

    pimpleFoam uses an adaptive time step, so the samples are resampled onto a
    uniform grid (linear interpolation) before the FFT.

    With ``freq_band`` (Hz) the peak search is restricted to the physically
    plausible window and, within it, the HIGHEST-frequency local spectral peak
    whose magnitude is at least ``peak_tolerance`` of the strongest in-band
    peak wins — a strong sub-harmonic / modulation line must not displace the
    shedding fundamental. Without a band the legacy global-argmax behavior is
    kept unchanged.
    """
    t = np.asarray(times, dtype=float)
    v = np.asarray(values, dtype=float)
    n = t.size
    if n < 8 or v.size != n:
        return 0.0
    tu = np.linspace(float(t[0]), float(t[-1]), n)
    vu = np.interp(tu, t, v)
    vu = vu - vu.mean()
    dt = (tu[-1] - tu[0]) / (n - 1)
    if dt <= 0 or not np.any(np.abs(vu) > 0):
        return 0.0
    n_fft = 1 << math.ceil(math.log2(max(n, n * 8)))
    spec = np.abs(np.fft.rfft(vu * np.hanning(n), n=n_fft))
    freqs = np.fft.rfftfreq(n_fft, dt)
    if spec.size < 2:
        return 0.0
    if freq_band is None:
        k = 1 + int(np.argmax(spec[1:]))  # skip the DC bin
        return float(freqs[k])
    f_lo, f_hi = float(freq_band[0]), float(freq_band[1])
    if not (math.isfinite(f_lo) and math.isfinite(f_hi)) or not (0 < f_lo < f_hi):
        k = 1 + int(np.argmax(spec[1:]))
        return float(freqs[k])
    in_band = np.where((freqs >= f_lo) & (freqs <= f_hi) & (freqs > 0))[0]
    if in_band.size == 0:
        return 0.0
    interior = in_band[(in_band > 0) & (in_band < spec.size - 1)]
    peaks = interior[
        (spec[interior] >= spec[interior - 1]) & (spec[interior] >= spec[interior + 1])
    ]
    if peaks.size == 0:
        # No local spectral maximum inside the band: the in-band energy is the
        # monotonic leakage slope of an out-of-band line (or a noise ramp).
        # Returning the in-band argmax here minted a band-edge frequency for a
        # genuinely out-of-band phenomenon — honest answer: no in-band lock.
        return 0.0
    best = float(spec[peaks].max())
    if best <= 0 or best < IN_BAND_CREDIBILITY_FRACTION * float(spec[1:].max()):
        # The strongest in-band peak is dwarfed by out-of-band spectral
        # content: sidelobe leakage / noise wiggles, not a shedding line.
        return 0.0
    eligible = peaks[spec[peaks] >= peak_tolerance * best]
    k = int(eligible.max())  # highest in-band frequency within tolerance
    return float(freqs[k])


def strouhal(freq_hz: float, chord: float, speed: float) -> float:
    """St = f c / U."""
    if speed <= 0:
        return 0.0
    return freq_hz * chord / speed


def _downsample(values: list[float], max_points: int) -> list[float]:
    n = len(values)
    if n <= max_points:
        return [float(v) for v in values]
    idx = np.linspace(0, n - 1, max_points).round().astype(int)
    return [float(values[i]) for i in idx]


def _normalise_series(
    times: "np.ndarray | list[float]",
    *values: "np.ndarray | list[float]",
) -> tuple[np.ndarray, ...]:
    """Sort by time and drop duplicate timestamps so interpolation is stable."""
    t = np.asarray(times, dtype=float)
    arrays = [np.asarray(v, dtype=float) for v in values]
    n = t.size
    if any(a.size != n for a in arrays):
        raise ValueError("time/value arrays must have the same length")
    order = np.argsort(t)
    t = t[order]
    arrays = [a[order] for a in arrays]
    finite = np.isfinite(t)
    for a in arrays:
        finite &= np.isfinite(a)
    t = t[finite]
    arrays = [a[finite] for a in arrays]
    if t.size == 0:
        return (t, *arrays)
    keep = np.concatenate(([True], np.diff(t) > 1e-12))
    return (t[keep], *(a[keep] for a in arrays))


def integer_period_window(
    times: "np.ndarray | list[float]",
    period_s: float,
    discard_fraction: float = 0.4,
    target_cycles: int = 7,
) -> PeriodWindow | None:
    """Return the final phase-aligned window spanning an integer number of periods.

    The end is the last available sample. The start is moved backward by an
    integer number of measured periods and never before the discarded startup
    boundary. When enough data exists, exactly ``target_cycles`` final cycles are
    retained; otherwise the largest available integer number of cycles is used.
    """
    t = np.asarray(times, dtype=float)
    t = t[np.isfinite(t)]
    if t.size < 2 or not math.isfinite(period_s) or period_s <= 0:
        return None
    t = np.sort(t)
    first = float(t[0])
    end = float(t[-1])
    if end <= first:
        return None
    discard = min(max(float(discard_fraction), 0.0), 0.999999)
    discard_time = first + discard * (end - first)
    available = end - discard_time
    available_cycles = math.floor((available / period_s) + 1e-9)
    if available_cycles < 1:
        return None
    cycles = min(max(1, int(target_cycles)), available_cycles)
    start = end - cycles * period_s
    return PeriodWindow(start=start, end=end, cycles=cycles, period_s=period_s)


def _window_series(
    times: np.ndarray,
    cl: np.ndarray,
    cd: np.ndarray,
    cm: np.ndarray,
    window: PeriodWindow | None,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    if window is None:
        return times, cl, cd, cm
    start = max(float(times[0]), window.start)
    end = min(float(times[-1]), window.end)
    if end <= start:
        return times, cl, cd, cm
    interior = (times > start) & (times < end)
    out_t = np.concatenate(([start], times[interior], [end]))
    out_cl = np.concatenate(([np.interp(start, times, cl)], cl[interior], [np.interp(end, times, cl)]))
    out_cd = np.concatenate(([np.interp(start, times, cd)], cd[interior], [np.interp(end, times, cd)]))
    out_cm = np.concatenate(([np.interp(start, times, cm)], cm[interior], [np.interp(end, times, cm)]))
    return out_t, out_cl, out_cd, out_cm


def trailing_period_series(
    times: "np.ndarray | list[float]",
    cl: "np.ndarray | list[float]",
    cd: "np.ndarray | list[float]",
    cm: "np.ndarray | list[float]",
    period_s: float,
    cycles: float,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Return the exact trailing ``cycles * period_s`` physical-time window.

    The boundary is interpolated between its two real neighbouring samples,
    matching the evidence-preserving window machinery used for integer-period
    statistics.  The caller retains the complete source arrays; this helper
    only returns a certification view and never deletes startup history.
    """

    t, wcl, wcd, wcm = _normalise_series(times, cl, cd, cm)
    if (
        t.size < 2
        or not math.isfinite(period_s)
        or period_s <= 0
        or not math.isfinite(cycles)
        or cycles <= 0
    ):
        return t, wcl, wcd, wcm
    end = float(t[-1])
    window = PeriodWindow(
        start=end - float(cycles) * float(period_s),
        end=end,
        cycles=max(1, int(math.floor(float(cycles)))),
        period_s=float(period_s),
    )
    return _window_series(t, wcl, wcd, wcm, window)


def _time_weighted_mean_std(times: np.ndarray, values: np.ndarray) -> tuple[float, float]:
    if values.size == 0:
        return 0.0, 0.0
    if values.size == 1 or times.size != values.size or times[-1] <= times[0]:
        mean = float(values.mean())
        return mean, float(values.std())
    span = float(times[-1] - times[0])
    integrate = getattr(np, "trapezoid", None)
    if integrate is None:
        integrate = np.trapz
    mean = float(integrate(values, times) / span)
    variance = float(integrate((values - mean) ** 2, times) / span)
    return mean, max(variance, 0.0) ** 0.5


def force_history_transport_statistics(
    history: ForceHistory,
) -> ForceHistoryTransportStatistics:
    """Return finite time-weighted statistics for the bounded witness.

    This is intentionally stricter than the generic statistic helper: a
    certificate witness must contain aligned finite coefficient samples and a
    strictly increasing time axis.  The no-shedding certificate callers apply
    their separate minimum-count policy; this utility only proves that the
    actual payload can be integrated faithfully.
    """
    try:
        times = np.asarray(history.t, dtype=float)
        cl = np.asarray(history.cl, dtype=float)
        cd = np.asarray(history.cd, dtype=float)
        cm = np.asarray(history.cm, dtype=float)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("force-history transport values are malformed") from exc

    channels = (times, cl, cd, cm)
    count = int(times.size)
    if (
        count < 2
        or any(channel.ndim != 1 or channel.size != count for channel in channels)
        or not all(np.all(np.isfinite(channel)) for channel in channels)
        or np.any(np.diff(times) <= 0)
    ):
        raise ValueError("force-history transport is not a finite ordered witness")

    cl_mean, cl_rms = _time_weighted_mean_std(times, cl)
    cd_mean, cd_rms = _time_weighted_mean_std(times, cd)
    cm_mean, cm_rms = _time_weighted_mean_std(times, cm)
    values = (cl_mean, cl_rms, cd_mean, cd_rms, cm_mean, cm_rms)
    if not all(math.isfinite(value) for value in values):
        raise ValueError("force-history transport statistics are non-finite")
    return ForceHistoryTransportStatistics(
        cl_mean=cl_mean,
        cl_rms=cl_rms,
        cd_mean=cd_mean,
        cd_rms=cd_rms,
        cm_mean=cm_mean,
        cm_rms=cm_rms,
    )


def _coefficient_series(
    path: "Path | Sequence[Path]",
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Coefficient time series from one coefficient.dat, or MERGED from several
    restart segments (each pimpleFoam continuation writes its own
    ``postProcessing/forceCoeffs1/<startTime>/coefficient.dat``).

    The newer segment owns its nominal ``startTime`` boundary.  OpenFOAM may
    write one terminal force row into the older segment at exactly that time;
    after solver reconfiguration that row can be numerically inconsistent with
    both neighbouring states.  Treating those restart-seam rows as physical
    samples minted a false impulse train in otherwise flat production traces.
    Clip each older segment at the next numeric segment start, including a
    header-only successor that has not written its first force row yet, then
    sort and deduplicate the merged series.  The directory boundary owns the
    restarted physical trajectory even while its coefficient file is empty.
    Every genuine sample strictly before the boundary is preserved and the
    newer segment wins an exact overlap."""
    if isinstance(path, (list, tuple)):
        segment_paths = [Path(item) for item in path]
        numeric_boundaries: list[float] = []
        for segment_path in segment_paths:
            try:
                boundary = float(segment_path.parent.name)
            except ValueError:
                continue
            if math.isfinite(boundary):
                numeric_boundaries.append(boundary)
        numeric_boundaries = sorted(set(numeric_boundaries))
        parts: list[
            tuple[
                Path,
                float | None,
                tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray],
            ]
        ] = []
        last_exc: Exception | None = None
        for segment_path in segment_paths:
            try:
                values = _coefficient_series_one(segment_path)
            except (OSError, ValueError) as exc:  # in-flight segment may be header-only
                last_exc = exc
                continue
            try:
                segment_start: float | None = float(segment_path.parent.name)
            except ValueError:
                segment_start = None
            parts.append((segment_path, segment_start, values))
        if not parts:
            raise last_exc or ValueError("No coefficient data found (no segments)")
        # Numeric OpenFOAM restart segments have an authoritative physical
        # order independent of filesystem/glob order.  Non-standard inputs
        # retain their first-sample order and are never seam-clipped without a
        # numeric boundary contract.
        parts.sort(
            key=lambda item: (
                item[1] if item[1] is not None else float(item[2][0][0]),
                str(item[0]),
            )
        )
        clipped: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = []
        for _segment_path, segment_start, values in parts:
            next_start = None
            if segment_start is not None:
                next_start = next(
                    (
                        boundary
                        for boundary in numeric_boundaries
                        if boundary > segment_start + max(1e-12, abs(segment_start) * 1e-12)
                    ),
                    None,
                )
            if next_start is not None:
                tolerance = max(1e-12, abs(next_start) * 1e-12)
                keep = values[0] < next_start - tolerance
                if np.any(keep):
                    values = tuple(array[keep] for array in values)
                else:
                    continue
            clipped.append(values)
        merged = tuple(
            np.concatenate([part[k] for part in clipped]) for k in range(4)
        )
        return _normalise_series(*merged)
    return _coefficient_series_one(Path(path))


def coefficient_series(
    path: "Path | Sequence[Path]",
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Public alias: (t, cl, cd, cm) arrays, merged across restart segments."""
    return _coefficient_series(path)


def _coefficient_invalid_value_times_one(path: Path) -> np.ndarray:
    """Return timestamped non-finite Cl/Cd/Cm rows from one raw member.

    ``coefficient_series`` intentionally returns a finite, interpolation-safe
    numeric series to its many display and monitoring callers.  Certification
    needs one more piece of provenance: a raw non-finite coefficient row must
    remain visible to the cycle audit instead of disappearing during that
    normalisation.  This helper carries only the timestamp, never a made-up
    replacement coefficient.
    """
    header, rows = _data_rows(path)
    if not rows:
        return np.empty(0, dtype=float)
    if not header:
        header = [
            "Time", "Cd", "Cd(f)", "Cd(r)", "Cl", "Cl(f)", "Cl(r)",
            "CmPitch", "CmRoll", "CmYaw", "Cs", "Cs(f)", "Cs(r)",
        ]
    indices = {name: index for index, name in enumerate(header)}
    cm_key = "CmPitch" if "CmPitch" in indices else ("Cm" if "Cm" in indices else None)
    if not {"Time", "Cl", "Cd"}.issubset(indices) or cm_key is None:
        return np.empty(0, dtype=float)
    required = (indices["Time"], indices["Cl"], indices["Cd"], indices[cm_key])
    invalid: list[float] = []
    for row in rows:
        if len(row) <= indices["Time"]:
            continue
        timestamp = float(row[indices["Time"]])
        if not math.isfinite(timestamp):
            # A non-finite time cannot be assigned honestly to one period.
            # The normal numeric reader will reject any fully unusable source;
            # do not fabricate a phase location here.
            continue
        if len(row) <= max(required) or any(
            not math.isfinite(float(row[index])) for index in required[1:]
        ):
            invalid.append(timestamp)
    return np.unique(np.asarray(invalid, dtype=float))


def coefficient_invalid_value_times(
    path: "Path | Sequence[Path]",
) -> np.ndarray:
    """Raw non-finite coefficient timestamps after the same restart ownership.

    Each continuation's newer numeric directory owns the seam.  Mirror
    :func:`coefficient_series` clipping here so a discarded older seam row
    cannot falsely poison the cycle owned by the restarted segment.
    """
    paths = [Path(item) for item in path] if isinstance(path, (list, tuple)) else [Path(path)]
    starts: dict[Path, float | None] = {}
    numeric_boundaries: list[float] = []
    for member in paths:
        try:
            start = float(member.parent.name)
        except ValueError:
            start = None
        starts[member] = start if start is not None and math.isfinite(start) else None
        if starts[member] is not None:
            numeric_boundaries.append(starts[member])
    numeric_boundaries = sorted(set(numeric_boundaries))
    collected: list[np.ndarray] = []
    for member in paths:
        try:
            invalid = _coefficient_invalid_value_times_one(member)
        except (OSError, ValueError):
            # The normal series reader owns the resulting missing-data error.
            # This provenance sidecar must not turn a recoverable in-flight
            # header-only segment into invented corruption.
            continue
        start = starts[member]
        if start is not None:
            next_start = next(
                (
                    boundary
                    for boundary in numeric_boundaries
                    if boundary > start + max(1e-12, abs(start) * 1e-12)
                ),
                None,
            )
            if next_start is not None:
                tolerance = max(1e-12, abs(next_start) * 1e-12)
                invalid = invalid[invalid < next_start - tolerance]
        if invalid.size:
            collected.append(invalid)
    if not collected:
        return np.empty(0, dtype=float)
    return np.unique(np.concatenate(collected))


def _coefficient_series_one(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    header, rows = _data_rows(path)
    if not rows:
        raise ValueError(f"No coefficient data found in {path}")
    if not header:
        header = [
            "Time", "Cd", "Cd(f)", "Cd(r)", "Cl", "Cl(f)", "Cl(r)",
            "CmPitch", "CmRoll", "CmYaw", "Cs", "Cs(f)", "Cs(r)",
        ]
    idx = {name: i for i, name in enumerate(header)}
    cm_key = "CmPitch" if "CmPitch" in idx else ("Cm" if "Cm" in idx else None)

    def col(name: str) -> list[float]:
        i = idx[name]
        return [r[i] for r in rows if len(r) > i]

    t = col("Time") if "Time" in idx else [float(i) for i in range(len(rows))]
    cl = col("Cl")
    cd = col("Cd")
    cm = col(cm_key) if cm_key else [0.0] * len(cl)
    return _normalise_series(t, cl, cd, cm)


# Search the most recent evidence first.  Fractions are deliberately dense near
# the tail: a violent transient may occupy most of a long same-case trajectory,
# while only the final few periods are the physical settled wake.  Candidates
# are still byte-backed suffixes of the immutable merged history; this selector
# never deletes or rewrites raw solver evidence.
_CLEAN_TAIL_FRACTIONS = (
    0.025,
    0.05,
    0.075,
    0.10,
    0.15,
    0.20,
    0.30,
    0.40,
    0.50,
    0.65,
    0.80,
    1.0,
)


def _tail_candidate_series(
    t: np.ndarray,
    cl: np.ndarray,
    cd: np.ndarray,
    cm: np.ndarray,
    *,
    min_samples: int,
    include_dense_tail_counts: bool = False,
) -> list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]]:
    """Return distinct trailing evidence suffixes, shortest/latest first."""
    if t.size < min_samples or float(t[-1]) <= float(t[0]):
        return []
    span = float(t[-1] - t[0])
    out: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = []
    starts: set[int] = set()

    def append(index: int) -> None:
        index = max(0, min(int(index), int(t.size) - min_samples))
        if index in starts or t.size - index < min_samples:
            return
        starts.add(index)
        out.append((t[index:], cl[index:], cd[index:], cm[index:]))

    if include_dense_tail_counts:
        # A same-case trajectory can span many continuations.  Its final clean
        # 4.5-cycle certificate may then be much shorter than 2.5% of the
        # complete immutable history, so percentage-only candidates all begin
        # inside the corrupt prefix.  Search recent sample-count suffixes at a
        # dense geometric cadence until the ordinary 2.5% candidate takes
        # over.  This path is reserved for final clean-tail certification;
        # the frequently polled two-period live monitor keeps the bounded
        # percentage list below.
        first_fraction_count = max(
            min_samples,
            int(math.ceil(_CLEAN_TAIL_FRACTIONS[0] * t.size)),
        )
        count = min_samples
        while count < min(first_fraction_count, int(t.size)):
            append(int(t.size) - count)
            next_count = max(count + 1, int(math.ceil(count * 1.10)))
            count = next_count
        append(int(t.size) - min(first_fraction_count, int(t.size)))

    for fraction in _CLEAN_TAIL_FRACTIONS:
        start_time = float(t[-1]) - fraction * span
        index = max(0, int(np.searchsorted(t, start_time, side="left")))
        append(index)
    if 0 not in starts:
        append(0)
    return out


def stable_two_period_window(
    path: "Path | Sequence[Path]",
    speed: float,
    chord: float,
    frame_times: "list[float] | np.ndarray",
    discard_fraction: float = 0.0,
    min_frames_per_cycle: float = 20.0,
    min_samples_per_cycle: int = 20,
    phase_samples: int = 96,
    similarity_tolerance: float = 0.12,
    mean_drift_tolerance: float = 0.12,
    alpha_deg: float | None = None,
    section_thickness_ratio: float | None = None,
) -> StablePeriodResult:
    """Return a live-cadence candidate when the final two periods are repeatable.

    Two periods are enough only when the final two force cycles are nearly the
    same phase shape and the retained field writes can animate them at the
    requested cadence. They are never a publishable FAST/FULL certificate;
    :func:`clean_periodic_tail` applies the 3/5-cycle terminal certification
    floor after the run. The result is deliberately conservative: missing
    period, sparse samples, shape drift, or too few field frames all keep the
    solver running.
    """
    if speed <= 0 or chord <= 0:
        return StablePeriodResult(ok=False, reason="invalid speed/chord")
    restart_boundaries: tuple[float, ...] = ()
    if isinstance(path, (list, tuple)):
        starts: set[float] = set()
        for item in path:
            try:
                start = float(Path(item).parent.name)
            except ValueError:
                continue
            if math.isfinite(start):
                starts.add(start)
        # The first segment is the trajectory origin, not a continuation seam.
        restart_boundaries = tuple(sorted(starts)[1:])
    try:
        t, cl, cd, cm = _coefficient_series(path)
    except Exception as exc:  # noqa: BLE001 - in-flight coefficient file may be incomplete
        return StablePeriodResult(ok=False, reason=f"coefficient history unavailable: {exc}")
    if t.size < max(16, min_samples_per_cycle * 2):
        return StablePeriodResult(ok=False, reason="not enough coefficient samples")
    if discard_fraction > 0 and t[-1] > t[0]:
        start = float(t[0]) + min(max(discard_fraction, 0.0), 0.95) * float(t[-1] - t[0])
        mask = t >= start
        t, cl, cd, cm = t[mask], cl[mask], cd[mask], cm[mask]
    if t.size < max(16, min_samples_per_cycle * 2):
        return StablePeriodResult(ok=False, reason="not enough retained coefficient samples")

    frames = np.asarray(frame_times, dtype=float)
    frames = frames[np.isfinite(frames)]
    best: StablePeriodResult | None = None
    for candidate in _tail_candidate_series(
        t,
        cl,
        cd,
        cm,
        min_samples=max(16, min_samples_per_cycle * 2),
    ):
        tc, clc, cdc, cmc = candidate
        freq = dominant_frequency(
            tc,
            clc,
            freq_band=shedding_frequency_band(
                speed,
                chord,
                alpha_deg=alpha_deg,
                section_thickness_ratio=section_thickness_ratio,
            ),
        )
        st = strouhal(freq, chord, speed)
        period = chord / (st * speed) if st > 0 else None
        if period is None or not math.isfinite(period) or period <= 0:
            continue
        window = integer_period_window(
            tc, period, discard_fraction=0.0, target_cycles=2
        )
        if window is None or window.cycles < 2:
            continue

        mid = window.start + period
        first_mask = (tc >= window.start) & (tc <= mid)
        second_mask = (tc >= mid) & (tc <= window.end)
        if (
            int(first_mask.sum()) < min_samples_per_cycle
            or int(second_mask.sum()) < min_samples_per_cycle
        ):
            best = best or StablePeriodResult(
                ok=False,
                reason="not enough samples per period",
                period_s=period,
                window_start=window.start,
                window_end=window.end,
                cycles=2,
            )
            continue

        retained_mask = (tc >= window.start) & (tc <= window.end)
        if _has_impulsive_discontinuity(
            tc[retained_mask],
            clc[retained_mask],
            cdc[retained_mask],
            cmc[retained_mask],
            ignored_jump_times=restart_boundaries,
        ):
            best = best or StablePeriodResult(
                ok=False,
                reason="candidate periods contain an impulsive discontinuity",
                stable=False,
                period_s=period,
                window_start=window.start,
                window_end=window.end,
                cycles=2,
            )
            continue

        phase = np.linspace(0.0, period, max(8, phase_samples), endpoint=False)

        def compare(values: np.ndarray) -> tuple[float, float]:
            p1 = np.interp(window.start + phase, tc, values)
            p2 = np.interp(mid + phase, tc, values)
            combined = np.concatenate((p1, p2))
            amplitude = float(np.nanmax(combined) - np.nanmin(combined))
            scale = max(
                amplitude,
                abs(float(np.nanmean(combined))) * 0.05,
                1e-9,
            )
            nrms = float(np.sqrt(np.nanmean((p1 - p2) ** 2)) / scale)
            mean_drift = float(
                abs(np.nanmean(p1) - np.nanmean(p2)) / scale
            )
            return nrms, mean_drift

        cl_similarity, cl_drift = compare(clc)
        cd_similarity, cd_drift = compare(cdc)
        cm_similarity, cm_drift = compare(cmc)
        similarity = max(cl_similarity, cd_similarity, cm_similarity)
        mean_drift = max(cl_drift, cd_drift, cm_drift)
        stable = (
            similarity <= similarity_tolerance
            and mean_drift <= mean_drift_tolerance
        )
        frame_count = int(
            ((frames >= window.start) & (frames <= window.end)).sum()
        )
        frames_per_cycle = frame_count / 2.0
        candidate_series = trailing_period_series(tc, clc, cdc, cmc, period, 2.0)
        audit = audit_period_cycles(
            candidate_series[0],
            candidate_series[1],
            candidate_series[2],
            candidate_series[3],
            period,
            fidelity="candidate",
            required_cycles=2.0,
            min_clean_cycles=2,
            frame_times=frames,
            min_frames_per_cycle=min_frames_per_cycle,
            min_samples_per_cycle=min_samples_per_cycle,
            phase_samples=phase_samples,
        )
        base = StablePeriodResult(
            ok=False,
            reason="",
            stable=stable,
            period_s=period,
            window_start=window.start,
            window_end=window.end,
            cycles=2,
            frame_count=frame_count,
            frames_per_cycle=frames_per_cycle,
            similarity=similarity,
            mean_drift=mean_drift,
            clean_cycles=audit.terminal_clean_cycles,
            required_clean_cycles=audit.required_clean_cycles,
        )
        if not stable:
            best = best or replace(
                base,
                reason=(
                    f"periods differ: similarity {similarity:.3f}, "
                    f"mean drift {mean_drift:.3f}"
                ),
            )
            continue
        # Preserve the legacy aggregate-frame explanation when the total is
        # plainly sparse.  When the aggregate clears the floor but one cycle
        # does not, the stricter per-cycle audit below owns the rejection.
        audit_frame_only_legacy = (
            frames_per_cycle + 1e-9 < min_frames_per_cycle
            and all(
                not cycle.clean
                and cycle.hard_reasons
                and all(reason.startswith("frames ") for reason in cycle.hard_reasons)
                for cycle in audit.cycles
            )
        )
        if not audit.certified and not audit_frame_only_legacy:
            latest = next(
                (cycle for cycle in reversed(audit.cycles) if not cycle.clean),
                None,
            )
            detail = "; ".join(
                (latest.hard_reasons + latest.soft_reasons) if latest else ()
            ) or "cycle audit did not find a contiguous clean suffix"
            best = best or replace(
                base,
                reason=f"candidate periods need recovery: {detail}",
            )
            continue
        if frames_per_cycle + 1e-9 < min_frames_per_cycle:
            best = best or replace(
                base,
                reason=(
                    f"frames/cycle {frames_per_cycle:.2f} "
                    f"< {min_frames_per_cycle:.2f}"
                ),
            )
            continue
        return replace(
            base,
            ok=True,
            reason="two stable periods with sufficient frames",
        )
    return best or StablePeriodResult(
        ok=False, reason="no measurable shedding period"
    )


# --------------------------------------------------------------------------- #
# Frame-track recording contract (task #23): robust period tracking,
# integer-period time-weighted stats, stationarity, and frame targeting.
# --------------------------------------------------------------------------- #

#: Absolute floor of the stationarity drift denominator. The drift metric
#: normalises the half-window mean delta by max(|mean(cl)|, retained cl rms,
#: DRIFT_ABS_FLOOR): a symmetric airfoil at alpha~0 has mean cl ~ 0, so a bare
#: |mean| denominator made such points UNJUDGEABLE — any femto-scale numerical
#: wobble divided by ~0 failed stationarity forever (prod 2026-07-07: alpha=0
#: points could only ever exercise reject paths). A truly drifting near-zero
#: signal still fails: its half-window delta is judged against the rms/absolute
#: floor scale instead of an accidentally tiny mean.
DRIFT_ABS_FLOOR = 0.05
#: Fallback synthetic target cadence when the caller cannot provide actual
#: written VTU times. Normal frame export uses all written states up to cap.
FRAME_EXPORT_FRAMES_PER_PERIOD = 30.0
#: ... over the last min(3, K) whole periods ...
FRAME_EXPORT_SPAN_PERIODS = 3
#: ... capped at 120 frames total.
FRAME_EXPORT_MAX_FRAMES = 120


def _evenly_capped_times(times: Sequence[float], max_frames: int) -> list[float]:
    if len(times) <= max_frames:
        return [float(t) for t in times]
    n = len(times)
    m = max(2, int(max_frames))
    selected: list[int] = []
    for pos, raw in enumerate(np.linspace(0, n - 1, m)):
        k = int(round(float(raw)))
        lower = selected[-1] + 1 if selected else 0
        upper = n - (m - pos)
        selected.append(min(max(k, lower), upper))
    return [float(times[i]) for i in selected]

# --------------------------------------------------------------------------- #
# Precalc-tier ESTABLISHED-OSCILLATION stationarity (user decision 2026-07-08:
# "the solution should converge to a stable oscillation"). The strict 5%
# two-half mean-drift gate stays the FULL-tier "verified" bar; the precalc
# tier instead asks whether the transient has SETTLED INTO a bounded limit
# cycle: per-cycle means m_1..m_K must show no monotonic trend (a relaxing
# startup approaches its attractor one-directionally; an established
# modulated limit cycle scatters trendlessly), the shedding period must be
# stable across the half-windows, and the oscillation amplitude must not be
# growing (the oscillating-steady growth guard).
# --------------------------------------------------------------------------- #

#: Minimum whole cycles for the established-oscillation trend test. With
#: fewer than 3 cycle means "trend" is undefined (2 points are always
#: monotone), so shorter precalc windows are honestly non-stationary.
ESTABLISHED_MIN_CYCLES = 3
#: A monotone run of cycle means counts as a TREND only when the net change
#: |m_K - m_1| is at least this multiple of the residual scatter of the m_i
#: about their least-squares line. Rationale (worked for K=3, the precalc
#: contract size): the raw std of MONOTONE cycle means is trend-dominated —
#: net/std(m_i) is pinned to ~2.1-2.45 for any monotone triple — so raw
#: scatter cannot separate trend from luck; the RESIDUAL about the fitted
#: line can. K=3 geometry: with d = |m_2 - (m_1+m_3)/2| (interior deviation
#: from the endpoint chord), s_resid = d*sqrt(2/3), and strict monotonicity
#: bounds d < |net|/2, i.e. s_resid < 0.409|net|. The threshold must sit
#: ABOVE the collinearity bound |net|/s_resid = 2.449 or every monotone
#: triple would be "trending" and the significance clause would be vacuous.
#: At 3.0, a monotone triple is ACCEPTED when d > 0.408|net| — the interior
#: mean far off the endpoint chord, the signature of a modulated cycle that
#: landed monotone by luck (chance 2/3! = 1/3) — and REJECTED for the smooth
#: relaxation shapes: a geometric approach with per-cycle decay ratio rho has
#: d/|net| = (1-rho)/(2(1+rho)) < 0.408 for every rho > 0.105, so anything
#: short of a ~90%-in-one-cycle collapse trends. A slow smooth modulation
#: (period >> K cycles) IS still rejected — at K=3 it is indistinguishable
#: from a relaxing drift, and rejection escalates to the full tier, the
#: conservative direction.
TREND_MONOTONE_SIGNIFICANCE = 3.0
#: Slow-drift guard: even WITHOUT monotone signs (noise can flip one cycle
#: mean), a net change this many times the residual scatter is a drift with
#: noise riding on it, not an established cycle. Larger than the monotone
#: threshold because the residual already contains the sign-flipping wiggle.
TREND_DOMINANT_SIGNIFICANCE = 4.0
#: Absolute trend floor: net cycle-mean change below this fraction of the
#: drift scale (max(|mean cl|, retained cl rms, DRIFT_ABS_FLOOR) — the same
#: denominator as drift_frac) never counts as trending, so femto-scale
#: monotone numerical wobble cannot reject an established oscillation
#: (same rationale as DRIFT_ABS_FLOOR itself).
TREND_NET_MIN_FRACTION = 0.02


def _refined_lag_period(ac: np.ndarray, k: int, dt: float) -> float:
    """Parabolic interpolation of the autocorrelation maximum around lag k."""
    y0, y1, y2 = float(ac[k - 1]), float(ac[k]), float(ac[k + 1])
    denom = y0 - 2.0 * y1 + y2
    shift = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-12 else 0.0
    shift = min(0.5, max(-0.5, shift))
    return (k + shift) * dt


def measure_period(
    times: "np.ndarray | list[float]",
    values: "np.ndarray | list[float]",
    min_cycles: float = 2.0,
    corr_threshold: float = 0.2,
    period_band: "tuple[float, float] | None" = None,
    peak_tolerance: float = SUBHARMONIC_PEAK_TOLERANCE,
) -> float | None:
    """Shedding period [s] measured by AUTOCORRELATION of the (uniformly
    resampled, demeaned) signal — robust for noisy periodic force histories
    where zero crossings jitter and an FFT bin can land between peaks.

    Returns None when no credible period exists: flat/short signals, no
    positive autocorrelation peak past the first zero crossing, or fewer than
    ``min_cycles`` cycles of data. The peak lag is refined by parabolic
    interpolation of the autocorrelation maximum.

    ``period_band`` (seconds, from :func:`shedding_period_band`) restricts the
    lag search to the physically plausible shedding window: a broadband
    post-stall signal's low-frequency modulation / sub-harmonic (prod
    2026-07-07: a ~0.12 s sub-harmonic of a 0.0338 s fundamental) then cannot
    win the global argmax. Within the band the HIGHEST-frequency local
    autocorrelation peak whose strength is >= ``peak_tolerance`` of the
    strongest in-band peak is preferred (see SUBHARMONIC_PEAK_TOLERANCE), and
    when no in-band autocorrelation peak clears ``corr_threshold`` the FFT of
    the signal — restricted to the same band — is the fallback. Callers
    without flow context pass ``period_band=None`` and keep the legacy
    unconstrained behavior unchanged.
    """
    t, v = _normalise_series(times, values)
    if t.size < 16 or float(t[-1]) <= float(t[0]):
        return None
    n = int(min(8192, max(256, t.size)))
    tu = np.linspace(float(t[0]), float(t[-1]), n)
    vu = np.interp(tu, t, v)
    vu = vu - vu.mean()
    if not np.any(np.abs(vu) > 0):
        return None
    ac = np.correlate(vu, vu, mode="full")[n - 1 :]
    if ac[0] <= 0:
        return None
    ac = ac / ac[0]
    dt = (float(tu[-1]) - float(tu[0])) / (n - 1)
    span = float(t[-1]) - float(t[0])

    if period_band is not None:
        p_lo, p_hi = float(period_band[0]), float(period_band[1])
        if math.isfinite(p_lo) and math.isfinite(p_hi) and 0 < p_lo < p_hi:
            # Spectral credibility gate: the band must contain a REAL spectral
            # line (see IN_BAND_CREDIBILITY_FRACTION) before any in-band lag
            # may be locked. Without it, a genuinely out-of-band phenomenon
            # (bluff-body-like St < 0.05) minted a silently wrong period from
            # a noise wiggle on the sloping in-band autocorrelation, or from
            # the FFT leakage skirt at the band edge.
            freq = dominant_frequency(
                t, v, freq_band=(1.0 / p_hi, 1.0 / p_lo), peak_tolerance=peak_tolerance
            )
            if freq <= 0:
                return None
            k_lo = max(1, int(math.ceil(p_lo / dt)))
            k_hi = min(n - 2, int(math.floor(p_hi / dt)))
            if k_hi >= k_lo:
                lags = np.arange(k_lo, k_hi + 1)
                seg = ac[k_lo : k_hi + 1]
                is_peak = (
                    (seg >= ac[k_lo - 1 : k_hi])
                    & (seg >= ac[k_lo + 1 : k_hi + 2])
                    & (seg >= corr_threshold)
                )
                peak_lags = lags[is_peak]
                if peak_lags.size:
                    best = float(ac[peak_lags].max())
                    eligible = peak_lags[ac[peak_lags] >= peak_tolerance * best]
                    k = int(eligible.min())  # shortest lag = highest frequency
                    period = _refined_lag_period(ac, k, dt)
                    if (
                        math.isfinite(period)
                        and period > 0
                        and span >= min_cycles * period
                        and period * freq >= 1.0 - AC_FFT_UNDERCUT_TOLERANCE
                    ):
                        return float(period)
                    # The refined lag is unusable or undercuts the certified
                    # in-band FFT line (a slope artifact of dominant
                    # out-of-band modulation): fall through to the FFT line.
            # FFT fallback (reusing the credibility-gated in-band line): the
            # lag grid may be too coarse for the band, or no autocorrelation
            # local maximum cleared the threshold on a very noisy signal. The
            # FFT candidate must still be CORROBORATED by autocorrelation >=
            # corr_threshold at its lag — a flat/noise-only signal must not
            # mint a period, preserving the no-shedding honesty of the legacy
            # behavior.
            period = 1.0 / freq
            lag = period / dt
            corroborated = (
                1 <= lag <= n - 2
                and float(np.interp(lag, np.arange(n), ac)) >= corr_threshold
            )
            if (
                math.isfinite(period)
                and corroborated
                and span >= min_cycles * period
            ):
                return float(period)
            return None
        # invalid band => explicit legacy behavior below

    below = np.where(ac < 0)[0]
    if below.size == 0:
        return None
    first_negative = int(below[0])
    if first_negative >= n - 1:
        return None
    k = first_negative + int(np.argmax(ac[first_negative:]))
    if k <= 0 or k >= n - 1 or float(ac[k]) < corr_threshold:
        return None
    period = _refined_lag_period(ac, k, dt)
    if not math.isfinite(period) or period <= 0 or span < min_cycles * period:
        return None
    return float(period)


@dataclass(frozen=True)
class PeriodEstimate:
    """Band-constrained period estimate with a half-window stability verdict."""

    period_s: float
    ambiguous: bool
    first_half_s: "float | None"
    second_half_s: "float | None"


def estimate_period(
    times: "np.ndarray | list[float]",
    values: "np.ndarray | list[float]",
    *,
    speed: "float | None" = None,
    chord: "float | None" = None,
    min_cycles: float = PERIOD_ESTIMATE_MIN_CYCLES,
    corr_threshold: float = 0.2,
    ambiguity_tolerance: float = PERIOD_AMBIGUITY_TOLERANCE,
    alpha_deg: "float | None" = None,
    section_thickness_ratio: "float | None" = None,
) -> "PeriodEstimate | None":
    """Flow-context-aware shedding period with a stability check.

    Wraps :func:`measure_period` with the physical Strouhal band derived from
    ``speed``/``chord`` plus optional ``alpha_deg`` (legacy unconstrained search
    when speed/chord is missing), then estimates the period independently on the
    two halves of the analysis window. A missing half-window estimate, or two
    estimates differing by more than ``ambiguity_tolerance``, marks the period
    AMBIGUOUS.  The full-window estimate remains usable for continuation sizing,
    but an ambiguous estimate must never certify established oscillation.
    """
    band = shedding_period_band(
        speed,
        chord,
        alpha_deg=alpha_deg,
        section_thickness_ratio=section_thickness_ratio,
    )
    t, v = _normalise_series(times, values)
    if t.size == 0:
        return None
    full = measure_period(
        t, v, min_cycles=min_cycles, corr_threshold=corr_threshold, period_band=band
    )
    if full is None:
        return None
    mid = 0.5 * (float(t[0]) + float(t[-1]))
    first_mask = t <= mid
    second_mask = t >= mid
    p1 = measure_period(
        t[first_mask], v[first_mask],
        min_cycles=min_cycles, corr_threshold=corr_threshold, period_band=band,
    )
    p2 = measure_period(
        t[second_mask], v[second_mask],
        min_cycles=min_cycles, corr_threshold=corr_threshold, period_band=band,
    )
    # A full-window cadence is not evidence that the oscillation has settled
    # across time.  Both independent halves must corroborate it before callers
    # may certify an established oscillation.  Keeping ``period_s`` lets the
    # continuation loop size a safe next chunk while the quality verdict stays
    # fail closed.
    if p1 is None or p2 is None:
        return PeriodEstimate(
            period_s=float(full),
            ambiguous=True,
            first_half_s=p1,
            second_half_s=p2,
        )
    if (
        abs(p1 - p2) / max(p1, p2) > ambiguity_tolerance
    ):
        return PeriodEstimate(
            period_s=float(min(p1, p2)), ambiguous=True, first_half_s=p1, second_half_s=p2
        )
    return PeriodEstimate(period_s=float(full), ambiguous=False, first_half_s=p1, second_half_s=p2)


def discard_startup(
    times: "np.ndarray | list[float]",
    *values: "np.ndarray | list[float]",
    fraction: float,
) -> tuple[np.ndarray, ...]:
    """Drop the first ``fraction`` of the time span (startup transient)."""
    t = np.asarray(times, dtype=float)
    arrays = [np.asarray(v, dtype=float) for v in values]
    if fraction <= 0 or t.size == 0 or float(t[-1]) <= float(t[0]):
        return (t, *arrays)
    cut = float(t[0]) + min(max(float(fraction), 0.0), 0.999999) * float(t[-1] - t[0])
    mask = t >= cut
    return (t[mask], *(a[mask] for a in arrays))


@dataclass(frozen=True)
class CleanPeriodicTail:
    """A byte-backed settled suffix whose independent halves agree on period."""

    series: tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]
    estimate: PeriodEstimate
    audit: CleanCycleAudit | None = None
    clean_cycles: int = 0
    required_clean_cycles: int = 0
    certification_reason: str = ""
    cadence_adjusted: bool = False


def _has_impulsive_discontinuity(
    t: np.ndarray,
    *channels: np.ndarray,
    ignored_jump_times: Sequence[float] = (),
) -> bool:
    """Detect an isolated solver-step jump that is not a resolved waveform.

    The derivative comparison accounts for adaptive timesteps.  Both a large
    robust-amplitude jump and a 20x slope outlier are required, so ordinary
    sharp but repeatedly resolved post-stall cycles do not trip this guard.
    """
    if t.size < 32:
        return False
    dt = np.diff(t)
    valid_dt = np.isfinite(dt) & (dt > 0)
    # An OpenFOAM continuation may restart from a byte-backed checkpoint with
    # a different initial residual state. The single transition crossing its
    # authoritative numeric segment boundary is not a new within-run impulse.
    # Keep all samples and all ordinary period-similarity checks; exclude only
    # that derivative from the live recovery trigger. Final clean-tail
    # certification supplies no exclusions and therefore remains strict.
    for raw_boundary in ignored_jump_times:
        try:
            boundary = float(raw_boundary)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(boundary):
            continue
        valid_dt &= ~((t[:-1] < boundary) & (t[1:] >= boundary))
    if int(valid_dt.sum()) < 16:
        return True
    for values in channels:
        finite = np.isfinite(values)
        if int(finite.sum()) != values.size:
            return True
        jumps = np.abs(np.diff(values))
        slopes = jumps[valid_dt] / dt[valid_dt]
        if slopes.size < 16:
            continue
        slope_reference = float(np.nanpercentile(slopes, 95))
        robust_span = float(
            np.nanpercentile(values, 95) - np.nanpercentile(values, 5)
        )
        if (
            float(np.nanmax(slopes))
            > max(20.0 * slope_reference, 1e-12)
            and float(np.nanmax(jumps))
            > max(0.25 * robust_span, 1e-9)
        ):
            return True
    return False


@dataclass(frozen=True)
class _CycleEvidence:
    """Interpolated coefficient evidence for one exact whole period."""

    index: int
    start: float
    end: float
    time: np.ndarray
    cl: np.ndarray
    cd: np.ndarray
    cm: np.ndarray
    phase_cl: np.ndarray
    phase_cd: np.ndarray
    phase_cm: np.ndarray
    samples: int
    frames: int | None
    phase_gap: float
    hard_reasons: tuple[str, ...]


def _finite_frame_times(
    frame_times: "Sequence[float] | np.ndarray | None",
) -> np.ndarray | None:
    if frame_times is None:
        return None
    raw = np.asarray(frame_times, dtype=float)
    raw = raw[np.isfinite(raw)]
    return np.unique(np.sort(raw))


def _invalid_value_times(
    times: "np.ndarray | list[float]",
    *channels: "np.ndarray | list[float]",
) -> np.ndarray:
    """Return timestamps with a finite time but a missing coefficient value.

    Normalisation necessarily drops non-finite records before interpolation.
    Retaining their timestamps here lets the cycle audit call the affected
    period corrupt instead of accidentally smoothing a NaN away.
    """
    raw_t = np.asarray(times, dtype=float)
    arrays = [np.asarray(channel, dtype=float) for channel in channels]
    if any(values.size != raw_t.size for values in arrays):
        return np.empty(0, dtype=float)
    finite_values = np.ones(raw_t.size, dtype=bool)
    for values in arrays:
        finite_values &= np.isfinite(values)
    return raw_t[np.isfinite(raw_t) & ~finite_values]


def _normalise_invalid_times(
    values: "Sequence[float] | np.ndarray | None",
) -> np.ndarray:
    """Return finite, unique timestamps supplied by an outer raw reader.

    The clean-tail selector normally sees the coefficient arrays directly and
    can retain the timestamp of a non-finite coefficient before it normalises
    the series.  A restart merger or archive reader may already have removed
    that row, however.  This narrow adapter lets that reader carry the
    immutable corruption timestamp forward without asking the reducer to
    manufacture a coefficient value for it.
    """
    if values is None:
        return np.empty(0, dtype=float)
    try:
        raw = np.asarray(values, dtype=float)
    except (TypeError, ValueError):
        return np.empty(0, dtype=float)
    return np.unique(np.sort(raw[np.isfinite(raw)]))


def _cycle_phase_gap(
    times: np.ndarray,
    start: float,
    end: float,
) -> float:
    span = end - start
    if times.size < 2 or not math.isfinite(span) or span <= 0:
        return 1.0
    phase = np.clip((times - start) / span, 0.0, 1.0)
    phase = np.unique(phase)
    if phase.size < 2:
        return 1.0
    return float(np.max(np.diff(np.concatenate(([0.0], phase, [1.0])))))


def _has_cycle_impulse(
    times: np.ndarray,
    *channels: np.ndarray,
) -> bool:
    """Apply the normal impulse guard, including 20-sample certificate cycles.

    The shared history guard intentionally needs 32 samples to avoid reacting
    to a sparse in-flight monitor.  Certified cycles legitimately permit 20
    samples, so give that small range an equivalent robust fallback rather
    than letting a single corrupt sample escape solely due to row count.
    """
    if _has_impulsive_discontinuity(times, *channels):
        return True
    if times.size >= 32 or times.size < 8:
        return False
    dt = np.diff(times)
    valid = np.isfinite(dt) & (dt > 0)
    if int(valid.sum()) < 6:
        return True
    for values in channels:
        if int(np.isfinite(values).sum()) != values.size:
            return True
        jumps = np.abs(np.diff(values))
        slopes = jumps[valid] / dt[valid]
        if slopes.size < 6:
            continue
        reference = float(np.nanpercentile(slopes, 75))
        robust_span = float(
            np.nanpercentile(values, 95) - np.nanpercentile(values, 5)
        )
        if (
            float(np.nanmax(slopes)) > max(12.0 * reference, 1e-12)
            and float(np.nanmax(jumps)) > max(0.25 * robust_span, 1e-9)
        ):
            return True
    return False


def _channel_scale(values: np.ndarray) -> tuple[float, float, float]:
    """Return comparison scale, robust amplitude and time/phase mean."""
    if values.size == 0:
        return 1e-9, 0.0, 0.0
    amplitude = float(np.nanpercentile(values, 95) - np.nanpercentile(values, 5))
    mean = float(np.nanmean(values))
    return max(amplitude, 0.05 * abs(mean), 1e-9), max(amplitude, 0.0), mean


def _high_frequency_amplitude(values: np.ndarray) -> float:
    """RMS-equivalent phase energy above the resolved waveform harmonics."""
    if values.size < CLEAN_CYCLE_HIGH_FREQUENCY_START_BIN * 2:
        return 0.0
    centered = np.asarray(values, dtype=float) - float(np.nanmean(values))
    spectrum = np.fft.rfft(centered)
    start = min(CLEAN_CYCLE_HIGH_FREQUENCY_START_BIN, spectrum.size)
    if start >= spectrum.size:
        return 0.0
    # rfft coefficients carry N/2 of a sinusoid amplitude.  The root-sum
    # conversion below is deliberately comparable with the coefficient units,
    # not an arbitrary spectral-bin magnitude.
    return float(math.sqrt(2.0) * np.linalg.norm(spectrum[start:]) / values.size)


def _phase_aligned_errors(
    values: tuple[np.ndarray, np.ndarray, np.ndarray],
    template: tuple[np.ndarray, np.ndarray, np.ndarray],
) -> tuple[int, tuple[float, float, float], tuple[float, float, float]]:
    """Align a cycle to the vector template and return shift/shape/amplitude.

    Search the full 96-bin circle to *measure* an excessive phase offset, then
    use its best alignment for shape comparison.  A shift greater than four
    bins is still rejected by the caller; it is not hidden by alignment.
    """
    scales = tuple(_channel_scale(channel)[0] for channel in template)
    best_shift = 0
    best_cost = math.inf
    count = values[0].size
    for shift in range(count):
        cost = 0.0
        for actual, expected, scale in zip(values, template, scales):
            delta = np.roll(actual, shift) - expected
            cost += float(np.nanmean(delta**2)) / (scale**2)
        if cost < best_cost:
            best_cost = cost
            best_shift = shift
    # Report the shortest signed circle movement, not its equivalent 95-bin
    # positive representation.
    signed_shift = best_shift if best_shift <= count // 2 else best_shift - count
    aligned = tuple(np.roll(channel, best_shift) for channel in values)
    shape = tuple(
        float(math.sqrt(float(np.nanmean((actual - expected) ** 2))) / scale)
        for actual, expected, scale in zip(aligned, template, scales)
    )
    amplitude_deviation: list[float] = []
    for actual, expected in zip(aligned, template):
        _actual_scale, actual_amplitude, _actual_mean = _channel_scale(actual)
        _expected_scale, expected_amplitude, _expected_mean = _channel_scale(expected)
        if expected_amplitude <= max(1e-8, 0.01 * _expected_scale):
            amplitude_deviation.append(0.0 if actual_amplitude <= 1e-8 else float("inf"))
        else:
            amplitude_deviation.append(
                abs(actual_amplitude - expected_amplitude) / expected_amplitude
            )
    return signed_shift, shape, tuple(amplitude_deviation)


def _mean_outlier(
    name: str,
    actual: float,
    expected: float,
) -> bool:
    budget = max(
        _CYCLE_MEAN_ABS_BUDGET[name],
        _CYCLE_MEAN_REL_BUDGET[name] * abs(expected),
    )
    return abs(actual - expected) > budget


def _cycle_evidence(
    t: np.ndarray,
    cl: np.ndarray,
    cd: np.ndarray,
    cm: np.ndarray,
    *,
    index: int,
    is_last: bool,
    start: float,
    end: float,
    phase_samples: int,
    frame_times: np.ndarray | None,
    min_samples_per_cycle: int,
    min_frames_per_cycle: float,
    invalid_times: np.ndarray,
) -> _CycleEvidence:
    eps = max(abs(start), abs(end), 1.0) * 1e-10
    # Every raw coefficient row has exactly one cycle owner. Adjacent
    # inclusive windows used to let a period-boundary row satisfy both
    # neighbouring cycles' 20-sample gate. Use [start, end) windows and let
    # only the final cycle include the physical terminal endpoint.
    if is_last:
        raw_mask = (t >= start - eps) & (t <= end + eps)
        invalid_mask = (invalid_times >= start - eps) & (invalid_times <= end + eps)
    else:
        raw_mask = (t >= start - eps) & (t < end - eps)
        invalid_mask = (invalid_times >= start - eps) & (invalid_times < end - eps)
    samples = int(raw_mask.sum())
    raw_times = t[raw_mask]
    phase_gap = _cycle_phase_gap(raw_times, start, end)
    if frame_times is None:
        frames: int | None = None
    else:
        if is_last:
            frame_mask = (frame_times >= start - eps) & (frame_times <= end + eps)
        else:
            frame_mask = (frame_times >= start - eps) & (frame_times < end - eps)
        frames = int(frame_mask.sum())

    hard: list[str] = []
    if samples < min_samples_per_cycle:
        hard.append(f"samples {samples} < {min_samples_per_cycle}")
    if phase_gap > CLEAN_CYCLE_MAX_PHASE_GAP:
        hard.append(
            f"phase gap {phase_gap:.1%} > {CLEAN_CYCLE_MAX_PHASE_GAP:.0%}"
        )
    if frames is not None and frames + 1e-9 < min_frames_per_cycle:
        hard.append(f"frames {frames} < {min_frames_per_cycle:g}")
    if invalid_times.size and np.any(invalid_mask):
        hard.append("non-finite coefficient sample")

    window = PeriodWindow(start=start, end=end, cycles=1, period_s=end - start)
    wt, wcl, wcd, wcm = _window_series(t, cl, cd, cm, window)
    if _has_cycle_impulse(wt, wcl, wcd, wcm):
        hard.append("impulsive discontinuity")
    phase = np.linspace(start, end, max(8, int(phase_samples)), endpoint=False)
    return _CycleEvidence(
        index=index,
        start=start,
        end=end,
        time=wt,
        cl=wcl,
        cd=wcd,
        cm=wcm,
        phase_cl=np.interp(phase, wt, wcl),
        phase_cd=np.interp(phase, wt, wcd),
        phase_cm=np.interp(phase, wt, wcm),
        samples=samples,
        frames=frames,
        phase_gap=phase_gap,
        hard_reasons=tuple(hard),
    )


def _cycle_template(
    cycles: Sequence[_CycleEvidence],
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    return tuple(
        np.median(np.stack([getattr(cycle, name) for cycle in cycles]), axis=0)
        for name in ("phase_cl", "phase_cd", "phase_cm")
    )  # type: ignore[return-value]


def audit_period_cycles(
    times: "np.ndarray | list[float]",
    cl: "np.ndarray | list[float]",
    cd: "np.ndarray | list[float]",
    cm: "np.ndarray | list[float]",
    period_s: float,
    *,
    fidelity: str | None = None,
    required_cycles: float = 0.0,
    min_clean_cycles: int | None = None,
    frame_times: "Sequence[float] | np.ndarray | None" = None,
    min_frames_per_cycle: float = 20.0,
    min_samples_per_cycle: int = CLEAN_CYCLE_MIN_SAMPLES,
    phase_samples: int = CLEAN_CYCLE_PHASE_SAMPLES,
    invalid_coefficient_times: "Sequence[float] | np.ndarray | None" = None,
) -> CleanCycleAudit:
    """Audit every exact whole terminal period and select a clean suffix.

    The median template is built from the latest usable cycles, which makes an
    old damaged startup unable to define what "normal" looks like.  A cycle is
    clean only when Cl, Cd *and* Cm pass hard integrity and soft repeatability
    checks.  The returned object contains every disposition so callers can
    distinguish a request for more periods from a numerical-recovery trigger.
    """
    requirement = required_clean_cycle_count(
        fidelity=fidelity,
        required_cycles=required_cycles,
        minimum_cycles=min_clean_cycles,
    )
    if (
        not math.isfinite(period_s)
        or period_s <= 0
        or int(phase_samples) < 8
    ):
        return CleanCycleAudit(
            period_s=float(period_s) if math.isfinite(period_s) else 0.0,
            phase_samples=max(8, int(phase_samples)),
            cycles=(),
            terminal_clean_cycles=0,
            required_clean_cycles=requirement,
            template_cycles=0,
            shape_error=math.inf,
        )

    # Keep both defects visible: values supplied directly to this audit and
    # timestamps preserved by an outer archive/restart reader after it had to
    # normalise its numeric arrays.  A terminal NaN must make its owning cycle
    # non-publishable; silently interpolating over it would defeat the entire
    # clean-suffix contract.
    invalid_times = _invalid_value_times(times, cl, cd, cm)
    inherited_invalid_times = _normalise_invalid_times(invalid_coefficient_times)
    if inherited_invalid_times.size:
        invalid_times = np.unique(
            np.concatenate((invalid_times, inherited_invalid_times))
        )
    t, vcl, vcd, vcm = _normalise_series(times, cl, cd, cm)
    if t.size < 2 or float(t[-1]) <= float(t[0]):
        return CleanCycleAudit(
            period_s=float(period_s),
            phase_samples=int(phase_samples),
            cycles=(),
            terminal_clean_cycles=0,
            required_clean_cycles=requirement,
            template_cycles=0,
            shape_error=math.inf,
        )

    available = int(math.floor((float(t[-1]) - float(t[0])) / period_s + 1e-9))
    if available < 1:
        return CleanCycleAudit(
            period_s=float(period_s),
            phase_samples=int(phase_samples),
            cycles=(),
            terminal_clean_cycles=0,
            required_clean_cycles=requirement,
            template_cycles=0,
            shape_error=math.inf,
        )
    end = float(t[-1])
    first = end - available * period_s
    frames = _finite_frame_times(frame_times)
    evidence = tuple(
        _cycle_evidence(
            t,
            vcl,
            vcd,
            vcm,
            index=index,
            is_last=index == available - 1,
            start=first + index * period_s,
            end=first + (index + 1) * period_s,
            phase_samples=int(phase_samples),
            frame_times=frames,
            min_samples_per_cycle=max(2, int(min_samples_per_cycle)),
            min_frames_per_cycle=max(0.0, float(min_frames_per_cycle)),
            invalid_times=invalid_times,
        )
        for index in range(available)
    )

    usable = [cycle for cycle in evidence if not cycle.hard_reasons]
    # A terminal weighted lookback keeps a long corrupted beginning from
    # winning the median.  Two extra cycles make a single bad final/penultimate
    # cycle unable to redefine the template; five is also the final-tier floor.
    template_limit = max(requirement + 2, FINAL_CLEAN_CYCLE_MINIMUM)
    template_source = usable[-template_limit:]
    if not template_source:
        audits = tuple(
            CycleAudit(
                index=cycle.index,
                start=cycle.start,
                end=cycle.end,
                samples=cycle.samples,
                frames=cycle.frames,
                phase_gap=cycle.phase_gap,
                phase_shift_bins=0,
                cl_mean=0.0,
                cd_mean=0.0,
                cm_mean=0.0,
                cl_shape_error=math.inf,
                cd_shape_error=math.inf,
                cm_shape_error=math.inf,
                cl_amplitude_deviation=math.inf,
                cd_amplitude_deviation=math.inf,
                cm_amplitude_deviation=math.inf,
                cl_high_frequency=0.0,
                cd_high_frequency=0.0,
                cm_high_frequency=0.0,
                hard_reasons=cycle.hard_reasons,
                soft_reasons=(),
            )
            for cycle in evidence
        )
        return CleanCycleAudit(
            period_s=float(period_s),
            phase_samples=int(phase_samples),
            cycles=audits,
            terminal_clean_cycles=0,
            required_clean_cycles=requirement,
            template_cycles=0,
            shape_error=math.inf,
            measured_periods=available,
        )

    template = _cycle_template(template_source)
    template_means = tuple(float(np.nanmean(channel)) for channel in template)
    high_frequency_by_cycle = {
        cycle.index: tuple(
            _high_frequency_amplitude(channel)
            for channel in (cycle.phase_cl, cycle.phase_cd, cycle.phase_cm)
        )
        for cycle in evidence
    }
    high_frequency_peer = tuple(
        np.asarray(
            [high_frequency_by_cycle[cycle.index][channel] for cycle in template_source],
            dtype=float,
        )
        for channel in range(3)
    )
    high_frequency_median = tuple(
        float(np.median(values)) if values.size else 0.0
        for values in high_frequency_peer
    )
    high_frequency_mad = tuple(
        float(np.median(np.abs(values - median))) if values.size else 0.0
        for values, median in zip(high_frequency_peer, high_frequency_median)
    )
    template_scales = tuple(_channel_scale(channel)[0] for channel in template)

    audits_list: list[CycleAudit] = []
    for cycle in evidence:
        values = (cycle.phase_cl, cycle.phase_cd, cycle.phase_cm)
        shift, shapes, amplitudes = _phase_aligned_errors(values, template)
        means = tuple(
            _time_weighted_mean_std(cycle.time, values_raw)[0]
            for values_raw in (cycle.cl, cycle.cd, cycle.cm)
        )
        high_frequency = high_frequency_by_cycle[cycle.index]
        hard = list(cycle.hard_reasons)
        soft: list[str] = []
        names = ("cl", "cd", "cm")
        for name, mean, expected in zip(names, means, template_means):
            if _mean_outlier(name, mean, expected):
                soft.append(f"{name} mean outlier")
        for name, shape in zip(names, shapes):
            if shape > CLEAN_CYCLE_MAX_SHAPE_NRMSE:
                soft.append(f"{name} shape {shape:.3f} > {CLEAN_CYCLE_MAX_SHAPE_NRMSE:.2f}")
        for name, amplitude in zip(names, amplitudes):
            if amplitude > CLEAN_CYCLE_MAX_AMPLITUDE_DEVIATION:
                soft.append(
                    f"{name} amplitude deviation {amplitude:.1%} > "
                    f"{CLEAN_CYCLE_MAX_AMPLITUDE_DEVIATION:.0%}"
                )
        if abs(shift) > CLEAN_CYCLE_MAX_PHASE_SHIFT_BINS:
            soft.append(
                f"phase shift {shift:+d} bins > "
                f"{CLEAN_CYCLE_MAX_PHASE_SHIFT_BINS}"
            )
        for name, energy, scale, median, mad in zip(
            names,
            high_frequency,
            template_scales,
            high_frequency_median,
            high_frequency_mad,
        ):
            # Require a material fraction of the physical waveform *and* an
            # outlier against peer cycles.  A repeatable sharp wake is present
            # in the median/template and therefore does not get labelled noise.
            peer_outlier = energy > 3.0 * max(median, 1e-12) or energy > median + 6.0 * max(mad, 1e-12)
            if energy > CLEAN_CYCLE_HIGH_FREQUENCY_FRACTION * scale and peer_outlier:
                hard.append(f"{name} high-frequency burst")
        audits_list.append(
            CycleAudit(
                index=cycle.index,
                start=cycle.start,
                end=cycle.end,
                samples=cycle.samples,
                frames=cycle.frames,
                phase_gap=cycle.phase_gap,
                phase_shift_bins=shift,
                cl_mean=means[0],
                cd_mean=means[1],
                cm_mean=means[2],
                cl_shape_error=shapes[0],
                cd_shape_error=shapes[1],
                cm_shape_error=shapes[2],
                cl_amplitude_deviation=amplitudes[0],
                cd_amplitude_deviation=amplitudes[1],
                cm_amplitude_deviation=amplitudes[2],
                cl_high_frequency=high_frequency[0],
                cd_high_frequency=high_frequency[1],
                cm_high_frequency=high_frequency[2],
                hard_reasons=tuple(hard),
                soft_reasons=tuple(soft),
            )
        )
    audits = tuple(audits_list)
    terminal = 0
    for cycle in reversed(audits):
        if not cycle.clean:
            break
        terminal += 1
    finite_shape = [
        max(cycle.cl_shape_error, cycle.cd_shape_error, cycle.cm_shape_error)
        for cycle in audits
        if math.isfinite(cycle.cl_shape_error)
        and math.isfinite(cycle.cd_shape_error)
        and math.isfinite(cycle.cm_shape_error)
    ]
    return CleanCycleAudit(
        period_s=float(period_s),
        phase_samples=int(phase_samples),
        cycles=audits,
        terminal_clean_cycles=terminal,
        required_clean_cycles=requirement,
        template_cycles=len(template_source),
        shape_error=max(finite_shape) if finite_shape else math.inf,
        measured_periods=available,
    )


def _period_in_physical_band(
    period_s: float,
    *,
    speed: float,
    chord: float,
    alpha_deg: "float | None",
    section_thickness_ratio: "float | None",
) -> bool:
    band = shedding_period_band(
        speed,
        chord,
        alpha_deg=alpha_deg,
        section_thickness_ratio=section_thickness_ratio,
    )
    if band is None:
        return True
    return band[0] - 1e-12 <= period_s <= band[1] + 1e-12


def _choose_clean_cycle_cadence(
    times: np.ndarray,
    cl: np.ndarray,
    cd: np.ndarray,
    cm: np.ndarray,
    period_s: float,
    *,
    speed: float,
    chord: float,
    fidelity: str | None,
    required_cycles: float,
    min_clean_cycles: int | None,
    frame_times: "Sequence[float] | np.ndarray | None",
    min_frames_per_cycle: float,
    phase_samples: int,
    alpha_deg: "float | None",
    section_thickness_ratio: "float | None",
    invalid_coefficient_times: "Sequence[float] | np.ndarray | None",
) -> CleanCycleAudit:
    """Use T, then test T/2 and 2T only when T cannot certify.

    An alternating wake is a common false rejection: T sees adjacent cycles as
    different while 2T is the actual vector repeat.  Conversely a harmonic
    lock at 2T can hide a clean T cadence.  An alternate cadence is accepted
    only if it certifies a terminal suffix and lowers vector template error by
    at least 30%, so the detector never changes cadence merely to obtain more
    cycle count.
    """
    common = dict(
        fidelity=fidelity,
        required_cycles=required_cycles,
        min_clean_cycles=min_clean_cycles,
        frame_times=frame_times,
        min_frames_per_cycle=min_frames_per_cycle,
        phase_samples=phase_samples,
        invalid_coefficient_times=invalid_coefficient_times,
    )
    baseline = audit_period_cycles(times, cl, cd, cm, period_s, **common)
    if baseline.certified:
        return baseline
    candidates: list[tuple[float, CleanCycleAudit]] = [(period_s, baseline)]
    for factor in (0.5, 2.0):
        candidate = period_s * factor
        if (
            not math.isfinite(candidate)
            or candidate <= 0
            or not _period_in_physical_band(
                candidate,
                speed=speed,
                chord=chord,
                alpha_deg=alpha_deg,
                section_thickness_ratio=section_thickness_ratio,
            )
        ):
            continue
        candidates.append(
            (candidate, audit_period_cycles(times, cl, cd, cm, candidate, **common))
        )
    baseline_error = baseline.shape_error
    for candidate_period, candidate in candidates[1:]:
        improves = (
            not math.isfinite(baseline_error)
            or candidate.shape_error <= 0.70 * baseline_error
        )
        if candidate.certified and improves:
            return replace(candidate, cadence_adjusted=True)
    return baseline


def clean_periodic_tail(
    times: "np.ndarray | list[float]",
    cl: "np.ndarray | list[float]",
    cd: "np.ndarray | list[float]",
    cm: "np.ndarray | list[float]",
    *,
    speed: float,
    chord: float,
    required_cycles: float,
    fidelity: str | None = None,
    min_clean_cycles: int | None = None,
    frame_times: "Sequence[float] | np.ndarray | None" = None,
    min_frames_per_cycle: float = 20.0,
    phase_samples: int = CLEAN_CYCLE_PHASE_SAMPLES,
    alpha_deg: "float | None" = None,
    section_thickness_ratio: "float | None" = None,
    recovery_origin_time: float | None = None,
    recovery_latest_time: float | None = None,
    invalid_coefficient_times: "Sequence[float] | np.ndarray | None" = None,
) -> "CleanPeriodicTail | None":
    """Find the latest clean, corroborated periodic suffix.

    A fixed elapsed-time discard is only a lower-level startup hint: numerical
    settling can outlive it.  Search trailing immutable evidence suffixes,
    require the period to agree across both halves, then retain an exact final
    ``required_cycles`` horizon with the same independently corroborated
    cadence.  The horizon is publishable only when the larger whole-cycle
    suffix has a contiguous terminal run of individually clean Cl/Cd/Cm
    cycles.  ``frame_times`` is optional for historical coefficient-only
    callers; when supplied each selected cycle must independently satisfy the
    requested frame floor.
    """
    # Preserve a direct raw non-finite row before normalisation drops it.  The
    # archive/live callers may additionally provide defects found while
    # parsing a merged restart history.
    direct_invalid_times = _invalid_value_times(times, cl, cd, cm)
    inherited_invalid_times = _normalise_invalid_times(invalid_coefficient_times)
    all_invalid_times = (
        np.unique(np.concatenate((direct_invalid_times, inherited_invalid_times)))
        if inherited_invalid_times.size
        else direct_invalid_times
    )
    t, vcl, vcd, vcm = _normalise_series(times, cl, cd, cm)
    # The cadence candidate below may intentionally inspect only a short
    # terminal suffix.  Preserve an independently supplied same-case progress
    # interval for recovery-budget accounting; normal callers fall back to the
    # complete input interval.
    progress_origin = (
        float(recovery_origin_time)
        if recovery_origin_time is not None
        else (float(t[0]) if t.size else None)
    )
    progress_latest = (
        float(recovery_latest_time)
        if recovery_latest_time is not None
        else (float(t[-1]) if t.size else None)
    )
    clean_requirement = required_clean_cycle_count(
        fidelity=fidelity,
        required_cycles=required_cycles,
        minimum_cycles=min_clean_cycles,
    )
    cycles = max(
        float(required_cycles),
        float(clean_requirement),
        2.0 * PERIOD_ESTIMATE_MIN_CYCLES + 0.5,
    )
    minimum_samples = max(64, int(math.ceil(cycles * 20.0)))
    for candidate in _tail_candidate_series(
        t,
        vcl,
        vcd,
        vcm,
        min_samples=minimum_samples,
        include_dense_tail_counts=True,
    ):
        tc, clc, cdc, cmc = candidate
        estimate = estimate_period(
            tc,
            clc,
            speed=speed,
            chord=chord,
            alpha_deg=alpha_deg,
            section_thickness_ratio=section_thickness_ratio,
        )
        if estimate is None or estimate.ambiguous:
            continue
        period = float(estimate.period_s)
        if (
            not math.isfinite(period)
            or period <= 0
            or float(tc[-1] - tc[0]) + 1e-12 < cycles * period
        ):
            continue
        verification = trailing_period_series(
            tc,
            clc,
            cdc,
            cmc,
            period,
            cycles,
        )
        confirmed = estimate_period(
            verification[0],
            verification[1],
            speed=speed,
            chord=chord,
            alpha_deg=alpha_deg,
            section_thickness_ratio=section_thickness_ratio,
        )
        if confirmed is None or confirmed.ambiguous:
            continue
        confirmed_period = float(confirmed.period_s)
        if (
            not math.isfinite(confirmed_period)
            or confirmed_period <= 0
            or abs(confirmed_period - period) / max(confirmed_period, period)
            > PERIOD_AMBIGUITY_TOLERANCE
            or float(tc[-1] - tc[0]) + 1e-12
            < cycles * confirmed_period
        ):
            continue
        verification = trailing_period_series(
            tc,
            clc,
            cdc,
            cmc,
            confirmed_period,
            cycles,
        )
        audit = _choose_clean_cycle_cadence(
            tc,
            clc,
            cdc,
            cmc,
            confirmed_period,
            speed=speed,
            chord=chord,
            fidelity=fidelity,
            required_cycles=required_cycles,
            min_clean_cycles=min_clean_cycles,
            frame_times=frame_times,
            min_frames_per_cycle=min_frames_per_cycle,
            phase_samples=phase_samples,
            alpha_deg=alpha_deg,
            section_thickness_ratio=section_thickness_ratio,
            invalid_coefficient_times=all_invalid_times,
        )
        audit = with_clean_cycle_recovery_progress(
            audit,
            origin_time=progress_origin,
            latest_time=progress_latest,
        )
        assert audit is not None
        if not audit.certified:
            continue
        selected_period = audit.period_s
        exact = trailing_period_series(
            tc,
            clc,
            cdc,
            cmc,
            selected_period,
            required_cycles,
        )
        if exact[0].size < 2 or float(exact[0][-1] - exact[0][0]) + 1e-12 < required_cycles * selected_period:
            continue
        # The selected fractional publication horizon must sit inside the
        # terminal whole-cycle suffix.  This is explicit rather than inferred
        # from a sample count because adaptive timesteps move row boundaries.
        suffix_start = audit.terminal_clean_start
        if suffix_start is None or float(exact[0][0]) + 1e-10 < suffix_start:
            continue
        # Publish only the exact corroborated horizon.  The candidate may be
        # wider than this window and still contain an old startup burst whose
        # energy is too small to change its dominant trailing period.  Returning
        # that wider suffix would reintroduce precisely the corrupt prefix this
        # selector exists to remove.
        selected_estimate = PeriodEstimate(
            period_s=selected_period,
            ambiguous=False,
            first_half_s=confirmed.first_half_s,
            second_half_s=confirmed.second_half_s,
        )
        return CleanPeriodicTail(
            series=exact,
            estimate=selected_estimate,
            audit=audit,
            clean_cycles=audit.terminal_clean_cycles,
            required_clean_cycles=audit.required_clean_cycles,
            certification_reason=(
                f"{audit.terminal_clean_cycles}/{audit.required_clean_cycles} "
                "terminal cycles clean"
            ),
            cadence_adjusted=audit.cadence_adjusted,
        )
    return None


def terminal_period_estimate(
    times: "np.ndarray | list[float]",
    cl: "np.ndarray | list[float]",
    cd: "np.ndarray | list[float]",
    cm: "np.ndarray | list[float]",
    *,
    speed: float,
    chord: float,
    required_cycles: float,
    fidelity: str | None = None,
    min_clean_cycles: int | None = None,
    alpha_deg: "float | None" = None,
    section_thickness_ratio: "float | None" = None,
) -> "PeriodEstimate | None":
    """Find a corroborated cadence from the latest usable raw trajectory.

    This is deliberately *not* a certification path.  It exists for the one
    recovery case where a corrupt terminal row prevents the whole-history
    period estimator from agreeing across its halves.  The caller must still
    run :func:`audit_period_cycles` with the preserved corruption timestamps
    before it can request more physical periods.  Returning a cadence here
    therefore enables a bounded exact continuation, never a false publish.
    """
    t, vcl, vcd, vcm = _normalise_series(times, cl, cd, cm)
    requirement = required_clean_cycle_count(
        fidelity=fidelity,
        required_cycles=required_cycles,
        minimum_cycles=min_clean_cycles,
    )
    cycles = max(
        float(required_cycles),
        float(requirement),
        2.0 * PERIOD_ESTIMATE_MIN_CYCLES + 0.5,
    )
    minimum_samples = max(64, int(math.ceil(cycles * 20.0)))
    for candidate in _tail_candidate_series(
        t,
        vcl,
        vcd,
        vcm,
        min_samples=minimum_samples,
        include_dense_tail_counts=True,
    ):
        tc, clc, cdc, cmc = candidate
        estimate = estimate_period(
            tc,
            clc,
            speed=speed,
            chord=chord,
            alpha_deg=alpha_deg,
            section_thickness_ratio=section_thickness_ratio,
        )
        if estimate is None or estimate.ambiguous or estimate.period_s <= 0:
            continue
        period = float(estimate.period_s)
        if float(tc[-1] - tc[0]) + 1e-12 < cycles * period:
            continue
        verification = trailing_period_series(tc, clc, cdc, cmc, period, cycles)
        confirmed = estimate_period(
            verification[0],
            verification[1],
            speed=speed,
            chord=chord,
            alpha_deg=alpha_deg,
            section_thickness_ratio=section_thickness_ratio,
        )
        if confirmed is None or confirmed.ambiguous or confirmed.period_s <= 0:
            continue
        confirmed_period = float(confirmed.period_s)
        if (
            abs(confirmed_period - period) / max(confirmed_period, period)
            > PERIOD_AMBIGUITY_TOLERANCE
            or float(tc[-1] - tc[0]) + 1e-12 < cycles * confirmed_period
        ):
            continue
        return PeriodEstimate(
            period_s=confirmed_period,
            ambiguous=False,
            first_half_s=confirmed.first_half_s,
            second_half_s=confirmed.second_half_s,
        )
    return None


@dataclass(frozen=True)
class ChannelWindowStats:
    """Time-weighted trapezoidal stats of one coefficient over the window."""

    mean: float
    std: float
    min: float
    max: float


@dataclass(frozen=True)
class PeriodWindowStats:
    """Integer-period window stats backing the frame_track contract.

    ``cycle_means``/``cycle_mean_std``/``stationary_reason`` are ENGINE-SIDE
    diagnostics for the precalc established-oscillation verdict and its
    quality-warning text. They are deliberately NOT part of the serialized
    frame_track contract (the cross-runtime parser rejects new keys); the
    verdict travels through the existing ``stationary`` boolean and warning
    strings only.
    """

    period_s: float
    periods_retained: float  # fractional periods available in the series (M.x)
    whole_periods: int  # K = floor(periods_retained); the stats window
    window_start: float
    window_end: float
    cl: ChannelWindowStats
    cd: ChannelWindowStats
    cm: ChannelWindowStats
    drift_frac: float
    stationary: bool
    cycle_means: tuple[float, ...] = ()
    cycle_mean_std: float = 0.0
    stationary_reason: str = ""


def _windowed_mean(t: np.ndarray, v: np.ndarray, a: float, b: float) -> float:
    """Time-weighted trapezoidal mean of v over [a, b] with interpolated ends."""
    interior = (t > a) & (t < b)
    tt = np.concatenate(([a], t[interior], [b]))
    vv = np.concatenate(([np.interp(a, t, v)], v[interior], [np.interp(b, t, v)]))
    mean, _std = _time_weighted_mean_std(tt, vv)
    return mean


def _cycle_mean_trend(cycle_means: "Sequence[float]", scale: float) -> tuple[bool, str]:
    """Robust monotonic-trend test on per-cycle means (precalc established-
    oscillation gate). Returns ``(trending, description)``.

    Definition (K = len(cycle_means) >= ESTABLISHED_MIN_CYCLES, documented at
    the TREND_* constants):

    - net = m_K - m_1; monotone = all successive differences share one strict
      sign (any tie/reversal breaks it — a Kendall-style sign statistic, which
      at |S| = K(K-1)/2 is exactly this condition);
    - s_resid = dof-adjusted rms residual of the m_i about their least-squares
      line (sqrt(SS/(K-2))) — the scatter that is NOT explained by a linear
      trend;
    - TRENDING iff |net| >= TREND_NET_MIN_FRACTION * scale (absolute floor)
      AND (monotone and |net| >= TREND_MONOTONE_SIGNIFICANCE * s_resid,
      OR |net| >= TREND_DOMINANT_SIGNIFICANCE * s_resid — the slow-drift
      guard for drifts whose noise flips one cycle mean).
    """
    ms = np.asarray(cycle_means, dtype=float)
    k = ms.size
    net = float(ms[-1] - ms[0])
    if abs(net) < TREND_NET_MIN_FRACTION * scale:
        return False, f"net cycle-mean change {net:+.3g} below the {TREND_NET_MIN_FRACTION:.0%} trend floor"
    diffs = np.diff(ms)
    monotone = bool(np.all(diffs > 0.0) or np.all(diffs < 0.0))
    x = np.arange(k, dtype=float)
    slope, intercept = np.polyfit(x, ms, 1)
    resid = ms - (slope * x + intercept)
    s_resid = float(math.sqrt(float(np.sum(resid**2)) / (k - 2))) if k > 2 else 0.0
    direction = "upward" if net > 0 else "downward"
    if monotone and abs(net) >= TREND_MONOTONE_SIGNIFICANCE * s_resid:
        return True, (
            f"cycle means trend {direction} monotonically: net {net:+.3g} over {k} cycles "
            f"vs residual scatter {s_resid:.3g}"
        )
    if abs(net) >= TREND_DOMINANT_SIGNIFICANCE * s_resid:
        return True, (
            f"cycle means drift {direction}: net {net:+.3g} over {k} cycles dominates "
            f"residual scatter {s_resid:.3g}"
        )
    return False, (
        f"cycle means scatter trendlessly (net {net:+.3g} vs residual scatter {s_resid:.3g} "
        f"over {k} cycles)"
    )


def _established_oscillation_verdict(
    st: np.ndarray,
    scl: np.ndarray,
    start: float,
    end: float,
    period_s: float,
    k: int,
    cycle_means: tuple[float, ...],
    drift_scale: float,
    period_stable: bool,
) -> tuple[bool, str]:
    """Precalc-tier stationarity: has the transient CONVERGED TO A STABLE
    OSCILLATION? Requires K >= ESTABLISHED_MIN_CYCLES whole cycles, a stable
    period, no monotonic cycle-mean trend (:func:`_cycle_mean_trend`) and a
    non-growing amplitude (the oscillating-steady growth guard
    OSCILLATING_AMPLITUDE_GROWTH_MAX applied to the whole-period half-window
    peak-to-peaks). Returns ``(established, reason)``."""
    if k < ESTABLISHED_MIN_CYCLES:
        return False, (
            f"only {k} whole cycle{'s' if k != 1 else ''} retained; the established-oscillation "
            f"test needs >= {ESTABLISHED_MIN_CYCLES}"
        )
    if not period_stable:
        return False, "shedding period unstable between the analysis half-windows"
    trending, trend_reason = _cycle_mean_trend(cycle_means, drift_scale)
    if trending:
        return False, trend_reason
    # Bounded amplitude: same whole-period halves as the drift metric
    # (floor(K/2) periods each, middle cycle skipped when K is odd).
    half_span = (k // 2) * period_s
    first = (st >= start) & (st <= start + half_span)
    second = (st >= end - half_span) & (st <= end)
    if np.count_nonzero(first) >= 2 and np.count_nonzero(second) >= 2:
        ptp1 = float(np.max(scl[first]) - np.min(scl[first]))
        ptp2 = float(np.max(scl[second]) - np.min(scl[second]))
        # Additive floor as in the steady guard: machine-flat channels must
        # not trip the ratio on a ~0 denominator.
        if ptp2 > OSCILLATING_AMPLITUDE_GROWTH_MAX * ptp1 + 1e-4 * drift_scale:
            growth = ptp2 / ptp1 if ptp1 > 0 else float("inf")
            return False, (
                f"oscillation amplitude growing (x{growth:.2f} second-half vs first-half "
                f"peak-to-peak, > x{OSCILLATING_AMPLITUDE_GROWTH_MAX:g} guard)"
            )
    return True, trend_reason


def period_window_stats(
    times: "np.ndarray | list[float]",
    cl: "np.ndarray | list[float]",
    cd: "np.ndarray | list[float]",
    cm: "np.ndarray | list[float]",
    period_s: float,
    drift_tolerance: float = 0.05,
    *,
    established_oscillation: bool = False,
    period_stable: bool = True,
) -> PeriodWindowStats | None:
    """Stats over exactly K = floor(available periods) whole periods ending at
    the last sample: time-weighted trapezoidal mean/std (non-uniform dt, so an
    integer-period window yields phase-bias-free means) plus min/max, and the
    stationarity verdict |mean(first half) - mean(second half)| /
    max(|mean(cl)|, retained cl rms, DRIFT_ABS_FLOOR) on Cl. The halves are
    whole-period halves (floor(K/2) periods each, middle
    period skipped when K is odd) so the drift metric itself carries no
    half-period phase bias.

    ``established_oscillation=True`` (precalc fidelity tier) replaces the
    drift-tolerance verdict with the ESTABLISHED-OSCILLATION test
    (:func:`_established_oscillation_verdict`): trendless per-cycle means +
    stable period (``period_stable``, the caller's half-window period check) +
    bounded amplitude. ``drift_frac`` is still computed and reported either
    way; the default keeps the strict full-tier gate byte-identical.

    Pass the POST-DISCARD series; ``periods_retained`` is the fractional
    number of periods it spans. Returns None when less than one whole period
    is available or the period is invalid.
    """
    t, wcl, wcd, wcm = _normalise_series(times, cl, cd, cm)
    if t.size < 4 or not math.isfinite(period_s) or period_s <= 0:
        return None
    first = float(t[0])
    end = float(t[-1])
    if end <= first:
        return None
    available = (end - first) / period_s
    k = math.floor(available + 1e-9)
    if k < 1:
        return None
    start = end - k * period_s
    window = PeriodWindow(start=start, end=end, cycles=k, period_s=period_s)
    st, scl, scd, scm = _window_series(t, wcl, wcd, wcm, window)

    def channel(values: np.ndarray) -> ChannelWindowStats:
        mean, std = _time_weighted_mean_std(st, values)
        return ChannelWindowStats(
            mean=float(mean), std=float(std), min=float(np.min(values)), max=float(np.max(values))
        )

    cl_stats = channel(scl)
    cd_stats = channel(scd)
    cm_stats = channel(scm)

    half = k // 2
    if half >= 1:
        m1 = _windowed_mean(st, scl, start, start + half * period_s)
        m2 = _windowed_mean(st, scl, end - half * period_s, end)
    else:
        mid = 0.5 * (start + end)
        m1 = _windowed_mean(st, scl, start, mid)
        m2 = _windowed_mean(st, scl, mid, end)
    # Denominator floor: judge the drift against the LARGEST honest scale of
    # the signal — |mean|, the retained oscillation rms, or the absolute floor.
    # This keeps alpha~0 symmetric cases (mean cl ~ 0) judgeable instead of
    # auto-failing on a near-zero denominator, while a genuinely drifting
    # near-zero signal still fails via the rms/absolute-floor scale.
    drift_scale = max(abs(cl_stats.mean), abs(cl_stats.std), DRIFT_ABS_FLOOR)
    drift = abs(m1 - m2) / drift_scale

    # Per-cycle Cl means over the K whole periods (integer-cycle sub-windows
    # of the stats window): the established-oscillation evidence, and the
    # scatter disclosed by the precalc acceptance warning.
    boundaries = [start + i * period_s for i in range(k)] + [end]
    cycle_means = tuple(
        _windowed_mean(st, scl, boundaries[i], boundaries[i + 1]) for i in range(k)
    )
    cycle_mean_std = float(np.std(np.asarray(cycle_means))) if k > 1 else 0.0

    if established_oscillation:
        stationary, reason = _established_oscillation_verdict(
            st, scl, start, end, period_s, k, cycle_means, drift_scale, period_stable
        )
    else:
        stationary, reason = bool(drift <= drift_tolerance), ""

    return PeriodWindowStats(
        period_s=float(period_s),
        periods_retained=float(available),
        whole_periods=int(k),
        window_start=float(start),
        window_end=float(end),
        cl=cl_stats,
        cd=cd_stats,
        cm=cm_stats,
        drift_frac=float(drift),
        stationary=bool(stationary),
        cycle_means=cycle_means,
        cycle_mean_std=cycle_mean_std,
        stationary_reason=reason,
    )


def frame_target_times(
    window_end: float,
    period_s: float,
    whole_periods: int,
    frames_per_period: float = FRAME_EXPORT_FRAMES_PER_PERIOD,
    max_frames: int = FRAME_EXPORT_MAX_FRAMES,
    span_periods: int = FRAME_EXPORT_SPAN_PERIODS,
    written_times: Sequence[float] | None = None,
) -> list[float]:
    """Target frame times for the frame player.

    When real written VTU times are supplied, every written state inside the
    LAST min(``span_periods``, K) whole-period window is exported up to
    ``max_frames``. Dense written windows are capped evenly. Without written
    times, fall back to a synthetic ``frames_per_period`` cadence. The window
    start itself is excluded so the phase coverage is uniform (no duplicated
    endpoint phase)."""
    if not math.isfinite(period_s) or period_s <= 0 or whole_periods < 1:
        return []
    p = max(1, min(int(span_periods), int(whole_periods)))
    span = p * period_s
    start = window_end - span
    if written_times is not None:
        eps = max(abs(window_end), abs(period_s), 1.0) * 1e-9
        written: list[float] = []
        for raw in written_times:
            try:
                t = float(raw)
            except (TypeError, ValueError):
                continue
            if math.isfinite(t) and t > start + eps and t <= window_end + eps:
                written.append(t)
        written.sort()
        if written:
            return _evenly_capped_times(written, int(max_frames))
    n = int(round(frames_per_period * p))
    n = max(2, min(int(max_frames), n))
    step = span / n
    return [window_end - span + (j + 1) * step for j in range(n)]


def frame_coefficients(
    frame_times: Sequence[float],
    times: "np.ndarray | list[float]",
    cl: "np.ndarray | list[float]",
    cd: "np.ndarray | list[float]",
    cm: "np.ndarray | list[float]",
) -> list[tuple[int, float, float, float, float]]:
    """Per-frame (i, t, cl, cd, cm): coefficients linearly interpolated from
    the coefficient.dat series at each frame's exact physical time."""
    t, vcl, vcd, vcm = _normalise_series(times, cl, cd, cm)
    if t.size == 0:
        return []
    out: list[tuple[int, float, float, float, float]] = []
    for i, ft in enumerate(frame_times):
        ftf = float(ft)
        out.append(
            (
                i,
                ftf,
                float(np.interp(ftf, t, vcl)),
                float(np.interp(ftf, t, vcd)),
                float(np.interp(ftf, t, vcm)),
            )
        )
    return out


# Below this relative fluctuation the transient force signal is treated as
# steady: a symmetric airfoil at alpha~0 (or any weakly-loaded point) sheds no
# vortices, so the pimpleFoam history is a flat line plus numerical noise. The
# FFT of that noise can still report a spurious "shedding" peak, so amplitude —
# not the presence of a frequency bin — is the honest no-shedding signal.
NO_SHEDDING_REL_TOL = 5e-3
# Absolute fluctuation floor for near-zero-load cases (e.g. cl_mean ~= 0), so a
# genuinely flat lift signal whose mean is ~0 is still classified as steady
# rather than being judged only against its own (tiny) mean.
NO_SHEDDING_ABS_FLOOR = 1e-3
# A physical no-shedding verdict must observe more than a pair of points.  This
# is deliberately the same floor carried by the cross-runtime certificate: a
# sparse, apparently flat trace cannot demonstrate that a slow wake is absent.
NO_SHEDDING_MIN_SAMPLE_COUNT = 20
# The slow edge of the physically plausible shedding band is the one a flat
# trace must rule out.  Keep the small margin beyond two complete periods so a
# boundary sample cannot turn an exactly-two-period observation into a verdict.
NO_SHEDDING_MIN_SLOW_PERIODS = 2.1


def no_shedding_min_observation_s(speed: float, chord: float) -> float:
    """Physical slow-wake horizon required before a flat URANS trace can pass.

    The policy belongs with the unsteady reducer rather than with one caller:
    live results and authenticated archive reductions must use the same
    ``2.1 * c / (St_low * U)`` horizon.  Invalid physical inputs deliberately
    return infinity so every caller fails closed.
    """
    try:
        u = float(speed)
        c = float(chord)
    except (TypeError, ValueError):
        return math.inf
    slow_st = float(SHEDDING_STROUHAL_BAND[0])
    if not (
        math.isfinite(u)
        and math.isfinite(c)
        and math.isfinite(slow_st)
        and u > 0
        and c > 0
        and slow_st > 0
    ):
        return math.inf
    return NO_SHEDDING_MIN_SLOW_PERIODS * c / (slow_st * u)


def _no_shedding_from_stats(
    cl_mean: float,
    cl_rms: float,
    cd_mean: float,
    cd_rms: float,
    cm_mean: float,
    cm_rms: float,
    *,
    rel_tol: float = NO_SHEDDING_REL_TOL,
    abs_floor: float = NO_SHEDDING_ABS_FLOOR,
) -> bool:
    """All-channel amplitude verdict shared by raw and stored histories.

    A large lift coefficient must not mask a noisy moment coefficient.  Grade
    Cl, Cd, and Cm independently against their own mean plus the common
    near-zero absolute floor; each coefficient is a separately reported
    physical result and all must be quiet before calling a wake steady.
    """
    channels = (
        (cl_mean, cl_rms),
        (cd_mean, cd_rms),
        (cm_mean, cm_rms),
    )
    if not all(math.isfinite(value) for pair in channels for value in pair):
        return False
    return all(
        abs(rms) <= max(rel_tol * abs(mean), abs_floor)
        for mean, rms in channels
    )


def is_no_shedding(
    history: "ForceHistory | None",
    rel_tol: float = NO_SHEDDING_REL_TOL,
    abs_floor: float = NO_SHEDDING_ABS_FLOOR,
) -> bool:
    """True when a transient force history shows no meaningful vortex shedding.

    The case is non-shedding when the retained lift and drag oscillations are
    negligible relative to the signal magnitude (with an absolute floor for
    near-zero-load cases). Such a URANS run is physically steady, so its
    time-averaged coefficients — not a periodic analysis — are the answer.

    Requires real force data: an absent/empty history is *not* classified as
    no-shedding (that is an honest failure, handled by the caller), because
    there is nothing to average.
    """
    if history is None or history.samples < NO_SHEDDING_MIN_SAMPLE_COUNT:
        return False
    channels = (history.t, history.cl, history.cd, history.cm)
    if (
        len(history.t) < NO_SHEDDING_MIN_SAMPLE_COUNT
        or any(len(channel) != len(history.t) for channel in channels)
    ):
        return False
    return _no_shedding_from_stats(
        history.cl_mean,
        history.cl_rms,
        history.cd_mean,
        history.cd_rms,
        history.cm_mean,
        history.cm_rms,
        rel_tol=rel_tol,
        abs_floor=abs_floor,
    )


def force_history(
    path: "Path | Sequence[Path]",
    speed: float,
    chord: float,
    discard_fraction: float = 0.4,
    max_points: int = 400,
    target_cycles: int = 7,
    alpha_deg: float | None = None,
    section_thickness_ratio: float | None = None,
    observation_start_time: float | None = None,
    preserve_observation_window: bool = False,
) -> ForceHistory:
    """Extract the windowed Cl/Cd/Cm time series from a transient coefficient.dat,
    plus the measured shedding frequency and Strouhal number.

    Drops the first ``discard_fraction`` (startup) and downsamples to at most
    ``max_points`` for transport. ``observation_start_time`` may additionally
    pin an exact physical-time boundary; that boundary is interpolated between
    real adjacent coefficient samples so an adaptive timestep cannot shorten a
    required observation horizon by one sample. When
    ``preserve_observation_window`` is true, period detection is still
    measured but the returned samples/statistics retain the complete selected
    observation instead of the trailing integer-period publication window.
    This is used by the independent steady-vs-shedding amplitude gate.
    """
    t_all, cl_all, cd_all, cm_all = _coefficient_series(path)
    if t_all.size == 0:
        raise ValueError(f"No usable coefficient data found in {path}")
    start_time = float(t_all[0])
    if discard_fraction > 0 and t_all[-1] > t_all[0]:
        start_time = float(t_all[0]) + min(max(discard_fraction, 0.0), 0.999999) * float(t_all[-1] - t_all[0])
    if observation_start_time is not None:
        try:
            explicit_start = float(observation_start_time)
        except (TypeError, ValueError):
            explicit_start = math.inf
        if math.isfinite(explicit_start):
            start_time = max(start_time, explicit_start)
    if start_time > float(t_all[0]) and start_time < float(t_all[-1]):
        t_a, cl_a, cd_a, cm_a = _window_series(
            t_all,
            cl_all,
            cd_all,
            cm_all,
            PeriodWindow(
                start=start_time,
                end=float(t_all[-1]),
                cycles=0,
                period_s=0.0,
            ),
        )
    else:
        mask = t_all >= start_time
        t_a, cl_a, cd_a, cm_a = t_all[mask], cl_all[mask], cd_all[mask], cm_all[mask]
    if t_a.size == 0:
        raise ValueError(f"No usable coefficient data found in {path}")

    # Decide amplitude-flat/no-shedding from the FULL post-discard observation
    # before period extraction. A tiny numerical ripple can have a perfectly
    # credible in-band FFT line; period-windowing that ripple first used to crop
    # a physically sufficient 4.3 s observation to the last three spurious
    # cycles (~1.5 s), making the slow-shedding safety floor impossible to
    # satisfy. A flat trace owns the whole retained span and no invented period.
    full_cl_mean, full_cl_rms = _time_weighted_mean_std(t_a, cl_a)
    full_cd_mean, full_cd_rms = _time_weighted_mean_std(t_a, cd_a)
    full_cm_mean, full_cm_rms = _time_weighted_mean_std(t_a, cm_a)
    amplitude_flat = _no_shedding_from_stats(
        full_cl_mean,
        full_cl_rms,
        full_cd_mean,
        full_cd_rms,
        full_cm_mean,
        full_cm_rms,
    )
    # The configured discard is not evidence that an oscillating wake has
    # settled.  A high-Courant startup burst can extend beyond that elapsed-time
    # boundary and poison period detection even when the final wake owns many
    # clean cycles.  Preserve the complete observation for genuinely flat
    # wakes: their physical no-shedding horizon must never be shortened by a
    # tiny, spectrally credible numerical ripple.
    if not amplitude_flat and not preserve_observation_window:
        clean_tail = clean_periodic_tail(
            t_a,
            cl_a,
            cd_a,
            cm_a,
            speed=speed,
            chord=chord,
            required_cycles=max(
                float(target_cycles),
                2.0 * PERIOD_ESTIMATE_MIN_CYCLES + 0.5,
            ),
            alpha_deg=alpha_deg,
            section_thickness_ratio=section_thickness_ratio,
        )
        if clean_tail is not None:
            t_a, cl_a, cd_a, cm_a = clean_tail.series
            full_cl_mean, full_cl_rms = _time_weighted_mean_std(t_a, cl_a)
            full_cd_mean, full_cd_rms = _time_weighted_mean_std(t_a, cd_a)
            full_cm_mean, full_cm_rms = _time_weighted_mean_std(t_a, cm_a)
    if amplitude_flat:
        freq = 0.0
        st = 0.0
        period = None
        window = None
        wt, wcl, wcd, wcm = t_a, cl_a, cd_a, cm_a
        cl_mean, cl_rms = full_cl_mean, full_cl_rms
        cd_mean, cd_rms = full_cd_mean, full_cd_rms
        cm_mean, cm_rms = full_cm_mean, full_cm_rms
    else:
        # Physical band constraint: the FFT peak search is restricted to the
        # plausible shedding window for this flow (St in
        # SHEDDING_STROUHAL_BAND), so history.strouhal / period_s — the
        # quality-evaluation period chain — can never lock onto a low-frequency
        # sub-harmonic of a broadband post-stall signal. Without speed/chord the
        # band is None (legacy search).
        freq = dominant_frequency(
            t_a,
            cl_a,
            freq_band=shedding_frequency_band(
                speed,
                chord,
                alpha_deg=alpha_deg,
                section_thickness_ratio=section_thickness_ratio,
            ),
        )
        st = strouhal(freq, chord, speed)
        period = (
            chord / (st * speed)
            if st > 0 and speed > 0 and chord > 0
            else None
        )
        if preserve_observation_window:
            window = None
            wt, wcl, wcd, wcm = t_a, cl_a, cd_a, cm_a
            cl_mean, cl_rms = full_cl_mean, full_cl_rms
            cd_mean, cd_rms = full_cd_mean, full_cd_rms
            cm_mean, cm_rms = full_cm_mean, full_cm_rms
        else:
            window = (
                integer_period_window(
                    t_a,
                    period,
                    discard_fraction=0.0,
                    target_cycles=target_cycles,
                )
                if period
                else None
            )
            wt, wcl, wcd, wcm = _window_series(t_a, cl_a, cd_a, cm_a, window)
            cl_mean, cl_rms = _time_weighted_mean_std(wt, wcl)
            cd_mean, cd_rms = _time_weighted_mean_std(wt, wcd)
            cm_mean, cm_rms = _time_weighted_mean_std(wt, wcm)
    return ForceHistory(
        t=_downsample(wt.tolist(), max_points),
        cl=_downsample(wcl.tolist(), max_points),
        cd=_downsample(wcd.tolist(), max_points),
        cm=_downsample(wcm.tolist(), max_points),
        cl_mean=cl_mean,
        cl_rms=cl_rms,
        cd_mean=cd_mean,
        cd_rms=cd_rms,
        cm_mean=cm_mean,
        cm_rms=cm_rms,
        shedding_freq_hz=freq,
        strouhal=st,
        samples=int(wt.size),
        period_s=period,
        retained_cycles=window.cycles if window else None,
        window_start=window.start if window else float(wt[0]),
        window_end=window.end if window else float(wt[-1]),
    )
