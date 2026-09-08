"""Reduce real histories into correlated observations, not extra CFD solves."""

from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import json
from typing import Literal

import numpy as np

from .progressive_polar import PolarObservation, _matrix


@dataclass(frozen=True)
class PolarHistory:
    observation: PolarObservation
    artifact_sha256: str
    coordinate_kind: Literal["physical_time", "iteration"]
    coordinate: list[float]
    coefficients: list[list[float]]
    informative_start: float
    correlation_time: float | None
    correlation_evidence_id: str | None


@dataclass(frozen=True)
class HistoryReductionPolicy:
    block_duration: float
    minimum_samples: int
    noise_floor: list[float]
    maximum_blocks: int | None = None


def _weighted_statistics(coordinate: np.ndarray, coefficients: np.ndarray):
    steps = np.diff(coordinate)
    duration = float(coordinate[-1] - coordinate[0])
    weights = np.zeros(len(coordinate))
    weights[:-1] += steps / 2
    weights[1:] += steps / 2
    weights /= duration
    mean = np.sum(coefficients * weights[:, None], axis=0)
    variance = np.sum((coefficients - mean) ** 2 * weights[:, None], axis=0)
    center = np.sum(coordinate * weights)
    spread = np.sum((coordinate - center) ** 2 * weights)
    slope = np.sum((coordinate - center)[:, None] * (coefficients - mean) * weights[:, None], axis=0) / spread
    drift = abs(slope) * duration
    return mean, variance, drift, float(1 / np.sum(weights ** 2))


def history_observations(history: PolarHistory, policy: HistoryReductionPolicy) -> list[PolarObservation]:
    coordinates = np.asarray(history.coordinate, dtype=float)
    if (coordinates.ndim != 1 or len(coordinates) < 2 or not np.all(np.isfinite(coordinates))
            or np.any(np.diff(coordinates) <= 0)):
        raise ValueError("History coordinates must be real, finite and strictly increasing")
    coefficients = _matrix(history.coefficients, (len(coordinates), 3), "history coefficients")
    if np.any(coefficients[:, 1] <= 0):
        raise ValueError("Nonphysical history drag")
    floor = _matrix(policy.noise_floor, (3,), "history noise floor", True)
    if (not np.isfinite(policy.block_duration) or policy.block_duration <= 0
            or isinstance(policy.minimum_samples, bool) or not isinstance(policy.minimum_samples, int)
            or policy.minimum_samples < 4
            or (policy.maximum_blocks is not None and (
                isinstance(policy.maximum_blocks, bool) or not isinstance(policy.maximum_blocks, int)
                or not 1 <= policy.maximum_blocks <= 128))):
        raise ValueError("Invalid history reduction policy")
    if history.coordinate_kind not in {"physical_time", "iteration"}:
        raise ValueError("Unknown history coordinate kind")
    if not np.isfinite(history.informative_start) or history.informative_start < coordinates[0]:
        raise ValueError("An informative window must identify the real retained history")
    if (len(history.artifact_sha256) != 64
            or any(character not in "0123456789abcdef" for character in history.artifact_sha256)):
        raise ValueError("History observations require an immutable source artifact checksum")
    if history.correlation_time is not None and (
        not np.isfinite(history.correlation_time) or history.correlation_time <= 0 or not history.correlation_evidence_id
    ):
        raise ValueError("A measured correlation time requires its evidence identity")
    source = history.observation
    if not source.eligible or source.exclusion_reason:
        return [source]
    if source.numerical_convergence in {"diverged", "corrupt", "nonphysical"}:
        raise ValueError("Rejected history must not be reduced into eligible blocks")
    if source.statistical_certification in {"startup_only", "corrupt"}:
        raise ValueError("Startup-only history has no informative blocks")
    selected = np.flatnonzero(coordinates >= history.informative_start)
    if len(selected) < policy.minimum_samples:
        return [replace(source, eligible=False, exclusion_reason="insufficient_informative_history")]
    start = int(selected[0])
    blocks = []
    while start < len(coordinates) - 1:
        if (history.coordinate_kind == "iteration"
                or (policy.maximum_blocks is not None and len(blocks) + 1 == policy.maximum_blocks)):
            stop = len(coordinates) - 1
        else:
            stop = int(np.searchsorted(coordinates, coordinates[start] + policy.block_duration, side="right") - 1)
            stop = min(stop, len(coordinates) - 1)
            if policy.maximum_blocks is not None:
                stop = min(max(stop, start + policy.minimum_samples - 1), len(coordinates) - 1)
                if len(coordinates) - stop < policy.minimum_samples:
                    stop = len(coordinates) - 1
        if stop - start + 1 < policy.minimum_samples:
            break
        window_coordinates = coordinates[start:stop + 1]
        mean, variance, drift, sampling_count = _weighted_statistics(window_coordinates, coefficients[start:stop + 1])
        duration = float(window_coordinates[-1] - window_coordinates[0])
        if history.coordinate_kind == "physical_time" and history.correlation_time is not None:
            effective_count = max(1.0, min(sampling_count, duration / (2 * history.correlation_time)))
        else:
            effective_count = 1.0
        uncertainty = np.sqrt(variance / effective_count + drift ** 2 + floor ** 2)
        payload = {"artifact": history.artifact_sha256, "start": float(window_coordinates[0]),
                   "end": float(window_coordinates[-1]), "coordinate_kind": history.coordinate_kind,
                   "result_id": source.result_id, "attempt_id": source.attempt_id,
                   "correlation_evidence_id": history.correlation_evidence_id}
        identity = hashlib.sha256(json.dumps(payload, sort_keys=True, allow_nan=False).encode()).hexdigest()
        blocks.append(replace(
            source, observation_id="history-block-" + identity, coefficients=mean.tolist(),
            standard_error=uncertainty.tolist(),
            window=(float(window_coordinates[0]), float(window_coordinates[-1]))
            if history.coordinate_kind == "physical_time" else None,
            statistical_certification=source.statistical_certification
            if history.coordinate_kind == "physical_time" else "numerical_iterations_only",
        ))
        start = stop
    return blocks or [replace(source, eligible=False, exclusion_reason="insufficient_history_block_duration")]
