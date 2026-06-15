"""Celery tasks that run polar jobs in the worker (OpenFOAM-enabled) container."""
from __future__ import annotations

from .celery_app import celery_app
from .config import get_settings
from .jobs import execute_job
from .models import JobResult, JobState, JobStatus, PolarRequest
from .storage import JobStore


@celery_app.task(name="airfoilfoam.run_polar", bind=True)
def run_polar(self, job_id: str, request_json: str) -> dict:
    settings = get_settings()
    store = JobStore(settings)
    request = PolarRequest.model_validate_json(request_json)
    try:
        result = execute_job(job_id, request, store=store, settings=settings)
    except Exception as exc:  # noqa: BLE001
        store.write_status(
            JobStatus(job_id=job_id, state=JobState.failed, message=f"{type(exc).__name__}: {exc}")
        )
        store.write_result(
            JobResult(job_id=job_id, state=JobState.failed, message=f"{type(exc).__name__}: {exc}")
        )
        raise
    return {"job_id": job_id, "state": result.state.value}
