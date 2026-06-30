// Viscosity models for the mediums registry. This is the ONE implementation of
// Sutherland's law etc. — the Python solver stays a dumb scalar consumer (it is
// handed a resolved density + dynamic/kinematic viscosity per boundary condition).

export type ViscosityModelName = "constant" | "sutherland" | "table";

export type ViscositySpec =
  | { model: "constant"; mu: number } // mu [Pa·s]
  | { model: "sutherland"; muRef: number; tRef: number; s: number } // Sutherland coefficients
  | { model: "table"; tempsK: number[]; mu: number[] }; // linear-interpolated table

/**
 * Dynamic viscosity μ [Pa·s] at temperature `tempK` [K].
 *
 * Sutherland's law: μ(T) = μ_ref · (T/T_ref)^1.5 · (T_ref + S) / (T + S)
 */
export function evalDynamicViscosity(spec: ViscositySpec, tempK: number): number {
  switch (spec.model) {
    case "constant":
      return spec.mu;
    case "sutherland": {
      const { muRef, tRef, s } = spec;
      return muRef * Math.pow(tempK / tRef, 1.5) * ((tRef + s) / (tempK + s));
    }
    case "table": {
      const T = spec.tempsK;
      const M = spec.mu;
      if (T.length === 0) throw new Error("viscosity table is empty");
      if (tempK <= T[0]) return M[0];
      if (tempK >= T[T.length - 1]) return M[M.length - 1];
      for (let i = 0; i < T.length - 1; i++) {
        if (tempK >= T[i] && tempK <= T[i + 1]) {
          const f = (tempK - T[i]) / (T[i + 1] - T[i]);
          return M[i] + (M[i + 1] - M[i]) * f;
        }
      }
      return M[M.length - 1];
    }
  }
}

/** Kinematic viscosity ν = μ/ρ [m²/s]. */
export function evalKinematicViscosity(
  spec: ViscositySpec,
  density: number,
  tempK: number,
): number {
  return evalDynamicViscosity(spec, tempK) / density;
}

export interface MediumStateInput {
  phase: "gas" | "liquid";
  density: number;
  refTemperatureK: number;
  refPressurePa: number;
  viscosity: ViscositySpec;
  speedOfSound?: number | null;
}

export interface FlowConditionInput {
  temperatureK: number;
  pressurePa: number;
  speedMps: number;
}

export interface FlowConditionState {
  dynamicViscosity: number;
  density: number;
  kinematicViscosity: number;
  mach: number | null;
}

export interface OperatingConditionInput extends FlowConditionInput {
  referenceChordM: number;
}

export interface OperatingConditionState extends FlowConditionState {
  reynolds: number;
}

export function densityAtState(medium: MediumStateInput, state: Pick<FlowConditionInput, "temperatureK" | "pressurePa">): number {
  if (medium.phase !== "gas") return medium.density;
  return medium.density * (state.pressurePa / medium.refPressurePa) * (medium.refTemperatureK / state.temperatureK);
}

export function deriveFlowConditionState(
  medium: MediumStateInput,
  state: FlowConditionInput,
): FlowConditionState {
  const dynamicViscosity = evalDynamicViscosity(medium.viscosity, state.temperatureK);
  const density = densityAtState(medium, state);
  const kinematicViscosity = dynamicViscosity / density;
  const mach = medium.speedOfSound && medium.speedOfSound > 0 ? state.speedMps / medium.speedOfSound : null;
  return { dynamicViscosity, density, kinematicViscosity, mach };
}

export function reynoldsFromFlowReference(flow: Pick<FlowConditionInput, "speedMps"> & Pick<FlowConditionState, "kinematicViscosity">, referenceLengthM: number): number {
  return (flow.speedMps * referenceLengthM) / flow.kinematicViscosity;
}

export function deriveOperatingConditionState(
  medium: MediumStateInput,
  state: OperatingConditionInput,
): OperatingConditionState {
  const flow = deriveFlowConditionState(medium, state);
  return { ...flow, reynolds: reynoldsFromFlowReference({ speedMps: state.speedMps, kinematicViscosity: flow.kinematicViscosity }, state.referenceChordM) };
}
