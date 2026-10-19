import type { DB, Sql } from "@aerodb/db";
import { publishProgressiveWorkerReports } from "./progressive-remote-publication";
import { runNotificationDrain } from "./notification-drain";

export async function runProgressiveReportService(
  db: DB,
  notifications: Pick<Sql, "listen">,
  signal: AbortSignal,
  options: {
    publish?: () => Promise<boolean>;
    lane?: number;
    laneCount?: number;
    reportError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  if (signal.aborted) return;
  const publish =
    options.publish ??
    (() =>
      publishProgressiveWorkerReports(
        db,
        fetch,
        options.lane ?? 0,
        options.laneCount ?? 1,
      ));
  const reportError =
    options.reportError ??
    ((error) =>
      console.error(
        "[sweeper] progressive report publication failed:",
        error instanceof Error ? error.message : String(error),
      ));
  await runNotificationDrain(
    notifications,
    "progressive_worker_report_changed",
    signal,
    { drain: publish, reportError },
  );
}
