import type { DB, Sql } from "@aerodb/db";
import {
  publishProgressiveWorkerReports,
  type ProgressivePublicationCursor,
} from "./progressive-remote-publication";
import { runNotificationDrain } from "./notification-drain";

export async function runProgressiveReportService(
  db: DB,
  notifications: Pick<Sql, "listen">,
  signal: AbortSignal,
  options: {
    publish?: () => Promise<boolean>;
    lane?: number;
    laneCount?: number;
    pollIntervalMs?: number;
    reportError?: (error: unknown) => void;
  } = {},
): Promise<void> {
  if (signal.aborted) return;
  const publicationCursor: ProgressivePublicationCursor = {
    nextPass: "active",
  };
  const publish =
    options.publish ??
    (() =>
      publishProgressiveWorkerReports(
        db,
        fetch,
        options.lane ?? 0,
        options.laneCount ?? 1,
        publicationCursor,
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
    {
      drain: publish,
      reportError,
      // A report can be written while the sweeper is restarting or while a
      // LISTEN subscription is being replaced. The periodic fallback keeps
      // terminal reports from becoming permanent backlog. Tests that inject a
      // custom publisher can opt out or choose a shorter interval.
      pollIntervalMs: options.pollIntervalMs ?? (options.publish ? undefined : 5_000),
    },
  );
}
