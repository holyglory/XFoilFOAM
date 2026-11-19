import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";

export const SOLVER_HISTORY_KINDS = [
  "force_history",
] as const;
export type SolverHistoryKind = (typeof SOLVER_HISTORY_KINDS)[number];
// One source per object. Oversize sources are reported, never truncated.
export const MAX_SOLVER_HISTORY_BYTES = 32 * 1024 * 1024;
export const MAX_SOLVER_HISTORY_ENVELOPE_BYTES = 2 * MAX_SOLVER_HISTORY_BYTES + 4096;
export const MAX_SOLVER_HISTORY_STORED_BYTES = MAX_SOLVER_HISTORY_ENVELOPE_BYTES + 65536;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export interface SolverHistorySource {
  sourceKind: SolverHistoryKind;
  sourceId: string;
  resultId: string | null;
  resultAttemptId: string | null;
  /** Exact PostgreSQL ::text export, NOT JSON.parse/stringify output. JSONB
   * has already lost original engine wire formatting and duplicate keys. */
  payloadText: string;
}

export interface SolverHistoryEnvelope extends SolverHistorySource {
  version: 1;
  sourceInstance: string;
}

export interface SolverHistoryArchiveIdentity {
  sourceInstance: string;
  sourceKind: SolverHistoryKind;
  sourceId: string;
  resultId: string | null;
  resultAttemptId: string | null;
  sourceSha256: string;
  sourceByteSize: number;
  envelopeSha256: string;
  envelopeByteSize: number;
  storedSha256: string;
  storedByteSize: number;
  bucket: string;
  objectKey: string;
  generation: string;
  crc32c: string;
}

export function solverHistorySha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertSolverHistoryInstance(instance: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(instance))
    throw new Error("Solver history source instance is required and must be a stable identifier");
}

export function assertSolverHistorySource(source: SolverHistorySource): void {
  if (
    !SOLVER_HISTORY_KINDS.includes(source.sourceKind) ||
    !UUID.test(source.sourceId) ||
    (source.resultId !== null && !UUID.test(source.resultId)) ||
    (source.resultAttemptId !== null && !UUID.test(source.resultAttemptId)) ||
    source.resultId === null
  ) throw new Error("Invalid solver history source ownership");
  if (typeof source.payloadText !== "string") throw new Error("Missing solver history text");
  const size = Buffer.byteLength(source.payloadText, "utf8");
  if (size < 1 || size > MAX_SOLVER_HISTORY_BYTES)
    throw new Error("Solver history source exceeds the bounded archive size");
  // Validate syntax without reserializing: JSON numeric precision, spacing,
  // key ordering, nulls and even currently malformed physical evidence survive.
  JSON.parse(source.payloadText);
}

export function encodeSolverHistory(sourceInstance: string, source: SolverHistorySource) {
  assertSolverHistoryInstance(sourceInstance);
  assertSolverHistorySource(source);
  const envelope: SolverHistoryEnvelope = {
    version: 1, sourceInstance,
    sourceKind: source.sourceKind, sourceId: source.sourceId,
    resultId: source.resultId, resultAttemptId: source.resultAttemptId,
    payloadText: source.payloadText,
  };
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  if (bytes.byteLength > MAX_SOLVER_HISTORY_ENVELOPE_BYTES)
    throw new Error("Solver history envelope exceeds the bounded archive size");
  const stored = gzipSync(bytes, { level: 9 });
  return {
    stored,
    sourceSha256: solverHistorySha256(Buffer.from(source.payloadText, "utf8")),
    sourceByteSize: Buffer.byteLength(source.payloadText, "utf8"),
    envelopeSha256: solverHistorySha256(bytes), envelopeByteSize: bytes.byteLength,
    storedSha256: solverHistorySha256(stored), storedByteSize: stored.byteLength,
  };
}

export function assertSolverHistoryArchive(identity: SolverHistoryArchiveIdentity): void {
  assertSolverHistoryInstance(identity.sourceInstance);
  assertSolverHistorySource({ ...identity, payloadText: "null" });
  if (
    !identity.bucket || identity.bucket.includes("/") ||
    !identity.objectKey || identity.objectKey.startsWith("/") ||
    identity.objectKey.split("/").some((part) => !part || part === "." || part === "..") ||
    !/^[1-9][0-9]{0,19}$/.test(identity.generation) ||
    !/^[A-Za-z0-9+/]{6}==$/.test(identity.crc32c) ||
    ![identity.sourceSha256, identity.envelopeSha256, identity.storedSha256].every((s) => SHA256.test(s)) ||
    ![
      [identity.sourceByteSize, MAX_SOLVER_HISTORY_BYTES],
      [identity.envelopeByteSize, MAX_SOLVER_HISTORY_ENVELOPE_BYTES],
      [identity.storedByteSize, MAX_SOLVER_HISTORY_STORED_BYTES],
    ].every(([size, max]) => Number.isSafeInteger(size) && size > 0 && size <= max)
  ) throw new Error("Invalid immutable solver history archive identity");
}

export function decodeSolverHistory(
  stored: Buffer,
  identity: SolverHistoryArchiveIdentity,
): SolverHistoryEnvelope {
  assertSolverHistoryArchive(identity);
  if (stored.byteLength !== identity.storedByteSize || solverHistorySha256(stored) !== identity.storedSha256)
    throw new Error("Solver history stored bytes failed exact verification");
  const bytes = gunzipSync(stored, { maxOutputLength: MAX_SOLVER_HISTORY_ENVELOPE_BYTES });
  if (bytes.byteLength !== identity.envelopeByteSize || solverHistorySha256(bytes) !== identity.envelopeSha256)
    throw new Error("Solver history envelope failed exact verification");
  const envelope = JSON.parse(bytes.toString("utf8")) as SolverHistoryEnvelope;
  if (envelope?.version !== 1) throw new Error("Unsupported solver history archive version");
  assertSolverHistorySource(envelope);
  for (const field of ["sourceInstance", "sourceKind", "sourceId", "resultId", "resultAttemptId"] as const) {
    if (envelope[field] !== identity[field]) throw new Error("Solver history archive belongs to a different source");
  }
  if (Buffer.byteLength(envelope.payloadText, "utf8") !== identity.sourceByteSize ||
      solverHistorySha256(Buffer.from(envelope.payloadText, "utf8")) !== identity.sourceSha256)
    throw new Error("Solver history source text failed exact verification");
  return envelope;
}

/** A raw coefficient file, equivalent JSON or rounded numbers are not proof
 * of a byte-identical PostgreSQL representation. Caller supplies an already
 * authenticated archive member and retains its provenance separately. */
export function compareSolverHistoryRaw(source: SolverHistorySource, raw: Buffer) {
  assertSolverHistorySource(source);
  const bytes = Buffer.from(source.payloadText, "utf8");
  return {
    byteIdentical: bytes.equals(raw),
    sourceSha256: solverHistorySha256(bytes), sourceByteSize: bytes.byteLength,
    candidateSha256: solverHistorySha256(raw), candidateByteSize: raw.byteLength,
  };
}
