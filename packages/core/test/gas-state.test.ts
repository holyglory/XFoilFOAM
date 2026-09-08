import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { evaluateGasState, gasHeatCapacity } from "../src/gas-state";
import {
  caloricallyPerfectGasForMaterial,
  gasThermodynamicsForMaterial,
  type GasThermodynamicModel,
} from "../src/gas-thermodynamics";
import {
  densityAtState,
  deriveOperatingConditionState,
  speedOfSoundAtState,
  type MediumStateInput,
} from "../src/viscosity";
import { sourceAirAudit, sourceAirModel } from "./fixtures/source-air-model";

function material(): MediumStateInput {
  return {
    phase: "gas",
    density: 1.225539021373505,
    refTemperatureK: 288.15,
    refPressurePa: 101325,
    speedOfSound: 340.40998328942305,
    viscosity: {
      model: "table",
      tempsK: [288.15],
      mu: [1.7961537371721837e-5],
    },
    gasThermodynamics: sourceAirModel(),
  };
}

describe("explicit gas material operating state", () => {
  it("matches the Python engine model at every retained source temperature", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const gas = sourceAirModel();
    const states = sourceAirAudit.source_samples.flatMap((sample) =>
      [10132.5, 101325, 1013250].map((pressure_pa) => ({
        temperature_k: sample.temperature_k,
        pressure_pa,
      })),
    );
    const result = spawnSync(
      `${root}/.venv/bin/python`,
      [
        "-c",
        `
import json, sys
from airfoilfoam.thermodynamics import GasThermodynamics, ThermodynamicState
payload = json.load(sys.stdin)
gas = GasThermodynamics.model_validate(payload["gas"])
rows = []
for raw in payload["states"]:
    state = ThermodynamicState.model_validate(raw)
    density = gas.density(state)
    viscosity = gas.dynamic_viscosity(state.temperature_k)
    rows.append(dict(density=density, dynamicViscosity=viscosity,
        kinematicViscosity=viscosity/density, heatCapacity=gas.heat_capacity_at(state.temperature_k),
        thermalConductivity=gas.thermal_conductivity(state.temperature_k), speedOfSound=gas.speed_of_sound(state)))
json.dump(rows, sys.stdout, allow_nan=False)
`,
      ],
      {
        cwd: root,
        input: JSON.stringify({ gas, states }),
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const expected = JSON.parse(result.stdout) as Record<string, number>[];
    expect(expected).toHaveLength(states.length);
    for (const [index, state] of states.entries()) {
      const evaluated = evaluateGasState(
        gas,
        state.temperature_k,
        state.pressure_pa,
      );
      for (const [property, value] of Object.entries(evaluated))
        expect(Math.abs(value / expected[index][property] - 1)).toBeLessThan(
          1e-12,
        );
    }
  });

  it("retains the source-fit approximation limits rather than claiming exact source properties", () => {
    for (const sample of sourceAirAudit.source_samples) {
      const state = evaluateGasState(
        sourceAirModel(),
        sample.temperature_k,
        101325,
      );
      expect(
        Math.abs(state.heatCapacity / sample.cp0_j_per_kg_k - 1),
      ).toBeLessThan(0.0021);
      expect(
        Math.abs(state.dynamicViscosity / sample.dynamic_viscosity_pa_s - 1),
      ).toBeLessThan(0.00073);
      expect(
        Math.abs(
          state.thermalConductivity / sample.thermal_conductivity_w_per_m_k - 1,
        ),
      ).toBeLessThan(0.00046);
    }
  });

  it("uses one explicit model for Mach, Reynolds, density and transport instead of the legacy table", () => {
    const medium = material();
    const gas = sourceAirModel();
    const input = {
      temperatureK: 900,
      pressurePa: 101325,
      speedMps: 400,
      referenceChordM: 0.23,
    };
    const expected = evaluateGasState(
      gas,
      input.temperatureK,
      input.pressurePa,
    );
    expect(deriveOperatingConditionState(medium, input)).toEqual({
      density: expected.density,
      dynamicViscosity: expected.dynamicViscosity,
      kinematicViscosity: expected.kinematicViscosity,
      mach: input.speedMps / expected.speedOfSound,
      reynolds:
        (input.speedMps * input.referenceChordM) / expected.kinematicViscosity,
    });
    expect(densityAtState(medium, input)).toBe(expected.density);
    expect(speedOfSoundAtState(medium, input.temperatureK)).toBe(
      expected.speedOfSound,
    );
    expect(gasThermodynamicsForMaterial(medium)).toEqual(gas);
    expect(() => caloricallyPerfectGasForMaterial(medium)).toThrow(
      "must not be replaced",
    );
    const copied = gasThermodynamicsForMaterial(medium);
    copied.gas_constant = 1;
    expect(medium.gasThermodynamics?.gas_constant).toBe(gas.gas_constant);
  });

  it.each([99, 2001, NaN, Infinity, 0])(
    "refuses extrapolation or invalid temperature %s",
    (temperature) => {
      expect(() =>
        evaluateGasState(sourceAirModel(), temperature, 101325),
      ).toThrow();
      expect(() => speedOfSoundAtState(material(), temperature)).toThrow();
    },
  );

  it.each([0, -1, NaN, Infinity])(
    "refuses invalid absolute pressure %s",
    (pressure) => {
      expect(() =>
        evaluateGasState(sourceAirModel(), 288.15, pressure),
      ).toThrow();
    },
  );

  it.each([
    "gas_constant",
    "reference_dynamic_viscosity",
    "reference_temperature_k",
  ])("refuses a nonfinite %s", (property) => {
    const invalid = { ...sourceAirModel(), [property]: NaN };
    expect(() => evaluateGasState(invalid, 288.15, 101325)).toThrow();
  });

  it("does not fall back when an explicitly supplied model is malformed or belongs to liquid", () => {
    const invalid = sourceAirModel();
    invalid.polynomial_transport.dynamic_viscosity_coefficients[0] = -1;
    expect(() =>
      gasThermodynamicsForMaterial({
        ...material(),
        gasThermodynamics: invalid,
      }),
    ).toThrow();
    expect(() =>
      gasThermodynamicsForMaterial({ ...material(), phase: "liquid" }),
    ).toThrow();
    expect(() =>
      densityAtState(
        { ...material(), phase: "liquid" },
        { temperatureK: 288.15, pressurePa: 101325 },
      ),
    ).toThrow();
    expect(() =>
      evaluateGasState(
        {
          ...sourceAirModel(),
          heat_capacity_model: "unknown",
        } as unknown as GasThermodynamicModel,
        288.15,
        101325,
      ),
    ).toThrow();
  });

  it("preserves constant and Sutherland legacy material behavior when no model is selected", () => {
    for (const viscosity of [
      { model: "constant" as const, mu: 2e-5 },
      { model: "sutherland" as const, muRef: 2e-5, tRef: 288.15, s: 110 },
    ]) {
      const medium = { ...material(), gasThermodynamics: null, viscosity };
      const gas = gasThermodynamicsForMaterial(medium);
      expect(gas).toEqual(caloricallyPerfectGasForMaterial(medium));
      expect(evaluateGasState(gas, 288.15, 101325).density).toBeCloseTo(
        medium.density,
        12,
      );
      expect(gasHeatCapacity(gas, 1000)).toBeGreaterThan(gas.gas_constant);
    }
  });
});
