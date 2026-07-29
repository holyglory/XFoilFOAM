/**
 * Archive-clean-cycle recovery bridge.
 *
 * The reducer records an immutable scientific interpretation and a mutable,
 * exact-source recovery action.  This module is the only writer allowed to
 * turn that action into normal URANS ladder work.  It deliberately does not
 * submit CFD: it materializes existing durable request/obligation/verify
 * records, then the ordinary claim/compose/ingest path owns physical work.
 */
import {
  blockFinalUransVerificationBeforeSubmitInTransaction,
  type DB,
  hasExactValidSolverManifest,
  hasExactVerifiedRestartableEvidenceArchiveForArchive,
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  resultInterpretationRecoveryActions,
  simPrecalcObligationRequests,
  simPrecalcObligations,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueRequests,
  simulationPresetRevisions,
  simulationPresets,
  type SimUransVerifyQueueItem,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { solverImplementationIdForSetup } from "./build-request";
import { supersedeArchiveReductionQueueForRecoveredAction } from "./archive-reduction-queue";

const ACTION_LEASE_MS = 5 * 60_000;
const ACTION_RETRY_MS = 60_000;
const MAX_ACTIONS_PER_TICK = 8;

/** These are internal scheduler outcomes, never user-entered request flags. */
export const ARCHIVE_BACKFILL_PRECALC_CONTINUATION_OUTCOME =
  "archive_clean_cycle_continuation_pending";
export const ARCHIVE_BACKFILL_FINAL_CONTINUATION_OUTCOME =
  "archive_clean_cycle_final_continuation_pending";

/** Pure policy boundary used by the durable router and its regression tests.
 * A FULL archive checkpoint is never allowed to jump past its accepted FAST
 * baseline, and an unproven checkpoint is never represented as a continuation. */
export function archiveRecoveryRouteMode(input: {
  fidelity: "urans_precalc" | "urans_full";
  exactRestartProof: boolean;
  hasAcceptedPrecalcBaseline?: boolean;
}): "continue_exact_case" | "fresh_rerun" | "wait_for_precalc" {
  if (input.fidelity === "urans_precalc") {
    return input.exactRestartProof ? "continue_exact_case" : "fresh_rerun";
  }
  if (!input.exactRestartProof) return "fresh_rerun";
  return input.hasAcceptedPrecalcBaseline
    ? "continue_exact_case"
    : "wait_for_precalc";
}

/**
 * Archive recovery is scoped to one complete physical cell.  A matching
 * airfoil/revision/AoA is not enough: a revision can be repaired or migrated
 * around a boundary-condition change, and a saved transient may never cross
 * that physical boundary.
 */
export function archiveRecoveryPhysicalCellMatches(input: {
  sourceAirfoilId: string;
  sourceRevisionId: string;
  sourceBcId: string;
  sourceAoaDeg: number;
  targetAirfoilId: string;
  targetRevisionId: string;
  targetBcId: string;
  targetAoaDeg: number;
}): boolean {
  return (
    input.sourceAirfoilId === input.targetAirfoilId &&
    input.sourceRevisionId === input.targetRevisionId &&
    input.sourceBcId === input.targetBcId &&
    Number.isFinite(input.sourceAoaDeg) &&
    Number.isFinite(input.targetAoaDeg) &&
    input.sourceAoaDeg === input.targetAoaDeg
  );
}

/**
 * FULL archive recovery never creates another physical owner after the exact
 * cell has accepted FINAL evidence.  An existing request/target is allowed to
 * establish the required FAST baseline, but must be observed rather than
 * replaced.  A proven checkpoint with no owner also waits through ordinary
 * FULL coverage; it does not bypass FAST.
 */
export function archiveRecoveryFullRouteMode(input: {
  exactRestartProof: boolean;
  hasAcceptedFull: boolean;
  hasActiveFullRequest: boolean;
  hasTargetRequest: boolean;
}): "satisfied" | "wait_for_precalc" | "fresh_rerun" {
  if (input.hasAcceptedFull) return "satisfied";
  if (
    input.hasActiveFullRequest ||
    input.hasTargetRequest ||
    input.exactRestartProof
  ) {
    return "wait_for_precalc";
  }
  return "fresh_rerun";
}

/**
 * Decide whether this archive action may allocate a new FULL request after
 * reading the action's own target inside the natural-cell lock. A target is
 * an immutable ownership receipt: once present, its outcome must be surfaced
 * rather than replaced by a second physical FINAL owner. `none` means the
 * action never had a target (for example, a migration-era handoff).
 */
export function archiveRecoveryMayCreateFullOwner(input: {
  hasAcceptedFull: boolean;
  hasActiveFullRequest: boolean;
  actionTargetRequestId: string | null;
  authoritativeTargetState:
    | "none"
    | "active"
    | "terminal"
    | "missing"
    | "mismatched";
}): boolean {
  return (
    !input.hasAcceptedFull &&
    !input.hasActiveFullRequest &&
    input.actionTargetRequestId == null &&
    input.authoritativeTargetState === "none"
  );
}

/** A pending FULL verify queue is owned by one immutable checkpoint source.
 * The same source may replay after a crash; a competing archive may only wait
 * for ordinary coverage, never replace the saved state selected by the first
 * source. */
export function archiveRecoveryMayOwnVerifyQueue(input: {
  queueLatestResultAttemptId: string | null;
  sourceResultAttemptId: string;
}): boolean {
  return (
    input.queueLatestResultAttemptId == null ||
    input.queueLatestResultAttemptId === input.sourceResultAttemptId
  );
}

/**
 * An action's request target is only a temporary receipt while it waits for
 * accepted FAST coverage. Once the exact FINAL checkpoint attaches to a
 * verify queue, that queue becomes the sole physical owner. Keep the target
 * shape explicit: preserving the earlier request pointer would violate the
 * durable action's XOR constraint and make a crash/replay ambiguous.
 */
export function archiveRecoveryVerifyQueueTargetReceipt(
  verifyQueueId: string,
): {
  targetUransRequestId: null;
  targetVerifyQueueId: string;
} {
  if (!verifyQueueId) {
    throw new Error("archive verify-queue target requires a stable queue id");
  }
  return { targetUransRequestId: null, targetVerifyQueueId: verifyQueueId };
}

/** A saved state is executable only by the exact OpenFOAM implementation and
 * single boundary condition that produced it.  Legacy unknown provenance is
 * explicitly the 2406 compatibility generation; every other missing or
 * mismatched identity fails closed before a continuation is routed. */
export function archiveRecoveryImplementationMatchesTarget(input: {
  targetImplementationId: string | null | undefined;
  sourceAttemptImplementationId: string | null | undefined;
  sourceJobImplementationId: string | null | undefined;
  sourceJobBoundaryConditionIds: readonly string[] | null | undefined;
  sourceBcId: string;
}): boolean {
  const target = normalizedArchiveContinuationImplementationId(
    input.targetImplementationId,
  );
  const attempt = normalizedArchiveContinuationImplementationId(
    input.sourceAttemptImplementationId,
  );
  const job = normalizedArchiveContinuationImplementationId(
    input.sourceJobImplementationId,
  );
  return Boolean(
    target &&
      attempt &&
      job &&
      target === attempt &&
      target === job &&
      Array.isArray(input.sourceJobBoundaryConditionIds) &&
      input.sourceJobBoundaryConditionIds.length === 1 &&
      input.sourceJobBoundaryConditionIds[0] === input.sourceBcId,
  );
}

/**
 * A later accepted URANS generation can satisfy a recovery action only when it
 * belongs to the same resolved execution contract as the action's source. A
 * revision/AoA match alone is intentionally insufficient: legacy boundary
 * fallback and an OpenFOAM cutover can otherwise make a 2406 result suppress a
 * required 2606 repair for another physical cell.
 */
export function archiveRecoveryAcceptedCandidateMatchesTarget(input: {
  targetImplementationId: string | null | undefined;
  targetBcId: string;
  candidateAttemptImplementationId: string | null | undefined;
  candidateJobImplementationId: string | null | undefined;
  candidateJobBoundaryConditionIds: readonly string[] | null | undefined;
}): boolean {
  return archiveRecoveryImplementationMatchesTarget({
    targetImplementationId: input.targetImplementationId,
    sourceAttemptImplementationId: input.candidateAttemptImplementationId,
    sourceJobImplementationId: input.candidateJobImplementationId,
    sourceJobBoundaryConditionIds: input.candidateJobBoundaryConditionIds,
    sourceBcId: input.targetBcId,
  });
}

type RecoveryActionState =
  | "pending"
  | "routing"
  | "waiting_for_precalc"
  | "continuation_routed"
  | "fresh_rerun_routed"
  | "satisfied"
  | "blocked"
  | "cancelled";

type ClaimedRecoveryAction = {
  id: string;
  resultId: string;
  resultAttemptId: string;
  sourceArchiveId: string;
  inputEvidenceSignature: string;
  fidelity: "urans_precalc" | "urans_full";
  requestedAction: "continue_exact_case" | "verify_restart_proof_then_rerun";
  priorState: RecoveryActionState;
  targetUransRequestId: string | null;
  targetVerifyQueueId: string | null;
  correctiveTailPeriods: number | null;
  claimToken: string;
};

type ActionSource = {
  resultId: string;
  resultAttemptId: string;
  airfoilId: string;
  revisionId: string;
  bcId: string;
  aoaDeg: number;
  fidelity: "urans_precalc" | "urans_full" | null;
  status: string;
  source: string;
  engineJobId: string | null;
  engineCaseSlug: string | null;
  solverImplementationId: string | null;
  jobSolverImplementationId: string | null;
  jobBoundaryConditionIds: string[] | null;
};

function normalizedArchiveContinuationImplementationId(
  implementationId: string | null | undefined,
): string | null {
  if (!implementationId) return null;
  return implementationId === LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID
    ? OPENCFD_2406_SOLVER_IMPLEMENTATION_ID
    : implementationId;
}

/**
 * Saved OpenFOAM state is implementation-specific. Check it before the
 * archive action becomes `continuation_routed`; otherwise a 2406 checkpoint
 * can be committed as a continuation for a 2606 target and later be cancelled
 * by the submit consumer with no remaining action to recover it.
 */
async function archiveRecoveryTargetCompatibility(
  db: DB,
  source: ActionSource,
): Promise<{
  physicalCell: boolean;
  implementation: boolean;
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
  if (!revision)
    return {
      physicalCell: false,
      implementation: false,
      targetImplementationId: null,
    };
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
    // The request tables are keyed by revision/AoA and intentionally resolve
    // the BC in the same way as the submit consumer. A changed legacy
    // fallback must not let an old archive action declare a newer physical
    // boundary cell satisfied or route its saved state into it.
    return {
      physicalCell: false,
      implementation: false,
      targetImplementationId: null,
    };
  }
  let targetImplementationId: string | null = null;
  try {
    targetImplementationId = solverImplementationIdForSetup(snapshot);
  } catch {
    return {
      physicalCell: true,
      implementation: false,
      targetImplementationId: null,
    };
  }
  return {
    physicalCell: true,
    implementation: archiveRecoveryImplementationMatchesTarget({
      targetImplementationId,
      sourceAttemptImplementationId: source.solverImplementationId,
      sourceJobImplementationId: source.jobSolverImplementationId,
      sourceJobBoundaryConditionIds: source.jobBoundaryConditionIds,
      sourceBcId: source.bcId,
    }),
    targetImplementationId,
  };
}

function actionRetryAt(): Date {
  return new Date(Date.now() + ACTION_RETRY_MS);
}

function sourceFidelity(value: unknown): "urans_precalc" | "urans_full" | null {
  return value === "urans_precalc" || value === "urans_full" ? value : null;
}

/** Nullable for actions created before the archive clean-tail contract. A
 * non-null value comes only from the authenticated archive reducer and must
 * remain a bounded whole-period instruction all the way to the engine. */
export function archiveRecoveryCorrectiveTailPeriods(
  value: unknown,
): number | null {
  if (value == null) return null;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 3
  ) {
    throw new Error(
      "archive recovery corrective_tail_periods must be an integer from 1 through 3",
    );
  }
  return value;
}

/** Claim exactly one durable action. `routing` is leased so a crashed
 * sweeper never turns an archive result into a lost, invisible task. */
async function claimNextArchiveRecoveryAction(
  db: DB,
): Promise<ClaimedRecoveryAction | null> {
  const token = randomUUID();
  const leaseUntil = new Date(Date.now() + ACTION_LEASE_MS);
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const rows = (await tx.execute(sql`
      WITH candidate AS (
        SELECT action.id, action.state
        FROM result_interpretation_recovery_actions action
        WHERE (
          (action.state = 'pending' AND action.next_attempt_at <= now())
          OR (action.state = 'waiting_for_precalc' AND action.next_attempt_at <= now())
          OR (action.state = 'routing' AND action.claim_expires_at <= now())
        )
        ORDER BY action.next_attempt_at ASC, action."createdAt" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE result_interpretation_recovery_actions action
      SET state = 'routing',
          claim_token = ${token}::uuid,
          claim_expires_at = ${leaseUntil},
          attempt_count = action.attempt_count +
            CASE WHEN candidate.state = 'waiting_for_precalc' THEN 0 ELSE 1 END,
          "updatedAt" = now()
      FROM candidate
      WHERE action.id = candidate.id
      RETURNING
        action.id,
        action.result_id,
        action.result_attempt_id,
        action.source_archive_id,
        action.input_evidence_signature,
        action.fidelity,
        action.requested_action,
        candidate.state AS prior_state,
        action.target_urans_request_id,
        action.target_verify_queue_id,
        action.corrective_tail_periods
    `)) as unknown as Array<{
      id: string;
      result_id: string;
      result_attempt_id: string;
      source_archive_id: string;
      input_evidence_signature: string;
      fidelity: string;
      requested_action: string;
      prior_state: string;
      target_urans_request_id: string | null;
      target_verify_queue_id: string | null;
      corrective_tail_periods: number | null;
    }>;
    const row = rows[0];
    if (
      !row ||
      !sourceFidelity(row.fidelity) ||
      !["continue_exact_case", "verify_restart_proof_then_rerun"].includes(
        row.requested_action,
      ) ||
      !["pending", "routing", "waiting_for_precalc"].includes(row.prior_state)
    ) {
      return null;
    }
    return {
      id: row.id,
      resultId: row.result_id,
      resultAttemptId: row.result_attempt_id,
      sourceArchiveId: row.source_archive_id,
      inputEvidenceSignature: row.input_evidence_signature,
      fidelity: sourceFidelity(row.fidelity)!,
      requestedAction:
        row.requested_action as ClaimedRecoveryAction["requestedAction"],
      priorState: row.prior_state as RecoveryActionState,
      targetUransRequestId: row.target_urans_request_id,
      targetVerifyQueueId: row.target_verify_queue_id,
      correctiveTailPeriods: archiveRecoveryCorrectiveTailPeriods(
        row.corrective_tail_periods,
      ),
      claimToken: token,
    };
  });
}

async function settleArchiveRecoveryActionInTransaction(
  tx: DB,
  action: ClaimedRecoveryAction,
  values: {
    state: Exclude<RecoveryActionState, "routing">;
    targetUransRequestId?: string | null;
    targetVerifyQueueId?: string | null;
    decisionReason?: string | null;
    lastError?: string | null;
    nextAttemptAt?: Date;
  },
): Promise<boolean> {
  const [settled] = await tx
    .update(resultInterpretationRecoveryActions)
    .set({
      state: values.state,
      claimToken: null,
      claimExpiresAt: null,
      // A target is an immutable recovery ownership receipt. Retry/error
      // paths intentionally omit it, so preserve the current claimed action's
      // target unless a caller explicitly supplies null to clear it.
      targetUransRequestId:
        values.targetUransRequestId === undefined
          ? action.targetUransRequestId
          : values.targetUransRequestId,
      targetVerifyQueueId:
        values.targetVerifyQueueId === undefined
          ? action.targetVerifyQueueId
          : values.targetVerifyQueueId,
      decisionReason: values.decisionReason ?? null,
      lastError: values.lastError ?? null,
      nextAttemptAt: values.nextAttemptAt ?? new Date(),
    })
    .where(
      and(
        eq(resultInterpretationRecoveryActions.id, action.id),
        eq(resultInterpretationRecoveryActions.state, "routing"),
        eq(resultInterpretationRecoveryActions.claimToken, action.claimToken),
      ),
    )
    .returning({ id: resultInterpretationRecoveryActions.id });
  return Boolean(settled);
}

async function settleArchiveRecoveryAction(
  db: DB,
  action: ClaimedRecoveryAction,
  values: {
    state: Exclude<RecoveryActionState, "routing">;
    targetUransRequestId?: string | null;
    targetVerifyQueueId?: string | null;
    decisionReason?: string | null;
    lastError?: string | null;
    nextAttemptAt?: Date;
  },
): Promise<boolean> {
  const settled = await settleArchiveRecoveryActionInTransaction(db, action, values);
  if (settled && values.state === "satisfied") {
    await supersedeArchiveReductionQueueForRecoveredAction(db, {
      resultId: action.resultId,
      resultAttemptId: action.resultAttemptId,
      sourceArchiveId: action.sourceArchiveId,
      reason:
        "a later accepted URANS recovery generation satisfied this exact source action",
    });
  }
  return settled;
}

/**
 * Read an action's source, and prove that *the same archive chosen by the
 * archive reducer* remains the current verified GCS restart archive.  The
 * regular exact-archive helper additionally proves its required OpenFOAM
 * members.  Both gates are required: the generic helper must not accidentally
 * authorize a replacement archive that differs from the reducer input.
 */
async function sourceForArchiveRecoveryAction(
  db: DB,
  action: Pick<
    ClaimedRecoveryAction,
    "id" | "resultId" | "resultAttemptId" | "sourceArchiveId" | "fidelity"
  >,
): Promise<{ source: ActionSource | null; restartable: boolean }> {
  const rows = (await db.execute(sql`
    SELECT
      attempt.result_id,
      attempt.id AS result_attempt_id,
      attempt.airfoil_id,
      attempt.simulation_preset_revision_id AS revision_id,
      attempt.bc_id,
      attempt.aoa_deg::float8 AS aoa_deg,
      attempt.status,
      attempt.source,
      attempt.engine_job_id,
      attempt.engine_case_slug,
      attempt.solver_implementation_id,
      source_job.solver_implementation_id AS job_solver_implementation_id,
      source_job.bc_ids AS job_boundary_condition_ids,
      attempt.evidence_payload ->> 'fidelity' AS fidelity,
      archive.id AS current_archive_id,
      archive.state AS archive_state,
      blob.backend AS blob_backend,
      blob.compression AS blob_compression,
      blob.mime_type AS blob_mime_type,
      blob."verifiedAt" AS blob_verified_at
    FROM result_interpretation_recovery_actions action
    JOIN result_attempts attempt
      ON attempt.id = action.result_attempt_id
     AND attempt.result_id = action.result_id
    JOIN results result
      ON result.id = attempt.result_id
     AND result.airfoil_id = attempt.airfoil_id
     AND result.simulation_preset_revision_id IS NOT DISTINCT FROM
       attempt.simulation_preset_revision_id
     AND result.bc_id = attempt.bc_id
     AND result.aoa_deg IS NOT DISTINCT FROM attempt.aoa_deg
    LEFT JOIN solver_evidence_archives archive
      ON archive.id = action.source_archive_id
     AND archive.result_id = attempt.result_id
     AND archive.result_attempt_id = attempt.id
     AND archive.state = 'current'
    LEFT JOIN solver_evidence_blobs blob ON blob.id = archive.blob_id
    LEFT JOIN sim_jobs source_job ON source_job.id = attempt.sim_job_id
    WHERE action.id = ${action.id}
      AND action.result_id = ${action.resultId}
      AND action.result_attempt_id = ${action.resultAttemptId}
      AND action.source_archive_id = ${action.sourceArchiveId}
      AND action.fidelity = ${action.fidelity}
    LIMIT 1
  `)) as unknown as Array<{
    result_id: string;
    result_attempt_id: string;
    airfoil_id: string;
    revision_id: string;
    bc_id: string;
    aoa_deg: number;
    status: string;
    source: string;
    engine_job_id: string | null;
    engine_case_slug: string | null;
    solver_implementation_id: string | null;
    job_solver_implementation_id: string | null;
    job_boundary_condition_ids: string[] | null;
    fidelity: string | null;
    current_archive_id: string | null;
    archive_state: string | null;
    blob_backend: string | null;
    blob_compression: string | null;
    blob_mime_type: string | null;
    blob_verified_at: Date | null;
  }>;
  const row = rows[0];
  if (
    !row ||
    !row.revision_id ||
    !row.bc_id ||
    row.aoa_deg == null ||
    !Number.isFinite(Number(row.aoa_deg))
  ) {
    return { source: null, restartable: false };
  }
  const source: ActionSource = {
    resultId: row.result_id,
    resultAttemptId: row.result_attempt_id,
    airfoilId: row.airfoil_id,
    revisionId: row.revision_id,
    bcId: row.bc_id,
    aoaDeg: Number(row.aoa_deg),
    fidelity: sourceFidelity(row.fidelity),
    status: row.status,
    source: row.source,
    engineJobId: row.engine_job_id,
    engineCaseSlug: row.engine_case_slug,
    solverImplementationId: row.solver_implementation_id,
    jobSolverImplementationId: row.job_solver_implementation_id,
    jobBoundaryConditionIds: row.job_boundary_condition_ids,
  };
  const exactCurrentArchive =
    row.current_archive_id === action.sourceArchiveId &&
    row.archive_state === "current" &&
    row.blob_backend === "gcs" &&
    row.blob_compression === "zstd" &&
    row.blob_mime_type === "application/zstd" &&
    row.blob_verified_at != null;
  const sourceShape =
    source.fidelity === action.fidelity &&
    ["done", "failed"].includes(source.status) &&
    source.source === "solved" &&
    Boolean(source.engineJobId && source.engineCaseSlug);
  const restartable =
    exactCurrentArchive &&
    sourceShape &&
    (await hasExactValidSolverManifest(
      db,
      source.resultId,
      source.resultAttemptId,
    )) &&
    (await hasExactVerifiedRestartableEvidenceArchiveForArchive(
      db,
      source.resultId,
      source.resultAttemptId,
      action.sourceArchiveId,
    ));
  return { source, restartable };
}

async function activeExactRequest(
  tx: DB,
  source: ActionSource,
  input: { continuation: boolean },
): Promise<{
  id: string;
  state: "pending" | "running";
  correctiveTailPeriods: number | null;
} | null> {
  const rows = (await tx.execute(sql`
    SELECT request.id,
           request.state,
           request.continue_from_result_id,
           request.continue_from_result_attempt_id,
           request.corrective_tail_periods
    FROM sim_urans_requests request
    WHERE request.airfoil_id = ${source.airfoilId}
      AND request.revision_id = ${source.revisionId}
      AND request.aoa_deg = ${source.aoaDeg}
      AND request.fidelity = 'precalc'
      AND request.state IN ('pending', 'running')
    ORDER BY request."createdAt" ASC
    FOR UPDATE
  `)) as unknown as Array<{
    id: string;
    state: "pending" | "running";
    continue_from_result_id: string | null;
    continue_from_result_attempt_id: string | null;
    corrective_tail_periods: number | null;
  }>;
  const exact = rows.find((row) =>
    input.continuation
      ? row.continue_from_result_id === source.resultId &&
        row.continue_from_result_attempt_id === source.resultAttemptId
      : row.continue_from_result_id == null &&
        row.continue_from_result_attempt_id == null,
  );
  return exact
    ? {
        id: exact.id,
        state: exact.state,
        correctiveTailPeriods: archiveRecoveryCorrectiveTailPeriods(
          exact.corrective_tail_periods,
        ),
      }
    : null;
}

async function ensureArchiveRecoveryPrecalcRoute(
  db: DB,
  action: ClaimedRecoveryAction,
  source: ActionSource,
  input: {
    continuation: boolean;
    targetImplementationId: string | null;
    onRouted?: (tx: DB, requestId: string) => Promise<void>;
  },
): Promise<
  | { kind: "routed"; requestId: string }
  | { kind: "satisfied"; reason: string }
  | { kind: "blocked"; reason: string }
  | { kind: "retry"; reason: string }
> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // Matches createUransRequest's natural request lock.  No generic request
    // can race us into a second open physical owner for this exact cell.
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

    const accepted = await acceptedUransForArchiveAction(tx, source, {
      fidelity: "urans_precalc",
      targetImplementationId: input.targetImplementationId,
    });
    if (accepted) {
      // The legacy obligation key does not carry BC or implementation. Repair
      // an old/mis-keyed terminal projection only when the independently
      // selected accepted attempt proved the resolved target contract above.
      if (
        obligation &&
        !(
          obligation.state === "satisfied" &&
          obligation.sourceResultId === accepted.resultId &&
          obligation.sourceResultAttemptId === accepted.resultAttemptId &&
          obligation.lastOutcome === "accepted" &&
          obligation.lastError == null &&
          obligation.nextSubmitAt == null
        )
      ) {
        await tx
          .update(simPrecalcObligations)
          .set({
            state: "satisfied",
            sourceResultId: accepted.resultId,
            sourceResultAttemptId: accepted.resultAttemptId,
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
          "a later accepted preliminary generation matches this exact boundary-condition and solver implementation",
      };
    }
    if (
      obligation &&
      obligation.state === "running" &&
      obligation.sourceResultAttemptId !== source.resultAttemptId
    ) {
      return {
        kind: "retry" as const,
        reason:
          "another physical preliminary generation currently owns this cell",
      };
    }
    if (
      obligation &&
      obligation.state === "pending" &&
      obligation.sourceResultAttemptId != null &&
      obligation.sourceResultAttemptId !== source.resultAttemptId
    ) {
      return {
        kind: "retry" as const,
        reason: "another preliminary recovery is pending for this exact cell",
      };
    }
    if (
      obligation &&
      input.continuation &&
      obligation.continuationNoProgressCount >= 2
    ) {
      return {
        kind: "blocked" as const,
        reason:
          "the exact preliminary continuation exhausted its no-progress safety limit",
      };
    }
    if (
      obligation &&
      !input.continuation &&
      obligation.state === "blocked" &&
      obligation.attemptCount >= obligation.maxAttempts
    ) {
      return {
        kind: "blocked" as const,
        reason:
          "fresh preliminary rerun would exceed this cell's existing physical-attempt budget",
      };
    }

    const existingRequest = await activeExactRequest(tx, source, {
      continuation: input.continuation,
    });
    const conflictingOpenRequest = !existingRequest
      ? ((await tx.execute(sql`
          SELECT request.id
          FROM sim_urans_requests request
          WHERE request.airfoil_id = ${source.airfoilId}
            AND request.revision_id = ${source.revisionId}
            AND request.aoa_deg = ${source.aoaDeg}
            AND request.fidelity = 'precalc'
            AND request.state IN ('pending', 'running')
          LIMIT 1
        `)) as unknown as Array<{ id: string }>)
      : [];
    if (conflictingOpenRequest.length) {
      return {
        kind: "retry" as const,
        reason:
          "an incompatible open preliminary request already owns this exact cell",
      };
    }

    let requestId = existingRequest?.id;
    const requestedCorrectiveTailPeriods = input.continuation
      ? action.correctiveTailPeriods
      : null;
    if (existingRequest && requestedCorrectiveTailPeriods != null) {
      if (existingRequest.correctiveTailPeriods == null) {
        // A migration-era pending request for this *same immutable source* can
        // safely receive the now-proven archive instruction. Once it has been
        // submitted, changing it would lie about the physical run instead.
        if (existingRequest.state !== "pending") {
          return {
            kind: "retry" as const,
            reason:
              "matching continuation is already running without the archive clean-tail instruction",
          };
        }
        await tx
          .update(simUransRequests)
          .set({ correctiveTailPeriods: requestedCorrectiveTailPeriods })
          .where(
            and(
              eq(simUransRequests.id, existingRequest.id),
              eq(simUransRequests.state, "pending"),
              eq(simUransRequests.continueFromResultId, source.resultId),
              eq(
                simUransRequests.continueFromResultAttemptId,
                source.resultAttemptId,
              ),
            ),
          );
      } else if (
        existingRequest.correctiveTailPeriods !== requestedCorrectiveTailPeriods
      ) {
        return {
          kind: "blocked" as const,
          reason:
            "matching continuation carries a different archive clean-tail instruction",
        };
      }
    }
    if (!requestId) {
      const [request] = await tx
        .insert(simUransRequests)
        .values({
          airfoilId: source.airfoilId,
          revisionId: source.revisionId,
          aoaDeg: source.aoaDeg,
          fidelity: "precalc",
          state: "pending",
          backgroundOwner: true,
          requestedBy: "archive-clean-cycle-backfill",
          continueFromResultId: input.continuation ? source.resultId : null,
          continueFromResultAttemptId: input.continuation
            ? source.resultAttemptId
            : null,
          correctiveTailPeriods: requestedCorrectiveTailPeriods,
        })
        .returning({ id: simUransRequests.id });
      requestId = request?.id;
    }
    if (!requestId)
      throw new Error("archive recovery could not create a PRECALC request");

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
          lastOutcome: input.continuation
            ? ARCHIVE_BACKFILL_PRECALC_CONTINUATION_OUTCOME
            : "archive_clean_cycle_fresh_rerun_pending",
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
          lastOutcome: input.continuation
            ? ARCHIVE_BACKFILL_PRECALC_CONTINUATION_OUTCOME
            : "archive_clean_cycle_fresh_rerun_pending",
          lastError: null,
        })
        .where(eq(simPrecalcObligations.id, obligation.id))
        .returning({ id: simPrecalcObligations.id });
      obligationId = reopened?.id;
    }
    if (!obligationId)
      throw new Error("archive recovery could not create a PRECALC obligation");
    await tx
      .insert(simPrecalcObligationRequests)
      .values({ obligationId, requestId })
      .onConflictDoNothing();
    // Route ownership and the action receipt commit together. If a worker
    // crashes before the commit, neither the request/obligation mutation nor
    // the action transition survives; a later lease holder cannot consume an
    // orphaned continuation as ordinary work.
    await input.onRouted?.(tx, requestId);
    return { kind: "routed" as const, requestId };
  });
}

type ArchiveFullRequestOutcome =
  | { kind: "satisfied"; resultAttemptId: string }
  | { kind: "active" | "created"; id: string }
  | {
      kind:
        | "target_terminal"
        | "target_missing"
        | "target_mismatched"
        | "target_inconsistent";
    };

type AcceptedArchiveRecoveryGeneration = {
  resultId: string;
  resultAttemptId: string;
};

/**
 * Select a later accepted generation only after proving the whole physical and
 * executable identity. `sim_precalc_obligations` and request ownership have a
 * historical natural key without BC/implementation, so this query is the
 * mandatory compatibility fence before either can be treated as satisfied.
 */
async function acceptedUransForArchiveAction(
  tx: DB,
  source: ActionSource,
  input: {
    fidelity: "urans_precalc" | "urans_full";
    targetImplementationId: string | null;
  },
): Promise<AcceptedArchiveRecoveryGeneration | null> {
  if (!input.targetImplementationId) return null;
  const rows = (await tx.execute(sql`
    SELECT
      result.id AS result_id,
      attempt.id AS result_attempt_id,
      attempt.solver_implementation_id AS attempt_solver_implementation_id,
      candidate_job.solver_implementation_id AS job_solver_implementation_id,
      candidate_job.bc_ids AS job_boundary_condition_ids
    FROM results result
    JOIN result_attempts attempt
      ON attempt.result_id = result.id
     AND attempt.airfoil_id = result.airfoil_id
     AND attempt.bc_id = result.bc_id
     AND attempt.simulation_preset_revision_id =
         result.simulation_preset_revision_id
     AND attempt.aoa_deg = result.aoa_deg
    JOIN result_classifications classification
      ON classification.result_attempt_id = attempt.id
     AND classification.state = 'accepted'
    JOIN sim_jobs candidate_job ON candidate_job.id = attempt.sim_job_id
    WHERE result.airfoil_id = ${source.airfoilId}
      AND result.simulation_preset_revision_id = ${source.revisionId}
      AND result.bc_id = ${source.bcId}
      AND result.aoa_deg = ${source.aoaDeg}
      AND result.status = 'done'
      AND result.source = 'solved'
      AND attempt.status = 'done'
      AND attempt.source = 'solved'
      AND attempt.method_key = 'openfoam.urans'
      AND attempt.evidence_payload ->> 'fidelity' = ${input.fidelity}
    ORDER BY attempt."createdAt" DESC, attempt.id DESC
    LIMIT 64
  `)) as unknown as Array<{
    result_id: string;
    result_attempt_id: string;
    attempt_solver_implementation_id: string | null;
    job_solver_implementation_id: string | null;
    job_boundary_condition_ids: string[] | null;
  }>;
  const row = rows.find((candidate) =>
    archiveRecoveryAcceptedCandidateMatchesTarget({
      targetImplementationId: input.targetImplementationId,
      targetBcId: source.bcId,
      candidateAttemptImplementationId:
        candidate.attempt_solver_implementation_id,
      candidateJobImplementationId: candidate.job_solver_implementation_id,
      candidateJobBoundaryConditionIds: candidate.job_boundary_condition_ids,
    }),
  );
  return row
    ? { resultId: row.result_id, resultAttemptId: row.result_attempt_id }
    : null;
}

async function fullRequestForArchiveAction(
  db: DB,
  source: ActionSource,
  input: {
    actionTargetRequestId: string | null;
    targetImplementationId: string | null;
    onOwner?: (
      tx: DB,
      request: { kind: "active" | "created"; id: string },
    ) => Promise<void>;
  },
): Promise<ArchiveFullRequestOutcome> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(
          ${`urans-request:${source.airfoilId}:${source.revisionId}:full`}, 0
        )
      )
    `);
    const accepted = await acceptedUransForArchiveAction(tx, source, {
      fidelity: "urans_full",
      targetImplementationId: input.targetImplementationId,
    });
    if (accepted) return { kind: "satisfied" as const, ...accepted };

    // Re-read the recorded target after taking this exact same cell lock as
    // request creation. The outer read merely decides whether to attempt a
    // checkpoint attachment. It cannot authorize a replacement if the target
    // reaches a terminal state before this transaction obtains its lock.
    let authoritativeTargetState:
      | "none"
      | "active"
      | "terminal"
      | "missing"
      | "mismatched" = "none";
    if (input.actionTargetRequestId) {
      const [target] = await tx
        .select({
          airfoilId: simUransRequests.airfoilId,
          revisionId: simUransRequests.revisionId,
          aoaDeg: simUransRequests.aoaDeg,
          fidelity: simUransRequests.fidelity,
          state: simUransRequests.state,
        })
        .from(simUransRequests)
        .where(eq(simUransRequests.id, input.actionTargetRequestId))
        .for("update")
        .limit(1);
      if (!target) {
        authoritativeTargetState = "missing";
      } else if (
        target.airfoilId !== source.airfoilId ||
        target.revisionId !== source.revisionId ||
        Number(target.aoaDeg) !== Number(source.aoaDeg) ||
        target.fidelity !== "full"
      ) {
        authoritativeTargetState = "mismatched";
      } else {
        authoritativeTargetState =
          target.state === "pending" || target.state === "running"
            ? "active"
            : "terminal";
      }
      if (authoritativeTargetState === "terminal") {
        return { kind: "target_terminal" as const };
      }
      if (authoritativeTargetState === "missing") {
        return { kind: "target_missing" as const };
      }
      if (authoritativeTargetState === "mismatched") {
        return { kind: "target_mismatched" as const };
      }
    }
    const [existing] = await tx
      .select({ id: simUransRequests.id })
      .from(simUransRequests)
      .where(
        and(
          eq(simUransRequests.airfoilId, source.airfoilId),
          eq(simUransRequests.revisionId, source.revisionId),
          eq(simUransRequests.aoaDeg, source.aoaDeg),
          eq(simUransRequests.fidelity, "full"),
          inArray(simUransRequests.state, ["pending", "running"]),
        ),
      )
      .for("update")
      .limit(1);
    if (existing) {
      await tx
        .update(simUransRequests)
        .set({ backgroundOwner: true })
        .where(eq(simUransRequests.id, existing.id));
      await input.onOwner?.(tx, { kind: "active", id: existing.id });
      return { kind: "active" as const, id: existing.id };
    }
    if (
      !archiveRecoveryMayCreateFullOwner({
        hasAcceptedFull: false,
        hasActiveFullRequest: false,
        actionTargetRequestId: input.actionTargetRequestId,
        authoritativeTargetState,
      })
    ) {
      // An active target should also have matched the exact open request just
      // queried above. Failing closed prevents a surprising second owner if
      // another controller altered the target in a way this action cannot
      // honestly represent.
      return { kind: "target_inconsistent" as const };
    }
    const [created] = await tx
      .insert(simUransRequests)
      .values({
        airfoilId: source.airfoilId,
        revisionId: source.revisionId,
        aoaDeg: source.aoaDeg,
        fidelity: "full",
        state: "pending",
        backgroundOwner: true,
        requestedBy: "archive-clean-cycle-backfill",
      })
      .returning({ id: simUransRequests.id });
    if (!created)
      throw new Error("archive recovery could not create a FULL request");
    await input.onOwner?.(tx, { kind: "created", id: created.id });
    return { kind: "created" as const, id: created.id };
  });
}

/**
 * An action can point only to a same-cell FULL request. A terminal target is
 * intentionally not replaced: its own durable FINAL controller has already
 * consumed the generation/budget decision, so silently creating another owner
 * would duplicate physical work and hide a critical recovery failure.
 */
async function archiveFullTargetRequestState(
  db: DB,
  action: ClaimedRecoveryAction,
  source: ActionSource,
): Promise<"missing" | "active" | "terminal" | "mismatched"> {
  if (!action.targetUransRequestId) return "missing";
  const [request] = await db
    .select({
      airfoilId: simUransRequests.airfoilId,
      revisionId: simUransRequests.revisionId,
      aoaDeg: simUransRequests.aoaDeg,
      fidelity: simUransRequests.fidelity,
      state: simUransRequests.state,
    })
    .from(simUransRequests)
    .where(eq(simUransRequests.id, action.targetUransRequestId))
    .limit(1);
  if (!request) return "missing";
  if (
    request.airfoilId !== source.airfoilId ||
    request.revisionId !== source.revisionId ||
    Number(request.aoaDeg) !== Number(source.aoaDeg) ||
    request.fidelity !== "full"
  ) {
    return "mismatched";
  }
  return request.state === "pending" || request.state === "running"
    ? "active"
    : "terminal";
}

async function attachArchiveFullContinuationToVerifyQueue(
  db: DB,
  action: ClaimedRecoveryAction,
  source: ActionSource,
): Promise<{ queueId: string | null; reason?: string }> {
  if (!action.targetUransRequestId) return { queueId: null };
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const rows = (await tx.execute(sql`
      SELECT queue.id, queue.state, queue.latest_result_attempt_id
      FROM sim_urans_verify_queue queue
      JOIN sim_urans_verify_queue_requests coverage
        ON coverage.queue_id = queue.id
       AND coverage.request_id = ${action.targetUransRequestId}
      JOIN result_attempts precalc_attempt
        ON precalc_attempt.id = queue.precalc_result_attempt_id
       AND precalc_attempt.result_id = queue.precalc_result_id
       AND precalc_attempt.airfoil_id = ${source.airfoilId}
       AND precalc_attempt.simulation_preset_revision_id = ${source.revisionId}
       AND precalc_attempt.bc_id = ${source.bcId}
       AND precalc_attempt.aoa_deg = ${source.aoaDeg}
       AND precalc_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
      JOIN result_classifications precalc_classification
        ON precalc_classification.result_attempt_id = precalc_attempt.id
       AND precalc_classification.state = 'accepted'
      WHERE queue.state = 'pending'
        AND (
          queue.latest_result_attempt_id IS NULL
          OR queue.latest_result_attempt_id = ${source.resultAttemptId}
        )
      ORDER BY queue."createdAt" ASC
      FOR UPDATE OF queue
      LIMIT 1
    `)) as unknown as Array<{
      id: string;
      state: string;
      latest_result_attempt_id: string | null;
    }>;
    const queue = rows[0];
    if (!queue) return { queueId: null };
    if (
      !archiveRecoveryMayOwnVerifyQueue({
        queueLatestResultAttemptId: queue.latest_result_attempt_id,
        sourceResultAttemptId: source.resultAttemptId,
      })
    ) {
      return {
        queueId: null,
        reason: "verify queue already belongs to a different immutable FULL checkpoint",
      };
    }
    const [attached] = await tx
      .update(simUransVerifyQueue)
      .set({
        latestResultAttemptId: source.resultAttemptId,
        lastOutcome: ARCHIVE_BACKFILL_FINAL_CONTINUATION_OUTCOME,
        lastError: null,
        nextSubmitAt: null,
      })
      .where(
        and(
          eq(simUransVerifyQueue.id, queue.id),
          eq(simUransVerifyQueue.state, "pending"),
          or(
            isNull(simUransVerifyQueue.latestResultAttemptId),
            eq(
              simUransVerifyQueue.latestResultAttemptId,
              source.resultAttemptId,
            ),
          ),
        ),
      )
      .returning({ id: simUransVerifyQueue.id });
    if (!attached) {
      return {
        queueId: null,
        reason: "verify queue was claimed while archive action routed",
      };
    }
    const settled = await settleArchiveRecoveryActionInTransaction(tx, action, {
      state: "continuation_routed",
      ...archiveRecoveryVerifyQueueTargetReceipt(attached.id),
      decisionReason:
        "exact full checkpoint attached to an accepted preliminary URANS verify queue",
    });
    if (!settled) {
      throw new Error(
        "archive recovery lost its lease while attaching an exact FULL checkpoint",
      );
    }
    return { queueId: attached.id };
  });
}

async function routeOneArchiveRecoveryAction(
  db: DB,
  action: ClaimedRecoveryAction,
): Promise<void> {
  const { source, restartable } = await sourceForArchiveRecoveryAction(
    db,
    action,
  );
  if (!source || source.fidelity !== action.fidelity) {
    await settleArchiveRecoveryAction(db, action, {
      state: "blocked",
      decisionReason: "source identity is no longer an exact URANS attempt",
      lastError:
        "archive recovery refuses to infer a target from changed or missing evidence provenance",
    });
    return;
  }
  const targetCompatibility = await archiveRecoveryTargetCompatibility(db, source);
  if (!targetCompatibility.physicalCell) {
    await settleArchiveRecoveryAction(db, action, {
      state: "blocked",
      decisionReason:
        "the current target boundary condition is not the archive checkpoint's exact physical cell",
      lastError:
        "archive recovery refuses to infer a continuation or fresh replacement across a changed boundary condition",
    });
    return;
  }
  // A valid archive may still be non-resumable after an OpenFOAM cutover or
  // if its original job used a multi-BC batch. Such evidence can request a
  // normal fresh generation, but it must never reach a continuation consumer
  // that will cancel after this action has been marked routed.
  const exactContinuationRestartProof =
    restartable && targetCompatibility.implementation;

  if (action.fidelity === "urans_precalc") {
    const routeMode = archiveRecoveryRouteMode({
      fidelity: action.fidelity,
      exactRestartProof: exactContinuationRestartProof,
    });
    const route = await ensureArchiveRecoveryPrecalcRoute(
      db,
      action,
      source,
      {
        continuation: routeMode === "continue_exact_case",
        targetImplementationId: targetCompatibility.targetImplementationId,
        onRouted: async (tx, requestId) => {
          const settled = await settleArchiveRecoveryActionInTransaction(
            tx,
            action,
            {
              state:
                routeMode === "continue_exact_case"
                  ? "continuation_routed"
                  : "fresh_rerun_routed",
              targetUransRequestId: requestId,
              decisionReason:
                routeMode === "continue_exact_case"
                  ? "exact source archive, boundary, implementation, and restart checkpoint proved; same case queued"
                  : restartable
                    ? "archive checkpoint is incompatible with the current solver or boundary contract; one budgeted fresh preliminary generation queued"
                    : "exact restart proof unavailable; one budgeted fresh preliminary generation queued",
            },
          );
          if (!settled) {
            throw new Error(
              "archive recovery lost its lease while recording a PRECALC request owner",
            );
          }
        },
      },
    );
    if (route.kind === "routed") {
      return;
    }
    if (route.kind === "satisfied") {
      await settleArchiveRecoveryAction(db, action, {
        state: "satisfied",
        decisionReason: route.reason,
      });
      return;
    }
    if (route.kind === "blocked") {
      await settleArchiveRecoveryAction(db, action, {
        state: "blocked",
        decisionReason: route.reason,
      });
      return;
    }
    await settleArchiveRecoveryAction(db, action, {
      state: "pending",
      nextAttemptAt: actionRetryAt(),
      decisionReason: route.reason,
    });
    return;
  }

  // A FULL recovery never bypasses FAST.  With an exact checkpoint, wait for
  // an accepted compatible FAST baseline, then attach the checkpoint to its
  // normal verify queue. Without proof, ordinary FULL coverage owns the one
  // budgeted fresh generation.
  const targetState = await archiveFullTargetRequestState(db, action, source);
  if (targetState === "mismatched") {
    await settleArchiveRecoveryAction(db, action, {
      state: "blocked",
      decisionReason:
        "the recorded FULL request belongs to a different physical cell",
      lastError:
        "archive recovery refuses to replace or attach a FULL request with mismatched airfoil, revision, AoA, or fidelity",
    });
    return;
  }
  if (exactContinuationRestartProof && targetState === "active") {
    const attached = await attachArchiveFullContinuationToVerifyQueue(
      db,
      action,
      source,
    );
    if (attached.queueId) {
      // The queue attachment and this action's immutable target receipt
      // committed in one transaction. Do not perform a second settle here:
      // a crash between those writes would leave a special queue ownerless.
      return;
    }
  }
  // Re-check under the natural-cell lock. A concurrent FINAL acceptance must
  // satisfy this action rather than race into another physical request.
  const request = await fullRequestForArchiveAction(db, source, {
    actionTargetRequestId: action.targetUransRequestId,
    targetImplementationId: targetCompatibility.targetImplementationId,
    onOwner: async (tx, owner) => {
      const routeMode = archiveRecoveryFullRouteMode({
        exactRestartProof: exactContinuationRestartProof,
        hasAcceptedFull: false,
        hasActiveFullRequest: owner.kind === "active",
        hasTargetRequest: action.targetUransRequestId != null,
      });
      const settled = await settleArchiveRecoveryActionInTransaction(
        tx,
        action,
        {
          state:
            routeMode === "wait_for_precalc"
              ? "waiting_for_precalc"
              : "fresh_rerun_routed",
          targetUransRequestId: owner.id,
          decisionReason:
            routeMode === "wait_for_precalc"
              ? "waiting for the normal FULL request to establish its accepted preliminary URANS baseline"
              : "exact restart proof unavailable; normal FULL request owns a budgeted fresh generation",
          nextAttemptAt: exactContinuationRestartProof
            ? actionRetryAt()
            : new Date(),
        },
      );
      if (!settled) {
        throw new Error(
          "archive recovery lost its lease while recording a FULL request owner",
        );
      }
    },
  });
  if (request.kind === "satisfied") {
    await settleArchiveRecoveryAction(db, action, {
      state: "satisfied",
      decisionReason:
        "a later accepted full-URANS generation already satisfies this exact physical cell",
    });
    return;
  }
  if (
    request.kind === "target_terminal" ||
    request.kind === "target_missing" ||
    request.kind === "target_mismatched" ||
    request.kind === "target_inconsistent"
  ) {
    await settleArchiveRecoveryAction(db, action, {
      state: "blocked",
      decisionReason:
        request.kind === "target_terminal"
          ? "the previously routed FULL request reached a terminal state without an accepted exact FINAL result"
          : "the recorded FULL recovery owner is no longer a compatible active physical request",
      lastError:
        "archive recovery will not silently create another FULL physical owner after its immutable target is terminal, missing, mismatched, or inconsistent; a new durable recovery action is required after the cause is resolved",
    });
    return;
  }
  // `fullRequestForArchiveAction` persisted this action's target receipt in
  // the same transaction as the owner. Returning without another settle keeps
  // the crash/lease boundary atomic.
}

/** Materialize a bounded number of durable actions before normal ladder
 * claiming. It has no EngineClient dependency: physical solve submission
 * remains exclusively in `uransLadderTick`'s normal consumers. */
export async function routeArchiveInterpretationRecoveryActions(
  db: DB,
  opts: { maxActions?: number } = {},
): Promise<number> {
  const maxActions = opts.maxActions ?? MAX_ACTIONS_PER_TICK;
  let routed = 0;
  for (let index = 0; index < maxActions; index += 1) {
    const action = await claimNextArchiveRecoveryAction(db);
    if (!action) break;
    try {
      await routeOneArchiveRecoveryAction(db, action);
    } catch (error) {
      await settleArchiveRecoveryAction(db, action, {
        state: "pending",
        nextAttemptAt: actionRetryAt(),
        lastError:
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : String(error).slice(0, 2_000),
      });
    }
    routed += 1;
  }
  return routed;
}

/**
 * Strict authorization for the special PRECALC continuation path. An ordinary
 * request cannot opt into this; it must be pointed to by a durable action
 * whose source archive remains exact/current/verified at submit time.
 */
export async function archiveBackfillPrecalcContinuationForRequest(
  db: DB,
  input: {
    requestId: string;
    resultId: string;
    resultAttemptId: string;
    airfoilId: string;
    revisionId: string;
    bcId: string;
    aoaDeg: number;
    correctiveTailPeriods: number | null;
  },
): Promise<boolean> {
  const [action] = await db
    .select({
      id: resultInterpretationRecoveryActions.id,
      resultId: resultInterpretationRecoveryActions.resultId,
      resultAttemptId: resultInterpretationRecoveryActions.resultAttemptId,
      sourceArchiveId: resultInterpretationRecoveryActions.sourceArchiveId,
      fidelity: resultInterpretationRecoveryActions.fidelity,
      correctiveTailPeriods:
        resultInterpretationRecoveryActions.correctiveTailPeriods,
    })
    .from(resultInterpretationRecoveryActions)
    .where(
      and(
        eq(
          resultInterpretationRecoveryActions.targetUransRequestId,
          input.requestId,
        ),
        eq(resultInterpretationRecoveryActions.state, "continuation_routed"),
        eq(resultInterpretationRecoveryActions.fidelity, "urans_precalc"),
        eq(resultInterpretationRecoveryActions.resultId, input.resultId),
        eq(
          resultInterpretationRecoveryActions.resultAttemptId,
          input.resultAttemptId,
        ),
      ),
    )
    .limit(1);
  if (!action) return false;
  if (
    archiveRecoveryCorrectiveTailPeriods(action.correctiveTailPeriods) !==
    archiveRecoveryCorrectiveTailPeriods(input.correctiveTailPeriods)
  ) {
    return false;
  }
  const { source, restartable } = await sourceForArchiveRecoveryAction(db, {
    ...action,
    fidelity: "urans_precalc",
  });
  const compatibility = source
    ? await archiveRecoveryTargetCompatibility(db, source)
    : null;
  return Boolean(
    restartable &&
    source &&
    compatibility?.physicalCell &&
    compatibility.implementation &&
    archiveRecoveryPhysicalCellMatches({
      sourceAirfoilId: source.airfoilId,
      sourceRevisionId: source.revisionId,
      sourceBcId: source.bcId,
      sourceAoaDeg: source.aoaDeg,
      targetAirfoilId: input.airfoilId,
      targetRevisionId: input.revisionId,
      targetBcId: input.bcId,
      targetAoaDeg: input.aoaDeg,
    }),
  );
}

/**
 * A request marked as an archive-clean-cycle continuation has a stricter
 * submit-time proof than a normal continuation.  In particular, it may not
 * fall back to a superseding archive for the same result attempt after the
 * reducer's generation-pinned archive has changed.
 */
export async function archiveBackfillPrecalcRequestRequiresActionProof(
  db: DB,
  requestId: string,
): Promise<boolean> {
  const [action] = await db
    .select({ id: resultInterpretationRecoveryActions.id })
    .from(resultInterpretationRecoveryActions)
    .where(
      and(
        eq(resultInterpretationRecoveryActions.targetUransRequestId, requestId),
        eq(resultInterpretationRecoveryActions.fidelity, "urans_precalc"),
        eq(
          resultInterpretationRecoveryActions.state,
          "continuation_routed",
        ),
      ),
    )
    .limit(1);
  return Boolean(action);
}

/**
 * A generation-pinned archive continuation that loses its exact proof at
 * submit time must not look successfully routed forever. Cancel its sole
 * request and terminalize the matching action together so a generic
 * continuation cannot silently substitute a newer archive for the reducer's
 * original input.
 */
export async function blockArchiveBackfillPrecalcContinuationAtSubmit(
  db: DB,
  input: { requestId: string; reason: string },
): Promise<boolean> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [action] = await tx
      .update(resultInterpretationRecoveryActions)
      .set({
        state: "blocked",
        decisionReason:
          "archive-pinned preliminary continuation lost its exact restart proof at submission",
        lastError: input.reason.slice(0, 2_000),
        nextAttemptAt: new Date(),
        claimToken: null,
        claimExpiresAt: null,
      })
      .where(
        and(
          eq(resultInterpretationRecoveryActions.targetUransRequestId, input.requestId),
          eq(resultInterpretationRecoveryActions.fidelity, "urans_precalc"),
          eq(
            resultInterpretationRecoveryActions.state,
            "continuation_routed",
          ),
        ),
      )
      .returning({ id: resultInterpretationRecoveryActions.id });
    if (!action) return false;
    await tx
      .update(simUransRequests)
      .set({ state: "cancelled" })
      .where(
        and(
          eq(simUransRequests.id, input.requestId),
          eq(simUransRequests.state, "running"),
        ),
      );
    return true;
  });
}

export type ArchiveBackfillFinalContinuation = {
  resultId: string;
  resultAttemptId: string;
  bcId: string;
  engineJobId: string;
  engineCaseSlug: string;
  solverImplementationId: string | null;
  correctiveTailPeriods: number | null;
};

/** Exact, action-owned FINAL continuation authorization. The verify queue
 * still has to prove its accepted FAST baseline independently in the normal
 * consumer; this only authorizes its full checkpoint. */
export async function archiveBackfillFinalContinuationForVerifyItem(
  db: DB,
  item: SimUransVerifyQueueItem,
  targetBcId: string,
): Promise<ArchiveBackfillFinalContinuation | null> {
  if (item.lastOutcome !== ARCHIVE_BACKFILL_FINAL_CONTINUATION_OUTCOME) {
    return null;
  }
  if (!item.latestResultAttemptId) return null;
  const [action] = await db
    .select({
      id: resultInterpretationRecoveryActions.id,
      resultId: resultInterpretationRecoveryActions.resultId,
      resultAttemptId: resultInterpretationRecoveryActions.resultAttemptId,
      sourceArchiveId: resultInterpretationRecoveryActions.sourceArchiveId,
      fidelity: resultInterpretationRecoveryActions.fidelity,
      correctiveTailPeriods:
        resultInterpretationRecoveryActions.correctiveTailPeriods,
    })
    .from(resultInterpretationRecoveryActions)
    .where(
      and(
        eq(resultInterpretationRecoveryActions.targetVerifyQueueId, item.id),
        eq(resultInterpretationRecoveryActions.state, "continuation_routed"),
        eq(resultInterpretationRecoveryActions.fidelity, "urans_full"),
        eq(
          resultInterpretationRecoveryActions.resultAttemptId,
          item.latestResultAttemptId,
        ),
      ),
    )
    .limit(1);
  if (!action) return null;
  const { source, restartable } = await sourceForArchiveRecoveryAction(db, {
    ...action,
    fidelity: "urans_full",
  });
  const compatibility = source
    ? await archiveRecoveryTargetCompatibility(db, source)
    : null;
  // The verify queue owns one immutable accepted FAST attempt. Check that
  // attempt's full physical cell as well as the currently resolved target:
  // a stale/mutated queue must not turn a valid checkpoint into a continuation
  // for another boundary condition.
  const queueRows = (await db.execute(sql`
    SELECT
      precalc_attempt.airfoil_id,
      precalc_attempt.simulation_preset_revision_id AS revision_id,
      precalc_attempt.bc_id,
      precalc_attempt.aoa_deg::float8 AS aoa_deg
    FROM sim_urans_verify_queue queue
    JOIN result_attempts precalc_attempt
      ON precalc_attempt.id = queue.precalc_result_attempt_id
     AND precalc_attempt.result_id = queue.precalc_result_id
    WHERE queue.id = ${item.id}
      AND queue.airfoil_id = ${item.airfoilId}
      AND queue.revision_id = ${item.revisionId}
      AND queue.aoa_deg = ${item.aoaDeg}
    LIMIT 1
  `)) as unknown as Array<{
    airfoil_id: string;
    revision_id: string;
    bc_id: string;
    aoa_deg: number;
  }>;
  const queueCell = queueRows[0];
  if (
    !restartable ||
    !source ||
    !compatibility?.physicalCell ||
    !compatibility.implementation ||
    !queueCell ||
    !archiveRecoveryPhysicalCellMatches({
      sourceAirfoilId: source.airfoilId,
      sourceRevisionId: source.revisionId,
      sourceBcId: source.bcId,
      sourceAoaDeg: source.aoaDeg,
      targetAirfoilId: queueCell.airfoil_id,
      targetRevisionId: queueCell.revision_id,
      targetBcId: queueCell.bc_id,
      targetAoaDeg: Number(queueCell.aoa_deg),
    }) ||
    !archiveRecoveryPhysicalCellMatches({
      sourceAirfoilId: source.airfoilId,
      sourceRevisionId: source.revisionId,
      sourceBcId: source.bcId,
      sourceAoaDeg: source.aoaDeg,
      targetAirfoilId: item.airfoilId,
      targetRevisionId: item.revisionId,
      targetBcId,
      targetAoaDeg: item.aoaDeg,
    }) ||
    !source.engineJobId ||
    !source.engineCaseSlug
  ) {
    return null;
  }
  return {
    resultId: source.resultId,
    resultAttemptId: source.resultAttemptId,
    bcId: source.bcId,
    engineJobId: source.engineJobId,
    engineCaseSlug: source.engineCaseSlug,
    solverImplementationId: source.solverImplementationId,
    correctiveTailPeriods: archiveRecoveryCorrectiveTailPeriods(
      action.correctiveTailPeriods,
    ),
  };
}

/** A special FULL queue outcome is an authorization boundary, not merely a
 * display label. If its source archive stops proving the exact checkpoint,
 * the ordinary FINAL recovery planner must not take over and spend a fresh
 * generation under the wrong provenance. */
export async function archiveBackfillFinalVerifyQueueRequiresActionProof(
  db: DB,
  verifyQueueId: string,
): Promise<boolean> {
  const [action] = await db
    .select({ id: resultInterpretationRecoveryActions.id })
    .from(resultInterpretationRecoveryActions)
    .where(
      and(
        eq(resultInterpretationRecoveryActions.targetVerifyQueueId, verifyQueueId),
        eq(resultInterpretationRecoveryActions.fidelity, "urans_full"),
        eq(
          resultInterpretationRecoveryActions.state,
          "continuation_routed",
        ),
      ),
    )
    .limit(1);
  return Boolean(action);
}

export async function blockArchiveBackfillFinalContinuationAtSubmit(
  db: DB,
  input: {
    verifyQueueId: string;
    reason: string;
    targetSolverImplementationId: string;
  },
): Promise<boolean> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // Serialize the special authorization before changing its queue.  If a
    // crash occurs at any later line, this transaction rolls back both sides;
    // a healed `pending` queue therefore cannot fall through to generic FULL
    // planning while its action looks terminal (or vice versa).
    const actions = (await tx.execute(sql`
      SELECT action.id
      FROM result_interpretation_recovery_actions action
      WHERE action.target_verify_queue_id = ${input.verifyQueueId}
        AND action.fidelity = 'urans_full'
        AND action.state = 'continuation_routed'
      FOR UPDATE
    `)) as unknown as Array<{ id: string }>;
    const action = actions[0];

    const queueBlocked =
      await blockFinalUransVerificationBeforeSubmitInTransaction(tx, {
        verifyQueueId: input.verifyQueueId,
        reason: input.reason,
        incidentReason: "archive-pinned-continuation-proof-lost",
        targetSolverImplementationId: input.targetSolverImplementationId,
        // Claim healing may have returned this special queue to pending after
        // a process crash. It remains action-owned until this atomic fence
        // settles it; ordinary fresh FINAL planning must not claim it.
        allowPendingUnsubmitted: true,
        metadata: {
          archiveRecoveryActionId: action?.id ?? null,
          archiveContinuationProof: "lost_at_submit",
        },
      });
    if (!queueBlocked) {
      // The queue is already terminal or has an actual submitted job. Neither
      // is generically runnable, so do not manufacture another incident or
      // alter a physical run. A future terminal reconciliation owns any
      // remaining action cleanup.
      return false;
    }

    // The action can be absent only if an external destructive cascade raced
    // this worker; the queue fence above still prevents a fresh replacement.
    // When present, its state change is deliberately in the exact same
    // transaction as queue/request/incident state.
    if (!action) return true;
    const [blockedAction] = await tx
      .update(resultInterpretationRecoveryActions)
      .set({
        state: "blocked",
        decisionReason:
          "archive-pinned full continuation lost its exact restart proof at submission",
        lastError: input.reason.slice(0, 2_000),
        nextAttemptAt: new Date(),
        claimToken: null,
        claimExpiresAt: null,
      })
      .where(
        and(
          eq(resultInterpretationRecoveryActions.id, action.id),
          eq(
            resultInterpretationRecoveryActions.targetVerifyQueueId,
            input.verifyQueueId,
          ),
          eq(resultInterpretationRecoveryActions.fidelity, "urans_full"),
          eq(
            resultInterpretationRecoveryActions.state,
            "continuation_routed",
          ),
        ),
      )
      .returning({ id: resultInterpretationRecoveryActions.id });
    if (!blockedAction) {
      // The row was locked above, so a failed transition means a broken
      // invariant rather than a harmless retry. Throw to roll back the queue
      // fence, request projection, and incident together.
      throw new Error(
        "archive recovery action disappeared while atomically blocking a FINAL continuation",
      );
    }
    return true;
  });
}
