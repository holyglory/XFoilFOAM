"""Airfoil geometry: parse Selig/Lednicer files, normalise, chord-align, resample.

The output is a chord-aligned, unit-chord airfoil with a *sharp* (closed) trailing
edge at (1, 0) and leading edge at (0, 0). Angle of attack is applied later by
rotating the freestream, so chord-aligning the geometry is the correct convention.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np

from .models import AirfoilFormat


def _numeric_pairs(text: str) -> list[tuple[float, float]]:
    pairs: list[tuple[float, float]] = []
    for line in text.splitlines():
        parts = line.replace(",", " ").split()
        if len(parts) < 2:
            continue
        try:
            x = float(parts[0])
            y = float(parts[1])
        except ValueError:
            continue
        pairs.append((x, y))
    return pairs


def _looks_like_lednicer_header(pair: tuple[float, float]) -> bool:
    """Lednicer files start (after the name) with two point counts, e.g. '61. 61.'."""
    x, y = pair
    return x > 1.5 and y > 1.5 and abs(x - round(x)) < 1e-6 and abs(y - round(y)) < 1e-6


def _detect_format(pairs: list[tuple[float, float]]) -> AirfoilFormat:
    if pairs and _looks_like_lednicer_header(pairs[0]):
        return AirfoilFormat.lednicer
    return AirfoilFormat.selig


def _parse_selig(pairs: list[tuple[float, float]]) -> np.ndarray:
    """Selig: a single contour from TE over the top to LE and back under to TE."""
    return np.asarray(pairs, dtype=float)


def _parse_lednicer(pairs: list[tuple[float, float]]) -> np.ndarray:
    """Lednicer: header counts, then upper (LE->TE), then lower (LE->TE)."""
    n_up = int(round(pairs[0][0]))
    n_lo = int(round(pairs[0][1]))
    body = pairs[1:]
    if len(body) < n_up + n_lo:
        raise ValueError(
            f"Lednicer file declares {n_up}+{n_lo} points but only {len(body)} coordinates found."
        )
    upper = np.asarray(body[:n_up], dtype=float)  # LE -> TE
    lower = np.asarray(body[n_up : n_up + n_lo], dtype=float)  # LE -> TE
    # Convert to Selig order: TE -> upper(reversed to LE) -> lower(LE->TE) -> TE
    upper_te_to_le = upper[::-1]
    contour = np.vstack([upper_te_to_le, lower[1:]])  # drop duplicate LE
    return contour


def parse_airfoil(text: str, fmt: AirfoilFormat = AirfoilFormat.auto) -> np.ndarray:
    """Parse raw coordinate text into an (N, 2) contour array in Selig order."""
    pairs = _numeric_pairs(text)
    if len(pairs) < 5:
        raise ValueError("Could not find enough coordinate pairs to form an airfoil.")
    if fmt == AirfoilFormat.auto:
        fmt = _detect_format(pairs)
    if fmt == AirfoilFormat.lednicer:
        return _parse_lednicer(pairs)
    return _parse_selig(pairs)


@dataclass
class Airfoil:
    """A chord-aligned, unit-chord airfoil with a closed (sharp) trailing edge."""

    name: str
    contour: np.ndarray  # (N, 2) Selig order, LE=(0,0), TE=(1,0)
    te_gap_original: float  # trailing-edge gap before closing (unit-chord scale)

    # -- construction ------------------------------------------------------- #
    @classmethod
    def from_contour(cls, name: str, contour: np.ndarray) -> "Airfoil":
        pts = np.asarray(contour, dtype=float)
        if pts.ndim != 2 or pts.shape[1] != 2 or pts.shape[0] < 5:
            raise ValueError("Airfoil contour must be an (N>=5, 2) array.")

        # Leading edge = point of minimum x; trailing edge = mean of the two endpoints.
        le_idx = int(np.argmin(pts[:, 0]))
        le = pts[le_idx].copy()
        te = 0.5 * (pts[0] + pts[-1])
        te_gap_original = float(abs(pts[0, 1] - pts[-1, 1]))

        # Translate LE to origin.
        pts = pts - le
        te = te - le

        # Rotate so the chord line (LE->TE) lies on +x.
        theta = math.atan2(te[1], te[0])
        c, s = math.cos(-theta), math.sin(-theta)
        rot = np.array([[c, -s], [s, c]])
        pts = pts @ rot.T
        te = te @ rot.T

        # Scale to unit chord.
        chord = float(te[0])
        if chord <= 0:
            raise ValueError("Degenerate airfoil: non-positive chord after alignment.")
        pts = pts / chord
        te_gap_original /= chord

        # Close the trailing edge to a sharp point at (1, 0): force endpoints.
        pts[0] = np.array([1.0, 0.0])
        pts[-1] = np.array([1.0, 0.0])
        # Snap the leading edge exactly to the origin.
        le_idx = int(np.argmin(pts[:, 0]))
        pts[le_idx] = np.array([0.0, 0.0])

        return cls(name=name, contour=pts, te_gap_original=te_gap_original)

    # -- queries ------------------------------------------------------------ #
    @property
    def le_index(self) -> int:
        return int(np.argmin(self.contour[:, 0]))

    def split_surfaces(self) -> tuple[np.ndarray, np.ndarray]:
        """Return (upper, lower) each ordered LE->TE with x increasing."""
        i = self.le_index
        upper = self.contour[: i + 1][::-1]  # was TE->LE, now LE->TE
        lower = self.contour[i:]  # LE->TE
        return upper, lower

    @staticmethod
    def _resample_surface(surface: np.ndarray, n: int) -> np.ndarray:
        """Cosine-cluster a single surface (LE->TE) to n+1 points, x in [0, 1]."""
        # Parameterise by cumulative arc length for robustness near a blunt nose.
        d = np.sqrt(np.sum(np.diff(surface, axis=0) ** 2, axis=1))
        s = np.concatenate([[0.0], np.cumsum(d)])
        s /= s[-1]
        # Cosine spacing in arc length clusters points near LE and TE.
        beta = np.linspace(0.0, math.pi, n + 1)
        s_target = 0.5 * (1.0 - np.cos(beta))
        x = np.interp(s_target, s, surface[:, 0])
        y = np.interp(s_target, s, surface[:, 1])
        out = np.column_stack([x, y])
        out[0] = np.array([0.0, 0.0])
        out[-1] = np.array([1.0, 0.0])
        return out

    def resampled_surfaces(self, n: int) -> tuple[np.ndarray, np.ndarray]:
        """Return (upper, lower) resampled to n+1 points each, ordered LE->TE."""
        upper, lower = self.split_surfaces()
        return self._resample_surface(upper, n), self._resample_surface(lower, n)


def load_airfoil(name: str, text: str | None, points, fmt: AirfoilFormat) -> Airfoil:
    """Build an Airfoil from either raw text or an explicit point list."""
    if points is not None:
        contour = np.asarray(points, dtype=float)
    else:
        if text is None:
            raise ValueError("No airfoil geometry supplied.")
        contour = parse_airfoil(text, fmt)
    return Airfoil.from_contour(name, contour)
