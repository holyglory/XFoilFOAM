import fcntl
import json

import pytest

from airfoilfoam.config import Settings
from airfoilfoam.execution_stop import execution_stop_proof, record_execution_owner
from airfoilfoam.storage import JobStore
from airfoilfoam.models import PolarRequest, JobResult, JobState
from airfoilfoam import tasks


@pytest.fixture
def execution(tmp_path, monkeypatch):
    store = JobStore(Settings(data_dir=tmp_path / "data"))
    job_id = "isolated-execution-stop"
    store.job_dir(job_id).mkdir(parents=True)
    record_execution_owner(store, job_id)
    store.mark_cancelled(job_id)
    inventories = []

    def processes(identity, *, strict=False):
        assert identity == job_id
        assert strict
        return inventories.copy()

    monkeypatch.setattr(store, "job_processes", processes)
    return store, job_id, inventories


def test_stop_requires_the_real_execution_lock_and_no_remaining_children(execution):
    store, job_id, processes = execution
    with (store.job_dir(job_id) / ".execute.lock").open("a") as writer:
        fcntl.flock(writer.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        held = execution_stop_proof(store, job_id)
        assert held["execution_stopped"] is False
        assert held["producer_stopped"] is False
    processes.append(12345)
    live_child = execution_stop_proof(store, job_id)
    assert live_child["producer_stopped"] is True
    assert live_child["execution_stopped"] is False
    assert live_child["remaining"] == [12345]
    processes.clear()
    stopped = execution_stop_proof(store, job_id)
    assert stopped["execution_stopped"] is True
    assert stopped["namespace_verified"] is True
    assert stopped["remaining"] == []
    assert stopped["error"] is None
    assert stopped["fence"] == "cancel_marker"


def test_completed_execution_is_inspected_without_cancelling_or_modifying_its_result(execution):
    store, job_id, _ = execution
    (store.job_dir(job_id) / "cancelled").unlink()
    store.write_result(JobResult(job_id=job_id, state=JobState.completed))
    result_path = store.job_dir(job_id) / "result.json"
    original = result_path.read_bytes()
    proof = execution_stop_proof(store, job_id)
    assert proof["execution_stopped"] is True
    assert proof["fence"] == "terminal_result"
    assert result_path.read_bytes() == original
    assert store.is_cancelled(job_id) is False


@pytest.mark.parametrize("missing", ["marker", "owner", "namespace", "inventory"])
def test_missing_or_wrong_scope_evidence_never_certifies_cancellation(execution, monkeypatch, missing):
    store, job_id, _ = execution
    owner_path = store.job_dir(job_id) / ".execution-owner.json"
    if missing == "marker":
        (store.job_dir(job_id) / "cancelled").unlink()
    elif missing == "owner":
        owner_path.unlink()
    elif missing == "namespace":
        owner = json.loads(owner_path.read_text())
        owner["pid_namespace"] = "isolated-other-process-namespace"
        owner_path.write_text(json.dumps(owner))
        with pytest.raises(RuntimeError, match="different process namespace"):
            record_execution_owner(store, job_id)
    else:
        def unavailable(*_args, **_kwargs):
            raise PermissionError("isolated unreadable process inventory")
        monkeypatch.setattr(store, "job_processes", unavailable)
    proof = execution_stop_proof(store, job_id)
    assert proof["execution_stopped"] is False
    assert proof["error"]


def test_cancelled_redelivery_cannot_restart_or_reassign_execution_ownership(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data")
    store = JobStore(settings)
    request = PolarRequest.model_validate({"airfoil": {"name": "unused", "coordinates": "not loaded"},
                                          "aoa": {"angles": [0]}})
    job_id = "cancelled-redelivery"
    store.create(job_id, request)
    record_execution_owner(store, job_id)
    owner = store.job_dir(job_id) / ".execution-owner.json"
    original = owner.read_bytes()
    store.mark_cancelled(job_id)
    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(tasks, "install_subprocess_signal_handlers", lambda: None)

    def unexpected(*_args, **_kwargs):
        raise AssertionError("Cancelled work must not execute or replace its owner")

    monkeypatch.setattr(tasks, "record_execution_owner", unexpected)
    monkeypatch.setattr(tasks, "execute_job", unexpected)
    assert tasks.run_polar(job_id, request.model_dump_json()) == {"job_id": job_id, "state": "cancelled"}
    assert store.read_status(job_id).state.value == "cancelled"
    assert store.read_result(job_id) is None
    assert owner.read_bytes() == original


def test_queued_cancellation_can_prove_no_execution_without_inventing_a_worker_owner(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data")
    store = JobStore(settings)
    request = PolarRequest.model_validate({"airfoil": {"name": "unused", "coordinates": "not loaded"}, "aoa": {"angles": [0]}})
    job_id = "cancelled-before-first-worker"
    store.create(job_id, request)
    store.mark_cancelled(job_id)
    owner_path = store.job_dir(job_id) / ".execution-owner.json"
    monkeypatch.setattr(store, "job_processes", lambda *_args, **_kwargs: [])
    with (store.job_dir(job_id) / ".execute.lock").open("a") as writer:
        fcntl.flock(writer.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        assert execution_stop_proof(store, job_id)["execution_stopped"] is False
    proof = execution_stop_proof(store, job_id)
    assert proof["execution_stopped"] is True
    assert proof["ownership_basis"] == "never_started_cancellation_fence"
    assert proof["fence"] == "cancel_marker"
    assert not owner_path.exists()
    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(tasks, "install_subprocess_signal_handlers", lambda: None)

    def unexpected(*_args, **_kwargs):
        raise AssertionError("Fenced queued work must never start")

    monkeypatch.setattr(tasks, "record_execution_owner", unexpected)
    monkeypatch.setattr(tasks, "execute_job", unexpected)
    assert tasks.run_polar(job_id, request.model_dump_json())["state"] == "cancelled"
    assert not owner_path.exists()
    assert execution_stop_proof(store, job_id)["execution_stopped"] is True


@pytest.mark.parametrize("invalid", ["wrong_marker", "missing_marker", "running_status", "terminal_result", "remaining_child"])
def test_never_started_proof_rejects_missing_or_contradictory_evidence(tmp_path, monkeypatch, invalid):
    store = JobStore(Settings(data_dir=tmp_path / "data"))
    request = PolarRequest.model_validate({"airfoil": {"name": "unused", "coordinates": "not loaded"}, "aoa": {"angles": [0]}})
    job_id = "invalid-never-started-proof"
    store.create(job_id, request)
    store.mark_cancelled(job_id)
    marker = store.job_dir(job_id) / ".execution-not-started.json"
    monkeypatch.setattr(store, "job_processes", lambda *_args, **_kwargs: [12345] if invalid == "remaining_child" else [])
    if invalid == "wrong_marker":
        marker.write_text(json.dumps({"version": 1, "job_id": "another-job"}))
    elif invalid == "missing_marker":
        marker.unlink()
    elif invalid == "running_status":
        status = store.read_status(job_id)
        status.state = JobState.running
        store.write_status(status)
    elif invalid == "terminal_result":
        (store.job_dir(job_id) / "cancelled").unlink()
        store.write_result(JobResult(job_id=job_id, state=JobState.completed))
    proof = execution_stop_proof(store, job_id)
    assert proof["execution_stopped"] is False
    assert proof["error"]


def test_starting_execution_consumes_the_unstarted_fence_before_physical_work(tmp_path):
    store = JobStore(Settings(data_dir=tmp_path / "data"))
    request = PolarRequest.model_validate({"airfoil": {"name": "unused", "coordinates": "not loaded"}, "aoa": {"angles": [0]}})
    job_id = "starting-consumes-fence"
    store.create(job_id, request)
    marker = store.job_dir(job_id) / ".execution-not-started.json"
    assert marker.exists()
    record_execution_owner(store, job_id)
    assert not marker.exists()
