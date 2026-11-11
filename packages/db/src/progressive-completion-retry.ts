import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { acquireProgressiveAdmissionLock } from "./progressive-admission-lock";
import { progressiveCfdNoAcceptedHistoryAndSettledSql } from "./progressive-attempt-budget";

const COMPLETION_RETRY_REASONS = [
  "terminal execution has no measured case evidence",
  "fast pass has no informative accepted evidence",
  "precise evidence remains unresolved",
] as const;

export async function requeueProgressiveCompletionRetries(
  db: DB,
  input: { campaignId: string; expectedCount: number; unitIds?: readonly string[] },
) {
  if (
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input.campaignId) ||
    !Number.isSafeInteger(input.expectedCount) ||
    input.expectedCount < 1 ||
    input.expectedCount > 2048
  )
    throw new Error("Completion retry requires an exact campaign and bounded count");
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
  const unitIds = input.unitIds;
  if (unitIds !== undefined && (
    !Array.isArray(unitIds) ||
    unitIds.length !== input.expectedCount ||
    unitIds.some((id) => typeof id !== "string" || !uuid.test(id)) ||
    new Set(unitIds.map((id) => id.toLowerCase())).size !== unitIds.length
  ))
    throw new Error("Completion retry requires unique unit UUIDs matching the bounded count");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
    await acquireProgressiveAdmissionLock(connection);
    // Serialize pause, plan changes and settlement before dependent row locks.
    await connection.execute(sql`
      SELECT id FROM sim_campaigns WHERE id = ${input.campaignId}::uuid FOR UPDATE
    `);
    const units = await connection.execute(sql`
      SELECT unit.id, unit.work_id
      FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
      JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id
      JOIN sim_jobs job ON job.id = attempt.sim_job_id
        AND job.campaign_id = campaign.id
      JOIN progressive_cfd_execution_stops stopped
        ON stopped.sim_job_id = attempt.sim_job_id
        AND stopped.engine_job_id = job.engine_job_id
        AND stopped.engine_job_id = attempt.sim_job_id::text
      WHERE generation.campaign_id = ${input.campaignId}::uuid
        AND generation.epoch_id = ${epoch.id}::uuid
        AND generation.status = 'active'
        AND generation.plan_revision_id = campaign.current_plan_revision_id
        AND campaign.status IN ('active', 'attention', 'paused')
        AND work.state IN ('pending', 'gap')
        AND unit.state = 'gap'
        AND ${unitIds === undefined ? sql`true` : sql`unit.id IN (${sql.join(unitIds.map((id) => sql`${id}::uuid`), sql`, `)})`}
        AND unit.lease_token IS NULL
        AND unit.lease_owner IS NULL
        AND unit.lease_until IS NULL
        AND unit.attempts IN (1, 2)
        AND unit.active_seconds < unit.active_budget_seconds
        AND job.status IN ('done', 'failed', 'cancelled')
        AND attempt.outcome = 'failed'
        AND attempt.finished_at IS NOT NULL
        AND attempt.error IN (${sql.join(COMPLETION_RETRY_REASONS.map((reason) => sql`${reason}`), sql`, `)})
        AND unit.error = attempt.error
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts newer
          WHERE newer.unit_id = unit.id
            AND (newer.started_at, newer.token) > (attempt.started_at, attempt.token)
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts history
          LEFT JOIN sim_jobs history_job ON history_job.id = history.sim_job_id
          WHERE history.unit_id = unit.id
            AND (history.outcome = 'running' OR history.finished_at IS NULL
              OR history_job.status NOT IN ('done', 'failed', 'cancelled'))
        )
        AND ${progressiveCfdNoAcceptedHistoryAndSettledSql()}
      ORDER BY generation.created_at, generation.id, unit.id
      LIMIT ${input.expectedCount}::int
      FOR UPDATE OF generation, work, unit, attempt, job SKIP LOCKED
    `);
    if (units.length !== input.expectedCount)
      throw new Error(
        `Completion retry candidate count changed: expected ${input.expectedCount}, found ${units.length}`,
      );
    const requeued = await connection.execute(sql`
        UPDATE progressive_cfd_units AS unit
        SET state = 'pending', lease_token = NULL, lease_owner = NULL,
          lease_until = NULL, retry_after = NULL,
          error = CASE WHEN attempts >= 2 THEN error
            ELSE 'Completion retry admitted after an under-budget unresolved attempt' END
        WHERE id IN (${sql.join(units.map((unit) => sql`${unit.id}::uuid`), sql`, `)})
          AND state = 'gap' AND attempts IN (1, 2)
          AND active_seconds < active_budget_seconds
          AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL
          AND ${progressiveCfdNoAcceptedHistoryAndSettledSql()}
        RETURNING id
      `);
    if (requeued.length !== input.expectedCount)
      throw new Error(
        `Completion retry candidate count changed: expected ${input.expectedCount}, found ${requeued.length}`,
      );
    await connection.execute(sql`
        UPDATE progressive_work SET state = 'pending', error = NULL, completed_at = NULL
        WHERE id IN (${sql.join(units.map((unit) => sql`${unit.work_id}::uuid`), sql`, `)})
          AND state = 'gap'
      `);
    return { requeued: requeued.length };
  });
}
