/**
 * Pure policy for the live archive-publication queue.  Keeping these checks
 * independent of Drizzle lets the queue tests prove the important negative
 * cases (old reducer versions, stale archives, and long selected prefixes)
 * without fabricating a database or CFD result.
 */
export type ArchiveReductionScanRow = {
  sourceArchiveId: string;
  archivePointerValid: boolean;
  currentSelection: {
    acceptedArchive: boolean;
    sourceArchiveId: string | null;
    reducerVersionId: string | null;
  };
};

export function shouldEnqueueArchiveReduction(
  row: ArchiveReductionScanRow,
  reducerVersionId: string,
): boolean {
  if (!row.archivePointerValid) return false;
  const selected = row.currentSelection;
  return !(
    selected.acceptedArchive &&
    selected.sourceArchiveId === row.sourceArchiveId &&
    selected.reducerVersionId === reducerVersionId
  );
}

/**
 * A scanner must filter accepted/invalid prefix rows before applying its
 * bounded candidate limit.  Otherwise 64 old selected rows can starve every
 * later newly-uploaded archive forever.
 */
export function selectArchiveReductionScanPage<T extends ArchiveReductionScanRow>(
  rows: readonly T[],
  reducerVersionId: string,
  limit: number,
): T[] {
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error("archive reduction scan limit must be positive");
  return rows
    .filter((row) => shouldEnqueueArchiveReduction(row, reducerVersionId))
    .slice(0, limit);
}

/** A reducer may run only while its exact source remains current.  A
 * non-current URANS is allowed solely when the durable PRECALC lineage proves
 * it is the successor of the selected accepted RANS result. */
export function mayRunArchiveReduction(input: {
  sourceArchiveCurrent: boolean;
  targetAttemptCurrent: boolean;
  hasExactPrecalcRansLineage: boolean;
}): boolean {
  return (
    input.sourceArchiveCurrent &&
    (input.targetAttemptCurrent || input.hasExactPrecalcRansLineage)
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
    throw new Error("archive reduction attemptCount must be a positive integer");
  }
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}
