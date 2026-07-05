import {
  airfoils,
  type CampaignLaneKey,
  fieldColorScales,
  forceHistory,
  laneKeyId,
  onResultIngested,
  type DB,
  type ResultInsert,
  resultAttempts,
  resultFieldExtents,
  results,
  resultMedia,
  solverEvidenceArtifacts,
} from "@aerodb/db";
import { canonicalSi } from "@aerodb/core";
import {
  ALL_IMAGE_FIELDS,
  type EngineClient,
  type EngineEvidenceArtifact,
  type ImageFieldName,
  type JobResult,
  type PolarPoint,
  type RenderedDefaultMedia,
} from "@aerodb/engine-client";
import { and, desc, eq, inArray } from "drizzle-orm";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_RENDER_PROFILE_KEY = "default:v1:zoom2";

interface VideoMetadata {
  durationS?: number;
  width?: number;
  height?: number;
  frameCount?: number;
}

export interface SpeedBc {
  speed: number;
  bcId: string;
  presetRevisionId?: string | null;
  mach?: number | null;
}

/** One (condition, speed) member of a batched campaign job's requestPayload
 *  conditionMap. Speeds are canonical SI values (canonicalSi('speedMps', …))
 *  stamped at compose time, so ingest maps each engine polar back to its
 *  condition by exact canonical equality — never by nearest-speed guessing. */
export interface ConditionMapEntry {
  conditionId: string;
  revisionId: string;
  presetId: string;
  speed: number;
  reynolds: number;
  bcId: string;
}

/** Pure speed→condition mapping for batched jobs: canonical float equality.
 *  Returns null when no entry matches (a mismatched polar must be skipped, not
 *  misattributed to the nearest revision). */
export function matchConditionEntryBySpeed(entries: ConditionMapEntry[], polarSpeed: number): ConditionMapEntry | null {
  const canonical = canonicalSi("speedMps", polarSpeed);
  return entries.find((entry) => entry.speed === canonical) ?? null;
}

/** Engine image URL ("/jobs/<id>/files/cases/x/v.png") → media store key
 *  ("jobs/<id>/cases/x/v.png", relative to DATA_DIR). */
function storageKeyOf(urlPath: string): string {
  const m = urlPath.match(/^\/?jobs\/([^/]+)\/files\/(.+)$/);
  return m ? `jobs/${m[1]}/${m[2]}` : urlPath.replace(/^\/+/, "");
}

function finitePositiveNumber(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function mediaRoots(): string[] {
  return Array.from(
    new Set(
      [process.env.MEDIA_DIR, process.env.DATA_DIR, "/data/airfoilfoam", "data/airfoilfoam"].filter(
        (x): x is string => Boolean(x),
      ),
    ),
  );
}

async function localMediaPath(storageKey: string): Promise<string | null> {
  for (const root of mediaRoots()) {
    const base = resolve(root);
    const full = resolve(base, storageKey);
    if (full !== base && !full.startsWith(base + sep)) continue;
    try {
      await access(full, constants.R_OK);
      return full;
    } catch {
      // Try the next configured/shared media root.
    }
  }
  return null;
}

async function probeVideoMetadata(storageKey: string): Promise<VideoMetadata> {
  const full = await localMediaPath(storageKey);
  if (!full) return {};
  try {
    const { stdout } = await execFileAsync(
      process.env.FFPROBE_BIN ?? "ffprobe",
      [
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-count_frames",
        "-show_entries",
        "stream=nb_read_frames,nb_frames,duration,width,height",
        "-of",
        "json",
        full,
      ],
      { timeout: 8000, maxBuffer: 1_000_000 },
    );
    const stream = JSON.parse(stdout)?.streams?.[0] ?? {};
    return {
      durationS: finitePositiveNumber(stream.duration),
      width: finitePositiveNumber(stream.width),
      height: finitePositiveNumber(stream.height),
      frameCount: finitePositiveNumber(stream.nb_read_frames) ?? finitePositiveNumber(stream.nb_frames),
    };
  } catch {
    return {};
  }
}

async function registerMedia(
  db: DB,
  engine: EngineClient,
  resultId: string,
  kind: "image" | "video",
  role: "instantaneous" | "mean",
  field: string,
  urlPath: string,
  mimeType: string,
  scale?: {
    colorScaleId: string;
    colorScaleVersion: number;
    vmin: number;
    vmax: number;
    policy: string;
    renderProfileKey: string;
  },
): Promise<void> {
  const storageKey = storageKeyOf(urlPath);
  const video = kind === "video" ? await probeVideoMetadata(storageKey) : {};
  await db
    .insert(resultMedia)
    .values({
      resultId,
      kind,
      field,
      role,
      storageKey,
      mimeType,
      width: video.width ? Math.round(video.width) : null,
      height: video.height ? Math.round(video.height) : null,
      frameCount: video.frameCount ? Math.round(video.frameCount) : null,
      durationS: video.durationS ?? null,
      colorScaleId: scale?.colorScaleId ?? null,
      colorScaleVersion: scale?.colorScaleVersion ?? null,
      scaleVmin: scale?.vmin ?? null,
      scaleVmax: scale?.vmax ?? null,
      scalePolicy: scale?.policy ?? null,
      renderProfileKey: scale?.renderProfileKey ?? DEFAULT_RENDER_PROFILE_KEY,
      engineUrl: `${engine.baseUrl}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`,
    })
    .onConflictDoUpdate({
      target: [resultMedia.resultId, resultMedia.kind, resultMedia.field, resultMedia.role],
      set: {
        storageKey,
        mimeType,
        width: video.width ? Math.round(video.width) : null,
        height: video.height ? Math.round(video.height) : null,
        frameCount: video.frameCount ? Math.round(video.frameCount) : null,
        durationS: video.durationS ?? null,
        colorScaleId: scale?.colorScaleId ?? null,
        colorScaleVersion: scale?.colorScaleVersion ?? null,
        scaleVmin: scale?.vmin ?? null,
        scaleVmax: scale?.vmax ?? null,
        scalePolicy: scale?.policy ?? null,
        renderProfileKey: scale?.renderProfileKey ?? DEFAULT_RENDER_PROFILE_KEY,
        engineUrl: `${engine.baseUrl}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`,
      },
    });
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function stalledForPoint(p: PolarPoint): boolean {
  return p.unsteady || p.converged === false;
}

function validForPolarPoint(p: PolarPoint): boolean {
  const hasCoefficients = finiteNumber(p.cl) && finiteNumber(p.cd) && p.cd > 0;
  if (p.unsteady) return !p.error && hasCoefficients;
  return p.converged === true && !stalledForPoint(p) && !p.error && hasCoefficients;
}

function failedForPoint(p: PolarPoint): boolean {
  return Boolean(p.error) || !finiteNumber(p.cl) || !finiteNumber(p.cd);
}

async function insertResultAttempt(opts: {
  db: DB;
  resultId?: string | null;
  airfoilId: string;
  bcId: string;
  presetRevisionId?: string | null;
  simJobId: string;
  engineJobId: string;
  point: PolarPoint;
}): Promise<string | null> {
  const { db, resultId, airfoilId, bcId, presetRevisionId, simJobId, engineJobId, point: p } = opts;
  const stalled = stalledForPoint(p);
  const [inserted] = await db
    .insert(resultAttempts)
    .values({
      resultId: resultId ?? null,
      airfoilId,
      bcId,
      simulationPresetRevisionId: presetRevisionId ?? null,
      aoaDeg: p.aoa_deg,
      status: failedForPoint(p) ? "failed" : "done",
      source: failedForPoint(p) ? "queued" : "solved",
      regime: p.unsteady ? "urans" : "rans",
      validForPolar: validForPolarPoint(p),
      simJobId,
      engineJobId,
      engineCaseSlug: p.case_slug ?? null,
      cl: p.cl ?? null,
      cd: p.cd ?? null,
      cm: p.cm ?? null,
      clCd: p.cl_cd ?? null,
      clStd: p.cl_std ?? null,
      cdStd: p.cd_std ?? null,
      cmStd: p.cm_std ?? null,
      stalled,
      unsteady: p.unsteady,
      converged: p.converged,
      finalResidual: p.final_residual ?? null,
      iterations: p.iterations ?? null,
      yPlusAvg: p.y_plus_avg ?? null,
      yPlusMax: p.y_plus_max ?? null,
      nCells: p.n_cells ?? null,
      firstOrderFallback: p.first_order_fallback,
      strouhal: p.strouhal ?? null,
      error: p.error ?? null,
      evidencePayload: p,
      solvedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [resultAttempts.simJobId, resultAttempts.engineJobId, resultAttempts.aoaDeg, resultAttempts.regime],
    })
    .returning({ id: resultAttempts.id });
  if (inserted?.id) return inserted.id;
  const [existing] = await db
    .select({ id: resultAttempts.id })
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.simJobId, simJobId),
        eq(resultAttempts.engineJobId, engineJobId),
        eq(resultAttempts.aoaDeg, p.aoa_deg),
        eq(resultAttempts.regime, p.unsteady ? "urans" : "rans"),
      ),
    )
    .limit(1);
  return existing?.id ?? null;
}

async function registerEvidenceArtifacts(opts: {
  db: DB;
  engine: EngineClient;
  resultId?: string | null;
  resultAttemptId?: string | null;
  airfoilId: string;
  simJobId: string;
  engineJobId: string;
  point: PolarPoint;
  artifact: EngineEvidenceArtifact;
}): Promise<void> {
  const { db, engine, resultId, resultAttemptId, airfoilId, simJobId, engineJobId, point, artifact } = opts;
  const urlPath = artifact.url ?? artifact.path;
  if (!urlPath) return;
  const storageKey = storageKeyOf(urlPath);
  const kind = artifact.kind as "manifest" | "openfoam_bundle" | "vtk_window" | "time_directory" | "log" | "force_coefficients" | "mesh" | "dictionary" | "field_data";
  await db
    .insert(solverEvidenceArtifacts)
    .values({
      resultId: resultId ?? null,
      resultAttemptId: resultAttemptId ?? null,
      airfoilId,
      simJobId,
      engineJobId,
      engineCaseSlug: point.case_slug ?? null,
      aoaDeg: point.aoa_deg,
      kind,
      field: artifact.field ?? null,
      role: artifact.role ?? null,
      storageKey,
      mimeType: artifact.mime_type,
      sha256: artifact.sha256,
      byteSize: artifact.byte_size,
      engineUrl: `${engine.baseUrl}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`,
      metadata: artifact.metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [solverEvidenceArtifacts.storageKey, solverEvidenceArtifacts.sha256],
      set: {
        resultId: resultId ?? null,
        resultAttemptId: resultAttemptId ?? null,
        engineCaseSlug: point.case_slug ?? null,
        metadata: artifact.metadata ?? {},
      },
    });
}

type ScaleGroupKey = `${string}:${string}:${ImageFieldName}`;

interface ScaleGroup {
  airfoilId: string;
  presetRevisionId: string;
  field: ImageFieldName;
  changedResultIds: Set<string>;
}

function isImageFieldName(value: string): value is ImageFieldName {
  return (ALL_IMAGE_FIELDS as string[]).includes(value);
}

function fieldScalePolicy(field: ImageFieldName): "sequential_zero" | "diverging_zero" {
  return field === "velocity_magnitude" || field === "turbulent_kinetic_energy" || field === "turbulent_viscosity"
    ? "sequential_zero"
    : "diverging_zero";
}

function normalizeScale(field: ImageFieldName, minValue: number, maxValue: number): { vmin: number; vmax: number; policy: string } {
  const policy = fieldScalePolicy(field);
  if (policy === "sequential_zero") {
    const vmax = Math.max(0, maxValue);
    return { vmin: 0, vmax: vmax > 0 ? vmax : 1e-12, policy };
  }
  const extent = Math.max(Math.abs(minValue), Math.abs(maxValue));
  const bound = extent > 0 ? extent : 1e-12;
  return { vmin: -bound, vmax: bound, policy };
}

function nearlyEqual(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= scale * 1e-9;
}

function stableHash(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, nested]) => [k, stable(nested)]));
    }
    return v;
  };
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex").slice(0, 24);
}

function scaleGroupKey(airfoilId: string, presetRevisionId: string, field: ImageFieldName): ScaleGroupKey {
  return `${airfoilId}:${presetRevisionId}:${field}`;
}

function evidenceBaseFromPoint(point: PolarPoint): string | null {
  const manifest = point.evidence_artifacts?.find((artifact) => artifact.kind === "manifest");
  const base = manifest?.metadata?.evidenceBase;
  return typeof base === "string" && base.trim() ? base : null;
}

function evidenceShaFromPoint(point: PolarPoint): string {
  const manifest = point.evidence_artifacts?.find((artifact) => artifact.kind === "manifest");
  return manifest?.sha256 ?? stableHash(point.evidence_artifacts ?? []);
}

async function airfoilContourPoints(db: DB, airfoilId: string): Promise<[number, number][] | null> {
  const [row] = await db.select({ points: airfoils.points }).from(airfoils).where(eq(airfoils.id, airfoilId)).limit(1);
  const points = row?.points as { x: number; y: number }[] | undefined;
  if (!points?.length) return null;
  return points.map((p) => [p.x, p.y]);
}

async function computeAndStoreFieldExtents(opts: {
  db: DB;
  engine: EngineClient;
  engineJobId: string;
  airfoilId: string;
  presetRevisionId: string | null;
  resultId: string;
  point: PolarPoint;
  speed: number;
  chord: number;
  airfoilPoints: [number, number][];
  groups: Map<ScaleGroupKey, ScaleGroup>;
}): Promise<void> {
  const { db, engine, engineJobId, airfoilId, presetRevisionId, resultId, point, speed, chord, airfoilPoints, groups } = opts;
  if (!presetRevisionId || !point.case_slug || failedForPoint(point)) return;
  const evidenceBase = evidenceBaseFromPoint(point);
  if (!evidenceBase) return;
  let response;
  try {
    response = await engine.computeFieldExtents(engineJobId, {
      case_slug: point.case_slug,
      evidence_base: evidenceBase,
      airfoil_points: airfoilPoints,
      chord,
      speed,
      fields: ALL_IMAGE_FIELDS,
      zoom_chords: 2,
      max_frames: 220,
    });
  } catch {
    return;
  }
  const evidenceSha256 = evidenceShaFromPoint(point);
  for (const [rawField, extent] of Object.entries(response.fields)) {
    if (!isImageFieldName(rawField) || !extent) continue;
    if (!Number.isFinite(extent.min) || !Number.isFinite(extent.max) || extent.finite_count <= 0) continue;
    await db
      .insert(resultFieldExtents)
      .values({
        resultId,
        airfoilId,
        simulationPresetRevisionId: presetRevisionId,
        field: rawField,
        renderProfileKey: DEFAULT_RENDER_PROFILE_KEY,
        vmin: extent.min,
        vmax: extent.max,
        finiteCount: extent.finite_count,
        sourceTimeStart: response.window_start ?? null,
        sourceTimeEnd: response.window_end ?? null,
        evidenceSha256,
      })
      .onConflictDoUpdate({
        target: [resultFieldExtents.resultId, resultFieldExtents.field, resultFieldExtents.renderProfileKey],
        set: {
          vmin: extent.min,
          vmax: extent.max,
          finiteCount: extent.finite_count,
          sourceTimeStart: response.window_start ?? null,
          sourceTimeEnd: response.window_end ?? null,
          evidenceSha256,
          updatedAt: new Date(),
        },
      });
    const key = scaleGroupKey(airfoilId, presetRevisionId, rawField);
    const group = groups.get(key) ?? { airfoilId, presetRevisionId, field: rawField, changedResultIds: new Set<string>() };
    group.changedResultIds.add(resultId);
    groups.set(key, group);
  }
}

async function manifestEvidenceBaseForResult(db: DB, resultId: string): Promise<string | null> {
  const [manifest] = await db
    .select()
    .from(solverEvidenceArtifacts)
    .where(and(eq(solverEvidenceArtifacts.resultId, resultId), eq(solverEvidenceArtifacts.kind, "manifest")))
    .orderBy(desc(solverEvidenceArtifacts.createdAt))
    .limit(1);
  const base = manifest?.metadata && typeof manifest.metadata === "object" ? (manifest.metadata as Record<string, unknown>).evidenceBase : null;
  return typeof base === "string" && base.trim() ? base : null;
}

async function renderScaledMediaRows(opts: {
  db: DB;
  engine: EngineClient;
  resultRows: (typeof results.$inferSelect)[];
  field: ImageFieldName;
  scale: { id: string; version: number; vmin: number; vmax: number; policy: string };
  airfoilPoints: [number, number][];
}): Promise<{ resultId: string; media: RenderedDefaultMedia[] }[]> {
  const rendered: { resultId: string; media: RenderedDefaultMedia[] }[] = [];
  for (const result of opts.resultRows) {
    if (!result.engineJobId || !result.engineCaseSlug || result.status !== "done" || result.source !== "solved") continue;
    const evidenceBase = await manifestEvidenceBaseForResult(opts.db, result.id);
    if (!evidenceBase) continue;
    const response = await opts.engine.renderDefaultMedia(result.engineJobId, {
      case_slug: result.engineCaseSlug,
      evidence_base: evidenceBase,
      airfoil_points: opts.airfoilPoints,
      chord: result.chord ?? 1,
      speed: result.speed ?? 0,
      fields: [opts.field],
      scales: { [opts.field]: { vmin: opts.scale.vmin, vmax: opts.scale.vmax } },
      unsteady: result.unsteady,
      zoom_chords: 2,
      scale_version: opts.scale.version,
      render_profile_key: DEFAULT_RENDER_PROFILE_KEY,
    });
    rendered.push({ resultId: result.id, media: [...response.images, ...response.mean_images, ...response.videos] });
  }
  return rendered;
}

async function registerRenderedMediaSet(
  db: DB,
  engine: EngineClient,
  rows: { resultId: string; media: RenderedDefaultMedia[] }[],
  scale: { id: string; version: number; vmin: number; vmax: number; policy: string },
): Promise<number> {
  let count = 0;
  for (const row of rows) {
    for (const media of row.media) {
      await registerMedia(db, engine, row.resultId, media.kind, media.role, media.field, media.url, media.mime_type, {
        colorScaleId: scale.id,
        colorScaleVersion: scale.version,
        vmin: scale.vmin,
        vmax: scale.vmax,
        policy: scale.policy,
        renderProfileKey: DEFAULT_RENDER_PROFILE_KEY,
      });
      count++;
    }
  }
  return count;
}

async function rebalanceFieldScales(opts: {
  db: DB;
  engine: EngineClient;
  groups: Map<ScaleGroupKey, ScaleGroup>;
  airfoilPoints: [number, number][];
}): Promise<number> {
  let mediaCount = 0;
  for (const group of opts.groups.values()) {
    const extents = await opts.db
      .select()
      .from(resultFieldExtents)
      .where(
        and(
          eq(resultFieldExtents.airfoilId, group.airfoilId),
          eq(resultFieldExtents.simulationPresetRevisionId, group.presetRevisionId),
          eq(resultFieldExtents.field, group.field),
          eq(resultFieldExtents.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
        ),
      );
    if (!extents.length) continue;
    const minValue = Math.min(...extents.map((row) => row.vmin));
    const maxValue = Math.max(...extents.map((row) => row.vmax));
    const normalized = normalizeScale(group.field, minValue, maxValue);
    const evidenceSignature = stableHash(
      extents
        .map((row) => ({
          resultId: row.resultId,
          field: row.field,
          min: row.vmin,
          max: row.vmax,
          evidenceSha256: row.evidenceSha256,
        }))
        .sort((a, b) => a.resultId.localeCompare(b.resultId)),
    );
    const [active] = await opts.db
      .select()
      .from(fieldColorScales)
      .where(
        and(
          eq(fieldColorScales.airfoilId, group.airfoilId),
          eq(fieldColorScales.simulationPresetRevisionId, group.presetRevisionId),
          eq(fieldColorScales.field, group.field),
          eq(fieldColorScales.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
          eq(fieldColorScales.active, true),
        ),
      )
      .limit(1);
    const [latest] = await opts.db
      .select()
      .from(fieldColorScales)
      .where(
        and(
          eq(fieldColorScales.airfoilId, group.airfoilId),
          eq(fieldColorScales.simulationPresetRevisionId, group.presetRevisionId),
          eq(fieldColorScales.field, group.field),
          eq(fieldColorScales.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
        ),
      )
      .orderBy(desc(fieldColorScales.version))
      .limit(1);

    if (active && nearlyEqual(active.vmin, normalized.vmin) && nearlyEqual(active.vmax, normalized.vmax)) {
      const targets = await opts.db
        .select()
        .from(results)
        .where(inArray(results.id, Array.from(group.changedResultIds)));
      const rendered = await renderScaledMediaRows({
        db: opts.db,
        engine: opts.engine,
        resultRows: targets,
        field: group.field,
        scale: { id: active.id, version: active.version, vmin: active.vmin, vmax: active.vmax, policy: active.scalePolicy },
        airfoilPoints: opts.airfoilPoints,
      });
      mediaCount += await registerRenderedMediaSet(opts.db, opts.engine, rendered, {
        id: active.id,
        version: active.version,
        vmin: active.vmin,
        vmax: active.vmax,
        policy: active.scalePolicy,
      });
      continue;
    }

    const nextVersion = (latest?.version ?? 0) + 1;
    const [scale] = await opts.db
      .insert(fieldColorScales)
      .values({
        airfoilId: group.airfoilId,
        simulationPresetRevisionId: group.presetRevisionId,
        field: group.field,
        renderProfileKey: DEFAULT_RENDER_PROFILE_KEY,
        scalePolicy: normalized.policy,
        vmin: normalized.vmin,
        vmax: normalized.vmax,
        evidenceSignature,
        status: "rebalancing",
        version: nextVersion,
        active: false,
      })
      .returning();

    const allResultIds = Array.from(new Set(extents.map((row) => row.resultId)));
    const targets = await opts.db.select().from(results).where(inArray(results.id, allResultIds));
    try {
      const rendered = await renderScaledMediaRows({
        db: opts.db,
        engine: opts.engine,
        resultRows: targets,
        field: group.field,
        scale: { id: scale.id, version: scale.version, vmin: scale.vmin, vmax: scale.vmax, policy: scale.scalePolicy },
        airfoilPoints: opts.airfoilPoints,
      });
      await opts.db.transaction(async (tx) => {
        await tx
          .update(fieldColorScales)
          .set({ active: false })
          .where(
            and(
              eq(fieldColorScales.airfoilId, group.airfoilId),
              eq(fieldColorScales.simulationPresetRevisionId, group.presetRevisionId),
              eq(fieldColorScales.field, group.field),
              eq(fieldColorScales.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
              eq(fieldColorScales.active, true),
            ),
          );
        await tx
          .update(fieldColorScales)
          .set({ active: true, status: "active", activatedAt: new Date() })
          .where(eq(fieldColorScales.id, scale.id));
        mediaCount += await registerRenderedMediaSet(tx as unknown as DB, opts.engine, rendered, {
          id: scale.id,
          version: scale.version,
          vmin: scale.vmin,
          vmax: scale.vmax,
          policy: scale.scalePolicy,
        });
      });
    } catch (error) {
      await opts.db
        .update(fieldColorScales)
        .set({ status: "failed", failureReason: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500) })
        .where(eq(fieldColorScales.id, scale.id));
    }
  }
  return mediaCount;
}

/** Ingest a completed JobResult into Postgres. Pure upsert on the natural key, so
 *  re-ingesting a job is a no-op (idempotent). Registers RANS contour images now;
 *  URANS video / force-history slots fill once the Python pipeline emits them. */
export async function ingestResult(opts: {
  db: DB;
  engine: EngineClient;
  engineJobId: string;
  simJobId: string;
  airfoilId: string;
  speedMap: SpeedBc[];
  /** Batched campaign jobs only: each polar is mapped to its (condition,
   *  revision, bc) by exact canonical speed. Jobs without a conditionMap keep
   *  the single-revision nearest-speed path unchanged. */
  conditionMap?: ConditionMapEntry[];
  result: JobResult;
}): Promise<{ points: number; media: number; dirtyLanes: CampaignLaneKey[] }> {
  const { db, engine, engineJobId, simJobId, airfoilId, speedMap, conditionMap, result } = opts;
  let points = 0;
  let media = 0;
  const airfoilPoints = await airfoilContourPoints(db, airfoilId);
  const scaleGroups = new Map<ScaleGroupKey, ScaleGroup>();
  const dirtyLanes = new Map<string, CampaignLaneKey>();

  for (const polar of result.polars) {
    let bcId: string;
    let presetRevisionId: string | null;
    let mappedMach: number | null;
    if (conditionMap?.length) {
      // Batched campaign job: exact canonical speed → condition entry. A polar
      // with no matching entry is skipped — never misattributed to a revision.
      const entry = matchConditionEntryBySpeed(conditionMap, polar.speed);
      if (!entry) {
        console.error(
          `[sweeper] ingest ${engineJobId}: polar speed ${polar.speed} has no conditionMap entry (canonical ${canonicalSi("speedMps", polar.speed)}) — skipping polar`,
        );
        continue;
      }
      bcId = entry.bcId;
      presetRevisionId = entry.revisionId;
      mappedMach = speedMap.find((s) => canonicalSi("speedMps", s.speed) === entry.speed)?.mach ?? null;
    } else {
      if (speedMap.length === 0) continue;
      const match = speedMap.reduce((best, s) =>
        Math.abs(s.speed - polar.speed) < Math.abs(best.speed - polar.speed) ? s : best,
      );
      bcId = match.bcId;
      presetRevisionId = match.presetRevisionId ?? null;
      mappedMach = match.mach ?? null;
    }
    const resultIdsByAoa = new Map<number, string>();

    for (const p of polar.points) {
      const stalled = stalledForPoint(p);
      const failed = failedForPoint(p);
      const v: ResultInsert = {
        airfoilId,
        bcId,
        simulationPresetRevisionId: presetRevisionId,
        aoaDeg: p.aoa_deg,
        status: failed ? "failed" : "done",
        source: failed ? "queued" : "solved",
        regime: p.unsteady ? "urans" : "rans",
        reynolds: Math.round(polar.reynolds),
        speed: polar.speed,
        chord: polar.chord,
        mach: polar.mach ?? mappedMach,
        cl: p.cl ?? null,
        cd: p.cd ?? null,
        cm: p.cm ?? null,
        clCd: p.cl_cd ?? null,
        clStd: p.cl_std ?? null,
        cdStd: p.cd_std ?? null,
        cmStd: p.cm_std ?? null,
        stalled,
        unsteady: p.unsteady,
        converged: p.converged,
        finalResidual: p.final_residual ?? null,
        iterations: p.iterations ?? null,
        yPlusAvg: p.y_plus_avg ?? null,
        yPlusMax: p.y_plus_max ?? null,
        nCells: p.n_cells ?? null,
        firstOrderFallback: p.first_order_fallback,
        strouhal: p.strouhal ?? null,
        error: p.error ?? null,
        engineJobId,
        engineCaseSlug: p.case_slug ?? null,
        simJobId,
        solvedAt: new Date(),
        priority: 0,
      };
      const { airfoilId: _a, bcId: _b, simulationPresetRevisionId: _rev, aoaDeg: _c, ...setV } = v;
      const [row] = await db
        .insert(results)
        .values(v)
        .onConflictDoUpdate({ target: [results.airfoilId, results.simulationPresetRevisionId, results.aoaDeg], set: setV })
        .returning({ id: results.id });
      resultIdsByAoa.set(p.aoa_deg, row.id);
      const attemptId = await insertResultAttempt({ db, resultId: row.id, airfoilId, bcId, presetRevisionId, simJobId, engineJobId, point: p });
      points++;

      // Campaign ingest hook (spec §7): terminal-link matching campaign points
      // (incl. derived-by-symmetry cells), bump progress counters, collect
      // dirty lane keys. Lanes are drained by the caller AFTER the polar fit
      // cache refresh so laneTick sees the new fit.
      const laneKeys = await onResultIngested(db, {
        airfoilId,
        revisionId: presetRevisionId,
        aoaDeg: p.aoa_deg,
        resultId: row.id,
        status: failed ? "failed" : "done",
        regime: p.unsteady ? "urans" : "rans",
      });
      for (const key of laneKeys) dirtyLanes.set(laneKeyId(key), key);

      for (const artifact of p.evidence_artifacts ?? []) {
        await registerEvidenceArtifacts({
          db,
          engine,
          resultId: row.id,
          resultAttemptId: attemptId,
          airfoilId,
          simJobId,
          engineJobId,
          point: p,
          artifact,
        });
      }

      if (airfoilPoints) {
        await computeAndStoreFieldExtents({
          db,
          engine,
          engineJobId,
          airfoilId,
          presetRevisionId,
          resultId: row.id,
          point: p,
          speed: polar.speed,
          chord: polar.chord,
          airfoilPoints,
          groups: scaleGroups,
        });
      }

      if (p.force_history) {
        const fh = p.force_history;
        await db
          .insert(forceHistory)
          .values({
            resultId: row.id,
            t: fh.t,
            cl: fh.cl,
            cd: fh.cd,
            cm: fh.cm ?? null,
            clMean: p.cl ?? null,
            clRms: p.cl_std ?? null,
            cdMean: p.cd ?? null,
            cdRms: p.cd_std ?? null,
            strouhal: p.strouhal ?? null,
            sheddingFreqHz: fh.shedding_freq_hz ?? null,
            sampleCount: fh.samples ?? null,
          })
          .onConflictDoUpdate({
            target: forceHistory.resultId,
            set: { t: fh.t, cl: fh.cl, cd: fh.cd, cm: fh.cm ?? null, strouhal: p.strouhal ?? null },
          });
      }
    }
    for (const p of polar.attempts ?? []) {
      const attemptId = await insertResultAttempt({
        db,
        resultId: resultIdsByAoa.get(p.aoa_deg) ?? null,
        airfoilId,
        bcId,
        presetRevisionId,
        simJobId,
        engineJobId,
        point: p,
      });
      for (const artifact of p.evidence_artifacts ?? []) {
        await registerEvidenceArtifacts({
          db,
          engine,
          resultId: resultIdsByAoa.get(p.aoa_deg) ?? null,
          resultAttemptId: attemptId,
          airfoilId,
          simJobId,
          engineJobId,
          point: p,
          artifact,
        });
      }
    }
  }
  if (airfoilPoints && scaleGroups.size) {
    media += await rebalanceFieldScales({ db, engine, groups: scaleGroups, airfoilPoints });
  }
  return { points, media, dirtyLanes: [...dirtyLanes.values()] };
}
