from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import subprocess


ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "scripts/deploy/run-three-stage-urans-canary-once.sh"

TARGET = {
    "campaign-id": "c24047fa-743f-4ae5-bcd6-f3071ff79fb4",
    "condition-id": "e2db6c43-2e4a-4b15-b99e-1e2d391543be",
    "expected-campaign-generation": "2",
    "parent-job-id": "28d9ac1c-ad4d-4c60-a34b-f090842eeb54",
    "airfoil-id": "4617c7ad-264e-48bf-926c-b24d33e4d7c0",
    "revision-id": "fba9c1f7-222f-4399-94ae-4f777b1ef868",
    "aoa-deg": "15",
    "source-result-id": "54d62432-8ba2-4fdb-a27b-39f709f00712",
    "source-result-attempt-id": "266cc794-9498-4a77-baf0-0924e44e34fe",
    "precalc-obligation-id": "6515a96c-d80f-4f35-a98d-4a29f30c0d53",
    "expected-engine-build-id": "prod-20260717-8e6d9bd32615-r6",
    "expected-mesh-recovery-version": "2",
    "expected-urans-recovery-version": "2",
}

IDS = {
    "api": "a" * 64,
    "worker": "b" * 64,
    "node-api": "c" * 64,
    "sweeper": "d" * 64,
}


def _write(path: Path, value: str, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    path.chmod(0o755 if executable else 0o644)


FAKE_DOCKER = r'''#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "$*" == "compose version" ]]; then
  printf '%s\n' compose-version >>"$CALL_LOG"
  exit 0
fi

# Strip the stable Compose connection options before decoding the subcommand.
args=("$@")
index=0
[[ "${args[$index]}" == compose ]] && ((index += 1))
while ((index < ${#args[@]})); do
  case "${args[$index]}" in
    --env-file|-p|-f) ((index += 2)) ;;
    *) break ;;
  esac
done
command=("${args[@]:$index}")

service_id() {
  case "$1" in
    api) printf '%s\n' "$FAKE_API_ID" ;;
    worker) printf '%s\n' "$FAKE_WORKER_ID" ;;
    node-api) printf '%s\n' "$FAKE_NODE_API_ID" ;;
    sweeper) printf '%s\n' "$FAKE_SWEEPER_ID" ;;
    *) exit 96 ;;
  esac
}
state_file() {
  case "$1" in
    api) printf '%s\n' "$API_STATE" ;;
    worker) printf '%s\n' "$WORKER_STATE" ;;
    node-api) printf '%s\n' "$NODE_API_STATE" ;;
    sweeper) printf '%s\n' "$SWEEPER_STATE" ;;
    *) exit 96 ;;
  esac
}

if [[ "${command[*]}" == "config --quiet" ]]; then
  printf '%s\n' config-quiet >>"$CALL_LOG"
  exit 0
fi
if [[ "${command[*]}" == "config --services" ]]; then
  printf '%s\n' config-services >>"$CALL_LOG"
  printf '%s\n' api worker node-api sweeper
  exit 0
fi
if [[ "${command[0]:-}" == ps ]]; then
  service="${command[-1]}"
  if [[ "${command[*]}" == "ps --all -q $service" ]]; then
    printf 'ps-all:%s\n' "$service" >>"$CALL_LOG"
    if [[ "$service" == api && "${FAKE_ENGINE_DRIFT:-0}" == 1 && -f "$CLI_EXECUTED" ]]; then
      printf '%064d\n' 0 | tr 0 e
    else
      service_id "$service"
    fi
    exit 0
  fi
  if [[ "${command[*]}" == "ps --status running -q $service" ]]; then
    printf 'ps-running:%s\n' "$service" >>"$CALL_LOG"
    file="$(state_file "$service")"
    if [[ "$(<"$file")" == running || "${FAKE_STOP_VERIFY_RUNNING:-}" == "$service" ]]; then
      service_id "$service"
    fi
    exit 0
  fi
fi
if [[ "${command[0]:-}" == stop ]]; then
  service="${command[1]}"
  printf 'stop:%s\n' "$service" >>"$CALL_LOG"
  if [[ "$service" == api || "$service" == worker ]]; then
    printf 'engine mutation attempted\n' >&2
    exit 95
  fi
  file="$(state_file "$service")"
  printf '%s\n' stopped >"$file"
  exit 0
fi
if [[ "${command[0]:-}" == start ]]; then
  service="${command[1]}"
  printf 'start:%s\n' "$service" >>"$CALL_LOG"
  if [[ "$service" == api || "$service" == worker ]]; then
    printf 'engine mutation attempted\n' >&2
    exit 95
  fi
  file="$(state_file "$service")"
  printf '%s\n' running >"$file"
  exit 0
fi
if [[ "${command[0]:-}" == run ]]; then
  printf '%s\0' "${command[@]}" >>"$CLI_ARGS_LOG"
  printf '%s\n' cli >>"$CALL_LOG"
  : >"$CLI_EXECUTED"
  if [[ "$(<"$NODE_API_STATE")" != stopped || "$(<"$SWEEPER_STATE")" != stopped ]]; then
    printf 'CLI executed while ordinary writers were active\n' >&2
    exit 94
  fi
  if [[ "${FAKE_CLI_FAIL:-0}" == 1 ]]; then
    printf '%s\n' '{"partial":true}'
    exit 41
  fi
  if [[ "${FAKE_BAD_RECEIPT:-0}" == 1 ]]; then
    printf '%s\n' 'not-json'
    exit 0
  fi
  printf '%s\n' "$CANARY_RECEIPT"
  exit 0
fi

printf 'unexpected fake docker invocation: %s\n' "${command[*]}" >&2
exit 97
'''


def _target_args() -> list[str]:
    args: list[str] = []
    for name, value in TARGET.items():
        args.extend((f"--{name}", value))
    return args


def _receipt() -> dict[str, object]:
    return {
        "action": "submitted",
        "stage": "preliminary",
        "campaignId": TARGET["campaign-id"],
        "conditionId": TARGET["condition-id"],
        "parentJobId": TARGET["parent-job-id"],
        "airfoilId": TARGET["airfoil-id"],
        "revisionId": TARGET["revision-id"],
        "aoaDeg": 15,
        "sourceResultId": TARGET["source-result-id"],
        "sourceResultAttemptId": TARGET["source-result-attempt-id"],
        "precalcObligationId": TARGET["precalc-obligation-id"],
        "requestId": "11111111-1111-4111-8111-111111111111",
        "verifyQueueId": None,
        "simJobId": "22222222-2222-4222-8222-222222222222",
        "engineJobId": "engine-canary-1",
        "requestState": "submitted",
        "obligationState": "submitted",
        "verifyState": None,
        "criticalIncidentId": None,
        "criticalIncidentStage": None,
        "criticalIncidentReason": None,
        "criticalRemediationVersion": None,
        "expectedCampaignGeneration": 2,
        "expectedEngineBuildId": TARGET["expected-engine-build-id"],
        "expectedMeshRecoveryVersion": 2,
        "expectedUransRecoveryVersion": 2,
    }


def _fixture(
    tmp_path: Path,
    *,
    node_api_state: str = "running",
    sweeper_state: str = "running",
) -> tuple[dict[str, str], Path, Path]:
    app = tmp_path / "app"
    state = tmp_path / "state"
    fake_bin = tmp_path / "bin"
    calls = tmp_path / "calls.log"
    cli_args = tmp_path / "cli-args.bin"
    cli_executed = tmp_path / "cli-executed"
    state.mkdir()
    fake_bin.mkdir()
    _write(app / "docker-compose.deploy.yml", "services: {}\n")
    _write(
        app / "scripts/deploy/deployment-env-preflight.py",
        "#!/usr/bin/env python3\nraise SystemExit(0)\n",
        executable=True,
    )
    env_file = state / ".env.deploy"
    _write(env_file, "DATABASE_URL=postgres://fixture\n")
    env_file.chmod(0o600)
    _write(fake_bin / "docker", FAKE_DOCKER, executable=True)

    state_files = {
        service: tmp_path / f"{service}.state"
        for service in ("api", "worker", "node-api", "sweeper")
    }
    for service in ("api", "worker"):
        _write(state_files[service], "running\n")
    _write(state_files["node-api"], f"{node_api_state}\n")
    _write(state_files["sweeper"], f"{sweeper_state}\n")

    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "APP_DIR": str(app),
        "AIRFOILS_PRO_STATE_DIR": str(state),
        "ENV_FILE": str(env_file),
        "COMPOSE_FILE": str(app / "docker-compose.deploy.yml"),
        "COMPOSE_PROJECT_NAME": "fixture",
        "LOCK_FILE": str(tmp_path / "deploy.lock"),
        "CALL_LOG": str(calls),
        "CLI_ARGS_LOG": str(cli_args),
        "CLI_EXECUTED": str(cli_executed),
        "CANARY_RECEIPT": json.dumps(_receipt(), separators=(",", ":")),
        "FAKE_API_ID": IDS["api"],
        "FAKE_WORKER_ID": IDS["worker"],
        "FAKE_NODE_API_ID": IDS["node-api"],
        "FAKE_SWEEPER_ID": IDS["sweeper"],
        "API_STATE": str(state_files["api"]),
        "WORKER_STATE": str(state_files["worker"]),
        "NODE_API_STATE": str(state_files["node-api"]),
        "SWEEPER_STATE": str(state_files["sweeper"]),
    }
    return env, calls, cli_args


def _run(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(WRAPPER), *_target_args()],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def _events(calls: Path) -> list[str]:
    return calls.read_text().splitlines() if calls.exists() else []


def _service_state(env: dict[str, str], service: str) -> str:
    return Path(env[f"{service.upper().replace('-', '_')}_STATE"]).read_text().strip()


def test_runs_one_exact_cli_only_after_both_writers_stop_and_restores_them(
    tmp_path: Path,
) -> None:
    env, calls, cli_args = _fixture(tmp_path)
    result = _run(env)
    assert result.returncode == 0, result.stderr
    assert result.stdout.count("\n") == 1
    assert json.loads(result.stdout) == _receipt()

    events = _events(calls)
    assert events.count("cli") == 1
    cli_index = events.index("cli")
    assert events.index("stop:node-api") < cli_index
    assert events.index("stop:sweeper") < cli_index
    assert events.index("start:node-api") > cli_index
    assert events.index("start:sweeper") > cli_index
    assert not any(event in {"stop:api", "start:api", "stop:worker", "start:worker"} for event in events)
    assert _service_state(env, "node-api") == "running"
    assert _service_state(env, "sweeper") == "running"

    invocation = cli_args.read_bytes().split(b"\0")
    assert invocation[-1] == b""
    assert [part.decode() for part in invocation[:-1]] == [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "sweeper",
        "pnpm",
        "--filter",
        "@aerodb/sweeper",
        "urans-canary:admit-once",
        "--",
        *_target_args(),
    ]


def test_cli_failure_restores_prior_states_and_keeps_stdout_empty(tmp_path: Path) -> None:
    env, calls, _ = _fixture(tmp_path)
    env["FAKE_CLI_FAIL"] = "1"
    result = _run(env)
    assert result.returncode == 14
    assert result.stdout == ""
    assert _events(calls).count("cli") == 1
    assert _service_state(env, "node-api") == "running"
    assert _service_state(env, "sweeper") == "running"


def test_stop_verification_failure_never_invokes_cli_and_restores_services(
    tmp_path: Path,
) -> None:
    env, calls, _ = _fixture(tmp_path)
    env["FAKE_STOP_VERIFY_RUNNING"] = "sweeper"
    result = _run(env)
    assert result.returncode == 14
    assert result.stdout == ""
    assert "cli" not in _events(calls)
    assert _service_state(env, "node-api") == "running"
    assert _service_state(env, "sweeper") == "running"


def test_each_service_returns_to_its_independent_prior_state(tmp_path: Path) -> None:
    env, calls, _ = _fixture(tmp_path, node_api_state="stopped", sweeper_state="running")
    result = _run(env)
    assert result.returncode == 0, result.stderr
    assert _events(calls).count("cli") == 1
    assert _service_state(env, "node-api") == "stopped"
    assert _service_state(env, "sweeper") == "running"


def test_versioned_application_symlink_is_a_valid_deployment_root(tmp_path: Path) -> None:
    env, _, _ = _fixture(tmp_path)
    app = Path(env["APP_DIR"])
    release = tmp_path / "releases" / "fixture-release"
    release.parent.mkdir()
    app.rename(release)
    app.symlink_to(release, target_is_directory=True)
    result = _run(env)
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == _receipt()


def test_invalid_receipt_is_refused_after_restoration_without_stdout(tmp_path: Path) -> None:
    env, calls, _ = _fixture(tmp_path)
    env["FAKE_BAD_RECEIPT"] = "1"
    result = _run(env)
    assert result.returncode == 14
    assert result.stdout == ""
    assert _events(calls).count("cli") == 1
    assert _service_state(env, "node-api") == "running"
    assert _service_state(env, "sweeper") == "running"


def test_engine_identity_change_fails_closed_without_mutating_engine_services(
    tmp_path: Path,
) -> None:
    env, calls, _ = _fixture(tmp_path)
    env["FAKE_ENGINE_DRIFT"] = "1"
    result = _run(env)
    assert result.returncode == 18
    assert result.stdout == ""
    events = _events(calls)
    assert events.count("cli") == 1
    assert not any(event in {"stop:api", "start:api", "stop:worker", "start:worker"} for event in events)
    assert _service_state(env, "node-api") == "running"
    assert _service_state(env, "sweeper") == "running"


def test_shared_deploy_lock_refuses_before_any_docker_probe(tmp_path: Path) -> None:
    env, calls, _ = _fixture(tmp_path)
    lock_path = Path(env["LOCK_FILE"])
    with lock_path.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = _run(env)
    assert result.returncode == 9
    assert result.stdout == ""
    assert not calls.exists()
