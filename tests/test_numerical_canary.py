from pathlib import Path
import json
from types import SimpleNamespace

import pytest

from airfoilfoam.numerical_canary import run_canary, source_material_for_canary
from airfoilfoam.openfoam.dialects import OPENCFD_2606
from airfoilfoam.openfoam.runner import DeterministicMeshError, InfrastructureError, RunResult, Runner


ASPECT_ONLY = (
    " ***High aspect ratio cells found, Max aspect ratio: 25716.220065, number of cells 744\n"
    "    Mesh non-orthogonality Max: 78.12 average: 31.0\n"
    "Failed 1 mesh checks.\n"
)


class CanaryRunner(Runner):
    def __init__(self, mesh_output, mesh_code, solver_suffix="", first_courant=0.1):
        self.settings = SimpleNamespace(engine_identity=lambda: OPENCFD_2606.identity)
        self.mesh_output = mesh_output
        self.mesh_code = mesh_code
        self.commands = []
        self.solver_suffix = solver_suffix
        self.first_courant = first_courant

    def run(self, case_dir, command, timeout=7200, monitor=None):
        self.commands.append(command)
        if command.startswith("checkMesh"):
            return RunResult(command, self.mesh_code, self.mesh_output)
        if command.endswith("xfoilfoamAcousticStartup"):
            return RunResult(command, 0, "XFOILFOAM_ACOUSTIC_STARTUP " + json.dumps({
                "version": 1, "courant_rate": 1e8, "maximum_courant": 0.2,
                "requested_delta_t": 1e-8, "safe_delta_t": 0.2 / 1.2e8,
            }) + "\n")
        if command == "rhoCentralFoam":
            coefficients = case_dir / "postProcessing/forceCoeffs1/0/coefficient.dat"
            coefficients.parent.mkdir(parents=True)
            coefficients.write_text("# Time Cd Cl CmPitch\n0 0.1 0.2 -0.03\n1 0.1 0.2 -0.03\n2 0.1 0.2 -0.03\n")
            return RunResult(command, 0, f"Mean and max Courant Numbers = 0.01 {self.first_courant}\nTime = 1\nTime = 2\nEnd\n" + self.solver_suffix)
        return RunResult(command, 0, "")


def canary(tmp_path, runner):
    coordinates = Path(__file__).parents[1] / "packages/db/seed/selig-database/ag24.dat"
    return run_canary("rhoCentralFoam", 3, coordinates, tmp_path / "case", runner)


@pytest.mark.parametrize("returncode", [0, 1])
def test_canary_uses_production_mesh_qa_and_discloses_anisotropy(tmp_path, returncode):
    runner = CanaryRunner(ASPECT_ONLY, returncode)
    receipt = canary(tmp_path, runner)
    assert receipt["mesh_quality"]["aspect_ratio_only_failure"] is True
    assert receipt["mesh_quality"]["max_aspect_ratio"] == 25716.220065
    assert receipt["quality_warnings"]
    assert receipt["converged_polar_validated"] is False
    assert (tmp_path / "case/log.checkMesh").read_text() == ASPECT_ONLY
    assert "rhoCentralFoam" in runner.commands


@pytest.mark.parametrize("output,code,error", [
    (ASPECT_ONLY.replace("Failed 1", " ***Max skewness = 6.2\nFailed 2"), 1, DeterministicMeshError),
    (ASPECT_ONLY.replace("78.12", "88.3"), 1, DeterministicMeshError),
    (ASPECT_ONLY + "negative cell volume\n", 1, DeterministicMeshError),
    (ASPECT_ONLY, 124, InfrastructureError),
    ("Mesh OK.\n", 0, RuntimeError),
])
def test_canary_does_not_run_solver_after_bad_or_incomplete_mesh_qa(tmp_path, output, code, error):
    runner = CanaryRunner(output, code)
    with pytest.raises(error):
        canary(tmp_path, runner)
    assert "rhoCentralFoam" not in runner.commands
    assert not (tmp_path / "case/receipt.json").exists()


def test_canary_uses_the_supplied_material_without_falling_back_to_constant_air(tmp_path):
    fixture = Path(__file__).parent / "fixtures/air-thermophysics-audit.json"
    gas = source_material_for_canary(fixture)
    runner = CanaryRunner(ASPECT_ONLY, 0)
    coordinates = Path(__file__).parents[1] / "packages/db/seed/selig-database/ag24.dat"
    receipt = run_canary("rhoCentralFoam", 3, coordinates, tmp_path / "case", runner, gas=gas)
    assert receipt["gas_model"] == gas.model_dump(mode="json")
    assert receipt["converged_polar_validated"] is False
    assert "polynomial" in (tmp_path / "case/constant/thermophysicalProperties").read_text()
    assert "libxfoilfoamThermophysics.so" in (tmp_path / "case/system/controlDict").read_text()


@pytest.mark.parametrize("separator", [" ", "\n    "])
def test_canary_rejects_material_clamping_even_when_native_solver_exits_zero(tmp_path, separator):
    warning = f"attempt to use janafThermo<EquationOfState>{separator}out of temperature range 150 -> 2000; T = 104.4\n"
    runner = CanaryRunner(ASPECT_ONLY, 0, warning)
    with pytest.raises(RuntimeError, match="clamped temperature"):
        canary(tmp_path, runner)
    assert warning in (tmp_path / "case/log.rhoCentralFoam").read_text()
    assert (tmp_path / "case/material-domain-diagnostic.json").is_file()
    assert not (tmp_path / "case/receipt.json").exists()


def test_canary_does_not_confuse_a_temperature_range_description_with_native_clamping(tmp_path):
    runner = CanaryRunner(ASPECT_ONLY, 0, "Configured material temperature range 150 -> 2000\n")
    assert canary(tmp_path, runner)["converged_polar_validated"] is False


@pytest.mark.parametrize("first_courant", [0.21, 518.049, float("nan")])
def test_canary_rejects_first_step_courant_violation(tmp_path, first_courant):
    with pytest.raises(RuntimeError, match="first-step Courant"):
        canary(tmp_path, CanaryRunner(ASPECT_ONLY, 0, first_courant=first_courant))
    assert not (tmp_path / "case/receipt.json").exists()
