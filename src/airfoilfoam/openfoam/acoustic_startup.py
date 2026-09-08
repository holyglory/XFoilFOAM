from __future__ import annotations

import json
import math
from pathlib import Path

from ..material_domain import check_material_domain
from .runner import InfrastructureError


def acoustic_startup_step(case_dir: Path, runner, maximum_courant: float) -> float:
    if isinstance(maximum_courant, bool) or not math.isfinite(maximum_courant) or maximum_courant <= 0:
        raise InfrastructureError("Acoustic startup requires a finite positive Courant ceiling")
    result = runner.application(
        case_dir,
        "/opt/xfoilfoam-thermophysics/bin/xfoilfoamAcousticStartup",
        timeout=60,
    )
    (case_dir / "log.acoustic-startup").write_text(result.stdout, encoding="utf-8")
    check_material_domain(case_dir, result)
    if not result.ok:
        raise InfrastructureError("Native acoustic startup preflight failed; retained log.acoustic-startup")
    records = [line.removeprefix("XFOILFOAM_ACOUSTIC_STARTUP ") for line in result.stdout.splitlines()
               if line.startswith("XFOILFOAM_ACOUSTIC_STARTUP ")]
    try:
        if len(records) != 1:
            raise ValueError("Expected one native startup receipt")
        receipt = json.loads(records[0])
        if not isinstance(receipt, dict):
            raise ValueError("Native startup receipt must be an object")
        values = [receipt[key] for key in ("courant_rate", "maximum_courant", "requested_delta_t", "safe_delta_t")]
        if receipt.get("version") != 1 or any(
            isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0
            for value in values
        ):
            raise ValueError("Invalid native startup values")
        rate, limit, requested, safe = values
        if limit > maximum_courant * (1 + 1e-12) or safe > requested or 1.2 * safe * rate > limit * (1 + 1e-12):
            raise ValueError("Native startup step exceeds its selected Courant ceiling")
    except (KeyError, TypeError, ValueError) as error:
        raise InfrastructureError(f"Invalid native acoustic startup receipt: {error}") from error
    (case_dir / "acoustic-startup.json").write_text(json.dumps(receipt, allow_nan=False) + "\n", encoding="utf-8")
    return safe
