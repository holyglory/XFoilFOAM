#!/usr/bin/env python3
"""Validate and durably publish a deployment receipt.

The source and destination must be siblings so publication can use one atomic
no-clobber hard-link operation. The source file is restricted and fsynced
first; the destination directory is fsynced after publication so a successful
return survives power loss. Callers must not perform the external action
certified by the receipt until this command returns successfully.
"""

from __future__ import annotations

import argparse
import errno
import json
import os
from pathlib import Path
import re
from typing import Any


SHA256 = re.compile(r"^[0-9a-f]{64}$")
OCI_SHA256 = re.compile(r"^sha256:[0-9a-f]{64}$")
GIT_OBJECT = re.compile(r"^[0-9a-f]{40}$")


def _require_object(payload: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("receipt must be a JSON object")
    return payload


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"receipt contains duplicate JSON key: {key}")
        result[key] = value
    return result


def _validate_opencfd2606_canary(payload: dict[str, Any]) -> None:
    jobs = payload.get("jobs")
    if (
        payload.get("schema_version") != 1
        or payload.get("status") != "ok"
        or not isinstance(jobs, list)
        or len(jobs) != 3
        or any(
            not isinstance(job, dict)
            or not isinstance(job.get("job_id"), str)
            or not job["job_id"].strip()
            for job in jobs
        )
        or len({job["job_id"] for job in jobs}) != 3
    ):
        raise ValueError(
            "OpenCFD 2606 canary receipt must contain three distinct successful jobs"
        )


def _validate_opencfd2606_volume_canary(payload: dict[str, Any]) -> None:
    jobs = payload.get("jobs")
    scenarios = {
        "serial-rans",
        "mpi-2-rans",
        "forced-urans-precalc-no-shedding",
    }
    storage = payload.get("evidence_storage")
    if (
        payload.get("schema_version") != 1
        or payload.get("status") != "ok"
        or payload.get("attestation_profile") != "hz-solver2-volume-v1"
        or not isinstance(storage, dict)
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
        or not isinstance(jobs, list)
        or len(jobs) != 3
        or {job.get("scenario") for job in jobs if isinstance(job, dict)}
        != scenarios
        or any(
            not isinstance(job, dict)
            or not isinstance(job.get("job_id"), str)
            or not job["job_id"].strip()
            or not isinstance(job.get("volume_restore_proof"), dict)
            or not isinstance(job["volume_restore_proof"].get("strip_bytes_freed"), int)
            or job["volume_restore_proof"]["strip_bytes_freed"] <= 0
            for job in jobs
        )
        or len({job["job_id"] for job in jobs}) != 3
    ):
        raise ValueError(
            "OpenCFD 2606 volume canary receipt must contain the exact retained-volume scenarios and restore proofs"
        )
    for job in jobs:
        points = job.get("points")
        if not isinstance(points, list) or not points:
            raise ValueError("volume canary job has no accepted point evidence")
        for point in points:
            artifacts = point.get("artifacts") if isinstance(point, dict) else None
            if not isinstance(artifacts, list) or not artifacts:
                raise ValueError("volume canary point has no artifact manifest")
            for artifact in artifacts:
                binding = artifact.get("storage") if isinstance(artifact, dict) else None
                if (
                    not isinstance(binding, dict)
                    or binding.get("backend") != "volume"
                    or binding.get("archive_format") != "tar+zstd"
                    or binding.get("compression") != "zstd"
                    or binding.get("zstd_level") != 10
                    or binding.get("local_disposition") != "volume"
                    or not isinstance(binding.get("stored_sha256"), str)
                    or not SHA256.fullmatch(binding["stored_sha256"])
                    or not isinstance(binding.get("stored_byte_size"), int)
                    or binding["stored_byte_size"] <= 0
                    or not isinstance(binding.get("uncompressed_tar_sha256"), str)
                    or not SHA256.fullmatch(binding["uncompressed_tar_sha256"])
                    or not isinstance(binding.get("uncompressed_tar_byte_size"), int)
                    or binding["uncompressed_tar_byte_size"] <= 0
                    or any(
                        key in binding
                        for key in (
                            "bucket",
                            "object_key",
                            "generation",
                            "crc32c",
                            "pointer_path",
                            "restore_verification",
                        )
                    )
                ):
                    raise ValueError("volume canary artifact has an invalid archive binding")


def _validate_opencfd2406_rollback(payload: dict[str, Any]) -> None:
    sha_fields = (
        "context_tree_sha256",
        "dockerfile_sha256",
        "dependency_lock_sha256",
        "simple_foam_sha256",
    )
    text_fields = (
        "base_image",
        "ubuntu_snapshot",
        "image_tag",
        "openfoam_package_version",
        "created_at",
    )
    if (
        payload.get("schema_version") != 1
        or payload.get("purpose")
        != "emergency-opencfd-2406-image-reconstruction"
        or payload.get("deployed") is not False
        or payload.get("platform") != "linux/amd64"
        or not isinstance(payload.get("source_revision"), str)
        or not GIT_OBJECT.fullmatch(payload["source_revision"])
        or not isinstance(payload.get("source_tree"), str)
        or not GIT_OBJECT.fullmatch(payload["source_tree"])
        or not isinstance(payload.get("image_id"), str)
        or not OCI_SHA256.fullmatch(payload["image_id"])
        or any(
            not isinstance(payload.get(field), str)
            or not SHA256.fullmatch(payload[field])
            for field in sha_fields
        )
        or any(
            not isinstance(payload.get(field), str) or not payload[field].strip()
            for field in text_fields
        )
        or "@sha256:" not in payload["base_image"]
    ):
        raise ValueError("OpenCFD 2406 rollback receipt has an invalid identity shape")


VALIDATORS = {
    "opencfd2606-canary": _validate_opencfd2606_canary,
    "opencfd2606-volume-canary": _validate_opencfd2606_volume_canary,
    "opencfd2406-rollback": _validate_opencfd2406_rollback,
}


def _load_and_sync_receipt(path: Path, profile: str) -> None:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"receipt is not a regular file: {path}")
    with path.open("rb") as handle:
        payload = _require_object(
            json.load(handle, object_pairs_hook=_unique_object)
        )
        VALIDATORS[profile](payload)
        os.fchmod(handle.fileno(), 0o600)
        os.fsync(handle.fileno())


def _sync_parent(path: Path) -> None:
    directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
    directory_fd = os.open(path.parent, directory_flags)
    try:
        os.fsync(directory_fd)
    finally:
        os.close(directory_fd)


def persist_receipt(source: Path, destination: Path, profile: str) -> None:
    source = Path(source)
    destination = Path(destination)
    if profile not in VALIDATORS:
        raise ValueError(f"unsupported receipt profile: {profile}")
    if source.is_symlink() or not source.is_file():
        raise ValueError(f"receipt source is not a regular file: {source}")
    if source.parent.resolve() != destination.parent.resolve():
        raise ValueError("receipt source and destination must be siblings")
    if destination.exists() or destination.is_symlink():
        raise ValueError(f"receipt destination already exists: {destination}")

    _load_and_sync_receipt(source, profile)

    # Publish without a check-then-replace race. A same-directory hard link is
    # one atomic no-clobber directory operation: exactly one concurrent writer
    # can create the immutable destination name. The source and destination
    # then name the same already-fsynced inode until the private temp name is
    # removed.
    try:
        os.link(source, destination, follow_symlinks=False)
    except FileExistsError as error:
        raise ValueError(
            f"receipt destination appeared during publication: {destination}"
        ) from error
    except OSError as error:
        if error.errno == errno.EEXIST:
            raise ValueError(
                f"receipt destination appeared during publication: {destination}"
            ) from error
        raise
    os.unlink(source)
    _sync_parent(destination)


def verify_existing_receipt(destination: Path, profile: str) -> None:
    destination = Path(destination)
    if profile not in VALIDATORS:
        raise ValueError(f"unsupported receipt profile: {profile}")
    _load_and_sync_receipt(destination, profile)
    _sync_parent(destination)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True, choices=sorted(VALIDATORS))
    parser.add_argument("--source", type=Path)
    parser.add_argument("--destination", required=True, type=Path)
    parser.add_argument("--verify-existing", action="store_true")
    args = parser.parse_args()
    if args.verify_existing:
        if args.source is not None:
            parser.error("--source cannot be used with --verify-existing")
        verify_existing_receipt(args.destination, args.profile)
    else:
        if args.source is None:
            parser.error("--source is required unless --verify-existing is used")
        persist_receipt(args.source, args.destination, args.profile)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
