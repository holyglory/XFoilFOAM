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

from .forces import _data_rows


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


def dominant_frequency(times: "np.ndarray | list[float]", values: "np.ndarray | list[float]") -> float:
    """Dominant oscillation frequency [Hz] of a (possibly non-uniformly sampled)
    signal, via the peak of its FFT magnitude (DC excluded).

    pimpleFoam uses an adaptive time step, so the samples are resampled onto a
    uniform grid (linear interpolation) before the FFT.
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
    k = 1 + int(np.argmax(spec[1:]))  # skip the DC bin
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

    freq = dominant_frequency(t, cl)
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
#: Frame-export cadence pinned by the contract: ~24 frames/period ...
FRAME_EXPORT_FRAMES_PER_PERIOD = 24.0
#: ... over the last min(3, K) whole periods ...
FRAME_EXPORT_SPAN_PERIODS = 3
#: ... capped at 120 frames total.
FRAME_EXPORT_MAX_FRAMES = 120


def measure_period(
    times: "np.ndarray | list[float]",
    values: "np.ndarray | list[float]",
    min_cycles: float = 2.0,
    corr_threshold: float = 0.2,
) -> float | None:
    """Shedding period [s] measured by AUTOCORRELATION of the (uniformly
    resampled, demeaned) signal — robust for noisy periodic force histories
    where zero crossings jitter and an FFT bin can land between peaks.

    Returns None when no credible period exists: flat/short signals, no
    positive autocorrelation peak past the first zero crossing, or fewer than
    ``min_cycles`` cycles of data. The peak lag is refined by parabolic
    interpolation of the autocorrelation maximum.
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
    below = np.where(ac < 0)[0]
    if below.size == 0:
        return None
    first_negative = int(below[0])
    if first_negative >= n - 1:
        return None
    k = first_negative + int(np.argmax(ac[first_negative:]))
    if k <= 0 or k >= n - 1 or float(ac[k]) < corr_threshold:
        return None
    y0, y1, y2 = float(ac[k - 1]), float(ac[k]), float(ac[k + 1])
    denom = y0 - 2.0 * y1 + y2
    shift = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-12 else 0.0
    shift = min(0.5, max(-0.5, shift))
    dt = (float(tu[-1]) - float(tu[0])) / (n - 1)
    period = (k + shift) * dt
    span = float(t[-1]) - float(t[0])
    if not math.isfinite(period) or period <= 0 or span < min_cycles * period:
        return None
    return float(period)


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
    """Integer-period window stats backing the frame_track contract."""

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


def _windowed_mean(t: np.ndarray, v: np.ndarray, a: float, b: float) -> float:
    """Time-weighted trapezoidal mean of v over [a, b] with interpolated ends."""
    interior = (t > a) & (t < b)
    tt = np.concatenate(([a], t[interior], [b]))
    vv = np.concatenate(([np.interp(a, t, v)], v[interior], [np.interp(b, t, v)]))
    mean, _std = _time_weighted_mean_std(tt, vv)
    return mean


def period_window_stats(
    times: "np.ndarray | list[float]",
    cl: "np.ndarray | list[float]",
    cd: "np.ndarray | list[float]",
    cm: "np.ndarray | list[float]",
    period_s: float,
    drift_tolerance: float = 0.05,
) -> PeriodWindowStats | None:
    """Stats over exactly K = floor(available periods) whole periods ending at
    the last sample: time-weighted trapezoidal mean/std (non-uniform dt, so an
    integer-period window yields phase-bias-free means) plus min/max, and the
    stationarity verdict |mean(first half) - mean(second half)| /
    max(|mean(cl)|, retained cl rms, DRIFT_ABS_FLOOR) on Cl. The halves are
    whole-period halves (floor(K/2) periods each, middle
    period skipped when K is odd) so the drift metric itself carries no
    half-period phase bias.

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
        stationary=bool(drift <= drift_tolerance),
    )


def frame_target_times(
    window_end: float,
    period_s: float,
    whole_periods: int,
    frames_per_period: float = FRAME_EXPORT_FRAMES_PER_PERIOD,
    max_frames: int = FRAME_EXPORT_MAX_FRAMES,
    span_periods: int = FRAME_EXPORT_SPAN_PERIODS,
) -> list[float]:
    """Target frame times: ~``frames_per_period`` per period over the LAST
    min(``span_periods``, K) whole periods, ending exactly at ``window_end``,
    capped at ``max_frames``. The window start itself is excluded so the phase
    coverage is uniform (no duplicated endpoint phase)."""
    if not math.isfinite(period_s) or period_s <= 0 or whole_periods < 1:
        return []
    p = max(1, min(int(span_periods), int(whole_periods)))
    n = int(round(frames_per_period * p))
    n = max(2, min(int(max_frames), n))
    span = p * period_s
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
    fluctuation = max(abs(history.cl_rms), abs(history.cd_rms))
    scale = abs(history.cl_mean) + abs(history.cd_mean)
    threshold = max(rel_tol * scale, abs_floor)
    return fluctuation <= threshold


def force_history(
    path: "Path | Sequence[Path]",
    speed: float,
    chord: float,
    discard_fraction: float = 0.4,
    max_points: int = 400,
    target_cycles: int = 7,
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

    freq = dominant_frequency(t_a, cl_a)
    st = strouhal(freq, chord, speed)
    period = chord / (st * speed) if st > 0 and speed > 0 and chord > 0 else None
    window = integer_period_window(t_a, period, discard_fraction=0.0, target_cycles=target_cycles) if period else None
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
