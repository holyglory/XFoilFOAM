import type { MediumStateInput, ViscositySpec } from "@aerodb/core";
import { evaluateGasState, parseGasThermodynamicModel } from "@aerodb/core";
import { asc, eq } from "drizzle-orm";
import type { DB } from "./client";
import { type Medium, mediumViscosityTablePoints } from "./schema";

export async function resolveMaterialSnapshot(
  db: DB,
  medium: Medium,
): Promise<MediumStateInput> {
  if (medium.gasThermodynamics != null) {
    if (medium.phase !== "gas")
      throw new Error("Only gas materials may supply a gas model");
    evaluateGasState(
      parseGasThermodynamicModel(medium.gasThermodynamics),
      medium.refTemperatureK,
      medium.refPressurePa,
    );
  }
  let viscosity: ViscositySpec;
  if (medium.viscosityModel === "constant") {
    if (
      !(medium.constantDynamicViscosity && medium.constantDynamicViscosity > 0)
    )
      throw new Error(
        `medium ${medium.slug} is missing a constant dynamic viscosity`,
      );
    viscosity = { model: "constant", mu: medium.constantDynamicViscosity };
  } else if (medium.viscosityModel === "sutherland") {
    if (
      !(medium.sutherlandMuRef && medium.sutherlandTRef) ||
      medium.sutherlandS === null ||
      medium.sutherlandS < 0
    )
      throw new Error(
        `medium ${medium.slug} is missing Sutherland coefficients`,
      );
    viscosity = {
      model: "sutherland",
      muRef: medium.sutherlandMuRef,
      tRef: medium.sutherlandTRef,
      s: medium.sutherlandS,
    };
  } else if (medium.viscosityModel === "table") {
    const points = await db
      .select()
      .from(mediumViscosityTablePoints)
      .where(eq(mediumViscosityTablePoints.mediumId, medium.id))
      .orderBy(asc(mediumViscosityTablePoints.temperatureK));
    if (
      !points.length ||
      points.some(
        (point, index) =>
          !(point.temperatureK > 0) ||
          !(point.dynamicViscosity > 0) ||
          (index > 0 && point.temperatureK <= points[index - 1].temperatureK),
      )
    )
      throw new Error(`medium ${medium.slug} has an invalid viscosity table`);
    viscosity = {
      model: "table",
      tempsK: points.map((point) => point.temperatureK),
      mu: points.map((point) => point.dynamicViscosity),
    };
  } else
    throw new Error(`medium ${medium.slug} has an unsupported viscosity model`);
  return {
    phase: medium.phase,
    density: medium.density,
    refTemperatureK: medium.refTemperatureK,
    refPressurePa: medium.refPressurePa,
    speedOfSound: medium.speedOfSound,
    viscosity,
    ...(medium.gasThermodynamics != null
      ? { gasThermodynamics: structuredClone(medium.gasThermodynamics) }
      : {}),
  };
}
