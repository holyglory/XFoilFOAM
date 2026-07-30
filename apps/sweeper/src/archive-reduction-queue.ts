/**
 * Automatic publication handoff for completed current URANS generations.
 *
 * The solver has already done its physical work when this queue is populated.
 * A queue row therefore means “reduce this exact immutable GCS archive”, not
 * “submit another CFD solve”.  Its identity is deliberately global rather
 * than run-scoped: replays, restarts, and the periodic scanner cannot create
 * duplicate archive reductions for the same attempt/archive/reducer tuple.
 */
import {
  type DB,
  refreshCampaignProgressForResultIds,
  refreshPolarCacheForRevision,
  resultArchiveReductionQueue,
  resultAttempts,
  resultCanonicalSelections,
  resultInterpretationBackfillItems,
  resultInterpretations,
  resultReducerVersions,
  results,
  solverEvidenceArchives,
  solverEvidenceBlobs,
} from "@aerodb/db";
import { parsePointFidelity, type EngineClient } from "@aerodb/engine-client";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  archivePointerForBackfill,
  createArchiveInterpretationBackfillRun,
  runArchiveInterpretationBackfill,
} from "./result-interpretation-backfill";
import {
  ensureResultInterpretationReducerVersion,
  hasExactPrecalcUransPromotionLineage,
  mayPromoteArchiveUransFromExactPrecalcRans,
  selectAcceptedArchiveInterpretation,
} from "./result-interpretations";
import {
  archiveReductionRetryDelayMs,
  mayRunArchiveReduction,
  reducerVersionIsNewer,
  selectArchiveReductionScanPage,
} from "./archive-reduction-queue-policy";
import {
  engineArchiveReductionVersion,
  supportsArchiveCleanCycleReduction,
} from "./engine-capabilities";
import { createSingleFlightBackgroundRunner } from "./single-flight";

export const ARCHIVE_REDUCTION_QUEUE_LEASE_MS = 30 * 60_000;
/** Renew well before expiry so a slow authenticated archive reduction never
 * becomes eligible for a second queue claimant mid-request. */
export const ARCHIVE_REDUCTION_QUEUE_LEASE_RENEW_MS = Math.max(
  1_000,
  Math.floor(ARCHIVE_REDUCTION_QUEUE_LEASE_MS / 3),
);
export const ARCHIVE_REDUCTION_QUEUE_SCAN_LIMIT = 64;
export const ARCHIVE_REDUCTION_QUEUE_DRAIN_LIMIT = 2;
/**
 * Hard operator and scheduler ceiling for one archive-reduction invocation.
 * Keep this exported so every admission entry point rejects an oversized
 * request before it can create durable work that the same invocation is not
 * allowed to process.
 */
export const ARCHIVE_REDUCTION_QUEUE_MAX_DRAIN_LIMIT = 8;

export type ArchiveReductionQueueDrainReport = {
  scanned: number;
  enqueued: number;
  admittedResultAttemptIds: string[];
  processed: number;
  /** The exact gateway contract observed or supplied by the admission owner.
   * `null` means the bounded health probe was unavailable or malformed. */
  archiveReductionVersion: number | null;
  /** A legacy/unavailable reducer must leave immutable queue rows untouched.
   * This is a controlled deployment hold, not a reduction failure/retry. */
  deferredByCapability: boolean;
};

type QueueState =
  | "pending"
  | "hydrating"
  | "reduced"
  | "superseded"
  | "missing_evidence"
  | "continuation_required"
  | "rerun_required"
  | "terminal_failure"
  | "failed";

type QueueItem = {
  id: string;
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
  reducerVersionId: string;
  state: QueueState;
  attemptCount: number;
  claimToken: string;
  backfillRunId: string | null;
};

function completedUransSql() {
  // The query uses only fixed aliases below.  Keep raw regime in the proof:
  // periodic URANS and no-shedding URANS have different later selection
  // semantics, but both represent a completed URANS fidelity generation that
  // needs archive reduction before publication.
  return sql`
    ${resultAttempts.status} = 'done'
    AND ${resultAttempts.source} = 'solved'
    AND ${resultAttempts.evidencePayload} ->> 'fidelity' IN ('urans_precalc', 'urans_full')
    AND (
      (${resultAttempts.regime} = 'urans' AND ${resultAttempts.unsteady} IN (TRUE, FALSE))
      -- Legacy no-shedding rows were written before regime meant numerical
      -- method.  They remain compatible only with URANS fidelity.
      OR (${resultAttempts.regime} = 'rans' AND ${resultAttempts.unsteady} = FALSE)
    )
  `;
}

/**
 * Insert durable work after an exact completed attempt and its immutable GCS
 * archive have been verified.  This deliberately scans attempt generations,
 * not only `results.currentResultAttemptId`: a RANS projection may stay
 * public while its exact preliminary-URANS child waits for publication.
 * A selected interpretation for *this reducer version* is already
 * publishable and never re-enters this queue.  This function is intentionally
 * safe to call after every ingest replay and from the bounded crash-recovery
 * scanner.
 */
export async function enqueueVerifiedArchiveReductions(
  db: DB,
  opts: {
    resultIds?: string[];
    resultAttemptIds?: string[];
    limit?: number;
  } = {},
): Promise<{
  reducerVersionId: string;
  scanned: number;
  enqueued: number;
  /** Exact attempt ids with an active, durable publication receipt after this
   * call. Callers must use this rather than re-implementing GCS admission. */
  admittedResultAttemptIds: string[];
}> {
  const reducerVersionId = await ensureResultInterpretationReducerVersion(db);
  const limit = opts.limit ?? ARCHIVE_REDUCTION_QUEUE_SCAN_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error("archive-reduction queue scan limit must be 1..10000");
  }
  const resultIds = [...new Set(opts.resultIds ?? [])];
  const resultAttemptIds = [...new Set(opts.resultAttemptIds ?? [])];
  const rows = await db
    .select({
      resultId: results.id,
      resultAttemptId: resultAttempts.id,
      sourceArchiveId: solverEvidenceArchives.id,
      blob: solverEvidenceBlobs,
      currentSelectionId: results.currentCanonicalSelectionId,
      selectedInterpretationId: results.currentResultInterpretationId,
      selectedState: resultInterpretations.state,
      selectedSource: resultInterpretations.source,
      selectedArchiveId: resultInterpretations.sourceArchiveId,
      selectedReducerVersionId: resultInterpretations.reducerVersionId,
    })
    .from(resultAttempts)
    .innerJoin(results, eq(results.id, resultAttempts.resultId))
    .innerJoin(
      solverEvidenceArchives,
      and(
        eq(solverEvidenceArchives.resultId, resultAttempts.resultId),
        eq(solverEvidenceArchives.resultAttemptId, resultAttempts.id),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .innerJoin(
      solverEvidenceBlobs,
      eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
    )
    .leftJoin(
      resultCanonicalSelections,
      eq(resultCanonicalSelections.id, results.currentCanonicalSelectionId),
    )
    .leftJoin(
      resultInterpretations,
      eq(resultInterpretations.id, results.currentResultInterpretationId),
    )
    .where(
      and(
        completedUransSql(),
        eq(solverEvidenceBlobs.backend, "gcs"),
        eq(solverEvidenceBlobs.compression, "zstd"),
        eq(solverEvidenceBlobs.mimeType, "application/zstd"),
        sql`btrim(COALESCE(${solverEvidenceBlobs.bucket}, '')) <> ''`,
        sql`${solverEvidenceBlobs.generation} ~ '^[1-9][0-9]{0,19}$'`,
        isNotNull(solverEvidenceBlobs.verifiedAt),
        sql`NOT EXISTS (
          SELECT 1
          FROM result_canonical_selections existing_selection
          JOIN result_interpretations existing_interpretation
            ON existing_interpretation.id = existing_selection.result_interpretation_id
          WHERE existing_selection.id = ${results.currentCanonicalSelectionId}
            AND existing_selection.result_id = ${results.id}
            AND existing_selection.result_attempt_id = ${resultAttempts.id}
            AND existing_interpretation.id = ${results.currentResultInterpretationId}
            AND existing_interpretation.result_id = ${results.id}
            AND existing_interpretation.result_attempt_id = ${resultAttempts.id}
            AND existing_interpretation.source = 'archive_backfill'
            AND existing_interpretation.state = 'accepted'
            AND existing_interpretation.source_archive_id = ${solverEvidenceArchives.id}
            AND existing_interpretation.reducer_version_id = ${reducerVersionId}::uuid
        )`,
        resultIds.length ? inArray(results.id, resultIds) : undefined,
        resultAttemptIds.length
          ? inArray(resultAttempts.id, resultAttemptIds)
          : undefined,
      ),
    )
    .orderBy(asc(results.updatedAt), asc(results.id))
    // SQL filters remove the common permanently-selected/non-GCS prefixes;
    // overfetch also lets the pure policy discard an old reducer/invalid
    // pointer prefix before it applies the bounded candidate limit.
    .limit(Math.min(limit * 4, 10_000));

  const candidates = selectArchiveReductionScanPage(
    rows.map((row) => ({
      ...row,
      archivePointerValid: archivePointerForBackfill(row.blob).pointer != null,
      currentSelection: {
        acceptedArchive:
          row.currentSelectionId != null &&
          row.selectedInterpretationId != null &&
          row.selectedState === "accepted" &&
          row.selectedSource === "archive_backfill",
        sourceArchiveId: row.selectedArchiveId,
        reducerVersionId: row.selectedReducerVersionId,
      },
    })),
    reducerVersionId,
    limit,
  );
  if (!candidates.length) {
    return {
      reducerVersionId,
      scanned: rows.length,
      enqueued: 0,
      admittedResultAttemptIds: [],
    };
  }
  const [candidateReducer] = await db
    .select({
      id: resultReducerVersions.id,
      reducerKey: resultReducerVersions.reducerKey,
      createdAt: resultReducerVersions.createdAt,
    })
    .from(resultReducerVersions)
    .where(eq(resultReducerVersions.id, reducerVersionId))
    .limit(1);
  if (!candidateReducer) {
    throw new Error(
      `archive reducer version ${reducerVersionId} was not found`,
    );
  }

  let enqueued = 0;
  const admittedResultAttemptIds = new Set<string>();
  for (const candidate of candidates) {
    // Queue admission and canonical selection share this result-row lock. It
    // closes the V1/V2 race: a later reducer receipt is visible before an old
    // worker may publish, while a selector that won just before admission can
    // still be deterministically replaced by the newer reducer later.
    const outcome = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      const [lockedResult] = await tx
        .select({ id: results.id })
        .from(results)
        .where(eq(results.id, candidate.resultId))
        .limit(1)
        .for("update");
      if (!lockedResult) return { inserted: false, active: false };

      const reducerRows = await tx
        .select({
          id: resultReducerVersions.id,
          createdAt: resultReducerVersions.createdAt,
        })
        .from(resultReducerVersions)
        .where(
          eq(resultReducerVersions.reducerKey, candidateReducer.reducerKey),
        );
      const laterReducerExists = reducerRows.some((version) =>
        reducerVersionIsNewer(version, candidateReducer),
      );
      // A stale sweeper process must not admit V1 after V2 was deployed. V1
      // receipts that were already admitted remain historical audit work, but
      // selection will see V2's durable receipt and refuse to publish V1.
      if (laterReducerExists) return { inserted: false, active: false };

      const [inserted] = await tx
        .insert(resultArchiveReductionQueue)
        .values({
          resultId: candidate.resultId,
          resultAttemptId: candidate.resultAttemptId,
          sourceArchiveId: candidate.sourceArchiveId,
          reducerVersionId,
          state: "pending",
        })
        .onConflictDoNothing()
        .returning({ id: resultArchiveReductionQueue.id });
      const [active] = await tx
        .select({ id: resultArchiveReductionQueue.id })
        .from(resultArchiveReductionQueue)
        .where(
          and(
            eq(
              resultArchiveReductionQueue.resultAttemptId,
              candidate.resultAttemptId,
            ),
            eq(
              resultArchiveReductionQueue.sourceArchiveId,
              candidate.sourceArchiveId,
            ),
            eq(resultArchiveReductionQueue.reducerVersionId, reducerVersionId),
            or(
              eq(resultArchiveReductionQueue.state, "pending"),
              eq(resultArchiveReductionQueue.state, "hydrating"),
              eq(resultArchiveReductionQueue.state, "continuation_required"),
              eq(resultArchiveReductionQueue.state, "rerun_required"),
            ),
          ),
        )
        .limit(1);
      return { inserted: inserted != null, active: active != null };
    });
    if (outcome.inserted) enqueued += 1;
    if (outcome.active) admittedResultAttemptIds.add(candidate.resultAttemptId);
  }
  return {
    reducerVersionId,
    scanned: rows.length,
    enqueued,
    admittedResultAttemptIds: [...admittedResultAttemptIds],
  };
}

type ArchiveReductionQueueScope = {
  resultIds?: string[];
  resultAttemptIds?: string[];
};

async function claimNextQueueItem(
  db: DB,
  scope: ArchiveReductionQueueScope = {},
): Promise<QueueItem | null> {
  const now = new Date();
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [item] = await tx
      .select({
        id: resultArchiveReductionQueue.id,
        resultId: resultArchiveReductionQueue.resultId,
        resultAttemptId: resultArchiveReductionQueue.resultAttemptId,
        sourceArchiveId: resultArchiveReductionQueue.sourceArchiveId,
        reducerVersionId: resultArchiveReductionQueue.reducerVersionId,
        state: resultArchiveReductionQueue.state,
        attemptCount: resultArchiveReductionQueue.attemptCount,
        backfillRunId: resultArchiveReductionQueue.backfillRunId,
      })
      .from(resultArchiveReductionQueue)
      .where(
        and(
          or(
            and(
              eq(resultArchiveReductionQueue.state, "pending"),
              lte(resultArchiveReductionQueue.nextAttemptAt, now),
            ),
            and(
              eq(resultArchiveReductionQueue.state, "hydrating"),
              lte(resultArchiveReductionQueue.claimExpiresAt, now),
            ),
          ),
          scope.resultIds?.length
            ? inArray(resultArchiveReductionQueue.resultId, scope.resultIds)
            : undefined,
          scope.resultAttemptIds?.length
            ? inArray(
                resultArchiveReductionQueue.resultAttemptId,
                scope.resultAttemptIds,
              )
            : undefined,
        ),
      )
      .orderBy(
        asc(resultArchiveReductionQueue.nextAttemptAt),
        asc(resultArchiveReductionQueue.createdAt),
      )
      .limit(1)
      // Multiple scheduler processes may drain this queue. Do not block a
      // second worker behind a long archive reduction; skip its leased row and
      // atomically claim the next exact archive instead.
      .for("update", { skipLocked: true });
    if (!item) return null;
    const claimToken = randomUUID();
    const [claimed] = await tx
      .update(resultArchiveReductionQueue)
      .set({
        state: "hydrating",
        attemptCount: item.attemptCount + 1,
        claimToken,
        claimExpiresAt: new Date(
          now.getTime() + ARCHIVE_REDUCTION_QUEUE_LEASE_MS,
        ),
        nextAttemptAt: now,
      })
      .where(eq(resultArchiveReductionQueue.id, item.id))
      .returning({ id: resultArchiveReductionQueue.id });
    if (!claimed) return null;
    return {
      ...item,
      state: "hydrating",
      attemptCount: item.attemptCount + 1,
      claimToken,
    } as QueueItem;
  });
}

async function settleQueueItem(
  db: DB,
  item: QueueItem,
  values: {
    state: Exclude<QueueState, "hydrating">;
    backfillRunId?: string | null;
    resultInterpretationId?: string | null;
    lastError?: string | null;
    nextAttemptAt?: Date;
  },
): Promise<boolean> {
  const [settled] = await db
    .update(resultArchiveReductionQueue)
    .set({
      state: values.state,
      claimToken: null,
      claimExpiresAt: null,
      backfillRunId:
        values.backfillRunId === undefined
          ? item.backfillRunId
          : values.backfillRunId,
      resultInterpretationId: values.resultInterpretationId ?? null,
      lastError: values.lastError ?? null,
      nextAttemptAt: values.nextAttemptAt ?? new Date(),
    })
    .where(
      and(
        eq(resultArchiveReductionQueue.id, item.id),
        eq(resultArchiveReductionQueue.state, "hydrating"),
        eq(resultArchiveReductionQueue.claimToken, item.claimToken),
        sql`${resultArchiveReductionQueue.claimExpiresAt} > clock_timestamp()`,
      ),
    )
    .returning({ id: resultArchiveReductionQueue.id });
  if (!settled) return false;
  // This is an observable campaign transition, not just background metadata.
  // Recompute the exact linked cells after every successful queue settlement
  // so a publication wait cannot linger as solved/rejected/blocked.
  await refreshCampaignProgressForResultIds(db, [item.resultId]);
  return true;
}

/**
 * A recovery action that has published a later accepted URANS generation
 * closes every still-open archive-publication receipt for the exact failed
 * source. This is deliberately source-pinned: it cannot cancel a newer
 * archive/reducer receipt, and it refreshes campaign progress so an
 * `awaiting archive reduction` cell cannot remain stuck after recovery.
 */
export async function supersedeArchiveReductionQueueForRecoveredAction(
  db: DB,
  input: {
    resultId: string;
    resultAttemptId: string;
    sourceArchiveId: string;
    reason?: string;
  },
): Promise<number> {
  const changed = await db
    .update(resultArchiveReductionQueue)
    .set({
      state: "superseded",
      claimToken: null,
      claimExpiresAt: null,
      lastError:
        input.reason ??
        "a later accepted URANS recovery generation superseded this archive publication receipt",
      nextAttemptAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resultArchiveReductionQueue.resultId, input.resultId),
        eq(resultArchiveReductionQueue.resultAttemptId, input.resultAttemptId),
        eq(resultArchiveReductionQueue.sourceArchiveId, input.sourceArchiveId),
        or(
          eq(resultArchiveReductionQueue.state, "pending"),
          eq(resultArchiveReductionQueue.state, "hydrating"),
          eq(resultArchiveReductionQueue.state, "continuation_required"),
          eq(resultArchiveReductionQueue.state, "rerun_required"),
        ),
      ),
    )
    .returning({ resultId: resultArchiveReductionQueue.resultId });
  if (changed.length) {
    await refreshCampaignProgressForResultIds(db, [
      ...new Set(changed.map((row) => row.resultId)),
    ]);
  }
  return changed.length;
}

/**
 * Create and attach the child receipt under one queue-row lock. Creating a
 * run and attaching it in separate transactions can orphan a run if the
 * queue lease changes between those writes. This short transaction performs
 * no reducer I/O, so the lock makes child-run ownership durable without
 * blocking physical work.
 */
async function ensureBackfillRunForQueueClaim(
  db: DB,
  item: QueueItem,
): Promise<string | null> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // Match the staging/selection and admission lock order. Creating the
    // child receipt ultimately writes an item with a result FK, so taking the
    // queue first would deadlock a concurrent stage that correctly holds the
    // result row before it renews/fences this queue claim.
    const [lockedResult] = await tx
      .select({ id: results.id })
      .from(results)
      .where(eq(results.id, item.resultId))
      .limit(1)
      .for("update");
    if (!lockedResult) return null;
    const [queue] = await tx
      .select({ backfillRunId: resultArchiveReductionQueue.backfillRunId })
      .from(resultArchiveReductionQueue)
      .where(
        and(
          eq(resultArchiveReductionQueue.id, item.id),
          eq(resultArchiveReductionQueue.state, "hydrating"),
          eq(resultArchiveReductionQueue.claimToken, item.claimToken),
          sql`${resultArchiveReductionQueue.claimExpiresAt} > clock_timestamp()`,
        ),
      )
      .limit(1)
      .for("update");
    if (!queue) return null;
    // Do not let an expired claimant attach or reuse a durable child run.
    // This renewal is inside the queue-row transaction, so a successor cannot
    // claim the parent between the expiry proof and child-run ownership.
    if (!(await renewQueueClaimLease(tx, item))) return null;
    if (queue.backfillRunId) return queue.backfillRunId;

    const created = await createArchiveInterpretationBackfillRun({
      db: tx,
      reducerVersionId: item.reducerVersionId,
      exactSource: {
        resultId: item.resultId,
        resultAttemptId: item.resultAttemptId,
        sourceArchiveId: item.sourceArchiveId,
      },
      requestedBy: "system:archive-publication-queue",
    });
    const [attached] = await tx
      .update(resultArchiveReductionQueue)
      .set({ backfillRunId: created.runId, updatedAt: new Date() })
      .where(
        and(
          eq(resultArchiveReductionQueue.id, item.id),
          eq(resultArchiveReductionQueue.state, "hydrating"),
          eq(resultArchiveReductionQueue.claimToken, item.claimToken),
          sql`${resultArchiveReductionQueue.claimExpiresAt} > clock_timestamp()`,
          isNull(resultArchiveReductionQueue.backfillRunId),
        ),
      )
      .returning({ id: resultArchiveReductionQueue.id });
    if (!attached) {
      // The throw rolls back the freshly-created child run as well.
      throw new ArchiveReductionQueueClaimLostError();
    }
    return created.runId;
  });
}

async function renewQueueClaimLease(db: DB, item: QueueItem): Promise<boolean> {
  const [renewed] = await db
    .update(resultArchiveReductionQueue)
    .set({
      claimExpiresAt: new Date(Date.now() + ARCHIVE_REDUCTION_QUEUE_LEASE_MS),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resultArchiveReductionQueue.id, item.id),
        eq(resultArchiveReductionQueue.state, "hydrating"),
        eq(resultArchiveReductionQueue.claimToken, item.claimToken),
        sql`${resultArchiveReductionQueue.claimExpiresAt} > clock_timestamp()`,
      ),
    )
    .returning({ id: resultArchiveReductionQueue.id });
  return renewed != null;
}

class ArchiveReductionQueueClaimLostError extends Error {
  constructor() {
    super(
      "archive reduction queue claim was lost while reducer I/O was active",
    );
  }
}

/** Keep the outer queue claim alive for the full child-run execution. The
 * child receipt has its own heartbeat in result-interpretation-backfill; both
 * leases must survive a slow GCS read to prevent duplicate queue/run claims. */
async function withQueueClaimLease<T>(
  db: DB,
  item: QueueItem,
  work: () => Promise<T>,
): Promise<T> {
  let lost = false;
  let renewing = false;
  const renew = async () => {
    if (lost || renewing) return;
    renewing = true;
    try {
      if (!(await renewQueueClaimLease(db, item))) lost = true;
    } catch {
      // A transient database failure must not let a stale claimant publish or
      // settle after its lease. Leave the receipt for its next owner instead.
      lost = true;
    } finally {
      renewing = false;
    }
  };
  await renew();
  if (lost) throw new ArchiveReductionQueueClaimLostError();
  const timer = setInterval(() => {
    void renew();
  }, ARCHIVE_REDUCTION_QUEUE_LEASE_RENEW_MS);
  timer.unref?.();
  try {
    const value = await work();
    if (lost) throw new ArchiveReductionQueueClaimLostError();
    return value;
  } finally {
    clearInterval(timer);
  }
}

async function alreadySelected(
  db: DB,
  item: QueueItem,
): Promise<{ interpretationId: string } | null> {
  const [row] = await db
    .select({ interpretationId: resultInterpretations.id })
    .from(results)
    .innerJoin(
      resultCanonicalSelections,
      eq(resultCanonicalSelections.id, results.currentCanonicalSelectionId),
    )
    .innerJoin(
      resultInterpretations,
      eq(resultInterpretations.id, results.currentResultInterpretationId),
    )
    .where(
      and(
        eq(results.id, item.resultId),
        eq(results.currentResultAttemptId, item.resultAttemptId),
        eq(results.currentCanonicalSelectionId, resultCanonicalSelections.id),
        eq(results.currentResultInterpretationId, resultInterpretations.id),
        eq(resultCanonicalSelections.resultId, item.resultId),
        eq(resultCanonicalSelections.resultAttemptId, item.resultAttemptId),
        eq(
          resultCanonicalSelections.resultInterpretationId,
          resultInterpretations.id,
        ),
        eq(resultInterpretations.resultId, item.resultId),
        eq(resultInterpretations.resultAttemptId, item.resultAttemptId),
        eq(resultInterpretations.sourceArchiveId, item.sourceArchiveId),
        eq(resultInterpretations.source, "archive_backfill"),
        eq(resultInterpretations.state, "accepted"),
        eq(resultInterpretations.reducerVersionId, item.reducerVersionId),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * A queue row refers to one immutable archive, so it must stop before reducer
 * I/O when a newer generation has superseded that source.  The one allowed
 * non-current case is deliberate: an exact source-pinned RANS handoff stays
 * public while its URANS successor is reduced.  The selector performs
 * the same CAS again immediately before promotion.
 */
async function publicationCandidateCanStillPublish(
  db: DB,
  item: QueueItem,
): Promise<boolean> {
  const [[source], [target], [current]] = await Promise.all([
    db
      .select({ id: solverEvidenceArchives.id })
      .from(solverEvidenceArchives)
      .where(
        and(
          eq(solverEvidenceArchives.id, item.sourceArchiveId),
          eq(solverEvidenceArchives.resultId, item.resultId),
          eq(solverEvidenceArchives.resultAttemptId, item.resultAttemptId),
          eq(solverEvidenceArchives.state, "current"),
        ),
      )
      .limit(1),
    db
      .select({
        fidelity: sql<unknown>`COALESCE(
          ${resultAttempts.evidencePayload} ->> 'fidelity',
          ${resultAttempts.evidencePayload} ->> 'fidelityTier'
        )`,
      })
      .from(resultAttempts)
      .where(
        and(
          eq(resultAttempts.id, item.resultAttemptId),
          eq(resultAttempts.resultId, item.resultId),
        ),
      )
      .limit(1),
    db
      .select({
        currentAttemptId: results.currentResultAttemptId,
        currentInterpretationId: results.currentResultInterpretationId,
      })
      .from(results)
      .where(eq(results.id, item.resultId))
      .limit(1),
  ]);
  if (!source || !target || !current) return false;
  if (current.currentAttemptId === item.resultAttemptId) {
    return mayRunArchiveReduction({
      sourceArchiveCurrent: true,
      targetAttemptCurrent: true,
      hasExactPrecalcRansLineage: false,
    });
  }
  if (!current.currentAttemptId) return false;

  const [predecessor] = await db
    .select({
      fidelity: sql<unknown>`COALESCE(
        ${resultAttempts.evidencePayload} ->> 'fidelity',
        ${resultAttempts.evidencePayload} ->> 'fidelityTier'
      )`,
    })
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, current.currentAttemptId),
        eq(resultAttempts.resultId, item.resultId),
      ),
    )
    .limit(1);
  const hasExactPrecalcLineage = await hasExactPrecalcUransPromotionLineage({
    db,
    resultId: item.resultId,
    currentRansAttemptId: current.currentAttemptId,
    targetUransAttemptId: item.resultAttemptId,
  });
  const hasExactPrecalcRansLineage = mayPromoteArchiveUransFromExactPrecalcRans(
    {
      targetFidelity:
        typeof target.fidelity === "string"
          ? parsePointFidelity(target.fidelity)
          : null,
      currentFidelity:
        typeof predecessor?.fidelity === "string"
          ? parsePointFidelity(predecessor.fidelity)
          : null,
      hasExactPrecalcLineage,
    },
  );
  return mayRunArchiveReduction({
    sourceArchiveCurrent: true,
    targetAttemptCurrent: false,
    hasExactPrecalcRansLineage,
  });
}

function queueStateForBackfillItem(
  state: string,
): Exclude<QueueState, "hydrating"> {
  if (
    state === "reduced" ||
    state === "superseded" ||
    state === "missing_evidence" ||
    state === "continuation_required" ||
    state === "rerun_required" ||
    state === "terminal_failure" ||
    state === "failed"
  ) {
    return state;
  }
  return "pending";
}

function limitedQueueError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return (
    text.trim().slice(0, 2_000) ||
    "archive reduction queue failed without an error message"
  );
}

async function processQueueItemImpl(
  db: DB,
  engine: EngineClient,
  item: QueueItem,
) {
  const selected = await alreadySelected(db, item);
  if (selected) {
    await settleQueueItem(db, item, {
      state: "reduced",
      resultInterpretationId: selected.interpretationId,
    });
    return;
  }
  if (!(await publicationCandidateCanStillPublish(db, item))) {
    await settleQueueItem(db, item, {
      state: "superseded",
      lastError:
        "archive source or URANS generation was superseded before publication",
    });
    return;
  }

  // A queue claim resumes the same bounded audit run after a transient engine
  // failure.  Only the first claim creates a run; recurring sweeper ticks
  // therefore never manufacture one run per tick.
  const runId =
    item.backfillRunId ?? (await ensureBackfillRunForQueueClaim(db, item));
  if (!runId) {
    // The claim was lost before the child could be attached. The next owner
    // will resume this queue row; do not fabricate an unowned child run.
    return;
  }
  const report = await withQueueClaimLease(db, item, () =>
    runArchiveInterpretationBackfill({
      db,
      engine,
      runId,
      maxItems: 1,
      expectedReducerVersionId: item.reducerVersionId,
      publicationClaim: {
        queueItemId: item.id,
        queueClaimToken: item.claimToken,
      },
    }),
  );
  const [child] = await db
    .select({
      state: resultInterpretationBackfillItems.state,
      resultInterpretationId:
        resultInterpretationBackfillItems.resultInterpretationId,
      lastError: resultInterpretationBackfillItems.lastError,
      nextAttemptAt: resultInterpretationBackfillItems.nextAttemptAt,
    })
    .from(resultInterpretationBackfillItems)
    .where(
      and(
        eq(resultInterpretationBackfillItems.runId, runId),
        eq(
          resultInterpretationBackfillItems.resultAttemptId,
          item.resultAttemptId,
        ),
        eq(
          resultInterpretationBackfillItems.sourceArchiveId,
          item.sourceArchiveId,
        ),
      ),
    )
    .limit(1);
  // The child receipt is exact-source-pinned. If A was superseded by B while
  // the engine reduced A, settle this queue row as superseded; never turn the
  // stale source into a retry that silently reads B.
  if (!(await publicationCandidateCanStillPublish(db, item))) {
    await settleQueueItem(db, item, {
      state: "superseded",
      backfillRunId: runId,
      resultInterpretationId: child?.resultInterpretationId ?? null,
      lastError:
        "archive source or URANS generation was superseded during reduction",
    });
    return;
  }
  if (!child) {
    // A prior completed reduction can make discovery intentionally empty.
    // Re-check the canonical pointer before declaring anything terminal.
    const selectedAfter = await alreadySelected(db, item);
    await settleQueueItem(
      db,
      item,
      selectedAfter
        ? {
            state: "reduced",
            backfillRunId: runId,
            resultInterpretationId: selectedAfter.interpretationId,
          }
        : {
            state: report.state === "failed" ? "failed" : "pending",
            backfillRunId: runId,
            lastError:
              report.state === "failed"
                ? "archive reduction run failed before creating a receipt"
                : null,
            nextAttemptAt: new Date(Date.now() + 60_000),
          },
    );
    return;
  }
  const state = queueStateForBackfillItem(child.state);
  if (state === "reduced") {
    const selectedAfter = await alreadySelected(db, item);
    if (selectedAfter) {
      await settleQueueItem(db, item, {
        state,
        backfillRunId: runId,
        resultInterpretationId: selectedAfter.interpretationId,
      });
      return;
    }
    if (!(await publicationCandidateCanStillPublish(db, item))) {
      await settleQueueItem(db, item, {
        state: "superseded",
        backfillRunId: runId,
        resultInterpretationId: child.resultInterpretationId,
        lastError:
          "archive reduction completed after its source was superseded",
      });
      return;
    }
    // A reducer may have completed just before a process crash between staging
    // and selection. Reuse its immutable interpretation; never launch a new
    // CFD solve or a duplicate reducer run to close that small window.
    const replayedSelection = await selectAcceptedArchiveInterpretation({
      db,
      resultId: item.resultId,
      resultAttemptId: item.resultAttemptId,
      sourceArchiveId: item.sourceArchiveId,
      interpretationId: child.resultInterpretationId,
      backfillRunId: runId,
      reducerVersionId: item.reducerVersionId,
      publicationClaim: {
        queueItemId: item.id,
        queueClaimToken: item.claimToken,
      },
      actor: "system:archive-publication-queue-recovery",
    });
    const selectedOnReplay = await alreadySelected(db, item);
    if (selectedOnReplay) {
      const [scope] = await db
        .select({
          airfoilId: results.airfoilId,
          revisionId: results.simulationPresetRevisionId,
        })
        .from(results)
        .where(eq(results.id, item.resultId))
        .limit(1);
      if (scope?.revisionId) {
        await refreshPolarCacheForRevision(
          db,
          scope.airfoilId,
          scope.revisionId,
        );
      }
    }
    await settleQueueItem(
      db,
      item,
      selectedOnReplay
        ? {
            state: "reduced",
            backfillRunId: runId,
            resultInterpretationId: selectedOnReplay.interpretationId,
          }
        : replayedSelection === "stale_attempt"
          ? {
              state: "superseded",
              backfillRunId: runId,
              resultInterpretationId: child.resultInterpretationId,
              lastError: "archive selection lost its generation fence",
            }
          : replayedSelection === "superseded_by_newer_reducer"
            ? {
                state: "superseded",
                backfillRunId: runId,
                resultInterpretationId: child.resultInterpretationId,
                lastError:
                  "archive reduction completed under an older reducer release",
              }
            : {
                state: "pending",
                backfillRunId: runId,
                resultInterpretationId: child.resultInterpretationId,
                lastError:
                  "archive reduction staged but selection is not yet publishable",
                nextAttemptAt: new Date(Date.now() + 60_000),
              },
    );
    return;
  }
  await settleQueueItem(db, item, {
    state,
    backfillRunId: runId,
    resultInterpretationId: child.resultInterpretationId,
    lastError: child.lastError,
    nextAttemptAt: child.nextAttemptAt,
  });
}

/** Always settle unexpected queue-worker exceptions. A failed reduction must
 * enter ordinary bounded retry/backoff immediately; leaving it in `hydrating`
 * makes the UI and campaign ledger wait for lease expiry with no owner. */
async function processQueueItem(db: DB, engine: EngineClient, item: QueueItem) {
  try {
    await processQueueItemImpl(db, engine, item);
  } catch (error) {
    if (error instanceof ArchiveReductionQueueClaimLostError) return;
    await settleQueueItem(db, item, {
      state: "pending",
      nextAttemptAt: new Date(
        Date.now() + archiveReductionRetryDelayMs(item.attemptCount),
      ),
      lastError: limitedQueueError(error),
    });
  }
}

/** Recover any crash between ingest commit and enqueue, then lease at most a
 * tiny bounded number of reductions.  Expensive reducer I/O runs from the
 * caller's single-flight background task; no admission tick awaits it. */
export async function drainArchiveReductionQueue(
  db: DB,
  engine: EngineClient,
  opts: ArchiveReductionQueueScope & {
    maxItems?: number;
    enqueue?: boolean;
    /** A scheduler which already made a live capability decision passes it
     * through so the nonblocking queue tail does not add another health
     * round-trip. Direct CLI callers deliberately omit it and probe here. */
    archiveReductionVersion?: number | null;
  } = {},
): Promise<ArchiveReductionQueueDrainReport> {
  const archiveReductionVersion =
    opts.archiveReductionVersion === undefined
      ? await engineArchiveReductionVersion(engine)
      : opts.archiveReductionVersion;
  // Do this before discovery or claiming. A legacy gateway does not expose the
  // immutable archive endpoint; creating a backoff/error receipt in that
  // expected rolling-upgrade state would misrepresent deployment sequencing as
  // a data-quality failure. Pending exact-source rows resume after v1 appears.
  if (!supportsArchiveCleanCycleReduction(archiveReductionVersion)) {
    return {
      scanned: 0,
      enqueued: 0,
      admittedResultAttemptIds: [],
      processed: 0,
      archiveReductionVersion,
      deferredByCapability: true,
    };
  }
  const scan =
    opts.enqueue === false
      ? { scanned: 0, enqueued: 0, admittedResultAttemptIds: [] }
      : await enqueueVerifiedArchiveReductions(db, {
          resultIds: opts.resultIds,
          resultAttemptIds: opts.resultAttemptIds,
        });
  const maxItems = opts.maxItems ?? ARCHIVE_REDUCTION_QUEUE_DRAIN_LIMIT;
  if (
    !Number.isSafeInteger(maxItems) ||
    maxItems <= 0 ||
    maxItems > ARCHIVE_REDUCTION_QUEUE_MAX_DRAIN_LIMIT
  ) {
    throw new Error("archive-reduction queue drain maxItems must be 1..8");
  }
  let processed = 0;
  for (let index = 0; index < maxItems; index += 1) {
    const item = await claimNextQueueItem(db, opts);
    if (!item) break;
    await processQueueItem(db, engine, item);
    processed += 1;
  }
  return {
    scanned: scan.scanned,
    enqueued: scan.enqueued,
    admittedResultAttemptIds: scan.admittedResultAttemptIds,
    processed,
    archiveReductionVersion,
    deferredByCapability: false,
  };
}

const scheduleDrainSingleFlight = createSingleFlightBackgroundRunner(
  (error) => {
    console.error(
      "[sweeper] archive publication queue drain failed:",
      error instanceof Error ? error.message : error,
    );
  },
);

/** Non-blocking tail of the scheduler tick. */
export function scheduleArchiveReductionQueueDrain(
  db: DB,
  engine: EngineClient,
  opts: { archiveReductionVersion?: number | null } = {},
): boolean {
  return scheduleDrainSingleFlight(() =>
    drainArchiveReductionQueue(db, engine, {
      maxItems: ARCHIVE_REDUCTION_QUEUE_DRAIN_LIMIT,
      archiveReductionVersion: opts.archiveReductionVersion,
    }),
  );
}
