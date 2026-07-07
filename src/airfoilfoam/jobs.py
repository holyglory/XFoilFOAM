"""Execute a polar job with one mesh per chord and CPU-budgeted AoA scheduling."""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Optional

from . import physics
from .airfoil import load_airfoil
from .cache import EngineCache
from .cancellation import JobCancelled
from .config import Settings, get_settings
from .meshing.base import get_mesher
from .models import (
    CaseSpec,
    ForceHistory,
    JobPhase,
    JobResult,
    JobState,
    JobStatus,
    Polar,
    PolarPoint,
    PolarRequest,
    ResourcePolicy,
)
from .openfoam.runner import get_runner
from .pipeline import CaseOutcome, PolarMarchResult, StoredCaseOutcome, prepare_mesh, resolve_mesh_params, run_case, solve_polar_marched
from .resources import CpuTokenPool, resolve_resources
from .storage import JobStore

ProgressCb = Optional[Callable[[JobStatus], None]]


def _slug(text: str) -> str:
    return text.replace(".", "p").replace("-", "m")


def _chord_slug(chord: float) -> str:
    return _slug(f"c{chord:g}")


def polar_slug(chord: float, speed: float) -> str:
    return _slug(f"c{chord:g}_u{speed:g}")


def _outcome_to_point(job_id: str, slug: str, outcome: CaseOutcome) -> PolarPoint:
    def url(rel: str) -> str:
        return f"/jobs/{job_id}/files/cases/{slug}/{rel}"

    fh = outcome.force_history
    history = (
        ForceHistory(
            t=fh.t, cl=fh.cl, cd=fh.cd, cm=fh.cm,
            shedding_freq_hz=fh.shedding_freq_hz, samples=fh.samples,
            period_s=fh.period_s, retained_cycles=fh.retained_cycles,
            window_start=fh.window_start, window_end=fh.window_end,
        )
        if fh is not None
        else None
    )
    return PolarPoint(
        case_slug=slug,
        aoa_deg=outcome.spec.aoa_deg,
        cl=outcome.cl, cd=outcome.cd, cm=outcome.cm, cl_cd=outcome.cl_cd,
        cl_std=outcome.cl_std, cd_std=outcome.cd_std, cm_std=outcome.cm_std,
        unsteady=outcome.unsteady,
        converged=outcome.converged,
        final_residual=outcome.final_residual,
        iterations=outcome.iterations,
        y_plus_avg=outcome.y_plus_avg, y_plus_max=outcome.y_plus_max,
        n_cells=outcome.n_cells or None,
        first_order_fallback=outcome.first_order_fallback,
        images={field: url(rel) for field, rel in outcome.images.items()},
        strouhal=outcome.strouhal,
        video={field: url(rel) for field, rel in outcome.video.items()},
        mean_images={field: url(rel) for field, rel in outcome.mean_images.items()},
        force_history=history,
        frame_track=outcome.frame_track,
        quality_warnings=outcome.quality_warnings,
        evidence_artifacts=[
            artifact.model_copy(update={"url": url(artifact.path)})
            for artifact in outcome.evidence_artifacts
        ],
        error=outcome.error,
    )


def execute_job(
    job_id: str,
    request: PolarRequest,
    store: Optional[JobStore] = None,
    settings: Optional[Settings] = None,
    progress: ProgressCb = None,
) -> JobResult:
    settings = settings or get_settings()
    store = store or JobStore(settings)
    airfoil = load_airfoil(
        request.airfoil.name, request.airfoil.coordinates, request.airfoil.points,
        request.airfoil.format,
    )
    mesher = get_mesher(request.mesh.mesher)
    runner = get_runner(settings)
    aoas = request.aoa.expand()
    chords, speeds = request.chord_lengths, request.speeds
    total = len(chords) * len(speeds) * len(aoas)
    plan = resolve_resources(request.resources, settings, total)
    cpu_tokens = CpuTokenPool(settings.cpu_token_state_path, plan.worker_cpu_budget)
    mesh_stats = {"count": 0}
    mesh_reuse_mode = "symlink" if runner.external_paths_visible else "copy"
    # Persistent cross-job cache: meshes are copied instead of rebuilt when a
    # previous job already built the same (geometry, chord, resolved params), and
    # steady cases seed from the nearest previously solved angle.
    cache = EngineCache.from_settings(settings)

    lock = threading.Lock()
    completed = {"n": 0}
    phase_ctx = {
        "phase": JobPhase.pending,
        "message": None,
        "active_solver": None,
        "active_case_slug": None,
        "active_aoa_deg": None,
        "cpu_tokens_waiting": 0,
        "cpu_tokens_held": 0,
    }

    def ensure_not_cancelled() -> None:
        if store.is_cancelled(job_id):
            raise JobCancelled("cancelled")

    def set_status(
        state: JobState,
        message: Optional[str] = None,
        *,
        phase: Optional[JobPhase] = None,
        active_solver: Optional[str] = None,
        active_case_slug: Optional[str] = None,
        active_aoa_deg: Optional[float] = None,
        cpu_tokens_waiting: Optional[int] = None,
        cpu_tokens_held: Optional[int] = None,
    ) -> None:
        if state == JobState.running:
            ensure_not_cancelled()
        if phase is not None:
            phase_ctx["phase"] = phase
        if message is not None:
            phase_ctx["message"] = message
        if active_solver is not None or phase is not None:
            phase_ctx["active_solver"] = active_solver
        if active_case_slug is not None or phase is not None:
            phase_ctx["active_case_slug"] = active_case_slug
        if active_aoa_deg is not None or phase is not None:
            phase_ctx["active_aoa_deg"] = active_aoa_deg
        if cpu_tokens_waiting is not None:
            phase_ctx["cpu_tokens_waiting"] = cpu_tokens_waiting
        if cpu_tokens_held is not None:
            phase_ctx["cpu_tokens_held"] = cpu_tokens_held
        st = JobStatus(
            job_id=job_id, state=state, total_cases=total,
            phase=phase_ctx["phase"],
            completed_cases=completed["n"],
            message=message if message is not None else phase_ctx["message"],
            active_solver=phase_ctx["active_solver"],
            active_case_slug=phase_ctx["active_case_slug"],
            active_aoa_deg=phase_ctx["active_aoa_deg"],
            cpu_tokens_waiting=int(phase_ctx["cpu_tokens_waiting"] or 0),
            cpu_tokens_held=int(phase_ctx["cpu_tokens_held"] or 0),
            scheduling=plan.metadata(
                mesh_build_count=mesh_stats["count"],
                aoa_case_count=total,
                mesh_reuse_mode=mesh_reuse_mode,
            ),
        )
        store.write_status(st)
        if progress:
            progress(st)

    def bump() -> None:
        with lock:
            completed["n"] += 1
            set_status(JobState.running)

    def wait_for_cpu(tokens: int, message: str, *, case: Optional[CaseSpec] = None) -> None:
        set_status(
            JobState.running,
            message,
            phase=JobPhase.waiting_cpu,
            active_solver=None,
            active_case_slug=case.slug if case else None,
            active_aoa_deg=case.aoa_deg if case else None,
            cpu_tokens_waiting=tokens,
            cpu_tokens_held=0,
        )

    def cpu_acquired(
        tokens: int,
        phase: JobPhase,
        message: str,
        *,
        solver: Optional[str] = None,
        case: Optional[CaseSpec] = None,
    ) -> None:
        set_status(
            JobState.running,
            message,
            phase=phase,
            active_solver=solver,
            active_case_slug=case.slug if case else None,
            active_aoa_deg=case.aoa_deg if case else None,
            cpu_tokens_waiting=0,
            cpu_tokens_held=tokens,
        )

    ensure_not_cancelled()
    set_status(JobState.running, "resolving job resources", phase=JobPhase.waiting_cpu)

    # 1. Mesh ONCE per chord (sized for the highest speed -> finest wall; reused by
    #    every speed/AoA of that chord).
    max_speed = max(speeds)
    meshes: dict[float, tuple] = {}
    for chord in chords:
        ensure_not_cancelled()
        resolved = resolve_mesh_params(
            request.mesh, CaseSpec(chord=chord, speed=max_speed, aoa_deg=0.0), request.fluid
        )
        mesh_dir = store.job_dir(job_id) / "meshes" / _chord_slug(chord)
        wait_for_cpu(1, f"waiting for CPU before meshing chord {chord:g}")
        with cpu_tokens.acquire(
            1,
            on_wait=lambda _snapshot, c=chord: wait_for_cpu(1, f"waiting for CPU before meshing chord {c:g}"),
            on_acquired=lambda _snapshot, c=chord: cpu_acquired(1, JobPhase.meshing, f"meshing chord {c:g}"),
        ):
            mr = prepare_mesh(
                mesh_dir, airfoil, resolved, chord, mesher, runner,
                cancel_check=ensure_not_cancelled, cache=cache,
            )
        mesh_stats["count"] += 1
        set_status(JobState.running, "mesh ready", phase=JobPhase.waiting_cpu, cpu_tokens_waiting=0, cpu_tokens_held=0)
        meshes[chord] = (mesh_dir, resolved, mr.n_cells)

    render_images = bool(request.solver.write_images)
    results: dict[tuple, dict[float, tuple[str, CaseOutcome]]] = {}
    attempts: dict[tuple, list[tuple[str, CaseOutcome]]] = {}

    def scheduling_metadata():
        return plan.metadata(
            mesh_build_count=mesh_stats["count"],
            aoa_case_count=total,
            mesh_reuse_mode=mesh_reuse_mode,
        )

    def build_polars() -> list[Polar]:
        polars: list[Polar] = []
        seen: set[tuple] = set()
        for chord in chords:
            for speed in speeds:
                if (chord, speed) in seen:
                    continue
                seen.add((chord, speed))
                re = physics.reynolds(speed, chord, request.fluid.nu)
                by_aoa = results.get((chord, speed), {})
                points = [
                    _outcome_to_point(job_id, by_aoa[a][0], by_aoa[a][1])
                    for a in aoas if a in by_aoa
                ]
                attempt_points = [
                    _outcome_to_point(job_id, slug, outcome)
                    for slug, outcome in attempts.get((chord, speed), [])
                ]
                polars.append(Polar(speed=speed, chord=chord, reynolds=re, points=points, attempts=attempt_points))
        return polars

    def write_partial_result_locked() -> None:
        store.write_result(
            JobResult(
                job_id=job_id,
                state=JobState.running,
                polars=build_polars(),
                scheduling=scheduling_metadata(),
            )
        )

    def record_outcome(chord: float, speed: float, item: StoredCaseOutcome, accepted: bool) -> None:
        key = (chord, speed)
        aoa = item.outcome.spec.aoa_deg
        with lock:
            if accepted:
                results.setdefault(key, {})[aoa] = (item.slug, item.outcome)
            else:
                attempts.setdefault(key, []).append((item.slug, item.outcome))
            write_partial_result_locked()

    use_warm_start = request.solver.warm_start and plan.resolved_policy == ResourcePolicy.airfoil_parallel

    if use_warm_start:
        # 2a. WARM-START: one polar per (chord, speed), marched serially over AoA,
        #     polars run concurrently. Image URLs are namespaced under the polar dir.
        def run_polar(chord: float, speed: float) -> tuple[float, float, PolarMarchResult]:
            ensure_not_cancelled()
            mesh_dir, resolved, n_cells = meshes[chord]
            polar_dir = store.case_dir(job_id, polar_slug(chord, speed))
            wait_for_cpu(plan.solver_processes, f"waiting for CPU before polar U={speed:g}")

            def phase_progress(
                phase: JobPhase,
                aoa: Optional[float],
                slug: Optional[str],
                solver: Optional[str],
                message: Optional[str] = None,
            ) -> None:
                set_status(
                    JobState.running,
                    message or f"{phase.value.replace('_', ' ')}",
                    phase=phase,
                    active_solver=solver,
                    active_case_slug=slug,
                    active_aoa_deg=aoa,
                    cpu_tokens_waiting=0,
                    cpu_tokens_held=plan.solver_processes,
                )

            with cpu_tokens.acquire(
                plan.solver_processes,
                on_wait=lambda _snapshot, s=speed: wait_for_cpu(plan.solver_processes, f"waiting for CPU before polar U={s:g}"),
                on_acquired=lambda _snapshot, s=speed: cpu_acquired(
                    plan.solver_processes,
                    JobPhase.solving_rans if not request.solver.force_transient else JobPhase.solving_urans,
                    f"{'URANS' if request.solver.force_transient else 'RANS'} solving polar U={s:g}",
                    solver="pimpleFoam" if request.solver.force_transient else "simpleFoam",
                ),
            ):
                march = solve_polar_marched(
                    polar_dir, mesh_dir, airfoil, chord, speed, request.fluid, request.roughness,
                    resolved, request.solver, mesher, runner, aoas, n_cells=n_cells,
                    n_proc=plan.solver_processes, render_images=render_images,
                    solver_timeout=settings.solver_timeout,
                    rans_solver_timeout=settings.rans_solver_timeout,
                    rans_max_iterations=settings.rans_max_iterations,
                    progress=bump,
                    phase_progress=phase_progress,
                    outcome_progress=lambda item, accepted, c=chord, s=speed: record_outcome(c, s, item, accepted),
                    cancel_check=ensure_not_cancelled,
                    cache=cache,
                    media_budget_s=settings.media_budget_seconds(),
                )
            ensure_not_cancelled()
            set_status(JobState.running, "polar complete", phase=JobPhase.ingesting, cpu_tokens_waiting=0, cpu_tokens_held=0)
            return chord, speed, march

        units = [(c, s) for c in chords for s in speeds]
        workers = max(1, min(plan.resolved_case_concurrency, len(units)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for fut in as_completed([pool.submit(run_polar, c, s) for c, s in units]):
                chord, speed, march = fut.result()
                results[(chord, speed)] = {
                    item.outcome.spec.aoa_deg: (item.slug, item.outcome)
                    for item in march.points
                }
                attempts[(chord, speed)] = [
                    (item.slug, item.outcome)
                    for item in march.attempts
                ]
    else:
        # 2b. DEFAULT: every (chord, speed, AoA) is an independent cold case that
        #     reuses the prebuilt mesh; all cases run concurrently (best throughput).
        def run_one(spec: CaseSpec) -> tuple:
            ensure_not_cancelled()
            mesh_dir, resolved, n_cells = meshes[spec.chord]
            solver_phase = JobPhase.solving_urans if request.solver.force_transient else JobPhase.solving_rans
            solver_name = "pimpleFoam" if request.solver.force_transient else "simpleFoam"

            def phase_progress(
                phase: JobPhase,
                aoa: Optional[float],
                slug: Optional[str],
                solver: Optional[str],
                message: Optional[str] = None,
            ) -> None:
                # Truthful per-case stage reporting for the default (cold,
                # case-parallel) path too: postprocessing must never masquerade
                # as solving (2026-07-07 render-grind incident).
                set_status(
                    JobState.running,
                    message or f"{phase.value.replace('_', ' ')} AoA {spec.aoa_deg:g}",
                    phase=phase,
                    active_solver=solver,
                    active_case_slug=slug,
                    active_aoa_deg=aoa,
                )

            wait_for_cpu(plan.solver_processes, f"waiting for CPU before AoA {spec.aoa_deg:g}", case=spec)
            with cpu_tokens.acquire(
                plan.solver_processes,
                on_wait=lambda _snapshot, case=spec: wait_for_cpu(
                    plan.solver_processes, f"waiting for CPU before AoA {case.aoa_deg:g}", case=case
                ),
                on_acquired=lambda _snapshot, case=spec: cpu_acquired(
                    plan.solver_processes,
                    solver_phase,
                    f"{solver_phase.value.replace('_', ' ')} AoA {case.aoa_deg:g}",
                    solver=solver_name,
                    case=case,
                ),
            ):
                # Pass the RESOLVED params of the shared mesh (not the raw request)
                # so the cache keys fields by the mesh geometry actually in use.
                outcome = run_case(
                    store.case_dir(job_id, spec.slug), airfoil, spec, request.fluid, request.roughness,
                    resolved, request.solver, mesher, runner, n_proc=plan.solver_processes,
                    render_images=render_images,
                    solver_timeout=settings.solver_timeout,
                    rans_solver_timeout=settings.rans_solver_timeout,
                    rans_max_iterations=settings.rans_max_iterations,
                    mesh_dir=mesh_dir,
                    cancel_check=ensure_not_cancelled,
                    cache=cache,
                    phase_progress=phase_progress,
                    case_slug=spec.slug,
                    media_budget_s=settings.media_budget_seconds(),
                )
            bump()
            return spec, outcome

        specs = request.cases()
        workers = max(1, min(plan.resolved_case_concurrency, len(specs)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for fut in as_completed([pool.submit(run_one, s) for s in specs]):
                spec, outcome = fut.result()
                with lock:
                    results.setdefault((spec.chord, spec.speed), {})[spec.aoa_deg] = (spec.slug, outcome)
                    write_partial_result_locked()

    # 3. Assemble polars (request order).
    polars = build_polars()

    any_ok = any(p.error is None for pol in polars for p in pol.points)
    state = JobState.completed if any_ok else JobState.failed
    result = JobResult(
        job_id=job_id,
        state=state,
        polars=polars,
        scheduling=scheduling_metadata(),
    )
    store.write_result(result)
    set_status(
        state,
        message=None if any_ok else "All cases failed",
        phase=JobPhase.completed if any_ok else JobPhase.failed,
        active_solver=None,
        active_case_slug=None,
        active_aoa_deg=None,
        cpu_tokens_waiting=0,
        cpu_tokens_held=0,
    )
    return result
