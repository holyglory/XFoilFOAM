import json
import math
from pathlib import Path
from types import SimpleNamespace

import pytest

from airfoilfoam.meshing.base import BoundaryPatch
from airfoilfoam.openfoam.potential_initialization import adiabatic_velocity_limit_squared, initialize_compressible_velocity, internal_velocity_squared
from airfoilfoam.openfoam.runner import InfrastructureError, RunResult
from airfoilfoam.thermodynamics import GasThermodynamics, ThermodynamicState


def fixture(tmp_path, *, change_physics=False, failure=False, family="rhoSimpleFoam", proposed_speed=200, returncode=0):
    for directory in ["0", "constant"]:
        (tmp_path / directory).mkdir()
    for name, value in {"0/p": "physical pressure", "0/T": "physical temperature",
                        "0/U": "internalField uniform (100 0 0);", "constant/thermophysicalProperties": "selected material"}.items():
        (tmp_path / name).write_text(value)
    calls = []

    def solve(case_dir, command, processors, timeout):
        calls.append((command, processors, timeout))
        temporary = (case_dir / "0/pXfoilfoamInitial").read_text()
        assert "[0 2 -2 0 0 0 0]" in temporary
        assert "-pName pXfoilfoamInitial" in command
        assert all(option not in command for option in ["-writep", "-writephi", "-writePhi", "-withFunctionObjects"])
        if failure:
            raise RuntimeError("isolated initialization failure")
        (case_dir / "0/U").write_text(f"internalField nonuniform List<vector> 2 ((100 0 0) ({proposed_speed} 0 0));")
        if change_physics:
            (case_dir / "0/T").write_text("unexpected thermal mutation")
        return RunResult(command, returncode, "isolated initialization trace")

    gas = GasThermodynamics(gas_constant=287.05, heat_capacity_cp=1005, transport_model="constant",
        reference_dynamic_viscosity=1.8e-5, reference_temperature_k=300, prandtl=0.7,
        provenance="explicit constant-property initialization unit fixture")
    runner = SimpleNamespace(flow_execution=SimpleNamespace(family=family, gas=gas,
        state=ThermodynamicState(temperature_k=300, pressure_pa=101325)), solver=solve, calls=calls)
    patches = [BoundaryPatch("wall", "wall"), BoundaryPatch("upstream", "inlet"),
               BoundaryPatch("downstream", "outlet"), BoundaryPatch("planes", "empty")]
    return runner, patches


def test_potential_velocity_preserves_real_pressure_and_temperature(tmp_path):
    runner, patches = fixture(tmp_path)
    initialize_compressible_velocity(tmp_path, runner, patches, "potentialFoam -writephi -writep -writePhi -withFunctionObjects -initialiseUBCs")
    assert (tmp_path / "0/p").read_text() == "physical pressure"
    assert (tmp_path / "0/T").read_text() == "physical temperature"
    assert not (tmp_path / "0/pXfoilfoamInitial").exists()
    assert (tmp_path / "pressure_initialization/pXfoilfoamInitial").is_file()
    receipt = json.loads((tmp_path / "pressure-initialization.json").read_text())
    assert receipt["aerodynamic_evidence"] is False and receipt["returncode"] == 0
    assert runner.calls[0][1:] == (1, 600)
    assert receipt["version"] == 2 and receipt["applied"] is True
    assert receipt["fallback_reason"] is None


@pytest.mark.parametrize("options,error", [({"change_physics": True}, InfrastructureError), ({"failure": True}, RuntimeError)])
def test_failed_or_mutating_initializer_cannot_continue_cfd(tmp_path, options, error):
    runner, patches = fixture(tmp_path, **options)
    with pytest.raises(error):
        initialize_compressible_velocity(tmp_path, runner, patches, "potentialFoam -initialiseUBCs")
    assert not (tmp_path / "0/pXfoilfoamInitial").exists()


def test_density_based_startup_is_not_replaced_by_potential_flow(tmp_path):
    runner, patches = fixture(tmp_path, family="rhoCentralFoam")
    with pytest.raises(InfrastructureError, match="pressure-based"):
        initialize_compressible_velocity(tmp_path, runner, patches, "potentialFoam")
    assert runner.calls == []


def test_reserved_existing_field_is_not_overwritten_or_removed(tmp_path):
    runner, patches = fixture(tmp_path)
    path = tmp_path / "0/pXfoilfoamInitial"
    path.write_text("existing unrelated state")
    with pytest.raises(InfrastructureError, match="already exists"):
        initialize_compressible_velocity(tmp_path, runner, patches, "potentialFoam")
    assert path.read_text() == "existing unrelated state"
    assert runner.calls == []


def test_impossible_potential_velocity_restores_exact_freestream_and_retains_proposal(tmp_path):
    runner, patches = fixture(tmp_path, proposed_speed=1200)
    original = (tmp_path / "0/U").read_bytes()
    result = initialize_compressible_velocity(tmp_path, runner, patches, "potentialFoam")
    assert result.ok
    assert (tmp_path / "0/U").read_bytes() == original
    assert (tmp_path / "pressure_initialization/U.freestream").read_bytes() == original
    assert "1200" in (tmp_path / "pressure_initialization/U.potential").read_text()
    receipt = json.loads((tmp_path / "pressure-initialization.json").read_text())
    assert receipt["applied"] is False
    assert receipt["fallback_reason"] == "exceeds_available_stagnation_enthalpy"
    assert receipt["maximum_proposed_velocity"] == 1200
    assert receipt["maximum_adiabatic_velocity"] == pytest.approx(math.sqrt(613000))
    assert receipt["velocity_sha256"] != receipt["proposed_velocity_sha256"]


def test_source_nasa7_enthalpy_rejects_measured_rae_initialization_peak(tmp_path):
    from airfoilfoam.numerical_canary import source_material_for_canary

    runner, patches = fixture(tmp_path, proposed_speed=1170.875072336956)
    runner.flow_execution.gas = source_material_for_canary(
        Path(__file__).parent / "fixtures/air-thermophysics-audit.json"
    )
    runner.flow_execution.state = ThermodynamicState(temperature_k=255.55555555555554, pressure_pa=108989)
    (tmp_path / "0/U").write_text("internalField uniform (233.72746451728528 0 0);")
    original = (tmp_path / "0/U").read_bytes()
    initialize_compressible_velocity(tmp_path, runner, patches, "potentialFoam")
    receipt = json.loads((tmp_path / "pressure-initialization.json").read_text())
    assert receipt["maximum_adiabatic_velocity"] == pytest.approx(605.2993174311963)
    assert receipt["applied"] is False
    assert (tmp_path / "0/U").read_bytes() == original


@pytest.mark.parametrize("ratio,applied", [(1 - 1e-8, True), (1 + 1e-8, False)])
def test_admissibility_uses_the_actual_gas_bound_not_a_fixed_velocity_cap(tmp_path, ratio, applied):
    bound = math.sqrt(100 ** 2 + 2 * 1005 * 300)
    runner, patches = fixture(tmp_path, proposed_speed=bound * ratio)
    initialize_compressible_velocity(tmp_path, runner, patches, "potentialFoam")
    receipt = json.loads((tmp_path / "pressure-initialization.json").read_text())
    assert receipt["applied"] is applied


@pytest.mark.parametrize("content", [
    b"internalField uniform (nan 0 0);",
    b"internalField uniform (1e309 0 0);",
    b"internalField uniform (1e200 0 0);",
    b"internalField uniform (1 2);",
    b"internalField nonuniform List<vector> 2 ((1 2 3));",
    b"internalField nonuniform List<vector> 0 ();",
    b"internalField nonuniform List<scalar> 1 ((1 2 3));",
    b"internalField uniform (1 2 3); internalField uniform (2 3 4);",
    b"FoamFile { format binary; } internalField uniform (1 2 3);",
    b"internalField nonuniform List<vector> 1 (\xff);",
])
def test_malformed_velocity_cannot_be_treated_as_a_safe_initializer(content):
    with pytest.raises(InfrastructureError, match="verify initialization"):
        internal_velocity_squared(content)


def test_velocity_parser_checks_all_components_and_ignores_comments():
    assert internal_velocity_squared(b"/* internalField uniform (900 0 0); */\ninternalField uniform (3 4 12);") == 169
    assert internal_velocity_squared(b"internalField nonuniform List<vector> 2 ((3 4 0) (0 0 -12));") == 144
    with pytest.raises(InfrastructureError, match="uniform freestream"):
        internal_velocity_squared(b"internalField nonuniform List<vector> 1 ((3 4 0));", require_uniform=True)


def test_failed_native_initializer_is_not_replaced_by_a_successful_fallback(tmp_path):
    runner, patches = fixture(tmp_path, proposed_speed=1200, returncode=1)
    result = initialize_compressible_velocity(tmp_path, runner, patches, "potentialFoam")
    assert not result.ok and result.returncode == 1
    receipt = json.loads((tmp_path / "pressure-initialization.json").read_text())
    assert receipt["applied"] is False and receipt["fallback_reason"] is None
    assert receipt["maximum_proposed_velocity"] is None
    assert (tmp_path / "pressure_initialization/U.freestream").is_file()
    assert (tmp_path / "pressure_initialization/U.potential").is_file()


@pytest.mark.parametrize("relative", ["pressure-initialization.json", "pressure_initialization"])
def test_existing_initialization_evidence_is_never_overwritten(tmp_path, relative):
    runner, patches = fixture(tmp_path)
    path = tmp_path / relative
    if relative.endswith(".json"):
        path.write_text("existing receipt")
    else:
        path.mkdir()
        (path / "U.potential").write_text("existing proposal")
    original = (tmp_path / "0/U").read_bytes()
    with pytest.raises(InfrastructureError, match="already exists"):
        initialize_compressible_velocity(tmp_path, runner, patches, "potentialFoam")
    assert runner.calls == []
    assert (tmp_path / "0/U").read_bytes() == original
    if path.is_file():
        assert path.read_text() == "existing receipt"
    else:
        assert (path / "U.potential").read_text() == "existing proposal"


@pytest.mark.parametrize("value", [-1, float('nan'), float('inf'), True])
def test_adiabatic_bound_rejects_nonphysical_freestream_magnitude(tmp_path, value):
    runner, _ = fixture(tmp_path)
    with pytest.raises(InfrastructureError, match="finite freestream"):
        adiabatic_velocity_limit_squared(runner.flow_execution, value)
