import hashlib
import json
import math
from pathlib import Path


def parse_geometry(text):
    if "x/c    z/c lower z/c upper" not in text:
        raise ValueError("Unknown RAE geometry column convention")
    rows = []
    for line in text.splitlines()[5:]:
        if not line.strip():
            continue
        values = [float(value) for value in line.split()]
        if len(values) != 3 or not all(math.isfinite(value) for value in values):
            raise ValueError("Malformed measured geometry")
        horizontal, negative_lower, upper = values
        rows.append((horizontal, -negative_lower, upper))
    if len(rows) != 65 or rows[0] != (0, 0, 0) or rows[-1] != (1, 0, 0):
        raise ValueError("Incomplete measured RAE geometry")
    if any(current[0] <= previous[0] for previous, current in zip(rows, rows[1:])):
        raise ValueError("Measured geometry abscissae must increase")
    if any(lower >= upper for _, lower, upper in rows[1:-1]):
        raise ValueError("Measured upper and lower surfaces intersect")
    upper_surface = [(horizontal, upper) for horizontal, _, upper in reversed(rows)]
    lower_surface = [(horizontal, lower) for horizontal, lower, _ in rows[1:]]
    return upper_surface + lower_surface


def parse_pressure(text):
    if "M_infty = 0.729, alpha = 2.31 deg." not in text or '\n"Experiment\n' not in text:
        raise ValueError("Pressure data does not identify NASA Study 1 experiments")
    rows = []
    for line in text.split('\n"Experiment\n', 1)[1].splitlines():
        if not line.strip():
            continue
        values = [float(value) for value in line.split()]
        if len(values) != 2 or not all(math.isfinite(value) for value in values):
            raise ValueError("Malformed experimental pressure sample")
        horizontal, negative_cp = values
        if not 0 <= horizontal <= 1:
            raise ValueError("Pressure coordinate is outside the chord")
        rows.append((horizontal, -negative_cp))
    leading = [index for index, row in enumerate(rows) if row[0] == 0]
    if len(leading) != 1 or not 2 <= leading[0] < len(rows) - 2:
        raise ValueError("Pressure traversal lacks a unique leading edge")
    middle = leading[0]
    upper = list(reversed(rows[:middle + 1]))
    lower = rows[middle:]
    for surface in (upper, lower):
        if any(current[0] <= previous[0] for previous, current in zip(surface, surface[1:])):
            raise ValueError("Pressure surface traversal is not monotonic")
    return {"upper": upper, "lower": lower}


def load_reference(directory):
    directory = Path(directory)
    provenance = json.loads((directory / "provenance.json").read_text())
    texts = {}
    for kind in ("geometry", "pressure"):
        entry = provenance[kind]
        raw = (directory / entry["file"]).read_bytes()
        if hashlib.sha256(raw).hexdigest() != entry["sha256"]:
            raise ValueError(f"Changed {kind} reference bytes")
        texts[kind] = raw.decode("ascii")
    if provenance["pressure"]["ordinate"] != "negative_cp":
        raise ValueError("The source pressure sign convention has changed")
    return {"provenance": provenance, "coordinates": parse_geometry(texts["geometry"]),
            "pressure": parse_pressure(texts["pressure"]),
            "conditions": {"mach": provenance["mach"], "alpha_deg": provenance["alpha_deg"],
                           "reference_reynolds": provenance["reynolds"],
                           "chord_m": provenance["chord_ft"] * 0.3048,
                           "temperature_k": provenance["temperature_rankine"] * 5 / 9,
                           "pressure_pa": provenance["pressure_psia"] * 6894.757293168}}


def selig_coordinates(reference):
    lines = ["RAE 2822 NASA measured coordinates"]
    lines.extend(f"{horizontal:.8f} {vertical:.8f}" for horizontal, vertical in reference["coordinates"])
    return "\n".join(lines) + "\n"
