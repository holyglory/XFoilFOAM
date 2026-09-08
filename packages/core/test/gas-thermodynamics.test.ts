import { describe, expect, it } from "vitest";
import { caloricallyPerfectGasForMaterial } from "../src/gas-thermodynamics";
import type { MediumStateInput } from "../src/viscosity";

const material: MediumStateInput = {
  phase: "gas",
  density: 1.225,
  refTemperatureK: 288.15,
  refPressurePa: 101325,
  speedOfSound: 340.3,
  viscosity: { model: "sutherland", muRef: 1.7894e-5, tRef: 288.15, s: 110.4 },
};

describe("reference-state gas closure", () => {
  it("preserves supplied density and sound speed without substituting air constants", () => {
    const gas = caloricallyPerfectGasForMaterial(material);
    const gamma =
      gas.heat_capacity_cp / (gas.heat_capacity_cp - gas.gas_constant);
    expect(
      material.refPressurePa / (gas.gas_constant * material.refTemperatureK),
    ).toBeCloseTo(material.density, 12);
    expect(
      Math.sqrt(gamma * gas.gas_constant * material.refTemperatureK),
    ).toBeCloseTo(material.speedOfSound!, 12);
    expect(gas).toMatchObject({
      transport_model: "sutherland",
      reference_dynamic_viscosity: 1.7894e-5,
      reference_temperature_k: 288.15,
      sutherland_temperature_k: 110.4,
    });
    expect(gas).not.toHaveProperty("prandtl");
    expect(gas.provenance).toContain("Model approximation");
  });
  it("uses the same explicit Eucken conductivity closure for constant transport", () => {
    const gas = caloricallyPerfectGasForMaterial({
      ...material,
      viscosity: { model: "constant", mu: 2e-5 },
    });
    const conductivity =
      2e-5 *
      (1.32 * (gas.heat_capacity_cp - gas.gas_constant) +
        1.77 * gas.gas_constant);
    expect((2e-5 * gas.heat_capacity_cp) / gas.prandtl!).toBeCloseTo(
      conductivity,
      12,
    );
    expect(gas).not.toHaveProperty("sutherland_temperature_k");
  });
  it("refuses missing physics and unsupported transport instead of guessing", () => {
    for (const patch of [
      { phase: "liquid" },
      { speedOfSound: null },
      { density: NaN },
      { speedOfSound: 1 },
      { viscosity: { model: "constant", mu: -1 } },
      { viscosity: { model: "sutherland", muRef: 1e-5, tRef: 300, s: -1 } },
      { viscosity: { model: "table", tempsK: [250, 300], mu: [1e-5, 2e-5] } },
    ])
      expect(() =>
        caloricallyPerfectGasForMaterial({
          ...material,
          ...patch,
        } as MediumStateInput),
      ).toThrow();
  });
});
