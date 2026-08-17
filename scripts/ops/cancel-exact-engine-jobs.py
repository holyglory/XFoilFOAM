#!/usr/bin/env python3
"""Invoke the engine's exact cancellation implementation without its HTTP pool."""

from __future__ import annotations

import argparse
import json
import re
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any


JOB_ID_RE = re.compile(r"^[0-9a-f]{32}$")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job-id", action="append", required=True)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout-seconds", type=float, default=240.0)
    return parser.parse_args()


def validate_job_ids(values: list[str]) -> list[str]:
    ids = sorted(set(values))
    if len(ids) != len(values):
        raise ValueError("duplicate --job-id")
    if any(not JOB_ID_RE.fullmatch(value) for value in ids):
        raise ValueError("every --job-id must be exactly 32 lowercase hexadecimal characters")
    return ids


def main() -> int:
    args = parse_args()
    job_ids = validate_job_ids(args.job_id)

    from airfoilfoam.celery_app import celery_app
    from airfoilfoam.config import Settings
    from airfoilfoam.models import JobPhase, JobState, JobStatus
    from airfoilfoam.openfoam.dialects import (
        OPENCFD_2606_IDENTITY,
        UnsupportedEngineIdentity,
        get_openfoam_dialect,
    )
    from airfoilfoam.storage import JobStore
    from airfoilfoam.tasks import kill_job_processes

    store = JobStore(Settings())
    missing = [job_id for job_id in job_ids if not store.exists(job_id)]
    if missing:
        raise ValueError(f"exact engine jobs do not exist: {missing}")

    def cancel(job_id: str) -> dict[str, Any]:
        status_before = store.read_status(job_id)
        request_before = store.read_request(job_id)
        requested_engine = (
            status_before.requested_engine
            if status_before is not None and status_before.requested_engine is not None
            else request_before.expected_engine
            if request_before is not None and request_before.expected_engine is not None
            else OPENCFD_2606_IDENTITY
        )
        try:
            queue = get_openfoam_dialect(requested_engine).queue_name
        except UnsupportedEngineIdentity as exc:
            raise RuntimeError(f"exact job engine route is unsupported: {exc}") from exc
        store.mark_cancelled(job_id)
        reapers: list[Any] = []
        for _ in range(2):
            result = kill_job_processes.apply_async(args=[job_id], queue=queue)
            reapers.append(result.get(timeout=10, propagate=False))
        celery_app.control.revoke(job_id, terminate=True, signal="SIGTERM")
        result = kill_job_processes.apply_async(args=[job_id], queue=queue)
        reapers.append(result.get(timeout=10, propagate=False))
        status = store.read_status(job_id) or JobStatus(job_id=job_id, state=JobState.cancelled)
        status.state = JobState.cancelled
        status.phase = JobPhase.cancelled
        status.message = "cancelled"
        store.write_status(status)
        store.terminalize_cancelled_result(job_id)
        return {"job_id": job_id, "reapers": reapers}

    completed: list[dict[str, Any]] = []
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as executor:
        futures = {executor.submit(cancel, job_id): job_id for job_id in job_ids}
        for future in as_completed(futures):
            try:
                completed.append(future.result())
            except Exception as exc:  # noqa: BLE001
                errors.append(f"{futures[future]}: {type(exc).__name__}: {exc}")

    deadline = time.monotonic() + args.timeout_seconds
    remaining: dict[str, int] = {}
    while True:
        remaining = {
            job_id: len(store.job_process_details(job_id))
            for job_id in job_ids
            if store.job_process_details(job_id)
        }
        if not remaining or time.monotonic() >= deadline:
            break
        time.sleep(2)

    print(
        json.dumps(
            {
                "requested_job_ids": job_ids,
                "cancelled": sorted(item["job_id"] for item in completed),
                "errors": errors,
                "remaining_processes": remaining,
                "idle": not remaining,
            },
            sort_keys=True,
        )
    )
    return 0 if not errors and not remaining else 1


if __name__ == "__main__":
    raise SystemExit(main())
