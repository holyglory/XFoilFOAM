from __future__ import annotations

import hashlib
import json
import stat
from datetime import datetime, timezone
from pathlib import Path

import pytest

from airfoilfoam.canary_evidence_cleanup import (
    CanaryCleanupError,
    cleanup_reservation,
    parse_reservation,
)


SHA = "a" * 64
KEY = f"solver-evidence/v1/sha256/aa/{SHA}.tar.zst"
GENERATION = "18446744073709551615"
SIZE = 456_789
CRC32C = "AAAAAA=="


class NotFound(Exception):
    code = 404


class FakeBlob:
    def __init__(self) -> None:
        self.present = True
        self.generation = GENERATION
        self.size = SIZE
        self.crc32c = CRC32C
        self.metadata = {"stored-sha256": SHA, "stored-size": str(SIZE)}
        self.reload_calls: list[dict[str, object]] = []
        self.delete_calls: list[dict[str, object]] = []
        self.delete_error: Exception | None = None
        self.delete_keeps_generation_live = False

    def reload(self, **kwargs: object) -> None:
        self.reload_calls.append(kwargs)
        if not self.present:
            raise NotFound("absent")

    def delete(self, **kwargs: object) -> None:
        self.delete_calls.append(kwargs)
        if self.delete_error is not None:
            raise self.delete_error
        if not self.present:
            raise NotFound("absent")
        if not self.delete_keeps_generation_live:
            self.present = False


class FakeBucket:
    def __init__(self, blob: FakeBlob) -> None:
        self._blob = blob
        self.calls: list[tuple[str, int]] = []

    def blob(self, name: str, *, generation: int) -> FakeBlob:
        self.calls.append((name, generation))
        return self._blob


class FakeClient:
    def __init__(self, blob: FakeBlob) -> None:
        self._bucket = FakeBucket(blob)
        self.bucket_calls: list[str] = []

    def bucket(self, name: str) -> FakeBucket:
        self.bucket_calls.append(name)
        return self._bucket


def _receipt() -> dict[str, object]:
    storage = {
        "backend": "gcs",
        "bucket": "airfoils-pro-storage-bucket",
        "object_key": KEY,
        "generation": GENERATION,
        "stored_sha256": SHA,
        "stored_byte_size": SIZE,
        "crc32c": CRC32C,
    }
    return {
        "schema_version": 1,
        "status": "ok",
        "engine": {
            "family": "openfoam",
            "distribution": "opencfd",
            "version": "2606",
        },
        "evidence_storage": {
            "backend": "gcs",
            "bucket": "airfoils-pro-storage-bucket",
            "object_prefix": "solver-evidence/v1",
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "local_disposition": "remote-only",
        },
        "jobs": [
            {
                "points": [
                    {
                        "artifacts": [
                            {
                                "kind": "engine_bundle",
                                "sha256": SHA,
                                "byte_size": SIZE,
                                "storage": storage,
                            },
                            {
                                "kind": "manifest",
                                "sha256": "b" * 64,
                                "byte_size": 31,
                                "storage": storage,
                            },
                        ]
                    }
                ]
            }
        ],
    }


def _reservation() -> dict[str, object]:
    canonical = json.dumps(
        _receipt(), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return {
        "schemaVersion": 1,
        "kind": "opencfd2606-canary-gcs-cleanup-reservation",
        "reservationId": "11111111-1111-4111-8111-111111111111",
        "reservedAt": "2026-07-18T18:00:00.000Z",
        "reservedBy": "operator@example.test",
        "attestation": {
            "id": "22222222-2222-4222-8222-222222222222",
            "receiptSha256": hashlib.sha256(canonical.encode()).hexdigest(),
            "canonicalReceipt": canonical,
        },
        "target": {
            "bucket": "airfoils-pro-storage-bucket",
            "objectKey": KEY,
            "generation": GENERATION,
            "sha256": SHA,
            "byteSize": SIZE,
            "crc32c": CRC32C,
        },
        "ownershipAtReservation": {
            "blobCount": 0,
            "artifactCount": 0,
            "archiveCount": 0,
            "orphanQuarantineCount": 0,
            "incompleteQuarantineCount": 0,
        },
    }


def test_dry_run_is_default_and_never_deletes_or_lists(tmp_path: Path) -> None:
    blob = FakeBlob()
    client = FakeClient(blob)
    result = cleanup_reservation(
        _reservation(),
        client=client,
        receipt_dir=tmp_path,
        operator="operator@example.test",
    )
    assert result["status"] == "eligible"
    assert blob.delete_calls == []
    assert client.bucket_calls == ["airfoils-pro-storage-bucket"]
    assert client._bucket.calls == [(KEY, int(GENERATION))]
    assert list(tmp_path.iterdir()) == []


def test_execute_uses_generation_match_and_replays_immutable_receipt(
    tmp_path: Path,
) -> None:
    blob = FakeBlob()
    client = FakeClient(blob)
    fixed = datetime(2026, 7, 18, 18, 30, tzinfo=timezone.utc)
    first = cleanup_reservation(
        _reservation(),
        client=client,
        receipt_dir=tmp_path,
        operator="operator@example.test",
        execute=True,
        now=fixed,
    )
    assert first["outcome"] == "deleted"
    assert first["postDeleteObservation"] == {"status": "absent"}
    assert blob.delete_calls == [
        {"if_generation_match": int(GENERATION), "timeout": 900}
    ]
    assert blob.reload_calls == [
        {"if_generation_match": int(GENERATION), "timeout": 900},
        {"if_generation_match": int(GENERATION), "timeout": 900},
    ]
    receipt_path = tmp_path / "11111111-1111-4111-8111-111111111111.json"
    assert stat.S_IMODE(receipt_path.stat().st_mode) == 0o600
    reload_count = len(blob.reload_calls)
    second = cleanup_reservation(
        _reservation(),
        client=client,
        receipt_dir=tmp_path,
        operator="operator@example.test",
        execute=True,
    )
    assert second == first
    assert len(blob.reload_calls) == reload_count
    assert len(blob.delete_calls) == 1
    dry_after_receipt = cleanup_reservation(
        _reservation(),
        client=client,
        receipt_dir=tmp_path,
        operator="operator@example.test",
    )
    assert dry_after_receipt["status"] == "already_absent"
    assert len(blob.reload_calls) == reload_count + 1
    assert len(blob.delete_calls) == 1


def test_absent_reserved_generation_gets_truthful_idempotent_receipt(
    tmp_path: Path,
) -> None:
    blob = FakeBlob()
    blob.present = False
    result = cleanup_reservation(
        _reservation(),
        client=FakeClient(blob),
        receipt_dir=tmp_path,
        operator="operator@example.test",
        execute=True,
    )
    assert result["outcome"] == "already_absent_after_reservation"
    assert result["preDeleteObservation"] == {"status": "absent"}
    assert result["postDeleteObservation"] == {"status": "absent"}
    assert blob.delete_calls == []


def test_disappearance_between_observation_and_delete_is_not_claimed(
    tmp_path: Path,
) -> None:
    blob = FakeBlob()
    blob.delete_error = NotFound("concurrent deletion")
    with pytest.raises(CanaryCleanupError, match="generation-matched delete failed"):
        cleanup_reservation(
            _reservation(),
            client=FakeClient(blob),
            receipt_dir=tmp_path,
            operator="operator@example.test",
            execute=True,
        )
    assert list(tmp_path.iterdir()) == []


def test_successful_delete_response_without_pinned_absence_is_not_claimed(
    tmp_path: Path,
) -> None:
    blob = FakeBlob()
    blob.delete_keeps_generation_live = True
    with pytest.raises(CanaryCleanupError, match="generation remains live"):
        cleanup_reservation(
            _reservation(),
            client=FakeClient(blob),
            receipt_dir=tmp_path,
            operator="operator@example.test",
            execute=True,
        )
    assert len(blob.delete_calls) == 1
    assert len(blob.reload_calls) == 2
    assert list(tmp_path.iterdir()) == []


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("generation", int(GENERATION)),
        ("byteSize", str(SIZE)),
        ("byteSize", True),
        ("sha256", "A" * 64),
        ("crc32c", "invalid"),
        ("objectKey", "solver-evidence/v1/../escape.tar.zst"),
    ],
)
def test_reservation_identity_rejects_wrong_json_types_and_values(
    field: str, value: object
) -> None:
    reservation = _reservation()
    reservation["target"][field] = value  # type: ignore[index]
    with pytest.raises(CanaryCleanupError):
        parse_reservation(reservation)


def test_attestation_mismatch_or_digest_mismatch_refuses_before_gcs(
    tmp_path: Path,
) -> None:
    for mutate in ("target", "digest"):
        reservation = _reservation()
        if mutate == "target":
            reservation["target"]["sha256"] = "c" * 64  # type: ignore[index]
        else:
            reservation["attestation"]["receiptSha256"] = "d" * 64  # type: ignore[index]
        client = FakeClient(FakeBlob())
        with pytest.raises(CanaryCleanupError):
            cleanup_reservation(
                reservation,
                client=client,
                receipt_dir=tmp_path,
                operator="operator@example.test",
            )
        assert client.bucket_calls == []


@pytest.mark.parametrize("field", ["generation", "size", "sha256", "crc32c"])
def test_live_gcs_metadata_mismatch_refuses_delete(field: str, tmp_path: Path) -> None:
    blob = FakeBlob()
    if field == "generation":
        blob.generation = "9"
    elif field == "size":
        blob.size = SIZE + 1
    elif field == "sha256":
        blob.metadata["stored-sha256"] = "b" * 64
    else:
        blob.crc32c = "BBBBBB=="
    with pytest.raises(CanaryCleanupError):
        cleanup_reservation(
            _reservation(),
            client=FakeClient(blob),
            receipt_dir=tmp_path,
            operator="operator@example.test",
            execute=True,
        )
    assert blob.delete_calls == []


def test_immutable_receipt_conflict_refuses_rewrite(tmp_path: Path) -> None:
    receipt_path = tmp_path / "11111111-1111-4111-8111-111111111111.json"
    receipt_path.write_text('{"not":"the receipt"}\n', encoding="utf-8")
    with pytest.raises(CanaryCleanupError):
        cleanup_reservation(
            _reservation(),
            client=FakeClient(FakeBlob()),
            receipt_dir=tmp_path,
            operator="operator@example.test",
            execute=True,
        )
