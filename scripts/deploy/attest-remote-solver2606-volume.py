#!/usr/bin/env python3
"""Create the immutable hz-solver2 volume-canary attestation."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile


SHA256 = re.compile(r"^[0-9a-f]{64}$")
REVISION = re.compile(r"^[0-9a-f]{40}$")
PROFILE = "hz-solver2-volume-v1"
ENGINE = {
    "family": "openfoam",
    "distribution": "opencfd",
    "version": "2606",
    "numerics_revision": "1",
    # EngineIdentity serializes this field as a JSON number.  Keep the
    # attester byte-shape compatible with the canary/API receipt it protects.
    "adapter_contract_version": 1,
}
ENGINE_HANDSHAKE_KEY = "openfoam:opencfd:2606:numerics-1:adapter-1"
EXECUTION_POOL = "openfoam-opencfd-2606"


def _canonical(value: object) -> bytes:
    return json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    ).encode("utf-8")


def _safe_receipt(path: Path) -> tuple[dict[str, object], bytes]:
    metadata = path.lstat()
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        raise ValueError("volume canary receipt must be a non-symlink regular file")
    if stat.S_IMODE(metadata.st_mode) != 0o600 or metadata.st_uid != os.geteuid():
        raise ValueError("volume canary receipt must be owner-owned mode 0600")
    raw = path.read_bytes()
    try:
        value = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("volume canary receipt is invalid JSON") from exc
    if not isinstance(value, dict):
        raise ValueError("volume canary receipt must be an object")
    jobs = value.get("jobs")
    scenarios = {
        "serial-rans",
        "mpi-2-rans",
        "forced-urans-precalc-no-shedding",
    }
    if (
        value.get("schema_version") != 1
        or value.get("status") != "ok"
        or value.get("attestation_profile") != PROFILE
        or value.get("engine") != ENGINE
        or value.get("engine_handshake_key") != ENGINE_HANDSHAKE_KEY
        or value.get("execution_pool") != EXECUTION_POOL
        or not isinstance(jobs, list)
        or len(jobs) != 3
        or any(
            not isinstance(job, dict)
            or not isinstance(job.get("job_id"), str)
            or not job["job_id"]
            or not isinstance(job.get("scenario"), str)
            or not isinstance(job.get("volume_restore_proof"), dict)
            for job in jobs
        )
    ):
        raise ValueError("volume canary receipt has an invalid profile or scenario set")
    assert isinstance(jobs, list)
    if (
        {job["scenario"] for job in jobs} != scenarios
        or len({job["job_id"] for job in jobs}) != 3
    ):
        raise ValueError("volume canary receipt has duplicate jobs or scenarios")
    storage = value.get("evidence_storage")
    if not isinstance(storage, dict) or storage != {
        "backend": "volume",
        "bucket": None,
        "object_prefix": "solver-evidence/v1",
        "archive_format": "tar+zstd",
        "compression": "zstd",
        "zstd_level": 10,
        "local_disposition": "volume",
    }:
        raise ValueError("volume canary receipt has an invalid retained-storage contract")
    runtime = value.get("runtime")
    if (
        not isinstance(runtime, dict)
        or runtime.get("family") != "openfoam"
        or runtime.get("distribution") != "opencfd"
        or runtime.get("version") != "2606"
        or runtime.get("source_revision")
        != "481094fdf34f11ed6d0d603ee59a858a0124236d"
        or not isinstance(runtime.get("build_id"), str)
        or not runtime["build_id"]
    ):
        raise ValueError("volume canary receipt lacks official OpenCFD 2606 provenance")
    return value, raw


def _write_atomic(path: Path, payload: dict[str, object]) -> None:
    if path.exists() or path.is_symlink():
        raise ValueError(f"attestation destination already exists: {path}")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "wb") as output:
            fd = -1
            output.write(_canonical(payload) + b"\n")
            output.flush()
            os.fsync(output.fileno())
        os.link(temporary_name, path, follow_symlinks=False)
        os.unlink(temporary_name)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if fd >= 0:
            os.close(fd)
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--receipt", required=True, type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--source-tree-sha256", required=True)
    parser.add_argument("--backup-manifest-sha256", required=True)
    parser.add_argument("--rollback-receipt-sha256", required=True)
    args = parser.parse_args()
    if not REVISION.fullmatch(args.source_revision):
        raise ValueError("source revision must be lowercase 40-hex")
    for label, value in (
        ("source tree", args.source_tree_sha256),
        ("backup manifest", args.backup_manifest_sha256),
        ("rollback receipt", args.rollback_receipt_sha256),
    ):
        if not SHA256.fullmatch(value):
            raise ValueError(f"{label} must be a lowercase SHA-256")

    receipt, raw = _safe_receipt(args.receipt)
    runtime = receipt["runtime"]
    assert isinstance(runtime, dict)
    receipt_sha = hashlib.sha256(raw).hexdigest()
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "profile": PROFILE,
        "status": "attested",
        "receiptSha256": receipt_sha,
        "sourceRevision": args.source_revision,
        "sourceTreeSha256": args.source_tree_sha256,
        "backupManifestSha256": args.backup_manifest_sha256,
        "rollbackReceiptSha256": args.rollback_receipt_sha256,
        "buildId": runtime.get("build_id"),
        "runtime": runtime,
        "evidenceStorage": receipt["evidence_storage"],
        "jobIds": [job["job_id"] for job in receipt["jobs"]],
        "attestedAt": datetime.now(timezone.utc).isoformat(),
    }
    _write_atomic(args.destination, payload)
    print(hashlib.sha256(args.destination.read_bytes()).hexdigest())
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"remote-solver volume attestation error: {exc}", file=sys.stderr)
        raise SystemExit(14) from exc
