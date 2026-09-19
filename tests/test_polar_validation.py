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
from airfoilfoam.api.predictions import ProgressivePolarRequest, calculate_progressive_polar
from test_polar_history import history, reduction


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
    source.pop("histories")
    source.pop("history_policy")
    source["reference"].pop("evidence_ids")
    source["reference"].pop("lineage_ids")
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


def history_case():
    case = fixture()
    histories = [history(-2, "left"), history(2, "right")]
    histories = [replace(source, artifact_sha256=str(index + 1) * 64,
                         observation=replace(source.observation, target_signature=case.prior.target_signature))
                 for index, source in enumerate(histories)]
    return replace(case, histories=histories, history_policy=reduction())


@pytest.mark.parametrize("count", [1, 2])
def test_independent_sparse_anchors_are_measured_without_becoming_reference_truth(count):
    case = fixture()
    anchors = [PolarObservation(f"anchor-{index}", f"result-{index}", f"attempt-{index}", f"lineage-{index}",
                               case.prior.target_signature, "single", "openfoam_fast" if index == 0 else "openfoam_precise",
                               angle, [0.1 * angle + 0.2, 0.025, -0.03], [0.02, 0.002, 0.003], True, "converged", "steady")
               for index, angle in enumerate([-2, 2][:count])]
    reference = replace(case.reference, source_kind="accepted_cfd", evidence_ids=["held-out-result", "held-out-attempt"],
                        lineage_ids=["held-out-lineage"])
    measured = evaluate([replace(case, observations=anchors, reference=reference)])
    assert len(measured["cases"][0]["evidence"]["contributors"]) == count
    assert measured["cases"][0]["metrics"]["cl"]["bias"] > 0
    assert measured["calibration_status"] == "unvalidated" and measured["acceptance_verdict"] == "not_evaluated"


def test_joint_history_validation_matches_the_live_fitter_and_preserves_uncertified_provenance():
    case = history_case()
    request = ProgressivePolarRequest.model_validate({
        "epoch_id": "00000000-0000-0000-0000-000000000001", "lease_token": "00000000-0000-0000-0000-000000000002",
        "prior": asdict(case.prior), "observations": [], "histories": [asdict(source) for source in case.histories],
        "history_policy": asdict(case.history_policy), "policy": asdict(policy()),
    })
    case = replace(case, prior=request.prior, histories=request.histories, history_policy=request.history_policy)
    measure = lambda value: evaluate_held_out_polars([value], request.policy, fit_profiles=[], fit_conditions=[], split_axis="profile")
    result = measure(case)
    live = calculate_progressive_polar(request)["estimate"]
    measured = result["cases"][0]
    assert measured["fit_signature"] == live["signature"]
    assert measured["evidence"]["contributors"] == live["contributors"]
    assert measured["evidence"]["history_count"] == 2
    assert measured["evidence"]["observation_count"] == 6
    assert {source["numerical_convergence"] for source in measured["evidence"]["contributors"]} == {"unconverged"}
    assert result["calibration_status"] == "unvalidated" and result["validation_id"] is None
    assert measure(replace(case, histories=list(reversed(case.histories))))["cases"][0]["fit_signature"] == live["signature"]
    changed = replace(case, history_policy=replace(case.history_policy, maximum_blocks=1))
    assert measure(changed)["input_signature"] != result["input_signature"]


@pytest.mark.parametrize("field", ["observation_id", "result_id", "attempt_id", "lineage_id"])
def test_history_reference_cannot_be_reused_under_a_different_label(field):
    case = history_case()
    reference = replace(case.reference, source_kind="accepted_cfd", evidence_ids=["independent-result"],
                        lineage_ids=["independent-lineage"])
    reference = replace(reference, evidence_ids=[getattr(case.histories[0].observation, field)])
    with pytest.raises(ValueError, match="used as fitting evidence"):
        evaluate([replace(case, reference=reference)])


def test_reference_artifact_reuse_and_cross_case_leakage_are_rejected():
    case = history_case()
    with pytest.raises(ValueError, match="used as fitting evidence"):
        evaluate([replace(case, reference=replace(case.reference, source_sha256=case.histories[0].artifact_sha256))])
    other = fixture("other")
    other = replace(other, reference=replace(other.reference, reference_id=case.histories[0].observation.attempt_id))
    with pytest.raises(ValueError, match="used as fitting evidence"):
        evaluate([case, other])


def test_accepted_reference_requires_declared_independent_sources_not_just_a_label():
    case = history_case()
    reference = replace(case.reference, source_kind="accepted_cfd")
    with pytest.raises(ValueError, match="exact evidence and lineage"):
        evaluate([replace(case, reference=reference)])
    reference = replace(reference, evidence_ids=["independent-attempt", "independent-result"], lineage_ids=["independent-lineage"])
    assert evaluate([replace(case, reference=reference)])["case_count"] == 1
    for values in ("not-a-list", ["duplicate", "duplicate"], [""]):
        with pytest.raises(ValueError):
            evaluate([replace(case, reference=replace(reference, lineage_ids=values))])


def test_history_measurement_preserves_startup_rejection_iteration_semantics_and_correlation():
    case = history_case()
    initial = evaluate([case])
    startup = replace(case, histories=[replace(source, informative_start=20) for source in case.histories])
    startup_result = evaluate([startup])["cases"][0]["evidence"]
    assert startup_result["contributors"] == [] and len(startup_result["excluded"]) == 2
    iterations = replace(case, histories=[replace(source, coordinate_kind="iteration") for source in case.histories])
    iteration_result = evaluate([iterations])["cases"][0]["evidence"]
    assert len(iteration_result["contributors"]) == 2
    assert all(row["statistical_certification"] == "numerical_iterations_only" for row in iteration_result["contributors"])
    unknown = replace(case, histories=[replace(source, correlation_time=None, correlation_evidence_id=None) for source in case.histories])
    unknown_result = evaluate([unknown])
    assert unknown_result["cases"][0]["metrics"]["cl"]["mean_interval_width"] >= initial["cases"][0]["metrics"]["cl"]["mean_interval_width"]


@pytest.mark.parametrize("kind", ["no-policy", "too-many-histories", "too-many-samples", "too-many-blocks", "divergent"])
def test_history_validation_preserves_live_fit_bounds_and_rejection(kind):
    case = history_case()
    if kind == "no-policy":
        case = replace(case, history_policy=None)
    elif kind == "too-many-histories":
        case = replace(case, histories=case.histories * 33)
    elif kind == "too-many-samples":
        case = replace(case, histories=[replace(case.histories[0], coordinate=[0] * 32769)])
    elif kind == "too-many-blocks":
        case = replace(case, histories=[replace(case.histories[0], coordinate=list(range(0, 1000)), coefficients=[[0.2, 0.02, 0]] * 1000)],
                       history_policy=replace(case.history_policy, block_duration=4))
    else:
        case = replace(case, histories=[replace(case.histories[0], observation=replace(case.histories[0].observation, numerical_convergence="diverged"))])
    with pytest.raises(ValueError):
        evaluate([case])


def test_file_evaluation_retains_real_history_input_fields(tmp_path):
    case = history_case()
    artifact = tmp_path / "source.fixture"
    artifact.write_bytes(b"explicit synthetic joint-history evaluation reference")
    checksum = hashlib.sha256(artifact.read_bytes()).hexdigest()
    source = asdict(replace(case, reference=replace(case.reference, source_sha256=checksum)))
    source["reference_file"] = artifact.name
    path = tmp_path / "input.json"
    path.write_text(json.dumps({"version": 1, "policy": asdict(policy()), "cases": [source],
                               "fit_profiles": [], "fit_conditions": [], "split_axis": "profile"}))
    result = evaluate_file(path)
    assert result["cases"][0]["evidence"]["history_count"] == 2
    assert result["cases"][0]["evidence"]["observation_count"] == 6
    assert result["cases"][0]["fit_signature"] == evaluate([case])["cases"][0]["fit_signature"]
