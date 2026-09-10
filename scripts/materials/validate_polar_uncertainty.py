import argparse
import hashlib
import json
import os
from pathlib import Path
import tempfile

from airfoilfoam.postprocess.polar_validation import PolarReference, PolarValidationCase, evaluate_held_out_polars
from airfoilfoam.postprocess.progressive_polar import PolarModelPolicy, PolarObservation, PolarPrior


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate evaluation field: {key}")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError(f"Nonfinite JSON value: {value}")


def evaluate_file(input_path):
    input_path = Path(input_path)
    if input_path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Evaluation input exceeds its bounded size")
    raw = input_path.read_bytes()
    payload = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    if payload.get("version") != 1 or not isinstance(payload.get("cases"), list):
        raise ValueError("Unsupported held-out evaluation document")
    cases = []
    verified = set()
    for source in payload["cases"]:
        artifact = input_path.parent / source["reference_file"]
        with artifact.open("rb") as content:
            checksum = hashlib.file_digest(content, "sha256").hexdigest()
        if checksum != source["reference"]["source_sha256"]:
            raise ValueError("Held-out source artifact checksum differs")
        verified.add(checksum)
        cases.append(PolarValidationCase(
            source["case_id"], source["profile_signature"], source["condition_signature"],
            PolarPrior(**source["prior"]), [PolarObservation(**row) for row in source["observations"]],
            PolarReference(**source["reference"]),
        ))
    result = evaluate_held_out_polars(cases, PolarModelPolicy(**payload["policy"]),
                                     fit_profiles=payload["fit_profiles"], fit_conditions=payload["fit_conditions"], split_axis=payload["split_axis"])
    result["input_file_sha256"] = hashlib.sha256(raw).hexdigest()
    result["source_artifacts_verified"] = len(verified)
    result["reference_integrity"] = "artifact_hashes_verified_numeric_mapping_requires_source_loader"
    return result


def write_result(path, result):
    path = Path(path)
    content = json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".polar-evaluation-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return hashlib.sha256(content).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = evaluate_file(args.input)
    signature = write_result(args.output, result)
    print(json.dumps({"kind": "held-out-uncertainty-measurement", "cases": result["case_count"],
                      "output_sha256": signature, "calibration_status": result["calibration_status"], "acceptance_verdict": result["acceptance_verdict"]}))


if __name__ == "__main__":
    main()
