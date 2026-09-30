import { and, eq, sql } from "drizzle-orm";
import { analysisContentHash, canonicalAnalysisJson } from "./analysis-target";
import {
  campaignEnrollmentScope,
  recomputeCampaignProgress,
  type CampaignPlan,
} from "./campaigns";
import { inheritLocalStepPolicy } from "./campaign-local-step-policy";
import type { DB } from "./client";
import { cancelObsoleteProgressiveCfdUnits } from "./progressive-cfd";
import { materializeProgressiveCampaignScope } from "./progressive-materialization";
import { reusePreviousBaselines } from "./progressive-recipe-adoption";
import {
  simulationPresets,
  simulationPresetRevisions,
  solverImplementations,
  solverProfiles,
} from "./schema";
import {
  METHOD_COMPATIBILITY_HASH_VERSION,
  OPENCFD_2606_NUMERICS2_SOLVER_IMPLEMENTATION_ID,
  OPENCFD_2606_NUMERICS2_EXECUTION_POOL_ID,
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
} from "./solver-implementations";
import {
  methodCompatibilityHashForSnapshot,
  physicsHashForSnapshot,
  simulationSetupSignature,
  type SimulationSetupSnapshot,
} from "./simulation-setup";

export const SOURCE_PRESERVING_NUMERICS_POLICY =
  "source-preserving-numerics-v2";

async function successorSolver(
  db: DB,
  source: SimulationSetupSnapshot["solver"],
) {
  const values = {
    solverImplementationId: OPENCFD_2606_NUMERICS2_SOLVER_IMPLEMENTATION_ID,
    turbulenceModel: source.turbulenceModel,
    nIterations: source.nIterations,
    convergenceTolerance: source.convergenceTolerance,
    momentumScheme: source.momentumScheme,
    transientCycles: source.transientCycles,
    transientDiscardFraction: source.transientDiscardFraction,
    transientMaxCourant: source.transientMaxCourant,
    uransPrecalcBudgetS: source.uransPrecalcBudgetS ?? null,
    uransInitializationIterations: source.uransInitializationIterations ?? null,
    localTimeStepSmoothing: source.localTimeStepSmoothing ?? null,
  };
  const slug = `numerics2-${analysisContentHash(values).slice(0, 32)}`;
  await db
    .insert(solverProfiles)
    .values({ ...values, slug, name: `${source.name} · numerics 2` })
    .onConflictDoNothing({ target: solverProfiles.slug });
  const [profile] = await db
    .select()
    .from(solverProfiles)
    .where(eq(solverProfiles.slug, slug));
  if (
    !profile ||
    Object.entries(values).some(
      ([key, value]) => profile[key as keyof typeof profile] !== value,
    )
  )
    throw new Error(
      "The corrected solver profile conflicts with its preserved numerical settings",
    );
  return profile;
}

async function successorRevision(
  db: DB,
  sourceId: string,
  implementation: typeof solverImplementations.$inferSelect,
) {
  const [source] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, sourceId));
  if (
    !source ||
    source.solverImplementationId !== OPENCFD_2606_SOLVER_IMPLEMENTATION_ID
  )
    throw new Error(
      "The source condition is not an exact OpenCFD 2606 numerical-revision-1 setup",
    );
  const snapshot = structuredClone(
    source.snapshot,
  ) as unknown as SimulationSetupSnapshot;
  if (
    snapshot.engine?.implementationId !== source.solverImplementationId ||
    snapshot.engine.numericsRevision !== "1" ||
    !snapshot.material
  )
    throw new Error(
      "The source setup has missing or inconsistent immutable engine/material identity",
    );
  const physicsHash = physicsHashForSnapshot(snapshot);
  const solver = await successorSolver(db, snapshot.solver);
  const slug = `numerics2-preset-${analysisContentHash({ sourceId, implementation: implementation.id }).slice(0, 32)}`;
  const values = {
    slug,
    name: `${snapshot.preset.name} · numerics 2`,
    flowConditionId: snapshot.flowState.id,
    referenceGeometryProfileId: snapshot.referenceGeometry.id,
    boundaryProfileId: snapshot.boundary.id,
    meshProfileId: snapshot.mesh.id,
    uransMeshProfileId: snapshot.uransMesh?.id ?? null,
    uransPrecalcMeshProfileId: snapshot.uransPrecalcMesh?.id ?? null,
    solverProfileId: solver.id,
    schedulingProfileId: snapshot.scheduling.id,
    outputProfileId: snapshot.output.id,
    sweepDefinitionId: snapshot.sweep.id,
    legacyBoundaryConditionId: null,
    enabled: false,
  };
  await db
    .insert(simulationPresets)
    .values(values)
    .onConflictDoNothing({ target: simulationPresets.slug });
  const [preset] = await db
    .select()
    .from(simulationPresets)
    .where(eq(simulationPresets.slug, slug));
  if (
    !preset ||
    Object.entries(values).some(
      ([key, value]) => preset[key as keyof typeof preset] !== value,
    )
  )
    throw new Error(
      "The corrected preset conflicts with its preserved source setup",
    );
  snapshot.preset = {
    id: preset.id,
    slug,
    name: preset.name,
    enabled: false,
    legacyBoundaryConditionId: null,
  };
  snapshot.solver = {
    ...snapshot.solver,
    id: solver.id,
    slug: solver.slug,
    name: solver.name,
  };
  snapshot.engine = {
    implementationId: implementation.id,
    key: implementation.key,
    family: implementation.family,
    distribution: implementation.distribution,
    releaseVersion: implementation.releaseVersion,
    methodFamily: implementation.methodFamily,
    adapterContractVersion: implementation.adapterContractVersion,
    numericsRevision: implementation.numericsRevision,
  };
  if (physicsHashForSnapshot(snapshot) !== physicsHash)
    throw new Error(
      "A numerical revision transition changed the physical target",
    );
  const signatureHash = simulationSetupSignature(snapshot);
  const [existing] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(
      and(
        eq(simulationPresetRevisions.presetId, preset.id),
        eq(simulationPresetRevisions.signatureHash, signatureHash),
      ),
    );
  if (existing) {
    if (
      canonicalAnalysisJson(existing.snapshot) !==
      canonicalAnalysisJson(snapshot)
    )
      throw new Error(
        "An existing successor revision conflicts with the exact source snapshot",
      );
    return existing;
  }
  const [revision] = await db
    .insert(simulationPresetRevisions)
    .values({
      presetId: preset.id,
      revisionNumber: 1,
      signatureHash,
      reynolds: source.reynolds,
      mach: source.mach,
      referenceLengthM: source.referenceLengthM,
      snapshot: snapshot as unknown as Record<string, unknown>,
      physicsHash,
      solverImplementationId: implementation.id,
      methodCompatibilityHashVersion: METHOD_COMPATIBILITY_HASH_VERSION,
      methodCompatibilityHash: methodCompatibilityHashForSnapshot(snapshot),
      isCanonicalPhysics: false,
      isCanonicalMethod: false,
    })
    .returning();
  return revision;
}

export async function adoptProgressiveNumerics2(
  db: DB,
  campaignId: string,
  expectedPlanRevisionId: string,
  options: { deferStoppedArchives?: boolean } = {},
) {
  const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  if (!uuid.test(campaignId) || !uuid.test(expectedPlanRevisionId))
    throw new Error("Exact campaign and source plan UUIDs are required");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${SOURCE_PRESERVING_NUMERICS_POLICY},0))`,
    );
    const [epoch] = await connection.execute(
      sql`SELECT id FROM calculation_epochs WHERE current FOR SHARE`,
    );
    const [admission] = await connection.execute(
      sql`SELECT enabled FROM sweeper_state WHERE id=1 FOR SHARE`,
    );
    if (options.deferStoppedArchives && admission?.enabled !== false)
      throw new Error(
        "Pause new solver admissions before handing off stopped archives",
      );
    const [campaign] = await connection.execute(
      sql`SELECT id,status,current_plan_revision_id,current_condition_generation FROM sim_campaigns WHERE id=${campaignId}::uuid FOR UPDATE`,
    );
    if (!campaign || !epoch)
      throw new Error("The campaign and current calculation epoch must exist");
    if (["cancelled", "archived"].includes(String(campaign.status)))
      return { kind: "not_required" as const, campaignId };
    const [plan] = await connection.execute(
      sql`SELECT id,plan,summary,revision_number FROM sim_campaign_plan_revisions WHERE id=${campaign.current_plan_revision_id}::uuid`,
    );
    if (!plan) throw new Error("The current campaign plan is missing");
    const summary = plan.summary as Record<string, unknown>;
    if (
      summary.numericalTransitionPolicy === SOURCE_PRESERVING_NUMERICS_POLICY &&
      summary.sourcePlanRevisionId === expectedPlanRevisionId
    )
      return {
        kind: "replayed" as const,
        campaignId,
        planRevisionId: String(plan.id),
        conditionGeneration: Number(campaign.current_condition_generation),
      };
    if (campaign.current_plan_revision_id !== expectedPlanRevisionId)
      throw new Error(
        "The campaign plan changed before the numerical transition",
      );
    if (admission?.enabled !== false) {
      const pools =
        await connection.execute(sql`SELECT id,enabled FROM solver_execution_pools
        WHERE id IN (${OPENCFD_2606_EXECUTION_POOL_ID}::uuid,${OPENCFD_2606_NUMERICS2_EXECUTION_POOL_ID}::uuid) ORDER BY id FOR SHARE`);
      if (
        pools.find((pool) => pool.id === OPENCFD_2606_EXECUTION_POOL_ID)
          ?.enabled !== false ||
        pools.find(
          (pool) => pool.id === OPENCFD_2606_NUMERICS2_EXECUTION_POOL_ID,
        )?.enabled !== true
      )
        throw new Error(
          "Pause new solver admissions before changing numerical revisions",
        );
    }
    const [implementation] = await connection
      .select()
      .from(solverImplementations)
      .where(
        eq(
          solverImplementations.id,
          OPENCFD_2606_NUMERICS2_SOLVER_IMPLEMENTATION_ID,
        ),
      );
    if (
      !implementation ||
      implementation.retiredAt ||
      implementation.numericsRevision !== "2"
    )
      throw new Error("The corrected numerical implementation is unavailable");
    const generations = await connection.execute(
      sql`SELECT id FROM progressive_generations WHERE campaign_id=${campaignId}::uuid AND epoch_id=${epoch.id}::uuid AND plan_revision_id=${plan.id}::uuid ORDER BY id FOR UPDATE`,
    );
    const [busy] = await connection.execute(sql`
      WITH stopped_archives AS MATERIALIZED (
        SELECT job.id FROM sim_jobs job
        JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id=job.id
        JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id
          AND stopped.engine_job_id=job.engine_job_id AND stopped.epoch_id=${epoch.id}::uuid
        WHERE ${options.deferStoppedArchives === true} AND job.campaign_id=${campaignId}::uuid
          AND job.solver_implementation_id=${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}::uuid
          AND job.status IN ('ingesting','cancelled') AND job.engine_state IN ('completed','failed','cancelled')
          AND coalesce(job.ingest_lease_expires_at<=clock_timestamp(),true)
          AND job.engine_job_id=job.id::text
          AND job.request_payload->'engineRequest'=dispatch.envelope->'request'
          AND job.request_payload->'progressive'=dispatch.envelope->'scope'
          AND stopped.proof->>'job_id'=job.engine_job_id
          AND stopped.proof->>'execution_stopped'='true' AND stopped.proof->>'producer_stopped'='true'
          AND stopped.proof->>'namespace_verified'='true' AND stopped.proof->'remaining'='[]'::jsonb
          AND stopped.proof->'error'='null'::jsonb
          AND EXISTS(SELECT 1 FROM progressive_remote_reports report WHERE report.sim_job_id=job.id
            AND report.report->'stopProof'=stopped.proof)
          AND NOT EXISTS(SELECT 1 FROM progressive_remote_reports report
            LEFT JOIN progressive_remote_progress_receipts receipt USING(sim_job_id,sequence)
            LEFT JOIN progressive_remote_report_inventories inventory USING(sim_job_id,sequence)
            WHERE report.sim_job_id=job.id AND (receipt.sequence IS NULL OR inventory.sequence IS NULL
              OR receipt.content_signature<>report.content_signature
              OR inventory.report_content_signature<>report.content_signature
              OR inventory.source_count<>(SELECT count(*) FROM progressive_remote_report_sources source
                WHERE source.sim_job_id=report.sim_job_id AND source.sequence=report.sequence)))
      )
      SELECT EXISTS(SELECT 1 FROM progressive_cfd_attempts attempt
        JOIN progressive_cfd_units unit ON unit.id=attempt.unit_id
        JOIN progressive_work work ON work.id=unit.work_id
        JOIN progressive_generations generation ON generation.id=work.generation_id
        JOIN sim_jobs job ON job.id=attempt.sim_job_id
        LEFT JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id=job.id
        WHERE generation.campaign_id=${campaignId}::uuid AND generation.epoch_id=${epoch.id}::uuid
          AND NOT EXISTS(SELECT 1 FROM stopped_archives deferred WHERE deferred.id=job.id)
          AND (attempt.outcome='running' OR job.status IN ('pending','submitted','running','ingesting')
            OR (job.engine_job_id IS NOT NULL AND (stopped.engine_job_id IS DISTINCT FROM job.engine_job_id OR stopped.epoch_id IS DISTINCT FROM ${epoch.id}::uuid))))
        OR EXISTS(SELECT 1 FROM sim_jobs job WHERE campaign_id=${campaignId}::uuid AND status IN ('pending','submitted','running','ingesting')
          AND NOT EXISTS(SELECT 1 FROM stopped_archives deferred WHERE deferred.id=job.id))
        OR EXISTS(SELECT 1 FROM progressive_work work JOIN progressive_generations generation ON generation.id=work.generation_id
          WHERE generation.campaign_id=${campaignId}::uuid AND generation.epoch_id=${epoch.id}::uuid AND work.state='leased') AS present,
        (SELECT count(*)::int FROM stopped_archives) AS deferred_archives
    `);
    if (busy?.present)
      throw new Error(
        "Old solver work must be physically stopped and settled before the numerical transition",
      );
    const conditions =
      await connection.execute(sql`SELECT id,ord,status,flow_condition_id,reference_geometry_profile_id,simulation_preset_revision_id,reynolds,mach
      FROM sim_campaign_conditions WHERE campaign_id=${campaignId}::uuid AND generation=${campaign.current_condition_generation}
        AND status IN ('active','kept') ORDER BY id FOR UPDATE`);
    if (!conditions.length || conditions.length > 2000)
      throw new Error("The campaign has no bounded active condition scope");
    const intent = await campaignEnrollmentScope(connection, campaignId);
    const newPlan = structuredClone(plan.plan) as CampaignPlan;
    const [currentSolver] = await connection
      .select()
      .from(solverProfiles)
      .where(eq(solverProfiles.id, newPlan.numerics.solverProfileId));
    if (
      !currentSolver ||
      ![OPENCFD_2606_SOLVER_IMPLEMENTATION_ID, implementation.id].includes(
        currentSolver.solverImplementationId,
      )
    )
      throw new Error(
        "The campaign solver profile is incompatible with this numerical transition",
      );
    newPlan.numerics.solverProfileId = (
      await successorSolver(connection, currentSolver)
    ).id;
    const number = Number(plan.revision_number) + 1;
    const generation = Number(campaign.current_condition_generation) + 1;
    const [successorPlan] =
      await connection.execute(sql`INSERT INTO sim_campaign_plan_revisions(campaign_id,revision_number,kind,plan,summary)
      VALUES(${campaignId}::uuid,${number},'engine_cutover',${canonicalAnalysisJson(newPlan)}::jsonb,
        ${canonicalAnalysisJson({
          numericalTransitionPolicy: SOURCE_PRESERVING_NUMERICS_POLICY,
          sourcePlanRevisionId: plan.id,
          fromNumerics: "1",
          toNumerics: "2",
          sourceConditionGeneration: campaign.current_condition_generation,
          priorStatus: campaign.status,
          stoppedArchiveHandoffJobs: Number(busy.deferred_archives),
        })}::jsonb) RETURNING id`);
    let points = 0;
    for (const condition of conditions) {
      const scope = intent.cellsByCondition.get(String(condition.id));
      if (!scope)
        throw new Error("The source condition lost its exact angle intent");
      const revision = await successorRevision(
        connection,
        String(condition.simulation_preset_revision_id),
        implementation,
      );
      const [successor] =
        await connection.execute(sql`INSERT INTO sim_campaign_conditions(campaign_id,ord,generation,flow_condition_id,reference_geometry_profile_id,preset_id,
        simulation_preset_revision_id,reynolds,mach,status,supersedes_condition_id,introduced_in_plan_revision_id)
        VALUES(${campaignId}::uuid,${condition.ord},${generation},${condition.flow_condition_id}::uuid,${condition.reference_geometry_profile_id}::uuid,
          ${revision.presetId}::uuid,${revision.id}::uuid,${condition.reynolds},${condition.mach},${condition.status},${condition.id}::uuid,${successorPlan.id}::uuid) RETURNING id`);
      await connection.execute(sql`INSERT INTO campaign_condition_scopes(condition_id,angles,source_plan_revision_id)
        VALUES(${successor.id}::uuid,ARRAY[${sql.join(
          scope.angles.map((angle) => sql`${angle}::float8`),
          sql`, `,
        )}]::float8[],${successorPlan.id}::uuid)`);
      const [inserted] = await connection.execute(sql`WITH inserted AS (
        INSERT INTO sim_campaign_points(campaign_id,condition_id,airfoil_id,aoa_deg,revision_id,plan_revision_number,state,result_id,result_attempt_id,derived_by_symmetry)
        SELECT campaign_id,${successor.id}::uuid,airfoil_id,aoa_deg,${revision.id}::uuid,${number},'requested',NULL,NULL,derived_by_symmetry
        FROM sim_campaign_points WHERE campaign_id=${campaignId}::uuid AND condition_id=${condition.id}::uuid AND state<>'released' RETURNING 1
      ) SELECT count(*)::int AS count FROM inserted`);
      points += Number(inserted.count);
      await connection.execute(sql`INSERT INTO sim_campaign_lanes(campaign_id,airfoil_id,condition_id,objective,state)
        SELECT campaign_id,airfoil_id,${successor.id}::uuid,objective,CASE WHEN state='symmetric_definition' THEN state ELSE 'awaiting_seed' END
        FROM sim_campaign_lanes WHERE campaign_id=${campaignId}::uuid AND condition_id=${condition.id}::uuid`);
    }
    await connection.execute(sql`UPDATE sim_campaign_conditions SET status='superseded',superseded_at=clock_timestamp(),status_changed_in_plan_revision_id=${successorPlan.id}::uuid
      WHERE campaign_id=${campaignId}::uuid AND generation=${campaign.current_condition_generation} AND status IN ('active','kept')`);
    await connection.execute(sql`UPDATE sim_campaign_points point SET state='released',"updatedAt"=clock_timestamp()
      FROM sim_campaign_conditions condition WHERE point.condition_id=condition.id AND point.campaign_id=${campaignId}::uuid
        AND condition.generation=${campaign.current_condition_generation} AND condition.status='superseded'`);
    await connection.execute(sql`UPDATE sim_campaigns SET current_condition_generation=${generation},current_plan_revision_id=${successorPlan.id}::uuid,
      status=CASE WHEN status='completed' THEN 'active' ELSE status END,"completedAt"=NULL,"updatedAt"=clock_timestamp() WHERE id=${campaignId}::uuid`);
    await inheritLocalStepPolicy(
      connection,
      campaignId,
      String(plan.id),
      String(successorPlan.id),
      true,
    );
    const previousIds = generations.map((row) => String(row.id));
    if (previousIds.length) {
      const ids = sql.join(
        previousIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      await connection.execute(
        sql`UPDATE progressive_generations SET status='cancelled' WHERE id IN (${ids})`,
      );
      await cancelObsoleteProgressiveCfdUnits(connection, campaignId);
      await connection.execute(sql`UPDATE progressive_work SET state='gap',completed_at=clock_timestamp(),error='superseded by numerical revision 2'
        WHERE generation_id IN (${ids}) AND state IN ('pending','leased')`);
    }
    const successor = await materializeProgressiveCampaignScope(
      connection,
      campaignId,
      undefined,
      SOURCE_PRESERVING_NUMERICS_POLICY,
    );
    if (!successor)
      throw new Error(
        "The numerical transition produced no eligible progressive scope",
      );
    if (previousIds.length) {
      await reusePreviousBaselines(
        connection,
        successor.id,
        previousIds,
        String(epoch.id),
      );
      await connection.execute(sql`INSERT INTO progressive_recipe_adoptions(epoch_id,campaign_id,plan_revision_id,policy,previous_generation_ids,generation_id)
        VALUES(${epoch.id}::uuid,${campaignId}::uuid,${successorPlan.id}::uuid,${SOURCE_PRESERVING_NUMERICS_POLICY},
          ARRAY[${sql.join(
            previousIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}],${successor.id}::uuid)`);
    }
    await recomputeCampaignProgress(transaction, campaignId);
    return {
      kind: "adopted" as const,
      campaignId,
      planRevisionId: String(successorPlan.id),
      conditionGeneration: generation,
      generationId: successor.id,
      conditions: conditions.length,
      points,
      stoppedArchiveHandoffJobs: Number(busy.deferred_archives),
    };
  });
}

export async function prepareSourcePreservingDefaults(db: DB) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [admission] = await connection.execute(
      sql`SELECT enabled FROM sweeper_state WHERE id=1 FOR SHARE`,
    );
    if (admission?.enabled !== false)
      throw new Error("Pause new solver admissions before updating defaults");
    const [target] = await connection.execute(
      sql`SELECT id FROM solver_implementations WHERE id=${OPENCFD_2606_NUMERICS2_SOLVER_IMPLEMENTATION_ID}::uuid AND retired_at IS NULL AND numerics_revision='2'`,
    );
    if (!target)
      throw new Error("The corrected numerical implementation is unavailable");
    const [pending] = await connection.execute(sql`SELECT
      EXISTS(SELECT 1 FROM sim_campaigns campaign JOIN sim_campaign_conditions condition
        ON condition.campaign_id=campaign.id AND condition.generation=campaign.current_condition_generation
        JOIN simulation_preset_revisions revision ON revision.id=condition.simulation_preset_revision_id
        WHERE campaign.status IN ('active','attention','paused','completed') AND condition.status IN ('active','kept')
          AND revision.solver_implementation_id=${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}::uuid) AS campaigns,
      EXISTS(SELECT 1 FROM sim_jobs WHERE solver_implementation_id=${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}::uuid
        AND status IN ('pending','submitted','running','ingesting')) AS jobs`);
    if (pending.campaigns || pending.jobs)
      throw new Error(
        "Transition existing campaigns and settle old jobs before updating defaults",
      );
    const profiles =
      await connection.execute(sql`UPDATE solver_profiles SET solver_implementation_id=${OPENCFD_2606_NUMERICS2_SOLVER_IMPLEMENTATION_ID}::uuid,"updatedAt"=clock_timestamp()
      WHERE solver_implementation_id=${OPENCFD_2606_SOLVER_IMPLEMENTATION_ID}::uuid RETURNING id`);
    return {
      profilesUpdated: profiles.length,
      solverImplementationId: OPENCFD_2606_NUMERICS2_SOLVER_IMPLEMENTATION_ID,
    };
  });
}
