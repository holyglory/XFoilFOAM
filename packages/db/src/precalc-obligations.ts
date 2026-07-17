import { and, asc, eq, inArray, sql, type SQLWrapper } from "drizzle-orm";
import {
  AUTO_PRECALC_CONTINUATION_BUDGET_S,
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
  isDeterministicMeshBlockerError,
} from "@aerodb/core";

import type { DB } from "./client";
import { lockPrecalcCells } from "./precalc-cell-lock";
import {
  probeCampaignCompletion,
  recomputeProgressForPrecalcObligations,
  recomputeProgressForCampaign,
} from "./campaign-execution";
import {
  resultAttempts,
  resultClassifications,
  results,
  simJobs,
  simPrecalcObligationAttempts,
  simPrecalcObligationCampaigns,
  simPrecalcObligationRequests,
  simPrecalcObligations,
  simUransRequests,
  simulationPresetRevisions,
  type SimJob,
  type SimPrecalcObligation,
} from "./schema";
import {
  recordSolverIncidentInTransaction,
  resolveSolverIncidentsForOwnerInTransaction,
  solverIncidentReason,
  URANS_RECOVERY_REMEDIATION_VERSION,
} from "./solver-incidents";
import {
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
} from "./solver-implementations";

export interface PrecalcObligationCell {
  airfoilId: string;
  revisionId: string;
  aoaDeg: number;
  sourceResultId?: string | null;
  sourceResultAttemptId?: string | null;
}

export interface PrecalcObligationOwnership {
  campaignIds?: string[];
  /** Request coverage is an owner link, not autonomous background ownership.
   * A request keeps work alive only while it is pending/running and carries
   * its own independent background owner. Campaign-only requests rely on
   * their campaign associations. */
  requestIds?: string[];
  /** Remote mirror leases are natural-cell owners only while their exact
   * promise point is active, unexpired, and explicitly remote-solver work. */
  syncPromiseIds?: string[];
  backgroundOwner?: boolean;
}

/** Same-case continuation is an exceptional recovery path. Each segment gets
 * the engine's own bounded extension controller; four completed segments are
 * ample recovery headroom without permitting an unbounded cross-job loop. */
export const MAX_PRECALC_CONTINUATION_SEGMENTS = 4;
export const MAX_PRECALC_NO_PROGRESS_SEGMENTS = 2;

const liveOwnerSql = (obligationId: string | SQLWrapper) => sql`(
  EXISTS (
    SELECT 1 FROM sim_precalc_obligations owned_obligation
    WHERE owned_obligation.id = ${obligationId} AND owned_obligation.background_owner
  )
  OR EXISTS (
    SELECT 1
    FROM sim_precalc_obligation_campaigns ownership
    JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
    WHERE ownership.obligation_id = ${obligationId}
      AND ownership.state = 'active'
      AND campaign.status IN ('active', 'attention', 'paused')
  )
  OR EXISTS (
    SELECT 1
    FROM sim_precalc_obligation_requests coverage
    JOIN sim_urans_requests request ON request.id = coverage.request_id
    WHERE coverage.obligation_id = ${obligationId}
      AND request.background_owner
      AND request.state IN ('pending', 'running')
  )
  OR EXISTS (
    SELECT 1
    FROM sim_precalc_obligations owned_obligation
    JOIN sync_sweep_promise_points promise_point
      ON promise_point.airfoil_id = owned_obligation.airfoil_id
     AND promise_point.simulation_preset_revision_id = owned_obligation.revision_id
     AND promise_point.aoa_deg = owned_obligation.aoa_deg
     AND promise_point.status = 'active'
    JOIN sync_sweep_promises promise
      ON promise.id = promise_point.promise_id
     AND promise.status = 'active'
     AND promise."expiresAt" > now()
     AND promise.request_payload ->> 'remoteSolver' = 'true'
    WHERE owned_obligation.id = ${obligationId}
  )
)`;

/** Ensure one physical obligation per value-compatible cell and attach every
 * beneficiary. Terminal satisfied/blocked work is never silently reopened. */
export async function ensurePrecalcObligationsInTransaction(
  tx: DB,
  cells: PrecalcObligationCell[],
  ownership: PrecalcObligationOwnership = {},
  opts: { transferFromJobId?: string } = {},
): Promise<SimPrecalcObligation[]> {
  if (!cells.length) return [];
  const requestedCampaignIds = [...new Set(ownership.campaignIds ?? [])].sort();
  const requestedRequestIds = [...new Set(ownership.requestIds ?? [])].sort();
  const requestedSyncPromiseIds = [
    ...new Set(ownership.syncPromiseIds ?? []),
  ].sort();
  const liveCampaignRows = requestedCampaignIds.length
    ? ((await tx.execute(sql`
          SELECT campaign.id
          FROM sim_campaigns campaign
          WHERE campaign.id = ANY(${sql`ARRAY[${sql.join(
            requestedCampaignIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})
            AND campaign.status IN ('active', 'attention', 'paused')
          ORDER BY campaign.id
          FOR SHARE OF campaign
        `)) as unknown as Array<{ id: string }>)
    : [];
  const campaignIds = liveCampaignRows.map((row) => row.id);
  const liveRemoteCells = requestedSyncPromiseIds.length
    ? ((await tx.execute(sql`
          SELECT promise.id, promise_point.airfoil_id,
                 promise_point.simulation_preset_revision_id AS revision_id,
                 promise_point.aoa_deg::float8 AS aoa_deg
          FROM sync_sweep_promises promise
          JOIN sync_sweep_promise_points promise_point
            ON promise_point.promise_id = promise.id
           AND promise_point.status = 'active'
          WHERE promise.id = ANY(${sql`ARRAY[${sql.join(
            requestedSyncPromiseIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})
            AND promise.status = 'active'
            AND promise."expiresAt" > now()
            AND promise.request_payload ->> 'remoteSolver' = 'true'
          ORDER BY promise.id, promise_point.id
          FOR SHARE OF promise, promise_point
        `)) as unknown as Array<{
        id: string;
        airfoil_id: string;
        revision_id: string;
        aoa_deg: number;
      }>)
    : [];
  const remoteCellKeys = new Set(
    liveRemoteCells.map(
      (row) => `${row.airfoil_id}:${row.revision_id}:${Number(row.aoa_deg)}`,
    ),
  );
  const liveRequestRows = requestedRequestIds.length
    ? ((await tx.execute(sql`
          SELECT request.id, request.background_owner
          FROM sim_urans_requests request
          WHERE request.id = ANY(${sql`ARRAY[${sql.join(
            requestedRequestIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})
            AND request.state IN ('pending', 'running')
          ORDER BY request.id
          FOR SHARE OF request
        `)) as unknown as Array<{ id: string; background_owner: boolean }>)
    : [];
  const requestIds = liveRequestRows.map((row) => row.id);
  // Global ownership transition lock order:
  // campaign/promise(+point)/request owner rows -> sorted natural-cell advisory
  // locks -> result/obligation rows. Campaign claim/requeue follows the same
  // order, preventing campaign↔cell inversion under concurrent routing.
  await lockPrecalcCells(tx, cells);
  const independentlyOwnedRequest = liveRequestRows.some(
    (row) => row.background_owner,
  );
  const hasSharedLiveOwner = Boolean(
    ownership.backgroundOwner ||
    campaignIds.length ||
    independentlyOwnedRequest,
  );
  if (!hasSharedLiveOwner && !remoteCellKeys.size) return [];
  const rows: SimPrecalcObligation[] = [];
  for (const cell of cells) {
    const hasLiveOwner =
      hasSharedLiveOwner ||
      remoteCellKeys.has(
        `${cell.airfoilId}:${cell.revisionId}:${Number(cell.aoaDeg)}`,
      );
    if (!hasLiveOwner) continue;
    const [existingObligation] = await tx
      .select({ id: simPrecalcObligations.id })
      .from(simPrecalcObligations)
      .where(
        and(
          eq(simPrecalcObligations.airfoilId, cell.airfoilId),
          eq(simPrecalcObligations.revisionId, cell.revisionId),
          eq(simPrecalcObligations.aoaDeg, cell.aoaDeg),
        ),
      )
      .limit(1);
    if (!existingObligation) {
      const [canonical] = await tx
        .select({ status: results.status, simJobId: results.simJobId })
        .from(results)
        .where(
          and(
            eq(results.airfoilId, cell.airfoilId),
            eq(results.simulationPresetRevisionId, cell.revisionId),
            eq(results.aoaDeg, cell.aoaDeg),
          ),
        )
        .limit(1);
      // A generic queue mutation that won the natural-cell lock remains the
      // sole owner for this cycle. Creating a new obligation behind its
      // pending/queued/stale row would strand ordinary work in a ladder-
      // owned state. No canonical row is fine for explicit/background
      // PRECALC requests; terminal evidence is also eligible for routing.
      if (
        canonical &&
        !["done", "failed"].includes(canonical.status) &&
        canonical.simJobId !== opts.transferFromJobId
      )
        continue;
    }
    if (cell.sourceResultId) {
      const [source] = await tx
        .select({ status: results.status })
        .from(results)
        .where(eq(results.id, cell.sourceResultId))
        .limit(1);
      // A concurrent generic retry which acquired the cell lock first has
      // already returned this source to pending. Do not create a ladder
      // owner behind that committed retry; the next terminal verdict may
      // route it again through the normal bounded path.
      if (!source || !["done", "failed"].includes(source.status)) continue;
    }
    let sourceResultAttemptId = cell.sourceResultAttemptId ?? null;
    if (!cell.sourceResultId && !sourceResultAttemptId) {
      const [sourceAttempt] = await tx
        .select({ id: resultAttempts.id })
        .from(resultAttempts)
        .where(
          and(
            eq(resultAttempts.airfoilId, cell.airfoilId),
            eq(resultAttempts.simulationPresetRevisionId, cell.revisionId),
            eq(resultAttempts.aoaDeg, cell.aoaDeg),
            eq(resultAttempts.regime, "rans"),
          ),
        )
        .orderBy(sql`${resultAttempts.createdAt} DESC`)
        .limit(1);
      sourceResultAttemptId = sourceAttempt?.id ?? null;
    }
    const [row] = await tx
      .insert(simPrecalcObligations)
      .values({
        airfoilId: cell.airfoilId,
        revisionId: cell.revisionId,
        aoaDeg: cell.aoaDeg,
        sourceResultId: cell.sourceResultId ?? null,
        sourceResultAttemptId,
        state: "pending",
        backgroundOwner: ownership.backgroundOwner ?? false,
      })
      .onConflictDoUpdate({
        target: [
          simPrecalcObligations.airfoilId,
          simPrecalcObligations.revisionId,
          simPrecalcObligations.aoaDeg,
        ],
        set: {
          sourceResultId: sql`COALESCE(${simPrecalcObligations.sourceResultId}, EXCLUDED.source_result_id)`,
          sourceResultAttemptId: sql`COALESCE(${simPrecalcObligations.sourceResultAttemptId}, EXCLUDED.source_result_attempt_id)`,
          backgroundOwner: sql`${simPrecalcObligations.backgroundOwner} OR EXCLUDED.background_owner`,
          state: sql`CASE
              WHEN ${simPrecalcObligations.state} = 'cancelled'
                AND ${hasLiveOwner}
              THEN 'pending'
              ELSE ${simPrecalcObligations.state}
            END`,
          completedAt: sql`CASE
              WHEN ${simPrecalcObligations.state} = 'cancelled'
                AND ${hasLiveOwner}
              THEN NULL
              ELSE ${simPrecalcObligations.completedAt}
            END`,
          updatedAt: new Date(),
        },
      })
      .returning();
    if (!row) continue;
    rows.push(row);
    if (campaignIds.length) {
      await tx
        .insert(simPrecalcObligationCampaigns)
        .values(
          campaignIds.map((campaignId) => ({
            obligationId: row.id,
            campaignId,
            state: "active",
            cancelledAt: null,
          })),
        )
        .onConflictDoUpdate({
          target: [
            simPrecalcObligationCampaigns.obligationId,
            simPrecalcObligationCampaigns.campaignId,
          ],
          set: { state: "active", cancelledAt: null, updatedAt: new Date() },
        });
    }
    if (requestIds.length) {
      await tx
        .insert(simPrecalcObligationRequests)
        .values(
          requestIds.map((requestId) => ({
            obligationId: row.id,
            requestId,
          })),
        )
        .onConflictDoNothing();
    }
  }
  return rows;
}

export async function ensurePrecalcObligations(
  db: DB,
  cells: PrecalcObligationCell[],
  ownership: PrecalcObligationOwnership = {},
): Promise<SimPrecalcObligation[]> {
  return db.transaction((rawTx) =>
    ensurePrecalcObligationsInTransaction(
      rawTx as unknown as DB,
      cells,
      ownership,
    ),
  );
}

async function nextPrecalcSubmissionSequence(
  tx: DB,
  obligationId: string,
): Promise<number> {
  const [row] = await tx
    .select({
      next: sql<number>`COALESCE(MAX(${simPrecalcObligationAttempts.attemptNumber}), 0)::int + 1`,
    })
    .from(simPrecalcObligationAttempts)
    .where(eq(simPrecalcObligationAttempts.obligationId, obligationId));
  const next = Number(row?.next ?? 1);
  if (!Number.isSafeInteger(next) || next <= 0) {
    throw new Error(
      `precalc obligation ${obligationId} has an invalid submission sequence`,
    );
  }
  return next;
}

function isSameCasePrecalcContinuation(
  requestPayload: unknown,
  obligationCount: number,
): boolean {
  if (
    obligationCount !== 1 ||
    requestPayload == null ||
    typeof requestPayload !== "object"
  ) {
    return false;
  }
  const payload = requestPayload as {
    continueFromResultAttemptId?: unknown;
    continueFromResultId?: unknown;
  };
  return Boolean(
    (typeof payload.continueFromResultAttemptId === "string" &&
      payload.continueFromResultAttemptId.length > 0) ||
    (typeof payload.continueFromResultId === "string" &&
      payload.continueFromResultId.length > 0),
  );
}

/** Record only an engine-accepted submission. A cancelled composition or
 * connection failure consumes no attempt. Engine-accepted infrastructure or
 * setup work is initially reserved against the physical budget, then released
 * transactionally if terminal settlement proves that no CFD attempt occurred.
 * A one-cell same-case continuation advances the immutable submission audit
 * without reserving another fresh-solve ordinal. Idempotent by
 * (obligation, job). */
export async function recordPrecalcObligationSubmission(
  db: DB,
  simJobId: string,
  obligationIds: string[],
): Promise<void> {
  if (!obligationIds.length) return;
  await db.transaction(async (tx) => {
    const [job] = await tx
      .select({ requestPayload: simJobs.requestPayload })
      .from(simJobs)
      .where(eq(simJobs.id, simJobId))
      .limit(1);
    if (!job) {
      throw new Error(`precalc submission job ${simJobId} does not exist`);
    }
    const sameCaseContinuation = isSameCasePrecalcContinuation(
      job.requestPayload,
      obligationIds.length,
    );
    const obligations = await tx
      .select()
      .from(simPrecalcObligations)
      .where(inArray(simPrecalcObligations.id, obligationIds))
      .orderBy(asc(simPrecalcObligations.id))
      .for("update");
    for (const obligation of obligations) {
      const [existing] = await tx
        .select({ id: simPrecalcObligationAttempts.id })
        .from(simPrecalcObligationAttempts)
        .where(
          and(
            eq(simPrecalcObligationAttempts.obligationId, obligation.id),
            eq(simPrecalcObligationAttempts.simJobId, simJobId),
          ),
        )
        .limit(1);
      if (existing) continue;
      if (
        (!sameCaseContinuation &&
          obligation.attemptCount >= obligation.maxAttempts) ||
        ["satisfied", "blocked", "cancelled"].includes(obligation.state)
      ) {
        throw new Error(
          `precalc obligation ${obligation.id} has no remaining submission attempt`,
        );
      }
      if (obligation.latestSimJobId !== simJobId) {
        throw new Error(
          `precalc obligation ${obligation.id} is leased to ${obligation.latestSimJobId ?? "no composition"}, not ${simJobId}`,
        );
      }
      const attemptNumber = await nextPrecalcSubmissionSequence(
        tx as unknown as DB,
        obligation.id,
      );
      const solverAttemptNumber = sameCaseContinuation
        ? null
        : obligation.attemptCount + 1;
      await tx.insert(simPrecalcObligationAttempts).values({
        obligationId: obligation.id,
        simJobId,
        attemptNumber,
        solverAttemptNumber,
        consumesSolverAttempt: !sameCaseContinuation,
        state: "submitted",
      });
      await tx
        .update(simPrecalcObligations)
        .set({
          state: "running",
          attemptCount: solverAttemptNumber ?? obligation.attemptCount,
          latestSimJobId: simJobId,
          lastOutcome: "submitted",
          lastError: null,
          submitFailureCount: 0,
          nextSubmitAt: null,
          lastAttemptAt: new Date(),
          completedAt: null,
        })
        .where(eq(simPrecalcObligations.id, obligation.id));
    }
  });
}

export interface MeshRecoveryRequeueScope {
  /** Test/repair closed world. An explicitly empty list matches nothing. */
  obligationIds?: string[];
  /** Exact conditional whole-polar event scope. */
  promotionIds?: string[];
  /** Scheduler closed world for shared test databases. Production omits it. */
  campaignIds?: string[];
  /** Exact explicit-request scope for shared test databases and repair tools. */
  requestIds?: string[];
}

export interface MeshRecoveryRequeueResult {
  obligationIds: string[];
  campaignIds: string[];
}

export interface PrecalcContinuationRecoveryResult extends MeshRecoveryRequeueResult {
  requestIds: string[];
  repairedSubmissionIds: string[];
}

function meshRecoveryScopeSql(scope: MeshRecoveryRequeueScope) {
  if (scope.obligationIds !== undefined) {
    return scope.obligationIds.length
      ? sql`obligation.id = ANY(${sql`ARRAY[${sql.join(
          scope.obligationIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})`
      : sql`false`;
  }
  if (scope.promotionIds !== undefined) {
    return scope.promotionIds.length
      ? sql`EXISTS (
          SELECT 1
          FROM sim_rans_polar_promotion_points scoped_point
          WHERE scoped_point.obligation_id = obligation.id
            AND scoped_point.promotion_id = ANY(${sql`ARRAY[${sql.join(
              scope.promotionIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})
        )`
      : sql`false`;
  }
  if (scope.requestIds !== undefined) {
    return scope.requestIds.length
      ? sql`EXISTS (
          SELECT 1
          FROM sim_precalc_obligation_requests scoped_request
          WHERE scoped_request.obligation_id = obligation.id
            AND scoped_request.request_id = ANY(${sql`ARRAY[${sql.join(
              scope.requestIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})
        )`
      : sql`false`;
  }
  if (scope.campaignIds !== undefined) {
    return scope.campaignIds.length
      ? sql`EXISTS (
          SELECT 1
          FROM sim_precalc_obligation_campaigns scoped_ownership
          WHERE scoped_ownership.obligation_id = obligation.id
            AND scoped_ownership.campaign_id = ANY(${sql`ARRAY[${sql.join(
              scope.campaignIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})
        )`
      : sql`false`;
  }
  return sql`true`;
}

function restartablePrecalcWarningSql(warnings: SQLWrapper) {
  return sql`EXISTS (
    SELECT 1
    FROM unnest(COALESCE(${warnings}, ARRAY[]::text[])) warning
    WHERE warning LIKE ${"%" + URANS_BUDGET_STOP_MARKER + "%"}
       OR warning LIKE ${"%" + URANS_CONTINUATION_REQUIRED_MARKER + "%"}
  )`;
}

function typedPrecalcInfrastructureInterruptionSql(input: {
  state: SQLWrapper;
  outcome: SQLWrapper;
  consumesSolverAttempt: SQLWrapper;
}) {
  return sql`(
    ${input.state} = 'cancelled'
    AND ${input.outcome} = 'infrastructure_retry_wait'
    AND NOT ${input.consumesSolverAttempt}
  )`;
}

/** Exact compatibility repair predicate for pre-typed continuation failures.
 * The submission must have targeted this checkpoint, produced no attempt
 * evidence, and ended at continuation staging with one of the known
 * missing/unrestartable-state errors. Numerical solver failures never match. */
function legacyPrecalcInfrastructureInterruptionSql(input: {
  resultAttemptId: SQLWrapper;
  consumesSolverAttempt: SQLWrapper;
  simJobId: SQLWrapper;
  error: SQLWrapper;
  checkpointResultAttemptId: SQLWrapper;
  checkpointResultId: SQLWrapper;
}) {
  return sql`(
    ${input.resultAttemptId} IS NULL
    AND ${input.consumesSolverAttempt}
    AND EXISTS (
      SELECT 1
      FROM sim_jobs legacy_continuation_job
      WHERE legacy_continuation_job.id = ${input.simJobId}
        AND legacy_continuation_job.status IN ('failed', 'cancelled')
        AND legacy_continuation_job.request_payload ->> 'uransFidelity' = 'precalc'
        AND (
          legacy_continuation_job.request_payload ->> 'continueFromResultAttemptId'
            = CAST(${input.checkpointResultAttemptId} AS text)
          OR (
            ${input.checkpointResultId} IS NOT NULL
            AND legacy_continuation_job.request_payload ->> 'continueFromResultId'
              = CAST(${input.checkpointResultId} AS text)
          )
        )
        AND position(
          'continuation failed:'
          in lower(COALESCE(${input.error}, legacy_continuation_job.error, ''))
        ) > 0
        AND (
          position(
            'nothing to restart from'
            in lower(COALESCE(${input.error}, legacy_continuation_job.error, ''))
          ) > 0
          OR position(
            'not restartable'
            in lower(COALESCE(${input.error}, legacy_continuation_job.error, ''))
          ) > 0
          OR position(
            'not found'
            in lower(COALESCE(${input.error}, legacy_continuation_job.error, ''))
          ) > 0
          OR position(
            'missing field'
            in lower(COALESCE(${input.error}, legacy_continuation_job.error, ''))
          ) > 0
          OR position(
            'mesh is missing'
            in lower(COALESCE(${input.error}, legacy_continuation_job.error, ''))
          ) > 0
          OR position(
            'no force coefficient history'
            in lower(COALESCE(${input.error}, legacy_continuation_job.error, ''))
          ) > 0
          OR position(
            'immutable evidence restore failed'
            in lower(COALESCE(${input.error}, legacy_continuation_job.error, ''))
          ) > 0
        )
    )
  )`;
}

type RestartablePrecalcCheckpointSqlOptions = {
  /** Immutable numerical implementation the new continuation job will use.
   * Omit when the obligation's immutable preset revision is the target. */
  targetSolverImplementationId?: string | SQLWrapper | null;
  /** When supplied, the selected checkpoint must be the exact immutable
   * attempt/result named by the continuation payload. */
  continuationResultAttemptId?: string | SQLWrapper | null;
  continuationResultId?: string | SQLWrapper | null;
};

const normalizedPrecalcSolverImplementationSql = (
  implementationId: string | SQLWrapper | null,
) => sql`CASE
  WHEN ${implementationId}::uuid = ${LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID}::uuid
    THEN ${OPENCFD_2406_SOLVER_IMPLEMENTATION_ID}::uuid
  ELSE ${implementationId}::uuid
END`;

const compatiblePrecalcCheckpointImplementationSql = (input: {
  targetSolverImplementationId: string | SQLWrapper | null;
  targetRevisionSolverImplementationId: string | SQLWrapper | null;
  checkpointRevisionSolverImplementationId: string | SQLWrapper | null;
  checkpointAttemptSolverImplementationId: string | SQLWrapper | null;
  checkpointJobSolverImplementationId: string | SQLWrapper | null;
}) => {
  const target = normalizedPrecalcSolverImplementationSql(
    input.targetSolverImplementationId,
  );
  return sql`(
    ${target} IS NOT NULL
    AND ${normalizedPrecalcSolverImplementationSql(
      input.targetRevisionSolverImplementationId,
    )} = ${target}
    AND ${normalizedPrecalcSolverImplementationSql(
      input.checkpointRevisionSolverImplementationId,
    )} = ${target}
    AND (
      ${input.checkpointAttemptSolverImplementationId}::uuid IS NULL
      OR ${normalizedPrecalcSolverImplementationSql(
        input.checkpointAttemptSolverImplementationId,
      )} = ${target}
    )
    AND (
      ${input.checkpointJobSolverImplementationId}::uuid IS NULL
      OR ${normalizedPrecalcSolverImplementationSql(
        input.checkpointJobSolverImplementationId,
      )} = ${target}
    )
  )`;
};

/** SQL predicate shared by capability-upgrade repair and promotion scans.
 * A checkpoint remains schedulable across later submissions only when every
 * newer row is a typed non-physical infrastructure interruption or the exact
 * pre-typed compatibility shape repaired below. Its immutable solver
 * implementation must also match the target continuation job; OpenCFD 2406
 * state must never be staged into a 2606 successor cell. */
export function restartablePrecalcCheckpointSql(
  obligationId: SQLWrapper,
  opts: RestartablePrecalcCheckpointSqlOptions = {},
) {
  const targetSolverImplementationId =
    opts.targetSolverImplementationId ??
    sql`checkpoint_target_revision.solver_implementation_id`;
  const resultAttemptMatch =
    opts.continuationResultAttemptId === undefined
      ? sql`true`
      : sql`(
          NULLIF(CAST(${opts.continuationResultAttemptId} AS text), '') IS NULL
          OR checkpoint_attempt.id::text =
            CAST(${opts.continuationResultAttemptId} AS text)
        )`;
  const resultMatch =
    opts.continuationResultId === undefined
      ? sql`true`
      : sql`(
          NULLIF(CAST(${opts.continuationResultId} AS text), '') IS NULL
          OR checkpoint_attempt.result_id::text =
            CAST(${opts.continuationResultId} AS text)
        )`;
  return sql`EXISTS (
    SELECT 1
    FROM sim_precalc_obligation_attempts checkpoint_submission
    JOIN sim_precalc_obligations checkpoint_obligation
      ON checkpoint_obligation.id = checkpoint_submission.obligation_id
    JOIN simulation_preset_revisions checkpoint_target_revision
      ON checkpoint_target_revision.id = checkpoint_obligation.revision_id
    JOIN result_attempts checkpoint_attempt
      ON checkpoint_attempt.id = checkpoint_submission.result_attempt_id
    JOIN simulation_preset_revisions checkpoint_revision
      ON checkpoint_revision.id =
        checkpoint_attempt.simulation_preset_revision_id
    LEFT JOIN sim_jobs checkpoint_job
      ON checkpoint_job.id = checkpoint_submission.sim_job_id
    WHERE checkpoint_submission.obligation_id = ${obligationId}
      AND checkpoint_attempt.simulation_preset_revision_id =
        checkpoint_obligation.revision_id
      AND checkpoint_attempt.engine_job_id IS NOT NULL
      AND checkpoint_attempt.engine_case_slug IS NOT NULL
      AND ${compatiblePrecalcCheckpointImplementationSql({
        targetSolverImplementationId,
        targetRevisionSolverImplementationId: sql`checkpoint_target_revision.solver_implementation_id`,
        checkpointRevisionSolverImplementationId: sql`checkpoint_revision.solver_implementation_id`,
        checkpointAttemptSolverImplementationId: sql`checkpoint_attempt.solver_implementation_id`,
        checkpointJobSolverImplementationId: sql`checkpoint_job.solver_implementation_id`,
      })}
      AND ${resultAttemptMatch}
      AND ${resultMatch}
      AND ${restartablePrecalcWarningSql(sql`checkpoint_attempt.quality_warnings`)}
      AND NOT EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_attempts newer_submission
        WHERE newer_submission.obligation_id = checkpoint_submission.obligation_id
          AND newer_submission.attempt_number > checkpoint_submission.attempt_number
          AND NOT (
            ${typedPrecalcInfrastructureInterruptionSql({
              state: sql`newer_submission.state`,
              outcome: sql`newer_submission.outcome`,
              consumesSolverAttempt: sql`newer_submission.consumes_solver_attempt`,
            })}
            OR ${legacyPrecalcInfrastructureInterruptionSql({
              resultAttemptId: sql`newer_submission.result_attempt_id`,
              consumesSolverAttempt: sql`newer_submission.consumes_solver_attempt`,
              simJobId: sql`newer_submission.sim_job_id`,
              error: sql`newer_submission.error`,
              checkpointResultAttemptId: sql`checkpoint_attempt.id`,
              checkpointResultId: sql`checkpoint_attempt.result_id`,
            })}
          )
      )
  )`;
}

/** Reopen only an immutable PRECALC mesh failure produced by an older engine
 * recovery strategy. The failed submission and its result evidence remain
 * untouched, but deterministic setup work does not consume the two-attempt CFD
 * budget. The effective capability version is immutable attempt evidence, so
 * retention may purge the producing sim_job without disabling a later strategy
 * upgrade. Infrastructure/evidence failures and ownerless work are outside
 * this transition by construction. */
export async function requeueDeterministicMeshObligationsForRecoveryVersion(
  db: DB,
  meshRecoveryVersion: number,
  scope: MeshRecoveryRequeueScope = {},
): Promise<MeshRecoveryRequeueResult> {
  if (!Number.isSafeInteger(meshRecoveryVersion) || meshRecoveryVersion <= 0) {
    return { obligationIds: [], campaignIds: [] };
  }
  const scopeSql = meshRecoveryScopeSql(scope);
  const result = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const candidates = (await tx.execute(sql`
      SELECT obligation.id,
             obligation.airfoil_id,
             obligation.revision_id,
             obligation.aoa_deg::float8 AS aoa_deg
      FROM sim_precalc_obligations obligation
      WHERE (${scopeSql})
        AND obligation.state = 'blocked'
        AND obligation.attempt_count < obligation.max_attempts
        AND obligation.last_outcome = 'deterministic_failure'
        AND EXISTS (
          SELECT 1
          FROM sim_precalc_obligation_attempts immutable_attempt
          WHERE immutable_attempt.obligation_id = obligation.id
            AND immutable_attempt.state = 'failed'
            AND immutable_attempt.outcome = 'deterministic_failure'
            AND NOT immutable_attempt.consumes_solver_attempt
            AND immutable_attempt.mesh_recovery_version < ${meshRecoveryVersion}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sim_jobs active_job
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(active_job.request_payload -> 'precalcObligationIds') = 'array'
              THEN active_job.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END
          ) active_payload_obligation(id)
          WHERE active_payload_obligation.id = obligation.id::text
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
            AND accepted_attempt.aoa_deg = obligation.aoa_deg
            AND (
              accepted_attempt.regime = 'urans'
              OR accepted_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
            )
        )
        AND (
          obligation.background_owner
          OR EXISTS (
            SELECT 1
            FROM sim_precalc_obligation_campaigns live_campaign_ownership
            JOIN sim_campaigns live_campaign
              ON live_campaign.id = live_campaign_ownership.campaign_id
             AND live_campaign.status IN ('active', 'attention', 'paused')
            WHERE live_campaign_ownership.obligation_id = obligation.id
              AND live_campaign_ownership.state = 'active'
          )
          OR EXISTS (
            SELECT 1
            FROM sim_precalc_obligation_requests live_request_coverage
            JOIN sim_urans_requests live_request
              ON live_request.id = live_request_coverage.request_id
             AND live_request.background_owner
             AND live_request.state IN ('pending', 'running')
            WHERE live_request_coverage.obligation_id = obligation.id
          )
          OR EXISTS (
            SELECT 1
            FROM sync_sweep_promise_points live_promise_point
            JOIN sync_sweep_promises live_promise
              ON live_promise.id = live_promise_point.promise_id
             AND live_promise.status = 'active'
             AND live_promise."expiresAt" > now()
             AND live_promise.request_payload ->> 'remoteSolver' = 'true'
            WHERE live_promise_point.airfoil_id = obligation.airfoil_id
              AND live_promise_point.simulation_preset_revision_id = obligation.revision_id
              AND live_promise_point.aoa_deg = obligation.aoa_deg
              AND live_promise_point.status = 'active'
          )
        )
      ORDER BY obligation.id
      LIMIT 500
    `)) as unknown as Array<{
      id: string;
      airfoil_id: string;
      revision_id: string;
      aoa_deg: number;
    }>;
    if (!candidates.length) return { obligationIds: [], campaignIds: [] };

    const candidateIds = candidates.map((row) => row.id);
    const candidateIdArray = sql`ARRAY[${sql.join(
      candidateIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
    // Preserve the repository-wide campaign -> remote promise+point ->
    // request ownership lock order before taking natural-cell advisory locks
    // and finally updating obligation rows.
    await tx.execute(sql`
      SELECT campaign.id
      FROM sim_campaigns campaign
      JOIN sim_precalc_obligation_campaigns ownership
        ON ownership.campaign_id = campaign.id
      WHERE ownership.obligation_id = ANY(${candidateIdArray})
      ORDER BY campaign.id
      FOR SHARE OF campaign
    `);
    await tx.execute(sql`
      SELECT promise.id, point.id AS point_id
      FROM sync_sweep_promises promise
      JOIN sync_sweep_promise_points point ON point.promise_id = promise.id
      JOIN sim_precalc_obligations obligation
        ON obligation.airfoil_id = point.airfoil_id
       AND obligation.revision_id = point.simulation_preset_revision_id
       AND obligation.aoa_deg = point.aoa_deg
      WHERE obligation.id = ANY(${candidateIdArray})
      ORDER BY promise.id, point.id
      FOR SHARE OF promise, point
    `);
    await tx.execute(sql`
      SELECT request.id
      FROM sim_urans_requests request
      JOIN sim_precalc_obligation_requests coverage
        ON coverage.request_id = request.id
      WHERE coverage.obligation_id = ANY(${candidateIdArray})
      ORDER BY request.id
      FOR SHARE OF request
    `);
    await lockPrecalcCells(
      tx,
      candidates.map((row) => ({
        airfoilId: row.airfoil_id,
        revisionId: row.revision_id,
        aoaDeg: Number(row.aoa_deg),
      })),
    );

    // Recheck every safety predicate after locks: lifecycle cancellation,
    // accepted late evidence, or a concurrent composition may have won since
    // the bounded candidate read above.
    const reopened = (await tx.execute(sql`
      UPDATE sim_precalc_obligations obligation
      SET state = 'pending',
          submit_failure_count = 0,
          next_submit_at = NULL,
          last_outcome = 'mesh_recovery_upgrade_pending',
          completed_at = NULL,
          "updatedAt" = now()
      WHERE obligation.id = ANY(${candidateIdArray})
        AND obligation.state = 'blocked'
        AND obligation.attempt_count < obligation.max_attempts
        AND obligation.last_outcome = 'deterministic_failure'
        AND EXISTS (
          SELECT 1
          FROM sim_precalc_obligation_attempts immutable_attempt
          WHERE immutable_attempt.obligation_id = obligation.id
            AND immutable_attempt.state = 'failed'
            AND immutable_attempt.outcome = 'deterministic_failure'
            AND NOT immutable_attempt.consumes_solver_attempt
            AND immutable_attempt.mesh_recovery_version < ${meshRecoveryVersion}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sim_jobs active_job
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(active_job.request_payload -> 'precalcObligationIds') = 'array'
              THEN active_job.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END
          ) active_payload_obligation(id)
          WHERE active_payload_obligation.id = obligation.id::text
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
            AND accepted_attempt.aoa_deg = obligation.aoa_deg
            AND (
              accepted_attempt.regime = 'urans'
              OR accepted_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
            )
        )
        AND (${liveOwnerSql(sql`obligation.id`)})
      RETURNING obligation.id
    `)) as unknown as Array<{ id: string }>;
    if (!reopened.length) return { obligationIds: [], campaignIds: [] };
    const reopenedIds = reopened.map((row) => row.id).sort();
    const reopenedIdArray = sql`ARRAY[${sql.join(
      reopenedIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
    const campaigns = (await tx.execute(sql`
      SELECT DISTINCT ownership.campaign_id
      FROM sim_precalc_obligation_campaigns ownership
      JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
      WHERE ownership.obligation_id = ANY(${reopenedIdArray})
        AND ownership.state = 'active'
        AND campaign.status IN ('active', 'attention', 'paused')
      ORDER BY ownership.campaign_id
    `)) as unknown as Array<{ campaign_id: string }>;
    return {
      obligationIds: reopenedIds,
      campaignIds: campaigns.map((row) => row.campaign_id),
    };
  });
  const affectedCampaignIds = await recomputeProgressForPrecalcObligations(
    db,
    result.obligationIds,
  );
  for (const campaignId of [
    ...new Set([...result.campaignIds, ...affectedCampaignIds]),
  ]) {
    await probeCampaignCompletion(db, campaignId);
  }
  return result;
}

/** Bounded capability-upgrade repair for restartable PRECALC obligations.
 *
 * Historical controller versions treated a continuation segment as a fresh
 * solve and could exhaust the two-solve budget when live checkpoint files had
 * been retained only in immutable evidence storage. This transition keeps the
 * immutable submission row and its error, but corrects that exact staging-only
 * interruption to non-physical infrastructure work, restores the physical
 * count from the remaining solver ordinals, and reopens the obligation.
 *
 * A blocked obligation whose newest physical evidence is itself restartable
 * is also reopened at max_attempts: further same-case integration is not a new
 * fresh solve. Numerical failures, non-continuation jobs, active work,
 * accepted evidence, and ownerless cells are excluded. */
export async function requeueRestartablePrecalcContinuations(
  db: DB,
  scope: MeshRecoveryRequeueScope = {},
): Promise<PrecalcContinuationRecoveryResult> {
  const empty: PrecalcContinuationRecoveryResult = {
    obligationIds: [],
    campaignIds: [],
    requestIds: [],
    repairedSubmissionIds: [],
  };
  const scopeSql = meshRecoveryScopeSql(scope);
  const result = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const candidates = (await tx.execute(sql`
      SELECT obligation.id,
             obligation.airfoil_id,
             obligation.revision_id,
             obligation.aoa_deg::float8 AS aoa_deg,
             checkpoint.submission_number AS checkpoint_submission_number,
             checkpoint.result_attempt_id AS checkpoint_result_attempt_id,
             checkpoint.result_id AS checkpoint_result_id
      FROM sim_precalc_obligations obligation
      JOIN simulation_preset_revisions target_revision
        ON target_revision.id = obligation.revision_id
      JOIN LATERAL (
        SELECT checkpoint_submission.attempt_number AS submission_number,
               checkpoint_attempt.id AS result_attempt_id,
               checkpoint_attempt.result_id
        FROM sim_precalc_obligation_attempts checkpoint_submission
        JOIN result_attempts checkpoint_attempt
          ON checkpoint_attempt.id = checkpoint_submission.result_attempt_id
        JOIN simulation_preset_revisions checkpoint_revision
          ON checkpoint_revision.id =
            checkpoint_attempt.simulation_preset_revision_id
        LEFT JOIN sim_jobs checkpoint_job
          ON checkpoint_job.id = checkpoint_submission.sim_job_id
        WHERE checkpoint_submission.obligation_id = obligation.id
          AND checkpoint_attempt.simulation_preset_revision_id =
            obligation.revision_id
          AND checkpoint_attempt.engine_job_id IS NOT NULL
          AND checkpoint_attempt.engine_case_slug IS NOT NULL
          AND ${compatiblePrecalcCheckpointImplementationSql({
            targetSolverImplementationId: sql`target_revision.solver_implementation_id`,
            targetRevisionSolverImplementationId: sql`target_revision.solver_implementation_id`,
            checkpointRevisionSolverImplementationId: sql`checkpoint_revision.solver_implementation_id`,
            checkpointAttemptSolverImplementationId: sql`checkpoint_attempt.solver_implementation_id`,
            checkpointJobSolverImplementationId: sql`checkpoint_job.solver_implementation_id`,
          })}
          AND ${restartablePrecalcWarningSql(sql`checkpoint_attempt.quality_warnings`)}
          AND NOT EXISTS (
            SELECT 1
            FROM sim_precalc_obligation_attempts newer_submission
            WHERE newer_submission.obligation_id = checkpoint_submission.obligation_id
              AND newer_submission.attempt_number > checkpoint_submission.attempt_number
              AND NOT (
                ${typedPrecalcInfrastructureInterruptionSql({
                  state: sql`newer_submission.state`,
                  outcome: sql`newer_submission.outcome`,
                  consumesSolverAttempt: sql`newer_submission.consumes_solver_attempt`,
                })}
                OR ${legacyPrecalcInfrastructureInterruptionSql({
                  resultAttemptId: sql`newer_submission.result_attempt_id`,
                  consumesSolverAttempt: sql`newer_submission.consumes_solver_attempt`,
                  simJobId: sql`newer_submission.sim_job_id`,
                  error: sql`newer_submission.error`,
                  checkpointResultAttemptId: sql`checkpoint_attempt.id`,
                  checkpointResultId: sql`checkpoint_attempt.result_id`,
                })}
              )
          )
        ORDER BY checkpoint_submission.attempt_number DESC
        LIMIT 1
      ) checkpoint ON true
      WHERE (${scopeSql})
        AND obligation.state = 'blocked'
        AND obligation.continuation_segment_count <
          ${MAX_PRECALC_CONTINUATION_SEGMENTS}
        AND obligation.continuation_no_progress_count <
          ${MAX_PRECALC_NO_PROGRESS_SEGMENTS}
        AND COALESCE(obligation.last_outcome, '') NOT IN (
          'continuation_no_progress_exhausted',
          'continuation_segment_exhausted'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sim_jobs active_job
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(active_job.request_payload -> 'precalcObligationIds') = 'array'
              THEN active_job.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END
          ) active_payload_obligation(id)
          WHERE active_payload_obligation.id = obligation.id::text
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
            AND accepted_attempt.aoa_deg = obligation.aoa_deg
            AND (
              accepted_attempt.regime = 'urans'
              OR accepted_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
            )
        )
        AND (
          (${liveOwnerSql(sql`obligation.id`)})
          OR EXISTS (
            SELECT 1
            FROM sim_precalc_obligation_requests repair_coverage
            JOIN sim_urans_requests repair_request
              ON repair_request.id = repair_coverage.request_id
             AND repair_request.background_owner
             AND repair_request.state = 'blocked'
            WHERE repair_coverage.obligation_id = obligation.id
          )
        )
      ORDER BY obligation.id
      LIMIT 500
    `)) as unknown as Array<{
      id: string;
      airfoil_id: string;
      revision_id: string;
      aoa_deg: number;
      checkpoint_submission_number: number;
      checkpoint_result_attempt_id: string;
      checkpoint_result_id: string | null;
    }>;
    if (!candidates.length) return empty;

    const candidateIds = candidates.map((row) => row.id);
    const candidateIdArray = sql`ARRAY[${sql.join(
      candidateIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
    await tx.execute(sql`
      SELECT campaign.id
      FROM sim_campaigns campaign
      JOIN sim_precalc_obligation_campaigns ownership
        ON ownership.campaign_id = campaign.id
      WHERE ownership.obligation_id = ANY(${candidateIdArray})
      ORDER BY campaign.id
      FOR SHARE OF campaign
    `);
    await tx.execute(sql`
      SELECT promise.id, point.id AS point_id
      FROM sync_sweep_promises promise
      JOIN sync_sweep_promise_points point ON point.promise_id = promise.id
      JOIN sim_precalc_obligations obligation
        ON obligation.airfoil_id = point.airfoil_id
       AND obligation.revision_id = point.simulation_preset_revision_id
       AND obligation.aoa_deg = point.aoa_deg
      WHERE obligation.id = ANY(${candidateIdArray})
      ORDER BY promise.id, point.id
      FOR SHARE OF promise, point
    `);
    await tx.execute(sql`
      SELECT request.id
      FROM sim_urans_requests request
      JOIN sim_precalc_obligation_requests coverage
        ON coverage.request_id = request.id
      WHERE coverage.obligation_id = ANY(${candidateIdArray})
      ORDER BY request.id
      FOR SHARE OF request
    `);
    await lockPrecalcCells(
      tx,
      candidates.map((row) => ({
        airfoilId: row.airfoil_id,
        revisionId: row.revision_id,
        aoaDeg: Number(row.aoa_deg),
      })),
    );

    const checkpointValues = sql.join(
      candidates.map(
        (row) =>
          sql`(${row.id}::uuid, ${row.checkpoint_submission_number}::int, ${row.checkpoint_result_attempt_id}::uuid, ${row.checkpoint_result_id}::uuid)`,
      ),
      sql`, `,
    );
    const repaired = (await tx.execute(sql`
      UPDATE sim_precalc_obligation_attempts interruption
      SET state = 'cancelled',
          outcome = 'infrastructure_retry_wait',
          solver_attempt_number = NULL,
          consumes_solver_attempt = false,
          completed_at = COALESCE(interruption.completed_at, now()),
          "updatedAt" = now()
      FROM (
        VALUES ${checkpointValues}
      ) AS checkpoint(
        obligation_id,
        submission_number,
        result_attempt_id,
        result_id
      )
      WHERE interruption.obligation_id = checkpoint.obligation_id
        AND interruption.attempt_number > checkpoint.submission_number
        AND ${legacyPrecalcInfrastructureInterruptionSql({
          resultAttemptId: sql`interruption.result_attempt_id`,
          consumesSolverAttempt: sql`interruption.consumes_solver_attempt`,
          simJobId: sql`interruption.sim_job_id`,
          error: sql`interruption.error`,
          checkpointResultAttemptId: sql`checkpoint.result_attempt_id`,
          checkpointResultId: sql`checkpoint.result_id`,
        })}
      RETURNING interruption.id
    `)) as unknown as Array<{ id: string }>;

    const reopened = (await tx.execute(sql`
      UPDATE sim_precalc_obligations obligation
      SET state = 'pending',
          attempt_count = (
            SELECT COALESCE(MAX(physical_attempt.solver_attempt_number), 0)::int
            FROM sim_precalc_obligation_attempts physical_attempt
            WHERE physical_attempt.obligation_id = obligation.id
              AND physical_attempt.consumes_solver_attempt
          ),
          submit_failure_count = 0,
          next_submit_at = NULL,
          last_outcome = 'continuation_recovery_pending',
          last_error = NULL,
          completed_at = NULL,
          "updatedAt" = now()
      WHERE obligation.id = ANY(${candidateIdArray})
        AND obligation.state = 'blocked'
        AND obligation.continuation_segment_count <
          ${MAX_PRECALC_CONTINUATION_SEGMENTS}
        AND obligation.continuation_no_progress_count <
          ${MAX_PRECALC_NO_PROGRESS_SEGMENTS}
        AND COALESCE(obligation.last_outcome, '') NOT IN (
          'continuation_no_progress_exhausted',
          'continuation_segment_exhausted'
        )
        AND ${restartablePrecalcCheckpointSql(sql`obligation.id`)}
        AND NOT EXISTS (
          SELECT 1
          FROM sim_jobs active_job
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(active_job.request_payload -> 'precalcObligationIds') = 'array'
              THEN active_job.request_payload -> 'precalcObligationIds'
              ELSE '[]'::jsonb
            END
          ) active_payload_obligation(id)
          WHERE active_payload_obligation.id = obligation.id::text
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
            AND accepted_attempt.aoa_deg = obligation.aoa_deg
            AND (
              accepted_attempt.regime = 'urans'
              OR accepted_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
            )
        )
        AND (
          (${liveOwnerSql(sql`obligation.id`)})
          OR EXISTS (
            SELECT 1
            FROM sim_precalc_obligation_requests repair_coverage
            JOIN sim_urans_requests repair_request
              ON repair_request.id = repair_coverage.request_id
             AND repair_request.background_owner
             AND repair_request.state = 'blocked'
            WHERE repair_coverage.obligation_id = obligation.id
          )
        )
      RETURNING obligation.id
    `)) as unknown as Array<{ id: string }>;
    if (!reopened.length) {
      return {
        ...empty,
        repairedSubmissionIds: repaired.map((row) => row.id).sort(),
      };
    }

    const reopenedIds = reopened.map((row) => row.id).sort();
    const reopenedIdArray = sql`ARRAY[${sql.join(
      reopenedIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`;
    const requests = (await tx.execute(sql`
      UPDATE sim_urans_requests request
      SET state = 'pending',
          sim_job_id = NULL,
          "updatedAt" = now()
      WHERE request.state = 'blocked'
        AND (
          request.background_owner
          OR EXISTS (
            SELECT 1
            FROM sim_urans_request_campaigns request_ownership
            JOIN sim_campaigns request_campaign
              ON request_campaign.id = request_ownership.campaign_id
            WHERE request_ownership.request_id = request.id
              AND request_ownership.state = 'active'
              AND request_campaign.status IN ('active', 'attention', 'paused')
          )
        )
        AND EXISTS (
          SELECT 1
          FROM sim_precalc_obligation_requests coverage
          WHERE coverage.request_id = request.id
            AND coverage.obligation_id = ANY(${reopenedIdArray})
        )
      RETURNING request.id
    `)) as unknown as Array<{ id: string }>;
    const campaigns = (await tx.execute(sql`
      SELECT DISTINCT ownership.campaign_id
      FROM sim_precalc_obligation_campaigns ownership
      JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
      WHERE ownership.obligation_id = ANY(${reopenedIdArray})
        AND ownership.state = 'active'
        AND campaign.status IN ('active', 'attention', 'paused')
      ORDER BY ownership.campaign_id
    `)) as unknown as Array<{ campaign_id: string }>;
    return {
      obligationIds: reopenedIds,
      campaignIds: campaigns.map((row) => row.campaign_id),
      requestIds: requests.map((row) => row.id).sort(),
      repairedSubmissionIds: repaired.map((row) => row.id).sort(),
    };
  });
  const affectedCampaignIds = await recomputeProgressForPrecalcObligations(
    db,
    result.obligationIds,
  );
  for (const campaignId of [
    ...new Set([...result.campaignIds, ...affectedCampaignIds]),
  ]) {
    await probeCampaignCompletion(db, campaignId);
  }
  return result;
}

export interface PrecalcSettlement {
  pending: string[];
  satisfied: string[];
  blocked: string[];
  /** Live-owner continuation sources proven permanently invalid before CFD.
   * These are critical non-physical incidents, not exhausted solver evidence. */
  continuationPermanent: string[];
  cancelled: string[];
  campaignIds: string[];
}

export type PrecalcRequestProjectedState =
  | "pending"
  | "blocked"
  | "cancelled"
  | "done";

/** One projection for every PRECALC request call site. Open physical work
 * stays pending; exhausted work is blocked; accepted truth is done; an
 * all-cancelled (or malformed empty) coverage set is cancelled. In a mixed
 * satisfied/cancelled terminal set, satisfied wins because the request did
 * deliver useful evidence. */
export async function precalcRequestStateFromObligations(
  db: DB,
  requestId: string,
): Promise<PrecalcRequestProjectedState> {
  const [coverage] = (await db.execute(sql`
    SELECT
      COALESCE(bool_or(obligation.state IN ('pending', 'running')), false) AS open,
      COALESCE(bool_or(obligation.state = 'blocked'), false) AS blocked,
      COALESCE(bool_or(obligation.state = 'satisfied'), false) AS satisfied,
      COALESCE(bool_or(obligation.state = 'cancelled'), false) AS cancelled
    FROM sim_precalc_obligation_requests item
    JOIN sim_precalc_obligations obligation
      ON obligation.id = item.obligation_id
    WHERE item.request_id = ${requestId}
  `)) as unknown as Array<{
    open: boolean;
    blocked: boolean;
    satisfied: boolean;
    cancelled: boolean;
  }>;
  if (coverage?.open) return "pending";
  if (coverage?.blocked) return "blocked";
  if (coverage?.satisfied) return "done";
  return "cancelled";
}

const ANSWERED_SUBMIT_RETRY_BACKOFF_MS = 30_000;
const INFRASTRUCTURE_RETRY_BACKOFF_MS = 30_000;

export interface PrecalcSubmitFailureSettlement {
  retryWait: string[];
  blocked: string[];
  campaignIds: string[];
  nextSubmitAt: Date | null;
}

/** Transaction-scoped core used by the guarded engine-submit boundary. The
 * caller owns the surrounding transaction so the sim_job failure and physical
 * obligation policy commit atomically. */
export async function recordPrecalcObligationSubmitFailureInTransaction(
  tx: DB,
  simJobId: string,
  obligationIds: string[],
  error: string,
  httpStatus: number | null,
): Promise<PrecalcSubmitFailureSettlement> {
  const result: PrecalcSubmitFailureSettlement = {
    retryWait: [],
    blocked: [],
    campaignIds: [],
    nextSubmitAt: null,
  };
  if (!obligationIds.length) return result;
  const retryable5xx =
    httpStatus !== null && httpStatus >= 500 && httpStatus < 600;
  const retryAt = new Date(Date.now() + ANSWERED_SUBMIT_RETRY_BACKOFF_MS);
  const obligations = await tx
    .select()
    .from(simPrecalcObligations)
    .where(inArray(simPrecalcObligations.id, obligationIds))
    .orderBy(asc(simPrecalcObligations.id))
    .for("update");
  for (const obligation of obligations) {
    if (["satisfied", "blocked", "cancelled"].includes(obligation.state))
      continue;
    // Idempotent replay of the same failed composition must not consume the
    // 5xx allowance twice. A newer lease is never settled by an older job.
    if (obligation.latestSimJobId !== simJobId) continue;
    if (
      obligation.lastOutcome === "submit_retry_wait" &&
      obligation.lastError === error
    ) {
      result.retryWait.push(obligation.id);
      continue;
    }
    const retry = retryable5xx && obligation.submitFailureCount < 1;
    const nextCount = Math.min(2, obligation.submitFailureCount + 1);
    await tx
      .update(simPrecalcObligations)
      .set({
        state: retry ? "pending" : "blocked",
        latestSimJobId: simJobId,
        submitFailureCount: nextCount,
        nextSubmitAt: retry ? retryAt : null,
        lastOutcome: retry ? "submit_retry_wait" : "submit_blocked",
        lastError: error,
        completedAt: retry ? null : new Date(),
      })
      .where(eq(simPrecalcObligations.id, obligation.id));
    (retry ? result.retryWait : result.blocked).push(obligation.id);
  }
  const owners = (await tx.execute(sql`
    SELECT DISTINCT ownership.campaign_id
    FROM sim_precalc_obligation_campaigns ownership
    WHERE ownership.obligation_id = ANY(${sql`ARRAY[${sql.join(
      obligationIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})
      AND ownership.state = 'active'
  `)) as unknown as Array<{ campaign_id: string }>;
  result.campaignIds = owners.map((row) => row.campaign_id);
  result.nextSubmitAt = result.retryWait.length ? retryAt : null;
  return result;
}

/** An answered engine submit is execution-policy evidence, never CFD
 * evidence. A deterministic/unknown/4xx rejection blocks immediately; a 5xx
 * gets one durable backoff and the second answered failure blocks. Connection
 * failures never call this helper and consume no budget. */
export async function recordPrecalcObligationSubmitFailure(
  db: DB,
  simJobId: string,
  obligationIds: string[],
  error: string,
  httpStatus: number | null,
): Promise<PrecalcSubmitFailureSettlement> {
  const result = await db.transaction((rawTx) =>
    recordPrecalcObligationSubmitFailureInTransaction(
      rawTx as unknown as DB,
      simJobId,
      obligationIds,
      error,
      httpStatus,
    ),
  );
  for (const campaignId of result.campaignIds) {
    await recomputeProgressForCampaign(db, campaignId);
    await probeCampaignCompletion(db, campaignId);
  }
  return result;
}

function hasPrecalcContinuationWarning(warnings: string[] | null): boolean {
  return (warnings ?? []).some(
    (warning) =>
      warning.includes(URANS_BUDGET_STOP_MARKER) ||
      warning.includes(URANS_CONTINUATION_REQUIRED_MARKER),
  );
}

export interface PrecalcContinuationProgress {
  periodsRetained: number | null;
  simulatedTimeS: number | null;
  periodS: number | null;
  driftFrac: number | null;
  stationary: boolean | null;
}

const finiteMetric = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

/** Extract only real engine measurements from the immutable PolarPoint
 * evidence payload. Missing/legacy data stays null. */
export function precalcContinuationProgressFromEvidence(
  evidencePayload: unknown,
): PrecalcContinuationProgress {
  const payload =
    evidencePayload != null &&
    typeof evidencePayload === "object" &&
    !Array.isArray(evidencePayload)
      ? (evidencePayload as Record<string, unknown>)
      : null;
  const frameTrack =
    payload?.frame_track != null &&
    typeof payload.frame_track === "object" &&
    !Array.isArray(payload.frame_track)
      ? (payload.frame_track as Record<string, unknown>)
      : null;
  const window =
    frameTrack?.window != null &&
    typeof frameTrack.window === "object" &&
    !Array.isArray(frameTrack.window)
      ? (frameTrack.window as Record<string, unknown>)
      : null;
  return {
    periodsRetained: finiteMetric(frameTrack?.periods_retained),
    simulatedTimeS: finiteMetric(window?.t_end),
    periodS: finiteMetric(frameTrack?.period_s),
    driftFrac: finiteMetric(frameTrack?.drift_frac),
    stationary:
      typeof frameTrack?.stationary === "boolean"
        ? frameTrack.stationary
        : null,
  };
}

/** Meaningful progress is phase evidence, not a heartbeat. A continuation
 * must add at least a quarter measured period (or a conservative time floor
 * when no period is measurable), materially lower drift, or become
 * stationary. */
export function precalcContinuationMadeProgress(
  previous: PrecalcContinuationProgress | null,
  current: PrecalcContinuationProgress,
): boolean {
  if (current.stationary === true && previous?.stationary !== true) return true;
  if (!previous) {
    return (
      current.periodsRetained != null ||
      current.simulatedTimeS != null ||
      current.driftFrac != null ||
      current.stationary != null
    );
  }
  if (
    current.periodsRetained != null &&
    previous.periodsRetained != null &&
    current.periodsRetained - previous.periodsRetained >= 0.25
  ) {
    return true;
  }
  if (current.simulatedTimeS != null && previous.simulatedTimeS != null) {
    const measuredPeriod = current.periodS ?? previous.periodS;
    const requiredDelta =
      measuredPeriod != null
        ? Math.max(1e-6, measuredPeriod * 0.25)
        : Math.max(1e-4, Math.abs(previous.simulatedTimeS) * 0.01);
    if (current.simulatedTimeS - previous.simulatedTimeS >= requiredDelta) {
      return true;
    }
  }
  return Boolean(
    current.driftFrac != null &&
    previous.driftFrac != null &&
    previous.driftFrac > 0 &&
    current.driftFrac <= previous.driftFrac * 0.9,
  );
}

export interface PrecalcTerminalSettlementOptions {
  terminalError?: string | null;
  /** Typed job-level failure for errors that happened before any per-angle
   * attempt existed. A present typed value is authoritative over legacy text. */
  terminalFailureDisposition?:
    | "none"
    | "hard_solver"
    | "deterministic_mesh"
    | "infrastructure"
    | null;
  /** Typed continuation-stage failure emitted by the engine before CFD starts.
   * Transient failures retry the same immutable source after backoff. Permanent
   * failures block explicitly; they never silently start a fresh physical run. */
  terminalContinuationFailureKind?: "transient" | "permanent" | null;
  /** Explicit cancellation records a cancelled attempt. A lost engine task,
   * worker restart, or stale recovery is transient infrastructure failure. */
  cancellation?: "transient" | "explicit";
}

/** Transaction-scoped terminal settlement. The caller may atomically combine
 * a job transition, result-claim release, request-owner cancellation, and the
 * exact payload-owned PRECALC ledger transition. */
export async function settlePrecalcObligationsForJobInTransaction(
  tx: DB,
  job: Pick<
    SimJob,
    | "id"
    | "airfoilId"
    | "simulationPresetRevisionId"
    | "requestPayload"
    | "engineJobId"
    | "submittedAt"
  >,
  opts: PrecalcTerminalSettlementOptions = {},
): Promise<PrecalcSettlement> {
  const payload = (job.requestPayload ?? {}) as {
    precalcObligationIds?: unknown;
    uransFidelity?: unknown;
    executedMeshRecoveryVersion?: unknown;
  };
  const acknowledgedMeshRecoveryVersion =
    typeof payload.executedMeshRecoveryVersion === "number" &&
    Number.isSafeInteger(payload.executedMeshRecoveryVersion) &&
    payload.executedMeshRecoveryVersion >= 0 &&
    payload.executedMeshRecoveryVersion <= 2_147_483_647
      ? payload.executedMeshRecoveryVersion
      : 0;
  const obligationIds = Array.isArray(payload.precalcObligationIds)
    ? payload.precalcObligationIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  const sameCaseContinuation = isSameCasePrecalcContinuation(
    job.requestPayload,
    obligationIds.length,
  );
  const outcome: PrecalcSettlement = {
    pending: [],
    satisfied: [],
    blocked: [],
    continuationPermanent: [],
    cancelled: [],
    campaignIds: [],
  };
  if (!obligationIds.length) return outcome;

  const campaignIds = (await tx.execute(sql`
    SELECT DISTINCT ownership.campaign_id
    FROM sim_precalc_obligation_campaigns ownership
    WHERE ownership.obligation_id = ANY(${sql`ARRAY[${sql.join(
      obligationIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})
      AND ownership.state = 'active'
  `)) as unknown as Array<{ campaign_id: string }>;
  outcome.campaignIds = campaignIds.map((row) => row.campaign_id);

  const obligations = await tx
    .select()
    .from(simPrecalcObligations)
    .where(inArray(simPrecalcObligations.id, obligationIds))
    .orderBy(asc(simPrecalcObligations.id))
    .for("update");
  for (const obligation of obligations) {
    if (
      obligation.airfoilId !== job.airfoilId ||
      obligation.revisionId !== job.simulationPresetRevisionId
    ) {
      continue;
    }
    let [submission] = await tx
      .select()
      .from(simPrecalcObligationAttempts)
      .where(
        and(
          eq(simPrecalcObligationAttempts.obligationId, obligation.id),
          eq(simPrecalcObligationAttempts.simJobId, job.id),
        ),
      )
      .limit(1);
    // Crash recovery: the job row proves the engine boundary was crossed,
    // even if the process died before recording the ledger attempt.
    const ownsCompositionLease =
      obligation.latestSimJobId == null || obligation.latestSimJobId === job.id;
    if (
      !submission &&
      ownsCompositionLease &&
      (job.engineJobId || job.submittedAt)
    ) {
      const solverAttemptNumber = sameCaseContinuation
        ? null
        : Math.min(obligation.maxAttempts, obligation.attemptCount + 1);
      const nextAttemptCount =
        solverAttemptNumber == null
          ? obligation.attemptCount
          : Math.max(obligation.attemptCount, solverAttemptNumber);
      const attemptNumber = await nextPrecalcSubmissionSequence(
        tx,
        obligation.id,
      );
      [submission] = await tx
        .insert(simPrecalcObligationAttempts)
        .values({
          obligationId: obligation.id,
          simJobId: job.id,
          attemptNumber,
          solverAttemptNumber,
          consumesSolverAttempt: !sameCaseContinuation,
          state: "submitted",
        })
        .onConflictDoNothing()
        .returning();
      if (submission) {
        await tx
          .update(simPrecalcObligations)
          .set({
            attemptCount: nextAttemptCount,
            latestSimJobId: job.id,
            lastAttemptAt: new Date(),
          })
          .where(eq(simPrecalcObligations.id, obligation.id));
        obligation.attemptCount = nextAttemptCount;
      }
    }

    const evidence = await tx
      .select({
        id: resultAttempts.id,
        status: resultAttempts.status,
        regime: resultAttempts.regime,
        error: resultAttempts.error,
        engineJobId: resultAttempts.engineJobId,
        engineCaseSlug: resultAttempts.engineCaseSlug,
        qualityWarnings: resultAttempts.qualityWarnings,
        evidencePayload: resultAttempts.evidencePayload,
        solverImplementationId: resultAttempts.solverImplementationId,
        fidelity: sql<
          string | null
        >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
        failureDisposition: sql<
          string | null
        >`${resultAttempts.evidencePayload} ->> 'failure_disposition'`,
        classification: resultClassifications.state,
        reasons: resultClassifications.reasons,
      })
      .from(resultAttempts)
      .leftJoin(
        resultClassifications,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(
        and(
          eq(resultAttempts.simJobId, job.id),
          eq(resultAttempts.airfoilId, obligation.airfoilId),
          eq(resultAttempts.simulationPresetRevisionId, obligation.revisionId),
          eq(resultAttempts.aoaDeg, obligation.aoaDeg),
        ),
      );
    const exactPrecalcJob =
      payload.uransFidelity === "precalc" &&
      obligationIds.includes(obligation.id);
    // Accepted/rejected PRECALC candidates must carry actual URANS-tier
    // evidence. A same-job RANS-shaped row is not preliminary evidence and
    // can never satisfy the obligation merely because the payload named the
    // cell. A failure before pimpleFoam starts can honestly echo RANS, so exact
    // same-job typed execution failures remain eligible for retry policy; the
    // legacy text fallback remains limited to its paired deterministic mesh
    // markers. The exact payload plus the sim_job/airfoil/revision/AoA query
    // above fences both paths to this physical submission, and any typed
    // disposition remains authoritative over legacy error wording.
    const precalcEvidence = evidence.filter(
      (row) => row.fidelity === "urans_precalc" || row.regime === "urans",
    );
    const exactPrecalcFailureFallback = exactPrecalcJob
      ? (evidence.find(
          (row) =>
            row.status === "failed" &&
            ((row.failureDisposition != null &&
              row.failureDisposition !== "none") ||
              (row.failureDisposition == null &&
                isDeterministicMeshBlockerError(row.error))),
        ) ?? null)
      : null;
    const accepted = precalcEvidence.find(
      (row) =>
        row.classification === "accepted" &&
        !hasPrecalcContinuationWarning(row.qualityWarnings),
    );
    const judged =
      accepted ??
      precalcEvidence.find((row) => row.classification != null) ??
      precalcEvidence[0] ??
      exactPrecalcFailureFallback ??
      null;
    const error = judged?.error ?? opts.terminalError ?? null;
    const failureDisposition =
      judged?.failureDisposition ?? opts.terminalFailureDisposition ?? null;
    // This signal applies only to exact same-case continuation jobs. A malformed
    // engine response on fresh work must not manufacture a permanent checkpoint
    // incident or bypass the ordinary physical-attempt policy.
    const continuationFailureKind = sameCaseContinuation
      ? (opts.terminalContinuationFailureKind ?? null)
      : null;
    const continuationPermanent = continuationFailureKind === "permanent";
    const continuationTransient = continuationFailureKind === "transient";
    const deterministic = Boolean(
      continuationFailureKind == null &&
      (failureDisposition === "deterministic_mesh" ||
        (failureDisposition == null && isDeterministicMeshBlockerError(error))),
    );
    const restartable = Boolean(
      judged?.engineJobId &&
      judged.engineCaseSlug &&
      hasPrecalcContinuationWarning(judged.qualityWarnings),
    );
    // Cache refresh classifies every stored attempt, including execution
    // failures such as a divergence watchdog trip. Classification presence
    // must not turn a raw failed attempt into a physics rejection and spend
    // its one corrective solve. A completed/status-done rejected window is
    // still non-retryable unless it carries an explicit continuation marker.
    const transientFailure = Boolean(
      error && !deterministic && (!judged || judged.status === "failed"),
    );
    const infrastructure = Boolean(
      continuationTransient ||
      failureDisposition === "infrastructure" ||
      (opts.cancellation === "transient" && !judged),
    );
    const [owner] = (await tx.execute(sql`
        SELECT (${liveOwnerSql(obligation.id)}) AS live
      `)) as unknown as Array<{ live: boolean }>;
    const currentProgress = precalcContinuationProgressFromEvidence(
      judged?.evidencePayload,
    );
    const physicalContinuationSegment = Boolean(
      sameCaseContinuation &&
      judged &&
      !continuationPermanent &&
      !continuationTransient &&
      !infrastructure &&
      !deterministic,
    );
    let continuationSegmentNumber: number | null = null;
    let continuationProgressed: boolean | null = null;
    let continuationSegmentCount = obligation.continuationSegmentCount;
    let continuationNoProgressCount = obligation.continuationNoProgressCount;
    if (physicalContinuationSegment) {
      const [priorRow] = (await tx.execute(sql`
        SELECT
          prior.progress_periods_retained,
          prior.progress_simulated_time_s,
          prior.progress_drift_frac,
          prior.progress_stationary,
          prior_evidence.evidence_payload
        FROM sim_precalc_obligation_attempts prior
        LEFT JOIN result_attempts prior_evidence
          ON prior_evidence.id = prior.result_attempt_id
        WHERE prior.obligation_id = ${obligation.id}
          AND prior.result_attempt_id IS NOT NULL
          ${
            submission
              ? sql`AND prior.attempt_number < ${submission.attemptNumber}`
              : sql``
          }
        ORDER BY prior.attempt_number DESC
        LIMIT 1
      `)) as unknown as Array<{
        progress_periods_retained: number | null;
        progress_simulated_time_s: number | null;
        progress_drift_frac: number | null;
        progress_stationary: boolean | null;
        evidence_payload: unknown;
      }>;
      const fallbackPrior = precalcContinuationProgressFromEvidence(
        priorRow?.evidence_payload,
      );
      const previousProgress = priorRow
        ? {
            periodsRetained:
              priorRow.progress_periods_retained ??
              fallbackPrior.periodsRetained,
            simulatedTimeS:
              priorRow.progress_simulated_time_s ??
              fallbackPrior.simulatedTimeS,
            periodS: fallbackPrior.periodS,
            driftFrac: priorRow.progress_drift_frac ?? fallbackPrior.driftFrac,
            stationary:
              priorRow.progress_stationary ?? fallbackPrior.stationary,
          }
        : null;
      continuationSegmentNumber = obligation.continuationSegmentCount + 1;
      continuationProgressed = precalcContinuationMadeProgress(
        previousProgress,
        currentProgress,
      );
      continuationSegmentCount = continuationSegmentNumber;
      continuationNoProgressCount = continuationProgressed
        ? 0
        : obligation.continuationNoProgressCount + 1;
    }
    const continuationNoProgressExhausted = Boolean(
      physicalContinuationSegment &&
      !accepted &&
      restartable &&
      continuationNoProgressCount >= MAX_PRECALC_NO_PROGRESS_SEGMENTS,
    );
    const continuationSegmentExhausted = Boolean(
      sameCaseContinuation &&
      !accepted &&
      (obligation.continuationSegmentCount >=
        MAX_PRECALC_CONTINUATION_SEGMENTS ||
        (physicalContinuationSegment &&
          restartable &&
          continuationSegmentCount >= MAX_PRECALC_CONTINUATION_SEGMENTS)),
    );

    // Engine acceptance proves a submission happened, not that a physical CFD
    // attempt happened. Release the reserved solver ordinal only for typed
    // continuation-stage, infrastructure, or deterministic setup/mesh
    // outcomes. The completed submission row remains immutable audit and
    // future submissions advance attempt_number while reusing the still-
    // available physical ordinal.
    const releasesSolverAttempt = Boolean(
      submission?.consumesSolverAttempt &&
      !accepted &&
      (continuationPermanent || infrastructure || deterministic),
    );
    if (releasesSolverAttempt) {
      obligation.attemptCount = Math.max(0, obligation.attemptCount - 1);
    }

    let state: "pending" | "satisfied" | "blocked" | "cancelled";
    let attemptState: "accepted" | "rejected" | "failed" | "cancelled";
    let lastOutcome: string;
    if (accepted) {
      state = "satisfied";
      attemptState = "accepted";
      lastOutcome = "accepted";
    } else if (!owner?.live) {
      state = "cancelled";
      attemptState = "cancelled";
      lastOutcome = "ownerless";
    } else if (continuationPermanent) {
      state = "blocked";
      attemptState = "failed";
      lastOutcome = "continuation_permanent_failure";
    } else if (
      continuationNoProgressExhausted ||
      continuationSegmentExhausted
    ) {
      state = "blocked";
      attemptState = infrastructure
        ? "cancelled"
        : judged?.classification
          ? "rejected"
          : "failed";
      lastOutcome = continuationNoProgressExhausted
        ? "continuation_no_progress_exhausted"
        : "continuation_segment_exhausted";
    } else if (infrastructure) {
      state = "pending";
      attemptState = "cancelled";
      lastOutcome = "infrastructure_retry_wait";
    } else if (deterministic) {
      state = "blocked";
      attemptState = "failed";
      lastOutcome = "deterministic_failure";
    } else if (opts.cancellation === "explicit") {
      state =
        obligation.attemptCount < obligation.maxAttempts
          ? "pending"
          : "blocked";
      attemptState = "cancelled";
      lastOutcome = state === "pending" ? "cancelled" : "cancelled_exhausted";
    } else if (
      restartable ||
      (obligation.attemptCount < obligation.maxAttempts && transientFailure)
    ) {
      state = "pending";
      attemptState = transientFailure
        ? "failed"
        : judged?.classification
          ? "rejected"
          : "failed";
      lastOutcome = transientFailure
        ? "failed"
        : judged?.classification
          ? "rejected"
          : "failed";
    } else {
      state = "blocked";
      attemptState = transientFailure
        ? "failed"
        : judged?.classification
          ? "rejected"
          : "failed";
      lastOutcome = transientFailure
        ? "failed_exhausted"
        : judged?.classification
          ? "rejected_exhausted"
          : "failed_exhausted";
    }

    if (submission) {
      await tx
        .update(simPrecalcObligationAttempts)
        .set({
          state: attemptState,
          outcome: lastOutcome,
          // First acknowledged execution truth wins. Submission-time desired
          // capability is not evidence; old workers therefore remain v0.
          meshRecoveryVersion: sql`CASE
            WHEN ${simPrecalcObligationAttempts.meshRecoveryVersion} = 0
            THEN ${acknowledgedMeshRecoveryVersion}
            ELSE ${simPrecalcObligationAttempts.meshRecoveryVersion}
          END`,
          continuationSegmentNumber,
          progressPeriodsRetained: currentProgress.periodsRetained,
          progressSimulatedTimeS: currentProgress.simulatedTimeS,
          progressDriftFrac: currentProgress.driftFrac,
          progressStationary: currentProgress.stationary,
          continuationProgressed,
          resultAttemptId: judged?.id ?? null,
          error,
          completedAt: new Date(),
          ...(releasesSolverAttempt
            ? {
                consumesSolverAttempt: false,
                solverAttemptNumber: null,
              }
            : {}),
        })
        .where(eq(simPrecalcObligationAttempts.id, submission.id));
    }
    // Accepted CFD evidence is physical ground truth even if it arrives
    // after a newer composition lease was installed. It may satisfy (and
    // therefore stop) that newer work, but a newer failure must never hide
    // an already-accepted older result.
    if (accepted) {
      await tx
        .update(simPrecalcObligations)
        .set({
          state: "satisfied",
          sourceResultAttemptId: accepted.id,
          lastOutcome: "accepted",
          lastError: null,
          continuationSegmentCount,
          continuationNoProgressCount: 0,
          nextSubmitAt: null,
          completedAt: new Date(),
        })
        .where(eq(simPrecalcObligations.id, obligation.id));
      await resolveSolverIncidentsForOwnerInTransaction(tx, {
        precalcObligationId: obligation.id,
      });
      outcome.satisfied.push(obligation.id);
      continue;
    }
    // A late replay may finish its own immutable attempt audit row, but it
    // cannot regress the physical obligation after a newer job was recorded.
    if (obligation.latestSimJobId && obligation.latestSimJobId !== job.id) {
      continue;
    }
    if (["blocked", "cancelled"].includes(obligation.state)) continue;
    if (obligation.state === "satisfied" && state !== "satisfied") continue;
    await tx
      .update(simPrecalcObligations)
      .set({
        state,
        attemptCount: obligation.attemptCount,
        continuationSegmentCount,
        continuationNoProgressCount,
        latestSimJobId: job.id,
        lastOutcome,
        lastError: error,
        nextSubmitAt:
          state === "pending" && lastOutcome === "infrastructure_retry_wait"
            ? new Date(Date.now() + INFRASTRUCTURE_RETRY_BACKOFF_MS)
            : null,
        completedAt: state === "pending" ? null : new Date(),
      })
      .where(eq(simPrecalcObligations.id, obligation.id));
    if (
      owner?.live &&
      state !== "cancelled" &&
      (judged != null || continuationPermanent || continuationSegmentExhausted)
    ) {
      const [revision] = await tx
        .select({
          solverImplementationId:
            simulationPresetRevisions.solverImplementationId,
        })
        .from(simulationPresetRevisions)
        .where(eq(simulationPresetRevisions.id, obligation.revisionId))
        .limit(1);
      const solverImplementationId =
        judged?.solverImplementationId ?? revision?.solverImplementationId;
      if (!solverImplementationId) {
        throw new Error(
          `precalc obligation ${obligation.id} has no solver implementation for incident attribution`,
        );
      }
      const reason = continuationNoProgressExhausted
        ? "continuation-no-progress"
        : continuationSegmentExhausted
          ? "continuation-segment-limit"
          : continuationPermanent
            ? "continuation-source-unavailable"
            : solverIncidentReason(
                judged?.reasons,
                failureDisposition && failureDisposition !== "none"
                  ? failureDisposition
                  : transientFailure
                    ? "solver-execution-failed"
                    : "non-publishable-evidence",
              );
      await recordSolverIncidentInTransaction(tx, {
        stage: "preliminary",
        reason,
        severity: state === "blocked" ? "critical" : "warning",
        owner: { precalcObligationId: obligation.id },
        solverImplementationId,
        occurrenceKey: `preliminary:${obligation.id}:${judged?.id ?? job.id}:${lastOutcome}`,
        remediationVersion: URANS_RECOVERY_REMEDIATION_VERSION,
        simJobId: job.id,
        resultAttemptId: judged?.id ?? null,
        campaignIds: outcome.campaignIds,
        metadata: {
          lastOutcome,
          continuationSegmentCount,
          continuationNoProgressCount,
          progress: currentProgress,
          classificationReasons: judged?.reasons ?? [],
          failureDisposition,
        },
      });
    }
    outcome[state].push(obligation.id);
    if (continuationPermanent && state === "blocked") {
      outcome.continuationPermanent.push(obligation.id);
    }
  }

  const requestId =
    typeof (job.requestPayload as { uransRequestId?: unknown } | null)
      ?.uransRequestId === "string"
      ? (job.requestPayload as { uransRequestId: string }).uransRequestId
      : null;
  if (requestId) {
    const [request] = await tx
      .select({ fidelity: simUransRequests.fidelity })
      .from(simUransRequests)
      .where(eq(simUransRequests.id, requestId))
      .limit(1);
    // A full request is an aggregate over preliminary obligations plus final
    // verify rows. Its state is projected by urans-ladder after verification
    // enqueue/settlement; collapsing it to the preliminary-only projection
    // would mark the user's final request done before final URANS ran.
    if (request?.fidelity === "precalc") {
      const requestState = await precalcRequestStateFromObligations(
        tx,
        requestId,
      );
      await tx
        .update(simUransRequests)
        .set({
          state: requestState,
          simJobId: requestState === "pending" ? null : job.id,
        })
        .where(
          and(
            eq(simUransRequests.id, requestId),
            eq(simUransRequests.state, "running"),
            eq(simUransRequests.simJobId, job.id),
          ),
        );
    }
  }

  return outcome;
}

export async function refreshPrecalcSettlementCampaigns(
  db: DB,
  campaignIds: string[],
): Promise<void> {
  for (const campaignId of [...new Set(campaignIds)]) {
    await recomputeProgressForCampaign(db, campaignId);
    await probeCampaignCompletion(db, campaignId);
  }
}

/** Settle actual engine evidence for every precalc cell owned by one job.
 * Attempt classifications include replace-guard rows, so protected canonical
 * RANS evidence never needs to be mutated to make retry exhaustion visible. */
export async function settlePrecalcObligationsForJob(
  db: DB,
  job: Pick<
    SimJob,
    | "id"
    | "airfoilId"
    | "simulationPresetRevisionId"
    | "requestPayload"
    | "engineJobId"
    | "submittedAt"
  >,
  opts: PrecalcTerminalSettlementOptions = {},
): Promise<PrecalcSettlement> {
  const outcome = await db.transaction((rawTx) =>
    settlePrecalcObligationsForJobInTransaction(
      rawTx as unknown as DB,
      job,
      opts,
    ),
  );
  await refreshPrecalcSettlementCampaigns(db, outcome.campaignIds);
  return outcome;
}

export interface PrecalcRepairSatisfaction {
  obligationId: string;
  resultAttemptId: string;
  changed: boolean;
}

/** State-only accepted-evidence projection for callers that already own the
 * surrounding transaction/order. It deliberately does not recompute campaign
 * progress or probe completion: ingestion must first exact-link the accepted
 * attempt, then let its normal progress hook observe obligation + point as one
 * coherent state. */
export async function satisfyPrecalcObligationFromAcceptedResultInTransaction(
  tx: DB,
  resultId: string,
): Promise<PrecalcRepairSatisfaction | null> {
  const [accepted] = await tx
    .select({
      resultId: results.id,
      airfoilId: results.airfoilId,
      revisionId: results.simulationPresetRevisionId,
      aoaDeg: results.aoaDeg,
      resultAttemptId: resultAttempts.id,
      simJobId: resultAttempts.simJobId,
    })
    .from(results)
    .innerJoin(
      resultClassifications,
      and(
        eq(resultClassifications.resultId, results.id),
        eq(resultClassifications.state, "accepted"),
      ),
    )
    .innerJoin(
      resultAttempts,
      and(
        eq(resultAttempts.resultId, results.id),
        eq(resultAttempts.status, "done"),
        sql`(
            ${resultAttempts.evidencePayload} ->> 'fidelity' = 'urans_precalc'
            OR (
              ${resultAttempts.evidencePayload} ->> 'fidelity' IS NULL
              AND ${resultAttempts.regime} = 'urans'
            )
          )`,
      ),
    )
    .where(
      and(
        eq(results.id, resultId),
        eq(results.status, "done"),
        eq(results.fidelity, "urans_precalc"),
        // A no-shedding preliminary URANS run is physically steady and is
        // deliberately stored with `regime = rans` so downstream media does
        // not claim unsteady fields that do not exist.  Fidelity, the exact
        // accepted attempt, and the continuation guards above are the proof
        // that this is still completed PRECALC evidence.
        sql`NOT EXISTS (
            SELECT 1
            FROM unnest(COALESCE(${results.qualityWarnings}, ARRAY[]::text[])) warning
            WHERE warning LIKE ${`%${URANS_BUDGET_STOP_MARKER}%`}
               OR warning LIKE ${`%${URANS_CONTINUATION_REQUIRED_MARKER}%`}
          )`,
        sql`EXISTS (
            SELECT 1
            FROM result_classifications accepted_attempt_classification
            WHERE accepted_attempt_classification.result_attempt_id = ${resultAttempts.id}
              AND accepted_attempt_classification.state = 'accepted'
          )`,
      ),
    )
    .orderBy(sql`${resultAttempts.createdAt} DESC`)
    .limit(1);
  if (!accepted?.revisionId) return null;

  const [obligation] = await tx
    .select()
    .from(simPrecalcObligations)
    .where(
      and(
        eq(simPrecalcObligations.airfoilId, accepted.airfoilId),
        eq(simPrecalcObligations.revisionId, accepted.revisionId),
        eq(simPrecalcObligations.aoaDeg, accepted.aoaDeg),
      ),
    )
    .for("update")
    .limit(1);
  if (!obligation) return null;

  const changed = !(
    obligation.state === "satisfied" &&
    obligation.sourceResultId === accepted.resultId &&
    obligation.sourceResultAttemptId === accepted.resultAttemptId &&
    obligation.lastOutcome === "accepted" &&
    obligation.lastError == null &&
    obligation.nextSubmitAt == null
  );
  if (changed) {
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
  await tx.update(simPrecalcObligationAttempts).set({
    state: "accepted",
    outcome: "accepted",
    resultAttemptId: accepted.resultAttemptId,
    error: null,
    completedAt: new Date(),
  }).where(sql`
        ${simPrecalcObligationAttempts.obligationId} = ${obligation.id}
        AND (
          ${simPrecalcObligationAttempts.resultAttemptId} = ${accepted.resultAttemptId}
          OR (
            ${accepted.simJobId}::uuid IS NOT NULL
            AND ${simPrecalcObligationAttempts.simJobId} = ${accepted.simJobId}
          )
        )
      `);
  await resolveSolverIncidentsForOwnerInTransaction(tx, {
    precalcObligationId: obligation.id,
  });
  return {
    obligationId: obligation.id,
    resultAttemptId: accepted.resultAttemptId,
    changed,
  };
}

/** Cross-ledger media repair may make already-stored preliminary evidence
 * publishable. This helper only projects accepted, exact-cell CFD truth into
 * the physical obligation ledger; it never creates or reopens solver work. */
export async function satisfyPrecalcObligationFromAcceptedResult(
  db: DB,
  resultId: string,
): Promise<PrecalcRepairSatisfaction | null> {
  const satisfaction = await db.transaction((rawTx) =>
    satisfyPrecalcObligationFromAcceptedResultInTransaction(
      rawTx as unknown as DB,
      resultId,
    ),
  );
  if (!satisfaction?.changed) return satisfaction;

  // The result classification above changed a campaign-visible cell.  Keep
  // the stored progress rows truthful for callers outside the normal sweeper
  // ingest path too (for example the deliberately scoped cache backfill).
  const campaignIds = await recomputeProgressForPrecalcObligations(db, [
    satisfaction.obligationId,
  ]);
  for (const campaignId of campaignIds) {
    await probeCampaignCompletion(db, campaignId);
  }
  return satisfaction;
}

export async function activeCampaignOwnersForUransRequest(
  db: DB,
  requestId: string,
): Promise<string[]> {
  const rows = (await db.execute(sql`
    SELECT ownership.campaign_id
    FROM sim_urans_request_campaigns ownership
    JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
    WHERE ownership.request_id = ${requestId}
      AND ownership.state = 'active'
      AND campaign.status IN ('active', 'attention', 'paused')
    ORDER BY ownership.campaign_id
  `)) as unknown as Array<{ campaign_id: string }>;
  return rows.map((row) => row.campaign_id);
}

export interface PrecalcContinuationAddress {
  obligationId: string;
  aoaDeg: number;
  resultAttemptId: string;
  engineJobId: string;
  engineCaseSlug: string;
  budgetOverrideS: number;
}

/** Select the newest restartable checkpoint whose newer immutable submissions
 * are only typed, non-consuming infrastructure interruptions. A later
 * evidence-less infrastructure loss must not hide an earlier checkpoint, while
 * a later physical/rejected attempt deliberately prevents an unchanged resume
 * loop. The canonical result may still be protected RANS evidence and is never
 * consulted. */
export async function precalcContinuationsForObligations(
  db: DB,
  obligationIds: string[],
): Promise<PrecalcContinuationAddress[]> {
  if (!obligationIds.length) return [];
  const rows = (await db.execute(sql`
    SELECT obligation.id AS obligation_id,
           obligation.aoa_deg::float8 AS aoa_deg,
           checkpoint.result_attempt_id,
           checkpoint.engine_job_id,
           checkpoint.engine_case_slug
    FROM sim_precalc_obligations obligation
    JOIN simulation_preset_revisions target_revision
      ON target_revision.id = obligation.revision_id
    JOIN LATERAL (
      SELECT candidate.result_attempt_id,
             result_attempt.engine_job_id,
             result_attempt.engine_case_slug
      FROM sim_precalc_obligation_attempts candidate
      JOIN result_attempts result_attempt
        ON result_attempt.id = candidate.result_attempt_id
      JOIN simulation_preset_revisions checkpoint_revision
        ON checkpoint_revision.id =
          result_attempt.simulation_preset_revision_id
      LEFT JOIN sim_jobs checkpoint_job
        ON checkpoint_job.id = candidate.sim_job_id
      WHERE candidate.obligation_id = obligation.id
        AND result_attempt.simulation_preset_revision_id =
          obligation.revision_id
        AND result_attempt.engine_job_id IS NOT NULL
        AND result_attempt.engine_case_slug IS NOT NULL
        AND ${compatiblePrecalcCheckpointImplementationSql({
          targetSolverImplementationId: sql`target_revision.solver_implementation_id`,
          targetRevisionSolverImplementationId: sql`target_revision.solver_implementation_id`,
          checkpointRevisionSolverImplementationId: sql`checkpoint_revision.solver_implementation_id`,
          checkpointAttemptSolverImplementationId: sql`result_attempt.solver_implementation_id`,
          checkpointJobSolverImplementationId: sql`checkpoint_job.solver_implementation_id`,
        })}
        AND ${restartablePrecalcWarningSql(sql`result_attempt.quality_warnings`)}
        AND NOT EXISTS (
          SELECT 1
          FROM sim_precalc_obligation_attempts newer
          WHERE newer.obligation_id = candidate.obligation_id
            AND newer.attempt_number > candidate.attempt_number
            AND NOT (
              ${typedPrecalcInfrastructureInterruptionSql({
                state: sql`newer.state`,
                outcome: sql`newer.outcome`,
                consumesSolverAttempt: sql`newer.consumes_solver_attempt`,
              })}
              OR ${legacyPrecalcInfrastructureInterruptionSql({
                resultAttemptId: sql`newer.result_attempt_id`,
                consumesSolverAttempt: sql`newer.consumes_solver_attempt`,
                simJobId: sql`newer.sim_job_id`,
                error: sql`newer.error`,
                checkpointResultAttemptId: sql`result_attempt.id`,
                checkpointResultId: sql`result_attempt.result_id`,
              })}
            )
        )
      ORDER BY candidate.attempt_number DESC
      LIMIT 1
    ) checkpoint ON true
    WHERE obligation.id = ANY(${sql`ARRAY[${sql.join(
      obligationIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})
      AND obligation.state = 'pending'
      AND obligation.continuation_segment_count <
        ${MAX_PRECALC_CONTINUATION_SEGMENTS}
      AND obligation.continuation_no_progress_count <
        ${MAX_PRECALC_NO_PROGRESS_SEGMENTS}
    ORDER BY obligation.aoa_deg
  `)) as unknown as Array<{
    obligation_id: string;
    aoa_deg: number;
    result_attempt_id: string;
    engine_job_id: string;
    engine_case_slug: string;
  }>;
  return rows.map((row) => ({
    obligationId: row.obligation_id,
    aoaDeg: Number(row.aoa_deg),
    resultAttemptId: row.result_attempt_id,
    engineJobId: row.engine_job_id,
    engineCaseSlug: row.engine_case_slug,
    budgetOverrideS: AUTO_PRECALC_CONTINUATION_BUDGET_S,
  }));
}
