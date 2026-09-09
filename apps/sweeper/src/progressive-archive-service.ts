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
          return deliverNextProgressiveWorkerArchive(db, engine);
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
