import { sql } from "drizzle-orm";
import {
  airfoilConcaveCurvature,
  fastWallSpacing,
  FAST_WALL_SPACING_POLICY,
  PROGRESSIVE_COMPUTE_POLICY,
} from "@aerodb/core";
import type { DB } from "./client";
import { cancelObsoleteProgressiveCfdUnits } from "./progressive-cfd";
import { campaignEnrollmentScope } from "./campaigns";
import { createAnalysisTarget, analysisContentHash } from "./analysis-target";
import {
  sealProgressiveGeneration,
  type SealedPolarTarget,
} from "./progressive-campaigns";
import type { SimulationSetupSnapshot } from "./simulation-setup";

export function progressiveRecipes(
  snapshot: SimulationSetupSnapshot,
  maximumConcaveCurvature: number | null = null,
): SealedPolarTarget["recipes"] {
  if (snapshot.solver.turbulenceModel !== "kOmegaSST")
    throw new Error(
      "Progressive recipe requires an explicit transition policy for this turbulence model",
    );
  const {
    id: _meshId,
    slug: _meshSlug,
    name: _meshName,
    ...mesh
  } = snapshot.mesh;
  const {
    id: _solverId,
    slug: _solverSlug,
    name: _solverName,
    ...solver
  } = snapshot.solver;
  const common = {
    engine: snapshot.engine ?? null,
    transition: "fully_turbulent",
    validation: "unvalidated",
  };
  const localDensity =
    snapshot.derived.mach !== null &&
    snapshot.derived.mach >=
      PROGRESSIVE_COMPUTE_POLICY.densityBasedMachThreshold;
  const wallSpacing = fastWallSpacing(
    mesh.targetYPlus,
    maximumConcaveCurvature,
  );
  return {
    neuralfoil: {
      recipe_id: "neuralfoil-prior-v1",
      model_size: "large",
      maximum_geometry_rms: 0.003,
      maximum_geometry_error: 0.012,
    },
    fast: {
      ...common,
      recipe_id: localDensity
        ? "openfoam-fast-density-local-v1"
        : "openfoam-fast-wall-v2",
      ...(!localDensity ? { wallSpacing } : {}),
      ...(localDensity
        ? { timeCoordinate: "local_pseudo_time_iterations" }
        : {}),
      mesh: {
        ...mesh,
        targetYPlus: localDensity ? 40 : wallSpacing.targetYPlus,
        nSurface: Math.min(
          mesh.nSurface,
          Math.max(80, Math.floor(mesh.nSurface * 0.65)),
        ),
        nRadial: Math.min(
          mesh.nRadial,
          Math.max(40, Math.floor(mesh.nRadial * 0.65)),
        ),
        nWake: Math.min(
          mesh.nWake,
          Math.max(40, Math.floor(mesh.nWake * 0.65)),
        ),
      },
      solver: {
        ...solver,
        nIterations: localDensity ? 5000 : Math.min(solver.nIterations, 1500),
        ...(localDensity ? { momentumScheme: "upwind" } : {}),
        convergenceTolerance: Math.max(solver.convergenceTolerance, 1e-4),
      },
    },
    precise: { ...common, recipe_id: "openfoam-precise-v1", mesh, solver },
  };
}

export async function materializeProgressiveCampaignScope(
  db: DB,
  campaignId: string,
  profileIds?: string[],
  requestVersion?: string,
) {
  if (profileIds?.length === 0) return null;
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = (await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    )) as unknown as Array<{ id: string }>;
    if (!epoch) throw new Error("Calculation epoch is missing");
    const [campaign] = (await connection.execute(sql`
      SELECT id, status, current_condition_generation FROM sim_campaigns WHERE id = ${campaignId} FOR UPDATE
    `)) as unknown as Array<{
      id: string;
      status: string;
      current_condition_generation: number;
    }>;
    if (!campaign) throw new Error("Campaign does not exist");
    if (campaign.status === "cancelled" || campaign.status === "archived")
      return null;
    const intent = await campaignEnrollmentScope(connection, campaignId);
    const profiles = (await connection.execute(sql`
      SELECT airfoil.id, airfoil.points FROM sim_campaign_airfoils membership
      JOIN airfoils airfoil ON airfoil.id = membership.airfoil_id
      WHERE membership.campaign_id = ${campaignId} AND airfoil."deletedAt" IS NULL AND airfoil."archivedAt" IS NULL
        ${
          profileIds
            ? sql`AND airfoil.id IN (${sql.join(
                profileIds.map((id) => sql`${id}`),
                sql`,`,
              )})`
            : sql``
        }
      ORDER BY airfoil.id
    `)) as unknown as Array<{
      id: string;
      points: Array<{ x: number; y: number }>;
    }>;
    const conditions = (await connection.execute(sql`
      SELECT condition.id, revision.id AS revision_id, revision.snapshot
      FROM sim_campaign_conditions condition JOIN simulation_preset_revisions revision ON revision.id = condition.simulation_preset_revision_id
      WHERE condition.campaign_id = ${campaignId} AND condition.generation = ${campaign.current_condition_generation}
        AND condition.status IN ('active', 'kept') ORDER BY condition.id
    `)) as unknown as Array<{
      id: string;
      revision_id: string;
      snapshot: SimulationSetupSnapshot;
    }>;
    const targets: SealedPolarTarget[] = [];
    const profileCurvature = new Map(
      profiles.map((profile) => [
        profile.id,
        airfoilConcaveCurvature(profile.points),
      ]),
    );
    for (const condition of conditions) {
      const { snapshot } = condition;
      if (!snapshot.material)
        throw new Error(
          "Campaign setup needs an explicit material-snapshot replan before progressive solving",
        );
      const angles = intent.cellsByCondition.get(condition.id)?.angles;
      if (!angles)
        throw new Error("Campaign condition has no preserved angle intent");
      for (const profile of profiles) {
        const recipes = progressiveRecipes(
          snapshot,
          profileCurvature.get(profile.id) ?? null,
        );
        const target = createAnalysisTarget({
          airfoilId: profile.id,
          points: profile.points,
          snapshot,
          material: {
            ...snapshot.material,
            speedOfSound: snapshot.material.speedOfSound ?? null,
          },
          transition: {
            model: "fully_turbulent",
            nCrit: 9,
            upper: 0,
            lower: 0,
          },
          branch: "increasing",
        });
        targets.push({
          airfoilId: profile.id,
          targetId: target.signature,
          physical: target.physical,
          revisionId: condition.revision_id,
          angles,
          recipes,
        });
      }
    }
    if (!targets.length) return null;
    return sealProgressiveGeneration(connection, {
      campaignId,
      planRevisionId: intent.revisionId,
      scopeKey: analysisContentHash({
        fastWallSpacingPolicy: FAST_WALL_SPACING_POLICY,
        plan: intent.revisionId,
        profiles: profiles.map((profile) => profile.id),
        ...(requestVersion ? { requestVersion } : {}),
      }),
      targets,
    });
  });
}

export async function reconcileProgressiveGenerationRequest(db: DB) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [epoch] = (await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    )) as unknown as Array<{ id: string }>;
    if (!epoch) throw new Error("Calculation epoch is missing");
    const [request] = (await connection.execute(sql`
      SELECT campaign.id AS campaign_id, campaign.current_plan_revision_id AS plan_revision_id,
        campaign.status, request.requested_version
      FROM progressive_scope_requests request JOIN sim_campaigns campaign ON campaign.id = request.campaign_id
      WHERE request.requested_version > request.processed_version
      ORDER BY campaign.priority DESC, request.requested_at, campaign.id
      LIMIT 1 FOR UPDATE OF campaign SKIP LOCKED
    `)) as unknown as Array<{
      campaign_id: string;
      plan_revision_id: string;
      status: string;
      requested_version: string;
    }>;
    if (!request) return null;
    await connection.execute(sql`
      UPDATE progressive_generations SET status = 'cancelled'
      WHERE campaign_id = ${request.campaign_id} AND epoch_id = ${epoch.id}
        AND status IN ('active', 'attention')
        AND (plan_revision_id IS DISTINCT FROM ${request.plan_revision_id}::uuid
          OR ${request.status} IN ('cancelled', 'archived'))
    `);
    await connection.execute(sql`
      UPDATE progressive_work_attempts attempt SET outcome = 'cancelled',
        finished_at = clock_timestamp(), error = 'campaign stopped or plan superseded'
      FROM progressive_work work JOIN progressive_generations generation ON generation.id = work.generation_id
      WHERE attempt.work_id = work.id AND attempt.outcome = 'running'
        AND generation.campaign_id = ${request.campaign_id} AND generation.status = 'cancelled'
    `);
    await cancelObsoleteProgressiveCfdUnits(connection, request.campaign_id);
    await connection.execute(sql`
      UPDATE progressive_work work SET state = 'gap', lease_token = NULL, lease_owner = NULL,
        lease_until = NULL, completed_at = clock_timestamp(), error = 'campaign stopped or plan superseded'
      FROM progressive_generations generation
      WHERE work.generation_id = generation.id AND generation.campaign_id = ${request.campaign_id}
        AND generation.status = 'cancelled' AND work.state IN ('pending', 'leased')
    `);
    if (["cancelled", "archived"].includes(request.status)) {
      await connection.execute(sql`
        UPDATE progressive_scope_requests SET processed_version = ${request.requested_version}, processed_at = clock_timestamp(), error = NULL
        WHERE campaign_id = ${request.campaign_id}
      `);
      return {
        campaignId: request.campaign_id,
        generationId: null,
        profiles: 0,
        error: null,
      };
    }
    const profiles = (await connection.execute(sql`
      SELECT membership.airfoil_id FROM sim_campaign_airfoils membership
      JOIN airfoils airfoil ON airfoil.id = membership.airfoil_id
      JOIN sim_campaigns campaign ON campaign.id = membership.campaign_id
      WHERE membership.campaign_id = ${request.campaign_id}
        AND airfoil."deletedAt" IS NULL AND airfoil."archivedAt" IS NULL
        AND EXISTS (
          SELECT 1 FROM sim_campaign_conditions condition
          WHERE condition.campaign_id = campaign.id AND condition.generation = campaign.current_condition_generation
            AND condition.status IN ('active', 'kept')
            AND NOT EXISTS (
              SELECT 1 FROM progressive_generations generation
              JOIN progressive_generation_targets scope ON scope.generation_id = generation.id
              JOIN polar_analysis_targets target ON target.id = scope.target_id
              WHERE generation.campaign_id = campaign.id AND generation.epoch_id = ${epoch.id}
                AND generation.plan_revision_id = ${request.plan_revision_id} AND generation.status <> 'cancelled'
                AND target.airfoil_id = membership.airfoil_id AND scope.revision_id = condition.simulation_preset_revision_id
            )
        ) ORDER BY membership.airfoil_id
    `)) as unknown as Array<{ airfoil_id: string }>;
    let generationId: string | null = null;
    let error: string | null = null;
    try {
      const generation = await materializeProgressiveCampaignScope(
        connection,
        request.campaign_id,
        profiles.map((profile) => profile.airfoil_id),
        request.requested_version,
      );
      generationId = generation?.id ?? null;
    } catch (failure) {
      error = String(failure).slice(0, 2000);
    }
    await connection.execute(sql`
      UPDATE progressive_scope_requests SET processed_version = ${request.requested_version}, processed_at = clock_timestamp(),
        generation_id = ${generationId}, error = ${error} WHERE campaign_id = ${request.campaign_id}
    `);
    return {
      campaignId: request.campaign_id,
      generationId,
      profiles: profiles.length,
      error,
    };
  });
}
