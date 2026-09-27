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
  const lanes = Number(
    process.env.REMOTE_EVIDENCE_ARCHIVE_LANES ??
      process.env.REMOTE_EVIDENCE_MAX_ACTIVE_UPLOADS_PER_SOLVER ??
      8,
  );
  if (!Number.isSafeInteger(lanes) || lanes < 1 || lanes > 32)
    throw new Error(
      "REMOTE_EVIDENCE_ARCHIVE_LANES must be an integer from 1 through 32",
    );
  await runSweeperServices(
    signal,
    Array.from({ length: lanes }, (_, lane) => ({
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
