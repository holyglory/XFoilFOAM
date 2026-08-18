/** Evidence-driven recovery policy for rejected preliminary URANS attempts. */

export type PrecalcFailureType =
  | "infrastructure_interruption"
  | "deterministic_setup_failure"
  | "missing_derived_media"
  | "incomplete_observation"
  | "stationary_aperiodic_candidate"
  | "numerical_instability"
  | "nonpublishable_evidence";

export type PrecalcRecoveryAction =
  | "retry_infrastructure"
  | "recover_deterministic_setup"
  | "repair_media"
  | "continue_exact_case"
  | "rerun_statistical_mean_contract"
  | "rerun_conservative_numerics"
  | "rerun_fresh";

export interface PrecalcRecoveryPolicyInput {
  status: string;
  failureDisposition?: string | null;
  classificationReasons?: readonly string[] | null;
  qualityWarnings?: readonly string[] | null;
  error?: string | null;
  hasRestartableEvidence: boolean;
  forceSampleCount?: number | null;
  fieldFrameCount?: number | null;
  /** Retrospective reducer score in [0, 1]. One means the exact immutable
   * history satisfies the new statistical-mean certificate. */
  statisticalMeanScore?: number | null;
  /** Continuous normalized severity derived from force/cycle diagnostics. */
  numericalNoiseScore?: number | null;
  /** Continuous fraction of the required physical observation already held. */
  observationProgress?: number | null;
}

export interface PrecalcRecoveryPlan {
  failureType: PrecalcFailureType;
  action: PrecalcRecoveryAction;
  consumesSolverAttempt: boolean;
  evidenceCompleteness: number;
  statisticalMeanScore: number;
  numericalNoiseScore: number;
  reason: string;
}

const MIN_FORCE_SAMPLES = 400;
const MIN_FIELD_FRAMES = 40;

function clamp01(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : 0;
}

function normalizedCount(
  value: number | null | undefined,
  required: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? clamp01(value / required)
    : 0;
}

function normalizedText(input: PrecalcRecoveryPolicyInput): string {
  return [
    ...(input.classificationReasons ?? []),
    ...(input.qualityWarnings ?? []),
    input.error ?? "",
  ]
    .join(" ")
    .toLowerCase();
}

function onlyMissingVideo(reasons: readonly string[]): boolean {
  const material = reasons.filter(
    (reason) => reason !== "missing-urans-video" && reason !== "not-converged",
  );
  return reasons.includes("missing-urans-video") && material.length === 0;
}

function inferredNumericalNoise(text: string): number {
  const markers = [
    "non-physical",
    "diverg",
    "high-frequency",
    "impulse",
    "amplitude-growth",
    "amplitude growing",
    "shape-error",
    "phase-shift",
    "period-instability",
    "period unstable",
    "mean-trend",
    "monotonic",
  ];
  return clamp01(
    markers.reduce(
      (score, marker) => score + (text.includes(marker) ? 0.25 : 0),
      0,
    ),
  );
}

/**
 * Select one normal ladder action from immutable evidence diagnostics.
 *
 * AoA and Reynolds are deliberately absent: they cannot create categorical
 * routing cliffs. Future learned scoring may add them only as normalized,
 * continuous features while preserving the typed evidence precedence here.
 */
export function planPrecalcRecovery(
  input: PrecalcRecoveryPolicyInput,
): PrecalcRecoveryPlan {
  const reasons = [...new Set(input.classificationReasons ?? [])];
  const text = normalizedText(input);
  const sampleCompleteness = normalizedCount(
    input.forceSampleCount,
    MIN_FORCE_SAMPLES,
  );
  const frameCompleteness = normalizedCount(
    input.fieldFrameCount,
    MIN_FIELD_FRAMES,
  );
  const measuredCompleteness = Math.min(sampleCompleteness, frameCompleteness);
  const evidenceCompleteness = Math.max(
    measuredCompleteness,
    clamp01(input.observationProgress),
  );
  const statisticalMeanScore = clamp01(input.statisticalMeanScore);
  const numericalNoiseScore = Math.max(
    clamp01(input.numericalNoiseScore),
    inferredNumericalNoise(text),
  );

  if (
    input.failureDisposition === "infrastructure" ||
    input.status === "cancelled" ||
    text.includes("infrastructure") ||
    text.includes("lost engine job") ||
    text.includes("worker restart")
  ) {
    return {
      failureType: "infrastructure_interruption",
      action: "retry_infrastructure",
      consumesSolverAttempt: false,
      evidenceCompleteness,
      statisticalMeanScore,
      numericalNoiseScore,
      reason: "execution ended before usable physical evidence",
    };
  }

  if (
    input.failureDisposition === "deterministic_mesh" ||
    text.includes("deterministic-mesh")
  ) {
    return {
      failureType: "deterministic_setup_failure",
      action: "recover_deterministic_setup",
      consumesSolverAttempt: false,
      evidenceCompleteness,
      statisticalMeanScore,
      numericalNoiseScore,
      reason: "deterministic setup or mesh recovery is required before CFD",
    };
  }

  if (onlyMissingVideo(reasons)) {
    return {
      failureType: "missing_derived_media",
      action: "repair_media",
      consumesSolverAttempt: false,
      evidenceCompleteness,
      statisticalMeanScore,
      numericalNoiseScore,
      reason: "coefficients are usable but required stored media is missing",
    };
  }

  const incomplete =
    reasons.some((reason) =>
      [
        "incomplete-urans-integration",
        "insufficient-periods",
        "insufficient-clean-cycle-evidence",
      ].includes(reason),
    ) ||
    text.includes("insufficient-observation-horizon") ||
    text.includes("insufficient-source-samples") ||
    text.includes("insufficient-field-frames") ||
    text.includes("missing-periodicity-assessment") ||
    text.includes("insufficient-periodicity-cycles") ||
    text.includes("source-cadence-gap") ||
    text.includes("budget-stop") ||
    text.includes("continuation-required");
  if (input.hasRestartableEvidence && incomplete) {
    return {
      failureType: "incomplete_observation",
      action: "continue_exact_case",
      consumesSolverAttempt: false,
      evidenceCompleteness,
      statisticalMeanScore,
      numericalNoiseScore,
      reason: "the exact saved trajectory needs more physical observation",
    };
  }

  if (statisticalMeanScore > 0) {
    return {
      failureType: "stationary_aperiodic_candidate",
      action: "rerun_statistical_mean_contract",
      consumesSolverAttempt: true,
      evidenceCompleteness,
      statisticalMeanScore,
      numericalNoiseScore,
      reason:
        "retrospective evidence supports the separate aperiodic statistical-mean contract",
    };
  }

  if (
    numericalNoiseScore > 0 ||
    input.failureDisposition === "hard_solver" ||
    input.status === "failed"
  ) {
    return {
      failureType: "numerical_instability",
      action: "rerun_conservative_numerics",
      consumesSolverAttempt: true,
      evidenceCompleteness,
      statisticalMeanScore,
      numericalNoiseScore,
      reason: "the next physical attempt must change numerical execution",
    };
  }

  return {
    failureType: "nonpublishable_evidence",
    action: "rerun_fresh",
    consumesSolverAttempt: true,
    evidenceCompleteness,
    statisticalMeanScore,
    numericalNoiseScore,
    reason: "the stored attempt is nonpublishable and has no safe continuation",
  };
}

export function precalcRecoveryOutcome(
  plan: PrecalcRecoveryPlan,
  exhausted: boolean,
): string {
  const base = {
    retry_infrastructure: "infrastructure_retry",
    recover_deterministic_setup: "deterministic_setup_recovery",
    repair_media: "media_repair",
    continue_exact_case: "observation_continuation",
    rerun_statistical_mean_contract: "aperiodic_contract_retry",
    rerun_conservative_numerics: "numerical_recovery",
    rerun_fresh: "fresh_physical_retry",
  } satisfies Record<PrecalcRecoveryAction, string>;
  return `${base[plan.action]}_${exhausted ? "exhausted" : "pending"}`;
}
