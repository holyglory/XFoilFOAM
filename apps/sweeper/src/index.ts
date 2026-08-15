import { syncApiSettings } from "@aerodb/db";

import {
  assertRemoteSolverHubUrlContract,
  assertRemoteSolverNodeEvidenceContract,
  makeContext,
} from "./config";
import { startHeartbeatTimer } from "./heartbeat";
import { runLoop } from "./loop";
import { startRemoteSolverFleetHeartbeatTimer } from "./remote-solver";
import { startArchiveInterpretationMaintenanceTimer } from "./result-interpretation-backfill";

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
const stopArchiveMaintenance = startArchiveInterpretationMaintenanceTimer(
  db,
  engine,
);
try {
  await runLoop(db, engine, ac.signal);
} finally {
  stopArchiveMaintenance();
  stopRemoteFleetHeartbeat();
  stopHeartbeat();
}
await sql.end();
console.log("[sweeper] stopped");
