"""Regression tests for D1/D2: physical-time resolution of index-named
foamToVTK output, loud (never silent) URANS media failures, and the refined
URANS feasibility guard. No OpenFOAM / no real solves."""
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam import pipeline
from airfoilfoam.models import (
    CaseSpec,
    FluidProperties,
    ImageField,
    MeshParams,
    RoughnessParams,
    SolverParams,
)
from airfoilfoam.pipeline import (
    CaseOutcome,
    TransientResult,
    URANS_REFINE_BUDGET_FRACTION,
    UransQuality,
    _finalize_outcome,
)
from airfoilfoam.postprocess.images import _vtu_time, find_all_vtus, select_vtus


# ---------------------------------------------------------------------------
# D1: windowed VTU selection on index-named VTK dirs (prod foamToVTK layout)
# ---------------------------------------------------------------------------


def _make_index_named_vtk(root: Path, times: list[float]) -> Path:
    """Replicate the prod foamToVTK layout: dirs named by TIMESTEP INDEX
    (transient_0..transient_N) with the physical times only in the
    ``.vtm.series`` file."""
    vtk = root / "VTK"
    series = {"file-series-version": "1.0", "files": []}
    for i, t in enumerate(times):
        d = vtk / f"transient_{i}"
        d.mkdir(parents=True)
        (d / "internal.vtu").write_text("<VTKFile/>")
        series["files"].append({"name": f"transient_{i}.vtm", "time": t})
    (vtk / "transient.vtm.series").write_text(json.dumps(series))
    return vtk


def test_select_vtus_windows_index_named_dirs_by_physical_time(tmp_path):
    # MUST-CATCH: window [0.1, 0.3] with dirs transient_0..transient_9 whose
    # physical times are 0.0..0.45. The legacy trailing-token parse read the
    # INDEX as the time, so no integer index fell inside the window and every
    # URANS point shipped with video:{} mean_images:{} (prod evidence).
    times = [0.05 * i for i in range(10)]  # 0.0 .. 0.45
    _make_index_named_vtk(tmp_path, times)
    start, end = 0.1, 0.3

    legacy_times = [
        float(p.parent.name.split("_")[-1]) for p in tmp_path.glob("VTK/*/internal.vtu")
    ]
    legacy_selected = [t for t in legacy_times if start <= t <= end]
    assert legacy_selected == []  # by construction the old behavior picked ZERO frames

    selected = select_vtus(find_all_vtus(tmp_path), start_time=start, end_time=end)

    expected = [f"transient_{i}" for i, t in enumerate(times) if start <= t <= end]
    assert len(expected) >= 4  # the window really does contain frames
    assert [p.parent.name for p in selected] == expected


def test_find_all_vtus_orders_index_named_dirs_by_series_time(tmp_path):
    # 12 dirs so a lexicographic sort (transient_10 < transient_2) would be wrong,
    # and shuffled series times so index order alone is not what is asserted.
    times = [0.01 * i for i in range(12)]
    _make_index_named_vtk(tmp_path, times)

    vtus = find_all_vtus(tmp_path)

    assert [p.parent.name for p in vtus] == [f"transient_{i}" for i in range(12)]
    assert [_vtu_time(p) for p in vtus] == pytest.approx(times)


def test_series_supports_directory_style_entries(tmp_path):
    vtk = tmp_path / "VTK"
    for i in range(2):
        d = vtk / f"transient_{i}"
        d.mkdir(parents=True)
        (d / "internal.vtu").write_text("<VTKFile/>")
    (vtk / "transient.vtm.series").write_text(
        json.dumps(
            {
                "files": [
                    {"name": "transient_0/internal.vtu", "time": 0.5},
                    {"name": "transient_1/internal.vtu", "time": 0.6},
                ]
            }
        )
    )

    assert _vtu_time(vtk / "transient_0" / "internal.vtu") == pytest.approx(0.5)
    assert _vtu_time(vtk / "transient_1" / "internal.vtu") == pytest.approx(0.6)


def test_time_value_field_data_fallback_when_series_missing(tmp_path):
    vtk = tmp_path / "VTK"
    d = vtk / "transient_7"
    d.mkdir(parents=True)
    (d / "internal.vtu").write_text("<VTKFile/>")
    (vtk / "transient_7.vtm").write_text(
        '<VTKFile type="vtkMultiBlockDataSet" version="1.0">\n'
        "  <FieldData>\n"
        '    <DataArray type="Float64" Name="TimeValue" NumberOfTuples="1" format="ascii"> 0.271 </DataArray>\n'
        "  </FieldData>\n"
        "</VTKFile>\n"
    )

    assert _vtu_time(d / "internal.vtu") == pytest.approx(0.271)


def test_legacy_time_named_dirs_still_float_parse(tmp_path):
    vtk = tmp_path / "VTK"
    for t in (0.1, 0.2, 0.3):
        d = vtk / f"transient_{t:g}"
        d.mkdir(parents=True)
        (d / "internal.vtu").write_text("<VTKFile/>")

    selected = select_vtus(find_all_vtus(tmp_path), start_time=0.15, end_time=0.35)

    assert [p.parent.name for p in selected] == ["transient_0.2", "transient_0.3"]


# ---------------------------------------------------------------------------
# D1: media render failures must be loud quality warnings, never silence
# ---------------------------------------------------------------------------


def test_urans_media_render_failures_are_loud_quality_warnings(tmp_path, monkeypatch):
    class FakeRunner:
        def application(self, *_args, **_kwargs):
            return SimpleNamespace(ok=True, check=lambda: None)

    avg = SimpleNamespace(cl=0.45, cd=0.08, cm=-0.02, cl_cd=5.625, cl_std=0.01, cd_std=0.002, cm_std=0.001)

    def fake_transient(case_dir, *_args, **_kwargs):
        return TransientResult(
            avg=avg,
            case_dir=case_dir,
            force_history=None,
            quality=UransQuality(ok=True, can_refine=False, reason="ok"),
            start_time=0.0,
            end_time=1.0,
            run_time=1.0,
        )

    def boom_mean(*_args, **_kwargs):
        raise RuntimeError("no VTU frames in retained window")

    def boom_animation(*_args, **_kwargs):
        raise RuntimeError("encoder exploded")

    monkeypatch.setattr(pipeline, "_run_transient", fake_transient)
    monkeypatch.setattr(
        pipeline, "render_contours", lambda *_a, **_k: {"velocity_magnitude": "velocity_magnitude.png"}
    )
    monkeypatch.setattr(pipeline, "render_mean_contours", boom_mean)
    monkeypatch.setattr(pipeline, "render_animation", boom_animation)

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
            force_transient=True, write_images=[ImageField.velocity_magnitude]
        ),
        runner=FakeRunner(),
        n_proc=1,
        render_images=True,
        solver_timeout=7200,
    )

    # The job still succeeds (media loss is degradation, not failure) ...
    assert outcome.unsteady
    assert outcome.converged
    assert outcome.cl == pytest.approx(0.45)
    # ... but the losses are recorded loudly, not swallowed.
    warnings = "\n".join(outcome.quality_warnings)
    assert "mean-image render failed: no VTU frames in retained window" in warnings
    assert "animation render failed (velocity_magnitude): encoder exploded" in warnings
    assert outcome.mean_images == {}
    assert outcome.video == {}

    # The evidence manifest unavailable map records the missing roles.
    manifest = json.loads((tmp_path / "evidence" / "evidence_manifest.json").read_text())
    assert manifest["media"]["unavailable"]["mean"] == ["velocity_magnitude"]
    assert manifest["media"]["unavailable"]["video"] == ["velocity_magnitude"]
    assert "instantaneous" not in manifest["media"]["unavailable"]


# ---------------------------------------------------------------------------
# D2: refined-pass feasibility guard
# ---------------------------------------------------------------------------


def _install_fake_transient_attempts(monkeypatch, *, base_wall_seconds: float) -> list[bool]:
    """Fake _prepare_transient_case/_run_transient_attempt; return the list of
    ``refined`` flags per attempt call."""
    calls: list[bool] = []
    period = 0.23  # weak-shedding naca-0012 a0 measured period (prod case)

    def fake_prepare(tcase, *_args, **_kwargs):
        tcase.mkdir(parents=True, exist_ok=True)
        (tcase / "0").mkdir(exist_ok=True)
        return (None, {})

    def fake_attempt(tcase, *_args, refined=False, **_kwargs):
        calls.append(refined)
        if not refined:
            (tcase / "0.3").mkdir(exist_ok=True)  # base pass simulated 0.3 s
            return TransientResult(
                avg=None,
                case_dir=tcase,
                force_history=None,
                quality=UransQuality(
                    ok=False,
                    can_refine=True,
                    reason="retained cycles 0.87 < 7.00",
                    measured_period_s=period,
                    retained_cycles=0.87,
                ),
                start_time=0.0,
                end_time=0.3,
                run_time=0.3,
                wall_seconds=base_wall_seconds,
            )
        return TransientResult(
            avg=None,
            case_dir=tcase,
            force_history=None,
            quality=UransQuality(ok=True, can_refine=False, reason="URANS quality target met."),
            start_time=0.3,
            end_time=3.0,
            run_time=2.7,
            refined=True,
            wall_seconds=60.0,
        )

    monkeypatch.setattr(pipeline, "_prepare_transient_case", fake_prepare)
    monkeypatch.setattr(pipeline, "_run_transient_attempt", fake_attempt)
    return calls


def _run_transient_with_guard(tmp_path, timeout=7200):
    return pipeline._run_transient(
        tmp_path,
        airfoil=None,
        resolved=None,
        spec=CaseSpec(chord=1.0, speed=7.3, aoa_deg=0.0),
        fluid=None,
        roughness=None,
        solver_params=SolverParams(),
        runner=None,
        n_proc=1,
        timeout=timeout,
    )


def test_refine_guard_skips_deterministically_infeasible_refined_pass(tmp_path, monkeypatch):
    # Base pass: 0.3 simulated s in 3600 wall s -> ~8.3e-5 sim-s/wall-s (the
    # prod dt-collapse rate). The refined window needs >= 2.6 simulated s
    # -> projected ~9h wall >> 0.8 * 7200 s budget: refinement must be skipped
    # instead of burning the whole timeout.
    calls = _install_fake_transient_attempts(monkeypatch, base_wall_seconds=3600.0)

    result = _run_transient_with_guard(tmp_path, timeout=7200)

    assert calls == [False]  # the refined attempt was never launched
    assert result is not None
    assert not result.refined
    assert not result.quality.ok
    assert not result.quality.can_refine
    assert "URANS refinement skipped: projected" in result.quality.reason
    assert "solver timeout budget" in result.quality.reason
    # the base window is still graded honestly (original warning preserved)
    assert "retained cycles 0.87 < 7.00" in result.quality.reason


def test_refine_guard_lets_feasible_refined_pass_proceed(tmp_path, monkeypatch):
    # Base pass: 0.3 simulated s in 10 wall s -> projected refined wall time is
    # ~90 s, far below 0.8 * 7200 s: refinement proceeds as before.
    calls = _install_fake_transient_attempts(monkeypatch, base_wall_seconds=10.0)

    result = _run_transient_with_guard(tmp_path, timeout=7200)

    assert calls == [False, True]
    assert result is not None
    assert result.refined
    assert result.quality.ok


def test_refine_guard_budget_references_the_passed_timeout(tmp_path, monkeypatch):
    # Same solve rate, but a huge per-attempt budget: the guard must scale with
    # the timeout it is given (no hardcoded 7200), so refinement proceeds.
    calls = _install_fake_transient_attempts(monkeypatch, base_wall_seconds=3600.0)
    projected_wall_s = 3600.0 / 0.3  # per simulated second
    generous_timeout = int(projected_wall_s * 3.0 / URANS_REFINE_BUDGET_FRACTION) * 4

    result = _run_transient_with_guard(tmp_path, timeout=generous_timeout)

    assert calls == [False, True]
    assert result is not None
    assert result.refined
