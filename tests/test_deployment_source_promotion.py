from __future__ import annotations

import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
MANIFEST_TOOL = ROOT / "scripts" / "deploy" / "deployment-source-manifest.py"
PROMOTION_SCRIPT = ROOT / "scripts" / "deploy" / "promote-and-redeploy.sh"
REVISION = "a" * 40
RECOVERY_FIELDS = (
    "OPENCFD2606_CUTOVER_PENDING",
    "OPENCFD2606_CUTOVER_COMPLETE",
    "OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING",
    "OPENCFD2606_CANARY_ATTESTATION_ID",
    "OPENCFD2606_CANARY_RECEIPT_EXPECTED",
    "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256",
    "OPENCFD2606_CUTOVER_SOURCE_REVISION",
    "OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256",
)


def _recovery_env(*, pending: str = "0") -> str:
    sweeper = "1" if pending == "1" else ""
    source_revision = "a" * 40 if pending == "1" else ""
    source_tree = "b" * 64 if pending == "1" else ""
    return (
        f"OPENCFD2606_CUTOVER_PENDING={pending}\n"
        "OPENCFD2606_CUTOVER_COMPLETE=0\n"
        f"OPENCFD2606_CUTOVER_SWEEPER_WAS_RUNNING={sweeper}\n"
        "OPENCFD2606_CANARY_ATTESTATION_ID=\n"
        "OPENCFD2606_CANARY_RECEIPT_EXPECTED=0\n"
        "OPENCFD2606_CERTIFIED_EVIDENCE_CONTRACT_SHA256=\n"
        f"OPENCFD2606_CUTOVER_SOURCE_REVISION={source_revision}\n"
        f"OPENCFD2606_CUTOVER_SOURCE_TREE_SHA256={source_tree}\n"
    )


def _write_legacy_env(app: Path, contents: str) -> Path:
    path = app / ".env.deploy"
    path.write_text(contents)
    path.chmod(0o600)
    return path


def _run_manifest(
    root: Path, operation: str, *, revision: str | None = None
) -> subprocess.CompletedProcess[str]:
    command = [
        sys.executable,
        str(MANIFEST_TOOL),
        operation,
        "--root",
        str(root),
        "--manifest",
        str(root / ".deployment-source.json"),
    ]
    if revision is not None:
        command.extend(["--revision", revision])
    return subprocess.run(command, text=True, capture_output=True, check=False)


def _staged_payload(root: Path, log: Path) -> None:
    deploy = root / "scripts" / "deploy"
    deploy.mkdir(parents=True)
    shutil.copy2(MANIFEST_TOOL, deploy / MANIFEST_TOOL.name)
    shutil.copy2(
        ROOT / "scripts" / "deploy" / "source-rsync-excludes.txt",
        deploy / "source-rsync-excludes.txt",
    )
    for name in (
        "atomic-release-switch.py",
        "bootstrap-opencfd-env.py",
        "deployment-env-preflight.py",
        "fsync-release.py",
        "opencfd2606_cutover_state.py",
        "remote-solver2606-cutover-state.py",
        "deployment-compose-profile.sh",
    ):
        shutil.copy2(ROOT / "scripts" / "deploy" / name, deploy / name)
    vps_script = deploy / "vps-redeploy.sh"
    vps_script.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
[[ "${DEPLOY_LOCK_HELD:-}" == "1" ]]
[[ "$(readlink -f "/proc/$$/fd/9")" == "$(readlink -f "$LOCK_FILE")" ]]
flock -n 9
[[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]]
[[ "$(stat -c '%a' "$ENV_FILE")" == "600" ]]
grep -Fx 'OPENCFD2606_CUTOVER_PENDING=0' "$ENV_FILE" >/dev/null
printf '%s\\t%s\\t%s\\n' \
  "$DEPLOY_SOURCE_REVISION" "$DEPLOY_SOURCE_TREE_SHA256" "$APP_DIR" \
  >"$PROMOTION_LOG"
"""
    )
    vps_script.chmod(0o755)
    (root / "payload.txt").write_text("sealed payload\n")
    created = _run_manifest(root, "--create", revision=REVISION)
    assert created.returncode == 0, created.stderr


def _fake_rsync(bin_dir: Path) -> None:
    bin_dir.mkdir()
    script = bin_dir / "rsync"
    script.write_text(
        """#!/usr/bin/env python3
from pathlib import Path
import os
import shutil
import sys

source = Path(sys.argv[-2].rstrip("/"))
destination = Path(sys.argv[-1].rstrip("/"))
destination.mkdir(parents=True, exist_ok=True)
preserved = {".env", ".env.deploy", ".env.local", ".git", ".github", ".ssh"}
for child in destination.iterdir():
    if child.name in preserved:
        continue
    if child.is_dir() and not child.is_symlink():
        shutil.rmtree(child)
    else:
        child.unlink()
for child in source.iterdir():
    if child.name in preserved:
        continue
    target = destination / child.name
    if child.is_dir() and not child.is_symlink():
        shutil.copytree(child, target, symlinks=True)
    elif child.is_symlink():
        target.symlink_to(child.readlink())
    else:
        shutil.copy2(child, target)
    if os.environ.get("FAKE_RSYNC_FAIL_AFTER_FIRST") == "1":
        raise SystemExit(47)
"""
    )
    script.chmod(0o755)


def _run_guarded_promotion_with_env(
    tmp_path: Path, env_contents: str
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    stage = tmp_path / "deploy-staging" / "guarded"
    app = tmp_path / "app"
    stage.mkdir(parents=True)
    app.mkdir()
    _staged_payload(stage, tmp_path / "promotion.log")
    _write_legacy_env(app, "SECRET=live\n" + env_contents)
    sentinel = app / "sentinel"
    sentinel.write_text("live\n")
    fake_bin = tmp_path / "bin"
    _fake_rsync(fake_bin)
    env = os.environ | {
        "STAGING_DIR": str(stage),
        "APP_DIR": str(app),
        "LOCK_FILE": str(tmp_path / "deploy.lock"),
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
    }
    completed = subprocess.run(
        [str(PROMOTION_SCRIPT)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )
    return completed, app, sentinel


@pytest.mark.parametrize("duplicate_key", RECOVERY_FIELDS)
def test_promotion_rejects_every_duplicate_recovery_field_before_materialization(
    tmp_path: Path, duplicate_key: str
) -> None:
    recovery = _recovery_env()
    value = next(
        line.split("=", 1)[1]
        for line in recovery.splitlines()
        if line.split("=", 1)[0] == duplicate_key
    )
    completed, app, sentinel = _run_guarded_promotion_with_env(
        tmp_path, recovery + f"{duplicate_key}={value}\n"
    )

    assert completed.returncode == 14
    assert "duplicate field" in completed.stderr
    assert sentinel.read_text() == "live\n"
    assert not app.is_symlink()
    assert not (tmp_path / "releases").exists()


@pytest.mark.parametrize("missing_key", RECOVERY_FIELDS)
def test_promotion_rejects_every_missing_recovery_field_before_materialization(
    tmp_path: Path, missing_key: str
) -> None:
    recovery = "\n".join(
        line
        for line in _recovery_env().splitlines()
        if line.split("=", 1)[0] != missing_key
    ) + "\n"
    completed, app, sentinel = _run_guarded_promotion_with_env(tmp_path, recovery)

    assert completed.returncode == 14
    assert "missing required field" in completed.stderr
    assert sentinel.read_text() == "live\n"
    assert not app.is_symlink()
    assert not (tmp_path / "releases").exists()


def test_promotion_rejects_semantically_impossible_terminal_tuple_before_materialization(
    tmp_path: Path,
) -> None:
    recovery = _recovery_env().replace(
        "OPENCFD2606_CUTOVER_COMPLETE=0",
        "OPENCFD2606_CUTOVER_COMPLETE=1",
    )
    completed, app, sentinel = _run_guarded_promotion_with_env(tmp_path, recovery)

    assert completed.returncode == 14
    assert "terminal certified state requires" in completed.stderr
    assert sentinel.read_text() == "live\n"
    assert not app.is_symlink()
    assert not (tmp_path / "releases").exists()


def test_manifest_binds_deployed_files_and_ignores_runtime_paths(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    (source / "app.txt").write_text("version one\n")
    executable = source / "run.sh"
    executable.write_text("#!/bin/sh\n")
    executable.chmod(0o755)
    (source / ".env.deploy").write_text("SECRET=one\n")
    (source / ".github").mkdir()
    (source / ".github" / "workflow.yml").write_text("ignored\n")

    created = _run_manifest(source, "--create", revision=REVISION)
    assert created.returncode == 0, created.stderr
    revision, tree_sha, file_count = created.stdout.strip().split("\t")
    assert revision == REVISION
    assert len(tree_sha) == 64
    assert int(file_count) == 2

    (source / ".env.deploy").write_text("SECRET=rotated\n")
    (source / ".github" / "workflow.yml").write_text("still ignored\n")
    verified = _run_manifest(source, "--verify")
    assert verified.returncode == 0, verified.stderr

    (source / "app.txt").write_text("tampered\n")
    rejected = _run_manifest(source, "--verify")
    assert rejected.returncode == 2
    assert "does not match its manifest" in rejected.stderr


def test_promotion_holds_shared_lock_preserves_env_and_verifies_exact_source(
    tmp_path: Path,
) -> None:
    stage = tmp_path / "deploy-staging" / "run-1"
    app = tmp_path / "app"
    log = tmp_path / "promotion.log"
    stage.mkdir(parents=True)
    app.mkdir()
    _staged_payload(stage, log)
    fake_bin = tmp_path / "bin"
    _fake_rsync(fake_bin)
    live_env = app / ".env.deploy"
    live_env.write_text("PERSISTED_SECRET=keep-me\n")
    live_env.chmod(0o600)
    (app / "stale-source.txt").write_text("must be deleted\n")

    env = os.environ.copy()
    env.update(
        {
            "STAGING_DIR": str(stage),
            "APP_DIR": str(app),
            "LOCK_FILE": str(tmp_path / "deploy.lock"),
            "EXPECTED_SOURCE_REVISION": REVISION,
            "PROMOTION_LOG": str(log),
            "PATH": f"{fake_bin}:{env['PATH']}",
        }
    )
    completed = subprocess.run(
        [str(PROMOTION_SCRIPT)], env=env, text=True, capture_output=True, check=False
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    shared_env = tmp_path / "state" / ".env.deploy"
    shared_text = shared_env.read_text()
    assert shared_text.startswith("PERSISTED_SECRET=keep-me\n")
    assert "OPENCFD2606_CUTOVER_PENDING=0\n" in shared_text
    assert "OPENCFD2606_CUTOVER_COMPLETE=0\n" in shared_text
    assert "OPENCFD2606_CANARY_RECEIPT_EXPECTED=0\n" in shared_text
    assert shared_env.stat().st_mode & 0o777 == 0o600
    assert app.is_symlink()
    assert not (app / "stale-source.txt").exists()
    assert (app / "payload.txt").read_text() == "sealed payload\n"
    manifest = json.loads((app / ".deployment-source.json").read_text())
    logged_revision, logged_hash, logged_app = log.read_text().strip().split("\t")
    assert logged_revision == manifest["sourceRevision"] == REVISION
    assert logged_hash == manifest["sourceTreeSha256"]
    assert logged_app == str(app)
    legacy_releases = list((tmp_path / "releases").glob("legacy-pre-versioned-*"))
    assert len(legacy_releases) == 1
    assert (legacy_releases[0] / ".env.deploy").is_symlink()
    assert (legacy_releases[0] / ".env.deploy").resolve() == shared_env


def test_promotion_rejects_wrong_revision_before_mutating_application(tmp_path: Path) -> None:
    stage = tmp_path / "deploy-staging" / "run-2"
    app = tmp_path / "app"
    stage.mkdir(parents=True)
    app.mkdir()
    _staged_payload(stage, tmp_path / "unused.log")
    sentinel = app / "sentinel.txt"
    sentinel.write_text("untouched\n")

    env = os.environ.copy()
    env.update(
        {
            "STAGING_DIR": str(stage),
            "APP_DIR": str(app),
            "LOCK_FILE": str(tmp_path / "deploy.lock"),
            "EXPECTED_SOURCE_REVISION": "b" * 40,
        }
    )
    completed = subprocess.run(
        [str(PROMOTION_SCRIPT)], env=env, text=True, capture_output=True, check=False
    )

    assert completed.returncode == 2
    assert "revision mismatch" in completed.stderr
    assert sentinel.read_text() == "untouched\n"


def test_promotion_uses_the_same_exclusive_lock_as_direct_deploys(tmp_path: Path) -> None:
    stage = tmp_path / "deploy-staging" / "run-3"
    app = tmp_path / "app"
    stage.mkdir(parents=True)
    app.mkdir()
    _staged_payload(stage, tmp_path / "unused.log")
    sentinel = app / "sentinel.txt"
    sentinel.write_text("untouched\n")
    lock_path = tmp_path / "deploy.lock"

    env = os.environ.copy()
    env.update(
        {
            "STAGING_DIR": str(stage),
            "APP_DIR": str(app),
            "LOCK_FILE": str(lock_path),
            "EXPECTED_SOURCE_REVISION": REVISION,
        }
    )
    with lock_path.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        completed = subprocess.run(
            [str(PROMOTION_SCRIPT)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    assert completed.returncode == 9
    assert "already running" in completed.stderr
    assert sentinel.read_text() == "untouched\n"


def test_control_plane_compose_validation_does_not_persist_expanded_secrets() -> None:
    script = (ROOT / "scripts" / "deploy" / "vps-redeploy.sh").read_text()
    assert "compose config >/dev/null" in script
    assert "/tmp/airfoils-pro-compose-config.yml" not in script


def test_promotion_refuses_pending_cutover_before_materializing_release(
    tmp_path: Path,
) -> None:
    stage = tmp_path / "deploy-staging" / "pending"
    app = tmp_path / "app"
    stage.mkdir(parents=True)
    app.mkdir()
    _staged_payload(stage, tmp_path / "unused.log")
    _write_legacy_env(app, "SECRET=live\n" + _recovery_env(pending="1"))
    sentinel = app / "sentinel"
    sentinel.write_text("live\n")
    fake_bin = tmp_path / "bin"
    _fake_rsync(fake_bin)
    env = os.environ | {
        "STAGING_DIR": str(stage),
        "APP_DIR": str(app),
        "LOCK_FILE": str(tmp_path / "deploy.lock"),
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
    }

    completed = subprocess.run(
        [str(PROMOTION_SCRIPT)], env=env, text=True, capture_output=True, check=False
    )

    assert completed.returncode == 14
    assert "recovery is pending" in completed.stderr
    assert not app.is_symlink()
    assert sentinel.read_text() == "live\n"
    releases = tmp_path / "releases"
    assert not releases.exists() or not any(releases.iterdir())


def test_interrupted_materialization_never_switches_and_retry_succeeds(
    tmp_path: Path,
) -> None:
    stage = tmp_path / "deploy-staging" / "interrupted"
    app = tmp_path / "app"
    log = tmp_path / "promotion.log"
    stage.mkdir(parents=True)
    app.mkdir()
    _staged_payload(stage, log)
    _write_legacy_env(app, "SECRET=legacy\n")
    sentinel = app / "sentinel"
    sentinel.write_text("live\n")
    fake_bin = tmp_path / "bin"
    _fake_rsync(fake_bin)
    env = os.environ | {
        "STAGING_DIR": str(stage),
        "APP_DIR": str(app),
        "LOCK_FILE": str(tmp_path / "deploy.lock"),
        "PROMOTION_LOG": str(log),
        "FAKE_RSYNC_FAIL_AFTER_FIRST": "1",
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
    }

    failed = subprocess.run(
        [str(PROMOTION_SCRIPT)], env=env, text=True, capture_output=True, check=False
    )
    assert failed.returncode == 47
    assert not app.is_symlink()
    assert sentinel.read_text() == "live\n"
    assert not [path for path in (tmp_path / "releases").iterdir() if not path.name.startswith(".")]
    shared = tmp_path / "state" / ".env.deploy"
    assert "OPENCFD2606_CUTOVER_PENDING=0\n" in shared.read_text()

    env.pop("FAKE_RSYNC_FAIL_AFTER_FIRST")
    retried = subprocess.run(
        [str(PROMOTION_SCRIPT)], env=env, text=True, capture_output=True, check=False
    )
    assert retried.returncode == 0, retried.stdout + retried.stderr
    assert app.is_symlink()
    assert (app / ".env.deploy").is_symlink()
    assert (app / ".env.deploy").resolve() == shared


def test_release_durability_failure_prevents_atomic_switch(tmp_path: Path) -> None:
    stage = tmp_path / "deploy-staging" / "durability"
    app = tmp_path / "app"
    stage.mkdir(parents=True)
    app.mkdir()
    _staged_payload(stage, tmp_path / "unused.log")
    failing_fsync = stage / "scripts" / "deploy" / "fsync-release.py"
    failing_fsync.write_text("#!/usr/bin/env python3\nraise SystemExit(55)\n")
    failing_fsync.chmod(0o755)
    assert _run_manifest(stage, "--create", revision=REVISION).returncode == 0
    _write_legacy_env(app, "SECRET=legacy\n")
    sentinel = app / "sentinel"
    sentinel.write_text("live\n")
    fake_bin = tmp_path / "bin"
    _fake_rsync(fake_bin)
    env = os.environ | {
        "STAGING_DIR": str(stage),
        "APP_DIR": str(app),
        "LOCK_FILE": str(tmp_path / "deploy.lock"),
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
    }

    completed = subprocess.run(
        [str(PROMOTION_SCRIPT)], env=env, text=True, capture_output=True, check=False
    )
    assert completed.returncode == 55
    assert not app.is_symlink()
    assert sentinel.read_text() == "live\n"


def test_existing_release_cannot_self_attest_with_poisoned_verifier(
    tmp_path: Path,
) -> None:
    stage = tmp_path / "deploy-staging" / "poison"
    app = tmp_path / "app"
    log = tmp_path / "promotion.log"
    stage.mkdir(parents=True)
    app.mkdir()
    _staged_payload(stage, log)
    _write_legacy_env(app, "SECRET=legacy\n")
    fake_bin = tmp_path / "bin"
    _fake_rsync(fake_bin)
    env = os.environ | {
        "STAGING_DIR": str(stage),
        "APP_DIR": str(app),
        "LOCK_FILE": str(tmp_path / "deploy.lock"),
        "PROMOTION_LOG": str(log),
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
    }
    first = subprocess.run(
        [str(PROMOTION_SCRIPT)], env=env, text=True, capture_output=True, check=False
    )
    assert first.returncode == 0, first.stdout + first.stderr
    poisoned = app / "scripts" / "deploy" / "deployment-source-manifest.py"
    poisoned.write_text("#!/bin/sh\nprintf 'forged\\n'\n")
    poisoned.chmod(0o755)

    second = subprocess.run(
        [str(PROMOTION_SCRIPT)], env=env, text=True, capture_output=True, check=False
    )
    assert second.returncode == 2
    assert "does not match its manifest" in second.stderr


def test_workflow_requires_operator_pinned_known_hosts_without_tofu() -> None:
    workflow = (ROOT / ".github" / "workflows" / "deploy-airfoils-pro.yml").read_text()
    assert "AIRFOILS_VPS_KNOWN_HOSTS" in workflow
    assert "ssh-keygen -F" in workflow
    assert "chmod 600 ~/.ssh/known_hosts" in workflow
    assert "ssh-keyscan" not in workflow


def test_first_atomic_switch_has_final_legacy_path_even_if_post_exchange_fsync_fails(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    tool = ROOT / "scripts" / "deploy" / "atomic-release-switch.py"
    spec = importlib.util.spec_from_file_location("atomic_release_switch", tool)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = tmp_path / "app"
    release = tmp_path / "releases" / "new"
    legacy = tmp_path / "releases" / "legacy"
    app.mkdir()
    (app / "sentinel").write_text("old\n")
    release.mkdir(parents=True)
    monkeypatch.setattr(
        module,
        "_fsync_directory",
        lambda _path: (_ for _ in ()).throw(OSError("injected fsync failure")),
    )
    monkeypatch.setattr(
        sys,
        "argv",
        [
            str(tool),
            "--app",
            str(app),
            "--release",
            str(release),
            "--legacy-destination",
            str(legacy),
        ],
    )

    with pytest.raises(OSError, match="injected fsync failure"):
        module.main()

    assert app.is_symlink()
    assert app.resolve() == release
    assert legacy.is_dir() and not legacy.is_symlink()
    assert (legacy / "sentinel").read_text() == "old\n"
    assert not list(tmp_path.glob(".app-link.*"))
