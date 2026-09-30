from dataclasses import replace
import hashlib
import json

import numpy as np
import pytest

from test_retained_polar_measurement import fixture_source
from test_progressive_polar import observation
from scripts.materials.calibrate_history_bias import bias_observation, curve_measurement, measure_profile
from scripts.materials import calibrate_history_bias as calibration
from scripts.materials.measure_retained_polar import replay_source
from scripts.materials.screen_sparse_polar_means import candidate_fit, measure_candidate_profile, verify_replay, producing_request_signature, manufactured_controls, assess_candidates, grouped_conflict_diagnostics, CANDIDATES, CONFLICT_CUTOFF
from test_progressive_polar import prior, policy
from scripts.materials.grouped_polar_conflicts import (
    conditional_group, gaussian_tail_cutoff, group_subspace_scores,
    grouped_covariance_diagnostics, method_moments,
)
from scripts.materials.screen_sparse_polar_means import study_destination
from airfoilfoam.postprocess.progressive_polar import fit_progressive_polar


@pytest.mark.parametrize("candidate", CANDIDATES)
def test_sparse_mean_candidate_preserves_sources_and_excludes_reference_lineage(tmp_path, candidate):
    path, _ = fixture_source(tmp_path)
    source, request, replayed = replay_source(path, hashlib.sha256(path.read_bytes()).hexdigest())
    original = request.model_dump_json()
    measured = measure_candidate_profile(source, request, candidate)
    assert measured["references"]
    for reference in measured["references"]:
        assert all(row["attempt_id"] != reference["reference_attempt_id"] for row in reference["contributors"])
    assert request.model_dump_json() == original
    assert verify_replay(replayed, source["model"]["response"])["passed"]
    changed = json.loads(json.dumps(replayed))
    changed["estimate"]["curves"]["composite"]["coefficients"][0][0] += 1e-6
    assert not verify_replay(changed, source["model"]["response"])["passed"]


def test_sparse_mean_screening_is_not_a_new_production_policy_or_evidence_label():
    row = observation("left", -2, 1.5)
    second = observation("right", 2, -0.3)
    original = json.dumps([row.__dict__, second.__dict__], sort_keys=True)
    for candidate in ("method_floor", "disagreement_floor"):
        estimate = candidate_fit(prior(), [row, second], policy(), candidate)
        assert estimate["research_only"]["not_production_policy"] is True
        assert estimate["calibration_status"] == "unvalidated"
        assert [item["attempt_id"] for item in estimate["contributors"]] == [row.attempt_id, second.attempt_id]
        assert json.dumps([row.__dict__, second.__dict__], sort_keys=True) == original
    rejected = replace(row, eligible=False, exclusion_reason="diagnosed bad source")
    estimate = candidate_fit(prior(), [rejected], policy(), "disagreement_floor")
    assert estimate["contributors"] == []
    assert estimate["excluded"] == [{"observation_id":row.observation_id,"reason":"diagnosed bad source"}]
    np.testing.assert_allclose(estimate["curves"]["composite"]["coefficients"],prior().coefficients)
    with pytest.raises(ValueError, match="Unknown frozen"):
        candidate_fit(prior(), [row], policy(), "unfrozen")


def test_producer_replay_distinguishes_numeric_json_normalization_from_unknown_transport(tmp_path):
    path, _ = fixture_source(tmp_path)
    source, request, replayed = replay_source(path, hashlib.sha256(path.read_bytes()).hexdigest())
    stored = json.loads(json.dumps(replayed))
    stored["estimate"]["alpha"] = [int(value) for value in stored["estimate"]["alpha"]]
    assert verify_replay(replayed, stored)["passed"]
    stored["request_signature"] = "a" * 64
    assert not verify_replay(replayed, stored)["passed"]
    assert not verify_replay(replayed, stored, "b" * 64)["passed"]
    invalid_source = tmp_path / "unrecognized-producing-api.py"
    invalid_source.write_text("unrecognized producer")
    with pytest.raises(ValueError, match="producing API source changed"):
        producing_request_signature(request, invalid_source)


def test_conservative_candidate_influence_falls_for_increasing_isolated_outliers():
    shifts = []
    for magnitude in (30, 300, 3000):
        estimate = candidate_fit(prior(), [observation("extreme", cl=magnitude)], policy(), "method_conservative_floor")
        shifts.append(max(abs(row[0]-base[0]) for row,base in zip(estimate["curves"]["composite"]["coefficients"],prior().coefficients)))
    assert shifts[0] > shifts[1] > shifts[2]
    assert shifts[-1] < 0.001


def test_method_scoped_conflict_preserves_a_coherent_precise_correction():
    rows = [observation("fast-left", -2, 3), observation("fast-right", 2, -3),
            observation("precise-left", -2, 0, method="openfoam_precise"),
            observation("precise-right", 2, 0.4, method="openfoam_precise")]
    estimate = candidate_fit(prior(), rows, policy(), "method_conservative_floor")
    precise = candidate_fit(prior(), rows[2:], policy(), "unchanged")
    np.testing.assert_allclose(estimate["curves"]["composite"]["coefficients"], precise["curves"]["composite"]["coefficients"], atol=0.02)
    assert estimate["curves"]["composite"]["coefficients"][2][0] > 0.15
    assert estimate["research_only"]["added_variance_multipliers"]["openfoam_precise"] == [0,0,0]


def test_conservative_guard_does_not_suppress_manufactured_camber_slope_or_stall():
    angles=list(range(-5,21))
    reference=replace(prior(),alpha=angles,
        coefficients=[[0.333+0.105*min(angle,12)-0.06*max(angle-12,0),0.02,-0.03] for angle in angles],
        standard_deviation=[[0.3,0.02,0.1] for _ in angles])
    controls=manufactured_controls(reference,policy())
    for name in ("camber_offset","slope_change","earlier_stall","large_coherent_offset"):
        unchanged=next(row for row in controls if row["fixture"]==name and row["candidate"]=="unchanged")
        guarded=next(row for row in controls if row["fixture"]==name and row["candidate"]=="method_conservative_floor")
        assert guarded["candidate_cl_rmse"] == pytest.approx(unchanged["candidate_cl_rmse"],abs=1e-12)
    diagnostics={"original_bad_mesh_counterfactual":{candidate:{"cl_zero":0,"cl_five":1} for candidate in CANDIDATES}}
    verdict=assess_candidates(diagnostics,controls)["method_conservative_floor"]
    assert verdict["checks"]["severe_sparse_reversal"] is True
    assert verdict["checks"]["repeated_bad_lineage"] is False
    assert verdict["passes_required_controls"] is False
    assert verdict["production_ready"] is False


@pytest.mark.parametrize("count",[1,2,8])
@pytest.mark.parametrize("correlation",[0,0.8,0.99])
def test_model_tail_threshold_is_conservative_for_correlated_gaussian_controls(count,correlation):
    random=np.random.default_rng(74301)
    shared=random.normal(size=(50000,1))
    independent=random.normal(size=(50000,count))
    samples=np.sqrt(correlation)*shared+np.sqrt(1-correlation)*independent
    scores=np.mean(samples**2,axis=1)
    assert np.mean(scores>CONFLICT_CUTOFF)<0.01


def test_grouped_diagnostic_exposes_related_windows_without_dropping_them():
    rows = [replace(observation(f"{alpha}-{window}", alpha=alpha, cl=cl),
                    lineage_id=f"lineage-{alpha}", window=(float(window), float(window + 1)))
            for alpha, cl in [(-2, 1.5), (2, -0.3)] for window in range(4)]
    diagnostic = grouped_conflict_diagnostics(prior(), rows, policy())
    assert [group["window_count"] for group in diagnostic["groups"]] == [4, 4]
    assert diagnostic["reversals"][0]["reversal"] is True
    assert diagnostic["reversals"][0]["related_window_count"] == 8
    assert diagnostic["interpretation"].endswith("not_independent_confirmations")
    assert len(rows) == 8


def test_grouped_reversal_candidate_handles_shared_bad_anchors_but_not_stall_controls():
    rows = [replace(observation(f"{alpha}-{window}", alpha=alpha, cl=cl),
                    lineage_id=f"lineage-{alpha}", window=(float(window), float(window + 1)))
            for alpha, cl in [(-2, 1.5), (2, -0.3)] for window in range(4)]
    guarded = candidate_fit(prior(), rows, policy(), "grouped_reversal_floor")
    coefficients = np.asarray(guarded["curves"]["composite"]["coefficients"])
    assert np.interp(4, prior().alpha, coefficients[:, 0]) > np.interp(0, prior().alpha, coefficients[:, 0])
    expanded = replace(prior(), alpha=list(range(-5, 21)),
                       coefficients=[[0.333 + 0.105 * min(angle, 12) - 0.06 * max(angle - 12, 0), 0.02, -0.03]
                                     for angle in range(-5, 21)],
                       standard_deviation=[[0.3, 0.02, 0.1] for _ in range(26)])
    controls = manufactured_controls(expanded, policy())
    stall = [row for row in controls if row["fixture"] == "earlier_stall" and row["candidate"] == "grouped_reversal_floor"]
    unchanged = [row for row in controls if row["fixture"] == "earlier_stall" and row["candidate"] == "unchanged"]
    assert stall and unchanged
    assert stall[0]["candidate_cl_rmse"] == pytest.approx(unchanged[0]["candidate_cl_rmse"], abs=1e-12)


def test_group_conditional_covariance_matches_gaussian_schur_complement():
    covariance = np.array([[2.0, 0.4, 0.6], [0.4, 3.0, 0.8], [0.6, 0.8, 4.0]])
    residual = np.array([1.0, -2.0, 3.0])
    actual_residual, actual_covariance = conditional_group(covariance, residual, [0, 1])
    cross = covariance[:2, 2]
    np.testing.assert_allclose(actual_residual, residual[:2]-cross*residual[2]/4)
    np.testing.assert_allclose(actual_covariance, covariance[:2, :2]-np.outer(cross, cross)/4)
    whole_residual, whole_covariance = conditional_group(covariance, residual, [0, 1, 2])
    np.testing.assert_array_equal(whole_residual, residual)
    np.testing.assert_array_equal(whole_covariance, covariance)
    with pytest.raises(ValueError):
        conditional_group(covariance, residual, [0, 0])


@pytest.mark.parametrize("method", ["openfoam_fast", "openfoam_precise"])
def test_group_model_covariance_reproduces_existing_observation_leave_out_scores(method):
    rows = [observation("left", -2, 0.4, method), observation("center", 0, -0.3, method), observation("right", 2, 0.7, method)]
    eligible, moments = method_moments(prior(), rows, policy())
    fitted = fit_progressive_polar(prior(), rows, policy())
    for index, (covariance, residual) in enumerate(moments):
        singleton_scores = []
        for position in range(len(eligible)):
            conditional_residual, conditional_covariance = conditional_group(covariance, residual, [position])
            singleton_scores.append(float(conditional_residual[0]**2/conditional_covariance[0, 0]))
        assert max(1.0, np.mean(singleton_scores)) == pytest.approx(
            fitted["diagnostics"][index]["disagreement_variance_multiplier"], rel=1e-9)


@pytest.mark.parametrize("correlation", [0.0, 0.8, 1.0])
def test_group_means_and_contrasts_detect_shared_and_opposing_errors(correlation):
    covariance = correlation*np.ones((4,4))+(1-correlation)*np.eye(4)+np.eye(4)*1e-10
    shared = group_subspace_scores(np.full(4,20.0), covariance, np.zeros(4), 0.001)
    opposing = group_subspace_scores(np.array([20.0,-20.0,20.0,-20.0]), covariance, np.zeros(4), 0.001)
    assert shared["mean_score"] > shared["mean_cutoff"]
    assert shared["contrast_score"] < shared["contrast_cutoff"]
    assert opposing["contrast_score"] > opposing["contrast_cutoff"]
    assert opposing["mean_score"] < 1e-10
    assert shared["mean_dimension"] == 1
    assert opposing["contrast_dimension"] == 3


@pytest.mark.parametrize("count", [1,4,16,64])
@pytest.mark.parametrize("shared_lineage", [False,True])
def test_group_conditioning_retains_windows_and_resists_duplicate_masking(count,shared_lineage):
    rows = [replace(observation(f"{alpha}-{window}", alpha=alpha, cl=cl),
                    lineage_id="shared" if shared_lineage else f"lineage-{alpha}",
                    window=(float(window), float(window+1)))
            for alpha,cl in [(-2,1.5),(2,-0.3)] for window in range(count)]
    fitted = candidate_fit(prior(), rows, policy(), "group_shared_covariance")
    reordered = candidate_fit(prior(), list(reversed(rows)), policy(), "group_shared_covariance")
    assert fitted["signature"] == reordered["signature"]
    np.testing.assert_allclose(fitted["curves"]["composite"]["coefficients"],reordered["curves"]["composite"]["coefficients"])
    assert len(fitted["contributors"]) == len(rows)
    values = np.asarray(fitted["curves"]["composite"]["coefficients"])
    assert values[-1,0] > values[0,0]
    assert max(abs(values[:,0]-np.asarray(prior().coefficients)[:,0])) < 0.4
    assert all(item["observation_id"] in {row.observation_id for row in rows} for item in fitted["contributors"])


def test_group_conflict_distinguishes_real_shift_and_precise_data_from_bad_fast_data():
    precise = [observation("precise-left",-2,0,method="openfoam_precise"),
               observation("precise-right",2,0.4,method="openfoam_precise")]
    wrong = [observation("wrong-left",-2,1.5),observation("wrong-right",2,-0.3)]
    fitted = candidate_fit(prior(), precise+wrong, policy(), "group_shared_covariance")
    reference = fit_progressive_polar(prior(),precise,policy())
    np.testing.assert_allclose(fitted["curves"]["composite"]["coefficients"],reference["curves"]["composite"]["coefficients"],atol=0.02)
    assert fitted["curves"]["composite"]["coefficients"][2][0] > 0.15
    groups = fitted["research_only"]["conditional_groups"]["groups"]
    assert all(coefficient["variance_multiplier"] == 0 for group in groups if group["method"]=="openfoam_precise"
               for coefficient in group["coefficients"])
    assert any(coefficient["variance_multiplier"] > 0 for group in groups if group["method"]=="openfoam_fast"
               for coefficient in group["coefficients"])


def test_group_diagnostic_interpolates_each_angle_without_inventing_shape_conflicts():
    reference=replace(prior(),coefficients=[[-0.5,0.08,-0.05],[-0.2,0.03,-0.02],[0.3,0.01,-0.03],
                                          [0.6,0.02,-0.06],[0.1,0.04,-0.01]])
    rows=[replace(observation(f"angle-{alpha}",alpha=alpha),coefficients=coefficient,lineage_id="same-sweep")
          for alpha,coefficient in zip(reference.alpha,reference.coefficients)]
    diagnostic=grouped_covariance_diagnostics(reference,rows,policy())
    assert all(item["mean_score"] < 1e-10 and item["variance_multiplier"] == 0
               for group in diagnostic["groups"] for item in group["coefficients"])


def test_unique_research_run_destinations_preserve_earlier_artifacts(tmp_path):
    first=study_destination(None,tmp_path)
    first.mkdir()
    (first/"proof.json").write_text("retained")
    second=study_destination(None,tmp_path)
    assert first!=second and first.parent==second.parent==tmp_path
    assert (first/"proof.json").read_text()=="retained"
    with pytest.raises(ValueError):
        study_destination(first,tmp_path)


@pytest.mark.parametrize("dimension",[1,4,16])
def test_group_chi_squared_cutoff_keeps_false_alarms_below_declared_model_bound(dimension):
    samples=np.random.default_rng(7783).normal(size=(40000,dimension))
    assert np.mean(np.sum(samples**2,axis=1)>gaussian_tail_cutoff(dimension,0.001)) < 0.001


def test_uncertified_bias_adds_transformed_variance_without_changing_values():
    source = replace(observation("uncertain"), statistical_certification="informative_uncertified")
    result = bias_observation(source, [1, 2, 1])
    assert result.coefficients == source.coefficients
    assert result.standard_error[0] == pytest.approx(np.hypot(source.standard_error[0], 0.3))
    original = np.log1p((source.standard_error[1] / source.coefficients[1]) ** 2)
    observed = np.log1p((result.standard_error[1] / result.coefficients[1]) ** 2)
    assert observed == pytest.approx(original + 1)
    assert bias_observation(source, [0, 0, 0]) is source
    assert bias_observation(source, [4, 4, 4], accepted=True) is source
    for certification in ("steady", "periodic", "aperiodic"):
        certified = replace(source, statistical_certification=certification)
        assert bias_observation(certified, [4, 4, 4]) is certified
    rejected = replace(source, eligible=False, exclusion_reason="test exclusion")
    assert bias_observation(rejected, [4, 4, 4]) is rejected


@pytest.mark.parametrize("values", [[-1, 0, 0], [0.5, 0, 0], [1, 2], [0, 0, float("nan")]])
def test_grid_is_prespecified(values):
    with pytest.raises(ValueError, match="prespecified"):
        bias_observation(observation("fixture"), values)


def test_reference_job_and_lineage_are_excluded_before_candidate_fit(tmp_path):
    path, _ = fixture_source(tmp_path)
    source, request, _ = replay_source(path, hashlib.sha256(path.read_bytes()).hexdigest())
    original = request.model_dump_json()
    result = measure_profile(source, request, [1, 1, 1])
    assert result["references"]
    for reference in result["references"]:
        assert all(contributor["attempt_id"] != reference["reference_attempt_id"] for contributor in reference["contributors"])
    assert request.model_dump_json() == original


def test_interval_measurement_uses_log_drag_and_rejects_uncovered_angles():
    estimate = {"alpha": [0, 1], "curves": {"composite": {
        "coefficients": [[0, 1, 0], [0, 1, 0]], "lower": [[-1.96, np.exp(-1.96), -1.96]] * 2,
        "upper": [[1.96, np.exp(1.96), 1.96]] * 2}}}
    reference = {"alpha": 0.5, "attemptId": "synthetic", "payload": {"cl": 1, "cd": np.e, "cm": -1}}
    result = curve_measurement(estimate, reference)
    assert result["standardized_absolute_error"] == pytest.approx([1, 1, 1])
    assert result["negative_log_score"] == pytest.approx([0.5, 0.5, 0.5])
    with pytest.raises(ValueError, match="outside"):
        curve_measurement(estimate, {**reference, "alpha": 2})


@pytest.mark.parametrize("mutation", ["none", "checksum", "partition", "count", "same-profile", "same-geometry"])
def test_frozen_groups_reject_overlap_or_changed_selection(tmp_path, monkeypatch, mutation):
    expected = {}
    for index, name in enumerate(("fit", "calibration", "heldout")):
        source = {"physical": {"airfoilId": f"profile-{index}", "geometry": {"signature": f"geometry-{index}"}}}
        if name == "heldout" and mutation == "same-profile":
            source["physical"]["airfoilId"] = "profile-0"
        if name == "heldout" and mutation == "same-geometry":
            source["physical"]["geometry"] = {"signature": "geometry-0"}
        payload = {"partition": "wrong" if name == "heldout" and mutation == "partition" else name,
                   "selectionSha256": calibration.SELECTION_SHA256,
                   "sources": [] if name == "heldout" and mutation == "count" else [source]}
        raw = json.dumps(payload).encode()
        (tmp_path / f"{name}.json").write_bytes(raw)
        expected[name] = (1, hashlib.sha256(raw).hexdigest())
    monkeypatch.setattr(calibration, "GROUPS", expected)
    if mutation == "checksum":
        (tmp_path / "heldout.json").write_bytes(b"{}")
    from scripts.materials.validate_history_transfer import pinned_json
    if mutation == "checksum":
        with pytest.raises(ValueError, match="preregistered checksum"):
            pinned_json(tmp_path / "heldout.json", expected["heldout"][1])
    else:
        assert pinned_json(tmp_path / "heldout.json", expected["heldout"][1]) == json.loads((tmp_path / "heldout.json").read_text())
    if mutation == "none":
        assert list(calibration.load_groups(tmp_path)) == ["fit", "calibration", "heldout"]
    else:
        with pytest.raises(ValueError):
            calibration.load_groups(tmp_path)


def test_no_selected_profile_is_dropped_when_a_source_replay_fails(tmp_path, monkeypatch):
    calls = []
    def replay(path, signature):
        calls.append(path.stem)
        if path.stem == "b" * 64:
            raise ValueError("isolated corrupt fit")
        return {"model": path.stem}, "request-fixture", {}
    monkeypatch.setattr(calibration, "replay_source", replay)
    sources = [{"model": {"id": value * 64}} for value in "abc"]
    with pytest.raises(ValueError, match="no group may be dropped"):
        calibration.prepare_sources(sources, tmp_path / "retained")
    assert calls == [value * 64 for value in "abc"]
    failure = json.loads((tmp_path / "retained/failures.json").read_text())
    assert failure == [{"model_id": "b" * 64, "error": "isolated corrupt fit"}]


@pytest.mark.parametrize("mutation", ["none", "missing", "cohort", "mach", "profile", "geometry", "prior-profile", "prior-geometry", "job", "model-id", "signature"])
def test_transfer_selection_preserves_the_frozen_scope_and_independence(monkeypatch, mutation):
    from scripts.materials import validate_history_transfer as transfer

    monkeypatch.setattr(transfer, "COHORT_COUNTS", {"control": 2})
    rows, selected = [], []
    for index in range(2):
        model_id = hashlib.sha256(f"synthetic-model-{index}".encode()).hexdigest()
        physical = {"airfoilId": f"synthetic-profile-{index}", "geometry": [[1, 0], [0, 0.1 + index * 0.01], [1, 0]],
                    "derived": {"mach": 0.1, "reynolds": 100000}}
        rows.append({"cohort": "control", "source": {"model": {"id": model_id}, "physical": physical,
                    "evidence": [{"jobId": f"synthetic-job-{index}", "lineageId": f"synthetic-unit-{index}"}]}})
        selected.append({"cohort": "control", "modelId": model_id, "airfoilId": physical["airfoilId"],
                         "mach": 0.1, "reynolds": 100000})
    selection = {"kind": "frozen-history-transfer-selection-v1", "selected": selected}
    exported = {"kind": "frozen-history-transfer-export-v1", "selectionSha256": transfer.SELECTION_SHA256, "sources": rows}
    prior = []
    if mutation == "missing":
        rows.pop()
    elif mutation == "cohort":
        rows[0]["cohort"] = "compressible"
    elif mutation == "mach":
        rows[0]["source"]["physical"]["derived"]["mach"] = 0.2
    elif mutation == "profile":
        rows[1]["source"]["physical"]["airfoilId"] = selected[1]["airfoilId"] = selected[0]["airfoilId"]
    elif mutation == "geometry":
        rows[1]["source"]["physical"]["geometry"] = rows[0]["source"]["physical"]["geometry"]
    elif mutation in ("prior-profile", "prior-geometry"):
        prior = [{"physical": {"airfoilId": selected[0]["airfoilId"] if mutation == "prior-profile" else "prior-profile",
                  "geometry": rows[0]["source"]["physical"]["geometry"] if mutation == "prior-geometry" else [[1, 0], [0, 0.2], [1, 0]]}}]
    elif mutation == "job":
        rows[0]["source"]["evidence"][0]["jobId"] = None
    elif mutation == "model-id":
        rows[0]["source"]["model"]["id"] = selected[0]["modelId"] = "../outside"
    elif mutation == "signature":
        exported["selectionSha256"] = "different-selection"
    if mutation == "none":
        transfer.verify_transfer_selection(selection, exported, prior)
    else:
        with pytest.raises(ValueError):
            transfer.verify_transfer_selection(selection, exported, prior)
