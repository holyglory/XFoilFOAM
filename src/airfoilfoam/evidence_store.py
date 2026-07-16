"""Immutable compressed evidence storage and verified render hydration.

This module deliberately owns no retention policy.  It can create or
transcode a Zstandard archive, publish that exact archive to object storage,
and atomically persist a remote pointer only after the remote object has been
verified.  A caller may remove local evidence only after those operations
return successfully.

Render hydration is fail-closed.  The complete archive is authenticated by its
stored and uncompressed-tar SHA-256 digests, and every hydrated VTK file is
then authenticated against ``evidence_manifest.json`` before the cache entry
becomes visible.
"""

from __future__ import annotations

import base64
import contextlib
import fcntl
import gzip
import hashlib
import json
import os
import shutil
import stat
import tarfile
import tempfile
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO, Iterator, Mapping, Sequence

import google_crc32c
import zstandard


__all__ = [
    "ARCHIVE_FORMAT",
    "ARCHIVE_MIME_TYPE",
    "DEFAULT_CACHE_MAX_BYTES",
    "DEFAULT_CACHE_TTL_SECONDS",
    "DEFAULT_OBJECT_PREFIX",
    "POINTER_SCHEMA_VERSION",
    "ArchiveRecord",
    "CacheCleanupReport",
    "EvidenceArchiveError",
    "EvidenceHydrationError",
    "EvidenceObjectStore",
    "EvidenceStoreError",
    "EvidenceUploadError",
    "RemoteEvidencePointer",
    "create_tar_zst",
    "inspect_tar_zst",
    "manifest_bundle_member_set_sha256",
    "read_remote_pointer",
    "transcode_gzip_tar_to_zst",
]


POINTER_SCHEMA_VERSION = 1
ARCHIVE_FORMAT = "tar+zstd"
ARCHIVE_MIME_TYPE = "application/zstd"
DEFAULT_OBJECT_PREFIX = "solver-evidence/v1"
DEFAULT_CACHE_TTL_SECONDS = 24 * 60 * 60
DEFAULT_CACHE_MAX_BYTES = 100 * 1024**3
_BUFFER_SIZE = 1024 * 1024
_HYDRATION_MARKER = ".hydrated.json"
_LOCK_STRIPES = 4096


class EvidenceStoreError(RuntimeError):
    """Base class for evidence archive, remote-store, and hydration errors."""


class EvidenceArchiveError(EvidenceStoreError):
    """Raised when a local archive cannot be created or authenticated."""


class EvidenceUploadError(EvidenceStoreError):
    """Raised when a remote object cannot be published and verified."""


class EvidenceHydrationError(EvidenceStoreError):
    """Raised when remote or archived evidence cannot be hydrated safely."""


@dataclass(frozen=True)
class ArchiveRecord:
    """Digests and sizes for one exact ``tar.zst`` archive generation."""

    path: Path
    stored_sha256: str
    stored_size: int
    tar_sha256: str
    tar_size: int
    zstd_level: int
    format: str = ARCHIVE_FORMAT

    def __post_init__(self) -> None:
        object.__setattr__(self, "path", Path(self.path))
        _require_sha256(self.stored_sha256, "stored_sha256")
        _require_sha256(self.tar_sha256, "tar_sha256")
        if self.stored_size < 0 or self.tar_size < 0:
            raise ValueError("archive sizes must be non-negative")
        if self.format != ARCHIVE_FORMAT:
            raise ValueError(f"unsupported archive format: {self.format}")


@dataclass(frozen=True)
class RemoteEvidencePointer:
    """Versioned local pointer to an immutable remote evidence object."""

    bucket: str
    object_key: str
    generation: int
    stored_sha256: str
    stored_size: int
    tar_sha256: str
    tar_size: int
    crc32c: str
    zstd_level: int
    created_at: str
    schema_version: int = POINTER_SCHEMA_VERSION
    format: str = ARCHIVE_FORMAT

    def __post_init__(self) -> None:
        if self.schema_version != POINTER_SCHEMA_VERSION:
            raise ValueError(f"unsupported pointer schema version: {self.schema_version}")
        if not self.bucket or not self.object_key:
            raise ValueError("bucket and object_key are required")
        if self.generation <= 0:
            raise ValueError("generation must be positive")
        _require_sha256(self.stored_sha256, "stored_sha256")
        _require_sha256(self.tar_sha256, "tar_sha256")
        if self.stored_size < 0 or self.tar_size < 0:
            raise ValueError("archive sizes must be non-negative")
        if self.format != ARCHIVE_FORMAT:
            raise ValueError(f"unsupported pointer format: {self.format}")
        try:
            decoded_crc = base64.b64decode(self.crc32c, validate=True)
        except Exception as exc:  # noqa: BLE001
            raise ValueError("crc32c must be valid base64") from exc
        if len(decoded_crc) != 4:
            raise ValueError("crc32c must encode four bytes")

    def to_dict(self) -> dict[str, Any]:
        return {
            "schemaVersion": self.schema_version,
            "format": self.format,
            "bucket": self.bucket,
            "objectKey": self.object_key,
            # GCS generations routinely exceed JavaScript's safe-integer
            # range.  JSON crosses the Node control plane, so preserve the
            # exact decimal identity as a string.
            "generation": str(self.generation),
            "storedSha256": self.stored_sha256,
            "storedSize": self.stored_size,
            "tarSha256": self.tar_sha256,
            "tarSize": self.tar_size,
            "crc32c": self.crc32c,
            "zstdLevel": self.zstd_level,
            "createdAt": self.created_at,
        }

    @classmethod
    def from_dict(cls, payload: Mapping[str, Any]) -> "RemoteEvidencePointer":
        try:
            return cls(
                schema_version=int(payload["schemaVersion"]),
                format=str(payload["format"]),
                bucket=str(payload["bucket"]),
                object_key=str(payload["objectKey"]),
                generation=int(payload["generation"]),
                stored_sha256=str(payload["storedSha256"]),
                stored_size=int(payload["storedSize"]),
                tar_sha256=str(payload["tarSha256"]),
                tar_size=int(payload["tarSize"]),
                crc32c=str(payload["crc32c"]),
                zstd_level=int(payload["zstdLevel"]),
                created_at=str(payload["createdAt"]),
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise ValueError(f"invalid evidence pointer: {exc}") from exc


@dataclass(frozen=True)
class CacheCleanupReport:
    """Result of one bounded render-cache cleanup pass."""

    entries_removed: int = 0
    bytes_removed: int = 0
    bytes_remaining: int = 0


class _DigestWriter:
    def __init__(self, raw: BinaryIO):
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


class _DigestReader:
    def __init__(self, raw: BinaryIO, *, max_size: int | None = None):
        self.raw = raw
        self.digest = hashlib.sha256()
        self.size = 0
        self.max_size = max_size

    def read(self, size: int = -1) -> bytes:
        data = self.raw.read(size)
        if data:
            self.digest.update(data)
            self.size += len(data)
            if self.max_size is not None and self.size > self.max_size:
                raise EvidenceHydrationError("uncompressed tar exceeds the size recorded in its pointer")
        return data

    def readable(self) -> bool:
        return True

    def hexdigest(self) -> str:
        return self.digest.hexdigest()


def create_tar_zst(
    source_dir: Path,
    destination: Path,
    *,
    level: int = 10,
    exclude_names: Sequence[str] = (),
) -> ArchiveRecord:
    """Create an atomic lossless ``tar.zst`` from children of ``source_dir``.

    Paths are stored relative to ``source_dir``.  Top-level names in
    ``exclude_names`` are omitted, which lets callers avoid archiving the
    destination itself or separately stored incompressible media.
    """

    source_dir = Path(source_dir)
    destination = Path(destination)
    if not source_dir.is_dir():
        raise FileNotFoundError(source_dir)
    excluded = set(exclude_names)
    if any(not name or "/" in name or "\\" in name for name in excluded):
        raise ValueError("exclude_names must contain top-level names only")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = _temporary_sibling(destination)
    try:
        with temporary.open("wb") as raw_output:
            stored_writer = _DigestWriter(raw_output)
            compressor = zstandard.ZstdCompressor(level=level)
            with compressor.stream_writer(stored_writer, closefd=False) as compressed:
                tar_writer = _DigestWriter(compressed)
                with tarfile.open(fileobj=tar_writer, mode="w|", format=tarfile.PAX_FORMAT) as archive:
                    for child in sorted(source_dir.iterdir(), key=lambda item: item.name):
                        if child.name in excluded:
                            continue
                        if child.resolve() in {destination.resolve(), temporary.resolve()}:
                            continue
                        archive.add(child, arcname=child.name, recursive=True)
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
        _fsync_directory(destination.parent)
        return record
    except Exception as exc:
        temporary.unlink(missing_ok=True)
        if isinstance(exc, (FileNotFoundError, ValueError)):
            raise
        raise EvidenceArchiveError(f"could not create {destination}: {exc}") from exc


def transcode_gzip_tar_to_zst(
    gzip_archive: Path,
    destination: Path,
    *,
    level: int = 10,
) -> ArchiveRecord:
    """Stream a gzip archive to Zstandard without changing one tar byte."""

    gzip_archive = Path(gzip_archive)
    destination = Path(destination)
    if not gzip_archive.is_file():
        raise FileNotFoundError(gzip_archive)
    if gzip_archive.resolve() == destination.resolve():
        raise ValueError("source and destination must differ")
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = _temporary_sibling(destination)
    tar_digest = hashlib.sha256()
    tar_size = 0
    try:
        with gzip.open(gzip_archive, "rb") as source, temporary.open("wb") as raw_output:
            stored_writer = _DigestWriter(raw_output)
            compressor = zstandard.ZstdCompressor(level=level)
            with compressor.stream_writer(stored_writer, closefd=False) as compressed:
                while True:
                    chunk = source.read(_BUFFER_SIZE)
                    if not chunk:
                        break
                    tar_digest.update(chunk)
                    tar_size += len(chunk)
                    compressed.write(chunk)
            raw_output.flush()
            os.fsync(raw_output.fileno())
        record = ArchiveRecord(
            path=destination,
            stored_sha256=stored_writer.hexdigest(),
            stored_size=stored_writer.size,
            tar_sha256=tar_digest.hexdigest(),
            tar_size=tar_size,
            zstd_level=level,
        )
        os.replace(temporary, destination)
        _fsync_directory(destination.parent)
        return record
    except Exception as exc:
        temporary.unlink(missing_ok=True)
        if isinstance(exc, (FileNotFoundError, ValueError)):
            raise
        raise EvidenceArchiveError(f"could not transcode {gzip_archive}: {exc}") from exc


def inspect_tar_zst(path: Path, *, level: int = 10) -> ArchiveRecord:
    """Authenticate an existing tar.zst and return its exact archive record."""

    path = Path(path)
    if not path.is_file():
        raise FileNotFoundError(path)
    try:
        stored_size, stored_sha256 = _size_and_sha256(path)
        tar_size, tar_sha256 = _zstd_tar_digest(path)
        return ArchiveRecord(
            path=path,
            stored_sha256=stored_sha256,
            stored_size=stored_size,
            tar_sha256=tar_sha256,
            tar_size=tar_size,
            zstd_level=level,
        )
    except (FileNotFoundError, ValueError, EvidenceArchiveError):
        raise
    except Exception as exc:  # noqa: BLE001
        raise EvidenceArchiveError(f"cannot inspect {path}: {exc}") from exc


def read_remote_pointer(path: Path) -> RemoteEvidencePointer:
    """Read and strictly validate a versioned pointer JSON file."""

    try:
        payload = json.loads(Path(path).read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise EvidenceStoreError(f"cannot read evidence pointer {path}: {exc}") from exc
    if not isinstance(payload, dict):
        raise EvidenceStoreError(f"evidence pointer {path} is not an object")
    try:
        return RemoteEvidencePointer.from_dict(payload)
    except ValueError as exc:
        raise EvidenceStoreError(f"cannot read evidence pointer {path}: {exc}") from exc


class EvidenceObjectStore:
    """GCS-backed immutable archive store with a verified local render cache.

    ``client`` is injectable; omitting it uses Google Application Default
    Credentials through ``google.cloud.storage.Client``.
    """

    def __init__(
        self,
        bucket: str,
        cache_root: Path,
        *,
        client: Any | None = None,
        object_prefix: str = DEFAULT_OBJECT_PREFIX,
        cache_ttl_seconds: float = DEFAULT_CACHE_TTL_SECONDS,
        cache_max_bytes: int = DEFAULT_CACHE_MAX_BYTES,
        timeout_seconds: float = 900,
    ) -> None:
        if not bucket:
            raise ValueError("bucket is required")
        if cache_ttl_seconds < 0 or cache_max_bytes < 0:
            raise ValueError("cache limits must be non-negative")
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be positive")
        self.bucket_name = bucket
        self.cache_root = Path(cache_root)
        self.object_prefix = object_prefix.strip("/")
        if not self.object_prefix:
            raise ValueError("object_prefix is required")
        self.cache_ttl_seconds = cache_ttl_seconds
        self.cache_max_bytes = cache_max_bytes
        self.timeout_seconds = timeout_seconds
        try:
            self.cache_root.mkdir(parents=True, exist_ok=True, mode=0o700)
            self._lock_root.mkdir(parents=True, exist_ok=True, mode=0o700)
        except OSError as exc:
            raise EvidenceStoreError(
                f"could not initialize evidence hydration cache {self.cache_root}: {exc}"
            ) from exc
        if client is None:
            try:
                from google.cloud import storage
            except ImportError as exc:  # pragma: no cover - dependency contract
                raise EvidenceStoreError("google-cloud-storage is not installed") from exc
            try:
                client = storage.Client()
            except Exception as exc:  # noqa: BLE001 - provider credential errors vary
                raise EvidenceStoreError(
                    "could not initialize the GCS evidence client from Application Default Credentials"
                ) from exc
        self.client = client

    @property
    def _lock_root(self) -> Path:
        return self.cache_root / ".locks"

    def object_key(self, archive: ArchiveRecord) -> str:
        """Return the content-addressed key for an exact stored archive."""

        digest = archive.stored_sha256
        return f"{self.object_prefix}/sha256/{digest[:2]}/{digest}.tar.zst"

    def upload_archive(self, archive: ArchiveRecord, pointer_path: Path) -> RemoteEvidencePointer:
        """Conditionally publish ``archive`` and atomically write its pointer.

        The source archive is never removed.  If the content-addressed object
        already exists, all immutable metadata is validated and the operation
        succeeds idempotently.  Any upload or validation failure leaves an
        existing pointer file untouched.
        """

        self._verify_local_archive(archive)
        crc32c = _crc32c_file(archive.path)
        object_key = self.object_key(archive)
        bucket = self.client.bucket(self.bucket_name)
        blob = bucket.blob(object_key)
        expected_metadata = _archive_metadata(archive)
        blob.metadata = dict(expected_metadata)
        # Do not rely on host-specific mimetype tables for ``.zst``.  The
        # canonical object is a Zstandard stream and its immutable remote
        # metadata must say so on both a fresh upload and an idempotent replay.
        blob.content_type = ARCHIVE_MIME_TYPE
        try:
            blob.upload_from_filename(
                str(archive.path),
                if_generation_match=0,
                checksum="crc32c",
                timeout=self.timeout_seconds,
            )
        except Exception as exc:  # noqa: BLE001
            if not _is_precondition_failed(exc):
                raise EvidenceUploadError(f"upload failed for gs://{self.bucket_name}/{object_key}: {exc}") from exc

        try:
            blob.reload(timeout=self.timeout_seconds)
            generation = _positive_int(getattr(blob, "generation", None), "generation")
            self._verify_blob(
                blob,
                expected_size=archive.stored_size,
                expected_crc32c=crc32c,
                expected_metadata=expected_metadata,
                expected_generation=generation,
            )
        except Exception as exc:  # noqa: BLE001
            if isinstance(exc, EvidenceUploadError):
                raise
            raise EvidenceUploadError(
                f"remote verification failed for gs://{self.bucket_name}/{object_key}: {exc}"
            ) from exc

        pointer = RemoteEvidencePointer(
            bucket=self.bucket_name,
            object_key=object_key,
            generation=generation,
            stored_sha256=archive.stored_sha256,
            stored_size=archive.stored_size,
            tar_sha256=archive.tar_sha256,
            tar_size=archive.tar_size,
            crc32c=crc32c,
            zstd_level=archive.zstd_level,
            created_at=datetime.now(timezone.utc).isoformat(),
        )
        try:
            _atomic_write_json(Path(pointer_path), pointer.to_dict())
        except OSError as exc:
            # The remote generation is durable, but callers still need the
            # exact local pointer before they can register or hydrate it.  Do
            # not leak a provider-independent filesystem exception past the
            # evidence-store boundary or let a caller mistake this for a
            # completed publication.
            raise EvidenceStoreError(
                f"could not persist the verified remote evidence pointer at {pointer_path}: {exc}"
            ) from exc
        return pointer

    def materialize_remote_archive(
        self,
        pointer: RemoteEvidencePointer | Path,
        destination: Path,
    ) -> Path:
        """Stream one pinned GCS generation to an atomically published file."""

        pointer = self._coerce_pointer(pointer)
        self._require_own_bucket(pointer)
        destination = Path(destination)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = _temporary_sibling(destination)
        try:
            blob = self.client.bucket(pointer.bucket).blob(pointer.object_key)
            blob.reload(timeout=self.timeout_seconds)
            self._verify_blob_against_pointer(blob, pointer)
            blob.download_to_filename(
                str(temporary),
                if_generation_match=pointer.generation,
                checksum="crc32c",
                timeout=self.timeout_seconds,
            )
            actual_size, actual_sha256 = _size_and_sha256(temporary)
            if actual_size != pointer.stored_size or actual_sha256 != pointer.stored_sha256:
                raise EvidenceHydrationError("downloaded archive size or SHA-256 does not match pointer")
            if _crc32c_file(temporary) != pointer.crc32c:
                raise EvidenceHydrationError("downloaded archive CRC32C does not match pointer")
            os.replace(temporary, destination)
            _fsync_directory(destination.parent)
            return destination
        except Exception as exc:  # noqa: BLE001
            temporary.unlink(missing_ok=True)
            if isinstance(exc, EvidenceHydrationError):
                raise
            raise EvidenceHydrationError(
                f"could not materialize gs://{pointer.bucket}/{pointer.object_key}: {exc}"
            ) from exc

    def verify_remote_pointer(
        self,
        pointer: RemoteEvidencePointer | Path,
    ) -> RemoteEvidencePointer:
        """Verify that one exact immutable generation still matches its pointer.

        This is the bounded reconciliation check for an archive whose local
        packaged bytes have already been removed.  It deliberately reloads
        GCS metadata instead of trusting a hydration-cache entry.
        """

        pointer = self._coerce_pointer(pointer)
        self._require_own_bucket(pointer)
        try:
            blob = self.client.bucket(pointer.bucket).blob(pointer.object_key)
            blob.reload(timeout=self.timeout_seconds)
            self._verify_blob_against_pointer(blob, pointer)
            return pointer
        except Exception as exc:  # noqa: BLE001 - provider errors vary
            if isinstance(exc, EvidenceHydrationError):
                raise
            raise EvidenceHydrationError(
                "remote object metadata does not match the pinned evidence pointer "
                f"for gs://{pointer.bucket}/{pointer.object_key}: {exc}"
            ) from exc

    def verify_all_manifest_members(
        self,
        pointer: RemoteEvidencePointer | Path,
        *,
        expected_manifest: bytes | None = None,
        fresh_download: bool = False,
    ) -> int:
        """Authenticate and read every manifest-listed member.

        Destructive retention callers use ``fresh_download=True`` so the proof
        is tied to a new generation-pinned GCS download immediately before
        local cleanup.  Merely authenticating the compressed object or its VTK
        subset is insufficient: logs, dictionaries, mesh files, force history,
        and time directories are equally immutable result evidence.
        """

        pointer = self._coerce_pointer(pointer)
        self._require_own_bucket(pointer)
        if fresh_download:
            with tempfile.TemporaryDirectory(
                prefix="evidence-all-members-restore-"
            ) as temporary:
                archive_path = self.materialize_remote_archive(
                    pointer,
                    Path(temporary) / "engine_evidence.tar.zst",
                )
                return _verify_archive_manifest_members(
                    archive_path,
                    pointer,
                    expected_manifest=expected_manifest,
                )
        with self.archive_source(pointer) as archive_path:
            return _verify_archive_manifest_members(
                archive_path,
                pointer,
                expected_manifest=expected_manifest,
            )

    def hydrate(self, pointer: RemoteEvidencePointer | Path) -> Path:
        """Return a verified content-addressed VTK cache directory."""

        pointer = self._coerce_pointer(pointer)
        with self._entry_lock(pointer.tar_sha256, exclusive=True):
            return self._ensure_hydrated_locked(pointer)

    def materialize_member(
        self,
        pointer: RemoteEvidencePointer | Path,
        member_path: str,
    ) -> Path:
        """Return one verified archive member in the bounded local cache."""

        pointer = self._coerce_pointer(pointer)
        normalized = _safe_tar_path(member_path).as_posix()
        with self._entry_lock(pointer.tar_sha256, exclusive=True):
            return self._ensure_member_locked(pointer, normalized)

    @contextlib.contextmanager
    def archive_source(self, pointer: RemoteEvidencePointer | Path) -> Iterator[Path]:
        """Yield the verified compressed archive while preventing eviction."""

        pointer = self._coerce_pointer(pointer)
        lock_path = self._lock_path(pointer.tar_sha256)
        entry: Path | None = None
        try:
            with lock_path.open("a+b") as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    archive_path = self._ensure_cached_archive_locked(pointer)
                    entry = archive_path.parent
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_SH)
                    _touch_cache_entry(entry)
                    yield archive_path
                finally:
                    if entry is not None:
                        _touch_cache_entry(entry)
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            self.cleanup_cache()

    @contextlib.contextmanager
    def member_source(
        self,
        pointer: RemoteEvidencePointer | Path,
        member_path: str,
    ) -> Iterator[Path]:
        """Yield one verified member while preventing concurrent eviction."""

        pointer = self._coerce_pointer(pointer)
        normalized = _safe_tar_path(member_path).as_posix()
        lock_path = self._lock_path(pointer.tar_sha256)
        entry: Path | None = None
        try:
            with lock_path.open("a+b") as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    member = self._ensure_member_locked(pointer, normalized)
                    entry = self.cache_root / pointer.tar_sha256
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_SH)
                    _touch_cache_entry(entry)
                    yield member
                finally:
                    if entry is not None:
                        _touch_cache_entry(entry)
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            self.cleanup_cache()

    @contextlib.contextmanager
    def render_source(self, pointer: RemoteEvidencePointer | Path) -> Iterator[Path]:
        """Yield verified VTK evidence while preventing concurrent eviction."""

        pointer = self._coerce_pointer(pointer)
        lock_path = self._lock_path(pointer.tar_sha256)
        entry: Path | None = None
        try:
            with lock_path.open("a+b") as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)
                try:
                    entry = self._ensure_hydrated_locked(pointer)
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_SH)
                    _touch(entry / _HYDRATION_MARKER)
                    yield entry
                finally:
                    if entry is not None:
                        _touch(entry / _HYDRATION_MARKER)
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        finally:
            self.cleanup_cache()

    def cleanup_cache(self, *, now: float | None = None) -> CacheCleanupReport:
        """Evict expired entries, then least-recently-used entries to the cap."""

        current_time = time.time() if now is None else now
        candidates: list[tuple[float, Path, int, str]] = []
        for entry in self.cache_root.iterdir():
            if not entry.is_dir() or entry.is_symlink():
                continue
            digest = _cache_entry_digest(entry.name)
            if digest is None:
                continue
            if entry.name.startswith("."):
                try:
                    accessed = entry.stat().st_mtime
                except OSError:
                    continue
            else:
                marker = entry / _HYDRATION_MARKER
                try:
                    accessed = marker.stat().st_mtime
                except OSError:
                    try:
                        accessed = entry.stat().st_mtime
                    except OSError:
                        continue
            candidates.append((accessed, entry, _tree_size(entry), digest))
        total = sum(size for _accessed, _entry, size, _digest in candidates)
        removed_entries = 0
        removed_bytes = 0
        for accessed, entry, size, digest in sorted(
            candidates,
            key=lambda item: item[0],
        ):
            expired = current_time - accessed > self.cache_ttl_seconds
            over_cap = total > self.cache_max_bytes
            if not expired and not over_cap:
                continue
            # Extraction/member stages are created while this same digest lock
            # is held.  A non-blocking exclusive acquisition distinguishes an
            # abandoned crash artifact from an active extraction, including
            # when the cache is already over its byte cap.
            lock_path = self._lock_path(digest)
            with lock_path.open("a+b") as lock_file:
                try:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    continue
                try:
                    if entry.is_dir() and not entry.is_symlink():
                        shutil.rmtree(entry)
                        total -= size
                        removed_entries += 1
                        removed_bytes += size
                finally:
                    fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)
        return CacheCleanupReport(
            entries_removed=removed_entries,
            bytes_removed=removed_bytes,
            bytes_remaining=max(total, 0),
        )

    def _ensure_hydrated_locked(self, pointer: RemoteEvidencePointer) -> Path:
        self._require_own_bucket(pointer)
        entry = self.cache_root / pointer.tar_sha256
        if entry.is_dir():
            try:
                _validate_hydrated_entry(entry, pointer)
                _touch(entry / _HYDRATION_MARKER)
                return entry
            except EvidenceHydrationError:
                # Keep only a subsequently re-verified compressed archive;
                # partial VTK/member state never survives a failed check.
                for name in ("VTK", "evidence_manifest.json", _HYDRATION_MARKER):
                    _remove_unsafe_cache_path(entry / name)
        elif entry.exists() or entry.is_symlink():
            _remove_unsafe_cache_path(entry)

        stage = self.cache_root / f".{pointer.tar_sha256}.{uuid.uuid4().hex}.stage"
        stage.mkdir(mode=0o700)
        try:
            archive_path = self._ensure_cached_archive_locked(pointer)
            _extract_and_verify_vtk(archive_path, stage, pointer)
            marker = {
                "schemaVersion": POINTER_SCHEMA_VERSION,
                "tarSha256": pointer.tar_sha256,
                "tarSize": pointer.tar_size,
                "storedSha256": pointer.stored_sha256,
                "generation": pointer.generation,
                "hydratedAt": datetime.now(timezone.utc).isoformat(),
            }
            _atomic_write_json(stage / _HYDRATION_MARKER, marker)
            _validate_hydrated_entry(stage, pointer)
            entry.mkdir(mode=0o700, exist_ok=True)
            for name in ("VTK", "evidence_manifest.json", _HYDRATION_MARKER):
                source = stage / name
                destination = entry / name
                _remove_unsafe_cache_path(destination)
                os.replace(source, destination)
            _fsync_directory(self.cache_root)
            _touch(entry / _HYDRATION_MARKER)
            return entry
        except Exception as exc:  # noqa: BLE001
            shutil.rmtree(stage, ignore_errors=True)
            shutil.rmtree(entry, ignore_errors=True)
            if isinstance(exc, EvidenceHydrationError):
                raise
            raise EvidenceHydrationError(f"could not hydrate {pointer.object_key}: {exc}") from exc
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    def _ensure_cached_archive_locked(self, pointer: RemoteEvidencePointer) -> Path:
        self._require_own_bucket(pointer)
        entry = self.cache_root / pointer.tar_sha256
        if entry.exists() and (not entry.is_dir() or entry.is_symlink()):
            _remove_unsafe_cache_path(entry)
        entry.mkdir(mode=0o700, exist_ok=True)
        archive_path = entry / "engine_evidence.tar.zst"
        if archive_path.is_file() and not archive_path.is_symlink():
            actual_size, actual_sha256 = _size_and_sha256(archive_path)
            if (
                actual_size == pointer.stored_size
                and actual_sha256 == pointer.stored_sha256
                and _crc32c_file(archive_path) == pointer.crc32c
            ):
                _touch_cache_entry(entry)
                return archive_path
            archive_path.unlink(missing_ok=True)
        elif archive_path.exists() or archive_path.is_symlink():
            _remove_unsafe_cache_path(archive_path)
        self.materialize_remote_archive(pointer, archive_path)
        _touch_cache_entry(entry)
        return archive_path

    def _ensure_member_locked(
        self,
        pointer: RemoteEvidencePointer,
        member_path: str,
    ) -> Path:
        self._require_own_bucket(pointer)
        normalized = _safe_tar_path(member_path).as_posix()
        entry = self.cache_root / pointer.tar_sha256
        target = entry.joinpath(*PurePosixPath(normalized).parts)
        manifest_path = entry / "evidence_manifest.json"
        if (
            normalized != "evidence_manifest.json"
            and target.is_file()
            and not target.is_symlink()
            and manifest_path.is_file()
        ):
            try:
                _verify_manifest_member(entry, normalized)
                _touch_cache_entry(entry)
                return target
            except EvidenceHydrationError:
                _remove_unsafe_cache_path(target)

        archive_path = self._ensure_cached_archive_locked(pointer)
        stage = self.cache_root / f".{pointer.tar_sha256}.{uuid.uuid4().hex}.member"
        stage.mkdir(mode=0o700)
        try:
            _extract_and_verify_member(archive_path, stage, pointer, normalized)
            staged_manifest = stage / "evidence_manifest.json"
            staged_target = stage.joinpath(*PurePosixPath(normalized).parts)
            if normalized == "evidence_manifest.json":
                manifest_path.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged_manifest, manifest_path)
                _touch_cache_entry(entry)
                return manifest_path
            if manifest_path.is_file():
                if manifest_path.read_bytes() != staged_manifest.read_bytes():
                    # A cache assembled from this immutable archive must have
                    # one exact manifest.  A mismatch means the whole entry is
                    # unsafe to reuse.
                    shutil.rmtree(entry)
                    entry.mkdir(mode=0o700)
            else:
                manifest_path.parent.mkdir(parents=True, exist_ok=True)
                os.replace(staged_manifest, manifest_path)
            target = entry.joinpath(*PurePosixPath(normalized).parts)
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            os.replace(staged_target, target)
            _verify_manifest_member(entry, normalized)
            _touch_cache_entry(entry)
            return target
        except Exception:
            if target.exists() or target.is_symlink():
                _remove_unsafe_cache_path(target)
            raise
        finally:
            shutil.rmtree(stage, ignore_errors=True)

    @contextlib.contextmanager
    def _entry_lock(self, digest: str, *, exclusive: bool) -> Iterator[None]:
        lock_path = self._lock_path(digest)
        with lock_path.open("a+b") as lock_file:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH)
            try:
                yield
            finally:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)

    def _lock_path(self, digest: str) -> Path:
        _require_sha256(digest, "cache digest")
        # Lock-file identity must remain stable while any process may hold it,
        # so per-digest lock files cannot be safely unlinked during eviction.
        # A fixed stripe set bounds inode growth for campaign-scale archives;
        # the small amount of unrelated serialization on a hash collision is
        # preferable to hundreds of thousands of permanent lock dentries.
        stripe = int(digest[:8], 16) % _LOCK_STRIPES
        return self._lock_root / f"stripe-{stripe:03x}.lock"

    @staticmethod
    def _coerce_pointer(pointer: RemoteEvidencePointer | Path) -> RemoteEvidencePointer:
        return read_remote_pointer(pointer) if isinstance(pointer, Path) else pointer

    def _require_own_bucket(self, pointer: RemoteEvidencePointer) -> None:
        if pointer.bucket != self.bucket_name:
            raise EvidenceHydrationError(
                f"pointer bucket {pointer.bucket!r} does not match store bucket {self.bucket_name!r}"
            )
        expected_key = (
            f"{self.object_prefix}/sha256/{pointer.stored_sha256[:2]}/"
            f"{pointer.stored_sha256}.tar.zst"
        )
        if pointer.object_key != expected_key:
            raise EvidenceHydrationError(
                "pointer object key does not match the configured content-addressed evidence prefix"
            )

    @staticmethod
    def _verify_local_archive(archive: ArchiveRecord) -> None:
        if not archive.path.is_file():
            raise EvidenceUploadError(f"archive does not exist: {archive.path}")
        size, sha256 = _size_and_sha256(archive.path)
        if size != archive.stored_size or sha256 != archive.stored_sha256:
            raise EvidenceUploadError("local archive size or SHA-256 does not match its record")
        tar_size, tar_sha256 = _zstd_tar_digest(archive.path)
        if tar_size != archive.tar_size or tar_sha256 != archive.tar_sha256:
            raise EvidenceUploadError("local uncompressed tar size or SHA-256 does not match its record")

    @staticmethod
    def _verify_blob(
        blob: Any,
        *,
        expected_size: int,
        expected_crc32c: str,
        expected_metadata: Mapping[str, str],
        expected_generation: int,
    ) -> None:
        if _positive_int(getattr(blob, "generation", None), "generation") != expected_generation:
            raise EvidenceUploadError("remote generation changed during validation")
        if _nonnegative_int(getattr(blob, "size", None), "size") != expected_size:
            raise EvidenceUploadError("remote size does not match local archive")
        if str(getattr(blob, "crc32c", "")) != expected_crc32c:
            raise EvidenceUploadError("remote CRC32C does not match local archive")
        if str(getattr(blob, "content_type", "")) != ARCHIVE_MIME_TYPE:
            raise EvidenceUploadError(
                f"remote content type must be {ARCHIVE_MIME_TYPE}"
            )
        actual_metadata = getattr(blob, "metadata", None)
        if not isinstance(actual_metadata, Mapping):
            raise EvidenceUploadError("remote metadata is missing")
        for key, expected in expected_metadata.items():
            if str(actual_metadata.get(key, "")) != expected:
                raise EvidenceUploadError(f"remote metadata mismatch for {key}")

    def _verify_blob_against_pointer(self, blob: Any, pointer: RemoteEvidencePointer) -> None:
        expected = {
            "airfoilfoam-schema-version": str(POINTER_SCHEMA_VERSION),
            "format": pointer.format,
            "stored-sha256": pointer.stored_sha256,
            "stored-size": str(pointer.stored_size),
            "tar-sha256": pointer.tar_sha256,
            "tar-size": str(pointer.tar_size),
            "zstd-level": str(pointer.zstd_level),
        }
        self._verify_blob(
            blob,
            expected_size=pointer.stored_size,
            expected_crc32c=pointer.crc32c,
            expected_metadata=expected,
            expected_generation=pointer.generation,
        )


def _archive_metadata(archive: ArchiveRecord) -> dict[str, str]:
    return {
        "airfoilfoam-schema-version": str(POINTER_SCHEMA_VERSION),
        "format": archive.format,
        "stored-sha256": archive.stored_sha256,
        "stored-size": str(archive.stored_size),
        "tar-sha256": archive.tar_sha256,
        "tar-size": str(archive.tar_size),
        "zstd-level": str(archive.zstd_level),
    }


def _cache_entry_digest(name: str) -> str | None:
    """Return the owning digest for a cache entry or extraction stage."""

    if not name.startswith("."):
        try:
            _require_sha256(name, "cache entry name")
        except ValueError:
            return None
        return name
    parts = name.split(".")
    if (
        len(parts) != 4
        or parts[0] != ""
        or parts[3] not in {"stage", "member"}
        or len(parts[2]) != 32
        or any(character not in "0123456789abcdef" for character in parts[2])
    ):
        return None
    try:
        _require_sha256(parts[1], "cache stage digest")
    except ValueError:
        return None
    return parts[1]


def _extract_and_verify_vtk(
    archive_path: Path,
    stage: Path,
    pointer: RemoteEvidencePointer,
) -> None:
    seen_archive_paths: set[str] = set()
    selected_files: set[str] = set()
    try:
        with Path(archive_path).open("rb") as compressed:
            decompressor = zstandard.ZstdDecompressor()
            with decompressor.stream_reader(compressed, read_across_frames=True) as raw_tar:
                digest_reader = _DigestReader(raw_tar, max_size=pointer.tar_size)
                with tarfile.open(fileobj=digest_reader, mode="r|") as archive:
                    for member in archive:
                        member_path = _safe_tar_path(member.name)
                        normalized = member_path.as_posix()
                        if normalized in seen_archive_paths:
                            raise EvidenceHydrationError(f"duplicate archive member: {normalized}")
                        seen_archive_paths.add(normalized)
                        if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                            raise EvidenceHydrationError(f"unsafe archive member type: {normalized}")
                        if not (member.isdir() or member.isfile()):
                            raise EvidenceHydrationError(f"unsupported archive member type: {normalized}")
                        selected = (
                            normalized == "evidence_manifest.json"
                            or normalized == "VTK"
                            or normalized.startswith("VTK/")
                        )
                        if not selected:
                            continue
                        destination = stage.joinpath(*member_path.parts)
                        if member.isdir():
                            destination.mkdir(parents=True, exist_ok=True, mode=0o700)
                            continue
                        source = archive.extractfile(member)
                        if source is None:
                            raise EvidenceHydrationError(f"cannot read archive member: {normalized}")
                        if member.size > pointer.tar_size:
                            raise EvidenceHydrationError(
                                f"archive member exceeds the recorded tar size: {normalized}"
                            )
                        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                        with destination.open("xb") as output:
                            shutil.copyfileobj(source, output, length=_BUFFER_SIZE)
                        os.chmod(destination, 0o600)
                        selected_files.add(normalized)
                while digest_reader.read(_BUFFER_SIZE):
                    pass
                tar_size = digest_reader.size
                tar_sha256 = digest_reader.hexdigest()
    except EvidenceHydrationError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise EvidenceHydrationError(f"cannot read Zstandard evidence archive: {exc}") from exc
    if tar_size != pointer.tar_size or tar_sha256 != pointer.tar_sha256:
        raise EvidenceHydrationError("uncompressed tar size or SHA-256 does not match pointer")
    if "evidence_manifest.json" not in selected_files:
        raise EvidenceHydrationError("archive has no evidence_manifest.json")
    _verify_vtk_manifest(stage)


def _extract_and_verify_member(
    archive_path: Path,
    stage: Path,
    pointer: RemoteEvidencePointer,
    requested_path: str,
) -> None:
    """Extract one regular file plus its manifest and authenticate the tar."""

    normalized_request = _safe_tar_path(requested_path).as_posix()
    selected_files: set[str] = set()
    seen_archive_paths: set[str] = set()
    try:
        with Path(archive_path).open("rb") as compressed:
            decompressor = zstandard.ZstdDecompressor()
            with decompressor.stream_reader(compressed, read_across_frames=True) as raw_tar:
                digest_reader = _DigestReader(raw_tar, max_size=pointer.tar_size)
                with tarfile.open(fileobj=digest_reader, mode="r|") as archive:
                    for member in archive:
                        member_path = _safe_tar_path(member.name)
                        normalized = member_path.as_posix()
                        if normalized in seen_archive_paths:
                            raise EvidenceHydrationError(f"duplicate archive member: {normalized}")
                        seen_archive_paths.add(normalized)
                        if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                            raise EvidenceHydrationError(f"unsafe archive member type: {normalized}")
                        if not (member.isdir() or member.isfile()):
                            raise EvidenceHydrationError(f"unsupported archive member type: {normalized}")
                        if normalized not in {normalized_request, "evidence_manifest.json"}:
                            continue
                        if not member.isfile():
                            raise EvidenceHydrationError(
                                f"requested archive member is not a regular file: {normalized}"
                            )
                        source = archive.extractfile(member)
                        if source is None:
                            raise EvidenceHydrationError(f"cannot read archive member: {normalized}")
                        if member.size > pointer.tar_size:
                            raise EvidenceHydrationError(
                                f"archive member exceeds the recorded tar size: {normalized}"
                            )
                        destination = stage.joinpath(*member_path.parts)
                        destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                        with destination.open("xb") as output:
                            shutil.copyfileobj(source, output, length=_BUFFER_SIZE)
                        os.chmod(destination, 0o600)
                        selected_files.add(normalized)
                while digest_reader.read(_BUFFER_SIZE):
                    pass
                tar_size = digest_reader.size
                tar_sha256 = digest_reader.hexdigest()
    except EvidenceHydrationError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise EvidenceHydrationError(f"cannot read Zstandard evidence archive: {exc}") from exc
    if tar_size != pointer.tar_size or tar_sha256 != pointer.tar_sha256:
        raise EvidenceHydrationError("uncompressed tar size or SHA-256 does not match pointer")
    if normalized_request not in selected_files:
        raise EvidenceHydrationError(f"archive member is unavailable: {normalized_request}")
    if "evidence_manifest.json" not in selected_files:
        raise EvidenceHydrationError("archive has no evidence_manifest.json")
    if normalized_request != "evidence_manifest.json":
        _verify_manifest_member(stage, normalized_request)


def _verify_archive_manifest_members(
    archive_path: Path,
    pointer: RemoteEvidencePointer,
    *,
    expected_manifest: bytes | None = None,
) -> int:
    """Stream-authenticate one archive and every file named by its manifest."""

    seen_archive_paths: set[str] = set()
    actual_files: dict[str, tuple[int, str]] = {}
    restored_manifest: bytes | None = None
    try:
        with Path(archive_path).open("rb") as compressed:
            decompressor = zstandard.ZstdDecompressor()
            with decompressor.stream_reader(
                compressed, read_across_frames=True
            ) as raw_tar:
                digest_reader = _DigestReader(raw_tar, max_size=pointer.tar_size)
                with tarfile.open(fileobj=digest_reader, mode="r|") as archive:
                    for member in archive:
                        member_path = _safe_tar_path(member.name)
                        normalized = member_path.as_posix()
                        if normalized in seen_archive_paths:
                            raise EvidenceHydrationError(
                                f"duplicate archive member: {normalized}"
                            )
                        seen_archive_paths.add(normalized)
                        if (
                            member.issym()
                            or member.islnk()
                            or member.isdev()
                            or member.isfifo()
                        ):
                            raise EvidenceHydrationError(
                                f"unsafe archive member type: {normalized}"
                            )
                        if member.isdir():
                            continue
                        if not member.isfile():
                            raise EvidenceHydrationError(
                                f"unsupported archive member type: {normalized}"
                            )
                        if member.size > pointer.tar_size:
                            raise EvidenceHydrationError(
                                "archive member exceeds the recorded tar size: "
                                f"{normalized}"
                            )
                        source = archive.extractfile(member)
                        if source is None:
                            raise EvidenceHydrationError(
                                f"cannot read archive member: {normalized}"
                            )
                        member_digest = hashlib.sha256()
                        member_size = 0
                        manifest_chunks: list[bytes] | None = (
                            [] if normalized == "evidence_manifest.json" else None
                        )
                        while True:
                            chunk = source.read(_BUFFER_SIZE)
                            if not chunk:
                                break
                            member_digest.update(chunk)
                            member_size += len(chunk)
                            if member_size > member.size:
                                raise EvidenceHydrationError(
                                    f"archive member exceeds its header size: {normalized}"
                                )
                            if manifest_chunks is not None:
                                manifest_chunks.append(chunk)
                        if member_size != member.size:
                            raise EvidenceHydrationError(
                                f"archive member size does not match its header: {normalized}"
                            )
                        actual_files[normalized] = (
                            member_size,
                            member_digest.hexdigest(),
                        )
                        if manifest_chunks is not None:
                            restored_manifest = b"".join(manifest_chunks)
                while digest_reader.read(_BUFFER_SIZE):
                    pass
                tar_size = digest_reader.size
                tar_sha256 = digest_reader.hexdigest()
    except EvidenceHydrationError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise EvidenceHydrationError(
            f"cannot read Zstandard evidence archive: {exc}"
        ) from exc
    if tar_size != pointer.tar_size or tar_sha256 != pointer.tar_sha256:
        raise EvidenceHydrationError(
            "uncompressed tar size or SHA-256 does not match pointer"
        )
    if restored_manifest is None:
        raise EvidenceHydrationError("archive has no evidence_manifest.json")
    if expected_manifest is not None and restored_manifest != expected_manifest:
        raise EvidenceHydrationError(
            "restored evidence manifest does not match local manifest"
        )
    expected_files = _manifest_expected_files_payload(restored_manifest)
    excluded_roots = _manifest_bundle_excludes_payload(restored_manifest)
    bundled_expected_files = {
        relative: expected
        for relative, expected in expected_files.items()
        if relative.split("/", 1)[0] not in excluded_roots
    }
    for relative, expected in bundled_expected_files.items():
        actual = actual_files.get(relative)
        if actual is None:
            raise EvidenceHydrationError(
                f"manifest member missing from archive: {relative}"
            )
        if actual != expected:
            raise EvidenceHydrationError(
                f"archive member failed manifest verification: {relative}"
            )
    return len(bundled_expected_files)


def _manifest_expected_files(root: Path) -> dict[str, tuple[int, str]]:
    manifest_path = root / "evidence_manifest.json"
    try:
        payload = manifest_path.read_bytes()
    except Exception as exc:  # noqa: BLE001
        raise EvidenceHydrationError(f"evidence manifest is invalid: {exc}") from exc
    return _manifest_expected_files_payload(payload)


def _manifest_expected_files_payload(
    payload: bytes,
) -> dict[str, tuple[int, str]]:
    try:
        manifest = json.loads(payload)
    except Exception as exc:  # noqa: BLE001
        raise EvidenceHydrationError(f"evidence manifest is invalid: {exc}") from exc
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, list):
        raise EvidenceHydrationError("evidence manifest has no files list")
    expected: dict[str, tuple[int, str]] = {}
    for item in files:
        if not isinstance(item, dict):
            raise EvidenceHydrationError("evidence manifest contains a non-object file entry")
        try:
            relative = _safe_tar_path(str(item["path"])).as_posix()
            size = int(item["byteSize"])
            sha256 = str(item["sha256"])
            _require_sha256(sha256, f"manifest SHA-256 for {relative}")
        except (KeyError, TypeError, ValueError, EvidenceHydrationError) as exc:
            raise EvidenceHydrationError(f"invalid evidence manifest entry: {exc}") from exc
        if size < 0:
            raise EvidenceHydrationError(f"invalid evidence size for {relative}")
        if relative in expected:
            raise EvidenceHydrationError(f"duplicate evidence manifest entry: {relative}")
        expected[relative] = (size, sha256)
    return expected


def _manifest_bundle_excludes_payload(payload: bytes) -> set[str]:
    try:
        manifest = json.loads(payload)
    except Exception as exc:  # noqa: BLE001
        raise EvidenceHydrationError(f"evidence manifest is invalid: {exc}") from exc
    raw = manifest.get("bundleExcludes", []) if isinstance(manifest, dict) else []
    if not isinstance(raw, list):
        raise EvidenceHydrationError("evidence manifest bundleExcludes is not a list")
    excluded: set[str] = set()
    for item in raw:
        if not isinstance(item, str) or not item or "/" in item or "\\" in item:
            raise EvidenceHydrationError(
                f"unsafe evidence manifest bundle exclusion: {item!r}"
            )
        normalized = _safe_tar_path(item).as_posix()
        if normalized in excluded:
            raise EvidenceHydrationError(
                f"duplicate evidence manifest bundle exclusion: {normalized}"
            )
        excluded.add(normalized)
    return excluded


def manifest_bundle_member_set_sha256(payload: bytes) -> tuple[int, str]:
    """Return count/digest for manifest + every non-excluded bundle member."""

    expected = _manifest_expected_files_payload(payload)
    excluded = _manifest_bundle_excludes_payload(payload)
    rows = [
        (
            "evidence_manifest.json",
            hashlib.sha256(payload).hexdigest(),
            len(payload),
        ),
        *[
            (path, sha256, size)
            for path, (size, sha256) in expected.items()
            if path.split("/", 1)[0] not in excluded
        ],
    ]
    digest = hashlib.sha256()
    for path, sha256, size in sorted(rows):
        digest.update(path.encode("utf-8"))
        digest.update(b"\0")
        digest.update(sha256.encode("ascii"))
        digest.update(b"\0")
        digest.update(str(size).encode("ascii"))
        digest.update(b"\n")
    return len(rows), digest.hexdigest()


def _verify_manifest_member(root: Path, member_path: str) -> None:
    normalized = _safe_tar_path(member_path).as_posix()
    expected = _manifest_expected_files(root).get(normalized)
    if expected is None:
        raise EvidenceHydrationError(f"archive member is missing from manifest: {normalized}")
    path = root.joinpath(*PurePosixPath(normalized).parts)
    if not path.is_file() or path.is_symlink():
        raise EvidenceHydrationError(f"hydrated archive member is unavailable: {normalized}")
    actual_size, actual_sha256 = _size_and_sha256(path)
    if (actual_size, actual_sha256) != expected:
        raise EvidenceHydrationError(f"archive member failed manifest verification: {normalized}")


def _validate_hydrated_entry(entry: Path, pointer: RemoteEvidencePointer) -> None:
    marker_path = entry / _HYDRATION_MARKER
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise EvidenceHydrationError(f"hydration marker is missing or invalid: {exc}") from exc
    expected = {
        "schemaVersion": POINTER_SCHEMA_VERSION,
        "tarSha256": pointer.tar_sha256,
        "tarSize": pointer.tar_size,
        "storedSha256": pointer.stored_sha256,
        "generation": pointer.generation,
    }
    for key, value in expected.items():
        if marker.get(key) != value:
            raise EvidenceHydrationError(f"hydration marker mismatch for {key}")
    _verify_vtk_manifest(entry)


def _verify_vtk_manifest(root: Path) -> None:
    manifest_path = root / "evidence_manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        raise EvidenceHydrationError(f"evidence manifest is invalid: {exc}") from exc
    files = manifest.get("files") if isinstance(manifest, dict) else None
    if not isinstance(files, list):
        raise EvidenceHydrationError("evidence manifest has no files list")
    expected: dict[str, tuple[int, str]] = {}
    for item in files:
        if not isinstance(item, dict):
            raise EvidenceHydrationError("evidence manifest contains a non-object file entry")
        try:
            relative = _safe_tar_path(str(item["path"])).as_posix()
        except (KeyError, EvidenceHydrationError) as exc:
            raise EvidenceHydrationError(f"unsafe evidence manifest path: {exc}") from exc
        if not relative.startswith("VTK/"):
            continue
        if relative in expected:
            raise EvidenceHydrationError(f"duplicate VTK manifest entry: {relative}")
        try:
            size = int(item["byteSize"])
            sha256 = str(item["sha256"])
            _require_sha256(sha256, f"manifest SHA-256 for {relative}")
        except (KeyError, TypeError, ValueError) as exc:
            raise EvidenceHydrationError(f"invalid VTK manifest entry {relative}: {exc}") from exc
        if size < 0:
            raise EvidenceHydrationError(f"invalid VTK size for {relative}")
        expected[relative] = (size, sha256)
    if not expected:
        raise EvidenceHydrationError("evidence manifest contains no VTK files")

    actual: dict[str, Path] = {}
    vtk_root = root / "VTK"
    if not vtk_root.is_dir() or vtk_root.is_symlink():
        raise EvidenceHydrationError("hydrated evidence has no safe VTK directory")
    for path in vtk_root.rglob("*"):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            raise EvidenceHydrationError(f"hydrated evidence contains a symlink: {relative}")
        if path.is_file():
            actual[relative] = path
        elif not path.is_dir():
            raise EvidenceHydrationError(f"hydrated evidence contains an unsafe file: {relative}")
    missing = sorted(set(expected) - set(actual))
    extra = sorted(set(actual) - set(expected))
    if missing:
        raise EvidenceHydrationError(f"VTK member missing from archive: {missing[0]}")
    if extra:
        raise EvidenceHydrationError(f"VTK member missing from manifest: {extra[0]}")
    for relative, path in actual.items():
        size, sha256 = expected[relative]
        actual_size, actual_sha256 = _size_and_sha256(path)
        if actual_size != size or actual_sha256 != sha256:
            raise EvidenceHydrationError(f"VTK member failed manifest verification: {relative}")


def _safe_tar_path(name: str) -> PurePosixPath:
    if not name or "\\" in name:
        raise EvidenceHydrationError(f"unsafe archive path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise EvidenceHydrationError(f"unsafe archive path: {name!r}")
    return path


def _zstd_tar_digest(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    try:
        with Path(path).open("rb") as source:
            with zstandard.ZstdDecompressor().stream_reader(source, read_across_frames=True) as reader:
                while True:
                    chunk = reader.read(_BUFFER_SIZE)
                    if not chunk:
                        break
                    digest.update(chunk)
                    size += len(chunk)
    except Exception as exc:  # noqa: BLE001
        raise EvidenceArchiveError(f"cannot decompress {path}: {exc}") from exc
    return size, digest.hexdigest()


def _size_and_sha256(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with Path(path).open("rb") as source:
        while True:
            chunk = source.read(_BUFFER_SIZE)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _crc32c_file(path: Path) -> str:
    checksum = google_crc32c.Checksum()
    with Path(path).open("rb") as source:
        while True:
            chunk = source.read(_BUFFER_SIZE)
            if not chunk:
                break
            checksum.update(chunk)
    return base64.b64encode(checksum.digest()).decode("ascii")


def _atomic_write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = _temporary_sibling(path)
    try:
        with temporary.open("x", encoding="utf-8") as output:
            json.dump(payload, output, indent=2, sort_keys=True)
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def _temporary_sibling(path: Path) -> Path:
    return path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _require_sha256(value: str, name: str) -> None:
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise ValueError(f"{name} must be a lowercase hexadecimal SHA-256")


def _positive_int(value: Any, name: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise EvidenceUploadError(f"remote {name} is invalid") from exc
    if parsed <= 0:
        raise EvidenceUploadError(f"remote {name} is invalid")
    return parsed


def _nonnegative_int(value: Any, name: str) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise EvidenceUploadError(f"remote {name} is invalid") from exc
    if parsed < 0:
        raise EvidenceUploadError(f"remote {name} is invalid")
    return parsed


def _is_precondition_failed(exc: Exception) -> bool:
    code = getattr(exc, "code", None)
    code = code() if callable(code) else code
    return code == 412 or exc.__class__.__name__ == "PreconditionFailed"


def _touch(path: Path) -> None:
    try:
        os.utime(path, None)
    except OSError:
        pass


def _touch_cache_entry(entry: Path) -> None:
    marker = entry / _HYDRATION_MARKER
    _touch(marker if marker.exists() else entry)


def _remove_unsafe_cache_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)
    elif path.exists():
        path.unlink(missing_ok=True)


def _tree_size(root: Path) -> int:
    total = 0
    for directory, dirs, files in os.walk(root, followlinks=False):
        dirs[:] = [name for name in dirs if not (Path(directory) / name).is_symlink()]
        for name in files:
            path = Path(directory) / name
            try:
                mode = path.lstat().st_mode
                if stat.S_ISREG(mode):
                    total += path.stat().st_size
            except OSError:
                continue
    return total
