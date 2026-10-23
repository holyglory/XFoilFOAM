import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { acquireProgressiveAdmissionLock } from "./progressive-admission-lock";
import { releaseResultClaimsForJob } from "./result-claim-lifecycle";

export const STALE_CANCEL_PENDING_REASON =
  "Stale cancellation released during disposable solver reset";

export async function recoverStaleProgressiveCancellations(
  db: DB,
  input: { campaignId: string; expectedJobs: number; olderThanMinutes?: number },
) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.campaignId) ||
    !Number.isSafeInteger(input.expectedJobs) ||
    input.expectedJobs < 0 ||
    input.expectedJobs > 100 ||
    (input.olderThanMinutes !== undefined &&
      (!Number.isSafeInteger(input.olderThanMinutes) ||
        input.olderThanMinutes < 60 ||
        input.olderThanMinutes > 24 * 30))
  )
    throw new Error("Stale cancellation recovery input is invalid");
  const olderThanMinutes = input.olderThanMinutes ?? 60;
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await acquireProgressiveAdmissionLock(connection);
    const candidates = await connection.execute(sql`
      SELECT job.id
      FROM sim_jobs job
      JOIN progressive_cfd_attempts attempt ON attempt.sim_job_id=job.id
      JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
      JOIN progressive_work work ON work.id=unit.work_id
      JOIN progressive_generations generation ON generation.id=work.generation_id
      JOIN sim_campaigns campaign ON campaign.id=generation.campaign_id
      WHERE campaign.id=${input.campaignId}::uuid
        AND generation.status='active'
        AND generation.plan_revision_id=campaign.current_plan_revision_id
        AND campaign.status IN ('active','attention','paused')
        AND job.status='cancelled' AND job.engine_state='cancel_pending'
        AND job.completed_cases=0
        AND job."updatedAt" <= clock_timestamp() - (${olderThanMinutes}::int * interval '1 minute')
        AND attempt.outcome='running'
        AND NOT EXISTS (SELECT 1 FROM progressive_cfd_evidence evidence WHERE evidence.attempt_token=attempt.token)
        AND NOT EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stop WHERE stop.sim_job_id=job.id)
      GROUP BY job.id
      ORDER BY job.id LIMIT ${input.expectedJobs}::int FOR UPDATE OF job SKIP LOCKED
    `);
    if (candidates.length !== input.expectedJobs)
      throw new Error(`Stale cancellation candidate count changed: expected ${input.expectedJobs}, found ${candidates.length}`);
    let releasedUnits = 0;
    for (const candidate of candidates) {
      const jobId = String(candidate.id);
      const attempts = await connection.execute(sql`
        UPDATE progressive_cfd_attempts SET outcome='failed',finished_at=clock_timestamp(),error=${STALE_CANCEL_PENDING_REASON}
        WHERE sim_job_id=${jobId}::uuid AND outcome='running' RETURNING token
      `);
      const units = await connection.execute(sql`
        UPDATE progressive_cfd_units unit SET state='gap',lease_token=NULL,lease_owner=NULL,lease_until=NULL,
          retry_after=NULL,error=${STALE_CANCEL_PENDING_REASON}
        FROM progressive_cfd_attempts attempt
        WHERE attempt.sim_job_id=${jobId}::uuid AND attempt.unit_id=unit.id AND attempt.error=${STALE_CANCEL_PENDING_REASON}
        RETURNING unit.id
      `);
      await connection.execute(sql`
        UPDATE progressive_work work SET state='gap',completed_at=clock_timestamp(),error=${STALE_CANCEL_PENDING_REASON}
        FROM progressive_cfd_units unit JOIN progressive_cfd_attempts attempt ON attempt.unit_id=unit.id
        WHERE attempt.sim_job_id=${jobId}::uuid AND work.id=unit.work_id
      `);
      await connection.execute(sql`
        UPDATE sim_jobs SET engine_state='cancelled',"updatedAt"=clock_timestamp(),error=${STALE_CANCEL_PENDING_REASON}
        WHERE id=${jobId}::uuid AND status='cancelled'
      `);
      await releaseResultClaimsForJob(connection, jobId, ["queued", "running"]);
      if (!attempts.length) throw new Error(`Stale cancellation changed no attempts for ${jobId}`);
      releasedUnits += units.length;
    }
    return { candidateJobs: candidates.length, releasedUnits };
  });
}
