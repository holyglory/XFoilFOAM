import { sql } from "drizzle-orm";
import type { DB } from "./client";

export async function recoverUnboundProgressiveCfdLeases(
  db: DB,
): Promise<{ retried: number; gaps: number }> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const receipt = { retried: 0, gaps: 0 };
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
    const [campaign] = await connection.execute(sql`
      SELECT campaign.id FROM sim_campaigns campaign WHERE campaign.status IN ('active', 'attention', 'paused') AND EXISTS (
        SELECT 1 FROM progressive_generations generation JOIN progressive_work work ON work.generation_id = generation.id
        JOIN progressive_cfd_units unit ON unit.work_id = work.id
        JOIN progressive_cfd_attempts attempt ON attempt.token = unit.lease_token AND attempt.unit_id = unit.id
        WHERE generation.campaign_id = campaign.id AND generation.epoch_id = ${epoch.id}
          AND generation.plan_revision_id = campaign.current_plan_revision_id AND generation.status = 'active'
          AND generation.stage = work.stage AND work.state = 'pending'
          AND unit.state = 'leased' AND unit.lease_until <= clock_timestamp()
          AND attempt.outcome = 'running' AND attempt.sim_job_id IS NULL
      ) ORDER BY campaign.priority DESC, campaign."createdAt", campaign.id LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    if (!campaign) return receipt;
    const units = await connection.execute(sql`
      SELECT unit.id, unit.lease_token, unit.attempts, unit.active_seconds, unit.active_budget_seconds
      FROM progressive_cfd_units unit JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN progressive_cfd_attempts attempt ON attempt.token = unit.lease_token AND attempt.unit_id = unit.id
      WHERE generation.campaign_id = ${campaign.id} AND generation.epoch_id = ${epoch.id}
        AND generation.plan_revision_id = (SELECT current_plan_revision_id FROM sim_campaigns WHERE id = ${campaign.id})
        AND generation.status = 'active' AND generation.stage = work.stage AND work.state = 'pending'
        AND unit.state = 'leased' AND unit.lease_until <= clock_timestamp()
        AND attempt.outcome = 'running' AND attempt.sim_job_id IS NULL
      ORDER BY unit.lease_until, unit.id LIMIT 64 FOR UPDATE OF generation, work, unit, attempt SKIP LOCKED
    `);
    for (const unit of units) {
      const retry =
        Number(unit.attempts) < 2 &&
        Number(unit.active_seconds) < Number(unit.active_budget_seconds);
      const reason = retry
        ? "unbound claim expired before engine submission"
        : "bounded unbound claim retries exhausted";
      await connection.execute(sql`
        UPDATE progressive_cfd_attempts SET outcome = 'expired', finished_at = clock_timestamp(), error = ${reason}
        WHERE token = ${unit.lease_token}
      `);
      await connection.execute(sql`
        UPDATE progressive_cfd_units SET state = ${retry ? "pending" : "gap"}, lease_token = NULL,
          lease_owner = NULL, lease_until = NULL, error = ${reason} WHERE id = ${unit.id}
      `);
      if (retry) receipt.retried += 1;
      else receipt.gaps += 1;
    }
    return receipt;
  });
}
