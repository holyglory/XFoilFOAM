import pytest

from airfoilfoam.models import AoASpec, FluidProperties, PolarRequest, SolverParams


def test_aoa_explicit_list():
    assert AoASpec(angles=[0, 5, 10]).expand() == [0, 5, 10]


def test_aoa_range_inclusive():
    assert AoASpec(start=-2, stop=4, step=2).expand() == [-2, 0, 2, 4]


def test_aoa_dedup_list_and_range():
    spec = AoASpec(angles=[0], start=0, stop=2, step=1)
    assert spec.expand() == [0, 1, 2]


def test_aoa_requires_something():
    with pytest.raises(ValueError):
        AoASpec()


def test_fluid_nu_from_mu_rho():
    f = FluidProperties(density=2.0, dynamic_viscosity=4.0)
    assert f.nu == 2.0


def test_fluid_nu_explicit():
    f = FluidProperties(density=1.0, kinematic_viscosity=1.23e-5)
    assert f.nu == 1.23e-5


def test_polar_request_cartesian_cases():
    req = PolarRequest(
        airfoil={"name": "a", "points": [[1, 0], [0.5, 0.1], [0, 0], [0.5, -0.1], [1, 0]]},
        chord_lengths=[0.5, 1.0],
        speeds=[20, 40],
        aoa=AoASpec(angles=[0, 5]),
    )
    cases = req.cases()
    assert len(cases) == 2 * 2 * 2
    slugs = {c.slug for c in cases}
    assert len(slugs) == 8  # all unique


def test_transient_max_courant_default_pinned_at_practitioner_ceiling():
    """PIN (prod 2026-07-07, job b01a7d46): relaxed-PIMPLE URANS at Co=15
    accumulated splitting error over the multi-period horizon into a velocity
    singularity (dt collapse, |Cl| excursions ±9.45e5). 4 is the
    practitioner-standard ceiling; profiles may still override the field."""
    assert SolverParams().transient_max_courant == pytest.approx(4.0)
    assert SolverParams(transient_max_courant=15.0).transient_max_courant == pytest.approx(15.0)


def test_case_slug_safe():
    req = PolarRequest(
        airfoil={"name": "a", "points": [[1, 0], [0.5, 0.1], [0, 0], [0.5, -0.1], [1, 0]]},
        chord_lengths=[1.0], speeds=[40], aoa=AoASpec(angles=[-2.5]),
    )
    slug = req.cases()[0].slug
    assert "." not in slug and "-" not in slug
