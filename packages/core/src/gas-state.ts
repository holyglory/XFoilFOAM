import type { GasThermodynamicModel } from "./gas-thermodynamics";

export interface GasStateProperties {
  density: number;
  dynamicViscosity: number;
  kinematicViscosity: number;
  heatCapacity: number;
  thermalConductivity: number;
  speedOfSound: number;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be finite and positive`);
  return value;
}

function polynomial(
  coefficients: readonly number[],
  temperature: number,
  count: number,
): number {
  if (
    !Array.isArray(coefficients) ||
    coefficients.length !== count ||
    !coefficients.every(Number.isFinite)
  )
    throw new Error(
      "Material polynomial coefficients are incomplete or nonfinite",
    );
  return coefficients.reduceRight(
    (value, coefficient) => value * temperature + coefficient,
    0,
  );
}

function requireTemperature(
  temperature: number,
  minimum: number,
  maximum: number,
): void {
  positive(minimum, "Material minimum temperature");
  positive(maximum, "Material maximum temperature");
  if (minimum >= maximum || temperature < minimum || temperature > maximum)
    throw new Error("Temperature is outside the declared material range");
}

export function gasHeatCapacity(
  model: GasThermodynamicModel,
  temperatureK: number,
): number {
  positive(temperatureK, "Gas temperature");
  const gasConstant = positive(model.gas_constant, "Specific gas constant");
  if (model.equation_of_state !== "perfect_gas")
    throw new Error("Unsupported gas equation of state");
  let heatCapacity: number;
  if (model.heat_capacity_model === "constant_cp") {
    if (model.nasa7 != null)
      throw new Error(
        "Constant heat capacity cannot contain NASA7 coefficients",
      );
    heatCapacity = model.heat_capacity_cp;
  } else if (model.heat_capacity_model === "nasa7" && model.nasa7 != null) {
    const calorics = model.nasa7;
    requireTemperature(
      temperatureK,
      calorics.minimum_temperature_k,
      calorics.maximum_temperature_k,
    );
    if (
      !Number.isFinite(calorics.common_temperature_k) ||
      calorics.common_temperature_k <= calorics.minimum_temperature_k ||
      calorics.common_temperature_k >= calorics.maximum_temperature_k ||
      model.heat_capacity_cp != null ||
      !calorics.provenance?.trim()
    )
      throw new Error(
        "NASA7 material requires an explicit valid join and provenance",
      );
    polynomial(calorics.low_coefficients, 0, 7);
    polynomial(calorics.high_coefficients, 0, 7);
    const coefficients =
      temperatureK < calorics.common_temperature_k
        ? calorics.low_coefficients
        : calorics.high_coefficients;
    heatCapacity =
      gasConstant * polynomial(coefficients.slice(0, 5), temperatureK, 5);
  } else throw new Error("Unsupported gas heat-capacity model");
  if (!Number.isFinite(heatCapacity) || heatCapacity <= gasConstant)
    throw new Error(
      "Gas heat capacity must be finite and exceed its gas constant",
    );
  return heatCapacity;
}

export function evaluateGasState(
  model: GasThermodynamicModel,
  temperatureK: number,
  pressurePa: number,
): GasStateProperties {
  positive(pressurePa, "Gas pressure");
  positive(model.reference_temperature_k, "Transport reference temperature");
  positive(model.reference_dynamic_viscosity, "Transport reference viscosity");
  if (typeof model.provenance !== "string" || !model.provenance.trim())
    throw new Error("Gas material requires explicit provenance");
  const heatCapacity = gasHeatCapacity(model, temperatureK);
  gasHeatCapacity(model, model.reference_temperature_k);
  let dynamicViscosity: number;
  let thermalConductivity: number;
  const suppliedPolynomial = (
    model as GasThermodynamicModel & { polynomial_transport?: unknown }
  ).polynomial_transport;
  if (model.transport_model !== "polynomial" && suppliedPolynomial != null)
    throw new Error(
      "Non-polynomial transport must not contain polynomial coefficients",
    );
  if (model.transport_model === "polynomial") {
    const transport = model.polynomial_transport;
    if (
      !transport ||
      model.heat_capacity_model !== "nasa7" ||
      model.sutherland_temperature_k != null ||
      model.prandtl != null ||
      !transport.provenance?.trim()
    )
      throw new Error(
        "Polynomial transport requires explicit NASA7 calorics without transport overrides",
      );
    requireTemperature(
      temperatureK,
      transport.minimum_temperature_k,
      transport.maximum_temperature_k,
    );
    requireTemperature(
      model.reference_temperature_k,
      transport.minimum_temperature_k,
      transport.maximum_temperature_k,
    );
    if (
      transport.minimum_temperature_k > model.nasa7.minimum_temperature_k ||
      transport.maximum_temperature_k < model.nasa7.maximum_temperature_k
    )
      throw new Error(
        "Polynomial transport must cover the declared caloric range",
      );
    const referenceViscosity = positive(
      polynomial(
        transport.dynamic_viscosity_coefficients,
        model.reference_temperature_k,
        8,
      ),
      "Polynomial reference viscosity",
    );
    if (
      Math.abs(referenceViscosity - model.reference_dynamic_viscosity) >
      1e-10 * Math.max(referenceViscosity, model.reference_dynamic_viscosity)
    )
      throw new Error(
        "Reference viscosity differs from the explicit polynomial model",
      );
    dynamicViscosity = polynomial(
      transport.dynamic_viscosity_coefficients,
      temperatureK,
      8,
    );
    thermalConductivity = polynomial(
      transport.thermal_conductivity_coefficients,
      temperatureK,
      8,
    );
  } else if (model.transport_model === "constant") {
    if (
      model.heat_capacity_model !== "constant_cp" ||
      model.sutherland_temperature_k != null
    )
      throw new Error(
        "Constant transport requires constant heat capacity and no Sutherland override",
      );
    dynamicViscosity = model.reference_dynamic_viscosity;
    thermalConductivity =
      (dynamicViscosity * heatCapacity) /
      positive(model.prandtl!, "Laminar Prandtl number");
  } else if (model.transport_model === "sutherland") {
    const sutherland = model.sutherland_temperature_k;
    if (
      sutherland == null ||
      !Number.isFinite(sutherland) ||
      sutherland < 0 ||
      model.prandtl != null
    )
      throw new Error(
        "Sutherland transport requires its coefficient and no Prandtl override",
      );
    dynamicViscosity =
      (model.reference_dynamic_viscosity *
        (temperatureK / model.reference_temperature_k) ** 1.5 *
        (model.reference_temperature_k + sutherland)) /
      (temperatureK + sutherland);
    thermalConductivity =
      dynamicViscosity *
      (1.32 * (heatCapacity - model.gas_constant) + 1.77 * model.gas_constant);
  } else throw new Error("Unsupported gas transport model");
  const density = positive(
    pressurePa / (model.gas_constant * temperatureK),
    "Gas density",
  );
  return {
    heatCapacity,
    density,
    dynamicViscosity: positive(dynamicViscosity, "Gas viscosity"),
    thermalConductivity: positive(thermalConductivity, "Gas conductivity"),
    kinematicViscosity: positive(
      dynamicViscosity / density,
      "Gas kinematic viscosity",
    ),
    speedOfSound: positive(
      Math.sqrt(
        (heatCapacity / (heatCapacity - model.gas_constant)) *
          model.gas_constant *
          temperatureK,
      ),
      "Gas sound speed",
    ),
  };
}
