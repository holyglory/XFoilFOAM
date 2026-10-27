import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { effectiveProgressiveStageSql } from "./progressive-execution-policy";
import { PROGRESSIVE_COMPUTE_POLICY } from "@aerodb/core";
import { assertProgressiveExecutionIdentity } from "./progressive-execution-identity";
import type { EngineExecutionStopProof } from "../../engine-client/src/types";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import type { DB } from "./client";
import { SOURCE_GEOMETRY_POLICY_VERSION } from "./progressive-evidence-geometry";
import {
  progressiveCfdNeverStartedAttemptCountSql,
  progressiveCfdOrdinaryAttemptCountSql,
  progressiveCfdPreciseVerificationAvailableSql,
} from "./progressive-attempt-budget";
import {
  admitProgressiveCfdBudgetExtension,
  PROGRESSIVE_FAST_BUDGET_EXTENSION_SECONDS,
  progressiveCfdEffectiveBudgetSql,
} from "./progressive-cfd-budget-extension";

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
  options: {
    recoverNeverStarted?: boolean;
    recoverStoredEvidence?: {
      resultAttemptIds: string[];
      scope: import("./progressive-cfd-evidence").ProgressiveStorageEvidenceRecoveryScope;
    };
  } = {},
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
    if (options.recoverStoredEvidence) {
      const { assertProgressiveStorageEvidenceRecoveryJob } =
        await import("./progressive-cfd-evidence");
      await assertProgressiveStorageEvidenceRecoveryJob(
        connection,
        simJobId,
        options.recoverStoredEvidence.scope,
        options.recoverStoredEvidence.resultAttemptIds,
      );
    }
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
    await connection.execute(sql`UPDATE progressive_cfd_units unit SET state = 'blocked',
        lease_token = NULL, lease_owner = NULL, lease_until = NULL,
        error = 'Physical stop acknowledged after the execution lease expired'
      FROM progressive_cfd_attempts attempt
      WHERE attempt.unit_id = unit.id AND attempt.sim_job_id = ${simJobId}
        AND attempt.outcome = 'running' AND unit.state = 'leased'
        AND unit.lease_token = attempt.token AND unit.lease_until <= clock_timestamp()`);
    const [job] = await connection.execute(
      sql`SELECT status, "ingestedAt" FROM sim_jobs WHERE id = ${simJobId}`,
    );
    if (
      !job ||
      !["done", "failed", "cancelled", "ingesting"].includes(String(job.status))
    )
      return { ...counts, waiting: 1 };
    const storedEvidenceIds = [
      ...new Set(options.recoverStoredEvidence?.resultAttemptIds ?? []),
    ];
    if (storedEvidenceIds.length > 2048)
      throw new Error(
        "Progressive stored-evidence recovery exceeds its bounded case scope",
      );
    const historicalEvidence = storedEvidenceIds.length
      ? sql`EXISTS (SELECT 1 FROM progressive_cfd_evidence historical_evidence
          WHERE historical_evidence.attempt_token = attempt.token
            AND historical_evidence.result_attempt_id IN (${sql.join(
              storedEvidenceIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}))`
      : sql`false`;
    const selectedReceiptScope = options.recoverStoredEvidence
      ? sql`AND receipt.result_attempt_id IN (${sql.join(
          storedEvidenceIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql``;
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
        ) AS value,
        EXISTS (
          SELECT 1 FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
          WHERE attempt.sim_job_id = ${simJobId} AND attempt.outcome = 'running'
            AND unit.state = 'blocked' AND unit.lease_token IS NULL AND unit.lease_until IS NULL
        ) AS stopped_pending,
        NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
          WHERE attempt.sim_job_id = ${simJobId} AND attempt.outcome = 'running'
            AND NOT (unit.state = 'blocked' AND unit.lease_token IS NULL AND unit.lease_until IS NULL)
        ) AS no_active_running_lease
      `);
      if (
        current?.value &&
        !(
          job.status === "ingesting" &&
          current.stopped_pending &&
          current.no_active_running_lease
        )
      )
        return { ...counts, waiting: 1 };
    }
    const sources = await connection.execute(sql`
      SELECT receipt.evidence_signature, raw.evidence_payload FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_evidence receipt ON receipt.attempt_token = attempt.token
      JOIN result_attempts raw ON raw.id = receipt.result_attempt_id WHERE attempt.sim_job_id = ${simJobId}
        ${selectedReceiptScope} LIMIT 2049
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
      SELECT attempt.token, attempt.outcome, attempt.active_seconds AS attempt_active_seconds,
        unit.id, unit.state, unit.lease_token, unit.lease_until, unit.attempts, unit.active_seconds, unit.active_budget_seconds,
        ${progressiveCfdEffectiveBudgetSql(sql`unit`)} AS effective_budget_seconds, work.id AS work_id,
        (SELECT extension.state FROM progressive_cfd_budget_extensions extension
          WHERE extension.unit_id = unit.id LIMIT 1) AS budget_extension_state,
        (SELECT extension.claim_attempt_token FROM progressive_cfd_budget_extensions extension
          WHERE extension.unit_id = unit.id LIMIT 1) AS budget_extension_claim_attempt_token,
        ${effectiveProgressiveStageSql()} = work.stage AND work.state IN ('pending', 'gap') AS recoverable_stage,
        NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts newer WHERE newer.unit_id = unit.id
          AND (newer.started_at, newer.token) > (attempt.started_at, attempt.token)) AS latest_attempt,
        ${progressiveCfdOrdinaryAttemptCountSql()} AS ordinary_attempts,
        ${progressiveCfdNeverStartedAttemptCountSql()} AS never_started_attempts,
        (SELECT count(*)::int FROM progressive_cfd_attempts history WHERE history.unit_id = unit.id) AS recorded_attempts,
        work.stage, epoch.current AND generation.status = 'active' AND generation.plan_revision_id = campaign.current_plan_revision_id
          AND campaign.status IN ('active', 'attention', 'paused') AS current_scope,
        evidence.count, evidence.accepted, evidence.infrastructure_only, fitted.state AS fit_state,
        EXISTS (SELECT 1 FROM progressive_cfd_recovery_plans recovery
          WHERE recovery.unit_id = unit.id AND recovery.parent_attempt_token = attempt.token) AS numerical_recovery,
        EXISTS (SELECT 1 FROM progressive_cfd_recovery_plans recovery
          WHERE recovery.unit_id = unit.id AND recovery.parent_attempt_token = attempt.token AND recovery.ordinal = 2) AS precise_verification,
        (unit.policy_version = ${PROGRESSIVE_COMPUTE_POLICY.version}
          AND ${progressiveCfdPreciseVerificationAvailableSql("unit", "attempt")}) AS unused_precise_verification,
        ${historicalEvidence} AS historical_recovery,
        EXISTS (SELECT 1 FROM progressive_cfd_evidence receipt,
          jsonb_array_elements(coalesce(fitted.response->'estimate'->'contributors', '[]'::jsonb)) contributor
          WHERE receipt.attempt_token = attempt.token AND receipt.result_attempt_id::text = contributor->>'attempt_id'
            ${selectedReceiptScope}) AS informative
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
        WHERE receipt.attempt_token = attempt.token ${selectedReceiptScope}
      ) evidence ON true
      LEFT JOIN LATERAL (
        SELECT fit.state, model.response FROM neuralfoil_predictions prediction
        JOIN progressive_polar_fit_work fit ON fit.prediction_id = prediction.id
        LEFT JOIN progressive_polar_geometry_verifications verification ON verification.model_id = fit.model_id
          AND verification.policy_version = ${SOURCE_GEOMETRY_POLICY_VERSION} AND verification.source_geometry_compatible
        LEFT JOIN progressive_polar_models model ON model.id = verification.model_id AND fit.state = 'ready'
        WHERE prediction.target_id = work.target_id AND prediction.epoch_id = generation.epoch_id
        ORDER BY prediction.created_at DESC, prediction.id DESC LIMIT 1
      ) fitted ON true
      WHERE attempt.sim_job_id = ${simJobId} ORDER BY unit.ordinal, unit.id
    `);
    for (const unit of units) {
      if (options.recoverStoredEvidence && unit.historical_recovery !== true)
        continue;
      const neverStarted =
        (stop.proof as EngineExecutionStopProof).ownership_basis ===
          "never_started_cancellation_fence" &&
        Number(unit.count) === 0 &&
        Number(unit.attempt_active_seconds) === 0;
      const recovering =
        options.recoverNeverStarted === true &&
        job.status === "cancelled" &&
        unit.outcome === "failed" &&
        unit.state === "gap" &&
        unit.current_scope === true &&
        unit.recoverable_stage === true &&
        unit.latest_attempt === true &&
        neverStarted;
      const recoveringStoredEvidence =
        options.recoverStoredEvidence != null &&
        unit.historical_recovery === true &&
        job.ingestedAt != null &&
        unit.current_scope === true &&
        unit.recoverable_stage === true &&
        unit.latest_attempt === true &&
        ["gap", "leased", "blocked"].includes(String(unit.state)) &&
        (unit.state !== "leased"
          ? unit.lease_token == null && unit.lease_until == null
          : unit.lease_token === unit.token &&
            unit.lease_until != null &&
            new Date(String(unit.lease_until)).getTime() <= Date.now()) &&
        ["complete", "failed", "cancelled"].includes(String(unit.outcome));
      const recoverableStoredEvidence = recoveringStoredEvidence;
      const staleTerminalUnit =
        unit.latest_attempt === true &&
        unit.outcome !== "running" &&
        ((unit.state === "leased" &&
          unit.lease_token === unit.token &&
          unit.lease_until != null &&
          new Date(String(unit.lease_until)).getTime() <= Date.now()) ||
          (unit.state === "blocked" &&
            unit.lease_token == null &&
            unit.lease_until == null));
      if (staleTerminalUnit) {
        await connection.execute(sql`UPDATE progressive_cfd_units SET state = 'gap',
          lease_token = NULL, lease_owner = NULL, lease_until = NULL,
          error = 'Terminal progressive execution released a stale unit lease'
          WHERE id = ${unit.id}`);
        counts.gaps += 1;
        continue;
      }
      if (
        unit.outcome !== "running" &&
        !recovering &&
        !recoverableStoredEvidence
      )
        continue;
      if (!unit.current_scope || unit.state === "cancelled") {
        await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome = 'cancelled', finished_at = clock_timestamp(),
          error = 'obsolete execution physically stopped' WHERE token = ${unit.token}`);
        await connection.execute(sql`UPDATE progressive_cfd_units SET state = 'cancelled', lease_token = NULL, lease_owner = NULL,
          lease_until = NULL, error = 'obsolete execution physically stopped' WHERE id = ${unit.id}`);
        counts.cancelled += 1;
        continue;
      }
      if (
        !recovering &&
        !recoverableStoredEvidence &&
        !["leased", "blocked"].includes(String(unit.state))
      )
        throw new Error(
          "Progressive CFD settlement has no exclusive current unit ownership",
        );
      const complete =
        unit.numerical_recovery !== true &&
        (unit.accepted === true ||
          (unit.stage === 2 && unit.informative === true));
      if (
        (!complete || recoverableStoredEvidence) &&
        unit.numerical_recovery !== true &&
        unit.stage === 2 &&
        Number(unit.count) > 0 &&
        ["pending", "leased"].includes(String(unit.fit_state))
      ) {
        counts.waiting += 1;
        continue;
      }
      const budgetExtensionAdmitted =
        !complete &&
        unit.stage === 2 &&
        unit.latest_attempt === true &&
        Number(unit.attempts) === 2 &&
        (await admitProgressiveCfdBudgetExtension(connection, {
          unitId: String(unit.id),
          attemptToken: String(unit.token),
        }));
      const effectiveBudget =
        Number(unit.effective_budget_seconds) +
        (budgetExtensionAdmitted ? PROGRESSIVE_FAST_BUDGET_EXTENSION_SECONDS : 0);
      const budgetExtensionPending =
        budgetExtensionAdmitted || unit.budget_extension_state === "pending";
      const exhausted =
        Number(unit.active_seconds) >= effectiveBudget;
      const ordinaryAttempts =
        Number(unit.ordinary_attempts) - (neverStarted ? 1 : 0);
      const budgetExtensionRetry =
        !complete &&
        budgetExtensionPending &&
        unit.stage === 2 &&
        ordinaryAttempts === 2 &&
        Number(unit.active_seconds) < effectiveBudget;
      const retry =
        budgetExtensionRetry ||
        (!complete &&
        !exhausted &&
        (!neverStarted ||
          (Number(unit.never_started_attempts) < 1 &&
            Number(unit.recorded_attempts) === Number(unit.attempts))) &&
        (ordinaryAttempts < 2 ||
          (ordinaryAttempts === 2 &&
            unit.stage === 3 &&
            (unit.precise_verification === true ||
              (neverStarted && unit.unused_precise_verification === true)))) &&
        (unit.numerical_recovery === true ||
          neverStarted ||
          (Number(unit.count) > 0 && unit.infrastructure_only === true)));
      const reason = complete
        ? null
        : budgetExtensionRetry
          ? "bounded URANS budget continuation admitted"
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
            : neverStarted
              ? "unstarted submission retry budget exhausted or history incomplete"
              : Number(unit.count) === 0
                ? "terminal execution has no measured case evidence"
                : unit.stage === 3
                  ? "precise evidence remains unresolved"
                  : "fast pass has no informative accepted evidence";
      await connection.execute(sql`UPDATE progressive_cfd_attempts SET outcome = ${complete ? "complete" : neverStarted ? "cancelled" : "failed"},
        finished_at = clock_timestamp(), error = ${reason} WHERE token = ${unit.token}`);
      await connection.execute(sql`UPDATE progressive_cfd_units SET state = ${complete ? "complete" : retry ? "pending" : "gap"},
        lease_token = NULL, lease_owner = NULL, lease_until = NULL, error = ${reason} WHERE id = ${unit.id}`);
      if (unit.budget_extension_state === "claimed" &&
          unit.budget_extension_claim_attempt_token === unit.token) {
        await connection.execute(sql`UPDATE progressive_cfd_budget_extensions
          SET state = ${complete ? "consumed" : "exhausted"}, consumed_at = clock_timestamp()
          WHERE unit_id = ${unit.id} AND state = 'claimed'
            AND claim_attempt_token = ${unit.token}::uuid`);
      }
      if ((recovering || budgetExtensionRetry) && retry)
        await connection.execute(sql`UPDATE progressive_work SET state = 'pending', error = NULL, completed_at = NULL
          WHERE id = ${unit.work_id} AND state = 'gap'`);
      if (complete) counts.complete += 1;
      else if (retry) counts.retry += 1;
      else counts.gaps += 1;
    }
    return counts;
  });
}

export type OperatorStaleRemoteDispatch = {
  jobId: string;
  promiseId: string;
};

export async function recoverOperatorVerifiedStaleRemoteDispatches(
  db: DB,
  input: {
    solverId: string;
    dispatches: readonly OperatorStaleRemoteDispatch[];
    expectedCount: number;
    operator: string;
    crossHostAbsenceConfirmed: true;
  },
): Promise<{ recoveredJobs: number; settledUnits: number }> {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(input.solverId) ||
    !input.operator.trim() ||
    input.crossHostAbsenceConfirmed !== true ||
    !Number.isSafeInteger(input.expectedCount) ||
    input.expectedCount < 1 ||
    input.expectedCount > 256 ||
    input.dispatches.length !== input.expectedCount ||
    new Set(input.dispatches.map((item) => item.jobId)).size !== input.expectedCount ||
    new Set(input.dispatches.map((item) => item.promiseId)).size !== input.expectedCount ||
    input.dispatches.some((item) => !uuid.test(item.jobId) || !uuid.test(item.promiseId))
  )
    throw new Error("Invalid bounded stale remote dispatch recovery scope");
  const batchId = randomUUID();
  let recoveredJobs = 0;
  let settledUnits = 0;
  for (const dispatch of input.dispatches) {
    const counts = await db.transaction(async (transaction) => {
      const connection = transaction as unknown as DB;
      const [owned] = await connection.execute(sql`
        SELECT job.id, job.campaign_id, job.engine_job_id, job.status,
          job.request_payload, promise.status AS promise_status,
          campaign.status AS campaign_status
        FROM progressive_remote_dispatches remote_dispatch
        JOIN sync_sweep_promises promise ON promise.id = remote_dispatch.promise_id
        JOIN sim_jobs job ON job.id = remote_dispatch.sim_job_id
        JOIN sim_campaigns campaign ON campaign.id = job.campaign_id
        WHERE remote_dispatch.sim_job_id = ${dispatch.jobId}::uuid
          AND remote_dispatch.promise_id = ${dispatch.promiseId}::uuid
          AND remote_dispatch.solver_id = ${input.solverId}::uuid
          AND promise.registered_solver_id = remote_dispatch.solver_id
          AND promise.status IN ('expired', 'cancelled')
          AND job.status = 'pending' AND job.engine_job_id IS NULL
          AND job.engine_state IS NULL
          AND campaign.status IN ('active', 'attention', 'paused')
        FOR UPDATE OF promise, job, campaign
      `);
      if (
        !owned ||
        !["expired", "cancelled"].includes(String(owned.promise_status)) ||
        owned.status !== "pending" ||
        owned.engine_job_id !== null
      )
        throw new Error(`Stale remote recovery ownership changed for ${dispatch.jobId}`);
      const attempts = await connection.execute(sql`
        SELECT token, outcome, active_seconds FROM progressive_cfd_attempts
        WHERE sim_job_id = ${dispatch.jobId}::uuid FOR UPDATE
      `);
      const [evidence] = await connection.execute(sql`
        SELECT
          EXISTS (SELECT 1 FROM progressive_remote_reports WHERE sim_job_id = ${dispatch.jobId}::uuid) AS reports,
          EXISTS (SELECT 1 FROM result_attempts WHERE sim_job_id = ${dispatch.jobId}::uuid) AS results,
          EXISTS (SELECT 1 FROM progressive_cfd_runtime_progress runtime
            JOIN progressive_cfd_attempts attempt ON attempt.token = runtime.attempt_token
            WHERE attempt.sim_job_id = ${dispatch.jobId}::uuid) AS runtime,
          EXISTS (SELECT 1 FROM progressive_cfd_execution_stops WHERE sim_job_id = ${dispatch.jobId}::uuid) AS stops
      `);
      if (
        !attempts.length ||
        attempts.some((attempt) => attempt.outcome !== "running" || Number(attempt.active_seconds) !== 0) ||
        evidence?.reports || evidence?.results || evidence?.runtime || evidence?.stops
      )
        throw new Error(`Stale remote recovery evidence guard failed for ${dispatch.jobId}`);
      const marker = {
        kind: "expired-remote-never-started",
        operator: input.operator,
        batchId,
        expectedCount: input.expectedCount,
        crossHostAbsenceConfirmed: true,
        dispatches: input.dispatches,
        markedAt: new Date().toISOString(),
      };
      await connection.execute(sql`
        UPDATE sync_sweep_promises SET status = 'cancelled',
          "cancelledAt" = coalesce("cancelledAt", clock_timestamp()),
          response_payload = coalesce(response_payload, '{}'::jsonb) ||
            jsonb_build_object('operatorRecovery', ${JSON.stringify(marker)}::jsonb),
          "updatedAt" = clock_timestamp()
        WHERE id = ${dispatch.promiseId}::uuid AND status IN ('expired', 'cancelled')
      `);
      await connection.execute(sql`
        UPDATE sync_sweep_promise_points SET status = 'cancelled', "updatedAt" = clock_timestamp()
        WHERE promise_id = ${dispatch.promiseId}::uuid AND status IN ('active', 'expired')
      `);
      await connection.execute(sql`
        UPDATE sim_jobs SET engine_job_id = ${dispatch.jobId}::uuid, status = 'cancelled',
          engine_state = 'cancelled', "ingestedAt" = clock_timestamp(), "finishedAt" = clock_timestamp(),
          "updatedAt" = clock_timestamp(),
          error = 'Operator-verified expired remote execution never started; no remote mirror or evidence'
        WHERE id = ${dispatch.jobId}::uuid AND status = 'pending' AND engine_job_id IS NULL
      `);
      await acknowledgeProgressiveCfdExecutionStop(connection, {
        simJobId: dispatch.jobId,
        proof: {
          version: 1,
          job_id: dispatch.jobId,
          execution_stopped: true,
          producer_stopped: true,
          namespace_verified: true,
          remaining: [],
          observed_at: new Date().toISOString(),
          error: null,
          fence: "cancel_marker",
          ownership_basis: "never_started_cancellation_fence",
        },
      });
      return settleProgressiveCfdExecution(connection, dispatch.jobId);
    });
    recoveredJobs += 1;
    settledUnits += Number(counts.complete ?? 0) + Number(counts.retry ?? 0) + Number(counts.gaps ?? 0) + Number(counts.cancelled ?? 0);
  }
  return { recoveredJobs, settledUnits };
}

const STALE_REMOTE_DISPATCH_RECOVERY_KEY =
  "progressiveStaleRemoteDispatchRecovery";
const STALE_REMOTE_DISPATCH_RECOVERY_KIND =
  "stale_remote_dispatch_recovery_v1";
const MAX_STALE_REMOTE_DISPATCH_RECOVERY_COUNT = 256;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type StaleRemoteDispatchRecoveryPair = {
  jobId: string;
  promiseId: string;
};

type StaleRemoteDispatchRecoveryMarker = {
  version: 1;
  kind: typeof STALE_REMOTE_DISPATCH_RECOVERY_KIND;
  batchId: string;
  expectedCount: number;
  operator: string;
  crossHostAbsenceConfirmed: true;
  dispatches: StaleRemoteDispatchRecoveryPair[];
  markedAt: string;
  recoveredAt?: string;
  disposition?: string;
};

function validateStaleRemoteDispatchRecoveryInput(input: {
  dispatches: readonly StaleRemoteDispatchRecoveryPair[];
  expectedCount: number;
  operator: string;
  crossHostAbsenceConfirmed: boolean;
}) {
  if (
    !Number.isSafeInteger(input.expectedCount) ||
    input.expectedCount < 1 ||
    input.expectedCount > MAX_STALE_REMOTE_DISPATCH_RECOVERY_COUNT ||
    input.dispatches.length !== input.expectedCount ||
    new Set(input.dispatches.map((dispatch) => dispatch.jobId)).size !==
      input.expectedCount ||
    new Set(input.dispatches.map((dispatch) => dispatch.promiseId)).size !==
      input.expectedCount ||
    input.dispatches.some(
      (dispatch) =>
        !UUID_RE.test(dispatch.jobId) || !UUID_RE.test(dispatch.promiseId),
    )
  )
    throw new Error(
      "Stale remote recovery requires an exact bounded job/promise list and expected count",
    );
  if (!input.operator.trim())
    throw new Error("Stale remote recovery requires an operator identity");
  if (input.crossHostAbsenceConfirmed !== true)
    throw new Error(
      "Stale remote recovery requires an explicit cross-host absence confirmation",
    );
}

function parseStaleRemoteDispatchRecoveryMarker(
  value: unknown,
): StaleRemoteDispatchRecoveryMarker | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<StaleRemoteDispatchRecoveryMarker>;
  const expectedCount = candidate.expectedCount;
  if (
    candidate.version !== 1 ||
    candidate.kind !== STALE_REMOTE_DISPATCH_RECOVERY_KIND ||
    typeof candidate.batchId !== "string" ||
    !UUID_RE.test(candidate.batchId) ||
    typeof expectedCount !== "number" ||
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 1 ||
    expectedCount > MAX_STALE_REMOTE_DISPATCH_RECOVERY_COUNT ||
    typeof candidate.operator !== "string" ||
    candidate.crossHostAbsenceConfirmed !== true ||
    !Array.isArray(candidate.dispatches) ||
    candidate.dispatches.length !== expectedCount ||
    candidate.dispatches.some(
      (dispatch) =>
        !dispatch ||
        typeof dispatch !== "object" ||
        typeof (dispatch as StaleRemoteDispatchRecoveryPair).jobId !== "string" ||
        typeof (dispatch as StaleRemoteDispatchRecoveryPair).promiseId !==
          "string" ||
        !UUID_RE.test((dispatch as StaleRemoteDispatchRecoveryPair).jobId) ||
        !UUID_RE.test((dispatch as StaleRemoteDispatchRecoveryPair).promiseId),
    )
  )
    return null;
  return candidate as StaleRemoteDispatchRecoveryMarker;
}

async function selectGuardedStaleRemoteDispatch(
  db: DB,
  dispatch: StaleRemoteDispatchRecoveryPair,
  batchId?: string,
) {
  const batchFilter =
    batchId == null
      ? sql``
      : sql`AND promise.response_payload#>>'{progressiveStaleRemoteDispatchRecovery,batchId}' = ${batchId}`;
  return db.execute(sql`
    SELECT dispatch.sim_job_id, dispatch.promise_id, dispatch.solver_id,
      promise.status AS promise_status, promise.response_payload,
      job.campaign_id, job.status AS job_status, job.engine_job_id, job.engine_state,
      job.request_payload,
      attempt.token, attempt.outcome, attempt.active_seconds AS attempt_active_seconds,
      unit.id AS unit_id, unit.state AS unit_state, unit.lease_token,
      unit.active_seconds AS unit_active_seconds,
      generation.id AS generation_id, generation.epoch_id,
      generation.campaign_id AS generation_campaign_id,
      generation.plan_revision_id AS generation_plan_revision_id,
      generation.status AS generation_status, generation.stage,
      epoch.current AS epoch_current, campaign.status AS campaign_status,
      campaign.current_plan_revision_id,
      work.id AS work_id, work.target_id, work.stage AS work_stage,
      attempt_counts.total_attempts, attempt_counts.running_attempts
    FROM progressive_remote_dispatches dispatch
    JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
    JOIN sim_jobs job ON job.id = dispatch.sim_job_id
    CROSS JOIN LATERAL (
      SELECT count(*)::integer AS total_attempts,
        count(*) FILTER (WHERE candidate.outcome = 'running')::integer AS running_attempts
      FROM progressive_cfd_attempts candidate
      WHERE candidate.sim_job_id = job.id
    ) attempt_counts
    JOIN progressive_cfd_attempts attempt ON attempt.sim_job_id = job.id
    JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
    JOIN progressive_work work ON work.id = unit.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id
    JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
    WHERE dispatch.sim_job_id = ${dispatch.jobId}::uuid
      AND dispatch.promise_id = ${dispatch.promiseId}::uuid
      AND promise.registered_solver_id = dispatch.solver_id
      AND promise.status IN ('expired', 'cancelled')
      AND job.status = 'pending'
      AND job.engine_job_id IS NULL
      AND job.engine_state IS NULL
      AND job.request_payload->'progressive'->>'generationId' = generation.id::text
      AND job.request_payload->'progressive'->>'epochId' = generation.epoch_id::text
      AND job.request_payload->'progressive'->>'targetId' = work.target_id
      AND job.request_payload->'progressive'->>'stage' = work.stage::text
      AND job.request_payload->'progressive'->>'recipeId' = attempt.execution_recipe_id
      AND jsonb_typeof(job.request_payload->'progressive'->'tokens') = 'array'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(job.request_payload->'progressive'->'tokens') token_value
        WHERE token_value = attempt.token::text
      )
      AND generation.status = 'active'
      AND epoch.current
      AND generation.plan_revision_id = campaign.current_plan_revision_id
      AND campaign.status IN ('active', 'attention', 'paused')
      AND work.state = 'pending'
      AND unit.state = 'leased'
      AND unit.lease_token = attempt.token
      AND attempt.active_seconds = 0
      AND unit.active_seconds = 0
      AND attempt_counts.total_attempts > 0
      AND NOT EXISTS (SELECT 1 FROM progressive_remote_reports report
        WHERE report.sim_job_id = job.id)
      AND NOT EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
        WHERE receipt.sim_job_id = job.id)
      AND NOT EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
        WHERE inventory.sim_job_id = job.id)
      AND NOT EXISTS (SELECT 1 FROM progressive_remote_report_sources source
        WHERE source.sim_job_id = job.id)
      AND NOT EXISTS (SELECT 1 FROM progressive_remote_evidence_receipts evidence
        WHERE evidence.sim_job_id = job.id)
      AND NOT EXISTS (
        SELECT 1 FROM progressive_cfd_evidence evidence
        JOIN progressive_cfd_attempts evidence_attempt
          ON evidence_attempt.token = evidence.attempt_token
        WHERE evidence_attempt.sim_job_id = job.id)
      AND NOT EXISTS (
        SELECT 1 FROM progressive_cfd_runtime_progress runtime
        JOIN progressive_cfd_attempts runtime_attempt
          ON runtime_attempt.token = runtime.attempt_token
        WHERE runtime_attempt.sim_job_id = job.id)
      AND NOT EXISTS (SELECT 1 FROM result_attempts raw
        WHERE raw.sim_job_id = job.id)
      AND NOT EXISTS (SELECT 1 FROM results result
        WHERE result.sim_job_id = job.id)
      AND NOT EXISTS (SELECT 1 FROM progressive_worker_reports worker_report
        WHERE worker_report.sim_job_id = job.id)
      AND NOT EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
        WHERE stopped.sim_job_id = job.id)
      ${batchFilter}
    FOR UPDATE OF promise, job, campaign, generation, work, unit, attempt
  `);
}

function dispatchPairKey(dispatch: StaleRemoteDispatchRecoveryPair) {
  return dispatch.jobId + ":" + dispatch.promiseId;
}

export async function markProgressiveStaleRemoteDispatchRecovery(
  db: DB,
  input: {
    dispatches: readonly StaleRemoteDispatchRecoveryPair[];
    expectedCount: number;
    operator: string;
    crossHostAbsenceConfirmed: boolean;
  },
): Promise<{ batchId: string; marked: number }> {
  validateStaleRemoteDispatchRecoveryInput(input);
  const dispatches = input.dispatches.map((dispatch) => ({ ...dispatch }));
  const marker: StaleRemoteDispatchRecoveryMarker = {
    version: 1,
    kind: STALE_REMOTE_DISPATCH_RECOVERY_KIND,
    batchId: randomUUID(),
    expectedCount: input.expectedCount,
    operator: input.operator.trim(),
    crossHostAbsenceConfirmed: true,
    dispatches,
    markedAt: new Date().toISOString(),
  };
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    for (const dispatch of dispatches) {
      const rows = await selectGuardedStaleRemoteDispatch(connection, dispatch);
      if (
        !rows.length ||
        Number(rows[0].total_attempts) !== rows.length ||
        Number(rows[0].running_attempts) !== rows.length ||
        rows.some((row) => row.outcome !== "running")
      )
        {
          const diagnostics = await connection.execute(sql`
            SELECT promise.status AS promise_status, job.status AS job_status,
              job.engine_state, job.request_payload->'progressive' AS progressive,
              attempt.outcome, attempt.active_seconds AS attempt_active_seconds,
              unit.state AS unit_state, unit.lease_token,
              unit.active_seconds AS unit_active_seconds,
              generation.id AS generation_id, generation.epoch_id,
              generation.status AS generation_status, epoch.current AS epoch_current,
              campaign.status AS campaign_status,
              campaign.current_plan_revision_id,
              generation.plan_revision_id AS generation_plan_revision_id,
              work.target_id, work.stage,
              attempt.execution_recipe_id
            FROM progressive_remote_dispatches dispatch
            JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
            JOIN sim_jobs job ON job.id = dispatch.sim_job_id
            JOIN progressive_cfd_attempts attempt ON attempt.sim_job_id = job.id
            JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
            JOIN progressive_work work ON work.id = unit.work_id
            JOIN progressive_generations generation ON generation.id = work.generation_id
            JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id
            JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
            WHERE dispatch.sim_job_id = ${dispatch.jobId}::uuid
              AND dispatch.promise_id = ${dispatch.promiseId}::uuid
          `);
          throw new Error(
            "Stale remote recovery guard failed for " +
              dispatch.jobId +
              "/" +
              dispatch.promiseId +
              ": " +
              JSON.stringify(diagnostics).slice(0, 4000),
          );
        }
      const payload = rows[0].response_payload as
        | Record<string, unknown>
        | null
        | undefined;
      if (
        parseStaleRemoteDispatchRecoveryMarker(
          payload?.[STALE_REMOTE_DISPATCH_RECOVERY_KEY],
        )
      )
        throw new Error(
          "Stale remote recovery is already marked for " +
            dispatch.jobId +
            "/" +
            dispatch.promiseId,
        );
    }
    for (const dispatch of dispatches)
      await connection.execute(sql`
        UPDATE sync_sweep_promises
        SET response_payload = coalesce(response_payload, '{}'::jsonb)
          || jsonb_build_object(
            ${STALE_REMOTE_DISPATCH_RECOVERY_KEY},
            ${JSON.stringify(marker)}::jsonb
          ),
          "updatedAt" = clock_timestamp()
        WHERE id = ${dispatch.promiseId}::uuid
          AND status IN ('expired', 'cancelled')
      `);
    return { batchId: marker.batchId, marked: dispatches.length };
  });
}

export async function recoverMarkedProgressiveStaleRemoteDispatches(
  db: DB,
  options: { maxBatches?: number } = {},
): Promise<{
  batches: number;
  recovered: number;
  cpuSlotsReleased: number;
  skipped: Array<{ batchId: string; reason: string }>;
}> {
  const maxBatches = options.maxBatches ?? 1;
  if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 8)
    throw new Error("Invalid stale remote recovery batch limit");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const batches = await connection.execute(sql`
      SELECT promise.response_payload#>>'{progressiveStaleRemoteDispatchRecovery,batchId}' AS batch_id
      FROM sync_sweep_promises promise
      JOIN progressive_remote_dispatches dispatch ON dispatch.promise_id = promise.id
      WHERE promise.response_payload#>>'{progressiveStaleRemoteDispatchRecovery,kind}' = ${STALE_REMOTE_DISPATCH_RECOVERY_KIND}
        AND promise.response_payload#>>'{progressiveStaleRemoteDispatchRecovery,version}' = '1'
        AND promise.response_payload#>>'{progressiveStaleRemoteDispatchRecovery,recoveredAt}' IS NULL
        AND promise.response_payload#>>'{progressiveStaleRemoteDispatchRecovery,expectedCount}' ~ '^[1-9][0-9]{0,2}$'
      GROUP BY promise.response_payload#>>'{progressiveStaleRemoteDispatchRecovery,batchId}'
      ORDER BY promise.response_payload#>>'{progressiveStaleRemoteDispatchRecovery,batchId}'
      LIMIT ${maxBatches}
    `);
    const receipt = {
      batches: 0,
      recovered: 0,
      cpuSlotsReleased: 0,
      skipped: [] as Array<{ batchId: string; reason: string }>,
    };
    for (const batch of batches) {
      const batchId = String(batch.batch_id);
      const markedRows = await connection.execute(sql`
        SELECT dispatch.sim_job_id, dispatch.promise_id, dispatch.cpu_slots,
          promise.response_payload
        FROM progressive_remote_dispatches dispatch
        JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
        JOIN sim_jobs job ON job.id = dispatch.sim_job_id
        WHERE promise.response_payload#>>'{progressiveStaleRemoteDispatchRecovery,batchId}' = ${batchId}
          AND promise.response_payload#>>'{progressiveStaleRemoteDispatchRecovery,recoveredAt}' IS NULL
        FOR UPDATE OF promise, job
      `);
      const firstPayload = markedRows[0]?.response_payload as
        | Record<string, unknown>
        | null
        | undefined;
      const marker = parseStaleRemoteDispatchRecoveryMarker(
        firstPayload?.[STALE_REMOTE_DISPATCH_RECOVERY_KEY],
      );
      const markedPairs = new Set(
        markedRows.map((row) =>
          dispatchPairKey({
            jobId: String(row.sim_job_id),
            promiseId: String(row.promise_id),
          }),
        ),
      );
      const markerPairs = marker
        ? new Set(marker.dispatches.map(dispatchPairKey))
        : new Set<string>();
      if (
        !marker ||
        marker.batchId !== batchId ||
        marker.dispatches.length !== marker.expectedCount ||
        markedRows.length !== marker.expectedCount ||
        markedPairs.size !== marker.expectedCount ||
        markerPairs.size !== marker.expectedCount ||
        [...markedPairs].some((pair) => !markerPairs.has(pair))
      ) {
        receipt.skipped.push({
          batchId,
          reason: "marker does not cover the exact current dispatch set",
        });
        continue;
      }
      const guarded = new Map<
        string,
        Awaited<ReturnType<typeof selectGuardedStaleRemoteDispatch>>
      >();
      let guardFailure: string | null = null;
      for (const dispatch of marker.dispatches) {
        const rows = await selectGuardedStaleRemoteDispatch(
          connection,
          dispatch,
          batchId,
        );
        if (
          !rows.length ||
          Number(rows[0].total_attempts) !== rows.length ||
          Number(rows[0].running_attempts) !== rows.length ||
          rows.some((row) => row.outcome !== "running")
        ) {
          guardFailure =
            "guard failed for " + dispatch.jobId + "/" + dispatch.promiseId;
          break;
        }
        guarded.set(dispatch.jobId, rows);
      }
      if (guardFailure || guarded.size !== marker.expectedCount) {
        receipt.skipped.push({
          batchId,
          reason: guardFailure ?? "guarded dispatch set is incomplete",
        });
        continue;
      }
      let batchSlots = 0;
      for (const dispatch of marker.dispatches) {
        const rows = guarded.get(dispatch.jobId)!;
        const proof: EngineExecutionStopProof = {
          version: 1,
          job_id: dispatch.jobId,
          execution_stopped: true,
          producer_stopped: true,
          namespace_verified: true,
          remaining: [],
          observed_at: new Date().toISOString(),
          error: null,
          fence: "cancel_marker",
          ownership_basis: "never_started_cancellation_fence",
        };
        await connection.execute(sql`
          UPDATE sim_jobs
          SET engine_job_id = ${dispatch.jobId},
            status = 'cancelled',
            engine_state = 'cancelled',
            "finishedAt" = coalesce("finishedAt", clock_timestamp()),
            "updatedAt" = clock_timestamp(),
            error = 'Operator-authorized recovery of a stale unstarted remote dispatch'
          WHERE id = ${dispatch.jobId}::uuid
            AND status = 'pending'
            AND engine_job_id IS NULL
            AND engine_state IS NULL
        `);
        await acknowledgeProgressiveCfdExecutionStop(connection, {
          simJobId: dispatch.jobId,
          proof,
        });
        await connection.execute(sql`
          UPDATE progressive_cfd_attempts
          SET outcome = 'failed',
            finished_at = clock_timestamp(),
            error = 'Stale remote dispatch was cancelled before engine submission'
          WHERE sim_job_id = ${dispatch.jobId}::uuid AND outcome = 'running'
        `);
        await connection.execute(sql`
          UPDATE progressive_cfd_units unit
          SET state = 'gap',
            lease_token = NULL,
            lease_owner = NULL,
            lease_until = NULL,
            error = 'Stale remote dispatch was cancelled before engine submission'
          FROM progressive_cfd_attempts attempt
          WHERE attempt.unit_id = unit.id
            AND attempt.sim_job_id = ${dispatch.jobId}::uuid
            AND attempt.outcome = 'failed'
        `);
        const settled = await settleProgressiveCfdExecution(
          connection,
          dispatch.jobId,
          { recoverNeverStarted: true },
        );
        if (
          settled.retry + settled.gaps !== rows.length ||
          settled.waiting !== 0
        )
          throw new Error(
            "Stale remote recovery did not settle every unit for " +
              dispatch.jobId,
          );
        batchSlots += Number(
          markedRows.find(
            (row) => String(row.sim_job_id) === dispatch.jobId,
          )?.cpu_slots ?? 0,
        );
      }
      for (const dispatch of marker.dispatches) {
        await connection.execute(sql`
          UPDATE sync_sweep_promises
          SET status = 'cancelled',
            "cancelledAt" = coalesce("cancelledAt", clock_timestamp()),
            "updatedAt" = clock_timestamp(),
            response_payload = jsonb_set(
              coalesce(response_payload, '{}'::jsonb),
              '{progressiveStaleRemoteDispatchRecovery}',
              coalesce(
                response_payload->'progressiveStaleRemoteDispatchRecovery',
                '{}'::jsonb
              ) || jsonb_build_object(
                'recoveredAt', clock_timestamp(),
                'disposition', 'never_started_cancelled'
              ),
              true
            )
          WHERE id = ${dispatch.promiseId}::uuid
        `);
        await connection.execute(sql`
          UPDATE sync_sweep_promise_points
          SET status = 'cancelled', "updatedAt" = clock_timestamp()
          WHERE promise_id = ${dispatch.promiseId}::uuid AND status = 'active'
        `);
      }
      receipt.batches += 1;
      receipt.recovered += marker.expectedCount;
      receipt.cpuSlotsReleased += batchSlots;
    }
    return receipt;
  });
}
