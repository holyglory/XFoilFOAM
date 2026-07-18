import {
  airfoils,
  type CampaignGapBatch,
  compareScheduleCandidates,
  type DB,
  enforceSweeperAdmissionFence,
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
  submitInterleavedVerifyIfDue,
  submitRecordedPromotionRecovery,
  uransLadderTick,
} from "./urans-ladder";
import {
  clearEngineUnreachable,
  engineBackoffActive,
  recordEngineUnreachable,
} from "./engine-backoff";
import {
  engineMeshRecoveryVersion,
  engineUransRecoveryVersion,
} from "./engine-capabilities";
import { requireExecutionPoolForSetup } from "./engine-pool";
import { type ContinuousBatch, findGaps, firstBatch } from "./gaps";
import {
  markTickCompleted,
  markTickStarted,
  touchHeartbeat,
} from "./heartbeat";
import { prepareAutomaticMeshRecovery } from "./mesh-recovery";
import { reconcile, resetOrphans } from "./reconcile";
import {
  admitRemoteSolverTick,
  reconcileRemoteSolverTick,
  type RemoteEngineAdmissionDecision,
} from "./remote-solver";
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

interface AdmissionFenceGate {
  blocked: boolean;
  guardFailed: boolean;
  hazardPresent: boolean;
}

/** Typed NEW-remote admission precedence. Safety provenance must survive even
 * when disk pressure is also present, and a successful FAST handoff consumes
 * the only admission opportunity before any mirrored RANS can be considered. */
export function remoteAdmissionDecisionForTick(input: {
  admissionFenced: boolean;
  diskAllowed: boolean;
  fastUransSubmitted: boolean;
  sharedCapacityAvailable: boolean;
  engineHealthy: boolean;
  meshRecoveryVersion: number | null;
}): RemoteEngineAdmissionDecision {
  if (input.admissionFenced) return { kind: "hold", reason: "safety_stop" };
  if (!input.diskAllowed) return { kind: "hold", reason: "storage_pressure" };
  if (input.fastUransSubmitted)
    return { kind: "hold", reason: "higher_priority_fast_urans" };
  if (!input.sharedCapacityAvailable)
    return { kind: "hold", reason: "shared_capacity_full" };
  if (!input.engineHealthy)
    return { kind: "hold", reason: "engine_unavailable" };
  if (input.meshRecoveryVersion == null)
    return { kind: "hold", reason: "mesh_capability_unknown" };
  return {
    kind: "allow",
    meshRecoveryVersion: input.meshRecoveryVersion,
  };
}

/**
 * The breaker is fail-closed for NEW admission only. A detector error must not
 * stop reconciliation, ingestion, retention, or already-running OpenFOAM
 * work, but it also must not become a window in which another job is admitted.
 */
async function checkAdmissionFence(
  db: DB,
  phase: "before_reconcile" | "after_reconcile" | "after_mesh_remediation",
): Promise<AdmissionFenceGate> {
  try {
    const result = await enforceSweeperAdmissionFence(db);
    if (result.fencedNow) {
      console.error(
        `[sweeper] NEW admission fenced after ${result.trigger?.reason ?? "critical solver outcome"}` +
          ` (${result.trigger?.triggerKey ?? "unknown trigger"}, ${phase}); running jobs continue`,
      );
    }
    return {
      blocked: result.active || result.hazardPresent,
      guardFailed: false,
      hazardPresent: result.hazardPresent,
    };
  } catch (error) {
    console.error(
      `[sweeper] admission-fence check failed (${phase}); holding new submissions:`,
      error,
    );
    return { blocked: true, guardFailed: true, hazardPresent: false };
  }
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
    admissionLane: "local",
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
  meshRecoveryVersion: number,
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
  request.expected_mesh_recovery_version = meshRecoveryVersion;

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
          meshRecoveryVersion,
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
  meshRecoveryVersion: number,
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
    meshRecoveryVersion,
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
  meshRecoveryVersion = 0,
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
  request.expected_mesh_recovery_version = meshRecoveryVersion;
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
          meshRecoveryVersion,
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
            meshRecoveryVersion,
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
  meshRecoveryVersion: number | null = 0,
): Promise<boolean> {
  // A malformed/unknown capability must never be coerced to legacy v0 at the
  // physical RANS boundary. Otherwise due FAST URANS is skipped while new
  // screening work consumes its capacity slot.
  if (meshRecoveryVersion == null) return false;
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
    ? submitCampaignBatch(
        db,
        engine,
        campaign as CampaignGapBatch,
        cpuSlots,
        undefined,
        meshRecoveryVersion,
      )
    : submitContinuousBatch(
        db,
        engine,
        continuous as ContinuousBatch,
        cpuSlots,
        meshRecoveryVersion,
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
  const preReconcileFence = await checkAdmissionFence(db, "before_reconcile");
  await reconcile(db, engine, reconcileOptions); // always reconcile, even when paused
  // Reconciliation can be the operation which records a blocked obligation or
  // critical incident. Re-check before any local or remote admission in this
  // same tick; waiting for the next poll would admit one job past the fence.
  const postReconcileFence = await checkAdmissionFence(db, "after_reconcile");
  await retentionTick(db, engine);
  let admissionFenced = preReconcileFence.blocked || postReconcileFence.blocked;
  const admissionFenceGuardFailed =
    preReconcileFence.guardFailed || postReconcileFence.guardFailed;
  let inFlightJobs = await inFlight(db);
  // Disk pressure blocks admission only. Reconciliation, partial ingestion,
  // retention and heartbeat progress above remain live so the system can
  // recover automatically instead of turning storage pressure into fake job
  // failures or a PostgreSQL outage.
  let diskAdmission = await refreshDiskAdmission(db, engine, inFlightJobs);
  // Remote authority/evidence reconciliation remains early and admission-free.
  // Its NEW RANS lane is considered only after durable FAST URANS below.
  const remoteAdmissionReady = await reconcileRemoteSolverTick(db, engine);
  // Dedicated remote-solver instances intentionally leave the local scheduler
  // disabled and use their independent remote CPU budget. In mixed mode,
  // mirrored RANS shares the visible local capacity and must wait rather than
  // queueing ahead of FAST URANS while every slot is occupied.
  const sharedRemoteCapacityAvailable =
    !state.enabled || inFlightJobs < state.maxConcurrentJobs;
  const localCapacityOpen =
    state.enabled &&
    !admissionFenced &&
    diskAdmission.allowed &&
    inFlightJobs < state.maxConcurrentJobs;
  const anyNewAdmissionEligible =
    !admissionFenced &&
    diskAdmission.allowed &&
    (localCapacityOpen || remoteAdmissionReady);

  let engineHealthy = false;
  let meshRecoveryVersion: number | null = null;
  let uransRecoveryVersion: number | null = null;
  let fastUransSubmitted = false;

  // One capability/health decision owns every local-engine NEW lane, including
  // work mirrored from an upstream hub. Unknown capability is never v0.
  // A latched safety stop closes only NEW work. Reconciliation above may have
  // just persisted a deterministic mesh blocker from an older engine
  // strategy, so capability discovery and the bounded versioned ledger
  // transition must remain live behind the fence. That transition is not an
  // admission: this tick remains fenced even when it successfully reopens the
  // exact blocker, and only a later explicit Resume may submit it.
  const fencedMeshRemediationDue =
    !admissionFenceGuardFailed &&
    (preReconcileFence.hazardPresent || postReconcileFence.hazardPresent);
  if (
    (anyNewAdmissionEligible || fencedMeshRemediationDue) &&
    !engineBackoffActive()
  ) {
    try {
      engineHealthy = await engine.health();
    } catch {
      engineHealthy = false;
    }
    if (!engineHealthy) {
      await recordEngineUnreachable(db);
    } else {
      await clearEngineUnreachable(db);
      meshRecoveryVersion =
        localCapacityOpen || fencedMeshRemediationDue
          ? await prepareAutomaticMeshRecovery(db, engine)
          : await engineMeshRecoveryVersion(engine);
      if (fencedMeshRemediationDue) {
        // The latch is deliberately not cleared by remediation. Re-read the
        // guard after the durable transition so a concurrent or unrelated
        // critical outcome is retained as current provenance; either way the
        // pre/post gates above make this entire tick admission-free.
        const postRemediationFence = await checkAdmissionFence(
          db,
          "after_mesh_remediation",
        );
        admissionFenced =
          admissionFenced ||
          postRemediationFence.blocked ||
          postRemediationFence.guardFailed;
      }
      if (meshRecoveryVersion == null) {
        console.error(
          "[sweeper] NEW admission deferred: engine mesh-recovery capability is unavailable or malformed; FAST URANS, remote RANS, and ordinary RANS remain queued",
        );
      } else if (localCapacityOpen) {
        uransRecoveryVersion = await engineUransRecoveryVersion(engine);
        // A recorded whole-polar promotion and an exact targeted RANS
        // rejection are normal automatic escalation work. Both strictly own
        // the slot before mirrored remote RANS or any other new RANS lane.
        const promotedSubmitted = await submitRecordedPromotionRecovery(
          db,
          engine,
          state.cpuSlots,
          { meshRecoveryVersion, uransRecoveryVersion },
        );
        const targetedSubmitted = promotedSubmitted
          ? false
          : await submitCampaignPrecalcRecoveries(
              db,
              engine,
              undefined,
              undefined,
              meshRecoveryVersion,
              uransRecoveryVersion,
            );
        fastUransSubmitted = promotedSubmitted || targetedSubmitted;
      }
    }
  }

  let remoteAdmissionConsumed = false;
  if (remoteAdmissionReady) {
    const decision = remoteAdmissionDecisionForTick({
      admissionFenced,
      diskAllowed: diskAdmission.allowed,
      fastUransSubmitted,
      sharedCapacityAvailable: sharedRemoteCapacityAvailable,
      engineHealthy,
      meshRecoveryVersion,
    });
    remoteAdmissionConsumed = await admitRemoteSolverTick(db, engine, decision);
    if (remoteAdmissionConsumed) {
      inFlightJobs = await inFlight(db);
      diskAdmission = await refreshDiskAdmission(db, engine, inFlightJobs);
    }
  }

  // Lower lanes run only when neither FAST nor remote admission consumed this
  // tick. Recheck the shared backoff because a remote submit attempt may have
  // discovered a connection failure after the successful health probe.
  if (
    localCapacityOpen &&
    engineHealthy &&
    meshRecoveryVersion != null &&
    !fastUransSubmitted &&
    !remoteAdmissionConsumed &&
    !engineBackoffActive()
  ) {
    // Once higher-priority FAST and remote work are quiet, durable DB history
    // gives one pending final verification the next eligible slot after at
    // most eight newly admitted wave-1 RANS jobs; restart cannot reset it.
    const interleavedVerifySubmitted = await submitInterleavedVerifyIfDue(
      db,
      engine,
      state.cpuSlots,
      { uransRecoveryVersion },
    );
    const ransSubmitted = interleavedVerifySubmitted
      ? false
      : await submitOneBatch(db, engine, state.cpuSlots, meshRecoveryVersion);
    // Admin-request PRECALC and the ordinary verify fallback remain below newly
    // composed RANS work. Campaign FAST and bounded final verification ran above.
    if (
      !interleavedVerifySubmitted &&
      !ransSubmitted &&
      (await inFlight(db)) < state.maxConcurrentJobs
    ) {
      await uransLadderTick(db, engine, state.cpuSlots, {
        meshRecoveryVersion,
        uransRecoveryVersion,
      });
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
