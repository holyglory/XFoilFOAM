import math

import numpy as np

def gaussian_tail_cutoff(dimension, probability):
    if not isinstance(dimension, int) or dimension < 1 or not 0 < probability < 1:
        raise ValueError("A positive dimension and model tail probability are required")
    parameter = -math.log(probability)
    return dimension + 2 * math.sqrt(dimension * parameter) + 2 * parameter


def conditional_group(covariance, residual, indices):
    covariance = np.asarray(covariance, dtype=float)
    residual = np.asarray(residual, dtype=float)
    indices = np.asarray(indices, dtype=int)
    if (covariance.shape != (len(residual), len(residual)) or not np.isfinite(covariance).all()
            or not np.isfinite(residual).all() or not len(indices) or len(set(indices)) != len(indices)
            or indices.min() < 0 or indices.max() >= len(residual)
            or not np.allclose(covariance, covariance.T, atol=1e-12, rtol=1e-12)):
        raise ValueError("Invalid conditional group covariance or scope")
    complement = np.array([index for index in range(len(residual)) if index not in indices], dtype=int)
    group_covariance = covariance[np.ix_(indices, indices)].copy()
    group_residual = residual[indices].copy()
    if len(complement):
        cross = covariance[np.ix_(indices, complement)]
        factor = np.linalg.cholesky(covariance[np.ix_(complement, complement)])
        projection = np.linalg.solve(factor, cross.T)
        group_covariance -= projection.T @ projection
        group_residual -= projection.T @ np.linalg.solve(factor, residual[complement])
    return group_residual, (group_covariance + group_covariance.T) / 2


def group_subspace_scores(residual, covariance, angles, probability):
    residual = np.asarray(residual, dtype=float)
    covariance = np.asarray(covariance, dtype=float)
    angles = np.asarray(angles, dtype=float)
    if (residual.ndim != 1 or angles.shape != residual.shape or not len(angles)
            or covariance.shape != (len(angles), len(angles))
            or not all(np.isfinite(value).all() for value in (residual, covariance, angles))):
        raise ValueError("Invalid group subspace input")
    unique_angles = np.unique(angles)
    averaging = np.array([(angles == angle) / np.count_nonzero(angles == angle) for angle in unique_angles])
    mean_residual = averaging @ residual
    mean_covariance = averaging @ covariance @ averaging.T
    mean_whitened = np.linalg.solve(np.linalg.cholesky(mean_covariance), mean_residual)
    whitened = np.linalg.solve(np.linalg.cholesky(covariance), residual)
    total = float(whitened @ whitened)
    mean_score = float(mean_whitened @ mean_whitened)
    contrast = total - mean_score
    if contrast < -1e-8 * max(1, total):
        raise ValueError("Group projection violates the covariance decomposition")
    mean_dimension = len(unique_angles)
    contrast_dimension = len(angles) - mean_dimension
    mean_cutoff = gaussian_tail_cutoff(mean_dimension, probability)
    contrast_cutoff = gaussian_tail_cutoff(contrast_dimension, probability) if contrast_dimension else None
    contrast_score = max(0, contrast) if contrast_dimension else 0.0
    multiplier = max(0.0, mean_score / mean_cutoff - 1,
                     contrast_score / contrast_cutoff - 1 if contrast_cutoff else 0.0)
    return {"mean_score": mean_score, "mean_dimension": mean_dimension, "mean_cutoff": mean_cutoff,
            "contrast_score": contrast_score, "contrast_dimension": contrast_dimension,
            "contrast_cutoff": contrast_cutoff, "variance_multiplier": multiplier,
            "total_score": total}


def method_moments(prior, observations, policy):
    from .progressive_polar import _transformed, _validate

    angles, coefficients, uncertainty, eligible, _ = _validate(prior, observations, policy)
    if not eligible or len(eligible) > 128 or len({row.method for row in eligible}) != 1:
        raise ValueError("A bounded single-method observation set is required")
    prior_mean, _ = _transformed(coefficients, uncertainty)
    values, errors = _transformed(np.array([row.coefficients for row in eligible]),
                                  np.array([row.standard_error for row in eligible]))
    method = eligible[0].method
    observed_angles = np.array([row.alpha for row in eligible])
    center = float(np.mean(np.unique(observed_angles)))
    scale = max(float(angles[-1] - angles[0]), policy.correlation_length_deg)
    normalized = (observed_angles - center) / scale
    distance = (observed_angles[:, None] - observed_angles[None, :]) / policy.correlation_length_deg
    lineage = np.array([[left.lineage_id == right.lineage_id for right in eligible] for left in eligible])
    if policy.uncertified_fast_bias_std is not None:
        uncertain = np.array([row.method == "openfoam_fast" and row.accepted_cfd is False
                              and row.statistical_certification not in {"steady", "periodic", "aperiodic"}
                              for row in eligible])
        errors = np.hypot(errors, uncertain[:, None] * np.asarray(policy.uncertified_fast_bias_std))
    moments = []
    for coefficient in range(3):
        covariance = np.zeros((len(eligible), len(eligible)))
        amplitudes = [policy.fast_discrepancy_std[coefficient]]
        if method == "openfoam_precise":
            amplitudes.append(policy.precise_discrepancy_std[coefficient])
        for amplitude in amplitudes:
            covariance += amplitude ** 2 + policy.slope_std[coefficient] ** 2 * np.outer(normalized, normalized)
            if len(np.unique(observed_angles)) >= 3:
                covariance += policy.local_std[coefficient] ** 2 * np.exp(-0.5 * distance ** 2)
        floors = policy.precise_noise_floor if method == "openfoam_precise" else policy.fast_noise_floor
        noise = np.maximum(errors[:, coefficient], floors[coefficient])
        covariance += policy.lineage_correlation * np.outer(noise, noise) * lineage
        covariance += np.diag((1 - policy.lineage_correlation) * noise ** 2)
        covariance += np.eye(len(eligible)) * max(float(np.max(np.diag(covariance))), 1.0) * 1e-10
        residual = values[:, coefficient] - np.interp(observed_angles, angles, prior_mean[:, coefficient])
        moments.append((covariance, residual))
    return eligible, moments


def grouped_covariance_diagnostics(prior, observations, policy, probability=0.01):
    from .progressive_polar import _validate

    _, _, _, eligible, _ = _validate(prior, observations, policy)
    if len(eligible) > 128 or not 0 < probability < 1:
        raise ValueError("Invalid bounded group diagnostic request")
    groups = sorted({(row.method, row.lineage_id) for row in eligible})
    per_test_probability = probability / (6 * max(1, len(groups)))
    prepared = {method: method_moments(prior, [row for row in eligible if row.method == method], policy)
                for method in sorted({row.method for row in eligible})}
    diagnostics = []
    for method, lineage_id in groups:
        rows, moments = prepared[method]
        indices = np.array([index for index, row in enumerate(rows) if row.lineage_id == lineage_id])
        group_angles = [rows[index].alpha for index in indices]
        coefficients = []
        for name, (covariance, residual) in zip(("cl", "log_cd", "cm"), moments):
            conditional_residual, conditional_covariance = conditional_group(covariance, residual, indices)
            coefficients.append({"coefficient": name, **group_subspace_scores(
                conditional_residual, conditional_covariance, group_angles, per_test_probability)})
        diagnostics.append({"method": method, "lineage_id": lineage_id, "window_count": len(indices),
                            "observation_ids": [rows[index].observation_id for index in indices],
                            "alpha": group_angles, "coefficients": coefficients})
    return {"version": "conditional-lineage-subspaces-v1", "groups": diagnostics,
            "model_family_tail_probability": probability, "per_test_tail_probability": per_test_probability,
            "interpretation": "fixed_gaussian_model_not_physical_validation"}


def shared_discrepancy_covariance(observations, diagnostics, policy):
    covariance = np.zeros((3, len(observations), len(observations)))
    indexed = {row.observation_id: index for index, row in enumerate(observations)}
    for group in diagnostics["groups"]:
        indices = [indexed[identity] for identity in group["observation_ids"]]
        angles = np.asarray(group["alpha"])
        shared = angles[:, None] == angles[None, :]
        scale = policy.fast_discrepancy_std if group["method"] == "openfoam_fast" else policy.precise_discrepancy_std
        for coefficient, channel in enumerate(group["coefficients"]):
            mean_excess = max(0.0, channel["mean_score"] / channel["mean_dimension"] - 1) \
                if channel["mean_score"] > channel["mean_cutoff"] else 0.0
            contrast_excess = max(0.0, channel["contrast_score"] / channel["contrast_dimension"] - 1) \
                if channel["contrast_cutoff"] and channel["contrast_score"] > channel["contrast_cutoff"] else 0.0
            channel["shared_variance"] = mean_excess * scale[coefficient] ** 2
            channel["independent_variance"] = contrast_excess * scale[coefficient] ** 2
            covariance[coefficient][np.ix_(indices, indices)] += (
                shared * channel["shared_variance"] + np.eye(len(indices)) * channel["independent_variance"])
    return covariance
