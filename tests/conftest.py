"""Shared test fixtures. Sets up an isolated data dir before importing the app."""
from __future__ import annotations

import os
import tempfile

# Must be set before airfoilfoam.config.get_settings() is first called.
_TMP = tempfile.mkdtemp(prefix="airfoilfoam-tests-")
os.environ.setdefault("AIRFOILFOAM_DATA_DIR", _TMP)
# Eager Celery never connects to the broker, but the URL must be a valid scheme.
os.environ.setdefault("AIRFOILFOAM_REDIS_URL", "redis://localhost:6379/0")

import numpy as np  # noqa: E402
import pytest  # noqa: E402


def naca4(code: str = "0012", n: int = 120) -> np.ndarray:
    """Generate NACA 4-digit coordinates in Selig order (TE -> top -> LE -> bottom -> TE)."""
    m = int(code[0]) / 100
    p = int(code[1]) / 10
    t = int(code[2:]) / 100
    beta = np.linspace(0, np.pi, n + 1)
    x = 0.5 * (1 - np.cos(beta))
    yt = 5 * t * (0.2969 * np.sqrt(x) - 0.1260 * x - 0.3516 * x**2 + 0.2843 * x**3 - 0.1015 * x**4)
    if m == 0:
        yc = np.zeros_like(x)
        dyc = np.zeros_like(x)
    else:
        yc = np.where(x < p, m / p**2 * (2 * p * x - x**2),
                      m / (1 - p) ** 2 * ((1 - 2 * p) + 2 * p * x - x**2))
        dyc = np.where(x < p, 2 * m / p**2 * (p - x), 2 * m / (1 - p) ** 2 * (p - x))
    th = np.arctan(dyc)
    xu, yu = x - yt * np.sin(th), yc + yt * np.cos(th)
    xl, yl = x + yt * np.sin(th), yc - yt * np.cos(th)
    xs = np.concatenate([xu[::-1], xl[1:]])
    ys = np.concatenate([yu[::-1], yl[1:]])
    return np.column_stack([xs, ys])


@pytest.fixture
def naca0012_selig_text() -> str:
    coords = naca4("0012", 100)
    lines = ["NACA 0012"]
    lines += [f"{x:.6f} {y:.6f}" for x, y in coords]
    return "\n".join(lines)


@pytest.fixture
def naca2412_points() -> list[tuple[float, float]]:
    return [tuple(p) for p in naca4("2412", 80)]


@pytest.fixture
def lednicer_text() -> str:
    """A small Lednicer-format file: header counts, upper LE->TE, blank, lower LE->TE."""
    return """My Airfoil
       3.       3.

       0.000000  0.000000
       0.500000  0.060000
       1.000000  0.000000

       0.000000  0.000000
       0.500000 -0.060000
       1.000000  0.000000
"""
