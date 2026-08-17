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
  hasExactLivePrecalcPublicationWinner,
  refreshCampaignProgressForResultIds,
  refreshPolarCacheForRevision,
  satisfyPrecalcObligationFromAcceptedResult,
  resultArchiveReductionQueue,
  resultAttempts,
  resultCanonicalSelections,
  resultInterpretationBackfillItems,
  resultInterpretationBackfillRuns,
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
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { randomUUID } from "node:crypto";

import {
  archivePointerForBackfill,
  createArchiveInterpretationBackfillRun,
  runArchiveInterpretationBackfill,
} from "./result-interpretation-backfill";
import {
  ensureResultInterpretationReducerVersion,
  hasExactLegacyUransArchiveGapRecoveryLineage,
  hasExactPrecalcUransPromotionLineage,
  mayPromoteArchiveUransFromExactPrecalcRans,
  selectAcceptedArchiveInterpretation,
} from "./result-interpretations";
import {
  archiveReductionRetryDelayMs,
  CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY,
  mayRunArchiveReduction,
  reducerVersionIsNewer,
  selectArchiveReductionScanPage,
} from "./archive-reduction-queue-policy";
import {
  engineArchiveReductionVersion,
  supportsArchiveCleanCycleReduction,
} from "./engine-capabilities";
import { ordinaryWriterBlockedByMaintenanceDrain } from "./maintenance-drain";
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
  | "failed"
  /** Legacy persisted value. New code never assigns it; a reopened current
   * source may be re-armed through the compatibility branch below. */
  | "historical_audit_required";

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

/** A completed normal child may outlive the live projection that selected it.
 * When the exact result is deliberately reopened, it is safe to replay that
 * immutable child selection; any other historical child must be detached so a
 * fresh live receipt can decide the current generation. */
type ReplayableHistoricalChild = {
  backfillRunId: string;
  resultInterpretationId: string;
};

const selectedArchiveReducer = alias(
  resultReducerVersions,
  "selected_archive_reducer",
);

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
  const [candidateReducer] = await db
    .select({
      id: resultReducerVersions.id,
      reducerKey: resultReducerVersions.reducerKey,
      reducerVersion: resultReducerVersions.reducerVersion,
      reducerBuildId: resultReducerVersions.buildId,
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
  const limit = opts.limit ?? ARCHIVE_REDUCTION_QUEUE_SCAN_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 10_000) {
    throw new Error("archive-reduction queue scan limit must be 1..10000");
  }
  const resultIds = [...new Set(opts.resultIds ?? [])];
  const resultAttemptIds = [...new Set(opts.resultAttemptIds ?? [])];
  const scanMode =
    resultIds.length || resultAttemptIds.length
      ? "explicit_historical_repair"
      : "routine";
  // An explicit exact source is an operator/ingest repair path. The bounded
  // unscoped crash-recovery scanner is prospective from the v6 release so it
  // cannot create work for every historical verified archive.
  const routineV5SelectionCompatibility =
    scanMode === "routine"
      ? sql`
          OR (
            ${candidateReducer.reducerKey} = 'airfoilfoam'
            AND ${candidateReducer.reducerVersion} = 'result-interpretation-v2'
            AND ${candidateReducer.reducerBuildId} = 'clean-cycle-v6'
            AND EXISTS (
              SELECT 1
              FROM result_reducer_versions compatible_v5_reducer
              WHERE compatible_v5_reducer.id
                = existing_interpretation.reducer_version_id
                AND compatible_v5_reducer.reducer_key
                  = ${CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY.reducerKey}
                AND compatible_v5_reducer.reducer_version
                  = ${CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY.reducerVersion}
                AND compatible_v5_reducer.build_id
                  = ${CLEAN_CYCLE_V5_SELECTION_COMPATIBILITY.reducerBuildId}
            )
          )`
      : sql``;
  const rows = await db
    .select({
      resultId: results.id,
      resultAttemptId: resultAttempts.id,
      resultAttemptCreatedAt: resultAttempts.createdAt,
      currentResultAttemptId: results.currentResultAttemptId,
      sourceArchiveId: solverEvidenceArchives.id,
      sourceArchiveCreatedAt: solverEvidenceArchives.createdAt,
      blob: solverEvidenceBlobs,
      currentSelectionId: results.currentCanonicalSelectionId,
      selectedInterpretationId: results.currentResultInterpretationId,
      selectedState: resultInterpretations.state,
      selectedSource: resultInterpretations.source,
      selectedArchiveId: resultInterpretations.sourceArchiveId,
      selectedReducerVersionId: resultInterpretations.reducerVersionId,
      selectedReducerKey: selectedArchiveReducer.reducerKey,
      selectedReducerVersion: selectedArchiveReducer.reducerVersion,
      selectedReducerBuildId: selectedArchiveReducer.buildId,
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
    .leftJoin(
      selectedArchiveReducer,
      eq(selectedArchiveReducer.id, resultInterpretations.reducerVersionId),
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
        scanMode === "routine"
          ? gte(solverEvidenceArchives.createdAt, candidateReducer.createdAt)
          : undefined,
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
            AND (
              existing_interpretation.reducer_version_id = ${reducerVersionId}::uuid
              ${routineV5SelectionCompatibility}
            )
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

  const rowsWithExactPublicationOwner = await Promise.all(
    rows.map(async (row) => ({
      ...row,
      archivePointerValid: archivePointerForBackfill(row.blob).pointer != null,
      resultHasCurrentAttempt: row.currentResultAttemptId != null,
      hasExactLivePrecalcPublicationOwner:
        row.currentResultAttemptId == null &&
        (await hasExactLivePrecalcPublicationWinner(db, {
          resultId: row.resultId,
          resultAttemptId: row.resultAttemptId,
        })),
      currentSelection: {
        acceptedArchive:
          row.currentSelectionId != null &&
          row.selectedInterpretationId != null &&
          row.selectedState === "accepted" &&
          row.selectedSource === "archive_backfill",
        sourceArchiveId: row.selectedArchiveId,
        reducerVersionId: row.selectedReducerVersionId,
        reducerKey: row.selectedReducerKey,
        reducerVersion: row.selectedReducerVersion,
        reducerBuildId: row.selectedReducerBuildId,
      },
    })),
  );
  const candidates = selectArchiveReductionScanPage(
    rowsWithExactPublicationOwner,
    candidateReducer,
    limit,
    scanMode,
  );
  if (!candidates.length) {
    return {
      reducerVersionId,
      scanned: rows.length,
      enqueued: 0,
      admittedResultAttemptIds: [],
    };
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
        .select({
          id: results.id,
          currentResultAttemptId: results.currentResultAttemptId,
        })
        .from(results)
        .where(eq(results.id, candidate.resultId))
        .limit(1)
        .for("update");
      // The outer scan is intentionally bounded and cannot hold result locks.
      // Re-prove this result still owns a live generation under the same lock
      // that inserts the queue receipt; otherwise a concurrent release could
      // turn historical GCS evidence into live publication work.
      const exactLivePrecalcOwner =
        lockedResult?.currentResultAttemptId == null &&
        lockedResult != null &&
        (await hasExactLivePrecalcPublicationWinner(tx, {
          resultId: candidate.resultId,
          resultAttemptId: candidate.resultAttemptId,
          lockForPublication: true,
        }));
      if (
        !lockedResult ||
        (!lockedResult.currentResultAttemptId && !exactLivePrecalcOwner)
      ) {
        return { inserted: false, active: false };
      }
      // The outer scan only proves that *some* generation was current when it
      // read the row. Recheck the full exact-source publication contract while
      // the result is locked: an old archived attempt must not wake from its
      // historical-audit hold merely because a different generation became
      // current. The sole non-current exception is the explicit PRECALC RANS
      // lineage encoded by `publicationCandidateState`.
      if ((await publicationCandidateState(tx, candidate)) !== "publishable") {
        return { inserted: false, active: false };
      }

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
      // receipts that were already admitted remain retained queue history, but
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
      // A released result deliberately parks an inherited receipt outside the
      // runnable queue. If the exact result is later deliberately reopened,
      // that audit-only hold must not suppress its ordinary archive
      // publication forever: the same immutable source is now live again and
      // may resume its normal archive_backfill authority. The result row lock
      // above makes this re-proof and state transition atomic with respect to
      // a concurrent release/selection. A child that reduced successfully
      // before the release stays immutable scientific evidence and is replayed
      // without reducer I/O; an incomplete/failed child is detached so the
      // revived live receipt creates a fresh exact child instead.
      if (!inserted) {
        const [replayableHistoricalChild] = await tx
          .select({
            backfillRunId: resultArchiveReductionQueue.backfillRunId,
            resultInterpretationId:
              resultInterpretationBackfillItems.resultInterpretationId,
          })
          .from(resultArchiveReductionQueue)
          .innerJoin(
            resultInterpretationBackfillItems,
            and(
              eq(
                resultInterpretationBackfillItems.runId,
                resultArchiveReductionQueue.backfillRunId,
              ),
              eq(
                resultInterpretationBackfillItems.resultId,
                resultArchiveReductionQueue.resultId,
              ),
              eq(
                resultInterpretationBackfillItems.resultAttemptId,
                resultArchiveReductionQueue.resultAttemptId,
              ),
              eq(
                resultInterpretationBackfillItems.sourceArchiveId,
                resultArchiveReductionQueue.sourceArchiveId,
              ),
              eq(resultInterpretationBackfillItems.state, "reduced"),
            ),
          )
          .innerJoin(
            resultInterpretations,
            and(
              eq(
                resultInterpretations.id,
                resultInterpretationBackfillItems.resultInterpretationId,
              ),
              eq(
                resultInterpretations.resultId,
                resultArchiveReductionQueue.resultId,
              ),
              eq(
                resultInterpretations.resultAttemptId,
                resultArchiveReductionQueue.resultAttemptId,
              ),
              eq(
                resultInterpretations.sourceArchiveId,
                resultArchiveReductionQueue.sourceArchiveId,
              ),
              eq(
                resultInterpretations.reducerVersionId,
                resultArchiveReductionQueue.reducerVersionId,
              ),
              eq(resultInterpretations.source, "archive_backfill"),
              eq(resultInterpretations.state, "accepted"),
            ),
          )
          .where(
            and(
              eq(resultArchiveReductionQueue.resultId, candidate.resultId),
              eq(
                resultArchiveReductionQueue.resultAttemptId,
                candidate.resultAttemptId,
              ),
              eq(
                resultArchiveReductionQueue.sourceArchiveId,
                candidate.sourceArchiveId,
              ),
              eq(
                resultArchiveReductionQueue.reducerVersionId,
                reducerVersionId,
              ),
              eq(
                resultArchiveReductionQueue.state,
                "historical_audit_required",
              ),
            ),
          )
          .limit(1);
        const preservedChild: ReplayableHistoricalChild | null =
          replayableHistoricalChild?.backfillRunId &&
          replayableHistoricalChild.resultInterpretationId
            ? {
                backfillRunId: replayableHistoricalChild.backfillRunId,
                resultInterpretationId:
                  replayableHistoricalChild.resultInterpretationId,
              }
            : null;
        await tx
          .update(resultArchiveReductionQueue)
          .set({
            state: "pending",
            claimToken: null,
            claimExpiresAt: null,
            attemptCount: 0,
            backfillRunId: preservedChild?.backfillRunId ?? null,
            resultInterpretationId:
              preservedChild?.resultInterpretationId ?? null,
            lastError: null,
            nextAttemptAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(resultArchiveReductionQueue.resultId, candidate.resultId),
              eq(
                resultArchiveReductionQueue.resultAttemptId,
                candidate.resultAttemptId,
              ),
              eq(
                resultArchiveReductionQueue.sourceArchiveId,
                candidate.sourceArchiveId,
              ),
              eq(
                resultArchiveReductionQueue.reducerVersionId,
                reducerVersionId,
              ),
              eq(
                resultArchiveReductionQueue.state,
                "historical_audit_required",
              ),
            ),
          );

        // A receipt may already have reduced normally before an operator
        // released the result projection. When that same exact generation is
        // deliberately made live again, retain its immutable normal child and
        // interpretation and re-arm the parent only to replay canonical
        // selection. Re-reducing the same authenticated archive would waste
        // work and manufacture duplicate scientific history.
        await tx
          .update(resultArchiveReductionQueue)
          .set({
            state: "pending",
            claimToken: null,
            claimExpiresAt: null,
            attemptCount: 0,
            lastError: null,
            nextAttemptAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(resultArchiveReductionQueue.resultId, candidate.resultId),
              eq(
                resultArchiveReductionQueue.resultAttemptId,
                candidate.resultAttemptId,
              ),
              eq(
                resultArchiveReductionQueue.sourceArchiveId,
                candidate.sourceArchiveId,
              ),
              eq(
                resultArchiveReductionQueue.reducerVersionId,
                reducerVersionId,
              ),
              eq(resultArchiveReductionQueue.state, "reduced"),
            ),
          );
      }
      const [active] = await tx
        .select({ id: resultArchiveReductionQueue.id })
        .from(resultArchiveReductionQueue)
        .where(
          and(
            eq(resultArchiveReductionQueue.resultId, candidate.resultId),
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
      return {
        // Preserve the `enqueued` metric as a count of new durable receipts;
        // a reactivated row is nevertheless live for scheduler admission.
        inserted: inserted != null,
        active: active != null,
      };
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

const LEGACY_NATIVE_FETCH_FAILURE = "fetch failed";

/**
 * Before native fetch failures were recognized as connection failures, the
 * first failed request terminally settled both a queue receipt and its child
 * run. The child is immutable operational history, but the queue receipt is
 * deliberately mutable scheduling state. Re-arm only that receipt, and only
 * when no scientific row was ever staged and the exact source is still the
 * current live publication target. A fresh child run therefore gets the
 * normal bounded retry budget without rewriting the forensic failure.
 *
 * This is intentionally much narrower than a generic failed-row retry. It
 * repairs the one known native-fetch misclassification and cannot revive a
 * superseded source, accepted/rejected interpretation, or any engine answer.
 */
export async function rearmLegacyNativeFetchArchiveReductionReceipts(
  db: DB,
  scope: ArchiveReductionQueueScope = {},
): Promise<number> {
  const candidates = await db
    .select({
      queueId: resultArchiveReductionQueue.id,
      resultId: resultArchiveReductionQueue.resultId,
      resultAttemptId: resultArchiveReductionQueue.resultAttemptId,
      sourceArchiveId: resultArchiveReductionQueue.sourceArchiveId,
      reducerVersionId: resultArchiveReductionQueue.reducerVersionId,
      backfillRunId: resultArchiveReductionQueue.backfillRunId,
      childId: resultInterpretationBackfillItems.id,
    })
    .from(resultArchiveReductionQueue)
    .innerJoin(
      resultInterpretationBackfillRuns,
      eq(
        resultInterpretationBackfillRuns.id,
        resultArchiveReductionQueue.backfillRunId,
      ),
    )
    .innerJoin(
      resultInterpretationBackfillItems,
      and(
        eq(
          resultInterpretationBackfillItems.runId,
          resultArchiveReductionQueue.backfillRunId,
        ),
        eq(
          resultInterpretationBackfillItems.resultId,
          resultArchiveReductionQueue.resultId,
        ),
        eq(
          resultInterpretationBackfillItems.resultAttemptId,
          resultArchiveReductionQueue.resultAttemptId,
        ),
        eq(
          resultInterpretationBackfillItems.sourceArchiveId,
          resultArchiveReductionQueue.sourceArchiveId,
        ),
      ),
    )
    .innerJoin(results, eq(results.id, resultArchiveReductionQueue.resultId))
    .where(
      and(
        eq(resultArchiveReductionQueue.state, "failed"),
        eq(resultArchiveReductionQueue.attemptCount, 1),
        eq(resultArchiveReductionQueue.lastError, LEGACY_NATIVE_FETCH_FAILURE),
        isNull(resultArchiveReductionQueue.resultInterpretationId),
        eq(resultInterpretationBackfillRuns.state, "completed"),
        eq(resultInterpretationBackfillItems.state, "failed"),
        eq(resultInterpretationBackfillItems.attemptCount, 1),
        eq(
          resultInterpretationBackfillItems.lastError,
          LEGACY_NATIVE_FETCH_FAILURE,
        ),
        isNull(resultInterpretationBackfillItems.resultInterpretationId),
        eq(
          results.currentResultAttemptId,
          resultArchiveReductionQueue.resultAttemptId,
        ),
        isNull(results.currentResultInterpretationId),
        isNull(results.currentCanonicalSelectionId),
        // A failed child must not be detached if any archive interpretation
        // exists for its exact scientific identity, even if an older worker
        // crashed before writing the reverse receipt pointer.
        sql`NOT EXISTS (
          SELECT 1
          FROM result_interpretations existing_interpretation
          WHERE existing_interpretation.result_id = ${resultArchiveReductionQueue.resultId}
            AND existing_interpretation.result_attempt_id = ${resultArchiveReductionQueue.resultAttemptId}
            AND existing_interpretation.source_archive_id = ${resultArchiveReductionQueue.sourceArchiveId}
            AND existing_interpretation.source = 'archive_backfill'
        )`,
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
    .orderBy(asc(resultArchiveReductionQueue.createdAt))
    .limit(ARCHIVE_REDUCTION_QUEUE_MAX_DRAIN_LIMIT);

  let rearmed = 0;
  for (const candidate of candidates) {
    const repaired = await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      // All writers that change a result's publication identity take this
      // lock. Re-prove the exact current attempt under it so a historical
      // source cannot be revived between discovery and the mutable repair.
      const [lockedResult] = await tx
        .select({
          currentResultAttemptId: results.currentResultAttemptId,
          currentResultInterpretationId: results.currentResultInterpretationId,
          currentCanonicalSelectionId: results.currentCanonicalSelectionId,
        })
        .from(results)
        .where(eq(results.id, candidate.resultId))
        .limit(1)
        .for("update");
      if (
        !lockedResult ||
        lockedResult.currentResultAttemptId !== candidate.resultAttemptId ||
        lockedResult.currentResultInterpretationId != null ||
        lockedResult.currentCanonicalSelectionId != null
      ) {
        return false;
      }

      // Take both mutable receipt rows under the same exact failure shape.
      // The old child is never modified; its terminal `fetch failed` record
      // remains attached to the completed historical run.
      const [child] = await tx
        .select({ id: resultInterpretationBackfillItems.id })
        .from(resultInterpretationBackfillItems)
        .where(
          and(
            eq(resultInterpretationBackfillItems.id, candidate.childId),
            eq(
              resultInterpretationBackfillItems.runId,
              candidate.backfillRunId!,
            ),
            eq(resultInterpretationBackfillItems.state, "failed"),
            eq(resultInterpretationBackfillItems.attemptCount, 1),
            eq(
              resultInterpretationBackfillItems.lastError,
              LEGACY_NATIVE_FETCH_FAILURE,
            ),
            isNull(resultInterpretationBackfillItems.resultInterpretationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!child) return false;

      const [existingInterpretation] = await tx
        .select({ id: resultInterpretations.id })
        .from(resultInterpretations)
        .where(
          and(
            eq(resultInterpretations.resultId, candidate.resultId),
            eq(
              resultInterpretations.resultAttemptId,
              candidate.resultAttemptId,
            ),
            eq(
              resultInterpretations.sourceArchiveId,
              candidate.sourceArchiveId,
            ),
            eq(resultInterpretations.source, "archive_backfill"),
          ),
        )
        .limit(1)
        .for("update");
      if (existingInterpretation) return false;

      const publicationState = await publicationCandidateState(tx, candidate);
      if (publicationState !== "publishable") return false;

      const [rearmedQueue] = await tx
        .update(resultArchiveReductionQueue)
        .set({
          state: "pending",
          claimToken: null,
          claimExpiresAt: null,
          // Detach only the mutable parent. Its preserved child/run remains
          // the durable forensic proof of the original native-fetch failure.
          backfillRunId: null,
          resultInterpretationId: null,
          lastError:
            `rearmed after preserved native-fetch child ${candidate.childId}; ` +
            "the original failed run remains immutable operational history",
          nextAttemptAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(resultArchiveReductionQueue.id, candidate.queueId),
            eq(resultArchiveReductionQueue.state, "failed"),
            eq(resultArchiveReductionQueue.attemptCount, 1),
            eq(
              resultArchiveReductionQueue.lastError,
              LEGACY_NATIVE_FETCH_FAILURE,
            ),
            eq(
              resultArchiveReductionQueue.backfillRunId,
              candidate.backfillRunId!,
            ),
            isNull(resultArchiveReductionQueue.resultInterpretationId),
          ),
        )
        .returning({ id: resultArchiveReductionQueue.id });
      return rearmedQueue != null;
    });
    if (repaired) rearmed += 1;
  }
  return rearmed;
}

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
    /** Historical released evidence is not a campaign transition. Do not make
     * a queue-cleanup receipt look like solved/blocked campaign work. */
    refreshCampaignProgress?: boolean;
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
  if (values.refreshCampaignProgress !== false) {
    await refreshCampaignProgressForResultIds(db, [item.resultId]);
  }
  return true;
}

async function holdHistoricalReleasedArchiveQueueItem(
  db: DB,
  item: QueueItem,
): Promise<PublicationCandidateState | "claim_lost"> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // The optimistic state check performed by the queue worker is deliberately
    // outside a transaction. Re-prove the release while holding the result
    // before parking its queue receipt; otherwise a concurrent publication
    // could revive the result after the check and strand live work in the
    // dormant historical-audit state forever.
    const [lockedResult] = await tx
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, item.resultId))
      .limit(1)
      .for("update");
    if (!lockedResult) return "superseded";

    if (lockedResult.currentResultAttemptId != null) {
      // The result is live again while its row is locked. Re-evaluate the
      // exact archive/lineage state in this same transaction, rather than
      // continuing based on the stale historical observation.
      return publicationCandidateState(tx, item);
    }
    if (
      await hasExactLivePrecalcPublicationWinner(tx, {
        resultId: item.resultId,
        resultAttemptId: item.resultAttemptId,
        lockForPublication: true,
      })
    ) {
      return publicationCandidateState(tx, item);
    }

    const [queue] = await tx
      .select({ id: resultArchiveReductionQueue.id })
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
    if (!queue) return "claim_lost";

    const [held] = await tx
      .update(resultArchiveReductionQueue)
      .set({
        // Released evidence is outside the accepted-current publication
        // contract. It is ineligible queue history, not audit work.
        state: "superseded",
        claimToken: null,
        claimExpiresAt: null,
        lastError:
          "released archive evidence is ineligible for reduction; discard the unpublished generation and rerun if needed",
        nextAttemptAt: new Date(),
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
    return held ? "superseded" : "claim_lost";
  });
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
): Promise<
  | { state: "attached"; runId: string }
  | { state: "historical_released" }
  | { state: "superseded" }
  | { state: "claim_lost" }
> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // Match the staging/selection and admission lock order. Creating the
    // child receipt ultimately writes an item with a result FK, so taking the
    // queue first would deadlock a concurrent stage that correctly holds the
    // result row before it renews/fences this queue claim.
    const [lockedResult] = await tx
      .select({
        id: results.id,
        currentResultAttemptId: results.currentResultAttemptId,
      })
      .from(results)
      .where(eq(results.id, item.resultId))
      .limit(1)
      .for("update");
    const exactLivePrecalcOwner =
      lockedResult?.currentResultAttemptId == null &&
      lockedResult != null &&
      (await hasExactLivePrecalcPublicationWinner(tx, {
        resultId: item.resultId,
        resultAttemptId: item.resultAttemptId,
        lockForPublication: true,
      }));
    if (
      !lockedResult ||
      (!lockedResult.currentResultAttemptId && !exactLivePrecalcOwner)
    ) {
      // This guard is deliberately inside the child-run transaction. The
      // earlier optimistic status read may be stale; without this proof a
      // release between the precheck and child creation could reduce
      // historical evidence and create a physical recovery action.
      return { state: "historical_released" };
    }
    // A non-null pointer only proves some generation is live. Re-evaluate the
    // exact result/attempt/archive relationship under the result-row lock
    // before attaching a durable child. Otherwise A can pass the optimistic
    // read, B can become current, and the stale A worker can manufacture a
    // child receipt before its later pre-I/O guard notices the supersession.
    const lockedPublicationState = await publicationCandidateState(tx, item);
    if (lockedPublicationState === "historical_released") {
      return { state: "historical_released" };
    }
    if (lockedPublicationState !== "publishable") {
      return { state: "superseded" };
    }
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
    if (!queue) return { state: "claim_lost" };
    // Do not let an expired claimant attach or reuse a durable child run.
    // This renewal is inside the queue-row transaction, so a successor cannot
    // claim the parent between the expiry proof and child-run ownership.
    if (!(await renewQueueClaimLease(tx, item))) {
      return { state: "claim_lost" };
    }
    if (queue.backfillRunId) {
      return { state: "attached", runId: queue.backfillRunId };
    }

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
    return { state: "attached", runId: created.runId };
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
 * Selection is not merely a presentation change for preliminary URANS: it is
 * the moment the exact archive-derived result becomes eligible to close the
 * physical PRECALC recovery owner.  Keep the reducer replay path on the same
 * reconciliation sequence as a newly reduced receipt, otherwise a process
 * crash between selection and settlement can leave stale blocked obligations
 * and their incidents visible to the admission breaker.
 */
async function reconcileAcceptedArchiveSelection(
  db: DB,
  item: QueueItem,
): Promise<void> {
  const [scope] = await db
    .select({
      airfoilId: results.airfoilId,
      revisionId: results.simulationPresetRevisionId,
    })
    .from(results)
    .where(eq(results.id, item.resultId))
    .limit(1);
  if (scope?.revisionId) {
    await refreshPolarCacheForRevision(db, scope.airfoilId, scope.revisionId);
  }
  await satisfyPrecalcObligationFromAcceptedResult(db, item.resultId);
  await refreshCampaignProgressForResultIds(db, [item.resultId]);
}

type PublicationCandidateState =
  | "publishable"
  | "historical_released"
  | "superseded";

type PublicationCandidate = Pick<
  QueueItem,
  "resultId" | "resultAttemptId" | "sourceArchiveId"
>;

/**
 * A queue row refers to one immutable archive, so it must stop before reducer
 * I/O when a newer generation has superseded that source.  The one allowed
 * non-current case is deliberate: an exact source-pinned RANS handoff stays
 * public while its URANS successor is reduced. A cleared projection is
 * historical by default, except for an active exact PRECALC owner whose own
 * latest archived child has not yet been published. The selector performs the
 * same exact-owner proof and CAS again immediately before promotion.
 */
async function publicationCandidateState(
  db: DB,
  item: PublicationCandidate,
): Promise<PublicationCandidateState> {
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
  if (!source || !target || !current) return "superseded";
  if (!current.currentAttemptId) {
    const hasExactLivePrecalcOwner =
      typeof target.fidelity === "string" &&
      parsePointFidelity(target.fidelity) === "urans_precalc" &&
      (await hasExactLivePrecalcPublicationWinner(db, {
        resultId: item.resultId,
        resultAttemptId: item.resultAttemptId,
      }));
    return mayRunArchiveReduction({
      sourceArchiveCurrent: true,
      targetAttemptCurrent: false,
      hasExactPrecalcRansLineage: false,
      hasExactLegacyRecoveryLineage: false,
      hasExactLivePrecalcPublicationOwner: hasExactLivePrecalcOwner,
    })
      ? "publishable"
      : "historical_released";
  }
  if (current.currentAttemptId === item.resultAttemptId) {
    return mayRunArchiveReduction({
      sourceArchiveCurrent: true,
      targetAttemptCurrent: true,
      hasExactPrecalcRansLineage: false,
      hasExactLegacyRecoveryLineage: false,
    })
      ? "publishable"
      : "superseded";
  }

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
  const hasExactLegacyRecoveryLineage =
    typeof target.fidelity === "string" &&
    parsePointFidelity(target.fidelity) === "urans_precalc" &&
    (await hasExactLegacyUransArchiveGapRecoveryLineage({
      db,
      resultId: item.resultId,
      currentLegacyAttemptId: current.currentAttemptId,
      targetUransAttemptId: item.resultAttemptId,
    }));
  return mayRunArchiveReduction({
    sourceArchiveCurrent: true,
    targetAttemptCurrent: false,
    hasExactPrecalcRansLineage,
    hasExactLegacyRecoveryLineage,
  })
    ? "publishable"
    : "superseded";
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
    // A prior process can crash after immutable selection but before the
    // mutable PRECALC owner/progress ledgers settle. Replaying this queue
    // receipt must use the same post-selection reconciliation as a fresh
    // reduction, otherwise one stale blocked owner can unnecessarily fence
    // healthy solver admission.
    await reconcileAcceptedArchiveSelection(db, item);
    await settleQueueItem(db, item, {
      state: "reduced",
      resultInterpretationId: selected.interpretationId,
    });
    return;
  }
  let initialPublicationState: PublicationCandidateState | "claim_lost" =
    await publicationCandidateState(db, item);
  if (initialPublicationState === "historical_released") {
    initialPublicationState = await holdHistoricalReleasedArchiveQueueItem(
      db,
      item,
    );
    if (
      initialPublicationState === "historical_released" ||
      initialPublicationState === "claim_lost"
    ) {
      return;
    }
  }
  if (initialPublicationState !== "publishable") {
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
  const ensuredRun = item.backfillRunId
    ? { state: "attached" as const, runId: item.backfillRunId }
    : await ensureBackfillRunForQueueClaim(db, item);
  if (ensuredRun.state === "historical_released") {
    const reconciled = await holdHistoricalReleasedArchiveQueueItem(db, item);
    if (reconciled === "historical_released" || reconciled === "claim_lost") {
      return;
    }
    if (reconciled === "superseded") {
      await settleQueueItem(db, item, {
        state: "superseded",
        lastError:
          "archive source or URANS generation was superseded while its released-evidence state was reconciled",
      });
      return;
    }
    // The result became live again while its row was locked. No child receipt
    // was attached, so leave this durable queue row immediately runnable for
    // a fresh exact-source admission rather than stranding it as historical
    // or proceeding from a stale release observation.
    await settleQueueItem(db, item, {
      state: "pending",
      nextAttemptAt: new Date(),
      lastError:
        "result became live while historical released-evidence state was reconciled; retrying exact archive admission",
    });
    return;
  }
  if (ensuredRun.state === "claim_lost") {
    // The claim was lost before the child could be attached. The next owner
    // will resume this queue row; do not fabricate an unowned child run.
    return;
  }
  if (ensuredRun.state === "superseded") {
    // No child was attached under the lock, so this is a pure stale-receipt
    // settlement. A different live generation owns subsequent publication.
    await settleQueueItem(db, item, {
      state: "superseded",
      lastError:
        "archive source or URANS generation was superseded before a child receipt could be attached",
    });
    return;
  }
  const runId = ensuredRun.runId;
  // A previously attached child can survive a process crash. Reprove the
  // released/live boundary immediately before it receives any reducer I/O;
  // the stage and recovery-action write boundaries repeat it under lock.
  let beforeReductionPublicationState:
    | PublicationCandidateState
    | "claim_lost" = await publicationCandidateState(db, item);
  if (beforeReductionPublicationState === "historical_released") {
    beforeReductionPublicationState =
      await holdHistoricalReleasedArchiveQueueItem(db, item);
    if (
      beforeReductionPublicationState === "historical_released" ||
      beforeReductionPublicationState === "claim_lost"
    ) {
      return;
    }
  }
  if (beforeReductionPublicationState !== "publishable") {
    await settleQueueItem(db, item, {
      state: "superseded",
      backfillRunId: runId,
      lastError:
        "archive source or URANS generation was superseded before archive reduction began",
    });
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
  let afterReductionPublicationState: PublicationCandidateState | "claim_lost" =
    await publicationCandidateState(db, item);
  if (afterReductionPublicationState === "historical_released") {
    afterReductionPublicationState =
      await holdHistoricalReleasedArchiveQueueItem(db, item);
    if (
      afterReductionPublicationState === "historical_released" ||
      afterReductionPublicationState === "claim_lost"
    ) {
      return;
    }
  }
  if (afterReductionPublicationState !== "publishable") {
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
    if (selectedAfter) {
      await reconcileAcceptedArchiveSelection(db, item);
    }
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
    // The child has committed a terminal reduction receipt. Selection can be
    // visible through the immutable result projection even if this worker's
    // immediately preceding `alreadySelected` probe observed the narrow
    // commit boundary. Reconcile here unconditionally: it is idempotent when
    // selection is not yet publishable, and closes the exact owner as soon as
    // it is. A stale blocked owner must never survive a successful archive
    // publication merely because a process crossed that boundary once.
    await reconcileAcceptedArchiveSelection(db, item);
    const selectedAfter = await alreadySelected(db, item);
    if (selectedAfter) {
      await settleQueueItem(db, item, {
        state,
        backfillRunId: runId,
        resultInterpretationId: selectedAfter.interpretationId,
      });
      return;
    }
    let beforeReplayPublicationState: PublicationCandidateState | "claim_lost" =
      await publicationCandidateState(db, item);
    if (beforeReplayPublicationState === "historical_released") {
      beforeReplayPublicationState =
        await holdHistoricalReleasedArchiveQueueItem(db, item);
      if (
        beforeReplayPublicationState === "historical_released" ||
        beforeReplayPublicationState === "claim_lost"
      ) {
        return;
      }
    }
    if (beforeReplayPublicationState !== "publishable") {
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
      await reconcileAcceptedArchiveSelection(db, item);
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
  // Archive reduction can create a backfill receipt, hydrate evidence and
  // select a canonical interpretation. The watcher-owned maintenance receipt
  // is the exclusive writer during its exact drain, so stop before a probe,
  // discovery, claim, GCS read or publication mutation.
  if (await ordinaryWriterBlockedByMaintenanceDrain(db)) {
    return {
      scanned: 0,
      enqueued: 0,
      admittedResultAttemptIds: [],
      processed: 0,
      archiveReductionVersion: opts.archiveReductionVersion ?? null,
      deferredByCapability: false,
    };
  }
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
  // Reconcile only the pre-fix, first-attempt native-fetch terminal shape.
  // This detaches a mutable queue parent from its preserved failed child; the
  // following ordinary claim creates a fresh bounded child under all normal
  // source/publication guards.
  await rearmLegacyNativeFetchArchiveReductionReceipts(db, {
    resultIds: opts.resultIds,
    resultAttemptIds: opts.resultAttemptIds,
  });
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
