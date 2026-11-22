import { constants } from "node:fs";
import { open, mkdir, link, unlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  assertSolverHistoryArchive,
  decodeSolverHistory,
  encodeSolverHistory,
  type SolverHistoryArchiveIdentity,
  type SolverHistoryEnvelope,
  type SolverHistorySource,
} from "./solver-history-storage";
import {
  assertResultHistoryArchive,
  decodeResultHistory,
  encodeResultHistory,
  MAX_RESULT_HISTORY_STORED_BYTES,
  crc32c,
  type ResultHistoryArchiveIdentity,
  type ResultHistoryEnvelope,
  type ResultHistorySource,
} from "./result-history-storage";

export type PointHistoryIdentity =
  | SolverHistoryArchiveIdentity
  | ResultHistoryArchiveIdentity;
export type PointHistorySource = SolverHistorySource | ResultHistorySource;
export type PointHistoryEnvelope =
  | SolverHistoryEnvelope
  | ResultHistoryEnvelope;
export const MAX_POINT_HISTORY_PACKED_BYTES = MAX_RESULT_HISTORY_STORED_BYTES;
export const POINT_HISTORY_KINDS = [
  "force_history",
  "steady_history",
  "frame_track",
] as const;
export type PointHistoryKind = (typeof POINT_HISTORY_KINDS)[number];
export function pointHistoryKey(
  instance: string,
  source: Pick<PointHistorySource, "sourceKind" | "resultId"> & {
    sourceId?: string;
  },
  hash: string,
) {
  return source.sourceKind === "force_history"
    ? `solver-histories/v1/${instance}/${source.sourceId}/${hash}.json.gz`
    : `result-histories/v1/${instance}/${source.sourceKind}/${source.resultId}/${hash}.json.gz`;
}
export function encodePointHistory(
  instance: string,
  source: PointHistorySource,
) {
  return source.sourceKind === "force_history"
    ? encodeSolverHistory(instance, source)
    : encodeResultHistory(instance, source);
}
export function assertPointHistoryIdentity(
  identity: PointHistoryIdentity,
): void {
  if (typeof identity.generation !== "string")
    throw new Error("Exact decimal generation required");
  if (identity.sourceKind === "force_history")
    assertSolverHistoryArchive(identity);
  else assertResultHistoryArchive(identity);
  if (
    identity.objectKey !==
      pointHistoryKey(
        identity.sourceInstance,
        identity,
        identity.storedSha256,
      ) ||
    BigInt(identity.generation) > 18446744073709551615n
  )
    throw new Error("Point history identity differs from its canonical key");
}
export { crc32c as pointHistoryCrc32c };

/** Restore typed fields after JSON transport. Keep receipts metadata-only even
 * when their source is a catalog row with inline_metadata or a test source. */
export function historyArchiveIdentity(
  value: PointHistoryIdentity,
): PointHistoryIdentity {
  const {
    sourceInstance,
    resultId,
    resultAttemptId,
    sourceSha256,
    sourceByteSize,
    envelopeSha256,
    envelopeByteSize,
    storedSha256,
    storedByteSize,
    bucket,
    objectKey,
    generation,
    crc32c,
  } = value;
  const common = {
    sourceInstance,
    resultId,
    resultAttemptId,
    sourceSha256,
    sourceByteSize,
    envelopeSha256,
    envelopeByteSize,
    storedSha256,
    storedByteSize,
    bucket,
    objectKey,
    generation,
    crc32c,
  };
  const identity: PointHistoryIdentity =
    value.sourceKind === "force_history"
      ? { ...common, sourceKind: value.sourceKind, sourceId: value.sourceId }
      : {
          ...common,
          sourceKind: value.sourceKind,
          resultId: value.resultId,
          verifiedAt: new Date(value.verifiedAt),
        };
  assertPointHistoryIdentity(identity);
  return identity;
}
export function decodePointHistory(
  bytes: Buffer,
  identity: PointHistoryIdentity,
): PointHistoryEnvelope {
  assertPointHistoryIdentity(identity);
  if (
    bytes.length !== identity.storedByteSize ||
    bytes.length > MAX_POINT_HISTORY_PACKED_BYTES ||
    crc32c(bytes) !== identity.crc32c
  )
    throw new Error("Point history working bytes failed size/CRC verification");
  return identity.sourceKind === "force_history"
    ? decodeSolverHistory(bytes, identity)
    : decodeResultHistory(bytes, identity);
}
export function pointHistoryWorkingRoot() {
  return join(
    process.env.MEDIA_DIR ||
      process.env.AIRFOILFOAM_DATA_DIR ||
      "/data/airfoilfoam",
    "point-histories/v1",
  );
}
function location(identity: PointHistoryIdentity, root: string) {
  assertPointHistoryIdentity(identity);
  if (!isAbsolute(root) || resolve(root) !== root)
    throw new Error("Point history working root must be absolute");
  return join(
    root,
    identity.storedSha256.slice(0, 2),
    `${identity.storedSha256}.json.gz`,
  );
}
async function syncDirectory(path: string) {
  const fd = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await fd.sync();
  } finally {
    await fd.close();
  }
}
async function readWorkingFile(
  identity: PointHistoryIdentity,
  root = pointHistoryWorkingRoot(),
): Promise<Buffer> {
  const path = location(identity, root);
  if ((await realpath(dirname(path))) !== dirname(path))
    throw new Error("Point history working path changed");
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await fd.stat();
    if (!stat.isFile() || stat.size !== identity.storedByteSize)
      throw new Error("Point history working size differs");
    // Read no more than the declared size even if a corrupt writer grows it.
    const bytes = Buffer.alloc(identity.storedByteSize + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await fd.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset);
  } finally {
    await fd.close();
  }
}
export async function readPointHistoryWorkingCopy(
  identity: PointHistoryIdentity,
  root = pointHistoryWorkingRoot(),
) {
  return decodePointHistory(await readWorkingFile(identity, root), identity);
}
/** No eviction: these immutable files are the credentialless API's working data. */
export async function retainPointHistoryWorkingCopy(
  bytes: Buffer,
  identity: PointHistoryIdentity,
  root = pointHistoryWorkingRoot(),
) {
  decodePointHistory(bytes, identity);
  const path = location(identity, root),
    directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o755 });
  if ((await realpath(directory)) !== directory)
    throw new Error("Point history working path changed");
  const temporary = join(directory, `.point-${randomUUID()}.tmp`),
    fd = await open(temporary, "wx", 0o644);
  try {
    try {
      await fd.writeFile(bytes);
      await fd.sync();
    } finally {
      await fd.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await syncDirectory(directory);
    await syncDirectory(root);
    await syncDirectory(dirname(root));
    await syncDirectory(dirname(dirname(root)));
    if (!(await readWorkingFile(identity, root)).equals(bytes))
      throw new Error("Point history durable restore differs");
    return {
      storedSha256: identity.storedSha256,
      storedByteSize: bytes.length,
      verified: true as const,
    };
  } finally {
    await unlink(temporary);
  }
}

/** Stable protocol identity independent of Date serialization or DB-only fields. */
export function pointHistoryIdentityDigest(identity: PointHistoryIdentity) {
  assertPointHistoryIdentity(identity);
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity.sourceInstance,
        identity.sourceKind,
        identity.sourceKind === "force_history" ? identity.sourceId : null,
        identity.resultId,
        identity.resultAttemptId,
        identity.sourceSha256,
        identity.sourceByteSize,
        identity.envelopeSha256,
        identity.envelopeByteSize,
        identity.storedSha256,
        identity.storedByteSize,
        identity.bucket,
        identity.objectKey,
        identity.generation,
        identity.crc32c,
      ]),
    )
    .digest("hex");
}
