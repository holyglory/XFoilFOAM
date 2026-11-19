import { Storage, type File } from "@google-cloud/storage";
import { createHash, randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { finished } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC32C = /^[A-Za-z0-9+/]{6}==$/;

export interface ProgressiveReportArchiveIdentity {
  bucket: string;
  objectKey: string;
  generation: string;
  mimeType: string;
  compression: "gzip";
  archiveFormat: "jsonl";
  storedSha256: string;
  storedByteSize: number;
  crc32c: string;
  verifiedAt: Date;
}

export interface ProgressiveReportArchiveMember {
  sourceKind: "remote" | "worker";
  executionId: string;
  sequence: number;
  memberKind: "report" | "conflict";
  contentSignature: string;
  reportSha256: string;
  reportByteSize: number;
}

function assertIdentity(identity: ProgressiveReportArchiveIdentity): void {
  if (
    !identity.bucket.trim() ||
    !identity.objectKey.trim() ||
    !GENERATION.test(identity.generation) ||
    !SHA256.test(identity.storedSha256) ||
    !CRC32C.test(identity.crc32c) ||
    !Number.isSafeInteger(identity.storedByteSize) ||
    identity.storedByteSize <= 0
  )
    throw new Error("Invalid progressive report archive identity");
}

async function sha256File(path: string): Promise<{
  sha256: string;
  byteSize: number;
}> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const raw of createReadStream(path)) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    hash.update(chunk);
    byteSize += chunk.byteLength;
  }
  return {sha256: hash.digest("hex"), byteSize};
}

async function writeGzipJsonLines(
  path: string,
  lines: AsyncIterable<string>,
): Promise<void> {
  const output = createWriteStream(path, {mode: 0o600});
  const gzip = createGzip({level: 9});
  gzip.pipe(output);
  try {
    for await (const line of lines) {
      if (!gzip.write(`${line}\n`)) {
        await new Promise<void>((resolve, reject) => {
          gzip.once("drain", resolve);
          gzip.once("error", reject);
        });
      }
    }
    gzip.end();
    await finished(output);
  } catch (error) {
    gzip.destroy();
    output.destroy();
    throw error;
  }
}

export class ProgressiveReportArchiveStore {
  private readonly storage: Storage;
  private readonly prefix: string;

  constructor(
    private readonly bucketName: string,
    prefix = process.env.AIRFOILFOAM_REPORT_ARCHIVE_PREFIX ??
      "progressive-reports/v1",
    storage = new Storage(),
  ) {
    if (!bucketName.trim()) throw new Error("Report archive bucket is required");
    this.storage = storage;
    this.prefix = prefix.replace(/^\/+|\/+$/g, "");
    if (!this.prefix || this.prefix.split("/").some((part) => part === "." || part === ".."))
      throw new Error("Report archive prefix is invalid");
  }

  temporaryPath(): string {
    return join(tmpdir(), `xfoilfoam-progressive-reports-${randomUUID()}.jsonl.gz`);
  }

  async removeTemporary(path: string): Promise<void> {
    await unlink(path).catch(() => undefined);
  }

  async writeBundle(
    path: string,
    lines: AsyncIterable<string>,
  ): Promise<{sha256: string; byteSize: number}> {
    await mkdir(tmpdir(), {recursive: true});
    await writeGzipJsonLines(path, lines);
    const identity = await sha256File(path);
    if (!SHA256.test(identity.sha256) || identity.byteSize <= 0)
      throw new Error("Progressive report archive failed local identity proof");
    return identity;
  }

  async putFile(
    path: string,
    identity: {sha256: string; byteSize: number},
    sourceKind: "remote" | "worker",
    executionId: string,
  ): Promise<ProgressiveReportArchiveIdentity> {
    if (!SHA256.test(identity.sha256) || !Number.isSafeInteger(identity.byteSize) || identity.byteSize <= 0)
      throw new Error("Invalid local report archive identity");
    const objectKey = `${this.prefix}/${sourceKind}/${executionId}/${identity.sha256}.jsonl.gz`;
    const bucket = this.storage.bucket(this.bucketName);
    let created = true;
    try {
      await bucket.upload(path, {
        destination: objectKey,
        resumable: true,
        validation: "crc32c",
        preconditionOpts: {ifGenerationMatch: 0},
        metadata: {
          cacheControl: "private, max-age=31536000, immutable",
          contentType: "application/gzip",
          metadata: {
            sha256: identity.sha256,
            byteSize: String(identity.byteSize),
            sourceKind,
            executionId,
            archiveFormat: "jsonl",
          },
        },
      });
    } catch (error) {
      const code = Number((error as {code?: unknown})?.code);
      if (code !== 412) throw error;
      created = false;
    }
    const file = bucket.file(objectKey);
    const [metadata] = await file.getMetadata();
    const generation = String(metadata.generation ?? "");
    const crc32c = String(metadata.crc32c ?? "");
    const custom = (metadata.metadata ?? {}) as Record<string, unknown>;
    if (
      !GENERATION.test(generation) ||
      !CRC32C.test(crc32c) ||
      Number(metadata.size) !== identity.byteSize ||
      metadata.contentType !== "application/gzip" ||
      custom.sha256 !== identity.sha256 ||
      custom.byteSize !== String(identity.byteSize) ||
      custom.sourceKind !== sourceKind ||
      custom.executionId !== executionId ||
      custom.archiveFormat !== "jsonl"
    ) {
      throw new Error(`Report archive ${created ? "upload" : "existing object"} metadata changed`);
    }
    const remote = await sha256FileFromGcs(file);
    if (remote.sha256 !== identity.sha256 || remote.byteSize !== identity.byteSize)
      throw new Error("Report archive GCS readback failed exact SHA-256 verification");
    const result: ProgressiveReportArchiveIdentity = {
      bucket: this.bucketName,
      objectKey,
      generation,
      mimeType: "application/gzip",
      compression: "gzip",
      archiveFormat: "jsonl",
      storedSha256: identity.sha256,
      storedByteSize: identity.byteSize,
      crc32c,
      verifiedAt: new Date(),
    };
    assertIdentity(result);
    return result;
  }

  async readBundle(identity: ProgressiveReportArchiveIdentity): Promise<string> {
    assertIdentity(identity);
    const file = this.storage
      .bucket(identity.bucket)
      .file(identity.objectKey, {generation: identity.generation});
    const chunks: Buffer[] = [];
    const hash = createHash("sha256");
    let size = 0;
    for await (const raw of file.createReadStream({validation: true})) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      hash.update(chunk);
      size += chunk.byteLength;
      chunks.push(chunk);
    }
    if (size !== identity.storedByteSize || hash.digest("hex") !== identity.storedSha256)
      throw new Error("Report archive readback failed its immutable identity check");
    return Buffer.concat(chunks).toString("utf8");
  }
}

async function sha256FileFromGcs(
  file: File,
): Promise<{sha256: string; byteSize: number}> {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const raw of file.createReadStream({validation: true})) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    hash.update(chunk);
    byteSize += chunk.byteLength;
  }
  return {sha256: hash.digest("hex"), byteSize};
}
