import { describe, expect, it } from "vitest";

import {
  buildNaca4,
  buildPolarFit,
  classifyPolarEvidence,
  DEFAULT_TRANSIENT_MAX_COURANT,
  deriveGeometry,
  deriveFlowConditionState,
  deriveOperatingConditionState,
  evalDynamicViscosity,
  evalKinematicViscosity,
  exportCoordinates,
  fRe,
  makePath,
  metrics,
  nacaGeometry,
  niceTicks,
  parseCoordinates,
  projectChart,
  evaluateUransMediaQuality,
  FRAME_TRACK_MIN_PERIODS,
  INCOMPLETE_URANS_INTEGRATION_REASON,
  isDeterministicMeshBlockerError,
  NON_PHYSICAL_COEFFICIENT_LIMIT,
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
  reynolds,
  reynoldsFromFlowReference,
  speedForReynolds,
  type NacaParams,
} from "../src/index";

// The original design engine, copied verbatim — our port must match it.
import * as ref from "./fixtures/airfoil-db.reference.js";

it("pins distinct restartable URANS warning markers", () => {
  expect(URANS_BUDGET_STOP_MARKER).toBe(
    "stopped by the wall-clock budget guard",
  );
  expect(URANS_CONTINUATION_REQUIRED_MARKER).toBe(
    "requires further same-case integration",
  );
  expect(URANS_CONTINUATION_REQUIRED_MARKER).not.toContain("budget");
});

it("recognizes only the exact deterministic precalc mesh blocker pair", () => {
  expect(
    isDeterministicMeshBlockerError(
      "mesh degenerate at this fidelity tier (max non-orthogonality 88.3 deg)",
    ),
  ).toBe(true);
  expect(
    isDeterministicMeshBlockerError("mesh generation failed transiently"),
  ).toBe(false);
  expect(isDeterministicMeshBlockerError(null)).toBe(false);
});

it("pins the safe cross-runtime transient Courant default", () => {
  expect(DEFAULT_TRANSIENT_MAX_COURANT).toBe(4);
});

const AIRFOILS: Record<string, NacaParams> = {
  "NACA 0012": { t: 0.12, m: 0.0, p: 0.0 },
  "NACA 2412": { t: 0.12, m: 0.02, p: 0.4 },
  "NACA 4412": { t: 0.12, m: 0.04, p: 0.4 },
  "NACA 4415": { t: 0.15, m: 0.04, p: 0.4 },
};

describe("geometry port matches airfoil-db.js", () => {
  for (const [name, params] of Object.entries(AIRFOILS)) {
    it(`buildNaca4 == buildAirfoil for ${name}`, () => {
      const mine = buildNaca4(params);
      const got = ref.buildAirfoil(params) as {
        contour: { x: number; y: number }[];
        camber: { x: number; y: number }[];
        areas: { upper: number; lower: number; camber: number };
        leRadius: number;
      };
      expect(mine.contour.length).toBe(got.contour.length);
      mine.contour.forEach((p, i) => {
        expect(p.x).toBeCloseTo(got.contour[i].x, 10);
        expect(p.y).toBeCloseTo(got.contour[i].y, 10);
      });
      mine.camber.forEach((p, i) => {
        expect(p.x).toBeCloseTo(got.camber[i].x, 10);
        expect(p.y).toBeCloseTo(got.camber[i].y, 10);
      });
      expect(mine.areas.upper).toBeCloseTo(got.areas.upper, 10);
      expect(mine.areas.lower).toBeCloseTo(got.areas.lower, 10);
      expect(mine.areas.camber).toBeCloseTo(got.areas.camber, 10);
      expect(mine.leRadius).toBeCloseTo(got.leRadius, 12);
    });
  }

  it("makePath == reference makePath", () => {
    const { contour } = buildNaca4(AIRFOILS["NACA 4412"]);
    expect(makePath(contour, 14, 80, 312, true)).toBe(
      (
        ref.makePath as (
          p: unknown,
          mx: number,
          cy: number,
          s: number,
          c: boolean,
        ) => string
      )(contour, 14, 80, 312, true),
    );
  });
});

describe("polar chart evidence gating", () => {
  it("does not relabel another angle's measured moment as cm0", () => {
    const base = {
      cl: 0.1,
      cd: 0.01,
      ld: 10,
      stalled: false,
      source: "solved" as const,
      resultId: "result-0",
    };

    expect(
      metrics([
        { ...base, a: -2, cm: null },
        { ...base, a: 0, cm: -0.03, resultId: "result-1" },
      ]).cm0,
    ).toBeNull();
    expect(
      metrics([
        { ...base, a: -4, cm: -0.05 },
        { ...base, a: 0, cm: -0.03, resultId: "result-1" },
      ]).cm0,
    ).toBe(-0.05);
  });

  it("exposes clickable points only for solved result rows", () => {
    const solved = {
      a: 0,
      cl: 0.1,
      cd: 0.01,
      cm: 0,
      ld: 10,
      stalled: false,
      source: "solved" as const,
      resultId: "result-0",
    };
    const queued = {
      a: 1,
      cl: 0.2,
      cd: 0.02,
      cm: 0,
      ld: 10,
      stalled: false,
      source: "queued" as const,
      resultId: null,
    };

    const projection = projectChart({
      chartType: "cla",
      polars: [
        {
          seriesId: "series-a",
          label: "Re 100k",
          re: 100000,
          color: "#f5a524",
          points: [solved, queued],
        },
      ],
      visibleSeries: { "series-a": true },
    });

    expect(projection.points).toHaveLength(1);
    expect(projection.points[0].point.resultId).toBe("result-0");
  });

  it("keeps an empty solved-only chart finite while sweeps are still queued", () => {
    const projection = projectChart({
      chartType: "cla",
      polars: [
        {
          seriesId: "series-a",
          label: "Re 100k",
          re: 100000,
          color: "#f5a524",
          points: [],
        },
      ],
      visibleSeries: { "series-a": true },
    });

    expect(projection.points).toHaveLength(0);
    expect(Number.isFinite(projection.domain.yMin)).toBe(true);
    expect(Number.isFinite(projection.domain.yMax)).toBe(true);
  });
});

describe("RANS stall classification and fitted polar", () => {
  const steadyRans = (
    a: number,
    cl: number,
    opts: {
      cd?: number;
      converged?: boolean;
      stalled?: boolean;
      failureDisposition?: "none" | "hard_solver";
    } = {},
  ) => ({
    a,
    cl,
    cd: opts.cd ?? 0.02,
    cm: -0.05,
    status: "done",
    source: "solved",
    regime: "rans" as const,
    converged: opts.converged ?? true,
    stalled: opts.stalled ?? false,
    failureDisposition: opts.failureDisposition ?? "none",
  });

  const ag24Like = [
    [-7, -0.45, 0.02],
    [-6, -0.34, 0.017],
    [-5, -0.23, 0.014],
    [-4, -0.12, 0.012],
    [-3, -0.01, 0.011],
    [-2, 0.1, 0.0105],
    [-1, 0.2, 0.0103],
    [0, 0.3, 0.0102],
    [1, 0.41, 0.0104],
    [2, 0.51, 0.011],
    [3, 0.62, 0.012],
    [4, 0.73, 0.014],
    [5, 0.84, 0.017],
    [6, 0.95, 0.021],
    [7, 1.04, 0.027],
    [8, 1.12, 0.034],
    [9, 1.2, 0.043],
    [10, 1.27, 0.054],
    [11, 1.32, 0.066],
    [12, 1.34, 0.078],
    [13, 1.32, 0.092],
    [14, 1.19, 0.08],
    [15, 0.9, 0.145],
    [16, 0.82, 0.182],
    [17, 0.79, 0.21],
    [18, 0.78, 0.239],
  ] as const;

  it("marks AG24-like post-stall RANS rows as needs_urans, not rejected", () => {
    const classified = classifyPolarEvidence(
      ag24Like.map(([a, cl, cd]) => ({
        a,
        cl,
        cd,
        cm: -0.05,
        ld: cl / cd,
        status: "done",
        source: "solved",
        regime: "rans",
        converged: true,
        stalled: false,
      })),
    );
    const stateByAoa = new Map(
      classified.classifications.map((c) => [c.evidence.a, c.state]),
    );
    expect([14, 15, 16, 17, 18].map((a) => stateByAoa.get(a))).toEqual([
      "needs_urans",
      "needs_urans",
      "needs_urans",
      "needs_urans",
      "needs_urans",
    ]);
    expect(stateByAoa.get(12)).toBe("accepted");
    expect(stateByAoa.get(13)).toBe("accepted");
    expect(classified.hardRejectedAoas).toEqual([]);
  });

  it("keeps provisional rows in the fit until URANS supersedes them", () => {
    const classified = classifyPolarEvidence(
      ag24Like.map(([a, cl, cd]) => ({
        a,
        cl,
        cd,
        cm: -0.05,
        ld: cl / cd,
        status: "done",
        source: "solved",
        regime: "rans",
        converged: true,
        stalled: false,
      })),
    );
    const provisionalFit = buildPolarFit(classified.classifications);
    expect(provisionalFit.status).toBe("provisional");
    expect(provisionalFit.provisionalPointCount).toBe(5);
    expect(provisionalFit.metrics?.clmax).toBeGreaterThan(1.2);

    const finalFit = buildPolarFit(
      classified.classifications.map((c) =>
        c.state === "needs_urans"
          ? {
              ...c,
              state: "superseded_by_urans" as const,
              reasons: [...c.reasons, "urans-replacement"],
            }
          : c,
      ),
    );
    expect(finalFit.status).toBe("final");
    expect(finalFit.provisionalPointCount).toBe(0);
    expect(finalFit.points.every((p) => p.a < 14)).toBe(true);
  });

  it("MUST-CATCH: routes the A18 Re102k alternate −5°/−4° branch to targeted URANS", () => {
    const classified = classifyPolarEvidence([
      steadyRans(-5, 0.2561),
      steadyRans(-4, 0.2409),
      steadyRans(-3, -0.4145, {
        converged: false,
        stalled: true,
        failureDisposition: "hard_solver",
      }),
      steadyRans(-2, -0.394),
      steadyRans(-1, -0.31),
      steadyRans(0, -0.22),
      steadyRans(1, -0.13),
      steadyRans(2, -0.04),
      steadyRans(3, 0.05),
      steadyRans(4, 0.14),
      steadyRans(5, 0.23),
    ]);
    const stateByAoa = new Map(
      classified.classifications.map((row) => [row.evidence.a, row]),
    );

    expect(classified.lowAoaFailure).toBe(false);
    expect(classified.needsUransAoas).toEqual([-5, -4]);
    expect(classified.hardRejectedAoas).toEqual([-3]);
    expect(stateByAoa.get(-5)?.state).toBe("needs_urans");
    expect(stateByAoa.get(-4)?.state).toBe("needs_urans");
    expect(stateByAoa.get(-5)?.reasons).toContain(
      "low-aoa-attached-branch-discontinuity",
    );
    expect(stateByAoa.get(-2)?.state).toBe("accepted");
    expect(stateByAoa.get(5)?.state).toBe("accepted");
  });

  it("MUST-CATCH: routes the A18 Re307k alternate branch without whole-polar promotion", () => {
    const classified = classifyPolarEvidence([
      steadyRans(-5, 0.2479),
      steadyRans(-4, 0.2514),
      steadyRans(-3, -0.4889),
      steadyRans(-2, -0.4456),
      steadyRans(-1, -0.36),
      steadyRans(0, -0.27),
      steadyRans(1, -0.18),
      steadyRans(2, -0.09),
      steadyRans(3, 0),
      steadyRans(4, 0.09),
      steadyRans(5, 0.18),
    ]);
    const stateByAoa = new Map(
      classified.classifications.map((row) => [row.evidence.a, row.state]),
    );

    expect(classified.lowAoaFailure).toBe(false);
    expect(classified.hardRejectedAoas).toEqual([]);
    expect(classified.needsUransAoas).toEqual([-5, -4]);
    expect(stateByAoa.get(-5)).toBe("needs_urans");
    expect(stateByAoa.get(-4)).toBe("needs_urans");
    expect(stateByAoa.get(-3)).toBe("accepted");
    expect(stateByAoa.get(5)).toBe("accepted");
  });

  it.each([
    [
      "the smooth A18 Re566k negative branch",
      [
        [-5, -0.562],
        [-4, -0.524],
        [-3, -0.499],
        [-2, -0.453],
        [-1, -0.4],
        [0, -0.35],
        [1, -0.3],
        [2, -0.25],
        [3, -0.2],
        [4, -0.15],
        [5, -0.1],
      ],
    ],
    [
      "a noisy attached baseline",
      [
        [-5, 0.26],
        [-4, 0.24],
        [-3, -0.49],
        [-2, -0.4],
        [-1, -0.32],
        [0, -0.24],
        [1, -0.02],
        [2, -0.18],
        [3, 0.26],
        [4, 0.08],
        [5, 0.46],
      ],
    ],
    [
      "the A63-like 0°/1° irregularity",
      [
        [-2, -0.16],
        [-1, -0.08],
        [0, 0],
        [1, -0.0186],
        [2, 0.12],
        [3, 0.22],
        [4, 0.32],
        [5, 0.42],
      ],
    ],
  ] as const)(
    "FALSE-POSITIVE GUARD: does not flag %s as a low-angle alternate branch",
    (_label, rows) => {
      const classified = classifyPolarEvidence(
        rows.map(([a, cl]) => steadyRans(a, cl)),
      );
      expect(classified.lowAoaFailure).toBe(false);
      expect(classified.needsUransAoas).toEqual([]);
      expect(
        classified.classifications.every((row) => row.state === "accepted"),
      ).toBe(true);
    },
  );

  it("detects low-AoA failure for whole-polar URANS promotion", () => {
    const classified = classifyPolarEvidence([
      {
        a: 2,
        cl: 0.31,
        cd: 0.018,
        cm: -0.01,
        status: "done",
        source: "solved",
        regime: "rans",
        converged: false,
        stalled: true,
        failureDisposition: "hard_solver",
      },
      {
        a: 1,
        cl: 0.2,
        cd: 0.01,
        cm: 0,
        status: "done",
        source: "solved",
        regime: "rans",
        converged: true,
        stalled: false,
      },
      {
        a: 3,
        cl: 0.3,
        cd: 0.011,
        cm: 0,
        status: "done",
        source: "solved",
        regime: "rans",
        converged: true,
        stalled: false,
      },
    ]);

    expect(classified.lowAoaFailure).toBe(true);
    expect(classified.hardRejectedAoas).toEqual([2]);
    expect(
      classified.classifications
        .filter((row) => row.evidence.a !== 2)
        .map((row) => row.state),
    ).toEqual(["needs_urans", "needs_urans"]);
  });

  it.each(["infrastructure", "deterministic_mesh"] as const)(
    "does not turn a low-AoA %s rejection into a polar-wide physics verdict",
    (failureDisposition) => {
      const classified = classifyPolarEvidence([
        {
          a: 2,
          cl: null,
          cd: null,
          cm: null,
          status: "failed",
          source: "queued",
          regime: "rans",
          converged: false,
          stalled: true,
          error: `${failureDisposition} fixture`,
          failureDisposition,
        },
        {
          a: 4,
          cl: 0.4,
          cd: 0.02,
          cm: -0.01,
          status: "done",
          source: "solved",
          regime: "rans",
          converged: true,
          stalled: false,
          failureDisposition: "none",
        },
      ]);
      expect(classified.lowAoaFailure).toBe(false);
      expect(classified.classifications.map((row) => row.state)).toEqual([
        "rejected",
        "accepted",
      ]);
    },
  );

  it("does not treat an unattempted queued shell as a hard low-AoA failure", () => {
    const classified = classifyPolarEvidence([
      {
        a: 2,
        cl: null,
        cd: null,
        cm: null,
        status: "pending",
        source: "queued",
        regime: "rans",
        converged: false,
        stalled: false,
      },
    ]);
    expect(classified.hardRejectedAoas).toEqual([2]);
    expect(classified.lowAoaFailure).toBe(false);
  });
});

describe("URANS evidence gate (ingest-shaped rows — solver-stalled ≠ post-stall)", () => {
  // MUST-CATCH: built with the sweeper's exact ingest semantics
  // (stalledForPoint: stalled = unsteady || converged === false), i.e. the
  // shape every real URANS results row has in the database. Under the v1
  // classifier this row was rejected "solver-stalled" and NO unsteady point
  // could ever be accepted (prod DB: 0 accepted URANS rows, ever).
  // Frame-track contract payload exactly as ingest persists it (verbatim
  // snake_case engine shape, results.frame_track jsonb — migration 0032).
  const contractFrameTrack = {
    period_s: 0.137,
    periods_retained: 6,
    stationary: true,
    drift_frac: 0.012,
    window: { t_start: 10.21, t_end: 11.03 },
    stats: {
      cl: { mean: 1.12, std: 0.18, min: 0.83, max: 1.41 },
      cd: { mean: 0.21, std: 0.03, min: 0.16, max: 0.27 },
      cm: { mean: -0.06, std: 0.01, min: -0.09, max: -0.03 },
    },
    fields: ["vorticity", "velocity_magnitude"],
    frames: [{ i: 0, t: 10.76, cl: 1.1, cd: 0.21, cm: -0.06 }],
    image_pattern: "frames/{field}/f{i04}.png",
  };

  const ingestShapedUrans = {
    a: 16,
    cl: 1.12,
    cd: 0.21,
    cm: -0.06,
    status: "done",
    source: "solved",
    regime: "urans" as const,
    converged: true,
    stalled: true, // true BECAUSE unsteady:true — the aerodynamic marker
    unsteady: true,
    hasForceHistory: true,
    hasVideo: true,
    frameTrack: contractFrameTrack,
  };

  it("accepts a converged unsteady row with force history + video + stationary frame track", () => {
    const classified = classifyPolarEvidence([ingestShapedUrans]);
    expect(classified.classifications[0].state).toBe("accepted");
    expect(classified.classifications[0].reasons).toEqual([]);
    expect(classified.hardRejectedAoas).toEqual([]);
  });

  it.each([URANS_BUDGET_STOP_MARKER, URANS_CONTINUATION_REQUIRED_MARKER])(
    "rejects restartable but incomplete URANS carrying %s",
    (marker) => {
      const classified = classifyPolarEvidence([
        {
          ...ingestShapedUrans,
          qualityWarnings: [
            `measured integration ${marker}; saved state retained`,
          ],
        },
      ]);
      expect(classified.classifications[0].state).toBe("rejected");
      expect(classified.classifications[0].reasons).toContain(
        INCOMPLETE_URANS_INTEGRATION_REASON,
      );
    },
  );

  it("does not reject an unrelated quality warning", () => {
    const classified = classifyPolarEvidence([
      {
        ...ingestShapedUrans,
        qualityWarnings: ["wall-clock timing recorded; integration complete"],
      },
    ]);
    expect(classified.classifications[0].state).toBe("accepted");
  });

  it("BACKWARD COMPAT: still accepts legacy URANS evidence with frame_track NULL/absent (pre-0032 rows keep the v2 gate — deploy must not mass-reject history)", () => {
    const { frameTrack: _ft, ...legacyShape } = ingestShapedUrans;
    for (const legacy of [legacyShape, { ...legacyShape, frameTrack: null }]) {
      const classified = classifyPolarEvidence([legacy]);
      expect(classified.classifications[0].state).toBe("accepted");
      expect(classified.classifications[0].reasons).toEqual([]);
    }
  });

  it("rejects a non-stationary frame track with the honest reason (confidence high)", () => {
    const classified = classifyPolarEvidence([
      {
        ...ingestShapedUrans,
        frameTrack: { ...contractFrameTrack, stationary: false },
      },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual(["non-stationary"]);
    expect(classified.classifications[0].confidence).toBe(1);
  });

  it(`rejects a short recording window (< ${FRAME_TRACK_MIN_PERIODS} retained periods)`, () => {
    const classified = classifyPolarEvidence([
      {
        ...ingestShapedUrans,
        frameTrack: {
          ...contractFrameTrack,
          periods_retained: FRAME_TRACK_MIN_PERIODS - 1,
        },
      },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual([
      "insufficient-periods",
    ]);
    expect(classified.classifications[0].confidence).toBe(1);
  });

  it(`accepts exactly ${FRAME_TRACK_MIN_PERIODS} retained periods (gate is >=)`, () => {
    const classified = classifyPolarEvidence([
      {
        ...ingestShapedUrans,
        frameTrack: {
          ...contractFrameTrack,
          periods_retained: FRAME_TRACK_MIN_PERIODS,
        },
      },
    ]);
    expect(classified.classifications[0].state).toBe("accepted");
  });

  it("MUST-CATCH: the ingest MISSING-frame_track sentinel is rejected (shedding point without stationarity evidence)", () => {
    // F3: the sweeper persists this sentinel when a post-contract engine
    // ships a shedding URANS point WITHOUT frame_track (period unmeasurable /
    // stats failed). It must gate-fail — null would have skipped the gate as
    // legacy evidence.
    const sentinel = {
      missing: true,
      stationary: false,
      periods_retained: null,
      reason: "engine shipped no frame_track for a shedding URANS point",
    };
    const classified = classifyPolarEvidence([
      { ...ingestShapedUrans, frameTrack: sentinel },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual([
      "non-stationary",
      "insufficient-periods",
    ]);
  });

  it("MUST-CATCH: a contract-drifted frame track FAILS CLOSED (missing verdict fields reject, never accept)", () => {
    // Shaped like a real drifted engine payload (renamed/retyped keys), not
    // like the parser's own fixtures.
    const classified = classifyPolarEvidence([
      {
        ...ingestShapedUrans,
        frameTrack: { periodsRetained: 9, stationary: "true" },
      },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual([
      "non-stationary",
      "insufficient-periods",
    ]);
  });

  it("still rejects a non-converged STEADY row as solver-stalled", () => {
    const classified = classifyPolarEvidence([
      {
        a: 4,
        cl: 0.5,
        cd: 0.02,
        cm: -0.01,
        status: "done",
        source: "solved",
        regime: "rans" as const,
        converged: false,
        stalled: true,
        unsteady: false,
      },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain("solver-stalled");
    expect(classified.classifications[0].reasons).toContain("not-converged");
  });

  it("rejects an unsteady row missing its video (evidence-first honesty)", () => {
    const classified = classifyPolarEvidence([
      { ...ingestShapedUrans, hasVideo: false },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual([
      "missing-urans-video",
    ]);
  });

  it("rejects an unsteady row missing its force history", () => {
    const classified = classifyPolarEvidence([
      { ...ingestShapedUrans, hasForceHistory: false },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual([
      "missing-force-history",
    ]);
  });

  it("rejects a non-converged unsteady row (not-converged, without solver-stalled)", () => {
    const classified = classifyPolarEvidence([
      { ...ingestShapedUrans, converged: false },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain("not-converged");
    expect(classified.classifications[0].reasons).not.toContain(
      "solver-stalled",
    );
  });

  // -------------------------------------------------------------------------
  // Non-physical coefficient magnitude gate (prod job b01a7d46, naca-0012
  // a0 u15): long-horizon URANS splitting-error blow-up graded cl mean -79.8
  // (std 10795, excursions ±945k). That row happened to be caught by other
  // gates; the same divergence with POSITIVE drag and legacy (absent)
  // frame_track would have passed everything. These fixtures are shaped like
  // that real breakage, not like the gate's implementation.
  // -------------------------------------------------------------------------
  it("MUST-CATCH: a diverged unsteady row with POSITIVE drag and NO frame_track is rejected non-physical-coefficients (every other gate passes)", () => {
    const { frameTrack: _ft, ...legacyShape } = ingestShapedUrans;
    const diverged = { ...legacyShape, cl: -79.8, cd: 12.4, cm: 0.31 };
    const classified = classifyPolarEvidence([diverged]);
    expect(classified.classifications[0].state).toBe("rejected");
    // EXACTLY this reason: proves the pre-existing gates were all silent and
    // only the magnitude bound caught the divergence.
    expect(classified.classifications[0].reasons).toEqual([
      "non-physical-coefficients",
    ]);
  });

  it("MUST-CATCH: the same divergence WITH a non-stationary frame track carries both honest reasons", () => {
    const classified = classifyPolarEvidence([
      {
        ...ingestShapedUrans,
        cl: -79.8,
        cd: 12.4,
        cm: 0.31,
        frameTrack: {
          ...contractFrameTrack,
          stationary: false,
          drift_frac: 0.94,
        },
      },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain(
      "non-physical-coefficients",
    );
    expect(classified.classifications[0].reasons).toContain("non-stationary");
  });

  it("MUST-CATCH: a diverged STEADY row (converged, positive drag) is equally non-physical", () => {
    const classified = classifyPolarEvidence([
      {
        a: 8,
        cl: 214.6, // blown-up pseudo-steady state that still reported converged
        cd: 3.2,
        cm: -41.9,
        status: "done",
        source: "solved",
        regime: "rans" as const,
        converged: true,
        stalled: false,
        unsteady: false,
      },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual([
      "non-physical-coefficients",
    ]);
  });

  it("triggers on |cm| alone (moment blow-up with plausible lift)", () => {
    const { frameTrack: _ft, ...legacyShape } = ingestShapedUrans;
    const classified = classifyPolarEvidence([
      { ...legacyShape, cl: 0.9, cd: 0.08, cm: -37.2 },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual([
      "non-physical-coefficients",
    ]);
  });

  it("FALSE-POSITIVE GUARD: legitimate extreme aerodynamics stay accepted (post-stall cl 2.5, high-lift S1223-like cl 2.4)", () => {
    // Highest physical section coefficients this database can produce — the
    // bound (5) must clear them with margin.
    const postStallFlatPlate = {
      ...ingestShapedUrans,
      a: 42,
      cl: 2.5,
      cd: 1.8,
      cm: -0.55,
    };
    const s1223HighLift = {
      a: 12,
      cl: 2.4,
      cd: 0.045,
      cm: -0.28,
      status: "done",
      source: "solved",
      regime: "rans" as const,
      converged: true,
      stalled: false,
      unsteady: false,
    };
    const classified = classifyPolarEvidence([
      postStallFlatPlate,
      s1223HighLift,
    ]);
    for (const c of classified.classifications) {
      expect(c.state).toBe("accepted");
      expect(c.reasons).toEqual([]);
    }
  });

  it("FALSE-POSITIVE GUARD: the bound is strict (> limit) — |cl| exactly at the limit is not caught", () => {
    const { frameTrack: _ft, ...legacyShape } = ingestShapedUrans;
    const classified = classifyPolarEvidence([
      { ...legacyShape, cl: -NON_PHYSICAL_COEFFICIENT_LIMIT, cd: 0.9, cm: 0.1 },
    ]);
    expect(classified.classifications[0].reasons).not.toContain(
      "non-physical-coefficients",
    );
  });
});

describe("URANS media quality", () => {
  it("flags the old NACA 0012 Re 500k AoA 20 sparse animation", () => {
    const quality = evaluateUransMediaQuality({
      unsteady: true,
      strouhal: 0.6634408650015379,
      speed: 7.303255616469686,
      chord: 1,
      historyTimes: [221.01577688779508, 224.1077570847098],
      frameCount: 50,
    });

    expect(quality.evaluated).toBe(true);
    expect(quality.ok).toBe(false);
    expect(quality.retainedCycles).toBeGreaterThan(14);
    expect(quality.framesPerCycle).toBeLessThan(20);
    expect(quality.reason).toContain("frames/cycle");
  });

  it("passes a refined 7-cycle animation with at least 20 frames per cycle", () => {
    const st = 0.6634408650015379;
    const speed = 7.303255616469686;
    const period = 1 / (st * speed);
    const quality = evaluateUransMediaQuality({
      unsteady: true,
      strouhal: st,
      speed,
      chord: 1,
      historyTimes: [10, 10 + 7 * period],
      frameCount: 140,
    });

    expect(quality.evaluated).toBe(true);
    expect(quality.ok).toBe(true);
    expect(quality.retainedCycles).toBeCloseTo(7, 8);
    expect(quality.framesPerCycle).toBeGreaterThanOrEqual(20);
  });

  it("does not invalidate rows when quality evidence is incomplete", () => {
    const quality = evaluateUransMediaQuality({
      unsteady: true,
      strouhal: 0.66,
      speed: 7.3,
      chord: 1,
      historyTimes: [1, 2],
      frameCount: null,
    });

    expect(quality.evaluated).toBe(false);
    expect(quality.ok).toBe(true);
  });
});

describe("fRe formatting", () => {
  it("matches reference", () => {
    for (const re of [50000, 100000, 250000, 300000, 1000000, 3300000]) {
      expect(fRe(re)).toBe((ref.fRe as (n: number) => string)(re));
    }
  });
});

describe("viscosity models", () => {
  it("Sutherland for air ≈ 1.79e-5 Pa·s at 288.15 K", () => {
    const mu = evalDynamicViscosity(
      { model: "sutherland", muRef: 1.716e-5, tRef: 273.15, s: 110.4 },
      288.15,
    );
    expect(mu).toBeGreaterThan(1.78e-5);
    expect(mu).toBeLessThan(1.8e-5);
    const nu = evalKinematicViscosity(
      { model: "sutherland", muRef: 1.716e-5, tRef: 273.15, s: 110.4 },
      1.225,
      288.15,
    );
    expect(nu).toBeCloseTo(mu / 1.225, 12);
  });

  it("constant + table models", () => {
    expect(evalDynamicViscosity({ model: "constant", mu: 1.002e-3 }, 300)).toBe(
      1.002e-3,
    );
    const table = {
      model: "table" as const,
      tempsK: [298, 313, 373],
      mu: [0.29, 0.1, 0.009],
    };
    expect(evalDynamicViscosity(table, 298)).toBe(0.29);
    expect(evalDynamicViscosity(table, 373)).toBe(0.009);
    expect(evalDynamicViscosity(table, 305.5)).toBeCloseTo(
      0.29 + (0.1 - 0.29) * 0.5,
      10,
    );
  });

  it("derives gas density, Reynolds, and Mach from speed/chord/state", () => {
    const state = deriveOperatingConditionState(
      {
        phase: "gas",
        density: 1.225,
        refTemperatureK: 288.15,
        refPressurePa: 101325,
        viscosity: {
          model: "sutherland",
          muRef: 1.716e-5,
          tRef: 273.15,
          s: 110.4,
        },
        speedOfSound: 340.3,
      },
      {
        temperatureK: 288.15,
        pressurePa: 101325,
        referenceChordM: 1,
        speedMps: 7.3,
      },
    );
    expect(state.dynamicViscosity).toBeGreaterThan(1.78e-5);
    expect(state.density).toBeCloseTo(1.225, 8);
    expect(state.reynolds).toBeCloseTo((7.3 * 1) / state.kinematicViscosity, 8);
    expect(state.mach).toBeCloseTo(7.3 / 340.3, 8);
  });

  it("keeps flow state independent from reference geometry when deriving Re", () => {
    const flow = deriveFlowConditionState(
      {
        phase: "gas",
        density: 1.225,
        refTemperatureK: 288.15,
        refPressurePa: 101325,
        viscosity: {
          model: "sutherland",
          muRef: 1.716e-5,
          tRef: 273.15,
          s: 110.4,
        },
        speedOfSound: 340.3,
      },
      { temperatureK: 288.15, pressurePa: 101325, speedMps: 12 },
    );
    expect(flow.mach).toBeCloseTo(12 / 340.3, 8);
    expect(
      reynoldsFromFlowReference(
        { speedMps: 12, kinematicViscosity: flow.kinematicViscosity },
        0.5,
      ),
    ).toBeCloseTo((12 * 0.5) / flow.kinematicViscosity, 8);
    expect(
      reynoldsFromFlowReference(
        { speedMps: 12, kinematicViscosity: flow.kinematicViscosity },
        2,
      ),
    ).toBeCloseTo((12 * 2) / flow.kinematicViscosity, 8);
  });
});

describe("reynolds inversion", () => {
  it("speedForReynolds round-trips through reynolds", () => {
    const nu = 1.48e-5;
    const chord = 1.0;
    const re = 200000;
    const speed = speedForReynolds(re, chord, nu);
    expect(reynolds(speed, chord, nu)).toBeCloseTo(re, 6);
  });
});

describe("coordinate I/O", () => {
  it("Selig export round-trips through parse", () => {
    const { contour } = buildNaca4(AIRFOILS["NACA 2412"]);
    const text = exportCoordinates("selig", "NACA 2412", contour);
    const parsed = parseCoordinates(text);
    expect(parsed.format).toBe("selig");
    expect(parsed.name).toBe("NACA 2412");
    expect(parsed.points.length).toBe(contour.length);
    parsed.points.forEach((p, i) => {
      expect(p.x).toBeCloseTo(contour[i].x, 5);
      expect(p.y).toBeCloseTo(contour[i].y, 5);
    });
  });

  it("Lednicer export round-trips back to a comparable contour", () => {
    const { contour } = buildNaca4(AIRFOILS["NACA 0012"]);
    const text = exportCoordinates("lednicer", "NACA 0012", contour);
    const parsed = parseCoordinates(text);
    expect(parsed.format).toBe("lednicer");
    // same point count, LE near origin, TE near (1,0)
    const xs = parsed.points.map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(0, 3);
    expect(Math.max(...xs)).toBeCloseTo(1, 3);
  });
});

describe("deriveGeometry from points ≈ analytic NACA geometry", () => {
  it("recovers thickness/camber for NACA 4412", () => {
    const analytic = nacaGeometry(AIRFOILS["NACA 4412"]);
    const derived = deriveGeometry(analytic.contour);
    expect(derived.thicknessPct).toBeCloseTo(12, 0); // ~12%
    expect(derived.camberPct).toBeCloseTo(4, 0); // ~4%
    expect(derived.areaUpper).toBeCloseTo(analytic.areaUpper, 2);
    expect(derived.areaLower).toBeCloseTo(analytic.areaLower, 2);
  });
});

describe("niceTicks", () => {
  it("produces sensible round steps", () => {
    const { step, out } = niceTicks(-8, 20, 7);
    expect(step).toBeGreaterThan(0);
    expect(out).toContain(0);
    expect(out.every((v) => v >= -8 && v <= 20 + step)).toBe(true);
  });
});
