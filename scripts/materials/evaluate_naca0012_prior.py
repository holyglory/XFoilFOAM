import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from airfoilfoam.neuralfoil_solver import BaselineCondition, BaselineRecipe, solve_baseline
from scripts.materials.naca0012_reference import load_reference
from scripts.materials.validate_polar_uncertainty import write_result


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def compare_prediction(reference, prediction):
    angles = prediction["alpha"]
    if (any(isinstance(angle, bool) or not isinstance(angle, (int, float)) or not math.isfinite(angle) for angle in angles)
            or len(set(angles)) != len(angles)):
        raise ValueError("Prediction angles must be finite and unique")
    coefficients = np.asarray(prediction["coefficients"], dtype=float)
    if coefficients.shape != (len(angles), 3) or not np.isfinite(coefficients).all() or np.any(coefficients[:, 1] <= 0):
        raise ValueError("Invalid predicted coefficient array")
    indices = {angle: index for index, angle in enumerate(angles)}
    measured = []
    for run in reference["runs"]:
        if any(row["alpha"] not in indices for row in run["rows"]):
            raise ValueError("Reference angles require exact predictions, not interpolation")
        selected = coefficients[[indices[row["alpha"]] for row in run["rows"]], :2]
        truth = np.asarray([row["coefficients"][:2] for row in run["rows"]], dtype=float)
        error = selected - truth
        with np.errstate(over="ignore", invalid="ignore"):
            squared = error ** 2
        if not np.isfinite(squared).all():
            raise ValueError("Comparison error exceeds finite range")
        measured.append({"trip_grit": run["trip_grit"], "samples": len(truth),
                         "alpha": [row["alpha"] for row in run["rows"]], "reference_coefficients": truth.tolist(),
                         "predicted_coefficients": selected.tolist(),
                         "metrics": {name: {"rmse": float(np.sqrt(np.mean(squared[:, column]))),
                                            "bias": float(np.mean(error[:, column])),
                                            "mae": float(np.mean(np.abs(error[:, column])))}
                                     for column, name in enumerate(("cl", "cd"))}})
    return measured


def run_study(directory, output):
    reference = load_reference(directory)
    output = Path(output)
    output.mkdir(parents=True, exist_ok=False)
    assumptions = {"model_geometry": reference["geometry_kind"], "as_tested_geometry": False,
                   "model_transition_upper": 0, "model_transition_lower": 0,
                   "model_n_crit": 9, "model_surface": "smooth_fully_turbulent_approximation",
                   "measured_trip_location": None, "measured_equivalent_roughness": None}
    angles = sorted({row["alpha"] for run in reference["runs"] for row in run["rows"]})
    target = identity({"geometry": reference["sources"]["n0012points_superbig_clust_fix.dat"]["sha256"],
                       "reynolds": 6000000, "mach": 0.15, "assumptions": assumptions})
    protocol = {"kind": "fixed_prior_comparison_protocol", "source_files": reference["sources"],
                "prediction_angles": angles, "assumptions": assumptions, "reference_conditions": reference["conditions"],
                "training_membership": "unknown", "production_policy_changed": False,
                "calibration_eligible": False, "limitations": reference["limitations"]}
    protocol_sha = write_result(output / "protocol.json", protocol)
    predictions = solve_baseline(reference["coordinates"], {
        "source_url": reference["sources"]["n0012points_superbig_clust_fix.dat"]["url"],
        "source_sha256": reference["sources"]["n0012points_superbig_clust_fix.dat"]["sha256"],
        "geometry_kind": reference["geometry_kind"], "coordinate_order": reference["coordinate_order"],
    }, [BaselineCondition(target, 6000000, 0.15, angles, 9, 0, 0, 0)],
       BaselineRecipe("naca0012-fully-turbulent-comparison-v1", "large", 0.003, 0.012))
    result = {"kind": "naca0012_tripped_prior_comparison", "protocol_sha256": protocol_sha,
              "attribution": reference["attribution"], "source_page": reference["source_page"],
              "source_files": reference["sources"], "assumptions": assumptions,
              "prediction": predictions[0], "cases": compare_prediction(reference, predictions[0]),
              "calibration_status": "unvalidated", "acceptance_verdict": "not_evaluated", "validation_id": None,
              "limitations": reference["limitations"] + ["prior_only_not_CFD_refinement", "not_a_matched_target_calibration"]}
    signature = write_result(output / "report.json", result)
    return {"kind": result["kind"], "cases": len(result["cases"]),
            "samples": sum(case["samples"] for case in result["cases"]), "report_sha256": signature,
            "metrics": [{"trip_grit": case["trip_grit"], "metrics": case["metrics"]} for case in result["cases"]],
            "calibration_status": result["calibration_status"]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(run_study(args.reference, args.output), allow_nan=False))
