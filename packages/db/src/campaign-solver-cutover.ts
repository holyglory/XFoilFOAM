import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import {
  CAMPAIGN_OBJECTIVES,
  CampaignError,
  normalizeCampaignPlan,
  recomputeCampaignProgress,
  type CampaignPlan,
  type CampaignPlanInput,
  type CampaignTx,
} from "./campaigns";
import type { DB } from "./client";
import { claimSimJobCancellation } from "./job-lifecycle";
import {
  ensureOpenCfd2606ContinuationCheck,
  getOpenCfd2606CanaryAttestation,
} from "./solver-cutover-attestation";
import {
  airfoils,
  simCampaignConditions,
  simCampaignLifecycleEvents,
  simCampaignPlanRevisions,
  simCampaignPoints,
  simCampaignSolverCutovers,
  simCampaigns,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
  solverExecutionPools,
  solverImplementations,
  solverProfiles,
} from "./schema";
import {
  methodCompatibilityHashForSnapshot,
  physicsHashForSnapshot,
  simulationSetupSignature,
  type SimulationSetupSnapshot,
} from "./simulation-setup";
import {
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
  METHOD_COMPATIBILITY_HASH_VERSION,
  OPENCFD_2406_EXECUTION_POOL_ID,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  OPENCFD_2606_EXECUTION_POOL_ID,
  OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
} from "./solver-implementations";

type DbTx = DB | CampaignTx;
const asDb = (db: DbTx): DB => db as DB;

const CUTOVER_LOCK_KEY = "openfoam-opencfd-2406-to-2606-cutover";
const CUTOVER_REASON =
  "OpenCFD 2406 worker retirement and fresh OpenCFD 2606 campaign generation";
const OLD_REVISION_IMPLEMENTATION_IDS = [
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  // Campaign revisions created before exact engine identity remain truthfully
  // unknown. Operationally they were submitted to the one pre-cutover 2406
  // route, so unfinished obligations must be moved without relabelling their
  // historical evidence.
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
] as const;

export interface OpenCfd2606CutoverInput {
  /** Omit for every affected campaign. Global engine admission/drain checks
   * always remain global because the 2406 container is being removed. */
  campaignIds?: string[];
  actor?: string | null;
  reason?: string | null;
  /** Required by finalization. It must name an immutable canary receipt for
   * the exact OpenCFD 2606 runtime and execution pool. */
  canaryAttestationId?: string;
}

export interface OpenCfd2606CutoverBlocker {
  kind:
    | "source_pool_enabled"
    | "source_implementation_active"
    | "source_solver_profiles"
    | "source_job_pending"
    | "source_job_submitted"
    | "source_job_running"
    | "source_job_ingesting"
    | "source_ladder_running"
    | "unselected_source_campaign"
    | "campaign_not_paused"
    | "target_implementation_missing"
    | "target_implementation_retired";
  count: number;
  ids: string[];
  message: string;
}

export interface OpenCfd2606CutoverReadiness {
  status: "ready" | "blocked";
  ready: boolean;
  blockers: OpenCfd2606CutoverBlocker[];
  sourcePoolEnabled: boolean;
  targetPoolEnabled: boolean;
  checkedAt: string;
}

export interface OpenCfd2606CutoverPreparation {
  status: "prepared";
  cutoverIds: string[];
  campaignsPrepared: number;
  campaignsAlreadyPrepared: number;
  campaignsPaused: number;
  solverProfilesMigrated: number;
  pendingJobsCancelled: number;
  pendingLadderItemsCancelled: number;
  sourcePoolDisabled: boolean;
  sourceImplementationRetired: boolean;
}

export interface OpenCfd2606CutoverFinalization {
  status: "finalized";
  cutoverIds: string[];
  campaignsFinalized: number;
  campaignsAlreadyFinalized: number;
  sourceConditionsSuperseded: number;
  targetConditionsCreated: number;
  targetPointsCreated: number;
  latePendingLadderItemsCancelled: number;
  canaryAttestationId: string;
}

export interface OpenCfd2606CutoverCompletion {
  status: "completed";
  cutoverIds: string[];
  campaignsCompleted: number;
  campaignsAlreadyCompleted: number;
  campaignsResumed: number;
  campaignsLeftPaused: number;
  sourcePoolDisabled: boolean;
  sourceImplementationRetired: boolean;
}

function normalizedIds(ids: string[] | undefined): string[] | undefined {
  if (ids === undefined) return undefined;
  return [...new Set(ids)];
}

function normalizedText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredCanaryAttestationId(value: string | undefined): string {
  const normalized = normalizedText(value);
  if (!normalized || !UUID.test(normalized)) {
    throw new CampaignError(
      "validation",
      "a valid successful OpenCFD 2606 canary attestation id is required",
    );
  }
  return normalized;
}

async function openCutoverCampaignIds(db: DbTx): Promise<string[]> {
  const rows = await asDb(db)
    .select({ campaignId: simCampaignSolverCutovers.campaignId })
    .from(simCampaignSolverCutovers)
    .where(
      and(
        inArray(simCampaignSolverCutovers.status, ["prepared", "finalized"]),
        eq(
          simCampaignSolverCutovers.toSolverImplementationId,
          OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        ),
      ),
    );
  return [...new Set(rows.map((row) => row.campaignId))];
}

function missingCampaignScope(
  requested: string[] | undefined,
  required: string[],
): string[] {
  if (requested === undefined) return [];
  const selected = new Set(requested);
  return required.filter((id) => !selected.has(id));
}

function sourceJobWhere() {
  return or(
    eq(simJobs.solverImplementationId, OPENCFD_2406_SOLVER_IMPLEMENTATION_ID),
    and(
      isNull(simJobs.solverImplementationId),
      or(
        isNull(simJobs.solverExecutionPoolId),
        eq(simJobs.solverExecutionPoolId, OPENCFD_2406_EXECUTION_POOL_ID),
      ),
    ),
  )!;
}

async function lockCutover(tx: DbTx): Promise<void> {
  await asDb(tx).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${CUTOVER_LOCK_KEY}, 0))`,
  );
}

async function cancelPendingOldLadderItems(tx: DbTx): Promise<number> {
  const requests = await asDb(tx).execute(sql`
      UPDATE sim_urans_requests request
      SET state = 'cancelled', "updatedAt" = now()
      FROM simulation_preset_revisions revision
      WHERE request.revision_id = revision.id
        AND revision.solver_implementation_id = ANY(
          ARRAY[${sql.join(
            OLD_REVISION_IMPLEMENTATION_IDS.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]::uuid[]
        )
        AND request.state = 'pending'
      RETURNING request.id
    `);
  const verify = await asDb(tx).execute(sql`
      UPDATE sim_urans_verify_queue item
      SET state = 'cancelled', "updatedAt" = now()
      FROM simulation_preset_revisions revision
      WHERE item.revision_id = revision.id
        AND revision.solver_implementation_id = ANY(
          ARRAY[${sql.join(
            OLD_REVISION_IMPLEMENTATION_IDS.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]::uuid[]
        )
        AND item.state = 'pending'
      RETURNING item.id
    `);
  const precalc = await asDb(tx).execute(sql`
      UPDATE sim_precalc_obligations obligation
      SET state = 'cancelled', completed_at = now(),
          last_error = ${CUTOVER_REASON}, "updatedAt" = now()
      FROM simulation_preset_revisions revision
      WHERE obligation.revision_id = revision.id
        AND revision.solver_implementation_id = ANY(
          ARRAY[${sql.join(
            OLD_REVISION_IMPLEMENTATION_IDS.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]::uuid[]
        )
        AND obligation.state = 'pending'
      RETURNING obligation.id
    `);
  await asDb(tx).execute(sql`
    DELETE FROM sim_ladder_submit_retries retry
    WHERE (retry.urans_request_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM sim_urans_requests request
      WHERE request.id = retry.urans_request_id AND request.state = 'cancelled'
    )) OR (retry.verify_queue_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM sim_urans_verify_queue item
      WHERE item.id = retry.verify_queue_id AND item.state = 'cancelled'
    ))
  `);
  return requests.length + verify.length + precalc.length;
}

/** Stage 1: close the old route, move every mutable solver-profile default to
 * 2606, pause affected campaigns, and record their prior lifecycle state.
 * Exact 2406 revisions/jobs/evidence remain unchanged. */
export async function prepareOpenCfd2606Cutover(
  db: DB,
  input: OpenCfd2606CutoverInput = {},
): Promise<OpenCfd2606CutoverPreparation> {
  const campaignIds = normalizedIds(input.campaignIds);
  const actor = normalizedText(input.actor);
  const reason = normalizedText(input.reason) ?? CUTOVER_REASON;

  const prepared = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as CampaignTx;
    await lockCutover(tx);

    const [targetImplementation] = await asDb(tx)
      .select()
      .from(solverImplementations)
      .where(
        eq(solverImplementations.id, OPENCFD_2606_SOLVER_IMPLEMENTATION_ID),
      )
      .limit(1);
    if (!targetImplementation || targetImplementation.retiredAt) {
      throw new CampaignError(
        "invalid_state",
        "OpenCFD 2606 implementation is missing or retired",
      );
    }

    await asDb(tx)
      .update(solverExecutionPools)
      .set({ enabled: false })
      .where(eq(solverExecutionPools.id, OPENCFD_2406_EXECUTION_POOL_ID));
    // Preparation is replayable. Re-close the target admission fence in the
    // same transaction as campaign pausing so an interrupted prior activation
    // cannot remain enabled while the operator drains or rebuilds services.
    await asDb(tx)
      .update(solverExecutionPools)
      .set({ enabled: false })
      .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID));
    const migratedProfiles = await asDb(tx)
      .update(solverProfiles)
      .set({
        solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      })
      .where(
        eq(
          solverProfiles.solverImplementationId,
          OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
        ),
      )
      .returning({ id: solverProfiles.id });

    const candidateFilters = [
      inArray(simCampaigns.status, ["active", "paused", "attention"]),
      sql`EXISTS (
        SELECT 1
        FROM sim_campaign_conditions condition
        JOIN simulation_preset_revisions revision
          ON revision.id = condition.simulation_preset_revision_id
        WHERE condition.campaign_id = ${simCampaigns.id}
          AND condition.generation = ${simCampaigns.currentConditionGeneration}
          AND condition.status IN ('active', 'kept')
          AND revision.solver_implementation_id = ANY(
            ARRAY[${sql.join(
              OLD_REVISION_IMPLEMENTATION_IDS.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]::uuid[]
          )
          AND EXISTS (
            SELECT 1 FROM sim_campaign_points point
            WHERE point.campaign_id = condition.campaign_id
              AND point.condition_id = condition.id
              AND point.state <> 'released'
          )
      )`,
    ];
    const candidates = await asDb(tx)
      .select()
      .from(simCampaigns)
      .where(and(...candidateFilters))
      .orderBy(asc(simCampaigns.createdAt), asc(simCampaigns.id))
      .for("update");

    const requiredCampaignIds = [
      ...new Set([
        ...candidates.map((campaign) => campaign.id),
        ...(await openCutoverCampaignIds(tx)),
      ]),
    ];
    const unselectedCampaignIds = missingCampaignScope(
      campaignIds,
      requiredCampaignIds,
    );
    if (unselectedCampaignIds.length > 0) {
      throw new CampaignError(
        "validation",
        "OpenCFD 2406 container retirement is global; campaignIds omitted one or more runnable/prepared campaigns",
        { campaignIds: unselectedCampaignIds },
      );
    }

    // Finalization runs only after the old container has been replaced. Prove
    // now—inside the same transaction as the admission fence—that every
    // current source revision and stored plan can be cloned. Any malformed or
    // mixed-engine campaign therefore aborts preparation without retiring the
    // last executable 2406 worker.
    for (const campaign of candidates) {
      await preflightCampaignCutover(tx, campaign, targetImplementation);
    }

    const candidateIdList = candidates.map((campaign) => campaign.id);
    const existing = candidateIdList.length
      ? await asDb(tx)
          .select()
          .from(simCampaignSolverCutovers)
          .where(
            and(
              inArray(simCampaignSolverCutovers.campaignId, candidateIdList),
              eq(
                simCampaignSolverCutovers.toSolverImplementationId,
                OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
              ),
            ),
          )
      : [];
    const existingByCampaign = new Map(
      existing.map((cutover) => [cutover.campaignId, cutover]),
    );
    const cutoverIds: string[] = existing.map((cutover) => cutover.id);
    let campaignsPrepared = 0;
    let campaignsPaused = 0;

    for (const campaign of candidates) {
      if (existingByCampaign.has(campaign.id)) continue;
      if (!campaign.currentPlanRevisionId) {
        throw new CampaignError(
          "invalid_state",
          `campaign ${campaign.id} has no current plan revision`,
        );
      }
      const [sourceCount] = (await asDb(tx).execute(sql`
        SELECT count(*)::int AS n
        FROM sim_campaign_conditions condition
        WHERE condition.campaign_id = ${campaign.id}
          AND condition.generation = ${campaign.currentConditionGeneration}
          AND condition.status IN ('active', 'kept')
      `)) as unknown as Array<{ n: number }>;
      const [cutover] = await asDb(tx)
        .insert(simCampaignSolverCutovers)
        .values({
          campaignId: campaign.id,
          fromSolverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
          toSolverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          sourcePlanRevisionId: campaign.currentPlanRevisionId,
          sourceGeneration: campaign.currentConditionGeneration,
          targetGeneration: campaign.currentConditionGeneration + 1,
          priorCampaignStatus: campaign.status,
          reason,
          preparedBy: actor,
          sourceConditionCount: Number(sourceCount?.n ?? 0),
        })
        .returning();
      cutoverIds.push(cutover.id);
      campaignsPrepared += 1;

      if (campaign.status !== "paused") {
        await asDb(tx)
          .update(simCampaigns)
          .set({ status: "paused", completedAt: null })
          .where(eq(simCampaigns.id, campaign.id));
        await asDb(tx)
          .insert(simCampaignLifecycleEvents)
          .values({
            campaignId: campaign.id,
            action: "pause",
            fromStatus: campaign.status,
            toStatus: "paused",
            actor,
            reason,
            metadata: {
              cutoverId: cutover.id,
              fromSolverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
              toSolverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
            },
          });
        campaignsPaused += 1;
      }
    }

    const pendingLadderItemsCancelled = await cancelPendingOldLadderItems(tx);
    // Retiring the immutable implementation is the durable admission fence:
    // an admin cannot re-enable its pool while accepted jobs continue to
    // drain. Historical revisions/jobs/evidence retain this FK unchanged.
    await asDb(tx)
      .update(solverImplementations)
      .set({
        retiredAt: sql`COALESCE(${solverImplementations.retiredAt}, now())`,
      })
      .where(
        eq(solverImplementations.id, OPENCFD_2406_SOLVER_IMPLEMENTATION_ID),
      );
    const pendingJobs = await asDb(tx)
      .select({ id: simJobs.id })
      .from(simJobs)
      .where(and(eq(simJobs.status, "pending"), sourceJobWhere()));

    return {
      cutoverIds,
      campaignsPrepared,
      campaignsAlreadyPrepared: existing.length,
      campaignsPaused,
      solverProfilesMigrated: migratedProfiles.length,
      pendingLadderItemsCancelled,
      pendingJobIds: pendingJobs.map((job) => job.id),
    };
  });

  // Pool admission is already closed. These per-job CAS transitions safely
  // race a submitter which loaded the old pool immediately before prepare:
  // cancellation wins while pending, otherwise readiness observes the live
  // submitted job and waits for its real terminal/ingest settlement.
  let pendingJobsCancelled = 0;
  for (const jobId of prepared.pendingJobIds) {
    const outcome = await claimSimJobCancellation(db, jobId, CUTOVER_REASON);
    if (outcome.kind === "cancelled") pendingJobsCancelled += 1;
  }

  return {
    status: "prepared",
    cutoverIds: prepared.cutoverIds,
    campaignsPrepared: prepared.campaignsPrepared,
    campaignsAlreadyPrepared: prepared.campaignsAlreadyPrepared,
    campaignsPaused: prepared.campaignsPaused,
    solverProfilesMigrated: prepared.solverProfilesMigrated,
    pendingJobsCancelled,
    pendingLadderItemsCancelled: prepared.pendingLadderItemsCancelled,
    sourcePoolDisabled: true,
    sourceImplementationRetired: true,
  };
}

async function inspectReadiness(
  db: DbTx,
  campaignIds: string[] | undefined,
): Promise<OpenCfd2606CutoverReadiness> {
  const blockers: OpenCfd2606CutoverBlocker[] = [];
  const addBlocker = (
    kind: OpenCfd2606CutoverBlocker["kind"],
    count: number,
    ids: string[],
    message: string,
  ) => {
    if (count > 0) blockers.push({ kind, count, ids, message });
  };

  const [sourcePool] = await asDb(db)
    .select({ enabled: solverExecutionPools.enabled })
    .from(solverExecutionPools)
    .where(eq(solverExecutionPools.id, OPENCFD_2406_EXECUTION_POOL_ID))
    .limit(1);
  const [targetPool] = await asDb(db)
    .select({ enabled: solverExecutionPools.enabled })
    .from(solverExecutionPools)
    .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID))
    .limit(1);
  const [sourceImplementation] = await asDb(db)
    .select({ retiredAt: solverImplementations.retiredAt })
    .from(solverImplementations)
    .where(eq(solverImplementations.id, OPENCFD_2406_SOLVER_IMPLEMENTATION_ID))
    .limit(1);
  const [targetImplementation] = await asDb(db)
    .select({
      id: solverImplementations.id,
      retiredAt: solverImplementations.retiredAt,
    })
    .from(solverImplementations)
    .where(eq(solverImplementations.id, OPENCFD_2606_SOLVER_IMPLEMENTATION_ID))
    .limit(1);
  addBlocker(
    "source_pool_enabled",
    sourcePool?.enabled ? 1 : 0,
    sourcePool?.enabled ? [OPENCFD_2406_EXECUTION_POOL_ID] : [],
    "OpenCFD 2406 execution admission is still enabled",
  );
  addBlocker(
    "source_implementation_active",
    sourceImplementation && !sourceImplementation.retiredAt ? 1 : 0,
    sourceImplementation && !sourceImplementation.retiredAt
      ? [OPENCFD_2406_SOLVER_IMPLEMENTATION_ID]
      : [],
    "OpenCFD 2406 implementation admission is not retired",
  );
  addBlocker(
    "target_implementation_missing",
    targetImplementation ? 0 : 1,
    [],
    "OpenCFD 2606 implementation is missing",
  );
  addBlocker(
    "target_implementation_retired",
    targetImplementation?.retiredAt ? 1 : 0,
    targetImplementation?.retiredAt
      ? [OPENCFD_2606_SOLVER_IMPLEMENTATION_ID]
      : [],
    "OpenCFD 2606 implementation is retired",
  );

  const oldProfiles = await asDb(db)
    .select({ id: solverProfiles.id })
    .from(solverProfiles)
    .where(
      eq(
        solverProfiles.solverImplementationId,
        OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
      ),
    );
  addBlocker(
    "source_solver_profiles",
    oldProfiles.length,
    oldProfiles.slice(0, 25).map((profile) => profile.id),
    "mutable solver profiles still select OpenCFD 2406",
  );

  const liveJobs = await asDb(db)
    .select({ id: simJobs.id, status: simJobs.status })
    .from(simJobs)
    .where(
      and(
        inArray(simJobs.status, [
          "pending",
          "submitted",
          "running",
          "ingesting",
        ]),
        sourceJobWhere(),
      ),
    )
    .orderBy(asc(simJobs.createdAt), asc(simJobs.id));
  for (const status of [
    "pending",
    "submitted",
    "running",
    "ingesting",
  ] as const) {
    const jobs = liveJobs.filter((job) => job.status === status);
    addBlocker(
      `source_job_${status}`,
      jobs.length,
      jobs.slice(0, 25).map((job) => job.id),
      `OpenCFD 2406/legacy jobs remain ${status}`,
    );
  }

  const runningLadder = (await asDb(db).execute(sql`
    SELECT kind, id
    FROM (
      SELECT 'precalc'::text AS kind, obligation.id::text AS id
      FROM sim_precalc_obligations obligation
      JOIN simulation_preset_revisions revision ON revision.id = obligation.revision_id
      WHERE obligation.state = 'running'
        AND revision.solver_implementation_id = ANY(
          ARRAY[${sql.join(
            OLD_REVISION_IMPLEMENTATION_IDS.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]::uuid[]
        )
      UNION ALL
      SELECT 'urans_request', request.id::text
      FROM sim_urans_requests request
      JOIN simulation_preset_revisions revision ON revision.id = request.revision_id
      WHERE request.state = 'running'
        AND revision.solver_implementation_id = ANY(
          ARRAY[${sql.join(
            OLD_REVISION_IMPLEMENTATION_IDS.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]::uuid[]
        )
      UNION ALL
      SELECT 'verify', item.id::text
      FROM sim_urans_verify_queue item
      JOIN simulation_preset_revisions revision ON revision.id = item.revision_id
      WHERE item.state = 'running'
        AND revision.solver_implementation_id = ANY(
          ARRAY[${sql.join(
            OLD_REVISION_IMPLEMENTATION_IDS.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]::uuid[]
        )
    ) live
  `)) as unknown as Array<{ kind: string; id: string }>;
  addBlocker(
    "source_ladder_running",
    runningLadder.length,
    runningLadder.slice(0, 25).map((item) => `${item.kind}:${item.id}`),
    "OpenCFD 2406/legacy ladder work has not reached a terminal state",
  );

  const cutoverFilters = [
    inArray(simCampaignSolverCutovers.status, ["prepared", "finalized"]),
    eq(
      simCampaignSolverCutovers.toSolverImplementationId,
      OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
    ),
  ];
  const scopedCutovers = await asDb(db)
    .select({
      campaignId: simCampaignSolverCutovers.campaignId,
      campaignStatus: simCampaigns.status,
    })
    .from(simCampaignSolverCutovers)
    .innerJoin(
      simCampaigns,
      eq(simCampaigns.id, simCampaignSolverCutovers.campaignId),
    )
    .where(and(...cutoverFilters));
  const unpaused = scopedCutovers.filter(
    (cutover) => cutover.campaignStatus !== "paused",
  );
  addBlocker(
    "campaign_not_paused",
    unpaused.length,
    unpaused.slice(0, 25).map((cutover) => cutover.campaignId),
    "a prepared campaign is no longer paused",
  );
  const unselectedCampaignIds = missingCampaignScope(campaignIds, [
    ...new Set(scopedCutovers.map((cutover) => cutover.campaignId)),
  ]);
  addBlocker(
    "unselected_source_campaign",
    unselectedCampaignIds.length,
    unselectedCampaignIds.slice(0, 25),
    "the selected campaign scope omits a global OpenCFD cutover campaign",
  );

  return {
    status: blockers.length === 0 ? "ready" : "blocked",
    ready: blockers.length === 0,
    blockers,
    sourcePoolEnabled: Boolean(sourcePool?.enabled),
    targetPoolEnabled: Boolean(targetPool?.enabled),
    checkedAt: new Date().toISOString(),
  };
}

/** Read-only global 2406 drain probe. Target-pool enablement is intentionally
 * not part of the old-worker drain proof. The guarded deploy enables, health
 * checks, and canaries the live 2606 pool before calling finalization; stage 3
 * independently requires that pool to remain enabled before resuming work. */
export async function inspectOpenCfd2606CutoverReadiness(
  db: DB,
  input: Pick<OpenCfd2606CutoverInput, "campaignIds"> = {},
): Promise<OpenCfd2606CutoverReadiness> {
  return inspectReadiness(db, normalizedIds(input.campaignIds));
}

function assertUsableSnapshot(
  value: Record<string, unknown>,
  revisionId: string,
): SimulationSetupSnapshot {
  const snapshot = value as unknown as SimulationSetupSnapshot;
  if (
    !snapshot.flowState ||
    !snapshot.referenceGeometry ||
    !snapshot.derived ||
    !snapshot.boundary ||
    !snapshot.mesh ||
    !snapshot.solver
  ) {
    throw new CampaignError(
      "invalid_state",
      `campaign revision ${revisionId} does not contain a complete immutable setup snapshot`,
    );
  }
  return snapshot;
}

function targetSnapshotForSource(
  source: Pick<
    typeof simulationPresetRevisions.$inferSelect,
    "id" | "solverImplementationId" | "snapshot"
  >,
  targetImplementation: typeof solverImplementations.$inferSelect,
): {
  snapshot: SimulationSetupSnapshot;
  physicsHash: string;
  methodCompatibilityHash: string;
  signatureHash: string;
} {
  if (
    !OLD_REVISION_IMPLEMENTATION_IDS.includes(
      source.solverImplementationId as (typeof OLD_REVISION_IMPLEMENTATION_IDS)[number],
    )
  ) {
    throw new CampaignError(
      "invalid_state",
      `source simulation revision ${source.id} is not a 2406/legacy cutover revision`,
    );
  }
  const sourceSnapshot = assertUsableSnapshot(source.snapshot, source.id);
  const targetSnapshot = JSON.parse(
    JSON.stringify(sourceSnapshot),
  ) as SimulationSetupSnapshot;
  targetSnapshot.engine = {
    implementationId: targetImplementation.id,
    key: targetImplementation.key,
    family: targetImplementation.family,
    distribution: targetImplementation.distribution,
    releaseVersion: targetImplementation.releaseVersion,
    methodFamily: targetImplementation.methodFamily,
    adapterContractVersion: targetImplementation.adapterContractVersion,
    numericsRevision: targetImplementation.numericsRevision,
  };
  const sourcePhysicsHash = physicsHashForSnapshot(sourceSnapshot);
  const targetPhysicsHash = physicsHashForSnapshot(targetSnapshot);
  if (sourcePhysicsHash !== targetPhysicsHash) {
    throw new CampaignError(
      "drift",
      `solver cutover changed physical/numerical setup for revision ${source.id}`,
    );
  }
  return {
    snapshot: targetSnapshot,
    physicsHash: targetPhysicsHash,
    methodCompatibilityHash: methodCompatibilityHashForSnapshot(targetSnapshot),
    signatureHash: simulationSetupSignature(targetSnapshot),
  };
}

function normalizedStoredPlan(
  value: Record<string, unknown>,
  campaignId: string,
): CampaignPlan {
  try {
    return normalizeCampaignPlan(value as unknown as CampaignPlanInput);
  } catch (error) {
    throw new CampaignError(
      "invalid_state",
      `campaign ${campaignId} plan cannot be replayed for the OpenCFD 2606 cutover: ${(error as Error).message}`,
      error instanceof CampaignError ? error.details : undefined,
    );
  }
}

async function preflightCampaignCutover(
  tx: CampaignTx,
  campaign: Pick<
    typeof simCampaigns.$inferSelect,
    "id" | "currentPlanRevisionId" | "currentConditionGeneration"
  >,
  targetImplementation: typeof solverImplementations.$inferSelect,
): Promise<void> {
  if (!campaign.currentPlanRevisionId) {
    throw new CampaignError(
      "invalid_state",
      `campaign ${campaign.id} has no current plan revision`,
    );
  }
  const [sourcePlan] = await asDb(tx)
    .select({ plan: simCampaignPlanRevisions.plan })
    .from(simCampaignPlanRevisions)
    .where(eq(simCampaignPlanRevisions.id, campaign.currentPlanRevisionId))
    .limit(1);
  if (!sourcePlan) {
    throw new CampaignError(
      "invalid_state",
      `campaign ${campaign.id} source plan revision is missing`,
    );
  }
  normalizedStoredPlan(sourcePlan.plan, campaign.id);

  const sourceRevisions = await asDb(tx)
    .select({
      conditionId: simCampaignConditions.id,
      id: simulationPresetRevisions.id,
      solverImplementationId: simulationPresetRevisions.solverImplementationId,
      snapshot: simulationPresetRevisions.snapshot,
    })
    .from(simCampaignConditions)
    .innerJoin(
      simulationPresetRevisions,
      eq(
        simulationPresetRevisions.id,
        simCampaignConditions.simulationPresetRevisionId,
      ),
    )
    .where(
      and(
        eq(simCampaignConditions.campaignId, campaign.id),
        eq(
          simCampaignConditions.generation,
          campaign.currentConditionGeneration,
        ),
        inArray(simCampaignConditions.status, ["active", "kept"]),
      ),
    )
    .orderBy(asc(simCampaignConditions.ord), asc(simCampaignConditions.id));
  if (sourceRevisions.length === 0) {
    throw new CampaignError(
      "invalid_state",
      `campaign ${campaign.id} has no current source conditions`,
    );
  }
  for (const revision of sourceRevisions) {
    try {
      targetSnapshotForSource(revision, targetImplementation);
    } catch (error) {
      throw new CampaignError(
        "invalid_state",
        `campaign ${campaign.id} condition ${revision.conditionId} cannot be cloned before retiring OpenCFD 2406: ${(error as Error).message}`,
        error instanceof CampaignError ? error.details : undefined,
      );
    }
  }
}

async function targetRevisionForSource(
  tx: CampaignTx,
  sourceRevisionId: string,
  targetImplementation: typeof solverImplementations.$inferSelect,
): Promise<{ presetId: string; revisionId: string }> {
  const [source] = await asDb(tx)
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, sourceRevisionId))
    .limit(1);
  if (!source) {
    throw new CampaignError(
      "invalid_state",
      `source simulation revision ${sourceRevisionId} is missing`,
    );
  }
  const target = targetSnapshotForSource(source, targetImplementation);
  const methodHash = target.methodCompatibilityHash;
  await asDb(tx).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"campaign-method:" + methodHash}, 0))`,
  );
  await asDb(tx).execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"campaign-cutover-preset:" + source.presetId}, 0))`,
  );
  const [sameSignature] = await asDb(tx)
    .select()
    .from(simulationPresetRevisions)
    .where(
      and(
        eq(simulationPresetRevisions.presetId, source.presetId),
        eq(simulationPresetRevisions.signatureHash, target.signatureHash),
        eq(
          simulationPresetRevisions.solverImplementationId,
          OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
        ),
      ),
    )
    .limit(1);
  if (sameSignature) {
    return {
      presetId: sameSignature.presetId,
      revisionId: sameSignature.id,
    };
  }
  // Method compatibility intentionally excludes scheduling, output, and sweep
  // policy. Those revisions may share one public polar series, but the
  // successor campaign must retain its own exact immutable request snapshot.
  // Elect at most one method-canonical row while inserting a noncanonical
  // exact-signature sibling when another preset already owns that election.
  const [canonicalMethod] = await asDb(tx)
    .select({ id: simulationPresetRevisions.id })
    .from(simulationPresetRevisions)
    .where(
      and(
        eq(
          simulationPresetRevisions.methodCompatibilityHashVersion,
          METHOD_COMPATIBILITY_HASH_VERSION,
        ),
        eq(simulationPresetRevisions.methodCompatibilityHash, methodHash),
        eq(simulationPresetRevisions.isCanonicalMethod, true),
      ),
    )
    .limit(1);
  const [latest] = await asDb(tx)
    .select({ revisionNumber: simulationPresetRevisions.revisionNumber })
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.presetId, source.presetId))
    .orderBy(sql`${simulationPresetRevisions.revisionNumber} DESC`)
    .limit(1);
  const [inserted] = await asDb(tx)
    .insert(simulationPresetRevisions)
    .values({
      presetId: source.presetId,
      revisionNumber: (latest?.revisionNumber ?? 0) + 1,
      signatureHash: target.signatureHash,
      reynolds: source.reynolds,
      mach: source.mach,
      referenceLengthM: source.referenceLengthM,
      snapshot: target.snapshot as unknown as Record<string, unknown>,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      physicsHash: target.physicsHash,
      methodCompatibilityHashVersion: METHOD_COMPATIBILITY_HASH_VERSION,
      methodCompatibilityHash: methodHash,
      isCanonicalPhysics: false,
      isCanonicalMethod: !canonicalMethod,
    })
    .returning();
  return { presetId: inserted.presetId, revisionId: inserted.id };
}

async function cancelSupersededCampaignOwnership(
  tx: CampaignTx,
  campaignId: string,
): Promise<void> {
  await asDb(tx).execute(sql`
    UPDATE sim_urans_request_campaigns
    SET state = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), "updatedAt" = now()
    WHERE campaign_id = ${campaignId} AND state = 'active'
  `);
  await asDb(tx).execute(sql`
    UPDATE sim_urans_verify_queue_campaigns
    SET state = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), "updatedAt" = now()
    WHERE campaign_id = ${campaignId} AND state = 'active'
  `);
  await asDb(tx).execute(sql`
    UPDATE sim_precalc_obligation_campaigns
    SET state = 'cancelled', cancelled_at = COALESCE(cancelled_at, now()), "updatedAt" = now()
    WHERE campaign_id = ${campaignId} AND state = 'active'
  `);
  await asDb(tx).execute(sql`
    UPDATE sim_urans_requests request
    SET state = 'cancelled', "updatedAt" = now()
    WHERE request.state = 'pending' AND NOT request.background_owner
      AND EXISTS (
        SELECT 1 FROM sim_urans_request_campaigns owner
        WHERE owner.request_id = request.id AND owner.campaign_id = ${campaignId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM sim_urans_request_campaigns owner
        WHERE owner.request_id = request.id AND owner.state = 'active'
      )
  `);
  await asDb(tx).execute(sql`
    UPDATE sim_urans_verify_queue item
    SET state = 'cancelled', "updatedAt" = now()
    WHERE item.state = 'pending' AND NOT item.background_owner
      AND EXISTS (
        SELECT 1 FROM sim_urans_verify_queue_campaigns owner
        WHERE owner.queue_id = item.id AND owner.campaign_id = ${campaignId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM sim_urans_verify_queue_campaigns owner
        WHERE owner.queue_id = item.id AND owner.state = 'active'
      )
  `);
  await asDb(tx).execute(sql`
    UPDATE sim_precalc_obligations obligation
    SET state = 'cancelled', completed_at = COALESCE(completed_at, now()),
        last_error = COALESCE(last_error, ${CUTOVER_REASON}), "updatedAt" = now()
    WHERE obligation.state = 'pending' AND NOT obligation.background_owner
      AND EXISTS (
        SELECT 1 FROM sim_precalc_obligation_campaigns owner
        WHERE owner.obligation_id = obligation.id AND owner.campaign_id = ${campaignId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM sim_precalc_obligation_campaigns owner
        WHERE owner.obligation_id = obligation.id AND owner.state = 'active'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_requests coverage
        JOIN sim_urans_requests request ON request.id = coverage.request_id
        WHERE coverage.obligation_id = obligation.id
          AND request.background_owner
          AND request.state IN ('pending', 'running')
      )
  `);
}

async function createTargetLanes(
  tx: CampaignTx,
  campaignId: string,
  generation: number,
  plan: CampaignPlan,
): Promise<void> {
  for (const objective of CAMPAIGN_OBJECTIVES) {
    if (!plan.objectives[objective.id].enabled) continue;
    await asDb(tx).execute(sql`
      INSERT INTO sim_campaign_lanes
        (campaign_id, airfoil_id, condition_id, objective, state)
      SELECT condition.campaign_id, scope.airfoil_id, condition.id, ${objective.key},
        CASE
          WHEN ${objective.key} = 'cl_zero' AND foil.is_symmetric
          THEN 'symmetric_definition'
          ELSE 'awaiting_seed'
        END
      FROM sim_campaign_conditions condition
      JOIN sim_campaign_airfoils scope ON scope.campaign_id = condition.campaign_id
      JOIN airfoils foil ON foil.id = scope.airfoil_id
      WHERE condition.campaign_id = ${campaignId}
        AND condition.generation = ${generation}
        AND condition.status IN ('active', 'kept')
      ON CONFLICT (campaign_id, airfoil_id, condition_id, objective) DO NOTHING
    `);
  }
}

/** Stage 2: after the old worker is fully drained, create one successor
 * condition generation and a fresh requested point for every current source
 * obligation. The guarded deploy calls this only after the live 2606 pool has
 * passed its health check and canary. Campaigns deliberately remain paused
 * until stage 3 makes the new generation schedulable. */
export async function finalizeOpenCfd2606Cutover(
  db: DB,
  input: OpenCfd2606CutoverInput = {},
): Promise<OpenCfd2606CutoverFinalization> {
  const campaignIds = normalizedIds(input.campaignIds);
  const actor = normalizedText(input.actor);
  const canaryAttestationId = requiredCanaryAttestationId(
    input.canaryAttestationId,
  );
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as CampaignTx;
    await lockCutover(tx);
    await getOpenCfd2606CanaryAttestation(asDb(tx), canaryAttestationId, {
      requireEnabledPool: true,
    });
    const readiness = await inspectReadiness(tx, campaignIds);
    if (!readiness.ready) {
      throw new CampaignError(
        "invalid_state",
        "OpenCFD 2406 work has not fully drained",
        readiness,
      );
    }
    // A terminal ingest may create new pending old-revision ladder metadata
    // after preparation. No producer remains after drain proof, so cancel that
    // late scheduling intent now; immutable evidence is never touched.
    const latePendingLadderItemsCancelled =
      await cancelPendingOldLadderItems(tx);

    const [targetImplementation] = await asDb(tx)
      .select()
      .from(solverImplementations)
      .where(
        eq(solverImplementations.id, OPENCFD_2606_SOLVER_IMPLEMENTATION_ID),
      )
      .limit(1);
    if (!targetImplementation || targetImplementation.retiredAt) {
      throw new CampaignError(
        "invalid_state",
        "OpenCFD 2606 implementation is missing or retired",
      );
    }

    const filters = [
      eq(simCampaignSolverCutovers.status, "prepared"),
      eq(
        simCampaignSolverCutovers.toSolverImplementationId,
        OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      ),
    ];
    if (campaignIds !== undefined) {
      filters.push(
        campaignIds.length
          ? inArray(simCampaignSolverCutovers.campaignId, campaignIds)
          : sql`false`,
      );
    }
    const pending = await asDb(tx)
      .select()
      .from(simCampaignSolverCutovers)
      .where(and(...filters))
      .orderBy(
        asc(simCampaignSolverCutovers.preparedAt),
        asc(simCampaignSolverCutovers.id),
      )
      .for("update");

    const completedScopeFilters = [
      inArray(simCampaignSolverCutovers.status, ["finalized", "completed"]),
      eq(
        simCampaignSolverCutovers.toSolverImplementationId,
        OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      ),
    ];
    if (campaignIds !== undefined) {
      completedScopeFilters.push(
        campaignIds.length
          ? inArray(simCampaignSolverCutovers.campaignId, campaignIds)
          : sql`false`,
      );
    }
    const alreadyFinalized = await asDb(tx)
      .select({
        id: simCampaignSolverCutovers.id,
        canaryAttestationId: simCampaignSolverCutovers.canaryAttestationId,
      })
      .from(simCampaignSolverCutovers)
      .where(and(...completedScopeFilters));
    const conflictingReplay = alreadyFinalized.find(
      (row) => row.canaryAttestationId !== canaryAttestationId,
    );
    if (conflictingReplay) {
      throw new CampaignError(
        "conflict",
        `cutover ${conflictingReplay.id} was finalized with a different canary attestation`,
      );
    }

    const cutoverIds: string[] = [];
    let sourceConditionsSuperseded = 0;
    let targetConditionsCreated = 0;
    let targetPointsCreated = 0;

    for (const cutover of pending) {
      const [campaign] = await asDb(tx)
        .select()
        .from(simCampaigns)
        .where(eq(simCampaigns.id, cutover.campaignId))
        .for("update")
        .limit(1);
      if (!campaign || campaign.status !== "paused") {
        throw new CampaignError(
          "invalid_state",
          `campaign ${cutover.campaignId} must remain paused during cutover`,
        );
      }
      if (
        campaign.currentConditionGeneration !== cutover.sourceGeneration ||
        campaign.currentPlanRevisionId !== cutover.sourcePlanRevisionId
      ) {
        throw new CampaignError(
          "conflict",
          `campaign ${campaign.id} changed after cutover preparation`,
        );
      }
      const [sourcePlan] = await asDb(tx)
        .select()
        .from(simCampaignPlanRevisions)
        .where(eq(simCampaignPlanRevisions.id, cutover.sourcePlanRevisionId))
        .limit(1);
      if (!sourcePlan) {
        throw new CampaignError(
          "invalid_state",
          `campaign ${campaign.id} source plan revision is missing`,
        );
      }
      const normalizedSourcePlan = normalizedStoredPlan(
        sourcePlan.plan,
        campaign.id,
      );
      const sourceConditions = await asDb(tx)
        .select()
        .from(simCampaignConditions)
        .where(
          and(
            eq(simCampaignConditions.campaignId, campaign.id),
            eq(simCampaignConditions.generation, cutover.sourceGeneration),
            inArray(simCampaignConditions.status, ["active", "kept"]),
          ),
        )
        .orderBy(asc(simCampaignConditions.ord), asc(simCampaignConditions.id));
      if (sourceConditions.length === 0) {
        throw new CampaignError(
          "invalid_state",
          `campaign ${campaign.id} has no current source conditions`,
        );
      }
      const [sourcePointCount] = (await asDb(tx).execute(sql`
        SELECT count(*)::int AS n
        FROM sim_campaign_points point
        JOIN sim_campaign_conditions condition ON condition.id = point.condition_id
        WHERE point.campaign_id = ${campaign.id}
          AND condition.generation = ${cutover.sourceGeneration}
          AND condition.status IN ('active', 'kept')
          AND point.state <> 'released'
      `)) as unknown as Array<{ n: number }>;
      const [latestPlan] = await asDb(tx)
        .select({ revisionNumber: simCampaignPlanRevisions.revisionNumber })
        .from(simCampaignPlanRevisions)
        .where(eq(simCampaignPlanRevisions.campaignId, campaign.id))
        .orderBy(sql`${simCampaignPlanRevisions.revisionNumber} DESC`)
        .limit(1);
      const targetPlanNumber = (latestPlan?.revisionNumber ?? 0) + 1;
      const [targetPlan] = await asDb(tx)
        .insert(simCampaignPlanRevisions)
        .values({
          campaignId: campaign.id,
          revisionNumber: targetPlanNumber,
          kind: "engine_cutover",
          plan: normalizedSourcePlan as unknown as Record<string, unknown>,
          summary: {
            fromSolverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
            toSolverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
            sourceGeneration: cutover.sourceGeneration,
            targetGeneration: cutover.targetGeneration,
            sourceConditions: sourceConditions.length,
            freshTargetPoints: Number(sourcePointCount?.n ?? 0),
            evidenceRelabelled: 0,
          },
          createdBy: actor,
        })
        .returning();

      for (const sourceCondition of sourceConditions) {
        const targetRevision = await targetRevisionForSource(
          tx,
          sourceCondition.simulationPresetRevisionId,
          targetImplementation,
        );
        const [targetCondition] = await asDb(tx)
          .insert(simCampaignConditions)
          .values({
            campaignId: campaign.id,
            ord: sourceCondition.ord,
            generation: cutover.targetGeneration,
            flowConditionId: sourceCondition.flowConditionId,
            referenceGeometryProfileId:
              sourceCondition.referenceGeometryProfileId,
            presetId: targetRevision.presetId,
            simulationPresetRevisionId: targetRevision.revisionId,
            reynolds: sourceCondition.reynolds,
            mach: sourceCondition.mach,
            status: sourceCondition.status,
            supersedesConditionId: sourceCondition.id,
            introducedInPlanRevisionId: targetPlan.id,
          })
          .returning();
        await asDb(tx).execute(sql`
          INSERT INTO sim_campaign_solver_cutover_points
            (cutover_id, campaign_id, source_condition_id,
             target_condition_id, airfoil_id, aoa_deg, target_revision_id)
          SELECT ${cutover.id}, point.campaign_id, ${sourceCondition.id},
                 ${targetCondition.id}, point.airfoil_id, point.aoa_deg,
                 ${targetRevision.revisionId}
            FROM sim_campaign_points point
           WHERE point.campaign_id = ${campaign.id}
             AND point.condition_id = ${sourceCondition.id}
             AND point.state <> 'released'
          ON CONFLICT DO NOTHING
        `);
        const insertedPoints = await asDb(tx).execute(sql`
          INSERT INTO sim_campaign_points
            (campaign_id, condition_id, airfoil_id, aoa_deg, revision_id,
             plan_revision_number, state, result_id, result_attempt_id,
             derived_by_symmetry)
          SELECT coverage.campaign_id, coverage.target_condition_id,
                 coverage.airfoil_id, coverage.aoa_deg,
                 coverage.target_revision_id,
                 ${targetPlanNumber}, 'requested', NULL, NULL,
                 source_point.derived_by_symmetry
          FROM sim_campaign_solver_cutover_points coverage
          JOIN sim_campaign_points source_point
            ON source_point.campaign_id = coverage.campaign_id
           AND source_point.condition_id = coverage.source_condition_id
           AND source_point.airfoil_id = coverage.airfoil_id
           AND source_point.aoa_deg = coverage.aoa_deg
          WHERE coverage.cutover_id = ${cutover.id}
            AND coverage.target_condition_id = ${targetCondition.id}
          ON CONFLICT (campaign_id, condition_id, airfoil_id, aoa_deg)
          DO NOTHING
          RETURNING aoa_deg
        `);
        targetConditionsCreated += 1;
        targetPointsCreated += insertedPoints.length;
      }

      const [coverageCount] = (await asDb(tx).execute(sql`
        SELECT count(*)::int AS n
          FROM sim_campaign_solver_cutover_points
         WHERE cutover_id = ${cutover.id}
      `)) as unknown as Array<{ n: number }>;
      if (Number(coverageCount?.n ?? 0) !== Number(sourcePointCount?.n ?? 0)) {
        throw new CampaignError(
          "conflict",
          `campaign ${campaign.id} eligible source-cell snapshot changed during finalization`,
        );
      }

      const superseded = await asDb(tx)
        .update(simCampaignConditions)
        .set({
          status: "superseded",
          supersededAt: new Date(),
          statusChangedInPlanRevisionId: targetPlan.id,
        })
        .where(
          and(
            eq(simCampaignConditions.campaignId, campaign.id),
            eq(simCampaignConditions.generation, cutover.sourceGeneration),
          ),
        )
        .returning({ id: simCampaignConditions.id });
      await asDb(tx).execute(sql`
        UPDATE sim_campaign_points point
        SET state = 'released', "updatedAt" = now()
        FROM sim_campaign_conditions condition
        WHERE point.campaign_id = ${campaign.id}
          AND point.condition_id = condition.id
          AND condition.campaign_id = point.campaign_id
          AND condition.generation = ${cutover.sourceGeneration}
      `);
      await cancelSupersededCampaignOwnership(tx, campaign.id);
      await asDb(tx)
        .update(simCampaigns)
        .set({
          currentConditionGeneration: cutover.targetGeneration,
          currentPlanRevisionId: targetPlan.id,
          completedAt: null,
        })
        .where(eq(simCampaigns.id, campaign.id));
      await createTargetLanes(
        tx,
        campaign.id,
        cutover.targetGeneration,
        normalizedSourcePlan,
      );
      await recomputeCampaignProgress(tx, campaign.id);
      await asDb(tx)
        .update(simCampaignSolverCutovers)
        .set({
          status: "finalized",
          canaryAttestationId,
          targetPlanRevisionId: targetPlan.id,
          finalizedBy: actor,
          finalizedAt: new Date(),
          sourceConditionCount: superseded.length,
          targetConditionCount: sourceConditions.length,
          targetPointCount: Number(coverageCount?.n ?? 0),
        })
        .where(eq(simCampaignSolverCutovers.id, cutover.id));
      cutoverIds.push(cutover.id);
      sourceConditionsSuperseded += superseded.length;
    }

    if (pending.length > 0 || alreadyFinalized.length > 0) {
      await ensureOpenCfd2606ContinuationCheck(asDb(tx), canaryAttestationId);
    }

    return {
      status: "finalized" as const,
      cutoverIds,
      campaignsFinalized: pending.length,
      campaignsAlreadyFinalized: alreadyFinalized.length,
      sourceConditionsSuperseded,
      targetConditionsCreated,
      targetPointsCreated,
      latePendingLadderItemsCancelled,
      canaryAttestationId,
    };
  });
}

/** Stage 3: require the replacement pool to remain live, reassert the 2406
 * retirement fence, and restore only campaigns which were runnable when
 * preparation began. */
export async function completeOpenCfd2606Cutover(
  db: DB,
  input: OpenCfd2606CutoverInput = {},
): Promise<OpenCfd2606CutoverCompletion> {
  const campaignIds = normalizedIds(input.campaignIds);
  const actor = normalizedText(input.actor);
  const requestedCanaryAttestationId = input.canaryAttestationId
    ? requiredCanaryAttestationId(input.canaryAttestationId)
    : null;
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as CampaignTx;
    await lockCutover(tx);
    const readiness = await inspectReadiness(tx, campaignIds);
    if (!readiness.ready) {
      throw new CampaignError(
        "invalid_state",
        "OpenCFD 2406 work is no longer fully drained",
        readiness,
      );
    }
    const [targetPool] = await asDb(tx)
      .select()
      .from(solverExecutionPools)
      .where(eq(solverExecutionPools.id, OPENCFD_2606_EXECUTION_POOL_ID))
      .for("update")
      .limit(1);
    if (
      !targetPool ||
      !targetPool.enabled ||
      targetPool.solverImplementationId !==
        OPENCFD_2606_SOLVER_IMPLEMENTATION_ID
    ) {
      throw new CampaignError(
        "invalid_state",
        "OpenCFD 2606 execution pool must be enabled before completion",
      );
    }
    const [remainingPrepared] = await asDb(tx)
      .select({ id: simCampaignSolverCutovers.id })
      .from(simCampaignSolverCutovers)
      .where(
        and(
          eq(simCampaignSolverCutovers.status, "prepared"),
          eq(
            simCampaignSolverCutovers.toSolverImplementationId,
            OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
          ),
        ),
      )
      .limit(1);
    if (remainingPrepared) {
      throw new CampaignError(
        "invalid_state",
        "every prepared campaign must be finalized before retiring OpenCFD 2406",
      );
    }

    const filters = [
      eq(simCampaignSolverCutovers.status, "finalized"),
      eq(
        simCampaignSolverCutovers.toSolverImplementationId,
        OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      ),
    ];
    if (campaignIds !== undefined) {
      filters.push(
        campaignIds.length
          ? inArray(simCampaignSolverCutovers.campaignId, campaignIds)
          : sql`false`,
      );
    }
    const finalizable = await asDb(tx)
      .select()
      .from(simCampaignSolverCutovers)
      .where(and(...filters))
      .orderBy(
        asc(simCampaignSolverCutovers.preparedAt),
        asc(simCampaignSolverCutovers.id),
      )
      .for("update");
    const completedFilters = [
      eq(simCampaignSolverCutovers.status, "completed"),
      eq(
        simCampaignSolverCutovers.toSolverImplementationId,
        OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      ),
    ];
    if (campaignIds !== undefined) {
      completedFilters.push(
        campaignIds.length
          ? inArray(simCampaignSolverCutovers.campaignId, campaignIds)
          : sql`false`,
      );
    }
    const alreadyCompleted = await asDb(tx)
      .select({
        id: simCampaignSolverCutovers.id,
        canaryAttestationId: simCampaignSolverCutovers.canaryAttestationId,
      })
      .from(simCampaignSolverCutovers)
      .where(and(...completedFilters));

    const completionRows = [...finalizable, ...alreadyCompleted];
    const linkedAttestationIds = [
      ...new Set(
        completionRows.map((row) => row.canaryAttestationId).filter(Boolean),
      ),
    ] as string[];
    if (
      completionRows.some((row) => !row.canaryAttestationId) ||
      linkedAttestationIds.length > 1 ||
      (requestedCanaryAttestationId != null &&
        linkedAttestationIds.some((id) => id !== requestedCanaryAttestationId))
    ) {
      throw new CampaignError(
        "conflict",
        "OpenCFD 2606 cutovers do not share the requested durable canary attestation",
      );
    }
    for (const attestationId of linkedAttestationIds) {
      await getOpenCfd2606CanaryAttestation(asDb(tx), attestationId, {
        requireEnabledPool: true,
      });
    }

    const cutoverIds: string[] = [];
    let campaignsResumed = 0;
    let campaignsLeftPaused = 0;
    for (const cutover of finalizable) {
      const [campaign] = await asDb(tx)
        .select()
        .from(simCampaigns)
        .where(eq(simCampaigns.id, cutover.campaignId))
        .for("update")
        .limit(1);
      if (
        !campaign ||
        campaign.status !== "paused" ||
        campaign.currentConditionGeneration !== cutover.targetGeneration ||
        campaign.currentPlanRevisionId !== cutover.targetPlanRevisionId
      ) {
        throw new CampaignError(
          "conflict",
          `campaign ${cutover.campaignId} changed after cutover finalization`,
        );
      }
      if (["active", "attention"].includes(cutover.priorCampaignStatus)) {
        await asDb(tx)
          .update(simCampaigns)
          .set({ status: "active", completedAt: null })
          .where(eq(simCampaigns.id, campaign.id));
        await asDb(tx)
          .insert(simCampaignLifecycleEvents)
          .values({
            campaignId: campaign.id,
            action: "resume",
            fromStatus: "paused",
            toStatus: "active",
            actor,
            reason: CUTOVER_REASON,
            metadata: {
              cutoverId: cutover.id,
              targetGeneration: cutover.targetGeneration,
              solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
            },
          });
        campaignsResumed += 1;
      } else {
        campaignsLeftPaused += 1;
      }
      await asDb(tx)
        .update(simCampaignSolverCutovers)
        .set({
          status: "completed",
          completedBy: actor,
          completedAt: new Date(),
        })
        .where(eq(simCampaignSolverCutovers.id, cutover.id));
      cutoverIds.push(cutover.id);
    }

    await asDb(tx)
      .update(solverExecutionPools)
      .set({ enabled: false })
      .where(eq(solverExecutionPools.id, OPENCFD_2406_EXECUTION_POOL_ID));
    await asDb(tx)
      .update(solverImplementations)
      .set({
        retiredAt: sql`COALESCE(${solverImplementations.retiredAt}, now())`,
      })
      .where(
        eq(solverImplementations.id, OPENCFD_2406_SOLVER_IMPLEMENTATION_ID),
      );

    return {
      status: "completed" as const,
      cutoverIds,
      campaignsCompleted: finalizable.length,
      campaignsAlreadyCompleted: alreadyCompleted.length,
      campaignsResumed,
      campaignsLeftPaused,
      sourcePoolDisabled: true,
      sourceImplementationRetired: true,
    };
  });
}
