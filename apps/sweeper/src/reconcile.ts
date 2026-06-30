import {
  airfoils,
  type DB,
  ransRetryPlanForJob,
  refreshPolarCacheForRevision,
  results,
  simJobs,
  simulationPresetRevisions,
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
import { ingestResult, type SpeedBc } from "./ingest";

const MISSING_JOB_REQUEUE_MS = Number(process.env.SWEEPER_MISSING_JOB_REQUEUE_MS ?? 10 * 60 * 1000);
type SimJobRow = typeof simJobs.$inferSelect;
interface ReconcileOptions {
  jobIds?: string[];
  recoverFailedJobIds?: string[];
  skipFailedRecovery?: boolean;
}

const activeJobStatuses: Array<"submitted" | "running" | "ingesting"> = ["submitted", "running", "ingesting"];

function activeJobWhere(jobId: string) {
  return and(eq(simJobs.id, jobId), inArray(simJobs.status, activeJobStatuses));
}

function reconcilableJobWhere(jobId: string) {
  return and(eq(simJobs.id, jobId), inArray(simJobs.status, [...activeJobStatuses, "failed"]));
}

async function failJob(db: DB, jobId: string, msg: string): Promise<void> {
  await db
    .update(results)
    .set({ status: "failed", source: "queued" })
    .where(and(eq(results.simJobId, jobId), inArray(results.status, ["queued", "running"])));
  await db.update(simJobs).set({ status: "failed", error: msg, finishedAt: new Date() }).where(activeJobWhere(jobId));
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
  const parentPayload = requestPayload(parent);
  const [existing] = await db
    .select({ id: simJobs.id })
    .from(simJobs)
    .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2), inArray(simJobs.status, ["pending", "submitted", "running", "ingesting", "done"])))
    .limit(1);
  if (existing) return;

  await refreshPolarCacheForRevision(db, parent.airfoilId, parent.simulationPresetRevisionId);
  const retry = await ransRetryPlanForJob(db, parent.id);
  if (!retry || retry.aoas.length === 0) return;
  const aoas = retry.aoas;

  const [a] = await db.select().from(airfoils).where(eq(airfoils.id, parent.airfoilId)).limit(1);
  const setup = await setupSnapshotForJob(db, parent);
  if (!a || !setup) return;
  const bcId = setup.snapshot.preset.legacyBoundaryConditionId ?? parent.bcIds[0];

  const { request, speed } = buildPolarRequest({ airfoil: a, setup: setup.snapshot, aoaList: aoas, wave: 2, queuePressure: await dbQueuePressure(db) });
  const [job] = await db
    .insert(simJobs)
    .values({
      parentJobId: parent.id,
      airfoilId: a.id,
      bcIds: [bcId],
      simulationPresetRevisionId: setup.revisionId,
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
      .where(activeJobWhere(job.id));
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
    await db
      .update(simJobs)
      .set({ status: "failed", error: "URANS submit failed: " + (e as Error).message, finishedAt: new Date() })
      .where(eq(simJobs.id, job.id));
  }
}

async function ingestCompletedJob(db: DB, engine: EngineClient, job: SimJobRow): Promise<void> {
  if (!job.engineJobId) return;
  const result = await engine.getResult(job.engineJobId);
  const speedMap = speedMapForJob(job);
  await ingestResult({ db, engine, engineJobId: job.engineJobId, simJobId: job.id, airfoilId: job.airfoilId, speedMap, result });
  if (job.simulationPresetRevisionId) {
    await refreshPolarCacheForRevision(db, job.airfoilId, job.simulationPresetRevisionId);
  }
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
    result,
  });
  if (ingested.points > 0 && job.simulationPresetRevisionId) {
    await refreshPolarCacheForRevision(db, job.airfoilId, job.simulationPresetRevisionId);
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
      result,
    });
    if (ingested.points === 0) {
      await failJob(db, job.id, msg);
      return;
    }
    if (job.simulationPresetRevisionId) {
      await refreshPolarCacheForRevision(db, job.airfoilId, job.simulationPresetRevisionId);
    }
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
