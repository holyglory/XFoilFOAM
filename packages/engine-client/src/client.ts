import type {
  EngineCacheStats,
  EngineHealth,
  EngineQueueState,
  FieldExtentsRequest,
  FieldExtentsResponse,
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

/** Thin typed client for the Python CFD solver API (FastAPI). */
export class EngineClient {
  readonly baseUrl: string;
  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EngineError(`${init?.method ?? "GET"} ${path} → ${res.status} ${body.slice(0, 300)}`, res.status);
    }
    return (await res.json()) as T;
  }

  async health(): Promise<boolean> {
    try {
      await this.json("/health");
      return true;
    } catch {
      return false;
    }
  }

  healthDetails(): Promise<EngineHealth> {
    return this.json<EngineHealth>("/health");
  }

  /** Submit a polar job → 202 with a job_id. */
  submitPolar(request: PolarRequest): Promise<JobStatus> {
    return this.json<JobStatus>("/polars", { method: "POST", body: JSON.stringify(request) });
  }

  getJob(jobId: string): Promise<JobStatus> {
    return this.json<JobStatus>(`/jobs/${encodeURIComponent(jobId)}`);
  }

  cancelJob(jobId: string): Promise<{ job_id: string; cancelled: boolean }> {
    return this.json<{ job_id: string; cancelled: boolean }>(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: "{}",
    });
  }

  getQueue(): Promise<EngineQueueState> {
    return this.json<EngineQueueState>("/queue");
  }

  /** Mesh/seed cache stats scanned from the engine's cache volume. */
  cacheStats(): Promise<EngineCacheStats> {
    return this.json<EngineCacheStats>("/cache/stats");
  }

  getJobRuntimes(jobIds: string[]): Promise<JobRuntimeResponse> {
    return this.json<JobRuntimeResponse>("/jobs/runtime", {
      method: "POST",
      body: JSON.stringify({ job_ids: jobIds }),
    });
  }

  /** Full result (the API returns 409 until the job completes). */
  getResult(jobId: string): Promise<JobResult> {
    return this.json<JobResult>(`/jobs/${encodeURIComponent(jobId)}/result`);
  }

  renderField(jobId: string, request: RenderFieldRequest): Promise<RenderFieldResponse> {
    return this.json<RenderFieldResponse>(`/jobs/${encodeURIComponent(jobId)}/render-field`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  computeFieldExtents(jobId: string, request: FieldExtentsRequest): Promise<FieldExtentsResponse> {
    return this.json<FieldExtentsResponse>(`/jobs/${encodeURIComponent(jobId)}/field-extents`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  renderDefaultMedia(jobId: string, request: RenderDefaultMediaRequest): Promise<RenderDefaultMediaResponse> {
    return this.json<RenderDefaultMediaResponse>(`/jobs/${encodeURIComponent(jobId)}/render-default-media`, {
      method: "POST",
      body: JSON.stringify(request),
    });
  }

  /** Absolute URL of a result artifact (image/log) on the engine. */
  fileUrl(jobId: string, relPath: string): string {
    const clean = relPath.replace(/^\/+/, "");
    return `${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/files/${clean}`;
  }
}
