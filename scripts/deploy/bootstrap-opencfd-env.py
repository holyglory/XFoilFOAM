#!/usr/bin/env python3
"""Canonicalize only a wholly absent legacy OpenCFD recovery tuple."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import tempfile


DEFAULTS = {
    "OPENCFD2606_CUTOVER_PENDING": "0",
    "OPENCFD2606_CUTOVER_COMPLETE": "0",
    "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING": "",
    "OPENCFD2606_CANARY_ATTESTATION_ID": "",
    "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "0",
    "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256": "",
    "OPENCFD2606_CUTOVER_SOURCE_REVISION": "",
    "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256": "",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()
    path = args.env_file
    lines = path.read_text(encoding="utf-8").splitlines()
    counts = {key: 0 for key in DEFAULTS}
    for line in lines:
        key = line.split("=", 1)[0] if "=" in line else ""
        if key in counts:
            counts[key] += 1
    # This helper owns only the one safe write: installing a pristine tuple
    # when every recovery field is absent.  Any partial, duplicate, malformed,
    # or semantically impossible tuple is left byte-for-byte unchanged for the
    # authoritative cutover-state validator used by the caller.
    if any(counts.values()):
        return 0

    output = lines + [f"{key}={value}" for key, value in DEFAULTS.items()]
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".env.deploy.bootstrap.", dir=path.parent
    )
    try:
        os.fchmod(descriptor, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary:
            temporary.write("\n".join(output) + "\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        os.replace(temporary_name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
