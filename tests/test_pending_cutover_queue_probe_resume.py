from __future__ import annotations

import fcntl
import hashlib
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]


def test_resume_launcher_preserves_its_historical_reviewed_runner_binding() -> None:
    launcher = (
        ROOT / "scripts" / "deploy" / "resume-pending-opencfd2606-cutover.sh"
    ).read_text()

    assert 'EXPECTED_BOUND_REVISION="63385777be7323777906fde44bdb9fa9b5cc0d6d"' in launcher
    assert 'EXPECTED_NODE_REPAIR_REVISION="26b19c9a6f229d76359095958a3a6d8edac0801f"' in launcher
    assert 'EXPECTED_REBUILD_SHA256="__REBUILD_SHA256__"' not in launcher
    expected_rebuild_sha = next(
        line.split('"', 2)[1]
        for line in launcher.splitlines()
        if line.startswith('EXPECTED_REBUILD_SHA256="')
    )
    current_rebuild_sha = hashlib.sha256(
        (ROOT / "scripts" / "deploy" / "rebuild-engine.sh").read_bytes()
    ).hexdigest()
    assert expected_rebuild_sha == (
        "515e81d52d59d2e4e798daf1bdaf2ff5e51e45cc5c3708d41af20130c2364021"
    )
    assert expected_rebuild_sha != current_rebuild_sha
    assert "pending-cutover-node-api-repair.json" in launcher
    assert "OPENCFD2606_CANARY_ATTESTATION_ID" in launcher
    assert '"$staging_real/scripts/deploy/rebuild-engine.sh" "$BUILD_ID"' in launcher
    assert "exec 9>\"$LOCK_FILE\"" in launcher
    assert "DEPLOY_LOCK_HELD=1" in launcher
    assert launcher.index("flock -n 9") < launcher.index("[[ -L \"$APP_DIR\" ]]")
    assert "docker compose up" not in launcher
    assert "docker compose down" not in launcher


def test_resume_launcher_refuses_contended_lock_before_journal_or_engine(
    tmp_path: Path,
) -> None:
    launcher = ROOT / "scripts" / "deploy" / "resume-pending-opencfd2606-cutover.sh"
    state_dir = tmp_path / "state"
    state_dir.mkdir()
    docker_called = tmp_path / "docker-called"
    fake_bin = tmp_path / "fake-bin"
    fake_bin.mkdir()
    fake_docker = fake_bin / "docker"
    fake_docker.write_text(
        '#!/usr/bin/env bash\ntouch "$DOCKER_CALLED"\nexit 99\n',
        encoding="utf-8",
    )
    fake_docker.chmod(0o755)

    env = dict(os.environ)
    env.update(
        {
            "PATH": f"{fake_bin}:{env['PATH']}",
            "DOCKER_CALLED": str(docker_called),
            "STAGING_DIR": str(tmp_path / "missing-staging"),
            "EXPECTED_TARGET_SOURCE_REVISION": "a" * 40,
            "BUILD_ID": "test-build",
            "APP_DIR": str(tmp_path / "missing-app"),
            "AIRFOILS_PRO_STATE_DIR": str(state_dir),
        }
    )

    lock_path = Path("/tmp/airfoils-pro-deploy.lock")
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        completed = subprocess.run(
            [str(launcher)],
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    assert completed.returncode == 9
    assert "Another Airfoils.Pro deploy is already running." in completed.stderr
    assert not (state_dir / "pending-cutover-queue-probe-resume.json").exists()
    assert not docker_called.exists()
