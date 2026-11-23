import { Storage } from "@google-cloud/storage";
import {
  assertProgressiveReportArchiveIdentity,
  readProgressiveReportArchiveBundle,
  readProgressiveReportArchiveText,
  validatedProgressiveReportArchiveLines,
  verifyProgressiveReportArchive,
  type ProgressiveReportArchiveReadIdentity,
} from "@aerodb/db/progressive-report-archive";
import { createHash, randomUUID } from "node:crypto";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSharedReport, SHARED_REPORT_FORMAT } from "./shared-report-archive";
import { HubReportObjects, putImmutableReportObject } from "./shared-report-objects";

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
  assertProgressiveReportArchiveIdentity(identity);
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
  return { sha256: hash.digest("hex"), byteSize };
}

/** No Storage client or credentials are needed; the caller owns directory cleanup. */
export async function writeProgressiveReportBundle(
  path: string,
  lines: AsyncIterable<string>,
): Promise<{ sha256: string; byteSize: number }> {
  await pipeline(
    Readable.from(validatedProgressiveReportArchiveLines(lines)),
    createGzip({ level: 9 }),
    createWriteStream(path, { mode: 0o600, flags: "wx" }),
  );
  return sha256File(path);
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
    if (!bucketName.trim())
      throw new Error("Report archive bucket is required");
    this.storage = storage;
    this.prefix = prefix.replace(/^\/+|\/+$/g, "");
    if (
      !this.prefix ||
      this.prefix.split("/").some((part) => part === "." || part === "..")
    )
      throw new Error("Report archive prefix is invalid");
  }

  temporaryPath(): string {
    return join(
      tmpdir(),
      `xfoilfoam-progressive-reports-${randomUUID()}.jsonl.gz`,
    );
  }

  async removeTemporary(path: string): Promise<void> {
    await unlink(path).catch(() => undefined);
  }

  async writeBundle(
    path: string,
    lines: AsyncIterable<string>,
  ): Promise<{ sha256: string; byteSize: number }> {
    return writeProgressiveReportBundle(path, lines);
  }

  async putFile(
    path: string,
    identity: { sha256: string; byteSize: number },
    sourceKind: "remote" | "worker",
    executionId: string,
  ): Promise<ProgressiveReportArchiveIdentity> {
    if (
      !SHA256.test(identity.sha256) ||
      !Number.isSafeInteger(identity.byteSize) ||
      identity.byteSize <= 0
    )
      throw new Error("Invalid local report archive identity");
    const objectKey = `${this.prefix}/${sourceKind}/${executionId}/${identity.sha256}.jsonl.gz`;
    const bucket = this.storage.bucket(this.bucketName);
    const {created,file}=await putImmutableReportObject(bucket,objectKey,{path},{
      sha256:identity.sha256,byteSize:String(identity.byteSize),sourceKind,executionId,archiveFormat:"jsonl"
    });
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
      throw new Error(
        `Report archive ${created ? "upload" : "existing object"} metadata changed`,
      );
    }
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
    // Never hash a live/latest object or GCS's transparent decompression. The
    // metadata and bytes must identify the same immutable compressed generation.
    const pinned = this.pinnedFile(result);
    const [pinnedMetadata] = await pinned.getMetadata();
    if (
      String(pinnedMetadata.generation) !== generation ||
      String(pinnedMetadata.size) !== String(identity.byteSize) ||
      pinnedMetadata.crc32c !== crc32c ||
      pinnedMetadata.contentType !== result.mimeType
    )
      throw new Error("Report archive generation metadata changed");
    await verifyProgressiveReportArchive(
      pinned.createReadStream({ validation: "crc32c", decompress: false }),
      result,
    );
    result.verifiedAt = new Date();
    return result;
  }

  async readBundle(
    identity: ProgressiveReportArchiveIdentity,
  ): Promise<string> {
    assertIdentity(identity);
    const file = this.pinnedFile(identity);
    return readProgressiveReportArchiveBundle(
      file.createReadStream({ validation: "crc32c", decompress: false }),
      identity,
    );
  }

  async read(identity: ProgressiveReportArchiveReadIdentity & { signal?: AbortSignal }): Promise<string> {
    if (identity.archiveFormat === SHARED_REPORT_FORMAT) {
      if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver")
        throw new Error("Shared report generations require the configured hub");
      return readSharedReport(new HubReportObjects(this.bucketName, this.prefix, this.storage), identity, identity.signal);
    }
    assertProgressiveReportArchiveIdentity(identity);
    const file = this.pinnedFile(identity);
    return readProgressiveReportArchiveText(
      file.createReadStream({ validation: "crc32c", decompress: false }),
      identity,
    );
  }

  private pinnedFile(identity: {
    bucket: string;
    objectKey: string;
    generation: string;
  }) {
    const file = this.storage
      .bucket(identity.bucket)
      .file(identity.objectKey, { generation: identity.generation });
    // Storage 7.16 converts FileOptions.generation to Number. Override the final
    // metadata/media query through its public interceptor, keeping every digit.
    file.interceptors.push({
      request: (options) => {
        if (!("uri" in options) || typeof options.uri !== "string")
          throw new Error("Report archive request has no string URI");
        return {
          ...options,
          uri: options.uri,
          qs: { ...options.qs, generation: identity.generation },
        };
      },
    });
    return file;
  }
}
