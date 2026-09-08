import { and, eq, sql } from "drizzle-orm";
import {
  progressiveSolverIsTransient,
  type ProgressiveSolverFamily,
  type ProgressiveTimeCoordinate,
} from "@aerodb/core";
import {
  analysisContentHash,
  canonicalAnalysisJson,
  createAnalysisTarget,
} from "./analysis-target";
import { legacyBoundaryValuesFromSnapshot } from "./campaigns";
import type { DB } from "./client";
import type { ProgressiveCfdLease } from "./progressive-cfd";
import {
  boundaryConditions,
  meshProfiles,
  progressiveCfdAttempts,
  progressiveCfdExecutionRecipes,
  simulationPresets,
  simulationPresetRevisions,
  solverProfiles,
} from "./schema";
import { METHOD_COMPATIBILITY_HASH_VERSION } from "./solver-implementations";
import {
  methodCompatibilityHashForSnapshot,
  physicsHashForSnapshot,
  simulationSetupSignature,
  type SimulationSetupSnapshot,
} from "./simulation-setup";

function numericalValues<T extends Record<string, unknown>>(profile: T) {
  const {
    id: _id,
    slug: _slug,
    name: _name,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    isSeeded: _isSeeded,
    solverImplementationId: _implementation,
    ...values
  } = profile;
  return values;
}

export async function lockProgressiveCfdExecution(
  db: DB,
  lease: ProgressiveCfdLease,
) {
  const [epoch] = await db.execute(
    sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
  );
  if (epoch?.id !== lease.epochId)
    throw new Error("Obsolete CFD calculation epoch");
  const [campaign] = await db.execute(
    sql`SELECT status, current_plan_revision_id FROM sim_campaigns WHERE id = ${lease.campaignId} FOR UPDATE`,
  );
  if (!campaign || !["active", "attention"].includes(String(campaign.status)))
    throw new Error("Campaign does not admit new CFD execution");
  const [unit] = await db.execute(sql`
    SELECT coalesce(recovery.recipe, unit.recipe) AS recipe, recovery.id AS recovery_plan_id,
      recovery.parent_job_id AS recovery_parent_job_id, target.physical, scope.revision_id, attempt.sim_job_id, attempt.execution_recipe_id,
      unit.active_budget_seconds - unit.active_seconds AS remaining_active_seconds
    FROM progressive_cfd_units unit JOIN progressive_work work ON work.id = unit.work_id
    JOIN progressive_generations generation ON generation.id = work.generation_id
    JOIN progressive_generation_targets scope ON scope.generation_id = generation.id AND scope.target_id = work.target_id
    JOIN polar_analysis_targets target ON target.id = work.target_id
    JOIN progressive_cfd_attempts attempt ON attempt.token = unit.lease_token AND attempt.unit_id = unit.id
    LEFT JOIN progressive_cfd_recovery_claims recovery_claim ON recovery_claim.attempt_token = attempt.token
    LEFT JOIN progressive_cfd_recovery_plans recovery ON recovery.id = recovery_claim.recovery_plan_id AND recovery.unit_id = unit.id
    WHERE unit.id = ${lease.id} AND unit.work_id = ${lease.workId} AND unit.aoa_deg = ${lease.alpha}
      AND unit.state = 'leased' AND unit.lease_token = ${lease.token} AND unit.lease_owner = ${lease.owner}
      AND unit.lease_until > clock_timestamp() AND attempt.outcome = 'running'
      AND generation.id = ${lease.generationId} AND generation.epoch_id = ${lease.epochId}
      AND generation.campaign_id = ${lease.campaignId} AND generation.plan_revision_id = ${campaign.current_plan_revision_id}
      AND generation.status = 'active' AND generation.stage = work.stage AND work.stage = ${lease.stage}
      AND work.state = 'pending' AND work.target_id = ${lease.targetId} AND scope.revision_id = ${lease.revisionId}
    FOR UPDATE OF generation, work, unit, attempt
  `);
  if (!unit) throw new Error("Obsolete or expired CFD execution lease");
  if (
    !unit.sim_job_id &&
    unit.remaining_active_seconds !== lease.remainingActiveSeconds
  )
    throw new Error("CFD lease budget differs from its remaining allocation");
  if (
    (unit.recovery_plan_id ?? null) !== (lease.recoveryPlanId ?? null) ||
    (unit.recovery_parent_job_id ?? null) !==
      (lease.recoveryParentJobId ?? null) ||
    canonicalAnalysisJson(unit.recipe) !==
      canonicalAnalysisJson(lease.recipe) ||
    canonicalAnalysisJson(unit.physical) !==
      canonicalAnalysisJson(lease.physical)
  )
    throw new Error("CFD lease payload differs from its sealed scope");
  return unit;
}

export async function materializeProgressiveCfdExecution(
  db: DB,
  lease: ProgressiveCfdLease,
) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await lockProgressiveCfdExecution(connection, lease);
    const identity = analysisContentHash({
      sourceRevisionId: lease.revisionId,
      recipe: lease.recipe,
    });
    await connection.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))`,
    );
    const existing = await connection
      .select({
        id: progressiveCfdExecutionRecipes.id,
        revision: simulationPresetRevisions,
      })
      .from(progressiveCfdExecutionRecipes)
      .innerJoin(
        simulationPresetRevisions,
        eq(
          simulationPresetRevisions.id,
          progressiveCfdExecutionRecipes.executionRevisionId,
        ),
      )
      .where(eq(progressiveCfdExecutionRecipes.id, identity))
      .limit(1);
    if (existing[0]) {
      await connection
        .update(progressiveCfdAttempts)
        .set({ executionRecipeId: identity })
        .where(eq(progressiveCfdAttempts.token, lease.token));
      return {
        recipeId: identity,
        revision: existing[0].revision,
        snapshot: existing[0].revision
          .snapshot as unknown as SimulationSetupSnapshot,
      };
    }
    const [source] = await connection
      .select()
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, lease.revisionId))
      .limit(1);
    if (!source) throw new Error("CFD source revision is missing");
    const frozen = source.snapshot as unknown as SimulationSetupSnapshot;
    if (!frozen.material || !frozen.engine)
      throw new Error(
        "CFD source has no immutable material or engine identity",
      );
    const physical = createAnalysisTarget({
      airfoilId: lease.physical.airfoilId,
      points: lease.physical.geometry.map(([x, y]) => ({ x, y })),
      snapshot: frozen,
      material: {
        ...frozen.material,
        speedOfSound: frozen.material.speedOfSound ?? null,
      },
      transition: lease.physical.transition,
      branch: lease.physical.branch,
    });
    if (physical.signature !== lease.targetId)
      throw new Error("CFD source revision does not match the physical target");
    const mesh = lease.recipe.mesh as
      | Omit<SimulationSetupSnapshot["mesh"], "id" | "slug" | "name">
      | undefined;
    const solver = lease.recipe.solver as
      | Omit<SimulationSetupSnapshot["solver"], "id" | "slug" | "name">
      | undefined;
    const selection = lease.recipe.selection as
      | { solver?: ProgressiveSolverFamily; pressureKind?: string }
      | undefined;
    const family = selection?.solver;
    const timeCoordinate = lease.recipe.timeCoordinate as
      | ProgressiveTimeCoordinate
      | undefined;
    const turbulentPrandtl = lease.recipe.turbulentPrandtl;
    if (
      !mesh ||
      !solver ||
      !family ||
      ![
        "simpleFoam",
        "pimpleFoam",
        "rhoSimpleFoam",
        "rhoPimpleFoam",
        "rhoCentralFoam",
      ].includes(family)
    )
      throw new Error("CFD numerical recipe is incomplete");
    progressiveSolverIsTransient(family, timeCoordinate);
    if (
      selection?.pressureKind !==
      (family.startsWith("rho") ? "absolute" : "kinematic")
    )
      throw new Error("CFD pressure convention does not match its solver");
    if (
      family.startsWith("rho") &&
      (typeof turbulentPrandtl !== "number" ||
        !Number.isFinite(turbulentPrandtl) ||
        turbulentPrandtl <= 0)
    )
      throw new Error(
        "Compressible CFD requires a pinned turbulent Prandtl number",
      );
    for (const [values, template] of [
      [mesh, numericalValues(frozen.mesh)],
      [solver, numericalValues(frozen.solver)],
    ] as const) {
      if (
        Object.keys(values).some((key) => !(key in template)) ||
        Object.keys(template).some((key) => !(key in values))
      )
        throw new Error("CFD numerical recipe has unknown or missing settings");
    }
    const meshSlug = `progressive-mesh-${analysisContentHash(mesh).slice(0, 24)}`;
    const solverSlug = `progressive-solver-${analysisContentHash({ solver, family, implementation: frozen.engine.implementationId }).slice(0, 24)}`;
    await connection
      .insert(meshProfiles)
      .values({
        ...mesh,
        slug: meshSlug,
        name: `${lease.stage === 2 ? "Fast" : "Precise"} CFD mesh`,
      })
      .onConflictDoNothing({ target: meshProfiles.slug });
    await connection
      .insert(solverProfiles)
      .values({
        ...solver,
        slug: solverSlug,
        name: `${family} ${lease.stage === 2 ? "fast" : "precise"}`,
        solverImplementationId: frozen.engine.implementationId,
      })
      .onConflictDoNothing({ target: solverProfiles.slug });
    const [meshRow] = await connection
      .select()
      .from(meshProfiles)
      .where(eq(meshProfiles.slug, meshSlug));
    const [solverRow] = await connection
      .select()
      .from(solverProfiles)
      .where(eq(solverProfiles.slug, solverSlug));
    if (
      !meshRow ||
      !solverRow ||
      canonicalAnalysisJson(numericalValues(meshRow)) !==
        canonicalAnalysisJson(mesh) ||
      canonicalAnalysisJson(numericalValues(solverRow)) !==
        canonicalAnalysisJson({
          ...solver,
          uransInitializationIterations:
            solver.uransInitializationIterations ?? null,
        })
    )
      throw new Error(
        "A content-addressed CFD profile was changed; refusing to overwrite it",
      );
    const slug = `${frozen.preset.slug}-progressive-${identity.slice(0, 16)}`;
    const [preset] = await connection
      .insert(simulationPresets)
      .values({
        slug,
        name: `${frozen.preset.name} — ${lease.stage === 2 ? "fast" : "precise"} ${family}`,
        enabled: false,
        flowConditionId: frozen.flowState.id,
        referenceGeometryProfileId: frozen.referenceGeometry.id,
        boundaryProfileId: frozen.boundary.id,
        meshProfileId: meshRow.id,
        solverProfileId: solverRow.id,
        uransMeshProfileId: meshRow.id,
        uransPrecalcMeshProfileId: meshRow.id,
        schedulingProfileId: frozen.scheduling.id,
        outputProfileId: frozen.output.id,
        sweepDefinitionId: frozen.sweep.id,
        targetScope: "airfoils",
        origin: "library",
      })
      .returning();
    const snapshot: SimulationSetupSnapshot = {
      ...structuredClone(frozen),
      preset: {
        id: preset.id,
        slug: preset.slug,
        name: preset.name,
        enabled: false,
        legacyBoundaryConditionId: null,
      },
      mesh: { ...mesh, id: meshRow.id, slug: meshRow.slug, name: meshRow.name },
      solver: {
        ...solver,
        id: solverRow.id,
        slug: solverRow.slug,
        name: solverRow.name,
        flowSolverFamily: family,
        ...(timeCoordinate ? { timeCoordinate } : {}),
        ...(family.startsWith("rho")
          ? { turbulentPrandtl: turbulentPrandtl as number }
          : {}),
      },
    };
    snapshot.uransMesh = snapshot.mesh;
    snapshot.uransPrecalcMesh = snapshot.mesh;
    const [boundary] = await connection
      .insert(boundaryConditions)
      .values({ ...legacyBoundaryValuesFromSnapshot(snapshot), slug })
      .returning();
    snapshot.preset.legacyBoundaryConditionId = boundary.id;
    await connection
      .update(simulationPresets)
      .set({ legacyBoundaryConditionId: boundary.id })
      .where(eq(simulationPresets.id, preset.id));
    const [revision] = await connection
      .insert(simulationPresetRevisions)
      .values({
        presetId: preset.id,
        revisionNumber: 1,
        signatureHash: simulationSetupSignature(snapshot),
        reynolds: snapshot.derived.reynolds,
        mach: snapshot.derived.mach,
        referenceLengthM: snapshot.referenceGeometry.referenceLengthM,
        snapshot: snapshot as unknown as Record<string, unknown>,
        solverImplementationId: frozen.engine.implementationId,
        physicsHash: physicsHashForSnapshot(snapshot),
        methodCompatibilityHashVersion: METHOD_COMPATIBILITY_HASH_VERSION,
        methodCompatibilityHash: methodCompatibilityHashForSnapshot(snapshot),
      })
      .returning();
    await connection.insert(progressiveCfdExecutionRecipes).values({
      id: identity,
      sourceRevisionId: source.id,
      recipe: lease.recipe,
      executionRevisionId: revision.id,
    });
    await connection
      .update(progressiveCfdAttempts)
      .set({ executionRecipeId: identity })
      .where(
        and(
          eq(progressiveCfdAttempts.token, lease.token),
          eq(progressiveCfdAttempts.outcome, "running"),
        ),
      );
    return { recipeId: identity, revision, snapshot };
  });
}
