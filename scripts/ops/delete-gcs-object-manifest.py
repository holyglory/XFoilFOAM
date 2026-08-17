#!/usr/bin/env python3
"""Delete an exact CSV manifest of generation-pinned GCS objects.

This is an intentionally small maintenance primitive. It does not discover,
download, inspect, reduce, restore, or reinterpret archive contents. The
database owner must materialize the deletion set first. Every mutation carries
the exact immutable GCS generation precondition from that manifest.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_WORKERS = 64
OBSOLETE_DISPOSITION = "obsolete_no_modern_canonical"
REQUIRED_COLUMNS = {
    "bucket",
    "object_key",
    "generation",
    "byte_size",
    "contract_disposition",
}


@dataclass(frozen=True)
class Target:
    bucket: str
    object_key: str
    generation: int
    byte_size: int
    contract_disposition: str


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_targets(path: Path) -> list[Target]:
    with path.open(newline="", encoding="utf-8") as stream:
        reader = csv.DictReader(stream)
        columns = set(reader.fieldnames or ())
        if not REQUIRED_COLUMNS.issubset(columns):
            missing = sorted(REQUIRED_COLUMNS - columns)
            raise ValueError(f"manifest is missing columns: {', '.join(missing)}")
        targets: list[Target] = []
        identities: set[tuple[str, str, int]] = set()
        for row_number, row in enumerate(reader, start=2):
            bucket = (row.get("bucket") or "").strip()
            object_key = (row.get("object_key") or "").strip()
            disposition = (row.get("contract_disposition") or "").strip()
            if not bucket or not object_key or object_key.startswith("/"):
                raise ValueError(f"manifest row {row_number} has an invalid object identity")
            if disposition != OBSOLETE_DISPOSITION:
                raise ValueError(
                    f"manifest row {row_number} is not explicitly classified as {OBSOLETE_DISPOSITION}"
                )
            try:
                generation = int(row.get("generation") or "")
                byte_size = int(row.get("byte_size") or "")
            except ValueError as exc:
                raise ValueError(
                    f"manifest row {row_number} has a non-integer generation or byte size"
                ) from exc
            if generation <= 0 or byte_size < 0:
                raise ValueError(f"manifest row {row_number} has out-of-range metadata")
            identity = (bucket, object_key, generation)
            if identity in identities:
                raise ValueError(f"manifest row {row_number} duplicates an object generation")
            identities.add(identity)
            targets.append(Target(bucket, object_key, generation, byte_size, disposition))
    if not targets:
        raise ValueError("manifest contains no deletion targets")
    return targets


def is_not_found(exc: Exception) -> bool:
    code: Any = getattr(exc, "code", None)
    if callable(code):
        code = code()
    return code == 404 or exc.__class__.__name__ == "NotFound"


def delete_target(client: Any, target: Target, timeout: float) -> str:
    blob = client.bucket(target.bucket).blob(
        target.object_key,
        generation=target.generation,
    )
    try:
        blob.delete(if_generation_match=target.generation, timeout=timeout)
        return "deleted"
    except Exception as exc:  # noqa: BLE001 - provider exception families vary
        if is_not_found(exc):
            return "already_absent"
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--expect-sha256")
    parser.add_argument("--workers", type=int, default=32)
    parser.add_argument("--timeout-seconds", type=float, default=120.0)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    path = Path(args.manifest).resolve(strict=True)
    targets = load_targets(path)
    checksum = file_sha256(path)
    configured_bucket = os.environ.get("AIRFOILFOAM_EVIDENCE_BUCKET", "").strip()
    buckets = sorted({target.bucket for target in targets})
    summary = {
        "manifest": str(path),
        "sha256": checksum,
        "objects": len(targets),
        "bytes": sum(target.byte_size for target in targets),
        "buckets": buckets,
        "contract_disposition": OBSOLETE_DISPOSITION,
        "execute": bool(args.execute),
    }
    if not args.execute:
        print(json.dumps(summary, sort_keys=True))
        return 0
    if args.expect_sha256 != checksum:
        raise ValueError("--expect-sha256 must match the exact manifest")
    if not configured_bucket or buckets != [configured_bucket]:
        raise ValueError("manifest bucket does not match AIRFOILFOAM_EVIDENCE_BUCKET")
    if not 1 <= args.workers <= MAX_WORKERS:
        raise ValueError(f"--workers must be between 1 and {MAX_WORKERS}")
    if not 1 <= args.timeout_seconds <= 900:
        raise ValueError("--timeout-seconds must be between 1 and 900")

    from google.cloud import storage

    client = storage.Client()
    counts = {"deleted": 0, "already_absent": 0}
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {
            executor.submit(delete_target, client, target, args.timeout_seconds): index
            for index, target in enumerate(targets, start=1)
        }
        for future in as_completed(futures):
            index = futures[future]
            try:
                counts[future.result()] += 1
            except Exception as exc:  # noqa: BLE001
                errors.append(f"row_index={index} error={type(exc).__name__}: {exc}")
                if len(errors) >= 20:
                    for pending in futures:
                        pending.cancel()
                    break

    result = {**summary, **counts, "errors": errors}
    print(json.dumps(result, sort_keys=True))
    return 1 if errors else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # noqa: BLE001
        print(json.dumps({"error": f"{type(error).__name__}: {error}"}), file=sys.stderr)
        raise SystemExit(1)
