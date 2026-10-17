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
import { effectiveProgressiveStageSql } from "@aerodb/db/progressive-execution-policy";
import { releaseResultClaimsForJob } from "@aerodb/db/result-claim-lifecycle";
import { indexProgressiveRemoteReport } from "@aerodb/db/progressive-remote-inventory";
import { persistEngineRuntimeForJob } from "./engine-provenance";
import { settleProgressiveRemoteJob } from "./progressive-remote-settlement";
import { activeReconcileConcurrency, runWithConcurrency } from "./reconcile";
import {
  progressiveReportJobsSql,
  progressiveSettlementJobsSql,
} from "./progressive-progress-selection";

const MAX_PROGRESSIVE_REPORTS_PER_EXECUTION = 16;
const MAX_PROGRESSIVE_CAMPAIGN_JOBS_PER_RECONCILIATION = 16;

async function applyProgressiveRemoteProgressInTransaction(
  db: DB,
  executionId: string,
) {
  const connection = db;
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
    const [campaign] = await connection.execute(sql`SELECT campaign.id FROM sim_campaigns campaign JOIN sim_jobs job ON job.campaign_id = campaign.id
      WHERE job.id = ${executionId}::uuid FOR UPDATE OF campaign SKIP LOCKED`);
    if (!campaign) return { kind: "waiting" as const };
    const [job] = await connection.execute(
      sql`SELECT engine_job_id, status, engine_state, completed_cases, request_payload
      FROM sim_jobs WHERE id = ${executionId}::uuid FOR UPDATE`,
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
    let [stored] =
      await connection.execute(sql`SELECT report.sequence, report.content_signature, report.report,
        EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
          WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence) AS progress_applied,
        EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
          WHERE inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence) AS progress_indexed
      FROM progressive_remote_reports report
      WHERE report.sim_job_id = ${executionId}::uuid AND (NOT EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
        WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
        OR NOT EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
          WHERE inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence))
      ORDER BY report.sequence LIMIT 1`);
    if (!stored && job.engine_job_id === null && job.status === "pending") {
      [stored] =
        await connection.execute(sql`SELECT report.sequence, report.content_signature, report.report,
        TRUE AS progress_applied, TRUE AS progress_indexed
      FROM progressive_remote_reports report
      WHERE report.sim_job_id = ${executionId}::uuid
        AND EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
          WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
        AND EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
          WHERE inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence)
      ORDER BY report.sequence DESC LIMIT 1`);
    }
    if (!stored) return { kind: "idle" as const };
    const validated = validateProgressiveRemoteReport(stored.report, envelope);
    if (validated.contentSignature !== stored.content_signature)
      throw new Error(
        "Remote progress bytes differ from their immutable receipt",
      );
    const report = validated.report;
    if (!stored.progress_indexed)
      await indexProgressiveRemoteReport(connection, {
        report,
        reportContentSignature: validated.contentSignature,
      });
    const jobReflectsReport =
      job.engine_job_id === executionId &&
      job.engine_state !== null &&
      job.status !== "pending" &&
      Number(job.completed_cases) >= report.status.completed_cases;
    if (stored.progress_applied && jobReflectsReport)
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
      WHERE attempt.sim_job_id = ${executionId}::uuid AND generation.status = 'active' AND work.stage = ${effectiveProgressiveStageSql()}
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
    if (!stored.progress_applied)
      await connection.execute(sql`INSERT INTO progressive_remote_progress_receipts(sim_job_id, sequence, content_signature)
        VALUES (${executionId}::uuid, ${report.sequence}, ${validated.contentSignature})`);
  return {
    kind: "applied" as const,
    sequence: report.sequence,
    stopped: report.stopProof !== null,
    settled,
  };
}

export async function applyProgressiveRemoteProgress(
  db: DB,
  executionId: string,
) {
  return db.transaction(async (transaction) =>
    applyProgressiveRemoteProgressInTransaction(
      transaction as unknown as DB,
      executionId,
    ),
  );
}

async function applyProgressiveRemoteProgressBatch(
  db: DB,
  executionId: string,
) {
  const batchReceipt = {
    applied: 0,
    indexed: 0,
    stopped: 0,
    idle: false,
    errors: [] as Array<{ executionId: string; reason: string }>,
  };
  for (
    let reportPass = 0;
    reportPass < MAX_PROGRESSIVE_REPORTS_PER_EXECUTION;
    reportPass += 1
  ) {
    try {
      const result = await db.transaction(async (transaction) =>
        applyProgressiveRemoteProgressInTransaction(
          transaction as unknown as DB,
          executionId,
        ),
      );
      if (result.kind === "indexed") batchReceipt.indexed += 1;
      if (result.kind === "applied") {
        batchReceipt.applied += 1;
        if (result.stopped) batchReceipt.stopped += 1;
      }
      if (result.kind === "idle") {
        batchReceipt.idle = true;
        break;
      }
      if (result.kind === "waiting") break;
    } catch (error) {
      batchReceipt.errors.push({
        executionId,
        reason: error instanceof Error ? error.message : String(error),
      });
      break;
    }
  }
  return batchReceipt;
}

type ProgressiveProgressJob = {
  sim_job_id: string;
  campaign_id: string;
};

type ProgressiveProgressReceipt = {
  applied: number;
  indexed: number;
  stopped: number;
  settled: number;
  waiting: number;
  errors: Array<{ executionId: string; reason: string }>;
};

async function reconcileProgressiveRemoteCampaign(
  db: DB,
  _campaignId: string,
  jobs: readonly ProgressiveProgressJob[],
): Promise<ProgressiveProgressReceipt> {
  const receipt: ProgressiveProgressReceipt = {
    applied: 0,
    indexed: 0,
    stopped: 0,
    settled: 0,
    waiting: 0,
    errors: [],
  };

  for (const job of jobs.slice(
    0,
    MAX_PROGRESSIVE_CAMPAIGN_JOBS_PER_RECONCILIATION,
  )) {
    const executionId = String(job.sim_job_id);
    try {
      const batch = await applyProgressiveRemoteProgressBatch(db, executionId);
      receipt.applied += batch.applied;
      receipt.indexed += batch.indexed;
      receipt.stopped += batch.stopped;
      receipt.errors.push(...batch.errors);
      if (batch.idle && batch.errors.length === 0) {
        const terminal = await settleProgressiveRemoteJob(db, executionId);
        if (terminal.kind === "settled") receipt.settled += 1;
        else receipt.waiting += 1;
      }
      await db.execute(
        sql`UPDATE sim_jobs SET "polledAt" = clock_timestamp() WHERE id = ${executionId}::uuid`,
      );
    } catch (error) {
      receipt.errors.push({
        executionId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return receipt;
}

export async function reconcileProgressiveRemoteProgress(
  db: DB,
  options: { jobIds?: string[] } = {},
) {
  if (
    options.jobIds &&
    (options.jobIds.length > 32 ||
      new Set(options.jobIds).size !== options.jobIds.length ||
      options.jobIds.some(
        (id) =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            id,
          ),
      ))
  )
    throw new Error("Invalid bounded progressive progress scope");
  const receipt = {
    applied: 0,
    indexed: 0,
    stopped: 0,
    settled: 0,
    waiting: 0,
    errors: [] as Array<{ executionId: string; reason: string }>,
  };
  if (options.jobIds?.length === 0) return receipt;
  const jobs = await db.execute(progressiveReportJobsSql(options.jobIds));
  const terminalJobs = await db.execute(
    progressiveSettlementJobsSql(options.jobIds),
  );
  const selectedJobs = [...jobs, ...terminalJobs] as unknown as Array<ProgressiveProgressJob>;
  const groupedJobs = new Map<string, ProgressiveProgressJob[]>();
  for (const job of selectedJobs) {
    const campaignJobs = groupedJobs.get(String(job.campaign_id)) ?? [];
    if (!campaignJobs.some((candidate) => candidate.sim_job_id === job.sim_job_id))
      campaignJobs.push(job);
    groupedJobs.set(String(job.campaign_id), campaignJobs);
  }
  await runWithConcurrency(
    [...groupedJobs.entries()],
    activeReconcileConcurrency(),
    async ([campaignId, campaignJobs]) => {
      try {
        const batch = await reconcileProgressiveRemoteCampaign(
          db,
          campaignId,
          campaignJobs,
        );
        receipt.applied += batch.applied;
        receipt.indexed += batch.indexed;
        receipt.stopped += batch.stopped;
        receipt.errors.push(...batch.errors);
        receipt.waiting += batch.waiting;
      } catch (error) {
        receipt.errors.push({
          executionId: campaignId,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
  return receipt;
}
