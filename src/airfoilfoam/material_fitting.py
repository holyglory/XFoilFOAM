from __future__ import annotations

import math
from collections.abc import Sequence

import numpy as np
from numpy.polynomial import Polynomial

from .calorics import Nasa7Calorics
from .transport import PolynomialTransport
from .thermophysical_constants import OPENCFD2606_STANDARD_PRESSURE_PA


def _samples(temperatures: Sequence[float], values: Sequence[float], minimum_count: int):
    temperature = np.asarray(temperatures, dtype=float)
    measured = np.asarray(values, dtype=float)
    if (temperature.ndim != 1 or measured.shape != temperature.shape or len(temperature) < minimum_count
            or not np.all(np.isfinite(temperature)) or not np.all(np.isfinite(measured))
            or np.any(temperature <= 0) or np.any(measured <= 0) or np.any(np.diff(temperature) <= 0)):
        raise ValueError("Material fitting requires ordered distinct positive finite source samples")
    return temperature, measured


def fit_nasa7_calorics(
    temperatures: Sequence[float], heat_capacity_ratios: Sequence[float], *, common_temperature_k: float,
    reference_temperature_k: float, reference_enthalpy_ratio: float, reference_entropy_ratio: float,
    provenance: str, reference_pressure_pa: float = OPENCFD2606_STANDARD_PRESSURE_PA,
) -> Nasa7Calorics:
    temperature, heat_capacity = _samples(temperatures, heat_capacity_ratios, 12)
    if (not math.isfinite(common_temperature_k) or not temperature[0] < common_temperature_k < temperature[-1]
            or not np.all(heat_capacity > 1)
            or not temperature[0] <= reference_temperature_k < common_temperature_k
            or not math.isfinite(reference_enthalpy_ratio) or not math.isfinite(reference_entropy_ratio)):
        raise ValueError("NASA7 fit needs physical heat capacities, two branches and a finite lower-branch reference state")
    low = temperature < common_temperature_k
    if np.count_nonzero(low) < 6 or np.count_nonzero(~low) < 6:
        raise ValueError("NASA7 fit requires at least six source samples per branch")
    scaled = temperature / common_temperature_k
    powers = scaled[:, None] ** np.arange(5)
    design = np.zeros((len(temperature), 9))
    design[low, :5] = powers[low]
    design[~low, :5] = 1
    design[~low, 5:] = powers[~low, 1:] - 1
    coefficients, _, rank, _ = np.linalg.lstsq(design / heat_capacity[:, None], np.ones(len(temperature)), rcond=None)
    if rank != 9:
        raise ValueError("NASA7 source temperatures cannot determine both branches")
    low_cp = coefficients[:5] / common_temperature_k ** np.arange(5)
    high_scaled = np.r_[np.sum(coefficients[:5]) - np.sum(coefficients[5:]), coefficients[5:]]
    high_cp = high_scaled / common_temperature_k ** np.arange(5)
    low_enthalpy = Polynomial(low_cp).integ()
    high_enthalpy = Polynomial(high_cp).integ()
    low_offset = reference_enthalpy_ratio - float(low_enthalpy(reference_temperature_k))
    high_offset = float(low_enthalpy(common_temperature_k) + low_offset - high_enthalpy(common_temperature_k))

    def entropy_base(branch, value):
        return float(branch[0] * math.log(value) + sum(
            coefficient * value ** index / index for index, coefficient in enumerate(branch[1:], 1)
        ))

    low_entropy_offset = reference_entropy_ratio - entropy_base(low_cp, reference_temperature_k)
    high_entropy_offset = entropy_base(low_cp, common_temperature_k) + low_entropy_offset - entropy_base(high_cp, common_temperature_k)
    return Nasa7Calorics(
        minimum_temperature_k=float(temperature[0]), common_temperature_k=common_temperature_k,
        entropy_reference_pressure_pa=reference_pressure_pa,
        maximum_temperature_k=float(temperature[-1]),
        low_coefficients=tuple([*low_cp, low_offset, low_entropy_offset]),
        high_coefficients=tuple([*high_cp, high_offset, high_entropy_offset]),
        provenance=provenance,
    )


def fit_sutherland_transport(temperatures: Sequence[float], viscosities: Sequence[float]) -> dict[str, float]:
    temperature, viscosity = _samples(temperatures, viscosities, 3)

    def residual(sutherland):
        shape = np.sqrt(temperature) / (1 + sutherland / temperature) / viscosity
        amplitude = float(np.sum(shape) / np.dot(shape, shape))
        return float(np.mean((amplitude * shape - 1) ** 2)), amplitude

    lower, upper = 0.0, float(temperature[-1] * 10)
    ratio = (math.sqrt(5) - 1) / 2
    for _ in range(160):
        left = upper - ratio * (upper - lower)
        right = lower + ratio * (upper - lower)
        if residual(left)[0] <= residual(right)[0]:
            upper = right
        else:
            lower = left
    sutherland = (lower + upper) / 2
    candidates = [(residual(value)[0], value, residual(value)[1]) for value in (0.0, sutherland, float(temperature[-1] * 10))]
    error, sutherland, amplitude = min(candidates)
    if sutherland == temperature[-1] * 10 or not math.isfinite(error) or not math.isfinite(amplitude) or amplitude <= 0:
        raise ValueError("Source transport does not admit a bounded positive Sutherland fit")
    reference_temperature = float(temperature[0])
    return {
        "sutherland_temperature_k": sutherland,
        "reference_temperature_k": reference_temperature,
        "reference_dynamic_viscosity": amplitude * math.sqrt(reference_temperature) / (1 + sutherland / reference_temperature),
        "source_rms_relative_error": math.sqrt(error),
    }


def fit_polynomial_transport(
    temperatures: Sequence[float], viscosities: Sequence[float], conductivities: Sequence[float], *, provenance: str,
) -> PolynomialTransport:
    temperature, viscosity = _samples(temperatures, viscosities, 16)
    _, conductivity = _samples(temperatures, conductivities, 16)

    def coefficients(values):
        with np.errstate(over="raise", invalid="raise", divide="raise"):
            polynomial, diagnostics = Polynomial.fit(temperature, values, deg=7, w=1 / values, full=True)
            if diagnostics[1] != 8:
                raise ValueError("Source transport does not identify all polynomial coefficients")
            fitted = polynomial.convert().coef
        return tuple(float(value) for value in fitted)

    return PolynomialTransport(
        minimum_temperature_k=float(temperature[0]), maximum_temperature_k=float(temperature[-1]),
        dynamic_viscosity_coefficients=coefficients(viscosity),
        thermal_conductivity_coefficients=coefficients(conductivity), provenance=provenance,
    )
