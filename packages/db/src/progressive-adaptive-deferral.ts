import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { SUBSONIC_THROUGH_PRECISE_POLICY } from "./progressive-execution-policy";

export async function deferProgressiveAdaptiveFastUnits(
  db: DB,
  campaignId: string,
) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(campaignId))
    throw new Error("Adaptive fast deferral requires an exact campaign UUID");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(sql`SET LOCAL lock_timeout = '5s'`);
    await connection.execute(sql`SET LOCAL statement_timeout = '30s'`);
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    const [campaign] = await connection.execute(sql`
      SELECT status, current_plan_revision_id FROM sim_campaigns
      WHERE id = ${campaignId}::uuid FOR UPDATE
    `);
    const [policy] = await connection.execute(sql`
      SELECT policy FROM campaign_progressive_execution_policies
      WHERE campaign_id = ${campaignId}::uuid
    `);
    if (
      !epoch ||
      !campaign ||
      !policy ||
      String(policy.policy) !== SUBSONIC_THROUGH_PRECISE_POLICY ||
      !["active", "attention", "paused"].includes(String(campaign.status))
    )
      throw new Error(
        "Adaptive fast deferral requires an active subsonic-priority campaign",
      );
    const generations = await connection.execute(sql`
      SELECT generation.id FROM progressive_generations generation
      WHERE generation.campaign_id = ${campaignId}::uuid
        AND generation.epoch_id = ${epoch.id}
        AND generation.plan_revision_id = ${campaign.current_plan_revision_id}
        AND generation.status = 'active'
      ORDER BY generation.created_at, generation.id FOR UPDATE
    `);
    let deferred = 0;
    const generationIds: string[] = [];
    for (const generation of generations) {
      const [cursor] = await connection.execute(sql`
        SELECT stage, status FROM progressive_generation_cohorts
        WHERE generation_id = ${generation.id} AND cohort = 'low' FOR UPDATE
      `);
      if (!cursor || Number(cursor.stage) !== 2) continue;
      const rows = await connection.execute(sql`
        UPDATE progressive_cfd_units unit SET state = 'gap',
          lease_token = NULL, lease_owner = NULL, lease_until = NULL,
          error = 'adaptive fast refinement deferred before precise low-Mach stage'
        FROM progressive_work work
        JOIN progressive_generation_cohort_targets member
          ON member.generation_id = work.generation_id AND member.target_id = work.target_id
        WHERE unit.work_id = work.id
          AND work.generation_id = ${generation.id}
          AND work.stage = 2 AND work.state = 'pending'
          AND member.cohort = 'low' AND unit.purpose = 'adaptive' AND unit.state = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM progressive_cfd_attempts attempt
            LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = attempt.sim_job_id
            WHERE attempt.unit_id = unit.id
              AND (attempt.outcome = 'running'
                OR (attempt.sim_job_id IS NOT NULL AND stopped.sim_job_id IS NULL))
          )
        RETURNING unit.id
      `);
      if (rows.length) {
        deferred += rows.length;
        generationIds.push(String(generation.id));
      }
    }
    if (deferred)
      await connection.execute(
        sql`SELECT pg_notify('progressive_work_changed', ${campaignId})`,
      );
    return { campaignId, generationIds, deferred };
  });
}
