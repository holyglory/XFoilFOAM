import json
from pathlib import Path

import pytest

from scripts.materials.npl3635_reference import (
    compare_zero_incidence_pressure_drag,
    load_reference,
    mach395_zero_incidence,
)


REFERENCE = Path(__file__).parent / "fixtures" / "npl3635" / "table2.json"


def test_npl3635_transcription_preserves_the_primary_source_and_exact_rows():
    reference = load_reference(REFERENCE)
    assert reference["version"] == "npl3635-table2-v1"
    assert reference["provenance"]["source_pages"] == [4, 13, 14]
    assert reference["conditions"][2] == {
        "mach": 3.95,
        "pressure_millitorr": 33.0,
        "reynolds_per_m": 790.0,
        "interaction_parameter": 2.19,
    }
    assert reference["biconvex"]["experimental_zero_incidence_pressure_drag"][2] == pytest.approx(0.02830)
    assert reference["double_wedge"]["experimental_zero_incidence_pressure_drag"][2] == pytest.approx(0.0199)
    assert mach395_zero_incidence(reference)["validation_scope"] == "adjacent_high_supersonic_reference_not_exact_mach3"


@pytest.mark.parametrize("mutation", ["condition", "drag", "provenance", "reorder"])
def test_npl3635_loader_rejects_changed_or_ambiguous_reference(tmp_path, mutation):
    payload = json.loads(REFERENCE.read_text())
    if mutation == "condition":
        payload["conditions"][2]["mach"] = 3.0
    elif mutation == "drag":
        payload["biconvex"]["experimental_zero_incidence_pressure_drag"][2] += 0.001
    elif mutation == "provenance":
        payload["provenance"].pop("source_pages")
    else:
        payload["conditions"] = list(reversed(payload["conditions"]))
    path = tmp_path / "table2.json"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError):
        load_reference(path)


def test_npl3635_never_pretends_to_be_a_local_hash_bound_experimental_archive(tmp_path):
    payload = json.loads(REFERENCE.read_text())
    payload["provenance"]["source_artifact_sha256"] = "a" * 64
    path = tmp_path / "table2.json"
    path.write_text(json.dumps(payload))
    with pytest.raises(ValueError, match="local PDF checksum"):
        load_reference(path)


def test_zero_incidence_comparison_requires_exact_mach_and_reynolds_and_never_certifies_accuracy():
    reference = load_reference(REFERENCE)
    comparison = compare_zero_incidence_pressure_drag(reference, "biconvex", 3.95, 790, 0.02830)
    assert comparison["absolute_error"] == pytest.approx(0)
    assert comparison["relative_error"] == pytest.approx(0)
    assert comparison["acceptance_certificate"] is False
    with pytest.raises(ValueError, match="unique"):
        compare_zero_incidence_pressure_drag(reference, "biconvex", 3.0, 790, 0.02830)
    with pytest.raises(ValueError, match="unique"):
        compare_zero_incidence_pressure_drag(reference, "biconvex", 3.95, 700, 0.02830)
