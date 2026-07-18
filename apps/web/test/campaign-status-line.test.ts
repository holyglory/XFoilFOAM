// The active status line must stay truthful in the claim→first-ingest window:
// point counters update on ingest, so while jobs are solving but nothing has
// ingested yet, the line must lead with the live job count (observed on the
// first production campaign, 2026-07-05: "0 points running" while 4 jobs
// solved at load 13.7).
import { describe, expect, it } from "vitest";

import type { AdminCampaignSummary } from "../lib/admin";
import {
  campaignAutomaticFastCount,
  campaignHubAdmissionStatusText,
  campaignHubSchedulerStatusText,
  campaignInstrumentStatus,
  campaignStatusLine,
  gateFromSolverState,
  pausedCampaignStatusText,
  reviewQueueOperationalState,
} from "../components/admin/campaigns/campaign-status";

function summary(overrides: {
  status?: string;
  running?: number;
  remaining?: number;
  jobs?: number;
  heartbeatAt?: string | null;
  sweeperEnabled?: boolean;
  engineHealthy?: boolean;
  engineUnreachableSince?: string | null;
  lastTickStartedAt?: string | null;
  lastTickCompletedAt?: string | null;
  diskAdmissionBlocked?: boolean;
  diskAdmissionReason?: string | null;
  admissionFenceActive?: boolean;
  failed?: number;
  rejected?: number;
  blocked?: number;
  closedWithFailedCount?: number | null;
  closedWithRejectedCount?: number | null;
  reviewBuckets?: { awaitingUrans: number; needsReview: number };
  tierCounts?: { ransOpen: number; precalcOpen: number; verifyOpen: number };
}): AdminCampaignSummary {
  const now = new Date().toISOString();
  return {
    ...(overrides.reviewBuckets
      ? { reviewBuckets: overrides.reviewBuckets }
      : {}),
    ...(overrides.tierCounts ? { tierCounts: overrides.tierCounts } : {}),
    campaign: {
      status: overrides.status ?? "active",
      closedWithFailedCount: overrides.closedWithFailedCount ?? null,
      closedWithRejectedCount: overrides.closedWithRejectedCount ?? null,
    } as AdminCampaignSummary["campaign"],
    totals: {
      requested: overrides.remaining ?? 32,
      solved: 0,
      failed: overrides.failed ?? 0,
      running: overrides.running ?? 0,
      superseded: 0,
      derived: 0,
      rejected: overrides.rejected ?? 0,
      blocked: overrides.blocked ?? 0,
      remaining: overrides.remaining ?? 32,
    } as AdminCampaignSummary["totals"],
    scheduler: {
      sweeperEnabled: overrides.sweeperEnabled ?? true,
      engineHealthy: overrides.engineHealthy ?? true,
      engineUnreachableSince: overrides.engineUnreachableSince ?? null,
      engineError: null,
      campaignJobsRunning: overrides.jobs ?? 0,
      heartbeatAt:
        overrides.heartbeatAt === undefined ? now : overrides.heartbeatAt,
      lastTickStartedAt: overrides.lastTickStartedAt ?? null,
      lastTickCompletedAt: overrides.lastTickCompletedAt ?? null,
      diskAdmissionBlocked: overrides.diskAdmissionBlocked ?? false,
      diskAdmissionReason: overrides.diskAdmissionReason ?? null,
      admissionFenceActive: overrides.admissionFenceActive ?? false,
    } as AdminCampaignSummary["scheduler"],
  } as AdminCampaignSummary;
}

describe("campaignStatusLine — active gate", () => {
  it("leads with the live job count during the claim→first-ingest window", () => {
    const line = campaignStatusLine(
      summary({ jobs: 4, running: 0, remaining: 32 }),
    );
    expect(line.tone).toBe("teal");
    expect(line.text).toContain("4 jobs solving");
    expect(line.text).toContain("0 points mid-ingest");
    expect(line.text).toContain("32 remaining");
  });

  it("keeps the point-based copy when no jobs are in flight", () => {
    const line = campaignStatusLine(
      summary({ jobs: 0, running: 0, remaining: 32 }),
    );
    expect(line.text).toBe("Active — 0 points running, 32 remaining.");
  });

  it("dead solver process still outranks everything (regression guard)", () => {
    const line = campaignStatusLine(
      summary({ jobs: 0, heartbeatAt: "2026-07-01T00:00:00Z" }),
    );
    expect(line.tone).toBe("red");
    expect(line.text).toContain("Solver process is not running");
  });
});

describe("CampaignsHub — admission-fence precedence", () => {
  it("shows the critical safety stop before the generic disabled copy", () => {
    const line = campaignHubAdmissionStatusText("admission_fenced", false);
    expect(line).toMatch(/Safety stop/i);
    expect(line).toMatch(/Running jobs continue/i);
    expect(line).toMatch(
      /engineering investigation is required before Resume/i,
    );
    expect(line).not.toMatch(/Sweeper disabled/i);
    expect(campaignHubAdmissionStatusText("paused", false)).toMatch(
      /Sweeper disabled/i,
    );
  });

  it("ReviewStep emits one primary state: safety stop outranks engine unreachable", () => {
    expect(
      reviewQueueOperationalState({
        processDead: false,
        admissionFenceActive: true,
        sweeperEnabled: false,
        engineUnreachableSince: new Date().toISOString(),
      }),
    ).toBe("safety_stop");
    expect(
      reviewQueueOperationalState({
        processDead: false,
        admissionFenceActive: false,
        sweeperEnabled: true,
        engineUnreachableSince: new Date().toISOString(),
      }),
    ).toBe("engine_unreachable");
    expect(
      reviewQueueOperationalState({
        processDead: true,
        admissionFenceActive: true,
        sweeperEnabled: false,
        engineUnreachableSince: new Date().toISOString(),
      }),
    ).toBe("process_not_running");
  });

  it("keeps SAFETY STOP primary when the engine is also unreachable", () => {
    const text = campaignHubSchedulerStatusText("admission_fenced", {
      sweeperEnabled: false,
      engineUnreachableSince: new Date().toISOString(),
    });
    expect(text).toMatch(/Safety stop/i);
    expect(text).toMatch(
      /engineering investigation is required before Resume/i,
    );
    expect(text).not.toMatch(/^Engine unreachable/i);
    expect(
      campaignHubSchedulerStatusText("engine_unreachable", {
        sweeperEnabled: true,
        engineUnreachableSince: new Date().toISOString(),
      }),
    ).toMatch(/^Engine unreachable/i);
    expect(
      campaignHubSchedulerStatusText("process_not_running", {
        sweeperEnabled: false,
        engineUnreachableSince: new Date().toISOString(),
      }),
    ).toMatch(/^Solver process is not running/i);
  });
});

describe("pausedCampaignStatusText — provenance without invention", () => {
  const NOW = Date.parse("2026-07-13T12:00:00.000Z");

  it("MUST-CATCH: uses the recorded reason instead of claiming the viewer paused it", () => {
    expect(
      pausedCampaignStatusText(
        {
          action: "pause",
          actor: null,
          reason: "solver maintenance",
          createdAt: "2026-07-13T08:00:00.000Z",
        },
        0,
        NOW,
      ),
    ).toBe(
      "Paused for solver maintenance · reason recorded 4h ago. No new points are scheduled while paused.",
    );
  });

  it("FALSE-POSITIVE GUARD: missing history stays explicitly unknown and preserves a real finishing-job count", () => {
    const text = pausedCampaignStatusText(null, 2, NOW);
    expect(text).toContain("reason unavailable");
    expect(text).toContain("2 running jobs will finish");
    expect(text).not.toContain("by you");
  });
});

describe("campaignStatusLine — composite gate badge (mockup fec7b453 screen 3)", () => {
  it("dead process → gate badge BLOCKED + lifecycle 'active', never a bare Active headline", () => {
    const line = campaignStatusLine(
      summary({ heartbeatAt: "2026-07-01T00:00:00Z" }),
    );
    expect(line.gate).toEqual({
      text: "BLOCKED — solver process not running",
      tone: "red",
    });
    expect(line.lifecycle).toBe("active");
    expect(line.text).not.toMatch(/^Active/);
  });

  it("engine unreachable → red gate badge", () => {
    const line = campaignStatusLine(
      summary({ engineUnreachableSince: new Date().toISOString() }),
    );
    expect(line.gate).toEqual({
      text: "BLOCKED — engine unreachable",
      tone: "red",
    });
    expect(line.lifecycle).toBe("active");
    expect(line.text).not.toMatch(/^Active/);
  });

  it("sweeper disabled → amber gate badge", () => {
    const line = campaignStatusLine(summary({ sweeperEnabled: false }));
    expect(line.gate).toEqual({
      text: "BLOCKED — sweeper disabled",
      tone: "amber",
    });
    expect(line.text).not.toMatch(/^Active/);
  });

  it("critical admission fence → red SAFETY STOP, never a misleading pause", () => {
    const line = campaignStatusLine(
      summary({
        sweeperEnabled: false,
        admissionFenceActive: true,
        jobs: 2,
      }),
    );
    expect(line.gate).toEqual({
      text: "SAFETY STOP — critical solver outcome",
      tone: "red",
    });
    expect(line.text).toMatch(/2 active jobs continue/i);
    expect(line.text).toMatch(/new submissions are fenced/i);

    const hero = campaignInstrumentStatus(
      summary({
        sweeperEnabled: false,
        admissionFenceActive: true,
        jobs: 2,
      }),
    );
    expect(hero).toMatchObject({
      title: "Solver safety stop",
      tone: "red",
      action: null,
    });
  });

  it("engine unhealthy → red gate badge", () => {
    const line = campaignStatusLine(summary({ engineHealthy: false }));
    expect(line.gate).toEqual({
      text: "BLOCKED — engine unhealthy",
      tone: "red",
    });
    expect(line.text).not.toMatch(/^Active/);
  });

  it("storage reserve → amber gate with the measured scheduler reason", () => {
    const reason =
      "Storage admission stopped: 93.0% used; 21.0 GiB free; 68.0 GiB required.";
    const line = campaignStatusLine(
      summary({
        diskAdmissionBlocked: true,
        diskAdmissionReason: reason,
      }),
    );
    expect(line.gate).toEqual({
      text: "BLOCKED — storage reserve reached",
      tone: "amber",
    });
    expect(line.text).toBe(reason);
  });

  it("dead process outranks every other gate (precedence)", () => {
    const line = campaignStatusLine(
      summary({
        heartbeatAt: "2026-07-01T00:00:00Z",
        sweeperEnabled: false,
        engineHealthy: false,
        engineUnreachableSince: new Date().toISOString(),
      }),
    );
    expect(line.gate?.text).toBe("BLOCKED — solver process not running");
  });

  it("healthy active campaign has NO gate and keeps the Active line", () => {
    const line = campaignStatusLine(summary({ jobs: 2 }));
    expect(line.gate).toBeNull();
    expect(line.lifecycle).toBe("active");
    expect(line.text).toMatch(/^Active/);
  });

  it("non-active lifecycles never carry a gate (paused/completed/attention)", () => {
    expect(
      campaignStatusLine(
        summary({ status: "paused", heartbeatAt: "2026-07-01T00:00:00Z" }),
      ).gate,
    ).toBeNull();
    expect(
      campaignStatusLine(summary({ status: "completed" })).gate,
    ).toBeNull();
    expect(
      campaignStatusLine(summary({ status: "attention", failed: 1 })).gate,
    ).toBeNull();
  });
});

describe("campaignInstrumentStatus — one truthful hero message", () => {
  it("MUST-CATCH: folds the storage gate and active lifecycle into one automatic safeguard message", () => {
    const s = summary({
      jobs: 8,
      diskAdmissionBlocked: true,
      diskAdmissionReason:
        "Storage admission stopped: 93.0% used; 21.0 GiB free; 68.0 GiB required.",
    });
    const view = campaignInstrumentStatus(s);
    expect(view).toEqual({
      title: "Capacity safeguard",
      detail:
        "8 active jobs continue; new work resumes automatically when capacity returns",
      tone: "amber",
      action: null,
    });
    expect(`${view.title} ${view.detail}`).not.toContain("ACTIVE");
    expect(`${view.title} ${view.detail}`).not.toContain("BLOCKED");
  });

  it("FALSE-POSITIVE GUARD: a disabled sweeper remains directly actionable", () => {
    const view = campaignInstrumentStatus(summary({ sweeperEnabled: false }));
    expect(view.title).toBe("Scheduling is off");
    expect(view.action).toBe("enable_sweeper");
    expect(view.detail).toContain("Enable scheduling");
  });

  it("FALSE-POSITIVE GUARD: healthy active work reports live jobs once", () => {
    const view = campaignInstrumentStatus(
      summary({ jobs: 4, remaining: 631_000 }),
    );
    expect(view).toEqual({
      title: "Campaign running",
      detail: "4 active jobs · 631,000 points remain",
      tone: "teal",
      action: null,
    });
  });

  it("MUST-CATCH: service failure copy does not repeat the same sentence", () => {
    const view = campaignInstrumentStatus(
      summary({ heartbeatAt: "2026-07-01T00:00:00Z" }),
    );
    expect(view.title).toBe("Solver unavailable");
    expect(view.detail).toContain("resumes after");
    expect(view.detail).not.toContain("not running");
  });
});

describe("gateFromSolverState — hub/backlog gate from the global derivation", () => {
  it("maps the admission breaker to a red safety stop", () => {
    expect(gateFromSolverState("admission_fenced")).toEqual({
      text: "SAFETY STOP — critical solver outcome",
      tone: "red",
    });
  });
  it("maps the blocking solver states to gate badges", () => {
    expect(gateFromSolverState("process_not_running")).toEqual({
      text: "BLOCKED — solver process not running",
      tone: "red",
    });
    expect(gateFromSolverState("engine_unreachable")).toEqual({
      text: "BLOCKED — engine unreachable",
      tone: "red",
    });
    expect(gateFromSolverState("engine_unhealthy")).toEqual({
      text: "BLOCKED — engine unhealthy",
      tone: "red",
    });
    expect(gateFromSolverState("paused")).toEqual({
      text: "BLOCKED — sweeper disabled",
      tone: "amber",
    });
    expect(gateFromSolverState("storage_blocked")).toEqual({
      text: "BLOCKED — storage reserve reached",
      tone: "amber",
    });
  });

  it("running / idle / unknown produce no gate", () => {
    expect(gateFromSolverState("running")).toBeNull();
    expect(gateFromSolverState("idle")).toBeNull();
    expect(gateFromSolverState("unknown")).toBeNull();
  });

  it("tick_stalled maps to the amber SLOW badge — honest slowness, never a BLOCKED lie", () => {
    const gate = gateFromSolverState("tick_stalled");
    expect(gate).toEqual({
      text: "SLOW — tick running; engine responding slowly",
      tone: "amber",
    });
    expect(gate?.text).not.toContain("BLOCKED");
    expect(gate?.tone).not.toBe("red");
  });
});

// Liveness/progress split (2026-07-06 prod false "PROCESS NOT RUNNING"): the
// campaign line must show the amber tick_stalled state while the liveness
// heartbeat is fresh but a slow engine call holds the current tick, and keep
// the red process gate ONLY for a genuinely stale heartbeat.
describe("campaignStatusLine — tick_stalled (fresh heartbeat, slow tick)", () => {
  const NOW = Date.parse("2026-07-06T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const stalledOverrides = {
    heartbeatAt: iso(5_000),
    lastTickStartedAt: iso(6 * 60_000),
    lastTickCompletedAt: iso(11 * 60_000),
  };

  it("MUST-CATCH: fresh heartbeat + >5 min unfinished tick → amber SLOW gate with the tick copy, NEVER red", () => {
    const line = campaignStatusLine(summary(stalledOverrides), NOW);
    expect(line.gate).toEqual({
      text: "SLOW — tick running; engine responding slowly",
      tone: "amber",
    });
    expect(line.tone).toBe("amber");
    expect(line.text).toBe(
      "Tick running 6m — engine responding slowly; scheduling continues next tick.",
    );
    expect(line.lifecycle).toBe("active");
  });

  it("MUST-CATCH: stale heartbeat with the same tick fields is still the red process gate", () => {
    const line = campaignStatusLine(
      summary({ ...stalledOverrides, heartbeatAt: iso(120_000) }),
      NOW,
    );
    expect(line.gate?.text).toBe("BLOCKED — solver process not running");
    expect(line.tone).toBe("red");
  });

  it("precedence: every BLOCKED gate outranks tick_stalled", () => {
    expect(
      campaignStatusLine(
        summary({ ...stalledOverrides, engineUnreachableSince: iso(60_000) }),
        NOW,
      ).gate?.text,
    ).toBe("BLOCKED — engine unreachable");
    expect(
      campaignStatusLine(
        summary({ ...stalledOverrides, sweeperEnabled: false }),
        NOW,
      ).gate?.text,
    ).toBe("BLOCKED — sweeper disabled");
    expect(
      campaignStatusLine(
        summary({ ...stalledOverrides, engineHealthy: false }),
        NOW,
      ).gate?.text,
    ).toBe("BLOCKED — engine unhealthy");
  });

  it("false-positive guards: short ticks and completed ticks keep the Active line", () => {
    const quick = campaignStatusLine(
      summary({ ...stalledOverrides, lastTickStartedAt: iso(60_000) }),
      NOW,
    );
    expect(quick.gate).toBeNull();
    expect(quick.text).toMatch(/^Active/);
    const finished = campaignStatusLine(
      summary({ ...stalledOverrides, lastTickCompletedAt: iso(30_000) }),
      NOW,
    );
    expect(finished.gate).toBeNull();
    expect(finished.text).toMatch(/^Active/);
    const preMigration = campaignStatusLine(
      summary({
        heartbeatAt: iso(5_000),
        lastTickStartedAt: null,
        lastTickCompletedAt: null,
      }),
      NOW,
    );
    expect(preMigration.gate).toBeNull();
    expect(preMigration.text).toMatch(/^Active/);
  });
});

describe("campaignStatusLine — honest close record (completed branch)", () => {
  it("keeps legacy close counters in technical logs instead of a red campaign failure count", () => {
    const line = campaignStatusLine(
      summary({
        status: "completed",
        closedWithFailedCount: 2,
        closedWithRejectedCount: 0,
      }),
    );
    expect(line.text).toBe("Completed · evidence retained in Solver logs.");
    expect(line.tone).toBe("amber");
    expect(line.text).not.toMatch(/failed|rejected|unavailable/i);
  });

  it("does not aggregate legacy failed and rejected counters into primary UI", () => {
    const line = campaignStatusLine(
      summary({
        status: "completed",
        closedWithFailedCount: 1,
        closedWithRejectedCount: 3,
      }),
    );
    expect(line.text).toBe("Completed · evidence retained in Solver logs.");
    expect(line.text).not.toMatch(/failed|rejected|4 unavailable/i);
  });

  it("never renders 'closed with 0 failed points' for a rejected-only close", () => {
    const line = campaignStatusLine(
      summary({
        status: "completed",
        closedWithFailedCount: 0,
        closedWithRejectedCount: 3,
      }),
    );
    expect(line.text).toBe("Completed · evidence retained in Solver logs.");
    expect(line.text).not.toContain("0 failed");
    expect(line.text).not.toContain("rejected");
  });

  it("falls back to the clean-completion copy when both close counts are 0/null", () => {
    const line = campaignStatusLine(
      summary({
        status: "completed",
        closedWithFailedCount: 0,
        closedWithRejectedCount: null,
      }),
    );
    expect(line.text).toBe("Completed — every obligated point is terminal.");
  });
});

describe("campaignStatusLine — legacy result evidence stays technical", () => {
  it("does not turn retained rejected RANS evidence into a red campaign failure", () => {
    const line = campaignStatusLine(
      summary({ status: "attention", rejected: 3, failed: 0 }),
    );
    expect(line.tone).toBe("amber");
    expect(line.text).toBe("Evidence retained · details in Solver logs.");
    expect(line.text).not.toMatch(/failed|rejected|unavailable/i);
  });

  it("does not synthesize a primary failure count from mixed legacy statuses", () => {
    const line = campaignStatusLine(
      summary({ status: "attention", rejected: 2, failed: 1 }),
    );
    expect(line.tone).toBe("amber");
    expect(line.text).toBe("Evidence retained · details in Solver logs.");
    expect(line.text).not.toContain("3");
  });
});

describe("campaignStatusLine — exhausted automatic recovery", () => {
  it("MUST-CATCH: names the state as critical, never as a normal blocked queue", () => {
    const line = campaignStatusLine(
      summary({
        status: "attention",
        blocked: 3,
        reviewBuckets: { awaitingUrans: 0, needsReview: 0 },
      }),
    );
    expect(line.tone).toBe("red");
    expect(line.text).toContain("3 critical recoveries exhausted");
    expect(line.text).toContain("system investigation required");
    expect(line.text).not.toContain("machine-blocked");
  });
});

// One-fidelity journey: only typed recovery exhaustion is red. Ordinary RANS
// evidence with pending/running FAST URANS is the calm violet automatic stage.
describe("campaignStatusLine — one automatic FAST-URANS handoff", () => {
  it("uses one authoritative FAST count instead of adding compatibility views", () => {
    expect(
      campaignAutomaticFastCount({
        automaticPrecalcOpen: 2,
        reviewBuckets: { awaitingUrans: 3 },
      }),
    ).toBe(2);
    expect(
      campaignAutomaticFastCount({
        automaticPrecalcOpen: 0,
        reviewBuckets: { awaitingUrans: 3 },
      }),
    ).toBe(3);
  });

  it("MUST-CATCH: normal rejected/failed RANS evidence with pending FAST work is violet, never a red failure", () => {
    const line = campaignStatusLine(
      summary({
        status: "attention",
        rejected: 1,
        failed: 1,
        reviewBuckets: { awaitingUrans: 0, needsReview: 0 },
        tierCounts: { ransOpen: 0, precalcOpen: 1, verifyOpen: 0 },
      }),
    );
    expect(line.tone).toBe("violet");
    expect(line.text).toBe("Awaiting FAST URANS · 1 point");
    expect(line.text).not.toMatch(/failed|rejected|unavailable|review/i);
  });

  it("FAST URANS remains primary when a rolling payload also carries legacy evidence counters", () => {
    const line = campaignStatusLine(
      summary({
        status: "attention",
        rejected: 5,
        failed: 1,
        reviewBuckets: { awaitingUrans: 3, needsReview: 2 },
      }),
    );
    expect(line.tone).toBe("violet");
    expect(line.text).toBe("Awaiting FAST URANS · 3 points");
    expect(line.text).not.toMatch(/failed|unavailable|review/i);
  });

  it("MUST-CATCH: awaiting-URANS-only attention is VIOLET, never red, no 'review' wording", () => {
    const line = campaignStatusLine(
      summary({
        status: "attention",
        rejected: 3,
        failed: 0,
        reviewBuckets: { awaitingUrans: 3, needsReview: 0 },
      }),
    );
    expect(line.tone).toBe("violet");
    expect(line.text).toBe("Awaiting FAST URANS · 3 points");
    expect(line.text).not.toContain("review");
  });

  it("legacy wire evidence alone stays a compact non-critical technical state", () => {
    const line = campaignStatusLine(
      summary({
        status: "attention",
        failed: 1,
        reviewBuckets: { awaitingUrans: 0, needsReview: 1 },
      }),
    );
    expect(line.tone).toBe("amber");
    expect(line.text).toBe("Evidence retained · details in Solver logs.");
  });

  it("empty split buckets never promote raw result.failed into red UI", () => {
    const line = campaignStatusLine(
      summary({
        status: "attention",
        failed: 2,
        reviewBuckets: { awaitingUrans: 0, needsReview: 0 },
      }),
    );
    expect(line.tone).toBe("amber");
    expect(line.text).toBe("Evidence retained · details in Solver logs.");
    expect(line.text).not.toMatch(/failed|critical/i);
  });
});
