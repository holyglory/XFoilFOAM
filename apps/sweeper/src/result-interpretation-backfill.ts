/**
 * Durable clean-cycle interpretation backfill.
 *
 * This worker is intentionally a read/reduce/append workflow:
 *
 *   exact GCS archive -> authenticated engine-side raw reduction
 *     -> immutable result_interpretations row -> append-only selection event
 *     -> mutable work receipt
 *
 * It never rewrites a raw result attempt or uses a browser/downsampled
 * `force_history` payload as input.  An accepted periodic archive reduction
 * may only move the result's interpretation pointer through an append-only
 * selection event after it proves that its exact attempt and archive are still
 * current. Re-running a solver produces a new immutable archive id; changing
 * the reducer policy produces a new reducer version. Those are the only ways
 * to obtain a new scientific interpretation for the same result attempt.
 */
import {
  type DB,
  type SolverEvidenceBlob,
  probeCampaignCompletion,
  recomputeProgressForCampaign,
  refreshPolarCacheForRevision,
  satisfyPrecalcObligationFromAcceptedResult,
  resultAttempts,
  resultCanonicalSelections,
  resultInterpretationBackfillItems,
  resultInterpretationBackfillRuns,
  resultInterpretationRecoveryActions,
  resultInterpretations,
  results,
  solverEvidenceArchives,
  solverEvidenceBlobs,
} from "@aerodb/db";
import {
  EngineError,
  EngineTimeoutError,
  parseArchiveCleanCycleRecoveryProgress,
  parsePointFidelity,
  type ArchiveCleanCycleRecoveryProgress,
  type ArchiveCleanCycleReductionResponse,
  type EngineClient,
  type PointFidelity,
  type RemoteEvidencePointerPayload,
} from "@aerodb/engine-client";
import { and, asc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import {
  ensureResultInterpretationReducerVersion,
  selectAcceptedArchiveInterpretation,
  stageArchiveResultInterpretation,
} from "./result-interpretations";
import { createSingleFlightBackgroundRunner } from "./single-flight";

const SHA256 = /^[0-9a-f]{64}$/;
const GCS_GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC32C = /^[A-Za-z0-9+/]{6}==$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The reducer performs a fresh, complete generation-pinned archive scan. */
export const ARCHIVE_INTERPRETATION_LEASE_MS = 30 * 60_000;
export const ARCHIVE_INTERPRETATION_MAX_ATTEMPTS = 3;
export const DEFAULT_ARCHIVE_INTERPRETATION_BACKFILL_LIMIT = 1_000;

export type ArchiveInterpretationBackfillScope = {
  resultIds?: string[];
  resultAttemptIds?: string[];
  /** Number of immutable URANS attempts to enqueue in a single run. */
  limit?: number;
};

export type ArchiveInterpretationBackfillCandidate = {
  resultId: string;
  resultAttemptId: string;
  fidelity: "urans_precalc" | "urans_full";
  sourceArchiveId: string | null;
  archivePointer: RemoteEvidencePointerPayload | null;
  unavailableReason: string | null;
};

export type ArchiveInterpretationBackfillDiscovery = {
  candidates: ArchiveInterpretationBackfillCandidate[];
  scanned: number;
  skippedExistingInterpretations: number;
  /** Exact attempt/reducer pairs deliberately retired by an operator. */
  skippedAbandonedReceipts: number;
  scope: Required<ArchiveInterpretationBackfillScope>;
};

export type ArchiveInterpretationBackfillRun = {
  runId: string;
  reducerVersionId: string;
  enqueued: number;
  skippedExistingInterpretations: number;
  skippedAbandonedReceipts: number;
  state: "running" | "completed";
};

export function archiveInterpretationCandidateDisposition(
  candidate: Pick<
    ArchiveInterpretationBackfillCandidate,
    "sourceArchiveId" | "resultAttemptId"
  >,
  interpretedArchiveIds: ReadonlySet<string>,
  abandonedAttemptIds: ReadonlySet<string>,
): "pending" | "interpreted" | "abandoned" {
  if (
    candidate.sourceArchiveId &&
    interpretedArchiveIds.has(candidate.sourceArchiveId)
  ) {
    return "interpreted";
  }
  if (abandonedAttemptIds.has(candidate.resultAttemptId)) return "abandoned";
  return "pending";
}

export type ArchiveInterpretationBackfillReport = {
  runId: string;
  state: "running" | "completed" | "failed" | "cancelled";
  processed: number;
  counts: Record<string, number>;
  /** Append-only archive-derived selection events recorded by this run. */
  canonicalSelectionsCreated: number;
  /** Current result pointers now owned by a selection from this run. */
  resultProjectionsUpdated: number;
};

export type DisposableArchiveFreshRerunReport = {
  runId: string;
  campaignId: string;
  obligationsReopened: number;
  attemptReceiptsAbandoned: number;
};

/**
 * A deliberately non-executing, durable handoff for work discovered while
 * reducing historical evidence.  The archive worker must never submit CFD
 * itself: it has no authority to turn an older attempt into a new physical
 * generation.  Instead it leaves this exact, machine-readable instruction on
 * the immutable-scope work receipt for the URANS-ladder recovery consumer.
 *
 * `rerun_required` does not mean "start a fresh solve now".  The consumer
 * must first prove whether the exact archive/case can restart; it may create a
 * fresh generation only when that proof is absent.  This keeps a recoverable
 * case on the same-case path and makes the fresh-rerun exception auditable.
 */
export type ArchiveBackfillRecoveryHandoff = {
  contract: "archive-clean-cycle-recovery-handoff-v1";
  action: "continue_exact_case" | "verify_restart_proof_then_rerun";
  scheduled: false;
  reducerState: "continuation_required" | "rerun_required";
  fidelity: "urans_precalc" | "urans_full";
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
  inputEvidenceSignature: string;
  /** Immutable reducer recommendation for an exact saved-case continuation.
   * NULL means the archive had no recoverable cadence and must first prove a
   * restart or fall back to the separately-budgeted fresh path. */
  correctiveTailPeriods: number | null;
};

type ArchiveBlobIdentity = Pick<
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
  | "metadata"
  | "verifiedAt"
>;

type BackfillItemState =
  | "pending"
  | "hydrating"
  | "reduced"
  | "missing_evidence"
  | "continuation_required"
  | "rerun_required"
  | "terminal_failure"
  | "failed"
  | "abandoned";

type ClaimedBackfillItem = {
  id: string;
  runId: string;
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string | null;
  attemptCount: number;
  claimToken: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    ? value
    : null;
}

function positiveSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function normaliseIds(values: string[] | undefined, label: string): string[] {
  const unique = [...new Set(values ?? [])].sort();
  for (const value of unique) {
    if (!UUID.test(value)) throw new Error(`${label} must contain UUID values`);
  }
  return unique;
}

export function normaliseArchiveInterpretationBackfillScope(
  scope: ArchiveInterpretationBackfillScope = {},
): Required<ArchiveInterpretationBackfillScope> {
  const limit = scope.limit ?? DEFAULT_ARCHIVE_INTERPRETATION_BACKFILL_LIMIT;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 100_000) {
    throw new Error(
      "backfill limit must be a positive integer no greater than 100000",
    );
  }
  return {
    resultIds: normaliseIds(scope.resultIds, "resultIds"),
    resultAttemptIds: normaliseIds(scope.resultAttemptIds, "resultAttemptIds"),
    limit,
  };
}

/** Only explicit URANS provenance is eligible.  A legacy/unknown attempt is
 * not silently guessed to be FAST or FINAL merely because `unsteady` is true. */
export function archiveBackfillFidelity(
  evidencePayload: unknown,
): "urans_precalc" | "urans_full" | null {
  if (!isRecord(evidencePayload)) return null;
  const fidelity = parsePointFidelity(evidencePayload.fidelity);
  return fidelity === "urans_precalc" || fidelity === "urans_full"
    ? fidelity
    : null;
}

/** Attempt payload is descriptive evidence, not authority to relabel the
 * immutable result row. Both identities must name the same URANS fidelity. */
export function exactArchiveBackfillFidelity(
  evidencePayload: unknown,
  resultFidelity: unknown,
): "urans_precalc" | "urans_full" | null {
  const attemptFidelity = archiveBackfillFidelity(evidencePayload);
  const storedFidelity = parsePointFidelity(resultFidelity);
  return attemptFidelity && storedFidelity === attemptFidelity
    ? attemptFidelity
    : null;
}

/**
 * Construct the only pointer the reducer is allowed to read.  This mirrors
 * the render-pointer validation but stays local to the backfill so no caller
 * can accidentally hand it an engine result payload or a volume archive.
 */
export function archivePointerForBackfill(blob: ArchiveBlobIdentity | null): {
  pointer: RemoteEvidencePointerPayload | null;
  reason: string | null;
} {
  if (!blob) {
    return {
      pointer: null,
      reason: "no immutable evidence archive is registered",
    };
  }
  if (blob.backend !== "gcs") {
    return {
      pointer: null,
      reason: "current archive is not generation-pinned GCS evidence",
    };
  }
  if (blob.compression !== "zstd" || blob.mimeType !== "application/zstd") {
    return {
      pointer: null,
      reason: "current GCS archive is not a Zstandard evidence bundle",
    };
  }
  const metadata = isRecord(blob.metadata) ? blob.metadata : {};
  if (metadata.archiveFormat != null && metadata.archiveFormat !== "tar+zstd") {
    return {
      pointer: null,
      reason: "archive metadata has an unsupported format",
    };
  }
  const zstdLevel = positiveSafeInteger(metadata.zstdLevel);
  const bucket = exactText(blob.bucket);
  const objectKey = exactText(blob.objectKey);
  const generation = exactText(blob.generation);
  const storedSize = positiveSafeInteger(blob.byteSize);
  const tarSize = positiveSafeInteger(blob.uncompressedTarByteSize);
  if (!zstdLevel || zstdLevel > 22) {
    return {
      pointer: null,
      reason: "archive metadata has an invalid Zstandard level",
    };
  }
  if (
    !bucket ||
    !objectKey ||
    objectKey.startsWith("/") ||
    objectKey.includes("\\")
  ) {
    return {
      pointer: null,
      reason: "archive GCS bucket or object key is invalid",
    };
  }
  if (!generation || !GCS_GENERATION.test(generation)) {
    return {
      pointer: null,
      reason: "archive GCS generation is missing or malformed",
    };
  }
  if (!SHA256.test(blob.sha256) || !SHA256.test(blob.uncompressedTarSha256)) {
    return { pointer: null, reason: "archive digest is missing or malformed" };
  }
  if (!CRC32C.test(blob.crc32c) || !storedSize || !tarSize) {
    return {
      pointer: null,
      reason: "archive size or CRC32C is missing or malformed",
    };
  }
  const verifiedAt = blob.verifiedAt instanceof Date ? blob.verifiedAt : null;
  if (!verifiedAt || !Number.isFinite(verifiedAt.getTime())) {
    return {
      pointer: null,
      reason: "archive verification timestamp is invalid",
    };
  }
  return {
    pointer: {
      schemaVersion: 1,
      format: "tar+zstd",
      bucket,
      objectKey,
      generation,
      storedSha256: blob.sha256,
      storedSize,
      tarSha256: blob.uncompressedTarSha256,
      tarSize,
      crc32c: blob.crc32c,
      zstdLevel,
      // This is the evidence-verification timestamp used by the existing
      // render path; it is not a mutable request timestamp.
      createdAt: verifiedAt.toISOString(),
    },
    reason: null,
  };
}

/** Discover explicit URANS attempts.  We retain no-archive candidates so the
 * ledger can honestly report `missing_evidence` rather than quietly omitting
 * them from the migration. */
export async function discoverArchiveInterpretationBackfill(
  db: DB,
  opts: {
    /** Null in a read-only plan before this reducer has ever been registered. */
    reducerVersionId: string | null;
    scope?: ArchiveInterpretationBackfillScope;
  },
): Promise<ArchiveInterpretationBackfillDiscovery> {
  const scope = normaliseArchiveInterpretationBackfillScope(opts.scope);
  const rows = await db
    .select({
      resultId: results.id,
      resultFidelity: results.fidelity,
      resultAttemptId: resultAttempts.id,
      evidencePayload: resultAttempts.evidencePayload,
      sourceArchiveId: solverEvidenceArchives.id,
      archiveResultId: solverEvidenceArchives.resultId,
      archiveAttemptId: solverEvidenceArchives.resultAttemptId,
      blob: solverEvidenceBlobs,
    })
    .from(resultAttempts)
    .innerJoin(results, eq(results.id, resultAttempts.resultId))
    .leftJoin(
      solverEvidenceArchives,
      and(
        eq(solverEvidenceArchives.resultId, results.id),
        eq(solverEvidenceArchives.resultAttemptId, resultAttempts.id),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .leftJoin(
      solverEvidenceBlobs,
      eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
    )
    .where(
      and(
        sql`${resultAttempts.resultId} IS NOT NULL`,
        sql`${resultAttempts.evidencePayload} ->> 'fidelity' IN ('urans_precalc', 'urans_full')`,
        inArray(results.fidelity, ["urans_precalc", "urans_full"]),
        sql`${results.fidelity} = ${resultAttempts.evidencePayload} ->> 'fidelity'`,
        scope.resultIds.length
          ? inArray(results.id, scope.resultIds)
          : undefined,
        scope.resultAttemptIds.length
          ? inArray(resultAttempts.id, scope.resultAttemptIds)
          : undefined,
      ),
    )
    .orderBy(asc(resultAttempts.createdAt), asc(resultAttempts.id))
    .limit(scope.limit);

  const candidates = rows.flatMap((row) => {
    const fidelity = exactArchiveBackfillFidelity(
      row.evidencePayload,
      row.resultFidelity,
    );
    // The SQL predicate is deliberately duplicated with a strict parser: the
    // parser is the actual provenance contract, and protects us from a future
    // JSON coercion or a malformed historical payload.
    if (!fidelity || !row.resultAttemptId) return [];
    const pointer = archivePointerForBackfill(row.blob);
    return [
      {
        resultId: row.resultId,
        resultAttemptId: row.resultAttemptId,
        fidelity,
        sourceArchiveId: row.sourceArchiveId,
        archivePointer: pointer.pointer,
        unavailableReason: pointer.reason,
      } satisfies ArchiveInterpretationBackfillCandidate,
    ];
  });

  const sourceArchiveIds = candidates
    .map((candidate) => candidate.sourceArchiveId)
    .filter((value): value is string => value != null);
  const interpretedArchiveIds = new Set<string>();
  if (sourceArchiveIds.length && opts.reducerVersionId) {
    const existing = await db
      .select({ sourceArchiveId: resultInterpretations.sourceArchiveId })
      .from(resultInterpretations)
      .where(
        and(
          eq(resultInterpretations.reducerVersionId, opts.reducerVersionId),
          inArray(resultInterpretations.sourceArchiveId, sourceArchiveIds),
        ),
      );
    for (const row of existing) {
      if (row.sourceArchiveId) interpretedArchiveIds.add(row.sourceArchiveId);
    }
  }
  const abandonedAttemptIds = new Set<string>();
  const candidateAttemptIds = candidates.map(
    (candidate) => candidate.resultAttemptId,
  );
  if (candidateAttemptIds.length && opts.reducerVersionId) {
    const abandoned = await db
      .select({
        resultAttemptId: resultInterpretationBackfillItems.resultAttemptId,
      })
      .from(resultInterpretationBackfillItems)
      .innerJoin(
        resultInterpretationBackfillRuns,
        eq(
          resultInterpretationBackfillRuns.id,
          resultInterpretationBackfillItems.runId,
        ),
      )
      .where(
        and(
          eq(
            resultInterpretationBackfillRuns.reducerVersionId,
            opts.reducerVersionId,
          ),
          eq(resultInterpretationBackfillItems.state, "abandoned"),
          inArray(
            resultInterpretationBackfillItems.resultAttemptId,
            candidateAttemptIds,
          ),
        ),
      );
    for (const row of abandoned) {
      abandonedAttemptIds.add(row.resultAttemptId);
    }
  }
  const dispositions = candidates.map((candidate) =>
    archiveInterpretationCandidateDisposition(
      candidate,
      interpretedArchiveIds,
      abandonedAttemptIds,
    ),
  );
  const pending = candidates.filter(
    (_candidate, index) => dispositions[index] === "pending",
  );
  return {
    candidates: pending,
    scanned: candidates.length,
    skippedExistingInterpretations: dispositions.filter(
      (disposition) => disposition === "interpreted",
    ).length,
    skippedAbandonedReceipts: dispositions.filter(
      (disposition) => disposition === "abandoned",
    ).length,
    scope,
  };
}

/** Create a durable run and immutable-attempt receipts.  No CFD request is
 * launched here; items with no raw archive are still retained as an honest
 * missing-evidence outcome. */
export async function createArchiveInterpretationBackfillRun(opts: {
  db: DB;
  scope?: ArchiveInterpretationBackfillScope;
  requestedBy?: string;
}): Promise<ArchiveInterpretationBackfillRun> {
  const reducerVersionId = await ensureResultInterpretationReducerVersion(
    opts.db,
  );
  const discovery = await discoverArchiveInterpretationBackfill(opts.db, {
    reducerVersionId,
    scope: opts.scope,
  });
  const now = new Date();
  const initialState = discovery.candidates.length ? "running" : "completed";
  const [run] = await opts.db
    .insert(resultInterpretationBackfillRuns)
    .values({
      reducerVersionId,
      state: initialState,
      scope: {
        contract: "archive-clean-cycle-backfill-v1",
        ...discovery.scope,
        rawEvidenceImmutable: true,
        canonicalSelection: "accepted-current-archive-only",
      },
      summary: {
        discovered: discovery.scanned,
        enqueued: discovery.candidates.length,
        skippedExistingInterpretations:
          discovery.skippedExistingInterpretations,
        skippedAbandonedReceipts: discovery.skippedAbandonedReceipts,
        canonicalSelectionsCreated: 0,
        resultProjectionsUpdated: 0,
      },
      requestedBy: opts.requestedBy?.trim() || "system",
      startedAt: now,
      completedAt: initialState === "completed" ? now : null,
    })
    .returning({ id: resultInterpretationBackfillRuns.id });
  if (!run)
    throw new Error("archive interpretation backfill run was not persisted");
  if (discovery.candidates.length) {
    await opts.db
      .insert(resultInterpretationBackfillItems)
      .values(
        discovery.candidates.map((candidate) => ({
          runId: run.id,
          resultId: candidate.resultId,
          resultAttemptId: candidate.resultAttemptId,
          sourceArchiveId: candidate.sourceArchiveId,
          state: "pending",
          nextAttemptAt: now,
        })),
      )
      .onConflictDoNothing();
  }
  return {
    runId: run.id,
    reducerVersionId,
    enqueued: discovery.candidates.length,
    skippedExistingInterpretations: discovery.skippedExistingInterpretations,
    skippedAbandonedReceipts: discovery.skippedAbandonedReceipts,
    state: initialState,
  };
}

async function claimNextArchiveInterpretationItem(
  db: DB,
  runId: string,
): Promise<ClaimedBackfillItem | null> {
  const now = new Date();
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // Serialize claims with operator cancellation. Once cancellation owns this
    // row, no already-running worker loop may claim another archive receipt.
    const [run] = await tx
      .select({ state: resultInterpretationBackfillRuns.state })
      .from(resultInterpretationBackfillRuns)
      .where(eq(resultInterpretationBackfillRuns.id, runId))
      .limit(1)
      .for("update");
    if (run?.state !== "running") return null;
    const [item] = await tx
      .select({
        id: resultInterpretationBackfillItems.id,
        runId: resultInterpretationBackfillItems.runId,
        resultId: resultInterpretationBackfillItems.resultId,
        resultAttemptId: resultInterpretationBackfillItems.resultAttemptId,
        sourceArchiveId: resultInterpretationBackfillItems.sourceArchiveId,
        attemptCount: resultInterpretationBackfillItems.attemptCount,
      })
      .from(resultInterpretationBackfillItems)
      .where(
        and(
          eq(resultInterpretationBackfillItems.runId, runId),
          or(
            and(
              eq(resultInterpretationBackfillItems.state, "pending"),
              lte(resultInterpretationBackfillItems.nextAttemptAt, now),
            ),
            and(
              eq(resultInterpretationBackfillItems.state, "hydrating"),
              lte(resultInterpretationBackfillItems.claimExpiresAt, now),
            ),
          ),
        ),
      )
      .orderBy(
        asc(resultInterpretationBackfillItems.nextAttemptAt),
        asc(resultInterpretationBackfillItems.createdAt),
      )
      .limit(1)
      .for("update");
    if (!item) return null;
    const claimToken = randomUUID();
    const [claimed] = await tx
      .update(resultInterpretationBackfillItems)
      .set({
        state: "hydrating",
        attemptCount: item.attemptCount + 1,
        claimToken,
        claimExpiresAt: new Date(
          now.getTime() + ARCHIVE_INTERPRETATION_LEASE_MS,
        ),
        nextAttemptAt: now,
      })
      .where(eq(resultInterpretationBackfillItems.id, item.id))
      .returning({ id: resultInterpretationBackfillItems.id });
    if (!claimed) return null;
    return { ...item, claimToken, attemptCount: item.attemptCount + 1 };
  });
}

async function archivePointerForClaim(
  db: DB,
  item: ClaimedBackfillItem,
): Promise<{
  fidelity: "urans_precalc" | "urans_full" | null;
  pointer: RemoteEvidencePointerPayload | null;
  reason: string | null;
}> {
  const [attempt] = await db
    .select({ evidencePayload: resultAttempts.evidencePayload })
    .from(resultAttempts)
    .where(
      and(
        eq(resultAttempts.id, item.resultAttemptId),
        eq(resultAttempts.resultId, item.resultId),
      ),
    )
    .limit(1);
  const fidelity = archiveBackfillFidelity(attempt?.evidencePayload);
  if (!fidelity) {
    return {
      fidelity: null,
      pointer: null,
      reason: "attempt no longer has explicit URANS fidelity provenance",
    };
  }
  if (!item.sourceArchiveId) {
    return {
      fidelity,
      pointer: null,
      reason: "attempt has no immutable raw evidence archive",
    };
  }
  const [archive] = await db
    .select({
      resultId: solverEvidenceArchives.resultId,
      resultAttemptId: solverEvidenceArchives.resultAttemptId,
      blob: solverEvidenceBlobs,
    })
    .from(solverEvidenceArchives)
    .innerJoin(
      solverEvidenceBlobs,
      eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
    )
    .where(
      and(
        eq(solverEvidenceArchives.id, item.sourceArchiveId),
        eq(solverEvidenceArchives.resultId, item.resultId),
        eq(solverEvidenceArchives.resultAttemptId, item.resultAttemptId),
      ),
    )
    .limit(1);
  if (!archive) {
    return {
      fidelity,
      pointer: null,
      reason: "the planned immutable archive is no longer available",
    };
  }
  const pointer = archivePointerForBackfill(archive.blob);
  return { fidelity, pointer: pointer.pointer, reason: pointer.reason };
}

function limitedError(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value);
  return (
    text.trim().slice(0, 2_000) ||
    "archive interpretation failed without an error message"
  );
}

function backoffForAttempt(attemptCount: number): number {
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, attemptCount - 1));
}

/** Node's fetch reports connection resets, DNS failures, and other failures
 * that occur before an HTTP response as a deliberately terse TypeError. Keep
 * this exact transport shape retryable without broadening all TypeErrors
 * (invalid URLs and reducer programming defects must remain terminal). */
export function isArchiveInterpretationTransientError(error: unknown): boolean {
  if (error instanceof EngineTimeoutError) return true;
  if (error instanceof TypeError && error.message.trim() === "fetch failed") {
    return true;
  }
  return (
    error instanceof EngineError &&
    error.code !== "archive_reduction_contract_drift" &&
    error.status !== 409 &&
    error.status !== 422 &&
    (error.status == null || error.status >= 500)
  );
}

async function settleClaim(
  db: DB,
  item: ClaimedBackfillItem,
  values: {
    state: Exclude<BackfillItemState, "hydrating">;
    lastError?: string | null;
    resultInterpretationId?: string | null;
    nextAttemptAt?: Date;
    /**
     * A machine-readable handoff is persisted in the separate mutable
     * scheduler ledger atomically with this receipt.  It is deliberately not
     * encoded in `lastError`: text is diagnostic; the action row is the only
     * executable source of recovery intent.
     */
    recoveryHandoff?: ArchiveBackfillRecoveryHandoff | null;
  },
): Promise<boolean> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [settled] = await tx
      .update(resultInterpretationBackfillItems)
      .set({
        state: values.state,
        claimToken: null,
        claimExpiresAt: null,
        lastError: values.lastError ?? null,
        resultInterpretationId: values.resultInterpretationId ?? null,
        nextAttemptAt: values.nextAttemptAt ?? new Date(),
      })
      .where(
        and(
          eq(resultInterpretationBackfillItems.id, item.id),
          eq(resultInterpretationBackfillItems.state, "hydrating"),
          eq(resultInterpretationBackfillItems.claimToken, item.claimToken),
        ),
      )
      .returning({ id: resultInterpretationBackfillItems.id });
    if (!settled) return false;

    if (values.recoveryHandoff) {
      const handoff = values.recoveryHandoff;
      // The recovery identity is the immutable physical generation plus
      // source archive and fidelity. A later backfill pass must never reset a
      // claimed/routed action or create another CFD generation. The one safe
      // legacy upgrade is a still-pending, target-less action that predates
      // corrective_tail_periods: it can adopt the authenticated reducer's
      // bounded instruction before any scheduler ownership exists.
      await tx.execute(sql`
        INSERT INTO result_interpretation_recovery_actions (
          result_id,
          result_attempt_id,
          source_archive_id,
          input_evidence_signature,
          fidelity,
          requested_action,
          corrective_tail_periods,
          state,
          decision_reason
        ) VALUES (
          ${handoff.resultId},
          ${handoff.resultAttemptId},
          ${handoff.sourceArchiveId},
          ${handoff.inputEvidenceSignature},
          ${handoff.fidelity},
          ${handoff.action},
          ${handoff.correctiveTailPeriods},
          'pending',
          ${`archive reducer ${handoff.reducerState}`}
        )
        ON CONFLICT (result_attempt_id, source_archive_id, fidelity) DO UPDATE
        SET corrective_tail_periods = EXCLUDED.corrective_tail_periods,
            decision_reason = EXCLUDED.decision_reason,
            "updatedAt" = now()
        WHERE result_interpretation_recovery_actions.state = 'pending'
          AND result_interpretation_recovery_actions.corrective_tail_periods IS NULL
          AND result_interpretation_recovery_actions.target_urans_request_id IS NULL
          AND result_interpretation_recovery_actions.target_verify_queue_id IS NULL
          AND result_interpretation_recovery_actions.requested_action = EXCLUDED.requested_action
          AND EXCLUDED.corrective_tail_periods IS NOT NULL
      `);
    }
    return true;
  });
}

function reducerSummary(
  state: string,
  diagnostics: Record<string, unknown>,
): string {
  const reason =
    typeof diagnostics.reason === "string" ? diagnostics.reason : null;
  return reason
    ? `raw archive reducer: ${state}; ${reason}`.slice(0, 2_000)
    : `raw archive reducer: ${state}`;
}

function hasCycleCertificate(point: Record<string, unknown>): boolean {
  return point.urans_cycle_certificate != null;
}

/**
 * Build a stable action record rather than burying an operational instruction
 * in prose. The worker persists this in the dedicated recovery-action ledger
 * atomically when it settles its backfill receipt; the archive interpretation
 * remains a scientific statement only.
 */
export function archiveBackfillRecoveryHandoff(input: {
  state: "continuation_required" | "rerun_required";
  fidelity: "urans_precalc" | "urans_full";
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
  inputEvidenceSignature: string;
  recommendedAdditionalPeriods?: unknown;
}): ArchiveBackfillRecoveryHandoff {
  if (!UUID.test(input.resultId) || !UUID.test(input.resultAttemptId)) {
    throw new Error(
      "archive recovery handoff requires exact result and attempt UUIDs",
    );
  }
  if (!UUID.test(input.sourceArchiveId)) {
    throw new Error(
      "archive recovery handoff requires one exact source archive UUID",
    );
  }
  if (!SHA256.test(input.inputEvidenceSignature)) {
    throw new Error(
      "archive recovery handoff requires a SHA-256 evidence signature",
    );
  }
  const correctiveTailPeriods =
    input.state === "continuation_required"
      ? archiveRecommendedAdditionalPeriods(input.recommendedAdditionalPeriods)
      : null;
  return {
    contract: "archive-clean-cycle-recovery-handoff-v1",
    action:
      input.state === "continuation_required"
        ? "continue_exact_case"
        : "verify_restart_proof_then_rerun",
    scheduled: false,
    reducerState: input.state,
    fidelity: input.fidelity,
    resultId: input.resultId,
    resultAttemptId: input.resultAttemptId,
    sourceArchiveId: input.sourceArchiveId,
    inputEvidenceSignature: input.inputEvidenceSignature,
    correctiveTailPeriods,
  };
}

/**
 * The raw archive reducer, rather than a collapsed result warning, is the
 * authority for a damaged terminal tail.  Keep this narrow validation at the
 * scheduler boundary: missing, fractional, or out-of-range values are a
 * reducer contract drift, never an excuse to quietly use a smaller tail.
 */
export function archiveRecommendedAdditionalPeriods(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 3
  ) {
    throw new Error(
      "archive continuation requires recommendedAdditionalPeriods as an integer from 1 through 3",
    );
  }
  return value;
}

/**
 * Revalidate the reducer's additive v1 progress proof at the durable work
 * boundary. The engine client performs the same check, but the backfill also
 * owns this guard because tests, future transports, and recovery tools may
 * supply an EngineClient-shaped object without passing through that client.
 *
 * Historical archive responses omitted this object and retain their legacy
 * handling (`null` here). Once present, no state may schedule a continuation
 * unless its measured physical periods, tier cap, and bounded recommendation
 * are mutually consistent.
 */
export function archiveBackfillRecoveryProgress(input: {
  state: ArchiveCleanCycleReductionResponse["state"];
  fidelity: "urans_precalc" | "urans_full";
  diagnostics: Record<string, unknown>;
}): ArchiveCleanCycleRecoveryProgress | null {
  const parsed = parseArchiveCleanCycleRecoveryProgress(input.diagnostics, {
    state: input.state,
    fidelity: input.fidelity,
  });
  if (!parsed.ok) {
    throw new EngineError(
      `archive clean-cycle reducer recovery progress contract drift: ${parsed.errors.join("; ")}`,
      undefined,
      "archive_reduction_contract_drift",
    );
  }
  return parsed.value;
}

/**
 * A historical recovery action may have been created before the reducer
 * emitted an exact additional-period instruction.  That action can be
 * upgraded only while it is still an inert pending record—never after the
 * scheduler has claimed, routed, or attached any physical work.
 *
 * The SQL upsert in `settleClaim` repeats this condition at the write
 * boundary. Keeping the predicate pure gives the regression suite a direct
 * contract and prevents future callers from weakening it in prose alone.
 */
export function archiveRecoveryMayAdoptCorrectiveTail(input: {
  actionState: string;
  currentCorrectiveTailPeriods: unknown;
  incomingCorrectiveTailPeriods: unknown;
}): boolean {
  if (
    input.actionState !== "pending" ||
    input.currentCorrectiveTailPeriods != null
  ) {
    return false;
  }
  try {
    archiveRecommendedAdditionalPeriods(input.incomingCorrectiveTailPeriods);
    return true;
  } catch {
    return false;
  }
}

/** A capped clean-cycle trajectory is a critical terminal fact, not a request
 * for another automatic physical attempt. Keep this pure policy visible to
 * the worker test suite so a future reducer state cannot accidentally create
 * a duplicate recovery action. */
export function archiveReducerNeedsRecoveryHandoff(
  state:
    | "accepted"
    | "continuation_required"
    | "recovery_exhausted"
    | "rerun_required"
    | "missing_evidence",
): boolean {
  return state === "continuation_required" || state === "rerun_required";
}

async function processClaimedArchiveInterpretationItem(opts: {
  db: DB;
  engine: EngineClient;
  item: ClaimedBackfillItem;
}): Promise<void> {
  const source = await archivePointerForClaim(opts.db, opts.item);
  if (!source.fidelity || !source.pointer) {
    await settleClaim(opts.db, opts.item, {
      state: "missing_evidence",
      lastError: source.reason ?? "raw archive evidence is unavailable",
    });
    return;
  }
  try {
    const reduction = await opts.engine.reduceRemoteEvidenceCleanCycles({
      remote: source.pointer,
      fidelity: source.fidelity,
    });
    const recoveryProgress = archiveBackfillRecoveryProgress({
      state: reduction.state,
      fidelity: source.fidelity,
      diagnostics: reduction.diagnostics,
    });
    // A FAST/FINAL archive response is still URANS evidence when its physical
    // wake is steady-equivalent (`unsteady=false`). That representation is
    // legal only for an accepted reduction: every non-accepted reducer state
    // must retain periodic/cycle evidence. The staged reducer then validates
    // the accompanying no-shedding certificate and force witness before this
    // item can ever select a canonical coefficient.
    if (
      !isRecord(reduction.point) ||
      typeof reduction.point.unsteady !== "boolean" ||
      (reduction.point.unsteady === false && reduction.state !== "accepted")
    ) {
      throw new EngineError(
        "archive reducer returned an invalid URANS mode for its reduction state",
        undefined,
        "archive_reduction_contract_drift",
      );
    }
    if (reduction.state === "missing_evidence") {
      await settleClaim(opts.db, opts.item, {
        state: "missing_evidence",
        lastError: reducerSummary(reduction.state, reduction.diagnostics),
      });
      return;
    }

    // A cadence-free rerun recommendation has no scientific coefficient
    // interpretation to stage.  The work receipt is the durable record of
    // that fact.  If the reducer did obtain a certificate, stage it so its
    // failed/unclean cycles remain inspectable without ever becoming canonical.
    const stageable =
      reduction.state !== "rerun_required" ||
      hasCycleCertificate(reduction.point);
    const staged = stageable
      ? await stageArchiveResultInterpretation({
          db: opts.db,
          resultId: opts.item.resultId,
          resultAttemptId: opts.item.resultAttemptId,
          sourceArchiveId: opts.item.sourceArchiveId!,
          inputEvidenceSignature: reduction.inputEvidenceSignature,
          point: reduction.point,
          fidelity: source.fidelity,
          diagnostics: reduction.diagnostics,
        })
      : null;

    if (reduction.state === "accepted" && staged?.state !== "accepted") {
      throw new EngineError(
        "archive reducer called a point accepted but its certificate cannot be staged as accepted",
        undefined,
        "archive_reduction_contract_drift",
      );
    }
    if (
      reduction.state === "continuation_required" &&
      staged?.state !== "continuation_required"
    ) {
      throw new EngineError(
        "archive reducer called for continuation but its certificate cannot be staged as continuation-required",
        undefined,
        "archive_reduction_contract_drift",
      );
    }
    if (
      reduction.state === "recovery_exhausted" &&
      staged?.state !== "terminal_failure"
    ) {
      throw new EngineError(
        "archive reducer exhausted clean-cycle recovery but its evidence was not staged as terminal",
        undefined,
        "archive_reduction_contract_drift",
      );
    }

    const state: Exclude<
      BackfillItemState,
      "pending" | "hydrating" | "failed"
    > =
      reduction.state === "accepted"
        ? "reduced"
        : reduction.state === "continuation_required"
          ? "continuation_required"
          : reduction.state === "recovery_exhausted"
            ? "terminal_failure"
            : "rerun_required";
    // An accepted reduction may now become the canonical coefficient
    // interpretation, but only through the selector's exact-current-attempt
    // and current-archive proof.  No raw attempt/result scalar is updated.
    // If a concurrent solve changed the result generation, the append-only
    // interpretation stays useful historical evidence and this receipt still
    // settles as reduced without retargeting the newer solve.
    const selectionOutcome =
      state === "reduced"
        ? await selectAcceptedArchiveInterpretation({
            db: opts.db,
            resultId: opts.item.resultId,
            resultAttemptId: opts.item.resultAttemptId,
            sourceArchiveId: opts.item.sourceArchiveId!,
            interpretationId: staged?.id ?? null,
            backfillRunId: opts.item.runId,
          })
        : null;
    if (
      selectionOutcome === "selected" ||
      selectionOutcome === "already_selected"
    ) {
      // Archive selection is the scientific acceptance event. Close the
      // exact physical PRECALC obligation from that event even when the old
      // live-summary classifier had rejected the immutable attempt.
      await satisfyPrecalcObligationFromAcceptedResult(
        opts.db,
        opts.item.resultId,
      );
      const [resultScope] = await opts.db
        .select({
          airfoilId: results.airfoilId,
          simulationPresetRevisionId: results.simulationPresetRevisionId,
        })
        .from(results)
        .where(eq(results.id, opts.item.resultId))
        .limit(1);
      if (resultScope?.simulationPresetRevisionId) {
        // Rebuild immediately so a successful historical reduction becomes
        // visible through the same fit cache used by public/admin views.
        await refreshPolarCacheForRevision(
          opts.db,
          resultScope.airfoilId,
          resultScope.simulationPresetRevisionId,
        );
      }
    }
    const recoveryHandoff = archiveReducerNeedsRecoveryHandoff(reduction.state)
      ? archiveBackfillRecoveryHandoff({
          state:
            reduction.state === "continuation_required"
              ? "continuation_required"
              : "rerun_required",
          fidelity: source.fidelity,
          resultId: opts.item.resultId,
          resultAttemptId: opts.item.resultAttemptId,
          sourceArchiveId: opts.item.sourceArchiveId!,
          inputEvidenceSignature: reduction.inputEvidenceSignature,
          recommendedAdditionalPeriods:
            reduction.state === "continuation_required"
              ? (recoveryProgress?.recommendedAdditionalPeriods ??
                reduction.diagnostics.recommendedAdditionalPeriods)
              : undefined,
        })
      : null;
    await settleClaim(opts.db, opts.item, {
      state,
      resultInterpretationId: staged?.id ?? null,
      lastError:
        state === "reduced"
          ? null
          : reducerSummary(reduction.state, reduction.diagnostics),
      recoveryHandoff,
    });
  } catch (error) {
    const message = limitedError(error);
    const answeredArchiveProblem =
      error instanceof EngineError &&
      (error.status === 409 || error.status === 422);
    const transient = isArchiveInterpretationTransientError(error);
    if (answeredArchiveProblem) {
      await settleClaim(opts.db, opts.item, {
        state: "missing_evidence",
        lastError: message,
      });
      return;
    }
    if (
      transient &&
      opts.item.attemptCount < ARCHIVE_INTERPRETATION_MAX_ATTEMPTS
    ) {
      await settleClaim(opts.db, opts.item, {
        state: "pending",
        nextAttemptAt: new Date(
          Date.now() + backoffForAttempt(opts.item.attemptCount),
        ),
        lastError: message,
      });
      return;
    }
    await settleClaim(opts.db, opts.item, {
      state: "failed",
      lastError: message,
    });
  }
}

async function readRun(
  db: DB,
  runId: string,
): Promise<{
  id: string;
  reducerVersionId: string;
  state: "planned" | "running" | "completed" | "failed" | "cancelled";
} | null> {
  const [run] = await db
    .select({
      id: resultInterpretationBackfillRuns.id,
      reducerVersionId: resultInterpretationBackfillRuns.reducerVersionId,
      state: resultInterpretationBackfillRuns.state,
    })
    .from(resultInterpretationBackfillRuns)
    .where(eq(resultInterpretationBackfillRuns.id, runId))
    .limit(1);
  if (!run) return null;
  if (
    run.state !== "planned" &&
    run.state !== "running" &&
    run.state !== "completed" &&
    run.state !== "failed" &&
    run.state !== "cancelled"
  ) {
    throw new Error(`archive interpretation run ${runId} has an invalid state`);
  }
  return {
    ...run,
    state: run.state as
      | "planned"
      | "running"
      | "completed"
      | "failed"
      | "cancelled",
  };
}

async function countRunItems(
  db: DB,
  runId: string,
): Promise<Record<string, number>> {
  const rows = await db
    .select({
      state: resultInterpretationBackfillItems.state,
      count: sql<number>`count(*)::int`,
    })
    .from(resultInterpretationBackfillItems)
    .where(eq(resultInterpretationBackfillItems.runId, runId))
    .groupBy(resultInterpretationBackfillItems.state);
  return Object.fromEntries(rows.map((row) => [row.state, row.count]));
}

async function countRunCanonicalSelections(
  db: DB,
  runId: string,
): Promise<{ events: number; currentProjections: number }> {
  const [row] = await db
    .select({
      events: sql<number>`count(${resultCanonicalSelections.id})::int`,
      currentProjections: sql<number>`count(${results.id})::int`,
    })
    .from(resultCanonicalSelections)
    .leftJoin(
      results,
      and(
        eq(results.currentCanonicalSelectionId, resultCanonicalSelections.id),
        eq(results.id, resultCanonicalSelections.resultId),
      ),
    )
    .where(eq(resultCanonicalSelections.backfillRunId, runId));
  return {
    events: row?.events ?? 0,
    currentProjections: row?.currentProjections ?? 0,
  };
}

export function archiveInterpretationRunSummaryState(input: {
  currentState: "planned" | "running" | "completed" | "failed" | "cancelled";
  openItems: number;
  forceFailed?: boolean;
}): ArchiveInterpretationBackfillReport["state"] {
  if (input.currentState === "cancelled") return "cancelled";
  if (input.currentState === "failed" || input.forceFailed) return "failed";
  return input.openItems === 0 ? "completed" : "running";
}

async function refreshRunSummary(
  db: DB,
  runId: string,
  opts: { processed: number; forceFailed?: boolean } = { processed: 0 },
): Promise<ArchiveInterpretationBackfillReport> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // Summary refresh shares the run-row mutex with claim and cancellation.
    // Without this lock, a worker that read "running" just before cancellation
    // could write that stale state back after the cancellation committed.
    const [lockedRun] = await tx
      .select({ id: resultInterpretationBackfillRuns.id })
      .from(resultInterpretationBackfillRuns)
      .where(eq(resultInterpretationBackfillRuns.id, runId))
      .limit(1)
      .for("update");
    if (!lockedRun) {
      throw new Error(
        `archive interpretation backfill run ${runId} was not found`,
      );
    }
    const currentRun = await readRun(tx, runId);
    const counts = await countRunItems(tx, runId);
    const selections = await countRunCanonicalSelections(tx, runId);
    if (!currentRun) {
      throw new Error(
        `archive interpretation backfill run ${runId} was not found`,
      );
    }
    const open = (counts.pending ?? 0) + (counts.hydrating ?? 0);
    const state = archiveInterpretationRunSummaryState({
      currentState: currentRun.state,
      openItems: open,
      forceFailed: opts.forceFailed,
    });
    const now = new Date();
    await tx
      .update(resultInterpretationBackfillRuns)
      .set({
        state,
        completedAt:
          state === "completed" || state === "failed" || state === "cancelled"
            ? now
            : null,
        summary: {
          counts,
          processedThisInvocation: opts.processed,
          canonicalSelectionsCreated: selections.events,
          resultProjectionsUpdated: selections.currentProjections,
          rawEvidenceImmutable: true,
        },
      })
      .where(eq(resultInterpretationBackfillRuns.id, runId));
    return {
      runId,
      state,
      processed: opts.processed,
      counts,
      canonicalSelectionsCreated: selections.events,
      resultProjectionsUpdated: selections.currentProjections,
    };
  });
}

/**
 * Stop mutable archive-preservation work without changing source evidence.
 * The run row is the cancellation mutex; open item claims become terminal
 * before the mutex is released, so late reducer responses lose their item CAS
 * and the same attempt cannot be rediscovered under this reducer version.
 */
export async function cancelArchiveInterpretationBackfillRun(opts: {
  db: DB;
  runId: string;
  reason: string;
}): Promise<ArchiveInterpretationBackfillReport> {
  const reason = opts.reason.trim();
  if (!reason)
    throw new Error("archive interpretation cancellation requires a reason");
  await opts.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [run] = await tx
      .select({ state: resultInterpretationBackfillRuns.state })
      .from(resultInterpretationBackfillRuns)
      .where(eq(resultInterpretationBackfillRuns.id, opts.runId))
      .limit(1)
      .for("update");
    if (!run) {
      throw new Error(
        `archive interpretation backfill run ${opts.runId} was not found`,
      );
    }
    if (run.state === "cancelled") return;
    if (run.state === "completed" || run.state === "failed") {
      throw new Error(
        `archive interpretation backfill run ${opts.runId} is already ${run.state}`,
      );
    }
    const now = new Date();
    await tx
      .update(resultInterpretationBackfillItems)
      .set({
        state: "abandoned",
        claimToken: null,
        claimExpiresAt: null,
        nextAttemptAt: now,
        lastError: `operator abandoned archive preservation: ${reason}`.slice(
          0,
          2_000,
        ),
      })
      .where(
        and(
          eq(resultInterpretationBackfillItems.runId, opts.runId),
          inArray(resultInterpretationBackfillItems.state, [
            "pending",
            "hydrating",
          ]),
        ),
      );
    await tx
      .update(resultInterpretationBackfillRuns)
      .set({ state: "cancelled", completedAt: now })
      .where(eq(resultInterpretationBackfillRuns.id, opts.runId));
  });
  return refreshRunSummary(opts.db, opts.runId, { processed: 0 });
}

/**
 * Convert one campaign's exhausted legacy PRECALC cells to their already
 * budgeted fresh attempt after an operator has cancelled archive preservation.
 * Every prior URANS attempt receives a terminal receipt in the cancelled run;
 * that exact receipt fences both rediscovery and same-case continuation.
 */
export async function routeCampaignPrecalcToFreshAfterArchiveAbandonment(opts: {
  db: DB;
  runId: string;
  campaignId: string;
  reason: string;
}): Promise<DisposableArchiveFreshRerunReport> {
  if (!UUID.test(opts.runId) || !UUID.test(opts.campaignId)) {
    throw new Error(
      "archive fresh rerun requires exact run and campaign UUIDs",
    );
  }
  const reason = opts.reason.trim();
  if (!reason) throw new Error("archive fresh rerun requires a reason");
  const report = await opts.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [run] = await tx
      .select({ state: resultInterpretationBackfillRuns.state })
      .from(resultInterpretationBackfillRuns)
      .where(eq(resultInterpretationBackfillRuns.id, opts.runId))
      .limit(1)
      .for("update");
    if (!run) {
      throw new Error(
        `archive interpretation backfill run ${opts.runId} was not found`,
      );
    }
    if (run.state !== "cancelled") {
      throw new Error(
        `archive fresh rerun requires a cancelled backfill run (state ${run.state})`,
      );
    }

    const candidates = (await tx.execute(sql`
      SELECT obligation.id
      FROM sim_precalc_obligations obligation
      JOIN sim_precalc_obligation_campaigns ownership
        ON ownership.obligation_id = obligation.id
       AND ownership.campaign_id = ${opts.campaignId}::uuid
       AND ownership.state = 'active'
      JOIN sim_campaigns campaign
        ON campaign.id = ownership.campaign_id
       AND campaign.status IN ('active', 'attention', 'paused')
      WHERE obligation.state = 'blocked'
        AND obligation.last_outcome = 'rejected_exhausted'
        AND obligation.attempt_count < obligation.max_attempts
        AND NOT EXISTS (
          SELECT 1
          FROM sim_jobs active_job
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(active_job.request_payload -> 'precalcObligationIds') = 'array'
              THEN active_job.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END
          ) active_owner(id)
          WHERE active_owner.id = obligation.id::text
            AND active_job.status IN ('pending', 'submitted', 'running', 'ingesting')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM result_attempts accepted_attempt
          JOIN result_classifications accepted_classification
            ON accepted_classification.result_attempt_id = accepted_attempt.id
           AND accepted_classification.state = 'accepted'
          WHERE accepted_attempt.airfoil_id = obligation.airfoil_id
            AND accepted_attempt.simulation_preset_revision_id = obligation.revision_id
            AND accepted_attempt.aoa_deg IS NOT DISTINCT FROM obligation.aoa_deg
            AND accepted_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
        )
        AND EXISTS (
          SELECT 1
          FROM sim_precalc_obligation_attempts submission
          JOIN result_attempts source_attempt
            ON source_attempt.id = submission.result_attempt_id
           AND source_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
          JOIN solver_evidence_archives source_archive
            ON source_archive.result_id = source_attempt.result_id
           AND source_archive.result_attempt_id = source_attempt.id
           AND source_archive.state = 'current'
          WHERE submission.obligation_id = obligation.id
        )
      ORDER BY obligation.id
      FOR UPDATE OF obligation
    `)) as unknown as Array<{ id: string }>;
    if (!candidates.length) {
      return {
        runId: opts.runId,
        campaignId: opts.campaignId,
        obligationsReopened: 0,
        attemptReceiptsAbandoned: 0,
      };
    }
    const obligationIds = sql`ARRAY[${sql.join(
      candidates.map((candidate) => sql`${candidate.id}::uuid`),
      sql`, `,
    )}]`;
    const inserted = (await tx.execute(sql`
      INSERT INTO result_interpretation_backfill_items (
        run_id,
        result_id,
        result_attempt_id,
        source_archive_id,
        state,
        next_attempt_at,
        last_error
      )
      SELECT DISTINCT
        ${opts.runId}::uuid,
        source_attempt.result_id,
        source_attempt.id,
        source_archive.id,
        'abandoned',
        now(),
        ${`operator abandoned archive preservation: ${reason}`.slice(0, 2_000)}
      FROM sim_precalc_obligation_attempts submission
      JOIN result_attempts source_attempt
        ON source_attempt.id = submission.result_attempt_id
       AND source_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
      JOIN solver_evidence_archives source_archive
        ON source_archive.result_id = source_attempt.result_id
       AND source_archive.result_attempt_id = source_attempt.id
       AND source_archive.state = 'current'
      WHERE submission.obligation_id = ANY(${obligationIds})
      ON CONFLICT (run_id, result_attempt_id) DO NOTHING
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    const [coverage] = (await tx.execute(sql`
      SELECT count(DISTINCT submission.obligation_id)::int AS covered,
             count(DISTINCT receipt.id)::int AS receipts
      FROM sim_precalc_obligation_attempts submission
      JOIN result_interpretation_backfill_items receipt
        ON receipt.run_id = ${opts.runId}::uuid
       AND receipt.result_attempt_id = submission.result_attempt_id
       AND receipt.state = 'abandoned'
      WHERE submission.obligation_id = ANY(${obligationIds})
    `)) as unknown as Array<{ covered: number; receipts: number }>;
    if (Number(coverage?.covered ?? 0) !== candidates.length) {
      throw new Error(
        "archive fresh rerun could not terminally receipt every candidate obligation",
      );
    }
    const reopened = (await tx.execute(sql`
      UPDATE sim_precalc_obligations obligation
      SET state = 'pending',
          next_submit_at = NULL,
          completed_at = NULL,
          last_outcome = 'archive_abandoned_fresh_retry_pending',
          last_error = NULL,
          "updatedAt" = now()
      WHERE obligation.id = ANY(${obligationIds})
        AND obligation.state = 'blocked'
        AND obligation.last_outcome = 'rejected_exhausted'
        AND obligation.attempt_count < obligation.max_attempts
      RETURNING obligation.id
    `)) as unknown as Array<{ id: string }>;
    if (reopened.length !== candidates.length) {
      throw new Error(
        "archive fresh rerun lost an obligation ownership race; no changes were committed",
      );
    }
    await tx.execute(sql`
      UPDATE result_interpretation_backfill_runs
      SET scope = scope || jsonb_build_object(
            'operatorFreshRerunCampaignId', ${opts.campaignId}::text,
            'operatorFreshRerunReason', ${reason}::text
          ),
          summary = summary || jsonb_build_object(
            'attemptReceiptsAbandoned', (
              SELECT count(*)::int
              FROM result_interpretation_backfill_items receipt
              WHERE receipt.run_id = ${opts.runId}::uuid
                AND receipt.state = 'abandoned'
            ),
            'obligationsReopenedFresh', ${reopened.length}
          ),
          "updatedAt" = now()
      WHERE id = ${opts.runId}::uuid
    `);
    return {
      runId: opts.runId,
      campaignId: opts.campaignId,
      obligationsReopened: reopened.length,
      attemptReceiptsAbandoned: Number(coverage?.receipts ?? inserted.length),
    };
  });
  await recomputeProgressForCampaign(opts.db, opts.campaignId);
  await probeCampaignCompletion(opts.db, opts.campaignId);
  return report;
}

/**
 * Resume one durable backfill run.  A bounded invocation is deliberate: a
 * scheduler/CLI can invoke it repeatedly, and a transient remote-store error
 * remains pending with a timestamped retry rather than blocking the rest of
 * the historical evidence set.
 */
export async function runArchiveInterpretationBackfill(opts: {
  db: DB;
  engine: EngineClient;
  runId: string;
  maxItems?: number;
}): Promise<ArchiveInterpretationBackfillReport> {
  const maxItems =
    opts.maxItems ?? DEFAULT_ARCHIVE_INTERPRETATION_BACKFILL_LIMIT;
  if (!Number.isSafeInteger(maxItems) || maxItems <= 0 || maxItems > 100_000) {
    throw new Error(
      "maxItems must be a positive integer no greater than 100000",
    );
  }
  const run = await readRun(opts.db, opts.runId);
  if (!run)
    throw new Error(
      `archive interpretation backfill run ${opts.runId} was not found`,
    );
  if (run.state === "cancelled" || run.state === "failed") {
    return refreshRunSummary(opts.db, run.id, {
      processed: 0,
      forceFailed: run.state === "failed",
    });
  }
  const currentReducerVersionId =
    await ensureResultInterpretationReducerVersion(opts.db);
  if (run.reducerVersionId !== currentReducerVersionId) {
    const report = await refreshRunSummary(opts.db, run.id, {
      processed: 0,
      forceFailed: true,
    });
    throw new Error(
      `archive interpretation backfill run ${run.id} is pinned to reducer ${run.reducerVersionId}, not current reducer ${currentReducerVersionId}; create a new run`,
    );
  }
  if (run.state === "completed")
    return refreshRunSummary(opts.db, run.id, { processed: 0 });
  const [started] = await opts.db
    .update(resultInterpretationBackfillRuns)
    .set({ state: "running", startedAt: new Date(), completedAt: null })
    .where(
      and(
        eq(resultInterpretationBackfillRuns.id, run.id),
        inArray(resultInterpretationBackfillRuns.state, ["planned", "running"]),
      ),
    )
    .returning({ id: resultInterpretationBackfillRuns.id });
  if (!started) {
    return refreshRunSummary(opts.db, run.id, { processed: 0 });
  }

  let processed = 0;
  while (processed < maxItems) {
    const item = await claimNextArchiveInterpretationItem(opts.db, run.id);
    if (!item) break;
    await processClaimedArchiveInterpretationItem({
      db: opts.db,
      engine: opts.engine,
      item,
    });
    processed += 1;
  }
  return refreshRunSummary(opts.db, run.id, { processed });
}

/** One bounded automatic archive-reduction pass. Historical/current URANS
 * evidence is discovered only when no compatible durable run is already
 * open, avoiding empty-run ledger churn during ordinary scheduler polling. */
export async function archiveInterpretationMaintenanceTick(opts: {
  db: DB;
  engine: EngineClient;
  discoveryLimit?: number;
  maxItems?: number;
}): Promise<ArchiveInterpretationBackfillReport | null> {
  const reducerVersionId = await ensureResultInterpretationReducerVersion(
    opts.db,
  );
  const [openRun] = await opts.db
    .select({ id: resultInterpretationBackfillRuns.id })
    .from(resultInterpretationBackfillRuns)
    .where(
      and(
        eq(resultInterpretationBackfillRuns.reducerVersionId, reducerVersionId),
        inArray(resultInterpretationBackfillRuns.state, ["planned", "running"]),
      ),
    )
    .orderBy(asc(resultInterpretationBackfillRuns.createdAt))
    .limit(1);
  let runId = openRun?.id ?? null;
  if (!runId) {
    const scope = { limit: opts.discoveryLimit ?? 16 };
    const discovery = await discoverArchiveInterpretationBackfill(opts.db, {
      reducerVersionId,
      scope,
    });
    if (!discovery.candidates.length) return null;
    const created = await createArchiveInterpretationBackfillRun({
      db: opts.db,
      scope,
      requestedBy: "system:sweeper-archive-maintenance",
    });
    runId = created.runId;
  }
  return runArchiveInterpretationBackfill({
    db: opts.db,
    engine: opts.engine,
    runId,
    maxItems: opts.maxItems ?? 4,
  });
}

const scheduleArchiveMaintenanceOnce = createSingleFlightBackgroundRunner(
  (error) => {
    console.error(
      "[sweeper] archive interpretation maintenance failed:",
      error instanceof Error ? error.message : String(error),
    );
  },
);

/** Keep raw-archive interpretation off the admission loop: a GCS download and
 * reduction may take minutes, while CPU scheduling and heartbeats must keep
 * progressing. Durable item claims make restart/retry safe. */
export function startArchiveInterpretationMaintenanceTimer(
  db: DB,
  engine: EngineClient,
  intervalMs = 30_000,
): () => void {
  const schedule = () => {
    scheduleArchiveMaintenanceOnce(() =>
      archiveInterpretationMaintenanceTick({ db, engine }),
    );
  };
  schedule();
  const timer = setInterval(schedule, intervalMs);
  return () => clearInterval(timer);
}
