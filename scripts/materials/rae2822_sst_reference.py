import hashlib
import math
from pathlib import Path
import re

try:
    from .rae2822_reference import load_reference
except ImportError:
    from rae2822_reference import load_reference


SOURCE_URL = "https://www.grc.nasa.gov/www/wind/valid/raetaf/raetaf04/"
SOURCE_HASHES = {
    "run.sst.lis": "7deea76d017f558976f5aac5e8e85ec5d6c2f75300b2b5562d91992d3eab0cb6",
    "run.sst.dat": "d0a917efadbf893a00ccb4e9b7e0463be26dbe9777996d5c99bed707920d1737",
    "cp.exp.gen": "739bbec6bd8775240bcf571fc8356701cab4c773c4e3d3b21deea5a3f627f001",
}


def _unique_positive(text, pattern):
    matches = re.findall(pattern, text)
    if not matches or len(set(matches)) != 1:
        raise ValueError("SST source quantity is missing or inconsistent across restarts")
    value = float(matches[0])
    if not math.isfinite(value) or value <= 0:
        raise ValueError("SST source quantities must be finite and positive")
    return value


def parse_sst_boundary(log):
    if "(k-omega) SST F. Menter turbulence model" not in log:
        raise ValueError("Reference log does not identify SST")
    kinetic_energy = _unique_positive(log, r"freestream k\s*:\s*([\d.E+-]+) ft\*\*2/s\*\*2") * 0.3048 ** 2
    omega = _unique_positive(log, r"freestream omega\s*:\s*([\d.E+-]+) 1/s")
    return {
        "kinetic_energy_m2_s2": kinetic_energy,
        "omega_per_s": omega,
        "initialization": "restart_from_spalart_allmaras" if (
            "Restart from existing solution" in log
            and "model was  Spalart-Allmaras, model is now    SST-Menter" in log
        ) else "unspecified",
        "native_residual_stop_satisfied": False if "All zones not converged" in log else None,
        "accuracy_certified": False,
    }


def boundary_request(boundary, speed, kinematic_viscosity):
    values = (speed, kinematic_viscosity, boundary["kinetic_energy_m2_s2"], boundary["omega_per_s"])
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0 for value in values):
        raise ValueError("Boundary conversion requires finite positive physical quantities")
    result = {
        "model": "kOmegaSST",
        "intensity": math.sqrt(boundary["kinetic_energy_m2_s2"] / 1.5) / speed,
        "viscosity_ratio": boundary["kinetic_energy_m2_s2"] / boundary["omega_per_s"] / kinematic_viscosity,
    }
    if not 0 < result["intensity"] < 1 or not math.isfinite(result["viscosity_ratio"]) or result["viscosity_ratio"] <= 0:
        raise ValueError("Source boundary cannot be represented by the requested physical setup")
    return result


def load_sst_reference(directory, experimental_directory):
    texts = {}
    for name, digest in SOURCE_HASHES.items():
        path = Path(directory) / name
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 8 * 1024 ** 2:
            raise ValueError("SST reference source must be a bounded regular file")
        raw = path.read_bytes()
        if hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError("SST reference source checksum differs")
        texts[name] = raw.decode("ascii")
    if "freestream static 0.729 15.80734 460.0 2.31 0.0" not in texts["run.sst.dat"] or "turbulence model sst" not in texts["run.sst.dat"]:
        raise ValueError("SST reference physical setup differs")
    reference = load_reference(experimental_directory)
    rows = [tuple(float(value) for value in line.split()) for line in texts["cp.exp.gen"].splitlines()[7:] if line.strip()]
    expected = [(alpha, -coefficient) for alpha, coefficient in reversed(reference["pressure"]["upper"])]
    expected += [(alpha, -coefficient) for alpha, coefficient in reference["pressure"]["lower"][1:]]
    if len(rows) != 103 or rows != expected:
        raise ValueError("SST archive does not share the exact experimental pressure rows")
    return {
        "source_url": SOURCE_URL,
        "source_hashes": dict(SOURCE_HASHES),
        "boundary": parse_sst_boundary(texts["run.sst.lis"]),
        "experimental_pressure_rows": len(rows),
        "interpretation": "reference_computation_boundary_not_measured_tunnel_turbulence",
        "changes_physical_target": True,
    }
