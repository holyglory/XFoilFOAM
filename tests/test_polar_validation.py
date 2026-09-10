from copy import deepcopy
from dataclasses import replace
from dataclasses import asdict
import hashlib
import json

import numpy as np
import pytest

from airfoilfoam.postprocess.polar_validation import PolarReference, PolarValidationCase, evaluate_held_out_polars
from airfoilfoam.postprocess.progressive_polar import PolarModelPolicy, PolarObservation, PolarPrior
from scripts.materials.validate_polar_uncertainty import evaluate_file, write_result


def fixture(case_id="fixture", samples=3):
    alpha = np.linspace(-2, 2, samples).tolist()
    coefficients = [[angle * 0.1, 0.02, -0.03] for angle in alpha]
    prior = PolarPrior(case_id, "prediction-" + case_id, "single", alpha, coefficients, [[0.3, 0.02, 0.1] for _ in alpha], {"fixture": True})
    reference = PolarReference("reference-" + case_id, "a" * 64, "experimental", case_id, "single", alpha,
                               [[row[0], row[1], None] for row in coefficients], False)
    return PolarValidationCase(case_id, "profile-" + case_id, "condition-" + case_id, prior, [], reference)


def policy():
    return PolarModelPolicy("fixture-policy", [0.4, 0.4, 0.1], [0.15, 0.15, 0.03], [0.5, 0.3, 0.1],
                            [0.15, 0.2, 0.03], [0.03, 0.03, 0.005], [0.01, 0.01, 0.001], 2, 0.8, "unvalidated")


def evaluate(cases, **kwargs):
    return evaluate_held_out_polars(cases, policy(), fit_profiles=["training-profile"], fit_conditions=["training-condition"],
                                    split_axis=kwargs.get("split_axis", "profile_and_condition"))


def test_missing_moment_is_not_zero_and_measurement_is_not_calibration():
    case = fixture()
    before = deepcopy(case)
    result = evaluate([case])
    assert case == before
    assert result["macro_metrics"]["cl"]["coverage"] == 1
    assert result["macro_metrics"]["cd"]["rmse"] == pytest.approx(0)
    assert result["macro_metrics"]["cm"] is None
    assert result["cases"][0]["measurement_uncertainty_known"] is False
    assert result["calibration_status"] == "unvalidated"
    assert result["validation_id"] is None
    assert result["acceptance_verdict"] == "not_evaluated"


@pytest.mark.parametrize("axis,change", [("profile", {"profile_signature": "training-profile"}),
                                         ("condition", {"condition_signature": "training-condition"}),
                                         ("profile_and_condition", {"profile_signature": "training-profile"})])
def test_rejects_whole_group_leakage(axis, change):
    with pytest.raises(ValueError, match="used to fit"):
        evaluate([replace(fixture(), **change)], split_axis=axis)


def test_split_axes_do_not_reject_intentionally_shared_other_axis():
    assert evaluate([replace(fixture(), condition_signature="training-condition")], split_axis="profile")["case_count"] == 1
    assert evaluate([replace(fixture(), profile_signature="training-profile")], split_axis="condition")["case_count"] == 1


def test_rejects_reference_reuse_in_sparse_anchors():
    case = fixture()
    anchor = PolarObservation("observation", "result", case.reference.reference_id, "lineage", case.prior.target_signature,
                              "single", "openfoam_fast", 0, [0, 0.02, -0.03], [0.1, 0.002, 0.01], True, "converged", "steady")
    with pytest.raises(ValueError, match="used as fitting evidence"):
        evaluate([replace(case, observations=[anchor])])


def test_macro_weighting_does_not_reward_dense_successful_polars():
    sparse, dense = fixture("sparse", 3), fixture("dense", 101)
    sparse = replace(sparse, reference=replace(sparse.reference, coefficients=[[10, 0.02, None] for _ in sparse.reference.alpha]))
    result = evaluate([dense, sparse])
    assert result["macro_metrics"]["cl"]["coverage"] == 0.5
    assert result["macro_metrics"]["cl"]["samples"] == 104
    assert evaluate([sparse, dense])["input_signature"] == result["input_signature"]


@pytest.mark.parametrize("change", [{"source_sha256": "bad"}, {"target_signature": "foreign"}, {"branch": "other"},
                                    {"source_kind": "demo"}, {"alpha": [-2, 0, 3]}, {"alpha": [-2, -2, 2]},
                                    {"coefficients": [[0, -0.1, None]] * 3}, {"coefficients": [[float("nan"), 0.02, None]] * 3},
                                    {"coefficients": [[None, None, None]] * 3}])
def test_rejects_incompatible_corrupt_or_uncomputed_reference(change):
    case = fixture()
    with pytest.raises(ValueError):
        evaluate([replace(case, reference=replace(case.reference, **change))])


def test_detects_interval_misses_and_binds_exact_input_changes():
    case = fixture()
    missed = replace(case, reference=replace(case.reference, coefficients=[[9, 0.02, None]] * 3))
    result = evaluate([missed])
    assert result["cases"][0]["metrics"]["cl"]["coverage"] == 0
    assert result["cases"][0]["metrics"]["cl"]["bias"] == pytest.approx(-9)
    assert result["input_signature"] != evaluate([case])["input_signature"]
    with pytest.raises(ValueError, match="Duplicate"):
        evaluate([case, case])


def test_nonuniform_alpha_weighting_and_numeric_overflow():
    case = fixture()
    alpha = [-2, -1, 2]
    changed = replace(case, prior=replace(case.prior, alpha=alpha),
                      reference=replace(case.reference, alpha=alpha, coefficients=[[10, 0.02, None], [0, 0.02, None], [0.2, 0.02, None]]))
    metrics = evaluate([changed])["cases"][0]["metrics"]["cl"]
    assert metrics["coverage"] == pytest.approx(2 / 3)
    assert metrics["span_weighted_coverage"] == pytest.approx(0.875)
    with pytest.raises(ValueError, match="finite evaluation range"):
        evaluate([replace(case, reference=replace(case.reference, coefficients=[[1e308, 0.02, None]] * 3))])


def test_file_evaluation_verifies_source_bytes_and_never_overwrites(tmp_path):
    artifact = tmp_path / "source.fixture"
    artifact.write_bytes(b"explicit synthetic evaluation fixture")
    checksum = hashlib.sha256(artifact.read_bytes()).hexdigest()
    case = fixture()
    source = asdict(replace(case, reference=replace(case.reference, source_sha256=checksum)))
    source["reference_file"] = artifact.name
    payload = {"version": 1, "policy": asdict(policy()), "cases": [source], "fit_profiles": [], "fit_conditions": [], "split_axis": "profile"}
    path = tmp_path / "input.json"
    path.write_text(json.dumps(payload))
    result = evaluate_file(path)
    assert result["source_artifacts_verified"] == 1
    assert result["calibration_status"] == "unvalidated"
    assert result["holdout_scope"] == "policy_fitting_not_surrogate_pretraining"
    output = tmp_path / "report.json"
    signature = write_result(output, result)
    assert signature == hashlib.sha256(output.read_bytes()).hexdigest()
    with pytest.raises(FileExistsError):
        write_result(output, {"changed": True})
    assert signature == hashlib.sha256(output.read_bytes()).hexdigest()
    artifact.write_bytes(b"changed bytes")
    with pytest.raises(ValueError, match="checksum differs"):
        evaluate_file(path)
    path.write_text('{"version":1,"version":1,"cases":[]}')
    with pytest.raises(ValueError, match="Duplicate"):
        evaluate_file(path)
    path.write_text('{"version":1,"cases":[],"invalid":NaN}')
    with pytest.raises(ValueError, match="Nonfinite"):
        evaluate_file(path)
