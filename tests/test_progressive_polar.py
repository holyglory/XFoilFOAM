from dataclasses import replace

import numpy as np
import pytest

from airfoilfoam.postprocess.progressive_polar import (
    PolarModelPolicy, PolarObservation, PolarPrior, fit_progressive_polar,
    _acquisition_reduction,
)


def prior():
    angles = [-4.0, -2.0, 0.0, 2.0, 4.0]
    return PolarPrior("physical-target", "test-prediction", "single", angles,
                      [[0.1 * alpha, 0.02, -0.03] for alpha in angles],
                      [[0.3, 0.02, 0.1] for _ in angles], {"fixture": True})


def policy():
    return PolarModelPolicy("test-policy", [0.4, 0.4, 0.1], [0.15, 0.15, 0.03],
                            [0.5, 0.3, 0.1], [0.15, 0.2, 0.03],
                            [0.03, 0.03, 0.005], [0.01, 0.01, 0.001], 2.0, 0.8, "unvalidated")


def observation(identity="sample", alpha=0.0, cl=0.2, method="openfoam_fast", **kwargs):
    return PolarObservation(identity, "result-" + identity, "attempt-" + identity, "lineage-" + identity,
                            "physical-target", "single", method, alpha, [cl, 0.024, -0.035],
                            [0.02, 0.002, 0.003], True, "converged", "steady", **kwargs)


def test_no_evidence_returns_the_actual_prior_without_claiming_cfd():
    fitted = fit_progressive_polar(prior(), [], policy())
    assert fitted["best_method"] == "neuralfoil"
    assert fitted["contributors"] == []
    np.testing.assert_allclose(fitted["curves"]["composite"]["coefficients"], prior().coefficients)
    assert set(fitted["curves"]) == {"composite"}
    assert fitted["kind"] == "estimate"
    assert fitted["calibration_status"] == "unvalidated"
    assert fitted["acquisition"]["status"] == "no_eligible_cfd"
    assert fitted["acquisition"]["candidates"] == []
    assert fitted["acquisition"]["prospective_noise_std"] is None


def test_acquisition_integrates_nonuniform_grid_and_penalizes_noise():
    angles = np.array([0., 1., 4.])
    covariance, coverage = _acquisition_reduction(angles, np.ones(3), np.eye(3), np.ones(3), 0.25, np.zeros((3, 3)))
    np.testing.assert_allclose(covariance, [0.1, 0.4, 0.3])
    np.testing.assert_allclose(coverage, 0)
    noisy, _ = _acquisition_reduction(angles, np.ones(3), np.eye(3), np.ones(3), 4, np.zeros((3, 3)))
    assert np.all(noisy < covariance)
    with pytest.raises(ValueError, match="exceeds"):
        _acquisition_reduction(angles, np.ones(3), np.eye(3) * 10, np.ones(3), 0.25, np.zeros((3, 3)))


@pytest.mark.parametrize("methods", [["openfoam_fast"], ["openfoam_precise"], ["openfoam_fast", "openfoam_precise"]])
def test_acquisition_is_bounded_and_uses_only_unobserved_angles(methods):
    rows = [observation(str(index), alpha=0, method=method) for index, method in enumerate(methods)]
    fitted = fit_progressive_polar(prior(), rows, policy())
    acquisition = fitted["acquisition"]
    assert acquisition["status"] == "available"
    assert [item["alpha"] for item in acquisition["candidates"]] == [-4, -2, 2, 4]
    for candidate in acquisition["candidates"]:
        components = np.array(candidate["covariance_reduction_fraction"]) + candidate["coverage_reduction_fraction"]
        assert np.all(components >= 0) and np.all(components <= 1 + 1e-8)
        assert candidate["integrated_variance_reduction_fraction"] == pytest.approx(np.mean(components))
    assert acquisition["candidates"][0]["integrated_variance_reduction_fraction"] == pytest.approx(acquisition["candidates"][-1]["integrated_variance_reduction_fraction"])
    assert fitted["calibration_status"] == "unvalidated"


def test_fully_observed_grid_has_no_new_angle_acquisition_and_rejected_evidence_does_not_claim_coverage():
    rows = [observation(str(index), alpha=alpha) for index, alpha in enumerate(prior().alpha)]
    assert fit_progressive_polar(prior(), rows, policy())["acquisition"]["candidates"] == []
    rejected = replace(rows[-1], eligible=False, exclusion_reason="nonphysical", numerical_convergence="nonphysical")
    fitted = fit_progressive_polar(prior(), [*rows[:-1], rejected], policy())
    assert [item["alpha"] for item in fitted["acquisition"]["candidates"]] == [4]


def test_one_anchor_adjusts_entire_polar_with_regularized_offset():
    fitted = fit_progressive_polar(prior(), [observation()], policy())
    corrected = np.array(fitted["curves"]["composite"]["coefficients"])
    assert fitted["best_method"] == "openfoam_fast"
    assert "openfoam_precise" not in fitted["curves"]
    correction = corrected[:, 0] - np.array(prior().coefficients)[:, 0]
    assert np.all(correction > 0.1)
    np.testing.assert_allclose(correction, correction[0])
    interval = np.array(fitted["curves"]["composite"]["upper"])[:, 0] - corrected[:, 0]
    assert interval[0] > interval[2]


def test_two_distinct_anchors_also_adjust_slope():
    fitted = fit_progressive_polar(prior(), [observation("left", -2, -0.3), observation("right", 2, 0.5)], policy())
    corrected = np.array(fitted["curves"]["composite"]["coefficients"])
    assert corrected[-1, 0] - corrected[0, 0] > 0.9


def test_precise_observation_does_not_relabel_fast_evidence():
    rows = [observation("fast", cl=0.25), observation("precise", cl=0.4, method="openfoam_precise")]
    fitted = fit_progressive_polar(prior(), rows, policy())
    assert fitted["curves"]["openfoam_precise"]["coefficients"][2][0] > fitted["curves"]["openfoam_fast"]["coefficients"][2][0]
    assert fitted["contributors"][0]["result_id"] == "result-fast"
    assert fitted["contributors"][1]["result_id"] == "result-precise"


def test_contradictory_points_widen_uncertainty_and_drag_stays_positive():
    consistent = fit_progressive_polar(prior(), [observation("a"), observation("b")], policy())
    conflicting = fit_progressive_polar(prior(), [observation("a"), observation("b", cl=-1.0)], policy())
    assert conflicting["diagnostics"][0]["disagreement_variance_multiplier"] > consistent["diagnostics"][0]["disagreement_variance_multiplier"]
    assert np.all(np.array(conflicting["curves"]["composite"]["lower"])[:, 1] > 0)


@pytest.mark.parametrize("change", [{"target_signature": "different-condition"}, {"branch": "descending"},
                                    {"numerical_convergence": "diverged"}, {"statistical_certification": "startup_only"},
                                    {"coefficients": [0.2, -0.01, 0.0]}, {"alpha": 5.0}])
def test_incompatible_or_corrupt_evidence_cannot_be_fused(change):
    with pytest.raises(ValueError):
        fit_progressive_polar(prior(), [replace(observation(), **change)], policy())


def test_rejected_evidence_is_retained_as_explanation_not_curve_input():
    bad = replace(observation(), eligible=False, exclusion_reason="diverged", numerical_convergence="diverged")
    fitted = fit_progressive_polar(prior(), [bad], policy())
    assert fitted["contributors"] == []
    assert fitted["excluded"] == [{"observation_id": "sample", "reason": "diverged"}]


def test_unconverged_informative_evidence_remains_explicitly_unconverged():
    row = replace(observation(), numerical_convergence="unconverged", statistical_certification="informative_uncertified")
    fitted = fit_progressive_polar(prior(), [row], policy())
    assert fitted["contributors"][0]["numerical_convergence"] == "unconverged"
    assert fitted["curves"]["composite"]["coefficients"][2][0] > 0


def test_overlapping_history_and_duplicate_observations_are_rejected():
    first = observation("block-1", window=(0.0, 2.0))
    second = replace(observation("block-2", window=(1.0, 3.0)), lineage_id=first.lineage_id)
    with pytest.raises(ValueError, match="Overlapping"):
        fit_progressive_polar(prior(), [first, second], policy())
    with pytest.raises(ValueError, match="Duplicate"):
        fit_progressive_polar(prior(), [first, first], policy())
    second = replace(second, window=(2.0, 4.0))
    assert len(fit_progressive_polar(prior(), [first, second], policy())["contributors"]) == 2


def test_signature_is_order_independent_and_sensitive_to_evidence_and_policy():
    rows = [observation("first", -2, -0.1), observation("second", 2, 0.3)]
    fitted = fit_progressive_polar(prior(), rows, policy())
    assert fitted["signature"] == fit_progressive_polar(prior(), list(reversed(rows)), policy())["signature"]
    assert fitted["signature"] != fit_progressive_polar(prior(), rows, replace(policy(), correlation_length_deg=3))["signature"]
    with pytest.raises(ValueError, match="validation evidence"):
        fit_progressive_polar(prior(), rows, replace(policy(), calibration_status="validated"))
