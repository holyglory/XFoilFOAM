import argparse
import hashlib
import json
from pathlib import Path
import re

from scripts.materials.measure_retained_polar import measure_source
from scripts.materials.validate_polar_uncertainty import reject_constant, unique_object, write_result


def measure_cohort(source_path, expected_sha256, destination):
    source_path, destination = Path(source_path), Path(destination)
    if source_path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Retained cohort exceeds the bounded input size")
    raw = source_path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("Retained cohort differs from its pinned checksum")
    cohort = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    sources = cohort.get("sources")
    if (cohort.get("kind") != "retained-polar-cohort-export-v1" or not isinstance(sources, list)
            or not 1 <= len(sources) <= 64):
        raise ValueError("Expected a bounded retained polar cohort")
    identities = [source["model"]["id"] for source in sources]
    profiles = [source["physical"]["airfoilId"] for source in sources]
    if (any(not isinstance(identity, str) or not re.fullmatch(r"[0-9a-f]{64}", identity) for identity in identities)
            or len(set(identities)) != len(identities) or len(set(profiles)) != len(profiles)):
        raise ValueError("Cohort must have distinct exact model and profile identities")
    destination.mkdir(parents=True, exist_ok=False)
    (destination / "source-cohort.json").write_bytes(raw)
    measurements, failures = [], []
    for source in sources:
        directory = destination / source["model"]["id"]
        directory.mkdir()
        source_file = directory / "source.json"
        source_sha256 = write_result(source_file, source)
        try:
            report = measure_source(source_file, source_sha256)
            report_sha256 = write_result(directory / "report.json", report)
            measurements.append({"model_id": source["model"]["id"], "profile_id": source["physical"]["airfoilId"],
                                 "source_sha256": source_sha256, "report_sha256": report_sha256,
                                 "history_count": report["history_count"], "held_out_references": len(report["held_out"])})
        except Exception as error:
            failure = {"model_id": source["model"]["id"], "source_sha256": source_sha256,
                       "error_type": type(error).__name__, "error": str(error)[:1000]}
            write_result(directory / "failure.json", failure)
            failures.append(failure)
    summary = {"kind": "retained-polar-cohort-measurement-v1", "source_sha256": expected_sha256,
               "requested_profiles": len(profiles), "measurements": measurements, "failures": failures,
               "complete": len(measurements) == len(sources), "calibration_status": "unvalidated",
               "production_policy_changed": False, "source_selection": cohort.get("selection"),
               "limitations": ["retrospective_diagnostic_not_untouched_policy_holdout",
                               "accepted_CFD_is_not_experimental_truth",
                               "shared_initialization_ancestry_not_proven_independent"]}
    write_result(destination / "summary.json", summary)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--destination", type=Path, required=True)
    arguments = parser.parse_args()
    result = measure_cohort(arguments.source, arguments.sha256, arguments.destination)
    print(json.dumps({"complete": result["complete"], "profiles": len(result["measurements"]),
                      "failed_profiles": len(result["failures"]), "calibration_status": result["calibration_status"]}))
    raise SystemExit(0 if result["complete"] else 1)
