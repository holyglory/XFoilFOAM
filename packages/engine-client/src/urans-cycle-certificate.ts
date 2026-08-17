/**
 * Versioned clean-cycle certification carried beside the frozen `frame_track`
 * contract.  `frame_track` remains intentionally exact and small for media;
 * this payload records the scientific reducer's full per-cycle verdict so the
 * control plane can persist an append-only interpretation ledger.
 */

import { selectedCleanCycleQualityReasons } from "@aerodb/core";

export const URANS_CLEAN_CYCLE_CERTIFICATE_VERSION = "clean-cycle-v3";

export const URANS_CYCLE_DISPOSITIONS = [
  "selected",
  "startup",
  "hard_corrupt",
  "settling_outlier",
  "cadence_unresolved",
  "numerically_noisy",
  "insufficient_frames",
] as const;

export type UransCycleDisposition = (typeof URANS_CYCLE_DISPOSITIONS)[number];

/**
 * A null diagnostic is an explicit fact that the reducer could not measure
 * that cycle. It is permitted only on a hard-corrupt, non-selected cycle so
 * legacy JSON (which could not represent the producer's old infinity
 * sentinel) stays readable without becoming publishable science.
 */
type UransCycleMetric = number | null;

export interface UransCycleCertificateCycle {
  index: number;
  t_start: number;
  t_end: number;
  coefficient_samples: number;
  field_frames: number;
  phase_max_gap: number;
  phase_shift_bins: number;
  cl_mean: UransCycleMetric;
  cd_mean: UransCycleMetric;
  cm_mean: UransCycleMetric;
  cl_shape_error: UransCycleMetric;
  cd_shape_error: UransCycleMetric;
  cm_shape_error: UransCycleMetric;
  cl_amplitude_deviation: UransCycleMetric;
  cd_amplitude_deviation: UransCycleMetric;
  cm_amplitude_deviation: UransCycleMetric;
  cl_high_frequency: UransCycleMetric;
  cd_high_frequency: UransCycleMetric;
  cm_high_frequency: UransCycleMetric;
  disposition: UransCycleDisposition;
  reasons: string[];
}

export interface UransCycleCertificate {
  reducer_version: string;
  period_s: number;
  phase_samples: number;
  required_clean_cycles: number;
  terminal_clean_cycles: number;
  selected_cycle_start_index: number | null;
  certified: boolean;
  cadence_adjusted: boolean;
  cycles: UransCycleCertificateCycle[];
}

export type UransCycleCertificateParseResult =
  | { ok: true; value: UransCycleCertificate }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function integerAtLeast(value: unknown, minimum: number): value is number {
  return finite(value) && Number.isInteger(value) && value >= minimum;
}

const CERTIFICATE_KEYS = [
  "reducer_version",
  "period_s",
  "phase_samples",
  "required_clean_cycles",
  "terminal_clean_cycles",
  "selected_cycle_start_index",
  "certified",
  "cadence_adjusted",
  "cycles",
] as const;

const CYCLE_KEYS = [
  "index",
  "t_start",
  "t_end",
  "coefficient_samples",
  "field_frames",
  "phase_max_gap",
  "phase_shift_bins",
  "cl_mean",
  "cd_mean",
  "cm_mean",
  "cl_shape_error",
  "cd_shape_error",
  "cm_shape_error",
  "cl_amplitude_deviation",
  "cd_amplitude_deviation",
  "cm_amplitude_deviation",
  "cl_high_frequency",
  "cd_high_frequency",
  "cm_high_frequency",
  "disposition",
  "reasons",
] as const;

const CYCLE_DIAGNOSTIC_KEYS = [
  "cl_mean",
  "cd_mean",
  "cm_mean",
  "cl_shape_error",
  "cd_shape_error",
  "cm_shape_error",
  "cl_amplitude_deviation",
  "cd_amplitude_deviation",
  "cm_amplitude_deviation",
  "cl_high_frequency",
  "cd_high_frequency",
  "cm_high_frequency",
] as const;

function unavailableDiagnosticKeys(value: Record<string, unknown>): string[] {
  return CYCLE_DIAGNOSTIC_KEYS.filter((key) => value[key] === null);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  at: string,
  errors: string[],
): void {
  for (const key of expected) {
    if (!(key in value)) errors.push(`${at}: missing key \"${key}\"`);
  }
  for (const key of Object.keys(value)) {
    if (!expected.includes(key))
      errors.push(`${at}: unexpected key \"${key}\" (contract drift)`);
  }
}

/**
 * Strict structural parser.  A malformed new certificate must fail closed at
 * interpretation time; absence remains valid legacy evidence and is handled
 * by the caller rather than this parser.
 */
export function parseUransCycleCertificate(
  value: unknown,
): UransCycleCertificateParseResult {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return {
      ok: false,
      errors: [
        `urans_cycle_certificate: expected object, got ${
          value === null ? "null" : typeof value
        }`,
      ],
    };
  }
  exactKeys(value, CERTIFICATE_KEYS, "urans_cycle_certificate", errors);
  if (
    !(typeof value.reducer_version === "string" && value.reducer_version.trim())
  ) {
    errors.push(
      "urans_cycle_certificate.reducer_version: expected non-empty string",
    );
  }
  if (!finite(value.period_s) || value.period_s <= 0)
    errors.push(
      "urans_cycle_certificate.period_s: expected positive finite number",
    );
  if (!integerAtLeast(value.phase_samples, 20) || value.phase_samples > 512)
    errors.push(
      "urans_cycle_certificate.phase_samples: expected integer in [20, 512]",
    );
  if (!integerAtLeast(value.required_clean_cycles, 1))
    errors.push(
      "urans_cycle_certificate.required_clean_cycles: expected positive integer",
    );
  if (!integerAtLeast(value.terminal_clean_cycles, 0))
    errors.push(
      "urans_cycle_certificate.terminal_clean_cycles: expected non-negative integer",
    );
  if (
    value.selected_cycle_start_index !== null &&
    !integerAtLeast(value.selected_cycle_start_index, 0)
  ) {
    errors.push(
      "urans_cycle_certificate.selected_cycle_start_index: expected non-negative integer or null",
    );
  }
  if (typeof value.certified !== "boolean")
    errors.push("urans_cycle_certificate.certified: expected boolean");
  if (typeof value.cadence_adjusted !== "boolean")
    errors.push("urans_cycle_certificate.cadence_adjusted: expected boolean");
  if (!Array.isArray(value.cycles)) {
    errors.push("urans_cycle_certificate.cycles: expected array");
  } else {
    let previousEnd = -Infinity;
    let previousCycleIndex: number | null = null;
    const selectedIndexes = new Set<number>();
    const cycleIndexes: number[] = [];
    value.cycles.forEach((entry, index) => {
      const at = `urans_cycle_certificate.cycles[${index}]`;
      if (!isRecord(entry)) {
        errors.push(`${at}: expected object`);
        return;
      }
      exactKeys(entry, CYCLE_KEYS, at, errors);
      const nonnegativeIntegerKeys = [
        "index",
        "coefficient_samples",
        "field_frames",
        "phase_shift_bins",
      ] as const;
      for (const key of nonnegativeIntegerKeys) {
        if (!integerAtLeast(entry[key], 0))
          errors.push(`${at}.${key}: expected non-negative integer`);
      }
      if (integerAtLeast(entry.index, 0)) {
        if (
          previousCycleIndex !== null &&
          entry.index !== previousCycleIndex + 1
        ) {
          errors.push(
            `${at}.index: cycles must have contiguous chronological indexes`,
          );
        }
        previousCycleIndex = entry.index;
        cycleIndexes.push(entry.index);
      }
      for (const key of ["t_start", "t_end"] as const) {
        if (!finite(entry[key]) || entry[key] < 0)
          errors.push(`${at}.${key}: expected non-negative finite number`);
      }
      if (
        finite(entry.t_start) &&
        finite(entry.t_end) &&
        entry.t_end <= entry.t_start
      )
        errors.push(`${at}: t_end must be greater than t_start`);
      if (finite(entry.t_start) && entry.t_start + 1e-12 < previousEnd) {
        errors.push(`${at}: cycles must be chronological and non-overlapping`);
      }
      if (finite(entry.t_end)) previousEnd = entry.t_end;
      if (!finite(entry.phase_max_gap))
        errors.push(`${at}.phase_max_gap: expected finite number`);
      const unavailableMetrics = unavailableDiagnosticKeys(entry);
      for (const key of CYCLE_DIAGNOSTIC_KEYS) {
        if (entry[key] !== null && !finite(entry[key]))
          errors.push(`${at}.${key}: expected finite number or null`);
      }
      if (
        unavailableMetrics.length > 0 &&
        entry.disposition !== "hard_corrupt"
      ) {
        errors.push(
          `${at}: unavailable cycle metrics require hard_corrupt disposition`,
        );
      }
      if (
        finite(entry.phase_max_gap) &&
        (entry.phase_max_gap < 0 || entry.phase_max_gap > 1)
      ) {
        errors.push(`${at}.phase_max_gap: expected number in [0, 1]`);
      }
      for (const key of [
        "cl_shape_error",
        "cd_shape_error",
        "cm_shape_error",
        "cl_amplitude_deviation",
        "cd_amplitude_deviation",
        "cm_amplitude_deviation",
        "cl_high_frequency",
        "cd_high_frequency",
        "cm_high_frequency",
      ] as const) {
        if (finite(entry[key]) && entry[key] < 0)
          errors.push(`${at}.${key}: expected non-negative number`);
      }
      if (
        typeof entry.disposition !== "string" ||
        !URANS_CYCLE_DISPOSITIONS.includes(
          entry.disposition as UransCycleDisposition,
        )
      ) {
        errors.push(`${at}.disposition: unexpected value`);
      }
      if (
        !Array.isArray(entry.reasons) ||
        entry.reasons.some((reason) => typeof reason !== "string")
      ) {
        errors.push(`${at}.reasons: expected string array`);
      }
      if (entry.disposition === "selected" && integerAtLeast(entry.index, 0)) {
        selectedIndexes.add(entry.index);
        if (unavailableMetrics.length > 0) {
          errors.push(
            `${at}: selected cycle has unavailable metrics (${unavailableMetrics.join(", ")})`,
          );
          return;
        }
        // A selected suffix is publishable science, not merely a topology
        // label. Refuse a remote/mixed-version payload that calls a cycle
        // selected while carrying its own corruption metrics or reasons.
        for (const reason of selectedCleanCycleQualityReasons({
          coefficientSamples: entry.coefficient_samples,
          fieldFrames: entry.field_frames,
          phaseMaxGap: entry.phase_max_gap,
          phaseShiftBins: entry.phase_shift_bins,
          cl: {
            shapeError: entry.cl_shape_error,
            amplitudeDeviation: entry.cl_amplitude_deviation,
            highFrequency: entry.cl_high_frequency,
          },
          cd: {
            shapeError: entry.cd_shape_error,
            amplitudeDeviation: entry.cd_amplitude_deviation,
            highFrequency: entry.cd_high_frequency,
          },
          cm: {
            shapeError: entry.cm_shape_error,
            amplitudeDeviation: entry.cm_amplitude_deviation,
            highFrequency: entry.cm_high_frequency,
          },
          reasons: entry.reasons,
        })) {
          errors.push(
            `${at}: selected cycle violates clean-cycle policy (${reason})`,
          );
        }
      }
    });
    if (value.certified === true) {
      if (selectedIndexes.size < (value.required_clean_cycles as number)) {
        errors.push(
          "urans_cycle_certificate: certified result has too few selected cycles",
        );
      }
      if (
        !integerAtLeast(value.selected_cycle_start_index, 0) ||
        !selectedIndexes.has(value.selected_cycle_start_index)
      ) {
        errors.push(
          "urans_cycle_certificate: certified result has invalid selected_cycle_start_index",
        );
      }
      if (
        (value.terminal_clean_cycles as number) <
        (value.required_clean_cycles as number)
      ) {
        errors.push(
          "urans_cycle_certificate: certified result has insufficient terminal_clean_cycles",
        );
      }
      const selectedStart = value.selected_cycle_start_index;
      if (integerAtLeast(selectedStart, 0)) {
        const startPosition = cycleIndexes.indexOf(selectedStart);
        if (startPosition === -1) {
          errors.push(
            "urans_cycle_certificate: certified result selected suffix is not present in cycles",
          );
        } else {
          const terminalIndexes = cycleIndexes.slice(startPosition);
          const selectedAreTerminalSuffix =
            terminalIndexes.length > 0 &&
            terminalIndexes.length ===
              (value.required_clean_cycles as number) &&
            terminalIndexes.every((cycleIndex) =>
              selectedIndexes.has(cycleIndex),
            ) &&
            [...selectedIndexes].every(
              (cycleIndex) => cycleIndex >= selectedStart,
            );
          if (!selectedAreTerminalSuffix) {
            errors.push(
              "urans_cycle_certificate: selected cycles must be the exact contiguous terminal publication suffix",
            );
          }
          if (
            selectedIndexes.size !== (value.required_clean_cycles as number)
          ) {
            errors.push(
              "urans_cycle_certificate: selected terminal suffix length must equal required_clean_cycles",
            );
          }
          if ((value.terminal_clean_cycles as number) > cycleIndexes.length) {
            errors.push(
              "urans_cycle_certificate: terminal_clean_cycles exceeds the audited cycle count",
            );
          }
        }
      }
    }
  }
  return errors.length
    ? { ok: false, errors }
    : { ok: true, value: value as unknown as UransCycleCertificate };
}
