import { describe, expect, it } from "vitest";

import {
  APERIODIC_BLOCK_COUNT,
  APERIODIC_CM_TOLERANCE_MULTIPLIER,
  APERIODIC_MAX_AMPLITUDE_GROWTH,
  APERIODIC_MAX_CI95_FRACTION,
  APERIODIC_MAX_HALF_DRIFT_FRACTION,
  APERIODIC_MAX_SOURCE_GAP_FRACTION,
  APERIODIC_MAX_TREND_FRACTION,
  APERIODIC_MEAN_CERTIFICATE_VERSION,
  APERIODIC_MIN_CONVECTIVE_TIMES,
  APERIODIC_MIN_EFFECTIVE_BLOCKS,
  APERIODIC_MIN_FIELD_FRAMES,
  APERIODIC_MIN_NONREPEATABLE_FRACTION,
  APERIODIC_MIN_PERIODICITY_CYCLES,
  APERIODIC_MIN_SOURCE_SAMPLES,
  parseAperiodicMeanCertificate,
} from "../src/aperiodic-mean-certificate";

const channel = {
  mean: 0.5,
  standard_deviation: 0.1,
  scale: 0.5,
  ci95_half_width: 0.01,
  ci95_fraction: 0.02,
  trend_fraction: 0.03,
  half_drift_fraction: 0.02,
  block_range_fraction: 0.12,
  effective_blocks: 8,
  amplitude_growth: 1.05,
};

function fixture() {
  return {
    reducer_version: APERIODIC_MEAN_CERTIFICATE_VERSION,
    certified: true,
    input_sha256: "a".repeat(64),
    source_sample_count: 2400,
    resampled_sample_count: 2400,
    field_frame_count: 120,
    observation_start_time: 0,
    observation_end_time: 0.02,
    observed_duration_s: 0.02,
    convective_times: 12,
    thresholds: {
      minimum_source_samples: APERIODIC_MIN_SOURCE_SAMPLES,
      minimum_field_frames: APERIODIC_MIN_FIELD_FRAMES,
      minimum_convective_times: APERIODIC_MIN_CONVECTIVE_TIMES,
      minimum_periodicity_cycles: APERIODIC_MIN_PERIODICITY_CYCLES,
      minimum_nonrepeatable_fraction: APERIODIC_MIN_NONREPEATABLE_FRACTION,
      maximum_source_gap_fraction: APERIODIC_MAX_SOURCE_GAP_FRACTION,
      block_count: APERIODIC_BLOCK_COUNT,
      minimum_effective_blocks: APERIODIC_MIN_EFFECTIVE_BLOCKS,
      maximum_ci95_fraction: APERIODIC_MAX_CI95_FRACTION,
      maximum_trend_fraction: APERIODIC_MAX_TREND_FRACTION,
      maximum_half_drift_fraction: APERIODIC_MAX_HALF_DRIFT_FRACTION,
      maximum_amplitude_growth: APERIODIC_MAX_AMPLITUDE_GROWTH,
      cm_tolerance_multiplier: APERIODIC_CM_TOLERANCE_MULTIPLIER,
    },
    periodicity: {
      candidate_period_s: 0.003,
      structurally_valid_cycles: 8,
      nonrepeatable_cycles: 6,
      nonrepeatable_fraction: 0.75,
    },
    cl: { ...channel },
    cd: { ...channel, mean: 0.08, scale: 0.1 },
    cm: { ...channel, mean: -0.1, scale: 0.1, ci95_fraction: 0.06 },
  };
}

describe("aperiodic mean certificate", () => {
  it("accepts the exact pinned certificate shape", () => {
    expect(parseAperiodicMeanCertificate(fixture())).toMatchObject({
      ok: true,
    });
  });

  it("rejects producer threshold drift and unexpected fields", () => {
    const value = fixture() as ReturnType<typeof fixture> & {
      inferred?: boolean;
    };
    value.thresholds.maximum_trend_fraction = 0.2;
    value.inferred = true;
    const parsed = parseAperiodicMeanCertificate(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("unexpected key"),
          expect.stringContaining("maximum_trend_fraction: expected"),
        ]),
      );
    }
  });

  it("rejects insufficient evidence and a mismatched observation window", () => {
    const value = fixture();
    value.source_sample_count = 20;
    value.field_frame_count = 2;
    value.observed_duration_s = 0.01;
    expect(parseAperiodicMeanCertificate(value)).toMatchObject({ ok: false });
  });

  it("rejects a repeatable periodic wake mislabeled as aperiodic", () => {
    const value = fixture();
    value.periodicity.nonrepeatable_cycles = 1;
    value.periodicity.nonrepeatable_fraction = 1 / 8;
    const parsed = parseAperiodicMeanCertificate(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors.join(" ")).toContain("nonrepeatable_fraction");
    }
  });

  it("rejects channel uncertainty, drift, and amplitude growth", () => {
    const value = fixture();
    value.cl.ci95_fraction = 0.5;
    value.cd.trend_fraction = 0.5;
    value.cm.amplitude_growth = 2;
    const parsed = parseAperiodicMeanCertificate(value);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("cl.ci95_fraction"),
          expect.stringContaining("cd.trend_fraction"),
          expect.stringContaining("cm.amplitude_growth"),
        ]),
      );
    }
  });
});
