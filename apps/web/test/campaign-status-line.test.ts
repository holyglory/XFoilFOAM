// The active status line must stay truthful in the claim→first-ingest window:
// point counters update on ingest, so while jobs are solving but nothing has
// ingested yet, the line must lead with the live job count (observed on the
// first production campaign, 2026-07-05: "0 points running" while 4 jobs
// solved at load 13.7).
import { describe, expect, it } from "vitest";

import type { AdminCampaignSummary } from "../lib/admin";
import { campaignStatusLine, gateFromSolverState } from "../components/admin/campaigns/campaign-status";

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
  failed?: number;
  rejected?: number;
  closedWithFailedCount?: number | null;
  closedWithRejectedCount?: number | null;
  reviewBuckets?: { awaitingUrans: number; needsReview: number };
}): AdminCampaignSummary {
  const now = new Date().toISOString();
  return {
    ...(overrides.reviewBuckets ? { reviewBuckets: overrides.reviewBuckets } : {}),
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
      remaining: overrides.remaining ?? 32,
    } as AdminCampaignSummary["totals"],
    scheduler: {
      sweeperEnabled: overrides.sweeperEnabled ?? true,
      engineHealthy: overrides.engineHealthy ?? true,
      engineUnreachableSince: overrides.engineUnreachableSince ?? null,
      engineError: null,
      campaignJobsRunning: overrides.jobs ?? 0,
      heartbeatAt: overrides.heartbeatAt === undefined ? now : overrides.heartbeatAt,
      lastTickStartedAt: overrides.lastTickStartedAt ?? null,
      lastTickCompletedAt: overrides.lastTickCompletedAt ?? null,
    } as AdminCampaignSummary["scheduler"],
  } as AdminCampaignSummary;
}

describe("campaignStatusLine — active gate", () => {
  it("leads with the live job count during the claim→first-ingest window", () => {
    const line = campaignStatusLine(summary({ jobs: 4, running: 0, remaining: 32 }));
    expect(line.tone).toBe("teal");
    expect(line.text).toContain("4 jobs solving");
    expect(line.text).toContain("0 points mid-ingest");
    expect(line.text).toContain("32 remaining");
  });

  it("keeps the point-based copy when no jobs are in flight", () => {
    const line = campaignStatusLine(summary({ jobs: 0, running: 0, remaining: 32 }));
    expect(line.text).toBe("Active — 0 points running, 32 remaining.");
  });

  it("dead solver process still outranks everything (regression guard)", () => {
    const line = campaignStatusLine(summary({ jobs: 0, heartbeatAt: "2026-07-01T00:00:00Z" }));
    expect(line.tone).toBe("red");
    expect(line.text).toContain("Solver process is not running");
  });
});

describe("campaignStatusLine — composite gate badge (mockup fec7b453 screen 3)", () => {
  it("dead process → gate badge BLOCKED + lifecycle 'active', never a bare Active headline", () => {
    const line = campaignStatusLine(summary({ heartbeatAt: "2026-07-01T00:00:00Z" }));
    expect(line.gate).toEqual({ text: "BLOCKED — solver process not running", tone: "red" });
    expect(line.lifecycle).toBe("active");
    expect(line.text).not.toMatch(/^Active/);
  });

  it("engine unreachable → red gate badge", () => {
    const line = campaignStatusLine(summary({ engineUnreachableSince: new Date().toISOString() }));
    expect(line.gate).toEqual({ text: "BLOCKED — engine unreachable", tone: "red" });
    expect(line.lifecycle).toBe("active");
    expect(line.text).not.toMatch(/^Active/);
  });

  it("sweeper disabled → amber gate badge", () => {
    const line = campaignStatusLine(summary({ sweeperEnabled: false }));
    expect(line.gate).toEqual({ text: "BLOCKED — sweeper disabled", tone: "amber" });
    expect(line.text).not.toMatch(/^Active/);
  });

  it("engine unhealthy → red gate badge", () => {
    const line = campaignStatusLine(summary({ engineHealthy: false }));
    expect(line.gate).toEqual({ text: "BLOCKED — engine unhealthy", tone: "red" });
    expect(line.text).not.toMatch(/^Active/);
  });

  it("dead process outranks every other gate (precedence)", () => {
    const line = campaignStatusLine(
      summary({ heartbeatAt: "2026-07-01T00:00:00Z", sweeperEnabled: false, engineHealthy: false, engineUnreachableSince: new Date().toISOString() }),
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
    expect(campaignStatusLine(summary({ status: "paused", heartbeatAt: "2026-07-01T00:00:00Z" })).gate).toBeNull();
    expect(campaignStatusLine(summary({ status: "completed" })).gate).toBeNull();
    expect(campaignStatusLine(summary({ status: "attention", failed: 1 })).gate).toBeNull();
  });
});

describe("gateFromSolverState — hub/backlog gate from the global derivation", () => {
  it("maps the four blocking solver states to gate badges", () => {
    expect(gateFromSolverState("process_not_running")).toEqual({ text: "BLOCKED — solver process not running", tone: "red" });
    expect(gateFromSolverState("engine_unreachable")).toEqual({ text: "BLOCKED — engine unreachable", tone: "red" });
    expect(gateFromSolverState("engine_unhealthy")).toEqual({ text: "BLOCKED — engine unhealthy", tone: "red" });
    expect(gateFromSolverState("paused")).toEqual({ text: "BLOCKED — sweeper disabled", tone: "amber" });
  });

  it("running / idle / unknown produce no gate", () => {
    expect(gateFromSolverState("running")).toBeNull();
    expect(gateFromSolverState("idle")).toBeNull();
    expect(gateFromSolverState("unknown")).toBeNull();
  });

  it("tick_stalled maps to the amber SLOW badge — honest slowness, never a BLOCKED lie", () => {
    const gate = gateFromSolverState("tick_stalled");
    expect(gate).toEqual({ text: "SLOW — tick running; engine responding slowly", tone: "amber" });
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
    expect(line.gate).toEqual({ text: "SLOW — tick running; engine responding slowly", tone: "amber" });
    expect(line.tone).toBe("amber");
    expect(line.text).toBe("Tick running 6m — engine responding slowly; scheduling continues next tick.");
    expect(line.lifecycle).toBe("active");
  });

  it("MUST-CATCH: stale heartbeat with the same tick fields is still the red process gate", () => {
    const line = campaignStatusLine(summary({ ...stalledOverrides, heartbeatAt: iso(120_000) }), NOW);
    expect(line.gate?.text).toBe("BLOCKED — solver process not running");
    expect(line.tone).toBe("red");
  });

  it("precedence: every BLOCKED gate outranks tick_stalled", () => {
    expect(campaignStatusLine(summary({ ...stalledOverrides, engineUnreachableSince: iso(60_000) }), NOW).gate?.text).toBe(
      "BLOCKED — engine unreachable",
    );
    expect(campaignStatusLine(summary({ ...stalledOverrides, sweeperEnabled: false }), NOW).gate?.text).toBe(
      "BLOCKED — sweeper disabled",
    );
    expect(campaignStatusLine(summary({ ...stalledOverrides, engineHealthy: false }), NOW).gate?.text).toBe(
      "BLOCKED — engine unhealthy",
    );
  });

  it("false-positive guards: short ticks and completed ticks keep the Active line", () => {
    const quick = campaignStatusLine(summary({ ...stalledOverrides, lastTickStartedAt: iso(60_000) }), NOW);
    expect(quick.gate).toBeNull();
    expect(quick.text).toMatch(/^Active/);
    const finished = campaignStatusLine(summary({ ...stalledOverrides, lastTickCompletedAt: iso(30_000) }), NOW);
    expect(finished.gate).toBeNull();
    expect(finished.text).toMatch(/^Active/);
    const preMigration = campaignStatusLine(summary({ heartbeatAt: iso(5_000), lastTickStartedAt: null, lastTickCompletedAt: null }), NOW);
    expect(preMigration.gate).toBeNull();
    expect(preMigration.text).toMatch(/^Active/);
  });
});

describe("campaignStatusLine — honest close record (completed branch)", () => {
  it("keeps the failed-only copy when the close recorded only failed points", () => {
    const line = campaignStatusLine(summary({ status: "completed", closedWithFailedCount: 2, closedWithRejectedCount: 0 }));
    expect(line.text).toBe("Completed — closed with 2 failed points.");
  });

  it("names both buckets when the close recorded failed AND rejected points", () => {
    const line = campaignStatusLine(summary({ status: "completed", closedWithFailedCount: 1, closedWithRejectedCount: 3 }));
    expect(line.text).toBe("Completed — closed with 1 failed point · 3 rejected.");
  });

  it("never renders 'closed with 0 failed points' for a rejected-only close", () => {
    const line = campaignStatusLine(summary({ status: "completed", closedWithFailedCount: 0, closedWithRejectedCount: 3 }));
    expect(line.text).toBe("Completed — closed with 3 rejected points.");
    expect(line.text).not.toContain("0 failed");
  });

  it("falls back to the clean-completion copy when both close counts are 0/null", () => {
    const line = campaignStatusLine(summary({ status: "completed", closedWithFailedCount: 0, closedWithRejectedCount: null }));
    expect(line.text).toBe("Completed — every obligated point is terminal.");
  });
});

describe("campaignStatusLine — attention covers rejected points (legacy payloads without the split)", () => {
  it("names rejected points in the attention copy", () => {
    const line = campaignStatusLine(summary({ status: "attention", rejected: 3, failed: 0 }));
    expect(line.tone).toBe("red");
    expect(line.text).toContain("3 rejected");
  });

  it("names both failed and rejected when both exist", () => {
    const line = campaignStatusLine(summary({ status: "attention", rejected: 2, failed: 1 }));
    expect(line.text).toContain("1 failed");
    expect(line.text).toContain("2 rejected");
  });
});

// Amendment-A split (approved design c19fd74a): red strictly for
// needs-review evidence; an awaiting-URANS-only attention state is the calm
// violet stage-2 queue — never a false red.
describe("campaignStatusLine — attention with the reviewBuckets split", () => {
  it("needs-review points drive the red copy (awaiting listed alongside)", () => {
    const line = campaignStatusLine(
      summary({ status: "attention", rejected: 5, failed: 1, reviewBuckets: { awaitingUrans: 3, needsReview: 2 } }),
    );
    expect(line.tone).toBe("red");
    expect(line.text).toBe("All obligated work is terminal — 2 points need review · 3 awaiting URANS.");
  });

  it("MUST-CATCH: awaiting-URANS-only attention is VIOLET, never red, no 'review' wording", () => {
    const line = campaignStatusLine(
      summary({ status: "attention", rejected: 3, failed: 0, reviewBuckets: { awaitingUrans: 3, needsReview: 0 } }),
    );
    expect(line.tone).toBe("violet");
    expect(line.text).toBe("All obligated work is terminal — 3 points awaiting URANS.");
    expect(line.text).not.toContain("review");
  });

  it("singular copy for one needs-review point", () => {
    const line = campaignStatusLine(
      summary({ status: "attention", failed: 1, reviewBuckets: { awaitingUrans: 0, needsReview: 1 } }),
    );
    expect(line.text).toBe("All obligated work is terminal — 1 point needs review.");
  });

  it("empty split buckets fall back to the legacy failed/rejected copy", () => {
    const line = campaignStatusLine(
      summary({ status: "attention", failed: 2, reviewBuckets: { awaitingUrans: 0, needsReview: 0 } }),
    );
    expect(line.text).toContain("2 failed");
  });
});
