// Coverage-matrix segmented bars (approved mockup 1ed4374f, recolored per
// amendment A / design c19fd74a): pure helper coverage for segment state
// derivation from real sim_campaign_progress cell counts (+ the optional
// awaitingUrans/needsReview split), fill-fraction math, tooltip labels, the
// per-row DONE fraction, and the chord-grouping threshold. Cells are shaped
// like the real /campaigns/:id/airfoils perCondition payloads (all eight
// counters present).

import { describe, expect, it } from "vitest";

import type {
  AdminCampaignConditionSummary,
  CampaignProgressTotals,
} from "../lib/admin";
import {
  type CoverageCell,
  MIN_SEGMENT_PX,
  SEGMENT_GAP_PX,
  groupConditionsByChord,
  needsChordGrouping,
  rowDoneFraction,
  segmentFillHeight,
  segmentTitle,
  segmentView,
  syncPromisedCount,
  terminalCount,
} from "../components/admin/campaigns/coverage-segments";

function cell(
  over: Partial<CampaignProgressTotals> = {},
): CampaignProgressTotals {
  return {
    requested: 31,
    solved: 0,
    failed: 0,
    running: 0,
    superseded: 0,
    derived: 0,
    rejected: 0,
    remaining: 31,
    ...over,
  };
}

function condition(
  over: Partial<AdminCampaignConditionSummary> = {},
): AdminCampaignConditionSummary {
  return {
    id: "cond-1",
    ord: 13,
    status: "active",
    flowConditionId: "fc-1",
    referenceGeometryProfileId: "geo-1",
    presetId: "p-1",
    presetSlug: "sl-33",
    presetName: "Sea level 33 m/s",
    presetOrigin: "campaign",
    revisionId: "rev-1",
    revisionNumber: 1,
    reynolds: 614_000,
    mach: 0.1,
    temperatureK: 288.15,
    pressurePa: 101_325,
    speedMps: 33,
    chordM: 0.3,
    drift: false,
    gainedEvidenceAfterRelease: false,
    counters: cell(),
    ...over,
  };
}

describe("segmentView state derivation", () => {
  it("missing cell (airfoil added after the condition) -> empty, zero fill", () => {
    expect(segmentView(null)).toEqual({ state: "empty", fillFraction: 0 });
    expect(segmentView(undefined)).toEqual({ state: "empty", fillFraction: 0 });
  });

  it("requested === 0 -> empty (never divides by zero)", () => {
    expect(segmentView(cell({ requested: 0, remaining: 0 }))).toEqual({
      state: "empty",
      fillFraction: 0,
    });
  });

  it("plain progress: fill = terminal fraction, running/remaining are NOT terminal", () => {
    // mid-flight condition: 20 solved + 4 derived done, 3 running, 4 pending
    const v = segmentView(
      cell({ solved: 20, derived: 4, running: 3, remaining: 4 }),
    );
    expect(v.state).toBe("progress");
    expect(v.fillFraction).toBeCloseTo(24 / 31, 10);
  });

  it("complete condition -> full fill", () => {
    const v = segmentView(cell({ solved: 27, derived: 4, remaining: 0 }));
    expect(v.state).toBe("progress");
    expect(v.fillFraction).toBe(1);
  });

  it("LEGACY payload (no split counters): rejected points tint the fill amber-state 'rejected'", () => {
    const v = segmentView(
      cell({ solved: 20, derived: 2, rejected: 2, remaining: 7 }),
    );
    expect(v.state).toBe("rejected");
    expect(v.fillFraction).toBeCloseTo(24 / 31, 10);
  });

  it("any failed point wins over rejected (failed-first salience)", () => {
    const v = segmentView(
      cell({ solved: 10, failed: 1, rejected: 2, remaining: 18 }),
    );
    expect(v.state).toBe("failed");
    expect(v.fillFraction).toBeCloseTo(13 / 31, 10);
  });

  it("fill fraction clamps to [0,1] even on inconsistent counters", () => {
    expect(segmentView(cell({ solved: 40, remaining: 0 })).fillFraction).toBe(
      1,
    );
  });
});

describe("segmentView — amendment-A split recolor (design c19fd74a)", () => {
  const split = (over: Partial<CoverageCell> = {}): CoverageCell => ({
    ...cell(),
    awaitingUrans: 0,
    needsReview: 0,
    ...over,
  });

  it("awaiting-URANS cells go VIOLET-state, never red", () => {
    const v = segmentView(
      split({
        solved: 20,
        derived: 2,
        rejected: 2,
        remaining: 7,
        awaitingUrans: 2,
      }),
    );
    expect(v.state).toBe("awaiting_urans");
    expect(v.fillFraction).toBeCloseTo(24 / 31, 10);
    // violet is calm: renders at the terminal fraction, not solid
    expect(segmentFillHeight(v)).toBeCloseTo(24 / 31, 10);
  });

  it("needs-review cells go RED-state solid, winning over awaiting", () => {
    const v = segmentView(
      split({
        solved: 20,
        rejected: 3,
        remaining: 8,
        awaitingUrans: 2,
        needsReview: 1,
      }),
    );
    expect(v.state).toBe("needs_review");
    expect(segmentFillHeight(v)).toBe(1);
  });

  it("failed still wins over everything (crash salience)", () => {
    const v = segmentView(
      split({
        solved: 10,
        failed: 1,
        rejected: 2,
        remaining: 18,
        awaitingUrans: 2,
        needsReview: 1,
      }),
    );
    expect(v.state).toBe("failed");
    expect(segmentFillHeight(v)).toBe(1);
  });

  it("rejected-but-rescheduled cells (split present, both buckets 0) are plain progress", () => {
    const v = segmentView(split({ solved: 20, rejected: 2, remaining: 9 }));
    expect(v.state).toBe("progress");
  });

  it("MUST-CATCH: renders exhausted recovery as critical and terminal, never a normal blocked queue", () => {
    const blocked = split({ solved: 20, blocked: 2, remaining: 9 });
    const view = segmentView(blocked);
    expect(view.state).toBe("blocked");
    expect(view.fillFraction).toBeCloseTo(22 / 31, 10);
    expect(segmentTitle(condition(), blocked, "active")).toContain(
      "2 critical failures",
    );
    expect(segmentTitle(condition(), blocked, "active")).not.toContain(
      "review",
    );
    expect(segmentTitle(condition(), blocked, "active")).not.toContain(
      "blocked",
    );
  });

  it("keeps cached legacy payload arithmetic finite when blocked is absent", () => {
    const legacy = cell({ solved: 20, derived: 2, remaining: 9 });
    delete (legacy as { blocked?: number }).blocked;
    expect(terminalCount(legacy)).toBe(22);
    expect(segmentView(legacy).fillFraction).toBeCloseTo(22 / 31, 10);
  });
});

describe("segmentFillHeight rendering rule", () => {
  it("failed renders SOLID (full height) regardless of progress", () => {
    expect(segmentFillHeight({ state: "failed", fillFraction: 0.1 })).toBe(1);
    expect(segmentFillHeight({ state: "failed", fillFraction: 0 })).toBe(1);
  });

  it("critical recovery failures render SOLID for immediate salience", () => {
    expect(segmentFillHeight({ state: "blocked", fillFraction: 0.1 })).toBe(1);
  });

  it("progress/rejected render at the terminal fraction; empty at 0", () => {
    expect(segmentFillHeight({ state: "progress", fillFraction: 0.5 })).toBe(
      0.5,
    );
    expect(segmentFillHeight({ state: "rejected", fillFraction: 0.4 })).toBe(
      0.4,
    );
    expect(segmentFillHeight({ state: "empty", fillFraction: 0 })).toBe(0);
  });
});

describe("segmentTitle tooltip", () => {
  it("LEGACY payload keeps the raw rejected wording: 'Re 614k · #13 · 24/31 · 2 rejected'", () => {
    const t = segmentTitle(
      condition(),
      cell({ solved: 20, derived: 2, rejected: 2, remaining: 7 }),
      "active",
    );
    expect(t).toBe("Re 614k · #13 · 24/31 · 2 rejected");
  });

  it("split payload replaces 'rejected' with its refined buckets", () => {
    const awaiting = {
      ...cell({ solved: 20, derived: 2, rejected: 2, remaining: 7 }),
      awaitingUrans: 2,
      needsReview: 0,
    };
    expect(segmentTitle(condition(), awaiting, "active")).toBe(
      "Re 614k · #13 · 24/31 · 2 awaiting URANS",
    );
    // A rolling legacy count is labelled unavailable; failed stays distinct.
    // distinguishable from rejected-urans reviews.
    const review = {
      ...cell({ solved: 12, failed: 1, rejected: 1, remaining: 17 }),
      awaitingUrans: 0,
      needsReview: 2,
    };
    expect(
      segmentTitle(condition({ reynolds: 1_500_000, ord: 14 }), review),
    ).toBe("Re 1.5M · #14 · 14/31 · 2 unavailable · 1 failed");
    // rescheduled rejects: neither bucket — no review wording at all
    const rescheduled = {
      ...cell({ solved: 20, rejected: 2, remaining: 9 }),
      awaitingUrans: 0,
      needsReview: 0,
    };
    expect(segmentTitle(condition(), rescheduled, "active")).toBe(
      "Re 614k · #13 · 22/31",
    );
  });

  it("failed condition includes the failed count (mockup row 3, Re 1.5M · #14)", () => {
    const t = segmentTitle(
      condition({ reynolds: 1_500_000, ord: 14 }),
      cell({ solved: 12, failed: 1, remaining: 18 }),
    );
    expect(t).toBe("Re 1.5M · #14 · 13/31 · 1 failed");
  });

  it("running and sync-promised counts surface when present", () => {
    const c = {
      ...cell({ solved: 5, running: 2, remaining: 24 }),
      syncPromised: 3,
    };
    expect(syncPromisedCount(c)).toBe(3);
    expect(segmentTitle(condition(), c)).toBe(
      "Re 614k · #13 · 5/31 · 2 running · 3 sync-promised",
    );
  });

  it("missing cell -> 'no points'; non-active display state is appended", () => {
    expect(segmentTitle(condition(), null, "active")).toBe(
      "Re 614k · #13 · no points",
    );
    expect(
      segmentTitle(condition(), cell({ solved: 31, remaining: 0 }), "released"),
    ).toBe("Re 614k · #13 · 31/31 · released");
    expect(
      segmentTitle(condition(), cell({ solved: 4, remaining: 27 }), "kept"),
    ).toBe("Re 614k · #13 · 4/31 · kept");
  });
});

describe("rowDoneFraction (DONE column)", () => {
  const row = {
    airfoilId: "a-1",
    slug: "ag03",
    name: "ag03",
    isSymmetric: false,
    perCondition: [
      { conditionId: "c1", ...cell({ solved: 31, remaining: 0 }) },
      {
        conditionId: "c2",
        ...cell({ solved: 20, derived: 2, rejected: 2, remaining: 7 }),
      },
      {
        conditionId: "c3",
        ...cell({ solved: 10, failed: 1, running: 2, remaining: 18 }),
      },
    ],
  };

  it("sums terminal/requested over the rendered conditions only", () => {
    const all = rowDoneFraction(row, new Set(["c1", "c2", "c3"]));
    expect(all).toEqual({ done: 31 + 24 + 11, total: 93 });
    // grouped view: only one chord's conditions rendered
    expect(rowDoneFraction(row, new Set(["c2"]))).toEqual({
      done: 24,
      total: 31,
    });
  });

  it("conditions the row has no cell for contribute nothing (no invented zeros in the denominator beyond real requested)", () => {
    expect(rowDoneFraction(row, new Set(["c1", "missing"]))).toEqual({
      done: 31,
      total: 31,
    });
    expect(
      rowDoneFraction({ ...row, perCondition: [] }, new Set(["c1"])),
    ).toEqual({ done: 0, total: 0 });
  });
});

describe("needsChordGrouping threshold", () => {
  it("current real campaigns (9-30 conditions) stay ungrouped at normal widths", () => {
    expect(needsChordGrouping(9, 600)).toBe(false);
    expect(needsChordGrouping(30, 600)).toBe(false); // (600 - 58) / 30 ≈ 18px
    expect(needsChordGrouping(30, 190)).toBe(false); // ≈ 4.4px, still ≥ 4
  });

  it("groups when a segment would fall under MIN_SEGMENT_PX after gaps", () => {
    expect(needsChordGrouping(200, 600)).toBe(true); // ≈ 1px per segment
    expect(needsChordGrouping(30, 170)).toBe(true); // (170 - 58) / 30 ≈ 3.7px
  });

  it("boundary: exactly MIN_SEGMENT_PX does not group", () => {
    const n = 30;
    const width = n * MIN_SEGMENT_PX + (n - 1) * SEGMENT_GAP_PX;
    expect(needsChordGrouping(n, width)).toBe(false);
    expect(needsChordGrouping(n, width - 1)).toBe(true);
  });

  it("degenerate inputs never group: single condition, unmeasured width", () => {
    expect(needsChordGrouping(1, 2)).toBe(false);
    expect(needsChordGrouping(500, 0)).toBe(false);
  });
});

describe("groupConditionsByChord", () => {
  it("groups a realistic many-condition campaign by chord, ascending, ord order kept", () => {
    // 96 conditions: 3 chords × 32 (speed × ambient) — the grouped path's
    // target shape. Each chord view must itself be renderable ungrouped.
    const chords = [0.3, 0.15, 0.6];
    const conds: AdminCampaignConditionSummary[] = [];
    let ord = 1;
    for (let i = 0; i < 32; i++) {
      for (const chordM of chords)
        conds.push(condition({ id: `c-${ord}`, ord, chordM }));
      ord += chords.length;
    }
    const groups = groupConditionsByChord(conds);
    expect(groups.map((g) => g.key)).toEqual(["0.15", "0.3", "0.6"]);
    expect(groups.map((g) => g.label)).toEqual([
      "c 0.15 m",
      "c 0.3 m",
      "c 0.6 m",
    ]);
    expect(groups.every((g) => g.conditions.length === 32)).toBe(true);
    // within a group the input (ord) order is preserved
    const ords = groups[1].conditions.map((c) => c.ord);
    expect(ords).toEqual([...ords].sort((a, b) => a - b));
    // one chord per view fits: 32 segments in a 320px bar ≈ 8px each
    expect(needsChordGrouping(96, 320)).toBe(true);
    expect(needsChordGrouping(32, 320)).toBe(false);
  });

  it("single shared chord -> one group (caller keeps the ungrouped rendering)", () => {
    const groups = groupConditionsByChord([
      condition({ id: "a", ord: 1 }),
      condition({ id: "b", ord: 2 }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].conditions).toHaveLength(2);
  });

  it("chord-less conditions bucket last with an honest label", () => {
    const groups = groupConditionsByChord([
      condition({ id: "a", ord: 1, chordM: null }),
      condition({ id: "b", ord: 2, chordM: 1 }),
    ]);
    expect(groups.map((g) => g.key)).toEqual(["1", "none"]);
    expect(groups[0].label).toBe("c 1 m");
    expect(groups[1].label).toBe("no chord");
  });
});
