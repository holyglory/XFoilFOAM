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
  hasExactLivePrecalcPublicationWinner,
  refreshCampaignProgressForResultIds,
  satisfyPrecalcObligationFromAcceptedResult,
  historicalArchiveAuditDecisions,
  type SolverEvidenceBlob,
  refreshPolarCacheForRevision,
  resultAttempts,
  resultCanonicalSelections,
  resultInterpretationBackfillItems,
  resultInterpretationBackfillRuns,
  resultInterpretationRecoveryActions,
  resultInterpretations,
  results,
  simJobs,
  solverEvidenceArchives,
  solverEvidenceArtifacts,
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
  ArchivePublicationClaimLostError,
  HistoricalArchiveAuditClaimLostError,
  HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT,
  historicalReleasedArchiveAuditScopeMatchesExactSource,
  type ArchivePublicationClaimFence,
  type ArchiveInterpretationStageAuthority,
  type HistoricalArchiveAuditDecisionDraft,
  ensureResultInterpretationReducerVersion,
  selectAcceptedArchiveInterpretation,
  stageArchiveResultInterpretation,
  validateHistoricalReleasedArchiveAuditExactSource,
  validateHistoricalReleasedArchiveAuditScope,
} from "./result-interpretations";
import { isEngineConnectionFailure } from "./engine-backoff";

const SHA256 = /^[0-9a-f]{64}$/;
const GCS_GENERATION = /^[1-9][0-9]{0,19}$/;
const CRC32C = /^[A-Za-z0-9+/]{6}==$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The reducer performs a fresh, complete generation-pinned archive scan. */
export const ARCHIVE_INTERPRETATION_LEASE_MS = 30 * 60_000;
export const ARCHIVE_INTERPRETATION_LEASE_RENEW_MS = Math.max(
  1_000,
  Math.floor(ARCHIVE_INTERPRETATION_LEASE_MS / 3),
);
export const ARCHIVE_INTERPRETATION_MAX_ATTEMPTS = 3;
export const DEFAULT_ARCHIVE_INTERPRETATION_BACKFILL_LIMIT = 1_000;
/**
 * A backfill child may be leased only by an actively running parent.  This is
 * deliberately narrower than summary refresh (which may observe a completed
 * parent): a cancellation or source-owner failure must stop new archive I/O
 * before the child changes from pending to hydrating.
 */
export const ARCHIVE_INTERPRETATION_CLAIMABLE_RUN_STATES = ["running"];

export type ArchiveInterpretationBackfillScope = {
  resultIds?: string[];
  resultAttemptIds?: string[];
  /** Number of immutable URANS attempts to enqueue in a single run. */
  limit?: number;
};

/** One immutable archive identity owned by the production publication queue.
 * This is intentionally separate from the historical/filter scope: a queue
 * claim must never rediscover the currently-current archive for an attempt. */
export type ExactArchiveInterpretationSource = {
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
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
  scope: Required<ArchiveInterpretationBackfillScope>;
};

export type ArchiveInterpretationBackfillRun = {
  runId: string;
  reducerVersionId: string;
  enqueued: number;
  skippedExistingInterpretations: number;
  state: "running" | "completed";
};

/**
 * One released result generation may be inspected only by this explicit,
 * exact-source route.  It deliberately is not a queue candidate: the result
 * has no live canonical pointer and the audit can never restore one.
 */
export type HistoricalReleasedArchiveAuditRun = {
  runId: string;
  reducerVersionId: string;
  enqueued: number;
};

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

/**
 * A summary is observational, never an authority to resurrect a terminal
 * operator decision. Keep this small policy explicit so cancellation remains
 * testable independently of aggregate database counts.
 */
export function archiveInterpretationBackfillSummaryState(input: {
  terminalState?: "failed" | "cancelled";
  auditIncomplete: boolean;
  openItems: number;
}): ArchiveInterpretationBackfillReport["state"] {
  if (input.terminalState) return input.terminalState;
  if (input.auditIncomplete) return "failed";
  return input.openItems === 0 ? "completed" : "running";
}

/**
 * A deliberately non-executing, durable handoff for work discovered while
 * reducing historical evidence.  The archive worker must never submit CFD
 * itself: it has no authority to turn an older attempt into a new physical
 * generation.  Instead it leaves this exact, machine-readable instruction on
 * the immutable-scope work receipt for the URANS-ladder recovery consumer.
 *
 * `rerun_required` means the retained generation lacks immutable publication
 * provenance. The consumer may inspect restart proof for diagnosis, but must
 * allocate one ordinary fresh generation rather than continuing that source.
 * `continuation_required` remains the only same-case continuation instruction.
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
  /** Explicit v2 policy emitted by the authenticated reducer. NULL preserves
   * the original legacy FAST=9 / FINAL=12 authority. */
  cleanCycleRecoveryPolicyVersion: "adaptive-clean-tail-v2" | null;
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
  | "failed";

export type ArchiveInterpretationRunMode =
  | "queue_publication"
  | "historical_released_audit";

type HistoricalArchiveAuditDecisionInput =
  HistoricalArchiveAuditDecisionDraft & {
    reducerVersionId: string;
    resultInterpretationId: string | null;
  };

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

/**
 * The production queue and a released-evidence audit share bounded GCS
 * reduction mechanics, but not authority.  Persisted scope is the source of
 * truth: a caller cannot opt a normal publication run into audit behaviour by
 * passing a flag at resume time.
 */
export function archiveInterpretationBackfillRunMode(
  scope: unknown,
): ArchiveInterpretationRunMode {
  if (!isRecord(scope)) return "queue_publication";
  if (scope.contract !== HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT) {
    return "queue_publication";
  }
  validateHistoricalReleasedArchiveAuditScope(scope);
  return "historical_released_audit";
}

/**
 * A historical released-evidence receipt is not a resumable background queue
 * item.  The caller must repeat the exact three immutable identities that
 * created it before it may spend another GCS/engine read.  Persisted scope is
 * still authoritative; this execution authority merely proves the caller is
 * the explicit audit path rather than a generic scheduler retry.
 */
export function requireHistoricalReleasedArchiveAuditExecutionAuthority(input: {
  scope: unknown;
  exactSource: ExactArchiveInterpretationSource | undefined;
}): ExactArchiveInterpretationSource {
  const persistedExactSource = validateHistoricalReleasedArchiveAuditScope(
    input.scope,
  );
  if (!input.exactSource) {
    throw new Error(
      "historical released-evidence audit execution requires the exact resultId, resultAttemptId, and sourceArchiveId authority",
    );
  }
  const executionExactSource =
    validateHistoricalReleasedArchiveAuditExactSource(input.exactSource);
  if (
    persistedExactSource.resultId !== executionExactSource.resultId ||
    persistedExactSource.resultAttemptId !==
      executionExactSource.resultAttemptId ||
    persistedExactSource.sourceArchiveId !==
      executionExactSource.sourceArchiveId
  ) {
    throw new Error(
      "historical released-evidence audit execution authority does not match the persisted audit source",
    );
  }
  return persistedExactSource;
}

/**
 * Publication work may retry a transient reducer/store failure.  An explicit
 * released-history audit is deliberately different: retrying it later without
 * a fresh three-ID invocation would turn an operator audit into background
 * discovery, so its reducer failure is terminal on that receipt.
 */
export function archiveInterpretationMayRetry(input: {
  mode: ArchiveInterpretationRunMode;
  transient: boolean;
  attemptCount: number;
}): boolean {
  return (
    input.mode === "queue_publication" &&
    input.transient &&
    input.attemptCount < ARCHIVE_INTERPRETATION_MAX_ATTEMPTS
  );
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
    objectKey.includes("\\") ||
    /(^|\/)\.{1,2}(\/|$)/.test(objectKey)
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
      resultAttemptId: resultAttempts.id,
      currentResultAttemptId: results.currentResultAttemptId,
      evidencePayload: resultAttempts.evidencePayload,
      regime: resultAttempts.regime,
      unsteady: resultAttempts.unsteady,
      sourceArchiveId: solverEvidenceArchives.id,
      archiveResultId: solverEvidenceArchives.resultId,
      archiveAttemptId: solverEvidenceArchives.resultAttemptId,
      blob: solverEvidenceBlobs,
    })
    .from(resultAttempts)
    .innerJoin(results, eq(results.id, resultAttempts.resultId))
    .innerJoin(
      solverEvidenceArchives,
      and(
        eq(solverEvidenceArchives.resultId, results.id),
        eq(solverEvidenceArchives.resultAttemptId, resultAttempts.id),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .innerJoin(
      solverEvidenceBlobs,
      eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
    )
    .where(
      and(
        sql`${resultAttempts.resultId} IS NOT NULL`,
        // This is the normal publication/recovery discovery path. A released
        // result's archive is historical evidence, even if its attempt and
        // GCS bundle are otherwise complete; only the explicit audit route
        // may read it.
        isNotNull(results.currentResultAttemptId),
        eq(resultAttempts.status, "done"),
        eq(resultAttempts.source, "solved"),
        sql`${resultAttempts.evidencePayload} ->> 'fidelity' IN ('urans_precalc', 'urans_full')`,
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
    const fidelity = archiveBackfillFidelity(row.evidencePayload);
    // The SQL predicate is deliberately duplicated with a strict parser: the
    // parser is the actual provenance contract, and protects us from a future
    // JSON coercion or a malformed historical payload.
    if (
      !fidelity ||
      !row.resultAttemptId ||
      !row.sourceArchiveId ||
      !(
        row.regime === "urans" ||
        (row.regime === "rans" && row.unsteady === false)
      )
    ) {
      return [];
    }
    const pointer = archivePointerForBackfill(row.blob);
    // The executable path accepts only a complete exact pointer. Archive
    // gaps are handled by the dedicated recovery ledger, never by a generic
    // reducer run that could manufacture recovery work from malformed bytes.
    if (!pointer.pointer) return [];
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
          // A released-history audit deliberately records a distinct source.
          // It cannot satisfy a later live publication receipt if this cell is
          // subsequently reopened: only a queue-authorized reduction may
          // suppress normal backfill discovery for its archive.
          eq(resultInterpretations.source, "archive_backfill"),
        ),
      );
    for (const row of existing) {
      if (row.sourceArchiveId) interpretedArchiveIds.add(row.sourceArchiveId);
    }
  }
  const pending = candidates.filter(
    (candidate) =>
      !candidate.sourceArchiveId ||
      !interpretedArchiveIds.has(candidate.sourceArchiveId),
  );
  return {
    candidates: pending,
    scanned: candidates.length,
    skippedExistingInterpretations: candidates.length - pending.length,
    scope,
  };
}

/** Resolve exactly one queue-owned immutable source. This is the strict
 * admission proof shared by queue run creation and its claim-time reducer
 * fence. It intentionally requires a current archive and a fully validated
 * generation-pinned GCS pointer. */
export async function discoverExactArchiveInterpretationBackfillCandidate(
  db: DB,
  source: ExactArchiveInterpretationSource,
): Promise<ArchiveInterpretationBackfillCandidate | null> {
  const [row] = await db
    .select({
      resultId: results.id,
      resultAttemptId: resultAttempts.id,
      currentResultAttemptId: results.currentResultAttemptId,
      evidencePayload: resultAttempts.evidencePayload,
      status: resultAttempts.status,
      attemptSource: resultAttempts.source,
      regime: resultAttempts.regime,
      unsteady: resultAttempts.unsteady,
      sourceArchiveId: solverEvidenceArchives.id,
      blob: solverEvidenceBlobs,
    })
    .from(resultAttempts)
    .innerJoin(results, eq(results.id, resultAttempts.resultId))
    .innerJoin(
      solverEvidenceArchives,
      and(
        eq(solverEvidenceArchives.id, source.sourceArchiveId),
        eq(solverEvidenceArchives.resultId, source.resultId),
        eq(solverEvidenceArchives.resultAttemptId, source.resultAttemptId),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .innerJoin(
      solverEvidenceBlobs,
      eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
    )
    .where(
      and(
        eq(results.id, source.resultId),
        eq(resultAttempts.id, source.resultAttemptId),
        eq(resultAttempts.resultId, source.resultId),
        eq(resultAttempts.status, "done"),
        eq(resultAttempts.source, "solved"),
      ),
    )
    .limit(1);
  const fidelity = archiveBackfillFidelity(row?.evidencePayload);
  if (
    !row ||
    !row.resultId ||
    !row.resultAttemptId ||
    !row.sourceArchiveId ||
    !fidelity ||
    !(
      row.regime === "urans" ||
      (row.regime === "rans" && row.unsteady === false)
    )
  ) {
    return null;
  }
  if (
    row.currentResultAttemptId == null &&
    !(await hasExactLivePrecalcPublicationWinner(db, {
      resultId: row.resultId,
      resultAttemptId: row.resultAttemptId,
    }))
  ) {
    return null;
  }
  const pointer = archivePointerForBackfill(row.blob);
  if (!pointer.pointer) return null;
  return {
    resultId: row.resultId,
    resultAttemptId: row.resultAttemptId,
    fidelity,
    sourceArchiveId: row.sourceArchiveId,
    archivePointer: pointer.pointer,
    unavailableReason: null,
  };
}

/**
 * Resolve one immutable archive from a *released* result for audit only.  A
 * normal queue source requires a current result generation; this inverse
 * proof makes the audit safe even when its raw interpretation is accepted:
 * there is no live projection it could legitimately replace.
 */
export async function discoverHistoricalReleasedArchiveAuditCandidate(
  db: DB,
  source: ExactArchiveInterpretationSource,
): Promise<ArchiveInterpretationBackfillCandidate | null> {
  for (const [label, value] of Object.entries(source)) {
    if (!UUID.test(value)) {
      throw new Error(
        `historical released-evidence audit ${label} must be a UUID`,
      );
    }
  }
  const [row] = await db
    .select({
      resultId: results.id,
      resultAttemptId: resultAttempts.id,
      evidencePayload: resultAttempts.evidencePayload,
      status: resultAttempts.status,
      attemptSource: resultAttempts.source,
      regime: resultAttempts.regime,
      unsteady: resultAttempts.unsteady,
      sourceArchiveId: solverEvidenceArchives.id,
      blob: solverEvidenceBlobs,
    })
    .from(resultAttempts)
    .innerJoin(results, eq(results.id, resultAttempts.resultId))
    .innerJoin(
      solverEvidenceArchives,
      and(
        eq(solverEvidenceArchives.id, source.sourceArchiveId),
        eq(solverEvidenceArchives.resultId, source.resultId),
        eq(solverEvidenceArchives.resultAttemptId, source.resultAttemptId),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .innerJoin(
      solverEvidenceArtifacts,
      and(
        eq(solverEvidenceArtifacts.id, solverEvidenceArchives.sourceArtifactId),
        eq(solverEvidenceArtifacts.resultId, results.id),
        eq(solverEvidenceArtifacts.resultAttemptId, resultAttempts.id),
      ),
    )
    .innerJoin(
      solverEvidenceBlobs,
      eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
    )
    .where(
      and(
        eq(results.id, source.resultId),
        isNull(results.currentResultAttemptId),
        isNull(results.currentResultInterpretationId),
        isNull(results.currentCanonicalSelectionId),
        eq(results.status, "done"),
        eq(results.source, "solved"),
        eq(resultAttempts.id, source.resultAttemptId),
        eq(resultAttempts.resultId, source.resultId),
        eq(resultAttempts.status, "done"),
        eq(resultAttempts.source, "solved"),
        inArray(solverEvidenceArtifacts.kind, [
          "engine_bundle",
          "openfoam_bundle",
        ]),
      ),
    )
    .limit(1);
  const fidelity = archiveBackfillFidelity(row?.evidencePayload);
  if (
    !row ||
    !fidelity ||
    !(
      row.regime === "urans" ||
      (row.regime === "rans" && row.unsteady === false)
    )
  ) {
    return null;
  }
  const pointer = archivePointerForBackfill(row.blob);
  if (!pointer.pointer) return null;
  return {
    resultId: row.resultId,
    resultAttemptId: row.resultAttemptId,
    fidelity,
    sourceArchiveId: row.sourceArchiveId,
    archivePointer: pointer.pointer,
    unavailableReason: null,
  };
}

/**
 * Re-prove one released audit source while the caller already owns the result
 * row.  Discovery intentionally happens without locks so a CLI can explain a
 * missing source cheaply; admission/settlement cannot rely on that snapshot.
 *
 * Lock order is deliberately caller child (when one exists) -> result ->
 * attempt/archive/source-artifact/blob.  Do not call this from a normal
 * publication path: a live archive must use its separate current-generation
 * fence.
 */
async function lockHistoricalReleasedArchiveAuditCandidate(
  db: DB,
  source: ExactArchiveInterpretationSource,
): Promise<ArchiveInterpretationBackfillCandidate | null> {
  for (const [label, value] of Object.entries(source)) {
    if (!UUID.test(value)) {
      throw new Error(
        `historical released-evidence audit ${label} must be a UUID`,
      );
    }
  }
  const [row] = await db
    .select({
      resultId: results.id,
      resultAttemptId: resultAttempts.id,
      evidencePayload: resultAttempts.evidencePayload,
      regime: resultAttempts.regime,
      unsteady: resultAttempts.unsteady,
      sourceArchiveId: solverEvidenceArchives.id,
      blob: solverEvidenceBlobs,
    })
    .from(results)
    .innerJoin(resultAttempts, eq(resultAttempts.resultId, results.id))
    .innerJoin(
      solverEvidenceArchives,
      and(
        eq(solverEvidenceArchives.id, source.sourceArchiveId),
        eq(solverEvidenceArchives.resultId, source.resultId),
        eq(solverEvidenceArchives.resultAttemptId, source.resultAttemptId),
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .innerJoin(
      solverEvidenceArtifacts,
      and(
        eq(solverEvidenceArtifacts.id, solverEvidenceArchives.sourceArtifactId),
        eq(solverEvidenceArtifacts.resultId, results.id),
        eq(solverEvidenceArtifacts.resultAttemptId, resultAttempts.id),
      ),
    )
    .innerJoin(
      solverEvidenceBlobs,
      eq(solverEvidenceBlobs.id, solverEvidenceArchives.blobId),
    )
    .where(
      and(
        eq(results.id, source.resultId),
        isNull(results.currentResultAttemptId),
        isNull(results.currentResultInterpretationId),
        isNull(results.currentCanonicalSelectionId),
        eq(results.status, "done"),
        eq(results.source, "solved"),
        eq(resultAttempts.id, source.resultAttemptId),
        eq(resultAttempts.resultId, source.resultId),
        eq(resultAttempts.status, "done"),
        eq(resultAttempts.source, "solved"),
        inArray(solverEvidenceArtifacts.kind, [
          "engine_bundle",
          "openfoam_bundle",
        ]),
      ),
    )
    .limit(1)
    .for("update");
  const fidelity = archiveBackfillFidelity(row?.evidencePayload);
  if (
    !row ||
    !row.resultId ||
    !row.resultAttemptId ||
    !row.sourceArchiveId ||
    !fidelity ||
    !(
      row.regime === "urans" ||
      (row.regime === "rans" && row.unsteady === false)
    )
  ) {
    return null;
  }
  const pointer = archivePointerForBackfill(row.blob);
  if (!pointer.pointer) return null;
  return {
    resultId: row.resultId,
    resultAttemptId: row.resultAttemptId,
    fidelity,
    sourceArchiveId: row.sourceArchiveId,
    archivePointer: pointer.pointer,
    unavailableReason: null,
  };
}

/** Create a durable run and immutable-attempt receipts.  No CFD request is
 * launched here; items with no raw archive are still retained as an honest
 * missing-evidence outcome. */
export async function createArchiveInterpretationBackfillRun(opts: {
  db: DB;
  scope?: ArchiveInterpretationBackfillScope;
  /** Queue-owned versions remain valid after a newer policy deploy. */
  reducerVersionId?: string;
  /** Production publication invokes this exact-source path. */
  exactSource?: ExactArchiveInterpretationSource;
  requestedBy?: string;
}): Promise<ArchiveInterpretationBackfillRun> {
  if (opts.exactSource && opts.scope) {
    throw new Error(
      "exact archive publication cannot be combined with a broad backfill scope",
    );
  }
  const reducerVersionId =
    opts.reducerVersionId ??
    (await ensureResultInterpretationReducerVersion(opts.db));
  const exactCandidate = opts.exactSource
    ? await discoverExactArchiveInterpretationBackfillCandidate(
        opts.db,
        opts.exactSource,
      )
    : null;
  const discovery = opts.exactSource
    ? {
        candidates: exactCandidate ? [exactCandidate] : [],
        scanned: exactCandidate ? 1 : 0,
        skippedExistingInterpretations: 0,
        scope: normaliseArchiveInterpretationBackfillScope({
          resultIds: [opts.exactSource.resultId],
          resultAttemptIds: [opts.exactSource.resultAttemptId],
          limit: 1,
        }),
      }
    : await discoverArchiveInterpretationBackfill(opts.db, {
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
        exactSource: opts.exactSource ?? null,
        rawEvidenceImmutable: true,
        canonicalSelection: "accepted-current-archive-only",
      },
      summary: {
        discovered: discovery.scanned,
        enqueued: discovery.candidates.length,
        skippedExistingInterpretations:
          discovery.skippedExistingInterpretations,
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
    state: initialState,
  };
}

/**
 * Create one audit receipt for a historical result that has deliberately been
 * released from canonical publication.  This is an exact three-ID operation;
 * broad discovery and automatic scheduling are intentionally impossible.
 */
export async function createHistoricalReleasedArchiveAuditRun(opts: {
  db: DB;
  exactSource: ExactArchiveInterpretationSource;
  reducerVersionId?: string;
  requestedBy?: string;
}): Promise<HistoricalReleasedArchiveAuditRun> {
  // Historical audit receipts deliberately do not publish a result, but they
  // still consume the same archive/worker path as live reductions. There are
  // no live receipts to preserve, so disable this obsolete forensic workflow
  // at its sole creation boundary rather than letting it reserve solver work.
  void opts;
  throw new Error(
    "historical released-evidence audits are disabled; discard unpublished generations and use accepted-current archive reduction only",
  );

  const exactSource = validateHistoricalReleasedArchiveAuditExactSource(
    opts.exactSource,
  );
  const reducerVersionId =
    opts.reducerVersionId ??
    (await ensureResultInterpretationReducerVersion(opts.db));
  return opts.db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // Serialize exact audit admission on the released result.  This does not
    // hold a transaction through GCS/engine I/O; it only prevents two CLI
    // invocations from creating competing durable receipts before either can
    // claim the one immutable archive.
    const [lockedResult] = await tx
      .select({ id: results.id })
      .from(results)
      .where(
        and(
          eq(results.id, exactSource.resultId),
          isNull(results.currentResultAttemptId),
          isNull(results.currentResultInterpretationId),
          isNull(results.currentCanonicalSelectionId),
          eq(results.status, "done"),
          eq(results.source, "solved"),
        ),
      )
      .limit(1)
      .for("update");
    if (!lockedResult) {
      throw new Error(
        "historical released-evidence audit source is no longer a released completed solved result",
      );
    }

    // The initial CLI discovery is intentionally not an admission proof. An
    // archive can be superseded or its GCS metadata corrected between the
    // operator's request and this transaction. Re-read the exact source only
    // after the released result is locked, then lock its
    // attempt/archive/source-artifact/blob before any durable audit receipt
    // is created.
    const candidate = await lockHistoricalReleasedArchiveAuditCandidate(
      tx,
      exactSource,
    );
    if (!candidate || !candidate.sourceArchiveId) {
      throw new Error(
        "historical released-evidence audit requires one exact current GCS archive owned by a released completed URANS-compatible attempt",
      );
    }
    const sourceArchiveId = candidate.sourceArchiveId;

    const [existingDecision] = await tx
      .select({ auditRunId: historicalArchiveAuditDecisions.auditRunId })
      .from(historicalArchiveAuditDecisions)
      .where(
        and(
          eq(
            historicalArchiveAuditDecisions.resultAttemptId,
            candidate.resultAttemptId,
          ),
          eq(historicalArchiveAuditDecisions.sourceArchiveId, sourceArchiveId),
          eq(
            historicalArchiveAuditDecisions.reducerVersionId,
            reducerVersionId,
          ),
        ),
      )
      .orderBy(asc(historicalArchiveAuditDecisions.createdAt))
      .limit(1);
    if (existingDecision) {
      return {
        runId: existingDecision.auditRunId,
        reducerVersionId,
        enqueued: 0,
      };
    }

    const [activeReceipt] = await tx
      .select({ runId: resultInterpretationBackfillItems.runId })
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
            resultInterpretationBackfillItems.resultAttemptId,
            candidate.resultAttemptId,
          ),
          eq(
            resultInterpretationBackfillItems.sourceArchiveId,
            sourceArchiveId,
          ),
          inArray(resultInterpretationBackfillItems.state, [
            "pending",
            "hydrating",
          ]),
          // A stale child left by a cancelled/failed audit is not an active
          // execution receipt.  A later explicit three-ID invocation must be
          // able to create its own receipt rather than returning a run that
          // cannot legally drain it.
          eq(resultInterpretationBackfillRuns.state, "running"),
          eq(
            resultInterpretationBackfillRuns.reducerVersionId,
            reducerVersionId,
          ),
          sql`${resultInterpretationBackfillRuns.scope} ->> 'contract' = ${HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT}`,
          sql`${resultInterpretationBackfillRuns.scope} ->> 'canonicalSelection' = 'forbidden'`,
          sql`${resultInterpretationBackfillRuns.scope} ->> 'physicalRecovery' = 'record-only'`,
          sql`${resultInterpretationBackfillRuns.scope} ->> 'campaignMutation' = 'forbidden'`,
          sql`${resultInterpretationBackfillRuns.scope} ->> 'rawEvidenceImmutable' = 'true'`,
          sql`${resultInterpretationBackfillRuns.scope} #>> '{exactSource,resultId}' = ${exactSource.resultId}`,
          sql`${resultInterpretationBackfillRuns.scope} #>> '{exactSource,resultAttemptId}' = ${exactSource.resultAttemptId}`,
          sql`${resultInterpretationBackfillRuns.scope} #>> '{exactSource,sourceArchiveId}' = ${sourceArchiveId}`,
        ),
      )
      .limit(1);
    if (activeReceipt) {
      return { runId: activeReceipt.runId, reducerVersionId, enqueued: 1 };
    }

    const now = new Date();
    const [run] = await tx
      .insert(resultInterpretationBackfillRuns)
      .values({
        reducerVersionId,
        state: "running",
        scope: {
          contract: HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT,
          exactSource,
          rawEvidenceImmutable: true,
          canonicalSelection: "forbidden",
          physicalRecovery: "record-only",
          campaignMutation: "forbidden",
        },
        summary: {
          discovered: 1,
          enqueued: 1,
          canonicalSelectionsCreated: 0,
          resultProjectionsUpdated: 0,
          physicalRecoveryActionsCreated: 0,
          campaignMutations: 0,
        },
        requestedBy:
          opts.requestedBy?.trim() ||
          "system:historical-released-evidence-audit",
        startedAt: now,
      })
      .returning({ id: resultInterpretationBackfillRuns.id });
    if (!run) {
      throw new Error(
        "historical released-evidence audit run was not persisted",
      );
    }
    await tx.insert(resultInterpretationBackfillItems).values({
      runId: run.id,
      resultId: candidate.resultId,
      resultAttemptId: candidate.resultAttemptId,
      sourceArchiveId,
      state: "pending",
      nextAttemptAt: now,
    });
    return { runId: run.id, reducerVersionId, enqueued: 1 };
  });
}

async function claimNextArchiveInterpretationItem(
  db: DB,
  runId: string,
): Promise<ClaimedBackfillItem | null> {
  const now = new Date();
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
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
      // Backfill workers may be resumed by multiple scheduler instances. A
      // lock wait here used to let two drainers serialise on the same receipt;
      // skip it and claim another independent immutable archive instead.
      .for("update", { skipLocked: true });
    if (!item) return null;

    // Preserve the audit lifecycle lock order (child -> parent run).  The
    // runner activation CAS prevents a terminal parent from being revived,
    // but a cancellation/source-owner cascade can still land after activation
    // and before this child is leased.  Lock and re-prove the parent here so
    // that transition leaves the child pending rather than starting reducer
    // I/O under a terminal run.  `withArchiveInterpretationClaimLease` repeats
    // the audit-specific proof immediately before engine I/O for the narrow
    // post-commit race with a later cancellation.
    const [runnableRun] = await tx
      .select({ id: resultInterpretationBackfillRuns.id })
      .from(resultInterpretationBackfillRuns)
      .where(
        and(
          eq(resultInterpretationBackfillRuns.id, item.runId),
          inArray(
            resultInterpretationBackfillRuns.state,
            ARCHIVE_INTERPRETATION_CLAIMABLE_RUN_STATES,
          ),
        ),
      )
      .limit(1)
      .for("update");
    if (!runnableRun) return null;

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
  /** The exact physical source job, not the currently deployed reducer,
   * authorizes a v2 cross-job continuation.  A missing marker is immutable
   * legacy v1 provenance. */
  cleanCycleRecoveryPolicyVersion: "adaptive-clean-tail-v2" | null;
}> {
  const [attempt] = await db
    .select({
      evidencePayload: resultAttempts.evidencePayload,
      cleanCycleRecoveryPolicyVersion: sql<string | null>`
        CASE
          WHEN ${simJobs.requestPayload} ->>
            'cleanCycleRecoveryPolicyVersion' = 'adaptive-clean-tail-v2'
          THEN 'adaptive-clean-tail-v2'
          ELSE NULL
        END
      `,
    })
    .from(resultAttempts)
    .leftJoin(simJobs, eq(simJobs.id, resultAttempts.simJobId))
    .where(
      and(
        eq(resultAttempts.id, item.resultAttemptId),
        eq(resultAttempts.resultId, item.resultId),
      ),
    )
    .limit(1);
  const fidelity = archiveBackfillFidelity(attempt?.evidencePayload);
  const cleanCycleRecoveryPolicyVersion =
    attempt?.cleanCycleRecoveryPolicyVersion === "adaptive-clean-tail-v2"
      ? "adaptive-clean-tail-v2"
      : null;
  if (!fidelity) {
    return {
      fidelity: null,
      pointer: null,
      reason: "attempt no longer has explicit URANS fidelity provenance",
      cleanCycleRecoveryPolicyVersion,
    };
  }
  if (!item.sourceArchiveId) {
    return {
      fidelity,
      pointer: null,
      reason: "attempt has no immutable raw evidence archive",
      cleanCycleRecoveryPolicyVersion,
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
        eq(solverEvidenceArchives.state, "current"),
      ),
    )
    .limit(1);
  if (!archive) {
    return {
      fidelity,
      pointer: null,
      reason: "the planned immutable archive is no longer available",
      cleanCycleRecoveryPolicyVersion,
    };
  }
  const pointer = archivePointerForBackfill(archive.blob);
  return {
    fidelity,
    pointer: pointer.pointer,
    reason: pointer.reason,
    cleanCycleRecoveryPolicyVersion,
  };
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

async function renewArchiveInterpretationClaim(
  db: DB,
  item: ClaimedBackfillItem,
): Promise<boolean> {
  const [renewed] = await db
    .update(resultInterpretationBackfillItems)
    .set({
      claimExpiresAt: new Date(Date.now() + ARCHIVE_INTERPRETATION_LEASE_MS),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(resultInterpretationBackfillItems.id, item.id),
        eq(resultInterpretationBackfillItems.state, "hydrating"),
        eq(resultInterpretationBackfillItems.claimToken, item.claimToken),
        sql`${resultInterpretationBackfillItems.claimExpiresAt} > clock_timestamp()`,
      ),
    )
    .returning({ id: resultInterpretationBackfillItems.id });
  return renewed != null;
}

/**
 * A historical audit may renew its lease only while its persisted run still
 * names this one exact immutable source. The generic receipt renewal is safe
 * for the live publication queue; it is intentionally not sufficient for an
 * audit because a malformed/broadened JSON scope must not keep GCS reduction
 * work alive after the initial check.
 */
async function renewHistoricalArchiveInterpretationClaim(
  db: DB,
  input: {
    item: ClaimedBackfillItem;
    exactSource: ExactArchiveInterpretationSource;
    reducerVersionId: string;
  },
): Promise<boolean> {
  const sourceArchiveId = input.item.sourceArchiveId;
  if (
    sourceArchiveId == null ||
    sourceArchiveId !== input.exactSource.sourceArchiveId
  ) {
    return false;
  }
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [ownedChild] = await tx
      .select({ runId: resultInterpretationBackfillItems.runId })
      .from(resultInterpretationBackfillItems)
      .where(
        and(
          eq(resultInterpretationBackfillItems.id, input.item.id),
          eq(resultInterpretationBackfillItems.runId, input.item.runId),
          eq(resultInterpretationBackfillItems.resultId, input.item.resultId),
          eq(
            resultInterpretationBackfillItems.resultAttemptId,
            input.item.resultAttemptId,
          ),
          eq(
            resultInterpretationBackfillItems.sourceArchiveId,
            sourceArchiveId,
          ),
          eq(resultInterpretationBackfillItems.state, "hydrating"),
          eq(
            resultInterpretationBackfillItems.claimToken,
            input.item.claimToken,
          ),
          sql`${resultInterpretationBackfillItems.claimExpiresAt} > clock_timestamp()`,
        ),
      )
      .limit(1)
      .for("update");
    if (!ownedChild) return false;
    const [auditRun] = await tx
      .select({
        reducerVersionId: resultInterpretationBackfillRuns.reducerVersionId,
        state: resultInterpretationBackfillRuns.state,
        scope: resultInterpretationBackfillRuns.scope,
      })
      .from(resultInterpretationBackfillRuns)
      .where(eq(resultInterpretationBackfillRuns.id, ownedChild.runId))
      .limit(1)
      .for("update");
    if (
      !auditRun ||
      auditRun.state !== "running" ||
      auditRun.reducerVersionId !== input.reducerVersionId ||
      !historicalReleasedArchiveAuditScopeMatchesExactSource({
        scope: auditRun.scope,
        exactSource: input.exactSource,
      })
    ) {
      return false;
    }
    return renewArchiveInterpretationClaim(tx, input.item);
  });
}

class ArchiveInterpretationClaimLostError extends Error {
  constructor() {
    super("archive interpretation claim was lost while reducer I/O was active");
  }
}

/** Keep the child receipt leased while the reducer streams a potentially
 * large authenticated archive. If renewal fails, this worker must not stage,
 * select, or settle a receipt now owned by another worker. */
async function withArchiveInterpretationClaimLease<T>(
  db: DB,
  item: ClaimedBackfillItem,
  work: () => Promise<T>,
  renewClaim: () => Promise<boolean> = () =>
    renewArchiveInterpretationClaim(db, item),
): Promise<T> {
  let lost = false;
  let renewing = false;
  const renew = async () => {
    if (lost || renewing) return;
    renewing = true;
    try {
      if (!(await renewClaim())) lost = true;
    } catch {
      lost = true;
    } finally {
      renewing = false;
    }
  };
  await renew();
  if (lost) throw new ArchiveInterpretationClaimLostError();
  const timer = setInterval(() => {
    void renew();
  }, ARCHIVE_INTERPRETATION_LEASE_RENEW_MS);
  timer.unref?.();
  try {
    const value = await work();
    if (lost) throw new ArchiveInterpretationClaimLostError();
    return value;
  } finally {
    clearInterval(timer);
  }
}

type SettleClaimValues = {
  state: Exclude<BackfillItemState, "hydrating">;
  lastError?: string | null;
  resultInterpretationId?: string | null;
  nextAttemptAt?: Date;
  /**
   * A machine-readable handoff is persisted in the separate mutable
   * scheduler ledger atomically with this receipt. It is deliberately not
   * encoded in `lastError`: text is diagnostic; the action row is the only
   * executable source of recovery intent.
   */
  recoveryHandoff?: ArchiveBackfillRecoveryHandoff | null;
  /** Historical released-evidence audits append a decision receipt instead
   * of creating a scheduler recovery action. */
  historicalAuditDecision?: HistoricalArchiveAuditDecisionInput | null;
};

/**
 * Settle a claimed child inside an existing transaction. Historical audit
 * staging calls this directly so the staged interpretation, final child
 * lifecycle, and immutable decision commit as one forensic fact. The public
 * wrapper below retains the ordinary single-call transaction boundary.
 */
async function settleClaimInTransaction(
  tx: DB,
  item: ClaimedBackfillItem,
  values: SettleClaimValues,
): Promise<boolean> {
  if (values.recoveryHandoff && values.historicalAuditDecision) {
    throw new Error(
      "one archive receipt cannot create both a live recovery action and a historical audit decision",
    );
  }
  let state = values.state;
  let lastError = values.lastError ?? null;
  let resultInterpretationId = values.resultInterpretationId ?? null;
  let recoveryHandoff = values.recoveryHandoff ?? null;
  let historicalAuditDecision = values.historicalAuditDecision ?? null;

  if (recoveryHandoff) {
    if (
      recoveryHandoff.resultId !== item.resultId ||
      recoveryHandoff.resultAttemptId !== item.resultAttemptId ||
      recoveryHandoff.sourceArchiveId !== item.sourceArchiveId
    ) {
      throw new Error(
        "archive recovery handoff must be pinned to the receipt's exact result, attempt, and source archive",
      );
    }
    // Normal recovery work may continue across a RANS → preliminary-URANS
    // generation change, but never after the result has been deliberately
    // released from publication. Lock the result before the child receipt
    // to match publication stage/selection order and make the handoff
    // insertion an all-or-nothing live-generation decision.
    const [liveResult] = await tx
      .select({ currentResultAttemptId: results.currentResultAttemptId })
      .from(results)
      .where(eq(results.id, item.resultId))
      .limit(1)
      .for("update");
    const exactLivePrecalcOwner =
      liveResult?.currentResultAttemptId == null &&
      liveResult != null &&
      (await hasExactLivePrecalcPublicationWinner(tx, {
        resultId: item.resultId,
        resultAttemptId: item.resultAttemptId,
        lockForPublication: true,
      }));
    if (
      !liveResult ||
      (!liveResult.currentResultAttemptId && !exactLivePrecalcOwner)
    ) {
      state = "terminal_failure";
      lastError =
        "archive publication source was released before its recovery handoff could be recorded; no solver work was scheduled from historical evidence";
      recoveryHandoff = null;
    }
  }

  if (historicalAuditDecision) {
    // Historical audit settlement owns the child first. Its no-publication
    // proof must cover the exact attempt/archive/blob at the same time as
    // the decision insert; otherwise a corrected/superseded GCS source
    // could receive a durable verdict for bytes no longer being audited.
    const [ownedChild] = await tx
      .select({ id: resultInterpretationBackfillItems.id })
      .from(resultInterpretationBackfillItems)
      .where(
        and(
          eq(resultInterpretationBackfillItems.id, item.id),
          eq(resultInterpretationBackfillItems.state, "hydrating"),
          eq(resultInterpretationBackfillItems.claimToken, item.claimToken),
          sql`${resultInterpretationBackfillItems.claimExpiresAt} > clock_timestamp()`,
        ),
      )
      .limit(1)
      .for("update");
    if (!ownedChild) return false;

    const [releasedResult] = await tx
      .select({
        id: results.id,
        currentResultAttemptId: results.currentResultAttemptId,
        currentResultInterpretationId: results.currentResultInterpretationId,
        currentCanonicalSelectionId: results.currentCanonicalSelectionId,
      })
      .from(results)
      .where(eq(results.id, item.resultId))
      .limit(1)
      .for("update");

    const lockedSource =
      releasedResult &&
      releasedResult.currentResultAttemptId == null &&
      releasedResult.currentResultInterpretationId == null &&
      releasedResult.currentCanonicalSelectionId == null &&
      item.sourceArchiveId
        ? await lockHistoricalReleasedArchiveAuditCandidate(tx, {
            resultId: item.resultId,
            resultAttemptId: item.resultAttemptId,
            sourceArchiveId: item.sourceArchiveId,
          })
        : null;
    const [auditRun] = lockedSource
      ? await tx
          .select({
            reducerVersionId: resultInterpretationBackfillRuns.reducerVersionId,
            scope: resultInterpretationBackfillRuns.scope,
          })
          .from(resultInterpretationBackfillRuns)
          .where(eq(resultInterpretationBackfillRuns.id, item.runId))
          .limit(1)
          .for("update")
      : [undefined];
    const auditAuthorityValid =
      auditRun != null &&
      auditRun.reducerVersionId === historicalAuditDecision.reducerVersionId &&
      historicalReleasedArchiveAuditScopeMatchesExactSource({
        scope: auditRun.scope,
        exactSource: {
          resultId: item.resultId,
          resultAttemptId: item.resultAttemptId,
          sourceArchiveId: item.sourceArchiveId!,
        },
      });
    if (!lockedSource || !auditAuthorityValid) {
      // An authority/source change is not a scientific terminal reducer
      // outcome. Keep the child in the operational failed state so the
      // audit-receipt fence can reserve terminal scientific states for a
      // real immutable decision.
      state = "failed";
      lastError =
        "historical audit incomplete: its exact released GCS source or no-publication authority changed before decision settlement";
      resultInterpretationId = null;
      historicalAuditDecision = null;
    }
  }

  const historicalAuditDecisionId = historicalAuditDecision
    ? randomUUID()
    : null;
  if (
    historicalAuditDecision &&
    historicalAuditDecision.resultInterpretationId !== resultInterpretationId
  ) {
    throw new Error(
      "historical audit decision must reference the exact interpretation staged by its child receipt",
    );
  }

  const [settled] = await tx
    .update(resultInterpretationBackfillItems)
    .set({
      state,
      claimToken: null,
      claimExpiresAt: null,
      lastError,
      resultInterpretationId,
      historicalAuditDecisionId,
      historicalAuditReducerState:
        historicalAuditDecision?.reducerState ?? null,
      historicalAuditInputEvidenceSignature:
        historicalAuditDecision?.inputEvidenceSignature ?? null,
      nextAttemptAt: values.nextAttemptAt ?? new Date(),
    })
    .where(
      and(
        eq(resultInterpretationBackfillItems.id, item.id),
        eq(resultInterpretationBackfillItems.state, "hydrating"),
        eq(resultInterpretationBackfillItems.claimToken, item.claimToken),
        sql`${resultInterpretationBackfillItems.claimExpiresAt} > clock_timestamp()`,
      ),
    )
    .returning({ id: resultInterpretationBackfillItems.id });
  if (!settled) return false;

  if (recoveryHandoff) {
    await upsertArchiveBackfillRecoveryAction(tx, recoveryHandoff);
  }
  if (historicalAuditDecision) {
    const [insertedDecision] = await tx
      .insert(historicalArchiveAuditDecisions)
      .values({
        id: historicalAuditDecisionId!,
        auditRunId: item.runId,
        resultId: item.resultId,
        resultAttemptId: item.resultAttemptId,
        sourceArchiveId: item.sourceArchiveId!,
        reducerVersionId: historicalAuditDecision.reducerVersionId,
        inputEvidenceSignature: historicalAuditDecision.inputEvidenceSignature,
        reducerState: historicalAuditDecision.reducerState,
        resultInterpretationId: historicalAuditDecision.resultInterpretationId,
        advisoryContinuationAction:
          historicalAuditDecision.advisoryContinuationAction,
        advisoryTailPeriods: historicalAuditDecision.advisoryTailPeriods,
        diagnostics: historicalAuditDecision.diagnostics,
      })
      .onConflictDoNothing()
      .returning({ id: historicalArchiveAuditDecisions.id });
    if (!insertedDecision) {
      // The reverse child pointer now names a freshly allocated UUID. Never
      // point it at an unrelated pre-existing decision just to make a replay
      // look successful: rolling back this transaction preserves the exact
      // claim for an explicit operator retry instead.
      throw new Error(
        "historical audit decision conflicts with an existing immutable receipt",
      );
    }
  }
  return true;
}

/**
 * Persist one exact archive-recovery instruction. Conflict updates are a
 * narrowly-defined migration enrichment only: an inert action may fill an
 * absent authenticated tail and/or v2 policy marker, but can never replace a
 * field once it has been recorded or alter an action owned by the scheduler.
 */
export async function upsertArchiveBackfillRecoveryAction(
  tx: DB,
  handoff: ArchiveBackfillRecoveryHandoff,
): Promise<void> {
  // The recovery identity is the immutable physical generation plus source
  // archive and fidelity. A later backfill pass must never reset a
  // claimed/routed action or create another CFD generation. The one safe
  // legacy upgrade is a still-pending, target-less action that predates
  // either field: it can adopt the authenticated reducer instruction before
  // any scheduler ownership exists.
  await tx.execute(sql`
        INSERT INTO result_interpretation_recovery_actions (
          result_id,
          result_attempt_id,
          source_archive_id,
          input_evidence_signature,
          fidelity,
          requested_action,
          corrective_tail_periods,
          clean_cycle_recovery_policy_version,
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
          ${handoff.cleanCycleRecoveryPolicyVersion},
          'pending',
          ${`archive reducer ${handoff.reducerState}`}
        )
        ON CONFLICT (result_attempt_id, source_archive_id, fidelity) DO UPDATE
        SET corrective_tail_periods = CASE
              WHEN result_interpretation_recovery_actions.corrective_tail_periods IS NULL
                AND EXCLUDED.corrective_tail_periods IS NOT NULL
              THEN EXCLUDED.corrective_tail_periods
              ELSE result_interpretation_recovery_actions.corrective_tail_periods
            END,
            clean_cycle_recovery_policy_version = CASE
              WHEN result_interpretation_recovery_actions.clean_cycle_recovery_policy_version IS NULL
                AND EXCLUDED.clean_cycle_recovery_policy_version = 'adaptive-clean-tail-v2'
              THEN EXCLUDED.clean_cycle_recovery_policy_version
              ELSE result_interpretation_recovery_actions.clean_cycle_recovery_policy_version
            END,
            decision_reason = EXCLUDED.decision_reason,
            "updatedAt" = now()
        WHERE result_interpretation_recovery_actions.state = 'pending'
          AND result_interpretation_recovery_actions.target_urans_request_id IS NULL
          AND result_interpretation_recovery_actions.target_verify_queue_id IS NULL
          AND result_interpretation_recovery_actions.requested_action = EXCLUDED.requested_action
          AND (
            (
              result_interpretation_recovery_actions.corrective_tail_periods IS NULL
              AND EXCLUDED.corrective_tail_periods IS NOT NULL
            )
            OR (
              result_interpretation_recovery_actions.clean_cycle_recovery_policy_version IS NULL
              AND EXCLUDED.clean_cycle_recovery_policy_version = 'adaptive-clean-tail-v2'
            )
          )
  `);
}

async function settleClaim(
  db: DB,
  item: ClaimedBackfillItem,
  values: SettleClaimValues,
): Promise<boolean> {
  return db.transaction(async (rawTx) =>
    settleClaimInTransaction(rawTx as unknown as DB, item, values),
  );
}

/**
 * An explicit released-history audit has no generic background retry owner.
 * If its exact released-source authority disappears after reducer I/O, leave
 * no hydrating receipt behind. This deliberately locks and settles only the
 * original token holder; a reclaimed successor is never overwritten. Unlike
 * ordinary settlement, an expired-but-unreclaimed audit lease can still be
 * closed here because the row lock serializes that decision with a new claim.
 */
async function failHistoricalAuditClaimIfStillOwned(
  db: DB,
  item: ClaimedBackfillItem,
  lastError: string,
): Promise<boolean> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const sourcePredicate = item.sourceArchiveId
      ? eq(
          resultInterpretationBackfillItems.sourceArchiveId,
          item.sourceArchiveId,
        )
      : isNull(resultInterpretationBackfillItems.sourceArchiveId);
    const [ownedChild] = await tx
      .select({ id: resultInterpretationBackfillItems.id })
      .from(resultInterpretationBackfillItems)
      .where(
        and(
          eq(resultInterpretationBackfillItems.id, item.id),
          eq(resultInterpretationBackfillItems.runId, item.runId),
          eq(resultInterpretationBackfillItems.resultId, item.resultId),
          eq(
            resultInterpretationBackfillItems.resultAttemptId,
            item.resultAttemptId,
          ),
          sourcePredicate,
          eq(resultInterpretationBackfillItems.state, "hydrating"),
          eq(resultInterpretationBackfillItems.claimToken, item.claimToken),
          isNull(resultInterpretationBackfillItems.historicalAuditDecisionId),
          isNull(resultInterpretationBackfillItems.historicalAuditReducerState),
          isNull(
            resultInterpretationBackfillItems.historicalAuditInputEvidenceSignature,
          ),
        ),
      )
      .limit(1)
      .for("update");
    if (!ownedChild) return false;

    const [settled] = await tx
      .update(resultInterpretationBackfillItems)
      .set({
        state: "failed",
        claimToken: null,
        claimExpiresAt: null,
        lastError,
        nextAttemptAt: new Date(),
      })
      .where(
        and(
          eq(resultInterpretationBackfillItems.id, item.id),
          eq(resultInterpretationBackfillItems.state, "hydrating"),
          eq(resultInterpretationBackfillItems.claimToken, item.claimToken),
          isNull(resultInterpretationBackfillItems.historicalAuditDecisionId),
        ),
      )
      .returning({ id: resultInterpretationBackfillItems.id });
    return settled != null;
  });
}

/**
 * A released-history audit is deliberately a single explicit execution, not a
 * queue item that a generic drainer can later revive.  Its operational failure
 * path must therefore be able to close the original claimed receipt even when
 * the lease elapsed during an engine/GCS read.  A different claimant is still
 * protected by `failHistoricalAuditClaimIfStillOwned`'s exact-token lock.
 */
async function settleHistoricalAuditDecisionOrFail(
  db: DB,
  item: ClaimedBackfillItem,
  values: SettleClaimValues,
): Promise<boolean> {
  const settled = await settleClaim(db, item, values);
  if (settled) return true;
  await failHistoricalAuditClaimIfStillOwned(
    db,
    item,
    "historical audit authority or lease was lost before immutable decision settlement; no audit decision recorded",
  );
  return false;
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
  recoveryProgress?: ArchiveCleanCycleRecoveryProgress | null;
  /** Exact source-job provenance. The reducer response alone cannot widen a
   * historical continuation because reducer code is deliberately replayable
   * against legacy archives. */
  sourceCleanCycleRecoveryPolicyVersion: "adaptive-clean-tail-v2" | null;
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
  const cleanCycleRecoveryPolicyVersion =
    input.state === "continuation_required" &&
    input.recoveryProgress != null &&
    "policyVersion" in input.recoveryProgress &&
    input.sourceCleanCycleRecoveryPolicyVersion === "adaptive-clean-tail-v2"
      ? input.recoveryProgress.policyVersion
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
    cleanCycleRecoveryPolicyVersion,
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
 * Historical released-evidence audit decisions deliberately preserve the
 * reducer's actual outcome without turning it into a scheduler command.  The
 * only action-shaped field is a bounded advisory for the exact saved case;
 * it is not a request, queue item, or promise and a later explicit promotion
 * must re-authorize it through the normal recovery controller.
 */
function historicalArchiveAuditDecisionForReduction(input: {
  reduction: ArchiveCleanCycleReductionResponse;
  recoveryProgress: ArchiveCleanCycleRecoveryProgress | null;
}): HistoricalArchiveAuditDecisionDraft {
  if (!SHA256.test(input.reduction.inputEvidenceSignature)) {
    throw new EngineError(
      "archive reducer returned an invalid historical-audit evidence signature",
      undefined,
      "archive_reduction_contract_drift",
    );
  }
  const continuation = input.reduction.state === "continuation_required";
  const advisoryTailPeriods = continuation
    ? archiveRecommendedAdditionalPeriods(
        input.recoveryProgress?.recommendedAdditionalPeriods ??
          input.reduction.diagnostics.recommendedAdditionalPeriods,
      )
    : null;
  return {
    inputEvidenceSignature: input.reduction.inputEvidenceSignature,
    reducerState: input.reduction.state,
    advisoryContinuationAction: continuation ? "continue_exact_case" : null,
    advisoryTailPeriods,
    diagnostics: {
      ...input.reduction.diagnostics,
      historicalAudit: {
        contract: HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT,
        canonicalSelection: "forbidden",
        physicalRecovery: "record-only",
        campaignMutation: "forbidden",
      },
    },
  };
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
  mode: ArchiveInterpretationRunMode;
  /** Persisted audit scope, parsed once before claiming so a malformed or
   * broad run cannot spend GCS/engine I/O. */
  historicalAuditExactSource?: ExactArchiveInterpretationSource;
  /** Parent publication receipt pinned by the queue claim. The child token is
   * added below immediately before any durable reducer mutation. */
  publicationClaim?: ArchivePublicationClaimFence;
  /** Pinned at queue admission; never resolve the currently deployed reducer
   * while draining historical work. */
  reducerVersionId: string;
}): Promise<void> {
  if (opts.mode === "queue_publication" && !opts.publicationClaim) {
    throw new ArchivePublicationClaimLostError();
  }
  const authority: ArchiveInterpretationStageAuthority =
    opts.mode === "queue_publication"
      ? {
          kind: "queue_publication",
          publicationClaim: {
            ...opts.publicationClaim!,
            backfillItemId: opts.item.id,
            backfillClaimToken: opts.item.claimToken,
          },
        }
      : {
          kind: "historical_released_audit",
          auditClaim: {
            backfillItemId: opts.item.id,
            backfillClaimToken: opts.item.claimToken,
          },
        };
  if (
    authority.kind === "queue_publication" &&
    (!authority.publicationClaim.queueItemId ||
      !authority.publicationClaim.queueClaimToken)
  ) {
    throw new ArchivePublicationClaimLostError();
  }
  if (authority.kind === "historical_released_audit") {
    const exactSource = opts.historicalAuditExactSource;
    if (
      !exactSource ||
      exactSource.resultId !== opts.item.resultId ||
      exactSource.resultAttemptId !== opts.item.resultAttemptId ||
      exactSource.sourceArchiveId !== opts.item.sourceArchiveId
    ) {
      await failHistoricalAuditClaimIfStillOwned(
        opts.db,
        opts.item,
        "historical audit receipt does not match its exact persisted source; no archive reduction was performed",
      );
      return;
    }
    // Avoid even a read-only GCS reduction if an operator/canonical workflow
    // has made this result live again since this receipt was admitted.  The
    // stage boundary repeats the proof under the result lock; this early gate
    // is merely an I/O and clarity guard and never changes the result.
    if (!opts.item.sourceArchiveId) {
      await failHistoricalAuditClaimIfStillOwned(
        opts.db,
        opts.item,
        "historical audit receipt has no immutable source archive; no archive reduction was performed",
      );
      return;
    }
    let stillReleased: ArchiveInterpretationBackfillCandidate | null;
    try {
      stillReleased = await discoverHistoricalReleasedArchiveAuditCandidate(
        opts.db,
        {
          resultId: opts.item.resultId,
          resultAttemptId: opts.item.resultAttemptId,
          sourceArchiveId: opts.item.sourceArchiveId,
        },
      );
    } catch (error) {
      await failHistoricalAuditClaimIfStillOwned(
        opts.db,
        opts.item,
        `historical audit source proof failed before reducer I/O; no audit decision recorded: ${limitedError(error)}`,
      );
      return;
    }
    if (!stillReleased) {
      await failHistoricalAuditClaimIfStillOwned(
        opts.db,
        opts.item,
        "historical audit source is no longer an exact released, verified GCS result; no archive reduction was performed",
      );
      return;
    }
  }
  let source: Awaited<ReturnType<typeof archivePointerForClaim>>;
  try {
    source = await archivePointerForClaim(opts.db, opts.item);
  } catch (error) {
    if (opts.mode === "historical_released_audit") {
      await failHistoricalAuditClaimIfStillOwned(
        opts.db,
        opts.item,
        `historical audit immutable archive lookup failed before reducer I/O; no audit decision recorded: ${limitedError(error)}`,
      );
      return;
    }
    throw error;
  }
  if (!source.fidelity || !source.pointer) {
    // The reducer never produced an authenticated missing-evidence response,
    // so a released-history audit cannot turn this local pointer failure into
    // a scientific immutable verdict. Record an operationally failed audit;
    // the live publication queue retains its normal missing-evidence state.
    if (opts.mode === "historical_released_audit") {
      await failHistoricalAuditClaimIfStillOwned(
        opts.db,
        opts.item,
        `historical audit immutable archive pointer is unavailable; no audit decision recorded: ${source.reason ?? "raw archive evidence is unavailable"}`,
      );
    } else {
      await settleClaim(opts.db, opts.item, {
        state: "missing_evidence",
        lastError: source.reason ?? "raw archive evidence is unavailable",
      });
    }
    return;
  }
  try {
    const reduction = await withArchiveInterpretationClaimLease(
      opts.db,
      opts.item,
      () =>
        opts.engine.reduceRemoteEvidenceCleanCycles({
          remote: source.pointer!,
          fidelity: source.fidelity!,
        }),
      authority.kind === "historical_released_audit"
        ? () =>
            renewHistoricalArchiveInterpretationClaim(opts.db, {
              item: opts.item,
              exactSource: opts.historicalAuditExactSource!,
              reducerVersionId: opts.reducerVersionId,
            })
        : undefined,
    );
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
      const historicalAuditDecisionDraft =
        authority.kind === "historical_released_audit"
          ? historicalArchiveAuditDecisionForReduction({
              reduction,
              recoveryProgress,
            })
          : null;
      const missingEvidenceSettlement = {
        state: "missing_evidence",
        lastError: reducerSummary(reduction.state, reduction.diagnostics),
        historicalAuditDecision: historicalAuditDecisionDraft
          ? {
              ...historicalAuditDecisionDraft,
              reducerVersionId: opts.reducerVersionId,
              resultInterpretationId: null,
            }
          : null,
      } as const;
      if (authority.kind === "historical_released_audit") {
        await settleHistoricalAuditDecisionOrFail(
          opts.db,
          opts.item,
          missingEvidenceSettlement,
        );
      } else {
        await settleClaim(opts.db, opts.item, missingEvidenceSettlement);
      }
      return;
    }

    // A cadence-free rerun recommendation has no scientific coefficient
    // interpretation to stage.  The work receipt is the durable record of
    // that fact.  If the reducer did obtain a certificate, stage it so its
    // failed/unclean cycles remain inspectable without ever becoming canonical.
    const stageable =
      reduction.state !== "rerun_required" ||
      hasCycleCertificate(reduction.point);
    const historicalAuditDecisionDraft =
      authority.kind === "historical_released_audit"
        ? historicalArchiveAuditDecisionForReduction({
            reduction,
            recoveryProgress,
          })
        : null;
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
    const historicalAuditFinalize =
      authority.kind === "historical_released_audit" && stageable
        ? async ({
            db,
            interpretation,
          }: {
            db: DB;
            interpretation: {
              id: string;
              state: string;
              regime: string;
            };
          }) =>
            settleClaimInTransaction(db, opts.item, {
              state,
              resultInterpretationId: interpretation.id,
              lastError:
                state === "reduced"
                  ? null
                  : reducerSummary(reduction.state, reduction.diagnostics),
              historicalAuditDecision: {
                ...historicalAuditDecisionDraft!,
                reducerVersionId: opts.reducerVersionId,
                resultInterpretationId: interpretation.id,
              },
            })
        : undefined;
    const staged = stageable
      ? await stageArchiveResultInterpretation({
          db: opts.db,
          resultId: opts.item.resultId,
          resultAttemptId: opts.item.resultAttemptId,
          sourceArchiveId: opts.item.sourceArchiveId!,
          reducerVersionId: opts.reducerVersionId,
          backfillRunId: opts.item.runId,
          authority,
          inputEvidenceSignature: reduction.inputEvidenceSignature,
          historicalAuditDecision: historicalAuditDecisionDraft ?? undefined,
          historicalAuditFinalize,
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

    if (authority.kind === "historical_released_audit" && stageable) {
      // `stageArchiveResultInterpretation` just committed the interpretation,
      // terminal claimed child, and immutable decision as one transaction.
      // Never run a second generic settlement against that final child.
      return;
    }
    // An accepted reduction may now become the canonical coefficient
    // interpretation, but only through the selector's exact-current-attempt
    // and current-archive proof.  No raw attempt/result scalar is updated.
    // If a concurrent solve changed the result generation, the append-only
    // interpretation stays useful historical evidence and this receipt still
    // settles as reduced without retargeting the newer solve.
    const selectionOutcome =
      state === "reduced" && authority.kind === "queue_publication"
        ? await selectAcceptedArchiveInterpretation({
            db: opts.db,
            resultId: opts.item.resultId,
            resultAttemptId: opts.item.resultAttemptId,
            sourceArchiveId: opts.item.sourceArchiveId!,
            interpretationId: staged?.id ?? null,
            backfillRunId: opts.item.runId,
            reducerVersionId: opts.reducerVersionId,
            publicationClaim: authority.publicationClaim,
          })
        : null;
    if (
      selectionOutcome === "selected" ||
      selectionOutcome === "already_selected"
    ) {
      const [resultScope] = await opts.db
        .select({
          airfoilId: results.airfoilId,
          simulationPresetRevisionId: results.simulationPresetRevisionId,
        })
        .from(results)
        .where(eq(results.id, opts.item.resultId))
        .limit(1);
      if (resultScope?.simulationPresetRevisionId) {
        // Rebuild immediately so a successful archive-publication reduction
        // becomes visible through the same fit cache used by public/admin
        // views. Historical audits never enter this branch.
        await refreshPolarCacheForRevision(
          opts.db,
          resultScope.airfoilId,
          resultScope.simulationPresetRevisionId,
        );
      }
      // The archive pointer is now the current, accepted PRECALC scientific
      // interpretation.  Close the exact physical recovery owner before the
      // next admission check observes its stale blocked/critical ledger.
      // This helper re-proves exact attempt/archive ownership and resolves
      // only incidents owned by that obligation.
      await satisfyPrecalcObligationFromAcceptedResult(
        opts.db,
        opts.item.resultId,
      );
      // Publication is a non-solver state transition. Recompute only the
      // campaign cells that reference this result so a raw archive-pending
      // counter cannot linger as rejected/blocked after an accepted selection.
      await refreshCampaignProgressForResultIds(opts.db, [opts.item.resultId]);
    }
    const recoveryHandoff =
      authority.kind === "queue_publication" &&
      archiveReducerNeedsRecoveryHandoff(reduction.state)
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
            recoveryProgress,
            sourceCleanCycleRecoveryPolicyVersion:
              source.cleanCycleRecoveryPolicyVersion,
          })
        : null;
    // Stageable audit outcomes persist their immutable decision in the same
    // transaction as the interpretation.  Only a cadence-free rerun has no
    // interpretation to stage, so it settles its record-only receipt here.
    const historicalAuditDecision =
      authority.kind === "historical_released_audit" && !stageable
        ? {
            ...historicalAuditDecisionDraft!,
            reducerVersionId: opts.reducerVersionId,
            resultInterpretationId: null,
          }
        : null;
    const terminalSettlement = {
      // The historical child receipt remains a completed reduction even when
      // a later reducer release owns canonical publication. The parent queue
      // records the operational supersession; this table's enum deliberately
      // preserves only scientific reducer outcomes.
      state,
      resultInterpretationId: staged?.id ?? null,
      lastError:
        state === "reduced" &&
        selectionOutcome !== "superseded_by_newer_reducer"
          ? null
          : selectionOutcome === "superseded_by_newer_reducer"
            ? "archive reduction completed under an older reducer release"
            : reducerSummary(reduction.state, reduction.diagnostics),
      recoveryHandoff,
      historicalAuditDecision,
    } as const;
    if (authority.kind === "historical_released_audit") {
      await settleHistoricalAuditDecisionOrFail(
        opts.db,
        opts.item,
        terminalSettlement,
      );
    } else {
      await settleClaim(opts.db, opts.item, terminalSettlement);
    }
  } catch (error) {
    if (
      opts.mode === "historical_released_audit" &&
      (error instanceof ArchiveInterpretationClaimLostError ||
        error instanceof ArchivePublicationClaimLostError ||
        error instanceof HistoricalArchiveAuditClaimLostError)
    ) {
      // A lost audit lease often means that its exact source was promoted live
      // or the audit scope changed while reducer I/O was in flight. If another
      // claimant really took over, the token fence leaves it untouched. If not,
      // close this one-shot audit as an operational failure rather than leaving
      // a permanent hydrating receipt with no decision.
      await failHistoricalAuditClaimIfStillOwned(
        opts.db,
        opts.item,
        `historical audit authority or lease was lost after reducer I/O; no audit decision recorded: ${limitedError(error)}`,
      );
      return;
    }
    if (
      error instanceof ArchiveInterpretationClaimLostError ||
      error instanceof ArchivePublicationClaimLostError ||
      error instanceof HistoricalArchiveAuditClaimLostError
    ) {
      // The successor owns the receipt now. Do not overwrite its lease or
      // settle it based on this stale reducer response.
      return;
    }
    const message = limitedError(error);
    const answeredArchiveProblem =
      error instanceof EngineError &&
      (error.status === 409 || error.status === 422);
    const contractDrift =
      error instanceof EngineError &&
      error.code === "archive_reduction_contract_drift";
    // `EngineClient.json` deliberately leaves native fetch failures as their
    // original TypeError so submit lifecycle can distinguish an engine that
    // never answered from one that returned an HTTP error.  This archive
    // reader needs the same connection-failure contract: a plain `fetch
    // failed` must not turn its first exact child into permanent evidence
    // history. Restrict the helper to native transport-shaped errors here so
    // a local programming TypeError cannot masquerade as an engine outage.
    const nativeFetchConnectionFailure =
      isEngineConnectionFailure(error) &&
      error instanceof TypeError &&
      /(?:fetch failed|network(?:\s+error)?|load failed)/i.test(error.message);
    const transient =
      error instanceof EngineTimeoutError ||
      nativeFetchConnectionFailure ||
      (error instanceof EngineError &&
        !answeredArchiveProblem &&
        !contractDrift &&
        (error.status == null || error.status >= 500));
    if (answeredArchiveProblem) {
      // A 409/422 transport response is an engine/API diagnosis, not an
      // authenticated reducer fact with an evidence signature. A live queue
      // may record it as missing evidence, but a released-history audit must
      // not manufacture a scientific `missing_evidence` decision from that
      // response.
      if (opts.mode === "historical_released_audit") {
        await failHistoricalAuditClaimIfStillOwned(
          opts.db,
          opts.item,
          `historical audit reducer returned an unauthenticated archive problem; no audit decision recorded: ${message}`,
        );
      } else {
        await settleClaim(opts.db, opts.item, {
          state: "missing_evidence",
          lastError: message,
        });
      }
      return;
    }
    if (opts.mode === "historical_released_audit" && transient) {
      // A released-history audit may only be started through an explicit,
      // three-ID operator invocation.  Do not turn a temporary engine/GCS
      // error into a pending item that a generic scheduler can resume later.
      await failHistoricalAuditClaimIfStillOwned(
        opts.db,
        opts.item,
        `historical audit reducer failed; no automatic retry: ${message}`,
      );
      return;
    }
    if (
      archiveInterpretationMayRetry({
        mode: opts.mode,
        transient,
        attemptCount: opts.item.attemptCount,
      })
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
    if (opts.mode === "historical_released_audit") {
      await failHistoricalAuditClaimIfStillOwned(opts.db, opts.item, message);
    } else {
      await settleClaim(opts.db, opts.item, {
        state: "failed",
        lastError: message,
      });
    }
  }
}

async function readRun(
  db: DB,
  runId: string,
): Promise<{
  id: string;
  reducerVersionId: string;
  state: "planned" | "running" | "completed" | "failed" | "cancelled";
  scope: Record<string, unknown>;
} | null> {
  const [run] = await db
    .select({
      id: resultInterpretationBackfillRuns.id,
      reducerVersionId: resultInterpretationBackfillRuns.reducerVersionId,
      state: resultInterpretationBackfillRuns.state,
      scope: resultInterpretationBackfillRuns.scope,
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
    scope: isRecord(run.scope) ? run.scope : {},
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

async function countHistoricalAuditDecisionsForRun(
  db: DB,
  runId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(historicalArchiveAuditDecisions)
    .where(eq(historicalArchiveAuditDecisions.auditRunId, runId));
  return row?.count ?? 0;
}

async function refreshRunSummary(
  db: DB,
  runId: string,
  opts: {
    processed: number;
    /** A cancelled/failed run must remain terminal even if its retained child
     * counters would otherwise look drained. */
    forceTerminalState?: "failed" | "cancelled";
  } = { processed: 0 },
): Promise<ArchiveInterpretationBackfillReport> {
  const [counts, selections, run, historicalDecisionCount] = await Promise.all([
    countRunItems(db, runId),
    countRunCanonicalSelections(db, runId),
    db
      .select({
        scope: resultInterpretationBackfillRuns.scope,
        state: resultInterpretationBackfillRuns.state,
      })
      .from(resultInterpretationBackfillRuns)
      .where(eq(resultInterpretationBackfillRuns.id, runId))
      .limit(1)
      .then(([row]) => row ?? null),
    countHistoricalAuditDecisionsForRun(db, runId),
  ]);
  const open = (counts.pending ?? 0) + (counts.hydrating ?? 0);
  const itemCount = Object.values(counts).reduce(
    (total, count) => total + count,
    0,
  );
  let historicalAudit = false;
  let historicalAuditContractMalformed = false;
  try {
    historicalAudit =
      run != null &&
      archiveInterpretationBackfillRunMode(run.scope) ===
        "historical_released_audit";
  } catch {
    // A malformed historical contract is incomplete by definition. Do not
    // report a drained mutable receipt as a successful immutable audit.
    historicalAudit = true;
    historicalAuditContractMalformed = true;
  }
  // 0106 permits a source-owner cascade to retain the audit run after its
  // exact child and immutable decision disappear. That run is useful forensic
  // history, but it did not complete an audit. Treat it as non-executable
  // failure rather than letting the otherwise-equal 0 decisions / 0 children
  // counters look like a successful no-op.
  const historicalAuditHasNoChildReceipt = historicalAudit && itemCount === 0;
  const auditIncomplete =
    historicalAudit &&
    open === 0 &&
    (historicalAuditContractMalformed ||
      historicalAuditHasNoChildReceipt ||
      historicalDecisionCount !== itemCount);
  const historicalAuditIncompleteReason = !historicalAudit
    ? null
    : historicalAuditContractMalformed
      ? "historical audit contract is malformed; no completed immutable audit can be reported"
      : historicalAuditHasNoChildReceipt
        ? "historical audit has no child execution receipt; its exact source may have been owner-cascaded before an immutable decision was recorded"
        : historicalDecisionCount !== itemCount
          ? "historical audit child receipts and immutable decisions do not have one-to-one completion"
          : null;
  const state = archiveInterpretationBackfillSummaryState({
    // A concurrent cancellation/failure is authoritative even if this
    // caller reached summary refresh through a stale runnable read.
    terminalState:
      opts.forceTerminalState ??
      (run?.state === "failed" || run?.state === "cancelled"
        ? run.state
        : undefined),
    auditIncomplete,
    openItems: open,
  });
  const report = (
    persistedState: ArchiveInterpretationBackfillReport["state"],
  ): ArchiveInterpretationBackfillReport => ({
    runId,
    state: persistedState,
    processed: opts.processed,
    counts,
    canonicalSelectionsCreated: selections.events,
    resultProjectionsUpdated: selections.currentProjections,
  });

  // A terminal run is forensic history. In particular, an owner-cascade
  // trigger writes the exact reason that its source disappeared; a later
  // observer must not replace that summary with its own generic zero-count
  // explanation or move `completedAt` forward.
  const alreadyTerminal =
    opts.forceTerminalState ??
    (run?.state === "failed" || run?.state === "cancelled"
      ? run.state
      : undefined);
  if (alreadyTerminal) return report(alreadyTerminal);

  const now = new Date();
  // Do not trust the state observed above as a write authority. A source-owner
  // cascade or operator cancellation can acquire the row between the summary
  // reads and this update. PostgreSQL re-checks this non-terminal predicate
  // after any row lock wait, so a terminal writer either wins before us (we do
  // no write) or after us (it becomes the final terminal state). `completed`
  // remains eligible so a malformed audit can self-correct to failed; only
  // failed/cancelled forensic records are immutable to this observer.
  const [updated] = await db
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
        ...(historicalAudit
          ? {
              historicalAuditDecisions: historicalDecisionCount,
              historicalAuditIncomplete: auditIncomplete,
              ...(historicalAuditIncompleteReason
                ? { historicalAuditIncompleteReason }
                : {}),
            }
          : {}),
      },
    })
    .where(
      and(
        eq(resultInterpretationBackfillRuns.id, runId),
        inArray(resultInterpretationBackfillRuns.state, [
          "planned",
          "running",
          "completed",
        ]),
      ),
    )
    .returning({ id: resultInterpretationBackfillRuns.id });
  if (updated) return report(state);

  // The CAS missed a terminal transition. Read it once for a truthful report;
  // never write a freshly derived summary over that terminal fact.
  const current = await readRun(db, runId);
  return report(
    current?.state === "failed" || current?.state === "cancelled"
      ? current.state
      : state,
  );
}

function historicalArchiveAuditExecutionIsDisabled(
  mode: ArchiveInterpretationRunMode,
): boolean {
  return mode === "historical_released_audit";
}

/**
 * Resume one durable backfill run. Queue-publication receipts may be invoked
 * repeatedly, and their transient remote-store failures remain pending with a
 * timestamped retry. A released-history audit is intentionally not a generic
 * retry target: every execution must present the same exact three-ID source
 * authority as the explicit audit command that created its receipt.
 */
export async function runArchiveInterpretationBackfill(opts: {
  db: DB;
  engine: EngineClient;
  runId: string;
  maxItems?: number;
  /** Queue callers repeat the persisted run identity as a fence. This does
   * not compare against the newly deployed policy: old queue items must stay
   * scientifically reproducible after a reducer rollout. */
  expectedReducerVersionId?: string;
  /** Exact parent queue claim. It is mandatory for a persisted publication
   * run, and rejected for a persisted released-evidence audit run. */
  publicationClaim?: ArchivePublicationClaimFence;
  /** Required only for a persisted released-evidence audit run. Repeating
   * this exact immutable source prevents a generic worker from retrying an
   * operator audit after a transient reducer failure. */
  historicalAuditExactSource?: ExactArchiveInterpretationSource;
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
  const mode = archiveInterpretationBackfillRunMode(run.scope);
  if (historicalArchiveAuditExecutionIsDisabled(mode)) {
    throw new Error(
      "historical released-evidence audits are disabled and cannot execute; only accepted-current archive reduction may run",
    );
  }
  const historicalAuditExactSource =
    mode === "historical_released_audit"
      ? requireHistoricalReleasedArchiveAuditExecutionAuthority({
          scope: run.scope,
          exactSource: opts.historicalAuditExactSource,
        })
      : undefined;
  if (mode === "queue_publication" && opts.historicalAuditExactSource != null) {
    throw new Error(
      "queue-publication backfill must not carry released-evidence audit execution authority",
    );
  }
  if (run.state === "cancelled" || run.state === "failed") {
    return refreshRunSummary(opts.db, run.id, {
      processed: 0,
      forceTerminalState: run.state,
    });
  }
  if (
    opts.expectedReducerVersionId != null &&
    run.reducerVersionId !== opts.expectedReducerVersionId
  ) {
    throw new Error(
      `archive interpretation backfill run ${run.id} is pinned to reducer ${run.reducerVersionId}, not queue reducer ${opts.expectedReducerVersionId}`,
    );
  }
  if (mode === "queue_publication" && !opts.publicationClaim) {
    throw new Error(
      "archive publication backfill requires an exact active queue claim",
    );
  }
  if (mode === "historical_released_audit" && opts.publicationClaim) {
    throw new Error(
      "historical released-evidence audit must not carry a publication claim",
    );
  }
  if (run.state === "completed")
    return refreshRunSummary(opts.db, run.id, { processed: 0 });
  // A source-owner cascade can mark a retained audit run failed after this
  // initial read but before execution begins. Do not resurrect that terminal
  // forensic state merely to discover its missing child on the next summary
  // refresh; activation is a compare-and-swap over runnable states only.
  const [activated] = await opts.db
    .update(resultInterpretationBackfillRuns)
    .set({ state: "running", startedAt: new Date(), completedAt: null })
    .where(
      and(
        eq(resultInterpretationBackfillRuns.id, run.id),
        inArray(resultInterpretationBackfillRuns.state, ["planned", "running"]),
      ),
    )
    .returning({ id: resultInterpretationBackfillRuns.id });
  if (!activated) {
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
      mode,
      historicalAuditExactSource,
      publicationClaim: opts.publicationClaim,
      reducerVersionId: run.reducerVersionId,
    });
    processed += 1;
  }
  return refreshRunSummary(opts.db, run.id, { processed });
}
