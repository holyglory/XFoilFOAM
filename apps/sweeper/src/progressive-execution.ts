import { eq, sql } from "drizzle-orm";
import { EngineError, type EngineClient } from "@aerodb/engine-client";
import {
  acknowledgeProgressiveCfdExecutionStop,
  assertProgressiveExecutionIdentity,
  settleProgressiveCfdExecution,
  simJobs,
  solverLocalExecutionSql,
  type DB,
} from "@aerodb/db";
import { releaseResultClaimsForJob } from "@aerodb/db/result-claim-lifecycle";
import {
  expectedEngineForJob,
  expectedExecutionPoolForJob,
} from "./engine-routing";

type StopEngine = Pick<EngineClient, "cancelJob" | "getExecutionStopProof">;

async function releaseMissingCancelledExecution(db: DB, jobId: string) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [job] = await connection.execute(sql`
      SELECT status, engine_state FROM sim_jobs WHERE id = ${jobId}::uuid FOR UPDATE
    `);
    if (job?.status !== "cancelled" || job.engine_state !== "cancelled")
      return 0;
    const [evidence] = await connection.execute(sql`
      SELECT EXISTS (SELECT 1 FROM result_attempts WHERE sim_job_id = ${jobId}::uuid)
        OR EXISTS (SELECT 1 FROM progressive_cfd_evidence evidence
          JOIN progressive_cfd_attempts attempt ON attempt.token = evidence.attempt_token
          WHERE attempt.sim_job_id = ${jobId}::uuid) AS present
    `);
    if (evidence?.present === true) return 0;
    const units = await connection.execute(sql`
      SELECT attempt.token, unit.id
      FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      WHERE attempt.sim_job_id = ${jobId}::uuid AND attempt.outcome = 'running'
      FOR UPDATE OF attempt, unit
    `);
    if (!units.length) return 0;
    for (const unit of units) {
      await connection.execute(sql`UPDATE progressive_cfd_attempts
        SET outcome = 'cancelled', finished_at = clock_timestamp(),
          error = 'Engine execution disappeared after cancellation without stored solver evidence'
        WHERE token = ${unit.token}::uuid`);
      await connection.execute(sql`UPDATE progressive_cfd_units
        SET state = 'gap', lease_token = NULL, lease_owner = NULL, lease_until = NULL,
          error = 'Engine execution disappeared after cancellation without stored solver evidence'
        WHERE id = ${unit.id}::uuid`);
    }
    await connection.execute(sql`UPDATE sim_jobs SET "ingestedAt" = coalesce("ingestedAt", clock_timestamp()),
      "finishedAt" = coalesce("finishedAt", clock_timestamp()), "updatedAt" = clock_timestamp(),
      error = 'Engine execution disappeared after cancellation without stored solver evidence'
      WHERE id = ${jobId}::uuid`);
    await releaseResultClaimsForJob(connection, jobId, ["queued", "running"]);
    return units.length;
  });
}

export async function reconcileProgressiveExecutions(
  db: DB,
  engine: StopEngine,
  options: { jobIds?: string[]; limit?: number } = {},
) {
  const limit = options.limit ?? 16;
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 64 ||
    (options.jobIds &&
      (options.jobIds.length > 64 ||
        new Set(options.jobIds).size !== options.jobIds.length))
  )
    throw new Error("Invalid progressive execution reconciliation scope");
  const receipt = {
    inspected: 0,
    acknowledged: 0,
    stopRequests: 0,
    complete: 0,
    retry: 0,
    gaps: 0,
    cancelled: 0,
    waiting: 0,
    errors: [] as Array<{ jobId: string; error: string }>,
  };
  if (options.jobIds?.length === 0) return receipt;
  const filter = options.jobIds
    ? sql`AND job.id IN (${sql.join(
        options.jobIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const candidates = await db.execute(sql`
    SELECT job.id FROM sim_jobs job
    JOIN LATERAL (
      SELECT bool_or(attempt.outcome = 'running') AS unsettled,
        bool_or((unit.active_seconds >= unit.active_budget_seconds AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_evidence receipt WHERE receipt.attempt_token = attempt.token AND receipt.budget_guard_exhausted
        ) AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_runtime_progress runtime WHERE runtime.attempt_token = attempt.token AND runtime.engine_job_id = job.engine_job_id
        )) OR NOT epoch.current
          OR generation.status <> 'active' OR generation.plan_revision_id IS DISTINCT FROM campaign.current_plan_revision_id
          OR campaign.status NOT IN ('active', 'attention', 'paused')) AS stop_required
      FROM progressive_cfd_attempts attempt JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      WHERE attempt.sim_job_id = job.id
    ) scope ON true
    LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = job.id
    WHERE job.engine_job_id IS NOT NULL AND job.request_payload->'progressive' IS NOT NULL
      AND ${solverLocalExecutionSql("job")}
      AND ((scope.unsettled AND job.status IN ('done', 'failed', 'cancelled'))
        OR (scope.stop_required AND stopped.sim_job_id IS NULL))
      ${filter}
    ORDER BY job."updatedAt", job.id LIMIT ${limit}
  `);
  for (const candidate of candidates) {
    const jobId = String(candidate.id);
    receipt.inspected += 1;
    try {
      const [job] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      if (!job?.engineJobId) continue;
      assertProgressiveExecutionIdentity(
        job.id,
        job.engineJobId,
        job.requestPayload,
      );
      const [stopped] = await db.execute(sql`
        SELECT sim_job_id FROM progressive_cfd_execution_stops WHERE sim_job_id = ${jobId}
      `);
      if (!stopped) {
        const route = {
          expectedEngine: expectedEngineForJob(job),
          expectedExecutionPool: await expectedExecutionPoolForJob(db, job),
          timeoutMs: 10_000,
        };
        if (!["done", "failed", "cancelled"].includes(job.status)) {
          const cancellation = await engine.cancelJob(job.engineJobId, route);
          if (
            cancellation.job_id !== job.engineJobId ||
            !cancellation.cancelled
          )
            throw new Error(
              "Engine did not acknowledge cancellation of the exact progressive job",
            );
          receipt.stopRequests += 1;
        }
        let proof;
        try {
          proof = await engine.getExecutionStopProof(job.engineJobId, route);
        } catch (error) {
          if (!(error instanceof EngineError && error.status === 404))
            throw error;
          const released = await releaseMissingCancelledExecution(db, jobId);
          if (!released) throw error;
          receipt.gaps += released;
          continue;
        }
        if (proof.job_id !== job.engineJobId)
          throw new Error("Execution-stop proof belongs to another engine job");
        if (!proof.execution_stopped) {
          if (["done", "failed", "cancelled"].includes(job.status)) {
            const cancellation = await engine.cancelJob(job.engineJobId, route);
            if (
              cancellation.job_id !== job.engineJobId ||
              !cancellation.cancelled
            )
              throw new Error(
                "Engine did not acknowledge cancellation of the exact progressive job",
              );
            receipt.stopRequests += 1;
          }
          receipt.waiting += 1;
          continue;
        }
        const acknowledgement = await acknowledgeProgressiveCfdExecutionStop(
          db,
          { simJobId: jobId, proof },
        );
        if (!acknowledgement.replayed) receipt.acknowledged += 1;
      }
      if (job.status === "cancelled" && job.engineState === "cancelled") {
        const [finished] = await db.execute(sql`
          UPDATE sim_jobs SET "ingestedAt" = coalesce("ingestedAt", clock_timestamp()),
            "finishedAt" = coalesce("finishedAt", clock_timestamp()), "updatedAt" = clock_timestamp()
          WHERE id = ${jobId}::uuid AND status = 'cancelled'
            AND (ingest_lease_expires_at IS NULL OR ingest_lease_expires_at <= clock_timestamp())
          RETURNING id
        `);
        if (finished) {
          const settled = await settleProgressiveCfdExecution(db, jobId);
          receipt.complete += settled.complete;
          receipt.retry += settled.retry;
          receipt.gaps += settled.gaps;
          receipt.cancelled += settled.cancelled;
          receipt.waiting += settled.waiting;
          continue;
        }
      }
      const settled = await settleProgressiveCfdExecution(db, jobId);
      for (const key of [
        "complete",
        "retry",
        "gaps",
        "cancelled",
        "waiting",
      ] as const)
        receipt[key] += settled[key];
    } catch (error) {
      receipt.errors.push({ jobId, error: String(error) });
    }
  }
  return receipt;
}
