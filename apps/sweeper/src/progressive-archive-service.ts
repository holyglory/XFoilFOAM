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
import { runSweeperServices } from "./service-lifecycle";

const PROGRESSIVE_ARCHIVE_TRANSFER_LANES = 8;

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
  await runSweeperServices(
    signal,
    Array.from({ length: PROGRESSIVE_ARCHIVE_TRANSFER_LANES }, (_, lane) => ({
      name: `progressive-archive-${lane}`,
      run: (laneSignal) =>
        runNotificationDrain(
          notifications,
          "progressive_worker_archive_changed",
          laneSignal,
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
        ),
    })),
  );
}
