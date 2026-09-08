import json
from types import SimpleNamespace

import pytest

from airfoilfoam.meshing.base import BoundaryPatch
from airfoilfoam.openfoam.potential_initialization import initialize_compressible_velocity
from airfoilfoam.openfoam.runner import InfrastructureError, RunResult


def fixture(tmp_path, *, change_physics=False, failure=False, family="rhoSimpleFoam"):
    for directory in ["0", "constant"]:
        (tmp_path / directory).mkdir()
    for name, value in {"0/p": "physical pressure", "0/T": "physical temperature",
                        "0/U": "initial velocity", "constant/thermophysicalProperties": "selected material"}.items():
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
        (case_dir / "0/U").write_text("velocity calculated by test fixture")
        if change_physics:
            (case_dir / "0/T").write_text("unexpected thermal mutation")
        return RunResult(command, 0, "isolated initialization trace")

    runner = SimpleNamespace(flow_execution=SimpleNamespace(family=family), solver=solve, calls=calls)
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
