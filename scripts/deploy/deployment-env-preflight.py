#!/usr/bin/env python3
"""Validate the authoritative production deployment environment file."""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import sys
from typing import Any
from urllib.parse import urlsplit


REMOTE_EVIDENCE_KEYS = {
    "AIRFOILFOAM_EVIDENCE_BUCKET",
    "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY",
    "AIRFOILFOAM_CONTROL_PLANE_TOKEN",
}
DEPLOYMENT_PROFILE_KEYS = {
    "AIRFOILFOAM_DEPLOYMENT_ROLE",
    "COMPOSE_PROJECT_NAME",
    "COMPOSE_OVERRIDE_FILE",
    "AIRFOILFOAM_EVIDENCE_BUCKET",
    "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX",
    "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL",
    "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY",
    "AIRFOILFOAM_CONTROL_PLANE_TOKEN",
    "AIRFOILFOAM_WORKER_CPU_BUDGET",
    "AIRFOILFOAM_CASE_CONCURRENCY",
    "AIRFOILFOAM_CELERY_CONCURRENCY",
    "ENGINE_URL",
}


def _valid_control_plane_token(token: str) -> bool:
    return (
        len(token) >= 32
        and token[:1] not in {"'", '"'}
        and token[-1:] not in {"'", '"'}
        and not any(character.isspace() for character in token)
    )


def _read_remote_evidence_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not raw_line or raw_line.lstrip().startswith("#") or "=" not in raw_line:
            continue
        key, value = raw_line.split("=", 1)
        if key not in REMOTE_EVIDENCE_KEYS:
            continue
        if key in values:
            raise ValueError(
                f"deployment env line {line_number} duplicates {key}"
            )
        if value != value.strip():
            raise ValueError(
                f"deployment env line {line_number} gives {key} surrounding whitespace"
            )
        values[key] = value
    return values


def _read_profile_values(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    for line_number, raw_line in enumerate(
        path.read_text(encoding="utf-8").splitlines(), start=1
    ):
        if not raw_line or raw_line.lstrip().startswith("#") or "=" not in raw_line:
            continue
        key, value = raw_line.split("=", 1)
        if key not in DEPLOYMENT_PROFILE_KEYS:
            continue
        if key in values:
            raise ValueError(f"deployment env line {line_number} duplicates {key}")
        if value != value.strip():
            raise ValueError(
                f"deployment env line {line_number} gives {key} surrounding whitespace"
            )
        values[key] = value
    return values


def _validate_remote_evidence_auth(path: Path) -> None:
    values = _read_remote_evidence_values(path)
    bucket = values.get("AIRFOILFOAM_EVIDENCE_BUCKET", "")
    remote_only = values.get("AIRFOILFOAM_EVIDENCE_REMOTE_ONLY", "").lower()
    if not bucket or remote_only not in {"1", "true", "yes", "on"}:
        return
    token = values.get("AIRFOILFOAM_CONTROL_PLANE_TOKEN", "")
    if not _valid_control_plane_token(token):
        raise ValueError(
            "remote-only GCS evidence requires an unquoted, whitespace-free "
            "AIRFOILFOAM_CONTROL_PLANE_TOKEN of at least 32 characters"
        )


def _validate_regular_owned_file(path: Path, label: str) -> None:
    _reject_symlink_components(path)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{label} must be a non-symlink regular file")
    if metadata.st_uid != os.geteuid():
        raise ValueError(f"{label} must be owned by the deploying user")
    if stat.S_IMODE(metadata.st_mode) & 0o022:
        raise ValueError(f"{label} must not be group/world writable")


def _require_regular_compose_file(path: Path, label: str) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as exc:
        raise ValueError(f"{label} is missing") from exc
    if stat.S_ISLNK(metadata.st_mode) or not stat.S_ISREG(metadata.st_mode):
        raise ValueError(f"{label} must be a regular non-symlink file")


def _compose_environment(value: object, label: str) -> dict[str, str]:
    if isinstance(value, dict):
        return {
            str(key): "" if item is None else str(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        result: dict[str, str] = {}
        for item in value:
            if not isinstance(item, str) or "=" not in item:
                raise ValueError(f"{label}.environment contains an invalid entry")
            key, item_value = item.split("=", 1)
            result[key] = item_value
        return result
    raise ValueError(f"{label}.environment must be an object or KEY=VALUE list")


def _compose_api_mounts(value: object) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("merged remote-solver api.volumes must be a list")
    mounts: list[dict[str, Any]] = []
    for mount in value:
        if not isinstance(mount, dict):
            raise ValueError("merged remote-solver api.volumes must use long syntax")
        mounts.append(mount)
    return mounts


def _read_merged_remote_compose(
    *, app: Path, env_file: Path, override: Path, project: str
) -> dict[str, Any]:
    """Read the exact Compose profile that will mount the remote API.

    This uses Docker Compose's resolved JSON rather than recreating its merge,
    interpolation, project-name, or volume-name rules in the preflight.  It is
    a read-only command: no containers, volumes, images, or network state are
    created by ``config``.
    """

    try:
        release = app.resolve(strict=True)
    except OSError as exc:
        raise ValueError("deployment application directory cannot be resolved") from exc
    base = release / "docker-compose.deploy.yml"
    _require_regular_compose_file(base, "deployment Compose file")
    _require_regular_compose_file(override, "remote-solver Compose override")
    command = [
        "docker",
        "compose",
        "--env-file",
        str(env_file),
        "--project-name",
        project,
        "--file",
        str(base),
        "--file",
        str(override),
        "config",
        "--format",
        "json",
    ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(
            "remote-solver stage verification requires Docker Compose JSON configuration"
        ) from exc
    if completed.returncode != 0:
        raise ValueError(
            "remote-solver Compose configuration could not be resolved for stage verification"
        )
    try:
        parsed = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise ValueError(
            "remote-solver Compose configuration did not produce JSON"
        ) from exc
    if not isinstance(parsed, dict):
        raise ValueError("remote-solver Compose configuration must be an object")
    return parsed


def _configured_results_volume_mountpoint(
    *, app: Path, env_file: Path, override: Path, project: str
) -> Path:
    """Find the API's real Docker-volume mountpoint without naming it by guess."""

    config = _read_merged_remote_compose(
        app=app, env_file=env_file, override=override, project=project
    )
    if config.get("name") != project:
        raise ValueError("resolved remote-solver Compose project name is not authoritative")
    services = config.get("services")
    if not isinstance(services, dict) or not isinstance(services.get("api"), dict):
        raise ValueError("resolved remote-solver Compose profile has no api service")
    api = services["api"]
    environment = _compose_environment(api.get("environment", {}), "api")
    data_dir_raw = environment.get("AIRFOILFOAM_DATA_DIR", "")
    data_dir = Path(data_dir_raw)
    if not data_dir_raw or not data_dir.is_absolute():
        raise ValueError("resolved remote-solver api data directory must be absolute")
    mounts = _compose_api_mounts(api.get("volumes", []))
    result_mounts = [
        mount
        for mount in mounts
        if mount.get("type") == "volume" and mount.get("target") == str(data_dir)
    ]
    if len(result_mounts) != 1 or not isinstance(result_mounts[0].get("source"), str):
        raise ValueError(
            "resolved remote-solver api must mount exactly one named results volume at its data directory"
        )
    volumes = config.get("volumes")
    if not isinstance(volumes, dict):
        raise ValueError("resolved remote-solver Compose profile has no volumes")
    logical_volume = result_mounts[0]["source"]
    definition = volumes.get(logical_volume)
    if not isinstance(definition, dict):
        raise ValueError("resolved remote-solver results volume definition is missing")
    volume_name = definition.get("name")
    if not isinstance(volume_name, str) or not volume_name:
        raise ValueError(
            "resolved remote-solver results volume has no Docker-assigned name"
        )
    try:
        inspected = subprocess.run(
            ["docker", "volume", "inspect", "--format", "{{ .Mountpoint }}", volume_name],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ValueError(
            "remote-solver results-volume inspection is required for stage verification"
        ) from exc
    mountpoint_raw = inspected.stdout.strip()
    if inspected.returncode != 0 or not mountpoint_raw or "\n" in mountpoint_raw:
        raise ValueError(
            "remote-solver results-volume inspection did not return one mountpoint"
        )
    mountpoint = Path(mountpoint_raw)
    try:
        metadata = mountpoint.stat()
    except OSError as exc:
        raise ValueError(
            "remote-solver results-volume mountpoint cannot be inspected"
        ) from exc
    if not stat.S_ISDIR(metadata.st_mode):
        raise ValueError("remote-solver results-volume mountpoint is not a directory")
    return mountpoint


def _validate_deployment_profile(path: Path, state: Path, app: Path) -> None:
    values = _read_profile_values(path)
    role = values.get("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub")
    if role == "hub":
        project = values.get("COMPOSE_PROJECT_NAME", "app")
        if project != "app" or values.get("COMPOSE_OVERRIDE_FILE", ""):
            raise ValueError(
                "hub deployment requires COMPOSE_PROJECT_NAME=app and no Compose override"
            )
        return
    if role != "remote-solver":
        raise ValueError("AIRFOILFOAM_DEPLOYMENT_ROLE must be hub or remote-solver")

    if values.get("COMPOSE_PROJECT_NAME") != "hz-solver2":
        raise ValueError(
            "remote-solver deployment requires COMPOSE_PROJECT_NAME=hz-solver2"
        )
    expected_override = state / "docker-compose.remote-solver.yml"
    override_raw = values.get("COMPOSE_OVERRIDE_FILE", "")
    if not override_raw or Path(override_raw) != expected_override:
        raise ValueError(
            "remote-solver deployment requires the external state Compose override "
            f"{expected_override}"
        )
    _validate_regular_owned_file(expected_override, "remote-solver Compose override")

    if values.get("AIRFOILFOAM_EVIDENCE_BUCKET", ""):
        raise ValueError("remote-solver volume evidence must not configure a GCS bucket")
    if values.get("AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX") != "solver-evidence/v1":
        raise ValueError(
            "remote-solver volume evidence requires object prefix solver-evidence/v1"
        )
    if values.get("AIRFOILFOAM_EVIDENCE_REMOTE_ONLY", "").lower() not in {
        "false",
        "0",
        "no",
        "off",
    }:
        raise ValueError("remote-solver volume evidence requires explicit remote-only=false")
    if values.get("AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL") != "10":
        raise ValueError("remote-solver volume evidence requires Zstandard level 10")
    if not _valid_control_plane_token(
        values.get("AIRFOILFOAM_CONTROL_PLANE_TOKEN", "")
    ):
        raise ValueError(
            "remote-solver deployment requires an unquoted, whitespace-free "
            "AIRFOILFOAM_CONTROL_PLANE_TOKEN of at least 32 characters"
        )
    for key in (
        "AIRFOILFOAM_WORKER_CPU_BUDGET",
        "AIRFOILFOAM_CASE_CONCURRENCY",
        "AIRFOILFOAM_CELERY_CONCURRENCY",
    ):
        if values.get(key) != "40":
            raise ValueError(f"remote-solver deployment requires {key}=40")


def _validate_engine_route(path: Path, state: Path) -> None:
    """Fence control-plane deploys to the explicitly active engine gateway."""
    marker = state / "engine-route.json"
    # ``Path.exists`` hides a dangling symlink. A missing marker is tolerated
    # only for the one-time pre-marker migration; a dangling or substituted
    # marker is route state tampering and must fail closed.
    if not os.path.lexists(marker):
        return
    _validate_regular_owned_file(marker, "engine route marker")
    payload = json.loads(marker.read_text(encoding="utf-8"))
    if not isinstance(payload, dict) or payload.get("schema_version") != 1:
        raise ValueError("engine route marker must use schema_version 1")
    expected = payload.get("engine_url")
    if not isinstance(expected, str) or expected != expected.strip():
        raise ValueError("engine route marker must contain one exact engine_url")
    parsed = urlsplit(expected)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ValueError("engine route marker engine_url must be an HTTP(S) URL")
    actual = _read_profile_values(path).get("ENGINE_URL", "")
    if actual != expected:
        raise ValueError(
            "deployment ENGINE_URL does not match the active engine route marker: "
            f"expected {expected}, found {actual or '<unset>'}"
        )


def _validate_no_pending_engine_route_switch(state: Path) -> None:
    """Fail closed if a two-file route transaction did not finish.

    ``switch-engine-route.py`` journals before replacing either the external
    env or the active-route marker. A process loss between those durable
    renames must never let a later control-plane deploy guess which gateway is
    authoritative. The switch helper is the only supported recovery path.
    """
    pending = state / ".engine-route-switch.pending.json"
    if not os.path.lexists(pending):
        return
    _validate_regular_owned_file(pending, "pending engine route transaction")
    raise ValueError(
        "engine route switch is incomplete; re-run scripts/deploy/switch-engine-route.sh "
        "with the exact original candidate URLs, active route, and candidate build ids"
    )


def _reject_symlink_components(path: Path) -> None:
    current = Path(path.anchor)
    for component in path.parts[1:]:
        current /= component
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(metadata.st_mode):
            raise ValueError(
                "unsafe OpenCFD v2606 recovery path: "
                f"state path contains symbolic-link component: {current}"
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-dir", required=True, type=Path)
    parser.add_argument("--state-dir", required=True, type=Path)
    parser.add_argument("--env-file", required=True, type=Path)
    args = parser.parse_args()

    app = args.app_dir.absolute()
    state = args.state_dir.absolute()
    env = args.env_file.absolute()
    if not state.is_absolute() or not env.is_absolute():
        raise ValueError("deployment state and environment paths must be absolute")
    _reject_symlink_components(state)
    state_target = state / ".env.deploy"
    metadata = env.lstat()
    if stat.S_ISREG(metadata.st_mode):
        # One-time pre-versioned migration accepts the live regular env inside
        # a real APP_DIR. Once APP_DIR is a release symlink, only the external
        # shared state file (or an exact symlink to it) is authoritative.
        if app.is_symlink() and env != state_target:
            raise ValueError("versioned deployment uses a non-authoritative env file")
    else:
        raise ValueError("deployment env must be a non-symlink regular file")
    if stat.S_IMODE(metadata.st_mode) != 0o600:
        raise ValueError("deployment env must have exact mode 0600")
    if metadata.st_uid != os.geteuid():
        raise ValueError("deployment env must be owned by the deploying user")
    _validate_remote_evidence_auth(env)
    _validate_deployment_profile(env, state, app)
    _validate_no_pending_engine_route_switch(state)
    _validate_engine_route(env, state)
    print(env.resolve(strict=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"deployment environment error: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
