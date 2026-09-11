from __future__ import annotations

import hashlib
import json
import math
import re
import shlex
from pathlib import Path

from ..material_domain import check_material_domain
from .foam_dict import Raw, dimensions, write_foam_dict
from .runner import InfrastructureError


PRESSURE_INITIALIZATION_DIR = "pressure_initialization"


def internal_velocity_squared(content: bytes, require_uniform=False):
    try:
        text = content.decode("utf-8")
        text = re.sub(r"/\*.*?\*/|//[^\n]*", "", text, flags=re.DOTALL)
        if re.search(r"\bformat\s+binary\s*;", text):
            raise ValueError("binary velocity field")
        entries = re.findall(r"\binternalField\s+(uniform|nonuniform)\s+(.*?);", text, re.DOTALL)
        if len(entries) != 1:
            raise ValueError("missing or ambiguous internal velocity")
        kind, value = entries[0]
        if require_uniform and kind != "uniform":
            raise ValueError("initial velocity is not uniform freestream")
        if kind == "uniform":
            body, count = value.strip(), 1
        else:
            match = re.fullmatch(r"List<vector>\s+(\d+)\s*\((.*)\)\s*", value, re.DOTALL)
            if match is None:
                raise ValueError("malformed nonuniform velocity")
            count, body = int(match[1]), match[2]
        vectors = re.findall(r"\(([^()]*)\)", body)
        if count <= 0 or len(vectors) != count or re.sub(r"\([^()]*\)", "", body).strip():
            raise ValueError("velocity list count differs from its values")
        maximum = 0.0
        for vector in vectors:
            components = [float(component) for component in vector.split()]
            if len(components) != 3 or not all(math.isfinite(component) for component in components):
                raise ValueError("velocity vectors must have three finite components")
            squared = sum(component * component for component in components)
            if not math.isfinite(squared):
                raise ValueError("velocity magnitude is not finite")
            maximum = max(maximum, squared)
        return maximum
    except (UnicodeDecodeError, ValueError) as error:
        raise InfrastructureError(f"Cannot verify initialization velocity: {error}") from error


def adiabatic_velocity_limit_squared(context, freestream_squared):
    if isinstance(freestream_squared, bool) or not isinstance(freestream_squared, (int, float)) or not math.isfinite(freestream_squared) or freestream_squared < 0:
        raise InfrastructureError("Initialization requires a finite freestream velocity magnitude")
    gas, temperature = context.gas, context.state.temperature_k
    heat_capacity = gas.heat_capacity_at(temperature)
    if gas.nasa7 is None:
        available = heat_capacity * temperature
    else:
        available = gas.gas_constant * (
            gas.nasa7.enthalpy_ratio(temperature)
            - gas.nasa7.enthalpy_ratio(gas.nasa7.minimum_temperature_k)
        )
    bound = freestream_squared + 2 * available
    if not math.isfinite(bound) or available < 0 or bound <= 0:
        raise InfrastructureError("Initialization has no finite adiabatic velocity range")
    return bound


def initialize_compressible_velocity(case_dir: Path, runner, patches, command: str):
    context = getattr(runner, "flow_execution", None)
    if getattr(context, "family", None) not in {"rhoSimpleFoam", "rhoPimpleFoam"}:
        raise InfrastructureError("Velocity initialization requires a pressure-based gas case")
    pressure_name = "pXfoilfoamInitial"
    temporary = case_dir / "0" / pressure_name
    if temporary.exists():
        raise InfrastructureError("The reserved initialization pressure already exists")
    protected = {
        name: (case_dir / name).read_bytes()
        for name in ("0/p", "0/T", "constant/thermophysicalProperties")
    }
    velocity_path = case_dir / "0/U"
    original_velocity = velocity_path.read_bytes()
    freestream_squared = internal_velocity_squared(original_velocity, require_uniform=True)
    velocity_limit_squared = adiabatic_velocity_limit_squared(context, freestream_squared)
    boundary = {}
    for patch in patches:
        if patch.role == "outlet":
            boundary[patch.name] = {"type": "fixedValue", "value": Raw("uniform 0")}
        elif patch.role in {"inlet", "wall"}:
            boundary[patch.name] = {"type": "zeroGradient"}
        elif patch.role == "empty":
            boundary[patch.name] = {"type": "empty"}
        else:
            raise InfrastructureError("Unsupported initialization boundary role")
    if not any(patch.role == "outlet" for patch in patches):
        raise InfrastructureError("Velocity initialization requires an outlet reference")
    evidence_dir = case_dir / PRESSURE_INITIALIZATION_DIR
    if (case_dir / "pressure-initialization.json").exists():
        raise InfrastructureError("The initialization receipt already exists")
    try:
        evidence_dir.mkdir()
    except FileExistsError as error:
        raise InfrastructureError("The initialization evidence already exists") from error
    (evidence_dir / "U.freestream").write_bytes(original_velocity)
    try:
        write_foam_dict(temporary, "volScalarField", pressure_name, {
            "dimensions": dimensions(0, 2, -2, 0, 0, 0, 0),
            "internalField": Raw("uniform 0"), "boundaryField": boundary,
        })
        (evidence_dir / pressure_name).write_bytes(temporary.read_bytes())
        velocity_only = shlex.join([argument for argument in shlex.split(command) if argument not in {"-writephi", "-writep", "-writePhi", "-withFunctionObjects"}])
        result = runner.solver(case_dir, f"{velocity_only} -pName {pressure_name}", 1, timeout=600)
    finally:
        temporary.unlink(missing_ok=True)
    check_material_domain(case_dir, result)
    if any((case_dir / name).read_bytes() != content for name, content in protected.items()):
        raise InfrastructureError("Velocity initialization changed the physical pressure or material state")
    proposed_velocity = velocity_path.read_bytes()
    (evidence_dir / "U.potential").write_bytes(proposed_velocity)
    proposed_squared = internal_velocity_squared(proposed_velocity) if result.ok else None
    applied = result.ok and proposed_squared < velocity_limit_squared
    if result.ok and not applied:
        velocity_path.write_bytes(original_velocity)
    (case_dir / "pressure-initialization.json").write_text(json.dumps({
        "version": 2, "kind": "velocity-only-potential-initialization",
        "aerodynamic_evidence": False,
        "protected_sha256": {name: hashlib.sha256(content).hexdigest() for name, content in protected.items()},
        "velocity_sha256": hashlib.sha256(velocity_path.read_bytes()).hexdigest(),
        "proposed_velocity_sha256": hashlib.sha256(proposed_velocity).hexdigest(),
        "maximum_proposed_velocity": math.sqrt(proposed_squared) if proposed_squared is not None else None,
        "maximum_adiabatic_velocity": math.sqrt(velocity_limit_squared),
        "applied": applied,
        "fallback_reason": "exceeds_available_stagnation_enthalpy" if result.ok and not applied else None,
        "returncode": result.returncode,
    }, allow_nan=False) + "\n")
    return result
