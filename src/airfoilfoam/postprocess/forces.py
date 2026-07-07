"""Parse OpenFOAM forceCoeffs and yPlus function-object output."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class ForceCoefficients:
    cl: float
    cd: float
    cm: float

    @property
    def cl_cd(self) -> Optional[float]:
        return self.cl / self.cd if self.cd not in (0.0, None) else None


def _data_rows(path: Path) -> tuple[list[str], list[list[float]]]:
    header: list[str] = []
    rows: list[list[float]] = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("#"):
            stripped = line.lstrip("#").strip()
            tokens = stripped.replace("\t", " ").split()
            if "Cl" in tokens and "Cd" in tokens:
                header = tokens
            continue
        parts = line.replace("\t", " ").split()
        try:
            rows.append([float(p) for p in parts])
        except ValueError:
            continue
    return header, rows


def parse_force_coefficients(path: Path, average_last: int = 50) -> ForceCoefficients:
    """Read coefficient.dat and return Cl, Cd, Cm averaged over the last rows."""
    header, rows = _data_rows(path)
    if not rows:
        raise ValueError(f"No coefficient data found in {path}")
    if not header:
        # Fallback to the documented column order (v2406).
        header = [
            "Time", "Cd", "Cd(f)", "Cd(r)", "Cl", "Cl(f)", "Cl(r)",
            "CmPitch", "CmRoll", "CmYaw", "Cs", "Cs(f)", "Cs(r)",
        ]
    idx = {name: i for i, name in enumerate(header)}
    cm_key = "CmPitch" if "CmPitch" in idx else ("Cm" if "Cm" in idx else None)

    sample = rows[-average_last:] if average_last > 0 else rows
    n = len(sample)

    def col(name: str) -> float:
        i = idx[name]
        return sum(r[i] for r in sample if len(r) > i) / n

    cl = col("Cl")
    cd = col("Cd")
    cm = col(cm_key) if cm_key else 0.0
    return ForceCoefficients(cl=cl, cd=cd, cm=cm)


@dataclass
class AveragedCoefficients:
    cl: float
    cd: float
    cm: float
    cl_std: float
    cd_std: float
    cm_std: float
    samples: int

    @property
    def cl_cd(self) -> Optional[float]:
        return self.cl / self.cd if self.cd not in (0.0, None) else None


def _mean_std(values: list[float]) -> tuple[float, float]:
    n = len(values)
    mean = sum(values) / n
    var = sum((v - mean) ** 2 for v in values) / n
    return mean, var**0.5


def time_averaged_coefficients(path: Path, discard_fraction: float = 0.4) -> AveragedCoefficients:
    """Time-average Cl/Cd/Cm over the statistically-stationary tail of a transient run.

    Drops the first ``discard_fraction`` of rows (startup transient) and returns the
    mean and standard deviation of the remainder.
    """
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

    start = int(len(rows) * discard_fraction)
    sample = rows[start:] or rows[-1:]

    def col(name: str) -> list[float]:
        i = idx[name]
        return [r[i] for r in sample if len(r) > i]

    cl_m, cl_s = _mean_std(col("Cl"))
    cd_m, cd_s = _mean_std(col("Cd"))
    if cm_key:
        cm_m, cm_s = _mean_std(col(cm_key))
    else:
        cm_m, cm_s = 0.0, 0.0
    return AveragedCoefficients(
        cl=cl_m, cd=cd_m, cm=cm_m, cl_std=cl_s, cd_std=cd_s, cm_std=cm_s, samples=len(sample)
    )


def force_is_steady(path: Path, window: int = 200, tol: float = 2.5e-3) -> bool:
    """True if Cl and Cd have stopped changing over the last ``window`` iterations.

    A pragmatic convergence test for steady airfoil RANS, where the residual norm
    often plateaus above the target while the integrated forces are already steady.
    Uses the peak-to-peak spread of the last window, normalised by |mean| (plus a
    small floor), for both Cl and Cd.
    """
    header, rows = _data_rows(path)
    if len(rows) < window + 5:
        return False
    if not header:
        header = ["Time", "Cd", "Cd(f)", "Cd(r)", "Cl"]
    idx = {name: i for i, name in enumerate(header)}
    sample = rows[-window:]

    def spread(name: str) -> float:
        i = idx[name]
        vals = [r[i] for r in sample if len(r) > i]
        if not vals:
            return 1.0
        mean = sum(vals) / len(vals)
        return (max(vals) - min(vals)) / (abs(mean) + 1e-3)

    return spread("Cl") < tol and spread("Cd") < tol


# --------------------------------------------------------------------------- #
# Oscillating-steady averaging (task #30, R1). A steady SIMPLE solve that
# never meets pointwise convergence but settles into a BOUNDED force
# oscillation (classic mildly-separated behaviour) is physically answerable:
# the window mean over the last N iterations is the point value. Detection is
# deliberately conservative — a drifting mean, a growing amplitude, or an
# oscillation larger than the signal scale all stay on the not-converged
# escalation path.
# --------------------------------------------------------------------------- #

#: Relative agreement required between the two half-window means (per channel).
OSCILLATING_MEAN_REL_TOL = 0.02
#: Bounded-amplitude ceiling: window peak-to-peak / scale beyond this is not
#: honestly "steady with a ripple" — it escalates to URANS instead.
OSCILLATING_AMPLITUDE_REL_MAX = 2.0
#: Bounded-amplitude growth guard: the second half-window's peak-to-peak may
#: not exceed the first's by more than this factor (a growing oscillation is
#: divergence in progress, not a limit cycle).
OSCILLATING_AMPLITUDE_GROWTH_MAX = 1.3
#: Absolute floor of the per-channel scale so near-zero-mean channels (Cl at
#: alpha~0, Cm) stay judgeable (same rationale as unsteady.DRIFT_ABS_FLOOR).
OSCILLATING_SCALE_FLOOR = 0.05


@dataclass
class SteadyOscillationAnalysis:
    """Verdict + full (downsampled) history of the oscillating-steady detector."""

    iterations: list[int]
    cl: list[float]
    cd: list[float]
    cm: list[float]
    window_start_iter: int
    window_end_iter: int
    mean_stable: bool
    note: str
    cl_mean: float
    cd_mean: float
    cm_mean: float
    cl_half_amplitude: float
    cd_half_amplitude: float


def _downsample_indices(n: int, max_points: int) -> list[int]:
    if n <= max_points:
        return list(range(n))
    step = (n - 1) / (max_points - 1)
    return sorted({round(i * step) for i in range(max_points)})


def analyze_steady_oscillation(
    path: Path,
    window: int = 400,
    max_samples: int = 2000,
    mean_rel_tol: float = OSCILLATING_MEAN_REL_TOL,
    amplitude_rel_max: float = OSCILLATING_AMPLITUDE_REL_MAX,
    amplitude_growth_max: float = OSCILLATING_AMPLITUDE_GROWTH_MAX,
    scale_floor: float = OSCILLATING_SCALE_FLOOR,
) -> Optional[SteadyOscillationAnalysis]:
    """Judge a non-converged steady coefficient.dat for bounded-oscillation
    acceptance and return its ENTIRE iteration history (downsampled to
    ``max_samples``) for the steady_history contract.

    Acceptance (``mean_stable``) requires, on the last ``window`` iterations,
    for BOTH Cl and Cd:
      - the two half-window means agree within ``mean_rel_tol`` of the channel
        scale max(|window mean|, ``scale_floor``);
      - window peak-to-peak / scale <= ``amplitude_rel_max``;
      - second-half peak-to-peak <= ``amplitude_growth_max`` x first-half
        peak-to-peak (bounded, non-growing oscillation).

    Returns None when the file holds no usable coefficient rows.
    """
    header, rows = _data_rows(path)
    if not rows:
        return None
    if not header:
        header = [
            "Time", "Cd", "Cd(f)", "Cd(r)", "Cl", "Cl(f)", "Cl(r)",
            "CmPitch", "CmRoll", "CmYaw", "Cs", "Cs(f)", "Cs(r)",
        ]
    idx = {name: i for i, name in enumerate(header)}
    if "Cl" not in idx or "Cd" not in idx:
        return None
    cm_key = "CmPitch" if "CmPitch" in idx else ("Cm" if "Cm" in idx else None)
    time_i = idx.get("Time")

    rows = [r for r in rows if len(r) > max(idx["Cl"], idx["Cd"], idx.get(cm_key, 0) if cm_key else 0)]
    if not rows:
        return None
    iterations = [
        int(round(r[time_i])) if time_i is not None and len(r) > time_i else k
        for k, r in enumerate(rows)
    ]
    cl = [r[idx["Cl"]] for r in rows]
    cd = [r[idx["Cd"]] for r in rows]
    cm = [r[idx[cm_key]] for r in rows] if cm_key else [0.0] * len(rows)

    n = len(rows)
    win = min(max(2, int(window)), n)
    w_cl, w_cd, w_cm = cl[-win:], cd[-win:], cm[-win:]
    window_start_iter, window_end_iter = iterations[-win], iterations[-1]

    def judge(values: list[float]) -> tuple[bool, str, float, float]:
        """(bounded_and_stable, failure reason, window mean, half amplitude)."""
        half = len(values) // 2
        first, second = values[:half], values[half:]
        w_mean = sum(values) / len(values)
        scale = max(abs(w_mean), scale_floor)
        m1 = sum(first) / len(first)
        m2 = sum(second) / len(second)
        mean_delta = abs(m1 - m2) / scale
        ptp = max(values) - min(values)
        ptp1 = max(first) - min(first)
        ptp2 = max(second) - min(second)
        if mean_delta > mean_rel_tol:
            return False, f"half-window means differ by {mean_delta:.1%} (> {mean_rel_tol:.0%})", w_mean, ptp / 2.0
        if ptp / scale > amplitude_rel_max:
            return (
                False,
                f"oscillation amplitude {ptp / scale:.2f}x the signal scale (> {amplitude_rel_max:g}x)",
                w_mean,
                ptp / 2.0,
            )
        # The additive floor keeps machine-noise-flat channels (ptp ~ 1e-9)
        # from tripping the growth ratio on a ~0 denominator; any physically
        # meaningful growing oscillation dwarfs 1e-4 x scale.
        if ptp2 > amplitude_growth_max * ptp1 + 1e-4 * scale:
            growth = ptp2 / ptp1 if ptp1 > 0 else float("inf")
            return False, f"oscillation amplitude growing (x{growth:.2f})", w_mean, ptp / 2.0
        return True, "", w_mean, ptp / 2.0

    cl_ok, cl_why, cl_mean, cl_amp = judge(w_cl)
    cd_ok, cd_why, cd_mean, cd_amp = judge(w_cd)
    cm_mean = sum(w_cm) / len(w_cm)

    short = n < int(window)
    mean_stable = cl_ok and cd_ok and not short
    if mean_stable:
        note = (
            f"converged (oscillating steady, averaged over last {win} iterations; "
            f"amplitude ±{cl_amp:.3g} Cl, ±{cd_amp:.3g} Cd)"
        )
    else:
        reasons = []
        if short:
            reasons.append(f"only {n} of {int(window)} required iterations recorded")
        if not cl_ok:
            reasons.append(f"Cl {cl_why}")
        if not cd_ok:
            reasons.append(f"Cd {cd_why}")
        note = "steady oscillation not accepted: " + "; ".join(reasons)

    keep = _downsample_indices(n, max(2, int(max_samples)))
    return SteadyOscillationAnalysis(
        iterations=[iterations[i] for i in keep],
        cl=[float(cl[i]) for i in keep],
        cd=[float(cd[i]) for i in keep],
        cm=[float(cm[i]) for i in keep],
        window_start_iter=int(window_start_iter),
        window_end_iter=int(window_end_iter),
        mean_stable=mean_stable,
        note=note,
        cl_mean=float(cl_mean),
        cd_mean=float(cd_mean),
        cm_mean=float(cm_mean),
        cl_half_amplitude=float(cl_amp),
        cd_half_amplitude=float(cd_amp),
    )


def parse_y_plus(path: Path) -> tuple[Optional[float], Optional[float]]:
    """Return (average, max) y+ for the airfoil patch from a yPlus.dat file."""
    avg: Optional[float] = None
    ymax: Optional[float] = None
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.replace("\t", " ").split()
        # columns: Time patch min max average
        if len(parts) >= 5:
            try:
                ymax = float(parts[3])
                avg = float(parts[4])
            except ValueError:
                continue
    return avg, ymax
