import json
from types import SimpleNamespace

import pytest

from airfoilfoam import worker_control
from airfoilfoam.celery_app import celery_app
from airfoilfoam.config import Settings
from airfoilfoam.execution_stop import record_execution_owner
from airfoilfoam.models import EngineIdentity, JobState, JobStatus
from airfoilfoam.storage import JobStore


def response(job_id="selected", pool="selected-pool", **changes):
    return {"job_id": job_id, "execution_pool": pool, "engine": EngineIdentity().model_dump(mode="json"),
            "owner_matched": True, "receipt": {"job_id": job_id, "version": 1, "execution_stopped": True}, **changes}


def install_control(monkeypatch, replies, bindings=None):
    calls = []
    queues = bindings if bindings is not None else {
        "selected-worker": [{"name": "selected-pool"}],
        "other-worker": [{"name": "other-pool"}],
    }
    monkeypatch.setattr(celery_app.control, "inspect", lambda **kwargs: SimpleNamespace(active_queues=lambda: queues))

    def broadcast(command, **kwargs):
        calls.append((command, kwargs))
        return replies

    monkeypatch.setattr(celery_app.control, "broadcast", broadcast)
    return calls


def test_execution_inspection_uses_worker_control_not_cfd_task_queue(monkeypatch):
    from airfoilfoam import tasks
    monkeypatch.setattr(tasks.inspect_job_execution_stop, "apply_async", lambda **kwargs: pytest.fail("CFD queue must not be used"))
    calls = install_control(monkeypatch, [{"selected-worker": response()}])
    proof = worker_control.request_worker_control("inspect", "selected", "selected-pool", EngineIdentity())
    assert proof["execution_stopped"] is True
    assert calls[0][0] == "airfoilfoam_inspect_execution"
    assert calls[0][1]["destination"] == ["selected-worker"]
    assert calls[0][1]["limit"] == 1


@pytest.mark.parametrize("reply", [
    {}, {"other-worker": response()}, {"selected-worker": response(job_id="another")},
    {"selected-worker": response(pool="another-pool")},
    {"selected-worker": response(owner_matched=False)},
    {"selected-worker": response(engine={})},
    {"selected-worker": response(receipt=None)},
])
def test_unmatched_or_malformed_control_reply_is_unavailable(monkeypatch, reply):
    install_control(monkeypatch, [reply])
    with pytest.raises(RuntimeError, match="matching worker"):
        worker_control.request_worker_control("inspect", "selected", "selected-pool", EngineIdentity())


def test_no_worker_does_not_broadcast_or_invent_stop_proof(monkeypatch):
    calls = install_control(monkeypatch, [], bindings={})
    with pytest.raises(RuntimeError, match="No live worker"):
        worker_control.request_worker_control("inspect", "selected", "selected-pool", EngineIdentity())
    assert calls == []


def store_fixture(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path, celery_queue="selected-pool")
    monkeypatch.setattr(worker_control, "get_settings", lambda: settings)
    store = JobStore(settings)
    store.write_status(JobStatus(job_id="selected", state=JobState.cancelled))
    store.mark_cancelled("selected")
    record_execution_owner(store, "selected")
    return store


def test_worker_control_preserves_native_namespace_and_fence(tmp_path, monkeypatch):
    store_fixture(tmp_path, monkeypatch)
    def inventory(_store, job_id, *, strict):
        assert job_id == "selected" and strict is True
        return []
    monkeypatch.setattr(JobStore, "job_processes", inventory)
    result = worker_control.execute_worker_control("inspect", "selected", "selected-pool", EngineIdentity().model_dump(mode="json"))
    assert result["owner_matched"] is True
    assert result["receipt"]["namespace_verified"] is True
    assert result["receipt"]["execution_stopped"] is True
    assert result["receipt"]["fence"] == "cancel_marker"


def test_unreadable_inventory_never_becomes_a_stop_proof(tmp_path, monkeypatch):
    store_fixture(tmp_path, monkeypatch)
    def unreadable(_store, job_id, *, strict):
        raise PermissionError("isolated unavailable process inventory")
    monkeypatch.setattr(JobStore, "job_processes", unreadable)
    result = worker_control.execute_worker_control("inspect", "selected", "selected-pool", EngineIdentity().model_dump(mode="json"))
    assert result["receipt"]["execution_stopped"] is False
    assert "unavailable process inventory" in result["receipt"]["error"]


@pytest.mark.parametrize("mismatch", ["pool", "engine", "namespace"])
def test_wrong_worker_cannot_reap_another_execution(tmp_path, monkeypatch, mismatch):
    from airfoilfoam import tasks
    store = store_fixture(tmp_path, monkeypatch)
    monkeypatch.setattr(tasks.kill_job_processes, "run", lambda identity: pytest.fail("Foreign execution must not be reaped"))
    pool = "other-pool" if mismatch == "pool" else "selected-pool"
    engine = EngineIdentity().model_dump(mode="json")
    if mismatch == "engine":
        engine["version"] = "2406"
    if mismatch == "namespace":
        path = store.job_dir("selected") / ".execution-owner.json"
        owner = json.loads(path.read_text())
        owner["pid_namespace"] = "foreign-namespace"
        path.write_text(json.dumps(owner))
    result = worker_control.execute_worker_control("reap", "selected", pool, engine)
    assert result["owner_matched"] is False


def test_commands_are_registered_in_worker_main_control_panel():
    from celery.worker.control import Panel
    worker_control.register_worker_controls()
    assert "airfoilfoam_inspect_execution" in Panel.data
    assert "airfoilfoam_reap_execution" in Panel.data
