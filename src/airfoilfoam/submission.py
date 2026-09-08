from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
from typing import Callable

from .models import EngineIdentity, JobPhase, JobState, JobStatus, PolarRequest
from .storage import JobStore


class SubmissionError(RuntimeError):
    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.status_code = status_code


@contextmanager
def submission_lock(store: JobStore, job_id: str):
    directory = store.submission_dir(job_id)
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".submission.lock").open("a") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise SubmissionError("submission_in_progress", "Execution registration is already in progress") from error
        yield


def _receipt(store: JobStore, job_id: str, state: str, **details) -> None:
    path = store.submission_dir(job_id) / f".submission-{state}.json"
    if path.exists():
        try:
            previous = json.loads(path.read_text())
            if any(previous.get(key) != value for key, value in {"version": 1, "job_id": job_id, "state": state, **details}.items()):
                raise ValueError("conflicting receipt")
        except (OSError, ValueError, AttributeError) as error:
            raise SubmissionError("submission_metadata_unavailable", "Existing submission receipt is unreadable or conflicts", 503) from error
        return
    store._write_json_atomic(path, json.dumps({
        "version": 1, "job_id": job_id, "state": state,
        "recorded_at": datetime.now(timezone.utc).isoformat(), **details,
    }, sort_keys=True))


def register_stable_submission(store: JobStore, request: PolarRequest, enqueue: Callable[[str, PolarRequest], str]) -> JobStatus:
    if request.execution_id is None:
        raise ValueError("Stable submission requires an execution identity")
    job_id = str(request.execution_id)
    signature = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
    with submission_lock(store, job_id):
        if store.is_cancelled(job_id):
            raise SubmissionError("execution_cancelled", "Execution identity has a durable cancellation fence")
        request_path = store.job_dir(job_id) / "request.json"
        if request_path.exists():
            previous = store.read_request(job_id)
            if previous is None:
                raise SubmissionError("submission_metadata_unavailable", "Existing execution request is unreadable", 503)
            if previous.model_dump(mode="json") != request.model_dump(mode="json"):
                raise SubmissionError("execution_identity_conflict", "Execution identity belongs to a different immutable request")
            status = store.read_status(job_id)
            if status is None:
                raise SubmissionError("submission_metadata_unavailable", "Existing execution status is unreadable", 503)
            if not (store.submission_dir(job_id) / ".submission-dispatching.json").exists():
                raise SubmissionError("submission_confirmation_unavailable", "Execution registration was interrupted before dispatch confirmation", 503)
            _receipt(store, job_id, "dispatching", request_sha256=signature)
            return status
        if any(path.name != ".submission.lock" for path in store.submission_dir(job_id).iterdir()):
            raise SubmissionError("execution_retired", "Execution registration survives removal of its job artifacts; the identity cannot be reused", 410)
        if store.job_dir(job_id).exists() and any(store.job_dir(job_id).iterdir()):
            raise SubmissionError("submission_metadata_unavailable", "Execution scope contains artifacts without its request", 503)
        store.create(job_id, request)
        status = store.read_status(job_id)
        if status is None:
            raise SubmissionError("submission_metadata_unavailable", "Execution registration has no readable status", 503)
        status.task_id = job_id
        store.write_status(status)
        _receipt(store, job_id, "dispatching", request_sha256=signature)
        try:
            acknowledged_id = enqueue(job_id, request)
            if acknowledged_id != job_id:
                raise RuntimeError("Broker did not acknowledge the allocated execution identity")
        except Exception as error:
            _receipt(store, job_id, "uncertain", error_kind=type(error).__name__)
            raise SubmissionError("submission_confirmation_unavailable", "Broker dispatch confirmation is unavailable; execution ownership is retained", 503) from error
        _receipt(store, job_id, "accepted")
        status = store.read_status(job_id)
        if status is None:
            raise SubmissionError("submission_metadata_unavailable", "Accepted execution status is unreadable", 503)
        return status


def fence_stable_submission(store: JobStore, job_id: str, expected_engine: EngineIdentity | None = None) -> EngineIdentity:
    with submission_lock(store, job_id):
        directory = store.job_dir(job_id)
        request = store.read_request(job_id)
        status = store.read_status(job_id)
        known_engine = request.expected_engine if request else status.requested_engine if status else None
        if known_engine is None and request is not None:
            known_engine = EngineIdentity()
        if known_engine is not None and expected_engine is not None and known_engine != expected_engine:
            raise SubmissionError("execution_identity_conflict", "Cancellation engine does not match the registered execution")
        if request is None and status is None:
            if expected_engine is None:
                raise SubmissionError("unregistered_execution_route_required", "Unregistered cancellation requires its exact engine route", 422)
            if any(path.name != ".submission.lock" for path in store.submission_dir(job_id).iterdir()):
                raise SubmissionError("execution_retired", "Execution registration survives removal of its job artifacts; no new execution owner can be inferred", 410)
            if directory.exists() and any(directory.iterdir()):
                raise SubmissionError("submission_metadata_unavailable", "Execution artifacts exist without a readable registration", 503)
            known_engine = expected_engine
            store._write_json_atomic(directory / ".execution-not-started.json", json.dumps({"version": 1, "job_id": job_id}))
            store.write_status(JobStatus(job_id=job_id, state=JobState.cancelled, phase=JobPhase.cancelled,
                                        requested_engine=known_engine, message="cancelled before registration"))
        elif request is None and not store.is_cancelled(job_id):
            raise SubmissionError("submission_metadata_unavailable", "Execution request is unavailable for cancellation routing", 503)
        if known_engine is None:
            raise SubmissionError("submission_metadata_unavailable", "Execution engine route is unavailable", 503)
        store.mark_cancelled(job_id)
        _receipt(store, job_id, "cancelled", requested_engine=known_engine.model_dump(mode="json"))
        return known_engine
