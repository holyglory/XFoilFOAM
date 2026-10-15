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
  let lastAdmissionWaitReason: string | null = null;
  let admissionFlight: Promise<void> | null = null;
  const startAdmission = () => {
    if (signal.aborted || admissionFlight) return;
    admissionFlight = prepareProgressiveRemoteFleet(db)
      .then((admission) => {
        const waitReason = admission.waitingReasons
          .map((entry) => `${entry.solverId}:${entry.reason}`)
          .join("|");
        if (waitReason && waitReason !== lastAdmissionWaitReason) {
          lastAdmissionWaitReason = waitReason;
          console.log(
            JSON.stringify({
              component: "progressive-remote-admission-wait",
              waiting: admission.waiting,
              waitingReasons: admission.waitingReasons,
            }),
          );
        } else if (!waitReason) {
          lastAdmissionWaitReason = null;
        }
        if (admission.prepared || admission.deferred || admission.errors.length)
          console.log(
            JSON.stringify({
              component: "progressive-remote-admission",
              ...admission,
            }),
          );
      })
      .catch((error) =>
        console.error(
          "[sweeper] progressive remote admission failed:",
          error instanceof Error ? error.message : String(error),
        ),
      )
      .finally(() => {
        admissionFlight = null;
      });
  };
  const progressDrain = runNotificationDrain(
    notifications,
    "progressive_remote_report_changed",
    signal,
    {
      drain: async () => {
        const stops = await acknowledgeProgressiveRemoteStops(db);
        const progress = await reconcileProgressiveRemoteProgress(db);
        startAdmission();
        if (
          stops.acknowledged ||
          stops.errors.length ||
          progress.applied ||
          progress.indexed ||
          progress.settled ||
          progress.errors.length
        )
          console.log(
            JSON.stringify({
              component: "progressive-hub-progress",
              stops,
              progress,
            }),
          );
        return (
          stops.acknowledged +
            progress.applied +
            progress.indexed +
            progress.settled >
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
  await progressDrain;
  await admissionFlight;
}
