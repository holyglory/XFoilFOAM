/** Strict cross-runtime parser for statistically stationary aperiodic URANS. */

export const APERIODIC_MEAN_CERTIFICATE_VERSION = "aperiodic-mean-v1";
export const APERIODIC_MIN_SOURCE_SAMPLES = 400;
export const APERIODIC_MIN_FIELD_FRAMES = 40;
export const APERIODIC_MIN_CONVECTIVE_TIMES = 4;
export const APERIODIC_MIN_PERIODICITY_CYCLES = 6;
export const APERIODIC_MIN_NONREPEATABLE_FRACTION = 0.5;
export const APERIODIC_MAX_SOURCE_GAP_FRACTION = 0.1;
export const APERIODIC_BLOCK_COUNT = 10;
export const APERIODIC_MIN_EFFECTIVE_BLOCKS = 3;
export const APERIODIC_MAX_CI95_FRACTION = 0.04;
export const APERIODIC_MAX_TREND_FRACTION = 0.06;
export const APERIODIC_MAX_HALF_DRIFT_FRACTION = 0.06;
export const APERIODIC_MAX_AMPLITUDE_GROWTH = 1.35;
export const APERIODIC_CM_TOLERANCE_MULTIPLIER = 2;

export interface AperiodicMeanChannelCertificate {
  mean: number;
  standard_deviation: number;
  scale: number;
  ci95_half_width: number;
  ci95_fraction: number;
  trend_fraction: number;
  half_drift_fraction: number;
  block_range_fraction: number;
  effective_blocks: number;
  amplitude_growth: number;
}

export interface AperiodicMeanThresholds {
  minimum_source_samples: number;
  minimum_field_frames: number;
  minimum_convective_times: number;
  minimum_periodicity_cycles: number;
  minimum_nonrepeatable_fraction: number;
  maximum_source_gap_fraction: number;
  block_count: number;
  minimum_effective_blocks: number;
  maximum_ci95_fraction: number;
  maximum_trend_fraction: number;
  maximum_half_drift_fraction: number;
  maximum_amplitude_growth: number;
  cm_tolerance_multiplier: number;
}

export interface AperiodicMeanPeriodicityAssessment {
  candidate_period_s: number;
  structurally_valid_cycles: number;
  nonrepeatable_cycles: number;
  nonrepeatable_fraction: number;
}

export interface AperiodicMeanCertificate {
  reducer_version: typeof APERIODIC_MEAN_CERTIFICATE_VERSION;
  certified: true;
  input_sha256: string;
  source_sample_count: number;
  resampled_sample_count: number;
  field_frame_count: number;
  observation_start_time: number;
  observation_end_time: number;
  observed_duration_s: number;
  convective_times: number;
  thresholds: AperiodicMeanThresholds;
  periodicity: AperiodicMeanPeriodicityAssessment;
  cl: AperiodicMeanChannelCertificate;
  cd: AperiodicMeanChannelCertificate;
  cm: AperiodicMeanChannelCertificate;
}

export type AperiodicMeanCertificateParseResult =
  | { ok: true; value: AperiodicMeanCertificate }
  | { ok: false; errors: string[] };

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ROOT_KEYS = [
  "reducer_version",
  "certified",
  "input_sha256",
  "source_sample_count",
  "resampled_sample_count",
  "field_frame_count",
  "observation_start_time",
  "observation_end_time",
  "observed_duration_s",
  "convective_times",
  "thresholds",
  "periodicity",
  "cl",
  "cd",
  "cm",
] as const;
const THRESHOLD_KEYS = [
  "minimum_source_samples",
  "minimum_field_frames",
  "minimum_convective_times",
  "minimum_periodicity_cycles",
  "minimum_nonrepeatable_fraction",
  "maximum_source_gap_fraction",
  "block_count",
  "minimum_effective_blocks",
  "maximum_ci95_fraction",
  "maximum_trend_fraction",
  "maximum_half_drift_fraction",
  "maximum_amplitude_growth",
  "cm_tolerance_multiplier",
] as const;
const PERIODICITY_KEYS = [
  "candidate_period_s",
  "structurally_valid_cycles",
  "nonrepeatable_cycles",
  "nonrepeatable_fraction",
] as const;
const CHANNEL_KEYS = [
  "mean",
  "standard_deviation",
  "scale",
  "ci95_half_width",
  "ci95_fraction",
  "trend_fraction",
  "half_drift_fraction",
  "block_range_fraction",
  "effective_blocks",
  "amplitude_growth",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  at: string,
  errors: string[],
): void {
  for (const key of keys)
    if (!(key in value)) errors.push(`${at}: missing key "${key}"`);
  for (const key of Object.keys(value))
    if (!keys.includes(key)) errors.push(`${at}: unexpected key "${key}"`);
}

function exactNumber(
  value: Record<string, unknown>,
  key: string,
  expected: number,
  at: string,
  errors: string[],
): void {
  if (value[key] !== expected)
    errors.push(`${at}.${key}: expected ${expected}`);
}

function channel(
  value: unknown,
  at: string,
  errors: string[],
): AperiodicMeanChannelCertificate | null {
  if (!record(value)) {
    errors.push(`${at}: expected object`);
    return null;
  }
  exactKeys(value, CHANNEL_KEYS, at, errors);
  for (const key of CHANNEL_KEYS) {
    if (!finite(value[key]))
      errors.push(`${at}.${key}: expected finite number`);
  }
  for (const key of [
    "standard_deviation",
    "ci95_half_width",
    "ci95_fraction",
    "trend_fraction",
    "half_drift_fraction",
    "block_range_fraction",
    "amplitude_growth",
  ]) {
    if (finite(value[key]) && value[key] < 0)
      errors.push(`${at}.${key}: expected non-negative number`);
  }
  if (finite(value.scale) && value.scale <= 0)
    errors.push(`${at}.scale: expected positive number`);
  if (
    finite(value.effective_blocks) &&
    value.effective_blocks < APERIODIC_MIN_EFFECTIVE_BLOCKS
  )
    errors.push(`${at}.effective_blocks: below certified minimum`);
  return value as unknown as AperiodicMeanChannelCertificate;
}

export function parseAperiodicMeanCertificate(
  value: unknown,
): AperiodicMeanCertificateParseResult {
  const errors: string[] = [];
  if (!record(value))
    return {
      ok: false,
      errors: ["aperiodic_mean_certificate: expected object"],
    };
  exactKeys(value, ROOT_KEYS, "aperiodic_mean_certificate", errors);
  if (value.reducer_version !== APERIODIC_MEAN_CERTIFICATE_VERSION)
    errors.push(
      `aperiodic_mean_certificate.reducer_version: expected ${APERIODIC_MEAN_CERTIFICATE_VERSION}`,
    );
  if (value.certified !== true)
    errors.push("aperiodic_mean_certificate.certified: expected true");
  if (
    typeof value.input_sha256 !== "string" ||
    !SHA256_HEX.test(value.input_sha256)
  )
    errors.push(
      "aperiodic_mean_certificate.input_sha256: expected SHA-256 hex",
    );
  for (const key of [
    "source_sample_count",
    "resampled_sample_count",
    "field_frame_count",
    "observation_start_time",
    "observation_end_time",
    "observed_duration_s",
    "convective_times",
  ]) {
    if (!finite(value[key]))
      errors.push(`aperiodic_mean_certificate.${key}: expected finite number`);
  }
  if (
    !Number.isInteger(value.source_sample_count) ||
    Number(value.source_sample_count) < APERIODIC_MIN_SOURCE_SAMPLES
  )
    errors.push(
      "aperiodic_mean_certificate.source_sample_count: below minimum",
    );
  if (
    !Number.isInteger(value.resampled_sample_count) ||
    Number(value.resampled_sample_count) < 1
  )
    errors.push(
      "aperiodic_mean_certificate.resampled_sample_count: expected positive integer",
    );
  if (
    !Number.isInteger(value.field_frame_count) ||
    Number(value.field_frame_count) < APERIODIC_MIN_FIELD_FRAMES
  )
    errors.push("aperiodic_mean_certificate.field_frame_count: below minimum");
  if (
    finite(value.convective_times) &&
    value.convective_times < APERIODIC_MIN_CONVECTIVE_TIMES
  )
    errors.push("aperiodic_mean_certificate.convective_times: below minimum");
  if (
    finite(value.observation_start_time) &&
    finite(value.observation_end_time) &&
    finite(value.observed_duration_s)
  ) {
    const span = value.observation_end_time - value.observation_start_time;
    if (span <= 0)
      errors.push("aperiodic_mean_certificate: reversed observation window");
    if (
      Math.abs(span - value.observed_duration_s) >
      1e-10 * Math.max(1, Math.abs(span))
    )
      errors.push("aperiodic_mean_certificate: duration mismatch");
  }
  if (!record(value.thresholds)) {
    errors.push("aperiodic_mean_certificate.thresholds: expected object");
  } else {
    exactKeys(
      value.thresholds,
      THRESHOLD_KEYS,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "minimum_source_samples",
      APERIODIC_MIN_SOURCE_SAMPLES,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "minimum_field_frames",
      APERIODIC_MIN_FIELD_FRAMES,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "minimum_convective_times",
      APERIODIC_MIN_CONVECTIVE_TIMES,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "minimum_periodicity_cycles",
      APERIODIC_MIN_PERIODICITY_CYCLES,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "minimum_nonrepeatable_fraction",
      APERIODIC_MIN_NONREPEATABLE_FRACTION,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "maximum_source_gap_fraction",
      APERIODIC_MAX_SOURCE_GAP_FRACTION,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "block_count",
      APERIODIC_BLOCK_COUNT,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "minimum_effective_blocks",
      APERIODIC_MIN_EFFECTIVE_BLOCKS,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "maximum_ci95_fraction",
      APERIODIC_MAX_CI95_FRACTION,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "maximum_trend_fraction",
      APERIODIC_MAX_TREND_FRACTION,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "maximum_half_drift_fraction",
      APERIODIC_MAX_HALF_DRIFT_FRACTION,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "maximum_amplitude_growth",
      APERIODIC_MAX_AMPLITUDE_GROWTH,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
    exactNumber(
      value.thresholds,
      "cm_tolerance_multiplier",
      APERIODIC_CM_TOLERANCE_MULTIPLIER,
      "aperiodic_mean_certificate.thresholds",
      errors,
    );
  }
  if (!record(value.periodicity)) {
    errors.push("aperiodic_mean_certificate.periodicity: expected object");
  } else {
    exactKeys(
      value.periodicity,
      PERIODICITY_KEYS,
      "aperiodic_mean_certificate.periodicity",
      errors,
    );
    for (const key of PERIODICITY_KEYS) {
      if (!finite(value.periodicity[key])) {
        errors.push(
          `aperiodic_mean_certificate.periodicity.${key}: expected finite number`,
        );
      }
    }
    const observed = value.periodicity.structurally_valid_cycles;
    const nonrepeatable = value.periodicity.nonrepeatable_cycles;
    const fraction = value.periodicity.nonrepeatable_fraction;
    if (
      !Number.isInteger(observed) ||
      Number(observed) < APERIODIC_MIN_PERIODICITY_CYCLES
    ) {
      errors.push(
        "aperiodic_mean_certificate.periodicity.structurally_valid_cycles: below minimum",
      );
    }
    if (
      !Number.isInteger(nonrepeatable) ||
      Number(nonrepeatable) < 1 ||
      (finite(observed) && Number(nonrepeatable) > observed)
    ) {
      errors.push(
        "aperiodic_mean_certificate.periodicity.nonrepeatable_cycles: invalid count",
      );
    }
    if (
      finite(fraction) &&
      (fraction < APERIODIC_MIN_NONREPEATABLE_FRACTION || fraction > 1)
    ) {
      errors.push(
        "aperiodic_mean_certificate.periodicity.nonrepeatable_fraction: outside certified range",
      );
    }
    if (
      finite(observed) &&
      finite(nonrepeatable) &&
      finite(fraction) &&
      Math.abs(nonrepeatable / observed - fraction) > 1e-12
    ) {
      errors.push(
        "aperiodic_mean_certificate.periodicity: inconsistent nonrepeatable fraction",
      );
    }
    if (
      finite(value.periodicity.candidate_period_s) &&
      value.periodicity.candidate_period_s <= 0
    ) {
      errors.push(
        "aperiodic_mean_certificate.periodicity.candidate_period_s: expected positive number",
      );
    }
  }
  const cl = channel(value.cl, "aperiodic_mean_certificate.cl", errors);
  const cd = channel(value.cd, "aperiodic_mean_certificate.cd", errors);
  const cm = channel(value.cm, "aperiodic_mean_certificate.cm", errors);
  for (const [name, item, multiplier] of [
    ["cl", cl, 1],
    ["cd", cd, 1],
    ["cm", cm, APERIODIC_CM_TOLERANCE_MULTIPLIER],
  ] as const) {
    if (!item) continue;
    if (item.ci95_fraction > APERIODIC_MAX_CI95_FRACTION * multiplier)
      errors.push(
        `aperiodic_mean_certificate.${name}.ci95_fraction: exceeds certified maximum`,
      );
    if (item.trend_fraction > APERIODIC_MAX_TREND_FRACTION * multiplier)
      errors.push(
        `aperiodic_mean_certificate.${name}.trend_fraction: exceeds certified maximum`,
      );
    if (
      item.half_drift_fraction >
      APERIODIC_MAX_HALF_DRIFT_FRACTION * multiplier
    )
      errors.push(
        `aperiodic_mean_certificate.${name}.half_drift_fraction: exceeds certified maximum`,
      );
    if (item.amplitude_growth > APERIODIC_MAX_AMPLITUDE_GROWTH)
      errors.push(
        `aperiodic_mean_certificate.${name}.amplitude_growth: exceeds certified maximum`,
      );
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: value as unknown as AperiodicMeanCertificate };
}
