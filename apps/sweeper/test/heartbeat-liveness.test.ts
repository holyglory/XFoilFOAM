// Must-catch layer for the 2026-07-06 prod incident: the heartbeat was only
// written inside tick work, so ONE hung engine HTTP call (engine API saturated
// by solvers) starved sweeper_state."heartbeatAt" past the web's 90 s truth
// gate and a LIVE process rendered red "PROCESS NOT RUNNING". The fix splits
// LIVENESS (independent 15 s timer → heartbeatAt) from TICK PROGRESS
// (lastTickStartedAt/lastTickCompletedAt, migration 0033). These tests are
// shaped like the real breakage: a fake engine that NEVER resolves hangs a
// real tick while the timer keeps beating.

import { createClient, sweeperState } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resetEngineBackoffForTests } from "../src/engine-backoff";
import { startHeartbeatTimer } from "../src/heartbeat";
import { tick } from "../src/loop";

const { db, sql } = createClient({ max: 3 });

/** Fake engine shaped like the incident: the engine ACCEPTS the connection and
 *  then never answers — every method returns a promise that never settles. */
function hungEngine(): EngineClient {
  const never = () => new Promise<never>(() => {});
  return {
    baseUrl: "http://engine.hung.test",
    health: never,
    healthDetails: never,
    submitPolar: never,
    getJob: never,
    cancelJob: never,
    getQueue: never,
    cacheStats: never,
    getJobRuntimes: never,
    getResult: never,
    renderField: never,
    computeFieldExtents: never,
    renderDefaultMedia: never,
    fileUrl: () => "http://engine.hung.test/file",
  } as unknown as EngineClient;
}

/** Fake engine that answers instantly-with-refusal (connection-class reject):
 *  lets a tick RUN TO COMPLETION without hanging and without submitting. */
function rejectingEngine(): EngineClient {
  const refuse = () => Promise.reject(new TypeError("fetch failed"));
  return {
    baseUrl: "http://engine.refused.test",
    health: async () => false,
    healthDetails: refuse,
    submitPolar: refuse,
    getJob: refuse,
    cancelJob: refuse,
    getQueue: refuse,
    cacheStats: refuse,
    getJobRuntimes: refuse,
    getResult: refuse,
    renderField: refuse,
    computeFieldExtents: refuse,
    renderDefaultMedia: refuse,
    fileUrl: () => "http://engine.refused.test/file",
  } as unknown as EngineClient;
}

async function readState() {
  const [row] = await db.select().from(sweeperState).where(eq(sweeperState.id, 1)).limit(1);
  if (!row) throw new Error("sweeper_state row 1 required (seeded database)");
  return row;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let original: Awaited<ReturnType<typeof readState>> | null = null;

beforeAll(async () => {
  original = await readState();
});

afterAll(async () => {
  if (original) {
    await db
      .update(sweeperState)
      .set({
        enabled: original.enabled,
        maxConcurrentJobs: original.maxConcurrentJobs,
        heartbeatAt: original.heartbeatAt,
        lastTickStartedAt: original.lastTickStartedAt,
        lastTickCompletedAt: original.lastTickCompletedAt,
      })
      .where(eq(sweeperState.id, 1));
  }
  await sql.end();
});

describe("liveness/progress split", () => {
  it("MUST-CATCH: the independent timer keeps heartbeatAt advancing while a tick hangs on a never-resolving engine call", async () => {
    resetEngineBackoffForTests();
    // enabled=true + headroom so the tick reaches an engine call and hangs
    // there (health probe / reconcile poll — whichever comes first is the
    // incident shape either way).
    await db.update(sweeperState).set({ enabled: true, maxConcurrentJobs: 999 }).where(eq(sweeperState.id, 1));
    // Backdate liveness + progress so every advance below is unambiguous.
    const backdated = new Date(Date.now() - 10 * 60_000);
    await db
      .update(sweeperState)
      .set({ heartbeatAt: backdated, lastTickStartedAt: backdated, lastTickCompletedAt: backdated })
      .where(eq(sweeperState.id, 1));

    // The hung tick: starts, stamps lastTickStartedAt, hangs on the first
    // engine round-trip (getQueue never settles) and never returns. Scoped
    // to a fresh uuid so it cannot touch real jobs (harness pattern).
    const pendingTick = tick(db, hungEngine(), { jobIds: [crypto.randomUUID()], skipFailedRecovery: true });
    pendingTick.catch(() => undefined); // never settles; guard just in case

    const stop = startHeartbeatTimer(db, 50); // short test interval
    try {
      await sleep(250);
      const first = await readState();
      // Liveness advanced far past the backdated value while the tick hangs.
      expect(first.heartbeatAt).not.toBeNull();
      expect(first.heartbeatAt!.getTime()).toBeGreaterThan(backdated.getTime());
      expect(Date.now() - first.heartbeatAt!.getTime()).toBeLessThan(10_000);
      // The hung tick stamped its start but could never complete.
      expect(first.lastTickStartedAt!.getTime()).toBeGreaterThan(backdated.getTime());
      expect(first.lastTickCompletedAt!.getTime()).toBe(backdated.getTime());
      expect(first.lastTickStartedAt!.getTime()).toBeGreaterThan(first.lastTickCompletedAt!.getTime());

      // And it keeps advancing — a heartbeat, not a one-off write.
      await sleep(200);
      const second = await readState();
      expect(second.heartbeatAt!.getTime()).toBeGreaterThan(first.heartbeatAt!.getTime());
      expect(second.lastTickCompletedAt!.getTime()).toBe(backdated.getTime());
    } finally {
      stop();
    }
  }, 15_000);

  it("a tick that runs to completion stamps lastTickStartedAt AND lastTickCompletedAt (completed >= started)", async () => {
    resetEngineBackoffForTests();
    // Disabled: the tick reconciles and completes without composing work —
    // the rejecting engine answers instantly so nothing hangs.
    await db.update(sweeperState).set({ enabled: false }).where(eq(sweeperState.id, 1));
    const backdated = new Date(Date.now() - 10 * 60_000);
    await db
      .update(sweeperState)
      .set({ lastTickStartedAt: backdated, lastTickCompletedAt: backdated })
      .where(eq(sweeperState.id, 1));

    const before = Date.now();
    await tick(db, rejectingEngine(), { jobIds: [crypto.randomUUID()], skipFailedRecovery: true });

    const s = await readState();
    expect(s.lastTickStartedAt!.getTime()).toBeGreaterThan(backdated.getTime());
    expect(s.lastTickCompletedAt!.getTime()).toBeGreaterThan(backdated.getTime());
    expect(s.lastTickCompletedAt!.getTime()).toBeGreaterThanOrEqual(s.lastTickStartedAt!.getTime());
    // Sanity: both stamps came from THIS tick, not clock drift.
    expect(s.lastTickStartedAt!.getTime()).toBeGreaterThanOrEqual(before - 60_000);
    // 180 s: the FIRST completed reconcile in a worker pays the full lane
    // sweep + campaign reconciler maintenance pass against the dev DB.
  }, 180_000);

  it("the timer's in-flight flag never stacks writes and the stop function halts the beat (stub db — deterministic)", async () => {
    // Stub DB: counts liveness writes and lets the test HOLD one open, so
    // stacking/stop behavior is provable without racing the shared dev row
    // (other test files legitimately touch sweeper_state.heartbeatAt).
    let writes = 0;
    const held: { release?: () => void } = {};
    const stubDb = {
      transaction: (_fn: unknown) => {
        writes += 1;
        return new Promise<void>((resolve) => {
          held.release = () => resolve();
        });
      },
    } as unknown as typeof db;

    const stop = startHeartbeatTimer(stubDb, 20);
    await sleep(150); // ~7 interval firings while the FIRST write hangs
    expect(writes).toBe(1); // in-flight flag: a hung write never stacks another
    held.release?.(); // the hung write finally settles
    await sleep(60);
    expect(writes).toBeGreaterThanOrEqual(2); // beats resume after it settles
    const atStop = writes;
    stop();
    held.release?.();
    await sleep(150);
    expect(writes).toBeLessThanOrEqual(atStop + 1); // nothing new after stop
  }, 15_000);
});
