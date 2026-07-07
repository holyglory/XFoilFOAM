// URANS fidelity-ladder tick (pinned contracts 4–6, spec: single existing
// priority scale — no second scale). Runs INSIDE the submit-capacity branch of
// the sweeper tick, and only when the RANS branch (submitOneBatch) submitted
// nothing this tick — so RANS work always outranks precalc-rank work by
// construction, and verify work additionally requires zero campaign
// RANS/precalc work machine-wide. At most ONE submission per tick (the same
// one-winner-per-tick discipline as the RANS branch).
//
// Tier 2 (precalc rank):
//   a) gated campaign wave-2 URANS retries — parents whose inline retry was
//      deferred because their campaign still had open RANS gaps;
//   b) admin request-URANS work items (contract 6).
// Tier 3 (global lowest): verify-queue items (contract 4) — one cell re-solved
//   at FULL fidelity; deltas recorded at ingest (reconcile settle path).

import {
  airfoils,
  campaignHasOpenRansGaps,
  type DB,
  hasOpenCampaignLadderWork,
  healOrphanedUransRequests,
  healOrphanedVerifyItems,
  nextPendingUransRequest,
  nextPendingVerifyItem,
  precalcSnapshotForVerifyItem,
  simCampaigns,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
  simUransRequests,
  simUransVerifyQueue,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { snapshotAoas } from "@aerodb/db/simulation-setup";
import type { EngineClient, UransFidelity } from "@aerodb/engine-client";
import { and, count, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";

import { buildPolarRequest } from "./build-request";
import { isEngineConnectionFailure, recordEngineUnreachable } from "./engine-backoff";
import { touchHeartbeat } from "./heartbeat";
import { submitUransRetryForJob } from "./reconcile";

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Parents whose gated retry was already re-attempted this process lifetime —
 *  a parent whose retry plan is empty must not be re-planned every tick
 *  forever. In-memory on purpose (a restart simply rescans; no payload
 *  mutation, no deadlock). Tests reset via resetUransLadderMemory(). */
const settledGatedParents = new Set<string>();

export function resetUransLadderMemory(): void {
  settledGatedParents.clear();
}

const GATED_PARENTS_PER_TICK = 3;

/** Tier-2a: re-attempt gated campaign wave-2 retries for campaigns whose RANS
 *  gaps have hit zero. Returns true when a submission happened. */
async function submitGatedCampaignRetries(db: DB, engine: EngineClient, campaignIds?: string[]): Promise<boolean> {
  const statusFilter = inArray(simCampaigns.status, ["active", "attention"]);
  const campaigns = await db
    .select({ id: simCampaigns.id })
    .from(simCampaigns)
    .where(campaignIds?.length ? and(statusFilter, inArray(simCampaigns.id, campaignIds)) : statusFilter);
  for (const campaign of campaigns) {
    if (await campaignHasOpenRansGaps(db, campaign.id)) continue;
    // STARVATION GUARD (adversarial review 2026-07-07): parents whose retry
    // plan is empty never grow a wave-2 child, so they never leave the
    // NOT-EXISTS filter. They MUST also be excluded from the SQL window —
    // skipping them only in memory left the finishedAt-ordered LIMIT window
    // permanently occupied by the first N no-retry parents, and parents
    // ranked past the window (typically the needs_urans ones, which finish
    // last because the gate stays closed until the final RANS gap) were never
    // fetched → precalc_open stuck > 0, campaign never completed. With the
    // exclusion the window slides forward every tick; a restart clears the
    // set and simply re-settles from the front at 3 parents/tick — bounded
    // progress, no re-block. MUST-CATCH: urans-ladder.test.ts starvation test.
    const settledIds = [...settledGatedParents];
    const parents = await db
      .select()
      .from(simJobs)
      .where(
        and(
          eq(simJobs.campaignId, campaign.id),
          eq(simJobs.wave, 1),
          inArray(simJobs.status, ["done", "failed"]),
          isNotNull(simJobs.ingestedAt),
          ...(settledIds.length ? [notInArray(simJobs.id, settledIds)] : []),
          // NOTE: the correlated column MUST be table-qualified by hand —
          // drizzle renders `${simJobs.id}` inside a sql`` fragment as
          // unqualified "id", which Postgres scope-resolves to the SUBQUERY's
          // own table (same defect class as the polar-cache force-history
          // correlation bug, 2026-07-05).
          sql`NOT EXISTS (
            SELECT 1 FROM sim_jobs child
            WHERE child.parent_job_id = "sim_jobs"."id" AND child.wave = 2
              AND child.status IN ('pending', 'submitted', 'running', 'ingesting', 'done')
          )`,
        ),
      )
      .orderBy(simJobs.finishedAt)
      .limit(GATED_PARENTS_PER_TICK);
    let attempted = 0;
    for (const parent of parents) {
      if (settledGatedParents.has(parent.id)) continue;
      if (attempted >= GATED_PARENTS_PER_TICK) break;
      attempted += 1;
      await touchHeartbeat(db);
      const [before] = await db
        .select({ n: count() })
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
      await submitUransRetryForJob(db, engine, parent);
      // The gate is open for this campaign, so the call ran to completion —
      // whether it submitted children or had nothing to retry, it is settled.
      settledGatedParents.add(parent.id);
      const [after] = await db
        .select({ n: count() })
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
      if (Number(after?.n ?? 0) > Number(before?.n ?? 0)) return true;
    }
  }
  return false;
}

interface ComposedTarget {
  airfoilId: string;
  revisionId: string;
  snapshot: SimulationSetupSnapshot;
  bcId: string;
}

/** Resolve airfoil + pinned revision snapshot + bc for a ladder job (snapshot
 *  legacy bc first, live preset fallback — the resolveCampaignEntries rule). */
async function resolveTarget(db: DB, airfoilId: string, revisionId: string): Promise<ComposedTarget | null> {
  const [revision] = await db.select().from(simulationPresetRevisions).where(eq(simulationPresetRevisions.id, revisionId)).limit(1);
  if (!revision) return null;
  const snapshot = revision.snapshot as unknown as SimulationSetupSnapshot;
  let bcId = snapshot.preset.legacyBoundaryConditionId ?? null;
  if (!bcId) {
    const [preset] = await db
      .select({ legacyBoundaryConditionId: simulationPresets.legacyBoundaryConditionId })
      .from(simulationPresets)
      .where(eq(simulationPresets.id, revision.presetId))
      .limit(1);
    bcId = preset?.legacyBoundaryConditionId ?? null;
  }
  if (!bcId) return null;
  return { airfoilId, revisionId, snapshot, bcId };
}

async function dbQueuePressure(db: DB): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(simJobs)
    .where(inArray(simJobs.status, ["pending", "submitted", "running", "ingesting"]));
  return Number(row?.n ?? 0);
}

/** Compose + submit one wave-2 URANS ladder job (admin request or verify
 *  item). NO claim flips: existing done rows keep their evidence — a failed
 *  ladder solve must never destroy previously-good coefficients; success
 *  overwrites via the natural-key upsert at ingest. */
async function submitLadderJob(
  db: DB,
  engine: EngineClient,
  opts: {
    target: ComposedTarget;
    aoas: number[];
    fidelity: UransFidelity;
    jobKind: "targeted" | "verify";
    campaignId?: string | null;
    payloadExtras: Record<string, unknown>;
    cpuSlots: number;
  },
): Promise<{ jobId: string; submitted: boolean; connectionFailure: boolean; error?: string }> {
  const { target, aoas, fidelity, jobKind, campaignId, payloadExtras, cpuSlots } = opts;
  const [a] = await db.select().from(airfoils).where(eq(airfoils.id, target.airfoilId)).limit(1);
  if (!a) return { jobId: "", submitted: false, connectionFailure: false, error: `airfoil ${target.airfoilId} not found` };
  const { request, speed } = buildPolarRequest({
    airfoil: a,
    setup: target.snapshot,
    aoaList: aoas,
    wave: 2,
    uransFidelity: fidelity,
    queuePressure: await dbQueuePressure(db),
    cpuSlots,
  });
  const [job] = await db
    .insert(simJobs)
    .values({
      airfoilId: a.id,
      bcIds: [target.bcId],
      simulationPresetRevisionId: target.revisionId,
      campaignId: campaignId ?? null,
      jobKind,
      referenceChordM: target.snapshot.referenceGeometry.referenceLengthM,
      wave: 2,
      status: "pending",
      totalCases: aoas.length,
      requestPayload: {
        speedMap: [{ speed, bcId: target.bcId, presetRevisionId: target.revisionId, mach: target.snapshot.flowState.mach }],
        aoas,
        uransFidelity: fidelity,
        resources: request.resources,
        setupSnapshot: target.snapshot,
        ...payloadExtras,
      },
    })
    .returning({ id: simJobs.id });
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
      .where(and(eq(simJobs.id, job.id), inArray(simJobs.status, ["pending", "submitted", "running", "ingesting"])));
    return { jobId: job.id, submitted: true, connectionFailure: false };
  } catch (e) {
    const message = errorMessage(e);
    const connectionFailure = isEngineConnectionFailure(e);
    await db
      .update(simJobs)
      .set({
        status: connectionFailure ? "cancelled" : "failed",
        error: (connectionFailure ? "engine unreachable at ladder submit: " : "ladder submit failed: ") + message,
        finishedAt: new Date(),
      })
      .where(eq(simJobs.id, job.id));
    if (connectionFailure) await recordEngineUnreachable(db);
    return { jobId: job.id, submitted: false, connectionFailure, error: message };
  }
}

/** Tier-2b: consume ONE pending admin request-URANS item (contract 6).
 *  aoaDeg NULL = whole polar (the pinned revision's sweep angle grid). */
async function consumeUransRequest(db: DB, engine: EngineClient, cpuSlots: number): Promise<boolean> {
  const request = await nextPendingUransRequest(db);
  if (!request) return false;
  const fidelity: UransFidelity = request.fidelity === "full" ? "full" : "precalc";
  const target = await resolveTarget(db, request.airfoilId, request.revisionId);
  if (!target) {
    console.error(`[sweeper] URANS request ${request.id} cancelled: revision ${request.revisionId} unresolvable (missing revision or bc)`);
    await db.update(simUransRequests).set({ state: "cancelled" }).where(eq(simUransRequests.id, request.id));
    return false;
  }
  const aoas = request.aoaDeg != null ? [request.aoaDeg] : snapshotAoas(target.snapshot);
  if (!aoas.length) {
    console.error(`[sweeper] URANS request ${request.id} cancelled: no angles derivable from the pinned revision sweep`);
    await db.update(simUransRequests).set({ state: "cancelled" }).where(eq(simUransRequests.id, request.id));
    return false;
  }
  const outcome = await submitLadderJob(db, engine, {
    target,
    aoas,
    fidelity,
    jobKind: "targeted",
    payloadExtras: { uransRequestId: request.id },
    cpuSlots,
  });
  if (outcome.submitted) {
    await db.update(simUransRequests).set({ state: "running", simJobId: outcome.jobId }).where(eq(simUransRequests.id, request.id));
    console.log(`[sweeper] URANS request ${request.id} submitted (${fidelity}, ${aoas.length} angle(s), job ${outcome.jobId})`);
    return true;
  }
  if (outcome.connectionFailure) return false; // stays pending; backoff recorded
  console.error(`[sweeper] URANS request ${request.id} cancelled: engine rejected the submit (${outcome.error})`);
  await db.update(simUransRequests).set({ state: "cancelled" }).where(eq(simUransRequests.id, request.id));
  return false;
}

/** Tier-3: consume ONE pending verify-queue item (contract 4) — ONLY when no
 *  campaign RANS/precalc work exists machine-wide (checked by the caller). */
async function consumeVerifyItem(db: DB, engine: EngineClient, cpuSlots: number): Promise<boolean> {
  const item = await nextPendingVerifyItem(db);
  if (!item) return false;
  const precalc = await precalcSnapshotForVerifyItem(db, item);
  if (!precalc) {
    // The precalc row is gone / no longer a done precalc solve (re-solved,
    // failed, or already verified) — the item is stale, not verifiable.
    console.error(`[sweeper] verify item ${item.id} cancelled: precalc result ${item.precalcResultId} is no longer a done urans_precalc row`);
    await db.update(simUransVerifyQueue).set({ state: "cancelled" }).where(eq(simUransVerifyQueue.id, item.id));
    return false;
  }
  const target = await resolveTarget(db, item.airfoilId, item.revisionId);
  if (!target) {
    console.error(`[sweeper] verify item ${item.id} cancelled: revision ${item.revisionId} unresolvable (missing revision or bc)`);
    await db.update(simUransVerifyQueue).set({ state: "cancelled" }).where(eq(simUransVerifyQueue.id, item.id));
    return false;
  }
  const outcome = await submitLadderJob(db, engine, {
    target,
    aoas: [item.aoaDeg],
    fidelity: "full",
    jobKind: "verify",
    campaignId: item.campaignId,
    payloadExtras: { verifyQueueItemId: item.id, verifyPrecalc: precalc },
    cpuSlots,
  });
  if (outcome.submitted) {
    await db.update(simUransVerifyQueue).set({ state: "running" }).where(eq(simUransVerifyQueue.id, item.id));
    console.log(`[sweeper] verify item ${item.id} submitted (aoa ${item.aoaDeg}, full fidelity, job ${outcome.jobId})`);
    return true;
  }
  if (outcome.connectionFailure) return false; // stays pending; backoff recorded
  console.error(`[sweeper] verify item ${item.id} cancelled: engine rejected the submit (${outcome.error})`);
  await db.update(simUransVerifyQueue).set({ state: "cancelled" }).where(eq(simUransVerifyQueue.id, item.id));
  return false;
}

/** One ladder pass: heal orphans, then submit AT MOST one piece of work in
 *  tier order (gated campaign retries → admin requests → verify queue). The
 *  caller (loop.tick) invokes this only when the RANS branch submitted nothing
 *  and in-flight capacity remains. Exported cpuSlots plumbed from
 *  sweeper_state like the RANS branch. */
export async function uransLadderTick(
  db: DB,
  engine: EngineClient,
  cpuSlots = 0,
  /** Test-harness scoping (shared dev DB): restrict the gated-retry scan to
   *  these campaigns. Production passes nothing (all campaigns). */
  opts: { campaignIds?: string[] } = {},
): Promise<boolean> {
  const healedItems = await healOrphanedVerifyItems(db);
  if (healedItems > 0) console.log(`[sweeper] verify queue: ${healedItems} orphaned running item(s) returned to pending`);
  const healedRequests = await healOrphanedUransRequests(db);
  if (healedRequests > 0) console.log(`[sweeper] URANS requests: ${healedRequests} orphaned running request(s) returned to pending`);

  if (await submitGatedCampaignRetries(db, engine, opts.campaignIds)) return true;
  if (await consumeUransRequest(db, engine, cpuSlots)) return true;
  // Verify tier is the GLOBAL LOWEST rank (contract 5): only when no campaign
  // RANS/precalc work exists machine-wide.
  if (await hasOpenCampaignLadderWork(db)) return false;
  return consumeVerifyItem(db, engine, cpuSlots);
}
