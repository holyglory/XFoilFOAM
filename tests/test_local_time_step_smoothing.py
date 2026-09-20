from pathlib import Path

import pytest

from airfoilfoam.models import PolarRequest, SolverParams
from scripts.materials.reproduce_mach3_failure import diagnostic_request


ROOT = Path(__file__).parents[1]


def request_for(smoothing=None):
    return diagnostic_request(
        ROOT / "packages/db/seed/selig-database/fx60100.dat",
        ROOT / "tests/fixtures/air-thermophysics-audit.json",
        "cold", smoothing=smoothing,
    )


def test_legacy_serialization_does_not_add_optional_numerics_or_capabilities():
    request = request_for()
    for mode in ("python", "json"):
        payload = request.model_dump(mode=mode)
        assert "local_time_step_smoothing" not in payload["solver"]
        assert "expected_local_time_step_version" not in payload
        assert PolarRequest.model_validate(payload).model_dump(mode=mode) == payload
    assert request.solver.local_time_step_smoothing is None


@pytest.mark.parametrize("smoothing", [0.02, 0.2])
def test_explicit_setting_changes_only_numerics_and_capability(smoothing):
    legacy = request_for().model_dump(mode="json")
    changed = request_for(smoothing).model_dump(mode="json")
    legacy["solver"]["local_time_step_smoothing"] = smoothing
    legacy["expected_local_time_step_version"] = 1
    assert changed == legacy
    assert PolarRequest.model_validate_json(request_for(smoothing).model_dump_json()).model_dump(mode="json") == changed


@pytest.mark.parametrize("value", [True, False, "0.2", -0.01, 1.01, float("nan"), float("inf")])
def test_invalid_or_coerced_smoothing_is_rejected(value):
    with pytest.raises(ValueError):
        SolverParams(local_time_step_smoothing=value)


@pytest.mark.parametrize("value", [0, 0.02, 0.2, 1])
def test_native_smoothing_bounds_are_supported(value):
    assert SolverParams(local_time_step_smoothing=value).local_time_step_smoothing == value


def test_explicit_setting_requires_a_capability_before_execution():
    payload = request_for(0.2).model_dump(mode="json")
    payload.pop("expected_local_time_step_version")
    with pytest.raises(ValueError, match="expected_local_time_step_version"):
        PolarRequest.model_validate(payload)


@pytest.mark.parametrize("family,transient", [("rhoCentralFoam", True), ("rhoPimpleFoam", True), ("rhoSimpleFoam", False), (None, False)])
def test_setting_cannot_be_silently_ignored_by_another_numerical_method(family, transient):
    payload = request_for(0.2).model_dump(mode="json")
    payload["solver"].update(flow_solver_family=family, force_transient=transient)
    with pytest.raises(ValueError, match="local-steady rhoCentralFoam"):
        PolarRequest.model_validate(payload)


@pytest.mark.parametrize("smoothing", [True, -1, 0, 0.5, float("nan")])
def test_diagnostic_scope_remains_the_prespecified_comparison(smoothing):
    with pytest.raises(ValueError, match="smoothing comparison"):
        request_for(smoothing)
