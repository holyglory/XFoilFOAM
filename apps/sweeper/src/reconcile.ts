import {
  airfoils,
  type CampaignLaneKey,
  type DB,
  laneKeyId,
  laneTick,
  onResultIngested,
  reconcileCampaigns,
  refreshPolarCacheForRevision,
  results,
  simCampaignLanes,
  simCampaigns,
  simJobs,
  simulationPresetRevisions,
  sweeperState,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import {
  EngineError,
  classifyQueueLifecycle,
  type EngineClient,
  type EngineQueueState,
  type JobRuntimeSummary,
  type JobStatus,
} from "@aerodb/engine-client";
import { and, count, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";

import { buildPolarRequest } from "./build-request";
import { isEngineConnectionFailure, recordEngineUnreachable } from "./engine-backoff";
import { type ConditionMapEntry, ingestResult, type SpeedBc } from "./ingest";
import { ransRetryPlanForJobScoped } from "./retry-plan";

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
const pendingDirtyLanes = new Map<string, CampaignLaneKey>();
let lastLaneSweepAt = 0;
let lastCampaignReconcileAt = 0;

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
  const failedRows = await db
    .update(results)
    .set({ status: "failed", source: "queued" })
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

/** Refresh polar-fit caches for every revision a job touched: each
 *  conditionMap entry's revision for batched campaign jobs, the job's single
 *  revision otherwise (today's path, unchanged). */
async function refreshPolarCachesForJob(db: DB, job: SimJobRow): Promise<void> {
  const conditionMap = conditionMapForJob(job);
  if (conditionMap) {
    for (const revisionId of new Set(conditionMap.map((entry) => entry.revisionId))) {
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

async function updateJobFromEngineStatus(db: DB, job: SimJobRow, status: JobStatus): Promise<void> {
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
  // Retry scoping (spec §7): whole-polar heuristics run against REVISION-WIDE
  // evidence; `targeted` parents escalate only their own bad angles.
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
      jobKind: retry.fullUrans ? "sweep" : "targeted",
      referenceChordM: setup.snapshot.referenceGeometry.referenceLengthM,
      wave: 2,
      status: "pending",
      totalCases: aoas.length,
      requestPayload: {
        syncPromiseId: parentPayload.syncPromiseId,
        speedMap: [{ speed, bcId, presetRevisionId: setup.revisionId, mach: setup.snapshot.flowState.mach }],
        aoas,
        parentJobId: parent.id,
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
    await refreshPolarCacheForRevision(db, a.id, setup.revisionId);
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
        jobKind: retry.fullUrans ? "sweep" : "targeted",
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
      await refreshPolarCacheForRevision(db, a.id, entry.revisionId);
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
    result,
  });
  collectDirtyLanes(ingested.dirtyLanes);
  await refreshPolarCachesForJob(db, job);
  await db
    .update(simJobs)
    .set({ status: "done", engineState: "completed", error: null, ingestedAt: new Date(), finishedAt: new Date() })
    .where(reconcilableJobWhere(job.id));
  await submitUransRetryForJob(db, engine, job);
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

async function ingestFailedEngineJob(db: DB, engine: EngineClient, job: SimJobRow, msg: string): Promise<void> {
  if (!job.engineJobId) {
    await failJob(db, job.id, msg);
    return;
  }
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
      result,
    });
    collectDirtyLanes(ingested.dirtyLanes);
    if (ingested.points === 0) {
      await failJob(db, job.id, msg);
      return;
    }
    await refreshPolarCachesForJob(db, job);
    await db
      .update(simJobs)
      .set({ status: "failed", engineState: "failed", error: msg, ingestedAt: new Date(), finishedAt: new Date() })
      .where(reconcilableJobWhere(job.id));
    await submitUransRetryForJob(db, engine, job);
  } catch {
    await failJob(db, job.id, msg);
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
      await ingestFailedEngineJob(db, engine, job, runtime.result_message ?? "engine job failed");
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
/** Single-row heartbeat upsert (~1 ms). Called between the slow phases of a
 *  tick so "process not running" (stale heartbeat) never lies during long
 *  reconcile passes — the state that masked a wedged first tick on 2026-07-05. */
export async function touchHeartbeat(db: DB): Promise<void> {
  await db
    .insert(sweeperState)
    .values({ id: 1 })
    .onConflictDoUpdate({ target: sweeperState.id, set: { heartbeatAt: new Date() } });
}

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
        await ingestFailedEngineJob(db, engine, job, runtime.result_message ?? "engine job failed");
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
  for (const key of dirty) {
    pendingDirtyLanes.delete(laneKeyId(key));
    try {
      await laneTick(db, key);
    } catch (e) {
      console.error("[sweeper] lane tick failed:", laneKeyId(key), errorMessage(e));
    }
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
        if (++sweepCount % 50 === 0) await touchHeartbeat(db);
      }
    } catch (e) {
      console.error("[sweeper] lane safety sweep failed:", errorMessage(e));
    }
  }

  if (now - lastCampaignReconcileAt >= CAMPAIGN_RECONCILE_MS) {
    lastCampaignReconcileAt = now;
    try {
      const healed = await reconcileCampaigns(db);
      for (const key of healed.staleLanes) {
        try {
          await laneTick(db, key);
        } catch (e) {
          console.error("[sweeper] reconciler lane tick failed:", laneKeyId(key), errorMessage(e));
        }
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
