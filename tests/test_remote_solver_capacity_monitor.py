from __future__ import annotations

import importlib.util
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import shutil
import stat
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "ops" / "remote_solver_capacity_report.py"
SCRIPT_PATH = ROOT / "scripts" / "ops" / "check-remote-solver-capacity.sh"
SERVICE_PATH = ROOT / "scripts" / "deploy" / "airfoils-remote-capacity-check.service"
TIMER_PATH = ROOT / "scripts" / "deploy" / "airfoils-remote-capacity-check.timer"
INSTALLER_PATH = (
    ROOT / "scripts" / "deploy" / "install-remote-solver-capacity-monitor.sh"
)
SPEC = importlib.util.spec_from_file_location("remote_solver_capacity_report", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
REPORTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPORTER)


NOW = datetime(2026, 8, 2, 8, 0, tzinfo=timezone.utc)


def _database(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "enabled": True,
        "transferPaused": False,
        "cpuCap": 40,
        "sweeperHeartbeatAt": NOW.isoformat().replace("+00:00", "Z"),
        "diskAdmissionBlocked": False,
        "diskAdmissionReason": None,
        "diskUsedPct": 77.0,
        "diskFreeBytes": 1_000,
        "diskRequiredFreeBytes": 100,
        "activePromises": 2,
        "liveRemoteJobs": 2,
        "reservedCpuSlots": 40,
        "engineJobIds": ["engine-a", "engine-b"],
        "liveJobProgress": {
            "jobs": 2,
            "totalCases": 52,
            "completedCases": 12,
            "awaitingEngineId": 0,
            "lastObservedAt": NOW.isoformat().replace("+00:00", "Z"),
            "states": {"running": 2},
        },
        "unsettledDeliveries": 0,
    }
    value.update(overrides)
    return value


def _queue(**overrides: object) -> dict[str, object]:
    value: dict[str, object] = {
        "queue_observation_state": "fresh",
        "queue_observed_at": NOW.isoformat().replace("+00:00", "Z"),
        "queue_refresh_in_progress": False,
        "queue_observation_error": None,
        "worker_queues_error": None,
        "worker_runtime_error": None,
        "inspection_errors": {},
        "worker_queues": [
            {"worker": "celery@remote", "queues": ["openfoam-opencfd-2606"]}
        ],
        "inspection_workers": {
            "active": ["celery@remote"],
            "reserved": ["celery@remote"],
            "scheduled": ["celery@remote"],
        },
        "queue_depth": 0,
        "active_count": 2,
        "reserved_count": 0,
        "scheduled_count": 0,
        "active": [{"job_id": "engine-a"}, {"job_id": "engine-b"}],
        "reserved": [],
        "scheduled": [],
        "job_ids": ["engine-a", "engine-b"],
        "duplicates": {},
        "queue_depths": {"openfoam-opencfd-2606": 0},
        "queue_enabled": {"openfoam-opencfd-2606": True},
    }
    value.update(overrides)
    return value


def _runtime(tokens: int = 20, processes: int = 20) -> dict[str, object]:
    return {
        "items": [
            {
                "job_id": "engine-a",
                "process_count": processes,
                "runtime_cpu_tokens_held": tokens,
                "status_state": "running",
                "status_total_cases": 26,
                "status_completed_cases": 5,
            },
            {
                "job_id": "engine-b",
                "process_count": processes,
                "runtime_cpu_tokens_held": tokens,
                "status_state": "running",
                "status_total_cases": 26,
                "status_completed_cases": 7,
            },
        ]
    }


def _codes(report: dict[str, object]) -> set[str]:
    return {item["code"] for item in report["issues"]}


def test_must_report_configured_and_live_cpu_progress_disk_and_complete_queue() -> None:
    report, status = REPORTER.build_report(
        database=_database(),
        engine_queue=_queue(),
        engine_runtime=_runtime(),
        host_openfoam_solver_processes=40,
        now=NOW,
    )

    assert status == 0
    assert report["status"] == "ok"
    assert report["capacity"] == {
        "configuredCpuSlots": 40,
        "reservedCpuSlots": 40,
        "runtimeCpuTokensHeld": 40,
        "hostOpenfoamSolverProcesses": 40,
        "reservationUtilizationPct": 100.0,
        "runtimeTokenUtilizationPct": 100.0,
        "activePromises": 2,
    }
    assert report["jobs"]["database"]["completedCases"] == 12
    assert report["jobs"]["engineRuntime"] == {
        "requestedJobs": 2,
        "reportedJobs": 2,
        "missingJobs": 0,
        "processCount": 40,
        "totalCases": 52,
        "completedCases": 12,
        "progressComplete": True,
    }
    assert report["diskAdmission"] == {
        "blocked": False,
        "reason": None,
        "usedPct": 77.0,
        "freeBytes": 1_000,
        "requiredFreeBytes": 100,
    }
    assert report["engine"]["queueComplete"] is True


def test_must_exit_nonzero_and_name_storage_admission_and_free_space_constraint() -> None:
    report, status = REPORTER.build_report(
        database=_database(
            diskAdmissionBlocked=True,
            diskAdmissionReason="terminal evidence awaits authenticated reclaim",
            diskFreeBytes=99,
            diskRequiredFreeBytes=100,
        ),
        engine_queue=_queue(),
        engine_runtime=_runtime(),
        host_openfoam_solver_processes=40,
        now=NOW,
    )

    assert status == 2
    assert report["status"] == "critical"
    assert {"storage_admission_blocked", "disk_free_below_required"} <= _codes(report)
    assert report["capacity"]["reservationUtilizationPct"] == 100.0


def test_must_fail_closed_when_engine_queue_or_runtime_coverage_is_incomplete() -> None:
    report, status = REPORTER.build_report(
        database=_database(),
        engine_queue=_queue(worker_runtime_error="Celery inspector timed out"),
        engine_runtime={"items": [_runtime()["items"][0]]},
        host_openfoam_solver_processes=20,
        now=NOW,
    )

    assert status == 2
    assert report["engine"]["queueComplete"] is False
    assert "engine_queue_worker_runtime_error" in _codes(report)
    assert "engine_runtime_coverage_incomplete" in _codes(report)


def test_must_warn_when_runnable_work_is_underfilled_without_mislabeling_storage() -> None:
    report, status = REPORTER.build_report(
        database=_database(reservedCpuSlots=20),
        engine_queue=_queue(),
        engine_runtime=_runtime(tokens=10, processes=10),
        host_openfoam_solver_processes=20,
        now=NOW,
    )

    assert status == 1
    assert report["status"] == "warning"
    assert _codes(report) == {"capacity_underfilled"}
    assert report["capacity"]["reservationUtilizationPct"] == 50.0
    assert report["capacity"]["runtimeTokenUtilizationPct"] == 50.0


def test_must_warn_when_reservations_hide_live_runtime_token_underfill() -> None:
    report, status = REPORTER.build_report(
        database=_database(reservedCpuSlots=40),
        engine_queue=_queue(),
        engine_runtime=_runtime(tokens=10, processes=10),
        host_openfoam_solver_processes=20,
        now=NOW,
    )

    assert status == 1
    assert report["status"] == "warning"
    assert _codes(report) == {"runtime_cpu_tokens_underfilled"}
    assert report["capacity"]["reservationUtilizationPct"] == 100.0
    assert report["capacity"]["runtimeTokenUtilizationPct"] == 50.0


def test_must_warn_when_engine_runtime_hides_missing_host_solver_processes() -> None:
    report, status = REPORTER.build_report(
        database=_database(reservedCpuSlots=40),
        engine_queue=_queue(),
        engine_runtime=_runtime(tokens=20, processes=20),
        host_openfoam_solver_processes=20,
        now=NOW,
    )

    assert status == 1
    assert report["status"] == "warning"
    assert _codes(report) == {"host_openfoam_process_coverage_underfilled"}
    assert report["jobs"]["engineRuntime"]["processCount"] == 40
    assert report["capacity"]["hostOpenfoamSolverProcesses"] == 20


def test_shell_entrypoint_is_versioned_executable_and_has_only_read_probes() -> None:
    source = SCRIPT_PATH.read_text(encoding="utf-8")
    assert SCRIPT_PATH.stat().st_mode & stat.S_IXUSR
    assert 'SELECT json_build_object(' in source
    assert '"$ENGINE_URL/queue"' in source
    assert '"$ENGINE_URL/jobs/runtime"' in source
    assert "--data-binary \"$runtime_request\"" in source
    assert "UPDATE " not in source
    assert "INSERT " not in source
    assert "DELETE " not in source
    assert "POST /" not in source
    assert "mv -f \"$temporary\" \"$OUTPUT_FILE\"" in source


def test_versioned_systemd_timer_reuses_established_name_and_runs_every_six_hours() -> None:
    service = SERVICE_PATH.read_text(encoding="utf-8")
    timer = TIMER_PATH.read_text(encoding="utf-8")
    installer = INSTALLER_PATH.read_text(encoding="utf-8")

    assert "Type=oneshot" in service
    assert (
        "ExecStart=/opt/airfoils-pro/app/scripts/ops/check-remote-solver-capacity.sh"
        in service
    )
    assert "WorkingDirectory=/opt/airfoils-pro/app" in service
    assert "OnCalendar=*-*-* 00/6:00:00" in timer
    assert "RandomizedDelaySec=5min" in timer
    assert "Persistent=true" in timer
    assert "Unit=airfoils-remote-capacity-check.service" in timer
    assert 'SERVICE_NAME="airfoils-remote-capacity-check.service"' in installer
    assert 'TIMER_NAME="airfoils-remote-capacity-check.timer"' in installer
    assert "airfoils-remote-solver-capacity-monitor" not in timer + installer


def test_capacity_timer_installer_is_remote_role_gated_and_never_mutates_solver() -> None:
    sources = "\n".join(
        path.read_text(encoding="utf-8")
        for path in (SERVICE_PATH, TIMER_PATH, INSTALLER_PATH)
    )
    installer = INSTALLER_PATH.read_text(encoding="utf-8")

    assert INSTALLER_PATH.stat().st_mode & stat.S_IXUSR
    assert '[[ "$DEPLOYMENT_ROLE" != "remote-solver" ]]' in installer
    assert '"$SYSTEMCTL_BIN" daemon-reload' in installer
    assert '"$SYSTEMCTL_BIN" reset-failed "$SERVICE_NAME" "$TIMER_NAME"' in installer
    assert '"$SYSTEMCTL_BIN" enable --now "$TIMER_NAME"' in installer
    assert '"$SYSTEMCTL_BIN" is-enabled --quiet "$TIMER_NAME"' in installer
    assert '"$SYSTEMCTL_BIN" is-active --quiet "$TIMER_NAME"' in installer
    for forbidden in (
        "docker compose up",
        "docker compose stop",
        "docker compose restart",
        "force-recreate",
        "UPDATE ",
        "INSERT ",
        "DELETE ",
        "/api/admin",
    ):
        assert forbidden not in sources


def test_ordinary_remote_promotion_installs_monitor_without_waiting_for_engine_idle() -> None:
    deploy = (
        ROOT / "scripts" / "deploy" / "vps-redeploy.sh"
    ).read_text(encoding="utf-8")
    function_start = deploy.index("install_remote_capacity_monitor()")
    function_end = deploy.index("\n}\n", function_start)
    installer_function = deploy[function_start:function_end]
    main_start = deploy.index("\nmain() {")
    main = deploy[main_start:]

    assert '[[ "$DEPLOYMENT_ROLE" == "remote-solver" ]] || return 0' in installer_function
    assert '"$DEPLOY_SCRIPT_DIR/install-remote-solver-capacity-monitor.sh"' in installer_function
    assert main.index("verify_deployment_source") < main.index(
        "install_remote_capacity_monitor"
    ) < main.index("persist_recovery_source_revision")
    assert main.index("install_remote_capacity_monitor") < main.index(
        "openfoam_processes"
    )


def test_installer_atomically_replaces_the_established_timer_without_a_duplicate(
    tmp_path: Path,
) -> None:
    app = tmp_path / "app"
    state = tmp_path / "state"
    deploy = app / "scripts" / "deploy"
    ops = app / "scripts" / "ops"
    unit_dir = tmp_path / "systemd"
    fake_bin = tmp_path / "bin"
    deploy.mkdir(parents=True)
    ops.mkdir(parents=True)
    state.mkdir()
    fake_bin.mkdir()
    for source in (
        ROOT / "scripts" / "deploy" / "deployment-env-preflight.py",
        ROOT / "scripts" / "deploy" / "deployment-compose-profile.sh",
        SERVICE_PATH,
        TIMER_PATH,
        INSTALLER_PATH,
    ):
        shutil.copy2(source, deploy / source.name)
    for source in (SCRIPT_PATH, MODULE_PATH):
        shutil.copy2(source, ops / source.name)
    (app / "docker-compose.deploy.yml").write_text("services: {}\n", encoding="utf-8")
    override = state / "docker-compose.remote-solver.yml"
    override.write_text("services: {}\n", encoding="utf-8")
    override.chmod(0o600)
    resolved_compose = tmp_path / "resolved-compose.json"
    resolved_compose.write_text(
        json.dumps(
            {
                "name": "hz-solver2",
                "services": {
                    "api": {
                        "environment": {
                            "AIRFOILFOAM_DATA_DIR": "/data/airfoilfoam",
                        },
                        "volumes": [
                            {
                                "type": "volume",
                                "source": "results",
                                "target": "/data/airfoilfoam",
                            },
                        ],
                    }
                },
                "volumes": {"results": {"name": "hz-solver2_results"}},
            }
        ),
        encoding="utf-8",
    )
    env_file = state / ".env.deploy"
    env_file.write_text(
        "\n".join(
            [
                "AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver",
                "COMPOSE_PROJECT_NAME=hz-solver2",
                f"COMPOSE_OVERRIDE_FILE={override}",
                "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1",
                "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=false",
                "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10",
                "AIRFOILFOAM_CONTROL_PLANE_TOKEN=capacity-monitor-test-token-at-least-32-bytes",
                "AIRFOILFOAM_WORKER_CPU_BUDGET=40",
                "AIRFOILFOAM_CASE_CONCURRENCY=40",
                "AIRFOILFOAM_CELERY_CONCURRENCY=40",
                "",
            ]
        ),
        encoding="utf-8",
    )
    env_file.chmod(0o600)
    systemctl = fake_bin / "systemctl"
    _write_executable(
        systemctl,
        "#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s\\n' \"$*\" >>\"$FAKE_SYSTEMCTL_LOG\"\n",
    )
    _write_executable(
        fake_bin / "docker",
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        "if [[ \"$1\" == \"compose\" ]]; then cat \"$FAKE_REMOTE_COMPOSE\"; exit 0; fi\n"
        "if [[ \"$1\" == \"volume\" && \"$2\" == \"inspect\" ]]; then printf '/proc\\n'; exit 0; fi\n"
        "exit 97\n",
    )

    completed = subprocess.run(
        [str(deploy / INSTALLER_PATH.name)],
        check=False,
        capture_output=True,
        text=True,
        env=os.environ
        | {
            "APP_DIR": str(app),
            "AIRFOILS_PRO_STATE_DIR": str(state),
            "ENV_FILE": str(env_file),
            "SYSTEMD_UNIT_DIR": str(unit_dir),
            "SYSTEMCTL_BIN": str(systemctl),
            "FAKE_SYSTEMCTL_LOG": str(tmp_path / "systemctl.log"),
            "FAKE_REMOTE_COMPOSE": str(resolved_compose),
            "PATH": f"{fake_bin}:{os.environ['PATH']}",
        },
    )

    assert completed.returncode == 0, completed.stderr
    assert sorted(path.name for path in unit_dir.iterdir()) == [
        "airfoils-remote-capacity-check.service",
        "airfoils-remote-capacity-check.timer",
    ]
    systemctl_calls = (tmp_path / "systemctl.log").read_text(encoding="utf-8")
    assert "daemon-reload" in systemctl_calls
    assert (
        "reset-failed airfoils-remote-capacity-check.service "
        "airfoils-remote-capacity-check.timer"
    ) in systemctl_calls
    assert "enable --now airfoils-remote-capacity-check.timer" in systemctl_calls


def test_cli_writes_a_private_json_report(tmp_path: Path) -> None:
    output = tmp_path / "report.json"
    now = datetime.now(timezone.utc)
    database = _database(
        sweeperHeartbeatAt=now.isoformat().replace("+00:00", "Z"),
    )
    queue = _queue(queue_observed_at=now.isoformat().replace("+00:00", "Z"))
    completed = subprocess.run(
        [
            sys.executable,
            str(MODULE_PATH),
            "--database",
            json.dumps(database),
            "--engine-queue",
            json.dumps(queue),
            "--engine-runtime",
            json.dumps(_runtime()),
            "--host-openfoam-solver-processes",
            "40",
            "--output",
            str(output),
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 0, completed.stderr
    assert json.loads(output.read_text())["status"] == "ok"
    assert stat.S_IMODE(output.stat().st_mode) == 0o600


def _write_executable(path: Path, source: str) -> None:
    path.write_text(source, encoding="utf-8")
    path.chmod(0o755)


def test_shell_entrypoint_runs_only_read_probes_and_publishes_atomic_report(tmp_path: Path) -> None:
    app = tmp_path / "app"
    state = tmp_path / "state"
    fake_bin = tmp_path / "bin"
    (app / "scripts" / "ops").mkdir(parents=True)
    (app / "scripts" / "deploy").mkdir(parents=True)
    state.mkdir()
    fake_bin.mkdir()
    for path in (SCRIPT_PATH, MODULE_PATH):
        shutil.copy2(path, app / "scripts" / "ops" / path.name)
    for name in ("deployment-env-preflight.py", "deployment-compose-profile.sh"):
        shutil.copy2(ROOT / "scripts" / "deploy" / name, app / "scripts" / "deploy" / name)
    (app / "docker-compose.deploy.yml").write_text("services: {}\n", encoding="utf-8")
    override = state / "docker-compose.remote-solver.yml"
    override.write_text("services: {}\n", encoding="utf-8")
    override.chmod(0o600)
    resolved_compose = tmp_path / "resolved-compose.json"
    resolved_compose.write_text(
        json.dumps(
            {
                "name": "hz-solver2",
                "services": {
                    "api": {
                        "environment": {
                            "AIRFOILFOAM_DATA_DIR": "/data/airfoilfoam",
                        },
                        "volumes": [
                            {
                                "type": "volume",
                                "source": "results",
                                "target": "/data/airfoilfoam",
                            },
                        ],
                    }
                },
                "volumes": {"results": {"name": "hz-solver2_results"}},
            }
        ),
        encoding="utf-8",
    )
    env_file = state / ".env.deploy"
    env_file.write_text(
        "\n".join(
            [
                "AIRFOILFOAM_DEPLOYMENT_ROLE=remote-solver",
                "COMPOSE_PROJECT_NAME=hz-solver2",
                f"COMPOSE_OVERRIDE_FILE={override}",
                "AIRFOILFOAM_EVIDENCE_OBJECT_PREFIX=solver-evidence/v1",
                "AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=false",
                "AIRFOILFOAM_EVIDENCE_ZSTD_LEVEL=10",
                "AIRFOILFOAM_CONTROL_PLANE_TOKEN=capacity-monitor-test-token-at-least-32-bytes",
                "AIRFOILFOAM_WORKER_CPU_BUDGET=40",
                "AIRFOILFOAM_CASE_CONCURRENCY=40",
                "AIRFOILFOAM_CELERY_CONCURRENCY=40",
                "ENGINE_URL=http://127.0.0.1:8000",
                "",
            ]
        ),
        encoding="utf-8",
    )
    env_file.chmod(0o600)
    _write_executable(
        fake_bin / "docker",
        """#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "compose" && "$*" == *" config --format json" ]]; then
  cat "$FAKE_REMOTE_COMPOSE"
  exit 0
fi
if [[ "$1" == "volume" && "$2" == "inspect" ]]; then
  printf '/proc\\n'
  exit 0
fi
if [[ "$*" == "compose version" ]]; then exit 0; fi
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
if [[ "$*" == *" exec -T postgres sh -lc "* ]]; then
  printf '%s' "$FAKE_DATABASE"
  exit 0
fi
exit 97
""",
    )
    _write_executable(
        fake_bin / "curl",
        """#!/usr/bin/env bash
set -euo pipefail
for argument in "$@"; do
  if [[ "$argument" == */queue ]]; then printf '%s' "$FAKE_QUEUE"; exit 0; fi
  if [[ "$argument" == */jobs/runtime ]]; then printf '%s' "$FAKE_RUNTIME"; exit 0; fi
done
exit 98
""",
    )
    _write_executable(
        fake_bin / "ps",
        """#!/usr/bin/env bash
for _ in $(seq 1 40); do printf 'pimpleFoam\\n'; done
""",
    )
    now = datetime.now(timezone.utc)
    run_env = os.environ | {
        "APP_DIR": str(app),
        "AIRFOILS_PRO_STATE_DIR": str(state),
        "ENV_FILE": str(env_file),
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "FAKE_DOCKER_LOG": str(tmp_path / "docker.log"),
        "FAKE_REMOTE_COMPOSE": str(resolved_compose),
        "FAKE_DATABASE": json.dumps(
            _database(sweeperHeartbeatAt=now.isoformat().replace("+00:00", "Z"))
        ),
        "FAKE_QUEUE": json.dumps(
            _queue(queue_observed_at=now.isoformat().replace("+00:00", "Z"))
        ),
        "FAKE_RUNTIME": json.dumps(_runtime()),
    }
    completed = subprocess.run(
        [str(app / "scripts" / "ops" / "check-remote-solver-capacity.sh")],
        check=False,
        capture_output=True,
        text=True,
        env=run_env,
    )

    assert completed.returncode == 0, completed.stderr
    report_path = state / "monitor" / "remote-solver-capacity-latest.json"
    assert json.loads(report_path.read_text())["capacity"]["runtimeCpuTokensHeld"] == 40
    assert stat.S_IMODE(report_path.stat().st_mode) == 0o600
    docker_calls = (tmp_path / "docker.log").read_text()
    assert " exec -T postgres sh -lc" in docker_calls
    assert not any(command in docker_calls for command in (" up ", " stop ", " restart ", " rm "))
