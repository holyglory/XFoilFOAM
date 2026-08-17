import { describe, expect, it } from "vitest";

import {
  parseUransCycleCertificate,
  URANS_CLEAN_CYCLE_CERTIFICATE_VERSION,
} from "../src/urans-cycle-certificate";

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

function certifiedCertificate() {
  return {
    reducer_version: URANS_CLEAN_CYCLE_CERTIFICATE_VERSION,
    period_s: 0.137,
    phase_samples: 96,
    required_clean_cycles: 3,
    terminal_clean_cycles: 3,
    selected_cycle_start_index: 1,
    certified: true,
    cadence_adjusted: false,
    cycles: [
      cycle(0, "startup"),
      cycle(1, "selected"),
      cycle(2, "selected"),
      cycle(3, "selected"),
    ],
  };
}

describe("clean-cycle certificate parser", () => {
  it("accepts an exact certified contiguous terminal suffix", () => {
    const parsed = parseUransCycleCertificate(certifiedCertificate());

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value).toMatchObject({
        reducer_version: URANS_CLEAN_CYCLE_CERTIFICATE_VERSION,
        terminal_clean_cycles: 3,
        selected_cycle_start_index: 1,
      });
    }
  });

  it("accepts legacy null diagnostics only as explicit hard-corrupt evidence", () => {
    const certificate = certifiedCertificate() as unknown as {
      cycles: Array<Record<string, unknown>>;
    };
    certificate.cycles[0] = {
      ...cycle(0, "hard_corrupt"),
      cl_amplitude_deviation: null,
      cd_amplitude_deviation: null,
      cm_amplitude_deviation: null,
      reasons: [
        "unavailable cycle metrics: cl_amplitude_deviation, cd_amplitude_deviation, cm_amplitude_deviation",
      ],
    };

    const parsed = parseUransCycleCertificate(certificate);

    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) {
      expect(parsed.value.cycles[0]).toMatchObject({
        disposition: "hard_corrupt",
        cl_amplitude_deviation: null,
      });
      expect(
        parsed.value.cycles.filter((entry) => entry.disposition === "selected"),
      ).toHaveLength(3);
    }
  });

  it("MUST-CATCH: rejects an unavailable diagnostic presented as a selected cycle", () => {
    const certificate = certifiedCertificate() as unknown as {
      cycles: Array<Record<string, unknown>>;
    };
    certificate.cycles[1] = {
      ...cycle(1, "selected"),
      cl_amplitude_deviation: null,
    };

    const parsed = parseUransCycleCertificate(certificate);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "urans_cycle_certificate.cycles[1]: unavailable cycle metrics require hard_corrupt disposition",
      );
    }
  });

  it("fails closed when selected cycles stitch around a corrupt middle cycle", () => {
    const certificate = certifiedCertificate();
    certificate.cycles = [
      cycle(0, "startup"),
      cycle(1, "selected"),
      cycle(2, "hard_corrupt"),
      cycle(3, "selected"),
      cycle(4, "selected"),
    ];

    const parsed = parseUransCycleCertificate(certificate);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "urans_cycle_certificate: selected cycles must be the exact contiguous terminal publication suffix",
      );
    }
  });

  it("accepts a three-cycle publication window after extra terminal clean evidence", () => {
    const certificate = certifiedCertificate();
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

    expect(parseUransCycleCertificate(certificate)).toMatchObject({ ok: true });
  });

  it("fails closed when a certified publication suffix does not match its fidelity window", () => {
    const certificate = certifiedCertificate();
    certificate.cycles[3] = cycle(3, "startup");

    const parsed = parseUransCycleCertificate(certificate);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        "urans_cycle_certificate: selected cycles must be the exact contiguous terminal publication suffix",
      );
    }
  });

  it("rejects contract drift instead of silently accepting an unknown payload field", () => {
    const parsed = parseUransCycleCertificate({
      ...certifiedCertificate(),
      made_up_field: true,
    });

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toContain(
        'urans_cycle_certificate: unexpected key "made_up_field" (contract drift)',
      );
    }
  });

  it.each([
    [
      "reported corruption reason",
      { reasons: ["impulsive discontinuity"] },
      "reasons",
    ],
    [
      "phase gap above the clean-cycle limit",
      { phase_max_gap: 0.11 },
      "phase-gap",
    ],
    [
      "phase shift above the clean-cycle limit",
      { phase_shift_bins: 5 },
      "phase-shift",
    ],
    [
      "shape error above the clean-cycle limit",
      { cl_shape_error: 0.13 },
      "cl-shape-error",
    ],
    [
      "amplitude deviation above the clean-cycle limit",
      { cd_amplitude_deviation: 0.31 },
      "cd-amplitude-deviation",
    ],
  ])(
    "MUST-CATCH: rejects a selected cycle with %s",
    (_label, mutation, reason) => {
      const certificate = certifiedCertificate();
      certificate.cycles[1] = { ...certificate.cycles[1], ...mutation };

      const parsed = parseUransCycleCertificate(certificate);

      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.errors).toContain(
          `urans_cycle_certificate.cycles[1]: selected cycle violates clean-cycle policy (${reason})`,
        );
      }
    },
  );
});
