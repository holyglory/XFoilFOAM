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
from scripts.materials.screen_sparse_polar_means import candidate_fit, measure_candidate_profile, verify_replay, producing_request_signature, manufactured_controls, assess_candidates, CANDIDATES, CONFLICT_CUTOFF
from test_progressive_polar import prior, policy


@pytest.mark.parametrize("candidate", ["unchanged", "method_floor", "disagreement_floor", "conservative_floor", "method_conservative_floor"])
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
