import { describe, expect, it } from "vitest";

import { campaignRemediationCopy } from "../components/admin/campaigns/campaign-remediation";
import {
  campaignPointsSearch,
  DEFAULT_POINT_FILTERS,
  parsePointFilters,
  type PointCorrectionSettings,
  pointCorrectionSettingsForKind,
  pointCorrectionSettingsValid,
  pointContinuationGuidance,
  pointPublicationExplanation,
  recommendedPointCorrections,
  statusChipDisplay,
  type PointStoryPayload,
} from "../lib/point-history";

const pinnedCorrectionSettings: PointCorrectionSettings = {
  mesh: {
    mesher: "blockmesh-cgrid",
    farfieldRadiusChords: 15,
    wakeLengthChords: 12,
    nSurface: 130,
    nRadial: 80,
    nWake: 60,
    targetYPlus: 1,
    spanChords: 0.1,
  },
  solver: {
    turbulenceModel: "kOmegaSST",
    nIterations: 3_000,
    convergenceTolerance: 0.00001,
    momentumScheme: "linearUpwind",
    transientCycles: 10,
    transientDiscardFraction: 0.4,
    transientMaxCourant: 4,
  },
};

const story = (
  point: Partial<PointStoryPayload["point"]> = {},
): PointStoryPayload => ({
  point: {
    resultId: "10000000-0000-4000-8000-000000000001",
    resultAttemptId: "20000000-0000-4000-8000-000000000002",
    viewResultAttemptId: "20000000-0000-4000-8000-000000000002",
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
    hasSelectedGeneration: false,
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

  it("explains why a pointer-null attempt cannot resume but can recalculate", () => {
    const guidance = pointContinuationGuidance(story());
    expect(guidance).toMatchObject({
      state: "no_selected_generation",
      title: "This run cannot continue",
      detail: expect.stringContaining("no solver generation is selected"),
      requirement: expect.stringContaining("checksummed evidence manifest"),
      freshStart: expect.stringContaining(
        "starts a new OpenFOAM case at time zero",
      ),
    });
    expect(guidance.requirement).toContain("not user authentication");
  });

  it("pre-fills every recalculation strategy from pinned values and validates edits", () => {
    const refined = pointCorrectionSettingsForKind(
      pinnedCorrectionSettings,
      "mesh_refinement",
    );
    expect(refined.mesh).toMatchObject({
      nSurface: 195,
      nRadial: 108,
      nWake: 81,
      farfieldRadiusChords: 20,
      wakeLengthChords: 16,
    });
    expect(pinnedCorrectionSettings.mesh.nSurface).toBe(130);
    expect(pointCorrectionSettingsValid(refined)).toBe(true);

    const stable = pointCorrectionSettingsForKind(
      pinnedCorrectionSettings,
      "numerical_stability",
    );
    expect(stable.solver).toMatchObject({
      nIterations: 4_500,
      transientCycles: 15,
      transientMaxCourant: 0.5,
    });

    const sampled = pointCorrectionSettingsForKind(
      pinnedCorrectionSettings,
      "longer_sampling",
    );
    expect(sampled.solver).toMatchObject({
      transientCycles: 20,
      transientDiscardFraction: 0.5,
      transientMaxCourant: 1,
    });

    const invalid = structuredClone(refined);
    invalid.mesh.nSurface = 5;
    expect(pointCorrectionSettingsValid(invalid)).toBe(false);
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
