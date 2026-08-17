from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
from typing import Any

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "deploy" / "production_maintenance_preflight.py"
SPEC = importlib.util.spec_from_file_location("production_maintenance_preflight", SCRIPT)
assert SPEC and SPEC.loader
preflight = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = preflight
SPEC.loader.exec_module(preflight)

TOKEN = "ed075d95-221d-4a45-af7c-2ae8f3518a2e"
JOB_ONE = "11111111-1111-4111-8111-111111111111"
JOB_TWO = "22222222-2222-4222-8222-222222222222"
ENGINE_ONE = "0123456789ab4def8abc0123456789ab"
ENGINE_TWO = "fedcba9876544fed8cba9876543210fe"


def terminal_status(
    job_id: str,
    *,
    state: str = "completed",
    phase: str | None = None,
    result_present: bool = True,
    held: int = 0,
    waiting: int = 0,
    message: str | None = None,
) -> dict[str, Any]:
    return {
        "read_error": None,
        "status": {
            "job_id": job_id,
            "state": state,
            "phase": phase or state,
            "cpu_tokens_held": held,
            "cpu_tokens_waiting": waiting,
            **({"message": message} if message is not None else {}),
        },
        "status_sha256": "a" * 64,
        "result_sha256": "b" * 64,
        "result_present": result_present,
    }


class FakeSystem:
    def __init__(
        self,
        *,
        jobs: list[dict[str, Any]] | None = None,
        statuses: dict[str, dict[str, Any]] | None = None,
        writers_running: bool = True,
        capability: dict[str, Any] | None = None,
        openfoam: bool = False,
        queue: dict[str, Any] | None = None,
        admission_token: str = TOKEN,
        receipt_rows: list[dict[str, Any]] | None = None,
    ) -> None:
        self.jobs = [
            {"ingested_at": None, "ingest_lease_live": False, **job}
            for job in (jobs or [])
        ]
        self.receipt_rows = [
            {
                "ingested_at": (
                    "2026-08-02T00:00:00+00:00"
                    if job.get("status") in {"done", "failed"}
                    else None
                ),
                "ingest_lease_live": False,
                **job,
            }
            for job in (receipt_rows if receipt_rows is not None else self.jobs)
        ]
        self.statuses = statuses or {}
        self.writers_running = writers_running
        self.capability = capability or dict(preflight.AFFECTED_RUNTIME)
        self.openfoam = openfoam
        self.queue = queue or {
            "active": {"celery@worker": []},
            "reserved": {"celery@worker": []},
            "scheduled": {"celery@worker": []},
            "active_queues": {
                "celery@worker": [{"name": "openfoam-opencfd-2606"}]
            },
            "queue_depths": {
                "openfoam-opencfd-2606": 0,
                "openfoam-foundation-14": 0,
            },
            "transport_unacked_counts": {"unacked": 0, "unacked_index": 0},
        }
        self.admission_token = admission_token
        self.calls: list[tuple[list[str], str | None]] = []

    def capture(
        self,
        args: list[str],
        timeout: float,
        *,
        input_text: str | None = None,
    ) -> subprocess.CompletedProcess[str]:
        del timeout
        self.calls.append((args, input_text))
        joined = " ".join(args)
        if args[:2] == ["docker", "ps"]:
            rows = ["api-id\tapi", "postgres-id\tpostgres", "worker-id\tworker"]
            if self.writers_running:
                rows.extend(("sweeper-id\tsweeper", "media-id\tmedia-repair"))
            return subprocess.CompletedProcess(args, 0, "\n".join(rows) + "\n", "")
        if "AIRFOILS_PRO_PRODUCTION_MAINTENANCE_CAPABILITY_PROBE" in joined:
            return subprocess.CompletedProcess(args, 0, json.dumps(self.capability), "")
        if args[:3] == ["docker", "exec", "worker-id"] and "pgrep" in args:
            return subprocess.CompletedProcess(
                args, 0 if self.openfoam else 1, "42 pimpleFoam\n" if self.openfoam else "", ""
            )
        if args == ["docker", "exec", "worker-id", "hostname"]:
            return subprocess.CompletedProcess(args, 0, "worker\n", "")
        if "AIRFOILS_PRO_PRODUCTION_MAINTENANCE_CELERY_REDIS_PROBE" in joined:
            return subprocess.CompletedProcess(args, 0, json.dumps(self.queue), "")
        if "AIRFOILS_PRO_PRODUCTION_MAINTENANCE_DATABASE_PROBE" in joined:
            value = {
                "admission": {
                    "enabled": False,
                    "admission_fence_active": False,
                    "maintenance_drain_token": self.admission_token,
                    "maintenance_drain_started_at": "2026-08-02T00:00:00+00:00",
                },
                "jobs": self.jobs,
            }
            return subprocess.CompletedProcess(args, 0, json.dumps(value), "")
        if "AIRFOILS_PRO_PRODUCTION_MAINTENANCE_RECEIPT_DATABASE_PROBE" in joined:
            return subprocess.CompletedProcess(
                args, 0, json.dumps(self.receipt_rows), ""
            )
        if "AIRFOILS_PRO_PRODUCTION_MAINTENANCE_STATUS_PROBE" in joined:
            requested = json.loads(input_text or "[]")
            value = {job_id: self.statuses.get(job_id) for job_id in requested}
            return subprocess.CompletedProcess(args, 0, json.dumps(value), "")
        raise AssertionError(f"unexpected command: {args}")


def run(system: FakeSystem, *, phase: str = "observe") -> dict[str, Any]:
    return preflight.collect_preflight(
        project="app",
        token=TOKEN,
        phase=phase,
        timeout=5,
        system=system,
    )


def test_exact_terminal_running_and_ingesting_rows_are_observed_not_mutated() -> None:
    jobs = [
        {"id": "db-1", "status": "running", "engine_state": "running", "engine_job_id": "engine-1"},
        {"id": "db-2", "status": "ingesting", "engine_state": "completed", "engine_job_id": "engine-2"},
    ]
    system = FakeSystem(
        jobs=jobs,
        statuses={
            "engine-1": terminal_status("engine-1", state="failed"),
            "engine-2": terminal_status("engine-2"),
        },
    )

    result = run(system)

    assert result["idle"] is True
    assert result["terminalCandidateCount"] == 2
    assert result["blockingJobCount"] == 0
    assert all(call[0][:2] in (["docker", "ps"], ["docker", "exec"]) for call in system.calls)
    database_commands = [" ".join(call[0]) for call in system.calls if "psql" in call[0]]
    assert len(database_commands) == 1
    assert "UPDATE " not in database_commands[0]
    assert "DELETE " not in database_commands[0]


def test_authoritative_phase_requires_both_writers_stopped() -> None:
    with pytest.raises(preflight.PreflightError, match="writers are still running"):
        run(FakeSystem(), phase="authoritative")

    assert run(FakeSystem(writers_running=False), phase="authoritative")["idle"] is True


@pytest.mark.parametrize(
    ("job", "status"),
    [
        ({"id": "1", "status": "pending", "engine_state": None, "engine_job_id": "e"}, terminal_status("e")),
        ({"id": "1", "status": "submitted", "engine_state": "submitted", "engine_job_id": "e"}, terminal_status("e")),
        ({"id": "1", "status": "running", "engine_state": "running", "engine_job_id": None}, None),
        ({"id": "1", "status": "running", "engine_state": "running", "engine_job_id": "e"}, terminal_status("e", state="running", phase="solving_urans")),
        ({"id": "1", "status": "running", "engine_state": "running", "engine_job_id": "e"}, terminal_status("e", result_present=False)),
        ({"id": "1", "status": "running", "engine_state": "running", "engine_job_id": "e"}, terminal_status("e", held=1)),
        ({"id": "1", "status": "ingesting", "engine_state": "running", "engine_job_id": "e"}, terminal_status("e")),
        ({"id": "1", "status": "ingesting", "engine_state": "completed", "engine_job_id": "e", "ingest_lease_live": True}, terminal_status("e")),
        ({"id": "1", "status": "ingesting", "engine_state": "completed", "engine_job_id": "e"}, terminal_status("e", phase="failed")),
    ],
)
def test_every_terminal_candidate_near_miss_remains_blocking(
    job: dict[str, Any], status: dict[str, Any] | None
) -> None:
    statuses = {"e": status} if status is not None else {}
    result = run(FakeSystem(jobs=[job], statuses=statuses))
    assert result["idle"] is False
    assert result["blockingJobCount"] == 1
    assert result["terminalCandidateCount"] == 0


@pytest.mark.parametrize("hazard", ("active", "reserved", "scheduled", "queue", "unacked"))
def test_each_direct_queue_hazard_blocks(hazard: str) -> None:
    queue = FakeSystem().queue
    queue = json.loads(json.dumps(queue))
    if hazard in {"active", "reserved", "scheduled"}:
        queue[hazard]["celery@worker"] = [{"id": "task-1"}]
    elif hazard == "queue":
        queue["queue_depths"]["openfoam-opencfd-2606"] = 1
    else:
        queue["transport_unacked_counts"]["unacked"] = 1
    assert run(FakeSystem(queue=queue))["idle"] is False


def test_openfoam_process_blocks_even_when_every_other_source_is_idle() -> None:
    result = run(FakeSystem(openfoam=True))
    assert result["idle"] is False
    assert result["openFoamProcessCount"] == 1


def test_incomplete_worker_coverage_and_wrong_runtime_refuse() -> None:
    queue = FakeSystem().queue
    queue = json.loads(json.dumps(queue))
    queue["scheduled"] = {}
    with pytest.raises(preflight.PreflightError, match="coverage is incomplete"):
        run(FakeSystem(queue=queue))

    wrong_identity = FakeSystem().queue
    wrong_identity = json.loads(json.dumps(wrong_identity))
    for field in ("active", "reserved", "scheduled", "active_queues"):
        wrong_identity[field]["celery@other"] = wrong_identity[field].pop(
            "celery@worker"
        )
    with pytest.raises(preflight.PreflightError, match="coverage is incomplete"):
        run(FakeSystem(queue=wrong_identity))

def test_affected_runtimes_are_the_exact_reviewed_gateway_identities() -> None:
    assert preflight.AFFECTED_RUNTIME == {
        "build_id": "b7d9213f59f2c1c19b8890b1500b81cf168d83aa",
        "engine_version": "2606",
        "urans_recovery_version": 12,
        "archive_reduction_version": 4,
        "queue_observation_version": 1,
    }
    assert preflight.URANS_CLEAN_CYCLE_AFFECTED_RUNTIME == {
        "build_id": "8d8aed9-clean-cycle-v13",
        "engine_version": "2606",
        "urans_recovery_version": 12,
        "archive_reduction_version": 4,
        "queue_observation_version": 1,
    }
    assert preflight.AFFECTED_RUNTIMES == (
        preflight.AFFECTED_RUNTIME,
        preflight.URANS_CLEAN_CYCLE_AFFECTED_RUNTIME,
    )


def test_urans_clean_cycle_runtime_is_receipt_eligible() -> None:
    result = run(
        FakeSystem(capability=dict(preflight.URANS_CLEAN_CYCLE_AFFECTED_RUNTIME))
    )
    assert result["runtime"] == preflight.URANS_CLEAN_CYCLE_AFFECTED_RUNTIME


@pytest.mark.parametrize(
    ("field", "bad_value"),
    (
        ("build_id", "wrong-build"),
        ("engine_version", "2406"),
        ("urans_recovery_version", 11),
        ("archive_reduction_version", 3),
        ("queue_observation_version", 0),
        ("queue_observation_version", True),
        ("queue_observation_version", 1.0),
        ("queue_observation_version", "1"),
    ),
)
def test_every_affected_runtime_field_mismatch_refuses(
    field: str, bad_value: object
) -> None:
    wrong = dict(preflight.AFFECTED_RUNTIME)
    wrong[field] = bad_value
    with pytest.raises(preflight.PreflightError, match="not the exact affected"):
        run(FakeSystem(capability=wrong))

    clean_cycle_wrong = dict(preflight.URANS_CLEAN_CYCLE_AFFECTED_RUNTIME)
    clean_cycle_wrong[field] = bad_value
    with pytest.raises(preflight.PreflightError, match="not the exact affected"):
        run(FakeSystem(capability=clean_cycle_wrong))


def test_exact_database_drain_ownership_is_mandatory() -> None:
    with pytest.raises(preflight.PreflightError, match="ownership is not exact"):
        run(FakeSystem(admission_token="00000000-0000-4000-8000-000000000000"))

    with pytest.raises(preflight.PreflightError, match="not canonical"):
        preflight.collect_preflight(
            project="app",
            token=TOKEN.upper(),
            phase="observe",
            timeout=5,
            system=FakeSystem(),
        )


def authoritative_receipt(tmp_path: Path) -> tuple[Path, dict[str, Any]]:
    jobs = [
        {
            "id": JOB_ONE,
            "status": "running",
            "engine_state": "running",
            "engine_job_id": ENGINE_ONE,
        },
        {
            "id": JOB_TWO,
            "status": "ingesting",
            "engine_state": "completed",
            "engine_job_id": ENGINE_TWO,
        },
    ]
    system = FakeSystem(
        jobs=jobs,
        statuses={
            ENGINE_ONE: terminal_status(ENGINE_ONE, state="failed"),
            ENGINE_TWO: terminal_status(ENGINE_TWO),
        },
        writers_running=False,
    )
    result = run(system, phase="authoritative")
    receipt = preflight._receipt_value(token=TOKEN, result=result)
    path = tmp_path / "maintenance-receipt.json"
    preflight._write_receipt(path, receipt)
    return path, receipt


def test_authoritative_receipt_binds_exact_jobs_and_evidence(tmp_path: Path) -> None:
    path, receipt = authoritative_receipt(tmp_path)

    assert path.stat().st_mode & 0o777 == 0o600
    assert receipt["candidateDigest"] == preflight._candidate_digest(
        receipt["candidates"]
    )
    assert [candidate["jobId"] for candidate in receipt["candidates"]] == [
        JOB_ONE,
        JOB_TWO,
    ]
    assert [candidate["engineJobId"] for candidate in receipt["candidates"]] == [
        ENGINE_ONE,
        ENGINE_TWO,
    ]
    assert preflight._read_receipt(path, TOKEN) == receipt


@pytest.mark.parametrize(
    "engine_job_id",
    (
        ENGINE_ONE.upper(),
        "33333333-3333-4333-8333-333333333333",
        ENGINE_ONE[:-1],
        f"{ENGINE_ONE}0",
        f" {ENGINE_ONE}",
        f"{ENGINE_ONE}\n",
        f"../{ENGINE_ONE}",
        f"{ENGINE_ONE[:-1]}g",
        f"{ENGINE_ONE}\x00",
    ),
)
def test_authoritative_receipt_rejects_noncanonical_engine_job_id(
    tmp_path: Path, engine_job_id: str
) -> None:
    _path, receipt = authoritative_receipt(tmp_path)
    candidate = dict(receipt["candidates"][0])
    candidate["engineJobId"] = engine_job_id
    result = {
        "phase": "authoritative",
        "idle": True,
        "runtime": preflight.AFFECTED_RUNTIME,
        "observedAt": "2026-08-02T12:00:00+00:00",
        "terminalCandidates": [candidate],
    }

    with pytest.raises(
        preflight.PreflightError,
        match="terminal candidate engineJobId is not canonical",
    ):
        preflight._receipt_value(token=TOKEN, result=result)


def test_authoritative_receipt_keeps_database_uuid_and_engine_id_contracts_distinct(
    tmp_path: Path,
) -> None:
    _path, receipt = authoritative_receipt(tmp_path)
    candidate = dict(receipt["candidates"][0])
    candidate["jobId"] = JOB_ONE.replace("-", "")
    result = {
        "phase": "authoritative",
        "idle": True,
        "runtime": preflight.AFFECTED_RUNTIME,
        "observedAt": "2026-08-02T12:00:00+00:00",
        "terminalCandidates": [candidate],
    }

    with pytest.raises(
        preflight.PreflightError,
        match="terminal candidate jobId is not canonical",
    ):
        preflight._receipt_value(token=TOKEN, result=result)


def test_receipt_message_budget_is_utf8_bytes_and_persists_literal_unicode(
    tmp_path: Path,
) -> None:
    _path, receipt = authoritative_receipt(tmp_path)
    candidate = dict(receipt["candidates"][0])
    candidate["engineMessage"] = "😀" * (
        preflight.MAX_RECEIPT_ENGINE_MESSAGE_BYTES // 4
    )
    result = {
        "phase": "authoritative",
        "idle": True,
        "runtime": preflight.AFFECTED_RUNTIME,
        "observedAt": "2026-08-02T12:00:00+00:00",
        "terminalCandidates": [candidate],
    }

    unicode_receipt = preflight._receipt_value(token=TOKEN, result=result)
    path = tmp_path / "unicode-receipt.json"
    preflight._write_receipt(path, unicode_receipt)

    raw = path.read_bytes()
    assert "😀".encode("utf-8") in raw
    assert b"\\ud83d" not in raw
    assert preflight._read_receipt(path, TOKEN) == unicode_receipt

    result["terminalCandidates"][0]["engineMessage"] += "x"
    with pytest.raises(preflight.PreflightError, match="engine message is invalid"):
        preflight._receipt_value(token=TOKEN, result=result)


def test_authoritative_receipt_binds_explicit_terminal_settlement_actions(
    tmp_path: Path,
) -> None:
    jobs = [
        {
            "id": JOB_ONE,
            "status": "running",
            "engine_state": "running",
            "engine_job_id": ENGINE_ONE,
        },
        {
            "id": JOB_TWO,
            "status": "running",
            "engine_state": "running",
            "engine_job_id": ENGINE_TWO,
        },
    ]
    result = run(
        FakeSystem(
            jobs=jobs,
            statuses={
                ENGINE_ONE: terminal_status(ENGINE_ONE, state="cancelled"),
                ENGINE_TWO: terminal_status(
                    ENGINE_TWO,
                    state="failed",
                    message=preflight.WORKER_RESTART_ORPHAN_MESSAGE,
                ),
            },
            writers_running=False,
        ),
        phase="authoritative",
    )
    receipt = preflight._receipt_value(token=TOKEN, result=result)
    assert [candidate["settlementAction"] for candidate in receipt["candidates"]] == [
        "release_cancelled",
        "release_worker_restart_orphan",
    ]
    path = tmp_path / "release-receipt.json"
    preflight._write_receipt(path, receipt)
    settled = preflight.collect_reconciliation(
        project="app",
        token=TOKEN,
        receipt_file=path,
        timeout=5,
        system=FakeSystem(
            jobs=[],
            receipt_rows=[
                {
                    "id": JOB_ONE,
                    "status": "cancelled",
                    "engine_state": "cancelled",
                    "engine_job_id": ENGINE_ONE,
                },
                {
                    "id": JOB_TWO,
                    "status": "cancelled",
                    "engine_state": "cancelled",
                    "engine_job_id": ENGINE_TWO,
                },
            ],
            writers_running=False,
        ),
    )
    assert settled["reconciled"] is True


def test_reconciliation_proves_ready_then_exact_terminal_settlement(
    tmp_path: Path,
) -> None:
    path, _receipt = authoritative_receipt(tmp_path)
    active_jobs = [
        {
            "id": JOB_ONE,
            "status": "running",
            "engine_state": "running",
            "engine_job_id": ENGINE_ONE,
        },
        {
            "id": JOB_TWO,
            "status": "ingesting",
            "engine_state": "completed",
            "engine_job_id": ENGINE_TWO,
        },
    ]
    before = preflight.collect_reconciliation(
        project="app",
        token=TOKEN,
        receipt_file=path,
        timeout=5,
        system=FakeSystem(
            jobs=active_jobs,
            statuses={
                ENGINE_ONE: terminal_status(ENGINE_ONE, state="failed"),
                ENGINE_TWO: terminal_status(ENGINE_TWO),
            },
            writers_running=False,
        ),
    )
    assert before["readyForReconcile"] is True
    assert before["reconciled"] is False
    assert before["remainingCount"] == 2

    terminal_rows = [
        {
            "id": JOB_ONE,
            "status": "failed",
            "engine_state": "failed",
            "engine_job_id": ENGINE_ONE,
        },
        {
            "id": JOB_TWO,
            "status": "done",
            "engine_state": "completed",
            "engine_job_id": ENGINE_TWO,
        },
    ]
    after = preflight.collect_reconciliation(
        project="app",
        token=TOKEN,
        receipt_file=path,
        timeout=5,
        system=FakeSystem(
            jobs=[], receipt_rows=terminal_rows, writers_running=False
        ),
    )
    assert after["reconciled"] is True
    assert after["terminalCount"] == 2


def test_reconciliation_refuses_evidence_drift_live_lease_and_scope_widening(
    tmp_path: Path,
) -> None:
    path, _receipt = authoritative_receipt(tmp_path)
    job = {
        "id": JOB_ONE,
        "status": "running",
        "engine_state": "running",
        "engine_job_id": ENGINE_ONE,
    }
    drifted = terminal_status(ENGINE_ONE, state="failed")
    drifted["result_sha256"] = "c" * 64
    with pytest.raises(preflight.PreflightError, match="evidence drifted"):
        preflight.collect_reconciliation(
            project="app",
            token=TOKEN,
            receipt_file=path,
            timeout=5,
            system=FakeSystem(
                jobs=[job],
                receipt_rows=[job, {
                    "id": JOB_TWO,
                    "status": "done",
                    "engine_state": "completed",
                    "engine_job_id": ENGINE_TWO,
                }],
                statuses={ENGINE_ONE: drifted},
                writers_running=False,
            ),
        )

    live_ingest = {
        "id": JOB_TWO,
        "status": "ingesting",
        "engine_state": "completed",
        "engine_job_id": ENGINE_TWO,
        "ingest_lease_live": True,
    }
    with pytest.raises(preflight.PreflightError, match="row drifted"):
        preflight.collect_reconciliation(
            project="app",
            token=TOKEN,
            receipt_file=path,
            timeout=5,
            system=FakeSystem(
                jobs=[job, live_ingest],
                receipt_rows=[job, live_ingest],
                statuses={
                    ENGINE_ONE: terminal_status(ENGINE_ONE, state="failed"),
                    ENGINE_TWO: terminal_status(ENGINE_TWO),
                },
                writers_running=False,
            ),
        )

    unexpected = {
        "id": "55555555-5555-4555-8555-555555555555",
        "status": "pending",
        "engine_state": None,
        "engine_job_id": None,
    }
    result = preflight.collect_reconciliation(
        project="app",
        token=TOKEN,
        receipt_file=path,
        timeout=5,
        system=FakeSystem(
            jobs=[unexpected],
            receipt_rows=[
                {
                    "id": JOB_ONE,
                    "status": "failed",
                    "engine_state": "failed",
                    "engine_job_id": ENGINE_ONE,
                },
                {
                    "id": JOB_TWO,
                    "status": "done",
                    "engine_state": "completed",
                    "engine_job_id": ENGINE_TWO,
                },
            ],
            writers_running=False,
        ),
    )
    assert result["readyForReconcile"] is False
    assert result["unexpectedActiveCount"] == 1


def test_reconciliation_refuses_any_restarted_writer(tmp_path: Path) -> None:
    path, _receipt = authoritative_receipt(tmp_path)
    with pytest.raises(
        preflight.PreflightError, match="writers restarted during reconciliation"
    ):
        preflight.collect_reconciliation(
            project="app",
            token=TOKEN,
            receipt_file=path,
            timeout=5,
            system=FakeSystem(writers_running=True),
        )


@pytest.mark.parametrize("missing_job_id", (JOB_ONE, JOB_TWO))
def test_reconciliation_requires_durable_ingest_receipt_for_ingest_actions(
    tmp_path: Path, missing_job_id: str
) -> None:
    path, _receipt = authoritative_receipt(tmp_path)
    rows = [
        {
            "id": JOB_ONE,
            "status": "failed",
            "engine_state": "failed",
            "engine_job_id": ENGINE_ONE,
            "ingested_at": (
                None
                if missing_job_id == JOB_ONE
                else "2026-08-02T00:00:00+00:00"
            ),
        },
        {
            "id": JOB_TWO,
            "status": "done",
            "engine_state": "completed",
            "engine_job_id": ENGINE_TWO,
            "ingested_at": (
                None
                if missing_job_id == JOB_TWO
                else "2026-08-02T00:00:00+00:00"
            ),
        },
    ]
    with pytest.raises(preflight.PreflightError, match="durable ingest receipt"):
        preflight.collect_reconciliation(
            project="app",
            token=TOKEN,
            receipt_file=path,
            timeout=5,
            system=FakeSystem(
                jobs=[], receipt_rows=rows, writers_running=False
            ),
        )
