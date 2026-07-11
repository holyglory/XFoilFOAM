/**
 * Chart domain + clipping guardrail — recall-shaped from prod 2026-07-09:
 * the CLARK Y Re 3.41M campaign polar (α −15..30) drew OUTSIDE the plot rect
 * on the cell panel / detail page because the α domain was hard-coded to
 * −8..20, the out-of-domain guard existed only for Cl–Cd, and nothing
 * clipped polylines. The must-catch below fails against that code.
 *
 * Also pins the zoom/pan/readout helpers the chart navigation feature uses.
 */
import { describe, expect, it } from "vitest";

import {
  CHART_VIEW,
  type ChartDomain,
  type ChartType,
  clipCurveToDomain,
  panChartDomain,
  projectChart,
  readoutAtX,
  zoomChartDomain,
} from "../src";
import type { PolarFit, PolarPointData } from "../src/types";

const { PX0, PX1, PY0, PY1 } = CHART_VIEW;
// polyline coords are emitted with toFixed(1) → allow the rounding margin
const EPS = 0.06;

/** Prod-shaped campaign polar: α −15..30 step 5 with a stall hook past 15°. */
function prodShapedPoints(): PolarPointData[] {
  const rows: [number, number, number, number][] = [
    [-15, -0.62, 0.089, -0.041],
    [-10, -0.31, 0.052, -0.048],
    [-5, 0.18, 0.021, -0.062],
    [0, 0.63, 0.013, -0.071],
    [5, 1.05, 0.016, -0.069],
    [10, 1.38, 0.028, -0.058],
    [15, 1.58, 0.055, -0.047],
    [20, 1.32, 0.148, -0.088],
    [25, 1.18, 0.235, -0.118],
    [30, 1.09, 0.334, -0.152],
  ];
  return rows.map(([a, cl, cd, cm], i) => ({
    a,
    cl,
    cd,
    cm,
    ld: cd > 0 ? cl / cd : 0,
    stalled: a >= 20,
    source: "solved" as const,
    resultId: `r-${i}`,
    classificationState: "accepted" as const,
  }));
}

function prodShapedFit(): PolarFit {
  const points = [];
  for (let a = -15; a <= 30 + 1e-9; a += 0.5) {
    const cl = a < 15 ? 0.63 + 0.085 * a : 1.58 - 0.03 * (a - 15);
    const cd = 0.013 + 0.0004 * a * a;
    points.push({ a, cl, cd, cm: -0.07 + 0.002 * a, ld: cl / cd });
  }
  return { points } as PolarFit;
}

function prodInput(chartType: ChartType, domain?: Partial<ChartDomain> | null) {
  return {
    chartType,
    polars: [{ seriesId: "series-wide", label: "Re 3.41M", re: 3_410_000, color: "#38bdf8", points: prodShapedPoints(), fit: prodShapedFit() }],
    visibleSeries: { "series-wide": true },
    domain,
  };
}

function allCurveCoords(curves: { points: string }[]): [number, number][] {
  return curves.flatMap((c) =>
    c.points
      .split(" ")
      .filter(Boolean)
      .map((pair) => pair.split(",").map(Number) as [number, number]),
  );
}

describe("must-catch: prod-shaped wide polar stays inside the plot rect", () => {
  for (const type of ["cla", "lda", "cma", "clcd"] as ChartType[]) {
    it(`every curve coordinate and point is inside the axes (${type})`, () => {
      const proj = projectChart(prodInput(type));
      const coords = allCurveCoords(proj.curves);
      expect(coords.length).toBeGreaterThan(0);
      for (const [x, y] of coords) {
        expect(x).toBeGreaterThanOrEqual(PX0 - EPS);
        expect(x).toBeLessThanOrEqual(PX1 + EPS);
        expect(y).toBeGreaterThanOrEqual(PY0 - EPS);
        expect(y).toBeLessThanOrEqual(PY1 + EPS);
      }
      for (const p of proj.points) {
        expect(p.cx).toBeGreaterThanOrEqual(PX0 - EPS);
        expect(p.cx).toBeLessThanOrEqual(PX1 + EPS);
        expect(p.cy).toBeGreaterThanOrEqual(PY0 - EPS);
        expect(p.cy).toBeLessThanOrEqual(PY1 + EPS);
      }
    });
  }

  it("the default α window fits the data (zoom-to-fit), not the legacy −8..20", () => {
    const proj = projectChart(prodInput("cla"));
    expect(proj.domain.xMin).toBeLessThanOrEqual(-15);
    expect(proj.domain.xMax).toBeGreaterThanOrEqual(30);
    // every solved point survives — the prod symptom hid −15/−10/25/30
    expect(proj.points.filter((p) => !p.point.stalled || p.point.stalled).length).toBe(10);
  });

  it("empty data keeps the legacy fallback window", () => {
    const proj = projectChart({ chartType: "cla", polars: [], visibleSeries: {} });
    expect(proj.domain.xMin).toBe(-8);
    expect(proj.domain.xMax).toBe(20);
  });

  it("x ticks span the fitted window and stay inside the rect", () => {
    const proj = projectChart(prodInput("cla"));
    expect(proj.xTicks.length).toBeGreaterThanOrEqual(4);
    for (const t of proj.xTicks) {
      expect(t.pos).toBeGreaterThanOrEqual(PX0 - EPS);
      expect(t.pos).toBeLessThanOrEqual(PX1 + EPS);
    }
    const labels = proj.xTicks.map((t) => Number(t.label));
    expect(Math.min(...labels)).toBeLessThanOrEqual(-10);
    expect(Math.max(...labels)).toBeGreaterThanOrEqual(25);
  });
});

describe("domain override (zoom window)", () => {
  it("respects the override and drops outside points", () => {
    const dom = { xMin: 0, xMax: 10, yMin: 0, yMax: 1.5 };
    const proj = projectChart(prodInput("cla", dom));
    expect(proj.domain).toEqual(dom);
    for (const p of proj.points) {
      expect(p.point.a).toBeGreaterThanOrEqual(0);
      expect(p.point.a).toBeLessThanOrEqual(10);
    }
    const coords = allCurveCoords(proj.curves);
    for (const [x, y] of coords) {
      expect(x).toBeGreaterThanOrEqual(PX0 - EPS);
      expect(x).toBeLessThanOrEqual(PX1 + EPS);
      expect(y).toBeGreaterThanOrEqual(PY0 - EPS);
      expect(y).toBeLessThanOrEqual(PY1 + EPS);
    }
  });

  it("interpolates boundary crossings exactly at the window edge", () => {
    const dom = { xMin: 0, xMax: 10, yMin: -10, yMax: 10 };
    const proj = projectChart(prodInput("cla", dom));
    const measured = proj.curves.filter((c) => c.kind === "measured");
    expect(measured.length).toBeGreaterThan(0);
    const first = allCurveCoords([measured[0]])[0];
    const last = allCurveCoords([measured[measured.length - 1]]).at(-1)!;
    // the curve enters at x=0 (α window edge) and leaves at x=10 → PX0/PX1
    expect(Math.abs(first[0] - PX0)).toBeLessThanOrEqual(0.11);
    expect(Math.abs(last[0] - PX1)).toBeLessThanOrEqual(0.11);
  });
});

describe("clipCurveToDomain", () => {
  const dom: ChartDomain = { xMin: 0, xMax: 10, yMin: 0, yMax: 1 };
  const pt = (a: number, cl: number): PolarPointData => ({
    a,
    cl,
    cd: 0.01,
    cm: 0,
    ld: 0,
    stalled: false,
    source: "solved",
    resultId: null,
  });

  it("splits a curve that exits and re-enters the window", () => {
    const segs = clipCurveToDomain(
      [pt(1, 0.5), pt(3, 1.6), pt(5, 1.7), pt(7, 0.5), pt(9, 0.6)],
      "cla",
      dom,
    );
    expect(segs.length).toBe(2);
    for (const seg of segs) {
      expect(seg.length).toBeGreaterThanOrEqual(2);
      for (const [x, y] of seg) {
        expect(x).toBeGreaterThanOrEqual(dom.xMin - 1e-9);
        expect(x).toBeLessThanOrEqual(dom.xMax + 1e-9);
        expect(y).toBeGreaterThanOrEqual(dom.yMin - 1e-9);
        expect(y).toBeLessThanOrEqual(dom.yMax + 1e-9);
      }
    }
    // exit crossing sits exactly on the y=1 boundary
    expect(segs[0].at(-1)![1]).toBeCloseTo(1, 9);
    expect(segs[1][0][1]).toBeCloseTo(1, 9);
  });

  it("fully-outside data yields no segments", () => {
    expect(clipCurveToDomain([pt(-5, 2), pt(-3, 3)], "cla", dom)).toEqual([]);
  });

  it("non-finite values break the polyline instead of poisoning it", () => {
    const segs = clipCurveToDomain([pt(1, 0.2), pt(2, Number.NaN), pt(3, 0.4), pt(4, 0.5)], "cla", dom);
    expect(segs.length).toBe(1);
    expect(segs[0][0][0]).toBeCloseTo(3, 9);
  });
});

describe("zoom / pan helpers", () => {
  const dom: ChartDomain = { xMin: -10, xMax: 30, yMin: 0, yMax: 2 };

  it("zoom keeps the anchor's relative position (map-style zoom)", () => {
    const center = { x: 10, y: 1.5 };
    const zoomed = zoomChartDomain(dom, 0.5, center);
    const fx = (center.x - dom.xMin) / (dom.xMax - dom.xMin);
    const fx2 = (center.x - zoomed.xMin) / (zoomed.xMax - zoomed.xMin);
    expect(fx2).toBeCloseTo(fx, 9);
    expect(zoomed.xMax - zoomed.xMin).toBeCloseTo(20, 9);
    expect(zoomed.yMax - zoomed.yMin).toBeCloseTo(1, 9);
  });

  it("zoom factor is clamped to sane bounds", () => {
    const wild = zoomChartDomain(dom, 1e9, { x: 0, y: 1 });
    expect(wild.xMax - wild.xMin).toBeLessThanOrEqual((dom.xMax - dom.xMin) * 10 + 1e-9);
  });

  it("pan translates the window", () => {
    expect(panChartDomain(dom, 5, -0.5)).toEqual({ xMin: -5, xMax: 35, yMin: -0.5, yMax: 1.5 });
  });
});

describe("readoutAtX", () => {
  const input = prodInput("cla");

  it("interpolates measured + fit values at the cursor α", () => {
    const rows = readoutAtX({ chartType: "cla", polars: input.polars, visibleSeries: input.visibleSeries, x: 2.5 });
    const measured = rows.find((r) => r.kind === "measured");
    const fit = rows.find((r) => r.kind === "fit");
    expect(measured).toBeDefined();
    // linear midpoint of (0, 0.63) and (5, 1.05)
    expect(measured!.y).toBeCloseTo(0.84, 9);
    expect(fit).toBeDefined();
    expect(fit!.y).toBeCloseTo(0.63 + 0.085 * 2.5, 6);
    expect(fit!.label).toBe("Re 3.41M · best-fit");
  });

  it("returns nothing outside the series span, for hidden series, and for Cl–Cd", () => {
    expect(readoutAtX({ chartType: "cla", polars: input.polars, visibleSeries: input.visibleSeries, x: 45 })).toEqual([]);
    expect(readoutAtX({ chartType: "cla", polars: input.polars, visibleSeries: {}, x: 0 })).toEqual([]);
    expect(readoutAtX({ chartType: "clcd", polars: input.polars, visibleSeries: input.visibleSeries, x: 0.02 })).toEqual([]);
  });

  it("L/D and Cm readouts use the right accessor", () => {
    const ld = readoutAtX({ chartType: "lda", polars: input.polars, visibleSeries: input.visibleSeries, x: 0 });
    const cm = readoutAtX({ chartType: "cma", polars: input.polars, visibleSeries: input.visibleSeries, x: 0 });
    expect(ld.find((r) => r.kind === "measured")!.y).toBeCloseTo(0.63 / 0.013, 6);
    expect(cm.find((r) => r.kind === "measured")!.y).toBeCloseTo(-0.071, 9);
  });
});
