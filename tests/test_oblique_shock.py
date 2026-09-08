import math

import pytest

from scripts.materials.oblique_shock import DetachedShockError, weak_oblique_shock
from scripts.materials.verify_oblique_shock import (
    REFERENCE_GAS_CONSTANT, REFERENCE_PRESSURE, REFERENCE_TEMPERATURE, analyze_case, compare_properties, conservation_errors, read_probe_rows, write_case,
)
from pathlib import Path
from airfoilfoam.airfoil import Airfoil, parse_airfoil
from airfoilfoam.case.compressible import CompressibleCaseBuilder
from airfoilfoam.meshing.base import BoundaryPatch
from airfoilfoam.models import CaseSpec, FluidProperties, MeshParams, RoughnessParams, SolverParams
from airfoilfoam.thermodynamics import CompressibleTimeWindow, GasThermodynamics, ThermodynamicState


def test_matches_nasa_mach_2p5_fifteen_degree_reference():
    shock = weak_oblique_shock(2.5, 15)
    assert shock.shock_angle_deg == pytest.approx(36.94490, abs=5e-6)
    assert shock.mach_downstream == pytest.approx(1.873526, abs=5e-7)
    assert shock.pressure_ratio == pytest.approx(2.467500, abs=5e-7)
    assert shock.density_ratio == pytest.approx(1.866549, abs=5e-7)
    assert shock.temperature_ratio == pytest.approx(1.321958, abs=1e-6)


@pytest.mark.parametrize("mach", [1.1, 2, 2.5, 3])
def test_zero_turning_is_a_mach_wave_not_a_normal_shock(mach):
    shock = weak_oblique_shock(mach, 0)
    assert shock.shock_angle_deg == pytest.approx(math.degrees(math.asin(1 / mach)))
    assert shock.pressure_ratio == pytest.approx(1)
    assert shock.density_ratio == pytest.approx(1)
    assert shock.temperature_ratio == pytest.approx(1)
    assert shock.mach_downstream == pytest.approx(mach)


@pytest.mark.parametrize("mach,angle", [(2, 10), (2.5, 15), (3, 15)])
def test_reference_conserves_normal_mass_momentum_and_total_energy(mach, angle):
    shock = weak_oblique_shock(mach, angle)
    beta = math.radians(shock.shock_angle_deg)
    downstream_angle = beta - math.radians(angle)
    upstream_speed = mach * math.sqrt(shock.gamma)
    downstream_speed = shock.mach_downstream * math.sqrt(shock.gamma * shock.temperature_ratio)
    upstream_normal = upstream_speed * math.sin(beta)
    downstream_normal = downstream_speed * math.sin(downstream_angle)
    assert upstream_normal == pytest.approx(shock.density_ratio * downstream_normal)
    assert 1 + upstream_normal ** 2 == pytest.approx(shock.pressure_ratio + shock.density_ratio * downstream_normal ** 2)
    heat_capacity = shock.gamma / (shock.gamma - 1)
    assert heat_capacity + upstream_speed ** 2 / 2 == pytest.approx(heat_capacity * shock.temperature_ratio + downstream_speed ** 2 / 2)


def test_detached_shock_is_not_an_invented_attached_solution():
    with pytest.raises(DetachedShockError):
        weak_oblique_shock(2, 40)


@pytest.mark.parametrize("mach,angle,gamma", [(1, 10, 1.4), (2, -1, 1.4), (2, 90, 1.4), (2, 10, 1), (float("nan"), 10, 1.4)])
def test_invalid_reference_conditions_are_rejected(mach, angle, gamma):
    with pytest.raises(ValueError):
        weak_oblique_shock(mach, angle, gamma)


def test_freestream_only_and_wrong_physics_cannot_pass_comparison():
    reference = weak_oblique_shock(2.5, 15)
    uniform = {"pressure_ratio": [1] * 3, "density_ratio": [1] * 3,
               "temperature_ratio": [1] * 3, "mach_downstream": [2.5] * 3}
    assert compare_properties(uniform, reference)["passed"] is False
    correct = {name: [getattr(reference, name)] * 3 for name in uniform}
    assert compare_properties(correct, reference)["passed"] is True
    correct["pressure_ratio"][1] *= 1.1
    assert compare_properties(correct, reference)["passed"] is False


def test_correct_scalar_jumps_cannot_hide_wrong_flow_direction():
    reference = weak_oblique_shock(2.5, 15)
    speed = reference.mach_downstream * math.sqrt(reference.gamma * REFERENCE_GAS_CONSTANT * REFERENCE_TEMPERATURE * reference.temperature_ratio)
    direction = math.radians(reference.deflection_deg)
    velocity = [speed * math.cos(direction), speed * math.sin(direction), 0]
    errors = conservation_errors(reference.pressure_ratio, reference.density_ratio, reference.temperature_ratio, velocity, reference)
    assert max(value for name, value in errors.items() if name != "entropy_change_over_R") < 1e-10
    assert errors["entropy_change_over_R"] > 0
    velocity[1] *= -1
    wrong = conservation_errors(reference.pressure_ratio, reference.density_ratio, reference.temperature_ratio, velocity, reference)
    assert wrong["direction_degrees"] == pytest.approx(30)
    assert wrong["normal_mass"] > 0.03


def test_probe_parser_requires_finite_complete_ordered_history(tmp_path):
    path = tmp_path / "probe"
    path.write_text("# native scalar probes\n" + "".join(f"{iteration} 1 2 3 4 5\n" for iteration in range(30)))
    assert len(read_probe_rows(path, 5)) == 30
    path.write_text(path.read_text().replace("10 1 2", "9 1 2"))
    with pytest.raises(ValueError, match="increasing"):
        read_probe_rows(path, 5)
    path.write_text("".join(f"{iteration} nan 2 3 4 5\n" for iteration in range(30)))
    with pytest.raises(ValueError, match="Malformed"):
        read_probe_rows(path, 5)


def test_benchmark_initializes_uniform_flow_not_the_analytic_answer(tmp_path):
    recipe = Path(__file__).parent / "fixtures/oblique-shock"
    reference, probes = write_case(tmp_path, 64, recipe)
    pressure = (tmp_path / "0/p").read_text()
    assert str(reference.pressure_ratio) not in pressure
    assert f"internalField uniform {REFERENCE_PRESSURE};" in " ".join(pressure.split())
    assert "nonuniform" not in pressure
    temperature = " ".join((tmp_path / "0/T").read_text().split())
    assert f"internalField uniform {REFERENCE_TEMPERATURE};" in temperature
    assert (tmp_path / "system/fvSchemes").read_bytes() == (recipe / "fvSchemes").read_bytes()
    assert len(probes) == 5
    assert "simulationType" in (tmp_path / "constant/turbulenceProperties").read_text()


def test_physical_benchmark_timestep_target_is_below_its_measured_ceiling(tmp_path):
    recipe = Path(__file__).parent / "fixtures/oblique-shock"
    write_case(tmp_path, 64, recipe, 3, True)
    control = " ".join((tmp_path / "system/controlDict").read_text().split())
    assert "maxCo 0.49;" in control
    assert "adjustTimeStep yes;" in control
    assert "localEuler" not in (tmp_path / "system/fvSchemes").read_text()


def test_steady_pressure_cannot_hide_unsteady_density(tmp_path):
    reference = weak_oblique_shock(2.5, 15)
    density = REFERENCE_PRESSURE / (REFERENCE_GAS_CONSTANT * REFERENCE_TEMPERATURE)
    upstream_speed = reference.mach_upstream * math.sqrt(reference.gamma * REFERENCE_GAS_CONSTANT * REFERENCE_TEMPERATURE)
    downstream_speed = reference.mach_downstream * math.sqrt(reference.gamma * REFERENCE_GAS_CONSTANT * REFERENCE_TEMPERATURE * reference.temperature_ratio)
    direction = math.radians(reference.deflection_deg)
    folder = tmp_path / "postProcessing/shockProbes/0"
    folder.mkdir(parents=True)
    for name, base, ratio in [("p", REFERENCE_PRESSURE, reference.pressure_ratio),
                              ("rho", density, reference.density_ratio), ("T", REFERENCE_TEMPERATURE, reference.temperature_ratio)]:
        values = [base, base * ratio, base * ratio, base * ratio, base]
        (folder / name).write_text("".join(f"{iteration} " + " ".join(map(str, values)) + "\n" for iteration in range(40)))
    velocities = [[upstream_speed, 0, 0]] + [[downstream_speed * math.cos(direction), downstream_speed * math.sin(direction), 0]] * 3 + [[upstream_speed, 0, 0]]
    (folder / "U").write_text("".join(f"{iteration} " + " ".join("(" + " ".join(map(str, velocity)) + ")" for velocity in velocities) + "\n" for iteration in range(40)))
    assert analyze_case(tmp_path, reference)["passed"] is True
    rows = (folder / "rho").read_text().splitlines()
    values = rows[-1].split()
    values[2] = str(float(values[2]) + density * 0.1)
    rows[-1] = " ".join(values)
    (folder / "rho").write_text("\n".join(rows) + "\n")
    result = analyze_case(tmp_path, reference)
    assert result["pressure_window_variation"] == 0
    assert result["relative_errors"]["density_ratio"] < 0.03
    assert result["field_window_variation"]["rho"] == pytest.approx(0.1)
    assert result["passed"] is False


@pytest.mark.parametrize("physical_time", [False, True])
def test_captured_benchmark_numerics_match_current_application_generator(tmp_path, physical_time):
    root = Path(__file__).parents[1]
    gas = GasThermodynamics(gas_constant=287.05, heat_capacity_cp=1005, transport_model="constant",
        reference_dynamic_viscosity=1.7894e-5, reference_temperature_k=288.15, prandtl=0.71,
        provenance="Isolated numerical-generator parity fixture")
    state = ThermodynamicState(temperature_k=288.15, pressure_pa=101325)
    airfoil = Airfoil.from_contour("AG24", parse_airfoil((root / "packages/db/seed/selig-database/ag24.dat").read_text()))
    builder = CompressibleCaseBuilder(airfoil,
        [BoundaryPatch("airfoil", "wall"), BoundaryPatch("inlet", "inlet"), BoundaryPatch("outlet", "outlet"), BoundaryPatch("frontAndBack", "empty")],
        MeshParams(), CaseSpec(chord=1, speed=3 * gas.speed_of_sound(state), aoa_deg=0),
        FluidProperties(density=gas.density(state), dynamic_viscosity=gas.dynamic_viscosity(state.temperature_k)), RoughnessParams(),
        SolverParams(force_transient=physical_time, transient_fallback=False, momentum_scheme="upwind"),
        gas=gas, state=state, solver_family="rhoCentralFoam", turbulent_prandtl=0.85,
        time_window=CompressibleTimeWindow(start_time=0,end_time=0.01,delta_t=1e-8,maximum_delta_t=1e-6,write_interval=1e-4,maximum_courant=0.5) if physical_time else None)
    builder.write(tmp_path)
    for name in ["fvSchemes", "fvSolution"]:
        expected = (root / "tests/fixtures/oblique-shock" / name).read_text()
        if name == "fvSchemes" and physical_time:
            expected = expected.replace("localEuler", "Euler")
        assert (tmp_path / "system" / name).read_text() == expected
