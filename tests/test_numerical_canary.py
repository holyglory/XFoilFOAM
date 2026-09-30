from pathlib import Path
import json
import hashlib
import re
from types import SimpleNamespace

import pytest

from airfoilfoam.numerical_canary import run_canary, source_material_for_canary
from airfoilfoam.openfoam.dialects import OPENCFD_2606
from airfoilfoam.openfoam.runner import DeterministicMeshError, InfrastructureError, RunResult, Runner
from scripts.materials.build_energy_probe import instrument
from scripts.materials.build_acoustic_probe import instrument as instrument_acoustic
from scripts.materials.replay_precise_state import bounded_gradients


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
            ceiling = float(re.search(r"\bmaxCo\s+(\S+);", (case_dir / "system/controlDict").read_text())[1])
            return RunResult(command, 0, "XFOILFOAM_ACOUSTIC_STARTUP " + json.dumps({
                "version": 1, "courant_rate": 1e8, "maximum_courant": ceiling,
                "requested_delta_t": 1e-8, "safe_delta_t": ceiling / 1.2e8,
            }) + "\n")
        if command == "rhoCentralFoam":
            coefficients = case_dir / "postProcessing/forceCoeffs1/0/coefficient.dat"
            coefficients.parent.mkdir(parents=True, exist_ok=True)
            coefficients.write_text("# Time Cd Cl CmPitch\n0 0.1 0.2 -0.03\n1 0.1 0.2 -0.03\n2 0.1 0.2 -0.03\n")
            return RunResult(command, 0, f"Mean and max Courant Numbers = 0.01 {self.first_courant}\nTime = 1\nTime = 2\nEnd\n" + self.solver_suffix)
        return RunResult(command, 0, "")


def canary(tmp_path, runner, **options):
    coordinates = Path(__file__).parents[1] / "packages/db/seed/selig-database/ag24.dat"
    return run_canary("rhoCentralFoam", 3, coordinates, tmp_path / "case", runner, **options)


@pytest.mark.parametrize("returncode", [0, 1])
def test_canary_uses_production_mesh_qa_and_discloses_anisotropy(tmp_path, returncode):
    runner = CanaryRunner(ASPECT_ONLY, returncode)
    receipt = canary(tmp_path, runner)
    assert receipt["mesh_quality"]["aspect_ratio_only_failure"] is True
    assert receipt["mesh_quality"]["max_aspect_ratio"] == 25716.220065
    assert receipt["mesher"]["name"] == "cartesian2d-external-boundary-layer"
    assert "cartesian2DMesh" in runner.commands
    assert "blockMesh" not in runner.commands
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


def test_canary_handoff_checks_both_real_invocations(tmp_path):
    runner = CanaryRunner(ASPECT_ONLY, 0)
    receipt = canary(tmp_path, runner, first_order_startup=True)
    assert runner.commands.count("rhoCentralFoam") == 2
    assert receipt["initial_first_order_startup"]["measured_first_courant"] == 0.1
    assert receipt["acoustic_startup"]["measured_first_courant"] == 0.1
    directory = tmp_path / "case"
    assert (directory / "system/fvSchemes").read_bytes() == (directory / "fvSchemes.requested").read_bytes()
    assert "upwind" in (directory / "fvSchemes.startup").read_text()
    assert "vanLeerV" in (directory / "fvSchemes.requested").read_text()
    assert (directory / "log.rhoCentralFoam.startup").is_file()


def test_canary_does_not_handoff_after_a_first_stage_courant_violation(tmp_path):
    runner = CanaryRunner(ASPECT_ONLY, 0, first_courant=0.21)
    with pytest.raises(RuntimeError, match="first-step Courant"):
        canary(tmp_path, runner, first_order_startup=True)
    assert runner.commands.count("rhoCentralFoam") == 1
    assert not (tmp_path / "case/receipt.json").exists()


@pytest.mark.parametrize("options", [
    {"maximum_courant": 0.05}, {"momentum_scheme": "upwind"},
    {"limited_nonorthogonal": True}, {"finite_edge_mesh": True},
    {"tadmor_flux": True}, {"minmod_reconstruction": True},
])
def test_canary_comparison_records_the_actual_recipe(tmp_path, options):
    runner = CanaryRunner(ASPECT_ONLY, 0, first_courant=0.04)
    receipt = canary(tmp_path, runner, save_every_step=True, **options)
    for key, value in options.items():
        assert receipt["startup_comparison"][key] == value
    assert receipt["converged_polar_validated"] is False
    schemes = (tmp_path / "case/system/fvSchemes").read_text()
    if options.get("limited_nonorthogonal"):
        assert "Gauss linear limited 0.5" in schemes
    if options.get("finite_edge_mesh"):
        assert receipt["mesher"]["cache_version"] == "finite-edge-central-wake-v1"
        assert "blockMesh" in runner.commands and "cartesian2DMesh" not in runner.commands
    if options.get("tadmor_flux"):
        assert re.search(r"fluxScheme\s+Tadmor;", schemes)
        assert "vanLeerV" in schemes
    if options.get("minmod_reconstruction"):
        assert re.search(r"reconstruct\(U\)\s+MinmodV;", schemes)
        assert re.search(r"reconstruct\(T\)\s+Minmod;", schemes)
        assert re.search(r"reconstruct\(rho\)\s+Minmod;", schemes)
        assert re.search(r"fluxScheme\s+Kurganov;", schemes)


def test_energy_probe_instrumentation_preserves_the_original_operations():
    source = '\n'.join([
        '#include "fvcSmooth.H"',
        '        volTensorField tauMC("tauMC", muEff*dev2(Foam::T(fvc::grad(U))));',
        '        rhoU.boundaryFieldRef() == rho.boundaryField()*U.boundaryField();',
        '        e.correctBoundaryConditions();',
        '        thermo.correct();',
    ])
    digest = hashlib.sha256(source.encode()).hexdigest()
    result = instrument(source, digest)
    assert result.count("reportEnergyBalance(runTime") == 1
    assert result.index("reportEnergyBalance(runTime") < result.index("thermo.correct();")
    original_lines = [line for line in result.splitlines() if line in source.splitlines()]
    assert original_lines == source.splitlines()
    with pytest.raises(ValueError, match="exact pinned solver source"):
        instrument(source)
    with pytest.raises(ValueError, match="exact pinned solver source"):
        instrument(source + " ", digest)
    changed = source.replace('        e.correctBoundaryConditions();', '')
    with pytest.raises(ValueError, match="insertion point changed"):
        instrument(changed, hashlib.sha256(changed.encode()).hexdigest())
    duplicated = source + '\n        e.correctBoundaryConditions();'
    with pytest.raises(ValueError, match="insertion point changed"):
        instrument(duplicated, hashlib.sha256(duplicated.encode()).hexdigest())


def test_density_probe_preserves_the_exact_preflight_and_exit_conditions():
    source = (Path(__file__).parents[1] / "src/airfoilfoam/native/acoustic-startup/acousticStartup.C").read_text()
    digest = hashlib.sha256(source.encode()).hexdigest()
    probed = instrument_acoustic(source, digest)
    original = probed.replace('\n#include "densityDiagnostic.H"', '').replace(
        "    reportDensityReconstruction(mesh, density, material->p(), material->T(), forwardDensity, backwardDensity);\n", "")
    assert original == source
    assert "return 2;" in probed
    with pytest.raises(ValueError, match="exact acoustic source"):
        instrument_acoustic(source + " ", digest)
    changed = source.replace("    if (gMin(forwardDensity)", "    if (gMin(changedDensity)")
    with pytest.raises(ValueError, match="insertion points"):
        instrument_acoustic(changed, hashlib.sha256(changed.encode()).hexdigest())


def test_saved_state_gradient_comparison_retains_original_transport_schemes():
    original = "gradSchemes { default Gauss linear; grad(U) cellLimited Gauss linear 1; }\ninterpolationSchemes { reconstruct(rho) vanLeer; reconstruct(U) vanLeerV; reconstruct(T) vanLeer; }"
    assert bounded_gradients(original, "original") == original
    density = bounded_gradients(original, "density")
    assert density.replace("\n    grad(rho) cellLimited Gauss linear 1;", "") == original
    assert bounded_gradients(original, "all").replace("default cellLimited Gauss linear 1;", "default Gauss linear;") == original
    assert bounded_gradients(original, "minmod-density").replace("reconstruct(rho) Minmod;", "reconstruct(rho) vanLeer;") == original
    assert bounded_gradients(original, "minmod-all").replace("MinmodV", "vanLeerV").replace("Minmod", "vanLeer") == original
    with pytest.raises(ValueError, match="settings changed"):
        bounded_gradients(original.replace("default Gauss linear;", "default leastSquares;"), "density")


def test_energy_probe_execution_is_explicit_and_fingerprinted(tmp_path):
    class ProbeRunner(CanaryRunner):
        def run(self, case_dir, command, timeout=7200, monitor=None):
            if command.endswith("xfoilfoamEnergyProbe'"):
                self.commands.append(command)
                command = "rhoCentralFoam"
            return super().run(case_dir, command, timeout, monitor)

    executable = tmp_path / "test fixture" / "xfoilfoamEnergyProbe"
    executable.parent.mkdir()
    executable.write_bytes(b"isolated executable identity fixture, not native CFD")
    runner = ProbeRunner(ASPECT_ONLY, 0)
    receipt = canary(tmp_path, runner, energy_probe=executable)
    assert receipt["startup_comparison"]["energy_probe_sha256"] == hashlib.sha256(executable.read_bytes()).hexdigest()
    assert any(command.startswith("'") and command.endswith("xfoilfoamEnergyProbe'") for command in runner.commands)
    assert receipt["converged_polar_validated"] is False


def test_matched_farfield_is_isolated_to_the_requested_numerical_comparison(tmp_path):
    class PressureRunner(CanaryRunner):
        def run(self, case_dir, command, timeout=7200, monitor=None):
            return super().run(case_dir, "rhoCentralFoam" if command == "rhoPimpleFoam" else command, timeout, monitor)

    coordinates = Path(__file__).parents[1] / "packages/db/seed/selig-database/ag24.dat"
    canary(tmp_path, CanaryRunner(ASPECT_ONLY, 0))
    for matched in (False, True):
        directory = tmp_path / str(matched)
        receipt = run_canary("rhoPimpleFoam", 3, coordinates, directory, PressureRunner(ASPECT_ONLY, 0), density_farfield=matched)
        assert receipt["startup_comparison"]["density_farfield"] is matched
        for name in ("U", "p", "T"):
            pressure_source = (directory / "0" / name).read_bytes()
            density_source = (tmp_path / "case/0" / name).read_bytes()
            assert (pressure_source == density_source) is matched
        assert "rhoPimpleFoam" in (directory / "system/controlDict").read_text()
        assert "PIMPLE" in (directory / "system/fvSolution").read_text()
