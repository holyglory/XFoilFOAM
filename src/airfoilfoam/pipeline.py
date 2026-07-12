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
from .airfoil import Airfoil, max_concave_curvature
from .cache import EngineCache, SeedHit
from .case.builder import CaseBuilder
from .cancellation import JobCancelled
from .meshing.base import Mesher, MeshResult, get_mesher
from .models import (
    FRAME_IMAGE_ARTIFACT_KIND,
    PRECALC_WALLFN_MAX_CONCAVE_CURVATURE,
    CaseSpec,
    EvidenceArtifact,
    FailureDisposition,
    FluidProperties,
    FrameChannelStats,
    FrameSample,
    FrameTrack,
    FrameTrackStats,
    FrameTrackWindow,
    JobPhase,
    MeshParams,
    RansFailurePolicy,
    RansPrecalcPromotion,
    RoughnessParams,
    SolverParams,
    SteadyHistory,
    SteadyHistoryWindow,
    UransFidelity,
    apply_urans_fidelity,
    derive_precalc_resolved_wall_mesh_params,
    effective_mesh_params,
    urans_budget_seconds,
    urans_point_fidelity,
)
from .openfoam.runner import (
    CommandTimeoutError,
    DeterministicMeshError,
    HardSolverError,
    InfrastructureError,
    OpenFOAMError,
    RunResult,
    Runner,
)
from .postprocess.forces import (
    AveragedCoefficients,
    analyze_steady_oscillation,
    force_is_steady,
    parse_force_coefficients,
    parse_y_plus,
    time_averaged_coefficients,
)
from .postprocess.images import (
    available_vtu_times,
    find_all_vtus,
    render_animations,
    render_contours,
    render_frame_track_images,
    render_mean_contours,
    select_vtus,
)
from .postprocess.residuals import parse_convergence
from .postprocess.unsteady import (
    PERIOD_AMBIGUITY_TOLERANCE,
    PERIOD_ESTIMATE_MIN_CYCLES,
    SHEDDING_STROUHAL_BAND,
    ChannelWindowStats,
    ForceHistory,
    PeriodEstimate,
    PeriodWindowStats,
    StablePeriodResult,
    coefficient_series,
    discard_startup,
    estimate_period,
    force_history as compute_force_history,
    frame_coefficients,
    frame_target_times,
    is_no_shedding,
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
    failure_disposition: FailureDisposition = FailureDisposition.none
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
    precalc_promotion: Optional[RansPrecalcPromotion] = None


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


class TransientTimeoutError(CommandTimeoutError):
    """A transient solver run killed by the wall-clock timeout that left no
    gradable coefficient window in the CURRENT chunk. Distinct from a crash:
    the case dir keeps its last written fields, so the saved state stays
    restartable (continuation catch sites mark the grade continuable)."""


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
        raise HardSolverError(reason)


def _checked_solver_result(case_dir: Path, result: RunResult) -> RunResult:
    """Check one solver result while preserving machine-readable provenance.

    ``RunResult.timed_out`` is authoritative execution evidence and is checked
    before a possibly stale divergence marker.  A non-timeout solver exit is a
    hard numerical failure only after the watchdog marker (when present) has
    supplied its precise reason.  No display-string parsing participates in
    this classification.
    """
    if getattr(result, "timed_out", False):
        # RunResult.check raises CommandTimeoutError from the typed flag.
        result.check()
    if not result.ok:
        _raise_if_condemned(case_dir)
        try:
            result.check()
        except InfrastructureError:
            raise
        except OpenFOAMError as exc:
            # A generic non-zero launcher/solver exit does not prove an
            # aerodynamic failure. OpenMPI admission, container/runtime,
            # filesystem and executable failures commonly return the same
            # code as an OpenFOAM numerical abort. Only the typed watchdog
            # condemnation above may widen a polar; ambiguous exits fail
            # closed into the infrastructure retry path.
            raise InfrastructureError(str(exc)) from exc
    return result.check()


def _record_outcome_failure(outcome: CaseOutcome, exc: BaseException) -> None:
    """Persist error text and structured provenance on a case outcome."""
    if isinstance(exc, DeterministicMeshError):
        disposition = FailureDisposition.deterministic_mesh
    elif isinstance(exc, InfrastructureError) or isinstance(exc, (TimeoutError, OSError)):
        disposition = FailureDisposition.infrastructure
    elif isinstance(exc, HardSolverError):
        disposition = FailureDisposition.hard_solver
    else:
        # Unknown application/runtime exceptions are not aerodynamic evidence.
        # They remain infrastructure until a narrower typed source proves
        # otherwise; this is intentionally fail-closed for URANS promotion.
        disposition = FailureDisposition.infrastructure
    outcome.failure_disposition = disposition
    outcome.error = f"{type(exc).__name__}: {exc}"


def _record_unexceptional_rans_rejection(outcome: CaseOutcome) -> None:
    """Classify data-backed RANS rejection that did not throw an exception."""
    if (
        outcome.failure_disposition == FailureDisposition.none
        and outcome.error is None
        and rans_outcome_rejected_for_polar(outcome)
    ):
        outcome.failure_disposition = FailureDisposition.hard_solver


# --------------------------------------------------------------------------- #
# March-rate guard markers (in-chunk hopeless-march early stop).
#
# Prod 2026-07-09 (job 571efe9f, s1223 c1 u50 @ Re 3.4M): a precalc transient
# reached t=0.0094 s of 0.4 s in the FULL 7200 s budget (~85 h projected).
# With no shedding cycle completed there is no measurable period, so the
# between-chunks budget projection guard can never engage — the run burns the
# whole wall budget blind. The heartbeat thread's march-rate watchdog
# (tasks.MarchRateWatchdog) projects the TRAILING simulated-time rate against
# the chunk target and stops provably hopeless marches early, leaving
# restartable state — graded through the same honest timeout path (continuable
# budget-stop), NOT the divergence path (whose partial window is garbage).
# --------------------------------------------------------------------------- #

#: Written by the pipeline before every pimpleFoam chunk launch: the chunk's
#: simulated-time target, its wall budget, and the launch wall-clock instant.
#: Its presence is what arms the heartbeat march-rate watchdog for a case.
MARCH_BUDGET_MARKER_FILENAME = "march_budget.json"

#: Written by the march-rate watchdog when it stops a hopeless march; read by
#: the grading path to grade the partial window as a continuable budget stop.
MARCH_STOP_MARKER_FILENAME = "march_stopped.json"


def write_march_budget_marker(case_dir: Path, end_t: float, budget_s: float, wall_start: float) -> None:
    """Arm the march-rate watchdog for the chunk about to launch."""
    case_dir.mkdir(parents=True, exist_ok=True)
    path = case_dir / MARCH_BUDGET_MARKER_FILENAME
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(
        json.dumps(
            {"end_t": float(end_t), "budget_s": float(budget_s), "wall_start": float(wall_start)},
            indent=2,
        )
        + "\n"
    )
    os.replace(tmp, path)


def update_march_budget_target(case_dir: Path, end_t: float) -> bool:
    """Keep the live watchdog target aligned with a monitor-extended chunk.

    The early-stop monitor may extend ``controlDict.endTime`` after measuring a
    real period.  Preserve the armed chunk's original ``wall_start`` and
    ``budget_s`` (therefore its original wall deadline) while atomically moving
    only the simulated-time target.  Without this update the watchdog disarms
    as soon as the solver crosses the stale original target, even though
    pimpleFoam is still marching toward the longer controller-owned horizon.
    """
    marker = read_march_budget_marker(case_dir)
    if marker is None:
        return False
    write_march_budget_marker(
        case_dir,
        end_t=float(end_t),
        budget_s=marker["budget_s"],
        wall_start=marker["wall_start"],
    )
    return True


def read_march_budget_marker(case_dir: Path) -> Optional[dict]:
    """The armed chunk's {end_t, budget_s, wall_start}, or None."""
    try:
        payload = json.loads((case_dir / MARCH_BUDGET_MARKER_FILENAME).read_text())
    except (OSError, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    out = {}
    for key in ("end_t", "budget_s", "wall_start"):
        value = payload.get(key)
        if not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            return None
        out[key] = float(value)
    return out


def write_march_stop(case_dir: Path, reason: str) -> None:
    """Persist the march-rate watchdog's truthful early-stop for grading."""
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / MARCH_STOP_MARKER_FILENAME).write_text(
        json.dumps({"reason": reason, "stopped_at": time.time()}, indent=2) + "\n"
    )


def read_march_stop(case_dir: Path) -> Optional[str]:
    """The march-rate watchdog's early-stop reason for this case, or None."""
    try:
        payload = json.loads((case_dir / MARCH_STOP_MARKER_FILENAME).read_text())
    except (OSError, ValueError):
        return None
    reason = payload.get("reason") if isinstance(payload, dict) else None
    return str(reason) if reason else None


def clear_march_markers(case_dir: Path) -> None:
    """Disarm the guard and drop a stale stop verdict before a fresh chunk."""
    for name in (MARCH_BUDGET_MARKER_FILENAME, MARCH_STOP_MARKER_FILENAME):
        try:
            (case_dir / name).unlink()
        except OSError:
            pass


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


def _concavity_disclosure(prefix: str, curvature: float) -> str:
    return (
        f"{prefix} ran the resolved-wall mesh: concave geometry "
        f"(max concave curvature {curvature:.2f}/c) folds the wall-function layer"
    )


def _user_defined_mesh_disclosure(fidelity: UransFidelity) -> str:
    if fidelity == UransFidelity.precalc:
        return "precalc URANS tier runs a user-defined precalc mesh"
    return "full URANS tier runs a user-defined mesh"


def _full_wall_function_mesh_disclosure() -> str:
    return "full URANS tier uses a wall-function mesh (y+~40) derived from the RANS mesh profile"


def _airfoil_max_concave_curvature(airfoil) -> float:
    contour = getattr(airfoil, "contour", None)
    if contour is None:
        return 0.0
    try:
        return max_concave_curvature(contour)
    except Exception as exc:  # noqa: BLE001 - geometry guard must never block meshing
        logger.warning("failed to measure airfoil concavity for mesh guard: %s", exc)
        return 0.0


def effective_mesh_params_for_airfoil(
    mesh: MeshParams,
    solver: SolverParams,
    airfoil,
    urans_mesh: Optional[MeshParams] = None,
    urans_precalc_mesh: Optional[MeshParams] = None,
) -> tuple[MeshParams, list[str]]:
    """Effective mesh params plus any disclosure warnings with geometry available."""
    if not solver.force_transient:
        return mesh, []

    if solver.urans_fidelity == UransFidelity.precalc and urans_precalc_mesh is not None:
        return urans_precalc_mesh, [_user_defined_mesh_disclosure(UransFidelity.precalc)]
    if solver.urans_fidelity == UransFidelity.full and urans_mesh is not None:
        return urans_mesh, [_user_defined_mesh_disclosure(UransFidelity.full)]

    derived = effective_mesh_params(mesh, solver)
    if abs(derived.target_y_plus - TRANSIENT_WALL_YPLUS) > 1e-9:
        return derived, []
    curvature = _airfoil_max_concave_curvature(airfoil)
    if curvature <= PRECALC_WALLFN_MAX_CONCAVE_CURVATURE:
        if solver.urans_fidelity == UransFidelity.full:
            return derived, [_full_wall_function_mesh_disclosure()]
        return derived, []
    if solver.urans_fidelity == UransFidelity.precalc:
        guarded = derive_precalc_resolved_wall_mesh_params(mesh)
        prefix = "precalc"
    else:
        guarded = mesh
        prefix = "full URANS tier"
    warning = _concavity_disclosure(prefix, curvature)
    logger.warning(
        "%s mesh uses resolved-wall spacing for concave airfoil %s: "
        "max concave curvature %.2f/c > %.2f/c",
        prefix,
        getattr(airfoil, "name", "<unknown>"),
        curvature,
        PRECALC_WALLFN_MAX_CONCAVE_CURVATURE,
    )
    return guarded, [warning]


def _standalone_transient_mesh_params(
    resolved: MeshParams,
    airfoil,
    spec: CaseSpec,
    fluid: FluidProperties,
    solver_params: SolverParams,
    urans_mesh: Optional[MeshParams] = None,
    urans_precalc_mesh: Optional[MeshParams] = None,
) -> tuple[MeshParams, list[str]]:
    if solver_params.urans_fidelity == UransFidelity.precalc and urans_precalc_mesh is not None:
        return (
            resolve_mesh_params(urans_precalc_mesh, spec, fluid),
            [_user_defined_mesh_disclosure(UransFidelity.precalc)],
        )
    if solver_params.urans_fidelity == UransFidelity.full and urans_mesh is not None:
        return (
            resolve_mesh_params(urans_mesh, spec, fluid),
            [_user_defined_mesh_disclosure(UransFidelity.full)],
        )
    if solver_params.force_transient:
        return resolved, []

    curvature = _airfoil_max_concave_curvature(airfoil)
    if curvature > PRECALC_WALLFN_MAX_CONCAVE_CURVATURE:
        warning = _concavity_disclosure("transient", curvature)
        logger.warning(
            "standalone transient mesh uses resolved-wall spacing for concave airfoil %s: "
            "max concave curvature %.2f/c > %.2f/c",
            getattr(airfoil, "name", "<unknown>"),
            curvature,
            PRECALC_WALLFN_MAX_CONCAVE_CURVATURE,
        )
        return resolved, [warning]
    h = physics.first_cell_height_for_yplus(TRANSIENT_WALL_YPLUS, spec.speed, spec.chord, fluid.nu)
    return (
        resolved.model_copy(
            update={
                "first_cell_height_chords": h / spec.chord,
                "n_surface": min(resolved.n_surface, 90),
                "n_radial": min(resolved.n_radial, 56),
                "n_wake": min(resolved.n_wake, 50),
                "farfield_radius_chords": min(resolved.farfield_radius_chords, 12.0),
                "wake_length_chords": min(resolved.wake_length_chords, 10.0),
            }
        ),
        [],
    )


@dataclass(frozen=True)
class MeshQaResult:
    max_non_ortho_deg: Optional[float] = None
    failed_checks: int = 0
    negative_volume: bool = False
    #: Every failed check is benign wall-layer anisotropy (checkMesh's
    #: "***High aspect ratio cells found" heuristic). High-AR cells are the
    #: NORMAL shape of a boundary-layer mesh at high Re (prod false positive
    #: 2026-07-11: sd8020 c1.0 u100, AR 4871, non-ortho only 72.4 deg — the
    #: transient p/pFinal smoother was hardened for exactly this anisotropy),
    #: so an aspect-ratio-ONLY failure is a disclosure, not a fatal verdict.
    aspect_ratio_only_failure: bool = False
    max_aspect_ratio: Optional[float] = None
    high_aspect_cells: Optional[int] = None


_CHECKMESH_NON_ORTHO_RE = re.compile(
    r"Mesh\s+non-orthogonality\s+Max:\s*([0-9.+\-eE]+)", re.IGNORECASE
)
_CHECKMESH_FAILED_RE = re.compile(r"Failed\s+([1-9]\d*)\s+mesh\s+checks?", re.IGNORECASE)
# checkMesh marks each FAILED check with a leading "***" line; single-star
# lines are advisories that did not fail the check.
_CHECKMESH_FAILLINE_RE = re.compile(r"^\s*\*\*\*(.+)$", re.MULTILINE)
_CHECKMESH_ASPECT_RE = re.compile(
    r"High aspect ratio cells found,\s*Max aspect ratio:\s*([0-9.+\-eE]+),\s*number of cells\s+(\d+)",
    re.IGNORECASE,
)


def _parse_check_mesh_output(output: str) -> MeshQaResult:
    max_non_ortho: Optional[float] = None
    match = _CHECKMESH_NON_ORTHO_RE.search(output)
    if match:
        try:
            max_non_ortho = float(match.group(1))
        except ValueError:
            max_non_ortho = None
    failed_checks = 0
    failed = _CHECKMESH_FAILED_RE.search(output)
    if failed:
        try:
            failed_checks = int(failed.group(1))
        except ValueError:
            failed_checks = 0
    lower = output.lower()
    negative_volume = "negative volume" in lower or "negative cell volume" in lower
    fail_lines = _CHECKMESH_FAILLINE_RE.findall(output)
    aspect_lines = [line for line in fail_lines if "high aspect ratio" in line.lower()]
    aspect_only = bool(failed_checks) and bool(fail_lines) and len(aspect_lines) == len(fail_lines)
    max_aspect: Optional[float] = None
    high_cells: Optional[int] = None
    aspect_match = _CHECKMESH_ASPECT_RE.search(output)
    if aspect_match:
        try:
            max_aspect = float(aspect_match.group(1))
            high_cells = int(aspect_match.group(2))
        except ValueError:
            max_aspect = None
            high_cells = None
    return MeshQaResult(
        max_non_ortho_deg=max_non_ortho,
        failed_checks=failed_checks,
        negative_volume=negative_volume,
        aspect_ratio_only_failure=aspect_only,
        max_aspect_ratio=max_aspect,
        high_aspect_cells=high_cells,
    )


def _run_transient_mesh_qa_gate(
    case_dir: Path, runner: Runner, quality_warnings: Optional[list[str]] = None
) -> None:
    try:
        result = runner.application(case_dir, "checkMesh -time 0", timeout=MESH_CHECK_TIMEOUT_S)
    except Exception as exc:  # noqa: BLE001 - inability to run the advisory gate is non-fatal
        logger.warning("checkMesh gate could not run for %s: %s", case_dir, exc)
        return
    output = getattr(result, "stdout", "") or ""
    try:
        (case_dir / "log.checkMesh").write_text(output)
    except OSError:
        logger.warning("could not write checkMesh log for %s", case_dir)
    qa = _parse_check_mesh_output(output)
    reasons: list[str] = []
    if qa.max_non_ortho_deg is not None and qa.max_non_ortho_deg > MESH_MAX_NON_ORTHO_DEG:
        reasons.append(
            f"checkMesh max non-orthogonality exceeds {MESH_MAX_NON_ORTHO_DEG:.1f} deg"
        )
    if qa.failed_checks > 0 and not qa.aspect_ratio_only_failure:
        reasons.append(f"checkMesh reported Failed {qa.failed_checks} mesh checks")
    if qa.negative_volume:
        reasons.append("checkMesh reported negative-volume cells")
    if reasons:
        if qa.max_non_ortho_deg is not None:
            prefix = (
                "mesh degenerate at this fidelity tier "
                f"(max non-orthogonality {qa.max_non_ortho_deg:.1f} deg): "
            )
        else:
            prefix = "mesh degenerate at this fidelity tier: "
        raise DeterministicMeshError(prefix + "; ".join(reasons) + "; see log.checkMesh")
    if qa.max_non_ortho_deg is None:
        logger.warning("checkMesh output for %s had no non-orthogonality summary; mesh QA gate skipped", case_dir)
        return
    if qa.failed_checks > 0 and qa.aspect_ratio_only_failure:
        ar = f"{qa.max_aspect_ratio:.0f}" if qa.max_aspect_ratio is not None else "unknown"
        cells = qa.high_aspect_cells if qa.high_aspect_cells is not None else "some"
        warning = (
            f"mesh quality warning: {cells} high-aspect-ratio wall cells (max aspect ratio {ar}) — "
            "checkMesh aspect-ratio heuristic waived: this is the normal anisotropy of a "
            "wall-function boundary layer at high Re, and the transient pressure solver is "
            "configured for it"
        )
        logger.warning("%s: %s", case_dir, warning)
        if quality_warnings is not None:
            quality_warnings.append(warning)
    if qa.max_non_ortho_deg > MESH_WARN_NON_ORTHO_DEG:
        warning = (
            f"mesh quality warning: max non-orthogonality {qa.max_non_ortho_deg:.1f} deg "
            f"at this fidelity tier (limit {MESH_MAX_NON_ORTHO_DEG:.1f} deg)"
        )
        logger.warning("%s: %s", case_dir, warning)
        if quality_warnings is not None:
            quality_warnings.append(warning)


TRANSIENT_WALL_YPLUS = 40.0  # wall-function y+ for transient mesh; mirrors models.URANS_PRECALC_WALL_YPLUS
MESH_MAX_NON_ORTHO_DEG = 85.0
MESH_WARN_NON_ORTHO_DEG = 75.0
MESH_CHECK_TIMEOUT_S = 300
TRANSIENT_INIT_ITERS = 600  # short steady init before the transient
TRANSIENT_INITIAL_STROUHAL = 0.5
# Prod s1223 jobs 7ff36caf/0cba5e9b on the y+40 precalc mesh showed the fresh
# startup dt ramp growing 1.2x/step toward the new Courant-4 ceiling before the
# separated flow was developed, then blowing up. Keep only the FIRST fresh chunk
# at roughly Co <= 1 (dt <= 2x the Strouhal period/5000 guess); resumed,
# extension, and refined chunks use their measured-period cadence/caps.
STARTUP_MAX_DELTA_T_FACTOR = 2.0
#: Extra span-retention (cycles) the extension loop targets past the whole-
#: cycle requirement: the quality gate counts INTEGER cycles, so breaking at a
#: fractional span-retention of exactly `target` leaves the gate one whole
#: cycle short (prod naca-4412 −15° u=100: span ~2.8 graded as 2.00 < 3.00).
RETENTION_SAFETY_CYCLES = 0.6
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
#: Field-write cadence for URANS frame/media evidence. This is deliberately
#: denser than ``URANS_MIN_FRAMES_PER_CYCLE``: the latter is the cross-runtime
#: quality gate, while this controls how many real states the player can export.
URANS_FRAME_WRITE_PER_CYCLE = 30.0
URANS_ANIMATION_FRAMES = 141
URANS_MAX_ANIMATION_FRAMES = 220
URANS_EARLY_STOP_MARKER = "urans_early_stop.json"
#: A flat URANS signal is not enough evidence of physically steady flow until
#: the retained force history spans the slow edge of the plausible shedding
#: band.  Two periods are the minimum needed to distinguish a weak, slowly
#: emerging wake from a genuinely flat signal; the extra tenth period keeps
#: the evidence floor clear of an exact two-cycle edge verdict.
URANS_NO_SHEDDING_MIN_SLOW_PERIODS = 2.1
#: The acquisition controller overshoots the evidence floor by another tenth
#: of a slow period so
#: discrete coefficient sampling and startup-discard rounding cannot leave a
#: physically sufficient run a few samples short of acceptance.
URANS_PERIOD_ACQUISITION_SLOW_PERIODS = 2.2
#: Internal quality-reason marker for an amplitude-flat trace whose retained
#: observation has not yet crossed the physical slow-shedding horizon. The
#: established-oscillation grader must leave this state to the period-
#: acquisition controller; a spurious FFT line may not bypass the horizon.
URANS_APPARENT_FLAT_OBSERVATION_MARKER = "an apparently flat signal spans"
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


def _early_stop_retained_cycles(solver_params: Optional[SolverParams]) -> float:
    """Tier-owned accepted-cycle target used to grade an early stop.

    Precalc is deliberately the fast preliminary tier, so its established
    oscillation needs the tier-owned three whole periods.  Full fidelity keeps
    the existing five-period acceptance floor even though its ordinary
    non-early-stopped horizon is seven periods.
    """
    if (
        solver_params is not None
        and solver_params.urans_fidelity == UransFidelity.precalc
    ):
        return float(apply_urans_fidelity(solver_params).urans_min_periods)
    return URANS_STABLE_RETAINED_CYCLES


def _early_stop_certification_cycles(
    solver_params: Optional[SolverParams],
) -> float:
    """Total stable span required before the live monitor may stop.

    The accepted tier target still owns the force-history retention bar.  The
    live certification span additionally includes the existing stop margin and
    must contain enough data for the period estimator's two independent halves
    to meet their own cycle floor.  This is 4.0 periods for precalc and leaves
    full fidelity's existing 5.5-period span unchanged.
    """
    return max(
        _early_stop_retained_cycles(solver_params)
        + URANS_STABLE_STOP_MARGIN_CYCLES,
        2.0 * PERIOD_ESTIMATE_MIN_CYCLES,
    )


def _fresh_transient_cycles(solver_params: SolverParams) -> float:
    """Guessed-period horizon for the first fresh transient chunk.

    A precalc run should reach its three retained periods plus the existing
    whole-cycle margin, then let measured-period continuation take over.  Full
    fidelity intentionally preserves the configured ``transient_cycles``
    horizon.
    """
    if solver_params.urans_fidelity != UransFidelity.precalc:
        return float(solver_params.transient_cycles)
    target = float(apply_urans_fidelity(solver_params).urans_min_periods)
    retained_fraction = max(
        1e-6,
        1.0 - min(max(solver_params.transient_discard_fraction, 0.0), 0.95),
    )
    return (target + RETENTION_SAFETY_CYCLES) / retained_fraction


def _no_shedding_min_observation_s(speed: float, chord: float) -> float:
    """Retained time needed before URANS may certify a flat wake.

    The slow side of the physical shedding band is chord based (matching
    :func:`shedding_period_band`), so this horizon covers 2.1 complete cycles
    at ``St=SHEDDING_STROUHAL_BAND[0]``.  Callers validate positive case speed
    and chord before solving; an invalid value returns infinity so this safety
    gate fails closed if it is ever called outside that boundary.
    """
    try:
        u = float(speed)
        c = float(chord)
    except (TypeError, ValueError):
        return math.inf
    slow_st = float(SHEDDING_STROUHAL_BAND[0])
    if not (
        math.isfinite(u)
        and math.isfinite(c)
        and math.isfinite(slow_st)
        and u > 0
        and c > 0
        and slow_st > 0
    ):
        return math.inf
    return URANS_NO_SHEDDING_MIN_SLOW_PERIODS * c / (slow_st * u)


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


def _set_foam_dict_entries(dict_path: Path, entries: dict[str, object]) -> None:
    if not dict_path.exists():
        return
    text = dict_path.read_text()
    for key, value in entries.items():
        value_text = _foam_value(value)
        pattern = re.compile(rf"(^\s*{re.escape(key)}\s+)([^;]*)(;)", re.MULTILINE)
        replacement = rf"\g<1>{value_text}\3"
        if pattern.search(text):
            text = pattern.sub(replacement, text, count=1)
        else:
            text += f"\n{key:<16} {value_text};\n"
    dict_path.write_text(text)


def _set_control_dict_entries(control_dict: Path, entries: dict[str, object]) -> None:
    _set_foam_dict_entries(control_dict, entries)


def _sanitize_freestream_init_time_state(case_dir: Path, initial_delta_t: float) -> bool:
    """Reset a SIMPLE-init pseudo-time restart to the intended transient dt.

    OpenFOAM v2406 restores ``deltaT`` from ``latestTime/uniform/time`` before
    the first pimpleFoam step. A 600-iteration simpleFoam init writes pseudo-time
    ``deltaT 1``/``deltaT0 1``; for a 0.4 s startup span, Time::run sees
    ``600 < 600.4 - 0.5*1`` as false and exits after zero steps. The forensic
    fingerprint is the first Courant line exploding (mean 167 / max 31446) from
    an inherited 1 s step.
    """
    if not (case_dir / "log.simpleFoam.init").is_file():
        return False
    try:
        dt = float(initial_delta_t)
    except (TypeError, ValueError):
        return False
    if not math.isfinite(dt) or dt <= 0:
        return False
    latest = _latest_time_dir(case_dir)
    if latest is None:
        return False
    time_state = latest / "uniform" / "time"
    if not time_state.is_file():
        return False
    before = time_state.read_text()
    _set_foam_dict_entries(time_state, {"deltaT": dt, "deltaT0": dt})
    return time_state.read_text() != before


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


# --------------------------------------------------------------------------- #
# Cross-job URANS continuation (task: continue budget-stopped transients).
#
# A transient stopped by the wall-clock budget guard leaves its case dir
# intact on the shared volume (the timeout path never deletes state; latestTime
# fields stay written). A continuation job copies that saved case state into
# the new job's case dir, restarts pimpleFoam from latestTime with a fresh
# (usually increased) budget and merges the coefficient history across the job
# boundary — the SAME restart-segment mechanics the in-run continuation chunks
# already use (``_transient_coeff_selection`` keyed on the transient's start).
# --------------------------------------------------------------------------- #

#: Continuable-grade marker (pinned cross-runtime contract with
#: packages/core/src/urans-quality.ts URANS_BUDGET_STOP_MARKER, matched by the
#: node continuable predicate as a substring of quality warnings): every URANS
#: grading path that stops on WALL-CLOCK grounds while leaving restartable
#: saved case state — the between-chunks budget projection guard, the
#: mid-chunk solver timeout partial grade, and a timed-out continuation chunk
#: — must embed exactly this substring in its quality reason. Rewording it is
#: a test failure on BOTH sides (tests/test_continuation.py pins the literal
#: here; the node fixtures pin it there).
URANS_BUDGET_STOP_MARKER = "stopped by the wall-clock budget guard"

#: A different restartable outcome from a wall-budget stop: the bounded
#: in-process controller used all of its same-case chunks, but the measured
#: window still needs more integration.  The control plane matches this exact
#: marker so the saved state remains continuable; it must never be conflated
#: with ``URANS_BUDGET_STOP_MARKER`` because no wall-clock claim is being made.
URANS_CONTINUATION_REQUIRED_MARKER = "requires further same-case integration"

#: Marker persisted in a transient case dir recording the coefficient-history
#: start time of the transient (the steady-init history written before it must
#: never merge into the force signal). Written when a fresh transient starts;
#: continuation jobs read it to keep merging across jobs.
TRANSIENT_START_MARKER = "transient_start.json"

#: Top-level directories of a saved case that a continuation never needs:
#: derived media and evidence are rebuilt from scratch after the resumed
#: solve, VTK frames are re-converted by foamToVTK, and stale decompositions
#: are re-created by the runner's ``decomposePar -latestTime -force``.
CONTINUATION_SKIP_DIRS = frozenset({"evidence", "images", "frames", "VTK", "custom_renders", "_seed_stage"})


@dataclass
class TransientResume:
    """Resume a STAGED transient case across jobs: restart from latestTime and
    merge the coefficient history from the transient's original start time."""

    #: Original transient start (coefficient merge boundary across ALL segments).
    transient_start: float
    #: latestTime of the saved case at staging — this job's own integration
    #: starts here, so wall-rate projections must measure from this origin.
    resume_from: float


@dataclass
class ContinuationSource:
    """A staged continuation case: where the restartable transient lives."""

    transient_subdir: str
    transient_start: float
    resume_from: float


def write_transient_start_marker(tcase: Path, transient_start: float) -> None:
    tcase.mkdir(parents=True, exist_ok=True)
    (tcase / TRANSIENT_START_MARKER).write_text(
        json.dumps({"transient_start": float(transient_start)}, indent=2) + "\n"
    )


def read_transient_start_marker(tcase: Path) -> Optional[float]:
    try:
        payload = json.loads((tcase / TRANSIENT_START_MARKER).read_text())
    except (OSError, ValueError):
        return None
    value = payload.get("transient_start") if isinstance(payload, dict) else None
    if isinstance(value, (int, float)) and math.isfinite(float(value)):
        return float(value)
    return None


def _infer_transient_start(tcase: Path) -> float:
    """Recover the transient's start for saved cases predating the marker.

    Mechanics-faithful heuristic: a steady-seeded transient (warm start from
    the job's steady RANS field) starts at 0 with no in-case init log; an
    init-seeded transient ran a short simpleFoam init in the case first
    (``log.simpleFoam.init``), whose pseudo-time forceCoeffs segment sits at 0,
    so the transient owns the first POSITIVE segment."""
    seg_times = sorted({_time_of(f) for f in _coeff_files(tcase)})
    if (tcase / "log.simpleFoam.init").exists():
        positive = [t for t in seg_times if t > 0]
        if positive:
            return positive[0]
    return seg_times[0] if seg_times else 0.0


def _find_continuable_transient(src_case: Path) -> str:
    """The transient subdir of a saved case, or a truthful OpenFOAMError."""
    if (src_case / "transient").is_dir():
        return "transient"
    candidates = sorted(
        d.name
        for d in src_case.iterdir()
        if d.is_dir() and d.name.startswith("transient") and not d.name.endswith("_refined")
    )
    if len(candidates) == 1:
        return candidates[0]
    if not candidates:
        raise OpenFOAMError(
            f"saved case {src_case.name} has no transient directory to continue"
        )
    raise OpenFOAMError(
        f"saved case {src_case.name} has multiple transient directories "
        f"({', '.join(candidates)}); cannot disambiguate the continuation target"
    )


def _hardlinkable(rel: Path) -> bool:
    """Files safe to hardlink instead of copy: bulk data the resumed run only
    READS or supersedes with new directories — numeric time-dir fields and the
    polyMesh. Everything modified in place (system/ dicts via write_text /
    foamDictionary, log.* via write_text) or appended near-in-place
    (postProcessing segment reuse edge) gets a REAL copy."""
    parts = rel.parts
    if "postProcessing" in parts:
        # forceCoeffs/yPlus segment dirs are numeric-named; a restart landing
        # on an identical startTime would rewrite the file through a hardlink
        # and corrupt the source job's evidence. Always real-copy.
        return False
    if "polyMesh" in parts:
        return True
    for part in parts[:-1]:
        try:
            float(part)
        except ValueError:
            continue
        return True
    return False


def _copy_case_tree(src_case: Path, dst_case: Path) -> None:
    """Copy a saved case dir into the new job (hardlinking bulk data where
    safe, falling back to a real copy across devices). Follows symlinks so a
    shared-mesh polyMesh symlink materialises as real files; skips derived
    media/evidence dirs and stale divergence verdicts."""
    if dst_case.exists():
        shutil.rmtree(dst_case)
    dst_case.mkdir(parents=True, exist_ok=True)
    for root, dirs, files in os.walk(src_case, followlinks=True):
        rel_root = Path(root).relative_to(src_case)
        dirs[:] = sorted(
            d
            for d in dirs
            if d not in CONTINUATION_SKIP_DIRS and not d.startswith("processor")
        )
        dst_root = dst_case / rel_root
        dst_root.mkdir(parents=True, exist_ok=True)
        for name in sorted(files):
            # Stale verdicts/arming from the SOURCE job must never poison the
            # resumed run (the fresh chunk re-arms its own march budget).
            if name in (
                DIVERGENCE_MARKER_FILENAME,
                MARCH_BUDGET_MARKER_FILENAME,
                MARCH_STOP_MARKER_FILENAME,
            ):
                continue
            src = Path(root) / name
            if not src.is_file():
                continue  # dangling symlink etc.
            dst = dst_root / name
            if _hardlinkable(rel_root / name):
                try:
                    os.link(src, dst)
                    continue
                except OSError:
                    pass  # cross-device or FS without hardlinks: real copy below
            shutil.copy2(src, dst, follow_symlinks=True)


def stage_continuation_case(src_case: Path, dst_case: Path) -> ContinuationSource:
    """Validate + copy a prior job's saved case for continuation.

    Raises a truthful ``OpenFOAMError`` when the source is missing, cleaned,
    or not restartable (no latestTime fields / no mesh / no controlDict) —
    the caller fails the job honestly instead of solving from nothing."""
    if not src_case.is_dir():
        raise OpenFOAMError(
            f"continuation source case directory not found: {src_case} "
            f"(job files cleaned from the engine volume, or wrong job id/slug)"
        )
    transient_subdir = _find_continuable_transient(src_case)
    src_t = src_case / transient_subdir
    latest = _latest_time_dir(src_t)
    if latest is None:
        raise OpenFOAMError(
            f"saved transient {src_case.name}/{transient_subdir} has no time directories; "
            f"nothing to restart from"
        )
    missing_fields = [name for name in ("U", "p") if not (latest / name).is_file()]
    if missing_fields:
        raise OpenFOAMError(
            f"saved transient {src_case.name}/{transient_subdir} latestTime {latest.name} "
            f"is missing fields {', '.join(missing_fields)}; not restartable"
        )
    if not (src_t / "system" / "controlDict").is_file():
        raise OpenFOAMError(
            f"saved transient {src_case.name}/{transient_subdir} has no system/controlDict; "
            f"not restartable"
        )
    if not (src_t / "constant" / "polyMesh" / "points").exists():
        raise OpenFOAMError(
            f"saved transient {src_case.name}/{transient_subdir} mesh is missing "
            f"(constant/polyMesh cleaned or its shared-mesh symlink dangles); not restartable"
        )
    _copy_case_tree(src_case, dst_case)
    dst_t = dst_case / transient_subdir
    transient_start = read_transient_start_marker(dst_t)
    if transient_start is None:
        transient_start = _infer_transient_start(dst_t)
        write_transient_start_marker(dst_t, transient_start)
        logger.warning(
            "continuation: %s has no %s marker; inferred transient start t=%g from the "
            "segment layout",
            src_t,
            TRANSIENT_START_MARKER,
            transient_start,
        )
    resume_from = _latest_time(dst_t)
    logger.warning(
        "continuation: staged saved case %s -> %s (transient %s, start t=%g, resume from "
        "latestTime t=%g)",
        src_case,
        dst_case,
        transient_subdir,
        transient_start,
        resume_from,
    )
    return ContinuationSource(
        transient_subdir=transient_subdir,
        transient_start=transient_start,
        resume_from=resume_from,
    )


def _make_urans_monitor(
    tcase: Path,
    spec: CaseSpec,
    coeff_start_time: Optional[float] = None,
    *,
    solver_params: Optional[SolverParams] = None,
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
            alpha_deg=spec.aoa_deg,
            frame_times=_numeric_time_dirs(tcase),
            discard_fraction=0.0,
            min_frames_per_cycle=URANS_MIN_FRAMES_PER_CYCLE,
        )
        period = result.period_s
        if period is not None and period > 0 and math.isfinite(period):
            previous = state.get("cadence_period")
            if previous is None or abs(float(previous) - period) / max(period, 1e-12) > 0.15:
                write_interval = period / URANS_FRAME_WRITE_PER_CYCLE
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
            # first stable two-period window. The stop only fires once both the
            # tier target (+ margin) and the period estimator's independent-half
            # evidence floor are present — never at bare detection, which kept
            # startup-adjacent periods and was rejected downstream.
            stable_since = state.get("stable_since")
            if stable_since is None and result.window_start is not None:
                stable_since = float(result.window_start)
                state["stable_since"] = stable_since
            if stable_since is not None:
                required_end = float(stable_since) + (
                    _early_stop_certification_cycles(solver_params) * period
                )
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
                        extended_end = max(required_end, latest + period)
                        _set_control_dict_entries(
                            tcase / "system" / "controlDict",
                            {
                                "endTime": extended_end,
                                "runTimeModifiable": True,
                            },
                        )
                        update_march_budget_target(tcase, extended_end)
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
    min_no_shedding_observation_s: Optional[float] = None,
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
        retained_span = max(0.0, retained_end - retained_start)
        if min_no_shedding_observation_s is None:
            required_span = _no_shedding_min_observation_s(speed, chord)
        else:
            try:
                required_span = float(min_no_shedding_observation_s)
            except (TypeError, ValueError):
                required_span = math.inf
        if (
            not math.isfinite(required_span)
            or required_span < 0
            or retained_span + 1e-9 < required_span
        ):
            return UransQuality(
                ok=False,
                can_refine=False,
                no_shedding=False,
                reason=(
                    "URANS quality could not be measured: "
                    f"{URANS_APPARENT_FLAT_OBSERVATION_MARKER} "
                    f"{retained_span:.6g}s, below the physical "
                    f"slow-shedding observation horizon {required_span:.6g}s."
                ),
                measured_period_s=None,
                retained_cycles=0.0,
                retained_frame_count=_field_frame_count(
                    case_dir, retained_start, retained_end
                ),
                frames_per_cycle=0.0,
                retained_start_time=retained_start,
                retained_end_time=retained_end,
            )
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


def _precalc_stationarity_unavailable(
    quality: UransQuality,
    detail: str,
    *,
    period_s: Optional[float] = None,
    allow_continuation: bool = True,
) -> UransQuality:
    """Fail a mandatory precalc stationarity grade closed.

    Preserve the force-history measurements, but authorize a corrective
    same-case chunk only when a real measured period can size its cadence.
    Full fidelity never reaches this helper.
    """
    valid_period = next(
        (
            float(candidate)
            for candidate in (period_s, quality.measured_period_s)
            if candidate is not None
            and math.isfinite(candidate)
            and candidate > 0
        ),
        None,
    )
    reason = (
        "URANS established-oscillation stationarity verdict unavailable: "
        f"{detail}"
    )
    if quality.reason:
        reason = f"{reason}; prior force-history grade: {quality.reason}"
    return UransQuality(
        ok=False,
        can_refine=allow_continuation and valid_period is not None,
        reason=reason,
        measured_period_s=valid_period,
        retained_cycles=quality.retained_cycles,
        retained_frame_count=quality.retained_frame_count,
        frames_per_cycle=quality.frames_per_cycle,
        retained_start_time=quality.retained_start_time,
        retained_end_time=quality.retained_end_time,
        no_shedding=quality.no_shedding,
    )


def _grade_precalc_established_oscillation(
    case_dir: Path,
    coeff_paths: list[Path],
    spec: CaseSpec,
    solver_params: SolverParams,
    quality: UransQuality,
    *,
    early_stopped: bool,
) -> UransQuality:
    """Apply the final precalc stationarity contract while continuation is live.

    Previously ``_run_transient_attempt`` accepted any dense three-period
    signal, and the established-oscillation verdict was discovered only during
    ``_finalize_outcome`` — after the controller had lost its opportunity to
    keep integrating the same case.  Reuse the exact ``period_window_stats``
    gate here so sparse or still-relaxing windows feed the continuation loop.
    """
    if (
        solver_params.urans_fidelity != UransFidelity.precalc
        or quality.no_shedding
        or URANS_APPARENT_FLAT_OBSERVATION_MARKER in quality.reason.lower()
    ):
        # An amplitude-flat trace below the physical observation floor belongs
        # to guessed-period acquisition. Re-running spectral stationarity here
        # could find a tiny in-band numerical ripple and wrongly bypass that
        # floor as an established oscillation.
        return quality
    if not coeff_paths:
        return _precalc_stationarity_unavailable(
            quality,
            "coefficient evidence is missing",
            allow_continuation=False,
        )
    period: Optional[float] = quality.measured_period_s
    try:
        t_all, cl_all, cd_all, cm_all = coefficient_series(coeff_paths)
        if early_stopped:
            t_c, cl_c, cd_c, cm_c = _early_stop_retained_series(
                case_dir, t_all, cl_all, cd_all, cm_all
            )
        else:
            t_c, cl_c, cd_c, cm_c = discard_startup(
                t_all,
                cl_all,
                cd_all,
                cm_all,
                fraction=solver_params.transient_discard_fraction,
            )
        estimate = estimate_period(
            t_c,
            cl_c,
            speed=spec.speed,
            chord=spec.chord,
            alpha_deg=spec.aoa_deg,
        )
        if estimate is None:
            # `quality.measured_period_s` is the looser FFT-derived history
            # value. It may size a corrective chunk, but it is not a
            # corroborated period and must never be promoted to a stable
            # established-oscillation verdict.
            return _precalc_stationarity_unavailable(
                quality,
                "no corroborated shedding period",
                period_s=quality.measured_period_s,
            )
        period = estimate.period_s
        if period is None or not math.isfinite(period) or period <= 0:
            return _precalc_stationarity_unavailable(
                quality,
                "no valid shedding period",
                period_s=period,
                allow_continuation=False,
            )
        stats = period_window_stats(
            t_c,
            cl_c,
            cd_c,
            cm_c,
            period,
            drift_tolerance=solver_params.urans_drift_tolerance,
            established_oscillation=True,
            period_stable=not estimate.ambiguous,
        )
    except Exception as exc:  # noqa: BLE001 - fail closed; log retains the diagnostic
        logger.warning(
            "precalc established-oscillation grading failed for %s",
            case_dir,
            exc_info=True,
        )
        return _precalc_stationarity_unavailable(
            quality,
            f"grading error ({type(exc).__name__})",
            period_s=period,
        )
    if stats is None:
        return _precalc_stationarity_unavailable(
            quality,
            "no whole-period statistics",
            period_s=period,
        )

    retained_cycles = float(stats.whole_periods)
    # Media is published from exactly the last min(3, K) whole periods (see
    # frame_target_times in _finalize_outcome). Grade that same real-evidence
    # window: sparse startup states outside the published player must not
    # permanently dilute a dense, usable tail.
    frame_cycles = float(min(URANS_FRAME_SPAN_PERIODS, stats.whole_periods))
    frame_start = stats.window_end - frame_cycles * stats.period_s
    frame_count = _field_frame_count(case_dir, frame_start, stats.window_end)
    frames_per_cycle = frame_count / frame_cycles if frame_cycles > 0 else 0.0
    target = float(apply_urans_fidelity(solver_params).urans_min_periods)
    eps = 1e-9
    too_short = retained_cycles + eps < target
    too_sparse = frames_per_cycle + eps < URANS_MIN_FRAMES_PER_CYCLE
    parts: list[str] = []
    if too_short:
        parts.append(f"retained cycles {retained_cycles:.2f} < {target:.2f}")
    if too_sparse:
        parts.append(
            f"frames/cycle {frames_per_cycle:.2f} < {URANS_MIN_FRAMES_PER_CYCLE:.2f}"
        )
    if not stats.stationary:
        parts.append(
            "URANS window not stationary (precalc established-oscillation test): "
            f"{stats.stationary_reason}"
        )
    ok = not parts
    return UransQuality(
        ok=ok,
        can_refine=not ok,
        reason="URANS quality target met." if ok else "; ".join(parts),
        measured_period_s=stats.period_s,
        retained_cycles=retained_cycles,
        retained_frame_count=frame_count,
        frames_per_cycle=frames_per_cycle,
        retained_start_time=stats.window_start,
        retained_end_time=stats.window_end,
    )


def refined_transient_timing(
    measured_period_s: float,
    original_run_time_s: float,
    original_delta_t: float,
    discard_fraction: float,
    cadence_period_s: float | None = None,
    min_cycles: float = URANS_MIN_RETAINED_CYCLES,
    frame_write_per_cycle: float = URANS_FRAME_WRITE_PER_CYCLE,
) -> RefinedTransientTiming:
    retained_cycles = max(1, math.ceil(min_cycles))
    retained_fraction = max(1e-6, 1.0 - discard_fraction)
    write_interval = measured_period_s / frame_write_per_cycle
    min_total_cycles = retained_cycles / retained_fraction
    original_cycles = original_run_time_s / measured_period_s
    requested_total_cycles = max(original_cycles, min_total_cycles)
    # Align endTime to the field-write cadence so the final retained window has
    # exactly N whole periods with start/end on saved phases.
    write_steps = max(1, math.ceil(requested_total_cycles * frame_write_per_cycle - 1e-9))
    run_time = (write_steps / frame_write_per_cycle) * measured_period_s
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
    freestream_fallback: bool = False,
    cancel_check: CancelCheck = None,
    quality_warnings: Optional[list[str]] = None,
    urans_mesh: Optional[MeshParams] = None,
    urans_precalc_mesh: Optional[MeshParams] = None,
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
        tmesh, mesh_warnings = _standalone_transient_mesh_params(
            resolved,
            airfoil,
            spec,
            fluid,
            solver_params,
            urans_mesh=urans_mesh,
            urans_precalc_mesh=urans_precalc_mesh,
        )
        if quality_warnings is not None:
            quality_warnings.extend(mesh_warnings)
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
    _run_transient_mesh_qa_gate(tcase, runner, quality_warnings)
    _check_cancel(cancel_check)
    # Preferred warm start: continue from an ACCEPTED in-job steady RANS field
    # solved on the SAME shared mesh (URANS-only jobs run that stage first).
    # Non-converged/non-accepted full steady fields are filtered by
    # _run_transient before this prep step; they can carry oscillating garbage
    # that is worse than the fresh no-seed initialisation path.
    if (
        steady_field_dir is not None
        and shared_mesh_dir is not None
        and steady_field_dir.is_dir()
        and _seed_transient_from_steady(steady_field_dir, tcase)
    ):
        logger.info("transient %s warm-started from steady field %s", tcase, steady_field_dir)
        return tmesh, patches
    if freestream_fallback:
        # A rejected full-steady field means this condition is hostile to
        # SIMPLE initialisation — skip the in-case short simpleFoam init (its
        # own field is garbage at exactly these cells). But PURE uniform
        # freestream is singular too: prod s1223 c=1 u=50 detonated on the
        # first 1-2 pimpleFoam steps (t~4e-5, |Cl| 1e53..1e110) from the
        # impulsive no-slip start around the high-camber section. The classic
        # cure is a smooth POTENTIAL-flow initial field: irrotational, no
        # SIMPLE iterations, nothing to oscillate — keep exactly that stage.
        logger.warning(
            "transient %s starts from potential-flow initialised freestream; "
            "skipping the in-case short simpleFoam init",
            tcase,
        )
        runner.application(tcase, "potentialFoam -writephi -initialiseUBCs", timeout=600)
        _check_cancel(cancel_check)
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
    deadline: float | None = None,
) -> Optional[TransientResult]:
    _check_cancel(cancel_check)
    # Fresh attempt = fresh verdict: a marker left by a condemned earlier stage
    # (e.g. the steady init) must not poison this pimpleFoam pass.
    clear_divergence_condemnation(tcase)
    clear_march_markers(tcase)
    start_t = _latest_time(tcase)
    end_t = start_t + run_time
    remaining_timeout = float(timeout)
    if deadline is not None:
        remaining_timeout = min(
            remaining_timeout,
            max(0.0, float(deadline) - time.monotonic()),
        )
    if remaining_timeout <= 0.0:
        raise TransientTimeoutError(
            "URANS integration stopped by the wall-clock budget guard before "
            "the next same-case chunk could start"
        )
    CaseBuilder(airfoil, patches, tmesh, spec, fluid, roughness, solver_params, n_proc=n_proc).write_transient(
        tcase,
        start_t,
        end_t,
        delta_t,
        write_interval=write_interval,
        max_delta_t=max_delta_t,
    )
    # Arm the heartbeat march-rate watchdog for this chunk: it projects the
    # trailing simulated-time rate against this target/budget and stops a
    # provably hopeless march early (graded below as a continuable budget
    # stop — restartable state, honest reason).
    write_march_budget_marker(
        tcase,
        end_t=end_t,
        budget_s=remaining_timeout,
        wall_start=time.time(),
    )
    solve_started = time.monotonic()
    res = runner.solver(
        tcase,
        "pimpleFoam",
        n_proc,
        timeout=remaining_timeout,
        restart=True,
        monitor=_make_urans_monitor(
            tcase,
            spec,
            coeff_start_time,
            solver_params=solver_params,
        ),
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
    # A march-rate guard stop is the SAME class of outcome (wall-clock
    # grounds, restartable state) — it just arrived early instead of at the
    # budget wall, so it takes the same honest partial-grade path.
    march_stop = read_march_stop(tcase)
    timed_out = (
        bool(getattr(res, "timed_out", False))
        or (not res.ok and getattr(res, "returncode", None) == 124)
        or march_stop is not None
    )
    if not res.ok and not timed_out:
        return None
    if n_proc > 1:
        reconstruct_timeout = remaining_timeout
        if deadline is not None:
            reconstruct_timeout = min(
                reconstruct_timeout,
                max(0.0, float(deadline) - time.monotonic()),
            )
        if reconstruct_timeout <= 0.0:
            _check_cancel(cancel_check)
            raise OpenFOAMError(
                "URANS MPI reconstruction could not start before the shared "
                "tier deadline; decomposed processor field state was not "
                "reconstructed and is not safely continuable"
            )
        else:
            reconstruction = runner.application(
                tcase,
                "reconstructPar -newTimes",
                timeout=reconstruct_timeout,
            )
            reconstruction_timed_out = (
                bool(getattr(reconstruction, "timed_out", False))
                or (
                    not reconstruction.ok
                    and getattr(reconstruction, "returncode", None) == 124
                )
            )
            if reconstruction_timed_out:
                _check_cancel(cancel_check)
                raise OpenFOAMError(
                    "URANS MPI reconstruction timed out before decomposed "
                    "processor field state could be published; the result is "
                    "not safely continuable"
                )
            elif not reconstruction.ok:
                # A deterministic reconstruction failure is not a wall-budget
                # outcome, even when pimpleFoam itself had already timed out.
                return None
        _check_cancel(cancel_check)

    def _timeout_error() -> OpenFOAMError:
        files_now = _coeff_files(tcase)
        reached = _coeff_last_time(files_now[-1]) if files_now else None
        if reached is None:
            reached = _latest_time(tcase) or None
        return TransientTimeoutError(
            _transient_timeout_message(
                remaining_timeout,
                reached,
                end_t,
                _last_log_delta_t(res.stdout),
            )
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
    early_stop_cycles = _early_stop_retained_cycles(solver_params)
    target_cycles = int(early_stop_cycles if early_stop else solver_params.urans_min_periods)
    try:
        history = compute_force_history(
            coeff_paths,
            spec.speed,
            spec.chord,
            history_discard,
            target_cycles=target_cycles,
            alpha_deg=spec.aoa_deg,
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
        min_cycles=early_stop_cycles if early_stop else float(solver_params.urans_min_periods),
        min_no_shedding_observation_s=_no_shedding_min_observation_s(
            spec.speed, spec.chord
        ),
    )
    quality = _grade_precalc_established_oscillation(
        tcase,
        list(coeff_paths),
        spec,
        solver_params,
        quality,
        early_stopped=bool(early_stop),
    )
    if early_stop and quality.ok:
        quality = UransQuality(
            ok=True,
            can_refine=False,
            reason=(
                "URANS early-stop target met: "
                f"{early_stop.get('reason', 'certified stable retained window')}"
            ),
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
        stop_clause = (
            f"stopped early at t={reached:.6g}s of {end_t:.6g}s — {march_stop}"
            if march_stop
            else (
                f"timed out at t={reached:.6g}s of {end_t:.6g}s "
                f"(solver timeout {remaining_timeout:g}s)"
            )
        )
        quality = UransQuality(
            ok=False,
            can_refine=False,
            reason=(
                f"{'refined' if refined else 'base'} transient {stop_clause}; "
                f"graded partial window; "
                f"URANS integration {URANS_BUDGET_STOP_MARKER} mid-chunk — the saved "
                f"case state resumes from the last written time step with a bigger "
                f"budget; {quality.reason}"
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

#: Period acquisition is staged rather than declaring a short slow-shedding
#: URANS run terminal. The first two horizons preserve the legacy/default search
#: points; the final horizon is derived from the slow edge of the physical
#: shedding band and the request's startup discard.
URANS_PERIOD_ACQUISITION_GUESSED_CYCLES = (10.0, 20.0)


def _period_acquisition_write_interval(guessed_period_s: float) -> float:
    """Sparse field cadence while no shedding period is measurable yet.

    The slow edge of the accepted physical band spans ten St=0.5 guesses.  A
    ``guessed_period / 30`` cadence therefore wrote roughly 300 full OpenFOAM
    states per real slow cycle (about 1,100 through the default acquisition
    horizon), even for truly steady/no-shedding cases that publish no frame
    track.  Record 30 states per *slow-edge* period instead; the live monitor
    switches immediately to ``measured_period / 30`` after a credible lock.
    """
    slow_st = float(SHEDDING_STROUHAL_BAND[0])
    slow_period_in_guesses = TRANSIENT_INITIAL_STROUHAL / slow_st
    return (
        float(guessed_period_s)
        * slow_period_in_guesses
        / URANS_FRAME_WRITE_PER_CYCLE
    )


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


def _quality_allows_more_integration(quality: UransQuality, target_cycles: float) -> bool:
    if quality.ok or quality.no_shedding:
        return False
    period = quality.measured_period_s
    if period is None or not math.isfinite(period) or period <= 0:
        return False
    if quality.can_refine:
        return True
    reason = quality.reason.lower()
    if any(
        marker in reason
        for marker in (
            URANS_BUDGET_STOP_MARKER,
            "timed out",
            "stopped early",
            "failed",
            "crashed",
            "diverged",
            "could not be measured",
            "missing or flat",
        )
    ):
        return False
    eps = 1e-9
    too_short = quality.retained_cycles + eps < target_cycles
    too_sparse = (
        quality.frames_per_cycle > 0.0
        and quality.frames_per_cycle + eps < URANS_MIN_FRAMES_PER_CYCLE
    )
    not_stationary = "not stationary" in reason or "established-oscillation" in reason
    return too_short or too_sparse or not_stationary


def _quality_needs_period_acquisition(
    quality: UransQuality, solver_params: SolverParams
) -> bool:
    """Whether a short URANS run needs more guessed-period data before grading.

    This is deliberately narrower than generic refinement: only a non-terminal
    run with real-but-yet-unmeasurable shedding reaches it. No-shedding,
    wall-budget, timeout, crash and divergence outcomes remain terminal here.
    """
    if (
        quality.ok
        or quality.no_shedding
        or quality.measured_period_s is not None
    ):
        return False
    reason = quality.reason.lower()
    if any(
        marker in reason
        for marker in (
            URANS_BUDGET_STOP_MARKER,
            "timed out",
            "stopped early",
            "failed",
            "crashed",
            "diverged",
        )
    ):
        return False
    return "could not be measured" in reason or "missing or flat" in reason


def _period_acquisition_horizons(solver_params: SolverParams) -> tuple[float, ...]:
    """Cumulative initial-period horizons that cover the physical slow edge."""
    discard = min(max(solver_params.transient_discard_fraction, 0.0), 0.95)
    retained_fraction = max(1e-6, 1.0 - discard)
    slow_st = float(SHEDDING_STROUHAL_BAND[0])
    slow_period_in_guesses = TRANSIENT_INITIAL_STROUHAL / slow_st
    # ``estimate_period`` requires two cycles. A small numerical overshoot keeps
    # the retained span on the safe side of its exact >= comparison.
    slow_edge_horizon = math.ceil(
        URANS_PERIOD_ACQUISITION_SLOW_PERIODS
        * slow_period_in_guesses
        / retained_fraction
    )
    profile_horizon = min(
        20.0,
        max(URANS_PERIOD_ACQUISITION_GUESSED_CYCLES[0], float(solver_params.transient_cycles)),
    )
    return tuple(
        sorted(
            {
                profile_horizon,
                URANS_PERIOD_ACQUISITION_GUESSED_CYCLES[1],
                float(slow_edge_horizon),
            }
        )
    )


def _period_ambiguity_detail(estimate: PeriodEstimate) -> str:
    """Human-readable half-window diagnostic that is safe for missing halves."""

    first = (
        f"{estimate.first_half_s:.4g}s"
        if estimate.first_half_s is not None
        else "unavailable"
    )
    second = (
        f"{estimate.second_half_s:.4g}s"
        if estimate.second_half_s is not None
        else "unavailable"
    )
    if estimate.first_half_s is None or estimate.second_half_s is None:
        verdict = "were not both measurable"
        usage = (
            f"using full-window period {estimate.period_s:.4g}s "
            "for continuation only"
        )
    else:
        verdict = f"differ by >{PERIOD_AMBIGUITY_TOLERANCE:.0%}"
        usage = f"using conservative shorter period {estimate.period_s:.4g}s"
    return (
        f"half-window estimates {first} / {second} {verdict}; "
        f"{usage}"
    )


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
    rate_origin: Optional[float] = None,
    deadline: Optional[float] = None,
) -> TransientResult:
    """Integrate until ``urans_min_periods`` WHOLE shedding periods are retained
    after startup discard, extending the SAME transient case in continuation
    chunks (the existing restart mechanics: ``write_transient`` from latestTime
    + solver restart — no second continuation path). The period is tracked on
    the fly from the Cl signal by band-constrained autocorrelation
    (``estimate_period`` with the flow's plausible Strouhal window); an
    ambiguous period remains usable only to size another continuation chunk;
    it cannot certify established oscillation until both half-windows agree.

    Stops early — grading honestly — when the wall-clock budget guard projects
    (from the measured solve rate) that the next chunk cannot fit the solver
    timeout budget: quality then carries "retained M.x of N periods (budget)".
    A physically long-enough no-shedding observation and a tier-certified
    stable early stop break the loop immediately.
    """
    target = float(solver_params.urans_min_periods)
    discard = min(max(solver_params.transient_discard_fraction, 0.0), 0.95)
    result = first
    total_wall = max(0.0, first.wall_seconds)
    end_time = first.end_time
    chunks = 0
    while chunks < URANS_CONTINUATION_MAX_CHUNKS:
        history = result.force_history
        acquiring_period = _quality_needs_period_acquisition(
            result.quality, solver_params
        )
        can_continue = _quality_allows_more_integration(result.quality, target)
        if (
            result.quality.no_shedding
            or (not can_continue and not acquiring_period)
        ):
            break
        span = max(0.0, _latest_time(tcase) - transient_start)
        if span <= 0.0:
            break
        if acquiring_period:
            guessed_period = initial_delta_t * 5000.0
            guessed_cycles = span / guessed_period
            next_horizon = next(
                (
                    horizon
                    for horizon in _period_acquisition_horizons(solver_params)
                    if horizon > guessed_cycles + 1e-6
                ),
                None,
            )
            if next_horizon is None:
                result.quality = _quality_with(
                    result.quality,
                    can_refine=False,
                    reason=(
                        "URANS period acquisition exhausted the physical slow-shedding "
                        f"horizon ({guessed_cycles:.1f} initial guesses); "
                        f"{result.quality.reason}"
                    ),
                )
                break
            period = guessed_period
            retained = result.quality.retained_cycles
            chunk_sim = (next_horizon - guessed_cycles) * guessed_period
            write_interval = _period_acquisition_write_interval(guessed_period)
            period_note = (
                f" (period acquisition: extending from {guessed_cycles:.1f} to "
                f"{next_horizon:g} initial guesses)"
            )
            logger.warning("URANS continuation%s", period_note)
        else:
            if history is None or len(history.t) < 8:
                break
            estimate = estimate_period(
                history.t,
                history.cl,
                speed=spec.speed,
                chord=spec.chord,
                alpha_deg=spec.aoa_deg,
            )
            period = estimate.period_s if estimate is not None else None
            period_note = ""
            if estimate is not None and estimate.ambiguous:
                period_note = f" (period ambiguous: {_period_ambiguity_detail(estimate)})"
                logger.warning("URANS continuation period tracking%s", period_note)
            if period is None:
                period = history.period_s or result.quality.measured_period_s
            if period is None or not math.isfinite(period) or period <= 0:
                break
            retained = span * (1.0 - discard) / period
            # Quality counts WHOLE retained cycles (integer sub-windows), so a
            # span-retention of ~2.9 still grades as 2 whole cycles. Overshoot
            # past the integer boundary so the loop and the gate agree.
            target_deficit = target + RETENTION_SAFETY_CYCLES - retained
            reason = result.quality.reason.lower()
            precalc = solver_params.urans_fidelity == UransFidelity.precalc
            sparse = precalc and (
                result.quality.frames_per_cycle + 1e-9 < URANS_MIN_FRAMES_PER_CYCLE
                or "frames/cycle" in reason
            )
            not_stationary = precalc and (
                "not stationary" in reason or "established-oscillation" in reason
            )
            if target_deficit <= 1e-6 and not (sparse or not_stationary):
                break
            sparse_tail_only = (
                sparse and target_deficit <= 1e-6 and not not_stationary
            )
            if sparse_tail_only:
                # The aerodynamic retained-period target is already satisfied;
                # only the published last-three-period FIELD tail is sparse.
                # Three newly written measured periods replace that tail in
                # full. Applying the global startup-retention fraction here
                # turned this into 3/(1-discard)=5 periods at the default 40%
                # discard, adding 67% solver/I/O work without adding evidence.
                chunk_sim = float(URANS_FRAME_SPAN_PERIODS) * period
            elif sparse:
                # Replace the whole published last-three-period frame window in
                # one dense measured-cadence chunk while also closing the real
                # aerodynamic retained-window deficit conservatively.
                target_deficit = max(
                    target_deficit, float(URANS_FRAME_SPAN_PERIODS)
                )
            elif not_stationary:
                target_deficit = max(target_deficit, 1.0)
            if not sparse_tail_only:
                chunk_sim = target_deficit * period / max(
                    1e-6, 1.0 - discard
                )
            write_interval = period / URANS_FRAME_WRITE_PER_CYCLE
        # Prod naca-4412 -15deg precalc retained 2.00/3.00 cycles at 19.5
        # frames/cycle and was not yet stationary, but still had a measurable
        # period and hours of budget. Those blockers are solved by more
        # integration; the next chunk writes at the dedicated frame cadence
        # while the budget guard below remains the honest stop condition.
        if timeout and total_wall > 0.0:
            # Rate = THIS job's simulated progress per wall second. For a
            # cross-job continuation the retained window spans prior jobs'
            # simulated time too, so the rate must measure from the resume
            # point (rate_origin), never from the transient start.
            rate_span = max(
                0.0,
                _latest_time(tcase) - (rate_origin if rate_origin is not None else transient_start),
            )
            rate = rate_span / total_wall  # simulated seconds per wall second
            projected_wall_s = chunk_sim / rate if rate > 0.0 else math.inf
            if total_wall + projected_wall_s > URANS_REFINE_BUDGET_FRACTION * timeout:
                reason = (
                    f"URANS integration {URANS_BUDGET_STOP_MARKER}: "
                    f"retained {retained:.1f} of {target:g} periods (budget); "
                    f"projected {projected_wall_s / 3600.0:.1f}h continuation exceeds "
                    f"{URANS_REFINE_BUDGET_FRACTION:.0%} of the {timeout / 3600.0:.1f}h "
                    f"solver timeout{period_note}; {result.quality.reason}"
                )
                logger.warning(reason)
                result.quality = _quality_with(
                    result.quality,
                    ok=False,
                    can_refine=False,
                    reason=reason,
                    measured_period_s=(
                        result.quality.measured_period_s
                        if acquiring_period
                        else result.quality.measured_period_s or period
                    ),
                )
                break
        if result.early_stopped:
            # A rejected early-stop marker belongs to the just-graded chunk.
            # Remove it before continuing so the next attempt cannot mistake
            # stale certification evidence for a new early stop.
            (tcase / URANS_EARLY_STOP_MARKER).unlink(missing_ok=True)
            result.early_stopped = False
        remaining_timeout = float(timeout)
        if deadline is not None:
            remaining_timeout = min(
                remaining_timeout,
                max(0.0, float(deadline) - time.monotonic()),
            )
        if remaining_timeout <= 0.0:
            reason = (
                f"URANS integration {URANS_BUDGET_STOP_MARKER}: exhausted the "
                f"{timeout / 3600.0:.1f}h tier budget before the next same-case "
                f"chunk; {result.quality.reason}"
            )
            result.quality = _quality_with(
                result.quality,
                ok=False,
                can_refine=False,
                reason=reason,
            )
            break
        try:
            nxt = _run_transient_attempt(
                tcase, airfoil, tmesh, patches, spec, fluid, roughness, solver_params,
                runner, n_proc, remaining_timeout,
                run_time=chunk_sim,
                delta_t=min(initial_delta_t, period / 5000.0),
                write_interval=write_interval,
                max_delta_t=write_interval,
                coeff_start_time=transient_start,
                cancel_check=cancel_check,
                deadline=deadline,
            )
        except OpenFOAMError as exc:
            # A chunk that timed out without gradable data must not discard the
            # already-graded window; the point keeps its honest partial grade.
            # A TIMEOUT (unlike a crash/divergence) leaves the previous chunk's
            # fields saved and restartable, so the grade carries the pinned
            # continuable marker.
            budget_note = (
                f" URANS integration {URANS_BUDGET_STOP_MARKER} mid-continuation — "
                f"the saved case state resumes from the last written time step;"
                if isinstance(exc, TransientTimeoutError)
                else ""
            )
            result.quality = _quality_with(
                result.quality,
                ok=False,
                can_refine=False,
                reason=(
                    f"URANS continuation chunk failed after retaining {retained:.1f} of "
                    f"{target:g} periods: {exc};{budget_note} {result.quality.reason}"
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
    if (
        chunks >= URANS_CONTINUATION_MAX_CHUNKS
        and solver_params.urans_fidelity == UransFidelity.precalc
        and _quality_allows_more_integration(result.quality, target)
    ):
        if result.early_stopped:
            (tcase / URANS_EARLY_STOP_MARKER).unlink(missing_ok=True)
            result.early_stopped = False
        reason_lower = result.quality.reason.lower()
        needs_more_aerodynamic_evidence = (
            result.quality.retained_cycles + 1e-9 < target
            or "not stationary" in reason_lower
            or "established-oscillation" in reason_lower
        )
        if needs_more_aerodynamic_evidence:
            reason = (
                f"URANS continuation {URANS_CONTINUATION_REQUIRED_MARKER}: reached the "
                f"{URANS_CONTINUATION_MAX_CHUNKS}-chunk in-run safety cap with "
                f"restartable saved case state; {result.quality.reason}"
            )
        else:
            # Frame density is media-remediation metadata, not an aerodynamic
            # acceptance gate in the public Node classifier.  Do not offer a
            # human continuation merely because the recorder could not replace
            # the full dense tail inside this run's safety cap.
            reason = (
                "URANS frame-recorder remediation reached the "
                f"{URANS_CONTINUATION_MAX_CHUNKS}-chunk in-run safety cap; "
                "coefficients remain graded from force history; "
                f"{result.quality.reason}"
            )
        result.quality = _quality_with(
            result.quality,
            ok=False,
            can_refine=False,
            reason=reason,
        )
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
    steady_field_dir: Optional[Path] = None, steady_field_accepted: bool = True,
    cancel_check: CancelCheck = None,
    resume: Optional[TransientResume] = None,
    quality_warnings: Optional[list[str]] = None,
    urans_mesh: Optional[MeshParams] = None,
    urans_precalc_mesh: Optional[MeshParams] = None,
):
    """Run URANS and extend it until the tier's quality target is retained.

    Precalc correctable-quality failures continue the same case in bounded,
    measured-cadence chunks; full fidelity preserves its separate refinement
    fallback.

    With ``resume`` the case dir already holds STAGED saved state from a prior
    job (cross-job continuation): mesh/steady/prepare stages are skipped, the
    transient restarts from latestTime, and grading/media run over the history
    merged from the transient's ORIGINAL start."""
    tcase = case_dir / subdir
    initial_period = physics.shedding_period(spec.speed, spec.chord, strouhal=TRANSIENT_INITIAL_STROUHAL)
    initial_delta_t = initial_period / 5000.0
    tier_deadline: Optional[float] = None
    if resume is not None:
        # Staged continuation: the saved state IS the case — never wipe or
        # re-prepare it. The shared mesh already sits in constant/polyMesh.
        tmesh = resolved
        patches = get_mesher(resolved.mesher).patches(tmesh)
        transient_start = resume.transient_start
        target = float(solver_params.urans_min_periods)
        discard = min(max(solver_params.transient_discard_fraction, 0.0), 0.95)
        # Size the first continuation chunk from the SAVED merged history
        # (same math as the in-run extension loop); fall back to the Strouhal
        # guess horizon when no period is measurable yet.
        period: Optional[float] = None
        span = max(0.0, resume.resume_from - transient_start)
        try:
            saved_paths = _transient_coeff_selection(tcase, transient_start)
            if saved_paths:
                t_all, cl_all, _cd_all, _cm_all = coefficient_series(saved_paths)
                estimate = estimate_period(
                    t_all, cl_all, speed=spec.speed, chord=spec.chord, alpha_deg=spec.aoa_deg
                )
                if estimate is not None:
                    period = estimate.period_s
        except Exception:  # noqa: BLE001 - chunk sizing must never block the resume
            period = None
        if period is not None and math.isfinite(period) and period > 0:
            retained = span * (1.0 - discard) / period
            chunk_sim = max(period, (target - retained) * period / max(1e-6, 1.0 - discard))
            write_interval: Optional[float] = period / URANS_FRAME_WRITE_PER_CYCLE
            delta_t = min(initial_delta_t, period / 5000.0)
        else:
            chunk_sim = max(
                2.0 * initial_period, solver_params.transient_cycles * initial_period - span
            )
            write_interval = None
            delta_t = initial_delta_t
        logger.warning(
            "continuation: resuming transient %s from t=%g (merged history start t=%g) "
            "with wall budget %gs",
            tcase, resume.resume_from, transient_start, timeout,
        )
        tier_deadline = time.monotonic() + float(timeout)
        first = _run_transient_attempt(
            tcase, airfoil, tmesh, patches, spec, fluid, roughness, solver_params,
            runner, n_proc, timeout,
            run_time=chunk_sim, delta_t=delta_t,
            write_interval=write_interval,
            max_delta_t=write_interval,
            coeff_start_time=transient_start,
            cancel_check=cancel_check,
            deadline=tier_deadline,
        )
    else:
        effective_steady_field_dir = steady_field_dir
        freestream_fallback = False
        if steady_field_dir is not None and not steady_field_accepted:
            logger.warning(
                "steady init not converged; transient starts from freestream instead "
                "of the non-converged field (%s); skipping in-case short "
                "simpleFoam init",
                steady_field_dir,
            )
            effective_steady_field_dir = None
            freestream_fallback = True
        tmesh, patches = _prepare_transient_case(
            tcase, airfoil, resolved, spec, fluid, roughness, solver_params, runner, n_proc, timeout,
            shared_mesh_dir=shared_mesh_dir,
            steady_field_dir=effective_steady_field_dir,
            freestream_fallback=freestream_fallback,
            cancel_check=cancel_check,
            quality_warnings=quality_warnings,
            urans_mesh=urans_mesh,
            urans_precalc_mesh=urans_precalc_mesh,
        )

        initial_run_time = _fresh_transient_cycles(solver_params) * initial_period
        transient_start = _latest_time(tcase)
        _sanitize_freestream_init_time_state(tcase, initial_delta_t)
        # Persist the merge boundary so a cross-job continuation can keep
        # merging coefficient segments after this job is gone.
        write_transient_start_marker(tcase, transient_start)
        tier_deadline = time.monotonic() + float(timeout)
        initial_write_interval = (
            _period_acquisition_write_interval(initial_period)
            if solver_params.urans_fidelity == UransFidelity.precalc
            else None
        )
        first = _run_transient_attempt(
            tcase, airfoil, tmesh, patches, spec, fluid, roughness, solver_params, runner, n_proc, timeout,
            run_time=initial_run_time, delta_t=initial_delta_t,
            write_interval=initial_write_interval,
            max_delta_t=STARTUP_MAX_DELTA_T_FACTOR * initial_delta_t,
            coeff_start_time=transient_start,
            cancel_check=cancel_check,
            deadline=tier_deadline,
        )
    if first is None:
        return None
    rate_origin = resume.resume_from if resume is not None else None
    first = _extend_transient_until_periods(
        tcase, first, transient_start, airfoil, tmesh, patches, spec, fluid, roughness,
        solver_params, runner, n_proc, timeout, initial_delta_t, cancel_check=cancel_check,
        rate_origin=rate_origin,
        deadline=tier_deadline,
    )
    if resume is not None:
        # The result grades the WHOLE merged transient window across jobs.
        first.start_time = transient_start
        first.end_time = max(first.end_time, _latest_time(tcase))
        first.run_time = max(0.0, first.end_time - transient_start)
    if (
        solver_params.urans_fidelity == UransFidelity.precalc
        and (
            URANS_CONTINUATION_REQUIRED_MARKER in first.quality.reason
            or _quality_allows_more_integration(
                first.quality, float(solver_params.urans_min_periods)
            )
        )
    ):
        # Precalc correctable-quality work is handled only by bounded same-case
        # continuation above.  A separate copied rerun wastes the already-built
        # trajectory and was the source of slow, terminal "review" outcomes.
        return first
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
    # Rate projection origin: for a resumed case, only THIS job's simulated
    # span corresponds to first.wall_seconds (the merged window includes prior
    # jobs' integration time).
    base_span = max(
        0.0, _latest_time(tcase) - (rate_origin if rate_origin is not None else first.start_time)
    )
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
    remaining_timeout = float(timeout)
    if tier_deadline is not None:
        remaining_timeout = min(
            remaining_timeout,
            max(0.0, tier_deadline - time.monotonic()),
        )
    if remaining_timeout <= 0.0:
        first.quality = _quality_with(
            first.quality,
            ok=False,
            can_refine=False,
            reason=(
                f"URANS refinement not started: integration {URANS_BUDGET_STOP_MARKER}; "
                f"the {timeout / 3600.0:.1f}h tier budget is exhausted; "
                f"{first.quality.reason}"
            ),
        )
        return first
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
            remaining_timeout,
            run_time=refined_timing.run_time_s,
            delta_t=refined_timing.delta_t,
            write_interval=refined_timing.write_interval,
            max_delta_t=refined_timing.max_delta_t,
            refined=True,
            coeff_start_time=first.start_time,
            cancel_check=cancel_check,
            deadline=tier_deadline,
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
    resume: Optional[TransientResume] = None,
    urans_budget_s: Optional[int] = None,
    urans_mesh: Optional[MeshParams] = None,
    urans_precalc_mesh: Optional[MeshParams] = None,
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
    steady_field_accepted = bool(steady_field_dir is not None and outcome.converged)
    if coeff_files:
        steady_coeff = coeff_files[-1]
        try:
            coeffs = parse_force_coefficients(steady_coeff)
        except (ValueError, IndexError, ZeroDivisionError) as exc:
            # A malformed/truncated coefficient artifact proves only that
            # evidence transport or parsing failed. It does not prove an
            # aerodynamic instability and therefore must not widen a polar.
            # Parsed finite-but-nonphysical coefficients are classified below
            # through the ordinary hard RANS verdict.
            raise InfrastructureError(
                f"steady RANS produced unreadable force coefficients in {steady_coeff}: {exc}"
            ) from exc
        outcome.cl, outcome.cd, outcome.cm = coeffs.cl, coeffs.cd, coeffs.cm
        outcome.cl_cd = coeffs.cl_cd
        if not outcome.converged and force_is_steady(steady_coeff):
            outcome.converged = True
        steady_field_accepted = bool(steady_field_dir is not None and outcome.converged)
        # Oscillating-steady averaging (R1): a steady solve that failed both
        # residual convergence and the pointwise force plateau, but oscillates
        # BOUNDEDLY with a stable windowed mean, is accepted with the window
        # average as the point values. The full coefficient history ships as
        # steady_history in BOTH the accepted and the still-failing case (the
        # failing history is analysis evidence on the escalation path);
        # classic converged solves ship steady_history=null.
        if not outcome.converged and (
            not solver_params.force_transient or steady_field_dir is not None
        ):
            try:
                osc = analyze_steady_oscillation(
                    steady_coeff, window=solver_params.steady_oscillation_window
                )
            except Exception as exc:  # noqa: BLE001 - analysis loss must not fail the case
                logger.warning("oscillating-steady analysis failed for %s: %s", case_dir, exc)
                osc = None
            if osc is not None and not solver_params.force_transient:
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
                    steady_field_accepted = bool(steady_field_dir is not None)
            elif osc is not None and osc.mean_stable:
                # A force_transient request still reports the URANS result, but
                # a bounded full-steady oscillation is an accepted developed
                # field and remains a valid transient seed.
                steady_field_accepted = bool(steady_field_dir is not None)
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
        raise InfrastructureError("forceCoeffs produced no coefficient.dat")

    # transient (URANS) fallback for unsteady (e.g. post-stall) conditions
    post_dir = case_dir
    frame_stats: Optional[PeriodWindowStats] = None
    frame_series: Optional[tuple] = None  # merged (t, cl, cd, cm) coefficient arrays
    if solver_params.force_transient or (not outcome.converged and solver_params.transient_fallback):
        # Fidelity tier: the tier owns the retained-period target and the
        # transient wall-clock budget (precalc: 3 periods / 7200 s; full:
        # 7 periods / 43200 s) — contract item 1, pinned cross-runtime.
        urans_params = apply_urans_fidelity(solver_params)
        # A continuation's per-job override (PolarRequest.budget_override_s)
        # replaces the tier budget for this job only (24 h cap).
        urans_timeout = urans_budget_seconds(solver_params, urans_budget_s)
        transient = _run_transient(
            case_dir, airfoil, resolved, spec, fluid, roughness, urans_params,
            runner, n_proc, urans_timeout, subdir=transient_subdir, shared_mesh_dir=shared_mesh_dir,
            steady_field_dir=steady_field_dir,
            steady_field_accepted=steady_field_accepted,
            cancel_check=cancel_check,
            resume=resume,
            quality_warnings=outcome.quality_warnings,
            urans_mesh=urans_mesh,
            urans_precalc_mesh=urans_precalc_mesh,
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
                    frame_estimate: Optional[PeriodEstimate] = estimate_period(
                        t_c, cl_c, speed=spec.speed, chord=spec.chord, alpha_deg=spec.aoa_deg
                    )
                    frame_period = frame_estimate.period_s if frame_estimate is not None else None
                    if frame_estimate is not None and frame_estimate.ambiguous:
                        outcome.quality_warnings.append(
                            "URANS period ambiguous: "
                            f"{_period_ambiguity_detail(frame_estimate)}"
                        )
                    if frame_period is None and transient.force_history is not None:
                        frame_period = transient.force_history.period_s
                    if frame_period is not None and frame_period > 0:
                        # PRECALC tier stationarity = established-oscillation
                        # test (trendless per-cycle means + stable period +
                        # bounded amplitude — user decision 2026-07-08: the
                        # rung certifies "converged to a stable oscillation").
                        # FULL tier keeps the strict 5% mean-drift gate
                        # ("verified" = converged mean), byte-identical.
                        precalc_tier = solver_params.urans_fidelity == UransFidelity.precalc
                        frame_stats = period_window_stats(
                            t_c, cl_c, cd_c, cm_c, frame_period,
                            drift_tolerance=solver_params.urans_drift_tolerance,
                            established_oscillation=precalc_tier,
                            period_stable=(
                                frame_estimate is not None
                                and not frame_estimate.ambiguous
                            ),
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
                precalc_tier = solver_params.urans_fidelity == UransFidelity.precalc
                if not frame_stats.stationary:
                    if precalc_tier and frame_stats.stationary_reason:
                        outcome.quality_warnings.append(
                            "URANS window not stationary (precalc established-oscillation "
                            f"test): {frame_stats.stationary_reason}"
                        )
                    else:
                        outcome.quality_warnings.append(
                            f"URANS window not stationary: Cl drift {frame_stats.drift_frac:.3f} "
                            f"exceeds tolerance {solver_params.urans_drift_tolerance:g} over "
                            f"{frame_stats.whole_periods} whole periods"
                        )
                elif precalc_tier:
                    # Acceptance under the established-oscillation gate is a
                    # looser bar than the full-tier converged mean: DISCLOSE
                    # the cycle-mean uncertainty on the accepted point.
                    outcome.quality_warnings.append(
                        f"cycle means scatter ±{frame_stats.cycle_mean_std:.3g} over "
                        f"{frame_stats.whole_periods} cycles (precalc)"
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
                raise HardSolverError(
                    f"URANS transient failed before grading (coefficient.dat has data up to "
                    f"t={reached_s}s); see {transient_subdir}/log.pimpleFoam"
                )
            raise HardSolverError("URANS transient produced no coefficient.dat")

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
            # Frame-track PNG export: every written state in the last
            # min(3, K) periods up to the 120-frame cap, rendered at the
            # contract's 640px width.
            if frame_stats is not None and solver_params.frame_fields:
                frames_out = (
                    (case_dir / image_subdir / "frames") if image_subdir else (case_dir / "frames")
                )
                if not budget.exceeded():
                    try:
                        try:
                            written_times = available_vtu_times(post_dir)
                        except (FileNotFoundError, OSError):
                            written_times = None
                        targets = frame_target_times(
                            frame_stats.window_end, frame_stats.period_s, frame_stats.whole_periods,
                            span_periods=URANS_FRAME_SPAN_PERIODS,
                            written_times=written_times,
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
    resume: Optional[TransientResume] = None,
    urans_budget_s: Optional[int] = None,
    mesh_quality_warnings: Optional[list[str]] = None,
    urans_mesh: Optional[MeshParams] = None,
    urans_precalc_mesh: Optional[MeshParams] = None,
) -> CaseOutcome:
    """Run one self-contained case. If ``mesh_dir`` is given, reuse that prebuilt
    mesh (skip blockMesh) instead of meshing in the case directory. With a
    ``cache``, the steady start seeds from the nearest previously solved angle
    at the same mesh/fluid/speed, and accepted steady fields are published back.

    With ``resume`` the case dir holds STAGED saved state from a prior job
    (see ``stage_continuation_case``): meshing and the steady stage are
    skipped entirely and the URANS transient restarts from latestTime with
    ``urans_budget_s`` (when given) replacing the tier wall budget."""
    case_dir.mkdir(parents=True, exist_ok=True)
    re = physics.reynolds(spec.speed, spec.chord, fluid.nu)
    outcome = CaseOutcome(spec=spec, reynolds=re)
    if mesh_quality_warnings:
        outcome.quality_warnings.extend(mesh_quality_warnings)
    steady_timeout = min(solver_timeout, rans_solver_timeout or solver_timeout)
    steady_solver_params = _steady_rans_params(solver_params, rans_max_iterations)

    if resume is not None:
        # Cross-job continuation: state exists — no mesh build, no steady
        # stage; the transient path in _finalize_outcome resumes from
        # latestTime and grades the merged history.
        try:
            _check_cancel(cancel_check)
            effective, derived_warnings = effective_mesh_params_for_airfoil(
                mesh_params,
                solver_params,
                airfoil,
                urans_mesh=urans_mesh,
                urans_precalc_mesh=urans_precalc_mesh,
            )
            outcome.quality_warnings.extend(derived_warnings)
            resolved = resolve_mesh_params(effective, spec, fluid)
            outcome.n_cells = mesher.cell_count(resolved) if hasattr(mesher, "cell_count") else 0
            _finalize_outcome(
                case_dir, outcome, airfoil, resolved, spec, fluid, roughness, solver_params,
                runner, n_proc, render_images, solver_timeout,
                cancel_check=cancel_check,
                phase_progress=phase_progress,
                case_slug=case_slug,
                media_budget_s=media_budget_s,
                resume=resume,
                urans_budget_s=urans_budget_s,
                urans_mesh=urans_mesh,
                urans_precalc_mesh=urans_precalc_mesh,
            )
        except JobCancelled:
            raise
        except (OpenFOAMError, Exception) as exc:  # noqa: BLE001 - report, don't crash the batch
            _record_outcome_failure(outcome, exc)
        return outcome

    try:
        _check_cancel(cancel_check)
        if mesh_dir is None:
            # Standalone case builds its own mesh: a precalc URANS request
            # meshes the derived half-resolution grid (contract item 1). With
            # a prebuilt mesh_dir the caller already derived before building.
            mesh_params, derived_warnings = effective_mesh_params_for_airfoil(
                mesh_params,
                solver_params,
                airfoil,
                urans_mesh=urans_mesh,
                urans_precalc_mesh=urans_precalc_mesh,
            )
            outcome.quality_warnings.extend(derived_warnings)
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
        # URANS-only (force_transient) cases run this steady RANS stage too: an
        # accepted developed steady field is a good transient seed, and the
        # steady log/coefficients are valuable attempt evidence. A successful
        # but non-converged/non-accepted steady stage is evidence only; the
        # transient falls back to the no-seed freestream initialisation path.
        # A steady failure must not abort the URANS attempt, and the steady
        # coefficients are never accepted as the reported result.
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
            log = _checked_solver_result(case_dir, res).stdout
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
            urans_mesh=urans_mesh,
            urans_precalc_mesh=urans_precalc_mesh,
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
        _record_outcome_failure(outcome, exc)

    if not solver_params.force_transient:
        _record_unexceptional_rans_rejection(outcome)

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
        and outcome.failure_disposition == FailureDisposition.hard_solver
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
    mesh_quality_warnings: Optional[list[str]] = None,
) -> list[StoredCaseOutcome]:
    urans_solver = apply_urans_fidelity(solver_params.model_copy(
        update={
            "transient_fallback": True,
            "force_transient": True,
            "transient_auto_refine": True,
            "urans_fidelity": UransFidelity.precalc,
        }
    ))
    points: list[StoredCaseOutcome] = []
    for j, aoa in enumerate(sorted(aoas)):
        _check_cancel(cancel_check)
        spec = CaseSpec(chord=chord, speed=speed, aoa_deg=aoa)
        case_slug = f"{polar_dir.name}/urans_a{j}"
        case_dir = polar_dir / f"urans_a{j}"
        if phase_progress:
            phase_progress(JobPhase.solving_urans, aoa, case_slug, "pimpleFoam")
        extra_run_case_kwargs = {}
        if mesh_quality_warnings:
            extra_run_case_kwargs["mesh_quality_warnings"] = mesh_quality_warnings
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
            **extra_run_case_kwargs,
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
    mesh_quality_warnings: Optional[list[str]] = None,
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
        if mesh_quality_warnings:
            outcome.quality_warnings.extend(mesh_quality_warnings)
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
            log = _checked_solver_result(polar_dir, res).stdout
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
            _record_outcome_failure(outcome, exc)
        _record_unexceptional_rans_rejection(outcome)
        stored = StoredCaseOutcome(slug=polar_dir.name, outcome=outcome)
        attempts.append(stored)
        if outcome_progress:
            outcome_progress(stored, False)
        if progress:
            progress()
        _check_cancel(cancel_check)
        # The policy separates the numerical decision from execution ownership:
        # Node-managed production sweeps stop immediately and emit a typed
        # external-PRECALC signal; direct multi-angle API sweeps may replace
        # in-job, but only at preliminary fidelity. Explicit targeted work uses
        # `continue` and never widens. Infrastructure/mesh errors cannot reach
        # this block because the predicate requires hard_solver provenance.
        qualifying_core_failure = (
            not solver_params.force_transient
            and should_abort_rans_sweep_for_urans(aoa, outcome)
        )
        if (
            qualifying_core_failure
            and solver_params.rans_failure_policy == RansFailurePolicy.abort_for_precalc
        ):
            reason = (
                f"RANS rejected at {aoa:g} deg inside the {RANS_CORE_ABORT_AOA_MIN:g}-"
                f"{RANS_CORE_ABORT_AOA_MAX:g} deg attached-range check; remaining RANS stopped "
                "for external preliminary URANS."
            )
            return PolarMarchResult(
                points=final_points,
                attempts=attempts,
                promoted_to_urans=False,
                abort_reason=reason,
                precalc_promotion=RansPrecalcPromotion(
                    trigger_aoa_deg=aoa,
                    attempted_aoas=[item.outcome.spec.aoa_deg for item in attempts],
                    intentionally_omitted_aoas=sorted_aoas[i + 1 :],
                ),
            )
        if (
            qualifying_core_failure
            and solver_params.rans_failure_policy == RansFailurePolicy.replace_precalc
            and solver_params.transient_fallback
            and len(sorted_aoas) > 1
        ):
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
                mesh_quality_warnings=mesh_quality_warnings,
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
