import pytest

from airfoilfoam.airfoil import load_airfoil
from airfoilfoam.meshing import get_mesher, list_meshers
from airfoilfoam.meshing.blockmesh import BlockMeshCGrid, solve_expansion
from airfoilfoam.models import AirfoilFormat, MeshParams


def test_mesher_registered():
    assert "blockmesh-cgrid" in list_meshers()
    assert isinstance(get_mesher("blockmesh-cgrid"), BlockMeshCGrid)


def test_solve_expansion_reproduces_length():
    d, L, n = 1e-4, 10.0, 80
    g = solve_expansion(d, L, n)
    # reconstruct per-cell ratio from last/first = r**(n-1)
    r = g ** (1.0 / (n - 1))
    total = d * (r**n - 1) / (r - 1)
    assert total == pytest.approx(L, rel=1e-3)
    assert g > 1.0


def test_build_dict_structure(naca0012_selig_text):
    af = load_airfoil("naca0012", naca0012_selig_text, None, AirfoilFormat.auto)
    mp = MeshParams(n_surface=60, n_radial=50, n_wake=40, first_cell_height_chords=1e-4)
    text = BlockMeshCGrid().build_dict(af, mp, chord=0.5)

    assert "scale 0.5;" in text
    # 10 base vertices x 2 z-layers
    assert text.count("(", text.index("vertices")) >= 20
    # four blocks
    assert text.count("hex (") == 4
    # boundary patches and the wake-cut merge
    for patch in ("airfoil", "freestream", "frontAndBack", "wakeUpper", "wakeLower"):
        assert patch in text
    assert "mergePatchPairs" in text
    assert "(wakeUpper wakeLower)" in text
    # airfoil spline edges present
    assert "spline 0 1" in text
    assert "spline 1 2" in text


def test_cell_count(naca0012_selig_text):
    mp = MeshParams(n_surface=100, n_radial=60, n_wake=40)
    assert BlockMeshCGrid().cell_count(mp) == 2 * 100 * 60 + 2 * 40 * 60


def test_patches_roles():
    mp = MeshParams()
    patches = BlockMeshCGrid().patches(mp)
    roles = {p.role for p in patches}
    assert roles == {"wall", "freestream", "empty"}
