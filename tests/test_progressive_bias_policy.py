from dataclasses import asdict, replace
import hashlib
import json
import math

import numpy as np
import pytest

from airfoilfoam.api.predictions import ProgressivePolarRequest, calculate_progressive_polar
from airfoilfoam.postprocess.progressive_polar import fit_progressive_polar
from test_progressive_polar import observation, policy, prior


def uncertain():
    return replace(observation(), numerical_convergence="unconverged",
                   statistical_certification="informative_uncertified", accepted_cfd=False)


def test_versioned_bias_option_matches_offline_added_variance_exactly():
    source = uncertain()
    errors = list(source.standard_error)
    errors[0] = math.hypot(errors[0], 0.3)
    errors[1] = source.coefficients[1] * math.sqrt(math.expm1(math.log1p((errors[1] / source.coefficients[1]) ** 2) + 0.5 ** 2))
    errors[2] = math.hypot(errors[2], 0.1)
    expected = fit_progressive_polar(prior(), [replace(source, standard_error=errors)], policy())
    actual = fit_progressive_polar(prior(), [source], replace(policy(), uncertified_fast_bias_std=[0.3, 0.5, 0.1]))
    assert actual["version"] == "progressive-polar-gp-v3"
    assert actual["calibration_status"] == "unvalidated" and actual["validation_id"] is None
    for method in actual["curves"]:
        for channel in ("coefficients", "lower", "upper"):
            np.testing.assert_allclose(actual["curves"][method][channel], expected["curves"][method][channel], rtol=1e-12)
    assert source.standard_error == observation().standard_error


@pytest.mark.parametrize("kind", ["accepted", "precise", "steady", "periodic", "aperiodic", "excluded"])
def test_bias_does_not_change_accepted_precise_or_excluded_evidence(kind):
    source = uncertain()
    if kind == "accepted":
        source = replace(source, accepted_cfd=True)
    elif kind == "precise":
        source = replace(source, method="openfoam_precise")
    elif kind == "excluded":
        source = replace(source, eligible=False, exclusion_reason="isolated excluded evidence")
    else:
        source = replace(source, statistical_certification=kind)
    baseline = fit_progressive_polar(prior(), [source], policy())
    candidate = fit_progressive_polar(prior(), [source], replace(policy(), uncertified_fast_bias_std=[0.3, 0.5, 0.1]))
    assert candidate["curves"] == baseline["curves"]
    assert candidate["contributors"] == baseline["contributors"]
    assert candidate["excluded"] == baseline["excluded"]


@pytest.mark.parametrize("bias", [[-1, 0, 0], [0.1, 0.2], [0.1, float("nan"), 0.1], [0.1, float("inf"), 0.1]])
def test_bias_requires_a_finite_nonnegative_vector(bias):
    with pytest.raises(ValueError):
        fit_progressive_polar(prior(), [uncertain()], replace(policy(), uncertified_fast_bias_std=bias))


def test_unknown_acceptance_and_unsupported_validation_claim_fail_closed():
    selected = replace(policy(), uncertified_fast_bias_std=[0.3, 0.5, 0.1])
    with pytest.raises(ValueError, match="acceptance metadata"):
        fit_progressive_polar(prior(), [observation()], selected)
    with pytest.raises(ValueError, match="no physical validation"):
        fit_progressive_polar(prior(), [uncertain()], replace(selected, calibration_status="validated", validation_id="unproven"))


def test_absent_optional_fields_preserve_legacy_fit_and_request_signatures():
    legacy_observation, legacy_policy = asdict(observation()), asdict(policy())
    legacy_observation.pop("accepted_cfd")
    legacy_policy.pop("uncertified_fast_bias_std")
    legacy = {"prior": asdict(prior()), "policy": legacy_policy, "observations": [legacy_observation]}
    serialize = lambda value: json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    expected_fit = hashlib.sha256(serialize({"version": "progressive-polar-gp-v2", **legacy})).hexdigest()
    request = {"epoch_id": "00000000-0000-0000-0000-000000000001", "lease_token": "00000000-0000-0000-0000-000000000002",
               **legacy, "histories": [], "history_policy": None}
    normalized = ProgressivePolarRequest.model_validate(request)
    payload = normalized.model_dump(mode="json", exclude={"epoch_id", "lease_token"})
    payload["policy"].pop("uncertified_fast_bias_std")
    payload["observations"][0].pop("accepted_cfd")
    expected_request = hashlib.sha256(serialize(payload)).hexdigest()
    actual = calculate_progressive_polar(normalized)
    assert actual["estimate"]["signature"] == expected_fit
    assert actual["request_signature"] == expected_request
    assert actual["estimate"]["version"] == "progressive-polar-gp-v2"
