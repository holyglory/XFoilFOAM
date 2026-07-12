import { and, eq, inArray } from "drizzle-orm";

import type { DB } from "./client";
import { syncRemotePromiseCancellations, syncSweepPromises } from "./schema";

export type SyncPromisePurgeResult =
  | { kind: "purged"; promiseIds: string[] }
  | {
      kind: "refused";
      activeOrExpiredPromiseIds: string[];
      undeliveredCancellationPromiseIds: string[];
    };

/**
 * Explicit, atomic retention boundary for mirrored promise audit state.
 * Delivered cancellation rows are retained indefinitely with their promise;
 * this function is the only normal path that removes them, immediately before
 * deleting terminal parents. It never time-GCs an outbox row and never partly
 * purges a requested set.
 */
export async function purgeSyncSweepPromises(
  db: DB,
  requestedPromiseIds: string[],
): Promise<SyncPromisePurgeResult> {
  return db.transaction((rawTx) =>
    purgeSyncSweepPromisesInTransaction(
      rawTx as unknown as DB,
      requestedPromiseIds,
    ),
  );
}

/** Same atomic operation inside an existing, wider purge transaction. */
export async function purgeSyncSweepPromisesInTransaction(
  db: DB,
  requestedPromiseIds: string[],
): Promise<SyncPromisePurgeResult> {
  const promiseIds = [...new Set(requestedPromiseIds)].sort();
  if (!promiseIds.length) return { kind: "purged", promiseIds: [] };
  const promises = await db
    .select({ id: syncSweepPromises.id, status: syncSweepPromises.status })
    .from(syncSweepPromises)
    .where(inArray(syncSweepPromises.id, promiseIds))
    .orderBy(syncSweepPromises.id)
    .for("update");
  const cancellations = await db
    .select({
      promiseId: syncRemotePromiseCancellations.promiseId,
      state: syncRemotePromiseCancellations.state,
    })
    .from(syncRemotePromiseCancellations)
    .where(inArray(syncRemotePromiseCancellations.promiseId, promiseIds))
    .orderBy(syncRemotePromiseCancellations.promiseId)
    .for("update");
  const activeOrExpiredPromiseIds = promises
    .filter((promise) => ["active", "expired"].includes(promise.status))
    .map((promise) => promise.id);
  const undeliveredCancellationPromiseIds = cancellations
    .filter((row) => row.state === "pending" || row.state === "retry_wait")
    .map((row) => row.promiseId);
  if (
    activeOrExpiredPromiseIds.length ||
    undeliveredCancellationPromiseIds.length
  ) {
    return {
      kind: "refused" as const,
      activeOrExpiredPromiseIds,
      undeliveredCancellationPromiseIds,
    };
  }
  await db
    .delete(syncRemotePromiseCancellations)
    .where(
      and(
        inArray(syncRemotePromiseCancellations.promiseId, promiseIds),
        eq(syncRemotePromiseCancellations.state, "delivered"),
      ),
    );
  const deleted = await db
    .delete(syncSweepPromises)
    .where(inArray(syncSweepPromises.id, promiseIds))
    .returning({ id: syncSweepPromises.id });
  return {
    kind: "purged" as const,
    promiseIds: deleted.map((row) => row.id).sort(),
  };
}
