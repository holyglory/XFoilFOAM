from __future__ import annotations

import fcntl
import os
from pathlib import Path
import shutil
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


def _prune_env(tmp_path: Path, deploy_root: Path, **extra: str) -> dict[str, str]:
    fake_bin = tmp_path / "bin"
    docker_log = _fake_docker(fake_bin)
    docker_root = tmp_path / "docker-root"
    docker_root.mkdir()
    deploy_lock = tmp_path / "deploy.lock"
    deploy_lock.touch(mode=0o444, exist_ok=True)
    deploy_lock.chmod(0o444)
    return os.environ | {
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


def _run_prune(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(PRUNE)], env=env, text=True, capture_output=True, timeout=15
    )


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

    env = _prune_env(tmp_path, deploy_root)
    docker_log = Path(env["DOCKER_LOG"])
    completed = _run_prune(env)

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


def test_exclusive_deployment_skips_all_cleanup(tmp_path: Path) -> None:
    deploy_root = tmp_path / "airfoils-pro"
    current = _tree(deploy_root / "releases" / "current", "current")
    stale = _tree(deploy_root / "deploy-staging" / "old", "old")
    _age(stale, hours=48)
    (deploy_root / "app").symlink_to(current)
    deploy_lock = tmp_path / "deploy.lock"

    env = _prune_env(tmp_path, deploy_root, DOCKER_ROOT_DIR="")
    docker_log = Path(env["DOCKER_LOG"])
    with deploy_lock.open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        completed = _run_prune(env)

    assert completed.returncode == 0, completed.stderr
    assert "A deployment is running" in completed.stdout
    assert stale.exists()
    assert not docker_log.exists()


def test_shared_reader_allows_docker_and_defers_all_source_trees(tmp_path: Path) -> None:
    root = tmp_path / "deploy"
    current = _tree(root / "releases" / "current", "live")
    (root / "app").symlink_to(current)
    expired = [
        _tree(root / path, "expired")
        for path in (
            "staging/old", "deploy-staging/old", "incoming/old", "staging-old",
            "releases/.materializing-old", "releases/previous",
        )
    ]
    for path in expired:
        _age(path, hours=96)
    env = _prune_env(tmp_path, root, DEPLOYMENT_RELEASE_KEEP_COUNT="1")
    with Path(env["AIRFOILS_PRO_DEPLOY_LOCK_FILE"]).open("rb") as lock:
        fcntl.flock(lock, fcntl.LOCK_SH | fcntl.LOCK_NB)
        run = _run_prune(env)
        assert run.returncode == 0, run.stderr
        assert "state=deferred removed_trees=0 removed_bytes=0" in run.stdout
        assert "Docker storage cleanup complete" in run.stdout
        assert Path(env["DOCKER_LOG"]).read_text().splitlines() == [
            "image prune --all --force --filter until=72h",
            "builder prune --all --force --keep-storage 10GB",
        ]
        assert all((path / "payload.txt").is_file() for path in expired)

    run = _run_prune(env)
    assert run.returncode == 0, run.stderr
    assert "state=complete removed_trees=6" in run.stdout
    assert all(not path.exists() for path in expired)
    assert (root / "app").resolve() == current


@pytest.mark.parametrize("stage", ["image", "builder", "handoff", "source"])
def test_lock_modes_and_single_cleanup_across_processes(tmp_path: Path, stage: str) -> None:
    root = tmp_path / "deploy"
    stale = _tree(root / "staging" / "old", "expired")
    _age(stale, hours=96)
    env = _prune_env(tmp_path, root)
    # Pause immediately before the selected operation. The flock and find
    # shims forward to the real tools; the competing process uses the same inode.
    if stage == "source":
        command, condition = "find", '[ "${!#}" = "-delete" ]'
    elif stage == "handoff":
        command, condition = "flock", '[ "$1" = "-x" ] && [ "${!#}" = 8 ]'
    else:
        command, condition = "docker", f'[ "$1" = "{stage}" ]'
    real_tool = shutil.which(command, path=env["PATH"])
    assert real_tool
    gate_bin = tmp_path / "gate-bin"
    gate_bin.mkdir()
    shim = gate_bin / command
    shim.write_text(
        f'#!/usr/bin/env bash\nset -eu\nif {condition}; then\n'
        '  touch "$PRUNE_TEST_ENTERED"\n  flock -s -w 12 "$PRUNE_TEST_GATE" true\n'
        'fi\nexec "$PRUNE_TEST_TOOL" "$@"\n'
    )
    shim.chmod(0o755)
    gate = tmp_path / "gate"
    entered = tmp_path / "entered"
    env.update(
        PATH=f"{gate_bin}:{env['PATH']}",
        PRUNE_TEST_GATE=str(gate),
        PRUNE_TEST_ENTERED=str(entered),
        PRUNE_TEST_TOOL=real_tool,
    )
    with gate.open("w") as barrier:
        fcntl.flock(barrier, fcntl.LOCK_EX)
        with subprocess.Popen(
            [str(PRUNE)], env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        ) as first:
            try:
                deadline = time.monotonic() + 8
                while not entered.exists() and time.monotonic() < deadline and first.poll() is None:
                    time.sleep(0.02)
                assert entered.exists(), f"cleanup did not reach {stage}"
                with Path(env["AIRFOILS_PRO_DEPLOY_LOCK_FILE"]).open("rb") as probe:
                    if stage == "handoff":
                        # A real deployment wins the gap after Docker releases its lock.
                        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    else:
                        with pytest.raises(BlockingIOError):
                            fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        if stage == "source":
                            with pytest.raises(BlockingIOError):
                                fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)
                        else:
                            fcntl.flock(probe, fcntl.LOCK_SH | fcntl.LOCK_NB)

                    second = _run_prune(env)
                    assert second.returncode == 0, second.stderr
                    assert "cleanup is already running" in second.stdout
                    fcntl.flock(barrier, fcntl.LOCK_UN)
                    stdout, stderr = first.communicate(timeout=12)
                    assert first.returncode == 0, stderr
            finally:
                fcntl.flock(barrier, fcntl.LOCK_UN)
                if first.poll() is None:
                    first.kill()
    assert len(Path(env["DOCKER_LOG"]).read_text().splitlines()) == 2
    assert stale.exists() == (stage != "source")
    assert f"state={'complete' if stage == 'source' else 'deferred'}" in stdout


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

    env = _prune_env(tmp_path, deploy_root, **{name: value})
    docker_log = Path(env["DOCKER_LOG"])
    completed = _run_prune(env)

    assert completed.returncode == 2
    assert "must be" in completed.stderr
    assert not docker_log.exists()
