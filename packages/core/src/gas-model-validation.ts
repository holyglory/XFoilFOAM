import type { GasThermodynamicModel } from "./gas-thermodynamics";
import { evaluateGasState } from "./gas-state";

function object(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Material model must be an explicit object");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key)))
    throw new Error("Material model contains unsupported fields");
  if (typeof record.provenance !== "string" || !record.provenance.trim())
    throw new Error("Material model requires explicit provenance");
  return record;
}

function coefficients(value: unknown, count: number): number[] {
  if (
    !Array.isArray(value) ||
    value.length !== count ||
    !value.every(Number.isFinite)
  )
    throw new Error(
      "Material coefficients must have the exact finite polynomial shape",
    );
  return value;
}

function evaluate(values: readonly number[], coordinate: number): number {
  const value = values.reduceRight(
    (result, coefficient) => result * coordinate + coefficient,
    0,
  );
  if (!Number.isFinite(value))
    throw new Error("Material polynomial cannot resolve a finite value");
  return value;
}

function derivative(values: readonly number[]): number[] {
  return values.slice(1).map((value, index) => value * (index + 1));
}

function rootsInUnitInterval(values: readonly number[]): number[] {
  const nonzero = [...values];
  while (nonzero.length > 1 && nonzero.at(-1) === 0) nonzero.pop();
  if (nonzero.length < 2) return [];
  if (nonzero.length === 2) {
    const root = -nonzero[0] / nonzero[1];
    return root > 0 && root < 1 ? [root] : [];
  }
  const partitions = [0, ...rootsInUnitInterval(derivative(nonzero)), 1];
  const tolerance =
    nonzero.reduce((sum, value) => sum + Math.abs(value), 0) *
    Number.EPSILON *
    128;
  const roots = partitions.filter(
    (coordinate) =>
      coordinate > 0 &&
      coordinate < 1 &&
      Math.abs(evaluate(nonzero, coordinate)) <= tolerance,
  );
  for (let index = 1; index < partitions.length; index++) {
    let lower = partitions[index - 1];
    let upper = partitions[index];
    let lowerValue = evaluate(nonzero, lower);
    const upperValue = evaluate(nonzero, upper);
    if (
      lowerValue === 0 ||
      upperValue === 0 ||
      Math.sign(lowerValue) === Math.sign(upperValue)
    )
      continue;
    for (let iteration = 0; iteration < 80; iteration++) {
      const middle = (lower + upper) / 2;
      if (middle === lower || middle === upper) break;
      const value = evaluate(nonzero, middle);
      if (value === 0) {
        lower = upper = middle;
        break;
      }
      if (Math.sign(value) === Math.sign(lowerValue)) {
        lower = middle;
        lowerValue = value;
      } else upper = middle;
    }
    roots.push((lower + upper) / 2);
  }
  return roots.sort((left, right) => left - right);
}

function requirePolynomialMinimum(
  values: readonly number[],
  lower: number,
  upper: number,
  minimum: number,
): void {
  if (![lower, upper].every(Number.isFinite) || !(0 < lower && lower < upper))
    throw new Error(
      "Material polynomial requires ordered positive temperature bounds",
    );
  let scaled = [0];
  for (const coefficient of [...values].reverse()) {
    const next = Array<number>(scaled.length + 1).fill(0);
    for (const [index, value] of scaled.entries()) {
      next[index] += value * lower;
      next[index + 1] += value * (upper - lower);
    }
    next[0] += coefficient;
    if (!next.every(Number.isFinite))
      throw new Error("Material polynomial overflows its declared domain");
    scaled = next;
  }
  const locations = [0, 1, ...rootsInUnitInterval(derivative(scaled))];
  if (locations.some((location) => evaluate(scaled, location) <= minimum))
    throw new Error(
      "Material polynomial violates its physical minimum inside the declared domain",
    );
}

export function parseGasThermodynamicModel(
  value: unknown,
): GasThermodynamicModel {
  const raw = object(value, [
    "equation_of_state",
    "heat_capacity_model",
    "gas_constant",
    "heat_capacity_cp",
    "nasa7",
    "transport_model",
    "polynomial_transport",
    "reference_dynamic_viscosity",
    "reference_temperature_k",
    "sutherland_temperature_k",
    "prandtl",
    "provenance",
  ]);
  const model = raw as unknown as GasThermodynamicModel;
  if (model.heat_capacity_model === "nasa7") {
    const calorics = object(model.nasa7, [
      "minimum_temperature_k",
      "common_temperature_k",
      "maximum_temperature_k",
      "entropy_reference_pressure_pa",
      "low_coefficients",
      "high_coefficients",
      "maximum_join_relative_error",
      "provenance",
    ]);
    const low = coefficients(calorics.low_coefficients, 7);
    const high = coefficients(calorics.high_coefficients, 7);
    const join = Number(calorics.common_temperature_k);
    requirePolynomialMinimum(
      low.slice(0, 5),
      Number(calorics.minimum_temperature_k),
      join,
      1,
    );
    requirePolynomialMinimum(
      high.slice(0, 5),
      join,
      Number(calorics.maximum_temperature_k),
      1,
    );
    const referencePressure = calorics.entropy_reference_pressure_pa ?? 100000;
    const tolerance = calorics.maximum_join_relative_error ?? 1e-4;
    if (
      typeof referencePressure !== "number" ||
      !Number.isFinite(referencePressure) ||
      referencePressure <= 0 ||
      typeof tolerance !== "number" ||
      !Number.isFinite(tolerance) ||
      tolerance <= 0 ||
      tolerance > 0.01
    )
      throw new Error(
        "NASA7 reference pressure and join tolerance are invalid",
      );
    const heatCapacity = (row: number[]) => evaluate(row.slice(0, 5), join);
    const enthalpy = (row: number[]) =>
      evaluate(
        [
          row[5],
          ...row
            .slice(0, 5)
            .map((coefficient, index) => coefficient / (index + 1)),
        ],
        join,
      );
    const entropy = (row: number[]) =>
      row[0] * Math.log(join) +
      row
        .slice(1, 5)
        .reduce(
          (sum, coefficient, index) =>
            sum + (coefficient * join ** (index + 1)) / (index + 1),
          0,
        ) +
      row[6];
    const scale = Math.max(heatCapacity(low), heatCapacity(high));
    for (const [evaluateProperty, normalizer] of [
      [heatCapacity, scale],
      [enthalpy, scale * join],
      [entropy, scale],
    ] as const) {
      const lowValue = evaluateProperty(low);
      const highValue = evaluateProperty(high);
      if (
        ![lowValue, highValue, normalizer].every(Number.isFinite) ||
        Math.abs(lowValue - highValue) / normalizer > tolerance
      )
        throw new Error(
          "NASA7 heat capacity, enthalpy and entropy must join continuously within tolerance",
        );
    }
  }
  if (model.transport_model === "polynomial") {
    const transport = object(model.polynomial_transport, [
      "minimum_temperature_k",
      "maximum_temperature_k",
      "dynamic_viscosity_coefficients",
      "thermal_conductivity_coefficients",
      "provenance",
    ]);
    for (const field of [
      "dynamic_viscosity_coefficients",
      "thermal_conductivity_coefficients",
    ])
      requirePolynomialMinimum(
        coefficients(transport[field], 8),
        Number(transport.minimum_temperature_k),
        Number(transport.maximum_temperature_k),
        0,
      );
  }
  evaluateGasState(model, model.reference_temperature_k, 100000);
  return structuredClone(model);
}
