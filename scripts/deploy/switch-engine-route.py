#!/usr/bin/env python3
"""Fail closed while switching the production control-plane engine route.

The Node control-plane services read ``ENGINE_URL`` from the external
``.env.deploy`` file while normal deploys fence that value against the
state-owned ``engine-route.json`` marker.  Replacing those two files with two
unrelated shell edits creates a window in which a deploy can revive the wrong
gateway.  This helper owns the only supported change path:

* it serializes with the normal production deployment lock;
* it proves *both* primary and recovery candidates twice, each against its own
  caller-supplied exact engine build id;
* it writes a durable, non-secret transaction journal before either state file
  is renamed; and
* it uses per-file atomic replacements plus directory fsyncs.  A process loss
  between the two replacements leaves the journal in place, which makes the
  deployment preflight refuse service mutation until this helper is re-run
  with the exact same request and completes the transaction.

It never invokes a Docker/Compose lifecycle command. The required consumer
network proof uses a short-lived ``docker compose exec`` inside the existing
``node-api`` container; it neither creates nor restarts a container. Switching
the state route changes what a future control-plane restart will use; it never
hot-switches a running process.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Iterator, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


DEFAULT_APP_DIR = Path("/opt/airfoils-pro/app")
DEFAULT_STATE_DIR = Path("/opt/airfoils-pro/state")
DEFAULT_LOCK_FILE = Path("/tmp/airfoils-pro-deploy.lock")
ENV_FILE_NAME = ".env.deploy"
ROUTE_MARKER_NAME = "engine-route.json"
PENDING_NAME = ".engine-route-switch.pending.json"
MAX_HEALTH_BYTES = 1_048_576
BUILD_ID_RE = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
STAGED_NAME_RE = re.compile(r"^\.engine-route-switch\.[A-Za-z0-9._-]+$")
COMPOSE_PROJECT_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
CONSUMER_PROBE_SERVICE = "node-api"
CONSUMER_HEALTH_PROBE = r"""
const target = process.env.AIRFOILFOAM_ENGINE_ROUTE_PROBE_URL;
const expectedBuildId = process.env.AIRFOILFOAM_ENGINE_ROUTE_PROBE_BUILD_ID;
const timeoutSeconds = Number(process.env.AIRFOILFOAM_ENGINE_ROUTE_PROBE_TIMEOUT);
const maxBytes = Number(process.env.AIRFOILFOAM_ENGINE_ROUTE_PROBE_MAX_BYTES);

function fail(message) {
  process.stderr.write(`consumer engine health proof failed: ${message}\\n`);
  process.exitCode = 2;
}

async function main() {
  if (!target || !expectedBuildId || !Number.isFinite(timeoutSeconds) || !Number.isFinite(maxBytes)) {
    fail("required probe environment is invalid");
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.ceil(timeoutSeconds * 1000));
  try {
    const response = await fetch(new URL("/health", target), {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (response.status !== 200) {
      fail(`HTTP ${response.status}`);
      return;
    }
    if (!response.body) {
      fail("response body was missing");
      return;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        fail(`response exceeded ${maxBytes} bytes`);
        return;
      }
      chunks.push(Buffer.from(next.value));
    }
    const payload = JSON.parse(Buffer.concat(chunks, totalBytes).toString("utf8"));
    if (!payload || typeof payload !== "object") {
      fail("response was not a JSON object");
      return;
    }
    if (payload.status !== "ok") {
      fail("status was not ok");
      return;
    }
    if (payload.build_id !== expectedBuildId) {
      fail(`build_id=${JSON.stringify(payload.build_id)} expected=${JSON.stringify(expectedBuildId)}`);
      return;
    }
    process.stdout.write("consumer engine health proof ok\\n");
  } catch (error) {
    fail(error && error.message ? error.message : String(error));
  } finally {
    clearTimeout(timer);
  }
}

void main();
""".strip()


class RouteSwitchError(RuntimeError):
    """A deliberate fail-closed refusal that is safe to show an operator."""


@dataclass(frozen=True)
class EngineCandidate:
    """One independently identified engine route and its health proofs."""

    name: str
    engine_url: str
    expected_build_id: str
    health_url: str | None


@dataclass(frozen=True)
class RouteSwitchRequest:
    app_dir: Path
    state_dir: Path
    env_file: Path
    lock_file: Path
    primary_engine_url: str
    primary_expected_build_id: str
    primary_health_url: str | None
    recovery_engine_url: str
    recovery_expected_build_id: str
    recovery_health_url: str | None
    active_route: str
    health_timeout_seconds: float

    @property
    def selected_engine_url(self) -> str:
        if self.active_route == "primary":
            return self.primary_engine_url
        return self.recovery_engine_url

    @property
    def primary_candidate(self) -> EngineCandidate:
        return EngineCandidate(
            name="primary",
            engine_url=self.primary_engine_url,
            expected_build_id=self.primary_expected_build_id,
            health_url=self.primary_health_url,
        )

    @property
    def recovery_candidate(self) -> EngineCandidate:
        return EngineCandidate(
            name="recovery",
            engine_url=self.recovery_engine_url,
            expected_build_id=self.recovery_expected_build_id,
            health_url=self.recovery_health_url,
        )


@dataclass(frozen=True)
class Target:
    name: str
    path: Path
    old_sha256: str | None
    new_sha256: str
    staged_name: str


class _NoRedirect(HTTPRedirectHandler):
    """A health proof must be for the requested candidate, not a redirect."""

    def redirect_request(  # type: ignore[override]
        self, *args: object, **kwargs: object
    ) -> Request:
        raise HTTPError(
            str(args[0]) if args else "",
            302,
            "redirects are not accepted for engine route health proofs",
            hdrs=None,
            fp=None,
        )


def _absolute(path: Path) -> Path:
    if not path.is_absolute():
        raise RouteSwitchError(f"path must be absolute: {path}")
    # abspath normalizes ``.`` / ``..`` without resolving a potentially unsafe
    # symlink in the external state tree.
    return Path(os.path.abspath(path))


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise RouteSwitchError(
                f"unsafe engine-route state path contains a symbolic link: {current}"
            )


def _validate_owned_regular_file(
    path: Path, label: str, *, exact_mode: int | None = None
) -> None:
    _reject_symlink_components(path)
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise RouteSwitchError(f"missing {label}: {path}") from error
    if not stat.S_ISREG(metadata.st_mode):
        raise RouteSwitchError(f"{label} must be a non-symlink regular file: {path}")
    if metadata.st_uid != os.geteuid():
        raise RouteSwitchError(f"{label} must be owned by the deploying user: {path}")
    mode = stat.S_IMODE(metadata.st_mode)
    if exact_mode is not None and mode != exact_mode:
        raise RouteSwitchError(
            f"{label} must have exact mode {exact_mode:04o}: {path} has {mode:04o}"
        )
    if mode & 0o022:
        raise RouteSwitchError(f"{label} must not be group/world writable: {path}")


def _validate_state_dir(state_dir: Path) -> None:
    _reject_symlink_components(state_dir)
    try:
        metadata = state_dir.lstat()
    except FileNotFoundError as error:
        raise RouteSwitchError(
            f"missing engine-route state directory: {state_dir}"
        ) from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise RouteSwitchError(
            f"engine-route state must be a real directory: {state_dir}"
        )
    if metadata.st_uid != os.geteuid():
        raise RouteSwitchError(
            f"engine-route state must be owned by the deploying user: {state_dir}"
        )
    if stat.S_IMODE(metadata.st_mode) & 0o022:
        raise RouteSwitchError(
            f"engine-route state must not be group/world writable: {state_dir}"
        )


def _validate_owned_directory(path: Path, label: str) -> None:
    _reject_symlink_components(path)
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise RouteSwitchError(f"missing {label}: {path}") from error
    if not stat.S_ISDIR(metadata.st_mode):
        raise RouteSwitchError(f"{label} must be a non-symlink directory: {path}")
    if metadata.st_uid != os.geteuid():
        raise RouteSwitchError(f"{label} must be owned by the deploying user: {path}")
    if stat.S_IMODE(metadata.st_mode) & 0o022:
        raise RouteSwitchError(f"{label} must not be group/world writable: {path}")


def _active_app_dir(app_dir: Path, state_dir: Path) -> Path:
    """Resolve the intentional active-release symlink without widening trust.

    The normal deployer atomically flips ``/opt/airfoils-pro/app`` to a
    versioned release under the same deployment root. Route switching must use
    that current Compose file, while refusing an arbitrary symlink target or a
    symlink anywhere inside the release tree.
    """
    _reject_symlink_components(app_dir.parent)
    try:
        metadata = app_dir.lstat()
    except FileNotFoundError as error:
        raise RouteSwitchError(f"missing active application path: {app_dir}") from error
    if stat.S_ISDIR(metadata.st_mode):
        _validate_owned_directory(app_dir, "active application directory")
        return app_dir
    if not stat.S_ISLNK(metadata.st_mode):
        raise RouteSwitchError(
            f"active application path must be a directory or release symlink: {app_dir}"
        )

    releases = state_dir.parent / "releases"
    _validate_owned_directory(releases, "versioned releases directory")
    try:
        resolved = app_dir.resolve(strict=True)
    except OSError as error:
        raise RouteSwitchError(
            f"active application release symlink cannot be resolved: {app_dir}"
        ) from error
    releases_real = releases.resolve(strict=True)
    try:
        resolved.relative_to(releases_real)
    except ValueError as error:
        raise RouteSwitchError(
            "active application release symlink must target the deployment "
            f"releases directory: {app_dir} -> {resolved}"
        ) from error
    _validate_owned_directory(resolved, "active versioned application release")
    return resolved


def _safe_optional_file(path: Path, label: str) -> bool:
    """Validate an optional state file without following a dangling symlink."""
    _reject_symlink_components(path)
    if not os.path.lexists(path):
        return False
    _validate_owned_regular_file(path, label)
    return True


def _read_bytes(path: Path, label: str, *, exact_mode: int | None = None) -> bytes:
    _validate_owned_regular_file(path, label, exact_mode=exact_mode)
    return path.read_bytes()


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _canonical_engine_url(value: str, label: str) -> str:
    if value != value.strip() or not value:
        raise RouteSwitchError(
            f"{label} must be a non-empty, whitespace-free HTTP(S) URL"
        )
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise RouteSwitchError(f"{label} has an invalid port") from error
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise RouteSwitchError(
            f"{label} must be an HTTP(S) engine origin without credentials, path, "
            "query, or fragment"
        )
    hostname = parsed.hostname.lower()
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    authority = hostname if port is None else f"{hostname}:{port}"
    return f"{parsed.scheme.lower()}://{authority}"


def _canonical_health_url(value: str, label: str) -> str:
    if value != value.strip() or not value:
        raise RouteSwitchError(
            f"{label} must be a non-empty, whitespace-free HTTP(S) health URL"
        )
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise RouteSwitchError(f"{label} has an invalid port") from error
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/health"
        or parsed.query
        or parsed.fragment
    ):
        raise RouteSwitchError(
            f"{label} must be an HTTP(S) /health URL without credentials, query, "
            "or fragment"
        )
    hostname = parsed.hostname.lower()
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    authority = hostname if port is None else f"{hostname}:{port}"
    return f"{parsed.scheme.lower()}://{authority}/health"


def _probe_health_url(
    health_url: str, candidate: EngineCandidate, timeout_seconds: float
) -> None:
    request = Request(
        health_url,
        headers={"Accept": "application/json"},
        method="GET",
    )
    opener = build_opener(_NoRedirect())
    try:
        with opener.open(request, timeout=timeout_seconds) as response:
            status = getattr(response, "status", response.getcode())
            if status != 200:
                raise RouteSwitchError(
                    f"{candidate.name} engine host health proof for {health_url} "
                    f"returned HTTP {status}, "
                    "expected 200"
                )
            body = response.read(MAX_HEALTH_BYTES + 1)
    except HTTPError as error:
        raise RouteSwitchError(
            f"{candidate.name} engine host health proof for {health_url} returned "
            f"HTTP {error.code}"
        ) from error
    except (URLError, TimeoutError, OSError) as error:
        raise RouteSwitchError(
            f"{candidate.name} engine host health proof for {health_url} failed: {error}"
        ) from error
    if len(body) > MAX_HEALTH_BYTES:
        raise RouteSwitchError(
            f"{candidate.name} engine host health proof for {health_url} exceeded "
            f"{MAX_HEALTH_BYTES} bytes"
        )
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RouteSwitchError(
            f"{candidate.name} engine host health proof for {health_url} did not return JSON"
        ) from error
    if not isinstance(payload, Mapping):
        raise RouteSwitchError(
            f"{candidate.name} engine host health proof for {health_url} must be a JSON object"
        )
    if payload.get("status") != "ok":
        raise RouteSwitchError(
            f"{candidate.name} engine host health proof for {health_url} did not "
            "report status=ok"
        )
    if payload.get("build_id") != candidate.expected_build_id:
        actual = payload.get("build_id")
        raise RouteSwitchError(
            f"{candidate.name} engine host health proof for {health_url} has "
            f"build_id={actual!r}; expected {candidate.expected_build_id!r}"
        )


def _read_deploy_value(env_bytes: bytes, key: str) -> str | None:
    try:
        source = env_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RouteSwitchError("deployment env is not valid UTF-8") from error
    values = [
        line.split("=", 1)[1].rstrip("\r\n")
        for line in source.splitlines(keepends=True)
        if line.startswith(f"{key}=")
    ]
    if len(values) > 1:
        raise RouteSwitchError(f"deployment env contains duplicate {key} entries")
    return values[0] if values else None


def _compose_command(request: RouteSwitchRequest) -> list[str]:
    """Build a read-only ``compose exec`` command for the actual consumer net.

    A host process cannot resolve Compose service DNS such as ``api``.  Prove
    the origin from the same network namespace that the Node control plane uses
    instead.  This function only selects an already installed client; the
    resulting command below is an ``exec`` and never a lifecycle operation.
    """
    env_bytes = _read_bytes(request.env_file, "deployment env", exact_mode=0o600)
    role = _read_deploy_value(env_bytes, "AIRFOILFOAM_DEPLOYMENT_ROLE") or "hub"
    if role != "hub":
        raise RouteSwitchError(
            "engine route switching requires the hub node-api consumer network"
        )
    project = _read_deploy_value(env_bytes, "COMPOSE_PROJECT_NAME") or "app"
    if not COMPOSE_PROJECT_RE.fullmatch(project):
        raise RouteSwitchError("deployment COMPOSE_PROJECT_NAME is not safe")
    override = _read_deploy_value(env_bytes, "COMPOSE_OVERRIDE_FILE")
    if override:
        raise RouteSwitchError(
            "hub engine route switching refuses an unexpected Compose override"
        )
    compose_file = _active_app_dir(request.app_dir, request.state_dir) / (
        "docker-compose.deploy.yml"
    )
    _validate_owned_regular_file(compose_file, "deployment Compose file")
    docker = shutil.which("docker")
    if docker:
        try:
            check = subprocess.run(
                [docker, "compose", "version"],
                text=True,
                capture_output=True,
                check=False,
                timeout=5,
            )
        except (OSError, subprocess.TimeoutExpired) as error:
            raise RouteSwitchError(
                "could not check Docker Compose for the consumer-network health proof"
            ) from error
        if check.returncode == 0:
            return [
                docker,
                "compose",
                "--env-file",
                str(request.env_file),
                "-p",
                project,
                "-f",
                str(compose_file),
            ]
    legacy = shutil.which("docker-compose")
    if legacy:
        return [
            legacy,
            "--env-file",
            str(request.env_file),
            "-p",
            project,
            "-f",
            str(compose_file),
        ]
    raise RouteSwitchError(
        "Docker Compose is unavailable for the required consumer-network health proof"
    )


def _probe_health_from_consumer(
    request: RouteSwitchRequest, candidate: EngineCandidate
) -> None:
    command = _compose_command(request) + [
        "exec",
        "-T",
        "-e",
        f"AIRFOILFOAM_ENGINE_ROUTE_PROBE_URL={candidate.engine_url}",
        "-e",
        f"AIRFOILFOAM_ENGINE_ROUTE_PROBE_BUILD_ID={candidate.expected_build_id}",
        "-e",
        f"AIRFOILFOAM_ENGINE_ROUTE_PROBE_TIMEOUT={request.health_timeout_seconds}",
        "-e",
        f"AIRFOILFOAM_ENGINE_ROUTE_PROBE_MAX_BYTES={MAX_HEALTH_BYTES}",
        CONSUMER_PROBE_SERVICE,
        "node",
        "-e",
        CONSUMER_HEALTH_PROBE,
    ]
    try:
        completed = subprocess.run(
            command,
            text=True,
            capture_output=True,
            check=False,
            timeout=max(10, int(request.health_timeout_seconds) + 8),
        )
    except subprocess.TimeoutExpired as error:
        raise RouteSwitchError(
            f"{candidate.name} engine consumer-network health proof timed out"
        ) from error
    except OSError as error:
        raise RouteSwitchError(
            f"{candidate.name} engine consumer-network health proof could not start: {error}"
        ) from error
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "unknown error"
        raise RouteSwitchError(
            f"{candidate.name} engine consumer-network health proof failed: {detail}"
        )


def _validate_candidates(request: RouteSwitchRequest) -> None:
    # Probe every candidate, not merely the route being selected. A switch is
    # only meaningful if its designated failover is independently usable from
    # the actual Node control-plane network. An optional host-visible /health
    # endpoint is additive evidence, never a substitute for that proof.
    for candidate in (request.primary_candidate, request.recovery_candidate):
        _probe_health_from_consumer(request, candidate)
        if candidate.health_url is not None:
            _probe_health_url(
                candidate.health_url,
                candidate,
                request.health_timeout_seconds,
            )


def _replace_engine_url(env_bytes: bytes, selected_engine_url: str) -> bytes:
    try:
        source = env_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RouteSwitchError("deployment env is not valid UTF-8") from error
    lines = source.splitlines(keepends=True)
    found = 0
    output: list[str] = []
    for line in lines:
        if line.startswith("ENGINE_URL="):
            found += 1
            ending = "\n" if line.endswith("\n") else ""
            output.append(f"ENGINE_URL={selected_engine_url}{ending}")
        else:
            output.append(line)
    if found != 1:
        raise RouteSwitchError(
            "deployment env must contain exactly one unquoted ENGINE_URL entry"
        )
    rendered = "".join(output)
    if not rendered.endswith("\n"):
        rendered += "\n"
    return rendered.encode("utf-8")


def _current_engine_url(env_bytes: bytes) -> str:
    try:
        source = env_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise RouteSwitchError("deployment env is not valid UTF-8") from error
    values = [
        line.split("=", 1)[1].rstrip("\r\n")
        for line in source.splitlines(keepends=True)
        if line.startswith("ENGINE_URL=")
    ]
    if len(values) != 1:
        raise RouteSwitchError(
            "deployment env must contain exactly one unquoted ENGINE_URL entry"
        )
    _canonical_engine_url(values[0], "deployment ENGINE_URL")
    return values[0]


def _read_marker(path: Path) -> tuple[bytes | None, str | None]:
    if not _safe_optional_file(path, "engine route marker"):
        return None, None
    raw = path.read_bytes()
    try:
        payload = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RouteSwitchError("engine route marker is not valid JSON") from error
    if not isinstance(payload, Mapping) or payload.get("schema_version") != 1:
        raise RouteSwitchError("engine route marker must use schema_version 1")
    engine_url = payload.get("engine_url")
    if not isinstance(engine_url, str):
        raise RouteSwitchError("engine route marker must contain an engine_url string")
    _canonical_engine_url(engine_url, "engine route marker engine_url")
    return raw, engine_url


def _marker_bytes(engine_url: str) -> bytes:
    # Keep the current v1 marker contract intentionally minimal; it is consumed
    # by deployment-env-preflight.py as the active route authority.
    return (
        json.dumps({"schema_version": 1, "engine_url": engine_url}, sort_keys=True)
        + "\n"
    ).encode("utf-8")


def _fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_new_file(state_dir: Path, suffix: str, content: bytes) -> Path:
    descriptor, name = tempfile.mkstemp(
        prefix=".engine-route-switch.", suffix=suffix, dir=state_dir
    )
    path = Path(name)
    try:
        os.fchmod(descriptor, 0o600)
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
    except BaseException:
        try:
            path.unlink()
        except FileNotFoundError:
            pass
        raise
    finally:
        os.close(descriptor)
    return path


def _safe_unlink(path: Path, label: str) -> None:
    if not os.path.lexists(path):
        return
    _validate_owned_regular_file(path, label)
    path.unlink()


def _json_bytes(value: Mapping[str, object]) -> bytes:
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode(
        "utf-8"
    )


def _target_payload(target: Target) -> dict[str, object]:
    return {
        "path": target.path.name,
        "old_sha256": target.old_sha256,
        "new_sha256": target.new_sha256,
        "staged_name": target.staged_name,
    }


def _transaction_payload(
    request: RouteSwitchRequest, targets: list[Target]
) -> dict[str, object]:
    return {
        "schema_version": 1,
        "operation": "engine-route-switch",
        "primary_engine_url": request.primary_engine_url,
        "primary_expected_build_id": request.primary_expected_build_id,
        "primary_health_url": request.primary_health_url,
        "recovery_engine_url": request.recovery_engine_url,
        "recovery_expected_build_id": request.recovery_expected_build_id,
        "recovery_health_url": request.recovery_health_url,
        "active_route": request.active_route,
        "engine_url": request.selected_engine_url,
        "commit_order": [target.name for target in targets],
        "targets": {target.name: _target_payload(target) for target in targets},
    }


def _parse_target(name: str, raw: object, state_dir: Path) -> Target:
    if not isinstance(raw, Mapping):
        raise RouteSwitchError(f"pending route transaction target {name} is invalid")
    expected_path = ENV_FILE_NAME if name == "env" else ROUTE_MARKER_NAME
    path_value = raw.get("path")
    old_sha256 = raw.get("old_sha256")
    new_sha256 = raw.get("new_sha256")
    staged_name = raw.get("staged_name")
    if (
        path_value != expected_path
        or not (old_sha256 is None or isinstance(old_sha256, str))
        or not isinstance(new_sha256, str)
        or not isinstance(staged_name, str)
        or not STAGED_NAME_RE.fullmatch(staged_name)
    ):
        raise RouteSwitchError(f"pending route transaction target {name} is malformed")
    if old_sha256 is not None and not re.fullmatch(r"[0-9a-f]{64}", old_sha256):
        raise RouteSwitchError(
            f"pending route transaction target {name} has an invalid old digest"
        )
    if not re.fullmatch(r"[0-9a-f]{64}", new_sha256):
        raise RouteSwitchError(
            f"pending route transaction target {name} has an invalid new digest"
        )
    return Target(
        name=name,
        path=state_dir / expected_path,
        old_sha256=old_sha256,
        new_sha256=new_sha256,
        staged_name=staged_name,
    )


def _load_pending_transaction(
    pending_path: Path, request: RouteSwitchRequest
) -> list[Target] | None:
    if not _safe_optional_file(pending_path, "pending engine route transaction"):
        return None
    try:
        payload = json.loads(pending_path.read_bytes())
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RouteSwitchError("pending engine route transaction is not valid JSON") from error
    if not isinstance(payload, Mapping):
        raise RouteSwitchError("pending engine route transaction must be a JSON object")
    expected_fields = {
        "schema_version": 1,
        "operation": "engine-route-switch",
        "primary_engine_url": request.primary_engine_url,
        "primary_expected_build_id": request.primary_expected_build_id,
        "primary_health_url": request.primary_health_url,
        "recovery_engine_url": request.recovery_engine_url,
        "recovery_expected_build_id": request.recovery_expected_build_id,
        "recovery_health_url": request.recovery_health_url,
        "active_route": request.active_route,
        "engine_url": request.selected_engine_url,
    }
    for key, expected in expected_fields.items():
        if payload.get(key) != expected:
            raise RouteSwitchError(
                "pending engine route transaction belongs to a different request; "
                "re-run it with the exact original primary/recovery URLs, active "
                "route, candidate build ids, and optional host health URLs"
            )
    order = payload.get("commit_order")
    targets_raw = payload.get("targets")
    if (
        not isinstance(order, list)
        or not order
        or any(item not in {"env", "marker"} for item in order)
        or len(set(order)) != len(order)
        or not isinstance(targets_raw, Mapping)
        or set(targets_raw) != set(order)
    ):
        raise RouteSwitchError("pending engine route transaction has an invalid target order")
    return [_parse_target(name, targets_raw[name], request.state_dir) for name in order]


def _digest_if_present(
    path: Path, label: str, *, exact_mode: int | None = None
) -> str | None:
    if not _safe_optional_file(path, label):
        return None
    if exact_mode is not None:
        _validate_owned_regular_file(path, label, exact_mode=exact_mode)
    return _sha256(path.read_bytes())


def _assert_staged_target(target: Target, state_dir: Path) -> Path:
    staged = state_dir / target.staged_name
    _validate_owned_regular_file(
        staged, f"staged engine route {target.name}", exact_mode=0o600
    )
    if _sha256(staged.read_bytes()) != target.new_sha256:
        raise RouteSwitchError(
            f"staged engine route {target.name} no longer matches the transaction journal"
        )
    return staged


def _replace_target(target: Target, state_dir: Path) -> None:
    staged = _assert_staged_target(target, state_dir)
    os.replace(staged, target.path)
    _fsync_directory(state_dir)


def _target_state(target: Target) -> str:
    actual = _digest_if_present(
        target.path,
        f"engine route {target.name}",
        exact_mode=0o600 if target.name == "env" else None,
    )
    if actual == target.new_sha256:
        return "new"
    if actual == target.old_sha256:
        return "old"
    raise RouteSwitchError(
        f"engine route {target.name} changed outside the pending transaction; "
        "refusing to guess"
    )


def _complete_pending_transaction(
    pending_path: Path, targets: list[Target], state_dir: Path
) -> str:
    states = {target.name: _target_state(target) for target in targets}
    seen_old = False
    for target in targets:
        current = states[target.name]
        if current == "old":
            seen_old = True
            _replace_target(target, state_dir)
            continue
        if seen_old:
            raise RouteSwitchError(
                "pending engine route transaction is out of commit order; refusing to guess"
            )
    for target in targets:
        if _target_state(target) != "new":
            raise RouteSwitchError(
                f"engine route {target.name} did not reach its journaled target"
            )
    _safe_unlink(pending_path, "pending engine route transaction")
    _fsync_directory(state_dir)
    return "resumed" if any(value == "new" for value in states.values()) else "switched"


def _discard_uncommitted_transaction(
    pending_path: Path, targets: list[Target], state_dir: Path
) -> None:
    # This is used only before the first target rename.  It refuses to discard
    # anything if a caller or a crash has already changed a target.
    for target in targets:
        if _target_state(target) != "old":
            raise RouteSwitchError(
                "candidate health changed after route transaction preparation and "
                "a target was already replaced; "
                "re-run the exact request to recover"
            )
    for target in targets:
        _safe_unlink(
            state_dir / target.staged_name, f"staged engine route {target.name}"
        )
    _safe_unlink(pending_path, "pending engine route transaction")
    _fsync_directory(state_dir)


def _prepare_new_transaction(
    request: RouteSwitchRequest,
) -> tuple[Path, list[Target]] | None:
    env_bytes = _read_bytes(request.env_file, "deployment env", exact_mode=0o600)
    current_engine_url = _current_engine_url(env_bytes)
    marker_path = request.state_dir / ROUTE_MARKER_NAME
    marker_bytes, marker_engine_url = _read_marker(marker_path)
    if marker_engine_url is not None and marker_engine_url != current_engine_url:
        raise RouteSwitchError(
            "deployment ENGINE_URL does not match the active engine route marker; "
            "refusing a route switch over inconsistent state"
        )
    selected = request.selected_engine_url
    desired_env = _replace_engine_url(env_bytes, selected)
    desired_marker = _marker_bytes(selected)

    # Retain a compatible marker when it already names the selected route;
    # overwriting unknown future v1 metadata would be an unnecessary mutation.
    marker_needs_change = marker_bytes is None or marker_engine_url != selected
    targets_to_stage: list[tuple[str, Path, bytes | None, bytes]] = []
    if desired_env != env_bytes:
        targets_to_stage.append(("env", request.env_file, env_bytes, desired_env))
    if marker_needs_change:
        targets_to_stage.append(("marker", marker_path, marker_bytes, desired_marker))
    if not targets_to_stage:
        return None

    targets: list[Target] = []
    journal_persisted = False
    try:
        for name, path, old, new in targets_to_stage:
            staged = _write_new_file(request.state_dir, f".{name}.new", new)
            targets.append(
                Target(
                    name=name,
                    path=path,
                    old_sha256=None if old is None else _sha256(old),
                    new_sha256=_sha256(new),
                    staged_name=staged.name,
                )
            )
        _fsync_directory(request.state_dir)
        pending_path = request.state_dir / PENDING_NAME
        if os.path.lexists(pending_path):
            raise RouteSwitchError(
                "pending engine route transaction appeared while preparing"
            )
        journal = _write_new_file(
            request.state_dir,
            ".pending.new",
            _json_bytes(_transaction_payload(request, targets)),
        )
        try:
            os.replace(journal, pending_path)
            journal_persisted = True
            _fsync_directory(request.state_dir)
        finally:
            if os.path.lexists(journal):
                _safe_unlink(journal, "staged engine route transaction journal")
        return pending_path, targets
    except BaseException:
        # No target is renamed until after this function succeeds, so staging
        # files never need to become a recovery obligation when preparation
        # itself fails. Once the journal is durable, however, its staged files
        # are recovery material even if a following directory fsync reports an
        # error; preserve them and let the exact request resume fail closed.
        if not journal_persisted:
            for target in targets:
                try:
                    _safe_unlink(
                        request.state_dir / target.staged_name,
                        f"staged engine route {target.name}",
                    )
                except (OSError, RouteSwitchError):
                    pass
        raise


def _run_preflight(request: RouteSwitchRequest) -> None:
    preflight = Path(__file__).with_name("deployment-env-preflight.py")
    completed = subprocess.run(
        [
            sys.executable,
            str(preflight),
            "--app-dir",
            str(request.app_dir),
            "--state-dir",
            str(request.state_dir),
            "--env-file",
            str(request.env_file),
        ],
        text=True,
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "unknown error"
        raise RouteSwitchError(
            f"deployment environment preflight refused route switch: {detail}"
        )


@contextmanager
def _deployment_lock(path: Path) -> Iterator[None]:
    _reject_symlink_components(path)
    descriptor = os.open(
        path,
        os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0),
        0o600,
    )
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            raise RouteSwitchError(f"deployment lock must be a regular file: {path}")
        if metadata.st_uid != os.geteuid() or stat.S_IMODE(metadata.st_mode) & 0o022:
            raise RouteSwitchError(f"deployment lock is not safely owned: {path}")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RouteSwitchError(
                "another Airfoils.Pro deploy is already running"
            ) from error
        yield
    finally:
        os.close(descriptor)


def switch_engine_route(request: RouteSwitchRequest) -> str:
    for path, label in (
        (request.app_dir, "active application path"),
        (request.state_dir, "engine-route state directory"),
        (request.env_file, "deployment env"),
        (request.lock_file, "deployment lock"),
    ):
        if not path.is_absolute():
            raise RouteSwitchError(f"{label} must be absolute: {path}")
    _validate_state_dir(request.state_dir)
    if request.env_file != request.state_dir / ENV_FILE_NAME:
        raise RouteSwitchError(
            f"deployment env must be the external state file {request.state_dir / ENV_FILE_NAME}"
        )
    if request.active_route not in {"primary", "recovery"}:
        raise RouteSwitchError("active route must be primary or recovery")
    for candidate in (request.primary_candidate, request.recovery_candidate):
        if candidate.engine_url != _canonical_engine_url(
            candidate.engine_url, f"{candidate.name} engine URL"
        ):
            raise RouteSwitchError(
                f"{candidate.name} engine URL must use canonical origin form"
            )
        if candidate.health_url is not None and candidate.health_url != _canonical_health_url(
            candidate.health_url, f"{candidate.name} health URL"
        ):
            raise RouteSwitchError(
                f"{candidate.name} health URL must use canonical /health form"
            )
    if request.primary_engine_url == request.recovery_engine_url:
        raise RouteSwitchError("primary and recovery engine URLs must be distinct")
    for candidate in (request.primary_candidate, request.recovery_candidate):
        if not BUILD_ID_RE.fullmatch(candidate.expected_build_id):
            raise RouteSwitchError(
                f"{candidate.name} expected build id may contain only letters, "
                "digits, dot, underscore, and hyphen"
            )
    if not (0.1 <= request.health_timeout_seconds <= 30):
        raise RouteSwitchError("health timeout seconds must be between 0.1 and 30")

    pending_path = request.state_dir / PENDING_NAME
    pending = _load_pending_transaction(pending_path, request)
    if pending is None:
        _run_preflight(request)

    # The first proof avoids staging a switch toward a bad gateway; the second
    # proof sits immediately before any target rename to narrow the external
    # health/build identity race as far as a stateless HTTP contract permits.
    _validate_candidates(request)
    if pending is not None:
        result = _complete_pending_transaction(pending_path, pending, request.state_dir)
        _run_preflight(request)
        return result

    prepared = _prepare_new_transaction(request)
    if prepared is None:
        _run_preflight(request)
        return "already-active"
    pending_path, targets = prepared
    try:
        _validate_candidates(request)
    except BaseException:
        _discard_uncommitted_transaction(pending_path, targets, request.state_dir)
        raise
    result = _complete_pending_transaction(pending_path, targets, request.state_dir)
    _run_preflight(request)
    return result


def _parse_args(argv: list[str] | None) -> RouteSwitchRequest:
    parser = argparse.ArgumentParser(
        description=(
            "Atomically switch the external production engine route after proving "
            "both primary and recovery gateways are healthy from the node-api "
            "network at their independently declared exact build ids."
        )
    )
    parser.add_argument("--app-dir", type=Path, default=DEFAULT_APP_DIR)
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    parser.add_argument("--env-file", type=Path)
    parser.add_argument("--lock-file", type=Path, default=DEFAULT_LOCK_FILE)
    parser.add_argument("--primary-engine-url", required=True)
    parser.add_argument("--primary-engine-build-id", required=True)
    parser.add_argument(
        "--primary-health-url",
        help="optional host-visible /health proof; never replaces the node-api proof",
    )
    parser.add_argument("--recovery-engine-url", required=True)
    parser.add_argument("--recovery-engine-build-id", required=True)
    parser.add_argument(
        "--recovery-health-url",
        help="optional host-visible /health proof; never replaces the node-api proof",
    )
    parser.add_argument("--active-route", choices=("primary", "recovery"), required=True)
    parser.add_argument("--health-timeout-seconds", type=float, default=5.0)
    args = parser.parse_args(argv)

    state_dir = _absolute(args.state_dir)
    env_file = _absolute(args.env_file) if args.env_file else state_dir / ENV_FILE_NAME
    return RouteSwitchRequest(
        app_dir=_absolute(args.app_dir),
        state_dir=state_dir,
        env_file=env_file,
        lock_file=_absolute(args.lock_file),
        primary_engine_url=_canonical_engine_url(
            args.primary_engine_url, "primary engine URL"
        ),
        primary_expected_build_id=args.primary_engine_build_id,
        primary_health_url=(
            _canonical_health_url(args.primary_health_url, "primary health URL")
            if args.primary_health_url
            else None
        ),
        recovery_engine_url=_canonical_engine_url(
            args.recovery_engine_url, "recovery engine URL"
        ),
        recovery_expected_build_id=args.recovery_engine_build_id,
        recovery_health_url=(
            _canonical_health_url(args.recovery_health_url, "recovery health URL")
            if args.recovery_health_url
            else None
        ),
        active_route=args.active_route,
        health_timeout_seconds=args.health_timeout_seconds,
    )


def main(argv: list[str] | None = None) -> int:
    try:
        request = _parse_args(argv)
        with _deployment_lock(request.lock_file):
            outcome = switch_engine_route(request)
        print(
            f"Engine route {outcome}: active={request.active_route} "
            f"url={request.selected_engine_url} "
            f"primary_build_id={request.primary_expected_build_id} "
            f"recovery_build_id={request.recovery_expected_build_id}"
        )
        return 0
    except (OSError, RouteSwitchError) as error:
        print(f"engine route switch refused: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
