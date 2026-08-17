#!/usr/bin/env python3
"""Prove a wedged production engine is physically idle without trusting its API.

This helper is deliberately narrower than the normal ``/queue`` contract.  It
is available only while the source-pinned watcher owns the production database
drain and only for the one deployed gateway generation whose synchronous API
pool can be exhausted by leaked evidence-stream leases.  It never mutates a
job, queue, status file, writer, or service.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid
from typing import Any, Protocol


AFFECTED_RUNTIME = {
    "build_id": "b7d9213f59f2c1c19b8890b1500b81cf168d83aa",
    "engine_version": "2606",
    "urans_recovery_version": 12,
    "archive_reduction_version": 4,
    "queue_observation_version": 1,
}
URANS_CLEAN_CYCLE_AFFECTED_RUNTIME = {
    "build_id": "8d8aed9-clean-cycle-v13",
    "engine_version": "2606",
    "urans_recovery_version": 12,
    "archive_reduction_version": 4,
    "queue_observation_version": 1,
}
AFFECTED_RUNTIMES = (
    AFFECTED_RUNTIME,
    URANS_CLEAN_CYCLE_AFFECTED_RUNTIME,
)
MAX_RECOVERY_JOBS = 100


def _is_exact_affected_runtime(value: object) -> bool:
    return isinstance(value, dict) and any(
        set(value) == set(affected)
        and all(
            type(value[field]) is type(expected) and value[field] == expected
            for field, expected in affected.items()
        )
        for affected in AFFECTED_RUNTIMES
    )
MAX_RECEIPT_ENGINE_MESSAGE_BYTES = 4096
CANONICAL_ENGINE_JOB_ID_RE = re.compile(r"[0-9a-f]{32}")
TERMINAL_PHASES = {
    "completed": "completed",
    "failed": "failed",
    "cancelled": "cancelled",
}
WORKER_RESTART_ORPHAN_MESSAGE = "worker restarted mid-solve; task lost"
SETTLEMENT_ACTIONS = {
    "ingest",
    "release_cancelled",
    "release_worker_restart_orphan",
}
OPENFOAM_PROCESS_RE = (
    r"[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|"
    r"[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|"
    r"[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|"
    r"[f]oamToVTK|[f]oamRun|[f]oamJob"
)
CAPABILITY_PROBE = r'''
# AIRFOILS_PRO_PRODUCTION_MAINTENANCE_CAPABILITY_PROBE
import json
from airfoilfoam.api.main import QUEUE_OBSERVATION_HEALTH_VERSION
from airfoilfoam.capabilities import ARCHIVE_REDUCTION_VERSION, URANS_RECOVERY_VERSION
from airfoilfoam.config import get_settings

settings = get_settings()
runtime = settings.engine_runtime_identity()
print(json.dumps({
    "build_id": settings.build_id,
    "engine_version": runtime.version,
    "urans_recovery_version": URANS_RECOVERY_VERSION,
    "archive_reduction_version": ARCHIVE_REDUCTION_VERSION,
    "queue_observation_version": QUEUE_OBSERVATION_HEALTH_VERSION,
}, separators=(",", ":")))
'''.strip()
CELERY_REDIS_PROBE = r'''
# AIRFOILS_PRO_PRODUCTION_MAINTENANCE_CELERY_REDIS_PROBE
import json
import signal
from redis import Redis
from airfoilfoam.celery_app import celery_app
from airfoilfoam.config import get_settings
from airfoilfoam.openfoam.dialects import get_openfoam_dialect, supported_openfoam_identities

def deadline(_signum, _frame):
    raise TimeoutError("direct production queue proof exceeded 15 seconds")

signal.signal(signal.SIGALRM, deadline)
signal.alarm(15)
inspect = celery_app.control.inspect(timeout=3.0)
raw = {
    "active": inspect.active(),
    "reserved": inspect.reserved(),
    "scheduled": inspect.scheduled(),
    "active_queues": inspect.active_queues(),
}
settings = get_settings()
redis = Redis.from_url(
    settings.broker_url,
    socket_connect_timeout=2.0,
    socket_timeout=2.0,
    retry_on_timeout=False,
)
queue_names = sorted(
    {get_openfoam_dialect(identity).queue_name for identity in supported_openfoam_identities()}
)
raw["queue_depths"] = {name: int(redis.llen(name)) for name in queue_names}
transport = {}
for name in ("unacked", "unacked_index"):
    kind = redis.type(name)
    if isinstance(kind, bytes):
        kind = kind.decode("ascii", "strict")
    if kind == "none":
        transport[name] = 0
    elif kind == "hash":
        transport[name] = int(redis.hlen(name))
    elif kind == "zset":
        transport[name] = int(redis.zcard(name))
    elif kind == "list":
        transport[name] = int(redis.llen(name))
    else:
        raise RuntimeError(f"unexpected Celery transport key type for {name}: {kind!r}")
raw["transport_unacked_counts"] = transport
print(json.dumps(raw, separators=(",", ":")))
'''.strip()
STATUS_PROBE = r'''
# AIRFOILS_PRO_PRODUCTION_MAINTENANCE_STATUS_PROBE
import json
import hashlib
import os
import stat
import sys
from airfoilfoam.storage import JobStore

job_ids = json.load(sys.stdin)
if not isinstance(job_ids, list) or len(job_ids) > 512:
    raise SystemExit("invalid maintenance status job-id set")
store = JobStore()
output = {}
def digest_regular(path):
    try:
        metadata = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
            return None
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()
    except FileNotFoundError:
        return None
for job_id in job_ids:
    if not isinstance(job_id, str) or not job_id or job_id in output:
        raise SystemExit("invalid or duplicate maintenance status job id")
    status_value, read_error = store.read_status_info(job_id)
    status_path = store.job_dir(job_id) / "status.json"
    result_path = store.job_dir(job_id) / "result.json"
    status_sha256 = digest_regular(status_path)
    result_sha256 = digest_regular(result_path)
    output[job_id] = {
        "read_error": read_error,
        "status": status_value.model_dump(mode="json") if status_value is not None else None,
        "status_sha256": status_sha256,
        "result_sha256": result_sha256,
        "result_present": result_sha256 is not None,
    }
print(json.dumps(output, separators=(",", ":")))
'''.strip()
DATABASE_QUERY = r'''
/* AIRFOILS_PRO_PRODUCTION_MAINTENANCE_DATABASE_PROBE */
SELECT json_build_object(
  'admission', json_build_object(
    'enabled', enabled,
    'admission_fence_active', admission_fence_active,
    'maintenance_drain_token', maintenance_drain_token,
    'maintenance_drain_started_at', maintenance_drain_started_at
  ),
  'jobs', COALESCE((
    SELECT json_agg(json_build_object(
      'id', job.id,
      'status', job.status,
      'engine_state', job.engine_state,
      'engine_job_id', job.engine_job_id,
      'ingested_at', job."ingestedAt",
      'ingest_lease_live', (
        job.status = 'ingesting'
        AND (
          job.ingest_lease_expires_at > now()
          OR (
            job.ingest_lease_expires_at IS NULL
            AND job."updatedAt" > now() - (600000 * interval '1 millisecond')
          )
        )
      )
    ) ORDER BY job."updatedAt", job.id)
    FROM sim_jobs AS job
    WHERE job.status IN ('pending','submitted','running','ingesting')
  ), '[]'::json)
)::text
FROM sweeper_state
WHERE id = 1;
'''.strip()


def _candidate_digest(candidates: list[dict[str, Any]]) -> str:
    payload = json.dumps(
        sorted(candidates, key=lambda value: value["jobId"]),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


class PreflightError(RuntimeError):
    pass


class CommandSystem(Protocol):
    def capture(
        self, args: list[str], timeout: float, *, input_text: str | None = None
    ) -> subprocess.CompletedProcess[str]: ...


class RealCommandSystem:
    def capture(
        self, args: list[str], timeout: float, *, input_text: str | None = None
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            args,
            text=True,
            input=input_text,
            capture_output=True,
            check=False,
            timeout=timeout,
        )


@dataclasses.dataclass(frozen=True)
class Containers:
    api: str
    postgres: str
    workers: tuple[str, ...]
    running_services: frozenset[str]


def _canonical_token(raw: str) -> str:
    try:
        parsed = uuid.UUID(raw)
    except (ValueError, AttributeError) as error:
        raise PreflightError("production maintenance token is invalid") from error
    canonical = str(parsed)
    if raw != canonical:
        raise PreflightError("production maintenance token is not canonical")
    return canonical


def _json_output(
    completed: subprocess.CompletedProcess[str], label: str
) -> Any:
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise PreflightError(f"{label} failed: {detail}")
    try:
        return json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise PreflightError(f"{label} returned invalid JSON") from error


def _containers(
    system: CommandSystem, project: str, timeout: float
) -> Containers:
    listing = system.capture(
        [
            "docker",
            "ps",
            "--filter",
            f"label=com.docker.compose.project={project}",
            "--format",
            '{{.ID}}\t{{.Label "com.docker.compose.service"}}',
        ],
        timeout,
    )
    if listing.returncode != 0:
        raise PreflightError(
            "production container inventory failed: "
            f"{(listing.stderr or listing.stdout).strip()}"
        )
    by_service: dict[str, list[str]] = {}
    for line in listing.stdout.splitlines():
        container_id, separator, service = line.partition("\t")
        if not separator or not container_id or not service:
            raise PreflightError("production container inventory is malformed")
        by_service.setdefault(service, []).append(container_id)
    for service in ("api", "postgres"):
        if len(by_service.get(service, ())) != 1:
            raise PreflightError(f"production requires exactly one running {service}")
    workers = tuple(
        container_id
        for service, container_ids in sorted(by_service.items())
        if service == "worker" or service.startswith("worker-")
        for container_id in container_ids
    )
    if not workers:
        raise PreflightError("production has no running engine worker")
    return Containers(
        api=by_service["api"][0],
        postgres=by_service["postgres"][0],
        workers=workers,
        running_services=frozenset(by_service),
    )


def _capability_identity(
    system: CommandSystem, containers: Containers, timeout: float
) -> dict[str, Any]:
    observed: list[dict[str, Any]] = []
    for container_id in (containers.api, *containers.workers):
        value = _json_output(
            system.capture(
                ["docker", "exec", container_id, "python3", "-c", CAPABILITY_PROBE],
                timeout,
            ),
            "production runtime capability probe",
        )
        if not isinstance(value, dict):
            raise PreflightError("production runtime capability probe is incomplete")
        observed.append(value)
    if any(not _is_exact_affected_runtime(value) for value in observed):
        raise PreflightError(
            "production runtime is not the exact affected legacy gateway family"
        )
    return observed[0]


def _openfoam_processes(
    system: CommandSystem, containers: Containers, timeout: float
) -> list[str]:
    found: list[str] = []
    for container_id in containers.workers:
        completed = system.capture(
            ["docker", "exec", container_id, "pgrep", "-af", OPENFOAM_PROCESS_RE],
            timeout,
        )
        if completed.returncode not in (0, 1):
            raise PreflightError(
                "production OpenFOAM process probe failed: "
                f"{(completed.stderr or completed.stdout).strip()}"
            )
        found.extend(line for line in completed.stdout.splitlines() if line.strip())
    return found


def _worker_node_names(
    system: CommandSystem, containers: Containers, timeout: float
) -> set[str]:
    names: set[str] = set()
    for container_id in containers.workers:
        completed = system.capture(
            ["docker", "exec", container_id, "hostname"], timeout
        )
        hostname = completed.stdout.strip()
        if (
            completed.returncode != 0
            or not hostname
            or len(completed.stdout.splitlines()) != 1
            or any(character.isspace() for character in hostname)
        ):
            raise PreflightError("production worker hostname probe failed")
        names.add(f"celery@{hostname}")
    if len(names) != len(containers.workers):
        raise PreflightError("production worker identities are not unique")
    return names


def _queue_snapshot(
    system: CommandSystem,
    containers: Containers,
    expected_workers: set[str],
    timeout: float,
) -> tuple[bool, set[str], dict[str, Any]]:
    value = _json_output(
        system.capture(
            ["docker", "exec", containers.api, "python3", "-c", CELERY_REDIS_PROBE],
            timeout,
        ),
        "production direct Celery/Redis probe",
    )
    if not isinstance(value, dict):
        raise PreflightError("production direct Celery/Redis probe is incomplete")
    names = ("active", "reserved", "scheduled", "active_queues")
    replies: dict[str, dict[str, Any]] = {}
    worker_sets: dict[str, set[str]] = {}
    for name in names:
        current = value.get(name)
        if not isinstance(current, dict):
            raise PreflightError(f"production direct probe lacks {name} coverage")
        if any(not isinstance(worker, str) or not worker for worker in current):
            raise PreflightError(f"production direct probe has invalid {name} workers")
        replies[name] = current
        worker_sets[name] = set(current)
    if worker_sets["active_queues"] != expected_workers:
        raise PreflightError("production direct probe worker coverage is incomplete")
    for name in names[:-1]:
        if worker_sets[name] != expected_workers:
            raise PreflightError(
                f"production direct probe worker coverage is incomplete for {name}"
            )
    task_ids: set[str] = set()
    task_counts: dict[str, int] = {}
    for name in names[:-1]:
        count = 0
        for tasks in replies[name].values():
            if not isinstance(tasks, list) or any(not isinstance(task, dict) for task in tasks):
                raise PreflightError(f"production direct probe has invalid {name} tasks")
            for task in tasks:
                task_id = task.get("id")
                if not isinstance(task_id, str) or not task_id:
                    raise PreflightError(f"production direct probe has an invalid {name} task id")
                task_ids.add(task_id)
            count += len(tasks)
        task_counts[name] = count
    queue_depths = value.get("queue_depths")
    if (
        not isinstance(queue_depths, dict)
        or not queue_depths
        or any(not isinstance(name, str) or not name or type(depth) is not int or depth < 0 for name, depth in queue_depths.items())
    ):
        raise PreflightError("production direct probe lacks registered queue depths")
    for worker, queues in replies["active_queues"].items():
        if not isinstance(queues, list) or not queues:
            raise PreflightError(f"production direct probe has no queues for {worker}")
        for queue in queues:
            if not isinstance(queue, dict) or not isinstance(queue.get("name"), str):
                raise PreflightError("production direct probe has invalid worker queues")
            if queue["name"] not in queue_depths:
                raise PreflightError("production worker is bound to an unregistered queue")
    transport = value.get("transport_unacked_counts")
    if (
        not isinstance(transport, dict)
        or set(transport) != {"unacked", "unacked_index"}
        or any(type(count) is not int or count < 0 for count in transport.values())
    ):
        raise PreflightError("production direct probe lacks transport bookkeeping")
    idle = (
        all(count == 0 for count in task_counts.values())
        and all(depth == 0 for depth in queue_depths.values())
        and all(count == 0 for count in transport.values())
    )
    return idle, task_ids, {
        "taskCounts": task_counts,
        "queueDepths": queue_depths,
        "transportUnackedCounts": transport,
        "workerCount": len(expected_workers),
    }


def _database_snapshot(
    system: CommandSystem, containers: Containers, token: str, timeout: float
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    value = _json_output(
        system.capture(
            [
                "docker", "exec", containers.postgres, "psql",
                "-U", "aerodb", "-d", "aerodb", "-X", "-A", "-t",
                "-v", "ON_ERROR_STOP=1", "-c", DATABASE_QUERY,
            ],
            timeout,
        ),
        "production maintenance database probe",
    )
    if not isinstance(value, dict) or set(value) != {"admission", "jobs"}:
        raise PreflightError("production maintenance database snapshot is incomplete")
    admission = value["admission"]
    jobs = value["jobs"]
    if (
        not isinstance(admission, dict)
        or admission.get("enabled") is not False
        or admission.get("admission_fence_active") is not False
        or admission.get("maintenance_drain_token") != token
        or not isinstance(admission.get("maintenance_drain_started_at"), str)
    ):
        raise PreflightError("production maintenance drain ownership is not exact")
    if not isinstance(jobs, list) or len(jobs) > MAX_RECOVERY_JOBS:
        raise PreflightError("production maintenance job snapshot is invalid or unbounded")
    expected_keys = {
        "id",
        "status",
        "engine_state",
        "engine_job_id",
        "ingested_at",
        "ingest_lease_live",
    }
    if any(not isinstance(job, dict) or set(job) != expected_keys for job in jobs):
        raise PreflightError("production maintenance job row is malformed")
    return jobs, admission


def _status_snapshot(
    system: CommandSystem,
    containers: Containers,
    jobs: list[dict[str, Any]],
    timeout: float,
) -> dict[str, Any]:
    job_ids = sorted(
        {
            job["engine_job_id"]
            for job in jobs
            if isinstance(job.get("engine_job_id"), str)
            and job["engine_job_id"].strip()
        }
    )
    value = _json_output(
        system.capture(
            ["docker", "exec", "-i", containers.api, "python3", "-c", STATUS_PROBE],
            timeout,
            input_text=json.dumps(job_ids, separators=(",", ":")),
        ),
        "production terminal status probe",
    )
    if not isinstance(value, dict) or set(value) != set(job_ids):
        raise PreflightError("production terminal status snapshot is incomplete")
    return value


def _terminal_candidate(job: dict[str, Any], evidence: Any) -> bool:
    engine_job_id = job.get("engine_job_id")
    if not isinstance(engine_job_id, str) or not engine_job_id.strip():
        return False
    if not isinstance(evidence, dict) or set(evidence) != {
        "read_error",
        "status",
        "status_sha256",
        "result_sha256",
        "result_present",
    }:
        return False
    if evidence["read_error"] is not None or evidence["result_present"] is not True:
        return False
    status = evidence["status"]
    if not isinstance(status, dict) or status.get("job_id") != engine_job_id:
        return False
    state = status.get("state")
    if state not in TERMINAL_PHASES or status.get("phase") != TERMINAL_PHASES[state]:
        return False
    if status.get("cpu_tokens_held") != 0 or status.get("cpu_tokens_waiting") != 0:
        return False
    for key in ("status_sha256", "result_sha256"):
        value = evidence.get(key)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
            return False
    if job["status"] == "running":
        return True
    return (
        job["status"] == "ingesting"
        and job["engine_state"] == "completed"
        and job["ingest_lease_live"] is False
    )


def _settlement_action(evidence: dict[str, Any]) -> str:
    status = evidence["status"]
    if status["state"] == "cancelled":
        return "release_cancelled"
    if (
        status["state"] == "failed"
        and status.get("message") == WORKER_RESTART_ORPHAN_MESSAGE
    ):
        return "release_worker_restart_orphan"
    return "ingest"


def collect_preflight(
    *,
    project: str,
    token: str,
    phase: str,
    timeout: float,
    system: CommandSystem,
) -> dict[str, Any]:
    token = _canonical_token(token)
    containers = _containers(system, project, timeout)
    if phase == "authoritative" and (
        "sweeper" in containers.running_services
        or "media-repair" in containers.running_services
    ):
        raise PreflightError("production writers are still running")
    runtime = _capability_identity(system, containers, timeout)
    openfoam = _openfoam_processes(system, containers, timeout)
    worker_names = _worker_node_names(system, containers, timeout)
    queue_idle, task_ids, queue = _queue_snapshot(
        system, containers, worker_names, timeout
    )
    jobs, _admission = _database_snapshot(system, containers, token, timeout)
    statuses = _status_snapshot(system, containers, jobs, timeout)
    terminal_candidates: list[dict[str, Any]] = []
    blockers: list[dict[str, str]] = []
    for job in jobs:
        engine_job_id = job.get("engine_job_id")
        evidence = statuses.get(engine_job_id) if isinstance(engine_job_id, str) else None
        if _terminal_candidate(job, evidence) and engine_job_id not in task_ids:
            terminal_candidates.append(
                {
                    "jobId": str(job["id"]),
                    "engineJobId": engine_job_id,
                    "databaseStatus": str(job["status"]),
                    "engineStatus": str(evidence["status"]["state"]),
                    "engineMessage": (
                        evidence["status"].get("message")
                        if isinstance(evidence["status"].get("message"), str)
                        else None
                    ),
                    "settlementAction": _settlement_action(evidence),
                    "statusSha256": str(evidence["status_sha256"]),
                    "resultSha256": str(evidence["result_sha256"]),
                }
            )
        else:
            blockers.append(
                {"databaseStatus": str(job.get("status")), "engineState": str(job.get("engine_state"))}
            )
    idle = not openfoam and queue_idle and not blockers
    return {
        "schemaVersion": 1,
        "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "phase": phase,
        "idle": idle,
        "runtime": runtime,
        "openFoamProcessCount": len(openfoam),
        "queue": queue,
        "blockingJobCount": len(blockers),
        "blockingJobs": blockers,
        "terminalCandidateCount": len(terminal_candidates),
        "terminalCandidates": terminal_candidates,
    }


def _receipt_value(
    *, token: str, result: dict[str, Any]
) -> dict[str, Any]:
    if result.get("phase") != "authoritative" or result.get("idle") is not True:
        raise PreflightError("only an authoritative idle proof may create a receipt")
    runtime = result.get("runtime")
    if not _is_exact_affected_runtime(runtime):
        raise PreflightError("authoritative receipt runtime is not the exact affected gateway")
    candidates = result.get("terminalCandidates")
    if not isinstance(candidates, list) or len(candidates) > MAX_RECOVERY_JOBS:
        raise PreflightError("terminal candidate receipt set is invalid")
    receipt_candidates: list[dict[str, Any]] = []
    for candidate in candidates:
        expected_keys = {
            "jobId",
            "engineJobId",
            "databaseStatus",
            "engineStatus",
            "engineMessage",
            "settlementAction",
            "statusSha256",
            "resultSha256",
        }
        if not isinstance(candidate, dict) or set(candidate) != expected_keys:
            raise PreflightError("terminal candidate receipt row is invalid")
        normalized: dict[str, Any] = {}
        raw_job_id = candidate.get("jobId")
        try:
            canonical_job_id = str(uuid.UUID(raw_job_id))
        except (ValueError, TypeError, AttributeError) as error:
            raise PreflightError("terminal candidate jobId is not a UUID") from error
        if raw_job_id != canonical_job_id:
            raise PreflightError("terminal candidate jobId is not canonical")
        normalized["jobId"] = canonical_job_id

        # The engine creates jobs with ``uuid.uuid4().hex``.  This is not the
        # database row UUID: keep the exact filesystem/Celery identity rather
        # than normalising it into a hyphenated UUID in a maintenance receipt.
        raw_engine_job_id = candidate.get("engineJobId")
        if (
            not isinstance(raw_engine_job_id, str)
            or CANONICAL_ENGINE_JOB_ID_RE.fullmatch(raw_engine_job_id) is None
        ):
            raise PreflightError("terminal candidate engineJobId is not canonical")
        normalized["engineJobId"] = raw_engine_job_id
        if candidate["databaseStatus"] not in {"running", "ingesting"}:
            raise PreflightError("terminal candidate database status is invalid")
        if candidate["engineStatus"] not in TERMINAL_PHASES:
            raise PreflightError("terminal candidate engine status is invalid")
        normalized["databaseStatus"] = candidate["databaseStatus"]
        normalized["engineStatus"] = candidate["engineStatus"]
        engine_message = candidate["engineMessage"]
        if engine_message is not None and (
            not isinstance(engine_message, str)
            or len(engine_message.encode("utf-8"))
            > MAX_RECEIPT_ENGINE_MESSAGE_BYTES
        ):
            raise PreflightError("terminal candidate engine message is invalid")
        normalized["engineMessage"] = engine_message
        settlement_action = candidate["settlementAction"]
        if settlement_action not in SETTLEMENT_ACTIONS:
            raise PreflightError("terminal candidate settlement action is invalid")
        if (
            (settlement_action == "release_cancelled" and candidate["engineStatus"] != "cancelled")
            or (
                settlement_action == "release_worker_restart_orphan"
                and (
                    candidate["engineStatus"] != "failed"
                    or engine_message != WORKER_RESTART_ORPHAN_MESSAGE
                )
            )
            or (
                settlement_action == "ingest"
                and (
                    candidate["engineStatus"] not in {"completed", "failed"}
                    or engine_message == WORKER_RESTART_ORPHAN_MESSAGE
                )
            )
        ):
            raise PreflightError(
                "terminal candidate settlement action disagrees with engine status"
            )
        normalized["settlementAction"] = settlement_action
        for key in ("statusSha256", "resultSha256"):
            value = candidate[key]
            if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
                raise PreflightError("terminal candidate evidence digest is invalid")
            normalized[key] = value
        receipt_candidates.append(normalized)
    job_ids = [candidate["jobId"] for candidate in receipt_candidates]
    engine_job_ids = [candidate["engineJobId"] for candidate in receipt_candidates]
    if len(set(job_ids)) != len(job_ids) or len(set(engine_job_ids)) != len(engine_job_ids):
        raise PreflightError("terminal candidate receipt identities are duplicated")
    receipt_candidates.sort(key=lambda value: value["jobId"])
    return {
        "schemaVersion": 1,
        "maintenanceToken": token,
        "affectedRuntime": runtime,
        "authoritativeObservedAt": result["observedAt"],
        "candidates": receipt_candidates,
        "candidateDigest": _candidate_digest(receipt_candidates),
    }


def _write_receipt(path: Path, value: dict[str, Any]) -> None:
    path = path.absolute()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        current = path.lstat()
    except FileNotFoundError:
        current = None
    if current is not None and (
        not stat.S_ISREG(current.st_mode) or path.is_symlink()
    ):
        raise PreflightError("production maintenance receipt target is unsafe")
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = -1
    try:
        descriptor = os.open(temporary, flags, 0o600)
        payload = (
            json.dumps(
                value,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=False,
            )
            + "\n"
        ).encode("utf-8")
        os.write(descriptor, payload)
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.replace(temporary, path)
        os.chmod(path, 0o600, follow_symlinks=False)
        parent_descriptor = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(parent_descriptor)
        finally:
            os.close(parent_descriptor)
    except OSError as error:
        raise PreflightError(f"could not persist maintenance receipt: {error}") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def _read_receipt(path: Path, token: str) -> dict[str, Any]:
    try:
        metadata = path.stat(follow_symlinks=False)
        if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
            raise PreflightError("production maintenance receipt is unsafe")
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            raise PreflightError("production maintenance receipt mode is not 0600")
        value = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError) as error:
        raise PreflightError(f"production maintenance receipt is unreadable: {error}") from error
    expected = {
        "schemaVersion",
        "maintenanceToken",
        "affectedRuntime",
        "authoritativeObservedAt",
        "candidates",
        "candidateDigest",
    }
    if (
        not isinstance(value, dict)
        or set(value) != expected
        or value["schemaVersion"] != 1
        or value["maintenanceToken"] != token
        or not _is_exact_affected_runtime(value["affectedRuntime"])
        or not isinstance(value["authoritativeObservedAt"], str)
        or not isinstance(value["candidates"], list)
        or len(value["candidates"]) > MAX_RECOVERY_JOBS
        or not isinstance(value["candidateDigest"], str)
    ):
        raise PreflightError("production maintenance receipt is invalid")
    # Reuse the authoritative validator so a private receipt cannot silently
    # widen its scope or lose the evidence binding after it is written.
    normalized = _receipt_value(
        token=token,
        result={
            "phase": "authoritative",
            "idle": True,
            "runtime": value["affectedRuntime"],
            "observedAt": value["authoritativeObservedAt"],
            "terminalCandidates": value["candidates"],
        },
    )
    if normalized != value:
        raise PreflightError("production maintenance receipt is not canonical")
    return value


def _receipt_database_rows(
    system: CommandSystem,
    containers: Containers,
    receipt: dict[str, Any],
    timeout: float,
) -> list[dict[str, Any]]:
    ids = [candidate["jobId"] for candidate in receipt["candidates"]]
    if not ids:
        return []
    id_literals = ",".join(f"'{job_id}'::uuid" for job_id in ids)
    query = f'''/* AIRFOILS_PRO_PRODUCTION_MAINTENANCE_RECEIPT_DATABASE_PROBE */
SELECT COALESCE(json_agg(json_build_object(
  'id', job.id,
  'status', job.status,
  'engine_state', job.engine_state,
  'engine_job_id', job.engine_job_id,
  'ingested_at', job."ingestedAt",
  'ingest_lease_live', (
    job.status = 'ingesting'
    AND (
      job.ingest_lease_expires_at > now()
      OR (
        job.ingest_lease_expires_at IS NULL
        AND job."updatedAt" > now() - (600000 * interval '1 millisecond')
      )
    )
  )
) ORDER BY job.id), '[]'::json)::text
FROM sim_jobs AS job
WHERE job.id = ANY(ARRAY[{id_literals}]::uuid[]);'''
    value = _json_output(
        system.capture(
            [
                "docker", "exec", containers.postgres, "psql",
                "-U", "aerodb", "-d", "aerodb", "-X", "-A", "-t",
                "-v", "ON_ERROR_STOP=1", "-c", query,
            ],
            timeout,
        ),
        "production maintenance receipt database probe",
    )
    expected_keys = {
        "id", "status", "engine_state", "engine_job_id", "ingested_at",
        "ingest_lease_live"
    }
    if (
        not isinstance(value, list)
        or len(value) != len(ids)
        or any(not isinstance(row, dict) or set(row) != expected_keys for row in value)
        or {row["id"] for row in value} != set(ids)
    ):
        raise PreflightError("production maintenance receipt rows are incomplete")
    return value


def collect_reconciliation(
    *,
    project: str,
    token: str,
    receipt_file: Path,
    timeout: float,
    system: CommandSystem,
) -> dict[str, Any]:
    token = _canonical_token(token)
    receipt = _read_receipt(receipt_file, token)
    containers = _containers(system, project, timeout)
    if (
        "sweeper" in containers.running_services
        or "media-repair" in containers.running_services
    ):
        raise PreflightError("production writers restarted during reconciliation")
    jobs, _admission = _database_snapshot(system, containers, token, timeout)
    receipt_rows = _receipt_database_rows(system, containers, receipt, timeout)
    receipt_ids = {candidate["jobId"] for candidate in receipt["candidates"]}
    candidate_by_id = {
        candidate["jobId"]: candidate for candidate in receipt["candidates"]
    }
    remaining = [job for job in jobs if job.get("id") in receipt_ids]
    unexpected = [job for job in jobs if job.get("id") not in receipt_ids]
    terminal_count = 0
    remaining_engine_ids: set[str] = set()
    for row in receipt_rows:
        candidate = candidate_by_id[row["id"]]
        if row["engine_job_id"] != candidate["engineJobId"]:
            raise PreflightError("production maintenance receipt engine identity drifted")
        if row["status"] in {"done", "failed", "cancelled"}:
            if candidate["settlementAction"] == "ingest":
                expected_terminal = {
                    "completed": ("done", "completed"),
                    "failed": ("failed", "failed"),
                }[candidate["engineStatus"]]
            else:
                expected_terminal = ("cancelled", "cancelled")
            if (row["status"], row["engine_state"]) != expected_terminal:
                raise PreflightError("production maintenance terminal settlement is inconsistent")
            if (
                candidate["settlementAction"] == "ingest"
                and not isinstance(row["ingested_at"], str)
            ):
                raise PreflightError(
                    "production maintenance ingest settlement lacks a durable ingest receipt"
                )
            if row["ingest_lease_live"] is not False:
                raise PreflightError("production maintenance terminal row retains a live ingest lease")
            terminal_count += 1
            continue
        if (
            row["status"] != candidate["databaseStatus"]
            or row["status"] not in {"running", "ingesting"}
            or row["ingest_lease_live"] is not False
        ):
            raise PreflightError("production maintenance receipt row drifted before settlement")
        remaining_engine_ids.add(candidate["engineJobId"])
    if remaining_engine_ids:
        statuses = _status_snapshot(system, containers, receipt_rows, timeout)
        for candidate in receipt["candidates"]:
            if candidate["engineJobId"] not in remaining_engine_ids:
                continue
            evidence = statuses.get(candidate["engineJobId"])
            if not isinstance(evidence, dict):
                raise PreflightError("production maintenance receipt evidence disappeared")
            status = evidence.get("status")
            if (
                evidence.get("read_error") is not None
                or evidence.get("status_sha256") != candidate["statusSha256"]
                or evidence.get("result_sha256") != candidate["resultSha256"]
                or not isinstance(status, dict)
                or status.get("job_id") != candidate["engineJobId"]
                or status.get("state") != candidate["engineStatus"]
                or status.get("message") != candidate["engineMessage"]
                or (
                    candidate["settlementAction"]
                    == "release_worker_restart_orphan"
                    and (
                        status.get("message") != WORKER_RESTART_ORPHAN_MESSAGE
                        or candidate["engineMessage"]
                        != WORKER_RESTART_ORPHAN_MESSAGE
                    )
                )
            ):
                raise PreflightError("production maintenance receipt evidence drifted")
    return {
        "schemaVersion": 1,
        "observedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "phase": "reconcile",
        "readyForReconcile": not unexpected,
        "reconciled": terminal_count == len(receipt_rows) and not unexpected,
        "candidateCount": len(receipt_rows),
        "terminalCount": terminal_count,
        "remainingCount": len(remaining),
        "remainingStatuses": sorted(str(job.get("status")) for job in remaining),
        "unexpectedActiveCount": len(unexpected),
        "unexpectedActiveStatuses": sorted(
            str(job.get("status")) for job in unexpected
        ),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", default="app")
    parser.add_argument("--maintenance-token", required=True)
    parser.add_argument(
        "--phase", choices=("observe", "authoritative", "reconcile"), required=True
    )
    parser.add_argument("--receipt-file", type=Path)
    parser.add_argument("--timeout-seconds", type=float, default=20.0)
    args = parser.parse_args(argv)
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", args.project):
        parser.error("project name is invalid")
    if not 1 <= args.timeout_seconds <= 60:
        parser.error("timeout must be between 1 and 60 seconds")
    if (args.phase in {"authoritative", "reconcile"}) != bool(args.receipt_file):
        parser.error("authoritative and reconcile phases require --receipt-file")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.phase == "reconcile":
            value = collect_reconciliation(
                project=args.project,
                token=args.maintenance_token,
                receipt_file=args.receipt_file,
                timeout=args.timeout_seconds,
                system=RealCommandSystem(),
            )
        else:
            value = collect_preflight(
                project=args.project,
                token=args.maintenance_token,
                phase=args.phase,
                timeout=args.timeout_seconds,
                system=RealCommandSystem(),
            )
            if args.receipt_file is not None and value["idle"] is True:
                receipt = _receipt_value(
                    token=_canonical_token(args.maintenance_token), result=value
                )
                _write_receipt(args.receipt_file, receipt)
    except (OSError, subprocess.SubprocessError, PreflightError, ValueError) as error:
        print(f"production maintenance preflight refused: {error}", file=sys.stderr)
        return 12
    print(json.dumps(value, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
