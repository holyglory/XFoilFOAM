import hashlib
import json
from pathlib import Path

import pytest

from airfoilfoam.material_domain import material_domain_failure
from airfoilfoam.models import JobResult, JobState, Polar, PolarPoint
from airfoilfoam.openfoam.runner import RunResult
from scripts.materials.reproduce_mach3_failure import collect_diagnostics, diagnostic_request, diagnostic_source_identity, execution_request, native_image_fingerprints, summarize_outcomes
from scripts.materials.replay_production_numerics import initialize_quiescent_velocity, replay_request, retain_failed_startup
from airfoilfoam.provenance import application_source_sha256


ROOT = Path(__file__).parents[1]
COORDINATES = ROOT / "packages/db/seed/selig-database/fx60100.dat"
MATERIAL = ROOT / "tests/fixtures/air-thermophysics-audit.json"


def test_quiescent_initial_guess_preserves_boundaries_and_physical_fields(tmp_path):
    velocity = b"FoamFile { format ascii; }\ninternalField uniform (1021 0 0);\nboundaryField { inlet { type fixedValue; value uniform (1021 0 0); } airfoil { type noSlip; } }\n"
    protected = {"0/p": b"pressure fixture", "0/T": b"temperature fixture", "constant/thermophysicalProperties": b"unchanged material fixture"}
    for name, content in {**protected, "0/U": velocity}.items():
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    receipt = initialize_quiescent_velocity(tmp_path)
    expected = velocity.replace(b"internalField uniform (1021 0 0);", b"internalField uniform (0 0 0);")
    assert (tmp_path / "0/U").read_bytes() == expected
    assert all((tmp_path / name).read_bytes() == content for name, content in protected.items())
    assert receipt["aerodynamic_evidence"] is False
    assert receipt["original_sha256"] == hashlib.sha256(velocity).hexdigest()
    first = next((tmp_path / "system/quiescentInitialization").glob("*/receipt.json"))
    original_receipt = first.read_bytes()
    initialize_quiescent_velocity(tmp_path)
    assert first.read_bytes() == original_receipt
    assert len(list((tmp_path / "system/quiescentInitialization").glob("*/receipt.json"))) == 2


def test_quiescent_initial_guess_never_overwrites_a_carried_velocity_field(tmp_path):
    velocity = tmp_path / "0/U"
    velocity.parent.mkdir()
    content = b"internalField nonuniform List<vector> 1 ((10 0 0));"
    velocity.write_bytes(content)
    with pytest.raises(ValueError, match="must not replace a carried field"):
        initialize_quiescent_velocity(tmp_path)
    assert velocity.read_bytes() == content


def test_failed_startup_capture_is_bounded_and_preserves_actual_field_bytes(tmp_path):
    source = tmp_path / "case"
    for name in ("0/U", "constant/thermophysicalProperties", "system/controlDict", "1/T", "2/T"):
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"isolated original field {name}".encode())
    (source / "material-domain-diagnostic.json").write_text('{"kind":"fixture"}')
    output = Path(retain_failed_startup(source, tmp_path / "captures"))
    receipt = json.loads((output / "capture.json").read_text())
    assert receipt["frames"] == [1, 2]
    assert receipt["coordinate_kind"] == "iteration"
    assert receipt["production_evidence"] is False
    assert (output / "2/T").read_bytes() == (source / "2/T").read_bytes()
    assert receipt["files"]["2/T"] == hashlib.sha256((source / "2/T").read_bytes()).hexdigest()
    (source / "5000").mkdir()
    assert retain_failed_startup(source, tmp_path / "captures") is None


def test_production_replay_preserves_the_complete_physical_and_numerical_request(tmp_path):
    original = diagnostic_request(COORDINATES, MATERIAL, "marched").model_dump(mode="json")
    original["execution_id"] = "11111111-1111-4111-8111-111111111111"
    original["expected_mesh_recovery_version"] = 2
    source_job = "22222222-2222-4222-8222-222222222222"
    source = tmp_path / "request.json"
    source.write_text(json.dumps({"source_job": source_job, "engine_request": original}))
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    job_id, preserved, request = replay_request(source, digest)
    assert job_id == source_job
    assert preserved.model_dump(mode="json") == original
    expected = dict(original)
    for name in ("execution_id", "expected_engine", "expected_execution_pool", "expected_mesh_recovery_version"):
        expected[name] = None
    expected["resources"] = {**original["resources"], "cpu_budget": 1, "solver_processes": 1, "case_concurrency": 1}
    expected["solver"] = {**original["solver"], "write_images": [], "frame_fields": []}
    assert request.model_dump(mode="json") == expected
    assert request.aoa.expand() == [-4, 13]
    assert request.resources.case_solver_budget_seconds == 900
    _, mesh_original, finite_mesh = replay_request(source, digest, finite_edge_mesh=True)
    assert mesh_original == preserved
    mesh_expected = {**expected, "mesh": {**expected["mesh"], "mesher": "blockmesh-cgrid-finite-edge"}}
    assert finite_mesh.model_dump(mode="json") == mesh_expected
    with pytest.raises(ValueError, match="original multi-angle sweep"):
        replay_request(source, digest, finite_edge_mesh=True, anchor_zero=True)
    _, anchor_original, anchor = replay_request(source, digest, anchor_zero=True)
    assert anchor_original == preserved
    expected["aoa"] = {**original["aoa"], "angles": [0]}
    assert anchor.model_dump(mode="json") == expected
    with pytest.raises(ValueError, match="zero-anchor comparison must be explicit"):
        replay_request(source, digest, anchor_zero=1)
    source.write_text(source.read_text() + " ")
    with pytest.raises(ValueError, match="retained production request changed"):
        replay_request(source, digest)


@pytest.mark.parametrize("changes", [
    {"force_transient": True}, {"momentum_scheme": "linearUpwind"}, {"flow_solver_family": "rhoPimpleFoam", "force_transient": True},
])
def test_production_replay_does_not_silently_substitute_another_method(tmp_path, changes):
    original = diagnostic_request(COORDINATES, MATERIAL, "cold").model_dump(mode="json")
    original["solver"].update(changes)
    source = tmp_path / "request.json"
    source.write_text(json.dumps({"source_job": "22222222-2222-4222-8222-222222222222", "engine_request": original}))
    with pytest.raises(ValueError, match="production density-based fast recipe"):
        replay_request(source, hashlib.sha256(source.read_bytes()).hexdigest())


def test_diagnostic_fingerprints_the_loaded_adapter_not_the_base_image(tmp_path):
    package = tmp_path / "src/airfoilfoam/__init__.py"
    package.parent.mkdir(parents=True)
    package.write_text("version = 'isolated test fixture'\n")
    with pytest.raises(ValueError, match="complete actually loaded"):
        diagnostic_source_identity(tmp_path, package)
    (tmp_path / "pyproject.toml").write_text("[project]\nname = 'isolated-test-fixture'\n")
    original = diagnostic_source_identity(tmp_path, package)
    assert original["engine_application_source_sha256"] == application_source_sha256(tmp_path)
    assert original["engine_source_revision"] is None
    package.write_text("version = 'changed isolated test fixture'\n")
    assert diagnostic_source_identity(tmp_path, package) != original
    with pytest.raises(ValueError, match="complete actually loaded"):
        diagnostic_source_identity(tmp_path, ROOT / "src/airfoilfoam/__init__.py")


def test_diagnostic_requires_the_image_native_fingerprints(tmp_path):
    with pytest.raises(FileNotFoundError):
        native_image_fingerprints(tmp_path)
    for name in ("package", "binary"):
        (tmp_path / f"airfoilfoam-engine-{name}-sha256").write_text("a" * 64 + "\n")
    assert native_image_fingerprints(tmp_path) == {"engine_package_sha256": "a" * 64, "engine_binary_sha256": "a" * 64}
    (tmp_path / "airfoilfoam-engine-binary-sha256").write_text("not a digest")
    with pytest.raises(ValueError, match="native image fingerprint"):
        native_image_fingerprints(tmp_path)


def test_parallel_handoff_changes_only_explicit_execution_controls():
    original = diagnostic_request(COORDINATES, MATERIAL, "cold")
    assert execution_request(original, 1, 5000) == original
    changed = execution_request(original, 2, 100).model_dump()
    expected = original.model_dump()
    expected["resources"]["solver_processes"] = 2
    expected["solver"]["n_iterations"] = 100
    assert changed == expected
    assert original.solver.n_iterations == 5000 and original.resources.solver_processes == 1


@pytest.mark.parametrize("mach", [1.2, 2])
def test_regime_comparison_changes_only_the_explicit_speed(mach):
    original = diagnostic_request(COORDINATES, MATERIAL, "cold", smoothing=0.2)
    variant = diagnostic_request(COORDINATES, MATERIAL, "cold", smoothing=0.2, mach=mach)
    expected = original.model_dump(mode="json")
    expected["speeds"] = [mach * original.fluid.gas.speed_of_sound(original.flow_state)]
    assert variant.model_dump(mode="json") == expected
    assert original.speeds == [1021.025]


@pytest.mark.parametrize("mach", [True, 0, 1.1, 1.5, 3, float("nan")])
def test_unplanned_regime_comparisons_are_rejected(mach):
    with pytest.raises(ValueError, match="Mach comparison"):
        diagnostic_request(COORDINATES, MATERIAL, "cold", mach=mach)


@pytest.mark.parametrize("processes,iterations", [(True, 5000), (0, 5000), (3, 5000), (2, 0), (2, 5050)])
def test_diagnostic_parallel_scope_cannot_expand(processes, iterations):
    with pytest.raises(ValueError, match="scope"):
        execution_request(diagnostic_request(COORDINATES, MATERIAL, "cold"), processes, iterations)


@pytest.mark.parametrize("start,angles", [("cold", [13]), ("marched", [-4, 13])])
def test_diagnostic_request_matches_the_observed_physics_and_recipe(start, angles):
    request = diagnostic_request(COORDINATES, MATERIAL, start)
    assert request.aoa.expand() == angles
    assert request.chord_lengths == [0.1]
    assert request.speeds == [1021.025]
    assert len(request.airfoil.points) == 97
    assert request.solver.flow_solver_family == "rhoCentralFoam"
    assert request.solver.momentum_scheme == "upwind"
    assert request.solver.n_iterations == 5000
    assert request.solver.convergence_tolerance == 0.0001
    assert request.solver.warm_start and not request.solver.force_transient
    assert not request.solver.transient_fallback
    assert request.solver.write_images == [] and request.solver.frame_fields == []
    assert request.resources.case_solver_budget_seconds == 900
    assert request.resources.solver_processes == 1
    assert request.mesh.n_surface == 84 and request.mesh.n_radial == 52
    assert request.mesh.n_wake == 40 and request.mesh.target_y_plus == 40
    assert request.fluid.gas.nasa7.minimum_temperature_k == 100
    assert request.fluid.gas.nasa7.maximum_temperature_k == 2000


@pytest.mark.parametrize("courant", [0.25, 0.1])
def test_smaller_local_step_changes_only_the_numerical_courant_setting(courant):
    original = diagnostic_request(COORDINATES, MATERIAL, "cold").model_dump()
    modified = diagnostic_request(COORDINATES, MATERIAL, "cold", courant).model_dump()
    original["solver"]["transient_max_courant"] = courant
    assert original == modified


@pytest.mark.parametrize("courant", [True, 0, -1, float("nan"), float("inf"), 5])
def test_unsupported_step_controls_are_rejected(courant):
    with pytest.raises(ValueError, match="Courant"):
        diagnostic_request(COORDINATES, MATERIAL, "cold", courant)


def test_rejected_attempts_remain_measurable_without_claiming_valid_polar_points():
    result = JobResult(job_id="isolated-fixture", state=JobState.failed, polars=[
        Polar(speed=1021.025, chord=0.1, reynolds=6962022, points=[], attempts=[
            PolarPoint(aoa_deg=13, error="material-domain failure", converged=False),
        ]),
    ])
    measured = summarize_outcomes(result)
    assert len(measured) == 1
    assert measured[0]["result_collection"] == "attempts"
    assert measured[0]["converged"] is False and measured[0]["cl"] is None
    assert measured[0]["error"] == "material-domain failure"


def test_changed_geometry_or_material_cannot_masquerade_as_the_observed_case(tmp_path):
    geometry = tmp_path / "modified.dat"
    geometry.write_text(COORDINATES.read_text().replace("0.00000", "0.00001"))
    with pytest.raises(ValueError, match="geometry"):
        diagnostic_request(geometry, MATERIAL, "cold")
    material = tmp_path / "material.json"
    material.write_bytes(MATERIAL.read_bytes() + b"\n")
    with pytest.raises(ValueError, match="pinned source-air"):
        diagnostic_request(COORDINATES, material, "cold")
    with pytest.raises(ValueError, match="starting state"):
        diagnostic_request(COORDINATES, MATERIAL, "invented")


@pytest.mark.parametrize("mutation", ["none", "changed", "missing", "traversal"])
def test_collected_diagnostic_requires_its_real_unchanged_log(tmp_path, mutation):
    case = tmp_path / "cases" / "c0p1_u1021"
    raw = "attempt to use janafThermo<EquationOfState> out of temperature range 100 -> 2000; T = 91\n"
    assert material_domain_failure(case, RunResult("rhoCentralFoam", -15, raw)) is not None
    signature = hashlib.sha256(raw.encode()).hexdigest()
    log = case / f"log.material-domain-{signature}"
    if mutation == "none":
        result = collect_diagnostics(tmp_path)
        assert len(result) == 1
        assert result[0]["solver_log_sha256"] == signature
        assert result[0]["minimum_attempted_temperature_k"] == 91
    else:
        if mutation == "changed":
            log.write_text("changed")
        elif mutation == "missing":
            log.unlink()
        else:
            path = case / "material-domain-diagnostic.json"
            record = json.loads(path.read_text())
            record["solver_log"] = "../../outside"
            path.write_text(json.dumps(record))
        with pytest.raises((ValueError, FileNotFoundError)):
            collect_diagnostics(tmp_path)
