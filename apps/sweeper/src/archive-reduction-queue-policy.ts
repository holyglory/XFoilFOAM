/**
 * Pure policy for the live archive-publication queue.  Keeping these checks
 * independent of Drizzle lets the queue tests prove the important negative
 * cases (old reducer versions, stale archives, and long selected prefixes)
 * without fabricating a database or CFD result.
 */
export type ArchiveReductionScanRow = {
  sourceArchiveId: string;
  /** An attempt may begin before a reducer release and finish after it. It is
   * retained for diagnostics but is deliberately not the prospective cutoff. */
  resultAttemptCreatedAt: Date | string | null;
  /** Immutable archive creation identifies the evidence generation. Routine
   * crash recovery is prospective from a reducer release; historical repair
   * is always an explicit exact scope. */
  sourceArchiveCreatedAt: Date | string | null;
  archivePointerValid: boolean;
  /** A null pointer means the result was deliberately released. Its GCS
   * archive is immutable historical evidence and can only enter the separate
   * explicit historical-audit workflow, unless a live exact PRECALC owner
   * proves this exact archived generation is still awaiting publication. */
  resultHasCurrentAttempt: boolean;
  /** Durable exact-owner exception for a cleared projection. This is never a
   * broad historical replay: the database re-proves one live PRECALC owner,
   * its exact latest job, boundary, implementation, and physical cell. */
  hasExactLivePrecalcPublicationOwner?: boolean;
  currentSelection: {
    acceptedArchive: boolean;
    sourceArchiveId: string | null;
    reducerVersionId: string | null;
    reducerKey: string | null;
    reducerVersion: string | null;
    reducerBuildId: string | null;
  };
};

/**
 * The v6 change fixes one machine-arithmetic admission boundary. It does not
 * change the already accepted v5 archive reductions, so a routine scanner
 * must not manufacture v6 work for every current v5 selection. Migration
 * 0120 deliberately creates v6 receipts only for its exact rejected sources.
 *
 * Keep this an exact reducer identity rather than a broad "older builds are
 * compatible" rule: later scientific-policy releases must still receive a
 * fresh reduction generation.
 */
export const CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY = {
  reducerKey: "airfoilfoam",
  reducerVersion: "result-interpretation-v2",
  reducerBuildId: "clean-cycle-v5",
} as const;

export const CLEAN_CYCLE_V6_REDUCER_IDENTITY = {
  reducerKey: "airfoilfoam",
  reducerVersion: "result-interpretation-v2",
  reducerBuildId: "clean-cycle-v6",
} as const;

export type ArchiveReductionTargetReducer = {
  id: string;
  reducerKey: string;
  reducerVersion: string;
  reducerBuildId: string;
  createdAt: Date | string;
};

export type ArchiveReductionScanMode = "routine" | "explicit_historical_repair";

function timestamp(value: Date | string | null): number | null {
  const parsed =
    value instanceof Date ? value.getTime() : Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : null;
}

/** Routine scans are prospective from immutable archive creation. An in-flight
 * attempt may predate the release and still produce a new verified archive
 * afterward, so attempt creation is intentionally not part of this cutoff.
 * Older archive generations can be repaired only through an exact scoped call
 * (including migration 0120), preventing a release from globally re-enqueueing
 * historical GCS evidence. */
export function archiveReductionSourceIsProspective(
  row: ArchiveReductionScanRow,
  target: ArchiveReductionTargetReducer,
): boolean {
  const releasedAt = timestamp(target.createdAt);
  const archiveCreatedAt = timestamp(row.sourceArchiveCreatedAt);
  return (
    releasedAt != null &&
    archiveCreatedAt != null &&
    archiveCreatedAt >= releasedAt
  );
}

export function isArchiveSelectionCompatibleWithReducer(
  selection: ArchiveReductionScanRow["currentSelection"],
  target: ArchiveReductionTargetReducer,
): boolean {
  if (!selection.acceptedArchive) return false;
  if (selection.reducerVersionId === target.id) return true;
  // This is a one-release compatibility bridge, not a broad preference for
  // any old reducer. New/no-selection rows continue to receive v6 receipts.
  return (
    target.reducerKey === CLEAN_CYCLE_V6_REDUCER_IDENTITY.reducerKey &&
    target.reducerVersion === CLEAN_CYCLE_V6_REDUCER_IDENTITY.reducerVersion &&
    target.reducerBuildId === CLEAN_CYCLE_V6_REDUCER_IDENTITY.reducerBuildId &&
    selection.reducerKey ===
      CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY.reducerKey &&
    selection.reducerVersion ===
      CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY.reducerVersion &&
    selection.reducerBuildId ===
      CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY.reducerBuildId
  );
}

export function shouldEnqueueArchiveReduction(
  row: ArchiveReductionScanRow,
  targetReducer: ArchiveReductionTargetReducer,
  mode: ArchiveReductionScanMode = "routine",
): boolean {
  if (
    !row.archivePointerValid ||
    (!row.resultHasCurrentAttempt &&
      row.hasExactLivePrecalcPublicationOwner !== true)
  )
    return false;
  const selected = row.currentSelection;
  if (
    selected.sourceArchiveId === row.sourceArchiveId &&
    (selected.reducerVersionId === targetReducer.id ||
      (mode === "routine" &&
        isArchiveSelectionCompatibleWithReducer(selected, targetReducer)))
  ) {
    return false;
  }
  return (
    mode === "explicit_historical_repair" ||
    archiveReductionSourceIsProspective(row, targetReducer)
  );
}

/**
 * A scanner must filter accepted/invalid prefix rows before applying its
 * bounded candidate limit.  Otherwise 64 old selected rows can starve every
 * later newly-uploaded archive forever.
 */
export function selectArchiveReductionScanPage<
  T extends ArchiveReductionScanRow,
>(
  rows: readonly T[],
  targetReducer: ArchiveReductionTargetReducer,
  limit: number,
  mode: ArchiveReductionScanMode = "routine",
): T[] {
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error("archive reduction scan limit must be positive");
  return rows
    .filter((row) => shouldEnqueueArchiveReduction(row, targetReducer, mode))
    .slice(0, limit);
}

/** A reducer may run only while its exact source remains current.  A
 * non-current URANS is allowed solely when the durable PRECALC lineage proves
 * it is the successor of the selected accepted RANS result. */
export function mayRunArchiveReduction(input: {
  sourceArchiveCurrent: boolean;
  targetAttemptCurrent: boolean;
  hasExactPrecalcRansLineage: boolean;
  hasExactLegacyRecoveryLineage?: boolean;
  /** A projection can be null while its exact active PRECALC job remains the
   * durable owner. This is a publication-only exception, never a release
   * reversal or permission to schedule arbitrary historical evidence. */
  hasExactLivePrecalcPublicationOwner?: boolean;
}): boolean {
  return (
    input.sourceArchiveCurrent &&
    (input.targetAttemptCurrent ||
      input.hasExactPrecalcRansLineage ||
      input.hasExactLegacyRecoveryLineage === true ||
      input.hasExactLivePrecalcPublicationOwner === true)
  );
}

/**
 * Reducer releases are an ordered scientific policy, not an implementation
 * race.  A later persisted reducer release owns canonical publication for an
 * exact archive as soon as it has a durable queue receipt.  Older workers may
 * still finish their immutable audit record, but they must not overwrite the
 * newer release's eventual projection.
 *
 * PostgreSQL timestamps are not unique, so retain the UUID tie-break used by
 * the database predicate.  Keeping this pure makes the concurrent V1/V2
 * regression executable without a live database.
 */
export type ReducerVersionPrecedence = {
  id: string;
  createdAt: Date | string;
};

function reducerTimestamp(value: Date | string): number {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("reducer version createdAt must be a valid timestamp");
  }
  return timestamp;
}

export function reducerVersionIsNewer(
  candidate: ReducerVersionPrecedence,
  incumbent: ReducerVersionPrecedence,
): boolean {
  const candidateTime = reducerTimestamp(candidate.createdAt);
  const incumbentTime = reducerTimestamp(incumbent.createdAt);
  return (
    candidateTime > incumbentTime ||
    (candidateTime === incumbentTime && candidate.id > incumbent.id)
  );
}

/** A candidate may publish only while no later reducer release is admitted or
 * already selected for this exact immutable source. */
export function mayPublishReducerVersion(input: {
  candidate: ReducerVersionPrecedence;
  admittedOrSelected: readonly ReducerVersionPrecedence[];
}): boolean {
  return !input.admittedOrSelected.some((version) =>
    reducerVersionIsNewer(version, input.candidate),
  );
}

/** Durable fallback after an unexpected queue-worker exception.  The lease is
 * always settled back to pending with bounded retry rather than being left in
 * hydrating until expiry. */
export function archiveReductionRetryDelayMs(attemptCount: number): number {
  if (!Number.isSafeInteger(attemptCount) || attemptCount < 1) {
    throw new Error(
      "archive reduction attemptCount must be a positive integer",
    );
  }
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}
