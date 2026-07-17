from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "scripts" / "deploy"
REVISION = "a" * 40
TREE = "b" * 64
BACKUP_SHA = "c" * 64
ROLLBACK_SHA = "d" * 64
BUILD_ID = "hz-solver2-opencfd2606-test"


def _module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _compose_config() -> dict[str, object]:
    evidence = {
        "AIRFOILFOAM_EVIDENCE_BUCKET": "",
        "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX": "solver-evidence/v1",
        "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL": "10",
        "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY": "false",
    }
    services: dict[str, object] = {
        name: {} for name in ("node-api", "sweeper", "media-repair", "redis")
    }
    services.update(
        {
            "api": {
                "environment": dict(evidence),
                "volumes": [
                    {"type": "volume", "source": "results", "target": "/data"}
                ],
            },
            "worker": {
                "environment": {
                    **evidence,
                    "AIRFOILFOAM_WORKER_CPU_BUDGET": "40",
                    "AIRFOILFOAM_CASE_CONCURRENCY": "40",
                    "AIRFOILFOAM_CELERY_CONCURRENCY": "40",
                },
                "deploy": {"resources": {"limits": {"cpus": "40"}}},
                "volumes": [
                    {"type": "volume", "source": "results", "target": "/data"},
                    {
                        "type": "volume",
                        "source": "engine_runtime",
                        "target": "/runtime",
                    },
                ],
            },
            "postgres": {
                "volumes": [
                    {"type": "volume", "source": "pgdata", "target": "/pg"}
                ]
            },
        }
    )
    return {
        "services": services,
        "volumes": {"results": {}, "pgdata": {}, "engine_runtime": {}},
    }


def _remote_env(state: Path, *, remote_only: str = "false") -> str:
    return "\n".join(
        (
            "AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver",
            "COMPOSE_PROJECT_NAME=hz-solver2",
            f"COMPOSE_OVERRIDE_FILE={state / 'docker-compose.remote-solver.yml'}",
            "AIRFOILFOAM_EVIDENCE_BUCKET=",
            "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1",
            "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10",
            f"AIRFOILFOAM_EVIDENCE_REMOTE_ONLY={remote_only}",
            "AIRFOILFOAM_WORKER_CPU_BUDGET=40",
            "AIRFOILFOAM_CASE_CONCURRENCY=40",
            "AIRFOILFOAM_CELERY_CONCURRENCY=40",
        )
    ) + "\n"


def _pending_env(*, receipt_sha: str = "", attestation_sha: str = "") -> str:
    values = {
        "AIRFOILFOAM_DEPLOYMENT_ROLE": "remote-solver",
        "REMOTE_SOLVER2606_CUTOVER_PENDING": "1",
        "REMOTE_SOLVER2606_CUTOVER_COMPLETE": "0",
        "REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING": "1",
        "REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING": "1",
        "REMOTE_SOLVER2606_CUTOVER_PHASE": "runtime-installed",
        "REMOTE_SOLVER2606_TARGET_BUILD_ID": BUILD_ID,
        "REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION": REVISION,
        "REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256": TREE,
        "REMOTE_SOLVER2606_PREVIOUS_BUILD_ID": "old-2406-build",
        "REMOTE_SOLVER2606_BACKUP_MANIFEST_SHA256": BACKUP_SHA,
        "REMOTE_SOLVER2606_ROLLBACK_RECEIPT_SHA256": ROLLBACK_SHA,
        "REMOTE_SOLVER2606_CANARY_RECEIPT_SHA256": receipt_sha,
        "REMOTE_SOLVER2606_ATTESTATION_SHA256": attestation_sha,
    }
    return "".join(f"{key}={value}\n" for key, value in values.items())


def _attestation(receipt_sha: str) -> dict[str, object]:
    runtime = {
        "family": "openfoam",
        "distribution": "opencfd",
        "version": "2606",
        "source_revision": "481094fdf34f11ed6d0d603ee59a858a0124236d",
        "build_id": BUILD_ID,
    }
    return {
        "schemaVersion": 1,
        "profile": "hz-solver2-volume-v1",
        "status": "attested",
        "receiptSha256": receipt_sha,
        "sourceRevision": REVISION,
        "sourceTreeSha256": TREE,
        "backupManifestSha256": BACKUP_SHA,
        "rollbackReceiptSha256": ROLLBACK_SHA,
        "buildId": BUILD_ID,
        "runtime": runtime,
        "evidenceStorage": {
            "backend": "volume",
            "bucket": None,
            "object_prefix": "solver-evidence/v1",
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "zstd_level": 10,
            "local_disposition": "volume",
        },
        "jobIds": ["serial-rans-job", "mpi-rans-job", "urans-job"],
    }


def _volume_receipt() -> dict[str, object]:
    binding = {
        "backend": "volume",
        "stored_sha256": "1" * 64,
        "stored_byte_size": 2048,
        "archive_format": "tar+zstd",
        "compression": "zstd",
        "uncompressed_tar_sha256": "2" * 64,
        "uncompressed_tar_byte_size": 8192,
        "zstd_level": 10,
        "local_disposition": "volume",
    }
    jobs = [
        {
            "scenario": scenario,
            "job_id": job_id,
            "volume_restore_proof": {"strip_bytes_freed": 1024},
            "points": [{"artifacts": [{"storage": dict(binding)}]}],
        }
        for scenario, job_id in (
            ("serial-rans", "serial-rans-job"),
            ("mpi-2-rans", "mpi-rans-job"),
            ("forced-urans-precalc-no-shedding", "urans-job"),
        )
    ]
    return {
        "schema_version": 1,
        "status": "ok",
        "attestation_profile": "hz-solver2-volume-v1",
        "engine": {
            "family": "openfoam",
            "distribution": "opencfd",
            "version": "2606",
            "numerics_revision": "1",
            "adapter_contract_version": "1",
        },
        "engine_handshake_key": "openfoam:opencfd:2606:numerics-1:adapter-1",
        "execution_pool": "openfoam-opencfd-2606",
        "runtime": {
            "family": "openfoam",
            "distribution": "opencfd",
            "version": "2606",
            "source_revision": "481094fdf34f11ed6d0d603ee59a858a0124236d",
            "build_id": BUILD_ID,
        },
        "evidence_storage": {
            "backend": "volume",
            "bucket": None,
            "object_prefix": "solver-evidence/v1",
            "archive_format": "tar+zstd",
            "compression": "zstd",
            "zstd_level": 10,
            "local_disposition": "volume",
        },
        "jobs": jobs,
    }


def test_merged_remote_compose_requires_all_40_cpu_and_volume_contracts() -> None:
    module = _module("remote_compose_validator", "validate-remote-solver-compose.py")
    value = _compose_config()
    module.validate(value)

    bad_cpu = json.loads(json.dumps(value))
    bad_cpu["services"]["worker"]["deploy"]["resources"]["limits"]["cpus"] = "8"
    with pytest.raises(ValueError, match="expected 40"):
        module.validate(bad_cpu)

    gcs = json.loads(json.dumps(value))
    gcs["services"]["api"]["environment"]["AIRFOILFOAM_EVIDENCE_BUCKET"] = "hub-bucket"
    with pytest.raises(ValueError, match="must not receive a GCS bucket"):
        module.validate(gcs)

    detached = json.loads(json.dumps(value))
    detached["services"]["worker"]["volumes"] = []
    with pytest.raises(ValueError, match="does not mount persistent volume"):
        module.validate(detached)


def test_remote_environment_preflight_requires_external_override_and_explicit_volume_retention(
    tmp_path: Path,
) -> None:
    app = tmp_path / "app"
    state = tmp_path / "state"
    app.mkdir()
    state.mkdir()
    override = state / "docker-compose.remote-solver.yml"
    override.write_text("services: {}\n", encoding="utf-8")
    override.chmod(0o644)
    env_file = state / ".env.deploy"
    env_file.write_text(_remote_env(state), encoding="utf-8")
    env_file.chmod(0o600)
    command = [
        sys.executable,
        str(DEPLOY / "deployment-env-preflight.py"),
        "--app-dir",
        str(app),
        "--state-dir",
        str(state),
        "--env-file",
        str(env_file),
    ]

    accepted = subprocess.run(command, text=True, capture_output=True, check=False)
    assert accepted.returncode == 0, accepted.stderr

    env_file.write_text(_remote_env(state, remote_only=""), encoding="utf-8")
    rejected = subprocess.run(command, text=True, capture_output=True, check=False)
    assert rejected.returncode == 2
    assert "explicit remote-only=false" in rejected.stderr


def test_remote_cutover_state_is_source_bound_restartable_and_tamper_evident(
    tmp_path: Path,
) -> None:
    module = _module("remote_cutover_state", "remote-solver2606-cutover-state.py")
    env_file = tmp_path / ".env.deploy"
    receipt_file = tmp_path / "receipt.json"
    attestation_file = tmp_path / "attestation.json"
    env_file.write_text(_pending_env(), encoding="utf-8")
    env_file.chmod(0o600)

    assert (
        module.validate(
            env_file,
            receipt_file,
            attestation_file,
            current_source_revision=REVISION,
            current_source_tree_sha256=TREE,
        )
        == "pending-pre-canary"
    )
    with pytest.raises(ValueError, match="different source revision"):
        module.validate(
            env_file,
            receipt_file,
            attestation_file,
            current_source_revision="f" * 40,
            current_source_tree_sha256=TREE,
        )

    receipt_file.write_text(json.dumps(_volume_receipt()) + "\n", encoding="utf-8")
    receipt_file.chmod(0o600)
    receipt_sha = hashlib.sha256(receipt_file.read_bytes()).hexdigest()
    attestation_file.write_text(
        json.dumps(_attestation(receipt_sha), sort_keys=True) + "\n",
        encoding="utf-8",
    )
    attestation_file.chmod(0o600)
    attestation_sha = hashlib.sha256(attestation_file.read_bytes()).hexdigest()
    env_file.write_text(
        _pending_env(receipt_sha=receipt_sha, attestation_sha=attestation_sha),
        encoding="utf-8",
    )
    assert module.validate(env_file, receipt_file, attestation_file) == "pending-attested"

    complete = _pending_env(
        receipt_sha=receipt_sha, attestation_sha=attestation_sha
    ).replace("REMOTE_SOLVER2606_CUTOVER_PENDING=1", "REMOTE_SOLVER2606_CUTOVER_PENDING=0").replace(
        "REMOTE_SOLVER2606_CUTOVER_COMPLETE=0",
        "REMOTE_SOLVER2606_CUTOVER_COMPLETE=1",
    )
    for key in (
        "REMOTE_SOLVER2606_SWEEPER_WAS_RUNNING",
        "REMOTE_SOLVER2606_MEDIA_REPAIR_WAS_RUNNING",
        "REMOTE_SOLVER2606_CUTOVER_PHASE",
        "REMOTE_SOLVER2606_TARGET_BUILD_ID",
        "REMOTE_SOLVER2606_CUTOVER_SOURCE_REVISION",
        "REMOTE_SOLVER2606_CUTOVER_SOURCE_TREE_SHA256",
        "REMOTE_SOLVER2606_PREVIOUS_BUILD_ID",
    ):
        complete = complete.replace(
            next(line for line in complete.splitlines() if line.startswith(f"{key}=")) + "\n",
            f"{key}=\n",
        )
    env_file.write_text(complete, encoding="utf-8")
    assert module.validate(env_file, receipt_file, attestation_file) == "complete"

    changed = _attestation(receipt_sha)
    changed["backupManifestSha256"] = "e" * 64
    attestation_file.write_text(json.dumps(changed, sort_keys=True) + "\n")
    changed_sha = hashlib.sha256(attestation_file.read_bytes()).hexdigest()
    env_file.write_text(complete.replace(attestation_sha, changed_sha))
    with pytest.raises(ValueError, match="source/recovery binding differs"):
        module.validate(env_file, receipt_file, attestation_file)


def test_volume_receipt_is_no_clobber_persisted_and_recovery_bound(
    tmp_path: Path,
) -> None:
    source = tmp_path / ".volume-receipt.tmp"
    receipt = tmp_path / "volume-receipt.json"
    attestation = tmp_path / "volume-attestation.json"
    source.write_text(json.dumps(_volume_receipt()) + "\n", encoding="utf-8")
    source.chmod(0o600)

    persisted = subprocess.run(
        [
            sys.executable,
            str(DEPLOY / "persist-json-receipt.py"),
            "--profile",
            "opencfd2606-volume-canary",
            "--source",
            str(source),
            "--destination",
            str(receipt),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert persisted.returncode == 0, persisted.stderr
    assert not source.exists()
    assert stat.S_IMODE(receipt.stat().st_mode) == 0o600

    attested = subprocess.run(
        [
            sys.executable,
            str(DEPLOY / "attest-remote-solver2606-volume.py"),
            "--receipt",
            str(receipt),
            "--destination",
            str(attestation),
            "--source-revision",
            REVISION,
            "--source-tree-sha256",
            TREE,
            "--backup-manifest-sha256",
            BACKUP_SHA,
            "--rollback-receipt-sha256",
            ROLLBACK_SHA,
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert attested.returncode == 0, attested.stderr
    assert attested.stdout.strip() == hashlib.sha256(attestation.read_bytes()).hexdigest()
    assert stat.S_IMODE(attestation.stat().st_mode) == 0o600
    payload = json.loads(attestation.read_text())
    assert payload["receiptSha256"] == hashlib.sha256(receipt.read_bytes()).hexdigest()
    assert payload["sourceRevision"] == REVISION
    assert payload["backupManifestSha256"] == BACKUP_SHA

    repeated = subprocess.run(
        [
            sys.executable,
            str(DEPLOY / "attest-remote-solver2606-volume.py"),
            "--receipt",
            str(receipt),
            "--destination",
            str(attestation),
            "--source-revision",
            REVISION,
            "--source-tree-sha256",
            TREE,
            "--backup-manifest-sha256",
            BACKUP_SHA,
            "--rollback-receipt-sha256",
            ROLLBACK_SHA,
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    assert repeated.returncode == 14
    assert "already exists" in repeated.stderr


def test_remote_deployment_scripts_keep_hub_and_volume_cutovers_disjoint() -> None:
    canonical = (DEPLOY / "rebuild-engine.sh").read_text(encoding="utf-8")
    remote = (DEPLOY / "rebuild-remote-solver-engine.sh").read_text(
        encoding="utf-8"
    )
    redeploy = (DEPLOY / "vps-redeploy.sh").read_text(encoding="utf-8")

    assert "cannot run for AIRFOILFOAM_DEPLOYMENT_ROLE" in canonical
    assert "rebuild-remote-solver-engine.sh" in canonical
    assert "COMPOSE_FILE_ARGS" in canonical
    assert "openfoam_2606_volume_canary.py" in remote
    assert "openfoam_2606_canary.py" not in remote.replace(
        "openfoam_2606_volume_canary.py", ""
    )
    assert "campaign-successor" in remote
    assert "ADMIN_COOKIE" not in remote
    assert "AIRFOILFOAM_EVIDENCE_BUCKET=" not in remote
    assert "COMPOSE_FILE_ARGS" in remote and "require_recreate_safe" in remote
    assert "remote-solver2606-cutover-state.py" in redeploy
