import { pointStage } from "./public-point-timing";
import type { DB } from "@aerodb/db/client";
import type { AttemptEvidenceReadRow } from "@aerodb/db/attempt-evidence-reader";
import { readPublicAttemptFields } from "@aerodb/db/public-attempt-fields";
import { readStoredAttemptEvidence } from "./attempt-evidence-reader";
import { readStoredResultHistory } from "./result-history-reader";

function payloadObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

/** Only the selected-result detail projection uses these fields. The caller
 * has already selected and authorized the exact result and attempt. */
export async function readSelectedAttemptDetailFields(
  db: DB,
  attempt: Pick<AttemptEvidenceReadRow, "id" | "resultId" | "simJobId"> & {
    evidenceArchiveId: string | null;
    evidenceStorageEventId: string | null;
    detailPayload: unknown;
  },
): Promise<Record<string, unknown>> {
  if (attempt.evidenceArchiveId === null)
    return payloadObject(attempt.detailPayload);

  const signal = AbortSignal.timeout(30_000);
  async function read() {
    if (attempt.evidenceArchiveId && attempt.evidenceStorageEventId) {
      const fields = await readPublicAttemptFields(db, [attempt], {
        read: (identity) => readStoredResultHistory(db, identity, signal),
      });
      signal.throwIfAborted();
      const hit = fields.get(attempt.id);
      if (hit) return hit;
    }
    const full = await pointStage(
      "fullOriginal",
      readStoredAttemptEvidence(
        db,
        {
          id: attempt.id,
          resultId: attempt.resultId,
          simJobId: attempt.simJobId,
          evidenceArchiveId: attempt.evidenceArchiveId,
          evidenceStorageEventId: attempt.evidenceStorageEventId,
          evidencePayload: null,
        },
        { signal, requireArchiveRead: true },
      ),
    );
    return payloadObject(full.evidencePayload);
  }

  // A queued database lookup or SDK metadata promise may outlive the read.
  // Bound the complete operation, including any verified full-source fallback.
  let rejectDeadline!: (reason: unknown) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const abort = () => rejectDeadline(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([read(), deadline]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
