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


def _coefficient_series(path: Path) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
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
    path: Path,
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


def force_history(
    path: Path,
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
