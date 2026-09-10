import { sql } from "drizzle-orm";
import { FAST_WALL_SPACING_POLICY } from "@aerodb/core";
import type { DB } from "./client";
import { cancelObsoleteProgressiveCfdUnits } from "./progressive-cfd";
import { materializeProgressiveCampaignScope } from "./progressive-materialization";
import { analysisContentHash } from "./analysis-target";
import {
  advanceGeneration,
  type SealedPolarTarget,
  validateNeuralFoilPredictionPayload,
} from "./progressive-campaigns";

async function reusePreviousBaselines(
  db: DB,
  generationId: string,
  previousIds: string[],
  epochId: string,
) {
  const previous = sql.join(
    previousIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  let cursor: string | null = null;
  let reused = 0;
  for (;;) {
    const batch: Record<string, unknown>[] = await db.execute(sql`
      SELECT work.id,work.target_id,scope.angles,scope.recipes,target.physical,cached.prediction_id,cached.payload
      FROM progressive_work work JOIN progressive_generation_targets scope
        ON scope.generation_id=work.generation_id AND scope.target_id=work.target_id
      JOIN polar_analysis_targets target ON target.id=scope.target_id
      LEFT JOIN LATERAL (
        SELECT prediction.id AS prediction_id,prediction.payload FROM progressive_work prior
        JOIN progressive_prediction_links link ON link.work_id=prior.id
        JOIN neuralfoil_predictions prediction ON prediction.id=link.prediction_id
        WHERE prior.generation_id IN (${previous}) AND prior.stage=1 AND prior.target_id=work.target_id
          AND prior.state='complete' AND prediction.target_id=work.target_id AND prediction.epoch_id=${epochId}::uuid
        ORDER BY prediction.created_at DESC,prediction.id LIMIT 1
      ) cached ON true
      WHERE work.generation_id=${generationId}::uuid AND work.stage=1 AND work.state='pending'
        ${cursor ? sql`AND work.id>${cursor}::uuid` : sql``}
      ORDER BY work.id LIMIT 256
    `);
    if (!batch.length) break;
    const links: Array<{ workId: string; predictionId: string }> = [];
    for (const row of batch) {
      cursor = String(row.id);
      if (
        !row.payload ||
        analysisContentHash({ epochId, payload: row.payload }) !==
          row.prediction_id
      )
        continue;
      try {
        validateNeuralFoilPredictionPayload(
          String(row.target_id),
          {
            angles: row.angles as number[],
            recipes: row.recipes as SealedPolarTarget["recipes"],
            physical: row.physical as SealedPolarTarget["physical"],
          },
          row.payload as Record<string, unknown>,
        );
      } catch {
        continue;
      }
      links.push({
        workId: String(row.id),
        predictionId: String(row.prediction_id),
      });
    }
    if (links.length) {
      await db.execute(sql`INSERT INTO progressive_prediction_links(work_id,prediction_id)
        VALUES ${sql.join(
          links.map((link) => sql`(${link.workId}::uuid,${link.predictionId})`),
          sql`, `,
        )}`);
      await db.execute(sql`UPDATE progressive_work SET state='complete',completed_at=clock_timestamp(),error=NULL
        WHERE id IN (${sql.join(
          links.map((link) => sql`${link.workId}::uuid`),
          sql`, `,
        )})`);
      reused += links.length;
    }
  }
  await advanceGeneration(db, generationId);
  return reused;
}

export async function adoptProgressiveWallPolicy(db: DB, campaignId: string) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(campaignId))
    throw new Error("An exact campaign UUID is required");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    const [admission] = await connection.execute(
      sql`SELECT enabled FROM sweeper_state WHERE id=1 FOR SHARE`,
    );
    const [campaign] = await connection.execute(
      sql`SELECT id,status,current_plan_revision_id FROM sim_campaigns WHERE id=${campaignId}::uuid FOR UPDATE`,
    );
    if (!epoch || !campaign?.current_plan_revision_id)
      throw new Error("Campaign and calculation epoch must exist");
    const [receipt] = await connection.execute(sql`
      SELECT generation_id,previous_generation_ids FROM progressive_recipe_adoptions
      WHERE epoch_id=${epoch.id} AND campaign_id=${campaignId}::uuid
        AND plan_revision_id=${campaign.current_plan_revision_id} AND policy=${FAST_WALL_SPACING_POLICY}
    `);
    if (receipt) return { kind: "replayed" as const, campaignId, ...receipt };
    if (!["active", "attention"].includes(String(campaign.status)))
      throw new Error(
        "Only active preliminary campaigns may adopt a numerical policy",
      );
    if (admission?.enabled !== false)
      throw new Error("Pause new solver admissions before adopting recipes");
    const generations = await connection.execute(sql`
      SELECT id,stage FROM progressive_generations WHERE campaign_id=${campaignId}::uuid
        AND epoch_id=${epoch.id} AND plan_revision_id=${campaign.current_plan_revision_id}
        AND status IN ('active','attention') ORDER BY id FOR UPDATE
    `);
    if (generations.some((generation) => Number(generation.stage) >= 3))
      throw new Error(
        "A precise generation must not be restarted by preliminary recipe adoption",
      );
    if (!generations.length)
      return { kind: "not_required" as const, campaignId };
    const generationIds = generations.map((generation) =>
      String(generation.id),
    );
    const ids = sql.join(
      generationIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const [outdated] = await connection.execute(sql`
      SELECT EXISTS(SELECT 1 FROM progressive_generation_targets WHERE generation_id IN (${ids})
        AND recipes#>>'{fast,recipe_id}' <> 'openfoam-fast-density-local-v1'
        AND recipes#>>'{fast,wallSpacing,policy}' IS DISTINCT FROM ${FAST_WALL_SPACING_POLICY}) AS present
    `);
    if (!outdated?.present)
      return { kind: "not_required" as const, campaignId };
    const [busy] = await connection.execute(sql`
      SELECT EXISTS(SELECT 1 FROM progressive_cfd_attempts attempt
        JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        JOIN progressive_work work ON work.id=unit.work_id
        JOIN sim_jobs job ON job.id=attempt.sim_job_id
        LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id
        WHERE work.generation_id IN (${ids}) AND (attempt.outcome='running'
          OR job.status IN ('pending','submitted','running','ingesting')
          OR (job.engine_job_id IS NOT NULL AND (stopped.engine_job_id IS DISTINCT FROM job.engine_job_id OR stopped.epoch_id IS DISTINCT FROM ${epoch.id}::uuid))))
        OR EXISTS(SELECT 1 FROM progressive_work WHERE generation_id IN (${ids}) AND state='leased') AS present
    `);
    if (busy?.present)
      throw new Error(
        "Old solver work must be physically stopped and settled before recipe adoption",
      );
    const profiles = await connection.execute(sql`
      SELECT DISTINCT target.airfoil_id FROM progressive_generation_targets scope
      JOIN polar_analysis_targets target ON target.id=scope.target_id
      WHERE scope.generation_id IN (${ids}) ORDER BY target.airfoil_id
    `);
    await connection.execute(
      sql`UPDATE progressive_generations SET status='cancelled' WHERE id IN (${ids})`,
    );
    await cancelObsoleteProgressiveCfdUnits(connection, campaignId);
    await connection.execute(sql`
      UPDATE progressive_work SET state='gap',completed_at=clock_timestamp(),error='superseded by explicit numerical policy adoption'
      WHERE generation_id IN (${ids}) AND state IN ('pending','leased')
    `);
    const successor = await materializeProgressiveCampaignScope(
      connection,
      campaignId,
      profiles.map((profile) => String(profile.airfoil_id)),
      `adopt-${FAST_WALL_SPACING_POLICY}`,
    );
    if (!successor)
      throw new Error("Recipe adoption has no current eligible profile scope");
    await reusePreviousBaselines(
      connection,
      successor.id,
      generationIds,
      String(epoch.id),
    );
    await connection.execute(sql`
      INSERT INTO progressive_recipe_adoptions(epoch_id,campaign_id,plan_revision_id,policy,previous_generation_ids,generation_id)
      VALUES(${epoch.id},${campaignId}::uuid,${campaign.current_plan_revision_id},${FAST_WALL_SPACING_POLICY},ARRAY[${ids}],${successor.id})
    `);
    return {
      kind: "adopted" as const,
      campaignId,
      generation_id: successor.id,
      previous_generation_ids: generationIds,
    };
  });
}
