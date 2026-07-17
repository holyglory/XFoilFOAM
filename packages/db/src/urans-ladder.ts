// URANS fidelity ladder — shared node-side helpers (pinned contracts 4–7,
// migration 0034). The sweeper consumes these in its ladder tick; the API
// reads the tier counts for the campaign summary payload.
//
// Ladder (contract 5, ONE priority scale — no second scale):
//   1. automatic PRECALC recovery                     — promotion / targeted
//   2. RANS work                                      — existing submit branch
//      with one final verification interleaved after at most eight newly
//      admitted wave-1 jobs while a schedulable verify item remains pending
//   3. admin request-URANS items and idle verify fallback

import {
  AUTO_PRECALC_CONTINUATION_BUDGET_S,
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
  MISSING_URANS_VIDEO_REASON,
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
} from "@aerodb/core";
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  or,
  sql,
  type SQLWrapper,
} from "drizzle-orm";

import type { DB } from "./client";
import {
  ensurePrecalcObligationsInTransaction,
  type PrecalcObligationCell,
} from "./precalc-obligations";
import {
  recordSolverIncidentInTransaction,
  resolveSolverIncidentsForOwnerInTransaction,
  URANS_RECOVERY_REMEDIATION_VERSION,
} from "./solver-incidents";
import {
  resultAttempts,
  resultClassifications,
  results,
  simCampaigns,
  simJobs,
  simPrecalcObligationRequests,
  simPrecalcObligations,
  simUransRequestCampaigns,
  simUransRequests,
  simUransVerifyQueue,
  simUransVerifyQueueRequests,
  type SimPrecalcObligation,
  type SimUransRequest,
  type SimUransVerifyQueueItem,
} from "./schema";

// ---------------------------------------------------------------------------
// Verify-queue enqueue (contract 4): an immutable result_attempt that
// classifies ACCEPTED at fidelity 'urans_precalc' owes a full-fidelity
// verification. Fidelity, not regime, owns this obligation: a no-shedding
// URANS attempt is represented as steady-equivalent regime='rans' but is still
// preliminary URANS evidence. Retry ownership and budgets are generation
// scoped; the mutable natural-cell results row is never the identity.
// ---------------------------------------------------------------------------
export {
  AUTO_PRECALC_CONTINUATION_BUDGET_S,
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
};

/** Final verification gets one corrective fresh trajectory. A restartable
 * trajectory continues for as many monotonic physical segments as it needs;
 * only repeated measured no-progress moves to that fresh fallback. */
export const FINAL_URANS_MAX_FRESH_ATTEMPTS = 2;
export const FINAL_URANS_MAX_NO_PROGRESS_SEGMENTS = 2;
export const FINAL_URANS_CONTINUATION_BUDGET_S = 6 * 60 * 60;
export const FINAL_URANS_RETRY_BACKOFF_MS = 30_000;

export const FINAL_URANS_OUTCOMES = {
  continuationPending: "continuation_pending",
  continuationRetryWait: "continuation_retry_wait",
  freshRetryPending: "fresh_retry_pending",
  infrastructureRetryWait: "infrastructure_retry_wait",
  mediaRepairPending: "media_repair_pending",
  accepted: "accepted",
  disagreed: "disagreed",
  recoveryExhausted: "final_recovery_exhausted",
  deterministicFailure: "deterministic_failure",
  continuationPermanentFailure: "continuation_permanent_failure",
  ownerless: "ownerless",
} as const;

export type FinalUransOutcome =
  (typeof FINAL_URANS_OUTCOMES)[keyof typeof FINAL_URANS_OUTCOMES];

/** Queue one bounded same-result continuation for a campaign precalc result.
 *
 * The result row is locked while the request is selected/inserted. Any prior
 * continuation for the physical result which completed or crossed the engine
 * submit boundary spends the ONE bounded attempt globally, regardless of how
 * many campaigns reference the evidence. An open request is reused and gains
 * every live owner association. A cancelled pre-submit composition did not
 * spend the attempt and may be recreated. The existing open-cell unique index
 * remains the final race guard.
 */
async function enqueueAutomaticPrecalcContinuations(
  db: DB,
  opts: {
    airfoilId: string;
    revisionId: string;
    campaignId?: string | null;
    aoaDeg?: number | null;
  },
): Promise<number> {
  if (!opts.campaignId) return 0;
  return db.transaction(async (tx) => {
    // Serializes exact-vs-whole overlap checks across automatic and admin
    // request creation. Distinct exact angles still coexist under the same
    // short transaction; the lock protects only metadata composition.
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`urans-request:${opts.airfoilId}:${opts.revisionId}:precalc`}, 0)
      )
    `);
    const candidates = (await tx.execute(sql`
      SELECT r.id, r.airfoil_id, r.simulation_preset_revision_id, r.aoa_deg::float8 AS aoa_deg
      FROM results r
      JOIN result_classifications rc ON rc.result_id = r.id
      JOIN sim_campaign_points p
        ON p.campaign_id = ${opts.campaignId}
       AND p.result_id = r.id
       AND p.state = 'terminal'
       AND p.derived_by_symmetry = false
      JOIN sim_campaigns campaign
        ON campaign.id = p.campaign_id
       AND campaign.status IN ('active', 'attention', 'paused')
      WHERE r.airfoil_id = ${opts.airfoilId}
        AND r.simulation_preset_revision_id = ${opts.revisionId}
        AND r.status = 'done'
        ${opts.aoaDeg == null ? sql`` : sql`AND r.aoa_deg = ${opts.aoaDeg}`}
        AND r.fidelity = 'urans_precalc'
        AND rc.state = 'rejected'
        AND COALESCE(rc.reasons, ARRAY[]::text[])
              <> ARRAY[${MISSING_URANS_VIDEO_REASON}]::text[]
        AND r.engine_job_id IS NOT NULL
        AND r.engine_case_slug IS NOT NULL
        AND EXISTS (
          SELECT 1
          FROM unnest(COALESCE(r.quality_warnings, ARRAY[]::text[])) warning
          WHERE warning LIKE ${"%" + URANS_BUDGET_STOP_MARKER + "%"}
             OR warning LIKE ${"%" + URANS_CONTINUATION_REQUIRED_MARKER + "%"}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM sim_urans_requests prior
          LEFT JOIN sim_jobs prior_job ON prior_job.id = prior.sim_job_id
          WHERE prior.continue_from_result_id = r.id
            AND prior.state NOT IN ('pending', 'running')
            AND (
              prior.state = 'done'
              OR prior_job.engine_job_id IS NOT NULL
              OR prior_job."submittedAt" IS NOT NULL
            )
        )
      FOR UPDATE OF r
    `)) as unknown as Array<{
      id: string;
      airfoil_id: string;
      simulation_preset_revision_id: string;
      aoa_deg: number;
    }>;
    let created = 0;
    for (const candidate of candidates) {
      const [covering] = (await tx.execute(sql`
        SELECT id
        FROM sim_urans_requests
        WHERE airfoil_id = ${candidate.airfoil_id}
          AND revision_id = ${candidate.simulation_preset_revision_id}
          AND fidelity = 'precalc'
          AND state IN ('pending', 'running')
          AND (aoa_deg = ${candidate.aoa_deg} OR aoa_deg IS NULL)
        ORDER BY (aoa_deg IS NULL) DESC, "createdAt" ASC
        LIMIT 1
      `)) as unknown as Array<{ id: string }>;
      let requestId = covering?.id;
      if (!requestId) {
        const [inserted] = (await tx.execute(sql`
          INSERT INTO sim_urans_requests (
            airfoil_id, revision_id, aoa_deg, fidelity, state, requested_by,
            continue_from_result_id, budget_override_s
          ) VALUES (
            ${candidate.airfoil_id}, ${candidate.simulation_preset_revision_id},
            ${candidate.aoa_deg}, 'precalc', 'pending',
            ${AUTO_PRECALC_CONTINUATION_REQUESTED_BY}, ${candidate.id},
            ${AUTO_PRECALC_CONTINUATION_BUDGET_S}
          )
          ON CONFLICT DO NOTHING
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
        requestId = inserted?.id;
        if (requestId) created += 1;
      }
      if (!requestId) {
        const [raced] = (await tx.execute(sql`
          SELECT id FROM sim_urans_requests
          WHERE airfoil_id = ${candidate.airfoil_id}
            AND revision_id = ${candidate.simulation_preset_revision_id}
            AND fidelity = 'precalc'
            AND state IN ('pending', 'running')
            AND (aoa_deg = ${candidate.aoa_deg} OR aoa_deg IS NULL)
          ORDER BY (aoa_deg IS NULL) DESC, "createdAt" ASC
          LIMIT 1
        `)) as unknown as Array<{ id: string }>;
        requestId = raced?.id;
      }
      if (!requestId) continue;
      // Every live campaign referencing the same source evidence becomes an
      // owner, even if another campaign or an independent whole-polar request
      // created the physical row first.
      await tx.execute(sql`
        INSERT INTO sim_urans_request_campaigns (request_id, campaign_id, state)
        SELECT DISTINCT ${requestId}::uuid, campaign.id, 'active'
        FROM sim_campaign_points point
        JOIN sim_campaigns campaign ON campaign.id = point.campaign_id
        WHERE point.result_id = ${candidate.id}
          AND point.derived_by_symmetry = false
          AND campaign.status IN ('active', 'attention', 'paused')
        ON CONFLICT (request_id, campaign_id) DO UPDATE
          SET state = 'active', cancelled_at = NULL, "updatedAt" = now()
      `);
    }
    return created;
  });
}

/** Preserve the semantics of the legacy "continue this full result" action
 * while routing it through the ordinary final-verification controller. The
 * accepted preliminary baseline is still mandatory; once its queue row
 * exists, the exact saved full attempt becomes that row's next continuation
 * source instead of bypassing the queue with a direct full submit. */
async function seedFinalContinuationFromRequestInTransaction(
  tx: DB,
  input: {
    requestId: string;
    queueId: string;
    airfoilId: string;
    revisionId: string;
    aoaDeg: number;
  },
): Promise<void> {
  const [request] = await tx
    .select({
      fidelity: simUransRequests.fidelity,
      continueFromResultId: simUransRequests.continueFromResultId,
      budgetOverrideS: simUransRequests.budgetOverrideS,
    })
    .from(simUransRequests)
    .where(eq(simUransRequests.id, input.requestId))
    .limit(1);
  if (request?.fidelity !== "full" || !request.continueFromResultId) return;

  const [source] = (await tx.execute(sql`
    SELECT attempt.id
    FROM result_attempts attempt
    WHERE attempt.airfoil_id = ${input.airfoilId}
      AND attempt.simulation_preset_revision_id = ${input.revisionId}
      AND attempt.aoa_deg = ${input.aoaDeg}
      AND attempt.result_id = ${request.continueFromResultId}
      AND attempt.source = 'solved'
      AND attempt.engine_job_id IS NOT NULL
      AND attempt.engine_case_slug IS NOT NULL
      AND attempt.evidence_payload ->> 'fidelity' = 'urans_full'
    ORDER BY attempt."createdAt" DESC, attempt.id DESC
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (!source) return;

  await tx.execute(sql`
    UPDATE sim_urans_verify_queue queue
    SET latest_result_attempt_id = ${source.id},
        fresh_attempt_count = GREATEST(queue.fresh_attempt_count, 1),
        continuation_no_progress_count = 0,
        continuation_budget_override_s = CASE
          WHEN ${request.budgetOverrideS ?? null}::int IS NULL
            THEN queue.continuation_budget_override_s
          ELSE GREATEST(
            COALESCE(queue.continuation_budget_override_s, 0),
            ${request.budgetOverrideS ?? null}::int
          )
        END,
        last_outcome = ${FINAL_URANS_OUTCOMES.continuationPending},
        last_error = NULL,
        next_submit_at = NULL,
        "updatedAt" = now()
    WHERE queue.id = ${input.queueId}
      AND queue.state = 'pending'
  `);
}

export async function enqueuePrecalcVerifications(
  db: DB,
  opts: {
    airfoilId: string;
    revisionId: string;
    campaignId?: string | null;
    aoaDeg?: number | null;
    /** Explicit final-fidelity request that owns the per-point verification.
     * Request ownership is distinct from an autonomous background owner. */
    requestId?: string | null;
  },
): Promise<number> {
  await enqueueAutomaticPrecalcContinuations(db, opts);
  return db.transaction(async (tx) => {
    const campaignJoin = opts.campaignId
      ? sql`JOIN sim_campaign_points selected_point
              ON selected_point.campaign_id = ${opts.campaignId}
             AND selected_point.result_id = r.id
             AND selected_point.result_attempt_id = precalc_attempt.id
             AND selected_point.state = 'terminal'
             AND selected_point.derived_by_symmetry = false
            JOIN sim_campaigns selected_campaign
              ON selected_campaign.id = selected_point.campaign_id
             AND selected_campaign.status IN ('active', 'attention', 'paused')`
      : sql``;
    const candidates = (await tx.execute(sql`
      SELECT r.id, precalc_attempt.id AS precalc_result_attempt_id,
             r.airfoil_id, r.simulation_preset_revision_id,
             r.aoa_deg::float8 AS aoa_deg
      FROM results r
      JOIN result_attempts precalc_attempt
        ON precalc_attempt.id = r.current_result_attempt_id
       AND precalc_attempt.result_id = r.id
       AND precalc_attempt.airfoil_id = r.airfoil_id
       AND precalc_attempt.simulation_preset_revision_id =
           r.simulation_preset_revision_id
       AND precalc_attempt.aoa_deg = r.aoa_deg
      JOIN result_classifications rc
        ON rc.result_attempt_id = precalc_attempt.id
      ${campaignJoin}
      WHERE r.airfoil_id = ${opts.airfoilId}
        AND r.simulation_preset_revision_id = ${opts.revisionId}
        AND r.status = 'done'
        ${opts.aoaDeg == null ? sql`` : sql`AND r.aoa_deg = ${opts.aoaDeg}`}
        AND precalc_attempt.status = 'done'
        AND precalc_attempt.source = 'solved'
        AND precalc_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
        AND rc.state = 'accepted'
      ORDER BY r.id
      FOR UPDATE OF r
    `)) as unknown as Array<{
      id: string;
      precalc_result_attempt_id: string;
      airfoil_id: string;
      simulation_preset_revision_id: string;
      aoa_deg: number;
    }>;
    let created = 0;
    for (const candidate of candidates) {
      // The result row lock serializes ordinary ingest replays. The advisory
      // lock also serializes explicit full-request coverage, which does not
      // otherwise own that mutable row, so one preliminary generation can
      // never mint two retry ledgers after reaching a terminal state.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${`final-verify-generation:${candidate.precalc_result_attempt_id}`},
            0
          )
        )
      `);
      const [existing] = (await tx.execute(sql`
        SELECT id, state
        FROM sim_urans_verify_queue
        WHERE precalc_result_attempt_id =
              ${candidate.precalc_result_attempt_id}
        ORDER BY
          CASE state
            WHEN 'done' THEN 0
            WHEN 'disagreed' THEN 1
            WHEN 'pending' THEN 2
            WHEN 'running' THEN 3
            WHEN 'blocked' THEN 4
            ELSE 5
          END,
          "createdAt",
          id
        LIMIT 1
      `)) as unknown as Array<{ id: string; state: string }>;
      const [inserted] = existing
        ? []
        : ((await tx.execute(sql`
            INSERT INTO sim_urans_verify_queue (
              airfoil_id, revision_id, aoa_deg, background_owner, state,
              precalc_result_id, precalc_result_attempt_id
            ) VALUES (
              ${candidate.airfoil_id},
              ${candidate.simulation_preset_revision_id},
              ${candidate.aoa_deg},
              ${!opts.campaignId && !opts.requestId},
              'pending',
              ${candidate.id},
              ${candidate.precalc_result_attempt_id}
            )
            ON CONFLICT (precalc_result_attempt_id)
              WHERE precalc_result_attempt_id IS NOT NULL
                AND state IN ('pending', 'running')
              DO NOTHING
            RETURNING id, state
          `)) as unknown as Array<{ id: string; state: string }>);
      if (inserted?.id) created += 1;
      const physical = existing ?? inserted;
      if (!physical?.id) continue;
      if (!opts.campaignId && !opts.requestId) {
        await tx.execute(sql`
          UPDATE sim_urans_verify_queue
          SET background_owner = true, "updatedAt" = now()
          WHERE id = ${physical.id}
        `);
      }
      if (opts.requestId) {
        await tx
          .insert(simUransVerifyQueueRequests)
          .values({ queueId: physical.id, requestId: opts.requestId })
          .onConflictDoNothing();
        await seedFinalContinuationFromRequestInTransaction(
          tx as unknown as DB,
          {
            requestId: opts.requestId,
            queueId: physical.id,
            airfoilId: candidate.airfoil_id,
            revisionId: candidate.simulation_preset_revision_id,
            aoaDeg: candidate.aoa_deg,
          },
        );
      }
      if (!opts.requestId) {
        await tx.execute(sql`
          INSERT INTO sim_urans_verify_queue_campaigns (
            queue_id, campaign_id, state
          )
          SELECT DISTINCT ${physical.id}::uuid, campaign.id, 'active'
          FROM sim_campaign_points point
          JOIN sim_campaigns campaign ON campaign.id = point.campaign_id
          WHERE point.result_id = ${candidate.id}
            AND point.result_attempt_id =
                ${candidate.precalc_result_attempt_id}
            AND point.derived_by_symmetry = false
            AND campaign.status IN ('active', 'attention', 'paused')
          ON CONFLICT (queue_id, campaign_id) DO UPDATE
            SET state = 'active', cancelled_at = NULL, "updatedAt" = now()
        `);
      }
      if (physical.state === "cancelled") {
        await tx.execute(sql`
          UPDATE sim_urans_verify_queue
          SET state = 'pending', sim_job_id = NULL, next_submit_at = NULL,
              "updatedAt" = now()
          WHERE id = ${physical.id}
            AND state = 'cancelled'
        `);
      }
    }
    return created;
  });
}

export interface FullUransRequestCoverage {
  requestId: string;
  totalCells: number;
  precalcObligations: SimPrecalcObligation[];
  verifyQueueIds: string[];
}

/** A full request may be temporarily unable to take ownership of one natural
 * cell because an ordinary queue mutation already owns it. No partial request
 * coverage is committed: the sweeper releases the request claim and retries
 * after that physical cell settles. */
export class FullUransRequestCoverageIncompleteError extends Error {
  constructor(
    readonly requestId: string,
    readonly missingCells: PrecalcObligationCell[],
  ) {
    super(
      `full URANS request ${requestId} could not materialize ${missingCells.length} cell(s)`,
    );
    this.name = "FullUransRequestCoverageIncompleteError";
  }
}

function uniqueSortedCoverageCells(
  cells: PrecalcObligationCell[],
): PrecalcObligationCell[] {
  const byKey = new Map<string, PrecalcObligationCell>();
  for (const cell of cells) {
    if (!Number.isFinite(cell.aoaDeg)) {
      throw new Error("full URANS request coverage requires finite AoA values");
    }
    byKey.set(
      `${cell.airfoilId}:${cell.revisionId}:${Number(cell.aoaDeg)}`,
      cell,
    );
  }
  return [...byKey.values()].sort(
    (a, b) =>
      a.airfoilId.localeCompare(b.airfoilId) ||
      a.revisionId.localeCompare(b.revisionId) ||
      a.aoaDeg - b.aoaDeg,
  );
}

/** Materialize the one truthful per-point sequence for an explicit final
 * request:
 *
 *   accepted preliminary evidence -> final verify queue
 *   otherwise                      -> preliminary obligation
 *
 * Existing successful or critically blocked final queue rows are linked
 * rather than reopened. Accepted exact final evidence from the removed direct
 * path is projected into a terminal queue record without inventing solver
 * evidence. The transaction either covers every requested cell or rolls back.
 */
export async function ensureFullUransRequestCoverage(
  db: DB,
  input: {
    requestId: string;
    cells: PrecalcObligationCell[];
  },
): Promise<FullUransRequestCoverage> {
  const cells = uniqueSortedCoverageCells(input.cells);
  if (!cells.length) {
    throw new FullUransRequestCoverageIncompleteError(input.requestId, []);
  }
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [request] = await tx
      .select()
      .from(simUransRequests)
      .where(eq(simUransRequests.id, input.requestId))
      .limit(1);
    if (!request || request.fidelity !== "full") {
      throw new Error(
        `full URANS request ${input.requestId} is missing or has the wrong fidelity`,
      );
    }
    if (!["pending", "running"].includes(request.state)) {
      throw new Error(
        `full URANS request ${input.requestId} is already ${request.state}`,
      );
    }
    const mismatched = cells.filter(
      (cell) =>
        cell.airfoilId !== request.airfoilId ||
        cell.revisionId !== request.revisionId ||
        (request.aoaDeg != null &&
          Number(cell.aoaDeg) !== Number(request.aoaDeg)),
    );
    if (mismatched.length) {
      throw new Error(
        `full URANS request ${input.requestId} coverage does not match its immutable scope`,
      );
    }

    const campaignRows = (await tx.execute(sql`
      SELECT ownership.campaign_id
      FROM sim_urans_request_campaigns ownership
      JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
      WHERE ownership.request_id = ${input.requestId}
        AND ownership.state = 'active'
        AND campaign.status IN ('active', 'attention', 'paused')
      ORDER BY ownership.campaign_id
    `)) as unknown as Array<{ campaign_id: string }>;
    const campaignIds = campaignRows.map((row) => row.campaign_id);
    if (!request.backgroundOwner && !campaignIds.length) {
      await tx
        .update(simUransRequests)
        .set({ state: "cancelled", simJobId: null })
        .where(eq(simUransRequests.id, request.id));
      throw new Error(`full URANS request ${request.id} has no live owner`);
    }

    const verifyQueueIds: string[] = [];
    const missingPrecalc: PrecalcObligationCell[] = [];
    for (const cell of cells) {
      // Serialize terminal-queue projection for legacy accepted final rows.
      // Ordinary pending inserts remain protected by their partial unique
      // index; every coverage caller takes these locks in the same sort order.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${`full-urans-coverage:${cell.airfoilId}:${cell.revisionId}:${Number(cell.aoaDeg)}`},
            0
          )
        )
      `);

      const [accepted] = (await tx.execute(sql`
        SELECT
          result.id,
          selected_attempt.id AS result_attempt_id,
          selected_attempt.evidence_payload ->> 'fidelity' AS fidelity,
          preliminary_attempt.id AS precalc_result_attempt_id
        FROM results result
        JOIN result_attempts selected_attempt
          ON selected_attempt.id = result.current_result_attempt_id
         AND selected_attempt.result_id = result.id
         AND selected_attempt.airfoil_id = result.airfoil_id
         AND selected_attempt.simulation_preset_revision_id =
             result.simulation_preset_revision_id
         AND selected_attempt.aoa_deg = result.aoa_deg
        JOIN result_classifications classification
          ON classification.result_attempt_id = selected_attempt.id
         AND classification.state = 'accepted'
        LEFT JOIN LATERAL (
          SELECT attempt.id
          FROM result_attempts attempt
          JOIN result_classifications attempt_classification
            ON attempt_classification.result_attempt_id = attempt.id
           AND attempt_classification.state = 'accepted'
          WHERE attempt.result_id = result.id
            AND attempt.airfoil_id = result.airfoil_id
            AND attempt.simulation_preset_revision_id =
                result.simulation_preset_revision_id
            AND attempt.aoa_deg = result.aoa_deg
            AND attempt.status = 'done'
            AND attempt.source = 'solved'
            AND attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
          ORDER BY attempt."createdAt" DESC, attempt.id DESC
          LIMIT 1
        ) preliminary_attempt ON true
        WHERE result.airfoil_id = ${cell.airfoilId}
          AND result.simulation_preset_revision_id = ${cell.revisionId}
          AND result.aoa_deg = ${cell.aoaDeg}
          AND result.status = 'done'
          AND selected_attempt.status = 'done'
          AND selected_attempt.source = 'solved'
          AND selected_attempt.evidence_payload ->> 'fidelity'
              IN ('urans_precalc', 'urans_full')
        ORDER BY CASE selected_attempt.evidence_payload ->> 'fidelity'
          WHEN 'urans_full' THEN 0
          ELSE 1
        END
        LIMIT 1
      `)) as unknown as Array<{
        id: string;
        result_attempt_id: string;
        fidelity: string;
        precalc_result_attempt_id: string | null;
      }>;
      const acceptedPrecalcAttemptId =
        accepted?.fidelity === "urans_precalc"
          ? accepted.result_attempt_id
          : (accepted?.precalc_result_attempt_id ?? null);
      if (acceptedPrecalcAttemptId) {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(
              ${`final-verify-generation:${acceptedPrecalcAttemptId}`},
              0
            )
          )
        `);
      }
      const queueGenerationScope =
        accepted?.fidelity === "urans_precalc"
          ? sql`AND queue.precalc_result_attempt_id = ${accepted.result_attempt_id}`
          : accepted?.fidelity === "urans_full"
            ? sql`AND (
                queue.state IN ('done', 'disagreed')
                ${acceptedPrecalcAttemptId ? sql`OR queue.precalc_result_attempt_id = ${acceptedPrecalcAttemptId}` : sql``}
              )`
            : sql`AND false`;
      const queues = (await tx.execute(sql`
        SELECT queue.id, queue.state
        FROM sim_urans_verify_queue queue
        WHERE queue.airfoil_id = ${cell.airfoilId}
          AND queue.revision_id = ${cell.revisionId}
          AND queue.aoa_deg = ${cell.aoaDeg}
          AND queue.state IN (
            'pending', 'running', 'done', 'disagreed', 'blocked', 'cancelled'
          )
          ${queueGenerationScope}
        ORDER BY
          CASE
            WHEN queue.state IN ('done', 'disagreed') THEN 0
            WHEN queue.state IN ('pending', 'running') THEN 1
            WHEN queue.state = 'blocked' THEN 2
            ELSE 3
          END,
          queue."updatedAt" DESC,
          queue.id
      `)) as unknown as Array<{ id: string; state: string }>;

      let queueId =
        queues.find((queue) => ["done", "disagreed"].includes(queue.state))
          ?.id ?? null;
      if (!queueId && accepted?.fidelity === "urans_full") {
        const [terminal] = (await tx.execute(sql`
          INSERT INTO sim_urans_verify_queue (
            airfoil_id, revision_id, aoa_deg, background_owner, state,
            precalc_result_id, precalc_result_attempt_id, verify_result_id,
            delta_cl, delta_cd, delta_cm, last_outcome
          ) VALUES (
            ${cell.airfoilId}, ${cell.revisionId}, ${cell.aoaDeg}, false,
            'done', ${accepted.id}, ${acceptedPrecalcAttemptId},
            ${accepted.id}, 0, 0, 0,
            ${FINAL_URANS_OUTCOMES.accepted}
          )
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
        queueId = terminal?.id ?? null;
      }
      queueId ??=
        queues.find((queue) => ["pending", "running"].includes(queue.state))
          ?.id ?? null;
      queueId ??= queues.find((queue) => queue.state === "blocked")?.id ?? null;
      queueId ??=
        queues.find((queue) => queue.state === "cancelled")?.id ?? null;
      if (!queueId && accepted?.fidelity === "urans_precalc") {
        const [inserted] = (await tx.execute(sql`
          INSERT INTO sim_urans_verify_queue (
            airfoil_id, revision_id, aoa_deg, background_owner, state,
            precalc_result_id, precalc_result_attempt_id
          ) VALUES (
            ${cell.airfoilId}, ${cell.revisionId}, ${cell.aoaDeg}, false,
            'pending', ${accepted.id}, ${accepted.result_attempt_id}
          )
          ON CONFLICT (precalc_result_attempt_id)
            WHERE precalc_result_attempt_id IS NOT NULL
              AND state IN ('pending', 'running')
            DO NOTHING
          RETURNING id
        `)) as unknown as Array<{ id: string }>;
        queueId = inserted?.id ?? null;
        if (!queueId) {
          const [raced] = (await tx.execute(sql`
            SELECT id
            FROM sim_urans_verify_queue
            WHERE airfoil_id = ${cell.airfoilId}
              AND revision_id = ${cell.revisionId}
              AND aoa_deg = ${cell.aoaDeg}
              AND precalc_result_attempt_id = ${accepted.result_attempt_id}
            ORDER BY "createdAt", id
            LIMIT 1
          `)) as unknown as Array<{ id: string }>;
          queueId = raced?.id ?? null;
        }
      }

      if (!queueId) {
        missingPrecalc.push({
          airfoilId: cell.airfoilId,
          revisionId: cell.revisionId,
          aoaDeg: cell.aoaDeg,
        });
        continue;
      }
      if (queues.find((queue) => queue.id === queueId)?.state === "cancelled") {
        await tx.execute(sql`
          UPDATE sim_urans_verify_queue
          SET state = 'pending', sim_job_id = NULL, next_submit_at = NULL,
              "updatedAt" = now()
          WHERE id = ${queueId}
            AND state = 'cancelled'
        `);
      }
      await tx
        .insert(simUransVerifyQueueRequests)
        .values({ queueId, requestId: request.id })
        .onConflictDoNothing();
      await seedFinalContinuationFromRequestInTransaction(tx, {
        requestId: request.id,
        queueId,
        airfoilId: cell.airfoilId,
        revisionId: cell.revisionId,
        aoaDeg: cell.aoaDeg,
      });
      verifyQueueIds.push(queueId);
    }

    let precalcObligations: SimPrecalcObligation[] = [];
    if (missingPrecalc.length) {
      precalcObligations = await ensurePrecalcObligationsInTransaction(
        tx,
        missingPrecalc,
        {
          campaignIds,
          requestIds: [request.id],
        },
      );
    }

    const coveredCells = (await tx.execute(sql`
      SELECT obligation.airfoil_id,
             obligation.revision_id,
             obligation.aoa_deg::float8 AS aoa_deg
      FROM sim_precalc_obligation_requests coverage
      JOIN sim_precalc_obligations obligation
        ON obligation.id = coverage.obligation_id
      WHERE coverage.request_id = ${request.id}
      UNION
      SELECT queue.airfoil_id,
             queue.revision_id,
             queue.aoa_deg::float8 AS aoa_deg
      FROM sim_urans_verify_queue_requests coverage
      JOIN sim_urans_verify_queue queue ON queue.id = coverage.queue_id
      WHERE coverage.request_id = ${request.id}
    `)) as unknown as Array<{
      airfoil_id: string;
      revision_id: string;
      aoa_deg: number;
    }>;
    const coveredKeys = new Set(
      coveredCells.map(
        (cell) =>
          `${cell.airfoil_id}:${cell.revision_id}:${Number(cell.aoa_deg)}`,
      ),
    );
    const uncovered = cells.filter(
      (cell) =>
        !coveredKeys.has(
          `${cell.airfoilId}:${cell.revisionId}:${Number(cell.aoaDeg)}`,
        ),
    );
    if (uncovered.length) {
      throw new FullUransRequestCoverageIncompleteError(request.id, uncovered);
    }

    const linkedObligations = await tx
      .select({ obligation: simPrecalcObligations })
      .from(simPrecalcObligationRequests)
      .innerJoin(
        simPrecalcObligations,
        eq(simPrecalcObligations.id, simPrecalcObligationRequests.obligationId),
      )
      .where(
        and(
          eq(simPrecalcObligationRequests.requestId, request.id),
          sql`NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests final_coverage
            JOIN sim_urans_verify_queue queue
              ON queue.id = final_coverage.queue_id
            WHERE final_coverage.request_id = ${request.id}
              AND queue.airfoil_id = ${simPrecalcObligations.airfoilId}
              AND queue.revision_id = ${simPrecalcObligations.revisionId}
              AND queue.aoa_deg = ${simPrecalcObligations.aoaDeg}
          )`,
        ),
      );
    const linkedQueueRows = await tx
      .select({ queueId: simUransVerifyQueueRequests.queueId })
      .from(simUransVerifyQueueRequests)
      .where(eq(simUransVerifyQueueRequests.requestId, request.id));
    return {
      requestId: request.id,
      totalCells: cells.length,
      precalcObligations: linkedObligations.map((row) => row.obligation),
      verifyQueueIds: linkedQueueRows.map((row) => row.queueId),
    };
  });
}

export type FullUransRequestProjectedState =
  | "pending"
  | "running"
  | "done"
  | "blocked"
  | "cancelled";

/** Project an aggregate full request from its per-point child ledgers. A
 * satisfied preliminary cell is not complete until a linked final queue row
 * exists. Open children outrank blocked siblings so all recoverable points
 * continue before the aggregate becomes critically blocked. */
export async function fullUransRequestStateFromCoverage(
  tx: DB,
  requestId: string,
): Promise<FullUransRequestProjectedState> {
  const [summary] = (await tx.execute(sql`
    SELECT
      request.background_owner
      OR EXISTS (
        SELECT 1
        FROM sim_urans_request_campaigns ownership
        JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
        WHERE ownership.request_id = request.id
          AND ownership.state = 'active'
          AND campaign.status IN ('active', 'attention', 'paused')
      ) AS owner_live,
      EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_requests coverage
        JOIN sim_precalc_obligations obligation
          ON obligation.id = coverage.obligation_id
        WHERE coverage.request_id = request.id
          AND obligation.state IN ('pending', 'running')
          AND NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests verify_coverage
            JOIN sim_urans_verify_queue queue
              ON queue.id = verify_coverage.queue_id
            WHERE verify_coverage.request_id = request.id
              AND queue.airfoil_id = obligation.airfoil_id
              AND queue.revision_id = obligation.revision_id
              AND queue.aoa_deg = obligation.aoa_deg
          )
      ) AS preliminary_open,
      EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_requests coverage
        JOIN sim_precalc_obligations obligation
          ON obligation.id = coverage.obligation_id
        WHERE coverage.request_id = request.id
          AND obligation.state = 'blocked'
          AND NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests verify_coverage
            JOIN sim_urans_verify_queue queue
              ON queue.id = verify_coverage.queue_id
            WHERE verify_coverage.request_id = request.id
              AND queue.airfoil_id = obligation.airfoil_id
              AND queue.revision_id = obligation.revision_id
              AND queue.aoa_deg = obligation.aoa_deg
          )
      ) AS preliminary_blocked,
      EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_requests coverage
        JOIN sim_precalc_obligations obligation
          ON obligation.id = coverage.obligation_id
        WHERE coverage.request_id = request.id
          AND NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_requests verify_coverage
            JOIN sim_urans_verify_queue queue
              ON queue.id = verify_coverage.queue_id
            WHERE verify_coverage.request_id = request.id
              AND queue.airfoil_id = obligation.airfoil_id
              AND queue.revision_id = obligation.revision_id
              AND queue.aoa_deg = obligation.aoa_deg
          )
      ) AS preliminary_without_final,
      COALESCE(bool_or(queue.state IN ('pending', 'running')), false)
        AS final_open,
      COALESCE(bool_or(queue.state = 'blocked'), false) AS final_blocked,
      COALESCE(bool_or(queue.state = 'cancelled'), false) AS final_cancelled,
      count(queue.id)::int AS final_count,
      count(queue.id) FILTER (
        WHERE queue.state IN ('done', 'disagreed')
      )::int AS final_success_count
    FROM sim_urans_requests request
    LEFT JOIN sim_urans_verify_queue_requests final_coverage
      ON final_coverage.request_id = request.id
    LEFT JOIN sim_urans_verify_queue queue
      ON queue.id = final_coverage.queue_id
    WHERE request.id = ${requestId}
      AND request.fidelity = 'full'
    GROUP BY request.id
  `)) as unknown as Array<{
    owner_live: boolean;
    preliminary_open: boolean;
    preliminary_blocked: boolean;
    preliminary_without_final: boolean;
    final_open: boolean;
    final_blocked: boolean;
    final_cancelled: boolean;
    final_count: number;
    final_success_count: number;
  }>;
  if (!summary?.owner_live) return "cancelled";
  if (summary.preliminary_open) return "pending";
  if (summary.final_open) return "running";
  if (summary.preliminary_blocked || summary.final_blocked) return "blocked";
  if (summary.preliminary_without_final) return "pending";
  if (
    summary.final_count > 0 &&
    summary.final_success_count === summary.final_count
  ) {
    return "done";
  }
  if (summary.final_cancelled) return "pending";
  return "pending";
}

/** Transaction-safe aggregate projection for queue settlement/media-repair
 * paths. Queue transitions lock queue before request throughout the existing
 * lifecycle, so this helper deliberately takes no request lock before reading
 * child state and performs only the final fenced request update. */
export async function refreshFullUransRequestStateInTransaction(
  tx: DB,
  requestId: string,
): Promise<FullUransRequestProjectedState | null> {
  const [request] = await tx
    .select({
      fidelity: simUransRequests.fidelity,
      state: simUransRequests.state,
      simJobId: simUransRequests.simJobId,
    })
    .from(simUransRequests)
    .where(eq(simUransRequests.id, requestId))
    .limit(1);
  if (!request || request.fidelity !== "full") return null;
  if (request.state === "cancelled") return "cancelled";
  const state = await fullUransRequestStateFromCoverage(tx, requestId);
  const [activePhysicalJob] =
    state === "pending" && request.simJobId
      ? ((await tx.execute(sql`
          SELECT job.id
          FROM sim_jobs job
          WHERE job.id = ${request.simJobId}
            AND job.status IN ('pending', 'submitted', 'running', 'ingesting')
          LIMIT 1
        `)) as unknown as Array<{ id: string }>)
      : [];
  const projectedState = activePhysicalJob ? "running" : state;
  await tx
    .update(simUransRequests)
    .set({
      state: projectedState,
      simJobId: activePhysicalJob ? activePhysicalJob.id : null,
    })
    .where(
      and(
        eq(simUransRequests.id, requestId),
        eq(simUransRequests.fidelity, "full"),
        sql`${simUransRequests.state} <> 'cancelled'`,
      ),
    );
  return projectedState;
}

export async function refreshFullUransRequestState(
  db: DB,
  requestId: string,
): Promise<FullUransRequestProjectedState | null> {
  return db.transaction((rawTx) =>
    refreshFullUransRequestStateInTransaction(
      rawTx as unknown as DB,
      requestId,
    ),
  );
}

export async function refreshFullUransRequestsForVerifyQueueInTransaction(
  tx: DB,
  queueId: string,
): Promise<string[]> {
  const links = await tx
    .select({ requestId: simUransVerifyQueueRequests.requestId })
    .from(simUransVerifyQueueRequests)
    .where(eq(simUransVerifyQueueRequests.queueId, queueId))
    .orderBy(asc(simUransVerifyQueueRequests.requestId));
  const refreshed: string[] = [];
  for (const link of links) {
    const state = await refreshFullUransRequestStateInTransaction(
      tx,
      link.requestId,
    );
    if (state) refreshed.push(link.requestId);
  }
  return refreshed;
}

export async function refreshFullUransRequestsForVerifyQueue(
  db: DB,
  queueId: string,
): Promise<string[]> {
  return db.transaction((rawTx) =>
    refreshFullUransRequestsForVerifyQueueInTransaction(
      rawTx as unknown as DB,
      queueId,
    ),
  );
}

// ---------------------------------------------------------------------------
// Ladder gates (contract 5).
// ---------------------------------------------------------------------------

/** A terminal/cancelled wave-1 parent can publish immutable RANS attempt
 * evidence before a canonical results row is installed. Such a cell is a
 * ladder obligation, not an unsolved RANS gap. Keep this expression shared by
 * the boolean gate and tier count so their answers cannot diverge. */
const ATTEMPT_BACKED_PRECALC_CELL_SQL = sql`EXISTS (
  SELECT 1
  FROM result_attempts ladder_attempt
  JOIN sim_jobs attempt_parent ON attempt_parent.id = ladder_attempt.sim_job_id
  LEFT JOIN result_classifications attempt_classification
    ON attempt_classification.result_attempt_id = ladder_attempt.id
  WHERE attempt_parent.campaign_id = p.campaign_id
    AND attempt_parent.wave = 1
    AND attempt_parent.status = 'cancelled'
    AND ladder_attempt.airfoil_id = p.airfoil_id
    AND ladder_attempt.simulation_preset_revision_id = p.revision_id
    AND ladder_attempt.aoa_deg = p.aoa_deg
    AND ladder_attempt.regime = 'rans'
    AND ladder_attempt.valid_for_polar = false
    AND (
      ladder_attempt.status = 'failed'
      OR attempt_classification.state IN ('needs_urans', 'rejected')
    )
)`;

/** Per-campaign precalc gate: URANS (precalc) work is gated while the campaign
 *  still has ANY open RANS gap. "Open RANS gap" mirrors the gap finder
 *  (findCampaignGapBatch): a requested, non-derived cell on a live condition
 *  that is still SCHEDULABLE as wave-1 work (no results row, or pending/
 *  stale), plus cells whose claim is held by an IN-FLIGHT wave-1 job (RANS
 *  still solving). A requested cell claimed by a wave-2 job — or left queued
 *  by a finished parent for its wave-2 child — is URANS work, not a RANS gap,
 *  so it must never gate the very retry that resolves it. */
export async function campaignHasOpenRansGaps(
  db: DB,
  campaignId: string,
): Promise<boolean> {
  const rows = (await db.execute(sql`
    SELECT 1 FROM sim_campaign_points p
    JOIN sim_campaign_conditions c ON c.id = p.condition_id AND c.status IN ('active', 'kept')
    JOIN airfoils a ON a.id = p.airfoil_id
    LEFT JOIN results r
      ON r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
    LEFT JOIN sim_jobs j ON j.id = r.sim_job_id
    WHERE p.campaign_id = ${campaignId} AND p.state = 'requested'
      AND p.derived_by_symmetry = false
      AND NOT (a.is_symmetric AND p.aoa_deg < 0)
      AND (
        (
          (r.id IS NULL OR r.status IN ('pending', 'stale'))
          AND NOT (${ATTEMPT_BACKED_PRECALC_CELL_SQL})
        )
        OR (
          r.status IN ('queued', 'running')
          AND j.wave = 1
          AND j.status IN ('pending', 'submitted', 'running', 'ingesting')
        )
      )
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

/** Idle-capacity verify gate: outside the bounded eight-RANS interleave,
 * verify-queue items schedule only when no campaign RANS/PRECALC work exists
 * anywhere — no open campaign gap, no pending admin request-URANS item, and no
 * in-flight non-verify campaign job. */
export async function hasOpenCampaignLadderWork(
  db: DB,
  scope: {
    requestIds?: string[];
    campaignIds?: string[];
    /** When false, a temporarily unavailable PRECALC capability must not make
     * unrelated full-fidelity verification look busy forever. Already-active
     * jobs still retain their normal lower-tier barrier. */
    includePrecalc?: boolean;
  } = {},
): Promise<boolean> {
  const includePrecalc = scope.includePrecalc !== false;
  const isolatedRequests = scope.requestIds !== undefined;
  const requestScope = !isolatedRequests
    ? sql``
    : scope.requestIds!.length
      ? sql`AND req.id = ANY(${sql`ARRAY[${sql.join(
          scope.requestIds!.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})`
      : sql`AND false`;
  const requestJobScope = !isolatedRequests
    ? sql``
    : scope.requestIds!.length
      ? sql`AND j.request_payload ->> 'uransRequestId' = ANY(${sql`ARRAY[${sql.join(
          scope.requestIds!.map((id) => sql`${id}`),
          sql`, `,
        )}]`}::text[])`
      : sql`AND false`;
  const requestFidelityScope = includePrecalc ? sql`` : sql`AND false`;
  const obligationCampaignScope = !includePrecalc
    ? sql`AND false`
    : scope.campaignIds === undefined
      ? sql``
      : scope.campaignIds.length
        ? sql`AND EXISTS (
        SELECT 1
        FROM sim_precalc_obligation_campaigns scoped_ownership
        WHERE scoped_ownership.obligation_id = obligation.id
          AND scoped_ownership.state = 'active'
          AND scoped_ownership.campaign_id = ANY(${sql`ARRAY[${sql.join(
            scope.campaignIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})
      )`
        : sql`AND false`;
  const [row] = (await db.execute(sql`
    SELECT
      ${
        isolatedRequests
          ? sql`false`
          : sql`EXISTS (
        SELECT 1 FROM sim_campaign_points p
        JOIN sim_campaigns camp ON camp.id = p.campaign_id AND camp.status = 'active'
        JOIN sim_campaign_conditions c ON c.id = p.condition_id AND c.status IN ('active', 'kept')
        WHERE p.state = 'requested'
      )`
      } AS rans_open,
      EXISTS (
        SELECT 1 FROM sim_urans_requests req
        WHERE req.state IN ('pending', 'running')
          ${requestScope}
          ${requestFidelityScope}
          AND NOT (
            req.fidelity = 'full'
            AND req.sim_job_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_requests final_coverage
              JOIN sim_urans_verify_queue queue
                ON queue.id = final_coverage.queue_id
              WHERE final_coverage.request_id = req.id
                AND queue.state IN ('pending', 'running')
            )
            AND NOT EXISTS (
              SELECT 1
              FROM sim_precalc_obligation_requests preliminary_coverage
              JOIN sim_precalc_obligations obligation
                ON obligation.id = preliminary_coverage.obligation_id
              WHERE preliminary_coverage.request_id = req.id
                AND obligation.state IN ('pending', 'running')
                AND NOT EXISTS (
                  SELECT 1
                  FROM sim_urans_verify_queue_requests covered_final
                  JOIN sim_urans_verify_queue covered_queue
                    ON covered_queue.id = covered_final.queue_id
                  WHERE covered_final.request_id = req.id
                    AND covered_queue.airfoil_id = obligation.airfoil_id
                    AND covered_queue.revision_id = obligation.revision_id
                    AND covered_queue.aoa_deg = obligation.aoa_deg
                )
            )
          )
          AND (
            req.background_owner
            OR EXISTS (
              SELECT 1
              FROM sim_urans_request_campaigns ownership
              JOIN sim_campaigns owner ON owner.id = ownership.campaign_id
              WHERE ownership.request_id = req.id
                AND ownership.state = 'active'
                AND owner.status IN ('active', 'attention')
            )
          )
      ) AS requests_open,
      EXISTS (
        SELECT 1 FROM sim_precalc_obligations obligation
        WHERE obligation.state IN ('pending', 'running')
          ${obligationCampaignScope}
          AND (
            obligation.background_owner
            OR EXISTS (
              SELECT 1
              FROM sim_precalc_obligation_campaigns ownership
              JOIN sim_campaigns owner ON owner.id = ownership.campaign_id
              WHERE ownership.obligation_id = obligation.id
                AND ownership.state = 'active'
                AND owner.status IN ('active', 'attention')
            )
          )
      ) AS obligations_open,
      EXISTS (
        -- Keep verify below every in-flight precalc job, including the
        -- campaign_id=NULL physical job of a shared request. The request may
        -- already be marked done during ingest; the job remains the boundary
        -- until its own terminal write commits.
        SELECT 1 FROM sim_jobs j
        WHERE j.status IN ('pending', 'submitted', 'running', 'ingesting')
          AND j.job_kind <> 'verify'
          ${requestJobScope}
          AND (
            EXISTS (
              SELECT 1 FROM sim_campaigns camp
              WHERE camp.id = j.campaign_id
                AND camp.status IN ('active', 'attention')
            )
            OR (
              j.campaign_id IS NULL
              AND EXISTS (
                SELECT 1
                FROM sim_urans_requests linked_request
                WHERE linked_request.id::text = j.request_payload ->> 'uransRequestId'
                  AND (
                    linked_request.background_owner
                    OR EXISTS (
                      SELECT 1
                      FROM sim_urans_request_campaigns ownership
                      JOIN sim_campaigns owner_campaign ON owner_campaign.id = ownership.campaign_id
                      WHERE ownership.request_id = linked_request.id
                        AND ownership.state = 'active'
                        AND owner_campaign.status IN ('active', 'attention')
                    )
                  )
              )
            )
          )
      ) AS campaign_jobs_open
  `)) as unknown as {
    rans_open: boolean;
    requests_open: boolean;
    obligations_open: boolean;
    campaign_jobs_open: boolean;
  }[];
  return Boolean(
    row?.rans_open ||
    row?.requests_open ||
    row?.obligations_open ||
    row?.campaign_jobs_open,
  );
}

// ---------------------------------------------------------------------------
// Campaign tier counts + derived phase (contract 7 — DERIVED, no stored enum).
// ---------------------------------------------------------------------------
export interface CampaignTierCounts {
  /** Open RANS obligations: requested cells on live conditions. */
  ransOpen: number;
  /** Open precalc obligations: solved cells whose verdict is needs_urans (the
   *  RANS evidence demands an unsteady re-solve that has not superseded it
   *  yet) plus live cells currently re-solving under a wave-2 job. */
  precalcOpen: number;
  /** Open verification obligations: pending/running verify-queue items. */
  verifyOpen: number;
}

export async function campaignOpenTierCounts(
  db: DB,
  campaignId: string,
): Promise<CampaignTierCounts> {
  const [row] = (await db.execute(sql`
    SELECT
      (
        -- RANS tier: requested non-derived cells still on the wave-1 path —
        -- schedulable gaps (no row / pending / stale) or claims held by an
        -- in-flight wave-1 job (same shape as campaignHasOpenRansGaps).
        SELECT count(*) FROM sim_campaign_points p
        JOIN sim_campaign_conditions c ON c.id = p.condition_id AND c.status IN ('active', 'kept')
        JOIN airfoils a ON a.id = p.airfoil_id
        LEFT JOIN results r
          ON r.airfoil_id = p.airfoil_id AND r.simulation_preset_revision_id = p.revision_id AND r.aoa_deg = p.aoa_deg
        LEFT JOIN sim_jobs j ON j.id = r.sim_job_id
        WHERE p.campaign_id = ${campaignId} AND p.state = 'requested'
          AND p.derived_by_symmetry = false
          AND NOT (a.is_symmetric AND p.aoa_deg < 0)
          AND (
            (
              (r.id IS NULL OR r.status IN ('pending', 'stale'))
              AND NOT (${ATTEMPT_BACKED_PRECALC_CELL_SQL})
            )
            OR (r.status IN ('queued', 'running') AND j.wave = 1 AND j.status IN ('pending', 'submitted', 'running', 'ingesting'))
          )
      )::int AS rans_open,
      (
        -- One physical cell may be visible through several durable sources at
        -- once (classification, live wave-2 claim, automatic request, media
        -- repair). UNION the physical keys before counting so UI totals never
        -- inflate one point into two or three obligations.
        SELECT count(*)::int
        FROM (
          SELECT p.airfoil_id, p.revision_id, p.aoa_deg
          FROM sim_campaign_points p
          JOIN sim_campaign_conditions c ON c.id = p.condition_id AND c.status IN ('active', 'kept')
          LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
          LEFT JOIN results live
            ON live.airfoil_id = p.airfoil_id
           AND live.simulation_preset_revision_id = p.revision_id
           AND live.aoa_deg = p.aoa_deg
          LEFT JOIN sim_jobs lj ON lj.id = live.sim_job_id
          WHERE p.campaign_id = ${campaignId}
            AND p.derived_by_symmetry = false
            AND (
              NOT EXISTS (
                SELECT 1 FROM sim_precalc_obligations known_obligation
                WHERE known_obligation.airfoil_id = p.airfoil_id
                  AND known_obligation.revision_id = p.revision_id
                  AND known_obligation.aoa_deg = p.aoa_deg
              )
              OR EXISTS (
                SELECT 1 FROM sim_precalc_obligations open_obligation
                WHERE open_obligation.airfoil_id = p.airfoil_id
                  AND open_obligation.revision_id = p.revision_id
                  AND open_obligation.aoa_deg = p.aoa_deg
                  AND open_obligation.state IN ('pending', 'running')
              )
            )
            AND (
              (
                p.state = 'terminal'
                AND (
                  rc.state = 'needs_urans'
                  OR (
                    rc.state = 'rejected'
                    AND live.status = 'done'
                    AND (
                      live.fidelity = 'rans'
                      OR (live.fidelity IS NULL AND live.regime IS DISTINCT FROM 'urans')
                    )
                  )
                )
              )
              OR (
                live.status IN ('queued', 'running')
                AND (lj.wave IS NULL OR lj.wave <> 1 OR lj.status IN ('done', 'failed', 'cancelled'))
              )
            )

          UNION

          SELECT obligation.airfoil_id, obligation.revision_id, obligation.aoa_deg
          FROM sim_precalc_obligation_campaigns ownership
          JOIN sim_precalc_obligations obligation
            ON obligation.id = ownership.obligation_id
          WHERE ownership.campaign_id = ${campaignId}
            AND ownership.state = 'active'
            AND obligation.state IN ('pending', 'running')

          UNION

          SELECT request_point.airfoil_id, request_point.revision_id, request_point.aoa_deg
          FROM sim_urans_request_campaigns ownership
          JOIN sim_urans_requests req ON req.id = ownership.request_id
          JOIN sim_campaign_points request_point
            ON request_point.campaign_id = ownership.campaign_id
           AND request_point.airfoil_id = req.airfoil_id
           AND request_point.revision_id = req.revision_id
           AND (req.aoa_deg IS NULL OR request_point.aoa_deg = req.aoa_deg)
           AND request_point.derived_by_symmetry = false
          WHERE ownership.campaign_id = ${campaignId}
            AND ownership.state = 'active'
            AND req.fidelity = 'precalc'
            AND req.state IN ('pending', 'running')

          UNION

          SELECT repair_point.airfoil_id, repair_point.revision_id, repair_point.aoa_deg
          FROM result_media_repairs repair
          JOIN results repair_result ON repair_result.id = repair.result_id
          JOIN sim_campaign_points repair_point ON repair_point.result_id = repair_result.id
          WHERE repair_point.campaign_id = ${campaignId}
            AND repair_point.derived_by_symmetry = false
            AND repair.state IN ('pending', 'running', 'retry_wait')
        ) physical_precalc_cell
      ) AS precalc_open,
      (
        SELECT count(DISTINCT q.id)
        FROM sim_urans_verify_queue q
        WHERE ${verifyQueueCampaignScopeSql(sql`q.id`, [campaignId])}
          AND q.state IN ('pending', 'running')
      )::int AS verify_open
  `)) as unknown as {
    rans_open: number;
    precalc_open: number;
    verify_open: number;
  }[];
  return {
    ransOpen: Number(row?.rans_open ?? 0),
    precalcOpen: Number(row?.precalc_open ?? 0),
    verifyOpen: Number(row?.verify_open ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Rolling-compatibility ladder buckets, derived live from one canonical SQL
// definition (no stored counters).
//
//   awaiting_urans — tier-1 rejects: terminal, non-derived, result DONE with a
//     'rejected' classification at fidelity 'rans' (NULL fidelity is a
//     pre-ladder RANS fallback only when regime is not explicitly URANS).
//     These are the stage-2 queue: calm violet, never red, no repair verbs.
//
//   needs_review — legacy wire key only. Its predicate is deliberately empty.
//     Machine failures, exhausted retries, rejected solver rows, and immutable
//     setup/media defects stay visible as failed/blocked/unavailable work; they
//     never become a coefficient-review chore merely because automation cannot
//     repair them.
//
// The point-history read model (point-history.ts) applies the SAME rule to
// raw results rows for the Points tab filters; both sides are pinned by the
// bucket-predicate matrix tests.
// ---------------------------------------------------------------------------
export interface CampaignReviewBuckets {
  awaitingUrans: number;
  needsReview: number;
}

export interface CampaignReviewBucketRow extends CampaignReviewBuckets {
  conditionId: string;
  airfoilId: string;
}

const AWAITING_URANS_POINT_SQL = sql`
  p.state = 'terminal' AND p.derived_by_symmetry = false
  AND r.status = 'done' AND rc.state = 'rejected'
  AND EXISTS (
    SELECT 1 FROM sim_precalc_obligations open_obligation
    WHERE open_obligation.airfoil_id = p.airfoil_id
      AND open_obligation.revision_id = p.revision_id
      AND open_obligation.aoa_deg = p.aoa_deg
      AND open_obligation.state IN ('pending', 'running')
  )
  AND (
    r.fidelity = 'rans'
    OR (r.fidelity IS NULL AND r.regime IS DISTINCT FROM 'urans')
  )`;

// Derived symmetry mirrors are excluded from BOTH arms: repairing the source
// point repairs its mirror and the Points tab bucket filters source rows only.
// `needs_review` is deliberately empty. A future human-adjudication workflow
// needs its own informed product decision; it must not be inferred from an
// automatic solver failure. Exhausted work stays rejected/failed/blocked: it
// is never auto-accepted and never becomes a coefficient-review chore.
const NEEDS_REVIEW_POINT_SQL = sql`FALSE`;

interface ReviewBucketQueryRow {
  condition_id: string;
  airfoil_id: string;
  awaiting_urans: number;
  needs_review: number;
}

/** Per-(condition, airfoil) rolling-compatibility ladder buckets. The coverage
 *  matrix and summary consume the same canonical query. */
export async function campaignReviewBucketRows(
  db: DB,
  campaignId: string,
  opts: { airfoilIds?: string[] } = {},
): Promise<CampaignReviewBucketRow[]> {
  const airfoilFilter = opts.airfoilIds?.length
    ? sql`AND p.airfoil_id = ANY(${sql`ARRAY[${sql.join(
        opts.airfoilIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )}]`})`
    : sql``;
  const rows = (await db.execute(sql`
    SELECT p.condition_id, p.airfoil_id,
      COUNT(*) FILTER (WHERE ${AWAITING_URANS_POINT_SQL})::int AS awaiting_urans,
      COUNT(*) FILTER (WHERE ${NEEDS_REVIEW_POINT_SQL})::int AS needs_review
    FROM sim_campaign_points p
    JOIN sim_campaign_conditions condition ON condition.id = p.condition_id
    JOIN sim_campaigns campaign ON campaign.id = p.campaign_id
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE p.campaign_id = ${campaignId}
      AND condition.generation = campaign.current_condition_generation
      AND condition.status IN ('active', 'kept')
      ${airfoilFilter}
    GROUP BY p.condition_id, p.airfoil_id
    HAVING COUNT(*) FILTER (WHERE ${AWAITING_URANS_POINT_SQL}) > 0
        OR COUNT(*) FILTER (WHERE ${NEEDS_REVIEW_POINT_SQL}) > 0
  `)) as unknown as ReviewBucketQueryRow[];
  return rows.map((row) => ({
    conditionId: row.condition_id,
    airfoilId: row.airfoil_id,
    awaitingUrans: Number(row.awaiting_urans),
    needsReview: Number(row.needs_review),
  }));
}

/** Whole-campaign rolling-compatibility ladder totals. */
export async function campaignReviewBuckets(
  db: DB,
  campaignId: string,
): Promise<CampaignReviewBuckets> {
  const [row] = (await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE ${AWAITING_URANS_POINT_SQL})::int AS awaiting_urans,
      COUNT(*) FILTER (WHERE ${NEEDS_REVIEW_POINT_SQL})::int AS needs_review
    FROM sim_campaign_points p
    JOIN sim_campaign_conditions condition ON condition.id = p.condition_id
    JOIN sim_campaigns campaign ON campaign.id = p.campaign_id
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE p.campaign_id = ${campaignId}
      AND condition.generation = campaign.current_condition_generation
      AND condition.status IN ('active', 'kept')
  `)) as unknown as Array<{ awaiting_urans: number; needs_review: number }>;
  return {
    awaitingUrans: Number(row?.awaiting_urans ?? 0),
    needsReview: Number(row?.needs_review ?? 0),
  };
}

/** Batched rolling-compatibility buckets for a campaign list payload.
 *  Campaigns without any bucketed point are absent from the map. */
export async function reviewBucketsByCampaign(
  db: DB,
  campaignIds: string[],
): Promise<Map<string, CampaignReviewBuckets>> {
  if (!campaignIds.length) return new Map();
  const rows = (await db.execute(sql`
    SELECT p.campaign_id,
      COUNT(*) FILTER (WHERE ${AWAITING_URANS_POINT_SQL})::int AS awaiting_urans,
      COUNT(*) FILTER (WHERE ${NEEDS_REVIEW_POINT_SQL})::int AS needs_review
    FROM sim_campaign_points p
    JOIN sim_campaign_conditions condition ON condition.id = p.condition_id
    JOIN sim_campaigns campaign ON campaign.id = p.campaign_id
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE p.campaign_id = ANY(${sql`ARRAY[${sql.join(
      campaignIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})
      AND condition.generation = campaign.current_condition_generation
      AND condition.status IN ('active', 'kept')
    GROUP BY p.campaign_id
  `)) as unknown as Array<{
    campaign_id: string;
    awaiting_urans: number;
    needs_review: number;
  }>;
  return new Map(
    rows.map((row) => [
      row.campaign_id,
      {
        awaitingUrans: Number(row.awaiting_urans),
        needsReview: Number(row.needs_review),
      },
    ]),
  );
}

export type CampaignPhase =
  | "running_rans"
  | "running_precalc"
  | "running_refinement"
  | "completed"
  | null;

/** Derived campaign phase (contract 7): running_rans → running_precalc →
 *  running_refinement → completed. Pure. Non-running statuses (paused,
 *  cancelled, archived) have no ladder phase; `attention`/`completed` report
 *  their own status truthfully (phase only decorates an active ladder). */
export function deriveCampaignPhase(
  status: string,
  tiers: CampaignTierCounts,
): CampaignPhase {
  if (status === "completed") return "completed";
  if (status !== "active" && status !== "attention") return null;
  if (tiers.ransOpen > 0) return "running_rans";
  if (tiers.precalcOpen > 0) return "running_precalc";
  if (tiers.verifyOpen > 0) return "running_refinement";
  return status === "active" ? "completed" : null;
}

// ---------------------------------------------------------------------------
// Queue/request accessors used by the sweeper ladder tick.
// ---------------------------------------------------------------------------
function linkedFullRequestOwnerSql(
  queueId: string | SQLWrapper,
  includePaused = false,
) {
  const campaignStates = includePaused
    ? sql`('active', 'attention', 'paused')`
    : sql`('active', 'attention')`;
  return sql`EXISTS (
    SELECT 1
    FROM sim_urans_verify_queue_requests coverage
    JOIN sim_urans_requests request ON request.id = coverage.request_id
    WHERE coverage.queue_id = ${queueId}
      AND request.fidelity = 'full'
      AND request.state IN ('pending', 'running')
      AND (
        request.background_owner
        OR EXISTS (
          SELECT 1
          FROM sim_urans_request_campaigns ownership
          JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
          WHERE ownership.request_id = request.id
            AND ownership.state = 'active'
            AND campaign.status IN ${campaignStates}
        )
      )
  )`;
}

function verifyQueueLiveOwnerSql(
  queueId: string | SQLWrapper,
  includePaused = false,
) {
  const campaignStates = includePaused
    ? sql`('active', 'attention', 'paused')`
    : sql`('active', 'attention')`;
  return sql`(
    EXISTS (
      SELECT 1
      FROM sim_urans_verify_queue owned_queue
      WHERE owned_queue.id = ${queueId}
        AND owned_queue.background_owner
    )
    OR EXISTS (
      SELECT 1
      FROM sim_urans_verify_queue_campaigns ownership
      JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
      WHERE ownership.queue_id = ${queueId}
        AND ownership.state = 'active'
        AND campaign.status IN ${campaignStates}
    )
    OR ${linkedFullRequestOwnerSql(queueId, includePaused)}
  )`;
}

function verifyQueueCampaignScopeSql(
  queueId: string | SQLWrapper,
  campaignIds: string[],
  requireOpenRequest = true,
) {
  if (!campaignIds.length) return sql`false`;
  const ids = sql`ARRAY[${sql.join(
    campaignIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
  return sql`(
    EXISTS (
      SELECT 1
      FROM sim_urans_verify_queue_campaigns scoped_owner
      WHERE scoped_owner.queue_id = ${queueId}
        AND scoped_owner.state = 'active'
        AND scoped_owner.campaign_id = ANY(${ids})
    )
    OR EXISTS (
      SELECT 1
      FROM sim_urans_verify_queue_requests coverage
      JOIN sim_urans_requests request ON request.id = coverage.request_id
      JOIN sim_urans_request_campaigns scoped_owner
        ON scoped_owner.request_id = request.id
      WHERE coverage.queue_id = ${queueId}
        AND request.fidelity = 'full'
        ${requireOpenRequest ? sql`AND request.state IN ('pending', 'running')` : sql``}
        AND scoped_owner.state = 'active'
        AND scoped_owner.campaign_id = ANY(${ids})
    )
  )`;
}

export interface PendingVerifyScope {
  /** Test-harness isolation for the shared dev DB. Production omits this and
   *  considers the global queue. */
  campaignIds?: string[];
  /** Test-only physical-item scope for background-owned rows, which have no
   * campaign association to isolate parallel files. Production omits this. */
  verifyIds?: string[];
  /** Rolling engine cutover gate. False keeps newly reopened continuation and
   * corrective-fresh recovery pending while still allowing an initial final
   * verification (and an ordinary transport retry) to be scheduled. */
  allowAutomaticRecovery?: boolean;
}

function verifyRecoveryScopeSql(scope: PendingVerifyScope) {
  return scope.allowAutomaticRecovery === false
    ? sql`AND q.fresh_attempt_count = 0
      AND q.continuation_attempt_count = 0
      AND COALESCE(q.last_outcome, '') NOT IN (
          ${FINAL_URANS_OUTCOMES.continuationPending},
          ${FINAL_URANS_OUTCOMES.continuationRetryWait},
          ${FINAL_URANS_OUTCOMES.freshRetryPending}
        )`
    : sql``;
}

/** A pending final-verification item cannot sit behind an unbounded wave-1
 * backlog. The scheduler admits at most this many new RANS jobs after the
 * oldest schedulable pending item (or the latest successfully admitted verify,
 * whichever is newer) before final verification owns the next eligible slot. */
export const MAX_WAVE1_ADMISSIONS_BEFORE_VERIFY = 8;

export interface VerifyInterleaveScope extends PendingVerifyScope {
  /** Test-only closed history for files sharing one live dev database.
   * Production omits this and counts every successfully admitted wave-1 job. */
  wave1JobIds?: string[];
}

export interface VerifyInterleaveDecision {
  due: boolean;
  pendingSince: Date | null;
  latestVerifySubmittedAt: Date | null;
  opportunitySince: Date | null;
  wave1AdmissionsSinceOpportunity: number;
}

/** Restart-safe final-verification fairness derived entirely from durable DB
 * history. No process-local counter is authoritative: after a restart, the
 * oldest runnable verify item, latest accepted verify submission, and wave-1
 * submittedAt history reconstruct the exact same decision.
 *
 * Only successful engine admissions count. Pending compositions and answered
 * submit failures have submittedAt=NULL and therefore cannot spend the bounded
 * RANS allowance. The bounded subquery stops once the threshold is reached. */
export async function finalVerifyInterleaveDecision(
  db: DB,
  scope: VerifyInterleaveScope = {},
): Promise<VerifyInterleaveDecision> {
  const campaignScopeSql =
    scope.campaignIds === undefined
      ? sql``
      : scope.campaignIds.length
        ? sql`AND ${verifyQueueCampaignScopeSql(sql`q.id`, scope.campaignIds)}`
        : sql`AND false`;
  const verifyScopeSql =
    scope.verifyIds === undefined
      ? sql``
      : scope.verifyIds.length
        ? sql`AND q.id = ANY(${sql`ARRAY[${sql.join(
            scope.verifyIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;
  const latestVerifyScopeSql =
    scope.verifyIds === undefined
      ? scope.campaignIds === undefined
        ? sql``
        : scope.campaignIds.length
          ? sql`AND ${verifyQueueCampaignScopeSql(
              sql`(verify_job.request_payload ->> 'verifyQueueItemId')::uuid`,
              scope.campaignIds,
              false,
            )}`
          : sql`AND false`
      : scope.verifyIds.length
        ? sql`AND verify_job.request_payload ->> 'verifyQueueItemId' =
          ANY(${sql`ARRAY[${sql.join(
            scope.verifyIds.map((id) => sql`${id}`),
            sql`, `,
          )}]`}::text[])`
        : sql`AND false`;
  const wave1ScopeSql =
    scope.wave1JobIds === undefined
      ? scope.campaignIds === undefined
        ? sql``
        : scope.campaignIds.length
          ? sql`AND wave1.campaign_id = ANY(${sql`ARRAY[${sql.join(
              scope.campaignIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})`
          : sql`AND false`
      : scope.wave1JobIds.length
        ? sql`AND wave1.id = ANY(${sql`ARRAY[${sql.join(
            scope.wave1JobIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;

  const recoveryScopeSql = verifyRecoveryScopeSql(scope);
  const [row] = (await db.execute(sql`
    WITH oldest_pending AS (
      SELECT MIN(q."createdAt") AS pending_since
      FROM sim_urans_verify_queue q
      WHERE q.state = 'pending'
        AND (q.next_submit_at IS NULL OR q.next_submit_at <= now())
        AND COALESCE(q.last_outcome, '') <> ${FINAL_URANS_OUTCOMES.mediaRepairPending}
        ${recoveryScopeSql}
        ${campaignScopeSql}
        ${verifyScopeSql}
        AND NOT EXISTS (
          SELECT 1
          FROM sim_ladder_submit_retries submit_retry
          WHERE submit_retry.verify_queue_id = q.id
            AND (
              submit_retry.state = 'blocked'
              OR submit_retry.next_attempt_at > now()
            )
        )
        AND ${verifyQueueLiveOwnerSql(sql`q.id`)}
    ),
    latest_verify AS (
      SELECT MAX(verify_job."submittedAt") AS latest_verify_submitted_at
      FROM sim_jobs verify_job
      WHERE verify_job.job_kind = 'verify'
        AND verify_job."submittedAt" IS NOT NULL
        ${latestVerifyScopeSql}
    ),
    opportunity AS (
      SELECT
        oldest_pending.pending_since,
        latest_verify.latest_verify_submitted_at,
        CASE
          WHEN oldest_pending.pending_since IS NULL THEN NULL
          ELSE GREATEST(
            oldest_pending.pending_since,
            COALESCE(
              latest_verify.latest_verify_submitted_at,
              oldest_pending.pending_since
            )
          )
        END AS opportunity_since
      FROM oldest_pending
      CROSS JOIN latest_verify
    ),
    bounded_wave1_admissions AS (
      SELECT COUNT(*)::int AS admission_count
      FROM (
        SELECT 1
        FROM sim_jobs wave1
        CROSS JOIN opportunity
        WHERE opportunity.opportunity_since IS NOT NULL
          AND wave1.wave = 1
          AND wave1.job_kind <> 'verify'
          AND wave1."submittedAt" IS NOT NULL
          AND wave1."submittedAt" > opportunity.opportunity_since
          ${wave1ScopeSql}
        LIMIT ${MAX_WAVE1_ADMISSIONS_BEFORE_VERIFY}
      ) admitted
    )
    SELECT
      opportunity.pending_since,
      opportunity.latest_verify_submitted_at,
      opportunity.opportunity_since,
      bounded_wave1_admissions.admission_count
    FROM opportunity
    CROSS JOIN bounded_wave1_admissions
  `)) as unknown as Array<{
    pending_since: Date | string | null;
    latest_verify_submitted_at: Date | string | null;
    opportunity_since: Date | string | null;
    admission_count: number;
  }>;

  const asDate = (value: Date | string | null | undefined) =>
    value == null ? null : value instanceof Date ? value : new Date(value);
  const wave1AdmissionsSinceOpportunity = Number(row?.admission_count ?? 0);
  const pendingSince = asDate(row?.pending_since);
  return {
    due:
      pendingSince != null &&
      wave1AdmissionsSinceOpportunity >= MAX_WAVE1_ADMISSIONS_BEFORE_VERIFY,
    pendingSince,
    latestVerifySubmittedAt: asDate(row?.latest_verify_submitted_at),
    opportunitySince: asDate(row?.opportunity_since),
    wave1AdmissionsSinceOpportunity,
  };
}

export async function nextPendingVerifyItem(
  db: DB,
  scope: PendingVerifyScope = {},
): Promise<SimUransVerifyQueueItem | null> {
  const scopeSql =
    scope.campaignIds === undefined
      ? sql``
      : scope.campaignIds.length
        ? sql`AND ${verifyQueueCampaignScopeSql(sql`q.id`, scope.campaignIds)}`
        : sql`AND false`;
  const verifyScopeSql =
    scope.verifyIds === undefined
      ? sql``
      : scope.verifyIds.length
        ? sql`AND q.id = ANY(${sql`ARRAY[${sql.join(
            scope.verifyIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;
  const recoveryScopeSql = verifyRecoveryScopeSql(scope);
  const [candidate] = (await db.execute(sql`
    SELECT q.id
    FROM sim_urans_verify_queue q
    WHERE q.state = 'pending'
      AND (q.next_submit_at IS NULL OR q.next_submit_at <= now())
      AND COALESCE(q.last_outcome, '') <> ${FINAL_URANS_OUTCOMES.mediaRepairPending}
      ${recoveryScopeSql}
      ${scopeSql}
      ${verifyScopeSql}
      AND NOT EXISTS (
        SELECT 1 FROM sim_ladder_submit_retries submit_retry
        WHERE submit_retry.verify_queue_id = q.id
          AND (
            submit_retry.state = 'blocked'
            OR submit_retry.next_attempt_at > now()
          )
      )
      AND ${verifyQueueLiveOwnerSql(sql`q.id`)}
    ORDER BY q."createdAt" ASC
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (!candidate) return null;
  const [item] = await db
    .select()
    .from(simUransVerifyQueue)
    .where(eq(simUransVerifyQueue.id, candidate.id))
    .limit(1);
  return item ?? null;
}

/** Atomically claim the next schedulable verify item before engine work.
 * Lifecycle verbs lock campaign first, so claim follows the same order:
 * optimistic queue read -> campaign SHARE -> conditional pending→running.
 * Two claimers may read one candidate, but only one conditional update wins. */
export async function claimNextPendingVerifyItem(
  db: DB,
  scope: PendingVerifyScope = {},
): Promise<SimUransVerifyQueueItem | null> {
  return db.transaction(async (tx) => {
    const scopeSql =
      scope.campaignIds === undefined
        ? sql``
        : scope.campaignIds.length
          ? sql`AND ${verifyQueueCampaignScopeSql(
              sql`q.id`,
              scope.campaignIds,
            )}`
          : sql`AND false`;
    const verifyScopeSql =
      scope.verifyIds === undefined
        ? sql``
        : scope.verifyIds.length
          ? sql`AND q.id = ANY(${sql`ARRAY[${sql.join(
              scope.verifyIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})`
          : sql`AND false`;
    const recoveryScopeSql = verifyRecoveryScopeSql(scope);
    const [candidate] = (await tx.execute(sql`
      SELECT q.id
      FROM sim_urans_verify_queue q
      WHERE q.state = 'pending'
        AND (q.next_submit_at IS NULL OR q.next_submit_at <= now())
        AND COALESCE(q.last_outcome, '') <> ${FINAL_URANS_OUTCOMES.mediaRepairPending}
        ${recoveryScopeSql}
        ${scopeSql}
        ${verifyScopeSql}
        AND NOT EXISTS (
          SELECT 1 FROM sim_ladder_submit_retries submit_retry
          WHERE submit_retry.verify_queue_id = q.id
            AND (
              submit_retry.state = 'blocked'
              OR submit_retry.next_attempt_at > now()
            )
        )
        AND ${verifyQueueLiveOwnerSql(sql`q.id`)}
      ORDER BY q."createdAt" ASC
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (!candidate) return null;
    // Match campaign lifecycle's campaign-row lock order. Background-owned
    // work needs no campaign lock; shared work locks every currently-live
    // owner before the conditional state transition.
    await tx.execute(sql`
      SELECT campaign.id
      FROM sim_campaigns campaign
      WHERE campaign.id IN (
        SELECT ownership.campaign_id
        FROM sim_urans_verify_queue_campaigns ownership
        WHERE ownership.queue_id = ${candidate.id}
          AND ownership.state = 'active'
        UNION
        SELECT request_ownership.campaign_id
        FROM sim_urans_verify_queue_requests coverage
        JOIN sim_urans_requests request ON request.id = coverage.request_id
        JOIN sim_urans_request_campaigns request_ownership
          ON request_ownership.request_id = request.id
        WHERE coverage.queue_id = ${candidate.id}
          AND request.fidelity = 'full'
          AND request.state IN ('pending', 'running')
          AND request_ownership.state = 'active'
      )
        AND campaign.status IN ('active', 'attention')
      ORDER BY campaign.id
      FOR SHARE OF campaign
    `);
    const [claimed] = await tx
      .update(simUransVerifyQueue)
      // A new execution claim invalidates every historical job binding. The
      // composer installs the exact new sim_job_id before external submit.
      .set({ state: "running", simJobId: null })
      .where(
        and(
          eq(simUransVerifyQueue.id, candidate.id),
          eq(simUransVerifyQueue.state, "pending"),
          or(
            isNull(simUransVerifyQueue.nextSubmitAt),
            sql`${simUransVerifyQueue.nextSubmitAt} <= now()`,
          ),
          sql`COALESCE(${simUransVerifyQueue.lastOutcome}, '') <> ${FINAL_URANS_OUTCOMES.mediaRepairPending}`,
          ...(scope.allowAutomaticRecovery === false
            ? [
                sql`${simUransVerifyQueue.freshAttemptCount} = 0`,
                sql`${simUransVerifyQueue.continuationAttemptCount} = 0`,
                sql`COALESCE(${simUransVerifyQueue.lastOutcome}, '') NOT IN (
                    ${FINAL_URANS_OUTCOMES.continuationPending},
                    ${FINAL_URANS_OUTCOMES.continuationRetryWait},
                    ${FINAL_URANS_OUTCOMES.freshRetryPending}
                  )`,
              ]
            : []),
          ...(scope.verifyIds === undefined
            ? []
            : scope.verifyIds.length
              ? [inArray(simUransVerifyQueue.id, scope.verifyIds)]
              : [sql`false`]),
          sql`NOT EXISTS (
            SELECT 1 FROM sim_ladder_submit_retries submit_retry
            WHERE submit_retry.verify_queue_id = ${simUransVerifyQueue.id}
              AND (
                submit_retry.state = 'blocked'
                OR submit_retry.next_attempt_at > now()
              )
          )`,
          verifyQueueLiveOwnerSql(simUransVerifyQueue.id),
        ),
      )
      .returning();
    return claimed ?? null;
  });
}

/** Release a pre-submit verify claim after a transient engine connection
 *  failure. Paused work freezes as pending for resume; terminal campaign work
 *  becomes cancelled instead of being resurrected into a hidden pending row. */
const VERIFY_CLAIM_RELEASE_STATE_SQL = sql`CASE
  WHEN ${verifyQueueLiveOwnerSql(sql`q.id`, true)} THEN 'pending'
  ELSE 'cancelled'
END`;

export async function releaseClaimedVerifyItem(
  db: DB,
  itemId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE sim_urans_verify_queue q
    SET state = ${VERIFY_CLAIM_RELEASE_STATE_SQL},
        sim_job_id = NULL,
        "updatedAt" = now()
    WHERE q.id = ${itemId} AND q.state = 'running'
  `);
}

export async function nextPendingUransRequest(
  db: DB,
): Promise<SimUransRequest | null> {
  const [candidate] = (await db.execute(sql`
    SELECT req.id
    FROM sim_urans_requests req
    WHERE req.state = 'pending'
      AND (
        req.fidelity = 'full'
        OR NOT EXISTS (
          SELECT 1 FROM sim_ladder_submit_retries submit_retry
          WHERE submit_retry.urans_request_id = req.id
            AND (
              submit_retry.state = 'blocked'
              OR submit_retry.next_attempt_at > now()
            )
        )
      )
      AND (
        req.background_owner
        OR EXISTS (
          SELECT 1
          FROM sim_urans_request_campaigns ownership
          JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
          WHERE ownership.request_id = req.id
            AND ownership.state = 'active'
            AND campaign.status IN ('active', 'attention')
        )
      )
    ORDER BY req."createdAt" ASC
    LIMIT 1
  `)) as unknown as Array<{ id: string }>;
  if (!candidate) return null;
  const [request] = await db
    .select()
    .from(simUransRequests)
    .where(eq(simUransRequests.id, candidate.id))
    .limit(1);
  return request ?? null;
}

export interface PendingUransRequestScope {
  /** Test-harness isolation for the shared dev DB. Production omits this. */
  requestIds?: string[];
  /** Capability-aware lane selection. Undefined keeps the ordinary mixed
   * oldest-first queue; `full` lets full work proceed while PRECALC is gated. */
  fidelity?: "precalc" | "full";
}

/** Atomically claim one request before composition or external submit.
 * Campaign ownership follows the lifecycle lock order: optimistic request
 * read -> campaign SHARE -> conditional pending→running. Campaign-only
 * requests are eligible only with a live owner; background-owned requests
 * remain independently runnable regardless of their original creator. */
export async function claimNextPendingUransRequest(
  db: DB,
  scope: PendingUransRequestScope = {},
): Promise<SimUransRequest | null> {
  return db.transaction(async (tx) => {
    const requestScope =
      scope.requestIds === undefined
        ? sql``
        : scope.requestIds.length
          ? sql`AND req.id = ANY(${sql`ARRAY[${sql.join(
              scope.requestIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})`
          : sql`AND false`;
    const fidelityScope = scope.fidelity
      ? sql`AND req.fidelity = ${scope.fidelity}`
      : sql``;
    const [candidate] = (await tx.execute(sql`
      SELECT req.id, req.background_owner
      FROM sim_urans_requests req
      WHERE req.state = 'pending'
        ${requestScope}
        ${fidelityScope}
        AND (
          req.fidelity = 'full'
          OR NOT EXISTS (
            SELECT 1 FROM sim_ladder_submit_retries submit_retry
            WHERE submit_retry.urans_request_id = req.id
              AND (
                submit_retry.state = 'blocked'
                OR submit_retry.next_attempt_at > now()
              )
          )
        )
        AND (
          req.background_owner
          OR EXISTS (
            SELECT 1
            FROM sim_urans_request_campaigns ownership
            JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
            WHERE ownership.request_id = req.id
              AND ownership.state = 'active'
              AND campaign.status IN ('active', 'attention')
          )
        )
      ORDER BY req."createdAt" ASC
      LIMIT 1
    `)) as unknown as Array<{ id: string; background_owner: boolean }>;
    if (!candidate) return null;
    if (!candidate.background_owner) {
      await tx.execute(sql`
        SELECT campaign.id
        FROM sim_urans_request_campaigns ownership
        JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
        WHERE ownership.request_id = ${candidate.id}
          AND ownership.state = 'active'
          AND campaign.status IN ('active', 'attention')
        ORDER BY campaign.id
        FOR SHARE OF campaign
      `);
    }
    const [claimed] = await tx
      .update(simUransRequests)
      .set({ state: "running", simJobId: null })
      .where(
        and(
          eq(simUransRequests.id, candidate.id),
          eq(simUransRequests.state, "pending"),
          sql`(
            ${simUransRequests.fidelity} = 'full'
            OR NOT EXISTS (
              SELECT 1 FROM sim_ladder_submit_retries submit_retry
              WHERE submit_retry.urans_request_id = ${simUransRequests.id}
                AND (
                  submit_retry.state = 'blocked'
                  OR submit_retry.next_attempt_at > now()
                )
            )
          )`,
          sql`(
            ${simUransRequests.backgroundOwner}
            OR EXISTS (
              SELECT 1
              FROM sim_urans_request_campaigns ownership
              JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
              WHERE ownership.request_id = ${simUransRequests.id}
                AND ownership.state = 'active'
                AND campaign.status IN ('active', 'attention')
            )
          )`,
        ),
      )
      .returning();
    return claimed ?? null;
  });
}

const REQUEST_CLAIM_RELEASE_STATE_SQL = sql`CASE
  WHEN req.background_owner THEN 'pending'
  WHEN EXISTS (
    SELECT 1
    FROM sim_urans_request_campaigns ownership
    JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
    WHERE ownership.request_id = req.id
      AND ownership.state = 'active'
      AND campaign.status IN ('active', 'attention', 'paused')
  ) THEN 'pending'
  ELSE 'cancelled'
END`;

export async function releaseClaimedUransRequest(
  db: DB,
  requestId: string,
): Promise<void> {
  await db.execute(sql`
    UPDATE sim_urans_requests req
    SET state = ${REQUEST_CLAIM_RELEASE_STATE_SQL}, sim_job_id = NULL,
        "updatedAt" = now()
    WHERE req.id = ${requestId} AND req.state = 'running'
  `);
}

/** Heal verify items stuck 'running' whose composing/solving job died without
 * settling them (job cancelled/lost/failed before ingest). Live/paused/public
 * work returns to pending; terminal campaign work becomes cancelled. A live
 * job referencing the item keeps it running. */
export async function healOrphanedVerifyItems(
  db: DB,
  scope: PendingVerifyScope = {},
): Promise<number> {
  const scopeSql =
    scope.campaignIds === undefined
      ? sql``
      : scope.campaignIds.length
        ? sql`AND ${verifyQueueCampaignScopeSql(sql`q.id`, scope.campaignIds)}`
        : sql`AND false`;
  const verifyScopeSql =
    scope.verifyIds === undefined
      ? sql``
      : scope.verifyIds.length
        ? sql`AND q.id = ANY(${sql`ARRAY[${sql.join(
            scope.verifyIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;
  return db.transaction(async (tx) => {
    // Pending physical work with neither a background owner nor a currently
    // live/frozen campaign owner is terminal, not a hidden queue entry. Lock
    // the source result as well as the queue row: every production association
    // creator holds that same result lock until its owner row is inserted, so
    // SKIP LOCKED defers rather than racing campaign launch/plan growth.
    const pendingCandidates = (await tx.execute(sql`
      SELECT q.id
      FROM sim_urans_verify_queue q
      JOIN results source_result ON source_result.id = q.precalc_result_id
      WHERE q.state = 'pending'
        ${scopeSql}
        ${verifyScopeSql}
        AND NOT ${verifyQueueLiveOwnerSql(sql`q.id`, true)}
      ORDER BY q."createdAt", q.id
      LIMIT 100
      FOR UPDATE OF q, source_result SKIP LOCKED
    `)) as unknown as Array<{ id: string }>;
    let pendingCancelled = 0;
    if (pendingCandidates.length) {
      const cancelled = (await tx.execute(sql`
        UPDATE sim_urans_verify_queue q
        SET state = 'cancelled', sim_job_id = NULL, "updatedAt" = now()
        WHERE q.id = ANY(${sql`ARRAY[${sql.join(
          pendingCandidates.map((row) => sql`${row.id}::uuid`),
          sql`, `,
        )}]`})
          AND q.state = 'pending'
          AND NOT ${verifyQueueLiveOwnerSql(sql`q.id`, true)}
        RETURNING q.id
      `)) as unknown as Array<{ id: string }>;
      pendingCancelled = cancelled.length;
    }

    // A five-minute-old pending job is beyond the engine client's bounded
    // 60-second submit timeout. Cancel it conditionally; a concurrent
    // pending→submitted winner makes PostgreSQL recheck and preserves it.
    await tx.execute(sql`
      UPDATE sim_jobs j
      SET status = 'cancelled', engine_state = 'cancelled',
          error = 'orphaned verify composition recovered before engine submission',
          "finishedAt" = now(), "updatedAt" = now()
      FROM sim_urans_verify_queue q
      WHERE q.state = 'running'
        ${scopeSql}
        ${verifyScopeSql}
        AND q."updatedAt" < now() - interval '5 minutes'
        AND j.status = 'pending'
        AND j."updatedAt" < now() - interval '5 minutes'
        AND q.sim_job_id = j.id
        AND j.request_payload ->> 'verifyQueueItemId' = q.id::text
    `);
    const rows = (await tx.execute(sql`
      UPDATE sim_urans_verify_queue q
      SET state = ${VERIFY_CLAIM_RELEASE_STATE_SQL}, sim_job_id = NULL,
          "updatedAt" = now()
      WHERE q.state = 'running'
        ${scopeSql}
        ${verifyScopeSql}
        AND NOT EXISTS (
          SELECT 1 FROM sim_jobs j
          WHERE j.status IN ('pending', 'submitted', 'running', 'ingesting')
            AND j.id = q.sim_job_id
        )
        AND q."updatedAt" < now() - interval '5 minutes'
      RETURNING q.id
    `)) as unknown as { id: string }[];
    return pendingCancelled + rows.length;
  });
}

/** Heal admin requests stuck 'running' after their job vanished (cancelled /
 *  lost / deleted): back to pending for a re-attempt. */
export async function healOrphanedUransRequests(
  db: DB,
  scope: PendingUransRequestScope = {},
): Promise<number> {
  const requestScope =
    scope.requestIds === undefined
      ? sql``
      : scope.requestIds.length
        ? sql`AND req.id = ANY(${sql`ARRAY[${sql.join(
            scope.requestIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})`
        : sql`AND false`;
  return db.transaction(async (tx) => {
    const ownerlessRows = (await tx.execute(sql`
      UPDATE sim_urans_requests req
      SET state = 'cancelled', sim_job_id = NULL, "updatedAt" = now()
      WHERE req.state IN ('pending', 'running')
        ${requestScope}
        AND req.background_owner = false
        AND NOT EXISTS (
          SELECT 1
          FROM sim_urans_request_campaigns ownership
          JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
          WHERE ownership.request_id = req.id
            AND ownership.state = 'active'
            AND campaign.status IN ('active', 'attention', 'paused')
        )
        AND (
          req.state = 'pending'
          OR NOT EXISTS (
            SELECT 1 FROM sim_jobs submitted_job
            WHERE (
                submitted_job.id = req.sim_job_id
                OR submitted_job.request_payload ->> 'uransRequestId' = req.id::text
              )
              AND (
                submitted_job.engine_job_id IS NOT NULL
                OR submitted_job."submittedAt" IS NOT NULL
                OR submitted_job.status IN ('submitted', 'running', 'ingesting', 'done', 'failed')
              )
          )
        )
      RETURNING req.id
    `)) as unknown as Array<{ id: string }>;

    // Terminal jobs must settle their request even if the process died in the
    // narrow gap before consumeUransRequest/ingest bookkeeping ran. A submit
    // rejection has no accepted engine id/evidence and is cancelled; a real
    // terminal engine job (done or failed) completed the requested attempt.
    const terminalRows = (await tx.execute(sql`
      UPDATE sim_urans_requests req
      SET state = CASE
            WHEN j.status = 'failed' AND j.engine_job_id IS NULL
              AND req.fidelity = 'precalc'
              AND EXISTS (
                SELECT 1
                FROM sim_precalc_obligation_requests coverage
                JOIN sim_precalc_obligations obligation
                  ON obligation.id = coverage.obligation_id
                WHERE coverage.request_id = req.id
                  AND obligation.state IN ('pending', 'running')
              ) THEN 'pending'
            WHEN j.status = 'failed' AND j.engine_job_id IS NULL
              AND req.fidelity = 'precalc'
              AND EXISTS (
                SELECT 1 FROM sim_precalc_obligation_requests coverage
                WHERE coverage.request_id = req.id
              ) THEN 'done'
            WHEN j.status = 'failed' AND j.engine_job_id IS NULL THEN 'cancelled'
            ELSE 'done'
          END,
          sim_job_id = CASE
            WHEN j.status = 'failed' AND j.engine_job_id IS NULL
              AND req.fidelity = 'precalc'
              AND EXISTS (
                SELECT 1
                FROM sim_precalc_obligation_requests coverage
                JOIN sim_precalc_obligations obligation
                  ON obligation.id = coverage.obligation_id
                WHERE coverage.request_id = req.id
                  AND obligation.state IN ('pending', 'running')
              ) THEN NULL
            ELSE j.id
          END,
          "updatedAt" = now()
      FROM sim_jobs j
      WHERE req.state = 'running'
        ${requestScope}
        AND req.fidelity = 'precalc'
        AND (
          j.id = req.sim_job_id
          OR j.request_payload ->> 'uransRequestId' = req.id::text
        )
        AND j.status IN ('done', 'failed')
      RETURNING req.id
    `)) as unknown as { id: string }[];

    await tx.execute(sql`
      UPDATE sim_jobs j
      SET status = 'cancelled', engine_state = 'cancelled',
          error = 'orphaned URANS request composition recovered before engine submission',
          "finishedAt" = now(), "updatedAt" = now()
      FROM sim_urans_requests req
      WHERE req.state = 'running'
        ${requestScope}
        AND req."updatedAt" < now() - interval '5 minutes'
        AND j.status = 'pending'
        AND j."updatedAt" < now() - interval '5 minutes'
        AND (
          j.id = req.sim_job_id
          OR j.request_payload ->> 'uransRequestId' = req.id::text
        )
    `);
    const rows = (await tx.execute(sql`
      UPDATE sim_urans_requests req
      SET state = ${REQUEST_CLAIM_RELEASE_STATE_SQL}, sim_job_id = NULL,
          "updatedAt" = now()
      WHERE req.state = 'running'
        ${requestScope}
        AND NOT EXISTS (
          SELECT 1 FROM sim_jobs j
          WHERE (
              j.id = req.sim_job_id
              OR j.request_payload ->> 'uransRequestId' = req.id::text
            )
            AND j.status IN ('pending', 'submitted', 'running', 'ingesting', 'done', 'failed')
        )
        AND req."updatedAt" < now() - interval '5 minutes'
      RETURNING req.id
    `)) as unknown as { id: string }[];
    const fullRows = (await tx.execute(sql`
      SELECT req.id
      FROM sim_urans_requests req
      WHERE req.fidelity = 'full'
        AND req.state <> 'cancelled'
        ${requestScope}
      ORDER BY req.id
    `)) as unknown as Array<{ id: string }>;
    for (const request of fullRows) {
      await refreshFullUransRequestStateInTransaction(
        tx as unknown as DB,
        request.id,
      );
    }
    return (
      ownerlessRows.length + terminalRows.length + rows.length + fullRows.length
    );
  });
}

/** Idempotent admin request-URANS creation (contract 6): one open item per
 *  (cell, fidelity); NULL aoaDeg = whole polar. Admin creation supplies an
 *  independent owner even when it reuses a campaign-created physical row;
 *  requestedBy remains the immutable creator of that row. Returns the open/created row
 *  and whether this call created it. Continuation items (amendment C) carry
 *  continueFromResultId + budgetOverrideS and share the same idempotency: a
 *  cell with an already-open item of this fidelity returns THAT item — the
 *  admin surface shows the open item instead of stacking a duplicate. */
export class UransRequestCoverageConflict extends Error {
  readonly code = "whole_polar_overlaps_open_exact" as const;
  constructor(readonly conflictingRequestIds: string[]) {
    super(
      "a whole-polar URANS request overlaps one or more open exact-angle requests",
    );
    this.name = "UransRequestCoverageConflict";
  }
}

export class PrecalcObligationTerminalConflict extends Error {
  readonly code = "precalc_obligation_terminal" as const;
  constructor(
    readonly obligations: Array<{
      id: string;
      aoaDeg: number;
      state: "blocked" | "satisfied";
    }>,
  ) {
    super(
      "preliminary work for this immutable setup is already terminal; request a new setup revision or full-fidelity verification",
    );
    this.name = "PrecalcObligationTerminalConflict";
  }
}

export async function createUransRequest(
  db: DB,
  input: {
    airfoilId: string;
    revisionId: string;
    aoaDeg?: number | null;
    fidelity: "precalc" | "full";
    requestedBy?: string | null;
    continueFromResultId?: string | null;
    budgetOverrideS?: number | null;
  },
): Promise<{ request: SimUransRequest; created: boolean }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`urans-request:${input.airfoilId}:${input.revisionId}:${input.fidelity}`}, 0)
      )
    `);
    if (input.fidelity === "precalc") {
      const terminal = await tx
        .select({
          id: simPrecalcObligations.id,
          aoaDeg: simPrecalcObligations.aoaDeg,
          state: simPrecalcObligations.state,
        })
        .from(simPrecalcObligations)
        .where(
          and(
            eq(simPrecalcObligations.airfoilId, input.airfoilId),
            eq(simPrecalcObligations.revisionId, input.revisionId),
            ...(input.aoaDeg == null
              ? []
              : [eq(simPrecalcObligations.aoaDeg, input.aoaDeg)]),
            inArray(simPrecalcObligations.state, ["blocked", "satisfied"]),
          ),
        )
        .orderBy(asc(simPrecalcObligations.aoaDeg))
        .for("update");
      if (terminal.length) {
        throw new PrecalcObligationTerminalConflict(
          terminal.map((obligation) => ({
            id: obligation.id,
            aoaDeg: obligation.aoaDeg,
            state: obligation.state as "blocked" | "satisfied",
          })),
        );
      }
    }
    let readyToInsert = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // The row lock serializes promotion with campaign cancellation. If
      // cancellation committed first, EvalPlanQual removes the now-terminal
      // row and this call inserts a fresh independent request instead.
      const open = await tx
        .select()
        .from(simUransRequests)
        .where(
          and(
            eq(simUransRequests.airfoilId, input.airfoilId),
            eq(simUransRequests.revisionId, input.revisionId),
            eq(simUransRequests.fidelity, input.fidelity),
            inArray(simUransRequests.state, ["pending", "running"]),
          ),
        )
        .orderBy(asc(simUransRequests.createdAt))
        .for("update");
      let covering: SimUransRequest | undefined;
      if (input.aoaDeg == null) {
        covering = open.find((request) => request.aoaDeg == null);
        if (!covering && open.length) {
          throw new UransRequestCoverageConflict(
            open.map((request) => request.id),
          );
        }
      } else {
        // A whole-polar request covers every exact angle. Reuse it rather than
        // stacking redundant work; otherwise only the same exact angle reuses.
        covering =
          open.find((request) => request.aoaDeg == null) ??
          open.find((request) => request.aoaDeg === input.aoaDeg);
      }
      if (!covering) {
        readyToInsert = true;
        break;
      }
      // A continuation endpoint rejects a covering request that resumes a
      // different source (or is fresh). Do not grant independent ownership
      // for a reuse the caller will reject as incompatible.
      if (
        input.continueFromResultId != null &&
        covering.continueFromResultId !== input.continueFromResultId
      ) {
        return { request: covering, created: false };
      }
      const [promoted] = await tx
        .update(simUransRequests)
        .set({ backgroundOwner: true })
        .where(
          and(
            eq(simUransRequests.id, covering.id),
            inArray(simUransRequests.state, ["pending", "running"]),
          ),
        )
        .returning();
      if (promoted) return { request: promoted, created: false };
      // Defensive retry: the state fence should be guaranteed by the row
      // lock, but never return a terminal row as a successful admin reuse.
    }
    if (!readyToInsert) {
      throw new Error(
        "URANS request ownership promotion lost its open-row fence",
      );
    }
    const [request] = await tx
      .insert(simUransRequests)
      .values({
        airfoilId: input.airfoilId,
        revisionId: input.revisionId,
        aoaDeg: input.aoaDeg ?? null,
        fidelity: input.fidelity,
        state: "pending",
        backgroundOwner: true,
        requestedBy: input.requestedBy ?? null,
        continueFromResultId: input.continueFromResultId ?? null,
        budgetOverrideS: input.budgetOverrideS ?? null,
      })
      .returning();
    return { request, created: true };
  });
}

/** The exact immutable preliminary generation a verify job compares against.
 * The mutable results row may already select a newer preliminary or a full
 * generation, so it is only an ownership cross-check, never the source. */
export interface VerifyPrecalcSnapshot {
  resultAttemptId: string;
  cl: number | null;
  cd: number | null;
  cm: number | null;
}

export async function precalcSnapshotForVerifyItem(
  db: DB,
  item: SimUransVerifyQueueItem,
): Promise<VerifyPrecalcSnapshot | null> {
  if (!item.precalcResultAttemptId) return null;
  const [row] = await db
    .select({
      resultAttemptId: resultAttempts.id,
      resultId: resultAttempts.resultId,
      airfoilId: resultAttempts.airfoilId,
      revisionId: resultAttempts.simulationPresetRevisionId,
      aoaDeg: resultAttempts.aoaDeg,
      cl: resultAttempts.cl,
      cd: resultAttempts.cd,
      cm: resultAttempts.cm,
      status: resultAttempts.status,
      source: resultAttempts.source,
      fidelity: sql<
        string | null
      >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
      classification: resultClassifications.state,
    })
    .from(resultAttempts)
    .leftJoin(
      resultClassifications,
      eq(resultClassifications.resultAttemptId, resultAttempts.id),
    )
    .where(eq(resultAttempts.id, item.precalcResultAttemptId))
    .limit(1);
  if (
    !row ||
    row.resultId !== item.precalcResultId ||
    row.airfoilId !== item.airfoilId ||
    row.revisionId !== item.revisionId ||
    Number(row.aoaDeg) !== Number(item.aoaDeg) ||
    row.status !== "done" ||
    row.source !== "solved" ||
    row.fidelity !== "urans_precalc" ||
    row.classification !== "accepted"
  )
    return null;
  return {
    resultAttemptId: row.resultAttemptId,
    cl: row.cl,
    cd: row.cd,
    cm: row.cm,
  };
}

export type FinalUransRecoveryPlan =
  | { mode: "fresh" }
  | {
      mode: "continuation";
      resultAttemptId: string;
      engineJobId: string;
      engineCaseSlug: string;
      solverImplementationId: string | null;
      budgetOverrideS: number;
    }
  | { mode: "media_repair" }
  | { mode: "exhausted"; reason: string };

/** A final verification can become terminal before a new sim_job exists:
 * either its durable retry ledger is already exhausted, or the only saved
 * continuation checkpoint is incompatible with the target implementation.
 * Fence the running claim and write the matching critical incident in the
 * same transaction so scheduler replays cannot create alert-only ghosts. */
export async function blockFinalUransVerificationBeforeSubmit(
  db: DB,
  input: {
    verifyQueueId: string;
    reason: string;
    incidentReason: string;
    targetSolverImplementationId: string;
    metadata?: Record<string, unknown>;
  },
): Promise<boolean> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const rows = (await tx.execute(sql`
      UPDATE sim_urans_verify_queue q
      SET state = 'blocked',
          sim_job_id = NULL,
          last_outcome = ${FINAL_URANS_OUTCOMES.recoveryExhausted},
          last_error = ${input.reason},
          next_submit_at = NULL,
          "updatedAt" = now()
      WHERE q.id = ${input.verifyQueueId}
        AND q.state = 'running'
        AND q.sim_job_id IS NULL
      RETURNING
        q.id,
        q.latest_result_attempt_id,
        q.fresh_attempt_count,
        q.max_fresh_attempts,
        q.continuation_attempt_count,
        q.continuation_no_progress_count
    `)) as unknown as Array<{
      id: string;
      latest_result_attempt_id: string | null;
      fresh_attempt_count: number;
      max_fresh_attempts: number;
      continuation_attempt_count: number;
      continuation_no_progress_count: number;
    }>;
    const row = rows[0];
    if (!row) return false;

    const [attempt] = row.latest_result_attempt_id
      ? await tx
          .select({
            id: resultAttempts.id,
            simJobId: resultAttempts.simJobId,
            solverImplementationId: resultAttempts.solverImplementationId,
            classificationReasons: resultClassifications.reasons,
          })
          .from(resultAttempts)
          .leftJoin(
            resultClassifications,
            eq(resultClassifications.resultAttemptId, resultAttempts.id),
          )
          .where(eq(resultAttempts.id, row.latest_result_attempt_id))
          .limit(1)
      : [];
    const solverImplementationId =
      attempt?.solverImplementationId ?? input.targetSolverImplementationId;
    await recordSolverIncidentInTransaction(tx, {
      stage: "final",
      reason: input.incidentReason,
      severity: "critical",
      owner: { verifyQueueId: row.id },
      solverImplementationId,
      occurrenceKey: `final:${row.id}:${attempt?.id ?? row.id}:${FINAL_URANS_OUTCOMES.recoveryExhausted}`,
      remediationVersion: URANS_RECOVERY_REMEDIATION_VERSION,
      simJobId: attempt?.simJobId ?? null,
      resultAttemptId: attempt?.id ?? null,
      metadata: {
        lastOutcome: FINAL_URANS_OUTCOMES.recoveryExhausted,
        schedulerReason: input.reason,
        classificationReasons: attempt?.classificationReasons ?? [],
        freshAttemptCount: row.fresh_attempt_count,
        maxFreshAttempts: row.max_fresh_attempts,
        continuationAttemptCount: row.continuation_attempt_count,
        continuationNoProgressCount: row.continuation_no_progress_count,
        targetSolverImplementationId: input.targetSolverImplementationId,
        ...input.metadata,
      },
    });
    await refreshFullUransRequestsForVerifyQueueInTransaction(tx, row.id);
    return true;
  });
}

/** Resolve the next full-fidelity action from the durable queue ledger.
 *
 * The latest immutable attempt is authoritative even when the accepted
 * preliminary result remains the selected canonical generation. Restartable
 * evidence always continues from the latest exact attempt while its physical
 * measurements advance; settlement owns the repeated-no-progress breaker. */
export async function finalUransRecoveryPlanForVerifyItem(
  db: DB,
  item: SimUransVerifyQueueItem,
): Promise<FinalUransRecoveryPlan> {
  if (item.lastOutcome === FINAL_URANS_OUTCOMES.mediaRepairPending) {
    return { mode: "media_repair" };
  }
  const continuationRequested =
    item.lastOutcome === FINAL_URANS_OUTCOMES.continuationPending ||
    item.lastOutcome === FINAL_URANS_OUTCOMES.continuationRetryWait;
  if (continuationRequested && item.latestResultAttemptId) {
    const [source] = await db
      .select({
        id: resultAttempts.id,
        airfoilId: resultAttempts.airfoilId,
        revisionId: resultAttempts.simulationPresetRevisionId,
        aoaDeg: resultAttempts.aoaDeg,
        engineJobId: resultAttempts.engineJobId,
        engineCaseSlug: resultAttempts.engineCaseSlug,
        solverImplementationId: resultAttempts.solverImplementationId,
        fidelity: sql<
          string | null
        >`${resultAttempts.evidencePayload} ->> 'fidelity'`,
      })
      .from(resultAttempts)
      .where(eq(resultAttempts.id, item.latestResultAttemptId))
      .limit(1);
    if (
      source &&
      source.airfoilId === item.airfoilId &&
      source.revisionId === item.revisionId &&
      Number(source.aoaDeg) === Number(item.aoaDeg) &&
      source.fidelity === "urans_full" &&
      source.engineJobId &&
      source.engineCaseSlug
    ) {
      return {
        mode: "continuation",
        resultAttemptId: source.id,
        engineJobId: source.engineJobId,
        engineCaseSlug: source.engineCaseSlug,
        solverImplementationId: source.solverImplementationId,
        budgetOverrideS:
          item.continuationBudgetOverrideS ?? FINAL_URANS_CONTINUATION_BUDGET_S,
      };
    }
  }
  if (item.freshAttemptCount < item.maxFreshAttempts) {
    return { mode: "fresh" };
  }
  return {
    mode: "exhausted",
    reason:
      "full URANS automatic recovery exhausted its fresh-start allowance after repeated non-progressing continuation",
  };
}

/** Media repair can make the exact rejected full attempt publishable without
 * another CFD solve. Complete the waiting verification from that repaired
 * immutable attempt; this is idempotent and exact-attempt fenced. */
export async function settleFinalUransVerificationAfterMediaRepair(
  db: DB,
  resultAttemptId: string,
): Promise<number> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    const [attempt] = await tx
      .select({
        id: resultAttempts.id,
        resultId: resultAttempts.resultId,
        simJobId: resultAttempts.simJobId,
        cl: resultAttempts.cl,
        cd: resultAttempts.cd,
        cm: resultAttempts.cm,
        classification: resultClassifications.state,
      })
      .from(resultAttempts)
      .leftJoin(
        resultClassifications,
        eq(resultClassifications.resultAttemptId, resultAttempts.id),
      )
      .where(eq(resultAttempts.id, resultAttemptId))
      .limit(1);
    if (!attempt?.resultId || attempt.classification !== "accepted") {
      return 0;
    }
    const rows = (await tx.execute(sql`
      UPDATE sim_urans_verify_queue q
      SET state = CASE
            WHEN (
              ${attempt.cl}::double precision IS NOT NULL
              AND preliminary.cl IS NOT NULL
              AND abs(${attempt.cl}::double precision - preliminary.cl) > 0.05
            ) OR (
              ${attempt.cd}::double precision IS NOT NULL
              AND preliminary.cd IS NOT NULL
              AND abs(${attempt.cd}::double precision - preliminary.cd) > 0.01
            ) THEN 'disagreed'
            ELSE 'done'
          END,
          verify_result_id = ${attempt.resultId},
          delta_cl = CASE
            WHEN ${attempt.cl}::double precision IS NOT NULL
             AND preliminary.cl IS NOT NULL
            THEN ${attempt.cl}::double precision - preliminary.cl
            ELSE NULL
          END,
          delta_cd = CASE
            WHEN ${attempt.cd}::double precision IS NOT NULL
             AND preliminary.cd IS NOT NULL
            THEN ${attempt.cd}::double precision - preliminary.cd
            ELSE NULL
          END,
          delta_cm = CASE
            WHEN ${attempt.cm}::double precision IS NOT NULL
             AND preliminary.cm IS NOT NULL
            THEN ${attempt.cm}::double precision - preliminary.cm
            ELSE NULL
          END,
          last_outcome = CASE
            WHEN (
              ${attempt.cl}::double precision IS NOT NULL
              AND preliminary.cl IS NOT NULL
              AND abs(${attempt.cl}::double precision - preliminary.cl) > 0.05
            ) OR (
              ${attempt.cd}::double precision IS NOT NULL
              AND preliminary.cd IS NOT NULL
              AND abs(${attempt.cd}::double precision - preliminary.cd) > 0.01
            ) THEN ${FINAL_URANS_OUTCOMES.disagreed}
            ELSE ${FINAL_URANS_OUTCOMES.accepted}
          END,
          last_error = NULL,
          continuation_no_progress_count = 0,
          next_submit_at = NULL,
          "updatedAt" = now()
      FROM result_attempts preliminary
      JOIN result_classifications preliminary_classification
        ON preliminary_classification.result_attempt_id = preliminary.id
       -- Publishing the exact accepted FULL attempt refreshes classifications
       -- before this settlement runs. That refresh truthfully changes the
       -- queue-owned PRECALC generation from accepted to superseded_by_urans.
       -- Both states prove the same immutable preliminary owner; every other
       -- state remains fail-closed under the exact attempt/queue fences below.
       AND preliminary_classification.state
         IN ('accepted', 'superseded_by_urans')
      WHERE q.latest_result_attempt_id = ${attempt.id}
        AND q.precalc_result_attempt_id = preliminary.id
        AND q.precalc_result_id = preliminary.result_id
        AND preliminary.airfoil_id = q.airfoil_id
        AND preliminary.simulation_preset_revision_id = q.revision_id
        AND preliminary.aoa_deg = q.aoa_deg
        AND preliminary.status = 'done'
        AND preliminary.source = 'solved'
        AND preliminary.evidence_payload ->> 'fidelity' = 'urans_precalc'
        AND (
          (
            q.state = 'pending'
            AND q.last_outcome = ${FINAL_URANS_OUTCOMES.mediaRepairPending}
          )
          OR (
            q.state = 'blocked'
            AND q.last_outcome = ${FINAL_URANS_OUTCOMES.recoveryExhausted}
            AND EXISTS (
              SELECT 1
              FROM sim_solver_incidents incident
              WHERE incident.verify_queue_id = q.id
                AND incident.result_attempt_id = ${attempt.id}
                AND incident.occurrence_key =
                  concat_ws(
                    ':',
                    'final',
                    q.id::text,
                    ${attempt.id}::uuid::text,
                    ${FINAL_URANS_OUTCOMES.recoveryExhausted}::text
                  )
            )
          )
        )
      RETURNING q.id
    `)) as unknown as Array<{ id: string }>;
    for (const row of rows) {
      await resolveSolverIncidentsForOwnerInTransaction(tx, {
        verifyQueueId: row.id,
      });
      await refreshFullUransRequestsForVerifyQueueInTransaction(tx, row.id);
    }
    return rows.length;
  });
}
