import { describe, expect, it } from "vitest";

import {
  classifyPolarEvidence,
  type PolarEvidencePoint,
} from "../src/polar-fit";

function channel(mean: number, span: number) {
  const min_value = mean - span / 2;
  const max_value = mean + span / 2;
  return {
    mean,
    min_value,
    max_value,
    peak_to_peak: max_value - min_value,
    relative_spread: (max_value - min_value) / (Math.abs(mean) + 1e-3),
  };
}

function holdCertificate() {
  return {
    reducer_version: "rans-hold-v1",
    sample_count: 200,
    required_sample_count: 200,
    start_iteration: 801,
    end_iteration: 1000,
    relative_tolerance: 0.002,
    absolute_floor: 1e-3,
    certified: true,
    cl: channel(0.62, 0.0002),
    cd: channel(0.021, 0.00002),
    cm: channel(-0.071, 0.00002),
  };
}

function steadyRansEvidence(): PolarEvidencePoint {
  return {
    a: 4,
    cl: 0.62,
    cd: 0.021,
    cm: -0.071,
    status: "done",
    source: "solved",
    regime: "rans",
    fidelity: "rans",
    converged: true,
    stalled: false,
    unsteady: false,
    ransHoldCertificate: holdCertificate(),
  };
}

describe("current RANS final-window proof", () => {
  it("accepts an exact all-channel current hold certificate", () => {
    const classified = classifyPolarEvidence([steadyRansEvidence()]);

    expect(classified.classifications[0]).toMatchObject({
      state: "accepted",
      reasons: [],
    });
  });

  it("keeps an absent proof compatible for legacy RANS evidence", () => {
    const { ransHoldCertificate: _proof, ...legacy } = steadyRansEvidence();
    const classified = classifyPolarEvidence([legacy]);

    expect(classified.classifications[0]).toMatchObject({
      state: "accepted",
      reasons: [],
    });
  });

  it("routes a current explicit missing proof to targeted FAST URANS", () => {
    const classified = classifyPolarEvidence([
      { ...steadyRansEvidence(), ransHoldCertificate: null },
    ]);

    expect(classified.needsUransAoas).toEqual([4]);
    expect(classified.hardRejectedAoas).toEqual([]);
    expect(classified.classifications[0]).toMatchObject({
      state: "needs_urans",
      reasons: ["missing-rans-hold-certificate"],
    });
  });

  it("routes malformed current proof to targeted FAST URANS without broad promotion", () => {
    const certificate = holdCertificate();
    const classified = classifyPolarEvidence([
      {
        ...steadyRansEvidence(),
        ransHoldCertificate: { ...certificate, cm: { ...certificate.cm, relative_spread: 0.5 } },
      },
    ]);

    expect(classified.needsUransAoas).toEqual([4]);
    expect(classified.hardRejectedAoas).toEqual([]);
    expect(classified.classifications[0]).toMatchObject({
      state: "needs_urans",
      reasons: ["invalid-rans-hold-certificate"],
    });
  });

  it("MUST-CATCH: refuses a structurally valid proof whose means do not bind the projected coefficients", () => {
    const classified = classifyPolarEvidence([
      { ...steadyRansEvidence(), cl: 0.621 },
    ]);

    expect(classified.needsUransAoas).toEqual([4]);
    expect(classified.hardRejectedAoas).toEqual([]);
    expect(classified.classifications[0]).toMatchObject({
      state: "needs_urans",
      reasons: ["rans-hold-coefficient-mismatch"],
    });
  });

  it("does not disguise a genuine RANS non-convergence as a proof-only handoff", () => {
    const classified = classifyPolarEvidence([
      {
        ...steadyRansEvidence(),
        converged: false,
        ransHoldCertificate: null,
      },
    ]);

    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toEqual(
      expect.arrayContaining(["not-converged", "missing-rans-hold-certificate"]),
    );
  });
});
