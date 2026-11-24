import { readAttemptWorkerReplayScope } from "@aerodb/db/attempt-evidence-proof-reader";
import { Storage } from "@google-cloud/storage";
import type { DB } from "@aerodb/db/client";
import { sql } from "drizzle-orm";
import type { HzSettledReceiptScope } from "../../sweeper/src/hz-settled-attempt-receipt";
import {
  hydrateAttemptEvidence,
  hydrateAttemptEvidenceBatch,
  readAttemptEvidenceText,
  AttemptEvidenceReadError,
  type AttemptEvidenceArchiveReader,
  type AttemptEvidenceReadOptions,
  type AttemptEvidenceReadRow,
  type AttemptEvidenceTextReadOptions,
} from "@aerodb/db/attempt-evidence-reader";
import { reportTextIdentity } from "@aerodb/db/progressive-report-archive";
import type {
  AttemptEvidenceAppReadRequest,
  AttemptEvidenceAppReadback,
} from "@aerodb/db/attempt-evidence-projection";
import { AttemptEvidenceStore } from "../../sweeper/src/attempt-evidence-store";
import { env } from "./env";
import { installProgressiveRetentionReader } from "@aerodb/db/progressive-remote-retention";

let store: AttemptEvidenceStore | undefined;
/** Existing canonical bucket/credentials only. A bucketless HZ must keep its
 * verified working copy on its own persistent volume. */
export const apiAttemptEvidenceReader: AttemptEvidenceArchiveReader = {
  async read(identity, signal) {
    if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver") {
      const { readHzAttemptWorkingCopy } =
        await import("../../sweeper/src/hz-attempt-volume");
      return readHzAttemptWorkingCopy(identity, signal);
    }
    if (!env.evidenceBucket || identity.bucket !== env.evidenceBucket.trim())
      throw new AttemptEvidenceReadError(
        "unavailable",
        "Canonical attempt archive storage is not configured for this API",
      );
    store ??= new AttemptEvidenceStore(
      new Storage({ retryOptions: { maxRetries: 1, totalTimeout: 30 } }),
    );
    return store.read(identity, signal);
  },
};
installProgressiveRetentionReader(apiAttemptEvidenceReader);

function bounded<T extends AttemptEvidenceReadOptions>(
  options?: T,
): T & { signal: AbortSignal } {
  const deadline = AbortSignal.timeout(30_000);
  return {
    ...options,
    signal: options?.signal
      ? AbortSignal.any([options.signal, deadline])
      : deadline,
  } as T & { signal: AbortSignal };
}

export function readStoredAttemptEvidence<T extends AttemptEvidenceReadRow>(
  db: DB,
  row: T,
  options?: AttemptEvidenceReadOptions,
): Promise<T> {
  return hydrateAttemptEvidence(
    db,
    apiAttemptEvidenceReader,
    row,
    bounded(options),
  );
}
export function readStoredAttemptEvidenceBatch<
  T extends AttemptEvidenceReadRow,
>(
  db: DB,
  rows: readonly T[],
  options?: AttemptEvidenceReadOptions,
): Promise<T[]> {
  return hydrateAttemptEvidenceBatch(
    db,
    apiAttemptEvidenceReader,
    rows,
    bounded(options),
  );
}
export async function readStoredAttemptEvidenceText(
  db: DB,
  attemptId: string,
  options?: AttemptEvidenceTextReadOptions & { source?: "worker-report" },
): Promise<string> {
  if (options?.source === "worker-report") {
    if (options.archiveId || options.forceArchive)
      throw new AttemptEvidenceReadError(
        "invalid",
        "Select one exact attempt archive source",
      );
    if (process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver") {
      const [installed] = await db.execute(sql`SELECT to_regprocedure('attempt_evidence_hz_settled_scope(uuid,uuid)') IS NOT NULL AS ready`);
      const scope = installed?.ready === true
        ? (await readAttemptWorkerReplayScope(db, attemptId)) as HzSettledReceiptScope | undefined : undefined;
      if (scope?.contract === "settled-receipt-v3") {
        const { readSettledWorkerPoint } = await import("../../sweeper/src/hz-settled-attempt-receipt");
        return (await readSettledWorkerPoint(db, scope, bounded(options).signal)).payloadText;
      }
    }
    const { readHzAttemptFromWorkerReport } =
      await import("../../sweeper/src/hz-attempt-report-reader");
    const { payloadText } = await readHzAttemptFromWorkerReport(
      db,
      attemptId,
      bounded(options).signal,
    );
    return payloadText;
  }
  return readAttemptEvidenceText(
    db,
    apiAttemptEvidenceReader,
    attemptId,
    bounded(options),
  );
}

/** Galileo's app-read callback. This always exercises the canonical GCS
 * reader; an inline fast-path success is never reported as archive access. */
export async function readApiAttemptEvidenceForApp(
  db: DB,
  request: AttemptEvidenceAppReadRequest,
): Promise<AttemptEvidenceAppReadback> {
  const text = await readStoredAttemptEvidenceText(db, request.attemptId, {
    signal: request.signal,
    archiveId: request.archiveId,
    forceArchive: request.forceArchive,
    requireArchiveRead: true,
  });
  const proof = reportTextIdentity(text);
  if (
    proof.sha256 !== request.sourceSha256 ||
    proof.byteSize !== request.sourceByteSize
  )
    throw new AttemptEvidenceReadError(
      "stale",
      "API attempt read differs from its requested exact source identity",
    );
  return {
    attemptId: request.attemptId,
    archiveId: request.archiveId,
    sourceSha256: proof.sha256,
    sourceByteSize: proof.byteSize,
    source:
      process.env.AIRFOILFOAM_DEPLOYMENT_ROLE === "remote-solver"
        ? "worker-volume"
        : "gcs",
    payloadText: text,
  };
}
