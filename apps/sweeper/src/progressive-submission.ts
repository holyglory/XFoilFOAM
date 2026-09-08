import { and, eq, inArray, sql } from "drizzle-orm";
import {
  acknowledgeProgressiveCfdExecutionStop,
  settleProgressiveCfdExecution,
  simJobs,
  solverLocalExecutionSql,
  type DB,
} from "@aerodb/db";
import { releaseResultClaimsForJob } from "@aerodb/db/result-claim-lifecycle";
import type { EngineClient, PolarRequest } from "@aerodb/engine-client";
import {
  expectedEngineForJob,
  expectedExecutionPoolForJob,
} from "./engine-routing";

export async function recoverProgressiveSubmissions(
  db: DB,
  engine: Pick<EngineClient, "cancelJob" | "getExecutionStopProof">,
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
    throw new Error("Invalid progressive submission recovery scope");
  const receipt = {
    inspected: 0,
    fenced: 0,
    neverStarted: 0,
    awaitingIngest: 0,
    waiting: 0,
    errors: [] as Array<{ jobId: string; error: string }>,
  };
  const [role] = await db.execute(
    sql`SELECT remote_solver_enabled FROM sync_api_settings LIMIT 1`,
  );
  if (role?.remote_solver_enabled || options.jobIds?.length === 0)
    return receipt;
  const filter = options.jobIds
    ? sql`AND job.id IN (${sql.join(
        options.jobIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql``;
  const candidates = await db.execute(sql`
    SELECT job.id FROM sim_jobs job
    WHERE job.request_payload->'progressive' IS NOT NULL
      AND ${solverLocalExecutionSql("job")}
      AND job.status IN ('pending', 'cancelled', 'failed')
      AND (job.engine_job_id IS NULL OR job.engine_state = 'submission_cancel_pending')
      AND (job.ingest_lease_expires_at IS NULL OR job.ingest_lease_expires_at <= clock_timestamp())
      AND EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt
        JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
        JOIN progressive_work work ON work.id = unit.work_id
        JOIN progressive_generations generation ON generation.id = work.generation_id
        JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id
        JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
        WHERE attempt.sim_job_id = job.id AND attempt.outcome = 'running'
          AND (job.status <> 'pending' OR job.engine_state = 'submission_cancel_pending'
            OR generation.status = 'cancelled' OR NOT epoch.current
            OR generation.plan_revision_id IS DISTINCT FROM campaign.current_plan_revision_id
            OR campaign.status IN ('cancelled', 'archived')
            OR (unit.lease_until <= clock_timestamp() AND job."updatedAt" <= clock_timestamp() - interval '90 seconds')))
      ${filter} ORDER BY job."updatedAt", job.id LIMIT ${limit}
  `);
  for (const candidate of candidates) {
    const jobId = String(candidate.id);
    receipt.inspected += 1;
    try {
      const [job] = await db
        .select()
        .from(simJobs)
        .where(eq(simJobs.id, jobId));
      const payload = job?.requestPayload as {
        engineRequest?: PolarRequest;
        progressive?: { executionId?: string };
      } | null;
      if (
        !job ||
        payload?.progressive?.executionId !== jobId ||
        payload.engineRequest?.execution_id !== jobId ||
        (job.engineJobId !== null && job.engineJobId !== jobId)
      )
        throw new Error(
          "Submission recovery has no exact immutable execution identity",
        );
      const route = {
        expectedEngine: expectedEngineForJob(job),
        expectedExecutionPool: await expectedExecutionPoolForJob(db, job),
        timeoutMs: 10_000,
      };
      const cancellation = await engine.cancelJob(jobId, {
        ...route,
        unregisteredExecution: {
          expected_engine: route.expectedEngine,
          expected_execution_pool: route.expectedExecutionPool,
        },
      });
      if (cancellation.job_id !== jobId || !cancellation.cancelled)
        throw new Error(
          "Engine did not acknowledge the exact submission cancellation",
        );
      const [owned] = await db
        .update(simJobs)
        .set({
          engineJobId: jobId,
          engineState: "submission_cancel_pending",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(simJobs.id, jobId),
            inArray(simJobs.status, ["pending", "cancelled", "failed"]),
            sql`(${simJobs.engineJobId} IS NULL OR ${simJobs.engineJobId} = ${jobId})`,
            sql`(${simJobs.ingestLeaseExpiresAt} IS NULL OR ${simJobs.ingestLeaseExpiresAt} <= clock_timestamp())`,
          ),
        )
        .returning({ id: simJobs.id });
      if (!owned) {
        receipt.waiting += 1;
        continue;
      }
      receipt.fenced += 1;
      const proof = await engine.getExecutionStopProof(jobId, route);
      if (proof.job_id !== jobId)
        throw new Error("Submission stop proof belongs to another execution");
      if (!proof.execution_stopped) {
        receipt.waiting += 1;
        continue;
      }
      await acknowledgeProgressiveCfdExecutionStop(db, {
        simJobId: jobId,
        proof,
      });
      if (proof.ownership_basis === "never_started_cancellation_fence") {
        await db.transaction(async (transaction) => {
          const connection = transaction as unknown as DB;
          const [evidence] = await connection.execute(sql`
            SELECT EXISTS (SELECT 1 FROM progressive_cfd_evidence receipt JOIN progressive_cfd_attempts attempt
              ON attempt.token = receipt.attempt_token WHERE attempt.sim_job_id = ${jobId}) AS present
          `);
          if (evidence?.present)
            throw new Error(
              "Never-started submission conflicts with stored case evidence",
            );
          const [finished] = await connection
            .update(simJobs)
            .set({
              status: "cancelled",
              engineState: "cancelled",
              ingestedAt: new Date(),
              finishedAt: new Date(),
              updatedAt: new Date(),
              error:
                "Exact engine cancellation proves this submission never started",
            })
            .where(
              and(
                eq(simJobs.id, jobId),
                eq(simJobs.engineJobId, jobId),
                eq(simJobs.engineState, "submission_cancel_pending"),
                sql`(${simJobs.ingestLeaseExpiresAt} IS NULL OR ${simJobs.ingestLeaseExpiresAt} <= clock_timestamp())`,
              ),
            )
            .returning({ id: simJobs.id });
          if (!finished)
            throw new Error(
              "Submission ownership changed before no-start settlement",
            );
          await releaseResultClaimsForJob(connection, jobId, [
            "queued",
            "running",
          ]);
        });
        await settleProgressiveCfdExecution(db, jobId);
        receipt.neverStarted += 1;
      } else {
        await db
          .update(simJobs)
          .set({
            status: "submitted",
            engineState: "cancelled",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(simJobs.id, jobId),
              eq(simJobs.engineJobId, jobId),
              eq(simJobs.engineState, "submission_cancel_pending"),
            ),
          );
        receipt.awaitingIngest += 1;
      }
    } catch (error) {
      receipt.errors.push({ jobId, error: String(error) });
    }
  }
  return receipt;
}
