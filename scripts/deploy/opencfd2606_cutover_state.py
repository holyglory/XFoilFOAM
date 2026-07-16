#!/usr/bin/env python3
"""Validate the durable OpenCFD v2606 cutover/recovery state.

Every deployment and engine-maintenance entry point invokes this module before
it can build, stop, start, or replace anything.  Keeping parsing and semantic
validation here prevents the individual shell scripts from accepting different
subsets of the same durable recovery tuple.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import uuid


FIELDS = (
    "OPENCFD2606_CUTOVER_PENDING",
    "OPENCFD2606_CUTOVER_COMPLETE",
    "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING",
    "OPENCFD2606_CANARY_ATTESTATION_ID",
    "OPENCFD2606_CANARY_RECEIPT_EXPECTED",
    "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256",
    "OPENCFD2606_CUTOVER_SOURCE_REVISION",
    "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256",
)

SHA1_RE = re.compile(r"^[0-9a-f]{40}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


class CutoverStateError(ValueError):
    """The persisted recovery state cannot be interpreted safely."""


def _parse_env(path: Path) -> dict[str, str]:
    if not path.is_file() or path.is_symlink():
        raise CutoverStateError(
            f"deployment environment is not a non-symlink regular file: {path}"
        )

    occurrences: dict[str, list[str]] = {key: [] for key in FIELDS}
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        raise CutoverStateError(f"cannot read deployment environment: {error}") from error

    for line in lines:
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in occurrences:
            occurrences[key].append(value)

    missing = [key for key in FIELDS if not occurrences[key]]
    duplicate = [key for key in FIELDS if len(occurrences[key]) != 1]
    if missing:
        raise CutoverStateError(
            "OpenCFD v2606 recovery tuple is missing required field(s): "
            + ", ".join(missing)
        )
    if duplicate:
        raise CutoverStateError(
            "OpenCFD v2606 recovery tuple contains duplicate field(s): "
            + ", ".join(duplicate)
        )
    return {key: occurrences[key][0] for key in FIELDS}


def _require_binary(name: str, value: str) -> None:
    if value not in {"0", "1"}:
        raise CutoverStateError(f"{name} must be exactly 0 or 1")


def _valid_uuid(value: str) -> bool:
    if not UUID_RE.fullmatch(value):
        return False
    try:
        uuid.UUID(value)
    except ValueError:
        return False
    return True


def _unique_json_object(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate receipt key: {key}")
        result[key] = value
    return result


def _receipt_state(path: Path) -> tuple[bool, bool]:
    """Return (present, valid_regular_file), including broken symlinks as present."""

    present = os.path.lexists(path)
    valid = present and path.is_file() and not path.is_symlink()
    if valid:
        try:
            with path.open("r", encoding="utf-8") as stream:
                payload = json.load(stream, object_pairs_hook=_unique_json_object)
            jobs = payload.get("jobs") if isinstance(payload, dict) else None
            valid = (
                isinstance(payload, dict)
                and payload.get("schema_version") == 1
                and payload.get("status") == "ok"
                and isinstance(jobs, list)
                and len(jobs) == 3
                and all(
                    isinstance(job, dict)
                    and isinstance(job.get("job_id"), str)
                    and bool(job["job_id"].strip())
                    for job in jobs
                )
                and len({job["job_id"] for job in jobs}) == 3
            )
        except (OSError, UnicodeError, ValueError, TypeError, json.JSONDecodeError):
            valid = False
    return present, valid


def validate_cutover_state(
    *,
    env_file: Path,
    receipt_file: Path,
    require_state: str = "any",
    current_source_revision: str | None = None,
    current_source_tree_sha256: str | None = None,
) -> dict[str, str]:
    values = _parse_env(env_file)

    pending = values["OPENCFD2606_CUTOVER_PENDING"]
    complete = values["OPENCFD2606_CUTOVER_COMPLETE"]
    sweeper = values["OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING"]
    attestation = values["OPENCFD2606_CANARY_ATTESTATION_ID"]
    receipt_expected = values["OPENCFD2606_CANARY_RECEIPT_EXPECTED"]
    contract = values["OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256"]
    source_revision = values["OPENCFD2606_CUTOVER_SOURCE_REVISION"]
    source_tree = values["OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256"]

    _require_binary("OPENCFD2606_CUTOVER_PENDING", pending)
    _require_binary("OPENCFD2606_CUTOVER_COMPLETE", complete)
    _require_binary("OPENCFD2606_CANARY_RECEIPT_EXPECTED", receipt_expected)
    if sweeper not in {"", "0", "1"}:
        raise CutoverStateError(
            "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING must be empty, 0, or 1"
        )
    if attestation and not _valid_uuid(attestation):
        raise CutoverStateError(
            "OPENCFD2606_CANARY_ATTESTATION_ID must be empty or a canonical UUID"
        )
    if contract and not SHA256_RE.fullmatch(contract):
        raise CutoverStateError(
            "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256 must be empty or a lowercase SHA-256"
        )
    if source_revision and not SHA1_RE.fullmatch(source_revision):
        raise CutoverStateError(
            "OPENCFD2606_CUTOVER_SOURCE_REVISION must be empty or a lowercase 40-hex revision"
        )
    if source_tree and not SHA256_RE.fullmatch(source_tree):
        raise CutoverStateError(
            "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256 must be empty or a lowercase SHA-256"
        )

    receipt_present, receipt_valid = _receipt_state(receipt_file)
    if receipt_expected == "1":
        if not receipt_valid:
            raise CutoverStateError(
                "pending cutover expects an exact retained canary receipt, but "
                f"{receipt_file} is missing or invalid"
            )
    elif receipt_present and pending != "1":
        raise CutoverStateError(
            "a retained canary receipt exists while OPENCFD2606_CANARY_RECEIPT_EXPECTED=0"
        )
    elif receipt_present and not receipt_valid:
        raise CutoverStateError(
            "a retained recovery receipt must be a nonempty, non-symlink regular file"
        )

    if pending == "0":
        if sweeper or attestation or receipt_expected != "0":
            raise CutoverStateError(
                "non-pending state must not retain scheduler, attestation, or receipt recovery fields"
            )
        if source_revision or source_tree:
            raise CutoverStateError(
                "non-pending state must not retain a deployment-source recovery binding"
            )
        if complete == "0":
            if contract:
                raise CutoverStateError(
                    "pristine non-pending state must not claim a certified evidence contract"
                )
            state_kind = "pristine"
        else:
            if not SHA256_RE.fullmatch(contract):
                raise CutoverStateError(
                    "terminal certified state requires an exact evidence-contract SHA-256"
                )
            state_kind = "terminal"
    else:
        if complete != "0":
            raise CutoverStateError("pending recovery cannot also be marked complete")
        if sweeper not in {"0", "1"}:
            raise CutoverStateError(
                "pending recovery requires the durable pre-maintenance sweeper state"
            )
        if not SHA1_RE.fullmatch(source_revision) or not SHA256_RE.fullmatch(source_tree):
            raise CutoverStateError(
                "pending recovery requires an exact deployment-source revision and tree binding"
            )
        if attestation:
            if receipt_expected != "0":
                raise CutoverStateError(
                    "attested pending recovery cannot also expect an unacknowledged receipt"
                )
            if not SHA256_RE.fullmatch(contract):
                raise CutoverStateError(
                    "attested pending recovery requires an exact certified evidence contract"
                )
            state_kind = (
                "pending-attested-retained-receipt"
                if receipt_present
                else "pending-attested"
            )
        elif receipt_expected == "1":
            if contract:
                raise CutoverStateError(
                    "pre-attestation receipt recovery must not claim a certified evidence contract"
                )
            state_kind = "pending-receipt"
        elif receipt_present:
            if contract:
                raise CutoverStateError(
                    "unmarked pre-attestation receipt recovery must not claim a certified evidence contract"
                )
            state_kind = "pending-unmarked-receipt"
        else:
            if contract:
                raise CutoverStateError(
                    "pending pre-attestation state must not claim a certified evidence contract"
                )
            state_kind = "pending-pristine"

    if (current_source_revision is None) != (current_source_tree_sha256 is None):
        raise CutoverStateError(
            "current deployment source revision and tree SHA-256 must be supplied together"
        )
    if current_source_revision is not None:
        if not SHA1_RE.fullmatch(current_source_revision):
            raise CutoverStateError("current deployment source revision is malformed")
        if not SHA256_RE.fullmatch(current_source_tree_sha256 or ""):
            raise CutoverStateError("current deployment source tree SHA-256 is malformed")
        if pending == "1" and (
            source_revision != current_source_revision
            or source_tree != current_source_tree_sha256
        ):
            raise CutoverStateError(
                "pending OpenCFD v2606 recovery belongs to a different deployment source"
            )

    if require_state == "non-pending" and pending != "0":
        raise CutoverStateError(
            "OpenCFD v2606 cutover recovery is pending; source/control-plane mutation is forbidden"
        )
    if require_state == "pending-certifiable" and state_kind not in {
        "pending-receipt",
        "pending-unmarked-receipt",
        "pending-attested",
        "pending-attested-retained-receipt",
    }:
        raise CutoverStateError(
            "continuation certification requires an exact pending receipt or attestation tuple"
        )

    return {**values, "state_kind": state_kind}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--receipt-file", type=Path, required=True)
    parser.add_argument(
        "--require-state",
        choices=("any", "non-pending", "pending-certifiable"),
        default="any",
    )
    parser.add_argument("--current-source-revision")
    parser.add_argument("--current-source-tree-sha256")
    parser.add_argument("--print-json", action="store_true")
    args = parser.parse_args(argv)
    try:
        values = validate_cutover_state(
            env_file=args.env_file,
            receipt_file=args.receipt_file,
            require_state=args.require_state,
            current_source_revision=args.current_source_revision,
            current_source_tree_sha256=args.current_source_tree_sha256,
        )
    except CutoverStateError as error:
        print(
            f"Unsafe OpenCFD v2606 recovery state: {error}; refusing deployment or maintenance.",
            file=sys.stderr,
        )
        return 14
    if args.print_json:
        print(json.dumps(values, sort_keys=True))
    else:
        print(values["state_kind"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
