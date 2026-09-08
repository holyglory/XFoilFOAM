from __future__ import annotations

import fcntl
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .storage import JobStore
from .models import JobState


def _namespace_identity() -> dict:
    return {
        "version": 1,
        "boot_id": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
        "pid_namespace": os.readlink("/proc/self/ns/pid"),
        "uid": os.geteuid(),
    }


def record_execution_owner(store: JobStore, job_id: str) -> None:
    owner_path = store.job_dir(job_id) / ".execution-owner.json"
    identity = _namespace_identity()
    if owner_path.exists() and json.loads(owner_path.read_text()) != identity:
        raise RuntimeError("Job execution belongs to a different process namespace; submit a fresh job")
    store._write_json_atomic(
        owner_path, json.dumps(identity, sort_keys=True),
    )
    (store.job_dir(job_id) / ".execution-not-started.json").unlink(missing_ok=True)


def execution_stop_proof(store: JobStore, job_id: str) -> dict:
    proof = {
        "version": 1,
        "job_id": job_id,
        "execution_stopped": False,
        "producer_stopped": False,
        "namespace_verified": False,
        "remaining": None,
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "error": None,
        "fence": None,
        "ownership_basis": None,
    }
    if store.is_cancelled(job_id):
        proof["fence"] = "cancel_marker"
    else:
        terminal = store.read_result(job_id)
        if terminal is None or terminal.state not in {JobState.completed, JobState.failed, JobState.cancelled}:
            proof["error"] = "Job has no durable terminal execution fence"
            return proof
        proof["fence"] = "terminal_result"
    try:
        with (store.job_dir(job_id) / ".execute.lock").open("a") as execution_lock:
            try:
                fcntl.flock(execution_lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                proof["error"] = "Job producer still owns its execution lock"
                return proof
            owner_path = store.job_dir(job_id) / ".execution-owner.json"
            if owner_path.exists():
                owner = json.loads(owner_path.read_text())
                if owner != _namespace_identity():
                    proof["error"] = "Reaper cannot verify the execution process namespace"
                    return proof
                proof["ownership_basis"] = "recorded_execution_namespace"
            else:
                prepared = json.loads((store.job_dir(job_id) / ".execution-not-started.json").read_text())
                status = store.read_status(job_id)
                if (
                    proof["fence"] != "cancel_marker"
                    or prepared != {"version": 1, "job_id": job_id}
                    or status is None or status.job_id != job_id
                    or status.engine is not None or status.started_at is not None
                    or status.state not in {JobState.pending, JobState.cancelled}
                ):
                    proof["error"] = "Job has no exact never-started cancellation fence"
                    return proof
                proof["ownership_basis"] = "never_started_cancellation_fence"
            proof["namespace_verified"] = True
            proof["producer_stopped"] = True
            proof["remaining"] = store.job_processes(job_id, strict=True)
            proof["execution_stopped"] = not proof["remaining"]
            if proof["remaining"]:
                proof["error"] = "Job child processes remain alive"
    except (OSError, ValueError, RuntimeError) as error:
        proof["error"] = str(error)
    proof["observed_at"] = datetime.now(timezone.utc).isoformat()
    return proof
