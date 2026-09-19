from dataclasses import asdict
import hashlib
import json

import pytest

from airfoilfoam.api.predictions import ProgressivePolarRequest, calculate_progressive_polar
from scripts.materials.measure_retained_polar import measure_source, replay_source
from test_polar_history import history, reduction
from test_progressive_polar import observation, policy, prior


def fixture_source(tmp_path):
    request = ProgressivePolarRequest.model_validate({
        "epoch_id": "00000000-0000-0000-0000-000000000001", "lease_token": "00000000-0000-0000-0000-000000000002",
        "prior": asdict(prior()), "observations": [asdict(observation("reference"))],
        "histories": [asdict(history(-2, "left")), asdict(history(2, "right"))],
        "history_policy": asdict(reduction()), "policy": asdict(policy()),
    })
    manifest = request.model_dump(mode="json")
    evidence = []
    for source in manifest["histories"]:
        original = source["observation"]
        coordinate, coefficients = source.pop("coordinate"), source.pop("coefficients")
        source["sample_count"] = len(coordinate)
        payload = {"force_history": {"t": coordinate, "cl": [row[0] for row in coefficients],
                                     "cd": [row[1] for row in coefficients], "cm": [row[2] for row in coefficients]}}
        payload.update(dict(zip(("cl", "cd", "cm"), original["coefficients"])))
        evidence.append({"attemptId": original["attempt_id"], "resultId": original["result_id"],
                         "jobId": "job-" + original["attempt_id"], "lineageId": original["lineage_id"], "alpha": original["alpha"],
                         "stage": 2, "classification": {"state": "rejected"}, "payload": payload, "signature": "b" * 64})
    original = manifest["observations"][0]
    evidence.append({"attemptId": original["attempt_id"], "resultId": original["result_id"],
                     "jobId": "job-reference", "lineageId": original["lineage_id"], "alpha": original["alpha"], "stage": 2,
                     "classification": {"state": "accepted"}, "payload": dict(zip(("cl", "cd", "cm"), original["coefficients"])),
                     "signature": "c" * 64})
    manifest["kind"] = "progressive-fit-replay-manifest-v1"
    source = {"kind": "retained-polar-holdout-source-v1", "physical": {"airfoilId": "synthetic-fixture", "geometry": [], "flow": {}},
              "model": {"id": "synthetic-fixture", "request": manifest, "response": calculate_progressive_polar(request)}, "evidence": evidence}
    path = tmp_path / "source.json"
    path.write_text(json.dumps(source))
    return path, source


def test_replays_exact_joint_histories_and_withholds_reference_before_measurement(tmp_path):
    path, _ = fixture_source(tmp_path)
    report = measure_source(path, hashlib.sha256(path.read_bytes()).hexdigest())
    assert report["stored_fit_reproduced"] is True and report["history_count"] == 2
    assert report["calibration_status"] == "unvalidated" and report["validation_id"] is None
    variants = report["held_out"][0]["variants"]
    assert variants["prior_only"]["cases"][0]["evidence"]["contributors"] == []
    assert len(variants["remaining_evidence"]["cases"][0]["evidence"]["contributors"]) == 6
    assert all(row["attempt_id"] != "attempt-reference" for row in variants["remaining_evidence"]["cases"][0]["evidence"]["contributors"])


@pytest.mark.parametrize("change", ["checksum", "sample-count", "history", "point", "identity", "stage", "response"])
def test_changed_source_or_mapping_cannot_claim_a_real_replay(tmp_path, change):
    path, source = fixture_source(tmp_path)
    original = hashlib.sha256(path.read_bytes()).hexdigest()
    if change == "checksum":
        path.write_bytes(path.read_bytes() + b"\n")
    elif change == "sample-count":
        source["model"]["request"]["histories"][0]["sample_count"] += 1
    elif change == "history":
        source["evidence"][0]["payload"]["force_history"]["cl"][-1] += 1
    elif change == "point":
        source["evidence"][-1]["payload"]["cl"] += 1
    elif change == "identity":
        source["evidence"][0]["lineageId"] = "foreign"
    elif change == "stage":
        source["evidence"][0]["stage"] = 9
    else:
        source["model"]["response"]["estimate"]["curves"]["composite"]["coefficients"][0][0] += 1
    if change != "checksum":
        path.write_text(json.dumps(source))
        original = hashlib.sha256(path.read_bytes()).hexdigest()
    with pytest.raises(ValueError):
        replay_source(path, original)


def test_shared_job_evidence_is_withheld_and_missing_accepted_reference_stays_missing(tmp_path):
    path, source = fixture_source(tmp_path)
    for record in source["evidence"]:
        record["jobId"] = "job-reference"
    path.write_text(json.dumps(source))
    report = measure_source(path, hashlib.sha256(path.read_bytes()).hexdigest())
    assert report["held_out"][0]["variants"]["remaining_evidence"]["cases"][0]["evidence"]["contributors"] == []
    source["evidence"][-1]["classification"]["state"] = "rejected"
    path.write_text(json.dumps(source))
    report = measure_source(path, hashlib.sha256(path.read_bytes()).hexdigest())
    assert report["held_out"] == [] and report["stored_fit_reproduced"] is True
