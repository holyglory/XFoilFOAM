#!/usr/bin/env python3
"""Wait for a genuinely idle engine, then invoke one guarded rebuild.

By default this watcher is admission-free and performs only read-only database,
process, and queue probes while work is active.  The explicit production-only
admission-drain mode atomically stops new submissions before reconciling to
idle, then restores admission only after its guarded child succeeds.  Once two
separated idle snapshots agree, it invokes the role-specific guarded
maintenance script exactly once.  The child script retains the authoritative
deployment lock and repeats every maintenance gate before it mutates a
service.
"""

from __future__ import annotations

import argparse
import dataclasses
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import socket
import stat
import subprocess
import sys
import tempfile
import time
from typing import Any, Callable, Protocol
from urllib import error, request
import uuid


BUILD_ID_RE = re.compile(r"[A-Za-z0-9._-]{1,160}")
SHA256_RE = re.compile(r"[0-9a-f]{64}")
REVISION_RE = re.compile(r"[0-9a-f]{40}")
PRODUCTION_WATCHER_STATUS_RE = re.compile(
    r"guarded-engine-rebuild-production-([A-Za-z0-9._-]{1,160})\.json"
)
LEGACY_WATCHER_STATUS_SCHEMA_VERSION = 2
WATCHER_STATUS_SCHEMA_VERSION = 3
PREENGINE_RECOVERY_ATTESTATION_SCHEMA_VERSION = 1
PREENGINE_RECOVERY_ATTESTATION_KIND = "production_preengine_mutation_attestation"
DEPLOYMENT_MANIFEST_NAME = ".deployment-source.json"
SOURCE_EXCLUDED_FILE_NAMES = {
    ".env",
    ".env.deploy",
    ".env.local",
    DEPLOYMENT_MANIFEST_NAME,
}
SOURCE_EXCLUDED_DIRECTORY_NAMES = {
    ".git",
    ".github",
    ".ssh",
    ".codex",
    ".pytest_cache",
    ".venv",
    "venv",
    "__pycache__",
    "node_modules",
    ".next",
    ".next-build",
    ".pnpm-store",
    "coverage",
    "data",
    "VTK",
    "postProcessing",
    ".codex-artifacts",
    ".codex-db-backups",
    ".cold-logs",
    "test-results",
}
OPENFOAM_PROCESS_RE = (
    r"[s]impleFoam|[p]impleFoam|[p]otentialFoam|[s]nappyHexMesh|"
    r"[s]urfaceFeatureExtract|[b]lockMesh|[c]heckMesh|[d]ecomposePar|"
    r"[r]econstructPar|[r]enumberMesh|[m]apFields|[p]ostProcess|"
    r"[f]oamToVTK|[f]oamRun|[f]oamJob"
)
LIVE_JOB_QUERY = (
    "SELECT count(*) FROM sim_jobs "
    "WHERE status IN ('pending','submitted','running','ingesting');"
)
# This pre-child probe identifies terminal-ingest *candidates* only.  The
# official remote rebuild script repeats the distinction after both writers
# are stopped and all other mutation gates pass; the watcher cannot authorize
# an engine mutation by itself.
REMOTE_MAINTENANCE_QUERY = """
WITH activity AS (
  SELECT
    (SELECT count(*) FROM sim_jobs
      WHERE status IN ('pending','submitted','running')
         OR (
           status = 'ingesting'
           AND (
             engine_state IS DISTINCT FROM 'completed'
             OR engine_job_id IS NULL
             OR btrim(engine_job_id) = ''
           )
         ))::int AS live_jobs,
    (SELECT count(*) FROM sim_jobs
      WHERE status = 'ingesting'
        AND engine_state = 'completed'
        AND engine_job_id IS NOT NULL
        AND btrim(engine_job_id) <> '')::int AS terminal_completed_ingests,
    (SELECT count(*) FROM sync_remote_result_deliveries
      WHERE state NOT IN ('delivered','superseded','blocked'))::int AS unsettled_deliveries,
    (SELECT count(*) FROM sync_remote_promise_cancellations
      WHERE state <> 'delivered')::int AS unsettled_cancellations,
    (SELECT count(*) FROM result_media_repairs
      WHERE state = 'running')::int AS running_media_repairs
)
SELECT row_to_json(activity)::text FROM activity;
""".strip()
REMOTE_REDIS_QUEUES = (
    "celery",
    "openfoam-opencfd-2406",
    "openfoam-opencfd-2606",
)
QUEUE_STALE_REFRESH_REPROBE_DELAY_SECONDS = 1.0
QUEUE_STALE_REFRESH_WARMUP_SECONDS = 45.0
QUEUE_RESPONSE_HTTP_STATUS_KEY = "_guarded_watcher_http_status"
PRODUCTION_PAUSE_ADMISSION_QUERY = """
UPDATE sweeper_state
SET enabled = false,
    maintenance_drain_token = :'maintenance_token'::uuid,
    maintenance_drain_started_at = now(),
    "updatedAt" = now()
WHERE id = 1
  AND enabled = true
  AND admission_fence_active = false
  AND maintenance_drain_token IS NULL
RETURNING row_to_json(sweeper_state)::text;
""".strip()
PRODUCTION_ADMISSION_STATE_QUERY = """
SELECT row_to_json(state)::text
FROM (
  SELECT
    enabled,
    admission_fence_active,
    maintenance_drain_token::text,
    maintenance_drain_started_at
  FROM sweeper_state
  WHERE id = 1
) state;
""".strip()
PRODUCTION_RESTORE_ADMISSION_QUERY = """
UPDATE sweeper_state
SET enabled = true,
    maintenance_drain_token = NULL,
    maintenance_drain_started_at = NULL,
    "updatedAt" = now()
WHERE id = 1
  AND enabled = false
  AND admission_fence_active = false
  AND maintenance_drain_token = :'maintenance_token'::uuid
RETURNING row_to_json(sweeper_state)::text;
""".strip()
MAINTENANCE_TOKEN_BIND_MARKER = ":'maintenance_token'"


class WatcherError(RuntimeError):
    """A fail-closed watcher error."""


class ChildInvocationError(WatcherError):
    """Invocation failed with an explicit pre/post-spawn mutation boundary."""

    def __init__(self, message: str, *, child_spawned: bool) -> None:
        super().__init__(message)
        self.child_spawned = child_spawned


class CommandSystem(Protocol):
    def capture(self, args: list[str], timeout: float) -> subprocess.CompletedProcess[str]: ...

    def fetch_json(self, url: str, timeout: float) -> dict[str, Any]: ...

    def invoke(
        self,
        args: list[str],
        log_path: Path,
        on_spawn: Callable[[int], None],
    ) -> int: ...


class LiveSystem:
    def capture(
        self, args: list[str], timeout: float
    ) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            args,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )

    def fetch_json(self, url: str, timeout: float) -> dict[str, Any]:
        try:
            with request.urlopen(url, timeout=timeout) as response:
                status = response.status
                payload = json.load(response)
        except error.HTTPError as response:
            # The engine's asynchronous queue refresh intentionally returns
            # its complete stale observation as HTTP 503.  Preserve that
            # transport fact so only the exact stale-refresh classifier may
            # retry it; no 503 body can ever become a fresh idle proof.
            if response.code != 503:
                response.close()
                raise
            status = response.code
            with response:
                payload = json.load(response)
        if not isinstance(payload, dict):
            raise WatcherError("engine queue response must be a JSON object")
        payload = dict(payload)
        payload[QUEUE_RESPONSE_HTTP_STATUS_KEY] = status
        return payload

    def invoke(
        self,
        args: list[str],
        log_path: Path,
        on_spawn: Callable[[int], None],
    ) -> int:
        flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        try:
            descriptor = os.open(log_path, flags, 0o600)
        except OSError as error:
            raise ChildInvocationError(
                f"guarded child log could not be opened: {error}",
                child_spawned=False,
            ) from error
        try:
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode):
                raise ChildInvocationError(
                    "rebuild log must be a regular file", child_spawned=False
                )
            if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
                raise ChildInvocationError(
                    "rebuild log must be private and owned by the watcher",
                    child_spawned=False,
                )
            with os.fdopen(descriptor, "ab", closefd=False) as log_file:
                try:
                    child = subprocess.Popen(
                        args,
                        stdout=log_file,
                        stderr=subprocess.STDOUT,
                    )
                except OSError as error:
                    raise ChildInvocationError(
                        f"guarded child could not be spawned: {error}",
                        child_spawned=False,
                    ) from error
                try:
                    on_spawn(child.pid)
                    return child.wait()
                except BaseException as error:
                    # Popen already returned: from here onward the official
                    # child may hold the deployment lock or mutate services.
                    # Wait when possible, but never misclassify this as a safe
                    # pre-spawn refusal that may reopen admission.
                    try:
                        child.wait()
                    except BaseException:
                        pass
                    raise ChildInvocationError(
                        f"guarded child was spawned but invocation tracking failed: {error}",
                        child_spawned=True,
                    ) from error
        finally:
            os.close(descriptor)


@dataclasses.dataclass(frozen=True)
class RoleContract:
    postgres_container: str
    worker_container: str
    rebuild_script: str
    compose_project: str | None = None
    redis_container: str | None = None


ROLE_CONTRACTS = {
    "production": RoleContract(
        postgres_container="app-postgres-1",
        worker_container="app-worker-1",
        rebuild_script="rebuild-engine.sh",
        compose_project="app",
    ),
    "remote-solver": RoleContract(
        postgres_container="hz-solver2-postgres-1",
        worker_container="hz-solver2-worker-1",
        rebuild_script="rebuild-remote-solver-engine.sh",
        redis_container="hz-solver2-redis-1",
    ),
}


@dataclasses.dataclass(frozen=True)
class WatchConfig:
    role: str
    build_id: str
    app_dir: Path
    state_dir: Path
    expected_revision: str
    expected_tree_sha256: str
    poll_seconds: float = 60.0
    stable_samples: int = 2
    probe_timeout_seconds: float = 20.0
    queue_max_age_seconds: float = 90.0
    drain_production_admission: bool = False
    # A release handoff can retain an already-owned production drain while the
    # old watcher is deliberately stopped before the active-release symlink is
    # advanced.  The successor must adopt that *exact* durable token; it must
    # never manufacture, clear, or briefly reopen admission during the handoff.
    adopt_production_drain_token: str | None = None
    # An adoption is bound to the exact prior watcher action. Build ids are
    # status-path components, so this prevents a new status path from hiding a
    # terminal old child that owns the same database drain token.
    adopt_production_drain_predecessor_build_id: str | None = None
    # Post-spawn adoption is allowed only with a private recovery attestation
    # from the production auditor; child exit status is not a mutation proof.
    adopt_production_drain_recovery_attestation: Path | None = None
    deploy_lock_path: Path = Path("/tmp/airfoils-pro-deploy.lock")

    @property
    def role_contract(self) -> RoleContract:
        return ROLE_CONTRACTS[self.role]

    @property
    def status_path(self) -> Path:
        return self.state_dir / f"guarded-engine-rebuild-{self.role}-{self.build_id}.json"

    @property
    def log_path(self) -> Path:
        return self.state_dir / f"guarded-engine-rebuild-{self.role}-{self.build_id}.log"

    @property
    def lock_path(self) -> Path:
        return self.state_dir / "guarded-engine-rebuild-watcher.lock"


@dataclasses.dataclass(frozen=True)
class SourcePin:
    release_path: Path
    release_device: int
    release_inode: int
    revision: str
    tree_sha256: str
    child_path: Path
    child_device: int
    child_inode: int
    child_sha256: str
    verifier_path: Path
    verifier_device: int
    verifier_inode: int
    verifier_sha256: str


@dataclasses.dataclass(frozen=True)
class RemoteMaintenancePreflight:
    terminal_completed_ingests: int
    unsettled_deliveries: int
    unsettled_cancellations: int
    running_media_repairs: int
    redis_queue_depths: dict[str, int]

    @property
    def idle(self) -> bool:
        return (
            self.unsettled_deliveries == 0
            and self.unsettled_cancellations == 0
            and self.running_media_repairs == 0
            and all(depth == 0 for depth in self.redis_queue_depths.values())
        )

    def as_json(self) -> dict[str, Any]:
        return {
            "idle": self.idle,
            "terminalCompletedIngests": self.terminal_completed_ingests,
            "unsettledDeliveries": self.unsettled_deliveries,
            "unsettledCancellations": self.unsettled_cancellations,
            "runningMediaRepairs": self.running_media_repairs,
            "redisQueueDepths": self.redis_queue_depths,
        }


@dataclasses.dataclass(frozen=True)
class ProductionAdmissionState:
    enabled: bool
    fenced: bool
    maintenance_token: str | None
    maintenance_started_at: str | None


@dataclasses.dataclass(frozen=True)
class IdleSnapshot:
    live_jobs: int | None
    openfoam_processes: tuple[str, ...]
    queue_idle: bool
    queue_observed_at: str | None
    remote_preflight: RemoteMaintenancePreflight | None = None
    production_maintenance_preflight: dict[str, Any] | None = None
    error: str | None = None

    @property
    def idle(self) -> bool:
        return (
            self.error is None
            and self.live_jobs == 0
            and not self.openfoam_processes
            and self.queue_idle
            and (self.remote_preflight is None or self.remote_preflight.idle)
        )

    def as_json(self) -> dict[str, Any]:
        return {
            "idle": self.idle,
            "liveJobs": self.live_jobs,
            "openFoamProcessCount": len(self.openfoam_processes),
            "queueIdle": self.queue_idle,
            "queueObservedAt": self.queue_observed_at,
            "remotePreflight": (
                self.remote_preflight.as_json()
                if self.remote_preflight is not None
                else None
            ),
            "productionMaintenancePreflight": self.production_maintenance_preflight,
            "error": self.error,
        }


def _utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _read_json(path: Path, label: str) -> dict[str, Any]:
    metadata = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise WatcherError(f"{label} must be a regular non-symlink file")
    with path.open("r", encoding="utf-8") as source:
        value = json.load(source)
    if not isinstance(value, dict):
        raise WatcherError(f"{label} must contain a JSON object")
    return value


def _directory_identity(path: Path, label: str) -> tuple[int, int]:
    metadata = path.stat(follow_symlinks=False)
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise WatcherError(f"{label} must be a directory, not a symlink")
    return metadata.st_dev, metadata.st_ino


def _regular_file_identity(path: Path, label: str) -> tuple[int, int]:
    metadata = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise WatcherError(f"{label} must be a regular non-symlink file")
    return metadata.st_dev, metadata.st_ino


def _source_directory_excluded(relative: Path) -> bool:
    return any(
        part in SOURCE_EXCLUDED_DIRECTORY_NAMES or part.startswith("processor")
        for part in relative.parts
    )


def _source_excluded(relative: Path) -> bool:
    return (
        relative.name in SOURCE_EXCLUDED_FILE_NAMES
        or _source_directory_excluded(relative.parent)
    )


def _source_entries(root: Path) -> list[Path]:
    entries: list[Path] = []
    for current, directory_names, file_names in os.walk(
        root, topdown=True, followlinks=False
    ):
        current_path = Path(current)
        retained_directories: list[str] = []
        for name in sorted(directory_names):
            path = current_path / name
            relative = path.relative_to(root)
            if _source_directory_excluded(relative):
                continue
            if path.is_symlink():
                entries.append(path)
                continue
            retained_directories.append(name)
        directory_names[:] = retained_directories
        for name in sorted(file_names):
            path = current_path / name
            if not _source_excluded(path.relative_to(root)):
                entries.append(path)
    return sorted(entries, key=lambda item: item.relative_to(root).as_posix())


def _source_tree(root: Path) -> tuple[str, int]:
    """Independently reproduce the deployment manifest tree algorithm.

    This cannot invoke a release helper: proving those helpers are intact is
    the reason the watcher performs the check itself.
    """
    digest = hashlib.sha256()
    count = 0
    for path in _source_entries(root):
        relative = path.relative_to(root)
        metadata = path.lstat()
        executable = b"1" if metadata.st_mode & 0o111 else b"0"
        if stat.S_ISREG(metadata.st_mode):
            kind = b"file"
            payload = path.read_bytes()
        elif stat.S_ISLNK(metadata.st_mode):
            kind = b"symlink"
            payload = os.readlink(path).encode("utf-8")
        else:
            raise WatcherError(
                f"unsupported deployment source entry: {relative.as_posix()}"
            )
        for field in (
            kind,
            relative.as_posix().encode("utf-8"),
            executable,
            str(len(payload)).encode("ascii"),
            payload,
        ):
            digest.update(str(len(field)).encode("ascii"))
            digest.update(b":")
            digest.update(field)
        count += 1
    return digest.hexdigest(), count


def _manifest_identity(
    config: WatchConfig, release_path: Path, *, verify_tree: bool
) -> tuple[str, str]:
    manifest = _read_json(
        release_path / DEPLOYMENT_MANIFEST_NAME, "deployment source manifest"
    )
    if set(manifest) != {
        "schemaVersion",
        "sourceRevision",
        "sourceTreeSha256",
        "fileCount",
    }:
        raise WatcherError("deployment source manifest has an unexpected schema")
    revision = manifest.get("sourceRevision")
    tree_sha256 = manifest.get("sourceTreeSha256")
    file_count = manifest.get("fileCount")
    if (
        manifest.get("schemaVersion") != 1
        or not isinstance(revision, str)
        or REVISION_RE.fullmatch(revision) is None
        or not isinstance(tree_sha256, str)
        or SHA256_RE.fullmatch(tree_sha256) is None
        or type(file_count) is not int
        or file_count < 1
    ):
        raise WatcherError("deployment source manifest is invalid")
    if revision != config.expected_revision or tree_sha256 != config.expected_tree_sha256:
        raise WatcherError(
            "active deployment source changed while waiting; refusing the pinned rebuild"
        )
    if verify_tree:
        observed_tree, observed_count = _source_tree(release_path)
        if observed_tree != tree_sha256 or observed_count != file_count:
            raise WatcherError(
                "deployment release no longer matches its pinned source manifest"
            )
    return revision, tree_sha256


def verify_source_pin(config: WatchConfig) -> SourcePin:
    release_path = config.app_dir.resolve(strict=True)
    release_device, release_inode = _directory_identity(
        release_path, "active application path"
    )
    revision, tree_sha256 = _manifest_identity(
        config, release_path, verify_tree=True
    )
    child_path = release_path / "scripts" / "deploy" / config.role_contract.rebuild_script
    child_device, child_inode = _regular_file_identity(
        child_path, "guarded rebuild child"
    )
    if not os.access(child_path, os.X_OK):
        raise WatcherError("guarded rebuild child is not executable")
    child_sha256 = _sha256(child_path)
    verifier_path = release_path / "scripts" / "deploy" / "deployment-source-manifest.py"
    verifier_device, verifier_inode = _regular_file_identity(
        verifier_path, "deployment source verifier"
    )
    verifier_sha256 = _sha256(verifier_path)
    return SourcePin(
        release_path=release_path,
        release_device=release_device,
        release_inode=release_inode,
        revision=revision,
        tree_sha256=tree_sha256,
        child_path=child_path,
        child_device=child_device,
        child_inode=child_inode,
        child_sha256=child_sha256,
        verifier_path=verifier_path,
        verifier_device=verifier_device,
        verifier_inode=verifier_inode,
        verifier_sha256=verifier_sha256,
    )


def verify_pinned_source(config: WatchConfig, pin: SourcePin) -> SourcePin:
    """Recheck exactly the release selected at watcher start, never app_dir again."""
    release_identity = _directory_identity(pin.release_path, "pinned application release")
    if release_identity != (pin.release_device, pin.release_inode):
        raise WatcherError("pinned application release was replaced while waiting")
    revision, tree_sha256 = _manifest_identity(
        config, pin.release_path, verify_tree=False
    )
    if revision != pin.revision or tree_sha256 != pin.tree_sha256:
        raise WatcherError("pinned application release manifest changed while waiting")
    child_identity = _regular_file_identity(pin.child_path, "guarded rebuild child")
    if child_identity != (pin.child_device, pin.child_inode):
        raise WatcherError("guarded rebuild child was replaced while waiting")
    if not os.access(pin.child_path, os.X_OK):
        raise WatcherError("guarded rebuild child is no longer executable")
    if _sha256(pin.child_path) != pin.child_sha256:
        raise WatcherError("guarded rebuild child changed while waiting")
    verifier_identity = _regular_file_identity(
        pin.verifier_path, "deployment source verifier"
    )
    if verifier_identity != (pin.verifier_device, pin.verifier_inode):
        raise WatcherError("deployment source verifier was replaced while waiting")
    if _sha256(pin.verifier_path) != pin.verifier_sha256:
        raise WatcherError("deployment source verifier changed while waiting")
    return pin


def verify_complete_pinned_source(config: WatchConfig, pin: SourcePin) -> None:
    verify_pinned_source(config, pin)
    _manifest_identity(config, pin.release_path, verify_tree=True)


def verify_active_release(config: WatchConfig, pin: SourcePin) -> None:
    try:
        active_release = config.app_dir.resolve(strict=True)
    except OSError as error:
        raise WatcherError("active application link is unavailable") from error
    active_identity = _directory_identity(active_release, "active application release")
    if (
        active_release != pin.release_path
        or active_identity != (pin.release_device, pin.release_inode)
    ):
        raise WatcherError(
            "active application release changed; refusing maintenance from an old release"
        )


def _pinned_child_path(config: WatchConfig) -> Path:
    return config.state_dir / f"guarded-engine-rebuild-{config.role}-{config.build_id}.child"


def _pinned_verifier_path(config: WatchConfig) -> Path:
    return config.state_dir / (
        f"guarded-engine-rebuild-{config.role}-{config.build_id}.source-verifier"
    )


def _private_regular_file(path: Path, label: str) -> None:
    metadata = path.stat(follow_symlinks=False)
    if not stat.S_ISREG(metadata.st_mode) or path.is_symlink():
        raise WatcherError(f"{label} must be a regular non-symlink file")
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
        raise WatcherError(f"{label} must be private and owned by the watcher")


def _materialize_pinned_file(
    config: WatchConfig,
    *,
    source: Path,
    source_identity: tuple[int, int],
    expected_sha256: str,
    destination: Path,
    label: str,
) -> Path:
    if os.path.lexists(destination):
        _private_regular_file(destination, f"pinned {label}")
        if _sha256(destination) != expected_sha256:
            raise WatcherError(f"existing pinned {label} does not match source pin")
        return destination

    if _regular_file_identity(source, label) != source_identity:
        raise WatcherError(f"{label} was replaced before pinning")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", dir=config.state_dir
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o700)
        with source.open("rb") as source_stream, os.fdopen(
            descriptor, "wb"
        ) as output:
            while chunk := source_stream.read(1024 * 1024):
                output.write(chunk)
            output.flush()
            os.fsync(output.fileno())
        if _regular_file_identity(source, label) != source_identity:
            raise WatcherError(f"{label} changed while being pinned")
        if _sha256(temporary) != expected_sha256:
            raise WatcherError(f"pinned {label} does not match verified source")
        os.replace(temporary, destination)
        directory = os.open(config.state_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if temporary.exists():
            temporary.unlink()
    _private_regular_file(destination, f"pinned {label}")
    return destination


def materialize_pinned_child(config: WatchConfig, pin: SourcePin) -> Path:
    """Freeze the verified child so a later release switch cannot swap it."""
    return _materialize_pinned_file(
        config,
        source=pin.child_path,
        source_identity=(pin.child_device, pin.child_inode),
        expected_sha256=pin.child_sha256,
        destination=_pinned_child_path(config),
        label="guarded rebuild child",
    )


def materialize_pinned_verifier(config: WatchConfig, pin: SourcePin) -> Path:
    """Freeze the bootstrap verifier used before any release helper executes."""
    return _materialize_pinned_file(
        config,
        source=pin.verifier_path,
        source_identity=(pin.verifier_device, pin.verifier_inode),
        expected_sha256=pin.verifier_sha256,
        destination=_pinned_verifier_path(config),
        label="deployment source verifier",
    )


def pinned_invocation(
    config: WatchConfig,
    pin: SourcePin,
    child: Path,
    verifier: Path,
    maintenance_token: str | None = None,
) -> list[str]:
    """Run the frozen child against the same verified release, not a mutable app symlink."""
    deploy_dir = pin.release_path / "scripts" / "deploy"
    invocation = [
        "/usr/bin/env",
        "PINNED_WATCHER_INVOCATION=true",
        f"ACTIVE_APP_LINK={config.app_dir.absolute()}",
        f"APP_DIR={pin.release_path}",
        f"COMPOSE_FILE={pin.release_path / 'docker-compose.deploy.yml'}",
        f"DEPLOYMENT_MANIFEST_FILE={pin.release_path / DEPLOYMENT_MANIFEST_NAME}",
        f"DEPLOY_SCRIPT_DIR={deploy_dir}",
        f"DEPLOY_SOURCE_REVISION={pin.revision}",
        f"DEPLOY_SOURCE_TREE_SHA256={pin.tree_sha256}",
        f"DEPLOY_SOURCE_VERIFIER={verifier}",
        f"DEPLOY_SOURCE_VERIFIER_SHA256={pin.verifier_sha256}",
        f"LOCK_FILE={config.deploy_lock_path}",
    ]
    if config.drain_production_admission:
        if maintenance_token is None:
            raise WatcherError("production guarded child lacks its maintenance token")
        trusted_state_dir = config.state_dir.absolute()
        invocation.extend(
            (
                f"AIRFOILS_PRO_STATE_DIR={trusted_state_dir}",
                "PRODUCTION_MAINTENANCE_RECEIPT_FILE="
                f"{trusted_state_dir / 'production-legacy-gateway-reconciliation.json'}",
                "PRODUCTION_MAINTENANCE_DRAIN_TOKEN="
                f"{_validated_maintenance_token(maintenance_token)}",
            )
        )
        if config.adopt_production_drain_recovery_attestation is not None:
            predecessor_build_id = config.adopt_production_drain_predecessor_build_id
            if predecessor_build_id is None:
                raise WatcherError(
                    "production recovery attestation lacks its predecessor build id"
                )
            invocation.extend(
                (
                    "PRODUCTION_PREENGINE_RECOVERY_ATTESTATION="
                    f"{config.adopt_production_drain_recovery_attestation}",
                    "PRODUCTION_PREENGINE_RECOVERY_PREDECESSOR_BUILD_ID="
                    f"{predecessor_build_id}",
                    "PRODUCTION_PREENGINE_RECOVERY_EXPECTED_ENGINE_BUILD_ID="
                    f"{_recovery_expected_engine_build_id(config)}",
                )
            )
    invocation.extend((str(child), config.build_id))
    return invocation


def _parse_queue_observed_at(
    queue: dict[str, Any],
) -> tuple[dt.datetime | None, str | None]:
    observed_at = queue.get("queue_observed_at")
    if not isinstance(observed_at, str):
        return None, None
    try:
        observed = dt.datetime.fromisoformat(observed_at.replace("Z", "+00:00"))
    except ValueError:
        return None, observed_at
    if observed.tzinfo is None:
        return None, observed_at
    return observed, observed_at


def _has_complete_exact_zero_queue_shape(queue: dict[str, Any]) -> bool:
    count_keys = ("active_count", "reserved_count", "scheduled_count")
    counts = {key: queue.get(key) for key in count_keys}
    depth = queue.get("queue_depth")
    default_depth = queue.get("default_queue_depth")
    depths = queue.get("queue_depths")
    enabled = queue.get("queue_enabled")
    inspection_errors = queue.get("inspection_errors")
    worker_queues = queue.get("worker_queues")
    valid_worker_queues = isinstance(worker_queues, list) and bool(worker_queues)
    worker_names: list[str] = []
    if valid_worker_queues:
        for binding in worker_queues:
            if (
                not isinstance(binding, dict)
                or not isinstance(binding.get("worker"), str)
                or not binding["worker"]
                or not isinstance(binding.get("queues"), list)
                or any(
                    not isinstance(route, str) or not route
                    for route in binding["queues"]
                )
            ):
                valid_worker_queues = False
                break
            worker_names.append(binding["worker"])
        valid_worker_queues = valid_worker_queues and len(set(worker_names)) == len(
            worker_names
        )
    inspection_workers = queue.get("inspection_workers")
    valid_inspection_coverage = isinstance(inspection_workers, dict)
    if valid_inspection_coverage:
        expected_workers = set(worker_names)
        for kind in ("active", "reserved", "scheduled"):
            observed_workers = inspection_workers.get(kind)
            if (
                not isinstance(observed_workers, list)
                or any(
                    not isinstance(worker, str) or not worker
                    for worker in observed_workers
                )
                or set(observed_workers) != expected_workers
            ):
                valid_inspection_coverage = False
                break
    return (
        queue.get("queue_observation_error") is None
        and queue.get("worker_queues_error") is None
        and queue.get("worker_runtime_error") is None
        and isinstance(inspection_errors, dict)
        and not inspection_errors
        and valid_worker_queues
        and valid_inspection_coverage
        and type(depth) is int
        and depth == 0
        and type(default_depth) is int
        and default_depth == 0
        and all(type(value) is int and value == 0 for value in counts.values())
        and isinstance(depths, dict)
        and bool(depths)
        and all(type(value) is int and value == 0 for value in depths.values())
        and sum(depths.values()) == depth
        and isinstance(enabled, dict)
        and set(enabled) == set(depths)
        and all(type(value) is bool for value in enabled.values())
        and queue.get("active") == []
        and queue.get("reserved") == []
        and queue.get("scheduled") == []
        and queue.get("job_ids") == []
    )


def _is_known_stale_refreshing_exact_zero_queue(queue: dict[str, Any]) -> bool:
    """Recognize only the engine's explicit asynchronous cache-warm state.

    This is a retry classifier, never idle proof: the following response must
    still satisfy the fresh exact-zero predicate before maintenance can move
    forward.  A valid timestamp establishes that this is a complete engine
    payload rather than an arbitrarily shaped object.
    """
    observed, _observed_at = _parse_queue_observed_at(queue)
    return (
        observed is not None
        and _queue_http_status(queue) in (200, 503)
        and queue.get("queue_observation_state") == "stale"
        and queue.get("queue_refresh_in_progress") is True
        and _has_complete_exact_zero_queue_shape(queue)
    )


def _queue_http_status(queue: dict[str, Any]) -> int | None:
    """Read the transport code retained by :class:`LiveSystem`.

    Test/adapter systems which provide a queue object directly model the normal
    HTTP-200 response.  Live responses always carry this internal marker and
    therefore cannot turn a 503 JSON body into an idle proof.
    """
    value = queue.get(QUEUE_RESPONSE_HTTP_STATUS_KEY, 200)
    return value if type(value) is int else None


def _require_zero_queue(queue: dict[str, Any], max_age_seconds: float) -> tuple[bool, str | None]:
    observed, observed_at = _parse_queue_observed_at(queue)
    if observed is None:
        return False, observed_at
    age = (dt.datetime.now(dt.timezone.utc) - observed).total_seconds()
    ready = (
        _queue_http_status(queue) == 200
        and queue.get("queue_observation_state") == "fresh"
        and queue.get("queue_refresh_in_progress") is False
        and _has_complete_exact_zero_queue_shape(queue)
        and 0 <= age <= max_age_seconds
    )
    return ready, observed_at


def _fetch_queue_after_bounded_stale_refresh(
    config: WatchConfig, system: CommandSystem
) -> dict[str, Any]:
    """Fetch one queue snapshot, warming only the exact stale-refresh state.

    The queue endpoint asynchronously refreshes an expired cache.  Its
    truthful stale response cannot prove idleness, but reprobing it a fixed
    number of times prevents an otherwise idle guarded rebuild from waiting an
    entire outer poll interval.  Every other response is returned immediately
    for the normal strict, fail-closed idle check.
    """
    # Live refreshes use a 20-second endpoint budget and may need two attempts;
    # the engine's fresh-cache successor remains visible for about five more
    # seconds.  Keep that resulting 45-second budget fixed even when an
    # operator configures a larger general probe timeout, and cap every request
    # to the remaining monotonic time.
    deadline = time.monotonic() + QUEUE_STALE_REFRESH_WARMUP_SECONDS
    remaining = max(0.0, deadline - time.monotonic())
    if remaining <= 0:
        raise WatcherError("engine queue stale-refresh warmup has no time budget")
    queue = system.fetch_json(
        "http://127.0.0.1:8000/queue",
        min(config.probe_timeout_seconds, remaining),
    )
    if time.monotonic() >= deadline:
        raise WatcherError(
            "engine queue stale-refresh warmup exceeded its 45-second monotonic budget"
        )
    while _is_known_stale_refreshing_exact_zero_queue(queue):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return queue
        time.sleep(min(QUEUE_STALE_REFRESH_REPROBE_DELAY_SECONDS, remaining))
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return queue
        queue = system.fetch_json(
            "http://127.0.0.1:8000/queue",
            min(config.probe_timeout_seconds, remaining),
        )
        if time.monotonic() >= deadline:
            raise WatcherError(
                "engine queue stale-refresh warmup exceeded its 45-second monotonic budget"
            )
    return queue


def _capture_production_worker_processes(
    config: WatchConfig, system: CommandSystem
) -> tuple[str, ...]:
    project = config.role_contract.compose_project
    if project is None:
        raise WatcherError("production worker probe requires a compose project")
    containers = system.capture(
        [
            "docker",
            "ps",
            "--filter",
            f"label=com.docker.compose.project={project}",
            "--format",
            "{{.ID}}\t{{.Label \"com.docker.compose.service\"}}",
        ],
        config.probe_timeout_seconds,
    )
    if containers.returncode != 0:
        raise WatcherError(
            "production worker inventory failed: "
            f"{(containers.stderr or containers.stdout).strip()}"
        )
    workers: list[tuple[str, str]] = []
    for line in containers.stdout.splitlines():
        container_id, separator, service = line.partition("\t")
        if not separator or not container_id or not service:
            raise WatcherError("production worker inventory is malformed")
        if service == "worker" or service.startswith("worker-"):
            workers.append((container_id, service))
    if not workers:
        raise WatcherError("production worker inventory contains no running engine workers")
    found: list[str] = []
    for container_id, service in workers:
        processes = system.capture(
            ["docker", "exec", container_id, "pgrep", "-af", OPENFOAM_PROCESS_RE],
            config.probe_timeout_seconds,
        )
        if processes.returncode not in (0, 1):
            raise WatcherError(
                f"OpenFOAM process probe failed for {service}: "
                f"{(processes.stderr or processes.stdout).strip()}"
            )
        found.extend(
            f"{service}: {line}"
            for line in processes.stdout.splitlines()
            if line.strip()
        )
    return tuple(found)


def _capture_openfoam_processes(
    config: WatchConfig, system: CommandSystem
) -> tuple[str, ...]:
    if config.role == "production":
        return _capture_production_worker_processes(config, system)
    processes = system.capture(
        [
            "docker",
            "exec",
            config.role_contract.worker_container,
            "pgrep",
            "-af",
            OPENFOAM_PROCESS_RE,
        ],
        config.probe_timeout_seconds,
    )
    if processes.returncode not in (0, 1):
        raise WatcherError(
            "OpenFOAM process probe failed: "
            f"{(processes.stderr or processes.stdout).strip()}"
        )
    return tuple(line for line in processes.stdout.splitlines() if line.strip())


def _remote_maintenance_preflight(
    config: WatchConfig, system: CommandSystem
) -> tuple[int, RemoteMaintenancePreflight]:
    contract = config.role_contract
    if contract.redis_container is None:
        raise WatcherError("remote maintenance preflight requires a Redis container")
    database = system.capture(
        [
            "docker",
            "exec",
            contract.postgres_container,
            "psql",
            "-U",
            "aerodb",
            "-d",
            "aerodb",
            "-X",
            "-A",
            "-t",
            "-c",
            REMOTE_MAINTENANCE_QUERY,
        ],
        config.probe_timeout_seconds,
    )
    if database.returncode != 0:
        raise WatcherError(
            "remote maintenance database probe failed: "
            f"{(database.stderr or database.stdout).strip()}"
        )
    try:
        activity = json.loads(database.stdout)
    except json.JSONDecodeError as error:
        raise WatcherError("remote maintenance database probe returned invalid JSON") from error
    expected = {
        "live_jobs",
        "terminal_completed_ingests",
        "unsettled_deliveries",
        "unsettled_cancellations",
        "running_media_repairs",
    }
    if not isinstance(activity, dict) or set(activity) != expected:
        raise WatcherError("remote maintenance database probe returned an incomplete snapshot")
    if any(type(activity[key]) is not int or activity[key] < 0 for key in expected):
        raise WatcherError("remote maintenance database probe returned invalid counts")

    redis_queue_depths: dict[str, int] = {}
    for queue_name in REMOTE_REDIS_QUEUES:
        depth = system.capture(
            [
                "docker",
                "exec",
                contract.redis_container,
                "redis-cli",
                "--raw",
                "LLEN",
                queue_name,
            ],
            config.probe_timeout_seconds,
        )
        if depth.returncode != 0:
            raise WatcherError(
                f"remote Redis queue probe failed for {queue_name}: "
                f"{(depth.stderr or depth.stdout).strip()}"
            )
        try:
            parsed_depth = int(depth.stdout.strip())
        except ValueError as error:
            raise WatcherError(
                f"remote Redis queue depth is invalid for {queue_name}"
            ) from error
        if parsed_depth < 0:
            raise WatcherError(f"remote Redis queue depth is negative for {queue_name}")
        redis_queue_depths[queue_name] = parsed_depth
    return (
        activity["live_jobs"],
        RemoteMaintenancePreflight(
            terminal_completed_ingests=activity["terminal_completed_ingests"],
            unsettled_deliveries=activity["unsettled_deliveries"],
            unsettled_cancellations=activity["unsettled_cancellations"],
            running_media_repairs=activity["running_media_repairs"],
            redis_queue_depths=redis_queue_depths,
        ),
    )


def _production_live_jobs(config: WatchConfig, system: CommandSystem) -> int:
    database = system.capture(
        [
            "docker",
            "exec",
            config.role_contract.postgres_container,
            "psql",
            "-U",
            "aerodb",
            "-d",
            "aerodb",
            "-X",
            "-A",
            "-t",
            "-c",
            LIVE_JOB_QUERY,
        ],
        config.probe_timeout_seconds,
    )
    if database.returncode != 0:
        raise WatcherError(
            f"database idle probe failed: {(database.stderr or database.stdout).strip()}"
        )
    live_jobs = int(database.stdout.strip())
    if live_jobs < 0:
        raise WatcherError("database idle probe returned a negative live-job count")
    return live_jobs


def _production_admission_state(
    config: WatchConfig, system: CommandSystem
) -> ProductionAdmissionState:
    state = system.capture(
        [
            "docker",
            "exec",
            config.role_contract.postgres_container,
            "psql",
            "-U",
            "aerodb",
            "-d",
            "aerodb",
            "-X",
            "-A",
            "-t",
            "-c",
            PRODUCTION_ADMISSION_STATE_QUERY,
        ],
        config.probe_timeout_seconds,
    )
    if state.returncode != 0:
        raise WatcherError(
            "production scheduler state probe failed: "
            f"{(state.stderr or state.stdout).strip()}"
        )
    try:
        value = json.loads(state.stdout)
    except json.JSONDecodeError as error:
        raise WatcherError("production scheduler state probe returned invalid JSON") from error
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "enabled",
            "admission_fence_active",
            "maintenance_drain_token",
            "maintenance_drain_started_at",
        }
        or type(value["enabled"]) is not bool
        or type(value["admission_fence_active"]) is not bool
        or (
            value["maintenance_drain_token"] is not None
            and not isinstance(value["maintenance_drain_token"], str)
        )
        or (
            value["maintenance_drain_started_at"] is not None
            and not isinstance(value["maintenance_drain_started_at"], str)
        )
        or (value["maintenance_drain_token"] is None)
        != (value["maintenance_drain_started_at"] is None)
    ):
        raise WatcherError("production scheduler state probe returned an incomplete snapshot")
    return ProductionAdmissionState(
        enabled=value["enabled"],
        fenced=value["admission_fence_active"],
        maintenance_token=value["maintenance_drain_token"],
        maintenance_started_at=value["maintenance_drain_started_at"],
    )


def _validated_maintenance_token(token: str) -> str:
    try:
        parsed = uuid.UUID(token)
    except (ValueError, TypeError, AttributeError) as error:
        raise WatcherError("production maintenance drain token is invalid") from error
    if str(parsed) != token:
        raise WatcherError("production maintenance drain token is not canonical")
    return token


def _validate_adopted_production_drain(config: WatchConfig) -> str | None:
    """Validate the narrow, source-pinned production-drain handoff mode.

    The global watcher lock is acquired before this is called.  The caller
    still has to prove the durable database row is already paused by this
    exact token before it can reach an engine-maintenance child.
    """
    token = config.adopt_production_drain_token
    if token is None:
        return None
    if config.role != "production" or not config.drain_production_admission:
        raise WatcherError(
            "production drain adoption requires production role and "
            "--drain-production-admission"
        )
    return _validated_maintenance_token(token)


def _bind_maintenance_token(query: str, token: str) -> str:
    """Bind one canonical UUID into SQL passed through psql's ``-c`` path.

    psql does not perform ``:variable`` interpolation for text supplied with
    ``-c`` on every supported production version. The UUID validator makes
    literal binding safe and this exact-one-marker contract fails closed if a
    query is accidentally widened or stops owning its token predicate.
    """
    token = _validated_maintenance_token(token)
    if query.count(MAINTENANCE_TOKEN_BIND_MARKER) != 1:
        raise WatcherError(
            "production maintenance drain query must contain exactly one token marker"
        )
    return query.replace(MAINTENANCE_TOKEN_BIND_MARKER, f"'{token}'")


def pause_production_admission(
    config: WatchConfig, system: CommandSystem, token: str
) -> None:
    if config.role != "production" or not config.drain_production_admission:
        raise WatcherError("production admission drain is not enabled for this watcher")
    token = _validated_maintenance_token(token)
    query = _bind_maintenance_token(PRODUCTION_PAUSE_ADMISSION_QUERY, token)
    paused = system.capture(
        [
            "docker",
            "exec",
            config.role_contract.postgres_container,
            "psql",
            "-U",
            "aerodb",
            "-d",
            "aerodb",
            "-X",
            "-A",
            "-t",
            "-c",
            query,
        ],
        config.probe_timeout_seconds,
    )
    if paused.returncode != 0:
        raise WatcherError(
            "production admission drain update failed: "
            f"{(paused.stderr or paused.stdout).strip()}"
        )
    if not paused.stdout.strip():
        state = _production_admission_state(config, system)
        raise WatcherError(
            "production admission drain was not acquired "
            f"(enabled={state.enabled}, admission_fence_active={state.fenced}, "
            f"maintenance_token={state.maintenance_token or '-'})"
        )
    try:
        value = json.loads(paused.stdout)
    except json.JSONDecodeError as error:
        raise WatcherError("production admission drain update returned invalid JSON") from error
    if (
        not isinstance(value, dict)
        or value.get("enabled") is not False
        or value.get("admission_fence_active") is not False
        or value.get("maintenance_drain_token") != token
        or not isinstance(value.get("maintenance_drain_started_at"), str)
    ):
        raise WatcherError("production admission drain update did not persist exact ownership")


def require_owned_production_drain(
    config: WatchConfig, system: CommandSystem, token: str
) -> None:
    token = _validated_maintenance_token(token)
    state = _production_admission_state(config, system)
    if state.enabled or state.fenced or state.maintenance_token != token:
        raise WatcherError(
            "production admission drain ownership changed "
            f"(enabled={state.enabled}, admission_fence_active={state.fenced}, "
            f"maintenance_token={state.maintenance_token or '-'})"
        )


def restore_production_admission(
    config: WatchConfig, system: CommandSystem, token: str
) -> None:
    token = _validated_maintenance_token(token)
    query = _bind_maintenance_token(PRODUCTION_RESTORE_ADMISSION_QUERY, token)
    restored = system.capture(
        [
            "docker",
            "exec",
            config.role_contract.postgres_container,
            "psql",
            "-U",
            "aerodb",
            "-d",
            "aerodb",
            "-X",
            "-A",
            "-t",
            "-c",
            query,
        ],
        config.probe_timeout_seconds,
    )
    if restored.returncode != 0:
        raise WatcherError(
            "production scheduler restore failed: "
            f"{(restored.stderr or restored.stdout).strip()}"
        )
    if not restored.stdout.strip():
        state = _production_admission_state(config, system)
        raise WatcherError(
            "production scheduler restore was not acquired "
            f"(enabled={state.enabled}, admission_fence_active={state.fenced}, "
            f"maintenance_token={state.maintenance_token or '-'})"
        )
    try:
        value = json.loads(restored.stdout)
    except json.JSONDecodeError as error:
        raise WatcherError("production scheduler restore returned invalid JSON") from error
    if (
        not isinstance(value, dict)
        or value.get("enabled") is not True
        or value.get("admission_fence_active") is not False
        or value.get("maintenance_drain_token") is not None
        or value.get("maintenance_drain_started_at") is not None
    ):
        raise WatcherError("production scheduler restore did not retire exact ownership")


def _is_timeout_error(error: BaseException) -> bool:
    current: BaseException | None = error
    visited: set[int] = set()
    while current is not None and id(current) not in visited:
        visited.add(id(current))
        if isinstance(current, (TimeoutError, socket.timeout)):
            return True
        reason = getattr(current, "reason", None)
        if isinstance(reason, BaseException) and id(reason) not in visited:
            current = reason
            continue
        current = current.__cause__ or current.__context__
    return False


def _production_maintenance_snapshot(
    config: WatchConfig,
    system: CommandSystem,
    maintenance_token: str,
) -> IdleSnapshot:
    helper = (
        config.app_dir.resolve()
        / "scripts"
        / "deploy"
        / "production_maintenance_preflight.py"
    )
    completed = system.capture(
        [
            "python3",
            str(helper),
            "--project",
            config.role_contract.compose_project or "app",
            "--maintenance-token",
            _validated_maintenance_token(maintenance_token),
            "--phase",
            "observe",
            "--timeout-seconds",
            str(config.probe_timeout_seconds),
        ],
        config.probe_timeout_seconds * 8,
    )
    if completed.returncode != 0:
        raise WatcherError(
            "production maintenance preflight failed: "
            f"{(completed.stderr or completed.stdout).strip()}"
        )
    try:
        value = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise WatcherError(
            "production maintenance preflight returned invalid JSON"
        ) from error
    expected = {
        "schemaVersion",
        "observedAt",
        "phase",
        "idle",
        "runtime",
        "openFoamProcessCount",
        "queue",
        "blockingJobCount",
        "blockingJobs",
        "terminalCandidateCount",
        "terminalCandidates",
    }
    if not isinstance(value, dict) or set(value) != expected:
        raise WatcherError("production maintenance preflight is incomplete")
    queue = value["queue"]
    if not isinstance(queue, dict):
        raise WatcherError("production maintenance queue proof is incomplete")
    task_counts = queue.get("taskCounts")
    queue_depths = queue.get("queueDepths")
    transport = queue.get("transportUnackedCounts")
    if (
        not isinstance(task_counts, dict)
        or set(task_counts) != {"active", "reserved", "scheduled"}
        or any(type(count) is not int or count < 0 for count in task_counts.values())
        or not isinstance(queue_depths, dict)
        or not queue_depths
        or any(type(depth) is not int or depth < 0 for depth in queue_depths.values())
        or not isinstance(transport, dict)
        or set(transport) != {"unacked", "unacked_index"}
        or any(type(count) is not int or count < 0 for count in transport.values())
    ):
        raise WatcherError("production maintenance queue proof is invalid")
    queue_idle = (
        all(count == 0 for count in task_counts.values())
        and all(depth == 0 for depth in queue_depths.values())
        and all(count == 0 for count in transport.values())
    )
    openfoam_count = value["openFoamProcessCount"]
    blocking_jobs = value["blockingJobCount"]
    if (
        value["schemaVersion"] != 1
        or value["phase"] != "observe"
        or type(value["idle"]) is not bool
        or not isinstance(value["observedAt"], str)
        or type(openfoam_count) is not int
        or openfoam_count < 0
        or type(blocking_jobs) is not int
        or blocking_jobs < 0
        or value["idle"]
        != (openfoam_count == 0 and blocking_jobs == 0 and queue_idle)
    ):
        raise WatcherError("production maintenance preflight is inconsistent")
    public_preflight = {
        "idle": value["idle"],
        "phase": value["phase"],
        "terminalCandidateCount": value["terminalCandidateCount"],
        "blockingJobCount": blocking_jobs,
        "queue": queue,
    }
    return IdleSnapshot(
        live_jobs=blocking_jobs,
        openfoam_processes=tuple("direct-openfoam-proof" for _ in range(openfoam_count)),
        queue_idle=queue_idle,
        queue_observed_at=value["observedAt"],
        production_maintenance_preflight=public_preflight,
    )


def collect_idle_snapshot(
    config: WatchConfig,
    system: CommandSystem,
    maintenance_token: str | None = None,
) -> IdleSnapshot:
    try:
        remote_preflight: RemoteMaintenancePreflight | None = None
        if config.role == "remote-solver":
            live_jobs, remote_preflight = _remote_maintenance_preflight(config, system)
        else:
            live_jobs = _production_live_jobs(config, system)
        openfoam_processes = _capture_openfoam_processes(config, system)
        try:
            queue = _fetch_queue_after_bounded_stale_refresh(config, system)
        except (OSError, ValueError) as error:
            if (
                config.role == "production"
                and config.drain_production_admission
                and maintenance_token is not None
                and _is_timeout_error(error)
            ):
                return _production_maintenance_snapshot(
                    config, system, maintenance_token
                )
            raise WatcherError(f"engine queue probe failed: {error}") from error
        queue_idle, observed_at = _require_zero_queue(
            queue, config.queue_max_age_seconds
        )
        return IdleSnapshot(
            live_jobs=live_jobs,
            openfoam_processes=openfoam_processes,
            queue_idle=queue_idle,
            queue_observed_at=observed_at,
            remote_preflight=remote_preflight,
        )
    except (OSError, ValueError, subprocess.SubprocessError, WatcherError) as error:
        return IdleSnapshot(
            live_jobs=None,
            openfoam_processes=(),
            queue_idle=False,
            queue_observed_at=None,
            error=str(error),
        )


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump(payload, output, sort_keys=True, separators=(",", ":"))
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


def _status_base(config: WatchConfig, pin: SourcePin) -> dict[str, Any]:
    return {
        # v2 introduced durable database-backed drain ownership and an
        # explicit child-spawn mutation boundary. v3 adds the explicit
        # predecessor/attestation contract. A v1 receipt cannot prove either
        # contract and must never be resumed as though it could.
        "schemaVersion": WATCHER_STATUS_SCHEMA_VERSION,
        "role": config.role,
        "buildId": config.build_id,
        "sourceRevision": pin.revision,
        "sourceTreeSha256": pin.tree_sha256,
        "releasePath": str(pin.release_path),
        "releaseDevice": pin.release_device,
        "releaseInode": pin.release_inode,
        "childScriptSha256": pin.child_sha256,
        "pinnedChildPath": str(_pinned_child_path(config)),
        "sourceVerifierSha256": pin.verifier_sha256,
        "pinnedSourceVerifierPath": str(_pinned_verifier_path(config)),
        "logPath": str(config.log_path),
        "productionAdmissionDrainRequested": config.drain_production_admission,
        "adoptProductionDrainToken": config.adopt_production_drain_token,
        "adoptProductionDrainPredecessorBuildId": (
            config.adopt_production_drain_predecessor_build_id
        ),
        "adoptProductionDrainRecoveryAttestation": (
            str(config.adopt_production_drain_recovery_attestation)
            if config.adopt_production_drain_recovery_attestation is not None
            else None
        ),
    }


def _load_existing_status(config: WatchConfig, pin: SourcePin) -> dict[str, Any] | None:
    if not config.status_path.exists():
        return None
    status_value = _read_json(config.status_path, "guarded rebuild watcher status")
    expected = _status_base(config, pin)
    for key in (
        "schemaVersion",
        "role",
        "buildId",
        "sourceRevision",
        "sourceTreeSha256",
        "releasePath",
        "releaseDevice",
        "releaseInode",
        "childScriptSha256",
        "pinnedChildPath",
        "sourceVerifierSha256",
        "pinnedSourceVerifierPath",
        "productionAdmissionDrainRequested",
        "adoptProductionDrainToken",
        "adoptProductionDrainPredecessorBuildId",
        "adoptProductionDrainRecoveryAttestation",
    ):
        if status_value.get(key) != expected[key]:
            raise WatcherError("existing watcher status belongs to a different pinned action")
    if status_value.get("state") in {
        "completed",
        "failed",
        "refused",
        "recovered_prechild_crash",
        "recovery_blocked_ambiguous_child",
    }:
        raise WatcherError(
            f"pinned rebuild watcher is already terminal: {status_value.get('state')}"
        )
    return status_value


@dataclasses.dataclass(frozen=True)
class ProductionDrainPredecessor:
    path: Path
    status: dict[str, Any]
    status_sha256: str


LEGACY_WATCHER_STATIC_STATUS_KEYS = frozenset(
    {
        "schemaVersion",
        "role",
        "buildId",
        "sourceRevision",
        "sourceTreeSha256",
        "releasePath",
        "releaseDevice",
        "releaseInode",
        "childScriptSha256",
        "pinnedChildPath",
        "sourceVerifierSha256",
        "pinnedSourceVerifierPath",
        "logPath",
        "productionAdmissionDrainRequested",
        "adoptProductionDrainToken",
    }
)
LEGACY_PRECHILD_WAITING_STATUS_KEYS = frozenset(
    {
        *LEGACY_WATCHER_STATIC_STATUS_KEYS,
        "state",
        "updatedAt",
        "stableSamples",
        "requiredStableSamples",
        "lastSnapshot",
        "productionAdmissionDrain",
    }
)
# This is the captured production v2 receipt from before
# ``adoptProductionDrainToken`` was introduced. It is a separate contract: do
# not derive it from the current legacy key set, or a later field addition could
# silently widen what this recovery accepts.
CAPTURED_LEGACY_V2_WAITING_STATUS_KEYS = frozenset(
    {
        "buildId",
        "childScriptSha256",
        "lastSnapshot",
        "logPath",
        "pinnedChildPath",
        "pinnedSourceVerifierPath",
        "productionAdmissionDrain",
        "productionAdmissionDrainRequested",
        "releaseDevice",
        "releaseInode",
        "releasePath",
        "requiredStableSamples",
        "role",
        "schemaVersion",
        "sourceRevision",
        "sourceTreeSha256",
        "sourceVerifierSha256",
        "stableSamples",
        "state",
        "updatedAt",
    }
)
CHAIN_DRAIN_STATES = frozenset({"paused_by_watcher", "adopted_pause_preserved"})


def _watcher_static_status_keys(schema_version: object) -> frozenset[str] | None:
    if schema_version == LEGACY_WATCHER_STATUS_SCHEMA_VERSION:
        return LEGACY_WATCHER_STATIC_STATUS_KEYS
    if schema_version == WATCHER_STATUS_SCHEMA_VERSION:
        return frozenset(
            {
                *LEGACY_WATCHER_STATIC_STATUS_KEYS,
                "adoptProductionDrainPredecessorBuildId",
                "adoptProductionDrainRecoveryAttestation",
            }
        )
    return None


def _drain_declares_token(value: object, token: str) -> bool:
    """Find an exact token even when a corrupt drain receipt nests it oddly."""
    pending: list[object] = [value]
    while pending:
        current = pending.pop()
        if current == token:
            return True
        if isinstance(current, dict):
            pending.extend(current.values())
        elif isinstance(current, list):
            pending.extend(current)
    return False


def _validate_token_chain_drain(value: object, token: str) -> None:
    """Accept only the explicit receipt shapes that may retain an adopted drain."""
    if not isinstance(value, dict) or value.get("token") != token:
        raise WatcherError(
            "production drain predecessor receipt has a malformed exact-token drain"
        )
    state = value.get("state")
    if state not in CHAIN_DRAIN_STATES or value != {
        "requested": True,
        "state": state,
        "token": token,
    }:
        raise WatcherError(
            "production drain predecessor receipt has a noncanonical exact-token drain"
        )


def _production_drain_status(token: str) -> dict[str, Any]:
    return {
        "requested": True,
        "state": "paused_by_watcher",
        "token": token,
    }


def _is_known_prechild_chain_receipt(status: dict[str, Any]) -> bool:
    """Recognize only known safe predecessor receipt shapes.

    The live incident has an older schema-v2 ``waiting`` receipt from before
    the child fields existed. It is not an unknown/malformed omission: its
    full static+waiting layout is explicit below. Newer records, or v2 records
    that did record the child boundary, must say ``pre_child`` unambiguously.
    """
    if (
        status.get("schemaVersion") == LEGACY_WATCHER_STATUS_SCHEMA_VERSION
        and set(status) == CAPTURED_LEGACY_V2_WAITING_STATUS_KEYS
        and status.get("role") == "production"
        and status.get("productionAdmissionDrainRequested") is True
        and status.get("state") == "waiting"
    ):
        return True
    static_keys = _watcher_static_status_keys(status.get("schemaVersion"))
    if static_keys is None:
        return False
    if (
        status.get("role") != "production"
        or status.get("productionAdmissionDrainRequested") is not True
    ):
        return False
    if static_keys == LEGACY_WATCHER_STATIC_STATUS_KEYS:
        if (
            set(status) == LEGACY_PRECHILD_WAITING_STATUS_KEYS
            and status.get("state") == "waiting"
        ):
            return True
    waiting_keys = static_keys | {
        "state",
        "updatedAt",
        "stableSamples",
        "requiredStableSamples",
        "lastSnapshot",
        "productionAdmissionDrain",
    }
    if set(status) == waiting_keys and status.get("state") == "waiting":
        return True
    prechild_shapes = {
        "admission_drain_paused": {
            "state",
            "updatedAt",
            "childSpawned",
            "mutationBoundary",
            "productionAdmissionDrain",
        },
        "invocation_prepared": {
            "state",
            "preparedAt",
            "childSpawned",
            "mutationBoundary",
            "productionAdmissionDrain",
        },
        "refused": {
            "state",
            "finishedAt",
            "error",
            "childSpawned",
            "mutationBoundary",
            "productionAdmissionDrain",
        },
    }
    extra_keys = prechild_shapes.get(status.get("state"))
    return (
        extra_keys is not None
        and set(status) == static_keys | extra_keys
        and status.get("childSpawned") is False
        and status.get("mutationBoundary") == "pre_child"
    )


def _find_exact_production_drain_predecessor(
    config: WatchConfig, token: str
) -> ProductionDrainPredecessor:
    """Find the explicit predecessor while auditing the entire token chain.

    Status filenames include a build id. Searching only the successor's new
    filename would let a terminal predecessor disappear from the admission
    decision. Sequential pre-child handoffs legitimately leave older receipts
    with the same token, so the explicit predecessor build id selects the
    action being adopted. Every *other* matching receipt must be pre-child;
    a second post-spawn receipt is ambiguity, not a recovery chain.
    """
    token = _validated_maintenance_token(token)
    requested_build_id = config.adopt_production_drain_predecessor_build_id
    if requested_build_id is None:
        raise WatcherError("adopted production drain requires an explicit predecessor build id")
    matches: list[ProductionDrainPredecessor] = []
    for path in sorted(config.state_dir.iterdir(), key=lambda item: item.name):
        if PRODUCTION_WATCHER_STATUS_RE.fullmatch(path.name) is None:
            continue
        _private_regular_file(path, "production guarded rebuild watcher status")
        status = _read_json(path, "production guarded rebuild watcher status")
        drain = status.get("productionAdmissionDrain")
        if not _drain_declares_token(drain, token):
            continue
        _validate_token_chain_drain(drain, token)
        build_id_match = PRODUCTION_WATCHER_STATUS_RE.fullmatch(path.name)
        assert build_id_match is not None
        if (
            status.get("schemaVersion")
            not in {LEGACY_WATCHER_STATUS_SCHEMA_VERSION, WATCHER_STATUS_SCHEMA_VERSION}
            or status.get("role") != "production"
            or status.get("buildId") != build_id_match.group(1)
        ):
            raise WatcherError(
                "production drain predecessor receipt has inconsistent identity"
            )
        matches.append(
            ProductionDrainPredecessor(
                path=path,
                status=status,
                status_sha256=_sha256(path),
            )
        )
    selected = [
        candidate
        for candidate in matches
        if candidate.status.get("buildId") == requested_build_id
    ]
    if len(selected) != 1:
        raise WatcherError(
            "adopted production drain must select exactly one matching predecessor receipt "
            f"for build {requested_build_id} (found={len(selected)})"
        )
    for candidate in matches:
        if candidate is selected[0]:
            continue
        if not _is_known_prechild_chain_receipt(candidate.status):
            raise WatcherError(
                "adopted production drain token has another post-spawn predecessor receipt"
            )
    return selected[0]


def _expected_preengine_recovery_attestation_path(
    config: WatchConfig, predecessor_build_id: str, token: str
) -> Path:
    return config.state_dir / (
        "production-preengine-mutation-attestation-"
        f"{predecessor_build_id}-{token}.json"
    )


def _validate_preengine_recovery_attestation(
    config: WatchConfig,
    predecessor: ProductionDrainPredecessor,
    token: str,
) -> None:
    attestation_path = config.adopt_production_drain_recovery_attestation
    if attestation_path is None:
        raise WatcherError(
            "post-spawn production drain predecessor requires a recovery attestation"
        )
    expected_path = _expected_preengine_recovery_attestation_path(
        config, predecessor.status["buildId"], token
    )
    if attestation_path != expected_path:
        raise WatcherError(
            "production recovery attestation path is not the canonical predecessor path"
        )
    _private_regular_file(attestation_path, "production pre-engine recovery attestation")
    value = _read_json(attestation_path, "production pre-engine recovery attestation")
    expected_keys = {
        "schemaVersion",
        "kind",
        "createdAt",
        "maintenanceToken",
        "predecessor",
        "expectedEngineBuildId",
        "databaseAdmission",
        "deploymentEnvironment",
        "containers",
        "logProof",
    }
    if not isinstance(value, dict) or set(value) != expected_keys:
        raise WatcherError("production recovery attestation schema is invalid")
    if (
        value["schemaVersion"] != PREENGINE_RECOVERY_ATTESTATION_SCHEMA_VERSION
        or value["kind"] != PREENGINE_RECOVERY_ATTESTATION_KIND
        or value["maintenanceToken"] != token
        or not isinstance(value["createdAt"], str)
        or not isinstance(value["expectedEngineBuildId"], str)
        or BUILD_ID_RE.fullmatch(value["expectedEngineBuildId"]) is None
    ):
        raise WatcherError("production recovery attestation identity is invalid")
    prior = value["predecessor"]
    expected_prior_keys = {
        "statusPath",
        "statusSha256",
        "logPath",
        "logSha256",
        "buildId",
        "sourceRevision",
        "sourceTreeSha256",
        "childExitCode",
    }
    if (
        not isinstance(prior, dict)
        or set(prior) != expected_prior_keys
        or prior.get("statusPath") != str(predecessor.path)
        or prior.get("statusSha256") != predecessor.status_sha256
        or prior.get("buildId") != predecessor.status.get("buildId")
        or prior.get("sourceRevision") != predecessor.status.get("sourceRevision")
        or prior.get("sourceTreeSha256") != predecessor.status.get("sourceTreeSha256")
        or prior.get("childExitCode") != 12
        or not isinstance(prior.get("logPath"), str)
        or not isinstance(prior.get("logSha256"), str)
        or SHA256_RE.fullmatch(prior["logSha256"]) is None
    ):
        raise WatcherError("production recovery attestation predecessor binding is invalid")
    if (
        predecessor.status.get("logPath") != prior["logPath"]
        or predecessor.status.get("logSha256") != prior["logSha256"]
    ):
        raise WatcherError("production recovery attestation predecessor log binding drifted")
    expected_admission = {
        "enabled": False,
        "admissionFenceActive": False,
        "maintenanceToken": token,
    }
    if value["databaseAdmission"] != expected_admission:
        raise WatcherError("production recovery attestation admission ownership is invalid")
    environment = value["deploymentEnvironment"]
    if (
        not isinstance(environment, dict)
        or set(environment) != {"airfoilfoamBuildId", "engineExpectedBuildId"}
        or environment["airfoilfoamBuildId"] != value["expectedEngineBuildId"]
        or environment["engineExpectedBuildId"] != value["expectedEngineBuildId"]
    ):
        raise WatcherError("production recovery attestation environment proof is invalid")
    containers = value["containers"]
    if (
        not isinstance(containers, dict)
        or set(containers) != {"api", "worker"}
        or any(
            not isinstance(container, dict)
            or set(container) != {"name", "id", "startedAt", "runtimeBuildId"}
            or container.get("name") not in {"app-api-1", "app-worker-1"}
            or not isinstance(container.get("id"), str)
            or not container["id"]
            or not isinstance(container.get("startedAt"), str)
            or container.get("runtimeBuildId") != value["expectedEngineBuildId"]
            for container in containers.values()
        )
    ):
        raise WatcherError("production recovery attestation container proof is invalid")
    log_proof = value["logProof"]
    if (
        not isinstance(log_proof, dict)
        or set(log_proof) != {"requiredMarker", "requiredMarkerCount", "forbiddenMarkers"}
        or log_proof["requiredMarker"]
        != "Refusing engine rebuild at before service recreate because the engine queue probe failed:"
        or log_proof["requiredMarkerCount"] != 1
        or not isinstance(log_proof["forbiddenMarkers"], list)
        or log_proof["forbiddenMarkers"]
        != [
            "Updated AIRFOILFOAM_BUILD_ID and ENGINE_EXPECTED_BUILD_ID",
            "Engine serves build_id=",
            "Container app-api-1 Recreate",
            "Container app-worker-1 Recreate",
        ]
    ):
        raise WatcherError("production recovery attestation log proof is invalid")


def _recovery_expected_engine_build_id(config: WatchConfig) -> str:
    """Read the already schema-validated old engine identity for child reproof."""
    attestation_path = config.adopt_production_drain_recovery_attestation
    if attestation_path is None:
        raise WatcherError("production recovery attestation is missing")
    _private_regular_file(attestation_path, "production pre-engine recovery attestation")
    value = _read_json(attestation_path, "production pre-engine recovery attestation")
    expected = value.get("expectedEngineBuildId")
    if not isinstance(expected, str) or BUILD_ID_RE.fullmatch(expected) is None:
        raise WatcherError("production recovery attestation engine identity is invalid")
    return expected


def _validate_adopted_production_predecessor(
    config: WatchConfig, token: str
) -> ProductionDrainPredecessor:
    predecessor_build_id = config.adopt_production_drain_predecessor_build_id
    if predecessor_build_id is None:
        raise WatcherError(
            "adopted production drain requires an explicit predecessor build id"
        )
    predecessor = _find_exact_production_drain_predecessor(config, token)
    if predecessor.status.get("buildId") != predecessor_build_id:
        raise WatcherError(
            "adopted production drain predecessor does not match the requested build id"
        )
    if predecessor_build_id == config.build_id:
        raise WatcherError(
            "adopted production drain successor must use a new build id"
        )
    pre_child = _is_known_prechild_chain_receipt(predecessor.status)
    if pre_child:
        if config.adopt_production_drain_recovery_attestation is not None:
            raise WatcherError(
                "pre-child production drain adoption must not supply a recovery attestation"
            )
        return predecessor
    post_spawn_failure = (
        predecessor.status.get("state") == "failed"
        and predecessor.status.get("childSpawned") is True
        and predecessor.status.get("mutationBoundary") == "child_spawned"
        and predecessor.status.get("childExitCode") == 12
    )
    if not post_spawn_failure:
        raise WatcherError(
            "adopted production drain predecessor may have crossed the engine mutation boundary"
        )
    _validate_preengine_recovery_attestation(config, predecessor, token)
    return predecessor


def _try_lock_deploy(config: WatchConfig) -> tuple[int | None, str, str | None]:
    """Acquire the official child lock without following or trusting a link."""
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    try:
        descriptor = os.open(config.deploy_lock_path, flags, 0o600)
    except OSError as error:
        return None, "probe_error", str(error)
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise WatcherError("deployment lock must be a regular file")
        if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o022:
            raise WatcherError(
                "deployment lock must be safely owned and not writable by others"
            )
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(descriptor)
            return None, "held", None
        return descriptor, "acquired", None
    except BaseException as error:
        os.close(descriptor)
        return None, "probe_error", str(error)


def _exact_guarded_child_processes(
    config: WatchConfig, system: CommandSystem
) -> tuple[tuple[str, ...], str | None]:
    captured = system.capture(
        ["ps", "-eo", "pid=,args="], config.probe_timeout_seconds
    )
    if captured.returncode != 0:
        return (), (captured.stderr or captured.stdout).strip() or "ps failed"
    child = str(_pinned_child_path(config))
    matches: list[str] = []
    for line in captured.stdout.splitlines():
        stripped = line.strip()
        _pid, separator, arguments = stripped.partition(" ")
        if not separator:
            continue
        try:
            tokens = shlex.split(arguments)
        except ValueError:
            continue
        if child in tokens and config.build_id in tokens:
            matches.append(stripped)
    return tuple(matches), None


def _engine_build_evidence(
    config: WatchConfig, system: CommandSystem
) -> tuple[str | None, str | None]:
    try:
        health = system.fetch_json(
            "http://127.0.0.1:8000/health", config.probe_timeout_seconds
        )
    except (OSError, ValueError, WatcherError) as error:
        return None, str(error)
    build_id = health.get("build_id")
    if not isinstance(build_id, str) or not build_id:
        return None, "engine health omitted build_id"
    return build_id, None


def _interrupted_drain(
    config: WatchConfig, status: dict[str, Any]
) -> tuple[bool, str, str | None, str | None]:
    if not config.drain_production_admission:
        return False, "not_requested", None, None
    value = status.get("productionAdmissionDrain")
    if not isinstance(value, dict):
        return False, "ownership_unknown", None, "drain receipt is malformed"
    token_value = value.get("token")
    try:
        token = _validated_maintenance_token(token_value)
    except WatcherError as error:
        return False, "ownership_unknown", None, str(error)
    if value != _drain_status(config, "paused_by_watcher", token):
        return False, "ownership_unknown", token, "drain receipt is not an exact owned pause"
    return True, "paused_by_watcher", token, None


def _recover_interrupted_invocation(
    config: WatchConfig,
    pin: SourcePin,
    system: CommandSystem,
    status: dict[str, Any] | None,
) -> int | None:
    """Resolve the prepared-to-spawn crash window without ever replaying a child.

    A pause is released only when the durable receipt says pre-child *and* the
    independent log, lock, process, source, engine-build, and database-owner
    evidence all prove that Popen could not have crossed the mutation boundary.
    Every ambiguous or post-spawn case stays paused for explicit resolution.
    """
    if status is None or status.get("state") not in {
        "invocation_prepared",
        "child_spawned",
        "invocation_started",
    }:
        return None

    previous_state = status.get("state")
    declared_prechild = (
        previous_state == "invocation_prepared"
        and status.get("childSpawned") is False
        and status.get("mutationBoundary") == "pre_child"
    )
    drain_owned, drain_state, drain_token, drain_error = _interrupted_drain(
        config, status
    )
    log_present = os.path.lexists(config.log_path)
    deploy_descriptor, deploy_lock_state, deploy_lock_error = _try_lock_deploy(
        config
    )
    exact_processes: tuple[str, ...] = ()
    process_error: str | None = None
    engine_build_id: str | None = None
    engine_error: str | None = None
    source_error: str | None = None
    drain_database_error: str | None = drain_error
    try:
        if deploy_descriptor is not None:
            try:
                verify_active_release(config, pin)
                verify_complete_pinned_source(config, pin)
                _private_regular_file(
                    _pinned_child_path(config), "pinned guarded rebuild child"
                )
                if _sha256(_pinned_child_path(config)) != pin.child_sha256:
                    raise WatcherError("pinned guarded rebuild child hash changed")
            except (OSError, ValueError, WatcherError) as error:
                source_error = str(error)
            try:
                exact_processes, process_error = _exact_guarded_child_processes(
                    config, system
                )
            except (OSError, ValueError, subprocess.SubprocessError) as error:
                process_error = str(error)
            engine_build_id, engine_error = _engine_build_evidence(config, system)
            if (
                config.drain_production_admission
                and drain_error is None
                and drain_token is not None
            ):
                try:
                    require_owned_production_drain(config, system, drain_token)
                    drain_database_error = None
                except WatcherError as error:
                    drain_database_error = str(error)

        evidence = {
            "declaredPreChild": declared_prechild,
            "logPresent": log_present,
            "deployLockState": deploy_lock_state,
            "deployLockError": deploy_lock_error,
            "exactChildProcesses": list(exact_processes),
            "processProbeError": process_error,
            "engineBuildId": engine_build_id,
            "engineProbeError": engine_error,
            "sourceProbeError": source_error,
            "drainProbeError": drain_database_error,
        }
        proven_prechild = (
            declared_prechild
            and not log_present
            and deploy_lock_state == "acquired"
            and deploy_lock_error is None
            and not exact_processes
            and process_error is None
            and engine_build_id is not None
            and engine_build_id != config.build_id
            and engine_error is None
            and source_error is None
            and (not config.drain_production_admission or drain_owned)
            and drain_database_error is None
        )
        if proven_prechild:
            final_drain_state, restore_error = _restore_owned_drain_before_child(
                config,
                system,
                drain_owned=drain_owned,
                drain_state=drain_state,
                drain_token=drain_token,
            )
            evidence["drainRestoreError"] = restore_error
            if restore_error is None:
                recovered = _status_base(config, pin)
                recovered.update(
                    state="recovered_prechild_crash",
                    finishedAt=_utc_now(),
                    recoveryFromState=previous_state,
                    error=(
                        "the prior watcher stopped before the guarded child was spawned; "
                        "no rebuild was replayed"
                    ),
                    childSpawned=False,
                    mutationBoundary="pre_child",
                    recoveryEvidence=evidence,
                    productionAdmissionDrain=_drain_status(
                        config, final_drain_state, drain_token
                    ),
                )
                _atomic_json(config.status_path, recovered)
                return 12

        blocked = _status_base(config, pin)
        recovery_action = (
            "production admission remains paused"
            if config.drain_production_admission
            else "maintenance remains unresolved"
        )
        blocked.update(
            state="recovery_blocked_ambiguous_child",
            finishedAt=_utc_now(),
            recoveryFromState=previous_state,
            error=(
                "the guarded child may have crossed its spawn or mutation boundary; "
                f"{recovery_action} and the child is never replayed; "
                "inspect recoveryEvidence and the guarded child log"
            ),
            childSpawned=status.get("childSpawned"),
            mutationBoundary="child_may_have_spawned",
            recoveryEvidence=evidence,
            productionAdmissionDrain=_drain_status(
                config, drain_state, drain_token
            ),
        )
        _atomic_json(config.status_path, blocked)
        return 12
    finally:
        if deploy_descriptor is not None:
            os.close(deploy_descriptor)


def _drain_status(
    config: WatchConfig, state: str, token: str | None = None
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "requested": config.drain_production_admission,
        "state": state,
    }
    if token is not None:
        value["token"] = token
    return value


def _restore_owned_drain_before_child(
    config: WatchConfig,
    system: CommandSystem,
    *,
    drain_owned: bool,
    drain_state: str,
    drain_token: str | None,
) -> tuple[str, str | None]:
    """Restore only a proven watcher-owned pause before any child was spawned."""
    if not config.drain_production_admission or not drain_owned:
        return drain_state, None
    if config.adopt_production_drain_token is not None:
        # This pause predates this source-pinned watcher.  A pre-child refusal
        # cannot prove that the old owner intended scheduling to resume, so the
        # successor leaves the exact database token in place for a later fresh
        # source-pinned adoption action.  Only a successful guarded child may
        # restore this token through the normal exact-owner CAS.
        return "adopted_pause_preserved", None
    if drain_token is None:
        return "restore_refused", "owned production drain has no durable token"
    try:
        state = _production_admission_state(config, system)
        if state.fenced:
            return (
                "restore_refused_fence_active",
                "production admission remained paused because a safety fence appeared",
            )
        if state.enabled:
            return "pause_already_released", None
        if state.maintenance_token != drain_token:
            return (
                "restore_refused_token_mismatch",
                "production admission remained paused because maintenance ownership changed",
            )
        restore_production_admission(config, system, drain_token)
        return "restored_before_child", None
    except WatcherError as error:
        return "restore_refused", str(error)


def _record_prechild_refusal(
    config: WatchConfig,
    pin: SourcePin,
    system: CommandSystem,
    error: BaseException,
    *,
    drain_owned: bool,
    drain_state: str,
    drain_token: str | None,
) -> int:
    final_drain_state, restore_error = _restore_owned_drain_before_child(
        config,
        system,
        drain_owned=drain_owned,
        drain_state=drain_state,
        drain_token=drain_token,
    )
    message = str(error)
    if restore_error:
        message = f"{message}; {restore_error}"
    status = _status_base(config, pin)
    status.update(
        state="refused",
        finishedAt=_utc_now(),
        error=message,
        childSpawned=False,
        mutationBoundary="pre_child",
        productionAdmissionDrain=_drain_status(
            config, final_drain_state, drain_token
        ),
    )
    _atomic_json(config.status_path, status)
    print(message, file=sys.stderr, flush=True)
    return 12


def _lock_watcher(config: WatchConfig) -> int:
    flags = os.O_RDWR | os.O_CREAT
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(config.lock_path, flags, 0o600)
    metadata = os.fstat(descriptor)
    if not stat.S_ISREG(metadata.st_mode):
        os.close(descriptor)
        raise WatcherError("watcher lock must be a regular file")
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o077:
        os.close(descriptor)
        raise WatcherError("watcher lock must be private and owned by the watcher")
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        os.close(descriptor)
        raise WatcherError("another guarded engine rebuild watcher is active") from error
    return descriptor


def _prepare_state_dir(path: Path) -> None:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    metadata = path.stat(follow_symlinks=False)
    if not stat.S_ISDIR(metadata.st_mode) or path.is_symlink():
        raise WatcherError("watcher state path must be a non-symlink directory")
    if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o022:
        raise WatcherError(
            "watcher state directory must be safely owned and not writable by others"
        )


def run_watcher(
    config: WatchConfig,
    *,
    system: CommandSystem | None = None,
    collect: Callable[[WatchConfig, CommandSystem], IdleSnapshot] = collect_idle_snapshot,
    sleep: Callable[[float], None] = time.sleep,
    monotonic: Callable[[], float] = time.monotonic,
    max_iterations: int | None = None,
) -> int:
    system = system or LiveSystem()
    _prepare_state_dir(config.state_dir)
    lock_descriptor = _lock_watcher(config)
    try:
        adopted_token = _validate_adopted_production_drain(config)
        pin = verify_source_pin(config)
        existing_status = _load_existing_status(config, pin)
        if adopted_token is not None and existing_status is None:
            _validate_adopted_production_predecessor(config, adopted_token)
        interrupted_outcome = _recover_interrupted_invocation(
            config, pin, system, existing_status
        )
        if interrupted_outcome is not None:
            return interrupted_outcome
        drain_state = "not_requested"
        drain_owned = False
        if config.drain_production_admission:
            if config.role != "production":
                raise WatcherError("only production may use the admission drain")
            existing_drain = (
                existing_status.get("productionAdmissionDrain")
                if existing_status is not None
                else None
            )
            if existing_drain is None:
                drain_token = adopted_token or str(uuid.uuid4())
                status = _status_base(config, pin)
                status.update(
                    state="drain_intent_recorded",
                    updatedAt=_utc_now(),
                    childSpawned=False,
                    mutationBoundary="pre_child",
                    productionAdmissionDrain=_drain_status(
                        config, "intent_recorded", drain_token
                    ),
                )
                _atomic_json(config.status_path, status)
                existing_drain = _drain_status(
                    config, "intent_recorded", drain_token
                )
            if not isinstance(existing_drain, dict):
                return _record_prechild_refusal(
                    config,
                    pin,
                    system,
                    WatcherError("existing production drain status is malformed"),
                    drain_owned=False,
                    drain_state="ownership_unknown",
                    drain_token=None,
                )
            drain_token_value = existing_drain.get("token")
            try:
                drain_token = _validated_maintenance_token(drain_token_value)
            except WatcherError as error:
                return _record_prechild_refusal(
                    config,
                    pin,
                    system,
                    error,
                    drain_owned=False,
                    drain_state="ownership_unknown",
                    drain_token=None,
                )

            if existing_drain == _drain_status(
                config, "intent_recorded", drain_token
            ):
                try:
                    admission = _production_admission_state(config, system)
                    if admission.fenced:
                        raise WatcherError(
                            "production drain intent cannot proceed while a safety fence is active"
                        )
                    if admission.maintenance_token == drain_token:
                        if admission.enabled:
                            raise WatcherError(
                                "maintenance token exists while scheduler admission is enabled"
                            )
                        drain_owned = True
                    elif (
                        admission.maintenance_token is None
                        and admission.enabled
                    ):
                        try:
                            pause_production_admission(
                                config, system, drain_token
                            )
                            drain_owned = True
                        except WatcherError:
                            # A lost psql response may follow a committed
                            # update.  The DB token, unlike a file receipt,
                            # proves ownership across that exact crash window.
                            admission = _production_admission_state(
                                config, system
                            )
                            if (
                                admission.enabled
                                or admission.fenced
                                or admission.maintenance_token != drain_token
                            ):
                                raise
                            drain_owned = True
                    else:
                        raise WatcherError(
                            "production scheduler drain is owned by another token or pause"
                        )
                    drain_state = "paused_by_watcher"
                    status = _status_base(config, pin)
                    status.update(
                        state="admission_drain_paused",
                        updatedAt=_utc_now(),
                        childSpawned=False,
                        mutationBoundary="pre_child",
                        productionAdmissionDrain=_drain_status(
                            config, drain_state, drain_token
                        ),
                    )
                    _atomic_json(config.status_path, status)
                except WatcherError as error:
                    return _record_prechild_refusal(
                        config,
                        pin,
                        system,
                        error,
                        drain_owned=drain_owned,
                        drain_state=drain_state,
                        drain_token=drain_token,
                    )
            elif existing_drain == _drain_status(
                config, "paused_by_watcher", drain_token
            ):
                drain_owned = True
                drain_state = "paused_by_watcher"
            else:
                return _record_prechild_refusal(
                    config,
                    pin,
                    system,
                    WatcherError(
                        "existing watcher status has an invalid production drain state"
                    ),
                    drain_owned=False,
                    drain_state="ownership_unknown",
                    drain_token=drain_token,
                )
            try:
                require_owned_production_drain(config, system, drain_token)
            except WatcherError as error:
                return _record_prechild_refusal(
                    config,
                    pin,
                    system,
                    error,
                    drain_owned=drain_owned,
                    drain_state=drain_state,
                    drain_token=drain_token,
                )
        else:
            drain_token = None
        stable_count = 0
        first_stable_at: float | None = None
        iteration = 0
        while True:
            iteration += 1
            try:
                verify_pinned_source(config, pin)
                verify_active_release(config, pin)
                if config.drain_production_admission:
                    if drain_token is None:
                        raise WatcherError(
                            "production admission drain has no durable token"
                        )
                    require_owned_production_drain(
                        config, system, drain_token
                    )
            except (OSError, ValueError, WatcherError) as error:
                return _record_prechild_refusal(
                    config,
                    pin,
                    system,
                    error,
                    drain_owned=drain_owned,
                    drain_state=drain_state,
                    drain_token=drain_token,
                )

            if collect is collect_idle_snapshot:
                snapshot = collect(
                    config,
                    system,
                    maintenance_token=drain_token,
                )
            else:
                snapshot = collect(config, system)
            sampled_at = monotonic()
            if snapshot.idle:
                if stable_count == 0:
                    first_stable_at = sampled_at
                stable_count += 1
            else:
                stable_count = 0
                first_stable_at = None
            separated = (
                stable_count >= config.stable_samples
                and first_stable_at is not None
                and sampled_at - first_stable_at
                >= config.poll_seconds * (config.stable_samples - 1)
            )
            status = _status_base(config, pin)
            status.update(
                state="waiting",
                updatedAt=_utc_now(),
                stableSamples=stable_count,
                requiredStableSamples=config.stable_samples,
                lastSnapshot=snapshot.as_json(),
                productionAdmissionDrain=_drain_status(
                    config, drain_state, drain_token
                ),
            )
            _atomic_json(config.status_path, status)
            print(
                f"[{_utc_now()}] idle={snapshot.idle} "
                f"stable={stable_count}/{config.stable_samples} "
                f"live_jobs={snapshot.live_jobs} openfoam={len(snapshot.openfoam_processes)} "
                f"queue_idle={snapshot.queue_idle} error={snapshot.error or '-'}",
                flush=True,
            )
            if separated:
                break
            if max_iterations is not None and iteration >= max_iterations:
                return 10
            sleep(config.poll_seconds)

        try:
            verify_active_release(config, pin)
            verify_complete_pinned_source(config, pin)
            if config.drain_production_admission:
                if drain_token is None:
                    raise WatcherError(
                        "production admission drain has no durable token"
                    )
                require_owned_production_drain(config, system, drain_token)
            pinned_child = materialize_pinned_child(config, pin)
            pinned_verifier = materialize_pinned_verifier(config, pin)
            # The final checks are intentionally after materialization and
            # immediately before the prepared mutation boundary.
            verify_complete_pinned_source(config, pin)
            verify_active_release(config, pin)
        except (OSError, ValueError, WatcherError) as error:
            return _record_prechild_refusal(
                config,
                pin,
                system,
                error,
                drain_owned=drain_owned,
                drain_state=drain_state,
                drain_token=drain_token,
            )
        status = _status_base(config, pin)
        status.update(
            state="invocation_prepared",
            preparedAt=_utc_now(),
            childSpawned=False,
            mutationBoundary="pre_child",
            productionAdmissionDrain=_drain_status(
                config, drain_state, drain_token
            ),
        )
        _atomic_json(config.status_path, status)
        print(
            f"Invoking guarded {config.role} engine rebuild exactly once for {config.build_id}",
            flush=True,
        )
        child_spawned = False

        def record_child_spawn(child_pid: int) -> None:
            nonlocal child_spawned, status
            child_spawned = True
            status = _status_base(config, pin)
            status.update(
                state="child_spawned",
                startedAt=_utc_now(),
                childPid=child_pid,
                childSpawned=True,
                mutationBoundary="child_spawned",
                productionAdmissionDrain=_drain_status(
                    config, drain_state, drain_token
                ),
            )
            _atomic_json(config.status_path, status)

        try:
            return_code = system.invoke(
                pinned_invocation(
                    config,
                    pin,
                    pinned_child,
                    pinned_verifier,
                    maintenance_token=drain_token,
                ),
                config.log_path,
                record_child_spawn,
            )
        except ChildInvocationError as error:
            if not error.child_spawned:
                return _record_prechild_refusal(
                    config,
                    pin,
                    system,
                    error,
                    drain_owned=drain_owned,
                    drain_state=drain_state,
                    drain_token=drain_token,
                )
            child_spawned = True
            status = _status_base(config, pin)
            status.update(
                state="failed",
                finishedAt=_utc_now(),
                error=str(error),
                childSpawned=True,
                mutationBoundary="child_spawned",
                productionAdmissionDrain=_drain_status(
                    config, drain_state, drain_token
                ),
            )
            if config.log_path.exists():
                status["logSha256"] = _sha256(config.log_path)
            _atomic_json(config.status_path, status)
            print(str(error), file=sys.stderr, flush=True)
            return 12
        except BaseException as error:
            # An implementation outside LiveSystem violated the explicit
            # invocation contract.  The prepared marker means a child might
            # exist, so preserve the pause and refuse a replay.
            status = _status_base(config, pin)
            status.update(
                state="failed",
                finishedAt=_utc_now(),
                error=f"invocation outcome is unknown: {error}",
                childSpawned=child_spawned,
                mutationBoundary="child_may_have_spawned",
                productionAdmissionDrain=_drain_status(
                    config, drain_state, drain_token
                ),
            )
            if config.log_path.exists():
                status["logSha256"] = _sha256(config.log_path)
            _atomic_json(config.status_path, status)
            return 12

        if not child_spawned:
            status = _status_base(config, pin)
            status.update(
                state="failed",
                finishedAt=_utc_now(),
                error="invoker returned without a durable child-spawn receipt",
                childSpawned=False,
                mutationBoundary="child_may_have_spawned",
                productionAdmissionDrain=_drain_status(
                    config, drain_state, drain_token
                ),
            )
            if config.log_path.exists():
                status["logSha256"] = _sha256(config.log_path)
            _atomic_json(config.status_path, status)
            return 12
        if return_code == 0 and config.drain_production_admission:
            try:
                if drain_token is None:
                    raise WatcherError(
                        "production admission drain has no durable token"
                    )
                restore_production_admission(config, system, drain_token)
                drain_state = "restored_after_child_success"
            except WatcherError as error:
                status.update(
                    state="failed",
                    finishedAt=_utc_now(),
                    childExitCode=return_code,
                    logSha256=_sha256(config.log_path),
                    error=str(error),
                    childSpawned=True,
                    mutationBoundary="child_spawned",
                    productionAdmissionDrain=_drain_status(
                        config, "restore_refused", drain_token
                    ),
                )
                _atomic_json(config.status_path, status)
                print(str(error), file=sys.stderr, flush=True)
                return 12
        status.update(
            state="completed" if return_code == 0 else "failed",
            finishedAt=_utc_now(),
            childExitCode=return_code,
            logSha256=_sha256(config.log_path),
            childSpawned=True,
            mutationBoundary="child_spawned",
            productionAdmissionDrain=_drain_status(
                config, drain_state, drain_token
            ),
        )
        _atomic_json(config.status_path, status)
        return return_code
    finally:
        os.close(lock_descriptor)


def _parse_args(argv: list[str] | None = None) -> WatchConfig:
    parser = argparse.ArgumentParser(
        description=(
            "Wait for two separated idle engine snapshots, then invoke the "
            "role-specific guarded rebuild exactly once."
        )
    )
    parser.add_argument("--role", choices=sorted(ROLE_CONTRACTS), required=True)
    parser.add_argument("--build-id", required=True)
    parser.add_argument("--expected-revision", required=True)
    parser.add_argument("--expected-tree-sha256", required=True)
    parser.add_argument("--app-dir", type=Path, default=Path("/opt/airfoils-pro/app"))
    parser.add_argument(
        "--state-dir", type=Path, default=Path("/opt/airfoils-pro/state")
    )
    parser.add_argument("--poll-seconds", type=float, default=60.0)
    parser.add_argument("--stable-samples", type=int, default=2)
    parser.add_argument("--probe-timeout-seconds", type=float, default=20.0)
    parser.add_argument("--queue-max-age-seconds", type=float, default=90.0)
    parser.add_argument(
        "--deploy-lock-path",
        type=Path,
        default=Path("/tmp/airfoils-pro-deploy.lock"),
        help="exact shared lock used by the official guarded rebuild child",
    )
    parser.add_argument(
        "--drain-production-admission",
        action="store_true",
        help=(
            "atomically stop new production submissions before waiting; restore them "
            "only after this watcher\'s guarded child succeeds with no active safety fence"
        ),
    )
    parser.add_argument(
        "--adopt-production-drain-token",
        help=(
            "adopt this exact already-paused production maintenance token after "
            "a source-pinned release handoff; an exact predecessor build id is "
            "mandatory and the token is preserved on every refusal"
        ),
    )
    parser.add_argument(
        "--adopt-production-drain-predecessor-build-id",
        help=(
            "exact build id of the one prior production watcher receipt that owns "
            "--adopt-production-drain-token"
        ),
    )
    parser.add_argument(
        "--adopt-production-drain-recovery-attestation",
        type=Path,
        help=(
            "canonical private production pre-engine-mutation attestation required "
            "only when the named predecessor spawned a child that failed with exit 12"
        ),
    )
    args = parser.parse_args(argv)
    if not BUILD_ID_RE.fullmatch(args.build_id):
        parser.error("build id may contain only letters, digits, dot, underscore, and hyphen")
    if not REVISION_RE.fullmatch(args.expected_revision):
        parser.error("expected revision must be a 40-character lowercase Git SHA")
    if not SHA256_RE.fullmatch(args.expected_tree_sha256):
        parser.error("expected tree SHA-256 must be 64 lowercase hex characters")
    if args.poll_seconds < 5:
        parser.error("poll seconds must be at least 5")
    if args.stable_samples < 2:
        parser.error("at least two stable samples are required")
    if not 1 <= args.probe_timeout_seconds <= 60:
        parser.error("probe timeout must be between 1 and 60 seconds")
    if args.queue_max_age_seconds < args.poll_seconds:
        parser.error("queue max age must be at least the poll interval")
    if args.drain_production_admission and args.role != "production":
        parser.error("only production may use --drain-production-admission")
    if args.adopt_production_drain_token is not None:
        if args.role != "production" or not args.drain_production_admission:
            parser.error(
                "--adopt-production-drain-token requires production role and "
                "--drain-production-admission"
            )
        try:
            _validated_maintenance_token(args.adopt_production_drain_token)
        except WatcherError as error:
            parser.error(str(error))
        if (
            not isinstance(args.adopt_production_drain_predecessor_build_id, str)
            or BUILD_ID_RE.fullmatch(args.adopt_production_drain_predecessor_build_id)
            is None
        ):
            parser.error(
                "--adopt-production-drain-token requires "
                "--adopt-production-drain-predecessor-build-id"
            )
    elif (
        args.adopt_production_drain_predecessor_build_id is not None
        or args.adopt_production_drain_recovery_attestation is not None
    ):
        parser.error(
            "production drain predecessor and recovery attestation require "
            "--adopt-production-drain-token"
        )
    if (
        args.adopt_production_drain_recovery_attestation is not None
        and args.adopt_production_drain_token is not None
    ):
        args.adopt_production_drain_recovery_attestation = (
            args.adopt_production_drain_recovery_attestation.absolute()
        )
    return WatchConfig(
        role=args.role,
        build_id=args.build_id,
        app_dir=args.app_dir.absolute(),
        state_dir=args.state_dir.absolute(),
        expected_revision=args.expected_revision,
        expected_tree_sha256=args.expected_tree_sha256,
        poll_seconds=args.poll_seconds,
        stable_samples=args.stable_samples,
        probe_timeout_seconds=args.probe_timeout_seconds,
        queue_max_age_seconds=args.queue_max_age_seconds,
        drain_production_admission=args.drain_production_admission,
        adopt_production_drain_token=args.adopt_production_drain_token,
        adopt_production_drain_predecessor_build_id=(
            args.adopt_production_drain_predecessor_build_id
        ),
        adopt_production_drain_recovery_attestation=(
            args.adopt_production_drain_recovery_attestation
        ),
        deploy_lock_path=args.deploy_lock_path.absolute(),
    )


def main(argv: list[str] | None = None) -> int:
    try:
        return run_watcher(_parse_args(argv))
    except (OSError, ValueError, WatcherError) as error:
        print(f"guarded engine rebuild watcher refused: {error}", file=sys.stderr)
        return 12


if __name__ == "__main__":
    raise SystemExit(main())
