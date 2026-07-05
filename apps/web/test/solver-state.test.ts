// Must-catch layer for the stale-heartbeat regression (DecisionHistory
// 2026-07-05 "First Real Campaign Run"): a sweeper row with enabled=true but
// a dead process misled a real launch — the UI read "sweeper running" while
// nothing could schedule. Every state and boundary of deriveSolverState is
// pinned here, shaped like the real payloads (ISO heartbeats vs a fixed now),
// plus false-positive guards for healthy/paused states.

import { describe, expect, it } from "vitest";

import {
  HEARTBEAT_STALE_MS,
  PROCESS_NOT_RUNNING_DETAIL,
  deriveSolverState,
  formatAge,
  heartbeatAgeMs,
  isProcessDead,
  solverChipText,
  solverStateLabel,
  type SolverStateInput,
} from "../lib/solver-state";

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const healthy: SolverStateInput = {
  fetchOk: true,
  heartbeatAt: iso(5_000),
  enabled: true,
  engineUnreachableSince: null,
  engineHealthy: true,
  activeJobCount: 3,
  backlogOpen: true,
};

describe("deriveSolverState gate precedence", () => {
  it("fetch failed -> unknown, never green-by-default (even with otherwise healthy inputs)", () => {
    const d = deriveSolverState({ ...healthy, fetchOk: false }, NOW);
    expect(d.state).toBe("unknown");
    expect(d.tone).not.toBe("teal");
    expect(d.headline).toMatch(/unknown/i);
  });

  it("null heartbeat -> process_not_running with 'never reported a heartbeat'", () => {
    const d = deriveSolverState({ ...healthy, heartbeatAt: null }, NOW);
    expect(d.state).toBe("process_not_running");
    expect(d.tone).toBe("red");
    expect(d.headline).toContain("has never reported a heartbeat");
    expect(d.detail).toBe(PROCESS_NOT_RUNNING_DETAIL);
    expect(d.detail).toMatch(/coordinator runtime sweeper/);
    expect(d.detail).toMatch(/sweeper service/);
  });

  it("REGRESSION: enabled=true with a days-stale heartbeat is PROCESS NOT RUNNING, not running", () => {
    // Shaped like the real 2026-07-05 incident: sweeper_state.enabled=true,
    // heartbeat days old, engine healthy — the old UI showed "sweeper
    // running" and prescribed Resume.
    const d = deriveSolverState({ ...healthy, heartbeatAt: iso(3 * 86_400_000) }, NOW);
    expect(d.state).toBe("process_not_running");
    expect(d.tone).toBe("red");
    expect(d.headline).toMatch(/last heartbeat 3d ago/);
    expect(d.detail).toBe(PROCESS_NOT_RUNNING_DETAIL);
  });

  it("boundary: exactly 90s old heartbeat is still alive; 90s+1ms is dead", () => {
    const alive = deriveSolverState({ ...healthy, heartbeatAt: iso(HEARTBEAT_STALE_MS) }, NOW);
    expect(alive.state).toBe("running");
    const dead = deriveSolverState({ ...healthy, heartbeatAt: iso(HEARTBEAT_STALE_MS + 1) }, NOW);
    expect(dead.state).toBe("process_not_running");
  });

  it("unparsable heartbeat timestamp is treated as dead, not alive", () => {
    const d = deriveSolverState({ ...healthy, heartbeatAt: "not-a-date" }, NOW);
    expect(d.state).toBe("process_not_running");
  });

  it("process dead wins over paused (dead + disabled is NOT 'paused')", () => {
    const d = deriveSolverState({ ...healthy, heartbeatAt: null, enabled: false }, NOW);
    expect(d.state).toBe("process_not_running");
  });

  it("process dead wins over engine unreachable", () => {
    const d = deriveSolverState(
      { ...healthy, heartbeatAt: iso(10 * 60_000), engineUnreachableSince: iso(60_000) },
      NOW,
    );
    expect(d.state).toBe("process_not_running");
  });

  it("alive + disabled -> paused (amber), with the honest running-jobs detail", () => {
    const d = deriveSolverState({ ...healthy, enabled: false }, NOW);
    expect(d.state).toBe("paused");
    expect(d.tone).toBe("amber");
    expect(d.detail).toMatch(/continue until they finish/);
  });

  it("compound paused + engine down -> secondary chip 'engine also unreachable … backoff'", () => {
    const d = deriveSolverState({ ...healthy, enabled: false, engineUnreachableSince: iso(120_000) }, NOW);
    expect(d.state).toBe("paused");
    expect(d.secondary.some((s) => s.includes("engine also unreachable since") && s.includes("resuming will hold in backoff"))).toBe(true);
  });

  it("alive + enabled + engine unreachable -> engine_unreachable (red) with backoff honesty", () => {
    const d = deriveSolverState({ ...healthy, engineUnreachableSince: iso(300_000) }, NOW);
    expect(d.state).toBe("engine_unreachable");
    expect(d.tone).toBe("red");
    expect(d.headline).toMatch(/no jobs are being submitted/i);
    expect(d.detail).toMatch(/held with backoff/);
    expect(d.detail).toMatch(/not marked failed/);
  });

  it("engine reachable but unhealthy -> engine_unhealthy (amber, advisory)", () => {
    const d = deriveSolverState({ ...healthy, engineHealthy: false }, NOW);
    expect(d.state).toBe("engine_unhealthy");
    expect(d.tone).toBe("amber");
  });

  it("engine build mismatch -> engine_unhealthy even when health probe says ok", () => {
    const d = deriveSolverState({ ...healthy, engineBuildMismatch: true }, NOW);
    expect(d.state).toBe("engine_unhealthy");
    expect(d.headline).toMatch(/build mismatch/i);
  });

  it("false-positive guard: healthy input -> running with jobs-in-flight + heartbeat age", () => {
    const d = deriveSolverState(healthy, NOW);
    expect(d.state).toBe("running");
    expect(d.tone).toBe("teal");
    // Without a points total in the payload the job count carries its own
    // unit label — "engine jobs" — so it can never be misread as points.
    expect(d.headline).toBe("Running — 3 engine jobs in flight · heartbeat 5s ago");
  });

  it("singular job count reads '1 engine job in flight'", () => {
    const d = deriveSolverState({ ...healthy, activeJobCount: 1 }, NOW);
    expect(d.headline).toContain("1 engine job in flight");
  });

  it("idle only when 0 jobs AND backlog closed", () => {
    const d = deriveSolverState({ ...healthy, activeJobCount: 0, backlogOpen: false }, NOW);
    expect(d.state).toBe("idle");
    expect(d.tone).toBe("teal");
    expect(d.headline).toMatch(/^Idle — running, nothing pending/);
  });

  it("0 jobs with backlog still open is running (work pending, not idle)", () => {
    const d = deriveSolverState({ ...healthy, activeJobCount: 0, backlogOpen: true }, NOW);
    expect(d.state).toBe("running");
  });

  it("unknown backlog (undefined) never claims idle", () => {
    const d = deriveSolverState({ ...healthy, activeJobCount: 0, backlogOpen: undefined }, NOW);
    expect(d.state).toBe("running");
  });
});

// MUST-CATCH (2026-07-06 user report "7 jobs in flight but 15 are running?"):
// the banner counts ENGINE JOB BATCHES, the campaign backlog strip counts
// POINTS — adjacent unlabelled counts in different units read as a
// contradiction on a healthy system.
describe("running headline unit labels (jobs vs points)", () => {
  it("payload carries the campaign points total -> both units, side by side", () => {
    const d = deriveSolverState({ ...healthy, activeJobCount: 7, campaignPointsSolving: 14 }, NOW);
    expect(d.headline).toBe("Running — 7 jobs in flight · 14 points solving · heartbeat 5s ago");
  });

  it("singular point count reads '1 point solving'", () => {
    const d = deriveSolverState({ ...healthy, campaignPointsSolving: 1 }, NOW);
    expect(d.headline).toContain("1 point solving");
  });

  it("points total ABSENT from the payload -> jobs relabelled 'engine jobs', no invented points count", () => {
    const d = deriveSolverState({ ...healthy, campaignPointsSolving: null }, NOW);
    expect(d.headline).toBe("Running — 3 engine jobs in flight · heartbeat 5s ago");
    expect(d.headline).not.toMatch(/points solving/);
  });

  it("zero campaign points is treated as absent (background gap-fill jobs DO solve non-campaign points — '0 points solving' would be a false number)", () => {
    const d = deriveSolverState({ ...healthy, campaignPointsSolving: 0 }, NOW);
    expect(d.headline).toBe("Running — 3 engine jobs in flight · heartbeat 5s ago");
    expect(d.headline).not.toMatch(/0 points/);
  });
});

describe("engineQueueError is always a secondary chip, never primary", () => {
  const states: Array<[string, SolverStateInput]> = [
    ["running", { ...healthy, engineQueueError: true }],
    ["paused", { ...healthy, enabled: false, engineQueueError: true }],
    ["process_not_running", { ...healthy, heartbeatAt: null, engineQueueError: true }],
    ["engine_unreachable", { ...healthy, engineUnreachableSince: iso(60_000), engineQueueError: true }],
  ];
  for (const [expected, input] of states) {
    it(`stays ${expected} with the celery chip in secondary`, () => {
      const d = deriveSolverState(input, NOW);
      expect(d.state).toBe(expected);
      expect(d.secondary).toContain("celery introspection unavailable");
      expect(d.headline).not.toMatch(/celery/i);
    });
  }
  it("no celery chip when introspection works", () => {
    expect(deriveSolverState(healthy, NOW).secondary).not.toContain("celery introspection unavailable");
  });
});

describe("helpers", () => {
  it("heartbeatAgeMs / isProcessDead boundaries", () => {
    expect(heartbeatAgeMs(null, NOW)).toBeNull();
    expect(heartbeatAgeMs(iso(1_000), NOW)).toBe(1_000);
    expect(isProcessDead(null, NOW)).toBe(true);
    expect(isProcessDead(iso(HEARTBEAT_STALE_MS), NOW)).toBe(false);
    expect(isProcessDead(iso(HEARTBEAT_STALE_MS + 1), NOW)).toBe(true);
  });

  it("formatAge buckets", () => {
    expect(formatAge(4_000)).toBe("4s");
    expect(formatAge(300_000)).toBe("5m");
    expect(formatAge(2 * 3_600_000)).toBe("2h");
    expect(formatAge(3 * 86_400_000)).toBe("3d");
  });

  it("state labels + hub chip copy match the approved mockups", () => {
    expect(solverStateLabel("process_not_running")).toBe("PROCESS NOT RUNNING");
    expect(solverChipText("running", 4)).toBe("solver · running · 4 jobs");
    expect(solverChipText("running", 1)).toBe("solver · running · 1 job");
    expect(solverChipText("paused")).toBe("solver · paused");
    expect(solverChipText("process_not_running")).toBe("solver · process not running");
    expect(solverChipText("engine_unreachable")).toBe("solver · engine unreachable");
    expect(solverChipText("idle")).toBe("solver · idle");
  });
});
