/**
 * Read-only inventory for every attempt that explicitly declares FAST or
 * FINAL URANS fidelity. Execution state distinguishes completed evidence from
 * failed or still-active work without silently dropping any history.
 *
 * This is deliberately separate from the archive-reduction and archive-gap
 * recovery writers.  Those paths are necessarily strict: they admit only one
 * executable kind of evidence.  An operator inventory must instead retain
 * every explicit attempt and explain why a particular source is or is not
 * eligible for one of those later, separately-invoked paths.
 */
import {
  type DB,
  resultAttempts,
  solverEvidenceArchives,
  solverEvidenceBlobs,
  type SolverEvidenceBlob,
} from "@aerodb/db";
import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";

import { archivePointerForBackfill } from "./result-interpretation-backfill";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INVENTORY_CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/i;

export const DEFAULT_HISTORICAL_URANS_INVENTORY_LIMIT = 1_000;
export const MAX_HISTORICAL_URANS_INVENTORY_LIMIT = 10_000;

export type HistoricalUransFidelity = "urans_precalc" | "urans_full";
export type HistoricalUransStage = "FAST" | "FINAL";
export type HistoricalUransAttemptStatus =
  (typeof resultAttempts.$inferSelect)["status"];
export type HistoricalUransAttemptSource =
  (typeof resultAttempts.$inferSelect)["source"];

/**
 * An explicit FAST/FINAL fidelity payload can exist before a result is
 * published, or on a terminal failed attempt whose immutable archive is still
 * important forensic evidence.  Inventory is exhaustive across those states,
 * but only the completed solved state can be handed to an existing automatic
 * reducer/recovery workflow.
 */
export type HistoricalUransExecutionState =
  | "completed_solved"
  | "terminal_failed"
  | "awaiting_result_publication"
  | "queued_or_running"
  | "stale_execution";

export type HistoricalUransInventoryScope = {
  resultIds?: string[];
  resultAttemptIds?: string[];
  /** Opaque keyset cursor emitted by a prior inventory page. */
  cursor?: string | null;
  limit?: number;
};

export type HistoricalUransInventoryCursor = {
  createdAt: string;
  resultAttemptId: string;
};

export type NormalizedHistoricalUransInventoryScope = {
  resultIds: string[];
  resultAttemptIds: string[];
  cursor: HistoricalUransInventoryCursor | null;
  limit: number;
};

/** These states are mutually exclusive for each explicit URANS attempt.
 * `malformed_current_archive` includes an impossible archive/blob join gap as
 * well as a GCS row that fails the exact generation-pinned pointer contract. */
export type HistoricalUransArchiveState =
  | "no_current_archive"
  | "current_local_archive"
  | "malformed_current_archive"
  | "verified_gcs_archive";

/** Existing publication accepts URANS rows and one narrow legacy no-shedding
 * shape.  Inventory preserves incompatible historical rows rather than
 * guessing that they may be reduced or rerun. */
export type HistoricalUransProvenanceState =
  | "eligible_for_existing_handoffs"
  | "non_publishable_execution"
  | "missing_result_owner"
  | "incompatible_runtime_provenance";

/** This is only a recommendation for a separately invoked workflow. None of
 * these values creates a queue row, a recovery receipt, or a solver request. */
export type HistoricalUransInventoryPlan =
  | "archive_interpretation_backfill_plan"
  | "wait_for_archive_migration"
  | "investigate_archive_integrity"
  | "fast_archive_gap_recovery_plan"
  | "final_archive_gap_manual_review"
  | "investigate_attempt_provenance"
  | "investigate_terminal_failure"
  | "await_result_publication"
  | "await_execution"
  | "investigate_stale_execution";

export type HistoricalUransInventoryCandidate = {
  resultId: string | null;
  resultAttemptId: string;
  sourceArchiveId: string | null;
  createdAt: string;
  fidelity: HistoricalUransFidelity;
  stage: HistoricalUransStage;
  attemptStatus: HistoricalUransAttemptStatus;
  attemptSource: HistoricalUransAttemptSource;
  executionState: HistoricalUransExecutionState;
  regime: "rans" | "urans" | null;
  unsteady: boolean;
  provenanceState: HistoricalUransProvenanceState;
  archiveState: HistoricalUransArchiveState;
  archiveReason: string | null;
  plan: HistoricalUransInventoryPlan;
};

export type HistoricalUransInventoryStageSummary = {
  total: number;
  byExecutionState: Record<HistoricalUransExecutionState, number>;
  byArchiveState: Record<HistoricalUransArchiveState, number>;
  byPlan: Record<HistoricalUransInventoryPlan, number>;
};

export type HistoricalUransInventoryDiscovery = {
  /** `candidates` is an inventory page, never a scheduled work list. */
  candidates: HistoricalUransInventoryCandidate[];
  scope: NormalizedHistoricalUransInventoryScope;
  nextCursor: string | null;
  /** False means a follow-up read-only page is required before claiming the
   * selected scope has been fully inventoried. */
  complete: boolean;
  /** Counts are deliberately page-scoped. Consult `complete` before treating
   * them as the selected scope's all-history totals. */
  pageSummary: Record<
    HistoricalUransStage,
    HistoricalUransInventoryStageSummary
  >;
};

type ArchiveBlobForInventory = Pick<
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

function normaliseIds(values: string[] | undefined, label: string): string[] {
  const unique = [...new Set(values ?? [])].sort();
  for (const value of unique) {
    if (!UUID.test(value)) throw new Error(`${label} must contain UUID values`);
  }
  return unique;
}

export function encodeHistoricalUransInventoryCursor(
  cursor: HistoricalUransInventoryCursor,
): string {
  return `${cursor.createdAt}|${cursor.resultAttemptId}`;
}

/** The cursor retains the database's microsecond timestamp text. Converting it
 * through JavaScript Date would collapse rows created within one millisecond
 * and could make a subsequent inventory page skip or repeat an attempt. */
export function parseHistoricalUransInventoryCursor(
  raw: string,
): HistoricalUransInventoryCursor | null {
  const match = INVENTORY_CURSOR.exec(raw);
  if (!match) return null;
  const createdAt = match[1]!;
  const resultAttemptId = match[2]!;
  if (
    !UUID.test(resultAttemptId) ||
    Number.isNaN(new Date(createdAt).getTime())
  ) {
    return null;
  }
  return { createdAt, resultAttemptId };
}

export function normaliseHistoricalUransInventoryScope(
  scope: HistoricalUransInventoryScope = {},
): NormalizedHistoricalUransInventoryScope {
  const limit = scope.limit ?? DEFAULT_HISTORICAL_URANS_INVENTORY_LIMIT;
  if (
    !Number.isSafeInteger(limit) ||
    limit <= 0 ||
    limit > MAX_HISTORICAL_URANS_INVENTORY_LIMIT
  ) {
    throw new Error(
      `historical URANS inventory limit must be a positive integer no greater than ${MAX_HISTORICAL_URANS_INVENTORY_LIMIT}`,
    );
  }
  const cursor =
    scope.cursor == null
      ? null
      : parseHistoricalUransInventoryCursor(scope.cursor);
  if (scope.cursor != null && !cursor) {
    throw new Error("historical URANS inventory cursor is malformed");
  }
  return {
    resultIds: normaliseIds(scope.resultIds, "resultIds"),
    resultAttemptIds: normaliseIds(scope.resultAttemptIds, "resultAttemptIds"),
    cursor,
    limit,
  };
}

export function historicalUransStage(
  fidelity: HistoricalUransFidelity,
): HistoricalUransStage {
  return fidelity === "urans_precalc" ? "FAST" : "FINAL";
}

export function historicalUransExecutionState(input: {
  status: HistoricalUransAttemptStatus;
  source: HistoricalUransAttemptSource;
}): HistoricalUransExecutionState {
  if (input.status === "failed") return "terminal_failed";
  if (input.status === "stale") return "stale_execution";
  if (input.status === "done" && input.source === "solved") {
    return "completed_solved";
  }
  if (input.status === "done") return "awaiting_result_publication";
  return "queued_or_running";
}

export function historicalUransProvenanceState(input: {
  resultId: string | null;
  regime: "rans" | "urans" | null;
  unsteady: boolean;
  executionState?: HistoricalUransExecutionState;
}): HistoricalUransProvenanceState {
  if (
    input.executionState != null &&
    input.executionState !== "completed_solved"
  ) {
    return "non_publishable_execution";
  }
  if (!input.resultId) return "missing_result_owner";
  return input.regime === "urans" ||
    (input.regime === "rans" && input.unsteady === false)
    ? "eligible_for_existing_handoffs"
    : "incompatible_runtime_provenance";
}

export function historicalUransArchiveState(input: {
  sourceArchiveId: string | null;
  blob: ArchiveBlobForInventory | null;
}): { state: HistoricalUransArchiveState; reason: string | null } {
  if (!input.sourceArchiveId) {
    return {
      state: "no_current_archive",
      reason: "no current immutable evidence archive is registered",
    };
  }
  if (!input.blob) {
    return {
      state: "malformed_current_archive",
      reason: "current evidence archive has no readable blob identity",
    };
  }
  if (input.blob.backend !== "gcs") {
    return {
      state: "current_local_archive",
      reason:
        "current archive is local volume evidence, not generation-pinned GCS",
    };
  }
  const pointer = archivePointerForBackfill(input.blob);
  if (!pointer.pointer) {
    return {
      state: "malformed_current_archive",
      reason:
        pointer.reason ??
        "current GCS archive does not meet the pointer contract",
    };
  }
  return { state: "verified_gcs_archive", reason: null };
}

export function historicalUransInventoryPlan(input: {
  fidelity: HistoricalUransFidelity;
  provenanceState: HistoricalUransProvenanceState;
  archiveState: HistoricalUransArchiveState;
  executionState: HistoricalUransExecutionState;
}): HistoricalUransInventoryPlan {
  switch (input.executionState) {
    case "terminal_failed":
      return "investigate_terminal_failure";
    case "awaiting_result_publication":
      return "await_result_publication";
    case "queued_or_running":
      return "await_execution";
    case "stale_execution":
      return "investigate_stale_execution";
    case "completed_solved":
      break;
  }
  if (input.provenanceState !== "eligible_for_existing_handoffs") {
    return "investigate_attempt_provenance";
  }
  switch (input.archiveState) {
    case "verified_gcs_archive":
      return "archive_interpretation_backfill_plan";
    case "current_local_archive":
      return "wait_for_archive_migration";
    case "malformed_current_archive":
      return "investigate_archive_integrity";
    case "no_current_archive":
      return input.fidelity === "urans_precalc"
        ? "fast_archive_gap_recovery_plan"
        : "final_archive_gap_manual_review";
  }
}

function emptyStageSummary(): HistoricalUransInventoryStageSummary {
  return {
    total: 0,
    byExecutionState: {
      completed_solved: 0,
      terminal_failed: 0,
      awaiting_result_publication: 0,
      queued_or_running: 0,
      stale_execution: 0,
    },
    byArchiveState: {
      no_current_archive: 0,
      current_local_archive: 0,
      malformed_current_archive: 0,
      verified_gcs_archive: 0,
    },
    byPlan: {
      archive_interpretation_backfill_plan: 0,
      wait_for_archive_migration: 0,
      investigate_archive_integrity: 0,
      fast_archive_gap_recovery_plan: 0,
      final_archive_gap_manual_review: 0,
      investigate_attempt_provenance: 0,
      investigate_terminal_failure: 0,
      await_result_publication: 0,
      await_execution: 0,
      investigate_stale_execution: 0,
    },
  };
}

export function summarizeHistoricalUransInventory(
  candidates: readonly HistoricalUransInventoryCandidate[],
): Record<HistoricalUransStage, HistoricalUransInventoryStageSummary> {
  const summary = {
    FAST: emptyStageSummary(),
    FINAL: emptyStageSummary(),
  };
  for (const candidate of candidates) {
    const stage = summary[candidate.stage];
    stage.total += 1;
    stage.byExecutionState[candidate.executionState] += 1;
    stage.byArchiveState[candidate.archiveState] += 1;
    stage.byPlan[candidate.plan] += 1;
  }
  return summary;
}

/**
 * List every explicit FAST/FINAL URANS attempt in the requested page. This is
 * intentionally a left join: archive-free, local, and malformed archive rows
 * remain visible as first-class inventory outcomes instead of disappearing at
 * the executable archive-reduction admission boundary. We also deliberately
 * retain failed, queued, running, and stale attempts: those rows are not
 * automatic work candidates, but omitting their immutable evidence would make
 * a historical inventory falsely appear complete.
 */
export async function discoverHistoricalUransInventory(
  db: DB,
  opts: { scope?: HistoricalUransInventoryScope } = {},
): Promise<HistoricalUransInventoryDiscovery> {
  const scope = normaliseHistoricalUransInventoryScope(opts.scope);
  const cursorPredicate = scope.cursor
    ? or(
        sql`${resultAttempts.createdAt} > ${scope.cursor.createdAt}::timestamptz`,
        and(
          sql`${resultAttempts.createdAt} = ${scope.cursor.createdAt}::timestamptz`,
          gt(resultAttempts.id, scope.cursor.resultAttemptId),
        ),
      )
    : undefined;
  const rows = await db
    .select({
      resultId: resultAttempts.resultId,
      resultAttemptId: resultAttempts.id,
      fidelity: sql<HistoricalUransFidelity>`${resultAttempts.evidencePayload} ->> 'fidelity'`,
      attemptStatus: resultAttempts.status,
      attemptSource: resultAttempts.source,
      regime: resultAttempts.regime,
      unsteady: resultAttempts.unsteady,
      createdAt: sql<string>`to_char(${resultAttempts.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      sourceArchiveId: solverEvidenceArchives.id,
      blob: solverEvidenceBlobs,
    })
    .from(resultAttempts)
    .leftJoin(
      solverEvidenceArchives,
      and(
        eq(solverEvidenceArchives.resultId, resultAttempts.resultId),
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
        sql`${resultAttempts.evidencePayload} ->> 'fidelity' IN ('urans_precalc', 'urans_full')`,
        scope.resultIds.length
          ? inArray(resultAttempts.resultId, scope.resultIds)
          : undefined,
        scope.resultAttemptIds.length
          ? inArray(resultAttempts.id, scope.resultAttemptIds)
          : undefined,
        cursorPredicate,
      ),
    )
    .orderBy(asc(resultAttempts.createdAt), asc(resultAttempts.id))
    .limit(scope.limit + 1);

  const page = rows.slice(0, scope.limit);
  const candidates = page.map((row) => {
    const executionState = historicalUransExecutionState({
      status: row.attemptStatus,
      source: row.attemptSource,
    });
    const provenanceState = historicalUransProvenanceState({
      resultId: row.resultId,
      regime: row.regime,
      unsteady: row.unsteady,
      executionState,
    });
    const archive = historicalUransArchiveState({
      sourceArchiveId: row.sourceArchiveId,
      blob: row.blob,
    });
    const fidelity = row.fidelity;
    return {
      resultId: row.resultId,
      resultAttemptId: row.resultAttemptId,
      sourceArchiveId: row.sourceArchiveId,
      createdAt: row.createdAt,
      fidelity,
      stage: historicalUransStage(fidelity),
      attemptStatus: row.attemptStatus,
      attemptSource: row.attemptSource,
      executionState,
      regime: row.regime,
      unsteady: row.unsteady,
      provenanceState,
      archiveState: archive.state,
      archiveReason: archive.reason,
      plan: historicalUransInventoryPlan({
        fidelity,
        provenanceState,
        archiveState: archive.state,
        executionState,
      }),
    } satisfies HistoricalUransInventoryCandidate;
  });
  const hasMore = rows.length > scope.limit;
  const last = candidates[candidates.length - 1];
  return {
    candidates,
    scope,
    nextCursor:
      hasMore && last
        ? encodeHistoricalUransInventoryCursor({
            createdAt: last.createdAt,
            resultAttemptId: last.resultAttemptId,
          })
        : null,
    complete: !hasMore,
    pageSummary: summarizeHistoricalUransInventory(candidates),
  };
}
