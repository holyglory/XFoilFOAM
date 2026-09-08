export const PROGRESSIVE_COMPUTE_POLICY = {
  version: "progressive-compute-v2",
  maximumMach: 3,
  incompressibleMachLimit: 0.3,
  sonicMargin: 0.05,
  densityBasedMachThreshold: 1.2,
  initialFastAnchors: 2,
  maximumFastAnchors: 8,
  minimumMarginalGain: 0.05,
  fastAnchorActiveSeconds: 900,
  maximumFastAttempts: 2,
  preciseInitialActiveSeconds: 43_200,
  turbulentPrandtl: 0.85,
} as const;

export type ProgressiveSolverFamily =
  | "simpleFoam"
  | "pimpleFoam"
  | "rhoSimpleFoam"
  | "rhoPimpleFoam"
  | "rhoCentralFoam";

export type ProgressiveTimeCoordinate =
  | "local_pseudo_time_iterations"
  | "physical_time_seconds";

export function progressiveSolverIsTransient(
  family: ProgressiveSolverFamily,
  coordinate?: ProgressiveTimeCoordinate,
): boolean {
  if (coordinate === "local_pseudo_time_iterations") {
    if (family !== "rhoCentralFoam")
      throw new Error("Local pseudo-time requires the density-based solver");
    return false;
  }
  const transient = ["pimpleFoam", "rhoPimpleFoam", "rhoCentralFoam"].includes(
    family,
  );
  if (coordinate === "physical_time_seconds" && !transient)
    throw new Error(
      "Steady pressure-based solvers cannot claim physical-time histories",
    );
  if (coordinate !== undefined && coordinate !== "physical_time_seconds")
    throw new Error("Unknown progressive time coordinate");
  return transient;
}

export function selectProgressiveSolver(input: {
  mach: number;
  minimumCriticalMach: number | null;
  diagnosedUnsteadiness: boolean;
  diagnosedShockInstability: boolean;
}): {
  solver: ProgressiveSolverFamily;
  reason: string;
  pressureKind: "kinematic" | "absolute";
} {
  if (
    !Number.isFinite(input.mach) ||
    input.mach < 0 ||
    input.mach > PROGRESSIVE_COMPUTE_POLICY.maximumMach
  )
    throw new Error(
      "Progressive air solver supports finite Mach numbers from 0 through 3",
    );
  if (
    input.minimumCriticalMach !== null &&
    (!Number.isFinite(input.minimumCriticalMach) ||
      input.minimumCriticalMach <= 0)
  )
    throw new Error(
      "Critical Mach must be a positive measured or predicted value, or unavailable",
    );
  if (input.mach >= PROGRESSIVE_COMPUTE_POLICY.densityBasedMachThreshold)
    return {
      solver: "rhoCentralFoam",
      reason: "supersonic_density_based",
      pressureKind: "absolute",
    };
  const localSonicMargin =
    input.minimumCriticalMach !== null &&
    input.minimumCriticalMach - input.mach >=
      PROGRESSIVE_COMPUTE_POLICY.sonicMargin;
  if (
    input.mach < PROGRESSIVE_COMPUTE_POLICY.incompressibleMachLimit &&
    localSonicMargin &&
    !input.diagnosedShockInstability
  )
    return {
      solver: input.diagnosedUnsteadiness ? "pimpleFoam" : "simpleFoam",
      reason: input.diagnosedUnsteadiness
        ? "low_mach_unsteady"
        : "low_mach_with_sonic_margin",
      pressureKind: "kinematic",
    };
  return {
    solver:
      input.diagnosedUnsteadiness || input.diagnosedShockInstability
        ? "rhoPimpleFoam"
        : "rhoSimpleFoam",
    reason: input.diagnosedShockInstability
      ? "diagnosed_shock_instability"
      : input.diagnosedUnsteadiness
        ? "compressible_unsteady"
        : "compressible_or_unknown_sonic_margin",
    pressureKind: "absolute",
  };
}

export interface PredictionAnchorSample {
  alpha: number;
  cl: number;
  cd: number;
}

function requestedGrid(angles: number[]): number[] {
  if (!angles.length || angles.some((angle) => !Number.isFinite(angle)))
    throw new Error("Anchor selection requires finite requested angles");
  return [...new Set(angles)].sort((left, right) => left - right);
}

export function initialFastAnchors(
  angles: number[],
  prediction: PredictionAnchorSample[] | null,
): {
  angles: number[];
  reason: "prior_zero_lift_and_efficiency" | "missing_prior_bracketing";
} {
  const grid = requestedGrid(angles);
  if (!prediction || prediction.length < 2)
    return {
      angles: [...new Set([grid[0], grid.at(-1)!])],
      reason: "missing_prior_bracketing",
    };
  if (
    prediction.some(
      (sample) =>
        ![sample.alpha, sample.cl, sample.cd].every(Number.isFinite) ||
        sample.cd <= 0,
    )
  )
    throw new Error("Anchor prediction contains invalid coefficients");
  const samples = [...prediction].sort(
    (left, right) => left.alpha - right.alpha,
  );
  if (
    new Set(samples.map((sample) => sample.alpha)).size !== samples.length ||
    samples[0].alpha > grid[0] ||
    samples.at(-1)!.alpha < grid.at(-1)!
  )
    throw new Error(
      "Anchor prediction must span the requested grid without duplicate angles",
    );
  const inScope = samples.filter(
    (sample) => sample.alpha >= grid[0] && sample.alpha <= grid.at(-1)!,
  );
  if (!inScope.length)
    throw new Error("Anchor prediction has no in-scope samples");
  const roots: number[] = [];
  for (let index = 0; index < samples.length; index++) {
    const current = samples[index];
    if (current.cl === 0) roots.push(current.alpha);
    const next = samples[index + 1];
    if (next && current.cl * next.cl < 0)
      roots.push(
        current.alpha -
          (current.cl * (next.alpha - current.alpha)) / (next.cl - current.cl),
      );
  }
  const zeroLift =
    roots
      .filter((angle) => angle >= grid[0] && angle <= grid.at(-1)!)
      .sort(
        (left, right) => Math.abs(left) - Math.abs(right) || left - right,
      )[0] ??
    [...inScope].sort(
      (left, right) =>
        Math.abs(left.cl) - Math.abs(right.cl) || left.alpha - right.alpha,
    )[0].alpha;
  const efficiency = [...inScope].sort(
    (left, right) =>
      right.cl / right.cd - left.cl / left.cd || left.alpha - right.alpha,
  )[0].alpha;
  const nearest = (angle: number) =>
    [...grid].sort(
      (left, right) =>
        Math.abs(left - angle) - Math.abs(right - angle) || left - right,
    )[0];
  const first = nearest(zeroLift);
  let second = nearest(efficiency);
  if (second === first && grid.length > 1)
    second = [...grid].sort(
      (left, right) =>
        Math.abs(right - first) - Math.abs(left - first) || left - right,
    )[0];
  return {
    angles: [...new Set([first, second])],
    reason: "prior_zero_lift_and_efficiency",
  };
}

export interface InformationGainCandidate {
  alpha: number;
  integratedVarianceReductionFraction: number;
  expectedActiveSeconds: number;
  modelId: string;
  costEvidenceId: string;
}

export function nextFastAnchor(input: {
  requestedAngles: number[];
  attemptedAngles: number[];
  initialCoverageComplete: boolean;
  candidates: InformationGainCandidate[];
}): {
  alpha: number | null;
  reason:
    | "initial_coverage_pending"
    | "angle_budget"
    | "marginal_gain"
    | "no_measured_candidate"
    | "information_gain";
} {
  const requested = requestedGrid(input.requestedAngles);
  const attempted = new Set(input.attemptedAngles);
  if ([...attempted].some((angle) => !requested.includes(angle)))
    throw new Error("Attempted anchor is outside the sealed requested scope");
  if (!input.initialCoverageComplete)
    return { alpha: null, reason: "initial_coverage_pending" };
  if (
    attempted.size >=
    Math.min(PROGRESSIVE_COMPUTE_POLICY.maximumFastAnchors, requested.length)
  )
    return { alpha: null, reason: "angle_budget" };
  for (const candidate of input.candidates) {
    if (
      !requested.includes(candidate.alpha) ||
      !Number.isFinite(candidate.integratedVarianceReductionFraction) ||
      candidate.integratedVarianceReductionFraction < 0 ||
      candidate.integratedVarianceReductionFraction > 1 ||
      !Number.isFinite(candidate.expectedActiveSeconds) ||
      candidate.expectedActiveSeconds <= 0 ||
      !candidate.modelId ||
      !candidate.costEvidenceId
    )
      throw new Error(
        "Information-gain admission requires an in-scope model and measured cost provenance",
      );
  }
  const available = input.candidates.filter(
    (candidate) => !attempted.has(candidate.alpha),
  );
  if (!available.length)
    return { alpha: null, reason: "no_measured_candidate" };
  const useful = available.filter(
    (candidate) =>
      candidate.integratedVarianceReductionFraction >=
      PROGRESSIVE_COMPUTE_POLICY.minimumMarginalGain,
  );
  if (!useful.length) return { alpha: null, reason: "marginal_gain" };
  useful.sort(
    (left, right) =>
      right.integratedVarianceReductionFraction / right.expectedActiveSeconds -
        left.integratedVarianceReductionFraction / left.expectedActiveSeconds ||
      left.alpha - right.alpha,
  );
  return { alpha: useful[0].alpha, reason: "information_gain" };
}
