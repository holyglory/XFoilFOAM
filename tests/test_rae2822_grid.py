import numpy as np
import pytest

from scripts.materials.rae2822_grid import extruded_c_grid, grid_nonorthogonality, parse_plot3d_grid, write_nasa_grid


def small_grid():
    return np.array([
        [[3, 0], [1, 0], [0, -0.5], [-1, 0], [0, 0.5], [1, 0], [3, 0]],
        [[3, -2], [1, -2], [-1, -2], [-2, 0], [-1, 2], [1, 2], [3, 2]],
    ])


def test_plot3d_coordinate_order_and_cardinality():
    grid = parse_plot3d_grid(b"2 2\n0 1 0 1\n0 0 1 1\n")
    assert grid.shape == (2, 2, 2)
    assert grid[1, 0].tolist() == [0, 1]
    for raw in [b"", b"2 2 0", b"2 2 0 1 0 1 0 0 1 nan", b"-2 2"]:
        with pytest.raises(ValueError):
            parse_plot3d_grid(raw)


def test_c_grid_welds_only_wake_and_owns_all_faces():
    mesh = extruded_c_grid(small_grid(), 1, 5, 2, 0.1)
    assert mesh["cells"] == 6
    assert len(mesh["points"]) == 24
    assert {name: len(rows) for name, rows in mesh["boundary"].items()} == {"inlet": 6, "outlet": 2, "airfoil": 4, "frontAndBack": 12}
    assert len(mesh["internal"]) == 6
    assert 2 * len(mesh["internal"]) + sum(len(rows) for rows in mesh["boundary"].values()) == 6 * mesh["cells"]
    assert all(face["owner"] < face["neighbour"] for face in mesh["internal"])
    order = [(face["owner"], face["neighbour"]) for face in mesh["internal"]]
    assert order == sorted(order)
    assert mesh["minimum_volume"] > 0
    diagnostic = grid_nonorthogonality(mesh, 6)
    assert len(diagnostic["largest"]) == 5
    assert all(0 <= face["angle_degrees"] < 90 for face in diagnostic["largest"])


def test_rejects_changed_seams_degenerate_cells_and_dimensions(tmp_path):
    grid = small_grid().astype(float)
    grid[0, -1, 1] = 1e-8
    with pytest.raises(ValueError, match="coincide exactly"):
        extruded_c_grid(grid, 1, 5, 1, 0.1)
    for chord in [0, -1, float("inf")]:
        with pytest.raises(ValueError, match="positive"):
            extruded_c_grid(small_grid(), 1, 5, chord, 0.1)
    source = tmp_path / "changed.x"
    source.write_bytes(b"2 2 0 1 0 1 0 0 1 1")
    with pytest.raises(ValueError, match="checksum"):
        write_nasa_grid(source, tmp_path / "case", 1, 0.1)
    assert not (tmp_path / "case").exists()
