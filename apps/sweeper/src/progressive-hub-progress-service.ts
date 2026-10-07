import type { DB, Sql } from "@aerodb/db";
import { sql } from "drizzle-orm";
import { acknowledgeProgressiveRemoteStops } from "./progressive-remote-stop-receipt";
import { reconcileProgressiveRemoteProgress } from "./progressive-remote-progress";
import { runNotificationDrain } from "./notification-drain";
import { prepareProgressiveRemoteFleet } from "./progressive-remote-admission";
import { advanceProgressiveCfdStages } from "@aerodb/db";

async function adaptiveWorkPending(db: DB): Promise<boolean> {
  const [row] = await db.execute(sql`
    SELECT EXISTS (
      SELECT 1 FROM progressive_cfd_units unit
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generations generation ON generation.id = work.generation_id
      JOIN calculation_epochs epoch ON epoch.id = generation.epoch_id AND epoch.current
      WHERE generation.status = 'active' AND work.stage = 2
        AND unit.purpose = 'adaptive' AND unit.state = 'pending'
    ) AS pending
  `);
  return row?.pending === true;
}

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
        const [role] = (await db.execute(
          sql`SELECT remote_solver_enabled FROM sync_api_settings LIMIT 1`,
        )) as unknown as Array<{ remote_solver_enabled: boolean }>;
        const stages = role?.remote_solver_enabled
          ? { admitted: 0, closed: 0, waiting: 0, campaignsCompleted: 0 }
          : (await adaptiveWorkPending(db))
            ? { admitted: 0, closed: 0, waiting: 1, campaignsCompleted: 0 }
            : await advanceProgressiveCfdStages(db);
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
          stages.admitted ||
          stages.closed ||
          stages.campaignsCompleted ||
          admission.prepared ||
          admission.deferred ||
          admission.errors.length
        )
          console.log(
            JSON.stringify({
              component: "progressive-hub-progress",
              stops,
              progress,
              stages,
              admission,
            }),
          );
        return (
          stops.acknowledged +
            progress.applied +
            progress.indexed +
            progress.settled +
            stages.admitted +
            stages.closed +
            stages.campaignsCompleted +
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
