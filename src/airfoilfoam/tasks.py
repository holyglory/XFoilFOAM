"""Celery tasks that run polar jobs in the worker (OpenFOAM-enabled) container."""
from __future__ import annotations

import fcntl
import logging
import os
import signal
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from celery.signals import worker_ready

from .cancellation import JobCancelled
from .celery_app import celery_app
from .config import Settings, get_settings
from .jobs import execute_job
from .models import JobPhase, JobResult, JobState, JobStatus, PolarRequest
from .openfoam.runner import install_subprocess_signal_handlers
from .pipeline import read_divergence_condemnation, write_divergence_condemnation
from .storage import JobStore

HEARTBEAT_INTERVAL_S = 10

#: Exit code of a worker child that condemned its own stalled task (forensics
#: in container logs; celery reports the task as failed either way).
STALLED_TASK_EXIT_CODE = 70

#: Phases the stall detector monitors. waiting_cpu is excluded (legitimately
#: quiet and process-free); meshing/ingesting run external subprocesses or are
#: short-lived and cheap.
STALL_MONITORED_PHASES = frozenset(
    {JobPhase.solving_rans, JobPhase.solving_urans, JobPhase.postprocessing}
)

logger = logging.getLogger(__name__)


def newest_progress_file_mtime(job_dir: Path) -> Optional[float]:
    """Newest mtime of the on-disk progress tokens under a job's cases tree:
    ``coefficient.dat`` rows (a live pimpleFoam march appends continuously),
    frame-track PNGs (an advancing media stage writes one per frame), and
    ``.vtu`` frames (an advancing foamToVTK conversion — which runs in a
    separate container under the docker runner, invisible to the /proc scan).
    Returns None when no token file exists. Walks only when called — the
    caller short-circuits on cheap status.json evidence first."""
    newest: Optional[float] = None
    cases_root = job_dir / "cases"
    if not cases_root.exists():
        return None
    for root, _dirs, files in os.walk(cases_root):
        in_frames = "frames" in Path(root).parts[-2:]
        for name in files:
            if (
                name != "coefficient.dat"
                and not name.endswith(".vtu")
                and not (in_frames and name.endswith(".png"))
            ):
                continue
            try:
                mtime = (Path(root) / name).stat().st_mtime
            except OSError:
                continue
            if newest is None or mtime > newest:
                newest = mtime
    return newest


def stall_reason(
    status: Optional[JobStatus],
    process_count: int,
    newest_token_unix: Optional[float],
    now_unix: float,
    threshold_s: float,
) -> Optional[str]:
    """The condemnation reason for a stalled task, or None to leave it alone.

    FALSE-POSITIVE GUARDS (must never condemn):
      - any live process with cwd inside the job dir (a legitimate long
        pimpleFoam march, foamToVTK, reconstructPar, ...): ``process_count > 0``;
      - an advancing progress token: status.json updated (phase transitions,
        completed cases, render progress messages all bump ``updated_at``),
        coefficient.dat rows appended, or frame PNGs written within the
        threshold;
      - phases that are legitimately quiet (pending/waiting_cpu/terminal).
    """
    if status is None or status.state != JobState.running:
        return None
    if status.phase not in STALL_MONITORED_PHASES:
        return None
    if process_count > 0:
        return None
    tokens = [
        t.timestamp()
        for t in (status.updated_at, status.last_progress_at, status.phase_started_at)
        if t is not None
    ]
    if newest_token_unix is not None:
        tokens.append(float(newest_token_unix))
    if not tokens:
        return None
    quiet_s = now_unix - max(tokens)
    if quiet_s < threshold_s:
        return None
    return f"stalled in {status.phase.value} — no progress for {int(quiet_s // 60)}m"


def _check_and_condemn_stall(store: JobStore, job_id: str, settings: Settings) -> None:
    """Heartbeat-thread stall check. On a confirmed stall the job is marked
    FAILED (the handled class: the node ingests the failure, releases the
    points, and the terminal-result guard in ``run_polar`` discards any broker
    redelivery) and the worker CHILD process exits — the only way to stop an
    in-process C-level grind that cooperative cancel checks can never reach
    (2026-07-07: matplotlib CubicTriInterpolator CG solves pinned tasks for
    3+ hours with a fresh heartbeat)."""
    threshold_s = settings.stall_no_progress_minutes * 60.0
    status = store.read_status(job_id)
    if status is None or status.state != JobState.running or status.phase not in STALL_MONITORED_PHASES:
        return
    now_unix = time.time()
    # Cheap short-circuit: fresh status.json (any write bumps updated_at)
    # spares the job without walking the cases tree.
    if status.updated_at is not None and now_unix - status.updated_at.timestamp() < threshold_s:
        return
    processes = store.job_process_details(job_id)
    reason = stall_reason(
        status,
        len(processes),
        newest_progress_file_mtime(store.job_dir(job_id)),
        now_unix,
        threshold_s,
    )
    if reason is None:
        return
    logger.error("stall detector: job %s %s — failing job and exiting worker child", job_id, reason)
    try:
        existing = store.read_result(job_id)
        status.state = JobState.failed
        status.phase = JobPhase.failed
        status.message = reason
        store.write_status(status)
        store.write_result(
            JobResult(
                job_id=job_id,
                state=JobState.failed,
                polars=existing.polars if existing is not None else [],
                message=reason,
            )
        )
    except Exception:  # noqa: BLE001 - the exit below still converts the grind to the handled death class
        logger.exception("stall detector: failed to persist stalled state for job %s", job_id)
    os._exit(STALLED_TASK_EXIT_CODE)

# --------------------------------------------------------------------------- #
# In-run divergence watchdog (heartbeat thread, per beat).
#
# Prod 2026-07-07 (job b01a7d46, naca-0012 a0 u15): a long-horizon URANS run
# accumulated splitting error into a velocity singularity — |Cl| excursions
# ±9.45e5, k bounding blow-up, dt collapse 8e-6 → 5e-8, simulated time frozen
# at 0.069 s for the FULL 7200 s wall budget. The honesty machinery graded and
# rejected the garbage afterwards, but 2 h of CPU were burned producing it.
# The watchdog reads the active case's newest coefficient.dat tail every beat
# and condemns a case that is provably diverging: the solver process group is
# killed (SIGTERM, like the runner wall-clock timeout) and a truthful marker
# makes the pipeline fail the CASE through the existing failed/timeout grading
# path (attempt evidence retained, honest error) — NOT the stall detector's
# whole-job os._exit.
# --------------------------------------------------------------------------- #

#: Phases the divergence watchdog monitors (a live solver writing coefficients).
DIVERGENCE_MONITORED_PHASES = frozenset({JobPhase.solving_rans, JobPhase.solving_urans})

#: Consecutive heartbeat samples with |Cl| beyond the sanity bound required to
#: condemn (~30 s at the 10 s beat): one spurious spike row never condemns,
#: while a genuine blow-up stays insane on every beat.
DIVERGENCE_CL_CONSECUTIVE = 3

#: Grace for legitimately tiny adaptive timesteps right after a (re)start:
#: the dt-collapse clock does not tick during a case's first 60 s of
#: observation, so startup ramps are never condemned.
DIVERGENCE_STARTUP_GRACE_S = 60.0

#: Only coefficient files touched this recently are considered live; a
#: finished steady-init segment's stale rows must never condemn the healthy
#: transient that follows it.
DIVERGENCE_ACTIVE_WINDOW_S = 120.0

#: Rows read from the coefficient.dat tail per beat.
DIVERGENCE_TAIL_ROWS = 20

#: Bytes read from the file tail (covers >20 rows of forceCoeffs output).
_COEFF_TAIL_BYTES = 32768

#: forceCoeffs coefficient.dat column layout (OpenFOAM default when the header
#: is unreadable): Time Cd Cd(f) Cd(r) Cl ...
_COEFF_DEFAULT_TIME_COL = 0
_COEFF_DEFAULT_CL_COL = 4


def coefficient_tail(path: Path, max_rows: int = DIVERGENCE_TAIL_ROWS) -> list[tuple[float, float]]:
    """(time, Cl) of the last ``max_rows`` data rows of a coefficient.dat —
    cheap: reads the header from the file head and only the tail bytes."""
    time_col, cl_col = _COEFF_DEFAULT_TIME_COL, _COEFF_DEFAULT_CL_COL
    try:
        with path.open("rb") as fh:
            head = fh.read(4096).decode(errors="replace")
            for line in head.splitlines():
                stripped = line.strip()
                if not stripped.startswith("#"):
                    break
                names = stripped.lstrip("#").split()
                if "Time" in names and "Cl" in names:
                    time_col = names.index("Time")
                    cl_col = names.index("Cl")
            fh.seek(0, os.SEEK_END)
            size = fh.tell()
            offset = max(0, size - _COEFF_TAIL_BYTES)
            fh.seek(offset)
            tail = fh.read().decode(errors="replace")
    except OSError:
        return []
    lines = tail.splitlines()
    if offset > 0 and lines:
        lines = lines[1:]  # first line may be a partial row
    rows: list[tuple[float, float]] = []
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        parts = stripped.split()
        if len(parts) <= max(time_col, cl_col):
            continue
        try:
            rows.append((float(parts[time_col]), float(parts[cl_col])))
        except ValueError:
            continue
    return rows[-max_rows:]


def _tail_delta_t(tail: list[tuple[float, float]]) -> Optional[float]:
    """Median positive time delta of the tail rows — the live adaptive dt."""
    deltas = sorted(
        b[0] - a[0] for a, b in zip(tail, tail[1:]) if b[0] - a[0] > 0.0
    )
    if not deltas:
        return None
    return deltas[len(deltas) // 2]


@dataclass
class _SegmentState:
    """Per-coefficient-segment watchdog state. Keyed by FILE path so every
    solver attempt/segment earns a fresh verdict (a condemned steady init must
    not pre-condemn — or immunise — the pimpleFoam segment that follows).

    Retry attempts can REUSE a condemned segment's path (the steady upwind
    fallback rewrites forceCoeffs1/0/coefficient.dat in the same case dir), so
    a condemned state is dropped for a fresh verdict once the pipeline clears
    the on-disk marker AND the file's newest row changes; while the file still
    shows the killed attempt's unchanged tail (marker cleared, retry not yet
    writing) nothing is judged at all — see ``DivergenceWatchdog.observe``."""

    first_seen: float
    insane_beats: int = 0
    dt_below_since: Optional[float] = None
    condemned_reason: Optional[str] = None
    condemned_last_time: Optional[float] = None


class DivergenceWatchdog:
    """Pure divergence-verdict logic (deterministic, directly testable).

    Condemns when EITHER:
      - |Cl| of the newest coefficient row exceeds ``cl_bound`` on
        ``DIVERGENCE_CL_CONSECUTIVE`` consecutive beats (physical post-stall
        |Cl| stays below ~3; a blow-up shoots past 50 and stays there), OR
      - the adaptive dt (from coefficient time deltas) stays below
        ``dt_floor`` with NO recovery for ``grace_s`` (dt collapse: the run
        would burn its whole wall budget frozen in simulated time).

    FALSE-POSITIVE GUARDS: post-stall high lift never trips the bound; the
    dt clock never ticks during the first ``startup_grace_s`` of a segment's
    observation and RESETS whenever dt recovers above the floor.
    """

    def __init__(
        self,
        cl_bound: float,
        dt_floor: float,
        grace_s: float,
        startup_grace_s: float = DIVERGENCE_STARTUP_GRACE_S,
        consecutive: int = DIVERGENCE_CL_CONSECUTIVE,
    ):
        self.cl_bound = float(cl_bound)
        self.dt_floor = float(dt_floor)
        self.grace_s = float(grace_s)
        self.startup_grace_s = float(startup_grace_s)
        self.consecutive = max(1, int(consecutive))
        self._segments: dict[str, _SegmentState] = {}

    def observe(
        self,
        segment_key: str,
        tail: list[tuple[float, float]],
        now: float,
        marker_present: bool = True,
    ) -> Optional[str]:
        """One heartbeat sample for one live coefficient segment. Returns the
        truthful condemnation reason, or None to leave the solver alone.

        ``marker_present`` is whether the case's on-disk condemnation marker
        still exists. While it does, a condemned segment keeps reporting so the
        caller can escalate SIGTERM -> SIGKILL on stragglers. Once the pipeline
        CLEARS the marker (fresh retry attempt — the steady upwind fallback
        reuses the very same coefficient.dat path), the stale verdict must not
        kill the retry: an unchanged dead tail is not judged at all, and the
        first CHANGED tail (truncated rewrite or new rows) resets the segment
        for a completely fresh verdict."""
        state = self._segments.get(segment_key)
        if state is None:
            state = _SegmentState(first_seen=now)
            self._segments[segment_key] = state
        if state.condemned_reason is not None:
            if marker_present:
                # Keep reporting so the caller can escalate SIGTERM -> SIGKILL
                # on stragglers (the marker dedupes the actual condemnation).
                return state.condemned_reason
            if (
                tail
                and state.condemned_last_time is not None
                and tail[-1][0] == state.condemned_last_time
            ):
                # Marker cleared but the file still shows the killed attempt's
                # unchanged rows (retry not writing yet) — nothing new to judge.
                return None
            # Fresh attempt owns this path now: fresh verdict.
            state = _SegmentState(first_seen=now)
            self._segments[segment_key] = state
        if not tail:
            return None
        t_last, cl_last = tail[-1]
        dt = _tail_delta_t(tail)

        # Rule 1: coefficient sanity bound, sustained.
        if abs(cl_last) > self.cl_bound:
            state.insane_beats += 1
        else:
            state.insane_beats = 0

        # Rule 2: persistent dt collapse (never during the startup ramp).
        dt_collapsed = False
        if dt is not None and dt < self.dt_floor:
            if now - state.first_seen >= self.startup_grace_s:
                if state.dt_below_since is None:
                    state.dt_below_since = now
                elif now - state.dt_below_since >= self.grace_s:
                    dt_collapsed = True
        else:
            state.dt_below_since = None  # recovery resets the clock

        if state.insane_beats < self.consecutive and not dt_collapsed:
            return None
        dt_s = f"{dt:.3g}" if dt is not None else "unknown"
        state.condemned_reason = (
            f"transient diverged at t={t_last:.6g}: |Cl|={abs(cl_last):.4g}, dt={dt_s}"
        )
        state.condemned_last_time = t_last
        return state.condemned_reason


def _case_root_for_coefficient(coeff_path: Path) -> Path:
    """…/<case>/postProcessing/forceCoeffs1/<t>/coefficient.dat -> <case>."""
    return coeff_path.parents[3]


def _live_coefficient_segments(job_dir: Path, now: float) -> list[Path]:
    """The newest recently-written coefficient.dat per case dir. Targeted
    globs (cases can nest as <slug>/, <polar>/transient_aN/ or
    <polar>/urans_aN/transient/) so no walk over time/VTK dirs happens."""
    patterns = (
        "cases/*/postProcessing/forceCoeffs1/*/coefficient.dat",
        "cases/*/*/postProcessing/forceCoeffs1/*/coefficient.dat",
        "cases/*/*/*/postProcessing/forceCoeffs1/*/coefficient.dat",
    )
    newest_per_case: dict[Path, tuple[float, Path]] = {}
    for pattern in patterns:
        for coeff in job_dir.glob(pattern):
            try:
                mtime = coeff.stat().st_mtime
            except OSError:
                continue
            if now - mtime > DIVERGENCE_ACTIVE_WINDOW_S:
                continue
            case_root = _case_root_for_coefficient(coeff)
            best = newest_per_case.get(case_root)
            if best is None or mtime > best[0]:
                newest_per_case[case_root] = (mtime, coeff)
    return [coeff for _mtime, coeff in newest_per_case.values()]


def _condemn_diverged_case(store: JobStore, job_id: str, case_root: Path, reason: str) -> None:
    """Kill the diverging case's solver process group and leave the truthful
    marker for the pipeline. Reuses the runner-timeout kill semantics (SIGTERM
    to the process group; the runner reaps the child and the pipeline fails
    the CASE) — the job itself keeps running its other cases."""
    already = read_divergence_condemnation(case_root) is not None
    case_pids = []
    for proc in store.job_process_details(job_id):
        cwd = proc.get("cwd")
        if not cwd:
            continue
        try:
            Path(cwd).relative_to(case_root)
        except ValueError:
            continue
        case_pids.append(int(proc["pid"]))
    if already:
        # Second beat after condemnation: escalate stragglers, exactly like
        # the runner's TERM→KILL timeout ladder.
        if case_pids:
            _kill_pids(case_pids, signal.SIGKILL)
        return
    logger.error(
        "divergence watchdog: job %s case %s condemned — %s (killing pids %s)",
        job_id, case_root.name, reason, case_pids or "none visible",
    )
    write_divergence_condemnation(case_root, reason)
    if case_pids:
        _kill_pids(case_pids, signal.SIGTERM)


def _check_and_condemn_divergence(
    store: JobStore, job_id: str, watchdog: DivergenceWatchdog, now: Optional[float] = None
) -> None:
    """Heartbeat-thread divergence check while a solver phase is active."""
    status = store.read_status(job_id)
    if status is None or status.state != JobState.running:
        return
    if status.phase not in DIVERGENCE_MONITORED_PHASES:
        return
    now = time.time() if now is None else now
    for coeff in _live_coefficient_segments(store.job_dir(job_id), now):
        case_root = _case_root_for_coefficient(coeff)
        # The pipeline clears the case marker before every fresh attempt; the
        # watchdog uses its presence to distinguish "escalate on the condemned
        # solver" from "a retry owns this path now — fresh verdict".
        marker_present = read_divergence_condemnation(case_root) is not None
        reason = watchdog.observe(
            str(coeff), coefficient_tail(coeff), now, marker_present=marker_present
        )
        if reason is not None:
            _condemn_diverged_case(store, job_id, case_root, reason)


# Captured at import time in the worker's main process, i.e. strictly before
# the consumer accepts any task. Any status.json touched at/after this instant
# belongs to a task started by THIS worker and must not be reconciled.
_WORKER_BOOT_TIME = datetime.now(timezone.utc)


@worker_ready.connect
def reconcile_orphaned_jobs(sender=None, **_kwargs) -> None:
    """Fail jobs whose celery task died with a previous worker process.

    Hooked at ``worker_ready`` (not API startup) because the worker owns task
    execution: an API restart while a healthy worker is mid-solve must not
    fail live jobs, whereas a freshly booted worker provably inherited no
    running tasks — they die with the process. A cross-worker ``inspect``
    plus the boot-time guard keeps this safe even if multiple workers or
    racy restart orders ever appear.
    """
    store = JobStore(get_settings())
    app = getattr(sender, "app", None) or celery_app
    active_ids: set[str] = set()
    try:
        replies = app.control.inspect(timeout=2.0).active() or {}
        for rows in replies.values():
            for row in rows or []:
                task_id = (row or {}).get("id")
                if task_id:
                    active_ids.add(str(task_id))
    except Exception:  # noqa: BLE001 - best effort; the boot-time guard still protects fresh tasks
        logger.warning("orphan reconcile: celery inspect failed; relying on boot-time guard", exc_info=True)
    reconciled = store.reconcile_orphans(boot_time=_WORKER_BOOT_TIME, active_task_ids=active_ids)
    for job_id in reconciled:
        # acks_late means Redis may redeliver the lost task after its
        # visibility timeout; revoke so a redelivery is discarded instead of
        # resurrecting a job the node already failed (task_id == job_id).
        try:
            app.control.revoke(job_id)
        except Exception:  # noqa: BLE001
            pass
        logger.warning("orphan reconcile: job %s marked failed (worker restarted mid-solve; task lost)", job_id)
    if reconciled:
        logger.warning("orphan reconcile: %d job(s) reconciled at worker boot", len(reconciled))


def _kill_pids(pids: list[int], sig: int) -> None:
    pgids: set[int] = set()
    for pid in pids:
        try:
            pgids.add(os.getpgid(pid))
        except ProcessLookupError:
            pass
    for pgid in pgids:
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            pass
    for pid in pids:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


@celery_app.task(name="airfoilfoam.kill_job_processes")
def kill_job_processes(job_id: str) -> dict:
    settings = get_settings()
    store = JobStore(settings)
    pids = store.job_processes(job_id)
    _kill_pids(pids, signal.SIGTERM)
    time.sleep(1)
    remaining = store.job_processes(job_id)
    _kill_pids(remaining, signal.SIGKILL)
    return {"job_id": job_id, "terminated": pids, "killed": remaining}


def _start_runtime_heartbeat(
    store: JobStore, job_id: str, settings: Optional[Settings] = None
) -> tuple[threading.Event, threading.Thread]:
    stop = threading.Event()
    settings = settings or get_settings()
    divergence_watchdog = DivergenceWatchdog(
        cl_bound=settings.divergence_cl_bound,
        dt_floor=settings.divergence_dt_floor,
        grace_s=settings.divergence_grace_minutes * 60.0,
    )

    def loop() -> None:
        while not stop.is_set():
            try:
                status = store.read_status(job_id)
                processes = store.job_process_details(job_id)
                active = _active_process(processes)
                store.write_runtime_heartbeat(
                    job_id,
                    os.getpid(),
                    len(processes),
                    process_details=processes,
                    phase=status.phase.value if status else None,
                    active_solver=(active or {}).get("command") or (status.active_solver if status else None),
                    active_case_slug=(active or {}).get("case_slug") or (status.active_case_slug if status else None),
                    active_aoa_deg=status.active_aoa_deg if status else None,
                    cpu_tokens_waiting=status.cpu_tokens_waiting if status else None,
                    cpu_tokens_held=status.cpu_tokens_held if status else None,
                    current_case=(active or {}).get("case_slug"),
                    last_progress_at=status.last_progress_at.isoformat() if status and status.last_progress_at else None,
                )
            except Exception:
                pass
            try:
                # Engine-side stall guardrail: a solving/postprocessing task
                # with no live processes and a frozen progress token is
                # condemned instead of grinding forever (exits the process).
                _check_and_condemn_stall(store, job_id, settings)
            except Exception:
                pass
            try:
                # In-run divergence watchdog: a solver whose coefficients blew
                # past the sanity bound (or whose dt collapsed persistently)
                # is killed per-CASE with a truthful marker; the pipeline then
                # fails that case through the normal grading path while the
                # rest of the job continues.
                _check_and_condemn_divergence(store, job_id, divergence_watchdog)
            except Exception:
                pass
            stop.wait(HEARTBEAT_INTERVAL_S)

    thread = threading.Thread(target=loop, name=f"job-heartbeat-{job_id[:8]}", daemon=True)
    thread.start()
    return stop, thread


def _active_process(processes: list[dict]) -> dict | None:
    for mode in ("urans", "rans", "meshing"):
        for proc in processes:
            if proc.get("solver_mode") == mode:
                return proc
    return processes[0] if processes else None


@celery_app.task(name="airfoilfoam.run_polar", bind=True)
def run_polar(self, job_id: str, request_json: str) -> dict:
    install_subprocess_signal_handlers()
    settings = get_settings()
    store = JobStore(settings)
    request = PolarRequest.model_validate_json(request_json)
    lock_path = store.job_dir(job_id) / ".execute.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("w") as lock_file:
        try:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            existing = store.read_result(job_id)
            if existing:
                return {"job_id": job_id, "state": existing.state.value}
            return {"job_id": job_id, "state": "duplicate-skipped"}
        # Terminal results are never resurrected: a broker redelivery after the
        # stall detector / boot reconcile / a hard time-limit kill failed the
        # job must be discarded, not re-executed (the node already released and
        # requeued the points into new jobs).
        existing = store.read_result(job_id)
        if existing and existing.state in {JobState.completed, JobState.failed, JobState.cancelled}:
            return {"job_id": job_id, "state": existing.state.value}
        status = store.read_status(job_id)
        if status:
            status.task_id = getattr(self.request, "id", None) or status.task_id
            status.state = JobState.running
            store.write_status(status)
        stop_heartbeat, heartbeat_thread = _start_runtime_heartbeat(store, job_id, settings)
        try:
            result = execute_job(job_id, request, store=store, settings=settings)
        except JobCancelled:
            result = JobResult(job_id=job_id, state=JobState.cancelled, message="cancelled")
            status = store.read_status(job_id) or JobStatus(job_id=job_id, state=JobState.cancelled)
            status.state = JobState.cancelled
            status.phase = JobPhase.cancelled
            status.message = "cancelled"
            store.write_status(status)
            store.write_result(result)
            return {"job_id": job_id, "state": "cancelled"}
        except Exception as exc:  # noqa: BLE001
            store.write_status(
                JobStatus(job_id=job_id, state=JobState.failed, message=f"{type(exc).__name__}: {exc}")
            )
            store.write_result(
                JobResult(job_id=job_id, state=JobState.failed, message=f"{type(exc).__name__}: {exc}")
            )
            raise
        finally:
            stop_heartbeat.set()
            heartbeat_thread.join(timeout=2)
            try:
                status = store.read_status(job_id)
                store.write_runtime_heartbeat(
                    job_id,
                    os.getpid(),
                    0,
                    phase=status.phase.value if status else None,
                    cpu_tokens_waiting=status.cpu_tokens_waiting if status else 0,
                    cpu_tokens_held=status.cpu_tokens_held if status else 0,
                )
            except Exception:
                pass
        return {"job_id": job_id, "state": result.state.value}
