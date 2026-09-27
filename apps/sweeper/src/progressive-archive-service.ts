import { syncApiSettings, type DB, type Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { eq } from "drizzle-orm";
import {
  assertRemoteSolverHubUrlContract,
  assertRemoteSolverNodeEvidenceContract,
} from "./config";
import { runNotificationDrain } from "./notification-drain";
import { nextProgressiveArchiveWakeAt } from "./progressive-worker-archive-delivery";
import { deliverNextProgressiveWorkerArchive } from "./remote-solver";

const PROGRESSIVE_ARCHIVE_TRANSFER_LANES = 8;

async function drainProgressiveArchives(
  db: DB,
  engine: EngineClient,
): Promise<boolean> {
  const results = await Promise.allSettled(
    Array.from({ length: PROGRESSIVE_ARCHIVE_TRANSFER_LANES }, () =>
      deliverNextProgressiveWorkerArchive(db, engine),
    ),
  );
  const errors = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (errors.length) throw errors[0]!.reason;
  return results.some(
    (result): result is PromiseFulfilledResult<boolean> =>
      result.status === "fulfilled" && result.value,
  );
}

export async function runProgressiveArchiveService(
  db: DB,
  notifications: Pick<Sql, "listen">,
  engine: EngineClient,
  signal: AbortSignal,
  options: {
    drain?: () => Promise<boolean>;
    nextWakeAt?: () => Promise<Date | null>;
    reportError?: (error: unknown) => void;
  } = {},
) {
  await runNotificationDrain(
    notifications,
    "progressive_worker_archive_changed",
    signal,
    {
      drain:
        options.drain ??
        (async () => {
          const [settings] = await db
            .select({
              upstreamBaseUrl: syncApiSettings.upstreamBaseUrl,
              remoteSolverEnabled: syncApiSettings.remoteSolverEnabled,
            })
            .from(syncApiSettings)
            .where(eq(syncApiSettings.id, 1));
          assertRemoteSolverHubUrlContract(settings?.upstreamBaseUrl);
          assertRemoteSolverNodeEvidenceContract(
            settings?.remoteSolverEnabled ?? false,
          );
          return drainProgressiveArchives(db, engine);
        }),
      nextWakeAt:
        options.nextWakeAt ?? (() => nextProgressiveArchiveWakeAt(db)),
      reportError:
        options.reportError ??
        ((error) =>
          console.error(
            "[sweeper] progressive archive delivery failed:",
            error instanceof Error ? error.message : String(error),
          )),
    },
  );
}
