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
  TICK_STALLED_AFTER_MS,
  deriveSolverState,
  formatAge,
  heartbeatAgeMs,
  isProcessDead,
  solverChipText,
  solverStateLabel,
  tickStalledForMs,
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

// Liveness/progress split (2026-07-06 prod incident: a single hung engine HTTP
// call inside tick work starved the in-tick heartbeat >90 s and a LIVE process
// rendered red "PROCESS NOT RUNNING"). heartbeatAt is now an independent 15 s
// liveness timer; lastTickStartedAt/lastTickCompletedAt carry tick progress.
describe("tick_stalled (liveness/progress split)", () => {
  // Shaped like the real incident: heartbeat fresh (timer), tick started
  // 6 min ago and never completed — computeFieldExtents hanging on a
  // saturated engine.
  const stalled: SolverStateInput = {
    ...healthy,
    lastTickStartedAt: iso(6 * 60_000),
    lastTickCompletedAt: iso(11 * 60_000),
  };

  it("MUST-CATCH: fresh heartbeat + long-running tick -> tick_stalled AMBER, never red", () => {
    const d = deriveSolverState(stalled, NOW);
    expect(d.state).toBe("tick_stalled");
    expect(d.tone).toBe("amber");
    expect(d.tone).not.toBe("red");
    expect(d.headline).toBe("Tick running 6m — engine responding slowly; scheduling continues next tick.");
  });

  it("MUST-CATCH: stale heartbeat -> red process_not_running regardless of tick fields", () => {
    // Even a tick pair that LOOKS stalled cannot excuse (or repaint) true
    // process death — liveness is independent now.
    const d = deriveSolverState({ ...stalled, heartbeatAt: iso(HEARTBEAT_STALE_MS + 1) }, NOW);
    expect(d.state).toBe("process_not_running");
    expect(d.tone).toBe("red");
    const never = deriveSolverState({ ...stalled, heartbeatAt: null }, NOW);
    expect(never.state).toBe("process_not_running");
  });

  it("tick below the 5 min threshold stays running (no premature stall)", () => {
    const d = deriveSolverState({ ...stalled, lastTickStartedAt: iso(4 * 60_000) }, NOW);
    expect(d.state).toBe("running");
  });

  it("completed >= started means the last tick finished — running, not stalled", () => {
    const d = deriveSolverState({ ...stalled, lastTickCompletedAt: iso(6 * 60_000 - 1) }, NOW);
    expect(d.state).toBe("running");
  });

  it("payload without tick fields (pre-migration) never derives tick_stalled", () => {
    const d = deriveSolverState({ ...healthy }, NOW);
    expect(d.state).toBe("running");
    const nulls = deriveSolverState({ ...healthy, lastTickStartedAt: null, lastTickCompletedAt: null }, NOW);
    expect(nulls.state).toBe("running");
  });

  it("precedence pins: process death > engine unreachable > engine unhealthy > tick_stalled > healthy", () => {
    // process death beats everything (pinned above too)
    expect(deriveSolverState({ ...stalled, heartbeatAt: null, engineUnreachableSince: iso(60_000) }, NOW).state).toBe(
      "process_not_running",
    );
    // engine unreachable beats tick_stalled
    expect(deriveSolverState({ ...stalled, engineUnreachableSince: iso(60_000) }, NOW).state).toBe("engine_unreachable");
    // engine unhealthy beats tick_stalled
    expect(deriveSolverState({ ...stalled, engineHealthy: false }, NOW).state).toBe("engine_unhealthy");
    expect(deriveSolverState({ ...stalled, engineBuildMismatch: true }, NOW).state).toBe("engine_unhealthy");
    // tick_stalled beats running/idle
    expect(deriveSolverState({ ...stalled, activeJobCount: 0, backlogOpen: false }, NOW).state).toBe("tick_stalled");
    // paused keeps its pinned position (disabled sweeper outranks the stall:
    // "scheduling continues next tick" would be a false line while paused)
    expect(deriveSolverState({ ...stalled, enabled: false }, NOW).state).toBe("paused");
    // fetch failed still wins over everything
    expect(deriveSolverState({ ...stalled, fetchOk: false }, NOW).state).toBe("unknown");
  });

  it("false-positive guard: fast tick churn (started advancing, completed lagging) is not a stall", () => {
    // Crash-looping or briskly-cycling ticks keep re-stamping started; the
    // young started timestamp must not read as a 5-min stall.
    const d = deriveSolverState({ ...healthy, lastTickStartedAt: iso(2_000), lastTickCompletedAt: iso(20 * 60_000) }, NOW);
    expect(d.state).toBe("running");
  });

  it("tickStalledForMs boundaries + unparsable stamps", () => {
    expect(tickStalledForMs(iso(TICK_STALLED_AFTER_MS), null, NOW)).toBeNull(); // exactly 5m: not yet stalled
    expect(tickStalledForMs(iso(TICK_STALLED_AFTER_MS + 1), null, NOW)).toBe(TICK_STALLED_AFTER_MS + 1);
    expect(tickStalledForMs(null, null, NOW)).toBeNull();
    expect(tickStalledForMs("not-a-date", null, NOW)).toBeNull(); // never invent a stall
    expect(tickStalledForMs(iso(600_000), "not-a-date", NOW)).toBe(600_000); // bad completed = not completed
    expect(tickStalledForMs(iso(600_000), iso(600_000), NOW)).toBeNull(); // completed == started counts as finished
  });

  it("label + chip copy for the new state", () => {
    expect(solverStateLabel("tick_stalled")).toBe("TICK STALLED");
    expect(solverChipText("tick_stalled")).toBe("solver · tick stalled");
  });
});
