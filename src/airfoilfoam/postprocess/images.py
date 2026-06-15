"""Render contour images (velocity, pressure, turbulence) from foamToVTK output.

Uses matplotlib only (no GPU / offscreen GL), so it works in any container or CI.
The 2D field is taken from the z=0 layer of the extruded mesh and triangulated;
triangles inside the airfoil are masked and the airfoil is drawn on top.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.tri as mtri  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.path import Path as MplPath  # noqa: E402

import meshio  # noqa: E402

from ..models import ImageField  # noqa: E402

# field -> (label, matplotlib colormap)
_FIELD_STYLE = {
    ImageField.velocity_magnitude: ("Velocity magnitude |U| [m/s]", "viridis"),
    ImageField.velocity_x: ("Velocity U_x [m/s]", "viridis"),
    ImageField.velocity_y: ("Velocity U_y [m/s]", "coolwarm"),
    ImageField.pressure: ("Kinematic pressure p [m^2/s^2]", "coolwarm"),
    ImageField.turbulent_kinetic_energy: ("Turbulent kinetic energy k [m^2/s^2]", "magma"),
    ImageField.turbulent_viscosity: ("Turbulent viscosity nut [m^2/s]", "magma"),
}


def find_internal_vtu(case_dir: Path) -> Path:
    candidates = sorted(case_dir.glob("VTK/*/internal.vtu"))
    if not candidates:
        # older foamToVTK layout: VTK/<case>_<n>.vtu
        candidates = sorted(p for p in case_dir.glob("VTK/*.vtu") if "internal" not in p.name)
    if not candidates:
        raise FileNotFoundError(f"No internal.vtu found under {case_dir/'VTK'}")
    # pick the highest time index
    return candidates[-1]


@dataclass
class _Field2D:
    x: np.ndarray
    y: np.ndarray
    triang: mtri.Triangulation


def _extract_value(mesh: "meshio.Mesh", mask: np.ndarray, field: ImageField) -> np.ndarray:
    data = mesh.point_data
    U = np.asarray(data["U"])[mask]
    if field == ImageField.velocity_magnitude:
        return np.linalg.norm(U, axis=1)
    if field == ImageField.velocity_x:
        return U[:, 0]
    if field == ImageField.velocity_y:
        return U[:, 1]
    if field == ImageField.pressure:
        return np.asarray(data["p"])[mask]
    if field == ImageField.turbulent_kinetic_energy:
        return np.asarray(data["k"])[mask]
    if field == ImageField.turbulent_viscosity:
        return np.asarray(data["nut"])[mask]
    raise ValueError(f"Unsupported image field {field}")


def _build_triangulation(mesh: "meshio.Mesh", airfoil_xy: np.ndarray) -> tuple[np.ndarray, _Field2D]:
    pts = mesh.points
    zmin = pts[:, 2].min()
    zmax = pts[:, 2].max()
    thresh = zmin + 0.5 * (zmax - zmin) if zmax > zmin else zmin + 1.0
    mask = pts[:, 2] <= thresh
    x = pts[mask, 0]
    y = pts[mask, 1]
    triang = mtri.Triangulation(x, y)
    # Mask triangles whose centroid lies inside the airfoil.
    tris = triang.triangles
    cx = x[tris].mean(axis=1)
    cy = y[tris].mean(axis=1)
    inside = MplPath(airfoil_xy).contains_points(np.column_stack([cx, cy]))
    triang.set_mask(inside)
    return mask, _Field2D(x=x, y=y, triang=triang)


def render_contours(
    case_dir: Path,
    out_dir: Path,
    airfoil_contour_unit: np.ndarray,
    chord: float,
    fields: list[ImageField],
    zoom_chords: float = 2.0,
    title_suffix: str = "",
) -> dict[str, str]:
    """Render the requested fields; return {field_value: output_filename}."""
    out_dir.mkdir(parents=True, exist_ok=True)
    vtu = find_internal_vtu(case_dir)
    mesh = meshio.read(vtu)

    airfoil_xy = airfoil_contour_unit * chord
    mask, f2d = _build_triangulation(mesh, airfoil_xy)

    xlim = (-zoom_chords * chord, (1.0 + zoom_chords) * chord)
    ylim = (-zoom_chords * chord, zoom_chords * chord)

    results: dict[str, str] = {}
    for field in fields:
        label, cmap = _FIELD_STYLE[field]
        values = _extract_value(mesh, mask, field)

        fig, ax = plt.subplots(figsize=(9, 6))
        levels = 40
        cs = ax.tricontourf(f2d.triang, values, levels=levels, cmap=cmap, extend="both")
        ax.fill(airfoil_xy[:, 0], airfoil_xy[:, 1], color="white", zorder=3)
        ax.plot(airfoil_xy[:, 0], airfoil_xy[:, 1], color="black", lw=1.0, zorder=4)
        ax.set_xlim(*xlim)
        ax.set_ylim(*ylim)
        ax.set_aspect("equal")
        ax.set_xlabel("x [m]")
        ax.set_ylabel("y [m]")
        ax.set_title(f"{label}{(' — ' + title_suffix) if title_suffix else ''}")
        cb = fig.colorbar(cs, ax=ax, fraction=0.035, pad=0.02)
        cb.set_label(label)
        fig.tight_layout()

        fname = f"{field.value}.png"
        fig.savefig(out_dir / fname, dpi=110)
        plt.close(fig)
        results[field.value] = fname

    return results
