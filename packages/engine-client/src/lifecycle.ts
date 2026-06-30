import type { EngineQueueState, JobRuntimeSummary } from "./types";

export type QueueRuntimeState =
  | "not_submitted"
  | "worker_visible"
  | "detached_running"
  | "result_ready"
  | "missing_grace"
  | "orphaned"
  | "corrupt_status"
  | "corrupt_result"
  | "unknown";

export interface QueueLifecycleJob {
  status: string;
  engineJobId?: string | null;
  engineState?: string | null;
  createdAt?: string | Date | null;
  submittedAt?: string | Date | null;
  polledAt?: string | Date | null;
  pendingAgeSec?: number | null;
}

export interface QueueLifecycleOptions {
  now?: Date;
  staleMs?: number;
  missingRequeueMs?: number;
  recoverImmediately?: boolean;
}

export interface QueueLifecycleClassification {
  runtimeState: QueueRuntimeState;
  stale: boolean;
  recoverable: boolean;
  needsIngest: boolean;
  engineQueueMatch: boolean;
  processCount: number;
  resultReady: boolean;
  staleReason: string | null;
}

const DEFAULT_STALE_MS = 30 * 60 * 1000;
const DEFAULT_MISSING_REQUEUE_MS = 10 * 60 * 1000;

export function engineQueueListsJob(queue: EngineQueueState | null | undefined, engineJobId: string | null | undefined): boolean {
  if (!queue || !engineJobId) return false;
  return (
    queue.job_ids.includes(engineJobId) ||
    [...queue.active, ...queue.reserved, ...queue.scheduled].some((task) => task.job_id === engineJobId)
  );
}

export function classifyQueueLifecycle(
  job: QueueLifecycleJob,
  runtime: JobRuntimeSummary | null | undefined,
  queue: EngineQueueState | null | undefined,
  options: QueueLifecycleOptions = {},
): QueueLifecycleClassification {
  const now = options.now ?? new Date();
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const missingRequeueMs = options.missingRequeueMs ?? DEFAULT_MISSING_REQUEUE_MS;
  const engineQueueMatch = engineQueueListsJob(queue, job.engineJobId);
  const pendingAgeMs = job.pendingAgeSec == null ? Math.max(0, now.getTime() - ageStart(job, now).getTime()) : Math.max(0, job.pendingAgeSec * 1000);
  const active = ["pending", "submitted", "running", "ingesting"].includes(job.status);
  const processCount = Math.max(0, Number(runtime?.process_count ?? 0));
  const heartbeatAlive =
    runtime?.runtime_heartbeat_age_sec != null &&
    Number.isFinite(Number(runtime.runtime_heartbeat_age_sec)) &&
    Number(runtime.runtime_heartbeat_age_sec) <= 120;
  const resultReady = Boolean(runtime?.has_result && runtime.result_readable && runtime.result_state);

  if (!job.engineJobId) {
    return {
      runtimeState: "not_submitted",
      stale: active && pendingAgeMs > staleMs,
      recoverable: false,
      needsIngest: false,
      engineQueueMatch,
      processCount,
      resultReady,
      staleReason: active && pendingAgeMs > staleMs ? "job has not been submitted to the engine" : null,
    };
  }

  if (resultReady) {
    return {
      runtimeState: "result_ready",
      stale: false,
      recoverable: false,
      needsIngest: active,
      engineQueueMatch,
      processCount,
      resultReady,
      staleReason: active ? "engine result file is ready for ingestion" : null,
    };
  }

  if (runtime?.result_error) {
    return {
      runtimeState: "corrupt_result",
      stale: active && pendingAgeMs > staleMs && processCount === 0,
      recoverable: active && pendingAgeMs > staleMs && processCount === 0,
      needsIngest: false,
      engineQueueMatch,
      processCount,
      resultReady,
      staleReason: `engine result file is unreadable: ${runtime.result_error}`,
    };
  }

  if (engineQueueMatch) {
    return {
      runtimeState: "worker_visible",
      stale: false,
      recoverable: false,
      needsIngest: false,
      engineQueueMatch,
      processCount,
      resultReady,
      staleReason: null,
    };
  }

  if (processCount > 0 || heartbeatAlive) {
    return {
      runtimeState: runtime?.status_error ? "corrupt_status" : "detached_running",
      stale: false,
      recoverable: false,
      needsIngest: false,
      engineQueueMatch,
      processCount,
      resultReady,
      staleReason: runtime?.status_error
        ? processCount > 0
          ? `status file is unreadable, but ${processCount} OpenFOAM process${processCount === 1 ? "" : "es"} still run`
          : "status file is unreadable, but the worker heartbeat is still fresh"
        : processCount > 0
          ? `${processCount} OpenFOAM process${processCount === 1 ? "" : "es"} still run although Celery no longer lists the task`
          : "worker heartbeat is still fresh although Celery no longer lists the task",
    };
  }

  if (runtime?.status_error) {
    const stale = active && pendingAgeMs > staleMs;
    return {
      runtimeState: "corrupt_status",
      stale,
      recoverable: stale,
      needsIngest: false,
      engineQueueMatch,
      processCount,
      resultReady,
      staleReason: `status file is unreadable and no OpenFOAM process is running: ${runtime.status_error}`,
    };
  }

  if (active && pendingAgeMs > staleMs) {
    const missingSince = job.engineState === "missing" ? dateOrNull(job.polledAt) ?? dateOrNull(job.submittedAt) ?? dateOrNull(job.createdAt) : null;
    const missingAgeMs = missingSince ? Math.max(0, now.getTime() - missingSince.getTime()) : 0;
    const recoverable = options.recoverImmediately || missingAgeMs >= missingRequeueMs;
    return {
      runtimeState: recoverable ? "orphaned" : "missing_grace",
      stale: true,
      recoverable,
      needsIngest: false,
      engineQueueMatch,
      processCount,
      resultReady,
      staleReason: recoverable
        ? "engine job is absent from Celery, has no OpenFOAM process, and no readable result file"
        : "engine job is absent from Celery; waiting through missing-job grace before recovery",
    };
  }

  return {
    runtimeState: "unknown",
    stale: false,
    recoverable: false,
    needsIngest: false,
    engineQueueMatch,
    processCount,
    resultReady,
    staleReason: null,
  };
}

function ageStart(job: QueueLifecycleJob, fallback: Date): Date {
  return dateOrNull(job.submittedAt) ?? dateOrNull(job.createdAt) ?? fallback;
}

function dateOrNull(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
