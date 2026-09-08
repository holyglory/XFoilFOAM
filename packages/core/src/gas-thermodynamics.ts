import type { MediumStateInput } from "./viscosity";
import { evaluateGasState } from "./gas-state";
import { parseGasThermodynamicModel } from "./gas-model-validation";

interface GasThermodynamicBase {
  equation_of_state: "perfect_gas";
  gas_constant: number;
  transport_model: "constant" | "sutherland" | "polynomial";
  reference_dynamic_viscosity: number;
  reference_temperature_k: number;
  sutherland_temperature_k?: number;
  prandtl?: number;
  provenance: string;
}

export interface ConstantCpGasThermodynamics extends GasThermodynamicBase {
  transport_model: "constant" | "sutherland";
  heat_capacity_model: "constant_cp";
  heat_capacity_cp: number;
  nasa7?: null;
}

export interface Nasa7CaloricModel {
  minimum_temperature_k: number;
  common_temperature_k: number;
  maximum_temperature_k: number;
  entropy_reference_pressure_pa?: number;
  low_coefficients: [number, number, number, number, number, number, number];
  high_coefficients: [number, number, number, number, number, number, number];
  maximum_join_relative_error?: number;
  provenance: string;
}

export interface Nasa7GasThermodynamics extends GasThermodynamicBase {
  heat_capacity_model: "nasa7";
  heat_capacity_cp?: null;
  nasa7: Nasa7CaloricModel;
  transport_model: "sutherland";
  sutherland_temperature_k: number;
  prandtl?: never;
}

export interface PolynomialTransportModel {
  minimum_temperature_k: number;
  maximum_temperature_k: number;
  dynamic_viscosity_coefficients: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  thermal_conductivity_coefficients: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  provenance: string;
}

export interface PolynomialNasa7GasThermodynamics extends Omit<
  Nasa7GasThermodynamics,
  "transport_model" | "sutherland_temperature_k"
> {
  transport_model: "polynomial";
  polynomial_transport: PolynomialTransportModel;
  sutherland_temperature_k?: never;
}

export type GasThermodynamicModel =
  | ConstantCpGasThermodynamics
  | Nasa7GasThermodynamics
  | PolynomialNasa7GasThermodynamics;

export function caloricallyPerfectGasForMaterial(
  material: MediumStateInput,
): ConstantCpGasThermodynamics {
  if (material.gasThermodynamics != null)
    throw new Error(
      "An explicit material model must not be replaced with reference-state calorics",
    );
  if (
    material.phase !== "gas" ||
    ![
      material.density,
      material.refTemperatureK,
      material.refPressurePa,
      material.speedOfSound,
    ].every(
      (value) =>
        typeof value === "number" && Number.isFinite(value) && value > 0,
    )
  )
    throw new Error(
      "Compressible gas requires a finite reference density, pressure, temperature and sound speed",
    );
  const gasConstant =
    material.refPressurePa / (material.density * material.refTemperatureK);
  const gamma =
    material.speedOfSound! ** 2 / (gasConstant * material.refTemperatureK);
  if (!(gamma > 1) || !Number.isFinite(gamma))
    throw new Error("Reference gas state implies invalid heat capacity");
  const heatCapacity = (gamma * gasConstant) / (gamma - 1);
  const common = {
    equation_of_state: "perfect_gas" as const,
    heat_capacity_model: "constant_cp" as const,
    gas_constant: gasConstant,
    heat_capacity_cp: heatCapacity,
    provenance:
      "calorically-perfect-reference-state-v1: R=P0/(rho0*T0); gamma=a0^2/(R*T0); Cp=gamma*R/(gamma-1); Eucken conductivity from OpenCFD2606 commit 481094fdf34f11ed6d0d603ee59a858a0124236d. Model approximation, not measured heat-capacity or conductivity data.",
  };
  if (material.viscosity.model === "table")
    throw new Error(
      "Tabulated gas transport needs an explicit compressible transport fit",
    );
  if (material.viscosity.model === "constant") {
    if (!Number.isFinite(material.viscosity.mu) || material.viscosity.mu <= 0)
      throw new Error("Invalid constant gas viscosity");
    return {
      ...common,
      transport_model: "constant",
      reference_dynamic_viscosity: material.viscosity.mu,
      reference_temperature_k: material.refTemperatureK,
      prandtl:
        heatCapacity /
        (1.32 * (heatCapacity - gasConstant) + 1.77 * gasConstant),
    };
  }
  const { muRef, tRef, s } = material.viscosity;
  if (
    ![muRef, tRef].every((value) => Number.isFinite(value) && value > 0) ||
    !Number.isFinite(s) ||
    s < 0
  )
    throw new Error("Invalid Sutherland gas transport coefficients");
  return {
    ...common,
    transport_model: "sutherland",
    reference_dynamic_viscosity: muRef,
    reference_temperature_k: tRef,
    sutherland_temperature_k: s,
  };
}

export function gasThermodynamicsForMaterial(
  material: MediumStateInput,
): GasThermodynamicModel {
  if (material.gasThermodynamics == null)
    return caloricallyPerfectGasForMaterial(material);
  if (material.phase !== "gas")
    throw new Error("Only gas materials may supply a compressible gas model");
  evaluateGasState(
    material.gasThermodynamics,
    material.refTemperatureK,
    material.refPressurePa,
  );
  return parseGasThermodynamicModel(material.gasThermodynamics);
}
