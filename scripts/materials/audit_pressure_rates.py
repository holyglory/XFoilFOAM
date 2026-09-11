import argparse
import hashlib
import json
from pathlib import Path
import re

import numpy as np

from scripts.materials.inspect_rae_extrema import content, field, mesh_list
from scripts.materials.rae2822_mapping import authenticated_retained_source
from scripts.materials.validate_polar_uncertainty import write_result


DIMENSIONS = {"rho": [1, -3, 0, 0, 0, 0, 0], "U": [0, 1, -1, 0, 0, 0, 0],
              "h": [0, 2, -2, 0, 0, 0, 0], "p": [1, -1, -2, 0, 0, 0, 0],
              "k": [0, 2, -2, 0, 0, 0, 0], "omega": [0, 0, -1, 0, 0, 0, 0], "rDeltaT": [0, 0, -1, 0, 0, 0, 0]}


def load_field(path, cells):
    width = 3 if path.name == "U" else 1
    text = content(path)
    dimensions = re.search(r"\bdimensions\s*\[([^]]+)\]\s*;", text)
    if not dimensions or [int(value) for value in dimensions[1].split()] != DIMENSIONS[path.name]:
        raise ValueError("Field dimensions differ from the primitive pressure contract")
    uniform = re.search(r"\binternalField\s+uniform\s+([^;]+);", text)
    if uniform:
        values = np.fromstring(uniform[1].strip().strip("()"), sep=" ")
        if len(values) != width or not np.isfinite(values).all():
            raise ValueError("Malformed uniform field")
        return np.full(cells, values[0]) if width == 1 else np.tile(values, (cells, 1))
    values = field(path, width)
    if len(values) != cells:
        raise ValueError("Field does not match the mesh cell count")
    return values


def recompute_rates(previous, current, references):
    inverse_step = current["rDeltaT"]
    if any(np.any(state["rho"] <= 0) for state in (previous, current)) or np.any(inverse_step <= 0):
        raise ValueError("Density and local inverse time step must be positive")
    for state in (previous, current):
        if any(not np.isfinite(values).all() for values in state.values()):
            raise ValueError("Nonfinite state")
    density_scale = references["referenceDensity"] * references["referenceSpeed"] / references["referenceLength"]
    scales = {"density": density_scale, "momentum": density_scale * references["referenceSpeed"],
              "total_energy": density_scale * references["referenceSpecificEnergy"],
              "k": references["referenceTurbulenceEnergy"] * references["referenceSpeed"] / references["referenceLength"],
              "omega": references["referenceTurbulenceFrequency"] * references["referenceSpeed"] / references["referenceLength"]}
    if any(not np.isfinite(value) or value <= 0 for value in scales.values()):
        raise ValueError("Invalid reference rate scale")
    states = []
    energies = []
    for state in (previous, current):
        kinetic = 0.5 * np.sum(state["U"] ** 2, axis=1)
        states.append({"density": state["rho"], "momentum": state["rho"][:, None] * state["U"],
                       "total_energy": state["rho"] * (state["h"] + kinetic) - state["p"],
                       "k": state["k"], "omega": state["omega"]})
        energies.append(state["rho"] * (np.abs(state["h"]) + kinetic) + np.abs(state["p"]))
    result = {}
    for name, scale in scales.items():
        difference = states[1][name] - states[0][name]
        amplitude = np.abs(states[1][name]) + np.abs(states[0][name])
        if name == "momentum":
            difference = np.linalg.norm(difference, axis=1)
            amplitude = np.linalg.norm(amplitude, axis=1)
        if name == "total_energy":
            amplitude = energies[0] + energies[1]
        rates = np.abs(difference) * inverse_step / scale
        if not np.isfinite(rates).all():
            raise ValueError("Nonfinite recomputed rates")
        maximum_cell = int(rates.argmax())
        roundoff = float(64 * np.finfo(float).eps * float(np.max(amplitude * inverse_step / scale)))
        result[name] = {"recomputed": float(rates[maximum_cell]), "cell_index": maximum_cell,
                        "field_change": float(difference[maximum_cell]), "inverse_local_step": float(inverse_step[maximum_cell]),
                        "reference_rate_scale": float(scale), "roundoff_envelope": roundoff}
    return result


def complete_times(root):
    return {int(path.name): path for path in root.iterdir() if path.name.isdigit() and all((path / name).is_file() for name in DIMENSIONS)}


def load_consecutive_states(root, cells):
    times = complete_times(root)
    coordinates = sorted(times)
    if len(coordinates) >= 2 and coordinates[-1] - coordinates[-2] == 1:
        selected = coordinates[-2:]
        return selected, [{name: load_field(times[coordinate] / name, cells) for name in DIMENSIONS} for coordinate in selected], "reconstructed"
    processors = sorted(path for path in root.iterdir() if path.is_dir() and re.fullmatch(r"processor\d+", path.name))
    if not processors:
        raise ValueError("Audit requires two consecutive saved states")
    processor_times = [complete_times(path) for path in processors]
    common = sorted(set.intersection(*(set(times) for times in processor_times)))
    if len(common) < 2 or common[-1] - common[-2] != 1:
        raise ValueError("Processor states are missing or not consecutive")
    selected = common[-2:]
    states = [{name: np.empty((cells, 3) if name == "U" else cells) for name in DIMENSIONS} for _ in selected]
    covered = np.zeros(cells, dtype=bool)
    for processor, times in zip(processors, processor_times, strict=True):
        addressing = mesh_list(processor / "constant/polyMesh/cellProcAddressing")
        if np.any(addressing >= cells) or len(set(addressing)) != len(addressing) or covered[addressing].any():
            raise ValueError("Processor cell addressing overlaps or exceeds the mesh")
        for index, coordinate in enumerate(selected):
            for name in DIMENSIONS:
                states[index][name][addressing] = load_field(times[coordinate] / name, len(addressing))
        covered[addressing] = True
    if not covered.all():
        raise ValueError("Processor states do not cover every mesh cell")
    if selected[-1] in complete_times(root):
        latest = root / str(selected[-1])
        if any(not np.array_equal(load_field(latest / name, cells), states[-1][name]) for name in DIMENSIONS):
            raise ValueError("Stored reconstruction differs from processor field values")
    return selected, states, "exact_processor_addressing"


def audit_case(directory):
    root, manifest_bytes, _, _, report = authenticated_retained_source(directory)
    if report.get("actual_execution", {}).get("physical_time_history") is not False or report.get("native_steady_detector", {}).get("energy_field") != "h":
        raise ValueError("Audit requires actual primitive-h local-time evidence")
    owner = mesh_list(root / "constant/polyMesh/owner")
    neighbour = mesh_list(root / "constant/polyMesh/neighbour")
    cells = int(max(owner.max(), neighbour.max() if len(neighbour) else 0)) + 1
    coordinates, states, storage = load_consecutive_states(root, cells)
    control = content(root / "system/controlDict")
    references = {}
    for name in report["native_steady_detector"]["references"]:
        matches = re.findall(rf"\b{re.escape(name)}\s+([-+0-9.eE]+)\s*;", control)
        if len(matches) != 1:
            raise ValueError("Native reference scale is ambiguous")
        references[name] = float(matches[0])
    coordinate = None
    last = None
    with (root / "log.rhoPimpleFoam").open() as source:
        for line in source:
            match = re.fullmatch(r"Time = ([-+0-9.eE]+)\s*", line)
            if match:
                coordinate = float(match[1])
            if line.startswith("XFOILFOAM_LOCAL_STEADY_RESIDUAL "):
                row = [float(value) for value in line.split()[1:]]
                if len(row) != 6 or not np.isfinite(row).all():
                    raise ValueError("Invalid native rate row")
                last = (coordinate, row)
    if last is None or last[0] != coordinates[-1]:
        raise ValueError("Native rate row and latest field coordinate differ")
    rates = recompute_rates(states[0], states[1], references)
    for index, value in enumerate(rates.values(), start=1):
        value["native"] = last[1][index]
        value["absolute_difference"] = abs(value["native"] - value["recomputed"])
        value["consistent_with_roundoff"] = bool(value["absolute_difference"] <= value["roundoff_envelope"])
    return {"kind": "independent_conserved_rate_arithmetic_audit", "states": coordinates, "storage": storage,
            "source_manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "cells": cells, "channels": rates, "all_channels_consistent": all(value["consistent_with_roundoff"] for value in rates.values()),
            "acceptance_verdict": "not_evaluated", "roundoff_model": "64_double_precision_eps_times_input_amplitudes_and_rate_scaling",
            "interpretation": "Arithmetic consistency is not a physical convergence or aerodynamic accuracy certificate."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    result = audit_case(args.case)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    signature = write_result(args.output, result)
    print(json.dumps({"all_channels_consistent": result["all_channels_consistent"], "states": result["states"],
                      "channels": result["channels"], "output_sha256": signature}, allow_nan=False))
    raise SystemExit(0 if result["all_channels_consistent"] else 1)
