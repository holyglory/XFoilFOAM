import { syncApiSettings } from "@aerodb/db";

import {
  assertRemoteSolverHubUrlContract,
  assertRemoteSolverNodeEvidenceContract,
  makeContext,
} from "./config";
import { startHeartbeatTimer } from "./heartbeat";
import { runLoop } from "./loop";
import { runProgressiveBaselineService } from "./progressive-service";
import { runProgressiveReportService } from "./progressive-report-service";
import { runProgressiveEvidenceService } from "./progressive-evidence-service";
import { runProgressiveArchiveService } from "./progressive-archive-service";
import { runProgressiveWorkerCapabilityService } from "./progressive-worker-capabilities";
import { runSweeperServices } from "./service-lifecycle";
import { startRemoteSolverFleetHeartbeatTimer } from "./remote-solver";

const { db, sql, engine } = makeContext();
try {
  const [syncSettings] = await db
    .select({
      remoteSolverEnabled: syncApiSettings.remoteSolverEnabled,
      upstreamBaseUrl: syncApiSettings.upstreamBaseUrl,
    })
    .from(syncApiSettings)
    .limit(1);
  assertRemoteSolverHubUrlContract(syncSettings?.upstreamBaseUrl);
  assertRemoteSolverNodeEvidenceContract(
    syncSettings?.remoteSolverEnabled ?? false,
  );
} catch (error) {
  await sql.end();
  throw error;
}
const ac = new AbortController();
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => ac.abort());

console.log(
  `[sweeper] starting — engine=${engine.baseUrl}. Gated by sweeper_state.enabled.`,
);
// LIVENESS is an independent 15 s timer (2026-07-06: a hung engine call inside
// tick work starved the in-tick heartbeat >90 s and the web read a live
// process as "PROCESS NOT RUNNING"). Tick progress is stamped separately by
// the loop (lastTickStartedAt/lastTickCompletedAt).
const stopHeartbeat = startHeartbeatTimer(db);
const stopRemoteFleetHeartbeat = startRemoteSolverFleetHeartbeatTimer(db);
try {
  await runSweeperServices(ac.signal, [
    { name: "controller", run: (signal) => runLoop(db, engine, signal) },
    {
      name: "progressive-capabilities",
      run: (signal) =>
        runProgressiveWorkerCapabilityService(db, engine, signal),
    },
    {
      name: "progressive-polars",
      run: (signal) => runProgressiveBaselineService(db, sql, engine, signal),
    },
    {
      name: "progressive-report-delivery",
      run: (signal) => runProgressiveReportService(db, sql, signal),
    },
    {
      name: "progressive-compact-evidence",
      run: (signal) => runProgressiveEvidenceService(db, sql, engine, signal),
    },
    {
      name: "progressive-archive-delivery",
      run: (signal) => runProgressiveArchiveService(db, sql, engine, signal),
    },
  ]);
} finally {
  stopRemoteFleetHeartbeat();
  stopHeartbeat();
  await sql.end();
}
console.log("[sweeper] stopped");
