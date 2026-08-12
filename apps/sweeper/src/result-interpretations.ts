/**
 * Append-only coefficient interpretation staging.
 *
 * A result attempt is immutable evidence; an interpretation is a versioned
 * scientific reduction of that evidence.  This module deliberately does not
 * update the legacy `results` projection.  Publication code creates an
 * explicit canonical-selection event only after the normal evidence/classifier
 * transaction accepts the exact attempt.
 */
import { selectedCleanCycleQualityReasons } from "@aerodb/core";
import {
  type DB,
  resultCanonicalSelections,
  resultAttempts,
  resultInterpretationCycles,
  resultInterpretations,
  resultReducerVersions,
  results,
  solverEvidenceArchives,
  solverEvidenceBlobs,
} from "@aerodb/db";
import {
  parseNoSheddingCertificate,
  parseRansHoldCertificate,
  parseUransCycleCertificate,
  NO_SHEDDING_CERTIFICATE_VERSION,
  NO_SHEDDING_MIN_SAMPLE_COUNT,
  type NoSheddingCertificate,
  type PointFidelity,
  type PolarPoint,
  RANS_HOLD_CERTIFICATE_VERSION,
  URANS_CLEAN_CYCLE_CERTIFICATE_VERSION,
  type UransCycleCertificate,
} from "@aerodb/engine-client";
import { createHash } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";

/** The control-plane reduction policy.  Changing any value changes the
 * immutable reducer identity; never edit a historical interpretation. */
export const RESULT_INTERPRETATION_REDUCER_POLICY = {
  contract: "result-interpretation-v1",
  urans: {
    certificate: URANS_CLEAN_CYCLE_CERTIFICATE_VERSION,
    fastMinimumCleanCycles: 3,
    finalMinimumCleanCycles: 5,
    minCoefficientSamplesPerCycle: 20,
    minFieldFramesPerCycle: 20,
  },
  rans: {
    certificate: RANS_HOLD_CERTIFICATE_VERSION,
    dedicatedHoldRequired: true,
    requiredFinalWindowSamples: 200,
  },
  noShedding: {
    certificate: NO_SHEDDING_CERTIFICATE_VERSION,
    minSourceSamples: NO_SHEDDING_MIN_SAMPLE_COUNT,
    minTransportSamples: NO_SHEDDING_MIN_SAMPLE_COUNT,
    allChannelAmplitudeProof: true,
  },
} as const;

export const RESULT_INTERPRETATION_REDUCER_KEY = "airfoilfoam";
export const RESULT_INTERPRETATION_REDUCER_VERSION = "result-interpretation-v1";
export const RESULT_INTERPRETATION_REDUCER_BUILD_ID = "clean-cycle-v3";

export type StagedResultInterpretation = {
  id: string;
  state:
    | "accepted"
    | "continuation_required"
    | "terminal_failure"
    | "legacy_uncertified";
  regime:
    | "legacy_engine_reported"
    | "rans_hold"
    | "steady_equivalent"
    | "periodic"
    | "broadband_stationary"
    | "trending_unresolved";
};

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, stable(nested)]),
    );
  }
  return value;
}

export function stableSha256(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function selectedCertificateCycles(certificate: UransCycleCertificate) {
  return certificate.cycles.filter((cycle) => cycle.disposition === "selected");
}

function selectedCertificateCycleQualityReasons(
  certificate: UransCycleCertificate,
): string[] {
  return selectedCertificateCycles(certificate).flatMap((cycle) =>
    selectedCleanCycleQualityReasons({
      coefficientSamples: cycle.coefficient_samples,
      fieldFrames: cycle.field_frames,
      phaseMaxGap: cycle.phase_max_gap,
      phaseShiftBins: cycle.phase_shift_bins,
      cl: {
        shapeError: cycle.cl_shape_error,
        amplitudeDeviation: cycle.cl_amplitude_deviation,
        highFrequency: cycle.cl_high_frequency,
      },
      cd: {
        shapeError: cycle.cd_shape_error,
        amplitudeDeviation: cycle.cd_amplitude_deviation,
        highFrequency: cycle.cd_high_frequency,
      },
      cm: {
        shapeError: cycle.cm_shape_error,
        amplitudeDeviation: cycle.cm_amplitude_deviation,
        highFrequency: cycle.cm_high_frequency,
      },
      reasons: cycle.reasons,
    }),
  );
}

function minimumCleanCyclesFor(fidelity: PointFidelity): number | null {
  if (fidelity === "urans_precalc") return 3;
  if (fidelity === "urans_full") return 5;
  return null;
}

function acceptedCoefficients(point: PolarPoint): boolean {
  return (
    isFiniteNumber(point.cl) &&
    isFiniteNumber(point.cd) &&
    isFiniteNumber(point.cm) &&
    point.cd > 0
  );
}

function isUransFidelity(fidelity: PointFidelity): boolean {
  return fidelity === "urans_precalc" || fidelity === "urans_full";
}

type TimeWeightedTransportStatistics = {
  mean: number;
  rms: number;
};

/**
 * Recompute the exact bounded-force-history witness statistic used by the
 * engine.  The raw-source statistics intentionally cannot be compared to
 * this lossy transport: the certificate therefore carries both forms, and
 * this function binds the transport form to the point payload before it can
 * become a steady-equivalent interpretation.
 */
function timeWeightedTransportStatistics(
  times: readonly number[],
  values: readonly number[],
): TimeWeightedTransportStatistics | null {
  if (times.length < 2 || values.length !== times.length) return null;
  const span = times.at(-1)! - times[0]!;
  if (!isFiniteNumber(span) || span <= 0) return null;

  let integral = 0;
  for (let index = 1; index < times.length; index += 1) {
    const dt = times[index]! - times[index - 1]!;
    if (!isFiniteNumber(dt) || dt <= 0) return null;
    integral += 0.5 * (values[index - 1]! + values[index]!) * dt;
  }
  const mean = integral / span;
  if (!isFiniteNumber(mean)) return null;

  let varianceIntegral = 0;
  for (let index = 1; index < times.length; index += 1) {
    const dt = times[index]! - times[index - 1]!;
    const previousDeviation = values[index - 1]! - mean;
    const deviation = values[index]! - mean;
    varianceIntegral +=
      0.5 *
      (previousDeviation * previousDeviation + deviation * deviation) *
      dt;
  }
  const rms = Math.sqrt(Math.max(varianceIntegral / span, 0));
  return isFiniteNumber(rms) ? { mean, rms } : null;
}

function noSheddingHistoryContractReason(
  point: PolarPoint,
  certificate: NoSheddingCertificate,
): string | null {
  const history = point.force_history;
  if (history == null) {
    return "no-shedding proof has no retained force-history transport";
  }
  const channels = [history.t, history.cl, history.cd, history.cm];
  const count = history.t.length;
  if (
    count < 2 ||
    channels.some(
      (channel) => !Array.isArray(channel) || channel.length !== count,
    )
  ) {
    return "no-shedding force-history channels are incomplete";
  }
  if (
    count !== certificate.transport_sample_count ||
    certificate.source_sample_count < count
  ) {
    return "no-shedding force-history sample counts do not match the certificate";
  }
  for (const channel of channels) {
    if (channel.some((value) => !isFiniteNumber(value))) {
      return "no-shedding force history contains non-finite values";
    }
  }
  if (
    history.t.some(
      (value, index) => index > 0 && value <= history.t[index - 1]!,
    )
  ) {
    return "no-shedding force-history times are not strictly increasing";
  }
  const firstTime = history.t[0]!;
  const lastTime = history.t.at(-1)!;
  if (
    !sameCertifiedMean(firstTime, certificate.observation_start_time) ||
    !sameCertifiedMean(lastTime, certificate.observation_end_time)
  ) {
    return "no-shedding force-history endpoints do not match the certificate";
  }
  const transport = [
    [
      "cl",
      history.cl,
      certificate.transport_cl_mean,
      certificate.transport_cl_rms,
    ],
    [
      "cd",
      history.cd,
      certificate.transport_cd_mean,
      certificate.transport_cd_rms,
    ],
    [
      "cm",
      history.cm,
      certificate.transport_cm_mean,
      certificate.transport_cm_rms,
    ],
  ] as const;
  for (const [channel, values, expectedMean, expectedRms] of transport) {
    const statistics = timeWeightedTransportStatistics(history.t, values);
    if (
      statistics == null ||
      !sameCertifiedMean(statistics.mean, expectedMean) ||
      !sameCertifiedMean(statistics.rms, expectedRms)
    ) {
      return `no-shedding ${channel} force-history transport does not match the certificate`;
    }
  }
  if (
    !acceptedCoefficients(point) ||
    !sameCertifiedMean(point.cl!, certificate.cl_mean) ||
    !sameCertifiedMean(point.cd!, certificate.cd_mean) ||
    !sameCertifiedMean(point.cm!, certificate.cm_mean)
  ) {
    return "published URANS coefficients do not equal the no-shedding observation means";
  }
  return null;
}

type NoSheddingUransProof =
  | { state: "accepted"; certificate: NoSheddingCertificate }
  | { state: "not_candidate" }
  | { state: "legacy" }
  | { state: "missing"; reason: string }
  | { state: "invalid"; reason: string; errors?: string[] };

/**
 * A no-shedding URANS run is a real steady-equivalent result, but only an
 * explicit physical-observation certificate can say so. Never infer it from a
 * solver boolean or missing cycle certificate: either can let a shortened or
 * broken transient bypass the clean-cycle gate.
 */
function noSheddingUransProof(
  point: PolarPoint,
  fidelity: PointFidelity,
): NoSheddingUransProof {
  const candidate =
    isUransFidelity(fidelity) &&
    point.unsteady === false &&
    point.converged === true &&
    !point.error &&
    point.frame_track === null &&
    point.urans_cycle_certificate === null;
  if (!candidate) return { state: "not_candidate" };
  if (point.no_shedding_certificate === undefined) {
    // Before this certificate existed, both omitted fields are historical
    // evidence, not proof that a current producer failed.
    if (
      point.frame_track === undefined &&
      point.urans_cycle_certificate === undefined
    ) {
      return { state: "legacy" };
    }
    return {
      state: "missing",
      reason:
        "current no-shedding URANS result has no physical observation certificate",
    };
  }
  if (point.no_shedding_certificate === null) {
    return {
      state: "missing",
      reason:
        "current no-shedding URANS result could not certify its physical observation",
    };
  }
  const parsed = parseNoSheddingCertificate(point.no_shedding_certificate);
  if (!parsed.ok) {
    return {
      state: "invalid",
      reason: "current no-shedding URANS certificate is malformed",
      errors: parsed.errors,
    };
  }
  const historyReason = noSheddingHistoryContractReason(point, parsed.value);
  if (historyReason) {
    return { state: "invalid", reason: historyReason };
  }
  return { state: "accepted", certificate: parsed.value };
}

type InterpretationDraft = Omit<StagedResultInterpretation, "id"> & {
  continuationReason: string | null;
  terminalReason: string | null;
  selectedWindow: Record<string, unknown>;
  statistics: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  cl: number | null;
  cd: number | null;
  cm: number | null;
  clCd: number | null;
  clWaveformRms: number | null;
  cdWaveformRms: number | null;
  cmWaveformRms: number | null;
  uncertaintyBasis:
    | "paired_cycles"
    | "paired_blocks"
    | "stability_envelope"
    | "numerical_plateau"
    | "legacy_engine_reported"
    | "not_available";
  effectiveBlocks: number | null;
};

function legacyDraft(point: PolarPoint, reason: string): InterpretationDraft {
  return {
    state: "legacy_uncertified",
    regime: "legacy_engine_reported",
    continuationReason: null,
    terminalReason: null,
    selectedWindow: {},
    statistics: {},
    diagnostics: { reason },
    cl: isFiniteNumber(point.cl) ? point.cl : null,
    cd: isFiniteNumber(point.cd) ? point.cd : null,
    cm: isFiniteNumber(point.cm) ? point.cm : null,
    clCd: isFiniteNumber(point.cl_cd) ? point.cl_cd : null,
    clWaveformRms: isFiniteNumber(point.cl_std) ? point.cl_std : null,
    cdWaveformRms: isFiniteNumber(point.cd_std) ? point.cd_std : null,
    cmWaveformRms: isFiniteNumber(point.cm_std) ? point.cm_std : null,
    uncertaintyBasis: "legacy_engine_reported",
    effectiveBlocks: null,
  };
}

function certificateContractReason(
  certificate: UransCycleCertificate,
  fidelity: PointFidelity,
): string | null {
  const minimum = minimumCleanCyclesFor(fidelity);
  if (minimum == null)
    return "URANS certificate supplied for a non-URANS fidelity";
  if (certificate.reducer_version !== URANS_CLEAN_CYCLE_CERTIFICATE_VERSION) {
    return `unsupported URANS reducer ${certificate.reducer_version}`;
  }
  if (certificate.required_clean_cycles !== minimum) {
    return `certificate requires ${certificate.required_clean_cycles} clean cycles; ${fidelity} requires ${minimum}`;
  }
  const selected = selectedCertificateCycles(certificate);
  if (certificate.certified) {
    if (certificate.terminal_clean_cycles < minimum)
      return "certificate marks certified despite an insufficient terminal clean suffix";
    if (selected.length !== minimum)
      return "certificate marks certified without exactly the fidelity-required selected publication cycles";
    const expectedStart = certificate.selected_cycle_start_index;
    if (
      expectedStart == null ||
      !selected.some((cycle) => cycle.index === expectedStart)
    ) {
      return "certificate marks certified without a selected terminal-start cycle";
    }
    const selectedAreContiguous = selected.every(
      (cycle, index) =>
        index === 0 || cycle.index === selected[index - 1]!.index + 1,
    );
    if (!selectedAreContiguous)
      return "certificate selected cycles are not a contiguous suffix";
    const finalCycleIndex = certificate.cycles.at(-1)?.index;
    if (finalCycleIndex == null || selected.at(-1)?.index !== finalCycleIndex) {
      return "certificate selected cycles are not the terminal publication suffix";
    }
    const qualityReasons = selectedCertificateCycleQualityReasons(certificate);
    if (qualityReasons.length) {
      return `certificate selects cycles that violate clean-cycle policy (${qualityReasons.join(", ")})`;
    }
  }
  return null;
}

function ransHoldContinuationDraft(
  reason: string,
  diagnostics: Record<string, unknown>,
): InterpretationDraft {
  return {
    state: "continuation_required",
    regime: "trending_unresolved",
    continuationReason: reason,
    terminalReason: null,
    selectedWindow: {},
    statistics: {},
    diagnostics,
    cl: null,
    cd: null,
    cm: null,
    clCd: null,
    clWaveformRms: null,
    cdWaveformRms: null,
    cmWaveformRms: null,
    uncertaintyBasis: "not_available",
    effectiveBlocks: null,
  };
}

function sameCertifiedMean(actual: number, expected: number): boolean {
  return (
    Math.abs(actual - expected) <=
    1e-12 * Math.max(1, Math.abs(actual), Math.abs(expected))
  );
}

function ransHoldDraft(point: PolarPoint): InterpretationDraft {
  // A missing *key* is legitimate historical evidence.  Current engine runs
  // serialize a key with either a complete proof or explicit null.
  if (point.rans_hold_certificate === undefined) {
    return legacyDraft(
      point,
      "steady result predates the dedicated all-channel RANS hold reducer",
    );
  }
  if (point.rans_hold_certificate === null) {
    return ransHoldContinuationDraft(
      "current steady RANS has no exact all-channel final-window proof; route this angle to FAST URANS",
      { ransHoldCertificate: "missing" },
    );
  }
  const parsed = parseRansHoldCertificate(point.rans_hold_certificate);
  if (!parsed.ok) {
    return ransHoldContinuationDraft(
      "current steady RANS hold proof is malformed; route this angle to FAST URANS",
      { ransHoldCertificate: "invalid", contractErrors: parsed.errors },
    );
  }
  const certificate = parsed.value;
  if (!acceptedCoefficients(point)) {
    return ransHoldContinuationDraft(
      "current steady RANS hold proof has unusable published coefficients; route this angle to FAST URANS",
      { ransHoldCertificate: certificate, coefficientState: "unusable" },
    );
  }
  if (
    !sameCertifiedMean(point.cl!, certificate.cl.mean) ||
    !sameCertifiedMean(point.cd!, certificate.cd.mean) ||
    !sameCertifiedMean(point.cm!, certificate.cm.mean)
  ) {
    return ransHoldContinuationDraft(
      "published RANS coefficients do not equal the certified raw final-window means; route this angle to FAST URANS",
      { ransHoldCertificate: certificate, coefficientState: "proof-mismatch" },
    );
  }
  return {
    state: "accepted",
    regime: "rans_hold",
    continuationReason: null,
    terminalReason: null,
    selectedWindow: {
      reducerVersion: certificate.reducer_version,
      sampleCount: certificate.sample_count,
      requiredSampleCount: certificate.required_sample_count,
      startIteration: certificate.start_iteration,
      endIteration: certificate.end_iteration,
    },
    statistics: {
      cl: certificate.cl,
      cd: certificate.cd,
      cm: certificate.cm,
    },
    diagnostics: { ransHoldCertificate: certificate },
    cl: certificate.cl.mean,
    cd: certificate.cd.mean,
    cm: certificate.cm.mean,
    clCd: certificate.cl.mean / certificate.cd.mean,
    clWaveformRms: null,
    cdWaveformRms: null,
    cmWaveformRms: null,
    uncertaintyBasis: "numerical_plateau",
    effectiveBlocks: 1,
  };
}

/** Pure current-engine reducer used by both live ingestion and archive staging.
 * Exported for focused contract tests; callers still persist through the
 * append-only staging functions below. */
export function draftResultInterpretationForPoint(
  point: PolarPoint,
  fidelity: PointFidelity,
): { draft: InterpretationDraft; certificate: UransCycleCertificate | null } {
  const noShedding = noSheddingUransProof(point, fidelity);
  // No-shedding URANS is an honest steady-equivalent result. It does not
  // invent periodic evidence, but it does require a typed slow-wake physical
  // observation certificate tied to the retained force history.
  if (noShedding.state === "accepted") {
    const certificate = noShedding.certificate;
    return {
      certificate: null,
      draft: {
        state: "accepted",
        regime: "steady_equivalent",
        continuationReason: null,
        terminalReason: null,
        selectedWindow: {
          kind: "steady_equivalent",
          reducerVersion: certificate.reducer_version,
          observationStartTime: certificate.observation_start_time,
          observationEndTime: certificate.observation_end_time,
          requiredObservationS: certificate.required_observation_s,
          observedObservationS: certificate.observed_observation_s,
          sourceSampleCount: certificate.source_sample_count,
          transportSampleCount: certificate.transport_sample_count,
        },
        statistics: {
          cl: { mean: certificate.cl_mean, rms: certificate.cl_rms },
          cd: { mean: certificate.cd_mean, rms: certificate.cd_rms },
          cm: { mean: certificate.cm_mean, rms: certificate.cm_rms },
        },
        diagnostics: { noSheddingCertificate: certificate },
        cl: certificate.cl_mean,
        cd: certificate.cd_mean,
        cm: certificate.cm_mean,
        clCd: certificate.cl_mean / certificate.cd_mean,
        clWaveformRms: certificate.cl_rms,
        cdWaveformRms: certificate.cd_rms,
        cmWaveformRms: certificate.cm_rms,
        uncertaintyBasis: "numerical_plateau",
        effectiveBlocks: null,
      },
    };
  }

  if (noShedding.state === "missing" || noShedding.state === "invalid") {
    return {
      certificate: null,
      draft: ransHoldContinuationDraft(
        `${noShedding.reason}; route this angle to FAST URANS`,
        {
          noSheddingCertificate:
            noShedding.state === "invalid" ? "invalid" : "missing",
          contractErrors:
            noShedding.state === "invalid" ? (noShedding.errors ?? []) : [],
        },
      ),
    };
  }

  if (fidelity === "rans") {
    return {
      certificate: null,
      draft: ransHoldDraft(point),
    };
  }

  if (!point.unsteady) {
    // A current URANS producer must explicitly identify a physically steady
    // transient. Anything else is missing evidence, not a RANS result and not
    // a license to use the steady-hold certificate path.
    if (
      point.frame_track === undefined &&
      point.urans_cycle_certificate === undefined
    ) {
      return {
        certificate: null,
        draft: legacyDraft(
          point,
          "URANS result predates the explicit no-shedding/cycle-certificate transport",
        ),
      };
    }
    return {
      certificate: null,
      draft: ransHoldContinuationDraft(
        "current URANS result is neither an explicit no-shedding result nor certified periodic evidence; route this angle to FAST URANS",
        {
          frameTrack: point.frame_track ?? "missing",
          uransCycleCertificate: point.urans_cycle_certificate ?? "missing",
        },
      ),
    };
  }

  if (point.urans_cycle_certificate === undefined) {
    return {
      certificate: null,
      draft: legacyDraft(
        point,
        "URANS result predates the clean-cycle certification reducer",
      ),
    };
  }

  if (point.urans_cycle_certificate === null) {
    return {
      certificate: null,
      draft: ransHoldContinuationDraft(
        "current shedding URANS has no clean-cycle certificate; route this angle to FAST URANS",
        { uransCycleCertificate: "missing" },
      ),
    };
  }

  const parsed = parseUransCycleCertificate(point.urans_cycle_certificate);
  if (!parsed.ok) {
    return {
      certificate: null,
      draft: {
        state: "terminal_failure",
        regime: "trending_unresolved",
        continuationReason: null,
        terminalReason: `URANS cycle certificate contract drift: ${parsed.errors.join("; ")}`,
        selectedWindow: {},
        statistics: {},
        diagnostics: { contractErrors: parsed.errors },
        cl: null,
        cd: null,
        cm: null,
        clCd: null,
        clWaveformRms: null,
        cdWaveformRms: null,
        cmWaveformRms: null,
        uncertaintyBasis: "not_available",
        effectiveBlocks: null,
      },
    };
  }

  const certificate = parsed.value;
  const contractReason = certificateContractReason(certificate, fidelity);
  const selected = selectedCertificateCycles(certificate);
  const selectedWindow = {
    periodS: certificate.period_s,
    phaseSamples: certificate.phase_samples,
    requiredCleanCycles: certificate.required_clean_cycles,
    terminalCleanCycles: certificate.terminal_clean_cycles,
    selectedCycleStartIndex: certificate.selected_cycle_start_index,
    selectedCycleIndexes: selected.map((cycle) => cycle.index),
    cadenceAdjusted: certificate.cadence_adjusted,
  };
  const diagnostics = {
    reducerVersion: certificate.reducer_version,
    certified: certificate.certified,
    cycleCount: certificate.cycles.length,
  };
  if (contractReason) {
    return {
      certificate,
      draft: {
        state: "terminal_failure",
        regime: "trending_unresolved",
        continuationReason: null,
        terminalReason: `URANS cycle certificate invalid: ${contractReason}`,
        selectedWindow,
        statistics: {},
        diagnostics,
        cl: null,
        cd: null,
        cm: null,
        clCd: null,
        clWaveformRms: null,
        cdWaveformRms: null,
        cmWaveformRms: null,
        uncertaintyBasis: "not_available",
        effectiveBlocks: null,
      },
    };
  }
  if (
    !certificate.certified ||
    !acceptedCoefficients(point) ||
    point.converged !== true
  ) {
    return {
      certificate,
      draft: {
        state: "continuation_required",
        regime: "trending_unresolved",
        continuationReason: !certificate.certified
          ? `terminal clean suffix ${certificate.terminal_clean_cycles}/${certificate.required_clean_cycles} is not certified`
          : !acceptedCoefficients(point)
            ? "certified URANS certificate has unusable coefficient values"
            : "certified clean-cycle suffix has no stationary statistics window; continue the exact case",
        terminalReason: null,
        selectedWindow,
        statistics: {},
        diagnostics,
        cl: null,
        cd: null,
        cm: null,
        clCd: null,
        clWaveformRms: null,
        cdWaveformRms: null,
        cmWaveformRms: null,
        uncertaintyBasis: "not_available",
        effectiveBlocks: null,
      },
    };
  }
  return {
    certificate,
    draft: {
      state: "accepted",
      regime: "periodic",
      continuationReason: null,
      terminalReason: null,
      selectedWindow,
      statistics: {
        frameTrack: point.frame_track ?? null,
      },
      diagnostics,
      cl: point.cl!,
      cd: point.cd!,
      cm: point.cm!,
      clCd: point.cl! / point.cd!,
      clWaveformRms: isFiniteNumber(point.cl_std) ? point.cl_std : null,
      cdWaveformRms: isFiniteNumber(point.cd_std) ? point.cd_std : null,
      cmWaveformRms: isFiniteNumber(point.cm_std) ? point.cm_std : null,
      uncertaintyBasis: "paired_cycles",
      effectiveBlocks: selected.length,
    },
  };
}

async function ensureReducerVersion(db: DB): Promise<string> {
  const policy = RESULT_INTERPRETATION_REDUCER_POLICY as unknown as Record<
    string,
    unknown
  >;
  const policySha256 = stableSha256(policy);
  const [inserted] = await db
    .insert(resultReducerVersions)
    .values({
      reducerKey: RESULT_INTERPRETATION_REDUCER_KEY,
      reducerVersion: RESULT_INTERPRETATION_REDUCER_VERSION,
      buildId: RESULT_INTERPRETATION_REDUCER_BUILD_ID,
      policySha256,
      policy,
      source: "application",
    })
    .onConflictDoNothing()
    .returning({ id: resultReducerVersions.id });
  if (inserted) return inserted.id;
  const [existing] = await db
    .select({ id: resultReducerVersions.id })
    .from(resultReducerVersions)
    .where(
      and(
        eq(resultReducerVersions.reducerKey, RESULT_INTERPRETATION_REDUCER_KEY),
        eq(
          resultReducerVersions.reducerVersion,
          RESULT_INTERPRETATION_REDUCER_VERSION,
        ),
        eq(
          resultReducerVersions.buildId,
          RESULT_INTERPRETATION_REDUCER_BUILD_ID,
        ),
        eq(resultReducerVersions.policySha256, policySha256),
      ),
    )
    .limit(1);
  if (!existing)
    throw new Error("result reducer version could not be persisted");
  return existing.id;
}

/** Read-only lookup used by a CLI planning pass.  Unlike `ensure…`, this
 * never creates a reducer row merely because an operator asked what work is
 * eligible. */
export async function findResultInterpretationReducerVersion(
  db: DB,
): Promise<string | null> {
  const policy = RESULT_INTERPRETATION_REDUCER_POLICY as unknown as Record<
    string,
    unknown
  >;
  const policySha256 = stableSha256(policy);
  const [existing] = await db
    .select({ id: resultReducerVersions.id })
    .from(resultReducerVersions)
    .where(
      and(
        eq(resultReducerVersions.reducerKey, RESULT_INTERPRETATION_REDUCER_KEY),
        eq(
          resultReducerVersions.reducerVersion,
          RESULT_INTERPRETATION_REDUCER_VERSION,
        ),
        eq(
          resultReducerVersions.buildId,
          RESULT_INTERPRETATION_REDUCER_BUILD_ID,
        ),
        eq(resultReducerVersions.policySha256, policySha256),
      ),
    )
    .limit(1);
  return existing?.id ?? null;
}

/**
 * Resolve the immutable reducer identity shared by live staging and archive
 * backfills.  A backfill run pins this id before it enqueues work, so a later
 * reducer-policy/build change creates a distinct run instead of silently
 * mixing scientific interpretations under one run record.
 */
export async function ensureResultInterpretationReducerVersion(
  db: DB,
): Promise<string> {
  return ensureReducerVersion(db);
}

/** Stage an immutable engine-derived interpretation after the complete attempt
 * and its exact evidence artifacts have been recorded.  Replays return the
 * existing interpretation when the complete evidence signature agrees. */
export async function stageEngineResultInterpretation(opts: {
  db: DB;
  resultId: string;
  resultAttemptId: string;
  point: PolarPoint;
  fidelity: PointFidelity;
}): Promise<StagedResultInterpretation> {
  const reducerVersionId = await ensureReducerVersion(opts.db);
  const { draft, certificate } = draftResultInterpretationForPoint(
    opts.point,
    opts.fidelity,
  );
  const inputEvidenceSignature = stableSha256({
    forceHistory: opts.point.force_history ?? null,
    frameTrack: opts.point.frame_track ?? null,
    cycleCertificate: opts.point.urans_cycle_certificate ?? null,
    noSheddingCertificatePresent: Object.hasOwn(
      opts.point,
      "no_shedding_certificate",
    ),
    noSheddingCertificate: opts.point.no_shedding_certificate ?? null,
    ransHoldCertificatePresent: Object.hasOwn(
      opts.point,
      "rans_hold_certificate",
    ),
    ransHoldCertificate: opts.point.rans_hold_certificate ?? null,
    evidenceArtifacts: (opts.point.evidence_artifacts ?? []).map(
      (artifact) => ({
        kind: artifact.kind,
        path: artifact.path,
        sha256: artifact.sha256,
        byteSize: artifact.byte_size,
      }),
    ),
  });
  const [inserted] = await opts.db
    .insert(resultInterpretations)
    .values({
      resultId: opts.resultId,
      resultAttemptId: opts.resultAttemptId,
      reducerVersionId,
      meshIdentityId: null,
      sourceArchiveId: null,
      source: "engine_reported",
      inputEvidenceSignature,
      state: draft.state,
      regime: draft.regime,
      continuationReason: draft.continuationReason,
      terminalReason: draft.terminalReason,
      selectedWindow: draft.selectedWindow,
      statistics: draft.statistics,
      diagnostics: draft.diagnostics,
      cl: draft.cl,
      cd: draft.cd,
      cm: draft.cm,
      clCd: draft.clCd,
      clWaveformRms: draft.clWaveformRms,
      cdWaveformRms: draft.cdWaveformRms,
      cmWaveformRms: draft.cmWaveformRms,
      clStandardError: null,
      cdStandardError: null,
      cmStandardError: null,
      clCi95Low: null,
      clCi95High: null,
      cdCi95Low: null,
      cdCi95High: null,
      cmCi95Low: null,
      cmCi95High: null,
      clCdCi95Low: null,
      clCdCi95High: null,
      clCdIntervalState: "unavailable",
      uncertaintyBasis: draft.uncertaintyBasis,
      effectiveBlocks: draft.effectiveBlocks,
      maxIatSeconds: null,
    })
    .onConflictDoNothing()
    .returning({ id: resultInterpretations.id });
  let interpretationId = inserted?.id;
  if (!interpretationId) {
    const [existing] = await opts.db
      .select({ id: resultInterpretations.id })
      .from(resultInterpretations)
      .where(
        and(
          eq(resultInterpretations.resultAttemptId, opts.resultAttemptId),
          eq(resultInterpretations.reducerVersionId, reducerVersionId),
          eq(
            resultInterpretations.inputEvidenceSignature,
            inputEvidenceSignature,
          ),
        ),
      )
      .limit(1);
    if (!existing)
      throw new Error("result interpretation replay could not be resolved");
    interpretationId = existing.id;
  }

  if (certificate) {
    const rows = certificate.cycles.map((cycle) => ({
      resultId: opts.resultId,
      resultAttemptId: opts.resultAttemptId,
      resultInterpretationId: interpretationId!,
      cycleIndex: cycle.index,
      startTimeS: cycle.t_start,
      endTimeS: cycle.t_end,
      periodS: certificate.period_s,
      disposition: cycle.disposition,
      coefficientSampleCount: cycle.coefficient_samples,
      fieldFrameCount: cycle.field_frames,
      phaseMaxGapFraction: cycle.phase_max_gap,
      metrics: {
        phaseShiftBins: cycle.phase_shift_bins,
        cl: {
          mean: cycle.cl_mean,
          shapeError: cycle.cl_shape_error,
          amplitudeDeviation: cycle.cl_amplitude_deviation,
          highFrequency: cycle.cl_high_frequency,
        },
        cd: {
          mean: cycle.cd_mean,
          shapeError: cycle.cd_shape_error,
          amplitudeDeviation: cycle.cd_amplitude_deviation,
          highFrequency: cycle.cd_high_frequency,
        },
        cm: {
          mean: cycle.cm_mean,
          shapeError: cycle.cm_shape_error,
          amplitudeDeviation: cycle.cm_amplitude_deviation,
          highFrequency: cycle.cm_high_frequency,
        },
        reasons: cycle.reasons,
      },
    }));
    if (rows.length) {
      await opts.db
        .insert(resultInterpretationCycles)
        .values(rows)
        .onConflictDoNothing();
    }
  }
  return { id: interpretationId, state: draft.state, regime: draft.regime };
}

type ArchiveSelectionAttempt = {
  status: string;
  source: string;
  regime: string | null;
  unsteady: boolean;
  error: string | null;
  fidelity: unknown;
};

type ArchiveSelectionInterpretation = {
  id: string;
  state: string;
  source: string;
  regime: string;
  sourceArchiveId: string | null;
  inputEvidenceSignature: string;
  cl: number | null;
  cd: number | null;
  cm: number | null;
  clCd: number | null;
  selectedWindow: Record<string, unknown>;
  statistics: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
};

type ArchiveSelectionCycle = {
  cycleIndex: number;
  disposition: string;
  coefficientSampleCount: number;
  fieldFrameCount: number;
  phaseMaxGapFraction: number | null;
  metrics: Record<string, unknown>;
};

/** The minimum immutable-store proof repeated by the selection policy.  The
 * full archive-pointer verifier runs before staging; this narrow subset keeps
 * a direct selection call from projecting a volume/local or unverified archive
 * merely because it is marked current. */
type ArchiveSelectionArchive = {
  id: string;
  state: string;
  backend: string;
  compression: string;
  mimeType: string;
  bucket: string | null;
  generation: string | null;
  verifiedAt: Date | null;
};

export type ArchiveInterpretationSelectionOutcome =
  | "selected"
  | "already_selected"
  | "stale_attempt"
  | "not_eligible";

/** Narrow compare-and-swap policy for archive recovery of a result whose old
 * live-summary classifier left no current attempt pointer. */
export function archiveAttemptMayPromotePointerlessResult(input: {
  currentAttemptId: string | null;
  currentInterpretationId: string | null;
  currentCanonicalSelectionId: string | null;
  resultStatus: string;
  resultSimJobId: string | null;
  attemptSimJobId: string | null;
}): boolean {
  return (
    input.currentAttemptId === null &&
    input.currentInterpretationId === null &&
    input.currentCanonicalSelectionId === null &&
    input.resultStatus === "failed" &&
    input.resultSimJobId === input.attemptSimJobId
  );
}

const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_TEXT = /^[0-9a-f]{64}$/;
const GCS_GENERATION_TEXT = /^[1-9][0-9]{0,19}$/;

function archiveFidelityCleanCycleRequirement(value: unknown): 3 | 5 | null {
  return value === "urans_precalc" ? 3 : value === "urans_full" ? 5 : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function archiveSelectedCycleQualityReasons(
  cycle: ArchiveSelectionCycle,
): string[] {
  const metrics = asRecord(cycle.metrics);
  const cl = asRecord(metrics.cl);
  const cd = asRecord(metrics.cd);
  const cm = asRecord(metrics.cm);
  return selectedCleanCycleQualityReasons({
    coefficientSamples: cycle.coefficientSampleCount,
    fieldFrames: cycle.fieldFrameCount,
    phaseMaxGap: cycle.phaseMaxGapFraction,
    phaseShiftBins: metrics.phaseShiftBins,
    cl: {
      shapeError: cl.shapeError,
      amplitudeDeviation: cl.amplitudeDeviation,
      highFrequency: cl.highFrequency,
    },
    cd: {
      shapeError: cd.shapeError,
      amplitudeDeviation: cd.amplitudeDeviation,
      highFrequency: cd.highFrequency,
    },
    cm: {
      shapeError: cm.shapeError,
      amplitudeDeviation: cm.amplitudeDeviation,
      highFrequency: cm.highFrequency,
    },
    reasons: metrics.reasons,
  });
}

function exactPositiveCoefficientSet(
  interpretation: ArchiveSelectionInterpretation,
): boolean {
  if (
    !isFiniteNumber(interpretation.cl) ||
    !isFiniteNumber(interpretation.cd) ||
    !isFiniteNumber(interpretation.cm) ||
    !isFiniteNumber(interpretation.clCd) ||
    interpretation.cd <= 0
  ) {
    return false;
  }
  const expected = interpretation.cl / interpretation.cd;
  return sameCertifiedMean(interpretation.clCd, expected);
}

function hasVerifiedCurrentGcsArchive(
  archive: ArchiveSelectionArchive | null,
  expectedSourceArchiveId: string,
): boolean {
  return (
    archive?.id === expectedSourceArchiveId &&
    archive.state === "current" &&
    archive.backend === "gcs" &&
    archive.compression === "zstd" &&
    archive.mimeType === "application/zstd" &&
    typeof archive.bucket === "string" &&
    archive.bucket.trim() !== "" &&
    typeof archive.generation === "string" &&
    GCS_GENERATION_TEXT.test(archive.generation) &&
    archive.verifiedAt instanceof Date &&
    Number.isFinite(archive.verifiedAt.getTime())
  );
}

/** Archive reductions can also certify an unsteady solve as physically
 * steady-equivalent. That path intentionally has no cycle rows, but it is not
 * a weaker route: the persisted observation certificate, selected interval and
 * scalar projection must agree exactly. The staging boundary has already
 * checked the raw force-history transport; the selector repeats the durable
 * reduction facts so an arbitrary accepted-looking row cannot be projected. */
function archiveNoSheddingCertificate(
  interpretation: ArchiveSelectionInterpretation,
): NoSheddingCertificate | null {
  const parsed = parseNoSheddingCertificate(
    interpretation.diagnostics.noSheddingCertificate,
  );
  return parsed.ok ? parsed.value : null;
}

function exactNoSheddingWindow(
  interpretation: ArchiveSelectionInterpretation,
  certificate: NoSheddingCertificate,
): boolean {
  const window = asRecord(interpretation.selectedWindow);
  return (
    window.kind === "steady_equivalent" &&
    window.reducerVersion === certificate.reducer_version &&
    isFiniteNumber(window.observationStartTime) &&
    sameCertifiedMean(
      window.observationStartTime,
      certificate.observation_start_time,
    ) &&
    isFiniteNumber(window.observationEndTime) &&
    sameCertifiedMean(
      window.observationEndTime,
      certificate.observation_end_time,
    ) &&
    isFiniteNumber(window.requiredObservationS) &&
    sameCertifiedMean(
      window.requiredObservationS,
      certificate.required_observation_s,
    ) &&
    isFiniteNumber(window.observedObservationS) &&
    sameCertifiedMean(
      window.observedObservationS,
      certificate.observed_observation_s,
    ) &&
    window.sourceSampleCount === certificate.source_sample_count &&
    window.transportSampleCount === certificate.transport_sample_count
  );
}

function exactNoSheddingStatistics(
  interpretation: ArchiveSelectionInterpretation,
  certificate: NoSheddingCertificate,
): boolean {
  const statistics = asRecord(interpretation.statistics);
  const channelMatches = (
    value: unknown,
    expected: { mean: number; rms: number },
  ) => {
    const channel = asRecord(value);
    return (
      isFiniteNumber(channel.mean) &&
      isFiniteNumber(channel.rms) &&
      sameCertifiedMean(channel.mean, expected.mean) &&
      sameCertifiedMean(channel.rms, expected.rms)
    );
  };
  return (
    channelMatches(statistics.cl, {
      mean: certificate.cl_mean,
      rms: certificate.cl_rms,
    }) &&
    channelMatches(statistics.cd, {
      mean: certificate.cd_mean,
      rms: certificate.cd_rms,
    }) &&
    channelMatches(statistics.cm, {
      mean: certificate.cm_mean,
      rms: certificate.cm_rms,
    }) &&
    isFiniteNumber(interpretation.cl) &&
    isFiniteNumber(interpretation.cd) &&
    isFiniteNumber(interpretation.cm) &&
    sameCertifiedMean(interpretation.cl, certificate.cl_mean) &&
    sameCertifiedMean(interpretation.cd, certificate.cd_mean) &&
    sameCertifiedMean(interpretation.cm, certificate.cm_mean)
  );
}

function isExactArchiveSteadyEquivalent(input: {
  interpretation: ArchiveSelectionInterpretation;
  attempt: ArchiveSelectionAttempt;
  cycles: readonly ArchiveSelectionCycle[];
}): boolean {
  const { interpretation, attempt, cycles } = input;
  // Archive-only provenance is deliberately nested by the staging writer so
  // it cannot collide with the engine-derived diagnostics. Read it through
  // the same durable shape the persisted interpretation uses; accepting a
  // top-level look-alike would let a hand-authored row bypass the raw
  // manifest's explicit URANS marker.
  const archiveBackfill = asRecord(interpretation.diagnostics.archiveBackfill);
  if (
    interpretation.regime !== "steady_equivalent" ||
    attempt.unsteady !== false ||
    // `unsteady=false` is the physical *answer* for a flat wake, not the
    // numerical provenance. Require the authenticated archive reducer to
    // retain the manifest's URANS marker so a regular RANS row cannot borrow
    // the steady-equivalent selector merely by carrying compatible scalars.
    archiveBackfill.unsteadyEvidence !== true ||
    // A no-shedding URANS attempt was historically persisted as `rans` because
    // the old ingest mapper used `unsteady` as the regime discriminator. The
    // fidelity + complete proof below is the narrow compatibility route; a
    // normal RANS row cannot use it.
    (attempt.regime !== "urans" && attempt.regime !== "rans") ||
    cycles.length !== 0
  ) {
    return false;
  }
  const certificate = archiveNoSheddingCertificate(interpretation);
  return (
    certificate != null &&
    exactNoSheddingWindow(interpretation, certificate) &&
    exactNoSheddingStatistics(interpretation, certificate)
  );
}

/**
 * Pure, deliberately conservative selector policy for archive reductions.
 * The raw archive may replace a stale engine summary only when it proves the
 * full terminal clean suffix for the exact current URANS attempt.  A valid
 * row alone is not enough: this repeats the selection invariants so a direct
 * database insertion cannot turn an arbitrary accepted-looking row into a
 * public coefficient projection.
 */
export function canSelectAcceptedArchiveInterpretation(input: {
  interpretation: ArchiveSelectionInterpretation;
  expectedSourceArchiveId: string;
  archive: ArchiveSelectionArchive | null;
  attempt: ArchiveSelectionAttempt;
  cycles: readonly ArchiveSelectionCycle[];
}): boolean {
  const { interpretation, expectedSourceArchiveId, attempt } = input;
  if (
    interpretation.state !== "accepted" ||
    interpretation.source !== "archive_backfill" ||
    !UUID_TEXT.test(interpretation.id) ||
    !UUID_TEXT.test(expectedSourceArchiveId) ||
    interpretation.sourceArchiveId !== expectedSourceArchiveId ||
    !SHA256_TEXT.test(interpretation.inputEvidenceSignature) ||
    !hasVerifiedCurrentGcsArchive(input.archive, expectedSourceArchiveId) ||
    attempt.status !== "done" ||
    attempt.source !== "solved" ||
    (attempt.error != null && attempt.error.trim() !== "") ||
    !exactPositiveCoefficientSet(interpretation)
  ) {
    return false;
  }
  const required = archiveFidelityCleanCycleRequirement(attempt.fidelity);
  if (required == null) return false;

  if (
    isExactArchiveSteadyEquivalent({
      interpretation,
      attempt,
      cycles: input.cycles,
    })
  ) {
    return true;
  }

  if (
    interpretation.regime !== "periodic" ||
    attempt.regime !== "urans" ||
    attempt.unsteady !== true ||
    input.cycles.length < required
  ) {
    return false;
  }

  const cycles = [...input.cycles].sort(
    (left, right) => left.cycleIndex - right.cycleIndex,
  );
  if (
    cycles.some(
      (cycle, index) =>
        !Number.isInteger(cycle.cycleIndex) ||
        cycle.cycleIndex < 0 ||
        (index > 0 && cycle.cycleIndex !== cycles[index - 1]!.cycleIndex + 1),
    )
  ) {
    return false;
  }
  const selected = cycles.filter((cycle) => cycle.disposition === "selected");
  if (selected.length !== required) return false;
  const selectedStart = cycles.length - required;
  if (
    cycles
      .slice(0, selectedStart)
      .some((cycle) => cycle.disposition === "selected") ||
    cycles
      .slice(selectedStart)
      .some((cycle) => cycle.disposition !== "selected")
  ) {
    return false;
  }
  return selected.every(
    (cycle) => archiveSelectedCycleQualityReasons(cycle).length === 0,
  );
}

/**
 * Stage one immutable interpretation derived from an authenticated raw
 * evidence archive.  This intentionally cannot update the result projection
 * or create a canonical selection: a later, explicit selection policy may
 * promote an accepted interpretation after it compares solver generations.
 */
export async function stageArchiveResultInterpretation(opts: {
  db: DB;
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
  /** SHA-256 generated by the archive reducer from its exact GCS pointer,
   * manifest and raw coefficient/frame member set. */
  inputEvidenceSignature: string;
  point: PolarPoint;
  fidelity: PointFidelity;
  diagnostics: Record<string, unknown>;
}): Promise<StagedResultInterpretation> {
  if (!/^[0-9a-f]{64}$/.test(opts.inputEvidenceSignature)) {
    throw new Error(
      "archive interpretation requires a SHA-256 raw-evidence signature",
    );
  }
  if (!opts.sourceArchiveId) {
    throw new Error("archive interpretation requires one exact source archive");
  }
  const reducerVersionId = await ensureReducerVersion(opts.db);
  const { draft, certificate } = draftResultInterpretationForPoint(
    opts.point,
    opts.fidelity,
  );
  // An archive reducer reaching the explicit FAST/FINAL physical-period cap
  // is a critical terminal interpretation, never another continuation. The
  // raw coefficient/cycle evidence remains persisted below, but no scalar can
  // be selected into a polar and no recovery handoff is created by the caller.
  const archiveRecoveryExhausted =
    opts.diagnostics.recoveryState === "exhausted";
  const exhaustionReason =
    typeof opts.diagnostics.reason === "string" &&
    opts.diagnostics.reason.trim()
      ? opts.diagnostics.reason.trim()
      : "clean-cycle recovery exhausted";
  const effectiveDraft: InterpretationDraft = archiveRecoveryExhausted
    ? {
        ...draft,
        state: "terminal_failure",
        regime: "trending_unresolved",
        continuationReason: null,
        terminalReason: `URANS ${exhaustionReason}`,
        cl: null,
        cd: null,
        cm: null,
        clCd: null,
        clWaveformRms: null,
        cdWaveformRms: null,
        cmWaveformRms: null,
        uncertaintyBasis: "not_available",
        effectiveBlocks: null,
      }
    : draft;
  const [inserted] = await opts.db
    .insert(resultInterpretations)
    .values({
      resultId: opts.resultId,
      resultAttemptId: opts.resultAttemptId,
      reducerVersionId,
      meshIdentityId: null,
      sourceArchiveId: opts.sourceArchiveId,
      source: "archive_backfill",
      inputEvidenceSignature: opts.inputEvidenceSignature,
      state: effectiveDraft.state,
      regime: effectiveDraft.regime,
      continuationReason: effectiveDraft.continuationReason,
      terminalReason: effectiveDraft.terminalReason,
      selectedWindow: effectiveDraft.selectedWindow,
      statistics: effectiveDraft.statistics,
      diagnostics: {
        ...effectiveDraft.diagnostics,
        archiveBackfill: opts.diagnostics,
      },
      cl: effectiveDraft.cl,
      cd: effectiveDraft.cd,
      cm: effectiveDraft.cm,
      clCd: effectiveDraft.clCd,
      clWaveformRms: effectiveDraft.clWaveformRms,
      cdWaveformRms: effectiveDraft.cdWaveformRms,
      cmWaveformRms: effectiveDraft.cmWaveformRms,
      clStandardError: null,
      cdStandardError: null,
      cmStandardError: null,
      clCi95Low: null,
      clCi95High: null,
      cdCi95Low: null,
      cdCi95High: null,
      cmCi95Low: null,
      cmCi95High: null,
      clCdCi95Low: null,
      clCdCi95High: null,
      clCdIntervalState: "unavailable",
      uncertaintyBasis: effectiveDraft.uncertaintyBasis,
      effectiveBlocks: effectiveDraft.effectiveBlocks,
      maxIatSeconds: null,
    })
    .onConflictDoNothing()
    .returning({ id: resultInterpretations.id });
  let interpretationId = inserted?.id;
  if (!interpretationId) {
    const [existing] = await opts.db
      .select({ id: resultInterpretations.id })
      .from(resultInterpretations)
      .where(
        and(
          eq(resultInterpretations.resultAttemptId, opts.resultAttemptId),
          eq(resultInterpretations.reducerVersionId, reducerVersionId),
          eq(
            resultInterpretations.inputEvidenceSignature,
            opts.inputEvidenceSignature,
          ),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new Error("archive interpretation replay could not be resolved");
    }
    interpretationId = existing.id;
  }

  if (certificate) {
    const rows = certificate.cycles.map((cycle) => ({
      resultId: opts.resultId,
      resultAttemptId: opts.resultAttemptId,
      resultInterpretationId: interpretationId!,
      cycleIndex: cycle.index,
      startTimeS: cycle.t_start,
      endTimeS: cycle.t_end,
      periodS: certificate.period_s,
      disposition: cycle.disposition,
      coefficientSampleCount: cycle.coefficient_samples,
      fieldFrameCount: cycle.field_frames,
      phaseMaxGapFraction: cycle.phase_max_gap,
      metrics: {
        phaseShiftBins: cycle.phase_shift_bins,
        cl: {
          mean: cycle.cl_mean,
          shapeError: cycle.cl_shape_error,
          amplitudeDeviation: cycle.cl_amplitude_deviation,
          highFrequency: cycle.cl_high_frequency,
        },
        cd: {
          mean: cycle.cd_mean,
          shapeError: cycle.cd_shape_error,
          amplitudeDeviation: cycle.cd_amplitude_deviation,
          highFrequency: cycle.cd_high_frequency,
        },
        cm: {
          mean: cycle.cm_mean,
          shapeError: cycle.cm_shape_error,
          amplitudeDeviation: cycle.cm_amplitude_deviation,
          highFrequency: cycle.cm_high_frequency,
        },
        reasons: cycle.reasons,
      },
    }));
    if (rows.length) {
      await opts.db
        .insert(resultInterpretationCycles)
        .values(rows)
        .onConflictDoNothing();
    }
  }
  return {
    id: interpretationId,
    state: effectiveDraft.state,
    regime: effectiveDraft.regime,
  };
}

/**
 * Select an accepted archive reduction when its producing attempt is either
 * the result's current generation or the exact terminal attempt projected
 * into a pointer-less failed cell. The latter is the archive-recovery path:
 * old live-summary classification may have rejected the attempt before its
 * authenticated archive was reduced. Selection is append-only and the result
 * update remains a compare-and-swap, so active/newer work is never retargeted.
 */
export async function selectAcceptedArchiveInterpretation(opts: {
  db: DB;
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
  interpretationId: string | null;
  backfillRunId: string;
  actor?: string;
}): Promise<ArchiveInterpretationSelectionOutcome> {
  if (!opts.interpretationId) return "not_eligible";
  const [interpretation] = await opts.db
    .select({
      id: resultInterpretations.id,
      state: resultInterpretations.state,
      source: resultInterpretations.source,
      regime: resultInterpretations.regime,
      sourceArchiveId: resultInterpretations.sourceArchiveId,
      inputEvidenceSignature: resultInterpretations.inputEvidenceSignature,
      cl: resultInterpretations.cl,
      cd: resultInterpretations.cd,
      cm: resultInterpretations.cm,
      clCd: resultInterpretations.clCd,
      selectedWindow: resultInterpretations.selectedWindow,
      statistics: resultInterpretations.statistics,
      diagnostics: resultInterpretations.diagnostics,
      resultId: resultInterpretations.resultId,
      resultAttemptId: resultInterpretations.resultAttemptId,
    })
    .from(resultInterpretations)
    .where(eq(resultInterpretations.id, opts.interpretationId))
    .limit(1);
  if (
    !interpretation ||
    interpretation.resultId !== opts.resultId ||
    interpretation.resultAttemptId !== opts.resultAttemptId
  ) {
    return "not_eligible";
  }

  const [current] = await opts.db
    .select({
      currentAttemptId: results.currentResultAttemptId,
      currentInterpretationId: results.currentResultInterpretationId,
      currentCanonicalSelectionId: results.currentCanonicalSelectionId,
      airfoilId: results.airfoilId,
      bcId: results.bcId,
      revisionId: results.simulationPresetRevisionId,
      aoaDeg: results.aoaDeg,
      status: results.status,
      simJobId: results.simJobId,
    })
    .from(results)
    .where(eq(results.id, opts.resultId))
    .limit(1);
  if (!current) return "stale_attempt";
  if (
    current.currentInterpretationId === interpretation.id &&
    current.currentCanonicalSelectionId
  ) {
    return "already_selected";
  }

  const [[attempt], [archive], cycles] = await Promise.all([
    opts.db
      .select({
        id: resultAttempts.id,
        airfoilId: resultAttempts.airfoilId,
        bcId: resultAttempts.bcId,
        revisionId: resultAttempts.simulationPresetRevisionId,
        aoaDeg: resultAttempts.aoaDeg,
        status: resultAttempts.status,
        source: resultAttempts.source,
        regime: resultAttempts.regime,
        unsteady: resultAttempts.unsteady,
        converged: resultAttempts.converged,
        stalled: resultAttempts.stalled,
        clStd: resultAttempts.clStd,
        cdStd: resultAttempts.cdStd,
        cmStd: resultAttempts.cmStd,
        finalResidual: resultAttempts.finalResidual,
        iterations: resultAttempts.iterations,
        yPlusAvg: resultAttempts.yPlusAvg,
        yPlusMax: resultAttempts.yPlusMax,
        nCells: resultAttempts.nCells,
        firstOrderFallback: resultAttempts.firstOrderFallback,
        strouhal: resultAttempts.strouhal,
        error: resultAttempts.error,
        qualityWarnings: resultAttempts.qualityWarnings,
        evidencePayload: resultAttempts.evidencePayload,
        engineJobId: resultAttempts.engineJobId,
        engineCaseSlug: resultAttempts.engineCaseSlug,
        simJobId: resultAttempts.simJobId,
        methodKey: resultAttempts.methodKey,
        solverImplementationId: resultAttempts.solverImplementationId,
        solverRuntimeBuildId: resultAttempts.solverRuntimeBuildId,
        solvedAt: resultAttempts.solvedAt,
        fidelity: sql<unknown>`COALESCE(
          ${resultAttempts.evidencePayload} ->> 'fidelity',
          ${resultAttempts.evidencePayload} ->> 'fidelityTier'
        )`,
      })
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.id, opts.resultAttemptId),
          eq(resultAttempts.resultId, opts.resultId),
        ),
      )
      .limit(1),
    opts.db
      .select({
        id: solverEvidenceArchives.id,
        state: solverEvidenceArchives.state,
        backend: solverEvidenceBlobs.backend,
        compression: solverEvidenceBlobs.compression,
        mimeType: solverEvidenceBlobs.mimeType,
        bucket: solverEvidenceBlobs.bucket,
        generation: solverEvidenceBlobs.generation,
        verifiedAt: solverEvidenceBlobs.verifiedAt,
      })
      .from(solverEvidenceArchives)
      .innerJoin(
        solverEvidenceBlobs,
        eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
      )
      .where(
        and(
          eq(solverEvidenceArchives.id, opts.sourceArchiveId),
          eq(solverEvidenceArchives.resultId, opts.resultId),
          eq(solverEvidenceArchives.resultAttemptId, opts.resultAttemptId),
          eq(solverEvidenceArchives.state, "current"),
        ),
      )
      .limit(1),
    opts.db
      .select({
        cycleIndex: resultInterpretationCycles.cycleIndex,
        disposition: resultInterpretationCycles.disposition,
        coefficientSampleCount:
          resultInterpretationCycles.coefficientSampleCount,
        fieldFrameCount: resultInterpretationCycles.fieldFrameCount,
        phaseMaxGapFraction: resultInterpretationCycles.phaseMaxGapFraction,
        metrics: resultInterpretationCycles.metrics,
      })
      .from(resultInterpretationCycles)
      .where(
        and(
          eq(
            resultInterpretationCycles.resultInterpretationId,
            interpretation.id,
          ),
          eq(resultInterpretationCycles.resultId, opts.resultId),
          eq(resultInterpretationCycles.resultAttemptId, opts.resultAttemptId),
        ),
      )
      .orderBy(asc(resultInterpretationCycles.cycleIndex)),
  ]);
  if (
    !attempt ||
    attempt.airfoilId !== current.airfoilId ||
    attempt.bcId !== current.bcId ||
    attempt.revisionId !== current.revisionId ||
    attempt.aoaDeg !== current.aoaDeg ||
    !canSelectAcceptedArchiveInterpretation({
      interpretation,
      expectedSourceArchiveId: opts.sourceArchiveId,
      archive: archive ?? null,
      attempt,
      cycles,
    })
  ) {
    return "not_eligible";
  }
  const promotesPointerlessTerminalAttempt =
    archiveAttemptMayPromotePointerlessResult({
      currentAttemptId: current.currentAttemptId,
      currentInterpretationId: current.currentInterpretationId,
      currentCanonicalSelectionId: current.currentCanonicalSelectionId,
      resultStatus: current.status,
      resultSimJobId: current.simJobId,
      attemptSimJobId: attempt.simJobId,
    });
  if (
    current.currentAttemptId !== opts.resultAttemptId &&
    !promotesPointerlessTerminalAttempt
  ) {
    return "stale_attempt";
  }

  const [selection] = await opts.db
    .insert(resultCanonicalSelections)
    .values({
      resultId: opts.resultId,
      resultAttemptId: opts.resultAttemptId,
      resultInterpretationId: interpretation.id,
      backfillRunId: opts.backfillRunId,
      // The namespace names the scientific reduction semantics, not merely
      // the storage route. Periodic rows own an exact clean-cycle suffix;
      // steady-equivalent URANS rows own an exact physical-observation window.
      selectionNamespace:
        interpretation.regime === "steady_equivalent"
          ? "archive-no-shedding-v1"
          : "archive-clean-cycle-v3",
      reason:
        interpretation.regime === "steady_equivalent"
          ? "accepted exact raw archive no-shedding observation for an exact URANS attempt"
          : "accepted exact raw archive clean-cycle interpretation for an exact attempt",
      actor: opts.actor ?? "system:archive-interpretation-backfill",
    })
    .returning({ id: resultCanonicalSelections.id });
  if (!selection) {
    throw new Error("archive canonical selection could not be persisted");
  }
  const currentInterpretationGuard = current.currentInterpretationId
    ? eq(results.currentResultInterpretationId, current.currentInterpretationId)
    : isNull(results.currentResultInterpretationId);
  const currentCanonicalSelectionGuard = current.currentCanonicalSelectionId
    ? eq(
        results.currentCanonicalSelectionId,
        current.currentCanonicalSelectionId,
      )
    : isNull(results.currentCanonicalSelectionId);
  const attemptEvidence = asRecord(attempt.evidencePayload);
  const attemptFidelity =
    typeof attemptEvidence.fidelity === "string"
      ? attemptEvidence.fidelity
      : null;
  const [updated] = await opts.db
    .update(results)
    .set({
      ...(promotesPointerlessTerminalAttempt
        ? {
            currentResultAttemptId: attempt.id,
            status: attempt.status,
            source: attempt.source,
            regime: attempt.regime,
            cl: interpretation.cl,
            cd: interpretation.cd,
            cm: interpretation.cm,
            clCd: interpretation.clCd,
            clStd: attempt.clStd,
            cdStd: attempt.cdStd,
            cmStd: attempt.cmStd,
            stalled: attempt.stalled,
            unsteady: attempt.unsteady,
            converged: attempt.converged,
            finalResidual: attempt.finalResidual,
            iterations: attempt.iterations,
            yPlusAvg: attempt.yPlusAvg,
            yPlusMax: attempt.yPlusMax,
            nCells: attempt.nCells,
            firstOrderFallback: attempt.firstOrderFallback,
            strouhal: attempt.strouhal,
            error: attempt.error,
            qualityWarnings: attempt.qualityWarnings,
            frameTrack: attemptEvidence.frame_track ?? null,
            fidelity: attemptFidelity,
            steadyHistory: attemptEvidence.steady_history ?? null,
            engineJobId: attempt.engineJobId,
            engineCaseSlug: attempt.engineCaseSlug,
            simJobId: attempt.simJobId,
            methodKey: attempt.methodKey,
            solverImplementationId: attempt.solverImplementationId,
            solverRuntimeBuildId: attempt.solverRuntimeBuildId,
            solvedAt: attempt.solvedAt,
            priority: 0,
          }
        : {}),
      currentResultInterpretationId: interpretation.id,
      currentCanonicalSelectionId: selection.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(results.id, opts.resultId),
        promotesPointerlessTerminalAttempt
          ? and(
              isNull(results.currentResultAttemptId),
              eq(results.status, "failed"),
              sql`${results.simJobId} IS NOT DISTINCT FROM ${attempt.simJobId}::uuid`,
            )
          : eq(results.currentResultAttemptId, opts.resultAttemptId),
        currentInterpretationGuard,
        currentCanonicalSelectionGuard,
      ),
    )
    .returning({ id: results.id });
  return updated ? "selected" : "stale_attempt";
}

/**
 * Live engine summaries can be projected immediately only when they certify a
 * physically steady RANS answer with an all-channel hold.  Both periodic and
 * no-shedding URANS summaries are staging evidence—even when their producer
 * certificates look accepted—until the authenticated GCS archive reducer
 * selects the exact raw window. This prevents a local/transient engine payload
 * from becoming a canonical polar value ahead of immutable evidence.
 */
export function canSelectImmediateEngineInterpretation(input: {
  state: string;
  source: string;
  regime: string;
}): boolean {
  return (
    input.state === "accepted" &&
    input.source === "engine_reported" &&
    input.regime === "rans_hold"
  );
}

/** Make an append-only canonical selection and project its pointer only after
 * the caller holds the result-row publication lock.  The attempt must match
 * the active canonical attempt; otherwise a stale ingestion worker cannot
 * attach a newer interpretation to somebody else's selected result. */
export async function selectEngineInterpretation(opts: {
  db: DB;
  resultId: string;
  resultAttemptId: string;
  interpretationId: string | null;
  actor?: string;
}): Promise<void> {
  if (!opts.interpretationId) return;
  const [interpretation] = await opts.db
    .select({
      id: resultInterpretations.id,
      state: resultInterpretations.state,
      source: resultInterpretations.source,
      regime: resultInterpretations.regime,
      resultId: resultInterpretations.resultId,
      resultAttemptId: resultInterpretations.resultAttemptId,
    })
    .from(resultInterpretations)
    .where(eq(resultInterpretations.id, opts.interpretationId))
    .limit(1);
  if (
    !interpretation ||
    !canSelectImmediateEngineInterpretation(interpretation) ||
    interpretation.resultId !== opts.resultId ||
    interpretation.resultAttemptId !== opts.resultAttemptId
  ) {
    return;
  }
  const [current] = await opts.db
    .select({
      currentInterpretationId: results.currentResultInterpretationId,
      currentCanonicalSelectionId: results.currentCanonicalSelectionId,
      currentAttemptId: results.currentResultAttemptId,
    })
    .from(results)
    .where(eq(results.id, opts.resultId))
    .limit(1);
  if (!current || current.currentAttemptId !== opts.resultAttemptId) return;
  if (current.currentInterpretationId === interpretation.id) return;
  const [selection] = await opts.db
    .insert(resultCanonicalSelections)
    .values({
      resultId: opts.resultId,
      resultAttemptId: opts.resultAttemptId,
      resultInterpretationId: interpretation.id,
      backfillRunId: null,
      selectionNamespace: "engine-proven-steady-v1",
      reason:
        "accepted all-channel RANS hold or explicit no-shedding engine interpretation",
      actor: opts.actor ?? "system:engine-ingest",
    })
    .returning({ id: resultCanonicalSelections.id });
  if (!selection)
    throw new Error("result canonical selection could not be persisted");
  // `=` against NULL never matches in SQL.  A first accepted interpretation
  // therefore needs an explicit null-aware compare-and-swap guard; otherwise
  // newly certified live results would retain a null projection pointer.
  const currentInterpretationGuard = current.currentInterpretationId
    ? eq(results.currentResultInterpretationId, current.currentInterpretationId)
    : isNull(results.currentResultInterpretationId);
  const [updated] = await opts.db
    .update(results)
    .set({
      currentResultInterpretationId: interpretation.id,
      currentCanonicalSelectionId: selection.id,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(results.id, opts.resultId),
        eq(results.currentResultAttemptId, opts.resultAttemptId),
        currentInterpretationGuard,
      ),
    )
    .returning({ id: results.id });
  if (!updated) {
    // The event is honest historical provenance even if a concurrent selection
    // wins the CAS; do not retry it into a potentially different generation.
    return;
  }
}
