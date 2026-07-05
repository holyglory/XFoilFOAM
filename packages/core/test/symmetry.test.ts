import { describe, expect, it } from "vitest";

import {
  buildNaca4,
  isAirfoilSymmetric,
  mirrorClassifiedEvidence,
  mirrorPolarPoint,
  type PolarEvidenceClassification,
  type Point,
} from "../src/index";

/** Diamond airfoil with an exact ±0.05 surface, lower side offset by `delta`
 *  at mid-chord — piecewise linear, so resampling introduces zero error. */
function diamondContour(delta: number): Point[] {
  return [
    { x: 1, y: 0 },
    { x: 0.5, y: 0.05 },
    { x: 0, y: 0 },
    { x: 0.5, y: -0.05 + delta },
    { x: 1, y: 0 },
  ];
}

describe("isAirfoilSymmetric (spec §9.1)", () => {
  it("detects NACA 0012 as symmetric", () => {
    const { contour } = buildNaca4({ t: 0.12, m: 0, p: 0 });
    expect(isAirfoilSymmetric(contour)).toBe(true);
  });

  it("detects cambered NACA 2412 and 4415 as asymmetric", () => {
    expect(isAirfoilSymmetric(buildNaca4({ t: 0.12, m: 0.02, p: 0.4 }).contour)).toBe(false);
    expect(isAirfoilSymmetric(buildNaca4({ t: 0.15, m: 0.04, p: 0.4 }).contour)).toBe(false);
  });

  it("is a chord-relative check: still true after rotation, translation, scaling", () => {
    const { contour } = buildNaca4({ t: 0.12, m: 0, p: 0 });
    const th = (5 * Math.PI) / 180;
    const transformed = contour.map((p) => ({
      x: 2 * (p.x * Math.cos(th) - p.y * Math.sin(th)) + 3,
      y: 2 * (p.x * Math.sin(th) + p.y * Math.cos(th)) - 1,
    }));
    expect(isAirfoilSymmetric(transformed)).toBe(true);
  });

  it("applies the 1e-4-of-chord tolerance at the boundary", () => {
    expect(isAirfoilSymmetric(diamondContour(0))).toBe(true);
    expect(isAirfoilSymmetric(diamondContour(0.00009))).toBe(true); // inside tolerance
    expect(isAirfoilSymmetric(diamondContour(0.0002))).toBe(false); // outside tolerance
  });

  it("rejects degenerate inputs instead of guessing", () => {
    expect(isAirfoilSymmetric([])).toBe(false);
    expect(
      isAirfoilSymmetric([
        { x: 0, y: 0 },
        { x: 1, y: 0 },
      ]),
    ).toBe(false);
  });
});

describe("mirrorPolarPoint (spec §9.2)", () => {
  it("negates aoaDeg/cl/cm, keeps cd, preserves every other field", () => {
    const source = {
      aoaDeg: 5,
      cl: 0.6,
      cd: 0.02,
      cm: -0.08,
      resultId: "r1",
      state: "terminal",
    };
    expect(mirrorPolarPoint(source)).toEqual({
      aoaDeg: -5,
      cl: -0.6,
      cd: 0.02,
      cm: 0.08,
      resultId: "r1",
      state: "terminal",
    });
  });

  it("keeps null coefficients null and never emits -0", () => {
    const mirrored = mirrorPolarPoint({ aoaDeg: 0, cl: null, cd: null, cm: 0 });
    expect(mirrored.cl).toBeNull();
    expect(mirrored.cd).toBeNull();
    expect(Object.is(mirrored.aoaDeg, 0)).toBe(true);
    expect(Object.is(mirrored.cm, 0)).toBe(true);
  });
});

describe("mirrorClassifiedEvidence (spec §9.2)", () => {
  const classification = (
    a: number,
    state: PolarEvidenceClassification["state"],
  ): PolarEvidenceClassification => ({
    evidence: {
      id: `res-${a}`,
      a,
      cl: 0.11 * a,
      cd: 0.01 + 0.0002 * a * a,
      cm: -0.05,
      ld: a === 0 ? 0 : (0.11 * a) / (0.01 + 0.0002 * a * a),
      status: "done",
      source: "solved",
      regime: "rans",
      converged: true,
      stalled: false,
    },
    state,
    region: "attached",
    confidence: 0.9,
    reasons: [],
  });

  it("mirrors accepted/needs_urans positive-α evidence with provenance", () => {
    const mirrored = mirrorClassifiedEvidence([
      classification(0, "accepted"),
      classification(2, "accepted"),
      classification(4, "needs_urans"),
      classification(6, "rejected"),
      classification(-1, "accepted"),
    ]);
    expect(mirrored.map((c) => c.evidence.a)).toEqual([-4, -2]);
    expect(mirrored.map((c) => c.derivedFromAoaDeg)).toEqual([4, 2]);
    expect(mirrored.map((c) => c.state)).toEqual(["needs_urans", "accepted"]);
  });

  it("negates cl/cm/ld, keeps cd and the source evidence fields", () => {
    const [mirrored] = mirrorClassifiedEvidence([classification(2, "accepted")]);
    const source = classification(2, "accepted").evidence;
    expect(mirrored.evidence.cl).toBeCloseTo(-(source.cl ?? 0), 12);
    expect(mirrored.evidence.cm).toBeCloseTo(-(source.cm ?? 0), 12);
    expect(mirrored.evidence.ld).toBeCloseTo(-(source.ld ?? 0), 12);
    expect(mirrored.evidence.cd).toBe(source.cd);
    expect(mirrored.evidence.id).toBe(source.id);
    expect(mirrored.evidence.regime).toBe("rans");
  });
});
