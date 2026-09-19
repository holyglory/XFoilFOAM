from __future__ import annotations

import hashlib
import json
import math
import os
import re
import shlex
import shutil
from pathlib import Path
from uuid import uuid4

from ..material_domain import check_material_domain
from .foam_dict import Raw, dimensions, render_field, write_foam_dict
from .runner import InfrastructureError


PRESSURE_INITIALIZATION_DIR = "pressure_initialization"


def velocity_internal_entry(content):
    text = content.decode("utf-8")
    cleaned = re.sub(r"/\*.*?\*/|//[^\n]*", lambda match: re.sub(r"[^\n]", " ", match[0]), text, flags=re.DOTALL)
    entries = list(re.finditer(r"\binternalField\s+(uniform|nonuniform)\s+(.*?);", cleaned, re.DOTALL))
    if len(entries) != 1:
        raise InfrastructureError("Cannot verify initialization internal velocity entry")
    return text, entries[0]


def preserve_previous_initialization(case_dir, evidence_dir):
    receipt_path = case_dir / "pressure-initialization.json"
    if not receipt_path.exists():
        if evidence_dir.exists():
            raise InfrastructureError("The initialization evidence already exists without a receipt")
        return
    try:
        content = receipt_path.read_bytes()
        receipt = json.loads(content)
        if receipt["kind"] != "velocity-only-potential-initialization" or receipt["version"] not in {2, 3}:
            raise ValueError("unknown initialization receipt")
        if receipt["version"] == 3:
            scope = receipt["attempt_directory"]
            if not re.fullmatch(r"attempt-[0-9a-f]{32}", scope):
                raise ValueError("invalid initialization attempt identity")
            if (evidence_dir / scope / "pressure-initialization.json").read_bytes() != content:
                raise ValueError("initialization receipt identity differs")
            for filename, key in (("U.potential", "proposed_velocity_sha256"), ("U.applied", "velocity_sha256")):
                expected = receipt.get(key)
                if expected is not None and hashlib.sha256((evidence_dir / scope / filename).read_bytes()).hexdigest() != expected:
                    raise ValueError("initialization velocity evidence differs")
        else:
            proposed = evidence_dir / "U.potential"
            if hashlib.sha256(proposed.read_bytes()).hexdigest() != receipt["proposed_velocity_sha256"]:
                raise ValueError("legacy initialization evidence differs")
            retained = evidence_dir / f"legacy-receipt-{hashlib.sha256(content).hexdigest()}.json"
            if retained.exists():
                if retained.read_bytes() != content:
                    raise ValueError("legacy initialization receipt differs")
            else:
                with retained.open("xb") as stream:
                    stream.write(content)
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise InfrastructureError(f"The initialization receipt already exists but cannot be verified: {error}") from error


def copy_initialization_inputs(case_dir, work_dir, runner):
    for directory in ("0", "system"):
        source = case_dir / directory
        if source.is_dir():
            shutil.copytree(source, work_dir / directory)
    destination = work_dir / "constant"
    destination.mkdir()
    for source in (case_dir / "constant").iterdir():
        target = destination / source.name
        if source.name == "polyMesh" and getattr(runner, "external_paths_visible", False):
            target.symlink_to(source.resolve(strict=True), target_is_directory=True)
        elif source.is_dir():
            shutil.copytree(source, target)
        else:
            shutil.copy2(source, target)


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
    velocity_boundary = {}
    _, freestream_entry = velocity_internal_entry(original_velocity)
    freestream = "uniform " + freestream_entry.group(2).strip()
    for patch in patches:
        if patch.role == "outlet":
            boundary[patch.name] = {"type": "fixedValue", "value": Raw("uniform 0")}
            velocity_boundary[patch.name] = {"type": "zeroGradient"}
        elif patch.role in {"inlet", "wall"}:
            boundary[patch.name] = {"type": "zeroGradient"}
            velocity_boundary[patch.name] = {"type": "fixedValue", "value": Raw(freestream if patch.role == "inlet" else "uniform (0 0 0)")}
        elif patch.role == "empty":
            boundary[patch.name] = {"type": "empty"}
            velocity_boundary[patch.name] = {"type": "empty"}
        else:
            raise InfrastructureError("Unsupported initialization boundary role")
    if not any(patch.role == "outlet" for patch in patches):
        raise InfrastructureError("Velocity initialization requires an outlet reference")
    evidence_dir = case_dir / PRESSURE_INITIALIZATION_DIR
    preserve_previous_initialization(case_dir, evidence_dir)
    attempt_name = f"attempt-{uuid4().hex}"
    attempt_dir = evidence_dir / attempt_name
    attempt_dir.mkdir(parents=True, exist_ok=False)
    work_dir = case_dir / f".{attempt_name}"
    work_dir.mkdir()
    result = None
    proposed_velocity = None
    proposed_squared = None
    applied = False
    failure = None
    try:
        copy_initialization_inputs(case_dir, work_dir, runner)
        (attempt_dir / "U.freestream").write_bytes(original_velocity)
        for name, content in protected.items():
            retained = attempt_dir / "original" / name
            retained.parent.mkdir(parents=True, exist_ok=True)
            retained.write_bytes(content)
        temporary = work_dir / "0" / pressure_name
        write_foam_dict(temporary, "volScalarField", pressure_name, {
            "dimensions": dimensions(0, 2, -2, 0, 0, 0, 0),
            "internalField": Raw("uniform 0"), "boundaryField": boundary,
        })
        (attempt_dir / pressure_name).write_bytes(temporary.read_bytes())
        initial_velocity = render_field("volVectorField", "U", dimensions(0, 1, -1, 0, 0, 0, 0), freestream, velocity_boundary).encode()
        (work_dir / "0/U").write_bytes(initial_velocity)
        (attempt_dir / "U.auxiliary").write_bytes(initial_velocity)
        if (work_dir / "system").is_dir():
            shutil.copytree(work_dir / "system", attempt_dir / "system")
        velocity_only = shlex.join([argument for argument in shlex.split(command) if argument not in {"-writephi", "-writep", "-writePhi", "-withFunctionObjects"}])
        result = runner.solver(work_dir, f"{velocity_only} -pName {pressure_name}", 1, timeout=600)
        (attempt_dir / "log.potentialFoam").write_bytes(str(result.stdout).encode())
        proposed_velocity = (work_dir / "0/U").read_bytes()
        (attempt_dir / "U.potential").write_bytes(proposed_velocity)
        if any((work_dir / name).read_bytes() != content for name, content in protected.items()):
            raise InfrastructureError("Velocity initialization changed the physical pressure or material state")
        check_material_domain(case_dir, result)
        if any((case_dir / name).read_bytes() != content for name, content in protected.items()):
            raise InfrastructureError("Velocity initialization changed the physical pressure or material state")
        proposed_squared = internal_velocity_squared(proposed_velocity) if result.ok else None
        admissible = result.ok and proposed_squared < velocity_limit_squared
        if admissible:
            _, proposed_entry = velocity_internal_entry(proposed_velocity)
            original_text, original_entry = velocity_internal_entry(original_velocity)
            updated = original_text[:original_entry.start()] + proposed_entry[0] + original_text[original_entry.end():]
            staged = case_dir / "0" / f".U.{attempt_name}"
            staged.write_text(updated)
            os.replace(staged, velocity_path)
            applied = True
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        applied_velocity = velocity_path.read_bytes()
        (attempt_dir / "U.applied").write_bytes(applied_velocity)
        receipt = json.dumps({
            "version": 3, "kind": "velocity-only-potential-initialization",
            "attempt_directory": attempt_name,
            "aerodynamic_evidence": False,
            "protected_sha256": {name: hashlib.sha256(content).hexdigest() for name, content in protected.items()},
            "velocity_sha256": hashlib.sha256(applied_velocity).hexdigest(),
            "proposed_velocity_sha256": hashlib.sha256(proposed_velocity).hexdigest() if proposed_velocity is not None else None,
            "maximum_proposed_velocity": math.sqrt(proposed_squared) if proposed_squared is not None else None,
            "maximum_adiabatic_velocity": math.sqrt(velocity_limit_squared),
            "applied": applied,
            "fallback_reason": "exceeds_available_stagnation_enthalpy" if result is not None and result.ok and failure is None and not applied else None,
            "returncode": result.returncode if result is not None else None,
            "error": failure,
        }, allow_nan=False) + "\n"
        (attempt_dir / "pressure-initialization.json").write_text(receipt)
        staged_receipt = case_dir / f".pressure-initialization-{attempt_name}.json"
        staged_receipt.write_text(receipt)
        os.replace(staged_receipt, case_dir / "pressure-initialization.json")
        shutil.rmtree(work_dir)
    return result
