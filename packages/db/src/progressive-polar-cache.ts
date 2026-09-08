import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type {
  ProgressivePolarFitRequest,
  ProgressivePolarFitResponse,
  ProgressivePolarObservation,
} from "../../engine-client/src/progressive-polar";
import {
  analysisContentHash,
  canonicalAnalysisJson,
  type AnalysisPhysical,
} from "./analysis-target";
import type { DB } from "./client";

export interface ProgressiveFitEvidence {
  attemptToken: string;
  resultAttemptId: string;
  resultId: string;
  lineageId: string;
  alpha: number;
  stage: 2 | 3;
  signature: string;
  payload: Record<string, unknown>;
  classification: { state: string; reasons: string[]; version: string } | null;
  review: { id: string; verdict: string } | null;
  interpretation: {
    id: string;
    state: string;
    regime: string;
    signature: string;
    window: Record<string, unknown>;
    maxIatSeconds: number | null;
  } | null;
  createdAt: string;
}

export interface ProgressiveFitSource {
  predictionId: string;
  targetId: string;
  epochId: string;
  physical: AnalysisPhysical;
  prediction: Record<string, unknown>;
  evidence: ProgressiveFitEvidence[];
  signature: string;
}

export interface ProgressiveFitLease {
  predictionId: string;
  sourceVersion: number;
  token: string;
  owner: string;
  source: ProgressiveFitSource;
}

class ProgressiveFitSourceError extends Error {}

async function sourceForPrediction(
  db: DB,
  predictionId: string,
): Promise<ProgressiveFitSource> {
  const [prediction] = await db.execute(sql`
    SELECT prediction.target_id, prediction.epoch_id, prediction.payload, target.physical
    FROM neuralfoil_predictions prediction JOIN polar_analysis_targets target ON target.id = prediction.target_id
    JOIN calculation_epochs epoch ON epoch.id = prediction.epoch_id AND epoch.current
    WHERE prediction.id = ${predictionId}
  `);
  if (!prediction)
    throw new ProgressiveFitSourceError(
      "Progressive fit has no current prediction source",
    );
  const records = await db.execute(sql`
    SELECT receipt.attempt_token, receipt.result_attempt_id, receipt.evidence_signature,
      unit.id AS lineage_id, unit.aoa_deg, work.stage, result_attempt.result_id, result_attempt.evidence_payload,
      result_attempt."createdAt" AS evidence_created_at,
      CASE WHEN classification.id IS NOT NULL THEN jsonb_build_object('state', classification.state,
        'reasons', classification.reasons, 'version', classification.classifier_version) END AS classification,
      review.payload AS review, interpretation.payload AS interpretation
    FROM progressive_cfd_evidence receipt JOIN progressive_cfd_attempts attempt ON attempt.token = receipt.attempt_token
    JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id JOIN progressive_work work ON work.id = unit.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    JOIN result_attempts result_attempt ON result_attempt.id = receipt.result_attempt_id
    LEFT JOIN result_classifications classification ON classification.result_attempt_id = result_attempt.id
    LEFT JOIN LATERAL (SELECT jsonb_build_object('id', verdict.id, 'verdict', verdict.verdict) AS payload
      FROM result_review_verdicts verdict WHERE verdict.result_id = result_attempt.result_id AND verdict."revokedAt" IS NULL
      ORDER BY verdict."createdAt" DESC, verdict.id DESC LIMIT 1) review ON true
    LEFT JOIN LATERAL (SELECT jsonb_build_object('id', interpretation.id, 'state', interpretation.state,
      'regime', interpretation.regime, 'signature', interpretation.input_evidence_signature,
      'window', interpretation.selected_window, 'maxIatSeconds', interpretation.max_iat_seconds) AS payload
      FROM result_interpretations interpretation WHERE interpretation.result_attempt_id = result_attempt.id
      ORDER BY interpretation."createdAt" DESC, interpretation.id DESC LIMIT 1) interpretation ON true
    WHERE work.target_id = ${prediction.target_id} AND generation.epoch_id = ${prediction.epoch_id}
    ORDER BY receipt.result_attempt_id LIMIT 257
  `);
  if (records.length > 256)
    throw new ProgressiveFitSourceError(
      "Progressive fit source exceeds its bounded evidence batch",
    );
  const evidence = records.map((row): ProgressiveFitEvidence => {
    const payload = row.evidence_payload as Record<string, unknown>;
    if (
      !row.result_id ||
      analysisContentHash(payload) !== row.evidence_signature
    )
      throw new ProgressiveFitSourceError(
        "Progressive fit source differs from its immutable evidence receipt",
      );
    return {
      attemptToken: String(row.attempt_token),
      resultAttemptId: String(row.result_attempt_id),
      resultId: String(row.result_id),
      lineageId: String(row.lineage_id),
      alpha: Number(row.aoa_deg),
      stage: Number(row.stage) as 2 | 3,
      signature: String(row.evidence_signature),
      payload,
      classification:
        row.classification as ProgressiveFitEvidence["classification"],
      review: row.review as ProgressiveFitEvidence["review"],
      interpretation:
        row.interpretation as ProgressiveFitEvidence["interpretation"],
      createdAt:
        row.evidence_created_at instanceof Date
          ? row.evidence_created_at.toISOString()
          : new Date(String(row.evidence_created_at)).toISOString(),
    };
  });
  const source = {
    predictionId,
    targetId: String(prediction.target_id),
    epochId: String(prediction.epoch_id),
    physical: prediction.physical as AnalysisPhysical,
    prediction: prediction.payload as Record<string, unknown>,
    evidence,
  };
  return {
    ...source,
    signature: analysisContentHash({
      predictionId,
      evidence: evidence.map(({ payload, ...identity }) => identity),
    }),
  };
}

export async function invalidateProgressiveFitPolicy(
  db: DB,
  policyId: string,
): Promise<number> {
  if (!policyId.trim())
    throw new Error("A fit policy must have a stable identity");
  const updated = await db.execute(sql`
    UPDATE progressive_polar_fit_work work SET source_version = work.source_version + 1,
      state = 'pending', lease_token = NULL, lease_owner = NULL, lease_until = NULL,
      model_id = NULL, attempts = 0, error = NULL, updated_at = clock_timestamp()
    FROM progressive_polar_models model, neuralfoil_predictions prediction, calculation_epochs epoch
    WHERE work.model_id = model.id AND prediction.id = work.prediction_id
      AND epoch.id = prediction.epoch_id AND epoch.current AND work.state = 'ready'
      AND model.response->'estimate'->>'policy_id' IS DISTINCT FROM ${policyId}
    RETURNING work.prediction_id
  `);
  return updated.length;
}

export async function claimProgressivePolarFit(
  db: DB,
  input: {
    owner: string;
    leaseSeconds: number;
    predictionId?: string;
    requireCfdEvidence?: boolean;
    requireSweeperEnabled?: boolean;
  },
): Promise<ProgressiveFitLease | null> {
  if (
    !input.owner.trim() ||
    !Number.isInteger(input.leaseSeconds) ||
    input.leaseSeconds < 10 ||
    input.leaseSeconds > 3600
  )
    throw new Error("Invalid bounded progressive fit lease");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
    const [work] = await connection.execute(sql`
      SELECT work.prediction_id, work.source_version, work.attempts FROM progressive_polar_fit_work work
      JOIN neuralfoil_predictions prediction ON prediction.id = work.prediction_id
      WHERE prediction.epoch_id = ${epoch.id}
        AND (NOT ${input.requireSweeperEnabled ?? false} OR (
          EXISTS (SELECT 1 FROM sweeper_state WHERE id = 1 AND enabled)
          AND NOT EXISTS (SELECT 1 FROM sync_api_settings WHERE remote_solver_enabled)))
        AND ${input.predictionId ? sql`prediction.id = ${input.predictionId}` : sql`true`}
        AND ${
          input.requireCfdEvidence
            ? sql`EXISTS (SELECT 1 FROM progressive_cfd_evidence receipt
          JOIN progressive_cfd_attempts attempt ON attempt.token = receipt.attempt_token
          JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id JOIN progressive_work source_work ON source_work.id = unit.work_id
          JOIN progressive_generations generation ON generation.id = source_work.generation_id
          WHERE source_work.target_id = prediction.target_id AND generation.epoch_id = prediction.epoch_id)`
            : sql`true`
        }
        AND EXISTS (SELECT 1 FROM progressive_generation_targets scope JOIN progressive_generations generation ON generation.id = scope.generation_id
          WHERE scope.target_id = prediction.target_id AND generation.epoch_id = prediction.epoch_id)
        AND (work.state = 'pending' OR (work.state = 'leased' AND work.lease_until <= clock_timestamp()))
      ORDER BY work.updated_at, work.prediction_id LIMIT 1 FOR UPDATE OF work SKIP LOCKED
    `);
    if (!work) return null;
    if (Number(work.attempts) >= 3) {
      await connection.execute(sql`
        UPDATE progressive_polar_fit_work SET state = 'gap', error = 'bounded fit delivery attempts exhausted',
          lease_token = NULL, lease_owner = NULL, lease_until = NULL WHERE prediction_id = ${work.prediction_id}
      `);
      return null;
    }
    let source: ProgressiveFitSource;
    try {
      source = await sourceForPrediction(
        connection,
        String(work.prediction_id),
      );
    } catch (error) {
      if (!(error instanceof ProgressiveFitSourceError)) throw error;
      await connection.execute(sql`
        UPDATE progressive_polar_fit_work SET state = 'gap', error = ${error.message},
          lease_token = NULL, lease_owner = NULL, lease_until = NULL WHERE prediction_id = ${work.prediction_id}
      `);
      return null;
    }
    const token = randomUUID();
    await connection.execute(sql`
      UPDATE progressive_polar_fit_work SET state = 'leased', lease_token = ${token}, lease_owner = ${input.owner},
        lease_until = clock_timestamp() + ${input.leaseSeconds} * interval '1 second', attempts = attempts + 1,
        error = NULL WHERE prediction_id = ${work.prediction_id}
    `);
    return {
      predictionId: source.predictionId,
      sourceVersion: Number(work.source_version),
      token,
      owner: input.owner,
      source,
    };
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalAnalysisJson(left) === canonicalAnalysisJson(right);
}

function exactObservation(
  source: ProgressiveFitSource,
  observation: ProgressivePolarObservation,
): ProgressiveFitEvidence {
  const row = source.evidence.find(
    (item) => item.resultAttemptId === observation.attempt_id,
  );
  if (
    !row ||
    observation.result_id !== row.resultId ||
    observation.lineage_id !== row.lineageId ||
    observation.target_signature !== source.targetId ||
    observation.branch !== source.physical.branch ||
    observation.alpha !== row.alpha ||
    observation.method !==
      (row.stage === 2 ? "openfoam_fast" : "openfoam_precise")
  )
    throw new Error(
      "Polar observation differs from its exact physical evidence source",
    );
  if (
    observation.eligible &&
    (observation.exclusion_reason ||
      ["exclude", "defer"].includes(row.review?.verdict ?? "") ||
      row.classification?.state === "superseded_by_urans" ||
      row.classification?.reasons.some((reason) =>
        ["non-physical-coefficients", "non-positive-drag"].includes(reason),
      ) ||
      ["infrastructure", "deterministic_mesh", "material_domain"].includes(
        String(row.payload.failure_disposition),
      ) ||
      (observation.numerical_convergence === "converged" &&
        row.payload.converged !== true))
  )
    throw new Error("Polar observation overstates its evidence eligibility");
  return row;
}

function validateFitInput(
  source: ProgressiveFitSource,
  request: ProgressivePolarFitRequest,
) {
  const accounted = new Set([
    ...request.observations.map((row) => row.attempt_id),
    ...request.histories.map((row) => row.observation.attempt_id),
  ]);
  if (source.evidence.some((row) => !accounted.has(row.resultAttemptId)))
    throw new Error(
      "Polar fit must account for every source attempt or explain its exclusion",
    );
  if (
    request.prior.prediction_id !== source.predictionId ||
    request.prior.target_signature !== source.targetId ||
    request.prior.branch !== source.physical.branch ||
    !sameJson(request.prior.alpha, source.prediction.alpha) ||
    !sameJson(request.prior.coefficients, source.prediction.coefficients) ||
    !sameJson(request.prior.provenance, {
      model: source.prediction.model,
      geometry_fit: source.prediction.geometry_fit,
      geometry_provenance: source.prediction.geometry_provenance,
    })
  )
    throw new Error(
      "Polar fit prior differs from the stored NeuralFoil prediction",
    );
  for (const observation of request.observations) {
    const evidence = exactObservation(source, observation);
    if (
      observation.eligible &&
      !sameJson(observation.coefficients, [
        evidence.payload.cl,
        evidence.payload.cd,
        evidence.payload.cm,
      ])
    )
      throw new Error(
        "Polar point values differ from their immutable evidence",
      );
  }
  for (const history of request.histories) {
    const evidence = exactObservation(source, history.observation);
    if (
      history.correlation_time !== null &&
      (history.correlation_time !== evidence.interpretation?.maxIatSeconds ||
        history.correlation_evidence_id !== evidence.interpretation.id)
    )
      throw new Error(
        "History correlation time has no matching stored interpretation evidence",
      );
    const payload = evidence.payload[
      history.coordinate_kind === "physical_time"
        ? "force_history"
        : "steady_history"
    ] as Record<string, unknown> | null;
    const coordinate =
      payload?.[
        history.coordinate_kind === "physical_time" ? "t" : "iterations"
      ];
    const channels = [payload?.cl, payload?.cd, payload?.cm];
    if (
      !payload ||
      !Array.isArray(coordinate) ||
      channels.some(
        (channel) =>
          !Array.isArray(channel) || channel.length !== coordinate.length,
      )
    )
      throw new Error("Polar history has no exact stored coefficient samples");
    const coefficients = coordinate.map((_, index) =>
      channels.map((channel) => (channel as number[])[index]),
    );
    if (
      history.artifact_sha256 !== analysisContentHash(payload) ||
      !sameJson(history.coordinate, coordinate) ||
      !sameJson(history.coefficients, coefficients)
    )
      throw new Error(
        "Polar history samples differ from their immutable source",
      );
  }
}

function validateFitOutput(
  request: ProgressivePolarFitRequest,
  response: ProgressivePolarFitResponse,
) {
  const estimate = response.estimate;
  if (
    response.epoch_id !== request.epoch_id ||
    response.lease_token !== request.lease_token ||
    !/^[a-f0-9]{64}$/.test(response.request_signature) ||
    !/^[a-f0-9]{64}$/.test(estimate.signature) ||
    estimate.version !== "progressive-polar-gp-v2" ||
    estimate.kind !== "estimate" ||
    estimate.target_signature !== request.prior.target_signature ||
    estimate.branch !== request.prior.branch ||
    estimate.prior_prediction_id !== request.prior.prediction_id ||
    estimate.policy_id !== request.policy.policy_id ||
    estimate.calibration_status !== request.policy.calibration_status ||
    estimate.validation_id !== (request.policy.validation_id ?? null) ||
    !sameJson(estimate.alpha, request.prior.alpha) ||
    estimate.interval.interpretation !== "conditional_model_uncertainty" ||
    estimate.interval.probability !== 0.95
  )
    throw new Error("Fitted polar response differs from its exact request");
  const observationIds = new Set<string>();
  const observedAngles = new Set<number>();
  for (const contributor of estimate.contributors) {
    if (observationIds.has(contributor.observation_id))
      throw new Error("Fitted polar contains duplicate contributors");
    observationIds.add(contributor.observation_id);
    const direct = request.observations.find(
      (row) => row.observation_id === contributor.observation_id,
    );
    const history = request.histories.find(
      (row) =>
        row.observation.attempt_id === contributor.attempt_id &&
        row.observation.method === contributor.method &&
        (row.coordinate_kind === "iteration"
          ? contributor.window == null
          : contributor.window &&
            contributor.window[0] >= row.informative_start &&
            contributor.window[1] > contributor.window[0] &&
            row.coordinate.includes(contributor.window[0]) &&
            row.coordinate.includes(contributor.window[1])),
    );
    const original = direct ?? history?.observation;
    if (
      !original?.eligible ||
      original.result_id !== contributor.result_id ||
      original.attempt_id !== contributor.attempt_id ||
      original.method !== contributor.method ||
      original.numerical_convergence !== contributor.numerical_convergence ||
      contributor.statistical_certification !==
        (history?.coordinate_kind === "iteration"
          ? "numerical_iterations_only"
          : original.statistical_certification)
    )
      throw new Error("Fitted polar contributor has no exact eligible source");
    observedAngles.add(original.alpha);
  }
  const acquisition = estimate.acquisition;
  const hasEvidence = estimate.contributors.length > 0;
  if (
    !acquisition ||
    acquisition.version !== "fixed-posterior-coverage-v1" ||
    acquisition.method !== "openfoam_fast" ||
    acquisition.noise_assumption !==
      "policy_floor_or_median_fast_observation" ||
    acquisition.status !== (hasEvidence ? "available" : "no_eligible_cfd") ||
    !Array.isArray(acquisition.candidates) ||
    !sameJson(
      acquisition.candidates.map((candidate) => candidate.alpha),
      hasEvidence
        ? estimate.alpha.filter((alpha) => !observedAngles.has(alpha))
        : [],
    ) ||
    (hasEvidence
      ? !Array.isArray(acquisition.prospective_noise_std) ||
        acquisition.prospective_noise_std.length !== 3 ||
        acquisition.prospective_noise_std.some(
          (value, index) =>
            !Number.isFinite(value) ||
            value < request.policy.fast_noise_floor[index],
        )
      : acquisition.prospective_noise_std !== null)
  )
    throw new Error(
      "Fitted polar has an incompatible acquisition scope or noise policy",
    );
  for (const candidate of acquisition.candidates) {
    const parts = [
      candidate.covariance_reduction_fraction,
      candidate.coverage_reduction_fraction,
    ];
    if (
      parts.some(
        (part) =>
          !Array.isArray(part) ||
          part.length !== 3 ||
          part.some(
            (value) => !Number.isFinite(value) || value < 0 || value > 1,
          ),
      ) ||
      !Number.isFinite(candidate.integrated_variance_reduction_fraction)
    )
      throw new Error(
        "Fitted polar has invalid acquisition uncertainty reductions",
      );
    const sums = parts[0].map((value, index) => value + parts[1][index]);
    if (
      sums.some((value) => value > 1 + 1e-8) ||
      Math.abs(
        candidate.integrated_variance_reduction_fraction -
          sums.reduce((total, value) => total + value, 0) / 3,
      ) > 1e-8
    )
      throw new Error(
        "Acquisition score does not match its whole-curve components",
      );
  }
  const methods = new Set(estimate.contributors.map((row) => row.method));
  const best = methods.has("openfoam_precise")
    ? "openfoam_precise"
    : methods.has("openfoam_fast")
      ? "openfoam_fast"
      : "neuralfoil";
  if (
    estimate.best_method !== best ||
    !estimate.curves.composite ||
    !sameJson(
      Object.keys(estimate.curves).sort(),
      ["composite", ...methods].sort(),
    )
  )
    throw new Error("Fitted polar overstates its contributing methods");
  for (const curve of Object.values(estimate.curves)) {
    for (const matrix of [curve.coefficients, curve.lower, curve.upper]) {
      if (
        matrix.length !== estimate.alpha.length ||
        matrix.some(
          (row) =>
            row.length !== 3 || !row.every(Number.isFinite) || row[1] <= 0,
        )
      )
        throw new Error(
          "Fitted polar contains invalid coefficients or uncertainty bounds",
        );
    }
    if (
      curve.coefficients.some((row, angle) =>
        row.some(
          (value, channel) =>
            curve.lower[angle][channel] > value ||
            curve.upper[angle][channel] < value,
        ),
      )
    )
      throw new Error(
        "Fitted polar uncertainty does not contain its central curve",
      );
  }
}

export async function storeProgressivePolarFit(
  db: DB,
  lease: ProgressiveFitLease,
  request: ProgressivePolarFitRequest,
  response: ProgressivePolarFitResponse,
): Promise<string> {
  if (
    request.epoch_id !== lease.source.epochId ||
    request.lease_token !== lease.token
  )
    throw new Error("Fitted polar delivery changed its lease identity");
  validateFitInput(lease.source, request);
  validateFitOutput(request, response);
  const id = analysisContentHash({
    source: lease.source.signature,
    request,
    response,
  });
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (epoch?.id !== lease.source.epochId)
      throw new Error("Obsolete fitted polar calculation epoch");
    const [work] = await connection.execute(sql`
      SELECT *, lease_until > clock_timestamp() AS lease_live FROM progressive_polar_fit_work WHERE prediction_id = ${lease.predictionId} FOR UPDATE
    `);
    if (work?.state === "ready" && work.model_id === id) return id;
    if (
      !work ||
      work.state !== "leased" ||
      work.lease_token !== lease.token ||
      work.lease_owner !== lease.owner ||
      Number(work.source_version) !== lease.sourceVersion ||
      !work.lease_live
    )
      throw new Error("Obsolete or expired fitted polar lease");
    const current = await sourceForPrediction(connection, lease.predictionId);
    if (current.signature !== lease.source.signature)
      throw new Error("Fitted polar evidence changed during calculation");
    validateFitInput(current, request);
    const manifest = {
      kind: "progressive-fit-replay-manifest-v1",
      ...request,
      histories: request.histories.map(
        ({ coordinate, coefficients, ...history }) => ({
          ...history,
          sample_count: coordinate.length,
        }),
      ),
    };
    await connection.execute(sql`
      INSERT INTO progressive_polar_models(id, prediction_id, source_signature, request, response)
      VALUES (${id}, ${lease.predictionId}, ${current.signature}, ${canonicalAnalysisJson(manifest)}::jsonb, ${canonicalAnalysisJson(response)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);
    for (const evidence of current.evidence) {
      await connection.execute(sql`
        INSERT INTO progressive_polar_model_evidence(model_id, attempt_token, result_attempt_id)
        VALUES (${id}, ${evidence.attemptToken}, ${evidence.resultAttemptId}) ON CONFLICT DO NOTHING
      `);
    }
    await connection.execute(sql`
      UPDATE progressive_polar_fit_work SET state = 'ready', model_id = ${id}, error = NULL,
        lease_token = NULL, lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
      WHERE prediction_id = ${lease.predictionId}
    `);
    return id;
  });
}

export async function failProgressivePolarFit(
  db: DB,
  lease: ProgressiveFitLease,
  error: string,
): Promise<boolean> {
  const changed = await db.execute(sql`
    UPDATE progressive_polar_fit_work SET state = CASE WHEN attempts < 3 THEN 'pending' ELSE 'gap' END,
      error = ${error.slice(0, 4000)}, lease_token = NULL, lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
    WHERE prediction_id = ${lease.predictionId} AND state = 'leased' AND lease_token = ${lease.token}
      AND lease_owner = ${lease.owner} AND source_version = ${lease.sourceVersion}
    RETURNING prediction_id
  `);
  return changed.length > 0;
}
