import argparse
from dataclasses import replace
import hashlib
import json
from pathlib import Path

import numpy as np

from airfoilfoam.api.predictions import ProgressivePolarRequest, calculate_progressive_polar
from airfoilfoam.postprocess.polar_validation import PolarReference, PolarValidationCase, evaluate_held_out_polars
from scripts.materials.validate_polar_uncertainty import reject_constant, unique_object, write_result


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def replay_source(path, expected_sha256):
    path = Path(path)
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Retained source exceeds the bounded input size")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("Retained source differs from its pinned checksum")
    source = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
    if source.get("kind") != "retained-polar-holdout-source-v1":
        raise ValueError("Unknown retained source export")
    manifest = source["model"]["request"]
    if manifest.get("kind") != "progressive-fit-replay-manifest-v1":
        raise ValueError("Expected an exact stored fit replay manifest")
    evidence = {row["attemptId"]: row for row in source["evidence"]}
    if len(evidence) != len(source["evidence"]):
        raise ValueError("Retained evidence repeats an attempt")
    histories = []
    for history in manifest["histories"]:
        record = evidence[history["observation"]["attempt_id"]]
        physical_time = history["coordinate_kind"] == "physical_time"
        payload = record["payload"]["force_history" if physical_time else "steady_history"]
        coordinate = payload["t" if physical_time else "iterations"]
        if len(coordinate) != history["sample_count"] or any(len(payload[name]) != len(coordinate) for name in ("cl", "cd", "cm")):
            raise ValueError("Retained history differs from its declared sample grid")
        histories.append({**{name: value for name, value in history.items() if name != "sample_count"},
                          "coordinate": coordinate, "coefficients": list(map(list, zip(payload["cl"], payload["cd"], payload["cm"])))})
    request = ProgressivePolarRequest.model_validate({**{name: value for name, value in manifest.items() if name != "kind"},
                                                     "histories": histories})
    for observation in [*request.observations, *(history.observation for history in request.histories)]:
        record = evidence[observation.attempt_id]
        if (record["stage"] not in (2, 3) or observation.result_id != record["resultId"] or observation.lineage_id != record["lineageId"]
                or observation.alpha != record["alpha"]
                or observation.method != ("openfoam_fast" if record["stage"] == 2 else "openfoam_precise")):
            raise ValueError("Retained source changes the exact observation identity")
        if observation.coefficients is not None and observation.coefficients != [record["payload"][name] for name in ("cl", "cd", "cm")]:
            raise ValueError("Retained point differs from its immutable coefficients")
    replayed = calculate_progressive_polar(request)
    stored = source["model"]["response"]
    if (replayed["request_signature"] != stored["request_signature"]
            or replayed["estimate"]["signature"] != stored["estimate"]["signature"]
            or identity(replayed["estimate"]["contributors"]) != identity(stored["estimate"]["contributors"])):
        raise ValueError("The retained source cannot reproduce its exact stored fit")
    for method, curve in stored["estimate"]["curves"].items():
        for channel in ("coefficients", "lower", "upper"):
            if not np.allclose(curve[channel], replayed["estimate"]["curves"][method][channel], rtol=1e-10, atol=1e-12):
                raise ValueError("Replayed coefficients or intervals differ from the stored curve")
    return source, request, replayed


def measure_source(path, expected_sha256):
    source, request, replayed = replay_source(path, expected_sha256)
    evidence = {row["attemptId"]: row for row in source["evidence"]}
    profile = identity({"airfoil": source["physical"]["airfoilId"], "geometry": source["physical"]["geometry"]})
    condition = identity({name: value for name, value in source["physical"].items() if name not in ("airfoilId", "geometry")})
    held_out = []
    for record in sorted(evidence.values(), key=lambda row: row["attemptId"]):
        if record["classification"]["state"] != "accepted":
            continue
        coefficients = [record["payload"][name] for name in ("cl", "cd", "cm")]
        reference = PolarReference(record["attemptId"], record["signature"], "accepted_cfd", request.prior.target_signature,
                                   request.prior.branch, [record["alpha"]], [coefficients], False,
                                   [record["attemptId"], record["resultId"], record["jobId"]], [record["lineageId"]])

        def separate(observation):
            original = evidence[observation.attempt_id]
            return original["jobId"] != record["jobId"] and original["lineageId"] != record["lineageId"]

        case = PolarValidationCase(record["attemptId"], profile, condition, request.prior,
                                   [row for row in request.observations if separate(row)], reference,
                                   [history for history in request.histories if separate(history.observation)], request.history_policy)
        variants = {}
        for name, variant in (("prior_only", replace(case, observations=[], histories=[], history_policy=None)), ("remaining_evidence", case)):
            variants[name] = evaluate_held_out_polars([variant], request.policy, fit_profiles=[], fit_conditions=[], split_axis="profile")
        held_out.append({"reference_attempt_id": record["attemptId"], "reference_alpha": record["alpha"], "variants": variants})
    return {"kind": "retained-polar-history-measurement-v1", "source_sha256": expected_sha256,
            "model_id": source["model"]["id"], "fit_signature": replayed["estimate"]["signature"],
            "stored_fit_reproduced": True, "history_count": len(request.histories),
            "history_kinds": sorted({history.coordinate_kind for history in request.histories}),
            "contributors": replayed["estimate"]["contributors"], "held_out": held_out,
            "calibration_status": "unvalidated", "validation_id": None, "production_policy_changed": False,
            "limitations": ["retrospective_diagnostic_not_untouched_policy_holdout", "accepted_CFD_is_not_experimental_truth",
                            "reference_numerical_and_measurement_error_unquantified", "shared_initialization_ancestry_not_proven_independent",
                            "sparse_current_fast_stage_not_fast_to_precise_or_profile_population_calibration"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    result = measure_source(arguments.source, arguments.sha256)
    source_bytes = arguments.source.read_bytes()
    if hashlib.sha256(source_bytes).hexdigest() != arguments.sha256:
        raise ValueError("Retained source changed during measurement")
    arguments.output.parent.mkdir(parents=True, exist_ok=False)
    with (arguments.output.parent / "source.json").open("xb") as retained:
        retained.write(source_bytes)
    digest = write_result(arguments.output, result)
    print(json.dumps({"kind": result["kind"], "stored_fit_reproduced": result["stored_fit_reproduced"],
                      "history_count": result["history_count"], "held_out_references": len(result["held_out"]),
                      "output_sha256": digest, "calibration_status": result["calibration_status"]}))


if __name__ == "__main__":
    main()
