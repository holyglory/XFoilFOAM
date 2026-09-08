"""OpenCFD 2606 pressure-based and density-based gas case dictionaries."""

from __future__ import annotations

from dataclasses import replace
import json
import math
from typing import Literal

from .. import physics
from ..openfoam.foam_dict import Raw, dimensions, vector, write_foam_dict
from ..thermodynamics import CompressibleTimeWindow, GasThermodynamics, ThermodynamicState
from .builder import CaseBuilder


class CompressibleCaseBuilder(CaseBuilder):
    def __init__(self, *args, gas: GasThermodynamics, state: ThermodynamicState,
                 solver_family: Literal["rhoSimpleFoam", "rhoPimpleFoam", "rhoCentralFoam"],
                 turbulent_prandtl: float, time_window: CompressibleTimeWindow | None = None, **kwargs):
        super().__init__(*args, **kwargs)
        if self.dialect.identity.distribution != "opencfd" or self.dialect.identity.version != "2606":
            raise ValueError("Compressible dictionaries require the pinned OpenCFD 2606 adapter")
        if solver_family not in {"rhoSimpleFoam", "rhoPimpleFoam", "rhoCentralFoam"}:
            raise ValueError("Unsupported compressible solver family")
        if self.solver.turbulence.model.value != "kOmegaSST":
            raise ValueError("The progressive compressible recipe currently requires fully turbulent SST")
        if not math.isfinite(turbulent_prandtl) or turbulent_prandtl <= 0:
            raise ValueError("Turbulent Prandtl must be explicit and positive")
        if not math.isclose(self.fluid.density, gas.density(state), rel_tol=1e-6):
            raise ValueError("Force reference density differs from the gas operating state")
        if not math.isclose(self.fluid.nu * self.fluid.density, gas.dynamic_viscosity(state.temperature_k), rel_tol=1e-6):
            raise ValueError("Reference viscosity differs from the resolved gas transport law")
        mach = self.spec.speed / gas.speed_of_sound(state)
        if not math.isfinite(mach) or mach <= 0 or (mach > 3 and not math.isclose(mach, 3, rel_tol=0, abs_tol=1e-12)):
            raise ValueError("The progressive compressible recipe is restricted to Mach 0 through 3")
        if solver_family == "rhoCentralFoam" and mach < 1.2 and not math.isclose(mach, 1.2, rel_tol=0, abs_tol=1e-12):
            raise ValueError("The density-based progressive recipe requires Mach at least 1.2")
        if solver_family != "rhoSimpleFoam" and time_window is None and not (solver_family == "rhoCentralFoam" and not self.solver.force_transient):
            raise ValueError("Transient compressible solvers require an explicit physical-time window")
        self.gas = gas
        self.state = state
        self.solver_family = solver_family
        self.turbulent_prandtl = turbulent_prandtl
        self.time_window = time_window
        self.local_steady = solver_family == "rhoCentralFoam" and not self.solver.force_transient
        self.dialect = replace(
            self.dialect, steady_solver_command=solver_family,
            transient_solver_command="rhoCentralFoam" if solver_family == "rhoCentralFoam" else "rhoPimpleFoam",
            control_solver_value_steady=solver_family,
            control_solver_value_transient="rhoCentralFoam" if solver_family == "rhoCentralFoam" else "rhoPimpleFoam",
            y_plus_command=f"{solver_family} -postProcess -func yPlus -latestTime",
        )

    def _write_constant(self, turb) -> None:
        write_foam_dict(self._p("constant", "thermophysicalProperties"), "dictionary", "thermophysicalProperties", self.gas.openfoam_dictionary())
        write_foam_dict(self._p("constant", "turbulenceProperties"), "dictionary", "turbulenceProperties", {
            "simulationType": "RAS", "RAS": {"RASModel": turb.ras_model, "turbulence": "on", "printCoeffs": "on"},
        })
        self._p("constant", "aerodynamicReference.json").write_text(json.dumps({
            "version": 1, "pressure_kind": "absolute", "pressure_pa": self.state.pressure_pa,
            "temperature_k": self.state.temperature_k, "density": self.fluid.density,
            "speed": self.spec.speed, "gas_model": self.gas.model_dump(),
        }, sort_keys=True, allow_nan=False) + "\n")
        self._write_numerical_execution()

    def _write_numerical_execution(self) -> None:
        self._p("constant", "numericalExecution.json").write_text(json.dumps({
            "version": 1, "solver_family": self.solver_family,
            "time_coordinate": "local_pseudo_time_iterations" if self.local_steady else "steady_iterations" if self.solver_family == "rhoSimpleFoam" else "physical_time_seconds",
            "physical_time_history": self.solver_family != "rhoSimpleFoam" and not self.local_steady,
        }, sort_keys=True) + "\n")

    def _force_coeffs_dict(self) -> dict:
        coefficients = super()._force_coeffs_dict()
        coefficients["rho"] = "rho"
        coefficients["pRef"] = self.state.pressure_pa
        return coefficients

    def _write_control_dict(self) -> None:
        if self.local_steady:
            energy = self.gas.heat_capacity_at(self.state.temperature_k) * self.state.temperature_k + 0.5 * self.spec.speed ** 2
            turbulent_energy = physics.freestream_k(self.spec.speed, self.solver.turbulence.intensity)
            turbulent_frequency = physics.freestream_omega(turbulent_energy, self.fluid.nu, self.solver.turbulence.viscosity_ratio)
            write_foam_dict(self._p("system", "controlDict"), "dictionary", "controlDict", {
                "application": "rhoCentralFoam", "startFrom": "startTime", "startTime": 0,
                "stopAt": "endTime", "endTime": self.solver.n_iterations, "deltaT": 1,
                "adjustTimeStep": "no", "maxCo": min(0.5, self.solver.transient_max_courant),
                "maxDeltaT": self.spec.chord / self.spec.speed,
                "rDeltaTSmoothingCoeff": 0.02, "writeControl": "timeStep", "writeInterval": 100,
                "purgeWrite": 2, "writeFormat": "ascii", "writePrecision": 12, "writeCompression": "off",
                "timeFormat": "general", "timePrecision": 12, "runTimeModifiable": "true",
                "functions": {"forceCoeffs1": self._force_coeffs_dict(), "steadyConvergence": {
                    "type": "xfoilfoamSteadyConvergence", "executeControl": "timeStep", "executeInterval": 1,
                    "referenceDensity": self.fluid.density, "referenceSpeed": self.spec.speed,
                    "referenceLength": self.spec.chord, "referenceSpecificEnergy": energy,
                    "referenceTurbulenceEnergy": turbulent_energy, "referenceTurbulenceFrequency": turbulent_frequency,
                    "tolerance": self.solver.convergence_tolerance, "consecutiveSteps": 100,
                }}, **self._control_library_entries(),
            })
            return
        if self.solver_family == "rhoSimpleFoam":
            super()._write_control_dict()
            return
        window = self.time_window
        assert window is not None
        write_foam_dict(self._p("system", "controlDict"), "dictionary", "controlDict", {
            "application": self.solver_family, "startFrom": "startTime", "startTime": window.start_time,
            "stopAt": "endTime", "endTime": window.end_time, "deltaT": window.delta_t,
            "adjustTimeStep": "yes", "maxCo": window.maximum_courant, "maxDeltaT": window.maximum_delta_t,
            "writeControl": "runTime", "writeInterval": window.write_interval,
            "purgeWrite": 0, "writeFormat": "ascii", "writePrecision": 12,
            "writeCompression": "off", "timeFormat": "general", "timePrecision": 12,
            "runTimeModifiable": "true", "functions": {"forceCoeffs1": self._force_coeffs_dict()},
            **self._control_library_entries(),
        })

    def _control_library_entries(self) -> dict:
        libraries = []
        if self.gas.transport_model == "polynomial":
            libraries.append(Raw('"/opt/xfoilfoam-thermophysics/lib/libxfoilfoamThermophysics.so"'))
        if self.local_steady:
            libraries.append(Raw('"/opt/xfoilfoam-thermophysics/lib/libxfoilfoamSteadyConvergence.so"'))
        return {"libs": libraries} if libraries else {}

    def _write_fv_schemes(self, turb) -> None:
        transient = self.solver_family != "rhoSimpleFoam"
        schemes = {
            "ddtSchemes": {"default": "localEuler" if self.local_steady else "Euler" if transient else "steadyState"},
            "gradSchemes": {"default": "Gauss linear", "limited": "cellLimited Gauss linear 1", "grad(U)": "$limited"},
            "laplacianSchemes": {"default": "Gauss linear corrected"},
            "interpolationSchemes": {"default": "linear"},
            "snGradSchemes": {"default": "corrected"}, "wallDist": {"method": "meshWave"},
        }
        if self.solver_family == "rhoCentralFoam":
            schemes["fluxScheme"] = "Kurganov"
            schemes["divSchemes"] = {"default": "none", "div(tauMC)": "Gauss linear", **turb.div_schemes}
            first_order = self.solver.momentum_scheme == "upwind"
            schemes["interpolationSchemes"].update({
                "reconstruct(rho)": "upwind" if first_order else "vanLeer",
                "reconstruct(U)": "upwind" if first_order else "vanLeerV",
                "reconstruct(T)": "upwind" if first_order else "vanLeer",
            })
        else:
            prefix = "" if transient else "bounded "
            momentum = prefix + ("Gauss upwind" if self.solver.momentum_scheme == "upwind" else "Gauss linearUpwind limited")
            schemes["divSchemes"] = {
                "default": "none", "div(phi,U)": momentum, "div(phi,e)": momentum,
                "div(phi,K)": momentum, "div(phi,Ekp)": momentum,
                "div(phiv,p)": "Gauss upwind",
                "div(phid,p)": "Gauss upwind", "div((phi|interpolate(rho)),p)": prefix + "Gauss upwind",
                "div(((rho*nuEff)*dev2(T(grad(U)))))": "Gauss linear", **turb.div_schemes,
            }
        write_foam_dict(self._p("system", "fvSchemes"), "dictionary", "fvSchemes", schemes)

    def _write_fv_solution(self, turb) -> None:
        transport = {"solver": "PBiCGStab", "preconditioner": "DILU", "tolerance": 1e-8, "relTol": 0.01}
        pressure = {"solver": "GAMG", "smoother": "GaussSeidel", "tolerance": 1e-7, "relTol": 0.01}
        variables = "|".join(["U", "e", "h", *turb.solver_vars])
        solution = {"solvers": {"p": pressure, "pFinal": {**pressure, "relTol": 0},
                                f'"({variables})"': transport, f'"({variables})Final"': {**transport, "relTol": 0}}}
        if self.solver_family == "rhoCentralFoam":
            solution["solvers"]['"(rho|rhoU|rhoE)"'] = {"solver": "diagonal"}
            diffusion = {"solver": "smoothSolver", "smoother": "symGaussSeidel", "nSweeps": 2, "tolerance": 1e-9, "relTol": 0.01}
            for variable in ["U", "e", "h"]:
                solution["solvers"][variable] = diffusion.copy()
                solution["solvers"][f"{variable}Final"] = {**diffusion, "relTol": 0}
        else:
            solution["solvers"]["Phi"] = {"solver": "GAMG", "smoother": "DIC", "tolerance": 1e-6, "relTol": 0.01}
            solution["potentialFlow"] = {"nNonOrthogonalCorrectors": 10}
            if self.solver_family == "rhoSimpleFoam":
                solution["SIMPLE"] = {"nNonOrthogonalCorrectors": 1, "consistent": "no", "pMinFactor": 0.1, "pMaxFactor": 2,
                                      "transonic": "no", "residualControl": {name: self.solver.convergence_tolerance for name in ["p", "U", "e", *turb.solver_vars]}}
            else:
                solution["solvers"]["rho"] = {"solver": "diagonal"}
                solution["solvers"]["rhoFinal"] = {"solver": "diagonal"}
                solution["PIMPLE"] = {"momentumPredictor": "yes", "nOuterCorrectors": 3, "nCorrectors": 2,
                                      "nNonOrthogonalCorrectors": 1, "transonic": "yes"}
            solution["relaxationFactors"] = {"fields": {"p": 0.3, "rho": 0.01}, "equations": {"U": 0.3 if self.solver_family == "rhoSimpleFoam" else 0.7, "e": 0.7, **{name: 0.5 for name in turb.solver_vars}}}
        write_foam_dict(self._p("system", "fvSolution"), "dictionary", "fvSolution", solution)

    def _write_zero(self, turb) -> None:
        freestream = self.freestream_vector
        velocity = f"uniform {vector(freestream.ux, freestream.uy, freestream.uz)}"
        pressure = f"uniform {self.state.pressure_pa:.12g}"
        temperature = f"uniform {self.state.temperature_k:.12g}"
        supersonic = self.solver_family == "rhoCentralFoam"
        self._write_field("U", "volVectorField", dimensions(0, 1, -1, 0, 0, 0, 0), velocity, {
            self.inlet: {"type": "fixedValue" if supersonic else "freestreamVelocity", "value": Raw(velocity), **({} if supersonic else {"freestreamValue": Raw(velocity)})},
            self.outlet: {"type": "zeroGradient"} if supersonic else {"type": "freestreamVelocity", "freestreamValue": Raw(velocity), "value": Raw(velocity)},
            self.wall: {"type": "noSlip"}, self.empty: {"type": "empty"},
        })
        self._write_field("p", "volScalarField", dimensions(1, -1, -2, 0, 0, 0, 0), pressure, {
            self.inlet: {"type": "fixedValue", "value": Raw(pressure)} if supersonic else {"type": "freestreamPressure", "freestreamValue": Raw(pressure)},
            self.outlet: {"type": "zeroGradient"} if supersonic else {"type": "freestreamPressure", "freestreamValue": Raw(pressure)},
            self.wall: {"type": "zeroGradient"}, self.empty: {"type": "empty"},
        })
        self._write_field("T", "volScalarField", dimensions(0, 0, 0, 1, 0, 0, 0), temperature, {
            self.inlet: {"type": "fixedValue", "value": Raw(temperature)},
            self.outlet: {"type": "zeroGradient"} if supersonic else {"type": "inletOutlet", "inletValue": Raw(temperature), "value": Raw(temperature)},
            self.wall: {"type": "zeroGradient"}, self.empty: {"type": "empty"},
        })
        self._write_field("alphat", "volScalarField", dimensions(1, -1, -1, 0, 0, 0, 0), "uniform 0", {
            self.inlet: {"type": "calculated", "value": Raw("uniform 0")},
            self.outlet: {"type": "calculated", "value": Raw("uniform 0")},
            self.wall: {"type": "compressible::alphatWallFunction", "Prt": self.turbulent_prandtl, "value": Raw("uniform 0")},
            self.empty: {"type": "empty"},
        })
        for field in turb.fields:
            self._write_field(field.object_name, field.class_name, field.dims, field.internal, field.boundary)

    def write_transient(self, case_dir, start_time, end_time, delta_t, write_interval=None, max_delta_t=None) -> None:
        if self.local_steady:
            raise ValueError("Local pseudo-time cannot be continued as physical-time URANS")
        if write_interval is None or max_delta_t is None:
            raise ValueError("Compressible continuation needs explicit physical step and retained-field cadence")
        self._case_dir = case_dir
        self.solver_family = "rhoCentralFoam" if self.solver_family == "rhoCentralFoam" else "rhoPimpleFoam"
        self.time_window = CompressibleTimeWindow(start_time=start_time, end_time=end_time, delta_t=delta_t,
                                                  maximum_delta_t=max_delta_t, write_interval=write_interval,
                                                  maximum_courant=min(0.5, self.solver.transient_max_courant))
        self._write_control_dict()
        turbulence = self._turbulence()
        self._write_fv_schemes(turbulence)
        self._write_fv_solution(turbulence)
        self._write_numerical_execution()
