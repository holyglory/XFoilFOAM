"""Render contour images + URANS animations from foamToVTK output.

Uses matplotlib only (no GPU / offscreen GL), so it works in any container or CI.
The 2D field is taken from the z=0 layer of the extruded mesh and triangulated;
triangles inside the airfoil are masked and the airfoil is drawn on top. Animations
(post-stall URANS) are encoded to mp4 via matplotlib's FFMpegWriter (needs ffmpeg).
"""
from __future__ import annotations

import json
import shutil
import time
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath
import re
from typing import Callable, Optional, Sequence

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.tri as mtri  # noqa: E402
import numpy as np  # noqa: E402
from matplotlib.path import Path as MplPath  # noqa: E402

import meshio  # noqa: E402

from ..models import FRAME_TRACK_MAX_FRAMES, ImageField  # noqa: E402

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

FRAME_TRACK_RENDER_LEVELS = 40
FRAME_TRACK_SCALE_SAMPLE_FRAMES = 32
_SIGNED_FRAME_FIELDS = frozenset(
    {
        ImageField.velocity_x,
        ImageField.velocity_y,
        ImageField.pressure,
        ImageField.pressure_coefficient,
        ImageField.vorticity,
    }
)


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


def available_vtu_times(case_dir: Path) -> list[float]:
    """Physical times of stored VTU frames, in render order."""
    return [_vtu_time(vtu) for vtu in find_all_vtus(case_dir)]


def _vtu_time(p: Path) -> float:
    """Physical solution time of a foamToVTK output file.

    foamToVTK on current stacks names output directories by TIMESTEP INDEX
    (e.g. ``transient_0`` .. ``transient_921``), not by physical time, so the
    trailing name token must never be trusted first. Resolution order:

    1. the VTK ``.series`` file written by foamToVTK (name -> time map),
    2. an inline ``TimeValue`` FieldData entry in the sibling ``.vtm`` file or
       in the VTU/VTM file itself,
    3. the legacy ``time='...'`` header attribute (older ``case_*`` layout),
    4. float-parse of the trailing name token (legacy time-named dirs).
    """
    vtk_root, key = _vtk_root_and_key(p)
    t = _series_time(vtk_root, key)
    if t is None:
        t = _xml_time_value(p, vtk_root, key)
    if t is not None:
        return t
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


def _vtk_root_and_key(p: Path) -> tuple[Path, str]:
    """The VTK output root and the frame key (dir name / file stem) for ``p``.

    Handles both foamToVTK layouts: ``VTK/<frame>/internal.vtu`` (directory per
    time step) and flat ``VTK/<frame>.vtu``.
    """
    parent = p.parent
    if parent.name == "VTK":
        return parent, p.stem
    return parent.parent, parent.name


def _series_time(vtk_root: Path, key: str) -> float | None:
    """Look ``key`` up in any ``.series`` file foamToVTK wrote next to the frames."""
    try:
        stat = vtk_root.stat()
    except OSError:
        return None
    for mapping in _root_series_maps(str(vtk_root), stat.st_mtime_ns):
        if key in mapping:
            return mapping[key]
    return None


@lru_cache(maxsize=64)
def _root_series_maps(vtk_root: str, _mtime_ns: int) -> tuple[dict[str, float], ...]:
    maps: list[dict[str, float]] = []
    for series in sorted(Path(vtk_root).glob("*.series")):
        try:
            stat = series.stat()
        except OSError:
            continue
        mapping = _series_time_map(str(series), stat.st_mtime_ns, stat.st_size)
        if mapping:
            maps.append(mapping)
    return tuple(maps)


@lru_cache(maxsize=256)
def _series_time_map(series_path: str, _mtime_ns: int, _size: int) -> dict[str, float] | None:
    """Parse a VTK ``.series`` file (``{"files": [{"name": ..., "time": ...}]}``)."""
    try:
        data = json.loads(Path(series_path).read_text(encoding="utf-8", errors="ignore"))
    except (OSError, ValueError):
        return None
    entries = data.get("files") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return None
    mapping: dict[str, float] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        try:
            time_value = float(entry.get("time"))
        except (TypeError, ValueError):
            continue
        rel = PurePosixPath(name)
        # "transient_12.vtm" -> key "transient_12" (matches the frame dir name);
        # "transient_12/internal.vtu" -> also map the leading directory.
        mapping[rel.stem] = time_value
        if len(rel.parts) > 1:
            mapping[rel.parts[0]] = time_value
    return mapping or None


_TIME_VALUE_RE = re.compile(r"Name=['\"]TimeValue['\"][^>]*>\s*([^<\s]+)")


def _xml_time_value(p: Path, vtk_root: Path, key: str) -> float | None:
    """``TimeValue`` FieldData from the sibling ``.vtm`` or the file itself."""
    for candidate in (vtk_root / f"{key}.vtm", p):
        try:
            stat = candidate.stat()
        except OSError:
            continue
        t = _time_value_in_head(str(candidate), stat.st_mtime_ns, stat.st_size)
        if t is not None:
            return t
    return None


@lru_cache(maxsize=4096)
def _time_value_in_head(path: str, _mtime_ns: int, _size: int) -> float | None:
    try:
        with open(path, "rb") as fh:
            head = fh.read(8192).decode("utf-8", errors="ignore")
    except OSError:
        return None
    match = _TIME_VALUE_RE.search(head)
    if match is None:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


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


class TriGradientOperator:
    """Precomputed per-triangle P1 gradient operator with area-weighted nodal
    recovery (Green-Gauss / linear finite-element gradient).

    Numerical scheme (chosen over ``CubicTriInterpolator.gradient``): the nodal
    field is treated as piecewise linear on each triangle, whose (constant)
    gradient is exact for linear fields and first-order accurate on smooth
    fields; each node then receives the area-weighted average of its incident
    triangles' gradients — the standard Green-Gauss / ZZ-style recovery, which
    restores near-second-order accuracy at interior nodes. The cubic min-E
    interpolator solved a conjugate-gradient system over the FULL triangulation
    on every construction (30-60 s per frame on a refined URANS mesh — the
    2026-07-07 prod grind: 2 builds x 141 frames pinned workers for hours).
    This operator is built ONCE per triangulation and applying it to a frame is
    a handful of vectorised O(n_triangles) passes (milliseconds). The output
    feeds 40-band contour plots; parity with the cubic gradient within
    contour-band resolution is asserted in tests/test_images_extra.py.

    Masked triangles (inside the airfoil) are excluded; nodes with no valid
    incident triangle get 0.0, matching the previous masked-invalid fill.
    """

    def __init__(self, triang: mtri.Triangulation):
        tris = np.asarray(triang.triangles)
        mask = triang.mask
        if mask is not None:
            tris = tris[~np.asarray(mask, dtype=bool)]
        x = np.asarray(triang.x, dtype=float)
        y = np.asarray(triang.y, dtype=float)
        x1, x2, x3 = (x[tris[:, k]] for k in range(3))
        y1, y2, y3 = (y[tris[:, k]] for k in range(3))
        det = (x2 - x1) * (y3 - y1) - (x3 - x1) * (y2 - y1)  # 2 * signed area
        good = np.abs(det) > 1e-300
        tris, det = tris[good], det[good]
        x1, x2, x3 = x1[good], x2[good], x3[good]
        y1, y2, y3 = y1[good], y2[good], y3[good]
        # dz/dx = sum_k gx[:, k] * z[tri[:, k]] (analogously gy): the exact
        # gradient of the linear interpolant on each triangle.
        self._gx = np.stack([(y2 - y3) / det, (y3 - y1) / det, (y1 - y2) / det], axis=1)
        self._gy = np.stack([(x3 - x2) / det, (x1 - x3) / det, (x2 - x1) / det], axis=1)
        self._tri_flat = tris.ravel()
        self._area3 = np.repeat(0.5 * np.abs(det), 3)
        self._n_nodes = len(x)
        wsum = np.bincount(self._tri_flat, weights=self._area3, minlength=self._n_nodes)
        self._inv_wsum = np.where(wsum > 0.0, 1.0 / np.where(wsum > 0.0, wsum, 1.0), 0.0)
        self._tris = tris

    def gradient(self, z: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Nodal (dz/dx, dz/dy) of one frame's nodal values ``z``."""
        zt = np.asarray(z, dtype=float)[self._tris]
        gx_t = np.repeat((zt * self._gx).sum(axis=1), 3) * self._area3
        gy_t = np.repeat((zt * self._gy).sum(axis=1), 3) * self._area3
        gx = np.bincount(self._tri_flat, weights=gx_t, minlength=self._n_nodes) * self._inv_wsum
        gy = np.bincount(self._tri_flat, weights=gy_t, minlength=self._n_nodes) * self._inv_wsum
        return gx, gy


def _gradient_operator(triang: mtri.Triangulation) -> TriGradientOperator:
    """The (cached) gradient operator of a triangulation. The triangulation of a
    case is identical across its frames, so the operator is built once and
    reused for every frame's vorticity (the whole point of the 2026-07-07 fix).
    The cache assumes the mask is not mutated after the first vorticity call —
    ``_build_triangulation`` sets the mask before any field is evaluated."""
    op = getattr(triang, "_airfoilfoam_grad_op", None)
    if op is None:
        op = TriGradientOperator(triang)
        triang._airfoilfoam_grad_op = op
    return op


def compute_vorticity(triang: mtri.Triangulation, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Out-of-plane vorticity omega_z = dv/dx - du/dy at the mesh nodes, from the
    precomputed linear gradient operator (built once per triangulation)."""
    op = _gradient_operator(triang)
    _, dudy = op.gradient(u)
    dvdx, _ = op.gradient(v)
    wz = dvdx - dudy
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
    # One meshio.read per VTU serves EVERY field (this API-process path burned
    # len(fields) x len(vtus) reads plus per-frame cubic interpolator builds in
    # the 2026-07-07 prod grind; the triangulation + gradient operator are now
    # shared across all frames and fields).
    stats: dict[ImageField, list] = {f: [float("inf"), float("-inf"), 0] for f in fields}
    failed: set[ImageField] = set()
    for vtu in vtus:
        mesh = meshio.read(vtu)
        for field in fields:
            if field in failed:
                continue
            try:
                values = _field_values(mesh, mask, f2d, field, freestream_speed)
            except (KeyError, ValueError):
                failed.add(field)
                continue
            finite = _finite_visible_values(f2d, values, xlim, ylim)
            if finite.size == 0:
                continue
            entry = stats[field]
            entry[0] = min(entry[0], float(np.min(finite)))
            entry[1] = max(entry[1], float(np.max(finite)))
            entry[2] += int(finite.size)
    result: dict[str, dict[str, float | int]] = {}
    for field in fields:
        if field in failed:
            continue
        min_value, max_value, finite_count = stats[field]
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


def _sample_track_frames(frames: Sequence[np.ndarray], max_frames: int = FRAME_TRACK_SCALE_SAMPLE_FRAMES) -> list[np.ndarray]:
    if len(frames) <= max_frames:
        return [np.asarray(frame, dtype=float) for frame in frames]
    idx = np.linspace(0, len(frames) - 1, max_frames).round().astype(int)
    return [np.asarray(frames[int(i)], dtype=float) for i in idx]


def _robust_frame_track_scale(field: ImageField, frames: Sequence[np.ndarray]) -> tuple[float, float]:
    """Robust constant color scale for one frame-player track.

    The frame player needs a single scale per field to avoid flicker, but raw
    min/max lets startup transients or near-wall vorticity spikes collapse the
    visible wake into a few color bands. Pool a bounded sample of real frames,
    use 2nd..98th percentiles, and keep signed diverging fields symmetric.
    """
    chunks: list[np.ndarray] = []
    for frame in _sample_track_frames(frames):
        values = np.asarray(frame, dtype=float).ravel()
        finite = values[np.isfinite(values)]
        if finite.size:
            chunks.append(finite)
    if not chunks:
        return 0.0, 1.0e-9
    pooled = np.concatenate(chunks)
    if field in _SIGNED_FRAME_FIELDS:
        vmax = float(np.percentile(np.abs(pooled), 98))
        if not np.isfinite(vmax) or vmax <= 0.0:
            vmax = float(np.max(np.abs(pooled)))
        if not np.isfinite(vmax) or vmax <= 0.0:
            vmax = 1.0e-9
        return -vmax, vmax
    vmin, vmax = (float(x) for x in np.percentile(pooled, [2, 98]))
    if not (np.isfinite(vmin) and np.isfinite(vmax)) or vmax <= vmin:
        vmin = float(np.min(pooled))
        vmax = float(np.max(pooled))
    if not (np.isfinite(vmin) and np.isfinite(vmax)) or vmax <= vmin:
        vmax = vmin + 1.0e-9
    return vmin, vmax


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
    """Render time-AVERAGED contours by averaging each field over the transient VTUs.

    One pass, ONE ``meshio.read`` per VTU: pointwise fields accumulate their
    per-frame nodal values (cheap array ops), while vorticity accumulates the
    raw nodal U and takes ONE gradient of the mean velocity at the end — the
    gradient operator is linear, so vorticity(mean U) == mean(vorticity(U_i))
    exactly, and the per-frame interpolator builds of the 2026-07-07 prod
    grind (2 CG solves x 141 frames) collapse to a single cheap operator
    application. Each field is then interpolated/rendered exactly once."""
    out_dir.mkdir(parents=True, exist_ok=True)
    vtus = select_vtus(find_all_vtus(case_dir), start_time, end_time, max_frames)
    if not vtus:
        return {}
    airfoil_xy = airfoil_contour_unit * chord
    mask, f2d = _build_triangulation(meshio.read(vtus[0]), airfoil_xy)
    acc: dict[ImageField, np.ndarray] = {}
    u_sum: np.ndarray | None = None  # nodal (u, v) accumulator for mean vorticity
    supported: set[ImageField] | None = None
    for vtu in vtus:
        mesh = meshio.read(vtu)
        frame_supported: set[ImageField] = set()
        for field in fields:
            try:
                if field == ImageField.vorticity:
                    uv = np.asarray(mesh.point_data["U"])[mask][:, :2]
                    u_sum = uv if u_sum is None else u_sum + uv
                    frame_supported.add(field)
                    continue
                vals = _field_values(mesh, mask, f2d, field, freestream_speed)
            except (KeyError, ValueError):
                continue
            frame_supported.add(field)
            acc[field] = vals if field not in acc else acc[field] + vals
        supported = frame_supported if supported is None else supported & frame_supported
    if ImageField.vorticity in (supported or set()) and u_sum is not None:
        u_mean = u_sum / len(vtus)
        acc[ImageField.vorticity] = compute_vorticity(f2d.triang, u_mean[:, 0], u_mean[:, 1]) * len(vtus)
    xlim = (-zoom_chords * chord, (1.0 + zoom_chords) * chord)
    ylim = (-zoom_chords * chord, zoom_chords * chord)
    results: dict[str, str] = {}
    for field in fields:
        if field not in (supported or set()) or field not in acc:
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


@dataclass
class AnimationBatchResult:
    """Outcome of one multi-field animation pass over a case's VTU series."""

    videos: dict[str, str]  # field value -> mp4 filename
    errors: dict[str, str]  # field value -> encode error (loud degradation)
    budget_skipped: list[str]  # fields not attempted: media wall budget hit


def render_animations(
    case_dir: Path,
    out_dir: Path,
    airfoil_contour_unit: np.ndarray,
    chord: float,
    fields: Sequence[ImageField],
    freestream_speed: float = 0.0,
    zoom_chords: float = 2.0,
    fps: int = 20,
    max_frames: int = 140,
    start_time: float | None = None,
    end_time: float | None = None,
    title_suffix: str = "",
    field_scales: dict[ImageField, tuple[float, float]] | None = None,
    deadline: float | None = None,
    progress: Callable[[str], None] | None = None,
) -> AnimationBatchResult:
    """Encode mp4s of ALL requested fields over the transient time series,
    reading each VTU exactly ONCE and reusing one triangulation (+ cached
    gradient operator) across every frame and field. This replaces the
    per-field ``render_animation`` loop that re-read the whole VTU series once
    per field (8x re-read in the 2026-07-07 prod grind).

    A field missing from the VTUs is skipped by omission (never invented); a
    per-field encoding failure lands in ``errors`` so callers degrade loudly.
    ``deadline`` (``time.monotonic`` clock) stops BEFORE starting another
    field's encode once the media wall budget is exhausted; skipped fields are
    reported in ``budget_skipped``."""
    result = AnimationBatchResult(videos={}, errors={}, budget_skipped=[])
    vtus = select_vtus(find_all_vtus(case_dir), start_time, end_time, min(max_frames, 220))
    if len(vtus) < 2:
        return result
    out_dir.mkdir(parents=True, exist_ok=True)
    airfoil_xy = airfoil_contour_unit * chord
    mask, f2d = _build_triangulation(meshio.read(vtus[0]), airfoil_xy)
    per_field: dict[ImageField, list[np.ndarray]] = {f: [] for f in fields}
    failed: set[ImageField] = set()
    for vtu in vtus:
        mesh = meshio.read(vtu)  # ONE read serves every field
        for field in fields:
            if field in failed:
                continue
            try:
                per_field[field].append(_field_values(mesh, mask, f2d, field, freestream_speed))
            except (KeyError, ValueError):
                failed.add(field)

    xlim = (-zoom_chords * chord, (1.0 + zoom_chords) * chord)
    ylim = (-zoom_chords * chord, zoom_chords * chord)
    for k, field in enumerate(fields):
        frames = per_field.get(field, [])
        if field in failed or len(frames) != len(vtus):
            continue
        if deadline is not None and time.monotonic() >= deadline:
            result.budget_skipped.append(field.value)
            continue
        if progress is not None:
            progress(f"rendering animation {field.value} ({k + 1}/{len(fields)})")
        vmin, vmax = _scale_for(field_scales, field)
        if vmin is None or vmax is None:
            allv = np.concatenate(frames)
            vmin, vmax = (float(np.percentile(allv, 2)), float(np.percentile(allv, 98)))
        label, cmap = _FIELD_STYLE[field]
        title = f"{label}{(' — ' + title_suffix) if title_suffix else ''}"

        def draw(ax, i: int, frames=frames, label=label, cmap=cmap, title=title, vmin=vmin, vmax=vmax) -> None:
            _draw_field(ax, f2d, frames[i], airfoil_xy, label, cmap, xlim, ylim, title, vmin=vmin, vmax=vmax)
            ax.set_xticks([])
            ax.set_yticks([])

        fname = f"{field.value}.mp4"
        try:
            written = write_animation_mp4(out_dir / fname, draw, len(frames), fps=fps)
        except Exception as exc:  # noqa: BLE001 - media is degradation, not failure
            result.errors[field.value] = f"{exc}"
            continue
        if written is not None:
            result.videos[field.value] = fname
    return result


def nearest_vtu_indices(vtu_times: Sequence[float], target_times: Sequence[float]) -> list[int]:
    """Index of the stored VTU frame nearest each target time, with consecutive
    duplicates collapsed (sparse field writes may map two targets to the same
    stored frame; the exported track keeps each stored frame once)."""
    if not len(vtu_times):
        return []
    arr = np.asarray(vtu_times, dtype=float)
    out: list[int] = []
    for target in target_times:
        k = int(np.argmin(np.abs(arr - float(target))))
        if not out or out[-1] != k:
            out.append(k)
    return out


def render_frame_track_images(
    case_dir: Path,
    out_root: Path,
    airfoil_contour_unit: np.ndarray,
    chord: float,
    fields: list[ImageField],
    target_times: Sequence[float],
    *,
    freestream_speed: float = 0.0,
    zoom_chords: float = 2.0,
    width_px: int = 640,
    deadline: float | None = None,
    progress: Callable[[str], None] | None = None,
) -> tuple[list[float], list[str]]:
    """Render the frame_track PNG sequence (contract: 640px wide) from the VTU
    frames nearest each target time.

    Writes ``out_root/{field}/f{i:04d}.png`` per rendered field with a
    consistent robust per-field color scale across the sequence. Returns
    ``(actual_frame_times, rendered_field_names)``; a field whose source data is
    missing in the VTUs is skipped (reported by omission, never invented).

    Budget sanity: the default precalc player can render 3 fields x up to 120
    frames = 360 PNGs per case; the media wall-budget guard remains the
    enforcement point for unexpectedly expensive meshes or filesystems.

    ``deadline`` (``time.monotonic`` clock) enforces the media wall budget:
    when it passes mid-field, that field's PARTIAL PNG directory is removed
    (the frame player contract requires complete sequences) and remaining
    fields are not attempted — the rendered list stays truthful.
    ``progress`` receives a human-readable token every 10 frames so the status
    file shows observable progress while frames render."""
    vtus = find_all_vtus(case_dir)
    times = [_vtu_time(v) for v in vtus]
    picks = nearest_vtu_indices(times, target_times)
    if len(picks) > FRAME_TRACK_MAX_FRAMES:
        picks = _subsample(picks, FRAME_TRACK_MAX_FRAMES)
    if len(picks) < 2:
        return [], []
    chosen = [vtus[k] for k in picks]
    chosen_times = [float(times[k]) for k in picks]

    airfoil_xy = airfoil_contour_unit * chord
    mask, f2d = _build_triangulation(meshio.read(chosen[0]), airfoil_xy)
    per_field: dict[ImageField, list[np.ndarray]] = {f: [] for f in fields}
    failed: set[ImageField] = set()
    for vtu in chosen:
        mesh = meshio.read(vtu)
        for field in fields:
            if field in failed:
                continue
            try:
                per_field[field].append(_field_values(mesh, mask, f2d, field, freestream_speed))
            except (KeyError, ValueError):
                failed.add(field)

    xlim = (-zoom_chords * chord, (1.0 + zoom_chords) * chord)
    ylim = (-zoom_chords * chord, zoom_chords * chord)
    dpi = 100
    width_px = max(64, int(width_px))
    height_px = max(64, int(round(width_px * (ylim[1] - ylim[0]) / (xlim[1] - xlim[0]))))

    rendered: list[str] = []
    renderable = [f for f in fields if f not in failed and len(per_field.get(f, [])) == len(chosen)]
    total_frames = len(chosen) * len(renderable)
    frames_done = 0
    for field in renderable:
        if deadline is not None and time.monotonic() >= deadline:
            break
        frames_vals = per_field[field]
        vmin, vmax = _robust_frame_track_scale(field, frames_vals)
        _label, cmap = _FIELD_STYLE[field]
        field_dir = out_root / field.value
        field_dir.mkdir(parents=True, exist_ok=True)
        complete = True
        for i, values in enumerate(frames_vals):
            if deadline is not None and time.monotonic() >= deadline:
                # Budget hit mid-sequence: a partial sequence must never ship
                # (the frame player pins frame index <-> coefficient samples),
                # so the incomplete field directory is removed entirely.
                complete = False
                break
            fig = plt.figure(figsize=(width_px / dpi, height_px / dpi), dpi=dpi)
            ax = fig.add_axes((0.0, 0.0, 1.0, 1.0))
            ax.set_axis_off()
            ax.tricontourf(
                f2d.triang,
                values,
                levels=FRAME_TRACK_RENDER_LEVELS,
                cmap=cmap,
                extend="both",
                vmin=vmin,
                vmax=vmax,
            )
            ax.fill(airfoil_xy[:, 0], airfoil_xy[:, 1], color="white", zorder=3)
            ax.plot(airfoil_xy[:, 0], airfoil_xy[:, 1], color="black", lw=1.0, zorder=4)
            ax.set_xlim(*xlim)
            ax.set_ylim(*ylim)
            fig.savefig(field_dir / f"f{i:04d}.png", dpi=dpi)
            plt.close(fig)
            frames_done += 1
            if progress is not None and (frames_done % 10 == 0 or frames_done == total_frames):
                progress(f"rendering frames {frames_done}/{total_frames}")
        if complete:
            rendered.append(field.value)
        else:
            shutil.rmtree(field_dir, ignore_errors=True)
            break
    return chosen_times, rendered


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
        if field == ImageField.vorticity:
            # Curl is linear: vorticity(mean U) == mean(vorticity(U_i)) under
            # the linear gradient operator — one gradient application total.
            u_acc = None
            for vtu in selected:
                uv = np.asarray(meshio.read(vtu).point_data["U"])[mask][:, :2]
                u_acc = uv if u_acc is None else u_acc + uv
            assert u_acc is not None
            u_mean = u_acc / len(selected)
            values = compute_vorticity(f2d.triang, u_mean[:, 0], u_mean[:, 1])
        else:
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
