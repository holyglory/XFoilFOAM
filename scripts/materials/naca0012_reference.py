import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
from urllib.request import urlopen


SOURCE_PAGE = "https://tmbwg.github.io/turbmodels/naca0012_val.html"
SOURCES = {
    "CLCD_Ladson_expdata.dat": {
        "url": "https://tmbwg.github.io/turbmodels/NACA0012_validation/CLCD_Ladson_expdata.dat",
        "sha256": "78cd2f6aa4968e80f44cbf6c96f699bd9c6e45681d958ec528a10cf72ed23357",
        "bytes": 1343,
    },
    "n0012points_superbig_clust_fix.dat": {
        "url": "https://tmbwg.github.io/turbmodels/NACA0012_grids/n0012points_superbig_clust_fix.dat",
        "sha256": "74e147db4fa052be7ab79465a756c55b39b1786bfd7141a86257e89586728ae1",
        "bytes": 824246,
    },
}


def verify_bytes(name, raw):
    expected = SOURCES[name]
    if len(raw) != expected["bytes"] or hashlib.sha256(raw).hexdigest() != expected["sha256"]:
        raise ValueError(f"Changed NACA0012 source bytes: {name}")
    return raw


def read_source(path, name):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_size != SOURCES[name]["bytes"]:
        raise ValueError(f"Changed NACA0012 source bytes: {name}")
    with path.open("rb") as source:
        return verify_bytes(name, source.read(SOURCES[name]["bytes"] + 1))


def fetch_sources(directory, source_cache=None):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    for name, source in SOURCES.items():
        destination = directory / name
        if destination.exists():
            read_source(destination, name)
            continue
        if source_cache is not None:
            raw = read_source(Path(source_cache) / name, name)
        else:
            with urlopen(source["url"], timeout=30) as response:
                raw = response.read(source["bytes"] + 1)
        verify_bytes(name, raw)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=directory, delete=False) as output:
                temporary = Path(output.name)
                output.write(raw)
                output.flush()
                os.fsync(output.fileno())
            os.link(temporary, destination)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return {"source_files": len(SOURCES), "source_bytes": sum(row["bytes"] for row in SOURCES.values())}


def parse_forces(text):
    lines = text.splitlines()
    if lines[:4] != ["# Data from Ladson, NASA TM 4074, 1988", "# Re=6 million, with transition tripped",
                     "# M=0.15", 'variables="alpha, deg","cl","cd"']:
        raise ValueError("Unknown force source conditions or columns")
    runs = []
    for line in lines[4:]:
        if not line.strip():
            continue
        zone = re.fullmatch(r'zone, t="(80|120|180) grit"', line)
        if zone:
            label = zone[1] + " grit"
            if any(run["trip_grit"] == label for run in runs):
                raise ValueError("Repeated tripped force run")
            runs.append({"trip_grit": label, "rows": []})
            continue
        if not runs:
            raise ValueError("Force row lacks its tripped run")
        values = [float(value) for value in line.split()]
        if len(values) != 3 or not all(math.isfinite(value) for value in values) or values[2] <= 0:
            raise ValueError("Malformed force coefficients")
        rows = runs[-1]["rows"]
        if rows and values[0] <= rows[-1]["alpha"]:
            raise ValueError("Force angles must retain their increasing source order")
        rows.append({"alpha": values[0], "coefficients": [values[1], values[2], None]})
    if [run["trip_grit"] for run in runs] != ["80 grit", "120 grit", "180 grit"] or [len(run["rows"]) for run in runs] != [17, 18, 18]:
        raise ValueError("Incomplete published tripped force runs")
    return runs


def parse_geometry(text):
    lines = text.splitlines()
    if (len(lines) < 4 or lines[0] != "# Altered 0012 points from TMR website case 2DN00, defined by:"
            or "0.105174606*x^4" not in lines[1] or lines[2] != "# (setting z=0)" or lines[3] != 'variables="x","y","z"'):
        raise ValueError("Unknown modified benchmark geometry convention")
    rows = [tuple(float(value) for value in line.split()) for line in lines[4:] if line.strip()]
    if (len(rows) != 12299 or any(len(row) != 3 or not all(math.isfinite(value) for value in row) or row[2] != 0 for row in rows)
            or rows[0] != (1, 0, 0) or rows[-1] != (1, 0, 0) or rows[6149] != (0, 0, 0)):
        raise ValueError("Incomplete or nonplanar benchmark coordinates")
    for previous, current in zip(rows[:6149], rows[1:6150]):
        if current[0] >= previous[0] or current[1] > 0:
            raise ValueError("Lower surface traversal changed")
    for previous, current in zip(rows[6149:-1], rows[6150:]):
        if current[0] <= previous[0] or current[1] < 0:
            raise ValueError("Upper surface traversal changed")
    return [[row[0], row[1]] for row in reversed(rows)]


def load_reference(directory):
    directory = Path(directory)
    texts = {name: read_source(directory / name, name).decode("ascii") for name in SOURCES}
    return {
        "kind": "naca0012_tripped_reference_not_calibration",
        "attribution": "Ladson, NASA TM 4074 (1988), force data supplied by the NASA-linked Turbulence Modeling Resource",
        "source_page": SOURCE_PAGE, "sources": SOURCES,
        "conditions": {"reported_mach": 0.15, "reported_reynolds": 6000000, "transition": "tripped",
                       "trip_location": None, "equivalent_roughness": None, "measurement_uncertainty": None},
        "geometry_kind": "modified_TMR_benchmark_not_as_tested",
        "coordinate_order": "reversed_source_points_upper_LE_lower",
        "coordinates": parse_geometry(texts["n0012points_superbig_clust_fix.dat"]),
        "runs": parse_forces(texts["CLCD_Ladson_expdata.dat"]),
        "calibration_eligible": False,
        "limitations": ["benchmark_geometry_differs_from_nominal_experiment", "trip_location_and_roughness_unavailable",
                        "measurement_uncertainty_unavailable", "near_stall_two_dimensionality_not_established",
                        "moment_not_provided"],
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--fetch", action="store_true")
    parser.add_argument("--source-cache", type=Path)
    args = parser.parse_args()
    if args.fetch:
        fetch_sources(args.directory, args.source_cache)
    reference = load_reference(args.directory)
    print(json.dumps({"kind": reference["kind"], "runs": len(reference["runs"]),
                      "samples": sum(len(run["rows"]) for run in reference["runs"]),
                      "geometry_points": len(reference["coordinates"]), "calibration_eligible": False}))
