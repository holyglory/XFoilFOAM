"""Versioned statistical-mean certification for non-periodic URANS evidence."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from typing import Sequence

import numpy as np

from ..models import (
    APERIODIC_MEAN_CERTIFICATE_VERSION,
    AperiodicMeanCertificate,
    AperiodicMeanChannelCertificate,
    AperiodicMeanPeriodicityAssessment,
    AperiodicMeanThresholds,
)


APERIODIC_MIN_SOURCE_SAMPLES = 400
APERIODIC_MIN_FIELD_FRAMES = 40
APERIODIC_MIN_CONVECTIVE_TIMES = 4.0
APERIODIC_MIN_PERIODICITY_CYCLES = 6
APERIODIC_MIN_NONREPEATABLE_FRACTION = 0.5
APERIODIC_MAX_SOURCE_GAP_FRACTION = 0.10
APERIODIC_BLOCK_COUNT = 10
APERIODIC_MIN_EFFECTIVE_BLOCKS = 3.0
APERIODIC_MAX_CI95_FRACTION = 0.04
APERIODIC_MAX_TREND_FRACTION = 0.06
APERIODIC_MAX_HALF_DRIFT_FRACTION = 0.06
APERIODIC_MAX_AMPLITUDE_GROWTH = 1.35
APERIODIC_CM_TOLERANCE_MULTIPLIER = 2.0
APERIODIC_RESAMPLED_MIN = 800
APERIODIC_RESAMPLED_MAX = 4000
APERIODIC_ABSOLUTE_FLOORS = {"cl": 0.02, "cd": 0.002, "cm": 0.01}


@dataclass(frozen=True)
class AperiodicMeanReduction:
    certificate: AperiodicMeanCertificate | None
    reasons: tuple[str, ...]
    observed_convective_times: float | None = None
    additional_convective_times: float | None = None


def _canonical_input_sha256(
    *,
    t: np.ndarray,
    cl: np.ndarray,
    cd: np.ndarray,
    cm: np.ndarray,
    speed: float,
    chord: float,
    field_frame_count: int,
    prior_diagnostic: str,
    candidate_period_s: float,
    periodicity_cycles_observed: int,
    periodicity_nonrepeatable_cycles: int,
) -> str:
    payload = {
        "reducer_version": APERIODIC_MEAN_CERTIFICATE_VERSION,
        "t": t.tolist(),
        "cl": cl.tolist(),
        "cd": cd.tolist(),
        "cm": cm.tolist(),
        "speed": speed,
        "chord": chord,
        "field_frame_count": field_frame_count,
        "prior_diagnostic": prior_diagnostic,
        "candidate_period_s": candidate_period_s,
        "periodicity_cycles_observed": periodicity_cycles_observed,
        "periodicity_nonrepeatable_cycles": periodicity_nonrepeatable_cycles,
    }
    encoded = json.dumps(
        payload,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _channel_certificate(
    t: np.ndarray,
    values: np.ndarray,
    *,
    absolute_floor: float,
) -> AperiodicMeanChannelCertificate:
    edges = np.linspace(float(t[0]), float(t[-1]), APERIODIC_BLOCK_COUNT + 1)
    means: list[float] = []
    standard_deviations: list[float] = []
    for index in range(APERIODIC_BLOCK_COUNT):
        left = edges[index]
        right = edges[index + 1]
        mask = (t >= left) & (
            t <= right if index == APERIODIC_BLOCK_COUNT - 1 else t < right
        )
        block_t = t[mask]
        block_values = values[mask]
        duration = float(block_t[-1] - block_t[0])
        means.append(float(np.trapezoid(block_values, block_t) / duration))
        standard_deviations.append(float(np.std(block_values)))

    block_means = np.asarray(means, dtype=float)
    mean = float(np.mean(block_means))
    standard_deviation = float(np.std(values))
    scale = max(abs(mean), standard_deviation, absolute_floor)
    x = np.arange(APERIODIC_BLOCK_COUNT, dtype=float)
    slope = float(np.polyfit(x, block_means, 1)[0])
    centered = block_means - mean
    denominator = float(np.dot(centered, centered))
    rho = (
        float(np.dot(centered[:-1], centered[1:]) / denominator)
        if denominator > 0
        else 0.0
    )
    rho = max(-0.9, min(0.9, rho))
    effective_blocks = max(
        1.0,
        min(
            float(APERIODIC_BLOCK_COUNT),
            APERIODIC_BLOCK_COUNT * (1.0 - rho) / (1.0 + rho),
        ),
    )
    ci95_half_width = (
        1.96 * float(np.std(block_means, ddof=1)) / math.sqrt(effective_blocks)
    )
    half = APERIODIC_BLOCK_COUNT // 2
    first_std = float(np.mean(standard_deviations[:half]))
    second_std = float(np.mean(standard_deviations[-half:]))
    return AperiodicMeanChannelCertificate(
        mean=mean,
        standard_deviation=standard_deviation,
        scale=scale,
        ci95_half_width=ci95_half_width,
        ci95_fraction=ci95_half_width / scale,
        trend_fraction=abs(slope * (APERIODIC_BLOCK_COUNT - 1)) / scale,
        half_drift_fraction=abs(
            float(np.mean(block_means[:half]) - np.mean(block_means[-half:]))
        )
        / scale,
        block_range_fraction=float(np.ptp(block_means)) / scale,
        effective_blocks=effective_blocks,
        amplitude_growth=second_std / max(first_std, absolute_floor),
    )


def _prior_diagnostic_veto(prior_diagnostic: str) -> str | None:
    lowered = prior_diagnostic.lower()
    if "cycle means trend" in lowered or "cycle means drift" in lowered:
        return "prior-monotonic-trend"
    if "amplitude growing" in lowered:
        return "prior-amplitude-growth"
    return None


def reduce_aperiodic_mean(
    *,
    t: Sequence[float],
    cl: Sequence[float],
    cd: Sequence[float],
    cm: Sequence[float],
    speed: float,
    chord: float,
    field_frame_count: int,
    prior_diagnostic: str = "",
    candidate_period_s: float | None = None,
    periodicity_cycles_observed: int = 0,
    periodicity_nonrepeatable_cycles: int = 0,
    periodicity_contaminated: bool = False,
) -> AperiodicMeanReduction:
    """Certify a terminal non-periodic mean without using AoA/Re thresholds."""

    reasons: list[str] = []
    try:
        arrays = tuple(np.asarray(values, dtype=float) for values in (t, cl, cd, cm))
        times, lift, drag, moment = arrays
        flow_speed = float(speed)
        reference_chord = float(chord)
        frames = int(field_frame_count)
        period = (
            float(candidate_period_s)
            if candidate_period_s is not None
            else float("nan")
        )
        observed_cycles = int(periodicity_cycles_observed)
        nonrepeatable_cycles = int(periodicity_nonrepeatable_cycles)
    except (TypeError, ValueError, OverflowError):
        return AperiodicMeanReduction(None, ("invalid-input-shape",))

    sample_count = int(times.size)
    if any(values.ndim != 1 or values.size != sample_count for values in arrays):
        reasons.append("mismatched-channel-lengths")
    if sample_count < APERIODIC_MIN_SOURCE_SAMPLES:
        reasons.append("insufficient-source-samples")
    if any(not np.all(np.isfinite(values)) for values in arrays):
        reasons.append("non-finite-evidence")
    if sample_count >= 2 and np.any(np.diff(times) <= 0):
        reasons.append("non-monotonic-time")
    if not math.isfinite(flow_speed) or flow_speed <= 0:
        reasons.append("invalid-speed")
    if not math.isfinite(reference_chord) or reference_chord <= 0:
        reasons.append("invalid-chord")
    if frames < APERIODIC_MIN_FIELD_FRAMES:
        reasons.append("insufficient-field-frames")
    if not math.isfinite(period) or period <= 0:
        reasons.append("missing-periodicity-assessment")
    if observed_cycles < APERIODIC_MIN_PERIODICITY_CYCLES:
        reasons.append("insufficient-periodicity-cycles")
    if nonrepeatable_cycles < 0 or nonrepeatable_cycles > observed_cycles:
        reasons.append("invalid-nonrepeatable-cycle-count")
    nonrepeatable_fraction = (
        nonrepeatable_cycles / observed_cycles if observed_cycles > 0 else 0.0
    )
    if (
        observed_cycles >= APERIODIC_MIN_PERIODICITY_CYCLES
        and nonrepeatable_fraction < APERIODIC_MIN_NONREPEATABLE_FRACTION
    ):
        reasons.append("periodicity-not-disproven")
    if periodicity_contaminated:
        reasons.append("periodicity-assessment-contaminated")
    if reasons:
        return AperiodicMeanReduction(None, tuple(reasons))

    duration = float(times[-1] - times[0])
    convective_times = duration * flow_speed / reference_chord
    additional = max(0.0, APERIODIC_MIN_CONVECTIVE_TIMES - convective_times)
    if convective_times < APERIODIC_MIN_CONVECTIVE_TIMES:
        reasons.append("insufficient-observation-horizon")
    block_duration = duration / APERIODIC_BLOCK_COUNT
    max_gap_fraction = float(np.max(np.diff(times)) / block_duration)
    if max_gap_fraction > APERIODIC_MAX_SOURCE_GAP_FRACTION:
        reasons.append("source-cadence-gap")
    if np.any(drag <= 0):
        reasons.append("non-positive-instantaneous-drag")
    if np.any(np.abs(lift) > 10) or np.any(np.abs(moment) > 10):
        reasons.append("non-physical-coefficients")
    veto = _prior_diagnostic_veto(prior_diagnostic)
    if veto is not None:
        reasons.append(veto)
    if reasons:
        return AperiodicMeanReduction(
            None,
            tuple(reasons),
            observed_convective_times=convective_times,
            additional_convective_times=additional,
        )

    grid_size = min(
        APERIODIC_RESAMPLED_MAX,
        max(APERIODIC_RESAMPLED_MIN, sample_count),
    )
    grid = np.linspace(float(times[0]), float(times[-1]), grid_size)
    channels = {
        "cl": _channel_certificate(
            grid,
            np.interp(grid, times, lift),
            absolute_floor=APERIODIC_ABSOLUTE_FLOORS["cl"],
        ),
        "cd": _channel_certificate(
            grid,
            np.interp(grid, times, drag),
            absolute_floor=APERIODIC_ABSOLUTE_FLOORS["cd"],
        ),
        "cm": _channel_certificate(
            grid,
            np.interp(grid, times, moment),
            absolute_floor=APERIODIC_ABSOLUTE_FLOORS["cm"],
        ),
    }
    for name, channel in channels.items():
        multiplier = APERIODIC_CM_TOLERANCE_MULTIPLIER if name == "cm" else 1.0
        if channel.ci95_fraction > APERIODIC_MAX_CI95_FRACTION * multiplier:
            reasons.append(f"{name}-mean-uncertainty")
        if channel.trend_fraction > APERIODIC_MAX_TREND_FRACTION * multiplier:
            reasons.append(f"{name}-mean-trend")
        if (
            channel.half_drift_fraction
            > APERIODIC_MAX_HALF_DRIFT_FRACTION * multiplier
        ):
            reasons.append(f"{name}-half-drift")
        if channel.effective_blocks < APERIODIC_MIN_EFFECTIVE_BLOCKS:
            reasons.append(f"{name}-insufficient-effective-blocks")
        if channel.amplitude_growth > APERIODIC_MAX_AMPLITUDE_GROWTH:
            reasons.append(f"{name}-amplitude-growth")
    if reasons:
        return AperiodicMeanReduction(
            None,
            tuple(reasons),
            observed_convective_times=convective_times,
            additional_convective_times=0.0,
        )

    thresholds = AperiodicMeanThresholds(
        minimum_source_samples=APERIODIC_MIN_SOURCE_SAMPLES,
        minimum_field_frames=APERIODIC_MIN_FIELD_FRAMES,
        minimum_convective_times=APERIODIC_MIN_CONVECTIVE_TIMES,
        minimum_periodicity_cycles=APERIODIC_MIN_PERIODICITY_CYCLES,
        minimum_nonrepeatable_fraction=APERIODIC_MIN_NONREPEATABLE_FRACTION,
        maximum_source_gap_fraction=APERIODIC_MAX_SOURCE_GAP_FRACTION,
        block_count=APERIODIC_BLOCK_COUNT,
        minimum_effective_blocks=APERIODIC_MIN_EFFECTIVE_BLOCKS,
        maximum_ci95_fraction=APERIODIC_MAX_CI95_FRACTION,
        maximum_trend_fraction=APERIODIC_MAX_TREND_FRACTION,
        maximum_half_drift_fraction=APERIODIC_MAX_HALF_DRIFT_FRACTION,
        maximum_amplitude_growth=APERIODIC_MAX_AMPLITUDE_GROWTH,
        cm_tolerance_multiplier=APERIODIC_CM_TOLERANCE_MULTIPLIER,
    )
    certificate = AperiodicMeanCertificate(
        reducer_version=APERIODIC_MEAN_CERTIFICATE_VERSION,
        certified=True,
        input_sha256=_canonical_input_sha256(
            t=times,
            cl=lift,
            cd=drag,
            cm=moment,
            speed=flow_speed,
            chord=reference_chord,
            field_frame_count=frames,
            prior_diagnostic=prior_diagnostic,
            candidate_period_s=period,
            periodicity_cycles_observed=observed_cycles,
            periodicity_nonrepeatable_cycles=nonrepeatable_cycles,
        ),
        source_sample_count=sample_count,
        resampled_sample_count=grid_size,
        field_frame_count=frames,
        observation_start_time=float(times[0]),
        observation_end_time=float(times[-1]),
        observed_duration_s=duration,
        convective_times=convective_times,
        thresholds=thresholds,
        periodicity=AperiodicMeanPeriodicityAssessment(
            candidate_period_s=period,
            structurally_valid_cycles=observed_cycles,
            nonrepeatable_cycles=nonrepeatable_cycles,
            nonrepeatable_fraction=nonrepeatable_fraction,
        ),
        cl=channels["cl"],
        cd=channels["cd"],
        cm=channels["cm"],
    )
    return AperiodicMeanReduction(
        certificate,
        (),
        observed_convective_times=convective_times,
        additional_convective_times=0.0,
    )
