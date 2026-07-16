"""Filesystem-backed job storage shared between the API and the worker."""
from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional, TypeVar

from .config import Settings, get_settings
from .models import EngineIdentity, JobPhase, JobResult, JobState, JobStatus, PolarRequest

T = TypeVar("T", JobResult, JobStatus, PolarRequest)

#: Message written to jobs whose celery task died with a restarted worker.
#: The node sweeper's failed-path keys off state=failed and ingests this
#: message as attempt evidence, so keep it stable.
ORPHAN_MESSAGE = "worker restarted mid-solve; task lost"

_TERMINAL_STATES = {JobState.completed, JobState.failed, JobState.cancelled}
_STATE_TO_PHASE = {
    JobState.completed: JobPhase.completed,
    JobState.failed: JobPhase.failed,
    JobState.cancelled: JobPhase.cancelled,
}


class JobStore:
    def __init__(self, settings: Optional[Settings] = None):
        self.settings = settings or get_settings()

    # -- paths -------------------------------------------------------------- #
    def job_dir(self, job_id: str) -> Path:
        return self.settings.job_dir(job_id)

    def cases_dir(self, job_id: str) -> Path:
        return self.job_dir(job_id) / "cases"

    def case_dir(self, job_id: str, slug: str) -> Path:
        return self.cases_dir(job_id) / slug

    def file_path(self, job_id: str, relpath: str) -> Path:
        """Resolve a path inside the job dir, guarding against traversal."""
        base = self.job_dir(job_id).resolve()
        target = (self.job_dir(job_id) / relpath).resolve()
        if base not in target.parents and target != base:
            raise ValueError("Path escapes job directory")
        return target

    # -- lifecycle ---------------------------------------------------------- #
    def create(self, job_id: str, request: PolarRequest) -> None:
        from .openfoam.dialects import get_openfoam_dialect

        self.job_dir(job_id).mkdir(parents=True, exist_ok=True)
        cancel_path = self.job_dir(job_id) / "cancelled"
        if cancel_path.exists():
            cancel_path.unlink()
        self._write_json_atomic(self.job_dir(job_id) / "request.json", request.model_dump_json(indent=2))
        total = len(request.cases())
        requested_engine = request.expected_engine or EngineIdentity()
        requested_pool = (
            request.expected_execution_pool
            or get_openfoam_dialect(requested_engine).queue_name
        )
        self.write_status(
            JobStatus(
                job_id=job_id,
                state=JobState.pending,
                total_cases=total,
                queued_at=datetime.now(timezone.utc),
                requested_engine=requested_engine,
                requested_execution_pool=requested_pool,
            )
        )

    def mark_cancelled(self, job_id: str, reason: str = "cancelled") -> None:
        path = self.job_dir(job_id) / "cancelled"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(reason)

    def is_cancelled(self, job_id: str) -> bool:
        return (self.job_dir(job_id) / "cancelled").exists()

    def terminalize_cancelled_result(self, job_id: str, reason: str = "cancelled") -> bool:
        """Make a partial running result terminal after cancellation.

        Incremental publication intentionally writes ``result.json`` while a
        job is running. If the worker disappears before its task catches the
        cancellation marker, status becomes cancelled but that partial result
        used to remain ``running`` forever, which truthfully blocked retention
        and leaked the complete live case directory. Preserve every published
        polar and change only the lifecycle state/message.
        """

        result = self.read_result(job_id)
        if result is None or result.state in {
            JobState.completed,
            JobState.failed,
            JobState.cancelled,
        }:
            return False
        result.state = JobState.cancelled
        result.message = reason
        self.write_result(result)
        return True

    def write_status(self, status: JobStatus) -> None:
        path = self.job_dir(status.job_id) / "status.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        now = datetime.now(timezone.utc)
        previous = self.read_status(status.job_id)
        if previous:
            status.task_id = status.task_id or previous.task_id
            if status.mesh_recovery_version is None:
                status.mesh_recovery_version = previous.mesh_recovery_version
            if status.engine is None:
                status.engine = previous.engine
            if status.requested_engine is None:
                status.requested_engine = previous.requested_engine
            if status.requested_execution_pool is None:
                status.requested_execution_pool = previous.requested_execution_pool
            if status.execution_pool is None:
                status.execution_pool = previous.execution_pool
            if status.failure_disposition is None:
                status.failure_disposition = previous.failure_disposition
            if status.continuation_failure_kind is None:
                status.continuation_failure_kind = (
                    previous.continuation_failure_kind
                )
            status.queued_at = status.queued_at or previous.queued_at
            status.started_at = status.started_at or previous.started_at
            if status.phase == previous.phase and status.phase_started_at is None:
                status.phase_started_at = previous.phase_started_at
            if status.last_progress_at is None:
                status.last_progress_at = previous.last_progress_at
            if status.completed_cases > previous.completed_cases:
                status.last_progress_at = now
            if status.phase != previous.phase:
                # A stage transition IS progress (solving -> postprocessing ->
                # next case). Before 2026-07-07 last_progress_at froze at solve
                # end while a render grind ran for hours inside the worker
                # process, so the node-side detectors saw an eternally quiet
                # but heartbeat-fresh job.
                status.last_progress_at = now
        if status.state == JobState.running and status.started_at is None:
            status.started_at = now
        if status.phase_started_at is None:
            status.phase_started_at = now
        if status.state in {JobState.completed, JobState.failed, JobState.cancelled}:
            status.last_progress_at = status.last_progress_at or now
            if status.phase in {JobPhase.pending, JobPhase.waiting_cpu}:
                status.phase = {
                    JobState.completed: JobPhase.completed,
                    JobState.failed: JobPhase.failed,
                    JobState.cancelled: JobPhase.cancelled,
                }.get(status.state, status.phase)
        status.updated_at = now
        self._write_json_atomic(path, status.model_dump_json(indent=2))

    def read_status(self, job_id: str) -> Optional[JobStatus]:
        status, _ = self.read_status_info(job_id)
        return status

    def read_status_info(self, job_id: str) -> tuple[Optional[JobStatus], Optional[str]]:
        path = self.job_dir(job_id) / "status.json"
        return self._read_model_info(path, JobStatus)

    def write_result(self, result: JobResult) -> None:
        path = self.job_dir(result.job_id) / "result.json"
        if (
            result.mesh_recovery_version is None
            or result.requested_engine is None
            or result.requested_execution_pool is None
            or result.engine is None
            or result.execution_pool is None
            or result.failure_disposition is None
            or result.continuation_failure_kind is None
        ):
            status = self.read_status(result.job_id)
            if status is not None:
                if result.mesh_recovery_version is None:
                    result.mesh_recovery_version = status.mesh_recovery_version
                if result.engine is None:
                    result.engine = status.engine
                if result.requested_engine is None:
                    result.requested_engine = status.requested_engine
                if result.requested_execution_pool is None:
                    result.requested_execution_pool = status.requested_execution_pool
                if result.execution_pool is None:
                    result.execution_pool = status.execution_pool
                if result.failure_disposition is None:
                    result.failure_disposition = status.failure_disposition
                if result.continuation_failure_kind is None:
                    result.continuation_failure_kind = (
                        status.continuation_failure_kind
                    )
        self._write_json_atomic(path, result.model_dump_json(indent=2))

    def read_result(self, job_id: str) -> Optional[JobResult]:
        result, _ = self.read_result_info(job_id)
        return result

    def read_result_info(self, job_id: str) -> tuple[Optional[JobResult], Optional[str]]:
        path = self.job_dir(job_id) / "result.json"
        return self._read_model_info(path, JobResult)

    def read_request(self, job_id: str) -> Optional[PolarRequest]:
        path = self.job_dir(job_id) / "request.json"
        request, _ = self._read_model_info(path, PolarRequest)
        return request

    def write_runtime_heartbeat(
        self,
        job_id: str,
        worker_pid: int,
        process_count: int,
        *,
        process_details: Optional[list[dict]] = None,
        phase: Optional[str] = None,
        active_solver: Optional[str] = None,
        active_case_slug: Optional[str] = None,
        active_aoa_deg: Optional[float] = None,
        cpu_tokens_waiting: Optional[int] = None,
        cpu_tokens_held: Optional[int] = None,
        current_case: Optional[str] = None,
        last_progress_at: Optional[str] = None,
    ) -> None:
        payload = {
            "job_id": job_id,
            "worker_pid": worker_pid,
            "process_count": process_count,
            "processes": process_details or [],
            "heartbeat_at": datetime.now(timezone.utc).isoformat(),
        }
        if phase is not None:
            payload["phase"] = phase
        if active_solver is not None:
            payload["active_solver"] = active_solver
        if active_case_slug is not None:
            payload["active_case_slug"] = active_case_slug
        if active_aoa_deg is not None:
            payload["active_aoa_deg"] = active_aoa_deg
        if cpu_tokens_waiting is not None:
            payload["cpu_tokens_waiting"] = cpu_tokens_waiting
        if cpu_tokens_held is not None:
            payload["cpu_tokens_held"] = cpu_tokens_held
        if current_case is not None:
            payload["current_case"] = current_case
        if last_progress_at is not None:
            payload["last_progress_at"] = last_progress_at
        self._write_json_atomic(self.job_dir(job_id) / "runtime.json", json.dumps(payload, indent=2))

    def read_runtime_info(self, job_id: str) -> tuple[Optional[dict], Optional[str]]:
        path = self.job_dir(job_id) / "runtime.json"
        if not path.exists():
            return None, None
        try:
            text = path.read_text(encoding="utf-8")
            if not text.strip():
                return None, "empty JSON file"
            data = json.loads(text)
            return data if isinstance(data, dict) else None, None
        except Exception as exc:  # noqa: BLE001
            return None, f"{type(exc).__name__}: {exc}"

    def exists(self, job_id: str) -> bool:
        return self.job_dir(job_id).exists()

    def list_job_ids(self) -> list[str]:
        jobs_root = self.settings.data_dir / "jobs"
        if not jobs_root.is_dir():
            return []
        return sorted(entry.name for entry in jobs_root.iterdir() if entry.is_dir())

    # -- orphan reconciliation ---------------------------------------------- #
    def reconcile_orphans(
        self,
        *,
        boot_time: Optional[datetime] = None,
        active_task_ids: Optional[set[str]] = None,
        worker_engine: Optional[EngineIdentity] = None,
    ) -> list[str]:
        """Mark jobs stranded at state=running by a dead worker as failed.

        Celery tasks die with the worker process, so at worker boot any job
        still persisted as ``running`` (and not touched since ``boot_time``,
        and not active on another worker) can no longer be making progress.
        Without this sweep the API keeps answering ``state=running`` forever
        and node-side pollers treat the job as a zombie.

        ``pending`` jobs are deliberately left alone: their queue messages
        survive a worker restart (acks_late) and the fresh worker will pick
        them up normally.

        Returns the list of reconciled job ids.
        """
        boot_time = boot_time or datetime.now(timezone.utc)
        active = active_task_ids or set()
        reconciled: list[str] = []
        for job_id in self.list_job_ids():
            status = self.read_status(job_id)
            if status is None or status.state is not JobState.running:
                continue
            # Each execution-pool worker may reconcile only the jobs it could
            # actually have inherited. Strict equality includes the adapter
            # contract revision; missing legacy provenance is not guessed in
            # this cross-worker safety path.
            if worker_engine is not None and status.requested_engine != worker_engine:
                continue
            # Genuinely active on some worker (task ids double as job ids for
            # run_polar, so check both).
            if job_id in active or (status.task_id and status.task_id in active):
                continue
            # Touched at/after this worker booted -> a fresh task owns it.
            updated = status.updated_at
            if updated is not None:
                if updated.tzinfo is None:
                    updated = updated.replace(tzinfo=timezone.utc)
                if updated >= boot_time:
                    continue
            existing_result = self.read_result(job_id)
            if existing_result is not None and existing_result.state in _TERMINAL_STATES:
                # Crash landed between write_result() and the final status
                # write: the result is the truth, so sync status to it instead
                # of inventing a failure.
                status.state = existing_result.state
                status.phase = _STATE_TO_PHASE[existing_result.state]
                status.message = existing_result.message or status.message
            else:
                status.state = JobState.failed
                status.phase = JobPhase.failed
                status.message = ORPHAN_MESSAGE
                if existing_result is not None:
                    # Partial result from mid-run: keep the solved-point /
                    # attempt evidence, only flip the terminal state.
                    existing_result.state = JobState.failed
                    existing_result.message = ORPHAN_MESSAGE
                    self.write_result(existing_result)
                else:
                    self.write_result(
                        JobResult(
                            job_id=job_id,
                            state=JobState.failed,
                            message=ORPHAN_MESSAGE,
                            engine=status.engine,
                        )
                    )
            status.active_solver = None
            status.active_case_slug = None
            status.active_aoa_deg = None
            status.active_pids = []
            status.cpu_tokens_waiting = 0
            status.cpu_tokens_held = 0
            self.write_status(status)
            reconciled.append(job_id)
        return reconciled

    def job_processes(self, job_id: str) -> list[int]:
        return [proc["pid"] for proc in self.job_process_details(job_id)]

    def job_process_details(self, job_id: str) -> list[dict]:
        proc_root = Path("/proc")
        if not proc_root.exists():
            return []
        root = self.job_dir(job_id).resolve()
        processes: list[dict] = []
        for proc in proc_root.iterdir():
            if not proc.name.isdigit():
                continue
            pid = int(proc.name)
            if pid == os.getpid():
                continue
            try:
                cwd = (proc / "cwd").resolve()
            except (FileNotFoundError, ProcessLookupError, PermissionError):
                continue
            try:
                cwd.relative_to(root)
            except ValueError:
                continue
            command = self._read_proc_command(proc)
            case_slug = self._case_slug_for_cwd(root, cwd)
            processes.append(
                {
                    "pid": pid,
                    "command": command,
                    "cwd": str(cwd),
                    "case_slug": case_slug,
                    "solver_mode": self._solver_mode(command, cwd),
                    "elapsed_sec": self._proc_elapsed_seconds(proc),
                }
            )
        return sorted(processes, key=lambda item: item["pid"])

    def _read_proc_command(self, proc: Path) -> str:
        try:
            raw = (proc / "cmdline").read_bytes()
            command = raw.replace(b"\x00", b" ").decode(errors="replace").strip()
            if command:
                return command
        except Exception:
            pass
        try:
            return (proc / "comm").read_text(encoding="utf-8", errors="replace").strip()
        except Exception:
            return proc.name

    def _case_slug_for_cwd(self, root: Path, cwd: Path) -> Optional[str]:
        try:
            rel = cwd.relative_to(root / "cases")
        except ValueError:
            return None
        parts = rel.parts
        return parts[0] if parts else None

    def _solver_mode(self, command: str, cwd: Path) -> Optional[str]:
        name = command.lower()
        cwd_text = str(cwd).lower()
        if "pimplefoam" in name or "/urans_" in cwd_text:
            return "urans"
        if "simplefoam" in name:
            return "rans"
        if "foamrun" in name and "incompressiblefluid" in name:
            if "urans" in cwd_text or "transient" in cwd_text:
                return "urans"
            return "rans"
        if "blockmesh" in name or "snappyhexmesh" in name or "extrudemesh" in name:
            return "meshing"
        return None

    def _proc_elapsed_seconds(self, proc: Path) -> Optional[float]:
        try:
            ticks_per_sec = os.sysconf(os.sysconf_names["SC_CLK_TCK"])
            uptime = float(Path("/proc/uptime").read_text().split()[0])
            start_ticks = int((proc / "stat").read_text().split()[21])
            return max(0.0, uptime - (start_ticks / ticks_per_sec))
        except Exception:
            return None

    def _write_json_atomic(self, path: Path, payload: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp_name = ""
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", suffix=".tmp", delete=False) as tmp:
            tmp_name = tmp.name
            tmp.write(payload)
            tmp.flush()
            os.fsync(tmp.fileno())
        os.replace(tmp_name, path)
        try:
            dir_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError:
            pass

    def _read_model_info(self, path: Path, model: type[T]) -> tuple[Optional[T], Optional[str]]:
        if not path.exists():
            return None, None
        try:
            text = path.read_text(encoding="utf-8")
            if not text.strip():
                return None, "empty JSON file"
            return model.model_validate_json(text), None
        except Exception as exc:  # noqa: BLE001 - runtime endpoint needs the exact read failure
            return None, f"{type(exc).__name__}: {exc}"
