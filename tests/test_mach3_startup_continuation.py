import hashlib
import json
from pathlib import Path

import pytest

from airfoilfoam.openfoam.rans_hold import root_entry
from scripts.materials.continue_mach3_startup import force_summary, load_checkpoint, prepare_continuation
from scripts.materials.inspect_mach3_startup import startup_request


ROOT = Path(__file__).parents[1]
GEOMETRY = ROOT / "packages/db/seed/selig-database/fx60100.dat"
MATERIAL = ROOT / "tests/fixtures/air-thermophysics-audit.json"


def checksum(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checkpoint(directory):
    original, request = startup_request(GEOMETRY, MATERIAL, 0.25)
    directory.mkdir()
    files = {"constant/polyMesh/" + name: "explicit synthetic mesh fixture" for name in ("points", "faces", "owner", "neighbour", "boundary")}
    files.update({"50/" + name: "explicit synthetic restart field" for name in ("U", "T", "p", "rho", "k", "omega", "nut", "alphat", "rDeltaT")})
    files.update({"constant/thermophysicalProperties": "explicit synthetic material fixture",
                  "constant/numericalExecution.json": '{"time_coordinate":"local_pseudo_time_iterations"}',
                  "system/fvSchemes": "ddtSchemes { default localEuler; }", "system/fvSolution": "solvers {}",
                  "system/controlDict": "deltaT 1;\nendTime 50;\nmaxCo 0.25;\nstartFrom startTime;\nwriteInterval 1;\npurgeWrite 0;\n",
                  "50/uniform/time": "value 50;\nindex 50;\ndeltaT 1;\ndeltaT0 1;\n",
                  "log.rhoCentralFoam": "explicit synthetic solver log"})
    for name, value in files.items():
        path = directory / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value)
    hashes = {name: checksum(directory / name) for name in files}
    frame_hashes = {name.removeprefix("50/"): value for name, value in hashes.items() if name.startswith("50/")}
    report = {"kind": "mach3-local-startup-fields-v1", "production_evidence": False,
              "outcome": "short_diagnostic_completed", "native_returncode": 0, "material_error": None, "frame_errors": [],
              "original_request": original.model_dump(mode="json"), "request": request.model_dump(mode="json"),
              "frames": [{"coordinate": coordinate, "field_sha256": frame_hashes} for coordinate in range(1, 51)],
              "input_sha256": {name: value for name, value in hashes.items() if not name.startswith("50/") and name != "log.rhoCentralFoam"},
              "solver_log_sha256": hashes["log.rhoCentralFoam"], "solver_active_seconds": 7.0}
    (directory / "source-report.json").write_text(json.dumps(report))
    manifest = {"kind": "mach3-diagnostic-last-state-subset-v1", "coordinate": 50, "accepted_cfd": False,
                "source_report_sha256": checksum(directory / "source-report.json"), "files": hashes}
    (directory / "manifest.json").write_text(json.dumps(manifest))
    return checksum(directory / "manifest.json")


@pytest.mark.parametrize("courant,request_courant", [(0.25, 0.25), (0.5, 4.0)])
def test_continuation_preserves_every_source_field_and_the_original_budget(tmp_path, courant, request_courant):
    source = tmp_path / "source"
    signature = checkpoint(source)
    before = {path: path.read_bytes() for path in source.rglob("*") if path.is_file()}
    manifest, report, request, remaining = prepare_continuation(source, tmp_path / "new", signature, GEOMETRY, MATERIAL, courant)
    assert remaining == 893 and request.solver.n_iterations == 5000
    assert request.solver.transient_max_courant == request_courant
    assert all(path.read_bytes() == value for path, value in before.items())
    for name, expected in manifest["files"].items():
        if name != "system/controlDict":
            target = tmp_path / "new" / ("source-log.rhoCentralFoam" if name == "log.rhoCentralFoam" else name)
            assert checksum(target) == expected
    control = (tmp_path / "new/system/controlDict").read_text()
    assert root_entry(control, "startFrom") == "latestTime"
    assert float(root_entry(control, "deltaT")) == 1
    assert float(root_entry(control, "endTime")) == 5000
    assert float(root_entry(control, "maxCo")) == courant


@pytest.mark.parametrize("mutation", ["manifest", "report", "field", "missing", "symlink"])
def test_corrupt_checkpoint_is_rejected_before_creating_the_new_case(tmp_path, mutation):
    source, destination = tmp_path / "source", tmp_path / "destination"
    signature = checkpoint(source)
    if mutation == "manifest":
        (source / "manifest.json").write_text("{}")
    elif mutation == "report":
        (source / "source-report.json").write_text("{}")
    elif mutation == "field":
        (source / "50/T").write_text("changed")
    elif mutation == "missing":
        (source / "50/T").unlink()
    else:
        target = source / "50/T"
        target.unlink()
        target.symlink_to(source / "50/p")
    with pytest.raises(ValueError):
        prepare_continuation(source, destination, signature, GEOMETRY, MATERIAL, 0.5)
    assert not destination.exists()


@pytest.mark.parametrize("consumed", [-1, 0, 900, 901, True, float("nan")])
def test_invalid_remaining_budget_is_not_increased_to_get_a_run(tmp_path, consumed):
    source = tmp_path / "source"
    checkpoint(source)
    report_path = source / "source-report.json"
    report = json.loads(report_path.read_text())
    report["solver_active_seconds"] = consumed
    report_path.write_text(json.dumps(report))
    manifest_path = source / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["source_report_sha256"] = checksum(report_path)
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        load_checkpoint(source, checksum(manifest_path), GEOMETRY, MATERIAL)


@pytest.mark.parametrize("mutation", ["different-angle", "failed-source", "different-clock"])
def test_resealed_but_incompatible_source_is_still_rejected(tmp_path, mutation):
    source = tmp_path / "source"
    checkpoint(source)
    report_path, manifest_path = source / "source-report.json", source / "manifest.json"
    report, manifest = json.loads(report_path.read_text()), json.loads(manifest_path.read_text())
    if mutation == "different-angle":
        report["original_request"]["aoa"]["angles"] = [12]
    elif mutation == "failed-source":
        report["native_returncode"] = -15
    else:
        clock = source / "50/uniform/time"
        clock.write_text(clock.read_text().replace("deltaT 1;", "deltaT 0.5;"))
        changed = checksum(clock)
        report["frames"][-1]["field_sha256"]["uniform/time"] = changed
        manifest["files"]["50/uniform/time"] = changed
    report_path.write_text(json.dumps(report))
    manifest["source_report_sha256"] = checksum(report_path)
    manifest_path.write_text(json.dumps(manifest))
    with pytest.raises(ValueError):
        load_checkpoint(source, checksum(manifest_path), GEOMETRY, MATERIAL)


@pytest.mark.parametrize("courant", [True, -1, 0, 0.3, 4, float("nan")])
def test_only_the_declared_continuation_variants_can_be_launched(tmp_path, courant):
    source = tmp_path / "source"
    signature = checkpoint(source)
    with pytest.raises(ValueError, match="Courant"):
        prepare_continuation(source, tmp_path / "new", signature, GEOMETRY, MATERIAL, courant)
    assert not (tmp_path / "new").exists()


def force_fixture(directory, rows):
    path = directory / "postProcessing/forceCoeffs1/50/coefficient.dat"
    path.parent.mkdir(parents=True)
    path.write_text("# Time Cd Cl CmPitch\n" + rows)


def test_force_measurement_excludes_initial_state_and_keeps_short_hold_unavailable(tmp_path):
    force_fixture(tmp_path, "50 0.3 9 4\n51 0.02 0.2 -0.03\n52 0.04 0.4 -0.05\n")
    measured = force_summary(tmp_path)
    assert measured["samples"] == 2 and measured["initial_samples"] == 1
    assert measured["coefficients"] == pytest.approx({"cd": 0.03, "cl": 0.3, "cm": -0.04})
    assert measured["force_hold"] is None


def test_an_initial_force_row_is_not_new_solver_progress(tmp_path):
    force_fixture(tmp_path, "50 0.3 9 4\n")
    measured = force_summary(tmp_path)
    assert measured["samples"] == 0 and measured["initial_samples"] == 1
    assert measured["coefficients"] is None and measured["force_hold"] is None


@pytest.mark.parametrize("rows", ["49 0.02 0.2 -0.03\n", "5001 0.02 0.2 -0.03\n", "51.5 0.02 0.2 -0.03\n", "51 0.02 nan -0.03\n", "51 0.02 0.2\n", "51 0.02 0.2 -0.03\n51 0.02 0.2 -0.03\n"])
def test_initial_corrupt_and_repeated_force_coordinates_are_not_counted(tmp_path, rows):
    force_fixture(tmp_path, rows)
    with pytest.raises(ValueError):
        force_summary(tmp_path)
