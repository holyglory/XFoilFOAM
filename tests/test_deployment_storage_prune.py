from __future__ import annotations

import fcntl
import os
from pathlib import Path
import subprocess
import time

import pytest


ROOT = Path(__file__).resolve().parents[1]
PRUNE = ROOT / "scripts" / "deploy" / "airfoils-docker-storage-prune"


def _fake_docker(bin_dir: Path) -> Path:
    bin_dir.mkdir()
    log = bin_dir / "docker.log"
    executable = bin_dir / "docker"
    executable.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$DOCKER_LOG"
case "${1:-} ${2:-}" in
  "image prune"|"builder prune")
    printf 'Total reclaimed space: 0B\n'
    ;;
  *)
    printf 'unexpected fake docker invocation: %s\n' "$*" >&2
    exit 64
    ;;
esac
"""
    )
    executable.chmod(0o755)
    return log


def _tree(path: Path, label: str) -> Path:
    path.mkdir(parents=True)
    (path / "payload.txt").write_text(label)
    return path


def _age(path: Path, *, hours: int) -> None:
    timestamp = time.time() - hours * 60 * 60
    os.utime(path, (timestamp, timestamp))


def _run_prune(tmp_path: Path, deploy_root: Path, **extra: str) -> tuple[subprocess.CompletedProcess[str], Path]:
    fake_bin = tmp_path / "bin"
    docker_log = _fake_docker(fake_bin)
    docker_root = tmp_path / "docker-root"
    docker_root.mkdir()
    deploy_lock = tmp_path / "deploy.lock"
    deploy_lock.touch(mode=0o444, exist_ok=True)
    deploy_lock.chmod(0o444)
    env = os.environ | {
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "DOCKER_LOG": str(docker_log),
        "DOCKER_ROOT_DIR": str(docker_root),
        "DOCKER_PRUNE_LOCK_FILE": str(tmp_path / "cleanup.lock"),
        "AIRFOILS_PRO_DEPLOY_LOCK_FILE": str(deploy_lock),
        "AIRFOILS_PRO_DEPLOY_ROOT": str(deploy_root),
        "AIRFOILS_PRO_APP_DIR": str(deploy_root / "app"),
        "AIRFOILS_PRO_RELEASES_DIR": str(deploy_root / "releases"),
        "DEPLOYMENT_RELEASE_KEEP_COUNT": "3",
        "DEPLOYMENT_STAGING_MAX_AGE_HOURS": "24",
    } | extra
    completed = subprocess.run(
        [str(PRUNE)], env=env, text=True, capture_output=True, check=False
    )
    return completed, docker_log


def test_cleanup_bounds_releases_and_staging_without_touching_live_or_fresh_sources(
    tmp_path: Path,
) -> None:
    deploy_root = tmp_path / "airfoils-pro"
    releases = deploy_root / "releases"
    current = _tree(releases / "current-old", "current")
    newest = _tree(releases / "newest", "newest")
    previous = _tree(releases / "previous", "previous")
    expired = _tree(releases / "expired", "expired")
    partial = _tree(releases / ".materializing-expired", "partial")
    _age(current, hours=120)
    _age(newest, hours=1)
    _age(previous, hours=2)
    _age(expired, hours=3)
    _age(partial, hours=48)
    (deploy_root / "app").symlink_to(current)

    stale_paths = [
        _tree(deploy_root / "deploy-staging" / "old", "old"),
        _tree(deploy_root / "staging" / "old", "old"),
        _tree(deploy_root / "incoming" / "old", "old"),
        _tree(deploy_root / "staging-legacy", "old"),
    ]
    for path in stale_paths:
        _age(path, hours=48)
    fresh = _tree(deploy_root / "deploy-staging" / "fresh", "fresh")
    outside = _tree(tmp_path / "outside", "outside")
    (deploy_root / "staging" / "outside-link").symlink_to(outside)

    completed, docker_log = _run_prune(tmp_path, deploy_root)

    assert completed.returncode == 0, completed.stderr
    assert (deploy_root / "app").resolve() == current
    assert {path.name for path in releases.iterdir()} == {
        current.name,
        newest.name,
        previous.name,
    }
    assert all(not path.exists() for path in stale_paths)
    assert fresh.exists()
    assert outside.exists()
    assert (deploy_root / "staging" / "outside-link").is_symlink()
    commands = docker_log.read_text().splitlines()
    assert commands == [
        "image prune --all --force --filter until=72h",
        "builder prune --all --force --keep-storage 10GB",
    ]
    assert f"docker_root={tmp_path / 'docker-root'}" in completed.stdout
    assert "removed_trees=6" in completed.stdout


def test_cleanup_is_a_noop_while_the_deployment_lock_is_held(tmp_path: Path) -> None:
    deploy_root = tmp_path / "airfoils-pro"
    current = _tree(deploy_root / "releases" / "current", "current")
    stale = _tree(deploy_root / "deploy-staging" / "old", "old")
    _age(stale, hours=48)
    (deploy_root / "app").symlink_to(current)
    deploy_lock = tmp_path / "deploy.lock"

    with deploy_lock.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        completed, docker_log = _run_prune(tmp_path, deploy_root)

    assert completed.returncode == 0, completed.stderr
    assert "A deployment is running" in completed.stdout
    assert stale.exists()
    assert not docker_log.exists()


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("DOCKER_PRUNE_RETENTION_HOURS", "0"),
        ("DOCKER_BUILD_CACHE_KEEP_STORAGE", "all"),
        ("DEPLOYMENT_RELEASE_KEEP_COUNT", "0"),
        ("DEPLOYMENT_STAGING_MAX_AGE_HOURS", "0"),
    ],
)
def test_cleanup_rejects_unbounded_or_malformed_settings(
    tmp_path: Path, name: str, value: str
) -> None:
    deploy_root = tmp_path / "airfoils-pro"
    deploy_root.mkdir()

    completed, docker_log = _run_prune(
        tmp_path, deploy_root, **{name: value}
    )

    assert completed.returncode == 2
    assert "must be" in completed.stderr
    assert not docker_log.exists()
