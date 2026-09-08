from __future__ import annotations

import hashlib
import json
import shlex
from pathlib import Path

from ..material_domain import check_material_domain
from .foam_dict import Raw, dimensions, write_foam_dict
from .runner import InfrastructureError


PRESSURE_INITIALIZATION_DIR = "pressure_initialization"


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
    evidence_dir.mkdir(exist_ok=True)
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
    (case_dir / "pressure-initialization.json").write_text(json.dumps({
        "version": 1, "kind": "velocity-only-potential-initialization",
        "aerodynamic_evidence": False,
        "protected_sha256": {name: hashlib.sha256(content).hexdigest() for name, content in protected.items()},
        "velocity_sha256": hashlib.sha256((case_dir / "0/U").read_bytes()).hexdigest(),
        "returncode": result.returncode,
    }, allow_nan=False) + "\n")
    return result
