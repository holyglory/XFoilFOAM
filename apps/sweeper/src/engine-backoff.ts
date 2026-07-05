// Engine-down backoff (docs/simulation-campaigns-spec.md §7): when the engine
// cannot be reached at submit time the sweeper does NOT mark jobs failed — it
// releases the composed work, records sweeper_state.engineUnreachableSince
// (one truthful banner for the Queue + campaign pages) and backs off
// exponentially, 5 s → 5 min cap, in memory. Cleared on the first successful
// probe/submit. `failed` stays reserved for jobs the engine rejected/ran.

import type { DB } from "@aerodb/db";
import { EngineError } from "@aerodb/engine-client";
import { sql } from "drizzle-orm";

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 300_000;

let consecutiveFailures = 0;
let nextAttemptAt = 0;

/** True while the submit path should stay quiet after a connection failure. */
export function engineBackoffActive(now = Date.now()): boolean {
  return now < nextAttemptAt;
}

export function currentBackoffMs(): number {
  if (consecutiveFailures === 0) return 0;
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1));
}

/** Connection-level failure (fetch refused/timeout). EngineError means the
 *  engine answered — those failures stay on the `failed` path. */
export function isEngineConnectionFailure(e: unknown): boolean {
  return !(e instanceof EngineError);
}

export async function recordEngineUnreachable(db: DB): Promise<void> {
  consecutiveFailures += 1;
  nextAttemptAt = Date.now() + currentBackoffMs();
  await db.execute(sql`
    UPDATE sweeper_state
    SET "engineUnreachableSince" = COALESCE("engineUnreachableSince", now()), "updatedAt" = now()
    WHERE id = 1
  `);
}

export async function clearEngineUnreachable(db: DB): Promise<void> {
  consecutiveFailures = 0;
  nextAttemptAt = 0;
  await db.execute(sql`
    UPDATE sweeper_state
    SET "engineUnreachableSince" = NULL, "updatedAt" = now()
    WHERE id = 1 AND "engineUnreachableSince" IS NOT NULL
  `);
}

/** Test-only: reset the in-memory backoff window. */
export function resetEngineBackoffForTests(): void {
  consecutiveFailures = 0;
  nextAttemptAt = 0;
}
