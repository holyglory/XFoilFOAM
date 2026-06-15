from pathlib import Path

import pytest

from airfoilfoam.postprocess.forces import (
    force_is_steady,
    parse_force_coefficients,
    parse_y_plus,
    time_averaged_coefficients,
)
from airfoilfoam.postprocess.residuals import parse_convergence

COEFF = """# Force and moment coefficients
# CofR : (0.25 0 0)
# Time\tCd\tCd(f)\tCd(r)\tCl\tCl(f)\tCl(r)\tCmPitch\tCmRoll\tCmYaw\tCs\tCs(f)\tCs(r)
1\t0.1\t0.05\t0.05\t0.4\t0.2\t0.2\t0.01\t0\t0\t0\t0\t0
2\t0.012\t0.006\t0.006\t0.50\t0.25\t0.25\t0.02\t0\t0\t0\t0\t0
3\t0.014\t0.007\t0.007\t0.52\t0.26\t0.26\t0.03\t0\t0\t0\t0\t0
"""


def test_parse_force_coefficients_named_columns(tmp_path: Path):
    p = tmp_path / "coefficient.dat"
    p.write_text(COEFF)
    fc = parse_force_coefficients(p, average_last=2)
    # average of rows 2 and 3
    assert fc.cd == pytest.approx((0.012 + 0.014) / 2)
    assert fc.cl == pytest.approx((0.50 + 0.52) / 2)
    assert fc.cm == pytest.approx((0.02 + 0.03) / 2)
    assert fc.cl_cd == pytest.approx(fc.cl / fc.cd)


def test_parse_force_coefficients_last_only(tmp_path: Path):
    p = tmp_path / "coefficient.dat"
    p.write_text(COEFF)
    fc = parse_force_coefficients(p, average_last=1)
    assert fc.cl == pytest.approx(0.52)
    assert fc.cd == pytest.approx(0.014)


def _coeff_file(tmp_path, cl_series, cd=0.01):
    p = tmp_path / "coefficient.dat"
    head = "# Time\tCd\tCd(f)\tCd(r)\tCl\tCl(f)\tCl(r)\tCmPitch\tCmRoll\tCmYaw\n"
    rows = "".join(
        f"{i}\t{cd}\t0\t0\t{cl}\t0\t0\t0\t0\t0\n" for i, cl in enumerate(cl_series, 1)
    )
    p.write_text("# Force coefficients\n" + head + rows)
    return p


def test_force_is_steady_true(tmp_path: Path):
    p = _coeff_file(tmp_path, [0.5] * 300)
    assert force_is_steady(p, window=200) is True


def test_force_is_steady_false_when_drifting(tmp_path: Path):
    series = [0.001 * i for i in range(300)]  # steadily climbing
    p = _coeff_file(tmp_path, series)
    assert force_is_steady(p, window=200) is False


def test_force_is_steady_false_when_too_few_rows(tmp_path: Path):
    p = _coeff_file(tmp_path, [0.5] * 50)
    assert force_is_steady(p, window=200) is False


def test_time_averaged_coefficients(tmp_path: Path):
    # an oscillating signal: discard the first 40%, average a clean sine-ish tail
    import math
    p = tmp_path / "coefficient.dat"
    head = "# Time\tCd\tCd(f)\tCd(r)\tCl\tCl(f)\tCl(r)\tCmPitch\tCmRoll\tCmYaw\n"
    rows = []
    for i in range(100):
        cl = 0.8 + 0.1 * math.sin(i)        # mean 0.8, fluctuating
        cd = 0.15 + 0.02 * math.cos(i)      # mean 0.15
        rows.append(f"{i}\t{cd}\t0\t0\t{cl}\t0\t0\t0.05\t0\t0\n")
    p.write_text("# coeffs\n" + head + "".join(rows))
    avg = time_averaged_coefficients(p, discard_fraction=0.4)
    assert avg.cl == pytest.approx(0.8, abs=0.03)
    assert avg.cd == pytest.approx(0.15, abs=0.01)
    assert avg.cl_std > 0.03          # captures the fluctuation
    assert avg.samples == 60          # last 60% of 100 rows
    assert avg.cl_cd == pytest.approx(avg.cl / avg.cd)


def test_parse_y_plus(tmp_path: Path):
    p = tmp_path / "yPlus.dat"
    p.write_text("# y+\n# Time\tpatch\tmin\tmax\taverage\n420\tairfoil\t1.5\t26.8\t9.58\n")
    avg, ymax = parse_y_plus(p)
    assert avg == pytest.approx(9.58)
    assert ymax == pytest.approx(26.8)


def test_parse_convergence_converged():
    log = """Time = 1
smoothSolver:  Solving for Ux, Initial residual = 0.5, Final residual = 1e-7, No Iterations 1
Time = 420
smoothSolver:  Solving for Ux, Initial residual = 9e-6, Final residual = 1e-9, No Iterations 1
GAMG:  Solving for p, Initial residual = 8e-6, Final residual = 1e-8, No Iterations 2
SIMPLE solution converged in 420 iterations
"""
    info = parse_convergence(log)
    assert info.converged is True
    assert info.iterations == 420
    assert info.final_residual == pytest.approx(9e-6)


def test_parse_convergence_not_converged():
    log = "Time = 1\nTime = 2\nsmoothSolver:  Solving for Ux, Initial residual = 0.3, Final residual = 1e-3, No Iterations 5\n"
    info = parse_convergence(log)
    assert info.converged is False
    assert info.iterations == 2
