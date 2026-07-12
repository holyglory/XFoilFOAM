import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DB } from "./client";
import { solverEvidenceArtifacts } from "./schema";

export const SYNC_BLOB_LOCK_NAMESPACE = 0x584646; // "XFF"
export const SYNC_BLOB_LOCK_STRIPES = 256;

export function syncBlobLockStripe(contentSha256: string): number {
  return (
    createHash("sha256")
      .update(contentSha256.toLowerCase())
      .digest()
      .readUInt16BE(0) % SYNC_BLOB_LOCK_STRIPES
  );
}

export async function acquireSyncBlobStripeLock(
  db: DB,
  contentSha256: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(${SYNC_BLOB_LOCK_NAMESPACE}, ${syncBlobLockStripe(contentSha256)})`,
  );
}

/** Transaction-scoped serialization for the canonical result row, its current
 * manifest artifacts, and evidence-derived presentation mutations. Callers
 * acquire this inside the transaction that performs the write. */
export async function acquireResultEvidenceLock(
  db: DB,
  resultId: string,
): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`result-evidence:${resultId}`}, 0))`,
  );
}

/**
 * Serialize one physical evidence-artifact identity before resolving which
 * canonical results currently reference it. This lock must always be acquired
 * before any result-evidence locks: two different artifact keys can otherwise
 * discover opposite result owners and deadlock while adding associations.
 */
export async function acquireEvidenceArtifactKeyLock(
  db: DB,
  storageKey: string,
  sha256: string,
): Promise<void> {
  const normalizedSha256 = sha256.toLowerCase();
  const identity = `${storageKey.length}:${storageKey}:${normalizedSha256}`;
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`evidence-artifact:${identity}`}, 0))`,
  );
}

/** Acquire all affected result locks in one deterministic global order. */
export async function acquireResultEvidenceLocks(
  db: DB,
  resultIds: ReadonlyArray<string | null | undefined>,
): Promise<void> {
  const ordered = [
    ...new Set(resultIds.filter((id): id is string => Boolean(id))),
  ].sort();
  for (const resultId of ordered) {
    await acquireResultEvidenceLock(db, resultId);
  }
}

/**
 * Transactional write boundary for one immutable blob identity. A blob may
 * have many owner-scoped association rows.
 *
 * Existing owners are deliberately read only after the artifact-key lock is
 * held. Every current owner and the incoming owner are then locked in sorted
 * order before the caller inserts an association.
 */
export async function withEvidenceArtifactWriteLocks<T>(
  db: DB,
  input: {
    storageKey: string;
    sha256: string;
    incomingResultId?: string | null;
  },
  write: (tx: DB, existingResultId: string | null) => Promise<T>,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await acquireEvidenceArtifactKeyLock(tx, input.storageKey, input.sha256);
    const existing = await tx
      .select({ resultId: solverEvidenceArtifacts.resultId })
      .from(solverEvidenceArtifacts)
      .where(
        and(
          eq(solverEvidenceArtifacts.storageKey, input.storageKey),
          eq(solverEvidenceArtifacts.sha256, input.sha256),
        ),
      );
    await acquireResultEvidenceLocks(tx, [
      ...existing.map((row) => row.resultId),
      input.incomingResultId,
    ]);
    return write(tx, existing[0]?.resultId ?? null);
  });
}
