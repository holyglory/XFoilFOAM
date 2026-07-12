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

// Cl-peak fixture for the Cl_max fine target: quadratic lift peak at an
// off-grid α* (cl = CLMAX_PEAK − KC·(α − α*)²) with a positive quadratic drag
// bucket. The local-quadratic LOWESS reproduces a quadratic exactly, so the
// golden-section argmax must land on α* to fine-target accuracy.
const A_CLMAX = 8.3;
const CLMAX_PEAK = 1.2;
const KC = 0.005;

function clPeakEvidence(a: number): PolarEvidencePoint {
  const cl = CLMAX_PEAK - KC * (a - A_CLMAX) ** 2;
  const cd = 0.02 + 0.0008 * (a - A_CLMAX) ** 2;
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

function classify(
  evidence: PolarEvidencePoint[],
): PolarEvidenceClassification[] {
  return evidence.map((e) => ({
    evidence: e,
    state: "accepted" as const,
    region: "attached" as const,
    confidence: 0.9,
    reasons: [],
  }));
}

function acceptedClassifications(
  angles: number[],
): PolarEvidenceClassification[] {
  return classify(angles.map(syntheticEvidence));
}

function clPeakClassifications(
  angles: number[],
): PolarEvidenceClassification[] {
  return classify(angles.map(clPeakEvidence));
}

describe("polar fit fine targets (spec §8)", () => {
  it("bumps POLAR_FIT_VERSION for the fine-target fields", () => {
    // v3 = alphaClmaxFine joined the metrics; existing fits refresh lazily on
    // the next ingest per revision (version participates in the cache key).
    expect(POLAR_FIT_VERSION).toBe("evidence-lowess-v5");
  });

  it("alphaLdmaxFine lands within 0.02° of the analytic L/D optimum", () => {
    const angles = Array.from({ length: 26 }, (_, i) => i - 10); // -10..15 step 1
    const fit = buildPolarFit(acceptedClassifications(angles));
    expect(fit.status).toBe("final");
    expect(fit.metrics).not.toBeNull();
    expect(
      Math.abs(fit.metrics!.alphaLdmaxFine - ALPHA_LDMAX),
    ).toBeLessThanOrEqual(0.02);
  });

  it("alphaClZeroFine lands within 0.02° of the analytic zero-lift angle", () => {
    const angles = Array.from({ length: 26 }, (_, i) => i - 10);
    const fit = buildPolarFit(acceptedClassifications(angles));
    expect(fit.metrics!.alphaClZeroFine).not.toBeNull();
    expect(
      Math.abs(fit.metrics!.alphaClZeroFine! - ALPHA0),
    ).toBeLessThanOrEqual(0.02);
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
    expect(metrics.alphaLdmaxFine).toBe(
      Number(metrics.alphaLdmaxFine.toFixed(2)),
    );
    expect(metrics.alphaClZeroFine).toBe(
      Number(metrics.alphaClZeroFine!.toFixed(2)),
    );
  });

  it("alphaClmaxFine lands within 0.02° of the analytic Cl peak", () => {
    const angles = Array.from({ length: 21 }, (_, i) => i - 2); // -2..18 step 1, peak at 8.3 off-grid
    const fit = buildPolarFit(clPeakClassifications(angles));
    expect(fit.status).toBe("final");
    expect(fit.metrics).not.toBeNull();
    expect(fit.metrics!.alphaClmaxFine).not.toBeNull();
    expect(
      Math.abs(fit.metrics!.alphaClmaxFine! - A_CLMAX),
    ).toBeLessThanOrEqual(0.02);
  });

  it("alphaClmaxFine is rounded to 0.01°", () => {
    const angles = Array.from({ length: 21 }, (_, i) => i - 2);
    const metrics = buildPolarFit(clPeakClassifications(angles)).metrics!;
    expect(metrics.alphaClmaxFine).toBe(
      Number(metrics.alphaClmaxFine!.toFixed(2)),
    );
  });

  it("alphaClmaxFine is null when the Cl argmax sits on the evidence boundary (no interior max)", () => {
    // The thin-airfoil fixture's cl is monotonic in α: the coarse argmax is the
    // last evidence sample, so no interior maximum is bracketed — the fine
    // target must be an honest null, not an extrapolated invention.
    const angles = Array.from({ length: 26 }, (_, i) => i - 10);
    const fit = buildPolarFit(acceptedClassifications(angles));
    expect(fit.metrics).not.toBeNull();
    expect(fit.metrics!.alphaClmaxFine).toBeNull();
  });
});
