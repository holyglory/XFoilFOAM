"""Runtime wiring for immutable evidence archives.

The codec/object-store implementation is intentionally independent of app
settings.  This module supplies the small shared policy used by the solver
worker, rendering API, retention pass, and migration CLI.
"""

from __future__ import annotations

import fcntl
import errno
import json
import os
import shutil
import stat
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Iterator

from .config import Settings
from .evidence_store import (
    ARCHIVE_MIME_TYPE,
    ArchiveRecord,
    EvidenceObjectStore,
    EvidenceHydrationError,
    EvidenceStoreError,
    RemoteEvidencePointer,
    create_tar_zst,
    inspect_tar_zst,
    manifest_bundle_member_set_sha256,
    read_remote_pointer,
)


EVIDENCE_ARCHIVE_NAME = "engine_evidence.tar.zst"
EVIDENCE_POINTER_NAME = "engine_evidence.remote.json"
EVIDENCE_FINALIZATION_ACK_NAME = "storage_finalization.database.json"
EVIDENCE_FINALIZATION_RECEIPT_NAME = "storage_finalization.json"
PACKAGED_RAW_DIRS = ("openfoam", "time_directories", "VTK")


class EvidenceCleanupError(RuntimeError):
    """Authenticated database-backed local evidence cleanup was refused."""


@dataclass(frozen=True)
class EvidenceDatabaseAssociation:
    result_id: str
    result_attempt_id: str
    source_artifact_id: str
    archive_id: str
    member_association_count: int
    member_associations_sha256: str
    manifest_member_set_sha256: str

    def to_dict(self) -> dict[str, str]:
        return {
            "resultId": self.result_id,
            "resultAttemptId": self.result_attempt_id,
            "sourceArtifactId": self.source_artifact_id,
            "archiveId": self.archive_id,
            "memberAssociationCount": self.member_association_count,
            "memberAssociationsSha256": self.member_associations_sha256,
            "manifestMemberSetSha256": self.manifest_member_set_sha256,
        }


@dataclass(frozen=True)
class EvidenceCleanupAuthorization:
    job_id: str
    case_slug: str
    evidence_base: str
    pointer: RemoteEvidencePointer
    associations: tuple[EvidenceDatabaseAssociation, ...]

    def to_dict(self) -> dict[str, Any]:
        associations = sorted(
            (association.to_dict() for association in self.associations),
            key=lambda item: (
                item["resultId"],
                item["resultAttemptId"],
                item["archiveId"],
                item["sourceArtifactId"],
            ),
        )
        return {
            "schemaVersion": 1,
            "jobId": self.job_id,
            "caseSlug": self.case_slug,
            "evidenceBase": self.evidence_base,
            "remote": self.pointer.to_dict(),
            "databaseAssociations": associations,
        }


@dataclass(frozen=True)
class EvidenceCleanupResult:
    state: str
    evidence_base: str
    bytes_freed: int
    verification: str
    association_count: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "evidence_base": self.evidence_base,
            "bytes_freed": self.bytes_freed,
            "verification": self.verification,
            "association_count": self.association_count,
        }


@dataclass(frozen=True)
class EvidencePublication:
    archive: ArchiveRecord
    pointer: RemoteEvidencePointer | None
    archive_path: Path
    pointer_path: Path

    @property
    def remote(self) -> bool:
        return self.pointer is not None

    def artifact_metadata(self) -> dict[str, object]:
        common: dict[str, object] = {
            "archiveFormat": self.archive.format,
            "compression": "zstd",
            "uncompressedTarSha256": self.archive.tar_sha256,
            "uncompressedTarByteSize": self.archive.tar_size,
            "zstdLevel": self.archive.zstd_level,
        }
        if self.pointer is None:
            return {**common, "storageBackend": "volume"}
        return {
            **common,
            "storageBackend": "gcs",
            "bucket": self.pointer.bucket,
            "objectKey": self.pointer.object_key,
            # GCS generations exceed JavaScript's safe integer range.  Keep the
            # exact decimal identity as a string across JSON and PostgreSQL.
            "generation": str(self.pointer.generation),
            "crc32c": self.pointer.crc32c,
            "verifiedAt": self.pointer.created_at,
            "pointerPath": self.pointer_path.name,
        }


def evidence_pointer_path(evidence_dir: Path) -> Path:
    return Path(evidence_dir) / EVIDENCE_POINTER_NAME


def evidence_archive_path(evidence_dir: Path) -> Path:
    return Path(evidence_dir) / EVIDENCE_ARCHIVE_NAME


def publish_evidence_directory(
    evidence_dir: Path,
    settings: Settings,
    *,
    exclude_names: tuple[str, ...] = ("frames",),
) -> EvidencePublication:
    """Create tar.zst and publish it when a bucket is configured.

    The local archive and raw members remain untouched on every exception.
    Callers may remove them only from a successfully returned remote
    publication.
    """

    publication = create_local_evidence_archive(
        evidence_dir,
        settings,
        exclude_names=exclude_names,
    )
    return publish_evidence_archive(publication, settings)


def create_local_evidence_archive(
    evidence_dir: Path,
    settings: Settings,
    *,
    exclude_names: tuple[str, ...] = ("frames",),
) -> EvidencePublication:
    """Create the canonical local archive without attempting object storage."""

    evidence_dir = Path(evidence_dir)
    archive_path = evidence_archive_path(evidence_dir)
    pointer_path = evidence_pointer_path(evidence_dir)
    archive = create_tar_zst(
        evidence_dir,
        archive_path,
        level=settings.evidence_zstd_level,
        exclude_names=(*exclude_names, EVIDENCE_POINTER_NAME),
    )
    return EvidencePublication(
        archive=archive,
        pointer=None,
        archive_path=archive_path,
        pointer_path=pointer_path,
    )


def publish_evidence_archive(
    publication: EvidencePublication,
    settings: Settings,
) -> EvidencePublication:
    """Publish an already-created archive, retaining it on every failure."""

    store = evidence_object_store(settings)
    if store is None:
        return publication
    pointer = store.upload_archive(publication.archive, publication.pointer_path)
    return EvidencePublication(
        archive=publication.archive,
        pointer=pointer,
        archive_path=publication.archive_path,
        pointer_path=publication.pointer_path,
    )


def remove_verified_local_packaged_evidence(
    evidence_dir: Path,
    publication: EvidencePublication,
) -> int:
    """Remove remote-backed package members and return logical bytes freed."""

    if publication.pointer is None or not publication.pointer_path.is_file():
        raise ValueError("verified remote pointer is required before local evidence removal")
    # Re-read the durable sidecar before deletion; a truncated or changed
    # pointer may never authorize removal.
    durable = read_remote_pointer(publication.pointer_path)
    if durable != publication.pointer:
        raise ValueError("durable evidence pointer does not match the verified upload")
    removed = 0
    for name in PACKAGED_RAW_DIRS:
        path = Path(evidence_dir) / name
        removed += _remove_path(path)
    removed += _remove_path(publication.archive_path)
    return removed


def remove_verified_local_raw_evidence(
    evidence_dir: Path,
    publication: EvidencePublication,
) -> int:
    """Remove duplicated unpacked evidence while retaining the full tar.zst.

    This pre-database-ack space reclamation is safe only because the complete
    authenticated local archive remains as a recovery source.  The later
    control-plane acknowledgement endpoint owns deletion of that archive.
    """

    if publication.pointer is None or not publication.pointer_path.is_file():
        raise ValueError("verified remote pointer is required before raw cleanup")
    durable = read_remote_pointer(publication.pointer_path)
    if durable != publication.pointer:
        raise ValueError("durable evidence pointer does not match the verified upload")
    restored_local = inspect_tar_zst(
        publication.archive_path,
        level=publication.archive.zstd_level,
    )
    if restored_local != publication.archive:
        raise ValueError("retained local evidence archive changed before raw cleanup")
    return sum(
        _remove_path(Path(evidence_dir) / name) for name in PACKAGED_RAW_DIRS
    )


def verify_remote_evidence_restore(
    evidence_dir: Path,
    publication: EvidencePublication,
    settings: Settings,
    *,
    store: EvidenceObjectStore | None = None,
) -> str:
    """Prove a pinned remote generation restores every bundled manifest member.

    This is the deletion authorization for newly finalized results.  Upload
    metadata, a pointer sidecar, and an object checksum are necessary but not
    sufficient: the exact generation must be downloaded, decompressed, its
    full uncompressed tar digest checked, and its manifest-backed render
    members restored before any packaged local source may be removed.
    """

    evidence_dir = Path(evidence_dir)
    if publication.pointer is None:
        raise EvidenceHydrationError("remote evidence pointer is required for restore proof")
    local_manifest = evidence_dir / "evidence_manifest.json"
    resolved_store = store or evidence_object_store(settings)
    if resolved_store is None:
        raise EvidenceHydrationError("remote evidence storage is not configured")
    member_count = resolved_store.verify_all_manifest_members(
        publication.pointer,
        expected_manifest=local_manifest.read_bytes(),
        fresh_download=True,
    )
    return f"archive+manifest+all-members-restore:{member_count}"


def finalize_remote_evidence_cleanup(
    job_root: Path,
    evidence_dir: Path,
    authorization: EvidenceCleanupAuthorization,
    settings: Settings,
    *,
    store: EvidenceObjectStore | None = None,
) -> EvidenceCleanupResult:
    """Delete local packaged bytes only after exact DB ack + fresh restore.

    The acknowledgement is written before deletion.  A crash after deletion
    but before the completion receipt is therefore recoverable: the exact
    authenticated replay performs another fresh restore, observes that no
    local bytes remain, and returns the typed ``no_local_bytes`` state.
    """

    if not authorization.associations:
        raise EvidenceCleanupError(
            "at least one durable database association is required"
        )
    association_identities = {
        (
            association.result_id,
            association.result_attempt_id,
            association.source_artifact_id,
            association.archive_id,
        )
        for association in authorization.associations
    }
    if len(association_identities) != len(authorization.associations):
        raise EvidenceCleanupError("duplicate database evidence association")
    job_root = Path(job_root)
    evidence_dir = Path(evidence_dir)
    _require_safe_cleanup_target(job_root, evidence_dir, authorization)
    resolved_store = store or evidence_object_store(settings)
    if resolved_store is None:
        raise EvidenceCleanupError("remote evidence storage is not configured")

    with _cleanup_job_guard(job_root):
        pointer_path = evidence_pointer_path(evidence_dir)
        try:
            durable_pointer = read_remote_pointer(pointer_path)
        except (OSError, ValueError, EvidenceStoreError) as exc:
            raise EvidenceCleanupError(
                f"durable remote evidence pointer is invalid: {exc}"
            ) from exc
        if durable_pointer != authorization.pointer:
            raise EvidenceCleanupError(
                "cleanup request does not match the durable remote evidence pointer"
            )

        local_manifest = evidence_dir / "evidence_manifest.json"
        if not local_manifest.is_file() or local_manifest.is_symlink():
            raise EvidenceCleanupError(
                "retained local evidence manifest is required for cleanup proof"
            )
        manifest_bytes = local_manifest.read_bytes()
        member_association_count, manifest_set_sha256 = (
            manifest_bundle_member_set_sha256(manifest_bytes)
        )
        for association in authorization.associations:
            if association.member_association_count != member_association_count:
                raise EvidenceCleanupError(
                    "database member association count does not match the retained manifest"
                )
            if association.manifest_member_set_sha256 != manifest_set_sha256:
                raise EvidenceCleanupError(
                    "database member set digest does not match the retained manifest"
                )
            if (
                len(association.member_associations_sha256) != 64
                or any(
                    character not in "0123456789abcdef"
                    for character in association.member_associations_sha256
                )
            ):
                raise EvidenceCleanupError(
                    "database member association digest is malformed"
                )

        canonical_authorization = authorization.to_dict()
        ack_path = evidence_dir / EVIDENCE_FINALIZATION_ACK_NAME
        existing_ack = _read_optional_json(ack_path)
        if existing_ack is not None:
            if existing_ack.get("authorization") != canonical_authorization:
                raise EvidenceCleanupError(
                    "existing database acknowledgement conflicts with cleanup request"
                )
        else:
            _atomic_write_json(
                ack_path,
                {
                    "schemaVersion": 1,
                    "state": "registered",
                    "authorization": canonical_authorization,
                    "registeredAt": datetime.now(timezone.utc).isoformat(),
                },
            )

        receipt_path = evidence_dir / EVIDENCE_FINALIZATION_RECEIPT_NAME
        previous_receipt = _read_optional_json(receipt_path)
        if (
            previous_receipt is not None
            and previous_receipt.get("authorization") != canonical_authorization
        ):
            raise EvidenceCleanupError(
                "existing cleanup receipt conflicts with cleanup request"
            )

        try:
            member_count = resolved_store.verify_all_manifest_members(
                durable_pointer,
                expected_manifest=manifest_bytes,
                fresh_download=True,
            )
        except (OSError, ValueError, EvidenceStoreError) as exc:
            raise EvidenceCleanupError(
                f"fresh exact-generation restore failed: {exc}"
            ) from exc
        verification = f"archive+manifest+all-members-restore:{member_count}"

        packaged_paths = [
            evidence_dir / name
            for name in (*PACKAGED_RAW_DIRS, EVIDENCE_ARCHIVE_NAME)
            if (evidence_dir / name).exists()
            or (evidence_dir / name).is_symlink()
        ]
        bytes_freed = sum(_remove_path(path) for path in packaged_paths)
        response_state = "complete" if packaged_paths else "no_local_bytes"
        _atomic_write_json(
            receipt_path,
            {
                "schemaVersion": 1,
                "state": "complete",
                "authorization": canonical_authorization,
                "verification": verification,
                "lastResponseState": response_state,
                "bytesDeleted": int(
                    (previous_receipt or {}).get("bytesDeleted", 0)
                )
                + bytes_freed,
                "completedAt": datetime.now(timezone.utc).isoformat(),
            },
        )
        return EvidenceCleanupResult(
            state=response_state,
            evidence_base=authorization.evidence_base,
            bytes_freed=bytes_freed,
            verification=verification,
            association_count=len(authorization.associations),
        )


@contextmanager
def hydrated_render_source(evidence_dir: Path, settings: Settings) -> Iterator[Path]:
    """Yield a verified temporary source directory containing ``VTK``."""

    pointer_path = evidence_pointer_path(evidence_dir)
    store = evidence_object_store(settings)
    if store is None:
        raise FileNotFoundError("remote evidence storage is not configured")
    if not pointer_path.is_file():
        raise FileNotFoundError(pointer_path)
    with store.render_source(pointer_path) as source:
        yield source


@lru_cache(maxsize=8)
def _cached_object_store(
    bucket: str,
    cache_root: str,
    object_prefix: str,
    cache_ttl_seconds: int,
    cache_max_bytes: int,
    timeout_seconds: int,
) -> EvidenceObjectStore:
    return EvidenceObjectStore(
        bucket,
        Path(cache_root),
        object_prefix=object_prefix,
        cache_ttl_seconds=cache_ttl_seconds,
        cache_max_bytes=cache_max_bytes,
        timeout_seconds=timeout_seconds,
    )


def evidence_object_store(settings: Settings) -> EvidenceObjectStore | None:
    bucket = (settings.evidence_bucket or "").strip()
    if not bucket:
        return None
    return _cached_object_store(
        bucket,
        str(settings.resolved_evidence_hydration_cache_dir()),
        settings.evidence_object_prefix,
        settings.evidence_hydration_cache_ttl_seconds,
        int(settings.evidence_hydration_cache_max_gb * 1024**3),
        settings.evidence_gcs_timeout_seconds,
    )


def _remove_path(path: Path) -> int:
    if not path.exists() and not path.is_symlink():
        return 0
    if path.is_symlink() or path.is_file():
        size = path.lstat().st_size
        path.unlink()
        return size
    size = sum(child.stat().st_size for child in path.rglob("*") if child.is_file())
    shutil.rmtree(path)
    return size


def _require_safe_cleanup_target(
    job_root: Path,
    evidence_dir: Path,
    authorization: EvidenceCleanupAuthorization,
) -> None:
    if job_root.is_symlink() or evidence_dir.is_symlink():
        raise EvidenceCleanupError("cleanup path must not be a symlink")
    try:
        resolved_job = job_root.resolve(strict=True)
        resolved_evidence = evidence_dir.resolve(strict=True)
        relative = evidence_dir.relative_to(job_root)
        resolved_evidence.relative_to(resolved_job)
    except (OSError, ValueError) as exc:
        raise EvidenceCleanupError(
            "cleanup evidence path must stay inside the job root"
        ) from exc
    expected = Path("cases") / authorization.case_slug / authorization.evidence_base
    if relative != expected:
        raise EvidenceCleanupError(
            "cleanup evidence path does not match caseSlug/evidenceBase"
        )
    current = job_root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise EvidenceCleanupError("cleanup path must not traverse a symlink")
    if authorization.job_id != job_root.name:
        raise EvidenceCleanupError("cleanup job id does not match job root")


@contextmanager
def _cleanup_job_guard(job_root: Path) -> Iterator[None]:
    lock_path = Path(job_root) / ".execute.lock"
    if lock_path.is_symlink():
        raise EvidenceCleanupError("job execution lock must not be a symlink")
    with lock_path.open("a+") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise EvidenceCleanupError(
                "job execution lock is held; cleanup will retry"
            ) from exc
        try:
            yield
        finally:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


def _read_optional_json(path: Path) -> dict[str, Any] | None:
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as exc:
        if exc.errno == errno.ENOENT:
            return None
        if exc.errno == errno.ELOOP:
            raise EvidenceCleanupError(
                f"cleanup state file {path} must not be a symlink"
            ) from exc
        raise EvidenceCleanupError(
            f"cannot open cleanup state file {path}: {exc}"
        ) from exc
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise EvidenceCleanupError(
                f"cleanup state file {path} must be a regular file"
            )
        with os.fdopen(descriptor, "r", encoding="utf-8") as source:
            descriptor = -1
            payload = json.load(source)
    except Exception as exc:  # noqa: BLE001
        if isinstance(exc, EvidenceCleanupError):
            raise
        raise EvidenceCleanupError(f"invalid cleanup state file {path}: {exc}") from exc
    finally:
        if descriptor >= 0:
            os.close(descriptor)
    if not isinstance(payload, dict):
        raise EvidenceCleanupError(f"cleanup state file {path} is not an object")
    return payload


def _atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as output:
            json.dump(payload, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


__all__ = [
    "ARCHIVE_MIME_TYPE",
    "EVIDENCE_ARCHIVE_NAME",
    "EVIDENCE_FINALIZATION_ACK_NAME",
    "EVIDENCE_FINALIZATION_RECEIPT_NAME",
    "EVIDENCE_POINTER_NAME",
    "PACKAGED_RAW_DIRS",
    "EvidencePublication",
    "EvidenceCleanupAuthorization",
    "EvidenceCleanupError",
    "EvidenceCleanupResult",
    "EvidenceDatabaseAssociation",
    "create_local_evidence_archive",
    "evidence_archive_path",
    "evidence_object_store",
    "evidence_pointer_path",
    "finalize_remote_evidence_cleanup",
    "hydrated_render_source",
    "publish_evidence_directory",
    "publish_evidence_archive",
    "remove_verified_local_raw_evidence",
    "remove_verified_local_packaged_evidence",
    "verify_remote_evidence_restore",
]
