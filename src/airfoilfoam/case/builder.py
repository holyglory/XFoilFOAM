"""Assemble a complete simpleFoam case for one airfoil/AoA/speed."""
from __future__ import annotations

from pathlib import Path

from .. import physics
from ..airfoil import Airfoil
from ..meshing.base import BoundaryPatch
from ..models import CaseSpec, FluidProperties, MeshParams, RoughnessParams, SolverParams
from ..openfoam.foam_dict import Raw, dimensions, render_field, vector, write_foam_dict
from .turbulence import build_turbulence


class CaseBuilder:
    """Writes constant/, system/ and 0/ for a steady incompressible RANS run."""

    def __init__(
        self,
        airfoil: Airfoil,
        patches: list[BoundaryPatch],
        mesh_params: MeshParams,
        spec: CaseSpec,
        fluid: FluidProperties,
        roughness: RoughnessParams,
        solver: SolverParams,
        n_proc: int = 1,
    ):
        self.airfoil = airfoil
        self.patches = patches
        self.mesh_params = mesh_params
        self.spec = spec
        self.fluid = fluid
        self.roughness = roughness
        self.solver = solver
        self.n_proc = n_proc

        by_role = lambda r: [p.name for p in patches if p.role == r]  # noqa: E731
        self.wall = by_role("wall")[0]
        self.inlet = by_role("inlet")[0]
        self.outlet = by_role("outlet")[0]
        self.empty = by_role("empty")[0]

    # -- derived quantities ------------------------------------------------- #
    @property
    def nu(self) -> float:
        return self.fluid.nu

    @property
    def freestream_vector(self):
        return physics.freestream_vector(self.spec.speed, self.spec.aoa_deg)

    @property
    def reynolds(self) -> float:
        return physics.reynolds(self.spec.speed, self.spec.chord, self.nu)

    # -- writing ------------------------------------------------------------ #
    def write(self, case_dir: Path) -> None:
        self._case_dir = case_dir
        case_dir.mkdir(parents=True, exist_ok=True)
        turb = self._turbulence()
        self._write_constant(turb)
        self._write_system(turb)
        self._write_zero(turb)

    def _turbulence(self):
        return build_turbulence(
            model=self.solver.turbulence.model,
            speed=self.spec.speed,
            nu=self.nu,
            intensity=self.solver.turbulence.intensity,
            viscosity_ratio=self.solver.turbulence.viscosity_ratio,
            roughness=self.roughness,
            wall=self.wall,
            inlet=self.inlet,
            outlet=self.outlet,
            empty=self.empty,
        )

    # -- constant/ ---------------------------------------------------------- #
    def _write_constant(self, turb) -> None:
        write_foam_dict(
            self._p("constant", "transportProperties"),
            "dictionary",
            "transportProperties",
            {
                "transportModel": "Newtonian",
                "nu": Raw(f"{dimensions(0, 2, -1, 0, 0, 0, 0)} {self.nu:.10g}"),
            },
        )
        write_foam_dict(
            self._p("constant", "turbulenceProperties"),
            "dictionary",
            "turbulenceProperties",
            {
                "simulationType": "RAS",
                "RAS": {
                    "RASModel": turb.ras_model,
                    "turbulence": "on",
                    "printCoeffs": "on",
                },
            },
        )

    # -- system/ ------------------------------------------------------------ #
    def _write_system(self, turb) -> None:
        self._write_control_dict()
        self._write_fv_schemes(turb)
        self._write_fv_solution(turb)
        if self.n_proc > 1:
            self._write_decompose()

    def _force_coeffs_dict(self) -> dict:
        fv = self.freestream_vector
        chord = self.spec.chord
        span = self.mesh_params.span_chords * chord
        area = chord * span
        return {
            "type": "forceCoeffs",
            "libs": ["forces"],
            "writeControl": "timeStep",
            "writeInterval": 1,
            "log": "no",
            "patches": [self.wall],
            "rho": "rhoInf",
            "rhoInf": self.fluid.density,
            "magUInf": self.spec.speed,
            "lRef": chord,
            "Aref": area,
            "liftDir": vector(*fv.lift_dir),
            "dragDir": vector(*fv.drag_dir),
            "CofR": vector(0.25 * chord, 0.0, 0.0),
            "pitchAxis": vector(0, 0, 1),
        }

    def _write_control_dict(self) -> None:
        force_coeffs = self._force_coeffs_dict()
        write_foam_dict(
            self._p("system", "controlDict"),
            "dictionary",
            "controlDict",
            {
                "application": "simpleFoam",
                "startFrom": "startTime",
                "startTime": 0,
                "stopAt": "endTime",
                "endTime": self.solver.n_iterations,
                "deltaT": 1,
                "writeControl": "timeStep",
                "writeInterval": self.solver.n_iterations,
                "purgeWrite": 0,
                "writeFormat": "ascii",
                "writePrecision": 8,
                "writeCompression": "off",
                "timeFormat": "general",
                "runTimeModifiable": "true",
                "functions": {"forceCoeffs1": force_coeffs},
            },
        )

    def _write_fv_schemes(self, turb) -> None:
        u_scheme = (
            "bounded Gauss upwind"
            if self.solver.momentum_scheme == "upwind"
            else "bounded Gauss linearUpwind grad(U)"
        )
        div = {
            "default": "none",
            "div(phi,U)": u_scheme,
            "div((nuEff*dev2(T(grad(U)))))": "Gauss linear",
        }
        div.update(turb.div_schemes)
        write_foam_dict(
            self._p("system", "fvSchemes"),
            "dictionary",
            "fvSchemes",
            {
                "ddtSchemes": {"default": "steadyState"},
                "gradSchemes": {
                    "default": "Gauss linear",
                    "grad(U)": "cellLimited Gauss linear 1",
                    "limitedGrad": "cellLimited Gauss linear 1",
                },
                "divSchemes": div,
                "laplacianSchemes": {"default": "Gauss linear corrected"},
                "interpolationSchemes": {"default": "linear"},
                "snGradSchemes": {"default": "corrected"},
                "wallDist": {"method": "meshWave"},
            },
        )

    def _write_fv_solution(self, turb) -> None:
        turb_vars = "|".join(turb.solver_vars)
        # Plain SIMPLE with conservative under-relaxation. SIMPLEC is faster but
        # sets up a 2-iteration limit-cycle oscillation in the forces on this
        # non-orthogonal C-grid; under-relaxed plain SIMPLE converges to a steady
        # state and stays stable for the delicate symmetric (AoA=0) case.
        relax_eq = {"U": 0.7}
        relax_eq.update({k: 0.5 for k in turb.relaxation})
        residual = {"p": self.solver.convergence_tolerance, "U": self.solver.convergence_tolerance}
        for v in turb.residual_controls:
            residual[v] = self.solver.convergence_tolerance
        write_foam_dict(
            self._p("system", "fvSolution"),
            "dictionary",
            "fvSolution",
            {
                "solvers": {
                    "p": {
                        "solver": "GAMG",
                        "smoother": "GaussSeidel",
                        "tolerance": 1e-7,
                        "relTol": 0.05,
                    },
                    "Phi": {
                        "solver": "GAMG",
                        "smoother": "DIC",
                        "tolerance": 1e-6,
                        "relTol": 0.01,
                    },
                    f'"({turb_vars}|U)"': {
                        "solver": "smoothSolver",
                        "smoother": "symGaussSeidel",
                        "tolerance": 1e-8,
                        "relTol": 0.1,
                    },
                },
                "potentialFlow": {"nNonOrthogonalCorrectors": 10},
                "SIMPLE": {
                    "nNonOrthogonalCorrectors": 2,
                    "consistent": "no",
                    "residualControl": residual,
                },
                "relaxationFactors": {"fields": {"p": 0.3}, "equations": relax_eq},
            },
        )

    # -- transient (URANS) overrides --------------------------------------- #
    def write_transient(
        self,
        case_dir: Path,
        start_time: float,
        end_time: float,
        delta_t: float,
        write_interval: float | None = None,
        max_delta_t: float | None = None,
    ) -> None:
        """Rewrite system/ for a transient pimpleFoam run that continues from the
        latest (steady) field. Keeps 0/ and constant/ untouched."""
        self._case_dir = case_dir
        turb = self._turbulence()
        self._write_transient_control_dict(start_time, end_time, delta_t, write_interval, max_delta_t)
        self._write_transient_schemes(turb)
        self._write_transient_solution(turb)

    def _write_transient_control_dict(self, start_time, end_time, delta_t, write_interval=None, max_delta_t=None) -> None:
        run_time = end_time - start_time
        write_foam_dict(
            self._p("system", "controlDict"),
            "dictionary",
            "controlDict",
            {
                "application": "pimpleFoam",
                "startFrom": "latestTime",
                "startTime": start_time,
                "stopAt": "endTime",
                "endTime": end_time,
                "deltaT": delta_t,
                "writeControl": "adjustableRunTime",
                # ~48 field snapshots, all retained (purgeWrite 0), so the URANS
                # animation has frames; the time-averaged forces use coefficient.dat
                # (accumulated separately, unaffected by these field writes).
                "writeInterval": write_interval if write_interval is not None else run_time / 48.0,
                "purgeWrite": 0,
                "writeFormat": "ascii",
                "writePrecision": 8,
                "writeCompression": "off",
                "timeFormat": "general",
                "runTimeModifiable": "true",
                "adjustTimeStep": "yes",
                "maxCo": self.solver.transient_max_courant,
                "maxDeltaT": max_delta_t if max_delta_t is not None else run_time / 50.0,
                "functions": {"forceCoeffs1": self._force_coeffs_dict()},
            },
        )

    def _write_transient_schemes(self, turb) -> None:
        div = {
            "default": "none",
            "div(phi,U)": "Gauss linearUpwind grad(U)",
            "div((nuEff*dev2(T(grad(U)))))": "Gauss linear",
        }
        div.update(turb.div_schemes)
        write_foam_dict(
            self._p("system", "fvSchemes"),
            "dictionary",
            "fvSchemes",
            {
                "ddtSchemes": {"default": "Euler"},  # 1st-order time, robust for URANS
                "gradSchemes": {"default": "Gauss linear", "grad(U)": "cellLimited Gauss linear 1"},
                "divSchemes": div,
                "laplacianSchemes": {"default": "Gauss linear corrected"},
                "interpolationSchemes": {"default": "linear"},
                "snGradSchemes": {"default": "corrected"},
                "wallDist": {"method": "meshWave"},
            },
        )

    def _write_transient_solution(self, turb) -> None:
        turb_vars = "|".join(turb.solver_vars)
        write_foam_dict(
            self._p("system", "fvSolution"),
            "dictionary",
            "fvSolution",
            {
                "solvers": {
                    # Prod 2026-07-09, s1223 c1 u50 Re 3.4M precalc:
                    # pFinal GAMG cap-saturation was the entire 4.6x per-step
                    # gap (DecisionHistory "Measured: why precalc URANS is slow").
                    # The pressure matrix is symmetric; DICGaussSeidel is the
                    # standard GAMG smoother for stretched/anisotropic near-wall
                    # layers. The capped pFinal residual sat at 2.7e-7..8.4e-7;
                    # a 1e-6 absolute floor is ample for incompressible force
                    # coefficients, and 3 PIMPLE outer correctors provide the
                    # remaining contraction.
                    "p": {"solver": "GAMG", "smoother": "DICGaussSeidel", "tolerance": 1e-7, "relTol": 0.05},
                    "pFinal": {"solver": "GAMG", "smoother": "DICGaussSeidel", "tolerance": 1e-6, "relTol": 0.0},
                    f'"({turb_vars}|U).*"': {
                        "solver": "smoothSolver",
                        "smoother": "symGaussSeidel",
                        "tolerance": 1e-8,
                        "relTol": 0.1,
                    },
                },
                # Several outer correctors with under-relaxation tighten the
                # pressure-velocity coupling each step, which is essential to keep
                # the violently-separated post-stall flow from diverging.
                "PIMPLE": {
                    "momentumPredictor": "yes",
                    "nOuterCorrectors": 3,
                    "nCorrectors": 2,
                    "nNonOrthogonalCorrectors": 1,
                },
                "relaxationFactors": {
                    "fields": {"p": 0.3},
                    "equations": {
                        "U": 0.7,
                        '"(k|omega|epsilon|nuTilda|gammaInt|ReThetat)"': 0.5,
                    },
                },
            },
        )

    def _write_decompose(self) -> None:
        write_foam_dict(
            self._p("system", "decomposeParDict"),
            "dictionary",
            "decomposeParDict",
            {
                "numberOfSubdomains": self.n_proc,
                "method": "scotch",
            },
        )

    # -- 0/ ----------------------------------------------------------------- #
    def _write_zero(self, turb) -> None:
        fv = self.freestream_vector
        u_free = Raw(f"uniform {vector(fv.ux, fv.uy, fv.uz)}")
        # U: fixed freestream at the inlet; inletOutlet at the outlet (zeroGradient
        # on outflow, clipped to zero on any backflow).
        u_boundary = {
            self.inlet: {"type": "fixedValue", "value": u_free},
            self.outlet: {
                "type": "inletOutlet",
                "inletValue": Raw(f"uniform {vector(0, 0, 0)}"),
                "value": u_free,
            },
            self.wall: {"type": "noSlip"},
            self.empty: {"type": "empty"},
        }
        self._write_field(
            "U", "volVectorField", dimensions(0, 1, -1, 0, 0, 0, 0),
            f"uniform {vector(fv.ux, fv.uy, fv.uz)}", u_boundary,
        )
        # p (kinematic): zeroGradient inlet, fixed reference at the outlet.
        p_boundary = {
            self.inlet: {"type": "zeroGradient"},
            self.outlet: {"type": "fixedValue", "value": Raw("uniform 0")},
            self.wall: {"type": "zeroGradient"},
            self.empty: {"type": "empty"},
        }
        self._write_field(
            "p", "volScalarField", dimensions(0, 2, -2, 0, 0, 0, 0), "uniform 0", p_boundary
        )
        # turbulence fields
        for spec in turb.fields:
            self._write_field(
                spec.object_name, spec.class_name, spec.dims, spec.internal, spec.boundary
            )

    def _write_field(self, name, class_name, dims, internal, boundary) -> None:
        text = render_field(class_name, name, dims, internal, boundary)
        path = self._p("0", name)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    # -- helpers ------------------------------------------------------------ #
    _case_dir: Path | None = None

    def _p(self, *parts: str) -> Path:
        assert self._case_dir is not None
        return self._case_dir.joinpath(*parts)
