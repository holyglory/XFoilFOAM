import argparse
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urljoin, urlsplit
from urllib.request import urlopen

import numpy as np

from scripts.materials.inspect_rae_extrema import content, field, mesh_list


def saved_scalar(path, cell_count):
    uniform = re.search(r"internalField\s+uniform\s+([^;\s]+)\s*;", content(path))
    values = np.full(cell_count, float(uniform[1])) if uniform else field(path)
    if len(values) != cell_count or not np.isfinite(values).all():
        raise ValueError("Saved scalar values differ from their mesh or are nonfinite")
    return values


def energy_balances(path, cell_count):
    records = []
    with path.open() as stream:
        for line in stream:
            if not line.startswith("XFOILFOAM_ENERGY_BALANCE "):
                continue
            record = json.loads(line.removeprefix("XFOILFOAM_ENERGY_BALANCE "))
            if (type(record.get("cell")) is not int or not 0 <= record["cell"] < cell_count
                    or type(record.get("time")) not in {int, float} or not np.isfinite(record["time"])
                    or record["time"] <= 0 or (records and record["time"] <= records[-1]["time"])
                    or any(value is not None and (type(value) not in {int, float} or not np.isfinite(value))
                           for value in record.values())):
                raise ValueError("Invalid native energy-balance record")
            records.append(record)
            if len(records) > 10000:
                raise ValueError("Native energy-balance records exceed the diagnostic bound")
    return records


class DirectoryLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attributes):
        if tag == "a":
            self.links.extend(value for key, value in attributes if key == "href" and value)


def copy_directory(url, destination, budget, thermal_only=False):
    destination.mkdir(parents=True, exist_ok=False)
    parser = DirectoryLinks()
    with urlopen(url, timeout=30) as response:
        parser.feed(response.read().decode("utf8"))
    for href in parser.links:
        name = unquote(href).rstrip("/")
        if name in {"", ".", ".."}:
            continue
        if "/" in name or "\\" in name or urlsplit(href).scheme:
            raise ValueError("Artifact listing escapes its owned directory")
        target = urljoin(url, href)
        if href.endswith("/"):
            copy_directory(target, destination / name, budget, thermal_only)
        else:
            if thermal_only and destination.name.replace(".", "", 1).replace("e-", "").isdigit() and name not in {"T", "p", "U", "k", "omega", "rho", "e"}:
                continue
            with urlopen(target, timeout=30) as response, (destination / name).open("xb") as output:
                while chunk := response.read(1024 * 1024):
                    budget[0] -= len(chunk)
                    if budget[0] < 0:
                        raise ValueError("Retained diagnostic exceeds its bounded copy allocation")
                    output.write(chunk)


def inspect_saved_case(directory):
    control = (directory / "system/controlDict").read_text()
    schemes = (directory / "system/fvSchemes").read_text()
    owner = mesh_list(directory / "constant/polyMesh/owner")
    cell_count = int(owner.max()) + 1
    frames = []
    for state in directory.iterdir():
        try:
            coordinate = float(state.name)
        except ValueError:
            continue
        if not state.is_dir() or coordinate <= 0:
            continue
        summary = {"coordinate": coordinate, "directory": state.name, "fields": {}}
        for name in ("T", "p", "rho", "e", "k", "omega", "nut", "alphat"):
            source = state / name
            if not source.is_file():
                continue
            values = saved_scalar(source, cell_count)
            if len(values) != cell_count:
                raise ValueError("Saved field differs from the actual mesh cell count")
            summary["fields"][name] = {
                "minimum": float(values.min()), "maximum": float(values.max()),
                "minimum_cell": int(values.argmin()), "maximum_cell": int(values.argmax()),
                "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            }
        velocity = state / "U"
        if velocity.is_file():
            values = np.linalg.norm(field(velocity, 3), axis=1)
            summary["fields"]["speed"] = {"minimum": float(values.min()), "maximum": float(values.max())}
        frames.append(summary)
    return {
        "case": directory.name, "cells": cell_count,
        "coordinate_kind": "iteration" if "localEuler" in schemes else "physical_time",
        "control_sha256": hashlib.sha256(control.encode()).hexdigest(),
        "schemes_sha256": hashlib.sha256(schemes.encode()).hexdigest(),
        "frames": sorted(frames, key=lambda row: row["coordinate"]),
        "startup": json.loads((directory / "acoustic-startup.json").read_text()) if (directory / "acoustic-startup.json").is_file() else None,
        "receipt": json.loads((directory / "receipt.json").read_text()) if (directory / "receipt.json").is_file() else None,
        "energy_balance": energy_balances(directory / "log.rhoCentralFoam", cell_count) if (directory / "log.rhoCentralFoam").is_file() else [],
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--groups", nargs="+", default=["mach2", "mach3"])
    parser.add_argument("--thermal-only", action="store_true")
    parser.add_argument("--probe-build")
    args = parser.parse_args()
    status = json.loads(subprocess.check_output(["devcoordinator2", "deployment", "status", "--name", "progressive-numerics", "--client", "codex"], text=True))
    if not status.get("ok") or status["data"]["deployment_id"] != "dec54282d9f0719c8":
        raise ValueError("The owned numerical deployment is unavailable")
    component = next(item for item in status["data"]["components"] if item["name"] == "numerics")
    if any(item["state"] not in {"completed", "failed"} for item in component["services"] if item["name"] != "artifacts") or not any(item["name"] == "artifacts" and item["state"] == "running" for item in component["services"]):
        raise ValueError("Read retained fields only with all numerical writers stopped")
    origin = f"http://127.0.0.1:{int(component['port'])}"
    args.destination.mkdir(parents=True, exist_ok=False)
    reports = []
    budget = [1024 * 1024 * 1024]
    if args.probe_build:
        if not re.fullmatch(r"energy-probe-build-r[1-9][0-9]*", args.probe_build):
            raise ValueError("Expected an owned energy-probe build")
        copy_directory(origin + f"/{args.probe_build}/", args.destination / args.probe_build, budget)
    for name in args.groups:
        if not re.fullmatch(r"mach[23](?:-[a-z]+)*", name):
            raise ValueError("Expected an owned Mach-2/Mach-3 case group")
        copy_directory(origin + f"/{name}/", args.destination / name, budget, args.thermal_only)
        for directory in sorted((args.destination / name).iterdir()):
            if directory.is_dir() and (directory / "system/controlDict").is_file():
                reports.append({"group": name, **inspect_saved_case(directory)})
    report = {"kind": "retained-cartesian-startup-diagnosis-v1", "production_evidence": False,
              "source_deployment": "dec54282d9f0719c8", "source_origin": origin,
              "retained_selection": "thermal_fields_and_mesh" if args.thermal_only else "complete_case", "cases": reports}
    (args.destination / "report.json").write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"cases": [{"group": row["group"], "case": row["case"], "cells": row["cells"], "frames": len(row["frames"]),
                                "validated_smoke": row["receipt"] is not None} for row in reports], "output": str(args.destination / "report.json")}))


if __name__ == "__main__":
    main()
