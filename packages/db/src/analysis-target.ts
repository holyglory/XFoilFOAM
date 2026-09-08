import { createHash } from "node:crypto";
import { materialPhysicsValues, type GasThermodynamicModel } from "@aerodb/core";
import type { SimulationSetupSnapshot } from "./simulation-setup";

export interface AnalysisMaterial {
  phase: "gas" | "liquid";
  density: number;
  refTemperatureK: number;
  refPressurePa: number;
  speedOfSound: number | null;
  viscosity: Record<string, unknown>;
  gasThermodynamics?: GasThermodynamicModel | null;
}

export interface TransitionAssumptions {
  model: "fully_turbulent" | "prescribed_transition";
  nCrit: number;
  upper: number;
  lower: number;
}

export function canonicalAnalysisJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalAnalysisJson).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalAnalysisJson(item)}`,
      )
      .join(",")}}`;
  throw new Error("Analysis identity requires finite, explicit JSON values");
}

export function analysisContentHash(value: unknown): string {
  return createHash("sha256")
    .update(canonicalAnalysisJson(value))
    .digest("hex");
}

export function createAnalysisTarget(input: {
  airfoilId: string;
  points: Array<{ x: number; y: number }>;
  material: AnalysisMaterial;
  snapshot: SimulationSetupSnapshot;
  transition: TransitionAssumptions;
  branch: "increasing" | "decreasing" | "independent";
}) {
  const { points, material, snapshot, transition, branch } = input;
  if (
    snapshot.material &&
    analysisContentHash({
      ...snapshot.material,
      speedOfSound: snapshot.material.speedOfSound ?? null,
    }) !== analysisContentHash(material)
  )
    throw new Error(
      "Analysis material differs from its immutable setup snapshot",
    );
  if (points.length < 3)
    throw new Error("Stored coordinate geometry is required");
  if (!points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)))
    throw new Error("Geometry contains nonfinite coordinates");
  if (
    Math.max(...points.map((point) => point.x)) ===
    Math.min(...points.map((point) => point.x))
  )
    throw new Error("Geometry has no chord extent");
  if (
    transition.model === "fully_turbulent" &&
    (transition.upper !== 0 || transition.lower !== 0)
  )
    throw new Error("Fully turbulent targets require leading-edge transition");
  if (
    !(transition.nCrit > 0) ||
    ![transition.upper, transition.lower].every(
      (value) => value >= 0 && value <= 1,
    )
  )
    throw new Error("Invalid transition assumptions");
  const { flowState, referenceGeometry, boundary, derived } = snapshot;
  const geometry = points.map(({ x, y }) => [x, y]);
  const physical = {
    version: "physical-analysis-target-v1",
    airfoilId: input.airfoilId,
    geometry,
    material: materialPhysicsValues(material),
    flow: {
      temperatureK: flowState.temperatureK,
      pressurePa: flowState.pressurePa,
      speedMps: flowState.speedMps,
      density: flowState.density,
      dynamicViscosity: flowState.dynamicViscosity,
      kinematicViscosity: flowState.kinematicViscosity,
    },
    reference: {
      geometryType: referenceGeometry.geometryType,
      referenceLengthKind: referenceGeometry.referenceLengthKind,
      referenceLengthM: referenceGeometry.referenceLengthM,
      spanM: referenceGeometry.spanM,
      referenceAreaM2: referenceGeometry.referenceAreaM2,
    },
    boundary: {
      turbulenceIntensity: boundary.turbulenceIntensity,
      viscosityRatio: boundary.viscosityRatio,
      sandGrainHeight: boundary.sandGrainHeight,
      roughnessConstant: boundary.roughnessConstant,
    },
    transition,
    derived: { reynolds: derived.reynolds, mach: derived.mach },
    branch,
  };
  if (
    !(derived.reynolds > 0) ||
    derived.mach === null ||
    derived.mach < 0 ||
    derived.mach > 3
  )
    throw new Error("Analysis target has no supported Reynolds/Mach state");
  if (
    ![
      flowState.temperatureK,
      flowState.pressurePa,
      flowState.density,
      flowState.dynamicViscosity,
      flowState.kinematicViscosity,
      referenceGeometry.referenceLengthM,
    ].every((value) => value > 0)
  )
    throw new Error("Analysis target has invalid physical state");
  return { signature: analysisContentHash(physical), physical };
}

export type AnalysisPhysical = ReturnType<
  typeof createAnalysisTarget
>["physical"];

export function progressiveComparisonConditionKey(
  physical: AnalysisPhysical,
): string {
  const { airfoilId: _airfoilId, geometry: _geometry, ...condition } = physical;
  return analysisContentHash({
    version: "progressive-comparison-condition-v1",
    physical: condition,
  });
}
