from __future__ import annotations

from argparse import Namespace
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = (
    ROOT
    / "scripts"
    / "deploy"
    / "pending-cutover-canary-db-ack-recovery.py"
)
WRAPPER_PATH = (
    ROOT
    / "scripts"
    / "deploy"
    / "recover-pending-opencfd2606-canary-db-ack.sh"
)
MIGRATION_VERIFIER = (
    ROOT / "scripts" / "deploy" / "verify-opencfd2606-canary-migration.sh"
)
REBUILD = ROOT / "scripts" / "deploy" / "rebuild-engine.sh"


def _load_helper():
    spec = importlib.util.spec_from_file_location("canary_db_ack_recovery", HELPER_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _private_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)


def test_source_contract_binds_bound_current_target_and_exact_changed_hashes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    helper = _load_helper()
    bound = tmp_path / "bound"
    current = tmp_path / "current"
    target = tmp_path / "target"
    bound.mkdir()
    (bound / "a.txt").write_text("bound\n", encoding="utf-8")
    shutil.copytree(bound, current)
    shutil.copytree(bound, target)
    (target / "b.txt").write_text("reviewed\n", encoding="utf-8")
    manifest_tool = ROOT / "scripts" / "deploy" / "deployment-source-manifest.py"
    model = helper.load_manifest_model(manifest_tool)
    bound_tree, bound_count = model._source_tree(bound)
    current_tree, current_count = model._source_tree(current)
    target_tree, target_count = model._source_tree(target)
    bound_revision = "1" * 40
    current_revision = "3" * 40
    target_revision = "2" * 40
    _private_json(
        bound / ".deployment-source.json",
        {
            "schemaVersion": 1,
            "sourceRevision": bound_revision,
            "sourceTreeSha256": bound_tree,
            "fileCount": bound_count,
        },
    )
    (bound / ".deployment-source.json").chmod(0o644)
    _private_json(
        current / ".deployment-source.json",
        {
            "schemaVersion": 1,
            "sourceRevision": current_revision,
            "sourceTreeSha256": current_tree,
            "fileCount": current_count,
        },
    )
    (current / ".deployment-source.json").chmod(0o644)
    _private_json(
        target / ".deployment-source.json",
        {
            "schemaVersion": 1,
            "sourceRevision": target_revision,
            "sourceTreeSha256": target_tree,
            "fileCount": target_count,
        },
    )
    (target / ".deployment-source.json").chmod(0o644)
    monkeypatch.setattr(helper, "BOUND_REVISION", bound_revision)
    monkeypatch.setattr(helper, "BOUND_TREE", bound_tree)
    monkeypatch.setattr(helper, "BOUND_COUNT", bound_count)
    monkeypatch.setattr(helper, "CURRENT_SOURCE_REVISION", current_revision)
    monkeypatch.setattr(helper, "CURRENT_SOURCE_TREE", current_tree)
    monkeypatch.setattr(helper, "CURRENT_SOURCE_COUNT", current_count)
    b_sha = _sha(target / "b.txt")
    changeset = hashlib.sha256(
        f"b.txt\tfile\t0\t{b_sha}\n".encode("utf-8")
    ).hexdigest()
    args = Namespace(
        manifest_tool=manifest_tool,
        bound_root=bound,
        bound_manifest=bound / ".deployment-source.json",
        current_root=current,
        current_manifest=current / ".deployment-source.json",
        target_root=target,
        target_manifest=target / ".deployment-source.json",
        expected_target_revision=target_revision,
        expected_target_tree=target_tree,
        expected_target_count=target_count,
        expected_changeset_sha256=changeset,
        expected_file_hash=[f"b.txt={b_sha}"],
    )

    result = helper.validate_source_contract(args)

    assert result["sourceChangeSha256"] == changeset
    assert [item["path"] for item in result["sourceChangePaths"]] == ["b.txt"]
    (target / "b.txt").write_text("drift\n", encoding="utf-8")
    with pytest.raises(helper.ContractError, match="deployment source does not match"):
        helper.validate_source_contract(args)
    (target / "b.txt").write_text("reviewed\n", encoding="utf-8")
    (current / "a.txt").write_text("wrong-r3-source\n", encoding="utf-8")
    with pytest.raises(helper.ContractError, match="deployment source does not match"):
        helper.validate_source_contract(args)


def _predecessor_payloads(
    helper,
    node_path: Path,
    queue_path: Path,
    replay_path: Path,
    retention_path: Path,
):
    node = {
        "schemaVersion": 1,
        "purpose": "pending-opencfd2606-node-api-timeout-repair",
        "status": "applied",
        "boundSourceRevision": helper.BOUND_REVISION,
        "boundSourceTreeSha256": helper.BOUND_TREE,
        "repairSourceRevision": helper.NODE_REPAIR_REVISION,
        "repairSourceTreeSha256": helper.NODE_REPAIR_TREE,
        "nodeApiImageBefore": "sha256:" + "1" * 64,
        "nodeApiImageAfter": "sha256:" + "2" * 64,
        "nodeApiContainerAfter": "3" * 64,
        "appliedAt": "2026-07-17T02:00:00+00:00",
    }
    _private_json(node_path, node)
    helper.NODE_REPAIR_JOURNAL_SHA256 = _sha(node_path)
    queue = {
        "schemaVersion": 1,
        "purpose": "pending-opencfd2606-queue-probe-resume",
        "status": "failed",
        "exitCode": 14,
        "boundSourceRevision": helper.BOUND_REVISION,
        "runnerSourceRevision": helper.QUEUE_RUNNER_REVISION,
        "runnerSourceTreeSha256": helper.QUEUE_RUNNER_TREE,
        "rebuildScriptSha256": helper.QUEUE_REBUILD_SHA256,
        "buildId": helper.PREVIOUS_BUILD_ID,
        "updatedAt": "2026-07-17T02:30:00+00:00",
    }
    _private_json(queue_path, queue)
    helper.QUEUE_REPAIR_JOURNAL_SHA256 = _sha(queue_path)
    replay = {
        "schemaVersion": 1,
        "purpose": "pending-opencfd2606-same-build-replay",
        "status": "failed",
        "completedAt": None,
        "failureCount": 1,
        "lastExitCode": 14,
        "boundSourceRevision": helper.BOUND_REVISION,
        "boundSourceTreeSha256": helper.BOUND_TREE,
        "replaySourceRevision": helper.SAME_BUILD_REPLAY_REVISION,
        "replaySourceTreeSha256": helper.SAME_BUILD_REPLAY_TREE,
        "buildId": helper.PREVIOUS_BUILD_ID,
        "nodeRepairReceiptSha256": helper.NODE_REPAIR_JOURNAL_SHA256,
        "nodeApiImageBefore": helper.SAME_BUILD_REPLAY_NODE_BEFORE,
        "nodeApiImageAfter": helper.SAME_BUILD_REPLAY_NODE_AFTER,
        "nodeApiAdminRoutesSha256": helper.SAME_BUILD_REPLAY_ADMIN_ROUTES_SHA256,
        "nodeApiAttestationSha256": helper.SAME_BUILD_REPLAY_ATTESTATION_SHA256,
        "deploymentEnvironmentBeforeSha256": helper.SAME_BUILD_REPLAY_ENV_SHA256,
        "currentDeploymentEnvironmentSha256": helper.SAME_BUILD_REPLAY_ENV_SHA256,
        "currentApiImage": helper.SAME_BUILD_REPLAY_API_IMAGE,
        "currentWorkerImage": helper.SAME_BUILD_REPLAY_WORKER_IMAGE,
        "currentDatabaseSnapshotSha256": helper.SAME_BUILD_REPLAY_DATABASE_SHA256,
        "currentCanaryReceiptSha256": "absent",
        "currentCutoverStateKind": "pending-pristine",
        "nodeApiContainerAfter": "4" * 64,
        "failedAt": "2026-07-17T03:04:30+00:00",
    }
    _private_json(replay_path, replay)
    replay_sha = _sha(replay_path)
    retention = {
        "schemaVersion": 1,
        "purpose": "pending-opencfd2606-retention-retry",
        "status": "failed",
        "preparedAt": "2026-07-17T03:42:00+00:00",
        "updatedAt": "2026-07-17T03:49:00+00:00",
        "completedAt": None,
        "failureCount": 1,
        "lastExitCode": 14,
        "priorFailedReplayJournalSha256": replay_sha,
        "boundReleaseSourceRevision": helper.BOUND_REVISION,
        "boundReleaseSourceTreeSha256": helper.BOUND_TREE,
        "priorReplaySourceRevision": helper.SAME_BUILD_REPLAY_REVISION,
        "engineSourceRevision": helper.CURRENT_SOURCE_REVISION,
        "engineSourceTreeSha256": helper.CURRENT_SOURCE_TREE,
        "engineSourceFileCount": helper.CURRENT_SOURCE_COUNT,
        "engineApplicationSourceSha256": "5" * 64,
        "nodeSourceRevision": helper.SAME_BUILD_REPLAY_REVISION,
        "nodeApiImage": helper.CURRENT_NODE_IMAGE,
        "nodeApiAdminRoutesSha256": helper.SAME_BUILD_REPLAY_ADMIN_ROUTES_SHA256,
        "nodeApiAttestationSha256": helper.SAME_BUILD_REPLAY_ATTESTATION_SHA256,
        "nodeApiContainerBefore": "6" * 64,
        "nodeApiContainerAfter": "7" * 64,
        "buildId": helper.CURRENT_BUILD_ID,
        "action": "rebuild_and_canary",
        "deploymentEnvironmentBeforeSha256": "8" * 64,
        "sourceBoundDeploymentEnvironmentSha256": "9" * 64,
        "promotionEligible": False,
        "currentDeploymentEnvironmentSha256": "a" * 64,
        "currentApiImage": helper.CURRENT_API_IMAGE,
        "currentWorkerImage": helper.CURRENT_WORKER_IMAGE,
        "currentDatabaseSnapshotSha256": "b" * 64,
        "currentCanaryReceiptSha256": "absent",
        "currentCutoverStateKind": "pending-pristine",
        "currentNodeApiImage": helper.CURRENT_NODE_IMAGE,
        "currentNodeExpectedBuildId": helper.CURRENT_BUILD_ID,
    }
    _private_json(retention_path, retention)
    helper.RETENTION_RETRY_JOURNAL_SHA256 = _sha(retention_path)
    return replay, retention


def test_predecessor_contract_requires_all_four_failed_recovery_records(
    tmp_path: Path,
) -> None:
    helper = _load_helper()
    node = tmp_path / "node.json"
    queue = tmp_path / "queue.json"
    replay = tmp_path / "replay.json"
    retention = tmp_path / "retention.json"
    replay_payload, retention_payload = _predecessor_payloads(
        helper, node, queue, replay, retention
    )
    replay_sha = _sha(replay)

    result = helper.validate_predecessor_journals(
        node, queue, replay, retention, replay_sha
    )

    assert result["sameBuildReplayJournalSha256"] == replay_sha
    assert result["sameBuildReplayNodeContainerAfter"] == "4" * 64
    assert result["retentionRetryJournalSha256"] == _sha(retention)
    assert result["retentionRetryNodeContainerAfter"] == "7" * 64
    retention_payload["currentApiImage"] = "sha256:" + "f" * 64
    _private_json(retention, retention_payload)
    with pytest.raises(helper.ContractError, match="fourth incident record"):
        helper.validate_predecessor_journals(node, queue, replay, retention, replay_sha)
    _private_json(retention, {**retention_payload, "currentApiImage": helper.CURRENT_API_IMAGE})
    replay_payload["status"] = "completed"
    _private_json(replay, replay_payload)
    with pytest.raises(helper.ContractError, match="same-build replay journal differs"):
        helper.validate_predecessor_journals(node, queue, replay, retention, replay_sha)

    retention.unlink()
    with pytest.raises(helper.ContractError, match="required file is missing"):
        helper.validate_predecessor_journals(node, queue, replay, retention, replay_sha)


def _backup_fixture(tmp_path: Path):
    helper = _load_helper()
    backup_dir = tmp_path / "backups"
    backup_dir.mkdir(mode=0o700)
    dump = backup_dir / "aerodb.dump"
    dump.write_bytes(b"custom postgres backup")
    dump.chmod(0o600)
    container_id = "a" * 64
    image_id = "sha256:" + "b" * 64
    catalog = {"tables": 10, "sequences": 2, "views": 1, "functions": 5}
    manifest = {
        "schema_version": 2,
        "type": "postgres-docker-backup",
        "created_at": "2026-07-17T03:10:00Z",
        "scope": "database",
        "format": "custom",
        "size": dump.stat().st_size,
        "sha256": _sha(dump),
        "source": {
            "container": {"id": container_id, "image_id": image_id},
            "postgres": {
                "user": "aerodb",
                "database": "aerodb",
                "scope": "database",
                "catalog": catalog,
            },
        },
        "publication": {
            "atomic_artifact": True,
            "exclusive": True,
            "directory_mode": "0700",
            "file_mode": "0600",
        },
        "verification": {
            "verified_at": "2026-07-17T03:12:00Z",
            "mode": "test_restore",
            "scope": "database",
            "sha256": _sha(dump),
            "ok": True,
            "verification_target": "scratch_database",
            "catalog_signature": catalog,
            "container_identity_preflight": {
                "expected_id": container_id,
                "actual_id": container_id,
                "match": "exact_full",
                "execution_target": "immutable_full_id",
            },
        },
    }
    manifest_path = backup_dir / "aerodb.dump.manifest.json"
    _private_json(manifest_path, manifest)
    receipt = {
        "schemaVersion": 1,
        "purpose": "airfoils-pro-postgres-off-vps-copy",
        "backupSha256": _sha(dump),
        "backupSize": dump.stat().st_size,
        "backupManifestSha256": _sha(manifest_path),
        "backupManifestSize": manifest_path.stat().st_size,
        "sourceContainerId": container_id,
        "sourceImageId": image_id,
        "destination": {
            "scheme": "gs",
            "locator": "gs://private-backups/aerodb.dump",
            "immutableVersion": "1780000000000000",
            "manifestLocator": (
                "gs://private-backups/aerodb.dump."
                f"{_sha(manifest_path)}.manifest.json"
            ),
            "manifestImmutableVersion": "1780000000000001",
        },
        "verification": {
            "ok": True,
            "method": "remote-download-sha256",
            "sha256": _sha(dump),
            "size": dump.stat().st_size,
            "manifestSha256": _sha(manifest_path),
            "manifestSize": manifest_path.stat().st_size,
            "verifiedAt": "2026-07-17T03:14:00Z",
        },
    }
    receipt_path = tmp_path / "off-vps.json"
    _private_json(receipt_path, receipt)
    args = Namespace(
        backup=dump,
        manifest=manifest_path,
        off_vps_receipt=receipt_path,
        expected_backup_sha256=_sha(dump),
        expected_manifest_sha256=_sha(manifest_path),
        expected_receipt_sha256=_sha(receipt_path),
        expected_postgres_container_id=container_id,
        expected_postgres_image_id=image_id,
        not_before="2026-07-17T03:04:30+00:00",
    )
    return helper, args, manifest


def test_backup_contract_requires_scratch_restore_and_verified_off_vps_copy(
    tmp_path: Path,
) -> None:
    helper, args, manifest = _backup_fixture(tmp_path)

    result = helper.validate_backup_contract(args)

    assert result["backupSha256"] == args.expected_backup_sha256
    assert result["offVpsDestination"]["scheme"] == "gs"
    manifest["verification"]["mode"] = "lightweight"
    _private_json(args.manifest, manifest)
    args.expected_manifest_sha256 = _sha(args.manifest)
    with pytest.raises(helper.ContractError, match="strong verification"):
        helper.validate_backup_contract(args)


def test_backup_contract_requires_generation_locked_remote_manifest_proof(
    tmp_path: Path,
) -> None:
    helper, args, _manifest = _backup_fixture(tmp_path)
    receipt = json.loads(args.off_vps_receipt.read_text(encoding="utf-8"))
    receipt["verification"].pop("manifestSha256")
    _private_json(args.off_vps_receipt, receipt)
    args.expected_receipt_sha256 = _sha(args.off_vps_receipt)

    with pytest.raises(helper.ContractError, match="remote verification"):
        helper.validate_backup_contract(args)


def _runtime_fixture(helper):
    ids = {
        "api": "1" * 64,
        "worker": "2" * 64,
        "node-api": "3" * 64,
        "sweeper": "4" * 64,
        "media-repair": "5" * 64,
        "postgres": "6" * 64,
    }
    images = {name: "sha256:" + str(index) * 64 for index, name in enumerate(ids, 1)}
    services = {}
    for service in ids:
        identity_environment = {}
        if service in {"api", "worker", "sweeper", "media-repair"}:
            identity_environment["AIRFOILFOAM_BUILD_ID"] = (
                helper.CURRENT_BUILD_ID
                if service in {"api", "worker"}
                else helper.PREVIOUS_BUILD_ID
            )
        if service == "node-api":
            identity_environment["ENGINE_EXPECTED_BUILD_ID"] = helper.CURRENT_BUILD_ID
        mounts = []
        if service in {"api", "worker", "node-api", "sweeper", "media-repair"}:
            mounts.append(
                {
                    "name": helper.RESULTS_VOLUME,
                    "destination": "/data/airfoilfoam",
                    "rw": service != "node-api",
                }
            )
        services[service] = {
            "containerId": ids[service],
            "imageId": images[service],
            "running": service in {"api", "worker", "node-api", "postgres"},
            "identityEnvironment": identity_environment,
            "mounts": mounts,
        }
    volume = {
        "Name": helper.RESULTS_VOLUME,
        "Driver": "local",
        "Mountpoint": "/var/lib/docker/volumes/app_results/_data",
        "CreatedAt": "2026-07-01T00:00:00Z",
        "Scope": "local",
        "Labels": {
            "com.docker.compose.project": "app",
            "com.docker.compose.volume": "results",
        },
        "Options": None,
    }
    snapshot = {
        "schemaVersion": 1,
        "stage": "test",
        "composeProjectName": "app",
        "services": services,
        "health": {
            "build_id": helper.CURRENT_BUILD_ID,
            "default_engine": {"version": "2606"},
        },
        "queue": {
            "queue_depth": 0,
            "active_count": 0,
            "reserved_count": 0,
            "scheduled_count": 0,
            "worker_queues_error": None,
            "worker_runtime_error": None,
            "inspection_errors": {},
            "queue_depths": {"openfoam-opencfd-2606": 0},
            "worker_queues": [{"worker": "celery@worker", "queues": ["openfoam-opencfd-2606"]}],
        },
        "workerTop": "PID COMMAND\n1 celery worker",
        "poolEnabled": False,
        "attestationCount": 0,
        "resultsVolume": volume,
    }
    expected = {service: (ids[service], images[service]) for service in ids}
    volume_sha = helper.canonical_sha256(helper.volume_identity(volume))
    return snapshot, expected, volume_sha


def test_runtime_contract_detects_image_and_results_volume_drift() -> None:
    helper = _load_helper()
    snapshot, expected, volume_sha = _runtime_fixture(helper)

    assert helper.validate_runtime_snapshot(snapshot, expected, volume_sha)[
        "resultsVolumeIdentitySha256"
    ] == volume_sha
    snapshot["services"]["worker"]["imageId"] = "sha256:" + "f" * 64
    with pytest.raises(helper.ContractError, match="runtime service worker"):
        helper.validate_runtime_snapshot(snapshot, expected, volume_sha)
    snapshot, expected, volume_sha = _runtime_fixture(helper)
    snapshot["services"]["api"]["identityEnvironment"][
        "AIRFOILFOAM_BUILD_ID"
    ] = helper.PREVIOUS_BUILD_ID
    with pytest.raises(helper.ContractError, match="exact incident build"):
        helper.validate_runtime_snapshot(snapshot, expected, volume_sha)
    snapshot, expected, volume_sha = _runtime_fixture(helper)
    snapshot["attestationCount"] = 1
    with pytest.raises(helper.ContractError, match="already has a canary attestation"):
        helper.validate_runtime_snapshot(snapshot, expected, volume_sha)
    snapshot, expected, volume_sha = _runtime_fixture(helper)
    snapshot["resultsVolume"]["CreatedAt"] = "2026-07-17T00:00:00Z"
    with pytest.raises(helper.ContractError, match="volume identity drifted"):
        helper.validate_runtime_snapshot(snapshot, expected, volume_sha)


def test_rollback_boundary_is_irreversible_after_receipt_or_db_attestation() -> None:
    helper = _load_helper()
    pristine = {
        "OPENCFD2606_CUTOVER_PENDING": "1",
        "OPENCFD2606_CUTOVER_COMPLETE": "0",
        "OPENCFD2606_CANARY_RECEIPT_EXPECTED": "0",
        "OPENCFD2606_CANARY_ATTESTATION_ID": "",
    }
    assert (
        helper.classify_rollback_boundary(pristine, False)
        == "pre-receipt-rollback-eligible"
    )
    assert (
        helper.classify_rollback_boundary(pristine, True)
        == "post-receipt-rollback-forbidden"
    )
    registered = dict(pristine, OPENCFD2606_CANARY_RECEIPT_EXPECTED="1")
    assert (
        helper.classify_rollback_boundary(registered, False)
        == "post-receipt-rollback-forbidden"
    )
    attested = dict(
        pristine,
        OPENCFD2606_CANARY_ATTESTATION_ID="11111111-1111-4111-8111-111111111111",
    )
    assert (
        helper.classify_rollback_boundary(attested, False)
        == "post-receipt-rollback-forbidden"
    )


def test_final_marker_keeps_current_source_and_requires_exact_r4_build_pair() -> None:
    helper = _load_helper()
    target_revision = "d" * 40
    target_tree = "e" * 64
    target_build = f"prod-20260717-{target_revision[:12]}-r4"
    pending = {
        "OPENCFD2606_CUTOVER_PENDING": "1",
        "OPENCFD2606_CUTOVER_COMPLETE": "0",
        "OPENCFD2606_CUTOVER_SOURCE_REVISION": helper.CURRENT_SOURCE_REVISION,
        "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256": helper.CURRENT_SOURCE_TREE,
        "AIRFOILFOAM_BUILD_ID": target_build,
        "ENGINE_EXPECTED_BUILD_ID": target_build,
    }

    assert helper.validate_final_marker_state(
        pending,
        expected_target_revision=target_revision,
        expected_target_tree=target_tree,
        expected_target_build_id=target_build,
    )["stateKind"] == "pending-current-r3"

    wrong_build = dict(pending, ENGINE_EXPECTED_BUILD_ID=helper.CURRENT_BUILD_ID)
    with pytest.raises(helper.ContractError, match="target r4 build"):
        helper.validate_final_marker_state(
            wrong_build,
            expected_target_revision=target_revision,
            expected_target_tree=target_tree,
            expected_target_build_id=target_build,
        )

    target_substitution = dict(
        pending,
        OPENCFD2606_CUTOVER_SOURCE_REVISION=target_revision,
        OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256=target_tree,
    )
    with pytest.raises(helper.ContractError, match="incorrectly substituted"):
        helper.validate_final_marker_state(
            target_substitution,
            expected_target_revision=target_revision,
            expected_target_tree=target_tree,
            expected_target_build_id=target_build,
        )


def test_recovery_journal_is_private_fsynced_and_immutable(tmp_path: Path) -> None:
    helper = _load_helper()
    path = tmp_path / "recovery.json"
    identity = {"target": "reviewed", "rollbackImages": {"worker": "sha256:" + "a" * 64}}

    helper.persist_recovery_journal(
        path,
        identity,
        status="prepared",
        phase="pre-delegation",
        exit_code=None,
        rollback_boundary="pre-receipt-rollback-eligible",
        runtime_snapshot_sha256="b" * 64,
    )
    helper.persist_recovery_journal(
        path,
        identity,
        status="failed",
        phase="rebuild-failed",
        exit_code=14,
        rollback_boundary="post-receipt-rollback-forbidden",
        runtime_snapshot_sha256=None,
    )

    payload = json.loads(path.read_text())
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    assert payload["identity"] == identity
    assert payload["rollbackBoundary"] == "post-receipt-rollback-forbidden"
    with pytest.raises(helper.ContractError, match="immutable identity"):
        helper.persist_recovery_journal(
            path,
            {"target": "different"},
            status="failed",
            phase="changed",
            exit_code=14,
            rollback_boundary="unknown-rollback-forbidden",
            runtime_snapshot_sha256=None,
        )


def _write_fake_docker(path: Path, payload: dict) -> None:
    path.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "if [[ \"${1:-}\" == \"compose\" && \"${2:-}\" == \"version\" ]]; then exit 0; fi\n"
        f"printf '%s\\n' '{json.dumps(payload, separators=(',', ':'))}'\n",
        encoding="utf-8",
    )
    path.chmod(0o755)


def test_migration_verifier_runs_after_node_health_and_before_pool_activation(
    tmp_path: Path,
) -> None:
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    proof = {
        "registration_table": True,
        "cleanup_table": True,
        "registration_trigger": True,
        "cleanup_trigger": True,
        "attestation_registration_column": True,
        "attestation_registration_unique": True,
        "migration_ledger": True,
        "registration_count": 0,
        "cleanup_proof_count": 0,
        "attestation_count": 0,
    }
    _write_fake_docker(fake_bin / "docker", proof)
    migration = tmp_path / "0072.sql"
    migration.write_text("SELECT 1;\n", encoding="utf-8")
    env = dict(os.environ)
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "ENV_FILE": str(tmp_path / ".env.deploy"),
            "COMPOSE_FILE": str(tmp_path / "docker-compose.deploy.yml"),
            "COMPOSE_PROJECT_DIRECTORY": str(tmp_path),
            "COMPOSE_PROJECT_NAME": "app",
            "EXPECTED_OPENCFD2606_MIGRATION_SHA256": _sha(migration),
            "OPENCFD2606_MIGRATION_FILE": str(migration),
        }
    )

    completed = subprocess.run(
        [str(MIGRATION_VERIFIER)], env=env, text=True, capture_output=True, check=False
    )

    assert completed.returncode == 0, completed.stderr
    rebuild = REBUILD.read_text(encoding="utf-8")
    main = rebuild[rebuild.index("main() {") :]
    assert main.index('wait_http "node-api"') < main.index(
        "run_post_node_health_verifier"
    ) < main.index("finish_opencfd_2606_cutover")

    proof["migration_ledger"] = False
    _write_fake_docker(fake_bin / "docker", proof)
    rejected = subprocess.run(
        [str(MIGRATION_VERIFIER)], env=env, text=True, capture_output=True, check=False
    )
    assert rejected.returncode != 0
    assert "migration 0072 database proof failed" in rejected.stderr


def test_wrapper_is_incident_bound_and_never_recreates_or_overwrites_predecessors() -> None:
    wrapper = WRAPPER_PATH.read_text(encoding="utf-8")
    rebuild = REBUILD.read_text(encoding="utf-8")

    assert 'BOUND_REVISION="63385777be7323777906fde44bdb9fa9b5cc0d6d"' in wrapper
    assert 'BOUND_COUNT="2198"' in wrapper
    assert "pending-cutover-node-api-repair.json" in wrapper
    assert "pending-cutover-queue-probe-resume.json" in wrapper
    assert "pending-opencfd2606-rebuild-replay.json" in wrapper
    assert "pending-opencfd2606-retention-retry.json" in wrapper
    assert 'CURRENT_REVISION="cd0967a1ba4ef82113d6b1eae9e38f0a7baec3a2"' in wrapper
    assert 'CURRENT_BUILD_ID="prod-20260717-cd0967a1ba4e-r3"' in wrapper
    assert "EXPECTED_SAME_BUILD_REPLAY_JOURNAL_SHA256" in wrapper
    assert "EXPECTED_TARGET_BACKUP_HOOK_SHA256" in wrapper
    assert "EXPECTED_POSTGRES_BACKUP_TOOL_SHA256" in wrapper
    assert "scripts/deploy/create-verified-canary-postgres-backup.sh" in wrapper
    hook_call = wrapper.rindex('\n    "$backup_and_copy_hook"\n')
    assert wrapper.index("flock -n 9") < wrapper.index("source_contract=")
    assert wrapper.index("flock -n 9") < wrapper.index("compose_current stop media-repair")
    assert wrapper.index("compose_current stop media-repair") < hook_call
    assert "Fresh backup hook refuses a preexisting artifact" not in wrapper
    assert wrapper.index('if [[ "$media_status" == "stopped-for-backup" ]]') < hook_call
    assert hook_call < wrapper.index('"$contract_helper" backup')
    assert "DEPLOY_LOCK_HELD=1" in wrapper
    assert 'COMPOSE_PROJECT_DIRECTORY="$staging_real"' in wrapper
    assert 'APP_DIR="$current_real"' in wrapper
    assert 'DEPLOYMENT_MANIFEST_FILE="$current_real/.deployment-source.json"' in wrapper
    assert 'DEPLOY_SOURCE_REVISION="$CURRENT_REVISION"' in wrapper
    assert 'DEPLOY_SOURCE_TREE_SHA256="$CURRENT_TREE"' in wrapper
    assert 'DEPLOY_SOURCE_REVISION="$EXPECTED_TARGET_SOURCE_REVISION"' not in wrapper
    assert '--current-root "$current_real"' in wrapper
    assert "force-recreate" not in wrapper
    assert "compose_target up" not in wrapper
    assert 'compose_target stop sweeper' in wrapper
    assert 'compose_target stop media-repair' in wrapper
    assert "pre-receipt-rollback-eligible" in wrapper
    assert 'rollback_boundary="$(printf' in wrapper
    assert 'python3 "$DEPLOY_SCRIPT_DIR/openfoam_2606_canary.py"' in rebuild
    assert '--project-directory "$COMPOSE_PROJECT_DIRECTORY"' in rebuild
    assert "control_plane_build_services=(node-api sweeper)" in rebuild
    assert "control_plane_build_services+=(media-repair)" in rebuild
    rebuild_main = rebuild[rebuild.index("main() {") :]
    assert rebuild_main.index("compose stop media-repair") < rebuild_main.index(
        "restore_media_repair_after_rebuild"
    )


def test_rollback_images_get_collision_safe_target_bound_tags_before_rebuild() -> None:
    wrapper = WRAPPER_PATH.read_text(encoding="utf-8")
    tag_call = wrapper.index('docker image tag "$image_id" "$rollback_tag"')
    rebuild_call = wrapper.index('"$rebuild_script" "$BUILD_ID"')

    assert "airfoils-pro-rollback-{service}:r3-to-r4-" in wrapper
    assert "source['targetSourceRevision'][:12]" in wrapper
    assert "source['sourceChangeSha256'][:12]" in wrapper
    assert "Rollback tag collision" in wrapper
    assert "Rollback tag verification failed" in wrapper
    assert wrapper.index('"rollbackImageTags"') < wrapper.index(
        'journal --path "$RECOVERY_JOURNAL"'
    )
    assert tag_call < rebuild_call
    assert "docker image prune" not in wrapper
