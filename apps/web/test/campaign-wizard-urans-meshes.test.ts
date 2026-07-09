import { describe, expect, it } from "vitest";

import { buildPlanInput, type WizardAnglePlan, type WizardEnvelope } from "../components/admin/campaigns/plan-model";
import { formatUransMeshDisclosureValue, formatUransMeshReviewSummary } from "../components/admin/campaigns/urans-mesh-selection";
import { draftFromPrefill, emptyDraft, restoreDraft } from "../components/admin/campaigns/wizard-draft";
import type { CampaignDuplicatePrefill, CampaignPlanInput } from "../lib/admin";

const baseNumerics: CampaignPlanInput["numerics"] = {
  boundaryProfileId: "boundary-1",
  meshProfileId: "mesh-rans",
  solverProfileId: "solver-1",
  outputProfileId: "output-1",
};

function campaignPlan(numerics: CampaignPlanInput["numerics"] = baseNumerics): CampaignPlanInput {
  return {
    mediumId: "medium-air",
    ambients: [["288.1500", "101325.0000"]],
    speedsMps: ["50.0000"],
    chordsM: ["1.0000"],
    spanM: "1.0000",
    areaMode: "derived",
    areaM2: null,
    excludedConditions: [],
    baseSweep: { fromDeg: "-2.0000", toDeg: "8.0000", stepDeg: "1.0000", listDeg: null },
    objectives: {
      ldMax: { enabled: false, toleranceDeg: "0.10", maxRounds: 8 },
      clZero: { enabled: false, toleranceDeg: "0.05", maxRounds: 6 },
      clMax: { enabled: false, toleranceDeg: "0.10", maxRounds: 8 },
    },
    numerics,
  };
}

function prefill(numerics: CampaignPlanInput["numerics"]): CampaignDuplicatePrefill {
  return {
    name: "Duplicate campaign",
    notes: null,
    priority: 5,
    airfoilIds: ["airfoil-1"],
    plan: campaignPlan(numerics),
  };
}

const envelope: WizardEnvelope = {
  mediumId: "medium-air",
  ambients: [["288.1500", "101325.0000"]],
  speedsMps: ["50.0000"],
  chordsM: ["1.0000"],
  spanM: "1.0000",
  areaMode: "derived",
  areaM2: null,
  excludedConditions: [],
};

const angle: WizardAnglePlan = {
  sweepMode: "range",
  fromDeg: -2,
  toDeg: 8,
  stepDeg: 1,
  listText: "",
  ldMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 8 },
  clZero: { enabled: false, toleranceDeg: 0.05, maxRounds: 6 },
  clMax: { enabled: false, toleranceDeg: 0.1, maxRounds: 8 },
};

describe("campaign wizard URANS mesh plan fields", () => {
  it("defaults both URANS mesh overrides to null in new drafts", () => {
    const draft = emptyDraft("polar_sweep");
    expect(draft.numerics.uransMeshProfileId).toBeNull();
    expect(draft.numerics.uransPrecalcMeshProfileId).toBeNull();
  });

  it("round-trips duplicate prefills with explicit URANS mesh overrides", () => {
    const draft = draftFromPrefill(
      prefill({
        ...baseNumerics,
        uransMeshProfileId: "mesh-full",
        uransPrecalcMeshProfileId: "mesh-precalc",
      }),
    );
    expect(draft.numerics).toMatchObject({
      boundaryProfileId: "boundary-1",
      meshProfileId: "mesh-rans",
      solverProfileId: "solver-1",
      outputProfileId: "output-1",
      uransMeshProfileId: "mesh-full",
      uransPrecalcMeshProfileId: "mesh-precalc",
    });
  });

  it("normalizes absent duplicate-prefill and restored-draft values to explicit null", () => {
    expect(draftFromPrefill(prefill(baseNumerics)).numerics).toMatchObject({
      uransMeshProfileId: null,
      uransPrecalcMeshProfileId: null,
    });

    const restored = restoreDraft(
      JSON.stringify({
        ...emptyDraft("polar_sweep"),
        numerics: baseNumerics,
      }),
    );
    expect(restored?.numerics.uransMeshProfileId).toBeNull();
    expect(restored?.numerics.uransPrecalcMeshProfileId).toBeNull();
  });

  it("emits explicit null keys in plan payloads when overrides are unset", () => {
    const plan = buildPlanInput(envelope, angle, baseNumerics);
    expect(plan.numerics).toEqual({
      ...baseNumerics,
      uransMeshProfileId: null,
      uransPrecalcMeshProfileId: null,
    });
  });

  it("keeps explicit URANS mesh ids in plan payloads", () => {
    const plan = buildPlanInput(envelope, angle, {
      ...baseNumerics,
      uransMeshProfileId: "mesh-full",
      uransPrecalcMeshProfileId: "mesh-precalc",
    });
    expect(plan.numerics.uransMeshProfileId).toBe("mesh-full");
    expect(plan.numerics.uransPrecalcMeshProfileId).toBe("mesh-precalc");
  });

  it("formats review and collapsed disclosure summaries from real mesh names", () => {
    const meshProfiles = [
      { id: "mesh-full", name: "Full URANS wall mesh" },
      { id: "mesh-precalc", name: "Precalc half mesh" },
    ];

    expect(formatUransMeshReviewSummary(baseNumerics, meshProfiles)).toBe("Derived");
    expect(formatUransMeshDisclosureValue(baseNumerics, meshProfiles)).toBe("Derived (default)");
    expect(formatUransMeshReviewSummary({ uransMeshProfileId: "mesh-full", uransPrecalcMeshProfileId: null }, meshProfiles)).toBe(
      "Full: Full URANS wall mesh · Precalc: Derived",
    );
    expect(formatUransMeshReviewSummary({ uransMeshProfileId: "mesh-full", uransPrecalcMeshProfileId: "mesh-precalc" }, meshProfiles)).toBe(
      "Full: Full URANS wall mesh · Precalc: Precalc half mesh",
    );
  });
});
