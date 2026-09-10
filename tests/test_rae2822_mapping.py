from copy import deepcopy
import hashlib
import json

import pytest

from scripts.materials.rae2822_mapping import authenticated_mapping_source, map_verified_initial_fields


def mapping_fixture(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    request = {"airfoil": {"coordinates": "isolated fixture"}, "speeds": [200], "mesh": {
        "n_surface": 128, "n_radial": 80, "n_wake": 64, "target_y_plus": 40},
        "solver": {"n_iterations": 3000, "convergence_tolerance": 1e-5, "momentum_scheme": "upwind"}}
    report = {"request": request, "outcome": "measured_converged", "convergence": {"converged": True},
              "pressure_iteration": 2000, "experimental_energy_form": "sensibleEnthalpy", "experimental_momentum_scheme": "upwind"}
    paths = [f"2000/{name}" for name in ("U", "p", "T", "k", "omega")]
    paths += [f"constant/polyMesh/{name}" for name in ("points", "faces", "owner", "neighbour", "boundary")]
    paths += ["system/controlDict", "constant/thermophysicalProperties", "constant/turbulenceProperties", "report.json"]
    members = []
    for name in paths:
        path = source / name
        path.parent.mkdir(parents=True, exist_ok=True)
        raw = json.dumps(report).encode() if name == "report.json" else b"isolated fixture"
        path.write_bytes(raw)
        members.append({"path": name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    (source / "retained-source-manifest.json").write_text(json.dumps({"files": members, "sourceRevision": "fixture-only"}))
    target = deepcopy(request)
    for key in ("n_surface", "n_radial", "n_wake"):
        target["mesh"][key] *= 2
    target["solver"]["n_iterations"] = 6000
    return source, target


def test_mapping_source_authenticates_real_bytes_and_only_permits_resolution_change(tmp_path):
    source, target = mapping_fixture(tmp_path)
    before = {str(path.relative_to(source)): path.read_bytes() for path in source.rglob("*") if path.is_file()}
    receipt = authenticated_mapping_source(source, target, {"experimental_energy_form": "sensibleEnthalpy", "experimental_local_time_pressure": False})
    assert receipt["coordinate"] == 2000
    assert receipt["report_sha256"] == hashlib.sha256(before["report.json"]).hexdigest()
    assert before == {str(path.relative_to(source)): path.read_bytes() for path in source.rglob("*") if path.is_file()}
    for field, value in [("speeds", [201]), ("airfoil", {"coordinates": "foreign"})]:
        with pytest.raises(ValueError, match="setup differs"):
            authenticated_mapping_source(source, {**target, field: value}, {})
    changed = deepcopy(target)
    changed["mesh"]["target_y_plus"] = 1
    with pytest.raises(ValueError, match="setup differs"):
        authenticated_mapping_source(source, changed, {})
    with pytest.raises(ValueError, match="experimental recipe"):
        authenticated_mapping_source(source, target, {"experimental_energy_form": "sensibleInternalEnergy"})
    (source / "2000/p").write_text("corrupt")
    with pytest.raises(ValueError, match="checksum or size"):
        authenticated_mapping_source(source, target, {})


def test_mapping_refuses_same_scope_before_any_command(tmp_path):
    source, target = mapping_fixture(tmp_path)
    with pytest.raises(ValueError, match="separate scopes"):
        map_verified_initial_fields(None, source, source / "nested", target, {})


def test_mapping_checks_the_target_mesh_and_preserves_initialization_identity(tmp_path):
    from unittest.mock import Mock

    source, request = mapping_fixture(tmp_path)
    request["fluid"] = {"gas": {"nasa7": {"minimum_temperature_k": 150, "maximum_temperature_k": 1500}}}
    manifest_path = source / "retained-source-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    report_path = source / "report.json"
    report = json.loads(report_path.read_text())
    report["request"]["fluid"] = request["fluid"]
    raw = json.dumps(report).encode()
    report_path.write_bytes(raw)
    manifest["files"][-1].update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
    manifest_path.write_text(json.dumps(manifest))
    destination = tmp_path / "target"
    (destination / "0").mkdir(parents=True)
    (destination / "constant/polyMesh").mkdir(parents=True)
    (destination / "constant/polyMesh/owner").write_text("FoamFile { format ascii; }\n2(0 1)")
    for name, values in {"U": "(200 1 0) (200 2 0)", "p": "100000 100001", "T": "250 251", "k": "1 1", "omega": "2 2"}.items():
        kind = "vector" if name == "U" else "scalar"
        (destination / "0" / name).write_text(f"FoamFile {{ format ascii; }}\ninternalField nonuniform List<{kind}> 2({values});")
    runner = Mock()
    runner.application.return_value.stdout = "isolated native mapping fixture"
    receipt = map_verified_initial_fields(runner, source, destination, request, {})
    assert receipt["kind"] == "mapped_initial_conditions_not_solver_evidence"
    assert receipt["target_coordinate"] == 0
    assert receipt["mapped_fields"]["U"]["cells"] == 2
    assert "-sourceTime 2000 -consistent -mapMethod interpolate" in receipt["command"]
    runner.application.return_value.check.assert_called_once_with()
    (destination / "constant/polyMesh/owner").write_text("FoamFile { format ascii; }\n3(0 1 2)")
    with pytest.raises(ValueError, match="target mesh"):
        map_verified_initial_fields(runner, source, destination, request, {})


@pytest.mark.parametrize("mutation", ["unconverged", "missing", "duplicate", "traversal", "symlink"])
def test_mapping_rejects_unsafe_or_incomplete_donor(tmp_path, mutation):
    source, target = mapping_fixture(tmp_path)
    manifest_path = source / "retained-source-manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if mutation == "unconverged":
        report_path = source / "report.json"
        report = json.loads(report_path.read_text())
        report["convergence"]["converged"] = False
        raw = json.dumps(report).encode()
        report_path.write_bytes(raw)
        manifest["files"][-1].update(bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
    elif mutation == "missing":
        manifest["files"] = [member for member in manifest["files"] if member["path"] != "2000/U"]
    elif mutation == "duplicate":
        manifest["files"].append(manifest["files"][0])
    elif mutation == "traversal":
        manifest["files"][0]["path"] = "../foreign"
    else:
        path = source / "2000/U"
        path.unlink()
        path.symlink_to(source / "2000/p")
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        authenticated_mapping_source(source, target, {})
