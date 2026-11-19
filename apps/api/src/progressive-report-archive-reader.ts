import { Storage } from "@google-cloud/storage";
import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { env } from "./env";

const SHA256 = /^[a-f0-9]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC32C = /^[A-Za-z0-9+/]{6}==$/;

let storage: Storage | null = null;

export async function readProgressiveReportArchive(identity: {
  bucket: string;
  objectKey: string;
  generation: string;
  mimeType: string;
  compression: string;
  archiveFormat: string;
  storedSha256: string;
  storedByteSize: number;
  crc32c: string;
  executionId: string;
  sequence: number;
  signature: string;
}): Promise<unknown> {
  const configuredBucket = env.evidenceBucket?.trim();
  if (!configuredBucket || identity.bucket !== configuredBucket)
    throw new Error("Progressive report archive bucket is not configured");
  if (
    identity.mimeType !== "application/gzip" ||
    identity.compression !== "gzip" ||
    identity.archiveFormat !== "jsonl" ||
    !GENERATION.test(identity.generation) ||
    !SHA256.test(identity.storedSha256) ||
    !CRC32C.test(identity.crc32c) ||
    !Number.isSafeInteger(identity.storedByteSize) ||
    identity.storedByteSize <= 0
  )
    throw new Error("Progressive report archive identity is invalid");

  storage ??= new Storage();
  const file = storage
    .bucket(identity.bucket)
    .file(identity.objectKey, {generation: identity.generation});
  const [metadata] = await file.getMetadata();
  const custom = (metadata.metadata ?? {}) as Record<string, unknown>;
  if (
    metadata.generation !== identity.generation ||
    Number(metadata.size) !== identity.storedByteSize ||
    metadata.crc32c !== identity.crc32c ||
    metadata.contentType !== identity.mimeType ||
    custom.sha256 !== identity.storedSha256 ||
    custom.byteSize !== String(identity.storedByteSize)
  )
    throw new Error("Progressive report archive metadata changed");

  const raw = file.createReadStream({validation: true});
  const hash = createHash("sha256");
  let byteSize = 0;
  raw.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteSize += bytes.byteLength;
    hash.update(bytes);
  });
  const gunzip = raw.pipe(createGunzip());
  const lines = createInterface({input: gunzip, crlfDelay: Infinity});
  let found: unknown = null;
  for await (const line of lines) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (
      entry.kind === "report" &&
      entry.sourceKind === "remote" &&
      entry.executionId === identity.executionId &&
      Number(entry.sequence) === identity.sequence &&
      entry.contentSignature === identity.signature
    ) {
      found = entry.report;
    }
  }
  if (byteSize !== identity.storedByteSize || hash.digest("hex") !== identity.storedSha256)
    throw new Error("Progressive report archive failed full readback verification");
  if (!found) throw new Error("Progressive report archive member was not found");
  return found;
}
