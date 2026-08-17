from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import textwrap


ROOT = Path(__file__).resolve().parents[1]
SCRIPT_NAME = "recover-production-sweeper-runtime.sh"
SCRIPT = ROOT / "scripts" / "deploy" / SCRIPT_NAME


def _executable(path: Path, contents: str) -> None:
    path.write_text(textwrap.dedent(contents), encoding="utf-8")
    path.chmod(0o755)


def _harness(tmp_path: Path, *, role: str = "hub") -> tuple[dict[str, str], Path, Path]:
    app = tmp_path / "release"
    deploy = app / "scripts" / "deploy"
    state = tmp_path / "state"
    bin_dir = tmp_path / "bin"
    deploy.mkdir(parents=True)
    state.mkdir()
    bin_dir.mkdir()

    shutil.copy2(SCRIPT, deploy / SCRIPT_NAME)
    (deploy / SCRIPT_NAME).chmod(0o755)
    shutil.copy2(
        ROOT / "scripts" / "deploy" / "deployment-compose-profile.sh",
        deploy / "deployment-compose-profile.sh",
    )
    _executable(
        deploy / "deployment-env-preflight.py",
        "#!/usr/bin/env python3\n"
        "import os\n"
        "import sys\n"
        "\n"
        "with open(os.environ['CALL_LOG'], 'a', encoding='utf-8') as stream:\n"
        "    stream.write('preflight ' + ' '.join(sys.argv[1:]) + '\\n')\n"
        "raise SystemExit(int(os.environ.get('FAKE_PREFLIGHT_STATUS', '0')))\n",
    )
    (app / "docker-compose.deploy.yml").write_text("services: {}\n", encoding="utf-8")
    developer_compose = app / "docker-compose.yml"
    developer_compose.write_text("services: {}\n", encoding="utf-8")

    if role == "remote-solver":
        override = state / "docker-compose.remote-solver.yml"
        override.write_text("services: {}\n", encoding="utf-8")
        env_text = (
            "AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver\n"
            "COMPOSE_PROJECT_NAME=hz-solver2\n"
            f"COMPOSE_OVERRIDE_FILE={override}\n"
        )
    else:
        env_text = "AIRFOILFOAM_DEPLOYMENT_ROLE=hub\nCOMPOSE_PROJECT_NAME=app\n"
    env_file = state / ".env.deploy"
    env_file.write_text(env_text, encoding="utf-8")
    env_file.chmod(0o600)

    _executable(
        bin_dir / "docker",
        """#!/usr/bin/env bash
        set -euo pipefail
        joined="$*"
        printf '%s\\n' "$joined" >>"$CALL_LOG"
        if [[ "$joined" == "compose version" ]]; then exit 0; fi
        if [[ "$joined" == *" config --services" ]]; then
          printf 'api\\nworker\\nnode-api\\npostgres\\nsweeper\\n'
          exit 0
        fi
        if [[ "$joined" == *" config --quiet" ]]; then exit 0; fi
        if [[ "$joined" == *" ps --status running -q api" ]]; then
          printf '%064d\\n' 10
          exit 0
        fi
        if [[ "$joined" == *" ps --status running -q worker" ]]; then
          printf '%064d\\n' 11
          exit 0
        fi
        if [[ "$joined" == *" ps --status running -q node-api" ]]; then
          printf '%064d\\n' 12
          exit 0
        fi
        if [[ "$joined" == *" ps --status running -q postgres" ]]; then
          printf '%064d\\n' 13
          exit 0
        fi
        if [[ "$joined" == *" ps --status running -q sweeper" ]]; then
          [[ -f "$SWEEPER_STARTED" && "${FAKE_SWEEPER_RUNNING:-1}" == "1" ]] && printf '%064d\\n' 14
          exit 0
        fi
        if [[ "$joined" == *" exec -T node-api node -e "* ]]; then
          printf '%s' "$API_DATABASE_FINGERPRINT"
          exit 0
        fi
        if [[ "$joined" == *" run --rm --no-deps -T sweeper node -e "* ]]; then
          printf '%s' "$SWEEPER_DATABASE_FINGERPRINT"
          exit 0
        fi
        if [[ "$joined" == *" exec -T postgres psql "* ]]; then
          if [[ -f "$SWEEPER_STARTED" ]]; then printf '200\\n'; else printf '100\\n'; fi
          exit 0
        fi
        if [[ "$joined" == *" up -d --no-deps --force-recreate sweeper" ]]; then
          : >"$SWEEPER_STARTED"
          exit 0
        fi
        printf 'unexpected docker command: %s\\n' "$joined" >&2
        exit 99
        """,
    )
    _executable(bin_dir / "sleep", "#!/usr/bin/env bash\nexit 0\n")

    env = os.environ.copy()
    env.update(
        {
            "APP_DIR": str(app),
            "AIRFOILS_PRO_STATE_DIR": str(state),
            "ENV_FILE": str(env_file),
            "COMPOSE_FILE": str(app / "docker-compose.deploy.yml"),
            "LOCK_FILE": str(tmp_path / "deploy.lock"),
            "CALL_LOG": str(tmp_path / "calls.log"),
            "SWEEPER_STARTED": str(tmp_path / "sweeper-started"),
            "API_DATABASE_FINGERPRINT": "a" * 64,
            "SWEEPER_DATABASE_FINGERPRINT": "a" * 64,
            "PATH": f"{bin_dir}:{env['PATH']}",
            "TICK_TIMEOUT_SECONDS": "2",
            "TICK_POLL_SECONDS": "1",
        }
    )
    return env, developer_compose, state


def _run(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [str(Path(env["APP_DIR"]) / "scripts" / "deploy" / SCRIPT_NAME)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_scheduler_recovery_starts_a_stopped_hub_runtime_with_only_the_deployment_profile(
    tmp_path: Path,
) -> None:
    env, developer_compose, _ = _harness(tmp_path)

    completed = _run(env)

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "Sweeper completed a reconciliation tick" in completed.stdout
    calls = Path(env["CALL_LOG"]).read_text(encoding="utf-8").splitlines()
    assert f"preflight --app-dir {env['APP_DIR']}" in calls[0]
    assert f"--state-dir {env['AIRFOILS_PRO_STATE_DIR']}" in calls[0]
    assert f"--env-file {env['ENV_FILE']}" in calls[0]
    compose_calls = [call for call in calls if call.startswith("compose --env-file")]
    assert compose_calls
    deployment_compose = str(Path(env["APP_DIR"]) / "docker-compose.deploy.yml")
    assert all(f" -p app -f {deployment_compose} " in f" {call} " for call in compose_calls)
    assert all(str(developer_compose) not in call for call in calls)
    assert any(" run --rm --no-deps -T sweeper node -e " in call for call in calls)
    assert not any(" exec -T sweeper node -e " in call for call in calls)
    starts = [call for call in calls if " up -d --no-deps --force-recreate " in call]
    assert starts == [
        f"compose --env-file {env['ENV_FILE']} -p app -f {deployment_compose} up -d --no-deps --force-recreate sweeper"
    ]
    assert all(not any(service in call for service in (" api", " worker")) for call in starts)
    assert sum(" ps --status running -q api" in call for call in calls) == 2
    assert sum(" ps --status running -q worker" in call for call in calls) == 2


def test_scheduler_recovery_preserves_the_remote_solver_override(tmp_path: Path) -> None:
    env, _, state = _harness(tmp_path, role="remote-solver")

    completed = _run(env)

    assert completed.returncode == 0, completed.stdout + completed.stderr
    calls = Path(env["CALL_LOG"]).read_text(encoding="utf-8").splitlines()
    deployment_compose = str(Path(env["APP_DIR"]) / "docker-compose.deploy.yml")
    override = state / "docker-compose.remote-solver.yml"
    starts = [call for call in calls if " up -d --no-deps --force-recreate " in call]
    assert starts == [
        "compose "
        f"--env-file {env['ENV_FILE']} -p hz-solver2 -f {deployment_compose} -f {override} "
        "up -d --no-deps --force-recreate sweeper"
    ]


def test_scheduler_recovery_refuses_a_developer_compose_file_before_docker(tmp_path: Path) -> None:
    env, developer_compose, _ = _harness(tmp_path)
    env["COMPOSE_FILE"] = str(developer_compose)

    completed = _run(env)

    assert completed.returncode == 2
    assert "requires the deployment Compose file" in completed.stderr
    assert not Path(env["CALL_LOG"]).exists()


def test_scheduler_recovery_refuses_database_endpoint_drift_before_start(tmp_path: Path) -> None:
    env, _, _ = _harness(tmp_path)
    env["SWEEPER_DATABASE_FINGERPRINT"] = "b" * 64

    completed = _run(env)

    assert completed.returncode == 14
    assert "database endpoints differ" in completed.stderr
    calls = Path(env["CALL_LOG"]).read_text(encoding="utf-8").splitlines()
    assert not any(" up -d --no-deps --force-recreate " in call for call in calls)
