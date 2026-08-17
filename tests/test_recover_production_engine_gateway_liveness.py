from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "deploy" / "recover-production-engine-gateway-liveness.sh"
TOKEN = "11111111-1111-4111-8111-111111111111"
REVISION = "a" * 40
TREE_SHA = "b" * 64
CANDIDATE_DIGEST = "c" * 64
JOB_ID = "11111111-2222-4333-8444-555555555555"
ENGINE_JOB_ID = "f6bc7a18428e4a32a3d73c4123eca78f"
STATUS_SHA = "d" * 64
RESULT_SHA = "e" * 64


def _executable(path: Path, contents: str) -> None:
    path.write_text(textwrap.dedent(contents))
    path.chmod(0o755)


def _snapshot(*, active: bool = False, coverage: bool = False, unacked: bool = False) -> dict[str, object]:
    workers = {"celery@worker-one": []}
    snapshot: dict[str, object] = {
        "active": workers,
        "reserved": workers,
        "scheduled": workers if not coverage else {},
        "active_queues": {"celery@worker-one": [{"name": "openfoam-opencfd-2606"}]},
        "queue_depths": {"openfoam-opencfd-2606": 0},
        "transport_unacked_counts": {"unacked": 1 if unacked else 0, "unacked_index": 0},
    }
    if active:
        snapshot["active"] = {"celery@worker-one": [{"id": "task-1"}]}
    return snapshot


def _fresh_queue(*, failure: str = "") -> dict[str, object]:
    return {
        "queue_observation_state": "stale" if failure == "fresh-queue" else "fresh",
        "queue_observed_at": "2026-08-02T00:00:00+00:00",
        "queue_observation_error": None,
        "active_count": 0,
        "reserved_count": 0,
        "scheduled_count": 0,
        "queue_depth": 0,
        "queue_depths": {"openfoam-opencfd-2606": 0},
        "worker_queues_error": None,
        "worker_runtime_error": None,
        "inspection_errors": {},
        "worker_queues": [{"worker": "celery@worker-one", "queues": ["openfoam-opencfd-2606"]}],
        "inspection_workers": {
            "active": ["celery@worker-one"],
            "reserved": ["celery@worker-one"],
            "scheduled": ["celery@worker-one"],
        },
    }


def _harness(tmp_path: Path, *, failure: str = "") -> tuple[dict[str, str], Path]:
    app = tmp_path / "release"
    deploy = app / "scripts" / "deploy"
    state = tmp_path / "state"
    bin_dir = tmp_path / "bin"
    deploy.mkdir(parents=True)
    state.mkdir()
    bin_dir.mkdir()
    shutil.copy2(SCRIPT, deploy / SCRIPT.name)
    (deploy / SCRIPT.name).chmod(0o755)
    (deploy / "deployment-env-preflight.py").write_text("# dispatched by fake python\n")
    (deploy / "deployment-source-manifest.py").write_text("# dispatched by fake python\n")
    (deploy / "deployment-compose-profile.sh").write_text(
        "configure_deployment_compose_profile() {\n"
        "  DEPLOYMENT_ROLE=hub\n"
        "  COMPOSE_PROJECT_NAME=gateway-liveness-test\n"
        "  COMPOSE_FILE_ARGS=()\n"
        "}\n"
    )
    (app / "docker-compose.deploy.yml").write_text("services: {}\n")
    (app / ".deployment-source.json").write_text("{}\n")
    (state / ".env.deploy").write_text(
        "AIRFOILFOAM_BUILD_ID=test-build\nENGINE_EXPECTED_BUILD_ID=test-build\n"
    )
    receipt = {
        "schemaVersion": 1,
        "maintenanceToken": TOKEN,
        "affectedRuntime": {
            "build_id": "b7d9213f59f2c1c19b8890b1500b81cf168d83aa",
            "engine_version": "2606",
            "urans_recovery_version": 12,
            "archive_reduction_version": 4,
            "queue_observation_version": 1,
        },
        "authoritativeObservedAt": "2026-08-02T00:00:00+00:00",
        "candidateDigest": CANDIDATE_DIGEST,
        "candidates": [{
            "jobId": JOB_ID,
            "engineJobId": ENGINE_JOB_ID,
            "databaseStatus": "ingesting",
            "engineStatus": "completed",
            "engineMessage": None,
            "settlementAction": "ingest",
            "statusSha256": STATUS_SHA,
            "resultSha256": RESULT_SHA,
        }],
    }
    runtime_failure_fields = {
        "runtime-build": ("build_id", "wrong-build"),
        "runtime-engine": ("engine_version", "2406"),
        "runtime-urans": ("urans_recovery_version", 11),
        "runtime-archive": ("archive_reduction_version", 3),
        "runtime-queue": ("queue_observation_version", 0),
        "runtime-queue-bool": ("queue_observation_version", True),
        "runtime-queue-float": ("queue_observation_version", 1.0),
        "runtime-queue-string": ("queue_observation_version", "1"),
    }
    if failure in runtime_failure_fields:
        field, bad_value = runtime_failure_fields[failure]
        receipt["affectedRuntime"][field] = bad_value
    receipt_path = state / "production-legacy-gateway-reconciliation.json"
    receipt_path.write_text(json.dumps(receipt, sort_keys=True) + "\n")
    receipt_path.chmod(0o600)
    receipt_sha = hashlib.sha256(receipt_path.read_bytes()).hexdigest()
    active_rows = [{
        "id": JOB_ID,
        # This is the one narrowly approved receipt retry rollback shape.
        "status": "running",
        "engine_state": "completed",
        "engine_job_id": ENGINE_JOB_ID,
        "ingested_at": None,
        "ingest_lease_live": False,
    }]
    if failure == "outside-job":
        active_rows.append({
            "id": "99999999-2222-4333-8444-555555555555",
            "status": "running",
            "engine_state": "completed",
            "engine_job_id": "a" * 32,
            "ingested_at": None,
            "ingest_lease_live": False,
        })
    if failure == "bad-rollback":
        active_rows[0]["ingested_at"] = "2026-08-02T00:00:00+00:00"
    evidence = {
        ENGINE_JOB_ID: {
            "statusSha256": "f" * 64 if failure == "evidence" else STATUS_SHA,
            "resultSha256": RESULT_SHA,
            "statusJobId": ENGINE_JOB_ID,
            "statusState": "completed",
            "statusPhase": "completed",
            "statusCpuHeld": 0,
            "statusCpuWaiting": 0,
        }
    }
    if failure == "active":
        direct = _snapshot(active=True)
    elif failure == "coverage":
        direct = _snapshot(coverage=True)
    elif failure == "unacked":
        direct = _snapshot(unacked=True)
    else:
        direct = _snapshot()

    _executable(
        bin_dir / "docker",
        r'''#!/usr/bin/env bash
        set -euo pipefail
        joined="$*"
        printf '%s\n' "$joined" >>"$CALL_LOG"
        if [[ "$joined" == "compose version" ]]; then exit 0; fi
        if [[ "${1:-}" == "inspect" ]]; then
          case "${2:-}" in
            api-test|worker-test) printf '["AIRFOILFOAM_BUILD_ID=test-build"]\n' ;;
            node-api-test) printf '["ENGINE_EXPECTED_BUILD_ID=test-build"]\n' ;;
            *) exit 99 ;;
          esac
          exit 0
        fi
        if [[ "$joined" == *" config --services"* ]]; then
          printf 'api\nworker\nsweeper\nmedia-repair\npostgres\nnode-api\n'; exit 0
        fi
        for pair in "api:api-test" "node-api:node-api-test" "postgres:postgres-test" "worker:worker-test"; do
          service="${pair%%:*}"; ident="${pair#*:}"
          if [[ "$joined" == *" ps --status running -q $service"* ]]; then
            [[ "$FAKE_FAILURE" == no-worker && "$service" == worker ]] || printf '%s\n' "$ident"
            exit 0
          fi
        done
        if [[ "$joined" == *" ps --status running -q sweeper"* || "$joined" == *" ps --status running -q media-repair"* ]]; then
          [[ "$FAKE_FAILURE" == writer ]] && printf 'writer-test\n'
          exit 0
        fi
        if [[ "${1:-}" == exec && "$joined" == *"postgres-test psql"* ]]; then
          if [[ "$joined" == *"FROM sweeper_state"* ]]; then
            printf '{"enabled":false,"admission_fence_active":false,"maintenance_drain_token":"%s","maintenance_drain_started_at":"2026-08-02T00:00:00+00:00"}\n' "$MAINTENANCE_TOKEN"
          elif [[ "$joined" == *"FROM sim_jobs"* ]]; then
            printf '%s\n' "$ACTIVE_ROWS"
          else
            exit 99
          fi
          exit 0
        fi
        if [[ "${1:-}" == exec && "$joined" == *"worker-test hostname"* ]]; then printf 'worker-one\n'; exit 0; fi
        if [[ "$joined" == *" exec -T worker sh -lc "* ]]; then
          [[ "$FAKE_FAILURE" == openfoam ]] && printf '42 pimpleFoam\n'
          exit 0
        fi
        if [[ "$joined" == *"AIRFOILS_PRO_GATEWAY_LIVENESS_RECEIPT_EVIDENCE_PROBE"* ]]; then printf '%s\n' "$EVIDENCE_JSON"; exit 0; fi
        if [[ "$joined" == *"AIRFOILS_PRO_GATEWAY_LIVENESS_DIRECT_CELERY_REDIS_PROBE"* ]]; then printf '%s\n' "$DIRECT_SNAPSHOT"; exit 0; fi
        if [[ "$joined" == *" logs --no-color --timestamps --tail 2000 api"* ]]; then printf 'preserved gateway log\n'; exit 0; fi
        if [[ "$joined" == *" up -d --no-deps --force-recreate api"* ]]; then : >"$API_RECREATED"; exit 0; fi
        printf 'unexpected docker command: %s\n' "$joined" >&2
        exit 99
        ''',
    )
    _executable(
        bin_dir / "curl",
        r'''#!/usr/bin/env bash
        set -euo pipefail
        url="${!#}"
        case "$url" in
          *:8000/health)
            if [[ -f "$API_RECREATED" && "$FAKE_FAILURE" == warm-ready ]]; then
              count=0; [[ -f "$HEALTH_READY_CHECKS" ]] && read -r count <"$HEALTH_READY_CHECKS"
              count=$((count + 1)); printf '%s\n' "$count" >"$HEALTH_READY_CHECKS"
              [[ "$count" -gt 1 ]] || { printf 'connection refused\n' >&2; exit 7; }
            fi
            if [[ "$FAKE_FAILURE" == health-after && -f "$API_RECREATED" ]]; then printf '{"build_id":"wrong","default_engine":{"version":"2606"}}\n';
            elif [[ "$FAKE_FAILURE" == health-malformed && -f "$API_RECREATED" ]]; then printf '{bad json\n';
            else printf '{"build_id":"test-build","default_engine":{"version":"2606"}}\n'; fi ;;
          *:4000/health) printf '{}\n' ;;
          *:8000/queue)
            if [[ "$FAKE_FAILURE" == warm-ready ]]; then
              count=0; [[ -f "$QUEUE_READY_CHECKS" ]] && read -r count <"$QUEUE_READY_CHECKS"
              count=$((count + 1)); printf '%s\n' "$count" >"$QUEUE_READY_CHECKS"
              if [[ "$count" == 1 ]]; then printf 'cold queue cache\n' >&2; exit 22; fi
              if [[ "$count" == 2 ]]; then printf '{"queue_observation_state":"stale","queue_observation_error":null}\n'; exit 0; fi
            fi
            if [[ "$FAKE_FAILURE" == queue-malformed ]]; then printf '{bad json\n'; else printf '%s\n' "$FRESH_QUEUE"; fi ;;
          *) exit 99 ;;
        esac
        ''',
    )
    _executable(
        bin_dir / "python3",
        r'''#!/usr/bin/env bash
        set -euo pipefail
        case "${1:-}" in
          */deployment-env-preflight.py) exit 0 ;;
          */deployment-source-manifest.py)
            count=0; [[ -f "$SOURCE_CHECKS" ]] && read -r count <"$SOURCE_CHECKS"
            count=$((count + 1)); printf '%s\n' "$count" >"$SOURCE_CHECKS"
            if [[ "$FAKE_FAILURE" == source && "$count" -gt 2 ]]; then printf 'bad\t%s\t1\n' "$TREE_SHA"; else printf '%s\t%s\t1\n' "$REVISION" "$TREE_SHA"; fi
            exit 0 ;;
        esac
        exec "$REAL_PYTHON" "$@"
        ''',
    )
    _executable(bin_dir / "sleep", "#!/usr/bin/env bash\nexit 0\n")

    env = os.environ | {
        "APP_DIR": str(app),
        "ACTIVE_APP_LINK": str(app),
        "AIRFOILS_PRO_STATE_DIR": str(state),
        "ENV_FILE": str(state / ".env.deploy"),
        "COMPOSE_FILE": str(app / "docker-compose.deploy.yml"),
        "DEPLOYMENT_MANIFEST_FILE": str(app / ".deployment-source.json"),
        "PRODUCTION_MAINTENANCE_RECEIPT_FILE": str(receipt_path),
        "GATEWAY_LOG_DIR": str(state / "logs"),
        "LOCK_FILE": str(tmp_path / "maintenance.lock"),
        "CALL_LOG": str(tmp_path / "calls.log"),
        "API_RECREATED": str(tmp_path / "api-recreated"),
        "SOURCE_CHECKS": str(tmp_path / "source-checks"),
        "HEALTH_READY_CHECKS": str(tmp_path / "health-ready-checks"),
        "QUEUE_READY_CHECKS": str(tmp_path / "queue-ready-checks"),
        "ACTIVE_ROWS": json.dumps(active_rows, separators=(",", ":")),
        "EVIDENCE_JSON": json.dumps(evidence, separators=(",", ":")),
        "DIRECT_SNAPSHOT": json.dumps(direct, separators=(",", ":")),
        "FRESH_QUEUE": json.dumps(_fresh_queue(failure=failure), separators=(",", ":")),
        "FAKE_FAILURE": failure,
        "MAINTENANCE_TOKEN": TOKEN,
        "REVISION": REVISION,
        "TREE_SHA": TREE_SHA,
        "REAL_PYTHON": sys.executable,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
    }
    env["RECOVERY_ARGS"] = json.dumps([
        str(deploy / SCRIPT.name),
        "--expected-build-id", "test-build",
        "--expected-source-revision", REVISION,
        "--expected-source-tree-sha256", TREE_SHA,
        "--maintenance-token", TOKEN,
        "--expected-receipt-sha256", receipt_sha,
        "--expected-candidate-digest", CANDIDATE_DIGEST,
    ])
    return env, receipt_path


def _run(tmp_path: Path, *, failure: str = "") -> tuple[subprocess.CompletedProcess[str], dict[str, str], list[str]]:
    env, _ = _harness(tmp_path, failure=failure)
    result = subprocess.run(json.loads(env.pop("RECOVERY_ARGS")), env=env, text=True, capture_output=True, check=False)
    log = Path(env["CALL_LOG"])
    return result, env, log.read_text().splitlines() if log.exists() else []


def test_gateway_liveness_recovery_accepts_only_known_retry_rollback_and_recreates_api(tmp_path: Path) -> None:
    result, env, calls = _run(tmp_path)

    assert result.returncode == 0, result.stdout + result.stderr
    assert Path(env["API_RECREATED"]).exists()
    restart = next(index for index, call in enumerate(calls) if " up -d --no-deps --force-recreate api" in call)
    logs = next(index for index, call in enumerate(calls) if " logs --no-color --timestamps --tail 2000 api" in call)
    assert logs < restart
    assert list((Path(env["GATEWAY_LOG_DIR"])).glob("api-*-test-build.log"))
    assert "only api was recreated" in result.stdout
    assert not any(" force-recreate worker" in call or " up -d --no-deps worker" in call for call in calls)
    assert not any(" stop sweeper" in call or " stop media-repair" in call for call in calls)


def test_gateway_liveness_recovery_waits_for_transient_health_and_cold_queue_cache(tmp_path: Path) -> None:
    result, env, calls = _run(tmp_path, failure="warm-ready")

    assert result.returncode == 0, result.stdout + result.stderr
    assert Path(env["API_RECREATED"]).exists()
    assert Path(env["HEALTH_READY_CHECKS"]).read_text().strip() == "2"
    assert Path(env["QUEUE_READY_CHECKS"]).read_text().strip() == "3"
    assert not any("force-recreate worker" in call or " up -d --no-deps worker" in call for call in calls)


@pytest.mark.parametrize(
    "failure",
    (
        "writer",
        "outside-job",
        "bad-rollback",
        "evidence",
        "active",
        "coverage",
        "unacked",
        "openfoam",
        "no-worker",
        "source",
        "runtime-build",
        "runtime-engine",
        "runtime-urans",
        "runtime-archive",
        "runtime-queue",
        "runtime-queue-bool",
        "runtime-queue-float",
        "runtime-queue-string",
    ),
)
def test_gateway_liveness_recovery_refuses_every_ambiguous_pre_restart_state(tmp_path: Path, failure: str) -> None:
    result, env, calls = _run(tmp_path, failure=failure)

    assert result.returncode != 0
    assert not Path(env["API_RECREATED"]).exists()
    assert not any("force-recreate api" in call or "force-recreate worker" in call for call in calls)
    assert not any(" stop sweeper" in call or " stop media-repair" in call for call in calls)


@pytest.mark.parametrize("failure", ("fresh-queue", "health-after", "health-malformed", "queue-malformed"))
def test_gateway_liveness_recovery_refuses_to_claim_success_without_post_restart_health_and_queue(
    tmp_path: Path, failure: str
) -> None:
    result, env, calls = _run(tmp_path, failure=failure)

    assert result.returncode != 0
    assert Path(env["API_RECREATED"]).exists()
    assert any(" up -d --no-deps --force-recreate api" in call for call in calls)
    assert not any("force-recreate worker" in call or " up -d --no-deps worker" in call for call in calls)
    assert not any(" stop sweeper" in call or " stop media-repair" in call for call in calls)


def test_gateway_liveness_recovery_is_explicitly_gateway_only_and_uses_two_direct_samples() -> None:
    source = SCRIPT.read_text()

    assert "for sample in 1 2" in source
    assert "AIRFOILS_PRO_GATEWAY_LIVENESS_DIRECT_CELERY_REDIS_PROBE" in source
    assert "AIRFOILS_PRO_GATEWAY_LIVENESS_RECEIPT_EVIDENCE_PROBE" in source
    assert "compose up -d --no-deps --force-recreate api" in source
    assert "compose up -d --no-deps --force-recreate api \"${worker" not in source
    assert "compose up -d --no-deps --force-recreate worker" not in source
    assert "compose stop sweeper" not in source
    assert "compose stop media-repair" not in source
