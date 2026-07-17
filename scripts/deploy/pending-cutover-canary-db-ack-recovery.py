#!/usr/bin/env python3
"""Fail-closed contracts for the 2026-07-17 canary DB-ACK recovery.

The shell launcher owns orchestration and the inherited deployment lock.  This
module keeps source, predecessor-journal, backup, runtime, rollback-boundary,
and recovery-journal validation deterministic and directly testable.
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
from typing import Any
from urllib.request import urlopen


BOUND_REVISION = "63385777be7323777906fde44bdb9fa9b5cc0d6d"
BOUND_TREE = "52c8bd3aa6d5a05dcd70a90d8896fb771f7fc36d129e698be0c935680e3fff36"
BOUND_COUNT = 2198
NODE_REPAIR_REVISION = "26b19c9a6f229d76359095958a3a6d8edac0801f"
NODE_REPAIR_TREE = "3f1631f275119fa1d316ecae8d9fe340b91b6f64f27b907780ea7ea1445632dd"
QUEUE_RUNNER_REVISION = "dfecaca2d35ac655aa647367b4a8b06744a63284"
QUEUE_RUNNER_TREE = "080fecf211c1e8e623860647bca2cc19e3daaeb8a869f958fc7b7132ca6f7a03"
QUEUE_REBUILD_SHA256 = "515e81d52d59d2e4e798daf1bdaf2ff5e51e45cc5c3708d41af20130c2364021"
NODE_REPAIR_JOURNAL_SHA256 = "1f57f0e664682c22812de55de3be2ff58e205dd11a9eb6a1bd2c1a08545e0c92"
QUEUE_REPAIR_JOURNAL_SHA256 = "4c3c1476f19ae1d6352d5130bd91e8870db41869805cabde52eaf0cfe34d1a9d"
SAME_BUILD_REPLAY_REVISION = "1f815f89c523cbf667725c1cd681d729c06a10c9"
SAME_BUILD_REPLAY_TREE = "80b7fd231d15dbf927557c8019c8c55787cac5977b79c00b144cb8007e765bae"
SAME_BUILD_REPLAY_NODE_BEFORE = "sha256:64ee90e0045a36eace3c57aeb5b3467c1e1f46c5eafb2466b98f8b754cbade32"
SAME_BUILD_REPLAY_NODE_AFTER = "sha256:89069188e2e57cad231dcf3527eaba2e5151b0886921eac4f720d589d09e66af"
SAME_BUILD_REPLAY_API_IMAGE = "sha256:bc8e23648e9e76424ea36a584f8a825d65fe82a23aa4e4ad89b019197dcc735c"
SAME_BUILD_REPLAY_WORKER_IMAGE = "sha256:42120ef817af19510830d18f99be2b0f8d8739a4b9b235d2ee294e558f64229a"
SAME_BUILD_REPLAY_DATABASE_SHA256 = "8421c15692afc6e36a834e481734411db61ecf18a95ce4db3a46ec9c7f7ad96c"
SAME_BUILD_REPLAY_ENV_SHA256 = "c4ff073a4ee698a02cdc70f535f930c93898b69e5f382bf6ac05f965b840acad"
SAME_BUILD_REPLAY_ADMIN_ROUTES_SHA256 = "e3e1782f0517ea29e451fd89661a1a54f982673cd62ad5502e5d45eaaa6a94f4"
SAME_BUILD_REPLAY_ATTESTATION_SHA256 = "928986cd328e7af647cefe7c241ed1a5ce9a6446907061055a28f28392c0944e"
CURRENT_BUILD_ID = "prod-20260717-63385777be73-r2"
POOL_ID = "3f8bc764-09ae-4ff3-8fd2-260600000001"
RESULTS_VOLUME = "app_results"
SHA_RE = re.compile(r"[0-9a-f]{64}")
REVISION_RE = re.compile(r"[0-9a-f]{40}")
CONTAINER_RE = re.compile(r"[0-9a-f]{64}")
IMAGE_RE = re.compile(r"sha256:[0-9a-f]{64}")


class ContractError(ValueError):
    pass


def fail(message: str) -> None:
    raise ContractError(message)


def sha256_bytes(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def canonical_sha256(value: Any) -> str:
    return sha256_bytes(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    )


def load_json(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        fail(f"JSON object required: {path}")
    return payload


def require_regular(path: Path, *, mode: int | None = None) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"required file is missing: {path}")
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        fail(f"required path is not a regular non-symlink file: {path}")
    if metadata.st_uid != os.getuid():
        fail(f"required file ownership mismatch: {path}")
    if mode is not None and stat.S_IMODE(metadata.st_mode) != mode:
        fail(f"required file mode must be {mode:04o}: {path}")


def parse_timestamp(value: Any, label: str) -> datetime:
    if not isinstance(value, str) or not value:
        fail(f"{label} timestamp is missing")
    candidate = value[:-1] + "+00:00" if value.endswith("Z") else value
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise ContractError(f"{label} timestamp is invalid") from exc
    if parsed.tzinfo is None:
        fail(f"{label} timestamp must include a timezone")
    return parsed.astimezone(timezone.utc)


def require_fields(payload: dict[str, Any], expected: dict[str, Any], label: str) -> None:
    for key, value in expected.items():
        if payload.get(key) != value:
            fail(f"{label} mismatch: {key}")


def load_manifest_model(tool: Path) -> Any:
    require_regular(tool)
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location("bound_deployment_source_manifest", tool)
    if spec is None or spec.loader is None:
        fail("cannot load the bound deployment source manifest model")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def source_entries(module: Any, root: Path) -> dict[str, dict[str, Any]]:
    entries: dict[str, dict[str, Any]] = {}
    for path in module._source_entries(root):
        relative = path.relative_to(root).as_posix()
        metadata = path.lstat()
        executable = bool(metadata.st_mode & 0o111)
        if stat.S_ISREG(metadata.st_mode):
            kind = "file"
            payload = path.read_bytes()
        elif stat.S_ISLNK(metadata.st_mode):
            kind = "symlink"
            payload = os.readlink(path).encode("utf-8")
        else:
            fail(f"unsupported source entry: {relative}")
        entries[relative] = {
            "path": relative,
            "kind": kind,
            "executable": executable,
            "sha256": sha256_bytes(payload),
        }
    return entries


def verify_manifest(module: Any, root: Path, manifest_path: Path) -> tuple[str, str, int]:
    root = root.resolve(strict=True)
    require_regular(manifest_path)
    manifest = module._load_manifest(manifest_path)
    tree, count = module._source_tree(root)
    if manifest.get("sourceTreeSha256") != tree or manifest.get("fileCount") != count:
        fail(f"deployment source does not match its manifest: {root}")
    return str(manifest["sourceRevision"]), tree, count


def parse_expected_hashes(values: list[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in values:
        if "=" not in item:
            fail("expected file hash must use relative/path=sha256")
        relative, digest = item.rsplit("=", 1)
        pure = PurePosixPath(relative)
        if not relative or pure.is_absolute() or ".." in pure.parts or relative in result:
            fail(f"unsafe or duplicate expected file hash path: {relative!r}")
        if SHA_RE.fullmatch(digest) is None:
            fail(f"invalid expected file SHA-256 for {relative}")
        result[relative] = digest
    if not result:
        fail("at least one independently reviewed target file hash is required")
    return result


def validate_source_contract(args: argparse.Namespace) -> dict[str, Any]:
    bound_root = args.bound_root.resolve(strict=True)
    target_root = args.target_root.resolve(strict=True)
    if bound_root == target_root:
        fail("bound and target source directories must be distinct")
    model = load_manifest_model(args.manifest_tool)
    bound = verify_manifest(model, bound_root, args.bound_manifest)
    target = verify_manifest(model, target_root, args.target_manifest)
    if bound != (BOUND_REVISION, BOUND_TREE, BOUND_COUNT):
        fail("bound production source differs from the incident tuple")
    expected_target = (
        args.expected_target_revision,
        args.expected_target_tree,
        args.expected_target_count,
    )
    if target != expected_target or target[0] == BOUND_REVISION:
        fail("target deployment source differs from the explicit reviewed tuple")

    expected_hashes = parse_expected_hashes(args.expected_file_hash)
    for relative, expected in expected_hashes.items():
        path = target_root / relative
        require_regular(path)
        if sha256_file(path) != expected:
            fail(f"target file bytes differ from reviewed hash: {relative}")

    bound_entries = source_entries(model, bound_root)
    target_entries = source_entries(model, target_root)
    changes: list[dict[str, Any]] = []
    lines: list[str] = []
    for relative in sorted(set(bound_entries) | set(target_entries)):
        if bound_entries.get(relative) == target_entries.get(relative):
            continue
        entry = target_entries.get(relative) or {
            "path": relative,
            "kind": "deleted",
            "executable": False,
            "sha256": "-",
        }
        changes.append(entry)
        lines.append(
            f"{relative}\t{entry['kind']}\t{int(entry['executable'])}\t{entry['sha256']}"
        )
    if not changes:
        fail("incident target has no source changes")
    changeset_sha = sha256_bytes(("\n".join(lines) + "\n").encode("utf-8"))
    if changeset_sha != args.expected_changeset_sha256:
        fail("target changed-path/hash contract differs from the reviewed digest")
    missing_changed = sorted(set(expected_hashes) - {entry["path"] for entry in changes})
    if missing_changed:
        fail(f"reviewed target files are not changed from the bound release: {missing_changed}")

    return {
        "schemaVersion": 1,
        "boundSourceRevision": bound[0],
        "boundSourceTreeSha256": bound[1],
        "boundSourceFileCount": bound[2],
        "targetSourceRevision": target[0],
        "targetSourceTreeSha256": target[1],
        "targetSourceFileCount": target[2],
        "sourceChangeSha256": changeset_sha,
        "sourceChangePaths": changes,
        "reviewedTargetFileHashes": expected_hashes,
    }


def validate_predecessor_journals(
    node_path: Path,
    queue_path: Path,
    same_build_path: Path,
    expected_same_build_sha256: str,
) -> dict[str, Any]:
    require_regular(node_path, mode=0o600)
    require_regular(queue_path, mode=0o600)
    require_regular(same_build_path, mode=0o600)
    if sha256_file(node_path) != NODE_REPAIR_JOURNAL_SHA256:
        fail("applied Node repair journal bytes differ from the incident record")
    if sha256_file(queue_path) != QUEUE_REPAIR_JOURNAL_SHA256:
        fail("failed queue-probe journal bytes differ from the incident record")
    if sha256_file(same_build_path) != expected_same_build_sha256:
        fail("failed same-build replay journal differs from its live preflight digest")
    node = load_json(node_path)
    queue = load_json(queue_path)
    same_build = load_json(same_build_path)
    require_fields(
        node,
        {
            "schemaVersion": 1,
            "purpose": "pending-opencfd2606-node-api-timeout-repair",
            "status": "applied",
            "boundSourceRevision": BOUND_REVISION,
            "boundSourceTreeSha256": BOUND_TREE,
            "repairSourceRevision": NODE_REPAIR_REVISION,
            "repairSourceTreeSha256": NODE_REPAIR_TREE,
        },
        "applied Node repair journal",
    )
    for key in ("nodeApiImageBefore", "nodeApiImageAfter"):
        if not isinstance(node.get(key), str) or IMAGE_RE.fullmatch(node[key]) is None:
            fail(f"applied Node repair journal has invalid {key}")
    if not isinstance(node.get("nodeApiContainerAfter"), str) or CONTAINER_RE.fullmatch(
        node["nodeApiContainerAfter"]
    ) is None:
        fail("applied Node repair journal lacks its exact post-repair container")
    applied_at = parse_timestamp(node.get("appliedAt"), "Node repair appliedAt")

    require_fields(
        queue,
        {
            "schemaVersion": 1,
            "purpose": "pending-opencfd2606-queue-probe-resume",
            "status": "failed",
            "exitCode": 14,
            "boundSourceRevision": BOUND_REVISION,
            "runnerSourceRevision": QUEUE_RUNNER_REVISION,
            "runnerSourceTreeSha256": QUEUE_RUNNER_TREE,
            "rebuildScriptSha256": QUEUE_REBUILD_SHA256,
            "buildId": CURRENT_BUILD_ID,
        },
        "failed queue-probe journal",
    )
    queue_updated = parse_timestamp(queue.get("updatedAt"), "queue repair updatedAt")
    if queue_updated < applied_at:
        fail("failed queue-probe journal predates the applied Node repair")
    require_fields(
        same_build,
        {
            "schemaVersion": 1,
            "purpose": "pending-opencfd2606-same-build-replay",
            "status": "failed",
            "completedAt": None,
            "failureCount": 1,
            "lastExitCode": 14,
            "boundSourceRevision": BOUND_REVISION,
            "boundSourceTreeSha256": BOUND_TREE,
            "replaySourceRevision": SAME_BUILD_REPLAY_REVISION,
            "replaySourceTreeSha256": SAME_BUILD_REPLAY_TREE,
            "buildId": CURRENT_BUILD_ID,
            "nodeRepairReceiptSha256": NODE_REPAIR_JOURNAL_SHA256,
            "nodeApiImageBefore": SAME_BUILD_REPLAY_NODE_BEFORE,
            "nodeApiImageAfter": SAME_BUILD_REPLAY_NODE_AFTER,
            "nodeApiAdminRoutesSha256": SAME_BUILD_REPLAY_ADMIN_ROUTES_SHA256,
            "nodeApiAttestationSha256": SAME_BUILD_REPLAY_ATTESTATION_SHA256,
            "deploymentEnvironmentBeforeSha256": SAME_BUILD_REPLAY_ENV_SHA256,
            "currentDeploymentEnvironmentSha256": SAME_BUILD_REPLAY_ENV_SHA256,
            "currentApiImage": SAME_BUILD_REPLAY_API_IMAGE,
            "currentWorkerImage": SAME_BUILD_REPLAY_WORKER_IMAGE,
            "currentDatabaseSnapshotSha256": SAME_BUILD_REPLAY_DATABASE_SHA256,
            "currentCanaryReceiptSha256": "absent",
            "currentCutoverStateKind": "pending-pristine",
        },
        "failed same-build replay journal",
    )
    same_build_failed_at = parse_timestamp(
        same_build.get("failedAt"), "same-build replay failedAt"
    )
    if same_build_failed_at < queue_updated:
        fail("failed same-build replay journal predates the queue-probe failure")
    replay_node_container = same_build.get("nodeApiContainerAfter")
    if not isinstance(replay_node_container, str) or CONTAINER_RE.fullmatch(
        replay_node_container
    ) is None:
        fail("failed same-build replay journal lacks its exact Node container")
    return {
        "schemaVersion": 1,
        "nodeRepairJournalSha256": sha256_file(node_path),
        "queueRepairJournalSha256": sha256_file(queue_path),
        "sameBuildReplayJournalSha256": sha256_file(same_build_path),
        "nodeRepairAppliedAt": applied_at.isoformat(),
        "queueRepairUpdatedAt": queue_updated.isoformat(),
        "sameBuildReplayFailedAt": same_build_failed_at.isoformat(),
        "latestPredecessorAt": same_build_failed_at.isoformat(),
        "sameBuildReplayNodeContainerAfter": replay_node_container,
        "sameBuildReplayNodeImageAfter": same_build["nodeApiImageAfter"],
        "sameBuildReplayApiImage": same_build["currentApiImage"],
        "sameBuildReplayWorkerImage": same_build["currentWorkerImage"],
    }


def validate_backup_contract(args: argparse.Namespace) -> dict[str, Any]:
    dump = args.backup
    manifest_path = args.manifest
    receipt_path = args.off_vps_receipt
    require_regular(dump, mode=0o600)
    require_regular(manifest_path, mode=0o600)
    require_regular(receipt_path, mode=0o600)
    if stat.S_IMODE(dump.parent.stat().st_mode) != 0o700:
        fail("database backup directory must be mode 0700")
    actual_dump_sha = sha256_file(dump)
    actual_manifest_sha = sha256_file(manifest_path)
    actual_receipt_sha = sha256_file(receipt_path)
    if actual_dump_sha != args.expected_backup_sha256:
        fail("database backup differs from its explicit reviewed SHA-256")
    if actual_manifest_sha != args.expected_manifest_sha256:
        fail("database backup manifest differs from its explicit reviewed SHA-256")
    if actual_receipt_sha != args.expected_receipt_sha256:
        fail("off-VPS receipt differs from its explicit reviewed SHA-256")

    manifest = load_json(manifest_path)
    require_fields(
        manifest,
        {
            "schema_version": 2,
            "type": "postgres-docker-backup",
            "scope": "database",
            "format": "custom",
            "sha256": actual_dump_sha,
            "size": dump.stat().st_size,
        },
        "database backup manifest",
    )
    publication = manifest.get("publication")
    if publication != {
        "atomic_artifact": True,
        "exclusive": True,
        "directory_mode": "0700",
        "file_mode": "0600",
    }:
        fail("database backup was not atomically/private published")
    source = manifest.get("source")
    if not isinstance(source, dict):
        fail("database backup lacks source provenance")
    container = source.get("container")
    postgres = source.get("postgres")
    if not isinstance(container, dict) or not isinstance(postgres, dict):
        fail("database backup source provenance is incomplete")
    require_fields(
        container,
        {"id": args.expected_postgres_container_id, "image_id": args.expected_postgres_image_id},
        "database backup container provenance",
    )
    require_fields(
        postgres,
        {"user": "aerodb", "database": "aerodb", "scope": "database"},
        "database backup PostgreSQL provenance",
    )
    source_catalog = postgres.get("catalog")
    if not isinstance(source_catalog, dict) or not source_catalog:
        fail("database backup source catalog signature is missing")

    verification = manifest.get("verification")
    if not isinstance(verification, dict):
        fail("database backup has no persisted verification")
    require_fields(
        verification,
        {
            "mode": "test_restore",
            "scope": "database",
            "sha256": actual_dump_sha,
            "ok": True,
            "verification_target": "scratch_database",
            "catalog_signature": source_catalog,
        },
        "database backup strong verification",
    )
    identity = verification.get("container_identity_preflight")
    if not isinstance(identity, dict):
        fail("database backup verification lacks immutable container identity")
    require_fields(
        identity,
        {
            "expected_id": args.expected_postgres_container_id,
            "actual_id": args.expected_postgres_container_id,
            "match": "exact_full",
            "execution_target": "immutable_full_id",
        },
        "database backup verification identity",
    )
    created_at = parse_timestamp(manifest.get("created_at"), "database backup createdAt")
    verified_at = parse_timestamp(verification.get("verified_at"), "database backup verifiedAt")
    not_before = parse_timestamp(args.not_before, "backup not-before")
    if created_at < not_before or verified_at < created_at:
        fail("database backup is not a fresh, subsequently verified pre-migration snapshot")

    receipt = load_json(receipt_path)
    require_fields(
        receipt,
        {
            "schemaVersion": 1,
            "purpose": "airfoils-pro-postgres-off-vps-copy",
            "backupSha256": actual_dump_sha,
            "backupSize": dump.stat().st_size,
            "backupManifestSha256": actual_manifest_sha,
            "sourceContainerId": args.expected_postgres_container_id,
        },
        "off-VPS backup receipt",
    )
    destination = receipt.get("destination")
    if not isinstance(destination, dict) or destination.get("scheme") not in {
        "gs",
        "s3",
        "ssh",
    }:
        fail("off-VPS backup receipt has no supported remote destination")
    if not isinstance(destination.get("locator"), str) or not destination["locator"]:
        fail("off-VPS backup receipt lacks its remote locator")
    if not isinstance(destination.get("immutableVersion"), str) or not destination[
        "immutableVersion"
    ]:
        fail("off-VPS backup receipt lacks an immutable remote generation/version")
    remote_verification = receipt.get("verification")
    if not isinstance(remote_verification, dict):
        fail("off-VPS backup receipt lacks remote verification")
    require_fields(
        remote_verification,
        {
            "ok": True,
            "method": "remote-download-sha256",
            "sha256": actual_dump_sha,
            "size": dump.stat().st_size,
        },
        "off-VPS backup verification",
    )
    remote_verified_at = parse_timestamp(
        remote_verification.get("verifiedAt"), "off-VPS backup verifiedAt"
    )
    if remote_verified_at < verified_at:
        fail("off-VPS copy was not verified after the local strong restore")

    return {
        "schemaVersion": 1,
        "backupPath": str(dump.resolve()),
        "backupSha256": actual_dump_sha,
        "backupSize": dump.stat().st_size,
        "backupManifestPath": str(manifest_path.resolve()),
        "backupManifestSha256": actual_manifest_sha,
        "strongVerificationAt": verified_at.isoformat(),
        "sourceCatalogSignature": source_catalog,
        "sourcePostgresContainerId": args.expected_postgres_container_id,
        "sourcePostgresImageId": args.expected_postgres_image_id,
        "offVpsReceiptPath": str(receipt_path.resolve()),
        "offVpsReceiptSha256": actual_receipt_sha,
        "offVpsDestination": destination,
        "offVpsVerifiedAt": remote_verified_at.isoformat(),
    }


def env_map(inspect: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    config = inspect.get("Config")
    values = config.get("Env") if isinstance(config, dict) else []
    for item in values or []:
        if isinstance(item, str) and "=" in item:
            key, value = item.split("=", 1)
            result[key] = value
    return result


def volume_identity(volume: dict[str, Any]) -> dict[str, Any]:
    return {
        "Name": volume.get("Name"),
        "Driver": volume.get("Driver"),
        "Mountpoint": volume.get("Mountpoint"),
        "CreatedAt": volume.get("CreatedAt"),
        "Scope": volume.get("Scope"),
        "Labels": volume.get("Labels") or {},
        "Options": volume.get("Options") or {},
    }


def validate_runtime_snapshot(
    snapshot: dict[str, Any],
    expected_services: dict[str, tuple[str, str]],
    expected_volume_sha256: str,
    expected_running: dict[str, bool] | None = None,
) -> dict[str, Any]:
    if snapshot.get("schemaVersion") != 1 or snapshot.get("composeProjectName") != "app":
        fail("runtime snapshot has an unexpected schema or Compose project")
    services = snapshot.get("services")
    if not isinstance(services, dict) or set(services) != set(expected_services):
        fail("runtime snapshot service set differs from the exact incident set")
    running_contract = {
        "api": True,
        "worker": True,
        "node-api": True,
        "sweeper": False,
        "media-repair": False,
        "postgres": True,
    }
    if expected_running:
        running_contract.update(expected_running)
    for service, (container_id, image_id) in expected_services.items():
        actual = services.get(service)
        if not isinstance(actual, dict):
            fail(f"runtime snapshot lacks service {service}")
        require_fields(
            actual,
            {
                "containerId": container_id,
                "imageId": image_id,
                "running": running_contract[service],
            },
            f"runtime service {service}",
        )
        environment = actual.get("identityEnvironment") or {}
        if service in {"api", "worker", "sweeper", "media-repair"} and environment.get(
            "AIRFOILFOAM_BUILD_ID"
        ) != CURRENT_BUILD_ID:
            fail(f"runtime service {service} does not carry the exact r2 build")
        if service == "node-api" and environment.get(
            "ENGINE_EXPECTED_BUILD_ID"
        ) != CURRENT_BUILD_ID:
            fail("runtime Node API does not carry the exact r2 engine expectation")

    for service, expected_rw in (
        ("api", True),
        ("worker", True),
        ("node-api", False),
        ("sweeper", True),
        ("media-repair", True),
    ):
        if service not in services:
            continue
        mounts = services[service].get("mounts")
        matching = [
            mount
            for mount in mounts or []
            if mount.get("name") == RESULTS_VOLUME
            and mount.get("destination") == "/data/airfoilfoam"
        ]
        if len(matching) != 1 or matching[0].get("rw") is not expected_rw:
            fail(f"runtime service {service} is not bound to the exact results volume")

    health = snapshot.get("health")
    if not isinstance(health, dict) or health.get("build_id") != CURRENT_BUILD_ID:
        fail("runtime engine health does not report the exact r2 build")
    engine = health.get("default_engine")
    if not isinstance(engine, dict) or engine.get("version") != "2606":
        fail("runtime engine health does not report OpenCFD 2606")
    queue = snapshot.get("queue")
    if not isinstance(queue, dict):
        fail("runtime queue snapshot is unavailable")
    for key in ("queue_depth", "active_count", "reserved_count", "scheduled_count"):
        if queue.get(key) != 0:
            fail(f"runtime queue is not idle: {key}")
    for key in ("worker_queues_error", "worker_runtime_error"):
        if queue.get(key) is not None:
            fail(f"runtime queue worker inspection failed: {key}")
    if queue.get("inspection_errors") != {}:
        fail("runtime queue task inspection is incomplete")
    depths = queue.get("queue_depths")
    if not isinstance(depths, dict) or not depths or any(value != 0 for value in depths.values()):
        fail("runtime registered queue depths are incomplete or nonzero")
    worker_queues = queue.get("worker_queues")
    if not isinstance(worker_queues, list) or len(worker_queues) != 1:
        fail("runtime queue does not cover the one exact worker container")

    worker_top = snapshot.get("workerTop")
    if not isinstance(worker_top, str):
        fail("runtime worker process snapshot is unavailable")
    solver_process = re.compile(
        r"\b(simpleFoam|pimpleFoam|potentialFoam|snappyHexMesh|surfaceFeatureExtract|"
        r"blockMesh|checkMesh|decomposePar|reconstructPar|renumberMesh|mapFields|"
        r"postProcess|foamToVTK|foamRun|foamJob)\b"
    )
    if solver_process.search(worker_top):
        fail("runtime worker still has an OpenFOAM process")
    if snapshot.get("poolEnabled") is not False:
        fail("OpenCFD 2606 execution pool is not fail-safe disabled")

    volume = snapshot.get("resultsVolume")
    if not isinstance(volume, dict):
        fail("runtime results volume inspection is unavailable")
    identity = volume_identity(volume)
    if identity.get("Name") != RESULTS_VOLUME:
        fail("runtime results volume name changed")
    labels = identity.get("Labels") or {}
    if labels.get("com.docker.compose.project") != "app" or labels.get(
        "com.docker.compose.volume"
    ) != "results":
        fail("runtime results volume Compose ownership changed")
    identity_sha = canonical_sha256(identity)
    if identity_sha != expected_volume_sha256:
        fail("runtime results volume identity drifted")
    normalized = dict(snapshot)
    normalized["resultsVolumeIdentitySha256"] = identity_sha
    normalized["snapshotSha256"] = canonical_sha256(snapshot)
    return normalized


def command(args: list[str], *, input_text: str | None = None) -> str:
    completed = subprocess.run(
        args,
        input=input_text,
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        fail(f"command failed ({completed.returncode}): {' '.join(args[:3])}: {detail}")
    return completed.stdout


def parse_service_specs(values: list[str]) -> dict[str, tuple[str, str]]:
    expected_names = {
        "api",
        "worker",
        "node-api",
        "sweeper",
        "media-repair",
        "postgres",
    }
    result: dict[str, tuple[str, str]] = {}
    for value in values:
        parts = value.split("=", 1)
        if len(parts) != 2 or "," not in parts[1]:
            fail("service identity must use service=container-id,image-id")
        service, identity = parts
        container_id, image_id = identity.split(",", 1)
        if service not in expected_names or service in result:
            fail(f"unexpected or duplicate service identity: {service}")
        if CONTAINER_RE.fullmatch(container_id) is None or IMAGE_RE.fullmatch(image_id) is None:
            fail(f"invalid service container/image identity: {service}")
        result[service] = (container_id, image_id)
    if set(result) != expected_names:
        fail(
            "all exact api/worker/node-api/sweeper/media-repair/postgres identities are required"
        )
    return result


def parse_expected_running(values: list[str]) -> dict[str, bool]:
    result: dict[str, bool] = {}
    for value in values:
        if "=" not in value:
            fail("expected running state must use service=true|false")
        service, raw = value.split("=", 1)
        if service in result or raw not in {"true", "false"}:
            fail(f"invalid or duplicate running-state contract: {value}")
        result[service] = raw == "true"
    return result


def capture_runtime_snapshot(args: argparse.Namespace) -> dict[str, Any]:
    expected = parse_service_specs(args.expected_service)
    expected_running = parse_expected_running(args.expected_running)
    if set(expected_running) - set(expected):
        fail("running-state contract names an unexpected service")
    compose = ["docker", "compose"]
    probe = subprocess.run(compose + ["version"], capture_output=True, text=True)
    if probe.returncode != 0:
        compose = ["docker-compose"]
    compose += [
        "--env-file",
        str(args.env_file),
        "-p",
        "app",
        "--project-directory",
        str(args.project_directory),
        "-f",
        str(args.compose_file),
    ]
    compose_ids: dict[str, str] = {}
    for service in expected:
        values = [line.strip() for line in command(compose + ["ps", "-aq", service]).splitlines() if line.strip()]
        if len(values) != 1:
            fail(f"Compose service {service} does not resolve to exactly one container")
        compose_ids[service] = values[0]
        if values[0] != expected[service][0]:
            fail(f"Compose service {service} container identity drifted")

    raw_inspect = json.loads(command(["docker", "inspect", *compose_ids.values()]))
    if not isinstance(raw_inspect, list) or len(raw_inspect) != len(expected):
        fail("Docker returned an incomplete container inspection")
    by_id = {item.get("Id"): item for item in raw_inspect if isinstance(item, dict)}
    services: dict[str, Any] = {}
    for service, (container_id, _expected_image) in expected.items():
        item = by_id.get(container_id)
        if not isinstance(item, dict):
            fail(f"Docker inspection omitted service {service}")
        mounts = []
        for mount in item.get("Mounts") or []:
            if isinstance(mount, dict):
                mounts.append(
                    {
                        "name": mount.get("Name"),
                        "destination": mount.get("Destination"),
                        "rw": mount.get("RW"),
                    }
                )
        environment = env_map(item)
        services[service] = {
            "containerId": item.get("Id"),
            "imageId": item.get("Image"),
            "running": (item.get("State") or {}).get("Running"),
            "identityEnvironment": {
                key: environment[key]
                for key in ("AIRFOILFOAM_BUILD_ID", "ENGINE_EXPECTED_BUILD_ID")
                if key in environment
            },
            "mounts": mounts,
        }

    volume_payload = json.loads(command(["docker", "volume", "inspect", RESULTS_VOLUME]))
    if not isinstance(volume_payload, list) or len(volume_payload) != 1:
        fail("Docker returned an incomplete results-volume inspection")
    with urlopen("http://127.0.0.1:8000/health", timeout=15) as response:
        health = json.load(response)
    with urlopen("http://127.0.0.1:8000/queue", timeout=15) as response:
        queue = json.load(response)
    worker_top = command(["docker", "top", expected["worker"][0], "-eo", "pid,args"])
    pool_value = command(
        compose
        + [
            "exec",
            "-T",
            "postgres",
            "sh",
            "-ec",
            "psql -X -A -t -v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" -d \"$POSTGRES_DB\" -c \"SELECT enabled::text FROM solver_execution_pools WHERE id = '$1'::uuid\"",
            "sh",
            POOL_ID,
        ]
    ).strip()
    if pool_value not in {"true", "false"}:
        fail("execution-pool database probe returned an invalid value")
    snapshot = {
        "schemaVersion": 1,
        "stage": args.stage,
        "composeProjectName": "app",
        "services": services,
        "health": health,
        "queue": queue,
        "workerTop": worker_top,
        "poolEnabled": pool_value == "true",
        "resultsVolume": volume_payload[0],
    }
    return validate_runtime_snapshot(
        snapshot, expected, args.expected_volume_sha256, expected_running
    )


def persist_media_quiesce_journal(
    path: Path,
    identity: dict[str, Any],
    *,
    status: str,
    runtime_snapshot_sha256: str,
    backup_proof_sha256: str | None = None,
) -> dict[str, Any]:
    if status not in {
        "prepared",
        "stopped-for-backup",
        "backup-verified",
        "completed",
    }:
        fail("media-quiesce journal status is invalid")
    now = datetime.now(timezone.utc).isoformat()
    if os.path.lexists(path):
        require_regular(path, mode=0o600)
        payload = load_json(path)
        if (
            payload.get("schemaVersion") != 1
            or payload.get("purpose")
            != "pending-opencfd2606-canary-db-ack-media-quiesce"
            or payload.get("identity") != identity
        ):
            fail("existing media-quiesce journal identity changed")
        current = payload.get("status")
        allowed = {
            "prepared": {"prepared", "stopped-for-backup"},
            "stopped-for-backup": {"stopped-for-backup", "backup-verified"},
            "backup-verified": {"backup-verified", "completed"},
            "completed": {"completed"},
        }
        if status not in allowed.get(str(current), set()):
            fail("media-quiesce journal lifecycle cannot move backward")
    else:
        if status != "prepared":
            fail("media-quiesce journal must begin in prepared state")
        payload = {
            "schemaVersion": 1,
            "purpose": "pending-opencfd2606-canary-db-ack-media-quiesce",
            "createdAt": now,
            "identity": identity,
        }
    payload["status"] = status
    payload["updatedAt"] = now
    payload["runtimeSnapshotSha256"] = runtime_snapshot_sha256
    if status == "stopped-for-backup":
        payload["stoppedAt"] = payload.get("stoppedAt") or now
    if status == "backup-verified":
        if not backup_proof_sha256 or SHA_RE.fullmatch(backup_proof_sha256) is None:
            fail("backup-verified media quiesce requires an exact backup proof SHA-256")
        payload["backupVerifiedAt"] = payload.get("backupVerifiedAt") or now
        payload["backupProofSha256"] = backup_proof_sha256
    if status == "completed":
        payload["completedAt"] = payload.get("completedAt") or now

    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
    return payload


def classify_rollback_boundary(state: dict[str, Any], receipt_exists: bool) -> str:
    pending = state.get("OPENCFD2606_CUTOVER_PENDING")
    complete = state.get("OPENCFD2606_CUTOVER_COMPLETE")
    expected = state.get("OPENCFD2606_CANARY_RECEIPT_EXPECTED")
    attestation = state.get("OPENCFD2606_CANARY_ATTESTATION_ID")
    if receipt_exists or expected == "1" or isinstance(attestation, str) and attestation:
        return "post-receipt-rollback-forbidden"
    if complete == "1":
        return "post-receipt-rollback-forbidden"
    if pending == "1" and complete == "0" and expected in {None, "", "0"} and attestation in {
        None,
        "",
    }:
        return "pre-receipt-rollback-eligible"
    return "unknown-rollback-forbidden"


def persist_recovery_journal(
    path: Path,
    identity: dict[str, Any],
    *,
    status: str,
    phase: str,
    exit_code: int | None,
    rollback_boundary: str,
    runtime_snapshot_sha256: str | None,
) -> dict[str, Any]:
    if status not in {"prepared", "running", "failed", "completed"}:
        fail("recovery journal status is invalid")
    if rollback_boundary not in {
        "pre-receipt-rollback-eligible",
        "post-receipt-rollback-forbidden",
        "unknown-rollback-forbidden",
    }:
        fail("recovery journal rollback boundary is invalid")
    path.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    if os.path.lexists(path):
        require_regular(path, mode=0o600)
        payload = load_json(path)
        if payload.get("schemaVersion") != 1 or payload.get("purpose") != "pending-opencfd2606-canary-db-ack-recovery":
            fail("existing recovery journal has an unexpected identity")
        if payload.get("identity") != identity:
            fail("existing recovery journal immutable identity changed")
        if payload.get("status") == "completed" and status != "completed":
            fail("completed recovery journal cannot be reopened")
        events = payload.get("events")
        if not isinstance(events, list):
            fail("existing recovery journal events are invalid")
    else:
        payload = {
            "schemaVersion": 1,
            "purpose": "pending-opencfd2606-canary-db-ack-recovery",
            "createdAt": now,
            "identity": identity,
            "events": [],
        }
        events = payload["events"]
    event = {
        "at": now,
        "status": status,
        "phase": phase,
        "exitCode": exit_code,
        "rollbackBoundary": rollback_boundary,
        "runtimeSnapshotSha256": runtime_snapshot_sha256,
    }
    events.append(event)
    payload.update(
        {
            "status": status,
            "phase": phase,
            "exitCode": exit_code,
            "rollbackBoundary": rollback_boundary,
            "runtimeSnapshotSha256": runtime_snapshot_sha256,
            "updatedAt": now,
        }
    )

    fd, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, sort_keys=True, separators=(",", ":"))
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        try:
            os.close(fd)
        except OSError:
            pass
        try:
            os.unlink(temporary_name)
        except FileNotFoundError:
            pass
        raise
    return payload


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="command", required=True)

    source = sub.add_parser("source")
    source.add_argument("--manifest-tool", type=Path, required=True)
    source.add_argument("--bound-root", type=Path, required=True)
    source.add_argument("--bound-manifest", type=Path, required=True)
    source.add_argument("--target-root", type=Path, required=True)
    source.add_argument("--target-manifest", type=Path, required=True)
    source.add_argument("--expected-target-revision", required=True)
    source.add_argument("--expected-target-tree", required=True)
    source.add_argument("--expected-target-count", type=int, required=True)
    source.add_argument("--expected-changeset-sha256", required=True)
    source.add_argument("--expected-file-hash", action="append", default=[])

    predecessor = sub.add_parser("predecessors")
    predecessor.add_argument("--node-journal", type=Path, required=True)
    predecessor.add_argument("--queue-journal", type=Path, required=True)
    predecessor.add_argument("--same-build-journal", type=Path, required=True)
    predecessor.add_argument("--expected-same-build-journal-sha256", required=True)

    backup = sub.add_parser("backup")
    backup.add_argument("--backup", type=Path, required=True)
    backup.add_argument("--manifest", type=Path, required=True)
    backup.add_argument("--off-vps-receipt", type=Path, required=True)
    backup.add_argument("--expected-backup-sha256", required=True)
    backup.add_argument("--expected-manifest-sha256", required=True)
    backup.add_argument("--expected-receipt-sha256", required=True)
    backup.add_argument("--expected-postgres-container-id", required=True)
    backup.add_argument("--expected-postgres-image-id", required=True)
    backup.add_argument("--not-before", required=True)

    runtime = sub.add_parser("runtime")
    runtime.add_argument("--snapshot", type=Path)
    runtime.add_argument("--env-file", type=Path)
    runtime.add_argument("--compose-file", type=Path)
    runtime.add_argument("--project-directory", type=Path)
    runtime.add_argument("--stage", required=True)
    runtime.add_argument("--expected-service", action="append", default=[])
    runtime.add_argument("--expected-running", action="append", default=[])
    runtime.add_argument("--expected-volume-sha256", required=True)

    boundary = sub.add_parser("boundary")
    boundary.add_argument("--state-json", type=Path, required=True)
    boundary.add_argument("--receipt-exists", choices=("true", "false"), required=True)

    media = sub.add_parser("media-quiesce")
    media.add_argument("--path", type=Path, required=True)
    media.add_argument("--identity-json", type=Path, required=True)
    media.add_argument(
        "--status",
        choices=("prepared", "stopped-for-backup", "backup-verified", "completed"),
        required=True,
    )
    media.add_argument("--runtime-snapshot-sha256", required=True)
    media.add_argument("--backup-proof-sha256")

    journal = sub.add_parser("journal")
    journal.add_argument("--path", type=Path, required=True)
    journal.add_argument("--identity-json", type=Path, required=True)
    journal.add_argument("--status", required=True)
    journal.add_argument("--phase", required=True)
    journal.add_argument("--exit-code", type=int)
    journal.add_argument("--rollback-boundary", required=True)
    journal.add_argument("--runtime-snapshot-sha256")
    return root


def main() -> int:
    args = parser().parse_args()
    if args.command == "source":
        for value, pattern, label in (
            (args.expected_target_revision, REVISION_RE, "target revision"),
            (args.expected_target_tree, SHA_RE, "target tree"),
            (args.expected_changeset_sha256, SHA_RE, "changeset"),
        ):
            if pattern.fullmatch(value) is None:
                fail(f"invalid {label}")
        result = validate_source_contract(args)
    elif args.command == "predecessors":
        if SHA_RE.fullmatch(args.expected_same_build_journal_sha256) is None:
            fail("invalid same-build replay journal SHA-256")
        result = validate_predecessor_journals(
            args.node_journal,
            args.queue_journal,
            args.same_build_journal,
            args.expected_same_build_journal_sha256,
        )
    elif args.command == "backup":
        for value, pattern, label in (
            (args.expected_backup_sha256, SHA_RE, "backup SHA-256"),
            (args.expected_manifest_sha256, SHA_RE, "backup manifest SHA-256"),
            (args.expected_receipt_sha256, SHA_RE, "off-VPS receipt SHA-256"),
            (args.expected_postgres_container_id, CONTAINER_RE, "Postgres container ID"),
            (args.expected_postgres_image_id, IMAGE_RE, "Postgres image ID"),
        ):
            if pattern.fullmatch(value) is None:
                fail(f"invalid {label}")
        result = validate_backup_contract(args)
    elif args.command == "runtime":
        expected = parse_service_specs(args.expected_service)
        expected_running = parse_expected_running(args.expected_running)
        if set(expected_running) - set(expected):
            fail("running-state contract names an unexpected service")
        if SHA_RE.fullmatch(args.expected_volume_sha256) is None:
            fail("invalid results-volume identity SHA-256")
        if args.snapshot:
            result = validate_runtime_snapshot(
                load_json(args.snapshot),
                expected,
                args.expected_volume_sha256,
                expected_running,
            )
        else:
            if not args.env_file or not args.compose_file or not args.project_directory:
                fail("live runtime capture requires env, Compose file, and project directory")
            result = capture_runtime_snapshot(args)
    elif args.command == "boundary":
        result = {
            "rollbackBoundary": classify_rollback_boundary(
                load_json(args.state_json), args.receipt_exists == "true"
            )
        }
    elif args.command == "media-quiesce":
        if SHA_RE.fullmatch(args.runtime_snapshot_sha256) is None:
            fail("invalid media-quiesce runtime snapshot SHA-256")
        result = persist_media_quiesce_journal(
            args.path,
            load_json(args.identity_json),
            status=args.status,
            runtime_snapshot_sha256=args.runtime_snapshot_sha256,
            backup_proof_sha256=args.backup_proof_sha256,
        )
    else:
        result = persist_recovery_journal(
            args.path,
            load_json(args.identity_json),
            status=args.status,
            phase=args.phase,
            exit_code=args.exit_code,
            rollback_boundary=args.rollback_boundary,
            runtime_snapshot_sha256=args.runtime_snapshot_sha256,
        )
    print(json.dumps(result, sort_keys=True, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ContractError, OSError, json.JSONDecodeError, subprocess.SubprocessError) as exc:
        print(f"pending canary DB-ACK recovery contract error: {exc}", file=sys.stderr)
        raise SystemExit(14) from exc
