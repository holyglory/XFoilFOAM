"""Read NPL R&M 3635 without treating rarefied-flow data as campaign validation."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import json
import math
from pathlib import Path


REFERENCE_VERSION = "npl3635-table2-v2"
TRANSCRIPTION_SHA256 = "26fdfebed44a028e499591ca42e29b9cd6971bafadd957702a442b98f08916b8"
SOURCE_PDF_SHA256 = "e152786031338d8ca0df7abac53e1c1fedf807f70e687302e3fec6770dc013d5"


def _unique_object(pairs):
    result = {}
    for name, value in pairs:
        if name in result:
            raise ValueError("Duplicate NPL reference field")
        result[name] = value
    return result


def _finite_positive(value: object, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} must be finite and positive")
    return float(value)


def load_reference_from_payload(payload: dict) -> dict:
    if not isinstance(payload, dict):
        raise ValueError("NPL reference must be an object")
    if payload.get("version", REFERENCE_VERSION) != REFERENCE_VERSION:
        raise ValueError("Unsupported NPL reference version")
    if payload.get("campaign_compatible", False) is not False:
        raise ValueError("NPL source is not compatible with the production campaign")
    original = {name: value for name, value in payload.items()
                if name not in ("version", "campaign_compatible", "source_artifact_verified")}
    try:
        serialized = json.dumps(original, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    except (TypeError, ValueError) as error:
        raise ValueError("Invalid NPL reference data") from error
    if hashlib.sha256(serialized).hexdigest() != TRANSCRIPTION_SHA256:
        raise ValueError("NPL reference transcription or provenance changed")
    return {"version": REFERENCE_VERSION, **deepcopy(original), "campaign_compatible": False, "source_artifact_verified": False}


def load_reference(path: str | Path, source_pdf: str | Path | None = None) -> dict:
    reference = load_reference_from_payload(json.loads(Path(path).read_text(encoding="utf-8"), object_pairs_hook=_unique_object))
    if source_pdf is not None:
        with Path(source_pdf).open("rb") as stream:
            actual = hashlib.file_digest(stream, "sha256").hexdigest()
        if actual != SOURCE_PDF_SHA256:
            raise ValueError("NPL primary PDF checksum differs")
        reference["source_artifact_verified"] = True
    return reference


def mach395_zero_incidence(reference: dict) -> dict:
    loaded = load_reference_from_payload(reference)
    return {
        "condition": loaded["conditions"][2],
        "biconvex_experimental_cd_pressure": loaded["biconvex"]["experimental_zero_incidence_pressure_drag"][2],
        "double_wedge_experimental_cd_pressure": loaded["double_wedge"]["experimental_zero_incidence_pressure_drag"][2],
        "validation_scope": "out_of_scope_rarefied_flow_not_campaign_validation",
        "campaign_compatible": False,
    }


def compare_zero_incidence_pressure_drag(
    reference: dict,
    section: str,
    mach: float,
    reynolds_chord: float,
    measured_cd_pressure: float,
) -> dict:
    loaded = load_reference_from_payload(reference)
    if section not in {"biconvex", "double_wedge"}:
        raise ValueError("Unknown NPL reference section")
    mach = _finite_positive(mach, "Mach")
    reynolds_chord = _finite_positive(reynolds_chord, "Chord Reynolds number")
    measured_cd_pressure = _finite_positive(measured_cd_pressure, "Pressure drag")
    matches = [(index, condition) for index, condition in enumerate(loaded["conditions"])
               if condition["mach"] == mach and condition["reynolds_chord"] == reynolds_chord]
    if len(matches) != 1:
        raise ValueError("No unique NPL reference row matches Mach and chord Reynolds")
    index, condition = matches[0]
    experimental = loaded[section]["experimental_zero_incidence_pressure_drag"][index]
    bias = measured_cd_pressure - experimental
    return {
        "section": section,
        "condition": condition,
        "measured_cd_pressure": measured_cd_pressure,
        "experimental_cd_pressure": experimental,
        "inviscid_cd_pressure": loaded[section]["inviscid_zero_incidence_pressure_drag"][index],
        "bias": bias,
        "absolute_error": abs(bias),
        "relative_error": abs(bias) / experimental,
        "validation_scope": "table_row_comparison_not_physical_compatibility",
        "campaign_compatible": False,
        "acceptance_certificate": False,
    }
