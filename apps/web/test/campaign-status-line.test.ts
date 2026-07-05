// The active status line must stay truthful in the claim→first-ingest window:
// point counters update on ingest, so while jobs are solving but nothing has
// ingested yet, the line must lead with the live job count (observed on the
// first production campaign, 2026-07-05: "0 points running" while 4 jobs
// solved at load 13.7).
import { describe, expect, it } from "vitest";

import type { AdminCampaignSummary } from "../lib/admin";
import { campaignStatusLine } from "../components/admin/campaigns/campaign-status";

function summary(overrides: {
  status?: string;
  running?: number;
  remaining?: number;
  jobs?: number;
  heartbeatAt?: string | null;
  failed?: number;
  rejected?: number;
  closedWithFailedCount?: number | null;
  closedWithRejectedCount?: number | null;
}): AdminCampaignSummary {
  const now = new Date().toISOString();
  return {
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
      sweeperEnabled: true,
      engineHealthy: true,
      engineUnreachableSince: null,
      engineError: null,
      campaignJobsRunning: overrides.jobs ?? 0,
      heartbeatAt: overrides.heartbeatAt === undefined ? now : overrides.heartbeatAt,
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

describe("campaignStatusLine — attention covers rejected points", () => {
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
