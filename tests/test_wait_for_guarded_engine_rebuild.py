from __future__ import annotations

import importlib.util
import io
import json
import fcntl
import os
import re
from dataclasses import replace as dataclass_replace
from pathlib import Path
import shutil
import subprocess
import sys
from typing import Any

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/deploy/wait-for-guarded-engine-rebuild.py"
SPEC = importlib.util.spec_from_file_location("guarded_engine_rebuild_watcher", SCRIPT)
assert SPEC and SPEC.loader
watcher = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = watcher
SPEC.loader.exec_module(watcher)


class FakeSystem:
    def __init__(self, exit_code: int = 0) -> None:
        self.exit_code = exit_code
        self.invocations: list[list[str]] = []

    def capture(self, args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
        raise AssertionError(f"unexpected live capture: {args} / {timeout}")

    def fetch_json(self, url: str, timeout: float) -> dict[str, Any]:
        raise AssertionError(f"unexpected live fetch: {url} / {timeout}")

    def invoke(self, args: list[str], log_path: Path, on_spawn) -> int:
        self.invocations.append(args)
        log_path.write_text("guarded child output\n", encoding="utf-8")
        log_path.chmod(0o600)
        on_spawn(4242)
        return self.exit_code


class ProductionDrainSystem(FakeSystem):
    def __init__(self, *, exit_code: int = 0) -> None:
        super().__init__(exit_code=exit_code)
        self.enabled = True
        self.fenced = False
        self.maintenance_token: str | None = None
        self.maintenance_started_at: str | None = None
        self.pause_calls = 0
        self.restore_calls = 0

    @staticmethod
    def _maintenance_token(args: list[str]) -> str:
        assert "-v" not in args
        sql = args[-1]
        assert watcher.MAINTENANCE_TOKEN_BIND_MARKER not in sql
        match = re.search(
            r"maintenance_drain_token\s*=\s*'([0-9a-f-]{36})'::uuid",
            sql,
        )
        if match is None:
            raise AssertionError(f"missing bound maintenance token in command: {args}")
        return match.group(1)

    @classmethod
    def _is_pause(cls, args: list[str]) -> bool:
        token = cls._maintenance_token(args)
        return args[-1] == watcher._bind_maintenance_token(
            watcher.PRODUCTION_PAUSE_ADMISSION_QUERY, token
        )

    @classmethod
    def _is_restore(cls, args: list[str]) -> bool:
        token = cls._maintenance_token(args)
        return args[-1] == watcher._bind_maintenance_token(
            watcher.PRODUCTION_RESTORE_ADMISSION_QUERY, token
        )

    def trip_fence(self) -> None:
        self.fenced = True
        self.enabled = False
        self.maintenance_token = None
        self.maintenance_started_at = None

    def capture(self, args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
        sql = args[-1]
        if "UPDATE sweeper_state" in sql and "SET enabled = false" in sql:
            assert self._is_pause(args)
            self.pause_calls += 1
            token = self._maintenance_token(args)
            if self.enabled and not self.fenced and self.maintenance_token is None:
                self.enabled = False
                self.maintenance_token = token
                self.maintenance_started_at = "2026-08-02T00:00:00+00:00"
                return subprocess.CompletedProcess(
                    args,
                    0,
                    stdout=json.dumps(
                        {
                            "enabled": False,
                            "admission_fence_active": False,
                            "maintenance_drain_token": token,
                            "maintenance_drain_started_at": self.maintenance_started_at,
                        }
                    ),
                )
            return subprocess.CompletedProcess(args, 0, stdout="")
        if "UPDATE sweeper_state" in sql and "SET enabled = true" in sql:
            assert self._is_restore(args)
            self.restore_calls += 1
            token = self._maintenance_token(args)
            if (
                not self.enabled
                and not self.fenced
                and self.maintenance_token == token
            ):
                self.enabled = True
                self.maintenance_token = None
                self.maintenance_started_at = None
                return subprocess.CompletedProcess(
                    args,
                    0,
                    stdout=json.dumps(
                        {
                            "enabled": True,
                            "admission_fence_active": False,
                            "maintenance_drain_token": None,
                            "maintenance_drain_started_at": None,
                        }
                    ),
                )
            return subprocess.CompletedProcess(args, 0, stdout="")
        if sql == watcher.PRODUCTION_ADMISSION_STATE_QUERY:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout=json.dumps(
                    {
                        "enabled": self.enabled,
                        "admission_fence_active": self.fenced,
                        "maintenance_drain_token": self.maintenance_token,
                        "maintenance_drain_started_at": self.maintenance_started_at,
                    }
                ),
            )
        raise AssertionError(f"unexpected production-drain capture: {args} / {timeout}")


class InterruptedInvocationSystem(ProductionDrainSystem):
    def __init__(
        self,
        *,
        engine_build_id: str = "previous-engine-build",
        process_lines: str = "",
    ) -> None:
        super().__init__()
        self.engine_build_id = engine_build_id
        self.process_lines = process_lines

    def capture(self, args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
        if args == ["ps", "-eo", "pid=,args="]:
            return subprocess.CompletedProcess(args, 0, stdout=self.process_lines)
        return super().capture(args, timeout)

    def fetch_json(self, url: str, timeout: float) -> dict[str, Any]:
        assert url == "http://127.0.0.1:8000/health"
        return {"build_id": self.engine_build_id}

    def invoke(self, args: list[str], log_path: Path, on_spawn) -> int:
        raise AssertionError("an interrupted invocation must never be replayed")


class PreSpawnFailureSystem(ProductionDrainSystem):
    def invoke(self, args: list[str], log_path: Path, on_spawn) -> int:
        self.invocations.append(args)
        raise watcher.ChildInvocationError(
            "synthetic log-open failure", child_spawned=False
        )


class PostSpawnTrackingFailureSystem(ProductionDrainSystem):
    def invoke(self, args: list[str], log_path: Path, on_spawn) -> int:
        self.invocations.append(args)
        log_path.write_text("child started\n", encoding="utf-8")
        log_path.chmod(0o600)
        on_spawn(5150)
        raise watcher.ChildInvocationError(
            "synthetic receipt failure after spawn", child_spawned=True
        )


class LostPauseResponseSystem(ProductionDrainSystem):
    def __init__(self) -> None:
        super().__init__()
        self.lose_pause_response = True

    def capture(self, args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
        if "SET enabled = false" in args[-1] and self.lose_pause_response:
            assert self._is_pause(args)
            committed = super().capture(args, timeout)
            assert committed.returncode == 0 and committed.stdout
            self.lose_pause_response = False
            return subprocess.CompletedProcess(
                args, 1, stdout="", stderr="synthetic connection loss after commit"
            )
        return super().capture(args, timeout)


class RemoteProbeSystem:
    def __init__(self, activity: dict[str, int], redis_depths: dict[str, int]) -> None:
        self.activity = activity
        self.redis_depths = redis_depths
        self.redis_probes: list[str] = []
        self.invocations = 0

    def capture(self, args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
        if args[-1] == watcher.REMOTE_MAINTENANCE_QUERY:
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(self.activity))
        if args[-2:] == ["-af", watcher.OPENFOAM_PROCESS_RE]:
            return subprocess.CompletedProcess(args, 1, stdout="")
        if args[-2] == "LLEN":
            queue = args[-1]
            self.redis_probes.append(queue)
            return subprocess.CompletedProcess(args, 0, stdout=str(self.redis_depths[queue]))
        raise AssertionError(f"unexpected remote preflight capture: {args} / {timeout}")

    def fetch_json(self, url: str, timeout: float) -> dict[str, Any]:
        return fresh_empty_queue()

    def invoke(self, args: list[str], log_path: Path, on_spawn) -> int:
        self.invocations += 1
        log_path.write_text("unexpected rebuild\n", encoding="utf-8")
        log_path.chmod(0o600)
        on_spawn(4242)
        return 0


class SequencedRemoteQueueProbeSystem(RemoteProbeSystem):
    def __init__(self, queues: list[dict[str, Any]]) -> None:
        super().__init__(
            {
                "live_jobs": 0,
                "terminal_completed_ingests": 0,
                "unsettled_deliveries": 0,
                "unsettled_cancellations": 0,
                "running_media_repairs": 0,
            },
            {queue: 0 for queue in watcher.REMOTE_REDIS_QUEUES},
        )
        self.queues = queues
        self.queue_fetches = 0
        self.queue_timeouts: list[float] = []

    def fetch_json(self, url: str, timeout: float) -> dict[str, Any]:
        assert url == "http://127.0.0.1:8000/queue"
        assert timeout > 0
        assert self.queue_fetches < len(self.queues)
        self.queue_timeouts.append(timeout)
        queue = self.queues[self.queue_fetches]
        self.queue_fetches += 1
        return queue


class ProductionProcessProbeSystem:
    def __init__(self) -> None:
        self.queried_workers: list[str] = []

    def capture(self, args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
        if args[:2] == ["docker", "ps"]:
            return subprocess.CompletedProcess(
                args,
                0,
                stdout="one\tworker\ntwo\tworker-opencfd-2606\nthree\tnode-api\n",
            )
        if args[-2:] == ["-af", watcher.OPENFOAM_PROCESS_RE]:
            self.queried_workers.append(args[2])
            return subprocess.CompletedProcess(args, 1, stdout="")
        raise AssertionError(f"unexpected worker-discovery capture: {args} / {timeout}")

    def fetch_json(self, url: str, timeout: float) -> dict[str, Any]:
        raise AssertionError("worker discovery does not fetch queue state")

    def invoke(self, args: list[str], log_path: Path, on_spawn) -> int:
        raise AssertionError("worker discovery does not invoke a rebuild")


class ProductionTimeoutRecoverySystem(ProductionDrainSystem):
    def __init__(self, *, helper_idle: bool = True, queue_error: BaseException | None = None) -> None:
        super().__init__()
        self.helper_idle = helper_idle
        self.queue_error = queue_error or TimeoutError("timed out")
        self.helper_calls = 0

    def capture(self, args: list[str], timeout: float) -> subprocess.CompletedProcess[str]:
        if args[-1] == watcher.LIVE_JOB_QUERY:
            return subprocess.CompletedProcess(args, 0, stdout="7\n")
        if args[:2] == ["docker", "ps"]:
            return subprocess.CompletedProcess(args, 0, stdout="worker-id\tworker\n")
        if args[-2:] == ["-af", watcher.OPENFOAM_PROCESS_RE]:
            return subprocess.CompletedProcess(args, 1, stdout="")
        if args[:2] == ["python3", str(args[1])] and "production_maintenance_preflight.py" in args[1]:
            self.helper_calls += 1
            task_count = 0 if self.helper_idle else 1
            payload = {
                "schemaVersion": 1,
                "observedAt": "2026-08-02T00:00:00+00:00",
                "phase": "observe",
                "idle": self.helper_idle,
                "runtime": {"build_id": "affected"},
                "openFoamProcessCount": 0,
                "queue": {
                    "taskCounts": {"active": task_count, "reserved": 0, "scheduled": 0},
                    "queueDepths": {"openfoam-opencfd-2606": 0},
                    "transportUnackedCounts": {"unacked": 0, "unacked_index": 0},
                    "workerCount": 1,
                },
                "blockingJobCount": 0,
                "blockingJobs": [],
                "terminalCandidateCount": 7,
                "terminalCandidates": [],
            }
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps(payload))
        return super().capture(args, timeout)

    def fetch_json(self, url: str, timeout: float) -> dict[str, Any]:
        assert url == "http://127.0.0.1:8000/queue"
        raise self.queue_error


class Clock:
    def __init__(self, step: float) -> None:
        self.value = 0.0
        self.step = step

    def __call__(self) -> float:
        value = self.value
        self.value += self.step
        return value


def make_config(tmp_path: Path, role: str = "production"):
    release = tmp_path / "release"
    deploy = release / "scripts" / "deploy"
    deploy.mkdir(parents=True)
    child_name = watcher.ROLE_CONTRACTS[role].rebuild_script
    child = deploy / child_name
    child.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    child.chmod(0o700)
    verifier = deploy / "deployment-source-manifest.py"
    shutil.copy2(ROOT / "scripts/deploy/deployment-source-manifest.py", verifier)
    verifier.chmod(0o700)
    (release / "docker-compose.deploy.yml").write_text(
        "services:\n  worker:\n    image: example.invalid/worker:test\n",
        encoding="utf-8",
    )
    revision = "a" * 40
    tree, file_count = watcher._source_tree(release)
    (release / ".deployment-source.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "sourceRevision": revision,
                "sourceTreeSha256": tree,
                "fileCount": file_count,
            }
        ),
        encoding="utf-8",
    )
    app = tmp_path / "app"
    app.symlink_to(release, target_is_directory=True)
    state = tmp_path / "state"
    return watcher.WatchConfig(
        role=role,
        build_id="test-build-v12",
        app_dir=app,
        state_dir=state,
        expected_revision=revision,
        expected_tree_sha256=tree,
        poll_seconds=5,
        stable_samples=2,
        deploy_lock_path=state / "deploy.lock",
    )


def prepare_interrupted_invocation(
    config: watcher.WatchConfig,
    system: InterruptedInvocationSystem,
    *,
    state: str = "invocation_prepared",
    child_spawned: bool = False,
    mutation_boundary: str = "pre_child",
) -> str:
    watcher._prepare_state_dir(config.state_dir)
    pin = watcher.verify_source_pin(config)
    watcher.materialize_pinned_child(config, pin)
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    system.enabled = False
    system.fenced = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"
    status = watcher._status_base(config, pin)
    status.update(
        state=state,
        preparedAt="2026-08-02T00:00:00+00:00",
        childSpawned=child_spawned,
        mutationBoundary=mutation_boundary,
        productionAdmissionDrain=watcher._drain_status(
            config, "paused_by_watcher", token
        ),
    )
    watcher._atomic_json(config.status_path, status)
    return token


def prepare_adoptable_prechild_receipt(
    config: watcher.WatchConfig,
    token: str,
    *,
    legacy_waiting_without_child_fields: bool = False,
) -> None:
    """Persist a real predecessor receipt without touching the DB fixture."""
    watcher._prepare_state_dir(config.state_dir)
    pin = watcher.verify_source_pin(config)
    if legacy_waiting_without_child_fields:
        status = {
            key: value
            for key, value in watcher._status_base(config, pin).items()
            if key
            not in {
                "adoptProductionDrainToken",
                "adoptProductionDrainPredecessorBuildId",
                "adoptProductionDrainRecoveryAttestation",
            }
        }
        status["schemaVersion"] = watcher.LEGACY_WATCHER_STATUS_SCHEMA_VERSION
        status.update(
            state="waiting",
            updatedAt="2026-08-02T16:30:00+00:00",
            stableSamples=1,
            requiredStableSamples=2,
            lastSnapshot=idle_snapshot().as_json(),
            productionAdmissionDrain=watcher._drain_status(
                config, "paused_by_watcher", token
            ),
        )
    else:
        status = watcher._status_base(config, pin)
        status.update(
            state="waiting",
            updatedAt="2026-08-02T16:30:00+00:00",
            stableSamples=1,
            requiredStableSamples=2,
            lastSnapshot=idle_snapshot().as_json(),
            productionAdmissionDrain=watcher._drain_status(
                config, "paused_by_watcher", token
            ),
        )
    watcher._atomic_json(config.status_path, status)


def prepare_postspawn_exit12_receipt(
    config: watcher.WatchConfig, token: str
) -> dict[str, Any]:
    watcher._prepare_state_dir(config.state_dir)
    pin = watcher.verify_source_pin(config)
    config.log_path.write_text(
        "Refusing engine rebuild at before service recreate because the engine queue probe failed:\n",
        encoding="utf-8",
    )
    config.log_path.chmod(0o600)
    status = watcher._status_base(config, pin)
    status.update(
        state="failed",
        startedAt="2026-08-02T16:47:00+00:00",
        finishedAt="2026-08-02T16:48:00+00:00",
        childPid=1234,
        childSpawned=True,
        mutationBoundary="child_spawned",
        childExitCode=12,
        logSha256=watcher._sha256(config.log_path),
        productionAdmissionDrain=watcher._drain_status(
            config, "paused_by_watcher", token
        ),
    )
    watcher._atomic_json(config.status_path, status)
    return status


def write_recovery_attestation(
    config: watcher.WatchConfig,
    status: dict[str, Any],
    token: str,
) -> Path:
    path = watcher._expected_preengine_recovery_attestation_path(
        config, config.build_id, token
    )
    value = {
        "schemaVersion": watcher.PREENGINE_RECOVERY_ATTESTATION_SCHEMA_VERSION,
        "kind": watcher.PREENGINE_RECOVERY_ATTESTATION_KIND,
        "createdAt": "2026-08-02T17:00:00+00:00",
        "maintenanceToken": token,
        "predecessor": {
            "statusPath": str(config.status_path),
            "statusSha256": watcher._sha256(config.status_path),
            "logPath": str(config.log_path),
            "logSha256": status["logSha256"],
            "buildId": config.build_id,
            "sourceRevision": status["sourceRevision"],
            "sourceTreeSha256": status["sourceTreeSha256"],
            "childExitCode": 12,
        },
        "expectedEngineBuildId": "previous-engine-build",
        "databaseAdmission": {
            "enabled": False,
            "admissionFenceActive": False,
            "maintenanceToken": token,
        },
        "deploymentEnvironment": {
            "airfoilfoamBuildId": "previous-engine-build",
            "engineExpectedBuildId": "previous-engine-build",
        },
        "containers": {
            "api": {
                "name": "app-api-1",
                "id": "api-id",
                "startedAt": "2026-08-02T15:00:00+00:00",
                "runtimeBuildId": "previous-engine-build",
            },
            "worker": {
                "name": "app-worker-1",
                "id": "worker-id",
                "startedAt": "2026-08-02T15:00:00+00:00",
                "runtimeBuildId": "previous-engine-build",
            },
        },
        "logProof": {
            "requiredMarker": (
                "Refusing engine rebuild at before service recreate because the engine queue probe failed:"
            ),
            "requiredMarkerCount": 1,
            "forbiddenMarkers": [
                "Updated AIRFOILFOAM_BUILD_ID and ENGINE_EXPECTED_BUILD_ID",
                "Engine serves build_id=",
                "Container app-api-1 Recreate",
                "Container app-worker-1 Recreate",
            ],
        },
    }
    watcher._atomic_json(path, value)
    return path


def idle_snapshot():
    return watcher.IdleSnapshot(
        live_jobs=0,
        openfoam_processes=(),
        queue_idle=True,
        queue_observed_at="2026-08-02T00:00:00+00:00",
    )


def busy_snapshot():
    return watcher.IdleSnapshot(
        live_jobs=1,
        openfoam_processes=("123 pimpleFoam",),
        queue_idle=False,
        queue_observed_at="2026-08-02T00:00:00+00:00",
    )


def fresh_empty_queue() -> dict[str, Any]:
    return {
        "queue_observation_state": "fresh",
        "queue_observed_at": watcher._utc_now(),
        "queue_refresh_in_progress": False,
        "queue_observation_error": None,
        "worker_queues_error": None,
        "worker_runtime_error": None,
        "inspection_errors": {},
        "queue_depth": 0,
        "default_queue_depth": 0,
        "queue_depths": {"openfoam-opencfd-2606": 0},
        "queue_enabled": {"openfoam-opencfd-2606": True},
        "active_count": 0,
        "reserved_count": 0,
        "scheduled_count": 0,
        "active": [],
        "reserved": [],
        "scheduled": [],
        "job_ids": [],
        "worker_queues": [
            {
                "worker": "celery@worker",
                "queues": ["openfoam-opencfd-2606"],
            }
        ],
        "inspection_workers": {
            "active": ["celery@worker"],
            "reserved": ["celery@worker"],
            "scheduled": ["celery@worker"],
        },
    }


def stale_refreshing_exact_zero_queue() -> dict[str, Any]:
    queue = fresh_empty_queue()
    queue["queue_observation_state"] = "stale"
    queue["queue_refresh_in_progress"] = True
    return queue


def test_maintenance_token_binding_is_canonical_complete_and_exactly_scoped():
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"

    pause = watcher._bind_maintenance_token(
        watcher.PRODUCTION_PAUSE_ADMISSION_QUERY, token
    )
    restore = watcher._bind_maintenance_token(
        watcher.PRODUCTION_RESTORE_ADMISSION_QUERY, token
    )
    for bound in (pause, restore):
        assert watcher.MAINTENANCE_TOKEN_BIND_MARKER not in bound
        assert bound.count(f"'{token}'::uuid") == 1
    assert f"SET enabled = false,\n    maintenance_drain_token = '{token}'::uuid" in pause
    assert f"AND maintenance_drain_token = '{token}'::uuid" in restore

    with pytest.raises(watcher.WatcherError, match="not canonical"):
        watcher._bind_maintenance_token(
            watcher.PRODUCTION_PAUSE_ADMISSION_QUERY, token.upper()
        )
    with pytest.raises(watcher.WatcherError, match="exactly one token marker"):
        watcher._bind_maintenance_token("SELECT 1", token)


def test_two_separated_idle_samples_invoke_only_the_guarded_production_child(tmp_path: Path):
    config = make_config(tmp_path)
    system = FakeSystem()
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 0
    invocation = system.invocations[0]
    release = config.app_dir.resolve()
    assert invocation[0] == "/usr/bin/env"
    assert "PINNED_WATCHER_INVOCATION=true" in invocation
    assert f"ACTIVE_APP_LINK={config.app_dir.absolute()}" in invocation
    assert f"APP_DIR={release}" in invocation
    assert f"COMPOSE_FILE={release / 'docker-compose.deploy.yml'}" in invocation
    assert f"DEPLOYMENT_MANIFEST_FILE={release / '.deployment-source.json'}" in invocation
    assert f"DEPLOY_SCRIPT_DIR={release / 'scripts/deploy'}" in invocation
    assert f"DEPLOY_SOURCE_REVISION={config.expected_revision}" in invocation
    assert f"DEPLOY_SOURCE_TREE_SHA256={config.expected_tree_sha256}" in invocation
    assert invocation.count(
        f"DEPLOY_SOURCE_TREE_SHA256={config.expected_tree_sha256}"
    ) == 1
    assert invocation.count(f"LOCK_FILE={config.deploy_lock_path}") == 1
    assert any(value.startswith("DEPLOY_SOURCE_VERIFIER=") for value in invocation)
    assert any(
        value.startswith("DEPLOY_SOURCE_VERIFIER_SHA256=") for value in invocation
    )
    assert invocation[-1] == "test-build-v12"
    assert invocation[-2] == str(
        config.state_dir / "guarded-engine-rebuild-production-test-build-v12.child"
    )
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "completed"
    assert status["childExitCode"] == 0
    assert config.status_path.stat().st_mode & 0o077 == 0


def test_activity_between_idle_samples_resets_the_stability_window(tmp_path: Path):
    config = make_config(tmp_path, role="remote-solver")
    system = FakeSystem()
    snapshots = iter(
        [idle_snapshot(), busy_snapshot(), idle_snapshot(), idle_snapshot()]
    )

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 0
    assert len(system.invocations) == 1
    assert system.invocations[0][-2].endswith(
        "guarded-engine-rebuild-remote-solver-test-build-v12.child"
    )


def test_source_drift_refuses_before_invocation(tmp_path: Path):
    config = make_config(tmp_path)
    system = FakeSystem()
    calls = 0

    def collect(_config, _system):
        nonlocal calls
        calls += 1
        if calls == 1:
            manifest = config.app_dir.resolve() / ".deployment-source.json"
            value = json.loads(manifest.read_text(encoding="utf-8"))
            value["sourceTreeSha256"] = "c" * 64
            manifest.write_text(json.dumps(value), encoding="utf-8")
        return idle_snapshot()

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=collect,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 12
    assert system.invocations == []
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "refused"


def test_active_app_symlink_switch_refuses_and_restores_owned_drain(tmp_path: Path):
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = ProductionDrainSystem()
    alternate = tmp_path / "alternate-release"
    alternate_deploy = alternate / "scripts" / "deploy"
    alternate_deploy.mkdir(parents=True)
    alternate_child = alternate_deploy / "rebuild-engine.sh"
    alternate_child.write_text("#!/bin/sh\necho alternate\n", encoding="utf-8")
    alternate_child.chmod(0o700)
    (alternate / ".deployment-source.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "sourceRevision": config.expected_revision,
                "sourceTreeSha256": config.expected_tree_sha256,
                "fileCount": 3,
            }
        ),
        encoding="utf-8",
    )
    calls = 0

    def collect(_config, _system):
        nonlocal calls
        calls += 1
        if calls == 1:
            config.app_dir.unlink()
            config.app_dir.symlink_to(alternate, target_is_directory=True)
        return idle_snapshot()

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=collect,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 12
    assert system.invocations == []
    assert system.pause_calls == 1
    assert system.restore_calls == 1
    assert system.enabled is True
    assert system.maintenance_token is None
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "refused"
    assert status["mutationBoundary"] == "pre_child"
    assert status["productionAdmissionDrain"]["state"] == "restored_before_child"


def test_pinned_child_content_drift_refuses_before_invocation(tmp_path: Path):
    config = make_config(tmp_path)
    system = FakeSystem()
    calls = 0

    def collect(_config, _system):
        nonlocal calls
        calls += 1
        if calls == 1:
            child = config.app_dir.resolve() / "scripts/deploy/rebuild-engine.sh"
            child.write_text("#!/bin/sh\necho changed\n", encoding="utf-8")
        return idle_snapshot()

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=collect,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 12
    assert system.invocations == []
    assert json.loads(config.status_path.read_text(encoding="utf-8"))["state"] == "refused"


def test_child_refusal_is_terminal_and_never_reinvoked(tmp_path: Path):
    config = make_config(tmp_path)
    system = FakeSystem(exit_code=23)
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 23
    assert len(system.invocations) == 1
    assert json.loads(config.status_path.read_text(encoding="utf-8"))["state"] == "failed"

    second = watcher.main(
        [
            "--role",
            config.role,
            "--build-id",
            config.build_id,
            "--expected-revision",
            config.expected_revision,
            "--expected-tree-sha256",
            config.expected_tree_sha256,
            "--app-dir",
            str(config.app_dir),
            "--state-dir",
            str(config.state_dir),
            "--poll-seconds",
            "5",
        ]
    )
    assert second == 12
    assert len(system.invocations) == 1


def test_watcher_contains_no_raw_engine_service_mutation():
    source = SCRIPT.read_text(encoding="utf-8")
    assert "docker compose" not in source
    assert "force-recreate" not in source
    assert "rebuild-engine.sh" in source
    assert "rebuild-remote-solver-engine.sh" in source


def test_queue_idle_requires_fresh_complete_worker_coverage():
    queue = fresh_empty_queue()

    assert watcher._require_zero_queue(queue, 90)[0] is True
    queue["inspection_workers"] = {"active": [], "reserved": [], "scheduled": []}
    assert watcher._require_zero_queue(queue, 90)[0] is False


def test_known_stale_refreshing_exact_zero_queue_reprobes_once_then_requires_fresh(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = make_config(tmp_path, role="remote-solver")
    stale = stale_refreshing_exact_zero_queue()
    stale[watcher.QUEUE_RESPONSE_HTTP_STATUS_KEY] = 503
    fresh = fresh_empty_queue()
    fresh[watcher.QUEUE_RESPONSE_HTTP_STATUS_KEY] = 200
    system = SequencedRemoteQueueProbeSystem(
        [stale, fresh]
    )
    delays: list[float] = []
    monkeypatch.setattr(watcher.time, "sleep", delays.append)
    monkeypatch.setattr(watcher.time, "monotonic", Clock(0.1))

    snapshot = watcher.collect_idle_snapshot(config, system)

    assert snapshot.idle is True
    assert system.queue_fetches == 2
    assert delays == [watcher.QUEUE_STALE_REFRESH_REPROBE_DELAY_SECONDS]


def test_two_live_length_stale_refreshes_require_two_fresh_idle_proofs_before_child(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = dataclass_replace(
        make_config(tmp_path, role="remote-solver"),
        probe_timeout_seconds=20,
        poll_seconds=5,
        stable_samples=2,
    )
    stale = stale_refreshing_exact_zero_queue()
    stale[watcher.QUEUE_RESPONSE_HTTP_STATUS_KEY] = 503
    fresh = fresh_empty_queue()
    fresh[watcher.QUEUE_RESPONSE_HTTP_STATUS_KEY] = 200
    queues = ([stale] * 35 + [fresh]) * 2
    system = SequencedRemoteQueueProbeSystem(queues)

    class WarmupClock:
        def __init__(self) -> None:
            self.value = 0.0

        def monotonic(self) -> float:
            return self.value

        def sleep(self, seconds: float) -> None:
            self.value += seconds

    warmup_clock = WarmupClock()
    monkeypatch.setattr(watcher.time, "monotonic", warmup_clock.monotonic)
    monkeypatch.setattr(watcher.time, "sleep", warmup_clock.sleep)

    outcome = watcher.run_watcher(
        config,
        system=system,
        sleep=lambda _seconds: None,
        monotonic=Clock(config.poll_seconds),
        max_iterations=2,
    )

    assert outcome == 0
    assert system.queue_fetches == 72
    assert system.invocations == 1
    assert warmup_clock.value == 70 * watcher.QUEUE_STALE_REFRESH_REPROBE_DELAY_SECONDS


def test_stale_queue_false_positives_never_trigger_the_warmup_reprobe(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = make_config(tmp_path, role="remote-solver")
    delays: list[float] = []
    monkeypatch.setattr(watcher.time, "sleep", delays.append)
    false_positives: list[dict[str, Any]] = []

    nonzero = stale_refreshing_exact_zero_queue()
    nonzero["active_count"] = 1
    false_positives.append(nonzero)
    errored = stale_refreshing_exact_zero_queue()
    errored["queue_observation_error"] = "refresh failed"
    false_positives.append(errored)
    incomplete = stale_refreshing_exact_zero_queue()
    incomplete.pop("inspection_workers")
    false_positives.append(incomplete)
    not_refreshing = stale_refreshing_exact_zero_queue()
    not_refreshing["queue_refresh_in_progress"] = False
    false_positives.append(not_refreshing)
    fresh_http_503 = fresh_empty_queue()
    fresh_http_503[watcher.QUEUE_RESPONSE_HTTP_STATUS_KEY] = 503
    false_positives.append(fresh_http_503)

    for queue in false_positives:
        system = SequencedRemoteQueueProbeSystem([queue])
        snapshot = watcher.collect_idle_snapshot(config, system)
        assert snapshot.idle is False
        assert system.queue_fetches == 1

    assert delays == []


def test_live_queue_probe_retains_a_503_body_as_stale_transport(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = json.dumps(stale_refreshing_exact_zero_queue()).encode("utf-8")
    response = watcher.error.HTTPError(
        "http://127.0.0.1:8000/queue",
        503,
        "refreshing",
        None,
        io.BytesIO(payload),
    )

    def raise_refreshing(*_args, **_kwargs):
        raise response

    monkeypatch.setattr(watcher.request, "urlopen", raise_refreshing)

    queue = watcher.LiveSystem().fetch_json("http://127.0.0.1:8000/queue", 1)

    assert queue[watcher.QUEUE_RESPONSE_HTTP_STATUS_KEY] == 503
    assert watcher._is_known_stale_refreshing_exact_zero_queue(queue) is True
    assert watcher._require_zero_queue(queue, 90)[0] is False


def test_stale_refresh_warmup_is_bounded_and_never_counts_as_idle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = dataclass_replace(
        make_config(tmp_path, role="remote-solver"), probe_timeout_seconds=60
    )
    system = SequencedRemoteQueueProbeSystem(
        [stale_refreshing_exact_zero_queue()] * 45
    )

    class WarmupClock:
        def __init__(self) -> None:
            self.value = 0.0
            self.delays: list[float] = []

        def monotonic(self) -> float:
            return self.value

        def sleep(self, seconds: float) -> None:
            self.delays.append(seconds)
            self.value += seconds

    warmup_clock = WarmupClock()
    monkeypatch.setattr(watcher.time, "sleep", warmup_clock.sleep)
    monkeypatch.setattr(watcher.time, "monotonic", warmup_clock.monotonic)

    outcome = watcher.run_watcher(
        config,
        system=system,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
        max_iterations=1,
    )

    assert outcome == 10
    assert system.queue_fetches == 45
    assert warmup_clock.value == watcher.QUEUE_STALE_REFRESH_WARMUP_SECONDS
    assert warmup_clock.delays == [
        watcher.QUEUE_STALE_REFRESH_REPROBE_DELAY_SECONDS
    ] * 45
    assert system.queue_timeouts[0] == watcher.QUEUE_STALE_REFRESH_WARMUP_SECONDS
    assert all(
        0 < timeout <= watcher.QUEUE_STALE_REFRESH_WARMUP_SECONDS
        for timeout in system.queue_timeouts
    )
    assert system.invocations == 0


def test_fresh_queue_response_completed_after_warmup_deadline_is_not_idle(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = dataclass_replace(
        make_config(tmp_path, role="remote-solver"), probe_timeout_seconds=60
    )

    class WarmupClock:
        value = 0.0

        def monotonic(self) -> float:
            return self.value

        def sleep(self, seconds: float) -> None:
            self.value += seconds

    warmup_clock = WarmupClock()

    class DeadlineCrossingSystem(SequencedRemoteQueueProbeSystem):
        def fetch_json(self, url: str, timeout: float) -> dict[str, Any]:
            queue = super().fetch_json(url, timeout)
            warmup_clock.value += watcher.QUEUE_STALE_REFRESH_WARMUP_SECONDS + 0.001
            return queue

    system = DeadlineCrossingSystem([fresh_empty_queue()])
    monkeypatch.setattr(watcher.time, "sleep", warmup_clock.sleep)
    monkeypatch.setattr(watcher.time, "monotonic", warmup_clock.monotonic)

    snapshot = watcher.collect_idle_snapshot(config, system)

    assert snapshot.idle is False
    assert snapshot.queue_idle is False
    assert snapshot.error is not None
    assert "exceeded its 45-second monotonic budget" in snapshot.error
    assert system.queue_timeouts == [watcher.QUEUE_STALE_REFRESH_WARMUP_SECONDS]


def test_remote_preflight_blocks_each_delivery_cancellation_media_and_redis_hazard(tmp_path: Path):
    config = make_config(tmp_path, role="remote-solver")
    base_activity = {
        "live_jobs": 0,
        "terminal_completed_ingests": 0,
        "unsettled_deliveries": 0,
        "unsettled_cancellations": 0,
        "running_media_repairs": 0,
    }
    zero_redis = {queue: 0 for queue in watcher.REMOTE_REDIS_QUEUES}
    hazards = (
        ("unsettled_deliveries", 1),
        ("unsettled_cancellations", 1),
        ("running_media_repairs", 1),
    )

    for key, value in hazards:
        activity = {**base_activity, key: value}
        system = RemoteProbeSystem(activity, zero_redis)
        snapshot = watcher.collect_idle_snapshot(config, system)
        assert snapshot.error is None
        assert snapshot.remote_preflight is not None
        assert snapshot.idle is False
        output_keys = {
            "unsettled_deliveries": "unsettledDeliveries",
            "unsettled_cancellations": "unsettledCancellations",
            "running_media_repairs": "runningMediaRepairs",
        }
        assert snapshot.remote_preflight.as_json()[output_keys[key]] == value

    redis_hazard = {**zero_redis, "openfoam-opencfd-2606": 1}
    system = RemoteProbeSystem(base_activity, redis_hazard)
    snapshot = watcher.collect_idle_snapshot(config, system)
    assert snapshot.error is None
    assert snapshot.remote_preflight is not None
    assert snapshot.idle is False
    assert snapshot.remote_preflight.redis_queue_depths == redis_hazard
    assert system.redis_probes == list(watcher.REMOTE_REDIS_QUEUES)

    # A blocker must fence the child invocation as well as mark the snapshot
    # non-idle.  The watcher remains in its read-only wait state.
    system = RemoteProbeSystem(
        {**base_activity, "unsettled_deliveries": 1}, zero_redis
    )
    outcome = watcher.run_watcher(
        config,
        system=system,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
        max_iterations=1,
    )
    assert outcome == 10
    assert system.invocations == 0


def test_remote_preflight_observes_but_does_not_block_on_exact_terminal_ingests(
    tmp_path: Path,
) -> None:
    config = make_config(tmp_path, role="remote-solver")
    activity = {
        "live_jobs": 0,
        "terminal_completed_ingests": 5,
        "unsettled_deliveries": 0,
        "unsettled_cancellations": 0,
        "running_media_repairs": 0,
    }
    zero_redis = {queue: 0 for queue in watcher.REMOTE_REDIS_QUEUES}
    system = RemoteProbeSystem(activity, zero_redis)

    snapshot = watcher.collect_idle_snapshot(config, system)

    assert snapshot.error is None
    assert snapshot.idle is True
    assert snapshot.remote_preflight is not None
    assert snapshot.remote_preflight.terminal_completed_ingests == 5
    assert snapshot.remote_preflight.as_json()["terminalCompletedIngests"] == 5


def test_remote_terminal_ingest_exemption_is_exact_and_other_ingests_block() -> None:
    query = watcher.REMOTE_MAINTENANCE_QUERY

    assert "status IN ('pending','submitted','running')" in query
    assert "status = 'ingesting'" in query
    assert "engine_state IS DISTINCT FROM 'completed'" in query
    assert "OR engine_job_id IS NULL" in query
    assert "OR btrim(engine_job_id) = ''" in query
    assert "engine_state = 'completed'" in query
    assert "engine_job_id IS NOT NULL" in query
    assert "btrim(engine_job_id) <> ''" in query
    assert "terminal_completed_ingests" in query
    assert "status IN ('pending','submitted','running','ingesting')" not in query


def test_production_worker_discovery_probes_every_running_worker_service(tmp_path: Path):
    config = make_config(tmp_path)
    system = ProductionProcessProbeSystem()

    assert watcher._capture_openfoam_processes(config, system) == ()
    assert system.queried_workers == ["one", "two"]


def test_owned_production_drain_uses_exact_legacy_timeout_preflight_and_passes_token(
    tmp_path: Path,
) -> None:
    config = dataclass_replace(
        make_config(tmp_path), drain_production_admission=True
    )
    system = ProductionTimeoutRecoverySystem()

    outcome = watcher.run_watcher(
        config,
        system=system,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 0
    assert system.helper_calls == 2
    assert len(system.invocations) == 1
    token_env = [
        value
        for value in system.invocations[0]
        if value.startswith("PRODUCTION_MAINTENANCE_DRAIN_TOKEN=")
    ]
    assert len(token_env) == 1
    token = token_env[0].split("=", 1)[1]
    assert token == str(__import__("uuid").UUID(token))
    assert system.invocations[0].count(
        f"AIRFOILS_PRO_STATE_DIR={config.state_dir.absolute()}"
    ) == 1
    assert system.invocations[0].count(
        "PRODUCTION_MAINTENANCE_RECEIPT_FILE="
        f"{config.state_dir.absolute() / 'production-legacy-gateway-reconciliation.json'}"
    ) == 1


def test_production_child_overrides_hostile_inherited_receipt_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    config = dataclass_replace(
        make_config(tmp_path), drain_production_admission=True
    )
    monkeypatch.setenv("AIRFOILS_PRO_STATE_DIR", "/tmp/attacker-state")
    monkeypatch.setenv(
        "PRODUCTION_MAINTENANCE_RECEIPT_FILE", "/tmp/attacker-receipt.json"
    )
    system = ProductionTimeoutRecoverySystem()

    assert watcher.run_watcher(
        config,
        system=system,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    ) == 0

    invocation = system.invocations[0]
    assert "AIRFOILS_PRO_STATE_DIR=/tmp/attacker-state" not in invocation
    assert "PRODUCTION_MAINTENANCE_RECEIPT_FILE=/tmp/attacker-receipt.json" not in invocation
    assert f"AIRFOILS_PRO_STATE_DIR={config.state_dir.absolute()}" in invocation
    assert (
        "PRODUCTION_MAINTENANCE_RECEIPT_FILE="
        f"{config.state_dir.absolute() / 'production-legacy-gateway-reconciliation.json'}"
        in invocation
    )


def test_legacy_timeout_preflight_never_overrides_direct_queue_activity(
    tmp_path: Path,
) -> None:
    config = dataclass_replace(
        make_config(tmp_path), drain_production_admission=True
    )
    system = ProductionTimeoutRecoverySystem(helper_idle=False)

    outcome = watcher.run_watcher(
        config,
        system=system,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
        max_iterations=1,
    )

    assert outcome == 10
    assert system.invocations == []
    assert system.enabled is False


def test_non_timeout_queue_error_never_uses_production_maintenance_preflight(
    tmp_path: Path,
) -> None:
    config = dataclass_replace(
        make_config(tmp_path), drain_production_admission=True
    )
    system = ProductionTimeoutRecoverySystem(
        queue_error=ConnectionRefusedError("connection refused")
    )

    outcome = watcher.run_watcher(
        config,
        system=system,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
        max_iterations=1,
    )

    assert outcome == 10
    assert system.helper_calls == 0
    assert system.invocations == []


def test_production_drain_pauses_then_restores_only_after_child_success(tmp_path: Path):
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = ProductionDrainSystem()
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 0
    assert system.pause_calls == 1
    assert system.restore_calls == 1
    assert system.enabled is True
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["productionAdmissionDrain"]["requested"] is True
    assert (
        status["productionAdmissionDrain"]["state"]
        == "restored_after_child_success"
    )
    assert "token" in status["productionAdmissionDrain"]


def test_successor_watcher_adopts_existing_drain_without_reopening_admission(
    tmp_path: Path,
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    predecessor = dataclass_replace(
        make_config(tmp_path),
        drain_production_admission=True,
    )
    prepare_adoptable_prechild_receipt(predecessor, token)
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 0
    assert system.pause_calls == 0
    assert system.restore_calls == 1
    assert system.enabled is True
    assert system.maintenance_token is None
    invocation = system.invocations[0]
    assert f"PRODUCTION_MAINTENANCE_DRAIN_TOKEN={token}" in invocation
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["adoptProductionDrainToken"] == token
    assert status["productionAdmissionDrain"]["state"] == "restored_after_child_success"


def test_successor_adoption_replaces_only_a_prechild_old_release_receipt(
    tmp_path: Path,
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    old_config = dataclass_replace(
        make_config(tmp_path), drain_production_admission=True
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"
    watcher._prepare_state_dir(old_config.state_dir)
    old_pin = watcher.verify_source_pin(old_config)
    old_status = watcher._status_base(old_config, old_pin)
    old_status.update(
        state="waiting",
        updatedAt="2026-08-02T16:30:00+00:00",
        stableSamples=1,
        requiredStableSamples=2,
        lastSnapshot=idle_snapshot().as_json(),
        productionAdmissionDrain=watcher._drain_status(
            old_config, "paused_by_watcher", token
        ),
    )
    watcher._atomic_json(old_config.status_path, old_status)

    successor_release = tmp_path / "successor-release"
    shutil.copytree(old_config.app_dir.resolve(), successor_release)
    successor_child = (
        successor_release
        / "scripts"
        / "deploy"
        / watcher.ROLE_CONTRACTS["production"].rebuild_script
    )
    successor_child.write_text("#!/bin/sh\n# successor release\nexit 0\n", encoding="utf-8")
    successor_child.chmod(0o700)
    successor_revision = "b" * 40
    successor_tree, successor_count = watcher._source_tree(successor_release)
    (successor_release / ".deployment-source.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "sourceRevision": successor_revision,
                "sourceTreeSha256": successor_tree,
                "fileCount": successor_count,
            }
        ),
        encoding="utf-8",
    )
    old_config.app_dir.unlink()
    old_config.app_dir.symlink_to(successor_release, target_is_directory=True)
    config = dataclass_replace(
        old_config,
        build_id="test-build-v13",
        expected_revision=successor_revision,
        expected_tree_sha256=successor_tree,
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=old_config.build_id,
    )
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 0
    assert system.pause_calls == 0
    assert system.restore_calls == 1
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["sourceRevision"] == successor_revision
    assert status["adoptProductionDrainToken"] == token
    assert status["productionAdmissionDrain"]["state"] == "restored_after_child_success"


def test_successor_adoption_accepts_exact_legacy_waiting_chain_history(
    tmp_path: Path,
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    legacy = dataclass_replace(
        make_config(tmp_path),
        build_id="test-build-v11",
        drain_production_admission=True,
    )
    predecessor = dataclass_replace(
        legacy,
        build_id="test-build-v12",
    )
    prepare_adoptable_prechild_receipt(
        legacy,
        token,
        legacy_waiting_without_child_fields=True,
    )
    prepare_adoptable_prechild_receipt(predecessor, token)
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    assert watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    ) == 0
    assert len(system.invocations) == 1
    assert system.restore_calls == 1


def test_successor_adoption_can_select_the_exact_production_captured_legacy_v2_waiting_receipt(
    tmp_path: Path,
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    predecessor = dataclass_replace(
        make_config(tmp_path), drain_production_admission=True
    )
    prepare_adoptable_prechild_receipt(
        predecessor,
        token,
        legacy_waiting_without_child_fields=True,
    )
    captured = json.loads(predecessor.status_path.read_text(encoding="utf-8"))
    assert set(captured) == watcher.CAPTURED_LEGACY_V2_WAITING_STATUS_KEYS
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    assert watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    ) == 0
    assert len(system.invocations) == 1
    assert system.restore_calls == 1


@pytest.mark.parametrize("near_miss", ["extra", "missing", "changed"])
def test_successor_adoption_rejects_near_miss_production_captured_legacy_v2_receipts(
    tmp_path: Path, near_miss: str
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    predecessor = dataclass_replace(
        make_config(tmp_path), drain_production_admission=True
    )
    prepare_adoptable_prechild_receipt(
        predecessor,
        token,
        legacy_waiting_without_child_fields=True,
    )
    receipt = json.loads(predecessor.status_path.read_text(encoding="utf-8"))
    if near_miss == "extra":
        receipt["unexpectedLegacyField"] = "unsafe"
    elif near_miss == "missing":
        del receipt["logPath"]
    else:
        receipt["productionAdmissionDrainRequested"] = False
    watcher._atomic_json(predecessor.status_path, receipt)
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"

    with pytest.raises(watcher.WatcherError, match="may have crossed"):
        watcher.run_watcher(config, system=system)
    assert system.invocations == []
    assert system.restore_calls == 0
    assert system.maintenance_token == token


def test_successor_adoption_rejects_postspawn_failure_without_audited_attestation(
    tmp_path: Path,
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    predecessor = dataclass_replace(
        make_config(tmp_path), drain_production_admission=True
    )
    prepare_postspawn_exit12_receipt(predecessor, token)
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"

    with pytest.raises(watcher.WatcherError, match="requires a recovery attestation"):
        watcher.run_watcher(config, system=system)
    assert system.invocations == []
    assert system.restore_calls == 0
    assert system.maintenance_token == token


def test_successor_adoption_accepts_audited_postspawn_exit12_and_reproves_in_child(
    tmp_path: Path,
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    predecessor = dataclass_replace(
        make_config(tmp_path), drain_production_admission=True
    )
    status = prepare_postspawn_exit12_receipt(predecessor, token)
    attestation = write_recovery_attestation(predecessor, status, token)
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
        adopt_production_drain_recovery_attestation=attestation,
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    assert watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    ) == 0
    invocation = system.invocations[0]
    assert f"PRODUCTION_PREENGINE_RECOVERY_ATTESTATION={attestation}" in invocation
    assert "PRODUCTION_PREENGINE_RECOVERY_PREDECESSOR_BUILD_ID=test-build-v12" in invocation
    assert (
        "PRODUCTION_PREENGINE_RECOVERY_EXPECTED_ENGINE_BUILD_ID=previous-engine-build"
        in invocation
    )
    assert system.restore_calls == 1


def test_successor_adoption_rejects_a_second_postspawn_receipt_for_the_same_token(
    tmp_path: Path,
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    earlier = dataclass_replace(
        make_config(tmp_path),
        build_id="test-build-v11",
        drain_production_admission=True,
    )
    predecessor = dataclass_replace(earlier, build_id="test-build-v12")
    prepare_postspawn_exit12_receipt(earlier, token)
    prepare_adoptable_prechild_receipt(predecessor, token)
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"

    with pytest.raises(watcher.WatcherError, match="another post-spawn"):
        watcher.run_watcher(config, system=system)
    assert system.invocations == []
    assert system.restore_calls == 0


@pytest.mark.parametrize(
    ("corrupt_drain", "message"),
    [
        (
            {
                "requested": True,
                "state": "unrecognised_changed_state",
                "token": "ed075d95-221d-4a45-af7c-2ae8f3518a2e",
            },
            "noncanonical exact-token drain",
        ),
        (
            {
                "requested": False,
                "state": "paused_by_watcher",
                "token": "ed075d95-221d-4a45-af7c-2ae8f3518a2e",
            },
            "noncanonical exact-token drain",
        ),
        (
            ["malformed-token-carrier", "ed075d95-221d-4a45-af7c-2ae8f3518a2e"],
            "malformed exact-token drain",
        ),
    ],
)
def test_successor_adoption_rejects_changed_or_malformed_exact_token_chain_receipts(
    tmp_path: Path, corrupt_drain: object, message: str
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    earlier = dataclass_replace(
        make_config(tmp_path),
        build_id="test-build-v11",
        drain_production_admission=True,
    )
    status = prepare_postspawn_exit12_receipt(earlier, token)
    status["productionAdmissionDrain"] = corrupt_drain
    watcher._atomic_json(earlier.status_path, status)
    predecessor = dataclass_replace(earlier, build_id="test-build-v12")
    prepare_adoptable_prechild_receipt(predecessor, token)
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"

    with pytest.raises(watcher.WatcherError, match=message):
        watcher.run_watcher(config, system=system)
    assert system.invocations == []
    assert system.restore_calls == 0
    assert system.maintenance_token == token


def test_successor_adoption_ignores_malformed_receipts_for_an_unrelated_token(
    tmp_path: Path,
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    unrelated_token = "72a6b93a-3789-4e6e-b3db-1d6a15c7dc01"
    earlier = dataclass_replace(
        make_config(tmp_path),
        build_id="test-build-v11",
        drain_production_admission=True,
    )
    status = prepare_postspawn_exit12_receipt(earlier, unrelated_token)
    status["productionAdmissionDrain"] = ["malformed-token-carrier", unrelated_token]
    watcher._atomic_json(earlier.status_path, status)
    predecessor = dataclass_replace(earlier, build_id="test-build-v12")
    prepare_adoptable_prechild_receipt(predecessor, token)
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    assert watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    ) == 0
    assert len(system.invocations) == 1
    assert system.restore_calls == 1


def test_official_engine_child_reproves_a_recovery_attestation_after_its_deploy_lock() -> None:
    script = (ROOT / "scripts/deploy/rebuild-engine.sh").read_text(encoding="utf-8")
    function_index = script.index("verify_preengine_recovery_attestation_under_lock()")
    child_lock_index = script.index("flock -n 9 ||", script.index("main()"))
    invocation_index = script.index(
        "verify_preengine_recovery_attestation_under_lock || exit $?",
        child_lock_index,
    )
    first_mutation_banner_index = script.index("Engine rebuild starting: BUILD_ID=$BUILD_ID")

    assert function_index < child_lock_index
    assert child_lock_index < invocation_index < first_mutation_banner_index
    assert "attest-guarded-production-preengine-failure.py" in script
    assert "--verify-existing" in script


def test_adopted_production_drain_is_preserved_on_prechild_source_refusal(
    tmp_path: Path,
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    predecessor = dataclass_replace(
        make_config(tmp_path),
        drain_production_admission=True,
    )
    prepare_adoptable_prechild_receipt(predecessor, token)
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
    )
    system = ProductionDrainSystem()
    system.enabled = False
    system.maintenance_token = token
    system.maintenance_started_at = "2026-08-02T00:00:00+00:00"
    alternate = tmp_path / "alternate-release"
    alternate.mkdir()
    calls = 0

    def collect(_config, _system):
        nonlocal calls
        calls += 1
        if calls == 1:
            config.app_dir.unlink()
            config.app_dir.symlink_to(alternate, target_is_directory=True)
        return idle_snapshot()

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=collect,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 12
    assert system.invocations == []
    assert system.pause_calls == 0
    assert system.restore_calls == 0
    assert system.enabled is False
    assert system.maintenance_token == token
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "refused"
    assert status["productionAdmissionDrain"] == {
        "requested": True,
        "state": "adopted_pause_preserved",
        "token": token,
    }


@pytest.mark.parametrize(
    ("enabled", "fenced", "stored_token"),
    [
        (False, False, None),
        (False, False, "72a6b93a-3789-4e6e-b3db-1d6a15c7dc01"),
        (True, False, "ed075d95-221d-4a45-af7c-2ae8f3518a2e"),
        (False, True, "ed075d95-221d-4a45-af7c-2ae8f3518a2e"),
    ],
)
def test_successor_drain_adoption_rejects_any_nonexact_paused_owner(
    tmp_path: Path, enabled: bool, fenced: bool, stored_token: str | None
) -> None:
    token = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
    predecessor = dataclass_replace(
        make_config(tmp_path),
        drain_production_admission=True,
    )
    prepare_adoptable_prechild_receipt(predecessor, token)
    config = dataclass_replace(
        predecessor,
        build_id="test-build-v13",
        adopt_production_drain_token=token,
        adopt_production_drain_predecessor_build_id=predecessor.build_id,
    )
    system = ProductionDrainSystem()
    system.enabled = enabled
    system.fenced = fenced
    system.maintenance_token = stored_token
    system.maintenance_started_at = (
        "2026-08-02T00:00:00+00:00" if stored_token is not None else None
    )

    outcome = watcher.run_watcher(config, system=system)

    assert outcome == 12
    assert system.invocations == []
    assert system.pause_calls == 0
    assert system.restore_calls == 0
    assert system.enabled is enabled
    assert system.fenced is fenced
    assert system.maintenance_token == stored_token
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "refused"


@pytest.mark.parametrize(
    "arguments",
    [
        ["--role", "production", "--build-id", "test", "--expected-revision", "a" * 40, "--expected-tree-sha256", "b" * 64, "--adopt-production-drain-token", "ed075d95-221d-4a45-af7c-2ae8f3518a2e"],
        ["--role", "remote-solver", "--build-id", "test", "--expected-revision", "a" * 40, "--expected-tree-sha256", "b" * 64, "--drain-production-admission", "--adopt-production-drain-token", "ed075d95-221d-4a45-af7c-2ae8f3518a2e"],
        ["--role", "production", "--build-id", "test", "--expected-revision", "a" * 40, "--expected-tree-sha256", "b" * 64, "--drain-production-admission", "--adopt-production-drain-token", "ED075D95-221D-4A45-AF7C-2AE8F3518A2E"],
    ],
)
def test_drain_adoption_cli_rejects_other_modes_and_noncanonical_tokens(
    arguments: list[str],
) -> None:
    with pytest.raises(SystemExit, match="2"):
        watcher._parse_args(arguments)


def test_production_drain_stays_paused_when_the_guarded_child_fails(tmp_path: Path):
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = ProductionDrainSystem(exit_code=23)
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 23
    assert system.pause_calls == 1
    assert system.restore_calls == 0
    assert system.enabled is False
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "failed"
    assert status["productionAdmissionDrain"]["requested"] is True
    assert status["productionAdmissionDrain"]["state"] == "paused_by_watcher"
    assert status["productionAdmissionDrain"]["token"] == system.maintenance_token


def test_production_drain_resume_reuses_the_durable_pause_without_repausing(
    tmp_path: Path,
):
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = ProductionDrainSystem()

    first = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: busy_snapshot(),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
        max_iterations=1,
    )
    assert first == 10
    assert system.enabled is False
    assert system.pause_calls == 1
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["productionAdmissionDrain"]["state"] == "paused_by_watcher"

    snapshots = iter([idle_snapshot(), idle_snapshot()])
    second = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert second == 0
    assert system.pause_calls == 1
    assert system.restore_calls == 1
    assert system.enabled is True


def test_production_drain_never_restores_when_a_safety_fence_appears(tmp_path: Path):
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = ProductionDrainSystem()
    calls = 0

    def collect(_config, _system):
        nonlocal calls
        calls += 1
        if calls == 1:
            system.trip_fence()
        return idle_snapshot()

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=collect,
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 12
    assert system.invocations == []
    assert system.enabled is False
    assert system.restore_calls == 0
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "refused"
    assert status["productionAdmissionDrain"]["requested"] is True
    assert (
        status["productionAdmissionDrain"]["state"]
        == "restore_refused_fence_active"
    )


def test_crash_after_database_pause_before_file_receipt_recovers_exact_owner(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = ProductionDrainSystem()
    original_atomic_json = watcher._atomic_json
    injected = False

    def crash_before_pause_receipt(path: Path, payload: dict[str, Any]) -> None:
        nonlocal injected
        if not injected and payload.get("state") == "admission_drain_paused":
            injected = True
            raise OSError("synthetic crash before durable pause receipt")
        original_atomic_json(path, payload)

    monkeypatch.setattr(watcher, "_atomic_json", crash_before_pause_receipt)
    with pytest.raises(OSError, match="synthetic crash"):
        watcher.run_watcher(
            config,
            system=system,
            collect=lambda _config, _system: idle_snapshot(),
            sleep=lambda _seconds: None,
            monotonic=Clock(5),
        )

    assert system.enabled is False
    assert system.maintenance_token is not None
    intent = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert intent["state"] == "drain_intent_recorded"
    assert (
        intent["productionAdmissionDrain"]["token"] == system.maintenance_token
    )

    monkeypatch.setattr(watcher, "_atomic_json", original_atomic_json)
    snapshots = iter([idle_snapshot(), idle_snapshot()])
    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 0
    assert system.pause_calls == 1
    assert system.restore_calls == 1
    assert system.enabled is True
    assert system.maintenance_token is None


def test_lost_pause_response_recovers_from_database_token(tmp_path: Path):
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = LostPauseResponseSystem()
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 0
    assert system.pause_calls == 1
    assert system.restore_calls == 1
    assert system.enabled is True
    assert system.maintenance_token is None


def test_pre_spawn_invocation_failure_restores_owned_drain(tmp_path: Path):
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = PreSpawnFailureSystem()
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 12
    assert system.restore_calls == 1
    assert system.enabled is True
    assert system.maintenance_token is None
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "refused"
    assert status["childSpawned"] is False
    assert status["productionAdmissionDrain"]["state"] == "restored_before_child"


def test_post_spawn_tracking_failure_preserves_owned_drain(tmp_path: Path):
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = PostSpawnTrackingFailureSystem()
    snapshots = iter([idle_snapshot(), idle_snapshot()])

    outcome = watcher.run_watcher(
        config,
        system=system,
        collect=lambda _config, _system: next(snapshots),
        sleep=lambda _seconds: None,
        monotonic=Clock(5),
    )

    assert outcome == 12
    assert system.restore_calls == 0
    assert system.enabled is False
    assert system.maintenance_token is not None
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "failed"
    assert status["childSpawned"] is True
    assert status["mutationBoundary"] == "child_spawned"


def test_restart_after_proven_prechild_crash_restores_exact_owned_pause_without_replay(
    tmp_path: Path,
) -> None:
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = InterruptedInvocationSystem()
    token = prepare_interrupted_invocation(config, system)

    outcome = watcher.run_watcher(config, system=system)

    assert outcome == 12
    assert system.restore_calls == 1
    assert system.enabled is True
    assert system.maintenance_token is None
    assert system.invocations == []
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "recovered_prechild_crash"
    assert status["recoveryFromState"] == "invocation_prepared"
    assert status["childSpawned"] is False
    assert status["productionAdmissionDrain"] == {
        "requested": True,
        "state": "restored_before_child",
        "token": token,
    }
    assert status["recoveryEvidence"]["deployLockState"] == "acquired"
    assert status["recoveryEvidence"]["engineBuildId"] == "previous-engine-build"


@pytest.mark.parametrize("ambiguity", ["log", "process", "target_build", "spawn_receipt"])
def test_restart_preserves_pause_when_child_boundary_is_ambiguous_or_crossed(
    tmp_path: Path, ambiguity: str
) -> None:
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = InterruptedInvocationSystem(
        engine_build_id=(
            config.build_id if ambiguity == "target_build" else "previous-engine-build"
        )
    )
    state = "child_spawned" if ambiguity == "spawn_receipt" else "invocation_prepared"
    prepare_interrupted_invocation(
        config,
        system,
        state=state,
        child_spawned=ambiguity == "spawn_receipt",
        mutation_boundary=(
            "child_spawned" if ambiguity == "spawn_receipt" else "pre_child"
        ),
    )
    if ambiguity == "log":
        config.log_path.write_text("child log was opened\n", encoding="utf-8")
        config.log_path.chmod(0o600)
    elif ambiguity == "process":
        system.process_lines = (
            "4242 /usr/bin/env PINNED_WATCHER_INVOCATION=true "
            f"{config.state_dir / 'guarded-engine-rebuild-production-test-build-v12.child'} "
            f"{config.build_id}\n"
        )

    outcome = watcher.run_watcher(config, system=system)

    assert outcome == 12
    assert system.restore_calls == 0
    assert system.enabled is False
    assert system.maintenance_token is not None
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "recovery_blocked_ambiguous_child"
    assert status["mutationBoundary"] == "child_may_have_spawned"
    assert status["productionAdmissionDrain"]["state"] == "paused_by_watcher"
    assert system.invocations == []


def test_restart_preserves_pause_while_official_deploy_lock_is_held(
    tmp_path: Path,
) -> None:
    config = dataclass_replace(make_config(tmp_path), drain_production_admission=True)
    system = InterruptedInvocationSystem()
    prepare_interrupted_invocation(config, system)
    descriptor = os.open(config.deploy_lock_path, os.O_RDWR | os.O_CREAT, 0o600)
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    try:
        outcome = watcher.run_watcher(config, system=system)
    finally:
        os.close(descriptor)

    assert outcome == 12
    assert system.restore_calls == 0
    assert system.enabled is False
    status = json.loads(config.status_path.read_text(encoding="utf-8"))
    assert status["state"] == "recovery_blocked_ambiguous_child"
    assert status["recoveryEvidence"]["deployLockState"] == "held"
