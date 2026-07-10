import type {
  EngineCacheStats,
  EngineHealth,
  EngineMaintenanceDiskResponse,
  EngineMaintenanceJobsResponse,
  EngineQueueState,
  EngineStripJobRequest,
  EngineStripJobResponse,
  FieldExtentsRequest,
  FieldExtentsResponse,
  EngineDeleteJobResponse,
  JobResult,
  JobRuntimeResponse,
  JobStatus,
  PolarRequest,
  RenderDefaultMediaRequest,
  RenderDefaultMediaResponse,
  RenderFieldRequest,
  RenderFieldResponse,
} from "./types";

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

/** A request the engine never answered within its timeout budget. Deliberately
 *  NOT an EngineError: EngineError means "the engine answered (badly)", while
 *  a timeout is a connection-class failure — the sweeper's
 *  isEngineConnectionFailure(e) treats it like ECONNREFUSED (release work,
 *  record engine backoff, never mark jobs failed). Root cause 2026-07-06: a
 *  single hung engine HTTP call (engine API saturated by solvers) stalled a
 *  sweeper tick indefinitely and starved the in-tick heartbeat writes. */
export class EngineTimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "EngineTimeoutError";
  }
}

/** Per-call override for the built-in timeout defaults. */
export interface EngineCallOptions {
  timeoutMs?: number;
}

/** Status/runtime polls (health, job status, queue, cache stats, runtimes). */
export const ENGINE_POLL_TIMEOUT_MS = 15_000;
/** Mutating calls + full-result reads (submit, cancel, result JSON). */
export const ENGINE_SUBMIT_TIMEOUT_MS = 60_000;
/** Field-extents / render round-trips (the engine rasterizes frames). */
export const ENGINE_RENDER_TIMEOUT_MS = 120_000;

/** Thin typed client for the Python CFD solver API (FastAPI). Every call
 *  carries an AbortSignal timeout so a saturated engine can stall a caller
 *  for at most its budget — a hung fetch surfaces as EngineTimeoutError. */
export class EngineClient {
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async json<T>(path: string, timeoutMs: number, init?: RequestInit): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        ...init,
        signal,
        headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new EngineError(`${init?.method ?? "GET"} ${path} → ${res.status} ${body.slice(0, 300)}`, res.status);
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof EngineError) throw e;
      if (signal.aborted) {
        throw new EngineTimeoutError(
          `${init?.method ?? "GET"} ${path} timed out after ${timeoutMs} ms — engine did not answer (request aborted)`,
          timeoutMs,
        );
      }
      throw e;
    }
  }

  async health(opts?: EngineCallOptions): Promise<boolean> {
    try {
      await this.json("/health", opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS);
      return true;
    } catch {
      return false;
    }
  }

  healthDetails(opts?: EngineCallOptions): Promise<EngineHealth> {
    return this.json<EngineHealth>("/health", opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS);
  }

  /** Submit a polar job → 202 with a job_id. */
  submitPolar(request: PolarRequest, opts?: EngineCallOptions): Promise<JobStatus> {
    return this.json<JobStatus>("/polars", opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  getJob(jobId: string, opts?: EngineCallOptions): Promise<JobStatus> {
    return this.json<JobStatus>(`/jobs/${encodeURIComponent(jobId)}`, opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS);
  }

  cancelJob(jobId: string, opts?: EngineCallOptions): Promise<{ job_id: string; cancelled: boolean }> {
    return this.json<{ job_id: string; cancelled: boolean }>(
      `/jobs/${encodeURIComponent(jobId)}/cancel`,
      opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS,
      { method: "POST", body: "{}" },
    );
  }

  getQueue(opts?: EngineCallOptions): Promise<EngineQueueState> {
    return this.json<EngineQueueState>("/queue", opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS);
  }

  /** Mesh/seed cache stats scanned from the engine's cache volume. */
  cacheStats(opts?: EngineCallOptions): Promise<EngineCacheStats> {
    return this.json<EngineCacheStats>("/cache/stats", opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS);
  }

  stripJob(jobId: string, request: EngineStripJobRequest = {}, opts?: EngineCallOptions): Promise<EngineStripJobResponse> {
    return this.json<EngineStripJobResponse>(
      `/jobs/${encodeURIComponent(jobId)}/strip`,
      opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  deleteJob(jobId: string, opts?: EngineCallOptions): Promise<EngineDeleteJobResponse> {
    return this.json<EngineDeleteJobResponse>(`/jobs/${encodeURIComponent(jobId)}`, opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS, {
      method: "DELETE",
    });
  }

  maintenanceJobs(opts?: EngineCallOptions): Promise<EngineMaintenanceJobsResponse> {
    return this.json<EngineMaintenanceJobsResponse>("/maintenance/jobs", opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS);
  }

  maintenanceDisk(opts?: EngineCallOptions): Promise<EngineMaintenanceDiskResponse> {
    return this.json<EngineMaintenanceDiskResponse>("/maintenance/disk", opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS);
  }

  getJobRuntimes(jobIds: string[], opts?: EngineCallOptions): Promise<JobRuntimeResponse> {
    return this.json<JobRuntimeResponse>("/jobs/runtime", opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS, {
      method: "POST",
      body: JSON.stringify({ job_ids: jobIds }),
    });
  }

  /** Full result (the API returns 409 until the job completes). The payload
   *  can be MBs of polar/frame evidence — budgeted like a submit, not a poll. */
  getResult(jobId: string, opts?: EngineCallOptions): Promise<JobResult> {
    return this.json<JobResult>(`/jobs/${encodeURIComponent(jobId)}/result`, opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS);
  }

  renderField(jobId: string, request: RenderFieldRequest, opts?: EngineCallOptions): Promise<RenderFieldResponse> {
    return this.json<RenderFieldResponse>(
      `/jobs/${encodeURIComponent(jobId)}/render-field`,
      opts?.timeoutMs ?? ENGINE_RENDER_TIMEOUT_MS,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  computeFieldExtents(jobId: string, request: FieldExtentsRequest, opts?: EngineCallOptions): Promise<FieldExtentsResponse> {
    return this.json<FieldExtentsResponse>(
      `/jobs/${encodeURIComponent(jobId)}/field-extents`,
      opts?.timeoutMs ?? ENGINE_RENDER_TIMEOUT_MS,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  renderDefaultMedia(jobId: string, request: RenderDefaultMediaRequest, opts?: EngineCallOptions): Promise<RenderDefaultMediaResponse> {
    return this.json<RenderDefaultMediaResponse>(
      `/jobs/${encodeURIComponent(jobId)}/render-default-media`,
      opts?.timeoutMs ?? ENGINE_RENDER_TIMEOUT_MS,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  /** Absolute URL of a result artifact (image/log) on the engine. */
  fileUrl(jobId: string, relPath: string): string {
    const clean = relPath.replace(/^\/+/, "");
    return `${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/files/${clean}`;
  }
}
