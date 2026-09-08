from concurrent.futures import ThreadPoolExecutor
import json
import shutil
import threading
from uuid import uuid4

import pytest
from pydantic import ValidationError

from airfoilfoam.config import Settings
from airfoilfoam.models import EngineIdentity, JobResult, JobState, PolarRequest
from airfoilfoam.storage import JobStore
from airfoilfoam.submission import SubmissionError, fence_stable_submission, register_stable_submission


@pytest.fixture
def submission(tmp_path):
    request = PolarRequest.model_validate({"execution_id": str(uuid4()), "airfoil": {"name": "unused", "coordinates": "not loaded"}, "aoa": {"angles": [0]}})
    return JobStore(Settings(data_dir=tmp_path / "data")), request


def test_stable_replay_enqueues_once_and_preserves_an_already_completed_worker_status(submission):
    store, request = submission
    calls = []

    def enqueue(job_id, queued):
        calls.append(job_id)
        assert queued == request
        assert store.read_status(job_id).task_id == job_id
        assert (store.submission_dir(job_id) / ".submission-dispatching.json").exists()
        status = store.read_status(job_id)
        status.state = JobState.completed
        status.completed_cases = 1
        store.write_status(status)
        store.write_result(JobResult(job_id=job_id, state=JobState.completed))
        return job_id

    first = register_stable_submission(store, request, enqueue)
    original = (store.job_dir(first.job_id) / "result.json").read_bytes()
    replay = register_stable_submission(store, request, enqueue)
    assert calls == [str(request.execution_id)]
    assert first == replay
    assert replay.state == JobState.completed and replay.completed_cases == 1
    assert (store.job_dir(first.job_id) / "result.json").read_bytes() == original
    with pytest.raises(SubmissionError) as conflict:
        register_stable_submission(store, request.model_copy(update={"speeds": [65.0]}), enqueue)
    assert conflict.value.code == "execution_identity_conflict"
    assert len(calls) == 1


def test_concurrent_registration_and_cancel_do_not_cross_a_dispatch_in_progress(submission):
    store, request = submission
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def enqueue(job_id, _request):
        calls.append(job_id)
        entered.set()
        assert release.wait(5)
        return job_id

    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(register_stable_submission, store, request, enqueue)
        try:
            assert entered.wait(5)
            for operation in [lambda: register_stable_submission(store, request, enqueue),
                              lambda: fence_stable_submission(store, str(request.execution_id))]:
                with pytest.raises(SubmissionError) as busy:
                    operation()
                assert busy.value.code == "submission_in_progress"
        finally:
            release.set()
        assert future.result(timeout=5).job_id == str(request.execution_id)
    assert len(calls) == 1
    fence_stable_submission(store, str(request.execution_id))
    with pytest.raises(SubmissionError) as cancelled:
        register_stable_submission(store, request, enqueue)
    assert cancelled.value.code == "execution_cancelled"
    assert len(calls) == 1


def test_lost_broker_confirmation_retains_identity_without_an_automatic_duplicate_enqueue(submission):
    store, request = submission
    calls = []

    def uncertain(job_id, _request):
        calls.append(job_id)
        raise ConnectionError("private broker diagnostic")

    with pytest.raises(SubmissionError) as failure:
        register_stable_submission(store, request, uncertain)
    assert failure.value.code == "submission_confirmation_unavailable"
    assert "private broker" not in str(failure.value)
    replay = register_stable_submission(store, request, uncertain)
    assert calls == [str(request.execution_id)]
    assert replay.job_id == str(request.execution_id) and replay.state == JobState.pending
    assert store.read_result(replay.job_id) is None
    receipt = json.loads((store.submission_dir(replay.job_id) / ".submission-uncertain.json").read_text())
    assert receipt["error_kind"] == "ConnectionError"
    fence_stable_submission(store, replay.job_id)
    assert store.is_cancelled(replay.job_id)


def test_unregistered_cancellation_requires_an_exact_route_and_blocks_delayed_registration(submission):
    store, request = submission
    job_id = str(request.execution_id)
    with pytest.raises(SubmissionError) as missing:
        fence_stable_submission(store, job_id)
    assert missing.value.code == "unregistered_execution_route_required"
    engine = EngineIdentity()
    assert fence_stable_submission(store, job_id, engine) == engine
    assert store.read_request(job_id) is None and store.read_result(job_id) is None
    assert store.read_status(job_id).state == JobState.cancelled
    with pytest.raises(SubmissionError) as fenced:
        register_stable_submission(store, request, lambda *_: pytest.fail("Cancelled execution must not enqueue"))
    assert fenced.value.code == "execution_cancelled"


@pytest.mark.parametrize("damage", ["request", "status", "receipt", "receipt_identity", "missing_request"])
def test_corrupt_registration_is_not_replaced_or_reenqueued(submission, damage):
    store, request = submission
    job_id = str(request.execution_id)
    register_stable_submission(store, request, lambda identity, _: identity)
    if damage == "missing_request":
        (store.job_dir(job_id) / "request.json").unlink()
    else:
        name = {"request": "request.json", "status": "status.json", "receipt": ".submission-dispatching.json", "receipt_identity": ".submission-dispatching.json"}[damage]
        path = (store.submission_dir(job_id) if damage.startswith("receipt") else store.job_dir(job_id)) / name
        if damage == "receipt_identity":
            receipt = json.loads(path.read_text())
            receipt["job_id"] = str(uuid4())
            path.write_text(json.dumps(receipt))
        else:
            path.write_text("incomplete original bytes")
    with pytest.raises(SubmissionError) as failed:
        register_stable_submission(store, request, lambda *_: pytest.fail("Damaged registration must not enqueue"))
    assert failed.value.code == ("execution_retired" if damage == "missing_request" else "submission_metadata_unavailable")


@pytest.mark.parametrize("cancelled", [True, False])
def test_routine_job_cleanup_never_allows_identity_reuse_or_a_broker_redelivery_to_restart(submission, monkeypatch, cancelled):
    from airfoilfoam import tasks

    store, request = submission
    job_id = str(request.execution_id)
    register_stable_submission(store, request, lambda identity, _: identity)
    if cancelled:
        fence_stable_submission(store, job_id)
    shutil.rmtree(store.job_dir(job_id))
    with pytest.raises(SubmissionError) as replay:
        register_stable_submission(store, request, lambda *_: pytest.fail("Retired work must not enqueue"))
    assert replay.value.code == ("execution_cancelled" if cancelled else "execution_retired")
    monkeypatch.setattr(tasks, "get_settings", lambda: store.settings)
    monkeypatch.setattr(tasks, "install_subprocess_signal_handlers", lambda: None)
    monkeypatch.setattr(tasks, "execute_job", lambda *_args, **_kwargs: pytest.fail("Retired work must not execute"))
    if cancelled:
        assert tasks.run_polar(job_id, request.model_dump_json()) == {"job_id": job_id, "state": "cancelled"}
    else:
        with pytest.raises(RuntimeError, match="registration is unavailable"):
            tasks.run_polar(job_id, request.model_dump_json())
    assert not store.job_dir(job_id).exists()


@pytest.mark.parametrize("identity", ["../outside", "not-a-uuid", "00000000-0000-0000-0000-000000000000"])
def test_execution_identity_is_typed_and_cannot_choose_arbitrary_paths(submission, identity):
    _, request = submission
    with pytest.raises(ValidationError):
        PolarRequest.model_validate({**request.model_dump(), "execution_id": identity})
