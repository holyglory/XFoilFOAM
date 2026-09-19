import hashlib
import json
from pathlib import Path

import pytest

from airfoilfoam.material_domain import material_domain_failure
from airfoilfoam.models import JobResult, JobState, Polar, PolarPoint
from airfoilfoam.openfoam.runner import RunResult
from scripts.materials.reproduce_mach3_failure import collect_diagnostics, diagnostic_request, execution_request, summarize_outcomes


ROOT = Path(__file__).parents[1]
COORDINATES = ROOT / "packages/db/seed/selig-database/fx60100.dat"
MATERIAL = ROOT / "tests/fixtures/air-thermophysics-audit.json"


def test_parallel_handoff_changes_only_explicit_execution_controls():
    original = diagnostic_request(COORDINATES, MATERIAL, "cold")
    assert execution_request(original, 1, 5000) == original
    changed = execution_request(original, 2, 100).model_dump()
    expected = original.model_dump()
    expected["resources"]["solver_processes"] = 2
    expected["solver"]["n_iterations"] = 100
    assert changed == expected
    assert original.solver.n_iterations == 5000 and original.resources.solver_processes == 1


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
