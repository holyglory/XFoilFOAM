from dataclasses import replace
import math

import pytest

from airfoilfoam.postprocess.polar_validation import PolarReference, PolarValidationCase
from airfoilfoam.postprocess.progressive_polar import PolarModelPolicy, PolarPrior
from scripts.materials.evaluate_uiuc_prior import identity
from scripts.materials.uiuc_condition_validation import GROUP_CENTERS, evaluate_condition_groups, reynolds_group


def condition_fixture(reynolds, suffix):
    condition = {"reynolds": reynolds, "mach_assumption": 0, "n_crit_assumption": 9,
                 "transition_assumption": "free", "surface": "Clean"}
    signature = identity(condition)
    prior = PolarPrior(f"target-{suffix}", f"prediction-{suffix}", "up", [0, 2], [[.1, .02, -.03], [.3, .03, -.04]],
                       [[.3, .01, .1], [.3, .015, .1]], {"fixture": True})
    reference = PolarReference(f"reference-{suffix}", "a" * 64, "experimental", prior.target_signature, "up", [0, 2],
                               [[.2, .03, None], [.4, .04, None]], False)
    return PolarValidationCase(f"case-{suffix}", "same-profile", signature, prior, [], reference), condition


def fixture_policy():
    return PolarModelPolicy("fixture-policy", [.4, .4, .1], [.15, .15, .03], [.5, .3, .1], [.15, .2, .03],
                            [.03, .03, .005], [.01, .01, .001], 2, .8, "unvalidated")


def test_grouping_keeps_nearby_conditions_together_without_rounding_targets():
    pairs = [condition_fixture(center, str(center)) for center in GROUP_CENTERS]
    pairs.append(condition_fixture(101200, "nearby-repeat"))
    cases = [case for case, _ in pairs]
    conditions = {case.condition_signature: values for case, values in pairs}
    folds = evaluate_condition_groups(cases, conditions, fixture_policy())
    assert len(folds) == 7
    assert sum(fold["baseline"]["case_count"] for fold in folds) == len(cases)
    target_fold = next(fold for fold in folds if fold["held_out_reynolds_group_center"] == 100000)
    assert target_fold["baseline"]["case_count"] == 2
    assert len(target_fold["evaluation_condition_signatures"]) == 2
    for fold in folds:
        assert not set(fold["fit_condition_signatures"]) & set(fold["evaluation_condition_signatures"])
        assert fold["finite_scale_availability"]["available"] is False
        assert fold["finite_scale_availability"]["groups"] == 6
        assert fold["finite_scale_availability"]["reason"] == "insufficient_independent_groups"
        assert fold["baseline"]["calibration_status"] == "unvalidated"
    assert conditions[cases[-1].condition_signature]["reynolds"] == 101200


@pytest.mark.parametrize("value", [None, True, 0, -1, math.nan, math.inf, 80000, 330000])
def test_grouping_rejects_invalid_or_undeclared_conditions(value):
    with pytest.raises(ValueError):
        reynolds_group(value)


def test_grouping_includes_declared_edges_and_refuses_just_outside():
    assert reynolds_group(38000) == reynolds_group(42000) == 40000
    with pytest.raises(ValueError, match="declared"):
        reynolds_group(37999)


def test_condition_identity_and_single_group_guards():
    case, values = condition_fixture(100000, "first")
    with pytest.raises(ValueError, match="exact identity"):
        evaluate_condition_groups([case], {case.condition_signature: {**values, "reynolds": 200000}}, fixture_policy())
    with pytest.raises(ValueError, match="two separated"):
        evaluate_condition_groups([case], {case.condition_signature: values}, fixture_policy())
    with pytest.raises(ValueError, match="repeats"):
        evaluate_condition_groups([case, case], {case.condition_signature: values}, fixture_policy())
    other, other_values = condition_fixture(200000, "second")
    with pytest.raises(ValueError, match="exact identity"):
        evaluate_condition_groups([replace(case, condition_signature="missing"), other],
                                  {case.condition_signature: values, other.condition_signature: other_values}, fixture_policy())
