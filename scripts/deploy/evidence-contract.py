#!/usr/bin/env python3
"""Print the canonical production evidence-storage contract SHA-256.

The OpenCFD 2606 canary receipt certifies one exact remote evidence contract.
Deployment scripts persist this digest with the attestation and compare it on
every later engine/control-plane deploy so a valid-looking env edit cannot
silently move evidence to another bucket, prefix, codec level, or disposition.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import sys


CONTRACT_KEYS = (
    "AIRFOILFOAM_EVIDENCE_BUCKET",
    "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX",
    "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL",
    "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY",
)
BUCKET_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$")


def read_contract_values(path: pathlib.Path) -> dict[str, str]:
    found: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not raw_line or raw_line.lstrip().startswith("#") or "=" not in raw_line:
            continue
        key, value = raw_line.split("=", 1)
        if key not in CONTRACT_KEYS:
            continue
        if key in found:
            raise ValueError(
                f"{path}:{line_number}: duplicate {key} makes the evidence contract ambiguous"
            )
        if value != value.strip():
            raise ValueError(
                f"{path}:{line_number}: {key} may not contain surrounding whitespace"
            )
        found[key] = value
    missing = [key for key in CONTRACT_KEYS if key not in found]
    if missing:
        raise ValueError(f"{path}: missing evidence contract keys: {', '.join(missing)}")
    return found


def canonical_contract(values: dict[str, str]) -> dict[str, object]:
    bucket = values["AIRFOILFOAM_EVIDENCE_BUCKET"]
    prefix = values["AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX"]
    zstd_text = values["AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL"]
    remote_only = values["AIRFOILFOAM_EVIDENCE_REMOTE_ONLY"]

    if not BUCKET_RE.fullmatch(bucket):
        raise ValueError("AIRFOILFOAM_EVIDENCE_BUCKET is not a valid configured GCS bucket")
    if not prefix or prefix.startswith("/") or ".." in prefix:
        raise ValueError(
            "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX must be a safe nonempty relative prefix"
        )
    if not re.fullmatch(r"[0-9]+", zstd_text):
        raise ValueError("AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL must be an integer")
    zstd_level = int(zstd_text)
    if not 1 <= zstd_level <= 22:
        raise ValueError("AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL must be from 1 through 22")
    if remote_only.lower() != "true":
        raise ValueError("AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true is required")

    # Keep this value-level shape identical to the receipt contract. The env
    # spelling `REMOTE_ONLY=true` maps to its durable receipt disposition.
    return {
        "archive_format": "tar+zstd",
        "backend": "gcs",
        "bucket": bucket,
        "compression": "zstd",
        "local_disposition": "remote-only",
        "object_prefix": prefix,
        "zstd_level": zstd_level,
    }


def contract_sha256(path: pathlib.Path) -> str:
    payload = json.dumps(
        canonical_contract(read_contract_values(path)),
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True, type=pathlib.Path)
    parser.add_argument("--print-contract", action="store_true")
    args = parser.parse_args()
    try:
        values = read_contract_values(args.env_file)
        contract = canonical_contract(values)
    except (OSError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 2
    if args.print_contract:
        print(json.dumps(contract, sort_keys=True, separators=(",", ":")))
    else:
        payload = json.dumps(
            contract, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        print(hashlib.sha256(payload).hexdigest())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
