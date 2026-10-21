from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re

from .openfoam.runner import MaterialDomainError
from .material_warning import material_temperature_diagnostics


_FLOAT_TOKEN = r"(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?(?:nan|inf))"
_UNIFORM_TEMPERATURE = re.compile(rf"\binternalField\s+uniform\s+({_FLOAT_TOKEN})\s*;", re.IGNORECASE)
_LIST_TEMPERATURE = re.compile(
    rf"\binternalField\s+nonuniform\s+List<scalar>\s+(\d+)\s*\((.*?)\)\s*;",
    re.IGNORECASE | re.DOTALL,
)


def _latest_temperature_file(case_dir: Path) -> tuple[Path | None, str | None]:
    candidates: list[tuple[float, Path, str]] = []
    for child in case_dir.iterdir() if case_dir.is_dir() else ():
        if not child.is_dir():
            continue
        try:
            value = float(child.name)
        except ValueError:
            continue
        candidates.append((value, child / "T", child.name))
    for _, path, name in sorted(candidates, reverse=True):
        if path.is_file():
            return path, name
    return None, None


def _finite_positive_temperature_guard(case_dir: Path) -> dict | None:
    if os.environ.get("AIRFOILFOAM_DIAGNOSTIC_FINITE_T_GUARD") != "1":
        return None
    path, time_name = _latest_temperature_file(case_dir)
    if path is None or time_name is None:
        return {"enabled": True, "valid": False, "error": "no numeric T field was written"}
    content = path.read_text(encoding="utf-8", errors="replace")
    uniform = _UNIFORM_TEMPERATURE.search(content)
    if uniform is not None:
        raw_values = [uniform.group(1)]
        expected_count = 1
    else:
        listed = _LIST_TEMPERATURE.search(content)
        if listed is None:
            return {
                "enabled": True,
                "valid": False,
                "time": time_name,
                "field": str(path),
                "error": "could not parse internalField",
            }
        expected_count = int(listed.group(1))
        raw_values = re.findall(_FLOAT_TOKEN, listed.group(2), re.IGNORECASE)
    values = [float(value) for value in raw_values]
    invalid = [value for value in values if not math.isfinite(value) or value <= 0]
    valid = len(values) == expected_count and not invalid
    return {
        "enabled": True,
        "valid": valid,
        "time": time_name,
        "field": str(path),
        "value_count": len(values),
        "expected_count": expected_count,
        "minimum_temperature_k": min(values) if values and all(math.isfinite(value) for value in values) else None,
        "maximum_temperature_k": max(values) if values and all(math.isfinite(value) for value in values) else None,
        "invalid_value_count": len(invalid),
        "invalid_value_sample": [repr(value) for value in invalid[:8]],
        **({"error": "internalField count does not match its declared size"} if len(values) != expected_count else {}),
    }


def material_domain_failure(case_dir: Path, result: object) -> MaterialDomainError | None:
    stdout = str(getattr(result, "stdout", ""))
    diagnostics = material_temperature_diagnostics(stdout)
    temperature_guard = _finite_positive_temperature_guard(case_dir)
    if not diagnostics["warning_count"] and (temperature_guard is None or temperature_guard["valid"]):
        return None
    raw = stdout.encode("utf-8")
    signature = hashlib.sha256(raw).hexdigest()
    log_name = f"log.material-domain-{signature}"
    case_dir.mkdir(parents=True, exist_ok=True)
    (case_dir / log_name).write_bytes(raw)
    (case_dir / "material-domain-diagnostic.json").write_text(
        json.dumps({
            "kind": "native-material-temperature-guard",
            **diagnostics,
            "finite_positive_temperature_guard": temperature_guard,
            "solver_log": log_name,
            "solver_log_sha256": signature,
            "command": str(getattr(result, "command", "")),
            "returncode": getattr(result, "returncode", None),
            "timed_out": bool(getattr(result, "timed_out", False)),
            "physical_cfd_validated": False,
        }, allow_nan=False) + "\n",
        encoding="utf-8",
    )
    if temperature_guard is not None and not temperature_guard["valid"]:
        return MaterialDomainError(
            f"The finite-positive-temperature guard rejected the native solver field; retained log {log_name}"
        )
    return MaterialDomainError(
        f"The native solver clamped temperature outside its material domain "
        f"({diagnostics['warning_count']} warnings); retained log {log_name}"
    )


def check_material_domain(case_dir: Path, result: object) -> None:
    failure = material_domain_failure(case_dir, result)
    if failure is not None:
        raise failure
