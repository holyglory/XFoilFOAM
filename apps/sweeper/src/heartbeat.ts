import { type DB, sweeperState } from "@aerodb/db";

/** Single-row heartbeat upsert (~1 ms). Called between the slow phases of a
 *  tick so "process not running" (stale heartbeat) never lies during long
 *  reconcile/ingest passes — the state that masked a wedged first tick on
 *  2026-07-05, and that on 2026-07-06 (7 jobs in flight) let the heartbeat go
 *  204 s stale mid-tick, tripping the Solver page's >90 s truth gate on a
 *  healthy process.
 *
 *  INVARIANT: no sweeper code path may run for more than ~30 s under
 *  realistic load without calling this. Long loops (per-point ingest,
 *  scaled-render batches, recovery sweeps, lane drains) must touch per
 *  iteration or per small batch of iterations.
 *
 *  Lives in its own module (not reconcile.ts) so ingest.ts can import it
 *  without a reconcile→ingest→reconcile cycle. */
export async function touchHeartbeat(db: DB): Promise<void> {
  await db
    .insert(sweeperState)
    .values({ id: 1 })
    .onConflictDoUpdate({ target: sweeperState.id, set: { heartbeatAt: new Date() } });
}
