import math

import pytest
from pydantic import ValidationError

from airfoilfoam.calorics import Nasa7Calorics
from airfoilfoam.thermodynamics import GasThermodynamics, ThermodynamicState


@pytest.fixture
def calorics():
    return Nasa7Calorics(
        minimum_temperature_k=150, common_temperature_k=500, maximum_temperature_k=1500,
        low_coefficients=(3, 0.001, 0, 0, 0, 0, 0),
        high_coefficients=(3, 0.001, 0, 0, 0, 0, 0),
        provenance="Isolated analytic heat-capacity test definition, not air-property data",
    )


def test_nasa7_uses_dimensionless_cp_coefficients_and_integrated_enthalpy(calorics):
    for temperature in (150, 499.99, 500, 800, 1500):
        assert calorics.heat_capacity_ratio(temperature) == pytest.approx(3 + 0.001 * temperature)
        assert calorics.enthalpy_ratio(temperature) == pytest.approx(3 * temperature + 0.0005 * temperature ** 2)
        assert calorics.entropy_ratio(temperature) == pytest.approx(3 * math.log(temperature) + 0.001 * temperature)
    assert calorics.openfoam_dictionary() == {
        "Tlow": 150, "Tcommon": 500, "Thigh": 1500,
        "lowCpCoeffs": [3, 0.001, 0, 0, 0, 0, 0], "highCpCoeffs": [3, 0.001, 0, 0, 0, 0, 0],
    }
    assert Nasa7Calorics.model_validate_json(calorics.model_dump_json()) == calorics


@pytest.mark.parametrize("temperature", [149.99, 1500.01, -1, float("nan"), float("inf")])
def test_nasa7_refuses_extrapolation_or_silent_clamping(calorics, temperature):
    with pytest.raises(ValueError, match="declared NASA7"):
        calorics.heat_capacity_ratio(temperature)
    with pytest.raises(ValueError, match="declared NASA7"):
        calorics.enthalpy_ratio(temperature)


def test_nasa7_checks_interior_extrema_not_only_endpoints(calorics):
    with pytest.raises(ValidationError, match="throughout"):
        Nasa7Calorics(**{**calorics.model_dump(), "low_coefficients": (9.5, -0.06, 0.0001, 0, 0, 0, 0)})
    for changes in ({"common_temperature_k": 150}, {"maximum_temperature_k": 499},
                    {"low_coefficients": (3, 0, 0, 0, 0, math.nan, 0)}):
        with pytest.raises(ValidationError):
            Nasa7Calorics(**{**calorics.model_dump(), **changes})


@pytest.mark.parametrize("index,offset", [(0, 0.5), (5, 100), (6, 1)])
def test_nasa7_refuses_discontinuous_temperature_branches(calorics, index, offset):
    changed = list(calorics.high_coefficients)
    changed[index] += offset
    with pytest.raises(ValidationError, match="must join"):
        Nasa7Calorics(**{**calorics.model_dump(), "high_coefficients": changed})


def test_nasa7_selects_the_high_branch_at_the_shared_temperature(calorics):
    high = (2.5, 0.002, 0, 0, 0, 125, 0.5 * math.log(500) - 0.5)
    joined = Nasa7Calorics(**{**calorics.model_dump(), "high_coefficients": high})
    assert joined.coefficients_at(500) == high
    assert joined.heat_capacity_ratio(600) == pytest.approx(3.7)
    assert joined.heat_capacity_ratio(400) == pytest.approx(3.4)
    assert joined.enthalpy_ratio(500) == pytest.approx(1625)
    assert joined.entropy_ratio(500) == pytest.approx(3 * math.log(500) + 0.5)


def test_nasa7_reports_finite_but_overflowing_coefficients_as_invalid_input(calorics):
    with pytest.raises(ValidationError, match="finite heat capacity"):
        Nasa7Calorics(**{**calorics.model_dump(), "low_coefficients": (3, 0, 0, 0, 1e308, 0, 0)})


def variable_gas(calorics):
    return GasThermodynamics(
        gas_constant=287, heat_capacity_model="nasa7", nasa7=calorics,
        transport_model="sutherland", reference_dynamic_viscosity=1.8e-5,
        reference_temperature_k=300, sutherland_temperature_k=110,
        provenance="Isolated explicit variable-Cp gas definition, not a runtime material seed",
    )


def test_variable_heat_capacity_controls_sound_speed_and_dictionary(calorics):
    gas = variable_gas(calorics)
    state = ThermodynamicState(temperature_k=800, pressure_pa=100000)
    assert gas.heat_capacity_at(800) == pytest.approx(287 * 3.8)
    assert gas.gamma_at(800) == pytest.approx(3.8 / 2.8)
    assert gas.speed_of_sound(state) ** 2 == pytest.approx(3.8 / 2.8 * 287 * 800)
    assert gas.density(state) == pytest.approx(100000 / (287 * 800))
    assert gas.gamma_at(800) < gas.gamma_at(300)
    with pytest.raises(ValueError, match="gamma_at"):
        _ = gas.gamma
    dictionary = gas.openfoam_dictionary()
    assert dictionary["thermoType"]["thermo"] == "janaf"
    assert dictionary["thermoType"]["energy"] == "sensibleInternalEnergy"
    assert dictionary["mixture"]["thermodynamics"] == calorics.openfoam_dictionary()
    assert "Cp" not in dictionary["mixture"]["thermodynamics"]
    assert GasThermodynamics.model_validate_json(gas.model_dump_json()) == gas
    with pytest.raises(ValueError, match="declared NASA7"):
        gas.density(ThermodynamicState(temperature_k=1800, pressure_pa=100000))


def test_variable_calorics_preflight_checks_stagnation_energy_not_ambient_gamma(calorics):
    gas = variable_gas(calorics)
    temperature = 300
    maximum = calorics.maximum_temperature_k
    available = gas.gas_constant * (3 * (maximum - temperature) + 0.0005 * (maximum ** 2 - temperature ** 2))
    boundary_speed = math.sqrt(2 * available)
    gas.validate_adiabatic_temperature_range(temperature, boundary_speed)
    gas.validate_adiabatic_temperature_range(maximum, 0)
    with pytest.raises(ValueError, match="stagnation temperature exceeds"):
        gas.validate_adiabatic_temperature_range(temperature, boundary_speed * 1.001)
    with pytest.raises(ValueError, match="stagnation temperature exceeds"):
        gas.validate_adiabatic_temperature_range(maximum, 1)
    for speed in (-1, float("nan"), float("inf"), 1e308):
        with pytest.raises(ValueError, match="finite"):
            gas.validate_adiabatic_temperature_range(temperature, speed)
    with pytest.raises(ValueError, match="declared NASA7"):
        gas.validate_adiabatic_temperature_range(149, 0)


def test_nasa7_cannot_mix_constant_cp_or_unsupported_transport(calorics):
    gas = variable_gas(calorics)
    for changes in ({"heat_capacity_cp": 1000}, {"nasa7": None}, {"heat_capacity_model": "constant_cp"},
                    {"transport_model": "constant", "prandtl": 0.7, "sutherland_temperature_k": None},
                    {"reference_temperature_k": 1600}, {"gas_constant": 1e308}):
        with pytest.raises(ValidationError):
            GasThermodynamics(**{**gas.model_dump(), **changes})


def test_entropy_reference_pressure_is_converted_without_changing_cp_or_enthalpy(calorics):
    source = Nasa7Calorics(**{**calorics.model_dump(), "entropy_reference_pressure_pa": 101325})
    native = source.openfoam_dictionary()
    for original, converted in ((source.low_coefficients, native["lowCpCoeffs"]), (source.high_coefficients, native["highCpCoeffs"])):
        assert converted[:6] == list(original[:6])
        assert converted[6] - math.log(101325 / 100000) == pytest.approx(original[6])
    assert source.entropy_ratio(300) == calorics.entropy_ratio(300)


def test_molecular_weight_conversion_preserves_the_native_specific_gas_constant(calorics):
    from airfoilfoam.thermophysical_constants import OPENCFD2606_UNIVERSAL_GAS_CONSTANT

    gas = variable_gas(calorics)
    molecular_weight = gas.openfoam_dictionary()["mixture"]["specie"]["molWeight"]
    assert OPENCFD2606_UNIVERSAL_GAS_CONSTANT / molecular_weight == pytest.approx(gas.gas_constant, rel=1e-14)
