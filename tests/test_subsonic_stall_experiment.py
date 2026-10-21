import hashlib
import json
from pathlib import Path

import pytest

from airfoilfoam.openfoam.dialects import (
    OPENCFD_2606_IDENTITY,
    UnsupportedEngineIdentity,
    get_openfoam_dialect,
)
from scripts.materials.subsonic_stall_experiment import (
    DEFAULT_MATERIAL,
    DEFAULT_SNAPSHOT,
    EXPECTED_SNAPSHOT_SHA256,
    ExperimentError,
    assert_no_production_write,
    build_experiment_plan,
    load_material,
    load_snapshot,
    selected_angles,
    write_plan_artifact,
)


ROOT = Path(__file__).parents[1]
MANIFEST = ROOT / ".codex-artifacts/subsonic-stall-repair-20261009/request-manifest.json"


def test_retained_requests_are_authenticated_and_exact():
    records, manifest = load_snapshot(ROOT / DEFAULT_SNAPSHOT, ROOT / MANIFEST)
    assert [record.profile for record in records] == ["e332", "e432"]
    assert [record.source_job for record in records] == [
        "50b9cfe1-55cd-49c2-ba02-367136d7f9dc",
        "2bedd5c3-4292-42ef-9044-f8080736cf36",
    ]
    assert manifest["files"]["production-request-snapshot.jsonl"]["sha256"] == EXPECTED_SNAPSHOT_SHA256
    assert all(record.request.solver.flow_solver_family == "simpleFoam" for record in records)


def test_fixed_selection_covers_attached_onset_and_stalled_angles():
    assert selected_angles("e332") == {
        "attached": (0.0, 5.0, 10.0),
        "stall_onset": (15.0,),
        "stalled": (20.0,),
    }
    assert selected_angles("e432") == {
        "attached": (0.0, 5.0),
        "stall_onset": (8.0, 9.0),
        "stalled": (15.0, 20.0),
    }


def test_plan_has_paired_simple_and_rho_pimple_controls_with_shared_physics():
    plan = build_experiment_plan(ROOT / DEFAULT_SNAPSHOT, ROOT / DEFAULT_MATERIAL, ROOT / MANIFEST)
    assert plan["outcome_id"] == "p10f9c0ef9d2f7efc"
    assert plan["bounds"] == {
        "profiles": 2,
        "physical_angles": 11,
        "solver_families": 2,
        "planned_cases": 4,
        "max_cases_per_profile": 2,
    }
    assert plan["execution_policy"]["coordinator_admission"] == "single-check"
    assert plan["execution_policy"]["job_order"] == "sequential"
    assert plan["execution_policy"]["max_concurrent_jobs"] == 1
    grouped = {}
    for run in plan["runs"]:
        grouped.setdefault(run["comparison_group"], {})[run["solver_family"]] = run
    assert len(grouped) == 2
    for pair in grouped.values():
        steady = pair["simpleFoam"]["request"]
        transient = pair["rhoPimpleFoam"]["request"]
        assert steady["airfoil"] == transient["airfoil"]
        assert steady["chord_lengths"] == transient["chord_lengths"]
        assert steady["speeds"] == transient["speeds"]
        assert steady["aoa"] == transient["aoa"]
        assert len(steady["aoa"]["angles"]) in (5, 6)
        assert steady["mesh"] == transient["mesh"]
        assert steady["roughness"] == transient["roughness"]
        assert steady["fluid"]["density"] == transient["fluid"]["density"]
        assert steady["fluid"]["kinematic_viscosity"] == transient["fluid"]["kinematic_viscosity"]
        for field in ("n_iterations", "convergence_tolerance", "momentum_scheme", "transient_max_courant"):
            assert steady["solver"][field] == transient["solver"][field]
        assert transient["solver"]["flow_solver_family"] == "rhoPimpleFoam"
        assert transient["solver"]["force_transient"] is True
        assert transient["solver"]["transient_fallback"] is False
        assert transient["flow_state"] == {"pressure_pa": 101325.0, "temperature_k": 288.15}
        assert transient["fluid"]["gas"]


def test_plan_accepts_verified_numerics2_and_rejects_numerics1():
    plan = build_experiment_plan(ROOT / DEFAULT_SNAPSHOT, ROOT / DEFAULT_MATERIAL, ROOT / MANIFEST)
    expected_engine = OPENCFD_2606_IDENTITY.model_dump(mode="json")
    expected_pool = get_openfoam_dialect(OPENCFD_2606_IDENTITY).queue_name

    for run in plan["runs"]:
        assert run["request"]["expected_engine"] == expected_engine
        assert run["request"]["expected_execution_pool"] == expected_pool

    stale_engine = OPENCFD_2606_IDENTITY.model_copy(update={"numerics_revision": "1"})
    with pytest.raises(UnsupportedEngineIdentity, match="numerics 1"):
        get_openfoam_dialect(stale_engine)


def test_material_binding_matches_both_retained_transport_values():
    material = load_material(ROOT / DEFAULT_MATERIAL)
    records, _ = load_snapshot(ROOT / DEFAULT_SNAPSHOT, ROOT / MANIFEST)
    dynamic_viscosity = material.gas.dynamic_viscosity(material.state.temperature_k)
    assert material.gas.density(material.state) == pytest.approx(records[0].request.fluid.density, rel=1e-9)
    assert dynamic_viscosity == pytest.approx(records[0].request.fluid.density * records[0].request.fluid.nu, rel=1e-9)
    assert material.gas.nasa7.minimum_temperature_k == 100
    assert material.gas.nasa7.maximum_temperature_k == 2000


def test_plan_artifact_is_new_and_immutable(tmp_path):
    plan = build_experiment_plan(ROOT / DEFAULT_SNAPSHOT, ROOT / DEFAULT_MATERIAL, ROOT / MANIFEST)
    destination = tmp_path / "subsonic-stall"
    receipt = write_plan_artifact(plan, destination, ROOT / DEFAULT_SNAPSHOT, ROOT / MANIFEST, ROOT / DEFAULT_MATERIAL)
    assert receipt["planned_cases"] == 4
    assert json.loads((destination / "experiment-plan.json").read_text())["production_write"] is False
    snapshot_copy = destination / "inputs/production-request-snapshot.jsonl"
    assert hashlib.sha256(snapshot_copy.read_bytes()).hexdigest() == EXPECTED_SNAPSHOT_SHA256
    before = (destination / "experiment-plan.json").read_bytes()
    with pytest.raises(ExperimentError, match="already exists"):
        write_plan_artifact(plan, destination, ROOT / DEFAULT_SNAPSHOT, ROOT / MANIFEST, ROOT / DEFAULT_MATERIAL)
    assert (destination / "experiment-plan.json").read_bytes() == before


def test_production_write_guard_rejects_credentials_and_protected_storage(tmp_path):
    with pytest.raises(ExperimentError, match="credentials"):
        assert_no_production_write(tmp_path / "diagnostic", {"AIRFOILFOAM_EVIDENCE_BUCKET": "prod-bucket"})
    with pytest.raises(ExperimentError, match="below /data/airfoilfoam"):
        assert_no_production_write(Path("/data/airfoilfoam/subsonic-stall"), {})


def test_plan_is_solver_free_by_default_and_native_execution_requires_coordinator_runtime(tmp_path):
    plan = build_experiment_plan(ROOT / DEFAULT_SNAPSHOT, ROOT / DEFAULT_MATERIAL, ROOT / MANIFEST)
    from scripts.materials import subsonic_stall_experiment as experiment

    with pytest.raises(ExperimentError, match="governed check"):
        experiment.execute_governed_plan(plan, tmp_path / "missing-plan")
