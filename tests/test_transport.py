import math
import json
from pathlib import Path

import numpy as np
import pytest
from numpy.polynomial import Polynomial

from airfoilfoam.material_fitting import fit_polynomial_transport
from airfoilfoam.transport import PolynomialTransport
from airfoilfoam.thermodynamics import GasThermodynamics


def transport(**changes):
    values = dict(minimum_temperature_k=150, maximum_temperature_k=2000,
        dynamic_viscosity_coefficients=(1e-5, 1e-8, 0, 0, 0, 0, 0, 0),
        thermal_conductivity_coefficients=(0.01, 1e-5, 0, 0, 0, 0, 0, 0),
        provenance="Isolated analytic transport fixture, not catalog air")
    return PolynomialTransport(**(values | changes))


def test_polynomial_transport_preserves_independent_source_properties():
    temperatures = np.linspace(150, 2000, 113)
    viscosity = 1e-5 + 1e-8 * temperatures + 1e-14 * temperatures ** 2
    conductivity = 0.01 + 1e-5 * temperatures + 1e-11 * temperatures ** 2
    fitted = fit_polynomial_transport(temperatures, viscosity, conductivity, provenance="Isolated analytic fixture")
    for temperature in np.linspace(150, 2000, 207):
        assert fitted.dynamic_viscosity(temperature) == pytest.approx(1e-5 + 1e-8 * temperature + 1e-14 * temperature ** 2)
        assert fitted.thermal_conductivity(temperature) == pytest.approx(0.01 + 1e-5 * temperature + 1e-11 * temperature ** 2)
        native = fitted.openfoam_dictionary()
        assert Polynomial(native["muCoeffs<8>"])(temperature) == fitted.dynamic_viscosity(temperature)
        assert Polynomial(native["kappaCoeffs<8>"])(temperature) == fitted.thermal_conductivity(temperature)


@pytest.mark.parametrize("temperature", [0, 149.99, 2000.01, math.inf, math.nan])
def test_transport_never_extrapolates_outside_its_source_domain(temperature):
    model = transport()
    with pytest.raises(ValueError, match="outside"):
        model.dynamic_viscosity(temperature)
    with pytest.raises(ValueError, match="outside"):
        model.thermal_conductivity(temperature)


@pytest.mark.parametrize("field", ["dynamic_viscosity_coefficients", "thermal_conductivity_coefficients"])
def test_rejects_interior_negative_values_despite_positive_endpoints(field):
    coefficients = (999999, -2000, 1, 0, 0, 0, 0, 0)
    assert Polynomial(coefficients)(150) > 0
    assert Polynomial(coefficients)(2000) > 0
    with pytest.raises(ValueError, match="positive throughout"):
        transport(**{field: coefficients})


@pytest.mark.parametrize("changes", [
    {"minimum_temperature_k": 2000}, {"maximum_temperature_k": 100},
    {"dynamic_viscosity_coefficients": (0,) * 8},
    {"thermal_conductivity_coefficients": (1, 0, 0, 0, 0, 0, 0, math.nan)},
    {"thermal_conductivity_coefficients": (1e308,) * 8},
    {"thermal_conductivity_coefficients": (1, 2)},
])
def test_rejects_invalid_transport_model(changes):
    with pytest.raises(ValueError):
        transport(**changes)


def test_rejects_absent_or_nonphysical_transport_source():
    temperatures = np.linspace(150, 2000, 17)
    for viscosity, conductivity in ((np.ones(17), np.ones(16)), (np.ones(17), -np.ones(17)), (np.full(17, math.nan), np.ones(17))):
        with pytest.raises(ValueError, match="source samples"):
            fit_polynomial_transport(temperatures, viscosity, conductivity, provenance="Isolated invalid source")


def source_fitted_gas():
    fixture = json.loads((Path(__file__).parent / "fixtures/air-thermophysics-audit.json").read_text())
    polynomial = PolynomialTransport.model_validate(fixture["transport"])
    return GasThermodynamics(gas_constant=fixture["gas_constant"], heat_capacity_model="nasa7", nasa7=fixture["calorics"],
        transport_model="polynomial", polynomial_transport=polynomial, reference_temperature_k=288.15,
        reference_dynamic_viscosity=polynomial.dynamic_viscosity(288.15),
        provenance="Isolated source-derived native regression, not installed as catalog data")


def test_polynomial_gas_preserves_source_transport_and_native_dictionary():
    gas = source_fitted_gas()
    assert GasThermodynamics.model_validate_json(gas.model_dump_json()) == gas
    assert gas.openfoam_dictionary()["thermoType"]["transport"] == "polynomial"
    assert gas.openfoam_dictionary()["mixture"]["transport"] == gas.polynomial_transport.openfoam_dictionary()
    for temperature in (150, 288.15, 999, 1000, 1500, 2000):
        assert gas.dynamic_viscosity(temperature) == gas.polynomial_transport.dynamic_viscosity(temperature)
        assert gas.thermal_conductivity(temperature) == gas.polynomial_transport.thermal_conductivity(temperature)


@pytest.mark.parametrize("changes", [
    {"polynomial_transport": None}, {"sutherland_temperature_k": 100}, {"prandtl": 0.71},
    {"heat_capacity_model": "constant_cp", "heat_capacity_cp": 1005, "nasa7": None},
    {"reference_dynamic_viscosity": 1e-2}, {"transport_model": "sutherland", "sutherland_temperature_k": 100},
])
def test_gas_rejects_ambiguous_or_unregistered_transport_combinations(changes):
    with pytest.raises(ValueError):
        GasThermodynamics.model_validate(source_fitted_gas().model_dump() | changes)


def test_transport_domain_must_cover_the_caloric_domain():
    model = source_fitted_gas().model_dump()
    model["polynomial_transport"]["minimum_temperature_k"] = 151
    with pytest.raises(ValueError, match="entire declared caloric"):
        GasThermodynamics.model_validate(model)
