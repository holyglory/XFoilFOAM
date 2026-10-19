import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { acquireProgressiveAdmissionLock } from "./progressive-admission-lock";

export const STALE_HZ_RESET_REASON =
  "Stale HZ remote execution released during disposable solver reset";

export type ProgressiveRemoteStaleRecoveryInput = {
  campaignId: string;
  expectedJobs: number;
  olderThanMinutes?: number;
};

export type ProgressiveRemoteStaleRecoveryResult = {
  candidateJobs: number;
  releasedJobs: string[];
  releasedUnits: number;
};

function assertInput(input: ProgressiveRemoteStaleRecoveryInput) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.campaignId) ||
    !Number.isSafeInteger(input.expectedJobs) ||
    input.expectedJobs < 1 ||
    input.expectedJobs > 100 ||
    (input.olderThanMinutes !== undefined &&
      (!Number.isSafeInteger(input.olderThanMinutes) ||
        input.olderThanMinutes < 60 ||
        input.olderThanMinutes > 24 * 30))
  )
    throw new Error(
      "Stale HZ recovery requires an exact campaign UUID and bounded expected job count",
    );
}

export async function recoverStaleProgressiveRemoteDispatches(
  db: DB,
  input: ProgressiveRemoteStaleRecoveryInput,
): Promise<ProgressiveRemoteStaleRecoveryResult> {
  assertInput(input);
  const olderThanMinutes = input.olderThanMinutes ?? 360;
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await acquireProgressiveAdmissionLock(connection);
    const candidates = await connection.execute(sql`
      SELECT job.id, promise.id AS promise_id
      FROM sim_jobs job
      JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id = job.id
      JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
      JOIN sim_campaigns campaign ON campaign.id = job.campaign_id
      WHERE job.campaign_id = ${input.campaignId}::uuid
        AND job.status IN ('pending', 'submitted', 'running', 'ingesting')
        AND promise.status IN ('expired', 'cancelled')
        AND job."updatedAt" <= clock_timestamp() - (${olderThanMinutes}::int * interval '1 minute')
        AND campaign.status IN ('active', 'attention', 'paused')
        AND EXISTS (
          SELECT 1
          FROM progressive_cfd_attempts attempt
          JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
          JOIN progressive_work work ON work.id = unit.work_id
          JOIN progressive_generations generation ON generation.id = work.generation_id
          WHERE attempt.sim_job_id = job.id
            AND attempt.outcome = 'running'
            AND unit.state = 'leased' AND unit.lease_token = attempt.token
            AND generation.status = 'active'
            AND generation.plan_revision_id = campaign.current_plan_revision_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_remote_reports report
          WHERE report.sim_job_id = job.id
            AND NOT EXISTS (
              SELECT 1 FROM progressive_remote_progress_receipts receipt
              WHERE receipt.sim_job_id = report.sim_job_id
                AND receipt.sequence = report.sequence
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM progressive_cfd_evidence evidence
          JOIN progressive_cfd_attempts evidence_attempt
            ON evidence_attempt.token = evidence.attempt_token
          WHERE evidence_attempt.sim_job_id = job.id
        )
      ORDER BY job."updatedAt", job.id
      LIMIT ${input.expectedJobs}::int
      FOR UPDATE OF job, promise SKIP LOCKED
    `);
    if (candidates.length !== input.expectedJobs)
      throw new Error(
        `Stale HZ recovery candidate count changed: expected ${input.expectedJobs}, found ${candidates.length}`,
      );

    const releasedJobs: string[] = [];
    let releasedUnits = 0;
    for (const candidate of candidates) {
      const jobId = String(candidate.id);
      const promiseId = String(candidate.promise_id);
      const [updatedAttempts] = await connection.execute(sql`
        UPDATE progressive_cfd_attempts attempt
        SET outcome = 'failed', finished_at = clock_timestamp(),
          error = ${STALE_HZ_RESET_REASON}
        WHERE attempt.sim_job_id = ${jobId}::uuid AND attempt.outcome = 'running'
      `);
      const [updatedUnits] = await connection.execute(sql`
        UPDATE progressive_cfd_units unit
        SET state = 'gap', lease_token = NULL, lease_owner = NULL,
          lease_until = NULL, retry_after = NULL, error = ${STALE_HZ_RESET_REASON}
        FROM progressive_cfd_attempts attempt
        WHERE attempt.sim_job_id = ${jobId}::uuid
          AND attempt.unit_id = unit.id
          AND attempt.error = ${STALE_HZ_RESET_REASON}
      `);
      await connection.execute(sql`
        UPDATE progressive_work work
        SET state = 'pending', error = NULL, completed_at = NULL
        FROM progressive_cfd_units unit
        JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id
        WHERE attempt.sim_job_id = ${jobId}::uuid
          AND work.id = unit.work_id
          AND work.state IN ('pending', 'gap')
      `);
      await connection.execute(sql`
        UPDATE sim_jobs
        SET status = 'cancelled', engine_state = 'cancelled',
          "finishedAt" = coalesce("finishedAt", clock_timestamp()),
          "updatedAt" = clock_timestamp(), error = ${STALE_HZ_RESET_REASON},
          ingest_lease_token = NULL, ingest_lease_claimed_at = NULL,
          ingest_lease_expires_at = NULL
        WHERE id = ${jobId}::uuid
      `);
      await connection.execute(sql`
        UPDATE sync_sweep_promises
        SET status = 'cancelled', "cancelledAt" = coalesce("cancelledAt", clock_timestamp()),
          "updatedAt" = clock_timestamp(),
          response_payload = coalesce(response_payload, '{}'::jsonb) ||
            jsonb_build_object(
              'authoritativeLeaseLoss', true,
              'remoteCancellation', jsonb_build_object(
                'disposition', 'operator_release',
                'reason', ${STALE_HZ_RESET_REASON}::text
              )
            )
        WHERE id = ${promiseId}::uuid
      `);
      await connection.execute(sql`
        UPDATE sync_sweep_promise_points
        SET status = 'cancelled', "updatedAt" = clock_timestamp()
        WHERE promise_id = ${promiseId}::uuid AND status = 'active'
      `);
      releasedJobs.push(jobId);
      releasedUnits += Number(updatedUnits.count ?? updatedUnits.length ?? 0);
      if (!Number(updatedAttempts.count ?? updatedAttempts.length))
        throw new Error(`Stale HZ recovery changed no attempts for ${jobId}`);
    }
    return {
      candidateJobs: candidates.length,
      releasedJobs,
      releasedUnits,
    };
  });
}
