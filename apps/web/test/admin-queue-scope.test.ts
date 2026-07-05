// Tab-scoped queue payload merging (spec §10/§12): the Solver page polls only
// the active tab's scope, and mergeAdminQueue folds each scoped payload over
// the previously known state. Two invariants are pinned here:
//  1. sections covered by the incoming scope ALWAYS overwrite — including
//     with null/error values (a fresh "engine unavailable" must replace a
//     stale healthy snapshot, never be masked by it);
//  2. sections outside the incoming scope keep their previous values (they
//     are only rendered on their own tabs, whose polls refresh them).

import { describe, expect, it } from "vitest";

import { type AdminQueue, mergeAdminQueue } from "../lib/admin";

function fullQueue(overrides: Partial<AdminQueue> = {}): AdminQueue {
  return {
    scope: "all",
    mode: "dev",
    engineUrl: "http://engine.local",
    sweeper: { enabled: true, heartbeatAt: "2026-07-05T10:00:00Z", cpuSlots: 0 } as AdminQueue["sweeper"],
    cpuSlotsAuto: true,
    engineUnreachableSince: null,
    backlogStrip: {
      campaigns: [],
      backgroundGapFill: { pendingPoints: 12, pendingSweeps: 3, computedAt: "2026-07-05T09:59:00Z" },
    },
    backlog: 12,
    inFlight: 2,
    results: { done: 10, failed: 1, solved: 10 },
    solvedToday: 4,
    pendingPointsTotal: 12,
    pendingSweepsTotal: 3,
    pendingSweeps: [],
    externalPromises: [],
    engineQueue: {
      queue_depth: 1,
      active: [],
      reserved: [],
      scheduled: [],
      active_count: 1,
      reserved_count: 0,
      scheduled_count: 0,
      job_ids: [],
      duplicates: {},
      redelivered: [],
    },
    engineQueueError: null,
    engineHealth: { status: "ok", version: "1", build_id: "b1" },
    engineHealthError: null,
    engineExpectedBuildId: "b1",
    engineBuildId: "b1",
    engineBuildMismatch: false,
    engineCache: { meshEntries: 4, seedEntries: 2, totalBytes: 10, capBytes: 100, oldestLastUsedAt: null },
    engineRuntimeAsOf: "2026-07-05T10:00:01Z",
    engineRuntimeError: null,
    activeJobs: [],
    finishedJobs: [],
    jobs: [],
    ...overrides,
  };
}

/** Shapes a scoped payload the way the API emits it: out-of-scope → null. */
function scoped(scope: AdminQueue["scope"], overrides: Partial<AdminQueue> = {}): AdminQueue {
  const base = fullQueue({ scope });
  if (scope === "activity") {
    return { ...base, pendingSweeps: null, externalPromises: null, engineCache: null, ...overrides };
  }
  if (scope === "background") {
    return {
      ...base,
      backlogStrip: null,
      results: null,
      solvedToday: null,
      inFlight: null,
      jobs: null,
      activeJobs: null,
      finishedJobs: null,
      engineQueue: null,
      engineQueueError: null,
      engineHealth: null,
      engineHealthError: null,
      engineCache: null,
      engineRuntimeAsOf: null,
      engineRuntimeError: null,
      ...overrides,
    };
  }
  if (scope === "engine") {
    return {
      ...base,
      backlogStrip: null,
      results: null,
      solvedToday: null,
      backlog: null,
      pendingPointsTotal: null,
      pendingSweepsTotal: null,
      pendingSweeps: null,
      externalPromises: null,
      jobs: null,
      finishedJobs: null,
      ...overrides,
    };
  }
  return { ...base, ...overrides };
}

describe("mergeAdminQueue", () => {
  it("returns the incoming payload verbatim with no previous state or scope=all", () => {
    const next = scoped("activity");
    expect(mergeAdminQueue(null, next)).toBe(next);
    const all = fullQueue();
    expect(mergeAdminQueue(scoped("activity"), all)).toBe(all);
  });

  it("activity scope refreshes activity sections and keeps background sections", () => {
    const prev = fullQueue({
      pendingSweeps: [{ airfoilId: "af-1" } as never],
      externalPromises: [{ id: "p-1" } as never],
    });
    const next = scoped("activity", { results: { done: 99, failed: 0, solved: 99 }, inFlight: 5, solvedToday: 11 });
    const merged = mergeAdminQueue(prev, next);
    // Activity sections come from the fresh payload…
    expect(merged.results).toEqual({ done: 99, failed: 0, solved: 99 });
    expect(merged.inFlight).toBe(5);
    expect(merged.solvedToday).toBe(11);
    // …background sections survive from the previous fetch (their tab's poll owns them).
    expect(merged.pendingSweeps).toEqual(prev.pendingSweeps);
    expect(merged.externalPromises).toEqual(prev.externalPromises);
    // engineCache is engine-scope-owned and must not be nulled by activity.
    expect(merged.engineCache).toEqual(prev.engineCache);
  });

  it("background scope refreshes the gap-scan list without clobbering job/engine sections", () => {
    const prev = fullQueue();
    const next = scoped("background", {
      pendingSweeps: [{ airfoilId: "af-2" } as never],
      pendingSweepsTotal: 7,
      pendingPointsTotal: 70,
      backlog: 70,
    });
    const merged = mergeAdminQueue(prev, next);
    expect(merged.pendingSweeps).toEqual(next.pendingSweeps);
    expect(merged.pendingSweepsTotal).toBe(7);
    expect(merged.backlog).toBe(70);
    expect(merged.jobs).toEqual(prev.jobs);
    expect(merged.engineHealth).toEqual(prev.engineHealth);
    expect(merged.results).toEqual(prev.results);
    // solvedToday is activity-owned: a background payload (null) must not
    // blank the badge count.
    expect(merged.solvedToday).toBe(prev.solvedToday);
  });

  it("engine scope overwrites engine blocks even with fresh unavailable/null values", () => {
    const prev = fullQueue();
    const next = scoped("engine", {
      engineQueue: null,
      engineQueueError: "engine queue refresh is still running",
      engineHealth: null,
      engineHealthError: "connect ECONNREFUSED",
      engineCache: null,
      engineRuntimeAsOf: null,
      engineRuntimeError: "engine runtime refresh is still running",
      activeJobs: [],
      inFlight: 0,
    });
    const merged = mergeAdminQueue(prev, next);
    // A fresh "unavailable" must replace the stale healthy snapshot — masking
    // a degraded engine behind old data would be fake status.
    expect(merged.engineQueue).toBeNull();
    expect(merged.engineQueueError).toBe("engine queue refresh is still running");
    expect(merged.engineHealth).toBeNull();
    expect(merged.engineHealthError).toBe("connect ECONNREFUSED");
    expect(merged.engineCache).toBeNull();
    expect(merged.engineRuntimeAsOf).toBeNull();
    // Activity/background lists stay (rendered only on their own tabs).
    expect(merged.jobs).toEqual(prev.jobs);
    expect(merged.finishedJobs).toEqual(prev.finishedJobs);
    expect(merged.pendingSweeps).toEqual(prev.pendingSweeps);
    expect(merged.results).toEqual(prev.results);
  });

  it("shell state (sweeper, engineUnreachableSince) refreshes on every scope", () => {
    const prev = fullQueue();
    const next = scoped("background", {
      sweeper: { enabled: false, heartbeatAt: "2026-07-05T11:00:00Z", cpuSlots: 8 } as AdminQueue["sweeper"],
      cpuSlotsAuto: false,
      engineUnreachableSince: "2026-07-05T10:59:00Z",
    });
    const merged = mergeAdminQueue(prev, next);
    expect(merged.sweeper).toEqual(next.sweeper);
    expect(merged.cpuSlotsAuto).toBe(false);
    expect(merged.engineUnreachableSince).toBe("2026-07-05T10:59:00Z");
    expect(merged.scope).toBe("background");
  });
});
