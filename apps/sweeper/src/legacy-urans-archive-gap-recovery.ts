/**
 * Recovery for legacy FAST-URANS attempts that have no current verified GCS
 * archive.  This is intentionally not an archive interpretation path:
 * without an authenticated archive there is no trustworthy state to reduce or
 * continue.  The original attempt remains immutable and this module can only
 * route one ordinary, bounded fresh PRECALC owner through the existing
 * request/obligation ladder.
 */
import {
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
  legacyUransArchiveGapRecoveryActions,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  resultAttempts,
  results,
  simPrecalcObligationRequests,
  simPrecalcObligations,
  simUransRequests,
  simulationPresetRevisions,
  simulationPresets,
  type DB,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { solverImplementationIdForSetup } from "./build-request";

const ACTION_LEASE_MS = 5 * 60_000;
const ACTION_RETRY_MS = 60_000;
export const LEGACY_ARCHIVE_GAP_MAX_ACTIONS_PER_TICK = 8;
export const LEGACY_ARCHIVE_GAP_REQUESTED_BY =
  "legacy-archive-gap-fast-rerun";
export const LEGACY_ARCHIVE_GAP_SOURCE_CONDITION =
  "missing_current_verified_gcs_archive";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type LegacyArchiveGapActionState =
  | "pending"
  | "routing"
  | "fresh_rerun_routed"
  | "satisfied"
  | "blocked"
  | "cancelled";

type ClaimedLegacyArchiveGapAction = {
  id: string;
  resultId: string;
  resultAttemptId: string;
  targetUransRequestId: string | null;
  claimToken: string;
};

type LegacyArchiveGapSource = {
  resultId: string;
  resultAttemptId: string;
  airfoilId: string;
  revisionId: string;
  bcId: string;
  aoaDeg: number;
  hasCurrentArchive: boolean;
  hasCurrentVerifiedGcsArchive: boolean;
};

export type LegacyUransArchiveGapRecoveryScope = {
  resultIds?: string[];
  resultAttemptIds?: string[];
  /** Bounded operator planning scope; execution additionally requires exact
   * result-attempt ids so it cannot accidentally expand into a broad rerun. */
  limit?: number;
};

export type LegacyUransArchiveGapRecoveryCandidate = {
  resultId: string;
  resultAttemptId: string;
  airfoilId: string;
  revisionId: string;
  bcId: string;
  aoaDeg: number;
  /** A local/incomplete archive waits for GCS migration rather than reruns. */
  archiveState: "absent" | "unverified_or_local";
};

export type LegacyUransArchiveGapRecoveryDiscovery = {
  candidates: LegacyUransArchiveGapRecoveryCandidate[];
  scope: Required<LegacyUransArchiveGapRecoveryScope>;
};

export type LegacyUransArchiveGapRecoveryMaterialization = {
  discovery: LegacyUransArchiveGapRecoveryDiscovery;
  created: number;
  alreadyTracked: number;
  noLongerEligible: number;
};

function normalizedImplementationId(
  implementationId: string | null | undefined,
): string | null {
  if (!implementationId) return null;
  return implementationId === LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID
    ? OPENCFD_2406_SOLVER_IMPLEMENTATION_ID
    : implementationId;
}

function normaliseIds(values: string[] | undefined, label: string): string[] {
  const unique = [...new Set(values ?? [])].sort();
  for (const value of unique) {
    if (!UUID.test(value)) throw new Error(`${label} must contain UUID values`);
  }
  return unique;
}

export function normaliseLegacyUransArchiveGapRecoveryScope(
  scope: LegacyUransArchiveGapRecoveryScope = {},
): Required<LegacyUransArchiveGapRecoveryScope> {
  const limit = scope.limit ?? 64;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new Error(
      "legacy archive-gap recovery limit must be a positive integer no greater than 1000",
    );
  }
  return {
    resultIds: normaliseIds(scope.resultIds, "resultIds"),
    resultAttemptIds: normaliseIds(
      scope.resultAttemptIds,
      "resultAttemptIds",
    ),
    limit,
  };
}

/**
 * Pure routing policy used by the durable consumer and focused regressions.
 * A local/unverified archive is not proof for a continuation, but it is also
 * not permission to waste a fresh solve while the migration can still finish.
 */
export function legacyArchiveGapRouteDecision(input: {
  sourceIsExactFastUrans: boolean;
  archiveState: "absent" | "unverified_or_local" | "verified_gcs";
  targetPhysicalCell: boolean;
  targetImplementationId: string | null;
  /** A later exact FAST result has authenticated bytes but its clean-cycle-v3
   * reduction has not yet been selected.  It cannot satisfy this action, but
   * it must be reduced before a second physical owner is considered. */
  hasCurrentFastAwaitingReduction: boolean;
  hasAcceptedCurrentFast: boolean;
  hasOpenPrecalcOwner: boolean;
  withinFreshAttemptBudget: boolean;
}):
  | "fresh_rerun"
  | "satisfied"
  | "retry"
  | "blocked"
  | "cancelled" {
  if (!input.sourceIsExactFastUrans) return "blocked";
  if (input.archiveState === "verified_gcs") return "cancelled";
  if (input.archiveState === "unverified_or_local") return "retry";
  if (!input.targetPhysicalCell || !input.targetImplementationId) {
    return "blocked";
  }
  if (input.hasAcceptedCurrentFast) return "satisfied";
  if (input.hasCurrentFastAwaitingReduction) return "retry";
  if (input.hasOpenPrecalcOwner) return "retry";
  if (!input.withinFreshAttemptBudget) return "blocked";
  return "fresh_rerun";
}

/**
 * Read-only discovery.  It intentionally retains local/incomplete archive
 * rows in the plan so an operator can see why a source is deferred, but it
 * never treats them as missing bytes or creates work in planning mode.
 */
export async function discoverLegacyUransArchiveGapRecovery(
  db: DB,
  opts: { scope?: LegacyUransArchiveGapRecoveryScope } = {},
): Promise<LegacyUransArchiveGapRecoveryDiscovery> {
  const scope = normaliseLegacyUransArchiveGapRecoveryScope(opts.scope);
  const rows = (await db.execute(sql`
    SELECT
      result.id AS result_id,
      attempt.id AS result_attempt_id,
      attempt.airfoil_id,
      attempt.simulation_preset_revision_id AS revision_id,
      attempt.bc_id,
      attempt.aoa_deg::float8 AS aoa_deg,
      EXISTS (
        SELECT 1
        FROM solver_evidence_archives archive
        WHERE archive.result_id = result.id
          AND archive.result_attempt_id = attempt.id
          AND archive.state = 'current'
      ) AS has_current_archive,
      EXISTS (
        SELECT 1
        FROM solver_evidence_archives archive
        JOIN solver_evidence_blobs blob ON blob.id = archive.blob_id
        WHERE archive.result_id = result.id
          AND archive.result_attempt_id = attempt.id
          AND archive.state = 'current'
          AND blob.backend = 'gcs'
          AND blob.compression = 'zstd'
          AND blob.mime_type = 'application/zstd'
          AND blob."verifiedAt" IS NOT NULL
      ) AS has_current_verified_gcs_archive
    FROM result_attempts attempt
    JOIN results result
      ON result.id = attempt.result_id
     AND result.airfoil_id = attempt.airfoil_id
     AND result.bc_id = attempt.bc_id
     AND result.simulation_preset_revision_id IS NOT DISTINCT FROM
       attempt.simulation_preset_revision_id
     AND result.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
    WHERE attempt.method_key = 'openfoam.urans'
      AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
      AND attempt.source = 'solved'
      AND attempt.status IN ('done', 'failed')
      AND result.source = 'solved'
      AND result.status IN ('done', 'failed')
      AND attempt.simulation_preset_revision_id IS NOT NULL
      AND attempt.bc_id IS NOT NULL
      AND attempt.aoa_deg IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM solver_evidence_archives archive
        JOIN solver_evidence_blobs blob ON blob.id = archive.blob_id
        WHERE archive.result_id = result.id
          AND archive.result_attempt_id = attempt.id
          AND archive.state = 'current'
          AND blob.backend = 'gcs'
          AND blob.compression = 'zstd'
          AND blob.mime_type = 'application/zstd'
          AND blob."verifiedAt" IS NOT NULL
      )
      ${
        scope.resultIds.length
          ? sql`AND result.id = ANY(${sql`ARRAY[${sql.join(
              scope.resultIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})`
          : sql``
      }
      ${
        scope.resultAttemptIds.length
          ? sql`AND attempt.id = ANY(${sql`ARRAY[${sql.join(
              scope.resultAttemptIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})`
          : sql``
      }
    ORDER BY attempt."createdAt" ASC, attempt.id ASC
    LIMIT ${scope.limit}
  `)) as unknown as Array<{
    result_id: string;
    result_attempt_id: string;
    airfoil_id: string;
    revision_id: string;
    bc_id: string;
    aoa_deg: number;
    has_current_archive: boolean;
    has_current_verified_gcs_archive: boolean;
  }>;
  return {
    candidates: rows.flatMap((row) => {
      if (
        !row.revision_id ||
        !row.bc_id ||
        !Number.isFinite(Number(row.aoa_deg)) ||
        row.has_current_verified_gcs_archive
      ) {
        return [];
      }
      return [
        {
          resultId: row.result_id,
          resultAttemptId: row.result_attempt_id,
          airfoilId: row.airfoil_id,
          revisionId: row.revision_id,
          bcId: row.bc_id,
          aoaDeg: Number(row.aoa_deg),
          archiveState: row.has_current_archive
            ? "unverified_or_local"
            : "absent",
        },
      ];
    }),
    scope,
  };
}

/**
 * Materialize one leased action per exact immutable source attempt.  This does
 * not submit CFD.  The `NOT EXISTS` fence is repeated at the write boundary so
 * a GCS upload that completed after planning cannot turn into an unnecessary
 * rerun.
 */
export async function materializeLegacyUransArchiveGapRecoveryActions(opts: {
  db: DB;
  scope?: LegacyUransArchiveGapRecoveryScope;
  createdBy?: string;
}): Promise<LegacyUransArchiveGapRecoveryMaterialization> {
  const createdBy = opts.createdBy?.trim() || "legacy-archive-gap-planner";
  if (!createdBy) throw new Error("legacy archive-gap recovery creator is empty");
  const discovery = await discoverLegacyUransArchiveGapRecovery(opts.db, {
    scope: opts.scope,
  });
  let created = 0;
  let alreadyTracked = 0;
  let noLongerEligible = 0;
  for (const candidate of discovery.candidates) {
    const inserted = (await opts.db.execute(sql`
      INSERT INTO legacy_urans_archive_gap_recovery_actions (
        result_id,
        result_attempt_id,
        source_condition,
        fidelity,
        state,
        created_by
      )
      SELECT
        attempt.result_id,
        attempt.id,
        ${LEGACY_ARCHIVE_GAP_SOURCE_CONDITION},
        'urans_precalc',
        'pending',
        ${createdBy}
      FROM result_attempts attempt
      JOIN results result
        ON result.id = attempt.result_id
       AND result.airfoil_id = attempt.airfoil_id
       AND result.bc_id = attempt.bc_id
       AND result.simulation_preset_revision_id IS NOT DISTINCT FROM
         attempt.simulation_preset_revision_id
       AND result.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
      WHERE attempt.id = ${candidate.resultAttemptId}::uuid
        AND attempt.result_id = ${candidate.resultId}::uuid
        AND attempt.method_key = 'openfoam.urans'
        AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
        AND attempt.source = 'solved'
        AND attempt.status IN ('done', 'failed')
        AND result.source = 'solved'
        AND result.status IN ('done', 'failed')
        AND NOT EXISTS (
          SELECT 1
          FROM solver_evidence_archives archive
          JOIN solver_evidence_blobs blob ON blob.id = archive.blob_id
          WHERE archive.result_id = result.id
            AND archive.result_attempt_id = attempt.id
            AND archive.state = 'current'
            AND blob.backend = 'gcs'
            AND blob.compression = 'zstd'
            AND blob.mime_type = 'application/zstd'
            AND blob."verifiedAt" IS NOT NULL
        )
      ON CONFLICT (result_attempt_id) DO NOTHING
      RETURNING id
    `)) as unknown as Array<{ id: string }>;
    if (inserted.length) {
      created += 1;
      continue;
    }
    const [existing] = await opts.db
      .select({ id: legacyUransArchiveGapRecoveryActions.id })
      .from(legacyUransArchiveGapRecoveryActions)
      .where(
        eq(
          legacyUransArchiveGapRecoveryActions.resultAttemptId,
          candidate.resultAttemptId,
        ),
      )
      .limit(1);
    if (existing) alreadyTracked += 1;
    else noLongerEligible += 1;
  }
  return { discovery, created, alreadyTracked, noLongerEligible };
}

function retryAt(): Date {
  return new Date(Date.now() + ACTION_RETRY_MS);
}

async function claimNextLegacyArchiveGapAction(
  db: DB,
): Promise<ClaimedLegacyArchiveGapAction | null> {
  const token = randomUUID();
  const leaseUntil = new Date(Date.now() + ACTION_LEASE_MS);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const rows = (await tx.execute(sql`
      WITH candidate AS (
        SELECT action.id
        FROM legacy_urans_archive_gap_recovery_actions action
        WHERE (
          (action.state = 'pending' AND action.next_attempt_at <= now())
          OR (action.state = 'routing' AND action.claim_expires_at <= now())
        )
        ORDER BY action.next_attempt_at ASC, action."createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE legacy_urans_archive_gap_recovery_actions action
      SET state = 'routing',
          claim_token = ${token}::uuid,
          claim_expires_at = ${leaseUntil},
          attempt_count = action.attempt_count + 1,
          "updatedAt" = now()
      FROM candidate
      WHERE action.id = candidate.id
      RETURNING action.id,
                action.result_id,
                action.result_attempt_id,
                action.target_urans_request_id
    `)) as unknown as Array<{
      id: string;
      result_id: string;
      result_attempt_id: string;
      target_urans_request_id: string | null;
    }>;
    const row = rows[0];
    return row
      ? {
          id: row.id,
          resultId: row.result_id,
          resultAttemptId: row.result_attempt_id,
          targetUransRequestId: row.target_urans_request_id,
          claimToken: token,
        }
      : null;
  });
}

async function settleLegacyArchiveGapActionInTransaction(
  tx: DB,
  action: ClaimedLegacyArchiveGapAction,
  values: {
    state: Exclude<LegacyArchiveGapActionState, "routing">;
    targetUransRequestId?: string | null;
    decisionReason?: string | null;
    lastError?: string | null;
    nextAttemptAt?: Date;
  },
): Promise<boolean> {
  const [settled] = await tx
    .update(legacyUransArchiveGapRecoveryActions)
    .set({
      state: values.state,
      claimToken: null,
      claimExpiresAt: null,
      targetUransRequestId:
        values.targetUransRequestId === undefined
          ? action.targetUransRequestId
          : values.targetUransRequestId,
      decisionReason: values.decisionReason ?? null,
      lastError: values.lastError ?? null,
      nextAttemptAt: values.nextAttemptAt ?? new Date(),
    })
    .where(
      and(
        eq(legacyUransArchiveGapRecoveryActions.id, action.id),
        eq(legacyUransArchiveGapRecoveryActions.state, "routing"),
        eq(legacyUransArchiveGapRecoveryActions.claimToken, action.claimToken),
      ),
    )
    .returning({ id: legacyUransArchiveGapRecoveryActions.id });
  return Boolean(settled);
}

async function settleLegacyArchiveGapAction(
  db: DB,
  action: ClaimedLegacyArchiveGapAction,
  values: {
    state: Exclude<LegacyArchiveGapActionState, "routing">;
    targetUransRequestId?: string | null;
    decisionReason?: string | null;
    lastError?: string | null;
    nextAttemptAt?: Date;
  },
): Promise<boolean> {
  return settleLegacyArchiveGapActionInTransaction(db, action, values);
}

async function sourceForLegacyArchiveGapAction(
  db: DB,
  action: Pick<
    ClaimedLegacyArchiveGapAction,
    "id" | "resultId" | "resultAttemptId"
  >,
): Promise<LegacyArchiveGapSource | null> {
  const rows = (await db.execute(sql`
    SELECT
      result.id AS result_id,
      attempt.id AS result_attempt_id,
      attempt.airfoil_id,
      attempt.simulation_preset_revision_id AS revision_id,
      attempt.bc_id,
      attempt.aoa_deg::float8 AS aoa_deg,
      EXISTS (
        SELECT 1
        FROM solver_evidence_archives archive
        WHERE archive.result_id = result.id
          AND archive.result_attempt_id = attempt.id
          AND archive.state = 'current'
      ) AS has_current_archive,
      EXISTS (
        SELECT 1
        FROM solver_evidence_archives archive
        JOIN solver_evidence_blobs blob ON blob.id = archive.blob_id
        WHERE archive.result_id = result.id
          AND archive.result_attempt_id = attempt.id
          AND archive.state = 'current'
          AND blob.backend = 'gcs'
          AND blob.compression = 'zstd'
          AND blob.mime_type = 'application/zstd'
          AND blob."verifiedAt" IS NOT NULL
      ) AS has_current_verified_gcs_archive
    FROM legacy_urans_archive_gap_recovery_actions action
    JOIN result_attempts attempt
      ON attempt.id = action.result_attempt_id
     AND attempt.result_id = action.result_id
    JOIN results result
      ON result.id = attempt.result_id
     AND result.airfoil_id = attempt.airfoil_id
     AND result.bc_id = attempt.bc_id
     AND result.simulation_preset_revision_id IS NOT DISTINCT FROM
       attempt.simulation_preset_revision_id
     AND result.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
    WHERE action.id = ${action.id}::uuid
      AND action.result_id = ${action.resultId}::uuid
      AND action.result_attempt_id = ${action.resultAttemptId}::uuid
      AND action.source_condition = ${LEGACY_ARCHIVE_GAP_SOURCE_CONDITION}
      AND action.fidelity = 'urans_precalc'
      AND attempt.method_key = 'openfoam.urans'
      AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
      AND attempt.source = 'solved'
      AND attempt.status IN ('done', 'failed')
      AND result.source = 'solved'
      AND result.status IN ('done', 'failed')
    LIMIT 1
  `)) as unknown as Array<{
    result_id: string;
    result_attempt_id: string;
    airfoil_id: string;
    revision_id: string | null;
    bc_id: string | null;
    aoa_deg: number | null;
    has_current_archive: boolean;
    has_current_verified_gcs_archive: boolean;
  }>;
  const row = rows[0];
  if (
    !row ||
    !row.revision_id ||
    !row.bc_id ||
    row.aoa_deg == null ||
    !Number.isFinite(Number(row.aoa_deg))
  ) {
    return null;
  }
  return {
    resultId: row.result_id,
    resultAttemptId: row.result_attempt_id,
    airfoilId: row.airfoil_id,
    revisionId: row.revision_id,
    bcId: row.bc_id,
    aoaDeg: Number(row.aoa_deg),
    hasCurrentArchive: row.has_current_archive,
    hasCurrentVerifiedGcsArchive: row.has_current_verified_gcs_archive,
  };
}

/** A fresh rerun may target the current solver implementation, but it may
 * never cross a changed boundary-condition cell. */
async function targetForLegacyArchiveGapSource(
  db: DB,
  source: LegacyArchiveGapSource,
): Promise<{
  physicalCell: boolean;
  targetImplementationId: string | null;
}> {
  const [revision] = await db
    .select({
      snapshot: simulationPresetRevisions.snapshot,
      presetId: simulationPresetRevisions.presetId,
    })
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, source.revisionId))
    .limit(1);
  if (!revision) return { physicalCell: false, targetImplementationId: null };
  const snapshot = revision.snapshot as unknown as SimulationSetupSnapshot;
  let targetBcId = snapshot.preset.legacyBoundaryConditionId ?? null;
  if (!targetBcId) {
    const [preset] = await db
      .select({ legacyBoundaryConditionId: simulationPresets.legacyBoundaryConditionId })
      .from(simulationPresets)
      .where(eq(simulationPresets.id, revision.presetId))
      .limit(1);
    targetBcId = preset?.legacyBoundaryConditionId ?? null;
  }
  if (targetBcId !== source.bcId) {
    return { physicalCell: false, targetImplementationId: null };
  }
  try {
    return {
      physicalCell: true,
      targetImplementationId: normalizedImplementationId(
        solverImplementationIdForSetup(snapshot),
      ),
    };
  } catch {
    return { physicalCell: true, targetImplementationId: null };
  }
}

type CurrentFastGeneration =
  | {
      kind: "accepted";
      resultId: string;
      resultAttemptId: string;
    }
  | {
      kind: "awaiting_clean_cycle_reduction";
      resultId: string;
      resultAttemptId: string;
    }
  | null;

/**
 * A raw accepted classification is deliberately not enough to suppress a
 * legacy archive-gap repair.  The candidate has to prove the same thing the
 * public accepted-polar projection proves: current exact attempt, current
 * verified GCS Zstandard archive, and one selected archive-certified FAST
 * reduction (periodic clean-cycle or a no-shedding physical observation).
 *
 * If the archive exists but the reducer has not selected it yet, wait for the
 * reducer.  If the candidate is itself archive-less, it is not evidence that
 * the requested repair has already happened and therefore must not consume the
 * recovery action as "satisfied".
 */
export function currentFastGenerationRecoveryState(input: {
  hasCurrentVerifiedGcsArchive: boolean;
  hasSelectedCurrentArchiveFastInterpretation: boolean;
}): "accepted" | "awaiting_clean_cycle_reduction" | null {
  if (!input.hasCurrentVerifiedGcsArchive) return null;
  return input.hasSelectedCurrentArchiveFastInterpretation
    ? "accepted"
    : "awaiting_clean_cycle_reduction";
}

async function currentFastGeneration(
  tx: DB,
  source: LegacyArchiveGapSource,
  targetImplementationId: string | null,
): Promise<CurrentFastGeneration> {
  if (!targetImplementationId) return null;
  const rows = (await tx.execute(sql`
    SELECT
      result.id AS result_id,
      attempt.id AS result_attempt_id,
      attempt.solver_implementation_id AS attempt_solver_implementation_id,
      candidate_job.solver_implementation_id AS job_solver_implementation_id,
      candidate_job.bc_ids AS job_boundary_condition_ids,
      archive.id AS archive_id,
      archive.state AS archive_state,
      archive_blob.backend AS archive_blob_backend,
      archive_blob.compression AS archive_blob_compression,
      archive_blob.mime_type AS archive_blob_mime_type,
      archive_blob.bucket AS archive_blob_bucket,
      archive_blob.generation AS archive_blob_generation,
      archive_blob."verifiedAt" AS archive_blob_verified_at,
      interpretation.id AS interpretation_id,
      interpretation.state AS interpretation_state,
      interpretation.source AS interpretation_source,
      interpretation.regime AS interpretation_regime,
      interpretation.source_archive_id AS interpretation_source_archive_id,
      selected.id AS selected_id,
      selected.selection_namespace AS selected_namespace,
      selected.result_interpretation_id AS selected_interpretation_id,
      reducer.build_id AS reducer_build_id
    FROM results result
    JOIN result_attempts attempt
      ON attempt.result_id = result.id
     AND attempt.airfoil_id = result.airfoil_id
     AND attempt.bc_id = result.bc_id
     AND attempt.simulation_preset_revision_id =
         result.simulation_preset_revision_id
     AND attempt.aoa_deg = result.aoa_deg
    JOIN sim_jobs candidate_job ON candidate_job.id = attempt.sim_job_id
    LEFT JOIN solver_evidence_archives archive
      ON archive.result_id = result.id
     AND archive.result_attempt_id = attempt.id
     AND archive.state = 'current'
    LEFT JOIN solver_evidence_blobs archive_blob
      ON archive_blob.id = archive.blob_id
    LEFT JOIN result_interpretations interpretation
      ON interpretation.id = result.current_result_interpretation_id
     AND interpretation.result_id = result.id
     AND interpretation.result_attempt_id = attempt.id
    LEFT JOIN result_canonical_selections selected
      ON selected.id = result.current_canonical_selection_id
     AND selected.result_id = result.id
     AND selected.result_attempt_id = attempt.id
     AND selected.result_interpretation_id = interpretation.id
    LEFT JOIN result_reducer_versions reducer
      ON reducer.id = interpretation.reducer_version_id
    WHERE result.airfoil_id = ${source.airfoilId}::uuid
      AND result.simulation_preset_revision_id = ${source.revisionId}::uuid
      AND result.bc_id = ${source.bcId}::uuid
      AND result.aoa_deg = ${source.aoaDeg}
      AND result.status = 'done'
      AND result.source = 'solved'
      AND result.current_result_attempt_id = attempt.id
      AND attempt.status = 'done'
      AND attempt.source = 'solved'
      AND attempt.method_key = 'openfoam.urans'
      AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
    ORDER BY attempt."createdAt" DESC, attempt.id DESC
    LIMIT 64
  `)) as unknown as Array<{
    result_id: string;
    result_attempt_id: string;
    attempt_solver_implementation_id: string | null;
    job_solver_implementation_id: string | null;
    job_boundary_condition_ids: string[] | null;
    archive_id: string | null;
    archive_state: string | null;
    archive_blob_backend: string | null;
    archive_blob_compression: string | null;
    archive_blob_mime_type: string | null;
    archive_blob_bucket: string | null;
    archive_blob_generation: string | null;
    archive_blob_verified_at: Date | null;
    interpretation_id: string | null;
    interpretation_state: string | null;
    interpretation_source: string | null;
    interpretation_regime: string | null;
    interpretation_source_archive_id: string | null;
    selected_id: string | null;
    selected_namespace: string | null;
    selected_interpretation_id: string | null;
    reducer_build_id: string | null;
  }>;
  for (const candidate of rows) {
    const exactImplementationAndBoundary =
      normalizedImplementationId(candidate.attempt_solver_implementation_id) ===
        targetImplementationId &&
      normalizedImplementationId(candidate.job_solver_implementation_id) ===
        targetImplementationId &&
      Array.isArray(candidate.job_boundary_condition_ids) &&
      candidate.job_boundary_condition_ids.length === 1 &&
      candidate.job_boundary_condition_ids[0] === source.bcId;
    if (!exactImplementationAndBoundary) continue;

    const hasCurrentVerifiedGcsArchive =
      candidate.archive_id != null &&
      candidate.archive_state === "current" &&
      candidate.archive_blob_backend === "gcs" &&
      candidate.archive_blob_compression === "zstd" &&
      candidate.archive_blob_mime_type === "application/zstd" &&
      candidate.archive_blob_bucket != null &&
      candidate.archive_blob_bucket.trim() !== "" &&
      /^[1-9][0-9]{0,19}$/.test(candidate.archive_blob_generation ?? "") &&
      candidate.archive_blob_verified_at != null;
    const hasSelectedCurrentArchiveFastInterpretation =
      candidate.interpretation_id != null &&
      candidate.interpretation_state === "accepted" &&
      candidate.interpretation_source === "archive_backfill" &&
      candidate.interpretation_source_archive_id === candidate.archive_id &&
      candidate.selected_id != null &&
      candidate.selected_interpretation_id === candidate.interpretation_id &&
      candidate.reducer_build_id === "clean-cycle-v3" &&
      ((candidate.interpretation_regime === "periodic" &&
        candidate.selected_namespace === "archive-clean-cycle-v3") ||
        (candidate.interpretation_regime === "steady_equivalent" &&
          candidate.selected_namespace === "archive-no-shedding-v1"));
    const evidenceState = currentFastGenerationRecoveryState({
      hasCurrentVerifiedGcsArchive,
      hasSelectedCurrentArchiveFastInterpretation,
    });
    if (!evidenceState) continue;
    return {
      kind: evidenceState,
      resultId: candidate.result_id,
      resultAttemptId: candidate.result_attempt_id,
    };
  }
  return null;
}

async function ensureFreshPrecalcRoute(
  db: DB,
  action: ClaimedLegacyArchiveGapAction,
  source: LegacyArchiveGapSource,
  targetImplementationId: string | null,
): Promise<
  | { kind: "routed"; requestId: string }
  | { kind: "satisfied"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "retry"; reason: string }
> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // Same natural-cell lock as ordinary URANS request creation.  The action
    // cannot race an admin request or another recovery into a second physical
    // owner for this exact FAST cell.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`urans-request:${source.airfoilId}:${source.revisionId}:precalc`},
          0
        )
      )
    `);
    const [obligation] = await tx
      .select()
      .from(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, source.airfoilId),
          eq(simPrecalcObligations.revisionId, source.revisionId),
          eq(simPrecalcObligations.aoaDeg, source.aoaDeg),
        ),
      )
      .for("update")
      .limit(1);

    const current = await currentFastGeneration(
      tx,
      source,
      targetImplementationId,
    );
    const hasOpenPrecalcOwner = Boolean(
      obligation && ["pending", "running"].includes(obligation.state),
    );
    const withinFreshAttemptBudget =
      !obligation ||
      obligation.state !== "blocked" ||
      obligation.attemptCount < obligation.maxAttempts;
    const decision = legacyArchiveGapRouteDecision({
      sourceIsExactFastUrans: true,
      archiveState: "absent",
      targetPhysicalCell: true,
      targetImplementationId,
      hasCurrentFastAwaitingReduction:
        current?.kind === "awaiting_clean_cycle_reduction",
      hasAcceptedCurrentFast: current?.kind === "accepted",
      hasOpenPrecalcOwner,
      withinFreshAttemptBudget,
    });
    if (decision === "satisfied" && current?.kind === "accepted") {
      if (
        obligation &&
        !(
          obligation.state === "satisfied" &&
          obligation.sourceResultId === current.resultId &&
          obligation.sourceResultAttemptId === current.resultAttemptId &&
          obligation.lastOutcome === "accepted" &&
          obligation.lastError == null &&
          obligation.nextSubmitAt == null
        )
      ) {
        await tx
          .update(simPrecalcObligations)
          .set({
            state: "satisfied",
            sourceResultId: current.resultId,
            sourceResultAttemptId: current.resultAttemptId,
            lastOutcome: "accepted",
            lastError: null,
            nextSubmitAt: null,
            completedAt: new Date(),
          })
          .where(eq(simPrecalcObligations.id, obligation.id));
      }
      return {
        kind: "satisfied" as const,
        reason:
          "a later accepted preliminary generation already matches the current boundary-condition and solver implementation",
      };
    }
    if (decision === "retry") {
      return {
        kind: "retry" as const,
        reason:
          current?.kind === "awaiting_clean_cycle_reduction"
            ? "an exact current preliminary result has a verified GCS archive but is still awaiting its selected clean-cycle-v3 reduction"
            : "another physical preliminary generation currently owns this exact cell",
      };
    }
    if (decision === "blocked") {
      return {
        kind: "blocked" as const,
        reason:
          "fresh preliminary rerun would exceed this cell's existing physical-attempt budget",
      };
    }
    if (decision !== "fresh_rerun") {
      throw new Error("legacy archive-gap route reached an impossible decision");
    }

    const openRequests = await tx
      .select({ id: simUransRequests.id })
      .from(simUransRequests)
      .where(
        and(
          eq(simUransRequests.airfoilId, source.airfoilId),
          eq(simUransRequests.revisionId, source.revisionId),
          eq(simUransRequests.aoaDeg, source.aoaDeg),
          eq(simUransRequests.fidelity, "precalc"),
          inArray(simUransRequests.state, ["pending", "running"]),
        ),
      )
      .for("update");
    if (openRequests.length) {
      return {
        kind: "retry" as const,
        reason: "an open preliminary request claimed this exact cell while recovery routed",
      };
    }

    const [request] = await tx
      .insert(simUransRequests)
      .values({
        airfoilId: source.airfoilId,
        revisionId: source.revisionId,
        aoaDeg: source.aoaDeg,
        fidelity: "precalc",
        state: "pending",
        backgroundOwner: true,
        requestedBy: LEGACY_ARCHIVE_GAP_REQUESTED_BY,
        continueFromResultId: null,
        continueFromResultAttemptId: null,
        correctiveTailPeriods: null,
      })
      .returning({ id: simUransRequests.id });
    if (!request) {
      throw new Error("legacy archive-gap recovery could not create a PRECALC request");
    }

    let obligationId = obligation?.id;
    if (!obligation) {
      const [created] = await tx
        .insert(simPrecalcObligations)
        .values({
          airfoilId: source.airfoilId,
          revisionId: source.revisionId,
          aoaDeg: source.aoaDeg,
          sourceResultId: source.resultId,
          sourceResultAttemptId: source.resultAttemptId,
          state: "pending",
          backgroundOwner: true,
          lastOutcome: "legacy_archive_gap_fresh_rerun_pending",
        })
        .returning({ id: simPrecalcObligations.id });
      obligationId = created?.id;
    } else if (obligation.state !== "running") {
      const [reopened] = await tx
        .update(simPrecalcObligations)
        .set({
          state: "pending",
          sourceResultId: source.resultId,
          sourceResultAttemptId: source.resultAttemptId,
          backgroundOwner: true,
          nextSubmitAt: null,
          completedAt: null,
          lastOutcome: "legacy_archive_gap_fresh_rerun_pending",
          lastError: null,
        })
        .where(eq(simPrecalcObligations.id, obligation.id))
        .returning({ id: simPrecalcObligations.id });
      obligationId = reopened?.id;
    }
    if (!obligationId) {
      throw new Error("legacy archive-gap recovery could not create a PRECALC obligation");
    }
    await tx
      .insert(simPrecalcObligationRequests)
      .values({ obligationId, requestId: request.id })
      .onConflictDoNothing();
    const settled = await settleLegacyArchiveGapActionInTransaction(tx, action, {
      state: "fresh_rerun_routed",
      targetUransRequestId: request.id,
      decisionReason:
        "no current verified GCS archive remains; one ordinary fresh preliminary URANS request owns the exact physical cell",
    });
    if (!settled) {
      throw new Error(
        "legacy archive-gap recovery lost its lease while recording the PRECALC request owner",
      );
    }
    return { kind: "routed" as const, requestId: request.id };
  });
}

async function routeOneLegacyArchiveGapAction(
  db: DB,
  action: ClaimedLegacyArchiveGapAction,
): Promise<void> {
  if (action.targetUransRequestId != null) {
    await settleLegacyArchiveGapAction(db, action, {
      state: "blocked",
      decisionReason:
        "a pending legacy archive-gap action unexpectedly already names a physical request",
      lastError:
        "recovery refuses to overwrite an existing request receipt; preserve it for audit and create no second owner",
    });
    return;
  }
  const source = await sourceForLegacyArchiveGapAction(db, action);
  if (!source) {
    await settleLegacyArchiveGapAction(db, action, {
      state: "blocked",
      decisionReason: "source identity is no longer an exact terminal FAST-URANS attempt",
      lastError:
        "archive-gap recovery refuses to infer a fresh target from changed or incomplete provenance",
    });
    return;
  }
  if (source.hasCurrentVerifiedGcsArchive) {
    await settleLegacyArchiveGapAction(db, action, {
      state: "cancelled",
      decisionReason:
        "a current verified GCS archive is now registered for the source attempt",
      lastError: null,
    });
    return;
  }
  if (source.hasCurrentArchive) {
    await settleLegacyArchiveGapAction(db, action, {
      state: "pending",
      nextAttemptAt: retryAt(),
      decisionReason:
        "a current local or unverified archive exists; waiting for evidence migration before a fresh rerun",
      lastError: null,
    });
    return;
  }
  const target = await targetForLegacyArchiveGapSource(db, source);
  if (!target.physicalCell) {
    await settleLegacyArchiveGapAction(db, action, {
      state: "blocked",
      decisionReason:
        "the current revision resolves to a different boundary-condition cell than the legacy source",
      lastError:
        "fresh recovery is prohibited across a changed physical boundary condition",
    });
    return;
  }
  if (!target.targetImplementationId) {
    await settleLegacyArchiveGapAction(db, action, {
      state: "blocked",
      decisionReason:
        "the current revision has no resolvable solver implementation identity",
      lastError:
        "fresh recovery requires a target implementation identity before it can own a physical solve",
    });
    return;
  }

  const route = await ensureFreshPrecalcRoute(
    db,
    action,
    source,
    target.targetImplementationId,
  );
  if (route.kind === "routed") return;
  if (route.kind === "satisfied") {
    await settleLegacyArchiveGapAction(db, action, {
      state: "satisfied",
      decisionReason: route.reason,
    });
    return;
  }
  if (route.kind === "blocked") {
    await settleLegacyArchiveGapAction(db, action, {
      state: "blocked",
      decisionReason: route.reason,
    });
    return;
  }
  await settleLegacyArchiveGapAction(db, action, {
    state: "pending",
    nextAttemptAt: retryAt(),
    decisionReason: route.reason,
  });
}

/**
 * Keep routed receipts truthful without creating another fresh owner.  A
 * normal request/obligation retains responsibility for its two-physical-run
 * budget after this action has routed; this reconciliation only records the
 * terminal accepted or blocked outcome of that owned request.
 */
async function reconcileRoutedLegacyArchiveGapActions(
  db: DB,
  maxActions: number,
): Promise<number> {
  if (maxActions <= 0) return 0;
  const actions = await db
    .select({
      id: legacyUransArchiveGapRecoveryActions.id,
      resultId: legacyUransArchiveGapRecoveryActions.resultId,
      resultAttemptId: legacyUransArchiveGapRecoveryActions.resultAttemptId,
      targetUransRequestId:
        legacyUransArchiveGapRecoveryActions.targetUransRequestId,
    })
    .from(legacyUransArchiveGapRecoveryActions)
    .where(eq(legacyUransArchiveGapRecoveryActions.state, "fresh_rerun_routed"))
    .orderBy(asc(legacyUransArchiveGapRecoveryActions.updatedAt))
    .limit(maxActions);
  let reconciled = 0;
  for (const action of actions) {
    if (!action.targetUransRequestId) continue;
    const source = await sourceForLegacyArchiveGapAction(db, action);
    if (!source) continue;
    if (source.hasCurrentVerifiedGcsArchive) {
      await db
        .update(legacyUransArchiveGapRecoveryActions)
        .set({
          state: "cancelled",
          decisionReason:
            "a current verified GCS archive is now registered for the original source attempt",
          lastError: null,
        })
        .where(
          and(
            eq(legacyUransArchiveGapRecoveryActions.id, action.id),
            eq(
              legacyUransArchiveGapRecoveryActions.state,
              "fresh_rerun_routed",
            ),
            eq(
              legacyUransArchiveGapRecoveryActions.targetUransRequestId,
              action.targetUransRequestId,
            ),
          ),
        );
      reconciled += 1;
      continue;
    }
    const target = await targetForLegacyArchiveGapSource(db, source);
    if (!target.physicalCell || !target.targetImplementationId) continue;
    const current = await currentFastGeneration(
      db,
      source,
      target.targetImplementationId,
    );
    if (current?.kind === "accepted") {
      await db
        .update(legacyUransArchiveGapRecoveryActions)
        .set({
          state: "satisfied",
          decisionReason:
            "the routed ordinary preliminary request produced an accepted current-generation FAST result",
          lastError: null,
        })
        .where(
          and(
            eq(legacyUransArchiveGapRecoveryActions.id, action.id),
            eq(
              legacyUransArchiveGapRecoveryActions.state,
              "fresh_rerun_routed",
            ),
            eq(
              legacyUransArchiveGapRecoveryActions.targetUransRequestId,
              action.targetUransRequestId,
            ),
          ),
        );
      reconciled += 1;
      continue;
    }
    if (current?.kind === "awaiting_clean_cycle_reduction") {
      // The owned fresh request has finished with authentic bytes. Its normal
      // archive reducer is now the sole owner of coefficient publication; do
      // not mark it failed or create a second physical request while the
      // clean-cycle-v3 selection is pending.
      continue;
    }
    const [request] = await db
      .select({ state: simUransRequests.state })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, action.targetUransRequestId))
      .limit(1);
    if (!request || ["blocked", "cancelled"].includes(request.state)) {
      await db
        .update(legacyUransArchiveGapRecoveryActions)
        .set({
          state: "blocked",
          decisionReason:
            "the routed ordinary preliminary request reached a terminal state without an accepted current-generation FAST result",
          lastError:
            "the normal preliminary obligation budget or target request ended; this legacy action will not create an additional physical owner",
        })
        .where(
          and(
            eq(legacyUransArchiveGapRecoveryActions.id, action.id),
            eq(
              legacyUransArchiveGapRecoveryActions.state,
              "fresh_rerun_routed",
            ),
            eq(
              legacyUransArchiveGapRecoveryActions.targetUransRequestId,
              action.targetUransRequestId,
            ),
          ),
        );
      reconciled += 1;
    }
  }
  return reconciled;
}

/**
 * Route only a bounded number of previously materialized actions.  It has no
 * EngineClient dependency and never submits CFD directly; the ordinary URANS
 * ladder consumes the request on a later tier-2 pass.
 */
export async function routeLegacyUransArchiveGapRecoveryActions(
  db: DB,
  opts: { maxActions?: number } = {},
): Promise<number> {
  const maxActions = opts.maxActions ?? LEGACY_ARCHIVE_GAP_MAX_ACTIONS_PER_TICK;
  if (!Number.isSafeInteger(maxActions) || maxActions < 0 || maxActions > 100) {
    throw new Error("legacy archive-gap recovery maxActions must be 0 through 100");
  }
  const reconciled = await reconcileRoutedLegacyArchiveGapActions(
    db,
    maxActions,
  );
  let processed = reconciled;
  while (processed < maxActions) {
    const action = await claimNextLegacyArchiveGapAction(db);
    if (!action) break;
    try {
      await routeOneLegacyArchiveGapAction(db, action);
    } catch (error) {
      await settleLegacyArchiveGapAction(db, action, {
        state: "pending",
        nextAttemptAt: retryAt(),
        lastError:
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : String(error).slice(0, 2_000),
      });
    }
    processed += 1;
  }
  return processed;
}
