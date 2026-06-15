"""Execute a polar job: mesh once per airfoil/chord, then march each polar.

The unit of parallelism is the *polar* (one chord+speed, swept over AoA): the mesh
is built once per chord and reused, and each polar marches the angle of attack,
warm-starting each AoA from the previous converged field. Polars run concurrently
(``case_concurrency``); each polar's solves are serial (``n_proc=1``), which gives
the best total throughput for small 2D cases.
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Optional

from . import physics
from .airfoil import load_airfoil
from .config import Settings, get_settings
from .meshing.base import get_mesher
from .models import CaseSpec, JobResult, JobState, JobStatus, Polar, PolarPoint, PolarRequest
from .openfoam.runner import get_runner
from .pipeline import CaseOutcome, prepare_mesh, resolve_mesh_params, run_case, solve_polar_marched
from .storage import JobStore

ProgressCb = Optional[Callable[[JobStatus], None]]


def _slug(text: str) -> str:
    return text.replace(".", "p").replace("-", "m")


def _chord_slug(chord: float) -> str:
    return _slug(f"c{chord:g}")


def polar_slug(chord: float, speed: float) -> str:
    return _slug(f"c{chord:g}_u{speed:g}")


def _outcome_to_point(job_id: str, slug: str, outcome: CaseOutcome) -> PolarPoint:
    images = {
        field: f"/jobs/{job_id}/files/cases/{slug}/{rel}"
        for field, rel in outcome.images.items()
    }
    return PolarPoint(
        aoa_deg=outcome.spec.aoa_deg,
        cl=outcome.cl, cd=outcome.cd, cm=outcome.cm, cl_cd=outcome.cl_cd,
        cl_std=outcome.cl_std, cd_std=outcome.cd_std, cm_std=outcome.cm_std,
        unsteady=outcome.unsteady,
        converged=outcome.converged,
        final_residual=outcome.final_residual,
        iterations=outcome.iterations,
        y_plus_avg=outcome.y_plus_avg, y_plus_max=outcome.y_plus_max,
        first_order_fallback=outcome.first_order_fallback,
        images=images,
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

    lock = threading.Lock()
    completed = {"n": 0}

    def set_status(state: JobState, message: Optional[str] = None) -> None:
        st = JobStatus(
            job_id=job_id, state=state, total_cases=total,
            completed_cases=completed["n"], message=message,
        )
        store.write_status(st)
        if progress:
            progress(st)

    def bump() -> None:
        with lock:
            completed["n"] += 1
            set_status(JobState.running)

    set_status(JobState.running)

    # 1. Mesh ONCE per chord (sized for the highest speed -> finest wall; reused by
    #    every speed/AoA of that chord).
    max_speed = max(speeds)
    meshes: dict[float, tuple] = {}
    for chord in chords:
        resolved = resolve_mesh_params(
            request.mesh, CaseSpec(chord=chord, speed=max_speed, aoa_deg=0.0), request.fluid
        )
        mesh_dir = store.job_dir(job_id) / "meshes" / _chord_slug(chord)
        mr = prepare_mesh(mesh_dir, airfoil, resolved, chord, mesher, runner)
        meshes[chord] = (mesh_dir, resolved, mr.n_cells)

    render_images = bool(request.solver.write_images)
    results: dict[tuple, list] = {}

    if request.solver.warm_start:
        # 2a. WARM-START: one polar per (chord, speed), marched serially over AoA,
        #     polars run concurrently. Image URLs are namespaced under the polar dir.
        def run_polar(chord: float, speed: float) -> tuple:
            mesh_dir, resolved, n_cells = meshes[chord]
            polar_dir = store.case_dir(job_id, polar_slug(chord, speed))
            outs = solve_polar_marched(
                polar_dir, mesh_dir, airfoil, chord, speed, request.fluid, request.roughness,
                resolved, request.solver, mesher, runner, aoas, n_cells=n_cells,
                render_images=render_images, solver_timeout=settings.solver_timeout, progress=bump,
            )
            return chord, speed, outs

        units = [(c, s) for c in chords for s in speeds]
        workers = max(1, min(settings.case_concurrency, len(units)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for fut in as_completed([pool.submit(run_polar, c, s) for c, s in units]):
                chord, speed, outs = fut.result()
                results[(chord, speed)] = {o.spec.aoa_deg: (polar_slug(chord, speed), o) for o in outs}
    else:
        # 2b. DEFAULT: every (chord, speed, AoA) is an independent cold case that
        #     reuses the prebuilt mesh; all cases run concurrently (best throughput).
        def run_one(spec: CaseSpec) -> tuple:
            mesh_dir, resolved, n_cells = meshes[spec.chord]
            outcome = run_case(
                store.case_dir(job_id, spec.slug), airfoil, spec, request.fluid, request.roughness,
                request.mesh, request.solver, mesher, runner, n_proc=settings.solver_processes,
                render_images=render_images, solver_timeout=settings.solver_timeout, mesh_dir=mesh_dir,
            )
            bump()
            return spec, outcome

        specs = request.cases()
        workers = max(1, min(settings.case_concurrency, len(specs)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            for fut in as_completed([pool.submit(run_one, s) for s in specs]):
                spec, outcome = fut.result()
                results.setdefault((spec.chord, spec.speed), {})[spec.aoa_deg] = (spec.slug, outcome)

    # 3. Assemble polars (request order).
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
            polars.append(Polar(speed=speed, chord=chord, reynolds=re, points=points))

    any_ok = any(p.error is None for pol in polars for p in pol.points)
    state = JobState.completed if any_ok else JobState.failed
    result = JobResult(job_id=job_id, state=state, polars=polars)
    store.write_result(result)
    set_status(state, message=None if any_ok else "All cases failed")
    return result
