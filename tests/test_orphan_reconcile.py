"""Worker-boot reconciliation of jobs orphaned by a dead worker process.

A recreated worker container kills its in-flight celery tasks; the persisted
status store would otherwise keep answering state=running forever (zombie
jobs). `JobStore.reconcile_orphans` + the `worker_ready` hook must mark those
jobs failed with a stable message while leaving everything legitimately
pending/terminal/active untouched.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from airfoilfoam import tasks
from airfoilfoam.config import Settings
from airfoilfoam.models import (
    JobPhase,
    JobResult,
    JobState,
    JobStatus,
    Polar,
    PolarPoint,
)
from airfoilfoam.storage import ORPHAN_MESSAGE, JobStore
from airfoilfoam.openfoam.dialects import FOUNDATION_14_IDENTITY


def make_store(tmp_path) -> JobStore:
    return JobStore(Settings(data_dir=tmp_path / "data"))


def seed(store: JobStore, job_id: str, state: JobState, **kwargs) -> None:
    store.write_status(JobStatus(job_id=job_id, state=state, **kwargs))


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


# --------------------------------------------------------------------------- #
# Cross-runtime message pin
# --------------------------------------------------------------------------- #
def test_orphan_message_is_pinned_for_node_clients():
    """The node sweeper matches this literal to tell worker-restart
    interruptions apart from real solver failures (release + re-solve, never
    fake terminal-failed evidence): packages/engine-client/src/types.ts
    WORKER_RESTART_ORPHAN_MESSAGE, consumed in apps/sweeper/src/reconcile.ts.
    The literal is hardcoded on BOTH sides on purpose — changing it here
    without the node side (or vice versa) must fail a test, never silently
    turn restarts back into fake failures. Node twin:
    apps/sweeper/test/orphan-message-pin.test.ts."""
    assert ORPHAN_MESSAGE == "worker restarted mid-solve; task lost"


# --------------------------------------------------------------------------- #
# JobStore.reconcile_orphans
# --------------------------------------------------------------------------- #
def test_running_job_from_before_boot_is_marked_failed(tmp_path):
    store = make_store(tmp_path)
    seed(store, "zombie", JobState.running, phase=JobPhase.solving_urans, task_id="zombie")

    boot = now_utc() + timedelta(seconds=1)  # worker booted after the status write
    reconciled = store.reconcile_orphans(boot_time=boot)

    assert reconciled == ["zombie"]
    status = store.read_status("zombie")
    assert status.state is JobState.failed
    assert status.phase is JobPhase.failed
    assert status.message == ORPHAN_MESSAGE
    assert status.active_pids == []
    result = store.read_result("zombie")
    assert result is not None
    assert result.state is JobState.failed
    assert result.message == ORPHAN_MESSAGE


def test_terminal_and_pending_jobs_are_untouched(tmp_path):
    store = make_store(tmp_path)
    seed(store, "done", JobState.completed)
    seed(store, "boom", JobState.failed, message="mesh exploded")
    seed(store, "gone", JobState.cancelled)
    # pending jobs stay: their queue message survives the restart (acks_late)
    seed(store, "queued", JobState.pending)

    reconciled = store.reconcile_orphans(boot_time=now_utc() + timedelta(seconds=1))

    assert reconciled == []
    assert store.read_status("done").state is JobState.completed
    assert store.read_status("boom").state is JobState.failed
    assert store.read_status("boom").message == "mesh exploded"
    assert store.read_status("gone").state is JobState.cancelled
    assert store.read_status("queued").state is JobState.pending


def test_job_started_after_boot_is_untouched(tmp_path):
    store = make_store(tmp_path)
    boot = now_utc() - timedelta(minutes=5)  # worker booted 5 min ago
    seed(store, "fresh", JobState.running)  # updated_at = now > boot

    assert store.reconcile_orphans(boot_time=boot) == []
    assert store.read_status("fresh").state is JobState.running


def test_actively_running_task_on_another_worker_is_untouched(tmp_path):
    store = make_store(tmp_path)
    seed(store, "job-a", JobState.running, task_id="task-a")
    seed(store, "job-b", JobState.running, task_id="job-b")

    boot = now_utc() + timedelta(seconds=1)
    reconciled = store.reconcile_orphans(boot_time=boot, active_task_ids={"task-a", "job-b"})

    assert reconciled == []
    assert store.read_status("job-a").state is JobState.running
    assert store.read_status("job-b").state is JobState.running


def test_partial_result_evidence_is_preserved(tmp_path):
    store = make_store(tmp_path)
    seed(store, "partial", JobState.running)
    polar = Polar(
        speed=10.0,
        chord=0.5,
        reynolds=3.4e5,
        points=[PolarPoint(aoa_deg=2.0, cl=0.31, cd=0.012, cm=-0.05)],
    )
    store.write_result(JobResult(job_id="partial", state=JobState.running, polars=[polar]))

    reconciled = store.reconcile_orphans(boot_time=now_utc() + timedelta(seconds=1))

    assert reconciled == ["partial"]
    result = store.read_result("partial")
    assert result.state is JobState.failed
    assert result.message == ORPHAN_MESSAGE
    assert len(result.polars) == 1  # solved-point evidence survives
    assert result.polars[0].points[0].cl == 0.31


def test_terminal_result_with_stale_running_status_syncs_to_result(tmp_path):
    # Crash between write_result(completed) and the final status write: the
    # result is the truth; reconcile must not invent a failure.
    store = make_store(tmp_path)
    seed(store, "raced", JobState.running)
    store.write_result(JobResult(job_id="raced", state=JobState.completed))

    reconciled = store.reconcile_orphans(boot_time=now_utc() + timedelta(seconds=1))

    assert reconciled == ["raced"]
    status = store.read_status("raced")
    assert status.state is JobState.completed
    assert status.phase is JobPhase.completed
    assert status.message != ORPHAN_MESSAGE
    assert store.read_result("raced").state is JobState.completed


def test_missing_jobs_root_is_a_noop(tmp_path):
    store = make_store(tmp_path)
    assert store.reconcile_orphans(boot_time=now_utc()) == []
    assert store.list_job_ids() == []


# --------------------------------------------------------------------------- #
# worker_ready hook
# --------------------------------------------------------------------------- #
class _FakeInspect:
    def __init__(self, active_replies):
        self._active = active_replies

    def active(self):
        return self._active


class _FakeControl:
    def __init__(self, active_replies):
        self._replies = active_replies
        self.revoked: list[str] = []

    def inspect(self, timeout=None):  # noqa: ARG002
        return _FakeInspect(self._replies)

    def revoke(self, task_id):
        self.revoked.append(task_id)


class _FakeApp:
    def __init__(self, active_replies):
        self.control = _FakeControl(active_replies)


class _FakeSender:
    def __init__(self, app):
        self.app = app


def test_worker_ready_hook_reconciles_and_revokes(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data")
    store = JobStore(settings)
    seed(
        store,
        "zombie",
        JobState.running,
        task_id="zombie",
        requested_engine=settings.engine_identity(),
    )
    seed(
        store,
        "alive",
        JobState.running,
        task_id="alive",
        requested_engine=settings.engine_identity(),
    )
    seed(
        store,
        "other-engine",
        JobState.running,
        task_id="other-engine",
        requested_engine=FOUNDATION_14_IDENTITY,
    )

    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(tasks, "_WORKER_BOOT_TIME", now_utc() + timedelta(seconds=1))
    app = _FakeApp({"worker@other": [{"id": "alive"}]})

    tasks.reconcile_orphaned_jobs(sender=_FakeSender(app))

    assert store.read_status("zombie").state is JobState.failed
    assert store.read_status("zombie").message == ORPHAN_MESSAGE
    assert store.read_status("alive").state is JobState.running
    # An OpenCFD worker must never fail a Foundation job merely because that
    # job is absent from this worker's active-task view.
    assert store.read_status("other-engine").state is JobState.running
    # lost task revoked so an acks_late redelivery cannot resurrect the job
    assert app.control.revoked == ["zombie"]


def test_worker_ready_hook_fails_closed_on_inspect_failure(tmp_path, monkeypatch):
    settings = Settings(data_dir=tmp_path / "data")
    store = JobStore(settings)
    seed(
        store,
        "zombie",
        JobState.running,
        requested_engine=settings.engine_identity(),
    )

    monkeypatch.setattr(tasks, "get_settings", lambda: settings)
    monkeypatch.setattr(tasks, "_WORKER_BOOT_TIME", now_utc() + timedelta(seconds=1))

    class _BrokenControl:
        def inspect(self, timeout=None):  # noqa: ARG002
            raise ConnectionError("broker down")

        def revoke(self, task_id):
            raise ConnectionError("broker down")

    class _BrokenApp:
        control = _BrokenControl()

    tasks.reconcile_orphaned_jobs(sender=_FakeSender(_BrokenApp()))

    # Cross-worker state is unknown, so a healthy solve in another container
    # must not be terminalized from a shared filesystem scan.
    assert store.read_status("zombie").state is JobState.running
    assert store.read_status("zombie").message is None
