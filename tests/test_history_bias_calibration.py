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
        (tmp_path / "heldout.json").write_bytes(b"changed source")
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
