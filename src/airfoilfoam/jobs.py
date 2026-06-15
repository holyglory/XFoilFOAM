"""Execute a whole polar job: fan out over (chord, speed, AoA) cases and collect."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Callable, Optional

from . import physics
from .airfoil import load_airfoil
from .config import Settings, get_settings
from .meshing.base import get_mesher
from .models import (
    CaseSpec,
    JobResult,
    JobState,
    JobStatus,
    Polar,
    PolarPoint,
    PolarRequest,
)
from .openfoam.runner import get_runner
from .pipeline import CaseOutcome, run_case
from .storage import JobStore

ProgressCb = Optional[Callable[[JobStatus], None]]


def _outcome_to_point(job_id: str, slug: str, outcome: CaseOutcome) -> PolarPoint:
    images = {
        field: f"/jobs/{job_id}/files/cases/{slug}/{rel}"
        for field, rel in outcome.images.items()
    }
    return PolarPoint(
        aoa_deg=outcome.spec.aoa_deg,
        cl=outcome.cl,
        cd=outcome.cd,
        cm=outcome.cm,
        cl_cd=outcome.cl_cd,
        converged=outcome.converged,
        final_residual=outcome.final_residual,
        iterations=outcome.iterations,
        y_plus_avg=outcome.y_plus_avg,
        y_plus_max=outcome.y_plus_max,
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

    specs = request.cases()
    total = len(specs)
    status = JobStatus(job_id=job_id, state=JobState.running, total_cases=total, completed_cases=0)
    store.write_status(status)
    if progress:
        progress(status)

    outcomes: dict[str, CaseOutcome] = {}

    def _run(spec: CaseSpec) -> tuple[str, CaseOutcome]:
        case_dir = store.case_dir(job_id, spec.slug)
        outcome = run_case(
            case_dir=case_dir,
            airfoil=airfoil,
            spec=spec,
            fluid=request.fluid,
            roughness=request.roughness,
            mesh_params=request.mesh,
            solver_params=request.solver,
            mesher=mesher,
            runner=runner,
            n_proc=settings.solver_processes,
            render_images=bool(request.solver.write_images),
            solver_timeout=settings.solver_timeout,
        )
        return spec.slug, outcome

    workers = max(1, min(settings.case_concurrency, total))
    completed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = [pool.submit(_run, s) for s in specs]
        for fut in as_completed(futures):
            slug, outcome = fut.result()
            outcomes[slug] = outcome
            completed += 1
            status = JobStatus(
                job_id=job_id, state=JobState.running, total_cases=total, completed_cases=completed
            )
            store.write_status(status)
            if progress:
                progress(status)

    # group into polars by (chord, speed), preserving request order
    polars: list[Polar] = []
    seen: set[tuple[float, float]] = set()
    for chord in request.chord_lengths:
        for speed in request.speeds:
            key = (chord, speed)
            if key in seen:
                continue
            seen.add(key)
            re = physics.reynolds(speed, chord, request.fluid.nu)
            points: list[PolarPoint] = []
            for aoa in request.aoa.expand():
                slug = CaseSpec(chord=chord, speed=speed, aoa_deg=aoa).slug
                if slug in outcomes:
                    points.append(_outcome_to_point(job_id, slug, outcomes[slug]))
            polars.append(Polar(speed=speed, chord=chord, reynolds=re, points=points))

    any_ok = any(p.error is None for pol in polars for p in pol.points)
    state = JobState.completed if any_ok else JobState.failed
    result = JobResult(job_id=job_id, state=state, polars=polars)
    store.write_result(result)
    final = JobStatus(
        job_id=job_id, state=state, total_cases=total, completed_cases=completed,
        message=None if any_ok else "All cases failed",
    )
    store.write_status(final)
    if progress:
        progress(final)
    return result
