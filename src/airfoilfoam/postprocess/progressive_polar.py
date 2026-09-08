"""Joint, evidence-derived multi-fidelity estimates; never solver-result rows."""

from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
import json
from typing import Literal

import numpy as np


MODEL_VERSION = "progressive-polar-gp-v2"
ACQUISITION_VERSION = "fixed-posterior-coverage-v1"
Method = Literal["openfoam_fast", "openfoam_precise"]


@dataclass(frozen=True)
class PolarPrior:
    target_signature: str
    prediction_id: str
    branch: str
    alpha: list[float]
    coefficients: list[list[float]]
    standard_deviation: list[list[float]]
    provenance: dict


@dataclass(frozen=True)
class PolarObservation:
    observation_id: str
    result_id: str
    attempt_id: str
    lineage_id: str
    target_signature: str
    branch: str
    method: Method
    alpha: float
    coefficients: list[float] | None
    standard_error: list[float] | None
    eligible: bool
    numerical_convergence: str
    statistical_certification: str
    exclusion_reason: str | None = None
    window: tuple[float, float] | None = None


@dataclass(frozen=True)
class PolarModelPolicy:
    """Discrepancies and noise floors use coefficient order Cl, log(Cd), Cm."""

    policy_id: str
    fast_discrepancy_std: list[float]
    precise_discrepancy_std: list[float]
    slope_std: list[float]
    local_std: list[float]
    fast_noise_floor: list[float]
    precise_noise_floor: list[float]
    correlation_length_deg: float
    lineage_correlation: float
    calibration_status: Literal["unvalidated", "validated"]
    validation_id: str | None = None


def _matrix(values, shape, name: str, positive: bool = False) -> np.ndarray:
    array = np.asarray(values, dtype=float)
    if array.shape != shape or not np.all(np.isfinite(array)):
        raise ValueError(f"Invalid {name}")
    if positive and np.any(array <= 0):
        raise ValueError(f"{name} must be positive")
    return array


def _validate(prior: PolarPrior, observations: list[PolarObservation], policy: PolarModelPolicy):
    angles = np.asarray(prior.alpha, dtype=float)
    if (angles.ndim != 1 or len(angles) < 2 or not np.all(np.isfinite(angles))
            or np.any(np.diff(angles) <= 0)):
        raise ValueError("Prior angles must be finite, distinct and increasing")
    coefficients = _matrix(prior.coefficients, (len(angles), 3), "prior coefficients")
    standard_deviation = _matrix(prior.standard_deviation, coefficients.shape, "prior uncertainty", True)
    if np.any(coefficients[:, 1] <= 0):
        raise ValueError("Prior drag must be positive")
    if not prior.target_signature or not prior.prediction_id or not prior.branch or not prior.provenance:
        raise ValueError("A prior requires physical identity and real prediction provenance")
    for name in ("fast_discrepancy_std", "precise_discrepancy_std", "slope_std", "local_std",
                 "fast_noise_floor", "precise_noise_floor"):
        _matrix(getattr(policy, name), (3,), name, True)
    if (not np.isfinite(policy.correlation_length_deg) or policy.correlation_length_deg <= 0
            or not np.isfinite(policy.lineage_correlation) or not 0 <= policy.lineage_correlation <= 1):
        raise ValueError("Invalid correlation policy")
    if policy.calibration_status not in {"unvalidated", "validated"}:
        raise ValueError("Unknown calibration status")
    if policy.calibration_status == "validated" and not policy.validation_id:
        raise ValueError("Validated uncertainty requires a validation evidence identifier")
    if not policy.policy_id:
        raise ValueError("A model policy needs an immutable identity")
    eligible = []
    excluded = []
    identifiers = set()
    intervals: dict[tuple, list[tuple[float, float] | None]] = {}
    for observation in sorted(observations, key=lambda row: row.observation_id):
        if not all((observation.observation_id, observation.result_id, observation.attempt_id, observation.lineage_id)):
            raise ValueError("Every observation requires exact evidence and lineage identities")
        if observation.observation_id in identifiers:
            raise ValueError("Duplicate observation identity")
        identifiers.add(observation.observation_id)
        if not observation.eligible:
            if not observation.exclusion_reason:
                raise ValueError("Excluded observations need an explanation")
            excluded.append({"observation_id": observation.observation_id, "reason": observation.exclusion_reason})
            continue
        if observation.exclusion_reason:
            raise ValueError("Excluded evidence cannot inform an estimate")
        if observation.target_signature != prior.target_signature or observation.branch != prior.branch:
            raise ValueError("Cannot fuse incompatible physical targets or hysteresis branches")
        if observation.method not in {"openfoam_fast", "openfoam_precise"}:
            raise ValueError("Unknown fidelity")
        if observation.numerical_convergence in {"diverged", "corrupt", "nonphysical"}:
            raise ValueError("Divergent, corrupt or nonphysical evidence cannot inform a polar")
        if observation.statistical_certification in {"startup_only", "corrupt"}:
            raise ValueError("Startup-only or corrupt history cannot inform a polar")
        values = _matrix(observation.coefficients, (3,), "observed coefficients")
        _matrix(observation.standard_error, (3,), "observation uncertainty", True)
        if values[1] <= 0 or not np.isfinite(observation.alpha):
            raise ValueError("Nonphysical observation")
        if not angles[0] <= observation.alpha <= angles[-1]:
            raise ValueError("Observation lies outside the prior domain")
        key = (observation.lineage_id, observation.method, observation.alpha)
        if observation.window is not None:
            start, end = observation.window
            if not np.isfinite(start) or not np.isfinite(end) or start >= end:
                raise ValueError("Invalid history window")
        for previous in intervals.get(key, []):
            if previous is None or observation.window is None:
                raise ValueError("Repeated lineage evidence needs disjoint physical-time windows")
            if max(previous[0], observation.window[0]) < min(previous[1], observation.window[1]):
                raise ValueError("Overlapping continuation histories would double-count evidence")
        intervals.setdefault(key, []).append(observation.window)
        eligible.append(observation)
    return angles, coefficients, standard_deviation, eligible, excluded


def _transformed(values: np.ndarray, uncertainty: np.ndarray):
    transformed = values.copy()
    transformed[:, 1] = np.log(values[:, 1])
    deviations = uncertainty.copy()
    deviations[:, 1] = np.sqrt(np.log1p((uncertainty[:, 1] / values[:, 1]) ** 2))
    return transformed, deviations


def _acquisition_reduction(angles, current_variance, posterior_cross, candidate_variance, noise_variance,
                           coverage_reduction):
    spacing = np.diff(angles)
    weights = np.concatenate(([spacing[0] / 2], (spacing[:-1] + spacing[1:]) / 2, [spacing[-1] / 2]))
    denominator = float(weights @ current_variance)
    if not np.isfinite(denominator) or denominator <= 0 or noise_variance <= 0:
        raise ValueError("Acquisition requires positive finite uncertainty and prospective noise")
    covariance_reduction = posterior_cross ** 2 / (candidate_variance[None, :] + noise_variance)
    covariance = weights @ covariance_reduction / denominator
    coverage = weights @ coverage_reduction / denominator
    total = covariance + coverage
    if not np.all(np.isfinite(total)) or np.any(total < -1e-8) or np.any(total > 1 + 1e-8):
        raise ValueError("Acquisition reduction exceeds the current fitted uncertainty")
    return np.clip(covariance, 0, 1), np.clip(coverage, 0, 1)


def fit_progressive_polar(prior: PolarPrior, observations: list[PolarObservation], policy: PolarModelPolicy) -> dict:
    angles, coefficients, uncertainty, eligible, excluded = _validate(prior, observations, policy)
    prior_mean, prior_std = _transformed(coefficients, uncertainty)
    serialized = json.dumps({"version": MODEL_VERSION, "prior": asdict(prior), "policy": asdict(policy),
                             "observations": [asdict(row) for row in sorted(observations, key=lambda row: row.observation_id)]},
                            sort_keys=True, separators=(",", ":"), allow_nan=False)
    signature = hashlib.sha256(serialized.encode()).hexdigest()
    means = {method: prior_mean.copy() for method in ("openfoam_fast", "openfoam_precise")}
    variances = {method: prior_std ** 2 for method in means}
    diagnostics = []
    acquisition_covariance = np.zeros((len(angles), 3))
    acquisition_coverage = np.zeros((len(angles), 3))
    acquisition_noise = []
    if eligible:
        observed_angles = np.array([row.alpha for row in eligible])
        observed_values, observed_errors = _transformed(
            np.array([row.coefficients for row in eligible]),
            np.array([row.standard_error for row in eligible]),
        )
        precise = np.array([row.method == "openfoam_precise" for row in eligible], dtype=float)
        lineage = np.array([[left.lineage_id == right.lineage_id for right in eligible] for left in eligible])
        noise_floors = np.array([policy.precise_noise_floor if row.method == "openfoam_precise"
                                 else policy.fast_noise_floor for row in eligible])
        for coefficient in range(3):
            reference = np.interp(observed_angles, angles, prior_mean[:, coefficient])
            residuals = observed_values[:, coefficient] - reference

            def kernel(left, right, method):
                contributing = observed_angles if method == "fast" else observed_angles[precise == 1]
                center = float(np.mean(np.unique(contributing))) if len(contributing) else float(np.mean(angles))
                scale = max(float(angles[-1] - angles[0]), policy.correlation_length_deg)
                amplitude = (policy.fast_discrepancy_std if method == "fast"
                             else policy.precise_discrepancy_std)[coefficient]
                covariance = np.full((len(left), len(right)), amplitude ** 2)
                covariance += policy.slope_std[coefficient] ** 2 * np.outer((left - center) / scale, (right - center) / scale)
                if len(np.unique(contributing)) >= 3:
                    distance = (left[:, None] - right[None, :]) / policy.correlation_length_deg
                    covariance += policy.local_std[coefficient] ** 2 * np.exp(-0.5 * distance ** 2)
                return covariance

            data_covariance = kernel(observed_angles, observed_angles, "fast")
            data_covariance += kernel(observed_angles, observed_angles, "precise") * np.outer(precise, precise)
            noise_std = np.maximum(observed_errors[:, coefficient], noise_floors[:, coefficient])
            noise_covariance = policy.lineage_correlation * np.outer(noise_std, noise_std) * lineage
            noise_covariance += np.diag((1 - policy.lineage_correlation) * noise_std ** 2)
            data_covariance += noise_covariance
            jitter = max(float(np.max(np.diag(data_covariance))), 1.0) * 1e-10
            data_covariance += np.eye(len(eligible)) * jitter
            cholesky = np.linalg.cholesky(data_covariance)
            solved = np.linalg.solve(cholesky.T, np.linalg.solve(cholesky, residuals))
            inverse_diagonal = np.sum(np.linalg.solve(cholesky, np.eye(len(eligible))) ** 2, axis=0)
            disagreement = max(1.0, float(np.mean(solved ** 2 / inverse_diagonal)))
            diagnostics.append({"coefficient": ("cl", "log_cd", "cm")[coefficient],
                                "disagreement_variance_multiplier": disagreement})
            fast_cross = kernel(angles, observed_angles, "fast")
            fast_projection = np.linalg.solve(cholesky, fast_cross.T)
            fast_covariance = kernel(angles, angles, "fast")
            fast_conditional_variance = np.maximum(np.diag(fast_covariance) - np.sum(fast_projection ** 2, axis=0), 0)
            fast_errors = noise_std[precise == 0]
            prospective_noise = max(policy.fast_noise_floor[coefficient], float(np.median(fast_errors)) if len(fast_errors) else 0)
            acquisition_noise.append(prospective_noise)
            for method in means:
                cross = kernel(angles, observed_angles, "fast")
                prediction_covariance = kernel(angles, angles, "fast")
                if method == "openfoam_precise":
                    cross += kernel(angles, observed_angles, "precise") * precise[None, :]
                    prediction_covariance += kernel(angles, angles, "precise")
                projected = np.linalg.solve(cholesky, cross.T)
                means[method][:, coefficient] += cross @ solved
                conditional_variance = np.maximum(np.diag(prediction_covariance) - np.sum(projected ** 2, axis=0), 0)
                nearest = np.min(abs(angles[:, None] - observed_angles[None, :]), axis=1)
                unsupported = 1 - np.exp(-(nearest / policy.correlation_length_deg) ** 2)
                variances[method][:, coefficient] = disagreement * (
                    conditional_variance + prior_std[:, coefficient] ** 2 * unsupported
                )
                if method == "openfoam_precise":
                    posterior_cross = fast_covariance - projected.T @ fast_projection
                    next_nearest = np.minimum(nearest[:, None], np.abs(angles[:, None] - angles[None, :]))
                    next_unsupported = 1 - np.exp(-(next_nearest / policy.correlation_length_deg) ** 2)
                    coverage_reduction = prior_std[:, coefficient, None] ** 2 * (unsupported[:, None] - next_unsupported)
                    covariance_score, coverage_score = _acquisition_reduction(
                        angles, variances[method][:, coefficient] / disagreement, posterior_cross,
                        fast_conditional_variance, prospective_noise ** 2, coverage_reduction,
                    )
                    acquisition_covariance[:, coefficient] = covariance_score
                    acquisition_coverage[:, coefficient] = coverage_score
    curves = {}
    for method in means:
        sigma = np.sqrt(variances[method])
        central = means[method].copy()
        lower = means[method] - 1.96 * sigma
        upper = means[method] + 1.96 * sigma
        with np.errstate(over="raise", invalid="raise"):
            for values in (central, lower, upper):
                values[:, 1] = np.exp(values[:, 1])
        if not all(np.all(np.isfinite(values)) for values in (central, lower, upper)):
            raise ValueError("Posterior is not finite; no publishable estimate")
        curves[method] = {"coefficients": central.tolist(), "lower": lower.tolist(), "upper": upper.tolist()}
    methods_present = {row.method for row in eligible}
    best_method = ("openfoam_precise" if "openfoam_precise" in methods_present
                   else "openfoam_fast" if methods_present else "neuralfoil")
    displayed_curves = {"composite": curves["openfoam_precise"]}
    for method in methods_present:
        displayed_curves[method] = curves[method]
    return {
        "version": MODEL_VERSION, "signature": signature, "kind": "estimate",
        "target_signature": prior.target_signature, "branch": prior.branch, "alpha": angles.tolist(),
        "prior_prediction_id": prior.prediction_id, "policy_id": policy.policy_id,
        "calibration_status": policy.calibration_status, "validation_id": policy.validation_id,
        "interval": {"probability": 0.95, "interpretation": "conditional_model_uncertainty"},
        "curves": displayed_curves, "best_method": best_method,
        "contributors": [{"observation_id": row.observation_id, "result_id": row.result_id,
                          "attempt_id": row.attempt_id, "method": row.method, "window": row.window,
                          "numerical_convergence": row.numerical_convergence,
                          "statistical_certification": row.statistical_certification} for row in eligible],
        "excluded": excluded, "diagnostics": diagnostics,
        "acquisition": {
            "version": ACQUISITION_VERSION, "method": "openfoam_fast",
            "status": "available" if eligible else "no_eligible_cfd",
            "noise_assumption": "policy_floor_or_median_fast_observation",
            "prospective_noise_std": acquisition_noise if eligible else None,
            "candidates": [{
                "alpha": float(alpha),
                "integrated_variance_reduction_fraction": float(np.mean(acquisition_covariance[index] + acquisition_coverage[index])),
                "covariance_reduction_fraction": acquisition_covariance[index].tolist(),
                "coverage_reduction_fraction": acquisition_coverage[index].tolist(),
            } for index, alpha in enumerate(angles) if eligible and alpha not in observed_angles],
        },
    }
