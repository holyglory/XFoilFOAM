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
