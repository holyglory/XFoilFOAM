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
from .models import CaseSpec, EvidenceArtifact, FluidProperties, JobPhase, MeshParams, RoughnessParams, SolverParams
from .openfoam.runner import OpenFOAMError, RunResult, Runner
from .postprocess.forces import (
    AveragedCoefficients,
    force_is_steady,
    parse_force_coefficients,
    parse_y_plus,
    time_averaged_coefficients,
)
from .postprocess.images import find_all_vtus, render_animation, render_contours, render_mean_contours, select_vtus
from .postprocess.residuals import parse_convergence
from .postprocess.unsteady import (
    ForceHistory,
    StablePeriodResult,
    force_history as compute_force_history,
    is_no_shedding,
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
URANS_STABLE_RETAINED_CYCLES = 2.0
URANS_MIN_FRAMES_PER_CYCLE = 20.0
URANS_ANIMATION_FRAMES = 141
URANS_MAX_ANIMATION_FRAMES = 220
URANS_EARLY_STOP_MARKER = "urans_early_stop.json"
#: Fraction of the per-attempt solver timeout the projected refined URANS pass
#: may consume; beyond this the refinement is skipped (it would deterministically
#: time out and burn hours of CPU) and the base window is graded honestly.
URANS_REFINE_BUDGET_FRACTION = 0.8


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


def _write_early_stop_marker(case_dir: Path, result: StablePeriodResult) -> None:
    (case_dir / URANS_EARLY_STOP_MARKER).write_text(
        json.dumps(
            {
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


def _make_urans_monitor(tcase: Path, spec: CaseSpec) -> Callable[[], None]:
    state: dict[str, object] = {"cadence_period": None, "target_period": None, "stop_requested": False}

    def monitor() -> None:
        coeff_files = _coeff_files(tcase)
        if not coeff_files:
            return
        result = stable_two_period_window(
            coeff_files[-1],
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
        if result.stable and period is not None and period > 0 and not result.ok:
            target_period = state.get("target_period")
            if target_period is None or abs(float(target_period) - period) / max(period, 1e-12) > 0.15:
                latest = _latest_time(tcase)
                _set_control_dict_entries(
                    tcase / "system" / "controlDict",
                    {
                        "endTime": latest + URANS_STABLE_RETAINED_CYCLES * period,
                        "runTimeModifiable": True,
                    },
                )
                state["target_period"] = period
        if result.ok and not state.get("stop_requested"):
            _write_early_stop_marker(tcase, result)
            _set_control_dict_entries(
                tcase / "system" / "controlDict",
                {"stopAt": "writeNow", "runTimeModifiable": True},
            )
            state["stop_requested"] = True

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
    runner.application(tcase, "potentialFoam -writephi -initialiseUBCs", timeout=600)
    _check_cancel(cancel_check)
    if solver_params.force_transient:
        return tmesh, patches
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
    cancel_check: CancelCheck = None,
) -> Optional[TransientResult]:
    _check_cancel(cancel_check)
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
        monitor=_make_urans_monitor(tcase, spec),
    )
    wall_seconds = max(0.0, time.monotonic() - solve_started)
    _check_cancel(cancel_check)
    if not res.ok:
        (tcase / "log.pimpleFoam").write_text(res.stdout)
        return None
    (tcase / "log.pimpleFoam").write_text(res.stdout)
    if n_proc > 1:
        if not runner.application(tcase, "reconstructPar -newTimes", timeout=timeout).ok:
            return None
        _check_cancel(cancel_check)
    files = _coeff_files(tcase)
    if not files:
        return None
    early_stop = _read_early_stop_marker(tcase)
    history: Optional[ForceHistory] = None
    history_discard = 0.0 if early_stop else solver_params.transient_discard_fraction
    target_cycles = int(URANS_STABLE_RETAINED_CYCLES) if early_stop else int(URANS_MIN_RETAINED_CYCLES)
    try:
        history = compute_force_history(
            files[-1],
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
            avg = time_averaged_coefficients(files[-1], solver_params.transient_discard_fraction)
    except Exception:  # noqa: BLE001 - no usable force rows
        return None
    quality = evaluate_urans_quality(
        tcase,
        history,
        spec.speed,
        spec.chord,
        min_cycles=URANS_STABLE_RETAINED_CYCLES if early_stop else URANS_MIN_RETAINED_CYCLES,
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
    )


def _run_transient(
    case_dir, airfoil, resolved, spec, fluid, roughness, solver_params, runner, n_proc, timeout,
    subdir="transient", shared_mesh_dir: Optional[Path] = None, cancel_check: CancelCheck = None,
):
    """Run URANS once, then automatically refine sparse/short transient media once."""
    tcase = case_dir / subdir
    try:
        tmesh, patches = _prepare_transient_case(
            tcase, airfoil, resolved, spec, fluid, roughness, solver_params, runner, n_proc, timeout,
            shared_mesh_dir=shared_mesh_dir,
            cancel_check=cancel_check,
        )
    except OpenFOAMError:
        return None

    initial_period = physics.shedding_period(spec.speed, spec.chord, strouhal=TRANSIENT_INITIAL_STROUHAL)
    initial_run_time = solver_params.transient_cycles * initial_period
    initial_delta_t = initial_period / 5000.0
    first = _run_transient_attempt(
        tcase, airfoil, tmesh, patches, spec, fluid, roughness, solver_params, runner, n_proc, timeout,
        run_time=initial_run_time, delta_t=initial_delta_t,
        cancel_check=cancel_check,
    )
    if first is None:
        return None
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
        cancel_check=cancel_check,
    )
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
    return "application/octet-stream"


def _artifact_kind_for_role(role: str) -> str:
    return role if role in {
        "vtk_window",
        "time_directory",
        "log",
        "force_coefficients",
        "mesh",
        "dictionary",
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
        "files": entries,
    }
    manifest_path = evidence_dir / "evidence_manifest.json"
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding="utf-8")

    bundle_path = evidence_dir / "openfoam_evidence.tar.gz"
    with tarfile.open(bundle_path, "w:gz") as tar:
        for child in sorted(evidence_dir.iterdir()):
            if child.name == bundle_path.name:
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
        artifacts.append(
            EvidenceArtifact(
                kind=_artifact_kind_for_role(role),
                path=str(path.relative_to(case_dir)),
                mime_type=_evidence_mime(path),
                sha256=str(entry["sha256"]),
                byte_size=int(entry["byteSize"]),
                role=role,
                metadata={
                    "evidenceBase": str(evidence_rel),
                    "manifestPath": str(manifest_path.relative_to(case_dir)),
                    "windowStart": start_time,
                    "windowEnd": end_time,
                },
            )
        )
    outcome.evidence_artifacts = artifacts


def _finalize_outcome(
    case_dir, outcome, airfoil, resolved, spec, fluid, roughness, solver_params,
    runner, n_proc, render_images, solver_timeout, transient_subdir="transient", image_subdir="",
    shared_mesh_dir: Optional[Path] = None, cancel_check: CancelCheck = None,
):
    """Parse forces, run the transient fallback if needed, compute y+ and images.

    ``image_subdir`` namespaces the output under the case dir (used to keep each
    marched AoA's artefacts separate within one polar directory).
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
    elif not solver_params.force_transient:
        raise OpenFOAMError("forceCoeffs produced no coefficient.dat")

    # transient (URANS) fallback for unsteady (e.g. post-stall) conditions
    post_dir = case_dir
    if solver_params.force_transient or (not outcome.converged and solver_params.transient_fallback):
        transient = _run_transient(
            case_dir, airfoil, resolved, spec, fluid, roughness, solver_params,
            runner, n_proc, solver_timeout, subdir=transient_subdir, shared_mesh_dir=shared_mesh_dir,
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
            post_dir = transient.case_dir
            outcome.force_history = transient.force_history
            if transient.force_history is not None and not transient.quality.no_shedding:
                outcome.strouhal = transient.force_history.strouhal
            if not transient.quality.ok:
                outcome.quality_warnings.append(transient.quality.reason)
        elif not coeff_files:
            raise OpenFOAMError("URANS transient produced no coefficient.dat")

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
    requested_fields = [field.value if hasattr(field, "value") else str(field) for field in solver_params.write_images]
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
            # Convert the transient fields; mean/animation use the retained measured
            # shedding window so dense refined runs become readable media.
            runner.application(post_dir, "foamToVTK").check()
            _check_cancel(cancel_check)
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
            for fld in fields:
                try:
                    name = render_animation(
                        post_dir, img_out, airfoil.contour, spec.chord, fld,
                        freestream_speed=spec.speed, zoom_chords=solver_params.image_zoom_chords,
                        max_frames=min(URANS_ANIMATION_FRAMES, URANS_MAX_ANIMATION_FRAMES),
                        start_time=media_start_time,
                        end_time=media_end_time,
                        title_suffix=suffix,
                    )
                except Exception as exc:  # noqa: BLE001 - media is degradation, not failure
                    logger.warning(
                        "URANS animation render failed for %s field %s: %s",
                        case_dir, fld.value, exc, exc_info=True,
                    )
                    outcome.quality_warnings.append(f"animation render failed ({fld.value}): {exc}")
                    continue
                if name:
                    vids[fld.value] = f"{prefix}images/{name}"
            outcome.video = vids
        else:
            runner.application(post_dir, "foamToVTK -latestTime").check()
            _check_cancel(cancel_check)
            imgs = render_contours(
                post_dir, img_out, airfoil.contour, spec.chord, fields,
                zoom_chords=solver_params.image_zoom_chords, title_suffix=suffix,
                freestream_speed=spec.speed,
            )
            outcome.images = {k: f"{prefix}images/{v}" for k, v in imgs.items()}

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
        if not solver_params.force_transient:
            res = solve_once(steady_solver_params)
            if not res.ok and steady_solver_params.momentum_scheme != "upwind":
                outcome.first_order_fallback = True
                res = solve_once(steady_solver_params.model_copy(update={"momentum_scheme": "upwind"}))
            log = res.check().stdout
            (case_dir / "log.simpleFoam").write_text(log)
            conv = parse_convergence(log)
            outcome.converged = conv.converged
            outcome.iterations = conv.iterations
            outcome.final_residual = conv.final_residual
        else:
            write_case(solver_params)

        _finalize_outcome(
            case_dir, outcome, airfoil, resolved, spec, fluid, roughness, solver_params,
            runner, n_proc, render_images, solver_timeout, shared_mesh_dir=mesh_dir,
            cancel_check=cancel_check,
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
    if solver_params.force_transient or rans_max_iterations is None:
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
    cache: Optional[EngineCache] = None,
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
        rans_solver = _steady_rans_params(rans_solver, rans_max_iterations)
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
            )
            return PolarMarchResult(
                points=urans_points,
                attempts=attempts,
                promoted_to_urans=True,
                abort_reason=reason,
            )
        if not solver_params.force_transient and rans_outcome_rejected_for_polar(outcome):
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
