#!/usr/bin/env python3
"""Create one auditable adoption proof for a known pre-engine child refusal.

The guarded watcher records ``child_spawned`` before it invokes the official
rebuild script.  That is intentionally conservative: a non-zero child result
does *not* normally prove that api/worker were left untouched.  This tool is
the narrow exception for a completed child that refused at the documented
``before service recreate`` gate.  It corroborates the immutable watcher
receipt and its log with the still-live deployment environment, engine
containers, and exact database-owned maintenance drain, then writes one
private, canonical attestation.  The successor watcher verifies that record
before it can adopt the token; deleting or hand-editing the failed receipt is
not a recovery path.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import uuid
from typing import Any


BUILD_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,160}")
REVISION_RE = re.compile(r"[0-9a-f]{40}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
SCHEMA_VERSION = 1
KIND = "production_preengine_mutation_attestation"
LEGACY_WATCHER_STATUS_SCHEMA_VERSION = 2
WATCHER_STATUS_SCHEMA_VERSION = 3
REQUIRED_LOG_MARKER = (
    "Refusing engine rebuild at before service recreate because the engine queue probe failed:"
)
FORBIDDEN_LOG_MARKERS = (
    "Updated AIRFOILFOAM_BUILD_ID and ENGINE_EXPECTED_BUILD_ID",
    "Engine serves build_id=",
    "Container app-api-1 Recreate",
    "Container app-worker-1 Recreate",
)
LEGACY_POSTSPAWN_FAILURE_STATUS_KEYS = frozenset(
    {
        "schemaVersion", "role", "buildId", "sourceRevision", "sourceTreeSha256",
        "releasePath", "releaseDevice", "releaseInode", "childScriptSha256",
        "pinnedChildPath", "sourceVerifierSha256", "pinnedSourceVerifierPath",
        "logPath", "productionAdmissionDrainRequested", "adoptProductionDrainToken",
        "state", "startedAt", "finishedAt", "childPid", "childSpawned",
        "mutationBoundary", "childExitCode", "logSha256", "productionAdmissionDrain",
    }
)
CURRENT_POSTSPAWN_FAILURE_STATUS_KEYS = frozenset(
    {
        *LEGACY_POSTSPAWN_FAILURE_STATUS_KEYS,
        "adoptProductionDrainPredecessorBuildId",
        "adoptProductionDrainRecoveryAttestation",
    }
)


class AuditError(RuntimeError):
    """The historic refusal cannot be certified safely."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _private_regular(path: Path, label: str) -> None:
    metadata = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise AuditError(f"{label} must be a regular non-symlink file")
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise AuditError(f"{label} must be private mode 0600 and owned by this auditor")


def _private_state_dir(path: Path) -> None:
    metadata = path.stat(follow_symlinks=False)
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise AuditError("state directory must be a non-symlink directory")
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o022:
        raise AuditError("state directory must be owned by this auditor and not writable by others")


def _read_json(path: Path, label: str) -> dict[str, Any]:
    _private_regular(path, label)
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AuditError(f"{label} is unreadable") from error
    if not isinstance(value, dict):
        raise AuditError(f"{label} must contain a JSON object")
    return value


def _canonical_token(value: str) -> str:
    try:
        parsed = uuid.UUID(value)
    except (TypeError, ValueError, AttributeError) as error:
        raise AuditError("maintenance token is invalid") from error
    if str(parsed) != value:
        raise AuditError("maintenance token is not canonical")
    return value


def _parse_timestamp(value: Any, label: str) -> dt.datetime:
    if not isinstance(value, str):
        raise AuditError(f"{label} is missing")
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise AuditError(f"{label} is not an ISO timestamp") from error
    if parsed.tzinfo is None:
        raise AuditError(f"{label} lacks timezone")
    return parsed.astimezone(dt.timezone.utc)


def _run(args: list[str], timeout: float, label: str) -> str:
    completed = subprocess.run(
        args,
        check=False,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout).strip()
        raise AuditError(f"{label} failed: {detail or completed.returncode}")
    return completed.stdout


def _read_env_identity(path: Path, expected_build_id: str) -> dict[str, str]:
    _private_regular(path, "deployment environment")
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key not in {"AIRFOILFOAM_BUILD_ID", "ENGINE_EXPECTED_BUILD_ID"}:
            continue
        if key in values:
            raise AuditError(f"deployment environment repeats {key}")
        values[key] = value
    if values != {
        "AIRFOILFOAM_BUILD_ID": expected_build_id,
        "ENGINE_EXPECTED_BUILD_ID": expected_build_id,
    }:
        raise AuditError("deployment engine identity does not remain on the predecessor build")
    return {
        "airfoilfoamBuildId": values["AIRFOILFOAM_BUILD_ID"],
        "engineExpectedBuildId": values["ENGINE_EXPECTED_BUILD_ID"],
    }


def _container_proof(
    name: str, expected_build_id: str, child_started_at: dt.datetime, timeout: float
) -> dict[str, str]:
    raw = _run(["docker", "inspect", "--format", "{{json .}}", name], timeout, name)
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise AuditError(f"{name} inspect output is invalid") from error
    if not isinstance(value, dict):
        raise AuditError(f"{name} inspect output is invalid")
    container_id = value.get("Id")
    state = value.get("State")
    config = value.get("Config")
    if (
        not isinstance(container_id, str)
        or not container_id
        or not isinstance(state, dict)
        or not isinstance(config, dict)
        or state.get("Running") is not True
        or not isinstance(config.get("Env"), list)
    ):
        raise AuditError(f"{name} is not a running inspectable engine container")
    started_at = _parse_timestamp(state.get("StartedAt"), f"{name} startedAt")
    if started_at >= child_started_at:
        raise AuditError(f"{name} started after the failed child began")
    env_values: dict[str, str] = {}
    for item in config["Env"]:
        if not isinstance(item, str) or "=" not in item:
            continue
        key, value = item.split("=", 1)
        env_values[key] = value
    if env_values.get("AIRFOILFOAM_BUILD_ID") != expected_build_id:
        raise AuditError(f"{name} does not retain the predecessor engine build id")
    runtime_build_id = _run(
        [
            "docker",
            "exec",
            name,
            "python3",
            "-c",
            "from airfoilfoam.config import get_settings; print(get_settings().build_id)",
        ],
        timeout,
        f"{name} runtime build probe",
    ).strip()
    if runtime_build_id != expected_build_id:
        raise AuditError(f"{name} runtime does not retain the predecessor engine build id")
    return {
        "name": name,
        "id": container_id,
        "startedAt": started_at.isoformat(),
        "runtimeBuildId": runtime_build_id,
    }


def _database_admission(token: str, timeout: float) -> dict[str, Any]:
    query = """
SELECT row_to_json(state)::text
FROM (
  SELECT enabled, admission_fence_active, maintenance_drain_token::text
  FROM sweeper_state WHERE id = 1
) state;
""".strip()
    raw = _run(
        [
            "docker", "exec", "app-postgres-1", "psql", "-U", "aerodb", "-d", "aerodb",
            "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query,
        ],
        timeout,
        "production maintenance drain probe",
    )
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as error:
        raise AuditError("production maintenance drain probe returned invalid JSON") from error
    expected = {
        "enabled": False,
        "admission_fence_active": False,
        "maintenance_drain_token": token,
    }
    if value != expected:
        raise AuditError("production maintenance drain ownership is no longer exact")
    return {
        "enabled": False,
        "admissionFenceActive": False,
        "maintenanceToken": token,
    }


def _assert_no_predecessor_child(path: Path, build_id: str, timeout: float) -> None:
    output = _run(["ps", "-eo", "pid=,args="], timeout, "guarded child process probe")
    matches = [line for line in output.splitlines() if str(path) in line and build_id in line]
    if matches:
        raise AuditError("the predecessor guarded child is still running")


def _atomic_write(path: Path, value: dict[str, Any]) -> None:
    if os.path.lexists(path):
        raise AuditError("recovery attestation already exists; it is immutable")
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(value, output, sort_keys=True, separators=(",", ":"))
            output.write("\n")
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()


def _validate_postspawn_failure_status(
    status: dict[str, Any],
    *,
    predecessor_build_id: str,
    token: str,
    log_path: Path,
) -> None:
    """Accept only the two known receipt layouts, never a permissive subset.

    The incident receipt was emitted by schema v2, before the adoption fields
    existed. New watcher receipts are v3. Keeping those schemas separate is
    what lets recovery certify the real historic failure without turning an
    arbitrary old JSON object into a valid maintenance proof.
    """
    schema_version = status.get("schemaVersion")
    expected_keys = (
        LEGACY_POSTSPAWN_FAILURE_STATUS_KEYS
        if schema_version == LEGACY_WATCHER_STATUS_SCHEMA_VERSION
        else CURRENT_POSTSPAWN_FAILURE_STATUS_KEYS
        if schema_version == WATCHER_STATUS_SCHEMA_VERSION
        else None
    )
    if expected_keys is None or set(status) != expected_keys:
        raise AuditError("predecessor watcher receipt schema is not an accepted terminal contract")
    expected_drain = {"requested": True, "state": "paused_by_watcher", "token": token}
    if (
        status.get("role") != "production"
        or status.get("buildId") != predecessor_build_id
        or not isinstance(status.get("sourceRevision"), str)
        or REVISION_RE.fullmatch(status["sourceRevision"]) is None
        or not isinstance(status.get("sourceTreeSha256"), str)
        or SHA256_RE.fullmatch(status["sourceTreeSha256"]) is None
        or status.get("state") != "failed"
        or status.get("childSpawned") is not True
        or status.get("mutationBoundary") != "child_spawned"
        or status.get("childExitCode") != 12
        or status.get("productionAdmissionDrain") != expected_drain
        or status.get("logPath") != str(log_path)
        or not isinstance(status.get("logSha256"), str)
        or SHA256_RE.fullmatch(status["logSha256"]) is None
    ):
        raise AuditError("predecessor watcher receipt is not an attestable exit-12 child failure")


def _validate_log_proof(log_text: str) -> None:
    if log_text.count(REQUIRED_LOG_MARKER) != 1:
        raise AuditError("predecessor log does not contain exactly one pre-engine refusal marker")
    if any(marker in log_text for marker in FORBIDDEN_LOG_MARKERS):
        raise AuditError("predecessor log contains an engine identity or service-recreate marker")


def audit_and_attest(
    *,
    state_dir: Path,
    predecessor_build_id: str,
    maintenance_token: str,
    expected_engine_build_id: str,
    timeout: float,
    verify_existing: bool = False,
) -> Path:
    _private_state_dir(state_dir)
    token = _canonical_token(maintenance_token)
    if BUILD_ID_RE.fullmatch(predecessor_build_id) is None:
        raise AuditError("predecessor build id is invalid")
    if BUILD_ID_RE.fullmatch(expected_engine_build_id) is None:
        raise AuditError("expected predecessor engine build id is invalid")
    status_path = state_dir / f"guarded-engine-rebuild-production-{predecessor_build_id}.json"
    log_path = state_dir / f"guarded-engine-rebuild-production-{predecessor_build_id}.log"
    status = _read_json(status_path, "predecessor guarded rebuild watcher status")
    _validate_postspawn_failure_status(
        status,
        predecessor_build_id=predecessor_build_id,
        token=token,
        log_path=log_path,
    )
    child_started_at = _parse_timestamp(status.get("startedAt"), "predecessor child startedAt")
    _private_regular(log_path, "predecessor guarded rebuild log")
    if _sha256(log_path) != status["logSha256"]:
        raise AuditError("predecessor guarded rebuild log does not match its immutable receipt")
    log_text = log_path.read_text(encoding="utf-8")
    _validate_log_proof(log_text)
    _assert_no_predecessor_child(
        Path(status["pinnedChildPath"]), predecessor_build_id, timeout
    )
    environment = _read_env_identity(state_dir / ".env.deploy", expected_engine_build_id)
    containers = {
        "api": _container_proof("app-api-1", expected_engine_build_id, child_started_at, timeout),
        "worker": _container_proof("app-worker-1", expected_engine_build_id, child_started_at, timeout),
    }
    database_admission = _database_admission(token, timeout)
    output_path = state_dir / (
        "production-preengine-mutation-attestation-"
        f"{predecessor_build_id}-{token}.json"
    )
    value = {
        "schemaVersion": SCHEMA_VERSION,
        "kind": KIND,
        "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "maintenanceToken": token,
        "predecessor": {
            "statusPath": str(status_path),
            "statusSha256": _sha256(status_path),
            "logPath": str(log_path),
            "logSha256": _sha256(log_path),
            "buildId": predecessor_build_id,
            "sourceRevision": status["sourceRevision"],
            "sourceTreeSha256": status["sourceTreeSha256"],
            "childExitCode": 12,
        },
        "expectedEngineBuildId": expected_engine_build_id,
        "databaseAdmission": database_admission,
        "deploymentEnvironment": environment,
        "containers": containers,
        "logProof": {
            "requiredMarker": REQUIRED_LOG_MARKER,
            "requiredMarkerCount": 1,
            "forbiddenMarkers": list(FORBIDDEN_LOG_MARKERS),
        },
    }
    if verify_existing:
        existing = _read_json(output_path, "production pre-engine recovery attestation")
        created_at = existing.get("createdAt")
        _parse_timestamp(created_at, "production recovery attestation createdAt")
        expected_without_created_at = dict(value)
        expected_without_created_at.pop("createdAt")
        existing_without_created_at = dict(existing)
        existing_without_created_at.pop("createdAt", None)
        if existing_without_created_at != expected_without_created_at:
            raise AuditError(
                "existing recovery attestation no longer matches current engine, environment, receipt, or log proof"
            )
    else:
        _atomic_write(output_path, value)
    return output_path


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Attest a historic production guarded child refusal before engine mutation."
    )
    parser.add_argument("--state-dir", type=Path, default=Path("/opt/airfoils-pro/state"))
    parser.add_argument("--predecessor-build-id", required=True)
    parser.add_argument("--maintenance-token", required=True)
    parser.add_argument("--expected-engine-build-id", required=True)
    parser.add_argument("--timeout-seconds", type=float, default=20.0)
    parser.add_argument(
        "--verify-existing",
        action="store_true",
        help="re-probe all evidence and require the immutable attestation to match exactly",
    )
    args = parser.parse_args(argv)
    if args.timeout_seconds < 1 or args.timeout_seconds > 60:
        parser.error("timeout seconds must be between 1 and 60")
    return args


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parse_args(argv)
        path = audit_and_attest(
            state_dir=args.state_dir.absolute(),
            predecessor_build_id=args.predecessor_build_id,
            maintenance_token=args.maintenance_token,
            expected_engine_build_id=args.expected_engine_build_id,
            timeout=args.timeout_seconds,
            verify_existing=args.verify_existing,
        )
    except (AuditError, OSError, subprocess.SubprocessError) as error:
        print(f"production pre-engine recovery attestation refused: {error}", file=sys.stderr)
        return 12
    print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
