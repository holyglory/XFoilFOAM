"""Celery tasks that run polar jobs in the worker (OpenFOAM-enabled) container."""
from __future__ import annotations

import fcntl
import logging
import os
import signal
import threading
import time
from datetime import datetime, timezone

from celery.signals import worker_ready

from .cancellation import JobCancelled
from .celery_app import celery_app
from .config import get_settings
from .jobs import execute_job
from .models import JobPhase, JobResult, JobState, JobStatus, PolarRequest
from .openfoam.runner import install_subprocess_signal_handlers
from .storage import JobStore

HEARTBEAT_INTERVAL_S = 10

logger = logging.getLogger(__name__)

# Captured at import time in the worker's main process, i.e. strictly before
# the consumer accepts any task. Any status.json touched at/after this instant
# belongs to a task started by THIS worker and must not be reconciled.
_WORKER_BOOT_TIME = datetime.now(timezone.utc)


@worker_ready.connect
def reconcile_orphaned_jobs(sender=None, **_kwargs) -> None:
    """Fail jobs whose celery task died with a previous worker process.

    Hooked at ``worker_ready`` (not API startup) because the worker owns task
    execution: an API restart while a healthy worker is mid-solve must not
    fail live jobs, whereas a freshly booted worker provably inherited no
    running tasks — they die with the process. A cross-worker ``inspect``
    plus the boot-time guard keeps this safe even if multiple workers or
    racy restart orders ever appear.
    """
    store = JobStore(get_settings())
    app = getattr(sender, "app", None) or celery_app
    active_ids: set[str] = set()
    try:
        replies = app.control.inspect(timeout=2.0).active() or {}
        for rows in replies.values():
            for row in rows or []:
                task_id = (row or {}).get("id")
                if task_id:
                    active_ids.add(str(task_id))
    except Exception:  # noqa: BLE001 - best effort; the boot-time guard still protects fresh tasks
        logger.warning("orphan reconcile: celery inspect failed; relying on boot-time guard", exc_info=True)
    reconciled = store.reconcile_orphans(boot_time=_WORKER_BOOT_TIME, active_task_ids=active_ids)
    for job_id in reconciled:
        # acks_late means Redis may redeliver the lost task after its
        # visibility timeout; revoke so a redelivery is discarded instead of
        # resurrecting a job the node already failed (task_id == job_id).
        try:
            app.control.revoke(job_id)
        except Exception:  # noqa: BLE001
            pass
        logger.warning("orphan reconcile: job %s marked failed (worker restarted mid-solve; task lost)", job_id)
    if reconciled:
        logger.warning("orphan reconcile: %d job(s) reconciled at worker boot", len(reconciled))


def _kill_pids(pids: list[int], sig: int) -> None:
    pgids: set[int] = set()
    for pid in pids:
        try:
            pgids.add(os.getpgid(pid))
        except ProcessLookupError:
            pass
    for pgid in pgids:
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
    for pid in pids:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


@celery_app.task(name="airfoilfoam.kill_job_processes")
def kill_job_processes(job_id: str) -> dict:
    settings = get_settings()
    store = JobStore(settings)
    pids = store.job_processes(job_id)
    _kill_pids(pids, signal.SIGTERM)
    time.sleep(1)
    remaining = store.job_processes(job_id)
    _kill_pids(remaining, signal.SIGKILL)
    return {"job_id": job_id, "terminated": pids, "killed": remaining}


def _start_runtime_heartbeat(store: JobStore, job_id: str) -> tuple[threading.Event, threading.Thread]:
    stop = threading.Event()

    def loop() -> None:
        while not stop.is_set():
            try:
                status = store.read_status(job_id)
                processes = store.job_process_details(job_id)
                active = _active_process(processes)
                store.write_runtime_heartbeat(
                    job_id,
                    os.getpid(),
                    len(processes),
                    process_details=processes,
                    phase=status.phase.value if status else None,
                    active_solver=(active or {}).get("command") or (status.active_solver if status else None),
                    active_case_slug=(active or {}).get("case_slug") or (status.active_case_slug if status else None),
                    active_aoa_deg=status.active_aoa_deg if status else None,
                    cpu_tokens_waiting=status.cpu_tokens_waiting if status else None,
                    cpu_tokens_held=status.cpu_tokens_held if status else None,
                    current_case=(active or {}).get("case_slug"),
                    last_progress_at=status.last_progress_at.isoformat() if status and status.last_progress_at else None,
                )
            except Exception:
                pass
            stop.wait(HEARTBEAT_INTERVAL_S)

    thread = threading.Thread(target=loop, name=f"job-heartbeat-{job_id[:8]}", daemon=True)
    thread.start()
    return stop, thread


def _active_process(processes: list[dict]) -> dict | None:
    for mode in ("urans", "rans", "meshing"):
        for proc in processes:
            if proc.get("solver_mode") == mode:
                return proc
    return processes[0] if processes else None


@celery_app.task(name="airfoilfoam.run_polar", bind=True)
def run_polar(self, job_id: str, request_json: str) -> dict:
    install_subprocess_signal_handlers()
    settings = get_settings()
    store = JobStore(settings)
    request = PolarRequest.model_validate_json(request_json)
    lock_path = store.job_dir(job_id) / ".execute.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            existing = store.read_result(job_id)
            if existing:
                return {"job_id": job_id, "state": existing.state.value}
            return {"job_id": job_id, "state": "duplicate-skipped"}
        existing = store.read_result(job_id)
        if existing and existing.state == JobState.completed:
            return {"job_id": job_id, "state": existing.state.value}
        status = store.read_status(job_id)
        if status:
            status.task_id = getattr(self.request, "id", None) or status.task_id
            status.state = JobState.running
            store.write_status(status)
        stop_heartbeat, heartbeat_thread = _start_runtime_heartbeat(store, job_id)
        try:
            result = execute_job(job_id, request, store=store, settings=settings)
        except JobCancelled:
            result = JobResult(job_id=job_id, state=JobState.cancelled, message="cancelled")
            status = store.read_status(job_id) or JobStatus(job_id=job_id, state=JobState.cancelled)
            status.state = JobState.cancelled
            status.phase = JobPhase.cancelled
            status.message = "cancelled"
            store.write_status(status)
            store.write_result(result)
            return {"job_id": job_id, "state": "cancelled"}
        except Exception as exc:  # noqa: BLE001
            store.write_status(
                JobStatus(job_id=job_id, state=JobState.failed, message=f"{type(exc).__name__}: {exc}")
            )
            store.write_result(
                JobResult(job_id=job_id, state=JobState.failed, message=f"{type(exc).__name__}: {exc}")
            )
            raise
        finally:
            stop_heartbeat.set()
            heartbeat_thread.join(timeout=2)
            try:
                status = store.read_status(job_id)
                store.write_runtime_heartbeat(
                    job_id,
                    os.getpid(),
                    0,
                    phase=status.phase.value if status else None,
                    cpu_tokens_waiting=status.cpu_tokens_waiting if status else 0,
                    cpu_tokens_held=status.cpu_tokens_held if status else 0,
                )
            except Exception:
                pass
        return {"job_id": job_id, "state": result.state.value}
