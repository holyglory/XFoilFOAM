import {
  airfoils,
  type CampaignLaneKey,
  campaignHasOpenRansGaps,
  type DB,
  enqueuePrecalcVerifications,
  laneKeyId,
  laneTick,
  onResultIngested,
  probeCampaignCompletion,
  reconcileCampaigns,
  recomputeProgressForCampaign,
  refreshPolarCacheForRevision,
  results,
  simCampaignLanes,
  simCampaigns,
  simJobs,
  simulationPresetRevisions,
  simUransRequests,
  simUransVerifyQueue,
  sweeperState,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import {
  EngineError,
  URANS_VERIFY_DELTA_CD_LIMIT,
  URANS_VERIFY_DELTA_CL_LIMIT,
  WORKER_RESTART_ORPHAN_MESSAGE,
  classifyQueueLifecycle,
  engineQueueListsJob,
  type EngineClient,
  type EngineQueueState,
  type JobResult,
  type JobRuntimeSummary,
  type JobStatus,
  type UransFidelity,
} from "@aerodb/engine-client";
import { and, count, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";

import { buildPolarRequest } from "./build-request";
import { isEngineConnectionFailure, recordEngineUnreachable } from "./engine-backoff";
import { touchHeartbeat } from "./heartbeat";
import { type ConditionMapEntry, failedForPoint, ingestResult, retryFailedScaleRenders, type SpeedBc } from "./ingest";
import { ransRetryPlanForJobScoped } from "./retry-plan";

export { touchHeartbeat } from "./heartbeat";

const MISSING_JOB_REQUEUE_MS = Number(process.env.SWEEPER_MISSING_JOB_REQUEUE_MS ?? 10 * 60 * 1000);
type SimJobRow = typeof simJobs.$inferSelect;
interface ReconcileOptions {
  jobIds?: string[];
  recoverFailedJobIds?: string[];
  skipFailedRecovery?: boolean;
}

const activeJobStatuses: Array<"submitted" | "running" | "ingesting"> = ["submitted", "running", "ingesting"];

// Campaign maintenance state (spec §7/§8): lane keys marked dirty by the
// ingest hooks, drained at the end of every reconcile pass AFTER polar-fit
// refreshes, plus in-memory timers for the 60 s lane safety sweep and the
// low-frequency campaign reconciler.
const LANE_SAFETY_SWEEP_MS = 60_000;
const CAMPAIGN_RECONCILE_MS = 5 * 60_000;
// Failed shared-scale renders retry on this cadence (bounded per row by
// MAX_SCALE_RENDER_ATTEMPTS): spaced retries outlast the transient engine
// hiccups that a burst of immediate retries would just re-hit. The timer
// starts at module load (not 0) so the first pass runs one full interval
// after boot: recovery semantics are unchanged for the long-lived sweeper,
// and short-lived processes (tests) never fire it implicitly.
const SCALE_RENDER_RETRY_MS = 5 * 60_000;
const pendingDirtyLanes = new Map<string, CampaignLaneKey>();
let lastLaneSweepAt = 0;
let lastCampaignReconcileAt = 0;
let lastScaleRenderRetryAt = Date.now();

function collectDirtyLanes(keys: CampaignLaneKey[]): void {
  for (const key of keys) pendingDirtyLanes.set(laneKeyId(key), key);
}

function activeJobWhere(jobId: string) {
  return and(eq(simJobs.id, jobId), inArray(simJobs.status, activeJobStatuses));
}

/** Freshly composed jobs are `pending` until their submit lands: the
 *  post-submit stamp must match them too (activeJobWhere alone silently
 *  no-ops on a just-inserted wave-2 child, leaving it pending forever with no
 *  engineJobId), while still refusing to resurrect cancelled/failed rows. */
function submittableJobWhere(jobId: string) {
  return and(eq(simJobs.id, jobId), inArray(simJobs.status, ["pending", ...activeJobStatuses]));
}

function reconcilableJobWhere(jobId: string) {
  return and(eq(simJobs.id, jobId), inArray(simJobs.status, [...activeJobStatuses, "failed"]));
}

async function failJob(db: DB, jobId: string, msg: string): Promise<void> {
  // Failed evidence rows must carry WHY: without the error stamp the failures
  // endpoint classifies them 'unknown' (ERROR_CLASS_SQL treats NULL/'' as
  // unknown — incident 2026-07-04: 12 campaign points terminal-failed with
  // empty error). Callers guarantee msg is non-empty (nonEmptyFailureMessage).
  const failedRows = await db
    .update(results)
    .set({ status: "failed", source: "queued", error: msg })
    .where(and(eq(results.simJobId, jobId), inArray(results.status, ["queued", "running"])))
    .returning({
      id: results.id,
      airfoilId: results.airfoilId,
      simulationPresetRevisionId: results.simulationPresetRevisionId,
      aoaDeg: results.aoaDeg,
    });
  await db.update(simJobs).set({ status: "failed", error: msg, finishedAt: new Date() }).where(activeJobWhere(jobId));
  for (const row of failedRows) {
    collectDirtyLanes(
      await onResultIngested(db, {
        airfoilId: row.airfoilId,
        revisionId: row.simulationPresetRevisionId,
        aoaDeg: row.aoaDeg,
        resultId: row.id,
        status: "failed",
      }),
    );
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isNotFound(e: unknown): boolean {
  return e instanceof EngineError && e.status === 404;
}

function queueListsJob(queue: EngineQueueState, engineJobId: string): boolean {
  return (
    queue.job_ids.includes(engineJobId) ||
    [...queue.active, ...queue.reserved, ...queue.scheduled].some((task) => task.job_id === engineJobId)
  );
}

function queueTaskJobIds(queue: EngineQueueState): string[] {
  return [...queue.active, ...queue.reserved, ...queue.scheduled]
    .map((task) => task.job_id)
    .filter((id): id is string => Boolean(id));
}

async function engineQueueMentionsJob(engine: EngineClient, engineJobId: string): Promise<boolean | null> {
  try {
    return queueListsJob(await engine.getQueue(), engineJobId);
  } catch {
    return null;
  }
}

async function engineRuntimeMap(engine: EngineClient, jobIds: string[]): Promise<Map<string, JobRuntimeSummary>> {
  if (jobIds.length === 0 || typeof engine.getJobRuntimes !== "function") return new Map();
  try {
    const response = await engine.getJobRuntimes(jobIds);
    return new Map(response.jobs.map((job) => [job.job_id, job]));
  } catch {
    return new Map();
  }
}

function requestPayloadWithScheduling(job: SimJobRow, status: JobStatus): Record<string, unknown> {
  const payload = ((job.requestPayload ?? {}) as Record<string, unknown>) ?? {};
  return status.scheduling ? { ...payload, scheduling: status.scheduling } : payload;
}

function requestPayload(job: SimJobRow): Record<string, unknown> {
  return ((job.requestPayload ?? {}) as Record<string, unknown>) ?? {};
}

/** Batched campaign jobs carry a requestPayload conditionMap: one
 *  (condition, revision, bc, canonical speed) entry per bundled speed. Jobs
 *  without one keep the single-revision paths untouched. Every job→revision
 *  assumption in this module goes through this helper or releases claims by
 *  simJobId (which already spans all entries of a batched job). */
function conditionMapForJob(job: SimJobRow): ConditionMapEntry[] | null {
  const raw = (requestPayload(job) as { conditionMap?: ConditionMapEntry[] }).conditionMap;
  return Array.isArray(raw) && raw.length > 0 ? raw : null;
}

/** URANS fidelity tier a wave-2 job requested (requestPayload.uransFidelity),
 *  the honest fallback for points whose engine fidelity echo is missing. */
function uransFidelityForJob(job: SimJobRow): UransFidelity | undefined {
  const raw = (requestPayload(job) as { uransFidelity?: unknown }).uransFidelity;
  return raw === "precalc" || raw === "full" ? raw : undefined;
}

/** Ladder contract 4: after the polar-cache refresh classified a job's fresh
 *  rows, every ACCEPTED urans_precalc results row in the job's revisions owes
 *  a full-fidelity verification — enqueue idempotently (partial unique index).
 *  campaign_id rides along for phase derivation; continuous rows enqueue with
 *  NULL campaign. Loud, never silent on failure (the verify tier must not
 *  silently starve). */
async function enqueueVerificationsForJob(db: DB, job: SimJobRow): Promise<void> {
  const conditionMap = conditionMapForJob(job);
  const revisionIds = conditionMap
    ? [...new Set(conditionMap.map((entry) => entry.revisionId))]
    : job.simulationPresetRevisionId
      ? [job.simulationPresetRevisionId]
      : [];
  for (const revisionId of revisionIds) {
    try {
      const enqueued = await enqueuePrecalcVerifications(db, {
        airfoilId: job.airfoilId,
        revisionId,
        campaignId: job.campaignId,
      });
      if (enqueued > 0) {
        console.log(`[sweeper] verify queue: enqueued ${enqueued} precalc-accepted point(s) (job ${job.id}, revision ${revisionId})`);
      }
    } catch (e) {
      console.error(`[sweeper] verify-queue enqueue FAILED (job ${job.id}, revision ${revisionId}): ${errorMessage(e)}`);
    }
  }
}

interface VerifyJobPayload {
  verifyQueueItemId?: string;
  verifyPrecalc?: { cl?: number | null; cd?: number | null; cm?: number | null };
  uransRequestId?: string;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Settle fidelity-ladder bookkeeping after a job's terminal ingest:
 *  - verify jobs (payload.verifyQueueItemId): complete the queue item —
 *    record deltas vs the precalc snapshot captured at consume time, mark
 *    done, or DISAGREED when |ΔCl| > 0.05 or |ΔCd| > 0.01 (contract 4). The
 *    classification stays on the VERIFIED row (it IS the results row now);
 *    the disagreement is surfaced via a quality-warning marker on that row
 *    and the queue deltas — nothing silently swapped. A failed verify solve
 *    cancels the item loudly (the failure evidence lives on the results row).
 *  - admin request jobs (payload.uransRequestId): flip the request done. */
async function settleUransLadderForJob(db: DB, job: SimJobRow): Promise<void> {
  const payload = requestPayload(job) as VerifyJobPayload;
  if (payload.uransRequestId) {
    await db
      .update(simUransRequests)
      .set({ state: "done" })
      .where(and(eq(simUransRequests.id, payload.uransRequestId), eq(simUransRequests.state, "running")));
  }
  if (!payload.verifyQueueItemId) return;
  const [item] = await db.select().from(simUransVerifyQueue).where(eq(simUransVerifyQueue.id, payload.verifyQueueItemId)).limit(1);
  if (!item || (item.state !== "running" && item.state !== "pending")) return;
  const [verified] = await db
    .select({ id: results.id, status: results.status, fidelity: results.fidelity, cl: results.cl, cd: results.cd, cm: results.cm, qualityWarnings: results.qualityWarnings })
    .from(results)
    .where(and(eq(results.airfoilId, item.airfoilId), eq(results.simulationPresetRevisionId, item.revisionId), eq(results.aoaDeg, item.aoaDeg)))
    .limit(1);
  // The verified ROW is the judge, not the job verdict: a partially-failed
  // job whose verify angle still solved (done, full fidelity) completes the
  // item honestly; anything else cancels it loudly.
  const verifiedSolved = Boolean(verified && verified.status === "done" && verified.fidelity === "urans_full");
  if (!verifiedSolved || !verified) {
    console.error(
      `[sweeper] URANS verify solve did not complete (item ${item.id}, job ${job.id}, aoa ${item.aoaDeg}) — item cancelled; failure evidence stays on the results row`,
    );
    await db
      .update(simUransVerifyQueue)
      .set({ state: "cancelled", verifyResultId: verified?.id ?? null })
      .where(eq(simUransVerifyQueue.id, item.id));
    return;
  }
  const precalc = payload.verifyPrecalc ?? {};
  const deltaOf = (a: unknown, b: number | null): number | null => {
    const pa = finiteOrNull(a);
    return pa !== null && b !== null ? b - pa : null;
  };
  const deltaCl = deltaOf(precalc.cl, finiteOrNull(verified.cl));
  const deltaCd = deltaOf(precalc.cd, finiteOrNull(verified.cd));
  const deltaCm = deltaOf(precalc.cm, finiteOrNull(verified.cm));
  const disagreed =
    (deltaCl !== null && Math.abs(deltaCl) > URANS_VERIFY_DELTA_CL_LIMIT) ||
    (deltaCd !== null && Math.abs(deltaCd) > URANS_VERIFY_DELTA_CD_LIMIT);
  await db
    .update(simUransVerifyQueue)
    .set({
      state: disagreed ? "disagreed" : "done",
      verifyResultId: verified.id,
      deltaCl,
      deltaCd,
      deltaCm,
    })
    .where(eq(simUransVerifyQueue.id, item.id));
  if (disagreed) {
    const marker =
      `urans-verify-disagreement: full-fidelity verification differs from precalc beyond bounds ` +
      `(ΔCl=${deltaCl?.toFixed(4) ?? "n/a"}, ΔCd=${deltaCd?.toFixed(5) ?? "n/a"}; limits ${URANS_VERIFY_DELTA_CL_LIMIT}/${URANS_VERIFY_DELTA_CD_LIMIT}) — point flagged for review`;
    console.error(`[sweeper] ${marker} (item ${item.id}, result ${verified.id})`);
    const warnings = verified.qualityWarnings ?? [];
    if (!warnings.some((w) => w.startsWith("urans-verify-disagreement:"))) {
      await db
        .update(results)
        .set({ qualityWarnings: [...warnings, marker] })
        .where(eq(results.id, verified.id));
    }
  }
}

/** Refresh polar-fit caches for every revision a job touched: each
 *  conditionMap entry's revision for batched campaign jobs, the job's single
 *  revision otherwise (today's path, unchanged). */
async function refreshPolarCachesForJob(db: DB, job: SimJobRow): Promise<void> {
  const conditionMap = conditionMapForJob(job);
  if (conditionMap) {
    for (const revisionId of new Set(conditionMap.map((entry) => entry.revisionId))) {
      // Invariant: no code path may run >30 s without a heartbeat touch —
      // each revision refresh re-fits + re-classifies a whole lane and a
      // batched campaign job can span many revisions.
      await touchHeartbeat(db);
      await refreshPolarCacheForRevision(db, job.airfoilId, revisionId);
    }
    return;
  }
  if (job.simulationPresetRevisionId) {
    await refreshPolarCacheForRevision(db, job.airfoilId, job.simulationPresetRevisionId);
  }
}

async function setupSnapshotForJob(
  db: DB,
  job: SimJobRow,
): Promise<{ snapshot: SimulationSetupSnapshot; revisionId: string } | null> {
  const payload = requestPayload(job);
  if (payload.setupSnapshot && typeof payload.setupSnapshot === "object" && job.simulationPresetRevisionId) {
    return { snapshot: payload.setupSnapshot as SimulationSetupSnapshot, revisionId: job.simulationPresetRevisionId };
  }
  if (!job.simulationPresetRevisionId) return null;
  const [revision] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, job.simulationPresetRevisionId))
    .limit(1);
  if (!revision) return null;
  return { snapshot: revision.snapshot as unknown as SimulationSetupSnapshot, revisionId: revision.id };
}

/** Engine-side cancellation (G2, incident 2026-07-05): a job the ENGINE
 *  reports as `cancelled` is terminal — mark the sim_job cancelled and release
 *  its claimed results rows back to `pending` so the gap finders
 *  (findGaps/findCampaignGapBatch) re-claim the points on the next tick. This
 *  is the exact claim-release the node-side admin cancel route performs
 *  (apps/api/src/admin-routes.ts POST /api/admin/jobs/:id/cancel); before this
 *  helper existed, engine state `cancelled` fell through the status mapping to
 *  "running" and the sweeper polled the dead job forever. Never ingests
 *  coefficients — released rows stay coefficient-free until re-solved. */
async function cancelJobAndReleaseClaims(db: DB, job: SimJobRow, msg: string): Promise<void> {
  await db
    .update(results)
    .set({ status: "pending", source: "queued", simJobId: null, engineJobId: null, engineCaseSlug: null })
    .where(and(eq(results.simJobId, job.id), inArray(results.status, ["queued", "running"])));
  await db
    .update(simJobs)
    .set({ status: "cancelled", engineState: "cancelled", error: msg, finishedAt: new Date() })
    .where(reconcilableJobWhere(job.id));
}

/** Zombie auto-recovery (G3, incident 2026-07-05): 4 in-flight celery tasks
 *  died with a force-recreated worker, but the engine's persisted status store
 *  kept answering state=running (HTTP 200, active_pids: [], last_progress_at
 *  hours stale), so the sweeper polled them as "running" for ~2.3 h. Detect
 *  that shape and treat it as LOST: engine says running, but
 *    - the runtime probe finds ZERO OpenFOAM processes,
 *    - the worker runtime heartbeat is stale/absent (a live celery task
 *      refreshes it even while waiting for CPU tokens),
 *    - Celery does not list the task (queue evidence required — a null queue
 *      probe never condemns a job), and
 *    - last progress is older than the grace below.
 *  Returns the loud reason string, or null when the job must be left alone. */
function classifyLostRunning(
  job: SimJobRow,
  status: JobStatus,
  runtime: JobRuntimeSummary | null,
  queue: EngineQueueState | null,
  now = Date.now(),
): string | null {
  if (status.state !== "running") return null;
  if (!runtime || !runtime.exists || runtime.process_count > 0) return null;
  const heartbeatAlive =
    runtime.runtime_heartbeat_age_sec != null &&
    Number.isFinite(Number(runtime.runtime_heartbeat_age_sec)) &&
    Number(runtime.runtime_heartbeat_age_sec) <= 120;
  if (heartbeatAlive) return null;
  if (!queue || engineQueueListsJob(queue, job.engineJobId)) return null;
  const lastProgress =
    parseEngineDate(status.last_progress_at) ?? parseEngineDate(status.started_at) ?? parseEngineDate(status.queued_at);
  if (!lastProgress) return null;
  const quietMs = now - lastProgress.getTime();
  if (quietMs < LOST_RUNNING_GRACE_MS) return null;
  return (
    `engine reports running but no OpenFOAM process exists, the worker heartbeat is stale, Celery does not list the task, ` +
    // Honest cause set: this shape now also covers the engine's celery hard
    // time-limit kill (task_time_limit, 2026-07-07), where the pool child is
    // SIGKILLed without any worker restart — so the message must not assert a
    // restart it cannot prove.
    `and last progress was ${Math.round(quietMs / 60000)} min ago — task lost (worker process died, was hard-killed, or restarted mid-solve); cancelled and requeued`
  );
}

/** Grace before declaring an engine-"running" job lost. The engine bumps
 *  status last_progress_at ONLY when completed_cases increases or the job goes
 *  terminal (src/airfoilfoam/storage.py write_status), so a single long case
 *  (meshing + a URANS march can legitimately run 20+ min) shows no progress
 *  while perfectly healthy. 30 min comfortably exceeds those quiet gaps, and
 *  process liveness is the primary signal anyway: the lost path additionally
 *  requires process_count == 0, a stale worker heartbeat, and absence from
 *  Celery — a healthy quiet case fails all three of those guards. */
const LOST_RUNNING_GRACE_MS = Number(process.env.SWEEPER_LOST_RUNNING_GRACE_MS ?? 30 * 60 * 1000);

function parseEngineDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function updateJobFromEngineStatus(db: DB, job: SimJobRow, status: JobStatus): Promise<void> {
  if (status.state === "cancelled") {
    // G2 dispatch site 1 (status mapping): `cancelled` used to fall through
    // the ternary below to status "running".
    await cancelJobAndReleaseClaims(db, job, status.message ?? "engine reported job cancelled; claims released");
    return;
  }
  await db
    .update(simJobs)
    .set({
      engineState: status.state,
      completedCases: status.completed_cases,
      totalCases: status.total_cases,
      polledAt: new Date(),
      error: status.state === "failed" ? (status.message ?? job.error) : null,
      finishedAt: null,
      requestPayload: requestPayloadWithScheduling(job, status),
      status: status.state === "completed" ? "ingesting" : status.state === "failed" ? "ingesting" : status.state === "pending" ? "submitted" : "running",
    })
    .where(reconcilableJobWhere(job.id));
}

async function markIngestRetry(db: DB, jobId: string, e: unknown): Promise<void> {
  await db
    .update(simJobs)
    .set({
      status: "ingesting",
      engineState: "completed",
      error: "ingest retry pending: " + errorMessage(e),
      polledAt: new Date(),
      finishedAt: null,
    })
    .where(reconcilableJobWhere(jobId));
}

async function requeueLostJob(db: DB, job: SimJobRow, msg: string): Promise<void> {
  await db
    .update(results)
    .set({ status: "pending", source: "queued", simJobId: null, engineJobId: null, engineCaseSlug: null })
    .where(and(eq(results.simJobId, job.id), inArray(results.status, ["queued", "running", "pending", "stale", "failed"])));
  await db
    .update(simJobs)
    .set({ status: "cancelled", engineState: "missing", error: msg, finishedAt: new Date() })
    .where(reconcilableJobWhere(job.id));
}

async function markPollMiss(db: DB, job: SimJobRow, msg: string): Promise<void> {
  await db
    .update(simJobs)
    .set({ status: "running", engineState: "missing", error: msg, polledAt: new Date(), finishedAt: null })
    .where(activeJobWhere(job.id));
}

async function dbQueuePressure(db: DB): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(simJobs)
    .where(inArray(simJobs.status, ["pending", ...activeJobStatuses]));
  return Number(row?.n ?? 0);
}

async function cancelTerminalEngineTasks(db: DB, engine: EngineClient, queue: EngineQueueState, liveEngineJobIds: Set<string>): Promise<void> {
  const candidateIds = [...new Set(queueTaskJobIds(queue).filter((jobId) => !liveEngineJobIds.has(jobId)))];
  if (candidateIds.length === 0) return;

  const terminalRows = await db
    .select({ id: simJobs.id, engineJobId: simJobs.engineJobId, status: simJobs.status, error: simJobs.error })
    .from(simJobs)
    .where(and(inArray(simJobs.engineJobId, candidateIds), inArray(simJobs.status, ["done", "failed", "cancelled"])));

  for (const row of terminalRows) {
    if (!row.engineJobId) continue;
    // Invariant: no code path may run >30 s without a heartbeat touch — each
    // engine-side cancel is a round-trip that crawls when the worker is
    // saturated, and a restart can leave a batch of obsolete tasks.
    await touchHeartbeat(db);
    try {
      await engine.cancelJob(row.engineJobId);
      await db
        .update(simJobs)
        .set({
          engineState: "cancelled",
          error: row.error ?? `obsolete engine task cancelled after DB job reached ${row.status}`,
        })
        .where(eq(simJobs.id, row.id));
    } catch (e) {
      await db
        .update(simJobs)
        .set({
          error: `obsolete engine task cancel failed: ${errorMessage(e)}`,
        })
        .where(eq(simJobs.id, row.id));
    }
  }
}

export async function submitUransRetryForJob(db: DB, engine: EngineClient, parent: typeof simJobs.$inferSelect): Promise<void> {
  if (parent.wave !== 1 || parent.bcIds.length === 0 || !parent.simulationPresetRevisionId) return;
  // Fidelity ladder gate (contract 5): within a campaign, URANS (precalc)
  // work is gated until the campaign has ZERO open RANS gaps. Gated parents
  // are re-attempted by the sweeper's ladder tick once the gaps close.
  if (parent.campaignId && (await campaignHasOpenRansGaps(db, parent.campaignId))) {
    console.log(
      `[sweeper] URANS retry for job ${parent.id} deferred: campaign ${parent.campaignId} still has open RANS gaps (ladder gate)`,
    );
    return;
  }
  const conditionMap = conditionMapForJob(parent);
  if (conditionMap) {
    // Batched campaign parent: the retry plan is computed PER conditionMap
    // entry and each retrying condition gets its own single-revision child.
    await submitCampaignUransRetries(db, engine, parent, conditionMap);
    return;
  }
  const parentPayload = requestPayload(parent);
  const [existing] = await db
    .select({ id: simJobs.id })
    .from(simJobs)
    .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2), inArray(simJobs.status, ["pending", "submitted", "running", "ingesting", "done"])))
    .limit(1);
  if (existing) return;

  await refreshPolarCacheForRevision(db, parent.airfoilId, parent.simulationPresetRevisionId);
  // Retry scoping (ladder R2): TARGETED-ONLY — every retry re-solves only the
  // job's own rejected/needs_urans angles at 'precalc' fidelity; whole-polar
  // URANS is an explicit admin action, never an automatic escalation.
  const retry = await ransRetryPlanForJobScoped(db, {
    parentJobId: parent.id,
    airfoilId: parent.airfoilId,
    revisionId: parent.simulationPresetRevisionId,
    jobKind: parent.jobKind,
  });
  if (!retry || retry.aoas.length === 0) return;
  const aoas = retry.aoas;

  const [a] = await db.select().from(airfoils).where(eq(airfoils.id, parent.airfoilId)).limit(1);
  const setup = await setupSnapshotForJob(db, parent);
  if (!a || !setup) return;
  const bcId = setup.snapshot.preset.legacyBoundaryConditionId ?? parent.bcIds[0];

  const [capacity] = await db
    .select({ cpuSlots: sweeperState.cpuSlots })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  const { request, speed } = buildPolarRequest({
    airfoil: a,
    setup: setup.snapshot,
    aoaList: aoas,
    wave: 2,
    uransFidelity: "precalc",
    queuePressure: await dbQueuePressure(db),
    cpuSlots: capacity?.cpuSlots ?? 0,
  });
  const [job] = await db
    .insert(simJobs)
    .values({
      parentJobId: parent.id,
      airfoilId: a.id,
      bcIds: [bcId],
      simulationPresetRevisionId: setup.revisionId,
      campaignId: parent.campaignId,
      jobKind: "targeted",
      referenceChordM: setup.snapshot.referenceGeometry.referenceLengthM,
      wave: 2,
      status: "pending",
      totalCases: aoas.length,
      requestPayload: {
        syncPromiseId: parentPayload.syncPromiseId,
        speedMap: [{ speed, bcId, presetRevisionId: setup.revisionId, mach: setup.snapshot.flowState.mach }],
        aoas,
        parentJobId: parent.id,
        uransFidelity: "precalc",
        retryMode: retry.retryMode,
        validRansPointCount: retry.validRansPointCount,
        needsUransCount: retry.needsUransCount,
        hardRejectedCount: retry.hardRejectedCount,
        resources: request.resources,
        setupSnapshot: setup.snapshot,
      },
    })
    .returning({ id: simJobs.id });

  if (retry.queueCanonicalAoas.length) {
    // The stored classification must stay the AT-INGEST verdict (already
    // refreshed above, before the retry plan): flipping rows to queued and
    // re-refreshing here rewrote every retried point's classification to a
    // synthetic post-requeue "not-solved" snapshot, destroying the evidence
    // trail (prod row 741db07a). No refresh after this flip.
    await db
      .update(results)
      .set({ status: "queued", source: "queued", simJobId: job.id })
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.simulationPresetRevisionId, setup.revisionId),
          inArray(results.aoaDeg, retry.queueCanonicalAoas),
        ),
      );
  }

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
      .where(submittableJobWhere(job.id));
    console.log(
      `[sweeper] URANS retry submitted → engine ${status.job_id} (sim_job ${job.id}, parent ${parent.id}, campaign ${parent.campaignId ?? "-"}, airfoil ${parent.airfoilId}, precalc, angles [${aoas.join(", ")}])`,
    );
  } catch (e) {
    if (retry.queueCanonicalAoas.length) {
      await db
        .update(results)
        .set({ status: "pending", source: "queued", simJobId: null, engineJobId: null, engineCaseSlug: null })
        .where(
          and(
            eq(results.airfoilId, a.id),
            eq(results.simulationPresetRevisionId, setup.revisionId),
            inArray(results.aoaDeg, retry.queueCanonicalAoas),
            eq(results.simJobId, job.id),
          ),
        );
    }
    if (isEngineConnectionFailure(e)) {
      // Engine-down backoff (spec §7): connection failures release the
      // composed retry instead of burning a `failed` job.
      await db
        .update(simJobs)
        .set({ status: "cancelled", error: "engine unreachable at URANS submit: " + (e as Error).message, finishedAt: new Date() })
        .where(eq(simJobs.id, job.id));
      await recordEngineUnreachable(db);
      return;
    }
    await db
      .update(simJobs)
      .set({ status: "failed", error: "URANS submit failed: " + (e as Error).message, finishedAt: new Date() })
      .where(eq(simJobs.id, job.id));
  }
}

/** RANS→URANS wave-2 for batched campaign parents: retry plans are computed
 *  per conditionMap entry against that entry's revision-wide evidence (exactly
 *  the scoped rules of submitUransRetryForJob), and each retrying condition
 *  submits its own single-revision child job through the existing machinery.
 *  Children are deduped per (parent, conditionId). */
async function submitCampaignUransRetries(
  db: DB,
  engine: EngineClient,
  parent: SimJobRow,
  conditionMap: ConditionMapEntry[],
): Promise<void> {
  const parentPayload = requestPayload(parent);
  const children = await db
    .select({ id: simJobs.id, requestPayload: simJobs.requestPayload })
    .from(simJobs)
    .where(
      and(
        eq(simJobs.parentJobId, parent.id),
        eq(simJobs.wave, 2),
        inArray(simJobs.status, ["pending", "submitted", "running", "ingesting", "done"]),
      ),
    );
  const retriedConditionIds = new Set(
    children
      .map((child) => ((child.requestPayload ?? {}) as { conditionId?: string }).conditionId)
      .filter((id): id is string => Boolean(id)),
  );

  const [a] = await db.select().from(airfoils).where(eq(airfoils.id, parent.airfoilId)).limit(1);
  if (!a) return;
  const [capacity] = await db
    .select({ cpuSlots: sweeperState.cpuSlots })
    .from(sweeperState)
    .where(eq(sweeperState.id, 1))
    .limit(1);
  const revisionIds = [...new Set(conditionMap.map((entry) => entry.revisionId))];
  const revisions = await db
    .select()
    .from(simulationPresetRevisions)
    .where(inArray(simulationPresetRevisions.id, revisionIds));
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));

  for (const entry of conditionMap) {
    if (retriedConditionIds.has(entry.conditionId)) continue;
    const revision = revisionById.get(entry.revisionId);
    if (!revision) continue;
    // Invariant: no code path may run >30 s without a heartbeat touch. Each
    // retrying condition does a cache refresh + retry plan + engine submit.
    await touchHeartbeat(db);
    await refreshPolarCacheForRevision(db, parent.airfoilId, entry.revisionId);
    const retry = await ransRetryPlanForJobScoped(db, {
      parentJobId: parent.id,
      airfoilId: parent.airfoilId,
      revisionId: entry.revisionId,
      jobKind: parent.jobKind,
      attemptRevisionId: entry.revisionId,
    });
    if (!retry || retry.aoas.length === 0) continue;
    const snapshot = revision.snapshot as unknown as SimulationSetupSnapshot;
    const { request, speed } = buildPolarRequest({
      airfoil: a,
      setup: snapshot,
      aoaList: retry.aoas,
      wave: 2,
      uransFidelity: "precalc",
      queuePressure: await dbQueuePressure(db),
      cpuSlots: capacity?.cpuSlots ?? 0,
    });
    const [job] = await db
      .insert(simJobs)
      .values({
        parentJobId: parent.id,
        airfoilId: a.id,
        bcIds: [entry.bcId],
        simulationPresetRevisionId: entry.revisionId,
        campaignId: parent.campaignId,
        jobKind: "targeted",
        referenceChordM: snapshot.referenceGeometry.referenceLengthM,
        wave: 2,
        status: "pending",
        totalCases: retry.aoas.length,
        requestPayload: {
          syncPromiseId: parentPayload.syncPromiseId,
          speedMap: [{ speed, bcId: entry.bcId, presetRevisionId: entry.revisionId, mach: snapshot.flowState.mach }],
          aoas: retry.aoas,
          parentJobId: parent.id,
          conditionId: entry.conditionId,
          uransFidelity: "precalc",
          retryMode: retry.retryMode,
          validRansPointCount: retry.validRansPointCount,
          needsUransCount: retry.needsUransCount,
          hardRejectedCount: retry.hardRejectedCount,
          resources: request.resources,
          setupSnapshot: snapshot,
        },
      })
      .returning({ id: simJobs.id });

    if (retry.queueCanonicalAoas.length) {
      // Same at-ingest-verdict rule as the single-revision path: the cache was
      // refreshed BEFORE the retry plan; a post-flip refresh would overwrite
      // the stored classification with a post-requeue "not-solved" snapshot.
      await db
        .update(results)
        .set({ status: "queued", source: "queued", simJobId: job.id })
        .where(
          and(
            eq(results.airfoilId, a.id),
            eq(results.simulationPresetRevisionId, entry.revisionId),
            inArray(results.aoaDeg, retry.queueCanonicalAoas),
          ),
        );
    }

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
        .where(submittableJobWhere(job.id));
      console.log(
        `[sweeper] URANS retry submitted → engine ${status.job_id} (sim_job ${job.id}, parent ${parent.id}, campaign ${parent.campaignId ?? "-"}, airfoil ${parent.airfoilId}, condition ${entry.conditionId}, precalc, angles [${retry.aoas.join(", ")}])`,
      );
    } catch (e) {
      if (retry.queueCanonicalAoas.length) {
        await db
          .update(results)
          .set({ status: "pending", source: "queued", simJobId: null, engineJobId: null, engineCaseSlug: null })
          .where(
            and(
              eq(results.airfoilId, a.id),
              eq(results.simulationPresetRevisionId, entry.revisionId),
              inArray(results.aoaDeg, retry.queueCanonicalAoas),
              eq(results.simJobId, job.id),
            ),
          );
      }
      if (isEngineConnectionFailure(e)) {
        // Engine-down backoff (spec §7): release this child and stop composing
        // further children until the engine is reachable again.
        await db
          .update(simJobs)
          .set({ status: "cancelled", error: "engine unreachable at URANS submit: " + (e as Error).message, finishedAt: new Date() })
          .where(eq(simJobs.id, job.id));
        await recordEngineUnreachable(db);
        return;
      }
      await db
        .update(simJobs)
        .set({ status: "failed", error: "URANS submit failed: " + (e as Error).message, finishedAt: new Date() })
        .where(eq(simJobs.id, job.id));
    }
  }
}

/** Post-refresh campaign settlement: the ingest-time completion probe fires
 *  BEFORE the polar cache refresh classifies fresh rows (it blocks on those
 *  unjudged points), so after the refresh the campaign's counters must absorb
 *  the verdicts (rejected bucket) and the probe must run again to settle
 *  completed vs attention honestly. */
async function settleCampaignAfterRefresh(db: DB, job: SimJobRow): Promise<void> {
  if (!job.campaignId) return;
  try {
    await recomputeProgressForCampaign(db, job.campaignId);
    await probeCampaignCompletion(db, job.campaignId);
  } catch (e) {
    // Counters/probe hiccups (e.g. a recompute deadlock against the periodic
    // reconciler) must not fail an already-ingested job — the reconciler
    // heals counters and re-probes within its 5-minute sweep. Loud, never silent.
    console.error(`[sweeper] campaign settle failed (campaign ${job.campaignId}, job ${job.id}): ${errorMessage(e)}`);
  }
}

async function ingestCompletedJob(db: DB, engine: EngineClient, job: SimJobRow): Promise<void> {
  if (!job.engineJobId) return;
  const result = await engine.getResult(job.engineJobId);
  const speedMap = speedMapForJob(job);
  const ingested = await ingestResult({
    db,
    engine,
    engineJobId: job.engineJobId,
    simJobId: job.id,
    airfoilId: job.airfoilId,
    speedMap,
    conditionMap: conditionMapForJob(job) ?? undefined,
    uransFidelity: uransFidelityForJob(job),
    result,
  });
  collectDirtyLanes(ingested.dirtyLanes);
  await refreshPolarCachesForJob(db, job);
  // Fidelity ladder: fresh verdicts exist now — enqueue verifications for
  // accepted precalc rows and settle verify/request bookkeeping.
  await enqueueVerificationsForJob(db, job);
  await settleUransLadderForJob(db, job);
  await db
    .update(simJobs)
    .set({ status: "done", engineState: "completed", error: null, ingestedAt: new Date(), finishedAt: new Date() })
    .where(reconcilableJobWhere(job.id));
  await submitUransRetryForJob(db, engine, job);
  await settleCampaignAfterRefresh(db, job);
}

async function ingestRunningPartialJob(db: DB, engine: EngineClient, job: SimJobRow): Promise<boolean> {
  if (!job.engineJobId) return false;
  let result;
  try {
    result = await engine.getResult(job.engineJobId);
  } catch {
    return false;
  }
  if (result.state !== "running") return false;
  const ingested = await ingestResult({
    db,
    engine,
    engineJobId: job.engineJobId,
    simJobId: job.id,
    airfoilId: job.airfoilId,
    speedMap: speedMapForJob(job),
    conditionMap: conditionMapForJob(job) ?? undefined,
    uransFidelity: uransFidelityForJob(job),
    result,
  });
  collectDirtyLanes(ingested.dirtyLanes);
  if (ingested.points > 0) {
    await refreshPolarCachesForJob(db, job);
  }
  return ingested.points > 0 || ingested.media > 0;
}

function speedMapForJob(job: SimJobRow): SpeedBc[] {
  const rawSpeedMap = ((job.requestPayload as { speedMap?: SpeedBc[] } | null)?.speedMap ?? []) as SpeedBc[];
  return rawSpeedMap.map((row) => ({
    ...row,
    presetRevisionId: row.presetRevisionId ?? job.simulationPresetRevisionId ?? null,
  }));
}

/** Guarantee every failure message stamped onto evidence rows is non-empty:
 *  ERROR_CLASS_SQL (packages/db/src/campaigns.ts) buckets NULL/'' as
 *  'unknown', which is exactly how the 2026-07-04 worker-restart incident
 *  surfaced ("15 failed", errorClass unknown, no error text anywhere). */
function nonEmptyFailureMessage(job: SimJobRow, msg: string): string {
  return msg.trim() ? msg : `engine job failed without a message (job ${job.engineJobId ?? job.id})`;
}

/** Keep ONLY solved points of a partial result: worker-restart orphan ingest
 *  must preserve real solved evidence while every unreached/unsolved point is
 *  released for a re-solve — never ingested as failure evidence. Attempt rows
 *  survive unfiltered: they are historical solver attempts that genuinely
 *  happened before the restart (result_attempts evidence, not results rows). */
function solvedPointsOnly(result: JobResult): JobResult {
  return {
    ...result,
    polars: result.polars.map((polar) => ({ ...polar, points: polar.points.filter((p) => !failedForPoint(p)) })),
  };
}

/** Worker-restart orphan (incident 2026-07-04): the engine's worker-boot
 *  reconciliation (src/airfoilfoam/storage.py reconcile_orphans) marks jobs
 *  whose celery task died with a restarted worker container as state=failed
 *  with the pinned WORKER_RESTART_ORPHAN_MESSAGE. That is an infrastructure
 *  interruption, NOT solver failure evidence — before this branch existed the
 *  failed-job ingest terminal-failed 12 campaign points (+3 symmetry mirrors)
 *  with empty error text for points that were merely interrupted.
 *
 *  Truthful handling: solved cases present in the partial result.json are
 *  real evidence and ingest as done; every remaining claimed row is RELEASED
 *  back to pending (the cancelJobAndReleaseClaims claim-release semantics, so
 *  the gap finders re-claim the points next tick) and the sim_job terminates
 *  'cancelled'. NOTHING is marked failed, so campaign points never
 *  terminal-fail on a restart. No URANS retry is submitted here: retry plans
 *  read revision-wide classifications, where just-released unsolved rows
 *  snapshot as 'rejected' until re-solved — deciding now could escalate
 *  interrupted points to whole-polar URANS; the follow-up re-solve job runs
 *  the same revision-wide retry pass on real evidence instead. */
async function releaseWorkerRestartOrphan(db: DB, engine: EngineClient, job: SimJobRow): Promise<void> {
  let solvedPoints = 0;
  if (job.engineJobId) {
    try {
      const result = await engine.getResult(job.engineJobId);
      const ingested = await ingestResult({
        db,
        engine,
        engineJobId: job.engineJobId,
        simJobId: job.id,
        airfoilId: job.airfoilId,
        speedMap: speedMapForJob(job),
        conditionMap: conditionMapForJob(job) ?? undefined,
        uransFidelity: uransFidelityForJob(job),
        result: solvedPointsOnly(result),
      });
      collectDirtyLanes(ingested.dirtyLanes);
      solvedPoints = ingested.points;
    } catch (e) {
      // No readable partial result (or ingest hiccup): nothing solved to
      // preserve — release everything below. Loud, never silent.
      console.error(
        `[sweeper] worker-restart orphan ${job.engineJobId} (sim_job ${job.id}): partial-result ingest unavailable (${errorMessage(e)}); releasing all claims`,
      );
    }
  }
  console.error(
    `[sweeper] WORKER RESTART orphan ${job.engineJobId ?? "(unsubmitted)"} (sim_job ${job.id}): ${solvedPoints} solved point(s) kept as evidence, remaining claims released for re-solve — nothing marked failed`,
  );
  await cancelJobAndReleaseClaims(db, job, "worker restarted mid-solve; points released for re-solve");
  if (solvedPoints > 0) {
    await refreshPolarCachesForJob(db, job);
    await enqueueVerificationsForJob(db, job);
    await settleCampaignAfterRefresh(db, job);
  }
}

/** Angle list a job was composed for (requestPayload.aoas) — loud-event
 *  addressing only; absent/odd payloads render as an empty list. */
function anglesForJob(job: SimJobRow): number[] {
  const raw = (requestPayload(job) as { aoas?: unknown }).aoas;
  return Array.isArray(raw) ? raw.filter((a): a is number => typeof a === "number" && Number.isFinite(a)) : [];
}

/** One-line job-failed event (gate incident 2026-07-07: campaign a1802299's
 *  only job failed and the sweeper logged NOTHING between claim and terminal
 *  failure). Every terminal failed-ingest outcome emits exactly one of these
 *  with full addressing + an explicit verdict. */
function logEngineJobFailed(job: SimJobRow, failure: string, counts: { points: number; attempts: number }, verdict: string): void {
  console.error(
    `[sweeper] engine job FAILED (engine ${job.engineJobId ?? "-"}, sim_job ${job.id}, campaign ${job.campaignId ?? "-"}, airfoil ${job.airfoilId}, angles [${anglesForJob(job).join(", ")}]): ${failure} — ${counts.points} point(s), ${counts.attempts} attempt(s) ingested; ${verdict}`,
  );
}

async function ingestFailedEngineJob(db: DB, engine: EngineClient, job: SimJobRow, msg: string): Promise<void> {
  if (msg === WORKER_RESTART_ORPHAN_MESSAGE) {
    // Infrastructure interruption, not solver failure — release, never fail.
    await releaseWorkerRestartOrphan(db, engine, job);
    return;
  }
  if (!job.engineJobId) {
    const failure = nonEmptyFailureMessage(job, msg);
    logEngineJobFailed(job, failure, { points: 0, attempts: 0 }, "never submitted to the engine; rows failed");
    await failJob(db, job.id, failure);
    await settleUransLadderForJob(db, job);
    return;
  }
  let result: JobResult;
  try {
    result = await engine.getResult(job.engineJobId);
  } catch (e) {
    const failure = nonEmptyFailureMessage(job, msg);
    logEngineJobFailed(job, failure, { points: 0, attempts: 0 }, `result payload unreadable (${errorMessage(e)}); rows failed with the status message`);
    await failJob(db, job.id, failure);
    await settleUransLadderForJob(db, job);
    return;
  }
  // The ENGINE's own failure message wins (gate incident 2026-07-07: the
  // runtime-probe dispatch passed the generic "engine job failed" fallback and
  // the real "All cases failed" never reached the evidence rows): prefer the
  // result payload's message, then the caller's status-derived msg, then the
  // pinned non-empty fallback.
  const failure = nonEmptyFailureMessage(job, typeof result.message === "string" && result.message.trim() ? result.message : msg);
  try {
    const ingested = await ingestResult({
      db,
      engine,
      engineJobId: job.engineJobId,
      simJobId: job.id,
      airfoilId: job.airfoilId,
      speedMap: speedMapForJob(job),
      conditionMap: conditionMapForJob(job) ?? undefined,
      uransFidelity: uransFidelityForJob(job),
      result,
      failedPointErrorFallback: failure,
    });
    collectDirtyLanes(ingested.dirtyLanes);
    if (ingested.points === 0) {
      await failJob(db, job.id, failure);
      if (ingested.attempts === 0) {
        // True crash: the payload shipped no evidence at all — current
        // terminal-fail behavior, now loud.
        await settleUransLadderForJob(db, job);
        logEngineJobFailed(job, failure, ingested, "no shipped evidence; rows failed");
        return;
      }
      // All-rejected job (gate incident 2026-07-07, job a2379532): points: []
      // but polars[].attempts carried the real solver evidence (forces,
      // steady_history, evidence artifacts) — already ingested above. Stamp
      // the job as evidence-ingested (the gated-ladder rescan requires
      // status='failed' AND ingested_at), classify the fresh attempt rows,
      // and keep the wave-2 gated retry reachable: before this branch existed
      // points===0 returned ABOVE submitUransRetryForJob, so a fully-rejected
      // (e.g. single-point) campaign job could never escalate to URANS.
      await db
        .update(simJobs)
        .set({ engineState: "failed", ingestedAt: new Date(), finishedAt: new Date() })
        .where(eq(simJobs.id, job.id));
      await refreshPolarCachesForJob(db, job);
      await settleUransLadderForJob(db, job);
      logEngineJobFailed(job, failure, ingested, "attempt evidence kept on the failed rows; gated URANS retry evaluated");
      await submitUransRetryForJob(db, engine, job);
      await settleCampaignAfterRefresh(db, job);
      return;
    }
    await refreshPolarCachesForJob(db, job);
    await enqueueVerificationsForJob(db, job);
    await settleUransLadderForJob(db, job);
    await db
      .update(simJobs)
      .set({ status: "failed", engineState: "failed", error: failure, ingestedAt: new Date(), finishedAt: new Date() })
      .where(reconcilableJobWhere(job.id));
    logEngineJobFailed(job, failure, ingested, "partial evidence ingested; failed rows carry the engine message");
    await submitUransRetryForJob(db, engine, job);
    await settleCampaignAfterRefresh(db, job);
  } catch (e) {
    // Loud, never silent (the old bare catch was exactly how a mid-ingest
    // hiccup erased all trace of the shipped evidence).
    logEngineJobFailed(job, failure, { points: 0, attempts: 0 }, `failed-result ingest errored (${errorMessage(e)}); rows failed`);
    await failJob(db, job.id, failure);
    await settleUransLadderForJob(db, job);
  }
}

async function ingestResultFileIfReady(db: DB, engine: EngineClient, job: SimJobRow, failedMessage = "engine job failed"): Promise<boolean> {
  if (!job.engineJobId) return false;
  let result;
  try {
    result = await engine.getResult(job.engineJobId);
  } catch {
    return false;
  }
  if (result.state === "completed") {
    await ingestCompletedJob(db, engine, job);
    return true;
  }
  if (result.state === "failed") {
    await ingestFailedEngineJob(db, engine, job, result.message ?? failedMessage);
    return true;
  }
  if (result.state === "cancelled") {
    // G2 dispatch site 2 (terminal result handling): a cancelled result file
    // is terminal like failed, but its coefficients must NEVER be ingested.
    await cancelJobAndReleaseClaims(db, job, result.message ?? "engine result marks job cancelled; claims released");
    return true;
  }
  return false;
}

async function recoverFailedEngineJobs(db: DB, engine: EngineClient, ids?: string[]): Promise<void> {
  const filters = [
    eq(simJobs.status, "failed"),
    isNotNull(simJobs.engineJobId),
    or(
      sql`${simJobs.error} ILIKE 'engine job not found%'`,
      sql`${simJobs.error} ILIKE 'ingest failed:%'`,
      sql`${simJobs.error} ILIKE 'ingest retry pending:%'`,
    ),
  ];
  if (ids?.length) filters.push(inArray(simJobs.id, ids));

  const jobs = await db
    .select()
    .from(simJobs)
    .where(and(...filters))
    .limit(25);

  for (const job of jobs) {
    if (!job.engineJobId) continue;
    // Invariant: no code path may run >30 s without a heartbeat touch. Each
    // recovery candidate can cost an engine round-trip PLUS a full re-ingest;
    // a 25-job sweep must not leave the heartbeat silent meanwhile (2026-07-06:
    // 204 s stale mid-tick read as PROCESS NOT RUNNING on a healthy process).
    await touchHeartbeat(db);
    let status: JobStatus | null = null;
    try {
      status = await engine.getJob(job.engineJobId);
    } catch (e) {
      try {
        if (await ingestResultFileIfReady(db, engine, job, "engine status is unavailable but result file is ready")) {
          continue;
        }
      } catch (ingestError) {
        await markIngestRetry(db, job.id, ingestError);
        continue;
      }
      const listed = await engineQueueMentionsJob(engine, job.engineJobId);
      if (listed) {
        await db
          .update(simJobs)
          .set({ status: "running", engineState: "running", error: null, polledAt: new Date(), finishedAt: null })
          .where(eq(simJobs.id, job.id));
        await db
          .update(results)
          .set({ status: "running", source: "queued", engineJobId: job.engineJobId })
          .where(and(eq(results.simJobId, job.id), inArray(results.status, ["failed", "queued", "running", "pending", "stale"])));
      } else if (isNotFound(e) && (job.error ?? "").startsWith("engine job not found")) {
        await requeueLostJob(db, job, "engine job disappeared; safely requeued for a fresh solve");
      }
      continue;
    }

    await db
      .update(results)
      .set({ status: status.state === "completed" ? "queued" : "running", source: "queued", engineJobId: job.engineJobId })
      .where(and(eq(results.simJobId, job.id), inArray(results.status, ["failed", "queued", "running", "pending", "stale"])));
    await updateJobFromEngineStatus(db, job, status);

    if (status.state === "completed") {
      try {
        await ingestCompletedJob(db, engine, job);
      } catch (e) {
        await markIngestRetry(db, job.id, e);
      }
    } else if (status.state === "failed") {
      await ingestFailedEngineJob(db, engine, job, status.message ?? "engine job failed");
    }
  }
}

async function keepDetachedRunning(db: DB, job: SimJobRow, runtime: JobRuntimeSummary, msg: string): Promise<void> {
  await db
    .update(simJobs)
    .set({
      status: "running",
      engineState: runtime.status_state ?? "running",
      totalCases: runtime.status_total_cases ?? job.totalCases,
      completedCases: runtime.status_completed_cases ?? job.completedCases,
      error: msg,
      polledAt: new Date(),
      finishedAt: null,
    })
    .where(activeJobWhere(job.id));
}

async function handlePollMiss(db: DB, engine: EngineClient, job: SimJobRow, e: unknown, queue: EngineQueueState | null, runtime: JobRuntimeSummary | null): Promise<void> {
  if (!job.engineJobId) return;
  const classified = classifyQueueLifecycle(job, runtime, queue);
  if (runtime?.has_result && runtime.result_readable) {
    if (runtime.result_state === "completed") {
      try {
        await ingestCompletedJob(db, engine, job);
      } catch (ingestError) {
        await markIngestRetry(db, job.id, ingestError);
      }
    } else if (runtime.result_state === "failed") {
      // The engine's REAL failure message lives on the status ("All cases
      // failed" — set_status), not necessarily on the result payload: fall
      // through result → status → generic (gate incident 2026-07-07).
      await ingestFailedEngineJob(db, engine, job, runtime.result_message ?? runtime.status_message ?? "engine job failed");
    } else if (
      runtime.result_state === "running" &&
      runtime.status_completed_cases !== null &&
      runtime.status_completed_cases !== undefined &&
      runtime.status_completed_cases > job.completedCases
    ) {
      await ingestRunningPartialJob(db, engine, job);
    }
    return;
  }

  if (classified.processCount > 0 || classified.runtimeState === "detached_running" || (classified.runtimeState === "corrupt_status" && classified.staleReason?.includes("heartbeat"))) {
    await keepDetachedRunning(db, job, runtime ?? { job_id: job.engineJobId, exists: true, cancelled: false, process_count: classified.processCount, status_readable: false, result_readable: false, has_result: false }, classified.staleReason ?? "engine task is detached from Celery but OpenFOAM processes are still running");
    return;
  }

  if (classified.recoverable) {
    await requeueLostJob(db, job, classified.staleReason ?? "engine job lost; safely requeued for a fresh solve");
    return;
  }

  const listed = queue ? classified.engineQueueMatch : await engineQueueMentionsJob(engine, job.engineJobId);
  if (listed) {
    await db
      .update(simJobs)
      .set({ status: "running", engineState: "running", error: null, polledAt: new Date(), finishedAt: null })
      .where(activeJobWhere(job.id));
    return;
  }
  if (listed === null || !isNotFound(e)) {
    await db
      .update(simJobs)
      .set({ error: "engine poll failed: " + errorMessage(e), polledAt: new Date(), finishedAt: null })
      .where(activeJobWhere(job.id));
    return;
  }

  const missingSince = job.engineState === "missing" ? (job.polledAt ?? job.submittedAt ?? job.createdAt) : null;
  if (missingSince && Date.now() - missingSince.getTime() >= MISSING_JOB_REQUEUE_MS) {
    await requeueLostJob(db, job, "engine job stayed missing; safely requeued for a fresh solve");
    return;
  }
  await markPollMiss(db, job, "engine job temporarily missing; waiting before requeue");
}

/** Poll in-flight engine jobs; completed jobs ingest, transient engine misses recover or requeue. */
export async function reconcile(db: DB, engine: EngineClient, options: ReconcileOptions = {}): Promise<void> {
  if (!options.skipFailedRecovery) {
    await recoverFailedEngineJobs(db, engine, options.recoverFailedJobIds);
  }

  const activeFilters = [inArray(simJobs.status, activeJobStatuses)];
  if (options.jobIds?.length) activeFilters.push(inArray(simJobs.id, options.jobIds));

  const jobs = await db
    .select()
    .from(simJobs)
    .where(and(...activeFilters));

  let queue: EngineQueueState | null = null;
  try {
    queue = await engine.getQueue();
  } catch {
    queue = null;
  }
  const runtimeByJobId = await engineRuntimeMap(
    engine,
    jobs.map((job) => job.engineJobId).filter((id): id is string => Boolean(id)),
  );
  if (queue) {
    await cancelTerminalEngineTasks(
      db,
      engine,
      queue,
      new Set(jobs.map((job) => job.engineJobId).filter((id): id is string => Boolean(id))),
    );
  }

  for (const job of jobs) {
    if (!job.engineJobId) continue;
    // Engine API calls take seconds when the worker saturates every core; a
    // 10+-job reconcile pass must not leave the heartbeat silent meanwhile.
    await touchHeartbeat(db);
    const runtime = runtimeByJobId.get(job.engineJobId) ?? null;
    if (runtime?.has_result && runtime.result_readable) {
      if (runtime.result_state === "completed") {
        try {
          await ingestCompletedJob(db, engine, job);
        } catch (e) {
          await markIngestRetry(db, job.id, e);
        }
        continue;
      } else if (runtime.result_state === "failed") {
        // Same result → status → generic message fallthrough as handlePollMiss
        // (the runtime dispatch is where "All cases failed" got lost to the
        // generic fallback on the 2026-07-07 gate run).
        await ingestFailedEngineJob(db, engine, job, runtime.result_message ?? runtime.status_message ?? "engine job failed");
        continue;
      } else if (
        runtime.result_state === "running" &&
        runtime.status_completed_cases !== null &&
        runtime.status_completed_cases !== undefined &&
        runtime.status_completed_cases > job.completedCases
      ) {
        await ingestRunningPartialJob(db, engine, job);
      }
    }
    let status;
    try {
      status = await engine.getJob(job.engineJobId);
    } catch (e) {
      try {
        if (await ingestResultFileIfReady(db, engine, job, "engine poll failed but result file is ready")) {
          continue;
        }
      } catch (ingestError) {
        await markIngestRetry(db, job.id, ingestError);
        continue;
      }
      await handlePollMiss(db, engine, job, e, queue, runtime);
      continue;
    }
    const lostReason = classifyLostRunning(job, status, runtime, queue);
    if (lostReason) {
      // G3: loud by design — this is a worker-restart zombie, not a routine state.
      console.error(`[sweeper] LOST engine job ${job.engineJobId} (sim_job ${job.id}): ${lostReason}`);
      try {
        await engine.cancelJob(job.engineJobId);
      } catch (cancelError) {
        console.error(`[sweeper] engine-side cancel of lost job ${job.engineJobId} failed: ${errorMessage(cancelError)}`);
      }
      await cancelJobAndReleaseClaims(db, job, lostReason);
      continue;
    }
    if (status.state === "running" && status.completed_cases > job.completedCases) {
      await ingestRunningPartialJob(db, engine, job);
    }
    await updateJobFromEngineStatus(db, job, status);

    if (status.state === "completed") {
      try {
        await ingestCompletedJob(db, engine, job);
      } catch (e) {
        await markIngestRetry(db, job.id, e);
      }
    } else if (status.state === "failed") {
      await ingestFailedEngineJob(db, engine, job, status.message ?? "engine job failed");
    }
  }

  await drainCampaignMaintenance(db);

  // Bounded re-attempt of failed shared-scale renders (one transient engine
  // fetch failure must not orphan a scale permanently — live proof 2026-07-05).
  const now = Date.now();
  if (now - lastScaleRenderRetryAt >= SCALE_RENDER_RETRY_MS) {
    lastScaleRenderRetryAt = now;
    try {
      const recovered = await retryFailedScaleRenders(db, engine);
      if (recovered > 0) console.log(`[sweeper] scaled-media retry pass registered ${recovered} media rows`);
    } catch (e) {
      console.error("[sweeper] scaled-media retry pass failed:", errorMessage(e));
    }
  }
}

/** Per-tick cap on dirty-lane processing. A dual-objective campaign dirties
 *  two lanes per ingested point; an unbounded drain after a burst of partial
 *  ingests wedged the tick for ~10 minutes at 10^5-lane scale (2026-07-05),
 *  starving job submission and the heartbeat. The remainder carries over —
 *  pendingDirtyLanes is a Map, so re-dirtied lanes dedupe for free. */
const DIRTY_LANE_DRAIN_CAP = 100;

/** Drain dirty refinement lanes after every reconcile pass (fits are fresh by
 *  now), run the 60 s lane safety sweep and the low-frequency campaign
 *  reconciler (spec §7/§8). All in-memory timers — no schema state. */
async function drainCampaignMaintenance(db: DB): Promise<void> {
  const dirty = [...pendingDirtyLanes.values()].slice(0, DIRTY_LANE_DRAIN_CAP);
  let drained = 0;
  for (const key of dirty) {
    pendingDirtyLanes.delete(laneKeyId(key));
    try {
      await laneTick(db, key);
    } catch (e) {
      console.error("[sweeper] lane tick failed:", laneKeyId(key), errorMessage(e));
    }
    // Invariant: no code path may run >30 s without a heartbeat touch — a
    // 100-lane drain under DB load must beat mid-drain, not only after it.
    if (++drained % 10 === 0) await touchHeartbeat(db);
  }
  if (pendingDirtyLanes.size > 0) {
    console.log(`[sweeper] dirty-lane backlog: ${pendingDirtyLanes.size} lanes carried to next tick`);
  }
  await touchHeartbeat(db);

  const now = Date.now();
  if (now - lastLaneSweepAt >= LANE_SAFETY_SWEEP_MS) {
    lastLaneSweepAt = now;
    try {
      const lanes = await db
        .select({
          campaignId: simCampaignLanes.campaignId,
          airfoilId: simCampaignLanes.airfoilId,
          conditionId: simCampaignLanes.conditionId,
          objective: simCampaignLanes.objective,
        })
        .from(simCampaignLanes)
        .innerJoin(simCampaigns, eq(simCampaigns.id, simCampaignLanes.campaignId))
        .where(and(eq(simCampaigns.status, "active"), inArray(simCampaignLanes.state, ["awaiting_seed", "iterating"])))
        .limit(200);
      let sweepCount = 0;
      for (const key of lanes) {
        try {
          await laneTick(db, key);
        } catch (e) {
          console.error("[sweeper] lane sweep tick failed:", laneKeyId(key), errorMessage(e));
        }
        // Invariant: no code path may run >30 s without a heartbeat touch —
        // per-10 (was per-50): 50 lane ticks at ~1 s each under load is a
        // 50 s silent stretch, past the web's 90 s truth-gate margin.
        if (++sweepCount % 10 === 0) await touchHeartbeat(db);
      }
    } catch (e) {
      console.error("[sweeper] lane safety sweep failed:", errorMessage(e));
    }
  }

  if (now - lastCampaignReconcileAt >= CAMPAIGN_RECONCILE_MS) {
    lastCampaignReconcileAt = now;
    try {
      const healed = await reconcileCampaigns(db);
      let healedCount = 0;
      for (const key of healed.staleLanes) {
        try {
          await laneTick(db, key);
        } catch (e) {
          console.error("[sweeper] reconciler lane tick failed:", laneKeyId(key), errorMessage(e));
        }
        // Invariant: no code path may run >30 s without a heartbeat touch.
        if (++healedCount % 10 === 0) await touchHeartbeat(db);
      }
    } catch (e) {
      console.error("[sweeper] campaign reconciler failed:", errorMessage(e));
    }
  }
}

/** Startup recovery: release result rows claimed by jobs that are no longer live. */
export async function resetOrphans(db: DB): Promise<void> {
  const live = await db
    .select({ id: simJobs.id })
    .from(simJobs)
    .where(inArray(simJobs.status, ["submitted", "running", "ingesting"]));
  const liveIds = live.map((l) => l.id);
  const claimed = inArray(results.status, ["queued", "running"]);
  await db
    .update(results)
    .set({ status: "pending", source: "queued", simJobId: null })
    .where(liveIds.length ? and(claimed, or(isNull(results.simJobId), notInArray(results.simJobId, liveIds))) : claimed);
}
