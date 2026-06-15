"""Run a single CFD case end to end: mesh -> solve -> coefficients -> images."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from . import physics
from .airfoil import Airfoil
from .case.builder import CaseBuilder
from .meshing.base import Mesher
from .models import CaseSpec, FluidProperties, MeshParams, RoughnessParams, SolverParams
from .openfoam.runner import OpenFOAMError, RunResult, Runner
from .postprocess.forces import force_is_steady, parse_force_coefficients, parse_y_plus
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
    converged: bool = False
    iterations: Optional[int] = None
    final_residual: Optional[float] = None
    y_plus_avg: Optional[float] = None
    y_plus_max: Optional[float] = None
    n_cells: int = 0
    first_order_fallback: bool = False
    images: dict[str, str] = field(default_factory=dict)  # field -> path relative to case dir
    error: Optional[str] = None


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

        # 5. force coefficients
        coeff_files = sorted(case_dir.glob("postProcessing/forceCoeffs1/*/coefficient.dat"))
        if not coeff_files:
            raise OpenFOAMError("forceCoeffs produced no coefficient.dat")
        coeffs = parse_force_coefficients(coeff_files[-1])
        outcome.cl, outcome.cd, outcome.cm = coeffs.cl, coeffs.cd, coeffs.cm
        outcome.cl_cd = coeffs.cl_cd
        # Treat steady integrated forces as converged even if the residual plateaus.
        if not outcome.converged and force_is_steady(coeff_files[-1]):
            outcome.converged = True

        # 6. y+
        runner.application(case_dir, "simpleFoam -postProcess -func yPlus -latestTime")
        yplus_files = sorted(case_dir.glob("postProcessing/yPlus/*/yPlus.dat"))
        if yplus_files:
            outcome.y_plus_avg, outcome.y_plus_max = parse_y_plus(yplus_files[-1])

        # 7. images
        if render_images and solver_params.write_images:
            runner.application(case_dir, "foamToVTK -latestTime").check()
            imgs = render_contours(
                case_dir,
                case_dir / "images",
                airfoil.contour,
                spec.chord,
                solver_params.write_images,
                zoom_chords=solver_params.image_zoom_chords,
                title_suffix=f"{airfoil.name} a={spec.aoa_deg:g}deg U={spec.speed:g}",
            )
            outcome.images = {k: f"images/{v}" for k, v in imgs.items()}

    except (OpenFOAMError, Exception) as exc:  # noqa: BLE001 - report, don't crash the batch
        outcome.error = f"{type(exc).__name__}: {exc}"

    return outcome
