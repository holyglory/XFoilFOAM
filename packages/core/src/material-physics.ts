import type { GasThermodynamicModel } from "./gas-thermodynamics";

function gasPhysicsValues(
  model: GasThermodynamicModel,
): Record<string, unknown> {
  const calorics =
    model.heat_capacity_model === "constant_cp"
      ? { heat_capacity_cp: model.heat_capacity_cp }
      : {
          nasa7: {
            minimum_temperature_k: model.nasa7.minimum_temperature_k,
            common_temperature_k: model.nasa7.common_temperature_k,
            maximum_temperature_k: model.nasa7.maximum_temperature_k,
            entropy_reference_pressure_pa:
              model.nasa7.entropy_reference_pressure_pa ?? 100000,
            low_coefficients: [...model.nasa7.low_coefficients],
            high_coefficients: [...model.nasa7.high_coefficients],
          },
        };
  const base = {
    equation_of_state: model.equation_of_state,
    gas_constant: model.gas_constant,
    heat_capacity_model: model.heat_capacity_model,
    transport_model: model.transport_model,
    ...calorics,
  };
  if (model.transport_model === "polynomial") {
    const transport = model.polynomial_transport;
    return {
      ...base,
      polynomial_transport: {
        minimum_temperature_k: transport.minimum_temperature_k,
        maximum_temperature_k: transport.maximum_temperature_k,
        dynamic_viscosity_coefficients: [
          ...transport.dynamic_viscosity_coefficients,
        ],
        thermal_conductivity_coefficients: [
          ...transport.thermal_conductivity_coefficients,
        ],
      },
    };
  }
  if (model.transport_model === "sutherland")
    return {
      ...base,
      reference_dynamic_viscosity: model.reference_dynamic_viscosity,
      reference_temperature_k: model.reference_temperature_k,
      sutherland_temperature_k: model.sutherland_temperature_k,
    };
  return {
    ...base,
    reference_dynamic_viscosity: model.reference_dynamic_viscosity,
    prandtl: model.prandtl,
  };
}

export function materialPhysicsValues<
  Material extends {
    phase: "gas" | "liquid";
    gasThermodynamics?: GasThermodynamicModel | null;
  },
>(material: Material) {
  if (!material.gasThermodynamics) return material;
  if (material.phase !== "gas")
    throw new Error("An explicit gas model requires a gas medium");
  return {
    phase: material.phase,
    gasThermodynamics: gasPhysicsValues(material.gasThermodynamics),
  };
}
