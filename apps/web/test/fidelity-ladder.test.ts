// Fidelity ladder web surfaces — pure invariants:
//   • pverify URL param round-trip (Points tab "verify pending"/"disagreed"
//     filters) + the cell-panel link builder
//   • fidelityChipView truth table (the ONE chip rule for rows, story header,
//     cell panel and the solver-results modal)
//   • disagreedDeltaLabel bound selection (contract-4 limits pinned)
//   • verify events in the story timeline
//   • buildSteadyHistoryModel (oscillating-steady iteration chart)
//   • campaignPhaseBadge / tierCountsLine (contract 7 phase display)
import { describe, expect, it } from "vitest";

import {
  campaignPhaseBadge,
  tierCountsLine,
  type CampaignGate,
} from "../components/admin/campaigns/campaign-status";
import {
  assembleTimeline,
  DEFAULT_POINT_FILTERS,
  disagreedDeltaLabel,
  fidelityChipView,
  parsePointFilters,
  pointFiltersToSearch,
  type PointStoryPayload,
  type PointVerifyInfo,
  URANS_VERIFY_DELTA_CD_LIMIT,
  URANS_VERIFY_DELTA_CL_LIMIT,
  verifyPointsSearch,
} from "../lib/point-history";
import { buildSteadyHistoryModel } from "../lib/steady-history";

// ---------------------------------------------------------------------------
// contract pins (values must match engine-client fidelity.ts / migration 0034)
// ---------------------------------------------------------------------------
describe("contract pins", () => {
  it("pins the verify disagreement bounds (contract 4)", () => {
    expect(URANS_VERIFY_DELTA_CL_LIMIT).toBe(0.05);
    expect(URANS_VERIFY_DELTA_CD_LIMIT).toBe(0.01);
  });
});

// ---------------------------------------------------------------------------
// pverify URL round-trip
// ---------------------------------------------------------------------------
describe("verify filter URL round-trip", () => {
  it("round-trips pending and disagreed and preserves foreign params", () => {
    for (const verify of ["pending", "disagreed"] as const) {
      const search = pointFiltersToSearch("?section=queue&tab=points", { ...DEFAULT_POINT_FILTERS, verify });
      expect(search).toContain("pverify=" + verify);
      expect(search).toContain("section=queue");
      expect(parsePointFilters(search)).toEqual({ ...DEFAULT_POINT_FILTERS, verify });
    }
  });

  it("omits the default ('' = any) and rejects malformed values", () => {
    expect(pointFiltersToSearch("", DEFAULT_POINT_FILTERS)).toBe("");
    expect(parsePointFilters("?pverify=bogus")).toEqual(DEFAULT_POINT_FILTERS);
    const cleared = pointFiltersToSearch("?pverify=pending", DEFAULT_POINT_FILTERS);
    expect(cleared).not.toContain("pverify");
  });

  it("verifyPointsSearch targets Solver ▸ Points scoped to airfoil + verify state", () => {
    const search = verifyPointsSearch("naca0012", "disagreed");
    const params = new URLSearchParams(search.slice(1));
    expect(params.get("section")).toBe("queue");
    expect(params.get("tab")).toBe("points");
    expect(params.get("pairfoil")).toBe("naca0012");
    expect(params.get("pverify")).toBe("disagreed");
    expect(parsePointFilters(search)).toEqual({ ...DEFAULT_POINT_FILTERS, airfoil: "naca0012", verify: "disagreed" });
  });
});

// ---------------------------------------------------------------------------
// fidelityChipView truth table
// ---------------------------------------------------------------------------
const verifyInfo = (over: Partial<PointVerifyInfo>): PointVerifyInfo => ({
  state: "pending",
  deltaCl: null,
  deltaCd: null,
  deltaCm: null,
  ...over,
});

describe("fidelityChipView", () => {
  it("renders NOTHING for plain RANS and pre-ladder rows", () => {
    expect(fidelityChipView("rans", null)).toBeNull();
    expect(fidelityChipView(null, null)).toBeNull();
    expect(fidelityChipView("garbage-tier", null)).toBeNull(); // drifted value → plain, never guessed
  });

  it("urans_precalc: amber 'precalc · verify pending' while an open verify item covers the cell", () => {
    expect(fidelityChipView("urans_precalc", verifyInfo({ state: "pending" }))).toEqual({ label: "precalc · verify pending", tone: "amber" });
    expect(fidelityChipView("urans_precalc", verifyInfo({ state: "running" }))).toEqual({ label: "precalc · verify pending", tone: "amber" });
    expect(fidelityChipView("urans_precalc", null)).toEqual({ label: "precalc", tone: "amber" });
    expect(fidelityChipView("urans_precalc", verifyInfo({ state: "cancelled" }))).toEqual({ label: "precalc · verify cancelled", tone: "amber" });
    expect(fidelityChipView("urans_precalc", verifyInfo({ state: "done" }))).toEqual({ label: "precalc · verified", tone: "teal" });
  });

  it("urans_full: teal 'verified'", () => {
    expect(fidelityChipView("urans_full", null)).toEqual({ label: "verified", tone: "teal" });
    expect(fidelityChipView("urans_full", verifyInfo({ state: "done", deltaCl: 0.01 }))).toEqual({ label: "verified", tone: "teal" });
  });

  it("disagreed outranks everything: red chip with the REAL stored deltas", () => {
    const view = fidelityChipView("urans_full", verifyInfo({ state: "disagreed", deltaCl: 0.06, deltaCd: 0.002 }));
    expect(view).toEqual({ label: "verify disagreed (Δcl 0.06)", tone: "red" });
    // even a precalc-labelled row reads disagreed first
    expect(fidelityChipView("urans_precalc", verifyInfo({ state: "disagreed", deltaCd: 0.02 }))?.tone).toBe("red");
  });

  it("disagreed without recorded deltas says so plainly (no invented numbers)", () => {
    expect(fidelityChipView("urans_full", verifyInfo({ state: "disagreed" }))).toEqual({ label: "verify disagreed", tone: "red" });
  });
});

describe("disagreedDeltaLabel", () => {
  it("lists only the deltas that exceeded their contract bound", () => {
    expect(disagreedDeltaLabel(verifyInfo({ state: "disagreed", deltaCl: 0.06, deltaCd: 0.002 }))).toBe("Δcl 0.06");
    expect(disagreedDeltaLabel(verifyInfo({ state: "disagreed", deltaCl: 0.01, deltaCd: -0.012 }))).toBe("Δcd 0.012");
    expect(disagreedDeltaLabel(verifyInfo({ state: "disagreed", deltaCl: -0.07, deltaCd: 0.02 }))).toBe("Δcl 0.07 · Δcd 0.02");
  });

  it("falls back to every recorded delta when none exceeds a bound (defensive honesty)", () => {
    expect(disagreedDeltaLabel(verifyInfo({ state: "disagreed", deltaCl: 0.01, deltaCd: 0.001 }))).toBe("Δcl 0.01 · Δcd 0.001");
    expect(disagreedDeltaLabel(verifyInfo({ state: "disagreed" }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// verify events in the story timeline
// ---------------------------------------------------------------------------
function storyWith(verify: PointVerifyInfo | null): PointStoryPayload {
  return {
    point: {
      resultId: "r1",
      airfoilId: "af1",
      airfoilSlug: "naca0012",
      airfoilName: "NACA 0012",
      aoaDeg: 12,
      reynolds: 400000,
      mach: null,
      speed: null,
      regime: "urans",
      status: "done",
      error: null,
      qualityWarnings: [],
      classification: null,
      revisionId: "rev1",
      campaignId: null,
      campaignName: null,
      conditionId: null,
      solvedAt: "2026-07-07T09:00:00.000Z",
      updatedAt: "2026-07-07T09:00:00.000Z",
      fidelity: "urans_precalc",
      reviewBucket: null,
      continuable: false,
      verify,
    },
    attempts: [],
    interruptions: [],
    closure: null,
  };
}

describe("assembleTimeline — verify events", () => {
  it("open verify item → amber queued/running event before NOW", () => {
    const queued = assembleTimeline(storyWith(verifyInfo({ state: "pending" })));
    const ev = queued.find((e) => e.title.includes("verification"));
    expect(ev?.tone).toBe("amber");
    expect(ev?.title).toBe("full-fidelity verification queued");
    expect(queued[queued.length - 1].kind).toBe("now");
    const running = assembleTimeline(storyWith(verifyInfo({ state: "running" })));
    expect(running.find((e) => e.title.includes("verification"))?.title).toBe("full-fidelity verification running");
  });

  it("disagreed → red event carrying the stored deltas", () => {
    const events = assembleTimeline(storyWith(verifyInfo({ state: "disagreed", deltaCl: 0.06 })));
    const ev = events.find((e) => e.title.includes("DISAGREED"));
    expect(ev?.tone).toBe("red");
    expect(ev?.detail).toContain("Δcl 0.06");
    expect(ev?.detail).toContain("classification stays on the verified");
  });

  it("no verify item / settled clean → no verify event", () => {
    expect(assembleTimeline(storyWith(null)).some((e) => e.title.includes("verification"))).toBe(false);
    expect(assembleTimeline(storyWith(verifyInfo({ state: "done" }))).some((e) => e.title.includes("verification"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildSteadyHistoryModel
// ---------------------------------------------------------------------------
const steadyHistory = () => ({
  iterations: [100, 200, 300, 400, 500],
  cl: [0.8, 0.9, 0.85, 0.87, 0.86],
  cd: [0.02, 0.021, 0.019, 0.02, 0.02],
  cm: [-0.1, -0.11, -0.1, -0.105, -0.102],
  window: { startIter: 300, endIter: 500 },
  meanStable: true,
  note: "steady oscillating mean over trailing window",
});

describe("buildSteadyHistoryModel", () => {
  it("null for absent payloads and for fewer than 2 samples (nothing invented)", () => {
    expect(buildSteadyHistoryModel(null)).toBeNull();
    expect(buildSteadyHistoryModel(undefined)).toBeNull();
    expect(buildSteadyHistoryModel({ ...steadyHistory(), iterations: [1], cl: [0.5], cd: [0.1], cm: [0] })).toBeNull();
  });

  it("maps the averaging window to sample fractions + honest counts", () => {
    const m = buildSteadyHistoryModel(steadyHistory())!;
    expect(m.windowStartFrac).toBeCloseTo(2 / 4);
    expect(m.windowEndFrac).toBe(1);
    expect(m.windowIterCount).toBe(200);
    expect(m.windowSampleCount).toBe(3);
    expect(m.meanStable).toBe(true);
    expect(m.note).toContain("oscillating mean");
  });

  it("truncates to the shortest series when lengths drift (never pads)", () => {
    const m = buildSteadyHistoryModel({ ...steadyHistory(), cm: [-0.1, -0.11, -0.1] })!;
    expect(m.iterations).toHaveLength(3);
    expect(m.cl).toHaveLength(3);
    expect(m.windowEndFrac).toBe(1); // clamped to the last available sample
  });
});

// ---------------------------------------------------------------------------
// campaign phase badge + tier counts (contract 7)
// ---------------------------------------------------------------------------
describe("campaignPhaseBadge", () => {
  const gate: CampaignGate = { text: "BLOCKED — sweeper disabled", tone: "amber" };

  it("maps the three running phases to their labels", () => {
    expect(campaignPhaseBadge("running_rans", "active", null)).toEqual({ key: "running_rans", label: "RUNNING RANS", tone: "teal" });
    expect(campaignPhaseBadge("running_precalc", "active", null)).toEqual({ key: "running_precalc", label: "RUNNING PRECALC URANS", tone: "amber" });
    expect(campaignPhaseBadge("running_refinement", "active", null)).toEqual({ key: "running_refinement", label: "RUNNING URANS REFINEMENT", tone: "amber" });
  });

  it("gate badge outranks the phase (blocked campaigns never show a running phase)", () => {
    expect(campaignPhaseBadge("running_rans", "active", gate)).toBeNull();
    expect(campaignPhaseBadge("running_refinement", "active", gate)).toBeNull();
  });

  it("no phase / no payload → no badge; completed lifecycle suppresses the duplicate", () => {
    expect(campaignPhaseBadge(null, "paused", null)).toBeNull();
    expect(campaignPhaseBadge(undefined, "active", null)).toBeNull();
    expect(campaignPhaseBadge("completed", "completed", null)).toBeNull();
    expect(campaignPhaseBadge("completed", "active", null)).toEqual({ key: "completed", label: "ALL TIERS TERMINAL", tone: "teal" });
  });
});

describe("tierCountsLine", () => {
  it("renders the three real per-tier open counts", () => {
    expect(tierCountsLine({ ransOpen: 1200, precalcOpen: 3, verifyOpen: 0 })).toBe("tiers open — RANS 1,200 · precalc 3 · verify 0");
  });

  it("older payloads without tier counts render nothing (no invented zeros)", () => {
    expect(tierCountsLine(undefined)).toBeNull();
    expect(tierCountsLine(null)).toBeNull();
  });
});
