#!/usr/bin/env python3
"""Keep the newest complete PostgreSQL backup sets in one private GCS prefix."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from typing import Any, Iterable


BACKUP_TIMESTAMP = re.compile(r"-(\d{8}T\d{6}Z)-[^/]+\.dump$")


@dataclass(frozen=True)
class ObjectVersion:
    name: str
    generation: int
    size: int


@dataclass(frozen=True)
class BackupSet:
    dump_name: str
    timestamp: str
    objects: tuple[ObjectVersion, ...]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--prefix", default="database-backups/production/")
    parser.add_argument("--keep", type=int, default=2)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--timeout-seconds", type=float, default=120.0)
    return parser.parse_args()


def classify(objects: Iterable[ObjectVersion], prefix: str) -> tuple[list[BackupSet], list[ObjectVersion]]:
    grouped: dict[str, dict[str, ObjectVersion]] = {}
    unrelated: list[ObjectVersion] = []
    for obj in objects:
        if not obj.name.startswith(prefix):
            raise ValueError(f"object is outside the requested prefix: {obj.name}")
        if obj.name.endswith(".dump.manifest.json"):
            dump_name = obj.name[: -len(".manifest.json")]
            kind = "manifest"
        elif obj.name.endswith(".dump"):
            dump_name = obj.name
            kind = "dump"
        else:
            unrelated.append(obj)
            continue
        match = BACKUP_TIMESTAMP.search(dump_name)
        if not match:
            unrelated.append(obj)
            continue
        group = grouped.setdefault(dump_name, {})
        if kind in group:
            raise ValueError(f"duplicate live object kind for backup: {dump_name}")
        group[kind] = obj

    complete: list[BackupSet] = []
    incomplete: list[ObjectVersion] = []
    for dump_name, group in grouped.items():
        if set(group) != {"dump", "manifest"}:
            incomplete.extend(group.values())
            continue
        match = BACKUP_TIMESTAMP.search(dump_name)
        assert match is not None
        complete.append(
            BackupSet(
                dump_name=dump_name,
                timestamp=match.group(1),
                objects=(group["dump"], group["manifest"]),
            )
        )
    complete.sort(key=lambda item: (item.timestamp, item.dump_name), reverse=True)
    return complete, sorted(incomplete + unrelated, key=lambda item: item.name)


def deletion_plan(
    complete: list[BackupSet],
    other: list[ObjectVersion],
    keep: int,
) -> tuple[list[BackupSet], list[ObjectVersion]]:
    if keep < 1:
        raise ValueError("--keep must be positive")
    if len(complete) < keep:
        raise RuntimeError(
            f"refusing to prune with only {len(complete)} complete backup set(s); {keep} required"
        )
    retained = complete[:keep]
    delete = [obj for item in complete[keep:] for obj in item.objects]
    oldest_retained_timestamp = retained[-1].timestamp
    for obj in other:
        match = BACKUP_TIMESTAMP.search(
            obj.name[: -len(".manifest.json")]
            if obj.name.endswith(".dump.manifest.json")
            else obj.name
        )
        if match and match.group(1) < oldest_retained_timestamp:
            delete.append(obj)
    delete.sort(key=lambda item: item.name)
    return retained, delete


def is_not_found(exc: Exception) -> bool:
    code: Any = getattr(exc, "code", None)
    if callable(code):
        code = code()
    return code == 404 or exc.__class__.__name__ == "NotFound"


def main() -> int:
    args = parse_args()
    bucket_name = os.environ.get("AIRFOILFOAM_EVIDENCE_BUCKET", "").strip()
    if not bucket_name:
        raise ValueError("AIRFOILFOAM_EVIDENCE_BUCKET is not configured")
    prefix = args.prefix.strip()
    if not prefix or prefix.startswith("/") or ".." in prefix.split("/"):
        raise ValueError("--prefix must be a safe relative GCS prefix")

    from google.cloud import storage

    client = storage.Client()
    versions = [
        ObjectVersion(blob.name, int(blob.generation), int(blob.size or 0))
        for blob in client.list_blobs(bucket_name, prefix=prefix)
    ]
    complete, other = classify(versions, prefix)
    retained, delete = deletion_plan(complete, other, args.keep)
    deleted = 0
    if args.execute:
        bucket = client.bucket(bucket_name)
        for obj in delete:
            try:
                bucket.blob(obj.name, generation=obj.generation).delete(
                    if_generation_match=obj.generation,
                    timeout=args.timeout_seconds,
                )
                deleted += 1
            except Exception as exc:  # noqa: BLE001
                if not is_not_found(exc):
                    raise

    print(
        json.dumps(
            {
                "mode": "execute" if args.execute else "dry_run",
                "bucket": bucket_name,
                "prefix": prefix,
                "retained_backup_sets": [item.dump_name for item in retained],
                "delete_objects": [
                    {"name": obj.name, "generation": obj.generation, "size": obj.size}
                    for obj in delete
                ],
                "deleted": deleted,
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
