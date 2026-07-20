"""Runtime wiring for immutable evidence archives.

The codec/object-store implementation is intentionally independent of app
settings.  This module supplies the small shared policy used by the solver
worker, rendering API, retention pass, and migration CLI.
"""

from __future__ import annotations

import fcntl
import errno
import hashlib
import json
import os
import shutil
import stat
import tempfile
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any, Callable, Iterator

from .config import Settings
from .evidence_store import (
    ARCHIVE_MIME_TYPE,
    ArchiveRecord,
    EvidenceCapacityError,
    EvidenceObjectStore,
    EvidenceHydrationError,
    EvidenceIntegrityError,
    EvidenceStoreError,
    EvidenceUnavailableError,
    MAX_EVIDENCE_MANIFEST_BYTES,
    RemoteEvidencePointer,
    create_tar_zst,
    extract_verified_evidence_archive,
    inspect_tar_zst,
    manifest_bundle_member_set_sha256,
    read_remote_pointer,
)


EVIDENCE_ARCHIVE_NAME = "engine_evidence.tar.zst"
EVIDENCE_POINTER_NAME = "engine_evidence.remote.json"
EVIDENCE_FINALIZATION_ACK_NAME = "storage_finalization.database.json"
EVIDENCE_FINALIZATION_RECEIPT_NAME = "storage_finalization.json"
BROKERED_HUB_BINDING_ACK_NAME = "brokered_hub_binding.database.json"
BROKERED_LOCAL_RECLAIM_INTENT_NAME = "brokered_local_reclaim.intent.json"
BROKERED_LOCAL_RECLAIM_RECEIPT_NAME = "brokered_local_reclaim.json"
PACKAGED_RAW_DIRS = ("openfoam", "time_directories", "VTK")
LEGACY_EVIDENCE_ARCHIVE_NAMES = (
    "openfoam_evidence.tar.gz",
    "engine_evidence.tar.gz",
)
CONTINUATION_EVIDENCE_PREFIXES = (
    "openfoam/system",
    "openfoam/constant",
    "openfoam/transient",
    "openfoam/postProcessing",
    "openfoam/logs",
    "time_directories",
)


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
class BrokeredRemoteEvidenceReclaim:
    job_id: str
    case_slug: str
    evidence_base: str
    receipt: dict[str, Any]
    receipt_hmac: str

    def authorization(self) -> dict[str, Any]:
        return {
            "schemaVersion": 1,
            "jobId": self.job_id,
            "caseSlug": self.case_slug,
            "evidenceBase": self.evidence_base,
            "receipt": self.receipt,
            "receiptHmac": self.receipt_hmac,
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


def restore_verified_continuation_evidence(
    evidence_dir: Path,
    destination: Path,
    settings: Settings,
    *,
    validate: Callable[[Path], None] | None = None,
    expected_archive_name: str | None = None,
    expected_archive_sha256: str | None = None,
    expected_archive_size: int | None = None,
) -> str:
    """Restore exact restart inputs from a local, remote, or legacy bundle.

    Raw evidence directories are deliberately not a source here: retention may
    remove them independently, while the immutable archive is the durable
    continuation contract.  Each candidate is fully manifest-verified before
    this function returns; a failed candidate leaves no partial destination.
    """

    evidence_dir = Path(evidence_dir)
    destination = Path(destination)
    if expected_archive_name is not None and (
        not expected_archive_name
        or "/" in expected_archive_name
        or "\\" in expected_archive_name
    ):
        raise EvidenceIntegrityError(
            f"unsafe recorded evidence archive name: {expected_archive_name!r}"
        )
    if expected_archive_sha256 is not None and (
        len(expected_archive_sha256) != 64
        or any(
            character not in "0123456789abcdefABCDEF"
            for character in expected_archive_sha256
        )
    ):
        raise EvidenceIntegrityError(
            "recorded evidence archive SHA-256 is invalid"
        )
    if expected_archive_size is not None and expected_archive_size < 0:
        raise EvidenceIntegrityError("recorded evidence archive size is invalid")
    manifest_path = evidence_dir / "evidence_manifest.json"
    expected_manifest: bytes | None = None
    if manifest_path.exists() or manifest_path.is_symlink():
        if not manifest_path.is_file() or manifest_path.is_symlink():
            raise EvidenceIntegrityError(
                f"local evidence manifest is not a safe regular file: {manifest_path}"
            )
        try:
            with manifest_path.open("rb") as source:
                expected_manifest = source.read(MAX_EVIDENCE_MANIFEST_BYTES + 1)
        except OSError as exc:
            raise EvidenceUnavailableError(
                f"local evidence manifest cannot be read: {exc}"
            ) from exc
        if len(expected_manifest) > MAX_EVIDENCE_MANIFEST_BYTES:
            raise EvidenceIntegrityError(
                "local evidence manifest exceeds the "
                f"{MAX_EVIDENCE_MANIFEST_BYTES}-byte limit"
            )

    attempted: list[str] = []
    had_transient_failure = False

    def record_attempt(label: str, exc: Exception | None = None) -> None:
        nonlocal had_transient_failure
        if isinstance(exc, (EvidenceUnavailableError, EvidenceCapacityError)):
            had_transient_failure = True
        attempted.append(label if exc is None else f"{label}: {exc}")

    pointer_path = evidence_pointer_path(evidence_dir)
    pointer: RemoteEvidencePointer | None = None
    if pointer_path.exists() or pointer_path.is_symlink():
        if not pointer_path.is_file() or pointer_path.is_symlink():
            raise EvidenceIntegrityError("unsafe remote evidence pointer")
        try:
            pointer = read_remote_pointer(pointer_path)
        except (OSError, ValueError, EvidenceStoreError) as exc:
            raise EvidenceIntegrityError(
                f"durable remote evidence pointer is invalid: {exc}"
            ) from exc
    if (
        pointer is not None
        and expected_archive_name == EVIDENCE_ARCHIVE_NAME
        and (
            (
                expected_archive_sha256 is not None
                and pointer.stored_sha256.lower()
                != expected_archive_sha256.lower()
            )
            or (
                expected_archive_size is not None
                and pointer.stored_size != expected_archive_size
            )
        )
    ):
        raise EvidenceIntegrityError(
            "durable remote pointer does not match the archive identity recorded "
            "for the continuation source result"
        )

    def archive_is_recorded(path: Path) -> bool:
        if expected_archive_name is not None and path.name != expected_archive_name:
            return False
        if expected_archive_size is not None:
            try:
                if path.stat().st_size != expected_archive_size:
                    raise EvidenceIntegrityError(
                        f"{path.name} size does not match the source result record"
                    )
            except OSError as exc:
                raise EvidenceUnavailableError(
                    f"cannot stat recorded archive {path}: {exc}"
                ) from exc
        if expected_archive_sha256 is not None:
            digest = hashlib.sha256()
            try:
                with path.open("rb") as source:
                    while True:
                        chunk = source.read(1024 * 1024)
                        if not chunk:
                            break
                        digest.update(chunk)
            except OSError as exc:
                raise EvidenceUnavailableError(
                    f"cannot read recorded archive {path}: {exc}"
                ) from exc
            if digest.hexdigest().lower() != expected_archive_sha256.lower():
                raise EvidenceIntegrityError(
                    f"{path.name} SHA-256 does not match the source result record"
                )
        return True

    def accept_candidate(label: str) -> str:
        if validate is None:
            return label
        try:
            validate(destination)
        except EvidenceStoreError:
            shutil.rmtree(destination, ignore_errors=True)
            raise
        except Exception as exc:  # noqa: BLE001
            shutil.rmtree(destination, ignore_errors=True)
            raise EvidenceHydrationError(
                f"restored archive is not restartable: {exc}"
            ) from exc
        return label

    local_archive = evidence_archive_path(evidence_dir)
    if (
        (local_archive.exists() or local_archive.is_symlink())
        and (
            expected_archive_name is None
            or expected_archive_name == local_archive.name
        )
    ):
        if not local_archive.is_file() or local_archive.is_symlink():
            record_attempt(f"{local_archive.name}: unsafe local archive")
        else:
            try:
                archive_is_recorded(local_archive)
                extract_verified_evidence_archive(
                    local_archive,
                    destination,
                    compression="zstd",
                    include_prefixes=CONTINUATION_EVIDENCE_PREFIXES,
                    pointer=pointer,
                    expected_manifest=expected_manifest,
                )
                return accept_candidate(f"local:{local_archive.name}")
            except EvidenceStoreError as exc:
                shutil.rmtree(destination, ignore_errors=True)
                record_attempt(local_archive.name, exc)

    def try_legacy_candidates() -> str | None:
        for name in LEGACY_EVIDENCE_ARCHIVE_NAMES:
            if expected_archive_name is not None and expected_archive_name != name:
                continue
            legacy_archive = evidence_dir / name
            if not (legacy_archive.exists() or legacy_archive.is_symlink()):
                continue
            if not legacy_archive.is_file() or legacy_archive.is_symlink():
                record_attempt(f"{name}: unsafe local archive")
                continue
            try:
                archive_is_recorded(legacy_archive)
                extract_verified_evidence_archive(
                    legacy_archive,
                    destination,
                    compression="gzip",
                    include_prefixes=CONTINUATION_EVIDENCE_PREFIXES,
                    # A migration pointer authenticates the canonical tar.zst
                    # generation.  It can never authenticate the distinct
                    # gzip container or its uncompressed tar digest.
                    pointer=None,
                    expected_manifest=expected_manifest,
                )
                return accept_candidate(f"legacy-local:{name}")
            except EvidenceStoreError as exc:
                shutil.rmtree(destination, ignore_errors=True)
                record_attempt(name, exc)
        return None

    if expected_archive_name in LEGACY_EVIDENCE_ARCHIVE_NAMES:
        accepted_legacy = try_legacy_candidates()
        if accepted_legacy is not None:
            return accepted_legacy

    if pointer is not None:
        try:
            store = evidence_object_store(settings)
            if store is None:
                raise EvidenceUnavailableError(
                    "remote evidence pointer exists but object storage is not configured"
                )
            with store.archive_source(pointer) as remote_archive:
                try:
                    extract_verified_evidence_archive(
                        remote_archive,
                        destination,
                        compression="zstd",
                        include_prefixes=CONTINUATION_EVIDENCE_PREFIXES,
                        pointer=pointer,
                        expected_manifest=expected_manifest,
                    )
                except (
                    EvidenceCapacityError,
                    EvidenceIntegrityError,
                    EvidenceUnavailableError,
                ):
                    raise
                except EvidenceStoreError as exc:
                    # Once a generation-pinned archive has been obtained,
                    # extraction/manifest failures describe immutable bytes,
                    # not a retryable provider outage.
                    raise EvidenceIntegrityError(str(exc)) from exc
            return accept_candidate(
                f"remote:gs://{pointer.bucket}/{pointer.object_key}"
                f"#{pointer.generation}"
            )
        except (
            EvidenceCapacityError,
            EvidenceIntegrityError,
            EvidenceUnavailableError,
        ) as exc:
            shutil.rmtree(destination, ignore_errors=True)
            record_attempt(pointer_path.name, exc)
        except (EvidenceStoreError, OSError, ValueError) as exc:
            shutil.rmtree(destination, ignore_errors=True)
            unavailable = EvidenceUnavailableError(
                f"remote evidence storage is unavailable: {exc}"
            )
            record_attempt(pointer_path.name, unavailable)

    if expected_archive_name not in LEGACY_EVIDENCE_ARCHIVE_NAMES:
        accepted_legacy = try_legacy_candidates()
        if accepted_legacy is not None:
            return accepted_legacy

    if expected_archive_name is not None and not attempted and pointer is None:
        record_attempt(
            f"{expected_archive_name}: archive recorded by the source result is unavailable"
        )
    if not attempted:
        raise EvidenceIntegrityError(
            f"no immutable continuation evidence archive found under {evidence_dir}"
        )
    error_type = (
        EvidenceUnavailableError
        if had_transient_failure
        else EvidenceIntegrityError
    )
    raise error_type(
        "no continuation evidence archive could be restored: "
        + " | ".join(attempted)
    )


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


def reclaim_brokered_remote_evidence(
    job_root: Path,
    evidence_dir: Path,
    authorization: BrokeredRemoteEvidenceReclaim,
    *,
    crash_after_deletions: int | None = None,
) -> EvidenceCleanupResult:
    """Reclaim credentialless remote-solver bytes after an exact hub receipt.

    The Node control plane has already authenticated the receipt HMAC with the
    per-solver credential.  This engine endpoint is control-plane protected and
    independently proves the local manifest/archive bytes match that receipt
    before writing a durable acknowledgement and deleting anything.  Replays
    after a crash are safe because a missing archive is accepted only when the
    exact acknowledgement was durably written first.
    """

    job_root = Path(job_root)
    evidence_dir = Path(evidence_dir)
    _require_safe_broker_reclaim_target(job_root, evidence_dir, authorization)
    receipt = authorization.receipt
    remote = receipt.get("remote")
    canonical = receipt.get("canonical")
    if (
        receipt.get("schemaVersion") != 1
        or receipt.get("kind") != "hub-canonical-evidence-binding"
        or receipt.get("bindingState") != "bound"
        or receipt.get("promisePointState") != "fulfilled"
        or receipt.get("engineJobId") != authorization.job_id
        or receipt.get("engineCaseSlug") != authorization.case_slug
        or not isinstance(remote, dict)
        or not isinstance(canonical, dict)
        or not all(
            isinstance(canonical.get(key), str) and canonical.get(key)
            for key in ("resultId", "resultAttemptId", "artifactId")
        )
        or not isinstance(authorization.receipt_hmac, str)
        or len(authorization.receipt_hmac) != 64
        or any(c not in "0123456789abcdef" for c in authorization.receipt_hmac)
    ):
        raise EvidenceCleanupError(
            "exact bound and fulfilled hub receipt is required for brokered reclaim"
        )

    required_hashes = ("storedSha256", "tarSha256", "manifestSha256")
    if any(
        not isinstance(remote.get(key), str)
        or len(str(remote.get(key))) != 64
        or any(c not in "0123456789abcdef" for c in str(remote.get(key)))
        for key in required_hashes
    ):
        raise EvidenceCleanupError("hub receipt contains malformed evidence digests")
    required_sizes = (
        "storedByteSize",
        "tarByteSize",
        "manifestByteSize",
        "bundledFileCount",
    )
    if any(
        not isinstance(remote.get(key), int) or int(remote.get(key)) <= 0
        for key in required_sizes
    ):
        raise EvidenceCleanupError("hub receipt contains malformed evidence sizes")
    zstd_level = remote.get("zstdLevel")
    if not isinstance(zstd_level, int) or not 1 <= zstd_level <= 22:
        raise EvidenceCleanupError("hub receipt contains invalid zstd level")

    canonical_authorization = authorization.authorization()
    with _cleanup_job_guard(job_root):
        ack_path = evidence_dir / BROKERED_HUB_BINDING_ACK_NAME
        existing_ack = _read_optional_json(ack_path)
        if existing_ack is not None and existing_ack.get("authorization") != canonical_authorization:
            raise EvidenceCleanupError(
                "existing hub binding acknowledgement conflicts with reclaim request"
            )

        manifest_path = evidence_dir / "evidence_manifest.json"
        if not manifest_path.is_file() or manifest_path.is_symlink():
            raise EvidenceCleanupError(
                "retained local evidence manifest is required for brokered reclaim"
            )
        manifest_bytes = manifest_path.read_bytes()
        if (
            len(manifest_bytes) != int(remote["manifestByteSize"])
            or hashlib.sha256(manifest_bytes).hexdigest()
            != remote["manifestSha256"]
        ):
            raise EvidenceCleanupError(
                "retained local evidence manifest does not match the hub receipt"
            )

        intent_path = evidence_dir / BROKERED_LOCAL_RECLAIM_INTENT_NAME
        existing_intent = _read_optional_json(intent_path)
        archive_path = evidence_dir / EVIDENCE_ARCHIVE_NAME
        if archive_path.exists() or archive_path.is_symlink():
            if archive_path.is_symlink() or not archive_path.is_file():
                raise EvidenceCleanupError(
                    "brokered local evidence archive must be a regular file"
                )
            try:
                archive = inspect_tar_zst(archive_path, level=zstd_level)
            except (OSError, ValueError, EvidenceStoreError) as exc:
                raise EvidenceCleanupError(
                    f"brokered local evidence archive is invalid: {exc}"
                ) from exc
            if (
                archive.stored_sha256 != remote["storedSha256"]
                or archive.stored_size != int(remote["storedByteSize"])
                or archive.tar_sha256 != remote["tarSha256"]
                or archive.tar_size != int(remote["tarByteSize"])
            ):
                raise EvidenceCleanupError(
                    "brokered local evidence archive does not match the hub receipt"
                )
        elif existing_intent is None:
            raise EvidenceCleanupError(
                "brokered archive is missing without a durable cleanup intent"
            )

        if existing_ack is None:
            _atomic_write_json(
                ack_path,
                {
                    "schemaVersion": 1,
                    "state": "hub_bound_and_fulfilled",
                    "authorization": canonical_authorization,
                    "registeredAt": datetime.now(timezone.utc).isoformat(),
                },
            )

        allowed_names = (*PACKAGED_RAW_DIRS, EVIDENCE_ARCHIVE_NAME)
        if existing_intent is None:
            inventories = [
                _broker_reclaim_path_inventory(evidence_dir / name, name)
                for name in allowed_names
                if (evidence_dir / name).exists()
                or (evidence_dir / name).is_symlink()
            ]
            intent = {
                "schemaVersion": 1,
                "kind": "brokered-local-evidence-reclaim-intent",
                "authorization": canonical_authorization,
                "paths": inventories,
                "plannedPathCount": len(inventories),
                "plannedBytes": sum(int(row["byteSize"]) for row in inventories),
            }
            _atomic_create_json(intent_path, intent)
            existing_intent = _read_optional_json(intent_path)
        if (
            existing_intent is None
            or existing_intent.get("authorization") != canonical_authorization
            or existing_intent.get("kind")
            != "brokered-local-evidence-reclaim-intent"
            or not isinstance(existing_intent.get("paths"), list)
        ):
            raise EvidenceCleanupError(
                "durable brokered reclaim intent conflicts with this request"
            )
        intended_rows = existing_intent["paths"]
        intended_names = {
            row.get("name")
            for row in intended_rows
            if isinstance(row, dict) and isinstance(row.get("name"), str)
        }
        if (
            len(intended_names) != len(intended_rows)
            or not intended_names.issubset(set(allowed_names))
            or existing_intent.get("plannedPathCount") != len(intended_rows)
            or existing_intent.get("plannedBytes")
            != sum(int(row.get("byteSize", -1)) for row in intended_rows)
        ):
            raise EvidenceCleanupError("durable brokered reclaim intent is malformed")
        for name in allowed_names:
            path = evidence_dir / name
            expected_inventory = next(
                (row for row in intended_rows if row.get("name") == name), None
            )
            if path.exists() or path.is_symlink():
                if expected_inventory is None:
                    raise EvidenceCleanupError(
                        f"brokered reclaim path {name} appeared after cleanup intent"
                    )
                if _broker_reclaim_path_inventory(path, name) != expected_inventory:
                    raise EvidenceCleanupError(
                        f"brokered reclaim path {name} changed after cleanup intent"
                    )

        intent_canonical = json.dumps(
            existing_intent, sort_keys=True, separators=(",", ":")
        ).encode("utf-8")
        final_receipt = {
            "schemaVersion": 1,
            "state": "complete",
            "authorization": canonical_authorization,
            "intentSha256": hashlib.sha256(intent_canonical).hexdigest(),
            "deletedPaths": sorted(str(name) for name in intended_names),
            "bytesDeleted": int(existing_intent["plannedBytes"]),
        }
        receipt_path = evidence_dir / BROKERED_LOCAL_RECLAIM_RECEIPT_NAME
        previous_receipt = _read_optional_json(receipt_path)
        if previous_receipt is not None:
            if previous_receipt != final_receipt:
                raise EvidenceCleanupError(
                    "immutable brokered reclaim receipt conflicts with cleanup intent"
                )
            if any(
                (evidence_dir / str(name)).exists()
                or (evidence_dir / str(name)).is_symlink()
                for name in intended_names
            ):
                raise EvidenceCleanupError(
                    "brokered reclaim receipt exists while intended paths remain"
                )
            return EvidenceCleanupResult(
                state="no_local_bytes",
                evidence_base=authorization.evidence_base,
                bytes_freed=int(existing_intent["plannedBytes"]),
                verification="hub-signed-bind+fulfillment+local-archive+intent",
                association_count=1,
            )

        if crash_after_deletions == 0:
            raise RuntimeError("injected brokered reclaim crash")
        deleted = 0
        for row in intended_rows:
            path = evidence_dir / str(row["name"])
            if path.exists() or path.is_symlink():
                _remove_path(path)
                deleted += 1
                if (
                    crash_after_deletions is not None
                    and deleted >= crash_after_deletions
                ):
                    raise RuntimeError("injected brokered reclaim crash")
        _atomic_create_json(receipt_path, final_receipt)
        return EvidenceCleanupResult(
            state="complete",
            evidence_base=authorization.evidence_base,
            bytes_freed=int(existing_intent["plannedBytes"]),
            verification="hub-signed-bind+fulfillment+local-archive+intent",
            association_count=1,
        )


def _require_safe_broker_reclaim_target(
    job_root: Path,
    evidence_dir: Path,
    authorization: BrokeredRemoteEvidenceReclaim,
) -> None:
    if job_root.is_symlink() or evidence_dir.is_symlink():
        raise EvidenceCleanupError("brokered reclaim path must not be a symlink")
    try:
        resolved_job = job_root.resolve(strict=True)
        resolved_evidence = evidence_dir.resolve(strict=True)
        relative = evidence_dir.relative_to(job_root)
        resolved_evidence.relative_to(resolved_job)
    except (OSError, ValueError) as exc:
        raise EvidenceCleanupError(
            "brokered reclaim evidence path must stay inside the job root"
        ) from exc
    expected = Path("cases") / authorization.case_slug / authorization.evidence_base
    if relative != expected or authorization.job_id != job_root.name:
        raise EvidenceCleanupError(
            "brokered reclaim path does not match job/case/evidence identity"
        )
    current = job_root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise EvidenceCleanupError(
                "brokered reclaim path must not traverse a symlink"
            )


def _broker_reclaim_path_inventory(path: Path, name: str) -> dict[str, Any]:
    path = Path(path)
    if path.is_symlink():
        raise EvidenceCleanupError(
            f"brokered reclaim path {name} must not be a symlink"
        )
    digest = hashlib.sha256()
    byte_size = 0
    entry_count = 0
    if path.is_file():
        data_hash = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                byte_size += len(chunk)
                data_hash.update(chunk)
        digest.update(
            f"file\0{name}\0{byte_size}\0{data_hash.hexdigest()}\n".encode("utf-8")
        )
        entry_count = 1
        kind = "file"
    elif path.is_dir():
        kind = "directory"
        for child in sorted(path.rglob("*"), key=lambda item: item.as_posix()):
            relative = child.relative_to(path).as_posix()
            if child.is_symlink():
                raise EvidenceCleanupError(
                    f"brokered reclaim path {name}/{relative} must not be a symlink"
                )
            if child.is_dir():
                digest.update(f"dir\0{relative}\n".encode("utf-8"))
                entry_count += 1
                continue
            if not child.is_file():
                raise EvidenceCleanupError(
                    f"brokered reclaim path {name}/{relative} is not a regular file"
                )
            child_hash = hashlib.sha256()
            child_size = 0
            with child.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    child_size += len(chunk)
                    child_hash.update(chunk)
            byte_size += child_size
            entry_count += 1
            digest.update(
                f"file\0{relative}\0{child_size}\0{child_hash.hexdigest()}\n".encode(
                    "utf-8"
                )
            )
    else:
        raise EvidenceCleanupError(
            f"brokered reclaim path {name} is not a regular file or directory"
        )
    return {
        "name": name,
        "kind": kind,
        "byteSize": byte_size,
        "entryCount": entry_count,
        "treeSha256": digest.hexdigest(),
    }


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


@contextmanager
def hydrated_pointer_render_source(
    pointer: RemoteEvidencePointer, settings: Settings
) -> Iterator[Path]:
    """Yield verified VTK for an exact pointer supplied by the control plane.

    Brokered remote-solver evidence is canonically registered on the hub after
    the source node uploads it directly to GCS.  Such an import deliberately
    has no matching local engine job directory or pointer sidecar.  The
    control plane can nevertheless render it by supplying the immutable blob
    identity read from the exact result-attempt archive row.
    """

    store = evidence_object_store(settings)
    if store is None:
        raise FileNotFoundError("remote evidence storage is not configured")
    with store.render_source(pointer) as source:
        yield source


@contextmanager
def hydrated_volume_render_source(
    evidence_dir: Path, settings: Settings
) -> Iterator[Path]:
    """Yield VTK restored from the retained local tar.zst archive.

    This is the dedicated-volume counterpart to GCS hydration.  It is used by
    the remote-solver cutover canary and by explicit archive-only render
    requests; ordinary volume-backed rendering still reads retained raw VTK.
    The whole archive is decompressed and every bundled manifest member is
    authenticated before the temporary VTK tree becomes visible.
    """

    evidence_dir = Path(evidence_dir)
    archive_path = evidence_archive_path(evidence_dir)
    manifest_path = evidence_dir / "evidence_manifest.json"
    for label, path in (("archive", archive_path), ("manifest", manifest_path)):
        if not path.is_file() or path.is_symlink():
            raise EvidenceIntegrityError(
                f"retained local evidence {label} is not a safe regular file"
            )
    try:
        with manifest_path.open("rb") as manifest_stream:
            manifest = manifest_stream.read(MAX_EVIDENCE_MANIFEST_BYTES + 1)
    except OSError as exc:
        raise EvidenceUnavailableError(
            f"retained local evidence manifest cannot be read: {exc}"
        ) from exc
    if len(manifest) > MAX_EVIDENCE_MANIFEST_BYTES:
        raise EvidenceIntegrityError(
            "retained local evidence manifest exceeds the safety limit"
        )
    before = inspect_tar_zst(archive_path, level=settings.evidence_zstd_level)
    cache_root = settings.resolved_evidence_hydration_cache_dir()
    cache_root.mkdir(parents=True, exist_ok=True)
    if cache_root.is_symlink() or not cache_root.is_dir():
        raise EvidenceIntegrityError(
            "volume evidence hydration cache is not a safe directory"
        )
    destination = Path(
        tempfile.mkdtemp(
            prefix=f".volume-{before.tar_sha256[:16]}-", dir=cache_root
        )
    )
    # extract_verified_evidence_archive requires a destination that does not
    # yet exist. mkdtemp reserves a collision-free name, then removal hands
    # that exact path to the extractor without a predictable-name race.
    destination.rmdir()
    try:
        extracted = extract_verified_evidence_archive(
            archive_path,
            destination,
            compression="zstd",
            include_prefixes=("VTK",),
            expected_manifest=manifest,
        )
        if extracted <= 0 or not (destination / "VTK").is_dir():
            raise EvidenceIntegrityError(
                "retained local evidence archive contains no verified VTK members"
            )
        after = inspect_tar_zst(archive_path, level=settings.evidence_zstd_level)
        if after != before:
            raise EvidenceIntegrityError(
                "retained local evidence archive changed during hydration"
            )
        yield destination
    finally:
        if destination.is_dir() and not destination.is_symlink():
            shutil.rmtree(destination)


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


def _atomic_create_json(path: Path, payload: dict[str, Any]) -> None:
    """Publish one immutable JSON ledger file without replacing a winner."""

    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
    try:
        with temporary.open("x", encoding="utf-8") as output:
            json.dump(payload, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        try:
            os.link(temporary, path)
        except FileExistsError:
            existing = _read_optional_json(path)
            if existing != payload:
                raise EvidenceCleanupError(
                    f"immutable cleanup state file {path} already has different content"
                )
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        temporary.unlink(missing_ok=True)


__all__ = [
    "ARCHIVE_MIME_TYPE",
    "BROKERED_HUB_BINDING_ACK_NAME",
    "BROKERED_LOCAL_RECLAIM_INTENT_NAME",
    "BROKERED_LOCAL_RECLAIM_RECEIPT_NAME",
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
    "BrokeredRemoteEvidenceReclaim",
    "create_local_evidence_archive",
    "evidence_archive_path",
    "evidence_object_store",
    "evidence_pointer_path",
    "finalize_remote_evidence_cleanup",
    "hydrated_render_source",
    "hydrated_pointer_render_source",
    "hydrated_volume_render_source",
    "publish_evidence_directory",
    "publish_evidence_archive",
    "reclaim_brokered_remote_evidence",
    "remove_verified_local_raw_evidence",
    "remove_verified_local_packaged_evidence",
    "verify_remote_evidence_restore",
]
