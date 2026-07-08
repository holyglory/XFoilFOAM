import { type Point } from "@aerodb/core";
import type { Airfoil } from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import {
  ALL_IMAGE_FIELDS,
  type AirfoilFormat,
  type PolarRequest,
  type ResourcePolicy,
  type TurbulenceModelName,
  type UransFidelity,
} from "@aerodb/engine-client";

/** Map an immutable simulation setup revision + airfoil into a Python PolarRequest.
 *  wave 1 = steady (transient_fallback off); wave 2 = re-run post-stall as URANS.
 *  Wave-2 requests carry solver.urans_fidelity (ladder contract 1): 'precalc'
 *  by default (3 periods, 1 h budget, half-resolution mesh — engine-derived);
 *  verify-queue / admin-full jobs pass 'full' explicitly. */
export function buildPolarRequest(opts: {
  airfoil: Airfoil;
  setup: SimulationSetupSnapshot;
  aoaList: number[];
  wave: number;
  /** URANS fidelity tier for wave-2 requests. Default 'precalc'. Ignored on
   *  wave 1 (steady solves have no URANS tier). */
  uransFidelity?: UransFidelity;
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
  const { airfoil, setup, aoaList, wave, uransFidelity, queuePressure, cpuSlots, speeds } = opts;
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
      // Wave-1 jobs (campaign RANS batches AND continuous/public sweeps) must
      // ship transient_fallback:false EXPLICITLY — the engine defaults it to
      // TRUE when the key is absent (models.py SolverParams), which re-runs
      // every non-converged steady as an ungated in-job URANS with no tier
      // fidelity/budget. Rejected wave-1 points reach URANS ONLY through the
      // gated ladder (targeted wave-2 'precalc' retries in reconcile.ts).
      // Incident pin: prod wave-1 sweep job 20b67295 (s1223 -5deg) diverged in
      // an engine-side in-job escalation. MUST-CATCH payload-shape pins:
      // build-request-transient-pin.test.ts. NOTE the engine's marched-sweep
      // whole-polar abort (pipeline.py should_abort_rans_sweep_for_urans) is
      // NOT gated on these flags — that gate is engine-side work.
      transient_fallback: wave === 2,
      force_transient: wave === 2,
      // Ladder contract 1: the node sends ONLY the fidelity literal; the
      // engine derives min periods / budget / mesh scale from it.
      ...(wave === 2 ? { urans_fidelity: uransFidelity ?? "precalc" } : {}),
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
