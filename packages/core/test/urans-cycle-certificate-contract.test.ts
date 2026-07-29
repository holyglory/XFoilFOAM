import { describe, expect, it } from "vitest";

import {
  classifyPolarEvidence,
  type PolarEvidencePoint,
} from "../src/polar-fit";

const frameTrack = (periodsRetained: number) => ({
  period_s: 0.137,
  periods_retained: periodsRetained,
  stationary: true,
  drift_frac: 0.01,
  window: { t_start: 10, t_end: 10 + periodsRetained * 0.137 },
  stats: {
    cl: { mean: 1.12, std: 0.18, min: 0.83, max: 1.41 },
    cd: { mean: 0.21, std: 0.03, min: 0.16, max: 0.27 },
    cm: { mean: -0.06, std: 0.01, min: -0.09, max: -0.03 },
  },
  fields: ["vorticity", "velocity_magnitude"],
  frames: [{ i: 0, t: 10.76, cl: 1.1, cd: 0.21, cm: -0.06 }],
  image_pattern: "frames/{field}/f{i04}.png",
});

function cycle(index: number, disposition: string) {
  return {
    index,
    t_start: 10 + index * 0.137,
    t_end: 10 + (index + 1) * 0.137,
    coefficient_samples: 20,
    field_frames: 20,
    phase_max_gap: 0.02,
    phase_shift_bins: 1,
    cl_mean: 1.12,
    cd_mean: 0.21,
    cm_mean: -0.06,
    cl_shape_error: 0.02,
    cd_shape_error: 0.02,
    cm_shape_error: 0.02,
    cl_amplitude_deviation: 0.02,
    cd_amplitude_deviation: 0.02,
    cm_amplitude_deviation: 0.02,
    cl_high_frequency: 0.01,
    cd_high_frequency: 0.01,
    cm_high_frequency: 0.01,
    disposition,
    reasons: [] as string[],
  };
}

function cleanCertificate(requiredCleanCycles: number) {
  return {
    reducer_version: "clean-cycle-v3",
    period_s: 0.137,
    phase_samples: 96,
    required_clean_cycles: requiredCleanCycles,
    terminal_clean_cycles: requiredCleanCycles,
    selected_cycle_start_index: 1,
    certified: true,
    cadence_adjusted: false,
    cycles: [
      cycle(0, "startup"),
      ...Array.from({ length: requiredCleanCycles }, (_, offset) =>
        cycle(offset + 1, "selected"),
      ),
    ],
  };
}

function uransEvidence(
  fidelity: "urans_precalc" | "urans_full",
): PolarEvidencePoint {
  const required = fidelity === "urans_precalc" ? 3 : 5;
  return {
    a: 16,
    cl: 1.12,
    cd: 0.21,
    cm: -0.06,
    status: "done",
    source: "solved",
    regime: "urans",
    fidelity,
    converged: true,
    stalled: true,
    unsteady: true,
    hasForceHistory: true,
    hasVideo: true,
    frameTrack: frameTrack(required),
    uransCycleCertificate: cleanCertificate(required),
  };
}

describe("clean-cycle certificate polar acceptance", () => {
  it("accepts exact FAST and FINAL terminal clean suffixes", () => {
    for (const fidelity of ["urans_precalc", "urans_full"] as const) {
      const classified = classifyPolarEvidence([uransEvidence(fidelity)]);
      expect(classified.classifications[0]).toMatchObject({
        state: "accepted",
        reasons: [],
      });
    }
  });

  it("accepts a fixed FAST publication window after extra clean terminal cycles", () => {
    const certificate = cleanCertificate(3);
    certificate.terminal_clean_cycles = 5;
    certificate.selected_cycle_start_index = 3;
    certificate.cycles = [
      cycle(0, "startup"),
      cycle(1, "startup"),
      cycle(2, "startup"),
      cycle(3, "selected"),
      cycle(4, "selected"),
      cycle(5, "selected"),
    ];

    const classified = classifyPolarEvidence([
      {
        ...uransEvidence("urans_precalc"),
        uransCycleCertificate: certificate,
      },
    ]);

    expect(classified.classifications[0]).toMatchObject({
      state: "accepted",
      reasons: [],
    });
  });

  it("keeps evidence with an absent certificate compatible as legacy evidence", () => {
    const current = uransEvidence("urans_precalc");
    const { uransCycleCertificate: _certificate, ...legacy } = current;

    const classified = classifyPolarEvidence([legacy]);

    expect(classified.classifications[0]).toMatchObject({
      state: "accepted",
      reasons: [],
    });
  });

  it("fails closed when a current producer explicitly omits the certificate", () => {
    const classified = classifyPolarEvidence([
      { ...uransEvidence("urans_precalc"), uransCycleCertificate: null },
    ]);

    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain(
      "missing-clean-cycle-certificate",
    );
  });

  it("rejects a current certificate from an unknown reducer version", () => {
    const current = uransEvidence("urans_precalc");
    const classified = classifyPolarEvidence([
      {
        ...current,
        uransCycleCertificate: {
          ...cleanCertificate(3),
          reducer_version: "clean-cycle-v1",
        },
      },
    ]);

    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain(
      "invalid-clean-cycle-certificate",
    );
  });

  it("rejects an uncertified current FAST result without treating it as legacy", () => {
    const certificate = {
      ...cleanCertificate(3),
      selected_cycle_start_index: null as number | null,
    };
    certificate.certified = false;
    certificate.terminal_clean_cycles = 2;
    certificate.selected_cycle_start_index = null;
    certificate.cycles = [cycle(0, "startup"), cycle(1, "settling_outlier")];

    const classified = classifyPolarEvidence([
      {
        ...uransEvidence("urans_precalc"),
        uransCycleCertificate: certificate,
      },
    ]);

    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain(
      "uncertified-urans-cycles",
    );
  });

  it("rejects a non-terminal selected set so a corrupt cycle cannot be stitched around", () => {
    const certificate = cleanCertificate(3);
    certificate.cycles = [
      cycle(0, "startup"),
      cycle(1, "selected"),
      cycle(2, "hard_corrupt"),
      cycle(3, "selected"),
      cycle(4, "selected"),
    ];

    const classified = classifyPolarEvidence([
      {
        ...uransEvidence("urans_precalc"),
        uransCycleCertificate: certificate,
      },
    ]);

    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain(
      "invalid-clean-cycle-certificate",
    );
  });

  it("rejects a selected cycle lacking the required coefficient or field samples", () => {
    const certificate = cleanCertificate(3);
    certificate.cycles[3] = {
      ...certificate.cycles[3],
      coefficient_samples: 19,
      field_frames: 19,
    };

    const classified = classifyPolarEvidence([
      {
        ...uransEvidence("urans_precalc"),
        uransCycleCertificate: certificate,
      },
    ]);

    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain(
      "insufficient-clean-cycle-evidence",
    );
  });

  it.each([
    ["a producer-reported corruption reason", { reasons: ["impulsive discontinuity"] }],
    ["a phase gap above 10%", { phase_max_gap: 0.11 }],
    ["a phase shift above four bins", { phase_shift_bins: 5 }],
    ["a shape error above the policy", { cm_shape_error: 0.13 }],
    ["an amplitude deviation above the policy", { cl_amplitude_deviation: 0.31 }],
  ])("MUST-CATCH: rejects selected evidence with %s", (_label, mutation) => {
    const certificate = cleanCertificate(3);
    certificate.cycles[1] = { ...certificate.cycles[1], ...mutation };

    const classified = classifyPolarEvidence([
      {
        ...uransEvidence("urans_precalc"),
        uransCycleCertificate: certificate,
      },
    ]);

    expect(classified.classifications[0].state).toBe("rejected");
    expect(classified.classifications[0].reasons).toContain(
      "invalid-clean-cycle-quality",
    );
  });
});

