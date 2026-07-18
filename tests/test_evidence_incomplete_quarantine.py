from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import os
import tarfile
import uuid
from dataclasses import dataclass
from pathlib import Path

import google_crc32c
import pytest

from airfoilfoam.config import Settings
from airfoilfoam.evidence_incomplete_quarantine import (
    ARCHIVE_NAME,
    DATABASE_ACK_NAME,
    PACKAGE_MANIFEST_NAME,
    PARTIAL_OBJECT_PREFIX,
    POINTER_NAME,
    PRESERVATION_KIND,
    QUARANTINE_REASON,
    RECEIPT_NAME,
    IncompleteEvidenceQuarantineError,
    _create_deterministic_tar_zst,
    _file_size_sha256,
    _receipt_digest_fields,
    plan_target,
    quarantine_target,
    resolve_target,
)
from airfoilfoam.evidence_store import EvidenceObjectStore, extract_verified_evidence_archive


class _PreconditionFailed(Exception):
    code = 412


@dataclass
class _Object:
    data: bytes
    metadata: dict[str, str]
    content_type: str
    crc32c: str
    generation: int


class _Blob:
    def __init__(self, client: "_Client", bucket: str, name: str):
        self.client = client
        self.bucket_name = bucket
        self.name = name
        self.metadata: dict[str, str] | None = None
        self.content_type: str | None = None
        self.crc32c: str | None = None
        self.generation: int | None = None
        self.size: int | None = None

    @property
    def identity(self) -> tuple[str, str]:
        return self.bucket_name, self.name

    def upload_from_filename(
        self,
        filename: str,
        *,
        if_generation_match: int,
        checksum: str,
        timeout: float,
    ) -> None:
        assert if_generation_match == 0 and checksum == "crc32c" and timeout > 0
        if self.identity in self.client.objects:
            raise _PreconditionFailed("exists")
        data = Path(filename).read_bytes()
        value = _Object(
            data=data,
            metadata=dict(self.metadata or {}),
            content_type=str(self.content_type),
            crc32c=base64.b64encode(google_crc32c.Checksum(data).digest()).decode(),
            generation=self.client.next_generation,
        )
        self.client.next_generation += 1
        self.client.objects[self.identity] = value
        self._load(value)

    def reload(self, *, timeout: float) -> None:
        assert timeout > 0
        self._load(self.client.objects[self.identity])

    def download_to_filename(
        self,
        filename: str,
        *,
        if_generation_match: int,
        checksum: str,
        timeout: float,
    ) -> None:
        assert checksum == "crc32c" and timeout > 0
        value = self.client.objects[self.identity]
        if value.generation != if_generation_match:
            raise _PreconditionFailed("generation")
        if self.client.fail_download:
            raise RuntimeError("download unavailable")
        self.client.downloads += 1
        Path(filename).write_bytes(value.data)

    def _load(self, value: _Object) -> None:
        self.metadata = dict(value.metadata)
        self.content_type = value.content_type
        self.crc32c = value.crc32c
        self.generation = value.generation
        self.size = len(value.data)


class _Bucket:
    def __init__(self, client: "_Client", name: str):
        self.client = client
        self.name = name

    def blob(self, name: str) -> _Blob:
        return _Blob(self.client, self.name, name)


class _Client:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], _Object] = {}
        self.next_generation = 18_000_000_000_000_000_001
        self.downloads = 0
        self.fail_download = False

    def bucket(self, name: str) -> _Bucket:
        return _Bucket(self, name)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _manifest(files: dict[str, bytes], *, excluded: dict[str, bytes] | None = None) -> bytes:
    excluded = excluded or {}
    rows = [
        {
            "path": path,
            "byteSize": len(data),
            "sha256": _sha(data),
            "role": "fixture",
        }
        for path, data in sorted({**files, **excluded}.items())
    ]
    return json.dumps(
        {
            "schemaVersion": 1,
            "bundleExcludes": ["frames"] if excluded else [],
            "files": rows,
        },
        sort_keys=True,
    ).encode()


def _write_tree(root: Path, files: dict[str, bytes]) -> None:
    for relative, data in files.items():
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)


def _gzip_bundle(evidence: Path, files: dict[str, bytes], manifest: bytes, *, truncate: bool) -> bytes:
    _write_tree(evidence, files)
    (evidence / "evidence_manifest.json").write_bytes(manifest)
    archive_path = evidence / "openfoam_evidence.tar.gz"
    with tarfile.open(archive_path, "w:gz") as archive:
        archive.add(evidence / "evidence_manifest.json", arcname="evidence_manifest.json")
        for root in sorted({path.split("/", 1)[0] for path in files}):
            archive.add(evidence / root, arcname=root)
    data = archive_path.read_bytes()
    if truncate:
        data = data[:-8]
        archive_path.write_bytes(data)
    return data


@dataclass
class _Fixture:
    settings: Settings
    target: object
    donor: object
    store: EvidenceObjectStore
    client: _Client
    corrupt_bytes: bytes


def _fixture(tmp_path: Path) -> _Fixture:
    jobs = tmp_path / "data/jobs"
    job = jobs / "job-one"
    target_evidence = job / "cases/case-one/a19/evidence"
    donor_evidence = job / "cases/case-one/a18/evidence"
    target_evidence.mkdir(parents=True)
    donor_evidence.mkdir(parents=True)
    (job / "status.json").write_text(json.dumps({"state": "cancelled"}))
    (job / "result.json").write_text(json.dumps({"state": "cancelled"}))

    vtk = b"authenticated local VTK"
    donor_log = b"authenticated donor log"
    missing = b"unrecoverable time field"
    target_files = {
        "VTK/value.vtu": vtk,
        "openfoam/logs/log.a19": donor_log,
        "time_directories/33000/U": missing,
    }
    target_manifest = _manifest(
        target_files,
        excluded={"frames/vorticity/f0001.png": b"separate frame"},
    )
    corrupt_bytes = _gzip_bundle(
        target_evidence,
        {"VTK/value.vtu": vtk},
        target_manifest,
        truncate=True,
    )
    unknown = target_evidence / "openfoam/operator-note.bin"
    unknown.parent.mkdir(parents=True, exist_ok=True)
    unknown.write_bytes(b"unmanifested but preserved")

    donor_manifest = _manifest({"openfoam/logs/log.a19": donor_log})
    _gzip_bundle(
        donor_evidence,
        {"openfoam/logs/log.a19": donor_log},
        donor_manifest,
        truncate=False,
    )
    settings = Settings(
        data_dir=tmp_path / "data",
        evidence_bucket="test-bucket",
        evidence_remote_only=True,
        evidence_hydration_cache_dir=tmp_path / "cache",
        evidence_hydration_cache_max_gb=0.1,
        control_plane_token="test-control-plane-token-at-least-32-bytes",
    )
    client = _Client()
    store = EvidenceObjectStore(
        "test-bucket",
        tmp_path / "cache",
        client=client,
        object_prefix=PARTIAL_OBJECT_PREFIX,
        cache_max_bytes=100 * 1024 * 1024,
    )
    return _Fixture(
        settings=settings,
        target=resolve_target(jobs, "job-one", "cases/case-one/a19/evidence"),
        donor=resolve_target(jobs, "job-one", "cases/case-one/a18/evidence"),
        store=store,
        client=client,
        corrupt_bytes=corrupt_bytes,
    )


def _ack(fixture: _Fixture) -> dict[str, object]:
    evidence = fixture.target.evidence_dir
    receipt_path = evidence / RECEIPT_NAME
    receipt = json.loads(receipt_path.read_text())
    receipt_size, receipt_sha = _file_size_sha256(receipt_path)
    digests = _receipt_digest_fields(receipt)
    return {
        "schemaVersion": 1,
        "state": "incomplete_quarantined",
        "registrationKind": PRESERVATION_KIND,
        "quarantineReason": QUARANTINE_REASON,
        "jobId": fixture.target.job_id,
        "evidencePath": fixture.target.evidence_path,
        "storedSha256": receipt["remote"]["storedSha256"],
        "generation": receipt["remote"]["generation"],
        "quarantineId": str(uuid.uuid4()),
        "blobId": str(uuid.uuid4()),
        "originalManifestSha256": receipt["originalManifest"]["sha256"],
        "originalManifestByteSize": receipt["originalManifest"]["byteSize"],
        **digests,
        "packageManifestSha256": receipt["packageManifest"]["sha256"],
        "packageManifestByteSize": receipt["packageManifest"]["byteSize"],
        "migrationReceiptSha256": receipt_sha,
        "migrationReceiptByteSize": receipt_size,
        "quarantinedAt": "2026-07-18T15:00:00.123Z",
    }


def test_dry_run_authenticates_donor_conserves_members_and_never_mutates(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path)

    result = plan_target(fixture.target, [fixture.donor])

    assert result.status == "planned-incomplete-quarantine"
    assert (result.expected_members, result.retained_members, result.missing_members) == (3, 2, 1)
    evidence = fixture.target.evidence_dir
    for name in (ARCHIVE_NAME, POINTER_NAME, PACKAGE_MANIFEST_NAME, RECEIPT_NAME):
        assert not (evidence / name).exists()
    assert (evidence / "openfoam_evidence.tar.gz").read_bytes() == fixture.corrupt_bytes


@pytest.mark.parametrize(
    ("drift", "error"),
    [
        ("non-string-path", "member path is not a string"),
        ("non-string-sha256", "member sha256 is not a string"),
        ("string-byte-size", "byteSize must be a non-negative safe integer"),
        ("boolean-byte-size", "byteSize must be a non-negative safe integer"),
        ("unsafe-large-byte-size", "byteSize must be a non-negative safe integer"),
        ("non-string-exclusion", "unsafe bundle exclusion"),
        ("duplicate-exclusion", "repeats a bundle exclusion"),
    ],
)
def test_pass1_rejects_manifest_path_or_exclusion_type_drift_before_upload(
    tmp_path: Path,
    drift: str,
    error: str,
) -> None:
    fixture = _fixture(tmp_path)
    evidence = fixture.target.evidence_dir
    manifest_path = evidence / "evidence_manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if drift == "non-string-path":
        manifest["files"][0]["path"] = 123
    elif drift == "non-string-sha256":
        manifest["files"][0]["sha256"] = 1
    elif drift == "string-byte-size":
        manifest["files"][0]["byteSize"] = "1"
    elif drift == "boolean-byte-size":
        manifest["files"][0]["byteSize"] = True
    elif drift == "unsafe-large-byte-size":
        manifest["files"][0]["byteSize"] = 9_007_199_254_740_992
    elif drift == "non-string-exclusion":
        manifest["bundleExcludes"] = [123]
    else:
        manifest["bundleExcludes"] = ["frames", "frames"]
    manifest_path.write_text(json.dumps(manifest, sort_keys=True))

    with pytest.raises(IncompleteEvidenceQuarantineError, match=error):
        quarantine_target(
            fixture.target,
            fixture.settings,
            donors=[fixture.donor],
            store=fixture.store,
        )

    assert fixture.client.objects == {}
    for name in (ARCHIVE_NAME, POINTER_NAME, PACKAGE_MANIFEST_NAME, RECEIPT_NAME):
        assert not (evidence / name).exists()


@pytest.mark.parametrize("partition", ["all-missing", "all-retained"])
def test_pass1_and_ack_accept_empty_partition_side(
    tmp_path: Path,
    partition: str,
) -> None:
    fixture = _fixture(tmp_path)
    evidence = fixture.target.evidence_dir
    if partition == "all-missing":
        manifest = _manifest({"time_directories/33000/U": b"never recovered"})
        fixture.corrupt_bytes = _gzip_bundle(evidence, {}, manifest, truncate=True)
        donors = []
        expected_counts = (1, 0, 1)
    else:
        missing = evidence / "time_directories/33000/U"
        missing.parent.mkdir(parents=True, exist_ok=True)
        missing.write_bytes(b"unrecoverable time field")
        donors = [fixture.donor]
        expected_counts = (3, 3, 0)

    result = quarantine_target(
        fixture.target,
        fixture.settings,
        donors=donors,
        store=fixture.store,
    )
    receipt = json.loads((evidence / RECEIPT_NAME).read_text())

    assert result.status == "awaiting-database-registration"
    assert (
        len(receipt["expectedMembers"]),
        len(receipt["retainedMembers"]),
        len(receipt["missingMembers"]),
    ) == expected_counts
    assert receipt["packageMembers"]

    (evidence / DATABASE_ACK_NAME).write_text(json.dumps(_ack(fixture), sort_keys=True))
    completed = quarantine_target(fixture.target, fixture.settings, store=fixture.store)
    assert completed.status == "incomplete-quarantined"


def test_pass1_uses_partial_prefix_preserves_exact_sources_and_is_deterministic(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path)
    evidence = fixture.target.evidence_dir

    first = quarantine_target(
        fixture.target,
        fixture.settings,
        donors=[fixture.donor],
        store=fixture.store,
    )
    second = quarantine_target(fixture.target, fixture.settings, store=fixture.store)

    assert first.status == second.status == "awaiting-database-registration"
    receipt = json.loads((evidence / RECEIPT_NAME).read_text())
    assert receipt["remote"] == json.loads((evidence / POINTER_NAME).read_text())
    assert receipt["remote"]["objectKey"].startswith(f"{PARTIAL_OBJECT_PREFIX}/sha256/")
    assert receipt["verificationMode"] == (
        f"archive+manifest+all-members-restore:{len(receipt['packageMembers'])}"
    )
    assert {row["path"] for row in receipt["expectedMembers"]} == {
        "VTK/value.vtu",
        "openfoam/logs/log.a19",
        "time_directories/33000/U",
    }
    assert [row["path"] for row in receipt["missingMembers"]] == [
        "time_directories/33000/U"
    ]
    for row in receipt["retainedMembers"]:
        assert row["packagePath"] == f"retained/{row['path']}"
    corrupt = [row for row in receipt["sourceArchives"] if row["role"] == "corrupt_original"]
    assert len(corrupt) == 1
    assert corrupt[0]["packagePath"] == "original/openfoam_evidence.tar.gz"
    assert corrupt[0]["readableTarByteSize"] > 0
    donor = [row for row in receipt["sourceArchives"] if row["role"] == "recovery_sibling"]
    assert len(donor) == 1
    assert donor[0]["uncompressedTarByteSize"] > 0
    assert len(donor[0]["uncompressedTarSha256"]) == 64
    restored = tmp_path / "forensic-restored"
    extract_verified_evidence_archive(
        evidence / ARCHIVE_NAME,
        restored,
        compression="zstd",
        expected_manifest=(evidence / PACKAGE_MANIFEST_NAME).read_bytes(),
    )
    assert (
        restored / "original/openfoam_evidence.tar.gz"
    ).read_bytes() == fixture.corrupt_bytes
    assert (restored / "unmanifested/local_raw/openfoam/operator-note.bin").read_bytes() == b"unmanifested but preserved"
    assert not (evidence / "engine_evidence.remote.json").exists()
    assert not (evidence / "storage_migration.json").exists()


def test_deterministic_writer_ignores_host_metadata(tmp_path: Path) -> None:
    source = tmp_path / "source"
    _write_tree(source, {"z/file.bin": b"z", "a/deep/file.txt": b"alpha"})
    first = _create_deterministic_tar_zst(source, tmp_path / "one.tar.zst", level=7)
    for index, path in enumerate(sorted(source.rglob("*"))):
        os.chmod(path, 0o700 if path.is_dir() else 0o600)
        os.utime(path, (10_000 + index, 20_000 + index))
    second = _create_deterministic_tar_zst(source, tmp_path / "two.tar.zst", level=7)
    assert first.stored_sha256 == second.stored_sha256
    assert first.tar_sha256 == second.tar_sha256
    assert first.stored_size == second.stored_size
    assert (tmp_path / "one.tar.zst").read_bytes() == (tmp_path / "two.tar.zst").read_bytes()


def test_valid_ack_and_fresh_restore_gate_cleanup_and_complete_replay(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path)
    evidence = fixture.target.evidence_dir
    quarantine_target(
        fixture.target,
        fixture.settings,
        donors=[fixture.donor],
        store=fixture.store,
    )
    ack = _ack(fixture)
    (evidence / DATABASE_ACK_NAME).write_text(json.dumps(ack, sort_keys=True))

    completed = quarantine_target(fixture.target, fixture.settings, store=fixture.store)
    replay = quarantine_target(fixture.target, fixture.settings, store=fixture.store)

    assert completed.status == "incomplete-quarantined"
    assert replay.status == "already-complete"
    assert fixture.client.downloads >= 2
    for relative in (
        "openfoam_evidence.tar.gz",
        "VTK",
        "openfoam",
        "time_directories",
        ARCHIVE_NAME,
    ):
        assert not (evidence / relative).exists()
    for relative in (
        "evidence_manifest.json",
        PACKAGE_MANIFEST_NAME,
        POINTER_NAME,
        RECEIPT_NAME,
        DATABASE_ACK_NAME,
    ):
        assert (evidence / relative).is_file()
    receipt = json.loads((evidence / RECEIPT_NAME).read_text())
    assert receipt["state"] == "complete"
    assert receipt["databaseAcknowledgement"] == ack
    assert receipt["registrationReceipt"] == {
        "sha256": ack["migrationReceiptSha256"],
        "byteSize": ack["migrationReceiptByteSize"],
    }


def test_bad_ack_or_fresh_download_failure_preserves_every_local_byte(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path)
    evidence = fixture.target.evidence_dir
    quarantine_target(
        fixture.target,
        fixture.settings,
        donors=[fixture.donor],
        store=fixture.store,
    )
    ack = _ack(fixture)
    ack["retainedMemberCount"] = int(ack["retainedMemberCount"]) + 1
    (evidence / DATABASE_ACK_NAME).write_text(json.dumps(ack))
    with pytest.raises(IncompleteEvidenceQuarantineError, match="retainedMemberCount"):
        quarantine_target(fixture.target, fixture.settings, store=fixture.store)
    assert (evidence / "openfoam_evidence.tar.gz").read_bytes() == fixture.corrupt_bytes
    assert (evidence / ARCHIVE_NAME).is_file()

    good = _ack(fixture)
    (evidence / DATABASE_ACK_NAME).write_text(json.dumps(good))
    fixture.client.fail_download = True
    with pytest.raises(IncompleteEvidenceQuarantineError, match="fresh forensic remote restore"):
        quarantine_target(fixture.target, fixture.settings, store=fixture.store)
    assert (evidence / "VTK/value.vtu").is_file()
    assert (evidence / ARCHIVE_NAME).is_file()


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("sha256", 1),
        ("byteSize", "1"),
        ("byteSize", True),
        ("byteSize", 9_007_199_254_740_992),
    ],
)
def test_completed_replay_rejects_coerced_registration_identity_types(
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    fixture = _fixture(tmp_path)
    evidence = fixture.target.evidence_dir
    quarantine_target(
        fixture.target,
        fixture.settings,
        donors=[fixture.donor],
        store=fixture.store,
    )
    (evidence / DATABASE_ACK_NAME).write_text(json.dumps(_ack(fixture)))
    quarantine_target(fixture.target, fixture.settings, store=fixture.store)

    receipt_path = evidence / RECEIPT_NAME
    receipt = json.loads(receipt_path.read_text())
    receipt["registrationReceipt"][field] = value
    receipt_path.write_text(json.dumps(receipt, sort_keys=True))

    with pytest.raises(
        IncompleteEvidenceQuarantineError,
        match="pass-1 registration receipt",
    ):
        quarantine_target(fixture.target, fixture.settings, store=fixture.store)


def test_active_lock_and_corrupt_donor_fail_closed_without_mutation(tmp_path: Path) -> None:
    fixture = _fixture(tmp_path)
    lock_path = fixture.target.job_root / ".execute.lock"
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(Exception, match="execution lock is held"):
            plan_target(fixture.target, [fixture.donor])
    donor_archive = fixture.donor.evidence_dir / "openfoam_evidence.tar.gz"
    donor_archive.write_bytes(donor_archive.read_bytes()[:-8])
    with pytest.raises(IncompleteEvidenceQuarantineError, match="donor archive"):
        plan_target(fixture.target, [fixture.donor])
    assert not (fixture.target.evidence_dir / ARCHIVE_NAME).exists()
