#!/usr/bin/env python3
"""Validate hz-solver2's durable OpenCFD 2606 cutover state.

The production hub has a different state machine whose terminal proof is a
GCS-backed campaign-successor attestation.  This validator intentionally owns
different marker names and volume receipt files so neither deployment role can
mistake the other's proof for authorization.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys


KEYS = (
    "REMOTE_SOLVER2606_CUTOVER_PENDING",
    "REMOTE_SOLVER2606_CUTOVER_COMPLETE",
    "REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING",
    "REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING",
    "REMOTE_SOLVER2606_CUTOVER_PHASE",
    "REMOTE_SOLVER2606_TARGET_BUILD_ID",
    "REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION",
    "REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256",
    "REMOTE_SOLVER2606_PREVIOUS_BUILD_ID",
    "REMOTE_SOLVER2606_BACKUP_MANIFEST_SHA256",
    "REMOTE_SOLVER2606_ROLLBACK_RECEIPT_SHA256",
    "REMOTE_SOLVER2606_CANARY_RECEIPT_SHA256",
    "REMOTE_SOLVER2606_ATTESTATION_SHA256",
)
HEX64 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")


def _values(path: Path) -> dict[str, str]:
    found: dict[str, str] = {}
    for line_number, line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key not in (*KEYS, "AIRFOILFOAM_DEPLOYMENT_ROLE"):
            continue
        if key in found:
            raise ValueError(f"deployment env line {line_number} duplicates {key}")
        if value != value.strip():
            raise ValueError(f"deployment env line {line_number} gives {key} whitespace")
        found[key] = value
    return found


def _safe_private_file(path: Path, label: str) -> bytes:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise ValueError(f"{label} must be a non-symlink regular file")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise ValueError(f"{label} must have exact mode 0600")
    if metadata.st_uid != os.geteuid():
        raise ValueError(f"{label} must be owned by the deploying user")
    return path.read_bytes()


def _volume_receipt(raw: bytes) -> dict[str, object]:
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("remote-solver canary receipt is invalid JSON") from exc
    storage = value.get("evidence_storage") if isinstance(value, dict) else None
    runtime = value.get("runtime") if isinstance(value, dict) else None
    jobs = value.get("jobs") if isinstance(value, dict) else None
    expected_scenarios = {
        "serial-rans",
        "mpi-2-rans",
        "forced-urans-precalc-no-shedding",
    }
    if (
        not isinstance(value, dict)
        or value.get("schema_version") != 1
        or value.get("status") != "ok"
        or value.get("attestation_profile") != "hz-solver2-volume-v1"
        or storage
        != {
            "backend": "volume",
            "bucket": None,
            "object_prefix": "solver-evidence/v1",
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "zstd_level": 10,
            "local_disposition": "volume",
        }
        or not isinstance(runtime, dict)
        or runtime.get("family") != "openfoam"
        or runtime.get("distribution") != "opencfd"
        or runtime.get("version") != "2606"
        or runtime.get("source_revision")
        != "481094fdf34f11ed6d0d603ee59a858a0124236d"
        or not isinstance(runtime.get("build_id"), str)
        or not runtime["build_id"]
        or not isinstance(jobs, list)
        or len(jobs) != 3
        or any(
            not isinstance(job, dict)
            or not isinstance(job.get("scenario"), str)
            or not isinstance(job.get("job_id"), str)
            or not job["job_id"]
            or not isinstance(job.get("volume_restore_proof"), dict)
            for job in jobs
        )
    ):
        raise ValueError("remote-solver canary receipt has an invalid volume profile")
    assert isinstance(jobs, list)
    if (
        {job["scenario"] for job in jobs} != expected_scenarios
        or len({job["job_id"] for job in jobs}) != 3
    ):
        raise ValueError("remote-solver canary receipt has duplicate jobs or scenarios")
    return value


def _require_hex(value: str, label: str, *, optional: bool = False) -> None:
    if optional and not value:
        return
    if not HEX64.fullmatch(value):
        raise ValueError(f"{label} must be a lowercase SHA-256")


def validate(
    env_file: Path,
    receipt_file: Path,
    attestation_file: Path,
    *,
    current_source_revision: str = "",
    current_source_tree_sha256: str = "",
    required_state: str = "any",
) -> str:
    values = _values(env_file)
    if values.get("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub") != "remote-solver":
        raise ValueError("remote-solver cutover state requires AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver")

    present = {key for key in KEYS if key in values}
    if not present:
        state = "pristine"
        if receipt_file.exists() or attestation_file.exists():
            raise ValueError("markerless remote-solver state has stale receipt/attestation files")
        if required_state == "pending":
            raise ValueError("remote-solver cutover is not pending")
        return state
    if present != set(KEYS):
        missing = sorted(set(KEYS) - present)
        raise ValueError(
            "remote-solver cutover marker tuple is partial; missing " + ", ".join(missing)
        )

    pending = values["REMOTE_SOLVER2606_CUTOVER_PENDING"]
    complete = values["REMOTE_SOLVER2606_CUTOVER_COMPLETE"]
    if pending not in {"0", "1"} or complete not in {"0", "1"}:
        raise ValueError("remote-solver pending/complete markers must be 0 or 1")
    if pending == "1" and complete != "0":
        raise ValueError("a pending remote-solver cutover cannot be complete")
    if pending == "0" and any(
        values[key]
        for key in (
            "REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING",
            "REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING",
            "REMOTE_SOLVER2606_CUTOVER_PHASE",
            "REMOTE_SOLVER2606_TARGET_BUILD_ID",
            "REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION",
            "REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256",
            "REMOTE_SOLVER2606_PREVIOUS_BUILD_ID",
        )
    ):
        raise ValueError("non-pending remote-solver state retains transient recovery fields")

    for key in (
        "REMOTE_SOLVER2606_BACKUP_MANIFEST_SHA256",
        "REMOTE_SOLVER2606_ROLLBACK_RECEIPT_SHA256",
    ):
        _require_hex(values[key], key, optional=complete == "0" and pending == "0")
    for key in (
        "REMOTE_SOLVER2606_CANARY_RECEIPT_SHA256",
        "REMOTE_SOLVER2606_ATTESTATION_SHA256",
    ):
        _require_hex(values[key], key, optional=pending == "1" or complete == "0")

    if pending == "1":
        for key in (
            "REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING",
            "REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING",
        ):
            if values[key] not in {"0", "1"}:
                raise ValueError(f"{key} must be 0 or 1 while cutover is pending")
        if not REVISION.fullmatch(values["REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION"]):
            raise ValueError("pending remote-solver cutover lacks its source revision")
        _require_hex(
            values["REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256"],
            "REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256",
        )
        if not values["REMOTE_SOLVER2606_PREVIOUS_BUILD_ID"]:
            raise ValueError("pending remote-solver cutover lacks its previous build id")
        if values["REMOTE_SOLVER2606_CUTOVER_PHASE"] not in {
            "prepared",
            "runtime-recreate-ready",
            "runtime-installed",
        }:
            raise ValueError("pending remote-solver cutover has an invalid phase")
        target_build_id = values["REMOTE_SOLVER2606_TARGET_BUILD_ID"]
        if (
            not target_build_id
            or any(
                character
                not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
                for character in target_build_id
            )
        ):
            raise ValueError("pending remote-solver cutover has an invalid target build id")
        if (
            current_source_revision
            and values["REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION"]
            != current_source_revision
        ):
            raise ValueError("pending remote-solver cutover belongs to a different source revision")
        if (
            current_source_tree_sha256
            and values["REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256"]
            != current_source_tree_sha256
        ):
            raise ValueError("pending remote-solver cutover belongs to a different source tree")

    receipt_sha = values["REMOTE_SOLVER2606_CANARY_RECEIPT_SHA256"]
    attestation_sha = values["REMOTE_SOLVER2606_ATTESTATION_SHA256"]
    if attestation_sha and not receipt_sha:
        raise ValueError("remote-solver attestation marker lacks its receipt marker")
    actual_receipt_sha = ""
    receipt: dict[str, object] | None = None
    if receipt_file.exists():
        receipt_raw = _safe_private_file(receipt_file, "remote-solver canary receipt")
        actual_receipt_sha = hashlib.sha256(receipt_raw).hexdigest()
        receipt = _volume_receipt(receipt_raw)
    if receipt_sha:
        if actual_receipt_sha != receipt_sha:
            raise ValueError("remote-solver canary receipt digest differs from its marker")
    elif actual_receipt_sha and pending != "1":
        raise ValueError("unmarked remote-solver receipt exists outside pending recovery")

    actual_attestation_sha = ""
    if attestation_file.exists():
        attestation_raw = _safe_private_file(
            attestation_file, "remote-solver canary attestation"
        )
        actual_attestation_sha = hashlib.sha256(attestation_raw).hexdigest()
        if attestation_sha and actual_attestation_sha != attestation_sha:
            raise ValueError("remote-solver canary attestation digest differs from its marker")
        try:
            attestation = json.loads(attestation_raw)
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("remote-solver canary attestation is invalid JSON") from exc
        if (
            not isinstance(attestation, dict)
            or attestation.get("profile") != "hz-solver2-volume-v1"
            or attestation.get("receiptSha256")
            != (receipt_sha or actual_receipt_sha)
            or attestation.get("status") != "attested"
        ):
            raise ValueError("remote-solver canary attestation has an invalid binding")
        attested_revision = attestation.get("sourceRevision")
        attested_tree = attestation.get("sourceTreeSha256")
        runtime = attestation.get("runtime")
        storage = attestation.get("evidenceStorage")
        job_ids = attestation.get("jobIds")
        if (
            not isinstance(attested_revision, str)
            or not REVISION.fullmatch(attested_revision)
            or not isinstance(attested_tree, str)
            or not HEX64.fullmatch(attested_tree)
            or (
                pending == "1"
                and (
                    attested_revision
                    != values["REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION"]
                    or attested_tree
                    != values["REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256"]
                )
            )
            or attestation.get("backupManifestSha256")
            != values["REMOTE_SOLVER2606_BACKUP_MANIFEST_SHA256"]
            or attestation.get("rollbackReceiptSha256")
            != values["REMOTE_SOLVER2606_ROLLBACK_RECEIPT_SHA256"]
            or not isinstance(runtime, dict)
            or runtime.get("family") != "openfoam"
            or runtime.get("distribution") != "opencfd"
            or runtime.get("version") != "2606"
            or runtime.get("source_revision")
            != "481094fdf34f11ed6d0d603ee59a858a0124236d"
            or attestation.get("buildId") != runtime.get("build_id")
            or receipt is None
            or runtime != receipt.get("runtime")
            or storage != receipt.get("evidence_storage")
            or job_ids
            != [
                job["job_id"]
                for job in receipt.get("jobs", [])
                if isinstance(job, dict)
            ]
            or (
                pending == "1"
                and runtime.get("build_id")
                != values["REMOTE_SOLVER2606_TARGET_BUILD_ID"]
            )
            or storage
            != {
                "backend": "volume",
                "bucket": None,
                "object_prefix": "solver-evidence/v1",
                "archive_format": "tar+zstd",
                "compression": "zstd",
                "zstd_level": 10,
                "local_disposition": "volume",
            }
            or not isinstance(job_ids, list)
            or len(job_ids) != 3
            or any(not isinstance(job_id, str) or not job_id for job_id in job_ids)
            or len(set(job_ids)) != 3
        ):
            raise ValueError("remote-solver canary attestation source/recovery binding differs")
    elif attestation_sha:
        raise ValueError("remote-solver attestation file is missing")
    if actual_attestation_sha and not actual_receipt_sha:
        raise ValueError("remote-solver attestation file lacks its receipt")
    if actual_attestation_sha and not attestation_sha and pending != "1":
        raise ValueError("unmarked remote-solver attestation exists outside pending recovery")

    if pending == "1":
        if actual_attestation_sha:
            state = "pending-attested"
        elif actual_receipt_sha:
            state = "pending-receipt"
        else:
            state = "pending-pre-canary"
    elif complete == "1":
        if not receipt_sha or not attestation_sha:
            raise ValueError("complete remote-solver cutover lacks its volume attestation")
        state = "complete"
    else:
        state = "pristine"
    if required_state == "pending" and not state.startswith("pending-"):
        raise ValueError("remote-solver cutover is not pending")
    if required_state == "non-pending" and state.startswith("pending-"):
        raise ValueError("remote-solver cutover recovery is pending")
    return state


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True, type=Path)
    parser.add_argument("--receipt-file", required=True, type=Path)
    parser.add_argument("--attestation-file", required=True, type=Path)
    parser.add_argument("--current-source-revision", default="")
    parser.add_argument("--current-source-tree-sha256", default="")
    parser.add_argument(
        "--require-state", choices=("any", "pending", "non-pending"), default="any"
    )
    args = parser.parse_args()
    print(
        validate(
            args.env_file,
            args.receipt_file,
            args.attestation_file,
            current_source_revision=args.current_source_revision,
            current_source_tree_sha256=args.current_source_tree_sha256,
            required_state=args.require_state,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"remote-solver OpenCFD 2606 state error: {exc}", file=sys.stderr)
        raise SystemExit(14) from exc
