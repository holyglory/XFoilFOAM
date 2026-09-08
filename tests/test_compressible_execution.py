from pathlib import Path
from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from airfoilfoam import pipeline
from airfoilfoam.airfoil import Airfoil, parse_airfoil
from airfoilfoam.cache import EngineCache
from airfoilfoam.meshing.base import BoundaryPatch
from airfoilfoam.models import PolarRequest, SolverParams
from airfoilfoam.openfoam.budget import BudgetedRunner
from airfoilfoam.openfoam.dialects import OPENCFD_2606, dialect_for_runner
from airfoilfoam.openfoam.execution import configure_flow_execution, is_compressible, is_density_based
from airfoilfoam.openfoam.runner import InfrastructureError, RunResult, Runner
from airfoilfoam.thermodynamics import GasThermodynamics, ThermodynamicState


class RecordedRunner(Runner):
    def __init__(self):
        self.settings = SimpleNamespace(engine_identity=lambda: OPENCFD_2606.identity, engine_runtime_identity=lambda: None)
        self.commands = []

    def run(self, case_dir, command, timeout=7200, monitor=None):
        self.commands.append(command)
        return RunResult(command, 0, "")


@pytest.fixture
def request_payload():
    coordinates = (Path(__file__).parents[1] / "packages/db/seed/selig-database/ag24.dat").read_text()
    gas = GasThermodynamics(
        gas_constant=287.05, heat_capacity_cp=1005, transport_model="constant",
        reference_dynamic_viscosity=1.82e-5, reference_temperature_k=298,
        prandtl=0.71, provenance="isolated request-contract regression definition",
    )
    state = ThermodynamicState(temperature_k=298, pressure_pa=100000)
    return {
        "airfoil": {"name": "ag24", "coordinates": coordinates}, "aoa": {"angles": [0, 2]},
        "chord_lengths": [1], "speeds": [0.72 * gas.speed_of_sound(state)],
        "fluid": {"density": gas.density(state), "dynamic_viscosity": gas.dynamic_viscosity(298), "gas": gas.model_dump()},
        "flow_state": state.model_dump(),
        "solver": {"flow_solver_family": "rhoSimpleFoam", "turbulent_prandtl": 0.85, "force_transient": False},
    }


@pytest.mark.parametrize("family,mach", [("rhoSimpleFoam", 0.72), ("rhoPimpleFoam", 0.95), ("rhoCentralFoam", 3)])
def test_explicit_flow_contract_round_trips_and_scopes_commands(request_payload, family, mach):
    request_payload["solver"].update(flow_solver_family=family, force_transient=family != "rhoSimpleFoam")
    request_payload["speeds"] = [request_payload["speeds"][0] / 0.72 * mach]
    request = PolarRequest.model_validate(request_payload)
    assert PolarRequest.model_validate_json(request.model_dump_json()) == request
    runner = RecordedRunner()
    configure_flow_execution(runner, request)
    assert is_compressible(runner)
    assert is_density_based(runner) == (family == "rhoCentralFoam")
    dialect = dialect_for_runner(runner)
    assert dialect.steady_solver_command == ("rhoCentralFoam" if family == "rhoCentralFoam" else "rhoSimpleFoam")
    assert dialect.transient_solver_command == ("rhoCentralFoam" if family == "rhoCentralFoam" else "rhoPimpleFoam")
    assert dialect_for_runner(BudgetedRunner(runner, 900)) == dialect
    assert dialect_for_runner(RecordedRunner()) == OPENCFD_2606
    assert OPENCFD_2606.steady_solver_command == "simpleFoam"


@pytest.mark.parametrize("family,mach", [("rhoSimpleFoam", 0.72), ("rhoPimpleFoam", 0.95), ("rhoCentralFoam", 3)])
def test_explicit_variable_calorics_reach_the_request_scoped_execution(request_payload, family, mach):
    gas = GasThermodynamics(**{
        **request_payload["fluid"]["gas"], "heat_capacity_model": "nasa7", "heat_capacity_cp": None,
        "transport_model": "sutherland", "prandtl": None, "sutherland_temperature_k": 110,
        "nasa7": {"minimum_temperature_k": 150, "common_temperature_k": 500, "maximum_temperature_k": 1500,
                  "low_coefficients": [3, 0.001, 0, 0, 0, 0, 0], "high_coefficients": [3, 0.001, 0, 0, 0, 0, 0],
                  "provenance": "Isolated analytic request round-trip test, not air material data"},
    })
    state = ThermodynamicState.model_validate(request_payload["flow_state"])
    request_payload["fluid"]["gas"] = gas.model_dump()
    request_payload["speeds"] = [mach * gas.speed_of_sound(state)]
    request_payload["solver"].update(flow_solver_family=family, force_transient=family != "rhoSimpleFoam")
    request = PolarRequest.model_validate(request_payload)
    runner = RecordedRunner()
    configure_flow_execution(runner, request)
    assert runner.flow_execution.gas == gas
    assert runner.flow_execution.gas.heat_capacity_at(800) == pytest.approx(gas.gas_constant * 3.8)
    assert runner.flow_execution.gas.openfoam_dictionary()["thermoType"]["thermo"] == "janaf"
    assert PolarRequest.model_validate_json(request.model_dump_json()) == request


def test_request_rejects_calorics_that_cover_freestream_but_not_stagnation(request_payload):
    gas = GasThermodynamics(**{
        **request_payload["fluid"]["gas"], "heat_capacity_model": "nasa7", "heat_capacity_cp": None,
        "transport_model": "sutherland", "prandtl": None, "sutherland_temperature_k": 110,
        "nasa7": {"minimum_temperature_k": 150, "common_temperature_k": 350, "maximum_temperature_k": 500,
                  "low_coefficients": [3, 0.001, 0, 0, 0, 0, 0], "high_coefficients": [3, 0.001, 0, 0, 0, 0, 0],
                  "provenance": "Isolated narrow-temperature caloric preflight fixture, not air material data"},
    })
    state = ThermodynamicState.model_validate(request_payload["flow_state"])
    request_payload["fluid"]["gas"] = gas.model_dump()
    request_payload["speeds"] = [0.5 * gas.speed_of_sound(state)]
    assert PolarRequest.model_validate(request_payload).fluid.gas == gas
    request_payload["speeds"] = [3 * gas.speed_of_sound(state)]
    request_payload["solver"].update(flow_solver_family="rhoCentralFoam", force_transient=True)
    with pytest.raises(ValidationError, match="stagnation temperature exceeds"):
        PolarRequest.model_validate(request_payload)


@pytest.mark.parametrize("missing", ["gas", "flow_state", "turbulent_prandtl"])
def test_compressible_request_cannot_silently_drop_required_physics(request_payload, missing):
    target = request_payload["fluid"] if missing == "gas" else request_payload["solver"] if missing == "turbulent_prandtl" else request_payload
    del target[missing]
    with pytest.raises(ValidationError, match="explicit gas"):
        PolarRequest.model_validate(request_payload)


def test_local_density_request_preserves_steady_mode_and_refuses_implicit_urans(request_payload):
    request_payload["speeds"] = [request_payload["speeds"][0] / 0.72 * 3]
    request_payload["solver"].update(flow_solver_family="rhoCentralFoam", force_transient=False, transient_fallback=False)
    request = PolarRequest.model_validate(request_payload)
    assert not PolarRequest.model_validate_json(request.model_dump_json()).solver.force_transient
    request_payload["solver"]["transient_fallback"] = True
    with pytest.raises(ValidationError, match="controller-owned"):
        PolarRequest.model_validate(request_payload)


@pytest.mark.parametrize("change", ["density", "viscosity", "mode", "mach", "low_central", "incompressible_gas", "unknown_family"])
def test_inconsistent_requests_fail_before_case_staging(request_payload, change):
    if change == "density":
        request_payload["fluid"]["density"] *= 2
    elif change == "viscosity":
        request_payload["fluid"]["dynamic_viscosity"] *= 2
    elif change == "mode":
        request_payload["solver"]["force_transient"] = True
    elif change == "mach":
        request_payload["speeds"] = [1500]
    elif change == "low_central":
        request_payload["solver"].update(flow_solver_family="rhoCentralFoam", force_transient=True)
    elif change == "incompressible_gas":
        request_payload["solver"]["flow_solver_family"] = "simpleFoam"
    else:
        request_payload["solver"]["flow_solver_family"] = "guessedSolver"
    with pytest.raises(ValidationError):
        PolarRequest.model_validate(request_payload)


def test_seed_identity_includes_gas_state_and_numerical_family(request_payload):
    request = PolarRequest.model_validate(request_payload)
    with pytest.raises(ValueError, match="thermodynamic state"):
        EngineCache.seed_key("mesh", request.fluid, request.speeds[0])
    original = EngineCache.seed_key("mesh", request.fluid, request.speeds[0], request.flow_state)
    warmer = request.flow_state.model_copy(update={"temperature_k": 310})
    assert EngineCache.seed_key("mesh", request.fluid, request.speeds[0], warmer) != original
    changed = request.fluid.model_copy(update={"gas": request.fluid.gas.model_copy(update={"heat_capacity_cp": 1100})})
    assert EngineCache.seed_key("mesh", changed, request.speeds[0], request.flow_state) != original
    assert EngineCache.solver_signature(request.solver, request.roughness) != EngineCache.solver_signature(SolverParams(), request.roughness)


@pytest.mark.parametrize("marched", [False, True])
def test_density_pipeline_skips_pseudo_steady_and_preserves_shared_mesh(request_payload, monkeypatch, tmp_path, marched):
    request_payload["solver"].update(flow_solver_family="rhoCentralFoam", force_transient=True)
    request_payload["speeds"] = [request_payload["speeds"][0] / 0.72 * 2]
    request = PolarRequest.model_validate(request_payload)
    runner = RecordedRunner()
    configure_flow_execution(runner, request)
    airfoil = Airfoil.from_contour("ag24", parse_airfoil(request.airfoil.coordinates))
    patches = [BoundaryPatch("airfoil", "wall"), BoundaryPatch("inlet", "inlet"), BoundaryPatch("outlet", "outlet"), BoundaryPatch("frontAndBack", "empty")]
    mesher = SimpleNamespace(patches=lambda _: patches, cell_count=lambda _: 0)
    mesh_dir = tmp_path / "mesh"
    mesh_dir.mkdir()
    linked, finalized = [], []
    monkeypatch.setattr(pipeline, "resolve_mesh_params", lambda mesh, *_: mesh)
    monkeypatch.setattr(pipeline, "_link_mesh", lambda destination, source, _: linked.append((destination, source)))

    def finalizer(case_dir, outcome, *args, **kwargs):
        finalized.append((outcome.spec.aoa_deg, kwargs["shared_mesh_dir"]))
        assert (case_dir / "constant/aerodynamicReference.json").is_file()
        assert (case_dir / "0/T").is_file()
        assert outcome.cl is None and outcome.iterations is None
        raise InfrastructureError("isolated routing fixture ends before physical integration")

    monkeypatch.setattr(pipeline, "_finalize_outcome", finalizer)
    if marched:
        result = pipeline.solve_polar_marched(
            tmp_path / "polar", mesh_dir, airfoil, 1, request.speeds[0], request.fluid,
            request.roughness, request.mesh, request.solver, mesher, runner, [0, 2], render_images=False,
        )
        assert len(result.attempts) == 2
        assert all(item.outcome.error and item.outcome.cl is None and not item.outcome.converged for item in result.points)
    else:
        result = pipeline.run_case(
            tmp_path / "case", airfoil, request.cases()[0], request.fluid, request.roughness,
            request.mesh, request.solver, mesher, runner, mesh_dir=mesh_dir, render_images=False,
        )
        assert result.error and result.cl is None
    assert len(finalized) == (2 if marched else 1)
    assert all(source == mesh_dir for _, source in linked + finalized)
    assert runner.commands == []


@pytest.mark.parametrize("family,fallback,expected", [
    ("rhoPimpleFoam", False, ["potentialFoam -initialiseUBCs -pName pXfoilfoamInitial", "rhoSimpleFoam"]),
    ("rhoPimpleFoam", True, []),
    ("rhoCentralFoam", False, []),
])
def test_transient_preparation_preserves_compressible_state_during_velocity_initialization(request_payload, monkeypatch, tmp_path, family, fallback, expected):
    request_payload["solver"].update(flow_solver_family=family, force_transient=True)
    if family == "rhoCentralFoam":
        request_payload["speeds"] = [request_payload["speeds"][0] / 0.72 * 2]
    request = PolarRequest.model_validate(request_payload)
    runner = RecordedRunner()
    configure_flow_execution(runner, request)
    airfoil = Airfoil.from_contour("ag24", parse_airfoil(request.airfoil.coordinates))
    patches = [BoundaryPatch("airfoil", "wall"), BoundaryPatch("inlet", "inlet"), BoundaryPatch("outlet", "outlet"), BoundaryPatch("frontAndBack", "empty")]
    mesh_dir = tmp_path / "mesh"
    mesh_dir.mkdir()
    monkeypatch.setattr(pipeline, "get_mesher", lambda _: SimpleNamespace(patches=lambda _: patches))
    monkeypatch.setattr(pipeline, "_link_mesh", lambda *_: None)
    monkeypatch.setattr(pipeline, "shared_mesh_qa_verified", lambda _: True)
    case_dir = tmp_path / "transient"
    pipeline._prepare_transient_case(
        case_dir, airfoil, request.mesh, request.cases()[0], request.fluid, request.roughness,
        request.solver, runner, 1, 30, shared_mesh_dir=mesh_dir, freestream_fallback=fallback,
    )
    assert runner.commands == expected
    builder = pipeline._case_builder(
        runner, airfoil, patches, request.mesh, request.cases()[0], request.fluid, request.roughness,
        request.solver, dialect=dialect_for_runner(runner),
    )
    builder.write_transient(case_dir, 0, 0.02, 1e-7, write_interval=1e-4, max_delta_t=1e-5)
    control = (case_dir / "system/controlDict").read_text()
    assert family in control
    assert "rhoSimpleFoam" not in control
    assert "0.02" in control
