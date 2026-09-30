import argparse
from dataclasses import replace
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from airfoilfoam.api.predictions import ProgressivePolarRequest, calculate_progressive_polar
from airfoilfoam.postprocess.polar_history import history_observations
from airfoilfoam.postprocess.progressive_polar import PolarObservation, fit_progressive_polar
from scripts.materials.calibrate_history_bias import curve_measurement
from scripts.materials.measure_retained_polar import identity, replay_source
from scripts.materials.validate_history_transfer import pinned_json
from scripts.materials.validate_polar_uncertainty import write_result


CANDIDATES = ("unchanged", "method_floor", "disagreement_floor", "conservative_floor", "method_conservative_floor", "grouped_reversal_floor")
MODEL_TAIL_PROBABILITY = 0.01
CONFLICT_CUTOFF = 1 + 2 * math.sqrt(-math.log(MODEL_TAIL_PROBABILITY)) - 2 * math.log(MODEL_TAIL_PROBABILITY)
SG_SHA256 = "06da59e93dbb969b3dcc1091c486d19aed176fd634c3a74f44c77c5464417654"
NATIVE_SHA256 = "d24fcb2ce96d8cf92970c8d3fd5bfd42007b0ce4215f78444bbb16bf0c6459d4"
PILOT_SHA256 = "a25a1ec79120cd779a04e808328d23560d1839d4806aaf492a94952e4f62a8b6"
PRODUCER_SHA256 = "6cf73807385838646488ea92283eb198c3d49c442433956b520edb5bcf1c984c"


def producing_request_signature(request, source_path):
    if hashlib.sha256(Path(source_path).read_bytes()).hexdigest() != PRODUCER_SHA256:
        raise ValueError("The pinned producing API source changed")
    payload = request.model_dump(mode="json", exclude={"epoch_id", "lease_token"})
    if payload["policy"].get("uncertified_fast_bias_std") is None:
        payload["policy"].pop("uncertified_fast_bias_std", None)
    for observation in [*payload["observations"], *(history["observation"] for history in payload["histories"])]:
        if observation.get("physical_identity") is not None or observation.get("numerical_identity") is not None:
            raise ValueError("The historical null-identity replay is outside its declared scope")
        if observation.get("accepted_cfd") is None:
            observation.pop("accepted_cfd", None)
    return identity(payload)


def candidate_fit(prior, observations, policy, candidate):
    if candidate not in CANDIDATES:
        raise ValueError("Unknown frozen sparse-mean candidate")
    baseline = fit_progressive_polar(prior, observations, policy)
    if candidate == "unchanged" or not baseline["contributors"]:
        return baseline
    cutoff = CONFLICT_CUTOFF if "conservative" in candidate else 1.0
    methods = {row.method for row in observations if row.eligible}
    scores = {}
    grouped = grouped_conflict_diagnostics(prior, observations, policy)
    grouped_factors = {}
    if candidate == "grouped_reversal_floor":
        for method in methods:
            reversals = [row for row in grouped["reversals"] if row["method"] == method and row["reversal"]]
            groups = [row for row in grouped["groups"] if row["method"] == method]
            grouped_factors[method] = 16.0 * max([row["related_window_count"] // 2 for row in reversals] or [0])
    for method in methods:
        diagnostic = fit_progressive_polar(prior, [row for row in observations if row.method == method], policy) \
            if candidate == "method_conservative_floor" else baseline
        scores[method] = [row["disagreement_variance_multiplier"] for row in diagnostic["diagnostics"]]
    multipliers = {method: (np.full(3, grouped_factors.get(method, 0.0)) if candidate == "grouped_reversal_floor"
                            else np.ones(3) if candidate == "method_floor"
                            else np.maximum(np.asarray(score)/cutoff-1,0))
                   for method, score in scores.items()}
    changed = []
    for observation in observations:
        if not observation.eligible:
            changed.append(observation)
            continue
        multiplier = multipliers[observation.method]
        if not multiplier.any():
            changed.append(observation)
            continue
        scale = np.asarray(policy.fast_discrepancy_std if observation.method == "openfoam_fast"
                           else policy.precise_discrepancy_std)
        original = np.asarray(observation.standard_error, dtype=float)
        transformed = original.copy()
        transformed[1] = math.sqrt(math.log1p((original[1] / observation.coefficients[1]) ** 2))
        effective = np.sqrt(transformed ** 2 + multiplier * scale ** 2)
        effective[1] = observation.coefficients[1] * math.sqrt(math.expm1(effective[1] ** 2))
        changed.append(replace(observation, standard_error=effective.tolist()))
    result = fit_progressive_polar(prior, changed, policy)
    result["research_only"] = {"candidate": candidate, "not_production_policy": True,
                               "original_observations_sha256": identity([row.__dict__ for row in observations]),
                               "added_variance_multipliers": {method: value.tolist() for method,value in multipliers.items()},
                               "disagreement_scores_before": scores, "grouped_conflicts": grouped,
                               "model_cutoff": cutoff,
                               "tail_probability_per_method_coefficient": MODEL_TAIL_PROBABILITY if "conservative" in candidate else None}
    result["research_only"]["grouped_conflicts"] = grouped_conflict_diagnostics(prior, observations, policy)
    return result


def grouped_conflict_diagnostics(prior, observations, policy):
    prior_angles = np.asarray(prior.alpha, dtype=float)
    prior_values = np.asarray(prior.coefficients, dtype=float)
    groups = {}
    for observation in observations:
        if not observation.eligible:
            continue
        key = (observation.method, observation.lineage_id)
        groups.setdefault(key, []).append(observation)
    diagnostics = []
    for (method, lineage_id), rows in sorted(groups.items()):
        angles = np.asarray([row.alpha for row in rows], dtype=float)
        values = np.asarray([row.coefficients for row in rows], dtype=float)
        errors = np.asarray([row.standard_error for row in rows], dtype=float)
        transformed = values.copy()
        transformed[:, 1] = np.log(values[:, 1])
        transformed_errors = errors.copy()
        transformed_errors[:, 1] = np.sqrt(np.log1p((errors[:, 1] / values[:, 1]) ** 2))
        center = float(np.mean(angles))
        prior_center = np.array([np.interp(center, prior_angles, prior_values[:, index]) for index in range(3)])
        prior_center[1] = math.log(prior_center[1])
        residual = np.mean(transformed - prior_center, axis=0)
        group_error = np.sqrt(np.mean(transformed_errors ** 2, axis=0))
        standardized = residual / np.maximum(group_error, 1e-12)
        diagnostics.append({
            "method": method,
            "lineage_id": lineage_id,
            "window_count": len(rows),
            "alpha_min": float(angles.min()),
            "alpha_max": float(angles.max()),
            "alpha_center": center,
            "residual_transformed": residual.tolist(),
            "group_error_transformed": group_error.tolist(),
            "standardized_residual": standardized.tolist(),
            "group_squared_score": float(np.mean(standardized ** 2)),
            "cl_value": float(np.mean(values[:, 0])),
        })
    reversals = []
    for method in sorted({row["method"] for row in diagnostics}):
        method_groups = [row for row in diagnostics if row["method"] == method]
        if len(method_groups) < 2:
            continue
        method_groups.sort(key=lambda row: row["alpha_center"])
        left, right = method_groups[0], method_groups[-1]
        observed_delta = (right["residual_transformed"][0] - left["residual_transformed"][0]
                          + float(np.interp(right["alpha_center"], prior_angles, prior_values[:, 0]))
                          - float(np.interp(left["alpha_center"], prior_angles, prior_values[:, 0])))
        prior_left = float(np.interp(left["alpha_center"], prior_angles, prior_values[:, 0]))
        prior_right = float(np.interp(right["alpha_center"], prior_angles, prior_values[:, 0]))
        prior_delta = prior_right - prior_left
        cl_values = [row["cl_value"] for row in method_groups]
        peak_index = int(np.argmax(cl_values))
        stall_like = (len(method_groups) >= 3 and 0 < peak_index < len(method_groups)-1
                      and cl_values[peak_index] - cl_values[-1] > 0.05)
        reversals.append({
            "method": method,
            "left_lineage_id": left["lineage_id"],
            "right_lineage_id": right["lineage_id"],
            "observed_cl_delta": float(observed_delta),
            "prior_cl_delta": prior_delta,
            "reversal": bool(prior_delta * observed_delta < 0 and abs(observed_delta) > 0.1 and not stall_like),
            "stall_like": stall_like,
            "related_window_count": left["window_count"] + right["window_count"],
        })
    return {"groups": diagnostics, "reversals": reversals,
            "interpretation": "diagnostic_only_related_windows_are_not_independent_confirmations"}


def observations_without_reference(source, request, reference):
    evidence = {row["attemptId"]: row for row in source["evidence"]}

    def independent(observation):
        record = evidence[observation.attempt_id]
        return record["jobId"] != reference["jobId"] and record["lineageId"] != reference["lineageId"]

    observations = [row for row in request.observations if independent(row)]
    for history in request.histories:
        if independent(history.observation):
            observations.extend(history_observations(history, request.history_policy))
    return observations


def measure_candidate_profile(source, request, candidate):
    references = [row for row in source["evidence"] if row["classification"]["state"] == "accepted"]
    if not references:
        raise ValueError("The selected source has no accepted reference")
    measurements = []
    for reference in references:
        observations = observations_without_reference(source, request, reference)
        estimate = candidate_fit(request.prior, observations, request.policy, candidate)
        measurement = curve_measurement(estimate, reference)
        measurement["contributors"] = estimate["contributors"]
        measurement["estimate_signature"] = estimate["signature"]
        predicted = np.array(measurement["mean_transformed"])
        predicted[1] = math.exp(predicted[1])
        actual = np.array([reference["payload"][name] for name in ("cl", "cd", "cm")])
        measurement["absolute_error"] = abs(predicted - actual).tolist()
        measurements.append(measurement)
    return {"profile_id": source["physical"]["airfoilId"], "model_id": source["model"]["id"],
            "references": measurements,
            "mean_absolute_error": np.mean([row["absolute_error"] for row in measurements], axis=0).tolist()}


def lift_summary(estimate):
    values = np.asarray(estimate["curves"]["composite"]["coefficients"])
    return {"cl_zero": float(np.interp(0, estimate["alpha"], values[:, 0])),
            "cl_five": float(np.interp(5, estimate["alpha"], values[:, 0])),
            "cl_twenty": float(np.interp(20, estimate["alpha"], values[:, 0])),
            "cl_range": [float(values[:, 0].min()), float(values[:, 0].max())]}


def verify_replay(replayed, stored, producer_signature=None):
    metadata = ("epoch_id", "lease_token", "request_signature")
    checks = {name: replayed[name] == stored[name] for name in metadata}
    current_transport_matches = checks["request_signature"]
    if producer_signature is not None:
        checks["request_signature"] = producer_signature == stored["request_signature"]
    for name in ("signature", "version", "target_signature", "alpha", "contributors", "excluded",
                 "branch", "best_method", "calibration_status", "validation_id", "policy_id", "prior_prediction_id"):
        checks[f"estimate.{name}"] = json.loads(json.dumps(replayed["estimate"][name])) == json.loads(json.dumps(stored["estimate"][name]))
    exact = all(checks.values())
    differences = {}
    for method, curve in stored["estimate"]["curves"].items():
        for channel in ("coefficients", "lower", "upper"):
            original = np.asarray(curve[channel])
            current = np.asarray(replayed["estimate"]["curves"][method][channel])
            if original.shape != current.shape or not np.isfinite(current).all():
                raise ValueError("Stored replay changed shape or produced nonfinite values")
            differences[f"{method}.{channel}"] = float(np.max(abs(original-current)))
    return {"exact_identity": exact, "identity_checks": checks, "max_absolute_differences": differences,
            "passed": exact and all(value <= 1e-12 for value in differences.values()),
            "absolute_tolerance": 1e-12, "current_transport_matches": current_transport_matches,
            "producer_source_sha256": PRODUCER_SHA256 if producer_signature is not None else None,
            "producer_signature": producer_signature}


def manufactured_controls(prior, policy):
    reference = np.asarray(prior.coefficients)
    angles = np.asarray(prior.alpha)
    measurements = []
    for name, selected in (("camber_offset", [0]), ("slope_change", [-3, 7]),
                           ("earlier_stall", [-3, 3, 7, 12, 18]),
                           ("large_coherent_offset", [-3, 0, 7]),
                           ("precise_overrides_wrong_fast", [-3, 7]),
                           ("repeated_bad_lineage", [-3, 7])):
        truth = reference.copy()
        if name in {"camber_offset", "precise_overrides_wrong_fast"}:
            truth[:, 0] += 0.2
        elif name == "large_coherent_offset":
            truth[:, 0] += 1.0
        elif name == "slope_change":
            truth[:, 0] += 0.03 * angles
        elif name == "earlier_stall":
            truth[:, 0] -= 0.06 * np.maximum(angles - 7, 0)
        observations = [PolarObservation(
            f"fixture-{name}-{alpha}", f"fixture-result-{name}-{alpha}", f"fixture-attempt-{name}-{alpha}",
            f"fixture-lineage-{name}-{alpha}", prior.target_signature, prior.branch, "openfoam_fast", float(alpha),
            [float(np.interp(alpha, angles, truth[:, index])) for index in range(3)],
            [0.03, 0.001, 0.005], True, "converged", "steady",
        ) for alpha in selected]
        if name == "precise_overrides_wrong_fast":
            observations = [replace(row, method="openfoam_precise", standard_error=[0.01, 0.001, 0.002])
                            for row in observations]
            observations.extend(replace(row, observation_id=f"wrong-fast-{row.observation_id}",
                                        result_id=f"wrong-fast-{row.result_id}", attempt_id=f"wrong-fast-{row.attempt_id}",
                                        lineage_id=f"wrong-fast-{row.lineage_id}", method="openfoam_fast",
                                        coefficients=[value, *row.coefficients[1:]], standard_error=[0.03,0.001,0.005])
                                for row,value in zip(list(observations), (1.5,-0.3)))
        if name == "repeated_bad_lineage":
            observations = [replace(row, observation_id=f"{row.observation_id}-window-{window}",
                                    coefficients=[value, *row.coefficients[1:]], window=(float(window),float(window+1)))
                            for row,value in zip(observations,(1.5,-0.3)) for window in range(4)]
        original_error = float(np.sqrt(np.mean((reference[:, 0] - truth[:, 0]) ** 2)))
        for candidate in CANDIDATES:
            estimate = candidate_fit(prior, observations, policy, candidate)
            predicted = np.asarray(estimate["curves"]["composite"]["coefficients"])
            error = float(np.sqrt(np.mean((predicted[:, 0] - truth[:, 0]) ** 2)))
            measurements.append({"fixture": name, "boundary": "manufactured_not_physical_validation",
                                 "candidate": candidate, "prior_cl_rmse": original_error, "candidate_cl_rmse": error,
                                 "cl_delta_zero_to_five": float(np.interp(5,angles,predicted[:,0])-np.interp(0,angles,predicted[:,0])),
                                 "improves_prior": error < original_error})
    return measurements


def assess_candidates(diagnostics, controls):
    indexed = {(row["fixture"],row["candidate"]): row for row in controls}
    verdicts = {}
    for candidate in CANDIDATES:
        original = diagnostics["original_bad_mesh_counterfactual"][candidate]
        checks = {"severe_sparse_reversal": original["cl_five"] > original["cl_zero"]}
        for name in ("camber_offset","slope_change","earlier_stall","large_coherent_offset","precise_overrides_wrong_fast"):
            checks[name] = indexed[name,candidate]["candidate_cl_rmse"] <= indexed[name,"unchanged"]["candidate_cl_rmse"]+1e-12
        repeated = indexed["repeated_bad_lineage",candidate]
        checks["repeated_bad_lineage"] = (repeated["cl_delta_zero_to_five"] > 0
            and repeated["candidate_cl_rmse"] < indexed["repeated_bad_lineage","unchanged"]["candidate_cl_rmse"])
        verdicts[candidate] = {"passes_required_controls": all(checks.values()), "checks": checks,
                               "production_ready": False}
    return verdicts


def run_study(sg_path, native_path, cohort_path, producer_path, destination):
    sg = pinned_json(sg_path, SG_SHA256)
    native = pinned_json(native_path, NATIVE_SHA256)
    cohort = pinned_json(cohort_path, PILOT_SHA256)
    destination.mkdir(parents=True, exist_ok=False)
    for name, path in (("sg6051-source.json", sg_path), ("native-source.json", native_path), ("pilot-source.json", cohort_path)):
        (destination / name).write_bytes(Path(path).read_bytes())
    manifest = sg["model"]["request"]
    if manifest["histories"]:
        raise ValueError("The pinned SG6051 diagnostic is no longer a two-anchor source")
    request = ProgressivePolarRequest.model_validate({name: value for name, value in manifest.items() if name != "kind"})
    producer_signature = producing_request_signature(request, producer_path)
    (destination / "producing-api.py").write_bytes(Path(producer_path).read_bytes())
    replay = calculate_progressive_polar(request)
    verification = verify_replay(replay, sg["model"]["response"], producer_signature)
    write_result(destination / "sg6051-replay-verification.json", verification)
    if not verification["passed"]:
        raise ValueError("The original SG6051 fit did not replay exactly")
    points = [row for row in native["outcomes"] if row["collection"] == "points"]
    if len(points) != 2 or {point["alpha"] for point in points} != {-3, 7} or not all(point["converged"] for point in points):
        raise ValueError("The corrected native comparison is incomplete")
    if native["production_evidence"] is not False or native["runtime"]["numerics_revision"] != "2":
        raise ValueError("The native diagnostic lost its separate provenance")
    native_observations = [PolarObservation(
        f"native-{native['local_job']}-{point['alpha']}", f"native-job-{native['local_job']}",
        f"native-case-{native['local_job']}-{point['alpha']}", native["local_job"],
        request.prior.target_signature, request.prior.branch, "openfoam_fast", point["alpha"],
        [point[name] for name in ("cl", "cd", "cm")], [0.03, point["cd"] * 0.03, 0.005],
        True, "converged", "steady",
    ) for point in points]
    diagnostics = {}
    for name, observations in (("original_bad_mesh_counterfactual", request.observations),
                               ("corrected_native_diagnostic", native_observations)):
        diagnostics[name] = {}
        for candidate in CANDIDATES:
            estimate = candidate_fit(request.prior, observations, request.policy, candidate)
            write_result(destination / f"{name}-{candidate}.json", estimate)
            diagnostics[name][candidate] = lift_summary(estimate)
            diagnostics[name][candidate]["grouped_conflicts"] = estimate.get("research_only", {}).get("grouped_conflicts")
    measurements, failures = {candidate: [] for candidate in CANDIDATES}, []
    sources = cohort.get("sources", [])
    if cohort.get("kind") != "retained-polar-cohort-export-v1" or len(sources) != 8 or len({row["physical"]["airfoilId"] for row in sources}) != 8:
        raise ValueError("The frozen pilot lost its eight distinct profiles")
    for source in sources:
        directory = destination / source["model"]["id"]
        directory.mkdir()
        source_path = directory / "source.json"
        source_sha = write_result(source_path, source)
        try:
            replayed_source, replayed_request, _ = replay_source(source_path, source_sha)
            for candidate in CANDIDATES:
                measurement = measure_candidate_profile(replayed_source, replayed_request, candidate)
                write_result(directory / f"{candidate}.json", measurement)
                measurements[candidate].append(measurement)
        except Exception as error:
            failures.append({"model_id": source["model"]["id"], "error": str(error)})
    controls = manufactured_controls(request.prior, request.policy)
    summary = {"kind": "sparse-mean-screening-v1", "complete": not failures, "production_policy_changed": False,
               "source_sha256": {"sg6051": SG_SHA256, "native": NATIVE_SHA256, "pilot": PILOT_SHA256,
                                 "producing_api": PRODUCER_SHA256},
               "model_tail_probability_per_method_coefficient": MODEL_TAIL_PROBABILITY,
               "conservative_conflict_cutoff": CONFLICT_CUTOFF,
               "diagnostics": diagnostics, "controls": controls,
               "candidate_acceptance": assess_candidates(diagnostics,controls),
               "cohort_mean_absolute_error": {
                   candidate: np.mean([row["mean_absolute_error"] for row in rows], axis=0).tolist() if rows else None
                   for candidate, rows in measurements.items()},
               "measurements": measurements, "failures": failures,
               "limitations": ["exploratory_regularization_not_independently_validated_for_deployment",
                               "model_tail_bound_not_physical_or_familywise_error_probability",
                               "accepted_CFD_reference_not_physical_truth", "legacy_reference_geometry_not_independently_revalidated",
                               "not_a_full_polar_reference", "existing_pilot_is_not_a_new_blind_validation_cohort",
                               "native_case_identifiers_are_diagnostic_artifact_labels_not_database_result_ids"]}
    write_result(destination / "summary.json", summary)
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sg6051", type=Path, required=True)
    parser.add_argument("--native", type=Path, required=True)
    parser.add_argument("--cohort", type=Path, required=True)
    parser.add_argument("--producing-api", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    arguments = parser.parse_args()
    summary = run_study(arguments.sg6051, arguments.native, arguments.cohort, arguments.producing_api, arguments.destination)
    print(json.dumps({name: summary[name] for name in ("complete", "diagnostics", "cohort_mean_absolute_error", "failures")}))
    raise SystemExit(0 if summary["complete"] else 1)
