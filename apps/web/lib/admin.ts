import type {
  BoundaryConditionDTO,
  CategoryNode,
  HashtagDTO,
  MediumDTO,
  ViscosityModelName,
  ViscosityTablePointDTO,
} from "@aerodb/core";
import {
  buildResultReviewPayload,
  type ResultReviewRecord,
  type ResultReviewVerdict,
} from "./result-review";

const BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/** Thrown by aj() on non-2xx: message = server {error}; status + body kept so
 *  callers (e.g. campaign 409 stale-diff dialogs) can read refreshed payloads. */
export interface AdminApiError extends Error {
  status: number;
  body: Record<string, unknown>;
}

export function isAdminApiError(e: unknown): e is AdminApiError {
  return (
    e instanceof Error &&
    typeof (e as AdminApiError).status === "number" &&
    typeof (e as AdminApiError).body === "object"
  );
}

async function aj<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const res = await fetch(BASE + path, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { error?: string };
    throw Object.assign(
      new Error(e.error || `request failed (${res.status})`),
      {
        status: res.status,
        body: e as Record<string, unknown>,
      },
    );
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export interface AdminMe {
  authed: boolean;
  mode: "dev" | "prod";
  email: string | null;
  provider?: "password" | "google" | null;
  providers?: {
    google: boolean;
    password: boolean;
  };
  google?: {
    enabled: boolean;
    allowedDomain: string;
    loginUrl: string;
  };
}
export interface AdminHealthSample {
  at: string;
  cpu: {
    load1: number;
    load5: number;
    load15: number;
    availableCpus: number;
    loadPct: number;
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPct: number;
  };
  storage: {
    path: string;
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usedPct: number;
  } | null;
  storageError: string | null;
}

export type AdminSolverIncidentStage = "rans" | "preliminary" | "final";
export type AdminSolverIncidentSeverity = "warning" | "critical";

/** Sanitized safety-stop context carried by high-frequency campaign polling.
 * Exact incident ids, errors and capacity snapshots remain on the dedicated
 * authenticated sweeper endpoint. */
export interface AdminAdmissionFenceContext {
  stage?: "rans" | "preliminary" | "final";
  fidelity?: "precalc" | "full";
}

export interface AdminSolverIncidentGroup {
  stage: AdminSolverIncidentStage;
  reason: string;
  solverImplementationId: string;
  solverImplementationKey: string;
  remediationVersion: string;
  occurrenceCount: number;
  openCount: number;
  openCriticalCount: number;
  firstOccurredAt: string;
  lastOccurredAt: string;
  requiresInvestigation: boolean;
  effectiveSeverity: AdminSolverIncidentSeverity;
}

export interface AdminSolverIncidentSummary {
  /** Repeated physical incidents at or above this count require investigation. */
  threshold: number;
  occurrenceCount: number;
  openCount: number;
  criticalGroupCount: number;
  groups: AdminSolverIncidentGroup[];
}

export interface AdminHealth {
  asOf: string;
  sampleIntervalSeconds: number;
  windowHours: number;
  current: AdminHealthSample;
  averages24h: {
    sampleCount: number;
    coverageSeconds: number;
    firstSampleAt: string | null;
    cpuLoad1: number | null;
    cpuLoadPct: number | null;
    memoryUsedPct: number | null;
  };
  history: AdminHealthSample[];
  /** Durable screening/preliminary/final solver reliability incidents.
   * Normal aerodynamic RANS handoff is deliberately absent from this model. */
  solverIncidents: AdminSolverIncidentSummary;
}
export interface SweeperState {
  enabled: boolean;
  maxConcurrentJobs: number;
  /** THE single global solver-capacity setting; 0 = auto (no cpu cap sent). */
  cpuSlots: number;
  pollIntervalMs: number;
  submitIntervalMs: number;
  heartbeatAt: string | null;
  engineUnreachableSince: string | null;
  /** Tick-progress pair (liveness/progress split, migration 0033): stamped by
   *  the sweeper loop at tick begin/end; null pre-migration. */
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  diskAdmissionBlocked?: boolean;
  diskAdmissionReason?: string | null;
  diskUsedPct?: number | null;
  diskFreeBytes?: number | null;
  diskRequiredFreeBytes?: number | null;
  diskCheckedAt?: string | null;
  admissionFenceActive?: boolean;
  lastAdmissionFenceAt?: string | null;
  lastAdmissionFenceReason?: string | null;
  lastAdmissionFenceTriggerKey?: string | null;
  lastAdmissionFenceDetails?: Record<string, unknown> | null;
}
export interface AdminJob {
  id: string;
  status: string;
  wave: number;
  kind: "sweep-rans" | "point-rans" | "point-urans";
  methodKey: string | null;
  solverImplementation: {
    id: string;
    key: string;
    family: string;
    distribution: string;
    releaseVersion: string;
    numericsRevision: string;
    adapterContractVersion: number;
  } | null;
  solverRuntimeBuild: {
    id: string;
    buildId: string;
    sourceRevision: string | null;
    imageDigest: string | null;
    applicationSourceSha256: string | null;
    packageSha256: string | null;
    binarySha256: string | null;
    architecture: string | null;
  } | null;
  solverExecutionPool: {
    id: string;
    slug: string;
    name: string;
    routingKey: string;
  } | null;
  engineJobId: string | null;
  engineState: string | null;
  totalCases: number;
  completedCases: number;
  airfoilName: string | null;
  airfoilSlug: string | null;
  bcName: string | null;
  bcSlug: string | null;
  mediumName: string | null;
  mediumSlug: string | null;
  reynolds: number | null;
  mach: number | null;
  speedMps: number | null;
  referenceChordM: number | null;
  temperatureK: number | null;
  pressurePa: number | null;
  turbulenceModel: string | null;
  turbulenceIntensity: number | null;
  viscosityRatio: number | null;
  schedulingPolicy: string;
  cpuBudget: number | null;
  caseConcurrency: number | null;
  solverProcesses: number | null;
  workerCpuBudget: number | null;
  meshBuildCount: number | null;
  aoaCaseCount: number | null;
  /** Batched campaign jobs (conditionMap): Reynolds range + bundled speed
   *  count; null for single-speed jobs. */
  reynoldsMin: number | null;
  reynoldsMax: number | null;
  speedCount: number | null;
  /** Pinned-detail evidence links (campaign spec §11): the job's single setup
   *  revision (→ /airfoils/<slug>?revision=<uuid>); null for multi-revision
   *  batched jobs, whose detail links stay unpinned. */
  revisionId: string | null;
  error: string | null;
  createdAt: string;
  submittedAt: string | null;
  finishedAt: string | null;
  pendingAgeSec: number;
  stale: boolean;
  engineQueueMatch: boolean;
  runtimeState: string;
  staleReason: string | null;
  processCount: number;
  resultReady: boolean;
  statusReadError: string | null;
  resultReadError: string | null;
  processes: {
    pid: number;
    command?: string | null;
    cwd?: string | null;
    case_slug?: string | null;
    solver_mode?: string | null;
    elapsed_sec?: number | null;
  }[];
  activePids: number[];
  phase: string | null;
  phaseStartedAt: string | null;
  lastProgressAt: string | null;
  activeSolver: string | null;
  activeCaseSlug: string | null;
  activeAoaDeg: number | null;
  cpuTokensWaiting: number | null;
  cpuTokensHeld: number | null;
  resultCount: number;
  solvedCount: number;
  failedCount: number;
  aoaMin: number | null;
  aoaMax: number | null;
  clMax: number | null;
  cdMin: number | null;
  ldMax: number | null;
  /** Campaign chip (admin payload only, spec §10); null for continuous work. */
  campaignId: string | null;
  campaignSlug: string | null;
  campaignName: string | null;
  jobKind: "sweep" | "targeted";
}

export interface EngineTaskSummary {
  worker: string;
  task_id: string | null;
  name: string | null;
  job_id: string | null;
  redelivered: boolean;
  time_start?: number | null;
}

export interface EngineQueueState {
  queue_depth: number | null;
  active: EngineTaskSummary[];
  reserved: EngineTaskSummary[];
  scheduled: EngineTaskSummary[];
  active_count: number;
  reserved_count: number;
  scheduled_count: number;
  job_ids: string[];
  duplicates: Record<string, number>;
  redelivered: EngineTaskSummary[];
}

export interface AdminPendingSweep {
  airfoilId: string;
  airfoilSlug: string;
  airfoilName: string;
  categoryName: string;
  categoryPath: string;
  bcId: string;
  bcSlug: string;
  bcName: string;
  mediumSlug: string;
  mediumName: string;
  reynolds: number;
  mach: number | null;
  speedMps: number;
  referenceChordM: number;
  temperatureK: number;
  pressurePa: number;
  turbulenceModel: string;
  turbulenceIntensity: number;
  viscosityRatio: number;
  schedulingPolicy: string;
  cpuBudget: number | null;
  caseConcurrency: number | null;
  solverProcesses: number | null;
  aoaCount: number;
  aoaMin: number;
  aoaMax: number;
  aoas: number[];
  status: string;
  priority: number;
  kind: "sweep-rans" | "point-rans" | "point-urans";
  requestedAt: string | null;
}
export interface AdminExternalPromise {
  id: string;
  sourceInstanceId: string | null;
  sourceInstanceName: string | null;
  status: string;
  expiresAt: string | null;
  createdAt: string | null;
  airfoilSlug: string;
  airfoilName: string;
  reynolds: number;
  mach: number | null;
  aoaCount: number;
  aoaMin: number;
  aoaMax: number;
}
export interface AdminCampaignBacklogEntry {
  id: string;
  slug: string;
  name: string;
  status: string;
  priority: number;
  remainingPoints: number;
  failedPoints: number;
  blockedPoints?: number;
  runningPoints: number;
}

export interface AdminQueueBacklogStrip {
  campaigns: AdminCampaignBacklogEntry[];
  /** Cached gap-fill counters served with the time they were computed; null
   *  until the first gap scan ever completes (shown as "not computed yet"). */
  backgroundGapFill: {
    pendingPoints: number;
    pendingSweeps: number;
    computedAt: string;
  } | null;
}

/** Disk truth from the engine's GET /cache/stats (mesh/seed cache volume);
 *  null when the engine endpoint is unreachable or errors — never invented. */
export interface AdminEngineCacheStats {
  meshEntries: number;
  seedEntries: number;
  totalBytes: number;
  capBytes: number;
  oldestLastUsedAt: string | null;
}

/** Tab-scoped queue fetches (spec §10/§12): the payload always has the full
 *  AdminQueue shape, but sections outside the requested scope come back null —
 *  a section is either present-and-real or explicitly absent, never invented.
 *  - activity   → sweeper + backlogStrip + jobs/activeJobs/finishedJobs +
 *                 results + cached engine chips
 *  - background → pendingSweeps + externalPromises (+ sweeper)
 *  - engine     → engine health/queue/cache + activeJobs (+ sweeper)
 *  - all        → everything (back-compat default) */
export type AdminQueueScope = "activity" | "background" | "engine" | "all";

export interface AdminQueue {
  scope: AdminQueueScope;
  mode: "dev" | "prod";
  engineUrl: string;
  sweeper: SweeperState;
  /** true while sweeper.cpuSlots is 0 (auto — no cpu cap sent to the engine). */
  cpuSlotsAuto: boolean;
  engineUnreachableSince: string | null;
  backlogStrip: AdminQueueBacklogStrip | null;
  backlog: number | null;
  inFlight: number | null;
  results: Record<string, number> | null;
  /** Results solved since the start of the current server day (activity scope
   *  only; null outside it). Drives the "N solved today" badge — hidden at 0. */
  solvedToday: number | null;
  pendingPointsTotal: number | null;
  pendingSweepsTotal: number | null;
  pendingSweeps: AdminPendingSweep[] | null;
  externalPromises: AdminExternalPromise[] | null;
  engineQueue: EngineQueueState | null;
  engineQueueError: string | null;
  engineHealth: {
    status: string;
    version: string;
    build_id?: string | null;
    package_file?: string | null;
  } | null;
  engineHealthError: string | null;
  engineExpectedBuildId: string | null;
  engineBuildId: string | null;
  engineBuildMismatch: boolean;
  engineCache: AdminEngineCacheStats | null;
  /** When the per-job runtime annotations were actually fetched from the
   *  engine; stale-while-refresh may serve an older snapshot — this timestamp
   *  is its true fetch time. null = no runtime data (jobs annotate unknown). */
  engineRuntimeAsOf: string | null;
  engineRuntimeError: string | null;
  activeJobs: AdminJob[] | null;
  finishedJobs: AdminJob[] | null;
  jobs: AdminJob[] | null;
}

/** Merge a scoped queue payload over the previously known one. Only sections
 *  covered by the incoming scope are overwritten (including with null/error
 *  values — a fresh "unavailable" must replace stale data). Sections outside
 *  the scope keep their previous values; the UI only renders those on their
 *  own tabs, where that tab's scope poll refreshes them. */
export function mergeAdminQueue(
  prev: AdminQueue | null,
  next: AdminQueue,
): AdminQueue {
  if (!prev || next.scope === "all") return next;
  const merged: AdminQueue = { ...prev };
  // Shell state ships with every scope.
  merged.scope = next.scope;
  merged.mode = next.mode;
  merged.engineUrl = next.engineUrl;
  merged.sweeper = next.sweeper;
  merged.cpuSlotsAuto = next.cpuSlotsAuto;
  merged.engineUnreachableSince = next.engineUnreachableSince;
  const activity = next.scope === "activity";
  const background = next.scope === "background";
  const engineScope = next.scope === "engine";
  if (activity) {
    merged.backlogStrip = next.backlogStrip;
    merged.results = next.results;
    merged.solvedToday = next.solvedToday;
    merged.jobs = next.jobs;
    merged.finishedJobs = next.finishedJobs;
  }
  if (activity || background) {
    merged.backlog = next.backlog;
    merged.pendingPointsTotal = next.pendingPointsTotal;
    merged.pendingSweepsTotal = next.pendingSweepsTotal;
  }
  if (background) {
    merged.pendingSweeps = next.pendingSweeps;
    merged.externalPromises = next.externalPromises;
  }
  if (activity || engineScope) {
    merged.activeJobs = next.activeJobs;
    merged.inFlight = next.inFlight;
    merged.engineQueue = next.engineQueue;
    merged.engineQueueError = next.engineQueueError;
    merged.engineHealth = next.engineHealth;
    merged.engineHealthError = next.engineHealthError;
    merged.engineExpectedBuildId = next.engineExpectedBuildId;
    merged.engineBuildId = next.engineBuildId;
    merged.engineBuildMismatch = next.engineBuildMismatch;
    merged.engineRuntimeAsOf = next.engineRuntimeAsOf;
    merged.engineRuntimeError = next.engineRuntimeError;
  }
  if (engineScope) {
    merged.engineCache = next.engineCache;
  }
  return merged;
}

export type SyncDataType =
  | "sweeps"
  | "airfoils"
  | "catalog_metadata"
  | "mediums"
  | "simulation_setup"
  | "polars"
  | "evidence_artifacts"
  | "result_media";
export interface AdminSyncPermission {
  dataType: SyncDataType;
  canFetch: boolean;
  canPush: boolean;
}
export interface AdminSyncConflict {
  id: string;
  dataType: SyncDataType;
  naturalKey: string;
  sourceInstanceId: string | null;
  sourceInstanceName: string | null;
  incomingPayload: Record<string, unknown>;
  localSnapshot: Record<string, unknown> | null;
  artifactManifest: Record<string, unknown> | null;
  createdAt: string | null;
}
export interface AdminRegisteredSolver {
  id: string;
  instanceId: string;
  instanceName: string;
  publicEndpoint: string | null;
  localEndpoint: string | null;
  cpuCapacity: number;
  cpuBudget: number;
  buildVersion: string | null;
  status: string;
  lastHeartbeatAt: string | null;
  activePromiseCount: number;
  activeAoaCount: number;
  solvedCount: number;
  pushedCount: number;
  recentError: string | null;
  updatedAt: string | null;
}
export interface AdminSyncState {
  settings: {
    enabled: boolean;
    instanceId: string;
    instanceName: string;
    publicEndpointOverride: string | null;
    publicEndpoint: string;
    secret: string;
    defaultPromiseTtlHours: number;
    upstreamBaseUrl: string | null;
    upstreamSecret: string | null;
    syncMode: "full" | "db_only_remote_assets";
    remoteSolverEnabled: boolean;
    remoteSolverCpuBudget: number;
    remoteSolverClaimSize: number;
    remoteSolverHeartbeatIntervalSeconds: number;
    remoteSolverRegisteredId: string | null;
    remoteSolverLastSyncAt: string | null;
    remoteSolverLastPromiseAt: string | null;
    remoteSolverLastPushAt: string | null;
    remoteSolverLastStatus: string;
    remoteSolverLastError: string | null;
  };
  permissions: AdminSyncPermission[];
  promises: {
    byStatus: Record<string, number>;
    pointsByStatus: Record<string, number>;
  };
  registeredSolvers: AdminRegisteredSolver[];
  remoteAssets: {
    byAvailability: Record<string, number>;
  };
  conflicts: AdminSyncConflict[];
}

export const adminMe = () => aj<AdminMe>("/api/admin/me");
export const adminLogin = (email: string, password: string) =>
  aj<{ ok: boolean }>("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
export const adminGoogleLoginUrl = (returnTo = "/admin") =>
  `${BASE}/api/admin/oauth/google?returnTo=${encodeURIComponent(returnTo)}`;
export const adminLogout = () =>
  aj<{ ok: boolean }>("/api/admin/logout", { method: "POST" });
export const getAdminHealth = () => aj<AdminHealth>("/api/admin/health");
export const getAdminQueue = (scope: AdminQueueScope = "all") =>
  aj<AdminQueue>(`/api/admin/queue${scope === "all" ? "" : `?scope=${scope}`}`);

/** One REAL solved result row (results: status=done, source=solved, solvedAt
 *  set) — derived/mirrored display points are never listed here. */
export interface AdminSolvedPoint {
  resultId: string;
  simJobId: string | null;
  airfoilSlug: string;
  airfoilName: string;
  aoaDeg: number;
  speed: number | null;
  reynolds: number | null;
  cl: number | null;
  cd: number | null;
  clCd: number | null;
  classificationState: string | null;
  solvedAt: string;
}
export interface AdminSolvedPointsPage {
  items: AdminSolvedPoint[];
  /** Keyset cursor (`solvedAtISO|resultId`) for the next page; null at the end. */
  nextCursor: string | null;
  /** Count of solved results for the current server day, over the SAME scope
   *  (jobId or global) as items — the count always accompanies its rows. */
  solvedToday: number;
}
export const getSolvedPoints = (
  opts: { jobId?: string | null; cursor?: string | null; limit?: number } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.jobId) qs.set("jobId", opts.jobId);
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.limit != null) qs.set("limit", String(opts.limit));
  const suffix = qs.toString();
  return aj<AdminSolvedPointsPage>(
    `/api/admin/solved-points${suffix ? `?${suffix}` : ""}`,
  );
};
// ---- Point History Explorer (Solver ▸ Points tab) ----
export const getPointHistory = (
  opts: {
    status?: string;
    airfoil?: string;
    campaignId?: string;
    regime?: string;
    errorClass?: string;
    reynolds?: string;
    verify?: string;
    cursor?: string | null;
    limit?: number;
    facets?: boolean;
  } = {},
) => {
  const qs = new URLSearchParams();
  if (opts.status && opts.status !== "all") qs.set("status", opts.status);
  if (opts.airfoil?.trim()) qs.set("airfoil", opts.airfoil.trim());
  if (opts.campaignId) qs.set("campaignId", opts.campaignId);
  if (opts.regime) qs.set("regime", opts.regime);
  if (opts.errorClass) qs.set("errorClass", opts.errorClass);
  if (opts.reynolds) qs.set("reynolds", opts.reynolds);
  if (opts.verify) qs.set("verify", opts.verify);
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.limit != null) qs.set("limit", String(opts.limit));
  if (opts.facets) qs.set("facets", "true");
  const suffix = qs.toString();
  return aj<import("./point-history").PointHistoryPagePayload>(
    `/api/admin/point-history${suffix ? `?${suffix}` : ""}`,
  );
};
export const getPointStory = (resultId: string) =>
  aj<import("./point-history").PointStoryPayload>(
    `/api/admin/point-history/${encodeURIComponent(resultId)}/story`,
  );
export const requeuePoint = (resultId: string) =>
  aj<{ requeued: 1; scope: "failed" | "rejected"; campaignIds: string[] }>(
    `/api/admin/point-history/${encodeURIComponent(resultId)}/requeue`,
    { method: "POST", body: JSON.stringify({}) },
  );

// ---- Fidelity ladder: admin request-URANS (contract 6) ----
export interface AdminLadderSubmitRetry {
  id: string;
  state: "retry_wait" | "blocked";
  attemptCount: number;
  nextAttemptAt: string | null;
  latestSimJobId: string | null;
  lastHttpStatus: number | null;
  lastError: string;
  createdAt: string;
  updatedAt: string;
}

/** One sim_urans_requests row: an admin work item the scheduler runs at
 *  precalc rank. aoaDeg null = whole polar. */
export interface AdminUransRequest {
  id: string;
  airfoilId: string;
  revisionId: string;
  aoaDeg: number | null;
  fidelity: "precalc" | "full" | string;
  state: "pending" | "running" | "done" | "blocked" | "cancelled" | string;
  simJobId: string | null;
  continueFromResultId: string | null;
  continueFromResultAttemptId: string | null;
  backgroundOwner: boolean;
  requestedBy: string | null;
  independentOwner: boolean;
  campaignOwners: Array<{ campaignId: string; state: string }>;
  submitRetry: AdminLadderSubmitRetry | null;
  createdAt: string;
  updatedAt: string;
}

/** One sim_urans_verify_queue row (contract 4) for the cell scope. */
export interface AdminUransVerifyItem {
  id: string;
  airfoilId: string;
  revisionId: string;
  aoaDeg: number;
  backgroundOwner: boolean;
  campaignOwners: Array<{ campaignId: string; state: string }>;
  state:
    | "pending"
    | "running"
    | "done"
    | "disagreed"
    | "blocked"
    | "cancelled"
    | string;
  precalcResultId: string;
  verifyResultId: string | null;
  deltaCl: number | null;
  deltaCd: number | null;
  deltaCm: number | null;
  submitRetry: AdminLadderSubmitRetry | null;
  createdAt: string;
  updatedAt: string;
}

/** Idempotent per (cell, fidelity): created=false replays the open item. */
export const requestUrans = (body: {
  airfoilId: string;
  revisionId: string;
  aoaDeg?: number;
  fidelity: "precalc" | "full";
}) =>
  aj<{ request: AdminUransRequest; created: boolean }>(
    "/api/admin/urans-requests",
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

/** Continuation (amendment C): resume a budget-stopped URANS solve from its
 *  saved engine case state with an increased wall-clock budget. The server
 *  derives cell/angle/fidelity from the SOURCE results row; idempotent like
 *  requestUrans (created=false replays the open item). */
export const continueUransResult = (
  resultId: string,
  resultAttemptId: string,
  budgetOverrideS: number,
) =>
  aj<{ request: AdminUransRequest; created: boolean }>(
    "/api/admin/urans-requests",
    {
      method: "POST",
      body: JSON.stringify({
        continueFromResultId: resultId,
        continueFromResultAttemptId: resultAttemptId,
        budgetOverrideS,
      }),
    },
  );

export const reviewResult = (
  resultId: string,
  verdict: ResultReviewVerdict,
  note: string,
) =>
  aj<{ review: ResultReviewRecord }>(
    `/api/admin/results/${encodeURIComponent(resultId)}/review`,
    {
      method: "POST",
      body: JSON.stringify(buildResultReviewPayload(verdict, note)),
    },
  );

export const deleteResultReview = (resultId: string) =>
  aj<void>(`/api/admin/results/${encodeURIComponent(resultId)}/review`, {
    method: "DELETE",
  });

export const getResultReviews = (resultId: string) =>
  aj<{ items: ResultReviewRecord[] }>(
    `/api/admin/results/${encodeURIComponent(resultId)}/reviews`,
  );

/** Bulk continuation: queue a resume for every unavailable row with saved,
 *  restartable solver state
 *  (optionally scoped to one campaign) with the same budget override. The
 *  server recomputes membership and excludes non-continuable rows (crashes or
 *  rejections without restartable state); replays are idempotent; conflicted =
 *  cells whose open request is NOT this row's continuation. */
export const bulkContinueUrans = (
  campaignId: string | null,
  budgetOverrideS: number,
) =>
  aj<{
    continuable: number;
    created: number;
    reused: number;
    conflicted: number;
  }>("/api/admin/urans-requests/bulk-continue", {
    method: "POST",
    body: JSON.stringify({
      ...(campaignId ? { campaignId } : {}),
      budgetOverrideS,
    }),
  });

/** Open/settled request items + verify-queue items for one cell scope — the
 *  action surfaces read this to render idempotent-aware button state. */
export const getUransRequests = (airfoilId: string, revisionId: string) =>
  aj<{ requests: AdminUransRequest[]; verifyItems: AdminUransVerifyItem[] }>(
    `/api/admin/urans-requests?airfoilId=${encodeURIComponent(airfoilId)}&revisionId=${encodeURIComponent(revisionId)}`,
  );

export const getAdminSync = () => aj<AdminSyncState>("/api/admin/sync");
export const patchAdminSync = (
  body: Partial<AdminSyncState["settings"]> & {
    permissions?: AdminSyncPermission[];
  },
) =>
  aj<AdminSyncState>("/api/admin/sync", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
export const runUpstreamSync = (body: {
  mode?: "full" | "db_only_remote_assets";
  types?: SyncDataType[];
  limit?: number;
}) =>
  aj<
    AdminSyncState & {
      lastRun?: {
        imported: number;
        conflicts: string[];
        mode: string;
        sourceInstanceId: string;
      };
    }
  >("/api/admin/sync/upstream/run", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const archiveSyncConflict = (id: string) =>
  aj<AdminSyncState>(
    `/api/admin/sync/conflicts/${encodeURIComponent(id)}/archive`,
    { method: "POST", body: JSON.stringify({}) },
  );
export const promoteSyncConflict = (id: string) =>
  aj<AdminSyncState>(
    `/api/admin/sync/conflicts/${encodeURIComponent(id)}/promote`,
    { method: "POST", body: JSON.stringify({}) },
  );
export const patchSweeper = (
  b: Partial<
    Pick<
      SweeperState,
      | "enabled"
      | "maxConcurrentJobs"
      | "cpuSlots"
      | "pollIntervalMs"
      | "submitIntervalMs"
    >
  >,
) =>
  aj<SweeperState>("/api/admin/sweeper", {
    method: "PATCH",
    body: JSON.stringify(b),
  });
export const recoverStaleJobs = (olderThanMinutes = 30) =>
  aj<{
    recovered: number;
    requeuedResults: number;
    requeued: number;
    keptRunning: number;
    markedIngesting: number;
    unchanged: number;
  }>("/api/admin/jobs/recover-stale", {
    method: "POST",
    body: JSON.stringify({ olderThanMinutes }),
  });
export const purgeTestArtifacts = (prefix: string) =>
  aj<{ purged: Record<string, number> }>("/api/admin/test-artifacts/purge", {
    method: "POST",
    body: JSON.stringify({ prefix }),
  });
export const cancelJob = (id: string) =>
  aj<{ cancelled: boolean }>(
    `/api/admin/jobs/${encodeURIComponent(id)}/cancel`,
    { method: "POST" },
  );

export interface MediumInput {
  slug?: string;
  name: string;
  phase: "gas" | "liquid";
  density: number;
  refTemperatureK: number;
  refPressurePa: number;
  viscosityModel: ViscosityModelName;
  constantDynamicViscosity?: number | null;
  sutherlandMuRef?: number | null;
  sutherlandTRef?: number | null;
  sutherlandS?: number | null;
  viscosityTable?: ViscosityTablePointDTO[];
  speedOfSound?: number | null;
  notes?: string | null;
}

export interface AdminBoundaryCondition extends BoundaryConditionDTO {
  sandGrainHeight: number;
  roughnessConstant: number;
  mesher: string;
  farfieldRadiusChords: number;
  wakeLengthChords: number;
  nSurface: number;
  nRadial: number;
  nWake: number;
  targetYPlus: number;
  spanChords: number;
  nIterations: number;
  convergenceTolerance: number;
  momentumScheme: string;
  transientCycles: number;
  transientDiscardFraction: number;
  transientMaxCourant: number;
  writeImages: string[];
  imageZoomChords: number;
  createdAt: string;
  updatedAt: string;
}

export type BoundaryConditionInput = Omit<
  AdminBoundaryCondition,
  | "id"
  | "slug"
  | "mediumSlug"
  | "mediumName"
  | "reynolds"
  | "mach"
  | "density"
  | "dynamicViscosity"
  | "kinematicViscosity"
  | "createdAt"
  | "updatedAt"
> & {
  slug?: string;
};

export const getAdminMediums = () =>
  aj<{ items: MediumDTO[] }>("/api/admin/mediums");
export const createAdminMedium = (body: MediumInput) =>
  aj<MediumDTO>("/api/admin/mediums", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateAdminMedium = (id: string, body: Partial<MediumInput>) =>
  aj<MediumDTO>(`/api/admin/mediums/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
export const getAdminBoundaryConditions = () =>
  aj<{ items: AdminBoundaryCondition[] }>("/api/admin/boundary-conditions");
export const createAdminBoundaryCondition = (body: BoundaryConditionInput) =>
  aj<AdminBoundaryCondition>("/api/admin/boundary-conditions", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateAdminBoundaryCondition = (
  id: string,
  body: Partial<BoundaryConditionInput>,
) =>
  aj<AdminBoundaryCondition>(
    `/api/admin/boundary-conditions/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );

export interface AdminFlowCondition {
  id: string;
  slug: string;
  name: string;
  mediumId: string;
  mediumSlug: string;
  mediumName: string;
  temperatureK: number;
  pressurePa: number;
  speedMps: number;
  density: number;
  dynamicViscosity: number;
  kinematicViscosity: number;
  mach: number | null;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminReferenceGeometryProfile {
  id: string;
  slug: string;
  name: string;
  geometryType: string;
  referenceLengthKind: string;
  referenceLengthM: number;
  spanM: number | null;
  referenceAreaM2: number | null;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminBoundaryProfile {
  id: string;
  slug: string;
  name: string;
  turbulenceIntensity: number;
  viscosityRatio: number;
  sandGrainHeight: number;
  roughnessConstant: number;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminMeshProfile {
  id: string;
  slug: string;
  name: string;
  mesher: string;
  farfieldRadiusChords: number;
  wakeLengthChords: number;
  nSurface: number;
  nRadial: number;
  nWake: number;
  targetYPlus: number;
  spanChords: number;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSolverImplementation {
  id: string;
  key: string;
  family: string;
  distribution: string;
  releaseVersion: string;
  methodFamily: string;
  adapterContractVersion: number;
  numericsRevision: string;
  capabilities: Record<string, unknown>;
  upstreamUrl: string | null;
  licenseSpdx: string | null;
  retiredAt: string | null;
  createdAt?: string;
}

export interface AdminSolverExecutionPool {
  id: string;
  slug: string;
  name: string;
  solverImplementationId: string;
  routingKey: string;
  capacityKind: string;
  capacityLimit: number | null;
  enabled: boolean;
  metadata: Record<string, unknown>;
  implementation: AdminSolverImplementation | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSolverProfile {
  id: string;
  solverImplementationId: string;
  implementation: AdminSolverImplementation | null;
  slug: string;
  name: string;
  turbulenceModel: string;
  nIterations: number;
  convergenceTolerance: number;
  momentumScheme: string;
  transientCycles: number;
  transientDiscardFraction: number;
  transientMaxCourant: number;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSchedulingProfile {
  id: string;
  slug: string;
  name: string;
  schedulingPolicy: "auto" | "airfoil_parallel" | "case_parallel" | "exclusive";
  cpuBudget: number | null;
  caseConcurrency: number | null;
  solverProcesses: number | null;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminOutputProfile {
  id: string;
  slug: string;
  name: string;
  writeImages: string[];
  imageZoomChords: number;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSweepDefinition {
  id: string;
  slug: string;
  name: string;
  aoaStart: number;
  aoaStop: number;
  aoaStep: number;
  aoaList: number[] | null;
  isSeeded: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminSimulationPreset {
  id: string;
  slug: string;
  name: string;
  flowConditionId: string;
  referenceGeometryProfileId: string;
  boundaryProfileId: string;
  meshProfileId: string;
  solverProfileId: string;
  schedulingProfileId: string;
  outputProfileId: string;
  sweepDefinitionId: string;
  legacyBoundaryConditionId: string | null;
  currentRevisionId: string | null;
  currentRevisionNumber: number | null;
  signatureHash: string | null;
  targetScope: "all" | "airfoils";
  targetAirfoilIds: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAirfoilOption {
  id: string;
  slug: string;
  name: string;
  /** Real geometric property computed from stored coordinates (spec §9.1). */
  isSymmetric: boolean;
}

export interface AdminSimulationSetup {
  flowConditions: AdminFlowCondition[];
  referenceGeometryProfiles: AdminReferenceGeometryProfile[];
  boundaryProfiles: AdminBoundaryProfile[];
  meshProfiles: AdminMeshProfile[];
  solverImplementations: AdminSolverImplementation[];
  solverExecutionPools: AdminSolverExecutionPool[];
  solverProfiles: AdminSolverProfile[];
  schedulingProfiles: AdminSchedulingProfile[];
  outputProfiles: AdminOutputProfile[];
  sweepDefinitions: AdminSweepDefinition[];
  airfoilOptions: AdminAirfoilOption[];
  simulationPresets: AdminSimulationPreset[];
}

export type FlowConditionInput = Pick<
  AdminFlowCondition,
  "name" | "mediumId" | "temperatureK" | "pressurePa" | "speedMps"
> & { slug?: string };
export type ReferenceGeometryProfileInput = Pick<
  AdminReferenceGeometryProfile,
  | "name"
  | "geometryType"
  | "referenceLengthKind"
  | "referenceLengthM"
  | "spanM"
  | "referenceAreaM2"
> & { slug?: string };
export type BoundaryProfileInput = Pick<
  AdminBoundaryProfile,
  | "name"
  | "turbulenceIntensity"
  | "viscosityRatio"
  | "sandGrainHeight"
  | "roughnessConstant"
> & { slug?: string };
export type MeshProfileInput = Pick<
  AdminMeshProfile,
  | "name"
  | "mesher"
  | "farfieldRadiusChords"
  | "wakeLengthChords"
  | "nSurface"
  | "nRadial"
  | "nWake"
  | "targetYPlus"
  | "spanChords"
> & { slug?: string };
export type SolverProfileInput = Pick<
  AdminSolverProfile,
  | "name"
  | "solverImplementationId"
  | "turbulenceModel"
  | "nIterations"
  | "convergenceTolerance"
  | "momentumScheme"
  | "transientCycles"
  | "transientDiscardFraction"
  | "transientMaxCourant"
> & { slug?: string };
export type SchedulingProfileInput = Pick<
  AdminSchedulingProfile,
  | "name"
  | "schedulingPolicy"
  | "cpuBudget"
  | "caseConcurrency"
  | "solverProcesses"
> & { slug?: string };
export type OutputProfileInput = Pick<
  AdminOutputProfile,
  "name" | "writeImages" | "imageZoomChords"
> & { slug?: string };
export type SweepDefinitionInput = Pick<
  AdminSweepDefinition,
  "name" | "aoaStart" | "aoaStop" | "aoaStep" | "aoaList"
> & {
  slug?: string;
};
export type SimulationPresetInput = Pick<
  AdminSimulationPreset,
  | "name"
  | "flowConditionId"
  | "referenceGeometryProfileId"
  | "boundaryProfileId"
  | "meshProfileId"
  | "solverProfileId"
  | "schedulingProfileId"
  | "outputProfileId"
  | "sweepDefinitionId"
  | "targetScope"
  | "targetAirfoilIds"
  | "enabled"
> & { slug?: string };

export const getAdminSimulationSetup = () =>
  aj<AdminSimulationSetup>("/api/admin/simulation-setup");
export const createFlowCondition = (body: FlowConditionInput) =>
  aj<AdminFlowCondition>("/api/admin/flow-conditions", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateFlowCondition = (
  id: string,
  body: Partial<FlowConditionInput>,
) =>
  aj<AdminFlowCondition>(
    `/api/admin/flow-conditions/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
export const deleteFlowCondition = (id: string) =>
  aj<{ ok: true }>(`/api/admin/flow-conditions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
export const createReferenceGeometryProfile = (
  body: ReferenceGeometryProfileInput,
) =>
  aj<AdminReferenceGeometryProfile>("/api/admin/reference-geometry-profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateReferenceGeometryProfile = (
  id: string,
  body: Partial<ReferenceGeometryProfileInput>,
) =>
  aj<AdminReferenceGeometryProfile>(
    `/api/admin/reference-geometry-profiles/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
export const deleteReferenceGeometryProfile = (id: string) =>
  aj<{ ok: true }>(
    `/api/admin/reference-geometry-profiles/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
export const createBoundaryProfile = (body: BoundaryProfileInput) =>
  aj<AdminBoundaryProfile>("/api/admin/boundary-profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateBoundaryProfile = (
  id: string,
  body: Partial<BoundaryProfileInput>,
) =>
  aj<AdminBoundaryProfile>(
    `/api/admin/boundary-profiles/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
export const deleteBoundaryProfile = (id: string) =>
  aj<{ ok: true }>(`/api/admin/boundary-profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
export const createMeshProfile = (body: MeshProfileInput) =>
  aj<AdminMeshProfile>("/api/admin/mesh-profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateMeshProfile = (
  id: string,
  body: Partial<MeshProfileInput>,
) =>
  aj<AdminMeshProfile>(`/api/admin/mesh-profiles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
export const deleteMeshProfile = (id: string) =>
  aj<{ ok: true }>(`/api/admin/mesh-profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
export const createSolverProfile = (body: SolverProfileInput) =>
  aj<AdminSolverProfile>("/api/admin/solver-profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateSolverProfile = (
  id: string,
  body: Partial<SolverProfileInput>,
) =>
  aj<AdminSolverProfile>(
    `/api/admin/solver-profiles/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
export const deleteSolverProfile = (id: string) =>
  aj<{ ok: true }>(`/api/admin/solver-profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
export const updateSolverExecutionPool = (
  id: string,
  body: { enabled?: boolean; capacityLimit?: number | null },
) =>
  aj<AdminSolverExecutionPool>(
    `/api/admin/solver-execution-pools/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
export const createSchedulingProfile = (body: SchedulingProfileInput) =>
  aj<AdminSchedulingProfile>("/api/admin/scheduling-profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateSchedulingProfile = (
  id: string,
  body: Partial<SchedulingProfileInput>,
) =>
  aj<AdminSchedulingProfile>(
    `/api/admin/scheduling-profiles/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
export const deleteSchedulingProfile = (id: string) =>
  aj<{ ok: true }>(`/api/admin/scheduling-profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
export const createOutputProfile = (body: OutputProfileInput) =>
  aj<AdminOutputProfile>("/api/admin/output-profiles", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateOutputProfile = (
  id: string,
  body: Partial<OutputProfileInput>,
) =>
  aj<AdminOutputProfile>(
    `/api/admin/output-profiles/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
export const deleteOutputProfile = (id: string) =>
  aj<{ ok: true }>(`/api/admin/output-profiles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
export const createSweepDefinition = (body: SweepDefinitionInput) =>
  aj<AdminSweepDefinition>("/api/admin/sweep-definitions", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateSweepDefinition = (
  id: string,
  body: Partial<SweepDefinitionInput>,
) =>
  aj<AdminSweepDefinition>(
    `/api/admin/sweep-definitions/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );
export const deleteSweepDefinition = (id: string) =>
  aj<{ ok: true }>(`/api/admin/sweep-definitions/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
export const createSimulationPreset = (body: SimulationPresetInput) =>
  aj<AdminSimulationPreset>("/api/admin/simulation-presets", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateSimulationPreset = (
  id: string,
  body: Partial<SimulationPresetInput>,
) =>
  aj<AdminSimulationPreset>(
    `/api/admin/simulation-presets/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(body) },
  );

export interface AdminCategoryInput {
  name: string;
  parentId?: string | null;
  description?: string | null;
  sortOrder?: number;
}

export interface AdminCategoryRow {
  id: string;
  slug: string;
  name: string;
  parentId: string | null;
  path: string;
  depth: number;
  sortOrder: number;
  description: string | null;
}

export const getAdminCategoryTree = () =>
  aj<CategoryNode[]>("/api/admin/categories/tree");
export const createAdminCategory = (body: AdminCategoryInput) =>
  aj<AdminCategoryRow>("/api/admin/categories", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const updateAdminCategory = (
  id: string,
  body: Partial<AdminCategoryInput>,
) =>
  aj<AdminCategoryRow>(`/api/admin/categories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
export const reorderAdminCategory = (body: {
  draggedId: string;
  targetId: string;
  position: "before" | "inside" | "after";
}) =>
  aj<CategoryNode[]>("/api/admin/categories/reorder", {
    method: "POST",
    body: JSON.stringify(body),
  });
export const deleteAdminCategory = (id: string) =>
  fetch(`${BASE}/api/admin/categories/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  }).then(async (res) => {
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error || `delete failed (${res.status})`);
    }
  });

export const getAdminHashtags = () =>
  aj<{ items: HashtagDTO[] }>("/api/admin/hashtags");
export const createAdminHashtag = (name: string) =>
  aj<HashtagDTO>("/api/admin/hashtags", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
export const updateAdminHashtag = (id: string, name: string) =>
  aj<HashtagDTO>(`/api/admin/hashtags/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
export const deleteAdminHashtag = (id: string) =>
  fetch(`${BASE}/api/admin/hashtags/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  }).then(async (res) => {
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(e.error || `delete failed (${res.status})`);
    }
  });

export type BulkAirfoilAction =
  | "move"
  | "archive"
  | "remove"
  | "restore"
  | "assignHashtags"
  | "removeHashtags";
export const bulkAirfoils = (body: {
  ids: string[];
  action: BulkAirfoilAction;
  categoryId?: string;
  hashtagIds?: string[];
}) =>
  aj<{ ok: boolean; updated: number }>("/api/admin/airfoils/bulk", {
    method: "POST",
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// Simulation campaigns (spec docs/simulation-campaigns-spec.md §10/§11).
// Types mirror the apps/api/src/campaign-routes.ts payloads exactly; functions
// wrap aj<T>() like every other admin client above.
// ---------------------------------------------------------------------------

export type CampaignObjectiveKey = "ld_max" | "cl_zero" | "cl_max";
export type CampaignErrorClass =
  | "mesh"
  | "diverged"
  | "timeout"
  | "engine"
  | "cancelled"
  | "solver"
  | "unknown";

export interface CampaignProgressTotals {
  requested: number;
  solved: number;
  failed: number;
  running: number;
  superseded: number;
  derived: number;
  /** Terminal-done points whose result classified 'rejected' (physics-invalid
   *  evidence): settled but NOT solved — surfaced like failed. */
  rejected: number;
  /** Terminal machine-owned PRECALC obligations whose bounded attempts are
   *  exhausted or deterministically blocked. Never a review count. */
  blocked?: number;
  remaining: number;
}

export type CampaignRemediationReason =
  | "mesh_quality"
  | "precalc_attempts_exhausted"
  | "engine_submit_rejected"
  | "other_unavailable";

export interface CampaignRemediationSummary {
  /** Open automatic mesh recovery; excluded from the blocked total. */
  repairing: number;
  /** Exact sum of terminal remediation groups and campaign totals.blocked. */
  blocked: number;
  /** Bounded reason model: never carries raw errors, job ids, or batch ids. */
  groups: Array<{
    reason: CampaignRemediationReason;
    state: "repairing" | "blocked";
    /** Campaign recovery is always system-owned; terminal means unavailable,
     * never that a user must alter an internal solver setup. */
    owner: "system";
    points: number;
  }>;
}

/** Rolling-compatibility ladder split. `awaitingUrans` is machine-owned stage-2
 *  work. `needsReview` is retained as a legacy wire key, but the canonical
 *  server predicate is empty; clients must describe any nonzero old payload as
 *  unavailable evidence, not as a promise of human review. */
export interface CampaignReviewBuckets {
  awaitingUrans: number;
  needsReview: number;
}

export interface CampaignObjectivePlanInput {
  enabled: boolean;
  /** Canonical 2-decimal degree string, e.g. "0.10". */
  toleranceDeg: string;
  maxRounds: number;
}

export interface CampaignPlanNumericsInput {
  boundaryProfileId: string;
  meshProfileId: string;
  solverProfileId: string;
  outputProfileId: string;
  /** null/absent = engine derives the full URANS mesh from the RANS mesh. */
  uransMeshProfileId?: string | null;
  /** null/absent = engine derives the precalc URANS mesh at half resolution. */
  uransPrecalcMeshProfileId?: string | null;
}

/** Spec §3.1 plan jsonb shape — all values are canonical decimal strings. */
export interface CampaignPlanInput {
  mediumId: string;
  /** [T_K, P_Pa] canonical strings, sorted ascending. */
  ambients: Array<[string, string]>;
  speedsMps: string[];
  chordsM: string[];
  spanM: string;
  areaMode: "derived" | "explicit";
  areaM2: string | null;
  /** [T, P, speed, chord] canonical strings (click-to-exclude cells). */
  excludedConditions: Array<[string, string, string, string]>;
  baseSweep: {
    fromDeg: string | null;
    toDeg: string | null;
    stepDeg: string | null;
    listDeg: string[] | null;
  };
  /** clMax is optional: plan revisions stored before the third objective have
   *  no block for it — readers must treat absence as disabled. */
  objectives: {
    ldMax: CampaignObjectivePlanInput;
    clZero: CampaignObjectivePlanInput;
    clMax?: CampaignObjectivePlanInput;
  };
  numerics: CampaignPlanNumericsInput;
}

export interface AdminCampaignListItem {
  id: string;
  slug: string;
  name: string;
  status: string;
  priority: number;
  notes: string | null;
  closedWithFailedCount: number | null;
  closedWithRejectedCount: number | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  conditionCount: number;
  airfoilCount: number;
  excludedAirfoilCount: number;
  latestLifecycleEvent: {
    action: string;
    actor: string | null;
    reason: string | null;
    createdAt: string;
  } | null;
  totals: CampaignProgressTotals;
  remediation: CampaignRemediationSummary;
  reviewBuckets?: CampaignReviewBuckets;
  automaticPrecalcOpen: number;
}

export interface AdminCampaignConditionSummary {
  id: string;
  ord: number;
  status: "active" | "kept" | "released" | string;
  flowConditionId: string;
  referenceGeometryProfileId: string;
  presetId: string;
  presetSlug: string;
  presetName: string;
  presetOrigin: string;
  revisionId: string;
  revisionNumber: number;
  reynolds: number;
  mach: number | null;
  temperatureK: number | null;
  pressurePa: number | null;
  speedMps: number | null;
  chordM: number | null;
  drift: boolean;
  gainedEvidenceAfterRelease: boolean;
  counters: CampaignProgressTotals;
  reviewBuckets?: CampaignReviewBuckets;
}

/** Mirrors GET /api/admin/campaigns/:id (campaignSummary + scheduler + rate). */
export interface AdminCampaignSummary {
  campaign: {
    id: string;
    slug: string;
    name: string;
    notes: string | null;
    status: string;
    priority: number;
    idempotencyKey: string;
    closedWithFailedCount: number | null;
    closedWithRejectedCount: number | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
    planRevisionNumber: number;
    plan: CampaignPlanInput;
    rateBaselineAt: string | null;
  };
  totals: CampaignProgressTotals;
  remediation: CampaignRemediationSummary;
  /** Rolling-compatibility ladder split. Optional: older APIs omit it. */
  reviewBuckets?: CampaignReviewBuckets;
  /** Fidelity ladder per-tier open counts (contract 7). Optional: older API
   *  payloads omit it — render nothing, never invented zeros. */
  tierCounts?: { ransOpen: number; precalcOpen: number; verifyOpen: number };
  /** Derived ladder phase (contract 7): running_rans → running_precalc →
   *  running_refinement → completed; null for paused/cancelled/archived. */
  phase?:
    | "running_rans"
    | "running_precalc"
    | "running_refinement"
    | "completed"
    | null;
  /** Campaign-scoped screening/preliminary/final reliability incidents. */
  solverIncidents: AdminSolverIncidentSummary;
  airfoilCount: number;
  excludedAirfoilCount: number;
  latestLifecycleEvent: AdminCampaignListItem["latestLifecycleEvent"];
  conditions: AdminCampaignConditionSummary[];
  lanesSummary: Record<string, Record<string, number>>;
  scheduler: {
    sweeperEnabled: boolean;
    cpuSlots: number;
    heartbeatAt: string | null;
    engineHealthy: boolean;
    engineCheckedAt: string;
    engineError: string | null;
    engineUnreachableSince: string | null;
    campaignJobsRunning: number;
    /** Tick-progress pair (liveness/progress split, migration 0033). */
    lastTickStartedAt: string | null;
    lastTickCompletedAt: string | null;
    diskAdmissionBlocked?: boolean;
    diskAdmissionReason?: string | null;
    diskUsedPct?: number | null;
    diskFreeBytes?: number | null;
    diskRequiredFreeBytes?: number | null;
    diskCheckedAt?: string | null;
    admissionFenceActive?: boolean;
    lastAdmissionFenceAt?: string | null;
    lastAdmissionFenceReason?: string | null;
    lastAdmissionFenceDetails?: AdminAdmissionFenceContext | null;
  };
  rate: {
    pointsLast24h: number;
    windowHours: 24;
    baselineAt: string | null;
    measuredSince: string;
    remainingPoints: number;
  } | null;
}

export interface AdminCampaignAirfoilRow {
  airfoilId: string;
  slug: string;
  name: string;
  isSymmetric: boolean;
  /** Per-cell rolling-compatibility counters; optional for older payloads. */
  perCondition: Array<
    { conditionId: string } & CampaignProgressTotals &
      Partial<CampaignReviewBuckets>
  >;
}

export interface AdminCampaignFailureGroup {
  errorClass: CampaignErrorClass;
  count: number;
  retryableCount: number;
  samples: Array<{
    resultId: string;
    conditionId: string;
    airfoilId: string;
    airfoilSlug: string;
    airfoilName: string;
    aoaDeg: number;
    error: string | null;
    attempts: number;
    retryable: boolean;
  }>;
}

export type AdminCampaignPreliminaryOutcomeKind =
  | "accepted"
  | "recovering"
  | "evidence_unavailable"
  | "continuation_unavailable"
  | "mesh_unavailable"
  | "submit_unavailable"
  | "recovery_unavailable";

export type AdminCampaignPreliminaryFastState =
  | "not_started"
  | "queued"
  | "running"
  | "accepted"
  | "critical";

export type AdminCampaignPreliminaryRansStage =
  | "screened"
  | "attempted"
  | "polar_handoff"
  | "skipped"
  | "not_started";

export type AdminCampaignPreliminaryFinalState =
  | "not_started"
  | "queued"
  | "running"
  | "accepted"
  | "critical";

export type AdminCampaignPreliminaryFinalActivityState =
  | "queued"
  | "running"
  | "critical";

export interface AdminCampaignPreliminaryOutcome {
  aoaDeg: number;
  sourceAoaDeg: number;
  derivedBySymmetry: boolean;
  affectedAoaDegs: number[];
  affectedPointCount: number;
  state: "pending" | "running" | "satisfied" | "blocked";
  outcome: AdminCampaignPreliminaryOutcomeKind;
  ransStage: AdminCampaignPreliminaryRansStage;
  fastState: AdminCampaignPreliminaryFastState;
  finalState: AdminCampaignPreliminaryFinalState;
  finalActivityState: AdminCampaignPreliminaryFinalActivityState | null;
  finalComparison: "within_tolerance" | "disagreed" | null;
  finalDeltaCl: number | null;
  finalDeltaCd: number | null;
  finalDeltaCm: number | null;
  finalSource: "verify" | "full_request" | null;
  criticalStage: "preflight" | "rans" | "fast" | "final" | null;
  fastResultId: string | null;
  fastResultAttemptId: string | null;
  finalResultId: string | null;
  finalResultAttemptId: string | null;
  finalEvidenceReasons: string[];
  finalSubmitError: string | null;
  finalSubmitHttpStatus: number | null;
  physicalAttemptsUsed: number;
  physicalAttemptsMax: number;
  recoverySubmissions: number;
  nonPhysicalSubmissions: number;
  interruptedPhysicalRuns: number;
  /** Stored RANS result-attempt/evidence records, not necessarily physical
   * solver runs. */
  ransEvidenceRuns: number;
  preliminaryEvidenceRuns: number;
  fullUransEvidenceRuns: number;
  legacyUransEvidenceRuns: number;
  evidenceReasons: string[];
  updatedAt: string;
}

export interface AdminCampaignPreliminaryOutcomes {
  total: number;
  recovering: number;
  critical: number;
  unavailable: number;
  verified: number;
  items: AdminCampaignPreliminaryOutcome[];
}

export interface AdminCampaignRejectedSample {
  resultId: string;
  conditionId: string;
  airfoilId: string;
  airfoilSlug: string;
  airfoilName: string;
  aoaDeg: number;
  reasons: string[];
  attempts: number;
}

export interface AdminCampaignRejected {
  total: number;
  samples: AdminCampaignRejectedSample[];
}

export interface AdminCampaignLane {
  campaignId: string;
  airfoilId: string;
  airfoilSlug: string;
  airfoilName: string;
  conditionId: string;
  conditionOrd: number;
  conditionStatus: string;
  reynolds: number;
  objective: string;
  state: string;
  currentTargetAlpha: number | null;
  iterationCount: number;
  extraRoundsGranted: number;
  witnessFitSetId: string | null;
  updatedAt: string;
}

export interface AdminCampaignLaneDetail {
  lane: {
    campaignId: string;
    airfoilId: string;
    conditionId: string;
    objective: CampaignObjectiveKey;
    state: string;
    currentTargetAlpha: number | null;
    iterationCount: number;
    extraRoundsGranted: number;
    witnessFitSetId: string | null;
    createdAt: string;
    updatedAt: string;
  };
  steps: Array<{
    iteration: number;
    predictedAlpha: number;
    fitSetId: string;
    solvedResultId: string | null;
    outcome: "predicted" | "solved" | "superseded" | "released" | string;
    createdAt: string;
    solved: {
      aoaDeg: number | null;
      cl: number | null;
      cd: number | null;
      status: string | null;
    } | null;
  }>;
}

/** Plan-edit preview diff (spec §6.1) — classifyPlanChange minus `internal`. */
export interface CampaignPlanDiff {
  basePlanRevisionNumber: number;
  newPlan: CampaignPlanInput;
  diffHash: string;
  addedConditions: Array<{
    comboKey: string;
    temperatureK: string;
    pressurePa: string;
    speedMps: string;
    chordM: string;
  }>;
  reactivatedConditions: Array<{
    conditionId: string;
    comboKey: string;
    previousStatus: string;
  }>;
  keptConditions: Array<{
    conditionId: string;
    comboKey: string;
    solvedAngles: number[];
    releasedPoints: number;
    keptOpenPoints: number;
  }>;
  releasedConditions: Array<{
    conditionId: string;
    comboKey: string;
    releasedPoints: number;
  }>;
  addedAngles: number[];
  removedAngles: number[];
  removedAngleKeptCells: number;
  removedAngleReleasedPoints: number;
  addedPoints: number;
  addedSolverRuns: number;
  reactivatedPoints: number;
  cancelledPoints: number;
  pendingResultDeletes: number;
  runningOnRemoved: number;
  objectiveDeltas: Array<{
    objective: CampaignObjectiveKey;
    changes: Array<
      | "enabled"
      | "disabled"
      | "tolerance_tightened"
      | "tolerance_loosened"
      | "rounds_changed"
    >;
    toleranceDeg: string;
  }>;
  valueDiffs: Record<string, { added: string[]; removed: string[] }>;
}

export interface CampaignLaunchInput {
  name: string;
  notes?: string | null;
  priority: number;
  /** Client-generated at Review (crypto.randomUUID). */
  idempotencyKey: string;
  airfoilIds: string[];
  plan: CampaignPlanInput;
  markStaleAndResolve?: boolean;
}

export interface CampaignLaunchResponse {
  campaign: {
    id: string;
    slug: string;
    name: string;
    status: string;
    priority: number;
  };
  replayed: boolean;
  totals: CampaignProgressTotals;
  conditionCount: number;
  presetsCreated: number;
  linkedSolver: number;
  linkedDerived: number;
  staleMarked: number;
}

export interface CampaignReusePreviewCondition {
  comboKey: string;
  temperatureK: string;
  pressurePa: string;
  speedMps: string;
  chordM: string;
  revisionId: string | null;
  presetId: string | null;
  reynolds: number;
  solvedPoints: number;
}

export type CampaignReusePreview =
  | {
      status: "ok";
      totalPoints: number;
      totalSolverRuns: number;
      derivedPoints: number;
      reusedPoints: number;
      allSolved: boolean;
      conditions: CampaignReusePreviewCondition[];
    }
  | { status: "timeout" };

/** POST …/duplicate payload — a wizard prefill; the API creates nothing. */
export interface CampaignDuplicatePrefill {
  name: string;
  notes: string | null;
  priority: number;
  airfoilIds: string[];
  plan: CampaignPlanInput;
}

export interface CampaignAddAirfoilsPreview {
  diffHash: string;
  newAirfoilIds: string[];
  alreadyIncluded: string[];
  addedPoints: number;
  addedSolverRuns: number;
  perCondition: Array<{
    conditionId: string;
    status: string;
    cellCount: number;
  }>;
}

export interface CampaignPlanApplyResult {
  status: "applied";
  planRevisionNumber: number;
  addedPoints: number;
  reactivatedPoints: number;
  cancelledPoints: number;
  pendingResultDeletes: number;
  totals: CampaignProgressTotals;
}

export type CampaignLifecycleVerb =
  | "pause"
  | "resume"
  | "cancel"
  | "close-with-failures"
  | "archive";

export interface CampaignLaneKey {
  airfoilId: string;
  conditionId: string;
  objective: CampaignObjectiveKey;
}

/** Global solver-state block on GET /api/admin/campaigns (pinned contract):
 *  sweeper_state row + active sim_jobs count + the queue endpoint's cached
 *  engine-health probe — no extra probes, nothing invented. */
export interface AdminCampaignsSolverState {
  heartbeatAt: string | null;
  enabled: boolean;
  engineUnreachableSince: string | null;
  engineHealthy: boolean;
  activeJobCount: number;
  /** Tick-progress pair (liveness/progress split, migration 0033). */
  lastTickStartedAt: string | null;
  lastTickCompletedAt: string | null;
  diskAdmissionBlocked?: boolean;
  diskAdmissionReason?: string | null;
  diskUsedPct?: number | null;
  diskFreeBytes?: number | null;
  diskRequiredFreeBytes?: number | null;
  diskCheckedAt?: string | null;
  admissionFenceActive?: boolean;
  lastAdmissionFenceAt?: string | null;
  lastAdmissionFenceReason?: string | null;
  lastAdmissionFenceDetails?: AdminAdmissionFenceContext | null;
}

export const listCampaigns = (params?: {
  statuses?: string[];
  limit?: number;
  offset?: number;
}) => {
  const qs = new URLSearchParams();
  if (params?.statuses?.length) qs.set("status", params.statuses.join(","));
  if (params?.limit != null) qs.set("limit", String(params.limit));
  if (params?.offset != null) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return aj<{
    items: AdminCampaignListItem[];
    total: number;
    solverState: AdminCampaignsSolverState;
  }>(`/api/admin/campaigns${suffix}`);
};

export const getCampaign = (id: string) =>
  aj<AdminCampaignSummary>(`/api/admin/campaigns/${encodeURIComponent(id)}`);

export const getCampaignAirfoils = (
  id: string,
  cursor?: string | null,
  limit = 25,
) => {
  const qs = new URLSearchParams({ limit: String(limit) });
  if (cursor) qs.set("cursor", cursor);
  return aj<{ items: AdminCampaignAirfoilRow[]; nextCursor: string | null }>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/airfoils?${qs.toString()}`,
  );
};

export const getCampaignFailures = (
  id: string,
  opts?: { conditionId?: string; airfoilId?: string },
) => {
  const qs = new URLSearchParams();
  if (opts?.conditionId) qs.set("conditionId", opts.conditionId);
  if (opts?.airfoilId) qs.set("airfoilId", opts.airfoilId);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return aj<{
    total: number;
    retryableTotal: number;
    groups: AdminCampaignFailureGroup[];
    rejected: AdminCampaignRejected;
  }>(`/api/admin/campaigns/${encodeURIComponent(id)}/failures${suffix}`);
};

export const getCampaignPreliminaryOutcomes = (
  id: string,
  opts: {
    conditionId: string;
    airfoilId: string;
    signal?: AbortSignal;
  },
) => {
  const qs = new URLSearchParams({
    conditionId: opts.conditionId,
    airfoilId: opts.airfoilId,
  });
  return aj<AdminCampaignPreliminaryOutcomes>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/preliminary-outcomes?${qs.toString()}`,
    { signal: opts.signal },
  );
};

export const getCampaignLanes = (
  id: string,
  opts?: {
    objective?: CampaignObjectiveKey;
    state?: string;
    cursor?: string | null;
    limit?: number;
  },
) => {
  const qs = new URLSearchParams();
  if (opts?.objective) qs.set("objective", opts.objective);
  if (opts?.state) qs.set("state", opts.state);
  if (opts?.cursor) qs.set("cursor", opts.cursor);
  if (opts?.limit != null) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return aj<{ items: AdminCampaignLane[]; nextCursor: string | null }>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/lanes${suffix}`,
  );
};

export const getCampaignLaneDetail = (
  id: string,
  airfoilId: string,
  conditionId: string,
  objective: CampaignObjectiveKey,
) =>
  aj<AdminCampaignLaneDetail>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/lanes/${encodeURIComponent(airfoilId)}/${encodeURIComponent(conditionId)}/${encodeURIComponent(objective)}`,
  );

export const previewCampaign = (input: {
  plan: CampaignPlanInput;
  airfoilIds: string[];
}) =>
  aj<CampaignReusePreview>("/api/admin/campaigns/preview", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const launchCampaign = (input: CampaignLaunchInput) =>
  aj<CampaignLaunchResponse>("/api/admin/campaigns", {
    method: "POST",
    body: JSON.stringify(input),
  });

export const previewCampaignPlan = (
  id: string,
  body: { plan: CampaignPlanInput; basePlanRevisionNumber: number },
) =>
  aj<CampaignPlanDiff>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/plan/preview`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

export const applyCampaignPlan = (
  id: string,
  body: {
    plan: CampaignPlanInput;
    basePlanRevisionNumber: number;
    diffHash: string;
  },
) =>
  aj<CampaignPlanApplyResult>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/plan/apply`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );

export const previewCampaignAirfoils = (id: string, airfoilIds: string[]) =>
  aj<CampaignAddAirfoilsPreview>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/airfoils`,
    {
      method: "POST",
      body: JSON.stringify({ airfoilIds, mode: "preview" }),
    },
  );

export const addCampaignAirfoils = (
  id: string,
  body: { airfoilIds: string[]; diffHash: string },
) =>
  aj<{
    status: "applied";
    addedAirfoils: number;
    addedPoints: number;
    totals: CampaignProgressTotals;
  }>(`/api/admin/campaigns/${encodeURIComponent(id)}/airfoils`, {
    method: "POST",
    body: JSON.stringify({
      airfoilIds: body.airfoilIds,
      mode: "apply",
      diffHash: body.diffHash,
    }),
  });

export const campaignVerb = (id: string, verb: CampaignLifecycleVerb) =>
  aj<
    {
      campaign?: { id: string; status: string } & Record<string, unknown>;
    } & Record<string, unknown>
  >(`/api/admin/campaigns/${encodeURIComponent(id)}/${verb}`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const forceReleaseCondition = (
  id: string,
  conditionId: string,
  body: { expectedCancelledPoints?: number },
) =>
  aj<{
    planRevisionNumber: number;
    cancelledPoints: number;
    totals: CampaignProgressTotals;
  }>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/conditions/${encodeURIComponent(conditionId)}/force-release`,
    { method: "POST", body: JSON.stringify(body) },
  );

export const restoreCondition = (id: string, conditionId: string) =>
  aj<CampaignPlanApplyResult>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/conditions/${encodeURIComponent(conditionId)}/restore`,
    { method: "POST", body: JSON.stringify({}) },
  );

export const continueLane = (
  id: string,
  laneKey: CampaignLaneKey,
  extraRounds: number,
) =>
  aj<{ lane: AdminCampaignLaneDetail["lane"] }>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/lanes/${encodeURIComponent(laneKey.airfoilId)}/${encodeURIComponent(laneKey.conditionId)}/${encodeURIComponent(laneKey.objective)}/continue`,
    { method: "POST", body: JSON.stringify({ extraRounds }) },
  );

export const requeueCampaignFailed = (
  id: string,
  body: {
    errorClasses?: CampaignErrorClass[];
    conditionId?: string;
    airfoilId?: string;
    expectedCount: number;
    includeRejected?: boolean;
    expectedRejectedCount?: number;
  },
) =>
  aj<{
    requeued: number;
    requeuedFailed: number;
    requeuedRejected: number;
    totals: CampaignProgressTotals;
  }>(`/api/admin/campaigns/${encodeURIComponent(id)}/requeue-failed`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getCampaignDuplicatePrefill = (id: string) =>
  aj<CampaignDuplicatePrefill>(
    `/api/admin/campaigns/${encodeURIComponent(id)}/duplicate`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
