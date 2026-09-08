import json
from types import SimpleNamespace

import pytest

from airfoilfoam.openfoam.acoustic_startup import acoustic_startup_step
from airfoilfoam.openfoam.runner import InfrastructureError, MaterialDomainError


def receipt(**changes):
    return {"version": 1, "courant_rate": 1e9, "maximum_courant": 0.2,
            "requested_delta_t": 5e-7, "safe_delta_t": 0.2 / 1.2e9, **changes}


def runner(payload, *, ok=True, prefix="", repeat=False):
    calls = []

    def application(case_dir, command, timeout):
        calls.append((case_dir, command, timeout))
        output = "XFOILFOAM_ACOUSTIC_STARTUP " + json.dumps(payload) + "\n"
        return SimpleNamespace(ok=ok, stdout=prefix + output * (2 if repeat else 1))

    return SimpleNamespace(application=application, calls=calls)


def test_native_rate_caps_first_step_and_retains_receipt(tmp_path):
    native = runner(receipt())
    timestep = acoustic_startup_step(tmp_path, native, 0.2)
    assert timestep == pytest.approx(0.2 / 1.2e9)
    assert timestep * 1.2e9 <= 0.2 * (1 + 1e-12)
    assert json.loads((tmp_path / "acoustic-startup.json").read_text()) == receipt()
    assert len(native.calls) == 1 and native.calls[0][2] == 60


def test_already_smaller_step_is_not_increased(tmp_path):
    assert acoustic_startup_step(tmp_path, runner(receipt(requested_delta_t=1e-12, safe_delta_t=1e-12)), 0.2) == 1e-12


@pytest.mark.parametrize("changes", [
    {"version": 2}, {"courant_rate": float("nan")}, {"courant_rate": 0},
    {"safe_delta_t": True}, {"safe_delta_t": -1}, {"maximum_courant": 0.5},
    {"safe_delta_t": 5e-7}, {"requested_delta_t": 1e-12},
])
def test_rejects_nonfinite_or_unbounded_native_receipts(tmp_path, changes):
    with pytest.raises(InfrastructureError):
        acoustic_startup_step(tmp_path, runner(receipt(**changes)), 0.2)
    assert (tmp_path / "log.acoustic-startup").is_file()
    assert not (tmp_path / "acoustic-startup.json").exists()


@pytest.mark.parametrize("options", [{"ok": False}, {"repeat": True}])
def test_rejects_failed_or_ambiguous_preflight(tmp_path, options):
    with pytest.raises(InfrastructureError):
        acoustic_startup_step(tmp_path, runner(receipt(), **options), 0.2)


def test_material_clamping_cannot_validate_startup(tmp_path):
    native = runner(receipt(), prefix="attempt to use janafThermo<EquationOfState> out of temperature range\n")
    with pytest.raises(MaterialDomainError):
        acoustic_startup_step(tmp_path, native, 0.2)
    assert (tmp_path / "material-domain-diagnostic.json").is_file()
    assert not (tmp_path / "acoustic-startup.json").exists()


@pytest.mark.parametrize("payload", [None, [], "invalid", {}])
def test_malformed_receipt_is_infrastructure_failure(tmp_path, payload):
    with pytest.raises(InfrastructureError):
        acoustic_startup_step(tmp_path, runner(payload), 0.2)


@pytest.mark.parametrize("limit", [float("nan"), float("inf"), 0, -1, True])
def test_invalid_configured_ceiling_does_not_launch_native_command(tmp_path, limit):
    native = runner(receipt())
    with pytest.raises(InfrastructureError):
        acoustic_startup_step(tmp_path, native, limit)
    assert native.calls == []
