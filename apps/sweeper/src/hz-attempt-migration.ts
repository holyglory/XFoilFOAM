import { Readable } from "node:stream";
import type { AttemptEvidenceArchiveIdentity } from "@aerodb/db/attempt-evidence-catalog";
import type { AttemptEvidenceFreshVerification } from "@aerodb/db/attempt-evidence-projection";
import { readAttemptEvidenceCopy } from "./attempt-evidence-archive";
import { packedBytes } from "./hz-attempt-custody";
import { HistoryOperationError, SETTLED_REPORT_SIZE_LIMIT } from "@aerodb/core/point-history-protocol";
export interface AttemptRelay {
  worker: (request: Record<string, unknown>, write?: boolean) => Promise<any>;
  api: (request: Record<string, unknown>) => Promise<any>;
  hub: (request: Record<string, unknown>) => Promise<any>;
}
function checkApp(
  value: Record<string, any>,
  id: string,
  archive: string,
  identity: AttemptEvidenceArchiveIdentity,
  forced: boolean,
) {
  if (
    value.source !== "worker-volume" ||
    value.attemptId !== id ||
    value.archiveId !== archive ||
    value.forceArchive !== forced ||
    value.sourceSha256 !== identity.sourceSha256 ||
    value.sourceByteSize !== identity.sourceByteSize
  )
    throw Error("Wrong HZ application readback");
}
/** Each RPC owns at most one bounded host lock. The 0207 catalog and pending
 * 0208 event survive a lost controller reply at every boundary. */
export async function migrateHzAttempt(
  relay: AttemptRelay,
  id: string,
  instance: string,
  restore = false,
) {
  try {
    return await transferHzAttempt(relay, id, instance, restore);
  } catch (error) {
    // A report can change representation after selection. The transition
    // restores a committed row before propagating a failed post-read.
    if (!restore && error instanceof HistoryOperationError &&
        error.operation === SETTLED_REPORT_SIZE_LIMIT && error.category === "input")
      return { limited: SETTLED_REPORT_SIZE_LIMIT };
    throw error;
  }
}

async function transferHzAttempt(relay: AttemptRelay, id: string, instance: string, restore: boolean) {
  const prep = await relay.worker({ operation: "prepare", attemptId: id });
  if (prep.limited) return { limited: prep.limited };
  if (restore && !prep.cold) return { alreadyInline: true };
  const fresh = await relay.hub(
    prep.archive
      ? { operation: "read", identity: prep.archive }
      : {
          operation: "put",
          instance: prep.instance,
          solver: prep.solver,
          proof: prep.proof,
          packed: prep.packed,
        },
  );
  const identity = fresh.identity as AttemptEvidenceArchiveIdentity;
  if (identity.attemptId !== id || identity.sourceInstance !== instance)
    throw Error("Unexpected GCS attempt owner");
  const packed = packedBytes(fresh.packed);
  await readAttemptEvidenceCopy(Readable.from([packed]), identity);
  if (restore)
    return {
      restored: await relay.worker(
        {
          operation: "restore",
          attemptId: id,
          archiveId: prep.archive.id,
          eventId: prep.eventId,
          ...fresh,
          pending: false,
        },
        true,
      ),
    };
  let catalog;
  try {
    catalog = await relay.worker(
      { operation: "stage", enable: !prep.cold, ...fresh },
      true,
    );
  } catch (error) {
    if (
      prep.cold &&
      !(error instanceof HistoryOperationError && error.retryable)
    )
      await relay.worker(
        {
          operation: "restore",
          attemptId: id,
          archiveId: prep.archive.id,
          eventId: prep.eventId,
          ...fresh,
          pending: false,
        },
        true,
      );
    throw error;
  }
  if (
    catalog.attemptId !== id ||
    (prep.archive && catalog.id !== prep.archive.id)
  )
    throw Error("Changed HZ catalog");
  const archiveId = catalog.id,
    owner = { attemptId: id, archiveId };
  let eventId = prep.eventId,
    measurement;
  if (!prep.cold) {
    await relay.worker({ operation: "replay", ...owner }, true);
    const dependencies = await relay.worker({ operation: "science", ...owner });
    const app = await relay.api({
      operation: "api",
      ...owner,
      forceArchive: true,
    });
    checkApp(app, id, archiveId, identity, true);
    // Refresh the *recorded* generation after potentially slow scientific reads.
    const verified = await relay.hub({ operation: "read", identity });
    if (
      verified.identity.generation !== identity.generation ||
      verified.identity.objectKey !== identity.objectKey ||
      verified.identity.bucket !== identity.bucket ||
      !packedBytes(verified.packed).equals(packed)
    )
      throw Error("Fresh generation changed");
    const proof: AttemptEvidenceFreshVerification = {
      direct: {
        ...owner,
        bucket: identity.bucket,
        objectKey: identity.objectKey,
        generation: identity.generation,
        crc32c: identity.crc32c,
        storedSha256: identity.storedSha256,
        storedByteSize: identity.storedByteSize,
        sourceSha256: identity.sourceSha256,
        sourceByteSize: identity.sourceByteSize,
        verifiedAt: verified.identity.verifiedAt,
      },
      app,
      dependencies,
    };
    measurement = await relay.worker(
      { operation: "commit", ...owner, proof },
      true,
    );
    if (measurement.limited) return { limited: measurement.limited };
    eventId = measurement.eventId;
  }
  try {
    const app = await relay.api({
      operation: "api",
      ...owner,
      forceArchive: false,
    });
    checkApp(app, id, archiveId, identity, false);
    await relay.worker({ operation: "replay", ...owner }, true);
    await relay.worker({ operation: "confirm", ...owner, eventId, app }, true);
  } catch (error) {
    // A deploy pause or disconnected confirmation may already have committed.
    // Re-enter through the durable event. Other failures restore pending rows.
    if (!(error instanceof HistoryOperationError && error.retryable))
      await relay.worker(
        {
          operation: "restore",
          ...owner,
          eventId,
          ...fresh,
          pending: !prep.cold,
        },
        true,
      );
    throw error;
  }
  return {
    attemptId: id,
    archiveId,
    eventId,
    generation: identity.generation,
    alreadyShortened: prep.cold || measurement?.alreadyShortened === true,
    payloadBytesReclaimed: measurement?.payloadBytesReclaimed ?? 0,
    netValueBytesReclaimed: measurement?.netValueBytesReclaimed ?? 0,
  };
}
