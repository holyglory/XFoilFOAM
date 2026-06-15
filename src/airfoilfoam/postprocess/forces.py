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
