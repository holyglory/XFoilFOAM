import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseGasThermodynamicModel } from "../src/gas-model-validation";
import { sourceAirModel } from "./fixtures/source-air-model";

function transportTrough(offset: number) {
  const model = sourceAirModel();
  model.polynomial_transport.dynamic_viscosity_coefficients = [
    640000e-10 + offset,
    -1600e-10,
    1e-10,
    0,
    0,
    0,
    0,
    0,
  ];
  model.reference_dynamic_viscosity =
    model.polynomial_transport.dynamic_viscosity_coefficients.reduceRight(
      (value, coefficient) =>
        value * model.reference_temperature_k + coefficient,
      0,
    );
  return model;
}

function fixtures() {
  const lowHeatCapacity = sourceAirModel();
  lowHeatCapacity.nasa7.low_coefficients = [20.75, -0.09, 0.0001, 0, 0, 0, 0];
  lowHeatCapacity.nasa7.high_coefficients = [
    ...lowHeatCapacity.nasa7.low_coefficients,
  ];
  const enthalpyJump = sourceAirModel();
  enthalpyJump.nasa7.high_coefficients[5] += 100;
  const entropyJump = sourceAirModel();
  entropyJump.nasa7.high_coefficients[6] += 0.1;
  const tooWideJoin = sourceAirModel();
  tooWideJoin.nasa7.maximum_join_relative_error = 1;
  const wrongReference = sourceAirModel();
  wrongReference.reference_dynamic_viscosity *= 2;
  const uncovered = sourceAirModel();
  uncovered.polynomial_transport.minimum_temperature_k = 200;
  const negativeConductivity = sourceAirModel();
  negativeConductivity.polynomial_transport.thermal_conductivity_coefficients =
    [-1, 0, 0, 0, 0, 0, 0, 0];
  const malformed = sourceAirModel();
  malformed.nasa7.low_coefficients.pop();
  const overflow = sourceAirModel();
  overflow.polynomial_transport.thermal_conductivity_coefficients[7] = 1e308;
  return [
    { name: "real source model", model: sourceAirModel(), valid: true },
    {
      name: "positive interior minimum",
      model: transportTrough(1e-12),
      valid: true,
    },
    {
      name: "narrow negative interior minimum",
      model: transportTrough(-1e-10),
      valid: false,
    },
    {
      name: "interior heat capacity below gas constant",
      model: lowHeatCapacity,
      valid: false,
    },
    { name: "discontinuous enthalpy", model: enthalpyJump, valid: false },
    { name: "discontinuous entropy", model: entropyJump, valid: false },
    { name: "weakened join tolerance", model: tooWideJoin, valid: false },
    {
      name: "reference transport mismatch",
      model: wrongReference,
      valid: false,
    },
    { name: "uncovered temperature domain", model: uncovered, valid: false },
    {
      name: "negative conductivity",
      model: negativeConductivity,
      valid: false,
    },
    { name: "incomplete caloric coefficients", model: malformed, valid: false },
    { name: "overflowing polynomial", model: overflow, valid: false },
    {
      name: "extra model property",
      model: { ...sourceAirModel(), guessed: true },
      valid: false,
    },
    {
      name: "unknown equation of state",
      model: { ...sourceAirModel(), equation_of_state: "guessed" },
      valid: false,
    },
    {
      name: "ambiguous transport override",
      model: { ...sourceAirModel(), prandtl: 0.72 },
      valid: false,
    },
  ];
}

describe("registered gas material validation", () => {
  it.each(fixtures())(
    "$name has matching engine and registry acceptance",
    ({ model, valid }) => {
      if (valid) expect(parseGasThermodynamicModel(model)).toEqual(model);
      else expect(() => parseGasThermodynamicModel(model)).toThrow();
    },
  );

  it("matches the Python validator across source, stationary-point, join and schema cases", () => {
    const cases = fixtures();
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const response = spawnSync(
      `${root}/.venv/bin/python`,
      [
        "-c",
        `
import json, sys
from pydantic import ValidationError
from airfoilfoam.thermodynamics import GasThermodynamics
output = []
for model in json.load(sys.stdin):
    try:
        GasThermodynamics.model_validate(model)
        output.append(True)
    except ValidationError:
        output.append(False)
json.dump(output, sys.stdout)
`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        input: JSON.stringify(cases.map((item) => item.model)),
        timeout: 30_000,
      },
    );
    expect(response.error).toBeUndefined();
    expect(response.status, response.stderr).toBe(0);
    expect(JSON.parse(response.stdout)).toEqual(
      cases.map((item) => item.valid),
    );
  });

  it("returns an independent exact copy instead of mutating source provenance or coefficients", () => {
    const original = sourceAirModel();
    const parsed = parseGasThermodynamicModel(original);
    if (parsed.heat_capacity_model !== "nasa7")
      throw new Error("Wrong material variant");
    parsed.nasa7.low_coefficients[0] += 1;
    expect(original.nasa7.low_coefficients[0]).not.toBe(
      parsed.nasa7.low_coefficients[0],
    );
  });
});
