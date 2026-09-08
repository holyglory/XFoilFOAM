import hashlib
import importlib.util
import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam.thermodynamics import ThermodynamicState


@pytest.fixture
def audit():
    path = Path(__file__).parents[1] / "scripts/materials/evaluate-air-pressure.py"
    specification = importlib.util.spec_from_file_location("air_pressure_audit", path)
    module = importlib.util.module_from_spec(specification)
    specification.loader.exec_module(module)
    return module


@pytest.fixture
def model(audit):
    fixture = json.loads((Path(__file__).parent / "fixtures/air-thermophysics-audit.json").read_text())
    return audit.source_model(fixture)


def test_isentrope_conserves_variable_caloric_energy_and_entropy(audit, model):
    reference = ThermodynamicState(temperature_k=288.15, pressure_pa=101325)
    states = audit.isentropic_reference_path(model, reference, 3)
    assert reference in states
    assert states[0].temperature_k == 100
    assert states[-1].temperature_k > reference.temperature_k
    calorics = model.nasa7
    kinetic_energy = (3 * model.speed_of_sound(reference)) ** 2 / 2
    assert model.gas_constant * (calorics.enthalpy_ratio(states[-1].temperature_k) -
        calorics.enthalpy_ratio(reference.temperature_k)) == pytest.approx(kinetic_energy, rel=1e-12)
    for state in states:
        assert calorics.entropy_ratio(state.temperature_k) - math.log(state.pressure_pa) == pytest.approx(
            calorics.entropy_ratio(reference.temperature_k) - math.log(reference.pressure_pa), abs=1e-12)


def test_constant_cp_nasa7_matches_analytic_stagnation_state(audit, model):
    coefficients = (3.5, 0, 0, 0, 0, 0, 0)
    calorics = model.nasa7.model_copy(update={"low_coefficients": coefficients, "high_coefficients": coefficients})
    constant = model.model_copy(update={"nasa7": calorics})
    reference = ThermodynamicState(temperature_k=288.15, pressure_pa=101325)
    stagnation = audit.isentropic_reference_path(constant, reference, 3)[-1]
    ratio = 1 + (1.4 - 1) * 9 / 2
    assert stagnation.temperature_k == pytest.approx(reference.temperature_k * ratio)
    assert stagnation.pressure_pa == pytest.approx(reference.pressure_pa * ratio ** 3.5)
    assert audit.isentropic_reference_path(constant, reference, 0)[-1] == reference


@pytest.mark.parametrize("mach,samples", [(float("nan"), 81), (-1, 81), (float("inf"), 81), (3, 1), (3, True), (20, 81)])
def test_path_rejects_invalid_or_uncovered_inputs(audit, model, mach, samples):
    with pytest.raises(ValueError):
        audit.isentropic_reference_path(model, ThermodynamicState(temperature_k=288.15, pressure_pa=101325), mach, samples)


@pytest.mark.parametrize("failure", ["liquid", "exception", "nan", "negative", "phase_nan", "candidate_domain"])
def test_audit_never_reports_missing_or_invalid_comparisons_as_zero_error(audit, model, failure):
    state = ThermodynamicState(temperature_k=99 if failure == "candidate_domain" else 288.15, pressure_pa=101325)

    def source_values(property_name, state):
        if failure == "exception":
            raise ValueError("Isolated source failure")
        if property_name == "Phase":
            return float("nan") if failure == "phase_nan" else 0 if failure == "liquid" else 5
        return float("nan") if failure == "nan" else -1 if failure == "negative" else 1

    row = audit.compare_state(model, state, source_values, {5})
    assert row["status"] != "compared"
    assert row["relative_errors"] is None
    summary = audit.summarize([row])
    assert summary["states"] == 1 and summary["compared"] == 0
    assert summary["source_errors"] + summary["candidate_errors"] + summary["excluded_phases"] == 1
    assert all(value is None for value in summary["maximum_sampled_relative_errors"].values())


def test_compared_errors_keep_worst_state_coordinates(audit, model):
    state = ThermodynamicState(temperature_k=288.15, pressure_pa=101325)
    source = {"Phase": 5, "Dmass": model.density(state) / 1.02, "Cpmass": model.heat_capacity_at(288.15),
        "A": model.speed_of_sound(state), "VISCOSITY": model.dynamic_viscosity(288.15),
        "CONDUCTIVITY": model.thermal_conductivity(288.15)}
    row = audit.compare_state(model, state, lambda name, state: source[name], {5})
    assert row["status"] == "compared"
    worst = audit.summarize([row])["maximum_sampled_relative_errors"]["density"]
    assert worst == {"relative_error": pytest.approx(.02), **state.model_dump()}


@pytest.mark.parametrize("phase", [1, 2, 5])
def test_declared_supercritical_and_gas_phases_are_compared_not_silently_excluded(audit, model, phase):
    state = ThermodynamicState(temperature_k=788, pressure_pa=3800000)
    row = audit.compare_state(model, state, lambda name, state: phase if name == "Phase" else 1, {1, 2, 5})
    assert row["status"] == "compared"
    assert row["phase"] == phase
    assert audit.summarize([row])["excluded_phases"] == 0


@pytest.mark.parametrize("changed", [None, "version", "git_revision", "cas", "fluid_json_sha256", "fluid"])
def test_source_identity_is_pinned(audit, changed):
    source_json = "isolated identity fixture"
    library = SimpleNamespace(__version__="8.0.0", __gitrevision__="isolated-revision")
    source = {"name": "CoolProp", "version": "8.0.0", "git_revision": "isolated-revision",
        "cas": "AIR.PPF", "fluid": "HEOS::Air", "fluid_json_sha256": hashlib.sha256(source_json.encode()).hexdigest()}
    if changed:
        source[changed] = "different"
        with pytest.raises(ValueError, match="source identity"):
            audit.verify_source(source, library, source_json, "AIR.PPF")
    else:
        audit.verify_source(source, library, source_json, "AIR.PPF")
