import hashlib
from pathlib import Path

import pytest

from airfoilfoam.airfoil import Airfoil
from airfoilfoam.openfoam.execution import configure_flow_execution
from airfoilfoam.openfoam.rans_hold import root_entry
from airfoilfoam.pipeline import _case_builder
from airfoilfoam.meshing.blockmesh import BlockMeshCGrid
from scripts.materials.inspect_mach3_startup import measured_frames, preserve_early_frames, startup_request
from test_compressible_execution import RecordedRunner


ROOT = Path(__file__).parents[1]
GEOMETRY = ROOT / "packages/db/seed/selig-database/fx60100.dat"
MATERIAL = ROOT / "tests/fixtures/air-thermophysics-audit.json"


@pytest.mark.parametrize("courant", [4.0, 0.25])
def test_startup_study_preserves_the_source_request_and_local_time_contract(tmp_path, courant):
    original, request = startup_request(GEOMETRY, MATERIAL, courant)
    expected = original.model_dump(mode="json")
    expected["solver"]["n_iterations"] = 50
    assert request.model_dump(mode="json") == expected
    assert original.solver.n_iterations == 5000
    assert request.resources.case_solver_budget_seconds == 900
    assert request.aoa.expand() == [13]
    runner = RecordedRunner()
    configure_flow_execution(runner, request)
    airfoil = Airfoil.from_contour(request.airfoil.name, request.airfoil.points)
    _case_builder(runner, airfoil, BlockMeshCGrid().patches(request.mesh), request.mesh,
                  request.cases()[0], request.fluid, request.roughness, request.solver).write(tmp_path)
    originals = {path: path.read_bytes() for directory in ("0", "constant") for path in (tmp_path / directory).rglob("*") if path.is_file()}
    preserve_early_frames(tmp_path)
    assert all(path.read_bytes() == value for path, value in originals.items())
    control = (tmp_path / "system/controlDict").read_text()
    assert float(root_entry(control, "deltaT")) == 1
    assert float(root_entry(control, "endTime")) == 50
    assert float(root_entry(control, "maxCo")) == min(0.5, courant)
    assert float(root_entry(control, "writeInterval")) == 1
    assert float(root_entry(control, "purgeWrite")) == 0


@pytest.mark.parametrize("courant", [True, 0, -1, 0.1, 0.5, 1, float("nan")])
def test_diagnostic_does_not_silently_expand_the_numerical_comparison(courant):
    with pytest.raises(ValueError, match="comparison"):
        startup_request(GEOMETRY, MATERIAL, courant)


def write_ascii(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("FoamFile { format ascii; }\n" + body)


def field_fixture(directory):
    mesh = directory / "constant/polyMesh"
    write_ascii(mesh / "points", "8((0 0 0)(1 0 0)(1 1 0)(0 1 0)(0 0 1)(1 0 1)(1 1 1)(0 1 1))")
    write_ascii(mesh / "faces", "6(4(0 1 2 3)4(4 5 6 7)4(0 1 5 4)4(1 2 6 5)4(2 3 7 6)4(3 0 4 7))")
    write_ascii(mesh / "owner", "6(0 0 0 0 0 0)")
    write_ascii(mesh / "neighbour", "0()")
    for coordinate, temperature in [(1, 250), (2, 200)]:
        state = directory / str(coordinate)
        for name, value in {"T": temperature, "p": 100000, "k": 2, "omega": 10 * coordinate}.items():
            write_ascii(state / name, f"internalField nonuniform List<scalar> 1 ({value});")
        write_ascii(state / "U", "internalField nonuniform List<vector> 1 ((10 0 0));")


def test_each_early_field_is_measured_at_its_own_coordinate_with_source_hashes(tmp_path):
    field_fixture(tmp_path)
    write_ascii(tmp_path / "2/nut", "internalField uniform 0.01;")
    write_ascii(tmp_path / "2/alphat", "internalField uniform 0.01;")
    write_ascii(tmp_path / "2/uniform/time", "value 2;")
    frames, errors = measured_frames(tmp_path, 1)
    assert not errors
    assert [frame["coordinate"] for frame in frames] == [1, 2]
    assert [frame["extrema"]["minimum_temperature"]["temperature_k"] for frame in frames] == [250, 200]
    assert [frame["extrema"]["maximum_turbulence_omega"]["turbulence_omega_per_s"] for frame in frames] == [10, 20]
    assert frames[0]["extrema"]["minimum_temperature"]["vertex_average_over_chord"] == [0.5, 0.5, 0.5]
    assert frames[0]["field_sha256"]["T"] == hashlib.sha256((tmp_path / "1/T").read_bytes()).hexdigest()
    assert frames[0]["field_sha256"]["T"] != frames[1]["field_sha256"]["T"]
    assert {"nut", "alphat", "uniform/time"} <= frames[1]["field_sha256"].keys()


def test_missing_field_is_not_silently_replaced_by_another_iteration(tmp_path):
    field_fixture(tmp_path)
    (tmp_path / "1/T").unlink()
    frames, errors = measured_frames(tmp_path, 1)
    assert [frame["coordinate"] for frame in frames] == [2]
    assert len(errors) == 1 and errors[0]["coordinate"] == 1


def test_external_field_links_are_not_authenticated_as_retained_checkpoint_members(tmp_path):
    field_fixture(tmp_path)
    (tmp_path / "1/nut").symlink_to(tmp_path / "2/T")
    frames, errors = measured_frames(tmp_path, 1)
    assert [frame["coordinate"] for frame in frames] == [2]
    assert len(errors) == 1 and "external links" in errors[0]["error"]


@pytest.mark.parametrize("coordinate", ["1e-8", "51", "-1", "nan"])
def test_changed_clock_or_horizon_is_not_misreported_as_iteration_evidence(tmp_path, coordinate):
    field_fixture(tmp_path)
    (tmp_path / coordinate).mkdir()
    with pytest.raises(ValueError, match="coordinate"):
        measured_frames(tmp_path, 1)
