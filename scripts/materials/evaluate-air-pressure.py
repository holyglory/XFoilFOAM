from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import tempfile

from airfoilfoam.thermodynamics import GasThermodynamics, ThermodynamicState
from airfoilfoam.transport import PolynomialTransport


PROPERTIES = {
    "density": "Dmass",
    "heat_capacity": "Cpmass",
    "speed_of_sound": "A",
    "dynamic_viscosity": "VISCOSITY",
    "thermal_conductivity": "CONDUCTIVITY",
}


def source_model(fixture: dict) -> GasThermodynamics:
    if fixture["kind"] != "source-derived-native-material-regression" or fixture["installed"] is not False:
        raise ValueError("Pressure audit requires the isolated source-derived material fixture")
    transport = PolynomialTransport.model_validate(fixture["transport"])
    reference_temperature = 288.15
    return GasThermodynamics(
        gas_constant=fixture["gas_constant"], heat_capacity_model="nasa7", nasa7=fixture["calorics"],
        transport_model="polynomial", polynomial_transport=transport,
        reference_dynamic_viscosity=transport.dynamic_viscosity(reference_temperature),
        reference_temperature_k=reference_temperature,
        provenance=f"Uninstalled pressure audit candidate from source audit {fixture['source_audit_sha256']}",
    )


def isentropic_reference_path(model: GasThermodynamics, reference: ThermodynamicState,
                              mach: float, samples: int = 81) -> list[ThermodynamicState]:
    if not math.isfinite(mach) or mach < 0 or not isinstance(samples, int) or isinstance(samples, bool) or samples < 2:
        raise ValueError("Reference path requires finite nonnegative Mach and at least two samples")
    calorics = model.nasa7
    if calorics is None:
        raise ValueError("Reference path requires explicit temperature-dependent calorics")
    speed = mach * model.speed_of_sound(reference)
    target_enthalpy_ratio = calorics.enthalpy_ratio(reference.temperature_k) + speed * speed / (2 * model.gas_constant)
    if target_enthalpy_ratio > calorics.enthalpy_ratio(calorics.maximum_temperature_k):
        raise ValueError("Reference stagnation enthalpy exceeds the material temperature domain")
    lower, upper = reference.temperature_k, calorics.maximum_temperature_k
    for iteration in range(80):
        midpoint = (lower + upper) / 2
        if calorics.enthalpy_ratio(midpoint) < target_enthalpy_ratio:
            lower = midpoint
        else:
            upper = midpoint
    stagnation_temperature = (lower + upper) / 2
    temperatures = [calorics.minimum_temperature_k +
        (stagnation_temperature - calorics.minimum_temperature_k) * index / (samples - 1)
        for index in range(samples)]
    temperatures = sorted(set([*temperatures, reference.temperature_k]))
    reference_entropy_ratio = calorics.entropy_ratio(reference.temperature_k)
    return [ThermodynamicState(temperature_k=temperature, pressure_pa=reference.pressure_pa *
        math.exp(calorics.entropy_ratio(temperature) - reference_entropy_ratio)) for temperature in temperatures]


def verify_source(fixture_source: dict, library, source_json: str, cas: str) -> None:
    expected = {
        "name": "CoolProp", "version": library.__version__, "git_revision": library.__gitrevision__,
        "fluid": "HEOS::Air", "cas": cas,
        "fluid_json_sha256": hashlib.sha256(source_json.encode()).hexdigest(),
    }
    if library.__version__ != "8.0.0" or cas != "AIR.PPF" or any(
        fixture_source.get(key) != value for key, value in expected.items()
    ):
        raise ValueError("Pressure audit source identity differs from the pinned fit source")


def compare_state(model: GasThermodynamics, state: ThermodynamicState, source_values, gas_phases: set[float]) -> dict:
    row = {**state.model_dump(), "status": "source_error", "phase": None,
           "source": None, "candidate": None, "relative_errors": None, "error": None}
    try:
        phase = float(source_values("Phase", state))
        if not math.isfinite(phase):
            raise ValueError("Source phase is not finite")
        row["phase"] = phase
        if phase not in gas_phases:
            row["status"] = "excluded_phase"
            return row
        source = {key: float(source_values(property_name, state)) for key, property_name in PROPERTIES.items()}
        if any(not math.isfinite(value) or value <= 0 for value in source.values()):
            raise ValueError("Source properties must be finite and positive")
    except (ValueError, RuntimeError, OverflowError) as error:
        row["error"] = str(error)
        return row
    row["source"] = source
    try:
        candidate = {
            "density": model.density(state), "heat_capacity": model.heat_capacity_at(state.temperature_k),
            "speed_of_sound": model.speed_of_sound(state),
            "dynamic_viscosity": model.dynamic_viscosity(state.temperature_k),
            "thermal_conductivity": model.thermal_conductivity(state.temperature_k),
        }
        if any(not math.isfinite(value) or value <= 0 for value in candidate.values()):
            raise ValueError("Candidate properties must be finite and positive")
    except (ValueError, RuntimeError, OverflowError) as error:
        row.update(status="candidate_error", error=str(error))
        return row
    row.update(status="compared", candidate=candidate,
        relative_errors={key: abs(candidate[key] / source[key] - 1) for key in PROPERTIES})
    return row


def summarize(rows: list[dict]) -> dict:
    compared = [row for row in rows if row["status"] == "compared"]
    maxima = {}
    for property_name in PROPERTIES:
        worst = max(compared, key=lambda row: row["relative_errors"][property_name], default=None)
        maxima[property_name] = None if worst is None else {
            "relative_error": worst["relative_errors"][property_name],
            "temperature_k": worst["temperature_k"], "pressure_pa": worst["pressure_pa"],
        }
    return {"states": len(rows), "compared": len(compared),
        "excluded_phases": sum(row["status"] == "excluded_phase" for row in rows),
        "source_errors": sum(row["status"] == "source_error" for row in rows),
        "candidate_errors": sum(row["status"] == "candidate_error" for row in rows),
        "maximum_sampled_relative_errors": maxima}


def evaluate(fixture_path: Path) -> dict:
    import CoolProp
    from CoolProp.CoolProp import PropsSI, get_fluid_param_string, get_phase_index

    fixture_bytes = fixture_path.read_bytes()
    fixture = json.loads(fixture_bytes)
    source_json = get_fluid_param_string("HEOS::Air", "JSON")
    verify_source(fixture["source"], CoolProp, source_json, get_fluid_param_string("HEOS::Air", "CAS"))
    model = source_model(fixture)
    compared_phases = {name: get_phase_index(name) for name in
        ("phase_gas", "phase_supercritical_gas", "phase_supercritical")}
    gas_phases = set(compared_phases.values())

    def source_values(property_name, state):
        return PropsSI(property_name, "T", state.temperature_k, "P", state.pressure_pa, "HEOS::Air")

    reference = ThermodynamicState(temperature_k=288.15, pressure_pa=101325)
    groups = {}
    for speed in (30, 90, 166):
        mach = speed / model.speed_of_sound(reference)
        groups[f"campaign_{speed}_mps_isentrope"] = isentropic_reference_path(model, reference, mach)
    groups["mach3_isentrope"] = isentropic_reference_path(model, reference, 3)
    temperatures = sorted(set([100 + 1900 * index / 80 for index in range(81)] + [288.15, 1000]))
    groups["exploratory_pressure_grid"] = [ThermodynamicState(temperature_k=temperature, pressure_pa=pressure)
        for pressure in (1000, 10000, 101325, 500000, 1000000, 4000000)
        for temperature in temperatures]
    comparisons = {name: [compare_state(model, state, source_values, gas_phases) for state in states]
        for name, states in groups.items()}
    return {"schema_version": 1, "kind": "source-air-pressure-comparison", "installed": False,
        "physical_cfd_validated": False, "source": fixture["source"], "source_fluid_json": source_json,
        "fixture_sha256": hashlib.sha256(fixture_bytes).hexdigest(), "model": model.model_dump(mode="json"),
        "reference_state": reference.model_dump(), "compared_source_phases": compared_phases,
        "summaries": {name: summarize(rows) for name, rows in comparisons.items()}, "comparisons": comparisons,
        "limitations": ["Sampled property discrepancies, not rigorous continuous error bounds or aerodynamic accuracy",
            "Isentropic reference paths are not shock solutions or bounds on a viscous CFD pressure/temperature field",
            "Exploratory pressure grid is not an approved operating envelope; excluded phases and errors remain explicit",
            "Candidate uses a perfect-gas EOS and pressure-independent transport; source uses the full HEOS EOS",
            "No catalog installation, campaign mutation or physical convergence claim"]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture", type=Path, default=Path("tests/fixtures/air-thermophysics-audit.json"))
    parser.add_argument("--output-directory", type=Path)
    args = parser.parse_args()
    report = evaluate(args.fixture)
    encoded = json.dumps(report, sort_keys=True, indent=2, allow_nan=False).encode() + b"\n"
    directory = args.output_directory or Path(tempfile.mkdtemp(prefix="xfoilfoam-air-pressure-"))
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "report.json"
    target.write_bytes(encoded)
    print(json.dumps({"report_path": str(target), "sha256": hashlib.sha256(encoded).hexdigest(),
        "summaries": report["summaries"], "installed": False, "physical_cfd_validated": False}, allow_nan=False))


if __name__ == "__main__":
    main()
