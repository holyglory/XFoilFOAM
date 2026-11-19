import type { DB } from "@aerodb/db/client";
import {
  readLegacyPageMembers,
  type LegacyExactPageMemberIdentity,
} from "@aerodb/db/legacy-report-storage-codec";
import {
  parseReportJson, reportValidationValue, ReportJsonNumber, reportTextIdentity,
  type ReportJson,
} from "@aerodb/db/progressive-report-archive";
import { CRC32C } from "@google-cloud/storage";
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readWorkerReportVolume } from "./worker-report-volume";
import type { LegacyBackupObject } from "./legacy-report-storage-gcs";
import type { LegacyReportPageReadIdentity, LegacyLocalPageProductReadback } from "@aerodb/db/legacy-report-custody";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_OBJECT = 512 * 1024 ** 2;
const MAX_MEMBER = 256 * 1024 ** 2;
export const MAX_LEGACY_PRODUCT_REQUEST_BYTES = 1024 * 1024;

/** Stable parent/controller interface: one object and its COMPLETE expected
 * member set. An operator receipt supplies object/source/scope; member keys,
 * signatures and byte proofs come from the same frozen page. */
export interface LegacyWorkerProductReadRequest {
  version: 1;
  object: Omit<LegacyBackupObject, "verifiedAt"> & { verifiedAt?: string };
  sourceInstance: string;
  solverId: string;
  scopeSha256: string;
  members: LegacyExactPageMemberIdentity[];
  expectedReaderSha256?: string;
  expectedCodecSha256?: string;
  expectedBuildId?: string;
}

export class LegacyWorkerProductReadError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
function invalid(): never { throw new LegacyWorkerProductReadError("input_invalid", "Invalid bounded legacy page request"); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((k) => !keys.includes(k))) invalid();
  return value as Record<string, unknown>;
}
const integer = (v: unknown, max: number) => typeof v === "number" && Number.isSafeInteger(v) && v > 0 && v <= max;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

export function validateLegacyWorkerProductReadRequest(value: unknown): LegacyWorkerProductReadRequest {
  const request = object(value, ["version", "object", "sourceInstance", "solverId", "scopeSha256", "members", "expectedReaderSha256", "expectedCodecSha256", "expectedBuildId"]);
  const stored = object(request.object, ["bucket", "objectKey", "generation", "sha256", "byteSize", "crc32c", "verifiedAt"]);
  if (request.version !== 1 || typeof request.sourceInstance !== "string" || !UUID.test(request.sourceInstance) ||
      typeof request.solverId !== "string" || !UUID.test(request.solverId) ||
      typeof request.scopeSha256 !== "string" || !HASH.test(request.scopeSha256) ||
      typeof stored.bucket !== "string" || !/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(stored.bucket) ||
      typeof stored.sha256 !== "string" || !HASH.test(stored.sha256) || !integer(stored.byteSize, MAX_OBJECT) ||
      typeof stored.generation !== "string" || !/^[1-9][0-9]{0,19}$/.test(stored.generation) ||
      BigInt(stored.generation) > 18_446_744_073_709_551_615n ||
      typeof stored.crc32c !== "string" || !/^[A-Za-z0-9+/]{6}==$/.test(stored.crc32c) ||
      (stored.verifiedAt !== undefined && (typeof stored.verifiedAt !== "string" || !Number.isFinite(Date.parse(stored.verifiedAt)))) ||
      stored.objectKey !== `legacy-worker-reports/v1/${request.sourceInstance}/${request.solverId}/${request.scopeSha256}/${stored.sha256}.jsonl.gz` ||
      !Array.isArray(request.members) || request.members.length < 1 || request.members.length > 128) invalid();
  for (const field of ["expectedReaderSha256", "expectedCodecSha256"] as const)
    if (request[field] !== undefined && (typeof request[field] !== "string" || !HASH.test(request[field] as string))) invalid();
  if (request.expectedBuildId !== undefined &&
      (typeof request.expectedBuildId !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/.test(request.expectedBuildId))) invalid();
  const seen = new Set<string>();
  for (const raw of request.members) {
    const member = object(raw, ["executionId", "sequence", "kind", "contentSignature", "reportSha256", "reportByteSize", "rowSha256", "rowByteSize"]);
    if (typeof member.executionId !== "string" || !UUID.test(member.executionId) ||
        !integer(member.sequence, Number.MAX_SAFE_INTEGER) || !["report", "conflict"].includes(member.kind as string) ||
        typeof member.contentSignature !== "string" || !HASH.test(member.contentSignature) ||
        typeof member.reportSha256 !== "string" || !HASH.test(member.reportSha256) || !integer(member.reportByteSize, MAX_MEMBER) ||
        (member.rowSha256 !== undefined && (typeof member.rowSha256 !== "string" || !HASH.test(member.rowSha256))) ||
        (member.rowByteSize !== undefined && !integer(member.rowByteSize, 256 * 1024 ** 2))) invalid();
    const key = `${member.kind}:${member.executionId}:${member.sequence}`;
    if (seen.has(key)) invalid();
    seen.add(key);
  }
  return request as unknown as LegacyWorkerProductReadRequest;
}

/** Reject duplicate JSON keys and numeric rounding before constructing the
 * typed request. Request numbers are positive decimal integers, not floats. */
export function parseLegacyWorkerProductReadRequest(text: string): LegacyWorkerProductReadRequest {
  if (Buffer.byteLength(text) > MAX_LEGACY_PRODUCT_REQUEST_BYTES) invalid();
  try {
    const parsed = parseReportJson(text);
    const exactNumbers = (v: ReportJson): void => {
      if (v instanceof ReportJsonNumber) {
        if (!/^(?:0|[1-9][0-9]*)$/.test(v.text) || !Number.isSafeInteger(Number(v.text))) invalid();
      } else if (Array.isArray(v)) v.forEach(exactNumbers);
      else if (v && typeof v === "object") Object.values(v).forEach(exactNumbers);
    };
    exactNumbers(parsed);
    return validateLegacyWorkerProductReadRequest(reportValidationValue(parsed));
  } catch { return invalid(); }
}

export interface LegacyWorkerProductPageProof {
  version: 1;
  kind: "legacy-worker-report-product-page-read";
  verified: true;
  readSource: "worker-report-volume";
  readMode: "hub-local-reader";
  storageKey: string;
  /** Observation time when the retained durable copy was fully verified. */
  durableAt: string;
  sourceInstance: string;
  solverId: string;
  scopeSha256: string;
  object: LegacyWorkerProductReadRequest["object"];
  volumeObjectReads: number;
  decoderPasses: number;
  storedBytesRead: number;
  memberCount: number;
  members: Required<LegacyExactPageMemberIdentity>[];
  memberProofSha256: string;
  readerSha256: string;
  codecSha256: string;
  buildId: string | null;
  checkedAt: string;
}

export async function legacyWorkerProductReaderIdentity() {
  const [reader, codec] = await Promise.all([
    readFile(new URL(import.meta.url)),
    readFile(new URL("../../../packages/db/src/legacy-report-storage-codec.ts", import.meta.url)),
  ]);
  return { readerSha256: hash(reader), codecSha256: hash(codec), buildId: process.env.AIRFOILFOAM_BUILD_ID?.trim() || null };
}

async function assertLocalOwner(db: DB, request: LegacyWorkerProductReadRequest, signal: AbortSignal) {
  signal.throwIfAborted();
  const [owner] = await db.execute(sql`
    SELECT instance_id::text AS source_instance, remote_solver_registered_id::text AS solver_id
    FROM sync_api_settings WHERE id = 1
  `) as unknown as Array<{ source_instance: string; solver_id: string | null }>;
  if (!owner || owner.source_instance !== request.sourceInstance || owner.solver_id !== request.solverId)
    throw new LegacyWorkerProductReadError("foreign_owner", "Page does not belong to the current local worker");
  signal.throwIfAborted();
}

/** Actual installed product read for custody: one volume open and one shared
 * complete-page decode. No network fallback, credentials, scheduling or SQL
 * writes. Object generation is retained verbatim; this is local read proof,
 * separate from the controller's authenticated GCS generation receipt. */
async function readPageWithProof(db: DB, value: LegacyWorkerProductReadRequest, abortSignal?: AbortSignal) {
  const request = validateLegacyWorkerProductReadRequest(value);
  const signal = abortSignal ? AbortSignal.any([abortSignal, AbortSignal.timeout(120_000)]) : AbortSignal.timeout(120_000);
  signal.throwIfAborted();
  const installed = await legacyWorkerProductReaderIdentity();
  if ((request.expectedReaderSha256 && request.expectedReaderSha256 !== installed.readerSha256) ||
      (request.expectedCodecSha256 && request.expectedCodecSha256 !== installed.codecSha256) ||
      (request.expectedBuildId && request.expectedBuildId !== installed.buildId))
    throw new LegacyWorkerProductReadError("source_changed", "Installed reader does not match the requested source identity");
  await assertLocalOwner(db, request, signal);
  const source = await readWorkerReportVolume({ storedSha256: request.object.sha256, storedByteSize: request.object.byteSize });
  if (!source) throw new LegacyWorkerProductReadError("volume_missing", "Verified compressed page is missing from the local working volume");
  const abort = () => { source.destroy(new LegacyWorkerProductReadError("aborted", "Page read aborted")); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Buffer[] = [], crc = new CRC32C(), sha = createHash("sha256");
  let size = 0;
  try {
    if (signal.aborted) abort();
    for await (const raw of source) {
      signal.throwIfAborted();
      const bytes = Buffer.from(raw); size += bytes.length;
      if (size > request.object.byteSize || size > MAX_OBJECT)
        throw new LegacyWorkerProductReadError("archive_invalid", "Compressed page exceeds its byte bound");
      sha.update(bytes); crc.update(bytes); chunks.push(bytes);
    }
  } finally { signal.removeEventListener("abort", abort); source.destroy(); }
  signal.throwIfAborted();
  if (size !== request.object.byteSize || sha.digest("hex") !== request.object.sha256 || crc.toString() !== request.object.crc32c)
    throw new LegacyWorkerProductReadError("archive_invalid", "Compressed page size/SHA/CRC differs from the verified object");
  const storedBytes = Buffer.concat(chunks);
  let decoded;
  try {
    decoded = readLegacyPageMembers(storedBytes, {
      ...request, storedSha256: request.object.sha256, storedByteSize: request.object.byteSize,
    });
  } catch { throw new LegacyWorkerProductReadError("member_invalid", "Complete decoded page or exact expected member set differs"); }
  const members = decoded.map((member) => {
    const report = reportTextIdentity(member.reportText), row = reportTextIdentity(member.rowText);
    return {
      executionId: member.executionId, sequence: member.sequence, kind: member.kind,
      contentSignature: member.contentSignature, reportSha256: report.sha256, reportByteSize: report.byteSize,
      rowSha256: row.sha256, rowByteSize: row.byteSize,
    };
  });
  await assertLocalOwner(db, request, signal);
  signal.throwIfAborted();
  const checkedAt = new Date().toISOString();
  const proof: LegacyWorkerProductPageProof = {
    version: 1, kind: "legacy-worker-report-product-page-read", verified: true, readSource: "worker-report-volume",
    readMode: "hub-local-reader", storageKey: `report-archives/v1/${request.object.sha256.slice(0, 2)}/${request.object.sha256}.jsonl.gz`, durableAt: checkedAt,
    sourceInstance: request.sourceInstance, solverId: request.solverId, scopeSha256: request.scopeSha256, object: request.object,
    volumeObjectReads: 1, decoderPasses: 1, storedBytesRead: size, memberCount: members.length,
    members, memberProofSha256: hash(JSON.stringify(members)), ...installed, checkedAt,
  };
  return { proof, storedBytes };
}

export async function readLegacyWorkerProductPage(db: DB, request: LegacyWorkerProductReadRequest, signal?: AbortSignal): Promise<LegacyWorkerProductPageProof> {
  return (await readPageWithProof(db, request, signal)).proof;
}

/** Shared installed interface used by the custody worker. This is exclusively
 * the existing local-volume path; registered-get must use its actual network
 * reader. durableAt records when the normal product reader verified the
 * already-retained durable copy, never a new GCS verification timestamp. */
export async function readLegacyWorkerReportArchivePage(
  db: DB, identity: LegacyReportPageReadIdentity,
): Promise<LegacyLocalPageProductReadback & { proof: LegacyWorkerProductPageProof }> {
  if (identity.sourceKind !== "worker" || identity.archiveFormat !== "legacy-jsonl" ||
      identity.mimeType !== "application/gzip" || identity.compression !== "gzip" ||
      identity.legacyReadMode !== "hub-local-reader" || !Array.isArray(identity.members) || identity.legacyPageMemberCount !== identity.members.length)
    throw new LegacyWorkerProductReadError("input_invalid", "Expected an exact complete local legacy page identity");
  const { proof, storedBytes } = await readPageWithProof(db, {
    version: 1, sourceInstance: identity.legacyInstanceId, solverId: identity.legacySolverId, scopeSha256: identity.legacyScopeSha256,
    object: { bucket: identity.bucket, objectKey: identity.objectKey, generation: identity.generation,
      sha256: identity.storedSha256, byteSize: identity.storedByteSize, crc32c: identity.crc32c },
    members: identity.members.map((member) => ({ ...member })),
  }, identity.signal);
  return { storedBytes, storageKey: proof.storageKey, durableAt: proof.durableAt, proof };
}
