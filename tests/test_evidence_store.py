from __future__ import annotations

import base64
import fcntl
import gzip
import hashlib
import io
import json
import tarfile
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import google_crc32c
import pytest
import zstandard

from airfoilfoam import evidence_store
from airfoilfoam.evidence_store import (
    ARCHIVE_FORMAT,
    ArchiveRecord,
    EvidenceHydrationError,
    EvidenceObjectStore,
    EvidenceStoreError,
    EvidenceUploadError,
    RemoteEvidencePointer,
    create_tar_zst,
    extract_verified_evidence_archive,
    inspect_tar_zst,
    manifest_bundle_member_set_sha256,
    read_remote_pointer,
    transcode_gzip_tar_to_zst,
)
from airfoilfoam.config import Settings
from airfoilfoam.evidence_runtime import (
    BROKERED_LOCAL_RECLAIM_INTENT_NAME,
    BROKERED_LOCAL_RECLAIM_RECEIPT_NAME,
    EVIDENCE_FINALIZATION_ACK_NAME,
    EVIDENCE_FINALIZATION_RECEIPT_NAME,
    EvidenceCleanupAuthorization,
    EvidenceCleanupError,
    EvidenceDatabaseAssociation,
    EvidencePublication,
    BrokeredRemoteEvidenceReclaim,
    finalize_remote_evidence_cleanup,
    reclaim_brokered_remote_evidence,
    verify_remote_evidence_restore,
)


class FakePreconditionFailed(Exception):
    code = 412


def test_default_gcs_client_initialization_failure_is_a_recoverable_storage_error(
    tmp_path: Path, monkeypatch
) -> None:
    from google.cloud import storage

    def fail_client():
        raise RuntimeError("simulated missing Application Default Credentials")

    monkeypatch.setattr(storage, "Client", fail_client)

    with pytest.raises(EvidenceStoreError, match="Application Default Credentials"):
        EvidenceObjectStore("test-bucket", tmp_path / "cache")


@dataclass
class _StoredObject:
    data: bytes
    metadata: dict[str, str]
    content_type: str
    crc32c: str
    generation: int


class _FakeBlob:
    def __init__(self, client: "_FakeStorageClient", bucket: str, name: str):
        self.client = client
        self.bucket_name = bucket
        self.name = name
        self.metadata: dict[str, str] | None = None
        self.content_type: str | None = None
        self.crc32c: str | None = None
        self.generation: int | None = None
        self.size: int | None = None

    @property
    def _identity(self) -> tuple[str, str]:
        return self.bucket_name, self.name

    def upload_from_filename(
        self,
        filename: str,
        *,
        if_generation_match: int,
        checksum: str,
        timeout: float,
    ) -> None:
        self.client.upload_attempts += 1
        assert if_generation_match == 0
        assert checksum == "crc32c"
        assert timeout > 0
        if self.client.fail_upload:
            raise RuntimeError("simulated upload failure")
        if self._identity in self.client.objects:
            raise FakePreconditionFailed("already exists")
        data = Path(filename).read_bytes()
        checksum_value = google_crc32c.Checksum(data).digest()
        stored = _StoredObject(
            data=data,
            metadata=dict(self.metadata or {}),
            content_type=str(self.content_type or ""),
            crc32c=base64.b64encode(checksum_value).decode("ascii"),
            generation=self.client.next_generation,
        )
        self.client.next_generation += 1
        self.client.objects[self._identity] = stored
        self._load(stored)

    def reload(self, *, timeout: float) -> None:
        assert timeout > 0
        self._load(self.client.objects[self._identity])

    def download_to_filename(
        self,
        filename: str,
        *,
        if_generation_match: int,
        checksum: str,
        timeout: float,
    ) -> None:
        assert checksum == "crc32c"
        assert timeout > 0
        stored = self.client.objects[self._identity]
        if stored.generation != if_generation_match:
            raise FakePreconditionFailed("generation changed")
        self.client.downloads += 1
        if self.client.download_delay:
            time.sleep(self.client.download_delay)
        Path(filename).write_bytes(stored.data)

    def _load(self, stored: _StoredObject) -> None:
        self.metadata = dict(stored.metadata)
        self.content_type = stored.content_type
        self.crc32c = stored.crc32c
        self.generation = stored.generation
        self.size = len(stored.data)


class _FakeBucket:
    def __init__(self, client: "_FakeStorageClient", name: str):
        self.client = client
        self.name = name

    def blob(self, name: str) -> _FakeBlob:
        return _FakeBlob(self.client, self.name, name)


class _FakeStorageClient:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], _StoredObject] = {}
        self.next_generation = 1
        self.upload_attempts = 0
        self.downloads = 0
        self.download_delay = 0.0
        self.fail_upload = False

    def bucket(self, name: str) -> _FakeBucket:
        return _FakeBucket(self, name)


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _write_source_tree(root: Path) -> dict[str, bytes]:
    vtk_files = {
        "VTK/a.vtu": b"vtk-one\n",
        "VTK/nested/b.vtu": b"vtk-two\x00\xff",
        "VTK/c.series": b'{"files": []}',
    }
    for relative, payload in vtk_files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    (root / "openfoam" / "logs").mkdir(parents=True)
    (root / "openfoam" / "logs" / "log.simpleFoam").write_text("solver log\n")
    manifest = {
        "schemaVersion": 2,
        "files": [
            {"path": relative, "byteSize": len(payload), "sha256": _sha(payload), "role": "vtk_window"}
            for relative, payload in sorted(vtk_files.items())
        ]
        + [
            {
                "path": "openfoam/logs/log.simpleFoam",
                "byteSize": 11,
                "sha256": _sha(b"solver log\n"),
                "role": "log",
            }
        ],
    }
    (root / "evidence_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return vtk_files


def _decompress_zstd(path: Path) -> bytes:
    with path.open("rb") as source:
        with zstandard.ZstdDecompressor().stream_reader(source, read_across_frames=True) as reader:
            return reader.read()


def _record_from_tar_bytes(path: Path, tar_bytes: bytes, *, level: int = 3) -> ArchiveRecord:
    compressed = zstandard.ZstdCompressor(level=level).compress(tar_bytes)
    path.write_bytes(compressed)
    return ArchiveRecord(
        path=path,
        stored_sha256=_sha(compressed),
        stored_size=len(compressed),
        tar_sha256=_sha(tar_bytes),
        tar_size=len(tar_bytes),
        zstd_level=level,
    )


def _tar_with_members(members: list[tuple[tarfile.TarInfo, bytes | None]]) -> bytes:
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for info, payload in members:
            if payload is not None:
                info.size = len(payload)
                archive.addfile(info, io.BytesIO(payload))
            else:
                archive.addfile(info)
    return output.getvalue()


def _valid_manifest(vtk_files: dict[str, bytes]) -> bytes:
    return json.dumps(
        {
            "schemaVersion": 2,
            "files": [
                {"path": path, "byteSize": len(payload), "sha256": _sha(payload)}
                for path, payload in sorted(vtk_files.items())
            ],
        }
    ).encode()


def _publish_record(
    tmp_path: Path,
    record: ArchiveRecord,
    client: _FakeStorageClient,
) -> tuple[EvidenceObjectStore, RemoteEvidencePointer]:
    store = EvidenceObjectStore("test-bucket", tmp_path / "cache", client=client)
    pointer = store.upload_archive(record, tmp_path / "pointer.json")
    assert client.objects[("test-bucket", pointer.object_key)].content_type == "application/zstd"
    return store, pointer


def _cleanup_fixture(tmp_path: Path):
    job_root = tmp_path / "jobs" / "11111111-1111-4111-8111-111111111111"
    evidence = job_root / "cases" / "case-1" / "evidence"
    evidence.mkdir(parents=True)
    _write_source_tree(evidence)
    frame = evidence / "frames" / "pressure" / "f0000.png"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"real-frame")
    manifest_path = evidence / "evidence_manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["bundleExcludes"] = ["frames"]
    manifest["files"].append(
        {
            "path": "frames/pressure/f0000.png",
            "byteSize": len(b"real-frame"),
            "sha256": _sha(b"real-frame"),
            "role": "frame_image",
        }
    )
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    archive_path = evidence / "engine_evidence.tar.zst"
    record = create_tar_zst(
        evidence,
        archive_path,
        level=7,
        exclude_names=("frames", "engine_evidence.remote.json"),
    )
    client = _FakeStorageClient()
    store = EvidenceObjectStore("test-bucket", tmp_path / "cache", client=client)
    pointer_path = evidence / "engine_evidence.remote.json"
    pointer = store.upload_archive(record, pointer_path)
    publication = EvidencePublication(record, pointer, archive_path, pointer_path)
    settings = Settings(
        data_dir=tmp_path,
        evidence_bucket="test-bucket",
        evidence_remote_only=True,
        evidence_zstd_level=7,
        evidence_hydration_cache_dir=tmp_path / "cache",
        control_plane_token="test-control-plane-token-32-bytes-minimum",
    )
    member_count, manifest_digest = manifest_bundle_member_set_sha256(
        manifest_path.read_bytes()
    )
    association = EvidenceDatabaseAssociation(
        result_id="22222222-2222-4222-8222-222222222222",
        result_attempt_id="33333333-3333-4333-8333-333333333333",
        source_artifact_id="44444444-4444-4444-8444-444444444444",
        archive_id="55555555-5555-4555-8555-555555555555",
        member_association_count=member_count,
        member_associations_sha256="1" * 64,
        manifest_member_set_sha256=manifest_digest,
    )
    authorization = EvidenceCleanupAuthorization(
        job_id=job_root.name,
        case_slug="case-1",
        evidence_base="evidence",
        pointer=pointer,
        associations=(association,),
    )
    return (
        job_root,
        evidence,
        publication,
        settings,
        store,
        authorization,
        client,
    )


def test_database_ack_cleanup_fresh_restores_all_bundled_members_and_is_idempotent(
    tmp_path: Path,
) -> None:
    (
        job_root,
        evidence,
        _publication,
        settings,
        store,
        authorization,
        client,
    ) = _cleanup_fixture(tmp_path)

    completed = finalize_remote_evidence_cleanup(
        job_root, evidence, authorization, settings, store=store
    )
    assert completed.state == "complete"
    assert completed.association_count == 1
    assert completed.verification == "archive+manifest+all-members-restore:4"
    assert not (evidence / "engine_evidence.tar.zst").exists()
    assert not (evidence / "openfoam").exists()
    assert not (evidence / "VTK").exists()
    # Explicitly excluded incompressible frame artifacts are independently
    # registered and retained; they never masquerade as archive members.
    assert (evidence / "frames" / "pressure" / "f0000.png").is_file()
    assert (evidence / EVIDENCE_FINALIZATION_ACK_NAME).is_file()
    assert (evidence / EVIDENCE_FINALIZATION_RECEIPT_NAME).is_file()
    downloads_after_first = client.downloads

    replay = finalize_remote_evidence_cleanup(
        job_root, evidence, authorization, settings, store=store
    )
    assert replay.state == "no_local_bytes"
    assert client.downloads == downloads_after_first + 1


def test_cleanup_member_count_mismatch_fails_before_ack_or_delete(
    tmp_path: Path,
) -> None:
    job_root, evidence, _publication, settings, store, authorization, _client = (
        _cleanup_fixture(tmp_path)
    )
    association = authorization.associations[0]
    invalid = EvidenceCleanupAuthorization(
        job_id=authorization.job_id,
        case_slug=authorization.case_slug,
        evidence_base=authorization.evidence_base,
        pointer=authorization.pointer,
        associations=(
            EvidenceDatabaseAssociation(
                result_id=association.result_id,
                result_attempt_id=association.result_attempt_id,
                source_artifact_id=association.source_artifact_id,
                archive_id=association.archive_id,
                member_association_count=association.member_association_count - 1,
                member_associations_sha256=association.member_associations_sha256,
                manifest_member_set_sha256=association.manifest_member_set_sha256,
            ),
        ),
    )
    with pytest.raises(EvidenceCleanupError, match="count does not match"):
        finalize_remote_evidence_cleanup(
            job_root, evidence, invalid, settings, store=store
        )
    assert not (evidence / EVIDENCE_FINALIZATION_ACK_NAME).exists()
    assert (evidence / "engine_evidence.tar.zst").is_file()


def test_cleanup_rejects_symlinked_ack_and_only_unlinks_packaged_child_symlink(
    tmp_path: Path,
) -> None:
    job_root, evidence, _publication, settings, store, authorization, _client = (
        _cleanup_fixture(tmp_path)
    )
    outside_ack = tmp_path / "outside-ack.json"
    outside_ack.write_text("{}")
    (evidence / EVIDENCE_FINALIZATION_ACK_NAME).symlink_to(outside_ack)
    with pytest.raises(EvidenceCleanupError, match="must not be a symlink"):
        finalize_remote_evidence_cleanup(
            job_root, evidence, authorization, settings, store=store
        )
    assert outside_ack.read_text() == "{}"
    assert (evidence / "engine_evidence.tar.zst").is_file()

    (evidence / EVIDENCE_FINALIZATION_ACK_NAME).unlink()
    outside_raw = tmp_path / "outside-raw"
    outside_raw.mkdir()
    (outside_raw / "keep.txt").write_text("keep")
    (evidence / "openfoam" / "outside-link").symlink_to(
        outside_raw, target_is_directory=True
    )
    finalize_remote_evidence_cleanup(
        job_root, evidence, authorization, settings, store=store
    )
    assert (outside_raw / "keep.txt").read_text() == "keep"


def _brokered_reclaim_authorization(
    job_root: Path,
    evidence: Path,
    publication: EvidencePublication,
) -> BrokeredRemoteEvidenceReclaim:
    manifest = (evidence / "evidence_manifest.json").read_bytes()
    return BrokeredRemoteEvidenceReclaim(
        job_id=job_root.name,
        case_slug="case-1",
        evidence_base="evidence",
        receipt={
            "schemaVersion": 1,
            "kind": "hub-canonical-evidence-binding",
            "promiseId": "11111111-1111-4111-8111-111111111111",
            "aoaDeg": 3,
            "remoteResultId": "22222222-2222-4222-8222-222222222222",
            "remoteResultAttemptId": "33333333-3333-4333-8333-333333333333",
            "engineJobId": job_root.name,
            "engineCaseSlug": "case-1",
            "brokeredUploadId": "66666666-6666-4666-8666-666666666666",
            "bindingState": "bound",
            "promisePointState": "fulfilled",
            "remote": {
                "bucket": "test-bucket",
                "objectKey": publication.pointer.object_key,
                "generation": str(publication.pointer.generation),
                "crc32c": publication.pointer.crc32c,
                "storedSha256": publication.archive.stored_sha256,
                "storedByteSize": publication.archive.stored_size,
                "tarSha256": publication.archive.tar_sha256,
                "tarByteSize": publication.archive.tar_size,
                "manifestSha256": hashlib.sha256(manifest).hexdigest(),
                "manifestByteSize": len(manifest),
                "zstdLevel": publication.archive.zstd_level,
                "bundledFileCount": 4,
            },
            "canonical": {
                "resultId": "77777777-7777-4777-8777-777777777777",
                "resultAttemptId": "88888888-8888-4888-8888-888888888888",
                "artifactId": "99999999-9999-4999-8999-999999999999",
            },
            "boundAt": "2026-07-18T00:00:00+00:00",
            "fulfilledAt": "2026-07-18T00:00:01+00:00",
        },
        receipt_hmac="a" * 64,
    )


def test_brokered_reclaim_intent_recovers_crash_before_and_during_delete(
    tmp_path: Path,
) -> None:
    job_root, evidence, publication, *_rest = _cleanup_fixture(tmp_path)
    authorization = _brokered_reclaim_authorization(
        job_root, evidence, publication
    )
    with pytest.raises(RuntimeError, match="injected"):
        reclaim_brokered_remote_evidence(
            job_root,
            evidence,
            authorization,
            crash_after_deletions=0,
        )
    intent_path = evidence / BROKERED_LOCAL_RECLAIM_INTENT_NAME
    intent_before = intent_path.read_bytes()
    assert (evidence / "engine_evidence.tar.zst").is_file()

    with pytest.raises(RuntimeError, match="injected"):
        reclaim_brokered_remote_evidence(
            job_root,
            evidence,
            authorization,
            crash_after_deletions=1,
        )
    assert intent_path.read_bytes() == intent_before
    completed = reclaim_brokered_remote_evidence(
        job_root, evidence, authorization
    )
    assert completed.state == "complete"
    assert completed.bytes_freed > 0
    assert not (evidence / "engine_evidence.tar.zst").exists()
    assert not (evidence / "openfoam").exists()
    assert not (evidence / "VTK").exists()
    immutable_receipt = (evidence / BROKERED_LOCAL_RECLAIM_RECEIPT_NAME).read_bytes()
    replay = reclaim_brokered_remote_evidence(job_root, evidence, authorization)
    assert replay.state == "no_local_bytes"
    assert replay.bytes_freed == completed.bytes_freed
    assert (evidence / BROKERED_LOCAL_RECLAIM_RECEIPT_NAME).read_bytes() == immutable_receipt


def test_brokered_reclaim_refuses_repopulated_or_changed_intended_paths(
    tmp_path: Path,
) -> None:
    job_root, evidence, publication, *_rest = _cleanup_fixture(tmp_path)
    authorization = _brokered_reclaim_authorization(
        job_root, evidence, publication
    )
    with pytest.raises(RuntimeError, match="injected"):
        reclaim_brokered_remote_evidence(
            job_root,
            evidence,
            authorization,
            crash_after_deletions=0,
        )
    (evidence / "VTK" / "changed.vtu").write_text("new bytes", encoding="utf-8")
    with pytest.raises(EvidenceCleanupError, match="changed after cleanup intent"):
        reclaim_brokered_remote_evidence(job_root, evidence, authorization)
    assert (evidence / "engine_evidence.tar.zst").is_file()
    assert not (evidence / BROKERED_LOCAL_RECLAIM_RECEIPT_NAME).exists()


def test_tar_zst_upload_materialize_and_selective_hydration_round_trip(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    vtk_files = _write_source_tree(source)
    archive_path = source / "openfoam_evidence.tar.zst"

    record = create_tar_zst(source, archive_path, level=7)

    assert record.format == ARCHIVE_FORMAT
    assert record.zstd_level == 7
    assert archive_path.is_file()
    tar_bytes = _decompress_zstd(archive_path)
    assert _sha(tar_bytes) == record.tar_sha256
    assert len(tar_bytes) == record.tar_size
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:") as archive:
        names = set(archive.getnames())
    assert "openfoam_evidence.tar.zst" not in names
    assert not any(name.startswith(".openfoam_evidence.tar.zst") for name in names)

    client = _FakeStorageClient()
    store, pointer = _publish_record(tmp_path, record, client)
    loaded = read_remote_pointer(tmp_path / "pointer.json")
    assert loaded == pointer
    assert pointer.object_key.endswith(f"/{record.stored_sha256}.tar.zst")
    assert archive_path.is_file(), "publishing must never remove the source archive"

    materialized = store.materialize_remote_archive(pointer, tmp_path / "download.tar.zst")
    assert materialized.read_bytes() == archive_path.read_bytes()

    with store.render_source(pointer) as evidence:
        assert (evidence / "evidence_manifest.json").is_file()
        assert not (evidence / "openfoam").exists()
        for relative, payload in vtk_files.items():
            assert (evidence / relative).read_bytes() == payload


def test_remote_restore_proof_downloads_exact_generation_before_cleanup_authorization(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _write_source_tree(source)
    record = create_tar_zst(source, source / "engine_evidence.tar.zst", level=7)
    client = _FakeStorageClient()
    store, pointer = _publish_record(tmp_path, record, client)
    publication = EvidencePublication(
        archive=record,
        pointer=pointer,
        archive_path=record.path,
        pointer_path=tmp_path / "pointer.json",
    )
    settings = Settings(
        data_dir=tmp_path,
        evidence_bucket="test-bucket",
        evidence_remote_only=True,
        control_plane_token="test-control-plane-token-32-bytes-minimum",
    )

    mode = verify_remote_evidence_restore(
        source, publication, settings, store=store
    )

    assert mode == "archive+manifest+all-members-restore:4"
    assert client.downloads == 1


def test_remote_restore_proof_rejects_corrupt_object_and_leaves_local_source(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _write_source_tree(source)
    record = create_tar_zst(source, source / "engine_evidence.tar.zst", level=7)
    client = _FakeStorageClient()
    store, pointer = _publish_record(tmp_path, record, client)
    publication = EvidencePublication(
        archive=record,
        pointer=pointer,
        archive_path=record.path,
        pointer_path=tmp_path / "pointer.json",
    )
    stored = client.objects[(pointer.bucket, pointer.object_key)]
    stored.data = b"corrupt"
    stored.crc32c = base64.b64encode(
        google_crc32c.Checksum(stored.data).digest()
    ).decode("ascii")
    settings = Settings(
        data_dir=tmp_path,
        evidence_bucket="test-bucket",
        evidence_remote_only=True,
        control_plane_token="test-control-plane-token-32-bytes-minimum",
    )

    with pytest.raises(EvidenceHydrationError):
        verify_remote_evidence_restore(source, publication, settings, store=store)

    assert record.path.is_file()
    assert (source / "VTK" / "a.vtu").is_file()


def test_gzip_transcode_preserves_exact_uncompressed_tar_bytes(tmp_path: Path) -> None:
    tar_bytes = _tar_with_members(
        [
            (tarfile.TarInfo("VTK/value.vtu"), b"exact tar bytes\x00\xff"),
            (tarfile.TarInfo("evidence_manifest.json"), b'{"files": []}'),
        ]
    )
    gzip_path = tmp_path / "evidence.tar.gz"
    with gzip.GzipFile(filename=str(gzip_path), mode="wb", compresslevel=6, mtime=0) as output:
        output.write(tar_bytes)
    destination = tmp_path / "evidence.tar.zst"

    record = transcode_gzip_tar_to_zst(gzip_path, destination, level=10)

    assert gzip_path.is_file()
    assert _decompress_zstd(destination) == tar_bytes
    assert record.tar_sha256 == _sha(tar_bytes)
    assert record.tar_size == len(tar_bytes)
    assert record.stored_sha256 == _sha(destination.read_bytes())
    assert record.stored_size == destination.stat().st_size
    assert inspect_tar_zst(destination, level=10) == record


@pytest.mark.parametrize("unsafe_name", ["../escaped", "/absolute"])
def test_hydration_rejects_traversal_and_absolute_tar_paths(tmp_path: Path, unsafe_name: str) -> None:
    vtk = {"VTK/value.vtu": b"vtk"}
    tar_bytes = _tar_with_members(
        [
            (tarfile.TarInfo(unsafe_name), b"malicious"),
            (tarfile.TarInfo("VTK/value.vtu"), vtk["VTK/value.vtu"]),
            (tarfile.TarInfo("evidence_manifest.json"), _valid_manifest(vtk)),
        ]
    )
    client = _FakeStorageClient()
    store, pointer = _publish_record(tmp_path, _record_from_tar_bytes(tmp_path / "bad.tar.zst", tar_bytes), client)

    with pytest.raises(EvidenceHydrationError, match="unsafe archive path"):
        store.hydrate(pointer)
    assert not (tmp_path / "escaped").exists()


def test_hydration_rejects_symlink_even_outside_selected_vtk_tree(tmp_path: Path) -> None:
    vtk = {"VTK/value.vtu": b"vtk"}
    link = tarfile.TarInfo("openfoam/logs/link")
    link.type = tarfile.SYMTYPE
    link.linkname = "/etc/passwd"
    tar_bytes = _tar_with_members(
        [
            (link, None),
            (tarfile.TarInfo("VTK/value.vtu"), vtk["VTK/value.vtu"]),
            (tarfile.TarInfo("evidence_manifest.json"), _valid_manifest(vtk)),
        ]
    )
    client = _FakeStorageClient()
    store, pointer = _publish_record(tmp_path, _record_from_tar_bytes(tmp_path / "link.tar.zst", tar_bytes), client)

    with pytest.raises(EvidenceHydrationError, match="unsafe archive member type"):
        store.hydrate(pointer)


@pytest.mark.parametrize("failure", ["corrupt", "missing"])
def test_hydration_rejects_corrupt_or_missing_manifest_members(tmp_path: Path, failure: str) -> None:
    actual_payload = b"real vtk"
    manifest_files = {
        "VTK/value.vtu": b"different vtk" if failure == "corrupt" else actual_payload,
    }
    if failure == "missing":
        manifest_files["VTK/missing.vtu"] = b"expected but absent"
    tar_bytes = _tar_with_members(
        [
            (tarfile.TarInfo("VTK/value.vtu"), actual_payload),
            (tarfile.TarInfo("evidence_manifest.json"), _valid_manifest(manifest_files)),
        ]
    )
    client = _FakeStorageClient()
    store, pointer = _publish_record(
        tmp_path,
        _record_from_tar_bytes(tmp_path / f"{failure}.tar.zst", tar_bytes),
        client,
    )

    expected = "failed manifest verification" if failure == "corrupt" else "missing from archive"
    with pytest.raises(EvidenceHydrationError, match=expected):
        store.hydrate(pointer)
    assert not (tmp_path / "cache" / pointer.tar_sha256).exists()


def test_upload_failure_leaves_archive_and_existing_pointer_untouched(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _write_source_tree(source)
    record = create_tar_zst(source, tmp_path / "evidence.tar.zst")
    pointer_path = tmp_path / "pointer.json"
    pointer_path.write_text("do not replace\n", encoding="utf-8")
    client = _FakeStorageClient()
    client.fail_upload = True
    store = EvidenceObjectStore("test-bucket", tmp_path / "cache", client=client)

    with pytest.raises(EvidenceUploadError, match="upload failed"):
        store.upload_archive(record, pointer_path)

    assert record.path.is_file()
    assert pointer_path.read_text(encoding="utf-8") == "do not replace\n"
    assert not client.objects


def test_verified_upload_wraps_pointer_persistence_oserror(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source-pointer-failure"
    source.mkdir()
    _write_source_tree(source)
    record = create_tar_zst(source, tmp_path / "evidence-pointer-failure.tar.zst")
    client = _FakeStorageClient()
    store = EvidenceObjectStore("test-bucket", tmp_path / "cache", client=client)

    def fail_pointer_write(_path: Path, _payload: object) -> None:
        raise OSError("simulated pointer fsync failure")

    monkeypatch.setattr(
        "airfoilfoam.evidence_store._atomic_write_json",
        fail_pointer_write,
    )

    with pytest.raises(
        EvidenceStoreError,
        match="could not persist the verified remote evidence pointer.*pointer fsync failure",
    ):
        store.upload_archive(record, tmp_path / "pointer.json")

    assert record.path.is_file()
    assert not (tmp_path / "pointer.json").exists()
    assert len(client.objects) == 1, "the exact remote generation remains retryable"


def test_content_addressed_upload_is_idempotent_and_validates_existing_object(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _write_source_tree(source)
    record = create_tar_zst(source, tmp_path / "evidence.tar.zst")
    client = _FakeStorageClient()
    store = EvidenceObjectStore("test-bucket", tmp_path / "cache", client=client)

    first = store.upload_archive(record, tmp_path / "pointer-one.json")
    second = store.upload_archive(record, tmp_path / "pointer-two.json")

    assert first.generation == second.generation == 1
    assert first.object_key == second.object_key
    assert client.upload_attempts == 2
    assert len(client.objects) == 1
    assert read_remote_pointer(tmp_path / "pointer-two.json").stored_sha256 == record.stored_sha256


def test_idempotent_upload_refuses_mismatched_existing_metadata(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _write_source_tree(source)
    record = create_tar_zst(source, tmp_path / "evidence.tar.zst")
    client = _FakeStorageClient()
    store = EvidenceObjectStore("test-bucket", tmp_path / "cache", client=client)
    pointer_path = tmp_path / "pointer.json"
    store.upload_archive(record, pointer_path)
    pointer_path.write_text("preserve me\n", encoding="utf-8")
    client.objects[("test-bucket", store.object_key(record))].metadata["tar-sha256"] = "0" * 64

    with pytest.raises(EvidenceUploadError, match="metadata mismatch"):
        store.upload_archive(record, pointer_path)

    assert pointer_path.read_text(encoding="utf-8") == "preserve me\n"


def test_idempotent_upload_refuses_mismatched_existing_content_type(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source-content-type"
    source.mkdir()
    _write_source_tree(source)
    record = create_tar_zst(source, source / "evidence.tar.zst", level=7)
    client = _FakeStorageClient()
    store = EvidenceObjectStore("test-bucket", tmp_path / "cache", client=client)
    pointer_path = tmp_path / "pointer.json"
    store.upload_archive(record, pointer_path)
    pointer_path.write_text("preserve me too\n", encoding="utf-8")
    client.objects[("test-bucket", store.object_key(record))].content_type = (
        "application/octet-stream"
    )

    with pytest.raises(EvidenceUploadError, match="remote content type"):
        store.upload_archive(record, pointer_path)

    assert pointer_path.read_text(encoding="utf-8") == "preserve me too\n"


def test_concurrent_hydration_downloads_and_publishes_once(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _write_source_tree(source)
    record = create_tar_zst(source, tmp_path / "evidence.tar.zst")
    client = _FakeStorageClient()
    client.download_delay = 0.1
    store, pointer = _publish_record(tmp_path, record, client)
    barrier = threading.Barrier(3)
    results: list[Path] = []
    errors: list[BaseException] = []

    def run() -> None:
        barrier.wait()
        try:
            results.append(store.hydrate(pointer))
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=run), threading.Thread(target=run)]
    for thread in threads:
        thread.start()
    barrier.wait()
    for thread in threads:
        thread.join(timeout=5)

    assert not errors
    assert len(results) == 2
    assert results[0] == results[1]
    assert client.downloads == 1


def test_render_context_prevents_eviction_then_enforces_size_bound(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _write_source_tree(source)
    record = create_tar_zst(source, tmp_path / "evidence.tar.zst")
    client = _FakeStorageClient()
    store = EvidenceObjectStore(
        "test-bucket",
        tmp_path / "cache",
        client=client,
        cache_max_bytes=0,
        cache_ttl_seconds=60,
    )
    pointer = store.upload_archive(record, tmp_path / "pointer.json")

    with store.render_source(pointer) as evidence:
        report = store.cleanup_cache()
        assert report.entries_removed == 0
        assert evidence.is_dir()

    assert not (tmp_path / "cache" / pointer.tar_sha256).exists()


def test_cleanup_counts_and_lock_safely_evicts_crash_orphan_stages(
    tmp_path: Path,
) -> None:
    cache = tmp_path / "cache"
    store = EvidenceObjectStore(
        "test-bucket",
        cache,
        client=_FakeStorageClient(),
        cache_max_bytes=0,
        cache_ttl_seconds=60,
    )
    digest = "a" * 64
    stage = cache / f".{digest}.{'b' * 32}.stage"
    stage.mkdir()
    (stage / "partial.vtu").write_bytes(b"crash-orphan")
    lock_path = store._lock_path(digest)

    with lock_path.open("a+b") as active_lock:
        fcntl.flock(active_lock.fileno(), fcntl.LOCK_EX)
        active_report = store.cleanup_cache()
        assert active_report.entries_removed == 0
        assert active_report.bytes_remaining == len(b"crash-orphan")
        assert stage.is_dir()

    orphan_report = store.cleanup_cache()
    assert orphan_report.entries_removed == 1
    assert orphan_report.bytes_removed == len(b"crash-orphan")
    assert orphan_report.bytes_remaining == 0
    assert not stage.exists()


def test_cache_lock_identity_uses_a_bounded_stripe_set(tmp_path: Path) -> None:
    store = EvidenceObjectStore(
        "test-bucket",
        tmp_path / "cache",
        client=_FakeStorageClient(),
    )
    paths = {
        store._lock_path(hashlib.sha256(str(index).encode()).hexdigest())
        for index in range(10_000)
    }

    assert len(paths) <= 4_096
    assert all(path.name.startswith("stripe-") for path in paths)
    assert all(len(path.name) == len("stripe-000.lock") for path in paths)


def test_archive_and_generic_member_sources_are_verified_and_cached(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _write_source_tree(source)
    record = create_tar_zst(source, tmp_path / "evidence.tar.zst")
    client = _FakeStorageClient()
    store, pointer = _publish_record(tmp_path, record, client)

    with store.member_source(pointer, "openfoam/logs/log.simpleFoam") as member:
        assert member.read_text(encoding="utf-8") == "solver log\n"
    with store.archive_source(pointer) as archive:
        assert archive.read_bytes() == record.path.read_bytes()

    assert client.downloads == 1
    assert store.materialize_member(pointer, "openfoam/logs/log.simpleFoam").is_file()


def test_generic_member_hydration_rejects_unmanifested_and_unsafe_paths(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _write_source_tree(source)
    extra = source / "openfoam" / "logs" / "not-in-manifest"
    extra.write_text("unregistered\n", encoding="utf-8")
    record = create_tar_zst(source, tmp_path / "evidence.tar.zst")
    client = _FakeStorageClient()
    store, pointer = _publish_record(tmp_path, record, client)

    with pytest.raises(EvidenceHydrationError, match="missing from manifest"):
        store.materialize_member(pointer, "openfoam/logs/not-in-manifest")
    with pytest.raises(EvidenceHydrationError, match="unsafe archive path"):
        store.materialize_member(pointer, "../outside")


@pytest.mark.parametrize(
    "unsafe_member",
    [
        tarfile.TarInfo("../escape"),
        tarfile.TarInfo("/absolute"),
        tarfile.TarInfo("openfoam/system/duplicate"),
        tarfile.TarInfo("openfoam/system/link"),
        tarfile.TarInfo("openfoam/system/hardlink"),
        tarfile.TarInfo("openfoam/system/fifo"),
        tarfile.TarInfo("openfoam/system/device"),
    ],
)
def test_verified_archive_extractor_rejects_unsafe_member_types_and_paths(
    tmp_path: Path,
    unsafe_member: tarfile.TarInfo,
) -> None:
    manifest = _valid_manifest({})
    members: list[tuple[tarfile.TarInfo, bytes | None]] = [
        (tarfile.TarInfo("evidence_manifest.json"), manifest),
    ]
    if unsafe_member.name.endswith("duplicate"):
        members.extend(
            [
                (unsafe_member, b"first"),
                (tarfile.TarInfo(unsafe_member.name), b"second"),
            ]
        )
    elif unsafe_member.name.endswith("hardlink"):
        unsafe_member.type = tarfile.LNKTYPE
        unsafe_member.linkname = "evidence_manifest.json"
        members.append((unsafe_member, None))
    elif unsafe_member.name.endswith("link"):
        unsafe_member.type = tarfile.SYMTYPE
        unsafe_member.linkname = "../target"
        members.append((unsafe_member, None))
    elif unsafe_member.name.endswith("fifo"):
        unsafe_member.type = tarfile.FIFOTYPE
        members.append((unsafe_member, None))
    elif unsafe_member.name.endswith("device"):
        unsafe_member.type = tarfile.CHRTYPE
        members.append((unsafe_member, None))
    else:
        members.append((unsafe_member, b"unsafe"))
    archive = tmp_path / "unsafe.tar.zst"
    _record_from_tar_bytes(archive, _tar_with_members(members))
    destination = tmp_path / "restored"

    with pytest.raises(EvidenceHydrationError):
        extract_verified_evidence_archive(
            archive,
            destination,
            compression="zstd",
            include_prefixes=("openfoam",),
        )

    assert not destination.exists()
    assert not (tmp_path / "escape").exists()


def test_verified_archive_extractor_rejects_unmanifested_member_and_cleans_up(
    tmp_path: Path,
) -> None:
    manifest = _valid_manifest({})
    archive = tmp_path / "unmanifested.tar.zst"
    _record_from_tar_bytes(
        archive,
        _tar_with_members(
            [
                (tarfile.TarInfo("evidence_manifest.json"), manifest),
                (tarfile.TarInfo("openfoam/system/controlDict"), b"unregistered"),
            ]
        ),
    )
    destination = tmp_path / "restored"

    with pytest.raises(EvidenceHydrationError, match="missing from manifest"):
        extract_verified_evidence_archive(
            archive,
            destination,
            compression="zstd",
            include_prefixes=("openfoam",),
        )

    assert not destination.exists()


def test_verified_archive_extractor_rejects_manifest_excluded_member_even_if_listed(
    tmp_path: Path,
) -> None:
    payload = b"must never be bundled or extracted"
    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "bundleExcludes": ["openfoam"],
            "files": [
                {
                    "path": "openfoam/system/controlDict",
                    "byteSize": len(payload),
                    # The old extractor skipped this hash because the root was
                    # excluded, yet still wrote the attacker-controlled bytes.
                    "sha256": "0" * 64,
                }
            ],
        }
    ).encode()
    archive = tmp_path / "excluded-member.tar.zst"
    _record_from_tar_bytes(
        archive,
        _tar_with_members(
            [
                (tarfile.TarInfo("evidence_manifest.json"), manifest),
                (tarfile.TarInfo("openfoam/system/controlDict"), payload),
            ]
        ),
    )
    destination = tmp_path / "restored"

    with pytest.raises(
        EvidenceHydrationError,
        match="member under manifest bundleExcludes",
    ):
        extract_verified_evidence_archive(
            archive,
            destination,
            compression="zstd",
            include_prefixes=("openfoam",),
        )

    assert not destination.exists()


def test_verified_archive_extractor_reserves_free_space_before_selected_write(
    tmp_path: Path,
    monkeypatch,
) -> None:
    payload = b"x" * 128
    manifest = _valid_manifest({"openfoam/system/controlDict": payload})
    archive = tmp_path / "capacity.tar.zst"
    _record_from_tar_bytes(
        archive,
        _tar_with_members(
            [
                (tarfile.TarInfo("evidence_manifest.json"), manifest),
                (tarfile.TarInfo("openfoam/system/controlDict"), payload),
            ]
        ),
    )
    monkeypatch.setattr(
        evidence_store,
        "_safe_extraction_capacity",
        lambda _destination: len(manifest) + 32,
    )
    destination = tmp_path / "capacity-restored"

    with pytest.raises(
        EvidenceHydrationError,
        match="exceed safe local restore capacity",
    ):
        extract_verified_evidence_archive(
            archive,
            destination,
            compression="zstd",
            include_prefixes=("openfoam",),
        )

    assert not destination.exists()


def test_verified_archive_extractor_rejects_unbounded_remote_pointer(
    tmp_path: Path,
    monkeypatch,
) -> None:
    manifest = _valid_manifest({})
    archive = tmp_path / "remote-bounded.tar.zst"
    record = _record_from_tar_bytes(
        archive,
        _tar_with_members(
            [(tarfile.TarInfo("evidence_manifest.json"), manifest)]
        ),
    )
    client = _FakeStorageClient()
    _store, pointer = _publish_record(tmp_path, record, client)
    monkeypatch.setattr(
        evidence_store,
        "_MAX_LOCAL_EVIDENCE_TAR_BYTES",
        pointer.tar_size - 1,
    )

    with pytest.raises(
        EvidenceHydrationError,
        match="remote evidence pointer declares an uncompressed tar larger",
    ):
        extract_verified_evidence_archive(
            archive,
            tmp_path / "remote-pointer-limit",
            compression="zstd",
            pointer=pointer,
        )
    assert not (tmp_path / "remote-pointer-limit").exists()


def test_verified_archive_extractor_bounds_local_tar_and_manifest(
    tmp_path: Path,
    monkeypatch,
) -> None:
    manifest = _valid_manifest({})
    archive = tmp_path / "bounded.tar.zst"
    _record_from_tar_bytes(
        archive,
        _tar_with_members(
            [(tarfile.TarInfo("evidence_manifest.json"), manifest)]
        ),
    )

    monkeypatch.setattr(evidence_store, "_MAX_LOCAL_EVIDENCE_TAR_BYTES", 512)
    with pytest.raises(EvidenceHydrationError, match="uncompressed tar exceeds"):
        extract_verified_evidence_archive(
            archive,
            tmp_path / "tar-limit",
            compression="zstd",
        )
    assert not (tmp_path / "tar-limit").exists()

    monkeypatch.setattr(
        evidence_store,
        "_MAX_LOCAL_EVIDENCE_TAR_BYTES",
        1024 * 1024,
    )
    monkeypatch.setattr(evidence_store, "MAX_EVIDENCE_MANIFEST_BYTES", 16)
    with pytest.raises(EvidenceHydrationError, match="manifest exceeds"):
        extract_verified_evidence_archive(
            archive,
            tmp_path / "manifest-limit",
            compression="zstd",
        )
    assert not (tmp_path / "manifest-limit").exists()
