import { type DB, type ProgressiveCfdLease } from "@aerodb/db";
import { sql } from "drizzle-orm";

export class ProgressiveEvidenceCellOwned extends Error {
  constructor(readonly leases: readonly ProgressiveCfdLease[]) {
    super("CFD evidence cells already have another execution owner");
    this.name = "ProgressiveEvidenceCellOwned";
  }
}

export async function deferProgressiveClaim(
  db: DB,
  conflict: ProgressiveEvidenceCellOwned,
): Promise<number> {
  if (!conflict.leases.length || conflict.leases.length > 512)
    throw new Error("Claim deferral requires a bounded exact lease scope");
  const targets = sql.join(
    conflict.leases.map(
      (
        lease,
      ) => sql`(unit.id=${lease.id}::uuid AND unit.work_id=${lease.workId}::uuid
    AND work.generation_id=${lease.generationId}::uuid AND work.target_id=${lease.targetId}
    AND generation.campaign_id=${lease.campaignId}::uuid AND generation.epoch_id=${lease.epochId}::uuid
    AND work.stage=${lease.stage} AND unit.aoa_deg=${lease.alpha}
    AND NOT EXISTS(SELECT 1 FROM progressive_cfd_attempts prepared WHERE prepared.token=${lease.token}::uuid))`,
    ),
    sql` OR `,
  );
  const rows = await db.execute(sql`UPDATE progressive_cfd_units unit
    SET retry_after=clock_timestamp()+interval '1 minute',error='Another execution owns these result cells; preparation deferred'
    FROM progressive_work work JOIN progressive_generations generation ON generation.id=work.generation_id
    JOIN calculation_epochs epoch ON epoch.id=generation.epoch_id JOIN sim_campaigns campaign ON campaign.id=generation.campaign_id
    WHERE unit.work_id=work.id AND (${targets}) AND epoch.current AND generation.status='active'
      AND generation.plan_revision_id=campaign.current_plan_revision_id AND campaign.status IN ('active','attention')
      AND generation.stage=work.stage AND work.state='pending' AND unit.state='pending' AND unit.lease_token IS NULL
      AND NOT EXISTS(SELECT 1 FROM progressive_cfd_attempts owner WHERE owner.unit_id=unit.id AND owner.outcome='running')
    RETURNING unit.id`);
  return rows.length;
}
