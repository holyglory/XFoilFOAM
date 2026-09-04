import { createHash } from "node:crypto";

import { and, desc, eq, sql } from "drizzle-orm";

import {
  CampaignError,
  syncLegacyBoundaryConditionForPreset,
} from "./campaigns";
import type { DB } from "./client";
import { recomputeProgressForPointCorrections } from "./campaign-execution";
import {
  airfoils,
  meshProfiles,
  pointCorrectionRuns,
  resultAttempts,
  resultClassifications,
  results,
  simulationPresetAirfoilTargets,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  sweepDefinitions,
} from "./schema";
import {
  ensureSimulationPresetRevision,
  type SimulationSetupSnapshot,
} from "./simulation-setup";
import { createUransRequest } from "./urans-ladder";
import { precalcContinuationsForObligations } from "./precalc-obligations";

export interface PointCorrectionSettings {
  mesh: {
    mesher: string;
    farfieldRadiusChords: number;
    wakeLengthChords: number;
    nSurface: number;
    nRadial: number;
    nWake: number;
    targetYPlus: number;
    spanChords: number;
  };
  solver: {
    turbulenceModel: string;
    nIterations: number;
    convergenceTolerance: number;
    momentumScheme: string;
    transientCycles: number;
    transientDiscardFraction: number;
    transientMaxCourant: number;
  };
}

export interface PointCorrectionInput extends PointCorrectionSettings {
  resultId: string;
  resultAttemptId: string;
  fidelity: "precalc" | "full";
  /** Operator experiment only: replace the normal FAST wall budget for this
   * fresh-from-zero corrected run. Ordinary campaign/admin requests cannot
   * set this field, and the sweeper revalidates the immutable correction
   * owner before it forwards the override to the engine. */
  freshBudgetOverrideS?: number | null;
  requestedBy?: string | null;
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
    .join(",")}}`;
}

/**
 * Create (or replay) one point-scoped corrected setup. The source generation
 * is named exactly, every physical profile stays pinned to its immutable
 * revision, and only the requested mesh/solver blocks are replaced. The
 * generated preset is disabled so the normal background scheduler cannot
 * widen this exact-angle operator request into a new campaign.
 */
export async function createPointCorrection(
  db: DB,
  input: PointCorrectionInput,
) {
  if (
    input.freshBudgetOverrideS != null &&
    (!Number.isSafeInteger(input.freshBudgetOverrideS) ||
      input.freshBudgetOverrideS < 4 * 60 * 60 ||
      input.freshBudgetOverrideS > 24 * 60 * 60)
  ) {
    throw new CampaignError(
      "validation",
      "fresh FAST duration must be an integer from 14400 through 86400 seconds",
    );
  }
  if (input.fidelity !== "precalc" && input.freshBudgetOverrideS != null) {
    throw new CampaignError(
      "validation",
      "fresh duration override is valid only for a FAST URANS correction",
    );
  }
  const [source] = await db
    .select({
      resultId: results.id,
      currentResultAttemptId: results.currentResultAttemptId,
      status: results.status,
      classificationState: resultClassifications.state,
      sourceAttemptStatus: resultAttempts.status,
      sourceAttemptRejected: sql<boolean>`EXISTS (
        SELECT 1
        FROM result_classifications source_attempt_classification
        WHERE source_attempt_classification.result_attempt_id = ${resultAttempts.id}
          AND source_attempt_classification.state = 'rejected'
      )`,
      airfoilId: results.airfoilId,
      bcId: results.bcId,
      airfoilName: airfoils.name,
      aoaDeg: results.aoaDeg,
      revisionId: simulationPresetRevisions.id,
      snapshot: simulationPresetRevisions.snapshot,
    })
    .from(results)
    .innerJoin(airfoils, eq(airfoils.id, results.airfoilId))
    .innerJoin(
      resultAttempts,
      and(
        eq(resultAttempts.id, input.resultAttemptId),
        eq(resultAttempts.resultId, results.id),
        eq(resultAttempts.airfoilId, results.airfoilId),
        eq(resultAttempts.bcId, results.bcId),
        eq(
          resultAttempts.simulationPresetRevisionId,
          results.simulationPresetRevisionId,
        ),
        eq(resultAttempts.aoaDeg, results.aoaDeg),
      ),
    )
    .leftJoin(
      resultClassifications,
      eq(resultClassifications.resultId, results.id),
    )
    .innerJoin(
      simulationPresetRevisions,
      eq(simulationPresetRevisions.id, results.simulationPresetRevisionId),
    )
    .where(eq(results.id, input.resultId))
    .limit(1);
  if (!source)
    throw new CampaignError(
      "not_found",
      "exact point result generation was not found",
    );
  if (source.currentResultAttemptId !== input.resultAttemptId) {
    const [newestAttempt] = await db
      .select({ id: resultAttempts.id })
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.resultId, source.resultId),
          eq(resultAttempts.airfoilId, source.airfoilId),
          eq(resultAttempts.bcId, source.bcId),
          eq(resultAttempts.simulationPresetRevisionId, source.revisionId),
          eq(resultAttempts.aoaDeg, source.aoaDeg),
        ),
      )
      .orderBy(desc(resultAttempts.createdAt), desc(resultAttempts.id))
      .limit(1);
    if (newestAttempt?.id !== input.resultAttemptId) {
      throw new CampaignError(
        "conflict",
        "newer stored evidence exists for this point; refresh before creating a fresh recalculation",
      );
    }
  }
  const selectedGeneration =
    source.currentResultAttemptId === input.resultAttemptId;
  const exactAttemptIsRepairable =
    source.sourceAttemptStatus === "failed" || source.sourceAttemptRejected;
  const selectedResultIsRepairable =
    selectedGeneration &&
    (source.status === "failed" || source.classificationState === "rejected");
  if (!exactAttemptIsRepairable && !selectedResultIsRepairable) {
    throw new CampaignError(
      "validation",
      "a fresh recalculation can be created only for an unpublished failed or rejected point",
    );
  }

  const snapshot = source.snapshot as unknown as SimulationSetupSnapshot;
  const implementationId = snapshot.engine?.implementationId;
  if (!implementationId) {
    throw new CampaignError(
      "validation",
      "the source revision has no pinned solver implementation",
    );
  }
  const requiredIds = {
    flowConditionId: snapshot.flowState?.id,
    referenceGeometryProfileId: snapshot.referenceGeometry?.id,
    boundaryProfileId: snapshot.boundary?.id,
    schedulingProfileId: snapshot.scheduling?.id,
    outputProfileId: snapshot.output?.id,
  };
  if (Object.values(requiredIds).some((id) => !id)) {
    throw new CampaignError(
      "validation",
      "the source revision is incomplete and cannot be cloned safely",
    );
  }

  const signature = createHash("sha256")
    .update(
      stableStringify({
        sourceResultAttemptId: input.resultAttemptId,
        fidelity: input.fidelity,
        freshBudgetOverrideS: input.freshBudgetOverrideS ?? null,
        mesh: input.mesh,
        solver: input.solver,
      }),
    )
    .digest("hex");
  const suffix = `${input.resultAttemptId.slice(0, 8)}-${signature.slice(0, 12)}`;
  const displayAoa = Number(source.aoaDeg).toFixed(2).replace(/\.00$/, "");
  const nameBase = `${source.airfoilName} α ${displayAoa}° correction`;
  const slugs = {
    mesh: `point-correction-mesh-${suffix}`,
    solver: `point-correction-solver-${suffix}`,
    sweep: `point-correction-sweep-${suffix}`,
    preset: `point-correction-${suffix}`,
  };

  const created = await db.transaction(async (tx) => {
    await tx
      .insert(meshProfiles)
      .values({
        slug: slugs.mesh,
        name: `${nameBase} mesh`,
        ...input.mesh,
      })
      .onConflictDoNothing({ target: meshProfiles.slug });
    const [mesh] = await tx
      .select()
      .from(meshProfiles)
      .where(eq(meshProfiles.slug, slugs.mesh))
      .limit(1);
    if (!mesh)
      throw new CampaignError("conflict", "corrected mesh profile unavailable");

    await tx
      .insert(solverProfiles)
      .values({
        slug: slugs.solver,
        name: `${nameBase} solver`,
        solverImplementationId: implementationId,
        uransPrecalcBudgetS: input.freshBudgetOverrideS ?? null,
        ...input.solver,
      })
      .onConflictDoNothing({ target: solverProfiles.slug });
    const [solver] = await tx
      .select()
      .from(solverProfiles)
      .where(eq(solverProfiles.slug, slugs.solver))
      .limit(1);
    if (!solver)
      throw new CampaignError(
        "conflict",
        "corrected solver profile unavailable",
      );

    await tx
      .insert(sweepDefinitions)
      .values({
        slug: slugs.sweep,
        name: `${nameBase} single angle`,
        aoaStart: Number(source.aoaDeg),
        aoaStop: Number(source.aoaDeg),
        aoaStep: 1,
        aoaList: [Number(source.aoaDeg)],
      })
      .onConflictDoNothing({ target: sweepDefinitions.slug });
    const [sweep] = await tx
      .select()
      .from(sweepDefinitions)
      .where(eq(sweepDefinitions.slug, slugs.sweep))
      .limit(1);
    if (!sweep)
      throw new CampaignError(
        "conflict",
        "corrected sweep definition unavailable",
      );

    await tx
      .insert(simulationPresets)
      .values({
        slug: slugs.preset,
        name: nameBase,
        ...requiredIds,
        meshProfileId: mesh.id,
        // A point-scoped URANS correction must use the corrected mesh at both
        // ladder tiers; inheriting the source preset's separate URANS mesh
        // would make the visible mesh controls ineffective.
        uransMeshProfileId: mesh.id,
        uransPrecalcMeshProfileId: mesh.id,
        solverProfileId: solver.id,
        sweepDefinitionId: sweep.id,
        targetScope: "airfoils",
        origin: "library",
        enabled: false,
      })
      .onConflictDoNothing({ target: simulationPresets.slug });
    const [preset] = await tx
      .select()
      .from(simulationPresets)
      .where(eq(simulationPresets.slug, slugs.preset))
      .limit(1);
    if (!preset)
      throw new CampaignError(
        "conflict",
        "corrected simulation preset unavailable",
      );
    await tx
      .insert(simulationPresetAirfoilTargets)
      .values({ presetId: preset.id, airfoilId: source.airfoilId })
      .onConflictDoNothing();
    return { presetId: preset.id };
  });

  // The legacy boundary-condition row remains the ladder job's cell identity;
  // synchronize it from the newly composed domain profiles before freezing
  // the immutable revision.
  await syncLegacyBoundaryConditionForPreset(db, created.presetId);
  const resolved = await ensureSimulationPresetRevision(db, created.presetId);
  if (!resolved)
    throw new CampaignError(
      "conflict",
      "corrected simulation revision could not be created",
    );
  const outcome = await createUransRequest(db, {
    airfoilId: source.airfoilId,
    revisionId: resolved.revision.id,
    aoaDeg: Number(source.aoaDeg),
    fidelity: input.fidelity,
    requestedBy: input.requestedBy ?? null,
    budgetOverrideS: input.freshBudgetOverrideS ?? null,
  });
  await db
    .insert(pointCorrectionRuns)
    .values({
      sourceResultId: source.resultId,
      sourceResultAttemptId: input.resultAttemptId,
      correctedPresetId: created.presetId,
      correctedRevisionId: resolved.revision.id,
      uransRequestId: outcome.request.id,
      fidelity: input.fidelity,
      settingsSha256: signature,
      settings: {
        mesh: input.mesh,
        solver: input.solver,
        execution: {
          freshBudgetOverrideS: input.freshBudgetOverrideS ?? null,
        },
      },
      requestedBy: input.requestedBy ?? null,
    })
    .onConflictDoNothing({
      target: [
        pointCorrectionRuns.sourceResultAttemptId,
        pointCorrectionRuns.settingsSha256,
      ],
    });
  const [correction] = await db
    .select({ id: pointCorrectionRuns.id })
    .from(pointCorrectionRuns)
    .where(
      and(
        eq(pointCorrectionRuns.sourceResultAttemptId, input.resultAttemptId),
        eq(pointCorrectionRuns.settingsSha256, signature),
      ),
    )
    .limit(1);
  if (!correction)
    throw new CampaignError(
      "conflict",
      "fresh recalculation provenance could not be recorded",
    );
  await recomputeProgressForPointCorrections(
    db,
    source.airfoilId,
    resolved.revision.id,
  );
  return {
    correctionRunId: correction.id,
    presetId: created.presetId,
    revisionId: resolved.revision.id,
    resultAttemptId: input.resultAttemptId,
    request: outcome.request,
    created: outcome.created,
  };
}

export async function nextRunnablePointCorrectionRequestId(
  db: DB,
  options: { allowContinuations: boolean; requestIds?: string[] },
): Promise<string | null> {
  type Candidate = {
    id: string;
    created_at: Date | string;
    obligation_id: string | null;
    requires_continuation: boolean;
  };
  let cursor: Candidate | undefined;
  const requestScope =
    options.requestIds === undefined
      ? sql`true`
      : options.requestIds.length
        ? sql`request.id IN (${sql.join(
            options.requestIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`
        : sql`false`;
  for (;;) {
    const cursorScope = cursor
      ? sql`(request."createdAt", request.id) > (${new Date(cursor.created_at).toISOString()}::timestamptz, ${cursor.id}::uuid)`
      : sql`true`;
    const candidates = (await db.execute(sql`
      SELECT request.id, request."createdAt" AS created_at,
             obligation.id AS obligation_id,
             COALESCE(obligation.attempt_count >= obligation.max_attempts, false) AS requires_continuation
      FROM sim_urans_requests request
      JOIN point_correction_runs correction ON correction.urans_request_id = request.id
      LEFT JOIN sim_precalc_obligations obligation
        ON obligation.airfoil_id = request.airfoil_id
       AND obligation.revision_id = request.revision_id
       AND obligation.aoa_deg = request.aoa_deg
      WHERE request.state = 'pending' AND request.fidelity = 'precalc'
        AND request.sim_job_id IS NULL
        AND (${requestScope}) AND (${cursorScope})
        AND NOT EXISTS (
          SELECT 1 FROM sim_ladder_submit_retries retry
          WHERE retry.urans_request_id = request.id
            AND (retry.state = 'blocked' OR retry.next_attempt_at > now())
        )
        AND (request.background_owner OR EXISTS (
          SELECT 1 FROM sim_urans_request_campaigns ownership
          JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
          WHERE ownership.request_id = request.id AND ownership.state = 'active'
            AND campaign.status IN ('active', 'attention')
        ))
        AND (obligation.id IS NULL OR (
          obligation.state = 'pending'
          AND (obligation.next_submit_at IS NULL OR obligation.next_submit_at <= now())
          AND (obligation.attempt_count < obligation.max_attempts OR ${options.allowContinuations})
        ))
      ORDER BY request."createdAt", request.id
      LIMIT 64
    `)) as unknown as Candidate[];
    if (!candidates.length) return null;
    const continuationIds = candidates
      .filter((candidate) => candidate.requires_continuation)
      .map((candidate) => candidate.obligation_id!);
    const continuations = continuationIds.length
      ? await precalcContinuationsForObligations(db, continuationIds)
      : [];
    const allowed = new Set(
      continuations.map((continuation) => continuation.obligationId),
    );
    const ready = candidates.find(
      (candidate) =>
        !candidate.requires_continuation ||
        allowed.has(candidate.obligation_id!),
    );
    if (ready) return ready.id;
    if (candidates.length < 64) return null;
    cursor = candidates[candidates.length - 1];
  }
}
