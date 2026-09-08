from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
import re


@dataclass(frozen=True)
class AbsolutePressureReference:
    pressure_pa: float
    density: float
    speed: float


def read_pressure_reference(case_dir: Path) -> AbsolutePressureReference | None:
    reference = case_dir / "constant" / "aerodynamicReference.json"
    pressure = case_dir / "0" / "p"
    if not reference.exists():
        physical_dimensions = pressure.exists() and re.search(
            r"\bdimensions\s*\[\s*1\s+-1\s+-2\s+0\s+0\s+0\s+0\s*\]", pressure.read_text(),
        )
        if physical_dimensions or (case_dir / "constant" / "thermophysicalProperties").exists():
            raise ValueError("Compressible pressure evidence has no stored reference state")
        return None
    try:
        payload = json.loads(reference.read_text())
        if payload["version"] != 1 or payload["pressure_kind"] != "absolute":
            raise ValueError("Unsupported pressure reference version or units")
        values = [payload[key] for key in ("pressure_pa", "density", "speed")]
        if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in values):
            raise ValueError("Pressure reference values must be finite and positive")
        if pressure.exists() and not re.search(
            r"\bdimensions\s*\[\s*1\s+-1\s+-2\s+0\s+0\s+0\s+0\s*\]", pressure.read_text(),
        ):
            raise ValueError("Pressure reference contradicts the stored field dimensions")
        return AbsolutePressureReference(*values)
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise ValueError("Stored compressible pressure reference is corrupt") from error
