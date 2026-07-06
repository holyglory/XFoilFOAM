import { type DB, sweeperState } from "@aerodb/db";
import { sql } from "drizzle-orm";

/** LIVENESS/PROGRESS SPLIT (2026-07-06 prod false "PROCESS NOT RUNNING"):
 *  sweeper_state."heartbeatAt" is pure LIVENESS — an independent 15 s timer
 *  (startHeartbeatTimer, wired in index.ts) writes it unconditionally, so a
 *  single hung engine HTTP call inside tick work can no longer starve it past
 *  the web truth gate's 90 s threshold. Tick PROGRESS lives in
 *  "lastTickStartedAt"/"lastTickCompletedAt" (markTickStarted/markTickCompleted,
 *  migration 0033): heartbeat fresh + tick started >5 min ago without
 *  completing derives the AMBER tick_stalled state, never red process death.
 *
 *  The tick-path touchHeartbeat calls stay (they are correct and cheap), but
 *  liveness no longer depends on them.
 *
 *  Lives in its own module (not reconcile.ts) so ingest.ts can import it
 *  without a reconcile→ingest→reconcile cycle. */

export const HEARTBEAT_TIMER_INTERVAL_MS = 15_000;

/** Cap on a single liveness write so a wedged connection cannot hold the
 *  in-flight flag forever (well under the 90 s staleness gate). */
export const HEARTBEAT_WRITE_TIMEOUT_MS = 10_000;

/** Single-row heartbeat upsert (~1 ms). Called between the slow phases of a
 *  tick so long reconcile/ingest passes keep the beat moving even between
 *  timer firings. */
export async function touchHeartbeat(db: DB): Promise<void> {
  await db
    .insert(sweeperState)
    .values({ id: 1 })
    .onConflictDoUpdate({ target: sweeperState.id, set: { heartbeatAt: new Date() } });
}

/** Liveness write with its own short statement timeout: SET LOCAL only lives
 *  inside a transaction, and a pg statement_timeout aborts the server-side
 *  query too (a client-side race would leak a running UPDATE). */
async function touchHeartbeatBounded(db: DB): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = ${sql.raw(String(HEARTBEAT_WRITE_TIMEOUT_MS))}`);
    await tx
      .insert(sweeperState)
      .values({ id: 1 })
      .onConflictDoUpdate({ target: sweeperState.id, set: { heartbeatAt: new Date() } });
  });
}

/** Independent liveness timer: writes heartbeatAt every `intervalMs`
 *  unconditionally — its own DB call, never blocked by tick work. An
 *  in-flight flag guarantees a hung write never stacks a second one; failures
 *  log loudly and the next firing retries. Returns a stop function (called on
 *  shutdown, after runLoop returns). */
export function startHeartbeatTimer(db: DB, intervalMs: number = HEARTBEAT_TIMER_INTERVAL_MS): () => void {
  let inFlight = false;
  const beat = () => {
    if (inFlight) return; // a hung write must never stack another
    inFlight = true;
    touchHeartbeatBounded(db)
      .catch((e) => {
        console.error("[sweeper] liveness heartbeat write failed:", e instanceof Error ? e.message : e);
      })
      .finally(() => {
        inFlight = false;
      });
  };
  const timer = setInterval(beat, intervalMs);
  // Never hold the process open on shutdown paths that miss the stop call.
  timer.unref?.();
  beat(); // first beat immediately — no 15 s "never reported" window on boot
  return () => clearInterval(timer);
}

/** Tick-progress stamp at tick BEGIN (also beats, keeping the old guarantee
 *  that a tick start is visible immediately). */
export async function markTickStarted(db: DB): Promise<void> {
  const now = new Date();
  await db
    .insert(sweeperState)
    .values({ id: 1 })
    .onConflictDoUpdate({ target: sweeperState.id, set: { heartbeatAt: now, lastTickStartedAt: now } });
}

/** Tick-progress stamp at tick END. Deliberately NOT in a finally: a tick
 *  that threw did not complete, and stamping it complete would hide a stall
 *  behind a crash loop. */
export async function markTickCompleted(db: DB): Promise<void> {
  const now = new Date();
  await db
    .insert(sweeperState)
    .values({ id: 1 })
    .onConflictDoUpdate({ target: sweeperState.id, set: { heartbeatAt: now, lastTickCompletedAt: now } });
}
