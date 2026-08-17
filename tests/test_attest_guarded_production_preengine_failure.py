from __future__ import annotations

import hashlib
import importlib.util
import json
from pathlib import Path
import stat
import sys
from typing import Any

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/deploy/attest-guarded-production-preengine-failure.py"
SPEC = importlib.util.spec_from_file_location("preengine_recovery_attester", SCRIPT)
assert SPEC and SPEC.loader
attester = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = attester
SPEC.loader.exec_module(attester)


TOKEN = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
PREDECESSOR_BUILD = "5a7cbc9"
OLD_ENGINE_BUILD = "1f434e"


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_private_json(path: Path, value: dict[str, Any]) -> None:
    path.write_text(json.dumps(value), encoding="utf-8")
    path.chmod(0o600)


def _legacy_failure_receipt(state_dir: Path) -> tuple[Path, Path, dict[str, Any]]:
    state_dir.mkdir(mode=0o700)
    state_dir.chmod(0o700)
    log_path = state_dir / f"guarded-engine-rebuild-production-{PREDECESSOR_BUILD}.log"
    log_path.write_text(
        "preflight succeeded\n"
        "Refusing engine rebuild at before service recreate because the engine queue probe failed:\n",
        encoding="utf-8",
    )
    log_path.chmod(0o600)
    status_path = state_dir / f"guarded-engine-rebuild-production-{PREDECESSOR_BUILD}.json"
    values = {
        "schemaVersion": 2,
        "role": "production",
        "buildId": PREDECESSOR_BUILD,
        "sourceRevision": "a" * 40,
        "sourceTreeSha256": "b" * 64,
        "releasePath": "/opt/airfoils-pro/releases/old",
        "releaseDevice": 1,
        "releaseInode": 2,
        "childScriptSha256": "c" * 64,
        "pinnedChildPath": str(state_dir / "guarded-engine-rebuild-production-5a7cbc9.child"),
        "sourceVerifierSha256": "d" * 64,
        "pinnedSourceVerifierPath": str(state_dir / "guarded-engine-rebuild-production-5a7cbc9.verifier"),
        "logPath": str(log_path),
        "productionAdmissionDrainRequested": True,
        "adoptProductionDrainToken": None,
        "state": "failed",
        "startedAt": "2026-08-02T16:47:00+00:00",
        "finishedAt": "2026-08-02T16:48:00+00:00",
        "childPid": 1234,
        "childSpawned": True,
        "mutationBoundary": "child_spawned",
        "childExitCode": 12,
        "logSha256": _sha256(log_path),
        "productionAdmissionDrain": {
            "requested": True,
            "state": "paused_by_watcher",
            "token": TOKEN,
        },
    }
    assert set(values) == attester.LEGACY_POSTSPAWN_FAILURE_STATUS_KEYS
    _write_private_json(status_path, values)
    env_path = state_dir / ".env.deploy"
    env_path.write_text(
        f"AIRFOILFOAM_BUILD_ID={OLD_ENGINE_BUILD}\n"
        f"ENGINE_EXPECTED_BUILD_ID={OLD_ENGINE_BUILD}\n",
        encoding="utf-8",
    )
    env_path.chmod(0o600)
    return status_path, log_path, values


def _install_live_probe_stub(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    live: dict[str, Any] = {
        "api_id": "app-api-1-id",
        "worker_id": "app-worker-1-id",
        "api_build": OLD_ENGINE_BUILD,
        "worker_build": OLD_ENGINE_BUILD,
        "environment_build": OLD_ENGINE_BUILD,
        "database_token": TOKEN,
        "processes": "",
    }

    def fake_run(args: list[str], timeout: float, label: str) -> str:
        if args == ["ps", "-eo", "pid=,args="]:
            return str(live["processes"])
        if args[:3] == ["docker", "inspect", "--format"]:
            name = args[-1]
            key = "api" if name == "app-api-1" else "worker"
            return json.dumps(
                {
                    "Id": live[f"{key}_id"],
                    "State": {"Running": True, "StartedAt": "2026-08-02T15:00:00+00:00"},
                    "Config": {"Env": [f"AIRFOILFOAM_BUILD_ID={live[f'{key}_build']}"]},
                }
            )
        if args[:3] == ["docker", "exec", "app-postgres-1"]:
            return json.dumps(
                {
                    "enabled": False,
                    "admission_fence_active": False,
                    "maintenance_drain_token": live["database_token"],
                }
            )
        if args[:3] == ["docker", "exec", "app-api-1"] or args[:3] == ["docker", "exec", "app-worker-1"]:
            key = "api" if args[2] == "app-api-1" else "worker"
            return f"{live[f'{key}_build']}\n"
        raise AssertionError(f"unexpected live command ({label}): {args}")

    monkeypatch.setattr(attester, "_run", fake_run)
    return live


def test_auditor_certifies_the_exact_legacy_v2_incident_then_reproves_it(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state_dir = tmp_path / "state"
    _legacy_failure_receipt(state_dir)
    _install_live_probe_stub(monkeypatch)

    output = attester.audit_and_attest(
        state_dir=state_dir,
        predecessor_build_id=PREDECESSOR_BUILD,
        maintenance_token=TOKEN,
        expected_engine_build_id=OLD_ENGINE_BUILD,
        timeout=5,
    )

    assert stat.S_IMODE(output.stat().st_mode) == 0o600
    payload = json.loads(output.read_text(encoding="utf-8"))
    assert payload["predecessor"]["buildId"] == PREDECESSOR_BUILD
    assert payload["databaseAdmission"]["maintenanceToken"] == TOKEN
    assert payload["containers"]["api"]["runtimeBuildId"] == OLD_ENGINE_BUILD
    assert payload["logProof"]["requiredMarkerCount"] == 1
    assert attester.audit_and_attest(
        state_dir=state_dir,
        predecessor_build_id=PREDECESSOR_BUILD,
        maintenance_token=TOKEN,
        expected_engine_build_id=OLD_ENGINE_BUILD,
        timeout=5,
        verify_existing=True,
    ) == output


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (
            lambda live, _state, _status, _log: live.__setitem__("api_id", "replacement-api-id"),
            "no longer matches current engine",
        ),
        (
            lambda live, _state, _status, _log: live.__setitem__("worker_build", "wrong-build"),
            "does not retain the predecessor",
        ),
        (
            lambda live, _state, _status, _log: live.__setitem__("database_token", "72a6b93a-3789-4e6e-b3db-1d6a15c7dc01"),
            "drain ownership",
        ),
        (
            lambda live, _state, status, _log: live.__setitem__(
                "processes", f"1234 {status['pinnedChildPath']} {PREDECESSOR_BUILD}"
            ),
            "child is still running",
        ),
    ],
)
def test_verify_existing_reprobes_live_container_database_and_process_evidence(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    mutate,
    message: str,
) -> None:
    state_dir = tmp_path / "state"
    status_path, log_path, status = _legacy_failure_receipt(state_dir)
    live = _install_live_probe_stub(monkeypatch)
    attester.audit_and_attest(
        state_dir=state_dir,
        predecessor_build_id=PREDECESSOR_BUILD,
        maintenance_token=TOKEN,
        expected_engine_build_id=OLD_ENGINE_BUILD,
        timeout=5,
    )
    mutate(live, state_dir, status, log_path)

    with pytest.raises(attester.AuditError, match=message):
        attester.audit_and_attest(
            state_dir=state_dir,
            predecessor_build_id=PREDECESSOR_BUILD,
            maintenance_token=TOKEN,
            expected_engine_build_id=OLD_ENGINE_BUILD,
            timeout=5,
            verify_existing=True,
        )


def test_verify_existing_rejects_environment_or_status_log_hash_drift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state_dir = tmp_path / "state"
    status_path, log_path, status = _legacy_failure_receipt(state_dir)
    _install_live_probe_stub(monkeypatch)
    attester.audit_and_attest(
        state_dir=state_dir,
        predecessor_build_id=PREDECESSOR_BUILD,
        maintenance_token=TOKEN,
        expected_engine_build_id=OLD_ENGINE_BUILD,
        timeout=5,
    )
    (state_dir / ".env.deploy").write_text(
        f"AIRFOILFOAM_BUILD_ID={OLD_ENGINE_BUILD}\nENGINE_EXPECTED_BUILD_ID=wrong-build\n",
        encoding="utf-8",
    )
    (state_dir / ".env.deploy").chmod(0o600)
    with pytest.raises(attester.AuditError, match="deployment engine identity"):
        attester.audit_and_attest(
            state_dir=state_dir,
            predecessor_build_id=PREDECESSOR_BUILD,
            maintenance_token=TOKEN,
            expected_engine_build_id=OLD_ENGINE_BUILD,
            timeout=5,
            verify_existing=True,
        )

    (state_dir / ".env.deploy").write_text(
        f"AIRFOILFOAM_BUILD_ID={OLD_ENGINE_BUILD}\nENGINE_EXPECTED_BUILD_ID={OLD_ENGINE_BUILD}\n",
        encoding="utf-8",
    )
    (state_dir / ".env.deploy").chmod(0o600)
    log_path.write_text(log_path.read_text(encoding="utf-8") + "later mutation\n", encoding="utf-8")
    log_path.chmod(0o600)
    with pytest.raises(attester.AuditError, match="does not match its immutable receipt"):
        attester.audit_and_attest(
            state_dir=state_dir,
            predecessor_build_id=PREDECESSOR_BUILD,
            maintenance_token=TOKEN,
            expected_engine_build_id=OLD_ENGINE_BUILD,
            timeout=5,
            verify_existing=True,
        )


@pytest.mark.parametrize(
    "log_body",
    [
        "preflight succeeded\n",
        (
            "Refusing engine rebuild at before service recreate because the engine queue probe failed:\n"
            "Refusing engine rebuild at before service recreate because the engine queue probe failed:\n"
        ),
    ],
)
def test_auditor_rejects_missing_or_duplicate_preengine_refusal_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, log_body: str
) -> None:
    state_dir = tmp_path / "state"
    status_path, log_path, status = _legacy_failure_receipt(state_dir)
    log_path.write_text(log_body, encoding="utf-8")
    log_path.chmod(0o600)
    status["logSha256"] = _sha256(log_path)
    _write_private_json(status_path, status)
    _install_live_probe_stub(monkeypatch)

    with pytest.raises(attester.AuditError, match="exactly one pre-engine refusal marker"):
        attester.audit_and_attest(
            state_dir=state_dir,
            predecessor_build_id=PREDECESSOR_BUILD,
            maintenance_token=TOKEN,
            expected_engine_build_id=OLD_ENGINE_BUILD,
            timeout=5,
        )


@pytest.mark.parametrize("target", ["status", "log", "environment"])
def test_auditor_rejects_nonprivate_evidence_paths(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, target: str
) -> None:
    state_dir = tmp_path / "state"
    status_path, log_path, _status = _legacy_failure_receipt(state_dir)
    target_path = {
        "status": status_path,
        "log": log_path,
        "environment": state_dir / ".env.deploy",
    }[target]
    target_path.chmod(0o644)
    _install_live_probe_stub(monkeypatch)

    with pytest.raises(attester.AuditError, match="private mode 0600"):
        attester.audit_and_attest(
            state_dir=state_dir,
            predecessor_build_id=PREDECESSOR_BUILD,
            maintenance_token=TOKEN,
            expected_engine_build_id=OLD_ENGINE_BUILD,
            timeout=5,
        )


def test_auditor_rejects_any_service_recreate_marker_even_with_a_matching_sha(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state_dir = tmp_path / "state"
    status_path, log_path, status = _legacy_failure_receipt(state_dir)
    log_path.write_text(
        log_path.read_text(encoding="utf-8") + "Container app-api-1 Recreate\n",
        encoding="utf-8",
    )
    log_path.chmod(0o600)
    status["logSha256"] = _sha256(log_path)
    _write_private_json(status_path, status)
    _install_live_probe_stub(monkeypatch)

    with pytest.raises(attester.AuditError, match="engine identity or service-recreate"):
        attester.audit_and_attest(
            state_dir=state_dir,
            predecessor_build_id=PREDECESSOR_BUILD,
            maintenance_token=TOKEN,
            expected_engine_build_id=OLD_ENGINE_BUILD,
            timeout=5,
        )


def test_auditor_does_not_treat_a_v2_receipt_with_v3_fields_as_legacy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    state_dir = tmp_path / "state"
    status_path, _log_path, status = _legacy_failure_receipt(state_dir)
    status["adoptProductionDrainPredecessorBuildId"] = None
    _write_private_json(status_path, status)
    _install_live_probe_stub(monkeypatch)

    with pytest.raises(attester.AuditError, match="accepted terminal contract"):
        attester.audit_and_attest(
            state_dir=state_dir,
            predecessor_build_id=PREDECESSOR_BUILD,
            maintenance_token=TOKEN,
            expected_engine_build_id=OLD_ENGINE_BUILD,
            timeout=5,
        )
