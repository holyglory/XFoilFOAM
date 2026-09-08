from __future__ import annotations

import hashlib
import json
import argparse
import math
from pathlib import Path
import tempfile

import numpy as np

from airfoilfoam.material_fitting import fit_nasa7_calorics, fit_sutherland_transport, fit_polynomial_transport
from airfoilfoam.thermodynamics import GasThermodynamics, ThermodynamicState


def evaluate_air_fit(minimum_temperature_k: float = 150) -> dict:
    import CoolProp
    from CoolProp.CoolProp import PropsSI, get_fluid_param_string, get_phase_index

    if CoolProp.__version__ != "8.0.0":
        raise ValueError("Air material audit requires the explicitly pinned CoolProp 8.0.0 source")
    fluid = "HEOS::Air"
    pressure = 101325.0
    reference_temperature = 288.15
    gas_constant = float(PropsSI("gas_constant", fluid) / PropsSI("molar_mass", fluid))
    source_json = get_fluid_param_string(fluid, "JSON")
    source = {
        "name": "CoolProp", "version": CoolProp.__version__, "git_revision": CoolProp.__gitrevision__,
        "fluid": fluid, "cas": get_fluid_param_string(fluid, "CAS"),
        "fluid_json_sha256": hashlib.sha256(source_json.encode()).hexdigest(),
        "caloric_properties": ["CP0MASS", "HMASS_IDEALGAS", "SMASS_IDEALGAS"],
        "transport_properties": ["VISCOSITY", "CONDUCTIVITY"],
        "caloric_density_basis": "pressure/(gas_constant*temperature): exact ideal-gas reference density",
        "transport_pressure_pa": pressure,
        "documentation": "https://coolprop.org/coolprop/HighLevelAPI.html",
        "fluid_source": "https://github.com/CoolProp/CoolProp/blob/v8.0.0/dev/fluids/Air.json",
    }
    if source["cas"] != "AIR.PPF":
        raise ValueError("Air audit resolved a different source material")
    if not math.isfinite(minimum_temperature_k) or not 0 < minimum_temperature_k < reference_temperature:
        raise ValueError("Air source fitting requires a finite positive lower temperature below its reference state")
    temperatures = np.unique(np.r_[np.linspace(minimum_temperature_k, 2000, 371), reference_temperature, 1000])
    if temperatures[-1] > PropsSI("TMAX", fluid) or temperatures[0] < PropsSI("TMIN", fluid):
        raise ValueError("Requested material audit exceeds its source temperature domain")

    def source_values(property_name, temperature, caloric=False):
        values = np.asarray(PropsSI(property_name, "T", temperature,
            "Dmass" if caloric else "P", pressure / (gas_constant * np.asarray(temperature)) if caloric else pressure,
            fluid), dtype=float)
        if not np.all(np.isfinite(values)):
            raise ValueError(f"Source property {property_name} is not finite")
        return values

    cp_ratio = source_values("CP0MASS", temperatures, True) / gas_constant
    viscosity = source_values("VISCOSITY", temperatures)
    allowed_phases = [get_phase_index("phase_gas"), get_phase_index("phase_supercritical_gas")]
    if not np.all(np.isin(source_values("Phase", temperatures), allowed_phases)):
        raise ValueError("The air source transport grid includes non-gas states")
    polynomial_transport = fit_polynomial_transport(temperatures, viscosity, source_values("CONDUCTIVITY", temperatures),
        provenance=f"Independent viscosity and conductivity fits to CoolProp 8.0.0 HEOS::Air at {pressure} Pa; source JSON SHA256 {source['fluid_json_sha256']}; candidate, not installed")
    calorics = fit_nasa7_calorics(
        temperatures, cp_ratio, common_temperature_k=1000,
        reference_pressure_pa=pressure,
        reference_temperature_k=reference_temperature,
        reference_enthalpy_ratio=float(source_values("HMASS_IDEALGAS", reference_temperature, True)) / gas_constant,
        reference_entropy_ratio=float(source_values("SMASS_IDEALGAS", reference_temperature, True)) / gas_constant,
        provenance=f"Relative least-squares fit to CoolProp 8.0.0 HEOS::Air ideal-gas calorics; source JSON SHA256 {source['fluid_json_sha256']}; continuous Cp/H/S join; candidate, not validated CFD",
    )
    transport = fit_sutherland_transport(temperatures, viscosity)
    model = GasThermodynamics(
        gas_constant=gas_constant, heat_capacity_model="nasa7", nasa7=calorics,
        transport_model="sutherland", reference_dynamic_viscosity=transport["reference_dynamic_viscosity"],
        reference_temperature_k=transport["reference_temperature_k"],
        sutherland_temperature_k=transport["sutherland_temperature_k"],
        provenance="Candidate temperature-dependent air model: explicit source caloric fit, reference-pressure Sutherland viscosity fit, OpenCFD Eucken conductivity approximation. Not installed as catalog data.",
    )
    verification_temperature = np.unique(np.r_[np.linspace(minimum_temperature_k, 2000, 3702), reference_temperature, 1000])
    if not np.all(np.isin(source_values("Phase", verification_temperature), allowed_phases)):
        raise ValueError("The air source verification grid includes non-gas states")
    reference_cp = source_values("CP0MASS", verification_temperature, True)
    reference_enthalpy = source_values("HMASS_IDEALGAS", verification_temperature, True)
    reference_entropy = source_values("SMASS_IDEALGAS", verification_temperature, True)
    reference_viscosity = source_values("VISCOSITY", verification_temperature)
    reference_conductivity = source_values("CONDUCTIVITY", verification_temperature)
    fitted_cp = np.asarray([model.heat_capacity_at(value) for value in verification_temperature])
    fitted_enthalpy = np.asarray([gas_constant * calorics.enthalpy_ratio(value) for value in verification_temperature])
    fitted_entropy = np.asarray([gas_constant * calorics.entropy_ratio(value) for value in verification_temperature])
    fitted_viscosity = np.asarray([model.dynamic_viscosity(value) for value in verification_temperature])
    fitted_conductivity = fitted_viscosity * (1.32 * (fitted_cp - gas_constant) + 1.77 * gas_constant)

    def discrepancy(fitted, expected, normalizer):
        relative = np.abs(fitted - expected) / normalizer
        worst = int(np.argmax(relative))
        return {"maximum_relative_error": float(relative[worst]), "rms_relative_error": float(np.sqrt(np.mean(relative ** 2))),
                "worst_temperature_k": float(verification_temperature[worst]),
                "source_at_worst": float(expected[worst]), "candidate_at_worst": float(fitted[worst])}

    metrics = {
        "heat_capacity": discrepancy(fitted_cp, reference_cp, reference_cp),
        "enthalpy_cp_temperature_normalized": discrepancy(fitted_enthalpy, reference_enthalpy, reference_cp * verification_temperature),
        "entropy_cp_normalized": discrepancy(fitted_entropy, reference_entropy, reference_cp),
        "dynamic_viscosity": discrepancy(fitted_viscosity, reference_viscosity, reference_viscosity),
        "thermal_conductivity": discrepancy(fitted_conductivity, reference_conductivity, reference_conductivity),
    }
    polynomial_metrics = {
        "dynamic_viscosity": discrepancy(np.asarray([polynomial_transport.dynamic_viscosity(value) for value in verification_temperature]), reference_viscosity, reference_viscosity),
        "thermal_conductivity": discrepancy(np.asarray([polynomial_transport.thermal_conductivity(value) for value in verification_temperature]), reference_conductivity, reference_conductivity),
    }
    reference_state = ThermodynamicState(temperature_k=reference_temperature, pressure_pa=pressure)
    sound_speed = model.speed_of_sound(reference_state)
    model.validate_adiabatic_temperature_range(reference_temperature, 3 * sound_speed)
    records = [{"temperature_k": float(temperature), "cp0_j_per_kg_k": float(cp),
        "enthalpy0_j_per_kg": float(enthalpy), "entropy0_j_per_kg_k": float(entropy),
        "dynamic_viscosity_pa_s": float(mu), "thermal_conductivity_w_per_m_k": float(conductivity)}
        for temperature, cp, enthalpy, entropy, mu, conductivity in zip(verification_temperature,
            reference_cp, reference_enthalpy, reference_entropy, reference_viscosity, reference_conductivity)]
    samples_json = json.dumps(records, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return {"schema_version": 1, "kind": "air-material-fit-audit", "installed": False,
        "source": source, "source_fluid_json": json.loads(source_json),
        "training_samples": len(temperatures), "verification_samples": len(records),
        "source_samples_sha256": hashlib.sha256(samples_json.encode()).hexdigest(), "source_samples": records,
        "candidate": model.model_dump(mode="json"), "fit_metrics": metrics,
        "alternative_polynomial_transport": {"candidate": polynomial_transport.model_dump(mode="json"), "fit_metrics": polynomial_metrics,
            "installed": False, "runtime_combination_verified": False},
        "reference_state": {"temperature_k": reference_temperature, "pressure_pa": pressure,
            "candidate_density": model.density(reference_state), "source_density": float(source_values("Dmass", reference_temperature)),
            "candidate_sound_speed": sound_speed, "source_sound_speed": float(source_values("A", reference_temperature))},
        "limitations": ["Reference-pressure transport fit, not a validated pressure range",
            "Thermally perfect gas approximation, not the full real-gas source EOS",
            "Source grid error is not a rigorous continuous bound or CFD validation",
            "No automatic catalog installation or change to campaign targets"]}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--minimum-temperature", type=float, default=150)
    parser.add_argument("--output-directory", type=Path)
    args = parser.parse_args()
    report = evaluate_air_fit(args.minimum_temperature)
    encoded = json.dumps(report, indent=2, sort_keys=True, allow_nan=False).encode() + b"\n"
    directory = args.output_directory or Path(tempfile.mkdtemp(prefix="xfoilfoam-air-fit-"))
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / "report.json"
    target.write_bytes(encoded)
    print(json.dumps({"report_path": str(target), "sha256": hashlib.sha256(encoded).hexdigest(),
        "source": report["source"], "fit_metrics": report["fit_metrics"],
        "polynomial_transport_metrics": report["alternative_polynomial_transport"]["fit_metrics"],
        "verification_samples": report["verification_samples"], "installed": False}, allow_nan=False))


if __name__ == "__main__":
    main()
