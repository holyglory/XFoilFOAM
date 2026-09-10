import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import type { DB } from "./client";
import {
  validateNeuralFoilPredictionPayload,
  type SealedPolarTarget,
} from "./progressive-campaigns";

export const PREDICTION_REPAIR_POLICY = "retained-polyline-baseline-repair-v1";
export interface PredictionRepairLease extends Pick<
  SealedPolarTarget,
  "angles" | "recipes" | "physical"
> {
  workId: string;
  token: string;
  owner: string;
  epochId: string;
  targetId: string;
  campaignId: string;
}

export async function claimMissingPredictionRepair(
  db: DB,
  campaignId: string,
  owner: string,
): Promise<PredictionRepairLease | null> {
  if (
    !/^[a-f0-9-]{36}$/.test(campaignId) ||
    !owner.trim() ||
    owner.length > 128
  )
    throw new Error("Invalid prediction repair owner or campaign");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [campaign] = await connection.execute(sql`
      SELECT campaign.id FROM sim_campaigns campaign JOIN sweeper_state state ON state.id = 1
      WHERE campaign.id = ${campaignId}::uuid AND campaign.status IN ('active', 'attention', 'completed')
        AND state.enabled AND NOT coalesce((SELECT remote_solver_enabled FROM sync_api_settings WHERE id = 1), false)
      FOR UPDATE OF campaign
    `);
    if (!campaign) return null;
    await connection.execute(sql`
      UPDATE progressive_prediction_repair_attempts attempt SET outcome = 'expired', finished_at = clock_timestamp()
      FROM progressive_prediction_repairs repair JOIN progressive_work work ON work.id = repair.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      WHERE generation.campaign_id = ${campaignId}::uuid AND repair.policy_version = ${PREDICTION_REPAIR_POLICY}
        AND repair.state = 'leased' AND repair.attempts = 2 AND repair.lease_until <= clock_timestamp()
        AND attempt.token = repair.lease_token AND attempt.outcome = 'running'
    `);
    await connection.execute(sql`
      UPDATE progressive_prediction_repairs repair SET state = 'gap', error = 'Prediction repair lease expired after its bounded retries',
        lease_token = NULL, lease_owner = NULL, lease_until = NULL, updated_at = clock_timestamp()
      FROM progressive_work work JOIN progressive_generations generation ON generation.id = work.generation_id
      WHERE repair.work_id = work.id AND generation.campaign_id = ${campaignId}::uuid
        AND repair.policy_version = ${PREDICTION_REPAIR_POLICY} AND repair.state = 'leased' AND repair.attempts = 2
        AND repair.lease_until <= clock_timestamp()
    `);
    const [candidate] = await connection.execute(sql`
      SELECT work.id, work.target_id, generation.epoch_id, scope.angles, scope.recipes, target.physical
      FROM progressive_work work JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id AND epoch.current
      JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id AND campaign.current_plan_revision_id = generation.plan_revision_id
      JOIN progressive_generation_targets scope ON scope.generation_id = generation.id AND scope.target_id = work.target_id
      JOIN polar_analysis_targets target ON target.id = work.target_id
      JOIN airfoils airfoil ON airfoil.id = target.airfoil_id AND airfoil."deletedAt" IS NULL AND airfoil."archivedAt" IS NULL
      JOIN sim_campaign_airfoils membership ON membership.campaign_id = campaign.id AND membership.airfoil_id = airfoil.id
      LEFT JOIN progressive_prediction_repairs repair ON repair.work_id = work.id AND repair.policy_version = ${PREDICTION_REPAIR_POLICY}
      WHERE campaign.id = ${campaignId}::uuid AND generation.status <> 'cancelled' AND generation.stage > 1
        AND work.stage = 1 AND work.state = 'gap' AND cardinality(scope.angles) >= 2
        AND (repair.work_id IS NULL OR (repair.attempts < 2 AND (repair.state = 'pending' OR (repair.state = 'leased' AND repair.lease_until <= clock_timestamp()))))
        AND NOT EXISTS (SELECT 1 FROM neuralfoil_predictions prediction
          WHERE prediction.epoch_id = generation.epoch_id AND prediction.target_id = work.target_id
            AND prediction.payload->'alpha' = to_jsonb(scope.angles) AND prediction.payload->'recipe' = scope.recipes->'neuralfoil')
      ORDER BY generation.created_at, work.id LIMIT 1 FOR UPDATE OF work
    `);
    if (!candidate) return null;
    const token = randomUUID();
    await connection.execute(sql`
      UPDATE progressive_prediction_repair_attempts attempt SET outcome = 'expired', finished_at = clock_timestamp()
      WHERE work_id = ${candidate.id}::uuid AND policy_version = ${PREDICTION_REPAIR_POLICY} AND outcome = 'running'
    `);
    await connection.execute(sql`
      INSERT INTO progressive_prediction_repairs(work_id, policy_version, state, attempts, lease_token, lease_owner, lease_until)
      VALUES (${candidate.id}::uuid, ${PREDICTION_REPAIR_POLICY}, 'leased', 1, ${token}::uuid, ${owner}, clock_timestamp() + interval '5 minutes')
      ON CONFLICT (work_id, policy_version) DO UPDATE SET state = 'leased', attempts = progressive_prediction_repairs.attempts + 1,
        lease_token = EXCLUDED.lease_token, lease_owner = EXCLUDED.lease_owner, lease_until = EXCLUDED.lease_until, updated_at = clock_timestamp()
    `);
    await connection.execute(sql`INSERT INTO progressive_prediction_repair_attempts(token, work_id, policy_version)
      VALUES (${token}::uuid, ${candidate.id}::uuid, ${PREDICTION_REPAIR_POLICY})`);
    return {
      workId: String(candidate.id),
      token,
      owner,
      epochId: String(candidate.epoch_id),
      targetId: String(candidate.target_id),
      campaignId,
      angles: candidate.angles as number[],
      recipes: candidate.recipes as SealedPolarTarget["recipes"],
      physical: candidate.physical as SealedPolarTarget["physical"],
    };
  });
}

async function lockRepair(db: DB, lease: PredictionRepairLease) {
  await db.execute(
    sql`SELECT id FROM calculation_epochs WHERE id = ${lease.epochId}::uuid AND current FOR SHARE`,
  );
  await db.execute(
    sql`SELECT id FROM sim_campaigns WHERE id = ${lease.campaignId}::uuid FOR UPDATE`,
  );
  const [scope] = await db.execute(sql`
    SELECT repair.prediction_id, repair.state, repair.attempts, scope.angles, scope.recipes, target.physical
    FROM progressive_prediction_repairs repair JOIN progressive_work work ON work.id = repair.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id AND epoch.current
    JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id AND campaign.current_plan_revision_id = generation.plan_revision_id
    JOIN progressive_generation_targets scope ON scope.generation_id = generation.id AND scope.target_id = work.target_id
    JOIN polar_analysis_targets target ON target.id = work.target_id
    WHERE repair.work_id = ${lease.workId}::uuid AND repair.policy_version = ${PREDICTION_REPAIR_POLICY}
      AND repair.lease_token = ${lease.token}::uuid AND repair.lease_owner = ${lease.owner}
      AND (repair.state = 'complete' OR (repair.state = 'leased' AND repair.lease_until > clock_timestamp()))
      AND epoch.id = ${lease.epochId}::uuid AND work.target_id = ${lease.targetId} AND work.stage = 1 AND work.state = 'gap'
      AND campaign.id = ${lease.campaignId}::uuid AND campaign.status NOT IN ('cancelled', 'archived') AND generation.status <> 'cancelled'
    FOR UPDATE OF repair
  `);
  if (!scope) throw new Error("Prediction repair lease is obsolete or expired");
  return scope;
}

export async function storeRepairedPrediction(
  db: DB,
  lease: PredictionRepairLease,
  payload: Record<string, unknown>,
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const stored = await lockRepair(connection, lease);
    const scope = {
      angles: stored.angles as number[],
      recipes: stored.recipes as SealedPolarTarget["recipes"],
      physical: stored.physical as SealedPolarTarget["physical"],
    };
    validateNeuralFoilPredictionPayload(lease.targetId, scope, payload);
    const id = analysisContentHash({ epochId: lease.epochId, payload });
    if (stored.state === "complete") {
      if (stored.prediction_id !== id)
        throw new Error("Completed prediction repair replay changed content");
      return id;
    }
    await connection.execute(sql`INSERT INTO neuralfoil_predictions(id, epoch_id, target_id, payload)
      VALUES (${id}, ${lease.epochId}::uuid, ${lease.targetId}, ${canonicalAnalysisJson(payload)}::jsonb) ON CONFLICT (id) DO NOTHING`);
    await connection.execute(sql`UPDATE progressive_prediction_repairs SET state = 'complete', prediction_id = ${id}, error = NULL,
      lease_until = NULL, updated_at = clock_timestamp() WHERE work_id = ${lease.workId}::uuid AND policy_version = ${PREDICTION_REPAIR_POLICY}`);
    await connection.execute(
      sql`UPDATE progressive_prediction_repair_attempts SET outcome = 'complete', finished_at = clock_timestamp() WHERE token = ${lease.token}::uuid`,
    );
    return id;
  });
}

export async function failPredictionRepair(
  db: DB,
  lease: PredictionRepairLease,
  error: string,
  retryable: boolean,
) {
  if (!error.trim())
    throw new Error("Prediction repair failure needs an explanation");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const repair = await lockRepair(connection, lease);
    if (repair.state === "complete")
      throw new Error("Completed prediction repair cannot fail");
    await connection.execute(sql`UPDATE progressive_prediction_repairs SET state = ${retryable && Number(repair.attempts) < 2 ? "pending" : "gap"},
      error = ${error.slice(0, 2000)}, lease_until = NULL, lease_token = NULL, lease_owner = NULL, updated_at = clock_timestamp()
      WHERE work_id = ${lease.workId}::uuid AND policy_version = ${PREDICTION_REPAIR_POLICY}`);
    await connection.execute(sql`UPDATE progressive_prediction_repair_attempts SET outcome = 'failed', error = ${error.slice(0, 2000)},
      finished_at = clock_timestamp() WHERE token = ${lease.token}::uuid`);
  });
}
