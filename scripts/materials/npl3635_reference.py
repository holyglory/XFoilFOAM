"""Load the published NPL R&M 3635 high-supersonic reference transcription."""

from __future__ import annotations

import json
import math
import tempfile
from pathlib import Path


REFERENCE_VERSION = "npl3635-table2-v1"
EXPECTED_MACH = [4.19, 4.04, 3.95, 2.12, 2.09, 1.79]
EXPECTED_BICONVEX_EXPERIMENTAL = [0.02084, 0.02410, 0.02830, 0.0432, 0.0458, 0.0624]
EXPECTED_DOUBLE_WEDGE_EXPERIMENTAL = [0.0154, 0.0182, 0.0199, 0.0297, 0.0312, 0.0420]


def _finite_positive(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be finite and positive")
    return float(value)


def load_reference(path: str | Path) -> dict:
    source = Path(path)
    payload = json.loads(source.read_text(encoding="utf-8"))
    if payload.get("provenance", {}).get("report") != "Aeronautical Research Council Reports and Memoranda 3635":
        raise ValueError("Unexpected NPL reference report")
    provenance = payload.get("provenance")
    required = {"source_locator", "source_pdf_locator", "source_pages", "source_artifact_sha256", "measurement_limitations"}
    if not isinstance(provenance, dict) or not required <= set(provenance):
        raise ValueError("NPL reference provenance is incomplete")
    if provenance["source_artifact_sha256"] is not None:
        raise ValueError("This transcription must not claim a local PDF checksum")
    if provenance["source_artifact_status"] != "remote_primary_source_not_copied":
        raise ValueError("NPL reference source-copy status is ambiguous")
    if provenance["thickness_to_chord"] != 0.1 or provenance["chord_m"] != 0.0254:
        raise ValueError("NPL reference geometry metadata changed")
    conditions = payload.get("conditions")
    if not isinstance(conditions, list) or len(conditions) != len(EXPECTED_MACH):
        raise ValueError("NPL reference condition table is incomplete")
    mach = []
    for condition in conditions:
        if not isinstance(condition, dict):
            raise ValueError("NPL reference condition row is malformed")
        mach.append(_finite_positive(condition.get("mach"), "Mach"))
        _finite_positive(condition.get("pressure_millitorr"), "static pressure")
        _finite_positive(condition.get("reynolds_per_m"), "Reynolds number")
        _finite_positive(condition.get("interaction_parameter"), "interaction parameter")
    if mach != EXPECTED_MACH:
        raise ValueError("NPL reference conditions are reordered or changed")
    for section, expected in (("biconvex", EXPECTED_BICONVEX_EXPERIMENTAL), ("double_wedge", EXPECTED_DOUBLE_WEDGE_EXPERIMENTAL)):
        values = payload.get(section, {}).get("experimental_zero_incidence_pressure_drag")
        inviscid = payload.get(section, {}).get("inviscid_zero_incidence_pressure_drag")
        if values != expected or not isinstance(inviscid, list) or len(inviscid) != len(expected):
            raise ValueError(f"NPL {section} pressure-drag transcription changed")
        if any(not math.isfinite(float(value)) or float(value) <= 0 for value in inviscid):
            raise ValueError(f"NPL {section} inviscid pressure drag is invalid")
    return {"version": REFERENCE_VERSION, **payload}


def mach395_zero_incidence(reference: dict) -> dict:
    loaded = load_reference_from_payload(reference)
    row = loaded["conditions"][2]
    return {
        "condition": row,
        "biconvex_experimental_cd_pressure": loaded["biconvex"]["experimental_zero_incidence_pressure_drag"][2],
        "double_wedge_experimental_cd_pressure": loaded["double_wedge"]["experimental_zero_incidence_pressure_drag"][2],
        "validation_scope": "adjacent_high_supersonic_reference_not_exact_mach3",
    }


def compare_zero_incidence_pressure_drag(
    reference: dict,
    section: str,
    mach: float,
    reynolds_per_m: float,
    measured_cd_pressure: float,
) -> dict:
    loaded = load_reference_from_payload(reference)
    if section not in {"biconvex", "double_wedge"}:
        raise ValueError("Unknown NPL reference section")
    if not math.isfinite(measured_cd_pressure) or measured_cd_pressure <= 0:
        raise ValueError("Measured pressure drag must be finite and positive")
    matches = [
        (index, condition)
        for index, condition in enumerate(loaded["conditions"])
        if math.isclose(condition["mach"], mach, rel_tol=0, abs_tol=1e-9)
        and math.isclose(condition["reynolds_per_m"], reynolds_per_m, rel_tol=0, abs_tol=1e-9)
    ]
    if len(matches) != 1:
        raise ValueError("No unique NPL reference condition matches Mach and Reynolds")
    index, condition = matches[0]
    experimental = loaded[section]["experimental_zero_incidence_pressure_drag"][index]
    inviscid = loaded[section]["inviscid_zero_incidence_pressure_drag"][index]
    return {
        "section": section,
        "condition": condition,
        "measured_cd_pressure": measured_cd_pressure,
        "experimental_cd_pressure": experimental,
        "inviscid_cd_pressure": inviscid,
        "absolute_error": measured_cd_pressure - experimental,
        "relative_error": (measured_cd_pressure - experimental) / experimental,
        "validation_scope": "source-matched-zero-incidence-pressure-drag-comparison",
        "acceptance_certificate": False,
    }


def load_reference_from_payload(payload: dict) -> dict:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", encoding="utf-8") as temporary:
        temporary.write(json.dumps(payload))
        temporary.flush()
        return load_reference(temporary.name)
