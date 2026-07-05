import { type Point } from "@aerodb/core";
import type { Airfoil } from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { ALL_IMAGE_FIELDS, type AirfoilFormat, type PolarRequest, type ResourcePolicy, type TurbulenceModelName } from "@aerodb/engine-client";

/** Map an immutable simulation setup revision + airfoil into a Python PolarRequest.
 *  wave 1 = steady (transient_fallback off); wave 2 = re-run post-stall as URANS. */
export function buildPolarRequest(opts: {
  airfoil: Airfoil;
  setup: SimulationSetupSnapshot;
  aoaList: number[];
  wave: number;
  queuePressure?: number;
  /** Global solver capacity (sweeper_state.cpuSlots). >0 → cpu_budget cap;
   *  0 → auto: omit cpu_budget so the engine resolves its own worker budget;
   *  undefined → legacy behavior (scheduling-profile snapshot value). */
  cpuSlots?: number;
  /** Batched campaign jobs: canonical speeds of every (condition, speed) entry
   *  (one shared mesh per chord, all speeds×angles march warm-started).
   *  Omitted → the snapshot's single speed (legacy behavior). */
  speeds?: number[];
}): { request: PolarRequest; speed: number; nu: number } {
  const { airfoil, setup, aoaList, wave, queuePressure, cpuSlots, speeds } = opts;
  const cpuBudget =
    cpuSlots == null ? (setup.scheduling.cpuBudget ?? undefined) : cpuSlots > 0 ? cpuSlots : undefined;
  const nu = setup.flowState.kinematicViscosity;
  const speed = setup.flowState.speedMps;
  const points = (airfoil.points as Point[]).map((p) => [p.x, p.y] as [number, number]);
  const request: PolarRequest = {
    airfoil: { name: airfoil.name, format: airfoil.pointFormat as AirfoilFormat, points },
    chord_lengths: [setup.referenceGeometry.referenceLengthM],
    speeds: speeds && speeds.length ? speeds : [speed],
    aoa: { angles: aoaList },
    fluid: { density: setup.flowState.density, kinematic_viscosity: nu },
    roughness: { sand_grain_height: setup.boundary.sandGrainHeight, roughness_constant: setup.boundary.roughnessConstant },
    mesh: {
      mesher: setup.mesh.mesher,
      farfield_radius_chords: setup.mesh.farfieldRadiusChords,
      wake_length_chords: setup.mesh.wakeLengthChords,
      n_surface: setup.mesh.nSurface,
      n_radial: setup.mesh.nRadial,
      n_wake: setup.mesh.nWake,
      target_y_plus: setup.mesh.targetYPlus,
      span_chords: setup.mesh.spanChords,
    },
    solver: {
      turbulence: {
        model: setup.solver.turbulenceModel as TurbulenceModelName,
        intensity: setup.boundary.turbulenceIntensity,
        viscosity_ratio: setup.boundary.viscosityRatio,
      },
      n_iterations: setup.solver.nIterations,
      convergence_tolerance: setup.solver.convergenceTolerance,
      momentum_scheme: setup.solver.momentumScheme,
      transient_fallback: wave === 2,
      force_transient: wave === 2,
      warm_start: wave === 1,
      transient_cycles: setup.solver.transientCycles,
      transient_discard_fraction: setup.solver.transientDiscardFraction,
      transient_max_courant: setup.solver.transientMaxCourant,
      write_images: ALL_IMAGE_FIELDS,
      image_zoom_chords: setup.output.imageZoomChords,
    },
    resources: {
      policy: (setup.scheduling.schedulingPolicy ?? "auto") as ResourcePolicy,
      cpu_budget: cpuBudget,
      case_concurrency: setup.scheduling.caseConcurrency ?? undefined,
      solver_processes: setup.scheduling.solverProcesses ?? undefined,
      queue_pressure: queuePressure ?? undefined,
    },
  };
  return { request, speed, nu };
}
