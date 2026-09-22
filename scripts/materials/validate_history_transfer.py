import argparse
import hashlib
import json
import re
from pathlib import Path

import numpy as np

from scripts.materials.calibrate_history_bias import GROUPS, load_groups, measure_profile
from scripts.materials.measure_retained_polar import identity, replay_source
from scripts.materials.validate_polar_uncertainty import reject_constant, unique_object, write_result


SELECTION_SHA256 = "aeaa82f385c4332053c5351b5264a4fa02b843c27e1a1771385facbfe0687291"
SOURCE_SHA256 = "6402d464a73cb7c75f4804d7abb937a768e9d05a12f37cda9c02da3d306df389"
PARAMETERS_SHA256 = "3009eb352665d7177db5f217798de1b1db7c28eb4b64ad3d04664a01f1309636"
PILOT_SHA256 = "a25a1ec79120cd779a04e808328d23560d1839d4806aaf492a94952e4f62a8b6"
COHORT_COUNTS = {"compressible": 7, "control": 20}


def pinned_json(path, expected_sha256):
    path = Path(path)
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Transfer input exceeds the retained source bound")
    raw = path.read_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_sha256:
        raise ValueError("Transfer input differs from the preregistered checksum")
    return json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)


def geometry_signature(source):
    coordinates = np.asarray(source["physical"]["geometry"], dtype=float)
    if coordinates.ndim != 2 or coordinates.shape[1] != 2 or not np.isfinite(coordinates).all():
        raise ValueError("Transfer profile has invalid retained geometry")
    return identity(coordinates.tolist())


def verify_transfer_selection(selection, exported, prior_sources):
    if (selection.get("kind") != "frozen-history-transfer-selection-v1"
            or exported.get("kind") != "frozen-history-transfer-export-v1"
            or exported.get("selectionSha256") != SELECTION_SHA256):
        raise ValueError("Transfer inputs have a different selection contract")
    chosen = {row["modelId"]: row for row in selection["selected"]}
    if len(chosen) != sum(COHORT_COUNTS.values()) or len(chosen) != len(selection["selected"]):
        raise ValueError("Transfer selection repeats or loses a selected model")
    if any(not isinstance(model_id, str) or not re.fullmatch(r"[a-f0-9]{64}", model_id) for model_id in chosen):
        raise ValueError("Transfer model identities are not content hashes")
    rows = exported["sources"]
    if (len(rows) != len(chosen)
            or {row["source"]["model"]["id"] for row in rows} != set(chosen)):
        raise ValueError("Transfer export does not conserve every selected model")
    profiles = {source["physical"]["airfoilId"] for source in prior_sources}
    geometries = {geometry_signature(source) for source in prior_sources}
    counts = {cohort: 0 for cohort in COHORT_COUNTS}
    for row in rows:
        source = row["source"]
        expected = chosen[source["model"]["id"]]
        physical = source["physical"]
        cohort = row["cohort"]
        if (cohort not in counts or cohort != expected["cohort"]
                or physical["airfoilId"] != expected["airfoilId"]
                or physical["derived"]["mach"] != expected["mach"]
                or physical["derived"]["reynolds"] != expected["reynolds"]):
            raise ValueError("Transfer profile or physical conditions changed")
        geometry = geometry_signature(source)
        if physical["airfoilId"] in profiles or geometry in geometries:
            raise ValueError("Transfer profile or geometry overlaps prior or other selected evidence")
        if any(not isinstance(evidence.get("jobId"), str) or not evidence["jobId"]
               or not isinstance(evidence.get("lineageId"), str) or not evidence["lineageId"]
               for evidence in source["evidence"]):
            raise ValueError("Transfer evidence lacks independent job or lineage identity")
        profiles.add(physical["airfoilId"])
        geometries.add(geometry)
        counts[cohort] += 1
    if counts != COHORT_COUNTS:
        raise ValueError("Transfer cohort counts differ from the frozen selection")


def physical_errors(measured, source):
    evidence = {row["attemptId"]: row for row in source["evidence"]}
    errors = []
    for reference in measured["references"]:
        predicted = np.array(reference["mean_transformed"], dtype=float)
        predicted[1] = np.exp(predicted[1])
        truth = np.array([evidence[reference["reference_attempt_id"]]["payload"][name]
                          for name in ("cl", "cd", "cm")], dtype=float)
        errors.append(np.abs(predicted - truth))
    result = np.mean(errors, axis=0)
    if not np.isfinite(result).all():
        raise ValueError("Transfer physical errors are not finite")
    return result.tolist()


def summarize(rows, expected_count, variant, interval_scale):
    measured = [row["variants"][variant] for row in rows]
    complete = len(measured) == expected_count
    if not measured:
        return {"complete": False, "requested_profiles": expected_count, "evaluated_profiles": 0}
    covered = sum(row["maximum_standardized_error"] <= interval_scale for row in measured)
    return {
        "complete": complete,
        "requested_profiles": expected_count,
        "evaluated_profiles": len(measured),
        "interval_scale": interval_scale,
        "covered_profiles": covered,
        "profile_coverage": covered / expected_count if complete else None,
        "mean_profile_absolute_error": np.mean([row["mean_absolute_error"] for row in measured], axis=0).tolist(),
        "mean_profile_interval_width_transformed": np.mean([
            np.mean([np.asarray(reference["sigma_transformed"]) * 2 * interval_scale
                     for reference in row["references"]], axis=0) for row in measured], axis=0).tolist(),
        "metrics_basis": "all_selected_profiles" if complete else "available_profiles_not_a_complete_study",
    }


def study(source_path, selection_path, parameters_path, prior_directory, pilot_path, destination):
    selection = pinned_json(selection_path, SELECTION_SHA256)
    exported = pinned_json(source_path, SOURCE_SHA256)
    parameters = pinned_json(parameters_path, PARAMETERS_SHA256)
    pilot = pinned_json(pilot_path, PILOT_SHA256)
    prior = [source for sources in load_groups(Path(prior_directory)).values() for source in sources]
    if parameters["multipliers"] != [1, 1, 1] or not parameters["calibration"]["available"]:
        raise ValueError("Transfer requires the originally frozen candidate, not new fitting")
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=False)
    protocol = {
        "kind": "frozen-history-transfer-v1",
        "selection_sha256": SELECTION_SHA256,
        "source_sha256": SOURCE_SHA256,
        "frozen_parameters_sha256": PARAMETERS_SHA256,
        "prior_cohort_sha256": {name: signature for name, (_, signature) in GROUPS.items()},
        "pilot_sha256": PILOT_SHA256,
        "cohort_counts": COHORT_COUNTS,
        "multipliers": parameters["multipliers"],
        "transferred_interval_scale": parameters["calibration"]["scale"],
        "retuning": False,
        "production_policy_changed": False,
        "calibration_status": "unvalidated",
    }
    write_result(destination / "protocol.json", protocol)
    failures, measured = [], []
    try:
        verify_transfer_selection(selection, exported, [*prior, *pilot["sources"]])
    except (KeyError, TypeError, ValueError) as error:
        failures.append({"scope": "selection", "error": str(error)})
    if not failures:
        for row in exported["sources"]:
            source = row["source"]
            model_id = source["model"]["id"]
            source_file = destination / f"{model_id}.json"
            signature = write_result(source_file, source)
            try:
                retained, request, _ = replay_source(source_file, signature)
                variants = {}
                for name, multipliers in (("baseline", [0, 0, 0]), ("candidate", parameters["multipliers"])):
                    result = measure_profile(retained, request, multipliers)
                    result["mean_absolute_error"] = physical_errors(result, retained)
                    variants[name] = result
                measured.append({"cohort": row["cohort"], "model_id": model_id,
                                 "mach": retained["physical"]["derived"]["mach"], "variants": variants})
            except Exception as error:
                failures.append({"model_id": model_id, "cohort": row["cohort"], "error": str(error)[:1000]})
    summaries = {}
    for cohort, expected_count in COHORT_COUNTS.items():
        rows = [row for row in measured if row["cohort"] == cohort]
        summaries[cohort] = {
            "baseline": summarize(rows, expected_count, "baseline", 1.96),
            "candidate_unscaled": summarize(rows, expected_count, "candidate", 1.96),
            "candidate_transferred_scale": summarize(rows, expected_count, "candidate", parameters["calibration"]["scale"]),
        }
    report = {**protocol, "complete": not failures, "failures": failures, "summaries": summaries, "profiles": measured,
              "limitations": ["accepted_CFD_not_experimental_truth", "small_compressible_cohort_not_population_calibration",
                              "shared_initialization_ancestry_not_proven_independent", "no_positive_angle_history_validation",
                              "no_transonic_Mach3_or_precise_stage_validation", "old_interval_scale_transfer_not_recalibration"]}
    signature = write_result(destination / "report.json", report)
    print(json.dumps({"complete": report["complete"], "failures": failures, "summaries": summaries,
                      "report_sha256": signature, "production_policy_changed": False}, allow_nan=False))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    for argument in ("source", "selection", "parameters", "prior-directory", "pilot", "destination"):
        parser.add_argument(f"--{argument}", type=Path, required=True)
    arguments = parser.parse_args()
    result = study(arguments.source, arguments.selection, arguments.parameters, arguments.prior_directory,
                   arguments.pilot, arguments.destination)
    raise SystemExit(0 if result["complete"] else 1)
