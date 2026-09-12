import math
from pathlib import Path

import pytest

from scripts.materials.rae2822_sst_reference import boundary_request, load_sst_reference, parse_sst_boundary


LOG = """(k-omega) SST F. Menter turbulence model
freestream k : 0.9033E-03 ft**2/s**2
freestream omega : 0.7664E+04 1/s
Restart from existing solution
model was  Spalart-Allmaras, model is now    SST-Menter
All zones not converged
"""


def test_source_units_and_boundary_conversion_preserve_kinetic_energy_and_frequency():
    boundary = parse_sst_boundary(LOG + LOG)
    assert boundary["kinetic_energy_m2_s2"] == pytest.approx(8.3919316032e-5)
    assert boundary["omega_per_s"] == 7664
    assert boundary["initialization"] == "restart_from_spalart_allmaras"
    assert boundary["native_residual_stop_satisfied"] is False
    assert boundary["accuracy_certified"] is False
    for speed, viscosity in [(233.7274645, 1.1e-5), (30, 1.5e-5)]:
        request = boundary_request(boundary, speed, viscosity)
        kinetic = 1.5 * (speed * request["intensity"]) ** 2
        assert kinetic == pytest.approx(boundary["kinetic_energy_m2_s2"])
        assert kinetic / (viscosity * request["viscosity_ratio"]) == pytest.approx(7664)
    assert boundary_request(boundary, 233.7274645, 1.1e-5)["intensity"] < 0.00004


@pytest.mark.parametrize("text", [LOG.replace("SST F. Menter", "other"), LOG.replace("ft**2/s**2", "m**2/s**2"), LOG.replace("0.7664E+04", "0"), LOG + LOG.replace("0.9033E-03", "0.9034E-03")])
def test_missing_changed_units_and_conflicting_restart_quantities_fail(text):
    with pytest.raises(ValueError):
        parse_sst_boundary(text)


def test_missing_convergence_message_never_proves_certification():
    boundary = parse_sst_boundary(LOG.replace("All zones not converged", "Flowfield solution complete"))
    assert boundary["native_residual_stop_satisfied"] is None
    assert boundary["accuracy_certified"] is False


@pytest.mark.parametrize("value", [0, -1, True, math.inf, math.nan, "30"])
def test_invalid_physical_conversion_inputs_are_rejected(value):
    with pytest.raises(ValueError):
        boundary_request(parse_sst_boundary(LOG), value, 1e-5)
    with pytest.raises(ValueError):
        boundary_request(parse_sst_boundary(LOG), 30, value)


def test_reference_source_cannot_be_substituted(tmp_path):
    (tmp_path / "run.sst.lis").write_text(LOG)
    with pytest.raises(ValueError, match="checksum"):
        load_sst_reference(tmp_path, Path(__file__).parent / "fixtures/rae2822")


@pytest.mark.parametrize("speed,viscosity", [(1e-300, 1e-5), (30, 1e-320)])
def test_finite_but_unrepresentable_setup_is_rejected(speed, viscosity):
    with pytest.raises(ValueError, match="represented"):
        boundary_request(parse_sst_boundary(LOG), speed, viscosity)
