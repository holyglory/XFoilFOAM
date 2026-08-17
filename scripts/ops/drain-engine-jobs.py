#!/usr/bin/env python3
"""Cancel every nonterminal engine job and prove the OpenFOAM engine is idle."""

from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any


TERMINAL_STATES = {"completed", "failed", "cancelled"}
REQUEST_TIMEOUT_SECONDS = 120.0


def request_json(base_url: str, method: str, path: str, payload: Any = None) -> Any:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}{path}",
        data=body,
        method=method,
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")
        raise RuntimeError(f"{method} {path} returned {exc.code}: {detail}") from exc


def runtime_rows(base_url: str, job_ids: list[str]) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for start in range(0, len(job_ids), 64):
        payload = request_json(
            base_url,
            "POST",
            "/jobs/runtime",
            {"job_ids": job_ids[start : start + 64], "inspect_result": False},
        )
        rows.extend(payload.get("jobs") or [])
    return rows


def is_nonterminal(row: dict[str, Any]) -> bool:
    state = row.get("status_state")
    return bool(row.get("process_count")) or (state is not None and state not in TERMINAL_STATES)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8000")
    parser.add_argument("--timeout-seconds", type=float, default=240.0)
    parser.add_argument("--request-timeout-seconds", type=float, default=120.0)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--inventory-only", action="store_true")
    parser.add_argument("--job-id", action="append", default=[])
    return parser.parse_args()


def main() -> int:
    global REQUEST_TIMEOUT_SECONDS
    args = parse_args()
    REQUEST_TIMEOUT_SECONDS = args.request_timeout_seconds
    requested_ids = sorted(set(args.job_id))
    if requested_ids:
        job_ids = requested_ids
    else:
        items = request_json(args.base_url, "GET", "/maintenance/jobs").get("items") or []
        job_ids = sorted(
            item["job_id"]
            for item in items
            if isinstance(item, dict) and isinstance(item.get("job_id"), str)
        )
    initial = runtime_rows(args.base_url, job_ids)
    discovered_ids = sorted(row["job_id"] for row in initial if is_nonterminal(row))
    if args.inventory_only:
        print(
            json.dumps(
                {
                    "job_directories": len(job_ids),
                    "nonterminal_job_ids": discovered_ids,
                },
                sort_keys=True,
            )
        )
        return 0
    if not requested_ids:
        raise ValueError("at least one exact --job-id is required unless --inventory-only is used")
    cancel_ids = sorted(set(requested_ids) & set(discovered_ids))
    errors: list[str] = []
    if cancel_ids:
        with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 16))) as executor:
            futures = {
                executor.submit(
                    request_json,
                    args.base_url,
                    "POST",
                    f"/jobs/{job_id}/cancel",
                ): job_id
                for job_id in cancel_ids
            }
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as exc:  # noqa: BLE001
                    errors.append(f"{futures[future]}: {type(exc).__name__}: {exc}")

    deadline = time.monotonic() + args.timeout_seconds
    remaining: list[dict[str, Any]] = []
    while True:
        remaining = [
            row
            for row in runtime_rows(args.base_url, requested_ids)
            if is_nonterminal(row)
        ]
        if not remaining or time.monotonic() >= deadline:
            break
        time.sleep(2)

    result = {
        "job_directories": len(job_ids),
        "requested_job_ids": requested_ids,
        "discovered_nonterminal": discovered_ids,
        "cancel_requested": len(cancel_ids),
        "cancel_errors": errors,
        "remaining_nonterminal": [
            {
                "job_id": row.get("job_id"),
                "state": row.get("status_state"),
                "process_count": row.get("process_count"),
            }
            for row in remaining
        ],
        "idle": not remaining,
    }
    print(json.dumps(result, sort_keys=True))
    return 0 if not errors and not remaining else 1


if __name__ == "__main__":
    raise SystemExit(main())
