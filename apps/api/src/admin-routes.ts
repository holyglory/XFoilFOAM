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
  simulationPresetAirfoilTargets,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  sweeperState,
  sweepDefinitions,
} from "@aerodb/db";
import {
  ensureEnabledSimulationPresetRevisions,
  ensureSimulationPresetRevision,
  resolveSimulationPresetSnapshot,
  type SimulationSetupSnapshot,
} from "@aerodb/db/simulation-setup";
import { EngineClient, EngineError, classifyQueueLifecycle, type EngineQueueState, type JobRuntimeSummary } from "@aerodb/engine-client";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, like, or, sql } from "drizzle-orm";
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
  signOAuthState,
  signSession,
  verifyOAuthState,
  verifySession,
} from "./admin-auth";
import { db } from "./db";
import { env } from "./env";
import { categoriesTree } from "./services/catalog";
import { hashtagsByAirfoilIds, listHashtags, slugifyHashtag, toHashtagDTO } from "./services/hashtags";
import {
  deriveBcState,
  deriveFlowState,
  mediumViscosityColumns,
  mediumViscosityInputFromMedium,
  resolveViscosity,
  tablePointsDTO,
  toMediumDTO,
} from "./services/mediums";

const activeSimJobStatuses: Array<"submitted" | "running" | "ingesting"> = ["submitted", "running", "ingesting"];
const imageFieldName = z.enum(ALL_IMAGE_FIELDS);

function activeSimJobWhere(jobId: string) {
  return and(eq(simJobs.id, jobId), inArray(simJobs.status, activeSimJobStatuses));
}

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
    const [exists] = await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, slug)).limit(1);
    if (!exists) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

async function categoryPlacement(parentId: string | null | undefined, slug: string) {
  if (!parentId) return { parentId: null, path: slug, depth: 0 };
  const [parent] = await db.select().from(categories).where(eq(categories.id, parentId)).limit(1);
  if (!parent) throw new Error("parent category not found");
  return { parentId: parent.id, path: `${parent.path}/${slug}`, depth: parent.depth + 1 };
}

async function moveCategorySubtree(current: Category, parentId: string | null | undefined): Promise<string | null> {
  if (parentId === current.id) throw new Error("category cannot be moved into itself");
  const placement = await categoryPlacement(parentId, current.slug);
  if (placement.path === current.path || placement.path.startsWith(current.path + "/")) {
    throw new Error("category cannot be moved into its own descendant");
  }
  const subtree = await db
    .select({ id: categories.id, path: categories.path })
    .from(categories)
    .where(or(eq(categories.id, current.id), like(categories.path, current.path + "/%")));
  for (const row of subtree) {
    const suffix = row.path.slice(current.path.length);
    const path = placement.path + suffix;
    await db
      .update(categories)
      .set({ path, depth: path.split("/").length - 1, parentId: row.id === current.id ? placement.parentId : undefined })
      .where(eq(categories.id, row.id));
  }
  return placement.parentId;
}

async function syncLegacyTagsForAirfoils(ids: string[]): Promise<void> {
  const map = await hashtagsByAirfoilIds(ids);
  for (const id of ids) {
    await db.update(airfoils).set({ tags: (map.get(id) ?? []).map((h) => h.name) }).where(eq(airfoils.id, id));
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
}

function iso(v: Date | string | null): string | null {
  if (!v) return null;
  return v instanceof Date ? v.toISOString() : v;
}

const QUEUE_REVISION_ENSURE_TTL_MS = 10_000;
const ENGINE_QUEUE_FRESH_TTL_MS = 5_000;
const ENGINE_QUEUE_BACKGROUND_TIMEOUT_MS = 750;
const ENGINE_HEALTH_FRESH_TTL_MS = 15_000;
const ENGINE_RUNTIME_UNSUPPORTED_TTL_MS = 60_000;

let queueRevisionEnsureAt = 0;
let queueRevisionEnsurePromise: Promise<void> | null = null;
let engineRuntimeUnsupportedUntil = 0;
let engineQueueCache:
  | {
      expiresAt: number;
      promise: Promise<{ queue: EngineQueueState | null; error: string | null }>;
      value: { queue: EngineQueueState | null; error: string | null } | null;
    }
  | null = null;
let engineHealthCache:
  | {
      expiresAt: number;
      promise: Promise<{ health: Awaited<ReturnType<EngineClient["healthDetails"]>> | null; error: string | null }>;
      value: { health: Awaited<ReturnType<EngineClient["healthDetails"]>> | null; error: string | null } | null;
    }
  | null = null;

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

async function getCachedEngineQueue(engine: EngineClient): Promise<{ queue: EngineQueueState | null; error: string | null }> {
  const now = Date.now();
  if (engineQueueCache && engineQueueCache.expiresAt > now) return engineQueueCache.promise;

  const previous = engineQueueCache?.value ?? null;
  const promise = engine
    .getQueue()
    .then((queue) => ({ queue, error: null }))
    .catch((e) => ({ queue: null, error: (e as Error).message }));

  const entry: NonNullable<typeof engineQueueCache> = {
    expiresAt: now + ENGINE_QUEUE_FRESH_TTL_MS,
    promise: promise.then((value) => {
      if (engineQueueCache === entry) entry.value = value;
      return value;
    }),
    value: previous,
  };
  engineQueueCache = entry;

  if (previous) {
    void entry.promise.catch(() => undefined);
    return previous;
  }

  return Promise.race([
    entry.promise,
    new Promise<{ queue: EngineQueueState | null; error: string | null }>((resolve) =>
      setTimeout(() => resolve({ queue: null, error: "engine queue refresh is still running" }), ENGINE_QUEUE_BACKGROUND_TIMEOUT_MS),
    ),
  ]);
}

async function getCachedEngineHealth(engine: EngineClient): Promise<{ health: Awaited<ReturnType<EngineClient["healthDetails"]>> | null; error: string | null }> {
  const now = Date.now();
  if (engineHealthCache && engineHealthCache.expiresAt > now) return engineHealthCache.promise;
  const previous = engineHealthCache?.value ?? null;
  const promise = engine
    .healthDetails()
    .then((health) => ({ health, error: null }))
    .catch((e) => ({ health: null, error: (e as Error).message }));
  const entry: NonNullable<typeof engineHealthCache> = {
    expiresAt: now + ENGINE_HEALTH_FRESH_TTL_MS,
    promise: promise.then((value) => {
      if (engineHealthCache === entry) entry.value = value;
      return value;
    }),
    value: previous,
  };
  engineHealthCache = entry;
  if (previous) {
    void entry.promise.catch(() => undefined);
    return previous;
  }
  return Promise.race([
    entry.promise,
    new Promise<{ health: Awaited<ReturnType<EngineClient["healthDetails"]>> | null; error: string | null }>((resolve) =>
      setTimeout(() => resolve({ health: null, error: "engine health refresh is still running" }), ENGINE_QUEUE_BACKGROUND_TIMEOUT_MS),
    ),
  ]);
}

function toQueueJob(r: QueueJobRow) {
  const createdAt = iso(r.created_at) ?? new Date().toISOString();
  const submittedAt = iso(r.submitted_at);
  const ageStart = submittedAt ?? createdAt;
  const pendingAgeSec = Math.max(0, Math.round((Date.now() - new Date(ageStart).getTime()) / 1000));
  const isActive = ["pending", "submitted", "running", "ingesting"].includes(r.status);
  const stale = isActive && pendingAgeSec > 30 * 60 && (r.engine_state == null || r.engine_state === "pending");
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
    referenceChordM: r.reference_chord_m == null ? null : Number(r.reference_chord_m),
    temperatureK: r.temperature_k == null ? null : Number(r.temperature_k),
    pressurePa: r.pressure_pa == null ? null : Number(r.pressure_pa),
    turbulenceModel: r.turbulence_model,
    turbulenceIntensity: r.turbulence_intensity == null ? null : Number(r.turbulence_intensity),
    viscosityRatio: r.viscosity_ratio == null ? null : Number(r.viscosity_ratio),
    schedulingPolicy: r.scheduling_policy ?? "auto",
    cpuBudget: r.cpu_budget == null ? null : Number(r.cpu_budget),
    caseConcurrency: r.case_concurrency == null ? null : Number(r.case_concurrency),
    solverProcesses: r.solver_processes == null ? null : Number(r.solver_processes),
    workerCpuBudget: r.worker_cpu_budget == null ? null : Number(r.worker_cpu_budget),
    meshBuildCount: r.mesh_build_count == null ? null : Number(r.mesh_build_count),
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
  };
}

async function engineRuntimeMap(engine: EngineClient, jobIds: string[]): Promise<Map<string, JobRuntimeSummary>> {
  const unique = Array.from(new Set(jobIds.filter(Boolean)));
  if (unique.length === 0) return new Map();
  if (Date.now() < engineRuntimeUnsupportedUntil) return new Map();
  try {
    const response = await engine.getJobRuntimes(unique);
    return new Map(response.jobs.map((job) => [job.job_id, job]));
  } catch (e) {
    if (e instanceof EngineError && e.status === 405) {
      engineRuntimeUnsupportedUntil = Date.now() + ENGINE_RUNTIME_UNSUPPORTED_TTL_MS;
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
    constantDynamicViscosity: z.coerce.number().positive().nullable().optional(),
    sutherlandMuRef: z.coerce.number().positive().nullable().optional(),
    sutherlandTRef: z.coerce.number().positive().nullable().optional(),
    sutherlandS: z.coerce.number().positive().nullable().optional(),
    viscosityTable: z.array(viscosityTablePointBody).optional(),
    speedOfSound: z.coerce.number().positive().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

const mediumBody = mediumBodyBase.superRefine((b, ctx) => {
    if (b.viscosityModel === "constant" && !(Number(b.constantDynamicViscosity) > 0)) {
      ctx.addIssue({ code: "custom", path: ["constantDynamicViscosity"], message: "required for constant viscosity" });
    }
    if (
      b.viscosityModel === "sutherland" &&
      (!(Number(b.sutherlandMuRef) > 0) || !(Number(b.sutherlandTRef) > 0) || !(Number(b.sutherlandS) > 0))
    ) {
      ctx.addIssue({ code: "custom", path: ["sutherlandMuRef"], message: "Sutherland mu ref, T ref, and S are required" });
    }
    if (b.viscosityModel === "table" && (b.viscosityTable?.length ?? 0) < 1) {
      ctx.addIssue({ code: "custom", path: ["viscosityTable"], message: "at least one table point is required" });
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
  transientMaxCourant: z.coerce.number().positive().default(15),
  writeImages: z.array(imageFieldName).default([...ALL_IMAGE_FIELDS]),
  imageZoomChords: z.coerce.number().positive().default(2),
  schedulingPolicy: z.enum(["auto", "airfoil_parallel", "case_parallel", "exclusive"]).default("auto"),
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
  transientMaxCourant: z.coerce.number().positive().default(15),
});

const schedulingProfileBody = z.object({
  slug: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1),
  schedulingPolicy: z.enum(["auto", "airfoil_parallel", "case_parallel", "exclusive"]).default("auto"),
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
    const [exists] = await db.select({ id: mediums.id }).from(mediums).where(eq(mediums.slug, slug)).limit(1);
    if (!exists) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

async function tablePointsForMediums(ids: string[]) {
  if (ids.length === 0) return new Map<string, typeof mediumViscosityTablePoints.$inferSelect[]>();
  const rows = await db
    .select()
    .from(mediumViscosityTablePoints)
    .where(inArray(mediumViscosityTablePoints.mediumId, ids))
    .orderBy(asc(mediumViscosityTablePoints.mediumId), asc(mediumViscosityTablePoints.sortOrder));
  const map = new Map<string, typeof mediumViscosityTablePoints.$inferSelect[]>();
  for (const row of rows) {
    const bucket = map.get(row.mediumId) ?? [];
    bucket.push(row);
    map.set(row.mediumId, bucket);
  }
  return map;
}

async function saveMediumTableRows(mediumId: string, rows: NonNullable<z.infer<typeof mediumBody>["viscosityTable"]>) {
  await db.delete(mediumViscosityTablePoints).where(eq(mediumViscosityTablePoints.mediumId, mediumId));
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

async function uniqueBoundarySlug(base: string): Promise<string> {
  let slug = base;
  let n = 2;
  for (let i = 0; i < 1000; i++) {
    const [exists] = await db.select({ id: boundaryConditions.id }).from(boundaryConditions).where(eq(boundaryConditions.slug, slug)).limit(1);
    if (!exists) return slug;
    slug = `${base}-${n++}`;
  }
  return `${base}-${Date.now()}`;
}

async function uniqueSetupSlug(tableName: string, base: string): Promise<string> {
  let slug = base || "setup";
  let n = 2;
  for (let i = 0; i < 1000; i++) {
    const rows = await db.execute(sql`SELECT id FROM ${sql.raw(tableName)} WHERE slug = ${slug} LIMIT 1`);
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
    reynolds: r.revision?.reynolds ?? Math.round((r.flowState.speedMps * r.referenceGeometry.referenceLengthM) / r.flowState.kinematicViscosity),
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

function toAdminBoundaryCondition(r: { bc: typeof boundaryConditions.$inferSelect; mediumSlug: string; mediumName: string }) {
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
      .select({ flowState: flowConditions, mediumSlug: mediums.slug, mediumName: mediums.name })
      .from(flowConditions)
      .innerJoin(mediums, eq(mediums.id, flowConditions.mediumId))
      .orderBy(asc(flowConditions.name)),
    db.select().from(referenceGeometryProfiles).orderBy(asc(referenceGeometryProfiles.name)),
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
      .innerJoin(flowConditions, eq(flowConditions.id, simulationPresets.flowConditionId))
      .innerJoin(mediums, eq(mediums.id, flowConditions.mediumId))
      .innerJoin(referenceGeometryProfiles, eq(referenceGeometryProfiles.id, simulationPresets.referenceGeometryProfileId))
      .innerJoin(boundaryProfiles, eq(boundaryProfiles.id, simulationPresets.boundaryProfileId))
      .innerJoin(meshProfiles, eq(meshProfiles.id, simulationPresets.meshProfileId))
      .innerJoin(solverProfiles, eq(solverProfiles.id, simulationPresets.solverProfileId))
      .innerJoin(schedulingProfiles, eq(schedulingProfiles.id, simulationPresets.schedulingProfileId))
      .innerJoin(outputProfiles, eq(outputProfiles.id, simulationPresets.outputProfileId))
      .innerJoin(sweepDefinitions, eq(sweepDefinitions.id, simulationPresets.sweepDefinitionId))
      .orderBy(asc(simulationPresets.name)),
    db.select().from(simulationPresetRevisions).orderBy(desc(simulationPresetRevisions.revisionNumber)),
    db.select().from(simulationPresetAirfoilTargets),
    db
      .select({ id: airfoils.id, slug: airfoils.slug, name: airfoils.name })
      .from(airfoils)
      .where(and(isNull(airfoils.archivedAt), isNull(airfoils.deletedAt)))
      .orderBy(asc(airfoils.name)),
  ]);
  const latestRevisionByPreset = new Map<string, typeof simulationPresetRevisions.$inferSelect>();
  for (const revision of revisionRows) {
    if (!latestRevisionByPreset.has(revision.presetId)) latestRevisionByPreset.set(revision.presetId, revision);
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
    referenceGeometryProfiles: referenceRows.map((row) => ({ ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! })),
    boundaryProfiles: boundaryRows.map((row) => ({ ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! })),
    meshProfiles: meshRows.map((row) => ({ ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! })),
    solverProfiles: solverRows.map((row) => ({ ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! })),
    schedulingProfiles: schedulingRows.map((row) => ({ ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! })),
    outputProfiles: outputRows.map((row) => ({ ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! })),
    sweepDefinitions: sweepRows.map((row) => ({ ...row, createdAt: iso(row.createdAt)!, updatedAt: iso(row.updatedAt)! })),
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
  const derived = deriveFlowState(row.medium, row.flowState, points.get(row.medium.id) ?? []);
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
  const rows = await db.select({ id: flowConditions.id }).from(flowConditions).where(eq(flowConditions.mediumId, mediumId));
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
  const derived = deriveBcState(row.medium, row.bc, points.get(row.medium.id) ?? []);
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
  const rows = await db.select({ id: boundaryConditions.id }).from(boundaryConditions).where(eq(boundaryConditions.mediumId, mediumId));
  for (const row of rows) await refreshBoundaryConditionDerived(row.id);
}

function legacyBoundaryValuesFromSnapshot(snapshot: SimulationSetupSnapshot) {
  return {
    name: snapshot.preset.name,
    mediumId: snapshot.flowState.mediumId,
    reynolds: Math.round(snapshot.derived.reynolds),
    referenceChordM: snapshot.referenceGeometry.referenceLengthM,
    temperatureK: snapshot.flowState.temperatureK,
    pressurePa: snapshot.flowState.pressurePa,
    speedMps: snapshot.flowState.speedMps,
    density: snapshot.flowState.density,
    dynamicViscosity: snapshot.flowState.dynamicViscosity,
    kinematicViscosity: snapshot.flowState.kinematicViscosity,
    mach: snapshot.flowState.mach,
    turbulenceModel: snapshot.solver.turbulenceModel,
    turbulenceIntensity: snapshot.boundary.turbulenceIntensity,
    viscosityRatio: snapshot.boundary.viscosityRatio,
    sandGrainHeight: snapshot.boundary.sandGrainHeight,
    roughnessConstant: snapshot.boundary.roughnessConstant,
    mesher: snapshot.mesh.mesher,
    farfieldRadiusChords: snapshot.mesh.farfieldRadiusChords,
    wakeLengthChords: snapshot.mesh.wakeLengthChords,
    nSurface: snapshot.mesh.nSurface,
    nRadial: snapshot.mesh.nRadial,
    nWake: snapshot.mesh.nWake,
    targetYPlus: snapshot.mesh.targetYPlus,
    spanChords: snapshot.mesh.spanChords,
    nIterations: snapshot.solver.nIterations,
    convergenceTolerance: snapshot.solver.convergenceTolerance,
    momentumScheme: snapshot.solver.momentumScheme,
    transientCycles: snapshot.solver.transientCycles,
    transientDiscardFraction: snapshot.solver.transientDiscardFraction,
    transientMaxCourant: snapshot.solver.transientMaxCourant,
    writeImages: snapshot.output.writeImages,
    imageZoomChords: snapshot.output.imageZoomChords,
    schedulingPolicy: snapshot.scheduling.schedulingPolicy,
    cpuBudget: snapshot.scheduling.cpuBudget,
    caseConcurrency: snapshot.scheduling.caseConcurrency,
    solverProcesses: snapshot.scheduling.solverProcesses,
    aoaStart: snapshot.sweep.aoaStart,
    aoaStop: snapshot.sweep.aoaStop,
    aoaStep: snapshot.sweep.aoaStep,
    aoaList: snapshot.sweep.aoaList,
    enabled: snapshot.preset.enabled,
  };
}

async function syncLegacyBoundaryConditionForPreset(presetId: string): Promise<string | null> {
  const snapshot = await resolveSimulationPresetSnapshot(db, presetId);
  if (!snapshot) return null;
  const values = legacyBoundaryValuesFromSnapshot(snapshot);
  if (snapshot.preset.legacyBoundaryConditionId) {
    await db
      .update(boundaryConditions)
      .set(values)
      .where(eq(boundaryConditions.id, snapshot.preset.legacyBoundaryConditionId));
    return snapshot.preset.legacyBoundaryConditionId;
  }
  const slug = await uniqueBoundarySlug(slugifyGeneric(snapshot.preset.slug || snapshot.preset.name));
  const [legacy] = await db.insert(boundaryConditions).values({ ...values, slug }).returning({ id: boundaryConditions.id });
  await db.update(simulationPresets).set({ legacyBoundaryConditionId: legacy.id }).where(eq(simulationPresets.id, presetId));
  return legacy.id;
}

async function refreshPresetRevisionsForRows(rows: { id: string }[]) {
  for (const row of rows) {
    await syncLegacyBoundaryConditionForPreset(row.id);
    await ensureSimulationPresetRevision(db, row.id);
  }
}

async function refreshPresetsByFlowConditionId(id: string) {
  const rows = await db.select({ id: simulationPresets.id }).from(simulationPresets).where(eq(simulationPresets.flowConditionId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsByReferenceGeometryProfileId(id: string) {
  const rows = await db.select({ id: simulationPresets.id }).from(simulationPresets).where(eq(simulationPresets.referenceGeometryProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsByBoundaryProfileId(id: string) {
  const rows = await db.select({ id: simulationPresets.id }).from(simulationPresets).where(eq(simulationPresets.boundaryProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsByMeshProfileId(id: string) {
  const rows = await db.select({ id: simulationPresets.id }).from(simulationPresets).where(eq(simulationPresets.meshProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsBySolverProfileId(id: string) {
  const rows = await db.select({ id: simulationPresets.id }).from(simulationPresets).where(eq(simulationPresets.solverProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsBySchedulingProfileId(id: string) {
  const rows = await db.select({ id: simulationPresets.id }).from(simulationPresets).where(eq(simulationPresets.schedulingProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsByOutputProfileId(id: string) {
  const rows = await db.select({ id: simulationPresets.id }).from(simulationPresets).where(eq(simulationPresets.outputProfileId, id));
  await refreshPresetRevisionsForRows(rows);
}

async function refreshPresetsBySweepDefinitionId(id: string) {
  const rows = await db.select({ id: simulationPresets.id }).from(simulationPresets).where(eq(simulationPresets.sweepDefinitionId, id));
  await refreshPresetRevisionsForRows(rows);
}

function normalizeTargetAirfoilIds(ids: string[] | undefined): string[] {
  return Array.from(new Set(ids ?? []));
}

async function validatePresetTargetAirfoils(ids: string[]): Promise<string | null> {
  if (ids.length === 0) return "select at least one profile";
  const rows = await db
    .select({ id: airfoils.id })
    .from(airfoils)
    .where(and(inArray(airfoils.id, ids), isNull(airfoils.archivedAt), isNull(airfoils.deletedAt)));
  if (rows.length !== ids.length) return "one or more selected profiles are unavailable";
  return null;
}

async function replacePresetTargets(presetId: string, targetScope: "all" | "airfoils", targetAirfoilIds: string[]) {
  await db.delete(simulationPresetAirfoilTargets).where(eq(simulationPresetAirfoilTargets.presetId, presetId));
  if (targetScope !== "airfoils") return;
  const values = targetAirfoilIds.map((airfoilId) => ({ presetId, airfoilId }));
  if (values.length) await db.insert(simulationPresetAirfoilTargets).values(values).onConflictDoNothing();
}

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  // ---- auth ----
  app.get("/api/admin/me", async (req) => {
    const mode = authMode();
    const providers = adminAuthProviders();
    const google = { enabled: providers.google, allowedDomain: googleAllowedDomain(), loginUrl: "/api/admin/oauth/google?returnTo=/admin" };
    if (mode === "dev") return { authed: true, mode, email: null, provider: null, providers, google };
    const s = verifySession((req as { cookies?: Record<string, string> }).cookies?.[COOKIE_NAME]);
    return { authed: !!s, mode, email: s?.email ?? null, provider: s?.provider ?? null, providers, google };
  });

  app.post("/api/admin/login", async (req, reply) => {
    const { email, password } = z.object({ email: z.string(), password: z.string() }).parse(req.body);
    if (!checkCredentials(email, password)) return reply.code(401).send({ error: "invalid email or password" });
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
    if (!googleOAuthConfigured()) return reply.code(503).send({ error: "Google OAuth is not configured" });
    const query = z.object({ returnTo: z.string().optional() }).parse(req.query);
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
    const verifiedState = verifyOAuthState(query.state, (req as { cookies?: Record<string, string> }).cookies?.[GOOGLE_STATE_COOKIE_NAME]);
    reply.clearCookie(GOOGLE_STATE_COOKIE_NAME, { path: "/api/admin/oauth/google/callback" });
    if (query.error) return reply.redirect(`/admin?auth=google-denied`, 303);
    if (!query.code || !verifiedState) return reply.code(400).send({ error: "invalid Google OAuth state" });
    try {
      const session = await googleSessionFromCode(req, query.code);
      reply.setCookie(COOKIE_NAME, signSession(session.email, 86_400_000, "google", session.domain), {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 86_400,
      });
      return reply.redirect(verifiedState.returnTo, 303);
    } catch (error) {
      app.log.warn({ err: error }, "Google admin OAuth failed");
      return reply.code(401).send({ error: error instanceof Error ? error.message : "Google OAuth failed" });
    }
  });

  app.post("/api/admin/logout", async (_req, reply) => {
    reply.clearCookie(COOKIE_NAME, { path: "/" });
    return { ok: true };
  });

  // ---- mediums + setup state (protected writes) ----
  app.get("/api/admin/mediums", { preHandler: requireAdmin }, async () => {
    const rows = await db.select().from(mediums).orderBy(asc(mediums.name));
    const points = await tablePointsForMediums(rows.map((row) => row.id));
    return { items: rows.map((row) => toMediumDTO(row, points.get(row.id) ?? [])) };
  });

  app.post("/api/admin/mediums", { preHandler: requireAdmin }, async (req, reply) => {
    const b = mediumBody.parse(req.body);
    const slug = b.slug ? slugifyGeneric(b.slug) : await uniqueMediumSlug(slugifyGeneric(b.name));
    const [exists] = await db.select({ id: mediums.id }).from(mediums).where(eq(mediums.slug, slug)).limit(1);
    if (exists) return reply.code(409).send({ error: "medium slug already exists" });
    const { dynamicViscosity, kinematicViscosity } = resolveViscosity(b, b.density, b.refTemperatureK);
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
    await saveMediumTableRows(row.id, b.viscosityModel === "table" ? b.viscosityTable ?? [] : []);
    return reply.code(201).send(toMediumDTO(row, b.viscosityTable ?? []));
  });

  app.patch("/api/admin/mediums/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = mediumPatchBody.parse(req.body);
    const [existing] = await db.select().from(mediums).where(eq(mediums.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: "medium not found" });
    const existingPoints = await tablePointsForMediums([id]);
    const existingInput = mediumViscosityInputFromMedium(existing, existingPoints.get(id) ?? []);
    const density = b.density ?? existing.density;
    const refT = b.refTemperatureK ?? existing.refTemperatureK;
    const viscosityInput = {
      ...existingInput,
      ...b,
      viscosityModel: b.viscosityModel ?? existingInput.viscosityModel,
      viscosityTable: b.viscosityTable ?? existingInput.viscosityTable,
    };
    const { dynamicViscosity, kinematicViscosity } = resolveViscosity(viscosityInput, density, refT);
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
        speedOfSound: Object.prototype.hasOwnProperty.call(b, "speedOfSound") ? b.speedOfSound ?? null : undefined,
        notes: Object.prototype.hasOwnProperty.call(b, "notes") ? b.notes ?? null : undefined,
      })
      .where(eq(mediums.id, id))
      .returning();
    await saveMediumTableRows(row.id, viscosityInput.viscosityModel === "table" ? viscosityInput.viscosityTable ?? [] : []);
    await refreshFlowConditionsForMedium(id);
    return toMediumDTO(row, viscosityInput.viscosityTable ?? []);
  });

  // ---- simulation setup profiles (protected writes) ----
  app.get("/api/admin/simulation-setup", { preHandler: requireAdmin }, async () => {
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
  });

  app.post("/api/admin/flow-conditions", { preHandler: requireAdmin }, async (req, reply) => {
    const b = flowConditionBody.parse(req.body);
    const [medium] = await db.select().from(mediums).where(eq(mediums.id, b.mediumId)).limit(1);
    if (!medium) return reply.code(404).send({ error: "medium not found" });
    const slug = b.slug ? slugifyGeneric(b.slug) : await uniqueSetupSlug("flow_conditions", slugifyGeneric(b.name));
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
    return reply.code(201).send({ ...row, mediumSlug: medium.slug, mediumName: medium.name, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
  });

  app.patch("/api/admin/flow-conditions/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = flowConditionBody.partial().parse(req.body);
    const [existing] = await db.select().from(flowConditions).where(eq(flowConditions.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: "flow condition not found" });
    const [medium] = await db.select().from(mediums).where(eq(mediums.id, b.mediumId ?? existing.mediumId)).limit(1);
    if (!medium) return reply.code(404).send({ error: "medium not found" });
    const merged = { ...existing, ...b };
    const points = await tablePointsForMediums([medium.id]);
    const derived = deriveFlowState(medium, merged, points.get(medium.id) ?? []);
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
    return { ...row, mediumSlug: medium.slug, mediumName: medium.name, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  });

  app.post("/api/admin/reference-geometry-profiles", { preHandler: requireAdmin }, async (req, reply) => {
    const b = referenceGeometryProfileBody.parse(req.body);
    const slug = b.slug ? slugifyGeneric(b.slug) : await uniqueSetupSlug("reference_geometry_profiles", slugifyGeneric(b.name));
    const [row] = await db
      .insert(referenceGeometryProfiles)
      .values({
        ...b,
        slug,
        spanM: b.spanM ?? null,
        referenceAreaM2: b.referenceAreaM2 ?? null,
      })
      .returning();
    return reply.code(201).send({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
  });

  app.patch("/api/admin/reference-geometry-profiles/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = referenceGeometryProfileBody.partial().parse(req.body);
    const [row] = await db
      .update(referenceGeometryProfiles)
      .set({
        name: b.name,
        geometryType: b.geometryType,
        referenceLengthKind: b.referenceLengthKind,
        referenceLengthM: b.referenceLengthM,
        spanM: Object.prototype.hasOwnProperty.call(b, "spanM") ? b.spanM ?? null : undefined,
        referenceAreaM2: Object.prototype.hasOwnProperty.call(b, "referenceAreaM2") ? b.referenceAreaM2 ?? null : undefined,
      })
      .where(eq(referenceGeometryProfiles.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: "reference geometry profile not found" });
    await refreshPresetsByReferenceGeometryProfileId(id);
    return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  });

  app.post("/api/admin/boundary-profiles", { preHandler: requireAdmin }, async (req, reply) => {
    const b = boundaryProfileBody.parse(req.body);
    const slug = b.slug ? slugifyGeneric(b.slug) : await uniqueSetupSlug("boundary_profiles", slugifyGeneric(b.name));
    const [row] = await db.insert(boundaryProfiles).values({ ...b, slug }).returning();
    return reply.code(201).send({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
  });

  app.patch("/api/admin/boundary-profiles/:id", { preHandler: requireAdmin }, async (req, reply) => {
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
    if (!row) return reply.code(404).send({ error: "boundary profile not found" });
    await refreshPresetsByBoundaryProfileId(id);
    return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  });

  app.post("/api/admin/mesh-profiles", { preHandler: requireAdmin }, async (req, reply) => {
    const b = meshProfileBody.parse(req.body);
    const slug = b.slug ? slugifyGeneric(b.slug) : await uniqueSetupSlug("mesh_profiles", slugifyGeneric(b.name));
    const [row] = await db.insert(meshProfiles).values({ ...b, slug }).returning();
    return reply.code(201).send({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
  });

  app.patch("/api/admin/mesh-profiles/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = meshProfileBody.partial().parse(req.body);
    const [row] = await db.update(meshProfiles).set(b).where(eq(meshProfiles.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "mesh profile not found" });
    await refreshPresetsByMeshProfileId(id);
    return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  });

  app.post("/api/admin/solver-profiles", { preHandler: requireAdmin }, async (req, reply) => {
    const b = solverProfileBody.parse(req.body);
    const slug = b.slug ? slugifyGeneric(b.slug) : await uniqueSetupSlug("solver_profiles", slugifyGeneric(b.name));
    const [row] = await db.insert(solverProfiles).values({ ...b, slug }).returning();
    return reply.code(201).send({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
  });

  app.patch("/api/admin/solver-profiles/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = solverProfileBody.partial().parse(req.body);
    const [row] = await db.update(solverProfiles).set(b).where(eq(solverProfiles.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "solver profile not found" });
    await refreshPresetsBySolverProfileId(id);
    return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  });

  app.post("/api/admin/scheduling-profiles", { preHandler: requireAdmin }, async (req, reply) => {
    const b = schedulingProfileBody.parse(req.body);
    const slug = b.slug ? slugifyGeneric(b.slug) : await uniqueSetupSlug("scheduling_profiles", slugifyGeneric(b.name));
    const [row] = await db.insert(schedulingProfiles).values({ ...b, slug }).returning();
    return reply.code(201).send({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
  });

  app.patch("/api/admin/scheduling-profiles/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = schedulingProfileBody.partial().parse(req.body);
    const [row] = await db
      .update(schedulingProfiles)
      .set({
        name: b.name,
        schedulingPolicy: b.schedulingPolicy,
        cpuBudget: Object.prototype.hasOwnProperty.call(b, "cpuBudget") ? b.cpuBudget ?? null : undefined,
        caseConcurrency: Object.prototype.hasOwnProperty.call(b, "caseConcurrency") ? b.caseConcurrency ?? null : undefined,
        solverProcesses: Object.prototype.hasOwnProperty.call(b, "solverProcesses") ? b.solverProcesses ?? null : undefined,
      })
      .where(eq(schedulingProfiles.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: "scheduling profile not found" });
    await refreshPresetsBySchedulingProfileId(id);
    return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  });

  app.post("/api/admin/output-profiles", { preHandler: requireAdmin }, async (req, reply) => {
    const b = outputProfileBody.parse(req.body);
    const slug = b.slug ? slugifyGeneric(b.slug) : await uniqueSetupSlug("output_profiles", slugifyGeneric(b.name));
    const [row] = await db.insert(outputProfiles).values({ ...b, slug }).returning();
    return reply.code(201).send({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
  });

  app.patch("/api/admin/output-profiles/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = outputProfileBody.partial().parse(req.body);
    const [row] = await db.update(outputProfiles).set(b).where(eq(outputProfiles.id, id)).returning();
    if (!row) return reply.code(404).send({ error: "output profile not found" });
    await refreshPresetsByOutputProfileId(id);
    return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  });

  app.post("/api/admin/sweep-definitions", { preHandler: requireAdmin }, async (req, reply) => {
    const b = sweepDefinitionBody.parse(req.body);
    const slug = b.slug ? slugifyGeneric(b.slug) : await uniqueSetupSlug("sweep_definitions", slugifyGeneric(b.name));
    const [row] = await db.insert(sweepDefinitions).values({ ...b, slug, aoaList: b.aoaList ?? null }).returning();
    return reply.code(201).send({ ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) });
  });

  app.patch("/api/admin/sweep-definitions/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = sweepDefinitionBody.partial().parse(req.body);
    const [row] = await db
      .update(sweepDefinitions)
      .set({
        name: b.name,
        aoaStart: b.aoaStart,
        aoaStop: b.aoaStop,
        aoaStep: b.aoaStep,
        aoaList: Object.prototype.hasOwnProperty.call(b, "aoaList") ? b.aoaList ?? null : undefined,
      })
      .where(eq(sweepDefinitions.id, id))
      .returning();
    if (!row) return reply.code(404).send({ error: "sweep definition not found" });
    await refreshPresetsBySweepDefinitionId(id);
    return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
  });

  app.post("/api/admin/simulation-presets", { preHandler: requireAdmin }, async (req, reply) => {
    const b = simulationPresetBody.parse(req.body);
    const targetAirfoilIds = normalizeTargetAirfoilIds(b.targetAirfoilIds);
    if (b.targetScope === "airfoils") {
      const error = await validatePresetTargetAirfoils(targetAirfoilIds);
      if (error) return reply.code(422).send({ error });
    }
    const slug = b.slug ? slugifyGeneric(b.slug) : await uniqueSetupSlug("simulation_presets", slugifyGeneric(b.name));
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
    return reply.code(201).send(rows.simulationPresets.find((preset) => preset.id === row.id));
  });

  app.patch("/api/admin/simulation-presets/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = simulationPresetBody.partial().parse(req.body);
    const [existing] = await db.select().from(simulationPresets).where(eq(simulationPresets.id, id)).limit(1);
    if (!existing) return reply.code(404).send({ error: "simulation preset not found" });
    const existingTargetRows = await db
      .select({ airfoilId: simulationPresetAirfoilTargets.airfoilId })
      .from(simulationPresetAirfoilTargets)
      .where(eq(simulationPresetAirfoilTargets.presetId, id));
    const targetScope = b.targetScope ?? existing.targetScope;
    const targetAirfoilIds = Object.prototype.hasOwnProperty.call(b, "targetAirfoilIds")
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
    if (!row) return reply.code(404).send({ error: "simulation preset not found" });
    if (Object.prototype.hasOwnProperty.call(b, "targetScope") || Object.prototype.hasOwnProperty.call(b, "targetAirfoilIds")) {
      await replacePresetTargets(row.id, targetScope, targetAirfoilIds);
    }
    await syncLegacyBoundaryConditionForPreset(row.id);
    await ensureSimulationPresetRevision(db, row.id);
    const rows = await rowsForSimulationSetup();
    return rows.simulationPresets.find((preset) => preset.id === row.id);
  });

  app.get("/api/admin/boundary-conditions", { preHandler: requireAdmin }, async () => ({ items: await rowsForBoundaryConditions() }));

  app.post("/api/admin/boundary-conditions", { preHandler: requireAdmin }, async (req, reply) => {
    const b = bcBody.parse(req.body);
    const [medium] = await db.select().from(mediums).where(eq(mediums.id, b.mediumId)).limit(1);
    if (!medium) return reply.code(404).send({ error: "medium not found" });
    const presetSlug = b.slug ? slugifyGeneric(b.slug) : await uniqueSetupSlug("simulation_presets", slugifyGeneric(b.name));
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
        slug: await uniqueSetupSlug("reference_geometry_profiles", `${base}-reference-geometry`),
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
        slug: await uniqueSetupSlug("scheduling_profiles", `${base}-scheduling`),
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
    return reply.code(201).send((await rowsForBoundaryConditions()).find((item) => item.id === preset.id));
  });

  app.patch("/api/admin/boundary-conditions/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = bcBody.partial().parse(req.body);
    const [preset] = await db
      .select()
      .from(simulationPresets)
      .where(or(eq(simulationPresets.id, id), eq(simulationPresets.legacyBoundaryConditionId, id)))
      .limit(1);
    if (!preset) return reply.code(404).send({ error: "simulation preset not found" });
    const [existingFlow] = await db.select().from(flowConditions).where(eq(flowConditions.id, preset.flowConditionId)).limit(1);
    if (!existingFlow) return reply.code(404).send({ error: "flow condition not found" });
    const [existingReferenceGeometry] = await db
      .select()
      .from(referenceGeometryProfiles)
      .where(eq(referenceGeometryProfiles.id, preset.referenceGeometryProfileId))
      .limit(1);
    if (!existingReferenceGeometry) return reply.code(404).send({ error: "reference geometry profile not found" });
    const [medium] = await db.select().from(mediums).where(eq(mediums.id, b.mediumId ?? existingFlow.mediumId)).limit(1);
    if (!medium) return reply.code(404).send({ error: "medium not found" });
    const merged = { ...existingFlow, ...b, referenceChordM: b.referenceChordM ?? existingReferenceGeometry.referenceLengthM };
    const points = await tablePointsForMediums([medium.id]);
    const derived = deriveBcState(medium, merged, points.get(medium.id) ?? []);
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
      .where(eq(referenceGeometryProfiles.id, preset.referenceGeometryProfileId));
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
        cpuBudget: Object.prototype.hasOwnProperty.call(b, "cpuBudget") ? b.cpuBudget ?? null : undefined,
        caseConcurrency: Object.prototype.hasOwnProperty.call(b, "caseConcurrency") ? b.caseConcurrency ?? null : undefined,
        solverProcesses: Object.prototype.hasOwnProperty.call(b, "solverProcesses") ? b.solverProcesses ?? null : undefined,
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
        aoaList: Object.prototype.hasOwnProperty.call(b, "aoaList") ? b.aoaList ?? null : undefined,
      })
      .where(eq(sweepDefinitions.id, preset.sweepDefinitionId));
    await db
      .update(simulationPresets)
      .set({ name: b.name, enabled: b.enabled })
      .where(eq(simulationPresets.id, preset.id));
    await syncLegacyBoundaryConditionForPreset(preset.id);
    await ensureSimulationPresetRevision(db, preset.id);
    return (await rowsForBoundaryConditions()).find((item) => item.id === preset.id);
  });

  // ---- category management (protected) ----
  app.get("/api/admin/categories/tree", { preHandler: requireAdmin }, async () => categoriesTree());

  app.post("/api/admin/categories", { preHandler: requireAdmin }, async (req, reply) => {
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
  });

  app.patch("/api/admin/categories/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = z
      .object({
        name: z.string().trim().min(1).optional(),
        parentId: z.string().uuid().nullable().optional(),
        description: z.string().nullable().optional(),
        sortOrder: z.number().int().optional(),
      })
      .parse(req.body);
    const [current] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
    if (!current) return reply.code(404).send({ error: "category not found" });
    try {
      if (Object.prototype.hasOwnProperty.call(b, "parentId") && b.parentId !== current.parentId) {
        await moveCategorySubtree(current, b.parentId);
      }
      const [row] = await db
        .update(categories)
        .set({
          name: b.name,
          description: Object.prototype.hasOwnProperty.call(b, "description") ? b.description ?? null : undefined,
          sortOrder: b.sortOrder,
        })
        .where(eq(categories.id, id))
        .returning();
      return row;
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  });

  app.post("/api/admin/categories/reorder", { preHandler: requireAdmin }, async (req, reply) => {
    const b = z
      .object({
        draggedId: z.string().uuid(),
        targetId: z.string().uuid(),
        position: z.enum(["before", "inside", "after"]),
      })
      .parse(req.body);
    if (b.draggedId === b.targetId) return reply.code(422).send({ error: "category cannot be dropped on itself" });
    const [dragged] = await db.select().from(categories).where(eq(categories.id, b.draggedId)).limit(1);
    const [target] = await db.select().from(categories).where(eq(categories.id, b.targetId)).limit(1);
    if (!dragged || !target) return reply.code(404).send({ error: "category not found" });
    if (target.path.startsWith(dragged.path + "/")) {
      return reply.code(422).send({ error: "category cannot be moved into its own descendant" });
    }

    try {
      const nextParentId = b.position === "inside" ? target.id : target.parentId;
      if (nextParentId !== dragged.parentId) await moveCategorySubtree(dragged, nextParentId);

      const siblings = await db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(nextParentId ? eq(categories.parentId, nextParentId) : isNull(categories.parentId))
        .orderBy(asc(categories.sortOrder), asc(categories.name));
      const ordered = siblings.filter((s) => s.id !== dragged.id);
      const insertAt =
        b.position === "inside"
          ? ordered.length
          : Math.max(
              0,
              ordered.findIndex((s) => s.id === target.id) + (b.position === "after" ? 1 : 0),
            );
      ordered.splice(insertAt, 0, { id: dragged.id, name: dragged.name });
      for (let i = 0; i < ordered.length; i++) {
        await db.update(categories).set({ sortOrder: (i + 1) * 10 }).where(eq(categories.id, ordered[i].id));
      }
      return categoriesTree();
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  });

  app.delete("/api/admin/categories/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [cat] = await db.select().from(categories).where(eq(categories.id, id)).limit(1);
    if (!cat) return reply.code(404).send({ error: "category not found" });
    const [childCount] = await db.select({ n: count() }).from(categories).where(eq(categories.parentId, id));
    if ((childCount?.n ?? 0) > 0) return reply.code(409).send({ error: "category has subcategories" });
    const [airfoilCount] = await db
      .select({ n: count() })
      .from(airfoils)
      .where(and(eq(airfoils.categoryId, id), isNull(airfoils.deletedAt)));
    if ((airfoilCount?.n ?? 0) > 0) return reply.code(409).send({ error: "category has airfoils" });
    await db.delete(categories).where(eq(categories.id, id));
    return reply.code(204).send();
  });

  // ---- hashtag management (protected) ----
  app.get("/api/admin/hashtags", { preHandler: requireAdmin }, async () => ({ items: await listHashtags() }));

  app.post("/api/admin/hashtags", { preHandler: requireAdmin }, async (req, reply) => {
    const { name } = z.object({ name: z.string().trim().min(1) }).parse(req.body);
    const slug = slugifyHashtag(name);
    const [exists] = await db.select({ id: hashtags.id }).from(hashtags).where(eq(hashtags.slug, slug)).limit(1);
    if (exists) return reply.code(409).send({ error: "hashtag already exists" });
    const [row] = await db.insert(hashtags).values({ slug, name }).returning({ id: hashtags.id, slug: hashtags.slug, name: hashtags.name });
    return reply.code(201).send(toHashtagDTO(row));
  });

  app.patch("/api/admin/hashtags/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { name } = z.object({ name: z.string().trim().min(1) }).parse(req.body);
    const slug = slugifyHashtag(name);
    const [dupe] = await db.select({ id: hashtags.id }).from(hashtags).where(eq(hashtags.slug, slug)).limit(1);
    if (dupe && dupe.id !== id) return reply.code(409).send({ error: "hashtag already exists" });
    const [row] = await db
      .update(hashtags)
      .set({ slug, name })
      .where(eq(hashtags.id, id))
      .returning({ id: hashtags.id, slug: hashtags.slug, name: hashtags.name });
    if (!row) return reply.code(404).send({ error: "hashtag not found" });
    return toHashtagDTO(row);
  });

  app.delete("/api/admin/hashtags/:id", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const affected = await db.select({ airfoilId: airfoilHashtags.airfoilId }).from(airfoilHashtags).where(eq(airfoilHashtags.hashtagId, id));
    await db.delete(hashtags).where(eq(hashtags.id, id));
    await syncLegacyTagsForAirfoils([...new Set(affected.map((r) => r.airfoilId))]);
    return reply.code(204).send();
  });

  // ---- airfoil bulk operations (protected) ----
  app.post("/api/admin/airfoils/bulk", { preHandler: requireAdmin }, async (req, reply) => {
    const b = z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(1000),
        action: z.enum(["move", "archive", "remove", "restore", "assignHashtags", "removeHashtags"]),
        categoryId: z.string().uuid().optional(),
        hashtagIds: z.array(z.string().uuid()).optional().default([]),
      })
      .parse(req.body);
    const ids = [...new Set(b.ids)];
    if (b.action === "move") {
      if (!b.categoryId) return reply.code(422).send({ error: "categoryId is required" });
      const [cat] = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, b.categoryId)).limit(1);
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
    if (b.hashtagIds.length === 0) return reply.code(422).send({ error: "hashtagIds are required" });
    const existingTags = await db.select({ id: hashtags.id }).from(hashtags).where(inArray(hashtags.id, b.hashtagIds));
    if (existingTags.length !== b.hashtagIds.length) return reply.code(404).send({ error: "one or more hashtags were not found" });
    if (b.action === "assignHashtags") {
      for (const airfoilId of ids) {
        for (const hashtagId of b.hashtagIds) {
          await db.insert(airfoilHashtags).values({ airfoilId, hashtagId }).onConflictDoNothing();
        }
      }
    } else {
      await db
        .delete(airfoilHashtags)
        .where(and(inArray(airfoilHashtags.airfoilId, ids), inArray(airfoilHashtags.hashtagId, b.hashtagIds)));
    }
    await syncLegacyTagsForAirfoils(ids);
    return { ok: true, updated: ids.length };
  });

  // ---- queue (protected) ----
  app.get("/api/admin/queue", { preHandler: requireAdmin }, async () => {
    await ensureQueueRevisionsFresh();
    const [s] = await db.select().from(sweeperState).where(eq(sweeperState.id, 1)).limit(1);

    // Pending work = (airfoil × enabled setup revision × AoA) gaps. Keep counts and the
    // visible list in one scan so the queue page does not recompute the same gap set.
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
    const pendingSweepsTotal = Number(pendingSweepRows[0]?.pending_sweeps_total ?? 0);
    const backlog = Number(pendingSweepRows[0]?.pending_points_total ?? 0);
    const pendingSweeps = pendingSweepRows.map((r) => ({
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
      caseConcurrency: r.case_concurrency == null ? null : Number(r.case_concurrency),
      solverProcesses: r.solver_processes == null ? null : Number(r.solver_processes),
      aoaCount: Number(r.aoa_count),
      aoaMin: Number(r.aoa_min),
      aoaMax: Number(r.aoa_max),
      aoas: (r.aoas ?? []).map(Number),
      status: r.status,
      priority: Number(r.priority ?? 0),
      kind: r.kind,
      requestedAt: iso(r.requested_at),
    }));

    const externalPromises = (await db.execute(sql`
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
    }[];

    const statusRows = (await db.execute(
      sql`SELECT status, count(*)::int AS n FROM results GROUP BY status`,
    )) as unknown as { status: string; n: number }[];
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = Number(r.n);
    const [solved] = await db.select({ n: count() }).from(results).where(and(eq(results.source, "solved"), eq(results.status, "done")));

    const [jobsRaw, activeJobsRaw, finishedJobsRaw] = await Promise.all([queueJobs("recent", 50), queueJobs("active", 40), queueJobs("finished", 80)]);
    const engine = new EngineClient(env.engineUrl);
    const [{ queue: engineQueue, error: engineQueueError }, { health: engineHealth, error: engineHealthError }] = await Promise.all([
      getCachedEngineQueue(engine),
      getCachedEngineHealth(engine),
    ]);
    const runtimeByEngineJobId = await engineRuntimeMap(
      engine,
      [...jobsRaw, ...activeJobsRaw, ...finishedJobsRaw].map((job) => job.engineJobId).filter((id): id is string => Boolean(id)),
    );
    const annotateJob = <T extends ReturnType<typeof toQueueJob>>(job: T) => ({
      ...job,
      ...(() => {
        const runtime = job.engineJobId ? runtimeByEngineJobId.get(job.engineJobId) : null;
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
        const activeSolver = runtime?.status_active_solver ?? runtime?.runtime_active_solver ?? null;
        const activeCaseSlug = runtime?.status_active_case_slug ?? runtime?.runtime_active_case_slug ?? null;
        const activeAoaDeg = runtime?.status_active_aoa_deg ?? runtime?.runtime_active_aoa_deg ?? null;
        const cpuTokensWaiting = runtime?.status_cpu_tokens_waiting ?? runtime?.runtime_cpu_tokens_waiting ?? null;
        const cpuTokensHeld = runtime?.status_cpu_tokens_held ?? runtime?.runtime_cpu_tokens_held ?? null;
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
          lastProgressAt: runtime?.runtime_last_progress_at ?? runtime?.status_last_progress_at ?? null,
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
    const jobs = jobsRaw.map(annotateJob);
    const activeJobs = activeJobsRaw.map(annotateJob);
    const finishedJobs = finishedJobsRaw.map(annotateJob);
    const inFlight = activeJobs.filter((j) => ["submitted", "running", "ingesting"].includes(j.status)).length;

    return {
      mode: authMode(),
      engineUrl: env.engineUrl,
      sweeper: s ?? { id: 1, enabled: false, maxConcurrentJobs: 2, pollIntervalMs: 5000, submitIntervalMs: 15000, heartbeatAt: null },
      backlog,
      inFlight,
      results: { ...byStatus, solved: solved?.n ?? 0 },
      pendingPointsTotal: backlog,
      pendingSweepsTotal,
      pendingSweeps,
      externalPromises: externalPromises.map((row) => ({
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
      })),
      engineQueue,
      engineQueueError,
      engineHealth,
      engineHealthError,
      engineExpectedBuildId: env.engineExpectedBuildId,
      engineBuildId: engineHealth?.build_id ?? null,
      engineBuildMismatch: Boolean(env.engineExpectedBuildId && engineHealth?.build_id && engineHealth.build_id !== env.engineExpectedBuildId),
      activeJobs,
      finishedJobs,
      jobs,
    };
  });

  app.patch("/api/admin/sweeper", { preHandler: requireAdmin }, async (req) => {
    const b = z
      .object({
        enabled: z.boolean().optional(),
        maxConcurrentJobs: z.number().int().positive().max(64).optional(),
        pollIntervalMs: z.number().int().min(1000).optional(),
        submitIntervalMs: z.number().int().min(1000).optional(),
      })
      .parse(req.body);
    const [s] = await db.insert(sweeperState).values({ id: 1, ...b }).onConflictDoUpdate({ target: sweeperState.id, set: b }).returning();
    return s;
  });

  app.post("/api/admin/results/requeue-failed", { preHandler: requireAdmin }, async () => {
    const rows = await db
      .update(results)
      .set({ status: "pending", simJobId: null })
      .where(eq(results.status, "failed"))
      .returning({ id: results.id });
    return { requeued: rows.length };
  });

  app.post("/api/admin/test-artifacts/purge", { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = z.object({ prefix: z.string().min(3), dryRun: z.boolean().default(false) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const { prefix, dryRun } = parsed.data;
    if (!prefix.startsWith("pw-")) return reply.code(422).send({ error: "only pw- test artifact prefixes can be purged" });
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
        (SELECT count(*)::int FROM hashtags WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix}) AS hashtags
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
    }[];
    if (dryRun) return { dryRun: true, purged: counts ?? { airfoils: 0, categories: 0, boundary_conditions: 0, mediums: 0, hashtags: 0 } };
    await db.delete(airfoils).where(or(like(airfoils.slug, likePrefix), like(airfoils.name, likePrefix)));
    await db.execute(sql`
      DELETE FROM sim_jobs j
      WHERE EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(j.bc_ids) AS bc(id)
        JOIN boundary_conditions b ON b.id::text = bc.id
        WHERE b.slug LIKE ${likePrefix} OR b.name ILIKE ${likePrefix}
      )
    `);
	    await db.delete(simulationPresets).where(or(like(simulationPresets.slug, likePrefix), like(simulationPresets.name, likePrefix)));
	    await db.delete(boundaryConditions).where(or(like(boundaryConditions.slug, likePrefix), like(boundaryConditions.name, likePrefix)));
	    await db.delete(flowConditions).where(or(like(flowConditions.slug, likePrefix), like(flowConditions.name, likePrefix)));
	    await db.delete(referenceGeometryProfiles).where(or(like(referenceGeometryProfiles.slug, likePrefix), like(referenceGeometryProfiles.name, likePrefix)));
	    await db.delete(operatingConditions).where(or(like(operatingConditions.slug, likePrefix), like(operatingConditions.name, likePrefix)));
    await db.delete(boundaryProfiles).where(or(like(boundaryProfiles.slug, likePrefix), like(boundaryProfiles.name, likePrefix)));
    await db.delete(meshProfiles).where(or(like(meshProfiles.slug, likePrefix), like(meshProfiles.name, likePrefix)));
    await db.delete(solverProfiles).where(or(like(solverProfiles.slug, likePrefix), like(solverProfiles.name, likePrefix)));
    await db.delete(schedulingProfiles).where(or(like(schedulingProfiles.slug, likePrefix), like(schedulingProfiles.name, likePrefix)));
    await db.delete(outputProfiles).where(or(like(outputProfiles.slug, likePrefix), like(outputProfiles.name, likePrefix)));
    await db.delete(sweepDefinitions).where(or(like(sweepDefinitions.slug, likePrefix), like(sweepDefinitions.name, likePrefix)));
    await db.execute(sql`
      UPDATE categories
      SET parent_id = NULL
      WHERE slug LIKE ${likePrefix} OR name ILIKE ${likePrefix} OR path ILIKE ${likePrefix}
    `);
    await db.delete(categories).where(or(like(categories.slug, likePrefix), like(categories.name, likePrefix), like(categories.path, likePrefix)));
    await db.delete(hashtags).where(or(like(hashtags.slug, likePrefix), like(hashtags.name, likePrefix)));
    await db.execute(sql`
      DELETE FROM mediums m
      WHERE (m.slug LIKE ${likePrefix} OR m.name ILIKE ${likePrefix})
        AND NOT EXISTS (SELECT 1 FROM boundary_conditions b WHERE b.medium_id = m.id)
        AND NOT EXISTS (SELECT 1 FROM operating_conditions oc WHERE oc.medium_id = m.id)
    `);
    return { purged: counts ?? { airfoils: 0, categories: 0, boundary_conditions: 0, mediums: 0, hashtags: 0 } };
  });

  app.post("/api/admin/jobs/recover-stale", { preHandler: requireAdmin }, async (req) => {
    const b = z
      .object({
        olderThanMinutes: z.number().int().positive().max(24 * 60).default(30),
      })
      .parse(req.body ?? {});
    const candidateRows = await db
      .select()
      .from(simJobs)
      .where(
        and(
          inArray(simJobs.status, ["submitted", "running", "ingesting"]),
          isNotNull(simJobs.engineJobId),
          sql`COALESCE(${simJobs.submittedAt}, ${simJobs.createdAt}) < now() - (${b.olderThanMinutes} || ' minutes')::interval`,
        ),
      );
    if (candidateRows.length === 0) {
      return { recovered: 0, requeuedResults: 0, requeued: 0, keptRunning: 0, markedIngesting: 0, unchanged: 0 };
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
      candidateRows.map((row) => row.engineJobId).filter((id): id is string => Boolean(id)),
    );

    let requeuedResults = 0;
    let requeued = 0;
    let keptRunning = 0;
    let markedIngesting = 0;
    let unchanged = 0;
    for (const job of candidateRows) {
      const runtime = job.engineJobId ? runtimeByEngineJobId.get(job.engineJobId) : null;
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
        await db
          .update(simJobs)
          .set({
            status: "ingesting",
            engineState: runtime?.result_state ?? "completed",
            error: classified.staleReason,
            polledAt: new Date(),
            finishedAt: null,
          })
          .where(activeSimJobWhere(job.id));
        markedIngesting++;
        continue;
      }

      if (!classified.recoverable) {
        if (classified.runtimeState === "worker_visible" || classified.runtimeState === "detached_running" || classified.processCount > 0) {
          await db
            .update(simJobs)
            .set({
              status: "running",
              engineState: runtime?.status_state ?? job.engineState ?? "running",
              totalCases: runtime?.status_total_cases ?? job.totalCases,
              completedCases: runtime?.status_completed_cases ?? job.completedCases,
              error: classified.staleReason,
              polledAt: new Date(),
              finishedAt: null,
            })
            .where(activeSimJobWhere(job.id));
          keptRunning++;
        } else {
          unchanged++;
        }
        continue;
      }

      const rows = await db
        .update(results)
        .set({ status: "pending", simJobId: null, engineJobId: null, engineCaseSlug: null })
        .where(and(eq(results.simJobId, job.id), inArray(results.status, ["queued", "running", "pending", "stale"])))
        .returning({ id: results.id });
      await db
        .update(simJobs)
        .set({
          status: "cancelled",
          engineState: "missing",
          finishedAt: new Date(),
          error: classified.staleReason ?? `stale/orphan recovery after ${b.olderThanMinutes} minutes`,
        })
        .where(activeSimJobWhere(job.id));
      requeuedResults += rows.length;
      requeued++;
    }
    return {
      recovered: requeued + markedIngesting,
      requeuedResults,
      requeued,
      keptRunning,
      markedIngesting,
      unchanged,
    };
  });

  app.post("/api/admin/jobs/:id/cancel", { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [job] = await db.select({ engineJobId: simJobs.engineJobId }).from(simJobs).where(eq(simJobs.id, id)).limit(1);
    let engineCancelError: string | null = null;
    if (job?.engineJobId) {
      try {
        await new EngineClient(env.engineUrl).cancelJob(job.engineJobId);
      } catch (e) {
        engineCancelError = (e as Error).message;
      }
    }
    await db
      .update(results)
      .set({ status: "pending", simJobId: null, engineJobId: null, engineCaseSlug: null })
      .where(and(eq(results.simJobId, id), inArray(results.status, ["queued", "running"])));
    const [s] = await db
      .update(simJobs)
      .set({
        status: "cancelled",
        engineState: "cancelled",
        finishedAt: new Date(),
        error: engineCancelError ? `cancelled by admin; engine cancel failed: ${engineCancelError}` : "cancelled by admin",
      })
      .where(eq(simJobs.id, id))
      .returning({ id: simJobs.id });
    if (!s) return reply.code(404).send({ error: "job not found" });
    return { cancelled: true, engineCancelled: Boolean(job?.engineJobId && !engineCancelError), engineCancelError };
  });
}
