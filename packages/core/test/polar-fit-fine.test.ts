import { describe, expect, it } from "vitest";

import {
  buildPolarFit,
  POLAR_FIT_VERSION,
  type PolarEvidenceClassification,
  type PolarEvidencePoint,
} from "../src/index";

// Synthetic smooth polar with known analytic targets: cl = m·(α − α0) (thin
// airfoil small-angle lift) and cd = cd0 + k·cl² (quadratic drag polar).
// L/D = cl/(cd0 + k·cl²) peaks at cl* = √(cd0/k) → α* = α0 + cl*/m.
const M = 0.11; // per degree
const ALPHA0 = -2;
const CD0 = 0.008;
const K = 0.01;
const ALPHA_LDMAX = ALPHA0 + Math.sqrt(CD0 / K) / M;

function syntheticEvidence(a: number): PolarEvidencePoint {
  const cl = M * (a - ALPHA0);
  const cd = CD0 + K * cl * cl;
  return {
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
  };
}

function acceptedClassifications(angles: number[]): PolarEvidenceClassification[] {
  return angles.map((a) => ({
    evidence: syntheticEvidence(a),
    state: "accepted" as const,
    region: "attached" as const,
    confidence: 0.9,
    reasons: [],
  }));
}

describe("polar fit fine targets (spec §8)", () => {
  it("bumps POLAR_FIT_VERSION for the fine-target fields", () => {
    expect(POLAR_FIT_VERSION).toBe("evidence-lowess-v2");
  });

  it("alphaLdmaxFine lands within 0.02° of the analytic L/D optimum", () => {
    const angles = Array.from({ length: 26 }, (_, i) => i - 10); // -10..15 step 1
    const fit = buildPolarFit(acceptedClassifications(angles));
    expect(fit.status).toBe("final");
    expect(fit.metrics).not.toBeNull();
    expect(Math.abs(fit.metrics!.alphaLdmaxFine - ALPHA_LDMAX)).toBeLessThanOrEqual(0.02);
  });

  it("alphaClZeroFine lands within 0.02° of the analytic zero-lift angle", () => {
    const angles = Array.from({ length: 26 }, (_, i) => i - 10);
    const fit = buildPolarFit(acceptedClassifications(angles));
    expect(fit.metrics!.alphaClZeroFine).not.toBeNull();
    expect(Math.abs(fit.metrics!.alphaClZeroFine! - ALPHA0)).toBeLessThanOrEqual(0.02);
  });

  it("alphaClZeroFine is null when Cl never crosses zero in the evidence range", () => {
    const angles = Array.from({ length: 11 }, (_, i) => i + 1); // 1..11, cl > 0 throughout
    const fit = buildPolarFit(acceptedClassifications(angles));
    expect(fit.metrics).not.toBeNull();
    expect(fit.metrics!.alphaClZeroFine).toBeNull();
  });

  it("fine targets are rounded to 0.01°", () => {
    const angles = Array.from({ length: 26 }, (_, i) => i - 10);
    const metrics = buildPolarFit(acceptedClassifications(angles)).metrics!;
    expect(metrics.alphaLdmaxFine).toBe(Number(metrics.alphaLdmaxFine.toFixed(2)));
    expect(metrics.alphaClZeroFine).toBe(Number(metrics.alphaClZeroFine!.toFixed(2)));
  });
});
