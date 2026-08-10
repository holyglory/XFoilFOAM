/**
 * Proof-only all-channel RANS final-window contract.
 *
 * A certificate is emitted only when the producing engine reduced the exact
 * final raw `coefficient.dat` window and every Cl/Cd/Cm channel held within
 * the stamped tolerance.  `null` at PolarPoint level is a current engine's
 * explicit lack of proof; `undefined` remains a legacy payload omission.  Do
 * not turn either absence into a synthetic/legacy certificate.
 */

export const RANS_HOLD_CERTIFICATE_VERSION = "rans-hold-v1";

export interface RansHoldChannel {
  mean: number;
  min_value: number;
  max_value: number;
  peak_to_peak: number;
  relative_spread: number;
}

export interface RansHoldCertificate {
  reducer_version: typeof RANS_HOLD_CERTIFICATE_VERSION;
  sample_count: number;
  required_sample_count: number;
  start_iteration: number;
  end_iteration: number;
  relative_tolerance: number;
  absolute_floor: number;
  certified: true;
  cl: RansHoldChannel;
  cd: RansHoldChannel;
  cm: RansHoldChannel;
}

export type RansHoldCertificateParseResult =
  | { ok: true; value: RansHoldCertificate }
  | { ok: false; errors: string[] };

const CERTIFICATE_KEYS = [
  "reducer_version",
  "sample_count",
  "required_sample_count",
  "start_iteration",
  "end_iteration",
  "relative_tolerance",
  "absolute_floor",
  "certified",
  "cl",
  "cd",
  "cm",
] as const;

const CHANNEL_KEYS = [
  "mean",
  "min_value",
  "max_value",
  "peak_to_peak",
  "relative_spread",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function integerAtLeast(value: unknown, minimum: number): value is number {
  return finite(value) && Number.isInteger(value) && value >= minimum;
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

function approximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12 * Math.max(1, Math.abs(left), Math.abs(right));
}

function validateChannel(
  value: unknown,
  channel: string,
  absoluteFloor: unknown,
  relativeTolerance: unknown,
  errors: string[],
): void {
  const at = `rans_hold_certificate.${channel}`;
  if (!isRecord(value)) {
    errors.push(`${at}: expected object`);
    return;
  }
  exactKeys(value, CHANNEL_KEYS, at, errors);
  for (const key of CHANNEL_KEYS) {
    if (!finite(value[key])) errors.push(`${at}.${key}: expected finite number`);
  }
  if (
    finite(value.min_value) &&
    finite(value.max_value) &&
    value.max_value < value.min_value
  ) {
    errors.push(`${at}: max_value must be >= min_value`);
  }
  if (finite(value.peak_to_peak) && value.peak_to_peak < 0) {
    errors.push(`${at}.peak_to_peak: expected non-negative number`);
  }
  if (finite(value.relative_spread) && value.relative_spread < 0) {
    errors.push(`${at}.relative_spread: expected non-negative number`);
  }
  if (
    finite(value.min_value) &&
    finite(value.max_value) &&
    finite(value.peak_to_peak) &&
    !approximatelyEqual(value.peak_to_peak, value.max_value - value.min_value)
  ) {
    errors.push(`${at}.peak_to_peak: must equal max_value - min_value`);
  }
  if (
    finite(value.mean) &&
    finite(value.peak_to_peak) &&
    finite(value.relative_spread) &&
    finite(absoluteFloor) &&
    finite(relativeTolerance)
  ) {
    const expectedSpread = value.peak_to_peak / (Math.abs(value.mean) + absoluteFloor);
    if (!approximatelyEqual(value.relative_spread, expectedSpread)) {
      errors.push(`${at}.relative_spread: does not match the stamped final-window spread`);
    }
    if (value.relative_spread > relativeTolerance) {
      errors.push(`${at}.relative_spread: exceeds the stamped tolerance`);
    }
  }
}

/**
 * Strict parser for a proof-bearing current RANS payload.  Callers handle
 * `undefined` (legacy omission) and `null` (current explicit lack of proof)
 * before calling this function; a malformed object fails closed.
 */
export function parseRansHoldCertificate(
  value: unknown,
): RansHoldCertificateParseResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [
        `rans_hold_certificate: expected object, got ${value === null ? "null" : typeof value}`,
      ],
    };
  }
  exactKeys(value, CERTIFICATE_KEYS, "rans_hold_certificate", errors);
  if (value.reducer_version !== RANS_HOLD_CERTIFICATE_VERSION) {
    errors.push(
      `rans_hold_certificate.reducer_version: expected ${RANS_HOLD_CERTIFICATE_VERSION}`,
    );
  }
  if (!integerAtLeast(value.sample_count, 1)) {
    errors.push("rans_hold_certificate.sample_count: expected positive integer");
  }
  if (!integerAtLeast(value.required_sample_count, 1)) {
    errors.push("rans_hold_certificate.required_sample_count: expected positive integer");
  }
  if (
    integerAtLeast(value.sample_count, 1) &&
    integerAtLeast(value.required_sample_count, 1) &&
    value.sample_count < value.required_sample_count
  ) {
    errors.push("rans_hold_certificate.sample_count: below required_sample_count");
  }
  for (const key of ["start_iteration", "end_iteration"] as const) {
    if (!integerAtLeast(value[key], 0)) {
      errors.push(`rans_hold_certificate.${key}: expected non-negative integer`);
    }
  }
  if (
    integerAtLeast(value.start_iteration, 0) &&
    integerAtLeast(value.end_iteration, 0) &&
    value.end_iteration < value.start_iteration
  ) {
    errors.push("rans_hold_certificate: iteration window is reversed");
  }
  if (
    integerAtLeast(value.sample_count, 1) &&
    integerAtLeast(value.start_iteration, 0) &&
    integerAtLeast(value.end_iteration, 0) &&
    value.end_iteration - value.start_iteration + 1 !== value.sample_count
  ) {
    errors.push("rans_hold_certificate: iteration window length must equal sample_count");
  }
  for (const key of ["relative_tolerance", "absolute_floor"] as const) {
    if (!(finite(value[key]) && value[key] > 0)) {
      errors.push(`rans_hold_certificate.${key}: expected positive finite number`);
    }
  }
  if (value.certified !== true) {
    errors.push("rans_hold_certificate.certified: expected true for a proof-bearing certificate");
  }
  for (const channel of ["cl", "cd", "cm"] as const) {
    validateChannel(
      value[channel],
      channel,
      value.absolute_floor,
      value.relative_tolerance,
      errors,
    );
  }
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as RansHoldCertificate };
}
