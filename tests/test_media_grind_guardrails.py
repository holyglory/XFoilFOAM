"""Guardrails for the 2026-07-07 render-grind incident (no OpenFOAM, no real
solves): the per-frame CubicTriInterpolator CG solve is GONE, the mean-contour
pass averages-then-renders, the media stage has a wall budget that degrades
loudly, the post-solve block reports JobPhase.postprocessing with observable
progress, the engine-side stall detector condemns frozen tasks (and SPARES
healthy quiet ones), and the celery hard time limit is config-derived."""
import json
import math
import os
import time as time_mod
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import matplotlib

matplotlib.use("Agg")
import matplotlib.tri as mtri  # noqa: E402
import meshio  # noqa: E402
import numpy as np  # noqa: E402
import pytest  # noqa: E402

from airfoilfoam import pipeline, tasks  # noqa: E402
from airfoilfoam.config import Settings  # noqa: E402
from airfoilfoam.models import (  # noqa: E402
    CaseSpec,
    FluidProperties,
    ImageField,
    JobPhase,
    JobResult,
    JobState,
    JobStatus,
    MeshParams,
    RoughnessParams,
    SolverParams,
)
from airfoilfoam.pipeline import CaseOutcome, TransientResult, UransQuality, _finalize_outcome  # noqa: E402
from airfoilfoam.postprocess import images  # noqa: E402
from airfoilfoam.postprocess.images import (  # noqa: E402
    TriGradientOperator,
    compute_vorticity,
    render_animations,
    render_frame_track_images,
    render_mean_contours,
)
from airfoilfoam.postprocess.unsteady import ForceHistory  # noqa: E402
from airfoilfoam.storage import JobStore  # noqa: E402


def _bomb_cubic(monkeypatch):
    """Any CubicTriInterpolator construction fails the test instantly — the
    fast structural signal that the per-frame CG grind came back."""

    def boom(*_a, **_k):
        raise AssertionError("CubicTriInterpolator must never be constructed in render paths")

    monkeypatch.setattr(mtri, "CubicTriInterpolator", boom)
    monkeypatch.setattr(matplotlib.tri, "CubicTriInterpolator", boom)
    # The OLD prod file bound the class via a module-level `from matplotlib.tri
    # import CubicTriInterpolator` — that binding happens at import time, so
    # patching only the mtri module attribute misses a literal revert
    # (verified empirically 2026-07-07: the reverted test escaped the bomb and
    # ground for hours). Patch any such module-level binding too.
    monkeypatch.setattr(images, "CubicTriInterpolator", boom, raising=False)


# --------------------------------------------------------------------------- #
# 1a. must-catch grind ceiling + numeric parity of the linear vorticity scheme
# --------------------------------------------------------------------------- #


def test_vorticity_140_frames_on_1e5_nodes_under_hard_ceiling(monkeypatch):
    # MUST-CATCH: prod py-spy showed TWO CubicTriInterpolator builds PER FRAME
    # x 141 frames on a refined mesh (~30-60 s of CG per frame => hours). The
    # replacement is a precomputed linear gradient operator: 140 frames on a
    # ~1e5-node triangulation must finish in seconds. 30 s is the hard CI
    # ceiling (measured ~2 s locally); a revert to per-frame CG blows past it
    # by orders of magnitude and also trips the constructor bomb.
    _bomb_cubic(monkeypatch)
    n = 317  # 317^2 = 100489 nodes
    xs = np.linspace(0.0, 1.0, n)
    gx, gy = np.meshgrid(xs, xs)
    x, y = gx.ravel(), gy.ravel()
    started = time_mod.perf_counter()
    triang = mtri.Triangulation(x, y)
    for i in range(140):
        u = np.sin(x * 3.0 + 0.01 * i) - y
        v = np.cos(y * 2.0 + 0.02 * i) + x
        wz = compute_vorticity(triang, u, v)
        assert wz.shape == x.shape
        # Checked INSIDE the loop so a slow revert fails after ~30s + one
        # frame instead of grinding through all 140 frames (hours) before the
        # post-loop assert — a revert must FAIL fast, not hang CI.
        elapsed = time_mod.perf_counter() - started
        assert elapsed < 30.0, (
            f"vorticity frame {i + 1}/140 at {elapsed:.1f}s — per-frame grind is back"
        )


def test_vorticity_linear_scheme_parity_with_cubic_within_contour_band():
    # Visual parity bar: renders use 40 contour bands, so the linear scheme
    # must agree with the cubic min-E gradient within one band (range/40) on a
    # smooth analytic flow. Measured on this fixture: max |lin-cub| = 1.7% of
    # range vs a 2.5% band width; p95 = 0.8%. Both schemes are also checked
    # against the analytic curl so the reference itself is validated.
    xs = np.linspace(0.0, 2.0, 61)
    gx, gy = np.meshgrid(xs, xs)
    x, y = gx.ravel(), gy.ravel()
    triang = mtri.Triangulation(x, y)
    u = np.sin(1.7 * x) * np.cos(1.3 * y)
    v = np.cos(0.9 * x) * np.sin(1.9 * y)
    wz_true = -0.9 * np.sin(0.9 * x) * np.sin(1.9 * y) + 1.3 * np.sin(1.7 * x) * np.sin(1.3 * y)

    wz_lin = compute_vorticity(triang, u, v)

    from matplotlib.tri import CubicTriInterpolator

    iu = CubicTriInterpolator(triang, u)
    iv = CubicTriInterpolator(triang, v)
    _, dudy = iu.gradient(triang.x, triang.y)
    dvdx, _ = iv.gradient(triang.x, triang.y)
    wz_cub = np.ma.filled(
        np.ma.masked_invalid(np.asarray(dvdx, float) - np.asarray(dudy, float)), 0.0
    )

    band = float(wz_cub.max() - wz_cub.min()) / 40.0  # one contour band
    diff = np.abs(wz_lin - wz_cub)
    assert float(diff.max()) < band
    assert float(np.percentile(diff, 95)) < 0.5 * band
    # sanity: both schemes track the analytic vorticity on the interior
    interior = (x > 0.1) & (x < 1.9) & (y > 0.1) & (y < 1.9)
    assert float(np.percentile(np.abs(wz_lin - wz_true)[interior], 95)) < 0.5 * band


def test_gradient_operator_cached_on_triangulation():
    xs = np.linspace(0.0, 1.0, 12)
    gx, gy = np.meshgrid(xs, xs)
    triang = mtri.Triangulation(gx.ravel(), gy.ravel())
    compute_vorticity(triang, gx.ravel(), gy.ravel())
    op1 = triang._airfoilfoam_grad_op
    compute_vorticity(triang, gy.ravel(), gx.ravel())
    assert triang._airfoilfoam_grad_op is op1  # reused, not rebuilt per frame


# --------------------------------------------------------------------------- #
# 1b/1c. mean contours: one read per VTU, ONE gradient build, render once per
# field; animations: one read per VTU for ALL fields
# --------------------------------------------------------------------------- #


def _write_vtu_sequence(root: Path, times, with_p=True):
    """Small extruded grid in the prod foamToVTK layout (index-named dirs +
    .series time map), with U (+ optionally p) point data."""
    xs = np.linspace(-1.0, 2.0, 9)
    ys = np.linspace(-1.0, 1.0, 7)
    xx, yy = np.meshgrid(xs, ys)
    layer = np.column_stack([xx.ravel(), yy.ravel()])
    pts = np.vstack(
        [
            np.column_stack([layer, np.zeros(len(layer))]),
            np.column_stack([layer, np.full(len(layer), 0.1)]),
        ]
    )
    vtk = root / "VTK"
    series = {"file-series-version": "1.0", "files": []}
    for i, t in enumerate(times):
        u = np.column_stack(
            [10.0 + np.sin(pts[:, 0] * 3.0 + t * 50.0), pts[:, 1] * 0.5, np.zeros(len(pts))]
        )
        data = {"U": u}
        if with_p:
            data["p"] = pts[:, 0] * 2.0 + t
        mesh = meshio.Mesh(
            pts, [("vertex", np.arange(len(pts)).reshape(-1, 1))], point_data=data
        )
        d = vtk / f"transient_{i}"
        d.mkdir(parents=True, exist_ok=True)
        meshio.write(d / "internal.vtu", mesh)
        series["files"].append({"name": f"transient_{i}.vtm", "time": t})
    (vtk / "transient.vtm.series").write_text(json.dumps(series))


_CONTOUR = np.array([[0.4, -0.05], [0.6, -0.05], [0.6, 0.05], [0.4, 0.05], [0.4, -0.05]])


def test_mean_contours_average_then_render_single_gradient(tmp_path, monkeypatch):
    _bomb_cubic(monkeypatch)
    times = [0.00, 0.01, 0.02, 0.03, 0.04]
    _write_vtu_sequence(tmp_path, times)

    reads = {"n": 0}
    real_read = images.meshio.read

    def counting_read(*a, **k):
        reads["n"] += 1
        return real_read(*a, **k)

    monkeypatch.setattr(images.meshio, "read", counting_read)

    builds = {"n": 0}
    real_init = TriGradientOperator.__init__

    def counting_init(self, triang):
        builds["n"] += 1
        real_init(self, triang)

    monkeypatch.setattr(TriGradientOperator, "__init__", counting_init)

    import matplotlib.pyplot as plt

    contourf_calls = []
    real_contourf = plt.Axes.tricontourf

    def counting_contourf(self, *a, **k):
        contourf_calls.append(1)
        return real_contourf(self, *a, **k)

    monkeypatch.setattr(plt.Axes, "tricontourf", counting_contourf)

    fields = [ImageField.vorticity, ImageField.velocity_magnitude, ImageField.pressure]
    out = render_mean_contours(tmp_path, tmp_path / "img", _CONTOUR, 1.0, fields, freestream_speed=10.0)

    assert set(out) == {"vorticity", "velocity_magnitude", "pressure"}
    # one read for the triangulation frame + exactly one per VTU frame
    assert reads["n"] == len(times) + 1
    # the gradient operator (the old per-frame CG's replacement) is built ONCE
    # for the whole mean pass, and each field is rendered exactly once
    assert builds["n"] == 1
    assert len(contourf_calls) == len(fields)


def test_mean_vorticity_equals_mean_of_per_frame_vorticity(tmp_path):
    # Linearity pin: curl(mean U) == mean(curl U_i) under the linear operator,
    # so averaging fields first (one gradient) loses nothing.
    times = [0.00, 0.01, 0.02]
    _write_vtu_sequence(tmp_path, times)
    vtus = images.find_all_vtus(tmp_path)
    mask, f2d = images._build_triangulation(meshio.read(vtus[0]), _CONTOUR)
    per_frame = []
    u_sum = None
    for v in vtus:
        uv = np.asarray(meshio.read(v).point_data["U"])[mask][:, :2]
        per_frame.append(compute_vorticity(f2d.triang, uv[:, 0], uv[:, 1]))
        u_sum = uv if u_sum is None else u_sum + uv
    mean_of_frames = np.mean(per_frame, axis=0)
    u_mean = u_sum / len(vtus)
    vort_of_mean = compute_vorticity(f2d.triang, u_mean[:, 0], u_mean[:, 1])
    np.testing.assert_allclose(vort_of_mean, mean_of_frames, rtol=1e-10, atol=1e-10)


def test_render_animations_reads_each_vtu_once_for_all_fields(tmp_path, monkeypatch):
    _bomb_cubic(monkeypatch)
    times = [0.00, 0.01, 0.02, 0.03]
    _write_vtu_sequence(tmp_path, times)

    reads = {"n": 0}
    real_read = images.meshio.read

    def counting_read(*a, **k):
        reads["n"] += 1
        return real_read(*a, **k)

    monkeypatch.setattr(images.meshio, "read", counting_read)

    fields = [
        ImageField.vorticity,
        ImageField.velocity_magnitude,
        ImageField.pressure,
        ImageField.turbulent_kinetic_energy,  # absent: skipped by omission
    ]
    batch = render_animations(tmp_path, tmp_path / "img", _CONTOUR, 1.0, fields, freestream_speed=10.0)

    # the old per-field loop read len(fields) * (len(vtus) + 1) times
    assert reads["n"] == len(times) + 1
    assert batch.errors == {}
    assert "turbulent_kinetic_energy" not in batch.videos
    from matplotlib.animation import FFMpegWriter

    if FFMpegWriter.isAvailable():
        assert set(batch.videos) == {"vorticity", "velocity_magnitude", "pressure"}
        for name in batch.videos.values():
            assert (tmp_path / "img" / name).stat().st_size > 0


def test_render_animations_missing_ffmpeg_fails_loud_before_vtu_io(tmp_path, monkeypatch):
    """A missing host encoder is unavailable evidence, not a silent empty map."""
    from matplotlib.animation import FFMpegWriter

    monkeypatch.setattr(FFMpegWriter, "isAvailable", lambda: False)

    def unexpected_vtu_read(*_args, **_kwargs):
        raise AssertionError("ffmpeg preflight must run before VTU discovery or reads")

    monkeypatch.setattr(images, "find_all_vtus", unexpected_vtu_read)
    fields = [ImageField.velocity_magnitude, ImageField.vorticity]

    batch = render_animations(
        tmp_path,
        tmp_path / "img",
        _CONTOUR,
        1.0,
        fields,
        freestream_speed=10.0,
    )

    assert batch.videos == {}
    assert batch.budget_skipped == []
    assert batch.errors == {
        "velocity_magnitude": "ffmpeg executable is unavailable on PATH",
        "vorticity": "ffmpeg executable is unavailable on PATH",
    }


def test_render_animations_available_ffmpeg_does_not_report_false_errors(tmp_path, monkeypatch):
    """The dependency preflight must not suppress the normal encode path."""
    from matplotlib.animation import FFMpegWriter

    times = [0.00, 0.01, 0.02]
    _write_vtu_sequence(tmp_path, times)
    monkeypatch.setattr(FFMpegWriter, "isAvailable", lambda: True)

    def write_stub(path, _draw, _n_frames, **_kwargs):
        path.write_bytes(b"real-encoder-path-was-selected")
        return path

    monkeypatch.setattr(images, "write_animation_mp4", write_stub)

    batch = render_animations(
        tmp_path,
        tmp_path / "img",
        _CONTOUR,
        1.0,
        [ImageField.velocity_magnitude],
        freestream_speed=10.0,
    )

    assert batch.errors == {}
    assert batch.budget_skipped == []
    assert batch.videos == {"velocity_magnitude": "velocity_magnitude.mp4"}
    assert (tmp_path / "img" / "velocity_magnitude.mp4").read_bytes() == (
        b"real-encoder-path-was-selected"
    )


def test_render_animations_expired_deadline_reports_budget_skips(tmp_path):
    times = [0.00, 0.01, 0.02]
    _write_vtu_sequence(tmp_path, times)
    batch = render_animations(
        tmp_path,
        tmp_path / "img",
        _CONTOUR,
        1.0,
        [ImageField.velocity_magnitude, ImageField.pressure],
        freestream_speed=10.0,
        deadline=time_mod.monotonic() - 1.0,
    )
    assert batch.videos == {}
    assert batch.budget_skipped == ["velocity_magnitude", "pressure"]


# --------------------------------------------------------------------------- #
# frame-track export: progress token cadence + deadline never ships partials
# --------------------------------------------------------------------------- #


def test_frame_track_progress_cadence_every_10_frames(tmp_path):
    times = [round(0.01 * i, 4) for i in range(12)]
    _write_vtu_sequence(tmp_path, times)
    messages = []

    frame_times, rendered = render_frame_track_images(
        tmp_path,
        tmp_path / "frames",
        _CONTOUR,
        1.0,
        [ImageField.velocity_magnitude],
        target_times=times,
        freestream_speed=10.0,
        zoom_chords=0.5,
        progress=messages.append,
    )

    assert rendered == ["velocity_magnitude"]
    assert len(frame_times) == 12
    assert messages == ["rendering frames 10/12", "rendering frames 12/12"]


def test_frame_track_deadline_never_ships_partial_field_sequences(tmp_path):
    times = [round(0.01 * i, 4) for i in range(8)]
    _write_vtu_sequence(tmp_path, times)
    out = tmp_path / "frames"

    frame_times, rendered = render_frame_track_images(
        tmp_path,
        out,
        _CONTOUR,
        1.0,
        [ImageField.velocity_magnitude, ImageField.pressure],
        target_times=times,
        freestream_speed=10.0,
        zoom_chords=0.5,
        deadline=time_mod.monotonic() + 0.05,  # enough for at most a few PNGs
    )

    # Whatever the budget allowed, the contract holds: a field is either fully
    # rendered or absent — no partial PNG directory may ship.
    for field in ("velocity_magnitude", "pressure"):
        pngs = sorted((out / field).glob("*.png")) if (out / field).exists() else []
        if field in rendered:
            assert len(pngs) == len(times)
        else:
            assert pngs == []


# --------------------------------------------------------------------------- #
# 2 + 3. media budget breach degrades loudly; postprocessing phase is emitted
# --------------------------------------------------------------------------- #


class _FakeRunner:
    def application(self, *_args, **_kwargs):
        return SimpleNamespace(ok=True, check=lambda: None)


def _fake_transient(tmp_path):
    avg = SimpleNamespace(cl=0.45, cd=0.08, cm=-0.02, cl_cd=5.6, cl_std=0.01, cd_std=0.002, cm_std=0.001)
    transient = tmp_path / "transient"
    transient.mkdir(exist_ok=True)
    period = 0.25
    times = np.linspace(0.0, 3.0, 1201)
    phase = 2.0 * math.pi * times / period
    cl = 0.45 + 0.05 * np.sin(phase)
    cd = 0.08 + 0.005 * np.cos(phase)
    cm = -0.02 + 0.002 * np.sin(phase)
    coeff = transient / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    coeff.parent.mkdir(parents=True, exist_ok=True)
    rows = [
        "# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"
    ]
    rows.extend(
        f"{t:.8g} {drag:.8g} 0 0 {lift:.8g} 0 0 {moment:.8g} 0 0 0 0 0"
        for t, lift, drag, moment in zip(times, cl, cd, cm)
    )
    coeff.write_text("\n".join(rows) + "\n")
    history = ForceHistory(
        t=times.tolist(),
        cl=cl.tolist(),
        cd=cd.tolist(),
        cm=cm.tolist(),
        cl_mean=float(cl.mean()),
        cl_rms=float(cl.std()),
        cd_mean=float(cd.mean()),
        cd_rms=float(cd.std()),
        cm_mean=float(cm.mean()),
        cm_rms=float(cm.std()),
        shedding_freq_hz=1.0 / period,
        strouhal=(1.0 / period) / 10.0,
        samples=len(times),
        period_s=period,
        retained_cycles=12,
        window_start=float(times[0]),
        window_end=float(times[-1]),
    )
    return TransientResult(
        avg=avg,
        case_dir=transient,
        force_history=history,
        quality=UransQuality(
            ok=True,
            can_refine=False,
            reason="ok",
            measured_period_s=period,
            retained_cycles=12,
        ),
        start_time=0.0,
        end_time=3.0,
        run_time=3.0,
        coeff_paths=[coeff],
    )


def _finalize(tmp_path, monkeypatch, *, media_budget_s, phase_progress=None, render_images=True):
    monkeypatch.setattr(pipeline, "_run_transient", lambda case_dir, *a, **k: _fake_transient(tmp_path))
    outcome = CaseOutcome(spec=CaseSpec(chord=1.0, speed=10.0, aoa_deg=12.0), reynolds=666_666)
    _finalize_outcome(
        tmp_path,
        outcome,
        airfoil=SimpleNamespace(name="unit airfoil", contour=[]),
        resolved=MeshParams(),
        spec=outcome.spec,
        fluid=FluidProperties(density=1.225, kinematic_viscosity=1.5e-5),
        roughness=RoughnessParams(),
        solver_params=SolverParams(
            force_transient=True,
            write_images=[ImageField.velocity_magnitude],
            frame_fields=[],
        ),
        runner=_FakeRunner(),
        n_proc=1,
        render_images=render_images,
        solver_timeout=7200,
        phase_progress=phase_progress,
        case_slug="unit/case",
        media_budget_s=media_budget_s,
    )
    return outcome


def test_media_budget_breach_completes_with_partial_artifacts_and_loud_warning(tmp_path, monkeypatch):
    def slow_instant(*_a, **_k):
        time_mod.sleep(0.3)  # blows through the 0.25 s budget below
        return {"velocity_magnitude": "velocity_magnitude.png"}

    monkeypatch.setattr(pipeline, "render_contours", slow_instant)
    mean_calls = []
    monkeypatch.setattr(pipeline, "render_mean_contours", lambda *a, **k: mean_calls.append(1) or {})
    anim_calls = []
    monkeypatch.setattr(pipeline, "render_animations", lambda *a, **k: anim_calls.append(1))

    outcome = _finalize(tmp_path, monkeypatch, media_budget_s=0.25)

    # the job COMPLETED with what rendered before the budget ran out ...
    assert outcome.converged
    assert outcome.error is None
    assert outcome.images == {"velocity_magnitude": "images/velocity_magnitude.png"}
    # ... later stages were skipped, not attempted
    assert mean_calls == [] and anim_calls == []
    assert outcome.mean_images == {} and outcome.video == {}
    warning = next(w for w in outcome.quality_warnings if "media rendering budget exhausted" in w)
    assert "rendered 1 of 3 artifacts" in warning
    # evidence manifest records the gaps as unavailable (missing, not invented)
    manifest = json.loads((tmp_path / "evidence" / "evidence_manifest.json").read_text())
    assert manifest["media"]["unavailable"]["mean"] == ["velocity_magnitude"]
    assert manifest["media"]["unavailable"]["video"] == ["velocity_magnitude"]


def test_media_budget_zero_skips_all_renders_but_job_completes(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(pipeline, "render_contours", lambda *a, **k: calls.append("inst") or {})
    monkeypatch.setattr(pipeline, "render_mean_contours", lambda *a, **k: calls.append("mean") or {})
    monkeypatch.setattr(pipeline, "render_animations", lambda *a, **k: calls.append("anim"))

    outcome = _finalize(tmp_path, monkeypatch, media_budget_s=0.0)

    assert calls == []
    assert outcome.error is None and outcome.converged
    warning = next(w for w in outcome.quality_warnings if "media rendering budget exhausted" in w)
    assert "rendered 0 of 3 artifacts" in warning


def test_generous_budget_renders_without_budget_warning(tmp_path, monkeypatch):
    monkeypatch.setattr(
        pipeline, "render_contours", lambda *a, **k: {"velocity_magnitude": "velocity_magnitude.png"}
    )
    monkeypatch.setattr(
        pipeline, "render_mean_contours", lambda *a, **k: {"velocity_magnitude": "velocity_magnitude_mean.png"}
    )
    from airfoilfoam.postprocess.images import AnimationBatchResult

    monkeypatch.setattr(
        pipeline,
        "render_animations",
        lambda *a, **k: AnimationBatchResult(
            videos={"velocity_magnitude": "velocity_magnitude.mp4"}, errors={}, budget_skipped=[]
        ),
    )

    outcome = _finalize(tmp_path, monkeypatch, media_budget_s=3600.0)

    assert not any("budget exhausted" in w for w in outcome.quality_warnings)
    assert outcome.video == {"velocity_magnitude": "images/velocity_magnitude.mp4"}


def test_postprocessing_phase_emitted_with_progress_messages(tmp_path, monkeypatch):
    events = []

    def spy(phase, aoa, slug, solver, message=None):
        events.append((phase, aoa, slug, solver, message))

    monkeypatch.setattr(pipeline, "render_contours", lambda *a, **k: {})
    monkeypatch.setattr(pipeline, "render_mean_contours", lambda *a, **k: {})
    from airfoilfoam.postprocess.images import AnimationBatchResult

    monkeypatch.setattr(
        pipeline,
        "render_animations",
        lambda *a, **k: AnimationBatchResult(videos={}, errors={}, budget_skipped=[]),
    )

    _finalize(tmp_path, monkeypatch, media_budget_s=3600.0, phase_progress=spy)

    assert events, "postprocessing phase was never emitted"
    phases = {e[0] for e in events}
    assert phases == {JobPhase.postprocessing}
    assert events[0][1] == pytest.approx(12.0)  # aoa
    assert events[0][2] == "unit/case"  # slug
    assert any("postprocessing" in (e[4] or "") for e in events)
    # progress tokens for the render stages are observable status messages
    assert any("rendering" in (e[4] or "") for e in events[1:])


def test_write_status_phase_transition_bumps_last_progress_at(tmp_path):
    store = JobStore(Settings(data_dir=tmp_path / "data"))
    store.write_status(JobStatus(job_id="j1", state=JobState.running, phase=JobPhase.solving_urans))
    first = store.read_status("j1")
    time_mod.sleep(0.01)
    store.write_status(JobStatus(job_id="j1", state=JobState.running, phase=JobPhase.solving_urans))
    same_phase = store.read_status("j1")
    assert same_phase.last_progress_at == first.last_progress_at  # no fake progress
    time_mod.sleep(0.01)
    store.write_status(JobStatus(job_id="j1", state=JobState.running, phase=JobPhase.postprocessing))
    transitioned = store.read_status("j1")
    assert transitioned.last_progress_at is not None
    assert first.last_progress_at is None or transitioned.last_progress_at > first.last_progress_at
    assert transitioned.phase_started_at >= same_phase.phase_started_at


# --------------------------------------------------------------------------- #
# 4. engine-side stall detector: condemns frozen tokens, SPARES healthy quiet
# --------------------------------------------------------------------------- #

_OLD = datetime.now(timezone.utc) - timedelta(hours=3)


def _running_status(phase: JobPhase, updated_ago_s: float = 3 * 3600.0) -> JobStatus:
    stamp = datetime.now(timezone.utc) - timedelta(seconds=updated_ago_s)
    return JobStatus(
        job_id="j1",
        state=JobState.running,
        phase=phase,
        updated_at=stamp,
        last_progress_at=stamp,
        phase_started_at=stamp,
    )


def test_stall_detector_condemns_frozen_solving_and_postprocessing():
    # MUST-CATCH (the incident shape): state=running, phase frozen, zero
    # OpenFOAM processes, every progress token hours old.
    now = time_mod.time()
    for phase in (JobPhase.solving_urans, JobPhase.solving_rans, JobPhase.postprocessing):
        reason = tasks.stall_reason(_running_status(phase), 0, now - 3 * 3600.0, now, 20 * 60.0)
        assert reason is not None
        assert reason.startswith(f"stalled in {phase.value} — no progress for ")
        assert reason.endswith(("179m", "180m"))  # ~3 h quiet, minute-rounded


def test_stall_detector_spares_live_pimplefoam_march():
    # FALSE-POSITIVE GUARD: a legitimate long march has live pids — never
    # condemned regardless of token age.
    now = time_mod.time()
    status = _running_status(JobPhase.solving_urans)
    assert tasks.stall_reason(status, 1, now - 3 * 3600.0, now, 20 * 60.0) is None


def test_stall_detector_spares_advancing_tokens_and_quiet_phases():
    now = time_mod.time()
    # advancing coefficient.dat / frame counter (fresh on-disk token), even
    # with no visible process (docker-runner solves, in-process rendering)
    status = _running_status(JobPhase.solving_urans)
    assert tasks.stall_reason(status, 0, now - 30.0, now, 20 * 60.0) is None
    status = _running_status(JobPhase.postprocessing)
    assert tasks.stall_reason(status, 0, now - 30.0, now, 20 * 60.0) is None
    # fresh status.json (message/phase updates bump updated_at)
    fresh = _running_status(JobPhase.postprocessing, updated_ago_s=30.0)
    assert tasks.stall_reason(fresh, 0, None, now, 20 * 60.0) is None
    # legitimately quiet phases are never monitored
    for phase in (JobPhase.waiting_cpu, JobPhase.meshing, JobPhase.ingesting, JobPhase.pending):
        assert tasks.stall_reason(_running_status(phase), 0, None, now, 20 * 60.0) is None
    # terminal/non-running states are left alone
    done = _running_status(JobPhase.solving_urans)
    done.state = JobState.completed
    assert tasks.stall_reason(done, 0, None, now, 20 * 60.0) is None
    assert tasks.stall_reason(None, 0, None, now, 20 * 60.0) is None


def test_newest_progress_file_mtime_tracks_coeffs_frames_and_vtus(tmp_path):
    job_dir = tmp_path / "job"
    coeff = job_dir / "cases" / "c1_u25" / "transient" / "postProcessing" / "forceCoeffs1" / "0.4" / "coefficient.dat"
    coeff.parent.mkdir(parents=True)
    coeff.write_text("# t cl cd\n0.4 0.5 0.05\n")
    old = time_mod.time() - 3 * 3600.0
    os.utime(coeff, (old, old))
    assert tasks.newest_progress_file_mtime(job_dir) == pytest.approx(old, abs=2.0)

    # an advancing frame PNG is a progress token (media stage IS advancing)
    png = job_dir / "cases" / "c1_u25" / "a0" / "frames" / "vorticity" / "f0003.png"
    png.parent.mkdir(parents=True)
    png.write_bytes(b"\x89PNG")
    fresh = tasks.newest_progress_file_mtime(job_dir)
    assert fresh is not None and fresh > old + 3000

    # an advancing foamToVTK conversion (docker runner: no visible pid) too
    os.utime(png, (old, old))
    vtu = job_dir / "cases" / "c1_u25" / "transient" / "VTK" / "transient_9" / "internal.vtu"
    vtu.parent.mkdir(parents=True)
    vtu.write_text("<VTKFile/>")
    fresh = tasks.newest_progress_file_mtime(job_dir)
    assert fresh is not None and fresh > old + 3000

    # unrelated files (logs, field writes) are not progress tokens
    assert tasks.newest_progress_file_mtime(tmp_path / "nowhere") is None


def test_parallel_runtime_case_observation_keeps_slug_and_aoa_from_one_case():
    """MUST-CATCH: a live am4 process must never inherit am5's global AoA."""
    from airfoilfoam.models import AirfoilInput, AoASpec, PolarRequest

    request = PolarRequest(
        airfoil=AirfoilInput(name="unit", points=[[1.0, 0.0], [0.0, 0.0], [1.0, 0.0]]),
        aoa=AoASpec(angles=[-5.0, -4.0]),
    )
    cases = {case.aoa_deg: case for case in request.cases()}
    status = JobStatus(
        job_id="parallel",
        state=JobState.running,
        # Another future most recently reported postprocessing.  The selected
        # live pimpleFoam process still owns a coherent URANS runtime tuple.
        phase=JobPhase.postprocessing,
        active_case_slug=cases[-5.0].slug,
        active_aoa_deg=-5.0,
    )
    processes = [
        {
            "pid": 41,
            "command": "pimpleFoam",
            "case_slug": cases[-4.0].slug,
            "solver_mode": "urans",
        }
    ]

    _active, slug, aoa = tasks._runtime_active_case(processes, status, request)

    assert _active["command"] == "pimpleFoam"
    assert tasks._runtime_active_phase(_active, status) is JobPhase.solving_urans
    assert slug == cases[-4.0].slug
    assert aoa == pytest.approx(-4.0)


def test_parallel_runtime_case_observation_never_borrows_unrelated_aoa():
    """FALSE-POSITIVE GUARD: unknown/nested live slugs report AoA unknown."""
    from airfoilfoam.models import AirfoilInput, AoASpec, PolarRequest

    request = PolarRequest(
        airfoil=AirfoilInput(name="unit", points=[[1.0, 0.0], [0.0, 0.0], [1.0, 0.0]]),
        aoa=AoASpec(angles=[-5.0, -4.0]),
    )
    status = JobStatus(
        job_id="parallel",
        state=JobState.running,
        phase=JobPhase.solving_urans,
        active_case_slug=request.cases()[0].slug,
        active_aoa_deg=-5.0,
    )
    processes = [
        {
            "pid": 42,
            "command": "pimpleFoam",
            "case_slug": "nested-polar-case",
            "solver_mode": "urans",
        }
    ]

    _active, slug, aoa = tasks._runtime_active_case(processes, status, request)

    assert slug == "nested-polar-case"
    assert aoa is None


def test_active_case_progress_mtime_is_targeted_and_never_invented(tmp_path):
    """Only the selected case's real coefficient append advances progress."""
    job_dir = tmp_path / "job"
    active_slug = "c1_u50_am4"
    sibling_slug = "c1_u50_am5"
    active = (
        job_dir
        / "cases"
        / active_slug
        / "transient"
        / "postProcessing"
        / "forceCoeffs1"
        / "0.02"
        / "coefficient.dat"
    )
    sibling = (
        job_dir
        / "cases"
        / sibling_slug
        / "transient"
        / "postProcessing"
        / "forceCoeffs1"
        / "0.02"
        / "coefficient.dat"
    )
    active.parent.mkdir(parents=True)
    sibling.parent.mkdir(parents=True)
    active.write_text("# Time Cl\n0.02 0.1\n")
    sibling.write_text("# Time Cl\n0.02 0.2\n")
    active_mtime = time_mod.time() - 30.0
    sibling_mtime = time_mod.time() - 1.0
    os.utime(active, (active_mtime, active_mtime))
    os.utime(sibling, (sibling_mtime, sibling_mtime))

    assert tasks._active_case_progress_mtime(job_dir, active_slug) == pytest.approx(
        active_mtime, abs=2.0
    )
    assert tasks._active_case_progress_mtime(job_dir, "missing") is None
    assert tasks._active_case_progress_mtime(job_dir, None) is None


def test_parallel_runtime_progress_never_borrows_newer_sibling_status_token():
    """A busy sibling must not make a stale representative case look fresh."""

    now = datetime.now(timezone.utc)
    stale_active_token = now - timedelta(hours=2)
    sibling_status = JobStatus(
        job_id="parallel-progress",
        state=JobState.running,
        phase=JobPhase.postprocessing,
        active_case_slug="c1_u50_am5",
        active_aoa_deg=-5.0,
        last_progress_at=now,
    )
    active_process = {
        "pid": 42,
        "command": "pimpleFoam",
        "case_slug": "c1_u50_am4",
        "solver_mode": "urans",
    }

    observed = tasks._runtime_last_progress_at(
        active_process,
        sibling_status,
        stale_active_token.timestamp(),
    )

    assert observed == stale_active_token
    # The same-case status token remains valid, and when process inspection has
    # no representative the singular status is still the best available token.
    sibling_status.active_case_slug = active_process["case_slug"]
    assert (
        tasks._runtime_last_progress_at(
            active_process,
            sibling_status,
            stale_active_token.timestamp(),
        )
        == now
    )
    assert tasks._runtime_last_progress_at(None, sibling_status, None) == now


def _write_stale_running_job(store: JobStore, job_id: str, phase: JobPhase) -> None:
    status = JobStatus(
        job_id=job_id,
        state=JobState.running,
        phase=phase,
        updated_at=_OLD,
        last_progress_at=_OLD,
        phase_started_at=_OLD,
        started_at=_OLD,
    )
    path = store.job_dir(job_id) / "status.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(status.model_dump_json(indent=2))


def test_check_and_condemn_marks_failed_and_exits_child(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data", stall_no_progress_minutes=20)
    store = JobStore(settings)
    _write_stale_running_job(store, "jstall", JobPhase.solving_urans)

    exits = []

    def fake_exit(code):
        exits.append(code)
        raise SystemExit(code)

    monkeypatch.setattr(tasks.os, "_exit", fake_exit)

    with pytest.raises(SystemExit):
        tasks._check_and_condemn_stall(store, "jstall", settings)

    assert exits == [tasks.STALLED_TASK_EXIT_CODE]
    status = store.read_status("jstall")
    assert status.state == JobState.failed
    assert status.phase == JobPhase.failed
    assert status.message.startswith("stalled in solving_urans — no progress for ")
    result = store.read_result("jstall")
    assert result.state == JobState.failed
    assert result.message == status.message


def test_check_and_condemn_spares_fresh_status(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data", stall_no_progress_minutes=20)
    store = JobStore(settings)
    store.write_status(JobStatus(job_id="jfresh", state=JobState.running, phase=JobPhase.solving_urans))

    def bomb_exit(code):  # pragma: no cover - only fires on regression
        raise AssertionError(f"os._exit({code}) called for a healthy job")

    monkeypatch.setattr(tasks.os, "_exit", bomb_exit)
    tasks._check_and_condemn_stall(store, "jfresh", settings)  # must return quietly


def test_run_polar_redelivery_discards_terminal_results(tmp_path, monkeypatch):
    from airfoilfoam.models import AoASpec, PolarRequest

    settings = Settings(data_dir=tmp_path / "data")
    store = JobStore(settings)
    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(
        tasks, "execute_job", lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not re-execute"))
    )
    request = PolarRequest(
        airfoil={"name": "a", "points": [[1, 0], [0.5, 0.1], [0, 0], [0.5, -0.1], [1, 0]]},
        aoa=AoASpec(angles=[0.0]),
    )
    store.create("jdead", request)
    store.write_result(JobResult(job_id="jdead", state=JobState.failed, message="stalled in postprocessing — no progress for 21m"))

    out = tasks.run_polar("jdead", request.model_dump_json())

    assert out == {"job_id": "jdead", "state": "failed"}


# --------------------------------------------------------------------------- #
# 5. celery hard time limit: config-derived, case-count scaled
# --------------------------------------------------------------------------- #


def test_celery_hard_time_limit_math_derives_from_config():
    from airfoilfoam.celery_app import TASK_TIME_LIMIT_MARGIN_S, celery_app, task_hard_time_limit_s
    from airfoilfoam.config import get_settings

    from airfoilfoam.models import URANS_FIDELITY_BUDGET_S, UransFidelity

    # The solver ceiling in the formula must cover the LARGEST fidelity-tier
    # URANS wall budget (full tier 43200 s > default solver_timeout 7200 s
    # since the 2026-07-07 measured-rate retune) — otherwise celery would
    # SIGKILL healthy full-tier transients mid-run.
    max_urans = max(URANS_FIDELITY_BUDGET_S.values())
    assert max_urans == URANS_FIDELITY_BUDGET_S[UransFidelity.full] == 43200

    settings = Settings(solver_timeout=7200, media_budget_fraction=0.5)
    per_case = 2 * max(7200, max_urans) + 0.5 * 7200 + TASK_TIME_LIMIT_MARGIN_S
    assert task_hard_time_limit_s(settings) == int(math.ceil(per_case))
    assert task_hard_time_limit_s(settings, total_cases=12) == int(math.ceil(12 * per_case))
    assert task_hard_time_limit_s(settings, total_cases=0) == int(math.ceil(per_case))

    other = Settings(solver_timeout=3600, media_budget_fraction=0.25)
    assert task_hard_time_limit_s(other) == int(
        math.ceil(2 * max(3600, max_urans) + 0.25 * 3600 + TASK_TIME_LIMIT_MARGIN_S)
    )

    # A solver_timeout ABOVE every tier budget still drives the ceiling.
    huge = Settings(solver_timeout=100_000, media_budget_fraction=0.25)
    assert task_hard_time_limit_s(huge) == int(
        math.ceil(2 * 100_000 + 0.25 * 100_000 + TASK_TIME_LIMIT_MARGIN_S)
    )

    # Worst-case fit: steady init + two wall-guarded transients + media +
    # margin must fit under the single-case ceiling (full tier, defaults).
    defaults = Settings()
    from airfoilfoam.pipeline import URANS_REFINE_BUDGET_FRACTION

    guard_fraction = URANS_REFINE_BUDGET_FRACTION  # in-run wall guard
    worst = (
        defaults.rans_solver_timeout
        + 2 * guard_fraction * max_urans
        + defaults.media_budget_seconds()
        + TASK_TIME_LIMIT_MARGIN_S
    )
    assert worst <= task_hard_time_limit_s(defaults)

    # the app-level default is wired from the live settings (no magic constant)
    assert celery_app.conf.task_time_limit == task_hard_time_limit_s(get_settings())


def test_media_budget_seconds_helper():
    settings = Settings(solver_timeout=7200, media_budget_fraction=0.5)
    assert settings.media_budget_seconds() == pytest.approx(3600.0)
    assert Settings(solver_timeout=1000, media_budget_fraction=0.1).media_budget_seconds() == pytest.approx(100.0)
