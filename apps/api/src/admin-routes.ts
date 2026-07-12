import {
  ALL_IMAGE_FIELDS,
  airfoilHashtags,
  airfoils,
  type Category,
  categories,
  boundaryConditions,
  boundaryProfiles,
  flowConditions,
  hashtags,
  mediumViscosityTablePoints,
  mediums,
  meshProfiles,
  operatingConditions,
  outputProfiles,
  referenceGeometryProfiles,
  results,
  schedulingProfiles,
  simJobs,
  simLadderSubmitRetries,
  simulationPresetAirfoilTargets,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  sweeperState,
  sweepDefinitions,
  campaignBacklogStrip,
  claimSimJobCancellation,
  createUransRequest,
  outsideLiveSimJobIngestLeaseWhere,
  PrecalcObligationTerminalConflict,
  refreshPrecalcSettlementCampaigns,
  purgeSyncSweepPromisesInTransaction,
  settlePrecalcObligationsForJobInTransaction,
  UransRequestCoverageConflict,
  type DB,
  listContinuableNeedsReview,
  simUransRequests,
  simUransRequestCampaigns,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  syncLegacyBoundaryConditionForPreset as syncLegacyBoundaryConditionForPresetDb,
} from "@aerodb/db";
import { DEFAULT_TRANSIENT_MAX_COURANT } from "@aerodb/core";
import { releaseResultClaimsForJob } from "@aerodb/db/result-claim-lifecycle";
import {
  ensureEnabledSimulationPresetRevisions,
  ensureSimulationPresetRevision,
} from "@aerodb/db/simulation-setup";
import {
  EngineClient,
  EngineError,
  classifyQueueLifecycle,
  type EngineCacheStats,
  type EngineQueueState,
  type JobRuntimeSummary,
} from "@aerodb/engine-client";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  like,
  or,
  sql,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  authMode,
  adminAuthProviders,
  checkCredentials,
  COOKIE_NAME,
  GOOGLE_STATE_COOKIE_NAME,
  googleAllowedDomain,
  googleAuthorizationUrl,
  googleOAuthConfigured,
  googleSessionFromCode,
  requireAdmin,
  sessionEmail,
  signOAuthState,
  signSession,
  verifyOAuthState,
  verifySession,
} from "./admin-auth";
import { db } from "./db";
import { env } from "./env";
import { categoriesTree } from "./services/catalog";
import {
  hashtagsByAirfoilIds,
  listHashtags,
  slugifyHashtag,
  toHashtagDTO,
} from "./services/hashtags";
import {
  deriveBcState,
  deriveFlowState,
  mediumViscosityColumns,
  mediumViscosityInputFromMedium,
  resolveViscosity,
  tablePointsDTO,
  toMediumDTO,
} from "./services/mediums";
import {
  startSystemHealthSampler,
  systemHealthSnapshot,
} from "./services/system-health";
import {
  readSweeperState,
  SWEEPER_STATE_DEFAULTS,
  type SweeperStateRow,
  writeSweeperState,
} from "./services/sweeper-state";

const imageFieldName = z.enum(ALL_IMAGE_FIELDS);

function slugifyCategory(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "category"
  );
}

function slugifyGeneric(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "item"
  );
}

async function uniqueCategorySlug(base: string): Promise<string> {
  let slug = base;
  let n = 2;
  for (let i = 0; i < 1000; i++) {
    const [exists] = await db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, slug))
      .limit(1);
    if (!exists) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

async function categoryPlacement(
  parentId: string | null | undefined,
  slug: string,
) {
  if (!parentId) return { parentId: null, path: slug, depth: 0 };
  const [parent] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, parentId))
    .limit(1);
  if (!parent) throw new Error("parent category not found");
  return {
    parentId: parent.id,
    path: `${parent.path}/${slug}`,
    depth: parent.depth + 1,
  };
}

async function moveCategorySubtree(
  current: Category,
  parentId: string | null | undefined,
): Promise<string | null> {
  if (parentId === current.id)
    throw new Error("category cannot be moved into itself");
  const placement = await categoryPlacement(parentId, current.slug);
  if (
    placement.path === current.path ||
    placement.path.startsWith(current.path + "/")
  ) {
    throw new Error("category cannot be moved into its own descendant");
  }
  const subtree = await db
    .select({ id: categories.id, path: categories.path })
    .from(categories)
    .where(
      or(
        eq(categories.id, current.id),
        like(categories.path, current.path + "/%"),
      ),
    );
  for (const row of subtree) {
    const suffix = row.path.slice(current.path.length);
    const path = placement.path + suffix;
    await db
      .update(categories)
      .set({
        path,
        depth: path.split("/").length - 1,
        parentId: row.id === current.id ? placement.parentId : undefined,
      })
      .where(eq(categories.id, row.id));
  }
  return placement.parentId;
}

async function syncLegacyTagsForAirfoils(ids: string[]): Promise<void> {
  const map = await hashtagsByAirfoilIds(ids);
  for (const id of ids) {
    await db
      .update(airfoils)
      .set({ tags: (map.get(id) ?? []).map((h) => h.name) })
      .where(eq(airfoils.id, id));
  }
}

type QueueJobStatusGroup = "active" | "finished" | "recent";

interface QueueJobRow {
  id: string;
  status: string;
  wave: number;
  kind: "sweep-rans" | "point-rans" | "point-urans";
  engine_job_id: string | null;
  engine_state: string | null;
  total_cases: number;
  completed_cases: number;
  airfoil_name: string | null;
  airfoil_slug: string | null;
  bc_name: string | null;
  bc_slug: string | null;
  medium_name: string | null;
  medium_slug: string | null;
  reynolds: number | null;
  mach: number | null;
  speed_mps: number | null;
  reference_chord_m: number | null;
  temperature_k: number | null;
  pressure_pa: number | null;
  turbulence_model: string | null;
  turbulence_intensity: number | null;
  viscosity_ratio: number | null;
  scheduling_policy: string | null;
  cpu_budget: number | null;
  case_concurrency: number | null;
  solver_processes: number | null;
  worker_cpu_budget: number | null;
  mesh_build_count: number | null;
  aoa_case_count: number | null;
  error: string | null;
  created_at: Date | string;
  submitted_at: Date | string | null;
  finished_at: Date | string | null;
  result_count: number | null;
  solved_count: number | null;
  failed_count: number | null;
  aoa_min: number | null;
  aoa_max: number | null;
  cl_max: number | null;
  cd_min: number | null;
  ld_max: number | null;
  campaign_id: string | null;
  campaign_slug: string | null;
  campaign_name: string | null;
  job_kind: string | null;
  // Batched campaign jobs (requestPayload conditionMap): Re range + speed count.
  reynolds_min: number | null;
  reynolds_max: number | null;
  speed_count: number | null;
  // Pinned-detail evidence links (campaign spec §11): the job's single setup
  // revision, or NULL for multi-revision batched jobs (no single pinned view).
  pinned_revision_id: string | null;
}

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : v;
}

const QUEUE_REVISION_ENSURE_TTL_MS = 10_000;
const ENGINE_QUEUE_FRESH_TTL_MS = 5_000;
const ENGINE_QUEUE_BACKGROUND_TIMEOUT_MS = 750;
const ENGINE_HEALTH_FRESH_TTL_MS = 15_000;
const ENGINE_CACHE_STATS_FRESH_TTL_MS = 30_000;
const ENGINE_RUNTIME_UNSUPPORTED_TTL_MS = 60_000;
const ENGINE_RUNTIME_FRESH_TTL_MS = 5_000;
const ENGINE_RUNTIME_RACE_CAP_MS = 500;

let queueRevisionEnsureAt = 0;
let queueRevisionEnsurePromise: Promise<void> | null = null;
// Background gap-fill backlog count for the queue backlog strip — lazily
// refreshed by the queue scan and served with its computedAt (spec §10:
// cached ~5 min; the strip never triggers its own full gap scan).
const GAP_FILL_CACHE_TTL_MS = 5 * 60 * 1000;
let gapFillBacklogCache: {
  pendingPoints: number;
  pendingSweeps: number;
  computedAt: string;
} | null = null;

/** One row of the Background tab's pending-sweeps list (gap scan output). */
interface GapScanPendingSweep {
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
interface GapScanResult {
  pendingSweeps: GapScanPendingSweep[];
  pendingSweepsTotal: number;
  pendingPointsTotal: number;
  computedAt: string;
}
// Single-flight guard: concurrent queue requests share one running gap scan.
let gapFillScanPromise: Promise<GapScanResult> | null = null;
let engineRuntimeUnsupportedUntil = 0;

/** TTL cache + stale-while-refresh + bounded race cap shared by every engine
 *  probe the queue payload depends on (spec §10/§12): the handler must NEVER
 *  await a live engine round-trip — while OpenFOAM solves saturate the CPU
 *  the engine's uvicorn takes seconds to answer, and that is exactly when the
 *  admin queue page must stay usable.
 *  - fresh entry with a known snapshot (stale or fresh) → served immediately;
 *  - fresh entry still resolving (cold path) → raced against the cap;
 *  - expired entry → refresh kicked off; the previous snapshot is served
 *    immediately when one exists, else the new probe races the cap.
 *  `probe` must never reject (each caller catches into an error-carrying
 *  value); `capValue` is the honest "still running" placeholder. */
type ProbeCacheEntry<T> = {
  key: string;
  expiresAt: number;
  promise: Promise<T>;
  value: T | null;
};
type ProbeCacheStore<T> = { current: ProbeCacheEntry<T> | null };
function raceCachedProbe<T>(
  store: ProbeCacheStore<T>,
  key: string,
  ttlMs: number,
  capMs: number,
  probe: () => Promise<T>,
  capValue: () => T,
): Promise<T> {
  const now = Date.now();
  const existing = store.current;
  if (existing && existing.key === key && existing.expiresAt > now) {
    if (existing.value) return Promise.resolve(existing.value);
    return Promise.race([
      existing.promise,
      new Promise<T>((resolve) => setTimeout(() => resolve(capValue()), capMs)),
    ]);
  }
  // Last-known snapshot (for the runtime probe possibly an older job set —
  // still served with its own asOf timestamp, never presented as fresh).
  const previous = existing?.value ?? null;
  const entry: ProbeCacheEntry<T> = {
    key,
    expiresAt: now + ttlMs,
    promise: probe().then((value) => {
      if (store.current === entry) entry.value = value;
      return value;
    }),
    value: previous,
  };
  store.current = entry;
  if (previous) {
    void entry.promise.catch(() => undefined);
    return Promise.resolve(previous);
  }
  return Promise.race([
    entry.promise,
    new Promise<T>((resolve) => setTimeout(() => resolve(capValue()), capMs)),
  ]);
}

const engineQueueCacheStore: ProbeCacheStore<{
  queue: EngineQueueState | null;
  error: string | null;
}> = { current: null };
const engineHealthCacheStore: ProbeCacheStore<{
  health: Awaited<ReturnType<EngineClient["healthDetails"]>> | null;
  error: string | null;
}> = { current: null };
const engineCacheStatsCacheStore: ProbeCacheStore<{
  stats: EngineCacheStats | null;
  error: string | null;
}> = { current: null };
/** Last-known per-job runtime annotations from POST /jobs/runtime. `asOf` is
 *  the time the snapshot was actually fetched from the engine — stale data is
 *  always served WITH that timestamp, never presented as fresh. */
type EngineRuntimeSnapshot = {
  runtimes: Map<string, JobRuntimeSummary>;
  asOf: string | null;
  error: string | null;
};
const engineRuntimeCacheStore: ProbeCacheStore<EngineRuntimeSnapshot> = {
  current: null,
};

async function ensureQueueRevisionsFresh() {
  const now = Date.now();
  if (now - queueRevisionEnsureAt < QUEUE_REVISION_ENSURE_TTL_MS) return;
  if (!queueRevisionEnsurePromise) {
    queueRevisionEnsurePromise = ensureEnabledSimulationPresetRevisions(db)
      .then(() => {
        queueRevisionEnsureAt = Date.now();
      })
      .finally(() => {
        queueRevisionEnsurePromise = null;
      });
  }
  await queueRevisionEnsurePromise;
}

function getCachedEngineQueue(
  engine: EngineClient,
): Promise<{ queue: EngineQueueState | null; error: string | null }> {
  return raceCachedProbe(
    engineQueueCacheStore,
    "engine-queue",
    ENGINE_QUEUE_FRESH_TTL_MS,
    ENGINE_QUEUE_BACKGROUND_TIMEOUT_MS,
    () =>
      engine
        .getQueue()
        .then((queue) => ({ queue, error: null as string | null }))
        .catch((e) => ({ queue: null, error: (e as Error).message })),
    () => ({ queue: null, error: "engine queue refresh is still running" }),
  );
}

export function getCachedEngineHealth(engine: EngineClient): Promise<{
  health: Awaited<ReturnType<EngineClient["healthDetails"]>> | null;
  error: string | null;
}> {
  return raceCachedProbe(
    engineHealthCacheStore,
    "engine-health",
    ENGINE_HEALTH_FRESH_TTL_MS,
    ENGINE_QUEUE_BACKGROUND_TIMEOUT_MS,
    () =>
      engine
        .healthDetails()
        .then((health) => ({ health, error: null as string | null }))
        .catch((e) => ({ health: null, error: (e as Error).message })),
    () => ({ health: null, error: "engine health refresh is still running" }),
  );
}

/** Bounded engine cache-stats probe (~30 s cache, same approach as the engine
 *  health probe — including the race cap on the COLD first request after a
 *  restart). Errors resolve to { stats: null } — never invented numbers. */
function getCachedEngineCacheStats(
  engine: EngineClient,
): Promise<{ stats: EngineCacheStats | null; error: string | null }> {
  return raceCachedProbe(
    engineCacheStatsCacheStore,
    "engine-cache-stats",
    ENGINE_CACHE_STATS_FRESH_TTL_MS,
    ENGINE_QUEUE_BACKGROUND_TIMEOUT_MS,
    () =>
      engine
        .cacheStats()
        .then((stats) => ({ stats, error: null as string | null }))
        .catch((e) => ({ stats: null, error: (e as Error).message })),
    () => ({
      stats: null,
      error: "engine cache-stats refresh is still running",
    }),
  );
}

function toQueueJob(r: QueueJobRow) {
  const createdAt = iso(r.created_at) ?? new Date().toISOString();
  const submittedAt = iso(r.submitted_at);
  const ageStart = submittedAt ?? createdAt;
  const pendingAgeSec = Math.max(
    0,
    Math.round((Date.now() - new Date(ageStart).getTime()) / 1000),
  );
  const isActive = ["pending", "submitted", "running", "ingesting"].includes(
    r.status,
  );
  const stale =
    isActive &&
    pendingAgeSec > 30 * 60 &&
    (r.engine_state == null || r.engine_state === "pending");
  return {
    id: r.id,
    status: r.status,
    wave: Number(r.wave),
    kind: r.kind,
    engineJobId: r.engine_job_id,
    engineState: r.engine_state,
    totalCases: Number(r.total_cases ?? 0),
    completedCases: Number(r.completed_cases ?? 0),
    airfoilName: r.airfoil_name,
    airfoilSlug: r.airfoil_slug,
    bcName: r.bc_name,
    bcSlug: r.bc_slug,
    mediumName: r.medium_name,
    mediumSlug: r.medium_slug,
    reynolds: r.reynolds == null ? null : Number(r.reynolds),
    mach: r.mach == null ? null : Number(r.mach),
    speedMps: r.speed_mps == null ? null : Number(r.speed_mps),
    referenceChordM:
      r.reference_chord_m == null ? null : Number(r.reference_chord_m),
    temperatureK: r.temperature_k == null ? null : Number(r.temperature_k),
    pressurePa: r.pressure_pa == null ? null : Number(r.pressure_pa),
    turbulenceModel: r.turbulence_model,
    turbulenceIntensity:
      r.turbulence_intensity == null ? null : Number(r.turbulence_intensity),
    viscosityRatio:
      r.viscosity_ratio == null ? null : Number(r.viscosity_ratio),
    schedulingPolicy: r.scheduling_policy ?? "auto",
    cpuBudget: r.cpu_budget == null ? null : Number(r.cpu_budget),
    caseConcurrency:
      r.case_concurrency == null ? null : Number(r.case_concurrency),
    solverProcesses:
      r.solver_processes == null ? null : Number(r.solver_processes),
    workerCpuBudget:
      r.worker_cpu_budget == null ? null : Number(r.worker_cpu_budget),
    meshBuildCount:
      r.mesh_build_count == null ? null : Number(r.mesh_build_count),
    aoaCaseCount: r.aoa_case_count == null ? null : Number(r.aoa_case_count),
    error: r.error,
    createdAt,
    submittedAt,
    finishedAt: iso(r.finished_at),
    pendingAgeSec,
    stale,
    resultCount: Number(r.result_count ?? 0),
    solvedCount: Number(r.solved_count ?? 0),
    failedCount: Number(r.failed_count ?? 0),
    aoaMin: r.aoa_min == null ? null : Number(r.aoa_min),
    aoaMax: r.aoa_max == null ? null : Number(r.aoa_max),
    clMax: r.cl_max == null ? null : Number(r.cl_max),
    cdMin: r.cd_min == null ? null : Number(r.cd_min),
    ldMax: r.ld_max == null ? null : Number(r.ld_max),
    // Campaign chip (admin payload only, spec §10).
    campaignId: r.campaign_id,
    campaignSlug: r.campaign_slug,
    campaignName: r.campaign_name,
    jobKind: r.job_kind ?? "sweep",
    // Batched campaign jobs: the card shows "Re min–max · N speeds" when the
    // bundled conditions span a Reynolds range; null for single-speed jobs.
    reynoldsMin: r.reynolds_min == null ? null : Number(r.reynolds_min),
    reynoldsMax: r.reynolds_max == null ? null : Number(r.reynolds_max),
    speedCount: r.speed_count == null ? null : Number(r.speed_count),
    // Evidence links pin this revision on the public detail page (?revision=);
    // null for multi-revision batched jobs, whose links stay unpinned.
    revisionId: r.pinned_revision_id,
  };
}

/** Race-capped + TTL-cached runtime annotations for the queue payload (same
 *  stale-while-refresh approach as getCachedEngineHealth): keyed by the
 *  engineJobId set, ~5 s TTL, ~500 ms race cap on the cold path. When the cap
 *  trips or the engine errors, the last-known snapshot is served with its
 *  original asOf timestamp; with no snapshot at all the jobs are annotated as
 *  runtime-unknown — never invented. */
function getCachedEngineRuntimes(
  engine: EngineClient,
  jobIds: string[],
): Promise<EngineRuntimeSnapshot> {
  const unique = Array.from(new Set(jobIds.filter(Boolean))).sort();
  if (unique.length === 0)
    return Promise.resolve({
      runtimes: new Map(),
      asOf: new Date().toISOString(),
      error: null,
    });
  if (Date.now() < engineRuntimeUnsupportedUntil) {
    return Promise.resolve({
      runtimes: new Map(),
      asOf: null,
      error: "engine build does not support POST /jobs/runtime",
    });
  }
  // Last-known snapshot (possibly for an older job set) — kept on refresh
  // errors so its true asOf keeps travelling with it.
  const previous = engineRuntimeCacheStore.current?.value ?? null;
  return raceCachedProbe(
    engineRuntimeCacheStore,
    unique.join(","),
    ENGINE_RUNTIME_FRESH_TTL_MS,
    ENGINE_RUNTIME_RACE_CAP_MS,
    () =>
      engine
        .getJobRuntimes(unique)
        .then((response) => ({
          runtimes: new Map(response.jobs.map((job) => [job.job_id, job])),
          asOf: new Date().toISOString(),
          error: null as string | null,
        }))
        .catch((e) => {
          if (e instanceof EngineError && e.status === 405) {
            engineRuntimeUnsupportedUntil =
              Date.now() + ENGINE_RUNTIME_UNSUPPORTED_TTL_MS;
          }
          // Keep the last good snapshot (with its true asOf) and carry the error.
          return {
            runtimes:
              previous?.runtimes ?? new Map<string, JobRuntimeSummary>(),
            asOf: previous?.asOf ?? null,
            error: (e as Error).message,
          };
        }),
    () => ({
      runtimes: new Map(),
      asOf: null,
      error: "engine runtime refresh is still running",
    }),
  );
}

/** Live (uncached) runtime lookup — reserved for explicit admin actions such
 *  as recover-stale, where the admin asked for a fresh engine check. The
 *  polled queue payload must use getCachedEngineRuntimes instead. */
async function engineRuntimeMap(
  engine: EngineClient,
  jobIds: string[],
): Promise<Map<string, JobRuntimeSummary>> {
  const unique = Array.from(new Set(jobIds.filter(Boolean)));
  if (unique.length === 0) return new Map();
  if (Date.now() < engineRuntimeUnsupportedUntil) return new Map();
  try {
    const response = await engine.getJobRuntimes(unique);
    return new Map(response.jobs.map((job) => [job.job_id, job]));
  } catch (e) {
    if (e instanceof EngineError && e.status === 405) {
      engineRuntimeUnsupportedUntil =
        Date.now() + ENGINE_RUNTIME_UNSUPPORTED_TTL_MS;
    }
    return new Map();
  }
}

async function queueJobs(group: QueueJobStatusGroup, limit: number) {
  const where =
    group === "active"
      ? sql`WHERE j.status IN ('pending', 'submitted', 'running', 'ingesting')`
      : group === "finished"
        ? sql`WHERE j.status IN ('done', 'failed', 'cancelled')`
        : sql``;
  const rows = (await db.execute(sql`
    WITH result_summary AS (
      SELECT
        sim_job_id,
        count(*)::int AS result_count,
        count(*) FILTER (WHERE status = 'done')::int AS solved_count,
        count(*) FILTER (WHERE status = 'failed')::int AS failed_count,
        min(aoa_deg)::float8 AS aoa_min,
        max(aoa_deg)::float8 AS aoa_max,
        max(cl)::float8 AS cl_max,
        min(cd)::float8 AS cd_min,
        max(cl_cd)::float8 AS ld_max,
        bool_or(unsteady = true OR regime = 'urans') AS has_urans
      FROM results
      WHERE sim_job_id IS NOT NULL
      GROUP BY sim_job_id
    )
    SELECT
      j.id,
      j.status,
      j.wave,
      CASE
        WHEN j.wave = 2 THEN 'point-urans'
        WHEN j.total_cases <= 1 AND COALESCE(rs.has_urans, false) THEN 'point-urans'
        WHEN j.total_cases <= 1 THEN 'point-rans'
        ELSE 'sweep-rans'
      END AS kind,
      j.engine_job_id,
      j.engine_state,
      j.total_cases,
      j.completed_cases,
      j.campaign_id,
      camp.slug AS campaign_slug,
      camp.name AS campaign_name,
      j.job_kind,
      j.error,
      j."createdAt" AS created_at,
      j."submittedAt" AS submitted_at,
      j."finishedAt" AS finished_at,
      a.name AS airfoil_name,
      a.slug AS airfoil_slug,
      COALESCE(rev.snapshot->'preset'->>'name', b.name) AS bc_name,
      COALESCE(rev.snapshot->'preset'->>'slug', b.slug) AS bc_slug,
      COALESCE(rev.snapshot->'flowState'->>'mediumName', rev.snapshot->'operating'->>'mediumName', m.name) AS medium_name,
      COALESCE(rev.snapshot->'flowState'->>'mediumSlug', rev.snapshot->'operating'->>'mediumSlug', m.slug) AS medium_slug,
      COALESCE(rev.reynolds::float8, (rev.snapshot->'derived'->>'reynolds')::float8, (rev.snapshot->'operating'->>'reynolds')::float8, b.reynolds::float8) AS reynolds,
      COALESCE((rev.snapshot->'flowState'->>'mach')::float8, (rev.snapshot->'derived'->>'mach')::float8, (rev.snapshot->'operating'->>'mach')::float8, b.mach::float8) AS mach,
      COALESCE((rev.snapshot->'flowState'->>'speedMps')::float8, (rev.snapshot->'operating'->>'speedMps')::float8, b.speed_mps::float8) AS speed_mps,
      COALESCE((rev.snapshot->'referenceGeometry'->>'referenceLengthM')::float8, (rev.snapshot->'operating'->>'referenceChordM')::float8, b.reference_chord_m::float8) AS reference_chord_m,
      COALESCE((rev.snapshot->'flowState'->>'temperatureK')::float8, (rev.snapshot->'operating'->>'temperatureK')::float8, b.temperature_k::float8) AS temperature_k,
      COALESCE((rev.snapshot->'flowState'->>'pressurePa')::float8, (rev.snapshot->'operating'->>'pressurePa')::float8, b.pressure_pa::float8) AS pressure_pa,
      COALESCE(rev.snapshot->'solver'->>'turbulenceModel', b.turbulence_model) AS turbulence_model,
      COALESCE((rev.snapshot->'boundary'->>'turbulenceIntensity')::float8, b.turbulence_intensity::float8) AS turbulence_intensity,
      COALESCE((rev.snapshot->'boundary'->>'viscosityRatio')::float8, b.viscosity_ratio::float8) AS viscosity_ratio,
      COALESCE(
        j.request_payload->'scheduling'->>'resolved_policy',
        j.request_payload->'resources'->>'policy',
        rev.snapshot->'scheduling'->>'schedulingPolicy',
        b.scheduling_policy,
        'auto'
      ) AS scheduling_policy,
      CASE
        WHEN jsonb_typeof(j.request_payload->'scheduling'->'resolved_cpu_budget') = 'number'
          THEN (j.request_payload->'scheduling'->>'resolved_cpu_budget')::int
        WHEN jsonb_typeof(j.request_payload->'resources'->'cpu_budget') = 'number'
          THEN (j.request_payload->'resources'->>'cpu_budget')::int
        ELSE COALESCE((rev.snapshot->'scheduling'->>'cpuBudget')::int, b.cpu_budget)
      END AS cpu_budget,
      CASE
        WHEN jsonb_typeof(j.request_payload->'scheduling'->'resolved_case_concurrency') = 'number'
          THEN (j.request_payload->'scheduling'->>'resolved_case_concurrency')::int
        WHEN jsonb_typeof(j.request_payload->'resources'->'case_concurrency') = 'number'
          THEN (j.request_payload->'resources'->>'case_concurrency')::int
        ELSE COALESCE((rev.snapshot->'scheduling'->>'caseConcurrency')::int, b.case_concurrency)
      END AS case_concurrency,
      CASE
        WHEN jsonb_typeof(j.request_payload->'scheduling'->'solver_processes') = 'number'
          THEN (j.request_payload->'scheduling'->>'solver_processes')::int
        WHEN jsonb_typeof(j.request_payload->'resources'->'solver_processes') = 'number'
          THEN (j.request_payload->'resources'->>'solver_processes')::int
        ELSE COALESCE((rev.snapshot->'scheduling'->>'solverProcesses')::int, b.solver_processes)
      END AS solver_processes,
      CASE
        WHEN jsonb_typeof(j.request_payload->'scheduling'->'worker_cpu_budget') = 'number'
          THEN (j.request_payload->'scheduling'->>'worker_cpu_budget')::int
        ELSE NULL
      END AS worker_cpu_budget,
      CASE
        WHEN jsonb_typeof(j.request_payload->'scheduling'->'mesh_build_count') = 'number'
          THEN (j.request_payload->'scheduling'->>'mesh_build_count')::int
        ELSE NULL
      END AS mesh_build_count,
      CASE
        WHEN jsonb_typeof(j.request_payload->'scheduling'->'aoa_case_count') = 'number'
          THEN (j.request_payload->'scheduling'->>'aoa_case_count')::int
        ELSE j.total_cases
      END AS aoa_case_count,
      CASE
        WHEN jsonb_typeof(j.request_payload->'conditionMap') = 'array'
          THEN (SELECT min((e->>'reynolds')::float8) FROM jsonb_array_elements(j.request_payload->'conditionMap') e)
        ELSE NULL
      END AS reynolds_min,
      CASE
        WHEN jsonb_typeof(j.request_payload->'conditionMap') = 'array'
          THEN (SELECT max((e->>'reynolds')::float8) FROM jsonb_array_elements(j.request_payload->'conditionMap') e)
        ELSE NULL
      END AS reynolds_max,
      CASE
        WHEN jsonb_typeof(j.request_payload->'conditionMap') = 'array'
          THEN jsonb_array_length(j.request_payload->'conditionMap')
        ELSE NULL
      END AS speed_count,
      CASE
        WHEN jsonb_typeof(j.request_payload->'conditionMap') = 'array'
          AND (SELECT count(DISTINCT e->>'revisionId') FROM jsonb_array_elements(j.request_payload->'conditionMap') e) > 1
          THEN NULL
        ELSE j.simulation_preset_revision_id
      END AS pinned_revision_id,
      COALESCE(rs.result_count, 0)::int AS result_count,
      COALESCE(rs.solved_count, 0)::int AS solved_count,
      COALESCE(rs.failed_count, 0)::int AS failed_count,
      rs.aoa_min,
      rs.aoa_max,
      rs.cl_max,
      rs.cd_min,
      rs.ld_max
    FROM sim_jobs j
    LEFT JOIN airfoils a ON a.id = j.airfoil_id
    LEFT JOIN sim_campaigns camp ON camp.id = j.campaign_id
    LEFT JOIN simulation_preset_revisions rev ON rev.id = j.simulation_preset_revision_id
    LEFT JOIN boundary_conditions b ON b.id = NULLIF(j.bc_ids->>0, '')::uuid
    LEFT JOIN mediums m ON m.id = b.medium_id
    LEFT JOIN result_summary rs ON rs.sim_job_id = j.id
    ${where}
    ORDER BY COALESCE(j."finishedAt", j."createdAt") DESC
    LIMIT ${limit}
  `)) as unknown as QueueJobRow[];
  return rows.map(toQueueJob);
}

const viscosityTablePointBody = z.object({
  temperatureK: z.coerce.number().positive(),
  dynamicViscosity: z.coerce.number().positive(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

const mediumBodyBase = z
  .object({
    slug: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1),
    phase: z.enum(["gas", "liquid"]),
    density: z.coerce.number().positive(),
    refTemperatureK: z.coerce.number().positive().default(288.15),
    refPressurePa: z.coerce.number().positive().default(101325),
    viscosityModel: z.enum(["constant", "sutherland", "table"]),
    constantDynamicViscosity: z.coerce
      .number()
      .positive()
      .nullable()
      .optional(),
    sutherlandMuRef: z.coerce.number().positive().nullable().optional(),
    sutherlandTRef: z.coerce.number().positive().nullable().optional(),
    sutherlandS: z.coerce.number().positive().nullable().optional(),
    viscosityTable: z.array(viscosityTablePointBody).optional(),
    speedOfSound: z.coerce.number().positive().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

const mediumBody = mediumBodyBase.superRefine((b, ctx) => {
  if (
    b.viscosityModel === "constant" &&
    !(Number(b.constantDynamicViscosity) > 0)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["constantDynamicViscosity"],
      message: "required for constant viscosity",
    });
  }
  if (
    b.viscosityModel === "sutherland" &&
    (!(Number(b.sutherlandMuRef) > 0) ||
      !(Number(b.sutherlandTRef) > 0) ||
      !(Number(b.sutherlandS) > 0))
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["sutherlandMuRef"],
      message: "Sutherland mu ref, T ref, and S are required",
    });
  }
  if (b.viscosityModel === "table" && (b.viscosityTable?.length ?? 0) < 1) {
    ctx.addIssue({
      code: "custom",
      path: ["viscosityTable"],
      message: "at least one table point is required",
    });
  }
});
const mediumPatchBody = mediumBodyBase.partial();

const bcBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  mediumId: z.string().uuid(),
  temperatureK: z.coerce.number().positive().default(288.15),
  pressurePa: z.coerce.number().positive().default(101325),
  referenceChordM: z.coerce.number().positive().default(1),
  speedMps: z.coerce.number().positive().default(50),
  turbulenceModel: z.string().trim().min(1).default("kOmegaSST"),
  turbulenceIntensity: z.coerce.number().positive().max(1).default(0.001),
  viscosityRatio: z.coerce.number().positive().default(10),
  sandGrainHeight: z.coerce.number().min(0).default(0),
  roughnessConstant: z.coerce.number().positive().default(0.5),
  mesher: z.string().trim().min(1).default("blockmesh-cgrid"),
  farfieldRadiusChords: z.coerce.number().positive().default(15),
  wakeLengthChords: z.coerce.number().positive().default(12),
  nSurface: z.coerce.number().int().positive().default(130),
  nRadial: z.coerce.number().int().positive().default(80),
  nWake: z.coerce.number().int().positive().default(60),
  targetYPlus: z.coerce.number().positive().default(1),
  spanChords: z.coerce.number().positive().default(0.1),
  nIterations: z.coerce.number().int().positive().default(3000),
  convergenceTolerance: z.coerce.number().positive().default(1e-5),
  momentumScheme: z.string().trim().min(1).default("linearUpwind"),
  transientCycles: z.coerce.number().positive().default(10),
  transientDiscardFraction: z.coerce.number().min(0).max(0.95).default(0.4),
  transientMaxCourant: z.coerce
    .number()
    .positive()
    .default(DEFAULT_TRANSIENT_MAX_COURANT),
  writeImages: z.array(imageFieldName).default([...ALL_IMAGE_FIELDS]),
  imageZoomChords: z.coerce.number().positive().default(2),
  schedulingPolicy: z
    .enum(["auto", "airfoil_parallel", "case_parallel", "exclusive"])
    .default("auto"),
  cpuBudget: z.coerce.number().int().positive().nullable().optional(),
  caseConcurrency: z.coerce.number().int().positive().nullable().optional(),
  solverProcesses: z.coerce.number().int().positive().nullable().optional(),
  aoaStart: z.coerce.number().default(-8),
  aoaStop: z.coerce.number().default(20),
  aoaStep: z.coerce.number().positive().default(1),
  aoaList: z.array(z.coerce.number()).nullable().optional(),
  enabled: z.boolean().default(true),
});

const flowConditionBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  mediumId: z.string().uuid(),
  temperatureK: z.coerce.number().positive().default(288.15),
  pressurePa: z.coerce.number().positive().default(101325),
  speedMps: z.coerce.number().positive().default(50),
});

const referenceGeometryProfileBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  geometryType: z.string().trim().min(1).default("airfoil_2d"),
  referenceLengthKind: z.string().trim().min(1).default("chord"),
  referenceLengthM: z.coerce.number().positive().default(1),
  spanM: z.coerce.number().positive().nullable().optional(),
  referenceAreaM2: z.coerce.number().positive().nullable().optional(),
});

const boundaryProfileBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  turbulenceIntensity: z.coerce.number().positive().max(1).default(0.001),
  viscosityRatio: z.coerce.number().positive().default(10),
  sandGrainHeight: z.coerce.number().min(0).default(0),
  roughnessConstant: z.coerce.number().positive().default(0.5),
});

const meshProfileBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  mesher: z.string().trim().min(1).default("blockmesh-cgrid"),
  farfieldRadiusChords: z.coerce.number().positive().default(15),
  wakeLengthChords: z.coerce.number().positive().default(12),
  nSurface: z.coerce.number().int().positive().default(130),
  nRadial: z.coerce.number().int().positive().default(80),
  nWake: z.coerce.number().int().positive().default(60),
  targetYPlus: z.coerce.number().positive().default(1),
  spanChords: z.coerce.number().positive().default(0.1),
});

const solverProfileBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  turbulenceModel: z.string().trim().min(1).default("kOmegaSST"),
  nIterations: z.coerce.number().int().positive().default(3000),
  convergenceTolerance: z.coerce.number().positive().default(1e-5),
  momentumScheme: z.string().trim().min(1).default("linearUpwind"),
  transientCycles: z.coerce.number().positive().default(10),
  transientDiscardFraction: z.coerce.number().min(0).max(0.95).default(0.4),
  transientMaxCourant: z.coerce
    .number()
    .positive()
    .default(DEFAULT_TRANSIENT_MAX_COURANT),
});

const schedulingProfileBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  schedulingPolicy: z
    .enum(["auto", "airfoil_parallel", "case_parallel", "exclusive"])
    .default("auto"),
  cpuBudget: z.coerce.number().int().positive().nullable().optional(),
  caseConcurrency: z.coerce.number().int().positive().nullable().optional(),
  solverProcesses: z.coerce.number().int().positive().nullable().optional(),
});

const outputProfileBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  writeImages: z.array(imageFieldName).default([...ALL_IMAGE_FIELDS]),
  imageZoomChords: z.coerce.number().positive().default(2),
});

const sweepDefinitionBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  aoaStart: z.coerce.number().default(-8),
  aoaStop: z.coerce.number().default(20),
  aoaStep: z.coerce.number().positive().default(1),
  aoaList: z.array(z.coerce.number()).nullable().optional(),
});

const simulationPresetBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  flowConditionId: z.string().uuid(),
  referenceGeometryProfileId: z.string().uuid(),
  boundaryProfileId: z.string().uuid(),
  meshProfileId: z.string().uuid(),
  solverProfileId: z.string().uuid(),
  schedulingProfileId: z.string().uuid(),
  outputProfileId: z.string().uuid(),
  sweepDefinitionId: z.string().uuid(),
  targetScope: z.enum(["all", "airfoils"]).default("all"),
  targetAirfoilIds: z.array(z.string().uuid()).default([]),
  enabled: z.boolean().default(true),
});

async function uniqueMediumSlug(base: string): Promise<string> {
  let slug = base;
  let n = 2;
  for (let i = 0; i < 1000; i++) {
    const [exists] = await db
      .select({ id: mediums.id })
      .from(mediums)
      .where(eq(mediums.slug, slug))
      .limit(1);
    if (!exists) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

async function tablePointsForMediums(ids: string[]) {
  if (ids.length === 0)
    return new Map<
      string,
      (typeof mediumViscosityTablePoints.$inferSelect)[]
    >();
  const rows = await db
    .select()
    .from(mediumViscosityTablePoints)
    .where(inArray(mediumViscosityTablePoints.mediumId, ids))
    .orderBy(
      asc(mediumViscosityTablePoints.mediumId),
      asc(mediumViscosityTablePoints.sortOrder),
    );
  const map = new Map<
    string,
    (typeof mediumViscosityTablePoints.$inferSelect)[]
  >();
  for (const row of rows) {
    const bucket = map.get(row.mediumId) ?? [];
    bucket.push(row);
    map.set(row.mediumId, bucket);
  }
  return map;
}

async function saveMediumTableRows(
  mediumId: string,
  rows: NonNullable<z.infer<typeof mediumBody>["viscosityTable"]>,
) {
  await db
    .delete(mediumViscosityTablePoints)
    .where(eq(mediumViscosityTablePoints.mediumId, mediumId));
  const points = tablePointsDTO(rows);
  if (points.length === 0) return;
  await db.insert(mediumViscosityTablePoints).values(
    points.map((p, i) => ({
      mediumId,
      temperatureK: p.temperatureK,
      dynamicViscosity: p.dynamicViscosity,
      sortOrder: p.sortOrder ?? i,
    })),
  );
}

async function uniqueSetupSlug(
  tableName: string,
  base: string,
): Promise<string> {
  let slug = base || "setup";
  let n = 2;
  for (let i = 0; i < 1000; i++) {
    const rows = await db.execute(
      sql`SELECT id FROM ${sql.raw(tableName)} WHERE slug = ${slug} LIMIT 1`,
    );
    if ((rows as unknown[]).length === 0) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

type SetupRow = {
  preset: typeof simulationPresets.$inferSelect;
  revision: typeof simulationPresetRevisions.$inferSelect | null;
  flowState: typeof flowConditions.$inferSelect;
  medium: typeof mediums.$inferSelect;
  referenceGeometry: typeof referenceGeometryProfiles.$inferSelect;
  boundary: typeof boundaryProfiles.$inferSelect;
  mesh: typeof meshProfiles.$inferSelect;
  solver: typeof solverProfiles.$inferSelect;
  scheduling: typeof schedulingProfiles.$inferSelect;
  output: typeof outputProfiles.$inferSelect;
  sweep: typeof sweepDefinitions.$inferSelect;
  targetAirfoilIds: string[];
};

function toAdminBoundaryConditionFromSetup(r: SetupRow) {
  return {
    id: r.preset.id,
    slug: r.preset.slug,
    name: r.preset.name,
    legacyBoundaryConditionId: r.preset.legacyBoundaryConditionId,
    simulationPresetId: r.preset.id,
    currentRevisionId: r.revision?.id ?? null,
    mediumId: r.flowState.mediumId,
    mediumSlug: r.medium.slug,
    mediumName: r.medium.name,
    temperatureK: r.flowState.temperatureK,
    pressurePa: r.flowState.pressurePa,
    speedMps: r.flowState.speedMps,
    reynolds:
      r.revision?.reynolds ??
      Math.round(
        (r.flowState.speedMps * r.referenceGeometry.referenceLengthM) /
          r.flowState.kinematicViscosity,
      ),
    referenceChordM: r.referenceGeometry.referenceLengthM,
    density: r.flowState.density,
    dynamicViscosity: r.flowState.dynamicViscosity,
    kinematicViscosity: r.flowState.kinematicViscosity,
    mach: r.flowState.mach,
    turbulenceModel: r.solver.turbulenceModel,
    turbulenceIntensity: r.boundary.turbulenceIntensity,
    viscosityRatio: r.boundary.viscosityRatio,
    sandGrainHeight: r.boundary.sandGrainHeight,
    roughnessConstant: r.boundary.roughnessConstant,
    mesher: r.mesh.mesher,
    farfieldRadiusChords: r.mesh.farfieldRadiusChords,
    wakeLengthChords: r.mesh.wakeLengthChords,
    nSurface: r.mesh.nSurface,
    nRadial: r.mesh.nRadial,
    nWake: r.mesh.nWake,
    targetYPlus: r.mesh.targetYPlus,
    spanChords: r.mesh.spanChords,
    nIterations: r.solver.nIterations,
    convergenceTolerance: r.solver.convergenceTolerance,
    momentumScheme: r.solver.momentumScheme,
    transientCycles: r.solver.transientCycles,
    transientDiscardFraction: r.solver.transientDiscardFraction,
    transientMaxCourant: r.solver.transientMaxCourant,
    writeImages: r.output.writeImages,
    imageZoomChords: r.output.imageZoomChords,
    schedulingPolicy: r.scheduling.schedulingPolicy,
    cpuBudget: r.scheduling.cpuBudget,
    caseConcurrency: r.scheduling.caseConcurrency,
    solverProcesses: r.scheduling.solverProcesses,
    aoaStart: r.sweep.aoaStart,
    aoaStop: r.sweep.aoaStop,
    aoaStep: r.sweep.aoaStep,
    aoaList: r.sweep.aoaList,
    enabled: r.preset.enabled,
    createdAt: iso(r.preset.createdAt)!,
    updatedAt: iso(r.preset.updatedAt)!,
  };
}

function toSimulationPresetDTO(r: SetupRow) {
  return {
    id: r.preset.id,
    slug: r.preset.slug,
    name: r.preset.name,
    flowConditionId: r.preset.flowConditionId,
    referenceGeometryProfileId: r.preset.referenceGeometryProfileId,
    boundaryProfileId: r.preset.boundaryProfileId,
    meshProfileId: r.preset.meshProfileId,
    solverProfileId: r.preset.solverProfileId,
    schedulingProfileId: r.preset.schedulingProfileId,
    outputProfileId: r.preset.outputProfileId,
    sweepDefinitionId: r.preset.sweepDefinitionId,
    legacyBoundaryConditionId: r.preset.legacyBoundaryConditionId,
    currentRevisionId: r.revision?.id ?? null,
    currentRevisionNumber: r.revision?.revisionNumber ?? null,
    signatureHash: r.revision?.signatureHash ?? null,
    targetScope: r.preset.targetScope,
    targetAirfoilIds: r.targetAirfoilIds,
    enabled: r.preset.enabled,
    createdAt: iso(r.preset.createdAt)!,
    updatedAt: iso(r.preset.updatedAt)!,
  };
}

function toAdminBoundaryCondition(r: {
  bc: typeof boundaryConditions.$inferSelect;
  mediumSlug: string;
  mediumName: string;
}) {
  return {
    id: r.bc.id,
    slug: r.bc.slug,
    name: r.bc.name,
    mediumId: r.bc.mediumId,
    mediumSlug: r.mediumSlug,
    mediumName: r.mediumName,
    temperatureK: r.bc.temperatureK,
    pressurePa: r.bc.pressurePa,
    speedMps: r.bc.speedMps,
    reynolds: r.bc.reynolds,
    referenceChordM: r.bc.referenceChordM,
    density: r.bc.density,
    dynamicViscosity: r.bc.dynamicViscosity,
    kinematicViscosity: r.bc.kinematicViscosity,
    mach: r.bc.mach,
    turbulenceModel: r.bc.turbulenceModel,
    turbulenceIntensity: r.bc.turbulenceIntensity,
    viscosityRatio: r.bc.viscosityRatio,
    sandGrainHeight: r.bc.sandGrainHeight,
    roughnessConstant: r.bc.roughnessConstant,
    mesher: r.bc.mesher,
    farfieldRadiusChords: r.bc.farfieldRadiusChords,
    wakeLengthChords: r.bc.wakeLengthChords,
    nSurface: r.bc.nSurface,
    nRadial: r.bc.nRadial,
    nWake: r.bc.nWake,
    targetYPlus: r.bc.targetYPlus,
    spanChords: r.bc.spanChords,
    nIterations: r.bc.nIterations,
    convergenceTolerance: r.bc.convergenceTolerance,
    momentumScheme: r.bc.momentumScheme,
    transientCycles: r.bc.transientCycles,
    transientDiscardFraction: r.bc.transientDiscardFraction,
    transientMaxCourant: r.bc.transientMaxCourant,
    writeImages: r.bc.writeImages,
    imageZoomChords: r.bc.imageZoomChords,
    schedulingPolicy: r.bc.schedulingPolicy,
    cpuBudget: r.bc.cpuBudget,
    caseConcurrency: r.bc.caseConcurrency,
    solverProcesses: r.bc.solverProcesses,
    aoaStart: r.bc.aoaStart,
    aoaStop: r.bc.aoaStop,
    aoaStep: r.bc.aoaStep,
    aoaList: r.bc.aoaList,
    enabled: r.bc.enabled,
    createdAt: iso(r.bc.createdAt)!,
    updatedAt: iso(r.bc.updatedAt)!,
  };
}

async function rowsForBoundaryConditions() {
  const rows = await rowsForSimulationSetup();
  return rows.presetsExpanded.map(toAdminBoundaryConditionFromSetup);
}

async function rowsForSimulationSetup() {
  const [
    flowRows,
    referenceRows,
    boundaryRows,
    meshRows,
    solverRows,
    schedulingRows,
    outputRows,
    sweepRows,
    presetRows,
    revisionRows,
    targetRows,
    airfoilRows,
  ] = await Promise.all([
    db
      .select({
        flowState: flowConditions,
        mediumSlug: mediums.slug,
        mediumName: mediums.name,
      })
      .from(flowConditions)
      .innerJoin(mediums, eq(mediums.id, flowConditions.mediumId))
      .orderBy(asc(flowConditions.name)),
    db
      .select()
      .from(referenceGeometryProfiles)
      .orderBy(asc(referenceGeometryProfiles.name)),
    db.select().from(boundaryProfiles).orderBy(asc(boundaryProfiles.name)),
    db.select().from(meshProfiles).orderBy(asc(meshProfiles.name)),
    db.select().from(solverProfiles).orderBy(asc(solverProfiles.name)),
    db.select().from(schedulingProfiles).orderBy(asc(schedulingProfiles.name)),
    db.select().from(outputProfiles).orderBy(asc(outputProfiles.name)),
    db.select().from(sweepDefinitions).orderBy(asc(sweepDefinitions.name)),
    db
      .select({
        preset: simulationPresets,
        flowState: flowConditions,
        medium: mediums,
        referenceGeometry: referenceGeometryProfiles,
        boundary: boundaryProfiles,
        mesh: meshProfiles,
        solver: solverProfiles,
        scheduling: schedulingProfiles,
        output: outputProfiles,
        sweep: sweepDefinitions,
      })
      .from(simulationPresets)
      .innerJoin(
        flowConditions,
        eq(flowConditions.id, simulationPresets.flowConditionId),
      )
      .innerJoin(mediums, eq(mediums.id, flowConditions.mediumId))
      .innerJoin(
        referenceGeometryProfiles,
        eq(
          referenceGeometryProfiles.id,
          simulationPresets.referenceGeometryProfileId,
        ),
      )
      .innerJoin(
        boundaryProfiles,
        eq(boundaryProfiles.id, simulationPresets.boundaryProfileId),
      )
      .innerJoin(
        meshProfiles,
        eq(meshProfiles.id, simulationPresets.meshProfileId),
      )
      .innerJoin(
        solverProfiles,
        eq(solverProfiles.id, simulationPresets.solverProfileId),
      )
      .innerJoin(
        schedulingProfiles,
        eq(schedulingProfiles.id, simulationPresets.schedulingProfileId),
      )
      .innerJoin(
        outputProfiles,
        eq(outputProfiles.id, simulationPresets.outputProfileId),
      )
      .innerJoin(
        sweepDefinitions,
        eq(sweepDefinitions.id, simulationPresets.sweepDefinitionId),
      )
      .orderBy(asc(simulationPresets.name)),
    db
      .select()
      .from(simulationPresetRevisions)
      .orderBy(desc(simulationPresetRevisions.revisionNumber)),
    db.select().from(simulationPresetAirfoilTargets),
    db
      .select({
        id: airfoils.id,
        slug: airfoils.slug,
        name: airfoils.name,
        isSymmetric: airfoils.isSymmetric,
      })
      .from(airfoils)
      .where(and(isNull(airfoils.archivedAt), isNull(airfoils.deletedAt)))
      .orderBy(asc(airfoils.name)),
  ]);
  const latestRevisionByPreset = new Map<
    string,
    typeof simulationPresetRevisions.$inferSelect
  >();
  for (const revision of revisionRows) {
    if (!latestRevisionByPreset.has(revision.presetId))
      latestRevisionByPreset.set(revision.presetId, revision);
  }
  const targetIdsByPreset = new Map<string, string[]>();
  for (const row of targetRows) {
    const ids = targetIdsByPreset.get(row.presetId) ?? [];
    ids.push(row.airfoilId);
    targetIdsByPreset.set(row.presetId, ids);
  }
  const presetsExpanded: SetupRow[] = presetRows.map((row) => ({
    ...row,
    revision: latestRevisionByPreset.get(row.preset.id) ?? null,
    targetAirfoilIds: targetIdsByPreset.get(row.preset.id) ?? [],
  }));
  return {
    flowConditions: flowRows.map(({ flowState, mediumSlug, mediumName }) => ({
      ...flowState,
      mediumSlug,
      mediumName,
      createdAt: iso(flowState.createdAt)!,
      updatedAt: iso(flowState.updatedAt)!,
    })),
    referenceGeometryProfiles: referenceRows.map((row) => ({
      ...row,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
    })),
    boundaryProfiles: boundaryRows.map((row) => ({
      ...row,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
    })),
    meshProfiles: meshRows.map((row) => ({
      ...row,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
    })),
    solverProfiles: solverRows.map((row) => ({
      ...row,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
    })),
    schedulingProfiles: schedulingRows.map((row) => ({
      ...row,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
    })),
    outputProfiles: outputRows.map((row) => ({
      ...row,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
    })),
    sweepDefinitions: sweepRows.map((row) => ({
      ...row,
      createdAt: iso(row.createdAt)!,
      updatedAt: iso(row.updatedAt)!,
    })),
    airfoilOptions: airfoilRows,
    simulationPresets: presetsExpanded.map(toSimulationPresetDTO),
    presetsExpanded,
  };
}

async function refreshFlowConditionDerived(id: string) {
  const [row] = await db
    .select({ flowState: flowConditions, medium: mediums })
    .from(flowConditions)
    .innerJoin(mediums, eq(mediums.id, flowConditions.mediumId))
    .where(eq(flowConditions.id, id))
    .limit(1);
  if (!row) return null;
  const points = await tablePointsForMediums([row.medium.id]);
  const derived = deriveFlowState(
    row.medium,
    row.flowState,
    points.get(row.medium.id) ?? [],
  );
  const [updated] = await db
    .update(flowConditions)
    .set({
      density: derived.density,
      dynamicViscosity: derived.dynamicViscosity,
      kinematicViscosity: derived.kinematicViscosity,
      mach: derived.mach,
    })
    .where(eq(flowConditions.id, id))
    .returning();
  await refreshPresetsByFlowConditionId(id);
  return updated;
}

async function refreshFlowConditionsForMedium(mediumId: string) {
  const rows = await db
    .select({ id: flowConditions.id })
    .from(flowConditions)
    .where(eq(flowConditions.mediumId, mediumId));
  for (const row of rows) await refreshFlowConditionDerived(row.id);
}

async function refreshBoundaryConditionDerived(id: string) {
  const [row] = await db
    .select({ bc: boundaryConditions, medium: mediums })
    .from(boundaryConditions)
    .innerJoin(mediums, eq(boundaryConditions.mediumId, mediums.id))
    .where(eq(boundaryConditions.id, id))
    .limit(1);
  if (!row) return null;
  const points = await tablePointsForMediums([row.medium.id]);
  const derived = deriveBcState(
    row.medium,
    row.bc,
    points.get(row.medium.id) ?? [],
  );
  const [updated] = await db
    .update(boundaryConditions)
    .set({
      density: derived.density,
      dynamicViscosity: derived.dynamicViscosity,
      kinematicViscosity: derived.kinematicViscosity,
      reynolds: Math.round(derived.reynolds),
      mach: derived.mach,
    })
    .where(eq(boundaryConditions.id, id))
    .returning();
  return updated;
}

async function refreshBoundaryConditionsForMedium(mediumId: string) {
  const rows = await db
    .select({ id: boundaryConditions.id })
    .from(boundaryConditions)
    .where(eq(boundaryConditions.mediumId, mediumId));
  for (const row of rows) await refreshBoundaryConditionDerived(row.id);
}

// The legacy boundary-condition bridge is shared with the campaign
// materializer — single implementation lives in @aerodb/db (campaigns.ts).
async function syncLegacyBoundaryConditionForPreset(
  presetId: string,
): Promise<string | null> {
  return syncLegacyBoundaryConditionForPresetDb(db, presetId);
}

async function refreshPresetRevisionsForRows(rows: { id: string }[]) {
  for (const row of rows) {
    await syncLegacyBoundaryConditionForPreset(row.id);
    await ensureSimulationPresetRevision(db, row.id);
  }
}

async function refreshPresetsByFlowConditionId(id: string) {
  const rows = await db
    .select({ id: simulationPresets.id })
    .from(simulationPresets)
    .where(eq(simulationPresets.flowConditionId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsByReferenceGeometryProfileId(id: string) {
  const rows = await db
    .select({ id: simulationPresets.id })
    .from(simulationPresets)
    .where(eq(simulationPresets.referenceGeometryProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsByBoundaryProfileId(id: string) {
  const rows = await db
    .select({ id: simulationPresets.id })
    .from(simulationPresets)
    .where(eq(simulationPresets.boundaryProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsByMeshProfileId(id: string) {
  const rows = await db
    .select({ id: simulationPresets.id })
    .from(simulationPresets)
    .where(eq(simulationPresets.meshProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsBySolverProfileId(id: string) {
  const rows = await db
    .select({ id: simulationPresets.id })
    .from(simulationPresets)
    .where(eq(simulationPresets.solverProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsBySchedulingProfileId(id: string) {
  const rows = await db
    .select({ id: simulationPresets.id })
    .from(simulationPresets)
    .where(eq(simulationPresets.schedulingProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsByOutputProfileId(id: string) {
  const rows = await db
    .select({ id: simulationPresets.id })
    .from(simulationPresets)
    .where(eq(simulationPresets.outputProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsBySweepDefinitionId(id: string) {
  const rows = await db
    .select({ id: simulationPresets.id })
    .from(simulationPresets)
    .where(eq(simulationPresets.sweepDefinitionId, id));
  await refreshPresetRevisionsForRows(rows);
}

function referencedProfileError(kind: string, rows: { name: string }[]) {
  const names = rows.map((row) => row.name).join(", ");
  const noun = rows.length === 1 ? "simulation preset" : "simulation presets";
  return `Cannot remove ${kind}; it is used by ${rows.length} ${noun}${names ? `: ${names}` : ""}. Update those presets first.`;
}

function normalizeTargetAirfoilIds(ids: string[] | undefined): string[] {
  return Array.from(new Set(ids ?? []));
}

async function validatePresetTargetAirfoils(
  ids: string[],
): Promise<string | null> {
  if (ids.length === 0) return "select at least one profile";
  const rows = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .where(
      and(
        inArray(airfoils.id, ids),
        isNull(airfoils.archivedAt),
        isNull(airfoils.deletedAt),
      ),
    );
  if (rows.length !== ids.length)
    return "one or more selected profiles are unavailable";
  return null;
}

async function replacePresetTargets(
  presetId: string,
  targetScope: "all" | "airfoils",
  targetAirfoilIds: string[],
) {
  await db
    .delete(simulationPresetAirfoilTargets)
    .where(eq(simulationPresetAirfoilTargets.presetId, presetId));
  if (targetScope !== "airfoils") return;
  const values = targetAirfoilIds.map((airfoilId) => ({ presetId, airfoilId }));
  if (values.length)
    await db
      .insert(simulationPresetAirfoilTargets)
      .values(values)
      .onConflictDoNothing();
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  const stopSystemHealthSampler = startSystemHealthSampler();
  app.addHook("onClose", async () => {
    stopSystemHealthSampler();
  });

  // ---- auth ----
  app.get("/api/admin/me", async (req) => {
    const mode = authMode();
    const providers = adminAuthProviders();
    const google = {
      enabled: providers.google,
      allowedDomain: googleAllowedDomain(),
      loginUrl: "/api/admin/oauth/google?returnTo=/admin",
    };
    if (mode === "dev")
      return {
        authed: true,
        mode,
        email: null,
        provider: null,
        providers,
        google,
      };
    const s = verifySession(
      (req as { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME],
    );
    return {
      authed: !!s,
      mode,
      email: s?.email ?? null,
      provider: s?.provider ?? null,
      providers,
      google,
    };
  });

  app.post("/api/admin/login", async (req, reply) => {
    // safeParse → 400 with a plain error (matching the purge route); a bare
    // .parse would bubble a raw ZodError out as a 500.
    const parsed = z
      .object({ email: z.string(), password: z.string() })
      .safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: "email and password are required" });
    const { email, password } = parsed.data;
    if (!checkCredentials(email, password))
      return reply.code(401).send({ error: "invalid email or password" });
    reply.setCookie(COOKIE_NAME, signSession(email, 86_400_000, "password"), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 86_400,
    });
    return { ok: true };
  });

  app.get("/api/admin/oauth/google", async (req, reply) => {
    if (authMode() === "dev") return reply.redirect("/admin", 303);
    if (!googleOAuthConfigured())
      return reply.code(503).send({ error: "Google OAuth is not configured" });
    const query = z
      .object({ returnTo: z.string().optional() })
      .parse(req.query);
    const state = signOAuthState(query.returnTo ?? "/admin");
    reply.setCookie(GOOGLE_STATE_COOKIE_NAME, state, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/api/admin/oauth/google/callback",
      maxAge: 600,
    });
    return reply.redirect(googleAuthorizationUrl(req, state), 303);
  });

  app.get("/api/admin/oauth/google/callback", async (req, reply) => {
    if (authMode() === "dev") return reply.redirect("/admin", 303);
    const query = z
      .object({
        code: z.string().optional(),
        state: z.string().optional(),
        error: z.string().optional(),
      })
      .parse(req.query);
    const verifiedState = verifyOAuthState(
      query.state,
      (req as { cookies?: Record<string, string> }).cookies?.[
        GOOGLE_STATE_COOKIE_NAME
      ],
    );
    reply.clearCookie(GOOGLE_STATE_COOKIE_NAME, {
      path: "/api/admin/oauth/google/callback",
    });
    if (query.error) return reply.redirect(`/admin?auth=google-denied`, 303);
    if (!query.code || !verifiedState)
      return reply.code(400).send({ error: "invalid Google OAuth state" });
    try {
      const session = await googleSessionFromCode(req, query.code);
      reply.setCookie(
        COOKIE_NAME,
        signSession(session.email, 86_400_000, "google", session.domain),
        {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          path: "/",
          maxAge: 86_400,
        },
      );
      return reply.redirect(verifiedState.returnTo, 303);
    } catch (error) {
      app.log.warn({ err: error }, "Google admin OAuth failed");
      return reply.code(401).send({
        error: error instanceof Error ? error.message : "Google OAuth failed",
      });
    }
  });

  app.post("/api/admin/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  app.get("/api/admin/health", { preHandler: requireAdmin }, async () =>
    systemHealthSnapshot(),
  );

  // ---- mediums + setup state (protected writes) ----
  app.get("/api/admin/mediums", { preHandler: requireAdmin }, async () => {
    const rows = await db.select().from(mediums).orderBy(asc(mediums.name));
    const points = await tablePointsForMediums(rows.map((row) => row.id));
    return {
      items: rows.map((row) => toMediumDTO(row, points.get(row.id) ?? [])),
    };
  });

  app.post(
    "/api/admin/mediums",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = mediumBody.parse(req.body);
      const slug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueMediumSlug(slugifyGeneric(b.name));
      const [exists] = await db
        .select({ id: mediums.id })
        .from(mediums)
        .where(eq(mediums.slug, slug))
        .limit(1);
      if (exists)
        return reply.code(409).send({ error: "medium slug already exists" });
      const { dynamicViscosity, kinematicViscosity } = resolveViscosity(
        b,
        b.density,
        b.refTemperatureK,
      );
      const [row] = await db
        .insert(mediums)
        .values({
          slug,
          name: b.name,
          phase: b.phase,
          density: b.density,
          refTemperatureK: b.refTemperatureK,
          refPressurePa: b.refPressurePa,
          ...mediumViscosityColumns(b),
          dynamicViscosity,
          kinematicViscosity,
          speedOfSound: b.speedOfSound ?? null,
          notes: b.notes ?? null,
        })
        .returning();
      await saveMediumTableRows(
        row.id,
        b.viscosityModel === "table" ? (b.viscosityTable ?? []) : [],
      );
      return reply.code(201).send(toMediumDTO(row, b.viscosityTable ?? []));
    },
  );

  app.patch(
    "/api/admin/mediums/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = mediumPatchBody.parse(req.body);
      const [existing] = await db
        .select()
        .from(mediums)
        .where(eq(mediums.id, id))
        .limit(1);
      if (!existing) return reply.code(404).send({ error: "medium not found" });
      const existingPoints = await tablePointsForMediums([id]);
      const existingInput = mediumViscosityInputFromMedium(
        existing,
        existingPoints.get(id) ?? [],
      );
      const density = b.density ?? existing.density;
      const refT = b.refTemperatureK ?? existing.refTemperatureK;
      const viscosityInput = {
        ...existingInput,
        ...b,
        viscosityModel: b.viscosityModel ?? existingInput.viscosityModel,
        viscosityTable: b.viscosityTable ?? existingInput.viscosityTable,
      };
      const { dynamicViscosity, kinematicViscosity } = resolveViscosity(
        viscosityInput,
        density,
        refT,
      );
      const [row] = await db
        .update(mediums)
        .set({
          name: b.name,
          phase: b.phase,
          density: b.density,
          refTemperatureK: b.refTemperatureK,
          refPressurePa: b.refPressurePa,
          ...mediumViscosityColumns(viscosityInput),
          dynamicViscosity,
          kinematicViscosity,
          speedOfSound: Object.prototype.hasOwnProperty.call(b, "speedOfSound")
            ? (b.speedOfSound ?? null)
            : undefined,
          notes: Object.prototype.hasOwnProperty.call(b, "notes")
            ? (b.notes ?? null)
            : undefined,
        })
        .where(eq(mediums.id, id))
        .returning();
      await saveMediumTableRows(
        row.id,
        viscosityInput.viscosityModel === "table"
          ? (viscosityInput.viscosityTable ?? [])
          : [],
      );
      await refreshFlowConditionsForMedium(id);
      return toMediumDTO(row, viscosityInput.viscosityTable ?? []);
    },
  );

  // ---- simulation setup profiles (protected writes) ----
  app.get(
    "/api/admin/simulation-setup",
    { preHandler: requireAdmin },
    async () => {
      const rows = await rowsForSimulationSetup();
      return {
        flowConditions: rows.flowConditions,
        referenceGeometryProfiles: rows.referenceGeometryProfiles,
        boundaryProfiles: rows.boundaryProfiles,
        meshProfiles: rows.meshProfiles,
        solverProfiles: rows.solverProfiles,
        schedulingProfiles: rows.schedulingProfiles,
        outputProfiles: rows.outputProfiles,
        sweepDefinitions: rows.sweepDefinitions,
        airfoilOptions: rows.airfoilOptions,
        simulationPresets: rows.simulationPresets,
      };
    },
  );

  app.post(
    "/api/admin/flow-conditions",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = flowConditionBody.parse(req.body);
      const [medium] = await db
        .select()
        .from(mediums)
        .where(eq(mediums.id, b.mediumId))
        .limit(1);
      if (!medium) return reply.code(404).send({ error: "medium not found" });
      const slug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueSetupSlug("flow_conditions", slugifyGeneric(b.name));
      const points = await tablePointsForMediums([medium.id]);
      const derived = deriveFlowState(medium, b, points.get(medium.id) ?? []);
      const [row] = await db
        .insert(flowConditions)
        .values({
          ...b,
          slug,
          density: derived.density,
          dynamicViscosity: derived.dynamicViscosity,
          kinematicViscosity: derived.kinematicViscosity,
          mach: derived.mach,
        })
        .returning();
      return reply.code(201).send({
        ...row,
        mediumSlug: medium.slug,
        mediumName: medium.name,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      });
    },
  );

  app.patch(
    "/api/admin/flow-conditions/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = flowConditionBody.partial().parse(req.body);
      const [existing] = await db
        .select()
        .from(flowConditions)
        .where(eq(flowConditions.id, id))
        .limit(1);
      if (!existing)
        return reply.code(404).send({ error: "flow condition not found" });
      const [medium] = await db
        .select()
        .from(mediums)
        .where(eq(mediums.id, b.mediumId ?? existing.mediumId))
        .limit(1);
      if (!medium) return reply.code(404).send({ error: "medium not found" });
      const merged = { ...existing, ...b };
      const points = await tablePointsForMediums([medium.id]);
      const derived = deriveFlowState(
        medium,
        merged,
        points.get(medium.id) ?? [],
      );
      const [row] = await db
        .update(flowConditions)
        .set({
          name: b.name,
          mediumId: b.mediumId,
          temperatureK: b.temperatureK,
          pressurePa: b.pressurePa,
          speedMps: b.speedMps,
          density: derived.density,
          dynamicViscosity: derived.dynamicViscosity,
          kinematicViscosity: derived.kinematicViscosity,
          mach: derived.mach,
        })
        .where(eq(flowConditions.id, id))
        .returning();
      await refreshPresetsByFlowConditionId(id);
      return {
        ...row,
        mediumSlug: medium.slug,
        mediumName: medium.name,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
    },
  );

  app.delete(
    "/api/admin/flow-conditions/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const refs = await db
        .select({ name: simulationPresets.name })
        .from(simulationPresets)
        .where(eq(simulationPresets.flowConditionId, id));
      if (refs.length)
        return reply
          .code(409)
          .send({ error: referencedProfileError("flow state", refs) });
      const [row] = await db
        .delete(flowConditions)
        .where(eq(flowConditions.id, id))
        .returning({ id: flowConditions.id });
      if (!row)
        return reply.code(404).send({ error: "flow condition not found" });
      return { ok: true };
    },
  );

  app.post(
    "/api/admin/reference-geometry-profiles",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = referenceGeometryProfileBody.parse(req.body);
      const slug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueSetupSlug(
            "reference_geometry_profiles",
            slugifyGeneric(b.name),
          );
      const [row] = await db
        .insert(referenceGeometryProfiles)
        .values({
          ...b,
          slug,
          spanM: b.spanM ?? null,
          referenceAreaM2: b.referenceAreaM2 ?? null,
        })
        .returning();
      return reply.code(201).send({
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      });
    },
  );

  app.patch(
    "/api/admin/reference-geometry-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = referenceGeometryProfileBody.partial().parse(req.body);
      const [row] = await db
        .update(referenceGeometryProfiles)
        .set({
          name: b.name,
          geometryType: b.geometryType,
          referenceLengthKind: b.referenceLengthKind,
          referenceLengthM: b.referenceLengthM,
          spanM: Object.prototype.hasOwnProperty.call(b, "spanM")
            ? (b.spanM ?? null)
            : undefined,
          referenceAreaM2: Object.prototype.hasOwnProperty.call(
            b,
            "referenceAreaM2",
          )
            ? (b.referenceAreaM2 ?? null)
            : undefined,
        })
        .where(eq(referenceGeometryProfiles.id, id))
        .returning();
      if (!row)
        return reply
          .code(404)
          .send({ error: "reference geometry profile not found" });
      await refreshPresetsByReferenceGeometryProfileId(id);
      return {
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
    },
  );

  app.delete(
    "/api/admin/reference-geometry-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const refs = await db
        .select({ name: simulationPresets.name })
        .from(simulationPresets)
        .where(eq(simulationPresets.referenceGeometryProfileId, id));
      if (refs.length)
        return reply.code(409).send({
          error: referencedProfileError("reference geometry profile", refs),
        });
      const [row] = await db
        .delete(referenceGeometryProfiles)
        .where(eq(referenceGeometryProfiles.id, id))
        .returning({ id: referenceGeometryProfiles.id });
      if (!row)
        return reply
          .code(404)
          .send({ error: "reference geometry profile not found" });
      return { ok: true };
    },
  );

  app.post(
    "/api/admin/boundary-profiles",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = boundaryProfileBody.parse(req.body);
      const slug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueSetupSlug("boundary_profiles", slugifyGeneric(b.name));
      const [row] = await db
        .insert(boundaryProfiles)
        .values({ ...b, slug })
        .returning();
      return reply.code(201).send({
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      });
    },
  );

  app.patch(
    "/api/admin/boundary-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = boundaryProfileBody.partial().parse(req.body);
      const [row] = await db
        .update(boundaryProfiles)
        .set({
          name: b.name,
          turbulenceIntensity: b.turbulenceIntensity,
          viscosityRatio: b.viscosityRatio,
          sandGrainHeight: b.sandGrainHeight,
          roughnessConstant: b.roughnessConstant,
        })
        .where(eq(boundaryProfiles.id, id))
        .returning();
      if (!row)
        return reply.code(404).send({ error: "boundary profile not found" });
      await refreshPresetsByBoundaryProfileId(id);
      return {
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
    },
  );

  app.delete(
    "/api/admin/boundary-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const refs = await db
        .select({ name: simulationPresets.name })
        .from(simulationPresets)
        .where(eq(simulationPresets.boundaryProfileId, id));
      if (refs.length)
        return reply
          .code(409)
          .send({ error: referencedProfileError("boundary profile", refs) });
      const [row] = await db
        .delete(boundaryProfiles)
        .where(eq(boundaryProfiles.id, id))
        .returning({ id: boundaryProfiles.id });
      if (!row)
        return reply.code(404).send({ error: "boundary profile not found" });
      return { ok: true };
    },
  );

  app.post(
    "/api/admin/mesh-profiles",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = meshProfileBody.parse(req.body);
      const slug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueSetupSlug("mesh_profiles", slugifyGeneric(b.name));
      const [row] = await db
        .insert(meshProfiles)
        .values({ ...b, slug })
        .returning();
      return reply.code(201).send({
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      });
    },
  );

  app.patch(
    "/api/admin/mesh-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = meshProfileBody.partial().parse(req.body);
      const [row] = await db
        .update(meshProfiles)
        .set(b)
        .where(eq(meshProfiles.id, id))
        .returning();
      if (!row)
        return reply.code(404).send({ error: "mesh profile not found" });
      await refreshPresetsByMeshProfileId(id);
      return {
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
    },
  );

  app.delete(
    "/api/admin/mesh-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const refs = await db
        .select({ name: simulationPresets.name })
        .from(simulationPresets)
        .where(eq(simulationPresets.meshProfileId, id));
      if (refs.length)
        return reply
          .code(409)
          .send({ error: referencedProfileError("mesh profile", refs) });
      const [row] = await db
        .delete(meshProfiles)
        .where(eq(meshProfiles.id, id))
        .returning({ id: meshProfiles.id });
      if (!row)
        return reply.code(404).send({ error: "mesh profile not found" });
      return { ok: true };
    },
  );

  app.post(
    "/api/admin/solver-profiles",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = solverProfileBody.parse(req.body);
      const slug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueSetupSlug("solver_profiles", slugifyGeneric(b.name));
      const [row] = await db
        .insert(solverProfiles)
        .values({ ...b, slug })
        .returning();
      return reply.code(201).send({
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      });
    },
  );

  app.patch(
    "/api/admin/solver-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = solverProfileBody.partial().parse(req.body);
      const [row] = await db
        .update(solverProfiles)
        .set(b)
        .where(eq(solverProfiles.id, id))
        .returning();
      if (!row)
        return reply.code(404).send({ error: "solver profile not found" });
      await refreshPresetsBySolverProfileId(id);
      return {
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
    },
  );

  app.delete(
    "/api/admin/solver-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const refs = await db
        .select({ name: simulationPresets.name })
        .from(simulationPresets)
        .where(eq(simulationPresets.solverProfileId, id));
      if (refs.length)
        return reply
          .code(409)
          .send({ error: referencedProfileError("solver profile", refs) });
      const [row] = await db
        .delete(solverProfiles)
        .where(eq(solverProfiles.id, id))
        .returning({ id: solverProfiles.id });
      if (!row)
        return reply.code(404).send({ error: "solver profile not found" });
      return { ok: true };
    },
  );

  app.post(
    "/api/admin/scheduling-profiles",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = schedulingProfileBody.parse(req.body);
      const slug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueSetupSlug("scheduling_profiles", slugifyGeneric(b.name));
      const [row] = await db
        .insert(schedulingProfiles)
        .values({ ...b, slug })
        .returning();
      return reply.code(201).send({
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      });
    },
  );

  app.patch(
    "/api/admin/scheduling-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = schedulingProfileBody.partial().parse(req.body);
      const [row] = await db
        .update(schedulingProfiles)
        .set({
          name: b.name,
          schedulingPolicy: b.schedulingPolicy,
          cpuBudget: Object.prototype.hasOwnProperty.call(b, "cpuBudget")
            ? (b.cpuBudget ?? null)
            : undefined,
          caseConcurrency: Object.prototype.hasOwnProperty.call(
            b,
            "caseConcurrency",
          )
            ? (b.caseConcurrency ?? null)
            : undefined,
          solverProcesses: Object.prototype.hasOwnProperty.call(
            b,
            "solverProcesses",
          )
            ? (b.solverProcesses ?? null)
            : undefined,
        })
        .where(eq(schedulingProfiles.id, id))
        .returning();
      if (!row)
        return reply.code(404).send({ error: "scheduling profile not found" });
      await refreshPresetsBySchedulingProfileId(id);
      return {
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
    },
  );

  app.delete(
    "/api/admin/scheduling-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const refs = await db
        .select({ name: simulationPresets.name })
        .from(simulationPresets)
        .where(eq(simulationPresets.schedulingProfileId, id));
      if (refs.length)
        return reply
          .code(409)
          .send({ error: referencedProfileError("scheduling profile", refs) });
      const [row] = await db
        .delete(schedulingProfiles)
        .where(eq(schedulingProfiles.id, id))
        .returning({ id: schedulingProfiles.id });
      if (!row)
        return reply.code(404).send({ error: "scheduling profile not found" });
      return { ok: true };
    },
  );

  app.post(
    "/api/admin/output-profiles",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = outputProfileBody.parse(req.body);
      const slug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueSetupSlug("output_profiles", slugifyGeneric(b.name));
      const [row] = await db
        .insert(outputProfiles)
        .values({ ...b, slug })
        .returning();
      return reply.code(201).send({
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      });
    },
  );

  app.patch(
    "/api/admin/output-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = outputProfileBody.partial().parse(req.body);
      const [row] = await db
        .update(outputProfiles)
        .set(b)
        .where(eq(outputProfiles.id, id))
        .returning();
      if (!row)
        return reply.code(404).send({ error: "output profile not found" });
      await refreshPresetsByOutputProfileId(id);
      return {
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
    },
  );

  app.delete(
    "/api/admin/output-profiles/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const refs = await db
        .select({ name: simulationPresets.name })
        .from(simulationPresets)
        .where(eq(simulationPresets.outputProfileId, id));
      if (refs.length)
        return reply
          .code(409)
          .send({ error: referencedProfileError("output profile", refs) });
      const [row] = await db
        .delete(outputProfiles)
        .where(eq(outputProfiles.id, id))
        .returning({ id: outputProfiles.id });
      if (!row)
        return reply.code(404).send({ error: "output profile not found" });
      return { ok: true };
    },
  );

  app.post(
    "/api/admin/sweep-definitions",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = sweepDefinitionBody.parse(req.body);
      const slug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueSetupSlug("sweep_definitions", slugifyGeneric(b.name));
      const [row] = await db
        .insert(sweepDefinitions)
        .values({ ...b, slug, aoaList: b.aoaList ?? null })
        .returning();
      return reply.code(201).send({
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      });
    },
  );

  app.patch(
    "/api/admin/sweep-definitions/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = sweepDefinitionBody.partial().parse(req.body);
      const [row] = await db
        .update(sweepDefinitions)
        .set({
          name: b.name,
          aoaStart: b.aoaStart,
          aoaStop: b.aoaStop,
          aoaStep: b.aoaStep,
          aoaList: Object.prototype.hasOwnProperty.call(b, "aoaList")
            ? (b.aoaList ?? null)
            : undefined,
        })
        .where(eq(sweepDefinitions.id, id))
        .returning();
      if (!row)
        return reply.code(404).send({ error: "sweep definition not found" });
      await refreshPresetsBySweepDefinitionId(id);
      return {
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      };
    },
  );

  app.delete(
    "/api/admin/sweep-definitions/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const refs = await db
        .select({ name: simulationPresets.name })
        .from(simulationPresets)
        .where(eq(simulationPresets.sweepDefinitionId, id));
      if (refs.length)
        return reply
          .code(409)
          .send({ error: referencedProfileError("sweep definition", refs) });
      const [row] = await db
        .delete(sweepDefinitions)
        .where(eq(sweepDefinitions.id, id))
        .returning({ id: sweepDefinitions.id });
      if (!row)
        return reply.code(404).send({ error: "sweep definition not found" });
      return { ok: true };
    },
  );

  app.post(
    "/api/admin/simulation-presets",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = simulationPresetBody.parse(req.body);
      const targetAirfoilIds = normalizeTargetAirfoilIds(b.targetAirfoilIds);
      if (b.targetScope === "airfoils") {
        const error = await validatePresetTargetAirfoils(targetAirfoilIds);
        if (error) return reply.code(422).send({ error });
      }
      const slug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueSetupSlug("simulation_presets", slugifyGeneric(b.name));
      const [row] = await db
        .insert(simulationPresets)
        .values({
          slug,
          name: b.name,
          flowConditionId: b.flowConditionId,
          referenceGeometryProfileId: b.referenceGeometryProfileId,
          boundaryProfileId: b.boundaryProfileId,
          meshProfileId: b.meshProfileId,
          solverProfileId: b.solverProfileId,
          schedulingProfileId: b.schedulingProfileId,
          outputProfileId: b.outputProfileId,
          sweepDefinitionId: b.sweepDefinitionId,
          targetScope: b.targetScope,
          enabled: b.enabled,
        })
        .returning();
      await replacePresetTargets(row.id, b.targetScope, targetAirfoilIds);
      await syncLegacyBoundaryConditionForPreset(row.id);
      await ensureSimulationPresetRevision(db, row.id);
      const rows = await rowsForSimulationSetup();
      return reply
        .code(201)
        .send(rows.simulationPresets.find((preset) => preset.id === row.id));
    },
  );

  app.patch(
    "/api/admin/simulation-presets/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = simulationPresetBody.partial().parse(req.body);
      const [existing] = await db
        .select()
        .from(simulationPresets)
        .where(eq(simulationPresets.id, id))
        .limit(1);
      if (!existing)
        return reply.code(404).send({ error: "simulation preset not found" });
      const existingTargetRows = await db
        .select({ airfoilId: simulationPresetAirfoilTargets.airfoilId })
        .from(simulationPresetAirfoilTargets)
        .where(eq(simulationPresetAirfoilTargets.presetId, id));
      const targetScope = b.targetScope ?? existing.targetScope;
      const targetAirfoilIds = Object.prototype.hasOwnProperty.call(
        b,
        "targetAirfoilIds",
      )
        ? normalizeTargetAirfoilIds(b.targetAirfoilIds)
        : existingTargetRows.map((row) => row.airfoilId);
      if (targetScope === "airfoils") {
        const error = await validatePresetTargetAirfoils(targetAirfoilIds);
        if (error) return reply.code(422).send({ error });
      }
      const [row] = await db
        .update(simulationPresets)
        .set({
          name: b.name,
          flowConditionId: b.flowConditionId,
          referenceGeometryProfileId: b.referenceGeometryProfileId,
          boundaryProfileId: b.boundaryProfileId,
          meshProfileId: b.meshProfileId,
          solverProfileId: b.solverProfileId,
          schedulingProfileId: b.schedulingProfileId,
          outputProfileId: b.outputProfileId,
          sweepDefinitionId: b.sweepDefinitionId,
          targetScope,
          enabled: b.enabled,
        })
        .where(eq(simulationPresets.id, id))
        .returning();
      if (!row)
        return reply.code(404).send({ error: "simulation preset not found" });
      if (
        Object.prototype.hasOwnProperty.call(b, "targetScope") ||
        Object.prototype.hasOwnProperty.call(b, "targetAirfoilIds")
      ) {
        await replacePresetTargets(row.id, targetScope, targetAirfoilIds);
      }
      await syncLegacyBoundaryConditionForPreset(row.id);
      await ensureSimulationPresetRevision(db, row.id);
      const rows = await rowsForSimulationSetup();
      return rows.simulationPresets.find((preset) => preset.id === row.id);
    },
  );

  app.get(
    "/api/admin/boundary-conditions",
    { preHandler: requireAdmin },
    async () => ({ items: await rowsForBoundaryConditions() }),
  );

  app.post(
    "/api/admin/boundary-conditions",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = bcBody.parse(req.body);
      const [medium] = await db
        .select()
        .from(mediums)
        .where(eq(mediums.id, b.mediumId))
        .limit(1);
      if (!medium) return reply.code(404).send({ error: "medium not found" });
      const presetSlug = b.slug
        ? slugifyGeneric(b.slug)
        : await uniqueSetupSlug("simulation_presets", slugifyGeneric(b.name));
      const points = await tablePointsForMediums([medium.id]);
      const derived = deriveBcState(medium, b, points.get(medium.id) ?? []);
      const base = slugifyGeneric(b.name);
      const [flowState] = await db
        .insert(flowConditions)
        .values({
          slug: await uniqueSetupSlug("flow_conditions", `${base}-flow`),
          name: `${b.name} flow`,
          mediumId: b.mediumId,
          temperatureK: b.temperatureK,
          pressurePa: b.pressurePa,
          speedMps: b.speedMps,
          density: derived.density,
          dynamicViscosity: derived.dynamicViscosity,
          kinematicViscosity: derived.kinematicViscosity,
          mach: derived.mach,
        })
        .returning();
      const [referenceGeometry] = await db
        .insert(referenceGeometryProfiles)
        .values({
          slug: await uniqueSetupSlug(
            "reference_geometry_profiles",
            `${base}-reference-geometry`,
          ),
          name: `${b.name} reference geometry`,
          geometryType: "airfoil_2d",
          referenceLengthKind: "chord",
          referenceLengthM: b.referenceChordM,
        })
        .returning();
      const [boundary] = await db
        .insert(boundaryProfiles)
        .values({
          slug: await uniqueSetupSlug("boundary_profiles", `${base}-boundary`),
          name: `${b.name} boundary`,
          turbulenceIntensity: b.turbulenceIntensity,
          viscosityRatio: b.viscosityRatio,
          sandGrainHeight: b.sandGrainHeight,
          roughnessConstant: b.roughnessConstant,
        })
        .returning();
      const [mesh] = await db
        .insert(meshProfiles)
        .values({
          slug: await uniqueSetupSlug("mesh_profiles", `${base}-mesh`),
          name: `${b.name} mesh`,
          mesher: b.mesher,
          farfieldRadiusChords: b.farfieldRadiusChords,
          wakeLengthChords: b.wakeLengthChords,
          nSurface: b.nSurface,
          nRadial: b.nRadial,
          nWake: b.nWake,
          targetYPlus: b.targetYPlus,
          spanChords: b.spanChords,
        })
        .returning();
      const [solver] = await db
        .insert(solverProfiles)
        .values({
          slug: await uniqueSetupSlug("solver_profiles", `${base}-solver`),
          name: `${b.name} solver`,
          turbulenceModel: b.turbulenceModel,
          nIterations: b.nIterations,
          convergenceTolerance: b.convergenceTolerance,
          momentumScheme: b.momentumScheme,
          transientCycles: b.transientCycles,
          transientDiscardFraction: b.transientDiscardFraction,
          transientMaxCourant: b.transientMaxCourant,
        })
        .returning();
      const [scheduling] = await db
        .insert(schedulingProfiles)
        .values({
          slug: await uniqueSetupSlug(
            "scheduling_profiles",
            `${base}-scheduling`,
          ),
          name: `${b.name} scheduling`,
          schedulingPolicy: b.schedulingPolicy,
          cpuBudget: b.cpuBudget ?? null,
          caseConcurrency: b.caseConcurrency ?? null,
          solverProcesses: b.solverProcesses ?? null,
        })
        .returning();
      const [output] = await db
        .insert(outputProfiles)
        .values({
          slug: await uniqueSetupSlug("output_profiles", `${base}-output`),
          name: `${b.name} output`,
          writeImages: b.writeImages,
          imageZoomChords: b.imageZoomChords,
        })
        .returning();
      const [sweep] = await db
        .insert(sweepDefinitions)
        .values({
          slug: await uniqueSetupSlug("sweep_definitions", `${base}-sweep`),
          name: `${b.name} sweep`,
          aoaStart: b.aoaStart,
          aoaStop: b.aoaStop,
          aoaStep: b.aoaStep,
          aoaList: b.aoaList ?? null,
        })
        .returning();
      const [preset] = await db
        .insert(simulationPresets)
        .values({
          slug: presetSlug,
          name: b.name,
          flowConditionId: flowState.id,
          referenceGeometryProfileId: referenceGeometry.id,
          boundaryProfileId: boundary.id,
          meshProfileId: mesh.id,
          solverProfileId: solver.id,
          schedulingProfileId: scheduling.id,
          outputProfileId: output.id,
          sweepDefinitionId: sweep.id,
          enabled: b.enabled,
        })
        .returning();
      await syncLegacyBoundaryConditionForPreset(preset.id);
      await ensureSimulationPresetRevision(db, preset.id);
      return reply
        .code(201)
        .send(
          (await rowsForBoundaryConditions()).find(
            (item) => item.id === preset.id,
          ),
        );
    },
  );

  app.patch(
    "/api/admin/boundary-conditions/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = bcBody.partial().parse(req.body);
      const [preset] = await db
        .select()
        .from(simulationPresets)
        .where(
          or(
            eq(simulationPresets.id, id),
            eq(simulationPresets.legacyBoundaryConditionId, id),
          ),
        )
        .limit(1);
      if (!preset)
        return reply.code(404).send({ error: "simulation preset not found" });
      const [existingFlow] = await db
        .select()
        .from(flowConditions)
        .where(eq(flowConditions.id, preset.flowConditionId))
        .limit(1);
      if (!existingFlow)
        return reply.code(404).send({ error: "flow condition not found" });
      const [existingReferenceGeometry] = await db
        .select()
        .from(referenceGeometryProfiles)
        .where(
          eq(referenceGeometryProfiles.id, preset.referenceGeometryProfileId),
        )
        .limit(1);
      if (!existingReferenceGeometry)
        return reply
          .code(404)
          .send({ error: "reference geometry profile not found" });
      const [medium] = await db
        .select()
        .from(mediums)
        .where(eq(mediums.id, b.mediumId ?? existingFlow.mediumId))
        .limit(1);
      if (!medium) return reply.code(404).send({ error: "medium not found" });
      const merged = {
        ...existingFlow,
        ...b,
        referenceChordM:
          b.referenceChordM ?? existingReferenceGeometry.referenceLengthM,
      };
      const points = await tablePointsForMediums([medium.id]);
      const derived = deriveBcState(
        medium,
        merged,
        points.get(medium.id) ?? [],
      );
      await db
        .update(flowConditions)
        .set({
          name: b.name ? `${b.name} flow` : undefined,
          mediumId: b.mediumId,
          temperatureK: b.temperatureK,
          pressurePa: b.pressurePa,
          speedMps: b.speedMps,
          density: derived.density,
          dynamicViscosity: derived.dynamicViscosity,
          kinematicViscosity: derived.kinematicViscosity,
          mach: derived.mach,
        })
        .where(eq(flowConditions.id, preset.flowConditionId));
      await db
        .update(referenceGeometryProfiles)
        .set({
          name: b.name ? `${b.name} reference geometry` : undefined,
          geometryType: "airfoil_2d",
          referenceLengthKind: "chord",
          referenceLengthM: b.referenceChordM,
        })
        .where(
          eq(referenceGeometryProfiles.id, preset.referenceGeometryProfileId),
        );
      await db
        .update(boundaryProfiles)
        .set({
          name: b.name ? `${b.name} boundary` : undefined,
          turbulenceIntensity: b.turbulenceIntensity,
          viscosityRatio: b.viscosityRatio,
          sandGrainHeight: b.sandGrainHeight,
          roughnessConstant: b.roughnessConstant,
        })
        .where(eq(boundaryProfiles.id, preset.boundaryProfileId));
      await db
        .update(meshProfiles)
        .set({
          name: b.name ? `${b.name} mesh` : undefined,
          mesher: b.mesher,
          farfieldRadiusChords: b.farfieldRadiusChords,
          wakeLengthChords: b.wakeLengthChords,
          nSurface: b.nSurface,
          nRadial: b.nRadial,
          nWake: b.nWake,
          targetYPlus: b.targetYPlus,
          spanChords: b.spanChords,
        })
        .where(eq(meshProfiles.id, preset.meshProfileId));
      await db
        .update(solverProfiles)
        .set({
          name: b.name ? `${b.name} solver` : undefined,
          turbulenceModel: b.turbulenceModel,
          nIterations: b.nIterations,
          convergenceTolerance: b.convergenceTolerance,
          momentumScheme: b.momentumScheme,
          transientCycles: b.transientCycles,
          transientDiscardFraction: b.transientDiscardFraction,
          transientMaxCourant: b.transientMaxCourant,
        })
        .where(eq(solverProfiles.id, preset.solverProfileId));
      await db
        .update(schedulingProfiles)
        .set({
          name: b.name ? `${b.name} scheduling` : undefined,
          schedulingPolicy: b.schedulingPolicy,
          cpuBudget: Object.prototype.hasOwnProperty.call(b, "cpuBudget")
            ? (b.cpuBudget ?? null)
            : undefined,
          caseConcurrency: Object.prototype.hasOwnProperty.call(
            b,
            "caseConcurrency",
          )
            ? (b.caseConcurrency ?? null)
            : undefined,
          solverProcesses: Object.prototype.hasOwnProperty.call(
            b,
            "solverProcesses",
          )
            ? (b.solverProcesses ?? null)
            : undefined,
        })
        .where(eq(schedulingProfiles.id, preset.schedulingProfileId));
      await db
        .update(outputProfiles)
        .set({
          name: b.name ? `${b.name} output` : undefined,
          writeImages: b.writeImages,
          imageZoomChords: b.imageZoomChords,
        })
        .where(eq(outputProfiles.id, preset.outputProfileId));
      await db
        .update(sweepDefinitions)
        .set({
          name: b.name ? `${b.name} sweep` : undefined,
          aoaStart: b.aoaStart,
          aoaStop: b.aoaStop,
          aoaStep: b.aoaStep,
          aoaList: Object.prototype.hasOwnProperty.call(b, "aoaList")
            ? (b.aoaList ?? null)
            : undefined,
        })
        .where(eq(sweepDefinitions.id, preset.sweepDefinitionId));
      await db
        .update(simulationPresets)
        .set({ name: b.name, enabled: b.enabled })
        .where(eq(simulationPresets.id, preset.id));
      await syncLegacyBoundaryConditionForPreset(preset.id);
      await ensureSimulationPresetRevision(db, preset.id);
      return (await rowsForBoundaryConditions()).find(
        (item) => item.id === preset.id,
      );
    },
  );

  // ---- category management (protected) ----
  app.get(
    "/api/admin/categories/tree",
    { preHandler: requireAdmin },
    async () => categoriesTree(),
  );

  app.post(
    "/api/admin/categories",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = z
        .object({
          name: z.string().trim().min(1),
          slug: z.string().trim().min(1).optional(),
          parentId: z.string().uuid().nullable().optional(),
          description: z.string().nullable().optional(),
          sortOrder: z.number().int().optional(),
        })
        .parse(req.body);
      const slug = await uniqueCategorySlug(slugifyCategory(b.slug ?? b.name));
      try {
        const placement = await categoryPlacement(b.parentId, slug);
        const [row] = await db
          .insert(categories)
          .values({
            slug,
            name: b.name,
            parentId: placement.parentId,
            path: placement.path,
            depth: placement.depth,
            sortOrder: b.sortOrder ?? 0,
            description: b.description ?? null,
          })
          .returning();
        return reply.code(201).send(row);
      } catch (e) {
        return reply.code(422).send({ error: (e as Error).message });
      }
    },
  );

  app.patch(
    "/api/admin/categories/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const b = z
        .object({
          name: z.string().trim().min(1).optional(),
          parentId: z.string().uuid().nullable().optional(),
          description: z.string().nullable().optional(),
          sortOrder: z.number().int().optional(),
        })
        .parse(req.body);
      const [current] = await db
        .select()
        .from(categories)
        .where(eq(categories.id, id))
        .limit(1);
      if (!current)
        return reply.code(404).send({ error: "category not found" });
      try {
        if (
          Object.prototype.hasOwnProperty.call(b, "parentId") &&
          b.parentId !== current.parentId
        ) {
          await moveCategorySubtree(current, b.parentId);
        }
        const [row] = await db
          .update(categories)
          .set({
            name: b.name,
            description: Object.prototype.hasOwnProperty.call(b, "description")
              ? (b.description ?? null)
              : undefined,
            sortOrder: b.sortOrder,
          })
          .where(eq(categories.id, id))
          .returning();
        return row;
      } catch (e) {
        return reply.code(422).send({ error: (e as Error).message });
      }
    },
  );

  app.post(
    "/api/admin/categories/reorder",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = z
        .object({
          draggedId: z.string().uuid(),
          targetId: z.string().uuid(),
          position: z.enum(["before", "inside", "after"]),
        })
        .parse(req.body);
      if (b.draggedId === b.targetId)
        return reply
          .code(422)
          .send({ error: "category cannot be dropped on itself" });
      const [dragged] = await db
        .select()
        .from(categories)
        .where(eq(categories.id, b.draggedId))
        .limit(1);
      const [target] = await db
        .select()
        .from(categories)
        .where(eq(categories.id, b.targetId))
        .limit(1);
      if (!dragged || !target)
        return reply.code(404).send({ error: "category not found" });
      if (target.path.startsWith(dragged.path + "/")) {
        return reply
          .code(422)
          .send({ error: "category cannot be moved into its own descendant" });
      }

      try {
        const nextParentId =
          b.position === "inside" ? target.id : target.parentId;
        if (nextParentId !== dragged.parentId)
          await moveCategorySubtree(dragged, nextParentId);

        const siblings = await db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(
            nextParentId
              ? eq(categories.parentId, nextParentId)
              : isNull(categories.parentId),
          )
          .orderBy(asc(categories.sortOrder), asc(categories.name));
        const ordered = siblings.filter((s) => s.id !== dragged.id);
        const insertAt =
          b.position === "inside"
            ? ordered.length
            : Math.max(
                0,
                ordered.findIndex((s) => s.id === target.id) +
                  (b.position === "after" ? 1 : 0),
              );
        ordered.splice(insertAt, 0, { id: dragged.id, name: dragged.name });
        for (let i = 0; i < ordered.length; i++) {
          await db
            .update(categories)
            .set({ sortOrder: (i + 1) * 10 })
            .where(eq(categories.id, ordered[i].id));
        }
        return categoriesTree();
      } catch (e) {
        return reply.code(422).send({ error: (e as Error).message });
      }
    },
  );

  app.delete(
    "/api/admin/categories/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [cat] = await db
        .select()
        .from(categories)
        .where(eq(categories.id, id))
        .limit(1);
      if (!cat) return reply.code(404).send({ error: "category not found" });
      const [childCount] = await db
        .select({ n: count() })
        .from(categories)
        .where(eq(categories.parentId, id));
      if ((childCount?.n ?? 0) > 0)
        return reply.code(409).send({ error: "category has subcategories" });
      const [airfoilCount] = await db
        .select({ n: count() })
        .from(airfoils)
        .where(and(eq(airfoils.categoryId, id), isNull(airfoils.deletedAt)));
      if ((airfoilCount?.n ?? 0) > 0)
        return reply.code(409).send({ error: "category has airfoils" });
      await db.delete(categories).where(eq(categories.id, id));
      return reply.code(204).send();
    },
  );

  // ---- hashtag management (protected) ----
  app.get("/api/admin/hashtags", { preHandler: requireAdmin }, async () => ({
    items: await listHashtags(),
  }));

  app.post(
    "/api/admin/hashtags",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { name } = z
        .object({ name: z.string().trim().min(1) })
        .parse(req.body);
      const slug = slugifyHashtag(name);
      const [exists] = await db
        .select({ id: hashtags.id })
        .from(hashtags)
        .where(eq(hashtags.slug, slug))
        .limit(1);
      if (exists)
        return reply.code(409).send({ error: "hashtag already exists" });
      const [row] = await db.insert(hashtags).values({ slug, name }).returning({
        id: hashtags.id,
        slug: hashtags.slug,
        name: hashtags.name,
      });
      return reply.code(201).send(toHashtagDTO(row));
    },
  );

  app.patch(
    "/api/admin/hashtags/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { name } = z
        .object({ name: z.string().trim().min(1) })
        .parse(req.body);
      const slug = slugifyHashtag(name);
      const [dupe] = await db
        .select({ id: hashtags.id })
        .from(hashtags)
        .where(eq(hashtags.slug, slug))
        .limit(1);
      if (dupe && dupe.id !== id)
        return reply.code(409).send({ error: "hashtag already exists" });
      const [row] = await db
        .update(hashtags)
        .set({ slug, name })
        .where(eq(hashtags.id, id))
        .returning({
          id: hashtags.id,
          slug: hashtags.slug,
          name: hashtags.name,
        });
      if (!row) return reply.code(404).send({ error: "hashtag not found" });
      return toHashtagDTO(row);
    },
  );

  app.delete(
    "/api/admin/hashtags/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const affected = await db
        .select({ airfoilId: airfoilHashtags.airfoilId })
        .from(airfoilHashtags)
        .where(eq(airfoilHashtags.hashtagId, id));
      await db.delete(hashtags).where(eq(hashtags.id, id));
      await syncLegacyTagsForAirfoils([
        ...new Set(affected.map((r) => r.airfoilId)),
      ]);
      return reply.code(204).send();
    },
  );

  // ---- airfoil bulk operations (protected) ----
  app.post(
    "/api/admin/airfoils/bulk",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const b = z
        .object({
          ids: z.array(z.string().uuid()).min(1).max(1000),
          action: z.enum([
            "move",
            "archive",
            "remove",
            "restore",
            "assignHashtags",
            "removeHashtags",
          ]),
          categoryId: z.string().uuid().optional(),
          hashtagIds: z.array(z.string().uuid()).optional().default([]),
        })
        .parse(req.body);
      const ids = [...new Set(b.ids)];
      if (b.action === "move") {
        if (!b.categoryId)
          return reply.code(422).send({ error: "categoryId is required" });
        const [cat] = await db
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.id, b.categoryId))
          .limit(1);
        if (!cat) return reply.code(404).send({ error: "category not found" });
        const rows = await db
          .update(airfoils)
          .set({ categoryId: b.categoryId })
          .where(and(inArray(airfoils.id, ids), isNull(airfoils.deletedAt)))
          .returning({ id: airfoils.id });
        return { ok: true, updated: rows.length };
      }
      if (b.action === "archive") {
        const rows = await db
          .update(airfoils)
          .set({ archivedAt: new Date() })
          .where(and(inArray(airfoils.id, ids), isNull(airfoils.deletedAt)))
          .returning({ id: airfoils.id });
        return { ok: true, updated: rows.length };
      }
      if (b.action === "remove") {
        const rows = await db
          .update(airfoils)
          .set({ deletedAt: new Date() })
          .where(inArray(airfoils.id, ids))
          .returning({ id: airfoils.id });
        return { ok: true, updated: rows.length };
      }
      if (b.action === "restore") {
        const rows = await db
          .update(airfoils)
          .set({ archivedAt: null, deletedAt: null })
          .where(inArray(airfoils.id, ids))
          .returning({ id: airfoils.id });
        return { ok: true, updated: rows.length };
      }
      if (b.hashtagIds.length === 0)
        return reply.code(422).send({ error: "hashtagIds are required" });
      const existingTags = await db
        .select({ id: hashtags.id })
        .from(hashtags)
        .where(inArray(hashtags.id, b.hashtagIds));
      if (existingTags.length !== b.hashtagIds.length)
        return reply
          .code(404)
          .send({ error: "one or more hashtags were not found" });
      if (b.action === "assignHashtags") {
        for (const airfoilId of ids) {
          for (const hashtagId of b.hashtagIds) {
            await db
              .insert(airfoilHashtags)
              .values({ airfoilId, hashtagId })
              .onConflictDoNothing();
          }
        }
      } else {
        await db
          .delete(airfoilHashtags)
          .where(
            and(
              inArray(airfoilHashtags.airfoilId, ids),
              inArray(airfoilHashtags.hashtagId, b.hashtagIds),
            ),
          );
      }
      await syncLegacyTagsForAirfoils(ids);
      return { ok: true, updated: ids.length };
    },
  );

  // ---- queue (protected) ----
  // Pending work = (airfoil × enabled setup revision × AoA) gaps. Keep counts and the
  // visible list in one scan so the queue page does not recompute the same gap set.
  // Single-flight: scope=background/all awaits it; other scopes only trigger a
  // background refresh and serve gapFillBacklogCache with its computedAt.
  const runGapFillScan = (): Promise<GapScanResult> => {
    if (gapFillScanPromise) return gapFillScanPromise;
    const scan = (async (): Promise<GapScanResult> => {
      const pendingSweepRows = (await db.execute(sql`
      WITH latest_revision AS (
        SELECT DISTINCT ON (preset_id) preset_id, id, reynolds
        FROM simulation_preset_revisions
        ORDER BY preset_id, revision_number DESC
      ),
      gap_rows AS (
        SELECT
          a.id AS airfoil_id,
          a.slug AS airfoil_slug,
          a.name AS airfoil_name,
          c.name AS category_name,
          c.path AS category_path,
          p.legacy_boundary_condition_id AS bc_id,
          p.slug AS bc_slug,
          p.name AS bc_name,
          m.slug AS medium_slug,
          m.name AS medium_name,
          rev.reynolds::float8 AS reynolds,
          fc.mach::float8 AS mach,
          fc.speed_mps::float8 AS speed_mps,
          rg.reference_length_m::float8 AS reference_chord_m,
          fc.temperature_k::float8 AS temperature_k,
          fc.pressure_pa::float8 AS pressure_pa,
          sp.turbulence_model,
          bp.turbulence_intensity::float8 AS turbulence_intensity,
          bp.viscosity_ratio::float8 AS viscosity_ratio,
          sched.scheduling_policy,
          sched.cpu_budget,
          sched.case_concurrency,
          sched.solver_processes,
          g.aoa::float8 AS aoa_deg,
          COALESCE(r.status, 'pending') AS status,
          COALESCE(r.priority, 0)::int AS priority,
          r.regime,
          r.unsteady,
          r."createdAt" AS requested_at
        FROM airfoils a
        JOIN categories c ON c.id = a.category_id
        CROSS JOIN simulation_presets p
        JOIN latest_revision rev ON rev.preset_id = p.id
        JOIN flow_conditions fc ON fc.id = p.flow_condition_id
        JOIN reference_geometry_profiles rg ON rg.id = p.reference_geometry_profile_id
        JOIN mediums m ON m.id = fc.medium_id
        JOIN boundary_profiles bp ON bp.id = p.boundary_profile_id
        JOIN solver_profiles sp ON sp.id = p.solver_profile_id
        JOIN scheduling_profiles sched ON sched.id = p.scheduling_profile_id
        JOIN sweep_definitions sw ON sw.id = p.sweep_definition_id
        CROSS JOIN LATERAL (
          SELECT jsonb_array_elements_text(sw.aoa_list)::numeric AS aoa WHERE sw.aoa_list IS NOT NULL
          UNION ALL
          SELECT generate_series(sw.aoa_start::numeric, sw.aoa_stop::numeric, sw.aoa_step::numeric) AS aoa WHERE sw.aoa_list IS NULL
        ) AS g
        LEFT JOIN results r ON r.airfoil_id = a.id AND r.simulation_preset_revision_id = rev.id AND r.aoa_deg = g.aoa
        WHERE p.enabled = true
          AND (
            p.target_scope = 'all'
            OR EXISTS (
              SELECT 1
              FROM simulation_preset_airfoil_targets target
              WHERE target.preset_id = p.id AND target.airfoil_id = a.id
            )
          )
          AND p.legacy_boundary_condition_id IS NOT NULL
          AND a."archivedAt" IS NULL
          AND a."deletedAt" IS NULL
          AND (r.id IS NULL OR r.status IN ('pending', 'stale'))
          AND NOT EXISTS (
            SELECT 1
            FROM sync_sweep_promise_points pp
            JOIN sync_sweep_promises pr ON pr.id = pp.promise_id
            WHERE pp.airfoil_id = a.id
              AND pp.simulation_preset_revision_id = rev.id
              AND pp.aoa_deg = g.aoa
              AND pp.status = 'active'
              AND pr.status = 'active'
              AND pr."expiresAt" > now()
          )
      ),
      grouped AS (
        SELECT
          airfoil_id,
          airfoil_slug,
          airfoil_name,
          category_name,
          category_path,
          bc_id,
          bc_slug,
          bc_name,
          medium_slug,
          medium_name,
          reynolds,
          mach,
          speed_mps,
          reference_chord_m,
          temperature_k,
          pressure_pa,
          turbulence_model,
          turbulence_intensity,
          viscosity_ratio,
          scheduling_policy,
          cpu_budget,
          case_concurrency,
          solver_processes,
          count(*)::int AS aoa_count,
          min(aoa_deg)::float8 AS aoa_min,
          max(aoa_deg)::float8 AS aoa_max,
          array_agg(aoa_deg ORDER BY aoa_deg) AS aoas,
          max(priority)::int AS priority,
          CASE
            WHEN bool_or(unsteady = true OR regime = 'urans') THEN 'point-urans'
            WHEN count(*) = 1 OR max(priority) > 0 THEN 'point-rans'
            ELSE 'sweep-rans'
          END AS kind,
          min(status::text) AS status,
          min(requested_at) AS requested_at
        FROM gap_rows
        GROUP BY
          airfoil_id, airfoil_slug, airfoil_name, category_name, category_path,
          bc_id, bc_slug, bc_name, medium_slug, medium_name, reynolds, mach,
          speed_mps, reference_chord_m, temperature_k, pressure_pa,
          turbulence_model, turbulence_intensity, viscosity_ratio,
          scheduling_policy, cpu_budget, case_concurrency, solver_processes
      )
      SELECT
        grouped.*,
        count(*) OVER()::int AS pending_sweeps_total,
        COALESCE(sum(aoa_count) OVER(), 0)::int AS pending_points_total
      FROM grouped
      ORDER BY priority DESC, reynolds ASC, airfoil_slug ASC, aoa_min ASC
      LIMIT 120
    `)) as unknown as {
        airfoil_id: string;
        airfoil_slug: string;
        airfoil_name: string;
        category_name: string;
        category_path: string;
        bc_id: string;
        bc_slug: string;
        bc_name: string;
        medium_slug: string;
        medium_name: string;
        reynolds: number;
        mach: number | null;
        speed_mps: number;
        reference_chord_m: number;
        temperature_k: number;
        pressure_pa: number;
        turbulence_model: string;
        turbulence_intensity: number;
        viscosity_ratio: number;
        scheduling_policy: string;
        cpu_budget: number | null;
        case_concurrency: number | null;
        solver_processes: number | null;
        aoa_count: number;
        aoa_min: number;
        aoa_max: number;
        aoas: number[];
        status: string;
        priority: number;
        kind: "sweep-rans" | "point-rans" | "point-urans";
        requested_at: Date | string | null;
        pending_sweeps_total: number;
        pending_points_total: number;
      }[];
      const pendingSweepsTotal = Number(
        pendingSweepRows[0]?.pending_sweeps_total ?? 0,
      );
      const pendingPointsTotal = Number(
        pendingSweepRows[0]?.pending_points_total ?? 0,
      );
      const computedAt = new Date().toISOString();
      gapFillBacklogCache = {
        pendingPoints: pendingPointsTotal,
        pendingSweeps: pendingSweepsTotal,
        computedAt,
      };
      const pendingSweeps: GapScanPendingSweep[] = pendingSweepRows.map(
        (r) => ({
          airfoilId: r.airfoil_id,
          airfoilSlug: r.airfoil_slug,
          airfoilName: r.airfoil_name,
          categoryName: r.category_name,
          categoryPath: r.category_path,
          bcId: r.bc_id,
          bcSlug: r.bc_slug,
          bcName: r.bc_name,
          mediumSlug: r.medium_slug,
          mediumName: r.medium_name,
          reynolds: Number(r.reynolds),
          mach: r.mach == null ? null : Number(r.mach),
          speedMps: Number(r.speed_mps),
          referenceChordM: Number(r.reference_chord_m),
          temperatureK: Number(r.temperature_k),
          pressurePa: Number(r.pressure_pa),
          turbulenceModel: r.turbulence_model,
          turbulenceIntensity: Number(r.turbulence_intensity),
          viscosityRatio: Number(r.viscosity_ratio),
          schedulingPolicy: r.scheduling_policy ?? "auto",
          cpuBudget: r.cpu_budget == null ? null : Number(r.cpu_budget),
          caseConcurrency:
            r.case_concurrency == null ? null : Number(r.case_concurrency),
          solverProcesses:
            r.solver_processes == null ? null : Number(r.solver_processes),
          aoaCount: Number(r.aoa_count),
          aoaMin: Number(r.aoa_min),
          aoaMax: Number(r.aoa_max),
          aoas: (r.aoas ?? []).map(Number),
          status: r.status,
          priority: Number(r.priority ?? 0),
          kind: r.kind,
          requestedAt: iso(r.requested_at),
        }),
      );
      return {
        pendingSweeps,
        pendingSweepsTotal,
        pendingPointsTotal,
        computedAt,
      };
    })();
    gapFillScanPromise = scan.finally(() => {
      gapFillScanPromise = null;
    });
    return gapFillScanPromise;
  };

  app.get(
    "/api/admin/queue",
    { preHandler: requireAdmin },
    async (req, reply) => {
      // Tab-scoped payloads (spec §10/§12): every scope returns the full
      // AdminQueue shape; out-of-scope sections are null so the web types stay
      // honest — a section is either present-and-real or explicitly absent.
      const parsedScope = z
        .object({
          scope: z
            .enum(["activity", "background", "engine", "all"])
            .default("all"),
        })
        .safeParse(req.query ?? {});
      if (!parsedScope.success) {
        return reply.code(400).send({
          error:
            "invalid scope — expected one of activity, background, engine, all",
        });
      }
      const scope = parsedScope.data.scope;
      const wantActivity = scope === "activity" || scope === "all";
      const wantBackground = scope === "background" || scope === "all";
      const wantEngine = scope === "engine" || scope === "all";
      // Engine tab shows stale/detached counts derived from activeJobs, so both
      // activity and engine scopes carry job lists + runtime annotations.
      const wantJobs = wantActivity || wantEngine;
      const wantEngineChips = wantActivity || wantEngine;

      await ensureQueueRevisionsFresh();
      const s = await readSweeperState();

      // Full gap scan only where the Background tab needs the visible list
      // (scope=background/all). The hot Activity polling path serves the cached
      // counters with their computedAt and, when stale, refreshes in the
      // background (spec §10: the strip never triggers its own full gap scan).
      let gapScan: GapScanResult | null = null;
      if (wantBackground) {
        gapScan = await runGapFillScan();
      } else if (
        !gapFillBacklogCache ||
        Date.now() - new Date(gapFillBacklogCache.computedAt).getTime() >=
          GAP_FILL_CACHE_TTL_MS
      ) {
        void runGapFillScan().catch(() => undefined);
      }
      const gapCounters = gapScan
        ? {
            pendingPoints: gapScan.pendingPointsTotal,
            pendingSweeps: gapScan.pendingSweepsTotal,
            computedAt: gapScan.computedAt,
          }
        : gapFillBacklogCache;

      const externalPromiseRows = !wantBackground
        ? null
        : ((await db.execute(sql`
      SELECT
        pr.id,
        pr.source_instance_id,
        pr.source_instance_name,
        pr.status,
        pr."expiresAt" AS expires_at,
        pr."createdAt" AS created_at,
        a.slug AS airfoil_slug,
        a.name AS airfoil_name,
        rev.reynolds::float8 AS reynolds,
        rev.mach::float8 AS mach,
        count(pp.*)::int AS aoa_count,
        min(pp.aoa_deg)::float8 AS aoa_min,
        max(pp.aoa_deg)::float8 AS aoa_max
      FROM sync_sweep_promises pr
      JOIN airfoils a ON a.id = pr.airfoil_id
      JOIN simulation_preset_revisions rev ON rev.id = pr.simulation_preset_revision_id
      JOIN sync_sweep_promise_points pp ON pp.promise_id = pr.id AND pp.status = pr.status
      WHERE pr.status = 'active' AND pr."expiresAt" > now()
      GROUP BY pr.id, a.slug, a.name, rev.reynolds, rev.mach
      ORDER BY pr."expiresAt" ASC
      LIMIT 80
    `)) as unknown as {
            id: string;
            source_instance_id: string | null;
            source_instance_name: string | null;
            status: string;
            expires_at: Date | string;
            created_at: Date | string;
            airfoil_slug: string;
            airfoil_name: string;
            reynolds: number;
            mach: number | null;
            aoa_count: number;
            aoa_min: number;
            aoa_max: number;
          }[]);

      let byStatus: Record<string, number> | null = null;
      // Solved-points badge (screen 5): real count of results solved since the
      // start of the current server day; null outside the activity scope.
      let solvedToday: number | null = null;
      if (wantActivity) {
        const statusRows = (await db.execute(
          sql`SELECT status, count(*)::int AS n FROM results GROUP BY status`,
        )) as unknown as { status: string; n: number }[];
        byStatus = {};
        for (const r of statusRows) byStatus[r.status] = Number(r.n);
        const [solved] = await db
          .select({ n: count() })
          .from(results)
          .where(and(eq(results.source, "solved"), eq(results.status, "done")));
        byStatus.solved = solved?.n ?? 0;
        const [today] = await db
          .select({ n: count() })
          .from(results)
          .where(
            and(
              eq(results.source, "solved"),
              eq(results.status, "done"),
              isNotNull(results.solvedAt),
              sql`${results.solvedAt} >= date_trunc('day', now())`,
            ),
          );
        solvedToday = today?.n ?? 0;
      }

      const [jobsRaw, activeJobsRaw, finishedJobsRaw] = await Promise.all([
        wantActivity ? queueJobs("recent", 50) : Promise.resolve(null),
        wantJobs ? queueJobs("active", 40) : Promise.resolve(null),
        wantActivity ? queueJobs("finished", 80) : Promise.resolve(null),
      ]);
      const engine = new EngineClient(env.engineUrl);
      // Every engine probe below is TTL-cached with stale-while-refresh and a
      // bounded race cap on its cold path — the queue payload NEVER waits on a
      // live engine round-trip (the engine's uvicorn can take seconds while
      // OpenFOAM solves saturate the CPU; spec §10/§12 requires this page to
      // stay usable exactly then).
      const emptyRuntimeSnapshot: EngineRuntimeSnapshot = {
        runtimes: new Map(),
        asOf: null,
        error: null,
      };
      const [
        { queue: engineQueue, error: engineQueueError },
        { health: engineHealth, error: engineHealthError },
        { stats: engineCacheStats },
        runtimeSnapshot,
      ] = await Promise.all([
        wantEngineChips
          ? getCachedEngineQueue(engine)
          : Promise.resolve<Awaited<ReturnType<typeof getCachedEngineQueue>>>({
              queue: null,
              error: null,
            }),
        wantEngineChips
          ? getCachedEngineHealth(engine)
          : Promise.resolve<Awaited<ReturnType<typeof getCachedEngineHealth>>>({
              health: null,
              error: null,
            }),
        wantEngine
          ? getCachedEngineCacheStats(engine)
          : Promise.resolve<
              Awaited<ReturnType<typeof getCachedEngineCacheStats>>
            >({ stats: null, error: null }),
        wantJobs
          ? getCachedEngineRuntimes(
              engine,
              [
                ...(jobsRaw ?? []),
                ...(activeJobsRaw ?? []),
                ...(finishedJobsRaw ?? []),
              ]
                .map((job) => job.engineJobId)
                .filter((id): id is string => Boolean(id)),
            )
          : Promise.resolve(emptyRuntimeSnapshot),
      ]);
      const runtimeByEngineJobId = runtimeSnapshot.runtimes;
      const annotateJob = <T extends ReturnType<typeof toQueueJob>>(
        job: T,
      ) => ({
        ...job,
        ...(() => {
          const runtime = job.engineJobId
            ? runtimeByEngineJobId.get(job.engineJobId)
            : null;
          if (!engineQueue && !runtime) {
            return {
              engineQueueMatch: false,
              stale: job.stale,
              runtimeState: "unknown",
              staleReason: null,
              processCount: 0,
              processes: [],
              activePids: [],
              phase: null,
              phaseStartedAt: null,
              lastProgressAt: null,
              activeSolver: null,
              activeCaseSlug: null,
              activeAoaDeg: null,
              cpuTokensWaiting: null,
              cpuTokensHeld: null,
              resultReady: false,
              statusReadError: null,
              resultReadError: null,
            };
          }
          const classified = classifyQueueLifecycle(job, runtime, engineQueue);
          const phase = runtime?.status_phase ?? runtime?.runtime_phase ?? null;
          const activeSolver =
            runtime?.status_active_solver ??
            runtime?.runtime_active_solver ??
            null;
          const activeCaseSlug =
            runtime?.status_active_case_slug ??
            runtime?.runtime_active_case_slug ??
            null;
          const activeAoaDeg =
            runtime?.status_active_aoa_deg ??
            runtime?.runtime_active_aoa_deg ??
            null;
          const cpuTokensWaiting =
            runtime?.status_cpu_tokens_waiting ??
            runtime?.runtime_cpu_tokens_waiting ??
            null;
          const cpuTokensHeld =
            runtime?.status_cpu_tokens_held ??
            runtime?.runtime_cpu_tokens_held ??
            null;
          return {
            engineQueueMatch: classified.engineQueueMatch,
            stale: job.stale || classified.stale,
            runtimeState: classified.runtimeState,
            staleReason: classified.staleReason,
            processCount: classified.processCount,
            processes: runtime?.processes ?? [],
            activePids: runtime?.active_pids ?? [],
            phase,
            phaseStartedAt: runtime?.status_phase_started_at ?? null,
            lastProgressAt:
              runtime?.runtime_last_progress_at ??
              runtime?.status_last_progress_at ??
              null,
            activeSolver,
            activeCaseSlug,
            activeAoaDeg,
            cpuTokensWaiting,
            cpuTokensHeld,
            resultReady: classified.resultReady,
            statusReadError: runtime?.status_error ?? null,
            resultReadError: runtime?.result_error ?? null,
          };
        })(),
      });
      const jobs = jobsRaw?.map(annotateJob) ?? null;
      const activeJobs = activeJobsRaw?.map(annotateJob) ?? null;
      const finishedJobs = finishedJobsRaw?.map(annotateJob) ?? null;
      const inFlight = activeJobs
        ? activeJobs.filter((j) =>
            ["submitted", "running", "ingesting"].includes(j.status),
          ).length
        : null;

      // Backlog strip (spec §10): per-active-campaign remaining from counters +
      // the cached background gap-fill note with its computed-at time (null
      // until the first scan ever completes — shown as "not computed yet",
      // never invented).
      const campaignBacklog = wantActivity
        ? await campaignBacklogStrip(db)
        : null;
      // engineUnreachableSince lands with the sweeper phase (migration 0026);
      // readSweeperState() reads it defensively while the column may be absent.
      const engineUnreachableSinceRaw = s?.engineUnreachableSince ?? null;
      const gapCountersInScope =
        wantActivity || wantBackground ? gapCounters : null;

      return {
        scope,
        mode: authMode(),
        engineUrl: env.engineUrl,
        // sweeper includes cpuSlots — THE single global solver-capacity setting;
        // 0 = auto (no cpu_budget cap is sent to the engine).
        sweeper: s ?? SWEEPER_STATE_DEFAULTS,
        cpuSlotsAuto: (s?.cpuSlots ?? 0) === 0,
        engineUnreachableSince: iso(engineUnreachableSinceRaw),
        backlogStrip: campaignBacklog
          ? {
              campaigns: campaignBacklog,
              backgroundGapFill: gapCounters,
            }
          : null,
        backlog: gapCountersInScope?.pendingPoints ?? null,
        inFlight,
        results: byStatus,
        solvedToday,
        pendingPointsTotal: gapCountersInScope?.pendingPoints ?? null,
        pendingSweepsTotal: gapCountersInScope?.pendingSweeps ?? null,
        pendingSweeps: gapScan?.pendingSweeps ?? null,
        externalPromises:
          externalPromiseRows?.map((row) => ({
            id: row.id,
            sourceInstanceId: row.source_instance_id,
            sourceInstanceName: row.source_instance_name,
            status: row.status,
            expiresAt: iso(row.expires_at),
            createdAt: iso(row.created_at),
            airfoilSlug: row.airfoil_slug,
            airfoilName: row.airfoil_name,
            reynolds: Number(row.reynolds),
            mach: row.mach == null ? null : Number(row.mach),
            aoaCount: Number(row.aoa_count),
            aoaMin: Number(row.aoa_min),
            aoaMax: Number(row.aoa_max),
          })) ?? null,
        engineQueue,
        engineQueueError,
        engineHealth,
        engineHealthError,
        engineExpectedBuildId: env.engineExpectedBuildId,
        engineBuildId: engineHealth?.build_id ?? null,
        engineBuildMismatch: Boolean(
          env.engineExpectedBuildId &&
          engineHealth?.build_id &&
          engineHealth.build_id !== env.engineExpectedBuildId,
        ),
        // Disk truth from the engine's GET /cache/stats (~30 s cache); null when
        // the endpoint is unreachable or errors — never invented (pinned contract).
        engineCache:
          engineCacheStats == null
            ? null
            : {
                meshEntries: Number(engineCacheStats.mesh_entries),
                seedEntries: Number(engineCacheStats.seed_entries),
                totalBytes: Number(engineCacheStats.total_bytes),
                capBytes: Number(engineCacheStats.cap_bytes),
                oldestLastUsedAt: engineCacheStats.oldest_last_used ?? null,
              },
        // When the runtime snapshot is stale (race cap tripped / engine error),
        // asOf carries the time it was actually fetched; null = no runtime data
        // at all (jobs annotate as runtime-unknown).
        engineRuntimeAsOf: wantJobs ? runtimeSnapshot.asOf : null,
        engineRuntimeError: wantJobs ? runtimeSnapshot.error : null,
        activeJobs,
        finishedJobs,
        jobs,
      };
    },
  );

  const sweeperResponse = (s: SweeperStateRow) => ({
    ...s,
    // 0 = auto: no cpu_budget cap is sent to the engine; the engine resolves
    // its own worker budget (pre-campaign behavior). Positive values are
    // passed into the engine `resources` block at job-compose time.
    cpuSlotsAuto: (s.cpuSlots ?? 0) === 0,
    cpuSlotsMeaning:
      "0 = auto (no cpu_budget cap sent to the engine); positive = global OpenFOAM CPU slots",
  });

  app.get("/api/admin/sweeper", { preHandler: requireAdmin }, async () => {
    const s = await readSweeperState();
    return sweeperResponse(s ?? SWEEPER_STATE_DEFAULTS);
  });

  app.patch("/api/admin/sweeper", { preHandler: requireAdmin }, async (req) => {
    const b = z
      .object({
        enabled: z.boolean().optional(),
        maxConcurrentJobs: z.number().int().positive().max(64).optional(),
        // 0 = auto (see sweeperResponse); capped to keep budgets sane.
        cpuSlots: z.number().int().min(0).max(512).optional(),
        pollIntervalMs: z.number().int().min(1000).optional(),
        submitIntervalMs: z.number().int().min(1000).optional(),
      })
      .parse(req.body);
    return sweeperResponse(await writeSweeperState(b));
  });

  app.post(
    "/api/admin/results/requeue-failed",
    { preHandler: requireAdmin },
    async (_req, reply) => {
      // A global status flip cannot safely reconstruct campaign points,
      // progress, fidelity-ladder ownership, or bounded submit retry state.
      // Keep the legacy URL explicit and inert; admins must choose the
      // campaign-scoped or stable-result-id requeue action whose transaction
      // owns those invariants.
      return reply.code(409).send({
        error:
          "global failed-result requeue is disabled; use a campaign-scoped requeue or Point History single-point requeue",
      });
    },
  );

  // Admin request-URANS (fidelity ladder contract 6): creates a work item the
  // sweeper schedules at PRECALC rank (after all RANS gaps, before the verify
  // queue). aoaDeg absent = whole polar. Idempotent per (cell, fidelity) —
  // replaying returns the existing open request with created=false.
  //
  // CONTINUATION mode (amendment C): { continueFromResultId, budgetOverrideS? }
  // resumes a budget-stopped URANS solve from its saved engine case state with
  // an increased wall-clock budget (+2h/+6h/+24h UI choices). The cell, angle and
  // fidelity derive from the SOURCE results row — the client names only the
  // row it is continuing.
  app.post(
    "/api/admin/urans-requests",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = z
        .object({
          airfoilId: z.string().uuid().optional(),
          revisionId: z.string().uuid().optional(),
          aoaDeg: z.number().finite().optional(),
          fidelity: z.enum(["precalc", "full"]).optional(),
          continueFromResultId: z.string().uuid().optional(),
          // 1 min .. 24 h — mirrors the engine's URANS_BUDGET_OVERRIDE_MAX_S
          // (models.py, le=86400): a larger value would be accepted here, queued,
          // then 422-rejected at engine submit and the request cancelled. Reject
          // it up front instead.
          budgetOverrideS: z
            .number()
            .int()
            .min(60)
            .max(24 * 3600)
            .optional(),
        })
        .safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? "invalid request",
        });
      const body = parsed.data;

      if (body.continueFromResultId) {
        const [source] = await db
          .select({
            id: results.id,
            airfoilId: results.airfoilId,
            revisionId: results.simulationPresetRevisionId,
            aoaDeg: results.aoaDeg,
            fidelity: results.fidelity,
            regime: results.regime,
            engineJobId: results.engineJobId,
            engineCaseSlug: results.engineCaseSlug,
          })
          .from(results)
          .where(eq(results.id, body.continueFromResultId))
          .limit(1);
        if (!source)
          return reply
            .code(404)
            .send({ error: "continuation source result not found" });
        if (
          source.regime !== "urans" &&
          !(source.fidelity ?? "").startsWith("urans")
        ) {
          return reply
            .code(422)
            .send({ error: "only URANS solves can be continued" });
        }
        if (!source.engineJobId || !source.engineCaseSlug) {
          return reply.code(422).send({
            error:
              "continuation source has no saved engine case state (engine ids missing)",
          });
        }
        if (!source.revisionId) {
          return reply.code(422).send({
            error: "continuation source has no pinned simulation revision",
          });
        }
        const { request, created } = await createUransRequest(db, {
          airfoilId: source.airfoilId,
          revisionId: source.revisionId,
          aoaDeg: source.aoaDeg,
          // The resumed run keeps the tier the evidence was solved at.
          fidelity:
            body.fidelity ??
            (source.fidelity === "urans_full" ? "full" : "precalc"),
          requestedBy: sessionEmail(req),
          continueFromResultId: source.id,
          budgetOverrideS: body.budgetOverrideS ?? null,
        });
        // Idempotency is per (cell, fidelity): a reused open item that is NOT a
        // continuation of this result would run a FRESH solve, silently
        // discarding the saved case state the admin asked to resume. Refuse
        // honestly instead of presenting a from-scratch job as a resume.
        if (!created && request.continueFromResultId !== source.id) {
          return reply.code(409).send({
            error:
              request.continueFromResultId == null
                ? `an open ${request.state} URANS request already covers this cell and is NOT a continuation — it will solve from scratch; wait for it to settle (or cancel it) before queuing this resume`
                : `an open ${request.state} URANS request already covers this cell but continues a different result; wait for it to settle before queuing this resume`,
            request,
          });
        }
        return reply.code(created ? 201 : 200).send({ request, created });
      }

      if (body.budgetOverrideS != null) {
        return reply.code(400).send({
          error:
            "budgetOverrideS is only valid with continueFromResultId (continuation mode)",
        });
      }
      if (!body.airfoilId || !body.revisionId || !body.fidelity) {
        return reply.code(400).send({
          error:
            "airfoilId, revisionId and fidelity are required (or pass continueFromResultId)",
        });
      }
      const [airfoil] = await db
        .select({ id: airfoils.id })
        .from(airfoils)
        .where(eq(airfoils.id, body.airfoilId))
        .limit(1);
      if (!airfoil) return reply.code(404).send({ error: "airfoil not found" });
      const [revision] = await db
        .select({ id: simulationPresetRevisions.id })
        .from(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.id, body.revisionId))
        .limit(1);
      if (!revision)
        return reply
          .code(404)
          .send({ error: "simulation preset revision not found" });
      let outcome;
      try {
        outcome = await createUransRequest(db, {
          airfoilId: body.airfoilId,
          revisionId: body.revisionId,
          aoaDeg: body.aoaDeg ?? null,
          fidelity: body.fidelity,
          requestedBy: sessionEmail(req),
        });
      } catch (error) {
        if (error instanceof UransRequestCoverageConflict) {
          return reply.code(409).send({
            error:
              "a whole-polar URANS request cannot reuse open exact-angle work because it would leave other angles uncovered; wait for or cancel the exact requests first",
            code: error.code,
            conflictingRequestIds: error.conflictingRequestIds,
          });
        }
        if (error instanceof PrecalcObligationTerminalConflict) {
          return reply.code(409).send({
            error:
              "preliminary work for this immutable setup is already terminal; create a revised setup to retry a blocker, or request full fidelity to refine accepted preliminary evidence",
            code: error.code,
            obligations: error.obligations,
          });
        }
        throw error;
      }
      const { request, created } = outcome;
      return reply.code(created ? 201 : 200).send({ request, created });
    },
  );

  // Bulk resume (unavailable-evidence page): queue a continuation for every
  // restartable row (budget-stopped rejected URANS evidence with
  // saved case state), optionally scoped to one campaign. Reuses the same
  // idempotent per-(cell, fidelity) request machinery as the single-row
  // Continue action; rows whose cell already has an open request are counted
  // as reused, never duplicated. Non-continuable unavailable rows (crashes,
  // non-budget rejections) are intentionally excluded — resuming needs saved
  // restartable state.
  app.post(
    "/api/admin/urans-requests/bulk-continue",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = z
        .object({
          campaignId: z.string().uuid().optional(),
          // mirrors the single-row continuation bounds (engine cap 24 h)
          budgetOverrideS: z
            .number()
            .int()
            .min(60)
            .max(24 * 3600),
        })
        .safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({
          error: parsed.error.issues[0]?.message ?? "invalid request",
        });
      const body = parsed.data;

      const rows = await listContinuableNeedsReview(db, {
        campaignId: body.campaignId ?? null,
      });
      let created = 0;
      let reused = 0;
      let conflicted = 0;
      for (const row of rows) {
        const { request, created: isNew } = await createUransRequest(db, {
          airfoilId: row.airfoilId,
          revisionId: row.revisionId,
          aoaDeg: row.aoaDeg,
          fidelity: row.fidelity === "urans_full" ? "full" : "precalc",
          requestedBy: sessionEmail(req),
          continueFromResultId: row.resultId,
          budgetOverrideS: body.budgetOverrideS,
        });
        if (isNew) created += 1;
        else if (request.continueFromResultId === row.resultId) reused += 1;
        // An open item covering the cell that is NOT this row's continuation
        // would run from scratch (or resume a different result) — count it
        // honestly instead of pretending this row was queued for resume.
        else conflicted += 1;
      }
      return reply
        .code(created ? 201 : 200)
        .send({ continuable: rows.length, created, reused, conflicted });
    },
  );

  // Open/settled request-URANS items + verify-queue items for one cell scope —
  // the Points tab / cell panel reads this to render the action state honestly
  // (idempotent replay shows the already-open item, never a fake new one).
  app.get(
    "/api/admin/urans-requests",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = z
        .object({ airfoilId: z.string().uuid(), revisionId: z.string().uuid() })
        .safeParse((req.query ?? {}) as Record<string, unknown>);
      if (!parsed.success)
        return reply
          .code(400)
          .send({ error: parsed.error.issues[0]?.message ?? "invalid query" });
      const requests = await db
        .select()
        .from(simUransRequests)
        .where(
          and(
            eq(simUransRequests.airfoilId, parsed.data.airfoilId),
            eq(simUransRequests.revisionId, parsed.data.revisionId),
          ),
        )
        .orderBy(desc(simUransRequests.createdAt))
        .limit(100);
      const verifyRows = await db
        .select()
        .from(simUransVerifyQueue)
        .where(
          and(
            eq(simUransVerifyQueue.airfoilId, parsed.data.airfoilId),
            eq(simUransVerifyQueue.revisionId, parsed.data.revisionId),
          ),
        )
        .orderBy(desc(simUransVerifyQueue.createdAt))
        .limit(100);
      const requestOwners = requests.length
        ? await db
            .select({
              requestId: simUransRequestCampaigns.requestId,
              campaignId: simUransRequestCampaigns.campaignId,
              state: simUransRequestCampaigns.state,
            })
            .from(simUransRequestCampaigns)
            .where(
              inArray(
                simUransRequestCampaigns.requestId,
                requests.map((request) => request.id),
              ),
            )
        : [];
      const verifyOwners = verifyRows.length
        ? await db
            .select({
              queueId: simUransVerifyQueueCampaigns.queueId,
              campaignId: simUransVerifyQueueCampaigns.campaignId,
              state: simUransVerifyQueueCampaigns.state,
            })
            .from(simUransVerifyQueueCampaigns)
            .where(
              inArray(
                simUransVerifyQueueCampaigns.queueId,
                verifyRows.map((item) => item.id),
              ),
            )
        : [];
      const requestRetries = requests.length
        ? await db
            .select()
            .from(simLadderSubmitRetries)
            .where(
              inArray(
                simLadderSubmitRetries.uransRequestId,
                requests.map((request) => request.id),
              ),
            )
        : [];
      const verifyRetries = verifyRows.length
        ? await db
            .select()
            .from(simLadderSubmitRetries)
            .where(
              inArray(
                simLadderSubmitRetries.verifyQueueId,
                verifyRows.map((item) => item.id),
              ),
            )
        : [];
      const requestsWithOwners = requests.map((request) => ({
        ...request,
        independentOwner: request.backgroundOwner,
        submitRetry:
          requestRetries.find((retry) => retry.uransRequestId === request.id) ??
          null,
        campaignOwners: requestOwners
          .filter((owner) => owner.requestId === request.id)
          .map(({ campaignId, state }) => ({ campaignId, state })),
      }));
      const verifyItems = verifyRows.map(
        ({ campaignId: _legacyCampaignId, ...item }) => ({
          ...item,
          submitRetry:
            verifyRetries.find((retry) => retry.verifyQueueId === item.id) ??
            null,
          campaignOwners: verifyOwners
            .filter((owner) => owner.queueId === item.id)
            .map(({ campaignId, state }) => ({ campaignId, state })),
        }),
      );
      return { requests: requestsWithOwners, verifyItems };
    },
  );

  app.post(
    "/api/admin/test-artifacts/purge",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const parsed = z
        .object({
          prefix: z.string().min(3),
          dryRun: z.boolean().default(false),
        })
        .safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: parsed.error.message });
      const { prefix, dryRun } = parsed.data;
      if (!prefix.startsWith("pw-"))
        return reply
          .code(422)
          .send({ error: "only pw- test artifact prefixes can be purged" });
      const likePrefix = `${prefix}%`;
      const [counts] = (await db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM airfoils WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix}) AS airfoils,
        (SELECT count(*)::int FROM categories WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix} OR path ILIKE ${likePrefix}) AS categories,
        (SELECT count(*)::int FROM boundary_conditions WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix}) AS boundary_conditions,
	        (SELECT count(*)::int FROM simulation_presets WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix}) AS simulation_presets,
	        (SELECT count(*)::int FROM flow_conditions WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix}) AS flow_conditions,
	        (SELECT count(*)::int FROM reference_geometry_profiles WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix}) AS reference_geometry_profiles,
	        (SELECT count(*)::int FROM operating_conditions WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix}) AS operating_conditions,
        (SELECT count(*)::int FROM mediums WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix}) AS mediums,
        (SELECT count(*)::int FROM hashtags WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix}) AS hashtags,
        (SELECT count(*)::int FROM sim_campaigns WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix} OR idempotency_key LIKE ${likePrefix}) AS sim_campaigns
    `)) as unknown as {
        airfoils: number;
        categories: number;
        boundary_conditions: number;
        simulation_presets: number;
        flow_conditions: number;
        reference_geometry_profiles: number;
        operating_conditions: number;
        mediums: number;
        hashtags: number;
        sim_campaigns: number;
      }[];
      const targetPromises = (await db.execute(sql`
        SELECT DISTINCT promise.id, promise.status, cancellation.state AS cancellation_state
        FROM sync_sweep_promises promise
        JOIN airfoils airfoil ON airfoil.id = promise.airfoil_id
        LEFT JOIN simulation_preset_revisions revision
          ON revision.id = promise.simulation_preset_revision_id
        LEFT JOIN simulation_presets preset ON preset.id = revision.preset_id
        LEFT JOIN sync_remote_promise_cancellations cancellation
          ON cancellation.promise_id = promise.id
        WHERE airfoil.slug LIKE ${likePrefix}
           OR airfoil.name ILIKE ${likePrefix}
           OR preset.slug LIKE ${likePrefix}
           OR preset.name ILIKE ${likePrefix}
        ORDER BY promise.id
      `)) as unknown as Array<{
        id: string;
        status: string;
        cancellation_state: string | null;
      }>;
      const targetPromiseIds = targetPromises.map((row) => row.id);
      if (!dryRun) {
        const activeOrExpiredPromiseIds = targetPromises
          .filter((row) => row.status === "active" || row.status === "expired")
          .map((row) => row.id);
        const undeliveredCancellationPromiseIds = targetPromises
          .filter(
            (row) =>
              row.cancellation_state === "pending" ||
              row.cancellation_state === "retry_wait",
          )
          .map((row) => row.id);
        if (
          activeOrExpiredPromiseIds.length ||
          undeliveredCancellationPromiseIds.length
        ) {
          return reply.code(409).send({
            error:
              "test-artifact purge refused because remote promises or cancellation deliveries are unfinished",
            activeOrExpiredPromiseIds,
            undeliveredCancellationPromiseIds,
          });
        }
      }
      // ---- campaign-family purge (spec §13 test hygiene) ------------------
      // The physical fidelity-ladder work is globally owned: its sim_jobs use
      // campaign_id = NULL and carry stable owner ids in request_payload. Plan,
      // lock and delete that graph in one transaction so purge cannot strand a
      // job, erase another campaign's work, or leave a revision pinned by an
      // invisible obligation ledger.
      const campaignOutcome = await db.transaction(async (tx) => {
        const campaignPurged = {
          campaign_results: 0,
          campaign_sim_jobs: 0,
          campaign_precalc_obligations: 0,
          campaign_precalc_obligation_attempts: 0,
          campaign_urans_requests: 0,
          campaign_urans_verify_items: 0,
          campaign_presets: 0,
          campaign_legacy_boundary_conditions: 0,
          campaign_flow_conditions: 0,
          campaign_reference_geometry_profiles: 0,
        };
        const campaignRows = (await tx.execute(sql`
          SELECT id FROM sim_campaigns
          WHERE slug LIKE ${likePrefix}
             OR name ILIKE ${likePrefix}
             OR idempotency_key LIKE ${likePrefix}
          FOR UPDATE
        `)) as unknown as Array<{ id: string }>;
        const campaignIds = campaignRows.map((row) => row.id);
        if (!campaignIds.length) {
          if (!dryRun) {
            const promisePurge = await purgeSyncSweepPromisesInTransaction(
              tx as unknown as DB,
              targetPromiseIds,
            );
            if (promisePurge.kind === "refused") {
              return {
                kind: "promise_refused" as const,
                campaignPurged,
                promisePurge,
              };
            }
          }
          return { kind: "ok" as const, campaignPurged };
        }

        const idsArray = `{${campaignIds.join(",")}}`;
        const exclusiveObligations = (await tx.execute(sql`
          SELECT obligation.id
          FROM sim_precalc_obligations obligation
          WHERE obligation.background_owner = false
            AND EXISTS (
              SELECT 1 FROM sim_precalc_obligation_campaigns target_owner
              WHERE target_owner.obligation_id = obligation.id
                AND target_owner.campaign_id = ANY(${idsArray}::uuid[])
            )
            AND NOT EXISTS (
              SELECT 1 FROM sim_precalc_obligation_campaigns survivor
              WHERE survivor.obligation_id = obligation.id
                AND survivor.campaign_id <> ALL(${idsArray}::uuid[])
            )
            AND NOT EXISTS (
              SELECT 1
              FROM sim_precalc_obligation_requests request_link
              JOIN sim_urans_requests request
                ON request.id = request_link.request_id
              WHERE request_link.obligation_id = obligation.id
                AND (
                  request.background_owner
                  OR EXISTS (
                    SELECT 1 FROM sim_urans_request_campaigns survivor
                    WHERE survivor.request_id = request.id
                      AND survivor.campaign_id <> ALL(${idsArray}::uuid[])
                  )
                )
            )
          FOR UPDATE OF obligation
        `)) as unknown as Array<{ id: string }>;
        const obligationIds = exclusiveObligations.map((row) => row.id);
        const obligationIdsArray = `{${obligationIds.join(",")}}`;

        const exclusiveRequests = (await tx.execute(sql`
          SELECT request.id
          FROM sim_urans_requests request
          WHERE request.background_owner = false
            AND EXISTS (
              SELECT 1 FROM sim_urans_request_campaigns target_owner
              WHERE target_owner.request_id = request.id
                AND target_owner.campaign_id = ANY(${idsArray}::uuid[])
            )
            AND NOT EXISTS (
              SELECT 1 FROM sim_urans_request_campaigns survivor
              WHERE survivor.request_id = request.id
                AND survivor.campaign_id <> ALL(${idsArray}::uuid[])
            )
          FOR UPDATE OF request
        `)) as unknown as Array<{ id: string }>;
        const requestIds = exclusiveRequests.map((row) => row.id);
        const requestIdsArray = `{${requestIds.join(",")}}`;

        const exclusiveVerifyItems = (await tx.execute(sql`
          SELECT verify_item.id
          FROM sim_urans_verify_queue verify_item
          WHERE verify_item.background_owner = false
            AND EXISTS (
              SELECT 1 FROM sim_urans_verify_queue_campaigns target_owner
              WHERE target_owner.queue_id = verify_item.id
                AND target_owner.campaign_id = ANY(${idsArray}::uuid[])
            )
            AND NOT EXISTS (
              SELECT 1 FROM sim_urans_verify_queue_campaigns survivor
              WHERE survivor.queue_id = verify_item.id
                AND survivor.campaign_id <> ALL(${idsArray}::uuid[])
            )
          FOR UPDATE OF verify_item
        `)) as unknown as Array<{ id: string }>;
        const verifyIds = exclusiveVerifyItems.map((row) => row.id);
        const verifyIdsArray = `{${verifyIds.join(",")}}`;

        // A precalc composition may cover several obligations. It is target-
        // exclusive only when the payload is non-empty and EVERY physical
        // obligation is target-exclusive. Full request/verify work has no
        // precalc array and is scoped by its normalized owner row instead.
        const physicalJobs = (await tx.execute(sql`
          SELECT job.id, job.status
          FROM sim_jobs job
          CROSS JOIN LATERAL (
            SELECT CASE
              WHEN jsonb_typeof(job.request_payload -> 'precalcObligationIds') = 'array'
              THEN job.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END AS obligation_ids
          ) payload
          WHERE job.campaign_id = ANY(${idsArray}::uuid[])
             OR (
               jsonb_array_length(payload.obligation_ids) > 0
               AND EXISTS (
                 SELECT 1 FROM jsonb_array_elements_text(payload.obligation_ids) item(id)
                 WHERE item.id = ANY(${obligationIdsArray}::text[])
               )
               AND NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements_text(payload.obligation_ids) item(id)
                 WHERE item.id <> ALL(${obligationIdsArray}::text[])
               )
             )
             OR (
               jsonb_array_length(payload.obligation_ids) = 0
               AND (
                 job.request_payload ->> 'uransRequestId' = ANY(${requestIdsArray}::text[])
                 OR job.request_payload ->> 'verifyQueueItemId' = ANY(${verifyIdsArray}::text[])
               )
             )
          FOR UPDATE OF job
        `)) as unknown as Array<{ id: string; status: string }>;
        const physicalJobIds = physicalJobs.map((row) => row.id);
        const physicalJobIdsArray = `{${physicalJobIds.join(",")}}`;
        const [attemptCount] = (await tx.execute(sql`
          SELECT count(*)::int AS n
          FROM sim_precalc_obligation_attempts
          WHERE obligation_id = ANY(${obligationIdsArray}::uuid[])
        `)) as unknown as Array<{ n: number }>;
        const targetProducedResult = sql`(
          result.sim_job_id = ANY(${physicalJobIdsArray}::uuid[])
          OR EXISTS (
            SELECT 1 FROM result_attempts produced_attempt
            WHERE produced_attempt.result_id = result.id
              AND produced_attempt.sim_job_id = ANY(${physicalJobIdsArray}::uuid[])
          )
          OR EXISTS (
            SELECT 1 FROM airfoils produced_airfoil
            WHERE produced_airfoil.id = result.airfoil_id
              AND (produced_airfoil.slug LIKE ${likePrefix} OR produced_airfoil.name ILIKE ${likePrefix})
          )
          OR EXISTS (
            SELECT 1
            FROM simulation_preset_revisions produced_revision
            JOIN simulation_presets produced_preset
              ON produced_preset.id = produced_revision.preset_id
            WHERE produced_revision.id = result.simulation_preset_revision_id
              AND (produced_preset.slug LIKE ${likePrefix} OR produced_preset.name ILIKE ${likePrefix})
          )
        ) AND NOT (
          EXISTS (
            SELECT 1
            FROM sim_precalc_obligations retained_obligation
            WHERE retained_obligation.airfoil_id = result.airfoil_id
              AND retained_obligation.revision_id = result.simulation_preset_revision_id
              AND retained_obligation.aoa_deg = result.aoa_deg
              AND (
                retained_obligation.background_owner
                OR EXISTS (
                  SELECT 1
                  FROM sim_precalc_obligation_requests retained_link
                  JOIN sim_urans_requests retained_request
                    ON retained_request.id = retained_link.request_id
                  WHERE retained_link.obligation_id = retained_obligation.id
                    AND retained_request.background_owner
                )
              )
          )
          OR EXISTS (
            SELECT 1 FROM sim_urans_verify_queue retained_verify
            WHERE retained_verify.background_owner
              AND (retained_verify.precalc_result_id = result.id OR retained_verify.verify_result_id = result.id)
          )
          OR EXISTS (
            SELECT 1 FROM sim_urans_requests retained_request
            WHERE retained_request.background_owner
              AND retained_request.continue_from_result_id = result.id
          )
          OR EXISTS (
            SELECT 1
            FROM sync_sweep_promise_points retained_point
            JOIN sync_sweep_promises retained_promise
              ON retained_promise.id = retained_point.promise_id
            WHERE retained_point.result_id = result.id
              AND retained_promise.status = 'active'
              AND retained_promise."expiresAt" > now()
          )
        )`;
        const [resultCount] = (await tx.execute(sql`
          SELECT count(DISTINCT result.id)::int AS n
          FROM results result
          JOIN sim_campaign_points target_point
            ON target_point.airfoil_id = result.airfoil_id
           AND target_point.revision_id = result.simulation_preset_revision_id
           AND target_point.aoa_deg = result.aoa_deg
          WHERE target_point.campaign_id = ANY(${idsArray}::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM sim_campaign_points survivor
              WHERE survivor.campaign_id <> ALL(${idsArray}::uuid[])
                AND survivor.airfoil_id = result.airfoil_id
                AND survivor.revision_id = result.simulation_preset_revision_id
                AND survivor.aoa_deg = result.aoa_deg
            )
            AND ${targetProducedResult}
        `)) as unknown as Array<{ n: number }>;
        campaignPurged.campaign_results = Number(resultCount?.n ?? 0);
        campaignPurged.campaign_sim_jobs = physicalJobs.length;
        campaignPurged.campaign_precalc_obligations = obligationIds.length;
        campaignPurged.campaign_precalc_obligation_attempts = Number(
          attemptCount?.n ?? 0,
        );
        campaignPurged.campaign_urans_requests = requestIds.length;
        campaignPurged.campaign_urans_verify_items = verifyIds.length;

        if (dryRun) return { kind: "ok" as const, campaignPurged };

        const activeJobs = physicalJobs.filter((job) =>
          ["pending", "submitted", "running", "ingesting"].includes(job.status),
        );
        if (activeJobs.length)
          return { kind: "active_jobs" as const, campaignPurged, activeJobs };

        const promisePurge = await purgeSyncSweepPromisesInTransaction(
          tx as unknown as DB,
          targetPromiseIds,
        );
        if (promisePurge.kind === "refused") {
          return {
            kind: "promise_refused" as const,
            campaignPurged,
            promisePurge,
          };
        }

        // Capture derived artifact ids before campaign deletion nulls their
        // created_by_campaign_id provenance and cascades condition rows.
        const presetIdRows = (await tx.execute(sql`
          SELECT DISTINCT preset_id AS id
          FROM sim_campaign_conditions
          WHERE campaign_id = ANY(${idsArray}::uuid[])
        `)) as unknown as Array<{ id: string }>;
        const flowIdRows = (await tx.execute(sql`
          SELECT id FROM flow_conditions
          WHERE created_by_campaign_id = ANY(${idsArray}::uuid[])
        `)) as unknown as Array<{ id: string }>;
        const geoIdRows = (await tx.execute(sql`
          SELECT id FROM reference_geometry_profiles
          WHERE created_by_campaign_id = ANY(${idsArray}::uuid[])
        `)) as unknown as Array<{ id: string }>;

        if (requestIds.length)
          await tx.execute(sql`
            DELETE FROM sim_urans_requests
            WHERE id = ANY(${requestIdsArray}::uuid[])
          `);
        if (verifyIds.length)
          await tx.execute(sql`
            DELETE FROM sim_urans_verify_queue
            WHERE id = ANY(${verifyIdsArray}::uuid[])
          `);
        const deletedResults = (await tx.execute(sql`
          DELETE FROM results result
          USING sim_campaign_points target_point
          WHERE target_point.campaign_id = ANY(${idsArray}::uuid[])
            AND result.airfoil_id = target_point.airfoil_id
            AND result.simulation_preset_revision_id = target_point.revision_id
            AND result.aoa_deg = target_point.aoa_deg
            AND NOT EXISTS (
              SELECT 1 FROM sim_campaign_points survivor
              WHERE survivor.campaign_id <> ALL(${idsArray}::uuid[])
                AND survivor.airfoil_id = result.airfoil_id
                AND survivor.revision_id = result.simulation_preset_revision_id
                AND survivor.aoa_deg = result.aoa_deg
            )
            AND ${targetProducedResult}
          RETURNING result.id
        `)) as unknown as unknown[];
        campaignPurged.campaign_results = deletedResults.length;
        if (physicalJobIds.length)
          await tx.execute(sql`
            DELETE FROM sim_jobs
            WHERE id = ANY(${physicalJobIdsArray}::uuid[])
          `);
        if (obligationIds.length)
          await tx.execute(sql`
            DELETE FROM sim_precalc_obligations
            WHERE id = ANY(${obligationIdsArray}::uuid[])
          `);
        await tx.execute(
          sql`DELETE FROM sim_campaigns WHERE id = ANY(${idsArray}::uuid[])`,
        );

        if (presetIdRows.length > 0) {
          const presetIdsArray = `{${presetIdRows.map((row) => row.id).join(",")}}`;
          const deletedPresets = (await tx.execute(sql`
            DELETE FROM simulation_presets preset
            WHERE preset.id = ANY(${presetIdsArray}::uuid[])
              AND preset.origin = 'campaign'
              AND NOT EXISTS (
                SELECT 1 FROM sim_campaign_conditions condition
                WHERE condition.preset_id = preset.id
              )
              AND NOT EXISTS (
                SELECT 1 FROM simulation_preset_revisions revision
                WHERE revision.preset_id = preset.id AND (
                  EXISTS (SELECT 1 FROM results result WHERE result.simulation_preset_revision_id = revision.id)
                  OR EXISTS (SELECT 1 FROM result_attempts attempt WHERE attempt.simulation_preset_revision_id = revision.id)
                  OR EXISTS (SELECT 1 FROM sim_jobs job WHERE job.simulation_preset_revision_id = revision.id)
                  OR EXISTS (SELECT 1 FROM sim_campaign_conditions condition WHERE condition.simulation_preset_revision_id = revision.id)
                  OR EXISTS (SELECT 1 FROM sim_precalc_obligations obligation WHERE obligation.revision_id = revision.id)
                  OR EXISTS (SELECT 1 FROM sim_urans_requests request WHERE request.revision_id = revision.id)
                  OR EXISTS (SELECT 1 FROM sim_urans_verify_queue verify_item WHERE verify_item.revision_id = revision.id)
                  OR EXISTS (SELECT 1 FROM sync_sweep_promises promise WHERE promise.simulation_preset_revision_id = revision.id)
                )
              )
            RETURNING preset.legacy_boundary_condition_id
          `)) as unknown as Array<{
            legacy_boundary_condition_id: string | null;
          }>;
          campaignPurged.campaign_presets = deletedPresets.length;
          const legacyIds = deletedPresets
            .map((row) => row.legacy_boundary_condition_id)
            .filter((id): id is string => Boolean(id));
          if (legacyIds.length > 0) {
            const legacyIdsArray = `{${legacyIds.join(",")}}`;
            const deletedLegacy = (await tx.execute(sql`
              DELETE FROM boundary_conditions boundary
              WHERE boundary.id = ANY(${legacyIdsArray}::uuid[])
                AND NOT EXISTS (
                  SELECT 1 FROM simulation_presets preset
                  WHERE preset.legacy_boundary_condition_id = boundary.id
                )
              RETURNING boundary.id
            `)) as unknown as unknown[];
            campaignPurged.campaign_legacy_boundary_conditions =
              deletedLegacy.length;
          }
        }
        if (flowIdRows.length > 0) {
          const flowIdsArray = `{${flowIdRows.map((row) => row.id).join(",")}}`;
          const deletedFlow = (await tx.execute(sql`
            DELETE FROM flow_conditions flow
            WHERE flow.id = ANY(${flowIdsArray}::uuid[])
              AND flow.origin = 'campaign'
              AND NOT EXISTS (SELECT 1 FROM simulation_presets preset WHERE preset.flow_condition_id = flow.id)
              AND NOT EXISTS (SELECT 1 FROM sim_campaign_conditions condition WHERE condition.flow_condition_id = flow.id)
            RETURNING flow.id
          `)) as unknown as unknown[];
          campaignPurged.campaign_flow_conditions = deletedFlow.length;
        }
        if (geoIdRows.length > 0) {
          const geoIdsArray = `{${geoIdRows.map((row) => row.id).join(",")}}`;
          const deletedGeo = (await tx.execute(sql`
            DELETE FROM reference_geometry_profiles geometry
            WHERE geometry.id = ANY(${geoIdsArray}::uuid[])
              AND geometry.origin = 'campaign'
              AND NOT EXISTS (SELECT 1 FROM simulation_presets preset WHERE preset.reference_geometry_profile_id = geometry.id)
              AND NOT EXISTS (SELECT 1 FROM sim_campaign_conditions condition WHERE condition.reference_geometry_profile_id = geometry.id)
            RETURNING geometry.id
          `)) as unknown as unknown[];
          campaignPurged.campaign_reference_geometry_profiles =
            deletedGeo.length;
        }
        return { kind: "ok" as const, campaignPurged };
      });

      if (dryRun)
        return {
          dryRun: true,
          purged: {
            ...(counts ?? {
              airfoils: 0,
              categories: 0,
              boundary_conditions: 0,
              mediums: 0,
              hashtags: 0,
              sim_campaigns: 0,
            }),
            ...campaignOutcome.campaignPurged,
          },
        };
      if (campaignOutcome.kind === "active_jobs")
        return reply.code(409).send({
          error:
            "test-artifact purge refused because target-owned solver jobs are still active",
          activeJobs: campaignOutcome.activeJobs,
        });
      if (campaignOutcome.kind === "promise_refused") {
        return reply.code(409).send({
          error:
            "test-artifact purge refused because remote promise state changed during purge",
          ...campaignOutcome.promisePurge,
        });
      }
      const campaignPurged = campaignOutcome.campaignPurged;

      await db
        .delete(airfoils)
        .where(
          or(like(airfoils.slug, likePrefix), like(airfoils.name, likePrefix)),
        );
      await db.execute(sql`
      DELETE FROM sim_jobs j
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(j.bc_ids) AS bc(id)
        JOIN boundary_conditions b ON b.id::text = bc.id
        WHERE b.slug LIKE ${likePrefix} OR b.name ILIKE ${likePrefix}
      )
    `);
      await db
        .delete(simulationPresets)
        .where(
          or(
            like(simulationPresets.slug, likePrefix),
            like(simulationPresets.name, likePrefix),
          ),
        );
      await db
        .delete(boundaryConditions)
        .where(
          or(
            like(boundaryConditions.slug, likePrefix),
            like(boundaryConditions.name, likePrefix),
          ),
        );
      await db
        .delete(flowConditions)
        .where(
          or(
            like(flowConditions.slug, likePrefix),
            like(flowConditions.name, likePrefix),
          ),
        );
      await db
        .delete(referenceGeometryProfiles)
        .where(
          or(
            like(referenceGeometryProfiles.slug, likePrefix),
            like(referenceGeometryProfiles.name, likePrefix),
          ),
        );
      await db
        .delete(operatingConditions)
        .where(
          or(
            like(operatingConditions.slug, likePrefix),
            like(operatingConditions.name, likePrefix),
          ),
        );
      await db
        .delete(boundaryProfiles)
        .where(
          or(
            like(boundaryProfiles.slug, likePrefix),
            like(boundaryProfiles.name, likePrefix),
          ),
        );
      await db
        .delete(meshProfiles)
        .where(
          or(
            like(meshProfiles.slug, likePrefix),
            like(meshProfiles.name, likePrefix),
          ),
        );
      await db
        .delete(solverProfiles)
        .where(
          or(
            like(solverProfiles.slug, likePrefix),
            like(solverProfiles.name, likePrefix),
          ),
        );
      await db
        .delete(schedulingProfiles)
        .where(
          or(
            like(schedulingProfiles.slug, likePrefix),
            like(schedulingProfiles.name, likePrefix),
          ),
        );
      await db
        .delete(outputProfiles)
        .where(
          or(
            like(outputProfiles.slug, likePrefix),
            like(outputProfiles.name, likePrefix),
          ),
        );
      await db
        .delete(sweepDefinitions)
        .where(
          or(
            like(sweepDefinitions.slug, likePrefix),
            like(sweepDefinitions.name, likePrefix),
          ),
        );
      await db.execute(sql`
      UPDATE categories
      SET parent_id = NULL
      WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix} OR path ILIKE ${likePrefix}
    `);
      await db
        .delete(categories)
        .where(
          or(
            like(categories.slug, likePrefix),
            like(categories.name, likePrefix),
            like(categories.path, likePrefix),
          ),
        );
      await db
        .delete(hashtags)
        .where(
          or(like(hashtags.slug, likePrefix), like(hashtags.name, likePrefix)),
        );
      await db.execute(sql`
      DELETE FROM mediums m
      WHERE (m.slug LIKE ${likePrefix} OR m.name ILIKE ${likePrefix})
        AND NOT EXISTS (SELECT 1 FROM boundary_conditions b WHERE b.medium_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM operating_conditions oc WHERE oc.medium_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM flow_conditions f WHERE f.medium_id = m.id)
    `);
      return {
        purged: {
          ...(counts ?? {
            airfoils: 0,
            categories: 0,
            boundary_conditions: 0,
            mediums: 0,
            hashtags: 0,
            sim_campaigns: 0,
          }),
          ...campaignPurged,
        },
      };
    },
  );

  app.post(
    "/api/admin/jobs/recover-stale",
    { preHandler: requireAdmin },
    async (req) => {
      const b = z
        .object({
          olderThanMinutes: z
            .number()
            .int()
            .positive()
            .max(24 * 60)
            .default(30),
          // Optional deterministic scope for one-shot maintenance/recovery. The
          // production deploy script omits it and keeps the established global
          // scan; tests and targeted admin repairs can avoid touching unrelated
          // active work.
          jobIds: z.array(z.string().uuid()).max(100).optional(),
        })
        .parse(req.body ?? {});
      const candidateFilters = [
        inArray(simJobs.status, ["submitted", "running", "ingesting"] as const),
        isNotNull(simJobs.engineJobId),
        sql`COALESCE(${simJobs.submittedAt}, ${simJobs.createdAt}) < now() - (${b.olderThanMinutes} || ' minutes')::interval`,
        // A live ingest owner is the sole evidence writer. This is the same
        // explicit-expiry / tokenless-legacy-grace rule used by the sweeper.
        outsideLiveSimJobIngestLeaseWhere(),
      ];
      if (b.jobIds?.length)
        candidateFilters.push(inArray(simJobs.id, b.jobIds));
      const candidateRows = await db
        .select()
        .from(simJobs)
        .where(and(...candidateFilters));
      if (candidateRows.length === 0) {
        return {
          recovered: 0,
          requeuedResults: 0,
          requeued: 0,
          keptRunning: 0,
          ingestReady: 0,
          // Backward-compatible response field. Recovery no longer manufactures
          // tokenless ingest owners; only the sweeper's atomic lease claim may
          // transition a job to `ingesting`.
          markedIngesting: 0,
          unchanged: 0,
        };
      }

      const engine = new EngineClient(env.engineUrl);
      let engineQueue: EngineQueueState | null = null;
      try {
        engineQueue = await engine.getQueue();
      } catch {
        engineQueue = null;
      }
      const runtimeByEngineJobId = await engineRuntimeMap(
        engine,
        candidateRows
          .map((row) => row.engineJobId)
          .filter((id): id is string => Boolean(id)),
      );

      let requeuedResults = 0;
      let requeued = 0;
      let keptRunning = 0;
      let ingestReady = 0;
      let unchanged = 0;
      for (const job of candidateRows) {
        const runtime = job.engineJobId
          ? runtimeByEngineJobId.get(job.engineJobId)
          : null;
        if (!runtime && !engineQueue) {
          unchanged++;
          continue;
        }
        const classified = classifyQueueLifecycle(
          {
            status: job.status,
            engineJobId: job.engineJobId,
            engineState: job.engineState,
            createdAt: job.createdAt,
            submittedAt: job.submittedAt,
            polledAt: job.polledAt,
          },
          runtime,
          engineQueue,
          { recoverImmediately: true, staleMs: b.olderThanMinutes * 60 * 1000 },
        );

        if (classified.needsIngest) {
          // Result-ready is an observation, not an ownership claim. Leave the
          // row submitted/running (or expired-ingesting) so claimJobForIngest can
          // acquire a real fenced token. A no-op recheck avoids reporting a row
          // which a concurrent sweeper already claimed after candidate loading.
          const [eligible] = await db
            .select({ id: simJobs.id })
            .from(simJobs)
            .where(
              and(
                eq(simJobs.id, job.id),
                inArray(simJobs.status, [
                  "submitted",
                  "running",
                  "ingesting",
                ] as const),
                outsideLiveSimJobIngestLeaseWhere(),
              ),
            )
            .limit(1);
          if (eligible) ingestReady++;
          else unchanged++;
          continue;
        }

        if (!classified.recoverable) {
          if (
            classified.runtimeState === "worker_visible" ||
            classified.runtimeState === "detached_running" ||
            classified.processCount > 0
          ) {
            const [kept] = await db
              .update(simJobs)
              .set({
                status: "running",
                engineState:
                  runtime?.status_state ?? job.engineState ?? "running",
                totalCases: runtime?.status_total_cases ?? job.totalCases,
                completedCases:
                  runtime?.status_completed_cases ?? job.completedCases,
                error: classified.staleReason,
                polledAt: new Date(),
                finishedAt: null,
                ingestLeaseToken: null,
                ingestLeaseClaimedAt: null,
                ingestLeaseExpiresAt: null,
              })
              .where(
                and(
                  eq(simJobs.id, job.id),
                  inArray(simJobs.status, [
                    "submitted",
                    "running",
                    "ingesting",
                  ] as const),
                  outsideLiveSimJobIngestLeaseWhere(),
                ),
              )
              .returning({ id: simJobs.id });
            if (kept) keptRunning++;
            else unchanged++;
          } else {
            unchanged++;
          }
          continue;
        }

        const recovered = await db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as DB;
          // Ingest owns evidence settlement while its lease is live. Recovery
          // may win submitted/running or an EXPIRED ingest lease → cancelled.
          // The claim release happens after, in this same transaction, so it
          // cannot detach rows from a concurrent ingest winner.
          const [stopped] = await tx
            .update(simJobs)
            .set({
              status: "cancelled",
              engineState: "missing",
              finishedAt: new Date(),
              error:
                classified.staleReason ??
                `stale/orphan recovery after ${b.olderThanMinutes} minutes`,
              ingestLeaseToken: null,
              ingestLeaseClaimedAt: null,
              ingestLeaseExpiresAt: null,
            })
            .where(
              and(
                eq(simJobs.id, job.id),
                inArray(simJobs.status, ["submitted", "running", "ingesting"]),
                outsideLiveSimJobIngestLeaseWhere(),
              ),
            )
            .returning({ id: simJobs.id });
          if (!stopped) return null;
          const released = await releaseResultClaimsForJob(tx, job.id, [
            "queued",
            "running",
            "pending",
            "stale",
          ]);
          const settlement = await settlePrecalcObligationsForJobInTransaction(
            tx,
            job,
            {
              terminalError:
                classified.staleReason ??
                `stale/orphan recovery after ${b.olderThanMinutes} minutes`,
              cancellation: "transient",
            },
          );
          return { released, campaignIds: settlement.campaignIds };
        });
        if (recovered === null) {
          unchanged++;
          continue;
        }
        await refreshPrecalcSettlementCampaigns(db, recovered.campaignIds);
        requeuedResults += recovered.released;
        requeued++;
      }
      return {
        recovered: requeued + ingestReady,
        requeuedResults,
        requeued,
        keptRunning,
        ingestReady,
        markedIngesting: 0,
        unchanged,
      };
    },
  );

  app.post(
    "/api/admin/jobs/:id/cancel",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      // One shared DB boundary owns cancellation across the API and sweeper:
      // pending compositions are cancellable; ingesting is not. The conditional
      // transition and claim release are one transaction, so a stale API read
      // can never release rows underneath an ingest that already won.
      const cancellation = await claimSimJobCancellation(
        db,
        id,
        "cancelled by admin",
      );
      if (cancellation.kind === "not_cancellable") {
        if (!cancellation.status)
          return reply.code(404).send({ error: "job not found" });
        return reply.code(409).send({
          error: `job is no longer cancellable (status: ${cancellation.status})`,
          code: "job_not_active",
          status: cancellation.status,
        });
      }

      let engineCancelError: string | null = null;
      if (cancellation.engineJobId) {
        try {
          await new EngineClient(env.engineUrl).cancelJob(
            cancellation.engineJobId,
          );
        } catch (e) {
          engineCancelError = (e as Error).message;
        }
      }
      await db
        .update(simJobs)
        .set({
          engineState: engineCancelError ? "cancel_pending" : "cancelled",
          error: engineCancelError
            ? `cancelled by admin; engine cancel failed: ${engineCancelError}`
            : "cancelled by admin",
        })
        .where(and(eq(simJobs.id, id), eq(simJobs.status, "cancelled")));
      return {
        cancelled: true,
        engineCancelled: Boolean(
          cancellation.engineJobId && !engineCancelError,
        ),
        engineCancelError,
      };
    },
  );
}
