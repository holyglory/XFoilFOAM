import { exportCoordinates, type Point, RELIST } from "@aerodb/core";
import {
  airfoils,
  boundaryProfiles,
  categories,
  fieldColorScales,
  fieldRenderCache,
  flowConditions,
  mediumViscosityTablePoints,
  mediums,
  meshProfiles,
  operatingConditions,
  outputProfiles,
  referenceGeometryProfiles,
  remoteAssetReferences,
  resultMedia,
  recordReviewVerdict,
  revokeActiveReviewVerdict,
  reviewVerdictHistory,
  activeReviewVerdict,
  CONTINUABLE_SQL,
  results,
  schedulingProfiles,
  simJobs,
  simulationPresetRevisions,
  simulationPresets,
  solverEvidenceArtifacts,
  solverProfiles,
  syncApiSettings,
  sweeperState,
  sweepDefinitions,
} from "@aerodb/db";
import { refreshPolarCacheForRevision } from "@aerodb/db/polar-cache";
import { ensureSimulationPresetRevision } from "@aerodb/db/simulation-setup";
import { EngineClient, type ImageFieldName } from "@aerodb/engine-client";
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";

import { requireAdmin, sessionEmail } from "./admin-auth";
import { db } from "./db";
import { env } from "./env";
import { mediaStore } from "./media-store";
import { createAirfoil, createAirfoilsBulk } from "./services/airfoils";
import { assembleDetail } from "./services/detail";
import { categoriesTree, listAirfoils } from "./services/catalog";
import { listHashtags } from "./services/hashtags";
import {
  mediumViscosityColumns,
  mediumViscosityInputFromMedium,
  resolveViscosity,
  tablePointsDTO,
  toMediumDTO,
} from "./services/mediums";
import { assembleSim } from "./services/sim";
import {
  assembleSolverWork,
  solverWorkStateForPoint,
} from "./services/solver-work";
import { readSweeperState, writeSweeperState } from "./services/sweeper-state";

const nacaSchema = z.object({
  t: z.number().positive(),
  m: z.number().min(0),
  p: z.number().min(0),
});
const imageFieldSchema = z.enum([
  "velocity_magnitude",
  "velocity_x",
  "velocity_y",
  "pressure",
  "pressure_coefficient",
  "vorticity",
  "turbulent_kinetic_energy",
  "turbulent_viscosity",
]);
const reviewVerdictBody = z.object({
  verdict: z.enum(["waive", "exclude", "defer"]),
  note: z.string().optional(),
});

type ReviewableResultContext = {
  id: string;
  airfoilId: string;
  revisionId: string | null;
  status: string | null;
  source: string | null;
  regime: string | null;
  fidelity: string | null;
  classificationState: string | null;
  continuable: boolean | null;
  openVerify: boolean | null;
  openRequest: boolean | null;
  autoRetriedAt: Date | string | null;
  error: string | null;
};

function reviewDTO(row: {
  id: string;
  resultId: string;
  verdict: "waive" | "exclude" | "defer";
  note: string | null;
  reviewer: string;
  createdAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
}) {
  return {
    id: row.id,
    resultId: row.resultId,
    verdict: row.verdict,
    note: row.note,
    reviewer: row.reviewer,
    at: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    revokedBy: row.revokedBy,
  };
}

async function loadReviewableResultContext(
  resultId: string,
): Promise<ReviewableResultContext | null> {
  const rows = (await db.execute(sql`
    SELECT
      r.id,
      r.airfoil_id AS "airfoilId",
      r.simulation_preset_revision_id AS "revisionId",
      r.status::text AS status,
      r.source::text AS source,
      r.regime::text AS regime,
      r.fidelity AS fidelity,
      rc.state::text AS "classificationState",
      ${CONTINUABLE_SQL} AS continuable,
      EXISTS (
        SELECT 1 FROM sim_urans_verify_queue q
        WHERE q.airfoil_id = r.airfoil_id
          AND q.revision_id = r.simulation_preset_revision_id
          AND q.aoa_deg = r.aoa_deg
          AND q.state IN ('pending', 'running')
      ) AS "openVerify",
      EXISTS (
        SELECT 1 FROM sim_urans_requests req
        WHERE req.airfoil_id = r.airfoil_id
          AND req.revision_id = r.simulation_preset_revision_id
          AND (req.aoa_deg = r.aoa_deg OR req.aoa_deg IS NULL OR req.continue_from_result_id = r.id)
          AND req.state IN ('pending', 'running')
      ) AS "openRequest",
      r.auto_retried_at AS "autoRetriedAt",
      r.error
    FROM results r
    LEFT JOIN result_classifications rc ON rc.result_id = r.id
    WHERE r.id = ${resultId}
    LIMIT 1
  `)) as unknown as ReviewableResultContext[];
  return rows[0] ?? null;
}

async function refreshReviewResultCache(
  ctx: ReviewableResultContext,
): Promise<void> {
  if (!ctx.revisionId) return;
  await refreshPolarCacheForRevision(db, ctx.airfoilId, ctx.revisionId);
}

async function isReviewableResult(
  ctx: ReviewableResultContext,
): Promise<boolean> {
  const active = await activeReviewVerdict(db, ctx.id);
  if (active) return true;
  return (
    solverWorkStateForPoint({
      resultId: ctx.id,
      status: ctx.status,
      source: ctx.source,
      regime: ctx.regime,
      fidelity: ctx.fidelity,
      classificationState: ctx.classificationState,
      continuable: ctx.continuable,
      openVerify: ctx.openVerify,
      openRequest: ctx.openRequest,
      autoRetriedAt: ctx.autoRetriedAt,
      error: ctx.error,
    }) === "needs_review"
  );
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
    .digest("hex")
    .slice(0, 24);
}

function artifactDTO(row: typeof solverEvidenceArtifacts.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    field: row.field,
    role: row.role,
    url: mediaStore.url(row.storageKey),
    downloadUrl: mediaStore.url(row.storageKey),
    mimeType: row.mimeType,
    sha256: row.sha256,
    byteSize: row.byteSize,
    metadata: row.metadata ?? {},
  };
}

async function remoteRefForStorageKey(storageKey: string) {
  const [row] = await db
    .select()
    .from(remoteAssetReferences)
    .where(eq(remoteAssetReferences.localStorageKey, storageKey))
    .limit(1);
  return row ?? null;
}

async function syncSettingsForRemoteProxy() {
  const [settings] = await db
    .select()
    .from(syncApiSettings)
    .where(eq(syncApiSettings.id, 1))
    .limit(1);
  return settings ?? null;
}

function resolveRemoteUrl(
  raw: string,
  upstreamBaseUrl?: string | null,
): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (!upstreamBaseUrl)
    throw new Error(
      "remote asset has relative URL but no upstream base URL is configured",
    );
  return `${upstreamBaseUrl.replace(/\/+$/, "")}/${raw.replace(/^\/+/, "")}`;
}

async function proxyRemoteAsset(storageKey: string) {
  const ref = await remoteRefForStorageKey(storageKey);
  if (!ref) return null;
  if (ref.availability === "cached" && ref.cachedStorageKey) {
    return mediaStore.stream(ref.cachedStorageKey);
  }
  const settings = await syncSettingsForRemoteProxy();
  const url = resolveRemoteUrl(
    ref.remoteDownloadUrl,
    settings?.upstreamBaseUrl,
  );
  const res = await fetch(url, {
    headers: settings?.upstreamSecret
      ? { "x-xfoilfoam-sync-secret": settings.upstreamSecret }
      : undefined,
  });
  if (!res.ok || !res.body)
    throw new Error(`remote asset fetch failed (${res.status})`);
  return {
    stream: Readable.fromWeb(res.body),
    size: Number(res.headers.get("content-length") ?? ref.byteSize ?? 0),
    mime: res.headers.get("content-type") ?? ref.mimeType,
  };
}

async function delegateRemoteRender(resultId: string, params: unknown) {
  const [ref] = await db
    .select()
    .from(remoteAssetReferences)
    .where(
      and(
        eq(remoteAssetReferences.resultId, resultId),
        sql`${remoteAssetReferences.remoteResultId} IS NOT NULL`,
      ),
    )
    .limit(1);
  if (!ref?.remoteResultId) return null;
  const settings = await syncSettingsForRemoteProxy();
  const renderUrl = ref.remoteRenderUrl
    ? resolveRemoteUrl(ref.remoteRenderUrl, settings?.upstreamBaseUrl)
    : resolveRemoteUrl(
        `/api/sync/v1/results/${encodeURIComponent(ref.remoteResultId)}/render`,
        settings?.upstreamBaseUrl,
      );
  const res = await fetch(renderUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(settings?.upstreamSecret
        ? { "x-xfoilfoam-sync-secret": settings.upstreamSecret }
        : {}),
    },
    body: JSON.stringify(params ?? {}),
  });
  const payload = (await res.json().catch(() => null)) as null | {
    id?: string;
    url?: string;
    mimeType?: string;
    field?: string;
    role?: string;
    cached?: boolean;
  };
  if (!res.ok || !payload?.url)
    throw new Error(
      payload && "error" in payload
        ? String((payload as { error?: unknown }).error)
        : `remote render failed (${res.status})`,
    );
  const remoteDownloadUrl = resolveRemoteUrl(
    payload.url,
    settings?.upstreamBaseUrl,
  );
  const key = `remote/${encodeURIComponent(ref.sourceInstanceId ?? "upstream")}/renders/${createHash("sha256").update(`${resultId}:${remoteDownloadUrl}`).digest("hex")}`;
  await db
    .insert(remoteAssetReferences)
    .values({
      localKind: "field_render_cache",
      localStorageKey: key,
      resultId,
      sourceInstanceId: ref.sourceInstanceId,
      sourceInstanceName: ref.sourceInstanceName,
      remoteResultId: ref.remoteResultId,
      remoteCacheId: payload.id ?? null,
      remoteDownloadUrl,
      remoteRenderUrl: renderUrl,
      mimeType: payload.mimeType ?? "image/png",
      availability: "remote_only",
      metadata: { field: payload.field ?? null, role: payload.role ?? null },
    })
    .onConflictDoUpdate({
      target: remoteAssetReferences.localStorageKey,
      set: {
        remoteDownloadUrl,
        remoteRenderUrl: renderUrl,
        updatedAt: new Date(),
      },
    });
  return {
    id: payload.id ?? key,
    cached: Boolean(payload.cached),
    field: payload.field,
    role: payload.role,
    url: mediaStore.url(key),
    mimeType: payload.mimeType ?? "image/png",
  };
}

function nearestRe(re: number): number {
  return RELIST.reduce(
    (best, x) => (Math.abs(x - re) < Math.abs(best - re) ? x : best),
    RELIST[0],
  );
}

function bcDTOFromSetup(row: {
  preset: typeof simulationPresets.$inferSelect;
  flowState: typeof flowConditions.$inferSelect;
  referenceGeometry: typeof referenceGeometryProfiles.$inferSelect;
  revisionReynolds: number | null;
  mediumSlug: string;
  mediumName: string;
  boundary: typeof boundaryProfiles.$inferSelect;
  mesh: typeof meshProfiles.$inferSelect;
  solver: typeof solverProfiles.$inferSelect;
  scheduling: typeof schedulingProfiles.$inferSelect;
  output: typeof outputProfiles.$inferSelect;
  sweep: typeof sweepDefinitions.$inferSelect;
}) {
  return {
    id: row.preset.id,
    slug: row.preset.slug,
    name: row.preset.name,
    mediumId: row.flowState.mediumId,
    mediumSlug: row.mediumSlug,
    mediumName: row.mediumName,
    temperatureK: row.flowState.temperatureK,
    pressurePa: row.flowState.pressurePa,
    speedMps: row.flowState.speedMps,
    reynolds:
      row.revisionReynolds ??
      Math.round(
        (row.flowState.speedMps * row.referenceGeometry.referenceLengthM) /
          row.flowState.kinematicViscosity,
      ),
    referenceChordM: row.referenceGeometry.referenceLengthM,
    density: row.flowState.density,
    dynamicViscosity: row.flowState.dynamicViscosity,
    kinematicViscosity: row.flowState.kinematicViscosity,
    turbulenceModel: row.solver.turbulenceModel,
    turbulenceIntensity: row.boundary.turbulenceIntensity,
    viscosityRatio: row.boundary.viscosityRatio,
    mach: row.flowState.mach,
    aoaStart: row.sweep.aoaStart,
    aoaStop: row.sweep.aoaStop,
    aoaStep: row.sweep.aoaStep,
    aoaList: row.sweep.aoaList,
    schedulingPolicy: row.scheduling.schedulingPolicy,
    cpuBudget: row.scheduling.cpuBudget,
    caseConcurrency: row.scheduling.caseConcurrency,
    solverProcesses: row.scheduling.solverProcesses,
    enabled: row.preset.enabled,
  };
}

const viscosityTablePointBody = z.object({
  temperatureK: z.coerce.number().positive(),
  dynamicViscosity: z.coerce.number().positive(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

const mediumBodyBase = z
  .object({
    slug: z.string().trim().min(1),
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

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ ok: true, service: "aerodb-api" }));

  // ---- categories ----
  app.get("/api/categories/tree", async () => categoriesTree());

  app.get("/api/categories", async () => {
    const rows = await db
      .select({
        id: categories.id,
        slug: categories.slug,
        name: categories.name,
        path: categories.path,
        depth: categories.depth,
      })
      .from(categories)
      .orderBy(asc(categories.path));
    return { items: rows };
  });

  app.get("/api/hashtags", async () => ({ items: await listHashtags() }));

  // ---- airfoils ----
  app.get("/api/airfoils", async (req) => {
    const numeric = z.coerce.number().finite().optional();
    const q = z
      .object({
        category: z.string().optional(),
        includeSubcategories: z
          .enum(["true", "false"])
          .optional()
          .transform((v) => (v == null ? undefined : v === "true")),
        q: z.string().optional(),
        sort: z.string().optional(),
        dir: z.enum(["asc", "desc"]).optional(),
        includePoints: z
          .enum(["true", "false"])
          .optional()
          .transform((v) => (v == null ? undefined : v === "true")),
        limit: z.coerce.number().int().positive().max(10000).optional(),
        offset: z.coerce.number().int().min(0).optional(),
        hashtags: z
          .string()
          .optional()
          .transform(
            (v) =>
              v
                ?.split(",")
                .map((x) => x.trim())
                .filter(Boolean) ?? undefined,
          ),
        thicknessMin: numeric,
        thicknessMax: numeric,
        areaMin: numeric,
        areaMax: numeric,
        upperAreaMin: numeric,
        upperAreaMax: numeric,
        upperPositiveMin: numeric,
        upperPositiveMax: numeric,
        upperNegativeMin: numeric,
        upperNegativeMax: numeric,
        lowerAreaMin: numeric,
        lowerAreaMax: numeric,
        lowerPositiveMin: numeric,
        lowerPositiveMax: numeric,
        lowerNegativeMin: numeric,
        lowerNegativeMax: numeric,
        camberAreaMin: numeric,
        camberAreaMax: numeric,
        camberPositiveMin: numeric,
        camberPositiveMax: numeric,
        camberNegativeMin: numeric,
        camberNegativeMax: numeric,
      })
      .parse(req.query);
    return { items: await listAirfoils(q) };
  });

  // create one airfoil (NACA params or pasted coordinates)
  app.post("/api/airfoils", async (req, reply) => {
    const b = z
      .object({
        name: z.string().optional(),
        categorySlug: z.string().optional(),
        naca: nacaSchema.optional(),
        coordinates: z.string().optional(),
      })
      .parse(req.body);
    try {
      return reply.code(201).send(await createAirfoil(b));
    } catch (e) {
      return reply.code(422).send({ error: (e as Error).message });
    }
  });

  // create many airfoils from coordinate blobs (bulk import)
  app.post("/api/airfoils/bulk", async (req, reply) => {
    const b = z
      .object({
        categorySlug: z.string().optional(),
        items: z
          .array(
            z.object({ name: z.string().optional(), coordinates: z.string() }),
          )
          .min(1)
          .max(200),
      })
      .parse(req.body);
    return reply
      .code(201)
      .send(await createAirfoilsBulk(b.items, b.categorySlug));
  });

  app.get("/api/airfoils/:slug", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    // revisionId: minimal pinned-revision scope for the campaign cell side
    // panel (spec §11 surgical exception) — omits nothing, invents nothing.
    const { revisionId } = z
      .object({ revisionId: z.string().uuid().optional() })
      .parse(req.query);
    const detail = await assembleDetail(slug, { revisionId });
    if (!detail) return reply.code(404).send({ error: "airfoil not found" });
    return detail;
  });

  app.get("/api/airfoils/:slug/coords.dat", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { format } = z
      .object({
        format: z.enum(["selig", "lednicer", "xfoil", "csv"]).default("selig"),
      })
      .parse(req.query);
    const [a] = await db
      .select()
      .from(airfoils)
      .where(
        and(
          eq(airfoils.slug, slug),
          isNull(airfoils.archivedAt),
          isNull(airfoils.deletedAt),
        ),
      )
      .limit(1);
    if (!a) return reply.code(404).send({ error: "airfoil not found" });
    const text = exportCoordinates(format, a.name, a.points as Point[]);
    reply
      .header("content-type", format === "csv" ? "text/csv" : "text/plain")
      .header(
        "content-disposition",
        `attachment; filename="${a.slug}.${format === "csv" ? "csv" : "dat"}"`,
      );
    return text;
  });

  app.get("/api/airfoils/:slug/sim", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { re, aoa, resultId } = z
      .object({
        re: z.coerce.number().optional(),
        aoa: z.coerce.number().optional(),
        resultId: z.string().uuid().optional(),
      })
      .refine(
        (query) =>
          query.resultId || (query.re !== undefined && query.aoa !== undefined),
        {
          message: "resultId or re+aoa is required",
        },
      )
      .parse(req.query);
    const sim = await assembleSim(slug, re, aoa, resultId);
    if (!sim)
      return reply
        .code(404)
        .send({ error: "no solved OpenFOAM result for this point" });
    return sim;
  });

  app.get("/api/airfoils/:slug/solver-work", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { revision } = z
      .object({ revision: z.string().uuid().optional() })
      .parse(req.query);
    const payload = await assembleSolverWork(slug, { revisionId: revision });
    if (!payload) return reply.code(404).send({ error: "airfoil not found" });
    return payload;
  });

  app.post(
    "/api/admin/results/:id/review",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const body = reviewVerdictBody.parse(req.body);
      const note = body.note?.trim() ?? "";
      if ((body.verdict === "waive" || body.verdict === "exclude") && !note) {
        return reply
          .code(422)
          .send({ error: "note is required for waive/exclude reviews" });
      }
      const ctx = await loadReviewableResultContext(id);
      if (!ctx) return reply.code(404).send({ error: "result not found" });
      if (!(await isReviewableResult(ctx))) {
        return reply
          .code(409)
          .send({ error: "result is not in a reviewable solver-work state" });
      }
      const reviewer = sessionEmail(req) ?? "dev-admin@local";
      const review = await recordReviewVerdict(db, {
        resultId: id,
        verdict: body.verdict,
        note,
        reviewer,
      });
      await refreshReviewResultCache(ctx);
      return reply.code(201).send({ review: reviewDTO(review) });
    },
  );

  app.delete(
    "/api/admin/results/:id/review",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const ctx = await loadReviewableResultContext(id);
      if (!ctx) return reply.code(404).send({ error: "result not found" });
      const reviewer = sessionEmail(req) ?? "dev-admin@local";
      await revokeActiveReviewVerdict(db, id, reviewer);
      await refreshReviewResultCache(ctx);
      return reply.code(204).send();
    },
  );

  app.get(
    "/api/admin/results/:id/reviews",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const ctx = await loadReviewableResultContext(id);
      if (!ctx) return reply.code(404).send({ error: "result not found" });
      const history = await reviewVerdictHistory(db, id);
      return { items: history.map(reviewDTO) };
    },
  );

  app.get("/api/airfoils/:slug/field-track", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { revisionId } = z
      .object({ revisionId: z.string().uuid().optional() })
      .parse(req.query);
    const [a] = await db
      .select()
      .from(airfoils)
      .where(
        and(
          eq(airfoils.slug, slug),
          isNull(airfoils.archivedAt),
          isNull(airfoils.deletedAt),
        ),
      )
      .limit(1);
    if (!a) return reply.code(404).send({ error: "airfoil not found" });
    const rows = await db
      .select()
      .from(results)
      .where(
        and(
          eq(results.airfoilId, a.id),
          eq(results.source, "solved"),
          eq(results.status, "done"),
          revisionId
            ? eq(results.simulationPresetRevisionId, revisionId)
            : sql`true`,
        ),
      )
      .orderBy(asc(results.aoaDeg));
    const resultIds = rows.map((row) => row.id);
    const mediaRows = resultIds.length
      ? await db
          .select()
          .from(resultMedia)
          .where(inArray(resultMedia.resultId, resultIds))
      : [];
    const fieldsByResult = new Map<string, Set<string>>();
    for (const media of mediaRows) {
      if (!media.field) continue;
      const set = fieldsByResult.get(media.resultId) ?? new Set<string>();
      set.add(media.field);
      fieldsByResult.set(media.resultId, set);
    }
    return {
      items: rows.map((row) => ({
        resultId: row.id,
        aoa: row.aoaDeg,
        re: row.reynolds ?? 0,
        mach: row.mach,
        regime: row.regime,
        fields: Array.from(fieldsByResult.get(row.id) ?? []),
      })),
    };
  });

  app.get("/api/results/:resultId/media", async (req, reply) => {
    const { resultId } = req.params as { resultId: string };
    const [result] = await db
      .select({ id: results.id })
      .from(results)
      .where(eq(results.id, resultId))
      .limit(1);
    if (!result) return reply.code(404).send({ error: "result not found" });
    const rows = await db
      .select()
      .from(resultMedia)
      .where(eq(resultMedia.resultId, resultId));
    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        field: row.field,
        role: row.role,
        url: mediaStore.url(row.storageKey),
        mimeType: row.mimeType,
        width: row.width,
        height: row.height,
        frameCount: row.frameCount,
        durationS: row.durationS,
        colorScaleId: row.colorScaleId,
        colorScaleVersion: row.colorScaleVersion,
        scaleVmin: row.scaleVmin,
        scaleVmax: row.scaleVmax,
        scalePolicy: row.scalePolicy,
        renderProfileKey: row.renderProfileKey,
      })),
    };
  });

  app.get("/api/results/:resultId/evidence", async (req, reply) => {
    const { resultId } = req.params as { resultId: string };
    const [result] = await db
      .select({ id: results.id })
      .from(results)
      .where(eq(results.id, resultId))
      .limit(1);
    if (!result) return reply.code(404).send({ error: "result not found" });
    const [artifacts, media, renders] = await Promise.all([
      db
        .select()
        .from(solverEvidenceArtifacts)
        .where(eq(solverEvidenceArtifacts.resultId, resultId)),
      db.select().from(resultMedia).where(eq(resultMedia.resultId, resultId)),
      db
        .select()
        .from(fieldRenderCache)
        .where(eq(fieldRenderCache.resultId, resultId)),
    ]);
    return {
      artifacts: artifacts.map(artifactDTO),
      media: media.map((row) => ({
        ...row,
        url: mediaStore.url(row.storageKey),
      })),
      customRenders: renders.map((row) => ({
        ...row,
        url: mediaStore.url(row.storageKey),
      })),
    };
  });

  app.post("/api/results/:resultId/render", async (req, reply) => {
    const { resultId } = req.params as { resultId: string };
    const body = z
      .object({
        field: imageFieldSchema,
        role: z.enum(["instantaneous", "mean"]).default("instantaneous"),
        scaleMode: z.enum(["track", "auto", "manual"]).default("track"),
        zoomChords: z.coerce.number().positive().default(2),
        colormap: z.string().trim().min(1).nullable().optional(),
        levels: z.coerce.number().int().min(3).max(200).default(40),
        vmin: z.coerce.number().nullable().optional(),
        vmax: z.coerce.number().nullable().optional(),
        frameIndex: z.coerce.number().int().min(0).nullable().optional(),
        widthPx: z.coerce.number().int().min(320).max(2400).default(990),
        heightPx: z.coerce.number().int().min(240).max(1800).default(660),
      })
      .parse(req.body);
    const [row] = await db
      .select({ result: results, airfoil: airfoils })
      .from(results)
      .innerJoin(airfoils, eq(airfoils.id, results.airfoilId))
      .where(eq(results.id, resultId))
      .limit(1);
    if (!row) return reply.code(404).send({ error: "result not found" });
    const result = row.result;
    if (!result.engineJobId || !result.engineCaseSlug) {
      const delegated = await delegateRemoteRender(resultId, body);
      if (delegated) return delegated;
      return reply
        .code(409)
        .send({ error: "result has no engine case evidence path" });
    }
    if (result.engineJobId.startsWith("sync:")) {
      const delegated = await delegateRemoteRender(resultId, body);
      if (delegated) return delegated;
    }
    const [manifest] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.resultId, resultId),
          eq(solverEvidenceArtifacts.kind, "manifest"),
        ),
      )
      .orderBy(desc(solverEvidenceArtifacts.createdAt))
      .limit(1);
    if (!manifest)
      return reply
        .code(409)
        .send({ error: "result has no raw evidence manifest" });
    const manifestMetadata =
      manifest.metadata && typeof manifest.metadata === "object"
        ? (manifest.metadata as Record<string, unknown>)
        : {};
    const evidenceBase =
      typeof manifestMetadata.evidenceBase === "string"
        ? manifestMetadata.evidenceBase
        : "evidence";
    let resolvedVmin = body.vmin ?? null;
    let resolvedVmax = body.vmax ?? null;
    if (body.scaleMode === "track") {
      const [mediaScale] = await db
        .select({ media: resultMedia, scale: fieldColorScales })
        .from(resultMedia)
        .leftJoin(
          fieldColorScales,
          eq(resultMedia.colorScaleId, fieldColorScales.id),
        )
        .where(
          and(
            eq(resultMedia.resultId, resultId),
            eq(resultMedia.field, body.field),
            eq(resultMedia.renderProfileKey, "default:v1:zoom2"),
          ),
        )
        .limit(1);
      resolvedVmin =
        mediaScale?.media.scaleVmin ?? mediaScale?.scale?.vmin ?? null;
      resolvedVmax =
        mediaScale?.media.scaleVmax ?? mediaScale?.scale?.vmax ?? null;
      if (resolvedVmin == null || resolvedVmax == null) {
        return reply.code(409).send({
          error: "track color scale is not available for this result field",
        });
      }
    } else if (body.scaleMode === "auto") {
      resolvedVmin = null;
      resolvedVmax = null;
    }
    const params = {
      field: body.field,
      role: body.role,
      scaleMode: body.scaleMode,
      zoomChords: body.zoomChords,
      colormap: body.colormap ?? null,
      levels: body.levels,
      vmin: resolvedVmin,
      vmax: resolvedVmax,
      frameIndex: body.frameIndex ?? null,
      widthPx: body.widthPx,
      heightPx: body.heightPx,
      evidenceSha256: manifest.sha256,
    };
    const paramsHash = stableHash(params);
    const [cached] = await db
      .select()
      .from(fieldRenderCache)
      .where(
        and(
          eq(fieldRenderCache.resultId, resultId),
          eq(fieldRenderCache.field, body.field),
          eq(fieldRenderCache.role, body.role),
          eq(fieldRenderCache.paramsHash, paramsHash),
        ),
      )
      .limit(1);
    if (cached) {
      return {
        id: cached.id,
        cached: true,
        field: cached.field,
        role: cached.role,
        url: mediaStore.url(cached.storageKey),
        mimeType: cached.mimeType,
        sha256: cached.sha256,
        byteSize: cached.byteSize,
        paramsHash: cached.paramsHash,
      };
    }
    const points = (row.airfoil.points as Point[]).map(
      (p) => [p.x, p.y] as [number, number],
    );
    const rendered = await new EngineClient(env.engineUrl).renderField(
      result.engineJobId,
      {
        case_slug: result.engineCaseSlug,
        evidence_base: evidenceBase,
        airfoil_points: points,
        chord: result.chord ?? 1,
        speed: result.speed ?? 0,
        field: body.field as ImageFieldName,
        role: body.role,
        zoom_chords: body.zoomChords,
        colormap: body.colormap ?? null,
        levels: body.levels,
        vmin: resolvedVmin,
        vmax: resolvedVmax,
        frame_index: body.frameIndex ?? null,
        width_px: body.widthPx,
        height_px: body.heightPx,
        params_hash: paramsHash,
      },
    );
    const storageKey = `jobs/${result.engineJobId}/cases/${result.engineCaseSlug}/${rendered.path}`;
    const [saved] = await db
      .insert(fieldRenderCache)
      .values({
        resultId,
        field: rendered.field,
        role: rendered.role,
        paramsHash,
        params,
        kind: rendered.kind,
        storageKey,
        mimeType: rendered.mime_type,
        sha256: rendered.sha256,
        byteSize: rendered.byte_size,
        width: body.widthPx,
        height: body.heightPx,
        engineUrl: `${env.engineUrl}${rendered.url}`,
      })
      .onConflictDoUpdate({
        target: [
          fieldRenderCache.resultId,
          fieldRenderCache.field,
          fieldRenderCache.role,
          fieldRenderCache.paramsHash,
        ],
        set: {
          storageKey,
          mimeType: rendered.mime_type,
          sha256: rendered.sha256,
          byteSize: rendered.byte_size,
          width: body.widthPx,
          height: body.heightPx,
          engineUrl: `${env.engineUrl}${rendered.url}`,
        },
      })
      .returning();
    return {
      id: saved.id,
      cached: false,
      field: saved.field,
      role: saved.role,
      url: mediaStore.url(saved.storageKey),
      mimeType: saved.mimeType,
      sha256: saved.sha256,
      byteSize: saved.byteSize,
      paramsHash: saved.paramsHash,
    };
  });

  // Enqueue a CFD simulation for a point (the sweeper picks it up). Works even
  // before the sweeper runs; it records queue intent, not solver output.
  app.post("/api/airfoils/:slug/simulate", async (req, reply) => {
    const { slug } = req.params as { slug: string };
    const { re, aoa } = z
      .object({ re: z.coerce.number(), aoa: z.coerce.number() })
      .parse(req.body);
    const [a] = await db
      .select()
      .from(airfoils)
      .where(
        and(
          eq(airfoils.slug, slug),
          isNull(airfoils.archivedAt),
          isNull(airfoils.deletedAt),
        ),
      )
      .limit(1);
    if (!a) return reply.code(404).send({ error: "airfoil not found" });
    const snapped = nearestRe(re);
    const [air] = await db
      .select({ id: mediums.id })
      .from(mediums)
      .where(eq(mediums.slug, "air"))
      .limit(1);
    if (!air) return reply.code(400).send({ error: "no air medium" });
    const [preset] = await db
      .select({ id: simulationPresets.id })
      .from(simulationPresets)
      .innerJoin(
        flowConditions,
        eq(flowConditions.id, simulationPresets.flowConditionId),
      )
      .innerJoin(
        simulationPresetRevisions,
        eq(simulationPresetRevisions.presetId, simulationPresets.id),
      )
      .where(
        and(
          eq(flowConditions.mediumId, air.id),
          eq(simulationPresetRevisions.reynolds, snapped),
          eq(simulationPresets.enabled, true),
          or(
            eq(simulationPresets.targetScope, "all"),
            sql`EXISTS (
            SELECT 1
            FROM simulation_preset_airfoil_targets target
            WHERE target.preset_id = ${simulationPresets.id} AND target.airfoil_id = ${a.id}
          )`,
          ),
        ),
      )
      .orderBy(desc(simulationPresets.updatedAt))
      .limit(1);
    if (!preset)
      return reply
        .code(400)
        .send({ error: `no simulation preset at Re ${snapped}` });
    const setup = await ensureSimulationPresetRevision(db, preset.id);
    const bcId = setup?.snapshot.preset.legacyBoundaryConditionId;
    if (!setup || !bcId)
      return reply.code(400).send({
        error: `simulation preset at Re ${snapped} has no compatibility boundary row`,
      });
    const aoaDeg = Math.round(aoa);
    const [row] = await db
      .insert(results)
      .values({
        airfoilId: a.id,
        bcId,
        simulationPresetRevisionId: setup.revision.id,
        aoaDeg,
        status: "pending",
        source: "queued",
        priority: 10,
      })
      .onConflictDoUpdate({
        target: [
          results.airfoilId,
          results.simulationPresetRevisionId,
          results.aoaDeg,
        ],
        set: { status: "pending", priority: 10 },
      })
      .returning({ id: results.id, status: results.status });
    return reply
      .code(202)
      .send({ resultId: row.id, status: row.status, re: snapped, aoa: aoaDeg });
  });

  // ---- mediums ----
  app.get("/api/mediums", async () => {
    const rows = await db.select().from(mediums).orderBy(asc(mediums.name));
    const points = await tablePointsForMediums(rows.map((row) => row.id));
    return {
      items: rows.map((row) => toMediumDTO(row, points.get(row.id) ?? [])),
    };
  });

  app.post("/api/mediums", { preHandler: requireAdmin }, async (req, reply) => {
    const b = mediumBody.parse(req.body);
    const { dynamicViscosity, kinematicViscosity } = resolveViscosity(
      b,
      b.density,
      b.refTemperatureK,
    );
    const [row] = await db
      .insert(mediums)
      .values({
        slug: b.slug,
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
  });

  app.patch(
    "/api/mediums/:id",
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
          slug: b.slug,
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
      return toMediumDTO(row, viscosityInput.viscosityTable ?? []);
    },
  );

  app.delete(
    "/api/mediums/:id",
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [refs] = await db
        .select({ n: count() })
        .from(flowConditions)
        .where(eq(flowConditions.mediumId, id));
      if ((refs?.n ?? 0) > 0)
        return reply
          .code(409)
          .send({ error: "medium is referenced by flow states" });
      await db.delete(mediums).where(eq(mediums.id, id));
      return reply.code(204).send();
    },
  );

  // ---- boundary conditions ----
  app.get("/api/boundary-conditions", async () => {
    const rows = await db
      .select({
        preset: simulationPresets,
        flowState: flowConditions,
        referenceGeometry: referenceGeometryProfiles,
        revisionReynolds: simulationPresetRevisions.reynolds,
        mediumSlug: mediums.slug,
        mediumName: mediums.name,
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
      .innerJoin(
        referenceGeometryProfiles,
        eq(
          referenceGeometryProfiles.id,
          simulationPresets.referenceGeometryProfileId,
        ),
      )
      .innerJoin(mediums, eq(mediums.id, flowConditions.mediumId))
      .innerJoin(
        simulationPresetRevisions,
        eq(simulationPresetRevisions.presetId, simulationPresets.id),
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
      .orderBy(
        asc(simulationPresetRevisions.reynolds),
        asc(simulationPresets.name),
        desc(simulationPresetRevisions.revisionNumber),
      );
    const seen = new Set<string>();
    return {
      items: rows
        .filter((row) => {
          if (seen.has(row.preset.id)) return false;
          seen.add(row.preset.id);
          return true;
        })
        .map(bcDTOFromSetup),
    };
  });

  // ---- media (served from the shared CFD data volume) ----
  app.get("/api/media/*", async (req, reply) => {
    const key = (req.params as Record<string, string>)["*"];
    try {
      const { stream, mime, size } = await mediaStore.stream(key);
      reply
        .header("content-type", mime)
        .header("content-length", size)
        .header("cache-control", "public, max-age=31536000, immutable");
      return reply.send(stream);
    } catch {
      try {
        const proxied = await proxyRemoteAsset(key);
        if (!proxied) return reply.code(404).send({ error: "media not found" });
        reply
          .header("content-type", proxied.mime)
          .header("content-length", proxied.size)
          .header("cache-control", "private, max-age=60");
        return reply.send(proxied.stream);
      } catch (err) {
        return reply.code(502).send({
          error: "remote media fetch failed: " + (err as Error).message,
        });
      }
    }
  });

  // ---- sweeper control / observability ----
  app.get("/api/sweeper", async () => {
    const s = await readSweeperState();
    return s ?? { id: 1, enabled: false };
  });

  // Admin-only (spec §10 auth hardening): sweeper writes control the solver
  // fleet. GET /api/sweeper stays a public status read (no campaign data).
  app.patch("/api/sweeper", { preHandler: requireAdmin }, async (req) => {
    const b = z
      .object({
        enabled: z.boolean().optional(),
        maxConcurrentJobs: z.number().int().positive().optional(),
        cpuSlots: z.number().int().min(0).max(512).optional(),
        pollIntervalMs: z.number().int().positive().optional(),
        submitIntervalMs: z.number().int().positive().optional(),
      })
      .parse(req.body);
    return writeSweeperState(b);
  });

  // Admin-only (spec §10): sim_jobs rows now carry campaignId and must not
  // leak campaign metadata through a public route. No public caller exists
  // (verified: apps/web, e2e, scripts, README all unaffected).
  app.get("/api/sim-jobs", { preHandler: requireAdmin }, async () => ({
    items: await db
      .select()
      .from(simJobs)
      .orderBy(desc(simJobs.createdAt))
      .limit(100),
  }));
}
