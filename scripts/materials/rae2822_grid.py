import hashlib
import json
import math
from pathlib import Path

import numpy as np


GRID_SHA256 = "2318157ce20050a3f7c1a5dc208cbfd3d821108b618afb2e43fd4792ee4238ed"
GRID_URL = "https://www.grc.nasa.gov/www/wind/valid/raetaf/raetaf01/raetaf.x.fmt"


def parse_plot3d_grid(raw):
    fields = raw.decode("ascii").split()
    if len(fields) < 2:
        raise ValueError("Missing PLOT3D dimensions")
    horizontal, radial = (int(value) for value in fields[:2])
    if min(horizontal, radial) < 2 or horizontal * radial > 1_000_000:
        raise ValueError("Invalid bounded PLOT3D dimensions")
    values = np.array([float(value.replace("D", "E").replace("d", "e")) for value in fields[2:]])
    count = horizontal * radial
    if len(values) != 2 * count or not np.isfinite(values).all():
        raise ValueError("PLOT3D coordinate count or finite values differ")
    return np.stack((values[:count].reshape(radial, horizontal), values[count:].reshape(radial, horizontal)), axis=-1)


def extruded_c_grid(grid, wall_start, wall_end, chord, span_chords):
    grid = np.asarray(grid, dtype=float)
    if grid.ndim != 3 or grid.shape[2] != 2 or not np.isfinite(grid).all():
        raise ValueError("Expected finite two-dimensional grid coordinates")
    radial, horizontal, _ = grid.shape
    if not 0 < wall_start < wall_end < horizontal - 1 or wall_end != horizontal - wall_start - 1:
        raise ValueError("Invalid symmetric C-grid seam bounds")
    if any(not math.isfinite(value) or value <= 0 for value in (chord, span_chords)):
        raise ValueError("Reference dimensions must be finite and positive")
    labels = np.empty((radial, horizontal), dtype=int)
    planar = []
    for row in range(radial):
        for column in range(horizontal):
            if row == 0 and column >= wall_end:
                opposite = horizontal - column - 1
                if not np.array_equal(grid[row, column], grid[row, opposite]):
                    raise ValueError("Published wake seam coordinates do not coincide exactly")
                labels[row, column] = labels[row, opposite]
            else:
                labels[row, column] = len(planar)
                planar.append((*grid[row, column] * chord, 0.0))
    plane_count = len(planar)
    points = planar + [(horizontal, vertical, chord * span_chords) for horizontal, vertical, _ in planar]
    faces = {}
    cell_centres = []
    minimum_volume = math.inf
    for row in range(radial - 1):
        for column in range(horizontal - 1):
            cell = row * (horizontal - 1) + column
            quad = [int(labels[row, column]), int(labels[row, column + 1]), int(labels[row + 1, column + 1]), int(labels[row + 1, column])]
            coordinates = np.array([planar[index][:2] for index in quad])
            area = 0.5 * float(np.sum(coordinates[:, 0] * np.roll(coordinates[:, 1], -1) - coordinates[:, 1] * np.roll(coordinates[:, 0], -1)))
            if area == 0 or len(set(quad)) != 4:
                raise ValueError("Degenerate reference grid cell")
            following = np.roll(coordinates, -1, axis=0)
            cross = coordinates[:, 0] * following[:, 1] - following[:, 0] * coordinates[:, 1]
            centre = np.sum((coordinates + following) * cross[:, None], axis=0) / (6 * area)
            cell_centres.append((float(centre[0]), float(centre[1]), chord * span_chords / 2))
            if area < 0:
                quad.reverse()
            minimum_volume = min(minimum_volume, abs(area) * chord * span_chords)
            edges = {
                frozenset((int(labels[row, column]), int(labels[row, column + 1]))): "airfoil" if row == 0 and wall_start <= column < wall_end else None,
                frozenset((int(labels[row + 1, column]), int(labels[row + 1, column + 1]))): "inlet" if row == radial - 2 else None,
                frozenset((int(labels[row, column]), int(labels[row + 1, column]))): "outlet" if column == 0 else None,
                frozenset((int(labels[row, column + 1]), int(labels[row + 1, column + 1]))): "outlet" if column == horizontal - 2 else None,
            }
            sides = [(tuple(reversed(quad)), "frontAndBack"), (tuple(index + plane_count for index in quad), "frontAndBack")]
            for index, first in enumerate(quad):
                second = quad[(index + 1) % 4]
                sides.append(((first, second, second + plane_count, first + plane_count), edges[frozenset((first, second))]))
            for vertices, patch in sides:
                key = tuple(sorted(vertices))
                existing = faces.get(key)
                if existing is None:
                    faces[key] = {"vertices": vertices, "owner": cell, "neighbour": None, "patch": patch}
                else:
                    if existing["neighbour"] is not None or patch is not None or existing["patch"] is not None:
                        raise ValueError("Reference face has invalid boundary or cell ownership")
                    reversed_vertices = tuple(reversed(existing["vertices"]))
                    if not any(vertices == reversed_vertices[offset:] + reversed_vertices[:offset] for offset in range(4)):
                        raise ValueError("Adjacent reference cells have inconsistent face orientation")
                    existing["neighbour"] = cell
    internal = sorted((face for face in faces.values() if face["neighbour"] is not None), key=lambda face: (face["owner"], face["neighbour"]))
    boundary = {patch: [] for patch in ("inlet", "outlet", "airfoil", "frontAndBack")}
    for face in faces.values():
        if face["neighbour"] is None:
            if face["patch"] not in boundary:
                raise ValueError("Unpaired wake or unknown exterior reference face")
            boundary[face["patch"]].append(face)
    return {"points": points, "internal": internal, "boundary": boundary, "cell_centres": cell_centres,
            "cells": (horizontal - 1) * (radial - 1), "minimum_volume": minimum_volume}


def grid_nonorthogonality(mesh, horizontal_cells):
    points = np.asarray(mesh["points"])
    centres = np.asarray(mesh["cell_centres"])
    largest = []
    for face in mesh["internal"]:
        vertices = points[list(face["vertices"])]
        normal = np.cross(vertices[1] - vertices[0], vertices[2] - vertices[0])
        delta = centres[face["neighbour"]] - centres[face["owner"]]
        magnitude = np.linalg.norm(normal) * np.linalg.norm(delta)
        if magnitude <= 0:
            raise ValueError("Degenerate face or adjacent cell centres")
        cosine = float(np.dot(normal, delta) / magnitude)
        angle = math.degrees(math.acos(np.clip(cosine, -1, 1)))
        largest.append({"angle_degrees": angle, "owner_cell": face["owner"], "neighbour_cell": face["neighbour"],
                        "owner_ij": [face["owner"] % horizontal_cells, face["owner"] // horizontal_cells],
                        "neighbour_ij": [face["neighbour"] % horizontal_cells, face["neighbour"] // horizontal_cells],
                        "face_centre": vertices.mean(axis=0).tolist()})
    largest.sort(key=lambda entry: entry["angle_degrees"], reverse=True)
    return {"centre_method": "exact_planar_polygon_centroid_extruded_prism", "severe_over_70": sum(entry["angle_degrees"] > 70 for entry in largest),
            "largest": largest[:5]}


def write_nasa_grid(source, destination, chord, span_chords):
    raw = Path(source).read_bytes()
    if hashlib.sha256(raw).hexdigest() != GRID_SHA256:
        raise ValueError("Published NASA grid checksum differs")
    grid = parse_plot3d_grid(raw)
    if grid.shape != (65, 369, 2):
        raise ValueError("Published NASA grid dimensions differ")
    mesh = extruded_c_grid(grid, 32, 336, chord, span_chords)
    root = Path(destination) / "constant/polyMesh"
    root.mkdir(parents=True, exist_ok=False)
    ordered = mesh["internal"] + [face for group in mesh["boundary"].values() for face in group]

    def write(name, kind, content):
        header = f'FoamFile\n{{\n version 2.0;\n format ascii;\n class {kind};\n location "constant/polyMesh";\n object {name};\n}}\n'
        (root / name).write_text(header + content)

    write("points", "vectorField", f'{len(mesh["points"])}\n(\n' + "\n".join("(" + " ".join(format(value, ".17g") for value in point) + ")" for point in mesh["points"]) + "\n)\n")
    write("faces", "faceList", f"{len(ordered)}\n(\n" + "\n".join("4(" + " ".join(str(index) for index in face["vertices"]) + ")" for face in ordered) + "\n)\n")
    for name, rows in (("owner", ordered), ("neighbour", mesh["internal"])):
        write(name, "labelList", f"{len(rows)}\n(\n" + "\n".join(str(face[name]) for face in rows) + "\n)\n")
    start = len(mesh["internal"])
    patches = []
    for patch, rows in mesh["boundary"].items():
        kind = "empty" if patch == "frontAndBack" else "wall" if patch == "airfoil" else "patch"
        patches.append(f"{patch}\n{{ type {kind}; nFaces {len(rows)}; startFace {start}; }}")
        start += len(rows)
    write("boundary", "polyBoundaryMesh", "4\n(\n" + "\n".join(patches) + "\n)\n")
    receipt = {"source_url": GRID_URL, "source_sha256": GRID_SHA256, "dimensions": [369, 65], "cells": mesh["cells"],
               "wall_node_indices_one_based": [33, 337], "span_chords": span_chords, "chord_m": chord,
               "minimum_cell_volume": mesh["minimum_volume"], "patch_faces": {name: len(rows) for name, rows in mesh["boundary"].items()}}
    (Path(destination) / "reference-grid.json").write_text(json.dumps(receipt, allow_nan=False) + "\n")
    return receipt


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("destination", nargs="?")
    parser.add_argument("--inspect", action="store_true")
    arguments = parser.parse_args()
    if arguments.inspect:
        raw = Path(arguments.source).read_bytes()
        if hashlib.sha256(raw).hexdigest() != GRID_SHA256:
            raise ValueError("Published NASA grid checksum differs")
        mesh = extruded_c_grid(parse_plot3d_grid(raw), 32, 336, 0.3048, 0.1)
        print(json.dumps(grid_nonorthogonality(mesh, 368), allow_nan=False))
    elif arguments.destination:
        print(json.dumps(write_nasa_grid(arguments.source, arguments.destination, 0.3048, 0.1), allow_nan=False))
    else:
        parser.error("A destination or --inspect is required")
