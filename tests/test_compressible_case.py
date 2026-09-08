from pathlib import Path
import json
from types import SimpleNamespace

import numpy as np
import pytest

from airfoilfoam.airfoil import Airfoil, parse_airfoil
from airfoilfoam.case.compressible import CompressibleCaseBuilder
from airfoilfoam.meshing.base import BoundaryPatch
from airfoilfoam.models import CaseSpec, FluidProperties, MeshParams, RoughnessParams, SolverParams
from airfoilfoam.openfoam.dialects import OPENCFD_2606
from airfoilfoam.thermodynamics import CompressibleTimeWindow, GasThermodynamics, ThermodynamicState, pressure_coefficient
from airfoilfoam.models import ImageField
from airfoilfoam.postprocess.images import _field_values, _field_style
from airfoilfoam.postprocess.pressure_reference import read_pressure_reference
from airfoilfoam.transport import PolynomialTransport


@pytest.fixture
def gas():
    return GasThermodynamics(
        gas_constant=287.05, heat_capacity_cp=1005, transport_model="constant",
        reference_dynamic_viscosity=1.82e-5, reference_temperature_k=298,
        prandtl=0.71, provenance="isolated calorically-perfect-air regression definition",
    )


@pytest.fixture
def state():
    return ThermodynamicState(temperature_k=298, pressure_pa=100000)


def builder(gas, state, family="rhoSimpleFoam", mach=0.72, **changes):
    source = Path(__file__).parents[1] / "packages/db/seed/selig-database/ag24.dat"
    parameters = {
        "airfoil": Airfoil.from_contour("AG24", parse_airfoil(source.read_text())),
        "patches": [BoundaryPatch("airfoil", "wall"), BoundaryPatch("inlet", "inlet"),
                    BoundaryPatch("outlet", "outlet"), BoundaryPatch("frontAndBack", "empty")],
        "mesh_params": MeshParams(),
        "spec": CaseSpec(chord=1, speed=mach * gas.speed_of_sound(state), aoa_deg=2),
        "fluid": FluidProperties(density=gas.density(state), dynamic_viscosity=gas.dynamic_viscosity(state.temperature_k)),
        "roughness": RoughnessParams(), "solver": SolverParams(force_transient=family != "rhoSimpleFoam"), "gas": gas, "state": state,
        "solver_family": family, "turbulent_prandtl": 0.85,
    }
    parameters.update(changes)
    return CompressibleCaseBuilder(**parameters)


def window():
    return CompressibleTimeWindow(start_time=0, end_time=0.02, delta_t=1e-7,
                                  maximum_delta_t=1e-5, write_interval=1e-4, maximum_courant=0.3)


def test_density_local_steady_is_explicit_iteration_time_and_conserved_residual_gated(tmp_path, gas, state):
    case = builder(gas, state, "rhoCentralFoam", 3,
                   solver=SolverParams(force_transient=False, transient_fallback=False, n_iterations=1500))
    case.write(tmp_path)
    control = " ".join((tmp_path / "system/controlDict").read_text().split())
    schemes = (tmp_path / "system/fvSchemes").read_text()
    assert "localEuler" in schemes and "endTime 1500;" in control
    assert "deltaT 1;" in control and "writeControl timeStep;" in control
    assert "xfoilfoamSteadyConvergence" in control and "consecutiveSteps 100;" in control
    assert "referenceDensity" in control and "referenceSpecificEnergy" in control
    assert "libxfoilfoamSteadyConvergence.so" in control
    identity = json.loads((tmp_path / "constant/numericalExecution.json").read_text())
    assert identity["time_coordinate"] == "local_pseudo_time_iterations"
    assert identity["physical_time_history"] is False
    with pytest.raises(ValueError, match="physical-time"):
        case.write_transient(tmp_path, 0, 1, 0.01)


@pytest.mark.parametrize("transient", [False, True])
@pytest.mark.parametrize("scheme", ["linearUpwind", "upwind"])
def test_density_reconstruction_honors_requested_order(tmp_path, gas, state, transient, scheme):
    case = builder(gas, state, "rhoCentralFoam", 3, time_window=window() if transient else None,
                   solver=SolverParams(force_transient=transient, transient_fallback=False, momentum_scheme=scheme))
    case.write(tmp_path)
    dictionary = " ".join((tmp_path / "system/fvSchemes").read_text().split())
    for field in ["rho", "U", "T"]:
        expected = "upwind" if scheme == "upwind" else "vanLeerV" if field == "U" else "vanLeer"
        assert f"reconstruct({field}) {expected};" in dictionary


def test_pressure_initializer_metadata_changes_to_physical_time_without_rewriting_material(tmp_path, gas, state):
    case = builder(gas, state)
    case.write(tmp_path)
    protected = {name: (tmp_path / name).read_bytes() for name in ["constant/thermophysicalProperties", "constant/aerodynamicReference.json", "0/p", "0/T"]}
    assert json.loads((tmp_path / "constant/numericalExecution.json").read_text())["time_coordinate"] == "steady_iterations"
    case.write_transient(tmp_path, 0, 0.01, 1e-8, write_interval=1e-4, max_delta_t=1e-6)
    identity = json.loads((tmp_path / "constant/numericalExecution.json").read_text())
    assert identity["solver_family"] == "rhoPimpleFoam"
    assert identity["time_coordinate"] == "physical_time_seconds" and identity["physical_time_history"] is True
    assert all((tmp_path / name).read_bytes() == content for name, content in protected.items())


def test_gas_state_and_transport_are_consistent(gas, state):
    assert gas.density(state) == pytest.approx(state.pressure_pa / (gas.gas_constant * state.temperature_k))
    assert gas.speed_of_sound(state) ** 2 == pytest.approx(gas.gamma * gas.gas_constant * state.temperature_k)
    assert gas.openfoam_dictionary()["mixture"]["transport"] == {"mu": 1.82e-5, "Pr": 0.71}
    assert pressure_coefficient(state.pressure_pa, state, gas.density(state), 100) == 0
    assert pressure_coefficient(state.pressure_pa + 0.5 * gas.density(state) * 100 ** 2, state, gas.density(state), 100) == pytest.approx(1)
    with pytest.raises(ValueError):
        pressure_coefficient(state.pressure_pa, state, gas.density(state), 0)


def test_sutherland_preserves_reference_and_explicit_conductivity_contract(gas):
    model = GasThermodynamics(**{**gas.model_dump(), "transport_model": "sutherland", "sutherland_temperature_k": 110.4, "prandtl": None})
    assert model.dynamic_viscosity(model.reference_temperature_k) == pytest.approx(model.reference_dynamic_viscosity)
    assert model.dynamic_viscosity(800) > model.dynamic_viscosity(298)
    transport = model.openfoam_dictionary()["mixture"]["transport"]
    assert set(transport) == {"As", "Ts"}
    assert transport["As"] * 298 ** 0.5 / (1 + transport["Ts"] / 298) == pytest.approx(model.reference_dynamic_viscosity)
    with pytest.raises(ValueError, match="Eucken"):
        GasThermodynamics(**{**model.model_dump(), "prandtl": 0.71})
    with pytest.raises(ValueError, match="heat capacity"):
        GasThermodynamics(**{**gas.model_dump(), "heat_capacity_cp": gas.gas_constant})


def test_explicit_nasa7_case_writes_the_supplied_caloric_model(tmp_path, gas, state):
    variable = GasThermodynamics(**{
        **gas.model_dump(), "heat_capacity_model": "nasa7", "heat_capacity_cp": None,
        "transport_model": "sutherland", "sutherland_temperature_k": 110, "prandtl": None,
        "nasa7": {"minimum_temperature_k": 150, "common_temperature_k": 500, "maximum_temperature_k": 1500,
                  "low_coefficients": [3, 0.001, 0, 0, 0, 0, 0], "high_coefficients": [3, 0.001, 0, 0, 0, 0, 0],
                  "provenance": "Isolated analytic variable-Cp dictionary test, not air material data"},
    })
    builder(variable, state).write(tmp_path)
    thermo = (tmp_path / "constant/thermophysicalProperties").read_text()
    assert "janaf" in thermo and "hConst" not in thermo
    assert "lowCpCoeffs" in thermo and "highCpCoeffs" in thermo
    normalized = " ".join(thermo.split())
    assert "Tlow 150;" in normalized and "Thigh 1500;" in normalized
    assert "sensibleInternalEnergy" in thermo


def test_compressible_pressure_energy_and_force_normalization(tmp_path, gas, state):
    case = builder(gas, state)
    case.write(tmp_path)
    pressure = (tmp_path / "0/p").read_text()
    assert "[1 -1 -2 0 0 0 0]" in pressure
    assert "uniform 100000" in pressure
    assert "freestreamPressure" in pressure
    assert not (tmp_path / "constant/transportProperties").exists()
    thermo = (tmp_path / "constant/thermophysicalProperties").read_text()
    assert "perfectGas" in thermo and "sensibleInternalEnergy" in thermo
    assert "[0 0 0 1 0 0 0]" in (tmp_path / "0/T").read_text()
    assert "[1 -1 -1 0 0 0 0]" in (tmp_path / "0/alphat").read_text()
    schemes = (tmp_path / "system/fvSchemes").read_text()
    assert "div(phi,e)" in schemes and "rho*nuEff" in schemes
    control = (tmp_path / "system/controlDict").read_text()
    assert "rhoSimpleFoam" in control and "pRef" in control
    assert case._force_coeffs_dict()["rho"] == "rho"
    assert case._force_coeffs_dict()["rhoInf"] == gas.density(state)
    assert case.dialect.steady_solver_command == "rhoSimpleFoam"
    assert OPENCFD_2606.steady_solver_command == "simpleFoam"
    solution = " ".join((tmp_path / "system/fvSolution").read_text().split())
    assert "p { solver GAMG;" in solution
    assert "transonic no;" in solution
    assert "U 0.3;" in solution


@pytest.mark.parametrize("family,mach", [("rhoPimpleFoam", 0.8), ("rhoCentralFoam", 2), ("rhoCentralFoam", 3)])
def test_transient_gas_cases_use_real_physical_time_and_shock_schemes(tmp_path, gas, state, family, mach):
    case = builder(gas, state, family, mach, time_window=window())
    case.write(tmp_path)
    control = (tmp_path / "system/controlDict").read_text()
    normalized = " ".join(control.split())
    assert family in control and "endTime 0.02;" in normalized and "maxCo 0.3;" in normalized
    assert "rhoInf" in control
    schemes = (tmp_path / "system/fvSchemes").read_text()
    solution = " ".join((tmp_path / "system/fvSolution").read_text().split())
    if family == "rhoCentralFoam":
        assert "Kurganov" in schemes and "reconstruct(rho)" in schemes
        assert "diagonal" in solution
        for variable in ["U", "e", "h"]:
            assert f"{variable} {{ solver smoothSolver; smoother symGaussSeidel;" in solution
    else:
        assert "PIMPLE" in solution
        assert "div(phiv,p)" in schemes
        assert "rho { solver diagonal; }" in solution
        assert "rhoFinal { solver diagonal; }" in solution


def test_compressible_inputs_reject_mismatched_state_and_missing_timing(gas, state):
    with pytest.raises(ValueError, match="density"):
        builder(gas, state, fluid=FluidProperties(density=10, dynamic_viscosity=1.82e-5))
    with pytest.raises(ValueError, match="viscosity"):
        builder(gas, state, fluid=FluidProperties(density=gas.density(state), dynamic_viscosity=1e-3))
    with pytest.raises(ValueError, match="physical-time"):
        builder(gas, state, "rhoCentralFoam", 2)
    with pytest.raises(ValueError, match="Mach"):
        builder(gas, state, "rhoCentralFoam", 3.01, time_window=window())
    with pytest.raises(ValueError, match="at least 1.2"):
        builder(gas, state, "rhoCentralFoam", 0.8, time_window=window())


def test_pressure_based_continuation_never_reverts_to_incompressible_dictionaries(tmp_path, gas, state):
    case = builder(gas, state)
    case.write(tmp_path)
    with pytest.raises(ValueError, match="explicit"):
        case.write_transient(tmp_path, start_time=0, end_time=0.01, delta_t=1e-7)
    case.write_transient(tmp_path, start_time=0, end_time=0.01, delta_t=1e-7, write_interval=1e-4, max_delta_t=1e-5)
    assert "rhoPimpleFoam" in (tmp_path / "system/controlDict").read_text()
    assert "PIMPLE" in (tmp_path / "system/fvSolution").read_text()
    assert "div(phi,e)" in (tmp_path / "system/fvSchemes").read_text()
    assert "uniform 100000" in (tmp_path / "0/p").read_text()


@pytest.mark.parametrize("family,mach", [("rhoSimpleFoam", 0.72), ("rhoPimpleFoam", 0.9), ("rhoCentralFoam", 3)])
def test_source_fitted_material_loads_the_native_library_in_every_solver_and_continuation(tmp_path, family, mach):
    fixture = json.loads((Path(__file__).parent / "fixtures/air-thermophysics-audit.json").read_text())
    transport = PolynomialTransport.model_validate(fixture["transport"])
    gas = GasThermodynamics(gas_constant=fixture["gas_constant"], heat_capacity_model="nasa7", nasa7=fixture["calorics"],
        transport_model="polynomial", polynomial_transport=transport, reference_temperature_k=288.15,
        reference_dynamic_viscosity=transport.dynamic_viscosity(288.15), provenance="Isolated source-derived regression")
    state = ThermodynamicState(temperature_k=288.15, pressure_pa=101325)
    case = builder(gas, state, family, mach, **({"time_window": window()} if family != "rhoSimpleFoam" else {}))
    case.write(tmp_path)
    library = 'libs            ("/opt/xfoilfoam-thermophysics/lib/libxfoilfoamThermophysics.so");'
    assert library in (tmp_path / "system/controlDict").read_text()
    assert "muCoeffs<8>" in (tmp_path / "constant/thermophysicalProperties").read_text()
    case.write_transient(tmp_path, start_time=0, end_time=0.01, delta_t=1e-7, write_interval=1e-4, max_delta_t=1e-5)
    assert library in (tmp_path / "system/controlDict").read_text()
    assert "uniform 101325" in (tmp_path / "0/p").read_text()
    if family != "rhoCentralFoam":
        assert "PIMPLE" in (tmp_path / "system/fvSolution").read_text()
        assert "div(phi,e)" in (tmp_path / "system/fvSchemes").read_text()


def test_compressible_rendering_uses_archived_density_and_pressure_not_kinematic_scaling(tmp_path, gas, state):
    case = builder(gas, state)
    case.write(tmp_path)
    reference = read_pressure_reference(tmp_path)
    assert reference.pressure_pa == state.pressure_pa
    dynamic_pressure = 0.5 * reference.density * reference.speed ** 2
    mesh = SimpleNamespace(point_data={"p": np.array([reference.pressure_pa, reference.pressure_pa + dynamic_pressure]), "U": np.zeros((2, 3))})
    mask = np.array([True, True])
    coefficients = _field_values(mesh, mask, None, ImageField.pressure_coefficient, reference.speed, case_dir=tmp_path)
    assert coefficients == pytest.approx([0, 1])
    assert _field_style(ImageField.pressure, tmp_path)[0] == "Static pressure p [Pa]"
    with pytest.raises(ValueError, match="Render speed"):
        _field_values(mesh, mask, None, ImageField.pressure_coefficient, reference.speed * 2, case_dir=tmp_path)
    (tmp_path / "constant/aerodynamicReference.json").unlink()
    with pytest.raises(ValueError, match="no stored reference"):
        _field_values(mesh, mask, None, ImageField.pressure_coefficient, reference.speed, case_dir=tmp_path)


def test_legacy_incompressible_pressure_keeps_its_original_units(tmp_path):
    mesh = SimpleNamespace(point_data={"p": np.array([0, 50]), "U": np.zeros((2, 3))})
    assert _field_values(mesh, np.array([True, True]), None, ImageField.pressure_coefficient, 10, case_dir=tmp_path) == pytest.approx([0, 1])
    assert _field_style(ImageField.pressure, tmp_path)[0] == "Kinematic pressure p [m^2/s^2]"


def test_conflicting_pressure_units_are_rejected(tmp_path, gas, state):
    builder(gas, state).write(tmp_path)
    pressure = tmp_path / "0/p"
    pressure.write_text(pressure.read_text().replace("[1 -1 -2 0 0 0 0]", "[0 2 -2 0 0 0 0]"))
    with pytest.raises(ValueError, match="contradicts"):
        read_pressure_reference(tmp_path)
