import math
from dataclasses import replace

import pytest

from airfoilfoam.postprocess.polar_validation import PolarReference, PolarValidationCase
from airfoilfoam.postprocess.progressive_polar import PolarPrior
from scripts.materials.uiuc_family_calibration import PILOTS, case_score, conformal_scale, family_split, scale_prior


def test_predeclared_split_keeps_pilots_out_of_validation_and_models_together():
    families = list(PILOTS) + [f"isolated-family-{index}" for index in range(23)]
    split = family_split(families)
    assert len(split["calibration"]) == 19
    assert len(split["validation"]) == 7
    assert PILOTS <= set(split["calibration"])
    assert not set(split["calibration"]) & set(split["validation"])
    assert family_split(list(reversed(families)) + [families[0]]) == split
    with pytest.raises(ValueError, match="predeclared"):
        family_split(families[:-1])


def test_small_samples_do_not_get_an_interpolated_finite_95_percent_certificate():
    assert conformal_scale({f"family-{index}": index + 1 for index in range(18)})["available"] is False
    result = conformal_scale({f"family-{index}": index + 1 for index in range(19)})
    assert result["available"] is True
    assert result["rank"] == 19
    assert result["scale"] == 19
    assert conformal_scale({f"family-{index}": 0 for index in range(19)})["available"] is False


@pytest.mark.parametrize("scores", [{}, {"family": -1}, {"family": math.inf}, {"family": math.nan}, {"family": True}, {"": 1}])
def test_refuses_corrupt_calibration_scores(scores):
    with pytest.raises(ValueError):
        conformal_scale(scores)


def candidate_fixture():
    prior = PolarPrior("target", "prediction", "up", [0, 2], [[0.1, 0.02, -0.03], [0.3, 0.03, -0.04]],
                       [[0.3, 0.01, 0.1], [0.3, 0.015, 0.1]], {"fixture": True})
    reference = PolarReference("reference", "a" * 64, "experimental", "target", "up", [0, 2],
                               [[0.2, 0.03, None], [0.4, 0.04, None]], False)
    return PolarValidationCase("case", "family", "condition", prior, [], reference)


def test_candidate_scales_transformed_intervals_without_changing_predictions():
    case = candidate_fixture()
    scaled = scale_prior(case, 1.2743)
    assert scaled.prior.coefficients == case.prior.coefficients
    assert scaled.reference == case.reference
    assert scaled.prior.standard_deviation != case.prior.standard_deviation
    assert case_score(scaled) == pytest.approx(case_score(case) / 1.2743)
    for before, after in zip(case.prior.standard_deviation, scaled.prior.standard_deviation, strict=True):
        assert after[0] == pytest.approx(before[0] * 1.2743)
        assert after[2] == before[2]


@pytest.mark.parametrize("scale", [True, 0, -1, math.inf, math.nan, 1e200])
def test_candidate_rejects_invalid_or_unrepresentable_scales(scale):
    with pytest.raises(ValueError):
        scale_prior(candidate_fixture(), scale)


def test_scoring_does_not_silently_interpolate_or_ignore_fitting_evidence():
    case = candidate_fixture()
    with pytest.raises(ValueError, match="interpolate"):
        case_score(replace(case, reference=replace(case.reference, alpha=[0, 3])))
    with pytest.raises(ValueError, match="anchors"):
        case_score(replace(case, observations=[object()]))
