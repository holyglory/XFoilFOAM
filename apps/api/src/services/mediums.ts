import {
  deriveFlowConditionState,
  deriveOperatingConditionState,
  evalDynamicViscosity,
  type FlowConditionState,
  type MediumDTO,
  type OperatingConditionState,
  type ViscosityModelName,
  type ViscositySpec,
  type ViscosityTablePointDTO,
} from "@aerodb/core";
import type { BoundaryCondition, FlowCondition, Medium, MediumViscosityTablePoint } from "@aerodb/db";

export interface ViscosityTableInputPoint {
  temperatureK: number;
  dynamicViscosity: number;
  sortOrder?: number;
}

export interface MediumViscosityInput {
  viscosityModel: ViscosityModelName;
  constantDynamicViscosity?: number | null;
  sutherlandMuRef?: number | null;
  sutherlandTRef?: number | null;
  sutherlandS?: number | null;
  viscosityTable?: ViscosityTableInputPoint[];
}

export function tablePointsDTO(
  points: (MediumViscosityTablePoint | ViscosityTablePointDTO | ViscosityTableInputPoint)[] = [],
): ViscosityTablePointDTO[] {
  return points
    .map((p, i) => ({
      temperatureK: p.temperatureK,
      dynamicViscosity: p.dynamicViscosity,
      sortOrder: p.sortOrder ?? i,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder || a.temperatureK - b.temperatureK);
}

export function toMediumDTO(
  m: Medium,
  points: (MediumViscosityTablePoint | ViscosityTablePointDTO | ViscosityTableInputPoint)[] = [],
): MediumDTO {
  return {
    id: m.id,
    slug: m.slug,
    name: m.name,
    phase: m.phase,
    density: m.density,
    refTemperatureK: m.refTemperatureK,
    refPressurePa: m.refPressurePa,
    viscosityModel: m.viscosityModel as ViscosityModelName,
    constantDynamicViscosity: m.constantDynamicViscosity,
    sutherlandMuRef: m.sutherlandMuRef,
    sutherlandTRef: m.sutherlandTRef,
    sutherlandS: m.sutherlandS,
    viscosityTable: tablePointsDTO(points),
    dynamicViscosity: m.dynamicViscosity,
    kinematicViscosity: m.kinematicViscosity,
    speedOfSound: m.speedOfSound,
    notes: m.notes,
    isSeeded: m.isSeeded,
  };
}

export function specFromInput(input: MediumViscosityInput): ViscositySpec {
  switch (input.viscosityModel) {
    case "constant":
      return { model: "constant", mu: Number(input.constantDynamicViscosity) };
    case "sutherland":
      return {
        model: "sutherland",
        muRef: Number(input.sutherlandMuRef),
        tRef: Number(input.sutherlandTRef),
        s: Number(input.sutherlandS),
      };
    case "table": {
      const rows = tablePointsDTO(input.viscosityTable ?? []).sort((a, b) => a.temperatureK - b.temperatureK);
      return {
        model: "table",
        tempsK: rows.map((p) => p.temperatureK),
        mu: rows.map((p) => p.dynamicViscosity),
      };
    }
  }
}

export function mediumViscosityColumns(input: MediumViscosityInput) {
  if (input.viscosityModel === "constant") {
    return {
      viscosityModel: input.viscosityModel,
      constantDynamicViscosity: input.constantDynamicViscosity ?? null,
      sutherlandMuRef: null,
      sutherlandTRef: null,
      sutherlandS: null,
    };
  }
  if (input.viscosityModel === "sutherland") {
    return {
      viscosityModel: input.viscosityModel,
      constantDynamicViscosity: null,
      sutherlandMuRef: input.sutherlandMuRef ?? null,
      sutherlandTRef: input.sutherlandTRef ?? null,
      sutherlandS: input.sutherlandS ?? null,
    };
  }
  return {
    viscosityModel: input.viscosityModel,
    constantDynamicViscosity: null,
    sutherlandMuRef: null,
    sutherlandTRef: null,
    sutherlandS: null,
  };
}

export function mediumViscosityInputFromMedium(
  medium: Medium,
  points: (MediumViscosityTablePoint | ViscosityTablePointDTO | ViscosityTableInputPoint)[] = [],
): MediumViscosityInput {
  return {
    viscosityModel: medium.viscosityModel as ViscosityModelName,
    constantDynamicViscosity: medium.constantDynamicViscosity,
    sutherlandMuRef: medium.sutherlandMuRef,
    sutherlandTRef: medium.sutherlandTRef,
    sutherlandS: medium.sutherlandS,
    viscosityTable: tablePointsDTO(points),
  };
}

export function specFromMedium(
  medium: Medium,
  points: (MediumViscosityTablePoint | ViscosityTablePointDTO | ViscosityTableInputPoint)[] = [],
): ViscositySpec {
  return specFromInput(mediumViscosityInputFromMedium(medium, points));
}

export function resolveViscosity(
  input: MediumViscosityInput,
  density: number,
  tempK: number,
): { dynamicViscosity: number; kinematicViscosity: number } {
  const mu = evalDynamicViscosity(specFromInput(input), tempK);
  return { dynamicViscosity: mu, kinematicViscosity: mu / density };
}

export function deriveBcState(
  medium: Medium,
  input: Pick<BoundaryCondition, "temperatureK" | "pressurePa" | "referenceChordM" | "speedMps">,
  points: (MediumViscosityTablePoint | ViscosityTablePointDTO | ViscosityTableInputPoint)[] = [],
): OperatingConditionState {
  return deriveOperatingConditionState(
    {
      phase: medium.phase,
      density: medium.density,
      refTemperatureK: medium.refTemperatureK,
      refPressurePa: medium.refPressurePa,
      viscosity: specFromMedium(medium, points),
      speedOfSound: medium.speedOfSound,
    },
    {
      temperatureK: input.temperatureK,
      pressurePa: input.pressurePa,
      referenceChordM: input.referenceChordM,
      speedMps: input.speedMps,
    },
  );
}

export function deriveFlowState(
  medium: Medium,
  input: Pick<FlowCondition, "temperatureK" | "pressurePa" | "speedMps">,
  points: (MediumViscosityTablePoint | ViscosityTablePointDTO | ViscosityTableInputPoint)[] = [],
): FlowConditionState {
  return deriveFlowConditionState(
    {
      phase: medium.phase,
      density: medium.density,
      refTemperatureK: medium.refTemperatureK,
      refPressurePa: medium.refPressurePa,
      viscosity: specFromMedium(medium, points),
      speedOfSound: medium.speedOfSound,
    },
    {
      temperatureK: input.temperatureK,
      pressurePa: input.pressurePa,
      speedMps: input.speedMps,
    },
  );
}
