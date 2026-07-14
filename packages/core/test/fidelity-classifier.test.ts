// Fidelity-ladder classifier gates (POLAR_CLASSIFIER_VERSION fidelity-ladder-v6):
//   1. FIDELITY-AWARE frame-track period bar — urans_precalc accepts at >= 3
//      retained periods, urans_full / legacy keeps the strict >= 5 bar.
//   2. Oscillating-steady acceptance — a STEADY row with converged=false but
//      steady_history.mean_stable === true is valid RANS evidence (the
//      not-converged / solver-stalled verdicts are waived for exactly that
//      shape, fail-closed on anything else).
// MUST-CATCH rows are built with the sweeper's exact ingest semantics
// (stalled = unsteady || converged === false) — the shape real rows have.

import { describe, expect, it } from "vitest";

import {
  classifyPolarEvidence,
  FRAME_TRACK_MIN_PERIODS,
  FRAME_TRACK_MIN_PERIODS_FULL,
  FRAME_TRACK_MIN_PERIODS_PRECALC,
  frameTrackMinPeriodsFor,
  isOscillatingSteadyStable,
  POLAR_CLASSIFIER_VERSION,
  type PolarEvidencePoint,
} from "../src/polar-fit";

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

const uransRow: PolarEvidencePoint = {
  a: 16,
  cl: 1.12,
  cd: 0.21,
  cm: -0.06,
  status: "done",
  source: "solved",
  regime: "urans",
  converged: true,
  stalled: true, // aerodynamic marker: true because unsteady
  unsteady: true,
  hasForceHistory: true,
  hasVideo: true,
  frameTrack: contractFrameTrack,
};

const steadyHistory = {
  iterations: [1000, 1500, 2000],
  cl: [0.84, 0.841, 0.84],
  cd: [0.019, 0.019, 0.019],
  cm: [-0.052, -0.052, -0.052],
  window: { start_iter: 1000, end_iter: 2000 },
  mean_stable: true,
  note: "steady residuals plateaued in a bounded oscillation",
};

/** Ingest-shaped oscillating-steady row: converged=false so stalled=true. */
const oscillatingSteadyRow: PolarEvidencePoint = {
  a: 6,
  cl: 0.84,
  cd: 0.019,
  cm: -0.052,
  status: "done",
  source: "solved",
  regime: "rans",
  converged: false,
  stalled: true,
  unsteady: false,
  steadyHistory,
};

describe("fidelity-aware frame-track period bar (v6)", () => {
  it("pins the version stamp and the per-tier bars", () => {
    expect(POLAR_CLASSIFIER_VERSION).toBe("fidelity-ladder-v6");
    expect(FRAME_TRACK_MIN_PERIODS_PRECALC).toBe(3);
    expect(FRAME_TRACK_MIN_PERIODS_FULL).toBe(5);
    expect(FRAME_TRACK_MIN_PERIODS).toBe(FRAME_TRACK_MIN_PERIODS_FULL);
    expect(frameTrackMinPeriodsFor("urans_precalc")).toBe(3);
    expect(frameTrackMinPeriodsFor("urans_full")).toBe(5);
    expect(frameTrackMinPeriodsFor("rans")).toBe(5);
    expect(frameTrackMinPeriodsFor(null)).toBe(5);
    expect(frameTrackMinPeriodsFor(undefined)).toBe(5);
    expect(frameTrackMinPeriodsFor("PRECALC")).toBe(5); // unknown → strict
  });

  it("MUST-CATCH: a precalc row with 3 retained periods ACCEPTS; the same track at full/legacy fidelity REJECTS", () => {
    const threePeriods = { ...contractFrameTrack, periods_retained: 3 };
    const precalc = classifyPolarEvidence([
      { ...uransRow, fidelity: "urans_precalc", frameTrack: threePeriods },
    ]);
    expect(precalc.classifications[0].state).toBe("accepted");
    expect(precalc.classifications[0].reasons).toEqual([]);

    for (const fidelity of ["urans_full", null, undefined] as const) {
      const full = classifyPolarEvidence([
        { ...uransRow, fidelity, frameTrack: threePeriods },
      ]);
      expect(full.classifications[0].state).toBe("rejected");
      expect(full.classifications[0].reasons).toContain("insufficient-periods");
    }
  });

  it("a precalc row below 3 periods still rejects (the precalc bar is 3, not 0)", () => {
    const classified = classifyPolarEvidence([
      {
        ...uransRow,
        fidelity: "urans_precalc",
        frameTrack: { ...contractFrameTrack, periods_retained: 2 },
      },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain(
      "insufficient-periods",
    );
  });

  it("the stationarity gate itself is unchanged: a non-stationary precalc track rejects", () => {
    const classified = classifyPolarEvidence([
      {
        ...uransRow,
        fidelity: "urans_precalc",
        frameTrack: {
          ...contractFrameTrack,
          periods_retained: 3,
          stationary: false,
        },
      },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain("non-stationary");
  });

  it("full-fidelity rows at >= 5 periods keep accepting (no regression)", () => {
    const classified = classifyPolarEvidence([
      {
        ...uransRow,
        fidelity: "urans_full",
        frameTrack: { ...contractFrameTrack, periods_retained: 5 },
      },
    ]);
    expect(classified.classifications[0].state).toBe("accepted");
  });
});

describe("oscillating-steady acceptance (steady_history.mean_stable, v4)", () => {
  it("MUST-CATCH: an ingest-shaped oscillating-steady row (converged=false, stalled=true, mean_stable=true) ACCEPTS as RANS evidence", () => {
    // Pre-v4 this exact shape rejected ["not-converged", "solver-stalled"] —
    // every oscillating-averaged steady solve was thrown away.
    const classified = classifyPolarEvidence([oscillatingSteadyRow]);
    expect(classified.classifications[0].state).toBe("accepted");
    expect(classified.classifications[0].reasons).toEqual([]);
    expect(classified.hardRejectedAoas).toEqual([]);
  });

  it("reasons stay rejection-only: the accepted oscillating row carries NO note in reasons (the marker lives in quality warnings)", () => {
    const classified = classifyPolarEvidence([oscillatingSteadyRow]);
    expect(classified.classifications[0].reasons).toEqual([]);
  });

  it("fail closed: mean_stable false / drifted string / absent history all still reject not-converged", () => {
    for (const history of [
      { ...steadyHistory, mean_stable: false },
      { ...steadyHistory, mean_stable: "true" },
      null,
      undefined,
    ]) {
      const classified = classifyPolarEvidence([
        { ...oscillatingSteadyRow, steadyHistory: history as never },
      ]);
      expect(classified.classifications[0].state).toBe("rejected");
      expect(classified.classifications[0].reasons).toContain("not-converged");
      expect(classified.classifications[0].reasons).toContain("solver-stalled");
    }
  });

  it("the waiver is narrow: other gates still reject an oscillating-steady row (error, missing coefficients, non-physical)", () => {
    const withError = classifyPolarEvidence([
      { ...oscillatingSteadyRow, error: "boom" },
    ]);
    expect(withError.classifications[0].state).toBe("rejected");
    expect(withError.classifications[0].reasons).toContain("solver-error");

    const missing = classifyPolarEvidence([
      { ...oscillatingSteadyRow, cm: null },
    ]);
    expect(missing.classifications[0].state).toBe("rejected");
    expect(missing.classifications[0].reasons).toContain(
      "missing-coefficients",
    );

    const blown = classifyPolarEvidence([
      { ...oscillatingSteadyRow, cl: 79.8 },
    ]);
    expect(blown.classifications[0].state).toBe("rejected");
    expect(blown.classifications[0].reasons).toContain(
      "non-physical-coefficients",
    );
  });

  it("an UNSTEADY row never uses the steady waiver (isOscillatingSteadyStable is steady-only)", () => {
    expect(isOscillatingSteadyStable(oscillatingSteadyRow)).toBe(true);
    expect(
      isOscillatingSteadyStable({ ...oscillatingSteadyRow, unsteady: true }),
    ).toBe(false);
    const classified = classifyPolarEvidence([
      {
        ...uransRow,
        converged: false,
        steadyHistory,
        frameTrack: contractFrameTrack,
      },
    ]);
    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain("not-converged");
  });
});
