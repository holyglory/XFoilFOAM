import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { AdminCampaignListItem } from "../lib/admin";

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(
  resolve(here, "../components/admin/campaigns/CampaignsHub.tsx"),
  "utf8",
);
const refreshBody =
  source.match(
    /const refresh = useCallback\(async \(signal\?: AbortSignal\) => \{([\s\S]*?)\n  \}, \[\]\);/,
  )?.[1] ?? "";

describe("CampaignsHub bounded polling", () => {
  it("MUST-CATCH: one list request supplies every visible campaign card", () => {
    expect(refreshBody).not.toBe("");
    expect(refreshBody.match(/\blistCampaigns\s*\(/g)).toHaveLength(1);
    expect(refreshBody).not.toMatch(/\bgetCampaign\s*\(/);
    expect(source).not.toMatch(
      /result\.items\.map\([\s\S]{0,400}\bgetCampaign\s*\(/,
    );
  });

  it("passes the poll AbortSignal into the single list request", () => {
    expect(refreshBody).toMatch(
      /\blistCampaigns\s*\([\s\S]*?,\s*signal\s*,?\s*\)/,
    );
    expect(refreshBody).toContain("if (signal?.aborted) return");
  });

  it("renders objective, Reynolds and live-job truth from the list card model", () => {
    expect(source).toContain("item.card.objectives");
    expect(source).toContain("item.card?.reynolds ?? []");
    expect(source).toContain("item.card?.campaignJobsRunning ?? 0");
  });

  it("MUST-CATCH: a legacy list item without card data survives a rolling deploy", () => {
    const legacyItem = {
      id: "legacy-campaign",
      slug: "legacy-campaign",
      name: "Legacy campaign",
      status: "active",
      priority: 5,
      notes: null,
      closedWithFailedCount: null,
      closedWithRejectedCount: null,
      completedAt: null,
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z",
      conditionCount: 1,
      airfoilCount: 1,
      excludedAirfoilCount: 0,
      automaticPrecalcOpen: 0,
      reviewBuckets: { awaitingUrans: 0, needsReview: 0 },
      remediation: { repairing: 0, blocked: 0, groups: [] },
      totals: {
        requested: 10,
        solved: 2,
        failed: 0,
        running: 1,
        superseded: 0,
        derived: 0,
        rejected: 0,
        blocked: 0,
        remaining: 7,
      },
      latestLifecycleEvent: null,
    } satisfies AdminCampaignListItem;
    expect("card" in legacyItem).toBe(false);
    expect(source).toContain("if (!item.card) return null");
    expect(source).toContain("item.card?.campaignJobsRunning ?? 0");
    expect(source).toContain("item.card?.reynolds ?? []");
    expect(source).not.toContain("item.card.reynolds.map(formatRe)");
    expect(source).not.toContain("item.card.campaignJobsRunning;");
  });
});
