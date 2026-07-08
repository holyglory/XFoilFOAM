// Campaign-detail dashboard hero (approved design c19fd74a, section D):
// pure-model coverage for the 3-stage pipeline assembly, the single progress
// bar's segment fractions, the honest measured-rate stage ETA (formatting +
// hide rules) and the one-line stats summary / sweep chip.
import { describe, expect, it } from "vitest";

import {
  ETA_MIN_WINDOW_MS,
  PIPELINE_STAGE_NOTES,
  assemblePipelineModel,
  formatEtaHours,
  progressBarSegments,
  progressSummaryLine,
  stageEta,
  sweepChipLabel,
} from "../components/admin/campaigns/campaign-pipeline";

const tiers = (ransOpen: number, precalcOpen: number, verifyOpen: number) => ({ ransOpen, precalcOpen, verifyOpen });

const totals = (over: Partial<Parameters<typeof progressBarSegments>[0]> = {}) => ({
  requested: 1750,
  solved: 1200,
  failed: 0,
  running: 0,
  superseded: 0,
  derived: 40,
  rejected: 0,
  remaining: 510,
  ...over,
});

// ---------------------------------------------------------------------------
// pipeline model assembly
// ---------------------------------------------------------------------------
describe("assemblePipelineModel", () => {
  it("no tierCounts payload (older API) -> no strip, never invented zeros", () => {
    expect(assemblePipelineModel({ tierCounts: null, reviewBuckets: null, phase: "running_rans", jobsRunning: 2 })).toBeNull();
    expect(assemblePipelineModel({ tierCounts: undefined, reviewBuckets: null, phase: null, jobsRunning: 0 })).toBeNull();
  });

  it("stage-2 open = precalcOpen + awaitingUrans (disjoint real counters), with an honest composition line", () => {
    const model = assemblePipelineModel({
      tierCounts: tiers(0, 12, 0),
      reviewBuckets: { awaitingUrans: 96, needsReview: 3 },
      phase: "running_precalc",
      jobsRunning: 4,
    })!;
    const unsteady = model.stages[1];
    expect(unsteady.open).toBe(108);
    expect(unsteady.detail).toBe("12 open · 96 awaiting");
    expect(unsteady.active).toBe(true);
    expect(unsteady.settled).toBe(false);
    expect(model.jobsRunning).toBe(4);
    // needsReview never inflates a pipeline stage — it is the red chip's number
    expect(model.stages.map((s) => s.open)).toEqual([0, 108, 0]);
  });

  it("marks the active stage from the ladder phase; downstream stages are NOT settled while upstream feeds them", () => {
    const model = assemblePipelineModel({
      tierCounts: tiers(320, 0, 0),
      reviewBuckets: { awaitingUrans: 0, needsReview: 0 },
      phase: "running_rans",
      jobsRunning: 0,
    })!;
    expect(model.stages.map((s) => s.active)).toEqual([true, false, false]);
    // MUST-CATCH: stage-1 rejects can still feed stages 2/3 — an empty
    // downstream stage renders "not started", never a false "settled ✓".
    expect(model.stages.map((s) => s.settled)).toEqual([false, false, false]);
    expect(model.stages[0].detail).toBe("320 open");
  });

  it("stages settle only when nothing upstream can feed them any more", () => {
    const done = assemblePipelineModel({
      tierCounts: tiers(0, 0, 0),
      reviewBuckets: { awaitingUrans: 0, needsReview: 2 },
      phase: "completed",
      jobsRunning: 0,
    })!;
    expect(done.stages.map((s) => s.settled)).toEqual([true, true, true]);
    const verifying = assemblePipelineModel({
      tierCounts: tiers(0, 0, 7),
      reviewBuckets: { awaitingUrans: 0, needsReview: 0 },
      phase: "running_refinement",
      jobsRunning: 1,
    })!;
    expect(verifying.stages.map((s) => s.settled)).toEqual([true, true, false]);
  });

  it("verify stage: queued count + background note; missing reviewBuckets means awaiting 0", () => {
    const model = assemblePipelineModel({ tierCounts: tiers(0, 0, 7), reviewBuckets: null, phase: "running_refinement", jobsRunning: 1 })!;
    expect(model.stages[2]).toMatchObject({ open: 7, detail: "7 queued", active: true });
    expect(model.stages[1].open).toBe(0);
    expect(PIPELINE_STAGE_NOTES.verify).toBe("background, after stage 2");
    expect(PIPELINE_STAGE_NOTES.unsteady).toContain("starts when stage 1 finishes");
  });
});

// ---------------------------------------------------------------------------
// single progress bar segments
// ---------------------------------------------------------------------------
describe("progressBarSegments", () => {
  it("teal done = solved + derived; amber = running; violet = awaitingUrans; rest open", () => {
    const seg = progressBarSegments(totals({ running: 12, rejected: 96, remaining: 402 }), { awaitingUrans: 96, needsReview: 2 });
    expect(seg.doneCount).toBe(1240);
    expect(seg.solvingCount).toBe(12);
    expect(seg.awaitingCount).toBe(96);
    expect(seg.openCount).toBe(1750 - 1240 - 12 - 96);
    expect(seg.done).toBeCloseTo(1240 / 1750, 10);
    expect(seg.solving).toBeCloseTo(12 / 1750, 10);
    expect(seg.awaitingUrans).toBeCloseTo(96 / 1750, 10);
  });

  it("failed / needs-review are NOT bar segments (they live on the red chip)", () => {
    const seg = progressBarSegments(totals({ failed: 5 }), { awaitingUrans: 0, needsReview: 5 });
    expect(seg.done + seg.solving + seg.awaitingUrans).toBeLessThan(1);
    expect(seg.awaitingCount).toBe(0);
  });

  it("requested = 0 never divides by zero; open never goes negative", () => {
    const seg = progressBarSegments(totals({ requested: 0, solved: 0, derived: 0, remaining: 0 }), null);
    expect(seg.done).toBe(0);
    expect(seg.openCount).toBe(0);
    const overfull = progressBarSegments(totals({ solved: 2000 }), { awaitingUrans: 100, needsReview: 0 });
    expect(overfull.done).toBe(1);
    expect(overfull.openCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// stage ETA — honest measured-rate projection with hide rules
// ---------------------------------------------------------------------------
describe("stageEta", () => {
  const NOW = Date.parse("2026-07-08T12:00:00.000Z");
  const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
  const opens = { ransOpen: 320, unsteadyOpen: 108, verifyOpen: 7 };
  const stableRate = { pointsLast24h: 96, measuredSince: iso(6 * 3600_000) };

  it("computes the CURRENT stage's ETA from the trailing-24h rate", () => {
    const eta = stageEta({ phase: "running_rans", stageOpenByPhase: opens, rate: stableRate, nowMs: NOW })!;
    expect(eta.stage).toBe(1);
    expect(eta.hours).toBeCloseTo(320 / 4, 10); // 96/24 = 4 points/h
    expect(eta.label).toBe("~3 d");
    const eta2 = stageEta({ phase: "running_precalc", stageOpenByPhase: opens, rate: stableRate, nowMs: NOW })!;
    expect(eta2.stage).toBe(2);
    expect(eta2.hours).toBeCloseTo(27, 10);
    expect(eta2.label).toBe("~27 h");
  });

  it("MUST-HIDE: no rate payload, zero measured rate, or missing tier counts", () => {
    expect(stageEta({ phase: "running_rans", stageOpenByPhase: opens, rate: null, nowMs: NOW })).toBeNull();
    expect(stageEta({ phase: "running_rans", stageOpenByPhase: opens, rate: { pointsLast24h: 0, measuredSince: iso(6 * 3600_000) }, nowMs: NOW })).toBeNull();
    expect(stageEta({ phase: "running_rans", stageOpenByPhase: null, rate: stableRate, nowMs: NOW })).toBeNull();
  });

  it("MUST-HIDE: unstable measurement window (< 1 h of history) — startup noise is not a rate", () => {
    const fresh = { pointsLast24h: 96, measuredSince: iso(ETA_MIN_WINDOW_MS - 60_000) };
    expect(stageEta({ phase: "running_rans", stageOpenByPhase: opens, rate: fresh, nowMs: NOW })).toBeNull();
    const exactly = { pointsLast24h: 96, measuredSince: iso(ETA_MIN_WINDOW_MS) };
    expect(stageEta({ phase: "running_rans", stageOpenByPhase: opens, rate: exactly, nowMs: NOW })).not.toBeNull();
  });

  it("MUST-HIDE: no running phase (completed/paused) or an empty current stage", () => {
    expect(stageEta({ phase: "completed", stageOpenByPhase: opens, rate: stableRate, nowMs: NOW })).toBeNull();
    expect(stageEta({ phase: null, stageOpenByPhase: opens, rate: stableRate, nowMs: NOW })).toBeNull();
    expect(stageEta({ phase: undefined, stageOpenByPhase: opens, rate: stableRate, nowMs: NOW })).toBeNull();
    expect(
      stageEta({ phase: "running_rans", stageOpenByPhase: { ...opens, ransOpen: 0 }, rate: stableRate, nowMs: NOW }),
    ).toBeNull();
  });

  it("malformed measuredSince hides instead of NaN math", () => {
    expect(
      stageEta({ phase: "running_rans", stageOpenByPhase: opens, rate: { pointsLast24h: 96, measuredSince: "not-a-date" }, nowMs: NOW }),
    ).toBeNull();
  });
});

describe("formatEtaHours", () => {
  it("tilde always; days over 48 h, whole hours over 10 h, half-hour steps under, floor label under 1 h", () => {
    expect(formatEtaHours(80)).toBe("~3 d");
    expect(formatEtaHours(48)).toBe("~2 d");
    expect(formatEtaHours(27)).toBe("~27 h");
    expect(formatEtaHours(10.4)).toBe("~10 h");
    expect(formatEtaHours(2.6)).toBe("~2.5 h");
    expect(formatEtaHours(2)).toBe("~2 h");
    expect(formatEtaHours(0.4)).toBe("~<1 h");
  });
});

// ---------------------------------------------------------------------------
// one-line stats summary + sweep chip
// ---------------------------------------------------------------------------
describe("progressSummaryLine", () => {
  it("renders the mockup line and omits zero parts", () => {
    const seg = progressBarSegments(totals({ running: 12, rejected: 96, remaining: 402 }), { awaitingUrans: 96, needsReview: 2 });
    expect(progressSummaryLine(seg, 1750)).toBe("1,240 done · 12 solving · 96 awaiting URANS · 402 open of 1,750");
    const quiet = progressBarSegments(totals(), null);
    expect(progressSummaryLine(quiet, 1750)).toBe("1,240 done · 510 open of 1,750");
  });
});

describe("sweepChipLabel", () => {
  it("range sweeps render from/to/step; list sweeps render the angle count", () => {
    expect(sweepChipLabel({ fromDeg: "-4.0000", toDeg: "14.0000", stepDeg: "2.0000", listDeg: null })).toBe("sweep -4°…14° step 2°");
    expect(sweepChipLabel({ fromDeg: null, toDeg: null, stepDeg: null, listDeg: ["0.0000", "4.0000", "8.0000"] })).toBe("sweep 3 angles");
    expect(sweepChipLabel({ fromDeg: null, toDeg: null, stepDeg: null, listDeg: null })).toBeNull();
  });
});
