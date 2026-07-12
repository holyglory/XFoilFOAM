import { describe, expect, it } from "vitest";

import {
  buildContinueUransPayload,
  buildSolverWorkConditionSummary,
  buildSolverWorkPopoverView,
  filterSortSolverWorkConditions,
  SOLVER_WORK_STATE_STYLES,
  SOLVER_WORK_STATES,
  solverWorkLegendStates,
  solverWorkPointPresentation,
  solverWorkResultContext,
  solverWorkRollup,
  solverWorkStateClass,
  type SolverWorkCondition,
  type SolverWorkPoint,
} from "../lib/solver-work";

function point(overrides: Partial<SolverWorkPoint>): SolverWorkPoint {
  return {
    aoaDeg: 0,
    state: "queued",
    resultId: null,
    fidelity: null,
    cl: null,
    cd: null,
    cm: null,
    plain: "queued for solver work",
    gate: null,
    chain: [],
    continuable: false,
    actions: [],
    supersededBy: null,
    reviewed: false,
    review: null,
    ...overrides,
  };
}

function condition(
  overrides: Partial<SolverWorkCondition>,
): SolverWorkCondition {
  return {
    presetRevisionId: "rev-1",
    reynolds: 853000,
    mach: 0.07,
    chordM: 0.5,
    speedMps: 25,
    updatedAt: "2026-07-10T09:48:00.000Z",
    attentionCount: 0,
    points: [],
    jobs: [],
    ...overrides,
  };
}

describe("solver-work state taxonomy", () => {
  it("pins the style/class mapping for all ten states", () => {
    expect(SOLVER_WORK_STATES).toEqual([
      "verified",
      "provisional",
      "solving",
      "queued",
      "ladder",
      "needs_time",
      "needs_review",
      "blocked",
      "excluded",
      "superseded",
    ]);
    expect(SOLVER_WORK_STATE_STYLES.verified).toMatchObject({
      color: "#34d399",
      background: "#0e1d18",
      border: "#1c3a31",
      className: "solver-work-state--verified",
    });
    expect(SOLVER_WORK_STATE_STYLES.needs_review).toMatchObject({
      color: "#fb923c",
      background: "#25140a",
      border: "#7c2d12",
      className: "solver-work-state--needs-review",
    });
    expect(SOLVER_WORK_STATE_STYLES.excluded).toMatchObject({
      label: "excluded",
      background: "#260d0d",
      border: "#7f1d1d",
      className: "solver-work-state--excluded",
    });
    for (const state of SOLVER_WORK_STATES) {
      expect(solverWorkStateClass(state)).toBe(
        `solver-work-state ${SOLVER_WORK_STATE_STYLES[state].className}`,
      );
    }
  });
});

describe("solver-work reviewed presentation", () => {
  const group = condition({ points: [] });

  it("does not mistake the API reviewed boolean for review metadata", () => {
    const blocked = point({
      state: "blocked",
      resultId: "res-blocked",
      reviewed: false,
      review: null,
    });
    const presentation = solverWorkPointPresentation(blocked);
    const anonView = buildSolverWorkPopoverView(group, blocked, false);
    const adminView = buildSolverWorkPopoverView(group, blocked, true);

    expect(presentation.visualState).toBe("blocked");
    expect(presentation.badgeMark).toBeNull();
    expect(anonView.stateLabel).toBe("blocked");
    expect(anonView.reviewedDisclosure).toBeNull();
    expect(anonView.actions.map((action) => action.kind)).toEqual([
      "open-results",
    ]);
    expect(adminView.actions.map((action) => action.kind)).not.toContain(
      "revoke-review",
    );
  });

  it("renders excluded points in the blocked-family palette and hides revoke for anonymous users", () => {
    const excluded = point({
      state: "excluded",
      resultId: "res-excluded",
      reviewed: true,
      review: {
        verdict: "exclude",
        note: "bad mesh evidence",
        reviewer: "ja@vr.ae",
        at: "2026-07-10T09:00:00.000Z",
      },
    });
    const presentation = solverWorkPointPresentation(excluded);
    const anonView = buildSolverWorkPopoverView(group, excluded, false);

    expect(presentation.visualState).toBe("excluded");
    expect(SOLVER_WORK_STATE_STYLES[presentation.visualState]).toMatchObject({
      label: "excluded",
      background: "#260d0d",
      border: "#7f1d1d",
    });
    expect(anonView.stateLabel).toBe("excluded · reviewed");
    expect(anonView.reviewedDisclosure).toBe(
      "excluded by ja@vr.ae 2026-07-10: bad mesh evidence",
    );
    expect(
      anonView.actions.some((action) => action.kind === "revoke-review"),
    ).toBe(false);
  });
});

describe("solver-work group filters and sorting", () => {
  const groups = [
    condition({
      presetRevisionId: "rev-900",
      reynolds: 900000,
      attentionCount: 1,
      updatedAt: "2026-07-10T09:40:00.000Z",
      points: [point({ state: "needs_review" })],
    }),
    condition({
      presetRevisionId: "rev-200",
      reynolds: 200000,
      attentionCount: 0,
      updatedAt: "2026-07-10T09:59:00.000Z",
      points: [point({ state: "queued" })],
    }),
    condition({
      presetRevisionId: "rev-500",
      reynolds: 500000,
      attentionCount: 3,
      updatedAt: "2026-07-10T09:55:00.000Z",
      points: [point({ state: "solving" })],
    }),
  ];

  it("filters attention and solving groups", () => {
    expect(
      filterSortSolverWorkConditions(groups, "attention", "re-asc").map(
        (item) => item.presetRevisionId,
      ),
    ).toEqual(["rev-500", "rev-900"]);
    expect(
      filterSortSolverWorkConditions(groups, "solving", "re-asc").map(
        (item) => item.presetRevisionId,
      ),
    ).toEqual(["rev-500"]);
  });

  it("pins Re ascending and attention-first order", () => {
    expect(
      filterSortSolverWorkConditions(groups, "all", "re-asc").map(
        (item) => item.presetRevisionId,
      ),
    ).toEqual(["rev-200", "rev-500", "rev-900"]);
    expect(
      filterSortSolverWorkConditions(groups, "all", "attention-first").map(
        (item) => item.presetRevisionId,
      ),
    ).toEqual(["rev-500", "rev-900", "rev-200"]);
  });
});

describe("solver-work popover assembly", () => {
  const needsTime = point({
    aoaDeg: 20,
    state: "needs_time",
    resultId: "res-time",
    fidelity: "urans-precalc",
    cl: 1.12,
    cd: 0.0881,
    cm: -0.041,
    plain:
      "URANS stopped at the wall-clock budget before two repeatable periods were saved.",
    gate: {
      name: "time budget",
      detail: "saved case state can continue from 14.2 s",
    },
    chain: [
      { label: "RANS ✗ stall", tone: "needs_review" },
      { label: "URANS ⏱", tone: "needs_time" },
    ],
    continuable: true,
  });
  const group = condition({ points: [needsTime] });

  it("renders the needs_time sentence, gate, chain, coefficients, and admin continue actions", () => {
    const view = buildSolverWorkPopoverView(group, needsTime, true);
    expect(view.title).toBe("α 20.0°");
    expect(view.plain).toContain("wall-clock budget");
    expect(view.gate).toEqual({
      name: "time budget",
      detail: "saved case state can continue from 14.2 s",
    });
    expect(view.coefficients).toEqual([
      { label: "Cl", value: "1.120" },
      { label: "Cd", value: "0.0881" },
      { label: "Cm", value: "-0.041" },
    ]);
    expect(view.provisionalNote).toBe(true);
    expect(view.chain.map((item) => item.label)).toEqual([
      "RANS ✗ stall",
      "URANS ⏱",
    ]);
    expect(view.actions.map((action) => action.label)).toEqual([
      "full results ▸",
      "Continue +2h",
      "Continue +6h",
      "Continue +24h",
    ]);
  });

  it("gates all admin controls for anonymous sessions", () => {
    const view = buildSolverWorkPopoverView(group, needsTime, false);
    expect(view.actions.filter((action) => action.adminOnly)).toEqual([]);
    expect(view.actions.map((action) => action.label)).toEqual([
      "full results ▸",
    ]);
  });

  it("pins the continuation POST payload used by the shared admin endpoint", () => {
    expect(buildContinueUransPayload("res-time", 6)).toEqual({
      continueFromResultId: "res-time",
      budgetOverrideS: 21600,
    });
  });
});

describe("solver-work result opening and group rollups", () => {
  it("builds the existing sim-modal context from a verified point resultId", () => {
    const verified = point({
      aoaDeg: 4,
      state: "verified",
      resultId: "result-42",
    });
    const group = condition({ reynolds: 400000, points: [verified] });
    const opened: unknown[] = [];
    const ctx = solverWorkResultContext(group, verified);
    if (ctx) opened.push(ctx);
    expect(opened).toEqual([{ re: 400000, aoa: 4, resultId: "result-42" }]);
  });

  it("computes rollup percentages and attention pill data from a mixed group", () => {
    const mixed = condition({
      attentionCount: 1,
      points: [
        point({ state: "verified" }),
        point({ state: "verified", aoaDeg: 1 }),
        point({ state: "solving", aoaDeg: 2 }),
        point({ state: "queued", aoaDeg: 3 }),
        point({ state: "needs_review", aoaDeg: 4 }),
        point({ state: "superseded", aoaDeg: 5, supersededBy: "result-2" }),
      ],
    });
    const summary = buildSolverWorkConditionSummary(
      mixed,
      new Date("2026-07-10T10:00:00.000Z").getTime(),
    );
    expect(summary.countLabel).toBe("5/6");
    expect(summary.attentionLabel).toBe("attention 1");
    expect(summary.meta).toContain("updated 12 min ago");

    const rollup = solverWorkRollup(mixed.points, false);
    expect(rollup.map((segment) => [segment.state, segment.count])).toEqual([
      ["verified", 2],
      ["solving", 1],
      ["queued", 1],
      ["needs_review", 1],
    ]);
    expect(rollup[0].percent).toBeCloseTo(40);
    expect(rollup.slice(1).map((segment) => segment.percent)).toEqual([
      20, 20, 20,
    ]);
  });

  it("hides superseded points by default and includes them when toggled", () => {
    const points = [
      point({ state: "verified" }),
      point({ state: "superseded", aoaDeg: 8, supersededBy: "result-new" }),
    ];
    expect(solverWorkLegendStates(points, false)).toEqual(["verified"]);
    expect(solverWorkLegendStates(points, true)).toEqual([
      "verified",
      "superseded",
    ]);
    expect(
      solverWorkRollup(points, false).map((segment) => segment.state),
    ).toEqual(["verified"]);
    expect(
      solverWorkRollup(points, true).map((segment) => segment.state),
    ).toEqual(["verified", "superseded"]);
  });
});
