from pathlib import Path

import pytest

from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.meshing import get_mesher, list_meshers
from airfoilfoam.meshing.cartesian2d import (
    CARTESIAN2D_EXTERNAL_MESHER,
    CARTESIAN2D_SURFACE_FILE,
    Cartesian2DExternalMesh,
)
from airfoilfoam.models import AirfoilFormat, MeshParams
from airfoilfoam.openfoam.runner import (
    DeterministicMeshError,
    InfrastructureError,
    RunResult,
)


SELIG_SEED_DIR = Path(__file__).resolve().parents[1] / "packages/db/seed/selig-database"


class _SequenceRunner:
    def __init__(self, *results: RunResult):
        self.results = list(results)
        self.commands: list[str] = []

    def application(self, _case_dir, command, *args, **kwargs):
        self.commands.append(command)
        return self.results.pop(0)


def _write_owner(case_dir: Path, labels: list[int], *, declared_count=None):
    owner = case_dir / "constant" / "polyMesh" / "owner"
    owner.parent.mkdir(parents=True, exist_ok=True)
    count = len(labels) if declared_count is None else declared_count
    owner.write_text(
        """FoamFile
{
    version 2.0;
    format ascii;
    class labelList;
    location "constant/polyMesh";
    object owner;
}

"""
        + str(count)
        + "\n(\n"
        + "\n".join(str(label) for label in labels)
        + "\n)\n"
    )


def _airfoil(name: str):
    return load_airfoil(
        name,
        (SELIG_SEED_DIR / f"{name}.dat").read_text(),
        None,
        AirfoilFormat.auto,
    )


def test_cartesian2d_mesher_is_internal_and_fingerprinted():
    mesher = get_mesher(CARTESIAN2D_EXTERNAL_MESHER)

    assert isinstance(mesher, Cartesian2DExternalMesh)
    assert mesher.user_selectable is False
    assert mesher.cache_version == "cfmesh-cartesian2d-external-layers-v1"
    assert CARTESIAN2D_EXTERNAL_MESHER not in list_meshers()
    assert CARTESIAN2D_EXTERNAL_MESHER in list_meshers(include_internal=True)
    assert [(patch.name, patch.role) for patch in mesher.patches(MeshParams())] == [
        ("airfoil", "wall"),
        ("inlet", "inlet"),
        ("outlet", "outlet"),
        ("bottomEmptyFaces", "empty"),
        ("topEmptyFaces", "empty"),
    ]


def test_cartesian2d_inputs_preserve_trusted_notch_and_physical_domain(tmp_path):
    airfoil = _airfoil("goe451")
    params = MeshParams(
        farfield_radius_chords=15,
        wake_length_chords=10,
        span_chords=0.1,
        n_surface=65,
        n_radial=40,
        n_wake=30,
        first_cell_height_chords=0.003,
    )
    mesher = Cartesian2DExternalMesh()

    mesher.write_inputs(tmp_path, airfoil, params, chord=0.05)

    surface = (tmp_path / CARTESIAN2D_SURFACE_FILE).read_text()
    mesh_dict = (tmp_path / "system" / "meshDict").read_text()
    # Authoritative GOE451 upper-surface notch, scaled only by the real chord.
    assert "(0.0012475 0 0)" in surface
    assert "(0.000623 0.000602 0)" in surface
    # Exact requested farfield, outlet and span extents in metres.
    assert "(-0.75 -0.75 0)" in surface
    assert "(0.55 0.75 0)" in surface
    assert "(-0.75 -0.75 0.005)" in surface
    # Resolution controls map deterministically to cfMesh controls.
    assert "maxCellSize 0.0166666666667;" in mesh_dict
    assert "cellSize 0.000769230769231;" in mesh_dict
    assert "maxFirstLayerThickness 0.00015;" in mesh_dict
    assert "nLayers 6;" in mesh_dict


def test_cartesian2d_run_records_real_cell_count_and_logs(tmp_path):
    mesher = Cartesian2DExternalMesh()
    runner = _SequenceRunner(RunResult("cartesian2DMesh", 0, "mesh generated\n"))
    _write_owner(tmp_path, [0, 1, 1, 12344, 12])

    result = mesher.run_mesh(tmp_path, MeshParams(), runner)

    assert runner.commands == ["cartesian2DMesh"]
    assert result.n_cells == 12345
    assert (tmp_path / "log.cartesian2DMesh").read_text() == "mesh generated\n"


@pytest.mark.parametrize(
    "owner_setup",
    [
        lambda path: None,
        lambda path: _write_owner(path, [0, 1], declared_count=3),
    ],
    ids=("missing-owner", "inconsistent-owner"),
)
def test_cartesian2d_unreadable_mesh_output_is_infrastructure(owner_setup, tmp_path):
    mesher = Cartesian2DExternalMesh()
    owner_setup(tmp_path)

    with pytest.raises(InfrastructureError, match="owner"):
        mesher.run_mesh(
            tmp_path,
            MeshParams(),
            _SequenceRunner(RunResult("cartesian2DMesh", 0, "mesh generated\n")),
        )


@pytest.mark.parametrize(
    "result",
    [
        RunResult("cartesian2DMesh", 127, "command not found\n"),
        RunResult("cartesian2DMesh", 137, "Killed\n"),
        RunResult("cartesian2DMesh", 124, "partial output\n", timed_out=True),
    ],
    ids=("unsupported-tool", "process-kill", "timeout"),
)
def test_cartesian2d_infrastructure_failure_never_becomes_geometry(result, tmp_path):
    mesher = Cartesian2DExternalMesh()

    with pytest.raises(InfrastructureError):
        mesher.run_mesh(tmp_path, MeshParams(), _SequenceRunner(result))


def test_cartesian2d_deterministic_mesher_rejection_remains_repair_evidence(tmp_path):
    mesher = Cartesian2DExternalMesh()
    result = RunResult("cartesian2DMesh", 1, "Surface is not closed\n")

    with pytest.raises(DeterministicMeshError, match="rejected the requested geometry"):
        mesher.run_mesh(tmp_path, MeshParams(), _SequenceRunner(result))
