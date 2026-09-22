import argparse
from dataclasses import replace
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from airfoilfoam.postprocess.polar_history import history_observations
from airfoilfoam.postprocess.progressive_polar import fit_progressive_polar
from scripts.materials.measure_retained_polar import replay_source
from scripts.materials.uiuc_family_calibration import conformal_scale
from scripts.materials.validate_polar_uncertainty import reject_constant, unique_object, write_result


MULTIPLIERS = (0, 1, 2, 4)
BASE_SCALES = np.array([0.3, 0.5, 0.1])
GROUPS = {
    "fit": (12, "dbfae0bda2197f092c5ebdd116a9ecfbec8fb8551492d40bf2d069c533cc8450"),
    "calibration": (20, "3064695863541664cfd08ebf8315cc07e70325f8361af9d8ceee3e47bedf610b"),
    "heldout": (20, "edbf67d62612bb5b1b8bf1acd91167069222bca8cb4c4100bd77e6997a2c1a4c"),
}
SELECTION_SHA256 = "6a766ac08995427d7e0a4f9424ceebdcef12d3edc9cdf486ee12571e9e1dcc8a"


def bias_observation(observation, multipliers, accepted=False):
    scales = np.asarray(multipliers, dtype=float)
    if scales.shape != (3,) or any(value not in MULTIPLIERS for value in scales):
        raise ValueError("Bias allowance differs from the prespecified grid")
    if (not observation.eligible or accepted or observation.statistical_certification in {"steady", "periodic", "aperiodic"}
            or not np.any(scales)):
        return observation
    coefficients = np.asarray(observation.coefficients, dtype=float)
    errors = np.asarray(observation.standard_error, dtype=float)
    if coefficients.shape != (3,) or errors.shape != (3,) or not np.all(np.isfinite(errors)) or np.any(errors <= 0) or coefficients[1] <= 0:
        raise ValueError("Invalid uncertainty observation")
    transformed = errors.copy()
    transformed[1] = math.sqrt(math.log1p((errors[1] / coefficients[1]) ** 2))
    increased = np.hypot(transformed, scales * BASE_SCALES)
    increased[1] = coefficients[1] * math.sqrt(math.expm1(increased[1] ** 2))
    return replace(observation, standard_error=increased.tolist())


def curve_measurement(estimate, reference):
    angle = reference["alpha"]
    if not estimate["alpha"][0] <= angle <= estimate["alpha"][-1]:
        raise ValueError("Reference is outside the fitted prior domain")
    curve = estimate["curves"]["composite"]
    interpolated = {}
    for name in ("coefficients", "lower", "upper"):
        values = np.asarray(curve[name], dtype=float).copy()
        values[:, 1] = np.log(values[:, 1])
        interpolated[name] = np.array([np.interp(angle, estimate["alpha"], values[:, index]) for index in range(3)])
    truth = np.array([reference["payload"][name] for name in ("cl", "cd", "cm")], dtype=float)
    if not np.all(np.isfinite(truth)) or truth[1] <= 0:
        raise ValueError("Accepted reference coefficients are not physical")
    truth[1] = math.log(truth[1])
    sigma = (interpolated["upper"] - interpolated["lower"]) / 3.92
    if not np.all(np.isfinite(sigma)) or np.any(sigma <= 0):
        raise ValueError("The fitted interval has no finite positive scale")
    residual = truth - interpolated["coefficients"]
    normalized = abs(residual) / sigma
    return {"reference_attempt_id": reference["attemptId"], "alpha": angle,
            "negative_log_score": (0.5 * normalized ** 2 + np.log(sigma)).tolist(),
            "standardized_absolute_error": normalized.tolist(), "absolute_error_transformed": abs(residual).tolist(),
            "mean_transformed": interpolated["coefficients"].tolist(), "sigma_transformed": sigma.tolist()}


def measure_profile(source, request, multipliers):
    evidence = {row["attemptId"]: row for row in source["evidence"]}
    references = [row for row in source["evidence"] if row["classification"]["state"] == "accepted"]
    if not references:
        raise ValueError("Selected profile lost its accepted reference")
    rows = []
    for reference in references:
        def independent(observation):
            record = evidence[observation.attempt_id]
            return record["jobId"] != reference["jobId"] and record["lineageId"] != reference["lineageId"]
        observations = [row for row in request.observations if independent(row)]
        for history in request.histories:
            if independent(history.observation):
                observations.extend(history_observations(history, request.history_policy))
        changed = [bias_observation(row, multipliers, evidence[row.attempt_id]["classification"]["state"] == "accepted")
                   for row in observations]
        estimate = fit_progressive_polar(request.prior, changed, request.policy)
        row = curve_measurement(estimate, reference)
        row["contributors"] = estimate["contributors"]
        row["eligible_observations"] = sum(item.eligible for item in changed)
        row["fit_signature"] = estimate["signature"]
        rows.append(row)
    return {"profile_id": source["physical"]["airfoilId"], "model_id": source["model"]["id"], "references": rows,
            "negative_log_score": np.mean([row["negative_log_score"] for row in rows], axis=0).tolist(),
            "maximum_standardized_error": float(np.max([row["standardized_absolute_error"] for row in rows]))}


def load_groups(directory):
    loaded = {}
    identities, geometries = set(), set()
    for name, (count, signature) in GROUPS.items():
        path = directory / f"{name}.json"
        if path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("Cohort exceeds its declared source bound")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != signature:
            raise ValueError("Independent cohort changed")
        payload = json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject_constant)
        if payload.get("partition") != name or payload.get("selectionSha256") != SELECTION_SHA256 or len(payload["sources"]) != count:
            raise ValueError("Independent cohort differs from its frozen split")
        for source in payload["sources"]:
            profile = source["physical"]["airfoilId"]
            geometry = json.dumps(source["physical"]["geometry"], sort_keys=True, separators=(",", ":"))
            if profile in identities or geometry in geometries:
                raise ValueError("Profile or exact geometry repeats across the frozen cohort")
            identities.add(profile)
            geometries.add(geometry)
        loaded[name] = payload["sources"]
    return loaded


def prepare_sources(sources, directory):
    prepared, failures = [], []
    directory.mkdir()
    for source in sources:
        identifier = source["model"]["id"]
        if len(identifier) != 64 or any(character not in "0123456789abcdef" for character in identifier):
            raise ValueError("Invalid exact model identity")
        path = directory / f"{identifier}.json"
        signature = write_result(path, source)
        try:
            original, request, _ = replay_source(path, signature)
            prepared.append((original, request))
        except Exception as error:
            failures.append({"model_id": identifier, "error": str(error)[:1000]})
    if failures:
        write_result(directory / "failures.json", failures)
        raise ValueError("Not every selected source reproduces; no group may be dropped")
    return prepared


def study(source_directory, destination):
    destination.mkdir(parents=True, exist_ok=False)
    write_result(destination / "protocol.json", {"version": 1, "grid": MULTIPLIERS, "base_scales": BASE_SCALES.tolist(),
        "groups": GROUPS, "selection_sha256": SELECTION_SHA256, "score": "equal_profile_transformed_gaussian_negative_log_score",
        "interval_score": "profile_max_all_reference_angles_and_coefficients", "coverage": 0.95,
        "production_policy_changed": False, "physical_accuracy_validated": False})
    groups = load_groups(source_directory)
    fitting = prepare_sources(groups["fit"], destination / "fit-sources")
    grid = []
    for multiplier in MULTIPLIERS:
        measured = [measure_profile(source, request, [multiplier] * 3) for source, request in fitting]
        grid.append({"multiplier": multiplier, "profiles": measured,
                     "score": np.mean([row["negative_log_score"] for row in measured], axis=0).tolist()})
    chosen = [min(grid, key=lambda row: (row["score"][index], row["multiplier"]))["multiplier"] for index in range(3)]
    write_result(destination / "fitting.json", {"grid": grid, "chosen_multipliers": chosen})
    calibration = prepare_sources(groups["calibration"], destination / "calibration-sources")
    calibrated = [measure_profile(source, request, chosen) for source, request in calibration]
    scale = conformal_scale({row["profile_id"]: row["maximum_standardized_error"] for row in calibrated})
    frozen = {"multipliers": chosen, "calibration": scale, "profiles": calibrated, "production_policy_changed": False}
    parameter_signature = write_result(destination / "frozen-parameters.json", frozen)
    if not scale["available"]:
        raise ValueError("No finite complete-cohort interval calibration is available")
    heldout = prepare_sources(groups["heldout"], destination / "heldout-sources")
    evaluated = {}
    for name, multipliers in (("unchanged", [0, 0, 0]), ("bias_allowance", chosen)):
        measured = [measure_profile(source, request, multipliers) for source, request in heldout]
        interval_scale = 1.96 if name == "unchanged" else scale["scale"]
        evaluated[name] = {"profiles": measured, "interval_scale": interval_scale,
                           "profile_coverage": sum(row["maximum_standardized_error"] <= interval_scale for row in measured) / len(measured),
                           "mean_profile_absolute_error_transformed": np.mean([
                               np.mean([reference["absolute_error_transformed"] for reference in row["references"]], axis=0)
                               for row in measured], axis=0).tolist(),
                           "mean_profile_interval_width_transformed": np.mean([
                               np.mean([np.asarray(reference["sigma_transformed"]) * 2 * interval_scale
                                        for reference in row["references"]], axis=0) for row in measured], axis=0).tolist()}
    result = {"kind": "independent-retained-history-bias-comparison-v1", "frozen_parameters_sha256": parameter_signature,
              "chosen_multipliers": chosen, "results": evaluated, "calibration_status": "unvalidated",
              "production_policy_changed": False, "physical_accuracy_validated": False,
              "limitations": ["accepted_CFD_not_experimental_truth", "exchangeability_not_established",
                              "shared_initialization_ancestry_not_proven_independent", "surrogate_pretraining_overlap_unknown",
                              "not_a_Mach3_or_precise_stage_validation"]}
    write_result(destination / "report.json", result)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-directory", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    result = study(args.source_directory, args.destination)
    print(json.dumps({"chosen_multipliers": result["chosen_multipliers"], "calibration_status": "unvalidated",
                      "results": {name: {key: value for key, value in values.items() if key != "profiles"}
                                  for name, values in result["results"].items()}}))
