import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { analysisContentHash } from "./analysis-target";
import { tryProgressiveAdmissionLock } from "./progressive-admission-lock";

export const MAX_PROGRESSIVE_CFD_REUSE_UNITS = 256;

export async function reuseAcceptedProgressiveCfdEvidence(
  db: DB,
  generationId: string,
  previousIds: string[],
  epochId: string,
  options: { limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? MAX_PROGRESSIVE_CFD_REUSE_UNITS;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(generationId) ||
    !uuid.test(epochId) ||
    previousIds.length > 32 ||
    new Set(previousIds).size !== previousIds.length ||
    previousIds.some((id) => !uuid.test(id) || id === generationId) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PROGRESSIVE_CFD_REUSE_UNITS
  )
    throw new Error("Invalid bounded progressive CFD evidence reuse scope");
  if (!previousIds.length) return 0;
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    if (!(await tryProgressiveAdmissionLock(connection))) return 0;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (epoch?.id !== epochId)
      throw new Error("Progressive CFD evidence reuse has an obsolete epoch");
    const [campaign] = await connection.execute(sql`
      SELECT campaign.id, campaign.status, campaign.current_plan_revision_id
      FROM sim_campaigns campaign
      JOIN progressive_generations generation ON generation.campaign_id = campaign.id
      WHERE generation.id = ${generationId}::uuid
      FOR UPDATE OF campaign SKIP LOCKED
    `);
    const [generation] = await connection.execute(sql`
      SELECT id, epoch_id, status, plan_revision_id
      FROM progressive_generations WHERE id = ${generationId}::uuid FOR UPDATE SKIP LOCKED
    `);
    if (!campaign || !generation) return 0;
    if (
      generation.epoch_id !== epochId ||
      generation.status !== "active" ||
      generation.plan_revision_id !== campaign.current_plan_revision_id ||
      !["active", "attention", "paused"].includes(String(campaign.status))
    )
      throw new Error(
        "Progressive CFD evidence reuse requires a current active successor",
      );
    const previous = sql.join(
      previousIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const candidates = await connection.execute(sql`
      SELECT successor.id AS successor_unit_id, successor.recipe AS successor_recipe,
        successor_scope.revision_id AS successor_revision_id,
        source_attempt.token AS source_attempt_token,
        source_attempt.execution_recipe_id AS source_execution_recipe_id,
        source_generation.id AS source_generation_id,
        evidence.result_attempt_id AS source_result_attempt_id,
        evidence.evidence_signature AS source_evidence_signature,
        raw.evidence_payload AS source_evidence_payload,
        execution_recipe.execution_revision_id,
        raw.simulation_preset_revision_id AS result_revision_id,
        stopped.proof, stopped.proof_signature
      FROM progressive_cfd_units successor
      JOIN progressive_work successor_work ON successor_work.id = successor.work_id
      JOIN progressive_generation_targets successor_scope
        ON successor_scope.generation_id = successor_work.generation_id
        AND successor_scope.target_id = successor_work.target_id
      JOIN polar_analysis_targets target ON target.id = successor_work.target_id
      JOIN progressive_work source_work
        ON source_work.target_id = successor_work.target_id
        AND source_work.stage = successor_work.stage
      JOIN progressive_generations source_generation
        ON source_generation.id = source_work.generation_id
        AND source_generation.id IN (${previous})
        AND source_generation.campaign_id = ${campaign.id}::uuid
        AND source_generation.epoch_id = ${epochId}::uuid
        AND source_generation.status IN ('cancelled', 'complete', 'attention')
      JOIN progressive_cfd_units source_unit
        ON source_unit.work_id = source_work.id
        AND source_unit.aoa_deg = successor.aoa_deg
      JOIN progressive_cfd_attempts source_attempt
        ON source_attempt.unit_id = source_unit.id
      JOIN progressive_cfd_execution_recipes execution_recipe
        ON execution_recipe.id = source_attempt.execution_recipe_id
        AND execution_recipe.source_revision_id = successor_scope.revision_id
        AND execution_recipe.recipe = successor.recipe
      JOIN progressive_cfd_evidence evidence ON evidence.attempt_token = source_attempt.token
      JOIN result_attempts raw ON raw.id = evidence.result_attempt_id
        AND raw.simulation_preset_revision_id = execution_recipe.execution_revision_id
        AND raw.airfoil_id = target.airfoil_id AND raw.aoa_deg = successor.aoa_deg
        AND raw.sim_job_id = source_attempt.sim_job_id
      JOIN result_classifications classification
        ON classification.result_attempt_id = raw.id AND classification.state = 'accepted'
      JOIN sim_jobs source_job ON source_job.id = source_attempt.sim_job_id
        AND source_job.engine_job_id = raw.engine_job_id
      JOIN progressive_cfd_execution_stops stopped
        ON stopped.sim_job_id = source_job.id
        AND stopped.engine_job_id = source_job.engine_job_id
        AND stopped.epoch_id = ${epochId}::uuid
      WHERE successor_work.generation_id = ${generationId}::uuid
        AND successor_work.stage IN (2, 3) AND successor_work.state = 'pending'
        AND successor.state = 'pending' AND successor.lease_token IS NULL
        AND successor.lease_owner IS NULL AND successor.lease_until IS NULL
        AND source_job.status IN ('done', 'failed', 'cancelled')
        AND source_job."ingestedAt" IS NOT NULL
        AND (source_job.ingest_lease_expires_at IS NULL OR source_job.ingest_lease_expires_at <= clock_timestamp())
        AND raw.status = 'done' AND raw.source = 'solved' AND raw.valid_for_polar
        AND COALESCE((SELECT review.verdict FROM result_review_verdicts review
          WHERE review.result_id = raw.result_id AND review."revokedAt" IS NULL
          ORDER BY review."createdAt" DESC, review.id DESC LIMIT 1), 'waive')
          NOT IN ('exclude', 'defer')
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts live_attempt
          WHERE (live_attempt.unit_id = successor.id OR live_attempt.sim_job_id = source_job.id)
            AND live_attempt.outcome = 'running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_remote_dispatches dispatch
          JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
          WHERE dispatch.sim_job_id = source_job.id AND promise.status = 'active'
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_evidence_reuses reuse WHERE reuse.successor_unit_id = successor.id
        )
      ORDER BY successor.id, source_attempt.finished_at DESC NULLS LAST, source_attempt.token, raw.id
      LIMIT ${limit}
    `);
    let reused = 0;
    const seen = new Set<string>();
    for (const row of candidates) {
      const unitId = String(row.successor_unit_id);
      if (seen.has(unitId)) continue;
      if (
        analysisContentHash({
          sourceRevisionId: String(row.successor_revision_id),
          recipe: row.successor_recipe,
        }) !== row.source_execution_recipe_id ||
        analysisContentHash(row.source_evidence_payload) !==
          row.source_evidence_signature ||
        analysisContentHash(row.proof) !== row.proof_signature
      )
        continue;
      seen.add(unitId);
      const inserted = await connection.execute(sql`
        INSERT INTO progressive_cfd_evidence_reuses (
          successor_unit_id, source_attempt_token, source_result_attempt_id,
          source_evidence_signature, source_generation_id, source_execution_recipe_id
        ) VALUES (
          ${unitId}::uuid, ${row.source_attempt_token}::uuid, ${row.source_result_attempt_id}::uuid,
          ${row.source_evidence_signature}, ${row.source_generation_id}::uuid, ${row.source_execution_recipe_id}
        ) ON CONFLICT (successor_unit_id) DO NOTHING RETURNING successor_unit_id
      `);
      if (!inserted.length) continue;
      const updated = await connection.execute(sql`
        UPDATE progressive_cfd_units SET state = 'complete', error = NULL
        WHERE id = ${unitId}::uuid AND state = 'pending'
          AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL RETURNING id
      `);
      if (updated.length !== 1)
        throw new Error(
          "Progressive CFD reuse lost its exact successor unit owner",
        );
      reused += 1;
    }
    if (reused > 0 && reused < limit)
      reused += await reuseAcceptedProgressiveCfdEvidence(
        connection,
        generationId,
        previousIds,
        epochId,
        { limit: limit - reused },
      );
    return reused;
  });
}

export async function reuseInformativeProgressiveCfdEvidence(
  db: DB,
  generationId: string,
  previousIds: string[],
  epochId: string,
  options: { limit?: number } = {},
): Promise<number> {
  const limit = options.limit ?? MAX_PROGRESSIVE_CFD_REUSE_UNITS;
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(generationId) ||
    !uuid.test(epochId) ||
    previousIds.length > 32 ||
    new Set(previousIds).size !== previousIds.length ||
    previousIds.some((id) => !uuid.test(id) || id === generationId) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > MAX_PROGRESSIVE_CFD_REUSE_UNITS
  )
    throw new Error("Invalid bounded progressive CFD evidence reuse scope");
  if (!previousIds.length) return 0;
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    if (!(await tryProgressiveAdmissionLock(connection))) return 0;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (epoch?.id !== epochId)
      throw new Error("Progressive CFD evidence reuse has an obsolete epoch");
    const [campaign] = await connection.execute(sql`
      SELECT campaign.id, campaign.status, campaign.current_plan_revision_id
      FROM sim_campaigns campaign
      JOIN progressive_generations generation ON generation.campaign_id = campaign.id
      WHERE generation.id = ${generationId}::uuid
      FOR UPDATE OF campaign SKIP LOCKED
    `);
    const [generation] = await connection.execute(sql`
      SELECT id, epoch_id, status, plan_revision_id
      FROM progressive_generations WHERE id = ${generationId}::uuid FOR UPDATE SKIP LOCKED
    `);
    if (!campaign || !generation) return 0;
    if (
      generation.epoch_id !== epochId ||
      generation.status !== "active" ||
      generation.plan_revision_id !== campaign.current_plan_revision_id ||
      !["active", "attention", "paused"].includes(String(campaign.status))
    )
      throw new Error(
        "Progressive CFD evidence reuse requires a current active successor",
      );
    const previous = sql.join(
      previousIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const candidates = await connection.execute(sql`
      SELECT successor.id AS successor_unit_id, successor.recipe AS successor_recipe,
        successor_scope.revision_id AS successor_revision_id,
        source_attempt.token AS source_attempt_token,
        source_attempt.execution_recipe_id AS source_execution_recipe_id,
        source_generation.id AS source_generation_id,
        evidence.result_attempt_id AS source_result_attempt_id,
        evidence.evidence_signature AS source_evidence_signature,
        raw.evidence_payload AS source_evidence_payload,
        execution_recipe.execution_revision_id,
        raw.simulation_preset_revision_id AS result_revision_id,
        stopped.proof, stopped.proof_signature
      FROM progressive_cfd_units successor
      JOIN progressive_work successor_work ON successor_work.id = successor.work_id
      JOIN progressive_generation_targets successor_scope
        ON successor_scope.generation_id = successor_work.generation_id
        AND successor_scope.target_id = successor_work.target_id
      JOIN polar_analysis_targets target ON target.id = successor_work.target_id
      JOIN progressive_work source_work
        ON source_work.target_id = successor_work.target_id
        AND source_work.stage = successor_work.stage
      JOIN progressive_generations source_generation
        ON source_generation.id = source_work.generation_id
        AND source_generation.id IN (${previous})
        AND source_generation.campaign_id = ${campaign.id}::uuid
        AND source_generation.epoch_id = ${epochId}::uuid
        AND source_generation.status IN ('cancelled', 'complete', 'attention')
      JOIN progressive_cfd_units source_unit
        ON source_unit.work_id = source_work.id
        AND source_unit.aoa_deg = successor.aoa_deg
      JOIN progressive_cfd_attempts source_attempt
        ON source_attempt.unit_id = source_unit.id
      JOIN progressive_cfd_execution_recipes execution_recipe
        ON execution_recipe.id = source_attempt.execution_recipe_id
        AND execution_recipe.source_revision_id = successor_scope.revision_id
        AND execution_recipe.recipe = successor.recipe
      JOIN progressive_cfd_evidence evidence ON evidence.attempt_token = source_attempt.token
      JOIN result_attempts raw ON raw.id = evidence.result_attempt_id
        AND raw.simulation_preset_revision_id = execution_recipe.execution_revision_id
        AND raw.airfoil_id = target.airfoil_id AND raw.aoa_deg = successor.aoa_deg
        AND raw.sim_job_id = source_attempt.sim_job_id
      JOIN sim_jobs source_job ON source_job.id = source_attempt.sim_job_id
        AND source_job.engine_job_id = raw.engine_job_id
      JOIN progressive_cfd_execution_stops stopped
        ON stopped.sim_job_id = source_job.id
        AND stopped.engine_job_id = source_job.engine_job_id
        AND stopped.epoch_id = ${epochId}::uuid
      WHERE successor_work.generation_id = ${generationId}::uuid
        AND successor_work.stage IN (2, 3) AND successor_work.state = 'pending'
        AND successor.state = 'pending' AND successor.lease_token IS NULL
        AND successor.lease_owner IS NULL AND successor.lease_until IS NULL
        AND source_job.status IN ('done', 'failed', 'cancelled')
        AND source_job."ingestedAt" IS NOT NULL
        AND (source_job.ingest_lease_expires_at IS NULL OR source_job.ingest_lease_expires_at <= clock_timestamp())
        AND raw.status IN ('done', 'failed')
        AND raw.evidence_payload IS NOT NULL
        AND jsonb_typeof(raw.evidence_payload) = 'object'
        AND raw.cl IS NOT NULL AND raw.cl > '-Infinity'::double precision
        AND raw.cl < 'Infinity'::double precision
        AND raw.cd IS NOT NULL AND raw.cd > '-Infinity'::double precision
        AND raw.cd < 'Infinity'::double precision
        AND raw.cm IS NOT NULL AND raw.cm > '-Infinity'::double precision
        AND raw.cm < 'Infinity'::double precision
        AND evidence.solver_active_seconds > 0
        AND evidence.solver_active_seconds < 'Infinity'::double precision
        AND (raw.status = 'failed' OR raw.converged IS FALSE)
        AND COALESCE(raw.evidence_payload->>'failure_disposition', '')
          NOT IN ('infrastructure', 'deterministic_mesh', 'material_domain')
        AND NOT EXISTS (
          SELECT 1 FROM result_classifications classification
          WHERE classification.result_attempt_id = raw.id AND classification.state = 'accepted'
        )
        AND COALESCE((SELECT review.verdict FROM result_review_verdicts review
          WHERE review.result_id = raw.result_id AND review."revokedAt" IS NULL
          ORDER BY review."createdAt" DESC, review.id DESC LIMIT 1), 'waive')
          NOT IN ('exclude', 'defer')
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_attempts live_attempt
          WHERE (live_attempt.unit_id = successor.id OR live_attempt.sim_job_id = source_job.id)
            AND live_attempt.outcome = 'running'
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_remote_dispatches dispatch
          JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
          WHERE dispatch.sim_job_id = source_job.id AND promise.status = 'active'
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_cfd_evidence_reuses reuse WHERE reuse.successor_unit_id = successor.id
        )
      ORDER BY successor.id, source_attempt.finished_at DESC NULLS LAST, source_attempt.token, raw.id
      LIMIT ${limit}
    `);
    let reused = 0;
    const seen = new Set<string>();
    for (const row of candidates) {
      const unitId = String(row.successor_unit_id);
      if (seen.has(unitId)) continue;
      if (
        analysisContentHash({
          sourceRevisionId: String(row.successor_revision_id),
          recipe: row.successor_recipe,
        }) !== row.source_execution_recipe_id ||
        analysisContentHash(row.source_evidence_payload) !==
          row.source_evidence_signature ||
        analysisContentHash(row.proof) !== row.proof_signature
      )
        continue;
      seen.add(unitId);
      const inserted = await connection.execute(sql`
        INSERT INTO progressive_cfd_evidence_reuses (
          successor_unit_id, source_attempt_token, source_result_attempt_id,
          source_evidence_signature, source_generation_id, source_execution_recipe_id
        ) VALUES (
          ${unitId}::uuid, ${row.source_attempt_token}::uuid, ${row.source_result_attempt_id}::uuid,
          ${row.source_evidence_signature}, ${row.source_generation_id}::uuid, ${row.source_execution_recipe_id}
        ) ON CONFLICT (successor_unit_id) DO NOTHING RETURNING successor_unit_id
      `);
      if (!inserted.length) continue;
      const updated = await connection.execute(sql`
        UPDATE progressive_cfd_units SET state = 'complete', error = NULL
        WHERE id = ${unitId}::uuid AND state = 'pending'
          AND lease_token IS NULL AND lease_owner IS NULL AND lease_until IS NULL RETURNING id
      `);
      if (updated.length !== 1)
        throw new Error(
          "Progressive CFD reuse lost its exact successor unit owner",
        );
      reused += 1;
    }
    if (reused > 0 && reused < limit)
      reused += await reuseInformativeProgressiveCfdEvidence(
        connection,
        generationId,
        previousIds,
        epochId,
        { limit: limit - reused },
      );
    return reused;
  });
}

export async function reconcileAcceptedProgressiveCfdEvidence(
  db: DB,
  campaignId?: string,
): Promise<number> {
  const adoptions = await db.execute(sql`
    SELECT adoption.generation_id, adoption.previous_generation_ids, adoption.epoch_id
    FROM progressive_recipe_adoptions adoption
    JOIN progressive_generations generation ON generation.id = adoption.generation_id
    JOIN sim_campaigns campaign ON campaign.id = generation.campaign_id
    JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id AND epoch.current
    WHERE generation.status = 'active'
      ${campaignId ? sql`AND campaign.id = ${campaignId}::uuid` : sql``}
      AND generation.plan_revision_id = campaign.current_plan_revision_id
      AND campaign.status IN ('active', 'attention', 'paused')
      AND EXISTS (
        SELECT 1 FROM progressive_work work JOIN progressive_cfd_units unit ON unit.work_id = work.id
        WHERE work.generation_id = generation.id AND work.state = 'pending' AND unit.state = 'pending'
      )
    ORDER BY adoption.created_at, adoption.generation_id LIMIT 1
  `);
  let reused = 0;
  for (const adoption of adoptions)
    reused += await reuseAcceptedProgressiveCfdEvidence(
      db,
      String(adoption.generation_id),
      (adoption.previous_generation_ids as string[]).map(String),
      String(adoption.epoch_id),
    );
  return reused;
}
