import { readFileSync } from "node:fs";
import type {
  Nasa7CaloricModel,
  PolynomialNasa7GasThermodynamics,
  PolynomialTransportModel,
} from "../../src/gas-thermodynamics";

export const sourceAirAudit = JSON.parse(
  readFileSync(
    new URL(
      "../../../../tests/fixtures/air-thermophysics-audit.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  source_audit_sha256: string;
  gas_constant: number;
  calorics: Nasa7CaloricModel;
  transport: PolynomialTransportModel;
  source_samples: {
    temperature_k: number;
    cp0_j_per_kg_k: number;
    dynamic_viscosity_pa_s: number;
    thermal_conductivity_w_per_m_k: number;
  }[];
};

export function sourceAirModel(): PolynomialNasa7GasThermodynamics {
  return {
    equation_of_state: "perfect_gas",
    heat_capacity_model: "nasa7",
    gas_constant: sourceAirAudit.gas_constant,
    nasa7: structuredClone(sourceAirAudit.calorics),
    transport_model: "polynomial",
    polynomial_transport: structuredClone(sourceAirAudit.transport),
    reference_temperature_k: 288.15,
    reference_dynamic_viscosity:
      sourceAirAudit.transport.dynamic_viscosity_coefficients.reduceRight(
        (value, coefficient) => value * 288.15 + coefficient,
        0,
      ),
    provenance: `Isolated source audit ${sourceAirAudit.source_audit_sha256}; not installed catalog material`,
  };
}
