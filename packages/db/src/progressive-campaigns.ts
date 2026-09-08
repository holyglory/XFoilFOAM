import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "./client";
import { cancelObsoleteProgressiveCfdUnits } from "./progressive-cfd";
import {
  analysisContentHash,
  canonicalAnalysisJson,
  type AnalysisPhysical,
} from "./analysis-target";

export type ProgressiveStage = 1 | 2 | 3;
export interface SealedPolarTarget {
  airfoilId: string;
  targetId: string;
  physical: AnalysisPhysical;
  revisionId: string;
  angles: number[];
  recipes: {
    neuralfoil: Record<string, unknown>;
    fast: Record<string, unknown>;
    precise: Record<string, unknown>;
  };
}

export interface ProgressiveLease {
  id: string;
  epochId: string;
  generationId: string;
  targetId: string;
  campaignId: string;
  stage: ProgressiveStage;
  token: string;
  owner: string;
  attempts: number;
  angles: number[];
  recipes: SealedPolarTarget["recipes"];
  physical: AnalysisPhysical;
  revisionId: string;
}

async function rows<T>(db: DB, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

async function currentEpoch(db: DB, expectedId?: string): Promise<string> {
  const [epoch] = await rows<{ id: string }>(
    db,
    sql`
    SELECT id FROM calculation_epochs WHERE current FOR SHARE
  `,
  );
  if (!epoch || (expectedId && epoch.id !== expectedId))
    throw new Error("Calculation epoch is missing or obsolete");
  return epoch.id;
}

export async function rotateCalculationEpoch(
  db: DB,
  reason: string,
  authoritativeId?: string,
) {
  if (!reason.trim()) throw new Error("Epoch replacement requires a reason");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('calculation-epoch', 0))`,
    );
    const [current] = await rows<{ id: string }>(
      connection,
      sql`
      SELECT id FROM calculation_epochs WHERE current FOR UPDATE
    `,
    );
    if (current && current.id === authoritativeId) return current.id;
    const nextId = authoritativeId ?? randomUUID();
    const [old] = await rows<{ id: string }>(
      connection,
      sql`SELECT id FROM calculation_epochs WHERE id = ${nextId}`,
    );
    if (old)
      throw new Error("An obsolete calculation epoch cannot be reactivated");
    await connection.execute(
      sql`UPDATE calculation_epochs SET current = false WHERE current`,
    );
    await connection.execute(sql`
      UPDATE progressive_work_attempts SET outcome = 'cancelled', error = 'calculation epoch replaced',
        finished_at = clock_timestamp() WHERE outcome = 'running'
    `);
    await connection.execute(sql`
      UPDATE progressive_generations SET status = 'cancelled'
      WHERE status IN ('active', 'attention')
    `);
    await cancelObsoleteProgressiveCfdUnits(connection);
    await connection.execute(sql`
      UPDATE progressive_work SET state = 'gap', error = 'calculation epoch replaced',
        lease_token = NULL, lease_owner = NULL, lease_until = NULL, completed_at = clock_timestamp()
      WHERE state IN ('pending', 'leased')
    `);
    await connection.execute(
      sql`INSERT INTO calculation_epochs (id, reason) VALUES (${nextId}, ${reason})`,
    );
    return nextId;
  });
}

export async function sealProgressiveGeneration(
  db: DB,
  input: {
    campaignId: string;
    planRevisionId: string;
    scopeKey: string;
    targets: SealedPolarTarget[];
  },
) {
  if (!input.scopeKey || !input.targets.length)
    throw new Error("A generation requires finite target scope");
  const orderedTargets = [...input.targets].sort((left, right) =>
    left.targetId.localeCompare(right.targetId),
  );
  if (
    new Set(orderedTargets.map((target) => target.targetId)).size !==
    orderedTargets.length
  )
    throw new Error("Duplicate analysis target in generation");
  for (const target of orderedTargets) {
    if (
      analysisContentHash(target.physical) !== target.targetId ||
      target.physical.airfoilId !== target.airfoilId
    )
      throw new Error("Analysis target identity mismatch");
    if (
      !target.angles.length ||
      target.angles.length > 32768 ||
      !target.angles.every(
        (angle, index) =>
          Number.isFinite(angle) &&
          Math.abs(angle) <= 180 &&
          (index === 0 || angle > target.angles[index - 1]),
      )
    )
      throw new Error("Target angles must be finite, distinct and increasing");
    for (const recipe of Object.values(target.recipes)) {
      if (!Object.keys(recipe).length)
        throw new Error("Each stage requires an immutable numerical recipe");
      canonicalAnalysisJson(recipe);
    }
  }
  const scopeSignature = analysisContentHash(orderedTargets);
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const epochId = await currentEpoch(connection);
    const [campaign] = await rows<{ id: string; status: string }>(
      connection,
      sql`
      SELECT campaign.id, campaign.status FROM sim_campaigns campaign
      JOIN sim_campaign_plan_revisions revision ON revision.campaign_id = campaign.id
      WHERE campaign.id = ${input.campaignId} AND revision.id = ${input.planRevisionId}
        AND campaign.current_plan_revision_id = revision.id
      FOR UPDATE OF campaign
    `,
    );
    if (!campaign)
      throw new Error(
        "Campaign plan revision is no longer current for this campaign",
      );
    const [existing] = await rows<{ id: string; scope_signature: string }>(
      connection,
      sql`
      SELECT id, scope_signature FROM progressive_generations
      WHERE epoch_id = ${epochId} AND campaign_id = ${input.campaignId} AND scope_key = ${input.scopeKey}
    `,
    );
    if (existing) {
      if (existing.scope_signature !== scopeSignature)
        throw new Error("Sealed generation scope cannot change");
      return { id: existing.id, epochId, replayed: true };
    }
    const [generation] = await rows<{ id: string }>(
      connection,
      sql`
      INSERT INTO progressive_generations (epoch_id, campaign_id, plan_revision_id, scope_key, scope_signature)
      VALUES (${epochId}, ${input.campaignId}, ${input.planRevisionId}, ${input.scopeKey}, ${scopeSignature}) RETURNING id
    `,
    );
    const sources = await rows<{
      id: string;
      points: Array<{ x: number; y: number }>;
    }>(
      connection,
      sql`
      SELECT airfoil.id, airfoil.points FROM airfoils airfoil
      JOIN sim_campaign_airfoils membership ON membership.airfoil_id = airfoil.id
      WHERE membership.campaign_id = ${input.campaignId} FOR KEY SHARE OF airfoil
    `,
    );
    const sourceGeometry = new Map(
      sources.map((source) => [
        source.id,
        canonicalAnalysisJson(source.points.map(({ x, y }) => [x, y])),
      ]),
    );
    const revisions = new Set(
      (
        await rows<{ revision_id: string }>(
          connection,
          sql`
      SELECT simulation_preset_revision_id AS revision_id FROM sim_campaign_conditions WHERE campaign_id = ${input.campaignId}
    `,
        )
      ).map((row) => row.revision_id),
    );
    for (const target of orderedTargets) {
      if (
        !revisions.has(target.revisionId) ||
        sourceGeometry.get(target.airfoilId) !==
          canonicalAnalysisJson(target.physical.geometry)
      )
        throw new Error(
          "Target geometry/revision does not belong to the campaign scope",
        );
    }
    for (let offset = 0; offset < orderedTargets.length; offset += 256) {
      const batch = orderedTargets.slice(offset, offset + 256);
      const inputRows = canonicalAnalysisJson(
        batch.map((target) => ({
          id: target.targetId,
          airfoil_id: target.airfoilId,
          physical: target.physical,
          revision_id: target.revisionId,
          angles: target.angles,
          recipes: target.recipes,
        })),
      );
      await connection.execute(sql`
        INSERT INTO polar_analysis_targets (id, airfoil_id, physical)
        SELECT id, airfoil_id, physical FROM jsonb_to_recordset(${inputRows}::jsonb)
          AS source(id text, airfoil_id uuid, physical jsonb)
        ON CONFLICT (id) DO NOTHING
      `);
      const [conflict] = await rows<{ id: string }>(
        connection,
        sql`
        SELECT target.id FROM polar_analysis_targets target
        JOIN jsonb_to_recordset(${inputRows}::jsonb) AS source(id text, physical jsonb) ON source.id = target.id
        WHERE target.physical <> source.physical LIMIT 1
      `,
      );
      if (conflict) throw new Error("Stored analysis target conflict");
      await connection.execute(sql`
        INSERT INTO progressive_generation_targets (generation_id, target_id, revision_id, angles, recipes)
        SELECT ${generation.id}, id, revision_id,
          ARRAY(SELECT jsonb_array_elements_text(angles)::double precision), recipes
        FROM jsonb_to_recordset(${inputRows}::jsonb) AS source(id text, revision_id uuid, angles jsonb, recipes jsonb)
      `);
      await connection.execute(sql`
        INSERT INTO progressive_work (generation_id, target_id, stage)
        SELECT ${generation.id}, source.id, stage FROM jsonb_to_recordset(${inputRows}::jsonb) AS source(id text)
        CROSS JOIN generate_series(1, 3) stage
      `);
    }
    if (campaign.status === "completed")
      await connection.execute(
        sql`UPDATE sim_campaigns SET status = 'active', "completedAt" = NULL WHERE id = ${campaign.id}`,
      );
    return { id: generation.id, epochId, replayed: false };
  });
}

export async function advanceGeneration(db: DB, generationId: string) {
  const [generation] = await rows<{ stage: ProgressiveStage }>(
    db,
    sql`
    SELECT stage FROM progressive_generations WHERE id = ${generationId} FOR UPDATE
  `,
  );
  const [counts] = await rows<{ pending: number; gaps: number }>(
    db,
    sql`
    SELECT count(*) FILTER (WHERE state IN ('pending', 'leased'))::integer AS pending,
      count(*) FILTER (WHERE state = 'gap')::integer AS gaps
    FROM progressive_work WHERE generation_id = ${generationId} AND stage = ${generation.stage}
  `,
  );
  if (counts.pending > 0) return;
  if (generation.stage < 3)
    await db.execute(
      sql`UPDATE progressive_generations SET stage = stage + 1 WHERE id = ${generationId}`,
    );
  else
    await db.execute(sql`
      UPDATE progressive_generations SET status = ${counts.gaps ? "attention" : "complete"},
        completed_at = CASE WHEN ${counts.gaps} = 0 THEN clock_timestamp() ELSE NULL END
      WHERE id = ${generationId}
    `);
}

export async function claimProgressiveWork(
  db: DB,
  input: {
    owner: string;
    stages: ProgressiveStage[];
    leaseSeconds: number;
    requireSweeperEnabled?: boolean;
    baselineGroup?: {
      generationId: string;
      airfoilId: string;
      geometry: number[][];
      recipe: Record<string, unknown>;
      maximumAngles: number;
    };
  },
): Promise<ProgressiveLease | null> {
  if (
    !input.owner ||
    !input.stages.length ||
    input.stages.some((stage) => ![1, 2, 3].includes(stage)) ||
    !Number.isInteger(input.leaseSeconds) ||
    input.leaseSeconds < 10 ||
    input.leaseSeconds > 3600
  )
    throw new Error("Invalid bounded progressive lease request");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const epochId = await currentEpoch(connection);
    if (input.requireSweeperEnabled) {
      const [admission] = await rows<{ enabled: boolean }>(
        connection,
        sql`SELECT enabled FROM sweeper_state WHERE id = 1 FOR SHARE`,
      );
      if (!admission?.enabled) return null;
    }
    const groupFilter = input.baselineGroup
      ? sql`
      generation.id = ${input.baselineGroup.generationId} AND work.stage = 1
      AND work.target_id IN (
        SELECT grouped.target_id FROM progressive_generation_targets grouped
        JOIN polar_analysis_targets physical_target ON physical_target.id = grouped.target_id
        WHERE grouped.generation_id = ${input.baselineGroup.generationId}
          AND physical_target.airfoil_id = ${input.baselineGroup.airfoilId}
          AND physical_target.physical->'geometry' = ${canonicalAnalysisJson(input.baselineGroup.geometry)}::jsonb
          AND grouped.recipes->'neuralfoil' = ${canonicalAnalysisJson(input.baselineGroup.recipe)}::jsonb
          AND cardinality(grouped.angles) <= ${input.baselineGroup.maximumAngles}
      )
    `
      : sql`true`;
    const [campaign] = await rows<{ id: string }>(
      connection,
      sql`
      SELECT campaign.id FROM sim_campaigns campaign
      WHERE campaign.status IN ('active', 'attention')
        AND EXISTS (
          SELECT 1 FROM progressive_generations generation JOIN progressive_work work ON work.generation_id = generation.id
          WHERE generation.campaign_id = campaign.id AND generation.epoch_id = ${epochId}
            AND generation.plan_revision_id = campaign.current_plan_revision_id
            AND ${groupFilter}
            AND generation.status = 'active' AND work.stage = generation.stage
            AND NOT EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = work.id)
            AND work.stage IN (${sql.join(
              input.stages.map((stage) => sql`${stage}`),
              sql`,`,
            )})
            AND (work.state = 'pending' OR (work.state = 'leased' AND work.lease_until <= clock_timestamp()))
        ) ORDER BY campaign.priority DESC, campaign."createdAt", campaign.id
      LIMIT 1 FOR UPDATE SKIP LOCKED
    `,
    );
    if (!campaign) return null;
    const [work] = await rows<{
      id: string;
      generation_id: string;
      target_id: string;
      stage: ProgressiveStage;
      attempts: number;
      angles: number[];
      recipes: SealedPolarTarget["recipes"];
      physical: AnalysisPhysical;
      revision_id: string;
    }>(
      connection,
      sql`
      SELECT work.id, work.generation_id, work.target_id, work.stage, work.attempts,
        scope.angles, scope.recipes, scope.revision_id, target.physical
      FROM progressive_work work JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN progressive_generation_targets scope ON scope.generation_id = generation.id AND scope.target_id = work.target_id
      JOIN polar_analysis_targets target ON target.id = work.target_id
      WHERE generation.campaign_id = ${campaign.id} AND generation.epoch_id = ${epochId}
        AND generation.plan_revision_id = (SELECT current_plan_revision_id FROM sim_campaigns WHERE id = ${campaign.id})
        AND ${groupFilter}
        AND generation.status = 'active' AND work.stage = generation.stage
        AND NOT EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = work.id)
        AND work.stage IN (${sql.join(
          input.stages.map((stage) => sql`${stage}`),
          sql`,`,
        )})
        AND (work.state = 'pending' OR (work.state = 'leased' AND work.lease_until <= clock_timestamp()))
      ORDER BY generation.created_at, generation.id, work.attempts, work.target_id LIMIT 1
      FOR UPDATE OF generation, work SKIP LOCKED
    `,
    );
    if (!work) return null;
    await connection.execute(sql`
      UPDATE progressive_work_attempts SET outcome = 'expired', finished_at = clock_timestamp(),
        error = 'delivery lease expired' WHERE work_id = ${work.id} AND outcome = 'running'
    `);
    if (work.attempts >= 2) {
      await connection.execute(sql`
        UPDATE progressive_work SET state = 'gap', error = 'bounded delivery attempts exhausted',
          lease_token = NULL, lease_owner = NULL, lease_until = NULL, completed_at = clock_timestamp()
        WHERE id = ${work.id}
      `);
      await advanceGeneration(connection, work.generation_id);
      return null;
    }
    const token = randomUUID();
    await connection.execute(sql`
      UPDATE progressive_work SET state = 'leased', lease_token = ${token}, lease_owner = ${input.owner},
        lease_until = clock_timestamp() + ${input.leaseSeconds} * interval '1 second', attempts = attempts + 1
      WHERE id = ${work.id}
    `);
    await connection.execute(sql`
      INSERT INTO progressive_work_attempts (token, work_id, owner, lease_until)
      SELECT ${token}, id, lease_owner, lease_until FROM progressive_work WHERE id = ${work.id}
    `);
    return {
      id: work.id,
      epochId,
      generationId: work.generation_id,
      targetId: work.target_id,
      campaignId: campaign.id,
      stage: work.stage,
      token,
      owner: input.owner,
      attempts: work.attempts + 1,
      angles: work.angles,
      recipes: work.recipes,
      physical: work.physical,
      revisionId: work.revision_id,
    };
  });
}

async function lockLease(db: DB, lease: ProgressiveLease) {
  await currentEpoch(db, lease.epochId);
  const [campaign] = await rows<{
    status: string;
    current_plan_revision_id: string;
  }>(
    db,
    sql`
    SELECT status, current_plan_revision_id FROM sim_campaigns WHERE id = ${lease.campaignId} FOR UPDATE
  `,
  );
  if (!campaign || ["cancelled", "archived"].includes(campaign.status))
    throw new Error("Campaign no longer accepts this work");
  const [work] = await rows<{ id: string; attempts: number }>(
    db,
    sql`
    SELECT work.id, work.attempts FROM progressive_work work
    JOIN progressive_generations generation ON generation.id = work.generation_id
    WHERE work.id = ${lease.id} AND work.generation_id = ${lease.generationId} AND work.target_id = ${lease.targetId}
      AND work.stage = ${lease.stage} AND work.state = 'leased'
      AND work.lease_token = ${lease.token} AND work.lease_owner = ${lease.owner}
      AND work.lease_until > clock_timestamp() AND generation.epoch_id = ${lease.epochId}
      AND generation.campaign_id = ${lease.campaignId} AND generation.stage = work.stage AND generation.status = 'active'
      AND generation.plan_revision_id = ${campaign.current_plan_revision_id}
    FOR UPDATE OF generation, work
  `,
  );
  if (!work) throw new Error("Progressive work lease is obsolete or expired");
  return work;
}

export async function failProgressiveWork(
  db: DB,
  lease: ProgressiveLease,
  error: string,
  retryDiagnosed: boolean,
) {
  if (!error.trim())
    throw new Error("A failed attempt requires an explanation");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const work = await lockLease(connection, lease);
    const retry = retryDiagnosed && work.attempts < 2;
    await connection.execute(sql`
      UPDATE progressive_work_attempts SET outcome = 'failed', error = ${error.slice(0, 4000)},
        finished_at = clock_timestamp() WHERE token = ${lease.token} AND outcome = 'running'
    `);
    await connection.execute(sql`
      UPDATE progressive_work SET state = ${retry ? "pending" : "gap"}, error = ${error.slice(0, 4000)},
        lease_token = NULL, lease_owner = NULL, lease_until = NULL,
        completed_at = CASE WHEN ${retry} THEN NULL ELSE clock_timestamp() END WHERE id = ${lease.id}
    `);
    if (!retry) await advanceGeneration(connection, lease.generationId);
  });
}

export async function storeNeuralFoilPrediction(
  db: DB,
  lease: ProgressiveLease,
  payload: Record<string, unknown>,
) {
  if (lease.stage !== 1)
    throw new Error("NeuralFoil output cannot complete CFD work");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await currentEpoch(connection, lease.epochId);
    const id = analysisContentHash({ epochId: lease.epochId, payload });
    const [replay] = await rows<{ prediction_id: string }>(
      connection,
      sql`
      SELECT link.prediction_id FROM progressive_prediction_links link
      JOIN progressive_work_attempts attempt ON attempt.work_id = link.work_id
      JOIN progressive_work work ON work.id = link.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      WHERE link.work_id = ${lease.id} AND attempt.token = ${lease.token} AND attempt.owner = ${lease.owner}
        AND attempt.outcome = 'complete' AND work.target_id = ${lease.targetId} AND work.generation_id = ${lease.generationId}
        AND generation.epoch_id = ${lease.epochId} AND generation.campaign_id = ${lease.campaignId}
    `,
    );
    if (replay) {
      if (replay.prediction_id !== id)
        throw new Error("Completed prediction replay has different content");
      return id;
    }
    await lockLease(connection, lease);
    const [scope] = await rows<{
      angles: number[];
      recipes: SealedPolarTarget["recipes"];
      physical: AnalysisPhysical;
    }>(
      connection,
      sql`
      SELECT scope.angles, scope.recipes, target.physical FROM progressive_generation_targets scope
      JOIN polar_analysis_targets target ON target.id = scope.target_id
      WHERE scope.generation_id = ${lease.generationId} AND scope.target_id = ${lease.targetId}
    `,
    );
    if (
      payload.kind !== "prediction" ||
      payload.method !== "neuralfoil" ||
      payload.cfd_evidence !== false ||
      payload.target_signature !== lease.targetId ||
      !/^[a-f0-9]{64}$/.test(String(payload.prediction_id)) ||
      canonicalAnalysisJson(payload.alpha) !==
        canonicalAnalysisJson(scope.angles) ||
      canonicalAnalysisJson(payload.recipe) !==
        canonicalAnalysisJson(scope.recipes.neuralfoil)
    )
      throw new Error("Prediction does not match its sealed target and recipe");
    const expectedCondition = {
      target_signature: lease.targetId,
      reynolds: scope.physical.derived.reynolds,
      mach: scope.physical.derived.mach,
      alpha: scope.angles,
      n_crit: scope.physical.transition.nCrit,
      transition_upper: scope.physical.transition.upper,
      transition_lower: scope.physical.transition.lower,
      roughness_height: scope.physical.boundary.sandGrainHeight,
    };
    if (
      canonicalAnalysisJson(payload.condition) !==
      canonicalAnalysisJson(expectedCondition)
    )
      throw new Error(
        "Prediction physical inputs differ from the analysis target",
      );
    const coefficients = payload.coefficients;
    const confidence = payload.analysis_confidence;
    if (
      !Array.isArray(coefficients) ||
      coefficients.length !== scope.angles.length ||
      !coefficients.every(
        (row) =>
          Array.isArray(row) &&
          row.length === 3 &&
          row.every(Number.isFinite) &&
          row[1] > 0,
      ) ||
      !Array.isArray(confidence) ||
      confidence.length !== scope.angles.length ||
      !confidence.every(
        (value) => Number.isFinite(value) && value >= 0 && value <= 1,
      )
    )
      throw new Error("Prediction contains invalid aerodynamic output");
    const model = payload.model as Record<string, unknown> | undefined;
    const geometryFit = payload.geometry_fit as
      | Record<string, unknown>
      | undefined;
    if (
      !model ||
      model.neuralfoil !== "0.3.3" ||
      model.aerosandbox !== "4.2.10" ||
      model.model_size !== scope.recipes.neuralfoil.model_size ||
      !/^[a-f0-9]{64}$/.test(String(model.weights_sha256)) ||
      !/^[a-f0-9]{64}$/.test(String(model.training_distribution_sha256)) ||
      payload.uncertainty_calibration !== "unvalidated" ||
      !payload.geometry_provenance ||
      !geometryFit ||
      typeof geometryFit.rms_chord !== "number" ||
      !Number.isFinite(geometryFit.rms_chord) ||
      geometryFit.rms_chord < 0 ||
      typeof geometryFit.maximum_chord !== "number" ||
      !Number.isFinite(geometryFit.maximum_chord) ||
      geometryFit.maximum_chord < geometryFit.rms_chord ||
      geometryFit.rms_chord >
        Number(scope.recipes.neuralfoil.maximum_geometry_rms) ||
      geometryFit.maximum_chord >
        Number(scope.recipes.neuralfoil.maximum_geometry_error)
    )
      throw new Error("Prediction is missing model and geometry provenance");
    await connection.execute(sql`
      INSERT INTO neuralfoil_predictions (id, epoch_id, target_id, payload)
      VALUES (${id}, ${lease.epochId}, ${lease.targetId}, ${canonicalAnalysisJson(payload)}::jsonb)
      ON CONFLICT (id) DO NOTHING
    `);
    await connection.execute(
      sql`INSERT INTO progressive_prediction_links (work_id, prediction_id) VALUES (${lease.id}, ${id})`,
    );
    await connection.execute(sql`
      UPDATE progressive_work_attempts SET outcome = 'complete', finished_at = clock_timestamp()
      WHERE token = ${lease.token} AND outcome = 'running'
    `);
    await connection.execute(sql`
      UPDATE progressive_work SET state = 'complete', completed_at = clock_timestamp(), error = NULL,
        lease_token = NULL, lease_owner = NULL, lease_until = NULL WHERE id = ${lease.id}
    `);
    await advanceGeneration(connection, lease.generationId);
    return id;
  });
}
