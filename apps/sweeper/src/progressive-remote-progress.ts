import {
  acknowledgeProgressiveCfdExecutionStop,
  canonicalAnalysisJson,
  recordProgressiveCfdRuntimeProgress,
  settleProgressiveCfdExecution,
  validateProgressiveRemoteReport,
  verifyProgressiveRemoteExecution,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
} from "@aerodb/db";
import { sql } from "drizzle-orm";
import { releaseResultClaimsForJob } from "@aerodb/db/result-claim-lifecycle";
import { indexProgressiveRemoteReport } from "@aerodb/db/progressive-remote-inventory";
import { persistEngineRuntimeForJob } from "./engine-provenance";
import { settleProgressiveRemoteJob } from "./progressive-remote-settlement";

export async function applyProgressiveRemoteProgress(
  db: DB,
  executionId: string,
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [dispatch] =
      await connection.execute(sql`SELECT envelope, content_signature, solver_id, promise_id
      FROM progressive_remote_dispatches WHERE sim_job_id = ${executionId}::uuid`);
    if (!dispatch)
      throw new Error("Remote progress has no exact dispatch owner");
    const envelope = verifyProgressiveRemoteExecution(
      dispatch.envelope as ProgressiveRemoteExecutionEnvelope,
      {
        executionId,
        solverId: String(dispatch.solver_id),
        promiseId: String(dispatch.promise_id),
        contentSignature: String(dispatch.content_signature),
      },
    );
    await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE id = ${envelope.scope.epochId}::uuid FOR SHARE`,
    );
    await connection.execute(sql`SELECT campaign.id FROM sim_campaigns campaign JOIN sim_jobs job ON job.campaign_id = campaign.id
      WHERE job.id = ${executionId}::uuid FOR UPDATE OF campaign`);
    const [job] = await connection.execute(
      sql`SELECT engine_job_id, request_payload FROM sim_jobs WHERE id = ${executionId}::uuid FOR UPDATE`,
    );
    if (
      !job ||
      (job.engine_job_id !== null && job.engine_job_id !== executionId) ||
      canonicalAnalysisJson(
        (job.request_payload as Record<string, unknown>).engineRequest,
      ) !== canonicalAnalysisJson(envelope.request) ||
      canonicalAnalysisJson(
        (job.request_payload as Record<string, unknown>).progressive,
      ) !== canonicalAnalysisJson(envelope.scope)
    )
      throw new Error(
        "Remote progress conflicts with immutable hub execution ownership",
      );
    const [stored] =
      await connection.execute(sql`SELECT report.sequence, report.content_signature, report.report,
        EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
          WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence) AS progress_applied
      FROM progressive_remote_reports report
      WHERE report.sim_job_id = ${executionId}::uuid AND (NOT EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
        WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
        OR NOT EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
          WHERE inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence))
      ORDER BY report.sequence LIMIT 1`);
    if (!stored) return { kind: "idle" as const };
    const validated = validateProgressiveRemoteReport(stored.report, envelope);
    if (validated.contentSignature !== stored.content_signature)
      throw new Error(
        "Remote progress bytes differ from their immutable receipt",
      );
    const report = validated.report;
    await indexProgressiveRemoteReport(connection, {
      report,
      reportContentSignature: validated.contentSignature,
    });
    if (stored.progress_applied)
      return { kind: "indexed" as const, sequence: report.sequence };
    await connection.execute(sql`UPDATE sim_jobs SET engine_job_id = ${executionId}, engine_state = ${report.status.state},
      completed_cases = ${report.status.completed_cases},
      status = CASE WHEN "ingestedAt" IS NOT NULL OR status = 'cancelled' THEN status ELSE ${["completed", "failed", "cancelled"].includes(report.status.state) ? "ingesting" : report.status.state === "running" ? "running" : "submitted"}::sim_job_status END,
      "updatedAt" = clock_timestamp() WHERE id = ${executionId}::uuid`);
    await persistEngineRuntimeForJob(
      connection,
      executionId,
      report.status.engine ?? report.result?.engine,
    );
    const [scope] = await connection.execute(sql`SELECT EXISTS (
      SELECT 1 FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      JOIN progressive_work work ON work.id = unit.work_id JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id AND epoch.current
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      WHERE attempt.sim_job_id = ${executionId}::uuid AND generation.status = 'active' AND work.stage = generation.stage
        AND generation.plan_revision_id = campaign.current_plan_revision_id AND campaign.status IN ('active', 'attention', 'paused')
        AND attempt.outcome = 'running' AND unit.state IN ('leased', 'blocked')) AS accepts_progress`);
    if (report.status.solver_budget_progress && scope.accepts_progress)
      await recordProgressiveCfdRuntimeProgress(connection, {
        simJobId: executionId,
        engineJobId: executionId,
        progress: report.status.solver_budget_progress,
      });
    if (report.stopProof)
      await acknowledgeProgressiveCfdExecutionStop(connection, {
        simJobId: executionId,
        proof: report.stopProof,
      });
    let settled: Awaited<
      ReturnType<typeof settleProgressiveCfdExecution>
    > | null = null;
    if (
      report.stopProof?.ownership_basis === "never_started_cancellation_fence"
    ) {
      const finished =
        await connection.execute(sql`UPDATE sim_jobs SET status = 'cancelled', engine_state = 'cancelled',
        "ingestedAt" = clock_timestamp(), "finishedAt" = clock_timestamp(),
        error = 'Exact remote execution fence proves this submission never started'
        WHERE id = ${executionId}::uuid AND (ingest_lease_expires_at IS NULL OR ingest_lease_expires_at <= clock_timestamp()) RETURNING id`);
      if (finished.length !== 1)
        throw new Error(
          "Never-started remote execution has an active evidence-ingestion owner",
        );
      await releaseResultClaimsForJob(connection, executionId, [
        "queued",
        "running",
      ]);
      settled = await settleProgressiveCfdExecution(connection, executionId);
    }
    await connection.execute(sql`INSERT INTO progressive_remote_progress_receipts(sim_job_id, sequence, content_signature)
      VALUES (${executionId}::uuid, ${report.sequence}, ${validated.contentSignature})`);
    return {
      kind: "applied" as const,
      sequence: report.sequence,
      stopped: report.stopProof !== null,
      settled,
    };
  });
}

export async function reconcileProgressiveRemoteProgress(db: DB) {
  const receipt = {
    applied: 0,
    indexed: 0,
    stopped: 0,
    settled: 0,
    waiting: 0,
    errors: [] as Array<{ executionId: string; reason: string }>,
  };
  const jobs =
    await db.execute(sql`SELECT report.sim_job_id FROM progressive_remote_reports report JOIN sim_jobs job ON job.id = report.sim_job_id
    WHERE NOT EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
      OR NOT EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory WHERE inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence)
      OR (EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped WHERE stopped.sim_job_id = job.id)
        AND EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt WHERE attempt.sim_job_id = job.id AND attempt.outcome = 'running'))
      OR (job.status IN ('done', 'failed', 'cancelled') AND EXISTS (
        SELECT 1 FROM progressive_remote_dispatches dispatch JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
        WHERE dispatch.sim_job_id = job.id AND promise.status = 'active'
      ))
    GROUP BY report.sim_job_id, job."polledAt", job."updatedAt" ORDER BY coalesce(job."polledAt", job."updatedAt"), report.sim_job_id LIMIT 32`);
  for (const job of jobs) {
    const executionId = String(job.sim_job_id);
    try {
      const result = await applyProgressiveRemoteProgress(db, executionId);
      if (result.kind === "indexed") receipt.indexed += 1;
      if (result.kind === "applied") {
        receipt.applied += 1;
        if (result.stopped) receipt.stopped += 1;
      }
      if (result.kind === "idle") {
        const terminal = await settleProgressiveRemoteJob(db, executionId);
        if (terminal.kind === "settled") receipt.settled += 1;
        else receipt.waiting += 1;
      }
    } catch (error) {
      await db.execute(
        sql`UPDATE sim_jobs SET "updatedAt" = clock_timestamp() WHERE id = ${executionId}::uuid`,
      );
      receipt.errors.push({
        executionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      await db.execute(
        sql`UPDATE sim_jobs SET "polledAt" = clock_timestamp() WHERE id = ${executionId}::uuid`,
      );
    }
  }
  return receipt;
}
