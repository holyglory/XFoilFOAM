import {
  airfoilHashtags,
  airfoils,
  boundaryConditions,
  boundaryProfiles,
  categories,
  fieldColorScales,
  flowConditions,
  forceHistory,
  hashtags,
  mediumViscosityTablePoints,
  mediums,
  meshProfiles,
  outputProfiles,
  referenceGeometryProfiles,
  registeredRemoteSolvers,
  remoteAssetReferences,
  resultAttempts,
  resultFieldExtents,
  resultMedia,
  schedulingProfiles,
  results,
  simulationPresetAirfoilTargets,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  solverEvidenceArtifacts,
  syncApiPermissions,
  syncApiSettings,
  syncImportConflicts,
  syncSweepPromisePoints,
  syncSweepPromises,
  sweepDefinitions,
} from "@aerodb/db";
import { refreshPolarCacheForRevision } from "@aerodb/db/polar-cache";
import { ensureEnabledSimulationPresetRevisions, simulationSetupSignature, type SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { and, asc, count, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

import { requireAdmin } from "./admin-auth";
import { db } from "./db";
import { env } from "./env";
import { mediaStore } from "./media-store";

const SYNC_DATA_TYPES = [
  "sweeps",
  "airfoils",
  "catalog_metadata",
  "mediums",
  "simulation_setup",
  "polars",
  "evidence_artifacts",
  "result_media",
] as const;
type SyncDataType = (typeof SYNC_DATA_TYPES)[number];
type SyncDirection = "fetch" | "push";

const syncDataTypeSchema = z.enum(SYNC_DATA_TYPES);

const permissionPatchSchema = z.object({
  dataType: syncDataTypeSchema,
  canFetch: z.boolean(),
  canPush: z.boolean(),
});

const syncSettingsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  instanceName: z.string().trim().min(1).optional(),
  publicEndpointOverride: z.string().trim().nullable().optional(),
  secret: z.string().optional(),
  defaultPromiseTtlHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
  upstreamBaseUrl: z.string().trim().nullable().optional(),
  upstreamSecret: z.string().optional(),
  syncMode: z.enum(["full", "db_only_remote_assets"]).optional(),
  remoteSolverEnabled: z.boolean().optional(),
  remoteSolverCpuBudget: z.coerce.number().int().min(0).max(256).optional(),
  remoteSolverClaimSize: z.coerce.number().int().min(1).max(500).optional(),
  remoteSolverHeartbeatIntervalSeconds: z.coerce.number().int().min(5).max(3600).optional(),
  permissions: z.array(permissionPatchSchema).optional(),
});

const claimBodySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(36),
  ttlHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
  solverId: z.string().uuid().optional(),
  sourceInstanceId: z.string().trim().optional(),
  sourceInstanceName: z.string().trim().optional(),
  sourceBaseUrl: z.string().trim().optional(),
});

const heartbeatBodySchema = z.object({
  ttlHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
});

const exportQuerySchema = z.object({
  types: z.string().optional(),
  since: z.string().datetime().optional(),
  assetMode: z.enum(["full", "remote_refs"]).default("full"),
  cursor: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

const solverRegisterSchema = z.object({
  instanceId: z.string().trim().min(1),
  instanceName: z.string().trim().min(1),
  publicEndpoint: z.string().trim().nullable().optional(),
  localEndpoint: z.string().trim().nullable().optional(),
  cpuCapacity: z.coerce.number().int().min(0).max(1024).default(0),
  cpuBudget: z.coerce.number().int().min(0).max(1024).default(0),
  buildVersion: z.string().trim().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const solverHeartbeatSchema = solverRegisterSchema.partial().extend({
  status: z.enum(["disabled", "idle", "syncing", "claiming", "solving", "pushing", "error", "offline"]).default("idle"),
  activePromiseCount: z.coerce.number().int().min(0).default(0),
  activeAoaCount: z.coerce.number().int().min(0).default(0),
  solvedCount: z.coerce.number().int().min(0).optional(),
  pushedCount: z.coerce.number().int().min(0).optional(),
  recentError: z.string().nullable().optional(),
});

const solverProgressSchema = z.object({
  status: z.enum(["disabled", "idle", "syncing", "claiming", "solving", "pushing", "error", "offline"]).optional(),
  activePromiseCount: z.coerce.number().int().min(0).optional(),
  activeAoaCount: z.coerce.number().int().min(0).optional(),
  solvedCountDelta: z.coerce.number().int().min(0).default(0),
  pushedCountDelta: z.coerce.number().int().min(0).default(0),
  recentError: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const upstreamSyncBodySchema = z.object({
  mode: z.enum(["full", "db_only_remote_assets"]).optional(),
  types: z.array(syncDataTypeSchema).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const importBodySchema = z.object({
  sourceInstanceId: z.string().trim().optional(),
  sourceInstanceName: z.string().trim().optional(),
  items: z.array(
    z.object({
      type: syncDataTypeSchema,
      naturalKey: z.string().optional(),
      data: z.record(z.unknown()),
    }),
  ),
});

const polarPointSchema = z.object({
  aoaDeg: z.coerce.number(),
  status: z.enum(["pending", "queued", "running", "done", "failed", "stale"]).default("done"),
  source: z.enum(["queued", "solved"]).default("solved"),
  regime: z.enum(["rans", "urans"]).nullable().optional(),
  reynolds: z.coerce.number().nullable().optional(),
  speed: z.coerce.number().nullable().optional(),
  chord: z.coerce.number().nullable().optional(),
  mach: z.coerce.number().nullable().optional(),
  cl: z.coerce.number().nullable().optional(),
  cd: z.coerce.number().nullable().optional(),
  cm: z.coerce.number().nullable().optional(),
  clCd: z.coerce.number().nullable().optional(),
  clStd: z.coerce.number().nullable().optional(),
  cdStd: z.coerce.number().nullable().optional(),
  cmStd: z.coerce.number().nullable().optional(),
  stalled: z.boolean().default(false),
  unsteady: z.boolean().default(false),
  converged: z.boolean().default(true),
  finalResidual: z.coerce.number().nullable().optional(),
  iterations: z.coerce.number().int().nullable().optional(),
  yPlusAvg: z.coerce.number().nullable().optional(),
  yPlusMax: z.coerce.number().nullable().optional(),
  nCells: z.coerce.number().int().nullable().optional(),
  firstOrderFallback: z.boolean().default(false),
  strouhal: z.coerce.number().nullable().optional(),
  error: z.string().nullable().optional(),
  engineJobId: z.string().nullable().optional(),
  engineCaseSlug: z.string().nullable().optional(),
  evidencePayload: z.record(z.unknown()).optional(),
  forceHistory: z
    .object({
      t: z.array(z.number()),
      cl: z.array(z.number()),
      cd: z.array(z.number()),
      cm: z.array(z.number()).optional(),
      strouhal: z.number().nullable().optional(),
      sheddingFreqHz: z.number().nullable().optional(),
      sampleCount: z.number().int().nullable().optional(),
    })
    .optional(),
  fieldExtents: z.array(z.record(z.unknown())).default([]),
  evidenceArtifacts: z.array(z.record(z.unknown())).default([]),
  media: z.array(z.record(z.unknown())).default([]),
});

const polarPushSchema = z.object({
  promiseId: z.string().uuid().optional(),
  sourceInstanceId: z.string().trim().optional(),
  sourceInstanceName: z.string().trim().optional(),
  airfoilSlug: z.string().trim().optional(),
  simulationPresetRevisionId: z.string().uuid().optional(),
  simulationPresetSignatureHash: z.string().trim().optional(),
  bcId: z.string().uuid().optional(),
  fieldColorScales: z.array(z.record(z.unknown())).default([]),
  results: z.array(polarPointSchema).min(1),
});

type PolarPushPayload = z.infer<typeof polarPushSchema>;

interface UploadedFileRef {
  storageKey: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
}

function stableHash(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, nested]) => [k, stable(nested)]));
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numberWithFallback(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function slugPart(value: unknown, fallback: string): string {
  const raw = nullableText(value) ?? fallback;
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || fallback;
}

async function ensureSyncRows(): Promise<void> {
  await db.insert(syncApiSettings).values({ id: 1 }).onConflictDoNothing();
  await db
    .insert(syncApiPermissions)
    .values(SYNC_DATA_TYPES.map((dataType) => ({ dataType, canFetch: false, canPush: false })))
    .onConflictDoNothing();
}

async function getSettings() {
  await ensureSyncRows();
  const [settings] = await db.select().from(syncApiSettings).where(eq(syncApiSettings.id, 1)).limit(1);
  const permissions = await db.select().from(syncApiPermissions).orderBy(asc(syncApiPermissions.dataType));
  return { settings: settings!, permissions };
}

async function expirePromises(): Promise<void> {
  const expiredIds = await db
    .update(syncSweepPromises)
    .set({ status: "expired", expiredAt: new Date(), updatedAt: new Date() })
    .where(and(eq(syncSweepPromises.status, "active"), sql`${syncSweepPromises.expiresAt} <= now()`))
    .returning({ id: syncSweepPromises.id });
  if (expiredIds.length) {
    await db
      .update(syncSweepPromisePoints)
      .set({ status: "expired", updatedAt: new Date() })
      .where(inArray(syncSweepPromisePoints.promiseId, expiredIds.map((row) => row.id)));
  }
}

function publicEndpoint(req: FastifyRequest, override: string | null): string {
  if (override?.trim()) return override.replace(/\/+$/, "") + "/api/sync/v1";
  const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim() || "http";
  const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? `localhost:${env.port}`).split(",")[0].trim();
  return `${proto}://${host}/api/sync/v1`;
}

function syncSecret(req: FastifyRequest): string | null {
  const direct = req.headers["x-xfoilfoam-sync-secret"];
  if (typeof direct === "string" && direct.length) return direct;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer ")) return auth.slice(7);
  return null;
}

const SYNC_POLAR_PUSH_BODY_LIMIT_BYTES = 512 * 1024 * 1024;

async function requireSync(
  req: FastifyRequest,
  reply: FastifyReply,
  dataType?: SyncDataType,
  direction?: SyncDirection,
): Promise<Awaited<ReturnType<typeof getSettings>> | null> {
  const ctx = await getSettings();
  if (!ctx.settings.enabled) {
    reply.code(404).send({ error: "sync api disabled" });
    return null;
  }
  if (!ctx.settings.secret || syncSecret(req) !== ctx.settings.secret) {
    reply.code(401).send({ error: "invalid sync secret" });
    return null;
  }
  if (dataType && direction) {
    const permission = ctx.permissions.find((p) => p.dataType === dataType);
    const allowed = direction === "fetch" ? permission?.canFetch : permission?.canPush;
    if (!allowed) {
      reply.code(403).send({ error: `${direction} disabled for ${dataType}` });
      return null;
    }
  }
  return ctx;
}

function permissionSummary(permissions: Awaited<ReturnType<typeof getSettings>>["permissions"]) {
  return Object.fromEntries(permissions.map((p) => [p.dataType, { fetch: p.canFetch, push: p.canPush }]));
}

async function createConflict(opts: {
  dataType: SyncDataType;
  naturalKey: string;
  incomingPayload: Record<string, unknown>;
  localSnapshot?: Record<string, unknown> | null;
  artifactManifest?: Record<string, unknown> | null;
  sourceInstanceId?: string | null;
  sourceInstanceName?: string | null;
}): Promise<string> {
  const [row] = await db
    .insert(syncImportConflicts)
    .values({
      dataType: opts.dataType,
      naturalKey: opts.naturalKey,
      incomingPayload: opts.incomingPayload,
      localSnapshot: opts.localSnapshot ?? null,
      artifactManifest: opts.artifactManifest ?? null,
      sourceInstanceId: opts.sourceInstanceId ?? null,
      sourceInstanceName: opts.sourceInstanceName ?? null,
    })
    .returning({ id: syncImportConflicts.id });
  return row.id;
}

function mediumValuesFromPayload(data: Record<string, unknown>) {
  const slug = nullableText(data.slug);
  if (!slug) throw new Error("medium payload lacks slug");
  const dynamicViscosity = numberWithFallback(data.dynamicViscosity ?? data.dynamic_viscosity, 1e-5);
  const density = numberWithFallback(data.density, 1);
  const phase: "gas" | "liquid" = data.phase === "liquid" ? "liquid" : "gas";
  return {
    slug,
    name: nullableText(data.name) ?? slug,
    phase,
    density,
    refTemperatureK: numberWithFallback(data.refTemperatureK ?? data.ref_temperature_k, 288.15),
    refPressurePa: numberWithFallback(data.refPressurePa ?? data.ref_pressure_pa, 101325),
    viscosityModel: nullableText(data.viscosityModel ?? data.viscosity_model) ?? "constant",
    constantDynamicViscosity: nullableNumber(data.constantDynamicViscosity ?? data.constant_dynamic_viscosity),
    sutherlandMuRef: nullableNumber(data.sutherlandMuRef ?? data.sutherland_mu_ref),
    sutherlandTRef: nullableNumber(data.sutherlandTRef ?? data.sutherland_t_ref),
    sutherlandS: nullableNumber(data.sutherlandS ?? data.sutherland_s),
    dynamicViscosity,
    kinematicViscosity: numberWithFallback(data.kinematicViscosity ?? data.kinematic_viscosity, dynamicViscosity / density),
    speedOfSound: nullableNumber(data.speedOfSound ?? data.speed_of_sound),
    notes: nullableText(data.notes),
    isSeeded: false,
  };
}

function mediumComparable(data: Record<string, unknown>) {
  const values = mediumValuesFromPayload(data);
  return {
    ...values,
    isSeeded: undefined,
    viscosityTable: Array.isArray(data.viscosityTable ?? data.viscosity_table)
      ? (data.viscosityTable ?? data.viscosity_table)
      : undefined,
  };
}

async function upsertMediumFromPayload(data: Record<string, unknown>) {
  const values = mediumValuesFromPayload(data);
  const [row] = await db
    .insert(mediums)
    .values(values)
    .onConflictDoUpdate({
      target: mediums.slug,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({ id: mediums.id });
  const tableRows = data.viscosityTable ?? data.viscosity_table;
  if (Array.isArray(tableRows)) {
    await db.delete(mediumViscosityTablePoints).where(eq(mediumViscosityTablePoints.mediumId, row.id));
    const rows = tableRows
      .map((item, index) => jsonObject(item))
      .filter((item) => typeof (item.temperatureK ?? item.temperature_k) === "number" && typeof (item.dynamicViscosity ?? item.dynamic_viscosity) === "number")
      .map((item, index) => ({
        mediumId: row.id,
        temperatureK: Number(item.temperatureK ?? item.temperature_k),
        dynamicViscosity: Number(item.dynamicViscosity ?? item.dynamic_viscosity),
        sortOrder: Number(item.sortOrder ?? item.sort_order ?? index),
      }));
    if (rows.length) await db.insert(mediumViscosityTablePoints).values(rows);
  }
  return row.id;
}

async function resolveCategoryForAirfoil(data: Record<string, unknown>, existingCategoryId?: string | null): Promise<string | null> {
  const categoryPath = nullableText(data.categoryPath ?? data.category_path);
  const categorySlug = nullableText(data.categorySlug ?? data.category_slug);
  const [category] = categoryPath
    ? await db.select({ id: categories.id }).from(categories).where(eq(categories.path, categoryPath)).limit(1)
    : categorySlug
      ? await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, categorySlug)).limit(1)
      : [];
  return category?.id ?? existingCategoryId ?? null;
}

function airfoilValuesFromPayload(data: Record<string, unknown>, categoryId: string, existingPoints?: unknown) {
  const slug = nullableText(data.slug);
  if (!slug) throw new Error("airfoil payload lacks slug");
  const points = Array.isArray(data.points) ? (data.points as never[]) : Array.isArray(existingPoints) ? (existingPoints as never[]) : [];
  if (!points.length) throw new Error("airfoil payload lacks coordinate points");
  return {
    slug,
    name: nullableText(data.name) ?? slug,
    categoryId,
    source: nullableText(data.source) ?? "remote-sync",
    points,
    pointFormat: nullableText(data.pointFormat ?? data.point_format) ?? "selig",
    thicknessPct: nullableNumber(data.thicknessPct ?? data.thickness_pct),
    thicknessXPct: nullableNumber(data.thicknessXPct ?? data.thickness_x_pct),
    camberPct: nullableNumber(data.camberPct ?? data.camber_pct),
    camberXPct: nullableNumber(data.camberXPct ?? data.camber_x_pct),
    leRadiusPct: nullableNumber(data.leRadiusPct ?? data.le_radius_pct),
    teThicknessPct: nullableNumber(data.teThicknessPct ?? data.te_thickness_pct),
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
  };
}

async function upsertAirfoilFromPayload(data: Record<string, unknown>) {
  const slug = nullableText(data.slug);
  if (!slug) throw new Error("airfoil payload lacks slug");
  const [existing] = await db.select({ categoryId: airfoils.categoryId, points: airfoils.points }).from(airfoils).where(eq(airfoils.slug, slug)).limit(1);
  const categoryId = await resolveCategoryForAirfoil(data, existing?.categoryId ?? null);
  if (!categoryId) throw new Error("airfoil payload references an unknown category");
  const values = airfoilValuesFromPayload(data, categoryId, existing?.points);
  const [row] = await db
    .insert(airfoils)
    .values(values)
    .onConflictDoUpdate({
      target: airfoils.slug,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({ id: airfoils.id });
  return row.id;
}

function permissionRowsForAdmin(permissions: Awaited<ReturnType<typeof getSettings>>["permissions"]) {
  const existing = new Map(permissions.map((p) => [p.dataType, p]));
  return SYNC_DATA_TYPES.map((dataType) => {
    const row = existing.get(dataType);
    return { dataType, canFetch: row?.canFetch ?? false, canPush: row?.canPush ?? false };
  });
}

async function syncAdminPayload(req: FastifyRequest) {
  const { settings, permissions } = await getSettings();
  const promiseRows = await db
    .select({
      status: syncSweepPromises.status,
      n: count(),
    })
    .from(syncSweepPromises)
    .groupBy(syncSweepPromises.status);
  const pointRows = await db
    .select({
      status: syncSweepPromisePoints.status,
      n: count(),
    })
    .from(syncSweepPromisePoints)
    .groupBy(syncSweepPromisePoints.status);
  const conflicts = await db
    .select()
    .from(syncImportConflicts)
    .where(eq(syncImportConflicts.status, "pending"))
    .orderBy(desc(syncImportConflicts.createdAt))
    .limit(50);
  const solvers = await db.select().from(registeredRemoteSolvers).orderBy(desc(registeredRemoteSolvers.updatedAt)).limit(100);
  const remoteAssetRows = await db
    .select({ availability: remoteAssetReferences.availability, n: count() })
    .from(remoteAssetReferences)
    .groupBy(remoteAssetReferences.availability);
  return {
    settings: {
      enabled: settings.enabled,
      instanceId: settings.instanceId,
      instanceName: settings.instanceName,
      publicEndpointOverride: settings.publicEndpointOverride,
      publicEndpoint: publicEndpoint(req, settings.publicEndpointOverride),
      secret: settings.secret,
      defaultPromiseTtlHours: settings.defaultPromiseTtlHours,
      upstreamBaseUrl: settings.upstreamBaseUrl,
      upstreamSecret: settings.upstreamSecret,
      syncMode: settings.syncMode,
      remoteSolverEnabled: settings.remoteSolverEnabled,
      remoteSolverCpuBudget: settings.remoteSolverCpuBudget,
      remoteSolverClaimSize: settings.remoteSolverClaimSize,
      remoteSolverHeartbeatIntervalSeconds: settings.remoteSolverHeartbeatIntervalSeconds,
      remoteSolverRegisteredId: settings.remoteSolverRegisteredId,
      remoteSolverLastSyncAt: iso(settings.remoteSolverLastSyncAt),
      remoteSolverLastPromiseAt: iso(settings.remoteSolverLastPromiseAt),
      remoteSolverLastPushAt: iso(settings.remoteSolverLastPushAt),
      remoteSolverLastStatus: settings.remoteSolverLastStatus,
      remoteSolverLastError: settings.remoteSolverLastError,
    },
    permissions: permissionRowsForAdmin(permissions),
    promises: {
      byStatus: Object.fromEntries(promiseRows.map((row) => [row.status, Number(row.n)])),
      pointsByStatus: Object.fromEntries(pointRows.map((row) => [row.status, Number(row.n)])),
    },
    registeredSolvers: solvers.map((row) => ({
      id: row.id,
      instanceId: row.instanceId,
      instanceName: row.instanceName,
      publicEndpoint: row.publicEndpoint,
      localEndpoint: row.localEndpoint,
      cpuCapacity: row.cpuCapacity,
      cpuBudget: row.cpuBudget,
      buildVersion: row.buildVersion,
      status: row.status,
      lastHeartbeatAt: iso(row.lastHeartbeatAt),
      activePromiseCount: row.activePromiseCount,
      activeAoaCount: row.activeAoaCount,
      solvedCount: row.solvedCount,
      pushedCount: row.pushedCount,
      recentError: row.recentError,
      updatedAt: iso(row.updatedAt),
    })),
    remoteAssets: {
      byAvailability: Object.fromEntries(remoteAssetRows.map((row) => [row.availability, Number(row.n)])),
    },
    conflicts: conflicts.map((row) => ({
      id: row.id,
      dataType: row.dataType,
      naturalKey: row.naturalKey,
      sourceInstanceId: row.sourceInstanceId,
      sourceInstanceName: row.sourceInstanceName,
      incomingPayload: row.incomingPayload,
      localSnapshot: row.localSnapshot,
      artifactManifest: row.artifactManifest,
      createdAt: iso(row.createdAt),
    })),
  };
}

function contentExtension(mimeType?: string | null, filename?: string | null): string {
  const fromName = filename ? extname(filename) : "";
  if (fromName) return fromName;
  if (mimeType === "image/png") return ".png";
  if (mimeType === "video/mp4") return ".mp4";
  if (mimeType === "application/json") return ".json";
  if (mimeType === "application/gzip") return ".gz";
  return ".bin";
}

async function storeBuffer(buf: Buffer, mimeType: string, filename?: string | null): Promise<UploadedFileRef> {
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const ext = contentExtension(mimeType, filename);
  const storageKey = `sync-imports/${sha256.slice(0, 2)}/${sha256}${ext}`;
  const full = join(env.mediaDir, storageKey);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, buf);
  return { storageKey, mimeType, sha256, byteSize: buf.byteLength };
}

async function storeMultipartFile(part: { file: AsyncIterable<Buffer>; filename?: string; mimetype?: string }): Promise<UploadedFileRef> {
  const tmpKey = `sync-imports/tmp/${randomUUID()}${contentExtension(part.mimetype, part.filename)}`;
  const tmpFull = join(env.mediaDir, tmpKey);
  await mkdir(dirname(tmpFull), { recursive: true });
  const out = createWriteStream(tmpFull);
  const hash = createHash("sha256");
  let byteSize = 0;
  try {
    for await (const chunk of part.file) {
      byteSize += chunk.length;
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
    const sha256 = hash.digest("hex");
    const storageKey = `sync-imports/${sha256.slice(0, 2)}/${sha256}${contentExtension(part.mimetype, part.filename)}`;
    const full = join(env.mediaDir, storageKey);
    await mkdir(dirname(full), { recursive: true });
    await rename(tmpFull, full).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code === "EEXIST") {
        await unlink(tmpFull).catch(() => undefined);
        return;
      }
      throw err;
    });
    return { storageKey, mimeType: part.mimetype ?? "application/octet-stream", sha256, byteSize };
  } catch (error) {
    out.destroy();
    await unlink(tmpFull).catch(() => undefined);
    throw error;
  }
}

async function parsePolarRequest(req: FastifyRequest): Promise<{ payload: PolarPushPayload; files: Map<string, UploadedFileRef> }> {
  const maybeMultipart = req as FastifyRequest & {
    isMultipart?: () => boolean;
    parts?: () => AsyncIterable<
      | { type: "field"; fieldname: string; value: unknown }
      | { type: "file"; fieldname: string; file: AsyncIterable<Buffer>; filename?: string; mimetype?: string }
    >;
  };
  if (!maybeMultipart.isMultipart?.()) {
    return { payload: polarPushSchema.parse(req.body), files: new Map() };
  }
  const files = new Map<string, UploadedFileRef>();
  let manifest: unknown = null;
  for await (const part of maybeMultipart.parts!()) {
    if (part.type === "field") {
      if (part.fieldname === "manifest") {
        manifest = typeof part.value === "string" ? JSON.parse(part.value) : part.value;
      }
      continue;
    }
    files.set(part.fieldname, await storeMultipartFile(part));
  }
  if (!manifest) throw new Error("multipart polar push requires a manifest field");
  return { payload: polarPushSchema.parse(manifest), files };
}

async function resolveUploadedArtifact(item: Record<string, unknown>, files: Map<string, UploadedFileRef>): Promise<UploadedFileRef> {
  const uploadField = nullableText(item.uploadField);
  const fromFile = uploadField ? files.get(uploadField) : null;
  const fromBase64 = nullableText(item.contentBase64);
  const ref = fromFile ?? (fromBase64 ? await storeBuffer(Buffer.from(fromBase64, "base64"), nullableText(item.mimeType) ?? "application/octet-stream", nullableText(item.filename)) : null);
  if (!ref) throw new Error(`artifact ${nullableText(item.kind) ?? nullableText(item.field) ?? "item"} is missing uploaded content`);
  if (nullableText(item.sha256) && item.sha256 !== ref.sha256) throw new Error(`sha256 mismatch for ${uploadField ?? item.sha256}`);
  if (typeof item.byteSize === "number" && item.byteSize !== ref.byteSize) throw new Error(`byte size mismatch for ${uploadField ?? item.sha256}`);
  return ref;
}

function equivalentResult(row: typeof results.$inferSelect, point: z.infer<typeof polarPointSchema>): boolean {
  const cmp = (a: number | null | undefined, b: number | null | undefined) => {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= scale * 1e-9;
  };
  return (
    row.status === point.status &&
    row.source === point.source &&
    row.regime === (point.regime ?? null) &&
    row.unsteady === point.unsteady &&
    row.converged === point.converged &&
    row.stalled === point.stalled &&
    cmp(row.cl, point.cl) &&
    cmp(row.cd, point.cd) &&
    cmp(row.cm, point.cm)
  );
}

async function importFieldExtentsForResult(opts: {
  resultId: string;
  airfoilId: string;
  simulationPresetRevisionId: string;
  extents: Record<string, unknown>[];
}) {
  let imported = 0;
  for (const extent of opts.extents) {
    const field = nullableText(extent.field);
    const vmin = nullableNumber(extent.vmin);
    const vmax = nullableNumber(extent.vmax);
    const finiteCount = typeof extent.finiteCount === "number" ? Math.round(extent.finiteCount) : typeof extent.finite_count === "number" ? Math.round(extent.finite_count) : null;
    const evidenceSha256 = nullableText(extent.evidenceSha256 ?? extent.evidence_sha256 ?? extent.sha256);
    if (!field || vmin == null || vmax == null || finiteCount == null || !evidenceSha256) continue;
    const renderProfileKey = nullableText(extent.renderProfileKey ?? extent.render_profile_key) ?? "default:v1:zoom2";
    await db
      .insert(resultFieldExtents)
      .values({
        resultId: opts.resultId,
        airfoilId: opts.airfoilId,
        simulationPresetRevisionId: opts.simulationPresetRevisionId,
        field,
        renderProfileKey,
        vmin,
        vmax,
        finiteCount,
        sourceTimeStart: nullableNumber(extent.sourceTimeStart ?? extent.source_time_start),
        sourceTimeEnd: nullableNumber(extent.sourceTimeEnd ?? extent.source_time_end),
        evidenceSha256,
      })
      .onConflictDoUpdate({
        target: [resultFieldExtents.resultId, resultFieldExtents.field, resultFieldExtents.renderProfileKey],
        set: {
          vmin,
          vmax,
          finiteCount,
          sourceTimeStart: nullableNumber(extent.sourceTimeStart ?? extent.source_time_start),
          sourceTimeEnd: nullableNumber(extent.sourceTimeEnd ?? extent.source_time_end),
          evidenceSha256,
          updatedAt: new Date(),
        },
      });
    imported++;
  }
  return imported;
}

async function importFieldColorScales(opts: {
  airfoilId: string;
  simulationPresetRevisionId: string;
  scales: Record<string, unknown>[];
  sourceInstanceId?: string;
  sourceInstanceName?: string;
}) {
  let imported = 0;
  const conflictIds: string[] = [];
  for (const scale of opts.scales) {
    const field = nullableText(scale.field);
    const vmin = nullableNumber(scale.vmin);
    const vmax = nullableNumber(scale.vmax);
    const evidenceSignature = nullableText(scale.evidenceSignature ?? scale.evidence_signature);
    if (!field || vmin == null || vmax == null || !evidenceSignature) continue;
    const renderProfileKey = nullableText(scale.renderProfileKey ?? scale.render_profile_key) ?? "default:v1:zoom2";
    const scalePolicy = nullableText(scale.scalePolicy ?? scale.scale_policy) ?? "track";
    const version = typeof scale.version === "number" ? Math.round(scale.version) : 1;
    const active = scale.active !== false;
    const [existingActive] = await db
      .select()
      .from(fieldColorScales)
      .where(
        and(
          eq(fieldColorScales.airfoilId, opts.airfoilId),
          eq(fieldColorScales.simulationPresetRevisionId, opts.simulationPresetRevisionId),
          eq(fieldColorScales.field, field),
          eq(fieldColorScales.renderProfileKey, renderProfileKey),
          eq(fieldColorScales.active, true),
        ),
      )
      .limit(1);
    if (existingActive && existingActive.evidenceSignature !== evidenceSignature) {
      conflictIds.push(
        await createConflict({
          dataType: "result_media",
          naturalKey: `${opts.airfoilId}:${opts.simulationPresetRevisionId}:${field}:${renderProfileKey}:scale`,
          incomingPayload: scale,
          localSnapshot: existingActive as unknown as Record<string, unknown>,
          sourceInstanceId: opts.sourceInstanceId,
          sourceInstanceName: opts.sourceInstanceName,
        }),
      );
      continue;
    }
    await db
      .insert(fieldColorScales)
      .values({
        airfoilId: opts.airfoilId,
        simulationPresetRevisionId: opts.simulationPresetRevisionId,
        field,
        renderProfileKey,
        scalePolicy,
        vmin,
        vmax,
        evidenceSignature,
        status: scale.status === "rebalancing" || scale.status === "staged" ? "rebalancing" : scale.status === "failed" ? "failed" : "active",
        version,
        active,
        failureReason: nullableText(scale.failureReason ?? scale.failure_reason),
        activatedAt: active ? new Date() : null,
      })
      .onConflictDoNothing({
        target: [
          fieldColorScales.airfoilId,
          fieldColorScales.simulationPresetRevisionId,
          fieldColorScales.field,
          fieldColorScales.renderProfileKey,
          fieldColorScales.version,
        ],
      });
    imported++;
  }
  return { imported, conflictIds };
}

async function importMedium(
  data: Record<string, unknown>,
  source: { sourceInstanceId?: string; sourceInstanceName?: string },
): Promise<{ imported: boolean; conflictId?: string }> {
  const slug = nullableText(data.slug);
  if (!slug) {
    return { imported: false, conflictId: await createConflict({ dataType: "mediums", naturalKey: "missing-slug", incomingPayload: data, sourceInstanceId: source.sourceInstanceId, sourceInstanceName: source.sourceInstanceName }) };
  }
  const [existing] = await db.select().from(mediums).where(eq(mediums.slug, slug)).limit(1);
  if (existing) {
    const tableRows = await db.select().from(mediumViscosityTablePoints).where(eq(mediumViscosityTablePoints.mediumId, existing.id));
    const localComparable = stableHash(mediumComparable({ ...existing, viscosityTable: tableRows }));
    const incomingComparable = stableHash(mediumComparable(data));
    if (localComparable === incomingComparable) return { imported: false };
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "mediums",
        naturalKey: slug,
        incomingPayload: data,
        localSnapshot: existing as unknown as Record<string, unknown>,
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  await upsertMediumFromPayload(data);
  return { imported: true };
}

async function importCategory(data: Record<string, unknown>): Promise<boolean> {
  const slug = nullableText(data.slug);
  const name = nullableText(data.name) ?? slug;
  const path = nullableText(data.path) ?? slug;
  if (!slug || !name || !path) return false;
  const [existing] = await db.select({ id: categories.id }).from(categories).where(eq(categories.path, path)).limit(1);
  if (existing) return false;
  await db.insert(categories).values({
    slug,
    name,
    path,
    depth: Number(data.depth ?? path.split("/").length - 1),
    sortOrder: Number(data.sortOrder ?? data.sort_order ?? 0),
    description: nullableText(data.description),
  });
  return true;
}

async function importHashtag(data: Record<string, unknown>): Promise<boolean> {
  const slug = nullableText(data.slug);
  if (!slug) return false;
  const [existing] = await db.select({ id: hashtags.id }).from(hashtags).where(eq(hashtags.slug, slug)).limit(1);
  if (existing) return false;
  await db.insert(hashtags).values({ slug, name: nullableText(data.name) ?? slug });
  return true;
}

async function importAirfoil(
  data: Record<string, unknown>,
  source: { sourceInstanceId?: string; sourceInstanceName?: string },
): Promise<{ imported: boolean; conflictId?: string }> {
  const slug = nullableText(data.slug);
  if (!slug) {
    return { imported: false, conflictId: await createConflict({ dataType: "airfoils", naturalKey: "missing-slug", incomingPayload: data, sourceInstanceId: source.sourceInstanceId, sourceInstanceName: source.sourceInstanceName }) };
  }
  const [existing] = await db.select().from(airfoils).where(eq(airfoils.slug, slug)).limit(1);
  if (existing) {
    const samePoints = stableHash(existing.points) === stableHash(data.points);
    if (samePoints) return { imported: false };
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "airfoils",
        naturalKey: slug,
        incomingPayload: data,
        localSnapshot: existing as unknown as Record<string, unknown>,
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  const categoryId = await resolveCategoryForAirfoil(data);
  if (!categoryId) {
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "airfoils",
        naturalKey: slug,
        incomingPayload: data,
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  await upsertAirfoilFromPayload(data);
  return { imported: true };
}

async function importSimulationSetupRevision(
  data: Record<string, unknown>,
  source: { sourceInstanceId?: string | null; sourceInstanceName?: string | null },
): Promise<{ imported: boolean; conflictId?: string; revisionId?: string }> {
  if (data.kind !== "simulation_preset_revision") return { imported: false };
  const snapshotRaw = data.snapshot;
  if (!snapshotRaw || typeof snapshotRaw !== "object" || Array.isArray(snapshotRaw)) {
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "simulation_setup",
        naturalKey: nullableText(data.id) ?? stableHash(data).slice(0, 24),
        incomingPayload: data,
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  const snapshot = snapshotRaw as unknown as SimulationSetupSnapshot;
  const signatureHash = nullableText(data.signatureHash ?? data.signature_hash) ?? simulationSetupSignature(snapshot);
  const prefix = `remote-${slugPart(source.sourceInstanceId, "upstream")}-${signatureHash.slice(0, 12)}`;
  const mediumSlug = nullableText(snapshot.flowState?.mediumSlug) ?? slugPart(snapshot.flowState?.mediumName, "medium");
  const [medium] = await db
    .insert(mediums)
    .values({
      slug: mediumSlug,
      name: nullableText(snapshot.flowState?.mediumName) ?? mediumSlug,
      phase: "gas",
      density: snapshot.flowState.density,
      refTemperatureK: snapshot.flowState.temperatureK,
      refPressurePa: snapshot.flowState.pressurePa,
      viscosityModel: "constant",
      constantDynamicViscosity: snapshot.flowState.dynamicViscosity,
      dynamicViscosity: snapshot.flowState.dynamicViscosity,
      kinematicViscosity: snapshot.flowState.kinematicViscosity,
      speedOfSound: snapshot.flowState.mach && snapshot.flowState.mach > 0 ? snapshot.flowState.speedMps / snapshot.flowState.mach : null,
      notes: `Imported from ${source.sourceInstanceName ?? source.sourceInstanceId ?? "up-tier sync"}`,
      isSeeded: false,
    })
    .onConflictDoUpdate({
      target: mediums.slug,
      set: {
        name: nullableText(snapshot.flowState?.mediumName) ?? mediumSlug,
        density: snapshot.flowState.density,
        refTemperatureK: snapshot.flowState.temperatureK,
        refPressurePa: snapshot.flowState.pressurePa,
        dynamicViscosity: snapshot.flowState.dynamicViscosity,
        kinematicViscosity: snapshot.flowState.kinematicViscosity,
        updatedAt: new Date(),
      },
    })
    .returning({ id: mediums.id });

  const [flow] = await db
    .insert(flowConditions)
    .values({
      slug: `${prefix}-flow`,
      name: `Remote flow ${signatureHash.slice(0, 8)}`,
      mediumId: medium.id,
      temperatureK: snapshot.flowState.temperatureK,
      pressurePa: snapshot.flowState.pressurePa,
      speedMps: snapshot.flowState.speedMps,
      density: snapshot.flowState.density,
      dynamicViscosity: snapshot.flowState.dynamicViscosity,
      kinematicViscosity: snapshot.flowState.kinematicViscosity,
      mach: snapshot.flowState.mach,
    })
    .onConflictDoUpdate({
      target: flowConditions.slug,
      set: {
        mediumId: medium.id,
        temperatureK: snapshot.flowState.temperatureK,
        pressurePa: snapshot.flowState.pressurePa,
        speedMps: snapshot.flowState.speedMps,
        density: snapshot.flowState.density,
        dynamicViscosity: snapshot.flowState.dynamicViscosity,
        kinematicViscosity: snapshot.flowState.kinematicViscosity,
        mach: snapshot.flowState.mach,
        updatedAt: new Date(),
      },
    })
    .returning({ id: flowConditions.id });
  const [referenceGeometry] = await db
    .insert(referenceGeometryProfiles)
    .values({
      slug: `${prefix}-reference`,
      name: `Remote reference ${signatureHash.slice(0, 8)}`,
      geometryType: snapshot.referenceGeometry.geometryType,
      referenceLengthKind: snapshot.referenceGeometry.referenceLengthKind,
      referenceLengthM: snapshot.referenceGeometry.referenceLengthM,
      spanM: snapshot.referenceGeometry.spanM,
      referenceAreaM2: snapshot.referenceGeometry.referenceAreaM2,
    })
    .onConflictDoUpdate({
      target: referenceGeometryProfiles.slug,
      set: {
        geometryType: snapshot.referenceGeometry.geometryType,
        referenceLengthKind: snapshot.referenceGeometry.referenceLengthKind,
        referenceLengthM: snapshot.referenceGeometry.referenceLengthM,
        spanM: snapshot.referenceGeometry.spanM,
        referenceAreaM2: snapshot.referenceGeometry.referenceAreaM2,
        updatedAt: new Date(),
      },
    })
    .returning({ id: referenceGeometryProfiles.id });
  const [boundary] = await db
    .insert(boundaryProfiles)
    .values({
      slug: `${prefix}-boundary`,
      name: `Remote boundary ${signatureHash.slice(0, 8)}`,
      turbulenceIntensity: snapshot.boundary.turbulenceIntensity,
      viscosityRatio: snapshot.boundary.viscosityRatio,
      sandGrainHeight: snapshot.boundary.sandGrainHeight,
      roughnessConstant: snapshot.boundary.roughnessConstant,
    })
    .onConflictDoUpdate({
      target: boundaryProfiles.slug,
      set: {
        turbulenceIntensity: snapshot.boundary.turbulenceIntensity,
        viscosityRatio: snapshot.boundary.viscosityRatio,
        sandGrainHeight: snapshot.boundary.sandGrainHeight,
        roughnessConstant: snapshot.boundary.roughnessConstant,
        updatedAt: new Date(),
      },
    })
    .returning({ id: boundaryProfiles.id });
  const [mesh] = await db
    .insert(meshProfiles)
    .values({
      slug: `${prefix}-mesh`,
      name: `Remote mesh ${signatureHash.slice(0, 8)}`,
      mesher: snapshot.mesh.mesher,
      farfieldRadiusChords: snapshot.mesh.farfieldRadiusChords,
      wakeLengthChords: snapshot.mesh.wakeLengthChords,
      nSurface: snapshot.mesh.nSurface,
      nRadial: snapshot.mesh.nRadial,
      nWake: snapshot.mesh.nWake,
      targetYPlus: snapshot.mesh.targetYPlus,
      spanChords: snapshot.mesh.spanChords,
    })
    .onConflictDoUpdate({
      target: meshProfiles.slug,
      set: {
        mesher: snapshot.mesh.mesher,
        farfieldRadiusChords: snapshot.mesh.farfieldRadiusChords,
        wakeLengthChords: snapshot.mesh.wakeLengthChords,
        nSurface: snapshot.mesh.nSurface,
        nRadial: snapshot.mesh.nRadial,
        nWake: snapshot.mesh.nWake,
        targetYPlus: snapshot.mesh.targetYPlus,
        spanChords: snapshot.mesh.spanChords,
        updatedAt: new Date(),
      },
    })
    .returning({ id: meshProfiles.id });
  const [solver] = await db
    .insert(solverProfiles)
    .values({
      slug: `${prefix}-solver`,
      name: `Remote solver ${signatureHash.slice(0, 8)}`,
      turbulenceModel: snapshot.solver.turbulenceModel,
      nIterations: snapshot.solver.nIterations,
      convergenceTolerance: snapshot.solver.convergenceTolerance,
      momentumScheme: snapshot.solver.momentumScheme,
      transientCycles: snapshot.solver.transientCycles,
      transientDiscardFraction: snapshot.solver.transientDiscardFraction,
      transientMaxCourant: snapshot.solver.transientMaxCourant,
    })
    .onConflictDoUpdate({
      target: solverProfiles.slug,
      set: {
        turbulenceModel: snapshot.solver.turbulenceModel,
        nIterations: snapshot.solver.nIterations,
        convergenceTolerance: snapshot.solver.convergenceTolerance,
        momentumScheme: snapshot.solver.momentumScheme,
        transientCycles: snapshot.solver.transientCycles,
        transientDiscardFraction: snapshot.solver.transientDiscardFraction,
        transientMaxCourant: snapshot.solver.transientMaxCourant,
        updatedAt: new Date(),
      },
    })
    .returning({ id: solverProfiles.id });
  const [scheduling] = await db
    .insert(schedulingProfiles)
    .values({
      slug: `${prefix}-scheduling`,
      name: `Remote scheduling ${signatureHash.slice(0, 8)}`,
      schedulingPolicy: snapshot.scheduling.schedulingPolicy,
      cpuBudget: snapshot.scheduling.cpuBudget,
      caseConcurrency: snapshot.scheduling.caseConcurrency,
      solverProcesses: snapshot.scheduling.solverProcesses,
    })
    .onConflictDoUpdate({
      target: schedulingProfiles.slug,
      set: {
        schedulingPolicy: snapshot.scheduling.schedulingPolicy,
        cpuBudget: snapshot.scheduling.cpuBudget,
        caseConcurrency: snapshot.scheduling.caseConcurrency,
        solverProcesses: snapshot.scheduling.solverProcesses,
        updatedAt: new Date(),
      },
    })
    .returning({ id: schedulingProfiles.id });
  const [output] = await db
    .insert(outputProfiles)
    .values({
      slug: `${prefix}-output`,
      name: `Remote output ${signatureHash.slice(0, 8)}`,
      writeImages: snapshot.output.writeImages,
      imageZoomChords: snapshot.output.imageZoomChords,
    })
    .onConflictDoUpdate({
      target: outputProfiles.slug,
      set: {
        writeImages: snapshot.output.writeImages,
        imageZoomChords: snapshot.output.imageZoomChords,
        updatedAt: new Date(),
      },
    })
    .returning({ id: outputProfiles.id });
  const [sweep] = await db
    .insert(sweepDefinitions)
    .values({
      slug: `${prefix}-sweep`,
      name: `Remote sweep ${signatureHash.slice(0, 8)}`,
      aoaStart: snapshot.sweep.aoaStart,
      aoaStop: snapshot.sweep.aoaStop,
      aoaStep: snapshot.sweep.aoaStep,
      aoaList: snapshot.sweep.aoaList,
    })
    .onConflictDoUpdate({
      target: sweepDefinitions.slug,
      set: {
        aoaStart: snapshot.sweep.aoaStart,
        aoaStop: snapshot.sweep.aoaStop,
        aoaStep: snapshot.sweep.aoaStep,
        aoaList: snapshot.sweep.aoaList,
        updatedAt: new Date(),
      },
    })
    .returning({ id: sweepDefinitions.id });

  const [legacy] = await db
    .insert(boundaryConditions)
    .values({
      slug: `${prefix}-legacy-bc`,
      name: `Remote compatibility setup ${signatureHash.slice(0, 8)}`,
      mediumId: medium.id,
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
      enabled: false,
      isSeeded: false,
    })
    .onConflictDoUpdate({
      target: boundaryConditions.slug,
      set: {
        reynolds: Math.round(snapshot.derived.reynolds),
        speedMps: snapshot.flowState.speedMps,
        referenceChordM: snapshot.referenceGeometry.referenceLengthM,
        updatedAt: new Date(),
      },
    })
    .returning({ id: boundaryConditions.id });

  const localSnapshot: SimulationSetupSnapshot = {
    ...snapshot,
    preset: { ...snapshot.preset, slug: `${prefix}-preset`, legacyBoundaryConditionId: legacy.id, enabled: false },
    flowState: { ...snapshot.flowState, mediumId: medium.id },
  };
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${prefix}-preset`,
      name: snapshot.preset.name || `Remote preset ${signatureHash.slice(0, 8)}`,
      flowConditionId: flow.id,
      referenceGeometryProfileId: referenceGeometry.id,
      boundaryProfileId: boundary.id,
      meshProfileId: mesh.id,
      solverProfileId: solver.id,
      schedulingProfileId: scheduling.id,
      outputProfileId: output.id,
      sweepDefinitionId: sweep.id,
      legacyBoundaryConditionId: legacy.id,
      targetScope: "all",
      enabled: false,
      isSeeded: false,
    })
    .onConflictDoUpdate({
      target: simulationPresets.slug,
      set: {
        flowConditionId: flow.id,
        referenceGeometryProfileId: referenceGeometry.id,
        boundaryProfileId: boundary.id,
        meshProfileId: mesh.id,
        solverProfileId: solver.id,
        schedulingProfileId: scheduling.id,
        outputProfileId: output.id,
        sweepDefinitionId: sweep.id,
        legacyBoundaryConditionId: legacy.id,
        enabled: false,
        updatedAt: new Date(),
      },
    })
    .returning({ id: simulationPresets.id });
  localSnapshot.preset.id = preset.id;
  const revisionNumber = Math.max(1, Math.round(numberWithFallback(data.revisionNumber ?? data.revision_number, 1)));
  const [revision] = await db
    .insert(simulationPresetRevisions)
    .values({
      presetId: preset.id,
      revisionNumber,
      signatureHash,
      reynolds: Math.round(numberWithFallback(data.reynolds, snapshot.derived.reynolds)),
      mach: nullableNumber(data.mach) ?? snapshot.derived.mach,
      referenceLengthM: numberWithFallback(data.referenceLengthM ?? data.reference_length_m, snapshot.referenceGeometry.referenceLengthM),
      snapshot: localSnapshot as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: [simulationPresetRevisions.presetId, simulationPresetRevisions.signatureHash] })
    .returning({ id: simulationPresetRevisions.id });
  const revisionId =
    revision?.id ??
    (
      await db
        .select({ id: simulationPresetRevisions.id })
        .from(simulationPresetRevisions)
        .where(and(eq(simulationPresetRevisions.presetId, preset.id), eq(simulationPresetRevisions.signatureHash, signatureHash)))
        .limit(1)
    )[0]?.id;
  return { imported: Boolean(revision?.id), revisionId };
}

async function promotePolarConflict(conflict: typeof syncImportConflicts.$inferSelect) {
  const [airfoilId, revisionId, ...aoaParts] = conflict.naturalKey.split(":");
  const aoaDeg = Number(aoaParts.join(":"));
  if (!airfoilId || !revisionId || !Number.isFinite(aoaDeg)) {
    throw new Error("polar conflict natural key is not promotable");
  }
  const point = polarPointSchema.parse(conflict.incomingPayload);
  const [existing] = await db
    .select()
    .from(results)
    .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, aoaDeg)))
    .limit(1);
  let bcId: string | null = existing?.bcId ?? null;
  if (!bcId) {
    const [revision] = await db.select().from(simulationPresetRevisions).where(eq(simulationPresetRevisions.id, revisionId)).limit(1);
    const snapshot = jsonObject(revision?.snapshot);
    bcId = nullableText(jsonObject(snapshot.preset).legacyBoundaryConditionId);
  }
  if (!bcId) throw new Error("polar conflict cannot resolve boundary/setup id");
  const values = {
    airfoilId,
    bcId,
    simulationPresetRevisionId: revisionId,
    aoaDeg,
    status: point.status,
    source: point.status === "done" ? "solved" : point.source,
    regime: point.regime ?? (point.unsteady ? "urans" : "rans"),
    reynolds: point.reynolds ? Math.round(point.reynolds) : null,
    speed: point.speed ?? null,
    chord: point.chord ?? null,
    mach: point.mach ?? null,
    cl: point.cl ?? null,
    cd: point.cd ?? null,
    cm: point.cm ?? null,
    clCd: point.clCd ?? null,
    clStd: point.clStd ?? null,
    cdStd: point.cdStd ?? null,
    cmStd: point.cmStd ?? null,
    stalled: point.stalled,
    unsteady: point.unsteady,
    converged: point.converged,
    finalResidual: point.finalResidual ?? null,
    iterations: point.iterations ?? null,
    yPlusAvg: point.yPlusAvg ?? null,
    yPlusMax: point.yPlusMax ?? null,
    nCells: point.nCells ?? null,
    firstOrderFallback: point.firstOrderFallback,
    strouhal: point.strouhal ?? null,
    error: point.error ?? null,
    engineJobId: point.engineJobId ?? `sync:${conflict.sourceInstanceId ?? "remote"}:promoted`,
    engineCaseSlug: point.engineCaseSlug ?? null,
    solvedAt: point.status === "done" ? new Date() : null,
    updatedAt: new Date(),
  };
  if (existing) {
    await db.update(results).set(values).where(eq(results.id, existing.id));
  } else {
    await db.insert(results).values(values);
  }
  await refreshPolarCacheForRevision(db, airfoilId, revisionId);
}

async function importPolarPush(payload: PolarPushPayload, files: Map<string, UploadedFileRef>): Promise<{
  imported: number;
  attempts: number;
  artifacts: number;
  media: number;
  fieldExtents: number;
  fieldColorScales: number;
  conflictIds: string[];
  promiseId: string | null;
}> {
  await expirePromises();
  const conflictIds: string[] = [];
  let imported = 0;
  let attempts = 0;
  let artifacts = 0;
  let media = 0;
  let fieldExtents = 0;
  let importedFieldColorScales = 0;
  let airfoilId: string | null = null;
  let revisionId: string | null = null;
  let bcId: string | null = payload.bcId ?? null;
  let promise: typeof syncSweepPromises.$inferSelect | null = null;

  if (payload.promiseId) {
    [promise] = await db.select().from(syncSweepPromises).where(eq(syncSweepPromises.id, payload.promiseId)).limit(1);
    if (!promise || promise.status !== "active" || promise.expiresAt <= new Date()) {
      throw new Error("promise is not active");
    }
    airfoilId = promise.airfoilId;
    revisionId = promise.simulationPresetRevisionId;
  } else if (payload.airfoilSlug) {
    const [airfoil] = await db.select({ id: airfoils.id }).from(airfoils).where(eq(airfoils.slug, payload.airfoilSlug)).limit(1);
    airfoilId = airfoil?.id ?? null;
    if (payload.simulationPresetRevisionId) revisionId = payload.simulationPresetRevisionId;
    if (!revisionId && payload.simulationPresetSignatureHash) {
      const [revision] = await db
        .select({ id: simulationPresetRevisions.id })
        .from(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.signatureHash, payload.simulationPresetSignatureHash))
        .limit(1);
      revisionId = revision?.id ?? null;
    }
  }
  if (!airfoilId || !revisionId) {
    conflictIds.push(
      await createConflict({
        dataType: "polars",
        naturalKey: payload.promiseId ?? `${payload.airfoilSlug ?? "unknown"}:${payload.simulationPresetSignatureHash ?? payload.simulationPresetRevisionId ?? "unknown"}`,
        incomingPayload: payload as unknown as Record<string, unknown>,
        sourceInstanceId: payload.sourceInstanceId,
        sourceInstanceName: payload.sourceInstanceName,
      }),
    );
    return { imported, attempts, artifacts, media, fieldExtents, fieldColorScales: importedFieldColorScales, conflictIds, promiseId: payload.promiseId ?? null };
  }

  const [revision] = await db.select().from(simulationPresetRevisions).where(eq(simulationPresetRevisions.id, revisionId)).limit(1);
  const snapshot = jsonObject(revision?.snapshot);
  const snapshotPreset = jsonObject(snapshot.preset);
  bcId = bcId ?? nullableText(snapshotPreset.legacyBoundaryConditionId);
  if (!bcId) {
    conflictIds.push(
      await createConflict({
        dataType: "polars",
        naturalKey: `${airfoilId}:${revisionId}`,
        incomingPayload: payload as unknown as Record<string, unknown>,
        sourceInstanceId: payload.sourceInstanceId,
        sourceInstanceName: payload.sourceInstanceName,
      }),
    );
    return { imported, attempts, artifacts, media, fieldExtents, fieldColorScales: importedFieldColorScales, conflictIds, promiseId: payload.promiseId ?? null };
  }

  if (payload.fieldColorScales.length) {
    const scaleResult = await importFieldColorScales({
      airfoilId,
      simulationPresetRevisionId: revisionId,
      scales: payload.fieldColorScales,
      sourceInstanceId: payload.sourceInstanceId,
      sourceInstanceName: payload.sourceInstanceName,
    });
    importedFieldColorScales += scaleResult.imported;
    conflictIds.push(...scaleResult.conflictIds);
  }

  for (const point of payload.results) {
    const [existing] = await db
      .select()
      .from(results)
      .where(and(eq(results.airfoilId, airfoilId), eq(results.simulationPresetRevisionId, revisionId), eq(results.aoaDeg, point.aoaDeg)))
      .limit(1);
    let resultId = existing?.id ?? null;
    if (existing && !equivalentResult(existing, point)) {
      conflictIds.push(
        await createConflict({
          dataType: "polars",
          naturalKey: `${airfoilId}:${revisionId}:${point.aoaDeg}`,
          incomingPayload: point as unknown as Record<string, unknown>,
          localSnapshot: existing as unknown as Record<string, unknown>,
          sourceInstanceId: payload.sourceInstanceId,
          sourceInstanceName: payload.sourceInstanceName,
        }),
      );
    }
    if (!existing) {
      const [row] = await db
        .insert(results)
        .values({
          airfoilId,
          bcId,
          simulationPresetRevisionId: revisionId,
          aoaDeg: point.aoaDeg,
          status: point.status,
          source: point.status === "done" ? "solved" : point.source,
          regime: point.regime ?? (point.unsteady ? "urans" : "rans"),
          reynolds: point.reynolds ? Math.round(point.reynolds) : null,
          speed: point.speed ?? null,
          chord: point.chord ?? null,
          mach: point.mach ?? null,
          cl: point.cl ?? null,
          cd: point.cd ?? null,
          cm: point.cm ?? null,
          clCd: point.clCd ?? null,
          clStd: point.clStd ?? null,
          cdStd: point.cdStd ?? null,
          cmStd: point.cmStd ?? null,
          stalled: point.stalled,
          unsteady: point.unsteady,
          converged: point.converged,
          finalResidual: point.finalResidual ?? null,
          iterations: point.iterations ?? null,
          yPlusAvg: point.yPlusAvg ?? null,
          yPlusMax: point.yPlusMax ?? null,
          nCells: point.nCells ?? null,
          firstOrderFallback: point.firstOrderFallback,
          strouhal: point.strouhal ?? null,
          error: point.error ?? null,
          engineJobId: point.engineJobId ?? `sync:${payload.sourceInstanceId ?? "remote"}:${payload.promiseId ?? "direct"}`,
          engineCaseSlug: point.engineCaseSlug ?? null,
          solvedAt: point.status === "done" ? new Date() : null,
        })
        .returning({ id: results.id });
      resultId = row.id;
      imported++;
    }
    if (!resultId) continue;
    const [attempt] = await db
      .insert(resultAttempts)
      .values({
        resultId,
        airfoilId,
        bcId,
        simulationPresetRevisionId: revisionId,
        aoaDeg: point.aoaDeg,
        status: point.status === "done" ? "done" : "failed",
        source: point.status === "done" ? "solved" : "queued",
        regime: point.regime ?? (point.unsteady ? "urans" : "rans"),
        validForPolar: point.status === "done" && point.converged && !point.error && Number(point.cd ?? 0) > 0,
        engineJobId: point.engineJobId ?? `sync:${payload.sourceInstanceId ?? "remote"}:${payload.promiseId ?? "direct"}`,
        engineCaseSlug: point.engineCaseSlug ?? null,
        cl: point.cl ?? null,
        cd: point.cd ?? null,
        cm: point.cm ?? null,
        clCd: point.clCd ?? null,
        clStd: point.clStd ?? null,
        cdStd: point.cdStd ?? null,
        cmStd: point.cmStd ?? null,
        stalled: point.stalled,
        unsteady: point.unsteady,
        converged: point.converged,
        finalResidual: point.finalResidual ?? null,
        iterations: point.iterations ?? null,
        yPlusAvg: point.yPlusAvg ?? null,
        yPlusMax: point.yPlusMax ?? null,
        nCells: point.nCells ?? null,
        firstOrderFallback: point.firstOrderFallback,
        strouhal: point.strouhal ?? null,
        error: point.error ?? null,
        evidencePayload: point.evidencePayload ?? point,
        solvedAt: point.status === "done" ? new Date() : null,
      })
      .returning({ id: resultAttempts.id });
    attempts++;

    fieldExtents += await importFieldExtentsForResult({
      resultId,
      airfoilId,
      simulationPresetRevisionId: revisionId,
      extents: point.fieldExtents,
    });

    for (const artifact of point.evidenceArtifacts) {
      const stored = await resolveUploadedArtifact(artifact, files);
      await db
        .insert(solverEvidenceArtifacts)
        .values({
          resultId,
          resultAttemptId: attempt.id,
          airfoilId,
          engineJobId: point.engineJobId ?? `sync:${payload.sourceInstanceId ?? "remote"}:${payload.promiseId ?? "direct"}`,
          engineCaseSlug: point.engineCaseSlug ?? null,
          aoaDeg: point.aoaDeg,
          kind: (nullableText(artifact.kind) ?? "field_data") as never,
          field: nullableText(artifact.field),
          role: nullableText(artifact.role),
          storageKey: stored.storageKey,
          mimeType: nullableText(artifact.mimeType) ?? stored.mimeType,
          sha256: stored.sha256,
          byteSize: stored.byteSize,
          metadata: { ...jsonObject(artifact.metadata), sourceInstanceId: payload.sourceInstanceId ?? null },
        })
        .onConflictDoNothing({ target: [solverEvidenceArtifacts.storageKey, solverEvidenceArtifacts.sha256] });
      artifacts++;
    }

    for (const m of point.media) {
      const stored = await resolveUploadedArtifact(m, files);
      await db
        .insert(resultMedia)
        .values({
          resultId,
          kind: (nullableText(m.kind) ?? "image") as never,
          field: nullableText(m.field),
          role: (nullableText(m.role) ?? "instantaneous") as never,
          storageKey: stored.storageKey,
          mimeType: nullableText(m.mimeType) ?? stored.mimeType,
          width: typeof m.width === "number" ? Math.round(m.width) : null,
          height: typeof m.height === "number" ? Math.round(m.height) : null,
          frameCount: typeof m.frameCount === "number" ? Math.round(m.frameCount) : null,
          durationS: typeof m.durationS === "number" ? m.durationS : null,
          colorScaleVersion: typeof m.colorScaleVersion === "number" ? Math.round(m.colorScaleVersion) : null,
          scaleVmin: typeof m.scaleVmin === "number" ? m.scaleVmin : null,
          scaleVmax: typeof m.scaleVmax === "number" ? m.scaleVmax : null,
          scalePolicy: nullableText(m.scalePolicy),
          renderProfileKey: nullableText(m.renderProfileKey) ?? "default:v1:zoom2",
        })
        .onConflictDoUpdate({
          target: [resultMedia.resultId, resultMedia.kind, resultMedia.field, resultMedia.role],
          set: {
            storageKey: stored.storageKey,
            mimeType: nullableText(m.mimeType) ?? stored.mimeType,
          },
        });
      media++;
    }

    if (point.forceHistory) {
      await db
        .insert(forceHistory)
        .values({
          resultId,
          t: point.forceHistory.t,
          cl: point.forceHistory.cl,
          cd: point.forceHistory.cd,
          cm: point.forceHistory.cm ?? null,
          strouhal: point.forceHistory.strouhal ?? null,
          sheddingFreqHz: point.forceHistory.sheddingFreqHz ?? null,
          sampleCount: point.forceHistory.sampleCount ?? null,
        })
        .onConflictDoUpdate({
          target: forceHistory.resultId,
          set: {
            t: point.forceHistory.t,
            cl: point.forceHistory.cl,
            cd: point.forceHistory.cd,
            cm: point.forceHistory.cm ?? null,
            strouhal: point.forceHistory.strouhal ?? null,
          },
        });
    }

    if (payload.promiseId) {
      await db
        .update(syncSweepPromisePoints)
        .set({ status: "fulfilled", resultId, updatedAt: new Date() })
        .where(
          and(
            eq(syncSweepPromisePoints.promiseId, payload.promiseId),
            eq(syncSweepPromisePoints.airfoilId, airfoilId),
            eq(syncSweepPromisePoints.simulationPresetRevisionId, revisionId),
            eq(syncSweepPromisePoints.aoaDeg, point.aoaDeg),
          ),
        );
    }
  }

  await refreshPolarCacheForRevision(db, airfoilId, revisionId);

  if (payload.promiseId) {
    const [remaining] = await db
      .select({ n: count() })
      .from(syncSweepPromisePoints)
      .where(and(eq(syncSweepPromisePoints.promiseId, payload.promiseId), eq(syncSweepPromisePoints.status, "active")));
    if ((remaining?.n ?? 0) === 0) {
      await db.update(syncSweepPromises).set({ status: "fulfilled", fulfilledAt: new Date(), updatedAt: new Date() }).where(eq(syncSweepPromises.id, payload.promiseId));
    }
  }

  return { imported, attempts, artifacts, media, fieldExtents, fieldColorScales: importedFieldColorScales, conflictIds, promiseId: payload.promiseId ?? null };
}

function exportRow(type: SyncDataType, data: unknown) {
  return { type, data };
}

function upstreamBase(settings: typeof syncApiSettings.$inferSelect): string {
  if (!settings.upstreamBaseUrl) throw new Error("up-tier API endpoint is not configured");
  return settings.upstreamBaseUrl.replace(/\/+$/, "");
}

function remoteHeaders(settings: typeof syncApiSettings.$inferSelect): Record<string, string> {
  return settings.upstreamSecret ? { "x-xfoilfoam-sync-secret": settings.upstreamSecret } : {};
}

function resolveRemoteDownloadUrl(settings: typeof syncApiSettings.$inferSelect, raw: unknown): string {
  const value = nullableText(raw);
  if (!value) throw new Error("remote asset payload lacks download URL");
  if (/^https?:\/\//i.test(value)) return value;
  return `${upstreamBase(settings)}/${value.replace(/^\/+/, "")}`;
}

function extFromMime(mime: string): string {
  if (mime.includes("png")) return ".png";
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("mp4")) return ".mp4";
  if (mime.includes("webm")) return ".webm";
  if (mime.includes("json")) return ".json";
  if (mime.includes("csv")) return ".csv";
  if (mime.includes("gzip")) return ".gz";
  if (mime.includes("text")) return ".txt";
  return ".bin";
}

async function downloadRemoteAsset(opts: {
  settings: typeof syncApiSettings.$inferSelect;
  downloadUrl: string;
  storageKey: string;
  expectedSha256?: string | null;
  expectedByteSize?: number | null;
}): Promise<{ sha256: string; byteSize: number; storageKey: string }> {
  const res = await fetch(opts.downloadUrl, { headers: remoteHeaders(opts.settings) });
  if (!res.ok || !res.body) throw new Error(`remote asset download failed (${res.status})`);
  const target = join(env.mediaDir, opts.storageKey);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const hash = createHash("sha256");
  let byteSize = 0;
  const stream = createReadStream(tmp);
  stream.on("data", (chunk: Buffer | string) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteSize += buf.length;
    hash.update(buf);
  });
  await once(stream, "end");
  const sha256 = hash.digest("hex");
  if (opts.expectedSha256 && sha256 !== opts.expectedSha256) {
    await unlink(tmp).catch(() => undefined);
    throw new Error(`remote asset checksum mismatch for ${opts.storageKey}`);
  }
  if (opts.expectedByteSize != null && opts.expectedByteSize > 0 && byteSize !== opts.expectedByteSize) {
    await unlink(tmp).catch(() => undefined);
    throw new Error(`remote asset byte size mismatch for ${opts.storageKey}`);
  }
  await rename(tmp, target);
  return { sha256, byteSize, storageKey: opts.storageKey };
}

async function localResultForRemote(sourceInstanceId: string | null | undefined, remoteResultId: string | null | undefined) {
  if (!remoteResultId) return null;
  const engineJobId = `sync:${sourceInstanceId ?? "upstream"}:${remoteResultId}`;
  const [row] = await db.select().from(results).where(eq(results.engineJobId, engineJobId)).limit(1);
  return row ?? null;
}

async function importExportedResult(
  data: Record<string, unknown>,
  source: { sourceInstanceId?: string | null; sourceInstanceName?: string | null },
): Promise<{ imported: boolean; conflictId?: string; resultId?: string }> {
  const remoteResultId = nullableText(data.remoteResultId ?? data.id);
  const airfoilSlug = nullableText(data.airfoilSlug);
  const signatureHash = nullableText(data.simulationPresetSignatureHash);
  const aoaDeg = nullableNumber(data.aoaDeg ?? data.aoa_deg);
  if (!remoteResultId || !airfoilSlug || !signatureHash || aoaDeg == null) {
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "polars",
        naturalKey: remoteResultId ?? stableHash(data).slice(0, 24),
        incomingPayload: data,
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  const [airfoil] = await db.select().from(airfoils).where(eq(airfoils.slug, airfoilSlug)).limit(1);
  const [revision] = await db.select().from(simulationPresetRevisions).where(eq(simulationPresetRevisions.signatureHash, signatureHash)).limit(1);
  if (!airfoil || !revision) {
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "polars",
        naturalKey: `${airfoilSlug}:${signatureHash}:${aoaDeg}`,
        incomingPayload: data,
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  const snapshot = jsonObject(revision.snapshot);
  const bcId = nullableText(jsonObject(snapshot.preset).legacyBoundaryConditionId ?? data.bcId ?? data.bc_id);
  if (!bcId) {
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "polars",
        naturalKey: `${airfoil.id}:${revision.id}:${aoaDeg}`,
        incomingPayload: data,
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  const status = ["pending", "queued", "running", "done", "failed", "stale"].includes(String(data.status)) ? String(data.status) : "done";
  const regime: "rans" | "urans" | null = data.regime === "urans" || data.regime === "rans" ? data.regime : null;
  const values = {
    airfoilId: airfoil.id,
    bcId,
    simulationPresetRevisionId: revision.id,
    aoaDeg,
    status: status as "pending" | "queued" | "running" | "done" | "failed" | "stale",
    source: status === "done" || data.source === "solved" ? ("solved" as const) : ("queued" as const),
    regime,
    reynolds: nullableNumber(data.reynolds) ? Math.round(Number(data.reynolds)) : null,
    speed: nullableNumber(data.speed),
    chord: nullableNumber(data.chord),
    mach: nullableNumber(data.mach),
    cl: nullableNumber(data.cl),
    cd: nullableNumber(data.cd),
    cm: nullableNumber(data.cm),
    clCd: nullableNumber(data.clCd ?? data.cl_cd),
    clStd: nullableNumber(data.clStd ?? data.cl_std),
    cdStd: nullableNumber(data.cdStd ?? data.cd_std),
    cmStd: nullableNumber(data.cmStd ?? data.cm_std),
    stalled: Boolean(data.stalled),
    unsteady: Boolean(data.unsteady),
    converged: Boolean(data.converged),
    finalResidual: nullableNumber(data.finalResidual ?? data.final_residual),
    iterations: nullableNumber(data.iterations),
    yPlusAvg: nullableNumber(data.yPlusAvg ?? data.y_plus_avg),
    yPlusMax: nullableNumber(data.yPlusMax ?? data.y_plus_max),
    nCells: nullableNumber(data.nCells ?? data.n_cells),
    firstOrderFallback: Boolean(data.firstOrderFallback ?? data.first_order_fallback),
    strouhal: nullableNumber(data.strouhal),
    error: nullableText(data.error),
    engineJobId: `sync:${source.sourceInstanceId ?? "upstream"}:${remoteResultId}`,
    engineCaseSlug: nullableText(data.engineCaseSlug ?? data.engine_case_slug),
    solvedAt: status === "done" ? new Date() : null,
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(results)
    .values(values)
    .onConflictDoUpdate({
      target: [results.airfoilId, results.simulationPresetRevisionId, results.aoaDeg],
      set: values,
    })
    .returning({ id: results.id });
  await refreshPolarCacheForRevision(db, airfoil.id, revision.id);
  return { imported: true, resultId: row.id };
}

async function upsertRemoteAssetReference(opts: {
  localKind: string;
  localRowId?: string | null;
  localStorageKey: string;
  resultId?: string | null;
  resultAttemptId?: string | null;
  sourceInstanceId?: string | null;
  sourceInstanceName?: string | null;
  remoteResultId?: string | null;
  remoteArtifactId?: string | null;
  remoteMediaId?: string | null;
  remoteCacheId?: string | null;
  remoteDownloadUrl: string;
  remoteRenderUrl?: string | null;
  sha256?: string | null;
  byteSize?: number | null;
  mimeType: string;
  availability: "remote_only" | "cached" | "missing" | "failed";
  cachedStorageKey?: string | null;
  metadata?: Record<string, unknown>;
}) {
  await db
    .insert(remoteAssetReferences)
    .values(opts)
    .onConflictDoUpdate({
      target: remoteAssetReferences.localStorageKey,
      set: {
        localRowId: opts.localRowId ?? null,
        resultId: opts.resultId ?? null,
        resultAttemptId: opts.resultAttemptId ?? null,
        remoteDownloadUrl: opts.remoteDownloadUrl,
        remoteRenderUrl: opts.remoteRenderUrl ?? null,
        sha256: opts.sha256 ?? null,
        byteSize: opts.byteSize ?? null,
        mimeType: opts.mimeType,
        availability: opts.availability,
        cachedStorageKey: opts.cachedStorageKey ?? null,
        metadata: opts.metadata ?? {},
        updatedAt: new Date(),
      },
    });
}

async function importRemoteMediaReference(
  data: Record<string, unknown>,
  settings: typeof syncApiSettings.$inferSelect,
  mode: "full" | "db_only_remote_assets",
  source: { sourceInstanceId?: string | null; sourceInstanceName?: string | null },
): Promise<{ imported: boolean; conflictId?: string }> {
  const remoteMediaId = nullableText(data.remoteMediaId ?? data.id);
  const remoteResultId = nullableText(data.remoteResultId ?? data.resultId ?? data.result_id);
  const result = await localResultForRemote(source.sourceInstanceId, remoteResultId);
  if (!remoteMediaId || !remoteResultId || !result) {
    return { imported: false, conflictId: await createConflict({ dataType: "result_media", naturalKey: remoteMediaId ?? stableHash(data).slice(0, 24), incomingPayload: data, sourceInstanceId: source.sourceInstanceId, sourceInstanceName: source.sourceInstanceName }) };
  }
  const mimeType = nullableText(data.mimeType ?? data.mime_type) ?? "application/octet-stream";
  const remoteDownloadUrl = resolveRemoteDownloadUrl(settings, data.downloadUrl);
  const baseKey = `sync/${source.sourceInstanceId ?? "upstream"}/media/${remoteMediaId}${extFromMime(mimeType)}`;
  const localStorageKey = mode === "full" ? baseKey : `remote/${source.sourceInstanceId ?? "upstream"}/media/${remoteMediaId}`;
  const expectedSha = nullableText(data.sha256);
  const expectedSize = nullableNumber(data.byteSize ?? data.byte_size);
  const downloaded = mode === "full"
    ? await downloadRemoteAsset({ settings, downloadUrl: remoteDownloadUrl, storageKey: baseKey, expectedSha256: expectedSha, expectedByteSize: expectedSize })
    : null;
  const [media] = await db
    .insert(resultMedia)
    .values({
      resultId: result.id,
      kind: data.kind === "video" ? "video" : "image",
      field: nullableText(data.field),
      role: data.role === "mean" || data.role === "history" ? data.role : "instantaneous",
      storageKey: localStorageKey,
      mimeType,
      width: nullableNumber(data.width),
      height: nullableNumber(data.height),
      frameCount: nullableNumber(data.frameCount ?? data.frame_count),
      durationS: nullableNumber(data.durationS ?? data.duration_s),
      colorScaleId: null,
      colorScaleVersion: nullableNumber(data.colorScaleVersion ?? data.color_scale_version),
      scaleVmin: nullableNumber(data.scaleVmin ?? data.scale_vmin),
      scaleVmax: nullableNumber(data.scaleVmax ?? data.scale_vmax),
      scalePolicy: nullableText(data.scalePolicy ?? data.scale_policy),
      renderProfileKey: nullableText(data.renderProfileKey ?? data.render_profile_key) ?? "default:v1:zoom2",
      engineUrl: remoteDownloadUrl,
    })
    .onConflictDoUpdate({
      target: [resultMedia.resultId, resultMedia.kind, resultMedia.field, resultMedia.role],
      set: { storageKey: localStorageKey, mimeType, engineUrl: remoteDownloadUrl },
    })
    .returning({ id: resultMedia.id });
  await upsertRemoteAssetReference({
    localKind: "result_media",
    localRowId: media.id,
    localStorageKey,
    resultId: result.id,
    sourceInstanceId: source.sourceInstanceId,
    sourceInstanceName: source.sourceInstanceName,
    remoteResultId,
    remoteMediaId,
    remoteDownloadUrl,
    sha256: downloaded?.sha256 ?? expectedSha,
    byteSize: downloaded?.byteSize ?? expectedSize,
    mimeType,
    availability: mode === "full" ? "cached" : "remote_only",
    cachedStorageKey: mode === "full" ? baseKey : null,
    metadata: { source: "upstream-sync" },
  });
  return { imported: true };
}

async function importRemoteEvidenceReference(
  data: Record<string, unknown>,
  settings: typeof syncApiSettings.$inferSelect,
  mode: "full" | "db_only_remote_assets",
  source: { sourceInstanceId?: string | null; sourceInstanceName?: string | null },
): Promise<{ imported: boolean; conflictId?: string }> {
  const remoteArtifactId = nullableText(data.remoteArtifactId ?? data.id);
  const remoteResultId = nullableText(data.remoteResultId ?? data.resultId ?? data.result_id);
  const result = await localResultForRemote(source.sourceInstanceId, remoteResultId);
  if (!remoteArtifactId || !remoteResultId || !result) {
    return { imported: false, conflictId: await createConflict({ dataType: "evidence_artifacts", naturalKey: remoteArtifactId ?? stableHash(data).slice(0, 24), incomingPayload: data, sourceInstanceId: source.sourceInstanceId, sourceInstanceName: source.sourceInstanceName }) };
  }
  const mimeType = nullableText(data.mimeType ?? data.mime_type) ?? "application/octet-stream";
  const remoteDownloadUrl = resolveRemoteDownloadUrl(settings, data.downloadUrl);
  const baseKey = `sync/${source.sourceInstanceId ?? "upstream"}/evidence/${remoteArtifactId}${extFromMime(mimeType)}`;
  const localStorageKey = mode === "full" ? baseKey : `remote/${source.sourceInstanceId ?? "upstream"}/evidence/${remoteArtifactId}`;
  const expectedSha = nullableText(data.sha256);
  const expectedSize = nullableNumber(data.byteSize ?? data.byte_size);
  const downloaded = mode === "full"
    ? await downloadRemoteAsset({ settings, downloadUrl: remoteDownloadUrl, storageKey: baseKey, expectedSha256: expectedSha, expectedByteSize: expectedSize })
    : null;
  const sha256 = downloaded?.sha256 ?? expectedSha ?? stableHash({ remoteArtifactId, remoteDownloadUrl });
  const byteSize = downloaded?.byteSize ?? expectedSize ?? 0;
  const [artifact] = await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: result.id,
      airfoilId: result.airfoilId,
      engineJobId: result.engineJobId,
      engineCaseSlug: result.engineCaseSlug,
      aoaDeg: result.aoaDeg,
      kind: data.kind === "manifest" || data.kind === "openfoam_bundle" || data.kind === "vtk_window" || data.kind === "time_directory" || data.kind === "log" || data.kind === "force_coefficients" || data.kind === "mesh" || data.kind === "dictionary" || data.kind === "field_data" ? data.kind : "field_data",
      field: nullableText(data.field),
      role: nullableText(data.role),
      storageKey: localStorageKey,
      mimeType,
      sha256,
      byteSize,
      engineUrl: remoteDownloadUrl,
      metadata: { ...jsonObject(data.metadata), source: "upstream-sync", remoteArtifactId },
    })
    .onConflictDoNothing()
    .returning({ id: solverEvidenceArtifacts.id });
  const artifactId = artifact?.id ?? (await db.select({ id: solverEvidenceArtifacts.id }).from(solverEvidenceArtifacts).where(and(eq(solverEvidenceArtifacts.storageKey, localStorageKey), eq(solverEvidenceArtifacts.sha256, sha256))).limit(1))[0]?.id ?? null;
  await upsertRemoteAssetReference({
    localKind: "evidence_artifact",
    localRowId: artifactId,
    localStorageKey,
    resultId: result.id,
    sourceInstanceId: source.sourceInstanceId,
    sourceInstanceName: source.sourceInstanceName,
    remoteResultId,
    remoteArtifactId,
    remoteDownloadUrl,
    sha256,
    byteSize,
    mimeType,
    availability: mode === "full" ? "cached" : "remote_only",
    cachedStorageKey: mode === "full" ? baseKey : null,
    metadata: { source: "upstream-sync" },
  });
  return { imported: true };
}

async function runUpstreamSync(modeOverride?: "full" | "db_only_remote_assets", typesOverride?: SyncDataType[], limit = 200) {
  const { settings } = await getSettings();
  if (!settings.upstreamBaseUrl) throw new Error("up-tier API endpoint is not configured");
  const mode = modeOverride ?? settings.syncMode;
  const statusRes = await fetch(`${upstreamBase(settings)}/status`, { headers: remoteHeaders(settings) });
  if (!statusRes.ok) throw new Error(`up-tier status failed (${statusRes.status})`);
  const status = (await statusRes.json()) as { instanceId?: string; instanceName?: string };
  const source = { sourceInstanceId: status.instanceId ?? "upstream", sourceInstanceName: status.instanceName ?? "Up-tier instance" };
  const types = typesOverride ?? ["catalog_metadata", "mediums", "airfoils", "simulation_setup", "polars", "evidence_artifacts", "result_media"];
  let imported = 0;
  const conflictIds: string[] = [];
  for (const type of types) {
    let cursor = 0;
    for (;;) {
      const url = `${upstreamBase(settings)}/export?types=${encodeURIComponent(type)}&cursor=${cursor}&limit=${limit}&assetMode=${mode === "full" ? "full" : "remote_refs"}`;
      const res = await fetch(url, { headers: remoteHeaders(settings) });
      if (!res.ok) throw new Error(`up-tier export ${type} failed (${res.status})`);
      const payload = (await res.json()) as { items?: { type: SyncDataType; data: Record<string, unknown> }[]; nextCursor?: number | null };
      for (const item of payload.items ?? []) {
        if (item.type === "catalog_metadata") {
          if (item.data.kind === "category" && (await importCategory(item.data))) imported++;
          else if (item.data.kind === "hashtag" && (await importHashtag(item.data))) imported++;
        } else if (item.type === "mediums") {
          const result = await importMedium(item.data, source);
          if (result.imported) imported++;
          if (result.conflictId) conflictIds.push(result.conflictId);
        } else if (item.type === "airfoils") {
          const result = await importAirfoil(item.data, source);
          if (result.imported) imported++;
          if (result.conflictId) conflictIds.push(result.conflictId);
        } else if (item.type === "simulation_setup") {
          const result = await importSimulationSetupRevision(item.data, source);
          if (result.imported) imported++;
          if (result.conflictId) conflictIds.push(result.conflictId);
        } else if (item.type === "polars") {
          const result = await importExportedResult(item.data, source);
          if (result.imported) imported++;
          if (result.conflictId) conflictIds.push(result.conflictId);
        } else if (item.type === "result_media") {
          const result = await importRemoteMediaReference(item.data, settings, mode, source);
          if (result.imported) imported++;
          if (result.conflictId) conflictIds.push(result.conflictId);
        } else if (item.type === "evidence_artifacts") {
          const result = await importRemoteEvidenceReference(item.data, settings, mode, source);
          if (result.imported) imported++;
          if (result.conflictId) conflictIds.push(result.conflictId);
        }
      }
      if (payload.nextCursor == null) break;
      cursor = payload.nextCursor;
    }
  }
  await db
    .update(syncApiSettings)
    .set({ remoteSolverLastSyncAt: new Date(), remoteSolverLastStatus: "idle", remoteSolverLastError: null, updatedAt: new Date() })
    .where(eq(syncApiSettings.id, 1));
  return { imported, conflicts: conflictIds, mode, sourceInstanceId: source.sourceInstanceId };
}

export async function registerSyncRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/sync/v1/status", async (req, reply) => {
    const ctx = await requireSync(req, reply);
    if (!ctx) return;
    return {
      ok: true,
      instanceId: ctx.settings.instanceId,
      instanceName: ctx.settings.instanceName,
      endpoint: publicEndpoint(req, ctx.settings.publicEndpointOverride),
      defaultPromiseTtlHours: ctx.settings.defaultPromiseTtlHours,
      permissions: permissionSummary(ctx.permissions),
    };
  });

  app.post("/api/sync/v1/solvers/register", async (req, reply) => {
    const ctx = await requireSync(req, reply, "sweeps", "fetch");
    if (!ctx) return;
    const body = solverRegisterSchema.parse(req.body ?? {});
    const values = {
      instanceId: body.instanceId,
      instanceName: body.instanceName,
      publicEndpoint: body.publicEndpoint ?? null,
      localEndpoint: body.localEndpoint ?? null,
      cpuCapacity: body.cpuCapacity,
      cpuBudget: body.cpuBudget,
      buildVersion: body.buildVersion ?? null,
      status: "idle" as const,
      lastHeartbeatAt: new Date(),
      recentError: null,
      metadata: body.metadata ?? {},
      updatedAt: new Date(),
    };
    const [solver] = await db
      .insert(registeredRemoteSolvers)
      .values(values)
      .onConflictDoUpdate({
        target: registeredRemoteSolvers.instanceId,
        set: values,
      })
      .returning();
    return {
      solver: {
        id: solver.id,
        instanceId: solver.instanceId,
        instanceName: solver.instanceName,
        cpuBudget: solver.cpuBudget,
        status: solver.status,
      },
    };
  });

  app.post("/api/sync/v1/solvers/:id/heartbeat", async (req, reply) => {
    const ctx = await requireSync(req, reply, "sweeps", "fetch");
    if (!ctx) return;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = solverHeartbeatSchema.parse(req.body ?? {});
    const update: Partial<typeof registeredRemoteSolvers.$inferInsert> = {
      status: body.status,
      lastHeartbeatAt: new Date(),
      activePromiseCount: body.activePromiseCount,
      activeAoaCount: body.activeAoaCount,
      recentError: body.recentError ?? null,
      updatedAt: new Date(),
    };
    if (body.instanceName) update.instanceName = body.instanceName;
    if (body.publicEndpoint !== undefined) update.publicEndpoint = body.publicEndpoint ?? null;
    if (body.localEndpoint !== undefined) update.localEndpoint = body.localEndpoint ?? null;
    if (body.cpuCapacity !== undefined) update.cpuCapacity = body.cpuCapacity;
    if (body.cpuBudget !== undefined) update.cpuBudget = body.cpuBudget;
    if (body.buildVersion !== undefined) update.buildVersion = body.buildVersion ?? null;
    if (body.solvedCount !== undefined) update.solvedCount = body.solvedCount;
    if (body.pushedCount !== undefined) update.pushedCount = body.pushedCount;
    if (body.metadata !== undefined) update.metadata = body.metadata;
    const [solver] = await db.update(registeredRemoteSolvers).set(update).where(eq(registeredRemoteSolvers.id, params.id)).returning();
    if (!solver) return reply.code(404).send({ error: "registered solver not found" });
    return { ok: true, solver };
  });

  app.post("/api/sync/v1/solvers/:id/progress", async (req, reply) => {
    const ctx = await requireSync(req, reply, "sweeps", "fetch");
    if (!ctx) return;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = solverProgressSchema.parse(req.body ?? {});
    const [existing] = await db.select().from(registeredRemoteSolvers).where(eq(registeredRemoteSolvers.id, params.id)).limit(1);
    if (!existing) return reply.code(404).send({ error: "registered solver not found" });
    const update: Partial<typeof registeredRemoteSolvers.$inferInsert> = {
      lastHeartbeatAt: new Date(),
      solvedCount: existing.solvedCount + body.solvedCountDelta,
      pushedCount: existing.pushedCount + body.pushedCountDelta,
      recentError: body.recentError ?? existing.recentError,
      updatedAt: new Date(),
    };
    if (body.status) update.status = body.status;
    if (body.activePromiseCount !== undefined) update.activePromiseCount = body.activePromiseCount;
    if (body.activeAoaCount !== undefined) update.activeAoaCount = body.activeAoaCount;
    if (body.metadata !== undefined) update.metadata = body.metadata;
    const [solver] = await db.update(registeredRemoteSolvers).set(update).where(eq(registeredRemoteSolvers.id, params.id)).returning();
    return { ok: true, solver };
  });

  app.post("/api/sync/v1/sweeps/claim", async (req, reply) => {
    const ctx = await requireSync(req, reply, "sweeps", "fetch");
    if (!ctx) return;
    const body = claimBodySchema.parse(req.body ?? {});
    let registeredSolver: typeof registeredRemoteSolvers.$inferSelect | null = null;
    if (body.solverId) {
      [registeredSolver] = await db.select().from(registeredRemoteSolvers).where(eq(registeredRemoteSolvers.id, body.solverId)).limit(1);
      if (!registeredSolver) return reply.code(404).send({ error: "registered solver not found" });
    }
    await ensureEnabledSimulationPresetRevisions(db);
    await expirePromises();
    const ttlHours = body.ttlHours ?? ctx.settings.defaultPromiseTtlHours;
    const expiresAt = new Date(Date.now() + ttlHours * 3600_000);
    const rows = (await db.execute(sql`
      WITH latest_revision AS (
        SELECT DISTINCT ON (preset_id) preset_id, id, signature_hash, reynolds, mach, reference_length_m, snapshot
        FROM simulation_preset_revisions
        ORDER BY preset_id, revision_number DESC
      ),
      gap_rows AS (
        SELECT
          a.id AS airfoil_id,
          a.slug AS airfoil_slug,
          a.name AS airfoil_name,
          a.source AS airfoil_source,
          a.point_format AS point_format,
          a.points AS points,
          p.id AS preset_id,
          p.legacy_boundary_condition_id AS bc_id,
          rev.id AS revision_id,
          rev.signature_hash,
          rev.reynolds,
          rev.mach,
          rev.reference_length_m,
          rev.snapshot,
          g.aoa::float8 AS aoa_deg,
          COALESCE(r.priority, 0)::int AS priority
        FROM airfoils a
        CROSS JOIN simulation_presets p
        JOIN latest_revision rev ON rev.preset_id = p.id
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
      )
      SELECT *
      FROM gap_rows
      ORDER BY priority DESC, reynolds ASC, airfoil_slug ASC, aoa_deg ASC
      LIMIT ${Math.max(body.limit * 3, body.limit)}
    `)) as unknown as {
      airfoil_id: string;
      airfoil_slug: string;
      airfoil_name: string;
      airfoil_source: string;
      point_format: string;
      points: unknown[];
      preset_id: string;
      bc_id: string;
      revision_id: string;
      signature_hash: string;
      reynolds: number;
      mach: number | null;
      reference_length_m: number;
      snapshot: Record<string, unknown>;
      aoa_deg: number;
    }[];
    const first = rows[0];
    if (!first) return { promise: null };
    const aoas = rows
      .filter((row) => row.airfoil_id === first.airfoil_id && row.revision_id === first.revision_id)
      .slice(0, body.limit)
      .map((row) => Number(row.aoa_deg))
      .sort((a, b) => a - b);
    const [promise] = await db
      .insert(syncSweepPromises)
      .values({
        sourceInstanceId: registeredSolver?.instanceId ?? body.sourceInstanceId ?? null,
        sourceInstanceName: registeredSolver?.instanceName ?? body.sourceInstanceName ?? null,
        sourceBaseUrl: registeredSolver?.publicEndpoint ?? body.sourceBaseUrl ?? null,
        airfoilId: first.airfoil_id,
        simulationPresetRevisionId: first.revision_id,
        aoaCount: aoas.length,
        expiresAt,
        requestPayload: { limit: body.limit, ttlHours, solverId: registeredSolver?.id ?? null, sourceBaseUrl: registeredSolver?.publicEndpoint ?? body.sourceBaseUrl ?? null },
      })
      .returning();
    const pointRows = await db
      .insert(syncSweepPromisePoints)
      .values(aoas.map((aoaDeg) => ({ promiseId: promise.id, airfoilId: first.airfoil_id, simulationPresetRevisionId: first.revision_id, aoaDeg })))
      .onConflictDoNothing()
      .returning({ aoaDeg: syncSweepPromisePoints.aoaDeg });
    if (!pointRows.length) {
      await db.update(syncSweepPromises).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(syncSweepPromises.id, promise.id));
      return { promise: null };
    }
    const promisedAoas = pointRows.map((row) => Number(row.aoaDeg)).sort((a, b) => a - b);
    await db.update(syncSweepPromises).set({ aoaCount: promisedAoas.length }).where(eq(syncSweepPromises.id, promise.id));
    if (registeredSolver) {
      const [active] = await db
        .select({ promises: count(), aoas: sql<number>`COALESCE(SUM(${syncSweepPromises.aoaCount}), 0)::int` })
        .from(syncSweepPromises)
        .where(and(eq(syncSweepPromises.sourceInstanceId, registeredSolver.instanceId), eq(syncSweepPromises.status, "active")));
      await db
        .update(registeredRemoteSolvers)
        .set({
          status: "claiming",
          lastHeartbeatAt: new Date(),
          activePromiseCount: Number(active?.promises ?? 1),
          activeAoaCount: Number(active?.aoas ?? promisedAoas.length),
          updatedAt: new Date(),
        })
        .where(eq(registeredRemoteSolvers.id, registeredSolver.id));
    }
    return {
      promise: {
        id: promise.id,
        expiresAt: expiresAt.toISOString(),
        ttlHours,
        airfoil: {
          id: first.airfoil_id,
          slug: first.airfoil_slug,
          name: first.airfoil_name,
          source: first.airfoil_source,
          pointFormat: first.point_format,
          points: first.points,
        },
        setupRevision: {
          id: first.revision_id,
          presetId: first.preset_id,
          legacyBoundaryConditionId: first.bc_id,
          signatureHash: first.signature_hash,
          reynolds: Number(first.reynolds),
          mach: first.mach == null ? null : Number(first.mach),
          referenceLengthM: Number(first.reference_length_m),
          snapshot: first.snapshot,
        },
        aoas: promisedAoas,
      },
    };
  });

  app.post("/api/sync/v1/sweeps/:promiseId/heartbeat", async (req, reply) => {
    const ctx = await requireSync(req, reply, "sweeps", "fetch");
    if (!ctx) return;
    const params = z.object({ promiseId: z.string().uuid() }).parse(req.params);
    const body = heartbeatBodySchema.parse(req.body ?? {});
    const expiresAt = new Date(Date.now() + (body.ttlHours ?? ctx.settings.defaultPromiseTtlHours) * 3600_000);
    const [row] = await db
      .update(syncSweepPromises)
      .set({ expiresAt, lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(and(eq(syncSweepPromises.id, params.promiseId), eq(syncSweepPromises.status, "active")))
      .returning();
    if (!row) return reply.code(404).send({ error: "active promise not found" });
    return { ok: true, expiresAt: expiresAt.toISOString() };
  });

  app.post("/api/sync/v1/sweeps/:promiseId/cancel", async (req, reply) => {
    const ctx = await requireSync(req, reply, "sweeps", "fetch");
    if (!ctx) return;
    const params = z.object({ promiseId: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .update(syncSweepPromises)
      .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(syncSweepPromises.id, params.promiseId))
      .returning();
    if (!row) return reply.code(404).send({ error: "promise not found" });
    await db.update(syncSweepPromisePoints).set({ status: "cancelled", updatedAt: new Date() }).where(eq(syncSweepPromisePoints.promiseId, params.promiseId));
    return { ok: true };
  });

  app.post("/api/sync/v1/sweeps/:promiseId/complete", async (req, reply) => {
    const ctx = await requireSync(req, reply, "sweeps", "fetch");
    if (!ctx) return;
    const params = z.object({ promiseId: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .update(syncSweepPromises)
      .set({ status: "fulfilled", fulfilledAt: new Date(), updatedAt: new Date(), responsePayload: jsonObject(req.body) })
      .where(eq(syncSweepPromises.id, params.promiseId))
      .returning();
    if (!row) return reply.code(404).send({ error: "promise not found" });
    await db.update(syncSweepPromisePoints).set({ status: "fulfilled", updatedAt: new Date() }).where(eq(syncSweepPromisePoints.promiseId, params.promiseId));
    return { ok: true };
  });

  app.get("/api/sync/v1/export", async (req, reply) => {
    const query = exportQuerySchema.parse(req.query);
    const types = (query.types ? query.types.split(",") : SYNC_DATA_TYPES).map((x) => x.trim()).filter(Boolean) as SyncDataType[];
    for (const type of types) {
      if (!SYNC_DATA_TYPES.includes(type)) return reply.code(400).send({ error: `unknown type ${type}` });
      const ctx = await requireSync(req, reply, type, "fetch");
      if (!ctx) return;
    }
    const since = query.since ? new Date(query.since) : null;
    const items: { type: SyncDataType; data: unknown }[] = [];
    for (const type of types) {
      if (items.length >= query.limit) break;
      const remaining = query.limit - items.length;
      if (type === "airfoils") {
        const rows = await db
          .select()
          .from(airfoils)
          .where(since ? gte(airfoils.updatedAt, since) : undefined)
          .orderBy(asc(airfoils.slug))
          .limit(remaining)
          .offset(query.cursor);
        items.push(...rows.map((row) => exportRow(type, row)));
      } else if (type === "catalog_metadata") {
        const cats = await db.select().from(categories).orderBy(asc(categories.path)).limit(remaining).offset(query.cursor);
        items.push(...cats.map((row) => exportRow(type, { kind: "category", ...row })));
        if (items.length < query.limit) {
          const tags = await db.select().from(hashtags).orderBy(asc(hashtags.slug)).limit(query.limit - items.length).offset(query.cursor);
          items.push(...tags.map((row) => exportRow(type, { kind: "hashtag", ...row })));
        }
      } else if (type === "mediums") {
        const rows = await db
          .select()
          .from(mediums)
          .where(since ? gte(mediums.updatedAt, since) : undefined)
          .orderBy(asc(mediums.slug))
          .limit(remaining)
          .offset(query.cursor);
        const pointRows = rows.length
          ? await db.select().from(mediumViscosityTablePoints).where(inArray(mediumViscosityTablePoints.mediumId, rows.map((r) => r.id)))
          : [];
        items.push(...rows.map((row) => exportRow(type, { ...row, viscosityTable: pointRows.filter((p) => p.mediumId === row.id) })));
      } else if (type === "simulation_setup") {
        const revisions = await db.select().from(simulationPresetRevisions).orderBy(desc(simulationPresetRevisions.createdAt)).limit(remaining).offset(query.cursor);
        items.push(...revisions.map((row) => exportRow(type, { kind: "simulation_preset_revision", ...row })));
      } else if (type === "polars") {
        const rows = await db
          .select()
          .from(results)
          .where(since ? gte(results.updatedAt, since) : undefined)
          .orderBy(desc(results.updatedAt))
          .limit(remaining)
          .offset(query.cursor);
        const airfoilRows = rows.length
          ? await db.select({ id: airfoils.id, slug: airfoils.slug }).from(airfoils).where(inArray(airfoils.id, rows.map((r) => r.airfoilId)))
          : [];
        const revisionRows = rows.some((row) => row.simulationPresetRevisionId)
          ? await db
              .select({ id: simulationPresetRevisions.id, signatureHash: simulationPresetRevisions.signatureHash })
              .from(simulationPresetRevisions)
              .where(inArray(simulationPresetRevisions.id, rows.map((r) => r.simulationPresetRevisionId).filter(Boolean) as string[]))
          : [];
        const airfoilSlugById = new Map(airfoilRows.map((row) => [row.id, row.slug]));
        const revisionSignatureById = new Map(revisionRows.map((row) => [row.id, row.signatureHash]));
        items.push(
          ...rows.map((row) =>
            exportRow(type, {
              ...row,
              remoteResultId: row.id,
              airfoilSlug: airfoilSlugById.get(row.airfoilId) ?? null,
              simulationPresetSignatureHash: row.simulationPresetRevisionId ? revisionSignatureById.get(row.simulationPresetRevisionId) ?? null : null,
            }),
          ),
        );
      } else if (type === "evidence_artifacts") {
        const rows = await db.select().from(solverEvidenceArtifacts).orderBy(desc(solverEvidenceArtifacts.createdAt)).limit(remaining).offset(query.cursor);
        items.push(...rows.map((row) => exportRow(type, { ...row, remoteArtifactId: row.id, remoteResultId: row.resultId, downloadUrl: `/api/sync/v1/artifacts/${row.id}/download` })));
      } else if (type === "result_media") {
        const rows = await db.select().from(resultMedia).orderBy(desc(resultMedia.createdAt)).limit(remaining).offset(query.cursor);
        items.push(...rows.map((row) => exportRow(type, { ...row, remoteMediaId: row.id, remoteResultId: row.resultId, downloadUrl: `/api/sync/v1/media/${row.id}/download` })));
      }
    }
    return { items, nextCursor: items.length === query.limit ? query.cursor + items.length : null };
  });

  app.post("/api/sync/v1/import", async (req, reply) => {
    const body = importBodySchema.parse(req.body ?? {});
    for (const item of body.items) {
      const ctx = await requireSync(req, reply, item.type, "push");
      if (!ctx) return;
    }
    let imported = 0;
    const conflictIds: string[] = [];
    for (const item of body.items) {
      if (item.type === "mediums") {
        const result = await importMedium(item.data, body);
        if (result.imported) imported++;
        if (result.conflictId) conflictIds.push(result.conflictId);
      } else if (item.type === "catalog_metadata") {
        if (item.data.kind === "category" && (await importCategory(item.data))) imported++;
        else if (item.data.kind === "hashtag" && (await importHashtag(item.data))) imported++;
      } else if (item.type === "airfoils") {
        const result = await importAirfoil(item.data, body);
        if (result.imported) imported++;
        if (result.conflictId) conflictIds.push(result.conflictId);
      } else if (item.type === "simulation_setup") {
        const result = await importSimulationSetupRevision(item.data, body);
        if (result.imported) imported++;
        if (result.conflictId) conflictIds.push(result.conflictId);
      } else {
        conflictIds.push(
          await createConflict({
            dataType: item.type,
            naturalKey: item.naturalKey ?? stableHash(item.data).slice(0, 24),
            incomingPayload: item.data,
            sourceInstanceId: body.sourceInstanceId,
            sourceInstanceName: body.sourceInstanceName,
          }),
        );
      }
    }
    return { imported, conflicts: conflictIds };
  });

  // Remote solvers push results with media + evidence bundles inline as
  // base64 (a single URANS point can carry tens of MB); Fastify's default
  // 1 MiB bodyLimit rejected the very first real push with 413 (validation
  // incident 2026-07-11). Scoped here — public routes keep the default.
  app.post("/api/sync/v1/polars", { bodyLimit: SYNC_POLAR_PUSH_BODY_LIMIT_BYTES }, async (req, reply) => {
    const ctx = await requireSync(req, reply, "polars", "push");
    if (!ctx) return;
    const { payload, files } = await parsePolarRequest(req);
    const needsArtifacts = payload.results.some((row) => row.evidenceArtifacts.length > 0);
    const needsMedia = payload.results.some((row) => row.media.length > 0);
    if (needsArtifacts && !(ctx.permissions.find((p) => p.dataType === "evidence_artifacts")?.canPush ?? false)) {
      return reply.code(403).send({ error: "push disabled for evidence_artifacts" });
    }
    if (needsMedia && !(ctx.permissions.find((p) => p.dataType === "result_media")?.canPush ?? false)) {
      return reply.code(403).send({ error: "push disabled for result_media" });
    }
    const result = await importPolarPush(payload, files);
    return result;
  });

  app.get("/api/sync/v1/artifacts/:id/download", async (req, reply) => {
    const ctx = await requireSync(req, reply, "evidence_artifacts", "fetch");
    if (!ctx) return;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db.select().from(solverEvidenceArtifacts).where(eq(solverEvidenceArtifacts.id, params.id)).limit(1);
    if (!row) return reply.code(404).send({ error: "artifact not found" });
    const file = await mediaStore.stream(row.storageKey);
    reply.header("content-type", file.mime);
    reply.header("content-length", String(file.size));
    return reply.send(file.stream);
  });

  app.get("/api/sync/v1/media/:id/download", async (req, reply) => {
    const ctx = await requireSync(req, reply, "result_media", "fetch");
    if (!ctx) return;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db.select().from(resultMedia).where(eq(resultMedia.id, params.id)).limit(1);
    if (!row) return reply.code(404).send({ error: "media not found" });
    const file = await mediaStore.stream(row.storageKey);
    reply.header("content-type", file.mime);
    reply.header("content-length", String(file.size));
    return reply.send(file.stream);
  });

  app.post("/api/sync/v1/results/:resultId/render", async (req, reply) => {
    const ctx = await requireSync(req, reply, "result_media", "fetch");
    if (!ctx) return;
    const params = z.object({ resultId: z.string().uuid() }).parse(req.params);
    const proto = String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0].trim() || "http";
    const host = String(req.headers["x-forwarded-host"] ?? req.headers.host ?? `localhost:${env.port}`).split(",")[0].trim();
    const res = await fetch(`${proto}://${host}/api/results/${encodeURIComponent(params.resultId)}/render`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req.body ?? {}),
    });
    const text = await res.text();
    reply.code(res.status).header("content-type", res.headers.get("content-type") ?? "application/json");
    return reply.send(text);
  });

  app.get("/api/admin/sync", { preHandler: requireAdmin }, async (req) => syncAdminPayload(req));

  app.patch("/api/admin/sync", { preHandler: requireAdmin }, async (req, reply) => {
    const body = syncSettingsPatchSchema.parse(req.body ?? {});
    await ensureSyncRows();
    const settingsPatch: Partial<typeof syncApiSettings.$inferInsert> = {};
    if (body.enabled !== undefined) settingsPatch.enabled = body.enabled;
    if (body.instanceName !== undefined) settingsPatch.instanceName = body.instanceName;
    if (body.publicEndpointOverride !== undefined) settingsPatch.publicEndpointOverride = body.publicEndpointOverride || null;
    if (body.secret !== undefined) settingsPatch.secret = body.secret;
    if (body.defaultPromiseTtlHours !== undefined) settingsPatch.defaultPromiseTtlHours = body.defaultPromiseTtlHours;
    if (body.upstreamBaseUrl !== undefined) settingsPatch.upstreamBaseUrl = body.upstreamBaseUrl ? body.upstreamBaseUrl.replace(/\/+$/, "") : null;
    if (body.upstreamSecret !== undefined) settingsPatch.upstreamSecret = body.upstreamSecret;
    if (body.syncMode !== undefined) settingsPatch.syncMode = body.syncMode;
    if (body.remoteSolverEnabled !== undefined) settingsPatch.remoteSolverEnabled = body.remoteSolverEnabled;
    if (body.remoteSolverCpuBudget !== undefined) settingsPatch.remoteSolverCpuBudget = body.remoteSolverCpuBudget;
    if (body.remoteSolverClaimSize !== undefined) settingsPatch.remoteSolverClaimSize = body.remoteSolverClaimSize;
    if (body.remoteSolverHeartbeatIntervalSeconds !== undefined) {
      settingsPatch.remoteSolverHeartbeatIntervalSeconds = body.remoteSolverHeartbeatIntervalSeconds;
    }
    if (Object.keys(settingsPatch).length) {
      await db.update(syncApiSettings).set({ ...settingsPatch, updatedAt: new Date() }).where(eq(syncApiSettings.id, 1));
    }
    for (const permission of body.permissions ?? []) {
      await db
        .insert(syncApiPermissions)
        .values(permission)
        .onConflictDoUpdate({
          target: syncApiPermissions.dataType,
          set: { canFetch: permission.canFetch, canPush: permission.canPush, updatedAt: new Date() },
        });
    }
    return syncAdminPayload(req);
  });

  app.post("/api/admin/sync/upstream/run", { preHandler: requireAdmin }, async (req, reply) => {
    const body = upstreamSyncBodySchema.parse(req.body ?? {});
    try {
      await db
        .update(syncApiSettings)
        .set({ remoteSolverLastStatus: "syncing", remoteSolverLastError: null, updatedAt: new Date() })
        .where(eq(syncApiSettings.id, 1));
      const result = await runUpstreamSync(body.mode, body.types, body.limit);
      return { ...(await syncAdminPayload(req)), lastRun: result };
    } catch (e) {
      await db
        .update(syncApiSettings)
        .set({ remoteSolverLastStatus: "error", remoteSolverLastError: e instanceof Error ? e.message : String(e), updatedAt: new Date() })
        .where(eq(syncApiSettings.id, 1));
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e), ...(await syncAdminPayload(req)) });
    }
  });

  app.post("/api/admin/sync/conflicts/:id/archive", { preHandler: requireAdmin }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .update(syncImportConflicts)
      .set({ status: "archived", resolvedAt: new Date(), resolutionNote: "archived by admin", updatedAt: new Date() })
      .where(eq(syncImportConflicts.id, params.id))
      .returning();
    if (!row) return reply.code(404).send({ error: "conflict not found" });
    return syncAdminPayload(req);
  });

  app.post("/api/admin/sync/conflicts/:id/promote", { preHandler: requireAdmin }, async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [conflict] = await db.select().from(syncImportConflicts).where(eq(syncImportConflicts.id, params.id)).limit(1);
    if (!conflict || conflict.status !== "pending") return reply.code(404).send({ error: "pending conflict not found" });
    if (conflict.dataType === "mediums") {
      const slug = nullableText(conflict.incomingPayload.slug);
      if (!slug) return reply.code(400).send({ error: "medium conflict lacks slug" });
      await upsertMediumFromPayload(conflict.incomingPayload);
    } else if (conflict.dataType === "airfoils") {
      await upsertAirfoilFromPayload(conflict.incomingPayload);
    } else if (conflict.dataType === "polars") {
      await promotePolarConflict(conflict);
    } else {
      return reply.code(409).send({ error: `promotion is not implemented for ${conflict.dataType}; archive or resolve manually` });
    }
    await db
      .update(syncImportConflicts)
      .set({ status: "promoted", resolvedAt: new Date(), resolutionNote: "promoted by admin", updatedAt: new Date() })
      .where(eq(syncImportConflicts.id, conflict.id));
    return syncAdminPayload(req);
  });
}
