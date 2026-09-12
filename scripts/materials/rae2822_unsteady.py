from dataclasses import asdict
import math
from copy import deepcopy

import numpy as np

from airfoilfoam.postprocess.forces import analyze_rans_hold


def unsteady_request(held_request, refined=False, maximum_courant=None):
    if type(refined) is not bool:
        raise ValueError("Refinement must be explicitly enabled or disabled")
    request = deepcopy(held_request)
    if maximum_courant is not None:
        validate_reference_courant(maximum_courant)
        request["solver"]["transient_max_courant"] = maximum_courant
    if refined:
        for key in ("n_surface", "n_radial", "n_wake"):
            value = request.get("mesh", {}).get(key)
            if type(value) is not int or value <= 0:
                raise ValueError("Refinement requires explicit positive source resolution")
            request["mesh"][key] = value * 2
    request["solver"].update(flow_solver_family="rhoPimpleFoam", force_transient=True,
                              transient_fallback=False, momentum_scheme="linearUpwind")
    return request


def validate_reference_courant(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value not in (0.25, 0.5):
        raise ValueError("Reference Courant comparison requires 0.25 or 0.5")


def physical_window(chord, speed, maximum_courant=0.5):
    validate_reference_courant(maximum_courant)
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in (chord, speed)):
        raise ValueError("Physical reference requires finite positive chord and speed")
    transit = chord / speed
    return {"convective_time": transit, "start_time": 0.0, "end_time": 10 * transit,
            "initial_delta_t": transit / 100, "maximum_delta_t": transit / 100,
            "write_interval": transit / 20, "maximum_courant": maximum_courant,
            "startup_until": 2 * transit, "minimum_comparison_duration": 2 * transit,
            "minimum_field_frames": 40}


def validate_held_report(report, coefficients):
    if (report.get("kind") != "rae2822-rans-hold-reference" or report.get("eligible_urans_seed") is not True
            or report.get("outcome") != "held_reference" or type(report.get("native_returncode")) is not int or report.get("native_returncode") != 0
            or report.get("timed_out") is not False
            or report.get("initial_numerical_convergence", {}).get("converged") is not True):
        raise ValueError("Unsteady reference requires a genuinely held RANS source")
    analysis = analyze_rans_hold(coefficients)
    if not analysis or not analysis.certified or asdict(analysis) != report.get("force_hold"):
        raise ValueError("Unsteady source hold differs from its raw coefficient proof")
    if type(report.get("fields_iteration")) is not int or report["fields_iteration"] != analysis.end_iteration:
        raise ValueError("Unsteady source checkpoint does not match its held window")
    return report["fields_iteration"]


def weighted_pressure_mean(samples, window, interval=None):
    if not samples:
        return {"available": False, "reason": "no_saved_pressure_frames", "field_frames": 0}
    samples = sorted(samples, key=lambda sample: sample[0])
    times = np.asarray([sample[0] for sample in samples], dtype=float)
    if not np.isfinite(times).all() or np.any(times <= 0) or np.any(np.diff(times) <= 0):
        raise ValueError("Pressure frames require unique increasing physical times")
    selected = [sample for sample in samples if sample[0] >= window["startup_until"]]
    if not selected:
        return {"available": False, "reason": "insufficient_developed_history", "field_frames": 0}
    if interval is None:
        start, end = selected[0][0], selected[-1][0]
    else:
        if not isinstance(interval, (tuple, list)) or len(interval) != 2 or any(
            isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) for value in interval
        ):
            raise ValueError("Pressure comparison interval must be finite physical times")
        start, end = interval
        if start >= end or start < selected[0][0] or end > selected[-1][0]:
            raise ValueError("Pressure comparison interval is outside developed saved evidence")
    times = np.asarray([sample[0] for sample in selected])
    actual_count = int(np.count_nonzero((times >= start) & (times <= end)))
    if actual_count < window["minimum_field_frames"] or end - start < window["minimum_comparison_duration"]:
        return {"available": False, "reason": "insufficient_developed_history", "field_frames": actual_count}
    first = max(0, int(np.searchsorted(times, start, side="right")) - 1)
    last = min(len(selected) - 1, int(np.searchsorted(times, end, side="left")))
    selected = selected[first:last + 1]
    source_times = times[first:last + 1]
    if np.max(np.diff(source_times)) > window["write_interval"] * 1.5:
        return {"available": False, "reason": "pressure_frame_gap", "field_frames": actual_count}
    boundaries = [value for value in (start, end) if value not in source_times]
    times = np.r_[start, source_times[(source_times > start) & (source_times < end)], end]
    mean = {}
    for side in ("upper", "lower"):
        arrays = [np.asarray(sample[1][side], dtype=float) for sample in selected]
        if any(array.ndim != 2 or array.shape != arrays[0].shape or array.shape[1] != 2
               or not np.isfinite(array).all() for array in arrays):
            raise ValueError("Pressure history changed its spatial sampling or contains invalid fields")
        coordinates = arrays[0][:, 0]
        if any(not np.array_equal(array[:, 0], coordinates) for array in arrays):
            raise ValueError("Pressure history changed its spatial sampling")
        if len(coordinates) < 2 or np.any(np.diff(coordinates) <= 0):
            raise ValueError("Pressure history has invalid surface coordinates")
        stored = np.asarray([array[:, 1] for array in arrays])
        values = np.column_stack([np.interp(times, source_times, stored[:, index]) for index in range(stored.shape[1])])
        averaged = np.sum((values[:-1] + values[1:]) * 0.5 * np.diff(times)[:, None], axis=0) / (times[-1] - times[0])
        mean[side] = np.column_stack((coordinates, averaged)).tolist()
    return {"available": True, "field_frames": actual_count, "start_time": float(times[0]), "end_time": float(times[-1]),
            "interpolated_boundaries": boundaries,
            "mean": mean, "statistical_certification": False, "interpretation": "time_weighted_pressure_not_a_period_certificate"}
