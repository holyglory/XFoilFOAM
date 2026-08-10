/**
 * Proof-bearing observation contract for a no-shedding URANS result.
 *
 * A flat transient is physically steady only after the engine has observed a
 * real slow-wake horizon.  This type is deliberately separate from the
 * periodic clean-cycle certificate: it records the duration, force statistics,
 * and amplitude threshold that make the absence of a period meaningful.
 */

export const NO_SHEDDING_CERTIFICATE_VERSION = "no-shedding-v1";
/** A physical no-shedding proof needs a dense raw interval and dense witness. */
export const NO_SHEDDING_MIN_SAMPLE_COUNT = 20;

export interface NoSheddingCertificate {
  reducer_version: typeof NO_SHEDDING_CERTIFICATE_VERSION;
  certified: true;
  required_observation_s: number;
  observation_start_time: number;
  observation_end_time: number;
  observed_observation_s: number;
  source_sample_count: number;
  transport_sample_count: number;
  relative_tolerance: number;
  absolute_floor: number;
  cl_mean: number;
  cd_mean: number;
  cm_mean: number;
  cl_rms: number;
  cd_rms: number;
  cm_rms: number;
  /** Time-weighted bounded-force-history witness; never raw-source stats. */
  transport_cl_mean: number;
  transport_cd_mean: number;
  transport_cm_mean: number;
  transport_cl_rms: number;
  transport_cd_rms: number;
  transport_cm_rms: number;
}

export type NoSheddingCertificateParseResult =
  | { ok: true; value: NoSheddingCertificate }
  | { ok: false; errors: string[] };

const CERTIFICATE_KEYS = [
  "reducer_version",
  "certified",
  "required_observation_s",
  "observation_start_time",
  "observation_end_time",
  "observed_observation_s",
  "source_sample_count",
  "transport_sample_count",
  "relative_tolerance",
  "absolute_floor",
  "cl_mean",
  "cd_mean",
  "cm_mean",
  "cl_rms",
  "cd_rms",
  "cm_rms",
  "transport_cl_mean",
  "transport_cd_mean",
  "transport_cm_mean",
  "transport_cl_rms",
  "transport_cd_rms",
  "transport_cm_rms",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positiveFinite(value: unknown): value is number {
  return finite(value) && value > 0;
}

function nonnegativeInteger(value: unknown, minimum = 0): value is number {
  return finite(value) && Number.isInteger(value) && value >= minimum;
}

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <=
    1e-10 * Math.max(1, Math.abs(left), Math.abs(right));
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  at: string,
  errors: string[],
): void {
  for (const key of expected) {
    if (!(key in value)) errors.push(`${at}: missing key "${key}"`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key)) {
      errors.push(`${at}: unexpected key "${key}" (contract drift)`);
    }
  }
}

/**
 * Strict parser for a current engine's physical no-shedding proof.  Callers
 * must separately distinguish `undefined` legacy omission from an explicit
 * `null` current-engine lack of proof.
 */
export function parseNoSheddingCertificate(
  value: unknown,
): NoSheddingCertificateParseResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [
        `no_shedding_certificate: expected object, got ${
          value === null ? "null" : typeof value
        }`,
      ],
    };
  }
  exactKeys(value, CERTIFICATE_KEYS, "no_shedding_certificate", errors);
  if (value.reducer_version !== NO_SHEDDING_CERTIFICATE_VERSION) {
    errors.push(
      `no_shedding_certificate.reducer_version: expected ${NO_SHEDDING_CERTIFICATE_VERSION}`,
    );
  }
  if (value.certified !== true) {
    errors.push("no_shedding_certificate.certified: expected true");
  }
  for (const key of [
    "required_observation_s",
    "observed_observation_s",
    "relative_tolerance",
    "absolute_floor",
  ] as const) {
    if (!positiveFinite(value[key])) {
      errors.push(`no_shedding_certificate.${key}: expected positive finite number`);
    }
  }
  for (const key of [
    "observation_start_time",
    "observation_end_time",
  ] as const) {
    if (!finite(value[key]) || value[key] < 0) {
      errors.push(`no_shedding_certificate.${key}: expected non-negative finite number`);
    }
  }
  for (const key of [
    "source_sample_count",
    "transport_sample_count",
  ] as const) {
    if (!nonnegativeInteger(value[key], NO_SHEDDING_MIN_SAMPLE_COUNT)) {
      errors.push(
        `no_shedding_certificate.${key}: expected integer >= ${NO_SHEDDING_MIN_SAMPLE_COUNT}`,
      );
    }
  }
  for (const key of [
    "cl_mean",
    "cd_mean",
    "cm_mean",
    "cl_rms",
    "cd_rms",
    "cm_rms",
    "transport_cl_mean",
    "transport_cd_mean",
    "transport_cm_mean",
    "transport_cl_rms",
    "transport_cd_rms",
    "transport_cm_rms",
  ] as const) {
    if (!finite(value[key])) {
      errors.push(`no_shedding_certificate.${key}: expected finite number`);
    }
  }
  for (const key of [
    "cl_rms",
    "cd_rms",
    "cm_rms",
    "transport_cl_rms",
    "transport_cd_rms",
    "transport_cm_rms",
  ] as const) {
    if (finite(value[key]) && value[key] < 0) {
      errors.push(`no_shedding_certificate.${key}: expected non-negative number`);
    }
  }
  if (
    finite(value.observation_start_time) &&
    finite(value.observation_end_time) &&
    value.observation_end_time <= value.observation_start_time
  ) {
    errors.push("no_shedding_certificate: observation time window is reversed");
  }
  if (
    finite(value.observation_start_time) &&
    finite(value.observation_end_time) &&
    positiveFinite(value.observed_observation_s) &&
    !approximatelyEqual(
      value.observed_observation_s,
      value.observation_end_time - value.observation_start_time,
    )
  ) {
    errors.push(
      "no_shedding_certificate.observed_observation_s: does not match the observation time window",
    );
  }
  if (
    positiveFinite(value.observed_observation_s) &&
    positiveFinite(value.required_observation_s) &&
    value.observed_observation_s +
      1e-10 * Math.max(1, value.observed_observation_s) <
      value.required_observation_s
  ) {
    errors.push(
      "no_shedding_certificate: observation is below the physical slow-shedding horizon",
    );
  }
  if (
    nonnegativeInteger(value.source_sample_count, NO_SHEDDING_MIN_SAMPLE_COUNT) &&
    nonnegativeInteger(value.transport_sample_count, NO_SHEDDING_MIN_SAMPLE_COUNT) &&
    value.source_sample_count < value.transport_sample_count
  ) {
    errors.push(
      "no_shedding_certificate: source sample count is below transported history count",
    );
  }
  if (
    positiveFinite(value.relative_tolerance) &&
    positiveFinite(value.absolute_floor)
  ) {
    for (const [channel, mean, rms] of [
      ["cl", value.cl_mean, value.cl_rms],
      ["cd", value.cd_mean, value.cd_rms],
      ["cm", value.cm_mean, value.cm_rms],
    ] as const) {
      if (!finite(mean) || !finite(rms)) continue;
      const threshold = Math.max(
        value.relative_tolerance * Math.abs(mean),
        value.absolute_floor,
      );
      if (Math.abs(rms) > threshold + 1e-12 * Math.max(1, threshold)) {
        errors.push(
          `no_shedding_certificate.${channel}_rms: exceeds its stamped amplitude tolerance`,
        );
      }
    }
  }
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as NoSheddingCertificate };
}
