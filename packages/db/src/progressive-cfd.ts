import { randomUUID } from "node:crypto";
import {
  initialFastAnchors,
  PROGRESSIVE_COMPUTE_POLICY,
  selectProgressiveSolver,
  type ProgressiveSolverFamily,
} from "@aerodb/core";
import { sql } from "drizzle-orm";
import {
  canonicalAnalysisJson,
  type AnalysisPhysical,
} from "./analysis-target";
import type { DB } from "./client";
import type { SealedPolarTarget } from "./progressive-campaigns";

interface WorkScope {
  id: string;
  generation_id: string;
  target_id: string;
  stage: 2 | 3;
  angles: number[];
  recipes: SealedPolarTarget["recipes"];
  physical: AnalysisPhysical;
  prediction: {
    alpha: number[];
    coefficients: number[][];
    compressibility_diagnostics?: { critical_mach?: Array<number | null> };
  } | null;
}

export interface ProgressiveCfdLease {
  id: string;
  workId: string;
  generationId: string;
  campaignId: string;
  epochId: string;
  targetId: string;
  revisionId: string;
  stage: 2 | 3;
  alpha: number;
  token: string;
  owner: string;
  recipe: Record<string, unknown>;
  physical: AnalysisPhysical;
  remainingActiveSeconds: number;
  recoveryPlanId?: string | null;
  recoveryParentJobId?: string | null;
}

export async function initializeProgressiveCfdWork(db: DB): Promise<number> {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
    const [campaign] = await connection.execute(sql`
      SELECT campaign.id FROM sim_campaigns campaign WHERE campaign.status IN ('active', 'attention', 'paused')
        AND EXISTS (
          SELECT 1 FROM progressive_generations generation JOIN progressive_work work ON work.generation_id = generation.id
          WHERE generation.campaign_id = campaign.id AND generation.epoch_id = ${epoch.id}
            AND generation.plan_revision_id = campaign.current_plan_revision_id AND generation.status = 'active'
            AND generation.stage IN (2, 3) AND work.stage = generation.stage AND work.state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = work.id)
        ) ORDER BY campaign.priority DESC, campaign."createdAt", campaign.id LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    if (!campaign) return 0;
    const scopes = (await connection.execute(sql`
      SELECT work.id, work.generation_id, work.target_id, work.stage, scope.angles, scope.recipes, target.physical,
        prediction.payload AS prediction
      FROM progressive_work work JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN progressive_generation_targets scope ON scope.generation_id = generation.id AND scope.target_id = work.target_id
      JOIN polar_analysis_targets target ON target.id = work.target_id
      LEFT JOIN progressive_work baseline ON baseline.generation_id = generation.id AND baseline.target_id = work.target_id AND baseline.stage = 1
      LEFT JOIN progressive_prediction_links link ON link.work_id = baseline.id
      LEFT JOIN neuralfoil_predictions prediction ON prediction.id = link.prediction_id AND prediction.epoch_id = generation.epoch_id
      WHERE generation.campaign_id = ${campaign.id} AND generation.epoch_id = ${epoch.id}
        AND generation.plan_revision_id = (SELECT current_plan_revision_id FROM sim_campaigns WHERE id = ${campaign.id})
        AND generation.status = 'active' AND generation.stage IN (2, 3) AND work.stage = generation.stage AND work.state = 'pending'
        AND NOT EXISTS (SELECT 1 FROM progressive_cfd_units unit WHERE unit.work_id = work.id)
      ORDER BY generation.created_at, generation.id, work.target_id LIMIT 64 FOR UPDATE OF generation, work SKIP LOCKED
    `)) as unknown as WorkScope[];
    let inserted = 0;
    for (const scope of scopes) {
      const anchors =
        scope.stage === 2
          ? initialFastAnchors(
              scope.angles,
              scope.prediction?.alpha.map((alpha, index) => ({
                alpha,
                cl: scope.prediction!.coefficients[index][0],
                cd: scope.prediction!.coefficients[index][1],
              })) ?? null,
            )
          : { angles: scope.angles, reason: "precise_requested_grid" };
      const critical =
        scope.prediction?.compressibility_diagnostics?.critical_mach;
      const minimumCriticalMach =
        critical?.length &&
        critical.every(
          (value) => value !== null && Number.isFinite(value) && value > 0,
        )
          ? Math.min(...(critical as number[]))
          : null;
      const selection = selectProgressiveSolver({
        mach: scope.physical.derived.mach!,
        minimumCriticalMach,
        diagnosedUnsteadiness: false,
        diagnosedShockInstability: false,
      });
      const recipe = {
        ...(scope.stage === 2 ? scope.recipes.fast : scope.recipes.precise),
        selection,
        turbulentPrandtl:
          selection.pressureKind === "absolute"
            ? PROGRESSIVE_COMPUTE_POLICY.turbulentPrandtl
            : null,
      };
      const budget =
        scope.stage === 2
          ? PROGRESSIVE_COMPUTE_POLICY.fastAnchorActiveSeconds
          : PROGRESSIVE_COMPUTE_POLICY.preciseInitialActiveSeconds;
      const units = anchors.angles.map((alpha, ordinal) => ({
        alpha,
        ordinal,
      }));
      await connection.execute(sql`
        INSERT INTO progressive_cfd_units (work_id, aoa_deg, ordinal, purpose, recipe, reason, active_budget_seconds, policy_version)
        SELECT ${scope.id}, source.alpha, source.ordinal, ${scope.stage === 2 ? "initial" : "precise"},
          ${canonicalAnalysisJson(recipe)}::jsonb, ${anchors.reason}, ${budget}, ${PROGRESSIVE_COMPUTE_POLICY.version}
        FROM jsonb_to_recordset(${canonicalAnalysisJson(units)}::jsonb) AS source(alpha double precision, ordinal integer)
      `);
      inserted += units.length;
    }
    return inserted;
  });
}

export async function claimProgressiveCfdUnit(
  db: DB,
  input: {
    owner: string;
    leaseSeconds: number;
    requireSweeperEnabled?: boolean;
    allowedSolverFamilies?: readonly ProgressiveSolverFamily[];
    allowPhysicalTime?: boolean;
    solverBudgetVersion?: number | null;
    remoteSolverId?: string;
    sameTarget?: {
      generationId: string;
      targetId: string;
      recipe: Record<string, unknown>;
      remainingActiveSeconds: number;
      recoveryParentJobId?: string | null;
    };
  },
): Promise<ProgressiveCfdLease | null> {
  if (
    !input.owner.trim() ||
    !Number.isInteger(input.leaseSeconds) ||
    input.leaseSeconds < 10 ||
    input.leaseSeconds > 3600
  )
    throw new Error("Invalid bounded CFD lease request");
  if (
    input.allowedSolverFamilies?.some(
      (family) =>
        ![
          "simpleFoam",
          "pimpleFoam",
          "rhoSimpleFoam",
          "rhoPimpleFoam",
          "rhoCentralFoam",
        ].includes(family),
    )
  )
    throw new Error("Unknown progressive solver capability");
  if (input.allowedSolverFamilies?.length === 0) return null;
  if (
    input.remoteSolverId !== undefined &&
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      input.remoteSolverId,
    )
  )
    throw new Error(
      "Recovery ownership requires an exact registered worker identity",
    );
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (!epoch) throw new Error("Calculation epoch is missing");
    const effectiveRecipe = sql`coalesce((SELECT recovery.recipe FROM progressive_cfd_recovery_plans recovery WHERE recovery.unit_id = unit.id ORDER BY recovery.ordinal DESC LIMIT 1), unit.recipe)`;
    const recoveryParent = sql`(SELECT recovery.parent_job_id FROM progressive_cfd_recovery_plans recovery WHERE recovery.unit_id = unit.id ORDER BY recovery.ordinal DESC LIMIT 1)`;
    const recoveryOwner = input.remoteSolverId
      ? sql`(${recoveryParent} IS NULL OR EXISTS (SELECT 1 FROM progressive_remote_dispatches dispatch WHERE dispatch.sim_job_id = ${recoveryParent} AND dispatch.solver_id = ${input.remoteSolverId}::uuid))`
      : sql`(${recoveryParent} IS NULL OR NOT EXISTS (SELECT 1 FROM progressive_remote_dispatches dispatch WHERE dispatch.sim_job_id = ${recoveryParent}))`;
    const attemptAvailable = sql`(unit.attempts < 2 OR (unit.attempts = 2 AND work.stage = 3 AND unit.policy_version = ${PROGRESSIVE_COMPUTE_POLICY.version} AND EXISTS (
      SELECT 1 FROM progressive_cfd_recovery_plans recovery WHERE recovery.unit_id = unit.id AND recovery.ordinal = 2
        AND NOT EXISTS (SELECT 1 FROM progressive_cfd_recovery_claims claimed WHERE claimed.recovery_plan_id = recovery.id)
    )))`;
    const targetFilter = input.sameTarget
      ? sql`generation.id = ${input.sameTarget.generationId} AND work.target_id = ${input.sameTarget.targetId}
          AND ${effectiveRecipe} = ${JSON.stringify(input.sameTarget.recipe)}::jsonb
          AND ${recoveryParent} IS NOT DISTINCT FROM ${input.sameTarget.recoveryParentJobId ?? null}::uuid
          AND (${input.solverBudgetVersion === 2} OR unit.active_budget_seconds - unit.active_seconds = ${input.sameTarget.remainingActiveSeconds})`
      : sql`true`;
    const selectedFamilies = input.allowedSolverFamilies
      ? sql`(${effectiveRecipe})->'selection'->>'solver' IN (${sql.join(
          input.allowedSolverFamilies.map((family) => sql`${family}`),
          sql`, `,
        )})`
      : sql`true`;
    const familyFilter = sql`(${selectedFamilies}) AND (${input.allowPhysicalTime !== false}
      OR (${effectiveRecipe})->'selection'->>'solver' IN ('simpleFoam', 'rhoSimpleFoam')
      OR ((${effectiveRecipe})->'selection'->>'solver' = 'rhoCentralFoam'
        AND (${effectiveRecipe})->>'timeCoordinate' = 'local_pseudo_time_iterations'))`;
    const previousExecutionStopped = sql`NOT EXISTS (
      SELECT 1 FROM progressive_cfd_attempts previous_attempt
      JOIN progressive_cfd_units previous_unit ON previous_unit.id = previous_attempt.unit_id
      JOIN progressive_work previous_work ON previous_work.id = previous_unit.work_id
      JOIN progressive_generations previous_generation ON previous_generation.id = previous_work.generation_id
      JOIN sim_jobs previous_job ON previous_job.id = previous_attempt.sim_job_id
      WHERE previous_generation.campaign_id = generation.campaign_id AND previous_work.target_id = work.target_id
        AND previous_generation.id <> generation.id
        AND NOT EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
          WHERE stopped.sim_job_id = previous_job.id AND stopped.engine_job_id = previous_job.engine_job_id)
    )`;
    if (input.requireSweeperEnabled) {
      const [state] = await connection.execute(
        sql`SELECT enabled FROM sweeper_state WHERE id = 1 FOR SHARE`,
      );
      if (!state?.enabled) return null;
    }
    const [campaign] = await connection.execute(sql`
      SELECT campaign.id FROM sim_campaigns campaign WHERE campaign.status IN ('active', 'attention')
        AND EXISTS (
          SELECT 1 FROM progressive_generations generation JOIN progressive_work work ON work.generation_id = generation.id
          JOIN progressive_cfd_units unit ON unit.work_id = work.id
          WHERE generation.campaign_id = campaign.id AND generation.epoch_id = ${epoch.id}
            AND ${targetFilter}
            AND ${familyFilter}
            AND ${recoveryOwner}
            AND ${previousExecutionStopped}
            AND generation.plan_revision_id = campaign.current_plan_revision_id AND generation.status = 'active'
            AND work.stage = generation.stage AND work.stage IN (2, 3) AND work.state = 'pending'
            AND unit.state = 'pending' AND ${attemptAvailable} AND unit.active_seconds < unit.active_budget_seconds
        ) ORDER BY campaign.priority DESC, campaign."createdAt", campaign.id LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    if (!campaign) return null;
    const [unit] = (await connection.execute(sql`
      SELECT unit.id, unit.work_id, work.generation_id, work.target_id, scope.revision_id,
        work.stage, unit.aoa_deg, ${effectiveRecipe} AS recipe, target.physical,
        (SELECT recovery.id FROM progressive_cfd_recovery_plans recovery WHERE recovery.unit_id = unit.id ORDER BY recovery.ordinal DESC LIMIT 1) AS recovery_plan_id,
        ${recoveryParent} AS recovery_parent_job_id,
        unit.active_budget_seconds - unit.active_seconds AS remaining_active_seconds
      FROM progressive_cfd_units unit JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN progressive_generation_targets scope ON scope.generation_id = generation.id AND scope.target_id = work.target_id
      JOIN polar_analysis_targets target ON target.id = work.target_id
      WHERE generation.campaign_id = ${campaign.id} AND generation.epoch_id = ${epoch.id}
        AND ${targetFilter}
        AND ${familyFilter}
        AND ${recoveryOwner}
        AND ${previousExecutionStopped}
        AND generation.plan_revision_id = (SELECT current_plan_revision_id FROM sim_campaigns WHERE id = ${campaign.id})
        AND generation.status = 'active' AND work.stage = generation.stage AND work.stage IN (2, 3) AND work.state = 'pending'
        AND unit.state = 'pending' AND ${attemptAvailable} AND unit.active_seconds < unit.active_budget_seconds
        AND NOT EXISTS (
          SELECT 1 FROM progressive_work sibling WHERE sibling.generation_id = generation.id AND sibling.stage = work.stage
            AND sibling.state = 'pending' AND NOT EXISTS (SELECT 1 FROM progressive_cfd_units initialized WHERE initialized.work_id = sibling.id)
        )
        AND (unit.purpose <> 'adaptive' OR NOT EXISTS (
          SELECT 1 FROM progressive_cfd_units initial JOIN progressive_work sibling ON sibling.id = initial.work_id
          WHERE sibling.generation_id = generation.id AND sibling.stage = work.stage
            AND initial.purpose = 'initial' AND initial.state NOT IN ('complete', 'gap')
        ))
      ORDER BY generation.created_at, generation.id, CASE WHEN unit.purpose = 'initial' THEN 0 ELSE 1 END,
        unit.ordinal, work.target_id LIMIT 1 FOR UPDATE OF generation, work, unit SKIP LOCKED
    `)) as unknown as Array<{
      id: string;
      work_id: string;
      generation_id: string;
      target_id: string;
      revision_id: string;
      stage: 2 | 3;
      aoa_deg: number;
      recipe: Record<string, unknown>;
      physical: AnalysisPhysical;
      remaining_active_seconds: number;
      recovery_plan_id: string | null;
      recovery_parent_job_id: string | null;
    }>;
    if (!unit) return null;
    const token = randomUUID();
    await connection.execute(sql`
      UPDATE progressive_cfd_units SET state = 'leased', lease_token = ${token}, lease_owner = ${input.owner},
        lease_until = clock_timestamp() + ${input.leaseSeconds} * interval '1 second', attempts = attempts + 1
      WHERE id = ${unit.id}
    `);
    await connection.execute(sql`
      INSERT INTO progressive_cfd_attempts (token, unit_id, owner, lease_until)
      SELECT ${token}, id, lease_owner, lease_until FROM progressive_cfd_units WHERE id = ${unit.id}
    `);
    if (unit.recovery_plan_id)
      await connection.execute(sql`
        INSERT INTO progressive_cfd_recovery_claims (attempt_token, recovery_plan_id)
        VALUES (${token}, ${unit.recovery_plan_id})
      `);
    return {
      id: unit.id,
      workId: unit.work_id,
      generationId: unit.generation_id,
      campaignId: String(campaign.id),
      epochId: String(epoch.id),
      targetId: unit.target_id,
      revisionId: unit.revision_id,
      stage: unit.stage,
      alpha: unit.aoa_deg,
      token,
      owner: input.owner,
      recipe: unit.recipe,
      physical: unit.physical,
      remainingActiveSeconds: unit.remaining_active_seconds,
      recoveryPlanId: unit.recovery_plan_id,
      recoveryParentJobId: unit.recovery_parent_job_id,
    };
  });
}

export async function claimProgressiveCfdBatch(
  db: DB,
  input: {
    owner: string;
    leaseSeconds: number;
    maximumUnits?: number;
    requireSweeperEnabled?: boolean;
    allowedSolverFamilies?: readonly ProgressiveSolverFamily[];
    allowPhysicalTime?: boolean;
    solverBudgetVersion?: number | null;
    remoteSolverId?: string;
  },
): Promise<ProgressiveCfdLease[]> {
  const maximum = input.maximumUnits ?? 64;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 512)
    throw new Error("Invalid bounded CFD batch size");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const first = await claimProgressiveCfdUnit(connection, input);
    if (!first) return [];
    const batch = [first];
    while (batch.length < maximum) {
      const next = await claimProgressiveCfdUnit(connection, {
        ...input,
        sameTarget: {
          generationId: first.generationId,
          targetId: first.targetId,
          recipe: first.recipe,
          remainingActiveSeconds: first.remainingActiveSeconds,
          recoveryParentJobId: first.recoveryParentJobId,
        },
      });
      if (!next) break;
      batch.push(next);
    }
    return batch.sort((left, right) => left.alpha - right.alpha);
  });
}

export async function cancelObsoleteProgressiveCfdUnits(
  db: DB,
  campaignId?: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE progressive_cfd_attempts attempt SET outcome = 'cancelled', finished_at = clock_timestamp(),
      error = 'campaign stopped, plan superseded or calculation epoch replaced'
    FROM progressive_cfd_units unit JOIN progressive_work work ON work.id = unit.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    WHERE attempt.unit_id = unit.id AND attempt.outcome = 'running' AND generation.status = 'cancelled'
      AND attempt.sim_job_id IS NULL
      ${campaignId ? sql`AND generation.campaign_id = ${campaignId}` : sql``}
  `);
  await db.execute(sql`
    UPDATE progressive_cfd_units unit SET state = 'cancelled', lease_token = NULL, lease_owner = NULL, lease_until = NULL,
      error = 'campaign stopped, plan superseded or calculation epoch replaced'
    FROM progressive_work work JOIN progressive_generations generation ON generation.id = work.generation_id
    WHERE unit.work_id = work.id AND generation.status = 'cancelled' AND unit.state IN ('pending', 'leased', 'blocked')
      ${campaignId ? sql`AND generation.campaign_id = ${campaignId}` : sql``}
  `);
}

export async function heartbeatProgressiveCfdUnit(
  db: DB,
  lease: ProgressiveCfdLease,
  input: {
    attemptActiveSeconds: number;
    leaseSeconds: number;
  },
): Promise<{ remainingActiveSeconds: number; stopRequired: boolean }> {
  if (
    !Number.isFinite(input.attemptActiveSeconds) ||
    input.attemptActiveSeconds < 0 ||
    !Number.isInteger(input.leaseSeconds) ||
    input.leaseSeconds < 10 ||
    input.leaseSeconds > 3600
  )
    throw new Error("Invalid measured CFD progress");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    if (epoch?.id !== lease.epochId)
      throw new Error("Obsolete CFD calculation epoch");
    const [campaign] = await connection.execute(sql`
      SELECT status, current_plan_revision_id FROM sim_campaigns WHERE id = ${lease.campaignId} FOR UPDATE
    `);
    if (
      !campaign ||
      ["cancelled", "archived"].includes(String(campaign.status))
    )
      throw new Error("Campaign no longer accepts CFD progress");
    const [unit] = await connection.execute(sql`
      SELECT unit.active_budget_seconds, unit.active_seconds, attempt.active_seconds AS attempt_seconds
      FROM progressive_cfd_units unit JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN progressive_cfd_attempts attempt ON attempt.token = unit.lease_token AND attempt.unit_id = unit.id
      WHERE unit.id = ${lease.id} AND unit.work_id = ${lease.workId} AND unit.aoa_deg = ${lease.alpha}
        AND unit.state = 'leased' AND unit.lease_token = ${lease.token} AND unit.lease_owner = ${lease.owner}
        AND unit.lease_until > clock_timestamp() AND attempt.outcome = 'running'
        AND generation.id = ${lease.generationId} AND generation.epoch_id = ${lease.epochId}
        AND generation.campaign_id = ${lease.campaignId} AND generation.plan_revision_id = ${campaign.current_plan_revision_id}
        AND generation.status = 'active' AND generation.stage = work.stage AND work.stage = ${lease.stage}
        AND work.target_id = ${lease.targetId}
      FOR UPDATE OF generation, work, unit, attempt
    `);
    if (!unit) throw new Error("Obsolete or expired CFD work lease");
    const previous = Number(unit.attempt_seconds);
    if (input.attemptActiveSeconds < previous)
      throw new Error("Measured active solver time cannot decrease");
    const total =
      Number(unit.active_seconds) + input.attemptActiveSeconds - previous;
    const remaining = Math.max(0, Number(unit.active_budget_seconds) - total);
    await connection.execute(sql`
      UPDATE progressive_cfd_attempts SET active_seconds = ${input.attemptActiveSeconds},
        lease_until = clock_timestamp() + ${input.leaseSeconds} * interval '1 second' WHERE token = ${lease.token}
    `);
    await connection.execute(sql`
      UPDATE progressive_cfd_units SET active_seconds = ${total},
        state = ${remaining > 0 ? "leased" : "blocked"},
        lease_token = ${remaining > 0 ? lease.token : null}::uuid,
        lease_owner = ${remaining > 0 ? lease.owner : null},
        lease_until = CASE WHEN ${remaining > 0} THEN clock_timestamp() + ${input.leaseSeconds} * interval '1 second' ELSE NULL END,
        error = CASE WHEN ${remaining > 0} THEN NULL ELSE 'active compute budget exhausted; execution stop acknowledgement required' END
      WHERE id = ${lease.id}
    `);
    return { remainingActiveSeconds: remaining, stopRequired: remaining === 0 };
  });
}
