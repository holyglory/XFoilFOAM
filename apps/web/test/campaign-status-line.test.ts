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
}): AdminCampaignSummary {
  const now = new Date().toISOString();
  return {
    campaign: { status: overrides.status ?? "active", closedWithFailedCount: null } as AdminCampaignSummary["campaign"],
    totals: {
      requested: overrides.remaining ?? 32,
      solved: 0,
      failed: 0,
      running: overrides.running ?? 0,
      superseded: 0,
      derived: 0,
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
