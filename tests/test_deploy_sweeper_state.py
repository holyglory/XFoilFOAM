from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]


def _write_executable(path: Path, contents: str) -> None:
    path.write_text(contents)
    path.chmod(0o755)


def _deploy_harness(
    tmp_path: Path,
    *,
    sweeper_state: str,
    probe_fails: bool = False,
    queue_active_after: int = 0,
) -> dict[str, str]:
    app_dir = tmp_path / "app"
    fake_bin = tmp_path / "bin"
    app_dir.mkdir()
    fake_bin.mkdir()
    (app_dir / ".env.deploy").write_text(
        "AIRFOILFOAM_BUILD_ID=old-build\nENGINE_EXPECTED_BUILD_ID=old-build\n"
    )
    (app_dir / "docker-compose.deploy.yml").write_text("services: {}\n")

    _write_executable(
        fake_bin / "docker",
        """#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CALL_LOG"
if [[ "${1:-}" == "compose" && "${2:-}" == "version" ]]; then
  exit 0
fi
joined="$*"
if [[ "$joined" == *" ps --status running -q sweeper"* ]]; then
  if [[ "${FAKE_STATE_PROBE_FAIL:-0}" == "1" ]]; then
    exit 42
  fi
  if [[ "$FAKE_SWEEPER_STATE" == "running" ]]; then
    printf 'fake-sweeper-container\n'
  fi
  exit 0
fi
if [[ "$joined" == *" exec -T worker "* ]]; then
  exit 0
fi
if [[ "$joined" == *" config"* ]]; then
  printf 'services: {}\n'
fi
exit 0
""",
    )
    _write_executable(
        fake_bin / "curl",
        """#!/usr/bin/env bash
set -euo pipefail
url="${!#}"
case "$url" in
  *:8000/queue)
    count=0
    if [[ -f "$QUEUE_PROBE_COUNT" ]]; then
      read -r count <"$QUEUE_PROBE_COUNT"
    fi
    count=$((count + 1))
    printf '%s\n' "$count" >"$QUEUE_PROBE_COUNT"
    if (( FAKE_QUEUE_ACTIVE_AFTER > 0 && count >= FAKE_QUEUE_ACTIVE_AFTER )); then
      printf '{"queue_depth":1,"active_count":0,"reserved_count":0,"scheduled_count":0,"job_ids":["arrived-after-stop"]}\n'
    else
      printf '{"queue_depth":0,"active_count":0,"reserved_count":0,"scheduled_count":0,"job_ids":[]}\n'
    fi
    ;;
  *:8000/health)
    printf '{"status":"ok","build_id":"%s"}\n' "$FAKE_BUILD_ID"
    ;;
  *)
    printf '{}\n'
    ;;
esac
""",
    )
    _write_executable(fake_bin / "sleep", "#!/usr/bin/env bash\nexit 0\n")

    env = os.environ.copy()
    env.update(
        {
            "APP_DIR": str(app_dir),
            "ENV_FILE": str(app_dir / ".env.deploy"),
            "COMPOSE_FILE": str(app_dir / "docker-compose.deploy.yml"),
            "LOCK_FILE": str(tmp_path / "deploy.lock"),
            "CALL_LOG": str(tmp_path / "calls.log"),
            "FAKE_BUILD_ID": "test-build",
            "FAKE_SWEEPER_STATE": sweeper_state,
            "FAKE_STATE_PROBE_FAIL": "1" if probe_fails else "0",
            "FAKE_QUEUE_ACTIVE_AFTER": str(queue_active_after),
            "QUEUE_PROBE_COUNT": str(tmp_path / "queue-probe-count"),
            "PATH": f"{fake_bin}:{env['PATH']}",
        }
    )
    return env


@pytest.mark.parametrize(
    ("script", "running_restore"),
    [
        ("vps-redeploy.sh", " up -d --no-deps sweeper"),
        ("rebuild-engine.sh", " up -d --no-deps --force-recreate sweeper"),
    ],
)
@pytest.mark.parametrize("initial_state", ["stopped", "running"])
def test_deploy_scripts_preserve_sweeper_state(
    tmp_path: Path, script: str, running_restore: str, initial_state: str
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state=initial_state)
    command = [str(ROOT / "scripts" / "deploy" / script)]
    if script == "rebuild-engine.sh":
        command.append("test-build")

    completed = subprocess.run(command, env=env, text=True, capture_output=True, check=False)

    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    stopped_restore = " up --no-start --no-deps --force-recreate sweeper"
    if initial_state == "stopped":
        assert any(stopped_restore in call for call in calls)
        assert not any(running_restore in call for call in calls)
        assert "Preserving the intentionally stopped sweeper" in completed.stdout
    else:
        assert any(running_restore in call for call in calls)
        assert not any(stopped_restore in call for call in calls)
        assert "Restoring the previously running sweeper" in completed.stdout


@pytest.mark.parametrize("script", ["vps-redeploy.sh", "rebuild-engine.sh"])
def test_deploy_scripts_fail_closed_when_sweeper_state_is_unknown(tmp_path: Path, script: str) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped", probe_fails=True)
    command = [str(ROOT / "scripts" / "deploy" / script)]
    if script == "rebuild-engine.sh":
        command.append("test-build")

    completed = subprocess.run(command, env=env, text=True, capture_output=True, check=False)

    assert completed.returncode == 12
    assert "Could not determine whether the sweeper is running" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    assert not any(" build " in call for call in calls)


def test_control_plane_deploy_initializes_nested_sync_mountpoint_before_node_api(tmp_path: Path) -> None:
    env = _deploy_harness(tmp_path, sweeper_state="stopped")

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "vps-redeploy.sh")],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    storage_init_index = next(
        index for index, call in enumerate(calls) if " up --no-deps storage-init" in call
    )
    node_api_index = next(
        index for index, call in enumerate(calls) if " up -d --no-deps node-api" in call
    )
    assert storage_init_index < node_api_index
    assert "Initializing the nested sync-imports mountpoint" in completed.stdout


@pytest.mark.parametrize("initial_state", ["stopped", "running"])
def test_engine_rebuild_refusal_restores_exact_prior_sweeper_state(
    tmp_path: Path, initial_state: str
) -> None:
    env = _deploy_harness(tmp_path, sweeper_state=initial_state, queue_active_after=2)

    completed = subprocess.run(
        [str(ROOT / "scripts" / "deploy" / "rebuild-engine.sh"), "test-build"],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )

    assert completed.returncode == 12
    assert "queued/reserved/active engine work exists" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text().splitlines()
    running_restore = " up -d --no-deps sweeper"
    if initial_state == "stopped":
        assert not any(running_restore in call for call in calls)
    else:
        assert any(running_restore in call for call in calls)
    assert not any(" up -d --no-deps --force-recreate api worker node-api" in call for call in calls)
    assert Path(env["ENV_FILE"]).read_text() == (
        "AIRFOILFOAM_BUILD_ID=old-build\nENGINE_EXPECTED_BUILD_ID=old-build\n"
    )
