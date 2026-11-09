import fcntl
import json
import multiprocessing

import pytest

from airfoilfoam.config import Settings
from airfoilfoam.execution_stop import execution_stop_proof, record_execution_owner
from airfoilfoam.storage import JobStore
from airfoilfoam.models import Polar, PolarPoint, PolarRequest, JobPhase, JobResult, JobState, JobStatus
from airfoilfoam import tasks


def retained_partial(job_id):
    return JobResult(job_id=job_id, state=JobState.running, polars=[Polar(
        speed=30, chord=1, reynolds=2_000_000,
        points=[PolarPoint(case_slug="c1_u30_am4", aoa_deg=-4, cl=0.4, cd=0.02, cm=-0.01, converged=True)],
        attempts=[PolarPoint(case_slug=f"c1_u30_am{abs(angle)}", aoa_deg=angle, cl=0.3, cd=0.03, cm=-0.02,
                             converged=False, error="retained interrupted attempt", solver_active_seconds=7201,
                             force_history={"t": [0.1, 0.2], "cl": [0.3, 0.4], "cd": [0.03, 0.04], "cm": [-0.02, -0.03]})
                  for angle in (-3, -2)],
    )])


def publish_late_snapshot(settings, job_id, ready, release):
    store = JobStore(settings)
    result = retained_partial(job_id)
    status = JobStatus(job_id=job_id, state=JobState.running, phase=JobPhase.solving_urans,
                       completed_cases=2, total_cases=7)
    ready.set()
    if not release.wait(5):
        raise TimeoutError("Test never released the delayed publication")
    store.write_result(result)
    store.write_status(status)


def publish_paused_result(settings, job_id, ready, release):
    class PausedStore(JobStore):
        def _write_json_atomic(self, path, payload):
            if path.name == "result.json":
                ready.set()
                if not release.wait(5):
                    raise TimeoutError("Test never released the result replacement")
            super()._write_json_atomic(path, payload)

    PausedStore(settings).write_result(retained_partial(job_id))


def fail_after_partial(settings, job_id, started, finished):
    started.set()
    JobStore(settings).terminalize_result(JobResult(job_id=job_id, state=JobState.failed, message="worker failed"))
    finished.set()


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


@pytest.mark.parametrize("terminal_state", [JobState.completed, JobState.failed, JobState.cancelled])
@pytest.mark.parametrize("status_first", [False, True])
def test_completed_execution_is_inspected_without_cancelling_or_modifying_its_result(execution, terminal_state, status_first):
    store, job_id, _ = execution
    (store.job_dir(job_id) / "cancelled").unlink()
    partial = retained_partial(job_id)
    store.write_status(JobStatus(job_id=job_id, state=JobState.running, completed_cases=2, total_cases=7))
    store.write_result(partial)
    context = multiprocessing.get_context("spawn")
    ready, release = context.Event(), context.Event()
    writer = context.Process(target=publish_late_snapshot, args=(store.settings, job_id, ready, release))
    writer.start()
    try:
        assert ready.wait(5)
        terminal = partial.model_copy(update={"state": terminal_state, "message": "authoritative terminal result"})
        status = JobStatus(job_id=job_id, state=terminal_state, phase=JobPhase(terminal_state.value),
                           completed_cases=2, total_cases=7, message=terminal.message)
        if status_first:
            store.write_status(status)
            store.write_result(partial)
            assert store.read_result(job_id).model_dump() == partial.model_dump()
        store.write_result(terminal)
        store.write_status(JobStatus(job_id=job_id, state=JobState.running, completed_cases=1, total_cases=7))
        store.write_status(status)
        result_path = store.job_dir(job_id) / "result.json"
        original = result_path.read_bytes()
        status_original = (store.job_dir(job_id) / "status.json").read_bytes()
        sidecars = {path.name: path.read_bytes() for path in (store.job_dir(job_id) / "continuation-metadata").glob("*.json")}
        release.set()
        writer.join(5)
        assert writer.exitcode == 0
        assert store.read_status(job_id).state is terminal_state
        assert (store.job_dir(job_id) / "status.json").read_bytes() == status_original
        assert store.read_result(job_id).state is terminal_state
        assert store.read_result(job_id).polars == partial.polars
        assert len(sidecars) == 3
        assert sidecars == {path.name: path.read_bytes() for path in (store.job_dir(job_id) / "continuation-metadata").glob("*.json")}
        conflicting = JobState.failed if terminal_state is JobState.completed else JobState.completed
        store.write_result(JobResult(job_id=job_id, state=conflicting))
        store.write_status(JobStatus(job_id=job_id, state=conflicting))
        assert (store.job_dir(job_id) / "status.json").read_bytes() == status_original
        assert result_path.read_bytes() == original
        assert store.terminalize_cancelled_result(job_id) is False
        assert store.terminalize_result(JobResult(job_id=job_id, state=terminal_state)) is False
        assert result_path.read_bytes() == original
    finally:
        release.set()
        if writer.is_alive():
            writer.terminate()
        writer.join(5)
    result_path = store.job_dir(job_id) / "result.json"
    proof = execution_stop_proof(store, job_id)
    assert proof["execution_stopped"] is True
    assert proof["fence"] == "terminal_result"
    assert result_path.read_bytes() == original
    assert store.is_cancelled(job_id) is False
    enriched = store.read_result(job_id)
    enriched.message = "authoritative same-state metadata enrichment"
    enriched.polars[0].points[0].y_plus_avg = 3.0
    store.write_result(enriched)
    assert store.read_result(job_id) == enriched
    assert store.read_result(job_id).polars[0].attempts == partial.polars[0].attempts
    assert execution_stop_proof(store, job_id)["execution_stopped"] is True


def test_terminal_publication_serializes_with_partial_replacement_across_processes(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data")
    store = JobStore(settings)
    job_id = "partial-replacement-race"
    store.write_status(JobStatus(job_id=job_id, state=JobState.running, completed_cases=2, total_cases=7))
    earlier = retained_partial(job_id)
    earlier.polars[0].attempts = []
    store.write_result(earlier)
    record_execution_owner(store, job_id)
    context = multiprocessing.get_context("spawn")
    ready, release, started, finished = [context.Event() for _ in range(4)]
    partial = context.Process(target=publish_paused_result, args=(settings, job_id, ready, release))
    terminal = context.Process(target=fail_after_partial, args=(settings, job_id, started, finished))
    partial.start()
    try:
        assert ready.wait(5)
        with (store.job_dir(job_id) / ".publication.lock").open("a") as contender:
            with pytest.raises(BlockingIOError):
                fcntl.flock(contender.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        terminal.start()
        assert started.wait(5)
        assert not finished.is_set()
        release.set()
        partial.join(5)
        terminal.join(5)
        assert partial.exitcode == terminal.exitcode == 0
        assert finished.is_set()
        result = store.read_result(job_id)
        assert result.state is JobState.failed
        assert result.polars == retained_partial(job_id).polars
        monkeypatch.setattr(store, "job_processes", lambda *_args, **_kwargs: [])
        assert execution_stop_proof(store, job_id)["execution_stopped"] is True
    finally:
        release.set()
        for process in (partial, terminal):
            if process.pid is not None:
                if process.is_alive():
                    process.terminate()
                process.join(5)


def test_worker_exception_preserves_partial_histories_and_terminal_stop_proof(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from airfoilfoam.openfoam.dialects import OPENCFD_2606_IDENTITY

    settings = Settings(data_dir=tmp_path / "data")
    store = JobStore(settings)
    job_id = "failed-worker-partial-history"
    request = PolarRequest.model_validate({"airfoil": {"name": "unused", "coordinates": "not loaded"},
                                          "aoa": {"angles": [-4, -3, -2, -1, 0, 1, 2]},
                                          "expected_engine": OPENCFD_2606_IDENTITY})
    store.create(job_id, request)
    partial = retained_partial(job_id)
    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(tasks, "install_subprocess_signal_handlers", lambda: None)
    monkeypatch.setattr(tasks, "_start_runtime_heartbeat", lambda *_args: (
        SimpleNamespace(set=lambda: None), SimpleNamespace(join=lambda **_kwargs: None)))

    def publish_then_fail(*_args, **_kwargs):
        store.write_result(partial)
        store.write_status(JobStatus(job_id=job_id, state=JobState.running, completed_cases=2, total_cases=7))
        raise RuntimeError("worker failed after partial publication")

    monkeypatch.setattr(tasks, "execute_job", publish_then_fail)
    with pytest.raises(RuntimeError, match="worker failed after partial publication"):
        tasks.run_polar(job_id, request.model_dump_json())
    result = store.read_result(job_id)
    assert result.state is JobState.failed
    assert result.polars == partial.polars
    assert store.read_status(job_id).completed_cases == 2
    assert store.read_status(job_id).total_cases == 7
    assert [point.aoa_deg for polar in result.polars for point in (*polar.points, *polar.attempts)] == [-4, -3, -2]
    assert all(not point.converged and point.force_history is not None for polar in result.polars for point in polar.attempts)
    monkeypatch.setattr(store, "job_processes", lambda *_args, **_kwargs: [])
    assert execution_stop_proof(store, job_id)["execution_stopped"] is True
    assert tasks.run_polar(job_id, request.model_dump_json())["state"] == "failed"


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
