"""Generation-pinned deletion of attested, zero-owner canary GCS objects.

The database-side reservation is the authority and permanent ownership fence.
This module deliberately has no prefix/list operation: it accepts only exact
reservation documents, verifies their embedded durable canary receipt, checks
the live object metadata, and deletes with a generation precondition.  Dry-run
is the default at the CLI boundary.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping


SHA256 = re.compile(r"^[0-9a-f]{64}$")
GENERATION = re.compile(r"^[1-9][0-9]{0,19}$")
CRC32C = re.compile(r"^[A-Za-z0-9+/]{6}==$")
MAX_GCS_GENERATION = 18_446_744_073_709_551_615
RESERVATION_KIND = "opencfd2606-canary-gcs-cleanup-reservation"
RECEIPT_KIND = "opencfd2606-canary-gcs-cleanup-receipt"


class CanaryCleanupError(RuntimeError):
    """Fail-closed cleanup validation or provider error."""


@dataclass(frozen=True)
class CleanupTarget:
    bucket: str
    object_key: str
    generation: str
    sha256: str
    byte_size: int
    crc32c: str

    def to_dict(self) -> dict[str, object]:
        return {
            "bucket": self.bucket,
            "objectKey": self.object_key,
            "generation": self.generation,
            "sha256": self.sha256,
            "byteSize": self.byte_size,
            "crc32c": self.crc32c,
        }


@dataclass(frozen=True)
class CleanupReservation:
    reservation_id: str
    reserved_at: str
    reserved_by: str
    attestation_id: str
    attestation_receipt_sha256: str
    canonical_attestation_receipt: str
    target: CleanupTarget


def _object(value: object, label: str) -> Mapping[str, object]:
    if not isinstance(value, dict):
        raise CanaryCleanupError(f"{label} must be an object")
    return value


def _array(value: object, label: str) -> list[object]:
    if not isinstance(value, list):
        raise CanaryCleanupError(f"{label} must be an array")
    return value


def _exact_keys(value: Mapping[str, object], keys: Iterable[str], label: str) -> None:
    expected = set(keys)
    if set(value) != expected:
        raise CanaryCleanupError(f"{label} has unexpected or missing fields")


def _string(value: object, label: str) -> str:
    if not isinstance(value, str) or not value or value.strip() != value:
        raise CanaryCleanupError(f"{label} must be an exact non-empty string")
    return value


def _pattern(value: object, label: str, expected: re.Pattern[str]) -> str:
    parsed = _string(value, label)
    if expected.fullmatch(parsed) is None:
        raise CanaryCleanupError(f"{label} has an invalid format")
    return parsed


def _positive_safe_int(value: object, label: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value <= 0
        or value > 9_007_199_254_740_991
    ):
        raise CanaryCleanupError(f"{label} must be a positive safe integer")
    return value


def _uuid(value: object, label: str) -> str:
    parsed = _string(value, label)
    try:
        identifier = uuid.UUID(parsed)
    except ValueError as exc:
        raise CanaryCleanupError(f"{label} must be a UUID") from exc
    if str(identifier) != parsed:
        raise CanaryCleanupError(f"{label} must use canonical lowercase UUID form")
    return parsed


def _timestamp(value: object, label: str) -> str:
    parsed = _string(value, label)
    try:
        datetime.fromisoformat(parsed.replace("Z", "+00:00"))
    except ValueError as exc:
        raise CanaryCleanupError(f"{label} must be an ISO timestamp") from exc
    return parsed


def _target(value: object, label: str) -> CleanupTarget:
    target = _object(value, label)
    _exact_keys(
        target,
        ("bucket", "objectKey", "generation", "sha256", "byteSize", "crc32c"),
        label,
    )
    generation = _pattern(target["generation"], f"{label}.generation", GENERATION)
    if int(generation) > MAX_GCS_GENERATION:
        raise CanaryCleanupError(f"{label}.generation exceeds GCS uint64")
    object_key = _string(target["objectKey"], f"{label}.objectKey")
    path = PurePosixPath(object_key)
    if (
        path.is_absolute()
        or "\\" in object_key
        or any(part in {"", ".", ".."} for part in path.parts)
    ):
        raise CanaryCleanupError(f"{label}.objectKey is unsafe")
    return CleanupTarget(
        bucket=_string(target["bucket"], f"{label}.bucket"),
        object_key=object_key,
        generation=generation,
        sha256=_pattern(target["sha256"], f"{label}.sha256", SHA256),
        byte_size=_positive_safe_int(target["byteSize"], f"{label}.byteSize"),
        crc32c=_pattern(target["crc32c"], f"{label}.crc32c", CRC32C),
    )


def _attested_bundle_targets(receipt: object) -> list[CleanupTarget]:
    root = _object(receipt, "embedded canary attestation receipt")
    if root.get("schema_version") != 1 or root.get("status") != "ok":
        raise CanaryCleanupError("embedded canary receipt is not successful schema v1")
    engine = _object(root.get("engine"), "embedded canary engine")
    if (
        engine.get("family") != "openfoam"
        or engine.get("distribution") != "opencfd"
        or engine.get("version") != "2606"
    ):
        raise CanaryCleanupError("embedded canary receipt is not OpenCFD 2606")
    storage = _object(root.get("evidence_storage"), "embedded evidence storage")
    if (
        storage.get("backend") != "gcs"
        or storage.get("archive_format") != "tar+zstd"
        or storage.get("compression") != "zstd"
        or storage.get("local_disposition") != "remote-only"
    ):
        raise CanaryCleanupError("embedded canary receipt is not remote-only GCS Zstandard")
    bucket = _string(storage.get("bucket"), "embedded GCS bucket")
    prefix = _string(storage.get("object_prefix"), "embedded GCS prefix")
    prefix_path = PurePosixPath(prefix)
    if (
        prefix_path.is_absolute()
        or "\\" in prefix
        or any(part in {"", ".", ".."} for part in prefix_path.parts)
    ):
        raise CanaryCleanupError("embedded GCS prefix is unsafe")
    found: dict[tuple[str, str, str], CleanupTarget] = {}
    for job in _array(root.get("jobs"), "embedded canary jobs"):
        job_object = _object(job, "embedded canary job")
        for point in _array(job_object.get("points"), "embedded canary points"):
            point_object = _object(point, "embedded canary point")
            for artifact in _array(
                point_object.get("artifacts"), "embedded canary artifacts"
            ):
                artifact_object = _object(artifact, "embedded canary artifact")
                if artifact_object.get("kind") != "engine_bundle":
                    continue
                artifact_sha = _pattern(
                    artifact_object.get("sha256"), "embedded bundle SHA-256", SHA256
                )
                artifact_size = _positive_safe_int(
                    artifact_object.get("byte_size"), "embedded bundle byte size"
                )
                binding = _object(
                    artifact_object.get("storage"), "embedded bundle storage"
                )
                candidate = _target(
                    {
                        "bucket": binding.get("bucket"),
                        "objectKey": binding.get("object_key"),
                        "generation": binding.get("generation"),
                        "sha256": binding.get("stored_sha256"),
                        "byteSize": binding.get("stored_byte_size"),
                        "crc32c": binding.get("crc32c"),
                    },
                    "embedded canary target",
                )
                expected_key = (
                    f"{prefix}/sha256/{candidate.sha256[:2]}/"
                    f"{candidate.sha256}.tar.zst"
                )
                if (
                    candidate.bucket != bucket
                    or candidate.object_key != expected_key
                    or candidate.sha256 != artifact_sha
                    or candidate.byte_size != artifact_size
                ):
                    raise CanaryCleanupError(
                        "embedded bundle differs from its content-addressed identity"
                    )
                key = (candidate.bucket, candidate.object_key, candidate.generation)
                previous = found.get(key)
                if previous is not None and previous != candidate:
                    raise CanaryCleanupError(
                        "embedded canary generation has conflicting identities"
                    )
                found[key] = candidate
    if not found:
        raise CanaryCleanupError("embedded canary receipt has no engine bundles")
    return sorted(found.values(), key=lambda item: (item.bucket, item.object_key, item.generation))


def parse_reservation(value: object) -> CleanupReservation:
    document = _object(value, "cleanup reservation document")
    _exact_keys(
        document,
        (
            "schemaVersion",
            "kind",
            "reservationId",
            "reservedAt",
            "reservedBy",
            "attestation",
            "target",
            "ownershipAtReservation",
        ),
        "cleanup reservation document",
    )
    if document["schemaVersion"] != 1 or document["kind"] != RESERVATION_KIND:
        raise CanaryCleanupError("unsupported cleanup reservation document")
    ownership = _object(document["ownershipAtReservation"], "reservation ownership")
    _exact_keys(
        ownership,
        (
            "blobCount",
            "artifactCount",
            "archiveCount",
            "orphanQuarantineCount",
            "incompleteQuarantineCount",
        ),
        "reservation ownership",
    )
    for name, count in ownership.items():
        if isinstance(count, bool) or not isinstance(count, int) or count != 0:
            raise CanaryCleanupError(f"reservation {name} must be exact integer zero")
    attestation = _object(document["attestation"], "reservation attestation")
    _exact_keys(
        attestation,
        ("id", "receiptSha256", "canonicalReceipt"),
        "reservation attestation",
    )
    receipt_sha = _pattern(
        attestation["receiptSha256"], "attestation receipt SHA-256", SHA256
    )
    canonical_receipt = _string(
        attestation["canonicalReceipt"], "canonical attestation receipt"
    )
    if hashlib.sha256(canonical_receipt.encode("utf-8")).hexdigest() != receipt_sha:
        raise CanaryCleanupError("embedded attestation receipt digest mismatch")
    try:
        receipt = json.loads(canonical_receipt)
    except json.JSONDecodeError as exc:
        raise CanaryCleanupError("canonical attestation receipt is invalid JSON") from exc
    target = _target(document["target"], "reservation target")
    if target not in _attested_bundle_targets(receipt):
        raise CanaryCleanupError(
            "reservation target is absent from the embedded durable canary attestation"
        )
    return CleanupReservation(
        reservation_id=_uuid(document["reservationId"], "reservation id"),
        reserved_at=_timestamp(document["reservedAt"], "reservation timestamp"),
        reserved_by=_string(document["reservedBy"], "reservation actor"),
        attestation_id=_uuid(attestation["id"], "attestation id"),
        attestation_receipt_sha256=receipt_sha,
        canonical_attestation_receipt=canonical_receipt,
        target=target,
    )


def _is_not_found(exc: Exception) -> bool:
    code = getattr(exc, "code", None)
    code = code() if callable(code) else code
    return code == 404 or exc.__class__.__name__ == "NotFound"


def _observe_blob(client: Any, target: CleanupTarget) -> tuple[Any, dict[str, object]] | None:
    blob = client.bucket(target.bucket).blob(
        target.object_key, generation=int(target.generation)
    )
    try:
        blob.reload(
            if_generation_match=int(target.generation),
            timeout=900,
        )
    except Exception as exc:  # noqa: BLE001 - provider exceptions vary
        if _is_not_found(exc):
            return None
        raise CanaryCleanupError(
            f"cannot inspect gs://{target.bucket}/{target.object_key}#"
            f"{target.generation}: {exc}"
        ) from exc
    metadata = getattr(blob, "metadata", None)
    observed_generation = getattr(blob, "generation", None)
    observed_size = getattr(blob, "size", None)
    observed_crc32c = getattr(blob, "crc32c", None)
    try:
        parsed_size = int(observed_size)
    except (TypeError, ValueError):
        parsed_size = -1
    if (
        isinstance(observed_generation, bool)
        or str(observed_generation) != target.generation
        or isinstance(observed_size, bool)
        or parsed_size != target.byte_size
        or not isinstance(metadata, Mapping)
        or metadata.get("stored-sha256") != target.sha256
        or metadata.get("stored-size") != str(target.byte_size)
        or observed_crc32c != target.crc32c
    ):
        raise CanaryCleanupError(
            f"live GCS metadata differs from reserved identity for "
            f"gs://{target.bucket}/{target.object_key}#{target.generation}"
        )
    return blob, {"status": "present", **target.to_dict()}


def _canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _receipt_path(receipt_dir: Path, reservation_id: str) -> Path:
    return receipt_dir / f"{reservation_id}.json"


def _read_existing_receipt(
    path: Path, reservation: CleanupReservation
) -> dict[str, object] | None:
    if not path.exists():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise CanaryCleanupError(f"existing cleanup receipt is unreadable: {path}: {exc}") from exc
    receipt = _object(value, "existing cleanup receipt")
    _exact_keys(
        receipt,
        (
            "schemaVersion",
            "kind",
            "reservationId",
            "attestationId",
            "target",
            "preDeleteObservation",
            "postDeleteObservation",
            "outcome",
            "deletedAt",
            "operator",
        ),
        "existing cleanup receipt",
    )
    target = _target(receipt.get("target"), "existing receipt target")
    observation = _object(
        receipt.get("preDeleteObservation"), "existing pre-delete observation"
    )
    outcome = receipt.get("outcome")
    if observation.get("status") == "present":
        _exact_keys(
            observation,
            ("status", "bucket", "objectKey", "generation", "sha256", "byteSize", "crc32c"),
            "existing present observation",
        )
        observed = _target(
            {key: value for key, value in observation.items() if key != "status"},
            "existing present target",
        )
        observation_valid = outcome == "deleted" and observed == target
    elif observation.get("status") == "absent":
        _exact_keys(observation, ("status",), "existing absent observation")
        observation_valid = outcome == "already_absent_after_reservation"
    else:
        observation_valid = False
    post_delete_observation = _object(
        receipt.get("postDeleteObservation"), "existing post-delete observation"
    )
    _exact_keys(
        post_delete_observation,
        ("status",),
        "existing post-delete observation",
    )
    if (
        receipt.get("schemaVersion") != 1
        or receipt.get("kind") != RECEIPT_KIND
        or receipt.get("reservationId") != reservation.reservation_id
        or receipt.get("attestationId") != reservation.attestation_id
        or target != reservation.target
        or not observation_valid
        or post_delete_observation.get("status") != "absent"
    ):
        raise CanaryCleanupError("existing immutable cleanup receipt conflicts with reservation")
    _timestamp(receipt.get("deletedAt"), "existing receipt deletedAt")
    _string(receipt.get("operator"), "existing receipt operator")
    return dict(receipt)


def _write_immutable_receipt(path: Path, receipt: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(path.parent, 0o700)
    except OSError as exc:
        raise CanaryCleanupError(f"cannot secure cleanup receipt directory: {exc}") from exc
    encoded = json.dumps(receipt, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    try:
        with path.open("x", encoding="utf-8") as output:
            os.chmod(path, 0o600)
            output.write(encoded)
            output.flush()
            os.fsync(output.fileno())
        descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except FileExistsError:
        existing = path.read_text(encoding="utf-8")
        if existing != encoded:
            raise CanaryCleanupError("immutable cleanup receipt already exists with different bytes")


def cleanup_reservation(
    reservation_value: object,
    *,
    client: Any,
    receipt_dir: Path,
    operator: str,
    execute: bool = False,
    now: datetime | None = None,
) -> dict[str, object]:
    reservation = parse_reservation(reservation_value)
    operator_name = _string(operator, "cleanup operator")
    receipt_path = _receipt_path(Path(receipt_dir), reservation.reservation_id)
    existing = _read_existing_receipt(receipt_path, reservation)
    if existing is not None and execute:
        return existing
    observation = _observe_blob(client, reservation.target)
    if not execute:
        return {
            "schemaVersion": 1,
            "kind": "opencfd2606-canary-gcs-cleanup-dry-run",
            "reservationId": reservation.reservation_id,
            "attestationId": reservation.attestation_id,
            "target": reservation.target.to_dict(),
            "status": "eligible" if observation is not None else "already_absent",
        }

    if observation is None:
        pre_delete: dict[str, object] = {"status": "absent"}
        outcome = "already_absent_after_reservation"
    else:
        blob, pre_delete = observation
        try:
            blob.delete(
                if_generation_match=int(reservation.target.generation),
                timeout=900,
            )
        except Exception as exc:  # noqa: BLE001
            raise CanaryCleanupError(
                f"generation-matched delete failed for gs://"
                f"{reservation.target.bucket}/{reservation.target.object_key}#"
                f"{reservation.target.generation}: {exc}"
            ) from exc
        if _observe_blob(client, reservation.target) is not None:
            raise CanaryCleanupError(
                f"generation remains live after generation-matched delete for gs://"
                f"{reservation.target.bucket}/{reservation.target.object_key}#"
                f"{reservation.target.generation}"
            )
        outcome = "deleted"

    deleted_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).isoformat()
    receipt: dict[str, object] = {
        "schemaVersion": 1,
        "kind": RECEIPT_KIND,
        "reservationId": reservation.reservation_id,
        "attestationId": reservation.attestation_id,
        "target": reservation.target.to_dict(),
        "preDeleteObservation": pre_delete,
        "postDeleteObservation": {"status": "absent"},
        "outcome": outcome,
        "deletedAt": deleted_at,
        "operator": operator_name,
    }
    _write_immutable_receipt(receipt_path, receipt)
    return receipt


def load_reservations(path: Path) -> list[object]:
    rows: list[object] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise CanaryCleanupError(
                f"reservation line {line_number} is invalid JSON: {exc}"
            ) from exc
    if not rows:
        raise CanaryCleanupError("reservation file is empty")
    return rows


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Delete exact zero-owner canary GCS generations (dry-run by default)."
    )
    parser.add_argument("--reservation-file", type=Path, required=True)
    parser.add_argument("--receipt-dir", type=Path, required=True)
    parser.add_argument("--operator", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args(argv)
    try:
        from google.cloud import storage

        client = storage.Client()
        for reservation in load_reservations(args.reservation_file):
            result = cleanup_reservation(
                reservation,
                client=client,
                receipt_dir=args.receipt_dir,
                operator=args.operator,
                execute=args.execute,
            )
            sys.stdout.write(_canonical_json(result) + "\n")
        return 0
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"canary evidence cleanup refused: {exc}\n")
        return 1


if __name__ == "__main__":  # pragma: no cover - exercised through functions
    raise SystemExit(main())
