"""Read-only retrospective evaluation for rejected preliminary URANS rows."""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
from typing import Any, Iterable, Mapping

from .postprocess.aperiodic import reduce_aperiodic_mean


@dataclass(frozen=True)
class AperiodicEvaluationSummary:
    evaluated: int
    certificate_candidates: int
    continuation_candidates: int
    conservative_rerun_candidates: int
    invalid_inputs: int
    estimated_rerun_cpu_hours: float | None
    estimated_cpu_hours_per_certificate_candidate: float | None


def _record(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _finite_number(value: object) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        number = float(value)
        if math.isfinite(number):
            return number
    return None


def _integer(value: object) -> int | None:
    number = _finite_number(value)
    if number is None or not number.is_integer():
        return None
    return int(number)


def _field_frame_count(payload: Mapping[str, Any], record: Mapping[str, Any]) -> int:
    explicit = _integer(record.get("field_frame_count", record.get("fieldFrames")))
    if explicit is not None and explicit >= 0:
        return explicit
    frame_track = _record(payload.get("frame_track"))
    frames = frame_track.get("frames")
    if isinstance(frames, list):
        return len(frames)
    certificate = _record(
        payload.get("urans_cycle_certificate", payload.get("cycleCertificate"))
    )
    cycles = certificate.get("cycles")
    if isinstance(cycles, list):
        counts = [
            _integer(_record(cycle).get("field_frames"))
            for cycle in cycles
        ]
        return sum(count for count in counts if count is not None and count > 0)
    return 0


def _warnings(record: Mapping[str, Any], payload: Mapping[str, Any]) -> list[str]:
    raw = record.get("quality_warnings", payload.get("quality_warnings", []))
    warnings = (
        [value for value in raw if isinstance(value, str)]
        if isinstance(raw, list)
        else []
    )
    error = record.get("error")
    if isinstance(error, str):
        warnings.append(error)
    return warnings


def _periodicity_assessment(
    payload: Mapping[str, Any],
) -> tuple[float | None, int, int, bool]:
    certificate = _record(
        payload.get("urans_cycle_certificate", payload.get("cycleCertificate"))
    )
    period = _finite_number(certificate.get("period_s"))
    raw_cycles = certificate.get("cycles")
    if not isinstance(raw_cycles, list):
        return period, 0, 0, False
    valid = 0
    nonrepeatable = 0
    contaminated = False
    for raw_cycle in raw_cycles:
        cycle = _record(raw_cycle)
        disposition = cycle.get("disposition")
        reasons = cycle.get("reasons")
        reason_text = " ".join(
            reason for reason in reasons if isinstance(reason, str)
        ).lower() if isinstance(reasons, list) else ""
        if disposition in {"selected", "clean", "settling_outlier"}:
            valid += 1
        if disposition == "settling_outlier":
            nonrepeatable += 1
        if disposition in {"numerically_noisy", "hard_corrupt"} or any(
            marker in reason_text
            for marker in ("high-frequency", "impulsive", "non-finite")
        ):
            contaminated = True
    return period, valid, nonrepeatable, contaminated


def _recommended_action(reasons: tuple[str, ...], restartable: bool) -> str:
    incomplete = {
        "insufficient-source-samples",
        "insufficient-field-frames",
        "insufficient-observation-horizon",
        "source-cadence-gap",
        "missing-periodicity-assessment",
        "insufficient-periodicity-cycles",
    }
    if restartable and any(reason in incomplete for reason in reasons):
        return "continue_exact_case"
    return "rerun_conservative_numerics"


def evaluate_rejected_record(raw: Mapping[str, Any]) -> dict[str, Any]:
    """Evaluate one JSON-compatible record without publishing or mutating it."""

    payload = _record(raw.get("evidence_payload", raw.get("point", raw)))
    force = _record(payload.get("force_history"))
    if not force and all(isinstance(payload.get(key), list) for key in ("t", "cl", "cd", "cm")):
        force = {key: payload[key] for key in ("t", "cl", "cd", "cm")}
    speed = _finite_number(raw.get("speed"))
    chord = _finite_number(raw.get("chord"))
    frame_count = _field_frame_count(payload, raw)
    warnings = _warnings(raw, payload)
    restartable = bool(raw.get("restartable", False))
    (
        candidate_period_s,
        periodicity_cycles_observed,
        periodicity_nonrepeatable_cycles,
        periodicity_contaminated,
    ) = _periodicity_assessment(payload)
    reduction = reduce_aperiodic_mean(
        t=force.get("t", []),
        cl=force.get("cl", []),
        cd=force.get("cd", []),
        cm=force.get("cm", []),
        speed=speed if speed is not None else float("nan"),
        chord=chord if chord is not None else float("nan"),
        field_frame_count=frame_count,
        prior_diagnostic="; ".join(warnings),
        candidate_period_s=candidate_period_s,
        periodicity_cycles_observed=periodicity_cycles_observed,
        periodicity_nonrepeatable_cycles=periodicity_nonrepeatable_cycles,
        periodicity_contaminated=periodicity_contaminated,
    )
    certificate = reduction.certificate
    reasons = reduction.reasons
    if certificate is not None:
        action = "rerun_statistical_mean_contract"
        score = 1.0
    else:
        action = _recommended_action(reasons, restartable)
        score = 0.0
    estimated_cpu_hours = _finite_number(raw.get("estimated_cpu_hours"))
    return {
        "obligation_id": raw.get("obligation_id"),
        "result_attempt_id": raw.get("result_attempt_id"),
        "certificate_candidate": certificate is not None,
        "statistical_mean_score": score,
        "recommended_action": action,
        "reasons": list(reasons),
        "source_sample_count": len(force.get("t", []))
        if isinstance(force.get("t"), list)
        else 0,
        "field_frame_count": frame_count,
        "observed_convective_times": reduction.observed_convective_times,
        "additional_convective_times": reduction.additional_convective_times,
        "estimated_cpu_hours": estimated_cpu_hours,
        "certificate": (
            certificate.model_dump(mode="json") if certificate is not None else None
        ),
    }


def summarize_evaluations(
    evaluations: Iterable[Mapping[str, Any]],
) -> AperiodicEvaluationSummary:
    rows = list(evaluations)
    candidates = sum(bool(row.get("certificate_candidate")) for row in rows)
    continuation = sum(
        row.get("recommended_action") == "continue_exact_case" for row in rows
    )
    conservative = sum(
        row.get("recommended_action") == "rerun_conservative_numerics"
        for row in rows
    )
    invalid = sum(
        any(
            reason
            in {
                "invalid-input-shape",
                "mismatched-channel-lengths",
                "non-finite-evidence",
                "invalid-speed",
                "invalid-chord",
            }
            for reason in row.get("reasons", [])
        )
        for row in rows
    )
    hours = [
        value
        for row in rows
        if (value := _finite_number(row.get("estimated_cpu_hours"))) is not None
        and value >= 0
    ]
    total_hours = sum(hours) if len(hours) == len(rows) and rows else None
    per_candidate = (
        total_hours / candidates
        if total_hours is not None and candidates > 0
        else None
    )
    return AperiodicEvaluationSummary(
        evaluated=len(rows),
        certificate_candidates=candidates,
        continuation_candidates=continuation,
        conservative_rerun_candidates=conservative,
        invalid_inputs=invalid,
        estimated_rerun_cpu_hours=total_hours,
        estimated_cpu_hours_per_certificate_candidate=per_candidate,
    )


def evaluate_json_lines(lines: Iterable[str]) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    evaluations = [
        evaluate_rejected_record(json.loads(line))
        for line in lines
        if line.strip()
    ]
    summary = summarize_evaluations(evaluations)
    return evaluations, {
        "mode": "read_only_non_publishing",
        **summary.__dict__,
    }
