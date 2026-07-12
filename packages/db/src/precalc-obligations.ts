import { and, asc, eq, inArray, sql } from "drizzle-orm";
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
  recomputeProgressForCampaign,
} from "./campaign-execution";
import {
  resultAttempts,
  resultClassifications,
  results,
  simPrecalcObligationAttempts,
  simPrecalcObligationCampaigns,
  simPrecalcObligationRequests,
  simPrecalcObligations,
  simUransRequests,
  type SimJob,
  type SimPrecalcObligation,
} from "./schema";

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

const liveOwnerSql = (obligationId: string) => sql`(
  EXISTS (
    SELECT 1 FROM sim_precalc_obligations obligation
    WHERE obligation.id = ${obligationId} AND obligation.background_owner
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
    FROM sim_precalc_obligations obligation
    JOIN sync_sweep_promise_points promise_point
      ON promise_point.airfoil_id = obligation.airfoil_id
     AND promise_point.simulation_preset_revision_id = obligation.revision_id
     AND promise_point.aoa_deg = obligation.aoa_deg
     AND promise_point.status = 'active'
    JOIN sync_sweep_promises promise
      ON promise.id = promise_point.promise_id
     AND promise.status = 'active'
     AND promise."expiresAt" > now()
     AND promise.request_payload ->> 'remoteSolver' = 'true'
    WHERE obligation.id = ${obligationId}
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
  // campaign/request/promise owner rows -> sorted natural-cell advisory
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

/** Record only an engine-accepted submission. A cancelled composition or
 * connection failure consumes no attempt. Idempotent by (obligation, job). */
export async function recordPrecalcObligationSubmission(
  db: DB,
  simJobId: string,
  obligationIds: string[],
): Promise<void> {
  if (!obligationIds.length) return;
  await db.transaction(async (tx) => {
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
        obligation.attemptCount >= obligation.maxAttempts ||
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
      const attemptNumber = obligation.attemptCount + 1;
      await tx.insert(simPrecalcObligationAttempts).values({
        obligationId: obligation.id,
        simJobId,
        attemptNumber,
        state: "submitted",
      });
      await tx
        .update(simPrecalcObligations)
        .set({
          state: "running",
          attemptCount: attemptNumber,
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

export interface PrecalcSettlement {
  pending: string[];
  satisfied: string[];
  blocked: string[];
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

export interface PrecalcTerminalSettlementOptions {
  terminalError?: string | null;
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
  };
  const obligationIds = Array.isArray(payload.precalcObligationIds)
    ? payload.precalcObligationIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  const outcome: PrecalcSettlement = {
    pending: [],
    satisfied: [],
    blocked: [],
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
      const attemptNumber = Math.min(
        obligation.maxAttempts,
        obligation.attemptCount + 1,
      );
      [submission] = await tx
        .insert(simPrecalcObligationAttempts)
        .values({
          obligationId: obligation.id,
          simJobId: job.id,
          attemptNumber,
          state: "submitted",
        })
        .onConflictDoNothing()
        .returning();
      if (submission) {
        await tx
          .update(simPrecalcObligations)
          .set({
            attemptCount: Math.max(obligation.attemptCount, attemptNumber),
            latestSimJobId: job.id,
            lastAttemptAt: new Date(),
          })
          .where(eq(simPrecalcObligations.id, obligation.id));
        obligation.attemptCount = Math.max(
          obligation.attemptCount,
          attemptNumber,
        );
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
        fidelity: sql<
          string | null
        >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
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
    // cell. The sole fallback is a deterministic mesh/setup failure: it can
    // happen before pimpleFoam starts and therefore honestly echo RANS. The
    // exact payload plus the sim_job/airfoil/revision/AoA query above fences
    // that fallback to this physical submission.
    const precalcEvidence = evidence.filter(
      (row) => row.fidelity === "urans_precalc" || row.regime === "urans",
    );
    const deterministicRansFallback = exactPrecalcJob
      ? (evidence.find((row) => isDeterministicMeshBlockerError(row.error)) ??
        null)
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
      deterministicRansFallback ??
      null;
    const error = judged?.error ?? opts.terminalError ?? null;
    const deterministic = isDeterministicMeshBlockerError(error);
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
    const [owner] = (await tx.execute(sql`
        SELECT (${liveOwnerSql(obligation.id)}) AS live
      `)) as unknown as Array<{ live: boolean }>;

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
      obligation.attemptCount < obligation.maxAttempts &&
      (restartable || transientFailure)
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
          resultAttemptId: judged?.id ?? null,
          error,
          completedAt: new Date(),
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
          nextSubmitAt: null,
          completedAt: new Date(),
        })
        .where(eq(simPrecalcObligations.id, obligation.id));
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
        latestSimJobId: job.id,
        lastOutcome,
        lastError: error,
        completedAt: state === "pending" ? null : new Date(),
      })
      .where(eq(simPrecalcObligations.id, obligation.id));
    outcome[state].push(obligation.id);
  }

  const requestId =
    typeof (job.requestPayload as { uransRequestId?: unknown } | null)
      ?.uransRequestId === "string"
      ? (job.requestPayload as { uransRequestId: string }).uransRequestId
      : null;
  if (requestId) {
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

/** Cross-ledger media repair may make already-stored preliminary evidence
 * publishable. This helper only projects accepted, exact-cell CFD truth into
 * the physical obligation ledger; it never creates or reopens solver work. */
export async function satisfyPrecalcObligationFromAcceptedResult(
  db: DB,
  resultId: string,
): Promise<PrecalcRepairSatisfaction | null> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
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
          eq(results.regime, "urans"),
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
    return {
      obligationId: obligation.id,
      resultAttemptId: accepted.resultAttemptId,
      changed,
    };
  });
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

/** Latest rejected attempt owns continuation addressing. The canonical result
 * may still be protected RANS evidence and is deliberately never consulted. */
export async function precalcContinuationsForObligations(
  db: DB,
  obligationIds: string[],
): Promise<PrecalcContinuationAddress[]> {
  if (!obligationIds.length) return [];
  const rows = (await db.execute(sql`
    SELECT obligation.id AS obligation_id,
           obligation.aoa_deg::float8 AS aoa_deg,
           result_attempt.id AS result_attempt_id,
           result_attempt.engine_job_id,
           result_attempt.engine_case_slug
    FROM sim_precalc_obligations obligation
    JOIN LATERAL (
      SELECT candidate.result_attempt_id
      FROM sim_precalc_obligation_attempts candidate
      WHERE candidate.obligation_id = obligation.id
        AND candidate.result_attempt_id IS NOT NULL
      ORDER BY candidate.attempt_number DESC
      LIMIT 1
    ) ledger_attempt ON true
    JOIN result_attempts result_attempt
      ON result_attempt.id = ledger_attempt.result_attempt_id
    WHERE obligation.id = ANY(${sql`ARRAY[${sql.join(
      obligationIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})
      AND obligation.state = 'pending'
      AND obligation.attempt_count < obligation.max_attempts
      AND result_attempt.engine_job_id IS NOT NULL
      AND result_attempt.engine_case_slug IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM unnest(COALESCE(result_attempt.quality_warnings, ARRAY[]::text[])) warning
        WHERE warning LIKE ${"%" + URANS_BUDGET_STOP_MARKER + "%"}
           OR warning LIKE ${"%" + URANS_CONTINUATION_REQUIRED_MARKER + "%"}
      )
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
