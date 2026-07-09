"""Unit tests for the new render helpers (vorticity + mp4 encoding). No OpenFOAM."""
import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import matplotlib.tri as mtri  # noqa: E402
import meshio  # noqa: E402
import numpy as np  # noqa: E402
import pytest  # noqa: E402

from airfoilfoam.models import ImageField  # noqa: E402
from airfoilfoam.postprocess.images import (  # noqa: E402
    _robust_frame_track_scale,
    compute_field_extents,
    compute_vorticity,
    render_contours,
    write_animation_mp4,
)


def test_compute_vorticity_solid_body_rotation():
    # u = -y, v = x  →  omega_z = dv/dx - du/dy = 1 - (-1) = 2 everywhere.
    xs = np.linspace(-1.0, 1.0, 25)
    gx, gy = np.meshgrid(xs, xs)
    x = gx.ravel()
    y = gy.ravel()
    triang = mtri.Triangulation(x, y)
    wz = compute_vorticity(triang, -y, x)
    assert abs(float(np.median(wz)) - 2.0) < 1e-3
    assert float(np.percentile(np.abs(wz - 2.0), 90)) < 0.05


def test_robust_frame_track_scale_excludes_unsigned_outlier():
    frames = [np.linspace(0.0, 10.0, 1000), np.r_[np.linspace(0.0, 10.0, 999), 5000.0]]

    vmin, vmax = _robust_frame_track_scale(ImageField.velocity_magnitude, frames)

    assert vmin == pytest.approx(0.2, abs=0.2)
    assert 9.0 < vmax < 20.0


def test_robust_frame_track_scale_is_symmetric_for_signed_vorticity():
    frames = [
        np.r_[np.linspace(-8.0, 6.0, 1000), 3000.0],
        np.linspace(-4.0, 7.0, 1000),
    ]

    vmin, vmax = _robust_frame_track_scale(ImageField.vorticity, frames)

    assert vmin == pytest.approx(-vmax)
    assert 7.0 < vmax < 20.0


def test_write_animation_mp4(tmp_path):
    from matplotlib.animation import FFMpegWriter

    if not FFMpegWriter.isAvailable():
        pytest.skip("ffmpeg not available on PATH")

    def draw(ax, i):
        ax.set_xlim(0, 1)
        ax.set_ylim(0, 1)
        ax.add_patch(plt.Circle((i / 10.0, 0.5), 0.1, color="teal"))

    out = write_animation_mp4(tmp_path / "anim.mp4", draw, n_frames=10, fps=10)
    assert out is not None
    assert out.exists()
    assert out.stat().st_size > 1000
    # mp4 container signature: an 'ftyp' box appears in the first bytes.
    assert b"ftyp" in out.read_bytes()[:64]


def _write_minimal_vtu(case_dir):
    vtk_dir = case_dir / "VTK" / "0"
    vtk_dir.mkdir(parents=True)
    xs = np.linspace(-2.0, 3.0, 8)
    ys = np.linspace(-2.0, 2.0, 7)
    gx, gy = np.meshgrid(xs, ys)
    x = gx.ravel()
    y = gy.ravel()
    z = np.zeros_like(x)
    triang = mtri.Triangulation(x, y)
    speed = np.where((x >= -1) & (x <= 2) & (y >= -1) & (y <= 1), 3.0 + x, 99.0)
    mesh = meshio.Mesh(
        points=np.column_stack([x, y, z]),
        cells=[("triangle", triang.triangles)],
        point_data={
            "U": np.column_stack([speed, np.zeros_like(speed), np.zeros_like(speed)]),
            "p": speed,
            "k": speed,
            "nut": speed,
        },
    )
    meshio.write(vtk_dir / "internal.vtu", mesh)


def test_compute_field_extents_uses_render_window(tmp_path):
    _write_minimal_vtu(tmp_path)
    airfoil = np.asarray([[0.0, 0.02], [1.0, 0.0], [0.0, -0.02], [0.0, 0.02]])

    extents = compute_field_extents(
        tmp_path,
        airfoil,
        1.0,
        [ImageField.velocity_magnitude],
        zoom_chords=1.0,
    )

    assert extents["velocity_magnitude"]["max"] < 6.0
    assert extents["velocity_magnitude"]["finite_count"] > 0


def test_render_contours_uses_supplied_field_scale(tmp_path, monkeypatch):
    _write_minimal_vtu(tmp_path)
    airfoil = np.asarray([[0.0, 0.02], [1.0, 0.0], [0.0, -0.02], [0.0, 0.02]])
    calls = []
    original = plt.Axes.tricontourf

    def wrapped(self, *args, **kwargs):
        calls.append(kwargs)
        return original(self, *args, **kwargs)

    monkeypatch.setattr(plt.Axes, "tricontourf", wrapped)
    render_contours(
        tmp_path,
        tmp_path / "images",
        airfoil,
        1.0,
        [ImageField.velocity_magnitude],
        field_scales={ImageField.velocity_magnitude: (0.0, 42.0)},
    )

    assert any(call.get("vmin") == 0.0 and call.get("vmax") == 42.0 for call in calls)
