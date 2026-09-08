import { describe, expect, it } from "vitest";
import { materialPhysicsValues } from "../src/material-physics";
import { evaluateGasState } from "../src/gas-state";
import { parseGasThermodynamicModel } from "../src/gas-model-validation";
import type { ConstantCpGasThermodynamics } from "../src/gas-thermodynamics";
import { sourceAirModel } from "./fixtures/source-air-model";

function material() {
  const gasThermodynamics = sourceAirModel();
  const reference = evaluateGasState(gasThermodynamics, 288.15, 101325);
  return {
    phase: "gas" as const,
    gasThermodynamics,
    density: reference.density,
    refTemperatureK: 288.15,
    refPressurePa: 101325,
    speedOfSound: reference.speedOfSound,
    viscosity: { model: "constant" as const, mu: reference.dynamicViscosity },
  };
}

describe("active material physics identity", () => {
  it("ignores provenance and inactive observations without mutating their stored source", () => {
    const original = material();
    const before = structuredClone(original);
    const changed = structuredClone(original);
    changed.gasThermodynamics.provenance = "Updated source attribution";
    changed.gasThermodynamics.nasa7.provenance = "Updated caloric attribution";
    changed.gasThermodynamics.polynomial_transport.provenance =
      "Updated transport attribution";
    changed.gasThermodynamics.nasa7.maximum_join_relative_error = 0.001;
    changed.gasThermodynamics.reference_temperature_k = 310;
    changed.gasThermodynamics.reference_dynamic_viscosity = evaluateGasState(
      original.gasThermodynamics,
      310,
      101325,
    ).dynamicViscosity;
    changed.density *= 1.01;
    changed.speedOfSound *= 1.01;
    changed.refTemperatureK = 300;
    changed.refPressurePa = 100000;
    changed.viscosity.mu *= 1.01;
    expect(() =>
      parseGasThermodynamicModel(changed.gasThermodynamics),
    ).not.toThrow();
    expect(materialPhysicsValues(changed)).toEqual(
      materialPhysicsValues(original),
    );
    expect(original).toEqual(before);
    const projected = materialPhysicsValues(original);
    expect(projected).not.toHaveProperty("density");
    expect(projected).not.toHaveProperty("viscosity");
    expect(projected).not.toHaveProperty("gasThermodynamics.provenance");
    expect(projected).not.toHaveProperty("gasThermodynamics.nasa7.provenance");
    expect(projected).not.toHaveProperty(
      "gasThermodynamics.polynomial_transport.provenance",
    );
    expect(projected).not.toHaveProperty(
      "gasThermodynamics.reference_temperature_k",
    );
  });

  it("retains real caloric and transport differences and owns its coefficient copies", () => {
    const original = material();
    const projected = materialPhysicsValues(original);
    const changed = structuredClone(original);
    changed.gasThermodynamics.gas_constant *= 1.0001;
    expect(materialPhysicsValues(changed)).not.toEqual(projected);
    const transportChanged = structuredClone(original);
    transportChanged.gasThermodynamics.polynomial_transport.thermal_conductivity_coefficients[0] *= 1.0001;
    expect(materialPhysicsValues(transportChanged)).not.toEqual(projected);
    const caloricsChanged = structuredClone(original);
    caloricsChanged.gasThermodynamics.nasa7.high_coefficients[0] *= 1.0001;
    expect(materialPhysicsValues(caloricsChanged)).not.toEqual(projected);
    original.gasThermodynamics.nasa7.low_coefficients[0] *= 1.0001;
    expect(materialPhysicsValues(original)).not.toEqual(projected);
  });

  it("normalizes the documented default entropy reference", () => {
    const original = material();
    delete original.gasThermodynamics.nasa7.entropy_reference_pressure_pa;
    const explicit = structuredClone(original);
    explicit.gasThermodynamics.nasa7.entropy_reference_pressure_pa = 100000;
    expect(materialPhysicsValues(explicit)).toEqual(
      materialPhysicsValues(original),
    );
  });

  it("retains the active Sutherland reference and constant transport properties", () => {
    const gas: ConstantCpGasThermodynamics = {
      equation_of_state: "perfect_gas",
      gas_constant: 287,
      heat_capacity_model: "constant_cp",
      heat_capacity_cp: 1005,
      transport_model: "sutherland",
      reference_dynamic_viscosity: 1.8e-5,
      reference_temperature_k: 288,
      sutherland_temperature_k: 110,
      provenance: "Isolated analytic identity fixture",
    };
    const original = { phase: "gas" as const, gasThermodynamics: gas };
    const changed = {
      ...original,
      gasThermodynamics: { ...gas, reference_temperature_k: 300 },
    };
    expect(materialPhysicsValues(changed)).not.toEqual(
      materialPhysicsValues(original),
    );
    const constant: ConstantCpGasThermodynamics = {
      ...gas,
      transport_model: "constant",
      sutherland_temperature_k: undefined,
      prandtl: 0.71,
    };
    const constantMaterial = {
      phase: "gas" as const,
      gasThermodynamics: constant,
    };
    expect(
      materialPhysicsValues({
        ...constantMaterial,
        gasThermodynamics: { ...constant, reference_temperature_k: 300 },
      }),
    ).toEqual(materialPhysicsValues(constantMaterial));
    expect(
      materialPhysicsValues({
        ...constantMaterial,
        gasThermodynamics: { ...constant, prandtl: 0.72 },
      }),
    ).not.toEqual(materialPhysicsValues(constantMaterial));
  });

  it("preserves legacy identities and refuses a gas model on liquid", () => {
    const original = material();
    const { gasThermodynamics, ...legacy } = original;
    expect(materialPhysicsValues(legacy)).toEqual(legacy);
    expect(
      materialPhysicsValues({ ...legacy, gasThermodynamics: null }),
    ).toEqual({ ...legacy, gasThermodynamics: null });
    expect(() =>
      materialPhysicsValues({ ...original, phase: "liquid" }),
    ).toThrow("gas medium");
    expect(gasThermodynamics.provenance).toBeTruthy();
  });
});
