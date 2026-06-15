import math

import pytest

from airfoilfoam import physics


def test_reynolds():
    assert physics.reynolds(50, 1.0, 1e-5) == pytest.approx(5e6)


def test_freestream_vector_zero_aoa():
    fv = physics.freestream_vector(40.0, 0.0)
    assert fv.ux == pytest.approx(40.0)
    assert fv.uy == pytest.approx(0.0, abs=1e-12)
    assert fv.lift_dir == pytest.approx((0.0, 1.0, 0.0))
    assert fv.drag_dir == pytest.approx((1.0, 0.0, 0.0))


def test_freestream_vector_aoa():
    fv = physics.freestream_vector(10.0, 30.0)
    assert fv.ux == pytest.approx(10 * math.cos(math.radians(30)))
    assert fv.uy == pytest.approx(10 * math.sin(math.radians(30)))
    # lift_dir perpendicular to drag_dir
    dot = sum(a * b for a, b in zip(fv.lift_dir, fv.drag_dir))
    assert dot == pytest.approx(0.0, abs=1e-12)


def test_freestream_turbulence_consistency():
    k = physics.freestream_k(50.0, 0.01)
    omega = physics.freestream_omega(k, 1.5e-5, 10.0)
    nut = physics.freestream_nut(k, omega)
    assert nut == pytest.approx(10.0 * 1.5e-5)
    eps = physics.freestream_epsilon(k, omega)
    assert eps == pytest.approx(physics.CMU * k * omega)


def test_first_cell_height_scales_with_yplus():
    h1 = physics.first_cell_height_for_yplus(1.0, 50.0, 1.0, 1.5e-5)
    h30 = physics.first_cell_height_for_yplus(30.0, 50.0, 1.0, 1.5e-5)
    assert h30 == pytest.approx(30.0 * h1, rel=1e-6)
    assert 0 < h1 < 1e-3
