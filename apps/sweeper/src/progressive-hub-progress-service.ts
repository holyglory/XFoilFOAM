import type { DB, Sql } from "@aerodb/db";
import { acknowledgeProgressiveRemoteStops } from "./progressive-remote-stop-receipt";
import { reconcileProgressiveRemoteProgress } from "./progressive-remote-progress";
import { runNotificationDrain } from "./notification-drain";
import { prepareProgressiveRemoteFleet } from "./progressive-remote-admission";

export async function runProgressiveHubProgressService(
  db: DB,
  notifications: Pick<Sql, "listen">,
  signal: AbortSignal,
) {
  await runNotificationDrain(
    notifications,
    "progressive_remote_report_changed",
    signal,
    {
      drain: async () => {
        const stops = await acknowledgeProgressiveRemoteStops(db);
        const progress = await reconcileProgressiveRemoteProgress(db);
        const admission = signal.aborted
          ? { prepared: 0, deferred: 0, waiting: 0, errors: [] }
          : await prepareProgressiveRemoteFleet(db);
        if (
          stops.acknowledged ||
          stops.errors.length ||
          progress.applied ||
          progress.indexed ||
          progress.settled ||
          progress.errors.length ||
          admission.prepared ||
          admission.deferred ||
          admission.errors.length
        )
          console.log(
            JSON.stringify({
              component: "progressive-hub-progress",
              stops,
              progress,
              admission,
            }),
          );
        return (
          stops.acknowledged +
            progress.applied +
            progress.indexed +
            progress.settled +
            admission.prepared +
            admission.deferred >
          0
        );
      },
      nextWakeAt: async () => new Date(Date.now() + 5000),
      reportError: (error) =>
        console.error(
          "[sweeper] progressive hub progress failed:",
          error instanceof Error ? error.message : String(error),
        ),
    },
  );
}
