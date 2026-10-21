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
QUIESCENT_INITIALIZATION_DIR = "quiescent-initialization"


def velocity_internal_entry(content):
    text = content.decode("utf-8")
    cleaned = re.sub(r"/\*.*?\*/|//[^\n]*", lambda match: re.sub(r"[^\n]", " ", match[0]), text, flags=re.DOTALL)
    entries = list(re.finditer(r"\binternalField\s+(uniform|nonuniform)\s+(.*?);", cleaned, re.DOTALL))
    if len(entries) != 1:
        raise InfrastructureError("Cannot verify initialization internal velocity entry")
    return text, entries[0]


def velocity_internal_vectors(content: bytes, require_uniform=False):
    try:
        text, entry = velocity_internal_entry(content)
        if re.search(r"\bformat\s+binary\s*;", text):
            raise ValueError("binary velocity field")
        kind, value = entry.group(1), entry.group(2)
        if require_uniform and kind != "uniform":
            raise ValueError("initial velocity is not uniform freestream")
        if kind == "uniform":
            count, body = 1, value.strip()
        else:
            match = re.fullmatch(r"List<vector>\s+(\d+)\s*\((.*)\)\s*", value, re.DOTALL)
            if match is None:
                raise ValueError("malformed nonuniform velocity")
            count, body = int(match[1]), match[2]
        vectors = re.findall(r"\(([^()]*)\)", body)
        if count <= 0 or len(vectors) != count or re.sub(r"\([^()]*\)", "", body).strip():
            raise ValueError("velocity list count differs from its values")
        parsed = []
        for vector_text in vectors:
            components = tuple(float(component) for component in vector_text.split())
            if len(components) != 3 or not all(math.isfinite(component) for component in components):
                raise ValueError("velocity vectors must have three finite components")
            squared = sum(component * component for component in components)
            if not math.isfinite(squared):
                raise ValueError("velocity magnitude is not finite")
            parsed.append(components)
        return kind, parsed
    except (UnicodeDecodeError, ValueError) as error:
        raise InfrastructureError(f"Cannot verify initialization velocity: {error}") from error


def _scalar_internal_entry(content: bytes):
    try:
        text = content.decode("utf-8")
        cleaned = re.sub(r"/\*.*?\*/|//[^\n]*", lambda match: re.sub(r"[^\n]", " ", match[0]), text, flags=re.DOTALL)
        entries = list(re.finditer(r"\binternalField\s+(uniform|nonuniform)\s+(.*?);", cleaned, re.DOTALL))
        if len(entries) != 1:
            raise ValueError("missing or ambiguous scalar internal field")
        return text, entries[0]
    except (UnicodeDecodeError, ValueError) as error:
        raise InfrastructureError(f"Cannot verify scalar internal field: {error}") from error


def _replace_scalar_internal(content: bytes, values: list[float]) -> bytes:
    text, entry = _scalar_internal_entry(content)
    if not values or not all(math.isfinite(value) for value in values):
        raise InfrastructureError("Thermodynamic initialization requires finite scalar values")
    if len(values) == 1:
        replacement = f"internalField uniform {values[0]:.17g};"
    else:
        rendered = " ".join(f"{value:.17g}" for value in values)
        replacement = f"internalField nonuniform List<scalar> {len(values)} ({rendered});"
    return (text[:entry.start()] + replacement + text[entry.end():]).encode("utf-8")


def _boundary_bytes(content: bytes) -> bytes:
    text = content.decode("utf-8")
    match = re.search(r"\bboundaryField\b", text)
    if match is None:
        raise InfrastructureError("Physical field has no boundaryField section")
    return text[match.start():].encode("utf-8")


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
    _, vectors = velocity_internal_vectors(content, require_uniform=require_uniform)
    return max(sum(component * component for component in vector) for vector in vectors)


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


def _specific_enthalpy(context, temperature_k: float) -> float:
    gas = context.gas
    if gas.nasa7 is not None:
        return gas.gas_constant * gas.nasa7.enthalpy_ratio(temperature_k)
    return gas.heat_capacity_at(temperature_k) * temperature_k


def _specific_entropy_ratio(context, temperature_k: float) -> float:
    gas = context.gas
    if gas.nasa7 is not None:
        return gas.nasa7.entropy_ratio(temperature_k)
    return gas.heat_capacity_at(temperature_k) / gas.gas_constant * math.log(temperature_k)


def _temperature_from_enthalpy(context, target_enthalpy: float) -> float:
    gas = context.gas
    lower = gas.nasa7.minimum_temperature_k if gas.nasa7 is not None else 1e-9
    upper = gas.nasa7.maximum_temperature_k if gas.nasa7 is not None else max(context.state.temperature_k * 4, context.state.temperature_k + 1)
    lower_enthalpy = _specific_enthalpy(context, lower)
    upper_enthalpy = _specific_enthalpy(context, upper)
    tolerance = max(1.0, abs(target_enthalpy), abs(lower_enthalpy), abs(upper_enthalpy)) * 1e-12
    if target_enthalpy < lower_enthalpy - tolerance or target_enthalpy > upper_enthalpy + tolerance:
        raise InfrastructureError("Isentropic initialization requires enthalpy inside the declared material range")
    low, high = lower, upper
    for _ in range(80):
        middle = (low + high) / 2
        if _specific_enthalpy(context, middle) < target_enthalpy:
            low = middle
        else:
            high = middle
    return (low + high) / 2


def _isentropic_thermodynamic_seed(context, freestream_vectors, proposed_vectors):
    if len(freestream_vectors) != 1:
        raise InfrastructureError("Isentropic initialization requires a uniform freestream velocity")
    reference_temperature = context.state.temperature_k
    reference_pressure = context.state.pressure_pa
    reference_speed_squared = sum(component * component for component in freestream_vectors[0])
    total_enthalpy = _specific_enthalpy(context, reference_temperature) + reference_speed_squared / 2
    reference_entropy = _specific_entropy_ratio(context, reference_temperature)
    temperatures = []
    pressures = []
    for vector in proposed_vectors:
        speed_squared = sum(component * component for component in vector)
        temperature = _temperature_from_enthalpy(context, total_enthalpy - speed_squared / 2)
        pressure = reference_pressure * math.exp(_specific_entropy_ratio(context, temperature) - reference_entropy)
        if not math.isfinite(temperature) or not math.isfinite(pressure) or pressure <= 0:
            raise InfrastructureError("Isentropic initialization produced a nonphysical thermodynamic state")
        temperatures.append(temperature)
        pressures.append(pressure)
    return {
        "temperatures": temperatures,
        "pressures": pressures,
        "minimum_temperature_k": min(temperatures),
        "maximum_temperature_k": max(temperatures),
        "minimum_pressure_pa": min(pressures),
        "maximum_pressure_pa": max(pressures),
    }


def initialize_compressible_velocity(case_dir: Path, runner, patches, command: str, *, startup_mode: str = "potential"):
    context = getattr(runner, "flow_execution", None)
    if getattr(context, "family", None) not in {"rhoSimpleFoam", "rhoPimpleFoam"}:
        raise InfrastructureError("Velocity initialization requires a pressure-based gas case")
    if startup_mode not in {"potential", "isentropic_potential"}:
        raise InfrastructureError(f"Unsupported compressible startup mode: {startup_mode}")
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
    original_vectors = velocity_internal_vectors(original_velocity, require_uniform=True)[1]
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
    thermodynamic_seed = None
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
            fields_to_apply = {velocity_path: updated.encode("utf-8")}
            if startup_mode == "isentropic_potential":
                proposed_vectors = velocity_internal_vectors(proposed_velocity)[1]
                thermodynamic_seed = _isentropic_thermodynamic_seed(context, original_vectors, proposed_vectors)
                fields_to_apply[case_dir / "0" / "p"] = _replace_scalar_internal(
                    protected["0/p"], thermodynamic_seed["pressures"]
                )
                fields_to_apply[case_dir / "0" / "T"] = _replace_scalar_internal(
                    protected["0/T"], thermodynamic_seed["temperatures"]
                )
            staged_paths = []
            replaced = []
            try:
                for path, content in fields_to_apply.items():
                    staged = path.parent / f".{path.name}.{attempt_name}"
                    staged.write_bytes(content)
                    staged_paths.append(staged)
                for path, staged in zip(fields_to_apply, staged_paths):
                    os.replace(staged, path)
                    replaced.append(path)
                if thermodynamic_seed is not None:
                    for name in ("0/p", "0/T"):
                        if _boundary_bytes((case_dir / name).read_bytes()) != _boundary_bytes(protected[name]):
                            raise InfrastructureError("Isentropic initialization changed a physical boundary field")
            except BaseException:
                for staged in staged_paths:
                    if staged.exists():
                        staged.unlink()
                originals = {
                    case_dir / name: content
                    for name, content in protected.items()
                    if (case_dir / name).exists()
                }
                originals[velocity_path] = original_velocity
                for path, content in originals.items():
                    restore = path.parent / f".{path.name}.restore-{attempt_name}"
                    restore.write_bytes(content)
                    os.replace(restore, path)
                raise
            applied = True
    except BaseException as error:
        failure = f"{type(error).__name__}: {error}"
        raise
    finally:
        applied_velocity = velocity_path.read_bytes()
        (attempt_dir / "U.applied").write_bytes(applied_velocity)
        if thermodynamic_seed is not None:
            (attempt_dir / "p.applied").write_bytes((case_dir / "0/p").read_bytes())
            (attempt_dir / "T.applied").write_bytes((case_dir / "0/T").read_bytes())
        receipt = json.dumps({
            "version": 3, "kind": "velocity-only-potential-initialization",
            "startup_mode": startup_mode,
            "attempt_directory": attempt_name,
            "aerodynamic_evidence": False,
            "protected_sha256": {name: hashlib.sha256(content).hexdigest() for name, content in protected.items()},
            "protected_boundary_sha256": (
                {
                    name: hashlib.sha256(_boundary_bytes(content)).hexdigest()
                    for name, content in protected.items()
                    if name in {"0/p", "0/T"}
                }
                if startup_mode == "isentropic_potential"
                else {}
            ),
            "velocity_sha256": hashlib.sha256(applied_velocity).hexdigest(),
            "proposed_velocity_sha256": hashlib.sha256(proposed_velocity).hexdigest() if proposed_velocity is not None else None,
            "maximum_proposed_velocity": math.sqrt(proposed_squared) if proposed_squared is not None else None,
            "maximum_adiabatic_velocity": math.sqrt(velocity_limit_squared),
            "applied": applied,
            "thermodynamic_seed": thermodynamic_seed,
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


def initialize_quiescent_velocity(case_dir: Path) -> dict:
    """Replace only a uniform internal velocity with rest for a transient canary."""
    case_dir = Path(case_dir)
    velocity_path = case_dir / "0/U"
    original_velocity = velocity_path.read_bytes()
    original_sha256 = hashlib.sha256(original_velocity).hexdigest()
    protected = {
        name: (case_dir / name).read_bytes()
        for name in ("0/p", "0/T", "constant/thermophysicalProperties")
        if (case_dir / name).is_file()
    }
    evidence_root = case_dir / "system" / QUIESCENT_INITIALIZATION_DIR
    evidence_root.mkdir(parents=True, exist_ok=True)
    for receipt_path in sorted(evidence_root.glob("attempt-*/receipt.json")):
        receipt = json.loads(receipt_path.read_text())
        if (
            receipt.get("version") == 1
            and receipt.get("kind") == "quiescent-initial-velocity"
            and receipt.get("applied_sha256") == original_sha256
        ):
            expected = receipt.get("protected_sha256")
            actual = {name: hashlib.sha256(content).hexdigest() for name, content in protected.items()}
            if expected != actual:
                raise InfrastructureError("Quiescent initialization protected fields changed")
            return receipt

    original_text, original_entry = velocity_internal_entry(original_velocity)
    if original_entry.group(1) != "uniform":
        raise InfrastructureError("Quiescent initialization requires a uniform internal velocity")
    if internal_velocity_squared(original_velocity, require_uniform=True) == 0:
        raise InfrastructureError("Zero internal velocity has no matching quiescent receipt")

    updated_velocity = (
        original_text[: original_entry.start()]
        + "internalField uniform (0 0 0);"
        + original_text[original_entry.end() :]
    ).encode()
    attempt_name = f"attempt-{uuid4().hex}"
    attempt_dir = evidence_root / attempt_name
    attempt_dir.mkdir(parents=True, exist_ok=False)
    (attempt_dir / "U.original").write_bytes(original_velocity)
    (attempt_dir / "U.applied").write_bytes(updated_velocity)
    for name, content in protected.items():
        retained = attempt_dir / "original" / name
        retained.parent.mkdir(parents=True, exist_ok=True)
        retained.write_bytes(content)
    staged = velocity_path.parent / f".U-{attempt_name}"
    try:
        staged.write_bytes(updated_velocity)
        os.replace(staged, velocity_path)
        if any((case_dir / name).read_bytes() != content for name, content in protected.items()):
            raise InfrastructureError("Quiescent initialization changed a protected physical field")
        applied_velocity = velocity_path.read_bytes()
        receipt = {
            "version": 1,
            "kind": "quiescent-initial-velocity",
            "attempt_directory": attempt_name,
            "aerodynamic_evidence": False,
            "applied": True,
            "original_sha256": original_sha256,
            "applied_sha256": hashlib.sha256(applied_velocity).hexdigest(),
            "protected_sha256": {name: hashlib.sha256(content).hexdigest() for name, content in protected.items()},
        }
        (attempt_dir / "receipt.json").write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
        return receipt
    except BaseException:
        if staged.exists():
            staged.unlink()
        restore = velocity_path.parent / f".U-restore-{attempt_name}"
        restore.write_bytes(original_velocity)
        os.replace(restore, velocity_path)
        shutil.rmtree(attempt_dir, ignore_errors=True)
        raise
