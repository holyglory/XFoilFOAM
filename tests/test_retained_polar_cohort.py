import hashlib
import json

import pytest

from scripts.materials import measure_retained_cohort as cohort
from scripts.materials import validate_grouped_history_cohort as grouped


def source_file(directory, sources=None):
    sources = sources if sources is not None else [
        {"model": {"id": digit * 64}, "physical": {"airfoilId": f"unit-test-profile-{digit}"}}
        for digit in ("a", "b", "c")]
    path = directory / "input.json"
    path.write_text(json.dumps({"kind": "retained-polar-cohort-export-v1", "sources": sources}))
    return path, hashlib.sha256(path.read_bytes()).hexdigest()


def test_all_selected_sources_are_retained_without_claiming_calibration(tmp_path, monkeypatch):
    path, signature = source_file(tmp_path)
    calls = []
    def measure(source, expected):
        assert hashlib.sha256(source.read_bytes()).hexdigest() == expected
        calls.append(source)
        return {"history_count": 1, "held_out": [{"unit_test": True}]}
    monkeypatch.setattr(cohort, "measure_source", measure)
    output = tmp_path / "evidence"
    summary = cohort.measure_cohort(path, signature, output)
    assert len(calls) == 3 and summary["complete"] and not summary["failures"]
    assert summary["calibration_status"] == "unvalidated" and not summary["production_policy_changed"]
    assert (output / "source-cohort.json").read_bytes() == path.read_bytes()
    assert len(list(output.glob("*/report.json"))) == 3
    with pytest.raises(FileExistsError):
        cohort.measure_cohort(path, signature, output)


def test_bad_source_does_not_cancel_other_measurements_or_become_success(tmp_path, monkeypatch):
    path, signature = source_file(tmp_path)
    def measure(source, expected):
        if source.parent.name == "b" * 64:
            raise ValueError("stored fit cannot be replayed")
        return {"history_count": 1, "held_out": []}
    monkeypatch.setattr(cohort, "measure_source", measure)
    output = tmp_path / "evidence"
    summary = cohort.measure_cohort(path, signature, output)
    assert not summary["complete"] and len(summary["measurements"]) == 2 and len(summary["failures"]) == 1
    assert summary["failures"][0]["model_id"] == "b" * 64
    assert len(list(output.glob("*/source.json"))) == 3
    assert (output / ("b" * 64) / "failure.json").is_file()
    assert not (output / ("b" * 64) / "report.json").exists()


@pytest.mark.parametrize("bad", ["checksum", "duplicate_model", "duplicate_profile", "unsafe_model", "empty"])
def test_invalid_cohort_fails_before_creating_output(tmp_path, bad):
    sources = [{"model": {"id": digit * 64}, "physical": {"airfoilId": digit}} for digit in ("a", "b")]
    if bad == "duplicate_model":
        sources[1]["model"]["id"] = sources[0]["model"]["id"]
    elif bad == "duplicate_profile":
        sources[1]["physical"]["airfoilId"] = sources[0]["physical"]["airfoilId"]
    elif bad == "unsafe_model":
        sources[0]["model"]["id"] = "../../elsewhere"
    elif bad == "empty":
        sources = []
    path, signature = source_file(tmp_path, sources)
    with pytest.raises(ValueError):
        cohort.measure_cohort(path, "0" * 64 if bad == "checksum" else signature, tmp_path / "evidence")
    assert not (tmp_path / "evidence").exists()


@pytest.mark.parametrize("bad",[None,"pilot_profile","pilot_geometry","count","selection","checksum","partition","missing"])
def test_grouped_cohort_verifies_pilot_exclusion_and_every_partition_before_execution(tmp_path,monkeypatch,bad):
    def row(index):
        return {"model":{"id":f"{index:064x}"},"physical":{"airfoilId":f"profile-{index}","geometry":[[0,0],[1,index/100]]}}
    pilot={"kind":"retained-polar-cohort-export-v1","sources":[row(index) for index in range(8)]}
    pilot_path=tmp_path/"pilot.json"
    pilot_path.write_text(json.dumps(pilot))
    monkeypatch.setattr(grouped,"PILOT_SHA256",hashlib.sha256(pilot_path.read_bytes()).hexdigest())
    paths,signatures={},{}
    for index,partition in enumerate(("fit","calibration","heldout")):
        source=row(index+10)
        if partition=="heldout" and bad=="pilot_profile":
            source["physical"]["airfoilId"]="profile-0"
        if partition=="heldout" and bad=="pilot_geometry":
            source["physical"]["geometry"]=pilot["sources"][0]["physical"]["geometry"]
        payload={"kind":"retained-polar-cohort-export-v1","partition":partition,
                 "selectionSha256":grouped.SELECTION_SHA256,"sources":[source]}
        if partition=="heldout" and bad=="count":
            payload["sources"]=[]
        if partition=="heldout" and bad=="selection":
            payload["selectionSha256"]="wrong"
        if partition=="heldout" and bad=="partition":
            payload["partition"]="fit"
        path=tmp_path/f"{partition}.json"
        path.write_text(json.dumps(payload))
        paths[partition]=path
        signatures[partition]=hashlib.sha256(path.read_bytes()).hexdigest()
    monkeypatch.setattr(grouped,"COHORTS",signatures)
    monkeypatch.setattr(grouped,"COUNTS",dict.fromkeys(signatures,1))
    if bad=="checksum":
        paths["heldout"].write_text("{}")
    if bad=="missing":
        paths.pop("heldout")
    if bad is None:
        assert set(grouped.verify_sources(paths,pilot_path))==set(signatures)
    else:
        with pytest.raises(ValueError):
            grouped.run(paths,pilot_path,tmp_path/"output")
        assert not (tmp_path/"output").exists()
