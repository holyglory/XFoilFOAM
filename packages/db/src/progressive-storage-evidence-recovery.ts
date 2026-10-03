import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { ProgressiveCfdEvidenceScopeClosed } from "./progressive-cfd-evidence";
import type { ProgressiveStorageEvidenceRecoveryScope } from "./progressive-cfd-evidence";
import { effectiveProgressiveStageSql } from "./progressive-execution-policy";
import {
  recordProgressiveRemoteEvidenceReceipt,
  type ProgressiveRemoteEvidenceDelivery,
} from "./progressive-remote-evidence-receipts";
import { ProgressiveRemoteEvidenceConflict } from "./progressive-remote-evidence";
import { verifyProgressiveRemoteExecution } from "./progressive-remote-execution";
import { settleProgressiveCfdExecution } from "./progressive-cfd-settlement";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const DEFAULT_LIMIT = 32;
const MAX_LIMIT = 128;

export interface ProgressiveStorageEvidenceRecoveryResult {
  selected: number;
  linked: number;
  replayed: number;
  skippedClosed: number;
  skippedPromiseStatus: number;
  skippedInFlight: number;
  conflicts: number;
  errors: number;
  settledJobs: number;
  settlementWaiting: number;
  errorSamples: string[];
}

function assertScope(scope: ProgressiveStorageEvidenceRecoveryScope) {
  if (
    !UUID.test(scope.campaignId) ||
    !UUID.test(scope.epochId) ||
    !UUID.test(scope.generationId) ||
    !UUID.test(scope.planRevisionId) ||
    scope.stage !== 2
  )
    throw new Error(
      "Progressive storage evidence recovery requires an exact campaign, epoch, generation, plan, and stage-2 scope",
    );
}

function result(): ProgressiveStorageEvidenceRecoveryResult {
  return {
    selected: 0,
    linked: 0,
    replayed: 0,
    skippedClosed: 0,
    skippedPromiseStatus: 0,
    skippedInFlight: 0,
    conflicts: 0,
    errors: 0,
    settledJobs: 0,
    settlementWaiting: 0,
    errorSamples: [],
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rememberError(
  receipt: ProgressiveStorageEvidenceRecoveryResult,
  error: unknown,
) {
  if (receipt.errorSamples.length < 8)
    receipt.errorSamples.push(message(error));
}

function scopeMatches(
  envelope: ReturnType<typeof verifyProgressiveRemoteExecution>,
  scope: ProgressiveStorageEvidenceRecoveryScope,
  row: Record<string, any>,
) {
  return (
    envelope.scope.epochId === scope.epochId &&
    envelope.scope.generationId === scope.generationId &&
    envelope.scope.stage === scope.stage &&
    envelope.scope.targetId === String(row.target_id) &&
    envelope.scope.recipeId === String(row.execution_recipe_id) &&
    envelope.scope.tokens.includes(String(row.attempt_token))
  );
}

/**
 * Re-publishes current-scope storage-only receipts into canonical progressive
 * evidence. This is deliberately hub-only: the HZ role must never run this
 * database recovery query or mutate canonical hub evidence.
 */
export async function recoverProgressiveStorageOnlyEvidence(
  db: DB,
  scope: ProgressiveStorageEvidenceRecoveryScope,
  options: { limit?: number } = {},
): Promise<ProgressiveStorageEvidenceRecoveryResult> {
  assertScope(scope);
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    throw new Error(
      `Progressive storage evidence recovery limit must be 1-${MAX_LIMIT}`,
    );

  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const receipt = result();
    const rows = await connection.execute(sql`
      SELECT receipt.sim_job_id::text AS sim_job_id, receipt.sequence,
        receipt.point_content_signature, receipt.result_attempt_id::text AS result_attempt_id,
        receipt.remote_result_id::text AS remote_result_id,
        receipt.remote_result_attempt_id::text AS remote_result_attempt_id,
        dispatch.solver_id::text AS solver_id, dispatch.promise_id::text AS promise_id,
        dispatch.content_signature AS dispatch_signature, dispatch.envelope,
        report.content_signature AS report_signature,
        promise.status AS promise_status,
        raw.aoa_deg, raw.engine_case_slug,
        progressive_attempt.token::text AS attempt_token,
        progressive_attempt.execution_recipe_id,
        progressive_attempt.outcome AS attempt_outcome,
        unit.state AS unit_state, unit.lease_token::text AS lease_token,
        unit.lease_until, work.target_id, work.stage, work.state AS work_state,
        generation.id::text AS generation_id, generation.epoch_id::text AS epoch_id,
        generation.plan_revision_id::text AS plan_revision_id,
        campaign.current_plan_revision_id::text AS current_plan_revision_id,
        epoch.current AS epoch_current,
        job.status AS job_status, job."ingestedAt" AS ingested_at,
        job.ingest_lease_expires_at
      FROM progressive_remote_evidence_receipts receipt
      JOIN progressive_remote_dispatches dispatch
        ON dispatch.sim_job_id = receipt.sim_job_id
      JOIN progressive_remote_reports report
        ON report.sim_job_id = receipt.sim_job_id AND report.sequence = receipt.sequence
      JOIN sync_sweep_promises promise
        ON promise.id = dispatch.promise_id
      JOIN sim_jobs job ON job.id = receipt.sim_job_id
      JOIN result_attempts raw ON raw.id = receipt.result_attempt_id
        AND raw.sim_job_id = receipt.sim_job_id
        AND raw.engine_job_id = receipt.sim_job_id::text
      JOIN progressive_cfd_attempts progressive_attempt
        ON progressive_attempt.sim_job_id = receipt.sim_job_id
        AND progressive_attempt.execution_recipe_id = dispatch.envelope#>>'{scope,recipeId}'
      JOIN progressive_cfd_units unit
        ON unit.id = progressive_attempt.unit_id AND unit.aoa_deg = raw.aoa_deg
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      WHERE receipt.storage_only = true
        AND receipt.result_attempt_id IS NOT NULL
        AND job.campaign_id = ${scope.campaignId}::uuid
        AND generation.id = ${scope.generationId}::uuid
        AND generation.epoch_id = ${scope.epochId}::uuid
        AND generation.plan_revision_id = ${scope.planRevisionId}::uuid
        AND generation.status = 'active'
        AND epoch.current
        AND campaign.status IN ('active', 'attention', 'paused')
        AND campaign.current_plan_revision_id = ${scope.planRevisionId}::uuid
        AND promise.status IN ('expired', 'cancelled', 'fulfilled')
        AND promise.registered_solver_id = dispatch.solver_id
        AND work.stage = ${scope.stage}
        AND ${effectiveProgressiveStageSql()} = ${scope.stage}
        AND work.state = 'pending'
        AND job.engine_job_id = job.id::text
        AND job.status IN ('done', 'failed', 'cancelled')
        AND job."ingestedAt" IS NOT NULL
        AND (job.ingest_lease_expires_at IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
        AND progressive_attempt.outcome IN ('running', 'complete', 'failed', 'cancelled')
        AND unit.state IN ('gap', 'leased', 'blocked')
        AND (unit.state <> 'leased' OR unit.lease_until IS NULL OR unit.lease_until <= clock_timestamp())
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_evidence evidence
          WHERE evidence.result_attempt_id = receipt.result_attempt_id
        )
      ORDER BY receipt.sim_job_id, receipt.sequence, receipt.point_content_signature
      LIMIT ${limit}
      FOR UPDATE OF receipt, dispatch, report, job, raw, progressive_attempt, unit, work, generation
      SKIP LOCKED
    `);

    const settlementIds = new Map<string, string[]>();
    for (const row of rows as unknown as Array<Record<string, any>>) {
      receipt.selected += 1;
      const delivery: ProgressiveRemoteEvidenceDelivery = {
        solverId: String(row.solver_id),
        promiseId: String(row.promise_id),
        engineJobId: String(row.sim_job_id),
        aoaDeg: Number(row.aoa_deg),
        engineCaseSlug:
          row.engine_case_slug == null ? null : String(row.engine_case_slug),
        progressiveEvidence: {
          sequence: Number(row.sequence),
          reportContentSignature: String(row.report_signature),
          pointContentSignature: String(row.point_content_signature),
        },
        remoteResultId: String(row.remote_result_id),
        remoteResultAttemptId: String(row.remote_result_attempt_id),
      };
      try {
        const envelope = verifyProgressiveRemoteExecution(row.envelope, {
          solverId: delivery.solverId,
          promiseId: delivery.promiseId,
          executionId: delivery.engineJobId,
          contentSignature: String(row.dispatch_signature),
        });
        if (!scopeMatches(envelope, scope, row))
          throw new ProgressiveRemoteEvidenceConflict(
            "Historical progressive evidence envelope is outside the requested target and recipe scope",
          );
        const [promise] = await connection.execute(sql`
          SELECT status FROM sync_sweep_promises
          WHERE id = ${delivery.promiseId}::uuid
            AND status IN ('expired', 'cancelled', 'fulfilled')
          FOR SHARE
        `);
        if (!promise)
          throw new ProgressiveRemoteEvidenceConflict(
            "Historical progressive evidence requires a closed promise status",
          );
        await recordProgressiveRemoteEvidenceReceipt(connection, {
          ...delivery,
          resultAttemptId: String(row.result_attempt_id),
          storageOnly: false,
          recoveryScope: scope,
        });
        receipt.linked += 1;
        const ids = settlementIds.get(delivery.engineJobId) ?? [];
        ids.push(String(row.result_attempt_id));
        settlementIds.set(delivery.engineJobId, ids);
      } catch (error) {
        if (
          error instanceof ProgressiveRemoteEvidenceConflict &&
          /closed promise status/i.test(message(error))
        ) {
          receipt.skippedPromiseStatus += 1;
        } else if (error instanceof ProgressiveCfdEvidenceScopeClosed) {
          receipt.skippedClosed += 1;
        } else if (
          error instanceof ProgressiveRemoteEvidenceConflict &&
          /in.?flight|active ingest|active lease|running/i.test(message(error))
        ) {
          receipt.skippedInFlight += 1;
        } else if (error instanceof ProgressiveRemoteEvidenceConflict) {
          receipt.conflicts += 1;
        } else {
          receipt.errors += 1;
        }
        rememberError(receipt, error);
      }
    }

    for (const [jobId, resultAttemptIds] of settlementIds) {
      try {
        const settled = await settleProgressiveCfdExecution(connection, jobId, {
          recoverStoredEvidence: {
            resultAttemptIds: [...new Set(resultAttemptIds)],
          },
        });
        if (settled.waiting > 0) receipt.settlementWaiting += 1;
        else receipt.settledJobs += 1;
      } catch (error) {
        receipt.errors += 1;
        rememberError(receipt, error);
      }
    }
    return receipt;
  });
}
