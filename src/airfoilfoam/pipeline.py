"""Run a single CFD case end to end: mesh -> solve -> coefficients -> images."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import physics
from .airfoil import Airfoil
from .case.builder import CaseBuilder
from .meshing.base import Mesher, get_mesher
from .models import CaseSpec, FluidProperties, MeshParams, RoughnessParams, SolverParams
from .openfoam.runner import OpenFOAMError, RunResult, Runner
from .postprocess.forces import (
    force_is_steady,
    parse_force_coefficients,
    parse_y_plus,
    time_averaged_coefficients,
)
from .postprocess.images import render_contours
from .postprocess.residuals import parse_convergence


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
    error: Optional[str] = None


def _time_of(coeff_path) -> float:
    try:
        return float(coeff_path.parent.name)
    except ValueError:
        return -1.0


def _coeff_files(case_dir: Path) -> list:
    return sorted(
        case_dir.glob("postProcessing/forceCoeffs1/*/coefficient.dat"), key=_time_of
    )


def _latest_time(case_dir: Path) -> float:
    times = []
    for d in case_dir.iterdir():
        if not d.is_dir():
            continue
        try:
            times.append(float(d.name))
        except ValueError:
            continue
    return max(times) if times else 0.0


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


@dataclass
class TransientResult:
    avg: "object"  # AveragedCoefficients
    case_dir: Path  # the (coarse-wall) transient case, for y+/image post-processing


def _run_transient(
    case_dir, airfoil, resolved, spec, fluid, roughness, solver_params, runner, n_proc, timeout
):
    """Run a self-contained transient (pimpleFoam/URANS) case for an unsteady
    (e.g. post-stall) condition and return time-averaged force coefficients.

    Uses a *coarser* wall mesh (wall-function y+) than the steady run: post-stall
    flow is pressure-dominated and a y+~1 wall would throttle the explicit Courant
    limit to an impractically small time step. Returns None if the run fails.
    """
    tcase = case_dir / "transient"
    tcase.mkdir(parents=True, exist_ok=True)
    mesher = get_mesher(resolved.mesher)

    # A deliberately coarse mesh for the URANS: fewer cells (faster steps) with a
    # larger minimum cell + wall-function y+ (a bigger, affordable time step). The
    # time-averaged mean does not need the steady mesh's fine resolution.
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

    # 1. mesh + a short steady initialisation (gives the transient a developed,
    #    already-separated field to start from).
    init_solver = solver_params.model_copy(
        update={"n_iterations": min(solver_params.n_iterations, TRANSIENT_INIT_ITERS)}
    )
    mesher.write_inputs(tcase, airfoil, tmesh, spec.chord)
    CaseBuilder(airfoil, patches, tmesh, spec, fluid, roughness, init_solver, n_proc=n_proc).write(tcase)
    mesher.run_mesh(tcase, tmesh, runner)
    runner.application(tcase, "potentialFoam -writephi -initialiseUBCs", timeout=600)
    if not runner.solver(tcase, "simpleFoam", n_proc, timeout=timeout).ok:
        return None

    # 2. transient continuation, time-averaged
    start_t = _latest_time(tcase)
    period = physics.shedding_period(spec.speed, spec.chord)
    run_time = solver_params.transient_cycles * period
    CaseBuilder(airfoil, patches, tmesh, spec, fluid, roughness, solver_params, n_proc=n_proc).write_transient(
        tcase, start_t, start_t + run_time, period / 5000.0
    )
    res = runner.solver(tcase, "pimpleFoam", n_proc, timeout=timeout, restart=True)
    if not res.ok:
        return None
    (tcase / "log.pimpleFoam").write_text(res.stdout)
    files = _coeff_files(tcase)
    if not files or _time_of(files[-1]) <= 0:
        return None
    avg = time_averaged_coefficients(files[-1], solver_params.transient_discard_fraction)
    return TransientResult(avg=avg, case_dir=tcase)


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
) -> CaseOutcome:
    case_dir.mkdir(parents=True, exist_ok=True)
    re = physics.reynolds(spec.speed, spec.chord, fluid.nu)
    outcome = CaseOutcome(spec=spec, reynolds=re)

    try:
        resolved = resolve_mesh_params(mesh_params, spec, fluid)

        # 1. mesh inputs + 2. case files (controlDict needed before blockMesh)
        mesher.write_inputs(case_dir, airfoil, resolved, spec.chord)
        patches = mesher.patches(resolved)

        def write_case(sp):
            CaseBuilder(
                airfoil, patches, resolved, spec, fluid, roughness, sp, n_proc=n_proc
            ).write(case_dir)

        write_case(solver_params)

        # 3. generate mesh
        mesh_result = mesher.run_mesh(case_dir, resolved, runner)
        outcome.n_cells = mesh_result.n_cells

        def solve_once(sp) -> "RunResult":
            write_case(sp)
            # Potential-flow initialisation greatly stabilises the cold RANS start.
            runner.application(case_dir, "potentialFoam -writephi -initialiseUBCs", timeout=600)
            return runner.solver(case_dir, "simpleFoam", n_proc, timeout=solver_timeout)

        # 4/5. solve, with an automatic first-order fallback for fragile cases
        # (e.g. the delicate symmetric AoA=0 state) that diverge with 2nd-order
        # convection. The fallback is more dissipative but reliably stable.
        res = solve_once(solver_params)
        if not res.ok and solver_params.momentum_scheme != "upwind":
            outcome.first_order_fallback = True
            res = solve_once(solver_params.model_copy(update={"momentum_scheme": "upwind"}))
        log = res.check().stdout
        (case_dir / "log.simpleFoam").write_text(log)
        conv = parse_convergence(log)
        outcome.converged = conv.converged
        outcome.iterations = conv.iterations
        outcome.final_residual = conv.final_residual

        # 5. force coefficients (steady)
        coeff_files = _coeff_files(case_dir)
        if not coeff_files:
            raise OpenFOAMError("forceCoeffs produced no coefficient.dat")
        steady_coeff = coeff_files[-1]
        coeffs = parse_force_coefficients(steady_coeff)
        outcome.cl, outcome.cd, outcome.cm = coeffs.cl, coeffs.cd, coeffs.cm
        outcome.cl_cd = coeffs.cl_cd
        # Treat steady integrated forces as converged even if the residual plateaus.
        if not outcome.converged and force_is_steady(steady_coeff):
            outcome.converged = True

        # 5b. transient (URANS) fallback: a steady run that did not converge usually
        # means the flow is genuinely unsteady (post-stall separation / vortex
        # shedding). Run a coarse-wall transient case and time-average the forces.
        post_dir = case_dir
        if not outcome.converged and solver_params.transient_fallback:
            transient = _run_transient(
                case_dir, airfoil, resolved, spec, fluid, roughness, solver_params,
                runner, n_proc, solver_timeout,
            )
            if transient is not None:
                avg = transient.avg
                outcome.cl, outcome.cd, outcome.cm = avg.cl, avg.cd, avg.cm
                outcome.cl_cd = avg.cl_cd
                outcome.cl_std, outcome.cd_std, outcome.cm_std = avg.cl_std, avg.cd_std, avg.cm_std
                outcome.unsteady = True
                outcome.converged = True
                post_dir = transient.case_dir  # y+/images from the transient case

        # 6. y+
        runner.application(post_dir, "simpleFoam -postProcess -func yPlus -latestTime")
        yplus_files = sorted(post_dir.glob("postProcessing/yPlus/*/yPlus.dat"))
        if yplus_files:
            outcome.y_plus_avg, outcome.y_plus_max = parse_y_plus(yplus_files[-1])

        # 7. images (from the transient case if the result is unsteady)
        if render_images and solver_params.write_images:
            runner.application(post_dir, "foamToVTK -latestTime").check()
            rel = post_dir.relative_to(case_dir)  # "." or "transient"
            suffix = f"{airfoil.name} a={spec.aoa_deg:g}deg U={spec.speed:g}"
            if outcome.unsteady:
                suffix += " (URANS mean field instant)"
            imgs = render_contours(
                post_dir,
                post_dir / "images",
                airfoil.contour,
                spec.chord,
                solver_params.write_images,
                zoom_chords=solver_params.image_zoom_chords,
                title_suffix=suffix,
            )
            prefix = "" if str(rel) == "." else f"{rel}/"
            outcome.images = {k: f"{prefix}images/{v}" for k, v in imgs.items()}

    except (OpenFOAMError, Exception) as exc:  # noqa: BLE001 - report, don't crash the batch
        outcome.error = f"{type(exc).__name__}: {exc}"

    return outcome
