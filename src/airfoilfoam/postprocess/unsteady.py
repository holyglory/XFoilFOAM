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


def _shedding_reference_length(chord: float, alpha_deg: "float | None") -> float:
    if alpha_deg is None:
        return chord
    try:
        sin_alpha = abs(math.sin(math.radians(float(alpha_deg))))
    except (TypeError, ValueError):
        return chord
    if not math.isfinite(sin_alpha) or sin_alpha <= SHEDDING_PROJECTED_HEIGHT_FLOOR:
        return chord
    return chord * sin_alpha


def shedding_period_band(
    speed: "float | None",
    chord: "float | None",
    st_band: tuple[float, float] = SHEDDING_STROUHAL_BAND,
    *,
    alpha_deg: "float | None" = None,
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
    length = _shedding_reference_length(c, alpha_deg)
    return (length / (hi * u), c / (lo * u))


def shedding_frequency_band(
    speed: "float | None",
    chord: "float | None",
    st_band: tuple[float, float] = SHEDDING_STROUHAL_BAND,
    *,
    alpha_deg: "float | None" = None,
) -> "tuple[float, float] | None":
    """Frequency-domain twin of :func:`shedding_period_band`: [St_min U / c,
    St_max U / H] in Hz, or None without flow context."""
    band = shedding_period_band(speed, chord, st_band, alpha_deg=alpha_deg)
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


def _coefficient_series(
    path: "Path | Sequence[Path]",
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Coefficient time series from one coefficient.dat, or MERGED from several
    restart segments (each pimpleFoam continuation writes its own
    ``postProcessing/forceCoeffs1/<startTime>/coefficient.dat``). Merging sorts
    by time and drops duplicate timestamps at the restart seams."""
    if isinstance(path, (list, tuple)):
        parts: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = []
        last_exc: Exception | None = None
        for p in path:
            try:
                parts.append(_coefficient_series_one(Path(p)))
            except (OSError, ValueError) as exc:  # in-flight segment may be header-only
                last_exc = exc
        if not parts:
            raise last_exc or ValueError("No coefficient data found (no segments)")
        merged = tuple(np.concatenate([part[k] for part in parts]) for k in range(4))
        return _normalise_series(*merged)
    return _coefficient_series_one(Path(path))


def coefficient_series(
    path: "Path | Sequence[Path]",
) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    """Public alias: (t, cl, cd, cm) arrays, merged across restart segments."""
    return _coefficient_series(path)


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
) -> StablePeriodResult:
    """Return an early-stop candidate when the final two periods are repeatable.

    Two periods are enough only when the final two force cycles are nearly the
    same phase shape and the retained field writes can animate them at the
    requested cadence. The result is deliberately conservative: missing period,
    sparse samples, shape drift, or too few field frames all keep the solver
    running.
    """
    if speed <= 0 or chord <= 0:
        return StablePeriodResult(ok=False, reason="invalid speed/chord")
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

    freq = dominant_frequency(
        t, cl, freq_band=shedding_frequency_band(speed, chord, alpha_deg=alpha_deg)
    )
    st = strouhal(freq, chord, speed)
    period = chord / (st * speed) if st > 0 else None
    if period is None or not math.isfinite(period) or period <= 0:
        return StablePeriodResult(ok=False, reason="no measurable shedding period")
    window = integer_period_window(t, period, discard_fraction=0.0, target_cycles=2)
    if window is None or window.cycles < 2:
        return StablePeriodResult(ok=False, reason="fewer than two measured periods", period_s=period)

    mid = window.start + period
    first_mask = (t >= window.start) & (t <= mid)
    second_mask = (t >= mid) & (t <= window.end)
    if int(first_mask.sum()) < min_samples_per_cycle or int(second_mask.sum()) < min_samples_per_cycle:
        return StablePeriodResult(
            ok=False,
            reason="not enough samples per period",
            period_s=period,
            window_start=window.start,
            window_end=window.end,
            cycles=2,
        )

    phase = np.linspace(0.0, period, max(8, phase_samples), endpoint=False)

    def compare(values: np.ndarray) -> tuple[float, float]:
        p1 = np.interp(window.start + phase, t, values)
        p2 = np.interp(mid + phase, t, values)
        combined = np.concatenate((p1, p2))
        amplitude = float(np.nanmax(combined) - np.nanmin(combined))
        scale = max(amplitude, abs(float(np.nanmean(combined))) * 0.05, 1e-9)
        nrms = float(np.sqrt(np.nanmean((p1 - p2) ** 2)) / scale)
        mean_drift = float(abs(np.nanmean(p1) - np.nanmean(p2)) / scale)
        return nrms, mean_drift

    cl_similarity, cl_drift = compare(cl)
    cd_similarity, cd_drift = compare(cd)
    similarity = max(cl_similarity, cd_similarity)
    mean_drift = max(cl_drift, cd_drift)
    stable = similarity <= similarity_tolerance and mean_drift <= mean_drift_tolerance

    frames = np.asarray(frame_times, dtype=float)
    frames = frames[np.isfinite(frames)]
    frame_count = int(((frames >= window.start) & (frames <= window.end)).sum())
    frames_per_cycle = frame_count / 2.0
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
    )
    if not stable:
        return replace(base, reason=f"periods differ: similarity {similarity:.3f}, mean drift {mean_drift:.3f}")
    if frames_per_cycle + 1e-9 < min_frames_per_cycle:
        return replace(base, reason=f"frames/cycle {frames_per_cycle:.2f} < {min_frames_per_cycle:.2f}")
    return replace(base, ok=True, reason="two stable periods with sufficient frames")


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
    band = shedding_period_band(speed, chord, alpha_deg=alpha_deg)
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


def _no_shedding_from_stats(
    cl_mean: float,
    cl_rms: float,
    cd_mean: float,
    cd_rms: float,
    *,
    rel_tol: float = NO_SHEDDING_REL_TOL,
    abs_floor: float = NO_SHEDDING_ABS_FLOOR,
) -> bool:
    """Amplitude-only no-shedding verdict shared by raw and stored histories."""
    fluctuation = max(abs(cl_rms), abs(cd_rms))
    scale = abs(cl_mean) + abs(cd_mean)
    threshold = max(rel_tol * scale, abs_floor)
    return fluctuation <= threshold


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
    if history is None or history.samples < 2 or len(history.t) < 2:
        return False
    return _no_shedding_from_stats(
        history.cl_mean,
        history.cl_rms,
        history.cd_mean,
        history.cd_rms,
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
) -> ForceHistory:
    """Extract the windowed Cl/Cd/Cm time series from a transient coefficient.dat,
    plus the measured shedding frequency and Strouhal number.

    Drops the first ``discard_fraction`` (startup) and downsamples to at most
    ``max_points`` for transport.
    """
    t_all, cl_all, cd_all, cm_all = _coefficient_series(path)
    if t_all.size == 0:
        raise ValueError(f"No usable coefficient data found in {path}")
    start_time = float(t_all[0])
    if discard_fraction > 0 and t_all[-1] > t_all[0]:
        start_time = float(t_all[0]) + min(max(discard_fraction, 0.0), 0.999999) * float(t_all[-1] - t_all[0])
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
    )
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
                speed, chord, alpha_deg=alpha_deg
            ),
        )
        st = strouhal(freq, chord, speed)
        period = (
            chord / (st * speed)
            if st > 0 and speed > 0 and chord > 0
            else None
        )
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
