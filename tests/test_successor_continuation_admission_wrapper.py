from __future__ import annotations

import fcntl
import json
import os
from pathlib import Path
import subprocess

import pytest


ROOT = Path(__file__).resolve().parents[1]
WRAPPER = ROOT / "scripts/deploy/admit-opencfd2606-successor-once.sh"
CAMPAIGN_ID = "c24047fa-743f-4ae5-bcd6-f3071ff79fb4"
ATTESTATION_ID = "112f52cd-eb8b-4908-bc79-6353daea6e12"
PLAN_ID = "2b65ecc9-318d-4e48-85d1-2fee221a0e01"
POOL_ID = "3f8bc764-09ae-4ff3-8fd2-260600000001"
JOB_ID = "47ba789e-e630-4df5-a8af-f52bb91737f8"
AIRFOIL_ID = "2a965fd4-a85f-4434-833e-7b208423f705"


def _write(path: Path, value: str, *, executable: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(value)
    path.chmod(0o755 if executable else 0o644)


FAKE_DOCKER = r"""#!/usr/bin/env bash
set -Eeuo pipefail
if [[ "$*" == "compose version" ]]; then
  exit 0
fi
for arg in "$@"; do
  if [[ "$arg" == *"find apps/sweeper/src packages"* ]]; then
    printf '%s\n' 'docker:digest:dash' >>"$CALL_LOG"
    if [[ "${FAKE_IMAGE_SOURCE_MISMATCH:-0}" == "1" ]]; then
      printf '%064d\n' 0 | tr 0 c
    else
      dash -c "$arg" _ "$APP_DIR"
    fi
    exit 0
  fi
done
if [[ " $* " == *" ps --status running -q sweeper "* ]]; then
  printf '%s\n' 'docker:ps-sweeper' >>"$CALL_LOG"
  exit 0
fi
if [[ " $* " == *" ps --status running -q node-api "* ]]; then
  printf '%s\n' 'docker:ps-node-api' >>"$CALL_LOG"
  if [[ "$(cat "$NODE_API_STATE")" == "running" ]]; then
    printf '%s\n' 'node-api-container'
  fi
  exit 0
fi
if [[ " $* " == *" stop sweeper "* ]]; then
  printf '%s\n' 'docker:stop-sweeper' >>"$CALL_LOG"
  exit 0
fi
if [[ " $* " == *" stop node-api "* ]]; then
  printf '%s\n' 'docker:stop-node-api' >>"$CALL_LOG"
  printf '%s\n' 'stopped' >"$NODE_API_STATE"
  if [[ "${FAKE_NODE_API_STOP_FAIL_AFTER_STOP:-0}" == "1" ]]; then
    exit 48
  fi
  exit 0
fi
if [[ " $* " == *" start node-api "* ]]; then
  printf '%s\n' 'docker:start-node-api' >>"$CALL_LOG"
  printf '%s\n' 'running' >"$NODE_API_STATE"
  exit 0
fi
if [[ " $* " == *" exec -T postgres "* ]]; then
  printf '%s\n' 'docker:postgres-close' >>"$CALL_LOG"
  if [[ "${FAKE_POSTGRES_FAIL:-0}" == "1" ]]; then
    exit 47
  fi
  if [[ "${FAKE_POSTGRES_BAD_READBACK:-0}" == "1" ]]; then
    printf '%s\n' '1|0'
  else
    printf '%s\n' '1|1'
  fi
  exit 0
fi
if [[ "$*" == *"successor-continuation-once-cli.ts"* ]]; then
  printf '%s\n' 'docker:one-shot-cli' >>"$CALL_LOG"
  plan="$TARGET_PLAN_REVISION_ID"
  if [[ "${FAKE_MODE:-success}" == "receipt-mismatch" ]]; then
    plan='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  fi
  printf '{"status":"submitted","campaignId":"%s","jobId":"%s","engineJobId":"engine-successor-1","solverRuntimeBuildId":null,"attestedSolverRuntimeBuildId":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb","runtimeAcknowledgement":"pending","targetGeneration":%s,"targetPlanRevisionId":"%s","airfoilId":"%s","conditionCount":3,"angleCount":26}\n' \
    "$CAMPAIGN_ID" "$JOB_ID" "$TARGET_GENERATION" "$plan" "$AIRFOIL_ID"
  exit 0
fi
printf 'unexpected fake docker invocation: %s\n' "$*" >&2
exit 97
"""


FAKE_CURL = r"""#!/usr/bin/env bash
set -Eeuo pipefail
method=GET body='' url=''
while (($#)); do
  case "$1" in
    -X) method="$2"; shift 2 ;;
    -d) body="$2"; shift 2 ;;
    http://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "$url" == */health ]]; then
  exit 0
fi
printf 'curl:%s:%s:%s\n' "$method" "$url" "$body" >>"$CALL_LOG"
if [[ "$url" == */continuation ]]; then
  campaign="$CAMPAIGN_ID"
  if [[ "${FAKE_MODE:-success}" == "continuation-mismatch" ]]; then
    campaign='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  fi
  printf '{"status":"pending","lastError":null,"requiredCampaigns":1,"campaigns":[{"campaignId":"%s","status":"pending","simJobId":null,"evidenceResultId":null,"lastError":null}]}\n' "$campaign"
else
  printf '{}\n'
fi
"""


def _fixture(tmp_path: Path) -> tuple[dict[str, str], Path]:
    app = tmp_path / "app"
    state = tmp_path / "state"
    fake_bin = tmp_path / "bin"
    calls = tmp_path / "calls.log"
    node_api_state = tmp_path / "node-api.state"
    state.mkdir()
    fake_bin.mkdir()
    _write(node_api_state, "running\n")

    _write(app / "apps/sweeper/src/base.ts", "export const base = true;\n")
    _write(app / "packages/example/src/index.ts", "export const value = 1;\n")
    for relative in (
        "package.json",
        "pnpm-workspace.yaml",
        "pnpm-lock.yaml",
        "tsconfig.base.json",
        "apps/sweeper/package.json",
    ):
        _write(app / relative, "{}\n")
    _write(app / "docker-compose.deploy.yml", "services: {}\n")
    _write(app / ".deployment-source.json", "{}\n")
    _write(
        app / "scripts/deploy/deployment-source-manifest.py",
        "#!/usr/bin/env python3\nprint('" + "a" * 40 + "\\t" + "b" * 64 + "\\t9')\n",
        executable=True,
    )
    _write(
        app / "scripts/deploy/opencfd2606_cutover_state.py",
        "#!/usr/bin/env python3\n"
        "import os,sys\n"
        "with open(os.environ['CALL_LOG'], 'a') as stream:\n"
        "    stream.write('state:' + ' '.join(sys.argv[1:]) + '\\n')\n",
        executable=True,
    )
    _write(
        app / "scripts/deploy/deployment-env-preflight.py",
        "#!/usr/bin/env python3\nraise SystemExit(0)\n",
        executable=True,
    )
    env_file = state / ".env.deploy"
    _write(env_file, "DATABASE_URL=postgres://fixture\n")
    env_file.chmod(0o600)
    _write(fake_bin / "docker", FAKE_DOCKER, executable=True)
    _write(fake_bin / "curl", FAKE_CURL, executable=True)

    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "APP_DIR": str(app),
        "AIRFOILS_PRO_STATE_DIR": str(state),
        "ENV_FILE": str(env_file),
        "LOCK_FILE": str(tmp_path / "deploy.lock"),
        "ADMIN_COOKIE": "aero_admin=fixture.fixture",
        "CAMPAIGN_ID": CAMPAIGN_ID,
        "CANARY_ATTESTATION_ID": ATTESTATION_ID,
        "TARGET_PLAN_REVISION_ID": PLAN_ID,
        "TARGET_GENERATION": "2",
        "JOB_ID": JOB_ID,
        "AIRFOIL_ID": AIRFOIL_ID,
        "CALL_LOG": str(calls),
        "NODE_API_STATE": str(node_api_state),
    }
    return env, calls


def _run(env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["bash", str(WRAPPER)],
        env=env,
        text=True,
        capture_output=True,
        check=False,
    )


def test_admits_exactly_one_job_and_leaves_both_scheduler_fences_explicit(
    tmp_path: Path,
) -> None:
    env, calls = _fixture(tmp_path)
    result = _run(env)
    assert result.returncode == 0, result.stderr
    receipt = json.loads(result.stdout)
    assert receipt["campaignId"] == CAMPAIGN_ID
    assert receipt["targetPlanRevisionId"] == PLAN_ID
    assert receipt["solverRuntimeBuildId"] is None
    assert receipt["runtimeAcknowledgement"] == "pending"
    events = calls.read_text().splitlines()
    assert any(
        "--require-state pending-certifiable" in event
        and f"--current-source-revision {'a' * 40}" in event
        and f"--current-source-tree-sha256 {'b' * 64}" in event
        for event in events
    )
    assert events.count("docker:one-shot-cli") == 1
    assert events.count("docker:digest:dash") == 1
    assert events.count("docker:ps-sweeper") == 2
    assert events.count("docker:ps-node-api") == 2
    assert events.count("docker:stop-node-api") == 1
    assert events.count("docker:start-node-api") == 1
    assert events.count("docker:postgres-close") == 1
    assert any(
        event.endswith('/api/admin/sweeper:{"enabled":false}') for event in events
    )
    assert any(
        f"solver-execution-pools/{POOL_ID}" in event
        and event.endswith('{"enabled":true}')
        for event in events
    )


@pytest.mark.parametrize("mode", ["continuation-mismatch", "receipt-mismatch"])
def test_any_post_enable_mismatch_stops_sweeper_and_disables_target_pool(
    tmp_path: Path, mode: str
) -> None:
    env, calls = _fixture(tmp_path)
    env["FAKE_MODE"] = mode
    result = _run(env)
    assert result.returncode != 0
    events = calls.read_text().splitlines()
    assert "docker:stop-sweeper" in events
    assert "docker:postgres-close" in events
    assert any(
        event.endswith('/api/admin/sweeper:{"enabled":false}') for event in events
    )
    if mode == "continuation-mismatch":
        assert "docker:one-shot-cli" not in events
        assert "docker:stop-node-api" not in events
    else:
        assert events.count("docker:one-shot-cli") == 1
        assert "docker:stop-node-api" in events
        assert "docker:start-node-api" in events


def test_image_source_drift_refuses_before_any_admission_mutation(
    tmp_path: Path,
) -> None:
    env, calls = _fixture(tmp_path)
    env["FAKE_IMAGE_SOURCE_MISMATCH"] = "1"
    result = _run(env)
    assert result.returncode == 14
    assert "exact sealed pending-attested scheduler source" in result.stderr
    events = calls.read_text().splitlines()
    assert events == ["docker:digest:dash"]


def test_partial_node_api_stop_failure_restores_the_exact_container(
    tmp_path: Path,
) -> None:
    env, calls = _fixture(tmp_path)
    env["FAKE_NODE_API_STOP_FAIL_AFTER_STOP"] = "1"
    result = _run(env)
    assert result.returncode == 14
    assert "could not be stopped cleanly" in result.stderr
    events = calls.read_text().splitlines()
    assert events.count("docker:stop-node-api") == 1
    assert events.count("docker:start-node-api") == 1
    assert Path(env["NODE_API_STATE"]).read_text().strip() == "running"
    assert "docker:one-shot-cli" not in events


def test_deploy_lock_is_held_before_source_or_container_preflight(
    tmp_path: Path,
) -> None:
    env, calls = _fixture(tmp_path)
    lock_path = Path(env["LOCK_FILE"])
    with lock_path.open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        result = _run(env)
    assert result.returncode == 9
    assert not calls.exists()


@pytest.mark.parametrize("failure", ["command", "readback"])
def test_postgres_closure_failure_is_a_distinct_critical_exit(
    tmp_path: Path,
    failure: str,
) -> None:
    env, calls = _fixture(tmp_path)
    env["FAKE_MODE"] = "continuation-mismatch"
    env[
        "FAKE_POSTGRES_FAIL" if failure == "command" else "FAKE_POSTGRES_BAD_READBACK"
    ] = "1"
    result = _run(env)
    assert result.returncode == 18
    events = calls.read_text().splitlines()
    assert "docker:postgres-close" in events
    assert "CRITICAL: successor admission failed" in result.stderr
