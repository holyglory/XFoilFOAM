import { sql } from "drizzle-orm";
import { assertProgressiveExecutionIdentity } from "./progressive-execution-identity";
import type { EngineExecutionStopProof } from "../../engine-client/src/types";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import type { DB } from "./client";
import { progressiveCfdOrdinaryAttemptCountSql } from "./progressive-attempt-budget";

export function validateProgressiveExecutionStopProof(
  proof: EngineExecutionStopProof,
): void {
  if (
    !proof ||
    proof.version !== 1 ||
    typeof proof.job_id !== "string" ||
    !proof.job_id ||
    proof.execution_stopped !== true ||
    proof.producer_stopped !== true ||
    proof.namespace_verified !== true ||
    !Array.isArray(proof.remaining) ||
    proof.remaining.length !== 0 ||
    proof.error !== null ||
    !["cancel_marker", "terminal_result"].includes(proof.fence ?? "") ||
    (proof.ownership_basis != null &&
      ![
        "recorded_execution_namespace",
        "never_started_cancellation_fence",
      ].includes(proof.ownership_basis)) ||
    (proof.ownership_basis === "never_started_cancellation_fence" &&
      proof.fence !== "cancel_marker") ||
    typeof proof.observed_at !== "string" ||
    !Number.isFinite(Date.parse(proof.observed_at))
  ) {
    throw new Error(
      "Progressive CFD settlement requires an exact verified execution-stop proof",
    );
  }
}

export async function acknowledgeProgressiveCfdExecutionStop(
  db: DB,
  input: { simJobId: string; proof: EngineExecutionStopProof },
): Promise<{ epochId: string; replayed: boolean }> {
  validateProgressiveExecutionStopProof(input.proof);
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [job] = await connection.execute(sql`
      SELECT campaign_id, engine_job_id, request_payload, request_payload->'progressive' AS progressive FROM sim_jobs WHERE id = ${input.simJobId}
    `);
    const metadata = job?.progressive as Record<string, unknown> | null;
    if (!metadata || job.engine_job_id !== input.proof.job_id)
      throw new Error(
        "Execution-stop proof does not belong to this progressive engine job",
      );
    assertProgressiveExecutionIdentity(
      input.simJobId,
      input.proof.job_id,
      job.request_payload,
    );
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE id = ${String(metadata.epochId)} FOR SHARE`,
    );
    if (!epoch)
      throw new Error("Execution-stop proof has no calculation epoch");
    const [campaign] = await connection.execute(
      sql`SELECT id FROM sim_campaigns WHERE id = ${job.campaign_id} FOR UPDATE`,
    );
    if (!campaign)
      throw new Error("Execution-stop proof has no campaign ownership");
    const units = await connection.execute(sql`
      SELECT attempt.token, attempt.execution_recipe_id, generation.id AS generation_id, generation.epoch_id,
        generation.campaign_id, work.target_id, work.stage
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      WHERE attempt.sim_job_id = ${input.simJobId}
      ORDER BY unit.ordinal, unit.id FOR UPDATE OF generation, work, unit, attempt
    `);
    const tokens = metadata.tokens;
    if (
      !units.length ||
      !Array.isArray(tokens) ||
      tokens.length !== units.length ||
      new Set(tokens).size !== units.length ||
      units.some(
        (unit) =>
          unit.generation_id !== metadata.generationId ||
          unit.epoch_id !== epoch.id ||
          unit.campaign_id !== campaign.id ||
          unit.target_id !== metadata.targetId ||
          unit.stage !== metadata.stage ||
          unit.execution_recipe_id !== metadata.recipeId ||
          !tokens.includes(unit.token),
      )
    )
      throw new Error(
        "Execution-stop proof differs from its immutable progressive unit scope",
      );
    const [lockedJob] = await connection.execute(sql`
      SELECT engine_job_id, request_payload->'progressive' AS progressive FROM sim_jobs WHERE id = ${input.simJobId} FOR UPDATE
    `);
    if (
      !lockedJob ||
      lockedJob.engine_job_id !== input.proof.job_id ||
      analysisContentHash(lockedJob.progressive) !==
        analysisContentHash(metadata)
    )
      throw new Error(
        "Progressive execution ownership changed while acknowledging its stop",
      );
    if (input.proof.ownership_basis === "never_started_cancellation_fence") {
      const [evidence] = await connection.execute(sql`
        SELECT EXISTS (SELECT 1 FROM result_attempts WHERE sim_job_id = ${input.simJobId})
          OR EXISTS (SELECT 1 FROM progressive_cfd_runtime_progress runtime JOIN progressive_cfd_attempts attempt
            ON attempt.token = runtime.attempt_token WHERE attempt.sim_job_id = ${input.simJobId} AND runtime.active_seconds > 0) AS present
      `);
      if (evidence?.present)
        throw new Error(
          "Never-started execution proof conflicts with stored solver attempts",
        );
    }
    const [existing] = await connection.execute(
      sql`SELECT engine_job_id, epoch_id FROM progressive_cfd_execution_stops WHERE sim_job_id = ${input.simJobId}`,
    );
    if (existing) {
      if (
        existing.engine_job_id !== input.proof.job_id ||
        existing.epoch_id !== epoch.id
      )
        throw new Error(
          "Execution-stop acknowledgement conflicts with its original ownership",
        );
      return { epochId: String(epoch.id), replayed: true };
    }
    await connection.execute(sql`
      INSERT INTO progressive_cfd_execution_stops(sim_job_id, engine_job_id, epoch_id, proof, proof_signature, observed_at)
      VALUES (${input.simJobId}, ${input.proof.job_id}, ${epoch.id}, ${canonicalAnalysisJson(input.proof)}::jsonb,
        ${analysisContentHash(input.proof)}, ${new Date(input.proof.observed_at).toISOString()}::timestamptz)
    `);
    return { epochId: String(epoch.id), replayed: false };
  });
}

export async function settleProgressiveCfdExecution(
  db: DB,
  simJobId: string,
): Promise<{
  complete: number;
  retry: number;
  gaps: number;
  cancelled: number;
  waiting: number;
}> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const counts = { complete: 0, retry: 0, gaps: 0, cancelled: 0, waiting: 0 };
    const [stop] = await connection.execute(
      sql`SELECT proof FROM progressive_cfd_execution_stops WHERE sim_job_id = ${simJobId}`,
    );
    if (!stop)
      throw new Error(
        "Progressive CFD execution has no persisted stop acknowledgement",
      );
    await acknowledgeProgressiveCfdExecutionStop(connection, {
      simJobId,
      proof: stop.proof as EngineExecutionStopProof,
    });
    const [job] = await connection.execute(
      sql`SELECT status, "ingestedAt" FROM sim_jobs WHERE id = ${simJobId}`,
    );
    if (!job || !["done", "failed", "cancelled"].includes(String(job.status)))
      return { ...counts, waiting: 1 };
    if (!job.ingestedAt) {
      const [current] = await connection.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
          JOIN progressive_work work ON work.id = unit.work_id
          JOIN progressive_generations generation ON generation.id = work.generation_id
          JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id
          JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
          WHERE attempt.sim_job_id = ${simJobId} AND attempt.outcome = 'running' AND epoch.current
            AND generation.status = 'active' AND generation.plan_revision_id = campaign.current_plan_revision_id
            AND campaign.status IN ('active', 'attention', 'paused')
        ) AS value
      `);
      if (current?.value) return { ...counts, waiting: 1 };
    }
    const sources = await connection.execute(sql`
      SELECT receipt.evidence_signature, raw.evidence_payload FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_evidence receipt ON receipt.attempt_token = attempt.token
      JOIN result_attempts raw ON raw.id = receipt.result_attempt_id WHERE attempt.sim_job_id = ${simJobId} LIMIT 2049
    `);
    if (
      sources.length > 2048 ||
      sources.some(
        (source) =>
          analysisContentHash(source.evidence_payload) !==
          source.evidence_signature,
      )
    )
      throw new Error(
        "Progressive CFD settlement has changed or unbounded receipt evidence",
      );
    const units = await connection.execute(sql`
      SELECT attempt.token, attempt.outcome, unit.id, unit.state, unit.attempts, unit.active_seconds, unit.active_budget_seconds,
        ${progressiveCfdOrdinaryAttemptCountSql()} AS ordinary_attempts,
        work.stage, epoch.current AND generation.status = 'active' AND generation.plan_revision_id = campaign.current_plan_revision_id
          AND campaign.status IN ('active', 'attention', 'paused') AS current_scope,
        evidence.count, evidence.accepted, evidence.infrastructure_only, fitted.state AS fit_state,
        EXISTS (SELECT 1 FROM progressive_cfd_recovery_plans recovery
          WHERE recovery.unit_id = unit.id AND recovery.parent_attempt_token = attempt.token) AS numerical_recovery,
        EXISTS (SELECT 1 FROM progressive_cfd_recovery_plans recovery
          WHERE recovery.unit_id = unit.id AND recovery.parent_attempt_token = attempt.token AND recovery.ordinal = 2) AS precise_verification,
        EXISTS (SELECT 1 FROM progressive_cfd_evidence receipt,
          jsonb_array_elements(coalesce(fitted.response->'estimate'->'contributors', '[]'::jsonb)) contributor
          WHERE receipt.attempt_token = attempt.token AND receipt.result_attempt_id::text = contributor->>'attempt_id') AS informative
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS count,
          coalesce(bool_or(raw.status = 'done' AND raw.valid_for_polar AND classification.state = 'accepted'
            AND (work.stage = 2 OR raw.regime = 'rans' OR raw.evidence_payload->>'fidelity' = 'urans_full')
            AND coalesce((SELECT review.verdict FROM result_review_verdicts review WHERE review.result_id = raw.result_id
              AND review."revokedAt" IS NULL ORDER BY review."createdAt" DESC, review.id DESC LIMIT 1), '') NOT IN ('exclude', 'defer')), false) AS accepted,
          coalesce(bool_and(coalesce(raw.evidence_payload->>'failure_disposition', '') = 'infrastructure'), false) AS infrastructure_only
        FROM progressive_cfd_evidence receipt JOIN result_attempts raw ON raw.id = receipt.result_attempt_id
        LEFT JOIN result_classifications classification ON classification.result_attempt_id = raw.id
        WHERE receipt.attempt_token = attempt.token
      ) evidence ON true
      LEFT JOIN LATERAL (
        SELECT fit.state, model.response FROM neuralfoil_predictions prediction
        JOIN progressive_polar_fit_work fit ON fit.prediction_id = prediction.id
        LEFT JOIN progressive_polar_models model ON model.id = fit.model_id AND fit.state = 'ready'
        WHERE prediction.target_id = work.target_id AND prediction.epoch_id = generation.epoch_id
        ORDER BY prediction.created_at DESC, prediction.id DESC LIMIT 1
      ) fitted ON true
      WHERE attempt.sim_job_id = ${simJobId} ORDER BY unit.ordinal, unit.id
    `);
    for (const unit of units) {
      if (unit.outcome !== "running") continue;
      if (!unit.current_scope || unit.state === "cancelled") {
        await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome = 'cancelled', finished_at = clock_timestamp(),
          error = 'obsolete execution physically stopped' WHERE token = ${unit.token}`);
        await connection.execute(sql`UPDATE progressive_cfd_units SET state = 'cancelled', lease_token = NULL, lease_owner = NULL,
          lease_until = NULL, error = 'obsolete execution physically stopped' WHERE id = ${unit.id}`);
        counts.cancelled += 1;
        continue;
      }
      if (!["leased", "blocked"].includes(String(unit.state)))
        throw new Error(
          "Progressive CFD settlement has no exclusive current unit ownership",
        );
      const complete =
        unit.numerical_recovery !== true &&
        (unit.accepted === true ||
          (unit.stage === 2 && unit.informative === true));
      if (
        !complete &&
        unit.numerical_recovery !== true &&
        unit.stage === 2 &&
        Number(unit.count) > 0 &&
        ["pending", "leased"].includes(String(unit.fit_state))
      ) {
        counts.waiting += 1;
        continue;
      }
      const exhausted =
        Number(unit.active_seconds) >= Number(unit.active_budget_seconds);
      const neverStarted =
        (stop.proof as EngineExecutionStopProof).ownership_basis ===
          "never_started_cancellation_fence" &&
        Number(unit.count) === 0 &&
        Number(unit.active_seconds) === 0;
      const retry =
        !complete &&
        !exhausted &&
        (Number(unit.ordinary_attempts) < 2 ||
          (Number(unit.ordinary_attempts) === 2 &&
            unit.stage === 3 &&
            unit.precise_verification === true)) &&
        (unit.numerical_recovery === true ||
          neverStarted ||
          (Number(unit.count) > 0 && unit.infrastructure_only === true));
      const reason = complete
        ? null
        : retry
          ? unit.numerical_recovery === true
            ? unit.precise_verification === true
              ? "accepted preliminary URANS; bounded precise verification admitted"
              : "stored RANS diagnosis; bounded immutable URANS recovery admitted"
            : neverStarted
              ? "engine proved submission never started; bounded retry admitted"
              : "diagnosed infrastructure failure; bounded retry admitted"
          : exhausted
            ? "active compute budget exhausted"
            : Number(unit.count) === 0
              ? "terminal execution has no measured case evidence"
              : unit.stage === 3
                ? "precise evidence remains unresolved"
                : "fast pass has no informative accepted evidence";
      await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome = ${complete ? "complete" : neverStarted ? "cancelled" : "failed"},
        finished_at = clock_timestamp(), error = ${reason} WHERE token = ${unit.token}`);
      await connection.execute(sql`UPDATE progressive_cfd_units SET state = ${complete ? "complete" : retry ? "pending" : "gap"},
        lease_token = NULL, lease_owner = NULL, lease_until = NULL, error = ${reason} WHERE id = ${unit.id}`);
      if (complete) counts.complete += 1;
      else if (retry) counts.retry += 1;
      else counts.gaps += 1;
    }
    return counts;
  });
}
