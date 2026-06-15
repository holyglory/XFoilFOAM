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
        self.freestream = by_role("freestream")[0]
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
            freestream=self.freestream,
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

    def _write_control_dict(self) -> None:
        fv = self.freestream_vector
        chord = self.spec.chord
        span = self.mesh_params.span_chords * chord
        area = chord * span
        force_coeffs = {
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
                "runTimeModifiable": "false",
                "functions": {"forceCoeffs1": force_coeffs},
            },
        )

    def _write_fv_schemes(self, turb) -> None:
        div = {
            "default": "none",
            "div(phi,U)": "bounded Gauss linearUpwind grad(U)",
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
                # 'limited 0.5' keeps the laplacian/snGrad stable on the non-orthogonal
                # cells near the trailing-edge wake cut of the C-grid.
                "laplacianSchemes": {"default": "Gauss linear limited corrected 0.5"},
                "interpolationSchemes": {"default": "linear"},
                "snGradSchemes": {"default": "limited corrected 0.5"},
                "wallDist": {"method": "meshWave"},
            },
        )

    def _write_fv_solution(self, turb) -> None:
        turb_vars = "|".join(turb.solver_vars)
        # Conservative relaxation -> robust on the non-orthogonal C-grid; SIMPLEC
        # (consistent) is faster but diverges late on poor cells, so use plain SIMPLE.
        relax_eq = {"U": 0.7}
        relax_eq.update(turb.relaxation)
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
                "relaxationFactors": {
                    "fields": {"p": 0.3},
                    "equations": relax_eq,
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
        # U
        u_boundary = {
            self.freestream: {
                "type": "freestreamVelocity",
                "freestreamValue": Raw(f"uniform {vector(fv.ux, fv.uy, fv.uz)}"),
            },
            self.wall: {"type": "noSlip"},
            self.empty: {"type": "empty"},
        }
        self._write_field(
            "U", "volVectorField", dimensions(0, 1, -1, 0, 0, 0, 0),
            f"uniform {vector(fv.ux, fv.uy, fv.uz)}", u_boundary,
        )
        # p (kinematic)
        p_boundary = {
            self.freestream: {"type": "freestreamPressure", "freestreamValue": Raw("uniform 0")},
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
