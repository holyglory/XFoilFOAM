import {
  acquireResultEvidenceLock,
  airfoils,
  type CampaignLaneKey,
  fieldColorScales,
  enqueuePrecalcVerifications,
  forceHistory,
  hasExactValidSolverManifest,
  laneKeyId,
  onResultIngested,
  onResultIngestedWithAutomaticPrecalcHandoff,
  type DB,
  type ResultInsert,
  resultAttempts,
  resultClassifications,
  solverEvidenceArchives,
  solverEvidenceArtifactMembers,
  resultFieldExtents,
  resultMediaRepairs,
  refreshPolarCacheForRevision,
  results,
  resultMedia,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  withEvidenceArtifactWriteLocks,
} from "@aerodb/db";
import {
  baseRejectionReasons,
  canonicalSi,
  type PolarEvidencePoint,
} from "@aerodb/core";
import {
  ALL_IMAGE_FIELDS,
  type EngineClient,
  type EngineEvidenceArtifact,
  type FinalizeRemoteEvidenceRequest,
  type ImageFieldName,
  type JobResult,
  parseFrameTrack,
  parsePointFidelity,
  parseSteadyHistory,
  type PointFidelity,
  type PolarPoint,
  type RansPrecalcPromotion,
  type RenderedDefaultMedia,
  type UransFidelity,
} from "@aerodb/engine-client";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { constants, createReadStream } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve, sep } from "node:path";
import { promisify } from "node:util";

import { touchHeartbeat } from "./heartbeat";
import {
  databaseMemberAssociationsSha256,
  manifestMemberSetSha256,
  parseEvidenceManifest,
} from "./evidence-manifest";
import {
  persistEngineRuntimeForJob,
  resolveEngineRuntimeBuild,
  type ResolvedEngineRuntime,
} from "./engine-provenance";
import type { RansRetryScope } from "./retry-plan";

const execFileAsync = promisify(execFile);
export const DEFAULT_RENDER_PROFILE_KEY = "default:v1:zoom2";

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GCS_GENERATION_PATTERN = /^[1-9][0-9]{0,19}$/;
const GCS_CRC32C_PATTERN = /^[A-Za-z0-9+/]{6}==$/;
const ARCHIVED_EVIDENCE_MEMBER_KINDS = new Set([
  "manifest",
  "vtk_window",
  "time_directory",
  "log",
  "force_coefficients",
  "mesh",
  "dictionary",
  "field_data",
]);

interface VerifiedGcsEvidenceBundle {
  bucket: string;
  objectKey: string;
  generation: string;
  crc32c: string;
  uncompressedTarSha256: string;
  uncompressedTarByteSize: number;
  verifiedAt: Date;
  verifiedAtText: string;
  evidenceBase: string;
  zstdLevel: number;
  blobMetadata: Record<string, unknown>;
}

export interface PendingRemoteEvidenceCleanup {
  caseSlug: string;
  evidenceBase: string;
  pointer: FinalizeRemoteEvidenceRequest["remote"];
  bundledFileCount: number;
  associations: Array<{
    resultId: string;
    resultAttemptId: string;
    sourceArtifactId: string;
    archiveId: string;
    memberAssociationCount?: number;
    memberAssociationsSha256?: string;
    manifestMemberSetSha256?: string;
  }>;
}

export class TerminalEvidenceCleanupPendingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TerminalEvidenceCleanupPendingError";
  }
}

interface VideoMetadata {
  durationS?: number;
  width?: number;
  height?: number;
  frameCount?: number;
}

interface MediaRepairWriteFence {
  repairId: string;
  resultAttemptId: string;
  claimToken: string;
  evidenceSignature: string;
}

interface MediaRegistrationEvidence {
  /** Solver manifest that produced this media. */
  evidenceSha256: string;
  /** Render responses supply both values; when present the shared-volume
   * bytes are verified before any database row can be committed. */
  expectedSha256?: string;
  expectedByteSize?: number;
  /** Durable repair paths re-read the shared-volume bytes. Normal ingest has
   * already received the content identity from the local engine contract (or
   * computed it directly for shipped media), so it may persist that identity
   * without a second multi-gigabyte read. */
  verifyExpectedBytes?: boolean;
  /** Engine-shipped media belongs to the immutable attempt payload. A replay
   * may insert a missing association, but must never mutate an existing exact
   * row: the later scaled-render path is the only ordinary writer allowed to
   * replace it, and always supplies a complete non-null byte identity. */
  preserveExistingAttemptMedia?: boolean;
  repairFence?: MediaRepairWriteFence;
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
  /** Pinned semantic intent and complete condition-local polar request. */
  ransRetryScope?: RansRetryScope;
}

export interface IngestedRansPrecalcPromotion {
  revisionId: string;
  conditionId: string | null;
  triggerResultAttemptId: string;
  triggerAoaDeg: number;
  attemptedAoas: number[];
  intentionallyOmittedAoas: number[];
}

function uniqueFiniteAoasInOrder(values: number[]): number[] {
  return [...new Set(values.filter(Number.isFinite))];
}

function sameAoas(left: number[], right: number[]): boolean {
  return (
    left.length === right.length && left.every((value, i) => value === right[i])
  );
}

/** Mirror the engine's primary steady-RANS marcher exactly: an available
 * 0-degree attached-flow anchor runs first, then the positive branch, then
 * the negative branch outward from zero. Sweeps without zero stay ascending.
 *
 * This order is evidence semantics, not presentation order. Sorting the
 * engine's attempted AoAs numerically made a real 0..5-degree early abort look
 * as though -5..-1 had also run, permanently trapping the terminal job in
 * ingestion even though its typed omitted-angle list was exact. */
function primaryRansMarchAoas(requestedAoas: number[]): number[] {
  const sorted = [...requestedAoas].sort((a, b) => a - b);
  if (!sorted.includes(0)) return sorted;
  return [
    ...sorted.filter((aoa) => aoa === 0),
    ...sorted.filter((aoa) => aoa > 0),
    ...sorted.filter((aoa) => aoa < 0).reverse(),
  ];
}

/** Validate the engine's early-abort accounting against both exact staged
 * attempts and the immutable angle list actually sent to this engine job.
 * Invalid metadata is a contract error: silently accepting it could mark
 * unattempted cases complete or release the wrong parent claims. */
export function validateRansPrecalcPromotionSignal(opts: {
  promotion: RansPrecalcPromotion;
  stagedAttemptAoas: number[];
  triggerFailureDisposition: PolarPoint["failure_disposition"] | null;
  jobAoas: number[];
}): { attemptedAoas: number[]; intentionallyOmittedAoas: number[] } | null {
  const attemptedAoas = uniqueFiniteAoasInOrder(opts.promotion.attempted_aoas);
  const intentionallyOmittedAoas = uniqueFiniteAoasInOrder(
    opts.promotion.intentionally_omitted_aoas,
  );
  const stagedAttemptAoas = uniqueFiniteAoasInOrder(opts.stagedAttemptAoas);
  const jobAoas = uniqueFiniteAoasInOrder(opts.jobAoas);
  const marchAoas = primaryRansMarchAoas(jobAoas);
  const triggerIndex = marchAoas.indexOf(opts.promotion.trigger_aoa_deg);
  const expectedAttemptedAoas =
    triggerIndex >= 0 ? marchAoas.slice(0, triggerIndex + 1) : [];
  const expectedOmittedAoas =
    triggerIndex >= 0
      ? [...jobAoas]
          .sort((a, b) => a - b)
          .filter((aoa) => !expectedAttemptedAoas.includes(aoa))
      : [];
  if (
    opts.promotion.failure_disposition !== "hard_solver" ||
    opts.triggerFailureDisposition !== "hard_solver" ||
    !Number.isFinite(opts.promotion.trigger_aoa_deg) ||
    opts.promotion.trigger_aoa_deg < 0 ||
    opts.promotion.trigger_aoa_deg > 5 ||
    jobAoas.length !== opts.jobAoas.length ||
    attemptedAoas.length !== opts.promotion.attempted_aoas.length ||
    intentionallyOmittedAoas.length !==
      opts.promotion.intentionally_omitted_aoas.length ||
    stagedAttemptAoas.length !== opts.stagedAttemptAoas.length ||
    triggerIndex < 0 ||
    !sameAoas(attemptedAoas, expectedAttemptedAoas) ||
    !sameAoas(intentionallyOmittedAoas, expectedOmittedAoas) ||
    !sameAoas(attemptedAoas, stagedAttemptAoas) ||
    attemptedAoas.at(-1) !== opts.promotion.trigger_aoa_deg
  ) {
    return null;
  }
  return { attemptedAoas, intentionallyOmittedAoas };
}

/** Pure speed→condition mapping for batched jobs: canonical float equality.
 *  Returns null when no entry matches (a mismatched polar must be skipped, not
 *  misattributed to the nearest revision). */
export function matchConditionEntryBySpeed(
  entries: ConditionMapEntry[],
  polarSpeed: number,
): ConditionMapEntry | null {
  const canonical = canonicalSi("speedMps", polarSpeed);
  return entries.find((entry) => entry.speed === canonical) ?? null;
}

/** Engine image URL ("/jobs/<id>/files/cases/x/v.png") → media store key
 *  ("jobs/<id>/cases/x/v.png", relative to DATA_DIR). */
function storageKeyOf(urlPath: string): string {
  const m = urlPath.match(/^\/?jobs\/([^/]+)\/files\/(.+)$/);
  return m ? `jobs/${m[1]}/${m[2]}` : urlPath.replace(/^\/+/, "");
}

function requireExactNonEmptyString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value
  ) {
    throw new Error(
      `GCS evidence metadata ${label} must be a non-empty string`,
    );
  }
  return value;
}

function safeRelativePathParts(value: unknown, label: string): string[] {
  const path = requireExactNonEmptyString(value, label);
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new Error(
      `GCS evidence metadata ${label} must be a safe relative path`,
    );
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(
      `GCS evidence metadata ${label} must be a safe relative path`,
    );
  }
  return parts;
}

function requireContentAddressedObjectKey(
  objectKey: string,
  storedSha256: string,
  label: string,
): void {
  const suffix = `sha256/${storedSha256.slice(0, 2)}/${storedSha256}.tar.zst`;
  if (objectKey !== suffix && !objectKey.endsWith(`/${suffix}`)) {
    throw new Error(
      `GCS evidence metadata ${label} must use the content-addressed ${suffix} form`,
    );
  }
}

function requirePositiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `GCS evidence metadata ${label} must be a positive safe integer`,
    );
  }
  return value;
}

function requireNonnegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `GCS evidence metadata ${label} must be a non-negative safe integer`,
    );
  }
  return value;
}

function requirePattern(
  value: unknown,
  label: string,
  pattern: RegExp,
): string {
  const text = requireExactNonEmptyString(value, label);
  if (!pattern.test(text)) {
    throw new Error(`GCS evidence metadata ${label} is malformed`);
  }
  return text;
}

function parseVerifiedGcsEvidenceBundle(
  kind: string,
  artifact: EngineEvidenceArtifact,
): VerifiedGcsEvidenceBundle | null {
  if (kind !== "engine_bundle") return null;
  const metadata = artifact.metadata;
  if (!metadata) return null;
  if (metadata.storageBackend == null) {
    const hasPartialCanonicalPointer = [
      "bucket",
      "objectKey",
      "generation",
      "crc32c",
      "compression",
      "uncompressedTarSha256",
      "uncompressedTarByteSize",
      "verifiedAt",
    ].some((key) => metadata[key] != null);
    if (hasPartialCanonicalPointer) {
      throw new Error(
        "GCS evidence metadata storageBackend is required when archive pointer metadata is present",
      );
    }
    return null;
  }
  if (metadata.storageBackend === "volume") return null;
  if (metadata.storageBackend !== "gcs") {
    throw new Error(
      "GCS evidence metadata storageBackend must be 'gcs' or 'volume'",
    );
  }
  if (artifact.mime_type !== "application/zstd") {
    throw new Error("GCS engine_bundle evidence must use application/zstd");
  }
  if (metadata.compression !== "zstd") {
    throw new Error("GCS evidence metadata compression must be 'zstd'");
  }
  if (metadata.archiveFormat != null && metadata.archiveFormat !== "tar+zstd") {
    throw new Error("GCS evidence metadata archiveFormat must be 'tar+zstd'");
  }
  if (
    metadata.zstdLevel != null &&
    (!Number.isInteger(metadata.zstdLevel) ||
      (metadata.zstdLevel as number) < 1 ||
      (metadata.zstdLevel as number) > 22)
  ) {
    throw new Error(
      "GCS evidence metadata zstdLevel must be an integer from 1 to 22",
    );
  }
  const verifiedAtText = requireExactNonEmptyString(
    metadata.verifiedAt,
    "verifiedAt",
  );
  const verifiedAt = new Date(verifiedAtText);
  if (!Number.isFinite(verifiedAt.getTime())) {
    throw new Error(
      "GCS evidence metadata verifiedAt must be an ISO timestamp",
    );
  }
  const evidenceBase = safeRelativePathParts(
    metadata.evidenceBase,
    "evidenceBase",
  ).join("/");
  // Validate the bundle's own case-relative path now. A malicious path must
  // roll back both the logical artifact and its physical archive identity.
  archiveMemberPathFromArtifactPath(evidenceBase, artifact.path, "bundle path");
  const bucket = requireExactNonEmptyString(metadata.bucket, "bucket");
  const objectKey = safeRelativePathParts(metadata.objectKey, "objectKey").join(
    "/",
  );
  const storedSha256 = requirePattern(
    artifact.sha256,
    "artifact sha256",
    SHA256_PATTERN,
  );
  requireContentAddressedObjectKey(objectKey, storedSha256, "objectKey");
  const generation = requirePattern(
    metadata.generation,
    "generation",
    GCS_GENERATION_PATTERN,
  );
  const crc32c = requirePattern(metadata.crc32c, "crc32c", GCS_CRC32C_PATTERN);
  const uncompressedTarSha256 = requirePattern(
    metadata.uncompressedTarSha256,
    "uncompressedTarSha256",
    SHA256_PATTERN,
  );
  const uncompressedTarByteSize = requirePositiveSafeInteger(
    metadata.uncompressedTarByteSize,
    "uncompressedTarByteSize",
  );
  requirePositiveSafeInteger(artifact.byte_size, "artifact byte_size");
  const zstdLevel = requirePositiveSafeInteger(metadata.zstdLevel, "zstdLevel");
  if (zstdLevel > 22) {
    throw new Error("GCS evidence metadata zstdLevel must be at most 22");
  }
  const blobMetadata: Record<string, unknown> = {
    archiveFormat: "tar+zstd",
    zstdLevel,
  };
  return {
    bucket,
    objectKey,
    generation,
    crc32c,
    uncompressedTarSha256,
    uncompressedTarByteSize,
    verifiedAt,
    verifiedAtText,
    evidenceBase,
    zstdLevel,
    blobMetadata,
  };
}

function archiveMemberPathFromArtifactPath(
  evidenceBase: string,
  artifactPath: string,
  label = "artifact path",
): string {
  const baseParts = safeRelativePathParts(evidenceBase, "evidenceBase");
  const artifactParts = safeRelativePathParts(artifactPath, label);
  const withinBase = baseParts.every(
    (part, index) => artifactParts[index] === part,
  );
  const memberParts = artifactParts.slice(baseParts.length);
  if (!withinBase || memberParts.length === 0) {
    throw new Error(
      `GCS evidence ${label} must name a member below evidenceBase`,
    );
  }
  return memberParts.join("/");
}

function archiveMemberPathFromStoredArtifact(
  evidenceBase: string,
  storageKey: string,
): string {
  const baseParts = safeRelativePathParts(evidenceBase, "evidenceBase");
  const storedParts = safeRelativePathParts(storageKey, "stored artifact path");
  const offsets: number[] = [];
  for (let i = 0; i <= storedParts.length - baseParts.length; i++) {
    if (baseParts.every((part, index) => storedParts[i + index] === part)) {
      offsets.push(i);
    }
  }
  if (offsets.length !== 1) {
    throw new Error(
      "stored GCS evidence artifact path does not identify one unambiguous evidenceBase",
    );
  }
  const memberParts = storedParts.slice(offsets[0] + baseParts.length);
  if (memberParts.length === 0) {
    throw new Error(
      "stored GCS evidence artifact path names evidenceBase itself",
    );
  }
  return memberParts.join("/");
}

function finitePositiveNumber(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function mediaRoots(): string[] {
  return Array.from(
    new Set(
      [
        process.env.MEDIA_DIR,
        process.env.DATA_DIR,
        "/data/airfoilfoam",
        "data/airfoilfoam",
      ].filter((x): x is string => Boolean(x)),
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
      frameCount:
        finitePositiveNumber(stream.nb_read_frames) ??
        finitePositiveNumber(stream.nb_frames),
    };
  } catch {
    return {};
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyRenderedMediaBytes(
  storageKey: string,
  expectedSha256: string,
  expectedByteSize: number,
): Promise<void> {
  const full = await localMediaPath(storageKey);
  if (!full) {
    throw new Error(
      `rendered media is not readable on the shared volume: ${storageKey}`,
    );
  }
  const info = await stat(full);
  if (!info.isFile() || info.size !== expectedByteSize) {
    throw new Error(
      `rendered media byte-size mismatch for ${storageKey}: expected ${expectedByteSize}, found ${info.isFile() ? info.size : "non-file"}`,
    );
  }
  const actualSha256 = await sha256File(full);
  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error(
      `rendered media checksum mismatch for ${storageKey}: expected ${expectedSha256}, found ${actualSha256}`,
    );
  }
}

async function requireMediaRepairWriteFence(
  db: DB,
  fence: MediaRepairWriteFence,
  resultId: string,
  evidenceSha256: string,
): Promise<void> {
  // Serialize canonical result identity, current-manifest writes, and media
  // repair mutations before taking row locks. Every artifact producer that
  // can attach a manifest to a result acquires this same transaction lock.
  await acquireResultEvidenceLock(db, resultId);

  // Lock the canonical cell next, then the mutable repair row. The obligation
  // owns one immutable attempt directly; it never borrows public authority
  // from results.current_result_attempt_id.
  const [cell] = await db
    .select({
      id: results.id,
      revisionId: results.simulationPresetRevisionId,
    })
    .from(results)
    .where(eq(results.id, resultId))
    .for("update")
    .limit(1);
  const [attempt] = await db
    .select({
      resultId: resultAttempts.resultId,
      revisionId: resultAttempts.simulationPresetRevisionId,
      status: resultAttempts.status,
      source: resultAttempts.source,
      engineJobId: resultAttempts.engineJobId,
      engineCaseSlug: resultAttempts.engineCaseSlug,
    })
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, fence.resultAttemptId),
        eq(resultAttempts.resultId, resultId),
      ),
    )
    .limit(1);
  const expectedSignature = attempt
    ? `${attempt.engineJobId ?? ""}:${attempt.engineCaseSlug ?? ""}:${evidenceSha256}`
    : null;
  if (
    !cell ||
    !attempt ||
    attempt.revisionId !== cell.revisionId ||
    attempt.status !== "done" ||
    attempt.source !== "solved" ||
    expectedSignature !== fence.evidenceSignature
  ) {
    throw new Error(
      `result media repair exact-attempt fence lost for result ${resultId}`,
    );
  }
  const exactManifest = await manifestForAttempt(
    db,
    resultId,
    fence.resultAttemptId,
  );
  if (exactManifest?.sha256 !== evidenceSha256) {
    throw new Error(
      `result media repair exact-manifest fence lost for result ${resultId}`,
    );
  }
  const [owned] = await db
    .select({ id: resultMediaRepairs.id })
    .from(resultMediaRepairs)
    .where(
      sql`
      ${resultMediaRepairs.id} = ${fence.repairId}
      AND ${resultMediaRepairs.resultId} = ${resultId}
      AND ${resultMediaRepairs.resultAttemptId} = ${fence.resultAttemptId}
      AND ${resultMediaRepairs.state} = 'running'
      AND ${resultMediaRepairs.claimToken} = ${fence.claimToken}::uuid
      AND ${resultMediaRepairs.claimExpiresAt} > now()
      AND ${resultMediaRepairs.evidenceSignature} = ${fence.evidenceSignature}
    `,
    )
    .for("update")
    .limit(1);
  if (!owned) {
    throw new Error(
      `result media repair lease/evidence fence lost for result ${resultId}`,
    );
  }
}

async function registerMedia(
  db: DB,
  engine: EngineClient,
  resultId: string,
  resultAttemptId: string,
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
  evidence?: MediaRegistrationEvidence,
): Promise<void> {
  const storageKey = storageKeyOf(urlPath);
  if (evidence?.expectedSha256 != null || evidence?.expectedByteSize != null) {
    if (
      !evidence.expectedSha256 ||
      evidence.expectedByteSize == null ||
      !Number.isInteger(evidence.expectedByteSize) ||
      evidence.expectedByteSize <= 0
    ) {
      throw new Error(
        `rendered media identity is incomplete for ${storageKey}`,
      );
    }
    if (evidence.verifyExpectedBytes) {
      await verifyRenderedMediaBytes(
        storageKey,
        evidence.expectedSha256,
        evidence.expectedByteSize,
      );
    }
  }
  const video = kind === "video" ? await probeVideoMetadata(storageKey) : {};
  const values = {
    resultId,
    resultAttemptId,
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
    evidenceSha256: evidence?.evidenceSha256 ?? null,
    sha256: evidence?.expectedSha256 ?? null,
    byteSize: evidence?.expectedByteSize ?? null,
    engineUrl: `${engine.baseUrl}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`,
  };
  const write = async (writeDb: DB) => {
    const [inserted] = await writeDb
      .insert(resultMedia)
      .values(values)
      .onConflictDoNothing()
      .returning({ id: resultMedia.id });
    if (!inserted) {
      if (evidence?.preserveExistingAttemptMedia) return;
      await writeDb
        .update(resultMedia)
        .set({
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
          renderProfileKey:
            scale?.renderProfileKey ?? DEFAULT_RENDER_PROFILE_KEY,
          evidenceSha256: evidence?.evidenceSha256 ?? null,
          sha256: evidence?.expectedSha256 ?? null,
          byteSize: evidence?.expectedByteSize ?? null,
          engineUrl: `${engine.baseUrl}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`,
        })
        .where(
          and(
            eq(resultMedia.resultAttemptId, resultAttemptId),
            eq(resultMedia.kind, kind),
            sql`${resultMedia.field} IS NOT DISTINCT FROM ${field}`,
            eq(resultMedia.role, role),
            eq(
              resultMedia.renderProfileKey,
              scale?.renderProfileKey ?? DEFAULT_RENDER_PROFILE_KEY,
            ),
          ),
        );
    }
  };
  if (!evidence?.repairFence) {
    await write(db);
    return;
  }

  const fence = evidence.repairFence;
  await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await requireMediaRepairWriteFence(
      tx,
      fence,
      resultId,
      evidence.evidenceSha256,
    );
    await write(tx);
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
 *  because the later extents/render pass failed.
 *
 *  Exact attempts are immutable and a new solve owns a new attempt id, so an
 *  engine-terminal replay is insert-only: omitted fields do not delete prior
 *  exact associations, and an unavailable local file cannot weaken a stored
 *  sha256/byte_size to NULL. A complete scaled-render artifact may replace the
 *  shared identity later; unlike the shipped replay it always carries a full
 *  byte identity, and durable repair replacements additionally hold the live
 *  lease/evidence fence. */
async function registerShippedMedia(
  db: DB,
  engine: EngineClient,
  resultId: string,
  resultAttemptId: string,
  p: PolarPoint,
): Promise<number> {
  const groups: Array<{
    kind: "image" | "video";
    role: "instantaneous" | "mean";
    entries: Record<string, string>;
  }> = [
    { kind: "image", role: "instantaneous", entries: p.images ?? {} },
    { kind: "image", role: "mean", entries: p.mean_images ?? {} },
    { kind: "video", role: "instantaneous", entries: p.video ?? {} },
  ];
  let count = 0;
  for (const group of groups) {
    for (const [field, urlPath] of Object.entries(group.entries)) {
      if (!urlPath) continue;
      const storageKey = storageKeyOf(urlPath);
      const localPath = await localMediaPath(storageKey);
      const localIdentity = localPath
        ? await (async () => {
            const info = await stat(localPath);
            return info.isFile() && info.size > 0
              ? { sha256: await sha256File(localPath), byteSize: info.size }
              : null;
          })()
        : null;
      await registerMedia(
        db,
        engine,
        resultId,
        resultAttemptId,
        group.kind,
        group.role,
        field,
        urlPath,
        shippedMimeType(group.kind, urlPath),
        undefined,
        {
          evidenceSha256: evidenceShaFromPoint(p),
          expectedSha256: localIdentity?.sha256,
          expectedByteSize: localIdentity?.byteSize,
          preserveExistingAttemptMedia: true,
        },
      );
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
  return (
    p.converged === true && !stalledForPoint(p) && !p.error && hasCoefficients
  );
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
    console.error(
      `[sweeper] frame_track CONTRACT DRIFT (${context}): ${parsed.errors.join("; ")}`,
    );
  }
  return raw;
}

/** Fidelity tier to persist on the results row (ladder contract 1/3).
 *  Precedence: the engine's strict-parsed echo; else the tier the JOB
 *  requested (for URANS points of fidelity-requesting wave-2 jobs — with a
 *  loud drift log, because a post-ladder engine must echo); else the honest
 *  regime-derived tier matching the 0034 backfill semantics (pre-ladder
 *  engines: urans = full behavior, steady = rans). Exported for the pin test. */
export function fidelityForPoint(
  p: PolarPoint,
  requestedUransFidelity: UransFidelity | undefined,
  context: string,
): PointFidelity {
  const echoed = parsePointFidelity(p.fidelity);
  if (echoed) return echoed;
  if (p.unsteady && requestedUransFidelity) {
    console.error(
      `[sweeper] fidelity echo MISSING on URANS point of a '${requestedUransFidelity}'-fidelity job (${context}); persisting the requested tier — engine contract drift`,
    );
    return requestedUransFidelity === "precalc"
      ? "urans_precalc"
      : "urans_full";
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
    console.error(
      `[sweeper] steady_history CONTRACT DRIFT (${context}): ${parsed.errors.join("; ")}`,
    );
  }
  return raw;
}

/** Oscillating-steady quality marker (ladder contract 2): a steady point
 *  accepted through mean-stable oscillating averaging carries the honest
 *  note in quality_warnings — the marker every point-story surface already
 *  reads. Never duplicates an engine-shipped warning. Exported for tests. */
export const STEADY_OSCILLATING_MARKER = "steady-oscillating-mean";

function hasStableSteadyMean(p: PolarPoint): boolean {
  return Boolean(
    !p.unsteady &&
    p.steady_history &&
    typeof p.steady_history === "object" &&
    (p.steady_history as { mean_stable?: unknown }).mean_stable === true,
  );
}

export function qualityWarningsForPoint(p: PolarPoint): string[] | null {
  const warnings = [...(p.quality_warnings ?? [])];
  const history = p.steady_history;
  if (hasStableSteadyMean(p) && history && typeof history === "object") {
    const note =
      typeof (history as { note?: unknown }).note === "string" &&
      (history as { note: string }).note.trim()
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

/** Quality-warning marker prefix stamped on the ATTEMPT row when the
 *  released-cell guard quarantines a failed shipment (live gap 2026-07-08,
 *  campaign 495d78e0): an incoming FAILED point must never re-terminalize a
 *  cell its job no longer owns — the auto-retry-once pass (amendment B)
 *  releases a crashed cell back to pending mid-job, and the same job's later
 *  partial/terminal ingests re-ship the identical failed case. Exported for
 *  the must-catch tests. */
export const RELEASED_CELL_MARKER = "released-cell failure quarantined";

/** Classification states whose canonical row the replace guard protects.
 *  needs_urans is PROVISIONAL ACCEPTED evidence (it feeds the polar fit), so
 *  it is protected exactly like accepted — never treated as rejected. */
const REPLACE_GUARD_PROTECTED_STATES = new Set<string>([
  "accepted",
  "needs_urans",
]);

/** Evidence view of an INCOMING engine point, shaped exactly like the row the
 *  post-ingest classifier would load from the results table (polar-cache
 *  loadResultEvidence → toEvidence). Media-presence gates (hasVideo /
 *  hasForceHistory) evaluate against what the payload SHIPS — the same media
 *  that registerShippedMedia / the force-history upsert would persist for this
 *  row. Exported for the replace-guard tests. */
export function incomingPointEvidence(
  p: PolarPoint,
  derived: {
    fidelity: PointFidelity;
    frameTrack: unknown;
    steadyHistory: unknown;
    error: string | null;
  },
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
    failureDisposition: p.failure_disposition ?? null,
    finalResidual: p.final_residual ?? null,
    iterations: p.iterations ?? null,
    firstOrderFallback: p.first_order_fallback,
    validForPolar: validForPolarPoint(p),
    hasForceHistory: Boolean(p.force_history),
    hasVideo: Object.values(p.video ?? {}).some(Boolean),
    frameTrack: (derived.frameTrack ??
      null) as PolarEvidencePoint["frameTrack"],
    fidelity: derived.fidelity,
    steadyHistory: (derived.steadyHistory ??
      null) as PolarEvidencePoint["steadyHistory"],
    qualityWarnings: qualityWarningsForPoint(p),
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
  derived: {
    fidelity: PointFidelity;
    frameTrack: unknown;
    steadyHistory: unknown;
    error: string | null;
  },
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
  derived: {
    fidelity: PointFidelity;
    frameTrack: unknown;
    steadyHistory: unknown;
    error: string | null;
  };
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
    .leftJoin(
      resultClassifications,
      eq(resultClassifications.resultId, results.id),
    )
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
  if (!existing.state || !REPLACE_GUARD_PROTECTED_STATES.has(existing.state))
    return null;
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
  resultId: string;
  airfoilId: string;
  bcId: string;
  presetRevisionId?: string | null;
  simJobId: string;
  engineJobId: string;
  runtime: ResolvedEngineRuntime | null;
  point: PolarPoint;
  /** Worker-acknowledged mesh-recovery strategy for the physical job. This is
   * immutable execution evidence; the requested version alone is not proof
   * that a worker actually ran that strategy. */
  meshRecoveryVersion?: number | null;
  derived?: {
    fidelity: PointFidelity;
    frameTrack: unknown;
    steadyHistory: unknown;
    error: string | null;
  };
  /** Extra honest markers appended to the attempt's quality warnings (replace
   *  guard: "higher-tier attempt rejected: …"). Never duplicated. */
  extraQualityWarnings?: string[];
}): Promise<string | null> {
  const {
    db,
    resultId,
    airfoilId,
    bcId,
    presetRevisionId,
    simJobId,
    engineJobId,
    runtime,
    point: p,
    derived,
  } = opts;
  const stalled = stalledForPoint(p);
  const warnings = [...(qualityWarningsForPoint(p) ?? [])];
  for (const extra of opts.extraQualityWarnings ?? []) {
    if (!warnings.includes(extra)) warnings.push(extra);
  }
  const evidencePayload = {
    ...p,
    // Keep the immutable payload engine-owned. Job-level failure fallback and
    // local quarantine/replace annotations are scheduler context; a running
    // partial and terminal replay of the same engine case must compare equal.
    error: p.error ?? null,
    fidelity: derived?.fidelity ?? p.fidelity ?? null,
    frame_track: derived?.frameTrack ?? p.frame_track ?? null,
    steady_history: derived?.steadyHistory ?? p.steady_history ?? null,
    quality_warnings: qualityWarningsForPoint(p) ?? [],
    // This job-level acknowledgement was added after immutable attempt
    // payloads were already live. Keep absence as absence when the engine did
    // not acknowledge a version, so an ordinary deploy cannot rewrite the
    // identity of legacy evidence merely by adding a new optional null key.
    ...(opts.meshRecoveryVersion == null
      ? {}
      : { mesh_recovery_version: opts.meshRecoveryVersion }),
  };
  const [inserted] = await db
    .insert(resultAttempts)
    .values({
      resultId,
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
      methodKey: p.method_key ?? null,
      solverImplementationId: runtime?.solverImplementationId ?? null,
      solverRuntimeBuildId: runtime?.solverRuntimeBuildId ?? null,
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
      error: derived?.error ?? p.error ?? null,
      // Engine non-fatal quality warnings — persisted verbatim so the point
      // story timeline can show the honest "why" (empty list → NULL, absence
      // stays absence). The oscillating-steady mean-stable marker is appended
      // here too (ladder contract 2), plus any caller-supplied markers
      // (replace guard).
      qualityWarnings: warnings.length ? warnings : null,
      evidencePayload,
      solvedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [
        resultAttempts.simJobId,
        resultAttempts.engineJobId,
        resultAttempts.resultId,
        resultAttempts.aoaDeg,
        resultAttempts.regime,
      ],
    })
    .returning({ id: resultAttempts.id });
  if (inserted?.id) return inserted.id;
  const [existing] = await db
    .select({
      id: resultAttempts.id,
      resultId: resultAttempts.resultId,
      evidencePayload: resultAttempts.evidencePayload,
    })
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.simJobId, simJobId),
        eq(resultAttempts.engineJobId, engineJobId),
        eq(resultAttempts.resultId, resultId),
        eq(resultAttempts.aoaDeg, p.aoa_deg),
        eq(resultAttempts.regime, p.unsteady ? "urans" : "rans"),
      ),
    )
    .limit(1);
  if (!existing) return null;
  const existingPayload = existing.evidencePayload ?? null;
  const exactReplay =
    stableHash(existingPayload) === stableHash(evidencePayload);
  const sameLegacyUnacknowledgedVersion =
    unacknowledgedMeshRecoveryVersion(existingPayload) &&
    unacknowledgedMeshRecoveryVersion(evidencePayload) &&
    stableAttemptEvidenceHashWithoutMeshRecoveryVersion(existingPayload) ===
      stableAttemptEvidenceHashWithoutMeshRecoveryVersion(evidencePayload);
  const incomingMeshRecoveryVersion =
    acknowledgedMeshRecoveryVersion(evidencePayload);
  const enrichLegacyMeshRecoveryVersion =
    unacknowledgedMeshRecoveryVersion(existingPayload) &&
    incomingMeshRecoveryVersion != null &&
    stableAttemptEvidenceHashWithoutMeshRecoveryVersion(existingPayload) ===
      stableAttemptEvidenceHashWithoutMeshRecoveryVersion(evidencePayload);
  if (
    existing.resultId !== resultId ||
    (!exactReplay &&
      !sameLegacyUnacknowledgedVersion &&
      !enrichLegacyMeshRecoveryVersion)
  ) {
    throw new Error(
      `result attempt replay changed immutable evidence for ${simJobId}/${engineJobId}/a=${p.aoa_deg}/${p.unsteady ? "urans" : "rans"}`,
    );
  }
  if (enrichLegacyMeshRecoveryVersion) {
    // Rolling-deploy enrichment is one-way and compare-and-set. The exact
    // engine replay supplied a newly persisted job-level acknowledgement, but
    // every pre-existing point field already compared equal above. Add only
    // that evidence key. If another replay wins the race, require its complete
    // payload to equal ours; a competing version remains an immutable-evidence
    // violation.
    const [enriched] = await db
      .update(resultAttempts)
      .set({ evidencePayload })
      .where(
        and(
          eq(resultAttempts.id, existing.id),
          eq(resultAttempts.evidencePayload, existingPayload),
        ),
      )
      .returning({ id: resultAttempts.id });
    if (!enriched) {
      const [raced] = await db
        .select({ evidencePayload: resultAttempts.evidencePayload })
        .from(resultAttempts)
        .where(eq(resultAttempts.id, existing.id))
        .limit(1);
      if (
        !raced ||
        stableHash(raced.evidencePayload ?? null) !==
          stableHash(evidencePayload)
      ) {
        throw new Error(
          `result attempt replay changed immutable evidence for ${simJobId}/${engineJobId}/a=${p.aoa_deg}/${p.unsteady ? "urans" : "rans"}`,
        );
      }
    }
  }
  return existing.id;
}

type StoredEvidenceArtifact = typeof solverEvidenceArtifacts.$inferSelect;
type StoredEvidenceArchive = typeof solverEvidenceArchives.$inferSelect;

function artifactEvidenceBase(
  artifact: Pick<StoredEvidenceArtifact, "metadata">,
  expectedEvidenceBase: string,
): string {
  const actual = safeRelativePathParts(
    artifact.metadata?.evidenceBase,
    "artifact evidenceBase",
  ).join("/");
  if (actual !== expectedEvidenceBase) {
    throw new Error(
      "archive member evidenceBase does not match its exact engine_bundle",
    );
  }
  return actual;
}

async function registerArchiveMember(opts: {
  db: DB;
  archive: StoredEvidenceArchive;
  artifact: StoredEvidenceArtifact;
  evidenceBase: string;
  artifactPath?: string;
}): Promise<void> {
  if (!ARCHIVED_EVIDENCE_MEMBER_KINDS.has(opts.artifact.kind)) return;
  if (
    opts.artifact.resultId !== opts.archive.resultId ||
    opts.artifact.resultAttemptId !== opts.archive.resultAttemptId
  ) {
    throw new Error(
      "archive member does not belong to the archive's exact result attempt",
    );
  }
  artifactEvidenceBase(opts.artifact, opts.evidenceBase);
  const memberPath = opts.artifactPath
    ? archiveMemberPathFromArtifactPath(opts.evidenceBase, opts.artifactPath)
    : archiveMemberPathFromStoredArtifact(
        opts.evidenceBase,
        opts.artifact.storageKey,
      );
  const [inserted] = await opts.db
    .insert(solverEvidenceArtifactMembers)
    .values({
      archiveId: opts.archive.id,
      artifactId: opts.artifact.id,
      memberPath,
    })
    .onConflictDoNothing()
    .returning({
      archiveId: solverEvidenceArtifactMembers.archiveId,
      artifactId: solverEvidenceArtifactMembers.artifactId,
      memberPath: solverEvidenceArtifactMembers.memberPath,
    });
  if (inserted) return;
  const [existing] = await opts.db
    .select({
      archiveId: solverEvidenceArtifactMembers.archiveId,
      artifactId: solverEvidenceArtifactMembers.artifactId,
      memberPath: solverEvidenceArtifactMembers.memberPath,
    })
    .from(solverEvidenceArtifactMembers)
    .where(
      and(
        eq(solverEvidenceArtifactMembers.archiveId, opts.archive.id),
        eq(solverEvidenceArtifactMembers.artifactId, opts.artifact.id),
      ),
    )
    .limit(1);
  if (!existing || existing.memberPath !== memberPath) {
    throw new Error(
      `archive member path ${memberPath} conflicts with immutable evidence already registered for this archive`,
    );
  }
}

async function registerVerifiedGcsArchive(opts: {
  db: DB;
  resultId: string;
  resultAttemptId: string;
  sourceArtifact: StoredEvidenceArtifact;
  artifact: EngineEvidenceArtifact;
  bundle: VerifiedGcsEvidenceBundle;
}): Promise<StoredEvidenceArchive> {
  const [owner] = await opts.db
    .select({ id: resultAttempts.id })
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, opts.resultAttemptId),
        eq(resultAttempts.resultId, opts.resultId),
      ),
    )
    .limit(1);
  if (!owner) {
    throw new Error(
      `GCS engine_bundle attempt ${opts.resultAttemptId} does not own result ${opts.resultId}`,
    );
  }
  if (
    opts.sourceArtifact.kind !== "engine_bundle" ||
    opts.sourceArtifact.resultId !== opts.resultId ||
    opts.sourceArtifact.resultAttemptId !== opts.resultAttemptId
  ) {
    throw new Error(
      "GCS canonical archive source must be an exact owned engine_bundle artifact",
    );
  }

  const blobValues = {
    backend: "gcs" as const,
    bucket: opts.bundle.bucket,
    objectKey: opts.bundle.objectKey,
    generation: opts.bundle.generation,
    compression: "zstd" as const,
    mimeType: opts.artifact.mime_type,
    sha256: opts.artifact.sha256,
    byteSize: opts.artifact.byte_size,
    crc32c: opts.bundle.crc32c,
    uncompressedTarSha256: opts.bundle.uncompressedTarSha256,
    uncompressedTarByteSize: opts.bundle.uncompressedTarByteSize,
    verifiedAt: opts.bundle.verifiedAt,
    metadata: opts.bundle.blobMetadata,
  };
  const [insertedBlob] = await opts.db
    .insert(solverEvidenceBlobs)
    .values(blobValues)
    .onConflictDoNothing()
    .returning();
  let blob = insertedBlob;
  if (!blob) {
    [blob] = await opts.db
      .select()
      .from(solverEvidenceBlobs)
      .where(
        and(
          eq(solverEvidenceBlobs.backend, "gcs"),
          eq(solverEvidenceBlobs.bucket, opts.bundle.bucket),
          eq(solverEvidenceBlobs.objectKey, opts.bundle.objectKey),
          eq(solverEvidenceBlobs.generation, opts.bundle.generation),
        ),
      )
      .limit(1);
  }
  if (
    !blob ||
    blob.compression !== blobValues.compression ||
    blob.mimeType !== blobValues.mimeType ||
    blob.sha256 !== blobValues.sha256 ||
    blob.byteSize !== blobValues.byteSize ||
    blob.crc32c !== blobValues.crc32c ||
    blob.uncompressedTarSha256 !== blobValues.uncompressedTarSha256 ||
    blob.uncompressedTarByteSize !== blobValues.uncompressedTarByteSize ||
    stableHash(blob.metadata) !== stableHash(blobValues.metadata)
  ) {
    throw new Error(
      `GCS object gs://${opts.bundle.bucket}/${opts.bundle.objectKey}#${opts.bundle.generation} changed immutable blob metadata`,
    );
  }

  // `verifiedAt` records an observation, not physical object identity. Two
  // exact result attempts may legitimately reference the same immutable
  // content-addressed GCS generation after verifying it at different times.
  // Keep the first blob row's valid timestamp; every logical source artifact
  // still preserves its own verification timestamp in metadata.

  const [current] = await opts.db
    .select()
    .from(solverEvidenceArchives)
    .where(
      and(
        eq(solverEvidenceArchives.resultAttemptId, opts.resultAttemptId),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .limit(1);
  if (
    current &&
    (current.resultId !== opts.resultId ||
      current.sourceArtifactId !== opts.sourceArtifact.id ||
      current.blobId !== blob.id)
  ) {
    throw new Error(
      `exact attempt ${opts.resultAttemptId} already has a different current evidence archive; normal ingest cannot supersede it`,
    );
  }
  let archive = current;
  if (!archive) {
    [archive] = await opts.db
      .insert(solverEvidenceArchives)
      .values({
        resultId: opts.resultId,
        resultAttemptId: opts.resultAttemptId,
        sourceArtifactId: opts.sourceArtifact.id,
        blobId: blob.id,
        state: "current",
      })
      .returning();
  }
  if (!archive) {
    throw new Error(
      `failed to register current evidence archive for attempt ${opts.resultAttemptId}`,
    );
  }

  // The manifest normally arrives before the bundle. Backfill every already
  // registered logical member now; later artifacts take the same idempotent
  // path after their association is inserted.
  const existingArtifacts = await opts.db
    .select()
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, opts.resultId),
        eq(solverEvidenceArtifacts.resultAttemptId, opts.resultAttemptId),
      ),
    )
    .orderBy(solverEvidenceArtifacts.id);
  for (const existingArtifact of existingArtifacts) {
    await registerArchiveMember({
      db: opts.db,
      archive,
      artifact: existingArtifact,
      evidenceBase: opts.bundle.evidenceBase,
    });
  }
  return archive;
}

async function currentArchiveWithEvidenceBase(
  db: DB,
  resultId: string,
  resultAttemptId: string,
): Promise<{ archive: StoredEvidenceArchive; evidenceBase: string } | null> {
  const [archive] = await db
    .select()
    .from(solverEvidenceArchives)
    .where(
      and(
        eq(solverEvidenceArchives.resultId, resultId),
        eq(solverEvidenceArchives.resultAttemptId, resultAttemptId),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .limit(1);
  if (!archive) return null;
  const [source] = await db
    .select({ metadata: solverEvidenceArtifacts.metadata })
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.id, archive.sourceArtifactId),
        inArray(solverEvidenceArtifacts.kind, [
          "engine_bundle",
          "openfoam_bundle",
        ]),
        eq(solverEvidenceArtifacts.resultId, resultId),
        eq(solverEvidenceArtifacts.resultAttemptId, resultAttemptId),
      ),
    )
    .limit(1);
  if (!source) {
    throw new Error(
      `current archive ${archive.id} has no exact owned bundle source`,
    );
  }
  const evidenceBase = safeRelativePathParts(
    source.metadata?.evidenceBase,
    "archive source evidenceBase",
  ).join("/");
  return { archive, evidenceBase };
}

export async function registerEvidenceArtifacts(opts: {
  db: DB;
  engine: EngineClient;
  resultId?: string | null;
  resultAttemptId?: string | null;
  airfoilId: string;
  simJobId: string;
  engineJobId: string;
  point: PolarPoint;
  artifact: EngineEvidenceArtifact;
  runtime?: ResolvedEngineRuntime | null;
}): Promise<PendingRemoteEvidenceCleanup | null> {
  const {
    db,
    engine,
    resultId,
    resultAttemptId,
    airfoilId,
    simJobId,
    engineJobId,
    point,
    artifact,
    runtime,
  } = opts;
  const urlPath = artifact.url ?? artifact.path;
  if (!urlPath) return null;
  const storageKey = storageKeyOf(urlPath);
  const knownKinds = [
    "manifest",
    "engine_bundle",
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
  // The engine's shared-mesh bundle is genuine, immutable mesh evidence. The
  // database currently has the broader `mesh` enum rather than a separate
  // `mesh_evidence` enum, so retain it under that truthful parent kind and
  // preserve the engine's exact label in metadata for provenance.
  const originalKind = artifact.kind;
  const normalizedKind =
    originalKind === "mesh_evidence" ? "mesh" : originalKind;
  const kind = knownKinds.find((k) => k === normalizedKind);
  if (!kind) {
    // Loud skip instead of a pg enum error that would abort the WHOLE ingest:
    // one unknown artifact kind from a newer engine must not cost the point's
    // coefficients, media, and every other artifact.
    console.error(
      `[sweeper] evidence artifact kind "${artifact.kind}" unknown to this build — SKIPPED (job ${engineJobId}, case ${point.case_slug}, aoa ${point.aoa_deg}, path ${artifact.path})`,
    );
    return null;
  }
  const gcsBundle = parseVerifiedGcsEvidenceBundle(kind, artifact);
  if (gcsBundle && (!resultId || !resultAttemptId)) {
    throw new Error(
      "verified GCS engine_bundle evidence requires an exact result and result attempt owner",
    );
  }
  const write = async (
    writeDb: DB,
  ): Promise<PendingRemoteEvidenceCleanup | null> => {
    if (gcsBundle) {
      const [exactOwner] = await writeDb
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(
          and(
            eq(resultAttempts.id, resultAttemptId!),
            eq(resultAttempts.resultId, resultId!),
          ),
        )
        .limit(1);
      if (!exactOwner) {
        throw new Error(
          `GCS engine_bundle attempt ${resultAttemptId} does not own result ${resultId}`,
        );
      }
    }
    const association = {
      resultId: resultId ?? null,
      resultAttemptId: resultAttemptId ?? null,
      airfoilId,
      simJobId,
      engineJobId,
      engineCaseSlug: point.case_slug ?? null,
      methodKey: point.method_key ?? null,
      solverImplementationId: runtime?.solverImplementationId ?? null,
      solverRuntimeBuildId: runtime?.solverRuntimeBuildId ?? null,
      aoaDeg: point.aoa_deg,
      kind,
      field: artifact.field ?? null,
      role: artifact.role ?? null,
      storageKey,
      mimeType: artifact.mime_type,
      sha256: artifact.sha256,
      byteSize: artifact.byte_size,
      engineUrl: `${engine.baseUrl}${urlPath.startsWith("/") ? "" : "/"}${urlPath}`,
      metadata:
        originalKind === normalizedKind
          ? (artifact.metadata ?? {})
          : { ...(artifact.metadata ?? {}), engineArtifactKind: originalKind },
    };
    if (kind === "manifest" && resultAttemptId) {
      const existingManifests = await writeDb
        .select()
        .from(solverEvidenceArtifacts)
        .where(
          and(
            eq(solverEvidenceArtifacts.resultAttemptId, resultAttemptId),
            eq(solverEvidenceArtifacts.kind, "manifest"),
          ),
        )
        .orderBy(solverEvidenceArtifacts.id);
      if (existingManifests.length > 1) {
        throw new Error(
          `exact attempt ${resultAttemptId} already has ambiguous manifest evidence`,
        );
      }
      const existingManifest = existingManifests[0];
      if (existingManifest) {
        const exactReplay =
          existingManifest.resultId === association.resultId &&
          existingManifest.resultAttemptId === association.resultAttemptId &&
          existingManifest.airfoilId === association.airfoilId &&
          existingManifest.simJobId === association.simJobId &&
          existingManifest.engineJobId === association.engineJobId &&
          existingManifest.engineCaseSlug === association.engineCaseSlug &&
          existingManifest.methodKey === association.methodKey &&
          existingManifest.solverImplementationId ===
            association.solverImplementationId &&
          existingManifest.solverRuntimeBuildId ===
            association.solverRuntimeBuildId &&
          existingManifest.aoaDeg === association.aoaDeg &&
          existingManifest.field === association.field &&
          existingManifest.role === association.role &&
          existingManifest.storageKey === association.storageKey &&
          existingManifest.mimeType === association.mimeType &&
          existingManifest.sha256 === association.sha256 &&
          existingManifest.byteSize === association.byteSize &&
          existingManifest.engineUrl === association.engineUrl &&
          stableHash(existingManifest.metadata ?? {}) ===
            stableHash(association.metadata);
        if (!exactReplay) {
          throw new Error(
            `manifest replay changed immutable association metadata for attempt ${resultAttemptId}`,
          );
        }
        const currentArchive =
          resultId && resultAttemptId
            ? await currentArchiveWithEvidenceBase(
                writeDb,
                resultId,
                resultAttemptId,
              )
            : null;
        if (currentArchive) {
          await registerArchiveMember({
            db: writeDb,
            archive: currentArchive.archive,
            artifact: existingManifest,
            evidenceBase: currentArchive.evidenceBase,
            artifactPath: artifact.path,
          });
        }
        return null;
      }
    }
    const [inserted] = await writeDb
      .insert(solverEvidenceArtifacts)
      .values(association)
      // Content-addressed bytes are intentionally reusable across attempts
      // and results. Owner-scoped partial indexes make exact replay
      // idempotent while each new owner gets its own immutable association;
      // never relabel another attempt's row just because the bytes match.
      .onConflictDoNothing()
      .returning();
    let storedArtifact = inserted;
    if (!storedArtifact) {
      [storedArtifact] = await writeDb
        .select()
        .from(solverEvidenceArtifacts)
        .where(
          and(
            resultAttemptId
              ? eq(solverEvidenceArtifacts.resultAttemptId, resultAttemptId)
              : sql`${solverEvidenceArtifacts.resultAttemptId} IS NULL`,
            eq(solverEvidenceArtifacts.kind, kind),
            sql`${solverEvidenceArtifacts.field} IS NOT DISTINCT FROM ${association.field}`,
            sql`${solverEvidenceArtifacts.role} IS NOT DISTINCT FROM ${association.role}`,
            eq(solverEvidenceArtifacts.storageKey, storageKey),
            eq(solverEvidenceArtifacts.sha256, artifact.sha256),
          ),
        )
        .limit(1);
      if (
        !storedArtifact ||
        storedArtifact.resultId !== association.resultId ||
        storedArtifact.airfoilId !== association.airfoilId ||
        storedArtifact.simJobId !== association.simJobId ||
        storedArtifact.engineJobId !== association.engineJobId ||
        storedArtifact.engineCaseSlug !== association.engineCaseSlug ||
        storedArtifact.methodKey !== association.methodKey ||
        storedArtifact.solverImplementationId !==
          association.solverImplementationId ||
        storedArtifact.solverRuntimeBuildId !==
          association.solverRuntimeBuildId ||
        storedArtifact.aoaDeg !== association.aoaDeg ||
        storedArtifact.mimeType !== association.mimeType ||
        storedArtifact.byteSize !== association.byteSize ||
        storedArtifact.engineUrl !== association.engineUrl ||
        stableHash(storedArtifact.metadata ?? {}) !==
          stableHash(association.metadata)
      ) {
        throw new Error(
          `evidence artifact replay changed immutable association metadata for attempt ${resultAttemptId ?? "unbound"} (${kind}/${artifact.field ?? ""}/${artifact.role ?? ""})`,
        );
      }
    }
    if (!storedArtifact) {
      throw new Error("failed to register immutable evidence artifact");
    }

    if (gcsBundle) {
      const archive = await registerVerifiedGcsArchive({
        db: writeDb,
        resultId: resultId!,
        resultAttemptId: resultAttemptId!,
        sourceArtifact: storedArtifact,
        artifact,
        bundle: gcsBundle,
      });
      const metadata = artifact.metadata ?? {};
      const cleanupDisposition = metadata.localEvidenceDisposition;
      if (
        cleanupDisposition !==
          "remote-copy-plus-local-archive-pending-database-ack" &&
        cleanupDisposition !== "remote-only-pending-cleanup"
      ) {
        return null;
      }
      if (!point.case_slug) {
        throw new Error("GCS evidence cleanup requires an exact case_slug");
      }
      const bundledFileCount = requireNonnegativeSafeInteger(
        metadata.bundledFileCount,
        "bundledFileCount",
      );
      return {
        caseSlug: point.case_slug,
        evidenceBase: gcsBundle.evidenceBase,
        pointer: {
          schemaVersion: 1,
          format: "tar+zstd",
          bucket: gcsBundle.bucket,
          objectKey: gcsBundle.objectKey,
          generation: gcsBundle.generation,
          storedSha256: artifact.sha256,
          storedSize: artifact.byte_size,
          tarSha256: gcsBundle.uncompressedTarSha256,
          tarSize: gcsBundle.uncompressedTarByteSize,
          crc32c: gcsBundle.crc32c,
          zstdLevel: gcsBundle.zstdLevel,
          createdAt: gcsBundle.verifiedAtText,
        },
        bundledFileCount,
        associations: [
          {
            resultId: resultId!,
            resultAttemptId: resultAttemptId!,
            sourceArtifactId: storedArtifact.id,
            archiveId: archive.id,
          },
        ],
      };
    }

    if (
      resultId &&
      resultAttemptId &&
      ARCHIVED_EVIDENCE_MEMBER_KINDS.has(storedArtifact.kind)
    ) {
      const currentArchive = await currentArchiveWithEvidenceBase(
        writeDb,
        resultId,
        resultAttemptId,
      );
      if (currentArchive) {
        await registerArchiveMember({
          db: writeDb,
          archive: currentArchive.archive,
          artifact: storedArtifact,
          evidenceBase: currentArchive.evidenceBase,
          artifactPath: artifact.path,
        });
      }
    }
    return null;
  };
  return withEvidenceArtifactWriteLocks(
    db,
    {
      storageKey,
      sha256: artifact.sha256,
      incomingResultId: resultId ?? null,
    },
    write,
  );
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

function fieldScalePolicy(
  field: ImageFieldName,
): "sequential_zero" | "diverging_zero" {
  return field === "velocity_magnitude" ||
    field === "turbulent_kinetic_energy" ||
    field === "turbulent_viscosity"
    ? "sequential_zero"
    : "diverging_zero";
}

function normalizeScale(
  field: ImageFieldName,
  minValue: number,
  maxValue: number,
): { vmin: number; vmax: number; policy: string } {
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

function attemptEvidenceRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function unacknowledgedMeshRecoveryVersion(value: unknown): boolean {
  const record = attemptEvidenceRecord(value);
  return (
    record != null &&
    (!Object.hasOwn(record, "mesh_recovery_version") ||
      record.mesh_recovery_version === null)
  );
}

function acknowledgedMeshRecoveryVersion(value: unknown): number | null {
  const version = attemptEvidenceRecord(value)?.mesh_recovery_version;
  return typeof version === "number" &&
    Number.isSafeInteger(version) &&
    version >= 0
    ? version
    : null;
}

/** Hash every point-owned field while excluding only the additive job-level
 * mesh strategy acknowledgement introduced after legacy attempts were stored.
 * Callers use this only to prove an otherwise exact replay before a one-time
 * compare-and-set enrichment; numeric versions remain immutable afterwards. */
function stableAttemptEvidenceHashWithoutMeshRecoveryVersion(
  value: unknown,
): string {
  const record = attemptEvidenceRecord(value);
  if (!record) {
    return stableHash(value);
  }
  const normalized = { ...record };
  delete normalized.mesh_recovery_version;
  return stableHash(normalized);
}

function mergePendingRemoteEvidenceCleanup(
  target: Map<string, PendingRemoteEvidenceCleanup>,
  incoming: PendingRemoteEvidenceCleanup,
): void {
  // `evidenceBase` is only unique inside one exact case directory. Ordinary
  // batch jobs deliberately reuse names such as "evidence" for every case,
  // so cleanup identity must include both path components that the engine
  // endpoint binds to its contained directory.
  const cleanupKey = `${incoming.caseSlug}\0${incoming.evidenceBase}`;
  const existing = target.get(cleanupKey);
  if (!existing) {
    target.set(cleanupKey, incoming);
    return;
  }
  if (
    existing.bundledFileCount !== incoming.bundledFileCount ||
    stableHash(existing.pointer) !== stableHash(incoming.pointer)
  ) {
    throw new Error(
      `evidence cleanup ${incoming.caseSlug}/${incoming.evidenceBase} resolved to conflicting remote identities`,
    );
  }
  for (const association of incoming.associations) {
    const identity = stableHash(association);
    const duplicate = existing.associations.find(
      (candidate) => stableHash(candidate) === identity,
    );
    if (!duplicate) existing.associations.push(association);
  }
}

async function validateRemoteEvidenceCleanupCoverage(
  db: DB,
  cleanup: PendingRemoteEvidenceCleanup,
): Promise<void> {
  let commonManifestSetSha256: string | null = null;
  for (const association of cleanup.associations) {
    const [archive] = await db
      .select()
      .from(solverEvidenceArchives)
      .where(
        and(
          eq(solverEvidenceArchives.id, association.archiveId),
          eq(solverEvidenceArchives.resultId, association.resultId),
          eq(
            solverEvidenceArchives.resultAttemptId,
            association.resultAttemptId,
          ),
          eq(
            solverEvidenceArchives.sourceArtifactId,
            association.sourceArtifactId,
          ),
          eq(solverEvidenceArchives.state, "current"),
        ),
      )
      .limit(1);
    if (!archive) {
      throw new Error(
        `cleanup archive ${association.archiveId} is not the exact current archive for its result attempt`,
      );
    }
    const memberRows = await db
      .select({
        memberPath: solverEvidenceArtifactMembers.memberPath,
        artifactId: solverEvidenceArtifacts.id,
        kind: solverEvidenceArtifacts.kind,
        resultId: solverEvidenceArtifacts.resultId,
        resultAttemptId: solverEvidenceArtifacts.resultAttemptId,
        sha256: solverEvidenceArtifacts.sha256,
        byteSize: solverEvidenceArtifacts.byteSize,
      })
      .from(solverEvidenceArtifactMembers)
      .innerJoin(
        solverEvidenceArtifacts,
        eq(
          solverEvidenceArtifacts.id,
          solverEvidenceArtifactMembers.artifactId,
        ),
      )
      .where(
        eq(solverEvidenceArtifactMembers.archiveId, association.archiveId),
      );
    const manifestRows = memberRows.filter(
      (row) =>
        row.kind === "manifest" && row.memberPath === "evidence_manifest.json",
    );
    if (manifestRows.length !== 1) {
      throw new Error(
        `cleanup archive ${association.archiveId} must map one exact manifest; found ${manifestRows.length}`,
      );
    }
    const [manifestArtifact] = await db
      .select()
      .from(solverEvidenceArtifacts)
      .where(eq(solverEvidenceArtifacts.id, manifestRows[0]!.artifactId))
      .limit(1);
    if (!manifestArtifact) {
      throw new Error(
        "cleanup manifest artifact disappeared during validation",
      );
    }
    const manifestPath = await localMediaPath(manifestArtifact.storageKey);
    if (!manifestPath) {
      throw new Error(
        `retained evidence manifest is unavailable for cleanup archive ${association.archiveId}`,
      );
    }
    const manifestBytes = await readFile(manifestPath);
    const parsed = parseEvidenceManifest(manifestBytes);
    if (parsed.bundled.length !== cleanup.bundledFileCount) {
      throw new Error(
        `cleanup bundle count ${cleanup.bundledFileCount} does not match ${parsed.bundled.length} manifest members`,
      );
    }
    const expectedByPath = new Map(
      parsed.memberSet.map((entry) => [entry.path, entry]),
    );
    if (memberRows.length !== expectedByPath.size) {
      throw new Error(
        `cleanup archive ${association.archiveId} member coverage is incomplete: ${memberRows.length}/${expectedByPath.size}`,
      );
    }
    const seenPaths = new Set<string>();
    for (const row of memberRows) {
      if (
        row.resultId !== association.resultId ||
        row.resultAttemptId !== association.resultAttemptId
      ) {
        throw new Error(
          `cleanup archive ${association.archiveId} contains a foreign member association`,
        );
      }
      if (seenPaths.has(row.memberPath)) {
        throw new Error(
          `cleanup archive ${association.archiveId} maps duplicate member ${row.memberPath}`,
        );
      }
      seenPaths.add(row.memberPath);
      const expected = expectedByPath.get(row.memberPath);
      if (
        !expected ||
        expected.sha256 !== row.sha256 ||
        expected.byteSize !== row.byteSize
      ) {
        throw new Error(
          `cleanup archive ${association.archiveId} member ${row.memberPath} does not match the retained manifest`,
        );
      }
    }

    if (parsed.excluded.length) {
      const allAttemptArtifacts = await db
        .select()
        .from(solverEvidenceArtifacts)
        .where(
          and(
            eq(solverEvidenceArtifacts.resultId, association.resultId),
            eq(
              solverEvidenceArtifacts.resultAttemptId,
              association.resultAttemptId,
            ),
          ),
        );
      for (const excluded of parsed.excluded) {
        const matches = allAttemptArtifacts.filter((artifact) => {
          if (artifact.metadata?.evidenceBase !== cleanup.evidenceBase)
            return false;
          try {
            return (
              archiveMemberPathFromStoredArtifact(
                cleanup.evidenceBase,
                artifact.storageKey,
              ) === excluded.path
            );
          } catch {
            return false;
          }
        });
        if (
          matches.length !== 1 ||
          matches[0]!.sha256 !== excluded.sha256 ||
          matches[0]!.byteSize !== excluded.byteSize
        ) {
          throw new Error(
            `excluded manifest member ${excluded.path} is not exactly registered as a separate artifact`,
          );
        }
        if (memberRows.some((row) => row.artifactId === matches[0]!.id)) {
          throw new Error(
            `excluded manifest member ${excluded.path} must not authorize archive cleanup as a bundled member`,
          );
        }
      }
    }

    const manifestSetSha256 = manifestMemberSetSha256(parsed.memberSet);
    if (
      commonManifestSetSha256 !== null &&
      commonManifestSetSha256 !== manifestSetSha256
    ) {
      throw new Error(
        `evidenceBase ${cleanup.evidenceBase} has conflicting manifest member sets across database associations`,
      );
    }
    commonManifestSetSha256 = manifestSetSha256;
    association.memberAssociationCount = memberRows.length;
    association.manifestMemberSetSha256 = manifestSetSha256;
    association.memberAssociationsSha256 = databaseMemberAssociationsSha256(
      memberRows.map((row) => ({
        path: row.memberPath,
        artifactId: row.artifactId,
        sha256: row.sha256,
        byteSize: row.byteSize,
      })),
    );
  }
}

async function acknowledgeTerminalRemoteEvidenceCleanups(
  db: DB,
  engine: EngineClient,
  engineJobId: string,
  cleanups: Map<string, PendingRemoteEvidenceCleanup>,
): Promise<number> {
  try {
    let acknowledged = 0;
    for (const cleanup of [...cleanups.values()].sort(
      (a, b) =>
        a.caseSlug.localeCompare(b.caseSlug) ||
        a.evidenceBase.localeCompare(b.evidenceBase),
    )) {
      await validateRemoteEvidenceCleanupCoverage(db, cleanup);
      const response = await engine.finalizeRemoteEvidence(engineJobId, {
        case_slug: cleanup.caseSlug,
        evidence_base: cleanup.evidenceBase,
        remote: cleanup.pointer,
        database_associations: cleanup.associations.map((association) => {
          if (
            association.memberAssociationCount == null ||
            !association.memberAssociationsSha256 ||
            !association.manifestMemberSetSha256
          ) {
            throw new Error("cleanup member coverage was not attested");
          }
          return {
            result_id: association.resultId,
            result_attempt_id: association.resultAttemptId,
            source_artifact_id: association.sourceArtifactId,
            archive_id: association.archiveId,
            member_association_count: association.memberAssociationCount,
            member_associations_sha256: association.memberAssociationsSha256,
            manifest_member_set_sha256: association.manifestMemberSetSha256,
          };
        }),
      });
      if (
        !["complete", "no_local_bytes"].includes(response.state) ||
        response.evidence_base !== cleanup.evidenceBase ||
        response.association_count !== cleanup.associations.length ||
        !response.verification.startsWith(
          "archive+manifest+all-members-restore:",
        )
      ) {
        throw new Error(
          `engine returned an incomplete cleanup acknowledgement for ${cleanup.evidenceBase}`,
        );
      }
      acknowledged++;
    }
    return acknowledged;
  } catch (error) {
    throw new TerminalEvidenceCleanupPendingError(
      `terminal remote evidence cleanup pending: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function scaleGroupKey(
  airfoilId: string,
  presetRevisionId: string,
  field: ImageFieldName,
): ScaleGroupKey {
  return `${airfoilId}:${presetRevisionId}:${field}`;
}

function evidenceBaseFromPoint(point: PolarPoint): string | null {
  const manifest = point.evidence_artifacts?.find(
    (artifact) => artifact.kind === "manifest",
  );
  const base = manifest?.metadata?.evidenceBase;
  return typeof base === "string" && base.trim() ? base : null;
}

function evidenceShaFromPoint(point: PolarPoint): string {
  const manifest = point.evidence_artifacts?.find(
    (artifact) => artifact.kind === "manifest",
  );
  return manifest?.sha256 ?? stableHash(point.evidence_artifacts ?? []);
}

async function airfoilContourPoints(
  db: DB,
  airfoilId: string,
): Promise<[number, number][] | null> {
  const [row] = await db
    .select({ points: airfoils.points })
    .from(airfoils)
    .where(eq(airfoils.id, airfoilId))
    .limit(1);
  const points = row?.points as { x: number; y: number }[] | undefined;
  if (!points?.length) return null;
  return points.map((p) => [p.x, p.y]);
}

async function manifestForResult(
  db: DB,
  resultId: string,
): Promise<{ evidenceBase: string; sha256: string } | null> {
  const [owner] = await db
    .select({ attemptId: results.currentResultAttemptId })
    .from(results)
    .where(eq(results.id, resultId))
    .limit(1);
  if (!owner?.attemptId) return null;
  return manifestForAttempt(db, resultId, owner.attemptId);
}

async function manifestForAttempt(
  db: DB,
  resultId: string,
  resultAttemptId: string,
): Promise<{ evidenceBase: string; sha256: string } | null> {
  const manifests = await db
    .select({ artifact: solverEvidenceArtifacts })
    .from(solverEvidenceArtifacts)
    .where(
      and(
        eq(solverEvidenceArtifacts.resultId, resultId),
        eq(solverEvidenceArtifacts.resultAttemptId, resultAttemptId),
        eq(solverEvidenceArtifacts.kind, "manifest"),
      ),
    )
    .orderBy(desc(solverEvidenceArtifacts.createdAt));
  // One exact generation owns exactly one manifest. Ambiguity fails closed;
  // choosing the newest row would reintroduce generation rediscovery.
  if (manifests.length !== 1) return null;
  const artifact = manifests[0]?.artifact;
  const base =
    artifact?.metadata && typeof artifact.metadata === "object"
      ? (artifact.metadata as Record<string, unknown>).evidenceBase
      : null;
  return typeof base === "string" &&
    base.trim() &&
    artifact?.sha256 &&
    /^[a-f0-9]{64}$/i.test(artifact.sha256) &&
    artifact.byteSize > 0 &&
    artifact.storageKey.trim() &&
    artifact.mimeType.trim()
    ? { evidenceBase: base, sha256: artifact.sha256 }
    : null;
}

async function manifestEvidenceBaseForResult(
  db: DB,
  resultId: string,
): Promise<string | null> {
  return (await manifestForResult(db, resultId))?.evidenceBase ?? null;
}

function assertRenderedArtifact(
  media: RenderedDefaultMedia,
  expected: {
    field: ImageFieldName;
    kind: "image" | "video";
    role: "instantaneous" | "mean";
  },
): void {
  const cleanPath =
    typeof media.path === "string" ? media.path.replace(/^\/+/, "") : "";
  if (
    media.field !== expected.field ||
    media.kind !== expected.kind ||
    media.role !== expected.role ||
    typeof media.url !== "string" ||
    !media.url.trim() ||
    typeof media.path !== "string" ||
    !cleanPath ||
    !media.url.endsWith(`/${cleanPath}`) ||
    typeof media.mime_type !== "string" ||
    !media.mime_type.startsWith(`${expected.kind}/`) ||
    typeof media.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(media.sha256) ||
    typeof media.byte_size !== "number" ||
    !Number.isInteger(media.byte_size) ||
    media.byte_size <= 0
  ) {
    throw new Error(
      `incomplete default-media artifact for ${expected.field} (${expected.kind}/${expected.role})`,
    );
  }
}

/** Fail closed on a 200 response that omitted a requested default artifact.
 *  Every extent-backed field gets an instantaneous still. A transient or
 *  preliminary-URANS result additionally gets its mean still and real
 *  instantaneous video. */
function completeRenderedMediaForField(
  response: {
    images?: RenderedDefaultMedia[];
    mean_images?: RenderedDefaultMedia[];
    videos?: RenderedDefaultMedia[];
  },
  field: ImageFieldName,
  requiresVideo: boolean,
): RenderedDefaultMedia[] {
  const images = Array.isArray(response.images) ? response.images : [];
  const means = Array.isArray(response.mean_images) ? response.mean_images : [];
  const videos = Array.isArray(response.videos) ? response.videos : [];
  const instantaneous = images.find(
    (media) =>
      media.field === field &&
      media.kind === "image" &&
      media.role === "instantaneous",
  );
  if (!instantaneous) {
    throw new Error(
      `default-media response missing instantaneous image for ${field}`,
    );
  }
  assertRenderedArtifact(instantaneous, {
    field,
    kind: "image",
    role: "instantaneous",
  });
  const accepted = [instantaneous];
  if (!requiresVideo) return accepted;
  const mean = means.find(
    (media) =>
      media.field === field && media.kind === "image" && media.role === "mean",
  );
  if (!mean)
    throw new Error(`default-media response missing mean image for ${field}`);
  assertRenderedArtifact(mean, { field, kind: "image", role: "mean" });
  accepted.push(mean);
  const video = videos.find(
    (media) =>
      media.field === field &&
      media.kind === "video" &&
      media.role === "instantaneous",
  );
  if (!video)
    throw new Error(
      `default-media response missing instantaneous video for ${field}`,
    );
  assertRenderedArtifact(video, {
    field,
    kind: "video",
    role: "instantaneous",
  });
  accepted.push(video);
  return accepted;
}

async function renderScaledMediaRows(opts: {
  db: DB;
  engine: EngineClient;
  resultRows: (typeof results.$inferSelect)[];
  field: ImageFieldName;
  scale: {
    id: string;
    version: number;
    vmin: number;
    vmax: number;
    policy: string;
  };
  airfoilPoints: [number, number][];
  heartbeat: () => Promise<void>;
}): Promise<
  {
    resultId: string;
    resultAttemptId: string;
    evidenceSha256: string;
    media: RenderedDefaultMedia[];
  }[]
> {
  const rendered: {
    resultId: string;
    resultAttemptId: string;
    evidenceSha256: string;
    media: RenderedDefaultMedia[];
  }[] = [];
  for (const result of opts.resultRows) {
    if (
      !result.engineJobId ||
      !result.engineCaseSlug ||
      result.status !== "done" ||
      result.source !== "solved"
    )
      continue;
    if (!result.currentResultAttemptId) continue;
    // Invariant: no ingest code path may run >30 s without a heartbeat touch.
    // Each renderDefaultMedia call is a full engine render round-trip (video
    // re-encode included) — the longest single stretch of the ingest chain.
    await opts.heartbeat();
    const manifest = await manifestForAttempt(
      opts.db,
      result.id,
      result.currentResultAttemptId,
    );
    if (!manifest) continue;
    if (
      result.chord == null ||
      !Number.isFinite(result.chord) ||
      result.chord <= 0 ||
      result.speed == null ||
      !Number.isFinite(result.speed) ||
      result.speed <= 0
    ) {
      throw new Error(
        `default-media render refused for result ${result.id}: stored chord and flow speed must be finite and positive`,
      );
    }
    // Media requirements follow the measured physical regime, not the job
    // tier. A PRECALC transient that measures no shedding is published as a
    // steady-equivalent RANS point and its immutable engine manifest truthfully
    // expects instantaneous stills only. Requiring a video from that one-frame
    // VTK window creates an impossible repair obligation. Truly unsteady
    // evidence remains fail-closed on mean fields and real videos.
    const requiresTransientMedia = result.unsteady;
    const response = await opts.engine.renderDefaultMedia(result.engineJobId, {
      case_slug: result.engineCaseSlug,
      evidence_base: manifest.evidenceBase,
      airfoil_points: opts.airfoilPoints,
      chord: result.chord,
      speed: result.speed,
      fields: [opts.field],
      scales: {
        [opts.field]: { vmin: opts.scale.vmin, vmax: opts.scale.vmax },
      },
      unsteady: requiresTransientMedia,
      zoom_chords: 2,
      scale_version: opts.scale.version,
      render_profile_key: DEFAULT_RENDER_PROFILE_KEY,
    });
    rendered.push({
      resultId: result.id,
      resultAttemptId: result.currentResultAttemptId,
      evidenceSha256: manifest.sha256,
      media: completeRenderedMediaForField(
        response,
        opts.field,
        requiresTransientMedia,
      ),
    });
  }
  return rendered;
}

async function registerRenderedMediaSet(
  db: DB,
  engine: EngineClient,
  rows: {
    resultId: string;
    resultAttemptId: string;
    evidenceSha256: string;
    media: RenderedDefaultMedia[];
  }[],
  scale: {
    id: string;
    version: number;
    vmin: number;
    vmax: number;
    policy: string;
  },
  repairFence?: MediaRepairWriteFence,
): Promise<number> {
  let count = 0;
  for (const row of rows) {
    for (const media of row.media) {
      await registerMedia(
        db,
        engine,
        row.resultId,
        row.resultAttemptId,
        media.kind,
        media.role,
        media.field,
        media.url,
        media.mime_type,
        {
          colorScaleId: scale.id,
          colorScaleVersion: scale.version,
          vmin: scale.vmin,
          vmax: scale.vmax,
          policy: scale.policy,
          renderProfileKey: DEFAULT_RENDER_PROFILE_KEY,
        },
        {
          evidenceSha256: row.evidenceSha256,
          expectedSha256: media.sha256,
          expectedByteSize: media.byte_size,
          verifyExpectedBytes: Boolean(repairFence),
          repairFence,
        },
      );
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
  /** Durable repair owns a bounded attempt and must observe any field failure. */
  strict?: boolean;
  /** When present, every post-render media upsert is atomically fenced by the
   * live durable repair claim and current manifest identity. */
  repairFence?: MediaRepairWriteFence;
  /** Exact attempt projection for a durable repair. It may intentionally be
   * pointer-null until repaired evidence classifies publishable. */
  repairSource?: typeof results.$inferSelect;
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
          eq(
            resultFieldExtents.simulationPresetRevisionId,
            group.presetRevisionId,
          ),
          eq(resultFieldExtents.field, group.field),
          eq(resultFieldExtents.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
          sql`(
            EXISTS (
              SELECT 1 FROM results current_result
              WHERE current_result.id = ${resultFieldExtents.resultId}
                AND current_result.current_result_attempt_id = ${resultFieldExtents.resultAttemptId}
            )
            OR (
              ${opts.repairSource?.id ?? null}::uuid IS NOT NULL
              AND ${resultFieldExtents.resultId} = ${opts.repairSource?.id ?? null}::uuid
              AND ${resultFieldExtents.resultAttemptId} = ${opts.repairSource?.currentResultAttemptId ?? null}::uuid
            )
          )`,
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
          eq(
            fieldColorScales.simulationPresetRevisionId,
            group.presetRevisionId,
          ),
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
          eq(
            fieldColorScales.simulationPresetRevisionId,
            group.presetRevisionId,
          ),
          eq(fieldColorScales.field, group.field),
          eq(fieldColorScales.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
        ),
      )
      .orderBy(desc(fieldColorScales.version))
      .limit(1);

    if (
      active &&
      nearlyEqual(active.vmin, normalized.vmin) &&
      nearlyEqual(active.vmax, normalized.vmax)
    ) {
      let targets = await opts.db
        .select()
        .from(results)
        .where(inArray(results.id, Array.from(group.changedResultIds)));
      if (opts.repairSource) {
        targets = targets.map((target) =>
          target.id === opts.repairSource!.id ? opts.repairSource! : target,
        );
      }
      const rendered = await renderScaledMediaRows({
        db: opts.db,
        engine: opts.engine,
        resultRows: targets,
        field: group.field,
        scale: {
          id: active.id,
          version: active.version,
          vmin: active.vmin,
          vmax: active.vmax,
          policy: active.scalePolicy,
        },
        airfoilPoints: opts.airfoilPoints,
        heartbeat: opts.heartbeat,
      });
      mediaCount += await registerRenderedMediaSet(
        opts.db,
        opts.engine,
        rendered,
        {
          id: active.id,
          version: active.version,
          vmin: active.vmin,
          vmax: active.vmax,
          policy: active.scalePolicy,
        },
        opts.repairFence,
      );
      continue;
    }

    const nextVersion = (latest?.version ?? 0) + 1;
    const scaleValues = {
      airfoilId: group.airfoilId,
      simulationPresetRevisionId: group.presetRevisionId,
      field: group.field,
      renderProfileKey: DEFAULT_RENDER_PROFILE_KEY,
      scalePolicy: normalized.policy,
      vmin: normalized.vmin,
      vmax: normalized.vmax,
      evidenceSignature,
      status: "rebalancing" as const,
      version: nextVersion,
      active: false,
    };
    const insertScale = async (writeDb: DB) => {
      const [created] = await writeDb
        .insert(fieldColorScales)
        .values(scaleValues)
        .returning();
      if (!created) throw new Error("failed to create field color scale");
      return created;
    };
    const fenceResultId = opts.repairFence
      ? Array.from(group.changedResultIds)[0]
      : null;
    const fenceEvidenceSha256 = fenceResultId
      ? extents.find((extent) => extent.resultId === fenceResultId)
          ?.evidenceSha256
      : null;
    const scale = opts.repairFence
      ? await opts.db.transaction(async (rawTx) => {
          const tx = rawTx as unknown as DB;
          if (!fenceResultId || !fenceEvidenceSha256) {
            throw new Error(
              "durable media repair scale change has no owned evidence row",
            );
          }
          await requireMediaRepairWriteFence(
            tx,
            opts.repairFence!,
            fenceResultId,
            fenceEvidenceSha256,
          );
          return insertScale(tx);
        })
      : await insertScale(opts.db);

    // A durable repair claim owns exactly one result. Activating a new shared
    // scale makes every other result's old color_scale_id discoverably stale;
    // each receives its own fenced repair instead of writing several results
    // under one result's lease token.
    const allResultIds = opts.repairFence
      ? Array.from(group.changedResultIds)
      : Array.from(new Set(extents.map((row) => row.resultId)));
    let targets = await opts.db
      .select()
      .from(results)
      .where(inArray(results.id, allResultIds));
    if (opts.repairSource) {
      targets = targets.map((target) =>
        target.id === opts.repairSource!.id ? opts.repairSource! : target,
      );
    }
    try {
      const rendered = await renderScaledMediaRows({
        db: opts.db,
        engine: opts.engine,
        resultRows: targets,
        field: group.field,
        scale: {
          id: scale.id,
          version: scale.version,
          vmin: scale.vmin,
          vmax: scale.vmax,
          policy: scale.scalePolicy,
        },
        airfoilPoints: opts.airfoilPoints,
        heartbeat: opts.heartbeat,
      });
      await opts.db.transaction(async (tx) => {
        if (opts.repairFence) {
          if (!fenceResultId || !fenceEvidenceSha256) {
            throw new Error(
              "durable media repair scale activation has no owned evidence row",
            );
          }
          await requireMediaRepairWriteFence(
            tx as unknown as DB,
            opts.repairFence,
            fenceResultId,
            fenceEvidenceSha256,
          );
        }
        await tx
          .update(fieldColorScales)
          .set({ active: false })
          .where(
            and(
              eq(fieldColorScales.airfoilId, group.airfoilId),
              eq(
                fieldColorScales.simulationPresetRevisionId,
                group.presetRevisionId,
              ),
              eq(fieldColorScales.field, group.field),
              eq(fieldColorScales.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
              eq(fieldColorScales.active, true),
            ),
          );
        await tx
          .update(fieldColorScales)
          .set({ active: true, status: "active", activatedAt: new Date() })
          .where(eq(fieldColorScales.id, scale.id));
        mediaCount += await registerRenderedMediaSet(
          tx as unknown as DB,
          opts.engine,
          rendered,
          {
            id: scale.id,
            version: scale.version,
            vmin: scale.vmin,
            vmax: scale.vmax,
            policy: scale.scalePolicy,
          },
          opts.repairFence,
        );
      });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message.slice(0, 500)
          : String(error).slice(0, 500);
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
        .set({
          status: "failed",
          failureReason: reason,
          renderAttempts: sql`${fieldColorScales.renderAttempts} + 1`,
        })
        .where(eq(fieldColorScales.id, scale.id));
      if (opts.strict) throw error;
    }
  }
  return mediaCount;
}

/** Bounded cap on scale render attempts: the first attempt happens at ingest;
 *  the reconcile retry pass re-runs failed rows until the count reaches this. */
export const MAX_SCALE_RENDER_ATTEMPTS = 3;

export interface StoredResultMediaRepairOutcome {
  mediaCount: number;
  expectedFields: ImageFieldName[];
}

/**
 * Rebuild complete default media for one already-solved preliminary/unsteady
 * result without touching its immutable coefficients or raw evidence.
 *
 * Extents are recomputed from the stored manifest. A partial extent response
 * may not silently forget a field that prior evidence already exposed. Every
 * valid returned field is fed through the shared track-scale renderer, whose
 * response is fail-closed by `completeRenderedMediaForField`.
 */
export async function repairDefaultMediaForStoredResult(opts: {
  db: DB;
  engine: EngineClient;
  resultId: string;
  resultAttemptId: string;
  heartbeat?: () => Promise<void>;
  repairFence?: MediaRepairWriteFence;
}): Promise<StoredResultMediaRepairOutcome> {
  const heartbeat = opts.heartbeat ?? (() => touchHeartbeat(opts.db));
  const [result] = await opts.db
    .select()
    .from(results)
    .where(eq(results.id, opts.resultId))
    .limit(1);
  if (!result)
    throw new Error(`media-repair result ${opts.resultId} no longer exists`);
  const [attempt] = await opts.db
    .select()
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, opts.resultAttemptId),
        eq(resultAttempts.resultId, opts.resultId),
      ),
    )
    .limit(1);
  if (!attempt) {
    throw new Error(
      `media-repair attempt ${opts.resultAttemptId} no longer exists for result ${opts.resultId}`,
    );
  }
  if (attempt.status !== "done" || attempt.source !== "solved") {
    throw new Error(
      `media-repair attempt ${opts.resultAttemptId} is not done solved evidence`,
    );
  }
  if (
    !result.simulationPresetRevisionId ||
    attempt.simulationPresetRevisionId !== result.simulationPresetRevisionId ||
    attempt.airfoilId !== result.airfoilId
  ) {
    throw new Error(
      `media-repair attempt ${opts.resultAttemptId} does not own the result's immutable setup`,
    );
  }
  const currentAttemptId = attempt.id;
  const presetRevisionId = result.simulationPresetRevisionId;
  if (!attempt.engineJobId || !attempt.engineCaseSlug) {
    throw new Error(
      `media-repair attempt ${opts.resultAttemptId} has no saved engine job/case address`,
    );
  }
  if (!Number.isFinite(result.chord) || !result.chord || result.chord <= 0) {
    throw new Error(
      `media-repair result ${opts.resultId} has no valid reference chord`,
    );
  }
  if (
    !Number.isFinite(result.speed) ||
    result.speed == null ||
    result.speed <= 0
  ) {
    throw new Error(
      `media-repair result ${opts.resultId} has no valid flow speed`,
    );
  }
  const contour = await airfoilContourPoints(opts.db, result.airfoilId);
  if (!contour?.length) {
    throw new Error(
      `media-repair result ${opts.resultId} has no stored airfoil coordinates`,
    );
  }
  const manifest = await manifestForAttempt(
    opts.db,
    result.id,
    currentAttemptId,
  );
  if (!manifest) {
    throw new Error(
      `media-repair result ${opts.resultId} has no usable stored evidence manifest`,
    );
  }

  const priorExtents = await opts.db
    .select({ field: resultFieldExtents.field })
    .from(resultFieldExtents)
    .where(
      and(
        eq(resultFieldExtents.resultId, result.id),
        eq(resultFieldExtents.resultAttemptId, currentAttemptId),
        eq(resultFieldExtents.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
        eq(resultFieldExtents.evidenceSha256, manifest.sha256),
      ),
    );
  await heartbeat();
  const response = await opts.engine.computeFieldExtents(attempt.engineJobId, {
    case_slug: attempt.engineCaseSlug,
    evidence_base: manifest.evidenceBase,
    airfoil_points: contour,
    chord: result.chord,
    speed: result.speed,
    fields: ALL_IMAGE_FIELDS,
    zoom_chords: 2,
    max_frames: 220,
  });
  // The engine round-trip may be slow. Revalidate ownership immediately
  // before any destructive presentation write; a stale renderer may inspect
  // its response, but cannot delete media or replace current extents.
  await heartbeat();
  if (!response || !response.fields || typeof response.fields !== "object") {
    throw new Error("field-extents response was empty");
  }
  const validExtents = Object.entries(response.fields).filter(
    (
      entry,
    ): entry is [
      ImageFieldName,
      { min: number; max: number; finite_count: number },
    ] => {
      const [field, extent] = entry;
      return Boolean(
        isImageFieldName(field) &&
        extent &&
        Number.isFinite(extent.min) &&
        Number.isFinite(extent.max) &&
        Number.isInteger(extent.finite_count) &&
        extent.finite_count > 0,
      );
    },
  );
  if (!validExtents.length) {
    throw new Error(
      "field-extents response contained no evidence-backed fields",
    );
  }
  const freshFields = new Set(validExtents.map(([field]) => field));
  const omittedPrior = priorExtents
    .map((row) => row.field)
    .filter(isImageFieldName)
    .filter((field) => !freshFields.has(field));
  if (omittedPrior.length) {
    throw new Error(
      `field-extents response incomplete; omitted prior evidence-backed fields: ${omittedPrior.sort().join(", ")}`,
    );
  }

  const groups = new Map<ScaleGroupKey, ScaleGroup>();
  const writeFreshExtents = async (writeDb: DB) => {
    // Keep the prior valid presentation rows while the potentially long
    // renderer pass runs. Exact-identity upserts replace them only after each
    // new artifact's bytes verify; obsolete signatures are removed after the
    // complete replacement set is proven below. This avoids a public
    // accepted-pointer gap caused solely by destructive pre-render deletion.
    await writeDb
      .delete(resultFieldExtents)
      .where(
        and(
          eq(resultFieldExtents.resultId, result.id),
          eq(resultFieldExtents.resultAttemptId, currentAttemptId),
          eq(resultFieldExtents.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
          sql`${resultFieldExtents.evidenceSha256} IS DISTINCT FROM ${manifest.sha256}`,
        ),
      );
    for (const [field, extent] of validExtents) {
      await writeDb
        .insert(resultFieldExtents)
        .values({
          resultId: result.id,
          resultAttemptId: currentAttemptId,
          airfoilId: result.airfoilId,
          simulationPresetRevisionId: presetRevisionId,
          field,
          renderProfileKey: DEFAULT_RENDER_PROFILE_KEY,
          vmin: extent.min,
          vmax: extent.max,
          finiteCount: extent.finite_count,
          sourceTimeStart: response.window_start ?? null,
          sourceTimeEnd: response.window_end ?? null,
          evidenceSha256: manifest.sha256,
        })
        .onConflictDoUpdate({
          target: [
            resultFieldExtents.resultAttemptId,
            resultFieldExtents.field,
            resultFieldExtents.renderProfileKey,
          ],
          targetWhere: sql`${resultFieldExtents.resultAttemptId} IS NOT NULL`,
          set: {
            vmin: extent.min,
            vmax: extent.max,
            finiteCount: extent.finite_count,
            sourceTimeStart: response.window_start ?? null,
            sourceTimeEnd: response.window_end ?? null,
            evidenceSha256: manifest.sha256,
            updatedAt: new Date(),
          },
        });
    }
  };
  if (opts.repairFence) {
    await opts.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await requireMediaRepairWriteFence(
        tx,
        opts.repairFence!,
        result.id,
        manifest.sha256,
      );
      await writeFreshExtents(tx);
    });
  } else {
    await writeFreshExtents(opts.db);
  }

  for (const [field] of validExtents) {
    groups.set(scaleGroupKey(result.airfoilId, presetRevisionId, field), {
      airfoilId: result.airfoilId,
      presetRevisionId,
      field,
      changedResultIds: new Set([result.id]),
    });
  }

  const payload =
    attempt.evidencePayload && typeof attempt.evidencePayload === "object"
      ? (attempt.evidencePayload as Record<string, unknown>)
      : {};
  const repairSource: typeof results.$inferSelect = {
    ...result,
    currentResultAttemptId: currentAttemptId,
    status: attempt.status,
    source: attempt.source,
    regime: attempt.regime,
    cl: attempt.cl,
    cd: attempt.cd,
    cm: attempt.cm,
    clCd: attempt.clCd,
    clStd: attempt.clStd,
    cdStd: attempt.cdStd,
    cmStd: attempt.cmStd,
    stalled: attempt.stalled,
    unsteady: attempt.unsteady,
    converged: attempt.converged,
    finalResidual: attempt.finalResidual,
    iterations: attempt.iterations,
    yPlusAvg: attempt.yPlusAvg,
    yPlusMax: attempt.yPlusMax,
    nCells: attempt.nCells,
    firstOrderFallback: attempt.firstOrderFallback,
    strouhal: attempt.strouhal,
    error: attempt.error,
    qualityWarnings: attempt.qualityWarnings,
    frameTrack: payload.frame_track ?? payload.frameTrack ?? null,
    fidelity: typeof payload.fidelity === "string" ? payload.fidelity : null,
    steadyHistory: payload.steady_history ?? payload.steadyHistory ?? null,
    simJobId: attempt.simJobId,
    engineJobId: attempt.engineJobId,
    engineCaseSlug: attempt.engineCaseSlug,
    solvedAt: attempt.solvedAt,
  };

  const mediaCount = await rebalanceFieldScales({
    db: opts.db,
    engine: opts.engine,
    groups,
    airfoilPoints: contour,
    heartbeat,
    strict: true,
    repairFence: opts.repairFence,
    repairSource,
  });

  const mediaRows = await opts.db
    .select({
      field: resultMedia.field,
      kind: resultMedia.kind,
      role: resultMedia.role,
      storageKey: resultMedia.storageKey,
      mimeType: resultMedia.mimeType,
      evidenceSha256: resultMedia.evidenceSha256,
    })
    .from(resultMedia)
    .where(
      and(
        eq(resultMedia.resultId, result.id),
        eq(resultMedia.resultAttemptId, currentAttemptId),
        eq(resultMedia.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
      ),
    );
  const requiresVideo = attempt.unsteady;
  for (const field of freshFields) {
    const required: Array<{
      kind: "image" | "video";
      role: "instantaneous" | "mean";
    }> = [{ kind: "image", role: "instantaneous" }];
    if (requiresVideo) {
      required.push(
        { kind: "image", role: "mean" },
        { kind: "video", role: "instantaneous" },
      );
    }
    for (const expected of required) {
      const present = mediaRows.some(
        (media) =>
          media.field === field &&
          media.kind === expected.kind &&
          media.role === expected.role &&
          media.storageKey.trim().length > 0 &&
          media.mimeType.startsWith(`${expected.kind}/`) &&
          media.evidenceSha256 === manifest.sha256,
      );
      if (!present) {
        throw new Error(
          `media commit incomplete for ${field}: missing ${expected.kind}/${expected.role}`,
        );
      }
    }
  }
  const retireObsoleteMedia = async (writeDb: DB) => {
    await writeDb
      .delete(resultMedia)
      .where(
        and(
          eq(resultMedia.resultId, result.id),
          eq(resultMedia.resultAttemptId, currentAttemptId),
          eq(resultMedia.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
          sql`${resultMedia.evidenceSha256} IS DISTINCT FROM ${manifest.sha256}`,
        ),
      );
  };
  if (opts.repairFence) {
    await opts.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      await requireMediaRepairWriteFence(
        tx,
        opts.repairFence!,
        result.id,
        manifest.sha256,
      );
      await retireObsoleteMedia(tx);
    });
  } else {
    await retireObsoleteMedia(opts.db);
  }
  return { mediaCount, expectedFields: [...freshFields].sort() };
}

/** Re-prove crash-recovered default media against the actual shared-volume
 * bytes before classification or verification can settle. DB metadata alone
 * is not artifact evidence: a removed/truncated file invalidates its mutable
 * presentation row and reopens the bounded repair obligation. */
export async function verifyStoredDefaultMediaForResult(
  db: DB,
  resultId: string,
  resultAttemptId: string,
): Promise<number> {
  const [result] = await db
    .select()
    .from(results)
    .where(eq(results.id, resultId))
    .limit(1);
  if (!result?.simulationPresetRevisionId) {
    throw new Error(
      `media verification result ${resultId} has no immutable setup revision`,
    );
  }
  const [attempt] = await db
    .select()
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, resultAttemptId),
        eq(resultAttempts.resultId, resultId),
      ),
    )
    .limit(1);
  if (!attempt) {
    throw new Error(
      `media verification attempt ${resultAttemptId} no longer exists for result ${resultId}`,
    );
  }
  if (attempt.status !== "done" || attempt.source !== "solved") {
    throw new Error(
      `media verification attempt ${resultAttemptId} is not done solved evidence`,
    );
  }
  const manifest = await manifestForAttempt(db, resultId, resultAttemptId);
  if (!manifest) {
    throw new Error(
      `media verification attempt ${resultAttemptId} has no exact evidence manifest`,
    );
  }
  const extents = await db
    .select()
    .from(resultFieldExtents)
    .where(
      and(
        eq(resultFieldExtents.resultId, resultId),
        eq(resultFieldExtents.resultAttemptId, resultAttemptId),
        eq(resultFieldExtents.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
        eq(resultFieldExtents.evidenceSha256, manifest.sha256),
      ),
    );
  if (!extents.length) {
    throw new Error(
      `media verification result ${resultId} has no current default field extents`,
    );
  }
  const scales = await db
    .select()
    .from(fieldColorScales)
    .where(
      and(
        eq(fieldColorScales.airfoilId, result.airfoilId),
        eq(
          fieldColorScales.simulationPresetRevisionId,
          result.simulationPresetRevisionId,
        ),
        eq(fieldColorScales.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
        eq(fieldColorScales.active, true),
      ),
    );
  const mediaRows = await db
    .select()
    .from(resultMedia)
    .where(
      and(
        eq(resultMedia.resultId, resultId),
        eq(resultMedia.resultAttemptId, resultAttemptId),
        eq(resultMedia.renderProfileKey, DEFAULT_RENDER_PROFILE_KEY),
        eq(resultMedia.evidenceSha256, manifest.sha256),
      ),
    );
  const requiresTransientMedia = attempt.unsteady;
  let verified = 0;
  for (const extent of extents) {
    const scale = scales.find((candidate) => candidate.field === extent.field);
    if (!scale) {
      throw new Error(
        `media verification has no active color scale for ${extent.field}`,
      );
    }
    const required: Array<{
      kind: "image" | "video";
      role: "instantaneous" | "mean";
    }> = [{ kind: "image", role: "instantaneous" }];
    if (requiresTransientMedia) {
      required.push(
        { kind: "image", role: "mean" },
        { kind: "video", role: "instantaneous" },
      );
    }
    for (const expected of required) {
      const media = mediaRows.find(
        (candidate) =>
          candidate.field === extent.field &&
          candidate.kind === expected.kind &&
          candidate.role === expected.role &&
          candidate.colorScaleId === scale.id,
      );
      if (
        !media ||
        !media.sha256 ||
        !/^[a-f0-9]{64}$/i.test(media.sha256) ||
        media.byteSize == null ||
        media.byteSize <= 0
      ) {
        throw new Error(
          `media verification missing identity for ${extent.field} ${expected.kind}/${expected.role}`,
        );
      }
      const verifiedSha256 = media.sha256;
      const verifiedByteSize = media.byteSize;
      try {
        await verifyRenderedMediaBytes(
          media.storageKey,
          verifiedSha256,
          verifiedByteSize,
        );
      } catch (error) {
        // Mutable presentation metadata must not keep pointing at corrupt or
        // absent bytes. Delete this exact observed media identity inside the
        // revision refresh transaction: attempt/result reclassification,
        // selected-pointer withdrawal, and revision/compatibility cache
        // retirement then commit atomically with the deletion. The identity
        // predicates are a CAS guard against deleting a renderer's newer row.
        try {
          await refreshPolarCacheForRevision(
            db,
            result.airfoilId,
            result.simulationPresetRevisionId,
            {
              beforeEvidenceLoad: async (tx) => {
                await tx
                  .delete(resultMedia)
                  .where(
                    and(
                      eq(resultMedia.id, media.id),
                      eq(resultMedia.resultId, resultId),
                      eq(resultMedia.resultAttemptId, resultAttemptId),
                      eq(
                        resultMedia.renderProfileKey,
                        DEFAULT_RENDER_PROFILE_KEY,
                      ),
                      eq(resultMedia.evidenceSha256, manifest.sha256),
                      eq(resultMedia.storageKey, media.storageKey),
                      eq(resultMedia.sha256, verifiedSha256),
                      eq(resultMedia.byteSize, verifiedByteSize),
                    ),
                  );
              },
            },
          );
        } catch (refreshError) {
          const mediaError =
            error instanceof Error ? error.message : String(error);
          const invalidationError =
            refreshError instanceof Error
              ? refreshError.message
              : String(refreshError);
          throw new Error(
            `${mediaError}; atomic media invalidation failed: ${invalidationError}`,
          );
        }
        throw error;
      }
      verified++;
    }
  }
  return verified;
}

/** Re-attempt failed shared-scale renders (bounded). A scale row that failed
 *  its render at ingest time (e.g. one transient engine fetch failure) is
 *  retried here with FRESH extents: only latest-version failed rows are live
 *  rebalance intent — a later ingest that rebalanced the same scope created a
 *  newer version that already re-rendered every extents row, so older failed
 *  rows are dead history and stay untouched. Successful media repair refreshes
 *  the exact evidence-derived polar cache immediately; otherwise a row first
 *  classified `missing-urans-video` would remain rejected until unrelated
 *  evidence happened to land. Returns registered media count. */
export async function retryFailedScaleRenders(
  db: DB,
  engine: EngineClient,
  opts: {
    heartbeat?: () => Promise<void>;
    maxAttempts?: number;
    /** Optional deterministic scope for targeted repair/tests. Omitted in the
     * production reconcile loop, which intentionally scans every failed row. */
    scaleIds?: string[];
  } = {},
): Promise<{ mediaCount: number; dirtyLanes: CampaignLaneKey[] }> {
  const heartbeat = opts.heartbeat ?? (() => touchHeartbeat(db));
  const maxAttempts = opts.maxAttempts ?? MAX_SCALE_RENDER_ATTEMPTS;
  if (opts.scaleIds?.length === 0) return { mediaCount: 0, dirtyLanes: [] };
  const retryable = await db
    .select()
    .from(fieldColorScales)
    .where(
      and(
        eq(fieldColorScales.status, "failed"),
        lt(fieldColorScales.renderAttempts, maxAttempts),
        opts.scaleIds ? inArray(fieldColorScales.id, opts.scaleIds) : undefined,
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
  const refreshedScopes = new Map<
    string,
    { airfoilId: string; revisionId: string; resultIds: Set<string> }
  >();
  const dirtyLanes = new Map<string, CampaignLaneKey>();
  const rememberRendered = (
    scaleRow: typeof fieldColorScales.$inferSelect,
    rendered: Array<{ resultId: string; media: RenderedDefaultMedia[] }>,
  ) => {
    const ids = rendered
      .filter((row) => row.media.length > 0)
      .map((row) => row.resultId);
    if (!ids.length) return;
    const key = `${scaleRow.airfoilId}:${scaleRow.simulationPresetRevisionId}`;
    const scope = refreshedScopes.get(key) ?? {
      airfoilId: scaleRow.airfoilId,
      revisionId: scaleRow.simulationPresetRevisionId,
      resultIds: new Set<string>(),
    };
    for (const id of ids) scope.resultIds.add(id);
    refreshedScopes.set(key, scope);
  };
  for (const candidateScale of retryable) {
    if (!isImageFieldName(candidateScale.field)) continue;
    const field: ImageFieldName = candidateScale.field;
    // Invariant: no code path may run >30 s without a heartbeat touch — each
    // retry is a per-result engine render round-trip chain.
    await heartbeat();
    const airfoilPoints = await airfoilContourPoints(
      db,
      candidateScale.airfoilId,
    );
    if (!airfoilPoints) continue;
    const extents = await db
      .select()
      .from(resultFieldExtents)
      .where(
        and(
          eq(resultFieldExtents.airfoilId, candidateScale.airfoilId),
          eq(
            resultFieldExtents.simulationPresetRevisionId,
            candidateScale.simulationPresetRevisionId,
          ),
          eq(resultFieldExtents.field, candidateScale.field),
          eq(
            resultFieldExtents.renderProfileKey,
            candidateScale.renderProfileKey,
          ),
          sql`EXISTS (
            SELECT 1 FROM results current_result
            WHERE current_result.id = ${resultFieldExtents.resultId}
              AND current_result.current_result_attempt_id = ${resultFieldExtents.resultAttemptId}
          )`,
        ),
      );
    if (!extents.length) {
      // Nothing left to scale (results pruned since the failure): the pending
      // rebalance is moot and nothing references a never-activated row.
      await db
        .delete(fieldColorScales)
        .where(eq(fieldColorScales.id, candidateScale.id));
      continue;
    }
    const minValue = Math.min(...extents.map((row) => row.vmin));
    const maxValue = Math.max(...extents.map((row) => row.vmax));
    const normalized = normalizeScale(field, minValue, maxValue);
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
    const [active] = await db
      .select()
      .from(fieldColorScales)
      .where(
        and(
          eq(fieldColorScales.airfoilId, candidateScale.airfoilId),
          eq(
            fieldColorScales.simulationPresetRevisionId,
            candidateScale.simulationPresetRevisionId,
          ),
          eq(fieldColorScales.field, candidateScale.field),
          eq(
            fieldColorScales.renderProfileKey,
            candidateScale.renderProfileKey,
          ),
          eq(fieldColorScales.active, true),
        ),
      )
      .limit(1);
    const targets = await db
      .select()
      .from(results)
      .where(
        inArray(results.id, [...new Set(extents.map((row) => row.resultId))]),
      );
    // Fence the renderer before the first engine call. Two sweepers may have
    // selected the same failed row, but only one can transition failed →
    // rebalancing; a stale loser cannot later overwrite the winner's active
    // scale or failure state.
    const [scaleRow] = await db
      .update(fieldColorScales)
      .set({ status: "rebalancing" })
      .where(
        and(
          eq(fieldColorScales.id, candidateScale.id),
          eq(fieldColorScales.status, "failed"),
          lt(fieldColorScales.renderAttempts, maxAttempts),
        ),
      )
      .returning();
    if (!scaleRow) continue;
    try {
      if (
        active &&
        nearlyEqual(active.vmin, normalized.vmin) &&
        nearlyEqual(active.vmax, normalized.vmax)
      ) {
        // Extents drifted back to the ACTIVE scale since the failure: the
        // pending rebalance is moot — heal media at the active scale and
        // retire the never-activated failed row.
        const rendered = await renderScaledMediaRows({
          db,
          engine,
          resultRows: targets,
          field,
          scale: {
            id: active.id,
            version: active.version,
            vmin: active.vmin,
            vmax: active.vmax,
            policy: active.scalePolicy,
          },
          airfoilPoints,
          heartbeat,
        });
        const registered = await registerRenderedMediaSet(
          db,
          engine,
          rendered,
          {
            id: active.id,
            version: active.version,
            vmin: active.vmin,
            vmax: active.vmax,
            policy: active.scalePolicy,
          },
        );
        mediaCount += registered;
        if (registered > 0) {
          rememberRendered(scaleRow, rendered);
        }
        await db
          .delete(fieldColorScales)
          .where(eq(fieldColorScales.id, scaleRow.id));
        continue;
      }
      // Re-run the rebalance on the SAME version row with fresh values (no
      // version churn per retry — the version was already allocated).
      await db
        .update(fieldColorScales)
        .set({
          status: "rebalancing",
          scalePolicy: normalized.policy,
          vmin: normalized.vmin,
          vmax: normalized.vmax,
          evidenceSignature,
        })
        .where(eq(fieldColorScales.id, scaleRow.id));
      const rendered = await renderScaledMediaRows({
        db,
        engine,
        resultRows: targets,
        field,
        scale: {
          id: scaleRow.id,
          version: scaleRow.version,
          vmin: normalized.vmin,
          vmax: normalized.vmax,
          policy: normalized.policy,
        },
        airfoilPoints,
        heartbeat,
      });
      let registered = 0;
      await db.transaction(async (tx) => {
        await tx
          .update(fieldColorScales)
          .set({ active: false })
          .where(
            and(
              eq(fieldColorScales.airfoilId, scaleRow.airfoilId),
              eq(
                fieldColorScales.simulationPresetRevisionId,
                scaleRow.simulationPresetRevisionId,
              ),
              eq(fieldColorScales.field, scaleRow.field),
              eq(fieldColorScales.renderProfileKey, scaleRow.renderProfileKey),
              eq(fieldColorScales.active, true),
            ),
          );
        await tx
          .update(fieldColorScales)
          .set({
            active: true,
            status: "active",
            activatedAt: new Date(),
            failureReason: null,
          })
          .where(eq(fieldColorScales.id, scaleRow.id));
        registered = await registerRenderedMediaSet(
          tx as unknown as DB,
          engine,
          rendered,
          {
            id: scaleRow.id,
            version: scaleRow.version,
            vmin: normalized.vmin,
            vmax: normalized.vmax,
            policy: normalized.policy,
          },
        );
      });
      mediaCount += registered;
      if (registered > 0) {
        rememberRendered(scaleRow, rendered);
      }
      console.log(
        `[sweeper] scaled-media retry RECOVERED (airfoil ${scaleRow.airfoilId}, revision ${scaleRow.simulationPresetRevisionId}, field ${scaleRow.field}, scale v${scaleRow.version}, attempt ${scaleRow.renderAttempts + 1})`,
      );
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message.slice(0, 500)
          : String(error).slice(0, 500);
      const attempt = scaleRow.renderAttempts + 1;
      console.error(
        `[sweeper] scaled-media retry FAILED (airfoil ${scaleRow.airfoilId}, revision ${scaleRow.simulationPresetRevisionId}, field ${scaleRow.field}, scale v${scaleRow.version}, attempt ${attempt}/${maxAttempts}${attempt >= maxAttempts ? " — EXHAUSTED, no further retries" : ""}): ${reason}`,
      );
      await db
        .update(fieldColorScales)
        .set({
          status: "failed",
          failureReason: reason,
          renderAttempts: sql`${fieldColorScales.renderAttempts} + 1`,
        })
        .where(eq(fieldColorScales.id, scaleRow.id));
    }
  }
  for (const scope of refreshedScopes.values()) {
    await refreshPolarCacheForRevision(db, scope.airfoilId, scope.revisionId);
    if (!scope.resultIds.size) continue;
    const campaignOwners = (await db.execute(sql`
      SELECT DISTINCT p.campaign_id, campaign.status
      FROM sim_campaign_points p
      JOIN sim_campaigns campaign ON campaign.id = p.campaign_id
      WHERE p.result_id = ANY(${sql`ARRAY[${sql.join(
        [...scope.resultIds].map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`})
      ORDER BY p.campaign_id
    `)) as unknown as Array<{ campaign_id: string; status: string }>;
    const liveOwner = campaignOwners.find(
      (row) => row.status === "active" || row.status === "attention",
    );
    if (liveOwner || campaignOwners.length === 0) {
      await enqueuePrecalcVerifications(db, {
        airfoilId: scope.airfoilId,
        revisionId: scope.revisionId,
        campaignId: liveOwner?.campaign_id ?? null,
      });
    }
    const repairedResults = await db
      .select({
        id: results.id,
        aoaDeg: results.aoaDeg,
        status: results.status,
        regime: results.regime,
      })
      .from(results)
      .where(
        and(
          eq(results.airfoilId, scope.airfoilId),
          eq(results.simulationPresetRevisionId, scope.revisionId),
          inArray(results.id, [...scope.resultIds]),
        ),
      );
    for (const result of repairedResults) {
      if (result.status !== "done" && result.status !== "failed") continue;
      const lanes = await onResultIngested(db, {
        airfoilId: scope.airfoilId,
        revisionId: scope.revisionId,
        aoaDeg: result.aoaDeg,
        resultId: result.id,
        status: result.status,
        regime: result.regime,
      });
      for (const lane of lanes) dirtyLanes.set(laneKeyId(lane), lane);
    }
  }
  return { mediaCount, dirtyLanes: [...dirtyLanes.values()] };
}

type StagedPoint = {
  airfoilId: string;
  bcId: string;
  presetRevisionId: string | null;
  resultId: string;
  resultAttemptId: string;
  point: PolarPoint;
  derived: {
    fidelity: PointFidelity;
    frameTrack: unknown;
    steadyHistory: unknown;
    error: string | null;
  };
  reynolds: number;
  speed: number;
  chord: number;
  mach: number | null;
  simJobId: string;
  engineJobId: string;
  ingestLeaseToken: string | null;
  observedCurrentAttemptId: string | null;
  observedStatus: string;
  observedSimJobId: string | null;
  quarantined: boolean;
};

type FinalizedPoint = {
  resultId: string;
  aoaDeg: number;
  status: "done" | "failed";
  regime: "rans" | "urans" | null;
  resultAttemptId: string | null;
  simJobId: string | null;
};

function fidelityRank(value: unknown): number {
  return value === "urans_full"
    ? 3
    : value === "urans_precalc"
      ? 2
      : value === "rans"
        ? 1
        : 0;
}

function classificationRank(value: unknown): number {
  return value === "accepted" ? 2 : value === "needs_urans" ? 1 : 0;
}

/** A stale canonical cell may still retain the exact parent RANS generation
 * that caused a durable PRECALC obligation. The obligation is the correction
 * authority for its URANS child, so stale must remain publishable alongside
 * terminal done/failed cells. Running/queued/pending cells still require
 * exact scheduling ownership and cannot be bypassed by this correction path. */
function correctionEligibleCellStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "stale";
}

/** Public for the exact-generation precedence regression: classification
 * improvement always wins (accepted evidence is stronger than provisional),
 * while equal-state corrections may only move fidelity forward. */
export function shouldPublishGeneration(input: {
  hasCurrent: boolean;
  candidateState: unknown;
  currentState: unknown;
  candidateFidelity: unknown;
  currentFidelity: unknown;
}): boolean {
  if (!input.hasCurrent) return classificationRank(input.candidateState) > 0;
  const candidateState = classificationRank(input.candidateState);
  const currentState = classificationRank(input.currentState);
  return (
    candidateState > currentState ||
    (candidateState === currentState &&
      candidateState > 0 &&
      fidelityRank(input.candidateFidelity) >=
        fidelityRank(input.currentFidelity))
  );
}

function payloadField<T>(
  payload: unknown,
  snake: string,
  camel: string,
): T | null {
  if (!payload || typeof payload !== "object") return null;
  const row = payload as Record<string, unknown>;
  return (row[snake] ?? row[camel] ?? null) as T | null;
}

/**
 * A correction/verification job may legitimately publish over a terminal
 * generation without first rewriting the canonical result's scheduling
 * owner. Prove that authority from the durable physical-work ledger; a parent
 * link or matching display values alone are never sufficient.
 */
async function incomingJobPublicationAuthority(
  db: DB,
  input: {
    simJobId: string;
    engineJobId: string;
    ingestLeaseToken?: string | null;
    airfoilId: string;
    revisionId: string | null;
    bcId: string;
    aoaDeg: number;
  },
  opts: { lock?: boolean } = {},
): Promise<{ jobValid: boolean; correctionAuthority: boolean }> {
  if (!input.revisionId) return { jobValid: false, correctionAuthority: false };
  const lock = opts.lock ? sql`FOR SHARE OF incoming` : sql``;
  const [job] = (await db.execute(sql`
    SELECT incoming.id,
           incoming.request_payload AS "requestPayload"
    FROM sim_jobs incoming
    WHERE incoming.id = ${input.simJobId}
      AND incoming.airfoil_id = ${input.airfoilId}
      -- Ordinary jobs own one pinned revision directly. A batched campaign
      -- job deliberately stores only its min-Re compatibility anchor in the
      -- scalar column; every other pinned member must prove its exact
      -- revision + boundary-condition tuple from the persisted conditionMap.
      AND (
        incoming.simulation_preset_revision_id = ${input.revisionId}
        OR incoming.request_payload -> 'conditionMap' @>
          jsonb_build_array(jsonb_build_object(
            'revisionId', ${input.revisionId}::text,
            'bcId', ${input.bcId}::text
          ))
      )
      AND incoming.engine_job_id = ${input.engineJobId}
      AND (
        (
          ${input.ingestLeaseToken ?? null}::text IS NOT NULL
          AND incoming.status = 'ingesting'
          AND incoming.ingest_lease_token = ${input.ingestLeaseToken ?? null}
          AND incoming.ingest_lease_expires_at > now()
        )
        OR (
          ${input.ingestLeaseToken ?? null}::text IS NULL
          AND incoming.status IN ('submitted', 'running', 'failed')
        )
      )
    LIMIT 1
    ${lock}
  `)) as unknown as Array<{
    id: string;
    requestPayload: Record<string, unknown> | null;
  }>;
  if (!job) return { jobValid: false, correctionAuthority: false };

  const payload = job.requestPayload ?? {};
  const verifyQueueItemId =
    typeof payload.verifyQueueItemId === "string"
      ? payload.verifyQueueItemId
      : null;
  if (verifyQueueItemId) {
    const ownerLock = opts.lock ? sql`FOR SHARE OF verify` : sql``;
    const rows = (await db.execute(sql`
      SELECT verify.id
      FROM sim_urans_verify_queue verify
      WHERE verify.id::text = ${verifyQueueItemId}
        AND verify.sim_job_id = ${input.simJobId}
        AND verify.airfoil_id = ${input.airfoilId}
        AND verify.revision_id = ${input.revisionId}
        AND verify.aoa_deg = ${input.aoaDeg}
        AND verify.state = 'running'
      LIMIT 1
      ${ownerLock}
    `)) as unknown as Array<{ id: string }>;
    return { jobValid: true, correctionAuthority: rows.length === 1 };
  }

  const uransRequestId =
    typeof payload.uransRequestId === "string" ? payload.uransRequestId : null;
  if (uransRequestId) {
    const ownerLock = opts.lock ? sql`FOR SHARE OF request` : sql``;
    const rows = (await db.execute(sql`
      SELECT request.id
      FROM sim_urans_requests request
      WHERE request.id::text = ${uransRequestId}
        AND request.sim_job_id = ${input.simJobId}
        AND request.airfoil_id = ${input.airfoilId}
        AND request.revision_id = ${input.revisionId}
        AND (request.aoa_deg IS NULL OR request.aoa_deg = ${input.aoaDeg})
        AND request.state = 'running'
      LIMIT 1
      ${ownerLock}
    `)) as unknown as Array<{ id: string }>;
    return { jobValid: true, correctionAuthority: rows.length === 1 };
  }

  const ownerLock = opts.lock ? sql`FOR SHARE OF obligation` : sql``;
  const rows = (await db.execute(sql`
    SELECT obligation.id
    FROM sim_precalc_obligations obligation
    WHERE obligation.latest_sim_job_id = ${input.simJobId}
      AND obligation.airfoil_id = ${input.airfoilId}
      AND obligation.revision_id = ${input.revisionId}
      AND obligation.aoa_deg = ${input.aoaDeg}
      AND obligation.state = 'running'
    ORDER BY obligation.id
    LIMIT 1
    ${ownerLock}
  `)) as unknown as Array<{ id: string }>;
  return { jobValid: true, correctionAuthority: rows.length === 1 };
}

/** Create only the scheduling shell needed to keep this in-flight engine cell
 * non-claimable. Existing canonical/public evidence is never overwritten at
 * this boundary; all solver fields remain owned by the immutable attempt until
 * the revision-locked publication transaction below. */
async function ensureIngestCell(opts: {
  db: DB;
  airfoilId: string;
  bcId: string;
  presetRevisionId: string | null;
  aoaDeg: number;
  simJobId: string;
  engineJobId: string;
  ingestLeaseToken?: string | null;
  reynolds: number;
  speed: number;
  chord: number;
  mach: number | null;
}): Promise<{
  id: string;
  currentAttemptId: string | null;
  status: string;
  simJobId: string | null;
  quarantined: boolean;
}> {
  const [created] = await opts.db
    .insert(results)
    .values({
      airfoilId: opts.airfoilId,
      bcId: opts.bcId,
      simulationPresetRevisionId: opts.presetRevisionId,
      aoaDeg: opts.aoaDeg,
      // Running + job ownership prevents a gap scan from claiming a second
      // solve while potentially slow evidence/media staging is in progress.
      status: "running",
      source: "queued",
      simJobId: opts.simJobId,
      reynolds: opts.reynolds,
      speed: opts.speed,
      chord: opts.chord,
      mach: opts.mach,
      priority: 0,
    })
    .onConflictDoNothing({
      target: [
        results.airfoilId,
        results.simulationPresetRevisionId,
        results.aoaDeg,
      ],
    })
    .returning({
      id: results.id,
      currentAttemptId: results.currentResultAttemptId,
      status: results.status,
      simJobId: results.simJobId,
    });
  let row =
    created ??
    (
      await opts.db
        .select({
          id: results.id,
          currentAttemptId: results.currentResultAttemptId,
          status: results.status,
          simJobId: results.simJobId,
        })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, opts.airfoilId),
            opts.presetRevisionId
              ? eq(results.simulationPresetRevisionId, opts.presetRevisionId)
              : sql`${results.simulationPresetRevisionId} IS NULL`,
            eq(results.aoaDeg, opts.aoaDeg),
          ),
        )
        .limit(1)
    )[0];
  if (!row)
    throw new Error(`failed to allocate ingest cell at a=${opts.aoaDeg}`);
  let differentOwner = row.simJobId !== opts.simJobId;
  const publicationAuthority = differentOwner
    ? await incomingJobPublicationAuthority(opts.db, {
        simJobId: opts.simJobId,
        engineJobId: opts.engineJobId,
        ingestLeaseToken: opts.ingestLeaseToken,
        airfoilId: opts.airfoilId,
        revisionId: opts.presetRevisionId,
        bcId: opts.bcId,
        aoaDeg: opts.aoaDeg,
      })
    : null;

  // Capability recovery may resume a durable PRECALC obligation whose old
  // scheduling shell was released before the replacement child was composed.
  // The shell has no solver truth and no owner, but INSERT ... DO NOTHING
  // cannot attach the live job to it. Reclaim that shell only when the exact
  // obligation ledger says this ingesting job is its current running owner.
  // The CAS keeps a stale/replayed job from stealing a concurrently claimed
  // cell, while terminal or selected generations remain correction-only.
  const reclaimableReleasedShell =
    differentOwner &&
    row.simJobId === null &&
    row.currentAttemptId === null &&
    ["pending", "queued", "stale"].includes(row.status) &&
    publicationAuthority?.jobValid === true &&
    publicationAuthority.correctionAuthority === true;
  if (reclaimableReleasedShell) {
    const [claimed] = await opts.db
      .update(results)
      .set({
        bcId: opts.bcId,
        status: "running",
        source: "queued",
        simJobId: opts.simJobId,
        engineJobId: opts.engineJobId,
        reynolds: opts.reynolds,
        speed: opts.speed,
        chord: opts.chord,
        mach: opts.mach,
        priority: 0,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(results.id, row.id),
          sql`${results.simJobId} IS NULL`,
          sql`${results.currentResultAttemptId} IS NULL`,
          inArray(results.status, ["pending", "queued", "stale"]),
        ),
      )
      .returning({
        id: results.id,
        currentAttemptId: results.currentResultAttemptId,
        status: results.status,
        simJobId: results.simJobId,
      });
    if (claimed) return { ...claimed, quarantined: false };

    // A concurrent scheduler/publication won the CAS. Re-read and apply the
    // ordinary owner/correction guard to that actual state.
    const [reloaded] = await opts.db
      .select({
        id: results.id,
        currentAttemptId: results.currentResultAttemptId,
        status: results.status,
        simJobId: results.simJobId,
      })
      .from(results)
      .where(eq(results.id, row.id))
      .limit(1);
    if (!reloaded)
      throw new Error(`ingest cell disappeared at a=${opts.aoaDeg}`);
    row = reloaded;
    differentOwner = row.simJobId !== opts.simJobId;
  }
  const authorizedCorrection =
    differentOwner &&
    correctionEligibleCellStatus(row.status) &&
    publicationAuthority?.correctionAuthority === true;
  return {
    ...row,
    // Late output from a job that no longer owns the cell remains exact
    // history only, even if the prior owner already left it terminal. A real
    // correction/retry claim must first put the cell under its own simJobId;
    // terminal status alone is not authority to overwrite selected evidence.
    quarantined: differentOwner && !authorizedCorrection,
  };
}

async function stageForceHistory(
  db: DB,
  resultId: string,
  resultAttemptId: string,
  p: PolarPoint,
): Promise<void> {
  if (!p.force_history) return;
  const fh = p.force_history;
  await db
    .insert(forceHistory)
    .values({
      resultId,
      resultAttemptId,
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
      target: forceHistory.resultAttemptId,
      targetWhere: sql`${forceHistory.resultAttemptId} IS NOT NULL`,
      set: {
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
      },
    });
}

async function currentTerminalState(
  tx: DB,
  resultId: string,
): Promise<FinalizedPoint | null> {
  const [row] = await tx
    .select({
      resultId: results.id,
      aoaDeg: results.aoaDeg,
      status: results.status,
      regime: results.regime,
      resultAttemptId: results.currentResultAttemptId,
      simJobId: results.simJobId,
    })
    .from(results)
    .where(eq(results.id, resultId))
    .limit(1);
  return row && (row.status === "done" || row.status === "failed")
    ? (row as FinalizedPoint)
    : null;
}

/** Select one staged exact generation under the same revision lock and SQL
 * transaction that rebuilds the canonical classification and fitted polar.
 * The observed pointer + scheduling owner form the CAS: a stale writer may
 * remain history but cannot publish over a newer generation or re-claimed
 * cell. */
async function publishStagedPoints(
  db: DB,
  airfoilId: string,
  revisionId: string,
  candidates: StagedPoint[],
): Promise<FinalizedPoint[]> {
  const finalized = new Map<string, FinalizedPoint>();
  await refreshPolarCacheForRevision(db, airfoilId, revisionId, {
    afterAttemptClassifications: async (tx) => {
      for (const candidate of [...candidates].sort((a, b) =>
        a.resultId.localeCompare(b.resultId),
      )) {
        if (candidate.quarantined) continue;
        // Global writer order is job -> physical ledger -> result. Holding
        // SHARE locks through the pointer update makes lease recovery,
        // cancellation, and owner replacement serialize with publication.
        const authority = await incomingJobPublicationAuthority(
          tx,
          {
            simJobId: candidate.simJobId,
            engineJobId: candidate.engineJobId,
            ingestLeaseToken: candidate.ingestLeaseToken,
            airfoilId: candidate.airfoilId,
            revisionId: candidate.presetRevisionId,
            bcId: candidate.bcId,
            aoaDeg: candidate.point.aoa_deg,
          },
          { lock: true },
        );
        if (!authority.jobValid) {
          console.error(
            "[sweeper] RELEASED-CELL GUARD: publication lease/engine authority expired " +
              `(sim_job ${candidate.simJobId}, engine ${candidate.engineJobId}, ` +
              `aoa ${candidate.point.aoa_deg}, result ${candidate.resultId}); exact attempt retained as history only`,
          );
          continue;
        }
        const [cell] = await tx
          .select({
            id: results.id,
            currentAttemptId: results.currentResultAttemptId,
            status: results.status,
            simJobId: results.simJobId,
          })
          .from(results)
          .where(eq(results.id, candidate.resultId))
          .for("update")
          .limit(1);
        if (!cell) continue;
        const casMatches =
          cell.currentAttemptId === candidate.observedCurrentAttemptId &&
          cell.status === candidate.observedStatus &&
          cell.simJobId === candidate.observedSimJobId;
        if (!casMatches) {
          const terminal = await currentTerminalState(tx, candidate.resultId);
          if (terminal) finalized.set(terminal.resultId, terminal);
          continue;
        }
        const ownsCurrentCell =
          cell.simJobId === candidate.simJobId ||
          (correctionEligibleCellStatus(cell.status) &&
            authority.correctionAuthority);
        if (!ownsCurrentCell) {
          console.error(
            `[sweeper] RELEASED-CELL GUARD: publication authority expired (sim_job ${candidate.simJobId}, case ${candidate.point.case_slug ?? "?"}, aoa ${candidate.point.aoa_deg}, result ${candidate.resultId}); exact attempt retained as history only`,
          );
          continue;
        }

        const [candidateAttempt] = await tx
          .select()
          .from(resultAttempts)
          .where(
            and(
              eq(resultAttempts.id, candidate.resultAttemptId),
              eq(resultAttempts.resultId, candidate.resultId),
            ),
          )
          .limit(1);
        if (!candidateAttempt) continue;
        const [candidateClassification] = await tx
          .select({
            state: resultClassifications.state,
            reasons: resultClassifications.reasons,
          })
          .from(resultClassifications)
          .where(
            eq(
              resultClassifications.resultAttemptId,
              candidate.resultAttemptId,
            ),
          )
          .limit(1);
        const candidateStateRank = classificationRank(
          candidateClassification?.state,
        );
        const candidateFidelity = payloadField<string>(
          candidateAttempt.evidencePayload,
          "fidelity",
          "fidelity",
        );
        const hasManifest = await hasExactValidSolverManifest(
          tx,
          candidate.resultId,
          candidate.resultAttemptId,
        );
        let currentStateRank = 0;
        let currentFidelityRank = 0;
        if (cell.currentAttemptId) {
          const [currentAttempt] = await tx
            .select({ evidencePayload: resultAttempts.evidencePayload })
            .from(resultAttempts)
            .where(
              and(
                eq(resultAttempts.id, cell.currentAttemptId),
                eq(resultAttempts.resultId, candidate.resultId),
              ),
            )
            .limit(1);
          const [currentClassification] = await tx
            .select({ state: resultClassifications.state })
            .from(resultClassifications)
            .where(
              eq(resultClassifications.resultAttemptId, cell.currentAttemptId),
            )
            .limit(1);
          currentStateRank = classificationRank(currentClassification?.state);
          currentFidelityRank = fidelityRank(
            payloadField<string>(
              currentAttempt?.evidencePayload,
              "fidelity",
              "fidelity",
            ),
          );
        }
        const eligible = hasManifest && candidateStateRank > 0;
        const outranksCurrent = shouldPublishGeneration({
          hasCurrent: Boolean(cell.currentAttemptId),
          candidateState: candidateClassification?.state,
          currentState:
            currentStateRank === 2
              ? "accepted"
              : currentStateRank === 1
                ? "needs_urans"
                : null,
          candidateFidelity,
          currentFidelity:
            currentFidelityRank === 3
              ? "urans_full"
              : currentFidelityRank === 2
                ? "urans_precalc"
                : currentFidelityRank === 1
                  ? "rans"
                  : null,
        });

        if (eligible && outranksCurrent) {
          const payload = candidateAttempt.evidencePayload;
          const [published] = await tx
            .update(results)
            .set({
              currentResultAttemptId: candidate.resultAttemptId,
              bcId: candidate.bcId,
              status: candidateAttempt.status,
              source: candidateAttempt.source,
              regime: candidateAttempt.regime,
              methodKey: candidateAttempt.methodKey,
              solverImplementationId: candidateAttempt.solverImplementationId,
              solverRuntimeBuildId: candidateAttempt.solverRuntimeBuildId,
              reynolds: candidate.reynolds,
              speed: candidate.speed,
              chord: candidate.chord,
              mach: candidate.mach,
              cl: candidateAttempt.cl,
              cd: candidateAttempt.cd,
              cm: candidateAttempt.cm,
              clCd: candidateAttempt.clCd,
              clStd: candidateAttempt.clStd,
              cdStd: candidateAttempt.cdStd,
              cmStd: candidateAttempt.cmStd,
              stalled: candidateAttempt.stalled,
              unsteady: candidateAttempt.unsteady,
              converged: candidateAttempt.converged,
              finalResidual: candidateAttempt.finalResidual,
              iterations: candidateAttempt.iterations,
              yPlusAvg: candidateAttempt.yPlusAvg,
              yPlusMax: candidateAttempt.yPlusMax,
              nCells: candidateAttempt.nCells,
              firstOrderFallback: candidateAttempt.firstOrderFallback,
              strouhal: candidateAttempt.strouhal,
              error: candidateAttempt.error,
              qualityWarnings: candidateAttempt.qualityWarnings,
              frameTrack: payloadField(payload, "frame_track", "frameTrack"),
              fidelity: candidateFidelity,
              steadyHistory: payloadField(
                payload,
                "steady_history",
                "steadyHistory",
              ),
              engineJobId: candidateAttempt.engineJobId,
              engineCaseSlug: candidateAttempt.engineCaseSlug,
              simJobId: candidateAttempt.simJobId,
              solvedAt: candidateAttempt.solvedAt,
              priority: 0,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(results.id, candidate.resultId),
                sql`${results.currentResultAttemptId} IS NOT DISTINCT FROM ${candidate.observedCurrentAttemptId}::uuid`,
                eq(results.status, candidate.observedStatus as never),
                sql`${results.simJobId} IS NOT DISTINCT FROM ${candidate.observedSimJobId}::uuid`,
              ),
            )
            .returning({
              resultId: results.id,
              aoaDeg: results.aoaDeg,
              status: results.status,
              regime: results.regime,
              resultAttemptId: results.currentResultAttemptId,
              simJobId: results.simJobId,
            });
          if (published && published.status === "done") {
            finalized.set(published.resultId, published as FinalizedPoint);
          }
          continue;
        }

        if (!cell.currentAttemptId) {
          const reasons = candidateClassification?.reasons ?? [];
          const reason = hasManifest
            ? reasons.length
              ? `solver evidence rejected: ${reasons.join(", ")}`
              : "solver evidence rejected by the polar classifier"
            : "solver evidence unavailable: exact manifest is missing or ambiguous";
          const [failedProjection] = await tx
            .update(results)
            .set({
              status: "failed",
              source: "queued",
              regime: candidateAttempt.regime,
              methodKey: candidateAttempt.methodKey,
              solverImplementationId: candidateAttempt.solverImplementationId,
              solverRuntimeBuildId: candidateAttempt.solverRuntimeBuildId,
              reynolds: candidate.reynolds,
              speed: candidate.speed,
              chord: candidate.chord,
              mach: candidate.mach,
              cl: candidateAttempt.cl,
              cd: candidateAttempt.cd,
              cm: candidateAttempt.cm,
              clCd: candidateAttempt.clCd,
              clStd: candidateAttempt.clStd,
              cdStd: candidateAttempt.cdStd,
              cmStd: candidateAttempt.cmStd,
              stalled: candidateAttempt.stalled,
              unsteady: candidateAttempt.unsteady,
              converged: candidateAttempt.converged,
              finalResidual: candidateAttempt.finalResidual,
              iterations: candidateAttempt.iterations,
              yPlusAvg: candidateAttempt.yPlusAvg,
              yPlusMax: candidateAttempt.yPlusMax,
              nCells: candidateAttempt.nCells,
              firstOrderFallback: candidateAttempt.firstOrderFallback,
              strouhal: candidateAttempt.strouhal,
              error:
                candidate.derived.error ?? candidateAttempt.error ?? reason,
              qualityWarnings: candidateAttempt.qualityWarnings,
              frameTrack: payloadField(
                candidateAttempt.evidencePayload,
                "frame_track",
                "frameTrack",
              ),
              fidelity: candidateFidelity,
              steadyHistory: payloadField(
                candidateAttempt.evidencePayload,
                "steady_history",
                "steadyHistory",
              ),
              engineJobId: candidateAttempt.engineJobId,
              engineCaseSlug: candidateAttempt.engineCaseSlug,
              simJobId: candidateAttempt.simJobId,
              solvedAt: candidateAttempt.solvedAt,
              priority: 0,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(results.id, candidate.resultId),
                sql`${results.currentResultAttemptId} IS NULL`,
                eq(results.status, candidate.observedStatus as never),
                sql`${results.simJobId} IS NOT DISTINCT FROM ${candidate.observedSimJobId}::uuid`,
              ),
            )
            .returning({
              resultId: results.id,
              aoaDeg: results.aoaDeg,
              status: results.status,
              regime: results.regime,
              resultAttemptId: results.currentResultAttemptId,
              simJobId: results.simJobId,
            });
          if (failedProjection) {
            finalized.set(failedProjection.resultId, {
              ...failedProjection,
              resultAttemptId: candidate.resultAttemptId,
              simJobId: candidate.simJobId,
            } as FinalizedPoint);
          }
          continue;
        }

        // A rejected/lower-fidelity child settles against the kept selected
        // generation, never against the incoming failed attempt.
        console.error(
          `[sweeper] REPLACE GUARD: exact attempt ${candidate.resultAttemptId} was not publishable (${candidateClassification?.state ?? "unclassified"}${candidateClassification?.reasons?.length ? `: ${candidateClassification.reasons.join(", ")}` : ""}); kept selected generation ${cell.currentAttemptId} on result ${candidate.resultId}`,
        );
        let terminal = await currentTerminalState(tx, candidate.resultId);
        if (!terminal && cell.currentAttemptId) {
          const [selectedAttempt] = await tx
            .select()
            .from(resultAttempts)
            .where(
              and(
                eq(resultAttempts.id, cell.currentAttemptId),
                eq(resultAttempts.resultId, candidate.resultId),
              ),
            )
            .limit(1);
          if (selectedAttempt) {
            const payload = selectedAttempt.evidencePayload;
            const [restored] = await tx
              .update(results)
              .set({
                status: selectedAttempt.status,
                source: selectedAttempt.source,
                regime: selectedAttempt.regime,
                methodKey: selectedAttempt.methodKey,
                solverImplementationId: selectedAttempt.solverImplementationId,
                solverRuntimeBuildId: selectedAttempt.solverRuntimeBuildId,
                cl: selectedAttempt.cl,
                cd: selectedAttempt.cd,
                cm: selectedAttempt.cm,
                clCd: selectedAttempt.clCd,
                clStd: selectedAttempt.clStd,
                cdStd: selectedAttempt.cdStd,
                cmStd: selectedAttempt.cmStd,
                stalled: selectedAttempt.stalled,
                unsteady: selectedAttempt.unsteady,
                converged: selectedAttempt.converged,
                finalResidual: selectedAttempt.finalResidual,
                iterations: selectedAttempt.iterations,
                yPlusAvg: selectedAttempt.yPlusAvg,
                yPlusMax: selectedAttempt.yPlusMax,
                nCells: selectedAttempt.nCells,
                firstOrderFallback: selectedAttempt.firstOrderFallback,
                strouhal: selectedAttempt.strouhal,
                error: selectedAttempt.error,
                qualityWarnings: selectedAttempt.qualityWarnings,
                frameTrack: payloadField(payload, "frame_track", "frameTrack"),
                fidelity: payloadField(payload, "fidelity", "fidelity"),
                steadyHistory: payloadField(
                  payload,
                  "steady_history",
                  "steadyHistory",
                ),
                engineJobId: selectedAttempt.engineJobId,
                engineCaseSlug: selectedAttempt.engineCaseSlug,
                simJobId: selectedAttempt.simJobId,
                solvedAt: selectedAttempt.solvedAt,
                priority: 0,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(results.id, candidate.resultId),
                  eq(results.currentResultAttemptId, cell.currentAttemptId),
                  eq(results.status, candidate.observedStatus as never),
                  sql`${results.simJobId} IS NOT DISTINCT FROM ${candidate.observedSimJobId}::uuid`,
                ),
              )
              .returning({
                resultId: results.id,
                aoaDeg: results.aoaDeg,
                status: results.status,
                regime: results.regime,
                resultAttemptId: results.currentResultAttemptId,
                simJobId: results.simJobId,
              });
            if (restored && restored.status === "done") {
              terminal = restored as FinalizedPoint;
            }
          }
        }
        if (terminal) finalized.set(terminal.resultId, terminal);
      }
    },
  });
  return [...finalized.values()];
}

/** Publish an exact media-repair owner only after its repaired attempt has
 * reclassified accepted/provisional inside the revision-locked cache refresh.
 * A concurrent different current generation normally wins. The sole
 * exception is an exact final-verification media repair, either still pending
 * or incident-fenced after bounded repair exhaustion: accepted PRECALC
 * intentionally remains current while the FULL attempt lacks media, and may
 * be replaced only after that exact FULL attempt becomes accepted. */
export async function publishRepairedResultAttempt(opts: {
  db: DB;
  resultId: string;
  resultAttemptId: string;
  repairId: string;
  evidenceSignature: string;
}): Promise<boolean> {
  const [scope] = await opts.db
    .select({
      airfoilId: results.airfoilId,
      revisionId: results.simulationPresetRevisionId,
    })
    .from(results)
    .where(eq(results.id, opts.resultId))
    .limit(1);
  if (!scope?.revisionId) return false;

  let published = false;
  await refreshPolarCacheForRevision(
    opts.db,
    scope.airfoilId,
    scope.revisionId,
    {
      afterAttemptClassifications: async (tx) => {
        // The polar advisory is already held by refreshPolarCacheForRevision.
        // Observe the pointer first, lock any exact FINAL queue authorization,
        // then lock/revalidate the result row. This matches every ladder
        // projection's polar -> queue -> result order and removes the former
        // result -> queue inversion.
        const [observedCell] = await tx
          .select({
            currentAttemptId: results.currentResultAttemptId,
            status: results.status,
          })
          .from(results)
          .where(eq(results.id, opts.resultId))
          .limit(1);
        if (
          !observedCell ||
          ["pending", "queued", "running", "stale"].includes(
            observedCell.status,
          )
        ) {
          return;
        }
        let exactFinalRepairReplacement = false;
        if (
          observedCell.currentAttemptId !== null &&
          observedCell.currentAttemptId !== opts.resultAttemptId
        ) {
          const [authorization] = (await tx.execute(sql`
            SELECT verify_item.id
            FROM sim_urans_verify_queue verify_item
            JOIN result_attempts repaired_attempt
              ON repaired_attempt.id = verify_item.latest_result_attempt_id
             AND repaired_attempt.id = ${opts.resultAttemptId}
             AND repaired_attempt.result_id = ${opts.resultId}
             AND repaired_attempt.status = 'done'
             AND repaired_attempt.source = 'solved'
             AND repaired_attempt.evidence_payload ->> 'fidelity' = 'urans_full'
            JOIN result_attempts current_attempt
              ON current_attempt.id = ${observedCell.currentAttemptId}
             AND current_attempt.result_id = ${opts.resultId}
             AND current_attempt.status = 'done'
             AND current_attempt.source = 'solved'
             AND current_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
            JOIN result_classifications current_classification
              ON current_classification.result_attempt_id = current_attempt.id
             AND current_classification.state = 'accepted'
            WHERE verify_item.precalc_result_id = ${opts.resultId}
              AND (
                (
                  verify_item.state = 'pending'
                  AND verify_item.last_outcome = 'media_repair_pending'
                )
                OR (
                  verify_item.state = 'blocked'
                  AND verify_item.last_outcome = 'final_recovery_exhausted'
                  AND EXISTS (
                    SELECT 1
                    FROM sim_solver_incidents incident
                    WHERE incident.verify_queue_id = verify_item.id
                      AND incident.result_attempt_id = repaired_attempt.id
                      AND incident.occurrence_key = concat_ws(
                        ':',
                        'final',
                        verify_item.id::text,
                        repaired_attempt.id::text,
                        'final_recovery_exhausted'
                      )
                  )
                )
              )
            LIMIT 1
            FOR UPDATE OF verify_item
          `)) as unknown as Array<{ id: string }>;
          if (!authorization) return;
          exactFinalRepairReplacement = true;
        }
        const [cell] = await tx
          .select({
            currentAttemptId: results.currentResultAttemptId,
            status: results.status,
          })
          .from(results)
          .where(eq(results.id, opts.resultId))
          .for("update")
          .limit(1);
        if (
          !cell ||
          cell.currentAttemptId !== observedCell.currentAttemptId ||
          cell.status !== observedCell.status
        ) {
          return;
        }
        const [repair] = await tx
          .select({
            resultAttemptId: resultMediaRepairs.resultAttemptId,
            state: resultMediaRepairs.state,
            evidenceSignature: resultMediaRepairs.evidenceSignature,
          })
          .from(resultMediaRepairs)
          .where(eq(resultMediaRepairs.id, opts.repairId))
          .for("update")
          .limit(1);
        if (
          !repair ||
          repair.resultAttemptId !== opts.resultAttemptId ||
          repair.state !== "done" ||
          repair.evidenceSignature !== opts.evidenceSignature
        ) {
          return;
        }
        const [attempt] = await tx
          .select()
          .from(resultAttempts)
          .where(
            and(
              eq(resultAttempts.id, opts.resultAttemptId),
              eq(resultAttempts.resultId, opts.resultId),
            ),
          )
          .limit(1);
        const [classification] = await tx
          .select({ state: resultClassifications.state })
          .from(resultClassifications)
          .where(
            eq(resultClassifications.resultAttemptId, opts.resultAttemptId),
          )
          .limit(1);
        const manifest = await manifestForAttempt(
          tx,
          opts.resultId,
          opts.resultAttemptId,
        );
        if (
          !attempt ||
          !manifest ||
          !(
            classification?.state === "accepted" ||
            (!exactFinalRepairReplacement &&
              classification?.state === "needs_urans")
          ) ||
          `${attempt.engineJobId ?? ""}:${attempt.engineCaseSlug ?? ""}:${manifest.sha256}` !==
            opts.evidenceSignature
        ) {
          return;
        }
        const payload = attempt.evidencePayload;
        const [updated] = await tx
          .update(results)
          .set({
            currentResultAttemptId: attempt.id,
            bcId: attempt.bcId,
            status: attempt.status,
            source: attempt.source,
            regime: attempt.regime,
            methodKey: attempt.methodKey,
            solverImplementationId: attempt.solverImplementationId,
            solverRuntimeBuildId: attempt.solverRuntimeBuildId,
            cl: attempt.cl,
            cd: attempt.cd,
            cm: attempt.cm,
            clCd: attempt.clCd,
            clStd: attempt.clStd,
            cdStd: attempt.cdStd,
            cmStd: attempt.cmStd,
            stalled: attempt.stalled,
            unsteady: attempt.unsteady,
            converged: attempt.converged,
            finalResidual: attempt.finalResidual,
            iterations: attempt.iterations,
            yPlusAvg: attempt.yPlusAvg,
            yPlusMax: attempt.yPlusMax,
            nCells: attempt.nCells,
            firstOrderFallback: attempt.firstOrderFallback,
            strouhal: attempt.strouhal,
            error: attempt.error,
            qualityWarnings: attempt.qualityWarnings,
            frameTrack: payloadField(payload, "frame_track", "frameTrack"),
            fidelity: payloadField(payload, "fidelity", "fidelity"),
            steadyHistory: payloadField(
              payload,
              "steady_history",
              "steadyHistory",
            ),
            engineJobId: attempt.engineJobId,
            engineCaseSlug: attempt.engineCaseSlug,
            simJobId: attempt.simJobId,
            solvedAt: attempt.solvedAt,
            priority: 0,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(results.id, opts.resultId),
              sql`${results.currentResultAttemptId} IS NOT DISTINCT FROM ${cell.currentAttemptId}::uuid`,
            ),
          )
          .returning({ id: results.id });
        published = Boolean(updated);
      },
    },
  );
  return published;
}

/** Ingest a completed JobResult through immutable attempt staging followed by
 * revision-locked exact-generation publication. */
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
  /** Exact AoAs sent to this engine job. Required when the engine returns a
   * typed early-abort promotion signal. */
  jobAoas?: number[];
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
  /** Durable ingest-lease owner. Production callers always provide this;
   * direct unit fixtures may omit it only while their sim_job is not in the
   * ingesting state. A live ingesting writer without the exact token cannot
   * publish a pointer. */
  ingestLeaseToken?: string;
  /** Heartbeat hook, called per point / per scaled-render batch so a
   *  multi-minute ingest never lets sweeper_state.heartbeatAt go stale past
   *  the web's 90 s truth gate (2026-07-06: 204 s stale under 7 jobs in
   *  flight read as PROCESS NOT RUNNING on a healthy process). Defaults to
   *  the real touchHeartbeat; tests inject a spy to count touches. */
  heartbeat?: () => Promise<void>;
  /** Deterministic crash-boundary hook used by the exact-generation replay
   * regression. It runs after every immutable evidence row is committed but
   * before classification/pointer publication. */
  hooks?: { afterEvidenceStaged?: () => Promise<void> };
}): Promise<{
  points: number;
  media: number;
  attempts: number;
  evidenceCleanups: number;
  dirtyLanes: CampaignLaneKey[];
  ransPrecalcPromotions: IngestedRansPrecalcPromotion[];
}> {
  const {
    db,
    engine,
    engineJobId,
    simJobId,
    airfoilId,
    speedMap,
    conditionMap,
    result,
  } = opts;
  const jobRuntime = await persistEngineRuntimeForJob(
    db,
    simJobId,
    result.engine,
  );
  const heartbeat = opts.heartbeat ?? (() => touchHeartbeat(db));
  let points = 0;
  let media = 0;
  // Attempt-evidence rows ingested from polars[].attempts. Reported separately
  // from `points` because an all-rejected job ships points: [] with the real
  // solver evidence ONLY in attempts (gate incident 2026-07-07, job a2379532):
  // the failed-job ingest path must be able to tell "evidence shipped" from a
  // true crash with an empty payload.
  let attempts = 0;
  const dirtyLanes = new Map<string, CampaignLaneKey>();
  const candidatesByRevision = new Map<string, StagedPoint[]>();
  const legacyCandidates: StagedPoint[] = [];
  const ransPrecalcPromotions: IngestedRansPrecalcPromotion[] = [];
  const remoteEvidenceCleanups = new Map<
    string,
    PendingRemoteEvidenceCleanup
  >();

  const stagePoint = async (input: {
    point: PolarPoint;
    bcId: string;
    presetRevisionId: string | null;
    mappedMach: number | null;
    reynolds: number;
    speed: number;
    chord: number;
  }): Promise<StagedPoint> => {
    const p = input.point;
    const pointRuntime = p.engine
      ? await persistEngineRuntimeForJob(db, simJobId, p.engine)
      : jobRuntime;
    const runtime =
      pointRuntime ?? (await resolveEngineRuntimeBuild(db, p.engine));
    const failed = failedForPoint(p);
    const pointError = p.error?.trim()
      ? p.error
      : failed || (p.converged === false && !hasStableSteadyMean(p))
        ? (opts.failedPointErrorFallback ?? null)
        : null;
    const pointContext = `job ${engineJobId}, case ${p.case_slug ?? "?"}, aoa ${p.aoa_deg}`;
    const derived = {
      frameTrack: frameTrackForPoint(p, pointContext),
      fidelity: fidelityForPoint(p, opts.uransFidelity, pointContext),
      steadyHistory: steadyHistoryForPoint(p, pointContext),
      error: pointError,
    };
    const cell = await ensureIngestCell({
      db,
      airfoilId,
      bcId: input.bcId,
      presetRevisionId: input.presetRevisionId,
      aoaDeg: p.aoa_deg,
      simJobId,
      engineJobId,
      ingestLeaseToken: opts.ingestLeaseToken,
      reynolds: Math.round(input.reynolds),
      speed: input.speed,
      chord: input.chord,
      mach: p.unsteady ? (input.mappedMach ?? null) : input.mappedMach,
    });
    const incomingReasons = incomingRejectionReasons(p, derived);
    const extraQualityWarnings: string[] = [];
    if (cell.quarantined) {
      console.error(
        `[sweeper] RELEASED-CELL GUARD: ${RELEASED_CELL_MARKER} (${pointContext}); cell was ${cell.status}${cell.simJobId ? ` under ${cell.simJobId}` : " (released)"}; exact attempt retained as history only`,
      );
      extraQualityWarnings.push(
        `${RELEASED_CELL_MARKER}: cell was ${cell.status}${cell.simJobId ? " under another job" : " (released)"} at ingest; canonical row not changed`,
      );
    } else if (cell.currentAttemptId && incomingReasons.length) {
      extraQualityWarnings.push(
        `${REPLACE_GUARD_MARKER}: ${incomingReasons.join(", ")}; selected generation retained unless exact classification accepts this attempt`,
      );
    }
    const resultAttemptId = await insertResultAttempt({
      db,
      resultId: cell.id,
      airfoilId,
      bcId: input.bcId,
      presetRevisionId: input.presetRevisionId,
      simJobId,
      engineJobId,
      runtime,
      point: p,
      meshRecoveryVersion: result.mesh_recovery_version ?? null,
      derived,
      extraQualityWarnings,
    });
    if (!resultAttemptId) {
      throw new Error(`failed to stage exact attempt (${pointContext})`);
    }

    // Exact immutable evidence is complete before any canonical projection or
    // current pointer can change. Every row carries both owner ids, enforced
    // by the 0053 composite foreign keys.
    for (const artifact of p.evidence_artifacts ?? []) {
      const cleanup = await registerEvidenceArtifacts({
        db,
        engine,
        resultId: cell.id,
        resultAttemptId,
        airfoilId,
        simJobId,
        engineJobId,
        point: p,
        artifact,
        runtime,
      });
      if (cleanup) {
        mergePendingRemoteEvidenceCleanup(remoteEvidenceCleanups, cleanup);
      }
    }
    if (!failed) {
      media += await registerShippedMedia(
        db,
        engine,
        cell.id,
        resultAttemptId,
        p,
      );
    }
    await stageForceHistory(db, cell.id, resultAttemptId, p);
    // Field extents and scaled default media belong to the separate, durable
    // media-repair worker. Calling the renderer while a continuous sweep is
    // publishing partial evidence makes the scheduler wait on I/O instead of
    // submitting the next independent polar. Shipped media and immutable raw
    // evidence above remain immediately available; the repair worker derives
    // extents only after the producing engine job is terminal.
    return {
      airfoilId,
      bcId: input.bcId,
      presetRevisionId: input.presetRevisionId,
      resultId: cell.id,
      resultAttemptId,
      point: p,
      derived,
      reynolds: Math.round(input.reynolds),
      speed: input.speed,
      chord: input.chord,
      mach: input.mappedMach,
      simJobId,
      engineJobId,
      ingestLeaseToken: opts.ingestLeaseToken ?? null,
      observedCurrentAttemptId: cell.currentAttemptId,
      observedStatus: cell.status,
      observedSimJobId: cell.simJobId,
      quarantined: cell.quarantined,
    };
  };

  for (const polar of result.polars) {
    let bcId: string;
    let presetRevisionId: string | null;
    let mappedMach: number | null;
    let conditionId: string | null = null;
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
      conditionId = entry.conditionId;
      presetRevisionId = entry.revisionId;
      mappedMach =
        speedMap.find((s) => canonicalSi("speedMps", s.speed) === entry.speed)
          ?.mach ?? null;
    } else {
      if (speedMap.length === 0) continue;
      const match = speedMap.reduce((best, s) =>
        Math.abs(s.speed - polar.speed) < Math.abs(best.speed - polar.speed)
          ? s
          : best,
      );
      bcId = match.bcId;
      presetRevisionId = match.presetRevisionId ?? null;
      mappedMach = match.mach ?? null;
    }
    const canonicalAoas = new Set(polar.points.map((point) => point.aoa_deg));
    const pointCandidates: StagedPoint[] = [];
    for (const p of polar.points) {
      await heartbeat();
      const staged = await stagePoint({
        point: p,
        bcId,
        presetRevisionId,
        mappedMach: polar.mach ?? mappedMach,
        reynolds: polar.reynolds,
        speed: polar.speed,
        chord: polar.chord,
      });
      pointCandidates.push(staged);
      points++;
    }
    const attemptOnlyByAoa = new Map<number, StagedPoint>();
    const stagedAttemptByAoa = new Map<number, StagedPoint>();
    for (const p of polar.attempts ?? []) {
      await heartbeat();
      attempts++;
      const staged = await stagePoint({
        point: p,
        bcId,
        presetRevisionId,
        mappedMach: polar.mach ?? mappedMach,
        reynolds: polar.reynolds,
        speed: polar.speed,
        chord: polar.chord,
      });
      stagedAttemptByAoa.set(p.aoa_deg, staged);
      if (!canonicalAoas.has(p.aoa_deg))
        attemptOnlyByAoa.set(p.aoa_deg, staged);
    }
    const promotion = polar.rans_precalc_promotion;
    if (promotion && presetRevisionId) {
      const trigger = stagedAttemptByAoa.get(promotion.trigger_aoa_deg);
      const validated = validateRansPrecalcPromotionSignal({
        promotion,
        stagedAttemptAoas: [...stagedAttemptByAoa.keys()],
        triggerFailureDisposition: trigger?.point.failure_disposition ?? null,
        jobAoas: opts.jobAoas ?? [],
      });
      if (trigger && validated) {
        ransPrecalcPromotions.push({
          revisionId: presetRevisionId,
          conditionId,
          triggerResultAttemptId: trigger.resultAttemptId,
          triggerAoaDeg: promotion.trigger_aoa_deg,
          attemptedAoas: validated.attemptedAoas,
          intentionallyOmittedAoas: validated.intentionallyOmittedAoas,
        });
      } else {
        throw new Error(
          `RANS PRECALC promotion signal failed exact attempt/omission accounting (engine job ${engineJobId}, revision ${presetRevisionId}, trigger ${promotion.trigger_aoa_deg})`,
        );
      }
    }
    for (const candidate of [
      ...pointCandidates,
      ...attemptOnlyByAoa.values(),
    ]) {
      if (candidate.presetRevisionId) {
        const bucket = candidatesByRevision.get(candidate.presetRevisionId);
        if (bucket) bucket.push(candidate);
        else candidatesByRevision.set(candidate.presetRevisionId, [candidate]);
      } else {
        legacyCandidates.push(candidate);
      }
    }
  }

  await opts.hooks?.afterEvidenceStaged?.();

  const evidenceCleanups = ["completed", "failed", "cancelled"].includes(
    result.state,
  )
    ? await acknowledgeTerminalRemoteEvidenceCleanups(
        db,
        engine,
        engineJobId,
        remoteEvidenceCleanups,
      )
    : 0;

  const finalizedByResult = new Map<string, FinalizedPoint>();
  for (const [revisionId, candidates] of candidatesByRevision) {
    const finalized = await publishStagedPoints(
      db,
      airfoilId,
      revisionId,
      candidates,
    );
    for (const row of finalized) finalizedByResult.set(row.resultId, row);
  }
  // Revision-less legacy evidence cannot participate in the compatibility
  // identity or fitted-polar transaction. Preserve it as exact attempt
  // history and fail the scheduling shell closed; public reads require a
  // selected revision-backed generation.
  for (const candidate of legacyCandidates) {
    if (candidate.quarantined) continue;
    const [failed] = await db
      .update(results)
      .set({
        status: "failed",
        source: "queued",
        error: "solver evidence has no immutable setup revision",
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(results.id, candidate.resultId),
          sql`${results.currentResultAttemptId} IS NULL`,
          eq(results.status, candidate.observedStatus as never),
          sql`${results.simJobId} IS NOT DISTINCT FROM ${candidate.observedSimJobId}::uuid`,
        ),
      )
      .returning({
        resultId: results.id,
        aoaDeg: results.aoaDeg,
        status: results.status,
        regime: results.regime,
        resultAttemptId: results.currentResultAttemptId,
        simJobId: results.simJobId,
      });
    if (failed)
      finalizedByResult.set(failed.resultId, failed as FinalizedPoint);
  }

  // Default-media rendering is deliberately outside the completed-job ingest
  // transaction. Immutable solver evidence, shipped media and field extents
  // are staged above; the bounded, leased result-media repair queue owns
  // expensive rendering and its retries. A missing URANS video therefore
  // remains rejected/unavailable, but cannot leave an engine-complete job
  // permanently `ingesting` and consume a scheduler slot.
  // Campaign and obligation state observe only committed selected evidence (or
  // a pointer-null machine failure). A rejected child of an existing public
  // generation settles against the kept current row returned above.
  for (const finalized of finalizedByResult.values()) {
    const candidate = [...candidatesByRevision.values(), legacyCandidates]
      .flat()
      .find((item) => item.resultId === finalized.resultId);
    const laneKeys = await onResultIngestedWithAutomaticPrecalcHandoff(db, {
      airfoilId,
      revisionId: candidate?.presetRevisionId ?? null,
      aoaDeg: finalized.aoaDeg,
      resultId: finalized.resultId,
      status: finalized.status,
      regime: finalized.regime,
      resultAttemptId: finalized.resultAttemptId,
      simJobId: finalized.simJobId,
    });
    for (const key of laneKeys) dirtyLanes.set(laneKeyId(key), key);
  }
  return {
    points,
    media,
    attempts,
    evidenceCleanups,
    dirtyLanes: [...dirtyLanes.values()],
    ransPrecalcPromotions,
  };
}
