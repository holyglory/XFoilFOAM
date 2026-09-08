"""Explicit gas calorics and transport used by compressible case recipes."""

from __future__ import annotations

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .calorics import Nasa7Calorics
from .thermophysical_constants import OPENCFD2606_UNIVERSAL_GAS_CONSTANT
from .transport import PolynomialTransport


class ThermodynamicState(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, frozen=True)
    temperature_k: float = Field(gt=0)
    pressure_pa: float = Field(gt=0)


class GasThermodynamics(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, frozen=True)
    equation_of_state: Literal["perfect_gas"] = "perfect_gas"
    heat_capacity_model: Literal["constant_cp", "nasa7"] = "constant_cp"
    gas_constant: float = Field(gt=0)
    heat_capacity_cp: float | None = Field(default=None, gt=0)
    nasa7: Nasa7Calorics | None = None
    transport_model: Literal["constant", "sutherland", "polynomial"]
    polynomial_transport: PolynomialTransport | None = None
    reference_dynamic_viscosity: float = Field(gt=0)
    reference_temperature_k: float = Field(gt=0)
    sutherland_temperature_k: float | None = Field(default=None, ge=0)
    prandtl: float | None = Field(default=None, gt=0)
    provenance: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_constitutive_model(self) -> "GasThermodynamics":
        if self.heat_capacity_model == "constant_cp":
            if self.heat_capacity_cp is None or self.heat_capacity_cp <= self.gas_constant or self.nasa7 is not None:
                raise ValueError("Perfect-gas constant heat capacity must exceed its gas constant and exclude NASA7 coefficients")
        elif self.nasa7 is None or self.heat_capacity_cp is not None or self.transport_model not in {"sutherland", "polynomial"}:
            raise ValueError("NASA7 requires explicit coefficients and Sutherland or registered polynomial transport, not constant heat capacity")
        if self.transport_model == "constant":
            if self.prandtl is None or self.sutherland_temperature_k is not None:
                raise ValueError("Constant transport needs explicit Prandtl and no Sutherland coefficient")
        elif self.transport_model == "sutherland" and (self.sutherland_temperature_k is None or self.prandtl is not None):
            raise ValueError("Sutherland transport needs its coefficient and uses OpenFOAM's Eucken conductivity, not a supplied Prandtl")
        if self.transport_model == "polynomial":
            transport = self.polynomial_transport
            if transport is None or self.nasa7 is None or self.sutherland_temperature_k is not None or self.prandtl is not None:
                raise ValueError("Polynomial transport requires explicit coefficients, NASA7 calorics and no Sutherland or Prandtl override")
            if transport.minimum_temperature_k > self.nasa7.minimum_temperature_k or transport.maximum_temperature_k < self.nasa7.maximum_temperature_k:
                raise ValueError("Polynomial transport must cover the entire declared caloric temperature range")
            if not math.isclose(transport.dynamic_viscosity(self.reference_temperature_k), self.reference_dynamic_viscosity, rel_tol=1e-10):
                raise ValueError("Reference viscosity differs from the explicit polynomial transport model")
        elif self.polynomial_transport is not None:
            raise ValueError("Non-polynomial transport must not contain polynomial coefficients")
        self.heat_capacity_at(self.reference_temperature_k)
        return self

    @property
    def gamma(self) -> float:
        if self.heat_capacity_cp is None:
            raise ValueError("Temperature-dependent heat capacity requires gamma_at with an explicit temperature")
        return self.heat_capacity_cp / (self.heat_capacity_cp - self.gas_constant)

    def heat_capacity_at(self, temperature_k: float) -> float:
        if not math.isfinite(temperature_k) or temperature_k <= 0:
            raise ValueError("Heat capacity temperature must be finite and positive")
        if self.nasa7 is not None:
            heat_capacity = self.gas_constant * self.nasa7.heat_capacity_ratio(temperature_k)
            if not math.isfinite(heat_capacity) or heat_capacity <= self.gas_constant:
                raise ValueError("Resolved heat capacity must be finite and exceed the gas constant")
            return heat_capacity
        assert self.heat_capacity_cp is not None
        return self.heat_capacity_cp

    def gamma_at(self, temperature_k: float) -> float:
        heat_capacity = self.heat_capacity_at(temperature_k)
        return heat_capacity / (heat_capacity - self.gas_constant)

    def density(self, state: ThermodynamicState) -> float:
        self.heat_capacity_at(state.temperature_k)
        return state.pressure_pa / (self.gas_constant * state.temperature_k)

    def speed_of_sound(self, state: ThermodynamicState) -> float:
        return math.sqrt(self.gamma_at(state.temperature_k) * self.gas_constant * state.temperature_k)

    def validate_adiabatic_temperature_range(self, temperature_k: float, speed_mps: float) -> None:
        heat_capacity = self.heat_capacity_at(temperature_k)
        if not math.isfinite(speed_mps) or speed_mps < 0:
            raise ValueError("Adiabatic temperature preflight requires a finite nonnegative speed")
        kinetic_energy = speed_mps * speed_mps / 2
        if not math.isfinite(kinetic_energy):
            raise ValueError("Adiabatic temperature preflight requires finite kinetic energy")
        if self.nasa7 is None:
            if not math.isfinite(temperature_k + kinetic_energy / heat_capacity):
                raise ValueError("The gas model cannot resolve a finite stagnation temperature")
            return
        maximum_enthalpy = self.nasa7.enthalpy_ratio(self.nasa7.maximum_temperature_k)
        static_enthalpy = self.nasa7.enthalpy_ratio(temperature_k)
        available_energy = self.gas_constant * (maximum_enthalpy - static_enthalpy)
        if not math.isfinite(available_energy) or available_energy < 0:
            raise ValueError("The gas model cannot resolve finite available stagnation enthalpy")
        if kinetic_energy > available_energy + max(1, available_energy) * 1e-12:
            raise ValueError("The requested flow's stagnation temperature exceeds the declared NASA7 material range")

    def dynamic_viscosity(self, temperature_k: float) -> float:
        if not math.isfinite(temperature_k) or temperature_k <= 0:
            raise ValueError("Transport temperature must be finite and positive")
        if self.transport_model == "constant":
            return self.reference_dynamic_viscosity
        if self.polynomial_transport is not None:
            return self.polynomial_transport.dynamic_viscosity(temperature_k)
        sutherland = self.sutherland_temperature_k
        assert sutherland is not None
        return self.reference_dynamic_viscosity * (temperature_k / self.reference_temperature_k) ** 1.5 * (
            self.reference_temperature_k + sutherland
        ) / (temperature_k + sutherland)

    def thermal_conductivity(self, temperature_k: float) -> float:
        heat_capacity = self.heat_capacity_at(temperature_k)
        if self.polynomial_transport is not None:
            return self.polynomial_transport.thermal_conductivity(temperature_k)
        viscosity = self.dynamic_viscosity(temperature_k)
        if self.transport_model == "constant":
            assert self.prandtl is not None
            return viscosity * heat_capacity / self.prandtl
        return viscosity * (1.32 * (heat_capacity - self.gas_constant) + 1.77 * self.gas_constant)

    def openfoam_dictionary(self) -> dict:
        if self.transport_model == "constant":
            transport = {"mu": self.reference_dynamic_viscosity, "Pr": self.prandtl}
        elif self.polynomial_transport is not None:
            transport = self.polynomial_transport.openfoam_dictionary()
        else:
            sutherland = self.sutherland_temperature_k
            assert sutherland is not None
            transport = {
                "As": self.reference_dynamic_viscosity * (1 + sutherland / self.reference_temperature_k) / math.sqrt(self.reference_temperature_k),
                "Ts": sutherland,
            }
        return {
            "thermoType": {
                "type": "hePsiThermo", "mixture": "pureMixture",
                "transport": "const" if self.transport_model == "constant" else ("polynomial" if self.polynomial_transport is not None else "sutherland"),
                "thermo": "janaf" if self.nasa7 is not None else "hConst", "equationOfState": "perfectGas",
                "specie": "specie", "energy": "sensibleInternalEnergy",
            },
            "mixture": {
                "specie": {"molWeight": OPENCFD2606_UNIVERSAL_GAS_CONSTANT / self.gas_constant},
                "thermodynamics": self.nasa7.openfoam_dictionary() if self.nasa7 is not None else {"Cp": self.heat_capacity_cp, "Hf": 0},
                "transport": transport,
            },
        }


class CompressibleTimeWindow(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, frozen=True)
    start_time: float = Field(ge=0)
    end_time: float = Field(gt=0)
    delta_t: float = Field(gt=0)
    maximum_delta_t: float = Field(gt=0)
    write_interval: float = Field(gt=0)
    maximum_courant: float = Field(gt=0, le=0.5)

    @model_validator(mode="after")
    def validate_window(self) -> "CompressibleTimeWindow":
        if self.end_time <= self.start_time or self.delta_t > self.maximum_delta_t:
            raise ValueError("Compressible physical-time window or initial step is invalid")
        if self.write_interval > self.end_time - self.start_time:
            raise ValueError("Physical-time window must retain field output")
        return self


def pressure_coefficient(pressure: float, state: ThermodynamicState, density: float, speed: float) -> float:
    if not all(math.isfinite(value) for value in (pressure, density, speed)) or density <= 0 or speed <= 0:
        raise ValueError("Pressure coefficient requires finite pressure and positive reference density/speed")
    return (pressure - state.pressure_pa) / (0.5 * density * speed ** 2)
