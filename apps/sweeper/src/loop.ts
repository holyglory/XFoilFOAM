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
  type SimulationSetupSnapshot,
} from "@aerodb/db/simulation-setup";
import type { EngineClient } from "@aerodb/engine-client";
import { count, eq, inArray, sql } from "drizzle-orm";

import { buildPolarRequest } from "./build-request";
import { claimAoas } from "./claim";
import { uransLadderTick } from "./urans-ladder";
import {
  clearEngineUnreachable,
  engineBackoffActive,
  isEngineConnectionFailure,
  recordEngineUnreachable,
} from "./engine-backoff";
import { type ContinuousBatch, findGaps, firstBatch } from "./gaps";
import { markTickCompleted, markTickStarted, touchHeartbeat } from "./heartbeat";
import { reconcile, resetOrphans } from "./reconcile";
import { remoteSolverTick } from "./remote-solver";
import { retentionTick } from "./retention";

interface SweeperConfig {
  enabled: boolean;
  maxConcurrentJobs: number;
  cpuSlots: number;
  pollIntervalMs: number;
  submitIntervalMs: number;
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
    maxConcurrentJobs: s?.maxConcurrentJobs ?? 2,
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

/** Release a composed job whose submit hit a connection failure: results back
 *  to pending, job cancelled (never `failed` — that is reserved for jobs the
 *  engine actually rejected/ran), engine backoff recorded. */
async function releaseUnsubmittedJob(db: DB, jobId: string, message: string): Promise<void> {
  await db.update(results).set({ status: "pending", simJobId: null }).where(eq(results.simJobId, jobId));
  await db
    .update(simJobs)
    .set({ status: "cancelled", error: message, finishedAt: new Date() })
    .where(eq(simJobs.id, jobId));
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
): Promise<boolean> {
  const suffix = context ? `, ${context}` : "";
  try {
    const status = await engine.submitPolar(request);
    await db
      .update(simJobs)
      .set({
        status: "submitted",
        engineJobId: status.job_id,
        submittedAt: new Date(),
        engineState: status.state,
        totalCases: status.total_cases,
      })
      .where(eq(simJobs.id, jobId));
    await clearEngineUnreachable(db);
    console.log(`[sweeper] job submitted → engine ${status.job_id} (sim_job ${jobId}${suffix})`);
    return true;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (isEngineConnectionFailure(e)) {
      // Engine-down backoff (spec §7): do NOT mark the job failed.
      console.error(`[sweeper] job submit RELEASED — engine unreachable (sim_job ${jobId}${suffix}): ${message}`);
      await releaseUnsubmittedJob(db, jobId, "engine unreachable at submit: " + message);
      await recordEngineUnreachable(db);
      return false;
    }
    console.error(`[sweeper] job submit FAILED (sim_job ${jobId}${suffix}): ${message}`);
    await db.update(results).set({ status: "pending", simJobId: null }).where(eq(results.simJobId, jobId));
    await db.update(simJobs).set({ status: "failed", error: "submit failed: " + message }).where(eq(simJobs.id, jobId));
    return false;
  }
}

async function submitContinuousBatch(
  db: DB,
  engine: EngineClient,
  batch: ContinuousBatch,
  queuePressure: number,
  cpuSlots: number,
): Promise<boolean> {
  const [a] = await db.select().from(airfoils).where(eq(airfoils.id, batch.airfoilId)).limit(1);
  const setup = await ensureSimulationPresetRevision(db, batch.presetId);
  if (!a || !setup) return false;
  const bcId = setup.snapshot.preset.legacyBoundaryConditionId ?? batch.bcId;

  const { request, speed } = buildPolarRequest({ airfoil: a, setup: setup.snapshot, aoaList: batch.aoas, wave: 1, queuePressure, cpuSlots });

  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId: a.id,
      bcIds: [bcId],
      simulationPresetRevisionId: setup.revision.id,
      referenceChordM: setup.snapshot.referenceGeometry.referenceLengthM,
      wave: 1,
      status: "pending",
      totalCases: batch.aoas.length,
      requestPayload: {
        speedMap: [{ speed, bcId, presetRevisionId: setup.revision.id, mach: setup.snapshot.flowState.mach }],
        aoas: batch.aoas,
        resources: request.resources,
        setupSnapshot: setup.snapshot,
      },
    })
    .returning({ id: simJobs.id });

  const claimed = await claimAoas(db, a.id, bcId, setup.revision.id, batch.aoas, job.id);
  if (claimed.length === 0) {
    await db.update(simJobs).set({ status: "cancelled" }).where(eq(simJobs.id, job.id));
    return false;
  }
  request.aoa = { angles: claimed };
  return submitComposedJob(db, engine, job.id, request, `continuous, airfoil ${a.id}, angles [${claimed.join(", ")}]`);
}

interface ResolvedCampaignEntry {
  conditionId: string;
  revisionId: string;
  presetId: string;
  speed: number;
  reynolds: number;
  bcId: string;
  snapshot: SimulationSetupSnapshot;
}

/** Resolve each batch entry's bcId exactly like the existing claim path —
 *  snapshot legacy id first, live preset row fallback (launch runs
 *  syncLegacyBoundaryConditionForPreset before any points). Entries with no
 *  resolvable bc are skipped with a loud log (results.bcId is NOT NULL). */
async function resolveCampaignEntries(db: DB, batch: CampaignGapBatch): Promise<ResolvedCampaignEntry[]> {
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
        .select({ legacyBoundaryConditionId: simulationPresets.legacyBoundaryConditionId })
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
    speedMap: entries.map((e) => ({ speed: e.speed, bcId: e.bcId, presetRevisionId: e.revisionId, mach: e.snapshot.flowState.mach })),
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
  queuePressure: number,
  cpuSlots: number,
): Promise<boolean> {
  const [a] = await db.select().from(airfoils).where(eq(airfoils.id, batch.airfoilId)).limit(1);
  if (!a) return false;
  const entries = await resolveCampaignEntries(db, batch);
  if (!entries.length) return false;
  // Min-Re entry = compat anchor: job revision, physics snapshot, chord.
  const anchor = entries[0];
  const snapshot = anchor.snapshot;

  const { request } = buildPolarRequest({
    airfoil: a,
    setup: snapshot,
    aoaList: batch.angles,
    wave: 1,
    queuePressure,
    cpuSlots,
    speeds: entries.map((e) => e.speed),
  });
  const totalCases = entries.length * batch.angles.length;
  const jobKind = totalCases <= 3 ? "targeted" : "sweep";

  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId: a.id,
      bcIds: [...new Set(entries.map((e) => e.bcId))],
      simulationPresetRevisionId: anchor.revisionId,
      campaignId: batch.campaignId,
      jobKind,
      referenceChordM: snapshot.referenceGeometry.referenceLengthM,
      wave: 1,
      status: "pending",
      totalCases,
      requestPayload: campaignJobPayload(batch, entries, batch.angles, jobKind, request.resources, snapshot),
    })
    .returning({ id: simJobs.id });

  // Claim per entry (its revisionId + bcId). Entries whose points all got
  // claimed elsewhere between selection and claim drop out of the job.
  const claimedUnion = new Set<number>();
  const activeEntries: ResolvedCampaignEntry[] = [];
  for (const entry of entries) {
    // Invariant: no code path may run >30 s without a heartbeat touch — each
    // claim is an UPDATE over up to 500 result rows and can crawl under load.
    await touchHeartbeat(db);
    const claimed = await claimAoas(db, a.id, entry.bcId, entry.revisionId, batch.angles, job.id);
    if (claimed.length === 0) continue;
    for (const aoa of claimed) claimedUnion.add(aoa);
    activeEntries.push(entry);
  }
  if (claimedUnion.size === 0 || activeEntries.length === 0) {
    await db.update(simJobs).set({ status: "cancelled" }).where(eq(simJobs.id, job.id));
    return false;
  }
  // Campaign claims stamp results.priority = GREATEST(existing, campaign band)
  // across ALL entries' claimed rows.
  await db
    .update(results)
    .set({ priority: sql`GREATEST(${results.priority}, ${batch.effectivePriority})` })
    .where(eq(results.simJobId, job.id));

  const claimedAoas = [...claimedUnion].sort((x, y) => x - y);
  const finalTotal = activeEntries.length * claimedAoas.length;
  const finalKind = finalTotal <= 3 ? "targeted" : "sweep";
  if (finalKind !== jobKind || finalTotal !== totalCases || activeEntries.length !== entries.length) {
    await db
      .update(simJobs)
      .set({
        jobKind: finalKind,
        totalCases: finalTotal,
        bcIds: [...new Set(activeEntries.map((e) => e.bcId))],
        requestPayload: campaignJobPayload(batch, activeEntries, claimedAoas, finalKind, request.resources, snapshot),
      })
      .where(eq(simJobs.id, job.id));
  }
  request.speeds = activeEntries.map((e) => e.speed);
  request.aoa = { angles: claimedAoas };
  return submitComposedJob(
    db,
    engine,
    job.id,
    request,
    `campaign ${batch.campaignId}, airfoil ${a.id}, ${activeEntries.length} condition(s), angles [${claimedAoas.join(", ")}]`,
  );
}

/** ONE winner per tick across the continuous + campaign branches under the one
 *  total order: effectivePriority DESC, reynolds ASC, slug ASC, aoa ASC (§7). */
export async function submitOneBatch(db: DB, engine: EngineClient, cpuSlots = 0): Promise<boolean> {
  await ensureEnabledSimulationPresetRevisions(db);
  const gaps = await findGaps(db, 500);
  const continuous = firstBatch(gaps);
  const campaign = await findCampaignGapBatch(db, { limit: 500 });
  // Invariant: no code path may run >30 s without a heartbeat touch — the two
  // gap scans above are heavy queries at 10^5-point scale, and composing +
  // claiming + submitting the winner below adds more DB/engine round-trips.
  await touchHeartbeat(db);
  if (!continuous && !campaign) return false;

  const continuousGroups = new Set(gaps.map((g) => `${g.airfoilId}:${g.bcId}`)).size;
  const queuePressure = Math.max(0, continuousGroups + (campaign?.openGroupCount ?? 0) - 1 + (await inFlight(db)));

  let winner: "continuous" | "campaign";
  if (continuous && campaign) {
    winner =
      compareScheduleCandidates(
        { effectivePriority: campaign.effectivePriority, reynolds: campaign.reynolds, slug: campaign.slug, aoa: campaign.headAoa },
        { effectivePriority: continuous.effectivePriority, reynolds: continuous.reynolds, slug: continuous.slug, aoa: continuous.headAoa },
      ) < 0
        ? "campaign"
        : "continuous";
  } else {
    winner = campaign ? "campaign" : "continuous";
  }

  return winner === "campaign"
    ? submitCampaignBatch(db, engine, campaign as CampaignGapBatch, queuePressure, cpuSlots)
    : submitContinuousBatch(db, engine, continuous as ContinuousBatch, queuePressure, cpuSlots);
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
  await remoteSolverTick(db, engine);
  await retentionTick(db, engine);
  if (state.enabled && (await inFlight(db)) < state.maxConcurrentJobs) {
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
        const ransSubmitted = await submitOneBatch(db, engine, state.cpuSlots);
        // Fidelity ladder (contract 5): precalc-rank and verify work run ONLY
        // when the RANS branch submitted nothing this tick and capacity
        // remains — one existing priority scale, RANS always first.
        if (!ransSubmitted && (await inFlight(db)) < state.maxConcurrentJobs) {
          await uransLadderTick(db, engine, state.cpuSlots);
        }
      }
    }
  }
  await markTickCompleted(db);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

export async function runLoop(db: DB, engine: EngineClient, signal: AbortSignal): Promise<void> {
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
