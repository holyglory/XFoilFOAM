import { createHash } from "node:crypto";
import { join } from "node:path";
import { Readable } from "node:stream";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import {
  assertAttemptEvidenceArchive,
  type AttemptEvidenceArchiveIdentity,
} from "@aerodb/db/attempt-evidence-catalog";
import { readAttemptEvidenceCopy } from "./attempt-evidence-archive";
import {
  readWorkerReportVolume,
  storeWorkerReportVolume,
} from "./worker-report-volume";

export function hzAttemptKey(
  instance: string,
  identity: Pick<
    AttemptEvidenceArchiveIdentity,
    "attemptId" | "sourceSha256" | "storedSha256"
  >,
) {
  return `attempt-evidence/v1/${instance}/${identity.attemptId}/${identity.sourceSha256}/${identity.storedSha256}.json.gz`;
}
/** A file is addressable only by its complete, locally admitted 0207 receipt.
 * A foreign generation with identical content gets a different location. */
function location(i: AttemptEvidenceArchiveIdentity) {
  assertAttemptEvidenceArchive(i);
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(i.sourceInstance))
    throw new Error(
      "HZ attempt working storage is not configured for this source instance",
    );
  if (
    process.env.AIRFOILFOAM_DEPLOYMENT_ROLE !== "remote-solver" ||
    i.objectKey !== hzAttemptKey(i.sourceInstance, i)
  )
    throw new Error("Invalid HZ attempt archive owner");
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        i.sourceInstance,
        i.attemptId,
        i.resultId,
        i.simJobId,
        i.bucket,
        i.objectKey,
        i.generation,
        i.sourceSha256,
        i.sourceByteSize,
        i.envelopeSha256,
        i.envelopeByteSize,
        i.storedSha256,
        i.storedByteSize,
        i.crc32c,
      ]),
    )
    .digest("hex");
  return join(
    process.env.MEDIA_DIR ||
      process.env.AIRFOILFOAM_DATA_DIR ||
      "/data/airfoilfoam",
    "attempt-histories",
    "v1",
    key,
  );
}
export async function assertHzAttemptOwner(
  db: DB,
  i: AttemptEvidenceArchiveIdentity,
) {
  location(i);
  const [owner] = await db.execute(
    sql`SELECT instance_id::text AS instance FROM sync_api_settings WHERE id=1`,
  );
  if (owner?.instance !== i.sourceInstance)
    throw new Error("Foreign HZ attempt archive instance");
}
/** Implements AttemptEvidenceArchiveReader.read, including use before a
 * projection/publication transaction. It never opens a DB or cloud client. */
export async function readHzAttemptWorkingCopy(
  i: AttemptEvidenceArchiveIdentity,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const stream = await readWorkerReportVolume(i, location(i));
  if (!stream) throw new Error("Exact HZ attempt working copy is unavailable");
  return readAttemptEvidenceCopy(stream, i, { signal });
}
export async function retainHzAttemptVolume(
  db: DB,
  i: AttemptEvidenceArchiveIdentity,
  packed: Buffer,
) {
  await assertHzAttemptOwner(db, i);
  const source = await readAttemptEvidenceCopy(Readable.from([packed]), i);
  await storeWorkerReportVolume(Readable.from([packed]), i, location(i));
  const restored = await readHzAttemptWorkingCopy(i);
  if (restored.payloadText !== source.payloadText)
    throw new Error("HZ working copy differs after fsync");
  return restored;
}
