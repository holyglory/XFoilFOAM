import { describe, expect, it } from "vitest";

import { campaignRemediationCopy } from "../components/admin/campaigns/campaign-remediation";
import {
  campaignPointsSearch,
  DEFAULT_POINT_FILTERS,
  parsePointFilters,
  pointPublicationExplanation,
  recommendedPointCorrections,
  statusChipDisplay,
  type PointStoryPayload,
} from "../lib/point-history";

const story = (
  point: Partial<PointStoryPayload["point"]> = {},
): PointStoryPayload => ({
  point: {
    resultId: "10000000-0000-4000-8000-000000000001",
    resultAttemptId: "20000000-0000-4000-8000-000000000002",
    airfoilId: "30000000-0000-4000-8000-000000000003",
    airfoilSlug: "test-foil",
    airfoilName: "Test Foil",
    aoaDeg: 12,
    reynolds: 400_000,
    mach: 0.06,
    speed: 20,
    regime: "urans",
    status: "done",
    error: null,
    qualityWarnings: [],
    classification: {
      state: "rejected",
      reasons: ["too few repeatable periods", "missing clean cycle"],
      confidence: 1,
      classifierVersion: "test-v1",
    },
    revisionId: "40000000-0000-4000-8000-000000000004",
    campaignId: "50000000-0000-4000-8000-000000000005",
    campaignName: "Campaign",
    conditionId: "60000000-0000-4000-8000-000000000006",
    solvedAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    fidelity: "urans_precalc",
    reviewBucket: null,
    workDisposition: "blocked",
    continuable: false,
    continuationResultAttemptId: null,
    correctionSetup: null,
    verify: null,
    ...point,
  },
  attempts: [],
  interruptions: [],
  corrections: [],
  closure: null,
});

describe("unpublished point tools", () => {
  it("routes campaign counts to the unified unpublished point explorer", () => {
    const campaignId = "50000000-0000-4000-8000-000000000005";
    const search = campaignPointsSearch(campaignId, "unpublished");
    expect(parsePointFilters(search)).toEqual({
      ...DEFAULT_POINT_FILTERS,
      campaignId,
      status: "unpublished",
    });
  });

  it("keeps terminal unpublished evidence amber instead of a red fleet alarm", () => {
    expect(statusChipDisplay("rejected", null, "blocked")).toEqual({
      label: "not published",
      tone: "amber",
    });
  });

  it("explains stored rejection reasons and recommends longer sampling", () => {
    const payload = story();
    expect(pointPublicationExplanation(payload)).toMatchObject({
      title: expect.stringContaining("Not published"),
      detail: expect.stringContaining("too few repeatable periods"),
      tone: "amber",
    });
    expect(recommendedPointCorrections(payload)).toEqual([
      "longer_sampling",
      "manual",
    ]);
  });

  it("reports active automatic follow-up before any manual diagnosis", () => {
    expect(
      pointPublicationExplanation(
        story({ status: "failed", workDisposition: "scheduled" }),
      ),
    ).toMatchObject({
      title: expect.stringContaining("solver follow-up is queued"),
      tone: "violet",
    });
  });

  it("keeps campaign copy calm while naming the real destination", () => {
    expect(
      campaignRemediationCopy({
        repairing: 0,
        blocked: 2,
        groups: [
          {
            reason: "mesh_quality",
            state: "blocked",
            owner: "system",
            points: 2,
          },
        ],
      }),
    ).toMatchObject({
      label: "not published",
      detail: expect.stringContaining("Solver › Points"),
    });
  });
});
