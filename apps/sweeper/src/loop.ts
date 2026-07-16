import {
  airfoils,
  type CampaignGapBatch,
  compareScheduleCandidates,
  type DB,
  findCampaignGapBatch,
  results,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
  sweeperState,
} from "@aerodb/db";
import {
  ensureEnabledSimulationPresetRevisions,
  ensureSimulationPresetRevision,
  snapshotAoas,
  type SimulationSetupSnapshot,
} from "@aerodb/db/simulation-setup";
import type { EngineClient } from "@aerodb/engine-client";
import { count, eq, inArray, sql } from "drizzle-orm";

import {
  buildPolarRequest,
  solverImplementationIdForSetup,
} from "./build-request";
import { claimAoas } from "./claim";
import { refreshDiskAdmission } from "./disk-admission";
import {
  submitCampaignPrecalcRecoveries,
  submitRecordedPromotionRecovery,
  uransLadderTick,
} from "./urans-ladder";
import {
  clearEngineUnreachable,
  engineBackoffActive,
  recordEngineUnreachable,
} from "./engine-backoff";
import { requireExecutionPoolForSetup } from "./engine-pool";
import { type ContinuousBatch, findGaps, firstBatch } from "./gaps";
import {
  markTickCompleted,
  markTickStarted,
  touchHeartbeat,
} from "./heartbeat";
import { prepareAutomaticMeshRecovery } from "./mesh-recovery";
import { reconcile, resetOrphans } from "./reconcile";
import { remoteSolverTick } from "./remote-solver";
import { retentionTick } from "./retention";
import { retryScopeForRequestedPolar } from "./retry-plan";
import { submitPendingJobWithLifecycleGuard } from "./submit-lifecycle";

interface SweeperConfig {
  enabled: boolean;
  maxConcurrentJobs: number;
  cpuSlots: number;
  pollIntervalMs: number;
  submitIntervalMs: number;
}

/**
 * `max_concurrent_jobs` predates the single "OpenFOAM CPU slots" control and
 * was never exposed in the admin UI.  A legacy value of two therefore became
 * an invisible hard ceiling: once a second job existed, engine auto-mode
 * quite correctly selected one CPU per job and left the remaining worker
 * tokens idle.  Zero means that the visible global capacity control owns the
 * admission limit too.  The Node services receive the same worker budget as
 * the engine through compose; retain a conservative fallback for unusual
 * local/development deployments that do not set it.
 */
export function effectiveMaxConcurrentJobs(
  configuredMax: number | null | undefined,
  cpuSlots: number | null | undefined,
  workerBudget = Number(process.env.AIRFOILFOAM_WORKER_CPU_BUDGET ?? 2),
): number {
  if (Number.isInteger(configuredMax) && (configuredMax ?? 0) > 0)
    return configuredMax as number;
  if (Number.isInteger(cpuSlots) && (cpuSlots ?? 0) > 0)
    return cpuSlots as number;
  return Number.isInteger(workerBudget) && workerBudget > 0 ? workerBudget : 2;
}

export async function getState(db: DB): Promise<SweeperConfig> {
  // Projected select (not select()) so the sweeper keeps working while the
  // 0026 engineUnreachableSince column has not been applied yet.
  const [s] = await db
    .select({
      enabled: sweeperState.enabled,
      maxConcurrentJobs: sweeperState.maxConcurrentJobs,
      cpuSlots: sweeperState.cpuSlots,
      pollIntervalMs: sweeperState.pollIntervalMs,
      submitIntervalMs: sweeperState.submitIntervalMs,
    })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  return {
    enabled: s?.enabled ?? false,
    // 0 = auto: admit up to the same CPU-token capacity the engine owns.
    // A positive value remains an explicit API-only override for installations
    // that deliberately want fewer concurrent polar jobs.
    maxConcurrentJobs: effectiveMaxConcurrentJobs(
      s?.maxConcurrentJobs,
      s?.cpuSlots,
    ),
    // 0 = auto: submit without a cpu_budget cap (the pre-campaign behavior).
    cpuSlots: s?.cpuSlots ?? 0,
    pollIntervalMs: s?.pollIntervalMs ?? 5000,
    submitIntervalMs: s?.submitIntervalMs ?? 15000,
  };
}

async function inFlight(db: DB): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(simJobs)
    .where(inArray(simJobs.status, ["submitted", "running", "ingesting"]));
  return r?.n ?? 0;
}

async function submitComposedJob(
  db: DB,
  engine: EngineClient,
  jobId: string,
  request: Parameters<EngineClient["submitPolar"]>[0],
  /** Loud claim→submit addressing (campaign, airfoil, angles): the 2026-07-07
   *  gate run's only campaign job went claim → submit → terminal failure with
   *  ZERO sweeper log lines — every submit outcome logs exactly one line. */
  context = "",
  campaignId: string | null = null,
): Promise<boolean> {
  const suffix = context ? `, ${context}` : "";
  const outcome = await submitPendingJobWithLifecycleGuard({
    db,
    engine,
    jobId,
    campaignId,
    request,
    connectionErrorPrefix: "engine unreachable at submit: ",
    submitErrorPrefix: "submit failed: ",
  });
  if (outcome.kind === "submitted") {
    await clearEngineUnreachable(db);
    console.log(
      `[sweeper] job submitted → engine ${outcome.status.job_id} (sim_job ${jobId}${suffix})`,
    );
    return true;
  }
  if (outcome.kind === "submission_in_progress") {
    console.log(
      `[sweeper] job submission already owned (sim_job ${jobId}${suffix})`,
    );
    return true;
  }
  if (outcome.kind === "connection_failure") {
    console.error(
      `[sweeper] job submit RELEASED — engine unreachable (sim_job ${jobId}${suffix}): ${outcome.error}`,
    );
    await recordEngineUnreachable(db);
    return false;
  }
  if (outcome.kind === "lifecycle_stopped") {
    console.log(
      `[sweeper] job submit STOPPED by campaign lifecycle (sim_job ${jobId}${suffix}): ${outcome.error}` +
        (outcome.engineCancelError
          ? `; compensating cancel pending: ${outcome.engineCancelError}`
          : ""),
    );
    return false;
  }
  console.error(
    `[sweeper] job submit FAILED (sim_job ${jobId}${suffix}): ${outcome.error}`,
  );
  return false;
}

async function submitContinuousBatch(
  db: DB,
  engine: EngineClient,
  batch: ContinuousBatch,
  cpuSlots: number,
): Promise<boolean> {
  const [a] = await db
    .select()
    .from(airfoils)
    .where(eq(airfoils.id, batch.airfoilId))
    .limit(1);
  const setup = await ensureSimulationPresetRevision(db, batch.presetId);
  if (!a || !setup) return false;
  const executionPool = await requireExecutionPoolForSetup(db, setup.snapshot);
  const bcId = setup.snapshot.preset.legacyBoundaryConditionId ?? batch.bcId;
  const retryScope = retryScopeForRequestedPolar(
    batch.effectivePriority >= 10 ? batch.aoas : snapshotAoas(setup.snapshot),
    { explicitTargeted: batch.effectivePriority >= 10 },
  );

  const { request, speed } = buildPolarRequest({
    airfoil: a,
    setup: setup.snapshot,
    aoaList: batch.aoas,
    wave: 1,
    ransFailurePolicy:
      retryScope.origin === "continuous-polar"
        ? "abort_for_precalc"
        : "continue",
    cpuSlots,
  });
  request.expected_execution_pool = executionPool.routingKey;

  // The job row and all result ownership become visible in one commit. An
  // admin cancel can therefore see either no composition or the complete
  // composition; it can never cancel the job between insert and claim.
  const composition = await db.transaction(async (tx) => {
    const [job] = await tx
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [bcId],
        simulationPresetRevisionId: setup.revision.id,
        solverImplementationId: solverImplementationIdForSetup(setup.snapshot),
        solverExecutionPoolId: executionPool.id,
        methodKey: "openfoam.rans",
        referenceChordM: setup.snapshot.referenceGeometry.referenceLengthM,
        wave: 1,
        status: "pending",
        totalCases: batch.aoas.length,
        requestPayload: {
          speedMap: [
            {
              speed,
              bcId,
              presetRevisionId: setup.revision.id,
              mach: setup.snapshot.flowState.mach,
            },
          ],
          aoas: batch.aoas,
          ransRetryScope: retryScope,
          resources: request.resources,
          setupSnapshot: setup.snapshot,
        },
      })
      .returning({ id: simJobs.id });
    const claimed = await claimAoas(
      tx,
      a.id,
      bcId,
      setup.revision.id,
      batch.aoas,
      job.id,
    );
    if (claimed.length === 0) {
      await tx
        .update(simJobs)
        .set({
          status: "cancelled",
          engineState: "cancelled",
          finishedAt: new Date(),
        })
        .where(eq(simJobs.id, job.id));
    }
    return { jobId: job.id, claimed };
  });
  const { jobId, claimed } = composition;
  if (claimed.length === 0) return false;
  request.aoa = { angles: claimed };
  return submitComposedJob(
    db,
    engine,
    jobId,
    request,
    `continuous, airfoil ${a.id}, angles [${claimed.join(", ")}]`,
  );
}

interface ResolvedCampaignEntry {
  conditionId: string;
  revisionId: string;
  presetId: string;
  speed: number;
  reynolds: number;
  requestedPolarAoas: number[];
  bcId: string;
  snapshot: SimulationSetupSnapshot;
}

/** Resolve each batch entry's bcId exactly like the existing claim path —
 *  snapshot legacy id first, live preset row fallback (launch runs
 *  syncLegacyBoundaryConditionForPreset before any points). Entries with no
 *  resolvable bc are skipped with a loud log (results.bcId is NOT NULL). */
async function resolveCampaignEntries(
  db: DB,
  batch: CampaignGapBatch,
): Promise<ResolvedCampaignEntry[]> {
  const revisionIds = [...new Set(batch.entries.map((e) => e.revisionId))];
  const revisions = await db
    .select()
    .from(simulationPresetRevisions)
    .where(inArray(simulationPresetRevisions.id, revisionIds));
  const revisionById = new Map(revisions.map((r) => [r.id, r]));
  const resolved: ResolvedCampaignEntry[] = [];
  for (const entry of batch.entries) {
    const revision = revisionById.get(entry.revisionId);
    if (!revision) {
      console.error(
        `[sweeper] campaign ${batch.campaignId}: pinned revision ${entry.revisionId} is missing — skipping condition ${entry.conditionId}`,
      );
      continue;
    }
    const snapshot = revision.snapshot as unknown as SimulationSetupSnapshot;
    let bcId = snapshot.preset.legacyBoundaryConditionId ?? null;
    if (!bcId) {
      const [preset] = await db
        .select({
          legacyBoundaryConditionId:
            simulationPresets.legacyBoundaryConditionId,
        })
        .from(simulationPresets)
        .where(eq(simulationPresets.id, entry.presetId))
        .limit(1);
      bcId = preset?.legacyBoundaryConditionId ?? null;
    }
    if (!bcId) {
      console.error(
        `[sweeper] campaign ${batch.campaignId}: preset ${entry.presetId} has no legacy boundary condition — cannot claim results (skipping condition ${entry.conditionId})`,
      );
      continue;
    }
    resolved.push({ ...entry, bcId, snapshot });
  }
  return resolved;
}

function campaignJobPayload(
  batch: CampaignGapBatch,
  entries: ResolvedCampaignEntry[],
  aoas: number[],
  jobKind: string,
  resources: unknown,
  anchorSnapshot: SimulationSetupSnapshot,
): Record<string, unknown> {
  return {
    speedMap: entries.map((e) => ({
      speed: e.speed,
      bcId: e.bcId,
      presetRevisionId: e.revisionId,
      mach: e.snapshot.flowState.mach,
    })),
    aoas,
    campaignId: batch.campaignId,
    jobKind,
    // Speed→condition ingest mapping (canonical speeds) + per-condition
    // revision/bc stamping for the batched job's results rows.
    conditionMap: entries.map((e) => ({
      conditionId: e.conditionId,
      revisionId: e.revisionId,
      presetId: e.presetId,
      speed: e.speed,
      reynolds: e.reynolds,
      bcId: e.bcId,
      ransRetryScope: retryScopeForRequestedPolar(e.requestedPolarAoas),
    })),
    resources,
    setupSnapshot: anchorSnapshot,
  };
}

/** Compose + claim + submit ONE batched campaign job: only that campaign's
 *  open points for the head (airfoil, chord, physics-group, angle-set) group
 *  across ALL its open speeds — never bundle foreign gaps (§7). The engine
 *  meshes once per airfoil-chord and marches every speed×angle warm-started.
 *  Physics come from the min-Re entry's PINNED revision snapshot (never
 *  re-resolved); every entry's snapshot shares the same ambient + numerics by
 *  the binding grouping rules. Exported for the integration tests. */
export async function submitCampaignBatch(
  db: DB,
  engine: EngineClient,
  batch: CampaignGapBatch,
  cpuSlotsOrLegacyQueuePressure: number,
  legacyCpuSlots?: number,
): Promise<boolean> {
  // Retain the former five-argument helper shape for deterministic scheduler
  // fixtures while making the legacy logical-backlog argument inert. Production
  // calls pass cpuSlots as the fourth argument; older callers pass
  // (queuePressure, cpuSlots), where only the final CPU cap is meaningful.
  const cpuSlots = legacyCpuSlots ?? cpuSlotsOrLegacyQueuePressure;
  const [a] = await db
    .select()
    .from(airfoils)
    .where(eq(airfoils.id, batch.airfoilId))
    .limit(1);
  if (!a) return false;
  const entries = await resolveCampaignEntries(db, batch);
  if (!entries.length) return false;
  // Min-Re entry = compat anchor: job revision, physics snapshot, chord.
  const anchor = entries[0];
  const snapshot = anchor.snapshot;
  const executionPool = await requireExecutionPoolForSetup(db, snapshot);
  const retryScope = retryScopeForRequestedPolar(anchor.requestedPolarAoas);

  const { request } = buildPolarRequest({
    airfoil: a,
    setup: snapshot,
    aoaList: batch.angles,
    wave: 1,
    ransFailurePolicy:
      retryScope.origin === "continuous-polar"
        ? "abort_for_precalc"
        : "continue",
    cpuSlots,
    speeds: entries.map((e) => e.speed),
  });
  request.expected_execution_pool = executionPool.routingKey;
  const totalCases = entries.length * batch.angles.length;
  const jobKind = totalCases <= 3 ? "targeted" : "sweep";

  // Beat before the bounded composition transaction. The independent timer
  // remains the liveness source if lock contention makes this wait noticeable.
  await touchHeartbeat(db);
  const composition = await db.transaction(async (tx) => {
    // Serialize lifecycle changes and campaign composers on the canonical
    // campaign row. Pause/cancel either commits first (and composition stops)
    // or waits and then observes/cancels the fully-claimed pending job.
    const campaignRows = (await tx.execute(sql`
      SELECT status
      FROM sim_campaigns
      WHERE id = ${batch.campaignId}
      FOR UPDATE
    `)) as unknown as Array<{ status: string }>;
    if (
      !campaignRows[0] ||
      !["active", "attention"].includes(campaignRows[0].status)
    )
      return null;

    const [job] = await tx
      .insert(simJobs)
      .values({
        airfoilId: a.id,
        bcIds: [...new Set(entries.map((e) => e.bcId))],
        simulationPresetRevisionId: anchor.revisionId,
        solverImplementationId: solverImplementationIdForSetup(snapshot),
        solverExecutionPoolId: executionPool.id,
        methodKey: "openfoam.rans",
        campaignId: batch.campaignId,
        jobKind,
        referenceChordM: snapshot.referenceGeometry.referenceLengthM,
        wave: 1,
        status: "pending",
        totalCases,
        requestPayload: campaignJobPayload(
          batch,
          entries,
          batch.angles,
          jobKind,
          request.resources,
          snapshot,
        ),
      })
      .returning({ id: simJobs.id });

    // Claim per entry inside the same transaction as the insert. Entries whose
    // points another committed composer already owns drop out of this job.
    const claimedUnion = new Set<number>();
    const activeEntries: ResolvedCampaignEntry[] = [];
    for (const entry of entries) {
      const claimed = await claimAoas(
        tx,
        a.id,
        entry.bcId,
        entry.revisionId,
        batch.angles,
        job.id,
      );
      if (claimed.length === 0) continue;
      for (const aoa of claimed) claimedUnion.add(aoa);
      activeEntries.push(entry);
    }
    if (claimedUnion.size === 0 || activeEntries.length === 0) {
      await tx
        .update(simJobs)
        .set({
          status: "cancelled",
          engineState: "cancelled",
          finishedAt: new Date(),
        })
        .where(eq(simJobs.id, job.id));
      return {
        jobId: job.id,
        claimedAoas: [] as number[],
        activeEntries: [] as ResolvedCampaignEntry[],
      };
    }
    await tx
      .update(results)
      .set({
        priority: sql`GREATEST(${results.priority}, ${batch.effectivePriority})`,
      })
      .where(eq(results.simJobId, job.id));

    const claimedAoas = [...claimedUnion].sort((x, y) => x - y);
    const finalTotal = activeEntries.length * claimedAoas.length;
    const finalKind = finalTotal <= 3 ? "targeted" : "sweep";
    if (
      finalKind !== jobKind ||
      finalTotal !== totalCases ||
      activeEntries.length !== entries.length
    ) {
      await tx
        .update(simJobs)
        .set({
          jobKind: finalKind,
          totalCases: finalTotal,
          bcIds: [...new Set(activeEntries.map((e) => e.bcId))],
          requestPayload: campaignJobPayload(
            batch,
            activeEntries,
            claimedAoas,
            finalKind,
            request.resources,
            snapshot,
          ),
        })
        .where(eq(simJobs.id, job.id));
    }
    return { jobId: job.id, claimedAoas, activeEntries };
  });
  if (
    !composition ||
    composition.claimedAoas.length === 0 ||
    composition.activeEntries.length === 0
  )
    return false;
  const { jobId, claimedAoas, activeEntries } = composition;
  request.speeds = activeEntries.map((e) => e.speed);
  request.aoa = { angles: claimedAoas };
  return submitComposedJob(
    db,
    engine,
    jobId,
    request,
    `campaign ${batch.campaignId}, airfoil ${a.id}, ${activeEntries.length} condition(s), angles [${claimedAoas.join(", ")}]`,
    batch.campaignId,
  );
}

/** ONE winner per tick across the continuous + campaign branches under the one
 *  total order: effectivePriority DESC, reynolds ASC, slug ASC, aoa ASC (§7). */
export async function submitOneBatch(
  db: DB,
  engine: EngineClient,
  cpuSlots = 0,
): Promise<boolean> {
  await ensureEnabledSimulationPresetRevisions(db);
  const gaps = await findGaps(db, 500);
  const continuous = firstBatch(gaps);
  const campaign = await findCampaignGapBatch(db, { limit: 500 });
  // Invariant: no code path may run >30 s without a heartbeat touch — the two
  // gap scans above are heavy queries at 10^5-point scale, and composing +
  // claiming + submitting the winner below adds more DB/engine round-trips.
  await touchHeartbeat(db);
  if (!continuous && !campaign) return false;

  let winner: "continuous" | "campaign";
  if (continuous && campaign) {
    winner =
      compareScheduleCandidates(
        {
          effectivePriority: campaign.effectivePriority,
          reynolds: campaign.reynolds,
          slug: campaign.slug,
          aoa: campaign.headAoa,
        },
        {
          effectivePriority: continuous.effectivePriority,
          reynolds: continuous.reynolds,
          slug: continuous.slug,
          aoa: continuous.headAoa,
        },
      ) < 0
        ? "campaign"
        : "continuous";
  } else {
    winner = campaign ? "campaign" : "continuous";
  }

  return winner === "campaign"
    ? submitCampaignBatch(db, engine, campaign as CampaignGapBatch, cpuSlots)
    : submitContinuousBatch(
        db,
        engine,
        continuous as ContinuousBatch,
        cpuSlots,
      );
}

/** One scheduler tick. `reconcileOptions` exists for the integration tests
 *  (they scope reconcile to their own job ids, the established harness
 *  pattern); the production loop always runs unscoped. */
export async function tick(
  db: DB,
  engine: EngineClient,
  reconcileOptions?: Parameters<typeof reconcile>[2],
): Promise<void> {
  const state = await getState(db);
  // Tick PROGRESS stamp (liveness/progress split, migration 0033): started
  // here, completed at the end. The web derives the amber tick_stalled state
  // (heartbeat fresh, tick >5 min without completing) from this pair —
  // liveness itself is the independent index.ts timer.
  await markTickStarted(db);
  await reconcile(db, engine, reconcileOptions); // always reconcile, even when paused
  await retentionTick(db, engine);
  let inFlightJobs = await inFlight(db);
  // Disk pressure blocks admission only. Reconciliation, partial ingestion,
  // retention and heartbeat progress above remain live so the system can
  // recover automatically instead of turning storage pressure into fake job
  // failures or a PostgreSQL outage.
  let diskAdmission = await refreshDiskAdmission(db, engine, inFlightJobs);
  await remoteSolverTick(db, engine, diskAdmission.allowed);
  const afterRemoteInFlight = await inFlight(db);
  if (afterRemoteInFlight !== inFlightJobs) {
    inFlightJobs = afterRemoteInFlight;
    diskAdmission = await refreshDiskAdmission(db, engine, inFlightJobs);
  }
  if (
    state.enabled &&
    diskAdmission.allowed &&
    inFlightJobs < state.maxConcurrentJobs
  ) {
    // Engine-down backoff (§7): check the cached engine probe before composing.
    if (!engineBackoffActive()) {
      let healthy = false;
      try {
        healthy = await engine.health();
      } catch {
        healthy = false;
      }
      if (!healthy) {
        await recordEngineUnreachable(db);
      } else {
        await clearEngineUnreachable(db);
        const meshRecoveryVersion = await prepareAutomaticMeshRecovery(
          db,
          engine,
        );
        // A recorded whole-polar promotion and an exact targeted RANS
        // rejection are both normal automatic escalation work. They receive
        // the next free slot ahead of a new RANS batch; this does not preempt
        // running work and keeps the lower-priority admin/verify ladder below
        // ordinary RANS.
        const promotedSubmitted =
          meshRecoveryVersion == null
            ? false
            : await submitRecordedPromotionRecovery(
                db,
                engine,
                state.cpuSlots,
                { meshRecoveryVersion },
              );
        const targetedSubmitted =
          promotedSubmitted || meshRecoveryVersion == null
            ? false
            : await submitCampaignPrecalcRecoveries(
                db,
                engine,
                undefined,
                undefined,
                meshRecoveryVersion,
              );
        const ransSubmitted =
          promotedSubmitted || targetedSubmitted
            ? false
            : await submitOneBatch(db, engine, state.cpuSlots);
        // Admin-request PRECALC and verification remain below newly composed
        // RANS work. Exact campaign recovery was handled above because it is
        // the normal continuation of an already-rejected RANS attempt.
        if (
          !promotedSubmitted &&
          !targetedSubmitted &&
          !ransSubmitted &&
          (await inFlight(db)) < state.maxConcurrentJobs
        ) {
          await uransLadderTick(db, engine, state.cpuSlots, {
            meshRecoveryVersion,
          });
        }
      }
    }
  }
  await markTickCompleted(db);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

export async function runLoop(
  db: DB,
  engine: EngineClient,
  signal: AbortSignal,
): Promise<void> {
  await resetOrphans(db);
  while (!signal.aborted) {
    try {
      await tick(db, engine);
    } catch (e) {
      console.error("[sweeper] tick error:", e);
    }
    const { pollIntervalMs } = await getState(db);
    await delay(pollIntervalMs, signal);
  }
}
