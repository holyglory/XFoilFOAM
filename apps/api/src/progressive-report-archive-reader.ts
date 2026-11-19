import { Storage } from "@google-cloud/storage";
import type { DB } from "@aerodb/db/client";
import { installProgressiveReportArchiveReader } from "@aerodb/db/progressive-report-reader";
import {
  assertProgressiveReportArchiveIdentity,
  readProgressiveReportArchiveText,
  type ProgressiveReportArchiveReadIdentity,
} from "@aerodb/db/progressive-report-archive";
import { env } from "./env";

let storage: Storage | null = null;

export async function installApiReportArchiveReader(db: DB): Promise<void> {
  if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver") {
    const { readStoredWorkerArchiveText } = await import("../../sweeper/src/report-archive-broker-client");
    installProgressiveReportArchiveReader({
      read: (identity) => readStoredWorkerArchiveText(db, identity),
    });
  } else if (env.evidenceBucket) {
    installProgressiveReportArchiveReader({ read: readProgressiveReportArchive });
  }
}

export async function readProgressiveReportArchive(
  identity: ProgressiveReportArchiveReadIdentity,
): Promise<string> {
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

  return readProgressiveReportArchiveText(
    file.createReadStream({ validation: "crc32c", decompress: false }),
    identity,
  );
}
