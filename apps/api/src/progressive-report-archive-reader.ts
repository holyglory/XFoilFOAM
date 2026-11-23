import { CRC32C, Storage } from "@google-cloud/storage";
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  DEFAULT_PROGRESSIVE_REPORT_READ_TIMEOUT_MS,
  installProgressiveReportArchiveReader,
  ProgressiveReportArchiveTimeout,
} from "@aerodb/db/progressive-report-reader";
import {
  assertProgressiveReportArchiveIdentity,
  readProgressiveReportArchiveText,
  type ProgressiveReportArchiveReadIdentity,
} from "@aerodb/db/progressive-report-archive";
import { env } from "./env";

let storage: Storage | null = null;

export async function installApiReportArchiveReader(): Promise<void> {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver") {
    const { readStoredWorkerArchiveText } =
      await import("../../sweeper/src/report-archive-broker-client");
    installProgressiveReportArchiveReader({
      // Owner/credential lookups use the connection that selected the report,
      // including its transaction when a sync import already holds a slot.
      read: (identity, connection) =>
        readStoredWorkerArchiveText(connection, identity),
    });
  } else if (env.evidenceBucket) {
    installProgressiveReportArchiveReader({
      read: readProgressiveReportArchive,
    });
  }
}

async function pinnedReportFile(
  identity: ProgressiveReportArchiveReadIdentity & { signal?: AbortSignal },
) {
  identity.signal?.throwIfAborted();
  const configuredBucket = env.evidenceBucket?.trim();
  if (!configuredBucket || identity.bucket !== configuredBucket)
    throw new Error("Progressive report archive bucket is not configured");
  assertProgressiveReportArchiveIdentity(identity);

  storage ??= new Storage();
  const file = storage
    .bucket(identity.bucket)
    .file(identity.objectKey, { generation: identity.generation });
  // Storage 7.16 rounds FileOptions.generation internally; the final request
  // interceptor keeps metadata and media requests pinned to the exact string.
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
  const [metadata] = await file.getMetadata();
  identity.signal?.throwIfAborted();
  const custom = (metadata.metadata ?? {}) as Record<string, unknown>;
  if (
    String(metadata.generation) !== identity.generation ||
    String(metadata.size) !== String(identity.storedByteSize) ||
    metadata.crc32c !== identity.crc32c ||
    metadata.contentType !== identity.mimeType ||
    custom.sha256 !== identity.storedSha256 ||
    custom.byteSize !== String(identity.storedByteSize)
  )
    throw new Error("Progressive report archive metadata changed");

  return file;
}

export async function readProgressiveReportArchive(
  identity: ProgressiveReportArchiveReadIdentity & { signal?: AbortSignal },
): Promise<string> {
  const file = await pinnedReportFile(identity);
  return readProgressiveReportArchiveText(
    file.createReadStream({ validation: "crc32c", decompress: false }),
    identity,
    identity.signal,
  );
}

/** A receipted point can independently reproduce its signed content. Verify
 * the complete compressed generation against the original full-bundle proof
 * before reusing its immutable, SQL-authenticated member registration. */
export async function verifyRetainedReportGeneration(
  identity: ProgressiveReportArchiveReadIdentity,
): Promise<void> {
  if (identity.sourceKind !== "remote" || identity.memberKind !== "report")
    throw new Error("Expected a registered hub report member");
  const controller = new AbortController();
  const scoped = {
    ...identity,
    sourceKind: "remote" as const,
    memberKind: "report" as const,
    signal: controller.signal,
  };
  const read = async () => {
    const file = await pinnedReportFile(scoped);
    const hash = createHash("sha256"),
      crc = new CRC32C();
    let bytes = 0;
    await pipeline(
      file.createReadStream({ validation: "crc32c", decompress: false }),
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > identity.storedByteSize)
            return callback(new Error("Report exceeded its registered size"));
          hash.update(chunk);
          crc.update(chunk);
          callback();
        },
      }),
      { signal: scoped.signal },
    );
    if (
      bytes !== identity.storedByteSize ||
      hash.digest("hex") !== identity.storedSha256 ||
      crc.toString() !== identity.crc32c
    )
      throw new Error(
        "Retained report generation failed its stored-byte proof",
      );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ProgressiveReportArchiveTimeout(scoped));
          controller.abort();
        }, DEFAULT_PROGRESSIVE_REPORT_READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
