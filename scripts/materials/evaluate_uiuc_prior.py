import argparse
from dataclasses import asdict
import hashlib
import json
from pathlib import Path

from airfoilfoam.airfoil import parse_airfoil
from airfoilfoam.neuralfoil_solver import BaselineCondition, BaselineRecipe, solve_baseline
from airfoilfoam.postprocess.polar_validation import PolarReference, PolarValidationCase, evaluate_held_out_polars
from airfoilfoam.postprocess.progressive_polar import PolarModelPolicy, PolarPrior
from scripts.materials.uiuc_volume1_reference import ATTRIBUTION, load_uiuc_volume1_archive, parse_uiuc_volume1
from scripts.materials.validate_polar_uncertainty import write_result


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def evaluate_archive(path, profiles=None, include_cases=False):
    source = load_uiuc_volume1_archive(path)
    cases, predictions, limitations = [], [], []
    condition_values = {}
    policy = PolarModelPolicy("fixed-production-prior-assumptions-evaluation-v1", [0.4, 0.4, 0.1], [0.15, 0.15, 0.03],
                              [0.5, 0.3, 0.1], [0.15, 0.2, 0.03], [0.03, 0.03, 0.005], [0.01, 0.01, 0.001], 2, 0.8, "unvalidated")
    recipe = BaselineRecipe("uiuc-as-tested-prior-evaluation-v1", "large", 0.003, 0.012)
    profiles = profiles if profiles is not None else (("E387A", "e387a.dap"), ("S1223", "s1223.dap"), ("SD8020", "sd8020.dap"))
    for profile, coordinate_name in profiles:
        coordinates = parse_airfoil(source["coordinates"][coordinate_name].decode("ascii"))
        geometry = [[float(point[0]), float(point[1])] for point in coordinates]
        geometry_hash = identity(geometry)
        polar = parse_uiuc_volume1(source["drag"][profile + ".DRG"], "drag")
        conditions, references = [], []
        for run in polar["runs"]:
            for branch_index, branch in enumerate(run["branches"]):
                if len(branch["rows"]) < 2:
                    limitations.append({"profile": profile, "run": run["source_run"], "branch": branch_index,
                                        "samples": len(branch["rows"]), "reason": "fewer_than_two_reference_angles"})
                    continue
                rows = sorted(branch["rows"], key=lambda row: row["alpha"])
                angles = [row["alpha"] for row in rows]
                physical_condition = {"reynolds": run["reynolds"], "mach_assumption": 0, "n_crit_assumption": 9,
                                      "transition_assumption": "free", "surface": polar["condition"]}
                condition_id = identity(physical_condition)
                condition_values[condition_id] = physical_condition
                branch_name = f'{branch["direction"]}-{branch_index}'
                target_id = identity({"geometry": geometry_hash, "condition": condition_id, "source_run": run["source_run"], "branch": branch_name})
                conditions.append(BaselineCondition(target_id, run["reynolds"], 0, angles, 9, 1, 1, 0))
                references.append((condition_id, branch_name, PolarReference(
                    f'UIUC-V1-{profile}-{run["source_run"]}-{run["ordinal"]}-{branch_index}', polar["source_sha256"], "experimental", target_id,
                    branch_name, angles, [row["coefficients"] for row in rows], False)))
        measured = solve_baseline(geometry, {"source": coordinate_name, "source_sha256": hashlib.sha256(source["coordinates"][coordinate_name]).hexdigest(),
                                            "archive_sha256": source["archive_sha256"], "geometry_kind": "as_tested", "attribution": ATTRIBUTION}, conditions, recipe)
        for prediction, (condition_id, branch, reference) in zip(measured, references, strict=True):
            prior = PolarPrior(prediction["target_signature"], prediction["prediction_id"], branch, prediction["alpha"], prediction["coefficients"],
                               [[0.3, max(0.002, row[1] * 0.5), 0.1] for row in prediction["coefficients"]],
                               {"model": prediction["model"], "geometry_fit": prediction["geometry_fit"], "geometry_provenance": prediction["geometry_provenance"]})
            cases.append(PolarValidationCase(reference.reference_id, geometry_hash, condition_id, prior, [], reference))
            predictions.append(prediction)
    result = evaluate_held_out_polars(cases, policy, fit_profiles=[], fit_conditions=[], split_axis="profile_and_condition")
    result.update({"attribution": ATTRIBUTION, "source_archive_sha256": source["archive_sha256"], "evaluation_kind": "untuned_neuralfoil_prior_baseline",
                   "reference_integrity": "pinned_archive_and_source_specific_parser", "profiles": len(profiles),
                   "comparison_assumptions": {"mach": 0, "n_crit": 9, "transition": "free", "roughness": "clean_as_nominally_smooth",
                                              "as_tested_geometry": True, "measured_mach": None, "measured_n_crit": None},
                   "limitations": limitations + [{"reason": "not_multifidelity_or_compressible_calibration"}, {"reason": "surrogate_training_membership_unknown"},
                                                   {"reason": "measurement_uncertainty_unavailable"}, {"reason": "experimental_moment_unavailable"}],
                   "predictions": predictions, "policy": asdict(policy)})
    if include_cases:
        result["case_inputs"] = [asdict(case) for case in cases]
        result["condition_values"] = condition_values
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = evaluate_archive(args.archive)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    signature = write_result(args.output, report)
    print(json.dumps({"kind": report["evaluation_kind"], "profiles": report["profiles"], "cases": report["case_count"],
                      "metrics": report["macro_metrics"], "output_sha256": signature, "calibration_status": report["calibration_status"]}, allow_nan=False))
