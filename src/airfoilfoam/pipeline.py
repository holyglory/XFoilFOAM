"""Run CFD cases end to end: mesh -> solve -> coefficients -> images.

Two entry points:
- ``run_case``: a single, self-contained case (mesh + solve).
- ``solve_polar_marched``: one polar (fixed chord/speed, AoA sweep) that meshes
  once and *marches* the angle of attack, warm-starting each AoA from the
  previous converged field. ``prepare_mesh`` builds a mesh once for reuse.
"""
from __future__ import annotations

import shutil
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


@dataclass
class TransientResult:
    avg: "object"  # AveragedCoefficients
    case_dir: Path  # the (coarse-wall) transient case, for y+/image post-processing


def _run_transient(
    case_dir, airfoil, resolved, spec, fluid, roughness, solver_params, runner, n_proc, timeout,
    subdir="transient",
):
    """Run a self-contained transient (pimpleFoam/URANS) case for an unsteady
    (e.g. post-stall) condition and return time-averaged force coefficients.

    Uses a *coarser* wall mesh (wall-function y+) than the steady run: post-stall
    flow is pressure-dominated and a y+~1 wall would throttle the explicit Courant
    limit to an impractically small time step. Returns None if the run fails.
    """
    tcase = case_dir / subdir
    if tcase.exists():
        shutil.rmtree(tcase)
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


def _finalize_outcome(
    case_dir, outcome, airfoil, resolved, spec, fluid, roughness, solver_params,
    runner, n_proc, render_images, solver_timeout, transient_subdir="transient", image_subdir="",
):
    """Parse forces, run the transient fallback if needed, compute y+ and images.

    ``image_subdir`` namespaces the output under the case dir (used to keep each
    marched AoA's artefacts separate within one polar directory).
    """
    coeff_files = _coeff_files(case_dir)
    if not coeff_files:
        raise OpenFOAMError("forceCoeffs produced no coefficient.dat")
    steady_coeff = coeff_files[-1]
    coeffs = parse_force_coefficients(steady_coeff)
    outcome.cl, outcome.cd, outcome.cm = coeffs.cl, coeffs.cd, coeffs.cm
    outcome.cl_cd = coeffs.cl_cd
    if not outcome.converged and force_is_steady(steady_coeff):
        outcome.converged = True

    # transient (URANS) fallback for unsteady (e.g. post-stall) conditions
    post_dir = case_dir
    if not outcome.converged and solver_params.transient_fallback:
        transient = _run_transient(
            case_dir, airfoil, resolved, spec, fluid, roughness, solver_params,
            runner, n_proc, solver_timeout, subdir=transient_subdir,
        )
        if transient is not None:
            avg = transient.avg
            outcome.cl, outcome.cd, outcome.cm = avg.cl, avg.cd, avg.cm
            outcome.cl_cd = avg.cl_cd
            outcome.cl_std, outcome.cd_std, outcome.cm_std = avg.cl_std, avg.cd_std, avg.cm_std
            outcome.unsteady = True
            outcome.converged = True
            post_dir = transient.case_dir

    # y+
    runner.application(post_dir, "simpleFoam -postProcess -func yPlus -latestTime")
    yplus_files = sorted(post_dir.glob("postProcessing/yPlus/*/yPlus.dat"))
    if yplus_files:
        outcome.y_plus_avg, outcome.y_plus_max = parse_y_plus(yplus_files[-1])

    # contour images
    if render_images and solver_params.write_images:
        runner.application(post_dir, "foamToVTK -latestTime").check()
        img_out = (case_dir / image_subdir / "images") if image_subdir else (case_dir / "images")
        suffix = f"{airfoil.name} a={spec.aoa_deg:g}deg U={spec.speed:g}"
        if outcome.unsteady:
            suffix += " (URANS instant)"
        imgs = render_contours(
            post_dir, img_out, airfoil.contour, spec.chord, solver_params.write_images,
            zoom_chords=solver_params.image_zoom_chords, title_suffix=suffix,
        )
        prefix = f"{image_subdir}/" if image_subdir else ""
        outcome.images = {k: f"{prefix}images/{v}" for k, v in imgs.items()}


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
    mesh_dir: Optional[Path] = None,
) -> CaseOutcome:
    """Run one self-contained case. If ``mesh_dir`` is given, reuse that prebuilt
    mesh (skip blockMesh) instead of meshing in the case directory."""
    case_dir.mkdir(parents=True, exist_ok=True)
    re = physics.reynolds(spec.speed, spec.chord, fluid.nu)
    outcome = CaseOutcome(spec=spec, reynolds=re)

    try:
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

        write_case(solver_params)

        if mesh_dir is None:
            outcome.n_cells = mesher.run_mesh(case_dir, resolved, runner).n_cells
        else:
            outcome.n_cells = mesher.cell_count(resolved) if hasattr(mesher, "cell_count") else 0

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

        _finalize_outcome(
            case_dir, outcome, airfoil, resolved, spec, fluid, roughness, solver_params,
            runner, n_proc, render_images, solver_timeout,
        )

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


def prepare_mesh(mesh_dir: Path, airfoil, resolved, chord, mesher, runner):
    """Build the mesh once (blockMesh) into ``mesh_dir`` for reuse across a polar
    set (all speeds/AoAs of one airfoil at one chord share this mesh)."""
    mesh_dir.mkdir(parents=True, exist_ok=True)
    mesher.write_inputs(mesh_dir, airfoil, resolved, chord)
    _write_minimal_controldict(mesh_dir)
    return mesher.run_mesh(mesh_dir, resolved, runner)


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


def _solve_cold_marched(
    polar_dir, mesh_dir, airfoil, patches, resolved, spec, fluid, roughness,
    solver_params, runner, solver_timeout, outcome,
):
    """Cold-start the first AoA of a polar (build case, reuse mesh, potentialFoam)."""
    def write_case(sp):
        CaseBuilder(airfoil, patches, resolved, spec, fluid, roughness, sp, n_proc=1).write(polar_dir)
        _link_mesh(polar_dir, mesh_dir, runner)
        # keep only a few time dirs (warm-starts need just the latest as a seed)
        runner.application(polar_dir, "foamDictionary -entry purgeWrite -set 3 system/controlDict")

    def solve_once(sp):
        write_case(sp)
        runner.application(polar_dir, "potentialFoam -writephi -initialiseUBCs", timeout=600)
        return runner.solver(polar_dir, "simpleFoam", 1, timeout=solver_timeout)

    res = solve_once(solver_params)
    if not res.ok and solver_params.momentum_scheme != "upwind":
        outcome.first_order_fallback = True
        res = solve_once(solver_params.model_copy(update={"momentum_scheme": "upwind"}))
    return res


def _solve_warm(polar_dir, spec, solver_params, runner, solver_timeout):
    """Warm-start one AoA: rewrite only the velocity BC + lift/drag dirs at the
    latest (previous-AoA) field and continue simpleFoam from it."""
    fv = physics.freestream_vector(spec.speed, spec.aoa_deg)
    lt_dir = _latest_time_dir(polar_dir)
    lt = lt_dir.name
    lt_v = int(float(lt))
    uval = f'"uniform ({fv.ux:.10g} {fv.uy:.10g} 0)"'
    ld = f'"({fv.lift_dir[0]:.10g} {fv.lift_dir[1]:.10g} 0)"'
    dd = f'"({fv.drag_dir[0]:.10g} {fv.drag_dir[1]:.10g} 0)"'
    for cmd in (
        f"foamDictionary -entry boundaryField.inlet.value -set {uval} {lt}/U",
        f"foamDictionary -entry boundaryField.outlet.value -set {uval} {lt}/U",
        f"foamDictionary -entry functions.forceCoeffs1.liftDir -set {ld} system/controlDict",
        f"foamDictionary -entry functions.forceCoeffs1.dragDir -set {dd} system/controlDict",
        f"foamDictionary -entry endTime -set {lt_v + solver_params.n_iterations} system/controlDict",
        "foamDictionary -entry startFrom -set latestTime system/controlDict",
    ):
        runner.application(polar_dir, cmd).check()
    return runner.solver(polar_dir, "simpleFoam", 1, timeout=solver_timeout)


def solve_polar_marched(
    polar_dir: Path, mesh_dir: Path, airfoil, chord, speed, fluid, roughness, resolved,
    solver_params, mesher, runner, aoas, n_cells=0, render_images=True,
    solver_timeout=7200, progress=None,
) -> list:
    """Run one polar (fixed chord+speed) over the AoA sweep, reusing ``mesh_dir``
    and warm-starting each AoA from the previous converged field (marching).
    Returns a CaseOutcome per AoA, ordered by ascending AoA."""
    polar_dir.mkdir(parents=True, exist_ok=True)
    patches = mesher.patches(resolved)
    outcomes = []
    for i, aoa in enumerate(sorted(aoas)):
        spec = CaseSpec(chord=chord, speed=speed, aoa_deg=aoa)
        outcome = CaseOutcome(
            spec=spec, reynolds=physics.reynolds(speed, chord, fluid.nu), n_cells=n_cells
        )
        try:
            if i == 0:
                res = _solve_cold_marched(
                    polar_dir, mesh_dir, airfoil, patches, resolved, spec, fluid, roughness,
                    solver_params, runner, solver_timeout, outcome,
                )
            else:
                res = _solve_warm(polar_dir, spec, solver_params, runner, solver_timeout)
            log = res.check().stdout
            (polar_dir / f"log.a{i}").write_text(log)
            conv = parse_convergence(log)
            outcome.converged = conv.converged
            # iterations relative to this segment (a warm continuation reports the
            # absolute time, so count the timesteps actually taken instead)
            outcome.iterations = log.count("\nTime = ") or conv.iterations
            outcome.final_residual = conv.final_residual
            _finalize_outcome(
                polar_dir, outcome, airfoil, resolved, spec, fluid, roughness, solver_params,
                runner, 1, render_images, solver_timeout,
                transient_subdir=f"transient_a{i}", image_subdir=f"a{i}",
            )
        except (OpenFOAMError, Exception) as exc:  # noqa: BLE001
            outcome.error = f"{type(exc).__name__}: {exc}"
        outcomes.append(outcome)
        if progress:
            progress()
    return outcomes
