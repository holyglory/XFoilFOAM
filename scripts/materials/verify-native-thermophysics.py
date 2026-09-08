from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import tempfile

from airfoilfoam.thermophysical_constants import OPENCFD2606_UNIVERSAL_GAS_CONSTANT, OPENCFD2606_STANDARD_PRESSURE_PA


def verify_native(fixture_path: Path, report_root: Path) -> dict:
    fixture_bytes = fixture_path.read_bytes()
    fixture = json.loads(fixture_bytes)
    if fixture["kind"] != "source-derived-native-material-regression" or fixture["installed"]:
        raise ValueError("Native regression requires its explicitly isolated source fixture")
    calorics, transport = fixture["calorics"], fixture["transport"]
    gas_constant = fixture["gas_constant"]
    pressure = fixture["source"]["transport_pressure_pa"]
    temperatures = [sample["temperature_k"] for sample in fixture["source_samples"]]
    directory = Path(tempfile.mkdtemp(prefix="native-material-", dir=report_root))

    def vector(values):
        return "(" + " ".join(format(value, ".17g") for value in values) + ")"

    entropy_offset = math.log(calorics["entropy_reference_pressure_pa"]) - math.log(OPENCFD2606_STANDARD_PRESSURE_PA)
    low = [*calorics["low_coefficients"][:6], calorics["low_coefficients"][6] + entropy_offset]
    high = [*calorics["high_coefficients"][:6], calorics["high_coefficients"][6] + entropy_offset]

    specification = f"""
pressure {pressure:.17g};
temperatures {vector(temperatures)};
mixture
{{
    specie {{ molWeight {OPENCFD2606_UNIVERSAL_GAS_CONSTANT / gas_constant:.17g}; }}
    thermodynamics
    {{
        Tlow {calorics['minimum_temperature_k']:.17g};
        Thigh {calorics['maximum_temperature_k']:.17g};
        Tcommon {calorics['common_temperature_k']:.17g};
        lowCpCoeffs {vector(low)};
        highCpCoeffs {vector(high)};
    }}
    transport
    {{
        muCoeffs<8> {vector(transport['dynamic_viscosity_coefficients'])};
        kappaCoeffs<8> {vector(transport['thermal_conductivity_coefficients'])};
    }}
}}
"""
    (directory / "input.dict").write_text(specification)
    result = subprocess.run(["/opt/xfoilfoam-thermophysics/bin/xfoilfoamThermoProbe", str(directory / "input.dict")],
        check=False, capture_output=True, text=True, timeout=30)
    (directory / "stdout.txt").write_text(result.stdout)
    (directory / "stderr.txt").write_text(result.stderr)
    result.check_returncode()
    native = json.loads(result.stdout)
    if native["registered_combinations"] != 1 or len(native["samples"]) != len(temperatures):
        raise ValueError("Native registration or material sample count differs")
    if not math.isclose(native["universal_gas_constant"], OPENCFD2606_UNIVERSAL_GAS_CONSTANT, rel_tol=1e-14):
        raise ValueError("The running native gas constant differs from the pinned adapter")
    errors = {}
    for expected_temperature, sample in zip(temperatures, native["samples"]):
        if sample["temperature_k"] != expected_temperature:
            raise ValueError("Native sample temperature differs")
        coefficients = calorics["low_coefficients"] if expected_temperature < calorics["common_temperature_k"] else calorics["high_coefficients"]
        expected = {
            "dynamic_viscosity": sum(value * expected_temperature ** index for index, value in enumerate(transport["dynamic_viscosity_coefficients"])),
            "thermal_conductivity": sum(value * expected_temperature ** index for index, value in enumerate(transport["thermal_conductivity_coefficients"])),
            "heat_capacity": gas_constant * sum(value * expected_temperature ** index for index, value in enumerate(coefficients[:5])),
            "enthalpy": gas_constant * (coefficients[5] + sum(value * expected_temperature ** (index + 1) / (index + 1) for index, value in enumerate(coefficients[:5]))),
            "entropy": gas_constant * (coefficients[0] * math.log(expected_temperature) + coefficients[6] + sum(value * expected_temperature ** index / index for index, value in enumerate(coefficients[1:5], 1)) - math.log(pressure / calorics["entropy_reference_pressure_pa"])),
            "density": pressure / (gas_constant * expected_temperature),
        }
        for name, value in expected.items():
            measured = sample[name]
            if not math.isfinite(measured) or not math.isclose(measured, value, rel_tol=1e-10, abs_tol=1e-14):
                raise ValueError(f"Native {name} differs from the supplied material model at {expected_temperature} K")
            errors[name] = max(errors.get(name, 0), abs(measured - value) / abs(value))
    report = {"kind": "native-material-implementation-check", "fixture_sha256": hashlib.sha256(fixture_bytes).hexdigest(),
        "source_audit_sha256": fixture["source_audit_sha256"], "source": fixture["source"],
        "native_library_sha256": hashlib.sha256(Path("/opt/xfoilfoam-thermophysics/lib/libxfoilfoamThermophysics.so").read_bytes()).hexdigest(),
        "maximum_relative_implementation_errors": errors, "samples": len(temperatures), "registered_combinations": 1,
        "physical_cfd_validated": False, "installed_catalog_material": False, "report_directory": str(directory)}
    (directory / "receipt.json").write_text(json.dumps(report, sort_keys=True, allow_nan=False) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--reports", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(verify_native(args.fixture, args.reports), allow_nan=False))


if __name__ == "__main__":
    main()
