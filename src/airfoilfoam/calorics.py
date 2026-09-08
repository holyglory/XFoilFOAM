from __future__ import annotations

import math

import numpy as np
from numpy.polynomial import Polynomial
from pydantic import BaseModel, ConfigDict, Field, model_validator

from .thermophysical_constants import OPENCFD2606_STANDARD_PRESSURE_PA


class Nasa7Calorics(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False, frozen=True)
    minimum_temperature_k: float = Field(gt=0)
    common_temperature_k: float = Field(gt=0)
    maximum_temperature_k: float = Field(gt=0)
    entropy_reference_pressure_pa: float = Field(default=OPENCFD2606_STANDARD_PRESSURE_PA, gt=0)
    low_coefficients: tuple[float, float, float, float, float, float, float]
    high_coefficients: tuple[float, float, float, float, float, float, float]
    maximum_join_relative_error: float = Field(default=1e-4, gt=0, le=0.01)
    provenance: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_temperature_domain(self) -> "Nasa7Calorics":
        if not self.minimum_temperature_k < self.common_temperature_k < self.maximum_temperature_k:
            raise ValueError("NASA7 requires ordered positive temperature bounds")
        for coefficients, lower, upper in (
            (self.low_coefficients, self.minimum_temperature_k, self.common_temperature_k),
            (self.high_coefficients, self.common_temperature_k, self.maximum_temperature_k),
        ):
            try:
                with np.errstate(over="raise", invalid="raise"):
                    polynomial = Polynomial(coefficients[:5])(Polynomial([lower, upper - lower]))
                    critical = polynomial.deriv().roots()
                    samples = [0.0, 1.0] + [float(root.real) for root in critical if abs(root.imag) < 1e-10 and 0 < root.real < 1]
                    heat_capacities = polynomial(np.asarray(samples))
            except (FloatingPointError, np.linalg.LinAlgError) as error:
                raise ValueError("NASA7 coefficients cannot resolve finite heat capacity over their declared range") from error
            if not np.all(np.isfinite(heat_capacities)) or np.any(heat_capacities <= 1):
                raise ValueError("NASA7 heat capacity must exceed the gas constant throughout its declared range")
        temperature = self.common_temperature_k
        low_cp = float(Polynomial(self.low_coefficients[:5])(temperature))
        high_cp = float(Polynomial(self.high_coefficients[:5])(temperature))
        scale = max(low_cp, high_cp)
        for lower, upper, normalizer in (
            (low_cp, high_cp, scale),
            (self._enthalpy_ratio(self.low_coefficients, temperature), self._enthalpy_ratio(self.high_coefficients, temperature), scale * temperature),
            (self._entropy_ratio(self.low_coefficients, temperature), self._entropy_ratio(self.high_coefficients, temperature), scale),
        ):
            if not math.isfinite(lower) or not math.isfinite(upper) or abs(lower - upper) / normalizer > self.maximum_join_relative_error:
                raise ValueError("NASA7 heat capacity, enthalpy and entropy must join within the explicit relative tolerance")
        return self

    def coefficients_at(self, temperature_k: float) -> tuple[float, ...]:
        if not math.isfinite(temperature_k) or not self.minimum_temperature_k <= temperature_k <= self.maximum_temperature_k:
            raise ValueError("Temperature is outside the declared NASA7 material range")
        return self.low_coefficients if temperature_k < self.common_temperature_k else self.high_coefficients

    def heat_capacity_ratio(self, temperature_k: float) -> float:
        coefficients = self.coefficients_at(temperature_k)
        return float(Polynomial(coefficients[:5])(temperature_k))

    def enthalpy_ratio(self, temperature_k: float) -> float:
        coefficients = self.coefficients_at(temperature_k)
        return self._enthalpy_ratio(coefficients, temperature_k)

    def entropy_ratio(self, temperature_k: float) -> float:
        return self._entropy_ratio(self.coefficients_at(temperature_k), temperature_k)

    @staticmethod
    def _enthalpy_ratio(coefficients: tuple[float, ...], temperature_k: float) -> float:
        return float(Polynomial([coefficients[5], *(value / (index + 1) for index, value in enumerate(coefficients[:5]))])(temperature_k))

    @staticmethod
    def _entropy_ratio(coefficients: tuple[float, ...], temperature_k: float) -> float:
        return coefficients[0] * math.log(temperature_k) + sum(value * temperature_k ** index / index for index, value in enumerate(coefficients[1:5], 1)) + coefficients[6]

    def openfoam_dictionary(self) -> dict:
        entropy_offset = math.log(self.entropy_reference_pressure_pa) - math.log(OPENCFD2606_STANDARD_PRESSURE_PA)
        low = [*self.low_coefficients[:6], self.low_coefficients[6] + entropy_offset]
        high = [*self.high_coefficients[:6], self.high_coefficients[6] + entropy_offset]
        return {
            "Tlow": self.minimum_temperature_k,
            "Thigh": self.maximum_temperature_k,
            "Tcommon": self.common_temperature_k,
            "lowCpCoeffs": low,
            "highCpCoeffs": high,
        }
