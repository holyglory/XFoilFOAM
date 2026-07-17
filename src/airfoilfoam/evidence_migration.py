"""Fail-closed migration of finalized solver evidence to immutable GCS tar.zst.

Dry-run is the default.  ``--execute`` acquires the same per-job advisory lock
as the solver/retention paths, requires a terminal job, uploads a
content-addressed archive, verifies a generation-pinned download and a real
restore, and writes an atomic receipt.  Every local packaged source remains
until a valid database-registration acknowledgement is present and a fresh
generation-pinned restore succeeds immediately before cleanup.
"""

from __future__ import annotations

import argparse
import fcntl
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator, Mapping, Sequence

from .config import Settings, get_settings
from .evidence_runtime import (
    EVIDENCE_ARCHIVE_NAME,
    EVIDENCE_POINTER_NAME,
    PACKAGED_RAW_DIRS,
    evidence_archive_path,
    evidence_object_store,
    evidence_pointer_path,
)
from .evidence_store import (
    ArchiveRecord,
    EvidenceHydrationError,
    EvidenceStoreError,
    RemoteEvidencePointer,
    inspect_tar_zst,
    manifest_bundle_member_set_sha256,
    read_remote_pointer,
    transcode_gzip_tar_to_zst,
)


RECEIPT_NAME = "storage_migration.json"
DATABASE_ACK_NAME = "storage_migration.database.json"
RECEIPT_SCHEMA_VERSION = 1
TERMINAL_STATES = {"completed", "failed", "cancelled"}
LEGACY_GZIP_NAMES = ("engine_evidence.tar.gz", "openfoam_evidence.tar.gz")
_BUFFER_SIZE = 1024 * 1024
_DISCOVERY_PRUNE_DIRS = {
    "VTK",
    "openfoam",
    "time_directories",
    "frames",
    "images",
    "scaled_media",
    "custom_renders",
    "constant",
    "system",
    "postProcessing",
    "dynamicCode",
}
_NUMERIC_TIME_DIR = re.compile(r"^-?(?:\d+(?:\.\d*)?|\.\d+)$")


class EvidenceMigrationError(RuntimeError):
    """A candidate could not be proven safe to migrate."""


@dataclass(frozen=True)
class MigrationTarget:
    job_root: Path
    evidence_dir: Path

    @property
    def job_id(self) -> str:
        return self.job_root.name

    @property
    def relative_evidence_path(self) -> str:
        return self.evidence_dir.relative_to(self.job_root).as_posix()


@dataclass(frozen=True)
class MigrationResult:
    job_id: str
    evidence_path: str
    status: str
    source_bytes: int = 0
    source_formats: tuple[str, ...] = ()
    source_paths: tuple[str, ...] = ()
    remote_bytes: int = 0
    bytes_deleted: int = 0
    object_uri: str | None = None
    generation: str | None = None
    verification: str | None = None
    message: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "jobId": self.job_id,
            "evidencePath": self.evidence_path,
            "status": self.status,
            "sourceBytes": self.source_bytes,
            "sourceFormats": list(self.source_formats),
            "sourcePaths": list(self.source_paths),
            "remoteBytes": self.remote_bytes,
            "bytesDeleted": self.bytes_deleted,
            "objectUri": self.object_uri,
            "generation": self.generation,
            "verification": self.verification,
            "message": self.message,
        }


def discover_targets(
    jobs_root: Path,
    *,
    job_ids: set[str] | None = None,
) -> Iterator[MigrationTarget]:
    """Yield terminal-job evidence directories with a local or remote bundle."""

    jobs_root = Path(jobs_root)
    if not jobs_root.is_dir():
        return
    if job_ids is None:
        job_roots = sorted(
            path
            for path in jobs_root.iterdir()
            if path.is_dir() and not path.is_symlink()
        )
    else:
        job_roots = []
        for job_id in sorted(job_ids):
            if (
                not job_id
                or job_id in {".", ".."}
                or Path(job_id).name != job_id
                or "/" in job_id
                or "\\" in job_id
            ):
                raise EvidenceMigrationError("job id must be one safe path segment")
            candidate = jobs_root / job_id
            if candidate.is_dir() and not candidate.is_symlink():
                job_roots.append(candidate)
    for job_root in job_roots:
        try:
            job_root.resolve(strict=True).relative_to(jobs_root.resolve(strict=True))
        except (OSError, ValueError):
            continue
        try:
            _require_terminal_job(job_root)
        except EvidenceMigrationError:
            continue
        cases_root = job_root / "cases"
        if not cases_root.is_dir():
            continue
        for root, dirnames, filenames in os.walk(cases_root, followlinks=False):
            current = Path(root)
            if current.name != "evidence":
                # Evidence directories are shallow metadata siblings of very
                # large solver trees.  Never crawl copied VTK/OpenFOAM data,
                # processor partitions, or numeric time directories merely to
                # discover the archive that owns them.
                dirnames[:] = sorted(
                    name
                    for name in dirnames
                    if name not in _DISCOVERY_PRUNE_DIRS
                    and re.fullmatch(r"processor\d+", name) is None
                    and _NUMERIC_TIME_DIR.fullmatch(name) is None
                    and not (current / name).is_symlink()
                )
                continue
            dirnames[:] = []
            if current.is_symlink():
                continue
            names = set(filenames)
            if (
                EVIDENCE_ARCHIVE_NAME in names
                or EVIDENCE_POINTER_NAME in names
                or any(name in names for name in LEGACY_GZIP_NAMES)
            ):
                yield MigrationTarget(job_root=job_root, evidence_dir=current)


def plan_target(target: MigrationTarget) -> MigrationResult:
    sources = _source_archives(target.evidence_dir)
    source_bytes = sum(path.stat().st_size for path in sources)
    source_formats, source_paths = _source_result_fields(
        {
            "path": path.relative_to(target.evidence_dir).as_posix(),
            "compression": _source_compression(path),
        }
        for path in sources
    )
    pointer_path = evidence_pointer_path(target.evidence_dir)
    if not sources and not pointer_path.is_file():
        raise EvidenceMigrationError("candidate has neither a local archive nor a remote pointer")
    return MigrationResult(
        job_id=target.job_id,
        evidence_path=target.relative_evidence_path,
        status="planned",
        source_bytes=source_bytes,
        source_formats=source_formats,
        source_paths=source_paths,
        message=(
            "verified remote pointer will be rechecked before cleanup"
            if pointer_path.is_file()
            else "legacy archive will be transcoded and uploaded"
        ),
    )


def migrate_target(
    target: MigrationTarget,
    settings: Settings,
    *,
    store: Any | None = None,
) -> MigrationResult:
    """Migrate one evidence directory and remove local bytes only after proof."""

    store = store or evidence_object_store(settings)
    if store is None:
        raise EvidenceMigrationError("AIRFOILFOAM_EVIDENCE_BUCKET is required")
    if not settings.evidence_remote_only:
        raise EvidenceMigrationError(
            "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true is required for destructive migration"
        )
    _require_contained_target(target)
    with _job_guard(target.job_root):
        _require_terminal_job(target.job_root)
        evidence_dir = target.evidence_dir
        manifest_path = evidence_dir / "evidence_manifest.json"
        manifest = _read_manifest(manifest_path)
        pointer_path = evidence_pointer_path(evidence_dir)
        receipt_path = evidence_dir / RECEIPT_NAME
        existing_receipt = _read_optional_json(receipt_path)
        if (
            existing_receipt
            and existing_receipt.get("state") == "complete"
            and pointer_path.is_file()
            and not _has_local_packaged_bytes(evidence_dir)
        ):
            pointer = read_remote_pointer(pointer_path)
            source_formats, source_paths = _source_result_fields(
                existing_receipt.get("sourceArchives", [])
            )
            try:
                # A local receipt is not proof that its generation remains
                # available.  Reconcile against GCS on every idempotent
                # completed-target pass without downloading the full archive.
                store.verify_remote_pointer(pointer)
            except (EvidenceStoreError, OSError, ValueError) as exc:
                raise EvidenceMigrationError(
                    f"completed migration remote verification failed: {exc}"
                ) from exc
            return _result_from_pointer(
                target,
                pointer,
                status="already-complete",
                verification="remote-metadata",
                source_formats=source_formats,
                source_paths=source_paths,
            )
        if (
            existing_receipt
            and existing_receipt.get("state") == "awaiting_database_registration"
            and pointer_path.is_file()
        ):
            pointer = read_remote_pointer(pointer_path)
            source_formats, source_paths = _source_result_fields(
                existing_receipt.get("sourceArchives", [])
            )
            ack = _read_optional_json(evidence_dir / DATABASE_ACK_NAME)
            if ack is None:
                return _result_from_pointer(
                    target,
                    pointer,
                    status="awaiting-database-registration",
                    verification=str(existing_receipt.get("verificationMode") or "receipt"),
                    source_formats=source_formats,
                    source_paths=source_paths,
                )
            _validate_database_ack(
                ack,
                target,
                pointer,
                manifest_path=manifest_path,
                receipt_path=receipt_path,
            )
            verification_mode = _verify_remote_restore(
                store,
                pointer,
                manifest_path,
                manifest,
                fresh_download=True,
            )
            deleted_paths = _existing_packaged_paths(evidence_dir)
            bytes_before = sum(_tree_size(path) for path in deleted_paths)
            for path in deleted_paths:
                _remove_path(path)
            bytes_deleted = max(
                0,
                bytes_before - sum(_tree_size(path) for path in deleted_paths),
            )
            acknowledgement_fields: dict[str, Any] = {
                "databaseAcknowledgement": ack,
            }
            if ack.get("state") == "quarantined":
                acknowledgement_fields["databaseQuarantine"] = ack
            else:
                acknowledgement_fields["databaseRegistration"] = ack
            existing_receipt.update(
                {
                    "state": "complete",
                    "completedAt": datetime.now(timezone.utc).isoformat(),
                    **acknowledgement_fields,
                    "verificationMode": verification_mode,
                    "deletedPaths": sorted(
                        set(existing_receipt.get("deletedPaths", []))
                        | {
                            path.relative_to(evidence_dir).as_posix()
                            for path in deleted_paths
                        }
                    ),
                    "bytesDeleted": int(existing_receipt.get("bytesDeleted", 0))
                    + bytes_deleted,
                }
            )
            _atomic_write_json(receipt_path, existing_receipt)
            return MigrationResult(
                job_id=target.job_id,
                evidence_path=target.relative_evidence_path,
                status="migrated",
                source_formats=source_formats,
                source_paths=source_paths,
                remote_bytes=pointer.stored_size,
                bytes_deleted=bytes_deleted,
                object_uri=f"gs://{pointer.bucket}/{pointer.object_key}",
                generation=str(pointer.generation),
                verification=verification_mode,
            )

        source_infos = _source_archive_infos(evidence_dir)
        source_formats, source_paths = _source_result_fields(source_infos)
        record = _prepare_archive(evidence_dir, settings, source_infos)
        pointer: RemoteEvidencePointer
        if pointer_path.is_file():
            pointer = read_remote_pointer(pointer_path)
            if record is not None:
                _require_record_matches_pointer(record, pointer)
        else:
            if record is None:
                raise EvidenceMigrationError(
                    "local archives disappeared before a verified pointer was written"
                )
            try:
                pointer = store.upload_archive(record, pointer_path)
            except (EvidenceStoreError, OSError) as exc:
                raise EvidenceMigrationError(f"remote upload failed: {exc}") from exc

        for info in source_infos:
            if info.get("compression") == "gzip":
                info["uncompressedTarSha256"] = pointer.tar_sha256
                info["uncompressedTarByteSize"] = pointer.tar_size

        verification_mode = _verify_remote_restore(
            store,
            pointer,
            manifest_path,
            manifest,
        )
        if record is None:
            record = ArchiveRecord(
                path=evidence_archive_path(evidence_dir),
                stored_sha256=pointer.stored_sha256,
                stored_size=pointer.stored_size,
                tar_sha256=pointer.tar_sha256,
                tar_size=pointer.tar_size,
                zstd_level=pointer.zstd_level,
            )

        now = datetime.now(timezone.utc).isoformat()
        receipt: dict[str, Any] = {
            "schemaVersion": RECEIPT_SCHEMA_VERSION,
            "state": "awaiting_database_registration",
            "jobId": target.job_id,
            "evidencePath": target.relative_evidence_path,
            "sourceArchives": (
                source_infos
                or (
                    list(existing_receipt.get("sourceArchives", []))
                    if existing_receipt
                    else []
                )
            ),
            "archive": {
                "storedSha256": pointer.stored_sha256,
                "storedByteSize": pointer.stored_size,
                "uncompressedTarSha256": pointer.tar_sha256,
                "uncompressedTarByteSize": pointer.tar_size,
                "zstdLevel": pointer.zstd_level,
            },
            "remote": pointer.to_dict(),
            "verificationMode": verification_mode,
            "verifiedAt": now,
            "deletedPaths": [],
            "bytesDeleted": 0,
        }
        _atomic_write_json(receipt_path, receipt)
        return MigrationResult(
            job_id=target.job_id,
            evidence_path=target.relative_evidence_path,
            status="awaiting-database-registration",
            source_bytes=sum(int(info["byteSize"]) for info in source_infos),
            source_formats=source_formats,
            source_paths=source_paths,
            remote_bytes=pointer.stored_size,
            bytes_deleted=0,
            object_uri=f"gs://{pointer.bucket}/{pointer.object_key}",
            generation=str(pointer.generation),
            verification=verification_mode,
        )


def run_migration(
    settings: Settings,
    *,
    jobs_root: Path | None = None,
    execute: bool = False,
    limit: int | None = None,
    job_ids: set[str] | None = None,
    continue_on_error: bool = False,
) -> list[MigrationResult]:
    root = Path(jobs_root) if jobs_root is not None else settings.data_dir / "jobs"
    results: list[MigrationResult] = []
    for target in discover_targets(root, job_ids=job_ids):
        if limit is not None and len(results) >= limit:
            break
        try:
            result = migrate_target(target, settings) if execute else plan_target(target)
        except Exception as exc:  # noqa: BLE001 - each failure is an explicit result
            result = MigrationResult(
                job_id=target.job_id,
                evidence_path=target.relative_evidence_path,
                status="failed",
                message=str(exc),
            )
            results.append(result)
            if not continue_on_error:
                break
            continue
        results.append(result)
    return results


def _prepare_archive(
    evidence_dir: Path,
    settings: Settings,
    source_infos: Sequence[Mapping[str, Any]],
) -> ArchiveRecord | None:
    canonical = evidence_archive_path(evidence_dir)
    gzip_paths = [
        evidence_dir / str(info["path"])
        for info in source_infos
        if info.get("compression") == "gzip"
    ]
    record = (
        inspect_tar_zst(canonical, level=settings.evidence_zstd_level)
        if canonical.is_file()
        else None
    )
    transcoded_from: Path | None = None
    if record is None and gzip_paths:
        transcoded_from = gzip_paths[0]
        record = transcode_gzip_tar_to_zst(
            transcoded_from,
            canonical,
            level=settings.evidence_zstd_level,
        )
    if record is None:
        return None
    for source in gzip_paths:
        if source == transcoded_from:
            continue
        tar_size, tar_sha256 = _gzip_tar_digest(source)
        if (tar_size, tar_sha256) != (record.tar_size, record.tar_sha256):
            raise EvidenceMigrationError(
                f"legacy archive {source.name} does not contain the canonical tar stream"
            )
    return record


def _verify_remote_restore(
    store: Any,
    pointer: RemoteEvidencePointer,
    local_manifest_path: Path,
    manifest: Mapping[str, Any],
    *,
    fresh_download: bool = False,
) -> str:
    try:
        # The database acknowledgement is the final destructive gate.  On
        # that pass, force a new generation-pinned download rather than
        # trusting the cache populated during upload.  In both modes read and
        # authenticate EVERY manifest-listed member; VTK-only verification can
        # otherwise delete the sole good copy of logs, dictionaries, mesh, or
        # force/time evidence omitted by a malformed legacy archive.
        member_count = store.verify_all_manifest_members(
            pointer,
            expected_manifest=local_manifest_path.read_bytes(),
            fresh_download=fresh_download,
        )
        return f"archive+manifest+all-members-restore:{member_count}"
    except (EvidenceStoreError, OSError, ValueError) as exc:
        raise EvidenceMigrationError(f"remote restore verification failed: {exc}") from exc


def _require_contained_target(target: MigrationTarget) -> None:
    """Reject symlinked or escaping paths before taking a lock or deleting."""

    job_root = Path(target.job_root)
    evidence_dir = Path(target.evidence_dir)
    if job_root.is_symlink() or evidence_dir.is_symlink():
        raise EvidenceMigrationError("migration target must not be a symlink")
    try:
        resolved_job = job_root.resolve(strict=True)
        resolved_evidence = evidence_dir.resolve(strict=True)
        relative = evidence_dir.relative_to(job_root)
        resolved_evidence.relative_to(resolved_job)
    except (OSError, ValueError) as exc:
        raise EvidenceMigrationError(
            "migration evidence path must stay inside its job root"
        ) from exc
    current = job_root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise EvidenceMigrationError(
                "migration evidence path must not traverse a symlink"
            )


def _require_record_matches_pointer(
    record: ArchiveRecord,
    pointer: RemoteEvidencePointer,
) -> None:
    if (
        record.stored_sha256 != pointer.stored_sha256
        or record.stored_size != pointer.stored_size
        or record.tar_sha256 != pointer.tar_sha256
        or record.tar_size != pointer.tar_size
    ):
        raise EvidenceMigrationError("local/downloaded archive does not match remote pointer")


def _source_archives(evidence_dir: Path) -> list[Path]:
    paths = [evidence_archive_path(evidence_dir)]
    paths.extend(evidence_dir / name for name in LEGACY_GZIP_NAMES)
    return [path for path in paths if path.is_file() and not path.is_symlink()]


def _source_archive_infos(evidence_dir: Path) -> list[dict[str, Any]]:
    infos: list[dict[str, Any]] = []
    for path in _source_archives(evidence_dir):
        size, sha256 = _file_size_sha256(path)
        compression = _source_compression(path)
        info: dict[str, Any] = {
            "path": path.name,
            "compression": compression,
            "sha256": sha256,
            "byteSize": size,
        }
        infos.append(info)
    return infos


def _source_compression(path: Path) -> str:
    return "zstd" if path.name.endswith(".zst") else "gzip"


def _source_result_fields(
    source_archives: Iterable[Mapping[str, Any]],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Return ordered, parallel source metadata for operator audit output."""

    formats: list[str] = []
    paths: list[str] = []
    for source in source_archives:
        compression = source.get("compression")
        path = source.get("path")
        if isinstance(compression, str) and isinstance(path, str):
            formats.append(compression)
            paths.append(path)
    return tuple(formats), tuple(paths)


def _read_manifest(path: Path) -> Mapping[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise EvidenceMigrationError(f"cannot read evidence manifest: {exc}") from exc
    if not isinstance(payload, Mapping) or not isinstance(payload.get("files"), list):
        raise EvidenceMigrationError("evidence manifest has no files list")
    return payload


def _require_terminal_job(job_root: Path) -> None:
    status = _read_optional_json(job_root / "status.json")
    state = status.get("state") if status else None
    if state not in TERMINAL_STATES:
        raise EvidenceMigrationError(f"job state is {state!r}, not terminal")
    result_path = job_root / "result.json"
    if result_path.exists():
        result = _read_optional_json(result_path)
        result_state = result.get("state") if result else None
        if result_state not in TERMINAL_STATES:
            raise EvidenceMigrationError(
                f"result state is {result_state!r}, not terminal"
            )


@contextmanager
def _job_guard(job_root: Path) -> Iterator[None]:
    lock_path = job_root / ".execute.lock"
    try:
        lock_file = lock_path.open("a+")
    except OSError as exc:
        raise EvidenceMigrationError(f"cannot open execution lock: {exc}") from exc
    try:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise EvidenceMigrationError("execution lock is held; job is active") from exc
        yield
    finally:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            lock_file.close()


def _has_local_packaged_bytes(evidence_dir: Path) -> bool:
    return any(path.exists() or path.is_symlink() for path in _existing_packaged_paths(evidence_dir))


def _existing_packaged_paths(evidence_dir: Path) -> list[Path]:
    names = [*PACKAGED_RAW_DIRS, EVIDENCE_ARCHIVE_NAME, *LEGACY_GZIP_NAMES]
    return [
        evidence_dir / name
        for name in names
        if (evidence_dir / name).exists() or (evidence_dir / name).is_symlink()
    ]


def _validate_database_ack(
    ack: Mapping[str, Any],
    target: MigrationTarget,
    pointer: RemoteEvidencePointer,
    *,
    manifest_path: Path,
    receipt_path: Path,
) -> None:
    expected = {
        "schemaVersion": RECEIPT_SCHEMA_VERSION,
        "jobId": target.job_id,
        "evidencePath": target.relative_evidence_path,
        "storedSha256": pointer.stored_sha256,
        "generation": str(pointer.generation),
    }
    for key, value in expected.items():
        if ack.get(key) != value:
            raise EvidenceMigrationError(
                f"database registration acknowledgement mismatch for {key}"
            )
    state = ack.get("state")
    if state == "registered":
        required_identity = (
            "resultId",
            "resultAttemptId",
            "sourceArtifactId",
            "archiveId",
        )
        timestamp_key = "registeredAt"
    elif state == "quarantined":
        if ack.get("registrationKind") != "orphan_evidence_quarantine":
            raise EvidenceMigrationError(
                "orphan database acknowledgement has the wrong registrationKind"
            )
        if ack.get("quarantineReason") != "terminal_engine_evidence_not_ingested":
            raise EvidenceMigrationError(
                "orphan database acknowledgement has the wrong quarantineReason"
            )
        if any(
            ack.get(key) is not None
            for key in ("resultId", "resultAttemptId", "archiveId")
        ):
            raise EvidenceMigrationError(
                "orphan database acknowledgement must not claim result ownership"
            )
        required_identity = (
            "quarantineId",
            "sourceArtifactId",
            "blobId",
        )
        timestamp_key = "quarantinedAt"

        manifest_bytes = manifest_path.read_bytes()
        manifest_member_count, manifest_member_set_sha256 = (
            manifest_bundle_member_set_sha256(manifest_bytes)
        )
        receipt_bytes = receipt_path.read_bytes()
        orphan_expected = {
            "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "manifestByteSize": len(manifest_bytes),
            "archiveMemberSetSha256": manifest_member_set_sha256,
            "archiveMemberCount": manifest_member_count,
            "migrationReceiptSha256": hashlib.sha256(receipt_bytes).hexdigest(),
            "migrationReceiptByteSize": len(receipt_bytes),
        }
        for key, value in orphan_expected.items():
            if ack.get(key) != value:
                raise EvidenceMigrationError(
                    f"orphan database acknowledgement mismatch for {key}"
                )
    else:
        raise EvidenceMigrationError(
            "database acknowledgement state must be registered or quarantined"
        )

    for key in required_identity:
        value = ack.get(key)
        if not isinstance(value, str) or not value.strip():
            raise EvidenceMigrationError(
                f"database registration acknowledgement lacks {key}"
            )
    acknowledged_at = ack.get(timestamp_key)
    if not isinstance(acknowledged_at, str) or acknowledged_at != acknowledged_at.strip():
        raise EvidenceMigrationError(
            f"database registration acknowledgement lacks a valid UTC {timestamp_key}"
        )
    try:
        # ``Date.toISOString()`` (the registration writer) uses ``Z`` while
        # Python's canonical UTC spelling is ``+00:00``.  Accept both ISO-8601
        # forms, but not a date-only/naive timestamp or a non-UTC offset: local
        # evidence deletion is permitted only after an attributable database
        # registration event.
        iso_value = (
            acknowledged_at[:-1] + "+00:00"
            if acknowledged_at.endswith("Z")
            else acknowledged_at
        )
        parsed_acknowledged_at = datetime.fromisoformat(iso_value)
    except ValueError as exc:
        raise EvidenceMigrationError(
            f"database registration acknowledgement has an invalid {timestamp_key}"
        ) from exc
    if (
        "T" not in acknowledged_at
        or parsed_acknowledged_at.tzinfo is None
        or parsed_acknowledged_at.utcoffset() != timedelta(0)
    ):
        raise EvidenceMigrationError(
            f"database registration acknowledgement {timestamp_key} must be UTC ISO-8601"
        )


def _result_from_pointer(
    target: MigrationTarget,
    pointer: RemoteEvidencePointer,
    *,
    status: str,
    verification: str,
    source_formats: tuple[str, ...] = (),
    source_paths: tuple[str, ...] = (),
) -> MigrationResult:
    return MigrationResult(
        job_id=target.job_id,
        evidence_path=target.relative_evidence_path,
        status=status,
        source_formats=source_formats,
        source_paths=source_paths,
        remote_bytes=pointer.stored_size,
        object_uri=f"gs://{pointer.bucket}/{pointer.object_key}",
        generation=str(pointer.generation),
        verification=verification,
    )


def _read_optional_json(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise EvidenceMigrationError(f"cannot read {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise EvidenceMigrationError(f"{path} is not a JSON object")
    return payload


def _gzip_tar_digest(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    try:
        with gzip.open(path, "rb") as source:
            while chunk := source.read(_BUFFER_SIZE):
                digest.update(chunk)
                size += len(chunk)
    except Exception as exc:  # noqa: BLE001
        raise EvidenceMigrationError(f"cannot read legacy gzip archive {path}: {exc}") from exc
    return size, digest.hexdigest()


def _file_size_sha256(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as source:
        while chunk := source.read(_BUFFER_SIZE):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _tree_size(path: Path) -> int:
    if not path.exists() and not path.is_symlink():
        return 0
    if path.is_symlink() or path.is_file():
        return path.lstat().st_size
    total = 0
    for root, dirnames, filenames in os.walk(path, followlinks=False):
        dirnames[:] = [
            name for name in dirnames if not (Path(root) / name).is_symlink()
        ]
        for name in filenames:
            child = Path(root) / name
            if child.is_file() and not child.is_symlink():
                total += child.stat().st_size
    return total


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as output:
            json.dump(payload, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _parse_args(argv: Sequence[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--execute",
        action="store_true",
        help="upload and verify; remove local packages only after database acknowledgement",
    )
    parser.add_argument("--jobs-root", type=Path, help="override <data-dir>/jobs")
    parser.add_argument("--job-id", action="append", dest="job_ids", help="limit to one job id (repeatable)")
    parser.add_argument("--limit", type=int, help="maximum evidence directories to process")
    parser.add_argument("--continue-on-error", action="store_true")
    parser.add_argument("--jsonl", type=Path, help="also append one JSON result per line")
    args = parser.parse_args(argv)
    if args.limit is not None and args.limit <= 0:
        parser.error("--limit must be positive")
    return args


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    results = run_migration(
        get_settings(),
        jobs_root=args.jobs_root,
        execute=args.execute,
        limit=args.limit,
        job_ids=set(args.job_ids) if args.job_ids else None,
        continue_on_error=args.continue_on_error,
    )
    jsonl = args.jsonl.open("a", encoding="utf-8") if args.jsonl else None
    try:
        for result in results:
            line = json.dumps(result.to_dict(), sort_keys=True)
            print(line)
            if jsonl:
                jsonl.write(line + "\n")
                jsonl.flush()
    finally:
        if jsonl:
            jsonl.close()
    summary = {
        "mode": "execute" if args.execute else "dry-run",
        "processed": len(results),
        "migrated": sum(result.status in {"migrated", "already-complete"} for result in results),
        "awaitingDatabase": sum(
            result.status == "awaiting-database-registration" for result in results
        ),
        "failed": sum(result.status == "failed" for result in results),
        "bytesDeleted": sum(result.bytes_deleted for result in results),
        "remoteBytes": sum(result.remote_bytes for result in results),
    }
    print(json.dumps({"summary": summary}, sort_keys=True), file=sys.stderr)
    return 1 if summary["failed"] else 0


if __name__ == "__main__":  # pragma: no cover - exercised through main tests
    raise SystemExit(main())


__all__ = [
    "EvidenceMigrationError",
    "MigrationResult",
    "MigrationTarget",
    "discover_targets",
    "main",
    "migrate_target",
    "plan_target",
    "run_migration",
]
