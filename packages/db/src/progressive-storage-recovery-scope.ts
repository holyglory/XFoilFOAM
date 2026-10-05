import { sql } from "drizzle-orm";
import type { DB } from "./client";

export class ProgressiveCfdEvidenceScopeClosed extends Error {}

export class ProgressiveCfdEvidenceScopePending extends Error {}

export interface ProgressiveStorageEvidenceRecoveryScope {
  campaignId: string;
  epochId: string;
  generationId: string;
  planRevisionId: string;
  stage: 2;
  cohort?: "low";
}

export function assertProgressiveStorageEvidenceRecoveryRole() {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "hub")
    throw new Error(
      "Progressive storage evidence recovery is a hub-only operator action",
    );
}

export async function assertProgressiveStorageEvidenceRecoveryHost(db: DB) {
  assertProgressiveStorageEvidenceRecoveryRole();
  const [settings] = await db.execute(sql`
    SELECT remote_solver_enabled FROM sync_api_settings WHERE id = 1 FOR SHARE
  `);
  if (!settings || settings.remote_solver_enabled !== false)
    throw new ProgressiveCfdEvidenceScopeClosed(
      "Progressive storage evidence recovery requires the configured hub database",
    );
}

export async function lockProgressiveStorageRecoveryUnits(
  db: DB,
  scope: ProgressiveStorageEvidenceRecoveryScope,
  simJobId: string,
) {
  await db.execute(sql`SELECT id FROM progressive_generations
    WHERE id = ${scope.generationId}::uuid FOR UPDATE`);
  await db.execute(sql`SELECT work.id FROM progressive_work work
    JOIN progressive_cfd_units unit ON unit.work_id = work.id
    JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id
    WHERE attempt.sim_job_id = ${simJobId}::uuid AND work.generation_id = ${scope.generationId}::uuid
    ORDER BY work.id FOR UPDATE OF work`);
  await db.execute(sql`SELECT unit.id FROM progressive_cfd_units unit
    JOIN progressive_cfd_attempts attempt ON attempt.unit_id = unit.id
    WHERE attempt.sim_job_id = ${simJobId}::uuid
    ORDER BY unit.ordinal, unit.id FOR UPDATE OF unit`);
  await db.execute(sql`SELECT attempt.token FROM progressive_cfd_attempts attempt
    JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
    WHERE attempt.sim_job_id = ${simJobId}::uuid
    ORDER BY unit.ordinal, unit.id, attempt.token FOR UPDATE OF attempt`);
}
