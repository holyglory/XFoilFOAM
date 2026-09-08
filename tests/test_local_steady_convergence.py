import json

import pytest

from airfoilfoam.postprocess.residuals import parse_local_steady_convergence


def residual_log(count=100, residual=1e-6, **changes):
    samples = "".join(f"XFOILFOAM_LOCAL_STEADY_RESIDUAL {iteration} {residual} {residual} {residual} {residual} {residual}\n" for iteration in range(1, count + 1))
    certificate = {"version": 2, "coordinate_kind": "iteration", "iteration": count,
                   "consecutive_steps": count, "tolerance": 1e-4, "maximum_window_residual": residual, **changes}
    return samples + "XFOILFOAM_LOCAL_STEADY_CONVERGED " + json.dumps(certificate) + "\n"


def test_native_certificate_requires_a_sustained_conserved_residual_window():
    result = parse_local_steady_convergence(residual_log(), 1e-4)
    assert result.converged and result.iterations == 100
    assert result.final_residual == 1e-6


@pytest.mark.parametrize("log", [
    "SIMPLE solution converged in 100 iterations\n",
    "Time = 100\ndiagonal: Solving for rho, Initial residual = 0, Final residual = 0\n",
    "XFOILFOAM_LOCAL_STEADY_RESIDUAL 1 0 0 0 0 0\n",
])
def test_generic_convergence_or_flat_solver_residuals_do_not_certify_local_mode(log):
    assert not parse_local_steady_convergence(log, 1e-4).converged


@pytest.mark.parametrize("log", [
    residual_log(count=99), residual_log(residual=0.1), residual_log(tolerance=1e-2),
    residual_log(coordinate_kind="physical_time"), residual_log(maximum_window_residual=0),
    residual_log(version=True), residual_log(version=1), residual_log(consecutive_steps=100.0),
    residual_log().replace("1e-06 1e-06\n", "0.1 0.1\n"),
    residual_log().replace("RESIDUAL 40 ", "RESIDUAL 41 "),
    residual_log().replace("RESIDUAL 50 1e-06", "RESIDUAL 50 nan"),
    residual_log() + "XFOILFOAM_LOCAL_STEADY_RESIDUAL 101 0 0 0\n",
    residual_log() + residual_log(),
])
def test_false_or_corrupt_certification_is_rejected(log):
    with pytest.raises(ValueError):
        parse_local_steady_convergence(log, 1e-4)
