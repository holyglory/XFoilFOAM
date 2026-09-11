import hashlib
import json
import math
from pathlib import Path, PurePosixPath
import shlex

import numpy as np

try:
    from .inspect_rae_extrema import field, mesh_list
except ImportError:
    from inspect_rae_extrema import field, mesh_list


def authenticated_retained_source(source):
    source = Path(source).resolve()
    manifest_bytes = (source / "retained-source-manifest.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    members = manifest.get("files")
    if not isinstance(members, list) or not 1 <= len(members) <= 10000:
        raise ValueError("Mapping source requires a bounded retained manifest")
    verified = {}
    for member in members:
        relative = PurePosixPath(member["path"])
        if relative.is_absolute() or ".." in relative.parts or relative.as_posix() != member["path"] or str(relative) in verified:
            raise ValueError("Invalid mapping source manifest path")
        path = source / relative
        if any(parent.is_symlink() for parent in [path, *path.parents] if parent != source and source in parent.parents):
            raise ValueError("Mapping source cannot follow symbolic links")
        raw = path.read_bytes()
        signature = hashlib.sha256(raw).hexdigest()
        if len(raw) != member["bytes"] or signature != member["sha256"]:
            raise ValueError("Mapping source checksum or size differs")
        verified[str(relative)] = signature
    if "report.json" not in verified:
        raise ValueError("Mapping source report is not authenticated")
    report = json.loads((source / "report.json").read_bytes())
    return source, manifest_bytes, manifest, verified, report


def authenticated_mapping_source(source, request, settings):
    source, manifest_bytes, manifest, verified, report = authenticated_retained_source(source)
    coordinate = report.get("pressure_iteration")
    if report.get("outcome") != "measured_converged" or report.get("convergence", {}).get("converged") is not True:
        raise ValueError("Mapping requires a genuinely converged donor")
    if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)) or not math.isfinite(coordinate) or coordinate <= 0 or not float(coordinate).is_integer():
        raise ValueError("Mapping source requires a positive exact saved coordinate")
    source_request = report.get("request")
    if not isinstance(source_request, dict):
        raise ValueError("Mapping source has no resolved request")
    expected = json.loads(json.dumps(request))
    for key in ("n_surface", "n_radial", "n_wake"):
        coarse = source_request.get("mesh", {}).get(key)
        fine = expected.get("mesh", {}).get(key)
        if type(coarse) is not int or type(fine) is not int or not 0 < coarse < fine:
            raise ValueError("Mapping requires explicit increasing mesh resolution")
        expected["mesh"][key] = coarse
    for key in ("n_iterations", "convergence_tolerance"):
        expected["solver"][key] = source_request.get("solver", {}).get(key)
    if expected != source_request:
        raise ValueError("Mapping source physical or numerical setup differs")
    defaults = {"experimental_consistent_pressure": False, "experimental_local_time_pressure": False, "experimental_density_relaxation": None,
                "experimental_pressure_advection": "upwind",
                "experimental_time_step_smoothing": 0.02,
                "experimental_low_re_k_wall": False,
                "experimental_nonorthogonal_correction": "corrected", "experimental_pressure_equation_relaxation": None,
                "experimental_pressure_solver": "GAMG", "experimental_energy_transport": report.get("experimental_momentum_scheme")}
    if any(report.get(key, defaults.get(key)) != value for key, value in settings.items()):
        raise ValueError("Mapping source experimental recipe differs")
    time_name = str(int(coordinate))
    required = [f"{time_name}/{name}" for name in ("U", "p", "T", "k", "omega")]
    required += [f"constant/polyMesh/{name}" for name in ("points", "faces", "owner", "neighbour", "boundary")]
    required += ["system/controlDict", "constant/thermophysicalProperties", "constant/turbulenceProperties"]
    if any(name not in verified for name in required):
        raise ValueError("Mapping source lacks authenticated mesh, fields or settings")
    return {"source": str(source), "coordinate": int(coordinate), "manifest_sha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "report_sha256": verified["report.json"], "source_revision": manifest.get("sourceRevision"),
            "members": {name: verified[name] for name in required}}


def map_verified_initial_fields(runner, source, destination, request, settings):
    destination = Path(destination).resolve()
    source = Path(source).resolve()
    if source == destination or source in destination.parents or destination in source.parents:
        raise ValueError("Mapping source and target must be separate scopes")
    receipt = authenticated_mapping_source(source, request, settings)
    command = f"mapFields {shlex.quote(str(source))} -sourceTime {receipt['coordinate']} -consistent -mapMethod interpolate"
    result = runner.application(destination, command, timeout=120)
    (destination / "log.mapFields").write_text(result.stdout)
    result.check()
    mapped = {}
    owner = mesh_list(destination / "constant/polyMesh/owner")
    if not len(owner):
        raise ValueError("Mapped target mesh has no cells")
    count = int(owner.max()) + 1
    for name, width in [("U", 3), ("p", 1), ("T", 1), ("k", 1), ("omega", 1)]:
        path = destination / "0" / name
        values = field(path, width)
        if len(values) != count:
            raise ValueError("Mapped field cell counts differ from the target mesh")
        if not count or not np.isfinite(values).all() or (name != "U" and np.any(values <= 0)):
            raise ValueError("Mapped initial field is not physically finite")
        if name == "T":
            calorics = request["fluid"]["gas"]["nasa7"]
            if np.any(values < calorics["minimum_temperature_k"]) or np.any(values > calorics["maximum_temperature_k"]):
                raise ValueError("Mapped temperature is outside the material domain")
        mapped[name] = {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "cells": count}
    if receipt != authenticated_mapping_source(source, request, settings):
        raise ValueError("Mapping changed its immutable source")
    return {**receipt, "kind": "mapped_initial_conditions_not_solver_evidence", "target_coordinate": 0,
            "method": "interpolate", "mapped_fields": mapped, "command": command}
