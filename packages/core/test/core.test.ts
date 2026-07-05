import { describe, expect, it } from "vitest";

import {
  buildNaca4,
  buildPolarFit,
  classifyPolarEvidence,
  deriveGeometry,
  deriveFlowConditionState,
  deriveOperatingConditionState,
  evalDynamicViscosity,
  evalKinematicViscosity,
  exportCoordinates,
  fRe,
  makePath,
  nacaGeometry,
  niceTicks,
  parseCoordinates,
  projectChart,
  evaluateUransMediaQuality,
  reynolds,
  reynoldsFromFlowReference,
  speedForReynolds,
  type NacaParams,
} from "../src/index";

// The original design engine, copied verbatim — our port must match it.
import * as ref from "./fixtures/airfoil-db.reference.js";

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
      (ref.makePath as (p: unknown, mx: number, cy: number, s: number, c: boolean) => string)(
        contour,
        14,
        80,
        312,
        true,
      ),
    );
  });
});

describe("polar chart evidence gating", () => {
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
      polars: [{ re: 100000, color: "#f5a524", points: [solved, queued] }],
      visibleRe: { 100000: true },
    });

    expect(projection.points).toHaveLength(1);
    expect(projection.points[0].point.resultId).toBe("result-0");
  });

  it("keeps an empty solved-only chart finite while sweeps are still queued", () => {
    const projection = projectChart({
      chartType: "cla",
      polars: [{ re: 100000, color: "#f5a524", points: [] }],
      visibleRe: { 100000: true },
    });

    expect(projection.points).toHaveLength(0);
    expect(Number.isFinite(projection.domain.yMin)).toBe(true);
    expect(Number.isFinite(projection.domain.yMax)).toBe(true);
  });
});

describe("RANS stall classification and fitted polar", () => {
  const ag24Like = [
    [-7, -0.45, 0.020],
    [-6, -0.34, 0.017],
    [-5, -0.23, 0.014],
    [-4, -0.12, 0.012],
    [-3, -0.01, 0.011],
    [-2, 0.10, 0.0105],
    [-1, 0.20, 0.0103],
    [0, 0.30, 0.0102],
    [1, 0.41, 0.0104],
    [2, 0.51, 0.011],
    [3, 0.62, 0.012],
    [4, 0.73, 0.014],
    [5, 0.84, 0.017],
    [6, 0.95, 0.021],
    [7, 1.04, 0.027],
    [8, 1.12, 0.034],
    [9, 1.20, 0.043],
    [10, 1.27, 0.054],
    [11, 1.32, 0.066],
    [12, 1.34, 0.078],
    [13, 1.32, 0.092],
    [14, 1.19, 0.080],
    [15, 0.90, 0.145],
    [16, 0.82, 0.182],
    [17, 0.79, 0.210],
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
    const stateByAoa = new Map(classified.classifications.map((c) => [c.evidence.a, c.state]));
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
          ? { ...c, state: "superseded_by_urans" as const, reasons: [...c.reasons, "urans-replacement"] }
          : c,
      ),
    );
    expect(finalFit.status).toBe("final");
    expect(finalFit.provisionalPointCount).toBe(0);
    expect(finalFit.points.every((p) => p.a < 14)).toBe(true);
  });

  it("detects low-AoA failure for whole-polar URANS promotion", () => {
    const classified = classifyPolarEvidence([
      { a: 0, cl: null, cd: null, cm: null, status: "failed", source: "queued", regime: "rans", converged: false, stalled: true },
      { a: 1, cl: 0.2, cd: 0.01, cm: 0, status: "done", source: "solved", regime: "rans", converged: true, stalled: false },
      { a: 2, cl: 0.3, cd: 0.011, cm: 0, status: "done", source: "solved", regime: "rans", converged: true, stalled: false },
    ]);

    expect(classified.lowAoaFailure).toBe(true);
    expect(classified.hardRejectedAoas).toEqual([0]);
  });
});

describe("URANS evidence gate (ingest-shaped rows — solver-stalled ≠ post-stall)", () => {
  // MUST-CATCH: built with the sweeper's exact ingest semantics
  // (stalledForPoint: stalled = unsteady || converged === false), i.e. the
  // shape every real URANS results row has in the database. Under the v1
  // classifier this row was rejected "solver-stalled" and NO unsteady point
  // could ever be accepted (prod DB: 0 accepted URANS rows, ever).
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
  };

  it("accepts a converged unsteady row with force history + video", () => {
    const classified = classifyPolarEvidence([ingestShapedUrans]);
    expect(classified.classifications[0].state).toBe("accepted");
    expect(classified.classifications[0].reasons).toEqual([]);
    expect(classified.hardRejectedAoas).toEqual([]);
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
    const classified = classifyPolarEvidence([{ ...ingestShapedUrans, hasVideo: false }]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual(["missing-urans-video"]);
  });

  it("rejects an unsteady row missing its force history", () => {
    const classified = classifyPolarEvidence([{ ...ingestShapedUrans, hasForceHistory: false }]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual(["missing-force-history"]);
  });

  it("rejects a non-converged unsteady row (not-converged, without solver-stalled)", () => {
    const classified = classifyPolarEvidence([{ ...ingestShapedUrans, converged: false }]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain("not-converged");
    expect(classified.classifications[0].reasons).not.toContain("solver-stalled");
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
    expect(evalDynamicViscosity({ model: "constant", mu: 1.002e-3 }, 300)).toBe(1.002e-3);
    const table = { model: "table" as const, tempsK: [298, 313, 373], mu: [0.29, 0.1, 0.009] };
    expect(evalDynamicViscosity(table, 298)).toBe(0.29);
    expect(evalDynamicViscosity(table, 373)).toBe(0.009);
    expect(evalDynamicViscosity(table, 305.5)).toBeCloseTo(0.29 + (0.1 - 0.29) * 0.5, 10);
  });

  it("derives gas density, Reynolds, and Mach from speed/chord/state", () => {
    const state = deriveOperatingConditionState(
      {
        phase: "gas",
        density: 1.225,
        refTemperatureK: 288.15,
        refPressurePa: 101325,
        viscosity: { model: "sutherland", muRef: 1.716e-5, tRef: 273.15, s: 110.4 },
        speedOfSound: 340.3,
      },
      { temperatureK: 288.15, pressurePa: 101325, referenceChordM: 1, speedMps: 7.3 },
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
        viscosity: { model: "sutherland", muRef: 1.716e-5, tRef: 273.15, s: 110.4 },
        speedOfSound: 340.3,
      },
      { temperatureK: 288.15, pressurePa: 101325, speedMps: 12 },
    );
    expect(flow.mach).toBeCloseTo(12 / 340.3, 8);
    expect(reynoldsFromFlowReference({ speedMps: 12, kinematicViscosity: flow.kinematicViscosity }, 0.5)).toBeCloseTo(
      (12 * 0.5) / flow.kinematicViscosity,
      8,
    );
    expect(reynoldsFromFlowReference({ speedMps: 12, kinematicViscosity: flow.kinematicViscosity }, 2)).toBeCloseTo(
      (12 * 2) / flow.kinematicViscosity,
      8,
    );
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
