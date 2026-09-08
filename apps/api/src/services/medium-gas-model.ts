import {
  evaluateGasState,
  parseGasThermodynamicModel,
  type GasThermodynamicModel,
} from "@aerodb/core";
import { boundaryConditions, flowConditions, type Medium } from "@aerodb/db";
import { eq } from "drizzle-orm";
import { db } from "../db";

interface MaterialWrite {
  gasThermodynamics?: unknown;
  phase?: string;
  refTemperatureK?: number;
  refPressurePa?: number;
}

export async function mediumGasModelForWrite(
  input: MaterialWrite,
  existing?: Medium,
): Promise<GasThermodynamicModel | null> {
  const selected =
    input.gasThermodynamics === undefined
      ? existing?.gasThermodynamics
      : input.gasThermodynamics;
  if (selected === null || selected === undefined) return null;
  let model: GasThermodynamicModel;
  try {
    if ((input.phase ?? existing?.phase) !== "gas") {
      throw new Error(
        "An explicit gas material model requires the gas phase; clear the model before changing phase",
      );
    }
    model = parseGasThermodynamicModel(selected);
    const referenceTemperature =
      input.refTemperatureK ?? existing?.refTemperatureK;
    const referencePressure = input.refPressurePa ?? existing?.refPressurePa;
    if (referenceTemperature === undefined || referencePressure === undefined) {
      throw new Error(
        "An explicit gas material model requires a reference temperature and pressure",
      );
    }
    evaluateGasState(model, referenceTemperature, referencePressure);
  } catch (error) {
    throw Object.assign(
      new Error(
        error instanceof Error ? error.message : "Invalid gas material model",
      ),
      { statusCode: 400 },
    );
  }
  if (existing) {
    const [flows, boundaries] = await Promise.all([
      db
        .select({
          temperatureK: flowConditions.temperatureK,
          pressurePa: flowConditions.pressurePa,
        })
        .from(flowConditions)
        .where(eq(flowConditions.mediumId, existing.id)),
      db
        .select({
          temperatureK: boundaryConditions.temperatureK,
          pressurePa: boundaryConditions.pressurePa,
        })
        .from(boundaryConditions)
        .where(eq(boundaryConditions.mediumId, existing.id)),
    ]);
    for (const state of [...flows, ...boundaries]) {
      try {
        evaluateGasState(model, state.temperatureK, state.pressurePa);
      } catch {
        throw Object.assign(
          new Error(
            "The gas material model does not cover an existing flow condition; save it as a new medium instead",
          ),
          { statusCode: 400 },
        );
      }
    }
  }
  return model;
}
