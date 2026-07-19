import type {
  EngineCapabilities,
  EngineCacheStats,
  EngineHealth,
  EngineIdentity,
  EngineMaintenanceDiskResponse,
  EngineMaintenanceJobsResponse,
  EngineQueueState,
  EngineStripJobRequest,
  EngineStripJobResponse,
  FieldExtentsRequest,
  FieldExtentsResponse,
  EngineDeleteJobResponse,
  FinalizeRemoteEvidenceRequest,
  FinalizeRemoteEvidenceResponse,
  VerifyRemoteEvidenceManifestRequest,
  VerifyRemoteEvidenceManifestResponse,
  JobResult,
  JobRuntimeResponse,
  JobStatus,
  PolarRequest,
  RenderDefaultMediaRequest,
  RenderDefaultMediaResponse,
  RenderFieldRequest,
  RenderFieldResponse,
} from "./types";
import {
  LEGACY_OPENCFD_2406_ENGINE,
  OPENCFD_2606_ENGINE,
  isEngineCapabilityDescriptor,
  isEngineIdentity,
  isEngineRuntimeIdentity,
  sameEngineIdentity,
} from "./engine-identity";

export const MESH_RECOVERY_CAPABILITY_MISMATCH_CODE =
  "mesh_recovery_version_mismatch";
export const URANS_RECOVERY_CAPABILITY_MISMATCH_CODE =
  "urans_recovery_version_mismatch";
export const ENGINE_IDENTITY_MISMATCH_CODE = "engine_identity_mismatch";

export class EngineError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Stable machine-readable code supplied by an answered engine error.
     * HTTP status alone is deliberately insufficient for retry policy. */
    readonly code?: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

function engineErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return undefined;
    const detail = (parsed as { detail?: unknown }).detail;
    if (!detail || typeof detail !== "object" || Array.isArray(detail))
      return undefined;
    const code = (detail as { code?: unknown }).code;
    return typeof code === "string" && code.length > 0 ? code : undefined;
  } catch {
    return undefined;
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
  /** Logical implementation recorded on the owning sim_job. Required by new
   * control-plane job/result polls in a multi-engine gateway. */
  expectedEngine?: EngineIdentity;
  expectedExecutionPool?: string;
}

export interface EngineClientOptions {
  /** Expected logical numerical implementation for every call through this
   * client. New clients default to the executable OpenCFD-v2606 runtime. */
  expectedEngine?: EngineIdentity;
  /** Historical-read bridge. Missing structured identity is accepted only
   * when the caller explicitly expects the legacy OpenCFD-v2406 identity. */
  allowLegacyMissingIdentity?: boolean;
  /** Dedicated server-to-server bearer token for destructive evidence cleanup. */
  controlPlaneToken?: string;
}

/** Status/runtime polls (health, job status, queue, cache stats, runtimes). */
export const ENGINE_POLL_TIMEOUT_MS = 15_000;
/** Mutating calls + full-result reads (submit, cancel, result JSON). */
export const ENGINE_SUBMIT_TIMEOUT_MS = 60_000;
/** Field-extents / render round-trips (the engine rasterizes frames). */
export const ENGINE_RENDER_TIMEOUT_MS = 120_000;
/** Fresh generation-pinned download plus complete archive/member verification. */
export const ENGINE_EVIDENCE_VERIFY_TIMEOUT_MS = 15 * 60_000;

/** Thin typed client for the Python CFD solver API (FastAPI). Every call
 *  carries an AbortSignal timeout so a saturated engine can stall a caller
 *  for at most its budget — a hung fetch surfaces as EngineTimeoutError. */
export class EngineClient {
  readonly baseUrl: string;
  readonly expectedEngine: EngineIdentity;
  private readonly allowLegacyMissingIdentity: boolean;
  private readonly controlPlaneToken: string | null;

  constructor(baseUrl: string, options: EngineClientOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.expectedEngine = {
      ...(options.expectedEngine ?? OPENCFD_2606_ENGINE),
    };
    this.allowLegacyMissingIdentity =
      options.allowLegacyMissingIdentity ?? true;
    this.controlPlaneToken = options.controlPlaneToken?.trim() || null;
  }

  private verifyEngineAcknowledgement(
    response: {
      engine?: unknown;
      requested_engine?: unknown;
      requested_execution_pool?: unknown;
      execution_pool?: unknown;
      engines?: unknown;
      supported_engines?: unknown;
    },
    operation: string,
    expected?: EngineIdentity,
    options: {
      requireRuntime?: boolean;
      requireRequestedAck?: boolean;
      expectedExecutionPool?: string;
      requireExecutionPool?: boolean;
      /** Health/capability inventories acknowledge routable logical targets,
       * never an executing runtime. Job/result verification must leave this
       * false so a worker runtime cannot be replaced by gateway metadata. */
      allowLogicalInventoryAck?: boolean;
    } = {},
  ): void {
    const actual = response.engine;
    const requested = response.requested_engine;
    const requestedPool = response.requested_execution_pool;
    const executedPool = response.execution_pool;
    const inventories: EngineIdentity[][] = [];
    if (response.engines != null) {
      if (!Array.isArray(response.engines)) {
        throw new EngineError(
          `${operation} returned a malformed engine inventory`,
          undefined,
          ENGINE_IDENTITY_MISMATCH_CODE,
        );
      }
      const identities = response.engines.map((candidate) => {
        if (isEngineIdentity(candidate)) return candidate;
        if (isEngineCapabilityDescriptor(candidate)) return candidate.engine;
        throw new EngineError(
          `${operation} returned a malformed engine inventory`,
          undefined,
          ENGINE_IDENTITY_MISMATCH_CODE,
        );
      });
      inventories.push(identities);
    }
    if (response.supported_engines != null) {
      if (!Array.isArray(response.supported_engines)) {
        throw new EngineError(
          `${operation} returned a malformed supported engine inventory`,
          undefined,
          ENGINE_IDENTITY_MISMATCH_CODE,
        );
      }
      const identities = response.supported_engines.map((candidate) => {
        if (isEngineIdentity(candidate)) return candidate;
        throw new EngineError(
          `${operation} returned a malformed supported engine inventory`,
          undefined,
          ENGINE_IDENTITY_MISMATCH_CODE,
        );
      });
      inventories.push(identities);
    }
    const inventoryAcknowledged =
      expected != null &&
      inventories.some((inventory) =>
        inventory.some((candidate) => sameEngineIdentity(expected, candidate)),
      );
    if (expected && inventories.length > 0 && !inventoryAcknowledged) {
      throw new EngineError(
        `${operation} does not advertise requested engine ${JSON.stringify(expected)}`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
    if (requested != null) {
      if (!isEngineIdentity(requested)) {
        throw new EngineError(
          `${operation} returned malformed requested_engine acknowledgement`,
          undefined,
          ENGINE_IDENTITY_MISMATCH_CODE,
        );
      }
      if (expected && !sameEngineIdentity(expected, requested)) {
        throw new EngineError(
          `${operation} acknowledged request ${JSON.stringify(requested)} but ${JSON.stringify(expected)} owns the job`,
          undefined,
          ENGINE_IDENTITY_MISMATCH_CODE,
        );
      }
    } else if (
      expected &&
      options.requireRequestedAck &&
      !(
        this.allowLegacyMissingIdentity &&
        sameEngineIdentity(expected, LEGACY_OPENCFD_2406_ENGINE)
      )
    ) {
      throw new EngineError(
        `${operation} did not acknowledge requested engine ${JSON.stringify(expected)}`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
    const expectedPool = options.expectedExecutionPool;
    if (requestedPool != null && typeof requestedPool !== "string") {
      throw new EngineError(
        `${operation} returned malformed requested_execution_pool`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
    if (
      expectedPool &&
      requestedPool != null &&
      requestedPool !== expectedPool
    ) {
      throw new EngineError(
        `${operation} acknowledged execution pool ${JSON.stringify(requestedPool)} but ${JSON.stringify(expectedPool)} owns the job`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
    const legacyPoolOmission =
      this.allowLegacyMissingIdentity &&
      expected != null &&
      sameEngineIdentity(expected, LEGACY_OPENCFD_2406_ENGINE) &&
      expectedPool === "celery";
    if (expectedPool && requestedPool == null && !legacyPoolOmission) {
      throw new EngineError(
        `${operation} did not acknowledge requested execution pool ${JSON.stringify(expectedPool)}`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
    if (actual == null) {
      if (inventoryAcknowledged && options.allowLogicalInventoryAck) return;
      if (requested != null && !options.requireRuntime) return;
      if (!expected) return;
      if (
        this.allowLegacyMissingIdentity &&
        sameEngineIdentity(expected, LEGACY_OPENCFD_2406_ENGINE)
      ) {
        return;
      }
      throw new EngineError(
        `${operation} did not acknowledge runtime for requested engine ${JSON.stringify(expected)}`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
    if (!isEngineRuntimeIdentity(actual)) {
      throw new EngineError(
        `${operation} returned malformed engine runtime identity`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
    if (expected && !sameEngineIdentity(expected, actual)) {
      throw new EngineError(
        `${operation} executed by ${JSON.stringify(actual)} but ${JSON.stringify(expected)} was requested`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
    if (executedPool != null && typeof executedPool !== "string") {
      throw new EngineError(
        `${operation} returned malformed execution_pool`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
    if (expectedPool && executedPool != null && executedPool !== expectedPool) {
      throw new EngineError(
        `${operation} executed on pool ${JSON.stringify(executedPool)} but ${JSON.stringify(expectedPool)} was requested`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
    if (
      expectedPool &&
      options.requireExecutionPool &&
      executedPool == null &&
      !legacyPoolOmission
    ) {
      throw new EngineError(
        `${operation} did not acknowledge executing pool ${JSON.stringify(expectedPool)}`,
        undefined,
        ENGINE_IDENTITY_MISMATCH_CODE,
      );
    }
  }

  private requestWithExpectedEngine(request: PolarRequest): PolarRequest {
    return {
      ...request,
      expected_engine: {
        ...(request.expected_engine ?? this.expectedEngine),
      },
    };
  }

  private async json<T>(
    path: string,
    timeoutMs: number,
    init?: RequestInit,
  ): Promise<T> {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        ...init,
        signal,
        headers: {
          "content-type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new EngineError(
          `${init?.method ?? "GET"} ${path} → ${res.status} ${body.slice(0, 300)}`,
          res.status,
          engineErrorCode(body),
        );
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
      const health = await this.json<EngineHealth>(
        "/health",
        opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS,
      );
      this.verifyEngineAcknowledgement(
        health,
        "GET /health",
        opts?.expectedEngine,
        { allowLogicalInventoryAck: true },
      );
      return true;
    } catch {
      return false;
    }
  }

  healthDetails(opts?: EngineCallOptions): Promise<EngineHealth> {
    return this.json<EngineHealth>(
      "/health",
      opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS,
    ).then((health) => {
      this.verifyEngineAcknowledgement(
        health,
        "GET /health",
        opts?.expectedEngine,
        { allowLogicalInventoryAck: true },
      );
      return health;
    });
  }

  capabilities(opts?: EngineCallOptions): Promise<EngineCapabilities> {
    return this.json<EngineCapabilities>(
      "/capabilities",
      opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS,
    ).then((capabilities) => {
      this.verifyEngineAcknowledgement(
        capabilities,
        "GET /capabilities",
        opts?.expectedEngine,
        { allowLogicalInventoryAck: true },
      );
      return capabilities;
    });
  }

  /** Submit a polar job → 202 with a job_id. */
  submitPolar(
    request: PolarRequest,
    opts?: EngineCallOptions,
  ): Promise<JobStatus> {
    const requestWithExpectedEngine = this.requestWithExpectedEngine(request);
    const expectedEngine = requestWithExpectedEngine.expected_engine!;
    return this.json<JobStatus>(
      "/polars",
      opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS,
      {
        method: "POST",
        body: JSON.stringify(requestWithExpectedEngine),
      },
    ).then((status) => {
      this.verifyEngineAcknowledgement(status, "POST /polars", expectedEngine, {
        requireRequestedAck: true,
        expectedExecutionPool:
          requestWithExpectedEngine.expected_execution_pool,
        requireRuntime: status.state !== "pending",
        requireExecutionPool: status.state !== "pending",
      });
      return status;
    });
  }

  getJob(jobId: string, opts?: EngineCallOptions): Promise<JobStatus> {
    return this.json<JobStatus>(
      `/jobs/${encodeURIComponent(jobId)}`,
      opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS,
    ).then((status) => {
      this.verifyEngineAcknowledgement(
        status,
        `GET /jobs/${jobId}`,
        opts?.expectedEngine,
        {
          requireRequestedAck: Boolean(opts?.expectedEngine),
          expectedExecutionPool: opts?.expectedExecutionPool,
          requireRuntime:
            Boolean(opts?.expectedEngine) && status.state !== "pending",
          requireExecutionPool:
            Boolean(opts?.expectedExecutionPool) && status.state !== "pending",
        },
      );
      return status;
    });
  }

  cancelJob(
    jobId: string,
    opts?: EngineCallOptions,
  ): Promise<{ job_id: string; cancelled: boolean }> {
    return this.json<{ job_id: string; cancelled: boolean }>(
      `/jobs/${encodeURIComponent(jobId)}/cancel`,
      opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS,
      { method: "POST", body: "{}" },
    );
  }

  getQueue(opts?: EngineCallOptions): Promise<EngineQueueState> {
    return this.json<EngineQueueState>(
      "/queue",
      opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS,
    );
  }

  /** Mesh/seed cache stats scanned from the engine's cache volume. */
  cacheStats(opts?: EngineCallOptions): Promise<EngineCacheStats> {
    return this.json<EngineCacheStats>(
      "/cache/stats",
      opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS,
    );
  }

  stripJob(
    jobId: string,
    request: EngineStripJobRequest = {},
    opts?: EngineCallOptions,
  ): Promise<EngineStripJobResponse> {
    return this.json<EngineStripJobResponse>(
      `/jobs/${encodeURIComponent(jobId)}/strip`,
      opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  deleteJob(
    jobId: string,
    opts?: EngineCallOptions,
  ): Promise<EngineDeleteJobResponse> {
    return this.json<EngineDeleteJobResponse>(
      `/jobs/${encodeURIComponent(jobId)}`,
      opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS,
      {
        method: "DELETE",
      },
    );
  }

  finalizeRemoteEvidence(
    jobId: string,
    request: FinalizeRemoteEvidenceRequest,
    opts?: EngineCallOptions,
  ): Promise<FinalizeRemoteEvidenceResponse> {
    if (!this.controlPlaneToken) {
      throw new EngineError(
        "ENGINE_CONTROL_PLANE_TOKEN is required for remote evidence cleanup",
        undefined,
        "evidence_cleanup_auth_missing",
      );
    }
    return this.json<FinalizeRemoteEvidenceResponse>(
      `/jobs/${encodeURIComponent(jobId)}/evidence/finalize-remote`,
      opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.controlPlaneToken}` },
        body: JSON.stringify(request),
      },
    );
  }

  verifyRemoteEvidenceManifest(
    request: VerifyRemoteEvidenceManifestRequest,
    opts?: EngineCallOptions,
  ): Promise<VerifyRemoteEvidenceManifestResponse> {
    if (!this.controlPlaneToken) {
      throw new EngineError(
        "ENGINE_CONTROL_PLANE_TOKEN is required for remote evidence verification",
        undefined,
        "evidence_verification_auth_missing",
      );
    }
    return this.json<unknown>(
      "/internal/evidence-archives/verify-manifest",
      opts?.timeoutMs ?? ENGINE_EVIDENCE_VERIFY_TIMEOUT_MS,
      {
        method: "POST",
        headers: { authorization: `Bearer ${this.controlPlaneToken}` },
        body: JSON.stringify(request),
      },
    ).then((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new EngineError(
          "remote evidence verification returned a malformed response",
          undefined,
          "evidence_verification_identity_mismatch",
        );
      }
      const response = raw as Record<string, unknown>;
      const remote = response.remote;
      const remoteKeys = [
        "schemaVersion",
        "format",
        "bucket",
        "objectKey",
        "generation",
        "storedSha256",
        "storedSize",
        "tarSha256",
        "tarSize",
        "crc32c",
        "zstdLevel",
        "createdAt",
      ] as const;
      const remoteMatches =
        remote != null &&
        typeof remote === "object" &&
        !Array.isArray(remote) &&
        remoteKeys.every(
          (key) =>
            (remote as Record<string, unknown>)[key] === request.remote[key],
        );
      if (
        response.state !== "verified" ||
        !remoteMatches ||
        response.manifestSha256 !== request.manifestSha256 ||
        response.manifestByteSize !== request.manifestByteSize ||
        response.manifestMemberSetSha256 !== request.manifestMemberSetSha256 ||
        response.manifestMemberCount !== request.manifestMemberCount
      ) {
        throw new EngineError(
          "remote evidence verification did not bind the exact pointer and manifest identities",
          undefined,
          "evidence_verification_identity_mismatch",
        );
      }
      return response as unknown as VerifyRemoteEvidenceManifestResponse;
    });
  }

  maintenanceJobs(
    opts?: EngineCallOptions,
  ): Promise<EngineMaintenanceJobsResponse> {
    return this.json<EngineMaintenanceJobsResponse>(
      "/maintenance/jobs",
      opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS,
    );
  }

  maintenanceDisk(
    opts?: EngineCallOptions,
  ): Promise<EngineMaintenanceDiskResponse> {
    return this.json<EngineMaintenanceDiskResponse>(
      "/maintenance/disk",
      opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS,
    );
  }

  getJobRuntimes(
    jobIds: string[],
    opts?: EngineCallOptions,
  ): Promise<JobRuntimeResponse> {
    return this.json<JobRuntimeResponse>(
      "/jobs/runtime",
      opts?.timeoutMs ?? ENGINE_POLL_TIMEOUT_MS,
      {
        method: "POST",
        body: JSON.stringify({ job_ids: jobIds }),
      },
    );
  }

  /** Published result snapshot. The API returns 409 until the first case is
   *  published, then serves state=running partials before the terminal result.
   *  The payload can be MBs of polar/frame evidence — budgeted like a submit,
   *  not a poll. */
  getResult(jobId: string, opts?: EngineCallOptions): Promise<JobResult> {
    return this.json<JobResult>(
      `/jobs/${encodeURIComponent(jobId)}/result`,
      opts?.timeoutMs ?? ENGINE_SUBMIT_TIMEOUT_MS,
    ).then((result) => {
      this.verifyEngineAcknowledgement(
        result,
        `GET /jobs/${jobId}/result`,
        opts?.expectedEngine,
        {
          requireRequestedAck: Boolean(opts?.expectedEngine),
          requireRuntime: Boolean(opts?.expectedEngine),
          expectedExecutionPool: opts?.expectedExecutionPool,
          requireExecutionPool: Boolean(opts?.expectedExecutionPool),
        },
      );
      for (const polar of result.polars) {
        for (const point of [...polar.points, ...(polar.attempts ?? [])]) {
          if (point.engine != null) {
            this.verifyEngineAcknowledgement(
              point,
              `GET /jobs/${jobId}/result point ${point.case_slug ?? point.aoa_deg}`,
              opts?.expectedEngine,
              { requireRuntime: Boolean(opts?.expectedEngine) },
            );
          }
        }
      }
      return result;
    });
  }

  renderField(
    jobId: string,
    request: RenderFieldRequest,
    opts?: EngineCallOptions,
  ): Promise<RenderFieldResponse> {
    return this.json<RenderFieldResponse>(
      `/jobs/${encodeURIComponent(jobId)}/render-field`,
      opts?.timeoutMs ?? ENGINE_RENDER_TIMEOUT_MS,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  computeFieldExtents(
    jobId: string,
    request: FieldExtentsRequest,
    opts?: EngineCallOptions,
  ): Promise<FieldExtentsResponse> {
    return this.json<FieldExtentsResponse>(
      `/jobs/${encodeURIComponent(jobId)}/field-extents`,
      opts?.timeoutMs ?? ENGINE_RENDER_TIMEOUT_MS,
      { method: "POST", body: JSON.stringify(request) },
    );
  }

  renderDefaultMedia(
    jobId: string,
    request: RenderDefaultMediaRequest,
    opts?: EngineCallOptions,
  ): Promise<RenderDefaultMediaResponse> {
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
