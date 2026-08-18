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
} from "../src/aperiodic-mean-certificate";
import {
  classifyPolarEvidence,
  type PolarEvidencePoint,
} from "../src/polar-fit";

const channel = {
  mean: 0.7,
  standard_deviation: 0.08,
  scale: 0.7,
  ci95_half_width: 0.014,
  ci95_fraction: 0.02,
  trend_fraction: 0.03,
  half_drift_fraction: 0.02,
  block_range_fraction: 0.2,
  effective_blocks: 8,
  amplitude_growth: 1.05,
};

const certificate = {
  reducer_version: APERIODIC_MEAN_CERTIFICATE_VERSION,
  certified: true,
  input_sha256: "b".repeat(64),
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
  cl: channel,
  cd: { ...channel, mean: 0.08, scale: 0.1 },
  cm: { ...channel, mean: -0.1, scale: 0.1, ci95_fraction: 0.06 },
} as const;

const row: PolarEvidencePoint = {
  a: 13,
  cl: 0.7,
  cd: 0.08,
  cm: -0.1,
  status: "done",
  source: "solved",
  regime: "urans",
  converged: true,
  stalled: true,
  unsteady: true,
  hasForceHistory: true,
  hasVideo: true,
  fidelity: "urans_precalc",
  frameTrack: { stationary: false, periods_retained: 1 },
  uransCycleCertificate: {
    reducer_version: "clean-cycle-v3",
    period_s: 0.003,
    phase_samples: 96,
    required_clean_cycles: 3,
    terminal_clean_cycles: 0,
    selected_cycle_start_index: null,
    certified: false,
    cadence_adjusted: false,
    cycles: [],
  },
  aperiodicMeanCertificate: certificate,
  qualityWarnings: ["URANS integration stopped by budget"],
};

describe("aperiodic statistical-mean classification", () => {
  it("accepts certified FAST evidence without claiming periodic stationarity", () => {
    expect(classifyPolarEvidence([row]).classifications[0]).toMatchObject({
      state: "accepted",
      reasons: [],
    });
  });

  it("keeps force-history and stored-video gates", () => {
    const classified = classifyPolarEvidence([
      { ...row, hasForceHistory: false, hasVideo: false },
    ]).classifications[0];
    expect(classified.state).toBe("rejected");
    expect(classified.reasons).toEqual(
      expect.arrayContaining(["missing-force-history", "missing-urans-video"]),
    );
  });

  it("fails closed on certificate drift and never bypasses FULL confirmation", () => {
    const malformed = classifyPolarEvidence([
      {
        ...row,
        aperiodicMeanCertificate: { ...certificate, certified: false },
      },
    ]).classifications[0];
    expect(malformed.reasons).toContain("invalid-aperiodic-mean-certificate");

    const full = classifyPolarEvidence([{ ...row, fidelity: "urans_full" }])
      .classifications[0];
    expect(full.state).toBe("rejected");
    expect(full.reasons).toContain("invalid-aperiodic-mean-certificate");
  });

  it("binds the published coefficients to the certified raw-window means", () => {
    const classified = classifyPolarEvidence([{ ...row, cl: row.cl! + 0.01 }])
      .classifications[0];
    expect(classified.state).toBe("rejected");
    expect(classified.reasons).toContain("aperiodic-mean-coefficient-mismatch");
  });
});
