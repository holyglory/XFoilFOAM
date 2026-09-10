"""Held-out measurements of conditional polar intervals, never calibration approval."""

from dataclasses import asdict, dataclass
import hashlib
import json
import math
import re

import numpy as np

from .progressive_polar import PolarModelPolicy, PolarObservation, PolarPrior, fit_progressive_polar


VALIDATION_VERSION = "heldout-polar-measurement-v1"
COEFFICIENTS = ("cl", "cd", "cm")


@dataclass(frozen=True)
class PolarReference:
    reference_id: str
    source_sha256: str
    source_kind: str
    target_signature: str
    branch: str
    alpha: list[float]
    coefficients: list[list[float | None]]
    measurement_uncertainty_known: bool


@dataclass(frozen=True)
class PolarValidationCase:
    case_id: str
    profile_signature: str
    condition_signature: str
    prior: PolarPrior
    observations: list[PolarObservation]
    reference: PolarReference


def _hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def _identity(value, name):
    if not isinstance(value, str) or not value.strip() or len(value) > 256:
        raise ValueError(f"Invalid {name}")


def _weights(angles):
    if len(angles) == 1:
        return np.ones(1)
    spacing = np.diff(angles)
    weights = np.r_[spacing[0] / 2, (spacing[:-1] + spacing[1:]) / 2, spacing[-1] / 2]
    return weights / weights.sum()


def _metrics(angles, truth, predicted, lower, upper):
    weights = _weights(angles)
    error = predicted - truth
    with np.errstate(over="ignore", invalid="ignore"):
        squared = error ** 2
    if not np.isfinite(error).all() or not np.isfinite(squared).all():
        raise ValueError("Reference error exceeds finite evaluation range")
    covered = (truth >= lower) & (truth <= upper)
    return {
        "samples": len(truth),
        "covered_samples": int(covered.sum()),
        "coverage": float(covered.mean()),
        "rmse": float(np.sqrt(np.mean(squared))),
        "mae": float(np.mean(np.abs(error))),
        "bias": float(np.mean(error)),
        "mean_interval_width": float(np.mean(upper - lower)),
        "span_weighted_coverage": float(weights @ covered),
        "span_weighted_rmse": float(np.sqrt(weights @ squared)),
        "span_weighted_mae": float(weights @ np.abs(error)),
        "span_weighted_bias": float(weights @ error),
        "span_weighted_interval_width": float(weights @ (upper - lower)),
    }


def evaluate_held_out_polars(cases, policy, *, fit_profiles, fit_conditions, split_axis):
    if split_axis not in {"profile", "condition", "profile_and_condition"}:
        raise ValueError("Unknown whole-group holdout axis")
    if not isinstance(cases, list) or not 1 <= len(cases) <= 10000:
        raise ValueError("Evaluation requires a bounded nonempty case set")
    for name, groups in (("profiles", fit_profiles), ("conditions", fit_conditions)):
        if not isinstance(groups, list):
            raise ValueError(f"Policy-fit {name} must be an explicit unique list")
        for group in groups:
            _identity(group, f"policy-fit {name}")
        if len(groups) != len(set(groups)):
            raise ValueError(f"Policy-fit {name} must be an explicit unique list")
    case_ids, targets, reference_ids = set(), set(), set()
    measured = []
    for case in sorted(cases, key=lambda value: value.case_id):
        for name in ("case_id", "profile_signature", "condition_signature"):
            _identity(getattr(case, name), name)
        if not 2 <= len(case.prior.alpha) <= 1024 or len(case.observations) > 512:
            raise ValueError("Validation case exceeds the bounded polar or observation grid")
        if case.case_id in case_ids or (case.prior.target_signature, case.prior.branch) in targets:
            raise ValueError("Duplicate held-out case or physical target")
        case_ids.add(case.case_id)
        targets.add((case.prior.target_signature, case.prior.branch))
        if split_axis in {"profile", "profile_and_condition"} and case.profile_signature in fit_profiles:
            raise ValueError("Held-out profile was used to fit the policy")
        if split_axis in {"condition", "profile_and_condition"} and case.condition_signature in fit_conditions:
            raise ValueError("Held-out condition was used to fit the policy")
        reference = case.reference
        _identity(reference.reference_id, "reference identity")
        if reference.reference_id in reference_ids:
            raise ValueError("Reference evidence is repeated across held-out cases")
        reference_ids.add(reference.reference_id)
        if not isinstance(reference.source_sha256, str) or not re.fullmatch(r"[a-f0-9]{64}", reference.source_sha256):
            raise ValueError("Reference requires its source artifact checksum")
        if reference.source_kind not in {"experimental", "accepted_cfd"} or not isinstance(reference.measurement_uncertainty_known, bool):
            raise ValueError("Reference kind or measurement-uncertainty provenance is invalid")
        if reference.target_signature != case.prior.target_signature or reference.branch != case.prior.branch:
            raise ValueError("Reference differs from the exact physical target or branch")
        used = {case.prior.prediction_id}
        for observation in case.observations:
            used.update((observation.observation_id, observation.result_id, observation.attempt_id, observation.lineage_id))
        if reference.reference_id in used:
            raise ValueError("Held-out reference was used as fitting evidence")
        angles = np.asarray(reference.alpha, dtype=float)
        if angles.ndim != 1 or len(angles) < 1 or not np.isfinite(angles).all() or np.any(np.diff(angles) <= 0):
            raise ValueError("Reference angles must be finite, unique and ordered")
        if len(reference.coefficients) != len(angles) or any(len(row) != 3 for row in reference.coefficients):
            raise ValueError("Reference coefficients must match its angle grid")
        for row in reference.coefficients:
            for index, value in enumerate(row):
                if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or (index == 1 and value <= 0)):
                    raise ValueError("Reference coefficients must be finite, with positive measured drag")
        fit = fit_progressive_polar(case.prior, case.observations, policy)
        indices = {alpha: index for index, alpha in enumerate(fit["alpha"])}
        if any(alpha not in indices for alpha in angles):
            raise ValueError("Evaluation cannot interpolate or extrapolate uncomputed reference angles")
        selected = [indices[alpha] for alpha in angles]
        curve = fit["curves"]["composite"]
        predicted, lower, upper = (np.asarray(curve[key], dtype=float)[selected] for key in ("coefficients", "lower", "upper"))
        if any(values.shape != (len(angles), 3) or not np.isfinite(values).all() for values in (predicted, lower, upper)) or np.any(lower >= upper):
            raise ValueError("Fitted intervals must have finite positive widths")
        metrics = {}
        for index, name in enumerate(COEFFICIENTS):
            available = [row[index] is not None for row in reference.coefficients]
            truth = np.array([row[index] for row in reference.coefficients if row[index] is not None], dtype=float)
            metrics[name] = None if not len(truth) else _metrics(angles[available], truth, predicted[available, index], lower[available, index], upper[available, index])
        if all(value is None for value in metrics.values()):
            raise ValueError("Held-out reference contains no measured coefficients")
        measured.append({"case_id": case.case_id, "profile_signature": case.profile_signature, "condition_signature": case.condition_signature,
                         "target_signature": reference.target_signature, "branch": reference.branch, "reference_id": reference.reference_id,
                         "source_sha256": reference.source_sha256, "source_kind": reference.source_kind,
                         "measurement_uncertainty_known": reference.measurement_uncertainty_known,
                         "fit_signature": fit["signature"], "reference_alpha_range": [float(angles[0]), float(angles[-1])], "metrics": metrics})
    macro = {}
    for name in COEFFICIENTS:
        values = [case["metrics"][name] for case in measured if case["metrics"][name] is not None]
        macro[name] = None if not values else {
            "cases": len(values), "samples": sum(value["samples"] for value in values),
            "coverage": float(np.mean([value["coverage"] for value in values])),
            "rmse": float(np.sqrt(np.mean([value["rmse"] ** 2 for value in values]))),
            "mae": float(np.mean([value["mae"] for value in values])),
            "bias": float(np.mean([value["bias"] for value in values])),
            "mean_interval_width": float(np.mean([value["mean_interval_width"] for value in values])),
        }
    source = {"version": VALIDATION_VERSION, "policy": asdict(policy), "cases": [asdict(case) for case in sorted(cases, key=lambda value: value.case_id)],
              "fit_profiles": sorted(fit_profiles), "fit_conditions": sorted(fit_conditions), "split_axis": split_axis}
    return {"version": VALIDATION_VERSION, "input_signature": _hash(source), "policy_id": policy.policy_id,
            "policy_signature": _hash(asdict(policy)), "split_axis": split_axis, "interval_probability": 0.95,
            "aggregation": "equal_case_not_sample_count", "reference_integrity": "source_loader_verification_required",
            "holdout_scope": "policy_fitting_not_surrogate_pretraining",
            "calibration_status": "unvalidated", "acceptance_verdict": "not_evaluated",
            "validation_id": None, "case_count": len(measured), "cases": measured, "macro_metrics": macro}
