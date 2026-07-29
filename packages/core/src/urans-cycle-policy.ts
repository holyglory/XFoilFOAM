/**
 * Shared semantic clean-cycle policy.
 *
 * The engine owns the full peer-relative high-frequency analysis, but every
 * consumer that can turn a certificate into a published coefficient needs to
 * reject a self-contradictory selected cycle as well.  This dependency-free
 * adapter deliberately accepts unknown fields so it can protect raw API JSON,
 * persisted JSONB, and archive-ledger rows without trusting their TypeScript
 * shape.
 */

export const URANS_CLEAN_CYCLE_MIN_COEFFICIENT_SAMPLES = 20;
export const URANS_CLEAN_CYCLE_MIN_FIELD_FRAMES = 20;
export const URANS_CLEAN_CYCLE_MAX_PHASE_GAP = 0.1;
export const URANS_CLEAN_CYCLE_MAX_PHASE_SHIFT_BINS = 4;
export const URANS_CLEAN_CYCLE_MAX_SHAPE_NRMSE = 0.12;
export const URANS_CLEAN_CYCLE_MAX_AMPLITUDE_DEVIATION = 0.3;

export type SelectedCleanCycleQualityInput = {
  coefficientSamples: unknown;
  fieldFrames: unknown;
  phaseMaxGap: unknown;
  phaseShiftBins: unknown;
  cl: {
    shapeError: unknown;
    amplitudeDeviation: unknown;
    highFrequency: unknown;
  };
  cd: {
    shapeError: unknown;
    amplitudeDeviation: unknown;
    highFrequency: unknown;
  };
  cm: {
    shapeError: unknown;
    amplitudeDeviation: unknown;
    highFrequency: unknown;
  };
  reasons: unknown;
};

export type SelectedCleanCycleQualityReason =
  | "coefficient-samples"
  | "field-frames"
  | "phase-gap"
  | "phase-shift"
  | "reasons"
  | "cl-shape-error"
  | "cd-shape-error"
  | "cm-shape-error"
  | "cl-amplitude-deviation"
  | "cd-amplitude-deviation"
  | "cm-amplitude-deviation"
  | "cl-high-frequency"
  | "cd-high-frequency"
  | "cm-high-frequency";

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeFinite(value: unknown): value is number {
  return finite(value) && value >= 0;
}

/**
 * Return every policy contradiction on a purportedly selected clean cycle.
 *
 * A high-frequency burst needs the engine's peer-relative comparison to
 * decide whether it is an outlier.  The durable certificate therefore carries
 * the engine verdict in `reasons`; consumers require that it is empty while
 * still rejecting non-finite/malformed high-frequency metrics.
 */
export function selectedCleanCycleQualityReasons(
  cycle: SelectedCleanCycleQualityInput,
): SelectedCleanCycleQualityReason[] {
  const reasons: SelectedCleanCycleQualityReason[] = [];
  if (
    !(
      finite(cycle.coefficientSamples) &&
      Number.isInteger(cycle.coefficientSamples) &&
      cycle.coefficientSamples >= URANS_CLEAN_CYCLE_MIN_COEFFICIENT_SAMPLES
    )
  ) {
    reasons.push("coefficient-samples");
  }
  if (
    !(
      finite(cycle.fieldFrames) &&
      Number.isInteger(cycle.fieldFrames) &&
      cycle.fieldFrames >= URANS_CLEAN_CYCLE_MIN_FIELD_FRAMES
    )
  ) {
    reasons.push("field-frames");
  }
  const phaseMaxGap = cycle.phaseMaxGap;
  if (
    !(nonNegativeFinite(phaseMaxGap) && phaseMaxGap <= URANS_CLEAN_CYCLE_MAX_PHASE_GAP)
  ) {
    reasons.push("phase-gap");
  }
  if (
    !(
      finite(cycle.phaseShiftBins) &&
      Number.isInteger(cycle.phaseShiftBins) &&
      Math.abs(cycle.phaseShiftBins) <= URANS_CLEAN_CYCLE_MAX_PHASE_SHIFT_BINS
    )
  ) {
    reasons.push("phase-shift");
  }
  if (!Array.isArray(cycle.reasons) || cycle.reasons.length > 0) {
    reasons.push("reasons");
  }

  for (const [name, metrics] of [
    ["cl", cycle.cl],
    ["cd", cycle.cd],
    ["cm", cycle.cm],
  ] as const) {
    const shapeError = metrics.shapeError;
    const amplitudeDeviation = metrics.amplitudeDeviation;
    if (
      !(
        nonNegativeFinite(shapeError) &&
        shapeError <= URANS_CLEAN_CYCLE_MAX_SHAPE_NRMSE
      )
    ) {
      reasons.push(`${name}-shape-error` as SelectedCleanCycleQualityReason);
    }
    if (
      !(
        nonNegativeFinite(amplitudeDeviation) &&
        amplitudeDeviation <=
          URANS_CLEAN_CYCLE_MAX_AMPLITUDE_DEVIATION
      )
    ) {
      reasons.push(
        `${name}-amplitude-deviation` as SelectedCleanCycleQualityReason,
      );
    }
    if (!nonNegativeFinite(metrics.highFrequency)) {
      reasons.push(`${name}-high-frequency` as SelectedCleanCycleQualityReason);
    }
  }
  return reasons;
}

