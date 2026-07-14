import { describe, expect, it } from "vitest";

import {
  fitBridgeThresholdDeg,
  measuredAlphas,
  projectChart,
  readoutAtX,
  supportedFitSegments,
} from "../src/chart";
import type { PolarFit, PolarPointData } from "../src/types";

function asFit(points: { a: number; cl: number; cd: number; cm: number; ld: number }[]): PolarFit {
  return { status: "ok" as PolarFit["status"], confidence: 1, metrics: null, points: points as PolarFit["points"], acceptedPointCount: points.length, provisionalPointCount: 0, rejectedPointCount: 0 };
}

function pt(a: number, over: Partial<PolarPointData> = {}): PolarPointData {
  return { a, cl: 0.1 * a, cd: 0.02 + 0.0005 * a * a, cm: -0.01, ld: 10, stalled: false, source: "solved", resultId: `r${a}`, classificationState: "accepted", ...over };
}

function fitSample(a: number, over: Partial<{ cl: number; cd: number; cm: number; ld: number }> = {}) {
  return { a, cl: 0.1 * a, cd: 0.02 + 0.0005 * a * a, cm: -0.01, ld: 10, ...over };
}

/** α grid every 1° from lo to hi inclusive. */
function fitGrid(lo: number, hi: number) {
  const out = [];
  for (let a = lo; a <= hi + 1e-9; a += 1) out.push(fitSample(a));
  return out;
}

describe("fit support gating (S1223 phantom-lobe incident 2026-07-10)", () => {
  // MUST-CATCH incident shape: 7 solved points with a 15° hole (10…25 pending
  // URANS) — the LOWESS samples bridging the hole invented a second Cl-Cd
  // lobe. The bridge must NOT be drawn: two segments, no sample inside the
  // unsupported middle.
  it("splits fit samples across an unsupported measured-α hole", () => {
    const alphas = [-15, -10, -5, 0, 5, 10, 25, 30];
    const segs = supportedFitSegments(fitGrid(-15, 30), alphas);
    expect(segs.length).toBe(2);
    // interval semantics: NOTHING draws inside the 10…25 hole
    expect(segs.flat().some((p) => p.a > 10 + 1e-9 && p.a < 25 - 1e-9)).toBe(false);
    expect(fitBridgeThresholdDeg(alphas)).toBe(10); // 2 x median(5°)
  });

  it("trims extrapolated tails beyond measured coverage", () => {
    const alphas = [0, 5, 10];
    const segs = supportedFitSegments(fitGrid(-20, 40), alphas);
    expect(segs.length).toBe(1);
    // no extrapolation: the fit never leaves the measured α range
    expect(Math.min(...segs[0].map((p) => p.a))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...segs[0].map((p) => p.a))).toBeLessThanOrEqual(10);
  });

  // FALSE-POSITIVE GUARD: a healthy uniformly-solved sweep keeps ONE
  // continuous fit — gating must not chop up well-supported polars.
  it("keeps a uniform 5-degree sweep as a single full segment", () => {
    const alphas = [-15, -10, -5, 0, 5, 10, 15, 20, 25, 30];
    const grid = fitGrid(-15, 30);
    const segs = supportedFitSegments(grid, alphas);
    expect(segs.length).toBe(1);
    expect(segs[0].length).toBe(grid.length);
  });

  it("projectChart draws the gated fit as multiple curves and ignores unsupported lobes in the Cl-Cd window", () => {
    const alphas = [-15, -10, -5, 0, 5, 10, 25, 30];
    // unsupported bridge carries an absurd Cd spike that must not stretch xMax
    const fitPoints = fitGrid(-15, 30).map((p) => (p.a > 13 && p.a < 22 ? { ...p, cd: 0.049 } : { ...p, cd: 0.01 }));
    const polars = [{ seriesId: "series-fit", label: "Re 850k", re: 850_000, color: "#a78bfa", points: alphas.map((a) => pt(a, { cd: 0.01 })), fit: asFit(fitPoints) }];
    const proj = projectChart({ chartType: "clcd", polars, visibleSeries: { "series-fit": true } });
    expect(proj.curves.filter((c) => c.kind === "fit").length).toBeGreaterThanOrEqual(2);
    // 0.049 spike lives only in the unsupported bridge → window stays near the data
    expect(proj.domain.xMax).toBeLessThan(0.045);
  });

  it("readoutAtX refuses fit values inside the unsupported hole but serves supported spans", () => {
    const alphas = [-15, -10, -5, 0, 5, 10, 25, 30];
    const polars = [{ seriesId: "series-fit", label: "Re 850k", re: 850_000, color: "#a78bfa", points: alphas.map((a) => pt(a)), fit: asFit(fitGrid(-15, 30)) }];
    const base = { chartType: "cla" as const, polars, visibleSeries: { "series-fit": true } };
    const inHole = readoutAtX({ ...base, x: 17.5 });
    expect(inHole.some((r) => r.kind === "fit")).toBe(false);
    const supported = readoutAtX({ ...base, x: 2.5 });
    expect(supported.some((r) => r.kind === "fit")).toBe(true);
  });
});
