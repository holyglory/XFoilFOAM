#!/usr/bin/env python3
"""Stream one immutable file from stdin into the private production GCS bucket."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from typing import Any


def is_precondition_failed(exc: Exception) -> bool:
    code: Any = getattr(exc, "code", None)
    if callable(code):
        code = code()
    return code == 412 or exc.__class__.__name__ == "PreconditionFailed"


class HashingReader:
    def __init__(self, stream: Any) -> None:
        self.stream = stream
        self.digest = hashlib.sha256()
        self.bytes_read = 0

    def read(self, size: int = -1) -> bytes:
        chunk = self.stream.read(size)
        if chunk:
            self.digest.update(chunk)
            self.bytes_read += len(chunk)
        return chunk

    def tell(self) -> int:
        return self.bytes_read


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--object-key", required=True)
    parser.add_argument("--size", required=True, type=int)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--content-type", default="application/octet-stream")
    parser.add_argument("--timeout-seconds", type=float, default=900.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    bucket_name = os.environ.get("AIRFOILFOAM_EVIDENCE_BUCKET", "").strip()
    if not bucket_name:
        raise ValueError("AIRFOILFOAM_EVIDENCE_BUCKET is not configured")
    if args.size <= 0:
        raise ValueError("--size must be positive")
    expected_sha256 = args.sha256.strip().lower()
    if len(expected_sha256) != 64 or any(c not in "0123456789abcdef" for c in expected_sha256):
        raise ValueError("--sha256 must be 64 lowercase hexadecimal characters")
    object_key = args.object_key.strip()
    if not object_key or object_key.startswith("/") or ".." in object_key.split("/"):
        raise ValueError("--object-key must be a safe relative GCS key")

    from google.cloud import storage

    client = storage.Client()
    blob = client.bucket(bucket_name).blob(object_key)
    blob.metadata = {
        "content-sha256": expected_sha256,
        "content-byte-size": str(args.size),
        "kind": "airfoils-pro-postgres-backup",
    }
    reader = HashingReader(sys.stdin.buffer)
    state = "uploaded"
    try:
        blob.upload_from_file(
            reader,
            size=args.size,
            content_type=args.content_type,
            if_generation_match=0,
            checksum="crc32c",
            timeout=args.timeout_seconds,
        )
    except Exception as exc:  # noqa: BLE001
        if not is_precondition_failed(exc):
            raise
        state = "already_present"
    if state == "uploaded":
        if reader.bytes_read != args.size or reader.digest.hexdigest() != expected_sha256:
            raise RuntimeError("stdin size or SHA-256 changed during GCS upload")

    blob.reload(timeout=args.timeout_seconds)
    metadata = blob.metadata or {}
    if (
        int(blob.size or -1) != args.size
        or metadata.get("content-sha256") != expected_sha256
        or metadata.get("content-byte-size") != str(args.size)
    ):
        raise RuntimeError("stored GCS object metadata does not match the requested file")
    print(
        json.dumps(
            {
                "state": state,
                "bucket": bucket_name,
                "object_key": object_key,
                "generation": str(blob.generation),
                "size": int(blob.size),
                "sha256": expected_sha256,
                "crc32c": blob.crc32c,
            },
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        raise SystemExit(1)
