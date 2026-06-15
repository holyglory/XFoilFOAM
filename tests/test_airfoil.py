import numpy as np
import pytest

from airfoilfoam.airfoil import Airfoil, load_airfoil, parse_airfoil
from airfoilfoam.models import AirfoilFormat


def test_parse_selig_autodetect(naca0012_selig_text):
    contour = parse_airfoil(naca0012_selig_text, AirfoilFormat.auto)
    assert contour.shape[1] == 2
    assert contour.shape[0] > 100


def test_lednicer_detection_and_parse(lednicer_text):
    contour = parse_airfoil(lednicer_text, AirfoilFormat.auto)
    # 3 upper + 3 lower - 1 shared LE = 5 points
    assert contour.shape[0] == 5
    af = Airfoil.from_contour("test", contour)
    # symmetric +/-0.06 thickness at mid chord
    upper, lower = af.split_surfaces()
    assert upper[:, 1].max() > 0.05
    assert lower[:, 1].min() < -0.05


def test_chord_alignment_normalisation(naca0012_selig_text):
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    xs = af.contour[:, 0]
    assert xs.min() == pytest.approx(0.0, abs=1e-9)
    assert xs.max() == pytest.approx(1.0, abs=1e-9)
    # leading edge at origin, trailing edge closed at (1, 0)
    assert af.contour[af.le_index] == pytest.approx([0.0, 0.0], abs=1e-9)
    assert af.contour[0] == pytest.approx([1.0, 0.0], abs=1e-9)
    assert af.contour[-1] == pytest.approx([1.0, 0.0], abs=1e-9)


def test_naca0012_thickness(naca0012_selig_text):
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    upper, lower = af.resampled_surfaces(120)
    # NACA0012 max thickness ~12% chord
    thickness = upper[:, 1] - lower[:, 1]
    assert thickness.max() == pytest.approx(0.12, abs=0.01)


def test_resample_endpoints_and_count(naca0012_selig_text):
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    upper, lower = af.resampled_surfaces(60)
    assert upper.shape == (61, 2)
    assert lower.shape == (61, 2)
    assert upper[0] == pytest.approx([0.0, 0.0])
    assert upper[-1] == pytest.approx([1.0, 0.0])


def test_points_input_rotated_airfoil():
    # an angled symmetric "airfoil" should be chord-aligned back to x-axis
    base = np.array([[1, 0.02], [0.5, 0.06], [0, 0], [0.5, -0.06], [1, -0.02]], dtype=float)
    theta = np.radians(10)
    rot = np.array([[np.cos(theta), -np.sin(theta)], [np.sin(theta), np.cos(theta)]])
    rotated = base @ rot.T
    af = Airfoil.from_contour("rot", rotated)
    assert af.contour[:, 0].min() == pytest.approx(0.0, abs=1e-9)
    assert af.contour[:, 0].max() == pytest.approx(1.0, abs=1e-9)


def test_too_few_points_raises():
    with pytest.raises(ValueError):
        parse_airfoil("airfoil\n0 0\n1 0\n", AirfoilFormat.selig)
