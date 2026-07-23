import { describe, expect, it } from "vitest";

import {
  activeReconcileConcurrency,
  activeReconcileJobLimit,
  DEFAULT_ACTIVE_RECONCILE_CONCURRENCY,
  DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT,
  runWithConcurrency,
} from "../src/reconcile";

describe("foreground reconciliation budget", () => {
  it("MUST-CATCH: bounds the unconfigured production pass before all high-concurrency jobs", () => {
    expect(activeReconcileJobLimit(undefined)).toBe(
      DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT,
    );
    expect(DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT).toBe(8);
  });

  it("accepts a positive operator override and fails safe on invalid values", () => {
    expect(activeReconcileJobLimit("4")).toBe(4);
    expect(activeReconcileJobLimit("200")).toBe(64);
    expect(activeReconcileJobLimit("0")).toBe(
      DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT,
    );
    expect(activeReconcileJobLimit("not-a-number")).toBe(
      DEFAULT_ACTIVE_RECONCILE_JOB_LIMIT,
    );
  });

  it("MUST-CATCH: polls independent jobs concurrently without exceeding the bounded worker count", async () => {
    let active = 0;
    let peak = 0;
    const visited: number[] = [];

    await runWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 4, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      visited.push(item);
      active -= 1;
    });

    expect(peak).toBe(4);
    expect(visited.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it("defaults to four concurrent polls and caps operator overrides", () => {
    expect(activeReconcileConcurrency(undefined)).toBe(
      DEFAULT_ACTIVE_RECONCILE_CONCURRENCY,
    );
    expect(DEFAULT_ACTIVE_RECONCILE_CONCURRENCY).toBe(4);
    expect(activeReconcileConcurrency("2")).toBe(2);
    expect(activeReconcileConcurrency("200")).toBe(8);
    expect(activeReconcileConcurrency("0")).toBe(
      DEFAULT_ACTIVE_RECONCILE_CONCURRENCY,
    );
    expect(activeReconcileConcurrency("not-a-number")).toBe(
      DEFAULT_ACTIVE_RECONCILE_CONCURRENCY,
    );
  });
});
