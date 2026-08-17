/**
 * Append-only coefficient interpretation staging.
 *
 * A result attempt is immutable evidence; an interpretation is a versioned
 * scientific reduction of that evidence.  This module deliberately does not
 * update the legacy `results` projection.  Publication code creates an
 * explicit canonical-selection event only after the normal evidence/classifier
 * transaction accepts the exact attempt.
 */
import {
  FRAME_TRACK_PERIOD_BOUNDARY_ULPS,
  selectedCleanCycleQualityReasons,
} from "@aerodb/core";
import {
  type DB,
  historicalArchiveAuditDecisions,
  hasExactLivePrecalcPublicationWinner,
  legacyUransArchiveGapRecoveryActions,
  resultArchiveReductionQueue,
  resultCanonicalSelections,
  resultAttempts,
  resultInterpretationBackfillItems,
  resultInterpretationBackfillRuns,
  resultInterpretationCycles,
  resultInterpretationRecoveryActions,
  resultInterpretations,
  resultReducerVersions,
  results,
  simPrecalcObligationAttempts,
  simPrecalcObligations,
  simUransRequests,
  solverEvidenceArchives,
  solverEvidenceArtifacts,
  solverEvidenceBlobs,
  type SolverEvidenceBlob,
} from "@aerodb/db";
import {
  parsePointFidelity,
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
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import {
  mayPublishReducerVersion,
  type ReducerVersionPrecedence,
} from "./archive-reduction-queue-policy";

/**
 * The global archive-publication receipt and its child backfill receipt use
 * the same bounded lease duration.  Keep this local rather than importing the
 * queue worker: result-interpretations is intentionally below the scheduler
 * layer, while the database predicate below is the durable mutation fence.
 */
const ARCHIVE_PUBLICATION_CLAIM_LEASE_MS = 30 * 60_000;

/**
 * A reducer response is not authority to write.  Every automatic archive
 * stage/selection carries the exact queue claimant that paid for the reducer
 * I/O.  Initial reduction has both parent and child tokens; recovery replay
 * has only the current parent token because its child receipt is already
 * settled.  Both forms must be checked at the write boundary.
 */
export type ArchivePublicationClaimFence = {
  queueItemId: string;
  queueClaimToken: string;
  backfillItemId?: string;
  backfillClaimToken?: string;
};

/**
 * Historical released evidence is scientifically valuable, but it is not an
 * automatic-publication candidate.  Keep the run contract here, beside the
 * durable staging fence, so an arbitrary caller cannot label an ordinary
 * backfill row as an audit and bypass the global publication queue.
 */
export const HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT =
  "archive-clean-cycle-historical-released-audit-v1";

const HISTORICAL_AUDIT_UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type HistoricalReleasedArchiveAuditExactSource = {
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
};

function historicalAuditRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Normalize the three immutable identities an audit is allowed to inspect.
 * UUID spellings are case-insensitive at the database boundary, but audit
 * scopes are JSON text and are later compared to canonical UUID text in the
 * database trigger.  Returning lower-case values keeps those two boundaries
 * identical without accepting any broader source shape.
 */
export function validateHistoricalReleasedArchiveAuditExactSource(
  source: unknown,
): HistoricalReleasedArchiveAuditExactSource {
  const record = historicalAuditRecord(source);
  if (!record) {
    throw new Error(
      "historical released-evidence audit requires exactSource with resultId, resultAttemptId, and sourceArchiveId",
    );
  }
  const fields = ["resultId", "resultAttemptId", "sourceArchiveId"] as const;
  const unexpectedFields = Object.keys(record).filter(
    (field) => !fields.includes(field as (typeof fields)[number]),
  );
  if (unexpectedFields.length) {
    throw new Error(
      `historical released-evidence audit exactSource has unsupported fields: ${unexpectedFields.join(", ")}`,
    );
  }
  const readUuid = (field: (typeof fields)[number]): string => {
    const value = record[field];
    if (typeof value !== "string" || !HISTORICAL_AUDIT_UUID_TEXT.test(value)) {
      throw new Error(
        `historical released-evidence audit exactSource.${field} must be a UUID`,
      );
    }
    return value.toLowerCase();
  };
  return {
    resultId: readUuid("resultId"),
    resultAttemptId: readUuid("resultAttemptId"),
    sourceArchiveId: readUuid("sourceArchiveId"),
  };
}

/**
 * Validate the persisted, no-publication audit contract and return its one
 * allowed source.  Call this when a run is admitted, claimed, renewed, or
 * staged; an audit contract without this exact identity is malformed rather
 * than a broad historical backfill.
 */
export function validateHistoricalReleasedArchiveAuditScope(
  scope: unknown,
): HistoricalReleasedArchiveAuditExactSource {
  const record = historicalAuditRecord(scope);
  if (
    !record ||
    record.contract !== HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT
  ) {
    throw new Error(
      "historical released-evidence audit run requires its exact audit contract",
    );
  }
  if (
    record.canonicalSelection !== "forbidden" ||
    record.physicalRecovery !== "record-only" ||
    record.campaignMutation !== "forbidden" ||
    record.rawEvidenceImmutable !== true
  ) {
    throw new Error(
      "historical released-evidence audit run is missing its no-publication authority fence",
    );
  }
  const broadFields = ["resultIds", "resultAttemptIds", "limit"];
  if (
    broadFields.some((field) =>
      Object.prototype.hasOwnProperty.call(record, field),
    )
  ) {
    throw new Error(
      "historical released-evidence audit run must not carry a broad discovery scope",
    );
  }
  return validateHistoricalReleasedArchiveAuditExactSource(record.exactSource);
}

/**
 * A non-throwing exact-source predicate for the durable SQL stage/renewal
 * gates.  It intentionally validates both the contract and all three UUIDs;
 * a source-mismatched child receipt can never become an audit just because it
 * shares a reducer version or archive blob.
 */
export function historicalReleasedArchiveAuditScopeMatchesExactSource(input: {
  scope: unknown;
  exactSource: HistoricalReleasedArchiveAuditExactSource;
}): boolean {
  try {
    const actual = validateHistoricalReleasedArchiveAuditScope(input.scope);
    const expected = validateHistoricalReleasedArchiveAuditExactSource(
      input.exactSource,
    );
    return (
      actual.resultId === expected.resultId &&
      actual.resultAttemptId === expected.resultAttemptId &&
      actual.sourceArchiveId === expected.sourceArchiveId
    );
  } catch {
    return false;
  }
}

/**
 * An audit's interpretation is scientifically useful immutable evidence, but
 * it is not a queue-authorized archive publication candidate.  This literal
 * is intentionally distinct from `archive_backfill`: the canonical selector
 * accepts only the latter, so an audit row cannot be replayed as an ordinary
 * queue reduction after the released result is later re-opened.
 *
 * The database source constraint and archive replay identities must keep this
 * source distinct too.  Do not collapse the rows through a shared uniqueness
 * key: different authority is part of their immutable provenance.
 */
export const HISTORICAL_ARCHIVE_AUDIT_INTERPRETATION_SOURCE =
  "historical_archive_audit";

const ARCHIVE_PUBLICATION_INTERPRETATION_SOURCE = "archive_backfill";

export type HistoricalArchiveAuditClaimFence = {
  backfillItemId: string;
  backfillClaimToken: string;
};

/**
 * Reducer facts that are safe to append beside a historical interpretation.
 * The staging transaction supplies the exact result/attempt/archive/reducer
 * identity and the interpretation id; callers cannot choose those pointers.
 */
export type HistoricalArchiveAuditDecisionDraft = {
  inputEvidenceSignature: string;
  reducerState:
    | "accepted"
    | "continuation_required"
    | "recovery_exhausted"
    | "rerun_required"
    | "missing_evidence";
  advisoryContinuationAction: "continue_exact_case" | null;
  advisoryTailPeriods: number | null;
  diagnostics: Record<string, unknown>;
};

export type ArchiveInterpretationStageAuthority =
  | {
      kind: "queue_publication";
      publicationClaim: ArchivePublicationClaimFence;
    }
  | {
      kind: "historical_released_audit";
      auditClaim: HistoricalArchiveAuditClaimFence;
    };

export class ArchivePublicationClaimLostError extends Error {
  constructor() {
    super(
      "archive publication claim was lost or expired before a durable write",
    );
  }
}

/** A historical audit may write immutable interpretation evidence only while
 * its exact audit receipt is live and the result remains released.  It never
 * has authority to publish, recover, or change the result projection. */
export class HistoricalArchiveAuditClaimLostError extends Error {
  constructor() {
    super(
      "historical released-evidence audit claim was lost or the result is no longer released",
    );
  }
}

function hasCompleteChildPublicationClaim(
  claim: ArchivePublicationClaimFence,
): boolean {
  return (
    (claim.backfillItemId == null && claim.backfillClaimToken == null) ||
    (typeof claim.backfillItemId === "string" &&
      claim.backfillItemId.length > 0 &&
      typeof claim.backfillClaimToken === "string" &&
      claim.backfillClaimToken.length > 0)
  );
}

/**
 * Fence a stage/select mutation under the exact live parent queue claim (and,
 * for a fresh reducer result, its exact child claim).  The SQL predicates
 * deliberately use `clock_timestamp()` rather than a transaction-start time:
 * an old claimant may not resurrect or publish after its lease has elapsed.
 * Updating the lease while both rows are locked keeps the short database
 * mutation safely inside the authenticated owner window.
 */
async function renewArchivePublicationClaimFence(
  db: DB,
  claim: ArchivePublicationClaimFence,
): Promise<void> {
  if (
    !claim.queueItemId ||
    !claim.queueClaimToken ||
    !hasCompleteChildPublicationClaim(claim)
  ) {
    throw new ArchivePublicationClaimLostError();
  }
  const [queue] = await db
    .update(resultArchiveReductionQueue)
    .set({
      claimExpiresAt: sql`clock_timestamp() + (${ARCHIVE_PUBLICATION_CLAIM_LEASE_MS} * interval '1 millisecond')`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resultArchiveReductionQueue.id, claim.queueItemId),
        eq(resultArchiveReductionQueue.state, "hydrating"),
        eq(resultArchiveReductionQueue.claimToken, claim.queueClaimToken),
        sql`${resultArchiveReductionQueue.claimExpiresAt} > clock_timestamp()`,
      ),
    )
    .returning({ id: resultArchiveReductionQueue.id });
  if (!queue) throw new ArchivePublicationClaimLostError();

  if (!claim.backfillItemId || !claim.backfillClaimToken) return;
  const [child] = await db
    .update(resultInterpretationBackfillItems)
    .set({
      claimExpiresAt: sql`clock_timestamp() + (${ARCHIVE_PUBLICATION_CLAIM_LEASE_MS} * interval '1 millisecond')`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resultInterpretationBackfillItems.id, claim.backfillItemId),
        eq(resultInterpretationBackfillItems.state, "hydrating"),
        eq(
          resultInterpretationBackfillItems.claimToken,
          claim.backfillClaimToken,
        ),
        sql`${resultInterpretationBackfillItems.claimExpiresAt} > clock_timestamp()`,
      ),
    )
    .returning({ id: resultInterpretationBackfillItems.id });
  if (!child) throw new ArchivePublicationClaimLostError();
}

async function renewHistoricalArchiveAuditClaimFence(
  db: DB,
  input: {
    auditClaim: HistoricalArchiveAuditClaimFence;
    backfillRunId: string;
    reducerVersionId: string;
    exactSource: HistoricalReleasedArchiveAuditExactSource;
  },
): Promise<void> {
  const exactSource = validateHistoricalReleasedArchiveAuditExactSource(
    input.exactSource,
  );
  const [item] = await db
    .update(resultInterpretationBackfillItems)
    .set({
      claimExpiresAt: sql`clock_timestamp() + (${ARCHIVE_PUBLICATION_CLAIM_LEASE_MS} * interval '1 millisecond')`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(
          resultInterpretationBackfillItems.id,
          input.auditClaim.backfillItemId,
        ),
        eq(resultInterpretationBackfillItems.state, "hydrating"),
        eq(
          resultInterpretationBackfillItems.claimToken,
          input.auditClaim.backfillClaimToken,
        ),
        sql`${resultInterpretationBackfillItems.claimExpiresAt} > clock_timestamp()`,
        sql`EXISTS (
          SELECT 1
          FROM result_interpretation_backfill_runs audit_run
          WHERE audit_run.id = ${resultInterpretationBackfillItems.runId}
            AND audit_run.id = ${input.backfillRunId}::uuid
            AND audit_run.reducer_version_id = ${input.reducerVersionId}::uuid
            AND audit_run.state = 'running'
            AND audit_run.scope ->> 'contract' = ${HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT}
            AND audit_run.scope ->> 'canonicalSelection' = 'forbidden'
            AND audit_run.scope ->> 'physicalRecovery' = 'record-only'
            AND audit_run.scope ->> 'campaignMutation' = 'forbidden'
            AND audit_run.scope ->> 'rawEvidenceImmutable' = 'true'
            AND audit_run.scope #>> '{exactSource,resultId}' = ${exactSource.resultId}
            AND audit_run.scope #>> '{exactSource,resultAttemptId}' = ${exactSource.resultAttemptId}
            AND audit_run.scope #>> '{exactSource,sourceArchiveId}' = ${exactSource.sourceArchiveId}
        )`,
      ),
    )
    .returning({ id: resultInterpretationBackfillItems.id });
  if (!item) throw new HistoricalArchiveAuditClaimLostError();
}

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
    periodBoundaryUlps: FRAME_TRACK_PERIOD_BOUNDARY_ULPS,
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
// This identity is durable queue semantics, not merely coefficient math. v2
// creates a new append-only reduction generation for sources whose v1 receipt
// terminated on the legacy generic missing-provenance 409.
export const RESULT_INTERPRETATION_REDUCER_VERSION = "result-interpretation-v2";
export const RESULT_INTERPRETATION_REDUCER_BUILD_ID = "clean-cycle-v6";

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

/**
 * The historical-audit caller owns the mutable claimed child. Staging invokes
 * this callback inside its own transaction only after the immutable
 * interpretation and cycle rows exist, so the child terminal receipt and its
 * one immutable decision commit as the same forensic fact.
 */
export type HistoricalArchiveAuditStageFinalizer = (input: {
  db: DB;
  interpretation: StagedResultInterpretation;
}) => Promise<boolean>;

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

function unavailableCycleDiagnosticKeys(
  cycle: UransCycleCertificate["cycles"][number],
): string[] {
  const diagnostics: ReadonlyArray<readonly [string, unknown]> = [
    ["cl_mean", cycle.cl_mean],
    ["cd_mean", cycle.cd_mean],
    ["cm_mean", cycle.cm_mean],
    ["cl_shape_error", cycle.cl_shape_error],
    ["cd_shape_error", cycle.cd_shape_error],
    ["cm_shape_error", cycle.cm_shape_error],
    ["cl_amplitude_deviation", cycle.cl_amplitude_deviation],
    ["cd_amplitude_deviation", cycle.cd_amplitude_deviation],
    ["cm_amplitude_deviation", cycle.cm_amplitude_deviation],
    ["cl_high_frequency", cycle.cl_high_frequency],
    ["cd_high_frequency", cycle.cd_high_frequency],
    ["cm_high_frequency", cycle.cm_high_frequency],
  ];
  return diagnostics.flatMap(([key, value]) =>
    isFiniteNumber(value) ? [] : [key],
  );
}

function selectedCertificateCycleQualityReasons(
  certificate: UransCycleCertificate,
): string[] {
  return selectedCertificateCycles(certificate).flatMap((cycle) => {
    const unavailable = unavailableCycleDiagnosticKeys(cycle);
    if (unavailable.length) {
      return [`unavailable-cycle-metrics:${unavailable.join(",")}`];
    }
    return selectedCleanCycleQualityReasons({
      coefficientSamples: cycle.coefficient_samples,
      fieldFrames: cycle.field_frames,
      phaseMaxGap: cycle.phase_max_gap,
      phaseShiftBins: cycle.phase_shift_bins,
      cl: {
        shapeError: cycle.cl_shape_error!,
        amplitudeDeviation: cycle.cl_amplitude_deviation!,
        highFrequency: cycle.cl_high_frequency!,
      },
      cd: {
        shapeError: cycle.cd_shape_error!,
        amplitudeDeviation: cycle.cd_amplitude_deviation!,
        highFrequency: cycle.cd_high_frequency!,
      },
      cm: {
        shapeError: cycle.cm_shape_error!,
        amplitudeDeviation: cycle.cm_amplitude_deviation!,
        highFrequency: cycle.cm_high_frequency!,
      },
      reasons: cycle.reasons,
    });
  });
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

/**
 * Compare reducer facts with enough precision to preserve the exact
 * time-weighted archive calculation while rejecting a separately rounded or
 * substituted scalar.  The same tolerance is deliberately used for the
 * periodic and no-shedding certificate witnesses below.
 */
function sameCertifiedMean(actual: number, expected: number): boolean {
  return (
    Math.abs(actual - expected) <=
    1e-12 * Math.max(1, Math.abs(actual), Math.abs(expected))
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

/**
 * Keep an immutable archive interpretation inspectable while making it
 * impossible for a terminal reducer outcome to retain publishable scalar
 * coefficients. The selected-window and cycle evidence remain attached to
 * the interpretation; only the scalar projection is deliberately cleared.
 */
function terminalArchiveInterpretationDraft(
  draft: InterpretationDraft,
  terminalReason: string,
): InterpretationDraft {
  return {
    ...draft,
    state: "terminal_failure",
    regime: "trending_unresolved",
    continuationReason: null,
    terminalReason,
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

/**
 * The historical audit decision is a reducer fact, so its optional staged
 * interpretation must use a deterministic state mapping. In particular, a
 * rerun recommendation with retained cycle evidence is terminal evidence, not
 * an accepted coefficient; a cadence-free rerun has no interpretation at all.
 */
function historicalAuditExpectedStageState(
  reducerState: HistoricalArchiveAuditDecisionDraft["reducerState"],
): "accepted" | "continuation_required" | "terminal_failure" | null {
  switch (reducerState) {
    case "accepted":
      return "accepted";
    case "continuation_required":
      return "continuation_required";
    case "recovery_exhausted":
    case "rerun_required":
      return "terminal_failure";
    case "missing_evidence":
      return null;
  }
}

/**
 * The mutable receipt uses the scheduler lifecycle vocabulary, while the
 * immutable audit decision uses reducer vocabulary. Keep their mapping beside
 * the staged-interpretation mapping so a later caller cannot claim an audit
 * finalized without leaving one compatible terminal receipt.
 */
function historicalAuditExpectedChildReceiptState(
  reducerState: HistoricalArchiveAuditDecisionDraft["reducerState"],
):
  | "reduced"
  | "continuation_required"
  | "terminal_failure"
  | "rerun_required"
  | "missing_evidence" {
  switch (reducerState) {
    case "accepted":
      return "reduced";
    case "continuation_required":
      return "continuation_required";
    case "recovery_exhausted":
      return "terminal_failure";
    case "rerun_required":
      return "rerun_required";
    case "missing_evidence":
      return "missing_evidence";
  }
}

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

/**
 * A periodic certificate is not merely a quality label.  The archive reducer
 * publishes the time-weighted mean of its exact terminal 3/5-cycle horizon.
 * Recompute that mean from the proof-bearing per-cycle values before staging
 * an accepted scalar so a malformed engine response cannot pair clean-cycle
 * metadata with unrelated coefficients.
 *
 * `clean_periodic_tail` creates equal-length contiguous cycles.  Checking
 * their geometry here is important: index contiguity alone does not prove that
 * the selected rows describe one physical terminal window.
 */
function periodicCertificateScalarProofReason(
  point: PolarPoint,
  certificate: UransCycleCertificate,
): string | null {
  const selected = selectedCertificateCycles(certificate);
  if (!selected.length) return "certificate has no selected publication cycles";

  let previousEnd: number | null = null;
  let durationTotal = 0;
  let clIntegral = 0;
  let cdIntegral = 0;
  let cmIntegral = 0;
  for (const cycle of selected) {
    const clMean = cycle.cl_mean;
    const cdMean = cycle.cd_mean;
    const cmMean = cycle.cm_mean;
    if (
      !isFiniteNumber(clMean) ||
      !isFiniteNumber(cdMean) ||
      !isFiniteNumber(cmMean)
    ) {
      return "certificate selected cycles have unavailable coefficient means";
    }
    const duration = cycle.t_end - cycle.t_start;
    if (
      !isFiniteNumber(duration) ||
      duration <= 0 ||
      !sameCertifiedMean(duration, certificate.period_s)
    ) {
      return "certificate selected cycles do not each span the certified period";
    }
    if (previousEnd != null && !sameCertifiedMean(previousEnd, cycle.t_start)) {
      return "certificate selected cycles are not one contiguous physical window";
    }
    previousEnd = cycle.t_end;
    durationTotal += duration;
    clIntegral += clMean * duration;
    cdIntegral += cdMean * duration;
    cmIntegral += cmMean * duration;
  }
  if (
    !isFiniteNumber(durationTotal) ||
    durationTotal <= 0 ||
    !sameCertifiedMean(durationTotal, selected.length * certificate.period_s)
  ) {
    return "certificate selected-cycle duration does not equal its exact terminal window";
  }
  const cl = clIntegral / durationTotal;
  const cd = cdIntegral / durationTotal;
  const cm = cmIntegral / durationTotal;
  if (
    !isFiniteNumber(cl) ||
    !isFiniteNumber(cd) ||
    !isFiniteNumber(cm) ||
    !sameCertifiedMean(point.cl!, cl) ||
    !sameCertifiedMean(point.cd!, cd) ||
    !sameCertifiedMean(point.cm!, cm)
  ) {
    return "published URANS coefficients do not equal the exact selected-cycle means";
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
  const scalarProofReason =
    contractReason == null &&
    certificate.certified &&
    acceptedCoefficients(point) &&
    point.converged === true
      ? periodicCertificateScalarProofReason(point, certificate)
      : null;
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
  if (contractReason || scalarProofReason) {
    return {
      certificate,
      draft: {
        state: "terminal_failure",
        regime: "trending_unresolved",
        continuationReason: null,
        terminalReason: `URANS cycle certificate invalid: ${contractReason ?? scalarProofReason}`,
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
          eq(resultInterpretations.source, "engine_reported"),
          isNull(resultInterpretations.sourceArchiveId),
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
  startTimeS: number;
  endTimeS: number;
  periodS: number;
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
  | "superseded_by_newer_reducer"
  | "not_eligible";

/**
 * The only allowed archive-publication replacement is a URANS child of the
 * exact source-pinned PRECALC RANS obligation. The source RANS may be an
 * accepted hold or the normal `needs_urans` handoff; chronology and generic
 * classifier labels are not authorization. Keeping this pure gives the queue,
 * selector, and regression tests one narrow guard against accidentally
 * promoting arbitrary historical evidence.
 */
export function mayPromoteArchiveUransFromExactPrecalcRans(input: {
  targetFidelity: PointFidelity | null;
  currentFidelity: PointFidelity | null;
  hasExactPrecalcLineage: boolean;
}): boolean {
  return (
    input.targetFidelity != null &&
    input.targetFidelity !== "rans" &&
    input.currentFidelity === "rans" &&
    input.hasExactPrecalcLineage
  );
}

/**
 * Verify the durable causal chain that authorizes automatic replacement of a
 * selected RANS point.  Timestamp ordering is deliberately not evidence: a
 * manual/imported URANS result can be newer and still must remain an
 * alternative until a user chooses it.  The child job must instead be an
 * immutable attempt of the exact source-pinned PRECALC obligation.
 */
export async function hasExactPrecalcUransPromotionLineage(opts: {
  db: DB;
  resultId: string;
  currentRansAttemptId: string;
  targetUransAttemptId: string;
}): Promise<boolean> {
  const [row] = await opts.db
    .select({ id: simPrecalcObligations.id })
    .from(simPrecalcObligations)
    .innerJoin(
      simPrecalcObligationAttempts,
      eq(simPrecalcObligationAttempts.obligationId, simPrecalcObligations.id),
    )
    .innerJoin(
      resultAttempts,
      and(
        eq(resultAttempts.id, opts.targetUransAttemptId),
        eq(resultAttempts.resultId, opts.resultId),
        eq(resultAttempts.simJobId, simPrecalcObligationAttempts.simJobId),
        eq(resultAttempts.airfoilId, simPrecalcObligations.airfoilId),
        eq(
          resultAttempts.simulationPresetRevisionId,
          simPrecalcObligations.revisionId,
        ),
        eq(resultAttempts.aoaDeg, simPrecalcObligations.aoaDeg),
      ),
    )
    .where(
      and(
        eq(simPrecalcObligations.sourceResultId, opts.resultId),
        eq(
          simPrecalcObligations.sourceResultAttemptId,
          opts.currentRansAttemptId,
        ),
      ),
    )
    .limit(1);
  return row != null;
}

/**
 * Verify the separate causal chain for a fresh FAST replacement of legacy
 * URANS whose immutable archive could not prove its numerical mode.  Unlike
 * the ordinary RANS -> URANS promotion above, the predecessor is itself a
 * legacy URANS attempt.  Automatic replacement is therefore authorized only
 * by the exact retained recovery action and its exact fresh request/job; a
 * merely newer URANS attempt is never enough.
 */
export async function hasExactLegacyUransArchiveGapRecoveryLineage(opts: {
  db: DB;
  resultId: string;
  currentLegacyAttemptId: string;
  targetUransAttemptId: string;
}): Promise<boolean> {
  const [interpretationRecovery] = await opts.db
    .select({ id: resultInterpretationRecoveryActions.id })
    .from(resultInterpretationRecoveryActions)
    .innerJoin(
      simUransRequests,
      and(
        eq(
          simUransRequests.id,
          resultInterpretationRecoveryActions.targetUransRequestId,
        ),
        eq(simUransRequests.fidelity, "precalc"),
        isNull(simUransRequests.continueFromResultId),
        isNull(simUransRequests.continueFromResultAttemptId),
      ),
    )
    .innerJoin(
      resultAttempts,
      and(
        eq(resultAttempts.id, opts.targetUransAttemptId),
        eq(resultAttempts.resultId, opts.resultId),
        eq(resultAttempts.simJobId, simUransRequests.simJobId),
        eq(resultAttempts.airfoilId, simUransRequests.airfoilId),
        eq(
          resultAttempts.simulationPresetRevisionId,
          simUransRequests.revisionId,
        ),
        eq(resultAttempts.aoaDeg, simUransRequests.aoaDeg),
      ),
    )
    .where(
      and(
        eq(resultInterpretationRecoveryActions.resultId, opts.resultId),
        eq(
          resultInterpretationRecoveryActions.resultAttemptId,
          opts.currentLegacyAttemptId,
        ),
        eq(resultInterpretationRecoveryActions.fidelity, "urans_precalc"),
        eq(
          resultInterpretationRecoveryActions.requestedAction,
          "verify_restart_proof_then_rerun",
        ),
        eq(resultInterpretationRecoveryActions.state, "fresh_rerun_routed"),
      ),
    )
    .limit(1);
  if (interpretationRecovery) return true;

  const [legacyGapRecovery] = await opts.db
    .select({ id: legacyUransArchiveGapRecoveryActions.id })
    .from(legacyUransArchiveGapRecoveryActions)
    .innerJoin(
      simUransRequests,
      and(
        eq(
          simUransRequests.id,
          legacyUransArchiveGapRecoveryActions.targetUransRequestId,
        ),
        eq(simUransRequests.fidelity, "precalc"),
        isNull(simUransRequests.continueFromResultId),
        isNull(simUransRequests.continueFromResultAttemptId),
      ),
    )
    .innerJoin(
      resultAttempts,
      and(
        eq(resultAttempts.id, opts.targetUransAttemptId),
        eq(resultAttempts.resultId, opts.resultId),
        eq(resultAttempts.simJobId, simUransRequests.simJobId),
        eq(resultAttempts.airfoilId, simUransRequests.airfoilId),
        eq(
          resultAttempts.simulationPresetRevisionId,
          simUransRequests.revisionId,
        ),
        eq(resultAttempts.aoaDeg, simUransRequests.aoaDeg),
      ),
    )
    .where(
      and(
        eq(legacyUransArchiveGapRecoveryActions.resultId, opts.resultId),
        eq(
          legacyUransArchiveGapRecoveryActions.resultAttemptId,
          opts.currentLegacyAttemptId,
        ),
        eq(legacyUransArchiveGapRecoveryActions.state, "fresh_rerun_routed"),
        eq(
          legacyUransArchiveGapRecoveryActions.sourceCondition,
          "missing_current_verified_gcs_archive",
        ),
      ),
    )
    .limit(1);
  return legacyGapRecovery != null;
}

const UUID_TEXT =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_TEXT = /^[0-9a-f]{64}$/;
const GCS_GENERATION_TEXT = /^[1-9][0-9]{0,19}$/;
const CRC32C_TEXT = /^[A-Za-z0-9+/]{6}==$/;

function archiveFidelityCleanCycleRequirement(value: unknown): 3 | 5 | null {
  return value === "urans_precalc" ? 3 : value === "urans_full" ? 5 : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

type HistoricalArchiveAuditAttemptProof = {
  status: unknown;
  source: unknown;
  regime: unknown;
  unsteady: unknown;
  fidelity: unknown;
};

type HistoricalArchiveAuditBlobProof = Pick<
  SolverEvidenceBlob,
  | "backend"
  | "bucket"
  | "objectKey"
  | "generation"
  | "compression"
  | "mimeType"
  | "sha256"
  | "byteSize"
  | "crc32c"
  | "uncompressedTarSha256"
  | "uncompressedTarByteSize"
  | "verifiedAt"
  | "metadata"
>;

/**
 * Recheck the exact source contract immediately before an audit stages any
 * immutable row. Discovery is only an I/O optimisation; result attempts and
 * archive metadata may not be trusted from a pre-reduction read. Keep this
 * testable in one place so the durable mutation boundary fails closed if an
 * attempt's completed/URANS provenance or its pinned GCS pointer changes.
 */
export function isHistoricalReleasedArchiveAuditSourceEligible(input: {
  expectedFidelity: PointFidelity;
  attempt: HistoricalArchiveAuditAttemptProof;
  blob: HistoricalArchiveAuditBlobProof;
}): boolean {
  const actualFidelity = parsePointFidelity(input.attempt.fidelity);
  const metadata = asRecord(input.blob.metadata);
  const zstdLevel = metadata.zstdLevel;
  const archiveFormat = metadata.archiveFormat;
  return (
    (input.expectedFidelity === "urans_precalc" ||
      input.expectedFidelity === "urans_full") &&
    actualFidelity === input.expectedFidelity &&
    input.attempt.status === "done" &&
    input.attempt.source === "solved" &&
    (input.attempt.regime === "urans" ||
      (input.attempt.regime === "rans" && input.attempt.unsteady === false)) &&
    input.blob.backend === "gcs" &&
    input.blob.compression === "zstd" &&
    input.blob.mimeType === "application/zstd" &&
    typeof input.blob.bucket === "string" &&
    input.blob.bucket.trim() !== "" &&
    input.blob.bucket.trim() === input.blob.bucket &&
    typeof input.blob.objectKey === "string" &&
    input.blob.objectKey.trim() !== "" &&
    input.blob.objectKey.trim() === input.blob.objectKey &&
    !input.blob.objectKey.startsWith("/") &&
    !input.blob.objectKey.includes("\\") &&
    !/(^|\/)\.{1,2}(\/|$)/.test(input.blob.objectKey) &&
    typeof input.blob.generation === "string" &&
    GCS_GENERATION_TEXT.test(input.blob.generation) &&
    SHA256_TEXT.test(input.blob.sha256) &&
    SHA256_TEXT.test(input.blob.uncompressedTarSha256) &&
    Number.isSafeInteger(input.blob.byteSize) &&
    input.blob.byteSize > 0 &&
    Number.isSafeInteger(input.blob.uncompressedTarByteSize) &&
    input.blob.uncompressedTarByteSize > 0 &&
    CRC32C_TEXT.test(input.blob.crc32c) &&
    input.blob.verifiedAt instanceof Date &&
    Number.isFinite(input.blob.verifiedAt.getTime()) &&
    (archiveFormat == null || archiveFormat === "tar+zstd") &&
    typeof zstdLevel === "number" &&
    Number.isSafeInteger(zstdLevel) &&
    zstdLevel >= 1 &&
    zstdLevel <= 22
  );
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

function archiveSelectedCycleMean(
  cycle: ArchiveSelectionCycle,
  channel: "cl" | "cd" | "cm",
): number | null {
  const value = asRecord(asRecord(cycle.metrics)[channel]).mean;
  return isFiniteNumber(value) ? value : null;
}

/**
 * Repeat the scalar proof from periodic archive staging using only persisted
 * ledger rows.  This is intentionally stricter than the quality gate: a
 * direct writer must not be able to pair a clean-looking selected suffix with
 * coefficients from a different time window.
 */
function exactArchivePeriodicScalarProof(input: {
  interpretation: ArchiveSelectionInterpretation;
  selected: readonly ArchiveSelectionCycle[];
  required: number;
}): boolean {
  const { interpretation, selected, required } = input;
  const window = asRecord(interpretation.selectedWindow);
  const selectedIndexes = window.selectedCycleIndexes;
  const terminalCleanCycles = window.terminalCleanCycles;
  const windowPeriodS = window.periodS;
  if (
    selected.length !== required ||
    !Array.isArray(selectedIndexes) ||
    selectedIndexes.length !== required ||
    selectedIndexes.some((index) => !Number.isInteger(index) || index < 0) ||
    selected.some(
      (cycle, index) => selectedIndexes[index] !== cycle.cycleIndex,
    ) ||
    window.selectedCycleStartIndex !== selected[0]?.cycleIndex ||
    window.requiredCleanCycles !== required ||
    !isFiniteNumber(terminalCleanCycles) ||
    !Number.isInteger(terminalCleanCycles) ||
    terminalCleanCycles < required ||
    !isFiniteNumber(windowPeriodS) ||
    windowPeriodS <= 0
  ) {
    return false;
  }

  let previousEnd: number | null = null;
  let durationTotal = 0;
  let clIntegral = 0;
  let cdIntegral = 0;
  let cmIntegral = 0;
  for (const cycle of selected) {
    const duration = cycle.endTimeS - cycle.startTimeS;
    const cl = archiveSelectedCycleMean(cycle, "cl");
    const cd = archiveSelectedCycleMean(cycle, "cd");
    const cm = archiveSelectedCycleMean(cycle, "cm");
    if (
      !isFiniteNumber(cycle.startTimeS) ||
      !isFiniteNumber(cycle.endTimeS) ||
      !isFiniteNumber(cycle.periodS) ||
      duration <= 0 ||
      !sameCertifiedMean(duration, cycle.periodS) ||
      !sameCertifiedMean(cycle.periodS, windowPeriodS) ||
      (previousEnd != null &&
        !sameCertifiedMean(previousEnd, cycle.startTimeS)) ||
      cl == null ||
      cd == null ||
      cm == null
    ) {
      return false;
    }
    previousEnd = cycle.endTimeS;
    durationTotal += duration;
    clIntegral += cl * duration;
    cdIntegral += cd * duration;
    cmIntegral += cm * duration;
  }
  if (
    !isFiniteNumber(durationTotal) ||
    durationTotal <= 0 ||
    !sameCertifiedMean(durationTotal, required * windowPeriodS)
  ) {
    return false;
  }
  const cl = clIntegral / durationTotal;
  const cd = cdIntegral / durationTotal;
  const cm = cmIntegral / durationTotal;
  return (
    isFiniteNumber(cl) &&
    isFiniteNumber(cd) &&
    isFiniteNumber(cm) &&
    interpretation.cl != null &&
    interpretation.cd != null &&
    interpretation.cm != null &&
    sameCertifiedMean(interpretation.cl, cl) &&
    sameCertifiedMean(interpretation.cd, cd) &&
    sameCertifiedMean(interpretation.cm, cm)
  );
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

/**
 * Archive reduction is an automatic publication path only while the durable
 * global queue receipt owns this exact source.  A merely current GCS archive
 * is evidence storage, not authority to choose a coefficient projection. The
 * queue/run tuple makes the reducer's scope explicit and prevents direct
 * callers from bypassing the normal lease and recovery ledger.
 */
async function hasActiveArchivePublicationReceipt(
  db: DB,
  input: {
    resultId: string;
    resultAttemptId: string;
    sourceArchiveId: string;
    reducerVersionId: string;
    backfillRunId: string;
    publicationClaim: ArchivePublicationClaimFence;
  },
): Promise<boolean> {
  const [receipt] = await db
    .select({ id: resultArchiveReductionQueue.id })
    .from(resultArchiveReductionQueue)
    .where(
      and(
        eq(resultArchiveReductionQueue.id, input.publicationClaim.queueItemId),
        eq(resultArchiveReductionQueue.resultId, input.resultId),
        eq(resultArchiveReductionQueue.resultAttemptId, input.resultAttemptId),
        eq(resultArchiveReductionQueue.sourceArchiveId, input.sourceArchiveId),
        eq(
          resultArchiveReductionQueue.reducerVersionId,
          input.reducerVersionId,
        ),
        eq(resultArchiveReductionQueue.backfillRunId, input.backfillRunId),
        eq(resultArchiveReductionQueue.state, "hydrating"),
        eq(
          resultArchiveReductionQueue.claimToken,
          input.publicationClaim.queueClaimToken,
        ),
        sql`${resultArchiveReductionQueue.claimExpiresAt} > clock_timestamp()`,
      ),
    )
    .limit(1);
  if (!receipt) return false;
  const { backfillItemId, backfillClaimToken } = input.publicationClaim;
  if (!backfillItemId && !backfillClaimToken) return true;
  if (!backfillItemId || !backfillClaimToken) return false;
  const [child] = await db
    .select({ id: resultInterpretationBackfillItems.id })
    .from(resultInterpretationBackfillItems)
    .where(
      and(
        eq(resultInterpretationBackfillItems.id, backfillItemId),
        eq(resultInterpretationBackfillItems.runId, input.backfillRunId),
        eq(resultInterpretationBackfillItems.resultId, input.resultId),
        eq(
          resultInterpretationBackfillItems.resultAttemptId,
          input.resultAttemptId,
        ),
        eq(
          resultInterpretationBackfillItems.sourceArchiveId,
          input.sourceArchiveId,
        ),
        eq(resultInterpretationBackfillItems.state, "hydrating"),
        eq(resultInterpretationBackfillItems.claimToken, backfillClaimToken),
        sql`${resultInterpretationBackfillItems.claimExpiresAt} > clock_timestamp()`,
      ),
    )
    .limit(1);
  return child != null;
}

/**
 * Audit staging has a deliberately narrower authority than publication.  The
 * caller must own a live receipt whose persisted contract explicitly forbids
 * canonical selection and physical recovery, and the exact archive must
 * still be a verified current GCS/Zstandard generation.  This lets a released
 * historical attempt retain an immutable interpretation without reopening
 * its polar cell or making a background audit an implicit retry.
 */
async function hasActiveHistoricalArchiveAuditReceipt(
  db: DB,
  input: {
    resultId: string;
    resultAttemptId: string;
    sourceArchiveId: string;
    reducerVersionId: string;
    backfillRunId: string;
    expectedFidelity: PointFidelity;
    auditClaim: HistoricalArchiveAuditClaimFence;
  },
): Promise<boolean> {
  const exactSource = validateHistoricalReleasedArchiveAuditExactSource({
    resultId: input.resultId,
    resultAttemptId: input.resultAttemptId,
    sourceArchiveId: input.sourceArchiveId,
  });
  const [receipt] = await db
    .select({
      id: resultInterpretationBackfillItems.id,
      scope: resultInterpretationBackfillRuns.scope,
      attemptStatus: resultAttempts.status,
      attemptSource: resultAttempts.source,
      attemptRegime: resultAttempts.regime,
      attemptUnsteady: resultAttempts.unsteady,
      attemptFidelity: sql<unknown>`COALESCE(
        ${resultAttempts.evidencePayload} ->> 'fidelity',
        ${resultAttempts.evidencePayload} ->> 'fidelityTier'
      )`,
      blob: solverEvidenceBlobs,
    })
    .from(resultInterpretationBackfillItems)
    .innerJoin(
      resultInterpretationBackfillRuns,
      eq(
        resultInterpretationBackfillRuns.id,
        resultInterpretationBackfillItems.runId,
      ),
    )
    .innerJoin(
      results,
      eq(results.id, resultInterpretationBackfillItems.resultId),
    )
    .innerJoin(
      resultAttempts,
      and(
        eq(
          resultAttempts.id,
          resultInterpretationBackfillItems.resultAttemptId,
        ),
        eq(resultAttempts.resultId, resultInterpretationBackfillItems.resultId),
      ),
    )
    .innerJoin(
      solverEvidenceArchives,
      and(
        eq(solverEvidenceArchives.id, input.sourceArchiveId),
        eq(
          solverEvidenceArchives.resultId,
          resultInterpretationBackfillItems.resultId,
        ),
        eq(
          solverEvidenceArchives.resultAttemptId,
          resultInterpretationBackfillItems.resultAttemptId,
        ),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .innerJoin(
      solverEvidenceArtifacts,
      and(
        eq(solverEvidenceArtifacts.id, solverEvidenceArchives.sourceArtifactId),
        eq(
          solverEvidenceArtifacts.resultId,
          resultInterpretationBackfillItems.resultId,
        ),
        eq(
          solverEvidenceArtifacts.resultAttemptId,
          resultInterpretationBackfillItems.resultAttemptId,
        ),
      ),
    )
    .innerJoin(
      solverEvidenceBlobs,
      eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
    )
    .where(
      and(
        eq(
          resultInterpretationBackfillItems.id,
          input.auditClaim.backfillItemId,
        ),
        eq(resultInterpretationBackfillItems.runId, input.backfillRunId),
        eq(resultInterpretationBackfillItems.resultId, input.resultId),
        eq(
          resultInterpretationBackfillItems.resultAttemptId,
          input.resultAttemptId,
        ),
        eq(
          resultInterpretationBackfillItems.sourceArchiveId,
          input.sourceArchiveId,
        ),
        eq(resultInterpretationBackfillItems.state, "hydrating"),
        eq(
          resultInterpretationBackfillItems.claimToken,
          input.auditClaim.backfillClaimToken,
        ),
        sql`${resultInterpretationBackfillItems.claimExpiresAt} > clock_timestamp()`,
        eq(
          resultInterpretationBackfillRuns.reducerVersionId,
          input.reducerVersionId,
        ),
        eq(resultInterpretationBackfillRuns.state, "running"),
        sql`${resultInterpretationBackfillRuns.scope} ->> 'contract' = ${HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT}`,
        sql`${resultInterpretationBackfillRuns.scope} ->> 'canonicalSelection' = 'forbidden'`,
        sql`${resultInterpretationBackfillRuns.scope} ->> 'physicalRecovery' = 'record-only'`,
        sql`${resultInterpretationBackfillRuns.scope} ->> 'campaignMutation' = 'forbidden'`,
        sql`${resultInterpretationBackfillRuns.scope} ->> 'rawEvidenceImmutable' = 'true'`,
        sql`${resultInterpretationBackfillRuns.scope} #>> '{exactSource,resultId}' = ${exactSource.resultId}`,
        sql`${resultInterpretationBackfillRuns.scope} #>> '{exactSource,resultAttemptId}' = ${exactSource.resultAttemptId}`,
        sql`${resultInterpretationBackfillRuns.scope} #>> '{exactSource,sourceArchiveId}' = ${exactSource.sourceArchiveId}`,
        isNull(results.currentResultAttemptId),
        isNull(results.currentResultInterpretationId),
        isNull(results.currentCanonicalSelectionId),
        eq(results.status, "done"),
        eq(results.source, "solved"),
        eq(solverEvidenceArchives.resultId, input.resultId),
        inArray(solverEvidenceArtifacts.kind, [
          "engine_bundle",
          "openfoam_bundle",
        ]),
        eq(solverEvidenceBlobs.backend, "gcs"),
        eq(solverEvidenceBlobs.compression, "zstd"),
        eq(solverEvidenceBlobs.mimeType, "application/zstd"),
        sql`btrim(COALESCE(${solverEvidenceBlobs.bucket}, '')) <> ''`,
        sql`${solverEvidenceBlobs.generation} ~ '^[1-9][0-9]{0,19}$'`,
        sql`${solverEvidenceBlobs.verifiedAt} IS NOT NULL`,
      ),
    )
    .limit(1)
    // The historical branch has already acquired the child item then the
    // released result. Lock the remaining mutable audit-source rows in that
    // same order before staging: cancellation, archive supersession, or a
    // changed blob pointer must wait rather than racing an immutable row in.
    .for("update");
  return (
    receipt != null &&
    historicalReleasedArchiveAuditScopeMatchesExactSource({
      scope: receipt.scope,
      exactSource,
    }) &&
    isHistoricalReleasedArchiveAuditSourceEligible({
      expectedFidelity: input.expectedFidelity,
      attempt: {
        status: receipt.attemptStatus,
        source: receipt.attemptSource,
        regime: receipt.attemptRegime,
        unsteady: receipt.attemptUnsteady,
        fidelity: receipt.attemptFidelity,
      },
      blob: receipt.blob,
    })
  );
}

/** Return true when a later reducer policy has an exact durable publication
 * receipt or selection for this immutable archive. This runs while the result
 * row is locked, and admission takes the same lock, so a V1 worker cannot
 * win canonical publication after V2 has been admitted. */
async function newerReducerOwnsArchivePublication(
  db: DB,
  input: {
    resultId: string;
    resultAttemptId: string;
    sourceArchiveId: string;
    reducerVersionId: string;
  },
): Promise<boolean> {
  const [candidate] = await db
    .select({
      id: resultReducerVersions.id,
      reducerKey: resultReducerVersions.reducerKey,
      createdAt: resultReducerVersions.createdAt,
    })
    .from(resultReducerVersions)
    .where(eq(resultReducerVersions.id, input.reducerVersionId))
    .limit(1);
  if (!candidate) return true;

  const [admitted, selected] = await Promise.all([
    db
      .select({
        id: resultReducerVersions.id,
        createdAt: resultReducerVersions.createdAt,
      })
      .from(resultArchiveReductionQueue)
      .innerJoin(
        resultReducerVersions,
        eq(
          resultReducerVersions.id,
          resultArchiveReductionQueue.reducerVersionId,
        ),
      )
      .where(
        and(
          eq(resultArchiveReductionQueue.resultId, input.resultId),
          eq(
            resultArchiveReductionQueue.resultAttemptId,
            input.resultAttemptId,
          ),
          eq(
            resultArchiveReductionQueue.sourceArchiveId,
            input.sourceArchiveId,
          ),
          eq(resultReducerVersions.reducerKey, candidate.reducerKey),
        ),
      ),
    db
      .select({
        id: resultReducerVersions.id,
        createdAt: resultReducerVersions.createdAt,
      })
      .from(resultCanonicalSelections)
      .innerJoin(
        resultInterpretations,
        eq(
          resultInterpretations.id,
          resultCanonicalSelections.resultInterpretationId,
        ),
      )
      .innerJoin(
        resultReducerVersions,
        eq(resultReducerVersions.id, resultInterpretations.reducerVersionId),
      )
      .where(
        and(
          eq(resultCanonicalSelections.resultId, input.resultId),
          eq(resultCanonicalSelections.resultAttemptId, input.resultAttemptId),
          eq(
            resultInterpretations.source,
            ARCHIVE_PUBLICATION_INTERPRETATION_SOURCE,
          ),
          eq(resultInterpretations.sourceArchiveId, input.sourceArchiveId),
          eq(resultReducerVersions.reducerKey, candidate.reducerKey),
        ),
      ),
  ]);
  return !mayPublishReducerVersion({
    candidate: candidate as ReducerVersionPrecedence,
    admittedOrSelected: [...admitted, ...selected],
  });
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
    interpretation.source !== ARCHIVE_PUBLICATION_INTERPRETATION_SOURCE ||
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
  if (
    !selected.every(
      (cycle) => archiveSelectedCycleQualityReasons(cycle).length === 0,
    )
  ) {
    return false;
  }
  return exactArchivePeriodicScalarProof({
    interpretation,
    selected,
    required,
  });
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
  /** Immutable queue/run identity. Archive reduction must never silently
   * switch to whatever reducer happens to be deployed at staging time. */
  reducerVersionId: string;
  backfillRunId: string;
  /** Queue publication and released-history audit use distinct, persisted
   * authorities.  The latter can stage evidence but can never select it. */
  authority: ArchiveInterpretationStageAuthority;
  /** SHA-256 generated by the archive reducer from its exact GCS pointer,
   * manifest and raw coefficient/frame member set. */
  inputEvidenceSignature: string;
  /**
   * The historical-audit receipt is part of the same immutable transaction as
   * its interpretation.  This prevents a process crash from leaving an
   * audit-looking interpretation with no durable audit decision, while still
   * keeping the decision physically incapable of authorizing publication or
   * solver recovery.
   */
  historicalAuditDecision?: HistoricalArchiveAuditDecisionDraft;
  /** Required for a released-evidence audit. The callback settles the exact
   * claimed child and inserts its decision in this transaction; it has no
   * canonical-selection or solver-recovery authority. */
  historicalAuditFinalize?: HistoricalArchiveAuditStageFinalizer;
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
  const historicalAuditDecision = opts.historicalAuditDecision;
  const historicalAuditFinalize = opts.historicalAuditFinalize;
  // Do this before opening the transaction. The audit branch never has a
  // broad/fallback source: every later lease renewal and stage proof repeats
  // this canonical three-ID identity against persisted run scope.
  const historicalAuditExactSource =
    opts.authority.kind === "historical_released_audit"
      ? validateHistoricalReleasedArchiveAuditExactSource({
          resultId: opts.resultId,
          resultAttemptId: opts.resultAttemptId,
          sourceArchiveId: opts.sourceArchiveId,
        })
      : null;
  if (opts.authority.kind === "historical_released_audit") {
    if (!historicalAuditDecision || !historicalAuditFinalize) {
      throw new HistoricalArchiveAuditClaimLostError();
    }
    if (
      historicalAuditDecision.inputEvidenceSignature !==
        opts.inputEvidenceSignature ||
      !SHA256_TEXT.test(historicalAuditDecision.inputEvidenceSignature)
    ) {
      throw new Error(
        "historical archive audit decision must carry the exact reducer evidence signature",
      );
    }
    const continuation =
      historicalAuditDecision.reducerState === "continuation_required";
    if (
      (continuation &&
        (historicalAuditDecision.advisoryContinuationAction !==
          "continue_exact_case" ||
          !Number.isSafeInteger(historicalAuditDecision.advisoryTailPeriods) ||
          historicalAuditDecision.advisoryTailPeriods == null ||
          historicalAuditDecision.advisoryTailPeriods < 1 ||
          historicalAuditDecision.advisoryTailPeriods > 3)) ||
      (!continuation &&
        (historicalAuditDecision.advisoryContinuationAction !== null ||
          historicalAuditDecision.advisoryTailPeriods !== null))
    ) {
      throw new Error(
        "historical archive audit decision has an invalid non-executable continuation shape",
      );
    }
  } else if (historicalAuditDecision || historicalAuditFinalize) {
    throw new ArchivePublicationClaimLostError();
  }
  return opts.db.transaction(async (rawTx) => {
    const db = rawTx as unknown as DB;
    const lockResult = () =>
      db
        .select({
          id: results.id,
          currentResultAttemptId: results.currentResultAttemptId,
          currentResultInterpretationId: results.currentResultInterpretationId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, opts.resultId))
        .limit(1)
        .for("update");
    if (opts.authority.kind === "queue_publication") {
      // Queue publication shares admission/selection's result -> parent queue
      // -> child receipt order. Its parent queue claim is the only authority
      // that may later call the canonical selector.
      const [lockedResult] = await lockResult();
      if (!lockedResult) throw new ArchivePublicationClaimLostError();
      const exactLivePrecalcOwner =
        lockedResult.currentResultAttemptId == null &&
        (await hasExactLivePrecalcPublicationWinner(db, {
          resultId: opts.resultId,
          resultAttemptId: opts.resultAttemptId,
          lockForPublication: true,
        }));
      if (!lockedResult.currentResultAttemptId && !exactLivePrecalcOwner) {
        // A result can be deliberately released after the queue's optimistic
        // precheck but before the reducer returns. The only normal exception
        // is an active exact PRECALC owner whose own archived child remains
        // unpublished; every other released source is audit-only.
        throw new Error(
          "archive publication source was released before interpretation staging",
        );
      }
      await renewArchivePublicationClaimFence(
        db,
        opts.authority.publicationClaim,
      );
      if (
        !(await hasActiveArchivePublicationReceipt(db, {
          resultId: opts.resultId,
          resultAttemptId: opts.resultAttemptId,
          sourceArchiveId: opts.sourceArchiveId,
          reducerVersionId: opts.reducerVersionId,
          backfillRunId: opts.backfillRunId,
          publicationClaim: opts.authority.publicationClaim,
        }))
      ) {
        throw new Error(
          "archive interpretation staging requires an active exact publication queue receipt",
        );
      }
    } else {
      // Settlement owns the historical child receipt before its audit-decision
      // FKs take a result lock. Use the same child -> result order here so a
      // reclaimed claimant cannot form a child/result lock cycle with staging.
      await renewHistoricalArchiveAuditClaimFence(db, {
        auditClaim: opts.authority.auditClaim,
        backfillRunId: opts.backfillRunId,
        reducerVersionId: opts.reducerVersionId,
        exactSource: historicalAuditExactSource!,
      });
      const [lockedResult] = await lockResult();
      if (!lockedResult) throw new HistoricalArchiveAuditClaimLostError();
      // A historical audit remains read-only with respect to a result's live
      // projection. Holding the result row lock makes this null proof stable
      // for the subsequent immutable interpretation insert.
      if (
        lockedResult.currentResultAttemptId != null ||
        lockedResult.currentResultInterpretationId != null ||
        lockedResult.currentCanonicalSelectionId != null
      ) {
        throw new HistoricalArchiveAuditClaimLostError();
      }
      if (
        !(await hasActiveHistoricalArchiveAuditReceipt(db, {
          resultId: historicalAuditExactSource!.resultId,
          resultAttemptId: historicalAuditExactSource!.resultAttemptId,
          sourceArchiveId: historicalAuditExactSource!.sourceArchiveId,
          reducerVersionId: opts.reducerVersionId,
          backfillRunId: opts.backfillRunId,
          expectedFidelity: opts.fidelity,
          auditClaim: opts.authority.auditClaim,
        }))
      ) {
        throw new HistoricalArchiveAuditClaimLostError();
      }
    }
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
    const historicalAuditRerunRequired =
      opts.authority.kind === "historical_released_audit" &&
      historicalAuditDecision!.reducerState === "rerun_required";
    const rerunReason =
      typeof opts.diagnostics.reason === "string" &&
      opts.diagnostics.reason.trim()
        ? opts.diagnostics.reason.trim()
        : "clean-cycle reducer requires a new run";
    const effectiveDraft: InterpretationDraft = archiveRecoveryExhausted
      ? terminalArchiveInterpretationDraft(draft, `URANS ${exhaustionReason}`)
      : historicalAuditRerunRequired
        ? terminalArchiveInterpretationDraft(
            draft,
            `URANS historical audit requires rerun: ${rerunReason}`,
          )
        : draft;
    if (opts.authority.kind === "historical_released_audit") {
      // The audit decision is a factual reducer receipt, not an alternate
      // interpretation policy.  Refuse to commit a receipt that calls a
      // malformed/rejected certificate accepted (or vice versa); otherwise a
      // later caller would see a contradictory audit log after this
      // transaction commits. A `rerun_required` decision can retain cycle
      // evidence, but only as a terminal, scalar-free interpretation.
      const expectedStageState = historicalAuditExpectedStageState(
        historicalAuditDecision!.reducerState,
      );
      if (
        expectedStageState == null ||
        effectiveDraft.state !== expectedStageState
      ) {
        throw new Error(
          "historical archive audit decision contradicts its staged scientific interpretation",
        );
      }
    }
    const interpretationSource =
      opts.authority.kind === "historical_released_audit"
        ? HISTORICAL_ARCHIVE_AUDIT_INTERPRETATION_SOURCE
        : ARCHIVE_PUBLICATION_INTERPRETATION_SOURCE;
    const [inserted] = await db
      .insert(resultInterpretations)
      .values({
        resultId: opts.resultId,
        resultAttemptId: opts.resultAttemptId,
        reducerVersionId: opts.reducerVersionId,
        sourceArchiveId: opts.sourceArchiveId,
        source: interpretationSource,
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
      const [existing] = await db
        .select({ id: resultInterpretations.id })
        .from(resultInterpretations)
        .where(
          and(
            eq(resultInterpretations.resultAttemptId, opts.resultAttemptId),
            eq(resultInterpretations.reducerVersionId, opts.reducerVersionId),
            eq(resultInterpretations.source, interpretationSource),
            eq(resultInterpretations.sourceArchiveId, opts.sourceArchiveId),
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
        await db
          .insert(resultInterpretationCycles)
          .values(rows)
          .onConflictDoNothing();
      }
    }
    const staged: StagedResultInterpretation = {
      id: interpretationId,
      state: effectiveDraft.state,
      regime: effectiveDraft.regime,
    };
    if (opts.authority.kind === "historical_released_audit") {
      if (!(await historicalAuditFinalize!({ db, interpretation: staged }))) {
        throw new HistoricalArchiveAuditClaimLostError();
      }

      // The callback is supplied by the mutable work-receipt layer, while this
      // module owns the immutable interpretation transaction. Do not trust a
      // truthy callback alone: prove, in this same transaction, that it left
      // the exact claimed child terminal and joined to the one compatible
      // immutable decision. This makes an accidental no-op callback roll the
      // whole interpretation back instead of creating an audit-looking row
      // with no completed execution receipt.
      const expectedChildState = historicalAuditExpectedChildReceiptState(
        historicalAuditDecision!.reducerState,
      );
      const [finalizedReceipt] = await db
        .select({
          childId: resultInterpretationBackfillItems.id,
          childAttemptCount: resultInterpretationBackfillItems.attemptCount,
          decisionAdvisoryContinuationAction:
            historicalArchiveAuditDecisions.advisoryContinuationAction,
          decisionAdvisoryTailPeriods:
            historicalArchiveAuditDecisions.advisoryTailPeriods,
        })
        .from(resultInterpretationBackfillItems)
        .innerJoin(
          historicalArchiveAuditDecisions,
          eq(
            resultInterpretationBackfillItems.historicalAuditDecisionId,
            historicalArchiveAuditDecisions.id,
          ),
        )
        .where(
          and(
            eq(
              resultInterpretationBackfillItems.id,
              opts.authority.auditClaim.backfillItemId,
            ),
            eq(resultInterpretationBackfillItems.runId, opts.backfillRunId),
            eq(resultInterpretationBackfillItems.resultId, opts.resultId),
            eq(
              resultInterpretationBackfillItems.resultAttemptId,
              opts.resultAttemptId,
            ),
            eq(
              resultInterpretationBackfillItems.sourceArchiveId,
              opts.sourceArchiveId,
            ),
            eq(resultInterpretationBackfillItems.state, expectedChildState),
            eq(
              resultInterpretationBackfillItems.historicalAuditReducerState,
              historicalAuditDecision!.reducerState,
            ),
            eq(
              resultInterpretationBackfillItems.historicalAuditInputEvidenceSignature,
              opts.inputEvidenceSignature,
            ),
            eq(
              resultInterpretationBackfillItems.resultInterpretationId,
              interpretationId,
            ),
            isNull(resultInterpretationBackfillItems.claimToken),
            isNull(resultInterpretationBackfillItems.claimExpiresAt),
            eq(historicalArchiveAuditDecisions.auditRunId, opts.backfillRunId),
            eq(historicalArchiveAuditDecisions.resultId, opts.resultId),
            eq(
              historicalArchiveAuditDecisions.resultAttemptId,
              opts.resultAttemptId,
            ),
            eq(
              historicalArchiveAuditDecisions.sourceArchiveId,
              opts.sourceArchiveId,
            ),
            eq(
              historicalArchiveAuditDecisions.reducerVersionId,
              opts.reducerVersionId,
            ),
            eq(
              historicalArchiveAuditDecisions.inputEvidenceSignature,
              opts.inputEvidenceSignature,
            ),
            eq(
              historicalArchiveAuditDecisions.reducerState,
              historicalAuditDecision!.reducerState,
            ),
            eq(
              historicalArchiveAuditDecisions.resultInterpretationId,
              interpretationId,
            ),
          ),
        )
        .limit(1);
      if (
        !finalizedReceipt ||
        finalizedReceipt.childAttemptCount < 1 ||
        finalizedReceipt.decisionAdvisoryContinuationAction !==
          historicalAuditDecision!.advisoryContinuationAction ||
        finalizedReceipt.decisionAdvisoryTailPeriods !==
          historicalAuditDecision!.advisoryTailPeriods
      ) {
        throw new HistoricalArchiveAuditClaimLostError();
      }
    }
    return staged;
  });
}

/**
 * Select an accepted archive reduction only when its producing archive is
 * current and either (a) its attempt is already current, or (b) it is the
 * exact PRECALC child of the source-pinned current RANS result. The latter
 * preserves any usable RANS projection during raw-archive reduction, then
 * atomically promotes the exact higher-fidelity URANS interpretation only
 * after it passes the archive gate.  Selection is append-only; a
 * compare-and-swap race merely leaves honest historical evidence and never
 * retargets an unrelated generation.
 */
export async function selectAcceptedArchiveInterpretation(opts: {
  db: DB;
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
  interpretationId: string | null;
  backfillRunId: string;
  /** Queue/run reducer identity. Selection is invalid if an interpretation
   * was staged under a different policy version. */
  reducerVersionId: string;
  /** Exact unexpired queue claimant allowed to publish this interpretation. */
  publicationClaim: ArchivePublicationClaimFence;
  actor?: string;
}): Promise<ArchiveInterpretationSelectionOutcome> {
  // The authorization read, append-only event, and mutable projection must
  // observe one serializable current-generation snapshot.  A reducer call is
  // intentionally outside this transaction; this short transaction only
  // decides whether its immutable answer can become canonical now.
  return opts.db.transaction(async (rawTx) =>
    selectAcceptedArchiveInterpretationInTransaction({
      ...opts,
      db: rawTx as unknown as DB,
    }),
  );
}

async function selectAcceptedArchiveInterpretationInTransaction(opts: {
  db: DB;
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
  interpretationId: string | null;
  backfillRunId: string;
  reducerVersionId: string;
  publicationClaim: ArchivePublicationClaimFence;
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
      clWaveformRms: resultInterpretations.clWaveformRms,
      cdWaveformRms: resultInterpretations.cdWaveformRms,
      cmWaveformRms: resultInterpretations.cmWaveformRms,
      selectedWindow: resultInterpretations.selectedWindow,
      statistics: resultInterpretations.statistics,
      diagnostics: resultInterpretations.diagnostics,
      resultId: resultInterpretations.resultId,
      resultAttemptId: resultInterpretations.resultAttemptId,
      reducerVersionId: resultInterpretations.reducerVersionId,
    })
    .from(resultInterpretations)
    .where(eq(resultInterpretations.id, opts.interpretationId))
    .limit(1);
  if (
    !interpretation ||
    interpretation.resultId !== opts.resultId ||
    interpretation.resultAttemptId !== opts.resultAttemptId ||
    interpretation.reducerVersionId !== opts.reducerVersionId
  ) {
    return "not_eligible";
  }

  const [current] = await opts.db
    .select({
      currentAttemptId: results.currentResultAttemptId,
      currentInterpretationId: results.currentResultInterpretationId,
      currentCanonicalSelectionId: results.currentCanonicalSelectionId,
    })
    .from(results)
    .where(eq(results.id, opts.resultId))
    .limit(1)
    .for("update");
  if (!current) {
    return "stale_attempt";
  }
  await renewArchivePublicationClaimFence(opts.db, opts.publicationClaim);
  if (
    !(await hasActiveArchivePublicationReceipt(opts.db, {
      resultId: opts.resultId,
      resultAttemptId: opts.resultAttemptId,
      sourceArchiveId: opts.sourceArchiveId,
      reducerVersionId: opts.reducerVersionId,
      backfillRunId: opts.backfillRunId,
      publicationClaim: opts.publicationClaim,
    }))
  ) {
    return "not_eligible";
  }
  if (
    await newerReducerOwnsArchivePublication(opts.db, {
      resultId: opts.resultId,
      resultAttemptId: opts.resultAttemptId,
      sourceArchiveId: opts.sourceArchiveId,
      reducerVersionId: opts.reducerVersionId,
    })
  ) {
    return "superseded_by_newer_reducer";
  }
  if (
    current.currentAttemptId === opts.resultAttemptId &&
    current.currentInterpretationId === interpretation.id &&
    current.currentCanonicalSelectionId
  ) {
    return "already_selected";
  }

  const [[attempt], [archive], cycles] = await Promise.all([
    opts.db
      .select({
        status: resultAttempts.status,
        source: resultAttempts.source,
        regime: resultAttempts.regime,
        fidelity: sql<unknown>`COALESCE(
          ${resultAttempts.evidencePayload} ->> 'fidelity',
          ${resultAttempts.evidencePayload} ->> 'fidelityTier'
        )`,
        simJobId: resultAttempts.simJobId,
        engineJobId: resultAttempts.engineJobId,
        engineCaseSlug: resultAttempts.engineCaseSlug,
        methodKey: resultAttempts.methodKey,
        solverImplementationId: resultAttempts.solverImplementationId,
        solverRuntimeBuildId: resultAttempts.solverRuntimeBuildId,
        stalled: resultAttempts.stalled,
        unsteady: resultAttempts.unsteady,
        converged: resultAttempts.converged,
        finalResidual: resultAttempts.finalResidual,
        iterations: resultAttempts.iterations,
        yPlusAvg: resultAttempts.yPlusAvg,
        yPlusMax: resultAttempts.yPlusMax,
        nCells: resultAttempts.nCells,
        firstOrderFallback: resultAttempts.firstOrderFallback,
        strouhal: resultAttempts.strouhal,
        error: resultAttempts.error,
        qualityWarnings: resultAttempts.qualityWarnings,
        solvedAt: resultAttempts.solvedAt,
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
      .limit(1)
      .for("update"),
    opts.db
      .select({
        cycleIndex: resultInterpretationCycles.cycleIndex,
        startTimeS: resultInterpretationCycles.startTimeS,
        endTimeS: resultInterpretationCycles.endTimeS,
        periodS: resultInterpretationCycles.periodS,
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

  const [currentGeneration] = current.currentAttemptId
    ? await opts.db
        .select({
          attemptId: resultAttempts.id,
          fidelity: sql<unknown>`COALESCE(
            ${resultAttempts.evidencePayload} ->> 'fidelity',
            ${resultAttempts.evidencePayload} ->> 'fidelityTier'
          )`,
        })
        .from(resultAttempts)
        .where(eq(resultAttempts.id, current.currentAttemptId))
        .limit(1)
    : [undefined];
  const targetFidelity =
    typeof attempt.fidelity === "string"
      ? parsePointFidelity(attempt.fidelity)
      : null;
  const currentFidelity =
    typeof currentGeneration?.fidelity === "string"
      ? parsePointFidelity(currentGeneration.fidelity)
      : null;
  const hasExactPrecalcLineage =
    current.currentAttemptId !== opts.resultAttemptId &&
    current.currentAttemptId
      ? await hasExactPrecalcUransPromotionLineage({
          db: opts.db,
          resultId: opts.resultId,
          currentRansAttemptId: current.currentAttemptId,
          targetUransAttemptId: opts.resultAttemptId,
        })
      : false;
  const promotesExactPrecalcRans =
    current.currentAttemptId !== opts.resultAttemptId &&
    mayPromoteArchiveUransFromExactPrecalcRans({
      targetFidelity,
      currentFidelity,
      hasExactPrecalcLineage,
    });
  const promotesExactLegacyRecovery =
    current.currentAttemptId !== opts.resultAttemptId &&
    current.currentAttemptId != null &&
    targetFidelity === "urans_precalc" &&
    (await hasExactLegacyUransArchiveGapRecoveryLineage({
      db: opts.db,
      resultId: opts.resultId,
      currentLegacyAttemptId: current.currentAttemptId,
      targetUransAttemptId: opts.resultAttemptId,
    }));
  const promotesExactReleasedPrecalcOwner =
    current.currentAttemptId == null &&
    targetFidelity === "urans_precalc" &&
    (await hasExactLivePrecalcPublicationWinner(opts.db, {
      resultId: opts.resultId,
      resultAttemptId: opts.resultAttemptId,
      lockForPublication: true,
    }));
  if (
    current.currentAttemptId !== opts.resultAttemptId &&
    !promotesExactPrecalcRans &&
    !promotesExactLegacyRecovery &&
    !promotesExactReleasedPrecalcOwner
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
          ? "accepted exact raw archive no-shedding observation for URANS publication"
          : "accepted exact raw archive clean-cycle interpretation for URANS publication",
      actor: opts.actor ?? "system:archive-interpretation-backfill",
    })
    .returning({ id: resultCanonicalSelections.id });
  if (!selection) {
    throw new Error("archive canonical selection could not be persisted");
  }
  const currentAttemptGuard = current.currentAttemptId
    ? eq(results.currentResultAttemptId, current.currentAttemptId)
    : isNull(results.currentResultAttemptId);
  const currentInterpretationGuard = current.currentInterpretationId
    ? eq(results.currentResultInterpretationId, current.currentInterpretationId)
    : isNull(results.currentResultInterpretationId);
  const currentCanonicalSelectionGuard = current.currentCanonicalSelectionId
    ? eq(
        results.currentCanonicalSelectionId,
        current.currentCanonicalSelectionId,
      )
    : isNull(results.currentCanonicalSelectionId);
  // Fence the final projection against an archive supersession after the
  // expensive reducer call.  The append-only interpretation/selection may
  // remain historical evidence, but a stale source archive may never replace
  // the live result projection.
  const currentArchiveGuard = sql`EXISTS (
    SELECT 1
    FROM solver_evidence_archives archive_guard
    WHERE archive_guard.id = ${opts.sourceArchiveId}::uuid
      AND archive_guard.result_id = ${opts.resultId}::uuid
      AND archive_guard.result_attempt_id = ${opts.resultAttemptId}::uuid
      AND archive_guard.state = 'current'
  )`;
  const [updated] = await opts.db
    .update(results)
    .set({
      currentResultAttemptId: opts.resultAttemptId,
      currentResultInterpretationId: interpretation.id,
      currentCanonicalSelectionId: selection.id,
      status: attempt.status,
      source: attempt.source,
      regime: attempt.regime,
      fidelity: targetFidelity,
      cl: interpretation.cl,
      cd: interpretation.cd,
      cm: interpretation.cm,
      clCd: interpretation.clCd,
      clStd: interpretation.clWaveformRms,
      cdStd: interpretation.cdWaveformRms,
      cmStd: interpretation.cmWaveformRms,
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
      engineJobId: attempt.engineJobId,
      engineCaseSlug: attempt.engineCaseSlug,
      simJobId: attempt.simJobId,
      methodKey: attempt.methodKey,
      solverImplementationId: attempt.solverImplementationId,
      solverRuntimeBuildId: attempt.solverRuntimeBuildId,
      solvedAt: attempt.solvedAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(results.id, opts.resultId),
        currentAttemptGuard,
        currentInterpretationGuard,
        currentCanonicalSelectionGuard,
        currentArchiveGuard,
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
      // No-shedding URANS is deliberately NOT an immediate engine projection:
      // it must wait for the immutable GCS archive reducer.  Keep this
      // provenance reason aligned with canSelectImmediateEngineInterpretation
      // so an operator never mistakes a live summary for archived evidence.
      reason: "accepted all-channel RANS hold engine interpretation",
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
