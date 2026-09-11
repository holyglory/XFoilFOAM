import json
import hashlib

import pytest

from scripts.materials.rae2822_local_time import configure_local_time_pressure, continuation_end_iteration, restore_local_pressure_state


def test_continuation_target_can_finish_original_scope_without_extra_iterations():
    assert continuation_end_iteration(3300, 6000, 6000) == 6000
    assert continuation_end_iteration(3000, 3000) == 6000
    for target in (3300, 3299, 9301, 6000.5, True):
        with pytest.raises(ValueError, match="within its iteration allowance"):
            continuation_end_iteration(3300, 6000, target)
    with pytest.raises(ValueError, match="positive exact"):
        continuation_end_iteration(0, 6000)


@pytest.mark.parametrize("transport", ["upwind", "linearUpwind limited"])
@pytest.mark.parametrize("pressure_advection", ["upwind", "vanLeer"])
def test_local_pressure_is_not_a_physical_time_history(tmp_path, transport, pressure_advection):
    (tmp_path / "system").mkdir()
    (tmp_path / "constant").mkdir()
    schemes = tmp_path / "system/fvSchemes"
    schemes.write_text(f"ddtSchemes {{ default steadyState; }} divSchemes {{ div(phi,h) bounded Gauss {transport}; div(phid,p) Gauss upwind; div(phiv,p) Gauss upwind; }}")
    thermo = tmp_path / "constant/thermophysicalProperties"
    thermo.write_text("source material fixture unchanged")
    receipt = configure_local_time_pressure(tmp_path, 0.3048, 233, pressure_advection)
    assert receipt["physical_time_history"] is False
    assert receipt["solver_family"] == "rhoPimpleFoam"
    assert receipt["steady_acceptance_certificate"] == "unavailable_experimental"
    assert receipt["maximum_local_step_seconds"] == pytest.approx(0.3048 / 233)
    assert "localEuler" in schemes.read_text()
    assert "bounded" not in schemes.read_text()
    assert f"Gauss {transport};" in schemes.read_text()
    assert f"div(phid,p) Gauss {pressure_advection};" in schemes.read_text()
    assert "div(phiv,p) Gauss upwind;" in schemes.read_text()
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


def test_pressure_advection_rejects_unknown_scheme_and_missing_entry_before_writing(tmp_path):
    with pytest.raises(ValueError, match="Unsupported"):
        configure_local_time_pressure(tmp_path, 0.3, 200, "invented")
    (tmp_path / "system").mkdir()
    path = tmp_path / "system/fvSchemes"
    original = "ddtSchemes { default steadyState; } divSchemes { div(phi,h) bounded Gauss upwind; }"
    path.write_text(original)
    with pytest.raises(ValueError, match="pressure-advection entry"):
        configure_local_time_pressure(tmp_path, 0.3, 200, "vanLeer")
    assert path.read_text() == original
    assert not (tmp_path / "system/fvSolution").exists()


def continuation_fixture(tmp_path, change=None):
    source, target = tmp_path / "source", tmp_path / "target"
    source.mkdir()
    target.mkdir()
    request = {"fixture": "same physical and numerical request"}
    execution = {"solver_family": "rhoPimpleFoam", "physical_time_history": False}
    report = {"request": request, "actual_execution": execution, "experimental_local_time_pressure": True,
              "outcome": "measured_uncertified", "pressure_iteration": 3000, "active_seconds": 100,
              "numerical_stability": {"pressure_limited_iterations": 0}}
    if change:
        report.update(change)
    shared = ("system/fvSchemes", "system/fvSolution", "system/controlDict", "constant/thermophysicalProperties",
              "constant/turbulenceProperties", "constant/numericalExecution.json")
    states = tuple(f"3000/{name}" for name in ("U", "p", "T", "k", "omega", "rho", "phi", "rDeltaT"))
    mesh = tuple(f"constant/polyMesh/{name}" for name in ("points", "faces", "owner", "neighbour", "boundary"))
    members = []
    for name in (*shared, *states, *mesh, "report.json"):
        raw = json.dumps(report).encode() if name == "report.json" else f"isolated state fixture {name}".encode()
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        if name in shared:
            destination = target / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(raw)
        members.append({"path": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    (source / "retained-source-manifest.json").write_text(json.dumps({"files": members, "sourceRevision": "fixture"}))
    return source, target, request, execution


@pytest.mark.parametrize("coordinate", [3000, 3000.0])
def test_uncertified_continuation_keeps_exact_state_and_cost_without_acceptance(tmp_path, coordinate):
    source, target, request, execution = continuation_fixture(tmp_path, {"pressure_iteration": coordinate})
    receipt = restore_local_pressure_state(source, target, request, execution)
    assert receipt["coordinate"] == 3000
    assert receipt["prior_active_seconds"] == 100
    assert receipt["kind"] == "uncertified_local_iteration_continuation"
    assert not (target / "report.json").exists()
    for name, digest in receipt["members"].items():
        assert (target / name).read_bytes() == (source / name).read_bytes()
        assert hashlib.sha256((target / name).read_bytes()).hexdigest() == digest
    with pytest.raises(ValueError, match="occupied"):
        restore_local_pressure_state(source, target, request, execution)


@pytest.mark.parametrize("change", [
    {"outcome": "failed"}, {"error": "thermal clamp"}, {"actual_execution": {"physical_time_history": True}},
    {"request": {"fixture": "different"}}, {"active_seconds": -1}, {"pressure_iteration": True},
    {"pressure_iteration": 3000.5}, {"pressure_iteration": float('inf')},
    {"accumulated_active_seconds": 99}, {"numerical_stability": {"pressure_limited_iterations": 1}},
])
def test_continuation_refuses_failed_incompatible_or_unaccounted_source(tmp_path, change):
    source, target, request, execution = continuation_fixture(tmp_path, change)
    with pytest.raises(ValueError):
        restore_local_pressure_state(source, target, request, execution)
    assert not (target / "3000").exists()


def test_continuation_rejects_changed_target_dictionary_and_unmanifested_source(tmp_path):
    source, target, request, execution = continuation_fixture(tmp_path)
    path = target / "system/fvSolution"
    original = path.read_bytes()
    path.write_text("different numerical setup")
    with pytest.raises(ValueError, match="dictionaries differ"):
        restore_local_pressure_state(source, target, request, execution)
    path.write_bytes(original)
    (source / "3000/unmanifested").write_text("unverified bytes")
    with pytest.raises(ValueError, match="unauthenticated"):
        restore_local_pressure_state(source, target, request, execution)
