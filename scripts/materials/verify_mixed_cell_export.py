"""Native mixed-cell VTK compatibility fixture; never published solver data."""

import hashlib
import json
from pathlib import Path
import tempfile

import meshio
import numpy as np

from airfoilfoam.openfoam.dialects import OPENCFD_2606
from airfoilfoam.openfoam.runner import LocalRunner
from airfoilfoam.models import ImageField
from airfoilfoam.postprocess.images import render_contours


def write_foam(path, class_name, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"FoamFile {{ version 2.0; format ascii; class {class_name}; object {path.name}; }}\n{body}\n"
    )


def write_fixture(case):
    points = [(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
              (0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1)]
    polygon = [(2, 0), (3, 0), (3.5, 0.5), (3, 1), (2, 1)]
    points.extend((horizontal, vertical, depth) for depth in (0, 1) for horizontal, vertical in polygon)
    faces = [(3, 2, 1, 0), (4, 5, 6, 7), (0, 1, 5, 4),
             (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7),
             (12, 11, 10, 9, 8), (13, 14, 15, 16, 17)]
    faces.extend((8 + index, 8 + (index + 1) % 5, 13 + (index + 1) % 5, 13 + index) for index in range(5))
    mesh = case / "constant/polyMesh"
    write_foam(mesh / "points", "vectorField", str(len(points)) + "\n(\n" +
               "\n".join("(" + " ".join(map(str, point)) + ")" for point in points) + "\n)")
    write_foam(mesh / "faces", "faceList", str(len(faces)) + "\n(\n" +
               "\n".join(str(len(face)) + "(" + " ".join(map(str, face)) + ")" for face in faces) + "\n)")
    write_foam(mesh / "owner", "labelList", "13\n(\n" + "\n".join(map(str, [0] * 6 + [1] * 7)) + "\n)")
    write_foam(mesh / "neighbour", "labelList", "0\n(\n)")
    write_foam(mesh / "boundary", "polyBoundaryMesh", "1\n( walls { type wall; nFaces 13; startFace 0; } )")
    write_foam(case / "system/controlDict", "dictionary",
               "application foamToVTK; startFrom startTime; startTime 0; stopAt endTime; endTime 1; deltaT 1; writeControl timeStep; writeInterval 1;")
    write_foam(case / "system/fvSchemes", "dictionary",
               "ddtSchemes { default Euler; } gradSchemes { default Gauss linear; } divSchemes { default none; } "
               "laplacianSchemes { default Gauss linear corrected; } interpolationSchemes { default linear; } "
               "snGradSchemes { default corrected; }")
    write_foam(case / "system/fvSolution", "dictionary", "solvers {}")
    write_foam(case / "0/p", "volScalarField",
               "dimensions [1 -1 -2 0 0 0 0]; internalField uniform 101325; boundaryField { walls { type zeroGradient; } }")
    write_foam(case / "0/U", "volVectorField",
               "dimensions [0 1 -1 0 0 0 0]; internalField uniform (1 0 0); boundaryField { walls { type zeroGradient; } }")
    (case / "constant/aerodynamicReference.json").write_text(json.dumps({
        "version": 1, "pressure_kind": "absolute", "pressure_pa": 101325, "density": 1.225, "speed": 1,
    }))


def hashes(case):
    return {str(path.relative_to(case)): hashlib.sha256(path.read_bytes()).hexdigest()
            for directory in ("constant", "0") for path in (case / directory).rglob("*") if path.is_file()}


def exported_mesh(case, directory):
    files = list((case / directory).rglob("*.vtu"))
    assert len(files) == 1, files
    return meshio.read(files[0])


def main():
    root = Path("/evidence")
    root.mkdir(parents=True, exist_ok=True)
    case = Path(tempfile.mkdtemp(prefix="mixed-cell-", dir=root))
    write_fixture(case)
    original = hashes(case)
    runner = LocalRunner()
    baseline = runner.application(case, "foamToVTK -time 0 -no-boundary -name baseline", timeout=60)
    (case / "baseline.log").write_text(baseline.stdout)
    baseline.check()
    try:
        exported_mesh(case, "baseline")
    except ValueError as error:
        assert "combinations of polyhedra" in str(error), error
    else:
        raise AssertionError("Fixture must reproduce the mixed-cell reader failure")
    for label, command in (("all", OPENCFD_2606.vtk_all_times_command),
                           ("latest", OPENCFD_2606.vtk_latest_time_command)):
        directory = "VTK" if label == "latest" else label
        converted = runner.application(case, f"{command} -no-boundary -name {directory}", timeout=60)
        (case / f"{label}.log").write_text(converted.stdout)
        converted.check()
        result = exported_mesh(case, directory)
        assert all(not block.type.startswith("polyhedron") for block in result.cells)
        assert len(result.points) >= 18
        np.testing.assert_allclose(result.point_data["p"], 101325)
        np.testing.assert_allclose(result.point_data["U"], np.tile([1, 0, 0], (len(result.points), 1)))
        assert hashes(case) == original
    rendered = render_contours(case, case / "images", np.array([[-1, -1], [-0.5, -1], [-1, -0.5]]),
                               1.0, [ImageField.pressure, ImageField.velocity_magnitude],
                               title_suffix="Synthetic mixed-cell export fixture")
    assert set(rendered) == {"pressure", "velocity_magnitude"}, rendered
    images = list((case / "images").glob("*.png"))
    assert len(images) == 2
    assert all(path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n") for path in images)
    assert hashes(case) == original
    print(json.dumps({"fixture_only": True, "baseline_reproduced": True, "rendered_fields": len(images),
                      "all_and_latest_readable": True, "original_mesh_and_fields_unchanged": True}))


if __name__ == "__main__":
    main()
