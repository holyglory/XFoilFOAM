import json

import pytest

from scripts.materials.rae2822_local_time import attach_pressure_steady_detector, pressure_steady_convergence


def references():
    return {"referenceDensity": 1.2, "referenceSpeed": 230, "referenceLength": 0.3,
            "referenceSpecificEnergy": 300000, "referenceTurbulenceEnergy": 0.5, "referenceTurbulenceFrequency": 20}


def test_detector_preserves_force_function_and_uses_derived_references(tmp_path):
    path = tmp_path / "system/controlDict"
    path.parent.mkdir()
    original = "application rhoPimpleFoam;\nfunctions { forceCoeffs1 { type forceCoeffs; } }\n"
    path.write_text(original)
    receipt = attach_pressure_steady_detector(tmp_path, references(), 1e-5)
    text = path.read_text()
    assert "forceCoeffs1 { type forceCoeffs; }" in text
    assert "conservedFields primitive;" in text
    assert "consecutiveSteps 100;" in text
    assert "libxfoilfoamSteadyConvergence.so" in text
    assert receipt["references"] == references()
    assert receipt["force_window_samples"] == 200
    with pytest.raises(ValueError, match="fresh"):
        attach_pressure_steady_detector(tmp_path, references(), 1e-5)


@pytest.mark.parametrize("tolerance", [0, -1, True, float('nan'), float('inf')])
def test_detector_rejects_invalid_tolerance_before_touching_case(tmp_path, tolerance):
    with pytest.raises(ValueError, match="finite and positive"):
        attach_pressure_steady_detector(tmp_path, references(), tolerance)
    assert not (tmp_path / "system").exists()


def certificate_log():
    rows = "".join(f"XFOILFOAM_LOCAL_STEADY_RESIDUAL {iteration} 1e-6 1e-6 1e-6 1e-6 1e-6\n" for iteration in range(1, 101))
    certificate = {"version": 2, "coordinate_kind": "iteration", "iteration": 100, "consecutive_steps": 100,
                   "tolerance": 1e-5, "maximum_window_residual": 1e-6}
    return "XFOILFOAM_LOCAL_STEADY_FIELD_SOURCE primitive h\n" + rows + "XFOILFOAM_LOCAL_STEADY_CONVERGED " + json.dumps(certificate) + "\n"


def test_pressure_convergence_requires_all_three_independent_gates():
    stability = {"available": True, "window_iterations": 200, "pressure_limited_iterations": 0}
    result = pressure_steady_convergence(certificate_log(), 1e-5, True, stability)
    assert result["converged"] is True
    assert result["native_rate_certificate"] is True
    assert not pressure_steady_convergence(certificate_log(), 1e-5, False, stability)["converged"]
    for change in ({"pressure_limited_iterations": 1}, {"window_iterations": 100}, {"available": False}, {"pressure_limited_iterations": False}):
        assert not pressure_steady_convergence(certificate_log(), 1e-5, True, {**stability, **change})["converged"]
    assert not pressure_steady_convergence("XFOILFOAM_LOCAL_STEADY_FIELD_SOURCE primitive h\nTime = 1\n", 1e-5, True, stability)["converged"]
    with pytest.raises(ValueError, match="capability"):
        pressure_steady_convergence(certificate_log().replace("primitive h", "stored rhoE"), 1e-5, True, stability)
    with pytest.raises(ValueError):
        pressure_steady_convergence(certificate_log().replace('"consecutive_steps": 100', '"consecutive_steps": 99'), 1e-5, True, stability)
