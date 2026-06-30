"""Render contour images + URANS animations from foamToVTK output.

Uses matplotlib only (no GPU / offscreen GL), so it works in any container or CI.
The 2D field is taken from the z=0 layer of the extruded mesh and triangulated;
triangles inside the airfoil are masked and the airfoil is drawn on top. Animations
(post-stall URANS) are encoded to mp4 via matplotlib's FFMpegWriter (needs ffmpeg).
"""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import re
from typing import Callable, Optional

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.tri as mtri  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.path import Path as MplPath  # noqa: E402
from matplotlib.tri import CubicTriInterpolator  # noqa: E402

import meshio  # noqa: E402

from ..models import ImageField  # noqa: E402

# field -> (label, matplotlib colormap)
_FIELD_STYLE = {
    ImageField.velocity_magnitude: ("Velocity magnitude |U| [m/s]", "viridis"),
    ImageField.velocity_x: ("Velocity U_x [m/s]", "viridis"),
    ImageField.velocity_y: ("Velocity U_y [m/s]", "coolwarm"),
    ImageField.pressure: ("Kinematic pressure p [m^2/s^2]", "coolwarm"),
    ImageField.pressure_coefficient: ("Pressure coefficient Cp", "coolwarm"),
    ImageField.vorticity: ("Vorticity omega_z [1/s]", "coolwarm"),
    ImageField.turbulent_kinetic_energy: ("Turbulent kinetic energy k [m^2/s^2]", "magma"),
    ImageField.turbulent_viscosity: ("Turbulent viscosity nut [m^2/s]", "magma"),
}


def find_internal_vtu(case_dir: Path) -> Path:
    return find_all_vtus(case_dir)[-1]


def find_all_vtus(case_dir: Path) -> list[Path]:
    """All internal-field VTUs under the case, ordered by time (ascending)."""
    candidates = sorted(case_dir.glob("VTK/*/internal.vtu"), key=lambda p: _vtu_time(p))
    if not candidates:
        candidates = sorted(
            (p for p in case_dir.glob("VTK/*.vtu") if "internal" not in p.name),
            key=lambda p: _vtu_time(p),
        )
    if not candidates:
        raise FileNotFoundError(f"No internal.vtu found under {case_dir / 'VTK'}")
    return candidates


def _vtu_time(p: Path) -> float:
    """Best-effort time index from a foamToVTK path (dir name or trailing _<n>)."""
    if p.parent.name.startswith("case_"):
        header_time = _vtu_header_time(str(p))
        if header_time is not None:
            return header_time
    for text in (p.parent.name, p.stem):
        token = text.split("_")[-1]
        try:
            return float(token)
        except ValueError:
            continue
    return 0.0


@lru_cache(maxsize=4096)
def _vtu_header_time(path: str) -> float | None:
    try:
        with open(path, "rb") as fh:
            head = fh.read(512).decode("utf-8", errors="ignore")
    except OSError:
        return None
    match = re.search(r"time=['\"]([^'\"]+)['\"]", head)
    if match is None:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def select_vtus(
    vtus: list[Path],
    start_time: float | None = None,
    end_time: float | None = None,
    max_frames: int | None = None,
) -> list[Path]:
    """Filter VTUs to a time window, preserve time order, and optionally subsample."""
    out = []
    for vtu in sorted(vtus, key=_vtu_time):
        t = _vtu_time(vtu)
        if start_time is not None and t < start_time:
            continue
        if end_time is not None and t > end_time:
            continue
        out.append(vtu)
    if max_frames is not None:
        out = _subsample(out, max_frames)
    return out


@dataclass
class _Field2D:
    x: np.ndarray
    y: np.ndarray
    triang: mtri.Triangulation


def compute_vorticity(triang: mtri.Triangulation, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Out-of-plane vorticity omega_z = dv/dx - du/dy, evaluated at the mesh nodes
    via cubic interpolation of the in-plane velocity components."""
    iu = CubicTriInterpolator(triang, np.asarray(u, dtype=float))
    iv = CubicTriInterpolator(triang, np.asarray(v, dtype=float))
    _, dudy = iu.gradient(triang.x, triang.y)
    dvdx, _ = iv.gradient(triang.x, triang.y)
    wz = np.asarray(dvdx, dtype=float) - np.asarray(dudy, dtype=float)
    return np.ma.filled(np.ma.masked_invalid(wz), 0.0)


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


def _field_values(
    mesh: "meshio.Mesh", mask: np.ndarray, f2d: _Field2D, field: ImageField, freestream_speed: float
) -> np.ndarray:
    """Per-node field values, including the derived vorticity / Cp fields."""
    if field == ImageField.vorticity:
        U = np.asarray(mesh.point_data["U"])[mask]
        return compute_vorticity(f2d.triang, U[:, 0], U[:, 1])
    if field == ImageField.pressure_coefficient:
        p = np.asarray(mesh.point_data["p"])[mask]
        q = 0.5 * max(freestream_speed, 1e-9) ** 2
        return p / q
    return _extract_value(mesh, mask, field)


def _build_triangulation(mesh: "meshio.Mesh", airfoil_xy: np.ndarray) -> tuple[np.ndarray, _Field2D]:
    pts = mesh.points
    zmin = pts[:, 2].min()
    zmax = pts[:, 2].max()
    thresh = zmin + 0.5 * (zmax - zmin) if zmax > zmin else zmin + 1.0
    mask = pts[:, 2] <= thresh
    x = pts[mask, 0]
    y = pts[mask, 1]
    triang = mtri.Triangulation(x, y)
    tris = triang.triangles
    cx = x[tris].mean(axis=1)
    cy = y[tris].mean(axis=1)
    inside = MplPath(airfoil_xy).contains_points(np.column_stack([cx, cy]))
    triang.set_mask(inside)
    return mask, _Field2D(x=x, y=y, triang=triang)


def _draw_field(ax, f2d: _Field2D, values, airfoil_xy, label, cmap, xlim, ylim, title, vmin=None, vmax=None, levels=40):
    ax.tricontourf(f2d.triang, values, levels=levels, cmap=cmap, extend="both", vmin=vmin, vmax=vmax)
    ax.fill(airfoil_xy[:, 0], airfoil_xy[:, 1], color="white", zorder=3)
    ax.plot(airfoil_xy[:, 0], airfoil_xy[:, 1], color="black", lw=1.0, zorder=4)
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.set_aspect("equal")
    ax.set_title(title)


def _finite_visible_values(f2d: _Field2D, values, xlim, ylim) -> np.ndarray:
    arr = np.asarray(values, dtype=float)
    visible = (
        (f2d.x >= min(xlim))
        & (f2d.x <= max(xlim))
        & (f2d.y >= min(ylim))
        & (f2d.y <= max(ylim))
        & np.isfinite(arr)
    )
    out = arr[visible]
    if out.size:
        return out
    return arr[np.isfinite(arr)]


def compute_field_extents(
    case_dir: Path,
    airfoil_contour_unit: np.ndarray,
    chord: float,
    fields: list[ImageField],
    *,
    freestream_speed: float = 0.0,
    zoom_chords: float = 2.0,
    max_frames: int | None = 220,
    start_time: float | None = None,
    end_time: float | None = None,
) -> dict[str, dict[str, float | int]]:
    """Return real finite min/max values for each field in the rendered window.

    The values come from stored VTU evidence only. Missing source fields are
    omitted; callers should record those as unavailable instead of inventing a
    scale.
    """
    vtus = select_vtus(find_all_vtus(case_dir), start_time, end_time, max_frames)
    if not vtus:
        return {}
    airfoil_xy = airfoil_contour_unit * chord
    mask, f2d = _build_triangulation(meshio.read(vtus[0]), airfoil_xy)
    xlim = (-zoom_chords * chord, (1.0 + zoom_chords) * chord)
    ylim = (-zoom_chords * chord, zoom_chords * chord)
    result: dict[str, dict[str, float | int]] = {}
    for field in fields:
        min_value = float("inf")
        max_value = float("-inf")
        finite_count = 0
        for vtu in vtus:
            try:
                values = _field_values(meshio.read(vtu), mask, f2d, field, freestream_speed)
            except (KeyError, ValueError):
                finite_count = 0
                break
            finite = _finite_visible_values(f2d, values, xlim, ylim)
            if finite.size == 0:
                continue
            min_value = min(min_value, float(np.min(finite)))
            max_value = max(max_value, float(np.max(finite)))
            finite_count += int(finite.size)
        if finite_count > 0 and np.isfinite(min_value) and np.isfinite(max_value):
            result[field.value] = {"min": min_value, "max": max_value, "finite_count": finite_count}
    return result


def _scale_for(field_scales: dict[ImageField, tuple[float, float]] | None, field: ImageField):
    if not field_scales:
        return None, None
    scale = field_scales.get(field)
    if scale is None:
        return None, None
    return scale


def render_contours(
    case_dir: Path,
    out_dir: Path,
    airfoil_contour_unit: np.ndarray,
    chord: float,
    fields: list[ImageField],
    zoom_chords: float = 2.0,
    title_suffix: str = "",
    freestream_speed: float = 0.0,
    field_scales: dict[ImageField, tuple[float, float]] | None = None,
) -> dict[str, str]:
    """Render the requested fields from the latest-time VTU; return {field: filename}."""
    out_dir.mkdir(parents=True, exist_ok=True)
    mesh = meshio.read(find_internal_vtu(case_dir))
    airfoil_xy = airfoil_contour_unit * chord
    mask, f2d = _build_triangulation(mesh, airfoil_xy)
    xlim = (-zoom_chords * chord, (1.0 + zoom_chords) * chord)
    ylim = (-zoom_chords * chord, zoom_chords * chord)

    results: dict[str, str] = {}
    for field in fields:
        label, cmap = _FIELD_STYLE[field]
        try:
            values = _field_values(mesh, mask, f2d, field, freestream_speed)
        except (KeyError, ValueError):
            continue
        vmin, vmax = _scale_for(field_scales, field)
        fig, ax = plt.subplots(figsize=(9, 6))
        cs = ax.tricontourf(f2d.triang, values, levels=40, cmap=cmap, extend="both", vmin=vmin, vmax=vmax)
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


def render_mean_contours(
    case_dir: Path,
    out_dir: Path,
    airfoil_contour_unit: np.ndarray,
    chord: float,
    fields: list[ImageField],
    zoom_chords: float = 2.0,
    title_suffix: str = "",
    freestream_speed: float = 0.0,
    max_frames: int = 140,
    start_time: float | None = None,
    end_time: float | None = None,
    field_scales: dict[ImageField, tuple[float, float]] | None = None,
) -> dict[str, str]:
    """Render time-AVERAGED contours by averaging each field over the transient VTUs."""
    out_dir.mkdir(parents=True, exist_ok=True)
    vtus = select_vtus(find_all_vtus(case_dir), start_time, end_time, max_frames)
    if not vtus:
        return {}
    airfoil_xy = airfoil_contour_unit * chord
    mask, f2d = _build_triangulation(meshio.read(vtus[0]), airfoil_xy)
    acc: dict[ImageField, np.ndarray] = {}
    supported: set[ImageField] | None = None
    for vtu in vtus:
        mesh = meshio.read(vtu)
        frame_supported: set[ImageField] = set()
        for field in fields:
            try:
                vals = _field_values(mesh, mask, f2d, field, freestream_speed)
            except (KeyError, ValueError):
                continue
            frame_supported.add(field)
            acc[field] = vals if field not in acc else acc[field] + vals
        supported = frame_supported if supported is None else supported & frame_supported
    xlim = (-zoom_chords * chord, (1.0 + zoom_chords) * chord)
    ylim = (-zoom_chords * chord, zoom_chords * chord)
    results: dict[str, str] = {}
    for field in fields:
        if field not in (supported or set()):
            continue
        label, cmap = _FIELD_STYLE[field]
        vmin, vmax = _scale_for(field_scales, field)
        fig, ax = plt.subplots(figsize=(9, 6))
        _draw_field(
            ax, f2d, acc[field] / len(vtus), airfoil_xy, label, cmap, xlim, ylim,
            f"{label} (mean){(' — ' + title_suffix) if title_suffix else ''}",
            vmin=vmin,
            vmax=vmax,
        )
        ax.set_xlabel("x [m]")
        ax.set_ylabel("y [m]")
        fig.tight_layout()
        fname = f"{field.value}_mean.png"
        fig.savefig(out_dir / fname, dpi=110)
        plt.close(fig)
        results[field.value] = fname
    return results


def _subsample(items: list, max_items: int) -> list:
    if len(items) <= max_items:
        return items
    idx = np.linspace(0, len(items) - 1, max_items).round().astype(int)
    return [items[i] for i in idx]


def write_animation_mp4(
    path: Path,
    draw: Callable[["plt.Axes", int], None],
    n_frames: int,
    figsize: tuple[float, float] = (9, 6),
    fps: int = 20,
    dpi: int = 100,
) -> Optional[Path]:
    """Encode ``n_frames`` to an mp4 via ffmpeg; ``draw(ax, i)`` renders frame i.
    Returns None (and leaves no file) if encoding is unavailable."""
    from matplotlib.animation import FFMpegWriter

    if not FFMpegWriter.isAvailable():
        return None
    fig, ax = plt.subplots(figsize=figsize)
    writer = FFMpegWriter(fps=fps, bitrate=2400, codec="libx264")
    try:
        with writer.saving(fig, str(path), dpi=dpi):
            for i in range(n_frames):
                ax.clear()
                draw(ax, i)
                writer.grab_frame()
    finally:
        plt.close(fig)
    return path


def render_animation(
    case_dir: Path,
    out_dir: Path,
    airfoil_contour_unit: np.ndarray,
    chord: float,
    field: ImageField,
    freestream_speed: float = 0.0,
    zoom_chords: float = 2.0,
    fps: int = 20,
    max_frames: int = 140,
    start_time: float | None = None,
    end_time: float | None = None,
    title_suffix: str = "",
    vmin: float | None = None,
    vmax: float | None = None,
) -> Optional[str]:
    """Encode an mp4 of one field over the transient time series. Returns the
    filename, or None if there are too few frames / ffmpeg is unavailable."""
    vtus = select_vtus(find_all_vtus(case_dir), start_time, end_time, min(max_frames, 220))
    if len(vtus) < 2:
        return None
    out_dir.mkdir(parents=True, exist_ok=True)
    airfoil_xy = airfoil_contour_unit * chord
    mask, f2d = _build_triangulation(meshio.read(vtus[0]), airfoil_xy)
    try:
        frames = [_field_values(meshio.read(v), mask, f2d, field, freestream_speed) for v in vtus]
    except (KeyError, ValueError):
        return None
    if vmin is None or vmax is None:
        allv = np.concatenate(frames)
        vmin, vmax = (float(np.percentile(allv, 2)), float(np.percentile(allv, 98)))
    label, cmap = _FIELD_STYLE[field]
    xlim = (-zoom_chords * chord, (1.0 + zoom_chords) * chord)
    ylim = (-zoom_chords * chord, zoom_chords * chord)
    title = f"{label}{(' — ' + title_suffix) if title_suffix else ''}"

    def draw(ax, i: int) -> None:
        _draw_field(ax, f2d, frames[i], airfoil_xy, label, cmap, xlim, ylim, title, vmin=vmin, vmax=vmax)
        ax.set_xticks([])
        ax.set_yticks([])

    fname = f"{field.value}.mp4"
    written = write_animation_mp4(out_dir / fname, draw, len(frames), fps=fps)
    return fname if written is not None else None


def render_custom_field(
    case_dir: Path,
    out_dir: Path,
    airfoil_contour_unit: np.ndarray,
    chord: float,
    field: ImageField,
    *,
    role: str = "instantaneous",
    freestream_speed: float = 0.0,
    zoom_chords: float = 2.0,
    colormap: str | None = None,
    levels: int = 40,
    vmin: float | None = None,
    vmax: float | None = None,
    frame_index: int | None = None,
    width_px: int = 990,
    height_px: int = 660,
    title_suffix: str = "",
    filename_prefix: str = "custom",
) -> str:
    """Render one custom PNG from stored VTU evidence.

    ``case_dir`` may be a full OpenFOAM case or an evidence directory containing
    a copied ``VTK`` tree. This is intentionally still-image only; default URANS
    videos are generated during solve finalization and stored as media.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    vtus = find_all_vtus(case_dir)
    if role == "mean":
        selected = vtus
    else:
        selected = [vtus[max(0, min(len(vtus) - 1, frame_index if frame_index is not None else len(vtus) - 1))]]
    if not selected:
        raise FileNotFoundError(f"No VTU files available under {case_dir / 'VTK'}")

    airfoil_xy = airfoil_contour_unit * chord
    mask, f2d = _build_triangulation(meshio.read(selected[0]), airfoil_xy)
    if role == "mean":
        acc = None
        for vtu in selected:
            vals = _field_values(meshio.read(vtu), mask, f2d, field, freestream_speed)
            acc = vals if acc is None else acc + vals
        assert acc is not None
        values = acc / len(selected)
    else:
        values = _field_values(meshio.read(selected[0]), mask, f2d, field, freestream_speed)

    label, default_cmap = _FIELD_STYLE[field]
    cmap = colormap or default_cmap
    xlim = (-zoom_chords * chord, (1.0 + zoom_chords) * chord)
    ylim = (-zoom_chords * chord, zoom_chords * chord)
    dpi = 110
    fig, ax = plt.subplots(figsize=(max(320, width_px) / dpi, max(240, height_px) / dpi))
    cs = ax.tricontourf(
        f2d.triang,
        values,
        levels=max(3, int(levels)),
        cmap=cmap,
        extend="both",
        vmin=vmin,
        vmax=vmax,
    )
    ax.fill(airfoil_xy[:, 0], airfoil_xy[:, 1], color="white", zorder=3)
    ax.plot(airfoil_xy[:, 0], airfoil_xy[:, 1], color="black", lw=1.0, zorder=4)
    ax.set_xlim(*xlim)
    ax.set_ylim(*ylim)
    ax.set_aspect("equal")
    ax.set_xlabel("x [m]")
    ax.set_ylabel("y [m]")
    title_role = "mean" if role == "mean" else "instant"
    ax.set_title(f"{label} ({title_role}){(' — ' + title_suffix) if title_suffix else ''}")
    cb = fig.colorbar(cs, ax=ax, fraction=0.035, pad=0.02)
    cb.set_label(label)
    fig.tight_layout()
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", filename_prefix).strip("_") or "custom"
    fname = f"{safe}_{field.value}_{role}.png"
    fig.savefig(out_dir / fname, dpi=dpi)
    plt.close(fig)
    return fname
