#!/usr/bin/env python3
"""Build a truthful, read-only remote-solver capacity report.

The shell entrypoint performs the only host/compose reads.  This reducer is
kept separate so its interpretation contract can be tested without Docker,
Postgres, a running engine, or a systemd timer.
"""

from __future__ import annotations

import argparse
from collections import Counter
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _timestamp_age_seconds(value: object, now: datetime) -> float | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return None
    return max(0.0, (now - parsed.astimezone(timezone.utc)).total_seconds())


def _nonnegative_int(
    value: object, *, field: str, issues: list[dict[str, str]]
) -> int | None:
    if type(value) is int and value >= 0:
        return value
    issues.append({"severity": "critical", "code": f"invalid_{field}"})
    return None


def _queue_completeness(snapshot: object, now: datetime) -> tuple[bool, list[str]]:
    if not isinstance(snapshot, dict):
        return False, ["queue_payload_invalid"]
    reasons: list[str] = []
    if snapshot.get("queue_observation_state") != "fresh":
        reasons.append("queue_observation_not_fresh")
    if snapshot.get("queue_refresh_in_progress") is not False:
        reasons.append("queue_refresh_in_progress")
    if snapshot.get("queue_observation_error") is not None:
        reasons.append("queue_observation_error")
    observed_age = _timestamp_age_seconds(snapshot.get("queue_observed_at"), now)
    if observed_age is None or observed_age > 120:
        reasons.append("queue_observation_stale")
    for key in ("worker_queues_error", "worker_runtime_error"):
        if snapshot.get(key) is not None:
            reasons.append(key)
    inspection_errors = snapshot.get("inspection_errors")
    if not isinstance(inspection_errors, dict) or inspection_errors:
        reasons.append("inspection_errors")

    worker_names: set[str] = set()
    worker_queues = snapshot.get("worker_queues")
    if not isinstance(worker_queues, list) or not worker_queues:
        reasons.append("worker_queues_missing")
    else:
        for binding in worker_queues:
            if not isinstance(binding, dict):
                reasons.append("worker_queue_binding_invalid")
                continue
            worker = binding.get("worker")
            queues = binding.get("queues")
            if (
                not isinstance(worker, str)
                or not worker
                or not isinstance(queues, list)
                or not queues
                or any(not isinstance(queue, str) or not queue for queue in queues)
            ):
                reasons.append("worker_queue_binding_invalid")
                continue
            if worker in worker_names:
                reasons.append("worker_queue_binding_duplicate")
            worker_names.add(worker)

    inspection_workers = snapshot.get("inspection_workers")
    if not isinstance(inspection_workers, dict):
        reasons.append("inspection_worker_coverage_missing")
    else:
        for kind in ("active", "reserved", "scheduled"):
            observed = inspection_workers.get(kind)
            if (
                not isinstance(observed, list)
                or any(not isinstance(worker, str) or not worker for worker in observed)
                or set(observed) != worker_names
            ):
                reasons.append(f"inspection_{kind}_coverage_incomplete")

    for key in ("queue_depth", "active_count", "reserved_count", "scheduled_count"):
        if type(snapshot.get(key)) is not int or snapshot[key] < 0:
            reasons.append(f"invalid_{key}")
    task_job_ids: list[str] = []
    for kind, count_key in (
        ("active", "active_count"),
        ("reserved", "reserved_count"),
        ("scheduled", "scheduled_count"),
    ):
        tasks = snapshot.get(kind)
        if not isinstance(tasks, list):
            reasons.append(f"{kind}_tasks_missing")
            continue
        if type(snapshot.get(count_key)) is int and len(tasks) != snapshot[count_key]:
            reasons.append(f"{kind}_count_mismatch")
        for task in tasks:
            if not isinstance(task, dict):
                reasons.append(f"{kind}_task_invalid")
                continue
            job_id = task.get("job_id")
            if job_id is not None:
                if not isinstance(job_id, str) or not job_id:
                    reasons.append(f"{kind}_task_invalid")
                else:
                    task_job_ids.append(job_id)
    job_ids = snapshot.get("job_ids")
    if (
        not isinstance(job_ids, list)
        or any(not isinstance(job_id, str) or not job_id for job_id in job_ids)
        or set(job_ids) != set(task_job_ids)
        or len(job_ids) != len(set(job_ids))
    ):
        reasons.append("job_id_coverage_incomplete")
    duplicates = snapshot.get("duplicates")
    expected_duplicates = {
        job_id: count for job_id, count in Counter(task_job_ids).items() if count > 1
    }
    if (
        not isinstance(duplicates, dict)
        or duplicates != expected_duplicates
        or any(not isinstance(job_id, str) or type(count) is not int or count < 2 for job_id, count in duplicates.items())
    ):
        reasons.append("duplicate_task_accounting_incomplete")
    depths = snapshot.get("queue_depths")
    enabled = snapshot.get("queue_enabled")
    if not isinstance(depths, dict) or not depths:
        reasons.append("queue_depths_missing")
    elif any(type(value) is not int or value < 0 for value in depths.values()):
        reasons.append("queue_depths_invalid")
    elif type(snapshot.get("queue_depth")) is int and sum(depths.values()) != snapshot["queue_depth"]:
        reasons.append("queue_depth_total_mismatch")
    if not isinstance(enabled, dict) or not isinstance(depths, dict) or set(enabled) != set(depths):
        reasons.append("queue_enabled_coverage_incomplete")
    elif any(type(value) is not bool for value in enabled.values()):
        reasons.append("queue_enabled_invalid")
    return not reasons, sorted(set(reasons))


def build_report(
    *,
    database: object,
    engine_queue: object,
    engine_runtime: object,
    host_openfoam_solver_processes: int,
    now: datetime | None = None,
) -> tuple[dict[str, Any], int]:
    """Return the report and systemd-compatible status (0/1/2)."""
    now = now or datetime.now(timezone.utc)
    issues: list[dict[str, str]] = []
    if not isinstance(database, dict):
        database = {}
        issues.append({"severity": "critical", "code": "database_payload_invalid"})
    if type(host_openfoam_solver_processes) is not int or host_openfoam_solver_processes < 0:
        issues.append({"severity": "critical", "code": "invalid_host_openfoam_solver_processes"})
        host_openfoam_solver_processes = 0

    enabled = database.get("enabled") is True
    transfer_paused = database.get("transferPaused") is True
    disk_blocked = database.get("diskAdmissionBlocked") is True
    cpu_cap = _nonnegative_int(database.get("cpuCap"), field="cpu_cap", issues=issues)
    live_jobs = _nonnegative_int(database.get("liveRemoteJobs"), field="live_remote_jobs", issues=issues)
    reserved_slots = _nonnegative_int(database.get("reservedCpuSlots"), field="reserved_cpu_slots", issues=issues)
    active_promises = _nonnegative_int(database.get("activePromises"), field="active_promises", issues=issues)
    free_bytes = _nonnegative_int(database.get("diskFreeBytes"), field="disk_free_bytes", issues=issues)
    required_free_bytes = _nonnegative_int(database.get("diskRequiredFreeBytes"), field="disk_required_free_bytes", issues=issues)
    heartbeat_age = _timestamp_age_seconds(database.get("sweeperHeartbeatAt"), now)

    if not enabled:
        issues.append({"severity": "critical", "code": "remote_solver_disabled"})
    if transfer_paused:
        issues.append({"severity": "critical", "code": "remote_transfer_paused"})
    if heartbeat_age is None or heartbeat_age > 600:
        issues.append({"severity": "critical", "code": "sweeper_heartbeat_stale"})
    if disk_blocked:
        issues.append({"severity": "critical", "code": "storage_admission_blocked"})
    if free_bytes is not None and required_free_bytes is not None and free_bytes < required_free_bytes:
        issues.append({"severity": "critical", "code": "disk_free_below_required"})

    queue_complete, queue_reasons = _queue_completeness(engine_queue, now)
    if not queue_complete:
        for reason in queue_reasons:
            issues.append({"severity": "critical", "code": f"engine_queue_{reason}"})

    requested_engine_ids = database.get("engineJobIds")
    if not isinstance(requested_engine_ids, list) or any(
        not isinstance(job_id, str) or not job_id for job_id in requested_engine_ids
    ):
        requested_engine_ids = []
        issues.append({"severity": "critical", "code": "invalid_engine_job_ids"})

    runtime_items = engine_runtime.get("items") if isinstance(engine_runtime, dict) else None
    if not isinstance(runtime_items, list):
        runtime_items = []
        issues.append({"severity": "critical", "code": "engine_runtime_items_missing"})
    runtime_by_id: dict[str, dict[str, Any]] = {}
    for item in runtime_items:
        if not isinstance(item, dict) or not isinstance(item.get("job_id"), str):
            issues.append({"severity": "critical", "code": "engine_runtime_item_invalid"})
            continue
        runtime_by_id[item["job_id"]] = item
    missing_runtime_ids = sorted(set(requested_engine_ids) - set(runtime_by_id))
    if missing_runtime_ids:
        issues.append({"severity": "critical", "code": "engine_runtime_coverage_incomplete"})

    runtime_cpu_tokens_held: int | None = 0
    runtime_process_count = 0
    runtime_total_cases = 0
    runtime_completed_cases = 0
    runtime_progress_complete = True
    runtime_tokens_complete = True
    for item in runtime_by_id.values():
        process_count = item.get("process_count")
        running = item.get("status_state") == "running" or (
            type(process_count) is int and process_count > 0
        )
        if type(process_count) is int and process_count >= 0:
            runtime_process_count += process_count
        elif running:
            runtime_progress_complete = False
        tokens_held = item.get("runtime_cpu_tokens_held")
        if type(tokens_held) is int and tokens_held >= 0:
            if runtime_cpu_tokens_held is not None:
                runtime_cpu_tokens_held += tokens_held
        elif running:
            runtime_cpu_tokens_held = None
            runtime_tokens_complete = False
        total_cases = item.get("status_total_cases")
        completed_cases = item.get("status_completed_cases")
        if (
            type(total_cases) is int
            and total_cases >= 0
            and type(completed_cases) is int
            and 0 <= completed_cases <= total_cases
        ):
            runtime_total_cases += total_cases
            runtime_completed_cases += completed_cases
        elif running:
            runtime_progress_complete = False
    if requested_engine_ids and not runtime_progress_complete:
        issues.append({"severity": "critical", "code": "engine_runtime_progress_incomplete"})
    if requested_engine_ids and not runtime_tokens_complete:
        issues.append({"severity": "critical", "code": "engine_runtime_cpu_tokens_incomplete"})

    job_progress = database.get("liveJobProgress")
    if not isinstance(job_progress, dict):
        job_progress = {}
        issues.append({"severity": "critical", "code": "database_job_progress_missing"})
    else:
        for key in ("jobs", "totalCases", "completedCases", "awaitingEngineId"):
            _nonnegative_int(job_progress.get(key), field=f"job_progress_{key}", issues=issues)

    queue_depth = engine_queue.get("queue_depth") if isinstance(engine_queue, dict) else None
    has_runnable_demand = bool(
        (active_promises or 0) > 0
        or (live_jobs or 0) > 0
        or (type(queue_depth) is int and queue_depth > 0)
    )
    capacity_should_be_full = (
        enabled
        and not transfer_paused
        and not disk_blocked
        and queue_complete
        and cpu_cap is not None
        and cpu_cap > 0
        and has_runnable_demand
    )
    if capacity_should_be_full and reserved_slots is not None:
        if reserved_slots < cpu_cap:
            issues.append({"severity": "warning", "code": "capacity_underfilled"})
        if (
            runtime_tokens_complete
            and not missing_runtime_ids
            and runtime_cpu_tokens_held is not None
            and runtime_cpu_tokens_held < reserved_slots
        ):
            issues.append(
                {"severity": "warning", "code": "runtime_cpu_tokens_underfilled"}
            )
        if (
            runtime_progress_complete
            and not missing_runtime_ids
            and host_openfoam_solver_processes < runtime_process_count
        ):
            issues.append(
                {
                    "severity": "warning",
                    "code": "host_openfoam_process_coverage_underfilled",
                }
            )

    status = "critical" if any(item["severity"] == "critical" for item in issues) else "warning" if issues else "ok"
    exit_code = 2 if status == "critical" else 1 if status == "warning" else 0
    queue_mapping = engine_queue if isinstance(engine_queue, dict) else {}
    report: dict[str, Any] = {
        "schemaVersion": 2,
        "checkedAt": now.isoformat().replace("+00:00", "Z"),
        "status": status,
        "issues": issues,
        "capacity": {
            "configuredCpuSlots": cpu_cap,
            "reservedCpuSlots": reserved_slots,
            "runtimeCpuTokensHeld": runtime_cpu_tokens_held,
            "hostOpenfoamSolverProcesses": host_openfoam_solver_processes,
            "reservationUtilizationPct": round(100 * reserved_slots / cpu_cap, 1) if cpu_cap and reserved_slots is not None else None,
            "runtimeTokenUtilizationPct": round(100 * runtime_cpu_tokens_held / cpu_cap, 1) if cpu_cap and runtime_cpu_tokens_held is not None else None,
            "activePromises": active_promises,
        },
        "jobs": {
            "database": job_progress,
            "engineRuntime": {
                "requestedJobs": len(requested_engine_ids),
                "reportedJobs": len(runtime_by_id),
                "missingJobs": len(missing_runtime_ids),
                "processCount": runtime_process_count,
                "totalCases": runtime_total_cases,
                "completedCases": runtime_completed_cases,
                "progressComplete": runtime_progress_complete and not missing_runtime_ids,
            },
        },
        "diskAdmission": {
            "blocked": disk_blocked,
            "reason": database.get("diskAdmissionReason"),
            "usedPct": database.get("diskUsedPct"),
            "freeBytes": free_bytes,
            "requiredFreeBytes": required_free_bytes,
        },
        "engine": {
            "queueComplete": queue_complete,
            "queueCompletenessReasons": queue_reasons,
            "queueDepth": queue_mapping.get("queue_depth"),
            "activeCount": queue_mapping.get("active_count"),
            "reservedCount": queue_mapping.get("reserved_count"),
            "scheduledCount": queue_mapping.get("scheduled_count"),
            "queueObservedAt": queue_mapping.get("queue_observed_at"),
        },
        "database": database,
    }
    return report, exit_code


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--engine-queue", required=True)
    parser.add_argument("--engine-runtime", required=True)
    parser.add_argument("--host-openfoam-solver-processes", required=True, type=int)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        report, exit_code = build_report(
            database=json.loads(args.database),
            engine_queue=json.loads(args.engine_queue),
            engine_runtime=json.loads(args.engine_runtime),
            host_openfoam_solver_processes=args.host_openfoam_solver_processes,
        )
    except (TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"remote capacity monitor input error: {exc}", file=os.sys.stderr)
        return 2
    args.output.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.chmod(args.output, 0o600)
    print(json.dumps(report, separators=(",", ":"), sort_keys=True))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
