import { NON_PHYSICAL_COEFFICIENT_LIMIT } from "@aerodb/core";
import {
  analysisContentHash,
  claimProgressivePolarFit,
  failProgressivePolarFit,
  storeProgressivePolarFit,
  type DB,
  type ProgressiveFitEvidence,
  type ProgressiveFitLease,
} from "@aerodb/db";
import type {
  EngineClient,
  ProgressiveCoefficientVector,
  ProgressivePolarFitRequest,
  ProgressivePolarHistory,
  ProgressivePolarModelPolicy,
  ProgressivePolarObservation,
} from "@aerodb/engine-client";

const ASSUMPTIONS = {
  version: "progressive-fit-assumptions-v6",
  historyOrigin: "recorded-source-before-windowing-v1",
  informativeWindow: "post-startup-suffix-v1",
  minimumUncertifiedConvectiveTransits: 1,
  acquisition: "fixed-posterior-coverage-v1",
  priorLiftStd: 0.3,
  priorMomentStd: 0.1,
  priorDragStdFloor: 0.002,
  priorDragRelativeStd: 0.5,
  historyNoiseFloor: [0.01, 0.001, 0.002] as ProgressiveCoefficientVector,
  model: {
    fast_discrepancy_std: [0.4, 0.4, 0.1],
    precise_discrepancy_std: [0.15, 0.15, 0.03],
    slope_std: [0.5, 0.3, 0.1],
    local_std: [0.15, 0.2, 0.03],
    fast_noise_floor: [0.03, 0.03, 0.005],
    precise_noise_floor: [0.01, 0.01, 0.001],
    correlation_length_deg: 2,
    lineage_correlation: 0.8,
    calibration_status: "unvalidated",
    validation_id: null,
  } satisfies Omit<ProgressivePolarModelPolicy, "policy_id">,
};

export const PROGRESSIVE_FIT_POLICY_ID = `${ASSUMPTIONS.version}-${analysisContentHash(ASSUMPTIONS)}`;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function physicalCoefficients(
  values: unknown[],
): values is ProgressiveCoefficientVector {
  return (
    values.length === 3 &&
    values.every(finite) &&
    values[1] > 0 &&
    Math.abs(values[0]) <= NON_PHYSICAL_COEFFICIENT_LIMIT &&
    Math.abs(values[2]) <= NON_PHYSICAL_COEFFICIENT_LIMIT
  );
}

interface Candidate {
  evidence: ProgressiveFitEvidence;
  observation: ProgressivePolarObservation;
  history: ProgressivePolarHistory | null;
}

function excluded(candidate: Candidate, reason: string): Candidate {
  return {
    ...candidate,
    history: null,
    observation: {
      ...candidate.observation,
      coefficients: null,
      standard_error: null,
      eligible: false,
      exclusion_reason: reason,
    },
  };
}

function candidateFor(
  lease: ProgressiveFitLease,
  evidence: ProgressiveFitEvidence,
): Candidate {
  const payload = evidence.payload;
  const observation: ProgressivePolarObservation = {
    observation_id: `attempt-${evidence.resultAttemptId}`,
    result_id: evidence.resultId,
    attempt_id: evidence.resultAttemptId,
    lineage_id: evidence.lineageId,
    target_signature: lease.source.targetId,
    branch: lease.source.physical.branch,
    method: evidence.stage === 2 ? "openfoam_fast" : "openfoam_precise",
    alpha: evidence.alpha,
    coefficients: null,
    standard_error: null,
    eligible: true,
    numerical_convergence:
      payload.converged === true ? "converged" : "unconverged",
    statistical_certification: "informative_uncertified",
    exclusion_reason: null,
  };
  const candidate: Candidate = { evidence, observation, history: null };
  if (["exclude", "defer"].includes(evidence.review?.verdict ?? ""))
    return excluded(candidate, `review_${evidence.review!.verdict}`);
  if (evidence.classification?.state === "superseded_by_urans")
    return excluded(candidate, "superseded_by_urans");
  if (
    ["infrastructure", "deterministic_mesh", "material_domain"].includes(
      String(payload.failure_disposition),
    )
  )
    return excluded(candidate, `failure_${payload.failure_disposition}`);
  if (
    evidence.classification?.reasons.some((reason) =>
      ["non-physical-coefficients", "non-positive-drag"].includes(reason),
    )
  )
    return excluded(candidate, "nonphysical_coefficients");
  if (
    typeof payload.error === "string" &&
    /(?:^|\n)\s*(?:FOAM FATAL ERROR\b|floating point exception\b|divergence guard:|solver diverged\b)/i.test(
      payload.error,
    )
  )
    return excluded(candidate, "divergent_or_fatal_solver_evidence");
  const transient = record(payload.force_history);
  const steady = record(payload.steady_history);
  const raw = transient ?? steady;
  if (raw) {
    const coordinateKind = transient ? "physical_time" : "iteration";
    const coordinate = raw[transient ? "t" : "iterations"];
    const channels = [raw.cl, raw.cd, raw.cm];
    if (
      !Array.isArray(coordinate) ||
      coordinate.length < 4 ||
      !coordinate.every(finite) ||
      coordinate.some(
        (value, index) => index > 0 && value <= coordinate[index - 1],
      ) ||
      channels.some(
        (channel) =>
          !Array.isArray(channel) || channel.length !== coordinate.length,
      )
    )
      return excluded(candidate, "malformed_or_insufficient_history");
    const coefficients = coordinate.map((_, index) =>
      channels.map((channel) => (channel as number[])[index]),
    );
    if (!coefficients.every(physicalCoefficients))
      return excluded(candidate, "nonphysical_history_coefficients");
    const frameWindow = record(record(payload.frame_track)?.window);
    const steadyWindow = record(raw.window);
    const start = transient
      ? (raw.window_start ?? frameWindow?.t_start)
      : steadyWindow?.start_iter;
    if (!finite(start) || start < coordinate[0] || start > coordinate.at(-1)!)
      return excluded(candidate, "missing_informative_window");
    let informativeStart = start;
    const origin = transient
      ? (raw.source_start_time ?? coordinate[0])
      : coordinate[0];
    if (!finite(origin) || origin > coordinate[0])
      return excluded(candidate, "invalid_history_origin");
    if (transient && evidence.classification?.state !== "accepted") {
      const length = lease.source.physical.reference.referenceLengthM;
      const speed = lease.source.physical.flow.speedMps;
      if (!finite(length) || length <= 0 || !finite(speed) || speed <= 0)
        return excluded(candidate, "missing_physical_history_scale");
      informativeStart = Math.max(
        start,
        origin +
          (ASSUMPTIONS.minimumUncertifiedConvectiveTransits * length) / speed,
      );
      if (informativeStart >= coordinate.at(-1)!)
        return excluded(candidate, "startup_only_history");
    }
    const iat = evidence.interpretation?.maxIatSeconds;
    const correlation = transient && finite(iat) && iat > 0 ? iat : null;
    candidate.history = {
      observation,
      artifact_sha256: analysisContentHash(raw),
      coordinate_kind: coordinateKind,
      coordinate,
      coefficients: coefficients as ProgressiveCoefficientVector[],
      informative_start: informativeStart,
      correlation_time: correlation,
      correlation_evidence_id:
        correlation === null ? null : evidence.interpretation!.id,
    };
    return candidate;
  }
  const values = [payload.cl, payload.cd, payload.cm];
  if (
    payload.converged !== true ||
    payload.unsteady === true ||
    payload.stalled === true ||
    payload.error ||
    !physicalCoefficients(values)
  )
    return excluded(candidate, "insufficient_informative_evidence");
  const floor =
    evidence.stage === 2
      ? ASSUMPTIONS.model.fast_noise_floor
      : ASSUMPTIONS.model.precise_noise_floor;
  observation.coefficients = values;
  observation.standard_error = [
    floor[0],
    Math.max(1e-12, values[1] * floor[1]),
    floor[2],
  ];
  observation.statistical_certification =
    evidence.classification?.state === "accepted"
      ? "steady"
      : "informative_uncertified";
  return candidate;
}

function overlaps(left: Candidate, right: Candidate): boolean {
  if (left.evidence.lineageId !== right.evidence.lineageId) return false;
  if (
    left.history?.coordinate_kind !== "physical_time" ||
    right.history?.coordinate_kind !== "physical_time"
  )
    return true;
  return (
    Math.min(
      left.history.coordinate.at(-1)!,
      right.history.coordinate.at(-1)!,
    ) >
    Math.max(left.history.informative_start, right.history.informative_start)
  );
}

export function buildProgressiveFitRequest(
  lease: ProgressiveFitLease,
): ProgressivePolarFitRequest {
  const { source } = lease;
  const alpha = source.prediction.alpha as number[];
  const coefficients = source.prediction
    .coefficients as ProgressiveCoefficientVector[];
  if (
    !Array.isArray(alpha) ||
    !Array.isArray(coefficients) ||
    alpha.length !== coefficients.length ||
    !coefficients.every(physicalCoefficients)
  )
    throw new Error("Stored NeuralFoil prior is malformed");
  const ordered = source.evidence
    .map((evidence) => candidateFor(lease, evidence))
    .sort(
      (left, right) =>
        right.evidence.createdAt.localeCompare(left.evidence.createdAt) ||
        right.evidence.resultAttemptId.localeCompare(
          left.evidence.resultAttemptId,
        ),
    );
  const accepted: Candidate[] = [];
  const candidates = ordered.map((candidate) => {
    if (!candidate.observation.eligible) return candidate;
    if (accepted.some((other) => overlaps(candidate, other)))
      return excluded(candidate, "overlapping_lineage_evidence");
    accepted.push(candidate);
    return candidate;
  });
  const histories = candidates.flatMap((candidate) =>
    candidate.history ? [candidate.history] : [],
  );
  const observations = candidates
    .filter((candidate) => !candidate.history)
    .map((candidate) => candidate.observation);
  const directCount = observations.filter((row) => row.eligible).length;
  const blocksPerHistory = Math.min(
    3,
    Math.floor((128 - directCount) / Math.max(1, histories.length)),
  );
  if (
    blocksPerHistory < 1 ||
    histories.length > 64 ||
    histories.reduce((sum, history) => sum + history.coordinate.length, 0) >
      32768
  )
    throw new Error(
      "Joint fit requires a larger bounded history reduction batch",
    );
  const duration = Math.max(
    1e-12,
    ...histories
      .filter((history) => history.coordinate_kind === "physical_time")
      .map((history) => history.coordinate.at(-1)! - history.informative_start),
  );
  return {
    epoch_id: source.epochId,
    lease_token: lease.token,
    prior: {
      target_signature: source.targetId,
      prediction_id: source.predictionId,
      branch: source.physical.branch,
      alpha,
      coefficients,
      standard_deviation: coefficients.map((row) => [
        ASSUMPTIONS.priorLiftStd,
        Math.max(
          ASSUMPTIONS.priorDragStdFloor,
          row[1] * ASSUMPTIONS.priorDragRelativeStd,
        ),
        ASSUMPTIONS.priorMomentStd,
      ]),
      provenance: {
        model: source.prediction.model,
        geometry_fit: source.prediction.geometry_fit,
        geometry_provenance: source.prediction.geometry_provenance,
      },
    },
    observations,
    histories,
    history_policy: histories.length
      ? {
          block_duration: duration / blocksPerHistory,
          minimum_samples: 4,
          maximum_blocks: blocksPerHistory,
          noise_floor: ASSUMPTIONS.historyNoiseFloor,
        }
      : null,
    policy: { ...ASSUMPTIONS.model, policy_id: PROGRESSIVE_FIT_POLICY_ID },
  };
}

export async function runProgressiveFitBatch(
  db: DB,
  engine: Pick<EngineClient, "fitProgressivePolar">,
  owner: string,
  options: { requireSweeperEnabled?: boolean } = {},
): Promise<{ claimed: number; stored: number; errors: string[] }> {
  const lease = await claimProgressivePolarFit(db, {
    owner,
    leaseSeconds: 180,
    requireCfdEvidence: true,
    requireSweeperEnabled: options.requireSweeperEnabled ?? true,
  });
  if (!lease) return { claimed: 0, stored: 0, errors: [] };
  try {
    const request = buildProgressiveFitRequest(lease);
    const response = await engine.fitProgressivePolar(request, {
      timeoutMs: 120_000,
    });
    await storeProgressivePolarFit(db, lease, request, response);
    return { claimed: 1, stored: 1, errors: [] };
  } catch (error) {
    await failProgressivePolarFit(db, lease, String(error));
    return { claimed: 1, stored: 0, errors: [String(error)] };
  }
}
