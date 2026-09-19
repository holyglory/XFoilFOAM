from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path

import pytest

from scripts.materials.npl3635_reference import (
    compare_zero_incidence_pressure_drag,
    load_reference,
    load_reference_from_payload,
    mach395_zero_incidence,
)


REFERENCE = Path(__file__).parent / "fixtures" / "npl3635" / "table2.json"


def test_npl3635_transcription_preserves_the_primary_source_and_exact_rows():
    reference = load_reference(REFERENCE)
    assert reference["version"] == "npl3635-table2-v2"
    assert reference["provenance"]["source_pages"] == [4, 13, 14]
    assert reference["conditions"][2] == {
        "mach": 3.95,
        "pressure_millitorr": 33.0,
        "reynolds_chord": 790.0,
        "interaction_parameter": 2.19,
    }
    assert reference["biconvex"]["experimental_zero_incidence_pressure_drag"][2] == pytest.approx(0.02830)
    assert reference["double_wedge"]["experimental_zero_incidence_pressure_drag"][2] == pytest.approx(0.0199)
    assert reference["provenance"]["source_page_numbering"] == "printed_report_pages"
    assert reference["provenance"]["source_pdf_table_page"] == 15
    assert reference["source_artifact_verified"] is False
    assert reference["campaign_compatible"] is False
    assert mach395_zero_incidence(reference)["validation_scope"] == "out_of_scope_rarefied_flow_not_campaign_validation"


@pytest.mark.parametrize("mutation", ["condition", "drag", "inviscid", "reynolds", "pressure", "temperature", "locator", "provenance", "reorder"])
def test_npl3635_loader_rejects_changed_or_ambiguous_reference(tmp_path, mutation):
    payload = json.loads(REFERENCE.read_text())
    if mutation == "condition":
        payload["conditions"][2]["mach"] = 3.0
    elif mutation == "drag":
        payload["biconvex"]["experimental_zero_incidence_pressure_drag"][2] += 0.001
    elif mutation == "inviscid":
        payload["double_wedge"]["inviscid_zero_incidence_pressure_drag"][2] += 0.001
    elif mutation == "reynolds":
        payload["conditions"][2]["reynolds_chord"] /= 0.0254
    elif mutation == "pressure":
        payload["conditions"][2]["pressure_millitorr"] = 45.0
    elif mutation == "temperature":
        payload["provenance"]["stagnation_temperature_k"] = 300.0
    elif mutation == "locator":
        payload["provenance"]["source_locator"] = "https://unrelated.invalid"
    elif mutation == "provenance":
        payload["provenance"].pop("source_pages")
    else:
        payload["conditions"] = list(reversed(payload["conditions"]))
    path = tmp_path / "table2.json"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError):
        load_reference(path)


def test_npl3635_requires_real_source_bytes_for_a_verified_pdf(tmp_path):
    payload = json.loads(REFERENCE.read_text())
    payload["provenance"]["source_artifact_sha256"] = "a" * 64
    path = tmp_path / "table2.json"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="provenance changed"):
        load_reference(path)
    fake_pdf = tmp_path / "changed.pdf"
    fake_pdf.write_bytes(b"explicit invalid reference fixture")
    with pytest.raises(ValueError, match="PDF checksum"):
        load_reference(REFERENCE, fake_pdf)


def test_zero_incidence_comparison_requires_exact_mach_and_reynolds_and_never_certifies_accuracy():
    reference = load_reference(REFERENCE)
    comparison = compare_zero_incidence_pressure_drag(reference, "biconvex", 3.95, 790, 0.02830)
    assert comparison["absolute_error"] == pytest.approx(0)
    assert comparison["relative_error"] == pytest.approx(0)
    assert comparison["acceptance_certificate"] is False
    assert comparison["campaign_compatible"] is False
    assert comparison["validation_scope"] == "table_row_comparison_not_physical_compatibility"
    lower = compare_zero_incidence_pressure_drag(reference, "biconvex", 3.95, 790, 0.02)
    assert lower["bias"] < 0 and lower["absolute_error"] > 0 and lower["relative_error"] > 0
    with pytest.raises(ValueError, match="unique"):
        compare_zero_incidence_pressure_drag(reference, "biconvex", 3.0, 790, 0.02830)
    with pytest.raises(ValueError, match="unique"):
        compare_zero_incidence_pressure_drag(reference, "biconvex", 3.95, 700, 0.02830)


@pytest.mark.parametrize("value", [True, "3.95", float("nan"), float("inf"), 0, -1])
@pytest.mark.parametrize("index", [0, 1, 2])
def test_comparison_rejects_nonphysical_numeric_inputs(value, index):
    inputs = [3.95, 790, 0.02830]
    inputs[index] = value
    with pytest.raises(ValueError):
        compare_zero_incidence_pressure_drag(load_reference(REFERENCE), "biconvex", *inputs)


def test_reference_validation_is_pure_concurrent_and_does_not_accept_old_units():
    reference = load_reference(REFERENCE)
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(load_reference_from_payload, [reference] * 12))
    results[0]["conditions"][2]["reynolds_chord"] = 0
    assert reference["conditions"][2]["reynolds_chord"] == 790
    assert all(item["conditions"][2]["reynolds_chord"] == 790 for item in results[1:])
    with pytest.raises(ValueError, match="version"):
        load_reference_from_payload({**reference, "version": "npl3635-table2-v1"})
    with pytest.raises(ValueError, match="not compatible"):
        load_reference_from_payload({**reference, "campaign_compatible": True})


def test_duplicate_json_fields_are_not_silently_accepted(tmp_path):
    source = tmp_path / "duplicate.json"
    source.write_text('{"provenance":{},"provenance":{}}')
    with pytest.raises(ValueError, match="Duplicate"):
        load_reference(source)
