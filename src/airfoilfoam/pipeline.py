"""Run CFD cases end to end: mesh -> solve -> coefficients -> images.

Two entry points:
- ``run_case``: a single, self-contained case (mesh + solve).
- ``solve_polar_marched``: one polar (fixed chord/speed, AoA sweep) that meshes
  once and *marches* the angle of attack, warm-starting each AoA from the
  previous converged field. ``prepare_mesh`` builds a mesh once for reuse.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import tarfile
import time
from dataclasses import dataclass, field
import math
from pathlib import Path
from typing import Callable, Optional

from . import physics
from .airfoil import Airfoil
from .cache import EngineCache, SeedHit
from .case.builder import CaseBuilder
from .cancellation import JobCancelled
from .meshing.base import Mesher, MeshResult, get_mesher
from .models import (
    FRAME_IMAGE_ARTIFACT_KIND,
    CaseSpec,
    EvidenceArtifact,
    FluidProperties,
    FrameChannelStats,
    FrameSample,
    FrameTrack,
    FrameTrackStats,
    FrameTrackWindow,
    JobPhase,
    MeshParams,
    RoughnessParams,
    SolverParams,
    SteadyHistory,
    SteadyHistoryWindow,
    apply_urans_fidelity,
    effective_mesh_params,
    urans_budget_seconds,
    urans_point_fidelity,
)
from .openfoam.runner import OpenFOAMError, RunResult, Runner
from .postprocess.forces import (
    AveragedCoefficients,
    analyze_steady_oscillation,
    force_is_steady,
    parse_force_coefficients,
    parse_y_plus,
    time_averaged_coefficients,
)
from .postprocess.images import (
    find_all_vtus,
    render_animations,
    render_contours,
    render_frame_track_images,
    render_mean_contours,
    select_vtus,
)
from .postprocess.residuals import parse_convergence
from .postprocess.unsteady import (
    ChannelWindowStats,
    ForceHistory,
    PeriodWindowStats,
    StablePeriodResult,
    coefficient_series,
    discard_startup,
    force_history as compute_force_history,
    frame_coefficients,
    frame_target_times,
    is_no_shedding,
    measure_period,
    period_window_stats,
    stable_two_period_window,
)

CancelCheck = Optional[Callable[[], None]]

logger = logging.getLogger(__name__)

#: A fresh steady case may seed its initial fields from a previously solved
#: angle at the same mesh/fluid/speed when the donor is within this many degrees.
SEED_MAX_ANGLE_DELTA_DEG = 2.0


def _check_cancel(cancel_check: CancelCheck) -> None:
    if cancel_check is not None:
        cancel_check()


@dataclass
class CaseOutcome:
    spec: CaseSpec
    reynolds: float
    cl: Optional[float] = None
    cd: Optional[float] = None
    cm: Optional[float] = None
    cl_cd: Optional[float] = None
    cl_std: Optional[float] = None
    cd_std: Optional[float] = None
    cm_std: Optional[float] = None
    unsteady: bool = False
    converged: bool = False
    iterations: Optional[int] = None
    final_residual: Optional[float] = None
    y_plus_avg: Optional[float] = None
    y_plus_max: Optional[float] = None
    n_cells: int = 0
    first_order_fallback: bool = False
    images: dict[str, str] = field(default_factory=dict)  # field -> path relative to case dir
    strouhal: Optional[float] = None
    video: dict[str, str] = field(default_factory=dict)  # field -> mp4 path relative to case dir
    mean_images: dict[str, str] = field(default_factory=dict)  # field -> mean png path
    evidence_artifacts: list[EvidenceArtifact] = field(default_factory=list)
    force_history: Optional[ForceHistory] = None
    frame_track: Optional[FrameTrack] = None
    #: Solve tier that produced the reported values (contract echo):
    #: "rans" | "urans_precalc" | "urans_full".
    fidelity: str = "rans"
    #: Steady-solve coefficient history (steady_history contract): shipped for
    #: oscillating-averaged acceptances AND for non-stabilising steady solves;
    #: None for classic pointwise convergence.
    steady_history: Optional[SteadyHistory] = None
    quality_warnings: list[str] = field(default_factory=list)
    error: Optional[str] = None


@dataclass
class StoredCaseOutcome:
    """A solver outcome plus the case slug used to serve its media files."""

    slug: str
    outcome: CaseOutcome


@dataclass
class PolarMarchResult:
    """Final polar points plus rejected/intermediate attempts captured as evidence."""

    points: list[StoredCaseOutcome] = field(default_factory=list)
    attempts: list[StoredCaseOutcome] = field(default_factory=list)
    promoted_to_urans: bool = False
    abort_reason: Optional[str] = None


def _time_of(coeff_path) -> float:
    try:
        return float(coeff_path.parent.name)
    except ValueError:
        return -1.0


def _coeff_files(case_dir: Path) -> list:
    return sorted(
        case_dir.glob("postProcessing/forceCoeffs1/*/coefficient.dat"), key=_time_of
    )


def _transient_coeff_selection(case_dir: Path, since: Optional[float]) -> list:
    """The coefficient.dat segments belonging to the transient itself.

    A restart writes each continuation segment into its own
    ``forceCoeffs1/<startTime>`` directory; the steady-initialisation history
    (pseudo-time iteration counts, written before ``since``) must never be
    merged into the transient force signal."""
    files = _coeff_files(case_dir)
    if not files:
        return []
    if since is None:
        return [files[-1]]
    return [f for f in files if _time_of(f) >= since - 1e-9] or [files[-1]]


def _coeff_last_time(coeff_path: Path) -> Optional[float]:
    """Last simulated time recorded in a forceCoeffs coefficient.dat (None if empty)."""
    try:
        last: Optional[str] = None
        with coeff_path.open() as fh:
            for line in fh:
                stripped = line.strip()
                if not stripped or stripped.startswith("#"):
                    continue
                last = stripped
        return float(last.split()[0]) if last else None
    except (OSError, ValueError, IndexError):
        return None


_LOG_DELTA_T_RE = re.compile(r"deltaT = ([0-9+\-.eE]+)")


def _last_log_delta_t(log_text: str) -> Optional[float]:
    """Last adaptive 'deltaT = ...' the solver reported (None if it never did)."""
    value: Optional[float] = None
    for match in _LOG_DELTA_T_RE.finditer(log_text):
        try:
            value = float(match.group(1))
        except ValueError:
            continue
    return value


def _transient_timeout_message(
    timeout_s: float, reached_t: Optional[float], end_t: float, delta_t: Optional[float]
) -> str:
    """Truthful description of a URANS solver-timeout failure (never blames a
    'missing' coefficient.dat for a run that simply ran out of wall-clock budget)."""
    reached = f"{reached_t:.6g}" if reached_t is not None else "unknown"
    dt = f"{delta_t:.3g}" if delta_t is not None else "unknown"
    return (
        f"URANS transient timed out after {timeout_s:g}s at t={reached} of {end_t:.6g}s "
        f"(dt collapsed to {dt})"
    )


#: Marker dropped into a case directory by the heartbeat-thread divergence
#: watchdog (tasks.py) when it kills a diverging solver. The pipeline turns it
#: into a truthful OpenFOAMError so the case flows the EXISTING failed/timeout
#: grading path (attempt evidence retained, honest error) — never the stall
#: detector's whole-job kill, and never a graded window of garbage.
DIVERGENCE_MARKER_FILENAME = "divergence_condemned.json"


def write_divergence_condemnation(case_dir: Path, reason: str) -> None:
    """Persist the watchdog's truthful condemnation for the solving pipeline."""
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / DIVERGENCE_MARKER_FILENAME).write_text(
        json.dumps({"reason": reason, "condemned_at": time.time()}, indent=2) + "\n"
    )


def read_divergence_condemnation(case_dir: Path) -> Optional[str]:
    """The watchdog's condemnation reason for this case, or None."""
    marker = case_dir / DIVERGENCE_MARKER_FILENAME
    try:
        payload = json.loads(marker.read_text())
    except (OSError, ValueError):
        return None
    reason = payload.get("reason") if isinstance(payload, dict) else None
    return str(reason) if reason else None


def clear_divergence_condemnation(case_dir: Path) -> None:
    """Drop a stale marker before a FRESH solver attempt (each attempt earns
    its own verdict; a condemned steady init must not poison the URANS pass,
    and a condemned 2nd-order steady solve must not poison the upwind retry)."""
    try:
        (case_dir / DIVERGENCE_MARKER_FILENAME).unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _raise_if_condemned(case_dir: Path) -> None:
    reason = read_divergence_condemnation(case_dir)
    if reason:
        raise OpenFOAMError(reason)


def _latest_time_dir(case_dir: Path):
    best, best_v = None, -1.0
    for d in case_dir.iterdir():
        if not d.is_dir():
            continue
        try:
            v = float(d.name)
        except ValueError:
            continue
        if v > best_v:
            best, best_v = d, v
    return best


def _latest_time(case_dir: Path) -> float:
    d = _latest_time_dir(case_dir)
    return float(d.name) if d is not None else 0.0


def resolve_mesh_params(
    mesh_params: MeshParams, spec: CaseSpec, fluid: FluidProperties
) -> MeshParams:
    """Fill in the first-cell height from the target y+ if not given explicitly."""
    if mesh_params.first_cell_height_chords is not None:
        return mesh_params
    height_m = physics.first_cell_height_for_yplus(
        mesh_params.target_y_plus, spec.speed, spec.chord, fluid.nu
    )
    height_chords = height_m / spec.chord
    return mesh_params.model_copy(update={"first_cell_height_chords": height_chords})


TRANSIENT_WALL_YPLUS = 40.0  # wall-function y+ for the transient mesh (affordable timestep)
TRANSIENT_INIT_ITERS = 600  # short steady init before the transient
TRANSIENT_INITIAL_STROUHAL = 0.5
URANS_REFINED_CADENCE_STROUHAL = 0.75
URANS_MIN_RETAINED_CYCLES = 7.0
#: Early-stop retention target. The two-period comparator only DETECTS a
#: repeatable limit cycle; once detected the run keeps integrating until this
#: many periods of certified-stable data exist (measured from the start of the
#: first stable window), so early-stopped points retain at least the node
#: acceptance gate (packages/core/src/polar-fit.ts FRAME_TRACK_MIN_PERIODS = 5,
#: pinned cross-runtime). Stopping at 2 stable periods shipped startup-biased
#: means and points the classifier then deterministically rejected.
URANS_STABLE_RETAINED_CYCLES = 5.0
#: Extra periods integrated past the retention target before the early stop
#: fires, so the downstream re-measured period (autocorrelation on the retained
#: tail) can never floor the whole-period count below the retention target.
URANS_STABLE_STOP_MARGIN_CYCLES = 0.5
URANS_MIN_FRAMES_PER_CYCLE = 20.0
URANS_ANIMATION_FRAMES = 141
URANS_MAX_ANIMATION_FRAMES = 220
URANS_EARLY_STOP_MARKER = "urans_early_stop.json"
#: Frame-export window pinned by the contract: last min(3, K) whole periods.
URANS_FRAME_SPAN_PERIODS = 3
#: Fraction of the per-attempt solver timeout the projected refined URANS pass
#: may consume; beyond this the refinement is skipped (it would deterministically
#: time out and burn hours of CPU) and the base window is graded honestly.
URANS_REFINE_BUDGET_FRACTION = 0.8
#: Fallback media wall-budget fraction of solver_timeout when the caller does
#: not pass an explicit budget (jobs.py passes Settings.media_budget_seconds()
#: — same default). Mirrors Settings.media_budget_fraction.
MEDIA_BUDGET_FRACTION_DEFAULT = 0.5


class MediaBudget:
    """Wall-clock budget for one case's post-solve media/frame stage.

    No timeout covered post-solve rendering before 2026-07-07 (the 7200 s
    guard is solver-subprocess-only), so an in-process render grind ran
    forever. On breach the media stage degrades LOUDLY per the existing
    media-loss machinery — the job completes with whatever rendered."""

    def __init__(self, seconds: float):
        self.seconds = max(0.0, float(seconds))
        self._t0 = time.monotonic()

    def elapsed(self) -> float:
        return time.monotonic() - self._t0

    def exceeded(self) -> bool:
        return self.elapsed() >= self.seconds

    def deadline(self) -> float:
        """The ``time.monotonic`` instant the budget runs out (for renderers)."""
        return self._t0 + self.seconds


@dataclass
class UransQuality:
    ok: bool
    can_refine: bool
    reason: str
    measured_period_s: Optional[float] = None
    retained_cycles: float = 0.0
    retained_frame_count: int = 0
    frames_per_cycle: float = 0.0
    retained_start_time: Optional[float] = None
    retained_end_time: Optional[float] = None
    # True when the transient is physically steady (no vortex shedding); its
    # time-averaged coefficients are the valid answer and no refine is possible.
    no_shedding: bool = False


@dataclass
class RefinedTransientTiming:
    measured_period_s: float
    run_time_s: float
    delta_t: float
    write_interval: float
    max_delta_t: float


@dataclass
class TransientResult:
    avg: "object"  # AveragedCoefficients
    case_dir: Path  # the (coarse-wall) transient case, for y+/image post-processing
    force_history: Optional[ForceHistory]
    quality: UransQuality
    start_time: float
    end_time: float
    run_time: float
    refined: bool = False
    early_stopped: bool = False
    #: Measured wall-clock seconds spent inside the transient solver run; used
    #: to project whether a refined pass can fit the solver timeout budget.
    wall_seconds: float = 0.0
    #: coefficient.dat segments of THIS transient (steady-init history
    #: excluded), merged for grading and for the frame_track stats.
    coeff_paths: list[Path] = field(default_factory=list)


def _numeric_time_dirs(case_dir: Path) -> list[float]:
    times: list[float] = []
    for d in case_dir.iterdir():
        if not d.is_dir():
            continue
        try:
            times.append(float(d.name))
        except ValueError:
            continue
    return sorted(times)


def _field_frame_count(case_dir: Path, start_time: float, end_time: float) -> int:
    return sum(1 for t in _numeric_time_dirs(case_dir) if start_time <= t <= end_time)


def _foam_value(value: object) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return value
    if isinstance(value, float):
        return f"{value:.12g}"
    return str(value)


def _set_control_dict_entries(control_dict: Path, entries: dict[str, object]) -> None:
    if not control_dict.exists():
        return
    text = control_dict.read_text()
    for key, value in entries.items():
        value_text = _foam_value(value)
        pattern = re.compile(rf"(^\s*{re.escape(key)}\s+)([^;]*)(;)", re.MULTILINE)
        replacement = rf"\g<1>{value_text}\3"
        if pattern.search(text):
            text = pattern.sub(replacement, text, count=1)
        else:
            text += f"\n{key:<16} {value_text};\n"
    control_dict.write_text(text)


def _read_early_stop_marker(case_dir: Path) -> dict[str, object] | None:
    path = case_dir / URANS_EARLY_STOP_MARKER
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return None
    return data if isinstance(data, dict) else None


def _early_stop_retained_series(tcase: Path, t, cl, cd, cm):
    """Certified-stable tail of an early-stopped run's coefficient series.

    Early-stopped runs must NOT use a fraction-based startup discard (their
    span is short, a fraction either over- or under-cuts) and must NOT use the
    raw full span (the startup transient biases the time-weighted means and
    trips the stationarity drift check). The early-stop marker records
    ``retain_from`` — the start of the certified-stable region — so the stats
    window is exactly the data the two-period comparator certified. Falls back
    to the last retention-target periods via the marker period, then to the
    full series (graded honestly downstream) when no marker data exists.
    """
    marker = _read_early_stop_marker(tcase) or {}
    retain_from = marker.get("retain_from")
    if not isinstance(retain_from, (int, float)) or not math.isfinite(float(retain_from)):
        retain_from = None
        period = marker.get("period_s")
        if (
            isinstance(period, (int, float))
            and math.isfinite(float(period))
            and float(period) > 0
            and len(t)
        ):
            retain_from = float(t[-1]) - (
                URANS_STABLE_RETAINED_CYCLES + URANS_STABLE_STOP_MARGIN_CYCLES
            ) * float(period)
    if retain_from is None:
        return t, cl, cd, cm
    mask = t >= float(retain_from)
    if int(mask.sum()) < 4:
        return t, cl, cd, cm
    return t[mask], cl[mask], cd[mask], cm[mask]


def _write_early_stop_marker(
    case_dir: Path, result: StablePeriodResult, retain_from: float | None = None
) -> None:
    (case_dir / URANS_EARLY_STOP_MARKER).write_text(
        json.dumps(
            {
                # Start of the certified-stable region: downstream frame-track
                # stats retain ONLY t >= retain_from (startup excluded).
                "retain_from": retain_from,
                "reason": result.reason,
                "period_s": result.period_s,
                "window_start": result.window_start,
                "window_end": result.window_end,
                "cycles": result.cycles,
                "frame_count": result.frame_count,
                "frames_per_cycle": result.frames_per_cycle,
                "similarity": result.similarity,
                "mean_drift": result.mean_drift,
            },
            indent=2,
            sort_keys=True,
        )
        + "\n"
    )


def _make_urans_monitor(
    tcase: Path, spec: CaseSpec, coeff_start_time: Optional[float] = None
) -> Callable[[], None]:
    state: dict[str, object] = {"cadence_period": None, "target_period": None, "stop_requested": False}

    def monitor() -> None:
        coeff_files = _transient_coeff_selection(tcase, coeff_start_time)
        if not coeff_files:
            return
        result = stable_two_period_window(
            coeff_files,
            speed=spec.speed,
            chord=spec.chord,
            frame_times=_numeric_time_dirs(tcase),
            discard_fraction=0.0,
            min_frames_per_cycle=URANS_MIN_FRAMES_PER_CYCLE,
        )
        period = result.period_s
        if period is not None and period > 0 and math.isfinite(period):
            previous = state.get("cadence_period")
            if previous is None or abs(float(previous) - period) / max(period, 1e-12) > 0.15:
                write_interval = period / URANS_MIN_FRAMES_PER_CYCLE
                _set_control_dict_entries(
                    tcase / "system" / "controlDict",
                    {
                        "writeInterval": write_interval,
                        "maxDeltaT": write_interval,
                        "runTimeModifiable": True,
                    },
                )
                state["cadence_period"] = period
        if result.stable and period is not None and period > 0:
            # Certification clock: retention is measured from the START of the
            # first stable two-period window, and the stop only fires once
            # URANS_STABLE_RETAINED_CYCLES (+ margin) periods of certified-
            # stable data exist — never at bare detection, which retained ~2
            # startup-adjacent periods and was rejected by the node gate.
            stable_since = state.get("stable_since")
            if stable_since is None and result.window_start is not None:
                stable_since = float(result.window_start)
                state["stable_since"] = stable_since
            if stable_since is not None:
                required_end = float(stable_since) + (
                    URANS_STABLE_RETAINED_CYCLES + URANS_STABLE_STOP_MARGIN_CYCLES
                ) * period
                latest = _latest_time(tcase)
                if result.ok and latest + 1e-9 >= required_end and not state.get("stop_requested"):
                    _write_early_stop_marker(tcase, result, retain_from=float(stable_since))
                    _set_control_dict_entries(
                        tcase / "system" / "controlDict",
                        {"stopAt": "writeNow", "runTimeModifiable": True},
                    )
                    state["stop_requested"] = True
                else:
                    target_period = state.get("target_period")
                    if target_period is None or abs(float(target_period) - period) / max(period, 1e-12) > 0.15:
                        _set_control_dict_entries(
                            tcase / "system" / "controlDict",
                            {
                                "endTime": max(required_end, latest + period),
                                "runTimeModifiable": True,
                            },
                        )
                        state["target_period"] = period
        else:
            # Stability lost (or never established): restart the certification
            # clock so a transient wobble cannot count toward retention.
            state["stable_since"] = None

    return monitor


def evaluate_urans_quality(
    case_dir: Path,
    history: Optional[ForceHistory],
    speed: float,
    chord: float,
    min_cycles: float = URANS_MIN_RETAINED_CYCLES,
    min_frames_per_cycle: float = URANS_MIN_FRAMES_PER_CYCLE,
) -> UransQuality:
    # No-shedding first: a symmetric airfoil at alpha~0 (or any weakly-loaded
    # point) escalated to URANS runs a physically steady transient. Its force
    # history exists and its time-average IS the physical answer, so accept the
    # steady-equivalent mean and never auto-refine (auto-refining a non-shedding
    # case is pointless and copies a degenerate retained window). This must be
    # decided from the fluctuation amplitude, not from the presence of a
    # (possibly spurious) FFT peak on numerical noise.
    if history is not None and len(history.t) >= 2 and is_no_shedding(history):
        retained_start = float(history.t[0])
        retained_end = float(history.t[-1])
        return UransQuality(
            ok=True,
            can_refine=False,
            no_shedding=True,
            reason=(
                "URANS steady (no vortex shedding): time-averaged coefficients "
                "are the physical answer."
            ),
            measured_period_s=None,
            retained_cycles=0.0,
            retained_frame_count=_field_frame_count(case_dir, retained_start, retained_end),
            frames_per_cycle=0.0,
            retained_start_time=retained_start,
            retained_end_time=retained_end,
        )
    if history is None or history.strouhal <= 0 or speed <= 0 or chord <= 0 or len(history.t) < 2:
        return UransQuality(
            ok=False,
            can_refine=False,
            reason="URANS quality could not be measured: missing or flat shedding history.",
        )
    measured_period = chord / (history.strouhal * speed)
    retained_start = float(history.t[0])
    retained_end = float(history.t[-1])
    retained_span = max(0.0, retained_end - retained_start)
    retained_cycles = retained_span / measured_period if measured_period > 0 else 0.0
    frame_count = _field_frame_count(case_dir, retained_start, retained_end)
    frames_per_cycle = frame_count / retained_cycles if retained_cycles > 0 else 0.0
    eps = 1e-9
    too_short = retained_cycles + eps < min_cycles
    too_sparse = frames_per_cycle + eps < min_frames_per_cycle
    if not too_short and not too_sparse:
        return UransQuality(
            ok=True,
            can_refine=False,
            reason="URANS quality target met.",
            measured_period_s=measured_period,
            retained_cycles=retained_cycles,
            retained_frame_count=frame_count,
            frames_per_cycle=frames_per_cycle,
            retained_start_time=retained_start,
            retained_end_time=retained_end,
        )
    parts = []
    if too_short:
        parts.append(f"retained cycles {retained_cycles:.2f} < {min_cycles:.2f}")
    if too_sparse:
        parts.append(f"frames/cycle {frames_per_cycle:.2f} < {min_frames_per_cycle:.2f}")
    return UransQuality(
        ok=False,
        can_refine=True,
        reason="; ".join(parts),
        measured_period_s=measured_period,
        retained_cycles=retained_cycles,
        retained_frame_count=frame_count,
        frames_per_cycle=frames_per_cycle,
        retained_start_time=retained_start,
        retained_end_time=retained_end,
    )


def refined_transient_timing(
    measured_period_s: float,
    original_run_time_s: float,
    original_delta_t: float,
    discard_fraction: float,
    cadence_period_s: float | None = None,
    min_cycles: float = URANS_MIN_RETAINED_CYCLES,
    min_frames_per_cycle: float = URANS_MIN_FRAMES_PER_CYCLE,
) -> RefinedTransientTiming:
    retained_cycles = max(1, math.ceil(min_cycles))
    retained_fraction = max(1e-6, 1.0 - discard_fraction)
    write_interval = measured_period_s / min_frames_per_cycle
    min_total_cycles = retained_cycles / retained_fraction
    original_cycles = original_run_time_s / measured_period_s
    requested_total_cycles = max(original_cycles, min_total_cycles)
    # Align endTime to the field-write cadence so the final retained window has
    # exactly N whole periods with start/end on saved phases.
    write_steps = max(1, math.ceil(requested_total_cycles * min_frames_per_cycle - 1e-9))
    run_time = (write_steps / min_frames_per_cycle) * measured_period_s
    delta_t = min(original_delta_t, measured_period_s / 5000.0)
    max_delta_t = min(write_interval, run_time / 50.0)
    return RefinedTransientTiming(
        measured_period_s=measured_period_s,
        run_time_s=run_time,
        delta_t=delta_t,
        write_interval=write_interval,
        max_delta_t=max_delta_t,
    )


def _copy_initialized_transient_case(src: Path, dst: Path, start_time: float) -> None:
    if dst.exists():
        shutil.rmtree(dst)
    dst.mkdir(parents=True, exist_ok=True)
    for name in ("0", "constant", "system"):
        src_path = src / name
        if src_path.exists():
            shutil.copytree(src_path, dst / name, symlinks=True)
    start_dir = None
    for d in src.iterdir():
        if not d.is_dir():
            continue
        try:
            if abs(float(d.name) - start_time) < 1e-9:
                start_dir = d
                break
        except ValueError:
            continue
    # start_time == 0.0 resolves to the "0" directory already copied above
    # (seen in production: symmetric airfoil at alpha=0 -> no shedding ->
    # auto-refine with a degenerate retained window -> FileExistsError).
    if start_dir is not None and not (dst / start_dir.name).exists():
        shutil.copytree(start_dir, dst / start_dir.name, symlinks=True)


def _seed_transient_from_steady(steady_time_dir: Path, tcase: Path) -> bool:
    """Warm-start a transient case from the in-job steady RANS field: replace the
    CaseBuilder's uniform ``0/`` fields with the developed steady fields. Only
    valid when both cases share the same mesh (shared job mesh). Returns False
    (leaving the case pristine for the potentialFoam path) if the essential
    fields are missing."""
    field_names = [f.name for f in steady_time_dir.iterdir() if f.is_file()]
    if "U" not in field_names or "p" not in field_names:
        return False
    zero = tcase / "0"
    zero.mkdir(parents=True, exist_ok=True)
    for name in field_names:
        shutil.copy2(steady_time_dir / name, zero / name)
    return True


def _prepare_transient_case(
    tcase: Path,
    airfoil,
    resolved,
    spec,
    fluid,
    roughness,
    solver_params,
    runner,
    n_proc,
    timeout,
    shared_mesh_dir: Optional[Path] = None,
    steady_field_dir: Optional[Path] = None,
    cancel_check: CancelCheck = None,
) -> tuple[MeshParams, object]:
    _check_cancel(cancel_check)
    if tcase.exists():
        shutil.rmtree(tcase)
    tcase.mkdir(parents=True, exist_ok=True)
    mesher = get_mesher(resolved.mesher)

    if shared_mesh_dir is not None:
        tmesh = resolved
    else:
        # Fallback for standalone single cases without a shared job mesh.
        h = physics.first_cell_height_for_yplus(TRANSIENT_WALL_YPLUS, spec.speed, spec.chord, fluid.nu)
        tmesh = resolved.model_copy(
            update={
                "first_cell_height_chords": h / spec.chord,
                "n_surface": min(resolved.n_surface, 90),
                "n_radial": min(resolved.n_radial, 56),
                "n_wake": min(resolved.n_wake, 50),
                "farfield_radius_chords": min(resolved.farfield_radius_chords, 12.0),
                "wake_length_chords": min(resolved.wake_length_chords, 10.0),
            }
        )
    patches = mesher.patches(tmesh)

    # A short steady initialisation gives the transient a developed,
    # already-separated field to continue from.
    init_solver = solver_params.model_copy(
        update={"n_iterations": min(solver_params.n_iterations, TRANSIENT_INIT_ITERS)}
    )
    CaseBuilder(airfoil, patches, tmesh, spec, fluid, roughness, init_solver, n_proc=n_proc).write(tcase)
    if shared_mesh_dir is None:
        mesher.write_inputs(tcase, airfoil, tmesh, spec.chord)
        mesher.run_mesh(tcase, tmesh, runner)
    else:
        _link_mesh(tcase, shared_mesh_dir, runner)
    _check_cancel(cancel_check)
    # Preferred warm start: continue from the in-job steady RANS field solved on
    # the SAME shared mesh (URANS-only jobs run that stage first). A developed
    # steady field is a vastly better initial condition than a uniform-flow cold
    # start — prod evidence: cambered clarky at alpha=4 cold-started URANS,
    # Courant control collapsed dt to ~1e-6 s and the run timed out at t=0.010
    # of 0.333 s.
    if (
        steady_field_dir is not None
        and shared_mesh_dir is not None
        and steady_field_dir.is_dir()
        and _seed_transient_from_steady(steady_field_dir, tcase)
    ):
        logger.info("transient %s warm-started from steady field %s", tcase, steady_field_dir)
        return tmesh, patches
    runner.application(tcase, "potentialFoam -writephi -initialiseUBCs", timeout=600)
    _check_cancel(cancel_check)
    # Unconditional steady (RANS) initialisation stage, for the URANS-only path
    # too: even a short, non-converged SIMPLE field gives the transient a
    # developed, already-separated start instead of violent uniform flow.
    init = runner.solver(tcase, "simpleFoam", n_proc, timeout=timeout)
    _check_cancel(cancel_check)
    (tcase / "log.simpleFoam.init").write_text(init.stdout)
    # The steady initialisation is only a convenience seed for pimpleFoam. When
    # the whole polar has already been promoted because RANS is fragile, failing
    # here with the same SIMPLE problem should not prevent the transient attempt.
    return tmesh, patches


def _run_transient_attempt(
    tcase: Path,
    airfoil,
    tmesh,
    patches,
    spec,
    fluid,
    roughness,
    solver_params,
    runner,
    n_proc,
    timeout,
    run_time: float,
    delta_t: float,
    write_interval: float | None = None,
    max_delta_t: float | None = None,
    refined: bool = False,
    coeff_start_time: float | None = None,
    cancel_check: CancelCheck = None,
) -> Optional[TransientResult]:
    _check_cancel(cancel_check)
    # Fresh attempt = fresh verdict: a marker left by a condemned earlier stage
    # (e.g. the steady init) must not poison this pimpleFoam pass.
    clear_divergence_condemnation(tcase)
    start_t = _latest_time(tcase)
    end_t = start_t + run_time
    CaseBuilder(airfoil, patches, tmesh, spec, fluid, roughness, solver_params, n_proc=n_proc).write_transient(
        tcase,
        start_t,
        end_t,
        delta_t,
        write_interval=write_interval,
        max_delta_t=max_delta_t,
    )
    solve_started = time.monotonic()
    res = runner.solver(
        tcase,
        "pimpleFoam",
        n_proc,
        timeout=timeout,
        restart=True,
        monitor=_make_urans_monitor(tcase, spec, coeff_start_time),
    )
    wall_seconds = max(0.0, time.monotonic() - solve_started)
    _check_cancel(cancel_check)
    (tcase / "log.pimpleFoam").write_text(res.stdout)
    # Divergence watchdog condemnation: the heartbeat thread killed a solver
    # whose coefficients blew past the sanity bound (or whose dt collapsed
    # persistently). The partial window is GARBAGE — never grade it like a
    # timeout; fail the case with the watchdog's truthful message instead.
    _raise_if_condemned(tcase)
    # A solver TIMEOUT is not a crash: the run may have written a gradable
    # partial coefficient window. Only a genuine solver failure aborts here.
    timed_out = bool(getattr(res, "timed_out", False)) or (
        not res.ok and getattr(res, "returncode", None) == 124
    )
    if not res.ok and not timed_out:
        return None
    if n_proc > 1:
        recon_ok = runner.application(tcase, "reconstructPar -newTimes", timeout=timeout).ok
        if not recon_ok and not timed_out:
            return None
        _check_cancel(cancel_check)

    def _timeout_error() -> OpenFOAMError:
        files_now = _coeff_files(tcase)
        reached = _coeff_last_time(files_now[-1]) if files_now else None
        if reached is None:
            reached = _latest_time(tcase) or None
        return OpenFOAMError(
            _transient_timeout_message(timeout, reached, end_t, _last_log_delta_t(res.stdout))
        )

    files = _coeff_files(tcase)
    if not files:
        if timed_out:
            # Truthful failure: the transient ran out of wall-clock budget and
            # left nothing gradable — never "produced no coefficient.dat".
            raise _timeout_error()
        return None
    coeff_paths = _transient_coeff_selection(tcase, coeff_start_time)
    early_stop = _read_early_stop_marker(tcase)
    history: Optional[ForceHistory] = None
    history_discard = 0.0 if early_stop else solver_params.transient_discard_fraction
    target_cycles = (
        int(URANS_STABLE_RETAINED_CYCLES) if early_stop else int(solver_params.urans_min_periods)
    )
    try:
        history = compute_force_history(
            coeff_paths,
            spec.speed,
            spec.chord,
            history_discard,
            target_cycles=target_cycles,
        )
    except Exception:  # noqa: BLE001 - quality/history is non-fatal
        history = None
    try:
        if history is not None:
            avg = AveragedCoefficients(
                cl=history.cl_mean,
                cd=history.cd_mean,
                cm=history.cm_mean,
                cl_std=history.cl_rms,
                cd_std=history.cd_rms,
                cm_std=history.cm_rms,
                samples=history.samples,
            )
        else:
            avg = time_averaged_coefficients(coeff_paths[-1], solver_params.transient_discard_fraction)
    except Exception:  # noqa: BLE001 - no usable force rows
        if timed_out:
            raise _timeout_error() from None
        return None
    quality = evaluate_urans_quality(
        tcase,
        history,
        spec.speed,
        spec.chord,
        min_cycles=URANS_STABLE_RETAINED_CYCLES if early_stop else float(solver_params.urans_min_periods),
    )
    if early_stop and quality.ok:
        quality = UransQuality(
            ok=True,
            can_refine=False,
            reason=f"URANS early-stop target met: {early_stop.get('reason', 'two stable periods')}",
            measured_period_s=quality.measured_period_s,
            retained_cycles=quality.retained_cycles,
            retained_frame_count=quality.retained_frame_count,
            frames_per_cycle=quality.frames_per_cycle,
            retained_start_time=quality.retained_start_time,
            retained_end_time=quality.retained_end_time,
        )
    if timed_out:
        # Honest partial grade: the requested span was NOT simulated, so the
        # point can never claim full quality, and refining a run that already
        # exhausted its wall-clock budget would deterministically time out too.
        reached = _coeff_last_time(files[-1])
        if reached is None:
            reached = _latest_time(tcase)
        quality = UransQuality(
            ok=False,
            can_refine=False,
            reason=(
                f"{'refined' if refined else 'base'} transient timed out at t={reached:.6g}s "
                f"of {end_t:.6g}s (solver timeout {timeout:g}s); graded partial window; "
                f"{quality.reason}"
            ),
            measured_period_s=quality.measured_period_s,
            retained_cycles=quality.retained_cycles,
            retained_frame_count=quality.retained_frame_count,
            frames_per_cycle=quality.frames_per_cycle,
            retained_start_time=quality.retained_start_time,
            retained_end_time=quality.retained_end_time,
            no_shedding=quality.no_shedding,
        )
    return TransientResult(
        avg=avg,
        case_dir=tcase,
        force_history=history,
        quality=quality,
        start_time=start_t,
        end_time=end_t,
        run_time=run_time,
        refined=refined,
        early_stopped=bool(early_stop),
        wall_seconds=wall_seconds,
        coeff_paths=list(coeff_paths),
    )


#: Safety cap on URANS continuation chunks: the period estimate normally
#: converges within a couple of extensions; a drifting estimate must not loop
#: the solver forever.
URANS_CONTINUATION_MAX_CHUNKS = 6


def _quality_with(quality: UransQuality, **updates) -> UransQuality:
    """Copy a UransQuality with the given fields replaced (measurements kept)."""
    base = dict(
        ok=quality.ok,
        can_refine=quality.can_refine,
        reason=quality.reason,
        measured_period_s=quality.measured_period_s,
        retained_cycles=quality.retained_cycles,
        retained_frame_count=quality.retained_frame_count,
        frames_per_cycle=quality.frames_per_cycle,
        retained_start_time=quality.retained_start_time,
        retained_end_time=quality.retained_end_time,
        no_shedding=quality.no_shedding,
    )
    base.update(updates)
    return UransQuality(**base)


def _extend_transient_until_periods(
    tcase: Path,
    first: TransientResult,
    transient_start: float,
    airfoil,
    tmesh,
    patches,
    spec,
    fluid,
    roughness,
    solver_params,
    runner,
    n_proc,
    timeout,
    initial_delta_t: float,
    cancel_check: CancelCheck = None,
) -> TransientResult:
    """Integrate until ``urans_min_periods`` WHOLE shedding periods are retained
    after startup discard, extending the SAME transient case in continuation
    chunks (the existing restart mechanics: ``write_transient`` from latestTime
    + solver restart — no second continuation path). The period is tracked on
    the fly from the Cl signal by autocorrelation (``measure_period``).

    Stops early — grading honestly — when the wall-clock budget guard projects
    (from the measured solve rate) that the next chunk cannot fit the solver
    timeout budget: quality then carries "retained M.x of N periods (budget)".
    The no-shedding early exit and the two-stable-period early stop are
    respected untouched (they break the loop immediately).
    """
    target = float(solver_params.urans_min_periods)
    discard = min(max(solver_params.transient_discard_fraction, 0.0), 0.95)
    result = first
    total_wall = max(0.0, first.wall_seconds)
    end_time = first.end_time
    chunks = 0
    while chunks < URANS_CONTINUATION_MAX_CHUNKS:
        history = result.force_history
        if (
            result.early_stopped
            or result.quality.no_shedding
            or not result.quality.can_refine
            or history is None
            or len(history.t) < 8
        ):
            break
        period = measure_period(history.t, history.cl)
        if period is None:
            period = history.period_s or result.quality.measured_period_s
        if period is None or not math.isfinite(period) or period <= 0:
            break
        span = max(0.0, _latest_time(tcase) - transient_start)
        if span <= 0.0:
            break
        retained = span * (1.0 - discard) / period
        if retained + 1e-6 >= target:
            break
        chunk_sim = (target - retained) * period / max(1e-6, 1.0 - discard)
        if timeout and total_wall > 0.0:
            rate = span / total_wall  # simulated seconds per wall second
            projected_wall_s = chunk_sim / rate if rate > 0.0 else math.inf
            if total_wall + projected_wall_s > URANS_REFINE_BUDGET_FRACTION * timeout:
                reason = (
                    f"URANS integration stopped by the wall-clock budget guard: "
                    f"retained {retained:.1f} of {target:g} periods (budget); "
                    f"projected {projected_wall_s / 3600.0:.1f}h continuation exceeds "
                    f"{URANS_REFINE_BUDGET_FRACTION:.0%} of the {timeout / 3600.0:.1f}h "
                    f"solver timeout; {result.quality.reason}"
                )
                logger.warning(reason)
                result.quality = _quality_with(
                    result.quality,
                    ok=False,
                    can_refine=False,
                    reason=reason,
                    measured_period_s=result.quality.measured_period_s or period,
                )
                break
        write_interval = period / URANS_MIN_FRAMES_PER_CYCLE
        try:
            nxt = _run_transient_attempt(
                tcase, airfoil, tmesh, patches, spec, fluid, roughness, solver_params,
                runner, n_proc, timeout,
                run_time=chunk_sim,
                delta_t=min(initial_delta_t, period / 5000.0),
                write_interval=write_interval,
                max_delta_t=write_interval,
                coeff_start_time=transient_start,
                cancel_check=cancel_check,
            )
        except OpenFOAMError as exc:
            # A chunk that timed out without gradable data must not discard the
            # already-graded window; the point keeps its honest partial grade.
            result.quality = _quality_with(
                result.quality,
                ok=False,
                can_refine=False,
                reason=(
                    f"URANS continuation chunk failed after retaining {retained:.1f} of "
                    f"{target:g} periods: {exc}; {result.quality.reason}"
                ),
            )
            break
        if nxt is None:
            result.quality = _quality_with(
                result.quality,
                ok=False,
                can_refine=False,
                reason=(
                    f"URANS continuation chunk crashed after retaining {retained:.1f} of "
                    f"{target:g} periods; {result.quality.reason}"
                ),
            )
            break
        chunks += 1
        total_wall += max(0.0, nxt.wall_seconds)
        end_time = nxt.end_time
        result = nxt
    if chunks > 0:
        # The returned result grades the WHOLE merged transient window.
        result.start_time = transient_start
        result.end_time = end_time
        result.run_time = max(0.0, end_time - transient_start)
        result.wall_seconds = total_wall
    return result


def _run_transient(
    case_dir, airfoil, resolved, spec, fluid, roughness, solver_params, runner, n_proc, timeout,
    subdir="transient", shared_mesh_dir: Optional[Path] = None,
    steady_field_dir: Optional[Path] = None, cancel_check: CancelCheck = None,
):
    """Run URANS, extend it until enough whole periods are retained, then
    automatically refine sparse/short transient media once."""
    tcase = case_dir / subdir
    try:
        tmesh, patches = _prepare_transient_case(
            tcase, airfoil, resolved, spec, fluid, roughness, solver_params, runner, n_proc, timeout,
            shared_mesh_dir=shared_mesh_dir,
            steady_field_dir=steady_field_dir,
            cancel_check=cancel_check,
        )
    except OpenFOAMError:
        return None

    initial_period = physics.shedding_period(spec.speed, spec.chord, strouhal=TRANSIENT_INITIAL_STROUHAL)
    initial_run_time = solver_params.transient_cycles * initial_period
    initial_delta_t = initial_period / 5000.0
    transient_start = _latest_time(tcase)
    first = _run_transient_attempt(
        tcase, airfoil, tmesh, patches, spec, fluid, roughness, solver_params, runner, n_proc, timeout,
        run_time=initial_run_time, delta_t=initial_delta_t,
        coeff_start_time=transient_start,
        cancel_check=cancel_check,
    )
    if first is None:
        return None
    first = _extend_transient_until_periods(
        tcase, first, transient_start, airfoil, tmesh, patches, spec, fluid, roughness,
        solver_params, runner, n_proc, timeout, initial_delta_t, cancel_check=cancel_check,
    )
    if (
        first.quality.ok
        or not solver_params.transient_auto_refine
        or not first.quality.can_refine
        or first.quality.measured_period_s is None
    ):
        if not first.quality.ok and not solver_params.transient_auto_refine:
            first.quality = UransQuality(
                ok=False,
                can_refine=False,
                reason=f"URANS auto-refinement skipped for batch sweep: {first.quality.reason}",
                measured_period_s=first.quality.measured_period_s,
                retained_cycles=first.quality.retained_cycles,
                retained_frame_count=first.quality.retained_frame_count,
                frames_per_cycle=first.quality.frames_per_cycle,
                retained_start_time=first.quality.retained_start_time,
                retained_end_time=first.quality.retained_end_time,
            )
        return first

    refined_timing = refined_transient_timing(
        first.quality.measured_period_s,
        original_run_time_s=first.run_time,
        original_delta_t=initial_delta_t,
        discard_fraction=solver_params.transient_discard_fraction,
        cadence_period_s=physics.shedding_period(
            spec.speed, spec.chord, strouhal=URANS_REFINED_CADENCE_STROUHAL
        ),
        min_cycles=float(solver_params.urans_min_periods),
    )
    # Feasibility guard: weak-shedding points can need a refined window whose
    # Courant-limited timestep makes the pass deterministically exceed the
    # solver timeout (seen in prod: ~6h projected vs a 2h budget, burning the
    # whole budget for nothing). Project the refined wall time from the
    # measured base-pass solve rate (simulated seconds per wall second); if it
    # cannot fit the same per-attempt timeout budget, skip the refinement and
    # grade the base window honestly instead.
    base_span = max(0.0, _latest_time(tcase) - first.start_time)
    if base_span <= 0.0:
        base_span = first.run_time
    if timeout and first.wall_seconds > 0.0 and base_span > 0.0:
        rate = base_span / first.wall_seconds  # simulated seconds per wall second
        projected_wall_s = refined_timing.run_time_s / rate if rate > 0.0 else math.inf
        if projected_wall_s > URANS_REFINE_BUDGET_FRACTION * timeout:
            reason = (
                f"URANS refinement skipped: projected {projected_wall_s / 3600.0:.1f}h wall time "
                f"exceeds {URANS_REFINE_BUDGET_FRACTION:.0%} of the {timeout / 3600.0:.1f}h solver "
                f"timeout budget; {first.quality.reason}"
            )
            logger.warning(
                "%s (base pass: %.3g simulated s in %.0f wall s; refined window: %.3g simulated s)",
                reason,
                base_span,
                first.wall_seconds,
                refined_timing.run_time_s,
            )
            first.quality = UransQuality(
                ok=False,
                can_refine=False,
                reason=reason,
                measured_period_s=first.quality.measured_period_s,
                retained_cycles=first.quality.retained_cycles,
                retained_frame_count=first.quality.retained_frame_count,
                frames_per_cycle=first.quality.frames_per_cycle,
                retained_start_time=first.quality.retained_start_time,
                retained_end_time=first.quality.retained_end_time,
            )
            return first

    refined_case = case_dir / f"{subdir}_refined"
    _copy_initialized_transient_case(tcase, refined_case, first.start_time)
    try:
        refined = _run_transient_attempt(
            refined_case,
            airfoil,
            tmesh,
            patches,
            spec,
            fluid,
            roughness,
            solver_params,
            runner,
            n_proc,
            timeout,
            run_time=refined_timing.run_time_s,
            delta_t=refined_timing.delta_t,
            write_interval=refined_timing.write_interval,
            max_delta_t=refined_timing.max_delta_t,
            refined=True,
            coeff_start_time=first.start_time,
            cancel_check=cancel_check,
        )
    except OpenFOAMError:
        # A refined pass that timed out without gradable data must not discard
        # the completed base pass — fall back to the base result below.
        refined = None
    if refined is None:
        first.quality = UransQuality(
            ok=False,
            can_refine=False,
            reason=f"URANS auto-refinement failed after first pass: {first.quality.reason}",
            measured_period_s=first.quality.measured_period_s,
            retained_cycles=first.quality.retained_cycles,
            retained_frame_count=first.quality.retained_frame_count,
            frames_per_cycle=first.quality.frames_per_cycle,
            retained_start_time=first.quality.retained_start_time,
            retained_end_time=first.quality.retained_end_time,
        )
        return first
    return refined


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _file_entry(base: Path, path: Path, role: str) -> dict[str, object]:
    st = path.stat()
    return {
        "path": str(path.relative_to(base)),
        "role": role,
        "byteSize": st.st_size,
        "sha256": _sha256_file(path),
    }


def _copy_file_preserving_rel(
    src_base: Path,
    src: Path,
    dst_base: Path,
    entries: list[dict[str, object]],
    role: str,
    manifest_base: Path | None = None,
) -> None:
    try:
        rel = src.relative_to(src_base)
    except ValueError:
        rel = Path(src.name)
    dst = dst_base / rel
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst, follow_symlinks=True)
    entries.append(_file_entry(manifest_base or dst_base, dst, role))


def _copy_tree_files(
    src_base: Path,
    dst_base: Path,
    entries: list[dict[str, object]],
    role: str,
    manifest_base: Path | None = None,
) -> None:
    if not src_base.exists():
        return
    for root, _dirs, files in os.walk(src_base, followlinks=True):
        for name in sorted(files):
            src = Path(root) / name
            if not src.is_file():
                continue
            _copy_file_preserving_rel(src_base, src, dst_base, entries, role, manifest_base=manifest_base)


def _evidence_mime(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".json":
        return "application/json"
    if suffix == ".gz":
        return "application/gzip"
    if suffix in {".vtu", ".vtk", ".vtp"}:
        return "application/vnd.vtk"
    if suffix in {".dat", ".log", ".txt"}:
        return "text/plain"
    if suffix == ".png":
        return "image/png"
    return "application/octet-stream"


def _artifact_kind_for_role(role: str) -> str:
    return role if role in {
        "vtk_window",
        "time_directory",
        "log",
        "force_coefficients",
        "mesh",
        "dictionary",
        FRAME_IMAGE_ARTIFACT_KIND,
    } else "field_data"


def _numeric_dirs_in_window(case_dir: Path, start_time: float | None, end_time: float | None) -> list[Path]:
    dirs: list[tuple[float, Path]] = []
    for child in case_dir.iterdir() if case_dir.exists() else []:
        if not child.is_dir():
            continue
        try:
            t = float(child.name)
        except ValueError:
            continue
        if start_time is not None and t < start_time:
            continue
        if end_time is not None and t > end_time:
            continue
        dirs.append((t, child))
    if not dirs:
        latest = _latest_time_dir(case_dir)
        return [latest] if latest is not None else []
    return [path for _, path in sorted(dirs)]


def _archive_case_evidence(
    case_dir: Path,
    post_dir: Path,
    outcome: CaseOutcome,
    *,
    image_subdir: str = "",
    start_time: float | None = None,
    end_time: float | None = None,
    requested_fields: list[str] | None = None,
) -> None:
    """Copy immutable raw evidence for this AoA and write manifest + bundle."""
    evidence_rel = Path(image_subdir) / "evidence" if image_subdir else Path("evidence")
    evidence_dir = case_dir / evidence_rel
    if evidence_dir.exists():
        shutil.rmtree(evidence_dir)
    evidence_dir.mkdir(parents=True, exist_ok=True)

    entries: list[dict[str, object]] = []
    raw_dir = evidence_dir / "openfoam"
    _copy_tree_files(case_dir / "system", raw_dir / "system", entries, "dictionary", manifest_base=evidence_dir)
    _copy_tree_files(case_dir / "constant", raw_dir / "constant", entries, "mesh", manifest_base=evidence_dir)
    if post_dir != case_dir:
        _copy_tree_files(post_dir / "system", raw_dir / "transient" / "system", entries, "dictionary", manifest_base=evidence_dir)
        _copy_tree_files(post_dir / "constant", raw_dir / "transient" / "constant", entries, "mesh", manifest_base=evidence_dir)

    for log in sorted(set(case_dir.glob("log*")) | set(post_dir.glob("log*"))):
        if log.is_file():
            _copy_file_preserving_rel(log.parent, log, raw_dir / "logs" / log.parent.name, entries, "log", manifest_base=evidence_dir)

    _copy_tree_files(post_dir / "postProcessing", raw_dir / "postProcessing", entries, "force_coefficients", manifest_base=evidence_dir)

    # Keep exact field evidence separately so future custom renders never depend
    # on mutable warm-start case directories.
    vtk_dir = evidence_dir / "VTK"
    try:
        selected_vtus = select_vtus(find_all_vtus(post_dir), start_time, end_time, None)
    except Exception:  # noqa: BLE001
        selected_vtus = []
    for vtu in selected_vtus:
        rel_parent = vtu.parent.name if vtu.parent.name != "VTK" else ""
        dst_parent = vtk_dir / rel_parent if rel_parent else vtk_dir
        dst_parent.mkdir(parents=True, exist_ok=True)
        dst = dst_parent / vtu.name
        shutil.copy2(vtu, dst)
        entries.append(_file_entry(evidence_dir, dst, "vtk_window"))
    if selected_vtus:
        # foamToVTK names frame dirs by timestep index; the .series file is the
        # name -> physical-time map, so archive it with the frames it describes.
        first_vtu = selected_vtus[0]
        vtk_src_root = first_vtu.parent if first_vtu.parent.name == "VTK" else first_vtu.parent.parent
        for series in sorted(vtk_src_root.glob("*.series")):
            vtk_dir.mkdir(parents=True, exist_ok=True)
            dst = vtk_dir / series.name
            shutil.copy2(series, dst)
            entries.append(_file_entry(evidence_dir, dst, "vtk_window"))

    time_dir_root = evidence_dir / "time_directories"
    for time_dir in _numeric_dirs_in_window(post_dir, start_time, end_time):
        _copy_tree_files(time_dir, time_dir_root / time_dir.name, entries, "time_directory", manifest_base=evidence_dir)

    # frame_track PNG sequence (contract: frames/{field}/f{i04}.png under the
    # case dir) ships inside the evidence bundle with the pinned artifact kind.
    frames_src = (case_dir / image_subdir / "frames") if image_subdir else (case_dir / "frames")
    _copy_tree_files(frames_src, evidence_dir / "frames", entries, FRAME_IMAGE_ARTIFACT_KIND, manifest_base=evidence_dir)

    expected_roles = ["instantaneous", "mean", "video"] if outcome.unsteady else ["instantaneous"]
    unavailable: dict[str, list[str]] = {}
    if requested_fields:
        role_maps = {
            "instantaneous": outcome.images,
            "mean": outcome.mean_images,
            "video": outcome.video,
        }
        for role in expected_roles:
            missing = sorted(set(requested_fields) - set(role_maps[role].keys()))
            if missing:
                unavailable[role] = missing

    manifest = {
        "schemaVersion": 1,
        "casePath": str(case_dir),
        "postPath": str(post_dir),
        "aoaDeg": outcome.spec.aoa_deg,
        "speedMps": outcome.spec.speed,
        "chordM": outcome.spec.chord,
        "unsteady": outcome.unsteady,
        "windowStart": start_time,
        "windowEnd": end_time,
        "media": {
            "requestedFields": requested_fields or [],
            "expectedRoles": expected_roles,
            "instantaneous": outcome.images,
            "mean": outcome.mean_images,
            "video": outcome.video,
            "unavailable": unavailable,
        },
        # frames/ ships as individual frame_image artifacts (below) but is
        # EXCLUDED from the tar bundle: PNGs are incompressible, and bundling
        # them tripled the ~36-72MB per-point frame volume on the engine
        # volume. Consumers of the bundle get everything else; frame PNGs are
        # fetched through their own registered artifacts.
        "bundleExcludes": ["frames"],
        "files": entries,
    }
    manifest_path = evidence_dir / "evidence_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")

    bundle_path = evidence_dir / "openfoam_evidence.tar.gz"
    with tarfile.open(bundle_path, "w:gz") as tar:
        for child in sorted(evidence_dir.iterdir()):
            if child.name == bundle_path.name or child.name == "frames":
                continue
            tar.add(child, arcname=child.name, recursive=True)

    artifacts = []
    for kind, path, mime in (
        ("manifest", manifest_path, "application/json"),
        ("openfoam_bundle", bundle_path, "application/gzip"),
    ):
        artifacts.append(
            EvidenceArtifact(
                kind=kind,
                path=str(path.relative_to(case_dir)),
                mime_type=mime,
                sha256=_sha256_file(path),
                byte_size=path.stat().st_size,
                role="evidence",
                metadata={
                    "evidenceBase": str(evidence_rel),
                    "fileCount": len(entries),
                    "windowStart": start_time,
                    "windowEnd": end_time,
                },
            )
        )
    for entry in entries:
        path = evidence_dir / str(entry["path"])
        if not path.is_file():
            continue
        role = str(entry["role"])
        kind = _artifact_kind_for_role(role)
        metadata: dict[str, object] = {
            "evidenceBase": str(evidence_rel),
            "manifestPath": str(manifest_path.relative_to(case_dir)),
            "windowStart": start_time,
            "windowEnd": end_time,
        }
        field_name: str | None = None
        if kind == FRAME_IMAGE_ARTIFACT_KIND:
            # The frame writer (render_frame_track_images) owns the
            # frames/{field}/f{i04}.png naming; stamp field + frameIndex
            # explicitly on the artifact so downstream URL resolution never
            # has to re-parse filenames (the filename coupling stays engine-
            # internal, pinned by tests on both runtimes).
            frame_match = re.match(r"^frames/([^/]+)/f(\d+)\.\w+$", str(entry["path"]))
            if frame_match:
                field_name = frame_match.group(1)
                metadata["frameIndex"] = int(frame_match.group(2))
        artifacts.append(
            EvidenceArtifact(
                kind=kind,
                path=str(path.relative_to(case_dir)),
                mime_type=_evidence_mime(path),
                sha256=str(entry["sha256"]),
                byte_size=int(entry["byteSize"]),
                role=role,
                field=field_name,
                metadata=metadata,
            )
        )
    outcome.evidence_artifacts = artifacts


def _finalize_outcome(
    case_dir, outcome, airfoil, resolved, spec, fluid, roughness, solver_params,
    runner, n_proc, render_images, solver_timeout, transient_subdir="transient", image_subdir="",
    shared_mesh_dir: Optional[Path] = None, steady_field_dir: Optional[Path] = None,
    cancel_check: CancelCheck = None,
    phase_progress=None, case_slug: Optional[str] = None,
    media_budget_s: Optional[float] = None,
):
    """Parse forces, run the transient fallback if needed, compute y+ and images.

    ``image_subdir`` namespaces the output under the case dir (used to keep each
    marched AoA's artefacts separate within one polar directory).

    ``phase_progress(phase, aoa, slug, solver, message=None)`` (optional) makes
    the post-solve stage TRUTHFUL: the y+/VTK/render/frame block reports
    ``JobPhase.postprocessing`` (2026-07-07 incident: the phase stayed
    ``solving_urans`` through a 3+ hour render grind, so node-side zombie
    detection correctly stayed silent) and render progress bumps the status
    message (an observable progress token for the engine stall detector).

    ``media_budget_s`` is the wall budget for the media/frame stage (default
    ``MEDIA_BUDGET_FRACTION_DEFAULT * solver_timeout``); on breach the job
    completes with partial media and a loud quality warning.
    """
    _check_cancel(cancel_check)
    coeff_files = _coeff_files(case_dir)
    if coeff_files:
        steady_coeff = coeff_files[-1]
        coeffs = parse_force_coefficients(steady_coeff)
        outcome.cl, outcome.cd, outcome.cm = coeffs.cl, coeffs.cd, coeffs.cm
        outcome.cl_cd = coeffs.cl_cd
        if not outcome.converged and force_is_steady(steady_coeff):
            outcome.converged = True
        # Oscillating-steady averaging (R1): a steady solve that failed both
        # residual convergence and the pointwise force plateau, but oscillates
        # BOUNDEDLY with a stable windowed mean, is accepted with the window
        # average as the point values. The full coefficient history ships as
        # steady_history in BOTH the accepted and the still-failing case (the
        # failing history is analysis evidence on the escalation path);
        # classic converged solves ship steady_history=null.
        if not outcome.converged and not solver_params.force_transient:
            try:
                osc = analyze_steady_oscillation(
                    steady_coeff, window=solver_params.steady_oscillation_window
                )
            except Exception as exc:  # noqa: BLE001 - analysis loss must not fail the case
                logger.warning("oscillating-steady analysis failed for %s: %s", case_dir, exc)
                osc = None
            if osc is not None:
                outcome.steady_history = SteadyHistory(
                    iterations=osc.iterations,
                    cl=osc.cl,
                    cd=osc.cd,
                    cm=osc.cm,
                    window=SteadyHistoryWindow(
                        start_iter=osc.window_start_iter, end_iter=osc.window_end_iter
                    ),
                    mean_stable=osc.mean_stable,
                    note=osc.note,
                )
                if osc.mean_stable:
                    outcome.cl, outcome.cd, outcome.cm = osc.cl_mean, osc.cd_mean, osc.cm_mean
                    outcome.cl_cd = osc.cl_mean / osc.cd_mean if osc.cd_mean else None
                    outcome.converged = True
                    outcome.quality_warnings.append(osc.note)
        if (
            not outcome.converged
            and not solver_params.force_transient
            and not solver_params.transient_fallback
        ):
            # RANS-tier terminal non-convergence (2026-07-07 ladder-gate
            # incident, job a2379532): with no in-engine escalation configured
            # the case has REAL force data and must SHIP as an honest point —
            # converged=false, final-window coefficients (parse_force_
            # coefficients tail average, the pre-ladder convention),
            # steady_history evidence and this loud note. The node-side ladder
            # classifier owns the escalate-to-URANS decision; a case failure
            # here turned a single-point gate campaign into "All cases failed"
            # with zero ingestable points and made escalation unreachable.
            note = (
                "steady RANS did not converge; coefficients are the final-window "
                "(last 50 iterations) values"
            )
            if outcome.steady_history is not None:
                note += f" — {outcome.steady_history.note}"
            outcome.quality_warnings.append(note)
    elif not solver_params.force_transient:
        raise OpenFOAMError("forceCoeffs produced no coefficient.dat")

    # transient (URANS) fallback for unsteady (e.g. post-stall) conditions
    post_dir = case_dir
    frame_stats: Optional[PeriodWindowStats] = None
    frame_series: Optional[tuple] = None  # merged (t, cl, cd, cm) coefficient arrays
    if solver_params.force_transient or (not outcome.converged and solver_params.transient_fallback):
        # Fidelity tier: the tier owns the retained-period target and the
        # transient wall-clock budget (precalc: 3 periods / 3600 s; full:
        # 7 periods / 21600 s) — contract item 1, pinned cross-runtime.
        urans_params = apply_urans_fidelity(solver_params)
        urans_timeout = urans_budget_seconds(solver_params)
        transient = _run_transient(
            case_dir, airfoil, resolved, spec, fluid, roughness, urans_params,
            runner, n_proc, urans_timeout, subdir=transient_subdir, shared_mesh_dir=shared_mesh_dir,
            steady_field_dir=steady_field_dir,
            cancel_check=cancel_check,
        )
        _check_cancel(cancel_check)
        if transient is not None:
            avg = transient.avg
            outcome.cl, outcome.cd, outcome.cm = avg.cl, avg.cd, avg.cm
            outcome.cl_cd = avg.cl_cd
            outcome.cl_std, outcome.cd_std, outcome.cm_std = avg.cl_std, avg.cd_std, avg.cm_std
            # A non-shedding transient is physically steady: report it as a
            # converged steady point (mean coefficients), not as unsteady, so it
            # gets steady single-frame media rather than a periodic animation.
            outcome.unsteady = not transient.quality.no_shedding
            outcome.converged = True
            # Truthful tier echo: these values came from the URANS transient
            # of this request's fidelity tier (a no-shedding steady-equivalent
            # mean is STILL a URANS-produced value, so it echoes urans_*).
            outcome.fidelity = urans_point_fidelity(solver_params)
            post_dir = transient.case_dir
            outcome.force_history = transient.force_history
            if transient.force_history is not None and not transient.quality.no_shedding:
                outcome.strouhal = transient.force_history.strouhal
            if not transient.quality.ok:
                outcome.quality_warnings.append(transient.quality.reason)
            # Frame-track recording contract: integer-period time-weighted stats
            # become the SINGLE SOURCE OF TRUTH for the point coefficients and
            # the measured Strouhal number. No-shedding points stay on the plain
            # time-average path (frame_track stays None).
            if not transient.quality.no_shedding and transient.coeff_paths:
                try:
                    t_all, cl_all, cd_all, cm_all = coefficient_series(transient.coeff_paths)
                    if transient.early_stopped:
                        # Certified-stable tail only (marker retain_from):
                        # a zero discard windowed the startup transient into
                        # the means (+~9% Cl bias) and tripped the drift check.
                        t_c, cl_c, cd_c, cm_c = _early_stop_retained_series(
                            transient.case_dir, t_all, cl_all, cd_all, cm_all
                        )
                    else:
                        t_c, cl_c, cd_c, cm_c = discard_startup(
                            t_all, cl_all, cd_all, cm_all,
                            fraction=solver_params.transient_discard_fraction,
                        )
                    frame_period = measure_period(t_c, cl_c)
                    if frame_period is None and transient.force_history is not None:
                        frame_period = transient.force_history.period_s
                    if frame_period is not None and frame_period > 0:
                        frame_stats = period_window_stats(
                            t_c, cl_c, cd_c, cm_c, frame_period,
                            drift_tolerance=solver_params.urans_drift_tolerance,
                        )
                        frame_series = (t_all, cl_all, cd_all, cm_all)
                except Exception as exc:  # noqa: BLE001 - stats loss is loud degradation
                    logger.warning("frame-track stats failed for %s: %s", case_dir, exc, exc_info=True)
                    outcome.quality_warnings.append(f"frame-track stats failed: {exc}")
            if frame_stats is not None:
                outcome.cl = frame_stats.cl.mean
                outcome.cd = frame_stats.cd.mean
                outcome.cm = frame_stats.cm.mean
                outcome.cl_cd = (
                    frame_stats.cl.mean / frame_stats.cd.mean if frame_stats.cd.mean else None
                )
                outcome.cl_std, outcome.cd_std, outcome.cm_std = (
                    frame_stats.cl.std, frame_stats.cd.std, frame_stats.cm.std,
                )
                if spec.speed > 0 and frame_stats.period_s > 0:
                    outcome.strouhal = spec.chord / (frame_stats.period_s * spec.speed)
                if not frame_stats.stationary:
                    outcome.quality_warnings.append(
                        f"URANS window not stationary: Cl drift {frame_stats.drift_frac:.3f} "
                        f"exceeds tolerance {solver_params.urans_drift_tolerance:g} over "
                        f"{frame_stats.whole_periods} whole periods"
                    )
        elif solver_params.force_transient or not coeff_files:
            # A URANS-only case must never silently fall back to the steady
            # coefficients; a fallback case with steady coefficients keeps them.
            transient_coeffs = _coeff_files(case_dir / transient_subdir)
            if transient_coeffs:
                # The file EXISTS — never claim it was not produced (prod
                # incident: timed-out clarky URANS runs had healthy
                # coefficient.dat rows but were reported as "produced no
                # coefficient.dat"). Timeouts raise their own truthful error
                # inside _run_transient_attempt; this branch covers crashes
                # after partial output.
                reached = _coeff_last_time(transient_coeffs[-1])
                reached_s = f"{reached:.6g}" if reached is not None else "unknown"
                raise OpenFOAMError(
                    f"URANS transient failed before grading (coefficient.dat has data up to "
                    f"t={reached_s}s); see {transient_subdir}/log.pimpleFoam"
                )
            raise OpenFOAMError("URANS transient produced no coefficient.dat")

    # Truthful stage transition: everything below (y+ / foamToVTK / renders /
    # frame export) is post-processing, not solving. The phase change also
    # bumps status phase_started_at + last_progress_at (storage.write_status).
    def media_progress(message: str) -> None:
        if phase_progress:
            phase_progress(JobPhase.postprocessing, spec.aoa_deg, case_slug, None, message)

    media_progress("postprocessing: y+ / VTK conversion / media rendering")

    # y+
    _check_cancel(cancel_check)
    runner.application(post_dir, "simpleFoam -postProcess -func yPlus -latestTime")
    _check_cancel(cancel_check)
    yplus_files = sorted(post_dir.glob("postProcessing/yPlus/*/yPlus.dat"))
    if yplus_files:
        outcome.y_plus_avg, outcome.y_plus_max = parse_y_plus(yplus_files[-1])

    # contour images
    media_start_time = None
    media_end_time = None
    frame_times: list[float] = []
    frame_fields_rendered: list[str] = []
    requested_fields = [field.value if hasattr(field, "value") else str(field) for field in solver_params.write_images]
    budget = MediaBudget(
        media_budget_s if media_budget_s is not None else MEDIA_BUDGET_FRACTION_DEFAULT * solver_timeout
    )
    expected_artifacts = 0
    if render_images and solver_params.write_images:
        img_out = (case_dir / image_subdir / "images") if image_subdir else (case_dir / "images")
        prefix = f"{image_subdir}/" if image_subdir else ""
        suffix = f"{airfoil.name} a={spec.aoa_deg:g}deg U={spec.speed:g}"
        fields = solver_params.write_images
        if outcome.unsteady:
            if outcome.force_history is not None:
                media_start_time = outcome.force_history.window_start
                media_end_time = outcome.force_history.window_end
                if media_start_time is None and outcome.force_history.t:
                    media_start_time = outcome.force_history.t[0]
                if media_end_time is None and outcome.force_history.t:
                    media_end_time = outcome.force_history.t[-1]
            anim_start_time = media_start_time
            anim_end_time = media_end_time
            if frame_stats is not None:
                # The integer-period stats window is the media window, and the
                # video is rendered FROM the frame-export window (last
                # min(3, K) periods) so video and frames agree.
                media_start_time = frame_stats.window_start
                media_end_time = frame_stats.window_end
                frame_span = (
                    min(URANS_FRAME_SPAN_PERIODS, frame_stats.whole_periods)
                    * frame_stats.period_s
                )
                anim_start_time = frame_stats.window_end - frame_span
                anim_end_time = frame_stats.window_end
            expected_artifacts = 3 * len(fields) + len(solver_params.frame_fields if frame_stats is not None else [])
            # Convert the transient fields; mean/animation use the retained measured
            # shedding window so dense refined runs become readable media.
            # foamToVTK is never budget-skipped: the VTU frames are the raw
            # EVIDENCE (archived below) — only derived media renders degrade.
            runner.application(post_dir, "foamToVTK").check()
            _check_cancel(cancel_check)
            if not budget.exceeded():
                media_progress("rendering instantaneous contours")
                inst = render_contours(
                    post_dir, img_out, airfoil.contour, spec.chord, fields,
                    zoom_chords=solver_params.image_zoom_chords,
                    title_suffix=suffix + " (URANS instant)", freestream_speed=spec.speed,
                )
                outcome.images = {k: f"{prefix}images/{v}" for k, v in inst.items()}
            # Media loss is degradation, not failure: the job keeps its
            # coefficients, but every render failure must be LOUD (logged and
            # recorded as a quality warning) so the evidence manifest and the
            # classifier see the gap instead of a silent empty map.
            if not budget.exceeded():
                media_progress("rendering mean contours")
                try:
                    means = render_mean_contours(
                        post_dir, img_out, airfoil.contour, spec.chord, fields,
                        zoom_chords=solver_params.image_zoom_chords, title_suffix=suffix,
                        freestream_speed=spec.speed,
                        max_frames=URANS_ANIMATION_FRAMES,
                        start_time=media_start_time,
                        end_time=media_end_time,
                    )
                    outcome.mean_images = {k: f"{prefix}images/{v}" for k, v in means.items()}
                except Exception as exc:  # noqa: BLE001 - media is degradation, not failure
                    logger.warning("URANS mean-image render failed for %s: %s", case_dir, exc, exc_info=True)
                    outcome.quality_warnings.append(f"mean-image render failed: {exc}")
            vids: dict[str, str] = {}
            if not budget.exceeded():
                try:
                    batch = render_animations(
                        post_dir, img_out, airfoil.contour, spec.chord, fields,
                        freestream_speed=spec.speed, zoom_chords=solver_params.image_zoom_chords,
                        max_frames=min(URANS_ANIMATION_FRAMES, URANS_MAX_ANIMATION_FRAMES),
                        start_time=anim_start_time,
                        end_time=anim_end_time,
                        title_suffix=suffix,
                        deadline=budget.deadline(),
                        progress=media_progress,
                    )
                except Exception as exc:  # noqa: BLE001 - media is degradation, not failure
                    logger.warning("URANS animation render failed for %s: %s", case_dir, exc, exc_info=True)
                    outcome.quality_warnings.append(f"animation render failed: {exc}")
                else:
                    for field_name, err in batch.errors.items():
                        logger.warning(
                            "URANS animation render failed for %s field %s: %s", case_dir, field_name, err
                        )
                        outcome.quality_warnings.append(f"animation render failed ({field_name}): {err}")
                    vids = {k: f"{prefix}images/{v}" for k, v in batch.videos.items()}
            outcome.video = vids
            # Frame-track PNG export: ~24 frames/period over the last
            # min(3, K) periods (cap 120), rendered from the VTU frames nearest
            # each target time at the contract's 640px width.
            if frame_stats is not None and solver_params.frame_fields:
                frames_out = (
                    (case_dir / image_subdir / "frames") if image_subdir else (case_dir / "frames")
                )
                if not budget.exceeded():
                    try:
                        targets = frame_target_times(
                            frame_stats.window_end, frame_stats.period_s, frame_stats.whole_periods,
                            span_periods=URANS_FRAME_SPAN_PERIODS,
                        )
                        frame_times, frame_fields_rendered = render_frame_track_images(
                            post_dir, frames_out, airfoil.contour, spec.chord,
                            solver_params.frame_fields, targets,
                            freestream_speed=spec.speed,
                            zoom_chords=solver_params.image_zoom_chords,
                            deadline=budget.deadline(),
                            progress=media_progress,
                        )
                    except Exception as exc:  # noqa: BLE001 - media is degradation, not failure
                        logger.warning(
                            "URANS frame-track image export failed for %s: %s", case_dir, exc, exc_info=True
                        )
                        outcome.quality_warnings.append(f"frame image export failed: {exc}")
                        frame_times, frame_fields_rendered = [], []
                missing_frame_fields = sorted(
                    {f.value for f in solver_params.frame_fields} - set(frame_fields_rendered)
                )
                if missing_frame_fields:
                    outcome.quality_warnings.append(
                        "frame images unavailable for fields: " + ", ".join(missing_frame_fields)
                    )
        else:
            expected_artifacts = len(fields)
            runner.application(post_dir, "foamToVTK -latestTime").check()
            _check_cancel(cancel_check)
            if not budget.exceeded():
                imgs = render_contours(
                    post_dir, img_out, airfoil.contour, spec.chord, fields,
                    zoom_chords=solver_params.image_zoom_chords, title_suffix=suffix,
                    freestream_speed=spec.speed,
                )
                outcome.images = {k: f"{prefix}images/{v}" for k, v in imgs.items()}
        rendered_artifacts = (
            len(outcome.images) + len(outcome.mean_images) + len(outcome.video) + len(frame_fields_rendered)
        )
        if budget.exceeded() and rendered_artifacts < expected_artifacts:
            warning = (
                f"media rendering budget exhausted after {budget.elapsed():.0f}s: "
                f"rendered {rendered_artifacts} of {expected_artifacts} artifacts"
            )
            logger.warning("%s (%s)", warning, case_dir)
            outcome.quality_warnings.append(warning)

    # Ship the pinned frame_track contract on every shedding URANS point (the
    # stats are real even when media rendering is disabled/unavailable —
    # missing frames are shipped as an empty list, never invented). Steady and
    # no-shedding points ship frame_track=None.
    if outcome.unsteady and frame_stats is not None:
        samples: list[FrameSample] = []
        if frame_times and frame_series is not None:
            samples = [
                FrameSample(i=i, t=t, cl=cl, cd=cd, cm=cm)
                for i, t, cl, cd, cm in frame_coefficients(frame_times, *frame_series)
            ]

        def channel(stats: ChannelWindowStats) -> FrameChannelStats:
            return FrameChannelStats(mean=stats.mean, std=stats.std, min=stats.min, max=stats.max)

        outcome.frame_track = FrameTrack(
            period_s=frame_stats.period_s,
            periods_retained=frame_stats.periods_retained,
            stationary=frame_stats.stationary,
            drift_frac=frame_stats.drift_frac,
            window=FrameTrackWindow(t_start=frame_stats.window_start, t_end=frame_stats.window_end),
            stats=FrameTrackStats(
                cl=channel(frame_stats.cl), cd=channel(frame_stats.cd), cm=channel(frame_stats.cm)
            ),
            fields=frame_fields_rendered,
            frames=samples,
            image_pattern=(
                f"{image_subdir}/frames/{{field}}/f{{i04}}.png"
                if image_subdir
                else "frames/{field}/f{i04}.png"
            ),
        )

    _archive_case_evidence(
        case_dir,
        post_dir,
        outcome,
        image_subdir=image_subdir,
        start_time=media_start_time if outcome.unsteady else None,
        end_time=media_end_time if outcome.unsteady else None,
        requested_fields=requested_fields if render_images else [],
    )


def run_case(
    case_dir: Path,
    airfoil: Airfoil,
    spec: CaseSpec,
    fluid: FluidProperties,
    roughness: RoughnessParams,
    mesh_params: MeshParams,
    solver_params: SolverParams,
    mesher: Mesher,
    runner: Runner,
    n_proc: int = 1,
    render_images: bool = True,
    solver_timeout: int = 7200,
    rans_solver_timeout: Optional[int] = None,
    rans_max_iterations: Optional[int] = None,
    mesh_dir: Optional[Path] = None,
    cancel_check: CancelCheck = None,
    cache: Optional[EngineCache] = None,
    phase_progress=None,
    case_slug: Optional[str] = None,
    media_budget_s: Optional[float] = None,
) -> CaseOutcome:
    """Run one self-contained case. If ``mesh_dir`` is given, reuse that prebuilt
    mesh (skip blockMesh) instead of meshing in the case directory. With a
    ``cache``, the steady start seeds from the nearest previously solved angle
    at the same mesh/fluid/speed, and accepted steady fields are published back."""
    case_dir.mkdir(parents=True, exist_ok=True)
    re = physics.reynolds(spec.speed, spec.chord, fluid.nu)
    outcome = CaseOutcome(spec=spec, reynolds=re)
    steady_timeout = min(solver_timeout, rans_solver_timeout or solver_timeout)
    steady_solver_params = _steady_rans_params(solver_params, rans_max_iterations)

    try:
        _check_cancel(cancel_check)
        if mesh_dir is None:
            # Standalone case builds its own mesh: a precalc URANS request
            # meshes the derived half-resolution grid (contract item 1). With
            # a prebuilt mesh_dir the caller already derived before building.
            mesh_params = effective_mesh_params(mesh_params, solver_params)
        resolved = resolve_mesh_params(mesh_params, spec, fluid)
        patches = mesher.patches(resolved)
        if mesh_dir is None:
            # controlDict (written by the case builder) must exist before blockMesh
            mesher.write_inputs(case_dir, airfoil, resolved, spec.chord)

        def write_case(sp):
            CaseBuilder(
                airfoil, patches, resolved, spec, fluid, roughness, sp, n_proc=n_proc
            ).write(case_dir)
            if mesh_dir is not None:
                _link_mesh(case_dir, mesh_dir, runner)

        write_case(steady_solver_params)

        if mesh_dir is None:
            outcome.n_cells = mesher.run_mesh(case_dir, resolved, runner).n_cells
        else:
            outcome.n_cells = mesher.cell_count(resolved) if hasattr(mesher, "cell_count") else 0
        _check_cancel(cancel_check)

        def solve_once(sp) -> "RunResult":
            _check_cancel(cancel_check)
            write_case(sp)
            # Each steady attempt earns its own divergence verdict (the upwind
            # fallback retry must not inherit the 2nd-order condemnation).
            clear_divergence_condemnation(case_dir)
            seeded = _try_seed_initial_field(
                case_dir, airfoil, spec.chord, resolved, spec, fluid, roughness, sp,
                runner, cache, cancel_check=cancel_check,
            )
            if not seeded:
                # Potential-flow initialisation greatly stabilises the cold RANS start.
                runner.application(case_dir, "potentialFoam -writephi -initialiseUBCs", timeout=600)
            _check_cancel(cancel_check)
            res = runner.solver(case_dir, "simpleFoam", n_proc, timeout=steady_timeout)
            _check_cancel(cancel_check)
            return res

        # 4/5. solve, with an automatic first-order fallback for fragile cases
        # (e.g. the delicate symmetric AoA=0 state) that diverge with 2nd-order
        # convection. The fallback is more dissipative but reliably stable.
        #
        # URANS-only (force_transient) cases run this steady RANS stage too:
        # even a non-converged steady field is a vastly better transient initial
        # condition than a uniform-flow cold start (prod: cambered airfoil at
        # alpha=4 cold-started URANS -> dt collapsed to ~1e-6 s -> timeout), and
        # the steady log/coefficients are valuable attempt evidence. The only
        # differences: a steady failure must not abort the URANS attempt, and
        # the steady coefficients are never accepted as the reported result.
        steady_field_dir: Optional[Path] = None
        res = solve_once(steady_solver_params)
        if not res.ok and steady_solver_params.momentum_scheme != "upwind":
            outcome.first_order_fallback = True
            res = solve_once(steady_solver_params.model_copy(update={"momentum_scheme": "upwind"}))
        if solver_params.force_transient and not res.ok:
            (case_dir / "log.simpleFoam").write_text(res.stdout)
            outcome.quality_warnings.append(
                "steady RANS initialisation stage failed; URANS falls back to a short steady init"
            )
        else:
            # Prefer the watchdog's truthful divergence message over the
            # generic "Command failed" tail when the solver was condemned.
            if not res.ok:
                _raise_if_condemned(case_dir)
            log = res.check().stdout
            (case_dir / "log.simpleFoam").write_text(log)
            conv = parse_convergence(log)
            outcome.converged = conv.converged
            outcome.iterations = conv.iterations
            outcome.final_residual = conv.final_residual
            if solver_params.force_transient:
                lt_dir = _latest_time_dir(case_dir)
                if lt_dir is not None and float(lt_dir.name) > 0:
                    steady_field_dir = lt_dir

        _finalize_outcome(
            case_dir, outcome, airfoil, resolved, spec, fluid, roughness, solver_params,
            runner, n_proc, render_images, solver_timeout, shared_mesh_dir=mesh_dir,
            steady_field_dir=steady_field_dir,
            cancel_check=cancel_check,
            phase_progress=phase_progress,
            case_slug=case_slug,
            media_budget_s=media_budget_s,
        )

        if (
            cache is not None
            and not solver_params.force_transient
            and not rans_outcome_rejected_for_polar(outcome)
        ):
            _publish_steady_seed(
                cache, case_dir, airfoil, spec.chord, resolved, spec, fluid,
                roughness, steady_solver_params,
            )

    except JobCancelled:
        raise
    except (OpenFOAMError, Exception) as exc:  # noqa: BLE001 - report, don't crash the batch
        outcome.error = f"{type(exc).__name__}: {exc}"

    return outcome


# --------------------------------------------------------------------------- #
# Mesh-once + warm-start marching (throughput path for batch polars)
# --------------------------------------------------------------------------- #
def _write_minimal_controldict(case_dir: Path) -> None:
    from .openfoam.foam_dict import write_foam_dict

    write_foam_dict(
        case_dir / "system" / "controlDict", "dictionary", "controlDict",
        {
            "application": "blockMesh", "startFrom": "startTime", "startTime": 0,
            "stopAt": "endTime", "endTime": 1, "deltaT": 1,
            "writeControl": "timeStep", "writeInterval": 1,
        },
    )


def _steady_rans_params(solver_params: SolverParams, rans_max_iterations: Optional[int]) -> SolverParams:
    """Worker-side steady-iteration cap, scoped to the URANS-INIT steady stage.

    A force_transient (URANS-only) case runs its steady RANS stage purely as a
    transient initialisation + evidence pass, so the worker cap
    (settings.rans_max_iterations, default 600) keeps that warm-up from
    monopolising CPU — the warm-start fix this cap was built for.

    A PRIMARY steady RANS solve must honor the profile's n_iterations budget.
    2026-07-07 ladder-gate incident: the solver profile shipped
    n_iterations=3000 but the steady controlDict got endTime=600 because this
    cap was applied unconditionally (jobs.py passes
    settings.rans_max_iterations to every job; CaseBuilder writes
    endTime=self.solver.n_iterations), starving moderate-AoA convergence."""
    if rans_max_iterations is None or not solver_params.force_transient:
        return solver_params
    cap = max(50, int(rans_max_iterations))
    if solver_params.n_iterations <= cap:
        return solver_params
    return solver_params.model_copy(update={"n_iterations": cap})


def prepare_mesh(
    mesh_dir: Path, airfoil, resolved, chord, mesher, runner,
    cancel_check: CancelCheck = None, cache: Optional[EngineCache] = None,
):
    """Build the mesh once (blockMesh) into ``mesh_dir`` for reuse across a polar
    set (all speeds/AoAs of one airfoil at one chord share this mesh).

    With a ``cache``, a mesh whose (airfoil geometry, chord, resolved params) was
    built by a previous job is copied from the persistent cache instead of
    re-running blockMesh; fresh builds are published back for future jobs."""
    _check_cancel(cancel_check)
    mesh_dir.mkdir(parents=True, exist_ok=True)
    mesher.write_inputs(mesh_dir, airfoil, resolved, chord)
    _write_minimal_controldict(mesh_dir)
    mesh_key = cache.mesh_key(airfoil, chord, resolved) if cache is not None else None
    if cache is not None and mesh_key is not None:
        manifest = cache.fetch_mesh(mesh_key, mesh_dir / "constant" / "polyMesh")
        if manifest is not None:
            _check_cancel(cancel_check)
            n_cells = int(manifest.get("nCells") or 0)
            if n_cells <= 0 and hasattr(mesher, "cell_count"):
                n_cells = mesher.cell_count(resolved)
            return MeshResult(
                patches=mesher.patches(resolved),
                span_chords=resolved.span_chords,
                n_cells=n_cells,
                log=f"reused cached mesh (key {mesh_key})",
            )
    result = mesher.run_mesh(mesh_dir, resolved, runner)
    _check_cancel(cancel_check)
    if cache is not None and mesh_key is not None:
        cache.publish_mesh(mesh_key, mesh_dir / "constant" / "polyMesh", n_cells=result.n_cells)
    return result


def _link_mesh(case_dir: Path, mesh_dir: Path, runner: Runner) -> None:
    """Make the shared mesh available in the case: symlink when the solver can see
    host paths (LocalRunner), otherwise copy it in (DockerRunner mounts only /case)."""
    (case_dir / "constant").mkdir(parents=True, exist_ok=True)
    dst = case_dir / "constant" / "polyMesh"
    # idempotent: a valid mesh already in place is reused as-is
    if (dst / "points").exists():
        return
    if dst.is_symlink() or dst.exists():
        if dst.is_dir() and not dst.is_symlink():
            shutil.rmtree(dst)
        else:
            dst.unlink()
    src = (mesh_dir / "constant" / "polyMesh").resolve()
    if runner.external_paths_visible:
        dst.symlink_to(src, target_is_directory=True)
    else:
        shutil.copytree(src, dst)


def _rewrite_carried_inlet_velocity(
    case_dir: Path, spec: CaseSpec, field_dir: str, runner: Runner, cancel_check: CancelCheck = None
) -> None:
    """Point a carried (previously converged) field at a new angle of attack by
    rewriting only the freestream velocity BC values in ``<field_dir>/U``.

    This is the single field-carry mechanism shared by the in-polar warm-start
    march and cross-job solution seeding; the case dictionaries written by the
    CaseBuilder stay authoritative for everything else."""
    fv = physics.freestream_vector(spec.speed, spec.aoa_deg)
    uval = f'"uniform ({fv.ux:.10g} {fv.uy:.10g} 0)"'
    for cmd in (
        f"foamDictionary -entry boundaryField.inlet.value -set {uval} {field_dir}/U",
        f"foamDictionary -entry boundaryField.outlet.value -set {uval} {field_dir}/U",
    ):
        _check_cancel(cancel_check)
        runner.application(case_dir, cmd).check()


def _try_seed_initial_field(
    case_dir: Path, airfoil, chord, resolved, spec, fluid, roughness, solver_params,
    runner: Runner, cache: Optional[EngineCache], cancel_check: CancelCheck = None,
) -> bool:
    """Seed a fresh steady case's ``0/`` fields from the nearest previously
    accepted angle at the same (mesh, fluid, speed) instead of a potentialFoam
    cold start. The donor fields are staged inside the case, the inlet velocity
    is rewritten for this angle exactly like the warm-start march does, and only
    then do they replace the CaseBuilder's ``0/`` files — any earlier failure
    leaves the case pristine for the normal potentialFoam path."""
    if cache is None:
        return False
    stage = case_dir / "_seed_stage"
    try:
        mesh_key = cache.mesh_key(airfoil, chord, resolved)
        seed_key = cache.seed_key(mesh_key, fluid, spec.speed)
        signature = cache.solver_signature(solver_params, roughness)
        hit: Optional[SeedHit] = cache.find_seed(
            seed_key, spec.aoa_deg, signature, max_delta_deg=SEED_MAX_ANGLE_DELTA_DEG
        )
        if hit is None:
            return False
        if stage.exists():
            shutil.rmtree(stage)
        copied = cache.materialize_seed(hit, stage)
        if "U" not in copied:
            shutil.rmtree(stage, ignore_errors=True)
            return False
        _rewrite_carried_inlet_velocity(case_dir, spec, stage.name, runner, cancel_check=cancel_check)
        zero = case_dir / "0"
        zero.mkdir(parents=True, exist_ok=True)
        for name in copied:
            os.replace(stage / name, zero / name)
        shutil.rmtree(stage, ignore_errors=True)
        logger.info(
            "seeded %s (aoa %g) from cached solution at aoa %g (fields: %s)",
            case_dir.name, spec.aoa_deg, hit.aoa_deg, ", ".join(copied),
        )
        return True
    except JobCancelled:
        raise
    except Exception as exc:  # noqa: BLE001 - seeding must never fail the solve
        logger.warning("solution seeding failed for %s: %s", case_dir, exc)
        shutil.rmtree(stage, ignore_errors=True)
        return False


def _publish_steady_seed(
    cache: Optional[EngineCache], case_dir: Path, airfoil, chord, resolved, spec, fluid,
    roughness, solver_params, solver: str = "simpleFoam",
) -> None:
    """Publish the latest-time fields of an ACCEPTED steady solve so later jobs
    at the same (mesh, fluid, speed) can seed nearby angles from them."""
    if cache is None:
        return
    try:
        lt_dir = _latest_time_dir(case_dir)
        if lt_dir is None or float(lt_dir.name) <= 0:
            return
        mesh_key = cache.mesh_key(airfoil, chord, resolved)
        seed_key = cache.seed_key(mesh_key, fluid, spec.speed)
        signature = cache.solver_signature(solver_params, roughness)
        cache.publish_seed(
            seed_key, spec.aoa_deg, signature, lt_dir,
            solver=solver, speed=spec.speed, fluid=fluid,
        )
    except Exception as exc:  # noqa: BLE001 - publishing is best-effort
        logger.warning("seed publish failed for %s: %s", case_dir, exc)


def _solve_cold_marched(
    polar_dir, mesh_dir, airfoil, patches, resolved, spec, fluid, roughness,
    solver_params, runner, solver_timeout, outcome, n_proc=1, cancel_check: CancelCheck = None,
    cache: Optional[EngineCache] = None,
):
    """Cold-start the first AoA of a polar (build case, reuse mesh, potentialFoam,
    or a cached-solution seed from a previous job when one is close enough)."""
    def write_case(sp):
        _check_cancel(cancel_check)
        CaseBuilder(airfoil, patches, resolved, spec, fluid, roughness, sp, n_proc=n_proc).write(polar_dir)
        _link_mesh(polar_dir, mesh_dir, runner)
        # keep only a few time dirs (warm-starts need just the latest as a seed)
        runner.application(polar_dir, "foamDictionary -entry purgeWrite -set 3 system/controlDict")

    def solve_once(sp):
        _check_cancel(cancel_check)
        write_case(sp)
        clear_divergence_condemnation(polar_dir)
        seeded = _try_seed_initial_field(
            polar_dir, airfoil, spec.chord, resolved, spec, fluid, roughness, sp,
            runner, cache, cancel_check=cancel_check,
        )
        if not seeded:
            runner.application(polar_dir, "potentialFoam -writephi -initialiseUBCs", timeout=600)
        _check_cancel(cancel_check)
        res = runner.solver(polar_dir, "simpleFoam", n_proc, timeout=solver_timeout)
        _check_cancel(cancel_check)
        return res

    res = solve_once(solver_params)
    if not res.ok and solver_params.momentum_scheme != "upwind":
        outcome.first_order_fallback = True
        res = solve_once(solver_params.model_copy(update={"momentum_scheme": "upwind"}))
    return res


def _solve_warm(polar_dir, spec, solver_params, runner, solver_timeout, n_proc=1, cancel_check: CancelCheck = None):
    """Warm-start one AoA: rewrite only the velocity BC + lift/drag dirs at the
    latest (previous-AoA) field and continue simpleFoam from it."""
    fv = physics.freestream_vector(spec.speed, spec.aoa_deg)
    clear_divergence_condemnation(polar_dir)
    lt_dir = _latest_time_dir(polar_dir)
    lt = lt_dir.name
    lt_v = int(float(lt))
    _rewrite_carried_inlet_velocity(polar_dir, spec, lt, runner, cancel_check=cancel_check)
    ld = f'"({fv.lift_dir[0]:.10g} {fv.lift_dir[1]:.10g} 0)"'
    dd = f'"({fv.drag_dir[0]:.10g} {fv.drag_dir[1]:.10g} 0)"'
    for cmd in (
        f"foamDictionary -entry functions.forceCoeffs1.liftDir -set {ld} system/controlDict",
        f"foamDictionary -entry functions.forceCoeffs1.dragDir -set {dd} system/controlDict",
        f"foamDictionary -entry endTime -set {lt_v + solver_params.n_iterations} system/controlDict",
        "foamDictionary -entry startFrom -set latestTime system/controlDict",
    ):
        _check_cancel(cancel_check)
        runner.application(polar_dir, cmd).check()
    _check_cancel(cancel_check)
    res = runner.solver(polar_dir, "simpleFoam", n_proc, timeout=solver_timeout)
    _check_cancel(cancel_check)
    return res


RANS_CORE_ABORT_AOA_MIN = 0.0
RANS_CORE_ABORT_AOA_MAX = 5.0


def rans_outcome_rejected_for_polar(outcome: CaseOutcome) -> bool:
    """True when a steady RANS point is evidence, but not a valid polar point."""
    if outcome.error:
        return True
    if outcome.unsteady:
        return True
    if not outcome.converged:
        return True
    if outcome.cl is None or outcome.cd is None:
        return True
    if not math.isfinite(outcome.cl) or not math.isfinite(outcome.cd):
        return True
    return outcome.cd <= 0


def steady_outcome_shippable(outcome: CaseOutcome) -> bool:
    """True when a REJECTED steady RANS outcome still carries real force data
    and therefore ships as an honest point (converged=false, final-window
    coefficients, steady_history, quality note) instead of vanishing into the
    attempts-only bucket. Case/point failure stays reserved for true crashes:
    an error set, or no finite coefficient data at all.

    2026-07-07 ladder-gate incident (job a2379532): a non-converged,
    non-oscillating steady at alpha=15 was dropped from final_points, the job
    shipped points=[] and failed with "All cases failed", and the node side
    (ingestFailedEngineJob short-circuits at points==0) could never submit the
    gated URANS escalation for single-point campaigns."""
    if outcome.error:
        return False
    if outcome.cl is None or outcome.cd is None:
        return False
    return math.isfinite(outcome.cl) and math.isfinite(outcome.cd)


def should_abort_rans_sweep_for_urans(aoa_deg: float, outcome: CaseOutcome) -> bool:
    return (
        RANS_CORE_ABORT_AOA_MIN <= aoa_deg <= RANS_CORE_ABORT_AOA_MAX
        and rans_outcome_rejected_for_polar(outcome)
    )


def _run_full_urans_replacement(
    polar_dir: Path,
    mesh_dir: Path,
    airfoil,
    chord,
    speed,
    fluid,
    roughness,
    resolved,
    solver_params,
    mesher,
    runner,
    aoas,
    n_cells=0,
    n_proc=1,
    render_images=True,
    solver_timeout=7200,
    progress=None,
    phase_progress=None,
    outcome_progress=None,
    progress_budget: Optional[int] = None,
    cancel_check: CancelCheck = None,
    media_budget_s: Optional[float] = None,
) -> list[StoredCaseOutcome]:
    urans_solver = solver_params.model_copy(
        update={"transient_fallback": True, "force_transient": True, "transient_auto_refine": True}
    )
    points: list[StoredCaseOutcome] = []
    for j, aoa in enumerate(sorted(aoas)):
        _check_cancel(cancel_check)
        spec = CaseSpec(chord=chord, speed=speed, aoa_deg=aoa)
        case_slug = f"{polar_dir.name}/urans_a{j}"
        case_dir = polar_dir / f"urans_a{j}"
        if phase_progress:
            phase_progress(JobPhase.solving_urans, aoa, case_slug, "pimpleFoam")
        outcome = run_case(
            case_dir,
            airfoil,
            spec,
            fluid,
            roughness,
            resolved,
            urans_solver,
            mesher,
            runner,
            n_proc=n_proc,
            render_images=render_images,
            solver_timeout=solver_timeout,
            mesh_dir=mesh_dir,
            cancel_check=cancel_check,
            phase_progress=phase_progress,
            case_slug=case_slug,
            media_budget_s=media_budget_s,
        )
        _check_cancel(cancel_check)
        outcome.n_cells = outcome.n_cells or n_cells
        stored = StoredCaseOutcome(slug=case_slug, outcome=outcome)
        points.append(stored)
        if outcome_progress:
            outcome_progress(stored, True)
        if progress and (progress_budget is None or j < progress_budget):
            progress()
    return points


def solve_polar_marched(
    polar_dir: Path, mesh_dir: Path, airfoil, chord, speed, fluid, roughness, resolved,
    solver_params, mesher, runner, aoas, n_cells=0, n_proc=1, render_images=True,
    solver_timeout=7200, rans_solver_timeout: Optional[int] = None,
    rans_max_iterations: Optional[int] = None, progress=None,
    phase_progress=None, outcome_progress=None, cancel_check: CancelCheck = None,
    cache: Optional[EngineCache] = None, media_budget_s: Optional[float] = None,
) -> PolarMarchResult:
    """Run one polar (fixed chord+speed) over the AoA sweep, reusing ``mesh_dir``
    and warm-starting each AoA from the previous converged field (marching).
    Returns final accepted points plus any rejected RANS attempts."""
    polar_dir.mkdir(parents=True, exist_ok=True)
    patches = mesher.patches(resolved)
    sorted_aoas = sorted(aoas)
    final_points: list[StoredCaseOutcome] = []
    attempts: list[StoredCaseOutcome] = []
    rans_solver = solver_params
    if not solver_params.force_transient:
        rans_solver = solver_params.model_copy(
            update={"transient_fallback": False, "force_transient": False}
        )
        # PRIMARY steady RANS honors the profile's n_iterations budget; the
        # worker-side rans_max_iterations cap is scoped to URANS-init steady
        # stages only (see _steady_rans_params — 2026-07-07 gate incident:
        # profile n_iterations=3000 ran with controlDict endTime 600).
    steady_timeout = solver_timeout if solver_params.force_transient else min(solver_timeout, rans_solver_timeout or solver_timeout)
    for i, aoa in enumerate(sorted_aoas):
        _check_cancel(cancel_check)
        spec = CaseSpec(chord=chord, speed=speed, aoa_deg=aoa)
        if phase_progress:
            phase_progress(
                JobPhase.solving_urans if solver_params.force_transient else JobPhase.solving_rans,
                aoa,
                f"{polar_dir.name}/a{i}",
                "pimpleFoam" if solver_params.force_transient else "simpleFoam",
            )
        outcome = CaseOutcome(
            spec=spec, reynolds=physics.reynolds(speed, chord, fluid.nu), n_cells=n_cells
        )
        try:
            if i == 0:
                res = _solve_cold_marched(
                    polar_dir, mesh_dir, airfoil, patches, resolved, spec, fluid, roughness,
                    rans_solver, runner, steady_timeout, outcome, n_proc=n_proc,
                    cancel_check=cancel_check, cache=cache,
                )
            else:
                res = _solve_warm(
                    polar_dir, spec, rans_solver, runner, steady_timeout, n_proc=n_proc,
                    cancel_check=cancel_check,
                )
            _check_cancel(cancel_check)
            if not res.ok:
                # Truthful divergence message beats the generic command tail.
                _raise_if_condemned(polar_dir)
            log = res.check().stdout
            (polar_dir / f"log.a{i}").write_text(log)
            conv = parse_convergence(log)
            outcome.converged = conv.converged
            # iterations relative to this segment (a warm continuation reports the
            # absolute time, so count the timesteps actually taken instead)
            outcome.iterations = log.count("\nTime = ") or conv.iterations
            outcome.final_residual = conv.final_residual
            _finalize_outcome(
                polar_dir, outcome, airfoil, resolved, spec, fluid, roughness, rans_solver,
                runner, n_proc, render_images, solver_timeout,
                transient_subdir=f"transient_a{i}", image_subdir=f"a{i}", shared_mesh_dir=mesh_dir,
                cancel_check=cancel_check,
                phase_progress=phase_progress,
                case_slug=f"{polar_dir.name}/a{i}",
                media_budget_s=media_budget_s,
            )
        except JobCancelled:
            raise
        except (OpenFOAMError, Exception) as exc:  # noqa: BLE001
            outcome.error = f"{type(exc).__name__}: {exc}"
        stored = StoredCaseOutcome(slug=polar_dir.name, outcome=outcome)
        attempts.append(stored)
        if outcome_progress:
            outcome_progress(stored, False)
        if progress:
            progress()
        _check_cancel(cancel_check)
        if not solver_params.force_transient and should_abort_rans_sweep_for_urans(aoa, outcome):
            reason = (
                f"RANS rejected at {aoa:g} deg inside the {RANS_CORE_ABORT_AOA_MIN:g}-"
                f"{RANS_CORE_ABORT_AOA_MAX:g} deg attached-range check; switching the whole polar to URANS."
            )
            remaining_progress = max(0, len(sorted_aoas) - len(attempts))
            urans_points = _run_full_urans_replacement(
                polar_dir,
                mesh_dir,
                airfoil,
                chord,
                speed,
                fluid,
                roughness,
                resolved,
                solver_params,
                mesher,
                runner,
                sorted_aoas,
                n_cells=n_cells,
                n_proc=n_proc,
                render_images=render_images,
                solver_timeout=solver_timeout,
                progress=progress,
                phase_progress=phase_progress,
                outcome_progress=outcome_progress,
                progress_budget=remaining_progress,
                cancel_check=cancel_check,
                media_budget_s=media_budget_s,
            )
            return PolarMarchResult(
                points=urans_points,
                attempts=attempts,
                promoted_to_urans=True,
                abort_reason=reason,
            )
        if not solver_params.force_transient and rans_outcome_rejected_for_polar(outcome):
            if not steady_outcome_shippable(outcome):
                # True crash (error set / no force data at all): evidence-only
                # attempt; the point is honestly ABSENT from the polar.
                continue
            # HONEST NON-CONVERGED (or otherwise rejected-with-data) POINT:
            # ship it with converged=false so the node-side ladder classifier
            # can reject + escalate. It never publishes a warm-start seed.
            final_points.append(stored)
            if outcome_progress:
                outcome_progress(stored, True)
            continue
        if not solver_params.force_transient:
            # Accepted steady point: its converged field becomes a cross-job seed.
            _publish_steady_seed(
                cache, polar_dir, airfoil, chord, resolved, spec, fluid, roughness, rans_solver,
            )
        final_points.append(stored)
        if outcome_progress:
            outcome_progress(stored, True)
    return PolarMarchResult(points=final_points, attempts=attempts)
