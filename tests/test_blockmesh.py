import math
from pathlib import Path

import pytest

from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.meshing import get_mesher, list_meshers
from airfoilfoam.meshing.blockmesh import (
    SEGMENTED_NORMAL_COUNTS,
    SURFACE_BLOCK_SEGMENTS,
    BlockMeshCGrid,
    _normal_aligned_outer_angles,
    solve_expansion,
)
from airfoilfoam.models import AirfoilFormat, MeshParams
from airfoilfoam.openfoam.runner import (
    DeterministicMeshError,
    InfrastructureError,
    RunResult,
)


SELIG_SEED_DIR = Path(__file__).resolve().parents[1] / "packages/db/seed/selig-database"


def test_mesher_registered():
    assert "blockmesh-cgrid" in list_meshers()
    legacy = get_mesher("blockmesh-cgrid")
    assert isinstance(legacy, BlockMeshCGrid)
    assert legacy.topology == "legacy"
    assert legacy.user_selectable is True
    for segments in SEGMENTED_NORMAL_COUNTS:
        name = f"blockmesh-cgrid-segmented-normal-{segments}"
        candidate = get_mesher(name)
        assert isinstance(candidate, BlockMeshCGrid)
        assert candidate.topology == "segmented-normal"
        assert candidate.surface_segments == segments
        assert candidate.user_selectable is False
        assert candidate.cache_version != legacy.cache_version
        assert name not in list_meshers()
        assert name in list_meshers(include_internal=True)


def test_candidate_constructor_rejects_unfingerprinted_variants():
    with pytest.raises(ValueError, match="must be one of"):
        BlockMeshCGrid.segmented_normal(21)
    with pytest.raises(ValueError, match="does not accept"):
        BlockMeshCGrid(surface_segments=20)


def test_solve_expansion_reproduces_length():
    d, L, n = 1e-4, 10.0, 80
    g = solve_expansion(d, L, n)
    # reconstruct per-cell ratio from last/first = r**(n-1)
    r = g ** (1.0 / (n - 1))
    total = d * (r**n - 1) / (r - 1)
    assert total == pytest.approx(L, rel=1e-3)
    assert g > 1.0


def test_default_build_dict_preserves_legacy_four_block_structure(naca0012_selig_text):
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    mp = MeshParams(n_surface=60, n_radial=50, n_wake=40, first_cell_height_chords=1e-4)
    text = BlockMeshCGrid().build_dict(af, mp, chord=0.5)

    assert "scale 0.5;" in text
    assert text.count("hex (") == 4
    for block in ("UA", "LA", "UW", "LW"):
        assert f"// {block}" in text
    assert "// UA00" not in text
    assert "( (0.5 0.5 6.0) (0.5 0.5 0.16666666666666666) )" in text
    for patch in ("airfoil", "inlet", "outlet", "frontAndBack", "wakeUpper", "wakeLower"):
        assert patch in text
    assert "(wakeUpper wakeLower)" in text


@pytest.mark.parametrize("segments", SEGMENTED_NORMAL_COUNTS)
def test_segmented_candidate_structure_is_explicit_and_fingerprinted(
    naca0012_selig_text, segments
):
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    mp = MeshParams(n_surface=65, n_radial=40, n_wake=30, first_cell_height_chords=1e-4)
    mesher = BlockMeshCGrid.segmented_normal(segments)
    text = mesher.build_dict(af, mp, chord=0.5)

    assert text.count("hex (") == 2 * segments + 2
    for side in ("UA", "LA"):
        for segment in range(segments):
            assert f"// {side}{segment:02d}" in text
    assert "// UW" in text
    assert "// LW" in text
    for patch in ("airfoil", "inlet", "outlet", "frontAndBack", "wakeUpper", "wakeLower"):
        assert patch in text
    assert "(wakeUpper wakeLower)" in text
    assert "spline 0 1" in text
    assert text.count("spline ") >= 2 * segments
    assert mesher.cache_version == f"segmented-normal-{segments}-v1"


@pytest.mark.parametrize("segments", SEGMENTED_NORMAL_COUNTS)
@pytest.mark.parametrize("n_surface", [40, 61, 130])
def test_segmented_surface_blocks_conserve_requested_cells(
    naca0012_selig_text, n_surface, segments
):
    """A topology repair must not silently add/drop streamwise cells.

    The non-divisible 61-cell case is a false-positive guard against assuming
    every real mesh count is an exact multiple of the topology segment count.
    """
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    mp = MeshParams(
        n_surface=n_surface,
        n_radial=40,
        n_wake=30,
        first_cell_height_chords=1e-4,
    )
    text = BlockMeshCGrid.segmented_normal(segments).build_dict(af, mp, chord=1.0)

    counts: dict[str, list[int]] = {"UA": [], "LA": []}
    for line in text.splitlines():
        for side in counts:
            if f"// {side}" in line:
                divisions = [
                    int(value)
                    for value in line.split(") (", 1)[1].split(")", 1)[0].split()[:2]
                ]
                counts[side].append(next(value for value in divisions if value != 40))

    expected_segments = min(segments, n_surface)
    assert len(counts["UA"]) == expected_segments
    assert len(counts["LA"]) == expected_segments
    assert sum(counts["UA"]) == n_surface
    assert sum(counts["LA"]) == n_surface
    assert min(counts["UA"]) >= 1
    assert counts["UA"] == counts["LA"]


@pytest.mark.parametrize("name", ["2032c", "n0012", "clarky", "s1223", "sd8020"])
def test_normal_aligned_outer_angles_preserve_c_grid_order_for_real_airfoils(name):
    """Normal alignment must never cross radial interfaces on unusual shapes.

    20-32C is the inverted-cell must-catch. The other real seed profiles guard
    against fixing that cambered nose by destabilising ordinary symmetric,
    classic cambered, concave-cove, or low-camber geometries.
    """
    path = SELIG_SEED_DIR / f"{name}.dat"
    af = load_airfoil(name, path.read_text(), None, AirfoilFormat.auto)
    upper, lower = af.resampled_surfaces(65)
    segments = min(SURFACE_BLOCK_SEGMENTS, 65)
    cuts = [round(i * 65 / segments) for i in range(segments + 1)]

    upper_angles = _normal_aligned_outer_angles(upper[::-1], cuts, 0.5 * math.pi, math.pi)
    lower_angles = _normal_aligned_outer_angles(lower, cuts, math.pi, 1.5 * math.pi)

    for angles, start, end in (
        (upper_angles, 0.5 * math.pi, math.pi),
        (lower_angles, math.pi, 1.5 * math.pi),
    ):
        assert len(angles) == segments + 1
        assert angles[0] == pytest.approx(start)
        assert angles[-1] == pytest.approx(end)
        assert all(b > a for a, b in zip(angles, angles[1:]))


@pytest.mark.parametrize("segments", SEGMENTED_NORMAL_COUNTS)
@pytest.mark.parametrize("name", ["naca1", "ua79sfm"])
def test_segmented_preflight_rejects_authoritative_open_catalog_contours(name, segments):
    """Must-catch unsupported open records before OpenFOAM sees a folded block.

    naca1 is a one-sided cowl curve and ua79sfm is an isolated main element.
    Both records are authoritative source data, but neither supplies a closed
    exterior airfoil for this solver.  The mesher must reject the resulting
    non-convex passage instead of inventing the absent surface/component.
    """
    af = load_airfoil(
        name,
        (SELIG_SEED_DIR / f"{name}.dat").read_text(),
        None,
        AirfoilFormat.auto,
    )
    mp = MeshParams(n_surface=65, n_radial=40, n_wake=30, first_cell_height_chords=0.003)

    with pytest.raises(DeterministicMeshError, match="segmented topology preflight failed"):
        BlockMeshCGrid.segmented_normal(segments).build_dict(af, mp, chord=0.05)


@pytest.mark.parametrize("segments", SEGMENTED_NORMAL_COUNTS)
def test_segmented_preflight_scans_every_seed_without_silent_fold(segments):
    """Full 1,621-profile regression: emit a preflighted mesh or reject it.

    The healthy set spans the production incident, corrected E850, symmetric,
    classic-camber, concave-cove, and low-camber shapes.  The two authoritative
    but open records are must-catches.  The test intentionally executes the
    same candidate on every real seed rather than fixtures shaped like the
    implementation.
    """
    paths = sorted(SELIG_SEED_DIR.glob("*.dat"))
    assert len(paths) == 1621
    mesher = BlockMeshCGrid.segmented_normal(segments)
    mp = MeshParams(n_surface=65, n_radial=40, n_wake=30, first_cell_height_chords=0.003)
    emitted: set[str] = set()
    rejected: set[str] = set()

    for path in paths:
        af = load_airfoil(path.stem, path.read_text(), None, AirfoilFormat.auto)
        try:
            text = mesher.build_dict(af, mp, chord=0.05)
        except DeterministicMeshError as exc:
            assert "segmented topology preflight failed" in str(exc)
            rejected.add(path.stem)
        else:
            assert text.count("hex (") == 2 * segments + 2
            emitted.add(path.stem)

    assert emitted.isdisjoint(rejected)
    assert emitted | rejected == {path.stem for path in paths}
    assert {"2032c", "e850", "n0012", "clarky", "s1223", "sd8020"} <= emitted
    assert {"naca1", "ua79sfm"} <= rejected


def test_cell_count(naca0012_selig_text):
    mp = MeshParams(n_surface=100, n_radial=60, n_wake=40)
    assert BlockMeshCGrid().cell_count(mp) == 2 * 100 * 60 + 2 * 40 * 60


def test_patches_roles():
    mp = MeshParams()
    patches = BlockMeshCGrid().patches(mp)
    roles = {p.role for p in patches}
    assert roles == {"wall", "inlet", "outlet", "empty"}


class _BlockMeshResultRunner:
    def __init__(self, result: RunResult):
        self.result = result

    def application(self, _case_dir, command, *args, **kwargs):
        assert command == "blockMesh"
        return self.result


@pytest.mark.parametrize("returncode", [137, 143, -9, -15])
def test_blockmesh_process_kill_is_infrastructure(tmp_path, returncode):
    """MUST-CATCH: worker/process kills must never advance geometry recovery."""
    runner = _BlockMeshResultRunner(
        RunResult(
            command="blockMesh",
            returncode=returncode,
            stdout="process terminated while allocating mesh\n",
        )
    )

    with pytest.raises(InfrastructureError, match="terminated by the execution environment"):
        BlockMeshCGrid().run_mesh(tmp_path, MeshParams(), runner)


def test_blockmesh_timeout_is_infrastructure(tmp_path):
    runner = _BlockMeshResultRunner(
        RunResult(
            command="blockMesh",
            returncode=124,
            stdout="Command timed out after 300s\n",
            timed_out=True,
        )
    )

    with pytest.raises(InfrastructureError, match="timed out"):
        BlockMeshCGrid().run_mesh(tmp_path, MeshParams(), runner)


@pytest.mark.parametrize("returncode", [125, 126, 127])
def test_blockmesh_launch_failure_is_infrastructure(tmp_path, returncode):
    runner = _BlockMeshResultRunner(
        RunResult(
            command="blockMesh",
            returncode=returncode,
            stdout="blockMesh: command unavailable\n",
        )
    )

    with pytest.raises(InfrastructureError, match="unavailable in the execution environment"):
        BlockMeshCGrid().run_mesh(tmp_path, MeshParams(), runner)


def test_blockmesh_oom_signature_is_infrastructure(tmp_path):
    runner = _BlockMeshResultRunner(
        RunResult(
            command="blockMesh",
            returncode=1,
            stdout="Out of memory: Killed process 123 (blockMesh)\n",
        )
    )

    with pytest.raises(InfrastructureError, match="out-of-memory"):
        BlockMeshCGrid().run_mesh(tmp_path, MeshParams(), runner)


def test_blockmesh_real_geometry_rejection_remains_deterministic(tmp_path):
    """False-positive guard: an ordinary blockMesh fatal stays repairable."""
    runner = _BlockMeshResultRunner(
        RunResult(
            command="blockMesh",
            returncode=1,
            stdout=(
                "FOAM FATAL ERROR: Inconsistent point locations between block pair\n"
            ),
        )
    )

    with pytest.raises(DeterministicMeshError, match="rejected the requested geometry"):
        BlockMeshCGrid().run_mesh(tmp_path, MeshParams(), runner)


def test_blockmesh_success_persists_real_stdout(tmp_path):
    runner = _BlockMeshResultRunner(
        RunResult(command="blockMesh", returncode=0, stdout="nCells: 7600\nEnd\n")
    )

    result = BlockMeshCGrid().run_mesh(tmp_path, MeshParams(), runner)

    assert result.n_cells == 7600
    assert (tmp_path / "log.blockMesh").read_text() == "nCells: 7600\nEnd\n"
