import { type Point } from "@aerodb/core";
import {
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  type Airfoil,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import {
  ALL_IMAGE_FIELDS,
  LEGACY_OPENCFD_2406_ENGINE,
  type AirfoilFormat,
  type EngineIdentity,
  type MeshParams,
  type PolarRequest,
  type RansFailurePolicy,
  type ResourcePolicy,
  type TurbulenceModelName,
  type UransFidelity,
} from "@aerodb/engine-client";

/** Engine v14 includes the immutable preliminary-URANS statistical contract
 * plus JSON-finite cycle diagnostics required for readable terminal results.
 * can publish a separately certified stationary aperiodic statistical mean.
 * Pin every new wave-2 request so a rolling deployment fails closed instead of
 * silently producing evidence under the older contract. */
export const REQUIRED_PRECALC_EVIDENCE_RECOVERY_VERSION = 14;
export const REQUIRED_URANS_INITIALIZATION_VERSION = 1;

export function engineIdentityForSetup(
  setup: SimulationSetupSnapshot,
): EngineIdentity {
  const engine = setup.engine;
  if (!engine) return { ...LEGACY_OPENCFD_2406_ENGINE };
  if (
    engine.family !== "openfoam" ||
    (engine.distribution !== "opencfd" && engine.distribution !== "foundation")
  ) {
    throw new Error(
      `unsupported solver implementation ${engine.key}; this worker supports OpenFOAM only`,
    );
  }
  return {
    family: engine.family,
    distribution: engine.distribution,
    version: engine.releaseVersion,
    numerics_revision: engine.numericsRevision,
    adapter_contract_version: engine.adapterContractVersion,
  };
}

/** Requested implementation FK for newly composed jobs. A historical
 * snapshot without structured identity can enter only the explicit legacy
 * OpenCFD-v2406 compatibility route. */
export function solverImplementationIdForSetup(
  setup: SimulationSetupSnapshot,
): string {
  return (
    setup.engine?.implementationId ?? OPENCFD_2406_SOLVER_IMPLEMENTATION_ID
  );
}

/** Map an immutable simulation setup revision + airfoil into a Python PolarRequest.
 *  wave 1 = steady (transient_fallback off); wave 2 = re-run post-stall as URANS.
 *  Wave-2 requests carry solver.urans_fidelity (ladder contract 1): 'precalc'
 *  by default (3 periods, 4 h budget, half-resolution wall-function mesh — engine-derived);
 *  verify-queue / admin-full jobs pass 'full' explicitly. */
export function buildPolarRequest(opts: {
  airfoil: Airfoil;
  setup: SimulationSetupSnapshot;
  aoaList: number[];
  wave: number;
  /** URANS fidelity tier for wave-2 requests. Default 'precalc'. Ignored on
   *  wave 1 (steady solves have no URANS tier). */
  uransFidelity?: UransFidelity;
  /** Wave-1 low-AoA policy. Continuous production polars use
   * abort_for_precalc; explicit targeted work uses continue. */
  ransFailurePolicy?: RansFailurePolicy;
  /** Global solver capacity (sweeper_state.cpuSlots). >0 → cpu_budget cap;
   *  0 → auto: omit cpu_budget so the engine resolves its own worker budget;
   *  undefined → legacy behavior (scheduling-profile snapshot value). */
  cpuSlots?: number;
  /** Batched campaign jobs: canonical speeds of every (condition, speed) entry
   *  (one shared mesh per chord, all speeds×angles march warm-started).
   *  Omitted → the snapshot's single speed (legacy behavior). */
  speeds?: number[];
  /** Logical numerical implementation selected by the immutable setup.
   * Defaults only to the historical OpenCFD-v2406 compatibility path. */
  engineIdentity?: EngineIdentity;
}): { request: PolarRequest; speed: number; nu: number } {
  const {
    airfoil,
    setup,
    aoaList,
    wave,
    uransFidelity,
    ransFailurePolicy,
    cpuSlots,
    speeds,
    engineIdentity,
  } = opts;
  const cpuBudget =
    cpuSlots == null
      ? (setup.scheduling.cpuBudget ?? undefined)
      : cpuSlots > 0
        ? cpuSlots
        : undefined;
  const nu = setup.flowState.kinematicViscosity;
  const speed = setup.flowState.speedMps;
  const points = (airfoil.points as Point[]).map(
    (p) => [p.x, p.y] as [number, number],
  );
  const meshBlock = (mesh: SimulationSetupSnapshot["mesh"]): MeshParams => ({
    mesher: mesh.mesher,
    farfield_radius_chords: mesh.farfieldRadiusChords,
    wake_length_chords: mesh.wakeLengthChords,
    n_surface: mesh.nSurface,
    n_radial: mesh.nRadial,
    n_wake: mesh.nWake,
    target_y_plus: mesh.targetYPlus,
    span_chords: mesh.spanChords,
  });
  const request: PolarRequest = {
    ...(wave === 2 && setup.solver.uransInitializationIterations != null
      ? {
          expected_urans_initialization_version:
            REQUIRED_URANS_INITIALIZATION_VERSION,
        }
      : {}),
    expected_engine: {
      ...(engineIdentity ?? engineIdentityForSetup(setup)),
    },
    ...(wave === 2
      ? {
          expected_urans_recovery_version:
            REQUIRED_PRECALC_EVIDENCE_RECOVERY_VERSION,
        }
      : {}),
    airfoil: {
      name: airfoil.name,
      format: airfoil.pointFormat as AirfoilFormat,
      points,
    },
    chord_lengths: [setup.referenceGeometry.referenceLengthM],
    speeds: speeds && speeds.length ? speeds : [speed],
    aoa: { angles: aoaList },
    fluid: { density: setup.flowState.density, kinematic_viscosity: nu },
    roughness: {
      sand_grain_height: setup.boundary.sandGrainHeight,
      roughness_constant: setup.boundary.roughnessConstant,
    },
    mesh: meshBlock(setup.mesh),
    ...(setup.uransMesh ? { urans_mesh: meshBlock(setup.uransMesh) } : {}),
    ...(setup.uransPrecalcMesh
      ? { urans_precalc_mesh: meshBlock(setup.uransPrecalcMesh) }
      : {}),
    solver: {
      turbulence: {
        model: setup.solver.turbulenceModel as TurbulenceModelName,
        intensity: setup.boundary.turbulenceIntensity,
        viscosity_ratio: setup.boundary.viscosityRatio,
      },
      n_iterations: setup.solver.nIterations,
      ...(wave === 2 && setup.solver.uransInitializationIterations != null
        ? {
            urans_initialization_iterations:
              setup.solver.uransInitializationIterations,
          }
        : {}),
      convergence_tolerance: setup.solver.convergenceTolerance,
      momentum_scheme: setup.solver.momentumScheme,
      // Wave-1 jobs (campaign RANS batches AND continuous/public sweeps) must
      // ship transient_fallback:false EXPLICITLY — the engine defaults it to
      // TRUE when the key is absent (models.py SolverParams), which re-runs
      // every non-converged steady as an ungated in-job URANS with no tier
      // fidelity/budget. Wave-1 escalation is explicit: continuous multi-angle
      // work uses abort_for_precalc so a structured low-angle hard_solver
      // failure stops the RANS march and lets the Node ladder durably compose
      // the exact preliminary scope; explicit targeted work uses continue.
      // Incident pin: prod wave-1 sweep job 20b67295 (s1223 -5deg) diverged in
      // an engine-side in-job escalation. MUST-CATCH payload-shape pins:
      // build-request-transient-pin.test.ts.
      transient_fallback: wave === 2,
      rans_failure_policy:
        wave === 1 ? (ransFailurePolicy ?? "continue") : "continue",
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
    },
  };
  return { request, speed, nu };
}

/** Durable scheduler weight for one engine job. OpenCFD runs one or more
 * solver processes per concurrently executed case; the control plane reserves
 * that product so a node cap represents real CPU pressure rather than merely
 * a count of database rows. When case concurrency is automatic but the request
 * carries a bounded CPU budget and explicit case scope, mirror the engine's
 * resolution instead of persisting a fictional one-slot reservation. */
export function admissionCpuSlotsForRequest(
  request: Pick<PolarRequest, "resources"> &
    Partial<Pick<PolarRequest, "aoa" | "speeds" | "chord_lengths" | "solver">>,
): number {
  const resources = request.resources;
  const solverProcesses =
    Number.isInteger(resources?.solver_processes) &&
    (resources?.solver_processes ?? 0) > 0
      ? (resources?.solver_processes as number)
      : 1;
  const caseConcurrency =
    Number.isInteger(resources?.case_concurrency) &&
    (resources?.case_concurrency ?? 0) > 0
      ? (resources?.case_concurrency as number)
      : null;
  const angleCount = request.aoa?.angles?.length ?? 0;
  const speedCount = request.speeds?.length ?? 0;
  const chordCount = request.chord_lengths?.length ?? 0;
  const warmStartedRans =
    request.solver?.warm_start === true &&
    request.solver?.force_transient !== true;
  const caseCount = warmStartedRans
    ? Math.max(1, speedCount) * Math.max(1, chordCount)
    : angleCount * Math.max(1, speedCount) * Math.max(1, chordCount);
  if (caseConcurrency != null) {
    const effectiveConcurrency =
      caseCount > 0 ? Math.min(caseConcurrency, caseCount) : caseConcurrency;
    return Math.max(1, solverProcesses * effectiveConcurrency);
  }

  const cpuBudget =
    Number.isInteger(resources?.cpu_budget) && (resources?.cpu_budget ?? 0) > 0
      ? (resources?.cpu_budget as number)
      : null;
  if (cpuBudget != null && caseCount > 0) {
    return Math.max(1, Math.min(cpuBudget, caseCount * solverProcesses));
  }
  return 1;
}

/** Pin the engine's actual case concurrency to the durable admission weight.
 *
 * `policy=auto` is intentionally sensitive to live queue pressure. That is a
 * useful default for unbounded ad-hoc work, but it is not safe after the
 * control plane has admitted and persisted an exact CPU reservation: a later
 * queue-depth observation can otherwise serialize the engine request while
 * the scheduler continues to report every reserved slot as busy.
 *
 * Requests without an explicit CPU budget or case concurrency remain
 * untouched because their engine resource shape is genuinely unresolved.
 * A finite `maxCpuSlots` lets remote admission consume only the node's current
 * remainder. Zero means even one complete solver-process group will not fit.
 */
export function pinAdmissionCpuSlotsForRequest(
  request: Pick<PolarRequest, "resources"> &
    Partial<Pick<PolarRequest, "aoa" | "speeds" | "chord_lengths" | "solver">>,
  maxCpuSlots = Number.POSITIVE_INFINITY,
): number {
  const resources = request.resources;
  const hasExplicitCpuBudget =
    Number.isInteger(resources?.cpu_budget) && (resources?.cpu_budget ?? 0) > 0;
  const hasExplicitCaseConcurrency =
    Number.isInteger(resources?.case_concurrency) &&
    (resources?.case_concurrency ?? 0) > 0;
  if (!hasExplicitCpuBudget && !hasExplicitCaseConcurrency) {
    return admissionCpuSlotsForRequest(request);
  }

  const solverProcesses =
    Number.isInteger(resources?.solver_processes) &&
    (resources?.solver_processes ?? 0) > 0
      ? (resources?.solver_processes as number)
      : 1;
  const naturalSlots = admissionCpuSlotsForRequest(request);
  const boundedSlots = Math.min(
    naturalSlots,
    Number.isFinite(maxCpuSlots)
      ? Math.max(0, Math.floor(maxCpuSlots))
      : naturalSlots,
  );
  if (boundedSlots < solverProcesses) return 0;

  const caseConcurrency = Math.max(
    1,
    Math.floor(boundedSlots / solverProcesses),
  );
  const admissionCpuSlots = caseConcurrency * solverProcesses;
  const pinnedResources = {
    ...(resources ?? {}),
    cpu_budget: admissionCpuSlots,
    case_concurrency: caseConcurrency,
  };
  if (resources) {
    // Several composition paths retain the original resources object while
    // assembling the durable job payload. Mutate that exact object as well as
    // assigning it back so no captured reference can keep the pre-pin
    // cpu_budget/case_concurrency pair.
    Object.assign(resources, pinnedResources);
    request.resources = resources;
  } else {
    request.resources = pinnedResources;
  }
  return admissionCpuSlots;
}
