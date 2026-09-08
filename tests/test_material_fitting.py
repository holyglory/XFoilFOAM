import math

import numpy as np
import pytest

from airfoilfoam.material_fitting import fit_nasa7_calorics, fit_sutherland_transport


def test_fits_analytic_heat_capacity_with_continuous_integrals():
    temperatures = np.linspace(150, 2000, 101)
    model = fit_nasa7_calorics(
        temperatures, 3 + temperatures * 0.001, common_temperature_k=1000,
        reference_temperature_k=300, reference_enthalpy_ratio=945,
        reference_entropy_ratio=3 * math.log(300) + 0.3,
        provenance="Isolated analytic source fixture, not air material data",
    )
    for temperature in np.linspace(150, 2000, 203):
        assert model.heat_capacity_ratio(temperature) == pytest.approx(3 + temperature * 0.001)
        assert model.enthalpy_ratio(temperature) == pytest.approx(3 * temperature + temperature ** 2 * 0.0005)
        assert model.entropy_ratio(temperature) == pytest.approx(3 * math.log(temperature) + temperature * 0.001)
    with pytest.raises(ValueError, match="outside"):
        model.heat_capacity_ratio(2001)


@pytest.mark.parametrize("sutherland", [0, 110.4, 700])
def test_fits_sutherland_without_inventing_transport_data(sutherland):
    temperatures = np.linspace(150, 2000, 201)
    amplitude = 1.7e-6
    viscosity = amplitude * np.sqrt(temperatures) / (1 + sutherland / temperatures)
    fitted = fit_sutherland_transport(temperatures, viscosity)
    assert fitted["sutherland_temperature_k"] == pytest.approx(sutherland, abs=1e-6)
    assert fitted["source_rms_relative_error"] < 1e-12
    assert fitted["reference_dynamic_viscosity"] == pytest.approx(viscosity[0])


@pytest.mark.parametrize("temperature,values", [
    ([1, 2, 3], [1, 2]), ([1, 1, 3], [1, 2, 3]), ([1, 2, float("nan")], [1, 2, 3]),
    ([1, 2, 3], [1, -2, 3]), ([[1, 2, 3]], [[1, 2, 3]]), ([3, 2, 1], [1, 2, 3]),
])
def test_rejects_unusable_source_samples(temperature, values):
    with pytest.raises(ValueError, match="source samples"):
        fit_sutherland_transport(temperature, values)


@pytest.mark.parametrize("common,reference,enthalpy", [(150, 300, 945), (1999, 300, 945), (1000, 1200, 945), (1000, 300, math.inf)])
def test_rejects_unidentified_caloric_branches(common, reference, enthalpy):
    temperatures = np.linspace(150, 2000, 101)
    with pytest.raises(ValueError):
        fit_nasa7_calorics(temperatures, np.full(101, 3.5), common_temperature_k=common,
            reference_temperature_k=reference, reference_enthalpy_ratio=enthalpy, reference_entropy_ratio=20,
            provenance="Isolated invalid input fixture")


def test_recovers_distinct_cp_branches_without_a_join_jump():
    temperatures = np.unique(np.r_[np.linspace(150, 2000, 101), 1000])
    values = np.where(temperatures < 1000, 3 + temperatures * 0.001, 3.5 + temperatures * 0.0005)
    model = fit_nasa7_calorics(temperatures, values, common_temperature_k=1000,
        reference_temperature_k=300, reference_enthalpy_ratio=945,
        reference_entropy_ratio=3 * math.log(300) + 0.3,
        provenance="Isolated piecewise analytic source, not air data")
    for temperature in np.linspace(150, 2000, 203):
        expected = 3 + temperature * 0.001 if temperature < 1000 else 3.5 + temperature * 0.0005
        assert model.heat_capacity_ratio(temperature) == pytest.approx(expected)
    assert model.heat_capacity_ratio(1000) == pytest.approx(4)
    assert model.enthalpy_ratio(1000) == pytest.approx(3500)
    assert model.entropy_ratio(1000) == pytest.approx(3 * math.log(1000) + 1)


def test_rejects_heat_capacity_below_gas_constant():
    temperatures = np.linspace(150, 2000, 101)
    with pytest.raises(ValueError, match="physical heat capacities"):
        fit_nasa7_calorics(temperatures, np.full(101, 0.99), common_temperature_k=1000,
            reference_temperature_k=300, reference_enthalpy_ratio=1000, reference_entropy_ratio=20,
            provenance="Isolated nonphysical source fixture")
