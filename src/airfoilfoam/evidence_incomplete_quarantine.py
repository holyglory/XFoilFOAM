"""Preserve one terminal, incomplete legacy evidence package in immutable GCS.

This is deliberately separate from canonical solver-evidence migration.  It
never writes the canonical archive, pointer, or receipt names and it never
turns incomplete evidence into a result.  Dry-run is the default.  Execution
uses three fail-closed passes: package/upload/verify, database acknowledgement,
then a fresh generation-pinned restore immediately before local cleanup.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import tarfile
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Sequence

import zstandard

from .config import Settings, get_settings
from .evidence_migration import (
    EvidenceMigrationError,
    LEGACY_GZIP_NAMES,
    MigrationTarget,
    _atomic_write_json,
    _file_size_sha256,
    _gzip_tar_digest,
    _job_guard,
    _read_optional_json,
    _remove_path,
    _require_contained_target,
    _require_terminal_job,
    _tree_size,
)
from .evidence_runtime import EVIDENCE_ARCHIVE_NAME, PACKAGED_RAW_DIRS
from .evidence_store import (
    ArchiveRecord,
    EvidenceHydrationError,
    EvidenceObjectStore,
    EvidenceStoreError,
    RemoteEvidencePointer,
    extract_verified_evidence_archive,
    inspect_tar_zst,
    read_remote_pointer,
)


PRESERVATION_KIND = "incomplete_evidence_quarantine"
QUARANTINE_REASON = "terminal_uningested_incomplete_archive"
PARTIAL_OBJECT_PREFIX = "solver-evidence-partial/v1"
ARCHIVE_NAME = "incomplete_evidence_quarantine.tar.zst"
POINTER_NAME = "incomplete_evidence_quarantine.remote.json"
PACKAGE_MANIFEST_NAME = "incomplete_evidence_quarantine.manifest.json"
RECEIPT_NAME = "incomplete_evidence_quarantine.receipt.json"
DATABASE_ACK_NAME = "incomplete_evidence_quarantine.database.json"
CORRUPT_ARCHIVE_NAME = "openfoam_evidence.tar.gz"
SCHEMA_VERSION = 1
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_DECIMAL = re.compile(r"^[1-9][0-9]*$")
_BUFFER_SIZE = 1024 * 1024
_MAX_SAFE_INTEGER = 9_007_199_254_740_991


class IncompleteEvidenceQuarantineError(RuntimeError):
    """The incomplete-evidence preservation contract could not be proven."""


@dataclass(frozen=True, order=True)
class MemberIdentity:
    path: str
    sha256: str
    byte_size: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "sha256": self.sha256,
            "byteSize": self.byte_size,
        }


@dataclass(frozen=True)
class IncompleteTarget:
    job_root: Path
    evidence_dir: Path

    @property
    def job_id(self) -> str:
        return self.job_root.name

    @property
    def evidence_path(self) -> str:
        return self.evidence_dir.relative_to(self.job_root).as_posix()

    def migration_target(self) -> MigrationTarget:
        return MigrationTarget(self.job_root, self.evidence_dir)


@dataclass(frozen=True)
class QuarantineResult:
    job_id: str
    evidence_path: str
    status: str
    expected_members: int = 0
    retained_members: int = 0
    missing_members: int = 0
    package_members: int = 0
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
            "expectedMembers": self.expected_members,
            "retainedMembers": self.retained_members,
            "missingMembers": self.missing_members,
            "packageMembers": self.package_members,
            "remoteBytes": self.remote_bytes,
            "bytesDeleted": self.bytes_deleted,
            "objectUri": self.object_uri,
            "generation": self.generation,
            "verification": self.verification,
            "message": self.message,
        }


@dataclass
class _Retained:
    identity: MemberIdentity
    package_path: str
    source_file: Path
    sources: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            **self.identity.to_dict(),
            "packagePath": self.package_path,
            "sources": sorted(
                self.sources,
                key=lambda row: json.dumps(row, sort_keys=True, separators=(",", ":")),
            ),
        }


@dataclass
class _Analysis:
    original_manifest_bytes: bytes
    expected: dict[str, MemberIdentity]
    retained: dict[str, _Retained]
    missing: list[MemberIdentity]
    unmanifested: list[dict[str, Any]]
    source_archives: list[dict[str, Any]]
    corrupt_terminal_error: str
    corrupt_readable_tar_bytes: int


def _safe_relative(value: str, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise IncompleteEvidenceQuarantineError(f"{label} must be a non-empty exact path")
    if (
        value.startswith("/")
        or "\\" in value
        or "\0" in value
        or any(ord(character) < 32 or ord(character) == 127 for character in value)
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise IncompleteEvidenceQuarantineError(f"{label} must be a safe relative path")
    return PurePosixPath(value).as_posix()


def _safe_job_id(value: str) -> str:
    if not value or value != value.strip() or Path(value).name != value or "/" in value or "\\" in value:
        raise IncompleteEvidenceQuarantineError("job id must be one safe path segment")
    return value


def _strict_byte_size(value: Any, label: str) -> int:
    """Match the JavaScript receipt contract without lossy JSON coercion."""

    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value < 0
        or value > _MAX_SAFE_INTEGER
    ):
        raise IncompleteEvidenceQuarantineError(
            f"{label} must be a non-negative safe integer"
        )
    return value


def resolve_target(jobs_root: Path, job_id: str, evidence_path: str) -> IncompleteTarget:
    jobs_root = Path(jobs_root)
    job_id = _safe_job_id(job_id)
    evidence_path = _safe_relative(evidence_path, "evidence path")
    job_root = jobs_root / job_id
    evidence_dir = job_root.joinpath(*PurePosixPath(evidence_path).parts)
    target = IncompleteTarget(job_root, evidence_dir)
    if not job_root.is_dir() or not evidence_dir.is_dir():
        raise IncompleteEvidenceQuarantineError("exact job/evidence path does not exist")
    try:
        _require_contained_target(target.migration_target())
    except EvidenceMigrationError as exc:
        raise IncompleteEvidenceQuarantineError(str(exc)) from exc
    return target


def _member_set_digest(members: Iterable[MemberIdentity]) -> tuple[int, str]:
    rows = sorted(members)
    digest = hashlib.sha256()
    for row in rows:
        digest.update(row.path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(row.sha256.encode("ascii"))
        digest.update(b"\0")
        digest.update(str(row.byte_size).encode("ascii"))
        digest.update(b"\n")
    return len(rows), digest.hexdigest()


def _strict_manifest(path: Path) -> tuple[bytes, dict[str, MemberIdentity]]:
    if not path.is_file() or path.is_symlink():
        raise IncompleteEvidenceQuarantineError("original evidence manifest must be a regular file")
    try:
        payload = path.read_bytes()
        raw = json.loads(payload)
    except Exception as exc:  # noqa: BLE001
        raise IncompleteEvidenceQuarantineError(f"cannot read original evidence manifest: {exc}") from exc
    if not isinstance(raw, dict) or not isinstance(raw.get("files"), list):
        raise IncompleteEvidenceQuarantineError("original evidence manifest has no files list")
    exclusions = raw.get("bundleExcludes", [])
    if not isinstance(exclusions, list):
        raise IncompleteEvidenceQuarantineError("original manifest bundleExcludes is not a list")
    excluded: set[str] = set()
    for item in exclusions:
        if not isinstance(item, str) or "/" in item or "\\" in item:
            raise IncompleteEvidenceQuarantineError("original manifest contains an unsafe bundle exclusion")
        normalized = _safe_relative(item, "bundle exclusion")
        if normalized in excluded:
            raise IncompleteEvidenceQuarantineError("original manifest repeats a bundle exclusion")
        excluded.add(normalized)
    expected: dict[str, MemberIdentity] = {}
    for item in raw["files"]:
        if not isinstance(item, dict):
            raise IncompleteEvidenceQuarantineError("original manifest contains a non-object file entry")
        try:
            raw_member_path = item["path"]
            if not isinstance(raw_member_path, str):
                raise IncompleteEvidenceQuarantineError(
                    "original manifest member path is not a string"
                )
            member_path = _safe_relative(raw_member_path, "manifest member path")
            byte_size = _strict_byte_size(
                item["byteSize"], "original manifest member byteSize"
            )
            sha256 = item["sha256"]
            if not isinstance(sha256, str):
                raise IncompleteEvidenceQuarantineError(
                    "original manifest member sha256 is not a string"
                )
        except (KeyError, TypeError, ValueError) as exc:
            raise IncompleteEvidenceQuarantineError(f"invalid original manifest member: {exc}") from exc
        if byte_size < 0 or not _SHA256.fullmatch(sha256):
            raise IncompleteEvidenceQuarantineError(f"invalid original manifest identity for {member_path}")
        if member_path in expected:
            raise IncompleteEvidenceQuarantineError(f"duplicate original manifest member: {member_path}")
        if member_path.split("/", 1)[0] not in excluded:
            expected[member_path] = MemberIdentity(member_path, sha256, byte_size)
    if not expected:
        raise IncompleteEvidenceQuarantineError("original manifest has no bundled members")
    return payload, expected


def _identity(path: Path, relative: str) -> MemberIdentity:
    size, sha256 = _file_size_sha256(path)
    return MemberIdentity(relative, sha256, size)


def _copy_exact(source: Path, destination: Path) -> None:
    if not source.is_file() or source.is_symlink():
        raise IncompleteEvidenceQuarantineError(f"unsafe source file: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as input_file, destination.open("xb") as output_file:
        shutil.copyfileobj(input_file, output_file, _BUFFER_SIZE)


def _iter_raw_files(evidence_dir: Path) -> list[tuple[str, Path]]:
    rows: list[tuple[str, Path]] = []
    for root_name in PACKAGED_RAW_DIRS:
        root = evidence_dir / root_name
        if not root.exists() and not root.is_symlink():
            continue
        if not root.is_dir() or root.is_symlink():
            raise IncompleteEvidenceQuarantineError(f"raw evidence root is unsafe: {root_name}")
        for current, dirnames, filenames in os.walk(root, followlinks=False):
            current_path = Path(current)
            for dirname in dirnames:
                if (current_path / dirname).is_symlink():
                    raise IncompleteEvidenceQuarantineError(
                        f"raw evidence contains a symlink: {(current_path / dirname).relative_to(evidence_dir)}"
                    )
            for filename in filenames:
                path = current_path / filename
                relative = path.relative_to(evidence_dir).as_posix()
                if not path.is_file() or path.is_symlink():
                    raise IncompleteEvidenceQuarantineError(f"raw evidence member is unsafe: {relative}")
                rows.append((relative, path))
    return sorted(rows)


def _gzip_readable_bytes(path: Path) -> tuple[int, str]:
    readable = 0
    try:
        with gzip.open(path, "rb") as source:
            # ``read()`` may consume the entire small stream and validate its
            # missing footer before returning any already-decoded bytes.
            # ``read1()`` exposes the genuinely readable prefix incrementally,
            # which is the forensic quantity this receipt records.
            while chunk := source.read1(_BUFFER_SIZE):
                readable += len(chunk)
    except Exception as exc:  # noqa: BLE001
        return readable, f"{type(exc).__name__}: {exc}"
    raise IncompleteEvidenceQuarantineError("legacy gzip is complete; use canonical evidence migration")


def _normalize_tar_name(value: str) -> str:
    while value.startswith("./"):
        value = value[2:]
    return _safe_relative(value, "archive member path")


def _normalize_stage_metadata(root: Path) -> None:
    paths = sorted(root.rglob("*"), key=lambda path: (len(path.parts), path.as_posix()), reverse=True)
    for path in paths:
        if path.is_symlink():
            raise IncompleteEvidenceQuarantineError(f"forensic stage contains a symlink: {path}")
        os.chmod(path, 0o755 if path.is_dir() else 0o644)
        os.utime(path, (0, 0), follow_symlinks=False)


class _DigestWriter:
    def __init__(self, raw: Any):
        self.raw = raw
        self.digest = hashlib.sha256()
        self.size = 0

    def write(self, data: bytes) -> int:
        written = self.raw.write(data)
        if written is None:
            written = len(data)
        if written:
            self.digest.update(memoryview(data)[:written])
            self.size += written
        return written

    def flush(self) -> None:
        self.raw.flush()

    def writable(self) -> bool:
        return True

    def hexdigest(self) -> str:
        return self.digest.hexdigest()


def _create_deterministic_tar_zst(
    source_dir: Path,
    destination: Path,
    *,
    level: int,
) -> ArchiveRecord:
    """Archive exact file bytes with host-independent deterministic metadata."""

    source_dir = Path(source_dir)
    destination = Path(destination)
    if not source_dir.is_dir() or source_dir.is_symlink():
        raise IncompleteEvidenceQuarantineError("forensic package source is unsafe")
    files: list[tuple[str, Path]] = []
    for path in source_dir.rglob("*"):
        relative = path.relative_to(source_dir).as_posix()
        if path.is_symlink():
            raise IncompleteEvidenceQuarantineError(
                f"forensic package source contains a symlink: {relative}"
            )
        if path.is_file():
            files.append((_safe_relative(relative, "forensic package member"), path))
        elif not path.is_dir():
            raise IncompleteEvidenceQuarantineError(
                f"forensic package source contains a non-file member: {relative}"
            )
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as raw_output:
            stored_writer = _DigestWriter(raw_output)
            compressor = zstandard.ZstdCompressor(level=level)
            with compressor.stream_writer(stored_writer, closefd=False) as compressed:
                tar_writer = _DigestWriter(compressed)
                with tarfile.open(
                    fileobj=tar_writer,
                    mode="w|",
                    format=tarfile.PAX_FORMAT,
                ) as archive:
                    for relative, path in sorted(files):
                        info = tarfile.TarInfo(relative)
                        info.size = path.stat().st_size
                        info.mode = 0o644
                        info.mtime = 0
                        info.uid = 0
                        info.gid = 0
                        info.uname = ""
                        info.gname = ""
                        with path.open("rb") as source:
                            archive.addfile(info, source)
                tar_writer.flush()
            raw_output.flush()
            os.fsync(raw_output.fileno())
        record = ArchiveRecord(
            path=destination,
            stored_sha256=stored_writer.hexdigest(),
            stored_size=stored_writer.size,
            tar_sha256=tar_writer.hexdigest(),
            tar_size=tar_writer.size,
            zstd_level=level,
        )
        os.replace(temporary, destination)
        descriptor = os.open(
            destination.parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
        )
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        return record
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _partial_store(settings: Settings) -> EvidenceObjectStore:
    bucket = (settings.evidence_bucket or "").strip()
    if not bucket:
        raise IncompleteEvidenceQuarantineError("AIRFOILFOAM_EVIDENCE_BUCKET is required")
    return EvidenceObjectStore(
        bucket,
        settings.resolved_evidence_hydration_cache_dir(),
        object_prefix=PARTIAL_OBJECT_PREFIX,
        cache_ttl_seconds=settings.evidence_hydration_cache_ttl_seconds,
        cache_max_bytes=int(settings.evidence_hydration_cache_max_gb * 1024**3),
        timeout_seconds=settings.evidence_gcs_timeout_seconds,
    )


def _put_retained(
    retained: dict[str, _Retained],
    expected: Mapping[str, MemberIdentity],
    member_path: str,
    source_file: Path,
    source: dict[str, Any],
    stage: Path,
) -> bool:
    identity = _identity(source_file, member_path)
    wanted = expected.get(member_path)
    if wanted is None or identity != wanted:
        return False
    existing = retained.get(member_path)
    if existing is not None:
        if source not in existing.sources:
            existing.sources.append(source)
        return True
    package_path = f"retained/{member_path}"
    destination = stage.joinpath(*PurePosixPath(package_path).parts)
    _copy_exact(source_file, destination)
    retained[member_path] = _Retained(
        identity=wanted,
        package_path=package_path,
        source_file=destination,
        sources=[source],
    )
    return True


def _preserve_unmanifested(
    source_file: Path,
    source_path: str,
    package_path: str,
    source: dict[str, Any],
    stage: Path,
    unmanifested: list[dict[str, Any]],
) -> None:
    package_path = _safe_relative(package_path, "unmanifested package path")
    destination = stage.joinpath(*PurePosixPath(package_path).parts)
    if destination.exists():
        raise IncompleteEvidenceQuarantineError(
            f"duplicate unmanifested package path: {package_path}"
        )
    _copy_exact(source_file, destination)
    actual = _identity(destination, package_path)
    unmanifested.append(
        {
            **actual.to_dict(),
            "sourcePath": source_path,
            "source": source,
        }
    )


def _scan_corrupt_archive(
    archive_path: Path,
    archive_sha256: str,
    original_manifest: bytes,
    expected: Mapping[str, MemberIdentity],
    retained: dict[str, _Retained],
    stage: Path,
    unmanifested: list[dict[str, Any]],
) -> tuple[int, str]:
    readable_bytes, gzip_error = _gzip_readable_bytes(archive_path)
    tar_error = ""
    seen_paths: dict[str, int] = {}
    scratch_root = stage / ".corrupt-member-scratch"
    scratch_root.mkdir()
    try:
        try:
            with tarfile.open(archive_path, mode="r|gz") as archive:
                for index, member in enumerate(archive):
                    if member.isdir():
                        continue
                    if not member.isfile():
                        raise IncompleteEvidenceQuarantineError(
                            f"corrupt archive contains an unsafe non-file member: {member.name}"
                        )
                    member_path = _normalize_tar_name(member.name)
                    seen_paths[member_path] = seen_paths.get(member_path, 0) + 1
                    if seen_paths[member_path] > 1:
                        raise IncompleteEvidenceQuarantineError(
                            f"corrupt archive repeats member path: {member_path}"
                        )
                    stream = archive.extractfile(member)
                    if stream is None:
                        raise IncompleteEvidenceQuarantineError(
                            f"corrupt archive member is unreadable: {member_path}"
                        )
                    scratch = scratch_root / f"{index:08d}.bin"
                    try:
                        with scratch.open("xb") as output:
                            while chunk := stream.read(_BUFFER_SIZE):
                                output.write(chunk)
                    except Exception:
                        scratch.unlink(missing_ok=True)
                        raise
                    if member_path == "evidence_manifest.json":
                        if scratch.read_bytes() != original_manifest:
                            raise IncompleteEvidenceQuarantineError(
                                "corrupt archive contains a different evidence manifest"
                            )
                        scratch.unlink()
                        continue
                    source = {
                        "kind": "corrupt_archive_member",
                        "sourceArchiveSha256": archive_sha256,
                        "memberPath": member_path,
                    }
                    if _put_retained(
                        retained,
                        expected,
                        member_path,
                        scratch,
                        source,
                        stage,
                    ):
                        scratch.unlink(missing_ok=True)
                        continue
                    occurrence = seen_paths[member_path]
                    _preserve_unmanifested(
                        scratch,
                        member_path,
                        f"unmanifested/corrupt_archive/{occurrence:04d}/{member_path}",
                        source,
                        stage,
                        unmanifested,
                    )
                    scratch.unlink(missing_ok=True)
        except IncompleteEvidenceQuarantineError:
            raise
        except Exception as exc:  # noqa: BLE001
            tar_error = f"{type(exc).__name__}: {exc}"
    finally:
        shutil.rmtree(scratch_root, ignore_errors=True)
    terminal_error = "; ".join(
        value for value in (f"gzip={gzip_error}", f"tar={tar_error}" if tar_error else "") if value
    )
    if not terminal_error:
        raise IncompleteEvidenceQuarantineError("corrupt archive has no terminal read error")
    return readable_bytes, terminal_error


def _donor_archive(evidence_dir: Path) -> tuple[Path, str]:
    candidates = [
        evidence_dir / EVIDENCE_ARCHIVE_NAME,
        *(evidence_dir / name for name in LEGACY_GZIP_NAMES),
    ]
    regular = [path for path in candidates if path.is_file() and not path.is_symlink()]
    if not regular:
        raise IncompleteEvidenceQuarantineError(
            f"donor has no local archive: {evidence_dir}"
        )
    canonical = evidence_dir / EVIDENCE_ARCHIVE_NAME
    selected = canonical if canonical in regular else regular[0]
    compression = "zstd" if selected.name.endswith(".zst") else "gzip"
    return selected, compression


def _recover_from_donor(
    target: IncompleteTarget,
    donor: IncompleteTarget,
    expected: Mapping[str, MemberIdentity],
    retained: dict[str, _Retained],
    stage: Path,
) -> dict[str, Any]:
    donor_manifest_path = donor.evidence_dir / "evidence_manifest.json"
    donor_manifest_bytes, donor_expected = _strict_manifest(donor_manifest_path)
    archive_path, compression = _donor_archive(donor.evidence_dir)
    archive_size, archive_sha256 = _file_size_sha256(archive_path)
    restored = stage / f".donor-{hashlib.sha256(donor.evidence_path.encode()).hexdigest()}"
    try:
        if compression == "zstd":
            record = inspect_tar_zst(archive_path)
            tar_size, tar_sha256 = record.tar_size, record.tar_sha256
        else:
            tar_size, tar_sha256 = _gzip_tar_digest(archive_path)
        extracted = extract_verified_evidence_archive(
            archive_path,
            restored,
            compression=compression,
            expected_manifest=donor_manifest_bytes,
        )
        if extracted != len(donor_expected):
            raise IncompleteEvidenceQuarantineError(
                "donor all-member verification count does not match its manifest"
            )
        for member_path in sorted(set(expected) & set(donor_expected)):
            if expected[member_path] != donor_expected[member_path]:
                continue
            source_file = restored.joinpath(*PurePosixPath(member_path).parts)
            source = {
                "kind": "sibling_archive_member",
                "sourceArchiveSha256": archive_sha256,
                "memberPath": member_path,
            }
            if not _put_retained(
                retained,
                expected,
                member_path,
                source_file,
                source,
                stage,
            ):
                raise IncompleteEvidenceQuarantineError(
                    f"verified donor member changed after extraction: {member_path}"
                )
    except (EvidenceMigrationError, EvidenceStoreError, OSError, ValueError) as exc:
        if isinstance(exc, IncompleteEvidenceQuarantineError):
            raise
        raise IncompleteEvidenceQuarantineError(
            f"donor archive failed complete authentication: {donor.evidence_path}: {exc}"
        ) from exc
    finally:
        shutil.rmtree(restored, ignore_errors=True)
    return {
        "role": "recovery_sibling",
        "jobId": target.job_id,
        "evidencePath": donor.evidence_path,
        "path": archive_path.name,
        "compression": compression,
        "sha256": archive_sha256,
        "byteSize": archive_size,
        "uncompressedTarSha256": tar_sha256,
        "uncompressedTarByteSize": tar_size,
        "integrity": "verified_complete",
    }


def _analyze(
    target: IncompleteTarget,
    donors: Sequence[IncompleteTarget],
    stage: Path,
) -> _Analysis:
    manifest_bytes, expected = _strict_manifest(
        target.evidence_dir / "evidence_manifest.json"
    )
    corrupt = target.evidence_dir / CORRUPT_ARCHIVE_NAME
    if not corrupt.is_file() or corrupt.is_symlink():
        raise IncompleteEvidenceQuarantineError(
            f"exact corrupt source {CORRUPT_ARCHIVE_NAME} is unavailable"
        )
    conflicting_legacy = [
        name
        for name in LEGACY_GZIP_NAMES
        if name != CORRUPT_ARCHIVE_NAME and (target.evidence_dir / name).exists()
    ]
    if conflicting_legacy or (target.evidence_dir / EVIDENCE_ARCHIVE_NAME).exists():
        raise IncompleteEvidenceQuarantineError(
            "incomplete target has another canonical/legacy archive candidate"
        )
    retained: dict[str, _Retained] = {}
    unmanifested: list[dict[str, Any]] = []
    for member_path, source_file in _iter_raw_files(target.evidence_dir):
        source = {"kind": "local_raw", "sourcePath": member_path}
        if _put_retained(
            retained,
            expected,
            member_path,
            source_file,
            source,
            stage,
        ):
            continue
        _preserve_unmanifested(
            source_file,
            member_path,
            f"unmanifested/local_raw/{member_path}",
            source,
            stage,
            unmanifested,
        )
    corrupt_size, corrupt_sha256 = _file_size_sha256(corrupt)
    readable, terminal_error = _scan_corrupt_archive(
        corrupt,
        corrupt_sha256,
        manifest_bytes,
        expected,
        retained,
        stage,
        unmanifested,
    )
    if readable <= 0:
        raise IncompleteEvidenceQuarantineError(
            "corrupt archive has no readable uncompressed tar prefix"
        )
    source_archives: list[dict[str, Any]] = [
        {
            "role": "corrupt_original",
            "jobId": target.job_id,
            "evidencePath": target.evidence_path,
            "path": CORRUPT_ARCHIVE_NAME,
            "compression": "gzip",
            "sha256": corrupt_sha256,
            "byteSize": corrupt_size,
            "integrity": "truncated",
            "packagePath": f"original/{CORRUPT_ARCHIVE_NAME}",
            "readableTarByteSize": readable,
            "terminalError": terminal_error,
        }
    ]
    for donor in sorted(donors, key=lambda item: item.evidence_path):
        source_archives.append(
            _recover_from_donor(target, donor, expected, retained, stage)
        )
    retained_paths = set(retained)
    expected_paths = set(expected)
    missing = [expected[path] for path in sorted(expected_paths - retained_paths)]
    if retained_paths & {member.path for member in missing}:
        raise IncompleteEvidenceQuarantineError("retained and missing member sets overlap")
    if retained_paths | {member.path for member in missing} != expected_paths:
        raise IncompleteEvidenceQuarantineError(
            "retained and missing member sets do not conserve the original manifest"
        )
    return _Analysis(
        original_manifest_bytes=manifest_bytes,
        expected=expected,
        retained=retained,
        missing=missing,
        unmanifested=sorted(unmanifested, key=lambda row: row["path"]),
        source_archives=source_archives,
        corrupt_terminal_error=terminal_error,
        corrupt_readable_tar_bytes=readable,
    )


def _atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as output:
            output.write(payload)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        temporary.unlink(missing_ok=True)


def _json_bytes(payload: Mapping[str, Any]) -> bytes:
    return (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _package_role(path: str) -> str:
    if path == "original/evidence_manifest.json":
        return "original_manifest"
    if path == f"original/{CORRUPT_ARCHIVE_NAME}":
        return "corrupt_archive"
    if path == "recovery_report.json":
        return "recovery_report"
    if path.startswith("retained/"):
        return "retained_evidence_member"
    if path.startswith("unmanifested/"):
        return "unmanifested_forensic_bytes"
    raise IncompleteEvidenceQuarantineError(f"unexpected forensic package member: {path}")


def _inventory_stage(stage: Path) -> list[MemberIdentity]:
    rows: list[MemberIdentity] = []
    for path in sorted(stage.rglob("*")):
        if path.is_dir() and not path.is_symlink():
            continue
        relative = path.relative_to(stage).as_posix()
        if path.is_symlink() or not path.is_file():
            raise IncompleteEvidenceQuarantineError(
                f"forensic package contains an unsafe member: {relative}"
            )
        if relative == "evidence_manifest.json":
            continue
        rows.append(_identity(path, relative))
    return rows


def _build_package_payloads(
    target: IncompleteTarget,
    donors: Sequence[IncompleteTarget],
    stage: Path,
) -> tuple[_Analysis, bytes, list[MemberIdentity]]:
    analysis = _analyze(target, donors, stage)
    original_dir = stage / "original"
    original_dir.mkdir(exist_ok=True)
    _atomic_write_bytes(
        original_dir / "evidence_manifest.json",
        analysis.original_manifest_bytes,
    )
    _copy_exact(
        target.evidence_dir / CORRUPT_ARCHIVE_NAME,
        original_dir / CORRUPT_ARCHIVE_NAME,
    )
    expected_rows = [analysis.expected[path] for path in sorted(analysis.expected)]
    retained_rows = [analysis.retained[path] for path in sorted(analysis.retained)]
    expected_count, expected_digest = _member_set_digest(expected_rows)
    retained_count, retained_digest = _member_set_digest(
        row.identity for row in retained_rows
    )
    missing_count, missing_digest = _member_set_digest(analysis.missing)
    recovery_report = {
        "schemaVersion": SCHEMA_VERSION,
        "preservationKind": PRESERVATION_KIND,
        "quarantineReason": QUARANTINE_REASON,
        "jobId": target.job_id,
        "evidencePath": target.evidence_path,
        "originalManifest": {
            "sha256": hashlib.sha256(analysis.original_manifest_bytes).hexdigest(),
            "byteSize": len(analysis.original_manifest_bytes),
            "expectedMemberSetSha256": expected_digest,
            "expectedMemberCount": expected_count,
        },
        "expectedMembers": [row.to_dict() for row in expected_rows],
        "retainedMembers": [row.to_dict() for row in retained_rows],
        "missingMembers": [row.to_dict() for row in analysis.missing],
        "unmanifestedMembers": analysis.unmanifested,
        "sourceArchives": analysis.source_archives,
        "conservation": {
            "expectedMemberCount": expected_count,
            "retainedMemberCount": retained_count,
            "missingMemberCount": missing_count,
            "retainedPlusMissing": retained_count + missing_count,
            "retainedMemberSetSha256": retained_digest,
            "missingMemberSetSha256": missing_digest,
            "partitionDisjoint": True,
        },
    }
    _atomic_write_bytes(stage / "recovery_report.json", _json_bytes(recovery_report))
    package_members = _inventory_stage(stage)
    package_manifest = {
        "schemaVersion": 2,
        "preservationKind": PRESERVATION_KIND,
        "quarantineReason": QUARANTINE_REASON,
        "bundleExcludes": [],
        "files": [
            {
                **row.to_dict(),
                "role": _package_role(row.path),
            }
            for row in package_members
        ],
    }
    package_manifest_bytes = _json_bytes(package_manifest)
    _atomic_write_bytes(stage / "evidence_manifest.json", package_manifest_bytes)
    return analysis, package_manifest_bytes, package_members


def _same_archive(left: ArchiveRecord, right: ArchiveRecord) -> bool:
    return (
        left.stored_sha256,
        left.stored_size,
        left.tar_sha256,
        left.tar_size,
        left.zstd_level,
    ) == (
        right.stored_sha256,
        right.stored_size,
        right.tar_sha256,
        right.tar_size,
        right.zstd_level,
    )


def _build_local_archive(
    target: IncompleteTarget,
    donors: Sequence[IncompleteTarget],
    settings: Settings,
) -> tuple[_Analysis, ArchiveRecord, bytes, list[MemberIdentity]]:
    evidence_dir = target.evidence_dir
    with tempfile.TemporaryDirectory(prefix="incomplete-evidence-stage-") as temporary:
        stage = Path(temporary) / "package"
        stage.mkdir(mode=0o700)
        analysis, package_manifest_bytes, package_members = _build_package_payloads(
            target,
            donors,
            stage,
        )
        _normalize_stage_metadata(stage)
        candidate = evidence_dir / f".{ARCHIVE_NAME}.{uuid.uuid4().hex}.candidate"
        try:
            candidate_record = _create_deterministic_tar_zst(
                stage,
                candidate,
                level=settings.evidence_zstd_level,
            )
            restored = Path(temporary) / "verified"
            restored_count = extract_verified_evidence_archive(
                candidate,
                restored,
                compression="zstd",
                expected_manifest=package_manifest_bytes,
            )
            if restored_count != len(package_members):
                raise IncompleteEvidenceQuarantineError(
                    "local forensic restore count does not match package manifest"
                )
            final_archive = evidence_dir / ARCHIVE_NAME
            if final_archive.exists() or final_archive.is_symlink():
                if not final_archive.is_file() or final_archive.is_symlink():
                    raise IncompleteEvidenceQuarantineError(
                        "existing forensic archive is not a regular file"
                    )
                existing = inspect_tar_zst(
                    final_archive,
                    level=settings.evidence_zstd_level,
                )
                if not _same_archive(existing, candidate_record):
                    raise IncompleteEvidenceQuarantineError(
                        "existing forensic archive conflicts with deterministic rebuild"
                    )
                record = existing
            else:
                os.replace(candidate, final_archive)
                descriptor = os.open(
                    evidence_dir,
                    os.O_RDONLY | getattr(os, "O_DIRECTORY", 0),
                )
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
                record = ArchiveRecord(
                    path=final_archive,
                    stored_sha256=candidate_record.stored_sha256,
                    stored_size=candidate_record.stored_size,
                    tar_sha256=candidate_record.tar_sha256,
                    tar_size=candidate_record.tar_size,
                    zstd_level=candidate_record.zstd_level,
                )
            local_manifest = evidence_dir / PACKAGE_MANIFEST_NAME
            if local_manifest.exists() or local_manifest.is_symlink():
                if (
                    not local_manifest.is_file()
                    or local_manifest.is_symlink()
                    or local_manifest.read_bytes() != package_manifest_bytes
                ):
                    raise IncompleteEvidenceQuarantineError(
                        "existing forensic package manifest conflicts with deterministic rebuild"
                    )
            else:
                _atomic_write_bytes(local_manifest, package_manifest_bytes)
            return analysis, record, package_manifest_bytes, package_members
        finally:
            candidate.unlink(missing_ok=True)


def _source_archive_rows(analysis: _Analysis) -> list[dict[str, Any]]:
    return sorted(
        analysis.source_archives,
        key=lambda row: (
            str(row["role"]),
            str(row["jobId"]),
            str(row["evidencePath"]),
            str(row["path"]),
        ),
    )


def _manifest_receipt_fields(
    target: IncompleteTarget,
    analysis: _Analysis,
    package_manifest_bytes: bytes,
    package_members: Sequence[MemberIdentity],
) -> dict[str, Any]:
    expected = [analysis.expected[path] for path in sorted(analysis.expected)]
    retained = [analysis.retained[path] for path in sorted(analysis.retained)]
    expected_count, expected_digest = _member_set_digest(expected)
    retained_count, retained_digest = _member_set_digest(
        row.identity for row in retained
    )
    missing_count, missing_digest = _member_set_digest(analysis.missing)
    package_count, package_digest = _member_set_digest(package_members)
    original_manifest_sha256 = hashlib.sha256(
        analysis.original_manifest_bytes
    ).hexdigest()
    original_count, original_digest = _member_set_digest(expected)
    return {
        "originalManifest": {
            "path": "evidence_manifest.json",
            "packagePath": "original/evidence_manifest.json",
            "sha256": original_manifest_sha256,
            "byteSize": len(analysis.original_manifest_bytes),
            "memberSetSha256": original_digest,
            "memberCount": original_count,
        },
        "packageManifest": {
            "path": PACKAGE_MANIFEST_NAME,
            "sha256": hashlib.sha256(package_manifest_bytes).hexdigest(),
            "byteSize": len(package_manifest_bytes),
            "memberSetSha256": package_digest,
            "memberCount": package_count,
        },
        "expectedMembers": [row.to_dict() for row in expected],
        "retainedMembers": [row.to_dict() for row in retained],
        "missingMembers": [row.to_dict() for row in analysis.missing],
        "packageMembers": [row.to_dict() for row in package_members],
        "sourceArchives": _source_archive_rows(analysis),
        "_digests": {
            "expectedMemberSetSha256": expected_digest,
            "expectedMemberCount": expected_count,
            "retainedMemberSetSha256": retained_digest,
            "retainedMemberCount": retained_count,
            "missingMemberSetSha256": missing_digest,
            "missingMemberCount": missing_count,
        },
    }


def _parse_identity_rows(raw: Any, label: str) -> list[MemberIdentity]:
    if not isinstance(raw, list):
        raise IncompleteEvidenceQuarantineError(f"{label} is not an array")
    rows: list[MemberIdentity] = []
    seen: set[str] = set()
    for value in raw:
        if not isinstance(value, dict):
            raise IncompleteEvidenceQuarantineError(f"{label} contains a non-object")
        try:
            raw_path = value["path"]
            if not isinstance(raw_path, str):
                raise IncompleteEvidenceQuarantineError(
                    f"{label} member path is not a string"
                )
            path = _safe_relative(raw_path, f"{label} path")
            sha256 = value["sha256"]
            if not isinstance(sha256, str):
                raise IncompleteEvidenceQuarantineError(
                    f"{label} member sha256 is not a string"
                )
            byte_size = _strict_byte_size(
                value["byteSize"], f"{label} member byteSize"
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise IncompleteEvidenceQuarantineError(f"invalid {label} identity: {exc}") from exc
        if path in seen or byte_size < 0 or not _SHA256.fullmatch(sha256):
            raise IncompleteEvidenceQuarantineError(f"invalid or duplicate {label} member: {path}")
        seen.add(path)
        rows.append(MemberIdentity(path, sha256, byte_size))
    return sorted(rows)


def _validate_receipt(
    target: IncompleteTarget,
    receipt: Mapping[str, Any],
    pointer: RemoteEvidencePointer,
    package_manifest_bytes: bytes,
) -> None:
    expected_scalars = {
        "schemaVersion": SCHEMA_VERSION,
        "preservationKind": PRESERVATION_KIND,
        "jobId": target.job_id,
        "evidencePath": target.evidence_path,
    }
    for key, expected in expected_scalars.items():
        if receipt.get(key) != expected:
            raise IncompleteEvidenceQuarantineError(f"forensic receipt mismatch for {key}")
    if receipt.get("state") not in {"awaiting_database_registration", "complete"}:
        raise IncompleteEvidenceQuarantineError("forensic receipt has an unsupported state")
    if receipt.get("remote") != pointer.to_dict():
        raise IncompleteEvidenceQuarantineError("forensic receipt remote identity does not match pointer")
    archive = receipt.get("archive")
    if archive != {
        "path": ARCHIVE_NAME,
        "storedSha256": pointer.stored_sha256,
        "storedByteSize": pointer.stored_size,
        "uncompressedTarSha256": pointer.tar_sha256,
        "uncompressedTarByteSize": pointer.tar_size,
        "zstdLevel": pointer.zstd_level,
    }:
        raise IncompleteEvidenceQuarantineError("forensic receipt archive identity does not match pointer")
    package = receipt.get("packageManifest")
    if not isinstance(package, dict):
        raise IncompleteEvidenceQuarantineError("forensic receipt lacks packageManifest")
    if (
        package.get("path") != PACKAGE_MANIFEST_NAME
        or package.get("sha256") != hashlib.sha256(package_manifest_bytes).hexdigest()
        or package.get("byteSize") != len(package_manifest_bytes)
    ):
        raise IncompleteEvidenceQuarantineError("forensic receipt package manifest identity is invalid")
    expected = _parse_identity_rows(receipt.get("expectedMembers"), "expectedMembers")
    retained = _parse_identity_rows(receipt.get("retainedMembers"), "retainedMembers")
    missing = _parse_identity_rows(receipt.get("missingMembers"), "missingMembers")
    package_members = _parse_identity_rows(receipt.get("packageMembers"), "packageMembers")
    if not expected:
        raise IncompleteEvidenceQuarantineError(
            "forensic receipt must contain at least one expected member"
        )
    if not package_members:
        raise IncompleteEvidenceQuarantineError(
            "forensic receipt must contain at least one package member"
        )
    expected_map = {row.path: row for row in expected}
    retained_map = {row.path: row for row in retained}
    missing_map = {row.path: row for row in missing}
    if set(retained_map) & set(missing_map) or set(retained_map) | set(missing_map) != set(expected_map):
        raise IncompleteEvidenceQuarantineError("forensic receipt does not conserve expected members")
    for path, row in {**retained_map, **missing_map}.items():
        if expected_map[path] != row:
            raise IncompleteEvidenceQuarantineError(f"forensic receipt changes expected identity: {path}")
    package_count, package_digest = _member_set_digest(package_members)
    if (
        package.get("memberCount") != package_count
        or package.get("memberSetSha256") != package_digest
    ):
        raise IncompleteEvidenceQuarantineError("forensic receipt package member set is invalid")
    verification = f"archive+manifest+all-members-restore:{package_count}"
    if receipt.get("verificationMode") != verification:
        raise IncompleteEvidenceQuarantineError("forensic receipt verification mode is invalid")


def _ack_registration_identity(
    receipt_path: Path,
    receipt: Mapping[str, Any],
) -> tuple[int, str]:
    if receipt.get("state") == "awaiting_database_registration":
        size, sha256 = _file_size_sha256(receipt_path)
        return size, sha256
    registration = receipt.get("registrationReceipt")
    if not isinstance(registration, dict):
        raise IncompleteEvidenceQuarantineError(
            "complete forensic receipt lacks pass-1 registration identity"
        )
    try:
        size = _strict_byte_size(
            registration["byteSize"],
            "pass-1 registration receipt byteSize",
        )
        sha256 = registration["sha256"]
    except KeyError as exc:
        raise IncompleteEvidenceQuarantineError(
            f"invalid pass-1 registration receipt identity: {exc}"
        ) from exc
    if (
        size <= 0
        or not isinstance(sha256, str)
        or not _SHA256.fullmatch(sha256)
    ):
        raise IncompleteEvidenceQuarantineError("invalid pass-1 registration receipt identity")
    return size, sha256


def _require_uuid(value: Any, label: str) -> str:
    if not isinstance(value, str):
        raise IncompleteEvidenceQuarantineError(f"database acknowledgement lacks {label}")
    try:
        parsed = uuid.UUID(value)
    except ValueError as exc:
        raise IncompleteEvidenceQuarantineError(
            f"database acknowledgement has invalid {label}"
        ) from exc
    if str(parsed) != value.lower():
        raise IncompleteEvidenceQuarantineError(
            f"database acknowledgement has noncanonical {label}"
        )
    return value


def _require_utc_timestamp(value: Any, label: str) -> str:
    if not isinstance(value, str) or value != value.strip() or "T" not in value:
        raise IncompleteEvidenceQuarantineError(f"database acknowledgement lacks {label}")
    try:
        parsed = datetime.fromisoformat(value[:-1] + "+00:00" if value.endswith("Z") else value)
    except ValueError as exc:
        raise IncompleteEvidenceQuarantineError(
            f"database acknowledgement has invalid {label}"
        ) from exc
    if parsed.tzinfo is None or parsed.utcoffset() != timedelta(0):
        raise IncompleteEvidenceQuarantineError(
            f"database acknowledgement {label} must be UTC"
        )
    return value


def _receipt_digest_fields(receipt: Mapping[str, Any]) -> dict[str, Any]:
    expected = _parse_identity_rows(receipt.get("expectedMembers"), "expectedMembers")
    retained = _parse_identity_rows(receipt.get("retainedMembers"), "retainedMembers")
    missing = _parse_identity_rows(receipt.get("missingMembers"), "missingMembers")
    package = _parse_identity_rows(receipt.get("packageMembers"), "packageMembers")
    expected_count, expected_digest = _member_set_digest(expected)
    retained_count, retained_digest = _member_set_digest(retained)
    missing_count, missing_digest = _member_set_digest(missing)
    package_count, package_digest = _member_set_digest(package)
    return {
        "expectedMemberSetSha256": expected_digest,
        "expectedMemberCount": expected_count,
        "retainedMemberSetSha256": retained_digest,
        "retainedMemberCount": retained_count,
        "missingMemberSetSha256": missing_digest,
        "missingMemberCount": missing_count,
        "packageMemberSetSha256": package_digest,
        "packageMemberCount": package_count,
    }


def _validate_database_ack(
    target: IncompleteTarget,
    receipt_path: Path,
    receipt: Mapping[str, Any],
    ack: Mapping[str, Any],
    pointer: RemoteEvidencePointer,
    package_manifest_bytes: bytes,
) -> None:
    receipt_size, receipt_sha256 = _ack_registration_identity(receipt_path, receipt)
    original = receipt.get("originalManifest")
    if not isinstance(original, dict):
        raise IncompleteEvidenceQuarantineError("forensic receipt lacks originalManifest")
    digest_fields = _receipt_digest_fields(receipt)
    expected = {
        "schemaVersion": SCHEMA_VERSION,
        "state": "incomplete_quarantined",
        "registrationKind": PRESERVATION_KIND,
        "quarantineReason": QUARANTINE_REASON,
        "jobId": target.job_id,
        "evidencePath": target.evidence_path,
        "storedSha256": pointer.stored_sha256,
        "generation": str(pointer.generation),
        "originalManifestSha256": original.get("sha256"),
        "originalManifestByteSize": original.get("byteSize"),
        **digest_fields,
        "packageManifestSha256": hashlib.sha256(package_manifest_bytes).hexdigest(),
        "packageManifestByteSize": len(package_manifest_bytes),
        "migrationReceiptSha256": receipt_sha256,
        "migrationReceiptByteSize": receipt_size,
    }
    for key, value in expected.items():
        if ack.get(key) != value:
            raise IncompleteEvidenceQuarantineError(
                f"database acknowledgement mismatch for {key}"
            )
    _require_uuid(ack.get("quarantineId"), "quarantineId")
    _require_uuid(ack.get("blobId"), "blobId")
    _require_utc_timestamp(ack.get("quarantinedAt"), "quarantinedAt")
    for forbidden in (
        "resultId",
        "resultAttemptId",
        "sourceArtifactId",
        "archiveId",
        "aoaDeg",
    ):
        if ack.get(forbidden) is not None:
            raise IncompleteEvidenceQuarantineError(
                f"incomplete evidence acknowledgement must not contain {forbidden}"
            )


def _result_from_receipt(
    target: IncompleteTarget,
    receipt: Mapping[str, Any],
    *,
    status: str,
    bytes_deleted: int = 0,
) -> QuarantineResult:
    remote = receipt["remote"]
    return QuarantineResult(
        job_id=target.job_id,
        evidence_path=target.evidence_path,
        status=status,
        expected_members=len(receipt["expectedMembers"]),
        retained_members=len(receipt["retainedMembers"]),
        missing_members=len(receipt["missingMembers"]),
        package_members=len(receipt["packageMembers"]),
        remote_bytes=int(remote["storedSize"]),
        bytes_deleted=bytes_deleted,
        object_uri=f"gs://{remote['bucket']}/{remote['objectKey']}",
        generation=str(remote["generation"]),
        verification=str(receipt["verificationMode"]),
    )


def _package_manifest_bytes(evidence_dir: Path) -> bytes:
    path = evidence_dir / PACKAGE_MANIFEST_NAME
    if not path.is_file() or path.is_symlink():
        raise IncompleteEvidenceQuarantineError(
            "forensic package manifest is unavailable or unsafe"
        )
    return path.read_bytes()


def _cleanup_paths(evidence_dir: Path) -> list[Path]:
    paths = [
        evidence_dir / CORRUPT_ARCHIVE_NAME,
        *(evidence_dir / name for name in PACKAGED_RAW_DIRS),
        evidence_dir / ARCHIVE_NAME,
    ]
    return [path for path in paths if path.exists() or path.is_symlink()]


def _require_awaiting_local_sources(
    evidence_dir: Path,
    pointer: RemoteEvidencePointer,
    *,
    zstd_level: int,
) -> None:
    corrupt = evidence_dir / CORRUPT_ARCHIVE_NAME
    archive = evidence_dir / ARCHIVE_NAME
    if not corrupt.is_file() or corrupt.is_symlink():
        raise IncompleteEvidenceQuarantineError(
            "awaiting forensic receipt lost its exact corrupt source archive"
        )
    if not archive.is_file() or archive.is_symlink():
        raise IncompleteEvidenceQuarantineError(
            "awaiting forensic receipt lost its local forensic archive"
        )
    record = inspect_tar_zst(archive, level=zstd_level)
    if (
        record.stored_sha256 != pointer.stored_sha256
        or record.stored_size != pointer.stored_size
        or record.tar_sha256 != pointer.tar_sha256
        or record.tar_size != pointer.tar_size
    ):
        raise IncompleteEvidenceQuarantineError(
            "awaiting local forensic archive does not match its remote pointer"
        )


def plan_target(
    target: IncompleteTarget,
    donors: Sequence[IncompleteTarget] = (),
) -> QuarantineResult:
    with _job_guard(target.job_root):
        try:
            _require_terminal_job(target.job_root)
        except EvidenceMigrationError as exc:
            raise IncompleteEvidenceQuarantineError(str(exc)) from exc
        with tempfile.TemporaryDirectory(prefix="incomplete-evidence-plan-") as temporary:
            stage = Path(temporary) / "package"
            stage.mkdir()
            analysis, _manifest, package_members = _build_package_payloads(
                target,
                donors,
                stage,
            )
    return QuarantineResult(
        job_id=target.job_id,
        evidence_path=target.evidence_path,
        status="planned-incomplete-quarantine",
        expected_members=len(analysis.expected),
        retained_members=len(analysis.retained),
        missing_members=len(analysis.missing),
        package_members=len(package_members),
        message=analysis.corrupt_terminal_error,
    )


def quarantine_target(
    target: IncompleteTarget,
    settings: Settings,
    *,
    donors: Sequence[IncompleteTarget] = (),
    store: EvidenceObjectStore | None = None,
) -> QuarantineResult:
    """Run or resume the exact three-pass incomplete-evidence quarantine."""

    if not settings.evidence_remote_only:
        raise IncompleteEvidenceQuarantineError(
            "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=true is required for cleanup"
        )
    try:
        _require_contained_target(target.migration_target())
    except EvidenceMigrationError as exc:
        raise IncompleteEvidenceQuarantineError(str(exc)) from exc
    store = store or _partial_store(settings)
    if store.object_prefix != PARTIAL_OBJECT_PREFIX:
        raise IncompleteEvidenceQuarantineError(
            "incomplete evidence store must use the distinct partial prefix"
        )
    with _job_guard(target.job_root):
        try:
            _require_terminal_job(target.job_root)
        except EvidenceMigrationError as exc:
            raise IncompleteEvidenceQuarantineError(str(exc)) from exc
        evidence_dir = target.evidence_dir
        receipt_path = evidence_dir / RECEIPT_NAME
        pointer_path = evidence_dir / POINTER_NAME
        ack_path = evidence_dir / DATABASE_ACK_NAME
        if receipt_path.exists() or receipt_path.is_symlink():
            if not receipt_path.is_file() or receipt_path.is_symlink():
                raise IncompleteEvidenceQuarantineError("forensic receipt is unsafe")
            if not pointer_path.is_file() or pointer_path.is_symlink():
                raise IncompleteEvidenceQuarantineError(
                    "forensic receipt lacks its exact regular remote pointer"
                )
            receipt = _read_optional_json(receipt_path)
            if receipt is None:
                raise IncompleteEvidenceQuarantineError("forensic receipt disappeared")
            pointer = read_remote_pointer(pointer_path)
            manifest_bytes = _package_manifest_bytes(evidence_dir)
            _validate_receipt(target, receipt, pointer, manifest_bytes)
            ack = _read_optional_json(ack_path)
            if ack is None:
                if receipt.get("state") == "complete":
                    raise IncompleteEvidenceQuarantineError(
                        "complete forensic receipt lacks database acknowledgement"
                    )
                _require_awaiting_local_sources(
                    evidence_dir,
                    pointer,
                    zstd_level=settings.evidence_zstd_level,
                )
                try:
                    count = store.verify_all_manifest_members(
                        pointer,
                        expected_manifest=manifest_bytes,
                    )
                except (EvidenceStoreError, OSError, ValueError) as exc:
                    raise IncompleteEvidenceQuarantineError(
                        f"forensic remote verification failed: {exc}"
                    ) from exc
                if count != len(receipt["packageMembers"]):
                    raise IncompleteEvidenceQuarantineError(
                        "forensic remote verification count changed"
                    )
                return _result_from_receipt(
                    target,
                    receipt,
                    status="awaiting-database-registration",
                )
            _validate_database_ack(
                target,
                receipt_path,
                receipt,
                ack,
                pointer,
                manifest_bytes,
            )
            if receipt.get("state") == "complete":
                if receipt.get("databaseAcknowledgement") != ack:
                    raise IncompleteEvidenceQuarantineError(
                        "complete forensic receipt database acknowledgement changed"
                    )
            try:
                count = store.verify_all_manifest_members(
                    pointer,
                    expected_manifest=manifest_bytes,
                    fresh_download=True,
                )
            except (EvidenceStoreError, OSError, ValueError) as exc:
                raise IncompleteEvidenceQuarantineError(
                    f"fresh forensic remote restore failed: {exc}"
                ) from exc
            if count != len(receipt["packageMembers"]):
                raise IncompleteEvidenceQuarantineError(
                    "fresh forensic restore count does not match receipt"
                )
            cleanup = _cleanup_paths(evidence_dir)
            bytes_before = sum(_tree_size(path) for path in cleanup)
            for path in cleanup:
                _remove_path(path)
            bytes_deleted = max(
                0,
                bytes_before - sum(_tree_size(path) for path in cleanup),
            )
            if receipt.get("state") == "complete":
                return _result_from_receipt(
                    target,
                    receipt,
                    status="already-complete",
                    bytes_deleted=bytes_deleted,
                )
            registration_size, registration_sha256 = _file_size_sha256(receipt_path)
            completed = dict(receipt)
            completed.update(
                {
                    "state": "complete",
                    "completedAt": datetime.now(timezone.utc).isoformat(),
                    "registrationReceipt": {
                        "sha256": registration_sha256,
                        "byteSize": registration_size,
                    },
                    "databaseAcknowledgement": ack,
                    "deletedPaths": sorted(
                        path.relative_to(evidence_dir).as_posix() for path in cleanup
                    ),
                    "bytesDeleted": bytes_deleted,
                }
            )
            _atomic_write_json(receipt_path, completed)
            return _result_from_receipt(
                target,
                completed,
                status="incomplete-quarantined",
                bytes_deleted=bytes_deleted,
            )

        if (evidence_dir / DATABASE_ACK_NAME).exists() or (
            evidence_dir / DATABASE_ACK_NAME
        ).is_symlink():
            raise IncompleteEvidenceQuarantineError(
                "forensic database acknowledgement exists before its receipt"
            )
        analysis, archive, manifest_bytes, package_members = _build_local_archive(
            target,
            donors,
            settings,
        )
        try:
            if pointer_path.exists() or pointer_path.is_symlink():
                if not pointer_path.is_file() or pointer_path.is_symlink():
                    raise IncompleteEvidenceQuarantineError(
                        "pre-receipt forensic pointer is unsafe"
                    )
                pointer = read_remote_pointer(pointer_path)
                if (
                    pointer.stored_sha256 != archive.stored_sha256
                    or pointer.stored_size != archive.stored_size
                    or pointer.tar_sha256 != archive.tar_sha256
                    or pointer.tar_size != archive.tar_size
                ):
                    raise IncompleteEvidenceQuarantineError(
                        "pre-receipt forensic pointer conflicts with deterministic rebuild"
                    )
                store.verify_remote_pointer(pointer)
            else:
                pointer = store.upload_archive(archive, pointer_path)
            count = store.verify_all_manifest_members(
                pointer,
                expected_manifest=manifest_bytes,
            )
        except (EvidenceStoreError, OSError, ValueError) as exc:
            if isinstance(exc, IncompleteEvidenceQuarantineError):
                raise
            raise IncompleteEvidenceQuarantineError(
                f"forensic upload/restore failed: {exc}"
            ) from exc
        if count != len(package_members):
            raise IncompleteEvidenceQuarantineError(
                "forensic remote restore count does not match package manifest"
            )
        expected_key = (
            f"{PARTIAL_OBJECT_PREFIX}/sha256/{pointer.stored_sha256[:2]}/"
            f"{pointer.stored_sha256}.tar.zst"
        )
        if pointer.object_key != expected_key:
            raise IncompleteEvidenceQuarantineError(
                "forensic pointer escaped the partial evidence prefix"
            )
        fields = _manifest_receipt_fields(
            target,
            analysis,
            manifest_bytes,
            package_members,
        )
        fields.pop("_digests", None)
        receipt: dict[str, Any] = {
            "schemaVersion": SCHEMA_VERSION,
            "state": "awaiting_database_registration",
            "preservationKind": PRESERVATION_KIND,
            "jobId": target.job_id,
            "evidencePath": target.evidence_path,
            "archive": {
                "path": ARCHIVE_NAME,
                "storedSha256": archive.stored_sha256,
                "storedByteSize": archive.stored_size,
                "uncompressedTarSha256": archive.tar_sha256,
                "uncompressedTarByteSize": archive.tar_size,
                "zstdLevel": archive.zstd_level,
            },
            "remote": pointer.to_dict(),
            **fields,
            "verificationMode": f"archive+manifest+all-members-restore:{count}",
            "verifiedAt": datetime.now(timezone.utc).isoformat(),
        }
        _validate_receipt(target, receipt, pointer, manifest_bytes)
        _atomic_write_json(receipt_path, receipt)
        return _result_from_receipt(
            target,
            receipt,
            status="awaiting-database-registration",
        )


def run_quarantine(
    settings: Settings,
    *,
    jobs_root: Path | None,
    job_id: str,
    evidence_path: str,
    donor_evidence_paths: Sequence[str] = (),
    execute: bool = False,
    store: EvidenceObjectStore | None = None,
) -> QuarantineResult:
    root = Path(jobs_root) if jobs_root is not None else settings.data_dir / "jobs"
    target = resolve_target(root, job_id, evidence_path)
    donors = [
        resolve_target(root, job_id, donor_path)
        for donor_path in sorted(set(donor_evidence_paths))
    ]
    if any(donor.evidence_path == target.evidence_path for donor in donors):
        raise IncompleteEvidenceQuarantineError(
            "incomplete target cannot be its own recovery donor"
        )
    return (
        quarantine_target(target, settings, donors=donors, store=store)
        if execute
        else plan_target(target, donors)
    )


def _parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--jobs-root", type=Path)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--evidence-path", required=True)
    parser.add_argument(
        "--donor-evidence-path",
        action="append",
        default=[],
        help="exact complete sibling evidence path under the same job",
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        result = run_quarantine(
            get_settings(),
            jobs_root=args.jobs_root,
            job_id=args.job_id,
            evidence_path=args.evidence_path,
            donor_evidence_paths=args.donor_evidence_path,
            execute=args.execute,
        )
    except Exception as exc:  # noqa: BLE001 - CLI emits one exact failure row
        print(
            json.dumps(
                {
                    "status": "failed",
                    "jobId": args.job_id,
                    "evidencePath": args.evidence_path,
                    "error": str(exc),
                },
                sort_keys=True,
            )
        )
        return 1
    print(json.dumps(result.to_dict(), sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())


__all__ = [
    "ARCHIVE_NAME",
    "DATABASE_ACK_NAME",
    "IncompleteEvidenceQuarantineError",
    "IncompleteTarget",
    "PACKAGE_MANIFEST_NAME",
    "PARTIAL_OBJECT_PREFIX",
    "POINTER_NAME",
    "PRESERVATION_KIND",
    "QuarantineResult",
    "QUARANTINE_REASON",
    "RECEIPT_NAME",
    "main",
    "plan_target",
    "quarantine_target",
    "resolve_target",
    "run_quarantine",
]
