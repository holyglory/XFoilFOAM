import argparse
from dataclasses import asdict, replace
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from airfoilfoam.postprocess.polar_validation import PolarReference, PolarValidationCase, evaluate_held_out_polars
from airfoilfoam.postprocess.progressive_polar import PolarModelPolicy, PolarObservation, PolarPrior
from scripts.materials.evaluate_uiuc_prior import evaluate_archive, identity
from scripts.materials.inventory_uiuc_references import inventory_archive
from scripts.materials.validate_polar_uncertainty import write_result


SPLIT_VERSION = "uiuc-prior-family-holdout-v1"
PILOTS = {"e387", "s1223", "sd8020"}


def family_split(families):
    groups = set(families)
    if not PILOTS <= groups or len(groups) != 26:
        raise ValueError("Reference families differ from the predeclared inventory")
    ordered = sorted(groups - PILOTS, key=lambda group: hashlib.sha256(f"{SPLIT_VERSION}:{group}".encode()).hexdigest())
    return {"version": SPLIT_VERSION, "calibration": sorted(PILOTS | set(ordered[:16])), "validation": sorted(ordered[16:])}


def conformal_scale(scores, probability=0.95):
    if isinstance(probability, bool) or not math.isfinite(probability) or not 0 < probability < 1:
        raise ValueError("Invalid group coverage probability")
    if not scores or any(not isinstance(key, str) or not key for key in scores):
        raise ValueError("Calibration requires distinct named groups")
    values = list(scores.values())
    if any(isinstance(value, bool) or not math.isfinite(value) or value < 0 for value in values):
        raise ValueError("Invalid group nonconformity score")
    rank = math.ceil((len(values) + 1) * probability)
    if rank > len(values):
        return {"available": False, "scale": None, "rank": rank, "groups": len(values), "reason": "insufficient_independent_groups"}
    scale = sorted(values)[rank - 1]
    return {"available": scale > 0, "scale": scale if scale > 0 else None, "rank": rank, "groups": len(values),
            "reason": None if scale > 0 else "zero_width_requires_review"}


def case_score(case):
    truth = np.asarray([row[:2] for row in case.reference.coefficients], dtype=float)
    predicted = np.asarray([row[:2] for row in case.prior.coefficients], dtype=float)
    deviation = np.asarray([row[:2] for row in case.prior.standard_deviation], dtype=float)
    if truth.shape != predicted.shape or not np.isfinite(truth).all() or np.any(truth[:, 1] <= 0):
        raise ValueError("Group score requires complete measured lift/drag at exact prior angles")
    if case.reference.alpha != case.prior.alpha or case.observations:
        raise ValueError("Prior-only group score cannot interpolate or contain fitting anchors")
    errors = truth - predicted
    errors[:, 1] = np.log(truth[:, 1]) - np.log(predicted[:, 1])
    deviation[:, 1] = np.sqrt(np.log1p((deviation[:, 1] / predicted[:, 1]) ** 2))
    scores = np.abs(errors) / (1.96 * deviation)
    if not np.isfinite(scores).all():
        raise ValueError("Nonfinite group score")
    return float(np.max(scores))


def scale_prior(case, scale):
    if isinstance(scale, bool) or not math.isfinite(scale) or scale <= 0:
        raise ValueError("Candidate scale must be finite and positive")
    deviations = []
    for coefficients, original in zip(case.prior.coefficients, case.prior.standard_deviation, strict=True):
        log_variance = math.log1p((original[1] / coefficients[1]) ** 2)
        try:
            drag = coefficients[1] * math.sqrt(math.expm1(scale * scale * log_variance))
        except OverflowError as error:
            raise ValueError("Candidate uncertainty exceeds finite representation") from error
        scaled = [original[0] * scale, drag, original[2]]
        if not all(math.isfinite(value) and value > 0 for value in scaled):
            raise ValueError("Candidate uncertainty exceeds finite representation")
        deviations.append(scaled)
    return replace(case, prior=replace(case.prior, standard_deviation=deviations))


def run_study(archive, output):
    inventory = inventory_archive(archive)
    split = family_split(item["family"] for item in inventory["items"])
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    protocol = {"kind": "predeclared_profile_family_holdout", "split": split, "inventory_signature": identity(inventory),
                "coverage_probability": 0.95, "score": "family_max_across_cases_angles_lift_logdrag", "source_archive_sha256": inventory["archive_sha256"]}
    write_result(output / "protocol.json", protocol)
    cases, failures, exclusions, policy = [], [], [], None
    for item in inventory["items"]:
        try:
            measured = evaluate_archive(archive, [(item["source"].rsplit(".", 1)[0], item["coordinates"])], include_cases=True)
            exclusions.extend({**entry, "family": item["family"]} for entry in measured["limitations"] if "profile" in entry)
            candidate_policy = PolarModelPolicy(**measured["policy"])
            if policy is not None and candidate_policy != policy:
                raise ValueError("Model policy changed during the study")
            policy = candidate_policy
            for case in measured["case_inputs"]:
                cases.append(PolarValidationCase(case["case_id"], item["family"], case["condition_signature"], PolarPrior(**case["prior"]),
                                                 [PolarObservation(**row) for row in case["observations"]], PolarReference(**case["reference"])))
        except (ValueError, KeyError, RuntimeError) as error:
            failures.append({"profile": item["profile"], "family": item["family"], "reason": str(error)})
    failed_families = {failure["family"] for failure in failures}
    calibration = [case for case in cases if case.profile_signature in split["calibration"] and case.profile_signature not in failed_families]
    validation = [case for case in cases if case.profile_signature in split["validation"] and case.profile_signature not in failed_families]
    scores = {}
    for case in calibration:
        scores[case.profile_signature] = max(scores.get(case.profile_signature, 0), case_score(case))
    selected = conformal_scale(scores) if scores else {"available": False, "scale": None, "reason": "no_valid_calibration_groups", "groups": 0}
    baseline = evaluate_held_out_polars(validation, policy, fit_profiles=split["calibration"], fit_conditions=[], split_axis="profile") if validation else None
    candidate = None
    candidate_failure = None
    if selected["available"] and validation:
        try:
            candidate = evaluate_held_out_polars([scale_prior(case, selected["scale"]) for case in validation], policy,
                                                 fit_profiles=split["calibration"], fit_conditions=[], split_axis="profile")
        except ValueError as error:
            candidate_failure = str(error)
    validation_scores = {}
    for case in validation:
        validation_scores[case.profile_signature] = max(validation_scores.get(case.profile_signature, 0), case_score(case))
    report = {"kind": "uiuc_profile_family_conformal_candidate", "protocol": protocol, "attribution": inventory["attribution"],
              "calibration_scores": scores, "selected": selected, "validation_scores": validation_scores,
              "whole_family_coverage": None if not selected["available"] or not validation_scores else sum(value <= selected["scale"] for value in validation_scores.values()) / len(validation_scores),
              "baseline_validation": baseline, "candidate_validation": candidate, "failures": failures,
              "candidate_failure": candidate_failure, "excluded_reference_branches": exclusions,
              "source_inventory": inventory,
              "case_input_signature": identity([asdict(case) for case in cases]), "case_count": len(cases),
              "calibration_status": "unvalidated", "acceptance_verdict": "not_evaluated",
              "limitations": ["coverage_assumes_exchangeable_groups_not_established_by_this_archive", "surrogate_training_membership_unknown",
                              "Mach0_ncrit9_free_transition_assumed_not_measured", "experimental_moment_and_measurement_uncertainty_unavailable",
                              "prior_only_not_multifidelity_or_compressible_calibration", "condition_holdout_not_performed"]}
    signature = write_result(output / "report.json", report)
    print(json.dumps({"kind": report["kind"], "cases": len(cases), "selected": selected, "validation_groups": len(validation_scores),
                      "whole_family_coverage": report["whole_family_coverage"], "failures": failures,
                      "candidate_metrics": candidate["macro_metrics"] if candidate else None, "output_sha256": signature,
                      "calibration_status": report["calibration_status"]}, allow_nan=False))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    run_study(args.archive, args.output)
