"""Cross-process driver for the incomplete-evidence quarantine contract test.

This helper deliberately injects only the GCS client boundary.  Packaging,
pointer creation, upload verification, all-member restore, acknowledgement
validation, and cleanup all run through the production Python implementation.
The fake object store is filesystem-backed so pass 3 must reopen the exact
object and generation created by the separate pass-1 process.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import shutil
import tarfile
import tempfile
from pathlib import Path, PurePosixPath
from typing import Any

import google_crc32c

from airfoilfoam.config import Settings
from airfoilfoam.evidence_incomplete_quarantine import (
    PARTIAL_OBJECT_PREFIX,
    POINTER_NAME,
    quarantine_target,
    resolve_target,
)
from airfoilfoam.evidence_store import EvidenceObjectStore


GENERATION = 18_000_000_000_000_000_001
TARGET_EVIDENCE_PATH = "cases/c0p05_u30/a19/evidence"
DONOR_EVIDENCE_PATH = "cases/c0p05_u30/a18/evidence"


class _PreconditionFailed(Exception):
    code = 412


def _safe_parts(value: str, label: str) -> tuple[str, ...]:
    if (
        not value
        or value.startswith("/")
        or "\\" in value
        or "\0" in value
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise ValueError(f"unsafe {label}: {value!r}")
    return tuple(PurePosixPath(value).parts)


def _sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _crc32c(payload: bytes) -> str:
    return base64.b64encode(google_crc32c.Checksum(payload).digest()).decode(
        "ascii"
    )


class _DurableBlob:
    def __init__(
        self,
        client: "_DurableClient",
        bucket_name: str,
        object_name: str,
    ) -> None:
        self.client = client
        self.bucket_name = bucket_name
        self.name = object_name
        self.metadata: dict[str, str] | None = None
        self.content_type: str | None = None
        self.crc32c: str | None = None
        self.generation: int | None = None
        self.size: int | None = None

    def _paths(self) -> tuple[Path, Path]:
        bucket_parts = _safe_parts(self.bucket_name, "bucket")
        object_parts = _safe_parts(self.name, "object name")
        data_path = self.client.root.joinpath("objects", *bucket_parts, *object_parts)
        metadata_path = self.client.root.joinpath(
            "metadata", *bucket_parts, *object_parts
        ).with_suffix(data_path.suffix + ".json")
        return data_path, metadata_path

    def _read_record(self) -> tuple[bytes, dict[str, Any], Path, Path]:
        data_path, metadata_path = self._paths()
        data = data_path.read_bytes()
        record = json.loads(metadata_path.read_text(encoding="utf-8"))
        if not isinstance(record, dict):
            raise RuntimeError("durable fake GCS metadata is not an object")
        if int(record.get("size", -1)) != len(data):
            raise RuntimeError("durable fake GCS byte size changed")
        if record.get("sha256") != _sha256(data):
            raise RuntimeError("durable fake GCS object digest changed")
        return data, record, data_path, metadata_path

    def _load(self, data: bytes, record: dict[str, Any]) -> None:
        metadata = record.get("metadata")
        if not isinstance(metadata, dict):
            raise RuntimeError("durable fake GCS custom metadata is invalid")
        self.metadata = {str(key): str(value) for key, value in metadata.items()}
        self.content_type = str(record["contentType"])
        self.crc32c = str(record["crc32c"])
        self.generation = int(record["generation"])
        self.size = len(data)

    def upload_from_filename(
        self,
        filename: str,
        *,
        if_generation_match: int,
        checksum: str,
        timeout: float,
    ) -> None:
        if if_generation_match != 0 or checksum != "crc32c" or timeout <= 0:
            raise AssertionError("unexpected production upload contract")
        data_path, metadata_path = self._paths()
        if data_path.exists() or metadata_path.exists():
            raise _PreconditionFailed("immutable object already exists")
        payload = Path(filename).read_bytes()
        record = {
            "schemaVersion": 1,
            "bucket": self.bucket_name,
            "objectKey": self.name,
            "generation": GENERATION,
            "size": len(payload),
            "sha256": _sha256(payload),
            "crc32c": _crc32c(payload),
            "contentType": str(self.content_type or ""),
            "metadata": dict(self.metadata or {}),
            "uploadCount": 1,
            "downloadCount": 0,
        }
        data_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            dir=data_path.parent,
            prefix=f".{data_path.name}.",
            delete=False,
        ) as temporary:
            temporary.write(payload)
            temporary.flush()
            os.fsync(temporary.fileno())
            temporary_data = Path(temporary.name)
        temporary_metadata = metadata_path.with_name(
            f".{metadata_path.name}.{os.getpid()}.tmp"
        )
        try:
            temporary_metadata.write_text(
                json.dumps(record, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            os.replace(temporary_data, data_path)
            os.replace(temporary_metadata, metadata_path)
        finally:
            temporary_data.unlink(missing_ok=True)
            temporary_metadata.unlink(missing_ok=True)
        self._load(payload, record)

    def reload(self, *, timeout: float) -> None:
        if timeout <= 0:
            raise AssertionError("unexpected production reload contract")
        data, record, _data_path, _metadata_path = self._read_record()
        self._load(data, record)

    def download_to_filename(
        self,
        filename: str,
        *,
        if_generation_match: int,
        checksum: str,
        timeout: float,
    ) -> None:
        if checksum != "crc32c" or timeout <= 0:
            raise AssertionError("unexpected production download contract")
        data, record, _data_path, metadata_path = self._read_record()
        if int(record["generation"]) != int(if_generation_match):
            raise _PreconditionFailed("generation changed")
        if record["crc32c"] != _crc32c(data):
            raise RuntimeError("durable fake GCS CRC32C changed")
        record["downloadCount"] = int(record.get("downloadCount", 0)) + 1
        metadata_path.write_text(
            json.dumps(record, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        Path(filename).write_bytes(data)
        self._load(data, record)


class _DurableBucket:
    def __init__(self, client: "_DurableClient", name: str) -> None:
        self.client = client
        self.name = name

    def blob(self, name: str) -> _DurableBlob:
        return _DurableBlob(self.client, self.name, name)


class _DurableClient:
    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)

    def bucket(self, name: str) -> _DurableBucket:
        return _DurableBucket(self, name)

    def object_stats(self, bucket: str, object_name: str) -> dict[str, Any]:
        blob = _DurableBlob(self, bucket, object_name)
        data, record, data_path, metadata_path = blob._read_record()
        return {
            **record,
            "dataPath": str(data_path),
            "metadataPath": str(metadata_path),
            "actualSize": len(data),
            "actualSha256": _sha256(data),
        }


def _manifest(
    files: dict[str, bytes],
    *,
    excluded: dict[str, bytes] | None = None,
) -> bytes:
    excluded = excluded or {}
    rows = [
        {
            "path": path,
            "byteSize": len(data),
            "sha256": _sha256(data),
            "role": "cross-language-contract-fixture",
        }
        for path, data in sorted({**files, **excluded}.items())
    ]
    return (
        json.dumps(
            {
                "schemaVersion": 1,
                "bundleExcludes": ["frames"] if excluded else [],
                "files": rows,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    ).encode("utf-8")


def _write_tree(root: Path, files: dict[str, bytes]) -> None:
    for relative, payload in files.items():
        destination = root.joinpath(*_safe_parts(relative, "fixture path"))
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(payload)


def _gzip_bundle(
    evidence_dir: Path,
    files: dict[str, bytes],
    manifest: bytes,
    *,
    truncate: bool,
) -> bytes:
    _write_tree(evidence_dir, files)
    (evidence_dir / "evidence_manifest.json").write_bytes(manifest)
    archive_path = evidence_dir / "openfoam_evidence.tar.gz"
    with tarfile.open(archive_path, "w:gz") as archive:
        archive.add(
            evidence_dir / "evidence_manifest.json",
            arcname="evidence_manifest.json",
        )
        for root_name in sorted({path.split("/", 1)[0] for path in files}):
            archive.add(evidence_dir / root_name, arcname=root_name)
    payload = archive_path.read_bytes()
    if truncate:
        payload = payload[:-8]
        archive_path.write_bytes(payload)
    return payload


def _create_fixture(media_root: Path, job_id: str) -> dict[str, Any]:
    jobs_root = media_root / "jobs"
    job_root = jobs_root / job_id
    target_dir = job_root.joinpath(*PurePosixPath(TARGET_EVIDENCE_PATH).parts)
    donor_dir = job_root.joinpath(*PurePosixPath(DONOR_EVIDENCE_PATH).parts)
    target_dir.mkdir(parents=True)
    donor_dir.mkdir(parents=True)
    (job_root / "status.json").write_text(
        json.dumps({"state": "cancelled"}), encoding="utf-8"
    )
    (job_root / "result.json").write_text(
        json.dumps({"state": "cancelled"}), encoding="utf-8"
    )

    vtk = b"cross-language authenticated local VTK\x00\xff"
    donor_log = b"cross-language authenticated sibling OpenFOAM log\n"
    missing = b"cross-language unrecoverable transient U field"
    excluded_frame = b"cross-language excluded rendered frame"
    operator_note = b"cross-language unmanifested operator note"
    expected = {
        "VTK/value.vtu": vtk,
        "openfoam/logs/log.a19": donor_log,
        "time_directories/33000/U": missing,
    }
    target_manifest = _manifest(
        expected,
        excluded={"frames/vorticity/f0001.png": excluded_frame},
    )
    corrupt_bytes = _gzip_bundle(
        target_dir,
        {"VTK/value.vtu": vtk},
        target_manifest,
        truncate=True,
    )
    _write_tree(
        target_dir,
        {
            "openfoam/operator-note.bin": operator_note,
            "frames/vorticity/f0001.png": excluded_frame,
        },
    )
    donor_manifest = _manifest({"openfoam/logs/log.a19": donor_log})
    donor_archive = _gzip_bundle(
        donor_dir,
        {"openfoam/logs/log.a19": donor_log},
        donor_manifest,
        truncate=False,
    )
    return {
        "targetEvidencePath": TARGET_EVIDENCE_PATH,
        "donorEvidencePath": DONOR_EVIDENCE_PATH,
        "corruptArchiveSha256": _sha256(corrupt_bytes),
        "corruptArchiveByteSize": len(corrupt_bytes),
        "targetManifestSha256": _sha256(target_manifest),
        "targetManifestByteSize": len(target_manifest),
        "vtkSha256": _sha256(vtk),
        "donorLogSha256": _sha256(donor_log),
        "missingSha256": _sha256(missing),
        "operatorNoteSha256": _sha256(operator_note),
        "excludedFrameSha256": _sha256(excluded_frame),
        "donorArchiveSha256": _sha256(donor_archive),
    }


def _settings(media_root: Path, bucket: str) -> Settings:
    return Settings(
        data_dir=media_root,
        evidence_bucket=bucket,
        evidence_remote_only=True,
        evidence_hydration_cache_dir=media_root / "evidence-contract-cache",
        evidence_hydration_cache_max_gb=0.1,
        evidence_hydration_cache_ttl_seconds=60,
        evidence_gcs_timeout_seconds=30,
        control_plane_token="cross-language-contract-token-at-least-32-bytes",
    )


def _store(
    media_root: Path,
    object_root: Path,
    bucket: str,
) -> tuple[EvidenceObjectStore, _DurableClient]:
    client = _DurableClient(object_root)
    store = EvidenceObjectStore(
        bucket,
        media_root / "evidence-contract-cache",
        client=client,
        object_prefix=PARTIAL_OBJECT_PREFIX,
        cache_ttl_seconds=60,
        cache_max_bytes=100 * 1024 * 1024,
        timeout_seconds=30,
    )
    return store, client


def _run(args: argparse.Namespace) -> dict[str, Any]:
    media_root = Path(args.media_root).resolve()
    object_root = Path(args.object_root).resolve()
    jobs_root = media_root / "jobs"
    fixture: dict[str, Any] | None = None
    if args.phase == "pass1":
        fixture = _create_fixture(media_root, args.job_id)
    store, client = _store(media_root, object_root, args.bucket)
    target = resolve_target(jobs_root, args.job_id, TARGET_EVIDENCE_PATH)
    donors = []
    if args.phase == "pass1":
        donors = [resolve_target(jobs_root, args.job_id, DONOR_EVIDENCE_PATH)]
    result = quarantine_target(
        target,
        _settings(media_root, args.bucket),
        donors=donors,
        store=store,
    )
    pointer = json.loads(
        (target.evidence_dir / POINTER_NAME).read_text(encoding="utf-8")
    )
    return {
        "phase": args.phase,
        "result": result.to_dict(),
        "fixture": fixture,
        "object": client.object_stats(
            str(pointer["bucket"]), str(pointer["objectKey"])
        ),
        "processId": os.getpid(),
    }


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser()
    parser.add_argument("--phase", choices=("pass1", "pass3"), required=True)
    parser.add_argument("--media-root", required=True)
    parser.add_argument("--object-root", required=True)
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--bucket", required=True)
    return parser


if __name__ == "__main__":
    print(json.dumps(_run(_parser().parse_args()), sort_keys=True))
