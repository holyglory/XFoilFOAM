from __future__ import annotations

import math

import numpy as np
from numpy.polynomial import Polynomial
from pydantic import BaseModel, ConfigDict, Field, model_validator


class PolynomialTransport(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, frozen=True)
    minimum_temperature_k: float = Field(gt=0)
    maximum_temperature_k: float = Field(gt=0)
    dynamic_viscosity_coefficients: tuple[float, float, float, float, float, float, float, float]
    thermal_conductivity_coefficients: tuple[float, float, float, float, float, float, float, float]
    provenance: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_transport_domain(self) -> "PolynomialTransport":
        if self.minimum_temperature_k >= self.maximum_temperature_k:
            raise ValueError("Polynomial transport requires ordered positive temperature bounds")
        for coefficients in (self.dynamic_viscosity_coefficients, self.thermal_conductivity_coefficients):
            try:
                with np.errstate(over="raise", invalid="raise"):
                    polynomial = Polynomial(coefficients)(Polynomial([
                        self.minimum_temperature_k, self.maximum_temperature_k - self.minimum_temperature_k,
                    ]))
                    critical = polynomial.deriv().roots()
                    locations = [0.0, 1.0] + [float(root.real) for root in critical if abs(root.imag) < 1e-10 and 0 < root.real < 1]
                    values = polynomial(np.asarray(locations))
            except (FloatingPointError, np.linalg.LinAlgError) as error:
                raise ValueError("Polynomial transport cannot resolve its declared temperature domain") from error
            if not np.all(np.isfinite(values)) or np.any(values <= 0):
                raise ValueError("Polynomial transport must remain finite and positive throughout its declared range")
        return self

    def _evaluate(self, coefficients: tuple[float, ...], temperature_k: float) -> float:
        if not math.isfinite(temperature_k) or not self.minimum_temperature_k <= temperature_k <= self.maximum_temperature_k:
            raise ValueError("Temperature is outside the declared polynomial transport range")
        value = float(Polynomial(coefficients)(temperature_k))
        if not math.isfinite(value) or value <= 0:
            raise ValueError("Polynomial transport resolved a nonpositive or nonfinite value")
        return value

    def dynamic_viscosity(self, temperature_k: float) -> float:
        return self._evaluate(self.dynamic_viscosity_coefficients, temperature_k)

    def thermal_conductivity(self, temperature_k: float) -> float:
        return self._evaluate(self.thermal_conductivity_coefficients, temperature_k)

    def openfoam_dictionary(self) -> dict:
        return {
            "muCoeffs<8>": list(self.dynamic_viscosity_coefficients),
            "kappaCoeffs<8>": list(self.thermal_conductivity_coefficients),
        }
