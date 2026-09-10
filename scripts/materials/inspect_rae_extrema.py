import json
from pathlib import Path
import re
import sys

import numpy as np


def content(path):
    text = path.read_text()
    if not re.search(r"\bformat\s+ascii\s*;", text):
        raise ValueError("Diagnostic requires retained ASCII fields")
    text = re.sub(r"/\*.*?\*/|//[^\n]*", "", text, flags=re.S)
    return re.sub(r"FoamFile\s*\{.*?\}", "", text, count=1, flags=re.S)


def mesh_list(path, width=1):
    match = re.fullmatch(r"\s*(\d+)\s*\((.*)\)\s*;?\s*", content(path), re.S)
    if not match:
        raise ValueError(f"Invalid list: {path.name}")
    values = np.fromstring(re.sub(r"[()]", " ", match[2]), sep=" ")
    if values.size != int(match[1]) * width or not np.isfinite(values).all():
        raise ValueError("Mesh list cardinality or values differ")
    if width == 1 and (np.any(values < 0) or np.any(values != np.floor(values))):
        raise ValueError("Mesh labels must be nonnegative integers")
    return values.reshape((-1, width)) if width > 1 else values.astype(int)


def field(path, width=1):
    match = re.search(r"internalField\s+nonuniform\s+List<(?:scalar|vector)>\s+(\d+)\s*\((.*?)\)\s*;", content(path), re.S)
    if not match:
        raise ValueError(f"Missing measured internal field: {path.name}")
    values = np.fromstring(re.sub(r"[()]", " ", match[2]), sep=" ")
    if values.size != int(match[1]) * width or not np.isfinite(values).all():
        raise ValueError("Field cardinality or values differ")
    return values.reshape((-1, width)) if width > 1 else values


def inspect(directory):
    directory = Path(directory)
    coordinate = max(int(child.name) for child in directory.iterdir() if child.is_dir() and child.name.isdigit() and (child / "T").is_file())
    state = directory / str(coordinate)
    mesh = directory / "constant/polyMesh"
    points = mesh_list(mesh / "points", 3)
    owner, neighbour = mesh_list(mesh / "owner"), mesh_list(mesh / "neighbour")
    faces = []
    for match in re.finditer(r"(\d+)\(([^()]*)\)", content(mesh / "faces")):
        vertices = np.fromstring(match[2], sep=" ", dtype=int)
        if len(vertices) != int(match[1]) or np.any(vertices < 0) or np.any(vertices >= len(points)):
            raise ValueError("Invalid face vertices")
        faces.append(vertices)
    if len(faces) != len(owner) or len(neighbour) > len(owner):
        raise ValueError("Face ownership differs")
    temperature, pressure, kinetic = field(state / "T"), field(state / "p"), field(state / "k")
    velocity = field(state / "U", 3)
    if not len(temperature) == len(pressure) == len(kinetic) == len(velocity) == int(owner.max()) + 1:
        raise ValueError("Cell/field dimensions differ")
    chord = json.loads((directory / "report.json").read_text())["request"]["chord_lengths"][0]
    selected = {}
    for name, cell in {"minimum_temperature": temperature.argmin(), "minimum_pressure": pressure.argmin(), "maximum_speed": np.linalg.norm(velocity, axis=1).argmax(), "maximum_turbulence_k": kinetic.argmax()}.items():
        face_ids = np.r_[np.flatnonzero(owner == cell), np.flatnonzero(neighbour == cell)]
        vertices = np.unique(np.concatenate([faces[index] for index in face_ids]))
        selected[name] = {"cell": int(cell), "vertex_average_over_chord": (points[vertices].mean(axis=0) / chord).tolist(), "temperature_k": float(temperature[cell]), "pressure_pa": float(pressure[cell]), "speed_mps": float(np.linalg.norm(velocity[cell])), "turbulence_k": float(kinetic[cell])}
    return {"source": str(directory), "coordinate": coordinate, "position_kind": "mean_of_cell_vertices_not_volume_centroid", "extrema": selected}


if __name__ == "__main__":
    for directory in sys.argv[1:]:
        print(json.dumps(inspect(directory), allow_nan=False), flush=True)
