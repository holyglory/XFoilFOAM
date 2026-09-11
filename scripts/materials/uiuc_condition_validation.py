import argparse
from dataclasses import asdict
import json
import math
from pathlib import Path

from airfoilfoam.postprocess.polar_validation import PolarReference, PolarValidationCase, evaluate_held_out_polars
from airfoilfoam.postprocess.progressive_polar import PolarModelPolicy, PolarObservation, PolarPrior
from scripts.materials.evaluate_uiuc_prior import evaluate_archive, identity
from scripts.materials.inventory_uiuc_references import inventory_archive
from scripts.materials.uiuc_family_calibration import case_score, conformal_scale
from scripts.materials.validate_polar_uncertainty import write_result


GROUP_CENTERS = (40000, 60000, 100000, 150000, 200000, 250000, 300000)
GROUP_TOLERANCE = 0.05
PROTOCOL_VERSION = "uiuc-retrospective-condition-groups-v1"


def reynolds_group(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError("Condition grouping requires finite positive measured Reynolds")
    matches = [center for center in GROUP_CENTERS if abs(value - center) <= center * GROUP_TOLERANCE]
    if len(matches) != 1:
        raise ValueError("Measured Reynolds is outside the declared separated groups")
    return matches[0]


def evaluate_condition_groups(cases, conditions, policy):
    groups = {}
    identifiers = set()
    for case in cases:
        if case.case_id in identifiers:
            raise ValueError("Condition evaluation repeats a case")
        identifiers.add(case.case_id)
        condition = conditions.get(case.condition_signature)
        if not isinstance(condition, dict) or identity(condition) != case.condition_signature:
            raise ValueError("Condition values differ from their exact identity")
        group = reynolds_group(condition.get("reynolds"))
        groups.setdefault(group, []).append(case)
    if len(groups) < 2:
        raise ValueError("Condition evaluation needs at least two separated groups")
    folds = []
    for group, validation in sorted(groups.items()):
        calibration = [case for other, members in groups.items() if other != group for case in members]
        fit_conditions = sorted({case.condition_signature for case in calibration})
        evaluation_conditions = sorted({case.condition_signature for case in validation})
        if set(fit_conditions) & set(evaluation_conditions):
            raise ValueError("Neighboring conditions cross the evaluation boundary")
        scores = {str(other): max(case_score(case) for case in members) for other, members in groups.items() if other != group}
        baseline = evaluate_held_out_polars(validation, policy, fit_profiles=sorted({case.profile_signature for case in calibration}),
                                           fit_conditions=fit_conditions, split_axis="condition")
        folds.append({"held_out_reynolds_group_center": group, "fit_condition_signatures": fit_conditions,
                      "evaluation_condition_signatures": evaluation_conditions, "calibration_scores": scores,
                      "finite_scale_availability": conformal_scale(scores), "baseline": baseline})
    return folds


def run_study(archive, output):
    inventory = inventory_archive(archive)
    groups = {reynolds_group(value) for item in inventory["items"] for value in item["reynolds"]}
    if groups != set(GROUP_CENTERS):
        raise ValueError("Source inventory differs from the declared condition groups")
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    protocol = {"version": PROTOCOL_VERSION, "kind": "retrospective_leave_one_reynolds_group_out",
                "group_centers": GROUP_CENTERS, "relative_group_tolerance": GROUP_TOLERANCE,
                "grouping_changes_physical_targets": False, "coverage_probability": 0.95,
                "score": "condition_group_max_across_profiles_branches_angles_lift_logdrag",
                "inventory_signature": identity(inventory), "source_archive_sha256": inventory["archive_sha256"],
                "untouched_prospective_holdout": False}
    write_result(output / "protocol.json", protocol)
    cases, conditions, failures, exclusions, policy = [], {}, [], [], None
    for item in inventory["items"]:
        try:
            measured = evaluate_archive(archive, [(item["source"].rsplit(".", 1)[0], item["coordinates"])], include_cases=True)
            candidate_policy = PolarModelPolicy(**measured["policy"])
            if policy is not None and candidate_policy != policy:
                raise ValueError("Model policy changed during the condition study")
            policy = candidate_policy
            exclusions.extend({**entry, "family": item["family"]} for entry in measured["limitations"] if "profile" in entry)
            for signature, values in measured["condition_values"].items():
                if signature in conditions and conditions[signature] != values:
                    raise ValueError("Source conditions changed during the study")
                conditions[signature] = values
            for case in measured["case_inputs"]:
                cases.append(PolarValidationCase(case["case_id"], item["family"], case["condition_signature"], PolarPrior(**case["prior"]),
                                                 [PolarObservation(**row) for row in case["observations"]], PolarReference(**case["reference"])))
        except (ValueError, KeyError, RuntimeError) as error:
            failures.append({"profile": item["profile"], "family": item["family"], "reason": str(error)})
    inputs = {"cases": [asdict(case) for case in cases], "condition_values": conditions,
              "policy": asdict(policy) if policy is not None else None}
    input_signature = write_result(output / "case-inputs.json", inputs)
    folds = evaluate_condition_groups(cases, conditions, policy) if cases else []
    report = {"kind": PROTOCOL_VERSION, "protocol": protocol, "source_inventory": inventory, "attribution": inventory["attribution"],
              "case_input_sha256": input_signature, "folds": folds, "case_count": len(cases), "failures": failures,
              "excluded_reference_branches": exclusions, "calibration_status": "unvalidated", "acceptance_verdict": "not_evaluated",
              "limitations": ["archive_already_used_in_prior_studies_not_untouched_holdout", "profile_overlap_between_condition_folds",
                              "nearby_reynolds_grouping_is_analyst_defined_not_a_physical_identity", "group_exchangeability_not_established",
                              "six_calibration_groups_cannot_supply_finite_95_percent_conformal_scale", "surrogate_training_membership_unknown",
                              "Mach0_ncrit9_free_transition_assumed_not_measured", "experimental_moment_and_measurement_uncertainty_unavailable",
                              "prior_only_not_multifidelity_or_compressible_calibration"]}
    signature = write_result(output / "report.json", report)
    print(json.dumps({"kind": report["kind"], "case_count": len(cases), "folds": len(folds), "failures": failures,
                      "output_sha256": signature, "calibration_status": report["calibration_status"]}, allow_nan=False))
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    run_study(arguments.archive, arguments.output)
