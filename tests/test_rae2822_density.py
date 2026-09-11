import hashlib
import json
import re
from pathlib import Path

import pytest

from airfoilfoam.airfoil import Airfoil, parse_airfoil
from airfoilfoam.case.compressible import CompressibleCaseBuilder
from airfoilfoam.meshing.base import BoundaryPatch
from airfoilfoam.models import CaseSpec, FluidProperties, MeshParams, RoughnessParams, SolverParams
from airfoilfoam.thermodynamics import GasThermodynamics, ThermodynamicState
from scripts.materials.rae2822_density import configure_density_reference, density_reference_convergence
from scripts.materials.rae2822_reference import load_reference, selig_coordinates


def case_builder(directory, family="rhoSimpleFoam", mach=0.729, scheme="upwind"):
    reference = load_reference(Path(__file__).parent / "fixtures/rae2822")
    gas = GasThermodynamics(gas_constant=287.05, heat_capacity_cp=1005, transport_model="constant",
        reference_dynamic_viscosity=1.82e-5, reference_temperature_k=298, prandtl=0.71,
        provenance="isolated constant-air dictionary fixture")
    state = ThermodynamicState(temperature_k=298, pressure_pa=100000)
    builder = CompressibleCaseBuilder(
        airfoil=Airfoil.from_contour("RAE2822", parse_airfoil(selig_coordinates(reference))),
        patches=[BoundaryPatch("airfoil", "wall"), BoundaryPatch("inlet", "inlet"), BoundaryPatch("outlet", "outlet"), BoundaryPatch("frontAndBack", "empty")],
        mesh_params=MeshParams(), spec=CaseSpec(chord=1, speed=mach * gas.speed_of_sound(state), aoa_deg=2.31),
        fluid=FluidProperties(density=gas.density(state), dynamic_viscosity=gas.dynamic_viscosity(state.temperature_k)),
        roughness=RoughnessParams(), solver=SolverParams(momentum_scheme=scheme, force_transient=False, transient_fallback=False,
            n_iterations=3000, convergence_tolerance=1e-5), gas=gas, state=state, solver_family=family, turbulent_prandtl=0.85,
    )
    builder.write(directory)
    return builder


def test_density_reference_preserves_physics_and_does_not_change_production_builder(tmp_path):
    builder = case_builder(tmp_path)
    execution = configure_density_reference(tmp_path, builder)
    assert builder.solver_family == "rhoSimpleFoam" and builder.local_steady is False
    assert execution["production_admission"] is False
    assert execution["solver_family"] == "rhoCentralFoam"
    assert execution["physical_time_history"] is False
    for relative, digest in execution["preserved_physical_files"].items():
        assert hashlib.sha256((tmp_path / relative).read_bytes()).hexdigest() == digest
    control = " ".join((tmp_path / "system/controlDict").read_text().split())
    schemes = " ".join((tmp_path / "system/fvSchemes").read_text().split())
    solution = (tmp_path / "system/fvSolution").read_text()
    assert "application rhoCentralFoam;" in control
    assert "endTime 3000;" in control and "consecutiveSteps 100;" in control
    assert "xfoilfoamSteadyConvergence" in control and "referenceTurbulenceFrequency" in control
    assert "localEuler" in schemes and "Kurganov" in schemes
    for field in ("rho", "U", "T"):
        assert f"reconstruct({field}) upwind;" in schemes
    assert "diagonal" in solution and "SIMPLE" not in solution
    assert "freestreamVelocity" in (tmp_path / "0/U").read_text()
    assert "freestreamPressure" in (tmp_path / "0/p").read_text()
    with pytest.raises(ValueError, match="existing numerical experiment"):
        configure_density_reference(tmp_path, builder)
    with pytest.raises(ValueError, match="Mach at least"):
        case_builder(tmp_path / "public", family="rhoCentralFoam")


@pytest.mark.parametrize("marker", ["log.rhoSimpleFoam", "3000"])
def test_density_reference_refuses_cases_with_execution_evidence(tmp_path, marker):
    builder = case_builder(tmp_path)
    (tmp_path / marker).touch()
    before = (tmp_path / "system/controlDict").read_bytes()
    with pytest.raises(ValueError, match="fresh case"):
        configure_density_reference(tmp_path, builder)
    assert (tmp_path / "system/controlDict").read_bytes() == before


def test_density_reference_requires_native_certificate_and_force_hold():
    samples = "".join(f"XFOILFOAM_LOCAL_STEADY_RESIDUAL {iteration} 1e-6 1e-6 1e-6 1e-6 1e-6\n" for iteration in range(1, 101))
    certificate = {"version": 2, "coordinate_kind": "iteration", "iteration": 100, "consecutive_steps": 100,
                   "tolerance": 1e-5, "maximum_window_residual": 1e-6}
    log = samples + "XFOILFOAM_LOCAL_STEADY_CONVERGED " + json.dumps(certificate)
    assert density_reference_convergence(log, 1e-5, True)["converged"]
    assert not density_reference_convergence(log, 1e-5, False)["converged"]
    assert not density_reference_convergence(samples, 1e-5, True)["converged"]
    with pytest.raises(ValueError, match="sustained"):
        density_reference_convergence("XFOILFOAM_LOCAL_STEADY_CONVERGED " + json.dumps(certificate), 1e-5, True)


@pytest.mark.parametrize("option", [{"uniform_start": False}, {"enthalpy": True},
    {"donor": "retained"}, {"local_time_pressure": True}, {"native_steady_check": True}, {"transonic": True}])
def test_density_reference_does_not_silently_combine_experiments(option):
    from scripts.materials.verify_rae2822 import run
    options = {"density_local_time": True, "uniform_start": True, "first_order": True, **option}
    with pytest.raises(ValueError, match="without other experiments"):
        run(None, None, None, "precise", **options)


def test_density_order_comparison_changes_only_three_reconstruction_entries(tmp_path):
    first = tmp_path / "first"
    higher = tmp_path / "higher"
    first_builder = case_builder(first)
    higher_builder = case_builder(higher, scheme="linearUpwind")
    first_execution = configure_density_reference(first, first_builder)
    higher_execution = configure_density_reference(higher, higher_builder)
    assert first_execution["reconstruction_schemes"] == {"rho": "upwind", "U": "upwind", "T": "upwind"}
    assert higher_execution["reconstruction_schemes"] == {"rho": "vanLeer", "U": "vanLeerV", "T": "vanLeer"}
    assert first_execution["flux_scheme"] == higher_execution["flux_scheme"] == "Kurganov"
    assert first_execution["preserved_physical_files"] == higher_execution["preserved_physical_files"]
    for relative in ("system/controlDict", "system/fvSolution"):
        assert (first / relative).read_bytes() == (higher / relative).read_bytes()
    expected = (first / "system/fvSchemes").read_text()
    for field, scheme in (("rho", "vanLeer"), ("U", "vanLeerV"), ("T", "vanLeer")):
        expected, count = re.subn(rf"(reconstruct\({field}\)\s+)upwind;", rf"\g<1>{scheme};", expected)
        assert count == 1
    assert (higher / "system/fvSchemes").read_text() == expected
