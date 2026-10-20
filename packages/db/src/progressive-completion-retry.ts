import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { acquireProgressiveAdmissionLock } from "./progressive-admission-lock";

const COMPLETION_RETRY_REASONS = [
  "terminal execution has no measured case evidence",
  "fast pass has no informative accepted evidence",
  "precise evidence remains unresolved",
] as const;

export async function requeueProgressiveCompletionRetries(
  db: DB,
  input: { campaignId: string; expectedCount: number },
) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.campaignId) ||
    !Number.isSafeInteger(input.expectedCount) ||
    input.expectedCount < 1 ||
    input.expectedCount > 2048
  )
    throw new Error("Completion retry requires an exact campaign and bounded count");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await acquireProgressiveAdmissionLock(connection);
    const units = await connection.execute(sql`
      SELECT unit.id, unit.work_id
      FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id
      JOIN sim_jobs job ON job.id = attempt.sim_job_id
      JOIN progressive_cfd_execution_stops stopped
        ON stopped.sim_job_id = attempt.sim_job_id
        AND stopped.engine_job_id = attempt.sim_job_id::text
      WHERE generation.campaign_id = ${input.campaignId}::uuid
        AND generation.status = 'active'
        AND generation.plan_revision_id = campaign.current_plan_revision_id
        AND campaign.status IN ('active', 'attention', 'paused')
        AND work.state IN ('pending', 'gap')
        AND unit.state = 'gap'
        AND unit.attempts = 2
        AND unit.active_seconds < unit.active_budget_seconds
        AND attempt.outcome = 'failed'
        AND attempt.error IN (${sql.join(COMPLETION_RETRY_REASONS.map((reason) => sql`${reason}`), sql`, `)})
        AND unit.error = attempt.error
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts newer
          WHERE newer.unit_id = unit.id
            AND (newer.started_at, newer.token) > (attempt.started_at, attempt.token)
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts running
          WHERE running.unit_id = unit.id AND running.outcome = 'running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_evidence evidence
          WHERE evidence.attempt_token IN (
            SELECT history.token FROM progressive_cfd_attempts history
            WHERE history.unit_id = unit.id
          )
          AND EXISTS (
            SELECT 1 FROM result_attempts raw
            JOIN result_classifications classification
              ON classification.result_attempt_id = raw.id
              AND classification.state = 'accepted'
            WHERE raw.id = evidence.result_attempt_id
              AND raw.status = 'done' AND raw.valid_for_polar
          )
        )
      ORDER BY generation.created_at, generation.id, unit.id
      LIMIT ${input.expectedCount}::int
      FOR UPDATE OF work, unit, attempt SKIP LOCKED
    `);
    if (units.length !== input.expectedCount)
      throw new Error(
        `Completion retry candidate count changed: expected ${input.expectedCount}, found ${units.length}`,
      );
    for (const unit of units) {
      await connection.execute(sql`
        UPDATE progressive_cfd_units
        SET state = 'pending', lease_token = NULL, lease_owner = NULL,
          lease_until = NULL, retry_after = NULL,
          error = 'Completion retry admitted after an under-budget unresolved attempt'
        WHERE id = ${unit.id}::uuid AND state = 'gap' AND attempts = 2
      `);
      await connection.execute(sql`
        UPDATE progressive_work SET state = 'pending', error = NULL, completed_at = NULL
        WHERE id = ${unit.work_id}::uuid AND state = 'gap'
      `);
    }
    return { requeued: units.length };
  });
}
