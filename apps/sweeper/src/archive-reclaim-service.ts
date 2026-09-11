import type { DB, Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";
import { runNotificationDrain } from "./notification-drain";
import { reclaimRemoteSolverEvidenceTick } from "./remote-solver";

export async function runArchiveReclaimService(
  db: DB,
  notifications: Pick<Sql, "listen">,
  engine: EngineClient,
  signal: AbortSignal,
  options: {
    drain?: () => Promise<number>;
    nextWakeAt?: () => Promise<Date | null>;
    reportError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  let idleDelay = 1000;
  const drain =
    options.drain ?? (() => reclaimRemoteSolverEvidenceTick(db, engine));
  const reportError =
    options.reportError ??
    ((error) =>
      console.error(
        "[sweeper] archive reclamation failed:",
        error instanceof Error ? error.message : String(error),
      ));
  const nextWakeAt =
    options.nextWakeAt ??
    (async () => {
      const [pending] = await db.execute(sql`
      SELECT min(wake_at) AS wake_at FROM (
        SELECT greatest(claim_expires_at,retry_after) AS wake_at FROM progressive_worker_archive_reclaims
        WHERE completed_at IS NULL
        UNION ALL
        SELECT greatest(reclaim_claim_expires_at,reclaim_next_attempt_at) AS wake_at FROM sync_remote_hub_binding_receipts
        WHERE reclaim_state IN ('pending','claiming')
      ) pending WHERE wake_at>clock_timestamp()`);
    return pending?.wake_at == null
      ? null
      : pending.wake_at instanceof Date
        ? pending.wake_at
        : new Date(String(pending.wake_at));
    });
  await runNotificationDrain(
    notifications,
    "progressive_worker_archive_changed",
    signal,
    {
      drain: async () => {
        try {
          if ((await drain()) > 0) {
            idleDelay = 1000;
            return true;
          }
        } catch (error) {
          reportError(error);
        }
        return false;
      },
      nextWakeAt: async () => {
        const fallback = new Date(Date.now() + idleDelay);
        idleDelay = Math.min(30_000, idleDelay * 2);
        try {
          const deadline = await nextWakeAt();
          return deadline && deadline.getTime() < fallback.getTime()
            ? deadline
            : fallback;
        } catch (error) {
          reportError(error);
          return fallback;
        }
      },
      reportError,
    },
  );
}
