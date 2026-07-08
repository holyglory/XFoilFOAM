"""Cross-job URANS continuation (approved design item C).

A URANS transient stopped by the wall-clock budget guard leaves its case dir
intact on the shared volume; a request carrying ``continue_from`` copies that
saved state into the new job, restarts pimpleFoam from latestTime with the
(usually increased) ``budget_override_s`` and merges the coefficient history
across the job boundary — the SAME restart-segment mechanics the in-run
continuation chunks use.

Covers (no real OpenFOAM solves — fake runners shaped like prod output):
  - request contract: continue_from validation, budget_override_s bounds;
  - budget override wiring: urans_budget_seconds, _finalize_outcome,
    run_case, execute_job, celery hard-limit math;
  - staging: state copy (hardlink where safe), skip dirs, honest failures for
    missing/cleaned/unrestartable sources, transient-start recovery;
  - MUST-CATCH resume mechanics: restart from latestTime + merged history
    spanning both segments over a staged fixture case;
  - MUST-CATCH restartability: a timed-out transient leaves a case dir that
    stages successfully for continuation (latestTime fields intact).
"""
import math
import os
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam import jobs, pipeline
from airfoilfoam.celery_app import TASK_TIME_LIMIT_MARGIN_S, task_hard_time_limit_s
from airfoilfoam.config import get_settings
from airfoilfoam.models import (
    URANS_BUDGET_OVERRIDE_MAX_S,
    AirfoilInput,
    AoASpec,
    CaseSpec,
    ContinueFrom,
    FluidProperties,
    MeshParams,
    PolarRequest,
    RoughnessParams,
    SolverParams,
    urans_budget_seconds,
)
from airfoilfoam.openfoam.runner import OpenFOAMError
from airfoilfoam.pipeline import (
    CaseOutcome,
    ContinuationSource,
    TransientResume,
    _finalize_outcome,
    _run_transient_attempt,
    read_transient_start_marker,
    run_case,
    stage_continuation_case,
    write_transient_start_marker,
)
from airfoilfoam.storage import JobStore

FLUID = FluidProperties(density=1.225, kinematic_viscosity=1.5e-5)
#: Prod campaign class: 0.1 m chord at 25 m/s; shedding at St=0.2 -> 0.02 s
#: period, inside the estimator's Strouhal band (0.05..0.5 -> 0.008..0.08 s).
SPEC = CaseSpec(chord=0.1, speed=25.0, aoa_deg=15.0)
PERIOD_S = 0.02


def _coeff_rows(t_start: float, t_end: float, dt: float = 0.001, cl0: float = 0.7) -> str:
    lines = ["# Time Cd Cd(f) Cd(r) Cl Cl(f) Cl(r) CmPitch CmRoll CmYaw Cs Cs(f) Cs(r)"]
    t = t_start
    while t <= t_end + 1e-12:
        cl = cl0 + 0.05 * math.sin(2 * math.pi * t / PERIOD_S)
        cd = 0.2 + 0.01 * math.sin(2 * math.pi * t / PERIOD_S + 0.7)
        row = [t, cd, 0.0, 0.0, cl, 0.0, 0.0, -0.1, 0.0, 0.0, 0.0, 0.0, 0.0]
        lines.append(" ".join(f"{v:.6g}" for v in row))
        t += dt
    return "\n".join(lines) + "\n"


def _write_time_dir(case: Path, name: str) -> None:
    d = case / name
    d.mkdir(parents=True, exist_ok=True)
    for field in ("U", "p", "k", "omega", "nut"):
        (d / field).write_text(f"saved {field} at {name}")


def _make_saved_case(
    case_dir: Path,
    *,
    with_marker: bool = True,
    with_init_log: bool = False,
    latest: str = "0.1",
) -> Path:
    """A saved URANS case shaped like a real budget-stopped campaign point:
    steady stage evidence in the case dir, transient/ with mesh, time dirs,
    controlDict and a shedding coefficient segment up to ``latest``."""
    tcase = case_dir / "transient"
    (tcase / "system").mkdir(parents=True)
    (tcase / "system" / "controlDict").write_text(
        'FoamFile { version 2.0; }\nstartFrom       latestTime;\nendTime         0.1;\n'
    )
    (tcase / "constant" / "polyMesh").mkdir(parents=True)
    (tcase / "constant" / "polyMesh" / "points").write_text("mesh points")
    _write_time_dir(tcase, "0")
    _write_time_dir(tcase, latest)
    coeff = tcase / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    coeff.parent.mkdir(parents=True)
    coeff.write_text(_coeff_rows(0.001, float(latest)))
    if with_marker:
        write_transient_start_marker(tcase, 0.0)
    if with_init_log:
        (tcase / "log.simpleFoam.init").write_text("init evidence")
    # Steady-stage evidence in the case dir (copied along, harmless).
    steady_coeff = case_dir / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
    steady_coeff.parent.mkdir(parents=True)
    steady_coeff.write_text(_coeff_rows(0.001, 0.02))
    # Media/evidence bulk a continuation must NOT drag along.
    (case_dir / "evidence").mkdir()
    (case_dir / "evidence" / "openfoam_evidence.tar.gz").write_text("bundle")
    (case_dir / "images").mkdir()
    (case_dir / "images" / "vorticity.png").write_text("png")
    (tcase / "VTK").mkdir()
    (tcase / "VTK" / "case_0.vtu").write_text("vtu")
    (tcase / "processor0").mkdir()
    (tcase / "processor0" / "junk").write_text("stale decomposition")
    # A stale divergence verdict must never poison the resumed attempt.
    (tcase / "divergence_condemned.json").write_text('{"reason": "old verdict"}')
    return tcase


def _continuation_request(naca0012_selig_text, **overrides) -> PolarRequest:
    kwargs = dict(
        airfoil=AirfoilInput(name="n0012", coordinates=naca0012_selig_text),
        chord_lengths=[SPEC.chord],
        speeds=[SPEC.speed],
        aoa=AoASpec(angles=[SPEC.aoa_deg]),
        solver=SolverParams(force_transient=True, write_images=[]),
        continue_from=ContinueFrom(engine_job_id="a" * 32, case_slug="c0p1_u25_a15"),
        budget_override_s=21600,
    )
    kwargs.update(overrides)
    return PolarRequest(**kwargs)


# --------------------------------------------------------------------------- #
# Request contract
# --------------------------------------------------------------------------- #


def test_continue_from_request_contract(naca0012_selig_text):
    req = _continuation_request(naca0012_selig_text)
    assert req.continue_from is not None
    assert req.budget_override_s == 21600

    # Nested slug (one level) is a real engine layout: <polar>/urans_aN.
    ContinueFrom(engine_job_id="deadbeef" * 4, case_slug="c0p1_u25/urans_a3")

    # Traversal / unsafe slugs and non-uuid-ish job ids are rejected.
    for bad_slug in ("../other", "a/../b", "a/b/c", "", "cases;rm", "/abs"):
        with pytest.raises(ValueError):
            ContinueFrom(engine_job_id="a" * 32, case_slug=bad_slug)
    for bad_job in ("", "short", "x" * 65, "..", "job/../id", "job id"):
        with pytest.raises(ValueError):
            ContinueFrom(engine_job_id=bad_job, case_slug="c1_u10_a5")

    # continue_from requires a URANS (force_transient) request...
    with pytest.raises(ValueError, match="force_transient"):
        _continuation_request(naca0012_selig_text, solver=SolverParams(write_images=[]))
    # ...and exactly one case.
    with pytest.raises(ValueError, match="exactly one"):
        _continuation_request(naca0012_selig_text, aoa=AoASpec(angles=[10.0, 15.0]))

    # Budget override bounds: 24 h cap, sane floor.
    with pytest.raises(ValueError):
        _continuation_request(naca0012_selig_text, budget_override_s=URANS_BUDGET_OVERRIDE_MAX_S + 1)
    with pytest.raises(ValueError):
        _continuation_request(naca0012_selig_text, budget_override_s=10)
    assert (
        _continuation_request(
            naca0012_selig_text, budget_override_s=URANS_BUDGET_OVERRIDE_MAX_S
        ).budget_override_s
        == 86_400
    )


def test_urans_budget_seconds_override():
    solver = SolverParams(force_transient=True)
    assert urans_budget_seconds(solver) == 43200  # tier budget untouched
    assert urans_budget_seconds(solver, 21600) == 21600
    assert urans_budget_seconds(SolverParams(urans_fidelity="precalc"), 9000) == 9000
    # Defensive clamp even if a caller bypasses request validation.
    assert urans_budget_seconds(solver, 500_000) == URANS_BUDGET_OVERRIDE_MAX_S
    assert urans_budget_seconds(solver, 1) == 60


def test_task_hard_time_limit_uses_budget_override():
    settings = get_settings()
    base = task_hard_time_limit_s(settings, 1)
    # An override above the tier ceiling raises the celery backstop with it.
    boosted = task_hard_time_limit_s(settings, 1, budget_override_s=86_400)
    assert boosted == int(
        math.ceil(2 * 86_400 + settings.media_budget_seconds() + TASK_TIME_LIMIT_MARGIN_S)
    )
    assert boosted > base
    # A small override never LOWERS the ceiling below the tier maximum.
    assert task_hard_time_limit_s(settings, 1, budget_override_s=7200) == base
    # Defensive clamp mirrors urans_budget_seconds.
    assert task_hard_time_limit_s(settings, 1, budget_override_s=999_999) == boosted


# --------------------------------------------------------------------------- #
# Staging: copy + honest failures + transient-start recovery
# --------------------------------------------------------------------------- #


def test_stage_continuation_copies_state_and_locates_restart(tmp_path):
    src = tmp_path / "src_job" / "cases" / "c0p1_u25_a15"
    _make_saved_case(src)
    dst = tmp_path / "new_job" / "cases" / "c0p1_u25_a15"

    source = stage_continuation_case(src, dst)

    assert source.transient_subdir == "transient"
    assert source.transient_start == 0.0
    assert source.resume_from == pytest.approx(0.1)
    # Restartable state copied: latestTime fields, mesh, controlDict, history.
    assert (dst / "transient" / "0.1" / "U").read_text() == "saved U at 0.1"
    assert (dst / "transient" / "constant" / "polyMesh" / "points").is_file()
    assert (dst / "transient" / "system" / "controlDict").is_file()
    assert (dst / "transient" / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat").is_file()
    assert read_transient_start_marker(dst / "transient") == 0.0
    # Bulk field data hardlinks (same volume); mutable files are REAL copies.
    src_u = src / "transient" / "0.1" / "U"
    dst_u = dst / "transient" / "0.1" / "U"
    assert os.stat(src_u).st_ino == os.stat(dst_u).st_ino
    for rel in ("system/controlDict", "postProcessing/forceCoeffs1/0/coefficient.dat"):
        assert (
            os.stat(src / "transient" / rel).st_ino != os.stat(dst / "transient" / rel).st_ino
        ), f"{rel} must be a real copy (rewritten in place by the resumed run)"
    # Derived media/evidence, VTK, stale decompositions and stale divergence
    # verdicts never travel with a continuation.
    assert not (dst / "evidence").exists()
    assert not (dst / "images").exists()
    assert not (dst / "transient" / "VTK").exists()
    assert not (dst / "transient" / "processor0").exists()
    assert not (dst / "transient" / "divergence_condemned.json").exists()


def test_stage_continuation_missing_or_unrestartable_sources_fail_honestly(tmp_path):
    dst = tmp_path / "dst"

    with pytest.raises(OpenFOAMError, match="not found"):
        stage_continuation_case(tmp_path / "gone" / "cases" / "x", dst)

    empty = tmp_path / "empty_case"
    empty.mkdir()
    with pytest.raises(OpenFOAMError, match="no transient directory"):
        stage_continuation_case(empty, dst)

    no_times = tmp_path / "no_times"
    (no_times / "transient" / "system").mkdir(parents=True)
    with pytest.raises(OpenFOAMError, match="no time directories"):
        stage_continuation_case(no_times, dst)

    no_fields = tmp_path / "no_fields"
    (no_fields / "transient" / "0.2").mkdir(parents=True)
    with pytest.raises(OpenFOAMError, match="missing fields U, p"):
        stage_continuation_case(no_fields, dst)

    no_mesh = tmp_path / "no_mesh"
    _make_saved_case(no_mesh)
    (no_mesh / "transient" / "constant" / "polyMesh" / "points").unlink()
    with pytest.raises(OpenFOAMError, match="mesh is missing"):
        stage_continuation_case(no_mesh, dst)

    no_control = tmp_path / "no_control"
    _make_saved_case(no_control)
    (no_control / "transient" / "system" / "controlDict").unlink()
    with pytest.raises(OpenFOAMError, match="no system/controlDict"):
        stage_continuation_case(no_control, dst)


def test_transient_start_recovery_without_marker(tmp_path):
    # Warm-seeded transient (no in-case init log): transient owns segment 0.
    warm = tmp_path / "warm"
    _make_saved_case(warm, with_marker=False)
    src_t = warm / "transient"
    assert read_transient_start_marker(src_t) is None
    source = stage_continuation_case(warm, tmp_path / "warm_dst")
    assert source.transient_start == 0.0
    assert read_transient_start_marker(tmp_path / "warm_dst" / "transient") == 0.0

    # Init-seeded transient: pseudo-time steady segment at 0, transient at the
    # first POSITIVE segment.
    seeded = tmp_path / "seeded"
    tcase = _make_saved_case(seeded, with_marker=False, with_init_log=True, latest="600.05")
    coeff = tcase / "postProcessing" / "forceCoeffs1" / "600" / "coefficient.dat"
    coeff.parent.mkdir(parents=True)
    coeff.write_text(_coeff_rows(600.001, 600.05))
    source = stage_continuation_case(seeded, tmp_path / "seeded_dst")
    assert source.transient_start == 600.0
    assert source.resume_from == pytest.approx(600.05)


# --------------------------------------------------------------------------- #
# MUST-CATCH: resume restarts from latestTime and merges history across jobs
# --------------------------------------------------------------------------- #


def test_resume_restarts_from_latest_time_and_merges_both_segments(tmp_path):
    """Real breakage shape: a budget-stopped campaign point (5 shedding periods
    saved, stopped at t=0.1) is continued in a NEW job. The resumed transient
    must restart pimpleFoam from latestTime (restart=True, controlDict
    startTime = saved latest) and grade the history MERGED across the job
    boundary — never re-prepare/wipe the case, never restart physics at 0."""
    case_dir = tmp_path / "case"
    _make_saved_case(case_dir)
    dst = tmp_path / "staged"
    source = stage_continuation_case(case_dir, dst)
    tcase = dst / "transient"

    calls: dict[str, object] = {}

    class FakeRunner:
        def solver(self, cdir, app, n_proc, timeout=None, restart=False, monitor=None):
            calls["app"] = app
            calls["restart"] = restart
            calls["timeout"] = timeout
            calls["n"] = calls.get("n", 0) + 1
            control = (Path(cdir) / "system" / "controlDict").read_text()
            calls["controlDict"] = control
            start = float(re.search(r"startTime\s+([0-9.eE+-]+);", control).group(1))
            end = float(re.search(r"endTime\s+([0-9.eE+-]+);", control).group(1))
            # The continuation segment lands in its OWN forceCoeffs dir named
            # by the restart time (OpenFOAM restart-segment behaviour).
            seg = Path(cdir) / "postProcessing" / "forceCoeffs1" / f"{start:g}" / "coefficient.dat"
            seg.parent.mkdir(parents=True, exist_ok=True)
            seg.write_text(_coeff_rows(start + 0.001, 0.2))
            _write_time_dir(Path(cdir), "0.15")
            _write_time_dir(Path(cdir), "0.2")
            return SimpleNamespace(ok=True, returncode=0, timed_out=False, stdout="Time = 0.2\n")

        def application(self, *_args, **_kwargs):
            return SimpleNamespace(ok=True, stdout="", check=lambda: None)

    # Full-tier period target (7): the retained integer-period window (0.14 s)
    # can only exist if the history MERGES across the 0.1 s job boundary.
    solver = SolverParams(
        force_transient=True,
        write_images=[],
        transient_discard_fraction=0.0,
        urans_min_periods=7,
        transient_auto_refine=False,
    )
    result = pipeline._run_transient(
        dst,
        airfoil=None,
        resolved=MeshParams(),
        spec=SPEC,
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=solver,
        runner=FakeRunner(),
        n_proc=1,
        timeout=21600,
        resume=TransientResume(
            transient_start=source.transient_start, resume_from=source.resume_from
        ),
    )

    assert result is not None
    # One resumed solver run with restart mechanics and the overridden budget.
    assert calls["n"] == 1 and calls["app"] == "pimpleFoam"
    assert calls["restart"] is True
    assert calls["timeout"] == 21600
    assert "latestTime" in calls["controlDict"]
    assert re.search(r"startTime\s+0\.1;", calls["controlDict"]), calls["controlDict"]
    # The saved state was NOT wiped or re-prepared.
    assert (tcase / "0.1" / "U").read_text() == "saved U at 0.1"
    # Merged history: coefficient segments of BOTH jobs feed the grade, and
    # the retained integer-period window CROSSES the job boundary at t=0.1
    # (7 periods x 0.02 s = 0.14 s > the 0.1 s continuation segment alone).
    assert len(result.coeff_paths) == 2
    history = result.force_history
    assert history is not None
    assert history.t[0] < 0.1 < history.t[-1]
    assert history.t[-1] >= 0.19
    # ...and the result grades the WHOLE merged transient window.
    assert result.start_time == source.transient_start
    assert result.end_time == pytest.approx(0.2)
    assert result.run_time == pytest.approx(0.2)
    avg = result.avg
    assert avg.cl == pytest.approx(0.7, abs=0.02)


# --------------------------------------------------------------------------- #
# Budget override + resume wiring through _finalize_outcome / run_case / jobs
# --------------------------------------------------------------------------- #


def test_finalize_outcome_threads_override_budget_and_resume(tmp_path, monkeypatch):
    captured = {}

    def fake_run_transient(case_dir, airfoil, resolved, spec, fluid, roughness, sp,
                           runner, n_proc, timeout, **kwargs):
        captured["timeout"] = timeout
        captured["resume"] = kwargs.get("resume")
        return None

    monkeypatch.setattr(pipeline, "_run_transient", fake_run_transient)
    outcome = CaseOutcome(spec=SPEC, reynolds=166_666)
    resume = TransientResume(transient_start=0.0, resume_from=0.1)
    with pytest.raises(OpenFOAMError):
        _finalize_outcome(
            tmp_path,
            outcome,
            airfoil=SimpleNamespace(name="n0012", contour=[]),
            resolved=MeshParams(),
            spec=SPEC,
            fluid=FLUID,
            roughness=RoughnessParams(),
            solver_params=SolverParams(force_transient=True, write_images=[]),
            runner=SimpleNamespace(),
            n_proc=1,
            render_images=False,
            solver_timeout=7200,
            resume=resume,
            urans_budget_s=21600,
        )
    assert captured["timeout"] == 21600  # override replaces the 43200 tier budget
    assert captured["resume"] is resume


def test_run_case_resume_skips_mesh_and_steady_stages(tmp_path, monkeypatch):
    captured = {}

    def fake_finalize(case_dir, outcome, *args, **kwargs):
        captured["resume"] = kwargs.get("resume")
        captured["urans_budget_s"] = kwargs.get("urans_budget_s")
        outcome.converged = True

    monkeypatch.setattr(pipeline, "_finalize_outcome", fake_finalize)

    class ForbiddenRunner:
        def solver(self, *_args, **_kwargs):
            raise AssertionError("continuation must never run the steady stage")

        def application(self, *_args, **_kwargs):
            raise AssertionError("continuation must never run mesh/init applications")

    class ForbiddenMesher:
        def patches(self, _resolved):
            return {}

        def cell_count(self, _resolved):
            return 4242

        def write_inputs(self, *_args, **_kwargs):
            raise AssertionError("continuation must never write mesh inputs")

        def run_mesh(self, *_args, **_kwargs):
            raise AssertionError("continuation must never build a mesh")

    resume = TransientResume(transient_start=0.0, resume_from=0.1)
    outcome = run_case(
        tmp_path / "case",
        airfoil=SimpleNamespace(name="n0012", contour=[]),
        spec=SPEC,
        fluid=FLUID,
        roughness=RoughnessParams(),
        mesh_params=MeshParams(),
        solver_params=SolverParams(force_transient=True, write_images=[]),
        mesher=ForbiddenMesher(),
        runner=ForbiddenRunner(),
        resume=resume,
        urans_budget_s=13337,
    )

    assert outcome.error is None
    assert outcome.converged
    assert outcome.n_cells == 4242
    assert captured["resume"] is resume
    assert captured["urans_budget_s"] == 13337


def test_execute_job_continuation_wiring(monkeypatch, naca0012_selig_text):
    captured = {}
    source = ContinuationSource(transient_subdir="transient", transient_start=0.42, resume_from=1.1)

    def fake_stage(src_case, dst_case):
        captured["src_case"] = src_case
        captured["dst_case"] = dst_case
        return source

    def fake_run_case(case_dir, airfoil, spec, fluid, roughness, mesh_params, solver_params,
                      mesher, runner, **kwargs):
        captured["case_dir"] = case_dir
        captured["resume"] = kwargs.get("resume")
        captured["urans_budget_s"] = kwargs.get("urans_budget_s")
        return CaseOutcome(
            spec=spec, reynolds=166_666, cl=0.9, cd=0.11, cm=-0.05,
            converged=True, unsteady=True, fidelity="urans_full",
        )

    def forbid_mesh(*_args, **_kwargs):
        raise AssertionError("continuation jobs must not mesh")

    monkeypatch.setattr(jobs, "stage_continuation_case", fake_stage)
    monkeypatch.setattr(jobs, "run_case", fake_run_case)
    monkeypatch.setattr(jobs, "prepare_mesh", forbid_mesh)

    request = _continuation_request(naca0012_selig_text)
    settings = get_settings()
    store = JobStore(settings)
    result = jobs.execute_job("continuation-wiring-test", request, store=store, settings=settings)

    assert result.state.value == "completed"
    cf = request.continue_from
    assert captured["src_case"] == store.cases_dir(cf.engine_job_id) / cf.case_slug
    assert captured["dst_case"] == store.case_dir("continuation-wiring-test", SPEC.slug)
    assert captured["case_dir"] == captured["dst_case"]
    resume = captured["resume"]
    assert isinstance(resume, TransientResume)
    assert resume.transient_start == 0.42 and resume.resume_from == 1.1
    assert captured["urans_budget_s"] == 21600
    # The continuation point ingests as a NORMAL polar point (same cell).
    assert len(result.polars) == 1
    points = result.polars[0].points
    assert len(points) == 1
    assert points[0].aoa_deg == SPEC.aoa_deg
    assert points[0].case_slug == SPEC.slug
    assert points[0].fidelity == "urans_full"


def test_execute_job_continuation_missing_source_fails_honestly(monkeypatch, naca0012_selig_text):
    """A cleaned/missing saved case must fail the job with a truthful message
    BEFORE any solving — never mesh, never solve, never invent a point."""

    def forbid(*_args, **_kwargs):
        raise AssertionError("must not solve when the continuation source is missing")

    monkeypatch.setattr(jobs, "run_case", forbid)
    monkeypatch.setattr(jobs, "prepare_mesh", forbid)

    request = _continuation_request(
        naca0012_selig_text,
        continue_from=ContinueFrom(engine_job_id="f" * 32, case_slug="never_existed"),
    )
    settings = get_settings()
    store = JobStore(settings)
    result = jobs.execute_job("continuation-missing-src", request, store=store, settings=settings)

    assert result.state.value == "failed"
    assert "continuation failed" in (result.message or "")
    assert "not found" in (result.message or "")
    assert result.polars == [] or all(not p.points for p in result.polars)
    status = store.read_status("continuation-missing-src")
    assert status is not None and status.state.value == "failed"
    assert "continuation failed" in (status.message or "")


# --------------------------------------------------------------------------- #
# MUST-CATCH: a timed-out transient leaves restartable state (continuable)
# --------------------------------------------------------------------------- #


def test_timed_out_transient_leaves_restartable_state_for_continuation(tmp_path, monkeypatch):
    """Real breakage shape: pimpleFoam killed by the wall-clock budget after
    writing fields at t=0.05. The budget-stop path must leave the case dir
    intact (latestTime fields written, controlDict/mesh present) so the SAME
    case stages successfully for a cross-job continuation."""

    class FakeCaseBuilder:
        def __init__(self, *_args, **_kwargs):
            pass

        def write_transient(self, *_args, **_kwargs) -> None:
            pass

    class TimeoutRunner:
        def solver(self, cdir, *_args, monitor=None, **_kwargs):
            seg = Path(cdir) / "postProcessing" / "forceCoeffs1" / "0" / "coefficient.dat"
            seg.parent.mkdir(parents=True, exist_ok=True)
            seg.write_text(_coeff_rows(0.001, 0.05))
            _write_time_dir(Path(cdir), "0.05")  # last complete write before SIGTERM
            return SimpleNamespace(
                ok=False, returncode=124, timed_out=True,
                stdout="deltaT = 1e-06\nTime = 0.05\nCommand timed out after 7200s",
            )

    monkeypatch.setattr(pipeline, "CaseBuilder", FakeCaseBuilder)

    case_dir = tmp_path / "case"
    tcase = case_dir / "transient"
    (tcase / "system").mkdir(parents=True)
    (tcase / "system" / "controlDict").write_text("startFrom latestTime;\n")
    (tcase / "constant" / "polyMesh").mkdir(parents=True)
    (tcase / "constant" / "polyMesh" / "points").write_text("mesh points")
    _write_time_dir(tcase, "0")
    write_transient_start_marker(tcase, 0.0)
    dirs_before = {d.name for d in tcase.iterdir()}

    result = _run_transient_attempt(
        tcase,
        airfoil=None,
        tmesh=None,
        patches={},
        spec=SPEC,
        fluid=FLUID,
        roughness=RoughnessParams(),
        solver_params=SolverParams(force_transient=True, urans_min_periods=7),
        runner=TimeoutRunner(),
        n_proc=1,
        timeout=7200,
        run_time=0.3,
        delta_t=1e-5,
        coeff_start_time=0.0,
    )

    # Honest partial grade — and NOTHING deleted by the budget-stop path.
    assert result is not None
    assert not result.quality.ok and not result.quality.can_refine
    assert "timed out" in result.quality.reason
    # MUST-CATCH (cross-runtime recall): the timed-out grade carries the pinned
    # continuable marker, so the node predicate offers CONTINUE — not only a
    # from-scratch requeue — for a solve killed mid-chunk by the wall clock.
    assert pipeline.URANS_BUDGET_STOP_MARKER in result.quality.reason
    assert dirs_before <= {d.name for d in tcase.iterdir()}
    latest = tcase / "0.05"
    assert (latest / "U").is_file() and (latest / "p").is_file()

    # The timed-out case IS continuable: staging succeeds and resumes from the
    # fields the killed run left at latestTime.
    source = stage_continuation_case(case_dir, tmp_path / "staged")
    assert source.transient_subdir == "transient"
    assert source.transient_start == 0.0
    assert source.resume_from == pytest.approx(0.05)
    assert (tmp_path / "staged" / "transient" / "0.05" / "U").is_file()


# --------------------------------------------------------------------------- #
# Cross-runtime marker pin: the continuable-grade phrase is a contract
# --------------------------------------------------------------------------- #


def test_budget_stop_marker_literal_is_pinned_on_the_engine_side():
    """packages/core/src/urans-quality.ts URANS_BUDGET_STOP_MARKER matches the
    engine's quality warnings by SUBSTRING. Both sides pin the identical
    literal: rewording the engine phrasing must fail HERE, loudly, instead of
    silently zeroing the node continuable predicate (recall guardrail)."""
    assert pipeline.URANS_BUDGET_STOP_MARKER == "stopped by the wall-clock budget guard"
