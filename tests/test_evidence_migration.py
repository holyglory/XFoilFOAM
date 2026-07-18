from __future__ import annotations

import base64
import fcntl
import hashlib
import json
import shutil
import tarfile
from dataclasses import dataclass
from pathlib import Path

import google_crc32c
import pytest

from airfoilfoam import evidence_migration
from airfoilfoam.config import Settings
from airfoilfoam.evidence_migration import (
    EvidenceMigrationError,
    MigrationTarget,
    discover_targets,
    migrate_target,
    plan_target,
    run_migration,
)
from airfoilfoam.evidence_store import (
    EvidenceObjectStore,
    manifest_bundle_member_set_sha256,
)


class FakePreconditionFailed(Exception):
    code = 412


@dataclass
class _StoredObject:
    data: bytes
    metadata: dict[str, str]
    content_type: str
    crc32c: str
    generation: int


class _FakeBlob:
    def __init__(self, client: "_FakeClient", bucket: str, name: str):
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
        if self.client.fail_upload:
            raise RuntimeError("simulated GCS outage")
        if self.identity in self.client.objects:
            raise FakePreconditionFailed("already exists")
        data = Path(filename).read_bytes()
        stored = _StoredObject(
            data=data,
            metadata=dict(self.metadata or {}),
            content_type=str(self.content_type or ""),
            crc32c=base64.b64encode(google_crc32c.Checksum(data).digest()).decode(),
            generation=self.client.next_generation,
        )
        self.client.next_generation += 1
        self.client.objects[self.identity] = stored
        self._load(stored)

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
        stored = self.client.objects[self.identity]
        if stored.generation != if_generation_match:
            raise FakePreconditionFailed("generation mismatch")
        if self.client.fail_download:
            raise RuntimeError("simulated GCS download outage")
        self.client.download_count += 1
        Path(filename).write_bytes(stored.data)

    def _load(self, stored: _StoredObject) -> None:
        self.metadata = dict(stored.metadata)
        self.content_type = stored.content_type
        self.crc32c = stored.crc32c
        self.generation = stored.generation
        self.size = len(stored.data)


class _FakeBucket:
    def __init__(self, client: "_FakeClient", name: str):
        self.client = client
        self.name = name

    def blob(self, name: str) -> _FakeBlob:
        return _FakeBlob(self.client, self.name, name)


class _FakeClient:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], _StoredObject] = {}
        self.next_generation = 10_000_000_000_000_000_001
        self.fail_upload = False
        self.fail_download = False
        self.download_count = 0

    def bucket(self, name: str) -> _FakeBucket:
        return _FakeBucket(self, name)


def _sha(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def _fixture(tmp_path: Path, *, state: str = "completed") -> tuple[MigrationTarget, Settings]:
    job_root = tmp_path / "data" / "jobs" / "job-one"
    evidence = job_root / "cases" / "case-one" / "a0" / "evidence"
    evidence.mkdir(parents=True)
    (job_root / "status.json").write_text(json.dumps({"state": state}))
    (job_root / "result.json").write_text(json.dumps({"state": state}))

    files = {
        "VTK/value.vtu": b"real vtk field\n",
        "openfoam/logs/log.simpleFoam": b"real solver log\n",
        "time_directories/100/U": b"real saved field\n",
    }
    for relative, payload in files.items():
        path = evidence / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(payload)
    manifest = {
        "schemaVersion": 2,
        "bundleExcludes": ["frames"],
        "files": [
            {
                "path": relative,
                "role": "vtk_window" if relative.startswith("VTK/") else "log",
                "byteSize": len(payload),
                "sha256": _sha(payload),
            }
            for relative, payload in sorted(files.items())
        ],
    }
    manifest_path = evidence / "evidence_manifest.json"
    manifest_path.write_text(json.dumps(manifest, sort_keys=True), encoding="utf-8")
    frame = evidence / "frames" / "vorticity" / "f0000.png"
    frame.parent.mkdir(parents=True)
    frame.write_bytes(b"png-frame")
    with tarfile.open(evidence / "openfoam_evidence.tar.gz", "w:gz") as archive:
        for name in ("evidence_manifest.json", "VTK", "openfoam", "time_directories"):
            archive.add(evidence / name, arcname=name)

    settings = Settings(
        data_dir=tmp_path / "data",
        evidence_bucket="test-bucket",
        evidence_remote_only=True,
        control_plane_token="test-control-plane-token-32-bytes-minimum",
        evidence_hydration_cache_dir=tmp_path / "cache",
        evidence_hydration_cache_max_gb=0.01,
    )
    return MigrationTarget(job_root, evidence), settings


def _store(settings: Settings, client: _FakeClient) -> EvidenceObjectStore:
    return EvidenceObjectStore(
        "test-bucket",
        settings.resolved_evidence_hydration_cache_dir(),
        client=client,
        cache_max_bytes=10 * 1024 * 1024,
    )


def test_legacy_gzip_migrates_verifies_restores_and_only_then_deletes(tmp_path: Path) -> None:
    target, settings = _fixture(tmp_path)
    evidence = target.evidence_dir
    client = _FakeClient()

    result = migrate_target(target, settings, store=_store(settings, client))

    assert result.status == "awaiting-database-registration"
    assert result.source_formats == ("gzip",)
    assert result.source_paths == ("openfoam_evidence.tar.gz",)
    assert result.to_dict()["sourceFormats"] == ["gzip"]
    assert result.to_dict()["sourcePaths"] == ["openfoam_evidence.tar.gz"]
    assert result.verification == "archive+manifest+all-members-restore:3"
    assert result.bytes_deleted == 0
    assert result.generation == "10000000000000000001"
    assert (evidence / "engine_evidence.remote.json").is_file()
    receipt = json.loads((evidence / "storage_migration.json").read_text())
    assert receipt["state"] == "awaiting_database_registration"
    assert receipt["deletedPaths"] == []
    assert receipt["bytesDeleted"] == 0
    assert receipt["archive"]["uncompressedTarSha256"] == receipt["sourceArchives"][0][
        "uncompressedTarSha256"
    ]
    for name in (
        "engine_evidence.tar.zst",
        "VTK",
        "openfoam",
        "time_directories",
    ):
        assert (evidence / name).exists(), name
    assert (evidence / "openfoam_evidence.tar.gz").is_file()
    assert (evidence / "evidence_manifest.json").is_file()
    assert (evidence / "frames" / "vorticity" / "f0000.png").is_file()
    assert len(client.objects) == 1

    retained_plan = plan_target(target)
    assert retained_plan.source_formats == ("zstd", "gzip")
    assert retained_plan.source_paths == (
        "engine_evidence.tar.zst",
        "openfoam_evidence.tar.gz",
    )

    waiting = migrate_target(target, settings, store=_store(settings, client))
    assert waiting.status == "awaiting-database-registration"
    assert waiting.source_formats == ("gzip",)
    assert waiting.source_paths == ("openfoam_evidence.tar.gz",)
    assert client.download_count == 1
    pointer = json.loads((evidence / "engine_evidence.remote.json").read_text())
    (evidence / "storage_migration.database.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "state": "registered",
                "jobId": target.job_id,
                "evidencePath": target.relative_evidence_path,
                "storedSha256": pointer["storedSha256"],
                "generation": pointer["generation"],
                "resultId": "result-one",
                "resultAttemptId": "attempt-one",
                "sourceArtifactId": "artifact-one",
                "archiveId": "archive-one",
                "registeredAt": "2026-07-15T21:00:00.123Z",
            }
        ),
        encoding="utf-8",
    )
    finalized = migrate_target(target, settings, store=_store(settings, client))
    assert finalized.status == "migrated"
    assert finalized.source_formats == ("gzip",)
    assert finalized.source_paths == ("openfoam_evidence.tar.gz",)
    # The final gate performs a new exact-generation download instead of
    # trusting the cache populated before database registration.
    assert client.download_count == 2
    for name in (
        "engine_evidence.tar.zst",
        "openfoam_evidence.tar.gz",
        "VTK",
        "openfoam",
        "time_directories",
    ):
        assert not (evidence / name).exists(), name
    assert json.loads((evidence / "storage_migration.json").read_text())["state"] == "complete"

    again = migrate_target(target, settings, store=_store(settings, client))
    assert again.status == "already-complete"
    assert again.source_formats == ("gzip",)
    assert again.source_paths == ("openfoam_evidence.tar.gz",)
    assert again.verification == "remote-metadata"


def _orphan_ack(target: MigrationTarget) -> dict[str, object]:
    evidence = target.evidence_dir
    pointer = json.loads((evidence / "engine_evidence.remote.json").read_text())
    manifest_bytes = (evidence / "evidence_manifest.json").read_bytes()
    member_count, member_set_sha256 = manifest_bundle_member_set_sha256(
        manifest_bytes
    )
    receipt_bytes = (evidence / "storage_migration.json").read_bytes()
    return {
        "schemaVersion": 1,
        "state": "quarantined",
        "registrationKind": "orphan_evidence_quarantine",
        "quarantineReason": "terminal_engine_evidence_not_ingested",
        "jobId": target.job_id,
        "evidencePath": target.relative_evidence_path,
        "storedSha256": pointer["storedSha256"],
        "generation": pointer["generation"],
        "quarantineId": "quarantine-one",
        "sourceArtifactId": "artifact-one",
        "blobId": "blob-one",
        "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
        "manifestByteSize": len(manifest_bytes),
        "archiveMemberSetSha256": member_set_sha256,
        "archiveMemberCount": member_count,
        "migrationReceiptSha256": hashlib.sha256(receipt_bytes).hexdigest(),
        "migrationReceiptByteSize": len(receipt_bytes),
        "quarantinedAt": "2026-07-17T08:00:00.123Z",
    }


def test_distinct_orphan_quarantine_ack_allows_only_fresh_verified_cleanup(
    tmp_path: Path,
) -> None:
    target, settings = _fixture(tmp_path)
    evidence = target.evidence_dir
    client = _FakeClient()
    store = _store(settings, client)

    assert migrate_target(target, settings, store=store).status == (
        "awaiting-database-registration"
    )
    ack = _orphan_ack(target)
    (evidence / "storage_migration.database.json").write_text(
        json.dumps(ack), encoding="utf-8"
    )

    finalized = migrate_target(target, settings, store=store)
    assert finalized.status == "migrated"
    assert client.download_count == 2
    receipt = json.loads((evidence / "storage_migration.json").read_text())
    assert receipt["databaseQuarantine"] == ack
    assert receipt["databaseAcknowledgement"] == ack
    assert "databaseRegistration" not in receipt
    for name in (
        "engine_evidence.tar.zst",
        "openfoam_evidence.tar.gz",
        "VTK",
        "openfoam",
        "time_directories",
    ):
        assert not (evidence / name).exists(), name


@pytest.mark.parametrize(
    ("mutation", "message"),
    [
        ({"resultId": "invented-result"}, "must not claim result ownership"),
        ({"archiveMemberSetSha256": "0" * 64}, "archiveMemberSetSha256"),
        ({"migrationReceiptSha256": "1" * 64}, "migrationReceiptSha256"),
        ({"registrationKind": "canonical_result"}, "registrationKind"),
        ({"quarantineReason": "unknown"}, "quarantineReason"),
    ],
)
def test_orphan_ack_mismatch_never_deletes_local_evidence(
    tmp_path: Path,
    mutation: dict[str, object],
    message: str,
) -> None:
    target, settings = _fixture(tmp_path)
    evidence = target.evidence_dir
    client = _FakeClient()
    store = _store(settings, client)
    assert migrate_target(target, settings, store=store).status == (
        "awaiting-database-registration"
    )
    ack = {**_orphan_ack(target), **mutation}
    (evidence / "storage_migration.database.json").write_text(
        json.dumps(ack), encoding="utf-8"
    )

    with pytest.raises(EvidenceMigrationError, match=message):
        migrate_target(target, settings, store=store)

    for name in (
        "engine_evidence.tar.zst",
        "openfoam_evidence.tar.gz",
        "VTK",
        "openfoam",
        "time_directories",
    ):
        assert (evidence / name).exists(), name
    assert json.loads((evidence / "storage_migration.json").read_text())[
        "state"
    ] == "awaiting_database_registration"


def test_completed_migration_rechecks_pinned_remote_generation(tmp_path: Path) -> None:
    target, settings = _fixture(tmp_path)
    evidence = target.evidence_dir
    client = _FakeClient()
    store = _store(settings, client)

    waiting = migrate_target(target, settings, store=store)
    pointer = json.loads((evidence / "engine_evidence.remote.json").read_text())
    (evidence / "storage_migration.database.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "state": "registered",
                "jobId": target.job_id,
                "evidencePath": target.relative_evidence_path,
                "storedSha256": pointer["storedSha256"],
                "generation": pointer["generation"],
                "resultId": "result-one",
                "resultAttemptId": "attempt-one",
                "sourceArtifactId": "artifact-one",
                "archiveId": "archive-one",
                "registeredAt": "2026-07-15T21:00:00.123Z",
            }
        ),
        encoding="utf-8",
    )
    assert waiting.status == "awaiting-database-registration"
    assert migrate_target(target, settings, store=store).status == "migrated"
    client.objects.clear()

    with pytest.raises(
        EvidenceMigrationError,
        match="completed migration remote verification failed",
    ):
        migrate_target(target, settings, store=store)


def test_upload_failure_preserves_every_local_source_and_writes_no_receipt(tmp_path: Path) -> None:
    target, settings = _fixture(tmp_path)
    evidence = target.evidence_dir
    client = _FakeClient()
    client.fail_upload = True

    with pytest.raises(EvidenceMigrationError, match="remote upload failed"):
        migrate_target(target, settings, store=_store(settings, client))

    assert (evidence / "openfoam_evidence.tar.gz").is_file()
    assert (evidence / "engine_evidence.tar.zst").is_file()
    assert (evidence / "VTK" / "value.vtu").is_file()
    assert not (evidence / "engine_evidence.remote.json").exists()
    assert not (evidence / "storage_migration.json").exists()


def test_dry_run_and_discovery_never_mutate_and_skip_active_jobs(tmp_path: Path) -> None:
    target, _settings = _fixture(tmp_path)
    active, _ = _fixture(tmp_path / "active", state="running")
    case_root = target.evidence_dir.parent
    for heavy_relative in (
        "VTK/deep/evidence",
        "openfoam/copied/evidence",
        "processor0/deep/evidence",
        "100.5/deep/evidence",
    ):
        false_evidence = case_root / heavy_relative
        false_evidence.mkdir(parents=True)
        (false_evidence / "openfoam_evidence.tar.gz").write_bytes(b"not evidence")

    discovered = list(discover_targets(target.job_root.parent))
    assert discovered == [target]
    assert list(
        discover_targets(target.job_root.parent, job_ids={target.job_id})
    ) == [target]
    with pytest.raises(EvidenceMigrationError, match="safe path segment"):
        list(discover_targets(target.job_root.parent, job_ids={"../job-one"}))
    assert list(discover_targets(active.job_root.parent)) == []
    planned = plan_target(target)
    assert planned.status == "planned"
    assert planned.source_formats == ("gzip",)
    assert planned.source_paths == ("openfoam_evidence.tar.gz",)
    assert planned.to_dict()["sourceFormats"] == ["gzip"]
    assert planned.to_dict()["sourcePaths"] == ["openfoam_evidence.tar.gz"]
    assert (target.evidence_dir / "openfoam_evidence.tar.gz").is_file()
    assert not (target.evidence_dir / "engine_evidence.tar.zst").exists()


def test_exact_evidence_paths_are_sorted_deduplicated_and_never_prefix_match(
    tmp_path: Path,
) -> None:
    target, settings = _fixture(tmp_path)
    selected_second = (
        target.job_root / "cases" / "case-one" / "a1" / "evidence"
    )
    prefix_neighbor = (
        target.job_root / "cases" / "case-one" / "a1-extra" / "evidence"
    )
    shutil.copytree(target.evidence_dir, selected_second)
    shutil.copytree(target.evidence_dir, prefix_neighbor)
    first_path = target.relative_evidence_path
    second_path = selected_second.relative_to(target.job_root).as_posix()

    discovered = list(
        discover_targets(
            target.job_root.parent,
            job_ids={target.job_id},
            evidence_paths=[second_path, first_path, second_path],
        )
    )

    assert [row.relative_evidence_path for row in discovered] == [
        first_path,
        second_path,
    ]
    assert prefix_neighbor.relative_to(target.job_root).as_posix() not in {
        row.relative_evidence_path for row in discovered
    }
    planned = run_migration(
        settings,
        jobs_root=target.job_root.parent,
        job_ids={target.job_id},
        evidence_paths=[second_path, first_path, second_path],
    )
    assert [row.evidence_path for row in planned] == [first_path, second_path]


@pytest.mark.parametrize(
    "unsafe_path",
    [
        "../job-two/cases/case-one/a0/evidence",
        "/cases/case-one/a0/evidence",
        "cases//case-one/a0/evidence",
        "cases/./case-one/a0/evidence",
        "cases/case-one/../a0/evidence",
        "cases\\case-one\\a0\\evidence",
        "cases/case-one/a0/evidence\n",
    ],
)
def test_exact_evidence_path_rejects_traversal_and_noncanonical_paths(
    tmp_path: Path,
    unsafe_path: str,
) -> None:
    target, _settings = _fixture(tmp_path)

    with pytest.raises(EvidenceMigrationError, match="evidence path"):
        list(
            discover_targets(
                target.job_root.parent,
                job_ids={target.job_id},
                evidence_paths=[unsafe_path],
            )
        )


def test_exact_evidence_paths_require_one_job_and_every_path_to_resolve(
    tmp_path: Path,
) -> None:
    target, settings = _fixture(tmp_path)
    other_job = target.job_root.parent / "job-two"
    shutil.copytree(target.job_root, other_job)
    other_evidence = other_job / "cases" / "other-case" / "evidence"
    shutil.copytree(target.evidence_dir, other_evidence)
    cross_job_path = other_evidence.relative_to(other_job).as_posix()

    for job_ids in (None, {target.job_id, other_job.name}):
        with pytest.raises(EvidenceMigrationError, match="exactly one job id"):
            list(
                discover_targets(
                    target.job_root.parent,
                    job_ids=job_ids,
                    evidence_paths=[target.relative_evidence_path],
                )
            )

    with pytest.raises(EvidenceMigrationError, match="did not resolve"):
        list(
            discover_targets(
                target.job_root.parent,
                job_ids={target.job_id},
                evidence_paths=[target.relative_evidence_path, cross_job_path],
            )
        )
    with pytest.raises(EvidenceMigrationError, match="did not resolve"):
        run_migration(
            settings,
            jobs_root=target.job_root.parent,
            execute=True,
            job_ids={target.job_id},
            evidence_paths=[target.relative_evidence_path, cross_job_path],
        )
    assert not (target.evidence_dir / "engine_evidence.tar.zst").exists()
    assert not (target.evidence_dir / "storage_migration.json").exists()


def test_cli_exact_evidence_paths_require_one_job_and_forbid_limit() -> None:
    with pytest.raises(SystemExit) as missing_job:
        evidence_migration._parse_args(  # noqa: SLF001 - MUST-CATCH CLI contract
            ["--evidence-path", "cases/case-one/a0/evidence"]
        )
    assert missing_job.value.code == 2

    with pytest.raises(SystemExit) as repeated_job:
        evidence_migration._parse_args(  # noqa: SLF001 - MUST-CATCH CLI contract
            [
                "--job-id",
                "job-one",
                "--job-id",
                "job-one",
                "--evidence-path",
                "cases/case-one/a0/evidence",
            ]
        )
    assert repeated_job.value.code == 2

    with pytest.raises(SystemExit) as limited:
        evidence_migration._parse_args(  # noqa: SLF001 - MUST-CATCH CLI contract
            [
                "--job-id",
                "job-one",
                "--evidence-path",
                "cases/case-one/a0/evidence",
                "--limit",
                "1",
            ]
        )
    assert limited.value.code == 2


def test_discovery_and_execution_reject_symlinked_job_roots(tmp_path: Path) -> None:
    outside_target, settings = _fixture(tmp_path / "outside")
    jobs_root = tmp_path / "data" / "jobs"
    jobs_root.mkdir(parents=True)
    linked_job = jobs_root / "linked-job"
    linked_job.symlink_to(outside_target.job_root, target_is_directory=True)

    assert list(discover_targets(jobs_root)) == []
    linked_evidence = linked_job / outside_target.evidence_dir.relative_to(
        outside_target.job_root
    )
    with pytest.raises(EvidenceMigrationError, match="must not be a symlink"):
        migrate_target(
            MigrationTarget(linked_job, linked_evidence),
            settings,
            store=_store(settings, _FakeClient()),
        )

    assert (outside_target.evidence_dir / "openfoam_evidence.tar.gz").is_file()
    assert not (outside_target.evidence_dir / "storage_migration.json").exists()


def test_manifest_member_omitted_from_archive_blocks_migration_and_preserves_sources(
    tmp_path: Path,
) -> None:
    target, settings = _fixture(tmp_path)
    evidence = target.evidence_dir
    # Reproduce the destructive legacy gap: the retained manifest names logs
    # and saved fields, but the legacy archive contains only manifest + VTK.
    with tarfile.open(evidence / "openfoam_evidence.tar.gz", "w:gz") as archive:
        for name in ("evidence_manifest.json", "VTK"):
            archive.add(evidence / name, arcname=name)

    with pytest.raises(
        EvidenceMigrationError,
        match="manifest member missing from archive: openfoam/logs/log.simpleFoam",
    ):
        migrate_target(target, settings, store=_store(settings, _FakeClient()))

    for name in (
        "engine_evidence.tar.zst",
        "openfoam_evidence.tar.gz",
        "VTK",
        "openfoam",
        "time_directories",
    ):
        assert (evidence / name).exists(), name
    assert not (evidence / "storage_migration.json").exists()


def test_execute_lock_refuses_migration_without_mutation(tmp_path: Path) -> None:
    target, settings = _fixture(tmp_path)
    client = _FakeClient()
    lock_path = target.job_root / ".execute.lock"
    with lock_path.open("a+") as lock_file:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        with pytest.raises(EvidenceMigrationError, match="execution lock is held"):
            migrate_target(target, settings, store=_store(settings, client))
    assert (target.evidence_dir / "openfoam_evidence.tar.gz").is_file()
    assert not client.objects


@pytest.mark.parametrize(
    "registered_at",
    [
        None,
        "not-a-timestamp",
        "2026-07-15T21:00:00",
        "2026-07-15T22:00:00+01:00",
    ],
)
def test_database_ack_requires_valid_utc_iso_registered_at_before_local_delete(
    tmp_path: Path, registered_at: str | None
) -> None:
    target, settings = _fixture(tmp_path)
    evidence = target.evidence_dir
    client = _FakeClient()
    store = _store(settings, client)

    waiting = migrate_target(target, settings, store=store)
    assert waiting.status == "awaiting-database-registration"
    pointer = json.loads((evidence / "engine_evidence.remote.json").read_text())
    ack = {
        "schemaVersion": 1,
        "state": "registered",
        "jobId": target.job_id,
        "evidencePath": target.relative_evidence_path,
        "storedSha256": pointer["storedSha256"],
        "generation": pointer["generation"],
        "resultId": "result-one",
        "resultAttemptId": "attempt-one",
        "sourceArtifactId": "artifact-one",
        "archiveId": "archive-one",
    }
    if registered_at is not None:
        ack["registeredAt"] = registered_at
    (evidence / "storage_migration.database.json").write_text(
        json.dumps(ack), encoding="utf-8"
    )

    with pytest.raises(EvidenceMigrationError, match="registeredAt"):
        migrate_target(target, settings, store=store)

    # The database receipt is not trustworthy, so the legacy source remains
    # the local recovery copy and the migration receipt stays explicitly open.
    assert (evidence / "openfoam_evidence.tar.gz").is_file()
    assert (evidence / "engine_evidence.tar.zst").is_file()
    assert (evidence / "VTK" / "value.vtu").is_file()
    receipt = json.loads((evidence / "storage_migration.json").read_text())
    assert receipt["state"] == "awaiting_database_registration"


def test_fresh_remote_restore_failure_after_valid_ack_preserves_all_local_sources(
    tmp_path: Path,
) -> None:
    target, settings = _fixture(tmp_path)
    evidence = target.evidence_dir
    client = _FakeClient()
    store = _store(settings, client)

    waiting = migrate_target(target, settings, store=store)
    assert waiting.status == "awaiting-database-registration"
    pointer = json.loads((evidence / "engine_evidence.remote.json").read_text())
    (evidence / "storage_migration.database.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "state": "registered",
                "jobId": target.job_id,
                "evidencePath": target.relative_evidence_path,
                "storedSha256": pointer["storedSha256"],
                "generation": pointer["generation"],
                "resultId": "result-one",
                "resultAttemptId": "attempt-one",
                "sourceArtifactId": "artifact-one",
                "archiveId": "archive-one",
                "registeredAt": "2026-07-15T21:00:00.123Z",
            }
        ),
        encoding="utf-8",
    )
    client.fail_download = True

    with pytest.raises(EvidenceMigrationError, match="remote restore verification failed"):
        migrate_target(target, settings, store=store)

    for name in (
        "engine_evidence.tar.zst",
        "openfoam_evidence.tar.gz",
        "VTK",
        "openfoam",
        "time_directories",
    ):
        assert (evidence / name).exists(), name
    receipt = json.loads((evidence / "storage_migration.json").read_text())
    assert receipt["state"] == "awaiting_database_registration"


def test_vtk_restore_rejects_archive_with_different_local_manifest(
    tmp_path: Path,
) -> None:
    target, settings = _fixture(tmp_path)
    evidence = target.evidence_dir
    client = _FakeClient()
    store = _store(settings, client)

    waiting = migrate_target(target, settings, store=store)
    assert waiting.status == "awaiting-database-registration"
    pointer = json.loads((evidence / "engine_evidence.remote.json").read_text())
    (evidence / "storage_migration.database.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "state": "registered",
                "jobId": target.job_id,
                "evidencePath": target.relative_evidence_path,
                "storedSha256": pointer["storedSha256"],
                "generation": pointer["generation"],
                "resultId": "result-one",
                "resultAttemptId": "attempt-one",
                "sourceArtifactId": "artifact-one",
                "archiveId": "archive-one",
                "registeredAt": "2026-07-15T21:00:00.123Z",
            }
        ),
        encoding="utf-8",
    )
    local_manifest = json.loads((evidence / "evidence_manifest.json").read_text())
    local_manifest["files"][0]["role"] = "mutated-local-role"
    (evidence / "evidence_manifest.json").write_text(
        json.dumps(local_manifest, sort_keys=True),
        encoding="utf-8",
    )

    with pytest.raises(
        EvidenceMigrationError,
        match="restored evidence manifest does not match local manifest",
    ):
        migrate_target(target, settings, store=store)

    for name in (
        "engine_evidence.tar.zst",
        "openfoam_evidence.tar.gz",
        "VTK",
        "openfoam",
        "time_directories",
    ):
        assert (evidence / name).exists(), name
