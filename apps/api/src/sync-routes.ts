import {
  airfoilHashtags,
  airfoils,
  acquireEvidenceArtifactKeyLock,
  acquireResultEvidenceLocks,
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
  onResultIngested,
  outputProfiles,
  parseEvidenceManifest,
  manifestMemberSetSha256,
  referenceGeometryProfiles,
  registerVerifiedBrokeredEvidenceArchive,
  registeredRemoteSolvers,
  remoteAssetReferences,
  resultAttempts,
  resultClassifications,
  resultFieldExtents,
  resultMedia,
  schedulingProfiles,
  results,
  simulationPresetAirfoilTargets,
  simulationPresetRevisions,
  simulationPresets,
  solverProfiles,
  solverImplementations,
  solverEvidenceArchives,
  solverEvidenceArtifacts,
  simCampaignPoints,
  simCampaigns,
  simUransVerifyQueue,
  simUransVerifyQueueCampaigns,
  SYNC_BLOB_LOCK_NAMESPACE,
  syncBlobLockStripe,
  syncApiPermissions,
  syncApiSettings,
  syncBrokeredEvidenceUploads,
  syncImportConflicts,
  syncRemotePromiseCancellations,
  syncRemoteResultDeliveries,
  syncUploadCapacityReservations,
  syncSweepPromisePoints,
  syncSweepPromises,
  sweepDefinitions,
  type DB,
  withEvidenceArtifactWriteLocks,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  METHOD_COMPATIBILITY_HASH_VERSION,
  enqueuePrecalcVerifications,
  hasExactVerifiedRestartableEvidenceArchive,
} from "@aerodb/db";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import { refreshPolarCacheForRevision } from "@aerodb/db/polar-cache";
import {
  ensureEnabledSimulationPresetRevisions,
  methodCompatibilityHashForSnapshot,
  physicsHashForSnapshot,
  simulationSetupSignature,
  type SimulationSetupSnapshot,
} from "@aerodb/db/simulation-setup";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, readFile, statfs, unlink } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { z } from "zod";

import { requireAdmin } from "./admin-auth";
import { advisoryLockSql, db } from "./db";
import {
  resolveEngineRuntimeBuild,
  type ResolvedEngineRuntime,
} from "./engine-provenance";
import { env } from "./env";
import { makeEngineClient } from "./engine-client";
import { mediaStore } from "./media-store";
import {
  fetchBoundBrokeredEvidenceArchive,
  requestBrokeredEvidenceUpload,
  revokeSolverEvidenceUploads,
  verifyBrokeredEvidenceUpload,
} from "./remote-evidence-broker";
import {
  SYNC_POLAR_MULTIPART_MAX_FIELDS,
  SYNC_POLAR_MULTIPART_MAX_FILES,
  SYNC_POLAR_MULTIPART_MAX_FILE_BYTES,
  SYNC_POLAR_MULTIPART_MAX_MANIFEST_BYTES,
  SYNC_POLAR_MULTIPART_MAX_PARTS,
  SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES,
  SYNC_POLAR_MULTIPART_MIN_FREE_BYTES,
  SYNC_POLAR_MULTIPART_MANIFEST_PARSER_BYTES,
} from "./sync-upload-limits";

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
  defaultPromiseTtlHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
  upstreamBaseUrl: z.string().trim().nullable().optional(),
  upstreamSecret: z.string().optional(),
  syncMode: z.enum(["full", "db_only_remote_assets"]).optional(),
  remoteSolverEnabled: z.boolean().optional(),
  remoteSolverCpuBudget: z.coerce.number().int().min(0).max(256).optional(),
  remoteSolverClaimSize: z.coerce.number().int().min(1).max(500).optional(),
  remoteSolverHeartbeatIntervalSeconds: z.coerce
    .number()
    .int()
    .min(5)
    .max(3600)
    .optional(),
  permissions: z.array(permissionPatchSchema).optional(),
});

const remoteSolverCredentialInstallSchema = z.object({
  registeredSolverId: z.string().uuid(),
  authToken: z.string().min(32).max(512),
});

const claimBodySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(36),
  ttlHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
  solverId: z.string().uuid().optional(),
  sourceInstanceId: z.string().trim().optional(),
  sourceInstanceName: z.string().trim().optional(),
  sourceBaseUrl: z.string().trim().optional(),
});

const heartbeatBodySchema = z.object({
  ttlHours: z.coerce
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .optional(),
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
  status: z
    .enum([
      "disabled",
      "idle",
      "syncing",
      "claiming",
      "solving",
      "pushing",
      "error",
      "offline",
    ])
    .default("idle"),
  activePromiseCount: z.coerce.number().int().min(0).default(0),
  activeAoaCount: z.coerce.number().int().min(0).default(0),
  solvedCount: z.coerce.number().int().min(0).optional(),
  pushedCount: z.coerce.number().int().min(0).optional(),
  recentError: z.string().nullable().optional(),
});

const brokeredEvidenceRequestSchema = z.object({
  idempotencyKey: z.string().uuid(),
  promiseId: z.string().uuid(),
  remoteResultId: z.string().uuid(),
  remoteResultAttemptId: z.string().uuid(),
  aoaDeg: z.number().finite(),
  engineJobId: z.string().trim().min(1).max(240),
  engineCaseSlug: z.string().trim().min(1).max(240).nullable().default(null),
  storedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  storedByteSize: z.number().int().positive(),
  tarSha256: z.string().regex(/^[0-9a-f]{64}$/),
  tarByteSize: z.number().int().positive(),
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
  manifestByteSize: z.number().int().positive(),
  zstdLevel: z.number().int().min(1).max(22),
  bundledFileCount: z.number().int().positive(),
});

const brokeredEvidenceVerifySchema = z.object({
  generation: z
    .string()
    .regex(/^[1-9][0-9]{0,19}$/)
    .refine(
      (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
      "generation exceeds GCS uint64",
    ),
});

const solverProgressSchema = z.object({
  status: z
    .enum([
      "disabled",
      "idle",
      "syncing",
      "claiming",
      "solving",
      "pushing",
      "error",
      "offline",
    ])
    .optional(),
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

const forceHistorySchema = z
  .object({
    t: z.array(z.number().finite()).min(2).max(400),
    cl: z.array(z.number().finite()).min(2).max(400),
    cd: z.array(z.number().finite()).min(2).max(400),
    cm: z.array(z.number().finite()).min(2).max(400).nullable().optional(),
    clMean: z.number().finite().nullable().optional(),
    clRms: z.number().finite().nullable().optional(),
    cdMean: z.number().finite().nullable().optional(),
    cdRms: z.number().finite().nullable().optional(),
    strouhal: z.number().finite().nullable().optional(),
    sheddingFreqHz: z.number().finite().nullable().optional(),
    sampleCount: z.number().int().nonnegative().nullable().optional(),
  })
  .superRefine((history, ctx) => {
    const n = history.t.length;
    if (
      history.cl.length !== n ||
      history.cd.length !== n ||
      (history.cm != null && history.cm.length !== n)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "force-history arrays must have equal lengths",
      });
    }
    for (let index = 1; index < n; index += 1) {
      if (!(history.t[index] > history.t[index - 1])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["t", index],
          message: "force-history time samples must be strictly increasing",
        });
        break;
      }
    }
  });

const syncEngineRuntimeSchema = z
  .object({
    family: z.string().trim().min(1),
    distribution: z.string().trim().min(1),
    version: z.string().trim().min(1),
    numericsRevision: z.string().trim().min(1),
    adapterContractVersion: z.coerce.number().int().positive(),
    buildId: z.string().trim().min(1),
    sourceRevision: z.string().trim().nullable().optional(),
    imageDigest: z.string().trim().nullable().optional(),
    applicationSourceSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .nullable()
      .optional(),
    packageSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .nullable()
      .optional(),
    binarySha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .nullable()
      .optional(),
    architecture: z.string().trim().nullable().optional(),
  })
  .transform((engine) => ({
    family: engine.family,
    distribution: engine.distribution,
    version: engine.version,
    numerics_revision: engine.numericsRevision,
    adapter_contract_version: engine.adapterContractVersion,
    build_id: engine.buildId,
    source_revision: engine.sourceRevision ?? null,
    image_digest: engine.imageDigest ?? null,
    application_source_sha256: engine.applicationSourceSha256 ?? null,
    package_sha256: engine.packageSha256 ?? null,
    binary_sha256: engine.binarySha256 ?? null,
    architecture: engine.architecture ?? null,
  }));

const polarPointSchema = z.object({
  aoaDeg: z.coerce.number(),
  status: z
    .enum(["pending", "queued", "running", "done", "failed", "stale"])
    .default("done"),
  source: z.enum(["queued", "solved"]).default("solved"),
  regime: z.enum(["rans", "urans"]).nullable().optional(),
  fidelity: z
    .enum(["rans", "urans_precalc", "urans_full"])
    .nullable()
    .optional(),
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
  qualityWarnings: z.array(z.string()).nullable().optional(),
  frameTrack: z.record(z.unknown()).nullable().optional(),
  steadyHistory: z.record(z.unknown()).nullable().optional(),
  methodKey: z.string().trim().min(1).nullable().optional(),
  engine: syncEngineRuntimeSchema.nullable().optional(),
  engineJobId: z.string().nullable().optional(),
  engineCaseSlug: z.string().nullable().optional(),
  remoteResultId: z.string().uuid().optional(),
  remoteResultAttemptId: z.string().uuid().optional(),
  evidencePayload: z.record(z.unknown()).optional(),
  forceHistory: forceHistorySchema.optional(),
  fieldExtents: z.array(z.record(z.unknown())).default([]),
  evidenceArtifacts: z.array(z.record(z.unknown())).default([]),
  media: z.array(z.record(z.unknown())).default([]),
});

const polarPushSchema = z
  .object({
    promiseId: z.string().uuid().optional(),
    sourceInstanceId: z.string().trim().optional(),
    sourceInstanceName: z.string().trim().optional(),
    airfoilSlug: z.string().trim().optional(),
    simulationPresetRevisionId: z.string().uuid().optional(),
    simulationPresetSignatureHash: z.string().trim().optional(),
    bcId: z.string().uuid().optional(),
    fieldColorScales: z.array(z.record(z.unknown())).default([]),
    results: z.array(polarPointSchema).min(1).max(500),
  })
  .superRefine((payload, ctx) => {
    const evidenceItemCount = payload.results.reduce(
      (sum, point) => sum + point.evidenceArtifacts.length + point.media.length,
      0,
    );
    if (evidenceItemCount > SYNC_POLAR_MULTIPART_MAX_FILES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["results"],
        message: `polar push contains more than ${SYNC_POLAR_MULTIPART_MAX_FILES} artifact/media items`,
      });
    }
    const extentAndScaleCount =
      payload.fieldColorScales.length +
      payload.results.reduce(
        (sum, point) => sum + point.fieldExtents.length,
        0,
      );
    if (extentAndScaleCount > SYNC_POLAR_MULTIPART_MAX_FILES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["fieldColorScales"],
        message: `polar push contains more than ${SYNC_POLAR_MULTIPART_MAX_FILES} field extents/color scales`,
      });
    }
  });

const conflictStatusBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});

type PolarPushPayload = z.infer<typeof polarPushSchema>;

class PolarPromiseScopeError extends Error {}
class PolarEvidenceBindingError extends Error {}

function syncIdentityToken(value: string, label: string): string {
  const token = value.trim();
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(token)) {
    throw new PolarPromiseScopeError(
      `${label} must be an unambiguous sync identity token`,
    );
  }
  return token;
}

interface UploadedFileRef {
  storageKey: string;
  mimeType: string;
  sha256: string;
  byteSize: number;
  tempFullPath?: string;
  newlyCommitted?: boolean;
  brokeredUploadId?: string;
}

class SyncMultipartUploadError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function stableHash(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, nested]) => [k, stable(nested)]),
      );
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(source[key])}`)
    .join(",")}}`;
}

const HUB_BINDING_RECEIPT_HMAC_DOMAIN =
  "xfoilfoam-hub-canonical-evidence-binding-v1\n";

function signHubBindingReceipt(
  receipt: HubBindingReceipt,
  solverToken: string,
): { receipt: HubBindingReceipt; receiptHmac: string } {
  return {
    receipt,
    receiptHmac: createHmac("sha256", solverToken)
      .update(HUB_BINDING_RECEIPT_HMAC_DOMAIN)
      .update(canonicalJson(receipt))
      .digest("hex"),
  };
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback
  );
}

async function ensureSyncRows(): Promise<void> {
  await db.insert(syncApiSettings).values({ id: 1 }).onConflictDoNothing();
  await db
    .insert(syncApiPermissions)
    .values(
      SYNC_DATA_TYPES.map((dataType) => ({
        dataType,
        canFetch: false,
        canPush: false,
      })),
    )
    .onConflictDoNothing();
}

async function getSettings() {
  await ensureSyncRows();
  const [settings] = await db
    .select()
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1))
    .limit(1);
  const permissions = await db
    .select()
    .from(syncApiPermissions)
    .orderBy(asc(syncApiPermissions.dataType));
  return { settings: settings!, permissions };
}

async function expirePromises(): Promise<void> {
  const expiredIds = await db
    .update(syncSweepPromises)
    .set({ status: "expired", expiredAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(syncSweepPromises.status, "active"),
        sql`${syncSweepPromises.expiresAt} <= now()`,
      ),
    )
    .returning({ id: syncSweepPromises.id });
  if (expiredIds.length) {
    await db
      .update(syncSweepPromisePoints)
      .set({ status: "expired", updatedAt: new Date() })
      .where(
        inArray(
          syncSweepPromisePoints.promiseId,
          expiredIds.map((row) => row.id),
        ),
      );
  }
}

function publicEndpoint(req: FastifyRequest, override: string | null): string {
  if (override?.trim()) return override.replace(/\/+$/, "") + "/api/sync/v1";
  const proto =
    String(req.headers["x-forwarded-proto"] ?? "http")
      .split(",")[0]
      .trim() || "http";
  const host = String(
    req.headers["x-forwarded-host"] ??
      req.headers.host ??
      `localhost:${env.port}`,
  )
    .split(",")[0]
    .trim();
  return `${proto}://${host}/api/sync/v1`;
}

function syncSecret(req: FastifyRequest): string | null {
  const direct = req.headers["x-xfoilfoam-sync-secret"];
  if (typeof direct === "string" && direct.length) return direct;
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.toLowerCase().startsWith("bearer "))
    return auth.slice(7);
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
    const allowed =
      direction === "fetch" ? permission?.canFetch : permission?.canPush;
    if (!allowed) {
      reply.code(403).send({ error: `${direction} disabled for ${dataType}` });
      return null;
    }
  }
  return ctx;
}

function remoteSolverToken(req: FastifyRequest): string | null {
  const value = req.headers["x-xfoilfoam-solver-token"];
  return typeof value === "string" && value.length ? value : null;
}

function solverTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

async function requireRegisteredRemoteSolver(
  req: FastifyRequest,
  reply: FastifyReply,
  solverId?: string,
): Promise<typeof registeredRemoteSolvers.$inferSelect | null> {
  const token = remoteSolverToken(req);
  if (!token) {
    reply.code(401).send({ error: "remote solver credential required" });
    return null;
  }
  const digest = solverTokenHash(token);
  const rows = await db
    .select()
    .from(registeredRemoteSolvers)
    .where(
      solverId
        ? and(
            eq(registeredRemoteSolvers.id, solverId),
            eq(registeredRemoteSolvers.authTokenHash, digest),
            isNull(registeredRemoteSolvers.revokedAt),
          )
        : and(
            eq(registeredRemoteSolvers.authTokenHash, digest),
            isNull(registeredRemoteSolvers.revokedAt),
          ),
    )
    .limit(2);
  const [solver] = rows;
  if (rows.length !== 1 || !solver?.authTokenHash) {
    reply
      .code(401)
      .send({ error: "invalid or revoked remote solver credential" });
    return null;
  }
  const supplied = Buffer.from(digest, "hex");
  const expected = Buffer.from(solver.authTokenHash, "hex");
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    reply
      .code(401)
      .send({ error: "invalid or revoked remote solver credential" });
    return null;
  }
  return solver;
}

function remoteSolverStatusPayload(
  solver: typeof registeredRemoteSolvers.$inferSelect,
) {
  return {
    id: solver.id,
    instanceId: solver.instanceId,
    instanceName: solver.instanceName,
    publicEndpoint: solver.publicEndpoint,
    localEndpoint: solver.localEndpoint,
    cpuCapacity: solver.cpuCapacity,
    cpuBudget: solver.cpuBudget,
    buildVersion: solver.buildVersion,
    credentialVersion: solver.credentialVersion,
    credentialActive: Boolean(solver.authTokenHash && !solver.revokedAt),
    revokedAt: iso(solver.revokedAt),
    status: solver.status,
    lastHeartbeatAt: iso(solver.lastHeartbeatAt),
    activePromiseCount: solver.activePromiseCount,
    activeAoaCount: solver.activeAoaCount,
    solvedCount: solver.solvedCount,
    pushedCount: solver.pushedCount,
    recentError: solver.recentError,
    metadata: solver.metadata,
    updatedAt: iso(solver.updatedAt),
  };
}

async function requirePromiseSyncAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  promiseId: string,
): Promise<Awaited<ReturnType<typeof getSettings>> | null> {
  if (!remoteSolverToken(req)) {
    const [promise] = await db
      .select({ requestPayload: syncSweepPromises.requestPayload })
      .from(syncSweepPromises)
      .where(eq(syncSweepPromises.id, promiseId))
      .limit(1);
    if (
      promise &&
      typeof (promise.requestPayload as Record<string, unknown> | null)
        ?.solverId === "string"
    ) {
      reply.code(401).send({ error: "remote solver credential required" });
      return null;
    }
    return requireSync(req, reply, "sweeps", "fetch");
  }
  const solver = await requireRegisteredRemoteSolver(req, reply);
  if (!solver) return null;
  const [promise] = await db
    .select()
    .from(syncSweepPromises)
    .where(eq(syncSweepPromises.id, promiseId))
    .limit(1);
  if (
    !promise ||
    promise.sourceInstanceId !== solver.instanceId ||
    String(
      (promise.requestPayload as Record<string, unknown> | null)?.solverId ??
        "",
    ) !== solver.id
  ) {
    reply.code(403).send({ error: "remote solver does not own this promise" });
    return null;
  }
  const ctx = await getSettings();
  if (
    !ctx.settings.enabled ||
    !ctx.permissions.find((row) => row.dataType === "sweeps")?.canFetch
  ) {
    reply.code(403).send({ error: "fetch disabled for sweeps" });
    return null;
  }
  return ctx;
}

function permissionSummary(
  permissions: Awaited<ReturnType<typeof getSettings>>["permissions"],
) {
  return Object.fromEntries(
    permissions.map((p) => [
      p.dataType,
      { fetch: p.canFetch, push: p.canPush },
    ]),
  );
}

/** Conflict payloads must stay INSPECTABLE, not exhaustive: pushed points
 *  carry media/evidence as inline base64 (tens-to-hundreds of MB) and storing
 *  them verbatim blew Postgres's 256 MB jsonb ceiling — the conflict INSERT
 *  itself 500'd and the remote push retried forever (validation incident
 *  2026-07-11). Strip every contentBase64 to a size stamp; sha256 + metadata
 *  survive for diagnosis. */
function stripBase64Content(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripBase64Content);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] =
        k === "contentBase64" && typeof v === "string"
          ? `[stripped ${v.length} base64 chars]`
          : stripBase64Content(v);
    }
    return out;
  }
  return value;
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
  const incomingPayload = stripBase64Content(opts.incomingPayload) as Record<
    string,
    unknown
  >;
  const sourceInstanceId = opts.sourceInstanceId ?? null;
  const artifactManifest = opts.artifactManifest ?? null;
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [fingerprintRow] = (await tx.execute(sql`
      SELECT encode(sha256(convert_to(jsonb_build_object(
        'sourceInstanceId', ${sourceInstanceId}::text,
        'dataType', ${opts.dataType}::text,
        'naturalKey', ${opts.naturalKey}::text,
        'incomingPayload', ${JSON.stringify(incomingPayload)}::jsonb,
        'artifactManifest', ${JSON.stringify(artifactManifest)}::jsonb
      )::text, 'UTF8')), 'hex') AS fingerprint
    `)) as unknown as Array<{ fingerprint: string }>;
    const fingerprint = fingerprintRow?.fingerprint;
    if (!fingerprint) throw new Error("failed to fingerprint sync conflict");
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sync-conflict:${fingerprint}`}, 0))`,
    );
    const pending = await tx
      .select()
      .from(syncImportConflicts)
      .where(
        and(
          eq(syncImportConflicts.status, "pending"),
          eq(syncImportConflicts.dataType, opts.dataType),
          eq(syncImportConflicts.naturalKey, opts.naturalKey),
          sql`${syncImportConflicts.sourceInstanceId} IS NOT DISTINCT FROM ${sourceInstanceId}`,
        ),
      );
    const equivalent = pending.find(
      (candidate) => candidate.fingerprint === fingerprint,
    );
    if (equivalent) return equivalent.id;
    const [inserted] = await tx
      .insert(syncImportConflicts)
      .values({
        dataType: opts.dataType,
        naturalKey: opts.naturalKey,
        fingerprint,
        incomingPayload,
        localSnapshot: opts.localSnapshot ?? null,
        artifactManifest,
        sourceInstanceId,
        sourceInstanceName: opts.sourceInstanceName ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: syncImportConflicts.id });
    if (inserted) return inserted.id;
    const [raced] = await tx
      .select({ id: syncImportConflicts.id })
      .from(syncImportConflicts)
      .where(
        and(
          eq(syncImportConflicts.status, "pending"),
          eq(syncImportConflicts.fingerprint, fingerprint),
        ),
      )
      .limit(1);
    if (!raced) throw new Error("failed to resolve sync conflict identity");
    return raced.id;
  });
}

function mediumValuesFromPayload(data: Record<string, unknown>) {
  const slug = nullableText(data.slug);
  if (!slug) throw new Error("medium payload lacks slug");
  const dynamicViscosity = numberWithFallback(
    data.dynamicViscosity ?? data.dynamic_viscosity,
    1e-5,
  );
  const density = numberWithFallback(data.density, 1);
  const phase: "gas" | "liquid" = data.phase === "liquid" ? "liquid" : "gas";
  return {
    slug,
    name: nullableText(data.name) ?? slug,
    phase,
    density,
    refTemperatureK: numberWithFallback(
      data.refTemperatureK ?? data.ref_temperature_k,
      288.15,
    ),
    refPressurePa: numberWithFallback(
      data.refPressurePa ?? data.ref_pressure_pa,
      101325,
    ),
    viscosityModel:
      nullableText(data.viscosityModel ?? data.viscosity_model) ?? "constant",
    constantDynamicViscosity: nullableNumber(
      data.constantDynamicViscosity ?? data.constant_dynamic_viscosity,
    ),
    sutherlandMuRef: nullableNumber(
      data.sutherlandMuRef ?? data.sutherland_mu_ref,
    ),
    sutherlandTRef: nullableNumber(
      data.sutherlandTRef ?? data.sutherland_t_ref,
    ),
    sutherlandS: nullableNumber(data.sutherlandS ?? data.sutherland_s),
    dynamicViscosity,
    kinematicViscosity: numberWithFallback(
      data.kinematicViscosity ?? data.kinematic_viscosity,
      dynamicViscosity / density,
    ),
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

async function upsertMediumFromPayload(
  data: Record<string, unknown>,
  database: DB = db,
) {
  const values = mediumValuesFromPayload(data);
  const [row] = await database
    .insert(mediums)
    .values(values)
    .onConflictDoUpdate({
      target: mediums.slug,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({ id: mediums.id });
  const tableRows = data.viscosityTable ?? data.viscosity_table;
  if (Array.isArray(tableRows)) {
    await database
      .delete(mediumViscosityTablePoints)
      .where(eq(mediumViscosityTablePoints.mediumId, row.id));
    const rows = tableRows
      .map((item, index) => jsonObject(item))
      .filter(
        (item) =>
          typeof (item.temperatureK ?? item.temperature_k) === "number" &&
          typeof (item.dynamicViscosity ?? item.dynamic_viscosity) === "number",
      )
      .map((item, index) => ({
        mediumId: row.id,
        temperatureK: Number(item.temperatureK ?? item.temperature_k),
        dynamicViscosity: Number(
          item.dynamicViscosity ?? item.dynamic_viscosity,
        ),
        sortOrder: Number(item.sortOrder ?? item.sort_order ?? index),
      }));
    if (rows.length)
      await database.insert(mediumViscosityTablePoints).values(rows);
  }
  return row.id;
}

async function resolveCategoryForAirfoil(
  data: Record<string, unknown>,
  existingCategoryId?: string | null,
  database: DB = db,
): Promise<string | null> {
  const categoryPath = nullableText(data.categoryPath ?? data.category_path);
  const categorySlug = nullableText(data.categorySlug ?? data.category_slug);
  const [category] = categoryPath
    ? await database
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.path, categoryPath))
        .limit(1)
    : categorySlug
      ? await database
          .select({ id: categories.id })
          .from(categories)
          .where(eq(categories.slug, categorySlug))
          .limit(1)
      : [];
  return category?.id ?? existingCategoryId ?? null;
}

function airfoilValuesFromPayload(
  data: Record<string, unknown>,
  categoryId: string,
  existingPoints?: unknown,
) {
  const slug = nullableText(data.slug);
  if (!slug) throw new Error("airfoil payload lacks slug");
  const points = Array.isArray(data.points)
    ? (data.points as never[])
    : Array.isArray(existingPoints)
      ? (existingPoints as never[])
      : [];
  if (!points.length)
    throw new Error("airfoil payload lacks coordinate points");
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
    teThicknessPct: nullableNumber(
      data.teThicknessPct ?? data.te_thickness_pct,
    ),
    tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
  };
}

async function upsertAirfoilFromPayload(
  data: Record<string, unknown>,
  database: DB = db,
) {
  const slug = nullableText(data.slug);
  if (!slug) throw new Error("airfoil payload lacks slug");
  const [existing] = await database
    .select({ categoryId: airfoils.categoryId, points: airfoils.points })
    .from(airfoils)
    .where(eq(airfoils.slug, slug))
    .limit(1);
  const categoryId = await resolveCategoryForAirfoil(
    data,
    existing?.categoryId ?? null,
    database,
  );
  if (!categoryId)
    throw new Error("airfoil payload references an unknown category");
  const values = airfoilValuesFromPayload(data, categoryId, existing?.points);
  const [row] = await database
    .insert(airfoils)
    .values(values)
    .onConflictDoUpdate({
      target: airfoils.slug,
      set: { ...values, updatedAt: new Date() },
    })
    .returning({ id: airfoils.id });
  return row.id;
}

function permissionRowsForAdmin(
  permissions: Awaited<ReturnType<typeof getSettings>>["permissions"],
) {
  const existing = new Map(permissions.map((p) => [p.dataType, p]));
  return SYNC_DATA_TYPES.map((dataType) => {
    const row = existing.get(dataType);
    return {
      dataType,
      canFetch: row?.canFetch ?? false,
      canPush: row?.canPush ?? false,
    };
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
  const solvers = await db
    .select()
    .from(registeredRemoteSolvers)
    .orderBy(desc(registeredRemoteSolvers.updatedAt))
    .limit(100);
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
      secretConfigured: settings.secret.length > 0,
      defaultPromiseTtlHours: settings.defaultPromiseTtlHours,
      upstreamBaseUrl: settings.upstreamBaseUrl,
      upstreamSecretConfigured: Boolean(settings.upstreamSecret?.length),
      syncMode: settings.syncMode,
      remoteSolverEnabled: settings.remoteSolverEnabled,
      remoteSolverCpuBudget: settings.remoteSolverCpuBudget,
      remoteSolverClaimSize: settings.remoteSolverClaimSize,
      remoteSolverHeartbeatIntervalSeconds:
        settings.remoteSolverHeartbeatIntervalSeconds,
      remoteSolverRegisteredId: settings.remoteSolverRegisteredId,
      remoteSolverLastSyncAt: iso(settings.remoteSolverLastSyncAt),
      remoteSolverLastPromiseAt: iso(settings.remoteSolverLastPromiseAt),
      remoteSolverLastPushAt: iso(settings.remoteSolverLastPushAt),
      remoteSolverLastStatus: settings.remoteSolverLastStatus,
      remoteSolverLastError: settings.remoteSolverLastError,
    },
    permissions: permissionRowsForAdmin(permissions),
    promises: {
      byStatus: Object.fromEntries(
        promiseRows.map((row) => [row.status, Number(row.n)]),
      ),
      pointsByStatus: Object.fromEntries(
        pointRows.map((row) => [row.status, Number(row.n)]),
      ),
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
      credentialVersion: row.credentialVersion,
      credentialActive: Boolean(row.authTokenHash && !row.revokedAt),
      revokedAt: iso(row.revokedAt),
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
      byAvailability: Object.fromEntries(
        remoteAssetRows.map((row) => [row.availability, Number(row.n)]),
      ),
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

function contentExtension(
  mimeType?: string | null,
  filename?: string | null,
): string {
  const fromName = filename ? extname(filename) : "";
  if (fromName) return fromName;
  if (mimeType === "image/png") return ".png";
  if (mimeType === "video/mp4") return ".mp4";
  if (mimeType === "application/json") return ".json";
  if (mimeType === "application/gzip") return ".gz";
  if (mimeType === "application/zstd") return ".zst";
  return ".bin";
}

async function storeBuffer(
  buf: Buffer,
  mimeType: string,
  filename?: string | null,
  onProgress?: () => Promise<void>,
): Promise<UploadedFileRef> {
  const sha256 = createHash("sha256").update(buf).digest("hex");
  const ext = contentExtension(mimeType, filename);
  const storageKey = `sync-imports/${sha256.slice(0, 2)}/${sha256}${ext}`;
  const tmpFull = join(env.mediaDir, `sync-imports/tmp/${randomUUID()}${ext}`);
  await mkdir(dirname(tmpFull), { recursive: true });
  const out = createWriteStream(tmpFull);
  try {
    const chunkBytes = 1024 * 1024;
    for (let offset = 0; offset < buf.byteLength; offset += chunkBytes) {
      await onProgress?.();
      const chunk = buf.subarray(offset, offset + chunkBytes);
      if (!out.write(chunk)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
  } catch (error) {
    if (!out.closed) {
      const closed = once(out, "close").catch(() => undefined);
      out.destroy();
      await closed;
    }
    await unlink(tmpFull).catch(() => undefined);
    throw error;
  }
  return {
    storageKey,
    mimeType,
    sha256,
    byteSize: buf.byteLength,
    tempFullPath: tmpFull,
  };
}

async function storeMultipartFile(
  part: {
    file: AsyncIterable<Buffer> & { truncated?: boolean };
    filename?: string;
    mimetype?: string;
  },
  budget: { decodedBytes: number },
  onProgress?: () => Promise<void>,
): Promise<UploadedFileRef> {
  const tmpKey = `sync-imports/tmp/${randomUUID()}${contentExtension(part.mimetype, part.filename)}`;
  const tmpFull = join(env.mediaDir, tmpKey);
  await mkdir(dirname(tmpFull), { recursive: true });
  const out = createWriteStream(tmpFull);
  const hash = createHash("sha256");
  let byteSize = 0;
  try {
    for await (const chunk of part.file) {
      byteSize += chunk.length;
      budget.decodedBytes += chunk.length;
      if (budget.decodedBytes > SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES) {
        throw new SyncMultipartUploadError(
          `multipart polar upload exceeds the ${SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES}-byte cumulative limit`,
          413,
        );
      }
      hash.update(chunk);
      await onProgress?.();
      if (!out.write(chunk)) await once(out, "drain");
    }
    if (part.file.truncated) {
      throw new SyncMultipartUploadError(
        `multipart polar file exceeds the ${SYNC_POLAR_MULTIPART_MAX_FILE_BYTES}-byte limit`,
        413,
      );
    }
    out.end();
    await once(out, "finish");
    const sha256 = hash.digest("hex");
    const storageKey = `sync-imports/${sha256.slice(0, 2)}/${sha256}${contentExtension(part.mimetype, part.filename)}`;
    return {
      storageKey,
      mimeType: part.mimetype ?? "application/octet-stream",
      sha256,
      byteSize,
      tempFullPath: tmpFull,
    };
  } catch (error) {
    if (!out.closed) {
      const closed = once(out, "close").catch(() => undefined);
      out.destroy();
      await closed;
    }
    await unlink(tmpFull).catch(() => undefined);
    throw error;
  }
}

async function cleanupMultipartTemps(
  files: Map<string, UploadedFileRef>,
): Promise<void> {
  await Promise.all(
    [
      ...new Set(
        [...files.values()].map((ref) => ref.tempFullPath).filter(Boolean),
      ),
    ].map((path) => unlink(path!).catch(() => undefined)),
  );
}

async function commitMultipartFiles(
  files: Map<string, UploadedFileRef>,
): Promise<void> {
  for (const ref of files.values()) {
    if (!ref.tempFullPath) continue;
    const full = join(env.mediaDir, ref.storageKey);
    await mkdir(dirname(full), { recursive: true });
    try {
      // Hard-linking promotes the completed staging file atomically and never
      // overwrites an existing content-addressed blob used by another owner.
      await link(ref.tempFullPath, full);
      ref.newlyCommitted = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      ref.newlyCommitted = false;
    }
    await unlink(ref.tempFullPath);
    ref.tempFullPath = undefined;
  }
}

async function cleanupUnreferencedCommittedFiles(
  files: Map<string, UploadedFileRef>,
): Promise<void> {
  const candidates = [
    ...new Set(
      [...files.values()]
        // Cleanup owns only blobs this request actually linked into the final
        // content store. Staged-only and EEXIST refs belong to nobody/another
        // request and must never be unlinked here.
        .filter((ref) => ref.newlyCommitted === true)
        .map((ref) => ref.storageKey),
    ),
  ];
  if (!candidates.length) return;
  const referenced = new Set<string>();
  const queryChunkSize = 4_000;
  for (let offset = 0; offset < candidates.length; offset += queryChunkSize) {
    const keys = candidates.slice(offset, offset + queryChunkSize);
    const [artifactRows, mediaRows, remoteRows] = await Promise.all([
      db
        .select({ storageKey: solverEvidenceArtifacts.storageKey })
        .from(solverEvidenceArtifacts)
        .where(inArray(solverEvidenceArtifacts.storageKey, keys)),
      db
        .select({ storageKey: resultMedia.storageKey })
        .from(resultMedia)
        .where(inArray(resultMedia.storageKey, keys)),
      db
        .select({ storageKey: remoteAssetReferences.localStorageKey })
        .from(remoteAssetReferences)
        .where(inArray(remoteAssetReferences.localStorageKey, keys)),
    ]);
    for (const row of [...artifactRows, ...mediaRows, ...remoteRows]) {
      referenced.add(row.storageKey);
    }
  }
  const unreferenced = candidates.filter((key) => !referenced.has(key));
  for (let offset = 0; offset < unreferenced.length; offset += 100) {
    await Promise.all(
      unreferenced.slice(offset, offset + 100).map(async (storageKey) => {
        try {
          await unlink(join(env.mediaDir, storageKey));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }),
    );
  }
}

const SYNC_UPLOAD_CAPACITY_LOCK_KEY = "sync-upload-capacity-v1";
const SYNC_UPLOAD_CAPACITY_LEASE_MS = 5 * 60_000;
const SYNC_UPLOAD_CAPACITY_RENEW_MS = 30_000;

function syncBlobLockStripes(
  payload: PolarPushPayload,
  files: Map<string, UploadedFileRef>,
): number[] {
  const identities = new Set([...files.values()].map((file) => file.sha256));
  for (const point of payload.results) {
    for (const item of [...point.evidenceArtifacts, ...point.media]) {
      const contentBase64 = nullableText(item.contentBase64);
      if (contentBase64) {
        // Use the identity of the decoded bytes—the same identity multipart
        // storage computes. A wrong declared checksum or alternate base64
        // spelling must not place identical content in a different lock lane.
        identities.add(
          createHash("sha256")
            .update(Buffer.from(contentBase64, "base64"))
            .digest("hex"),
        );
      }
    }
  }
  return [
    ...new Set([...identities].map((identity) => syncBlobLockStripe(identity))),
  ].sort((a, b) => a - b);
}

async function acquireSyncBlobLocks(
  payload: PolarPushPayload,
  files: Map<string, UploadedFileRef>,
): Promise<{ release: () => Promise<void> }> {
  const stripes = syncBlobLockStripes(payload, files);
  if (!stripes.length) return { release: async () => undefined };
  const connection = await advisoryLockSql.reserve();
  try {
    // One awaited statement per sorted stripe gives a contractual acquisition
    // order. A SELECT target-list side effect is not ordered by a subquery's
    // sort and can deadlock opposite-overlap requests.
    for (const stripe of stripes) {
      await connection.unsafe(
        `SELECT pg_advisory_lock(${SYNC_BLOB_LOCK_NAMESPACE}, $1)`,
        [stripe],
      );
    }
  } catch (error) {
    try {
      await connection.unsafe("SELECT pg_advisory_unlock_all()");
    } finally {
      connection.release();
    }
    throw error;
  }
  return {
    release: async () => {
      try {
        for (const stripe of [...stripes].reverse()) {
          await connection.unsafe(
            `SELECT pg_advisory_unlock(${SYNC_BLOB_LOCK_NAMESPACE}, $1)`,
            [stripe],
          );
        }
      } finally {
        try {
          // Also clears any partially released session lock if an individual
          // unlock call failed; pooled connections must never retain one.
          await connection.unsafe("SELECT pg_advisory_unlock_all()");
        } finally {
          connection.release();
        }
      }
    },
  };
}

async function acquireSolverCredentialRotationLock(
  solverId: string,
): Promise<{ release: () => Promise<void> }> {
  const connection = await advisoryLockSql.reserve();
  try {
    await connection.unsafe(
      "SELECT pg_advisory_lock(hashtextextended($1, 0))",
      [`remote-solver-credential-rotation:${solverId}`],
    );
  } catch (error) {
    connection.release();
    throw error;
  }
  return {
    release: async () => {
      try {
        await connection.unsafe("SELECT pg_advisory_unlock_all()");
      } finally {
        connection.release();
      }
    },
  };
}

function declaredMultipartUploads(
  payload: PolarPushPayload,
): Map<string, number> {
  const declared = new Map<string, number>();
  let declaredBytes = 0;
  for (const point of payload.results) {
    for (const item of [...point.evidenceArtifacts, ...point.media]) {
      const field = nullableText(item.uploadField);
      if (!field) continue;
      if (declared.has(field)) {
        throw new SyncMultipartUploadError(
          "multipart manifest repeats upload field " + field,
        );
      }
      const byteSize = exactDeclaredByteSize(item);
      if (byteSize == null) {
        throw new SyncMultipartUploadError(
          "multipart upload field " + field + " requires an exact byteSize",
        );
      }
      if (byteSize > SYNC_POLAR_MULTIPART_MAX_FILE_BYTES) {
        throw new SyncMultipartUploadError(
          "multipart upload field " + field + " exceeds the per-file limit",
          413,
        );
      }
      declared.set(field, byteSize);
      declaredBytes += byteSize;
    }
  }
  if (declared.size > SYNC_POLAR_MULTIPART_MAX_FILES) {
    throw new SyncMultipartUploadError(
      "multipart manifest declares too many files",
      413,
    );
  }
  if (declaredBytes > SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES) {
    throw new SyncMultipartUploadError(
      "multipart manifest exceeds the cumulative upload limit",
      413,
    );
  }
  return declared;
}

function exactDeclaredByteSize(item: Record<string, unknown>): number | null {
  const supplied = [item.byteSize, item.byte_size].filter(
    (value) => value != null,
  );
  if (!supplied.length) return null;
  const parsed = supplied.map(nullableNumber);
  if (
    parsed.some(
      (value) =>
        value == null || !Number.isSafeInteger(value) || Number(value) < 0,
    ) ||
    new Set(parsed).size !== 1
  ) {
    throw new SyncMultipartUploadError(
      "uploaded evidence declares an invalid or inconsistent byte size",
    );
  }
  return parsed[0]!;
}

export function assertMultipartDiskReserveAvailableBytes(
  declared: Map<string, number>,
  availableBytes: bigint,
): void {
  const declaredBytes = [...declared.values()].reduce(
    (sum, value) => sum + BigInt(value),
    0n,
  );
  const required = declaredBytes + BigInt(SYNC_POLAR_MULTIPART_MIN_FREE_BYTES);
  if (availableBytes < required) {
    throw new SyncMultipartUploadError(
      "insufficient free disk for sync polar upload and safety reserve",
      507,
    );
  }
}

async function syncImportAvailableBytes(): Promise<bigint> {
  const syncImportDir = join(env.mediaDir, "sync-imports");
  await mkdir(syncImportDir, { recursive: true });
  const stats = await statfs(syncImportDir, { bigint: true });
  return stats.bavail * stats.bsize;
}

export interface SyncUploadCapacityReservation {
  id: string;
  token: string;
  reservedBytes: number;
  renew: (force?: boolean) => Promise<void>;
  release: () => Promise<boolean>;
}

async function withSyncUploadCapacityLock<T>(
  operation: (tx: DB) => Promise<T>,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${SYNC_UPLOAD_CAPACITY_LOCK_KEY}, 0))`,
    );
    return operation(tx);
  });
}

export async function renewSyncUploadCapacityReservation(
  id: string,
  token: string,
): Promise<boolean> {
  return withSyncUploadCapacityLock(async (tx) => {
    await tx
      .delete(syncUploadCapacityReservations)
      .where(sql`${syncUploadCapacityReservations.expiresAt} <= now()`);
    const renewed = await tx
      .update(syncUploadCapacityReservations)
      .set({
        expiresAt: sql`now() + (${SYNC_UPLOAD_CAPACITY_LEASE_MS}::double precision * interval '1 millisecond')`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(syncUploadCapacityReservations.id, id),
          eq(syncUploadCapacityReservations.token, token),
          sql`${syncUploadCapacityReservations.expiresAt} > now()`,
        ),
      )
      .returning({ id: syncUploadCapacityReservations.id });
    return renewed.length === 1;
  });
}

export async function releaseSyncUploadCapacityReservation(
  id: string,
  token: string,
): Promise<boolean> {
  return withSyncUploadCapacityLock(async (tx) => {
    const released = await tx
      .delete(syncUploadCapacityReservations)
      .where(
        and(
          eq(syncUploadCapacityReservations.id, id),
          eq(syncUploadCapacityReservations.token, token),
        ),
      )
      .returning({ id: syncUploadCapacityReservations.id });
    return released.length === 1;
  });
}

export async function acquireSyncUploadCapacityReservation(
  reservedBytes: number,
): Promise<SyncUploadCapacityReservation | null> {
  if (reservedBytes === 0) return null;
  if (
    !Number.isSafeInteger(reservedBytes) ||
    reservedBytes < 0 ||
    reservedBytes > SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES
  ) {
    throw new SyncMultipartUploadError(
      "sync polar upload declares an invalid cumulative byte size",
      413,
    );
  }
  const row = await withSyncUploadCapacityLock(async (tx) => {
    await tx
      .delete(syncUploadCapacityReservations)
      .where(sql`${syncUploadCapacityReservations.expiresAt} <= now()`);
    // Measure inside the same process-independent serialization boundary as
    // prune/sum/insert. Existing reservations are deliberately counted at
    // their full declared size even after staging begins; statfs also sees the
    // written bytes, so this may reject conservatively but cannot undercount.
    const availableBytes = await syncImportAvailableBytes();
    const [active] = (await tx.execute(sql`
      SELECT COALESCE(sum(reserved_bytes), 0)::text AS reserved_bytes
      FROM sync_upload_capacity_reservations
      WHERE expires_at > now()
    `)) as unknown as Array<{ reserved_bytes: string }>;
    const activeBytes = BigInt(active?.reserved_bytes ?? "0");
    const required =
      activeBytes +
      BigInt(reservedBytes) +
      BigInt(SYNC_POLAR_MULTIPART_MIN_FREE_BYTES);
    if (availableBytes < required) {
      throw new SyncMultipartUploadError(
        "insufficient free disk for sync polar upload and safety reserve",
        507,
      );
    }
    const [inserted] = await tx
      .insert(syncUploadCapacityReservations)
      .values({
        token: randomUUID(),
        reservedBytes,
        expiresAt: sql`now() + (${SYNC_UPLOAD_CAPACITY_LEASE_MS}::double precision * interval '1 millisecond')`,
      })
      .returning({
        id: syncUploadCapacityReservations.id,
        token: syncUploadCapacityReservations.token,
      });
    return inserted;
  });
  let released = false;
  let lastRenewedAt = Date.now();
  return {
    ...row,
    reservedBytes,
    renew: async (force = false) => {
      if (released) throw new Error("sync upload capacity lease was released");
      if (!force && Date.now() - lastRenewedAt < SYNC_UPLOAD_CAPACITY_RENEW_MS)
        return;
      if (!(await renewSyncUploadCapacityReservation(row.id, row.token))) {
        throw new Error("sync upload capacity lease expired or was lost");
      }
      lastRenewedAt = Date.now();
    },
    release: async () => {
      if (released) return false;
      const settled = await releaseSyncUploadCapacityReservation(
        row.id,
        row.token,
      );
      released = true;
      return settled;
    },
  };
}

function declaredInlineUploads(
  payload: PolarPushPayload,
  files: Map<string, UploadedFileRef>,
): Map<string, number> {
  const declared = new Map<string, number>();
  let decodedBytes = [...files.values()].reduce(
    (sum, file) => sum + file.byteSize,
    0,
  );
  let ordinal = 0;
  for (const point of payload.results) {
    for (const item of [...point.evidenceArtifacts, ...point.media]) {
      const uploadField = nullableText(item.uploadField);
      if (uploadField && files.has(uploadField)) continue;
      const contentBase64 = nullableText(item.contentBase64);
      if (!contentBase64) continue;
      // Buffer.byteLength computes the decoded size without allocating the
      // potentially GiB-scale buffer. Invalid/non-canonical input may be
      // over-counted, which is the safe direction for the disk reserve gate;
      // the existing checksum/byte-size validation still rejects it later.
      const computedBytes = Buffer.byteLength(contentBase64, "base64");
      const claimedBytes = exactDeclaredByteSize(item);
      const byteSize = Math.max(computedBytes, claimedBytes ?? 0);
      if (byteSize > SYNC_POLAR_MULTIPART_MAX_FILE_BYTES) {
        throw new SyncMultipartUploadError(
          "inline evidence exceeds the per-file byte limit",
          413,
        );
      }
      decodedBytes += byteSize;
      if (decodedBytes > SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES) {
        throw new SyncMultipartUploadError(
          "inline evidence exceeds the cumulative upload byte limit",
          413,
        );
      }
      declared.set(`inline_${ordinal}`, byteSize);
      ordinal += 1;
    }
  }
  return declared;
}

async function parsePolarRequest(req: FastifyRequest): Promise<{
  payload: PolarPushPayload;
  files: Map<string, UploadedFileRef>;
  capacityReservation: SyncUploadCapacityReservation | null;
}> {
  const maybeMultipart = req as FastifyRequest & {
    isMultipart?: () => boolean;
    parts?: (options?: {
      limits?: {
        fileSize?: number;
        files?: number;
        fields?: number;
        parts?: number;
        fieldSize?: number;
      };
    }) => AsyncIterable<
      | {
          type: "field";
          fieldname: string;
          value: unknown;
          valueTruncated?: boolean;
        }
      | {
          type: "file";
          fieldname: string;
          file: AsyncIterable<Buffer> & { truncated?: boolean };
          filename?: string;
          mimetype?: string;
        }
    >;
  };
  if (!maybeMultipart.isMultipart?.()) {
    const payload = polarPushSchema.parse(req.body);
    const files = new Map<string, UploadedFileRef>();
    const inline = declaredInlineUploads(payload, files);
    const capacityReservation = await acquireSyncUploadCapacityReservation(
      [...inline.values()].reduce((sum, value) => sum + value, 0),
    );
    return { payload, files, capacityReservation };
  }

  const files = new Map<string, UploadedFileRef>();
  const budget = { decodedBytes: 0 };
  let payload: PolarPushPayload | null = null;
  let declared = new Map<string, number>();
  let capacityReservation: SyncUploadCapacityReservation | null = null;
  let partNumber = 0;
  try {
    for await (const part of maybeMultipart.parts!({
      limits: {
        fileSize: SYNC_POLAR_MULTIPART_MAX_FILE_BYTES,
        files: SYNC_POLAR_MULTIPART_MAX_FILES,
        fields: SYNC_POLAR_MULTIPART_MAX_FIELDS,
        parts: SYNC_POLAR_MULTIPART_MAX_PARTS,
        fieldSize: SYNC_POLAR_MULTIPART_MANIFEST_PARSER_BYTES,
      },
    })) {
      partNumber += 1;
      if (partNumber === 1) {
        if (part.type !== "field" || part.fieldname !== "manifest") {
          throw new SyncMultipartUploadError(
            "multipart polar manifest must be the first part",
          );
        }
        if (
          part.valueTruncated ||
          Buffer.byteLength(
            typeof part.value === "string"
              ? part.value
              : JSON.stringify(part.value),
          ) > SYNC_POLAR_MULTIPART_MAX_MANIFEST_BYTES
        ) {
          throw new SyncMultipartUploadError(
            "multipart polar manifest exceeds the configured byte limit",
            413,
          );
        }
        let manifest: unknown;
        try {
          manifest =
            typeof part.value === "string"
              ? JSON.parse(part.value)
              : part.value;
        } catch {
          throw new SyncMultipartUploadError(
            "multipart polar manifest is not valid JSON",
          );
        }
        payload = polarPushSchema.parse(manifest);
        declared = declaredMultipartUploads(payload);
        const inline = declaredInlineUploads(payload, new Map());
        const reservedBytes = [...declared.values(), ...inline.values()].reduce(
          (sum, value) => sum + value,
          0,
        );
        if (reservedBytes > SYNC_POLAR_MULTIPART_MAX_UPLOAD_BYTES) {
          throw new SyncMultipartUploadError(
            "polar upload exceeds the cumulative upload byte limit",
            413,
          );
        }
        // The full multipart+inline reservation is durable before the parser
        // accepts the first file byte.
        capacityReservation =
          await acquireSyncUploadCapacityReservation(reservedBytes);
        continue;
      }

      if (!payload) {
        throw new SyncMultipartUploadError(
          "multipart polar push requires a manifest first",
        );
      }
      if (part.type === "field") {
        throw new SyncMultipartUploadError(
          "multipart polar push contains an unexpected field " + part.fieldname,
        );
      }
      const declaredSize = declared.get(part.fieldname);
      if (declaredSize == null) {
        throw new SyncMultipartUploadError(
          "multipart upload field " +
            part.fieldname +
            " is not declared by the manifest",
        );
      }
      if (files.has(part.fieldname)) {
        throw new SyncMultipartUploadError(
          "multipart polar push repeats upload field " + part.fieldname,
        );
      }
      const stored = await storeMultipartFile(part, budget, async () => {
        await capacityReservation?.renew();
      });
      files.set(part.fieldname, stored);
      if (stored.byteSize !== declaredSize) {
        throw new SyncMultipartUploadError(
          "multipart upload field " +
            part.fieldname +
            " does not match its declared byteSize",
        );
      }
    }
    if (!payload) {
      throw new SyncMultipartUploadError(
        "multipart polar push requires a manifest field",
      );
    }
    const missing = [...declared.keys()].find((field) => !files.has(field));
    if (missing) {
      throw new SyncMultipartUploadError(
        "manifest references missing multipart upload field " + missing,
      );
    }
    return { payload, files, capacityReservation };
  } catch (error) {
    await cleanupMultipartTemps(files);
    await capacityReservation?.release();
    throw error;
  }
}
async function resolveUploadedArtifact(
  item: Record<string, unknown>,
  files: Map<string, UploadedFileRef>,
  capacityReservation?: SyncUploadCapacityReservation | null,
): Promise<UploadedFileRef> {
  const brokeredUploadId = nullableText(item.remoteEvidenceUploadId);
  if (brokeredUploadId) {
    if (nullableText(item.uploadField) || nullableText(item.contentBase64))
      throw new PolarEvidenceBindingError(
        "brokered GCS evidence must not also carry inline or multipart bytes",
      );
    const [upload] = await db
      .select()
      .from(syncBrokeredEvidenceUploads)
      .where(eq(syncBrokeredEvidenceUploads.id, brokeredUploadId))
      .limit(1);
    const metadata = jsonObject(item.metadata);
    if (
      !upload ||
      !["verified", "bound"].includes(upload.state) ||
      nullableText(item.kind) !== "engine_bundle" ||
      nullableText(item.mimeType) !== "application/zstd" ||
      nullableText(item.sha256) !== upload.storedSha256 ||
      exactDeclaredByteSize(item) !== upload.storedByteSize ||
      metadata.storageBackend !== "gcs" ||
      metadata.bucket !== upload.bucket ||
      metadata.objectKey !== upload.objectKey ||
      metadata.generation !== upload.generation ||
      metadata.crc32c !== upload.crc32c ||
      metadata.tarSha256 !== upload.tarSha256 ||
      metadata.tarByteSize !== String(upload.tarByteSize) ||
      metadata.manifestSha256 !== upload.manifestSha256 ||
      metadata.manifestByteSize !== String(upload.manifestByteSize)
    )
      throw new PolarEvidenceBindingError(
        "brokered GCS evidence identity does not match its verified upload",
      );
    return {
      storageKey: upload.objectKey,
      mimeType: "application/zstd",
      sha256: upload.storedSha256,
      byteSize: upload.storedByteSize,
      brokeredUploadId: upload.id,
    };
  }
  const uploadField = nullableText(item.uploadField);
  const fromFile = uploadField ? files.get(uploadField) : null;
  const fromBase64 = nullableText(item.contentBase64);
  let ref = fromFile;
  if (!ref && fromBase64) {
    await capacityReservation?.renew();
    const decoded = Buffer.from(fromBase64, "base64");
    if (decoded.byteLength > SYNC_POLAR_MULTIPART_MAX_FILE_BYTES) {
      throw new SyncMultipartUploadError(
        "inline evidence exceeds the per-file byte limit",
        413,
      );
    }
    ref = await storeBuffer(
      decoded,
      nullableText(item.mimeType) ?? "application/octet-stream",
      nullableText(item.filename),
      async () => {
        await capacityReservation?.renew();
      },
    );
    const inlineKey = `__inline_${randomUUID()}`;
    // Publish just this new ref; revisiting every prior inline item makes the
    // valid 8,192-item ceiling quadratic.
    await commitMultipartFiles(new Map([[inlineKey, ref]]));
    files.set(inlineKey, ref);
    await capacityReservation?.renew();
  }
  if (!ref)
    throw new Error(
      `artifact ${nullableText(item.kind) ?? nullableText(item.field) ?? "item"} is missing uploaded content`,
    );
  if (nullableText(item.sha256) && item.sha256 !== ref.sha256)
    throw new Error(`sha256 mismatch for ${uploadField ?? item.sha256}`);
  const declaredByteSize = exactDeclaredByteSize(item);
  if (declaredByteSize != null && declaredByteSize !== ref.byteSize)
    throw new Error(`byte size mismatch for ${uploadField ?? item.sha256}`);
  return ref;
}

async function uploadedFileBytes(ref: UploadedFileRef): Promise<Buffer> {
  return readFile(ref.tempFullPath ?? join(env.mediaDir, ref.storageKey));
}

interface PreparedBrokeredArchive {
  upload: typeof syncBrokeredEvidenceUploads.$inferSelect;
  evidenceBase: string;
  memberSet: ReturnType<typeof parseEvidenceManifest>["memberSet"];
}

/** Freshly authenticate every manifest member from the exact GCS generation
 * before the import transaction is allowed to advertise restartable evidence.
 * A compressed-object checksum alone proves the container, not the restart
 * contents needed by FINAL URANS. */
async function prepareBrokeredArchiveRegistration(
  preparedArtifacts: Array<{
    artifact: Record<string, unknown>;
    stored: UploadedFileRef;
  }>,
): Promise<PreparedBrokeredArchive | null> {
  const brokered = preparedArtifacts.filter(
    ({ stored }) => stored.brokeredUploadId,
  );
  if (!brokered.length) return null;
  if (brokered.length !== 1) {
    throw new PolarEvidenceBindingError(
      "one result attempt may carry only one brokered engine archive",
    );
  }
  const [manifest] = preparedArtifacts.filter(
    ({ artifact }) => nullableText(artifact.kind) === "manifest",
  );
  if (!manifest) {
    throw new PolarEvidenceBindingError(
      "brokered engine archive requires its exact manifest bytes",
    );
  }
  const uploadId = brokered[0]!.stored.brokeredUploadId!;
  const [upload] = await db
    .select()
    .from(syncBrokeredEvidenceUploads)
    .where(eq(syncBrokeredEvidenceUploads.id, uploadId))
    .limit(1);
  if (
    !upload ||
    !["verified", "bound"].includes(upload.state) ||
    !upload.generation ||
    !upload.crc32c ||
    !upload.verifiedAt
  ) {
    throw new PolarEvidenceBindingError(
      "brokered engine archive is not one verified GCS generation",
    );
  }
  const manifestBytes = await uploadedFileBytes(manifest.stored);
  const parsed = parseEvidenceManifest(manifestBytes);
  if (
    manifest.stored.sha256 !== upload.manifestSha256 ||
    manifest.stored.byteSize !== upload.manifestByteSize ||
    parsed.bundled.length !== upload.bundledFileCount ||
    parsed.memberSet.length !== upload.bundledFileCount + 1
  ) {
    throw new PolarEvidenceBindingError(
      "brokered archive manifest does not match its verified upload claim",
    );
  }
  const evidenceBase = nullableText(
    jsonObject(brokered[0]!.artifact.metadata).evidenceBase,
  );
  if (!evidenceBase) {
    throw new PolarEvidenceBindingError(
      "brokered engine archive lacks an exact evidenceBase",
    );
  }
  await makeEngineClient().verifyRemoteEvidenceManifest({
    remote: {
      schemaVersion: 1,
      format: "tar+zstd",
      bucket: upload.bucket,
      objectKey: upload.objectKey,
      generation: upload.generation,
      storedSha256: upload.storedSha256,
      storedSize: upload.storedByteSize,
      tarSha256: upload.tarSha256,
      tarSize: upload.tarByteSize,
      crc32c: upload.crc32c,
      zstdLevel: upload.zstdLevel,
      createdAt: upload.verifiedAt.toISOString(),
    },
    manifestBase64: manifestBytes.toString("base64"),
    manifestSha256: upload.manifestSha256,
    manifestByteSize: upload.manifestByteSize,
    manifestMemberSetSha256: manifestMemberSetSha256(parsed.memberSet),
    manifestMemberCount: parsed.memberSet.length,
  });
  return { upload, evidenceBase, memberSet: parsed.memberSet };
}

function equivalentResult(
  row: typeof results.$inferSelect,
  point: z.infer<typeof polarPointSchema>,
): boolean {
  const cmp = (a: number | null | undefined, b: number | null | undefined) => {
    if (a == null && b == null) return true;
    if (a == null || b == null) return false;
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return Math.abs(a - b) <= scale * 1e-9;
  };
  const sameJson = (a: unknown, b: unknown) =>
    stableHash(a ?? null) === stableHash(b ?? null);
  const normalizedSource = point.status === "done" ? "solved" : point.source;
  const normalizedRegime = point.regime ?? (point.unsteady ? "urans" : "rans");
  return (
    row.status === point.status &&
    row.source === normalizedSource &&
    row.regime === normalizedRegime &&
    row.fidelity === (point.fidelity ?? null) &&
    row.unsteady === point.unsteady &&
    row.converged === point.converged &&
    row.stalled === point.stalled &&
    cmp(row.cl, point.cl) &&
    cmp(row.cd, point.cd) &&
    cmp(row.cm, point.cm) &&
    cmp(row.clCd, point.clCd) &&
    cmp(row.clStd, point.clStd) &&
    cmp(row.cdStd, point.cdStd) &&
    cmp(row.cmStd, point.cmStd) &&
    cmp(row.finalResidual, point.finalResidual) &&
    row.iterations === (point.iterations ?? null) &&
    cmp(row.yPlusAvg, point.yPlusAvg) &&
    cmp(row.yPlusMax, point.yPlusMax) &&
    row.nCells === (point.nCells ?? null) &&
    row.firstOrderFallback === point.firstOrderFallback &&
    cmp(row.strouhal, point.strouhal) &&
    row.error === (point.error ?? null) &&
    sameJson(row.qualityWarnings, point.qualityWarnings) &&
    sameJson(row.frameTrack, point.frameTrack) &&
    sameJson(row.steadyHistory, point.steadyHistory)
  );
}

function remoteResultValues(
  point: z.infer<typeof polarPointSchema>,
  bcId: string,
  engineJobId: string,
  runtime: ResolvedEngineRuntime | null,
) {
  return {
    bcId,
    status: point.status,
    source: point.status === "done" ? ("solved" as const) : point.source,
    regime:
      point.regime ?? (point.unsteady ? ("urans" as const) : ("rans" as const)),
    fidelity: point.fidelity ?? null,
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
    qualityWarnings: point.qualityWarnings ?? null,
    frameTrack: point.frameTrack ?? null,
    steadyHistory: point.steadyHistory ?? null,
    simJobId: null,
    engineJobId,
    engineCaseSlug: point.engineCaseSlug ?? null,
    methodKey: point.methodKey ?? null,
    solverImplementationId: runtime?.solverImplementationId ?? null,
    solverRuntimeBuildId: runtime?.solverRuntimeBuildId ?? null,
    solvedAt: point.status === "done" ? new Date() : null,
    updatedAt: new Date(),
  };
}

function remoteAttemptValues(opts: {
  point: z.infer<typeof polarPointSchema>;
  airfoilId: string;
  bcId: string;
  revisionId: string;
  engineJobId: string;
  runtime: ResolvedEngineRuntime | null;
}) {
  const { point } = opts;
  const regime =
    point.regime ?? (point.unsteady ? ("urans" as const) : ("rans" as const));
  const suppliedEvidence = (point.evidencePayload ?? point) as Record<
    string,
    unknown
  >;
  const evidencePayload = stripBase64Content({
    ...suppliedEvidence,
    fidelity: point.fidelity ?? null,
    quality_warnings: point.qualityWarnings ?? null,
    frame_track: point.frameTrack ?? null,
    steady_history: point.steadyHistory ?? null,
    method_key: point.methodKey ?? null,
    engine: point.engine ?? null,
    // forceHistory is transported separately to keep the public contract
    // typed, but the immutable attempt payload is the classifier/source of
    // truth. Always normalize it into the exact attempt generation.
    force_history:
      point.forceHistory ??
      suppliedEvidence.force_history ??
      suppliedEvidence.forceHistory ??
      null,
  }) as Record<string, unknown>;
  return {
    regime,
    values: {
      airfoilId: opts.airfoilId,
      bcId: opts.bcId,
      simulationPresetRevisionId: opts.revisionId,
      aoaDeg: point.aoaDeg,
      status: point.status === "done" ? ("done" as const) : ("failed" as const),
      source:
        point.status === "done" ? ("solved" as const) : ("queued" as const),
      regime,
      validForPolar:
        point.status === "done" &&
        point.converged &&
        !point.error &&
        Number(point.cd ?? 0) > 0,
      engineJobId: opts.engineJobId,
      engineCaseSlug: point.engineCaseSlug ?? null,
      methodKey: point.methodKey ?? null,
      solverImplementationId: opts.runtime?.solverImplementationId ?? null,
      solverRuntimeBuildId: opts.runtime?.solverRuntimeBuildId ?? null,
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
      qualityWarnings: point.qualityWarnings ?? null,
      evidencePayload,
    },
  };
}

function comparableRemoteAttempt(attempt: Record<string, unknown>) {
  return {
    airfoilId: attempt.airfoilId,
    bcId: attempt.bcId,
    simulationPresetRevisionId: attempt.simulationPresetRevisionId,
    aoaDeg: attempt.aoaDeg,
    status: attempt.status,
    source: attempt.source,
    regime: attempt.regime,
    validForPolar: attempt.validForPolar,
    engineJobId: attempt.engineJobId,
    engineCaseSlug: attempt.engineCaseSlug ?? null,
    methodKey: attempt.methodKey ?? null,
    solverImplementationId: attempt.solverImplementationId ?? null,
    solverRuntimeBuildId: attempt.solverRuntimeBuildId ?? null,
    cl: attempt.cl ?? null,
    cd: attempt.cd ?? null,
    cm: attempt.cm ?? null,
    clCd: attempt.clCd ?? null,
    clStd: attempt.clStd ?? null,
    cdStd: attempt.cdStd ?? null,
    cmStd: attempt.cmStd ?? null,
    stalled: attempt.stalled,
    unsteady: attempt.unsteady,
    converged: attempt.converged,
    finalResidual: attempt.finalResidual ?? null,
    iterations: attempt.iterations ?? null,
    yPlusAvg: attempt.yPlusAvg ?? null,
    yPlusMax: attempt.yPlusMax ?? null,
    nCells: attempt.nCells ?? null,
    firstOrderFallback: attempt.firstOrderFallback,
    strouhal: attempt.strouhal ?? null,
    error: attempt.error ?? null,
    qualityWarnings: attempt.qualityWarnings ?? null,
    evidencePayload: attempt.evidencePayload ?? null,
  };
}

async function equivalentStoredResultEvidence(
  tx: DB,
  resultId: string,
  point: z.infer<typeof polarPointSchema>,
  exact: {
    engineJobId: string;
    engineCaseSlug: string | null;
    regime: "rans" | "urans";
    manifestSha256: string | null;
  },
): Promise<boolean> {
  const [storedAttempt] = await tx
    .select()
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.resultId, resultId),
        isNull(resultAttempts.simJobId),
        eq(resultAttempts.engineJobId, exact.engineJobId),
        sql`${resultAttempts.engineCaseSlug} IS NOT DISTINCT FROM ${exact.engineCaseSlug}`,
        eq(resultAttempts.aoaDeg, point.aoaDeg),
        eq(resultAttempts.regime, exact.regime),
      ),
    )
    .limit(1);
  // Same coefficients from a new namespaced remote engine attempt are a new
  // immutable generation, not a replay of stale parent evidence.
  if (!storedAttempt) return true;
  const storedMedia = await tx
    .select()
    .from(resultMedia)
    .where(
      and(
        eq(resultMedia.resultId, resultId),
        eq(resultMedia.resultAttemptId, storedAttempt.id),
        exact.manifestSha256
          ? eq(resultMedia.evidenceSha256, exact.manifestSha256)
          : sql`false`,
      ),
    );
  const storedArtifacts = await tx
    .select()
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, resultId),
        eq(solverEvidenceArtifacts.resultAttemptId, storedAttempt.id),
        sql`${solverEvidenceArtifacts.engineJobId} IS NOT DISTINCT FROM ${exact.engineJobId}`,
        sql`${solverEvidenceArtifacts.engineCaseSlug} IS NOT DISTINCT FROM ${exact.engineCaseSlug}`,
      ),
    );
  const storedExtents = await tx
    .select()
    .from(resultFieldExtents)
    .where(
      and(
        eq(resultFieldExtents.resultId, resultId),
        eq(resultFieldExtents.resultAttemptId, storedAttempt.id),
        exact.manifestSha256
          ? eq(resultFieldExtents.evidenceSha256, exact.manifestSha256)
          : sql`false`,
      ),
    );
  const manifest = (
    rows: Array<{
      kind?: unknown;
      field?: unknown;
      role?: unknown;
      sha256?: unknown;
      byteSize?: unknown;
      byte_size?: unknown;
      mimeType?: unknown;
      mime_type?: unknown;
      evidenceSha256?: unknown;
      evidence_sha256?: unknown;
      renderProfileKey?: unknown;
      render_profile_key?: unknown;
      width?: unknown;
      height?: unknown;
      frameCount?: unknown;
      frame_count?: unknown;
      durationS?: unknown;
      duration_s?: unknown;
      colorScaleVersion?: unknown;
      color_scale_version?: unknown;
      scaleVmin?: unknown;
      scale_vmin?: unknown;
      scaleVmax?: unknown;
      scale_vmax?: unknown;
      scalePolicy?: unknown;
      scale_policy?: unknown;
    }>,
    defaultRenderProfile = false,
  ) =>
    rows.map((row) => ({
      kind: nullableText(row.kind),
      field: nullableText(row.field),
      role: nullableText(row.role),
      sha256: nullableText(row.sha256),
      byteSize: nullableNumber(row.byteSize ?? row.byte_size),
      mimeType: nullableText(row.mimeType ?? row.mime_type),
      evidenceSha256: nullableText(row.evidenceSha256 ?? row.evidence_sha256),
      renderProfileKey:
        nullableText(row.renderProfileKey ?? row.render_profile_key) ??
        (defaultRenderProfile ? "default:v1:zoom2" : null),
      width: nullableNumber(row.width),
      height: nullableNumber(row.height),
      frameCount: nullableNumber(row.frameCount ?? row.frame_count),
      durationS: nullableNumber(row.durationS ?? row.duration_s),
      colorScaleVersion: nullableNumber(
        row.colorScaleVersion ?? row.color_scale_version,
      ),
      scaleVmin: nullableNumber(row.scaleVmin ?? row.scale_vmin),
      scaleVmax: nullableNumber(row.scaleVmax ?? row.scale_vmax),
      scalePolicy: nullableText(row.scalePolicy ?? row.scale_policy),
    }));
  const extentManifest = (
    rows: Array<{
      field?: unknown;
      renderProfileKey?: unknown;
      render_profile_key?: unknown;
      vmin?: unknown;
      vmax?: unknown;
      finiteCount?: unknown;
      finite_count?: unknown;
      evidenceSha256?: unknown;
      evidence_sha256?: unknown;
      sourceTimeStart?: unknown;
      source_time_start?: unknown;
      sourceTimeEnd?: unknown;
      source_time_end?: unknown;
    }>,
  ) =>
    rows.map((row) => ({
      field: nullableText(row.field),
      renderProfileKey:
        nullableText(row.renderProfileKey ?? row.render_profile_key) ??
        "default:v1:zoom2",
      vmin: nullableNumber(row.vmin),
      vmax: nullableNumber(row.vmax),
      finiteCount: nullableNumber(row.finiteCount ?? row.finite_count),
      evidenceSha256: nullableText(row.evidenceSha256 ?? row.evidence_sha256),
      sourceTimeStart: nullableNumber(
        row.sourceTimeStart ?? row.source_time_start,
      ),
      sourceTimeEnd: nullableNumber(row.sourceTimeEnd ?? row.source_time_end),
    }));

  const compatibleManifest = <T extends Record<string, unknown>>(
    stored: T[],
    incoming: T[],
    identity: (row: T) => string,
  ) => {
    if (!stored.length) return true;
    const storedHashesByIdentity = new Map<string, Set<string>>();
    const storedMultiplicity = new Map<string, number>();
    const incomingMultiplicity = new Map<string, number>();
    for (const row of stored) {
      const identityKey = identity(row);
      const contentHash = stableHash(row);
      const exactKey = `${identityKey}\u0000${contentHash}`;
      const hashes =
        storedHashesByIdentity.get(identityKey) ?? new Set<string>();
      hashes.add(contentHash);
      storedHashesByIdentity.set(identityKey, hashes);
      storedMultiplicity.set(
        exactKey,
        (storedMultiplicity.get(exactKey) ?? 0) + 1,
      );
    }
    for (const row of incoming) {
      const identityKey = identity(row);
      const contentHash = stableHash(row);
      const storedHashes = storedHashesByIdentity.get(identityKey);
      if (storedHashes && !storedHashes.has(contentHash)) return false;
      const exactKey = `${identityKey}\u0000${contentHash}`;
      incomingMultiplicity.set(
        exactKey,
        (incomingMultiplicity.get(exactKey) ?? 0) + 1,
      );
    }
    for (const [exactKey, requiredCount] of storedMultiplicity) {
      if ((incomingMultiplicity.get(exactKey) ?? 0) < requiredCount) {
        return false;
      }
    }
    return true;
  };

  const storedMediaManifest = manifest(
    storedMedia as unknown as Array<Record<string, unknown>>,
    true,
  );
  const incomingMediaManifest = manifest(point.media, true);
  const incomingBrokeredZstandard = point.evidenceArtifacts.some(
    (artifact) =>
      nullableText(artifact.kind) === "engine_bundle" &&
      nullableText(artifact.remoteEvidenceUploadId) != null,
  );
  const storedArtifactManifest = manifest(
    storedArtifacts.filter(
      (artifact) =>
        !nullableText(artifact.metadata?.archiveMemberPath) &&
        // A legacy remote result may be replayed specifically to replace its
        // imported gzip container with a broker-verified Zstandard archive.
        // Ignore only that obsolete container in replay equivalence; every
        // logical member, manifest, and all presentation evidence must still
        // match exactly before the transaction can bind and retire it.
        !(
          incomingBrokeredZstandard &&
          artifact.kind === "openfoam_bundle" &&
          artifact.mimeType === "application/gzip" &&
          artifact.storageKey.startsWith("sync-imports/") &&
          artifact.storageKey.endsWith(".gz")
        ),
    ) as unknown as Array<Record<string, unknown>>,
  );
  const incomingArtifactManifest = manifest(point.evidenceArtifacts);
  const storedExtentManifest = extentManifest(
    storedExtents as unknown as Array<Record<string, unknown>>,
  );
  const incomingExtentManifest = extentManifest(point.fieldExtents);

  return (
    compatibleManifest(
      storedMediaManifest,
      incomingMediaManifest,
      (row) =>
        `${String(row.kind)}:${String(row.field)}:${String(row.role)}:${String(row.renderProfileKey)}`,
    ) &&
    compatibleManifest(
      storedArtifactManifest,
      incomingArtifactManifest,
      (row) => `${String(row.kind)}:${String(row.field)}:${String(row.role)}`,
    ) &&
    compatibleManifest(
      storedExtentManifest,
      incomingExtentManifest,
      (row) => `${String(row.field)}:${String(row.renderProfileKey)}`,
    )
  );
}

async function importFieldExtentsForResult(opts: {
  database: DB;
  resultId: string;
  resultAttemptId: string;
  airfoilId: string;
  simulationPresetRevisionId: string;
  extents: Record<string, unknown>[];
}) {
  let imported = 0;
  for (const extent of opts.extents) {
    const field = nullableText(extent.field);
    const vmin = nullableNumber(extent.vmin);
    const vmax = nullableNumber(extent.vmax);
    const finiteCount =
      typeof extent.finiteCount === "number"
        ? Math.round(extent.finiteCount)
        : typeof extent.finite_count === "number"
          ? Math.round(extent.finite_count)
          : null;
    const evidenceSha256 = nullableText(
      extent.evidenceSha256 ?? extent.evidence_sha256 ?? extent.sha256,
    );
    if (
      !field ||
      vmin == null ||
      vmax == null ||
      finiteCount == null ||
      !evidenceSha256
    )
      continue;
    const renderProfileKey =
      nullableText(extent.renderProfileKey ?? extent.render_profile_key) ??
      "default:v1:zoom2";
    const association = {
      resultId: opts.resultId,
      resultAttemptId: opts.resultAttemptId,
      airfoilId: opts.airfoilId,
      simulationPresetRevisionId: opts.simulationPresetRevisionId,
      field,
      renderProfileKey,
      vmin,
      vmax,
      finiteCount,
      sourceTimeStart: nullableNumber(
        extent.sourceTimeStart ?? extent.source_time_start,
      ),
      sourceTimeEnd: nullableNumber(
        extent.sourceTimeEnd ?? extent.source_time_end,
      ),
      evidenceSha256,
    };
    const [inserted] = await opts.database
      .insert(resultFieldExtents)
      .values(association)
      .onConflictDoNothing()
      .returning({ id: resultFieldExtents.id });
    if (inserted) {
      imported++;
      continue;
    }
    const [replayed] = await opts.database
      .select()
      .from(resultFieldExtents)
      .where(
        and(
          eq(resultFieldExtents.resultAttemptId, opts.resultAttemptId),
          eq(resultFieldExtents.field, field),
          eq(resultFieldExtents.renderProfileKey, renderProfileKey),
        ),
      )
      .limit(1);
    if (
      !replayed ||
      replayed.resultId !== association.resultId ||
      replayed.airfoilId !== association.airfoilId ||
      replayed.simulationPresetRevisionId !==
        association.simulationPresetRevisionId ||
      replayed.vmin !== association.vmin ||
      replayed.vmax !== association.vmax ||
      replayed.finiteCount !== association.finiteCount ||
      replayed.sourceTimeStart !== association.sourceTimeStart ||
      replayed.sourceTimeEnd !== association.sourceTimeEnd ||
      replayed.evidenceSha256 !== association.evidenceSha256
    ) {
      throw new PolarEvidenceBindingError(
        `field extent ${field} changed immutable exact-attempt metadata`,
      );
    }
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
    const evidenceSignature = nullableText(
      scale.evidenceSignature ?? scale.evidence_signature,
    );
    if (!field || vmin == null || vmax == null || !evidenceSignature) continue;
    const renderProfileKey =
      nullableText(scale.renderProfileKey ?? scale.render_profile_key) ??
      "default:v1:zoom2";
    const scalePolicy =
      nullableText(scale.scalePolicy ?? scale.scale_policy) ?? "track";
    const version =
      typeof scale.version === "number" ? Math.round(scale.version) : 1;
    const active = scale.active !== false;
    const [existingActive] = await db
      .select()
      .from(fieldColorScales)
      .where(
        and(
          eq(fieldColorScales.airfoilId, opts.airfoilId),
          eq(
            fieldColorScales.simulationPresetRevisionId,
            opts.simulationPresetRevisionId,
          ),
          eq(fieldColorScales.field, field),
          eq(fieldColorScales.renderProfileKey, renderProfileKey),
          eq(fieldColorScales.active, true),
        ),
      )
      .limit(1);
    if (
      existingActive &&
      existingActive.evidenceSignature !== evidenceSignature
    ) {
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
        status:
          scale.status === "rebalancing" || scale.status === "staged"
            ? "rebalancing"
            : scale.status === "failed"
              ? "failed"
              : "active",
        version,
        active,
        failureReason: nullableText(
          scale.failureReason ?? scale.failure_reason,
        ),
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
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "mediums",
        naturalKey: "missing-slug",
        incomingPayload: data,
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  const [existing] = await db
    .select()
    .from(mediums)
    .where(eq(mediums.slug, slug))
    .limit(1);
  if (existing) {
    const tableRows = await db
      .select()
      .from(mediumViscosityTablePoints)
      .where(eq(mediumViscosityTablePoints.mediumId, existing.id));
    const localComparable = stableHash(
      mediumComparable({ ...existing, viscosityTable: tableRows }),
    );
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
  const [existing] = await db
    .select({ id: categories.id })
    .from(categories)
    .where(eq(categories.path, path))
    .limit(1);
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
  const [existing] = await db
    .select({ id: hashtags.id })
    .from(hashtags)
    .where(eq(hashtags.slug, slug))
    .limit(1);
  if (existing) return false;
  await db
    .insert(hashtags)
    .values({ slug, name: nullableText(data.name) ?? slug });
  return true;
}

async function importAirfoil(
  data: Record<string, unknown>,
  source: { sourceInstanceId?: string; sourceInstanceName?: string },
): Promise<{ imported: boolean; conflictId?: string }> {
  const slug = nullableText(data.slug);
  if (!slug) {
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "airfoils",
        naturalKey: "missing-slug",
        incomingPayload: data,
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  const [existing] = await db
    .select()
    .from(airfoils)
    .where(eq(airfoils.slug, slug))
    .limit(1);
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
  source: {
    sourceInstanceId?: string | null;
    sourceInstanceName?: string | null;
  },
): Promise<{ imported: boolean; conflictId?: string; revisionId?: string }> {
  if (data.kind !== "simulation_preset_revision") return { imported: false };
  const snapshotRaw = data.snapshot;
  if (
    !snapshotRaw ||
    typeof snapshotRaw !== "object" ||
    Array.isArray(snapshotRaw)
  ) {
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
  const [solverImplementation] = await db
    .select()
    .from(solverImplementations)
    .where(
      snapshot.engine
        ? eq(solverImplementations.key, snapshot.engine.key)
        : eq(solverImplementations.id, OPENCFD_2406_SOLVER_IMPLEMENTATION_ID),
    )
    .limit(1);
  if (
    !solverImplementation ||
    (snapshot.engine &&
      (solverImplementation.family !== snapshot.engine.family ||
        solverImplementation.distribution !== snapshot.engine.distribution ||
        solverImplementation.releaseVersion !==
          snapshot.engine.releaseVersion ||
        solverImplementation.numericsRevision !==
          snapshot.engine.numericsRevision ||
        solverImplementation.adapterContractVersion !==
          snapshot.engine.adapterContractVersion))
  ) {
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "simulation_setup",
        naturalKey: snapshot.engine?.key ?? "legacy-openfoam-opencfd-2406",
        incomingPayload: data,
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  const signatureHash =
    nullableText(data.signatureHash ?? data.signature_hash) ??
    simulationSetupSignature(snapshot);
  const prefix = `remote-${slugPart(source.sourceInstanceId, "upstream")}-${signatureHash.slice(0, 12)}`;
  const mediumSlug =
    nullableText(snapshot.flowState?.mediumSlug) ??
    slugPart(snapshot.flowState?.mediumName, "medium");
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
      speedOfSound:
        snapshot.flowState.mach && snapshot.flowState.mach > 0
          ? snapshot.flowState.speedMps / snapshot.flowState.mach
          : null,
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
      solverImplementationId: solverImplementation.id,
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
        solverImplementationId: solverImplementation.id,
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
    preset: {
      ...snapshot.preset,
      slug: `${prefix}-preset`,
      legacyBoundaryConditionId: legacy.id,
      enabled: false,
    },
    flowState: { ...snapshot.flowState, mediumId: medium.id },
  };
  const [preset] = await db
    .insert(simulationPresets)
    .values({
      slug: `${prefix}-preset`,
      name:
        snapshot.preset.name || `Remote preset ${signatureHash.slice(0, 8)}`,
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
  const physicsHash = physicsHashForSnapshot(localSnapshot);
  const methodCompatibilityHash =
    methodCompatibilityHashForSnapshot(localSnapshot);
  const revisionNumber = Math.max(
    1,
    Math.round(
      numberWithFallback(data.revisionNumber ?? data.revision_number, 1),
    ),
  );
  const [revision] = await db
    .insert(simulationPresetRevisions)
    .values({
      presetId: preset.id,
      revisionNumber,
      signatureHash,
      reynolds: Math.round(
        numberWithFallback(data.reynolds, snapshot.derived.reynolds),
      ),
      mach: nullableNumber(data.mach) ?? snapshot.derived.mach,
      referenceLengthM: numberWithFallback(
        data.referenceLengthM ?? data.reference_length_m,
        snapshot.referenceGeometry.referenceLengthM,
      ),
      snapshot: localSnapshot as unknown as Record<string, unknown>,
      physicsHash,
      solverImplementationId: solverImplementation.id,
      methodCompatibilityHashVersion: METHOD_COMPATIBILITY_HASH_VERSION,
      methodCompatibilityHash,
    })
    .onConflictDoNothing({
      target: [
        simulationPresetRevisions.presetId,
        simulationPresetRevisions.signatureHash,
      ],
    })
    .returning({ id: simulationPresetRevisions.id });
  const existingRevision = revision?.id
    ? null
    : (
        await db
          .select({
            id: simulationPresetRevisions.id,
            physicsHash: simulationPresetRevisions.physicsHash,
            methodCompatibilityHash:
              simulationPresetRevisions.methodCompatibilityHash,
            snapshot: simulationPresetRevisions.snapshot,
          })
          .from(simulationPresetRevisions)
          .where(
            and(
              eq(simulationPresetRevisions.presetId, preset.id),
              eq(simulationPresetRevisions.signatureHash, signatureHash),
            ),
          )
          .limit(1)
      )[0];
  const revisionId = revision?.id ?? existingRevision?.id;
  // Older sync-imported rows can predate physicsHash. Derive the rollout
  // repair from their immutable stored snapshot, never the incoming payload.
  if (
    existingRevision &&
    (!existingRevision.physicsHash ||
      (localSnapshot.engine && !existingRevision.methodCompatibilityHash))
  ) {
    const storedSnapshot =
      existingRevision.snapshot as unknown as SimulationSetupSnapshot;
    const storedMethodHash = storedSnapshot.engine
      ? methodCompatibilityHashForSnapshot(storedSnapshot)
      : null;
    await db
      .update(simulationPresetRevisions)
      .set({
        physicsHash: physicsHashForSnapshot(storedSnapshot),
        ...(storedMethodHash
          ? {
              solverImplementationId: solverImplementation.id,
              methodCompatibilityHashVersion: METHOD_COMPATIBILITY_HASH_VERSION,
              methodCompatibilityHash: storedMethodHash,
            }
          : {}),
      })
      .where(eq(simulationPresetRevisions.id, existingRevision.id));
  }
  return { imported: Boolean(revision?.id), revisionId };
}

class UnsafePolarConflictPromotionError extends Error {}

async function promotePolarConflict(
  conflict: typeof syncImportConflicts.$inferSelect,
) {
  throw new UnsafePolarConflictPromotionError(
    "legacy polar conflict promotion cannot publish an exact generation because complete bytes were not retained; re-push through /api/sync/v1/polars",
  );
  /* c8 ignore start -- retained temporarily only to keep historical conflict
   * payload parsing legible while existing rows are archived/re-pushed. */
  const [airfoilId, revisionId, ...aoaParts] = conflict.naturalKey.split(":");
  const aoaDeg = Number(aoaParts.join(":"));
  if (!airfoilId || !revisionId || !Number.isFinite(aoaDeg)) {
    throw new Error("polar conflict natural key is not promotable");
  }
  const point = polarPointSchema.parse(conflict.incomingPayload);
  const sourceInstanceId = syncIdentityToken(
    conflict.sourceInstanceId ?? "",
    "sourceInstanceId",
  );
  const rawEngineJobId = point.engineJobId ?? `promoted-${conflict.id}`;
  const importedEngineJobId = `sync:${sourceInstanceId}:${syncIdentityToken(
    rawEngineJobId,
    "engineJobId",
  )}`;
  if (
    point.evidenceArtifacts.length > 0 ||
    point.media.length > 0 ||
    point.fieldExtents.length > 0
  ) {
    throw new UnsafePolarConflictPromotionError(
      "polar conflict carries artifacts, media, or field extents whose bytes were not retained; push the evidence again instead of promoting metadata",
    );
  }

  const [initialExisting] = await db
    .select()
    .from(results)
    .where(
      and(
        eq(results.airfoilId, airfoilId),
        eq(results.simulationPresetRevisionId, revisionId),
        eq(results.aoaDeg, aoaDeg),
      ),
    )
    .limit(1);
  let bcId: string | null = initialExisting?.bcId ?? null;
  if (!bcId) {
    const [revision] = await db
      .select()
      .from(simulationPresetRevisions)
      .where(eq(simulationPresetRevisions.id, revisionId))
      .limit(1);
    const snapshot = jsonObject(revision?.snapshot);
    bcId = nullableText(jsonObject(snapshot.preset).legacyBoundaryConditionId);
  }
  if (!bcId) throw new Error("polar conflict cannot resolve boundary/setup id");
  const runtime = await resolveEngineRuntimeBuild(db, point.engine);
  const resultValues = remoteResultValues(
    point,
    bcId as string,
    importedEngineJobId,
    runtime,
  );
  const { regime: attemptRegime, values: attemptValues } = remoteAttemptValues({
    point,
    airfoilId,
    bcId: bcId as string,
    revisionId,
    engineJobId: importedEngineJobId,
    runtime,
  });

  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sync-polar-cell:${airfoilId}:${revisionId}:${aoaDeg}`}, 0))`,
    );
    const [existingRef] = await tx
      .select({ id: results.id })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, airfoilId),
          eq(results.simulationPresetRevisionId, revisionId),
          eq(results.aoaDeg, aoaDeg),
        ),
      )
      .limit(1);
    if (existingRef) await acquireResultEvidenceLocks(tx, [existingRef.id]);

    let [canonical] = existingRef
      ? await tx
          .select()
          .from(results)
          .where(eq(results.id, existingRef.id))
          .for("update")
          .limit(1)
      : [];
    if (canonical) {
      const [evidence] = (await tx.execute(sql`
        SELECT (
          EXISTS (SELECT 1 FROM solver_evidence_artifacts WHERE result_id = ${canonical.id})
          OR EXISTS (SELECT 1 FROM result_media WHERE result_id = ${canonical.id})
          OR EXISTS (SELECT 1 FROM force_history WHERE result_id = ${canonical.id})
          OR EXISTS (SELECT 1 FROM result_field_extents WHERE result_id = ${canonical.id})
          OR EXISTS (SELECT 1 FROM remote_asset_references WHERE result_id = ${canonical.id})
        ) AS has_presentation_or_artifact_evidence
      `)) as unknown as Array<{
        has_presentation_or_artifact_evidence: boolean;
      }>;
      if (evidence?.has_presentation_or_artifact_evidence) {
        throw new UnsafePolarConflictPromotionError(
          "polar conflict promotion would attach existing local artifacts or presentation evidence to different remote truth; archive it or re-import into a clean cell",
        );
      }
      await tx
        .update(results)
        .set(resultValues)
        .where(eq(results.id, canonical.id));
    } else {
      [canonical] = await tx
        .insert(results)
        .values({
          airfoilId,
          simulationPresetRevisionId: revisionId,
          aoaDeg,
          ...resultValues,
        })
        .returning();
      await acquireResultEvidenceLocks(tx, [canonical.id]);
    }

    const [existingAttempt] = await tx
      .select()
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.engineJobId, importedEngineJobId),
          eq(resultAttempts.aoaDeg, aoaDeg),
          eq(resultAttempts.regime, attemptRegime),
          sql`${resultAttempts.engineCaseSlug} IS NOT DISTINCT FROM ${point.engineCaseSlug ?? null}`,
          isNull(resultAttempts.simJobId),
        ),
      )
      .limit(1);
    if (existingAttempt) {
      const sameAttempt =
        existingAttempt.resultId === canonical.id &&
        stableHash(
          comparableRemoteAttempt(
            existingAttempt as unknown as Record<string, unknown>,
          ),
        ) ===
          stableHash(
            comparableRemoteAttempt(
              attemptValues as unknown as Record<string, unknown>,
            ),
          );
      if (!sameAttempt) {
        throw new UnsafePolarConflictPromotionError(
          "the namespaced remote attempt identity already belongs to different evidence",
        );
      }
    } else {
      await tx.insert(resultAttempts).values({
        resultId: canonical.id,
        ...attemptValues,
        solvedAt: point.status === "done" ? new Date() : null,
      });
    }

    if (point.forceHistory) {
      await tx.insert(forceHistory).values({
        resultId: canonical.id,
        t: point.forceHistory.t,
        cl: point.forceHistory.cl,
        cd: point.forceHistory.cd,
        cm: point.forceHistory.cm ?? null,
        clMean: point.forceHistory.clMean ?? null,
        clRms: point.forceHistory.clRms ?? null,
        cdMean: point.forceHistory.cdMean ?? null,
        cdRms: point.forceHistory.cdRms ?? null,
        strouhal: point.forceHistory.strouhal ?? null,
        sheddingFreqHz: point.forceHistory.sheddingFreqHz ?? null,
        sampleCount: point.forceHistory.sampleCount ?? null,
      });
    }
    const promoted = await tx
      .update(syncImportConflicts)
      .set({
        status: "promoted",
        resolvedAt: new Date(),
        resolutionNote: "promoted by admin",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(syncImportConflicts.id, conflict.id),
          eq(syncImportConflicts.status, "pending"),
        ),
      )
      .returning({ id: syncImportConflicts.id });
    if (promoted.length !== 1) {
      throw new UnsafePolarConflictPromotionError(
        "polar conflict changed state during promotion",
      );
    }
  });
  await refreshPolarCacheForRevision(db, airfoilId, revisionId);
  /* c8 ignore stop */
}

interface HubBindingReceipt {
  schemaVersion: 1;
  kind: "hub-canonical-evidence-binding";
  promiseId: string;
  aoaDeg: number;
  remoteResultId: string;
  remoteResultAttemptId: string;
  engineJobId: string;
  engineCaseSlug: string | null;
  brokeredUploadId: string;
  bindingState: "bound";
  promisePointState: "fulfilled";
  remote: {
    bucket: string;
    objectKey: string;
    generation: string;
    crc32c: string;
    storedSha256: string;
    storedByteSize: number;
    tarSha256: string;
    tarByteSize: number;
    manifestSha256: string;
    manifestByteSize: number;
    zstdLevel: number;
    bundledFileCount: number;
  };
  canonical: {
    resultId: string;
    resultAttemptId: string;
    artifactId: string;
  };
  boundAt: string;
  fulfilledAt: string;
}

async function importPolarPush(
  payload: PolarPushPayload,
  files: Map<string, UploadedFileRef>,
  capacityReservation?: SyncUploadCapacityReservation | null,
): Promise<{
  imported: number;
  attempts: number;
  artifacts: number;
  media: number;
  fieldExtents: number;
  fieldColorScales: number;
  conflictIds: string[];
  promiseId: string | null;
  fulfilledAoas: number[];
  unfulfilledAoas: number[];
  bindingReceipts: HubBindingReceipt[];
}> {
  await expirePromises();
  const conflictIds: string[] = [];
  let imported = 0;
  let attempts = 0;
  let artifacts = 0;
  let media = 0;
  let fieldExtents = 0;
  let importedFieldColorScales = 0;
  const fulfilledAoas: number[] = [];
  const unfulfilledAoas: number[] = [];
  const bindingReceipts: HubBindingReceipt[] = [];
  let airfoilId: string | null = null;
  let revisionId: string | null = null;
  let bcId: string | null = payload.bcId ?? null;
  let promise: typeof syncSweepPromises.$inferSelect | null = null;

  if (payload.promiseId) {
    [promise] = await db
      .select()
      .from(syncSweepPromises)
      .where(eq(syncSweepPromises.id, payload.promiseId))
      .limit(1);
    // Fulfilled/expired promises still identify their scope and the ingest is
    // idempotent — LATE chunks must land (validation incident 2026-07-11: a
    // ladder child's /complete fulfilled the promise after shipping 1 of 3
    // alphas; the parent's remaining chunks were then rejected forever and
    // the hub re-promised work the solver had already finished). Only a
    // cancelled or unknown promise rejects.
    if (!promise || promise.status === "cancelled") {
      throw new PolarPromiseScopeError("promise is not active");
    }
    if (
      promise.sourceInstanceId &&
      payload.sourceInstanceId &&
      promise.sourceInstanceId !== payload.sourceInstanceId
    ) {
      throw new PolarPromiseScopeError(
        "push source instance does not own this promise",
      );
    }
    airfoilId = promise.airfoilId;
    revisionId = promise.simulationPresetRevisionId;
  } else if (payload.airfoilSlug) {
    const [airfoil] = await db
      .select({ id: airfoils.id })
      .from(airfoils)
      .where(eq(airfoils.slug, payload.airfoilSlug))
      .limit(1);
    airfoilId = airfoil?.id ?? null;
    if (payload.simulationPresetRevisionId)
      revisionId = payload.simulationPresetRevisionId;
    if (!revisionId && payload.simulationPresetSignatureHash) {
      const [revision] = await db
        .select({ id: simulationPresetRevisions.id })
        .from(simulationPresetRevisions)
        .where(
          eq(
            simulationPresetRevisions.signatureHash,
            payload.simulationPresetSignatureHash,
          ),
        )
        .limit(1);
      revisionId = revision?.id ?? null;
    }
  }
  if (!airfoilId || !revisionId) {
    conflictIds.push(
      await createConflict({
        dataType: "polars",
        naturalKey:
          payload.promiseId ??
          `${payload.airfoilSlug ?? "unknown"}:${payload.simulationPresetSignatureHash ?? payload.simulationPresetRevisionId ?? "unknown"}`,
        incomingPayload: payload as unknown as Record<string, unknown>,
        sourceInstanceId: payload.sourceInstanceId,
        sourceInstanceName: payload.sourceInstanceName,
      }),
    );
    return {
      imported,
      attempts,
      artifacts,
      media,
      fieldExtents,
      fieldColorScales: importedFieldColorScales,
      conflictIds,
      promiseId: payload.promiseId ?? null,
      fulfilledAoas,
      unfulfilledAoas,
      bindingReceipts,
    };
  }

  const [revision] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, revisionId))
    .limit(1);
  const snapshot = jsonObject(revision?.snapshot);
  const snapshotPreset = jsonObject(snapshot.preset);
  // Never trust a pushing instance's bc id blindly: remote solvers send THEIR
  // database's uuid (validation incident 2026-07-11 — the Mac's local bc id
  // hit results_bc_id fk on the hub with a 500 on every chunk). Accept the
  // pushed id only if it exists HERE (same-instance/legacy pushes); otherwise
  // resolve the hub's own legacy bc from the revision snapshot.
  if (bcId) {
    const [localBc] = await db
      .select({ id: boundaryConditions.id })
      .from(boundaryConditions)
      .where(eq(boundaryConditions.id, bcId))
      .limit(1);
    if (!localBc) bcId = null;
  }
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
    return {
      imported,
      attempts,
      artifacts,
      media,
      fieldExtents,
      fieldColorScales: importedFieldColorScales,
      conflictIds,
      promiseId: payload.promiseId ?? null,
      fulfilledAoas,
      unfulfilledAoas,
      bindingReceipts,
    };
  }
  const rawSourceInstanceId =
    promise?.sourceInstanceId?.trim() || payload.sourceInstanceId?.trim();
  if (!rawSourceInstanceId) {
    throw new PolarPromiseScopeError(
      "polar push requires attributable sourceInstanceId",
    );
  }
  const sourceInstanceId = syncIdentityToken(
    rawSourceInstanceId,
    "sourceInstanceId",
  );

  // Validate the ENTIRE promised batch before any canonical row, attempt,
  // artifact, media, or shared field-scale write. A mixed [owned, foreign]
  // payload is one rejected request, never a partially imported promise.
  if (payload.promiseId) {
    const pushedAoas = payload.results.map((point) => point.aoaDeg);
    if (new Set(pushedAoas).size !== pushedAoas.length) {
      throw new PolarPromiseScopeError(
        `promise ${payload.promiseId} push repeats an AoA`,
      );
    }
    const ownedPoints = await db
      .select({ aoaDeg: syncSweepPromisePoints.aoaDeg })
      .from(syncSweepPromisePoints)
      .where(
        and(
          eq(syncSweepPromisePoints.promiseId, payload.promiseId),
          eq(syncSweepPromisePoints.airfoilId, airfoilId),
          eq(syncSweepPromisePoints.simulationPresetRevisionId, revisionId),
          inArray(syncSweepPromisePoints.aoaDeg, pushedAoas),
          inArray(syncSweepPromisePoints.status, [
            "active",
            "expired",
            "fulfilled",
          ]),
        ),
      );
    const ownedAoas = new Set(ownedPoints.map((point) => point.aoaDeg));
    const foreignAoa = pushedAoas.find((aoa) => !ownedAoas.has(aoa));
    if (foreignAoa !== undefined) {
      throw new PolarPromiseScopeError(
        `promise ${payload.promiseId} does not own pushed point ${foreignAoa}`,
      );
    }
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

  const committedPoints: Array<{
    aoaDeg: number;
    resultId: string;
    attemptId: string;
    observedCurrentAttemptId: string | null;
    incomingResult: Partial<typeof results.$inferInsert>;
    regime: "rans" | "urans";
    fidelity: string | null;
    brokeredUploadId: string | null;
  }> = [];
  for (const point of payload.results) {
    const runtime = await resolveEngineRuntimeBuild(db, point.engine);
    const rawEngineJobId =
      point.engineJobId ?? payload.promiseId ?? "direct-push";
    const importedEngineJobId = `sync:${sourceInstanceId}:${syncIdentityToken(
      rawEngineJobId,
      "engineJobId",
    )}`;
    const incomingResult: Partial<typeof results.$inferInsert> =
      remoteResultValues(point, bcId, importedEngineJobId, runtime);
    const { regime: attemptRegime, values: attemptValues } =
      remoteAttemptValues({
        point,
        airfoilId,
        bcId,
        revisionId,
        engineJobId: importedEngineJobId,
        runtime,
      });
    const insertAttemptForResult = async (tx: DB, resultId: string) => {
      const [existingAttempt] = await tx
        .select()
        .from(resultAttempts)
        .where(
          and(
            eq(resultAttempts.engineJobId, importedEngineJobId),
            eq(resultAttempts.aoaDeg, point.aoaDeg),
            eq(resultAttempts.regime, attemptRegime),
            sql`${resultAttempts.engineCaseSlug} IS NOT DISTINCT FROM ${point.engineCaseSlug ?? null}`,
            isNull(resultAttempts.simJobId),
          ),
        )
        .limit(1);
      if (existingAttempt) {
        if (existingAttempt.resultId !== resultId) {
          return { kind: "conflict" as const, attempt: existingAttempt };
        }
        if (
          stableHash(
            comparableRemoteAttempt(
              existingAttempt as unknown as Record<string, unknown>,
            ),
          ) !==
          stableHash(
            comparableRemoteAttempt(attemptValues as Record<string, unknown>),
          )
        ) {
          return { kind: "conflict" as const, attempt: existingAttempt };
        }
        return {
          kind: "existing" as const,
          attempt: { id: existingAttempt.id },
        };
      }
      const [attempt] = await tx
        .insert(resultAttempts)
        .values({
          resultId,
          ...attemptValues,
          solvedAt: point.status === "done" ? new Date() : null,
        })
        .returning({ id: resultAttempts.id });
      return { kind: "inserted" as const, attempt };
    };
    // Resolve inline/file payloads before acquiring DB evidence locks. File
    // objects are content-addressed; only the DB association is serialized.
    const preparedArtifacts: Array<{
      artifact: Record<string, unknown>;
      stored: UploadedFileRef;
    }> = [];
    for (const artifact of point.evidenceArtifacts) {
      preparedArtifacts.push({
        artifact,
        stored: await resolveUploadedArtifact(
          artifact,
          files,
          capacityReservation,
        ),
      });
    }
    const preparedMedia: Array<{
      item: Record<string, unknown>;
      stored: UploadedFileRef;
    }> = [];
    for (const item of point.media) {
      preparedMedia.push({
        item,
        stored: await resolveUploadedArtifact(item, files, capacityReservation),
      });
    }
    const manifests = preparedArtifacts.filter(
      ({ artifact }) => nullableText(artifact.kind) === "manifest",
    );
    if (manifests.length > 1) {
      throw new PolarEvidenceBindingError(
        `point ${point.aoaDeg} must carry at most one exact-attempt manifest`,
      );
    }
    const manifestSha256 = manifests[0]?.stored.sha256 ?? null;
    if (manifests[0] && manifests[0].stored.byteSize <= 0) {
      throw new PolarEvidenceBindingError(
        `point ${point.aoaDeg} exact-attempt manifest is empty`,
      );
    }
    if (
      (preparedMedia.length > 0 || point.fieldExtents.length > 0) &&
      !manifestSha256
    ) {
      throw new PolarEvidenceBindingError(
        `point ${point.aoaDeg} presentation evidence lacks an exact-attempt manifest`,
      );
    }
    for (const { item } of preparedMedia) {
      const evidenceSha256 = nullableText(
        item.evidenceSha256 ?? item.evidence_sha256,
      );
      if (!evidenceSha256 || evidenceSha256 !== manifestSha256) {
        throw new PolarEvidenceBindingError(
          `point ${point.aoaDeg} media evidence signature does not match its exact-attempt manifest`,
        );
      }
    }
    for (const extent of point.fieldExtents) {
      const evidenceSha256 = nullableText(
        extent.evidenceSha256 ?? extent.evidence_sha256 ?? extent.sha256,
      );
      if (!evidenceSha256 || evidenceSha256 !== manifestSha256) {
        throw new PolarEvidenceBindingError(
          `point ${point.aoaDeg} field extent evidence signature does not match its exact-attempt manifest`,
        );
      }
    }
    const preparedBrokeredArchive =
      await prepareBrokeredArchiveRegistration(preparedArtifacts);
    const resolution = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      const orderedArtifactKeys = [...preparedArtifacts].sort((a, b) =>
        `${a.stored.storageKey}:${a.stored.sha256}`.localeCompare(
          `${b.stored.storageKey}:${b.stored.sha256}`,
        ),
      );
      for (const prepared of orderedArtifactKeys) {
        await acquireEvidenceArtifactKeyLock(
          tx,
          prepared.stored.storageKey,
          prepared.stored.sha256,
        );
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`sync-polar-cell:${airfoilId}:${revisionId}:${point.aoaDeg}`}, 0))`,
      );
      const brokeredArtifacts = preparedArtifacts.filter(
        ({ stored }) => stored.brokeredUploadId,
      );
      if (brokeredArtifacts.length > 1) {
        throw new PolarEvidenceBindingError(
          `point ${point.aoaDeg} carries more than one brokered engine bundle`,
        );
      }
      for (const { stored } of brokeredArtifacts) {
        const [upload] = await tx
          .select()
          .from(syncBrokeredEvidenceUploads)
          .where(eq(syncBrokeredEvidenceUploads.id, stored.brokeredUploadId!))
          .for("update")
          .limit(1);
        if (
          !upload ||
          !payload.promiseId ||
          upload.promiseId !== payload.promiseId ||
          upload.sourceInstanceId !== sourceInstanceId ||
          upload.remoteResultId !== point.remoteResultId ||
          upload.remoteResultAttemptId !== point.remoteResultAttemptId ||
          upload.aoaDeg !== point.aoaDeg ||
          upload.engineJobId !== point.engineJobId ||
          upload.engineCaseSlug !== (point.engineCaseSlug ?? null) ||
          !["verified", "bound"].includes(upload.state)
        ) {
          throw new PolarEvidenceBindingError(
            `point ${point.aoaDeg} does not own the exact verified brokered evidence generation`,
          );
        }
      }
      // Global lock order: immutable blob identities -> natural cell ->
      // current result evidence -> canonical row FOR UPDATE. Blob bytes may
      // have many owner associations, so an existing association on another
      // result is reuse, not an ownership conflict.
      const [existingRef] = await tx
        .select({ id: results.id })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, airfoilId),
            eq(results.simulationPresetRevisionId, revisionId),
            eq(results.aoaDeg, point.aoaDeg),
          ),
        )
        .limit(1);
      if (existingRef) {
        await acquireResultEvidenceLocks(tx, [existingRef.id]);
      }

      let [existing] = existingRef
        ? await tx
            .select()
            .from(results)
            .where(eq(results.id, existingRef.id))
            .for("update")
            .limit(1)
        : [];

      const [ownedGeneration] =
        existing && payload.promiseId
          ? await tx
              .select({
                id: syncSweepPromisePoints.id,
                regime: resultAttempts.regime,
                fidelity: sql<
                  string | null
                >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
              })
              .from(syncSweepPromisePoints)
              .innerJoin(
                resultAttempts,
                and(
                  eq(resultAttempts.id, syncSweepPromisePoints.resultAttemptId),
                  eq(resultAttempts.resultId, existing.id),
                ),
              )
              .where(
                and(
                  eq(syncSweepPromisePoints.promiseId, payload.promiseId),
                  eq(syncSweepPromisePoints.airfoilId, airfoilId),
                  eq(
                    syncSweepPromisePoints.simulationPresetRevisionId,
                    revisionId,
                  ),
                  eq(syncSweepPromisePoints.aoaDeg, point.aoaDeg),
                  eq(syncSweepPromisePoints.resultId, existing.id),
                  existing.currentResultAttemptId
                    ? eq(
                        syncSweepPromisePoints.resultAttemptId,
                        existing.currentResultAttemptId,
                      )
                    : sql`false`,
                ),
              )
              .limit(1)
          : [];
      const priorFidelity =
        ownedGeneration?.fidelity ??
        (ownedGeneration?.regime === "rans" ? "rans" : null);
      const incomingFidelity =
        point.fidelity ?? (attemptRegime === "rans" ? "rans" : null);
      const ownedContinuation =
        (priorFidelity === "rans" && incomingFidelity === "urans_precalc") ||
        (priorFidelity === "urans_precalc" &&
          incomingFidelity === "urans_full");
      const [exactReplayAttempt] = existing
        ? await tx
            .select({ id: resultAttempts.id })
            .from(resultAttempts)
            .where(
              and(
                eq(resultAttempts.resultId, existing.id),
                isNull(resultAttempts.simJobId),
                eq(resultAttempts.engineJobId, importedEngineJobId),
                sql`${resultAttempts.engineCaseSlug} IS NOT DISTINCT FROM ${point.engineCaseSlug ?? null}`,
                eq(resultAttempts.aoaDeg, point.aoaDeg),
                eq(resultAttempts.regime, attemptRegime),
              ),
            )
            .limit(1)
        : [];

      let kind: "imported" | "equivalent" = "imported";
      let createdResult = false;
      if (!existing) {
        [existing] = await tx
          .insert(results)
          .values({
            airfoilId,
            bcId,
            simulationPresetRevisionId: revisionId,
            aoaDeg: point.aoaDeg,
            status: "pending",
            source: "queued",
          } as typeof results.$inferInsert)
          .returning();
        createdResult = true;
        await acquireResultEvidenceLocks(tx, [existing.id]);
      } else if (equivalentResult(existing, point)) {
        if (!ownedContinuation && !exactReplayAttempt) {
          return { kind: "conflict" as const, existing };
        }
        if (
          !(await equivalentStoredResultEvidence(tx, existing.id, point, {
            engineJobId: importedEngineJobId,
            engineCaseSlug: point.engineCaseSlug ?? null,
            regime: attemptRegime,
            manifestSha256,
          }))
        ) {
          return { kind: "conflict" as const, existing };
        }
        kind = "equivalent";
      } else {
        const noCoefficientTruth = [
          existing.cl,
          existing.cd,
          existing.cm,
          existing.clCd,
          existing.clStd,
          existing.cdStd,
          existing.cmStd,
        ].every((value) => value == null);
        if (ownedContinuation) {
          // The same authoritative promise may advance only along the exact
          // three-stage fidelity rail: RANS -> PRECALC -> FULL. Physical
          // `regime` can remain RANS for a no-shedding URANS solve, so fidelity
          // is the generation authority. Exact replay is handled separately;
          // skipped stages and competing generations still conflict below.
          kind = "equivalent";
        }
        const scheduledPlaceholder =
          existing.currentResultAttemptId == null &&
          ["pending", "stale"].includes(existing.status) &&
          noCoefficientTruth;
        if (!ownedContinuation && !scheduledPlaceholder) {
          return { kind: "conflict" as const, existing };
        }
      }

      const observedCurrentAttemptId = existing.currentResultAttemptId;

      const attemptResolution = await insertAttemptForResult(tx, existing.id);
      if (attemptResolution.kind === "conflict") {
        return { kind: "conflict" as const, existing };
      }
      const attempt = attemptResolution.attempt;
      const artifactAssociationFor = ({
        artifact,
        stored,
      }: (typeof preparedArtifacts)[number]) => ({
        resultId: existing.id,
        resultAttemptId: attempt.id,
        airfoilId,
        simJobId: null,
        engineJobId: importedEngineJobId,
        engineCaseSlug: point.engineCaseSlug ?? null,
        methodKey: point.methodKey ?? null,
        solverImplementationId: runtime?.solverImplementationId ?? null,
        solverRuntimeBuildId: runtime?.solverRuntimeBuildId ?? null,
        aoaDeg: point.aoaDeg,
        kind: (nullableText(artifact.kind) ?? "field_data") as never,
        field: nullableText(artifact.field),
        role: nullableText(artifact.role),
        storageKey: stored.storageKey,
        mimeType: nullableText(artifact.mimeType) ?? stored.mimeType,
        sha256: stored.sha256,
        byteSize: stored.byteSize,
        metadata: {
          ...jsonObject(artifact.metadata),
          sourceInstanceId,
          ...(stored.brokeredUploadId
            ? { remoteEvidenceUploadId: stored.brokeredUploadId }
            : {}),
        },
      });
      let replayedExistingManifest = false;
      let replayedExistingManifestArtifactId: string | null = null;
      if (attemptResolution.kind === "existing") {
        const storedManifests = await tx
          .select()
          .from(solverEvidenceArtifacts)
          .where(
            and(
              eq(solverEvidenceArtifacts.resultId, existing.id),
              eq(solverEvidenceArtifacts.resultAttemptId, attempt.id),
              eq(solverEvidenceArtifacts.kind, "manifest"),
            ),
          )
          .orderBy(solverEvidenceArtifacts.id);
        if (storedManifests.length > 1) {
          return { kind: "conflict" as const, existing };
        }
        const [storedManifest] = storedManifests;
        const [preparedManifest] = manifests;
        if (storedManifest) {
          if (!preparedManifest) {
            return { kind: "conflict" as const, existing };
          }
          const incomingManifest = artifactAssociationFor(preparedManifest);
          if (
            storedManifest.resultId !== incomingManifest.resultId ||
            storedManifest.resultAttemptId !==
              incomingManifest.resultAttemptId ||
            storedManifest.airfoilId !== incomingManifest.airfoilId ||
            storedManifest.simJobId !== incomingManifest.simJobId ||
            storedManifest.engineJobId !== incomingManifest.engineJobId ||
            storedManifest.engineCaseSlug !== incomingManifest.engineCaseSlug ||
            storedManifest.methodKey !== incomingManifest.methodKey ||
            storedManifest.solverImplementationId !==
              incomingManifest.solverImplementationId ||
            storedManifest.solverRuntimeBuildId !==
              incomingManifest.solverRuntimeBuildId ||
            storedManifest.aoaDeg !== incomingManifest.aoaDeg ||
            storedManifest.field !== incomingManifest.field ||
            storedManifest.role !== incomingManifest.role ||
            storedManifest.storageKey !== incomingManifest.storageKey ||
            storedManifest.mimeType !== incomingManifest.mimeType ||
            storedManifest.sha256 !== incomingManifest.sha256 ||
            storedManifest.byteSize !== incomingManifest.byteSize ||
            stableHash(storedManifest.metadata ?? {}) !==
              stableHash(incomingManifest.metadata)
          ) {
            return { kind: "conflict" as const, existing };
          }
          replayedExistingManifest = true;
          replayedExistingManifestArtifactId = storedManifest.id;
        }
      }
      const importedExtents = await importFieldExtentsForResult({
        database: tx,
        resultId: existing.id,
        resultAttemptId: attempt.id,
        airfoilId,
        simulationPresetRevisionId: revisionId,
        extents: point.fieldExtents,
      });
      let canonicalManifestArtifactId = replayedExistingManifestArtifactId;
      let canonicalBrokeredSourceArtifactId: string | null = null;
      for (const preparedArtifact of preparedArtifacts) {
        const association = artifactAssociationFor(preparedArtifact);
        if (replayedExistingManifest && association.kind === "manifest") {
          continue;
        }
        if (preparedArtifact.stored.brokeredUploadId) {
          const [boundUpload] = await tx
            .select()
            .from(syncBrokeredEvidenceUploads)
            .where(
              eq(
                syncBrokeredEvidenceUploads.id,
                preparedArtifact.stored.brokeredUploadId,
              ),
            )
            .for("update")
            .limit(1);
          if (boundUpload?.state === "bound") {
            const [replayed] = boundUpload.canonicalArtifactId
              ? await tx
                  .select()
                  .from(solverEvidenceArtifacts)
                  .where(
                    eq(
                      solverEvidenceArtifacts.id,
                      boundUpload.canonicalArtifactId,
                    ),
                  )
                  .limit(1)
              : [];
            if (
              !replayed ||
              replayed.resultId !== association.resultId ||
              replayed.resultAttemptId !== association.resultAttemptId ||
              replayed.airfoilId !== association.airfoilId ||
              replayed.simJobId !== association.simJobId ||
              replayed.engineJobId !== association.engineJobId ||
              replayed.engineCaseSlug !== association.engineCaseSlug ||
              replayed.methodKey !== association.methodKey ||
              replayed.solverImplementationId !==
                association.solverImplementationId ||
              replayed.solverRuntimeBuildId !==
                association.solverRuntimeBuildId ||
              replayed.aoaDeg !== association.aoaDeg ||
              replayed.kind !== association.kind ||
              replayed.field !== association.field ||
              replayed.role !== association.role ||
              replayed.storageKey !== association.storageKey ||
              replayed.mimeType !== association.mimeType ||
              replayed.sha256 !== association.sha256 ||
              replayed.byteSize !== association.byteSize ||
              stableHash(replayed.metadata ?? {}) !==
                stableHash(association.metadata)
            ) {
              throw new PolarEvidenceBindingError(
                "bound brokered evidence generation changed its canonical artifact",
              );
            }
            canonicalBrokeredSourceArtifactId = replayed.id;
            continue;
          }
        }
        const [insertedAssociation] = await tx
          .insert(solverEvidenceArtifacts)
          .values(association)
          .onConflictDoNothing()
          .returning({ id: solverEvidenceArtifacts.id });
        let canonicalArtifactId = insertedAssociation?.id ?? null;
        if (!insertedAssociation) {
          const [replayed] = await tx
            .select()
            .from(solverEvidenceArtifacts)
            .where(
              and(
                eq(solverEvidenceArtifacts.resultAttemptId, attempt.id),
                eq(solverEvidenceArtifacts.kind, association.kind),
                sql`${solverEvidenceArtifacts.field} IS NOT DISTINCT FROM ${association.field}`,
                sql`${solverEvidenceArtifacts.role} IS NOT DISTINCT FROM ${association.role}`,
                eq(solverEvidenceArtifacts.storageKey, association.storageKey),
                eq(solverEvidenceArtifacts.sha256, association.sha256),
              ),
            )
            .limit(1);
          if (
            !replayed ||
            replayed.resultId !== association.resultId ||
            replayed.airfoilId !== association.airfoilId ||
            replayed.engineJobId !== association.engineJobId ||
            replayed.engineCaseSlug !== association.engineCaseSlug ||
            replayed.methodKey !== association.methodKey ||
            replayed.solverImplementationId !==
              association.solverImplementationId ||
            replayed.solverRuntimeBuildId !==
              association.solverRuntimeBuildId ||
            replayed.aoaDeg !== association.aoaDeg ||
            replayed.mimeType !== association.mimeType ||
            replayed.byteSize !== association.byteSize ||
            stableHash(replayed.metadata ?? {}) !==
              stableHash(association.metadata)
          ) {
            throw new PolarEvidenceBindingError(
              `point ${point.aoaDeg} exact-attempt artifact association changed immutable metadata`,
            );
          }
          canonicalArtifactId = replayed.id;
        }
        if (association.kind === "manifest") {
          canonicalManifestArtifactId = canonicalArtifactId;
        }
        if (preparedArtifact.stored.brokeredUploadId) {
          const [upload] = await tx
            .select()
            .from(syncBrokeredEvidenceUploads)
            .where(
              eq(
                syncBrokeredEvidenceUploads.id,
                preparedArtifact.stored.brokeredUploadId,
              ),
            )
            .for("update")
            .limit(1);
          if (!upload || !canonicalArtifactId)
            throw new PolarEvidenceBindingError(
              "brokered evidence upload disappeared before canonical binding",
            );
          if (upload.state === "verified") {
            const [bound] = await tx
              .update(syncBrokeredEvidenceUploads)
              .set({
                state: "bound",
                canonicalResultId: existing.id,
                canonicalResultAttemptId: attempt.id,
                canonicalArtifactId,
                boundAt: new Date(),
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(syncBrokeredEvidenceUploads.id, upload.id),
                  eq(syncBrokeredEvidenceUploads.state, "verified"),
                ),
              )
              .returning({ id: syncBrokeredEvidenceUploads.id });
            if (!bound)
              throw new PolarEvidenceBindingError(
                "brokered evidence generation lost its bind race",
              );
          } else if (
            upload.canonicalResultId !== existing.id ||
            upload.canonicalResultAttemptId !== attempt.id ||
            upload.canonicalArtifactId !== canonicalArtifactId
          ) {
            throw new PolarEvidenceBindingError(
              "brokered evidence generation is already bound to different canonical evidence",
            );
          }
          canonicalBrokeredSourceArtifactId = canonicalArtifactId;
        }
      }
      let brokeredArchiveMemberCount = 0;
      if (preparedBrokeredArchive) {
        if (
          !canonicalBrokeredSourceArtifactId ||
          !canonicalManifestArtifactId
        ) {
          throw new PolarEvidenceBindingError(
            "brokered evidence lost its exact source or manifest association",
          );
        }
        const registration = await registerVerifiedBrokeredEvidenceArchive(tx, {
          resultId: existing.id,
          resultAttemptId: attempt.id,
          sourceArtifactId: canonicalBrokeredSourceArtifactId,
          manifestArtifactId: canonicalManifestArtifactId,
          evidenceBase: preparedBrokeredArchive.evidenceBase,
          identity: {
            bucket: preparedBrokeredArchive.upload.bucket,
            objectKey: preparedBrokeredArchive.upload.objectKey,
            generation: preparedBrokeredArchive.upload.generation!,
            crc32c: preparedBrokeredArchive.upload.crc32c!,
            storedSha256: preparedBrokeredArchive.upload.storedSha256,
            storedByteSize: preparedBrokeredArchive.upload.storedByteSize,
            tarSha256: preparedBrokeredArchive.upload.tarSha256,
            tarByteSize: preparedBrokeredArchive.upload.tarByteSize,
            manifestSha256: preparedBrokeredArchive.upload.manifestSha256,
            manifestByteSize: preparedBrokeredArchive.upload.manifestByteSize,
            zstdLevel: preparedBrokeredArchive.upload.zstdLevel,
            bundledFileCount: preparedBrokeredArchive.upload.bundledFileCount,
            verifiedAt: preparedBrokeredArchive.upload.verifiedAt!,
          },
          memberSet: preparedBrokeredArchive.memberSet,
        });
        brokeredArchiveMemberCount = registration.memberCount;

        // A successful exact broker replay supersedes only the old imported
        // gzip *container* association. Logical member rows remain mapped to
        // the authenticated current archive, while dropping this obsolete
        // source association lets sync-import GC remove the duplicate gzip
        // bytes. Never retire an archive that owns any canonical generation.
        await tx
          .delete(solverEvidenceArtifacts)
          .where(
            and(
              eq(solverEvidenceArtifacts.resultId, existing.id),
              eq(solverEvidenceArtifacts.resultAttemptId, attempt.id),
              eq(solverEvidenceArtifacts.kind, "openfoam_bundle"),
              eq(solverEvidenceArtifacts.mimeType, "application/gzip"),
              sql`${solverEvidenceArtifacts.storageKey} LIKE 'sync-imports/%'`,
              sql`${solverEvidenceArtifacts.storageKey} LIKE '%.gz'`,
              sql`NOT EXISTS (
                SELECT 1
                FROM ${solverEvidenceArchives} retained_archive
                WHERE retained_archive.source_artifact_id = ${solverEvidenceArtifacts.id}
              )`,
            ),
          );
      }
      for (const { item, stored } of preparedMedia) {
        const association = {
          resultId: existing.id,
          resultAttemptId: attempt.id,
          kind: (nullableText(item.kind) ?? "image") as never,
          field: nullableText(item.field),
          role: (nullableText(item.role) ?? "instantaneous") as never,
          storageKey: stored.storageKey,
          mimeType: nullableText(item.mimeType) ?? stored.mimeType,
          width: typeof item.width === "number" ? Math.round(item.width) : null,
          height:
            typeof item.height === "number" ? Math.round(item.height) : null,
          frameCount:
            typeof item.frameCount === "number"
              ? Math.round(item.frameCount)
              : null,
          durationS: typeof item.durationS === "number" ? item.durationS : null,
          colorScaleVersion:
            typeof item.colorScaleVersion === "number"
              ? Math.round(item.colorScaleVersion)
              : null,
          scaleVmin: typeof item.scaleVmin === "number" ? item.scaleVmin : null,
          scaleVmax: typeof item.scaleVmax === "number" ? item.scaleVmax : null,
          scalePolicy: nullableText(item.scalePolicy),
          renderProfileKey:
            nullableText(item.renderProfileKey) ?? "default:v1:zoom2",
          evidenceSha256: nullableText(
            item.evidenceSha256 ?? item.evidence_sha256,
          ),
          sha256: stored.sha256,
          byteSize: stored.byteSize,
        };
        const [insertedAssociation] = await tx
          .insert(resultMedia)
          .values(association)
          .onConflictDoNothing()
          .returning({ id: resultMedia.id });
        if (!insertedAssociation) {
          const [replayed] = await tx
            .select()
            .from(resultMedia)
            .where(
              and(
                eq(resultMedia.resultAttemptId, attempt.id),
                eq(resultMedia.kind, association.kind),
                sql`${resultMedia.field} IS NOT DISTINCT FROM ${association.field}`,
                eq(resultMedia.role, association.role),
                eq(resultMedia.renderProfileKey, association.renderProfileKey),
              ),
            )
            .limit(1);
          if (
            !replayed ||
            replayed.resultId !== association.resultId ||
            replayed.storageKey !== association.storageKey ||
            replayed.mimeType !== association.mimeType ||
            replayed.width !== association.width ||
            replayed.height !== association.height ||
            replayed.frameCount !== association.frameCount ||
            replayed.durationS !== association.durationS ||
            replayed.colorScaleVersion !== association.colorScaleVersion ||
            replayed.scaleVmin !== association.scaleVmin ||
            replayed.scaleVmax !== association.scaleVmax ||
            replayed.scalePolicy !== association.scalePolicy ||
            replayed.evidenceSha256 !== association.evidenceSha256 ||
            replayed.sha256 !== association.sha256 ||
            replayed.byteSize !== association.byteSize
          ) {
            throw new PolarEvidenceBindingError(
              `point ${point.aoaDeg} exact-attempt media association changed immutable metadata`,
            );
          }
        }
      }
      if (point.forceHistory) {
        const association = {
          resultId: existing.id,
          resultAttemptId: attempt.id,
          t: point.forceHistory.t,
          cl: point.forceHistory.cl,
          cd: point.forceHistory.cd,
          cm: point.forceHistory.cm ?? null,
          clMean: point.forceHistory.clMean ?? null,
          clRms: point.forceHistory.clRms ?? null,
          cdMean: point.forceHistory.cdMean ?? null,
          cdRms: point.forceHistory.cdRms ?? null,
          strouhal: point.forceHistory.strouhal ?? null,
          sheddingFreqHz: point.forceHistory.sheddingFreqHz ?? null,
          sampleCount: point.forceHistory.sampleCount ?? null,
        };
        const [insertedAssociation] = await tx
          .insert(forceHistory)
          .values(association)
          .onConflictDoNothing()
          .returning({ id: forceHistory.id });
        if (!insertedAssociation) {
          const [replayed] = await tx
            .select()
            .from(forceHistory)
            .where(eq(forceHistory.resultAttemptId, attempt.id))
            .limit(1);
          const comparable = (row: typeof association) => ({
            t: row.t,
            cl: row.cl,
            cd: row.cd,
            cm: row.cm,
            clMean: row.clMean,
            clRms: row.clRms,
            cdMean: row.cdMean,
            cdRms: row.cdRms,
            strouhal: row.strouhal,
            sheddingFreqHz: row.sheddingFreqHz,
            sampleCount: row.sampleCount,
          });
          if (
            !replayed ||
            replayed.resultId !== association.resultId ||
            stableHash(comparable(replayed as typeof association)) !==
              stableHash(comparable(association))
          ) {
            throw new PolarEvidenceBindingError(
              `point ${point.aoaDeg} exact-attempt force history changed immutable values`,
            );
          }
        }
      }
      return {
        kind,
        resultId: existing.id,
        attempt,
        observedCurrentAttemptId,
        incomingResult,
        createdResult,
        attemptInserted: attemptResolution.kind === "inserted",
        importedExtents,
        brokeredArchiveMemberCount,
      };
    });
    if (resolution.kind === "conflict") {
      conflictIds.push(
        await createConflict({
          dataType: "polars",
          naturalKey: `${airfoilId}:${revisionId}:${point.aoaDeg}`,
          incomingPayload: point as unknown as Record<string, unknown>,
          localSnapshot: resolution.existing as unknown as Record<
            string,
            unknown
          >,
          artifactManifest: payload.promiseId
            ? { promiseId: payload.promiseId }
            : undefined,
          sourceInstanceId: payload.sourceInstanceId,
          sourceInstanceName: payload.sourceInstanceName,
        }),
      );
      continue;
    }
    const resultId = resolution.resultId;
    if (resolution.kind === "imported") {
      imported++;
    }
    const attempt = resolution.attempt;
    if (resolution.attemptInserted) attempts++;
    fieldExtents += resolution.importedExtents;
    artifacts +=
      preparedArtifacts.length +
      Math.max(0, resolution.brokeredArchiveMemberCount - 1);
    media += preparedMedia.length;

    committedPoints.push({
      aoaDeg: point.aoaDeg,
      resultId,
      attemptId: attempt.id,
      observedCurrentAttemptId: resolution.observedCurrentAttemptId,
      incomingResult: resolution.incomingResult,
      regime: attemptRegime,
      fidelity: point.fidelity ?? null,
      brokeredUploadId:
        preparedArtifacts.find(({ stored }) => stored.brokeredUploadId)?.stored
          .brokeredUploadId ?? null,
    });
  }

  // Classify staged attempts, promote eligible exact generations, then reload
  // canonical evidence and rebuild result classification + fit under one
  // compatibility/revision lock and one transaction. Readers observe either
  // the old complete generation or the new complete generation.
  await refreshPolarCacheForRevision(db, airfoilId, revisionId, {
    afterAttemptClassifications: async (tx) => {
      let promotedAny = false;
      const fidelityRank = (
        state: "accepted" | "needs_urans",
        fidelity: string | null,
        regime: "rans" | "urans" | null,
      ) =>
        (state === "accepted" ? 200 : 100) +
        (fidelity === "urans_full"
          ? 30
          : fidelity === "urans_precalc" || regime === "urans"
            ? 20
            : 10);
      for (const committed of committedPoints) {
        const [incomingClass] = await tx
          .select({ state: resultClassifications.state })
          .from(resultClassifications)
          .where(
            and(
              eq(resultClassifications.resultAttemptId, committed.attemptId),
              inArray(resultClassifications.state, ["accepted", "needs_urans"]),
            ),
          )
          .orderBy(
            sql`CASE ${resultClassifications.state} WHEN 'accepted' THEN 2 ELSE 1 END DESC`,
            desc(resultClassifications.updatedAt),
          )
          .limit(1);
        if (!incomingClass) continue;
        const [manifestCheck] = (await tx.execute(sql`
          SELECT count(*)::int AS total,
                 count(*) FILTER (
                   WHERE sha256 ~ '^[0-9a-fA-F]{64}$'
                     AND byte_size > 0
                     AND length(trim(storage_key)) > 0
                     AND length(trim(mime_type)) > 0
                 )::int AS valid
          FROM solver_evidence_artifacts
          WHERE result_id = ${committed.resultId}
            AND result_attempt_id = ${committed.attemptId}
            AND kind = 'manifest'
        `)) as unknown as Array<{ total: number; valid: number }>;
        if (manifestCheck?.total !== 1 || manifestCheck.valid !== 1) continue;

        let currentRank = -1;
        if (committed.observedCurrentAttemptId) {
          const [current] = await tx
            .select({
              regime: resultAttempts.regime,
              evidencePayload: resultAttempts.evidencePayload,
              state: resultClassifications.state,
            })
            .from(resultAttempts)
            .innerJoin(
              resultClassifications,
              and(
                eq(resultClassifications.resultAttemptId, resultAttempts.id),
                inArray(resultClassifications.state, [
                  "accepted",
                  "needs_urans",
                ]),
              ),
            )
            .where(
              and(
                eq(resultAttempts.id, committed.observedCurrentAttemptId),
                eq(resultAttempts.resultId, committed.resultId),
              ),
            )
            .orderBy(
              sql`CASE ${resultClassifications.state} WHEN 'accepted' THEN 2 ELSE 1 END DESC`,
              desc(resultClassifications.updatedAt),
            )
            .limit(1);
          if (current) {
            const currentFidelity = nullableText(
              jsonObject(current.evidencePayload).fidelity,
            );
            currentRank = fidelityRank(
              current.state as "accepted" | "needs_urans",
              currentFidelity,
              current.regime,
            );
          }
        }
        const incomingRank = fidelityRank(
          incomingClass.state as "accepted" | "needs_urans",
          committed.fidelity,
          committed.regime,
        );
        if (incomingRank < currentRank) continue;
        const promoted = await tx
          .update(results)
          .set({
            ...committed.incomingResult,
            currentResultAttemptId: committed.attemptId,
          })
          .where(
            and(
              eq(results.id, committed.resultId),
              sql`${results.currentResultAttemptId} IS NOT DISTINCT FROM ${committed.observedCurrentAttemptId}`,
            ),
          )
          .returning({ id: results.id });
        promotedAny ||= promoted.length === 1;
      }
      if (promotedAny) {
        // Compatibility aggregation rebuilds after this transaction. Retire
        // any current aggregate containing the changed revision now, so the
        // publication gap is empty rather than pointer-B/cache-A.
        await tx.execute(sql`
          UPDATE polar_compatibility_fit_sets fit
          SET is_current = false, "updatedAt" = now()
          WHERE fit.is_current = true
            AND fit.airfoil_id = ${airfoilId}
            AND EXISTS (
              SELECT 1
              FROM polar_compatibility_fit_members member
              WHERE member.fit_set_id = fit.id
                AND member.simulation_preset_revision_id = ${revisionId}
            )
        `);
      }
    },
  });

  // Imported solver evidence must cross the same campaign/fidelity boundary
  // as locally ingested evidence. In particular, a brokered accepted FAST
  // generation is acknowledged only after its exact GCS archive is
  // restartable and one durable FINAL owner exists.
  for (const committed of committedPoints) {
    const [selected] = await db
      .select({
        status: results.status,
        regime: results.regime,
        currentResultAttemptId: results.currentResultAttemptId,
      })
      .from(results)
      .where(eq(results.id, committed.resultId))
      .limit(1);
    if (!selected || selected.currentResultAttemptId !== committed.attemptId) {
      continue;
    }
    await onResultIngested(db, {
      airfoilId,
      revisionId,
      aoaDeg: committed.aoaDeg,
      resultId: committed.resultId,
      resultAttemptId: committed.attemptId,
      status: selected.status,
      regime: selected.regime,
    });
    if (committed.fidelity !== "urans_precalc" || !committed.brokeredUploadId) {
      continue;
    }
    if (
      !(await hasExactVerifiedRestartableEvidenceArchive(
        db,
        committed.resultId,
        committed.attemptId,
      ))
    ) {
      throw new PolarEvidenceBindingError(
        `point ${committed.aoaDeg} brokered preliminary evidence is not restartable`,
      );
    }
    const [campaignOwner] = await db
      .select({ campaignId: simCampaignPoints.campaignId })
      .from(simCampaignPoints)
      .innerJoin(
        simCampaigns,
        eq(simCampaigns.id, simCampaignPoints.campaignId),
      )
      .where(
        and(
          eq(simCampaignPoints.resultId, committed.resultId),
          eq(simCampaignPoints.resultAttemptId, committed.attemptId),
          eq(simCampaignPoints.derivedBySymmetry, false),
          inArray(simCampaigns.status, ["active", "attention", "paused"]),
        ),
      )
      .orderBy(simCampaignPoints.campaignId)
      .limit(1);
    await enqueuePrecalcVerifications(db, {
      airfoilId,
      revisionId,
      campaignId: campaignOwner?.campaignId ?? null,
      aoaDeg: committed.aoaDeg,
    });
    const [finalOwner] = await db
      .select({
        queueId: simUransVerifyQueue.id,
        backgroundOwner: simUransVerifyQueue.backgroundOwner,
      })
      .from(simUransVerifyQueue)
      .where(
        and(
          eq(simUransVerifyQueue.precalcResultAttemptId, committed.attemptId),
          inArray(simUransVerifyQueue.state, [
            "pending",
            "running",
            "done",
            "disagreed",
          ]),
        ),
      )
      .orderBy(simUransVerifyQueue.createdAt)
      .limit(1);
    if (!finalOwner) {
      throw new PolarEvidenceBindingError(
        `point ${committed.aoaDeg} accepted preliminary evidence without FINAL ownership`,
      );
    }
    if (campaignOwner) {
      const [owned] = await db
        .select({ queueId: simUransVerifyQueueCampaigns.queueId })
        .from(simUransVerifyQueueCampaigns)
        .where(
          and(
            eq(simUransVerifyQueueCampaigns.queueId, finalOwner.queueId),
            eq(
              simUransVerifyQueueCampaigns.campaignId,
              campaignOwner.campaignId,
            ),
            eq(simUransVerifyQueueCampaigns.state, "active"),
          ),
        )
        .limit(1);
      if (!owned) {
        throw new PolarEvidenceBindingError(
          `point ${committed.aoaDeg} FINAL verification lost campaign ownership`,
        );
      }
    } else if (!finalOwner.backgroundOwner) {
      throw new PolarEvidenceBindingError(
        `point ${committed.aoaDeg} FINAL verification has no live owner`,
      );
    }
  }

  if (payload.promiseId) {
    for (const committed of committedPoints) {
      const pointSettlement = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB;
        const [classified] = (await tx.execute(sql`
          SELECT
            EXISTS (
              SELECT 1
              FROM results canonical
              JOIN result_classifications classification
                ON classification.result_id = canonical.id
              WHERE canonical.id = ${committed.resultId}
                AND canonical.current_result_attempt_id = ${committed.attemptId}
                AND classification.state = 'accepted'
            ) AS result_accepted,
            EXISTS (
              SELECT 1
              FROM result_attempts attempt
              JOIN result_classifications classification
                ON classification.result_attempt_id = attempt.id
               AND classification.state = 'accepted'
              WHERE attempt.id = ${committed.attemptId}
                AND attempt.result_id = ${committed.resultId}
            ) AS attempt_accepted,
            (
              SELECT count(*) = 1
                 AND count(*) FILTER (
                   WHERE manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
                     AND manifest.byte_size > 0
                     AND length(trim(manifest.storage_key)) > 0
                     AND length(trim(manifest.mime_type)) > 0
                 ) = 1
              FROM solver_evidence_artifacts manifest
              WHERE manifest.result_id = ${committed.resultId}
                AND manifest.result_attempt_id = ${committed.attemptId}
                AND manifest.kind = 'manifest'
            ) AS exact_manifest,
            NOT EXISTS (
              SELECT 1
              FROM result_media media
              WHERE media.result_id = ${committed.resultId}
                AND media.result_attempt_id = ${committed.attemptId}
                AND media.evidence_sha256 IS DISTINCT FROM (
                  SELECT manifest.sha256
                  FROM solver_evidence_artifacts manifest
                  WHERE manifest.result_id = ${committed.resultId}
                    AND manifest.result_attempt_id = ${committed.attemptId}
                    AND manifest.kind = 'manifest'
                  LIMIT 1
                )
            ) AS media_bound,
            NOT EXISTS (
              SELECT 1
              FROM result_field_extents extent
              WHERE extent.result_id = ${committed.resultId}
                AND extent.result_attempt_id = ${committed.attemptId}
                AND extent.evidence_sha256 IS DISTINCT FROM (
                  SELECT manifest.sha256
                  FROM solver_evidence_artifacts manifest
                  WHERE manifest.result_id = ${committed.resultId}
                    AND manifest.result_attempt_id = ${committed.attemptId}
                    AND manifest.kind = 'manifest'
                  LIMIT 1
                )
            ) AS extents_bound
        `)) as unknown as Array<{
          result_accepted: boolean;
          attempt_accepted: boolean;
          exact_manifest: boolean;
          media_bound: boolean;
          extents_bound: boolean;
        }>;
        if (
          !classified?.result_accepted ||
          !classified.attempt_accepted ||
          !classified.exact_manifest ||
          !classified.media_bound ||
          !classified.extents_bound
        ) {
          return { settled: false, receipt: null };
        }
        // Promise ownership advances by numerical fidelity, not the physical
        // regime flag: a no-shedding PRECALC or FULL URANS generation is
        // deliberately stored with physical regime RANS. Preserve every
        // immutable generation while allowing only RANS -> PRECALC -> FULL.
        const acceptedFidelityUpgrade =
          committed.fidelity === "urans_precalc"
            ? sql`EXISTS (
                SELECT 1
                FROM result_attempts prior_attempt
                WHERE prior_attempt.id = ${syncSweepPromisePoints.resultAttemptId}
                  AND prior_attempt.result_id = ${committed.resultId}
                  AND COALESCE(
                    prior_attempt.evidence_payload ->> 'fidelity',
                    CASE WHEN prior_attempt.regime = 'rans' THEN 'rans' END
                  ) = 'rans'
              )`
            : committed.fidelity === "urans_full"
              ? sql`EXISTS (
                  SELECT 1
                  FROM result_attempts prior_attempt
                  WHERE prior_attempt.id = ${syncSweepPromisePoints.resultAttemptId}
                    AND prior_attempt.result_id = ${committed.resultId}
                    AND prior_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
                )`
              : sql`false`;
        const fulfilledAt = new Date();
        const settled = await tx
          .update(syncSweepPromisePoints)
          .set({
            status: "fulfilled",
            resultId: committed.resultId,
            resultAttemptId: committed.attemptId,
            updatedAt: fulfilledAt,
          })
          .where(
            and(
              eq(syncSweepPromisePoints.promiseId, payload.promiseId!),
              eq(syncSweepPromisePoints.airfoilId, airfoilId),
              eq(syncSweepPromisePoints.simulationPresetRevisionId, revisionId),
              eq(syncSweepPromisePoints.aoaDeg, committed.aoaDeg),
              or(
                inArray(syncSweepPromisePoints.status, ["active", "expired"]),
                and(
                  eq(syncSweepPromisePoints.status, "fulfilled"),
                  eq(syncSweepPromisePoints.resultId, committed.resultId),
                  or(
                    eq(
                      syncSweepPromisePoints.resultAttemptId,
                      committed.attemptId,
                    ),
                    acceptedFidelityUpgrade,
                  ),
                ),
              ),
            ),
          )
          .returning({ id: syncSweepPromisePoints.id });
        if (settled.length !== 1) return { settled: false, receipt: null };
        if (!committed.brokeredUploadId)
          return { settled: true, receipt: null };
        const [upload] = await tx
          .select()
          .from(syncBrokeredEvidenceUploads)
          .where(eq(syncBrokeredEvidenceUploads.id, committed.brokeredUploadId))
          .for("update")
          .limit(1);
        if (
          !upload ||
          upload.state !== "bound" ||
          upload.promiseId !== payload.promiseId ||
          upload.aoaDeg !== committed.aoaDeg ||
          upload.canonicalResultId !== committed.resultId ||
          upload.canonicalResultAttemptId !== committed.attemptId ||
          !upload.canonicalArtifactId ||
          !upload.boundAt ||
          !upload.generation ||
          !upload.crc32c
        ) {
          throw new PolarEvidenceBindingError(
            `point ${committed.aoaDeg} was fulfilled without one exact canonical broker binding`,
          );
        }
        const receipt: HubBindingReceipt = {
          schemaVersion: 1,
          kind: "hub-canonical-evidence-binding",
          promiseId: upload.promiseId,
          aoaDeg: upload.aoaDeg,
          remoteResultId: upload.remoteResultId,
          remoteResultAttemptId: upload.remoteResultAttemptId,
          engineJobId: upload.engineJobId,
          engineCaseSlug: upload.engineCaseSlug,
          brokeredUploadId: upload.id,
          bindingState: "bound",
          promisePointState: "fulfilled",
          remote: {
            bucket: upload.bucket,
            objectKey: upload.objectKey,
            generation: upload.generation,
            crc32c: upload.crc32c,
            storedSha256: upload.storedSha256,
            storedByteSize: upload.storedByteSize,
            tarSha256: upload.tarSha256,
            tarByteSize: upload.tarByteSize,
            manifestSha256: upload.manifestSha256,
            manifestByteSize: upload.manifestByteSize,
            zstdLevel: upload.zstdLevel,
            bundledFileCount: upload.bundledFileCount,
          },
          canonical: {
            resultId: committed.resultId,
            resultAttemptId: committed.attemptId,
            artifactId: upload.canonicalArtifactId,
          },
          boundAt: upload.boundAt.toISOString(),
          fulfilledAt: fulfilledAt.toISOString(),
        };
        return { settled: true, receipt };
      });
      if (pointSettlement.settled) {
        fulfilledAoas.push(committed.aoaDeg);
        if (pointSettlement.receipt)
          bindingReceipts.push(pointSettlement.receipt);
      } else unfulfilledAoas.push(committed.aoaDeg);
    }
    const committedAoas = new Set(
      committedPoints.map((committed) => committed.aoaDeg),
    );
    for (const point of payload.results) {
      if (!committedAoas.has(point.aoaDeg)) unfulfilledAoas.push(point.aoaDeg);
    }
  }

  return {
    imported,
    attempts,
    artifacts,
    media,
    fieldExtents,
    fieldColorScales: importedFieldColorScales,
    conflictIds,
    promiseId: payload.promiseId ?? null,
    fulfilledAoas: [...new Set(fulfilledAoas)].sort((a, b) => a - b),
    unfulfilledAoas: [...new Set(unfulfilledAoas)].sort((a, b) => a - b),
    bindingReceipts,
  };
}

function exportRow(type: SyncDataType, data: unknown) {
  return { type, data };
}

function upstreamBase(settings: typeof syncApiSettings.$inferSelect): string {
  if (!settings.upstreamBaseUrl)
    throw new Error("up-tier API endpoint is not configured");
  return canonicalRemoteHubBaseUrl(settings.upstreamBaseUrl);
}

function remoteHeaders(
  settings: typeof syncApiSettings.$inferSelect,
): Record<string, string> {
  return settings.upstreamSecret
    ? { "x-xfoilfoam-sync-secret": settings.upstreamSecret }
    : {};
}

function resolveRemoteDownloadUrl(
  settings: typeof syncApiSettings.$inferSelect,
  raw: unknown,
): string {
  const value = nullableText(raw);
  if (!value) throw new Error("remote asset payload lacks download URL");
  const base = new URL(upstreamBase(settings));
  const target = /^[a-z][a-z0-9+.-]*:/i.test(value)
    ? new URL(value)
    : new URL(`${base.toString()}/${value.replace(/^\/+/, "")}`);
  if (
    target.origin !== base.origin ||
    target.username ||
    target.password ||
    target.hash
  ) {
    throw new Error("remote asset download URL changed hub authority");
  }
  return target.toString();
}

function extFromMime(mime: string): string {
  if (mime.includes("png")) return ".png";
  if (mime.includes("jpeg")) return ".jpg";
  if (mime.includes("mp4")) return ".mp4";
  if (mime.includes("webm")) return ".webm";
  if (mime.includes("json")) return ".json";
  if (mime.includes("csv")) return ".csv";
  if (mime.includes("gzip")) return ".gz";
  if (mime.includes("zstd")) return ".zst";
  if (mime.includes("text")) return ".txt";
  return ".bin";
}

async function downloadRemoteAsset(opts: {
  settings: typeof syncApiSettings.$inferSelect;
  downloadUrl: string;
  storageKey: string;
  expectedSha256?: string | null;
  expectedByteSize?: number | null;
}): Promise<{
  sha256: string;
  byteSize: number;
  storageKey: string;
  newlyCommitted: boolean;
}> {
  const res = await fetch(opts.downloadUrl, {
    headers: remoteHeaders(opts.settings),
  });
  if (!res.ok || !res.body)
    throw new Error(`remote asset download failed (${res.status})`);
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
  if (
    opts.expectedByteSize != null &&
    opts.expectedByteSize > 0 &&
    byteSize !== opts.expectedByteSize
  ) {
    await unlink(tmp).catch(() => undefined);
    throw new Error(`remote asset byte size mismatch for ${opts.storageKey}`);
  }
  let newlyCommitted = false;
  try {
    await link(tmp, target);
    newlyCommitted = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existingHash = createHash("sha256");
    let existingBytes = 0;
    const existingStream = createReadStream(target);
    existingStream.on("data", (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      existingBytes += buf.length;
      existingHash.update(buf);
    });
    await once(existingStream, "end");
    if (existingHash.digest("hex") !== sha256 || existingBytes !== byteSize) {
      throw new Error(
        `remote asset identity changed for existing ${opts.storageKey}`,
      );
    }
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
  return { sha256, byteSize, storageKey: opts.storageKey, newlyCommitted };
}

async function localResultForRemote(
  sourceInstanceId: string | null | undefined,
  remoteResultId: string | null | undefined,
) {
  if (!remoteResultId) return null;
  const engineJobId = `sync:${sourceInstanceId ?? "upstream"}:${remoteResultId}`;
  const [row] = await db
    .select()
    .from(results)
    .where(eq(results.engineJobId, engineJobId))
    .limit(1);
  return row ?? null;
}

async function exactCurrentRemoteGeneration(
  data: Record<string, unknown>,
  sourceInstanceId: string | null | undefined,
  remoteResultId: string | null | undefined,
) {
  const result = await localResultForRemote(sourceInstanceId, remoteResultId);
  const remoteAttemptId = nullableText(
    data.remoteResultAttemptId ??
      data.resultAttemptId ??
      data.result_attempt_id,
  );
  if (
    !result ||
    !remoteAttemptId ||
    !result.currentResultAttemptId ||
    remoteAttemptId !== result.currentResultAttemptId
  ) {
    return null;
  }
  const [attempt] = await db
    .select()
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, result.currentResultAttemptId),
        eq(resultAttempts.resultId, result.id),
      ),
    )
    .limit(1);
  if (!attempt) return null;
  const manifests = await db
    .select({
      id: solverEvidenceArtifacts.id,
      sha256: solverEvidenceArtifacts.sha256,
      byteSize: solverEvidenceArtifacts.byteSize,
      storageKey: solverEvidenceArtifacts.storageKey,
      mimeType: solverEvidenceArtifacts.mimeType,
      field: solverEvidenceArtifacts.field,
      role: solverEvidenceArtifacts.role,
      airfoilId: solverEvidenceArtifacts.airfoilId,
      simJobId: solverEvidenceArtifacts.simJobId,
      engineJobId: solverEvidenceArtifacts.engineJobId,
      engineCaseSlug: solverEvidenceArtifacts.engineCaseSlug,
      aoaDeg: solverEvidenceArtifacts.aoaDeg,
    })
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, result.id),
        eq(
          solverEvidenceArtifacts.resultAttemptId,
          result.currentResultAttemptId,
        ),
        eq(solverEvidenceArtifacts.kind, "manifest"),
      ),
    );
  const [manifest] = manifests;
  if (
    manifests.length !== 1 ||
    !manifest ||
    !/^[0-9a-f]{64}$/i.test(manifest.sha256) ||
    manifest.byteSize <= 0 ||
    !manifest.storageKey.trim() ||
    !manifest.mimeType.trim() ||
    manifest.airfoilId !== result.airfoilId ||
    manifest.simJobId !== attempt.simJobId ||
    manifest.engineJobId !== attempt.engineJobId ||
    manifest.engineCaseSlug !== attempt.engineCaseSlug ||
    manifest.aoaDeg !== attempt.aoaDeg
  ) {
    return null;
  }
  return {
    result,
    attempt,
    resultAttemptId: result.currentResultAttemptId,
    manifestSha256: manifest.sha256,
    manifest,
  };
}

async function importExportedResult(
  data: Record<string, unknown>,
  source: {
    sourceInstanceId?: string | null;
    sourceInstanceName?: string | null;
  },
): Promise<{ imported: boolean; conflictId?: string; resultId?: string }> {
  const remoteResultId = nullableText(data.remoteResultId ?? data.id);
  // The generic export row is only a mutable result projection: it has no
  // exact attempt, sole verified manifest, immutable artifact set, or atomic
  // current-generation publication contract.  Treating it as canonical could
  // overwrite an accepted generation (and its scheduler identity) beneath an
  // existing pointer.  Exact solver evidence is accepted only by the
  // generation-aware /api/sync/v1/polars endpoint.
  return {
    imported: false,
    conflictId: await createConflict({
      dataType: "polars",
      naturalKey: remoteResultId ?? stableHash(data).slice(0, 24),
      incomingPayload: {
        ...data,
        syncImportDisposition: "historical_projection_only",
        requiredEndpoint: "/api/sync/v1/polars",
      },
      sourceInstanceId: source.sourceInstanceId,
      sourceInstanceName: source.sourceInstanceName,
    }),
  };
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
  const immutable = {
    localKind: opts.localKind,
    localRowId: opts.localRowId ?? null,
    localStorageKey: opts.localStorageKey,
    resultId: opts.resultId ?? null,
    resultAttemptId: opts.resultAttemptId ?? null,
    sourceInstanceId: opts.sourceInstanceId ?? null,
    sourceInstanceName: opts.sourceInstanceName ?? null,
    remoteResultId: opts.remoteResultId ?? null,
    remoteArtifactId: opts.remoteArtifactId ?? null,
    remoteMediaId: opts.remoteMediaId ?? null,
    remoteCacheId: opts.remoteCacheId ?? null,
    remoteDownloadUrl: opts.remoteDownloadUrl,
    remoteRenderUrl: opts.remoteRenderUrl ?? null,
    sha256: opts.sha256 ?? null,
    byteSize: opts.byteSize ?? null,
    mimeType: opts.mimeType,
    metadata: opts.metadata ?? {},
  };
  const [inserted] = await db
    .insert(remoteAssetReferences)
    .values({
      ...immutable,
      availability: opts.availability,
      cachedStorageKey: opts.cachedStorageKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: remoteAssetReferences.id });
  if (inserted) return;
  const [existing] = await db
    .select()
    .from(remoteAssetReferences)
    .where(eq(remoteAssetReferences.localStorageKey, opts.localStorageKey))
    .limit(1);
  const comparable = (row: Record<string, unknown>) => ({
    localKind: row.localKind,
    localRowId: row.localRowId ?? null,
    localStorageKey: row.localStorageKey,
    resultId: row.resultId ?? null,
    resultAttemptId: row.resultAttemptId ?? null,
    sourceInstanceId: row.sourceInstanceId ?? null,
    sourceInstanceName: row.sourceInstanceName ?? null,
    remoteResultId: row.remoteResultId ?? null,
    remoteArtifactId: row.remoteArtifactId ?? null,
    remoteMediaId: row.remoteMediaId ?? null,
    remoteCacheId: row.remoteCacheId ?? null,
    remoteDownloadUrl: row.remoteDownloadUrl,
    remoteRenderUrl: row.remoteRenderUrl ?? null,
    sha256: row.sha256 ?? null,
    byteSize: row.byteSize ?? null,
    mimeType: row.mimeType,
    metadata: row.metadata ?? {},
  });
  if (
    !existing ||
    stableHash(comparable(existing as unknown as Record<string, unknown>)) !==
      stableHash(immutable)
  ) {
    throw new PolarEvidenceBindingError(
      `remote asset reference ${opts.localStorageKey} changed immutable identity`,
    );
  }
  await db
    .update(remoteAssetReferences)
    .set({
      availability: opts.availability,
      cachedStorageKey: opts.cachedStorageKey ?? null,
      updatedAt: new Date(),
    })
    .where(eq(remoteAssetReferences.id, existing.id));
}

async function importRemoteMediaReference(
  data: Record<string, unknown>,
  settings: typeof syncApiSettings.$inferSelect,
  mode: "full" | "db_only_remote_assets",
  source: {
    sourceInstanceId?: string | null;
    sourceInstanceName?: string | null;
  },
): Promise<{ imported: boolean; conflictId?: string }> {
  const remoteMediaId = nullableText(data.remoteMediaId ?? data.id);
  const remoteResultId = nullableText(
    data.remoteResultId ?? data.resultId ?? data.result_id,
  );
  const exact = await exactCurrentRemoteGeneration(
    data,
    source.sourceInstanceId,
    remoteResultId,
  );
  const expectedSha = nullableText(data.sha256);
  const expectedSize = nullableNumber(data.byteSize ?? data.byte_size);
  const evidenceSha256 = nullableText(
    data.evidenceSha256 ?? data.evidence_sha256,
  );
  if (
    !remoteMediaId ||
    !remoteResultId ||
    !exact ||
    !expectedSha ||
    !/^[0-9a-f]{64}$/i.test(expectedSha) ||
    expectedSize == null ||
    expectedSize <= 0 ||
    evidenceSha256 !== exact?.manifestSha256
  ) {
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "result_media",
        naturalKey: remoteMediaId ?? stableHash(data).slice(0, 24),
        incomingPayload: {
          ...data,
          syncImportDisposition: "unbound_historical_reference",
          requiredEvidence: "exact current attempt and verified manifest",
        },
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  const mimeType =
    nullableText(data.mimeType ?? data.mime_type) ?? "application/octet-stream";
  const remoteDownloadUrl = resolveRemoteDownloadUrl(
    settings,
    data.downloadUrl,
  );
  const baseKey = `sync/${source.sourceInstanceId ?? "upstream"}/media/${remoteMediaId}${extFromMime(mimeType)}`;
  const localStorageKey =
    mode === "full"
      ? baseKey
      : `remote/${source.sourceInstanceId ?? "upstream"}/media/${remoteMediaId}`;
  const downloaded =
    mode === "full"
      ? await downloadRemoteAsset({
          settings,
          downloadUrl: remoteDownloadUrl,
          storageKey: baseKey,
          expectedSha256: expectedSha,
          expectedByteSize: expectedSize,
        })
      : null;
  const association = {
    resultId: exact.result.id,
    resultAttemptId: exact.resultAttemptId,
    kind: (data.kind === "video" ? "video" : "image") as "video" | "image",
    field: nullableText(data.field),
    role: (data.role === "mean" || data.role === "history"
      ? data.role
      : "instantaneous") as "mean" | "history" | "instantaneous",
    storageKey: localStorageKey,
    mimeType,
    width: nullableNumber(data.width),
    height: nullableNumber(data.height),
    frameCount: nullableNumber(data.frameCount ?? data.frame_count),
    durationS: nullableNumber(data.durationS ?? data.duration_s),
    colorScaleId: null,
    colorScaleVersion: nullableNumber(
      data.colorScaleVersion ?? data.color_scale_version,
    ),
    scaleVmin: nullableNumber(data.scaleVmin ?? data.scale_vmin),
    scaleVmax: nullableNumber(data.scaleVmax ?? data.scale_vmax),
    scalePolicy: nullableText(data.scalePolicy ?? data.scale_policy),
    renderProfileKey:
      nullableText(data.renderProfileKey ?? data.render_profile_key) ??
      "default:v1:zoom2",
    evidenceSha256,
    sha256: downloaded?.sha256 ?? expectedSha,
    byteSize: downloaded?.byteSize ?? expectedSize,
    engineUrl: remoteDownloadUrl,
  };
  const [insertedMedia] = await db
    .insert(resultMedia)
    .values(association)
    .onConflictDoNothing()
    .returning({ id: resultMedia.id });
  let mediaId = insertedMedia?.id ?? null;
  if (!mediaId) {
    const [replayed] = await db
      .select()
      .from(resultMedia)
      .where(
        and(
          eq(resultMedia.resultAttemptId, exact.resultAttemptId),
          eq(resultMedia.kind, association.kind),
          sql`${resultMedia.field} IS NOT DISTINCT FROM ${association.field}`,
          eq(resultMedia.role, association.role),
          eq(resultMedia.renderProfileKey, association.renderProfileKey),
        ),
      )
      .limit(1);
    const comparable = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.keys(association).map((key) => [
          key,
          key === "colorScaleId" ? (row[key] ?? null) : row[key],
        ]),
      );
    if (
      !replayed ||
      stableHash(comparable(replayed as unknown as Record<string, unknown>)) !==
        stableHash(comparable(association))
    ) {
      if (downloaded?.newlyCommitted) {
        await unlink(join(env.mediaDir, downloaded.storageKey)).catch(
          () => undefined,
        );
      }
      return {
        imported: false,
        conflictId: await createConflict({
          dataType: "result_media",
          naturalKey: remoteMediaId,
          incomingPayload: {
            ...data,
            syncImportDisposition: "immutable_replay_mismatch",
          },
          localSnapshot: replayed as unknown as Record<string, unknown>,
          sourceInstanceId: source.sourceInstanceId,
          sourceInstanceName: source.sourceInstanceName,
        }),
      };
    }
    mediaId = replayed.id;
  }
  await upsertRemoteAssetReference({
    localKind: "result_media",
    localRowId: mediaId,
    localStorageKey,
    resultId: exact.result.id,
    resultAttemptId: exact.resultAttemptId,
    sourceInstanceId: source.sourceInstanceId,
    sourceInstanceName: source.sourceInstanceName,
    remoteResultId,
    remoteMediaId,
    remoteDownloadUrl,
    sha256: association.sha256,
    byteSize: association.byteSize,
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
  source: {
    sourceInstanceId?: string | null;
    sourceInstanceName?: string | null;
  },
): Promise<{ imported: boolean; conflictId?: string }> {
  const remoteArtifactId = nullableText(data.remoteArtifactId ?? data.id);
  const remoteResultId = nullableText(
    data.remoteResultId ?? data.resultId ?? data.result_id,
  );
  const exact = await exactCurrentRemoteGeneration(
    data,
    source.sourceInstanceId,
    remoteResultId,
  );
  const metadata = jsonObject(data.metadata);
  const expectedSha = nullableText(data.sha256);
  const expectedSize = nullableNumber(data.byteSize ?? data.byte_size);
  const kind: (typeof solverEvidenceArtifacts.$inferInsert)["kind"] =
    data.kind === "manifest" ||
    data.kind === "engine_bundle" ||
    data.kind === "openfoam_bundle" ||
    data.kind === "vtk_window" ||
    data.kind === "time_directory" ||
    data.kind === "log" ||
    data.kind === "force_coefficients" ||
    data.kind === "mesh" ||
    data.kind === "dictionary" ||
    data.kind === "field_data"
      ? data.kind
      : "field_data";
  const declaredGenerationSha = nullableText(
    data.generationManifestSha256 ??
      data.evidenceSha256 ??
      metadata.generationManifestSha256 ??
      metadata.manifestSha256 ??
      (kind === "manifest" ? expectedSha : null),
  );
  if (
    !remoteArtifactId ||
    !remoteResultId ||
    !exact ||
    !expectedSha ||
    !/^[0-9a-f]{64}$/i.test(expectedSha) ||
    expectedSize == null ||
    expectedSize <= 0 ||
    declaredGenerationSha !== exact?.manifestSha256
  ) {
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "evidence_artifacts",
        naturalKey: remoteArtifactId ?? stableHash(data).slice(0, 24),
        incomingPayload: {
          ...data,
          syncImportDisposition: "unbound_historical_reference",
          requiredEvidence: "exact current attempt and verified manifest",
        },
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  const mimeType =
    nullableText(data.mimeType ?? data.mime_type) ?? "application/octet-stream";
  if (kind === "manifest") {
    // A selected generation already owns exactly one manifest. Generic asset
    // sync may replay that association, but it must never create another
    // manifest merely because the same bytes arrived under a different remote
    // artifact/storage identity: two rows make the selected generation
    // ambiguous and invalidate its public publication fence.
    const incomingStorageKey = nullableText(
      data.storageKey ?? data.storage_key,
    );
    const exactReplay =
      expectedSha === exact.manifest.sha256 &&
      expectedSize === exact.manifest.byteSize &&
      mimeType === exact.manifest.mimeType &&
      nullableText(data.field) === exact.manifest.field &&
      nullableText(data.role) === exact.manifest.role &&
      incomingStorageKey === exact.manifest.storageKey;
    if (!exactReplay) {
      return {
        imported: false,
        conflictId: await createConflict({
          dataType: "evidence_artifacts",
          naturalKey: remoteArtifactId,
          incomingPayload: {
            ...data,
            syncImportDisposition: "selected_manifest_replay_mismatch",
            requiredEvidence:
              "exact replay of the selected attempt's sole manifest",
          },
          localSnapshot: {
            id: exact.manifest.id,
            resultId: exact.result.id,
            resultAttemptId: exact.resultAttemptId,
            kind: "manifest",
            field: exact.manifest.field,
            role: exact.manifest.role,
            storageKey: exact.manifest.storageKey,
            mimeType: exact.manifest.mimeType,
            sha256: exact.manifest.sha256,
            byteSize: exact.manifest.byteSize,
          },
          sourceInstanceId: source.sourceInstanceId,
          sourceInstanceName: source.sourceInstanceName,
        }),
      };
    }
    // The exact row is already present and selected. Do not download bytes,
    // insert another association, or add a second remote reference.
    return { imported: true };
  }
  const remoteDownloadUrl = resolveRemoteDownloadUrl(
    settings,
    data.downloadUrl,
  );
  const baseKey = `sync/${source.sourceInstanceId ?? "upstream"}/evidence/${remoteArtifactId}${extFromMime(mimeType)}`;
  const localStorageKey =
    mode === "full"
      ? baseKey
      : `remote/${source.sourceInstanceId ?? "upstream"}/evidence/${remoteArtifactId}`;
  const downloaded =
    mode === "full"
      ? await downloadRemoteAsset({
          settings,
          downloadUrl: remoteDownloadUrl,
          storageKey: baseKey,
          expectedSha256: expectedSha,
          expectedByteSize: expectedSize,
        })
      : null;
  const sha256 = downloaded?.sha256 ?? expectedSha;
  const byteSize = downloaded?.byteSize ?? expectedSize;
  const association = {
    resultId: exact.result.id,
    resultAttemptId: exact.resultAttemptId,
    airfoilId: exact.result.airfoilId,
    simJobId: exact.attempt.simJobId,
    engineJobId: exact.attempt.engineJobId,
    engineCaseSlug: exact.attempt.engineCaseSlug,
    methodKey: exact.attempt.methodKey,
    solverImplementationId: exact.attempt.solverImplementationId,
    solverRuntimeBuildId: exact.attempt.solverRuntimeBuildId,
    aoaDeg: exact.attempt.aoaDeg,
    kind,
    field: nullableText(data.field),
    role: nullableText(data.role),
    storageKey: localStorageKey,
    mimeType,
    sha256,
    byteSize,
    engineUrl: remoteDownloadUrl,
    metadata: {
      ...metadata,
      source: "upstream-sync",
      remoteArtifactId,
      generationManifestSha256: exact.manifestSha256,
    },
  };
  const artifact = await withEvidenceArtifactWriteLocks(
    db,
    {
      storageKey: localStorageKey,
      sha256,
      incomingResultId: exact.result.id,
    },
    async (tx) => {
      const [inserted] = await tx
        .insert(solverEvidenceArtifacts)
        .values(association)
        .onConflictDoNothing()
        .returning({ id: solverEvidenceArtifacts.id });
      return inserted;
    },
  );
  const artifactId =
    artifact?.id ??
    (
      await db
        .select({ id: solverEvidenceArtifacts.id })
        .from(solverEvidenceArtifacts)
        .where(
          and(
            eq(solverEvidenceArtifacts.resultAttemptId, exact.resultAttemptId),
            eq(solverEvidenceArtifacts.kind, association.kind),
            sql`${solverEvidenceArtifacts.field} IS NOT DISTINCT FROM ${association.field}`,
            sql`${solverEvidenceArtifacts.role} IS NOT DISTINCT FROM ${association.role}`,
            eq(solverEvidenceArtifacts.storageKey, localStorageKey),
            eq(solverEvidenceArtifacts.sha256, sha256),
          ),
        )
        .limit(1)
    )[0]?.id ??
    null;
  if (!artifactId) {
    if (downloaded?.newlyCommitted) {
      await unlink(join(env.mediaDir, downloaded.storageKey)).catch(
        () => undefined,
      );
    }
    return {
      imported: false,
      conflictId: await createConflict({
        dataType: "evidence_artifacts",
        naturalKey: remoteArtifactId,
        incomingPayload: {
          ...data,
          syncImportDisposition: "immutable_replay_mismatch",
        },
        sourceInstanceId: source.sourceInstanceId,
        sourceInstanceName: source.sourceInstanceName,
      }),
    };
  }
  if (!artifact) {
    const [replayed] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.id, artifactId))
      .limit(1);
    if (
      !replayed ||
      stableHash(replayed as unknown as Record<string, unknown>) !==
        stableHash({
          ...association,
          id: replayed?.id,
          simJobId: replayed?.simJobId ?? null,
          createdAt: replayed?.createdAt,
        })
    ) {
      if (downloaded?.newlyCommitted) {
        await unlink(join(env.mediaDir, downloaded.storageKey)).catch(
          () => undefined,
        );
      }
      return {
        imported: false,
        conflictId: await createConflict({
          dataType: "evidence_artifacts",
          naturalKey: remoteArtifactId,
          incomingPayload: {
            ...data,
            syncImportDisposition: "immutable_replay_mismatch",
          },
          localSnapshot: replayed as unknown as Record<string, unknown>,
          sourceInstanceId: source.sourceInstanceId,
          sourceInstanceName: source.sourceInstanceName,
        }),
      };
    }
  }
  await upsertRemoteAssetReference({
    localKind: "evidence_artifact",
    localRowId: artifactId,
    localStorageKey,
    resultId: exact.result.id,
    resultAttemptId: exact.resultAttemptId,
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

async function runUpstreamSync(
  modeOverride?: "full" | "db_only_remote_assets",
  typesOverride?: SyncDataType[],
  limit = 200,
) {
  const { settings } = await getSettings();
  if (!settings.upstreamBaseUrl)
    throw new Error("up-tier API endpoint is not configured");
  const mode = modeOverride ?? settings.syncMode;
  const statusRes = await fetch(`${upstreamBase(settings)}/status`, {
    headers: remoteHeaders(settings),
  });
  if (!statusRes.ok)
    throw new Error(`up-tier status failed (${statusRes.status})`);
  const status = (await statusRes.json()) as {
    instanceId?: string;
    instanceName?: string;
  };
  const source = {
    sourceInstanceId: status.instanceId ?? "upstream",
    sourceInstanceName: status.instanceName ?? "Up-tier instance",
  };
  const types = typesOverride ?? [
    "catalog_metadata",
    "mediums",
    "airfoils",
    "simulation_setup",
    "polars",
    "evidence_artifacts",
    "result_media",
  ];
  let imported = 0;
  const conflictIds: string[] = [];
  for (const type of types) {
    let cursor = 0;
    for (;;) {
      const url = `${upstreamBase(settings)}/export?types=${encodeURIComponent(type)}&cursor=${cursor}&limit=${limit}&assetMode=${mode === "full" ? "full" : "remote_refs"}`;
      const res = await fetch(url, { headers: remoteHeaders(settings) });
      if (!res.ok)
        throw new Error(`up-tier export ${type} failed (${res.status})`);
      const payload = (await res.json()) as {
        items?: { type: SyncDataType; data: Record<string, unknown> }[];
        nextCursor?: number | null;
      };
      for (const item of payload.items ?? []) {
        if (item.type === "catalog_metadata") {
          if (
            item.data.kind === "category" &&
            (await importCategory(item.data))
          )
            imported++;
          else if (
            item.data.kind === "hashtag" &&
            (await importHashtag(item.data))
          )
            imported++;
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
          const result = await importRemoteMediaReference(
            item.data,
            settings,
            mode,
            source,
          );
          if (result.imported) imported++;
          if (result.conflictId) conflictIds.push(result.conflictId);
        } else if (item.type === "evidence_artifacts") {
          const result = await importRemoteEvidenceReference(
            item.data,
            settings,
            mode,
            source,
          );
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
    .set({
      remoteSolverLastSyncAt: new Date(),
      remoteSolverLastStatus: "idle",
      remoteSolverLastError: null,
      updatedAt: new Date(),
    })
    .where(eq(syncApiSettings.id, 1));
  return {
    imported,
    conflicts: conflictIds,
    mode,
    sourceInstanceId: source.sourceInstanceId,
  };
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
    const body = solverRegisterSchema.parse(req.body ?? {});
    const [registered] = await db
      .select()
      .from(registeredRemoteSolvers)
      .where(eq(registeredRemoteSolvers.instanceId, body.instanceId))
      .limit(1);
    if (registered) {
      if (
        registered.authTokenHash === null &&
        registered.credentialVersion === 0 &&
        registered.revokedAt === null
      ) {
        const ctx = await requireSync(req, reply, "sweeps", "fetch");
        if (!ctx) return;
        const authToken = randomBytes(32).toString("base64url");
        const [bootstrapped] = await db
          .update(registeredRemoteSolvers)
          .set({
            instanceName: body.instanceName,
            publicEndpoint: body.publicEndpoint ?? null,
            localEndpoint: body.localEndpoint ?? null,
            cpuCapacity: body.cpuCapacity,
            cpuBudget: body.cpuBudget,
            buildVersion: body.buildVersion ?? null,
            authTokenHash: solverTokenHash(authToken),
            credentialVersion: 1,
            status: "idle",
            lastHeartbeatAt: new Date(),
            recentError: null,
            metadata: body.metadata ?? {},
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(registeredRemoteSolvers.id, registered.id),
              isNull(registeredRemoteSolvers.authTokenHash),
              eq(registeredRemoteSolvers.credentialVersion, 0),
              isNull(registeredRemoteSolvers.revokedAt),
            ),
          )
          .returning();
        if (!bootstrapped) {
          return reply.code(409).send({
            error:
              "legacy solver credential was provisioned concurrently; retry with that credential or rotate it as an administrator",
          });
        }
        return {
          credentialRotated: true,
          authToken,
          solver: {
            id: bootstrapped.id,
            instanceId: bootstrapped.instanceId,
            instanceName: bootstrapped.instanceName,
            cpuBudget: bootstrapped.cpuBudget,
            status: bootstrapped.status,
          },
        };
      }
      const authenticated = await requireRegisteredRemoteSolver(
        req,
        reply,
        registered.id,
      );
      if (!authenticated) return;
      const ctx = await getSettings();
      if (
        !ctx.settings.enabled ||
        !ctx.permissions.find((row) => row.dataType === "sweeps")?.canFetch
      )
        return reply.code(403).send({ error: "fetch disabled for sweeps" });
      const [refreshed] = await db
        .update(registeredRemoteSolvers)
        .set({
          instanceName: body.instanceName,
          publicEndpoint: body.publicEndpoint ?? null,
          localEndpoint: body.localEndpoint ?? null,
          cpuCapacity: body.cpuCapacity,
          cpuBudget: body.cpuBudget,
          buildVersion: body.buildVersion ?? null,
          status: "idle",
          lastHeartbeatAt: new Date(),
          recentError: null,
          metadata: body.metadata ?? {},
          updatedAt: new Date(),
        })
        .where(eq(registeredRemoteSolvers.id, registered.id))
        .returning();
      return {
        credentialRotated: false,
        solver: {
          id: refreshed.id,
          instanceId: refreshed.instanceId,
          instanceName: refreshed.instanceName,
          cpuBudget: refreshed.cpuBudget,
          status: refreshed.status,
        },
      };
    } else {
      const ctx = await requireSync(req, reply, "sweeps", "fetch");
      if (!ctx) return;
    }
    const authToken = randomBytes(32).toString("base64url");
    const values = {
      instanceId: body.instanceId,
      instanceName: body.instanceName,
      publicEndpoint: body.publicEndpoint ?? null,
      localEndpoint: body.localEndpoint ?? null,
      cpuCapacity: body.cpuCapacity,
      cpuBudget: body.cpuBudget,
      buildVersion: body.buildVersion ?? null,
      authTokenHash: solverTokenHash(authToken),
      credentialVersion: 1,
      revokedAt: null,
      status: "idle" as const,
      lastHeartbeatAt: new Date(),
      recentError: null,
      metadata: body.metadata ?? {},
      updatedAt: new Date(),
    };
    const [solver] = await db
      .insert(registeredRemoteSolvers)
      .values(values)
      // Bootstrap is create-only. Two callers may both observe no row, but
      // only the winner receives a credential; the loser must authenticate
      // with that credential or use the explicit admin rotation flow. Never
      // overwrite a token merely because registration raced.
      .onConflictDoNothing({ target: registeredRemoteSolvers.instanceId })
      .returning();
    if (!solver) {
      return reply.code(409).send({
        error:
          "solver instance was registered concurrently; retry with its existing solver credential or rotate it as an administrator",
      });
    }
    return {
      credentialRotated: true,
      authToken,
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
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const authenticated = await requireRegisteredRemoteSolver(
      req,
      reply,
      params.id,
    );
    if (!authenticated) return;
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
    if (body.publicEndpoint !== undefined)
      update.publicEndpoint = body.publicEndpoint ?? null;
    if (body.localEndpoint !== undefined)
      update.localEndpoint = body.localEndpoint ?? null;
    if (body.cpuCapacity !== undefined) update.cpuCapacity = body.cpuCapacity;
    if (body.cpuBudget !== undefined) update.cpuBudget = body.cpuBudget;
    if (body.buildVersion !== undefined)
      update.buildVersion = body.buildVersion ?? null;
    if (body.solvedCount !== undefined) update.solvedCount = body.solvedCount;
    if (body.pushedCount !== undefined) update.pushedCount = body.pushedCount;
    if (body.metadata !== undefined) update.metadata = body.metadata;
    const [solver] = await db
      .update(registeredRemoteSolvers)
      .set(update)
      .where(eq(registeredRemoteSolvers.id, params.id))
      .returning();
    if (!solver)
      return reply.code(404).send({ error: "registered solver not found" });
    return { ok: true, solver: remoteSolverStatusPayload(solver) };
  });

  app.post("/api/sync/v1/solvers/:id/progress", async (req, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const authenticated = await requireRegisteredRemoteSolver(
      req,
      reply,
      params.id,
    );
    if (!authenticated) return;
    const body = solverProgressSchema.parse(req.body ?? {});
    const [existing] = await db
      .select()
      .from(registeredRemoteSolvers)
      .where(eq(registeredRemoteSolvers.id, params.id))
      .limit(1);
    if (!existing)
      return reply.code(404).send({ error: "registered solver not found" });
    const update: Partial<typeof registeredRemoteSolvers.$inferInsert> = {
      lastHeartbeatAt: new Date(),
      solvedCount: existing.solvedCount + body.solvedCountDelta,
      pushedCount: existing.pushedCount + body.pushedCountDelta,
      recentError: body.recentError ?? existing.recentError,
      updatedAt: new Date(),
    };
    if (body.status) update.status = body.status;
    if (body.activePromiseCount !== undefined)
      update.activePromiseCount = body.activePromiseCount;
    if (body.activeAoaCount !== undefined)
      update.activeAoaCount = body.activeAoaCount;
    if (body.metadata !== undefined) update.metadata = body.metadata;
    const [solver] = await db
      .update(registeredRemoteSolvers)
      .set(update)
      .where(eq(registeredRemoteSolvers.id, params.id))
      .returning();
    return { ok: true, solver: remoteSolverStatusPayload(solver) };
  });

  app.post("/api/sync/v1/evidence-uploads", async (req, reply) => {
    const solver = await requireRegisteredRemoteSolver(req, reply);
    if (!solver) return;
    const ctx = await getSettings();
    if (
      !ctx.settings.enabled ||
      !ctx.permissions.find((row) => row.dataType === "evidence_artifacts")
        ?.canPush
    )
      return reply
        .code(403)
        .send({ error: "push disabled for evidence_artifacts" });
    const body = brokeredEvidenceRequestSchema.parse(req.body ?? {});
    try {
      return await requestBrokeredEvidenceUpload(db, solver, body);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "evidence upload request failed";
      const status = message.includes("quota") ? 429 : 409;
      return reply.code(status).send({ error: message });
    }
  });

  app.post("/api/sync/v1/evidence-uploads/:id/verify", async (req, reply) => {
    const solver = await requireRegisteredRemoteSolver(req, reply);
    if (!solver) return;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = brokeredEvidenceVerifySchema.parse(req.body ?? {});
    try {
      return await verifyBrokeredEvidenceUpload(
        db,
        solver,
        params.id,
        body.generation,
      );
    } catch (error) {
      return reply.code(409).send({
        error:
          error instanceof Error
            ? error.message
            : "evidence verification failed",
      });
    }
  });

  app.get("/api/sync/v1/evidence-uploads/:id/download", async (req, reply) => {
    const solver = await requireRegisteredRemoteSolver(req, reply);
    if (!solver) return;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      const archive = await fetchBoundBrokeredEvidenceArchive(
        db,
        solver,
        params.id,
      );
      reply
        .header("content-type", archive.mimeType)
        .header("content-length", String(archive.size))
        .header("x-content-sha256", archive.storedSha256)
        .header("x-gcs-generation", archive.generation)
        .header("cache-control", "private, no-store");
      return reply.send(Readable.fromWeb(archive.body));
    } catch (error) {
      return reply.code(409).send({
        error:
          error instanceof Error
            ? error.message
            : "bound evidence archive is unavailable",
      });
    }
  });

  app.post("/api/sync/v1/sweeps/claim", async (req, reply) => {
    const body = claimBodySchema.parse(req.body ?? {});
    let ctx: Awaited<ReturnType<typeof getSettings>> | null;
    let authenticatedSolver:
      | typeof registeredRemoteSolvers.$inferSelect
      | null = null;
    if (body.solverId) {
      authenticatedSolver = await requireRegisteredRemoteSolver(
        req,
        reply,
        body.solverId,
      );
      if (!authenticatedSolver) return;
      ctx = await getSettings();
      const permitted = ctx.permissions.find(
        (row) => row.dataType === "sweeps",
      )?.canFetch;
      if (!ctx.settings.enabled || !permitted)
        return reply.code(403).send({ error: "fetch disabled for sweeps" });
    } else {
      ctx = await requireSync(req, reply, "sweeps", "fetch");
      if (!ctx) return;
    }
    let registeredSolver: typeof registeredRemoteSolvers.$inferSelect | null =
      authenticatedSolver;
    if (body.solverId) {
      [registeredSolver] = await db
        .select()
        .from(registeredRemoteSolvers)
        .where(eq(registeredRemoteSolvers.id, body.solverId))
        .limit(1);
      if (!registeredSolver)
        return reply.code(404).send({ error: "registered solver not found" });
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
      .filter(
        (row) =>
          row.airfoil_id === first.airfoil_id &&
          row.revision_id === first.revision_id,
      )
      .slice(0, body.limit)
      .map((row) => Number(row.aoa_deg))
      .sort((a, b) => a - b);
    const [promise] = await db
      .insert(syncSweepPromises)
      .values({
        sourceInstanceId:
          registeredSolver?.instanceId ?? body.sourceInstanceId ?? null,
        sourceInstanceName:
          registeredSolver?.instanceName ?? body.sourceInstanceName ?? null,
        sourceBaseUrl:
          registeredSolver?.publicEndpoint ?? body.sourceBaseUrl ?? null,
        airfoilId: first.airfoil_id,
        simulationPresetRevisionId: first.revision_id,
        aoaCount: aoas.length,
        expiresAt,
        requestPayload: {
          limit: body.limit,
          ttlHours,
          solverId: registeredSolver?.id ?? null,
          sourceBaseUrl:
            registeredSolver?.publicEndpoint ?? body.sourceBaseUrl ?? null,
        },
      })
      .returning();
    const pointRows = await db
      .insert(syncSweepPromisePoints)
      .values(
        aoas.map((aoaDeg) => ({
          promiseId: promise.id,
          airfoilId: first.airfoil_id,
          simulationPresetRevisionId: first.revision_id,
          aoaDeg,
        })),
      )
      .onConflictDoNothing()
      .returning({ aoaDeg: syncSweepPromisePoints.aoaDeg });
    if (!pointRows.length) {
      await db
        .update(syncSweepPromises)
        .set({ status: "cancelled", cancelledAt: new Date() })
        .where(eq(syncSweepPromises.id, promise.id));
      return { promise: null };
    }
    const promisedAoas = pointRows
      .map((row) => Number(row.aoaDeg))
      .sort((a, b) => a - b);
    await db
      .update(syncSweepPromises)
      .set({ aoaCount: promisedAoas.length })
      .where(eq(syncSweepPromises.id, promise.id));
    if (registeredSolver) {
      const [active] = await db
        .select({
          promises: count(),
          aoas: sql<number>`COALESCE(SUM(${syncSweepPromises.aoaCount}), 0)::int`,
        })
        .from(syncSweepPromises)
        .where(
          and(
            eq(syncSweepPromises.sourceInstanceId, registeredSolver.instanceId),
            eq(syncSweepPromises.status, "active"),
          ),
        );
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
    const params = z.object({ promiseId: z.string().uuid() }).parse(req.params);
    const ctx = await requirePromiseSyncAccess(req, reply, params.promiseId);
    if (!ctx) return;
    const body = heartbeatBodySchema.parse(req.body ?? {});
    const expiresAt = new Date(
      Date.now() +
        (body.ttlHours ?? ctx.settings.defaultPromiseTtlHours) * 3600_000,
    );
    const [row] = await db
      .update(syncSweepPromises)
      .set({ expiresAt, lastHeartbeatAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(syncSweepPromises.id, params.promiseId),
          eq(syncSweepPromises.status, "active"),
          sql`${syncSweepPromises.expiresAt} > now()`,
        ),
      )
      .returning();
    if (!row) {
      const [existing] = await db
        .select({ status: syncSweepPromises.status })
        .from(syncSweepPromises)
        .where(eq(syncSweepPromises.id, params.promiseId))
        .limit(1);
      return reply.code(existing ? 409 : 404).send({
        error: existing
          ? "promise lease is no longer active"
          : "promise not found",
      });
    }
    return { ok: true, expiresAt: expiresAt.toISOString() };
  });

  app.post("/api/sync/v1/sweeps/:promiseId/cancel", async (req, reply) => {
    const params = z.object({ promiseId: z.string().uuid() }).parse(req.params);
    const ctx = await requirePromiseSyncAccess(req, reply, params.promiseId);
    if (!ctx) return;
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      const [promise] = (await tx.execute(sql`
        SELECT id, status
        FROM sync_sweep_promises
        WHERE id = ${params.promiseId}
        FOR UPDATE
      `)) as unknown as Array<{ id: string; status: string }>;
      if (!promise) return "missing" as const;
      if (promise.status === "fulfilled" || promise.status === "cancelled")
        return "terminal" as const;
      const cancelled = await tx
        .update(syncSweepPromises)
        .set({
          status: "cancelled",
          cancelledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(syncSweepPromises.id, params.promiseId),
            inArray(syncSweepPromises.status, ["active", "expired"]),
          ),
        )
        .returning({ id: syncSweepPromises.id });
      if (!cancelled.length) return "terminal" as const;
      await tx
        .update(syncSweepPromisePoints)
        .set({ status: "cancelled", updatedAt: new Date() })
        .where(
          and(
            eq(syncSweepPromisePoints.promiseId, params.promiseId),
            inArray(syncSweepPromisePoints.status, ["active", "expired"]),
          ),
        );
      return "cancelled" as const;
    });
    if (outcome === "missing")
      return reply.code(404).send({ error: "promise not found" });
    return { ok: true };
  });

  app.post("/api/sync/v1/sweeps/:promiseId/complete", async (req, reply) => {
    const params = z.object({ promiseId: z.string().uuid() }).parse(req.params);
    const ctx = await requirePromiseSyncAccess(req, reply, params.promiseId);
    if (!ctx) return;
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      const [promise] = (await tx.execute(sql`
        SELECT id, status, aoa_count
        FROM sync_sweep_promises
        WHERE id = ${params.promiseId}
        FOR UPDATE
      `)) as unknown as Array<{
        id: string;
        status: string;
        aoa_count: number;
      }>;
      if (!promise) return { kind: "missing" as const };
      if (promise.status === "cancelled") return { kind: "cancelled" as const };
      const [coverage] = (await tx.execute(sql`
        SELECT count(point.id)::int AS point_count,
               count(*) FILTER (
                 WHERE point.status <> 'fulfilled'
                    OR point.result_id IS NULL
                    OR point.result_attempt_id IS NULL
                    OR NOT EXISTS (
                      SELECT 1
                      FROM results canonical
                      JOIN result_classifications classification
                        ON classification.result_id = canonical.id
                      WHERE canonical.id = point.result_id
                        AND canonical.current_result_attempt_id = point.result_attempt_id
                        AND classification.state = 'accepted'
                    )
                    OR NOT EXISTS (
                      SELECT 1
                      FROM result_attempts attempt
                      JOIN result_classifications classification
                        ON classification.result_attempt_id = attempt.id
                       AND classification.state = 'accepted'
                      WHERE attempt.id = point.result_attempt_id
                        AND attempt.result_id = point.result_id
                        AND (
                          SELECT count(*) = 1
                             AND count(*) FILTER (
                               WHERE manifest.sha256 ~ '^[0-9a-fA-F]{64}$'
                                 AND manifest.byte_size > 0
                                 AND length(trim(manifest.storage_key)) > 0
                                 AND length(trim(manifest.mime_type)) > 0
                             ) = 1
                          FROM solver_evidence_artifacts manifest
                          WHERE manifest.result_id = point.result_id
                            AND manifest.result_attempt_id = point.result_attempt_id
                            AND manifest.kind = 'manifest'
                        )
                        AND NOT EXISTS (
                          SELECT 1
                          FROM result_media media
                          WHERE media.result_id = point.result_id
                            AND media.result_attempt_id = point.result_attempt_id
                            AND media.evidence_sha256 IS DISTINCT FROM (
                              SELECT manifest.sha256
                              FROM solver_evidence_artifacts manifest
                              WHERE manifest.result_id = point.result_id
                                AND manifest.result_attempt_id = point.result_attempt_id
                                AND manifest.kind = 'manifest'
                              LIMIT 1
                            )
                        )
                        AND NOT EXISTS (
                          SELECT 1
                          FROM result_field_extents extent
                          WHERE extent.result_id = point.result_id
                            AND extent.result_attempt_id = point.result_attempt_id
                            AND extent.evidence_sha256 IS DISTINCT FROM (
                              SELECT manifest.sha256
                              FROM solver_evidence_artifacts manifest
                              WHERE manifest.result_id = point.result_id
                                AND manifest.result_attempt_id = point.result_attempt_id
                                AND manifest.kind = 'manifest'
                              LIMIT 1
                            )
                        )
                    )
               )::int AS unfulfilled_count
        FROM sync_sweep_promise_points point
        WHERE point.promise_id = ${params.promiseId}
      `)) as unknown as Array<{
        point_count: number;
        unfulfilled_count: number;
      }>;
      const pointCount = Number(coverage?.point_count ?? 0);
      const unfulfilledCount = Number(coverage?.unfulfilled_count ?? 0);
      if (
        Number(promise.aoa_count) <= 0 ||
        pointCount !== Number(promise.aoa_count) ||
        unfulfilledCount > 0
      ) {
        return {
          kind: "incomplete" as const,
          pointCount,
          expectedCount: Number(promise.aoa_count),
          unfulfilledCount:
            unfulfilledCount +
            Math.max(0, Number(promise.aoa_count) - pointCount),
        };
      }
      const [row] = await tx
        .update(syncSweepPromises)
        .set({
          status: "fulfilled",
          fulfilledAt: new Date(),
          updatedAt: new Date(),
          responsePayload: jsonObject(req.body),
        })
        .where(eq(syncSweepPromises.id, params.promiseId))
        .returning();
      return { kind: "fulfilled" as const, row };
    });
    if (outcome.kind === "missing")
      return reply.code(404).send({ error: "promise not found" });
    if (outcome.kind === "cancelled")
      return reply.code(409).send({ error: "promise is cancelled" });
    if (outcome.kind === "incomplete") {
      return reply.code(409).send({
        error: "promise still has points without imported solver evidence",
        expectedPointCount: outcome.expectedCount,
        pointCount: outcome.pointCount,
        unfulfilledPointCount: outcome.unfulfilledCount,
      });
    }
    return { ok: true, promise: outcome.row };
  });

  app.get("/api/sync/v1/export", async (req, reply) => {
    const query = exportQuerySchema.parse(req.query);
    const types = (query.types ? query.types.split(",") : SYNC_DATA_TYPES)
      .map((x) => x.trim())
      .filter(Boolean) as SyncDataType[];
    for (const type of types) {
      if (!SYNC_DATA_TYPES.includes(type))
        return reply.code(400).send({ error: `unknown type ${type}` });
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
        const cats = await db
          .select()
          .from(categories)
          .orderBy(asc(categories.path))
          .limit(remaining)
          .offset(query.cursor);
        items.push(
          ...cats.map((row) => exportRow(type, { kind: "category", ...row })),
        );
        if (items.length < query.limit) {
          const tags = await db
            .select()
            .from(hashtags)
            .orderBy(asc(hashtags.slug))
            .limit(query.limit - items.length)
            .offset(query.cursor);
          items.push(
            ...tags.map((row) => exportRow(type, { kind: "hashtag", ...row })),
          );
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
          ? await db
              .select()
              .from(mediumViscosityTablePoints)
              .where(
                inArray(
                  mediumViscosityTablePoints.mediumId,
                  rows.map((r) => r.id),
                ),
              )
          : [];
        items.push(
          ...rows.map((row) =>
            exportRow(type, {
              ...row,
              viscosityTable: pointRows.filter((p) => p.mediumId === row.id),
            }),
          ),
        );
      } else if (type === "simulation_setup") {
        const revisions = await db
          .select()
          .from(simulationPresetRevisions)
          .orderBy(desc(simulationPresetRevisions.createdAt))
          .limit(remaining)
          .offset(query.cursor);
        items.push(
          ...revisions.map((row) =>
            exportRow(type, { kind: "simulation_preset_revision", ...row }),
          ),
        );
      } else if (type === "polars") {
        const rows = await db
          .select()
          .from(results)
          .where(since ? gte(results.updatedAt, since) : undefined)
          .orderBy(desc(results.updatedAt))
          .limit(remaining)
          .offset(query.cursor);
        const airfoilRows = rows.length
          ? await db
              .select({ id: airfoils.id, slug: airfoils.slug })
              .from(airfoils)
              .where(
                inArray(
                  airfoils.id,
                  rows.map((r) => r.airfoilId),
                ),
              )
          : [];
        const revisionRows = rows.some((row) => row.simulationPresetRevisionId)
          ? await db
              .select({
                id: simulationPresetRevisions.id,
                signatureHash: simulationPresetRevisions.signatureHash,
              })
              .from(simulationPresetRevisions)
              .where(
                inArray(
                  simulationPresetRevisions.id,
                  rows
                    .map((r) => r.simulationPresetRevisionId)
                    .filter(Boolean) as string[],
                ),
              )
          : [];
        const airfoilSlugById = new Map(
          airfoilRows.map((row) => [row.id, row.slug]),
        );
        const revisionSignatureById = new Map(
          revisionRows.map((row) => [row.id, row.signatureHash]),
        );
        items.push(
          ...rows.map((row) =>
            exportRow(type, {
              ...row,
              remoteResultId: row.id,
              airfoilSlug: airfoilSlugById.get(row.airfoilId) ?? null,
              simulationPresetSignatureHash: row.simulationPresetRevisionId
                ? (revisionSignatureById.get(row.simulationPresetRevisionId) ??
                  null)
                : null,
            }),
          ),
        );
      } else if (type === "evidence_artifacts") {
        const rows = await db
          .select()
          .from(solverEvidenceArtifacts)
          .orderBy(desc(solverEvidenceArtifacts.createdAt))
          .limit(remaining)
          .offset(query.cursor);
        items.push(
          ...rows.map((row) =>
            exportRow(type, {
              ...row,
              remoteArtifactId: row.id,
              remoteResultId: row.resultId,
              downloadUrl: `/api/sync/v1/artifacts/${row.id}/download`,
            }),
          ),
        );
      } else if (type === "result_media") {
        const rows = await db
          .select()
          .from(resultMedia)
          .orderBy(desc(resultMedia.createdAt))
          .limit(remaining)
          .offset(query.cursor);
        items.push(
          ...rows.map((row) =>
            exportRow(type, {
              ...row,
              remoteMediaId: row.id,
              remoteResultId: row.resultId,
              downloadUrl: `/api/sync/v1/media/${row.id}/download`,
            }),
          ),
        );
      }
    }
    return {
      items,
      nextCursor:
        items.length === query.limit ? query.cursor + items.length : null,
    };
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
        if (item.data.kind === "category" && (await importCategory(item.data)))
          imported++;
        else if (
          item.data.kind === "hashtag" &&
          (await importHashtag(item.data))
        )
          imported++;
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
  app.post(
    "/api/sync/v1/polars",
    { bodyLimit: SYNC_POLAR_PUSH_BODY_LIMIT_BYTES },
    async (req, reply) => {
      let authenticatedSolver:
        | typeof registeredRemoteSolvers.$inferSelect
        | null = null;
      let ctx: Awaited<ReturnType<typeof getSettings>> | null;
      if (remoteSolverToken(req)) {
        authenticatedSolver = await requireRegisteredRemoteSolver(req, reply);
        if (!authenticatedSolver) return;
        ctx = await getSettings();
        if (
          !ctx.settings.enabled ||
          !ctx.permissions.find((row) => row.dataType === "polars")?.canPush
        )
          return reply.code(403).send({ error: "push disabled for polars" });
      } else {
        ctx = await requireSync(req, reply, "polars", "push");
        if (!ctx) return;
      }
      let parsed: Awaited<ReturnType<typeof parsePolarRequest>>;
      try {
        parsed = await parsePolarRequest(req);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.code(400).send({ error: error.flatten() });
        }
        throw error;
      }
      const { payload, files, capacityReservation } = parsed;
      if (!authenticatedSolver && payload.promiseId) {
        const [promise] = await db
          .select({ requestPayload: syncSweepPromises.requestPayload })
          .from(syncSweepPromises)
          .where(eq(syncSweepPromises.id, payload.promiseId))
          .limit(1);
        if (
          promise &&
          typeof (promise.requestPayload as Record<string, unknown> | null)
            ?.solverId === "string"
        ) {
          await cleanupMultipartTemps(files);
          await capacityReservation?.release();
          return reply
            .code(401)
            .send({ error: "remote solver credential required" });
        }
      }
      if (authenticatedSolver) {
        const [promise] = payload.promiseId
          ? await db
              .select()
              .from(syncSweepPromises)
              .where(eq(syncSweepPromises.id, payload.promiseId))
              .limit(1)
          : [];
        if (
          !promise ||
          payload.sourceInstanceId !== authenticatedSolver.instanceId ||
          promise.sourceInstanceId !== authenticatedSolver.instanceId ||
          String(
            (promise.requestPayload as Record<string, unknown> | null)
              ?.solverId ?? "",
          ) !== authenticatedSolver.id
        ) {
          await cleanupMultipartTemps(files);
          await capacityReservation?.release();
          return reply.code(403).send({
            error: "remote solver does not own this exact promise payload",
          });
        }
      }
      let conflictError: string | null = null;
      let permissionError: string | null = null;
      let blobLocks: Awaited<ReturnType<typeof acquireSyncBlobLocks>> | null =
        null;
      let response: Awaited<ReturnType<typeof importPolarPush>> | null = null;
      try {
        const needsArtifacts = payload.results.some(
          (row) => row.evidenceArtifacts.length > 0,
        );
        const needsMedia = payload.results.some((row) => row.media.length > 0);
        if (
          needsArtifacts &&
          !(
            ctx.permissions.find((p) => p.dataType === "evidence_artifacts")
              ?.canPush ?? false
          )
        ) {
          permissionError = "push disabled for evidence_artifacts";
        }
        if (
          needsMedia &&
          !(
            ctx.permissions.find((p) => p.dataType === "result_media")
              ?.canPush ?? false
          )
        ) {
          permissionError = "push disabled for result_media";
        }
        if (!permissionError) {
          // Hold a shared-process-independent lock from blob publication until
          // the final reference check. A concurrent importer that observes an
          // EEXIST blob can therefore never race a failed owner's cleanup and
          // commit a DB association to bytes that are about to be unlinked.
          blobLocks = await acquireSyncBlobLocks(payload, files);
          await commitMultipartFiles(files);
          response = await importPolarPush(payload, files, capacityReservation);
        }
      } catch (error) {
        if (
          error instanceof PolarPromiseScopeError ||
          error instanceof PolarEvidenceBindingError
        ) {
          conflictError = error.message;
        } else {
          throw error;
        }
      } finally {
        await cleanupMultipartTemps(files);
        try {
          await cleanupUnreferencedCommittedFiles(files);
        } finally {
          try {
            await blobLocks?.release();
          } finally {
            await capacityReservation?.release();
          }
        }
      }
      if (permissionError)
        return reply.code(403).send({ error: permissionError });
      if (response) {
        if (!authenticatedSolver) {
          return { ...response, bindingReceipts: [] };
        }
        const token = remoteSolverToken(req);
        if (!token) {
          return reply.code(401).send({
            error: "remote solver credential required for binding receipt",
          });
        }
        return {
          ...response,
          bindingReceipts: response.bindingReceipts.map((receipt) =>
            signHubBindingReceipt(receipt, token),
          ),
        };
      }
      return reply.code(409).send({ error: conflictError });
    },
  );

  app.post("/api/sync/v1/conflicts/status", async (req, reply) => {
    let solver: typeof registeredRemoteSolvers.$inferSelect | null = null;
    if (remoteSolverToken(req)) {
      solver = await requireRegisteredRemoteSolver(req, reply);
      if (!solver) return;
    } else {
      const ctx = await requireSync(req, reply, "polars", "push");
      if (!ctx) return;
    }
    const body = conflictStatusBodySchema.parse(req.body ?? {});
    const rows = await db
      .select({
        id: syncImportConflicts.id,
        status: syncImportConflicts.status,
      })
      .from(syncImportConflicts)
      .where(
        and(
          inArray(syncImportConflicts.id, body.ids),
          solver
            ? eq(syncImportConflicts.sourceInstanceId, solver.instanceId)
            : undefined,
        ),
      );
    return { conflicts: rows };
  });

  app.get("/api/sync/v1/artifacts/:id/download", async (req, reply) => {
    const ctx = await requireSync(req, reply, "evidence_artifacts", "fetch");
    if (!ctx) return;
    const params = z.object({ id: z.string().uuid() }).parse(req.params);
    const [row] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.id, params.id))
      .limit(1);
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
    const [row] = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.id, params.id))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "media not found" });
    const file = await mediaStore.stream(row.storageKey);
    reply.header("content-type", file.mime);
    reply.header("content-length", String(file.size));
    return reply.send(file.stream);
  });

  app.post("/api/sync/v1/results/:resultId/render", async (req, reply) => {
    let solver: typeof registeredRemoteSolvers.$inferSelect | null = null;
    if (remoteSolverToken(req)) {
      solver = await requireRegisteredRemoteSolver(req, reply);
      if (!solver) return;
    } else {
      const ctx = await requireSync(req, reply, "result_media", "fetch");
      if (!ctx) return;
    }
    const params = z.object({ resultId: z.string().uuid() }).parse(req.params);
    const renderBody = z
      .object({
        expectedEvidenceSha256: z.string().regex(/^[0-9a-f]{64}$/i),
      })
      .passthrough()
      .parse(req.body ?? {});
    const [selected] = await db
      .select({ result: results, attempt: resultAttempts })
      .from(results)
      .leftJoin(
        resultAttempts,
        and(
          eq(resultAttempts.id, results.currentResultAttemptId),
          eq(resultAttempts.resultId, results.id),
        ),
      )
      .where(eq(results.id, params.resultId))
      .limit(1);
    if (!selected?.result.currentResultAttemptId || !selected.attempt) {
      return reply
        .code(409)
        .send({ error: "remote result has no selected evidence generation" });
    }
    if (solver) {
      const [ownedGeneration] = await db
        .select({ id: syncBrokeredEvidenceUploads.id })
        .from(syncBrokeredEvidenceUploads)
        .where(
          and(
            eq(syncBrokeredEvidenceUploads.solverId, solver.id),
            eq(syncBrokeredEvidenceUploads.state, "bound"),
            eq(
              syncBrokeredEvidenceUploads.canonicalResultId,
              selected.result.id,
            ),
            eq(
              syncBrokeredEvidenceUploads.canonicalResultAttemptId,
              selected.result.currentResultAttemptId,
            ),
          ),
        )
        .limit(1);
      if (!ownedGeneration)
        return reply.code(403).send({
          error:
            "remote solver does not own this canonical evidence generation",
        });
    }
    const manifests = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, params.resultId),
          eq(
            solverEvidenceArtifacts.resultAttemptId,
            selected.result.currentResultAttemptId,
          ),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      );
    const [manifest] = manifests;
    if (
      manifests.length !== 1 ||
      !manifest ||
      !/^[0-9a-f]{64}$/i.test(manifest.sha256) ||
      manifest.byteSize <= 0 ||
      !manifest.storageKey.trim() ||
      !manifest.mimeType.trim() ||
      manifest.airfoilId !== selected.result.airfoilId ||
      manifest.simJobId !== selected.attempt.simJobId ||
      manifest.engineJobId !== selected.attempt.engineJobId ||
      manifest.engineCaseSlug !== selected.attempt.engineCaseSlug ||
      manifest.aoaDeg !== selected.attempt.aoaDeg
    ) {
      return reply.code(409).send({
        error: "remote result has no unique current raw evidence manifest",
      });
    }
    if (renderBody.expectedEvidenceSha256 !== manifest.sha256) {
      return reply.code(409).send({
        error: "remote result evidence generation changed",
      });
    }
    const proto =
      String(req.headers["x-forwarded-proto"] ?? "http")
        .split(",")[0]
        .trim() || "http";
    const host = String(
      req.headers["x-forwarded-host"] ??
        req.headers.host ??
        `localhost:${env.port}`,
    )
      .split(",")[0]
      .trim();
    const res = await fetch(
      `${proto}://${host}/api/results/${encodeURIComponent(params.resultId)}/render`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-xfoilfoam-expected-result-attempt-id":
            selected.result.currentResultAttemptId,
          "x-xfoilfoam-expected-evidence-sha256": manifest.sha256,
        },
        body: JSON.stringify(renderBody),
      },
    );
    const text = await res.text();
    if (res.ok) {
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (
        payload.resultId !== params.resultId ||
        payload.resultAttemptId !== selected.result.currentResultAttemptId ||
        payload.evidenceSha256 !== manifest.sha256 ||
        typeof payload.id !== "string" ||
        typeof payload.url !== "string" ||
        typeof payload.paramsHash !== "string" ||
        typeof payload.mimeType !== "string" ||
        !payload.mimeType.trim() ||
        typeof payload.sha256 !== "string" ||
        !/^[0-9a-f]{64}$/i.test(payload.sha256) ||
        typeof payload.byteSize !== "number" ||
        !Number.isSafeInteger(payload.byteSize) ||
        payload.byteSize <= 0
      ) {
        return reply.code(502).send({
          error: "render response lacks exact generation or content identity",
        });
      }
      return payload;
    }
    reply
      .code(res.status)
      .header(
        "content-type",
        res.headers.get("content-type") ?? "application/json",
      );
    return reply.send(text);
  });

  app.get("/api/admin/sync", { preHandler: requireAdmin }, async (req) =>
    syncAdminPayload(req),
  );

  app.post(
    "/api/admin/sync/solvers/:id/revoke",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const [solver] = await db
        .select({ id: registeredRemoteSolvers.id })
        .from(registeredRemoteSolvers)
        .where(eq(registeredRemoteSolvers.id, params.id))
        .limit(1);
      if (!solver)
        return reply.code(404).send({ error: "registered solver not found" });
      await revokeSolverEvidenceUploads(db, solver.id);
      return syncAdminPayload(req);
    },
  );

  app.post(
    "/api/admin/sync/solvers/:id/rotate-credential",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const [solver] = await db
        .select()
        .from(registeredRemoteSolvers)
        .where(eq(registeredRemoteSolvers.id, params.id))
        .limit(1);
      if (!solver)
        return reply.code(404).send({ error: "registered solver not found" });

      const rotationLock = await acquireSolverCredentialRotationLock(solver.id);
      try {
        const [current] = await db
          .select()
          .from(registeredRemoteSolvers)
          .where(eq(registeredRemoteSolvers.id, solver.id))
          .limit(1);
        if (
          !current ||
          current.credentialVersion !== solver.credentialVersion
        ) {
          return reply.code(409).send({
            error: "solver credential changed while this rotation was waiting",
          });
        }
        // Revocation is durable before cancellation. A failed provider
        // cancellation keeps the protected hub-only bearer for the periodic
        // reconciler and leaves the solver disabled; no replacement token is
        // issued until every old capability is acknowledged cancelled/gone.
        const revoked = await revokeSolverEvidenceUploads(db, solver.id);
        if (revoked.pendingSessionCount > 0) {
          return reply.code(409).send({
            error:
              "solver credential remains revoked while old evidence upload sessions are being cancelled; retry rotation after reconciliation",
            pendingSessionCount: revoked.pendingSessionCount,
          });
        }
        const authToken = randomBytes(32).toString("base64url");
        const [rotated] = await db
          .update(registeredRemoteSolvers)
          .set({
            authTokenHash: solverTokenHash(authToken),
            credentialVersion: current.credentialVersion + 1,
            revokedAt: null,
            status: "idle",
            recentError: null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(registeredRemoteSolvers.id, solver.id),
              eq(
                registeredRemoteSolvers.credentialVersion,
                current.credentialVersion,
              ),
              isNotNull(registeredRemoteSolvers.revokedAt),
              isNull(registeredRemoteSolvers.authTokenHash),
            ),
          )
          .returning({
            id: registeredRemoteSolvers.id,
            credentialVersion: registeredRemoteSolvers.credentialVersion,
          });
        if (!rotated) {
          return reply.code(409).send({
            error: "solver credential rotation lost its serialized state",
          });
        }
        return {
          solverId: rotated.id,
          credentialVersion: rotated.credentialVersion,
          authToken,
        };
      } finally {
        await rotationLock.release();
      }
    },
  );

  app.patch(
    "/api/admin/sync",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const body = syncSettingsPatchSchema.parse(req.body ?? {});
      await ensureSyncRows();
      const { settings: currentSettings } = await getSettings();
      let requestedUpstreamBaseUrl: string | null | undefined;
      try {
        requestedUpstreamBaseUrl =
          body.upstreamBaseUrl === undefined
            ? undefined
            : body.upstreamBaseUrl
              ? canonicalRemoteHubBaseUrl(body.upstreamBaseUrl)
              : null;
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const nextUpstreamBaseUrl =
        requestedUpstreamBaseUrl === undefined
          ? currentSettings.upstreamBaseUrl
          : requestedUpstreamBaseUrl;
      const nextRemoteSolverEnabled =
        body.remoteSolverEnabled ?? currentSettings.remoteSolverEnabled;
      if (nextRemoteSolverEnabled) {
        if (!nextUpstreamBaseUrl) {
          return reply.code(400).send({
            error:
              "remote solver cannot be enabled before a remote hub URL is configured",
          });
        }
        try {
          canonicalRemoteHubBaseUrl(nextUpstreamBaseUrl);
        } catch (error) {
          return reply.code(400).send({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const authorityBaseChanges =
        nextUpstreamBaseUrl !== currentSettings.upstreamBaseUrl;
      const clearsOnlyBootstrapSecret =
        body.upstreamSecret !== undefined && !body.upstreamSecret.trim();
      const clearsLastRemoteCredential =
        clearsOnlyBootstrapSecret && !currentSettings.remoteSolverAuthToken;
      if (authorityBaseChanges || clearsLastRemoteCredential) {
        const [obligations] = (await db.execute(sql`
          SELECT (
            EXISTS (
              SELECT 1
              FROM sync_sweep_promises promise
              WHERE promise.status IN ('active', 'expired')
                AND promise.request_payload ->> 'remoteSolver' = 'true'
            )
            OR EXISTS (
              SELECT 1
              FROM sync_remote_result_deliveries delivery
              WHERE delivery.state IN ('pending', 'pushing', 'retry_wait')
            )
            OR EXISTS (
              SELECT 1
              FROM sync_remote_promise_cancellations cancellation
              WHERE cancellation.state IN ('pending', 'retry_wait')
            )
          ) AS blocked
        `)) as unknown as Array<{ blocked: boolean }>;
        if (obligations?.blocked) {
          return reply.code(409).send({
            error: authorityBaseChanges
              ? "up-tier endpoint cannot change while remote promises, result deliveries, or cancellations are unfinished"
              : "up-tier bootstrap secret cannot be cleared before a per-solver credential is installed while remote work is unfinished",
          });
        }
      }
      const settingsPatch: Partial<typeof syncApiSettings.$inferInsert> = {};
      if (body.enabled !== undefined) settingsPatch.enabled = body.enabled;
      if (body.instanceName !== undefined)
        settingsPatch.instanceName = body.instanceName;
      if (body.publicEndpointOverride !== undefined)
        settingsPatch.publicEndpointOverride =
          body.publicEndpointOverride || null;
      if (body.secret !== undefined) settingsPatch.secret = body.secret;
      if (body.defaultPromiseTtlHours !== undefined)
        settingsPatch.defaultPromiseTtlHours = body.defaultPromiseTtlHours;
      if (body.upstreamBaseUrl !== undefined)
        settingsPatch.upstreamBaseUrl = requestedUpstreamBaseUrl ?? null;
      if (body.upstreamSecret !== undefined)
        settingsPatch.upstreamSecret = body.upstreamSecret;
      if (body.syncMode !== undefined) settingsPatch.syncMode = body.syncMode;
      if (body.remoteSolverEnabled !== undefined)
        settingsPatch.remoteSolverEnabled = body.remoteSolverEnabled;
      if (body.remoteSolverCpuBudget !== undefined)
        settingsPatch.remoteSolverCpuBudget = body.remoteSolverCpuBudget;
      if (body.remoteSolverClaimSize !== undefined)
        settingsPatch.remoteSolverClaimSize = body.remoteSolverClaimSize;
      if (body.remoteSolverHeartbeatIntervalSeconds !== undefined) {
        settingsPatch.remoteSolverHeartbeatIntervalSeconds =
          body.remoteSolverHeartbeatIntervalSeconds;
      }
      if (Object.keys(settingsPatch).length) {
        await db
          .update(syncApiSettings)
          .set({ ...settingsPatch, updatedAt: new Date() })
          .where(eq(syncApiSettings.id, 1));
      }
      for (const permission of body.permissions ?? []) {
        await db
          .insert(syncApiPermissions)
          .values(permission)
          .onConflictDoUpdate({
            target: syncApiPermissions.dataType,
            set: {
              canFetch: permission.canFetch,
              canPush: permission.canPush,
              updatedAt: new Date(),
            },
          });
      }
      return syncAdminPayload(req);
    },
  );

  app.post(
    "/api/admin/sync/remote-solver/credential",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const body = remoteSolverCredentialInstallSchema.parse(req.body ?? {});
      await ensureSyncRows();
      const { settings } = await getSettings();
      if (!settings.upstreamBaseUrl) {
        return reply.code(400).send({
          error:
            "remote solver credential cannot be installed before a remote hub URL is configured",
        });
      }
      try {
        canonicalRemoteHubBaseUrl(settings.upstreamBaseUrl);
      } catch (error) {
        return reply.code(400).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
      await db
        .update(syncApiSettings)
        .set({
          remoteSolverRegisteredId: body.registeredSolverId,
          remoteSolverAuthToken: body.authToken,
          remoteSolverLastStatus: "idle",
          remoteSolverLastError: null,
          updatedAt: new Date(),
        })
        .where(eq(syncApiSettings.id, 1));
      return {
        ok: true,
        registeredSolverId: body.registeredSolverId,
        credentialInstalled: true,
      };
    },
  );

  app.post(
    "/api/admin/sync/upstream/run",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const body = upstreamSyncBodySchema.parse(req.body ?? {});
      try {
        await db
          .update(syncApiSettings)
          .set({
            remoteSolverLastStatus: "syncing",
            remoteSolverLastError: null,
            updatedAt: new Date(),
          })
          .where(eq(syncApiSettings.id, 1));
        const result = await runUpstreamSync(body.mode, body.types, body.limit);
        return { ...(await syncAdminPayload(req)), lastRun: result };
      } catch (e) {
        await db
          .update(syncApiSettings)
          .set({
            remoteSolverLastStatus: "error",
            remoteSolverLastError: e instanceof Error ? e.message : String(e),
            updatedAt: new Date(),
          })
          .where(eq(syncApiSettings.id, 1));
        return reply.code(400).send({
          error: e instanceof Error ? e.message : String(e),
          ...(await syncAdminPayload(req)),
        });
      }
    },
  );

  app.post(
    "/api/admin/sync/conflicts/:id/archive",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const archived = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB;
        const [conflict] = await tx
          .select()
          .from(syncImportConflicts)
          .where(eq(syncImportConflicts.id, params.id))
          .for("update")
          .limit(1);
        if (!conflict || conflict.status !== "pending") return false;
        if (conflict.dataType === "polars") {
          const promiseId = nullableText(
            jsonObject(conflict.artifactManifest).promiseId,
          );
          const [airfoilId, revisionId, ...aoaParts] =
            conflict.naturalKey.split(":");
          const aoaDeg = Number(aoaParts.join(":"));
          if (promiseId && airfoilId && revisionId && Number.isFinite(aoaDeg)) {
            const [canonical] = await tx
              .select({
                resultId: results.id,
                attemptId: results.currentResultAttemptId,
              })
              .from(results)
              .innerJoin(
                resultAttempts,
                and(
                  eq(resultAttempts.id, results.currentResultAttemptId),
                  eq(resultAttempts.resultId, results.id),
                ),
              )
              .innerJoin(
                resultClassifications,
                and(
                  eq(resultClassifications.resultAttemptId, resultAttempts.id),
                  eq(resultClassifications.airfoilId, results.airfoilId),
                  eq(
                    resultClassifications.simulationPresetRevisionId,
                    results.simulationPresetRevisionId,
                  ),
                  eq(resultClassifications.aoaDeg, resultAttempts.aoaDeg),
                  sql`${resultClassifications.regime} IS NOT DISTINCT FROM ${resultAttempts.regime}`,
                  eq(resultClassifications.state, "accepted"),
                ),
              )
              .where(
                and(
                  eq(results.airfoilId, airfoilId),
                  eq(results.simulationPresetRevisionId, revisionId),
                  eq(results.aoaDeg, aoaDeg),
                  isNotNull(results.currentResultAttemptId),
                ),
              )
              .limit(1);
            const settled = canonical?.attemptId
              ? await tx
                  .update(syncSweepPromisePoints)
                  .set({
                    status: "fulfilled",
                    resultId: canonical.resultId,
                    resultAttemptId: canonical.attemptId,
                    updatedAt: new Date(),
                  })
                  .where(
                    and(
                      eq(syncSweepPromisePoints.promiseId, promiseId),
                      eq(syncSweepPromisePoints.airfoilId, airfoilId),
                      eq(
                        syncSweepPromisePoints.simulationPresetRevisionId,
                        revisionId,
                      ),
                      eq(syncSweepPromisePoints.aoaDeg, aoaDeg),
                      inArray(syncSweepPromisePoints.status, [
                        "active",
                        "expired",
                      ]),
                    ),
                  )
                  .returning({ id: syncSweepPromisePoints.id })
              : [];
            if (!settled.length) {
              await tx
                .update(syncSweepPromises)
                .set({
                  status: "cancelled",
                  cancelledAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(
                  and(
                    eq(syncSweepPromises.id, promiseId),
                    inArray(syncSweepPromises.status, ["active", "expired"]),
                  ),
                );
              await tx
                .update(syncSweepPromisePoints)
                .set({ status: "cancelled", updatedAt: new Date() })
                .where(
                  and(
                    eq(syncSweepPromisePoints.promiseId, promiseId),
                    inArray(syncSweepPromisePoints.status, [
                      "active",
                      "expired",
                    ]),
                  ),
                );
            } else {
              await tx.execute(sql`
                UPDATE sync_sweep_promises promise
                SET status = 'fulfilled', "fulfilledAt" = now(), "updatedAt" = now()
                WHERE promise.id = ${promiseId}
                  AND promise.status IN ('active', 'expired')
                  AND promise.aoa_count = (
                    SELECT count(*)::int FROM sync_sweep_promise_points point
                    WHERE point.promise_id = promise.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM sync_sweep_promise_points point
                    WHERE point.promise_id = promise.id
                      AND point.status <> 'fulfilled'
                  )
              `);
            }
          }
        }
        const changed = await tx
          .update(syncImportConflicts)
          .set({
            status: "archived",
            resolvedAt: new Date(),
            resolutionNote: "archived by admin",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(syncImportConflicts.id, params.id),
              eq(syncImportConflicts.status, "pending"),
            ),
          )
          .returning({ id: syncImportConflicts.id });
        return changed.length === 1;
      });
      if (!archived)
        return reply.code(404).send({ error: "pending conflict not found" });
      return syncAdminPayload(req);
    },
  );

  app.post(
    "/api/admin/sync/conflicts/:id/promote",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const params = z.object({ id: z.string().uuid() }).parse(req.params);
      const outcome = await db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as DB;
        const [conflict] = await tx
          .select()
          .from(syncImportConflicts)
          .where(eq(syncImportConflicts.id, params.id))
          .for("update")
          .limit(1);
        if (!conflict || conflict.status !== "pending")
          return { kind: "missing" as const };
        if (conflict.dataType === "polars") return { kind: "polar" as const };
        if (conflict.dataType === "mediums") {
          const slug = nullableText(conflict.incomingPayload.slug);
          if (!slug) return { kind: "invalid-medium" as const };
          await upsertMediumFromPayload(conflict.incomingPayload, tx);
        } else if (conflict.dataType === "airfoils") {
          await upsertAirfoilFromPayload(conflict.incomingPayload, tx);
        } else {
          return {
            kind: "unsupported" as const,
            dataType: conflict.dataType,
          };
        }
        const promoted = await tx
          .update(syncImportConflicts)
          .set({
            status: "promoted",
            resolvedAt: new Date(),
            resolutionNote: "promoted by admin",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(syncImportConflicts.id, conflict.id),
              eq(syncImportConflicts.status, "pending"),
            ),
          )
          .returning({ id: syncImportConflicts.id });
        if (promoted.length !== 1)
          throw new Error("sync conflict changed state during promotion");
        return { kind: "promoted" as const };
      });
      if (outcome.kind === "missing")
        return reply.code(404).send({ error: "pending conflict not found" });
      if (outcome.kind === "invalid-medium")
        return reply.code(400).send({ error: "medium conflict lacks slug" });
      if (outcome.kind === "polar") {
        return reply.code(409).send({
          error:
            "polar conflict bytes are not retained; re-push the complete exact-attempt evidence instead of promoting metadata",
        });
      }
      if (outcome.kind === "unsupported") {
        return reply.code(409).send({
          error: `promotion is not implemented for ${outcome.dataType}; archive or resolve manually`,
        });
      }
      return syncAdminPayload(req);
    },
  );
}
