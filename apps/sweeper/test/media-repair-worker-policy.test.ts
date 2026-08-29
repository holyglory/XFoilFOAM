import { describe, expect, it } from "vitest";

import { runBoundedClaimBatch } from "../src/media-repair";
import {
  configuredMediaRepairConcurrency,
  MEDIA_REPAIR_ACTIVE_DELAY_MS,
  MEDIA_REPAIR_IDLE_DELAY_MS,
  nextMediaRepairDelayMs,
  runUntilAborted,
} from "../src/media-repair-worker-policy";

describe("durable media repair worker policy", () => {
  it("keeps a bounded number of independently claimed repairs in flight", async () => {
    const available = [1, 2, 3, 4];
    const claimed: number[] = [];
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      bothStarted = resolve;
    });

    const batch = runBoundedClaimBatch({
      concurrency: 2,
      claim: async () => {
        const value = available.shift() ?? null;
        if (value != null) claimed.push(value);
        return value;
      },
      run: async (value) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (active === 2) bothStarted();
        await gate;
        active -= 1;
        return value * 10;
      },
    });

    await started;
    expect(claimed).toEqual([1, 2]);
    expect(maxActive).toBe(2);
    expect(available).toEqual([3, 4]);
    release();
    await expect(batch).resolves.toEqual([10, 20]);
  });

  it("drains again immediately after work and sleeps only after an idle batch", () => {
    expect(nextMediaRepairDelayMs({ claimedCount: 2 })).toBe(
      MEDIA_REPAIR_ACTIVE_DELAY_MS,
    );
    expect(nextMediaRepairDelayMs({ claimedCount: 0 })).toBe(
      MEDIA_REPAIR_IDLE_DELAY_MS,
    );
  });

  it("accepts only the bounded production concurrency range", () => {
    expect(configuredMediaRepairConcurrency(undefined)).toBe(2);
    expect(configuredMediaRepairConcurrency("1")).toBe(1);
    expect(configuredMediaRepairConcurrency("4")).toBe(4);
    for (const value of ["0", "5", "1.5", "many"]) {
      expect(() => configuredMediaRepairConcurrency(value)).toThrow(
        "must be an integer from 1 through 4",
      );
    }
  });

  it("refills a fast lane without waiting for a slow peer", async () => {
    const ac = new AbortController();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let fastRuns = 0;
    let secondFastRun!: () => void;
    const fastRefilled = new Promise<void>((resolve) => {
      secondFastRun = resolve;
    });
    const slowLane = runUntilAborted(ac.signal, async () => {
      await slowGate;
    });
    const fastLane = runUntilAborted(ac.signal, async () => {
      fastRuns += 1;
      if (fastRuns === 2) {
        secondFastRun();
        ac.abort();
      }
    });

    await fastRefilled;
    expect(fastRuns).toBe(2);
    releaseSlow();
    await expect(Promise.all([slowLane, fastLane])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});
