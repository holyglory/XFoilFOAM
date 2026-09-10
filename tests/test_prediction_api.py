from dataclasses import asdict, replace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from airfoilfoam.api.main import _require_control_plane_bearer, create_app
from airfoilfoam.api.predictions import prediction_router
from test_neuralfoil_solver import condition, geometry, recipe
from test_polar_history import history, reduction
from test_progressive_polar import observation, policy, prior


def client_and_request():
    app = FastAPI()
    app.include_router(prediction_router("prediction-test-token", _require_control_plane_bearer))
    coordinates, provenance = geometry()
    request = {"epoch_id": str(uuid4()), "lease_token": str(uuid4()), "coordinates": coordinates,
               "geometry_provenance": provenance, "conditions": [asdict(condition())], "recipe": asdict(recipe())}
    return TestClient(app), request


def test_health_advertises_the_actual_geometry_fit_implementation():
    assert TestClient(create_app()).get("/health").json()["neuralfoil_geometry_fit_version"] == 2


def test_engine_api_returns_real_fenced_prediction_not_a_cfd_job():
    client, request = client_and_request()
    response = client.post("/predictions/neuralfoil", json=request,
                           headers={"Authorization": "Bearer prediction-test-token"})
    assert response.status_code == 200
    result = response.json()
    assert result["epoch_id"] == request["epoch_id"]
    assert result["lease_token"] == request["lease_token"]
    assert len(result["predictions"]) == 1
    assert result["predictions"][0]["kind"] == "prediction"
    assert result["predictions"][0]["cfd_evidence"] is False
    assert all(row[1] > 0 for row in result["predictions"][0]["coefficients"])
    assert "job_id" not in result


def test_prediction_endpoint_preserves_control_plane_authentication_and_rejects_bad_geometry():
    client, request = client_and_request()
    for headers in ({}, {"Authorization": "Bearer wrong"}):
        assert client.post("/predictions/neuralfoil", json=request, headers=headers).status_code == 401
    request["coordinates"] = [[0, 0]] * 8
    result = client.post("/predictions/neuralfoil", json=request,
                         headers={"Authorization": "Bearer prediction-test-token"})
    assert result.status_code == 422
    assert "predictions" not in result.json()


def test_prediction_endpoint_refuses_unbounded_batches():
    client, request = client_and_request()
    request["conditions"][0]["alpha"] = list(range(32769))
    response = client.post("/predictions/neuralfoil", json=request,
                           headers={"Authorization": "Bearer prediction-test-token"})
    assert response.status_code == 422
    assert "bounded angle budget" in response.json()["detail"]


def progressive_request():
    return {"epoch_id": str(uuid4()), "lease_token": str(uuid4()),
            "prior": asdict(prior()), "observations": [], "histories": [],
            "history_policy": asdict(reduction()), "policy": asdict(policy())}


def post_progressive(request, headers=None):
    client, _ = client_and_request()
    return client.post("/predictions/progressive-polar", json=request,
                       headers=headers if headers is not None else {"Authorization": "Bearer prediction-test-token"})


def test_progressive_endpoint_adjusts_the_entire_prior_with_one_exact_point():
    request = progressive_request()
    request["observations"] = [asdict(observation())]
    response = post_progressive(request)
    assert response.status_code == 200
    payload = response.json()
    assert payload["epoch_id"] == request["epoch_id"]
    assert payload["lease_token"] == request["lease_token"]
    assert len(payload["request_signature"]) == 64
    estimate = payload["estimate"]
    assert estimate["kind"] == "estimate"
    assert estimate["calibration_status"] == "unvalidated"
    assert estimate["contributors"][0]["attempt_id"] == "attempt-sample"
    assert all(current[0] > baseline[0] + 0.1 for current, baseline in zip(
        estimate["curves"]["composite"]["coefficients"], request["prior"]["coefficients"]))
    assert "openfoam_precise" not in estimate["curves"]
    assert "job_id" not in payload


def test_progressive_endpoint_reduces_multiple_unconverged_histories_jointly():
    request = progressive_request()
    request["histories"] = [asdict(history(-2, "left")), asdict(history(2, "right"))]
    response = post_progressive(request)
    assert response.status_code == 200
    estimate = response.json()["estimate"]
    assert len(estimate["contributors"]) == 6
    assert {row["attempt_id"] for row in estimate["contributors"]} == {"attempt-left", "attempt-right"}
    assert all(row["numerical_convergence"] == "unconverged" for row in estimate["contributors"])
    assert estimate["curves"]["composite"]["coefficients"][2][0] > 0.1


def test_progressive_signature_is_independent_of_delivery_lease_but_pins_history_policy():
    request = progressive_request()
    first = post_progressive(request).json()
    request["lease_token"] = str(uuid4())
    request["epoch_id"] = str(uuid4())
    assert post_progressive(request).json()["request_signature"] == first["request_signature"]
    request["history_policy"]["block_duration"] = 3
    assert post_progressive(request).json()["request_signature"] != first["request_signature"]


@pytest.mark.parametrize("headers", [{}, {"Authorization": "Bearer wrong"}])
def test_progressive_endpoint_preserves_control_plane_authentication(headers):
    assert post_progressive(progressive_request(), headers).status_code == 401


@pytest.mark.parametrize("change", [
    {"target_signature": "another-physical-target"}, {"branch": "descending"},
    {"numerical_convergence": "diverged"}, {"statistical_certification": "startup_only"},
    {"coefficients": [0.1, -0.01, 0.0]},
])
def test_progressive_endpoint_rejects_incompatible_or_nonphysical_evidence(change):
    request = progressive_request()
    request["observations"] = [asdict(replace(observation(), **change))]
    response = post_progressive(request)
    assert response.status_code == 422
    assert "estimate" not in response.json()


def test_progressive_endpoint_retains_exclusions_without_using_them_as_points():
    request = progressive_request()
    request["observations"] = [asdict(replace(observation(), eligible=False, exclusion_reason="diverged",
                                                numerical_convergence="diverged"))]
    response = post_progressive(request)
    assert response.status_code == 200
    estimate = response.json()["estimate"]
    assert estimate["contributors"] == []
    assert estimate["excluded"] == [{"observation_id": "sample", "reason": "diverged"}]
    assert estimate["best_method"] == "neuralfoil"


@pytest.mark.parametrize("limit", ["grid", "samples", "observations", "blocks", "policy"])
def test_progressive_endpoint_refuses_unbounded_or_unconfigured_joint_fits(limit):
    request = progressive_request()
    if limit == "grid":
        request["prior"]["alpha"] = list(range(1025))
    elif limit == "samples":
        request["histories"] = [asdict(replace(history(), coordinate=list(range(32769))))]
    elif limit == "observations":
        request["observations"] = [asdict(observation(str(index))) for index in range(129)]
    elif limit == "blocks":
        request["histories"] = [asdict(history(identity=str(index))) for index in range(43)]
    else:
        request["histories"] = [asdict(history())]
        request["history_policy"] = None
    response = post_progressive(request)
    assert response.status_code == 422
    assert "estimate" not in response.json()


def test_excluded_attempt_metadata_does_not_consume_the_numerical_observation_budget():
    request = progressive_request()
    request["observations"] = [asdict(replace(observation(str(index)), eligible=False,
        coefficients=None, standard_error=None, exclusion_reason="review_exclude")) for index in range(256)]
    request["histories"] = [asdict(history())]
    response = post_progressive(request)
    assert response.status_code == 200
    assert len(response.json()["estimate"]["excluded"]) == 256
    assert len(response.json()["estimate"]["contributors"]) == 3
    request["observations"] *= 3
    assert post_progressive(request).status_code == 422
