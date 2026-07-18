"""Celery tasks that run polar jobs in the worker (OpenFOAM-enabled) container."""
from __future__ import annotations

import fcntl
import logging
import math
import os
import signal
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from celery.signals import worker_ready

from .cancellation import JobCancelled
from .capabilities import MESH_RECOVERY_VERSION
from .celery_app import celery_app
from .config import Settings, get_settings
from .jobs import execute_job
from .models import (
    FailureDisposition,
    JobPhase,
    JobResult,
    JobState,
    JobStatus,
    PolarRequest,
)
from .openfoam.runner import (
    DeterministicMeshError,
    InfrastructureError,
    install_subprocess_signal_handlers,
)
from .pipeline import (
    read_divergence_condemnation,
    read_march_budget_marker,
    read_march_stop,
    write_divergence_condemnation,
    write_march_stop,
)
from .storage import JobStore
from .openfoam.dialects import FORCE_COEFFICIENT_FILENAMES

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
    force-coefficient rows (a live transient march appends continuously),
    frame-track PNGs (an advancing media stage writes one per frame), and
    ``.vtu``/``.vtk`` frames (an advancing foamToVTK conversion — which runs in a
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
                name not in FORCE_COEFFICIENT_FILENAMES
                and not name.endswith(".vtu")
                and not name.endswith(".vtk")
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
                engine=(existing.engine if existing is not None else status.engine),
                method_keys=(existing.method_keys if existing is not None else []),
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
    patterns = tuple(
        f"cases/{depth}/postProcessing/forceCoeffs1/*/{filename}"
        for depth in ("*", "*/*", "*/*/*")
        for filename in FORCE_COEFFICIENT_FILENAMES
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


# --------------------------------------------------------------------------- #
# In-run march-rate guard (heartbeat thread, per beat).
#
# Prod 2026-07-09 (job 571efe9f, s1223 c1 u50 @ Re 3.4M, precalc tier): the
# transient reached t=0.0094 s of the 0.4 s chunk target in the FULL 7200 s
# budget — ~85 h projected at the observed rate. With no shedding cycle
# completed there is no measurable period, so the between-chunks budget
# projection guard could never engage and the run burned its whole wall
# budget blind. This watchdog projects the TRAILING simulated-time rate of a
# live transient chunk against the chunk target (armed by the pipeline's
# march_budget.json) and stops a provably hopeless march early: SIGTERM to
# the case's solver processes plus a truthful march_stopped.json marker that
# routes the partial window through the HONEST timeout grading path
# (continuable budget stop, restartable state) — NOT the divergence path,
# whose partial window is garbage.
# --------------------------------------------------------------------------- #

#: Never judge a chunk's first 30 min of wall time: adaptive dt ramps up from
#: a deliberately tiny startup value, so early cumulative rates undershoot.
MARCH_WARMUP_WALL_S = 1800.0

#: Trailing window the rate is measured over (the newest samples only — a
#: slow startup ramp that has since recovered must not doom the projection).
MARCH_TRAIL_WINDOW_S = 900.0

#: Minimum wall span of samples inside the window before a rate is trusted.
MARCH_TRAIL_MIN_SPAN_S = 600.0

#: Stop only the PROVABLY hopeless: projected total wall (elapsed so far plus
#: remaining simulated time at the trailing rate) beyond this multiple of the
#: chunk's wall budget. A run merely projecting past its budget (e.g. 1.3x)
#: is left to reach the budget wall and grade there — a single continuation
#: finishes it; 3x+ means even one full continuation cannot.
MARCH_HOPELESS_FACTOR = 3.0


@dataclass
class _MarchSegmentState:
    """Per-coefficient-segment march-rate state (keyed by file path, like the
    divergence watchdog's). ``wall_start`` mirrors the armed marker so a fresh
    chunk (which rewrites march_budget.json) resets sampling and warmup."""

    wall_start: float
    samples: deque = field(default_factory=deque)  # (wall_time, sim_time)
    stopped_reason: Optional[str] = None


class MarchRateWatchdog:
    """Pure hopeless-march verdict logic (deterministic, directly testable).

    Stops a chunk when, after ``warmup_s`` of wall time, the trailing
    simulated-time rate projects the total wall to reach the chunk target
    beyond ``factor`` times the chunk's wall budget.

    FALSE-POSITIVE GUARDS: nothing is judged during the warmup; the rate is
    measured over a TRAILING window only (a slow dt-ramp start that has since
    recovered never trips); a zero/negative rate is never judged here (a
    frozen march is the stall/divergence watchdogs' verdict, not a
    projection); and a run projecting past its budget by less than ``factor``
    is left to grade honestly at the budget wall."""

    def __init__(
        self,
        warmup_s: float = MARCH_WARMUP_WALL_S,
        window_s: float = MARCH_TRAIL_WINDOW_S,
        min_span_s: float = MARCH_TRAIL_MIN_SPAN_S,
        factor: float = MARCH_HOPELESS_FACTOR,
    ):
        self.warmup_s = float(warmup_s)
        self.window_s = float(window_s)
        self.min_span_s = float(min_span_s)
        self.factor = float(factor)
        self._segments: dict[str, _MarchSegmentState] = {}

    def observe(
        self,
        segment_key: str,
        t_sim: float,
        now: float,
        end_t: float,
        budget_s: float,
        wall_start: float,
        stop_marker_present: bool = True,
    ) -> Optional[str]:
        """One heartbeat sample for one live transient segment. Returns the
        truthful stop reason, or None to leave the solver alone. A stopped
        segment keeps reporting while the on-disk stop marker exists (so the
        caller can escalate SIGTERM -> SIGKILL on stragglers); once the
        pipeline clears the markers for a fresh chunk, the state resets."""
        state = self._segments.get(segment_key)
        if state is None or state.wall_start != wall_start:
            # First sight, or a fresh chunk re-armed the marker: fresh state.
            state = _MarchSegmentState(wall_start=wall_start)
            self._segments[segment_key] = state
        if state.stopped_reason is not None:
            if stop_marker_present:
                return state.stopped_reason
            state = _MarchSegmentState(wall_start=wall_start)
            self._segments[segment_key] = state
        if budget_s <= 0:
            return None
        if state.samples and t_sim < state.samples[-1][1]:
            # Simulated time went backwards: a restart rewrote the segment.
            state.samples.clear()
        if not state.samples or t_sim > state.samples[-1][1] or now > state.samples[-1][0]:
            state.samples.append((now, t_sim))
        while state.samples and now - state.samples[0][0] > self.window_s:
            state.samples.popleft()
        elapsed = now - wall_start
        if elapsed < self.warmup_s:
            return None
        oldest_wall, oldest_t = state.samples[0]
        span = now - oldest_wall
        if span < self.min_span_s:
            return None
        rate = (t_sim - oldest_t) / span
        if rate <= 0.0 or not math.isfinite(rate):
            return None
        remaining = end_t - t_sim
        if remaining <= 0.0:
            return None
        projected_total_s = elapsed + remaining / rate
        if projected_total_s <= self.factor * budget_s:
            return None
        state.stopped_reason = (
            f"march-rate guard: at t={t_sim:.6g}s of {end_t:.6g}s after "
            f"{elapsed / 60.0:.0f} min, the trailing simulated-time rate "
            f"{rate:.3g} s/s projects ~{projected_total_s / 3600.0:.1f}h total wall "
            f"vs the {budget_s / 3600.0:.1f}h budget (>{self.factor:g}x) — "
            f"stopping the hopeless march early with restartable state"
        )
        return state.stopped_reason


def _case_solver_pids(store: JobStore, job_id: str, case_root: Path) -> list[int]:
    """PIDs of the job's solver processes working inside ``case_root``."""
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
    return case_pids


def _stop_hopeless_case(store: JobStore, job_id: str, case_root: Path, reason: str) -> None:
    """Kill the hopeless case's solver process group and leave the truthful
    march-stop marker: the pipeline grades the partial window through the
    honest timeout path (continuable budget stop). Same TERM->KILL escalation
    ladder as the divergence condemnation; the job's other cases keep running."""
    already = read_march_stop(case_root) is not None
    case_pids = _case_solver_pids(store, job_id, case_root)
    if already:
        if case_pids:
            _kill_pids(case_pids, signal.SIGKILL)
        return
    logger.warning(
        "march-rate guard: job %s case %s stopped early — %s (killing pids %s)",
        job_id, case_root.name, reason, case_pids or "none visible",
    )
    write_march_stop(case_root, reason)
    if case_pids:
        _kill_pids(case_pids, signal.SIGTERM)


def _check_and_stop_hopeless_march(
    store: JobStore, job_id: str, watchdog: MarchRateWatchdog, now: Optional[float] = None
) -> None:
    """Heartbeat-thread march-rate check for armed transient chunks."""
    status = store.read_status(job_id)
    if status is None or status.state != JobState.running:
        return
    if status.phase not in DIVERGENCE_MONITORED_PHASES:
        return
    now = time.time() if now is None else now
    for coeff in _live_coefficient_segments(store.job_dir(job_id), now):
        case_root = _case_root_for_coefficient(coeff)
        budget = read_march_budget_marker(case_root)
        if budget is None:
            continue  # not an armed transient chunk (e.g. a steady solve)
        tail = coefficient_tail(coeff)
        if not tail:
            continue
        reason = watchdog.observe(
            str(coeff),
            tail[-1][0],
            now,
            end_t=budget["end_t"],
            budget_s=budget["budget_s"],
            wall_start=budget["wall_start"],
            stop_marker_present=read_march_stop(case_root) is not None,
        )
        if reason is not None:
            _stop_hopeless_case(store, job_id, case_root, reason)


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
        replies = app.control.inspect(timeout=2.0).active()
        if not replies:
            logger.warning(
                "orphan reconcile: celery inspect returned no cross-worker snapshot; "
                "failing closed"
            )
            return
        for rows in replies.values():
            for row in rows or []:
                task_id = (row or {}).get("id")
                if task_id:
                    active_ids.add(str(task_id))
    except Exception:  # noqa: BLE001 - cross-worker uncertainty must never fail healthy work
        logger.warning("orphan reconcile: celery inspect failed; failing closed", exc_info=True)
        return
    reconciled = store.reconcile_orphans(
        boot_time=_WORKER_BOOT_TIME,
        active_task_ids=active_ids,
        worker_engine=get_settings().engine_identity(),
    )
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
    march_watchdog = MarchRateWatchdog()
    # request.json is immutable after submission.  Resolve case identity from
    # it instead of ever combining a live process slug with another parallel
    # future's singular status AoA.
    request = store.read_request(job_id)

    def loop() -> None:
        while not stop.is_set():
            try:
                status = store.read_status(job_id)
                processes = store.job_process_details(job_id)
                active, active_case_slug, active_aoa_deg = _runtime_active_case(
                    processes, status, request
                )
                active_phase = _runtime_active_phase(active, status)
                token_mtime = _active_case_progress_mtime(
                    store.job_dir(job_id), active_case_slug
                )
                last_progress = _runtime_last_progress_at(
                    active,
                    status,
                    token_mtime,
                )
                store.write_runtime_heartbeat(
                    job_id,
                    os.getpid(),
                    len(processes),
                    process_details=processes,
                    phase=active_phase.value if active_phase is not None else None,
                    active_solver=(active or {}).get("command") or (status.active_solver if status else None),
                    active_case_slug=active_case_slug,
                    active_aoa_deg=active_aoa_deg,
                    cpu_tokens_waiting=status.cpu_tokens_waiting if status else None,
                    cpu_tokens_held=status.cpu_tokens_held if status else None,
                    current_case=(active or {}).get("case_slug"),
                    last_progress_at=(
                        last_progress.isoformat() if last_progress is not None else None
                    ),
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
            try:
                # In-run march-rate guard: a transient chunk whose trailing
                # simulated-time rate projects provably hopeless total wall
                # (>3x its budget) is stopped early per-CASE with restartable
                # state and graded as an honest continuable budget stop.
                _check_and_stop_hopeless_march(store, job_id, march_watchdog)
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


def _runtime_active_case(
    processes: list[dict],
    status: Optional[JobStatus],
    request: Optional[PolarRequest],
) -> tuple[dict | None, Optional[str], Optional[float]]:
    """Return one internally-consistent representative active case.

    The runtime API retains singular fields for backwards compatibility even
    when ``case_parallel`` has several live futures.  A process cwd is stronger
    evidence of the selected representative slug than the shared status
    context.  Its AoA therefore comes from the same immutable request case;
    an unknown/nested slug is reported with unknown AoA instead of borrowing a
    different future's value.
    """

    active = _active_process(processes)
    process_slug = (active or {}).get("case_slug")
    status_slug = status.active_case_slug if status is not None else None
    active_slug = process_slug or status_slug
    if active_slug is None:
        return active, None, None

    if request is not None:
        for case in request.cases():
            if case.slug == active_slug:
                return active, active_slug, case.aoa_deg

    if status is not None and active_slug == status_slug:
        return active, active_slug, status.active_aoa_deg
    return active, active_slug, None


def _runtime_active_phase(
    active: Optional[dict], status: Optional[JobStatus]
) -> Optional[JobPhase]:
    """Phase belonging to the same representative process as runtime case.

    Parallel futures may leave the singular persisted status on another
    case's postprocessing callback while pimpleFoam is actively advancing the
    representative case.  A known process mode is direct runtime evidence and
    wins; status is retained only when process inspection cannot classify it.
    """

    phase_by_mode = {
        "urans": JobPhase.solving_urans,
        "rans": JobPhase.solving_rans,
        "meshing": JobPhase.meshing,
    }
    mode = (active or {}).get("solver_mode")
    if mode in phase_by_mode:
        return phase_by_mode[mode]
    return status.phase if status is not None else None


def _active_case_progress_mtime(
    job_dir: Path, case_slug: Optional[str]
) -> Optional[float]:
    """Newest real force-coefficient append for one selected active case.

    This is intentionally a fixed-depth, case-local glob used every heartbeat;
    it never walks the job's potentially huge VTK tree.  A missing token stays
    ``None`` so heartbeats alone cannot invent solver progress.
    """

    if not case_slug:
        return None
    cases_root = (job_dir / "cases").resolve()
    case_root = (cases_root / case_slug).resolve()
    try:
        case_root.relative_to(cases_root)
    except ValueError:
        return None
    if not case_root.is_dir():
        return None

    newest: Optional[float] = None
    for depth in ("", "*", "*/*", "*/*/*"):
        prefix = f"{depth}/" if depth else ""
        for filename in FORCE_COEFFICIENT_FILENAMES:
            pattern = (
                f"{prefix}postProcessing/forceCoeffs1/*/{filename}"
            )
            for coeff in case_root.glob(pattern):
                try:
                    mtime = coeff.stat().st_mtime
                except OSError:
                    continue
                if newest is None or mtime > newest:
                    newest = mtime
    return newest


def _runtime_last_progress_at(
    active: Optional[dict],
    status: Optional[JobStatus],
    active_case_token_mtime: Optional[float],
) -> Optional[datetime]:
    """Newest progress token belonging to the representative runtime case.

    In case-parallel jobs the singular status row may have just been updated
    by a different future.  A real representative process therefore accepts
    ``status.last_progress_at`` only when the status names that same case.  If
    there is no active process, status remains the best available evidence.
    The targeted coefficient mtime always belongs to the selected case.
    """

    process_slug = (active or {}).get("case_slug")
    status_token: Optional[datetime] = None
    if status is not None and (
        active is None
        or (
            process_slug is not None
            and status.active_case_slug == process_slug
        )
    ):
        status_token = status.last_progress_at
    coefficient_token = (
        datetime.fromtimestamp(active_case_token_mtime, timezone.utc)
        if active_case_token_mtime is not None
        else None
    )
    return max(
        (
            stamp
            for stamp in (status_token, coefficient_token)
            if stamp is not None
        ),
        default=None,
    )


def _terminal_failure_disposition(
    exc: Exception,
) -> Optional[FailureDisposition]:
    if isinstance(exc, DeterministicMeshError):
        return FailureDisposition.deterministic_mesh
    if isinstance(exc, InfrastructureError):
        return FailureDisposition.infrastructure
    return None


@celery_app.task(name="airfoilfoam.run_polar", bind=True)
def run_polar(self, job_id: str, request_json: str) -> dict:
    install_subprocess_signal_handlers()
    settings = get_settings()
    runtime_engine = settings.engine_runtime_identity()
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
            # This is the worker-executed capability acknowledgement. The API's
            # earlier pending status intentionally leaves it null so a rolling
            # deployment cannot claim that queued work ran newer code.
            status.mesh_recovery_version = MESH_RECOVERY_VERSION
            status.engine = runtime_engine
            status.execution_pool = settings.celery_queue
            store.write_status(status)
        stop_heartbeat, heartbeat_thread = _start_runtime_heartbeat(store, job_id, settings)
        try:
            result = execute_job(job_id, request, store=store, settings=settings)
        except JobCancelled:
            result = JobResult(
                job_id=job_id,
                state=JobState.cancelled,
                message="cancelled",
                engine=runtime_engine,
                execution_pool=settings.celery_queue,
            )
            status = store.read_status(job_id) or JobStatus(job_id=job_id, state=JobState.cancelled)
            status.state = JobState.cancelled
            status.phase = JobPhase.cancelled
            status.message = "cancelled"
            status.engine = runtime_engine
            status.execution_pool = settings.celery_queue
            store.write_status(status)
            store.write_result(result)
            return {"job_id": job_id, "state": "cancelled"}
        except Exception as exc:  # noqa: BLE001
            failure_disposition = _terminal_failure_disposition(exc)
            store.write_status(
                JobStatus(
                    job_id=job_id,
                    state=JobState.failed,
                    message=f"{type(exc).__name__}: {exc}",
                    engine=runtime_engine,
                    execution_pool=settings.celery_queue,
                    failure_disposition=failure_disposition,
                )
            )
            store.write_result(
                JobResult(
                    job_id=job_id,
                    state=JobState.failed,
                    message=f"{type(exc).__name__}: {exc}",
                    engine=runtime_engine,
                    execution_pool=settings.celery_queue,
                    failure_disposition=failure_disposition,
                )
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
