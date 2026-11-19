import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  pinExactGcsGeneration,
  type GcsGenerationTarget,
} from "./gcs-exact-generation";

export const RESULT_HISTORY_KINDS = ["steady_history", "frame_track"] as const;
export type ResultHistoryKind = (typeof RESULT_HISTORY_KINDS)[number];
export const MAX_RESULT_HISTORY_BYTES = 32 * 1024 * 1024;
export const MAX_RESULT_HISTORY_ENVELOPE_BYTES =
  2 * MAX_RESULT_HISTORY_BYTES + 4096;
export const MAX_RESULT_HISTORY_STORED_BYTES =
  MAX_RESULT_HISTORY_ENVELOPE_BYTES + 65536;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

export interface ResultHistorySource {
  sourceKind: ResultHistoryKind;
  resultId: string;
  resultAttemptId: string | null;
  /** Exact PostgreSQL jsonb::text; never parsed and reserialized for storage. */
  payloadText: string;
}
export interface ResultHistoryEnvelope extends ResultHistorySource {
  version: 1;
  sourceInstance: string;
}
export interface ResultHistoryArchiveIdentity extends Omit<
  ResultHistoryEnvelope,
  "payloadText" | "version"
> {
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
  verifiedAt: Date;
}
export interface ResultHistoryReader {
  read(identity: ResultHistoryArchiveIdentity): Promise<ResultHistoryEnvelope>;
}
export interface ResultHistoryArchiveStore extends ResultHistoryReader {
  put(
    bucket: string,
    sourceInstance: string,
    source: ResultHistorySource,
  ): Promise<ResultHistoryArchiveIdentity>;
}

export function resultHistorySha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export function assertResultHistoryInstance(instance: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(instance))
    throw new Error("Result history requires a stable source instance");
}
export function assertResultHistorySource(source: ResultHistorySource): void {
  if (
    !RESULT_HISTORY_KINDS.includes(source.sourceKind) ||
    !UUID.test(source.resultId) ||
    (source.resultAttemptId !== null && !UUID.test(source.resultAttemptId)) ||
    typeof source.payloadText !== "string" ||
    Buffer.byteLength(source.payloadText) < 1 ||
    Buffer.byteLength(source.payloadText) > MAX_RESULT_HISTORY_BYTES
  )
    throw new Error("Invalid bounded result history source");
  JSON.parse(source.payloadText);
}
function objectKey(
  identity: Pick<
    ResultHistoryArchiveIdentity,
    "sourceInstance" | "sourceKind" | "resultId" | "storedSha256"
  >,
) {
  return `result-histories/v1/${identity.sourceInstance}/${identity.sourceKind}/${identity.resultId}/${identity.storedSha256}.json.gz`;
}
export function assertResultHistoryArchive(
  identity: ResultHistoryArchiveIdentity,
): void {
  assertResultHistoryInstance(identity.sourceInstance);
  assertResultHistorySource({ ...identity, payloadText: "null" });
  if (
    !identity.bucket.trim() ||
    identity.bucket.includes("/") ||
    identity.objectKey !== objectKey(identity) ||
    !/^[1-9][0-9]{0,19}$/.test(identity.generation) ||
    BigInt(identity.generation) > 18_446_744_073_709_551_615n ||
    !/^[A-Za-z0-9+/]{6}==$/.test(identity.crc32c) ||
    ![
      identity.sourceSha256,
      identity.envelopeSha256,
      identity.storedSha256,
    ].every((hash) => SHA256.test(hash)) ||
    ![
      [identity.sourceByteSize, MAX_RESULT_HISTORY_BYTES],
      [identity.envelopeByteSize, MAX_RESULT_HISTORY_ENVELOPE_BYTES],
      [identity.storedByteSize, MAX_RESULT_HISTORY_STORED_BYTES],
    ].every(
      ([size, max]) => Number.isSafeInteger(size) && size > 0 && size <= max,
    ) ||
    !(identity.verifiedAt instanceof Date) ||
    !Number.isFinite(identity.verifiedAt.getTime())
  )
    throw new Error("Invalid immutable result history archive identity");
}
export function encodeResultHistory(
  sourceInstance: string,
  source: ResultHistorySource,
) {
  assertResultHistoryInstance(sourceInstance);
  assertResultHistorySource(source);
  const envelope: ResultHistoryEnvelope = {
    version: 1,
    sourceInstance,
    sourceKind: source.sourceKind,
    resultId: source.resultId,
    resultAttemptId: source.resultAttemptId,
    payloadText: source.payloadText,
  };
  const bytes = Buffer.from(JSON.stringify(envelope), "utf8");
  if (bytes.length > MAX_RESULT_HISTORY_ENVELOPE_BYTES)
    throw new Error("Result history envelope exceeds the byte limit");
  const stored = gzipSync(bytes, { level: 9 });
  return {
    stored,
    sourceSha256: resultHistorySha256(Buffer.from(source.payloadText)),
    sourceByteSize: Buffer.byteLength(source.payloadText),
    envelopeSha256: resultHistorySha256(bytes),
    envelopeByteSize: bytes.length,
    storedSha256: resultHistorySha256(stored),
    storedByteSize: stored.length,
  };
}
export function decodeResultHistory(
  stored: Buffer,
  identity: ResultHistoryArchiveIdentity,
): ResultHistoryEnvelope {
  assertResultHistoryArchive(identity);
  if (
    stored.length !== identity.storedByteSize ||
    resultHistorySha256(stored) !== identity.storedSha256
  )
    throw new Error("Result history stored bytes failed exact verification");
  const bytes = gunzipSync(stored, {
    maxOutputLength: MAX_RESULT_HISTORY_ENVELOPE_BYTES,
  });
  if (
    bytes.length !== identity.envelopeByteSize ||
    resultHistorySha256(bytes) !== identity.envelopeSha256
  )
    throw new Error("Result history envelope failed exact verification");
  const restored = JSON.parse(bytes.toString("utf8")) as ResultHistoryEnvelope;
  if (restored.version !== 1)
    throw new Error("Unsupported result history archive version");
  assertResultHistorySource(restored);
  for (const field of [
    "sourceInstance",
    "sourceKind",
    "resultId",
    "resultAttemptId",
  ] as const)
    if (restored[field] !== identity[field])
      throw new Error("Result history archive belongs to a different source");
  if (
    Buffer.byteLength(restored.payloadText) !== identity.sourceByteSize ||
    resultHistorySha256(Buffer.from(restored.payloadText)) !==
      identity.sourceSha256
  )
    throw new Error("Result history source text failed exact verification");
  return restored;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  return crc >>> 0;
});
function crc32c(bytes: Buffer): string {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  const result = Buffer.alloc(4);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return result.toString("base64");
}

interface GcsMetadata {
  generation?: string | number;
  size?: string | number;
  crc32c?: string;
  contentType?: string;
  contentEncoding?: string;
  metadata?: Record<string, unknown>;
}
interface GcsFile extends GcsGenerationTarget {
  save(
    bytes: Buffer,
    options: {
      resumable: false;
      validation: "crc32c";
      preconditionOpts: { ifGenerationMatch: 0 };
      metadata: {
        contentType: string;
        cacheControl: string;
        metadata: Record<string, string>;
      };
    },
  ): Promise<unknown>;
  getMetadata(): Promise<[GcsMetadata, ...unknown[]]>;
  createReadStream(options: {
    validation: "crc32c";
    decompress: false;
  }): AsyncIterable<Uint8Array>;
}
export interface ResultHistoryGcsClient {
  bucket(bucket: string): {
    file(key: string, options?: { generation: string }): GcsFile;
  };
}

/** SDK and server-side credentials are supplied by the API/sweeper registry. */
export class ResultHistoryGcsStore implements ResultHistoryArchiveStore {
  constructor(private readonly storage: ResultHistoryGcsClient) {}
  async put(
    bucket: string,
    sourceInstance: string,
    source: ResultHistorySource,
  ): Promise<ResultHistoryArchiveIdentity> {
    if (!bucket.trim() || bucket.includes("/"))
      throw new Error("Result history archive bucket is required");
    const encoded = encodeResultHistory(sourceInstance, source);
    const key = objectKey({
      sourceInstance,
      ...source,
      storedSha256: encoded.storedSha256,
    });
    const file = this.storage.bucket(bucket).file(key);
    try {
      await file.save(encoded.stored, {
        resumable: false,
        validation: "crc32c",
        preconditionOpts: { ifGenerationMatch: 0 },
        metadata: {
          contentType: "application/gzip",
          cacheControl: "private, max-age=31536000, immutable",
          metadata: {
            format: "result-history-v1",
            sha256: encoded.storedSha256,
          },
        },
      });
    } catch (error) {
      if (Number((error as { code?: unknown })?.code) !== 412) throw error;
    }
    const [metadata] = await file.getMetadata();
    const identity: ResultHistoryArchiveIdentity = {
      sourceInstance,
      sourceKind: source.sourceKind,
      resultId: source.resultId,
      resultAttemptId: source.resultAttemptId,
      sourceSha256: encoded.sourceSha256,
      sourceByteSize: encoded.sourceByteSize,
      envelopeSha256: encoded.envelopeSha256,
      envelopeByteSize: encoded.envelopeByteSize,
      storedSha256: encoded.storedSha256,
      storedByteSize: encoded.storedByteSize,
      bucket,
      objectKey: key,
      generation: String(metadata.generation ?? ""),
      crc32c: String(metadata.crc32c ?? ""),
      verifiedAt: new Date(),
    };
    await this.read(identity);
    return { ...identity, verifiedAt: new Date() };
  }
  async read(
    identity: ResultHistoryArchiveIdentity,
  ): Promise<ResultHistoryEnvelope> {
    assertResultHistoryArchive(identity);
    const file = pinExactGcsGeneration(
      this.storage
        .bucket(identity.bucket)
        .file(identity.objectKey, { generation: identity.generation }),
      identity.generation,
    );
    const [metadata] = await file.getMetadata();
    if (
      String(metadata.generation) !== identity.generation ||
      Number(metadata.size) !== identity.storedByteSize ||
      metadata.contentType !== "application/gzip" ||
      metadata.contentEncoding ||
      metadata.crc32c !== identity.crc32c ||
      metadata.metadata?.format !== "result-history-v1" ||
      metadata.metadata?.sha256 !== identity.storedSha256
    )
      throw new Error("Result history pinned generation metadata changed");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of file.createReadStream({
      validation: "crc32c",
      decompress: false,
    })) {
      const chunk = Buffer.from(raw);
      size += chunk.length;
      if (
        size > identity.storedByteSize ||
        size > MAX_RESULT_HISTORY_STORED_BYTES
      )
        throw new Error(
          "Result history archive exceeds its declared byte limit",
        );
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (crc32c(bytes) !== identity.crc32c)
      throw new Error("Result history archive failed CRC32C verification");
    return decodeResultHistory(bytes, identity);
  }
}
