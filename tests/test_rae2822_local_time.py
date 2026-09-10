import json

import pytest

from scripts.materials.rae2822_local_time import configure_local_time_pressure


def test_local_pressure_is_not_a_physical_time_history(tmp_path):
    (tmp_path / "system").mkdir()
    (tmp_path / "constant").mkdir()
    schemes = tmp_path / "system/fvSchemes"
    schemes.write_text("ddtSchemes { default steadyState; } divSchemes { div(phi,h) bounded Gauss upwind; }")
    thermo = tmp_path / "constant/thermophysicalProperties"
    thermo.write_text("source material fixture unchanged")
    receipt = configure_local_time_pressure(tmp_path, 0.3048, 233)
    assert receipt["physical_time_history"] is False
    assert receipt["solver_family"] == "rhoPimpleFoam"
    assert receipt["steady_acceptance_certificate"] == "unavailable_experimental"
    assert receipt["maximum_local_step_seconds"] == pytest.approx(0.3048 / 233)
    assert "localEuler" in schemes.read_text()
    assert "bounded" not in schemes.read_text()
    assert json.loads((tmp_path / "constant/numericalExecution.json").read_text()) == receipt
    assert thermo.read_text() == "source material fixture unchanged"
    solution = (tmp_path / "system/fvSolution").read_text()
    assert "PIMPLE" in solution and "SIMPLE\n" not in solution
    assert "pMaxFactor      2;" in solution
    assert "maxCo           0.5;" in solution
    with pytest.raises(ValueError, match="generated enthalpy"):
        configure_local_time_pressure(tmp_path, 0.3048, 233)


@pytest.mark.parametrize("chord,speed", [(0, 233), (0.3, 0), (-1, 233), (True, 233), (0.3, float('inf'))])
def test_local_pressure_rejects_invented_or_nonfinite_time_scales(tmp_path, chord, speed):
    with pytest.raises(ValueError, match="finite physical"):
        configure_local_time_pressure(tmp_path, chord, speed)
