from __future__ import annotations

import hashlib
import json
from pathlib import Path

from .openfoam.runner import MaterialDomainError
from .material_warning import MATERIAL_DOMAIN_WARNING


def material_domain_failure(case_dir: Path, result: object) -> MaterialDomainError | None:
    stdout = str(getattr(result, "stdout", ""))
    warnings = MATERIAL_DOMAIN_WARNING.findall(stdout)
    if not warnings:
        return None
    raw = stdout.encode("utf-8")
    signature = hashlib.sha256(raw).hexdigest()
    log_name = f"log.material-domain-{signature}"
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / log_name).write_bytes(raw)
    (case_dir / "material-domain-diagnostic.json").write_text(
        json.dumps({
            "kind": "native-material-temperature-clamping",
            "warning_count": len(warnings),
            "solver_log": log_name,
            "solver_log_sha256": signature,
            "command": str(getattr(result, "command", "")),
            "returncode": getattr(result, "returncode", None),
            "timed_out": bool(getattr(result, "timed_out", False)),
            "physical_cfd_validated": False,
        }, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    return MaterialDomainError(
        f"The native solver clamped temperature outside its material domain "
        f"({len(warnings)} warnings); retained log {log_name}"
    )


def check_material_domain(case_dir: Path, result: object) -> None:
    failure = material_domain_failure(case_dir, result)
    if failure is not None:
        raise failure
