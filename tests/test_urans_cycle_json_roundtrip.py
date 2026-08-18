from __future__ import annotations

import math

import numpy as np

from airfoilfoam.models import (
    UransCycleCertificateCycle,
    UransCycleDisposition,
)
from airfoilfoam.postprocess.unsteady import (
    CLEAN_CYCLE_UNBOUNDED_METRIC,
    _phase_aligned_errors,
)


def _cycle(**updates) -> UransCycleCertificateCycle:
    values = {
        "index": 0,
        "t_start": 0.0,
        "t_end": 1.0,
        "coefficient_samples": 20,
        "field_frames": 20,
        "phase_max_gap": 0.05,
        "phase_shift_bins": 0,
        "cl_mean": 0.0,
        "cd_mean": 0.02,
        "cm_mean": 0.0,
        "cl_shape_error": None,
        "cd_shape_error": None,
        "cm_shape_error": None,
        "cl_amplitude_deviation": None,
        "cd_amplitude_deviation": None,
        "cm_amplitude_deviation": None,
        "cl_high_frequency": None,
        "cd_high_frequency": None,
        "cm_high_frequency": None,
        "disposition": UransCycleDisposition.settling_outlier,
        "reasons": ["legacy unjudgeable diagnostic"],
    }
    values.update(updates)
    return UransCycleCertificateCycle(**values)


def test_current_unbounded_amplitude_is_finite_json() -> None:
    phase = np.linspace(0.0, 2.0 * np.pi, 96, endpoint=False)
    actual = np.sin(phase)
    flat = np.zeros_like(actual)
    _shift, _shape, amplitudes = _phase_aligned_errors(
        (actual, actual, actual),
        (flat, flat, flat),
    )

    assert amplitudes == (CLEAN_CYCLE_UNBOUNDED_METRIC,) * 3
    assert all(math.isfinite(value) for value in amplitudes)
    encoded = _cycle(
        cl_amplitude_deviation=amplitudes[0],
        cd_amplitude_deviation=amplitudes[1],
        cm_amplitude_deviation=amplitudes[2],
    ).model_dump_json()
    assert "Infinity" not in encoded
    assert '"cl_amplitude_deviation":null' not in encoded


def test_legacy_null_diagnostic_remains_readable_but_unjudgeable() -> None:
    encoded = _cycle().model_dump_json()
    restored = UransCycleCertificateCycle.model_validate_json(encoded)

    assert restored.cl_shape_error is None
    assert restored.cd_amplitude_deviation is None
