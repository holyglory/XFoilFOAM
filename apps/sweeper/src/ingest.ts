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
  resultClassifications,
  resultFieldExtents,
  results,
  resultMedia,
  solverEvidenceArtifacts,
} from "@aerodb/db";
import { baseRejectionReasons, canonicalSi, type PolarEvidencePoint } from "@aerodb/core";
import {
  ALL_IMAGE_FIELDS,
  type EngineClient,
  type EngineEvidenceArtifact,
  type ImageFieldName,
  type JobResult,
  parseFrameTrack,
  parsePointFidelity,
  parseSteadyHistory,
  type PointFidelity,
  type PolarPoint,
  type RenderedDefaultMedia,
  type UransFidelity,
} from "@aerodb/engine-client";
import { and, desc, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

import { touchHeartbeat } from "./heartbeat";

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

function shippedMimeType(kind: "image" | "video", urlPath: string): string {
  const ext = urlPath.split(".").pop()?.toLowerCase() ?? "";
  if (kind === "video") return ext === "webm" ? "video/webm" : "video/mp4";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  return "image/png";
}

/** Engine-shipped media (contour PNGs, URANS animation mp4, mean images) are
 *  registered at INGEST time, before any scaled-render round-trip. The
 *  classifier's hasVideo gate and the detail page read result_media, so a
 *  coefficient-complete URANS point must never lose its video row just
 *  because the later extents/render pass failed. Rows share the scaled-render
 *  path's (result, kind, field, role) upsert key, so a successful scaled
 *  render simply overwrites these with the scale-stamped versions.
 *
 *  Video rows are additionally RECONCILED to the current shipment: upserts
 *  never delete, so a wave-2 re-solve that ships no video (video:{}) would
 *  otherwise leave the wave-1 video row satisfying the classifier's hasVideo
 *  gate for the NEW coefficients. Only kind='video' rows whose field is
 *  absent from the current p.video map are removed — scaled-render video
 *  rows share the same (result, kind, field, role) key, so for any field the
 *  new shipment DOES cover, the row survives and is overwritten/re-rendered
 *  by the chain instead of being orphaned. */
async function registerShippedMedia(db: DB, engine: EngineClient, resultId: string, p: PolarPoint): Promise<number> {
  const groups: Array<{ kind: "image" | "video"; role: "instantaneous" | "mean"; entries: Record<string, string> }> = [
    { kind: "image", role: "instantaneous", entries: p.images ?? {} },
    { kind: "image", role: "mean", entries: p.mean_images ?? {} },
    { kind: "video", role: "instantaneous", entries: p.video ?? {} },
  ];
  const shippedVideoFields = Object.entries(p.video ?? {})
    .filter(([, urlPath]) => Boolean(urlPath))
    .map(([field]) => field);
  await db
    .delete(resultMedia)
    .where(
      and(
        eq(resultMedia.resultId, resultId),
        eq(resultMedia.kind, "video"),
        shippedVideoFields.length ? notInArray(resultMedia.field, shippedVideoFields) : undefined,
      ),
    );
  let count = 0;
  for (const group of groups) {
    for (const [field, urlPath] of Object.entries(group.entries)) {
      if (!urlPath) continue;
      await registerMedia(db, engine, resultId, group.kind, group.role, field, urlPath, shippedMimeType(group.kind, urlPath));
      count++;
    }
  }
  return count;
}

function stalledForPoint(p: PolarPoint): boolean {
  return p.unsteady || p.converged === false;
}

function validForPolarPoint(p: PolarPoint): boolean {
  const hasCoefficients = finiteNumber(p.cl) && finiteNumber(p.cd) && p.cd > 0;
  if (p.unsteady) return !p.error && hasCoefficients;
  return p.converged === true && !stalledForPoint(p) && !p.error && hasCoefficients;
}

/** A point with an error or without finite coefficients is failure/absence —
 *  exported so reconcile's worker-restart orphan path can keep ONLY solved
 *  points as evidence and release everything else for a re-solve. */
export function failedForPoint(p: PolarPoint): boolean {
  return Boolean(p.error) || !finiteNumber(p.cl) || !finiteNumber(p.cd);
}

/** frame_track value to persist on the results row: the engine payload
 *  VERBATIM (null-safe). Contract drift is validated loudly here but the raw
 *  value is still persisted — it is solver evidence, and the classifier's
 *  stationarity gate fails closed on drifted shapes (a malformed frame_track
 *  can only ever REJECT a point, never sneak one through). Exported for the
 *  contract pin test. */
export function frameTrackForPoint(p: PolarPoint, context: string): unknown {
  const raw = p.frame_track ?? null;
  if (raw === null) {
    if (p.unsteady) {
      // Post-contract engines ship frame_track on EVERY shedding URANS point.
      // A shedding point arriving WITHOUT it (period unmeasurable / stats
      // computation failed engine-side) has zero stationarity evidence, so it
      // must NOT persist as null — null means legacy pre-contract evidence
      // and skips the classifier's stationarity gate entirely. Persist a
      // fail-closed sentinel: the gate reads stationary / periods_retained
      // and rejects honestly (non-stationary + insufficient-periods).
      console.error(
        `[sweeper] frame_track MISSING on shedding URANS point (${context}); persisting fail-closed sentinel`,
      );
      return {
        missing: true,
        stationary: false,
        periods_retained: null,
        reason: "engine shipped no frame_track for a shedding URANS point",
      };
    }
    return null;
  }
  const parsed = parseFrameTrack(raw);
  if (!parsed.ok) {
    // Loud, never silent: a drifted engine payload means the pinned
    // frame-track contract broke on one side. Tests pin both sides; this log
    // is the production tripwire.
    console.error(`[sweeper] frame_track CONTRACT DRIFT (${context}): ${parsed.errors.join("; ")}`);
  }
  return raw;
}

/** Fidelity tier to persist on the results row (ladder contract 1/3).
 *  Precedence: the engine's strict-parsed echo; else the tier the JOB
 *  requested (for URANS points of fidelity-requesting wave-2 jobs — with a
 *  loud drift log, because a post-ladder engine must echo); else the honest
 *  regime-derived tier matching the 0034 backfill semantics (pre-ladder
 *  engines: urans = full behavior, steady = rans). Exported for the pin test. */
export function fidelityForPoint(p: PolarPoint, requestedUransFidelity: UransFidelity | undefined, context: string): PointFidelity {
  const echoed = parsePointFidelity(p.fidelity);
  if (echoed) return echoed;
  if (p.unsteady && requestedUransFidelity) {
    console.error(
      `[sweeper] fidelity echo MISSING on URANS point of a '${requestedUransFidelity}'-fidelity job (${context}); persisting the requested tier — engine contract drift`,
    );
    return requestedUransFidelity === "precalc" ? "urans_precalc" : "urans_full";
  }
  return p.unsteady ? "urans_full" : "rans";
}

/** steady_history value to persist verbatim (ladder contract 2). Like
 *  frame_track: drift is validated loudly but the raw payload is still
 *  persisted (solver evidence) — the classifier reads mean_stable fail-closed,
 *  so a malformed payload can never WAIVE a convergence gate. Exported for the
 *  pin test. */
export function steadyHistoryForPoint(p: PolarPoint, context: string): unknown {
  const raw = p.steady_history ?? null;
  if (raw === null) return null;
  const parsed = parseSteadyHistory(raw);
  if (!parsed.ok) {
    console.error(`[sweeper] steady_history CONTRACT DRIFT (${context}): ${parsed.errors.join("; ")}`);
  }
  return raw;
}

/** Oscillating-steady quality marker (ladder contract 2): a steady point
 *  accepted through mean-stable oscillating averaging carries the honest
 *  note in quality_warnings — the marker every point-story surface already
 *  reads. Never duplicates an engine-shipped warning. Exported for tests. */
export const STEADY_OSCILLATING_MARKER = "steady-oscillating-mean";

export function qualityWarningsForPoint(p: PolarPoint): string[] | null {
  const warnings = [...(p.quality_warnings ?? [])];
  const history = p.steady_history;
  if (!p.unsteady && history && typeof history === "object" && (history as { mean_stable?: unknown }).mean_stable === true) {
    const note = typeof (history as { note?: unknown }).note === "string" && (history as { note: string }).note.trim()
      ? (history as { note: string }).note
      : "steady solve settled into a bounded oscillation; coefficients are stable window means";
    const marker = `${STEADY_OSCILLATING_MARKER}: ${note}`;
    if (!warnings.includes(marker)) warnings.push(marker);
  }
  return warnings.length ? warnings : null;
}

/** Quality-warning marker prefix stamped on the ATTEMPT row when the replace
 *  guard keeps the canonical row (gate incident 2026-07-07: a rejected precalc
 *  URANS upserted OVER an accepted oscillating-steady RANS). Exported for the
 *  must-catch tests and every point-story surface that reads the marker. */
export const REPLACE_GUARD_MARKER = "higher-tier attempt rejected";

/** Classification states whose canonical row the replace guard protects.
 *  needs_urans is PROVISIONAL ACCEPTED evidence (it feeds the polar fit), so
 *  it is protected exactly like accepted — never treated as rejected. */
const REPLACE_GUARD_PROTECTED_STATES = new Set<string>(["accepted", "needs_urans"]);

/** Evidence view of an INCOMING engine point, shaped exactly like the row the
 *  post-ingest classifier would load from the results table (polar-cache
 *  loadResultEvidence → toEvidence). Media-presence gates (hasVideo /
 *  hasForceHistory) evaluate against what the payload SHIPS — the same media
 *  that registerShippedMedia / the force-history upsert would persist for this
 *  row. Exported for the replace-guard tests. */
export function incomingPointEvidence(
  p: PolarPoint,
  derived: { fidelity: PointFidelity; frameTrack: unknown; steadyHistory: unknown; error: string | null },
): PolarEvidencePoint {
  const failed = failedForPoint(p);
  return {
    a: p.aoa_deg,
    cl: p.cl ?? null,
    cd: p.cd ?? null,
    cm: p.cm ?? null,
    ld: p.cl_cd ?? null,
    status: failed ? "failed" : "done",
    source: failed ? "queued" : "solved",
    regime: p.unsteady ? "urans" : "rans",
    converged: p.converged,
    stalled: stalledForPoint(p),
    unsteady: p.unsteady,
    error: derived.error,
    finalResidual: p.final_residual ?? null,
    iterations: p.iterations ?? null,
    firstOrderFallback: p.first_order_fallback,
    validForPolar: validForPolarPoint(p),
    hasForceHistory: Boolean(p.force_history),
    hasVideo: Object.values(p.video ?? {}).some(Boolean),
    frameTrack: (derived.frameTrack ?? null) as PolarEvidencePoint["frameTrack"],
    fidelity: derived.fidelity,
    steadyHistory: (derived.steadyHistory ?? null) as PolarEvidencePoint["steadyHistory"],
  };
}

/** Advisory pre-classification for the replace decision ONLY: the pointwise
 *  rejection reasons the classifier's evidence gate (packages/core
 *  baseRejectionReasons — the exact function the post-ingest classifier runs)
 *  would raise for the incoming payload. Empty = the point would classify
 *  accepted or needs_urans-eligible (needs_urans only ever downgrades an
 *  ACCEPTED point via polar-shape context, never resurrects a rejected one, so
 *  the pointwise gate alone decides accept-vs-reject).
 *
 *  DRIFT FAILS SAFE by construction: the post-ingest classifier remains the
 *  source of truth for whatever row IS canonical. Every gate in
 *  baseRejectionReasons fails CLOSED (malformed frame_track / steady_history
 *  can only ever add reasons), and the media gates here see the payload's own
 *  shipment — so any pre/post disagreement can only make this function REJECT
 *  a point the classifier might have accepted (guard keeps the existing
 *  accepted evidence: the safe direction), never accept one the classifier
 *  rejects. Exported for the replace-guard tests. */
export function incomingRejectionReasons(
  p: PolarPoint,
  derived: { fidelity: PointFidelity; frameTrack: unknown; steadyHistory: unknown; error: string | null },
): string[] {
  return baseRejectionReasons(incomingPointEvidence(p, derived));
}

interface ReplaceGuardVerdict {
  /** Existing canonical row id (guard engaged: NOT upserted, kept as-is). */
  keptResultId: string;
  keptFidelity: string | null;
  keptRegime: "rans" | "urans" | null;
  keptState: string;
  reasons: string[];
}

/** Replace-guard decision for one incoming point (gate incident 2026-07-07):
 *  results are cell-unique (airfoil, revision, aoa) and classification runs
 *  AFTER the upsert, so before this guard a higher-fidelity ATTEMPT that
 *  failed its evidence gate silently replaced an accepted row. Returns a
 *  verdict when the canonical row must be KEPT (existing row is status=done
 *  with an accepted/needs_urans classification AND the incoming point would
 *  reject); null = upsert as today. Claimed rows (pending/queued/running) are
 *  never guarded — a re-solve in flight owns its cell, and blocking it would
 *  strand the row in a non-terminal status. */
async function replaceGuardVerdict(opts: {
  db: DB;
  airfoilId: string;
  presetRevisionId: string | null;
  point: PolarPoint;
  derived: { fidelity: PointFidelity; frameTrack: unknown; steadyHistory: unknown; error: string | null };
}): Promise<ReplaceGuardVerdict | null> {
  const { db, airfoilId, presetRevisionId, point: p, derived } = opts;
  // Legacy rows without a revision can't be addressed by the upsert's natural
  // key semantics here (NULL never equals NULL) — never guarded.
  if (!presetRevisionId) return null;
  const reasons = incomingRejectionReasons(p, derived);
  if (!reasons.length) return null; // would-accept (or needs_urans-eligible): normal replacement.
  const [existing] = await db
    .select({
      id: results.id,
      status: results.status,
      fidelity: results.fidelity,
      regime: results.regime,
      state: resultClassifications.state,
    })
    .from(results)
    .leftJoin(resultClassifications, eq(resultClassifications.resultId, results.id))
    .where(
      and(
        eq(results.airfoilId, airfoilId),
        eq(results.simulationPresetRevisionId, presetRevisionId),
        eq(results.aoaDeg, p.aoa_deg),
      ),
    )
    .limit(1);
  // Absent / failed / claimed / rejected / unclassified existing evidence:
  // any honest evidence beats none — upsert as today.
  if (!existing || existing.status !== "done") return null;
  if (!existing.state || !REPLACE_GUARD_PROTECTED_STATES.has(existing.state)) return null;
  return {
    keptResultId: existing.id,
    keptFidelity: existing.fidelity ?? null,
    keptRegime: existing.regime,
    keptState: existing.state,
    reasons,
  };
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
  /** Extra honest markers appended to the attempt's quality warnings (replace
   *  guard: "higher-tier attempt rejected: …"). Never duplicated. */
  extraQualityWarnings?: string[];
}): Promise<string | null> {
  const { db, resultId, airfoilId, bcId, presetRevisionId, simJobId, engineJobId, point: p } = opts;
  const stalled = stalledForPoint(p);
  const warnings = [...(qualityWarningsForPoint(p) ?? [])];
  for (const extra of opts.extraQualityWarnings ?? []) {
    if (!warnings.includes(extra)) warnings.push(extra);
  }
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
      // Engine non-fatal quality warnings — persisted verbatim so the point
      // story timeline can show the honest "why" (empty list → NULL, absence
      // stays absence). The oscillating-steady mean-stable marker is appended
      // here too (ladder contract 2), plus any caller-supplied markers
      // (replace guard).
      qualityWarnings: warnings.length ? warnings : null,
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
  const knownKinds = [
    "manifest",
    "openfoam_bundle",
    "vtk_window",
    "time_directory",
    "log",
    "force_coefficients",
    "mesh",
    "dictionary",
    "field_data",
    // Per-frame URANS PNGs (frame-track contract, FRAME_IMAGE_ARTIFACT_KIND).
    "frame_image",
  ] as const;
  const kind = knownKinds.find((k) => k === artifact.kind);
  if (!kind) {
    // Loud skip instead of a pg enum error that would abort the WHOLE ingest:
    // one unknown artifact kind from a newer engine must not cost the point's
    // coefficients, media, and every other artifact.
    console.error(
      `[sweeper] evidence artifact kind "${artifact.kind}" unknown to this build — SKIPPED (job ${engineJobId}, case ${point.case_slug}, aoa ${point.aoa_deg}, path ${artifact.path})`,
    );
    return;
  }
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
  if (!evidenceBase) {
    // Loud, never silent: without an evidence base the point can never get
    // scaled media, and downstream that reads as "missing-urans-video".
    console.error(
      `[sweeper] field extents skipped: no evidence base in manifest (job ${engineJobId}, case ${point.case_slug}, aoa ${point.aoa_deg}, result ${resultId})`,
    );
    return;
  }
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
  } catch (error) {
    // Loud, never silent: a swallowed extents failure is exactly how prod
    // points ended up coefficient-complete but "missing-urans-video".
    console.error(
      `[sweeper] computeFieldExtents FAILED (job ${engineJobId}, case ${point.case_slug}, aoa ${point.aoa_deg}, result ${resultId}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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
  heartbeat: () => Promise<void>;
}): Promise<{ resultId: string; media: RenderedDefaultMedia[] }[]> {
  const rendered: { resultId: string; media: RenderedDefaultMedia[] }[] = [];
  for (const result of opts.resultRows) {
    if (!result.engineJobId || !result.engineCaseSlug || result.status !== "done" || result.source !== "solved") continue;
    // Invariant: no ingest code path may run >30 s without a heartbeat touch.
    // Each renderDefaultMedia call is a full engine render round-trip (video
    // re-encode included) — the longest single stretch of the ingest chain.
    await opts.heartbeat();
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
  heartbeat: () => Promise<void>;
}): Promise<number> {
  let mediaCount = 0;
  for (const group of opts.groups.values()) {
    // Invariant: no ingest code path may run >30 s without a heartbeat touch.
    // One touch per scaled-render field batch; renderScaledMediaRows touches
    // again per result inside the batch (heartbeat 204 s stale, 2026-07-06).
    await opts.heartbeat();
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
        heartbeat: opts.heartbeat,
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
        heartbeat: opts.heartbeat,
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
      const reason = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      // Loud + recorded: the failure lands on the scale row (status='failed',
      // failureReason, render_attempts) AND in the log with full addressing,
      // never silently. The reconcile retry pass re-attempts failed rows until
      // MAX_SCALE_RENDER_ATTEMPTS (a one-shot transient engine fetch failure
      // must not orphan the scale permanently — live proof 2026-07-05).
      console.error(
        `[sweeper] scaled-media render FAILED (airfoil ${group.airfoilId}, revision ${group.presetRevisionId}, field ${group.field}, scale v${scale.version}): ${reason}`,
      );
      await opts.db
        .update(fieldColorScales)
        .set({ status: "failed", failureReason: reason, renderAttempts: sql`${fieldColorScales.renderAttempts} + 1` })
        .where(eq(fieldColorScales.id, scale.id));
    }
  }
  return mediaCount;
}

/** Bounded cap on scale render attempts: the first attempt happens at ingest;
 *  the reconcile retry pass re-runs failed rows until the count reaches this. */
export const MAX_SCALE_RENDER_ATTEMPTS = 3;

/** Re-attempt failed shared-scale renders (bounded). A scale row that failed
 *  its render at ingest time (e.g. one transient engine fetch failure) is
 *  retried here with FRESH extents: only latest-version failed rows are live
 *  rebalance intent — a later ingest that rebalanced the same scope created a
 *  newer version that already re-rendered every extents row, so older failed
 *  rows are dead history and stay untouched. Returns registered media count. */
export async function retryFailedScaleRenders(
  db: DB,
  engine: EngineClient,
  opts: { heartbeat?: () => Promise<void>; maxAttempts?: number } = {},
): Promise<number> {
  const heartbeat = opts.heartbeat ?? (() => touchHeartbeat(db));
  const maxAttempts = opts.maxAttempts ?? MAX_SCALE_RENDER_ATTEMPTS;
  const retryable = await db
    .select()
    .from(fieldColorScales)
    .where(
      and(
        eq(fieldColorScales.status, "failed"),
        lt(fieldColorScales.renderAttempts, maxAttempts),
        sql`NOT EXISTS (
          SELECT 1 FROM field_color_scales newer
          WHERE newer.airfoil_id = ${fieldColorScales.airfoilId}
            AND newer.simulation_preset_revision_id = ${fieldColorScales.simulationPresetRevisionId}
            AND newer.field = ${fieldColorScales.field}
            AND newer.render_profile_key = ${fieldColorScales.renderProfileKey}
            AND newer.version > ${fieldColorScales.version}
        )`,
      ),
    );
  let mediaCount = 0;
  for (const scaleRow of retryable) {
    if (!isImageFieldName(scaleRow.field)) continue;
    const field: ImageFieldName = scaleRow.field;
    // Invariant: no code path may run >30 s without a heartbeat touch — each
    // retry is a per-result engine render round-trip chain.
    await heartbeat();
    const airfoilPoints = await airfoilContourPoints(db, scaleRow.airfoilId);
    if (!airfoilPoints) continue;
    const extents = await db
      .select()
      .from(resultFieldExtents)
      .where(
        and(
          eq(resultFieldExtents.airfoilId, scaleRow.airfoilId),
          eq(resultFieldExtents.simulationPresetRevisionId, scaleRow.simulationPresetRevisionId),
          eq(resultFieldExtents.field, scaleRow.field),
          eq(resultFieldExtents.renderProfileKey, scaleRow.renderProfileKey),
        ),
      );
    if (!extents.length) {
      // Nothing left to scale (results pruned since the failure): the pending
      // rebalance is moot and nothing references a never-activated row.
      await db.delete(fieldColorScales).where(eq(fieldColorScales.id, scaleRow.id));
      continue;
    }
    const minValue = Math.min(...extents.map((row) => row.vmin));
    const maxValue = Math.max(...extents.map((row) => row.vmax));
    const normalized = normalizeScale(field, minValue, maxValue);
    const evidenceSignature = stableHash(
      extents
        .map((row) => ({ resultId: row.resultId, field: row.field, min: row.vmin, max: row.vmax, evidenceSha256: row.evidenceSha256 }))
        .sort((a, b) => a.resultId.localeCompare(b.resultId)),
    );
    const [active] = await db
      .select()
      .from(fieldColorScales)
      .where(
        and(
          eq(fieldColorScales.airfoilId, scaleRow.airfoilId),
          eq(fieldColorScales.simulationPresetRevisionId, scaleRow.simulationPresetRevisionId),
          eq(fieldColorScales.field, scaleRow.field),
          eq(fieldColorScales.renderProfileKey, scaleRow.renderProfileKey),
          eq(fieldColorScales.active, true),
        ),
      )
      .limit(1);
    const targets = await db.select().from(results).where(inArray(results.id, [...new Set(extents.map((row) => row.resultId))]));
    try {
      if (active && nearlyEqual(active.vmin, normalized.vmin) && nearlyEqual(active.vmax, normalized.vmax)) {
        // Extents drifted back to the ACTIVE scale since the failure: the
        // pending rebalance is moot — heal media at the active scale and
        // retire the never-activated failed row.
        const rendered = await renderScaledMediaRows({
          db,
          engine,
          resultRows: targets,
          field,
          scale: { id: active.id, version: active.version, vmin: active.vmin, vmax: active.vmax, policy: active.scalePolicy },
          airfoilPoints,
          heartbeat,
        });
        mediaCount += await registerRenderedMediaSet(db, engine, rendered, {
          id: active.id,
          version: active.version,
          vmin: active.vmin,
          vmax: active.vmax,
          policy: active.scalePolicy,
        });
        await db.delete(fieldColorScales).where(eq(fieldColorScales.id, scaleRow.id));
        continue;
      }
      // Re-run the rebalance on the SAME version row with fresh values (no
      // version churn per retry — the version was already allocated).
      await db
        .update(fieldColorScales)
        .set({ status: "rebalancing", scalePolicy: normalized.policy, vmin: normalized.vmin, vmax: normalized.vmax, evidenceSignature })
        .where(eq(fieldColorScales.id, scaleRow.id));
      const rendered = await renderScaledMediaRows({
        db,
        engine,
        resultRows: targets,
        field,
        scale: { id: scaleRow.id, version: scaleRow.version, vmin: normalized.vmin, vmax: normalized.vmax, policy: normalized.policy },
        airfoilPoints,
        heartbeat,
      });
      await db.transaction(async (tx) => {
        await tx
          .update(fieldColorScales)
          .set({ active: false })
          .where(
            and(
              eq(fieldColorScales.airfoilId, scaleRow.airfoilId),
              eq(fieldColorScales.simulationPresetRevisionId, scaleRow.simulationPresetRevisionId),
              eq(fieldColorScales.field, scaleRow.field),
              eq(fieldColorScales.renderProfileKey, scaleRow.renderProfileKey),
              eq(fieldColorScales.active, true),
            ),
          );
        await tx
          .update(fieldColorScales)
          .set({ active: true, status: "active", activatedAt: new Date(), failureReason: null })
          .where(eq(fieldColorScales.id, scaleRow.id));
        mediaCount += await registerRenderedMediaSet(tx as unknown as DB, engine, rendered, {
          id: scaleRow.id,
          version: scaleRow.version,
          vmin: normalized.vmin,
          vmax: normalized.vmax,
          policy: normalized.policy,
        });
      });
      console.log(
        `[sweeper] scaled-media retry RECOVERED (airfoil ${scaleRow.airfoilId}, revision ${scaleRow.simulationPresetRevisionId}, field ${scaleRow.field}, scale v${scaleRow.version}, attempt ${scaleRow.renderAttempts + 1})`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      const attempt = scaleRow.renderAttempts + 1;
      console.error(
        `[sweeper] scaled-media retry FAILED (airfoil ${scaleRow.airfoilId}, revision ${scaleRow.simulationPresetRevisionId}, field ${scaleRow.field}, scale v${scaleRow.version}, attempt ${attempt}/${maxAttempts}${attempt >= maxAttempts ? " — EXHAUSTED, no further retries" : ""}): ${reason}`,
      );
      await db
        .update(fieldColorScales)
        .set({ status: "failed", failureReason: reason, renderAttempts: sql`${fieldColorScales.renderAttempts} + 1` })
        .where(eq(fieldColorScales.id, scaleRow.id));
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
  /** URANS fidelity tier the JOB requested (wave-2 requestPayload
   *  uransFidelity) — the honest fallback when a point's fidelity echo is
   *  missing (with a loud drift log). Absent on wave-1/legacy jobs. */
  uransFidelity?: UransFidelity;
  result: JobResult;
  /** Job-level failure message stamped onto failed points whose own `error`
   *  is empty (incident 2026-07-04: failed rows landed with NULL error →
   *  failures endpoint errorClass 'unknown'). Only the failed-job ingest path
   *  passes this; results.error must never be empty for a failed row. */
  failedPointErrorFallback?: string;
  /** Heartbeat hook, called per point / per scaled-render batch so a
   *  multi-minute ingest never lets sweeper_state.heartbeatAt go stale past
   *  the web's 90 s truth gate (2026-07-06: 204 s stale under 7 jobs in
   *  flight read as PROCESS NOT RUNNING on a healthy process). Defaults to
   *  the real touchHeartbeat; tests inject a spy to count touches. */
  heartbeat?: () => Promise<void>;
}): Promise<{ points: number; media: number; attempts: number; dirtyLanes: CampaignLaneKey[] }> {
  const { db, engine, engineJobId, simJobId, airfoilId, speedMap, conditionMap, result } = opts;
  const heartbeat = opts.heartbeat ?? (() => touchHeartbeat(db));
  let points = 0;
  let media = 0;
  // Attempt-evidence rows ingested from polars[].attempts. Reported separately
  // from `points` because an all-rejected job ships points: [] with the real
  // solver evidence ONLY in attempts (gate incident 2026-07-07, job a2379532):
  // the failed-job ingest path must be able to tell "evidence shipped" from a
  // true crash with an empty payload.
  let attempts = 0;
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
    // AoAs whose canonical row the replace guard KEPT in this polar: the
    // engine's warm-start march ships every point ALSO in polars[].attempts
    // (same evidence_artifacts, same storageKey+sha256), and the artifact
    // upsert's conflict SET rewrites resultId — without this set, the
    // attempts loop below would re-attach the rejected shipment's manifest
    // to the kept row, undoing the guard's resultId:null isolation.
    const guardedAoas = new Set<number>();

    for (const p of polar.points) {
      // Invariant: no ingest code path may run >30 s without a heartbeat
      // touch. Each point below does result/attempt/evidence upserts plus a
      // computeFieldExtents engine round-trip — a many-point ingest is the
      // prime multi-minute stretch that starved the heartbeat on 2026-07-06.
      await heartbeat();
      const stalled = stalledForPoint(p);
      const failed = failedForPoint(p);
      // A failed row must carry WHY it failed: the point's own error when the
      // solver produced one, else the job-level failure message (see
      // failedPointErrorFallback above). Never NULL/empty on a failed row.
      const pointError = p.error?.trim() ? p.error : failed ? (opts.failedPointErrorFallback ?? null) : null;
      const pointContext = `job ${engineJobId}, case ${p.case_slug ?? "?"}, aoa ${p.aoa_deg}`;
      // Evidence derivations shared by the results row AND the replace-guard
      // pre-classification — derived ONCE so both see identical values.
      const derived = {
        frameTrack: frameTrackForPoint(p, pointContext),
        fidelity: fidelityForPoint(p, opts.uransFidelity, pointContext),
        steadyHistory: steadyHistoryForPoint(p, pointContext),
        error: pointError,
      };

      // REPLACE GUARD (gate incident 2026-07-07): an incoming point that would
      // fail the classifier's evidence gate must NOT replace a canonical row
      // holding accepted (or needs_urans) evidence — the attempt + its
      // evidence artifacts are ingested instead, and the canonical row stays
      // untouched (verify/request bookkeeping settles in reconcile against
      // the unchanged row). Advisory pre-classification only: the post-ingest
      // classifier remains the source of truth for whatever row IS canonical.
      const guard = await replaceGuardVerdict({ db, airfoilId, presetRevisionId, point: p, derived });
      if (guard) {
        const keptLabel = guard.keptFidelity ?? guard.keptRegime ?? "existing";
        console.error(
          `[sweeper] REPLACE GUARD: higher-tier ${derived.fidelity} attempt rejected {${guard.reasons.join(", ")}} (${pointContext}) — kept ${keptLabel} ${guard.keptState} evidence on canonical row ${guard.keptResultId}; attempt + evidence artifacts ingested, canonical row NOT replaced`,
        );
        resultIdsByAoa.set(p.aoa_deg, guard.keptResultId);
        guardedAoas.add(p.aoa_deg);
        const attemptId = await insertResultAttempt({
          db,
          resultId: guard.keptResultId,
          airfoilId,
          bcId,
          presetRevisionId,
          simJobId,
          engineJobId,
          point: p,
          extraQualityWarnings: [`${REPLACE_GUARD_MARKER}: ${guard.reasons.join(", ")}; kept ${keptLabel} ${guard.keptState} evidence`],
        });
        attempts++;
        for (const artifact of p.evidence_artifacts ?? []) {
          await registerEvidenceArtifacts({
            db,
            engine,
            // resultId stays NULL on purpose: attaching the rejected attempt's
            // manifest to the kept row would let manifestEvidenceBaseForResult
            // re-render the ACCEPTED row's media from the rejected attempt's
            // evidence base. The attempt row owns this evidence.
            resultId: null,
            resultAttemptId: attemptId,
            airfoilId,
            simJobId,
            engineJobId,
            point: p,
            artifact,
          });
        }
        // Campaign bookkeeping still settles against the KEPT canonical row
        // (idempotent terminal-link + counters + completion probe) — the cell
        // HAS accepted evidence; nothing else (media, force history, field
        // extents) may touch the kept row.
        const laneKeys = await onResultIngested(db, {
          airfoilId,
          revisionId: presetRevisionId,
          aoaDeg: p.aoa_deg,
          resultId: guard.keptResultId,
          status: "done",
          regime: guard.keptRegime,
        });
        for (const key of laneKeys) dirtyLanes.set(laneKeyId(key), key);
        continue;
      }

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
        error: pointError,
        qualityWarnings: qualityWarningsForPoint(p),
        // URANS frame-track contract payload, verbatim. NULL = steady /
        // no-shedding / legacy engine — the classifier gates only non-NULL.
        frameTrack: derived.frameTrack,
        // Fidelity ladder (contract 1/3): tier the evidence was solved at.
        fidelity: derived.fidelity,
        // Oscillating-averaged steady evidence (contract 2), verbatim.
        steadyHistory: derived.steadyHistory,
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

      if (!failed) {
        media += await registerShippedMedia(db, engine, row.id, p);
      }

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
      // Invariant: no ingest code path may run >30 s without a heartbeat
      // touch — attempt rows carry evidence-artifact registration too.
      await heartbeat();
      attempts++;
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
          // Guarded cell: the attempt duplicate of a guard-rejected point (or
          // any sibling attempt of that shipment) must NOT re-attach its
          // manifest to the KEPT row — the (storageKey, sha256) conflict SET
          // would overwrite the guard's deliberate resultId:null and let
          // manifestEvidenceBaseForResult re-render the accepted row's media
          // from the rejected shipment's evidence base.
          resultId: guardedAoas.has(p.aoa_deg) ? null : (resultIdsByAoa.get(p.aoa_deg) ?? null),
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
    media += await rebalanceFieldScales({ db, engine, groups: scaleGroups, airfoilPoints, heartbeat });
  }
  return { points, media, attempts, dirtyLanes: [...dirtyLanes.values()] };
}
