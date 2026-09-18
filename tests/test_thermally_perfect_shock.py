from dataclasses import asdict
import math
from pathlib import Path

import pytest

from airfoilfoam.numerical_canary import source_material_for_canary
from airfoilfoam.thermodynamics import GasThermodynamics
from scripts.materials.oblique_shock import DetachedShockError, weak_oblique_shock
from scripts.materials.thermally_perfect_shock import enthalpy_change, normal_shock, weak_thermally_perfect_shock
from scripts.materials.verify_oblique_shock import REFERENCE_PRESSURE, REFERENCE_TEMPERATURE, conservation_errors, write_case


def constant_gas(gamma=1.4):
    return GasThermodynamics(gas_constant=287.05, heat_capacity_cp=gamma * 287.05 / (gamma - 1),
        transport_model="constant", reference_dynamic_viscosity=1.8e-5, reference_temperature_k=288.15,
        prandtl=0.71, provenance="isolated constant-heat-capacity reference fixture")


def source_air():
    return source_material_for_canary(Path(__file__).parent / "fixtures/air-thermophysics-audit.json")


@pytest.mark.parametrize("mach,angle", [(2, 10), (2.5, 15), (3, 15), (3, 30), (1.1, 0)])
@pytest.mark.parametrize("gamma", [1.3, 1.4, 5 / 3])
def test_constant_heat_capacity_limit_matches_independent_closed_form(mach, angle, gamma):
    try:
        expected = weak_oblique_shock(mach, angle, gamma)
    except DetachedShockError:
        with pytest.raises(DetachedShockError):
            weak_thermally_perfect_shock(constant_gas(gamma), mach, angle, 288.15)
        return
    actual = weak_thermally_perfect_shock(constant_gas(gamma), mach, angle, 288.15)
    for name, value in asdict(expected).items():
        assert getattr(actual, name) == pytest.approx(value, rel=1e-9, abs=1e-9)


def test_variable_heat_capacity_normal_shock_conserves_energy_without_frozen_gamma():
    gas = source_air()
    shock = normal_shock(gas, 3, 288.15)
    constant = normal_shock(constant_gas(gas.gamma_at(288.15)), 3, 288.15)
    assert abs(shock.temperature_ratio / constant.temperature_ratio - 1) > 0.005
    assert shock.gamma_downstream < shock.gamma
    assert shock.entropy_change_over_R > 0
    assert shock.mach_downstream < 1
    speed_squared = 9 * gas.gamma_at(288.15) * gas.gas_constant * 288.15
    assert enthalpy_change(gas, 288.15, 288.15 * shock.temperature_ratio) == pytest.approx(
        speed_squared / 2 * (1 - 1 / shock.density_ratio ** 2), rel=1e-10)
    assert shock.pressure_ratio == pytest.approx(shock.density_ratio * shock.temperature_ratio)


def test_enthalpy_reference_offset_cannot_change_the_shock():
    gas = source_air()
    payload = gas.model_dump()
    for branch in ("low_coefficients", "high_coefficients"):
        coefficients = list(payload["nasa7"][branch])
        coefficients[5] += 1000000
        payload["nasa7"][branch] = coefficients
    shifted = GasThermodynamics.model_validate(payload)
    expected = weak_thermally_perfect_shock(gas, 3, 15, 288.15)
    actual = weak_thermally_perfect_shock(shifted, 3, 15, 288.15)
    assert asdict(actual) == pytest.approx(asdict(expected), rel=1e-10, abs=1e-10)
    for lower, upper in [(288.15, 800), (900, 1200), (1000, 1300)]:
        assert enthalpy_change(gas, lower, upper) == pytest.approx(enthalpy_change(shifted, lower, upper), rel=1e-10)
        assert enthalpy_change(gas, upper, lower) == pytest.approx(-enthalpy_change(gas, lower, upper))


def test_out_of_range_material_and_detached_conditions_are_not_extrapolated():
    gas = source_air()
    with pytest.raises(ValueError, match="material range"):
        normal_shock(gas, 3, 2001)
    with pytest.raises(ValueError, match="material range"):
        normal_shock(gas, 10, 288.15)
    with pytest.raises(DetachedShockError):
        weak_thermally_perfect_shock(gas, 2, 40, 288.15)
    for mach in (1, math.nan, math.inf, True):
        with pytest.raises(ValueError):
            normal_shock(gas, mach, 288.15)


@pytest.mark.parametrize("temperature", [100, 100.00000001, 1000])
def test_material_lower_endpoint_and_caloric_join_are_valid_upstream_states(temperature):
    shock = normal_shock(source_air(), 2, temperature)
    assert shock.temperature_ratio > 1
    assert shock.density_ratio > 1
    assert shock.entropy_change_over_R > 0


def test_material_case_uses_registered_calorics_and_uniform_initial_fields(tmp_path):
    gas = source_air()
    reference, probes = write_case(tmp_path, 64, Path(__file__).parent / "fixtures/oblique-shock", 3, gas=gas)
    assert len(probes) == 5
    assert reference.gamma_downstream != reference.gamma
    thermo = (tmp_path / "constant/thermophysicalProperties").read_text()
    assert "janaf" in thermo and "polynomial" in thermo and "hConst" not in thermo
    assert "libxfoilfoamThermophysics.so" in (tmp_path / "system/controlDict").read_text()
    assert f"internalField uniform {REFERENCE_TEMPERATURE};" in " ".join((tmp_path / "0/T").read_text().split())
    assert f"internalField uniform {REFERENCE_PRESSURE};" in " ".join((tmp_path / "0/p").read_text().split())
    assert "nonuniform" not in (tmp_path / "0/p").read_text()


def test_material_comparison_checks_energy_direction_and_actual_entropy_units():
    gas = source_air()
    reference = weak_thermally_perfect_shock(gas, 3, 15, REFERENCE_TEMPERATURE)
    downstream_temperature = REFERENCE_TEMPERATURE * reference.temperature_ratio
    speed = reference.mach_downstream * math.sqrt(gas.gamma_at(downstream_temperature) * gas.gas_constant * downstream_temperature)
    velocity = [speed * math.cos(math.radians(15)), speed * math.sin(math.radians(15)), 0]
    errors = conservation_errors(reference.pressure_ratio, reference.density_ratio, reference.temperature_ratio, velocity, reference, gas)
    assert max(value for name, value in errors.items() if name != "entropy_change_over_R") < 1e-9
    assert errors["entropy_change_over_R"] == pytest.approx(reference.entropy_change_over_R)
    velocity[1] *= -1
    wrong = conservation_errors(reference.pressure_ratio, reference.density_ratio, reference.temperature_ratio, velocity, reference, gas)
    assert wrong["direction_degrees"] == pytest.approx(30)
    assert wrong["normal_mass"] > 0.03
    constant = constant_gas()
    reference = weak_thermally_perfect_shock(constant, 3, 15, REFERENCE_TEMPERATURE)
    speed = reference.mach_downstream * math.sqrt(reference.gamma * constant.gas_constant * REFERENCE_TEMPERATURE * reference.temperature_ratio)
    velocity = [speed * math.cos(math.radians(15)), speed * math.sin(math.radians(15)), 0]
    errors = conservation_errors(reference.pressure_ratio, reference.density_ratio, reference.temperature_ratio, velocity, reference)
    assert errors["entropy_change_over_R"] == pytest.approx(reference.entropy_change_over_R)


def test_timestep_refinement_changes_only_the_declared_physical_target(tmp_path):
    recipe = Path(__file__).parent / "fixtures/oblique-shock"
    original, refined = tmp_path / "original", tmp_path / "refined"
    write_case(original, 128, recipe, 3, True, source_air())
    write_case(refined, 128, recipe, 3, True, source_air(), 0.245)
    initial_control = " ".join((original / "system/controlDict").read_text().split())
    refined_control = " ".join((refined / "system/controlDict").read_text().split())
    assert initial_control.replace("maxCo 0.49;", "maxCo 0.245;") == refined_control
    for name in ("0/U", "0/p", "0/T", "system/blockMeshDict", "system/fvSchemes", "system/fvSolution", "constant/thermophysicalProperties"):
        assert (original / name).read_bytes() == (refined / name).read_bytes()


@pytest.mark.parametrize("physical,courant", [(False, 0.245), (True, 0), (True, 0.5), (True, math.nan), (True, True)])
def test_timestep_reference_refuses_unsupported_controls(tmp_path, physical, courant):
    with pytest.raises(ValueError, match="timestep study"):
        write_case(tmp_path, 128, Path(__file__).parent / "fixtures/oblique-shock", 3, physical, source_air(), courant)


def test_invalid_cli_courant_is_rejected_before_creating_an_evidence_directory(tmp_path, monkeypatch):
    from scripts.materials import verify_oblique_shock
    destination = tmp_path / "not-created"
    monkeypatch.setattr("sys.argv", ["verify_oblique_shock", "--destination", str(destination), "--recipe", str(tmp_path),
                                    "--physical-time", "--target-courant", "nan"])
    monkeypatch.setattr(verify_oblique_shock, "get_runner", lambda *_args: pytest.fail("No native process may start"))
    with pytest.raises(SystemExit) as failure:
        verify_oblique_shock.main()
    assert failure.value.code == 2
    assert not destination.exists()
