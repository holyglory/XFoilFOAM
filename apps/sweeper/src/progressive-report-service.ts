import type { DB, Sql } from "@aerodb/db";
import { publishNextProgressiveWorkerReport } from "./progressive-remote-publication";
import { runNotificationDrain } from "./notification-drain";

export async function runProgressiveReportService(
  db: DB,
  notifications: Pick<Sql, "listen">,
  signal: AbortSignal,
  options: {
    publish?: () => Promise<boolean>;
    reportError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  if (signal.aborted) return;
  const publish =
    options.publish ?? (() => publishNextProgressiveWorkerReport(db));
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
