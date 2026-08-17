from __future__ import annotations

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "deploy" / "recover-production-legacy-gateway-reconciliation.sh"
TOKEN = "11111111-1111-4111-8111-111111111111"
REVISION = "a" * 40
TREE_SHA = "b" * 64
CANDIDATE_DIGEST = "c" * 64


def _executable(path: Path, contents: str) -> None:
    path.write_text(textwrap.dedent(contents))
    path.chmod(0o755)


def _recovery_harness(
    tmp_path: Path, *, failure: str = "", repair_rollback: bool = False
) -> tuple[dict[str, str], Path]:
    app = tmp_path / "release"
    deploy = app / "scripts" / "deploy"
    bin_dir = tmp_path / "bin"
    state = tmp_path / "state"
    deploy.mkdir(parents=True)
    bin_dir.mkdir()
    state.mkdir()
    shutil.copy2(SCRIPT, deploy / SCRIPT.name)
    (deploy / "deployment-env-preflight.py").write_text("# fake is selected by PATH\n")
    (deploy / "deployment-source-manifest.py").write_text("# fake is selected by PATH\n")
    (deploy / "production_maintenance_preflight.py").write_text("# fake is selected by PATH\n")
    (deploy / "deployment-compose-profile.sh").write_text(
        "configure_deployment_compose_profile() {\n"
        "  DEPLOYMENT_ROLE=hub\n"
        "  COMPOSE_PROJECT_NAME=receipt-recovery-test\n"
        "  COMPOSE_FILE_ARGS=()\n"
        "}\n"
    )
    (app / "docker-compose.deploy.yml").write_text("services: {}\n")
    (app / ".deployment-source.json").write_text("{}\n")
    (state / ".env.deploy").write_text("AIRFOILFOAM_BUILD_ID=test-build\n")

    receipt = {
        "schemaVersion": 1,
        "maintenanceToken": TOKEN if failure != "token" else "22222222-2222-4222-8222-222222222222",
        "candidateDigest": CANDIDATE_DIGEST,
        "candidates": [{"jobId": "receipt-only-job"}],
    }
    receipt_path = state / "production-legacy-gateway-reconciliation.json"
    receipt_path.write_text(json.dumps(receipt, sort_keys=True) + "\n")
    receipt_path.chmod(0o600)
    receipt_sha = hashlib.sha256(receipt_path.read_bytes()).hexdigest()

    _executable(
        bin_dir / "docker",
        r"""#!/usr/bin/env bash
        set -euo pipefail
        joined="$*"
        printf '%s\n' "$joined" >>"$CALL_LOG"
        if [[ "$joined" == "compose version" ]]; then exit 0; fi
        if [[ "${1:-}" == inspect ]]; then
          printf '["ENGINE_EXPECTED_BUILD_ID=test-build"]\n'
          exit 0
        fi
        if [[ "$joined" == *" ps --status running -q node-api"* ]]; then
          printf 'node-api-test\n'; exit 0
        fi
        if [[ "$joined" == *" ps --status running -q postgres"* ]]; then
          printf 'postgres-test\n'; exit 0
        fi
        if [[ "$joined" == *" config --services"* ]]; then
          printf 'sweeper\nmedia-repair\nworker\n'
          # The old wrapper expanded every optional profile and then required
          # this intentionally disabled pool to be running. The active-profile
          # query must never see it.
          [[ "$joined" != *"--profile *"* ]] || printf 'worker-foundation14\n'
          exit 0
        fi
        if [[ "$joined" == *" ps --status running -q sweeper"* ]]; then
          [[ -f "$SWEEPER_RUNNING" ]] && printf 'sweeper-test\n'
          exit 0
        fi
        if [[ "$joined" == *" ps --status running -q media-repair"* ]]; then
          [[ -f "$MEDIA_REPAIR_RUNNING" ]] && printf 'media-repair-test\n'
          exit 0
        fi
        if [[ "$joined" == *" ps --status running -q worker"* ]]; then
          printf 'worker-test\n'; exit 0
        fi
        if [[ "$joined" == *" stop sweeper"* ]]; then
          rm -f "$SWEEPER_RUNNING"; : >"$SWEEPER_STOPPED"; exit 0
        fi
        if [[ "$joined" == *" stop media-repair"* ]]; then
          rm -f "$MEDIA_REPAIR_RUNNING"; : >"$MEDIA_REPAIR_STOPPED"; exit 0
        fi
        if [[ "$joined" == *" exec -T worker sh -lc "* ]]; then exit 0; fi
        if [[ "$joined" == *" run --rm --no-deps -T "* && "$joined" == *"maintenance:reconcile-receipt"* ]]; then
          [[ -f "$SWEEPER_STOPPED" && -f "$MEDIA_REPAIR_STOPPED" ]] || {
            printf 'receipt CLI ran while a normal writer was live\n' >&2; exit 91;
          }
          if [[ "$joined" == *"repair-known-retry-rollback"* ]]; then
            : >"$REPAIRED"
            printf '{"schemaVersion":1,"mode":"receipt-retry-rollback-repair","repairedJobIds":["receipt-only-job"],"alreadyRestoredJobIds":[]}\n'
            exit 0
          fi
          if [[ "$FAKE_FAILURE" == cli ]]; then
            printf 'simulated receipt CLI failure\n' >&2; exit 92
          fi
          : >"$RECONCILED"
          if [[ "$FAKE_FAILURE" == receipt ]]; then
            printf 'tamper\n' >>"$RECEIPT_PATH"
          fi
          printf '{"requested":1,"reconciled":1,"remaining":0}\n'
          exit 0
        fi
        if [[ "$joined" == *" up -d --no-deps media-repair"* ]]; then
          : >"$MEDIA_REPAIR_RUNNING"
          [[ "$FAKE_FAILURE" != media-start ]] || { printf 'simulated partial media start failure\n' >&2; exit 95; }
          exit 0
        fi
        if [[ "$joined" == *" up -d --no-deps sweeper"* ]]; then
          : >"$SWEEPER_RUNNING"; exit 0
        fi
        if [[ "${1:-}" == exec && "$joined" == *" psql "* ]]; then
          if [[ "$joined" == *"UPDATE sweeper_state"* ]]; then
            [[ -f "$SWEEPER_RUNNING" && -f "$MEDIA_REPAIR_RUNNING" ]] || {
              printf 'CAS attempted before both writers were stable\n' >&2; exit 93;
            }
            [[ "$FAKE_FAILURE" != drain ]] || { printf '{"enabled":true}\n'; exit 0; }
            : >"$CAS_APPLIED"
            printf '{"enabled":true,"admission_fence_active":false,"maintenance_drain_token":null,"maintenance_drain_started_at":null}\n'
            # Real psql emits a DML command tag even with tuples-only output.
            # Quiet mode is required to keep the JSON transport singular.
            [[ "$joined" == *" -q "* ]] || printf 'UPDATE 1\n'
          else
            if [[ "$FAKE_FAILURE" == drain ]]; then
              printf '{"enabled":true,"admission_fence_active":false,"maintenance_drain_token":"%s","maintenance_drain_started_at":"2026-08-02T00:00:00+00:00"}\n' "$MAINTENANCE_TOKEN"
            else
              printf '{"enabled":false,"admission_fence_active":false,"maintenance_drain_token":"%s","maintenance_drain_started_at":"2026-08-02T00:00:00+00:00"}\n' "$MAINTENANCE_TOKEN"
            fi
          fi
          exit 0
        fi
        printf 'unexpected docker command: %s\n' "$joined" >&2
        exit 99
        """,
    )
    _executable(
        bin_dir / "curl",
        r"""#!/usr/bin/env bash
        set -euo pipefail
        url="${!#}"
        case "$url" in
          *:8000/health) printf '{"build_id":"test-build"}\n' ;;
          *:4000/health) printf '{}\n' ;;
          *:8000/queue)
            count=0; [[ -f "$QUEUE_CHECKS" ]] && read -r count <"$QUEUE_CHECKS"
            count=$((count + 1)); printf '%s\n' "$count" >"$QUEUE_CHECKS"
            if [[ "$FAKE_FAILURE" == queue-refresh && "$count" -eq 1 ]]; then
              printf 'simulated cold queue cache\n' >&2
              exit 22
            elif [[ "$FAKE_FAILURE" == queue-refresh && "$count" -eq 2 ]]; then
              printf '{"queue_observation_state":"stale","queue_observation_error":null}'
            elif [[ "$FAKE_FAILURE" == idle ]]; then
              printf '{"queue_observation_state":"fresh","queue_observation_error":null,"active_count":1,"reserved_count":0,"scheduled_count":0,"queue_depth":0,"queue_depths":{"openfoam-opencfd-2606":0},"inspection_errors":{},"worker_queues_error":null,"worker_runtime_error":null,"worker_queues":[{"worker":"worker-test"}]}'
            else
              printf '{"queue_observation_state":"fresh","queue_observation_error":null,"active_count":0,"reserved_count":0,"scheduled_count":0,"queue_depth":0,"queue_depths":{"openfoam-opencfd-2606":0},"inspection_errors":{},"worker_queues_error":null,"worker_runtime_error":null,"worker_queues":[{"worker":"worker-test"}]}'
            fi
            ;;
          *) printf 'unexpected curl URL: %s\n' "$url" >&2; exit 99 ;;
        esac
        """,
    )
    _executable(
        bin_dir / "python3",
        r"""#!/usr/bin/env bash
        set -euo pipefail
        case "${1:-}" in
          */deployment-env-preflight.py) exit 0 ;;
          */deployment-source-manifest.py)
            count=0; [[ -f "$SOURCE_CHECKS" ]] && read -r count <"$SOURCE_CHECKS"
            count=$((count + 1)); printf '%s\n' "$count" >"$SOURCE_CHECKS"
            if [[ "$FAKE_FAILURE" == source && "$count" -gt 1 ]]; then
              printf 'deadbeef\t%s\t1\n' "$TREE_SHA"
            else
              printf '%s\t%s\t1\n' "$REVISION" "$TREE_SHA"
            fi
            exit 0 ;;
          */production_maintenance_preflight.py)
            count=0; [[ -f "$PREFLIGHT_CHECKS" ]] && read -r count <"$PREFLIGHT_CHECKS"
            count=$((count + 1)); printf '%s\n' "$count" >"$PREFLIGHT_CHECKS"
            [[ "$FAKE_FAILURE" != preflight || "$count" -eq 1 ]] || { printf 'simulated post-CLI preflight failure\n' >&2; exit 94; }
            if [[ -f "$RECONCILED" ]]; then
              printf '{"readyForReconcile":true,"reconciled":true,"candidateCount":1,"terminalCount":1,"remainingCount":0,"unexpectedActiveCount":0}\n'
            else
              printf '{"readyForReconcile":true,"reconciled":false,"candidateCount":1,"terminalCount":0,"remainingCount":1,"unexpectedActiveCount":0}\n'
            fi
            exit 0 ;;
        esac
        exec "$REAL_PYTHON" "$@"
        """,
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
        "LOCK_FILE": str(tmp_path / "maintenance.lock"),
        "CALL_LOG": str(tmp_path / "calls.log"),
        "RECEIPT_PATH": str(receipt_path),
        "RECONCILED": str(tmp_path / "reconciled"),
        "REPAIRED": str(tmp_path / "repaired"),
        "CAS_APPLIED": str(tmp_path / "cas-applied"),
        "SWEEPER_RUNNING": str(tmp_path / "sweeper-running"),
        "MEDIA_REPAIR_RUNNING": str(tmp_path / "media-repair-running"),
        "SWEEPER_STOPPED": str(tmp_path / "sweeper-stopped"),
        "MEDIA_REPAIR_STOPPED": str(tmp_path / "media-repair-stopped"),
        "SOURCE_CHECKS": str(tmp_path / "source-checks"),
        "PREFLIGHT_CHECKS": str(tmp_path / "preflight-checks"),
        "QUEUE_CHECKS": str(tmp_path / "queue-checks"),
        "FAKE_FAILURE": failure,
        "MAINTENANCE_TOKEN": TOKEN,
        "REVISION": REVISION,
        "TREE_SHA": TREE_SHA,
        "REAL_PYTHON": sys.executable,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
    }
    args = [
        str(deploy / SCRIPT.name),
        "--expected-build-id", "test-build",
        "--expected-source-revision", REVISION,
        "--expected-source-tree-sha256", TREE_SHA,
        "--maintenance-token", TOKEN,
        "--expected-receipt-sha256", receipt_sha,
        "--expected-candidate-digest", CANDIDATE_DIGEST,
    ]
    if repair_rollback:
        args.append("--repair-known-retry-rollback")
    env["RECOVERY_ARGS"] = json.dumps(args)
    return env, receipt_path


def _run(
    tmp_path: Path, *, failure: str = "", repair_rollback: bool = False
) -> tuple[subprocess.CompletedProcess[str], dict[str, str], list[str]]:
    env, _ = _recovery_harness(
        tmp_path, failure=failure, repair_rollback=repair_rollback
    )
    completed = subprocess.run(
        json.loads(env.pop("RECOVERY_ARGS")), env=env, text=True, capture_output=True, check=False
    )
    call_log = Path(env["CALL_LOG"])
    return completed, env, call_log.read_text().splitlines() if call_log.exists() else []


def test_receipt_recovery_happy_path_is_receipt_scoped_and_releases_admission_last(tmp_path: Path) -> None:
    completed, env, calls = _run(tmp_path)

    assert completed.returncode == 0, completed.stdout + completed.stderr
    cli = next(index for index, call in enumerate(calls) if "maintenance:reconcile-receipt" in call)
    media_start = next(index for index, call in enumerate(calls) if " up -d --no-deps media-repair" in call)
    sweeper_start = next(index for index, call in enumerate(calls) if " up -d --no-deps sweeper" in call)
    cas = next(index for index, call in enumerate(calls) if "UPDATE sweeper_state" in call)
    assert cli < media_start < sweeper_start < cas
    assert Path(env["CAS_APPLIED"]).exists()
    assert not any(" build " in call or "force-recreate api" in call or "force-recreate worker" in call for call in calls)
    assert "Receipt recovery complete" in completed.stdout


def test_receipt_recovery_option_repairs_only_before_the_normal_receipt_settlement(
    tmp_path: Path,
) -> None:
    completed, env, calls = _run(tmp_path, repair_rollback=True)

    assert completed.returncode == 0, completed.stdout + completed.stderr
    repair = next(
        index
        for index, call in enumerate(calls)
        if "maintenance:reconcile-receipt" in call
        and "repair-known-retry-rollback" in call
    )
    settlement = next(
        index
        for index, call in enumerate(calls)
        if "maintenance:reconcile-receipt" in call
        and "repair-known-retry-rollback" not in call
    )
    assert repair < settlement
    assert Path(env["REPAIRED"]).exists()
    assert Path(env["CAS_APPLIED"]).exists()


def test_receipt_recovery_waits_for_cold_then_stale_queue_observation(
    tmp_path: Path,
) -> None:
    completed, env, calls = _run(tmp_path, failure="queue-refresh")

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert int(Path(env["QUEUE_CHECKS"]).read_text()) == 3
    assert Path(env["CAS_APPLIED"]).exists()
    media_start = next(
        index for index, call in enumerate(calls) if " up -d --no-deps media-repair" in call
    )
    sweeper_start = next(
        index for index, call in enumerate(calls) if " up -d --no-deps sweeper" in call
    )
    cas = next(index for index, call in enumerate(calls) if "UPDATE sweeper_state" in call)
    assert media_start < sweeper_start < cas


def test_receipt_recovery_binds_the_normal_active_release_link_to_one_release(tmp_path: Path) -> None:
    env, _ = _recovery_harness(tmp_path)
    active_link = tmp_path / "app"
    active_link.symlink_to(tmp_path / "release", target_is_directory=True)
    env["APP_DIR"] = str(active_link)
    env["ACTIVE_APP_LINK"] = str(active_link)

    completed = subprocess.run(
        json.loads(env.pop("RECOVERY_ARGS")), env=env, text=True, capture_output=True, check=False
    )

    assert completed.returncode == 0, completed.stdout + completed.stderr
    assert "Receipt recovery complete" in completed.stdout


@pytest.mark.parametrize(
    "failure",
    ("token", "source", "receipt", "cli", "preflight", "idle", "media-start"),
)
def test_receipt_recovery_failure_keeps_admission_paused_and_never_recreates_engine(
    tmp_path: Path, failure: str
) -> None:
    completed, env, calls = _run(tmp_path, failure=failure)

    assert completed.returncode != 0
    assert not Path(env["CAS_APPLIED"]).exists()
    assert not any(" build " in call or "force-recreate api" in call or "force-recreate worker" in call for call in calls)
    assert "maintenance token remains paused" in completed.stderr
    if failure in {"source", "receipt", "cli", "preflight", "idle"}:
        assert any(" stop sweeper" in call for call in calls)
        assert any(" stop media-repair" in call for call in calls)
    assert not any(" up -d --no-deps sweeper" in call for call in calls)
    if failure == "media-start":
        media_start = next(
            index
            for index, call in enumerate(calls)
            if " up -d --no-deps media-repair" in call
        )
        assert any(" stop media-repair" in call for call in calls[media_start + 1 :])
    else:
        assert not any(" up -d --no-deps media-repair" in call for call in calls)


def test_receipt_recovery_stops_restarted_writers_when_drain_ownership_changes(tmp_path: Path) -> None:
    completed, env, calls = _run(tmp_path, failure="drain")

    assert completed.returncode != 0
    assert not Path(env["CAS_APPLIED"]).exists()
    media_start = next(index for index, call in enumerate(calls) if " up -d --no-deps media-repair" in call)
    sweeper_start = next(index for index, call in enumerate(calls) if " up -d --no-deps sweeper" in call)
    trailing = calls[max(media_start, sweeper_start) + 1 :]
    assert any(" stop sweeper" in call for call in trailing)
    assert any(" stop media-repair" in call for call in trailing)
    assert "maintenance token remains paused" in completed.stderr


def test_receipt_recovery_script_forbids_engine_mutation_and_uses_the_existing_reconciler() -> None:
    source = SCRIPT.read_text()

    assert "maintenance:reconcile-receipt" in source
    assert "--receipt-file \"$RECEIPT_CONTAINER_PATH\"" in source
    assert "compose build" not in source
    assert "force-recreate api" not in source
    assert "force-recreate worker" not in source
    assert "compose up -d --no-deps api" not in source
    assert "compose up -d --no-deps worker" not in source
    assert "compose --profile '*' config --services" not in source
    assert source.index("require_new_engine_idle") < source.rindex("restore_admission_last")
    assert source.index("verify_active_release") < source.rindex("restore_admission_last")
