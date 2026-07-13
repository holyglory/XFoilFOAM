// URANS fidelity ladder — shared node-side helpers (pinned contracts 4–7,
// migration 0034). The sweeper consumes these in its ladder tick; the API
// reads the tier counts for the campaign summary payload.
//
// Ladder (contract 5, ONE priority scale — no second scale):
//   1. RANS work (continuous + campaign gaps)         — existing submit branch
//   2. precalc-rank work                              — gated wave-2 URANS
//      (per campaign: only once that campaign has ZERO open RANS gaps) and
//      admin request-URANS items (contract 6)
//   3. verify-queue items (contract 4)                — ONLY when no campaign
//      RANS/precalc work exists machine-wide

import {
  AUTO_PRECALC_CONTINUATION_BUDGET_S,
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
  MISSING_URANS_VIDEO_REASON,
  URANS_BUDGET_STOP_MARKER,
  URANS_CONTINUATION_REQUIRED_MARKER,
} from "@aerodb/core";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";

import type { DB } from "./client";
import {
  results,
  simCampaigns,
  simPrecalcObligations,
  simUransRequests,
  simUransVerifyQueue,
  type SimUransRequest,
  type SimUransVerifyQueueItem,
} from "./schema";

// ---------------------------------------------------------------------------
// Verify-queue enqueue (contract 4): a results row that classifies ACCEPTED at
// fidelity 'urans_precalc' owes a full-fidelity verification. Fidelity, not
// regime, owns this obligation: a no-shedding URANS attempt is represented as
// steady-equivalent regime='rans' but is still preliminary URANS evidence.
// Idempotent via the partial unique index (one open item per cell).
// ---------------------------------------------------------------------------
export {
  AUTO_PRECALC_CONTINUATION_BUDGET_S,
  AUTO_PRECALC_CONTINUATION_REQUESTED_BY,
};

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

export async function enqueuePrecalcVerifications(
  db: DB,
  opts: {
    airfoilId: string;
    revisionId: string;
    campaignId?: string | null;
    aoaDeg?: number | null;
  },
): Promise<number> {
  await enqueueAutomaticPrecalcContinuations(db, opts);
  return db.transaction(async (tx) => {
    const campaignJoin = opts.campaignId
      ? sql`JOIN sim_campaign_points selected_point
              ON selected_point.campaign_id = ${opts.campaignId}
             AND selected_point.result_id = r.id
             AND selected_point.state = 'terminal'
             AND selected_point.derived_by_symmetry = false
            JOIN sim_campaigns selected_campaign
              ON selected_campaign.id = selected_point.campaign_id
             AND selected_campaign.status IN ('active', 'attention', 'paused')`
      : sql``;
    const candidates = (await tx.execute(sql`
      SELECT r.id, r.airfoil_id, r.simulation_preset_revision_id,
             r.aoa_deg::float8 AS aoa_deg
      FROM results r
      JOIN result_classifications rc ON rc.result_id = r.id
      ${campaignJoin}
      WHERE r.airfoil_id = ${opts.airfoilId}
        AND r.simulation_preset_revision_id = ${opts.revisionId}
        AND r.status = 'done'
        ${opts.aoaDeg == null ? sql`` : sql`AND r.aoa_deg = ${opts.aoaDeg}`}
        AND r.fidelity = 'urans_precalc'
        AND rc.state = 'accepted'
        AND NOT EXISTS (
          -- Idempotent replay of this same accepted evidence must not mint a
          -- fresh automatic retry budget after its full solve was blocked. A
          -- genuinely new evidence row has a different precalc_result_id.
          SELECT 1 FROM sim_urans_verify_queue prior_verify
          WHERE prior_verify.precalc_result_id = r.id
            AND prior_verify.state = 'blocked'
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
      const [inserted] = (await tx.execute(sql`
        INSERT INTO sim_urans_verify_queue (
          airfoil_id, revision_id, aoa_deg, background_owner, state,
          precalc_result_id
        ) VALUES (
          ${candidate.airfoil_id}, ${candidate.simulation_preset_revision_id},
          ${candidate.aoa_deg}, ${!opts.campaignId}, 'pending', ${candidate.id}
        )
        ON CONFLICT (airfoil_id, revision_id, aoa_deg)
          WHERE state IN ('pending', 'running') DO NOTHING
        RETURNING id
      `)) as unknown as Array<{ id: string }>;
      if (inserted?.id) created += 1;
      const [physical] = inserted?.id
        ? [inserted]
        : ((await tx.execute(sql`
            SELECT id FROM sim_urans_verify_queue
            WHERE airfoil_id = ${candidate.airfoil_id}
              AND revision_id = ${candidate.simulation_preset_revision_id}
              AND aoa_deg = ${candidate.aoa_deg}
              AND state IN ('pending', 'running')
            ORDER BY "createdAt" ASC LIMIT 1
          `)) as unknown as Array<{ id: string }>);
      if (!physical?.id) continue;
      if (!opts.campaignId) {
        await tx.execute(sql`
          UPDATE sim_urans_verify_queue
          SET background_owner = true, "updatedAt" = now()
          WHERE id = ${physical.id}
        `);
      }
      await tx.execute(sql`
        INSERT INTO sim_urans_verify_queue_campaigns (queue_id, campaign_id, state)
        SELECT DISTINCT ${physical.id}::uuid, campaign.id, 'active'
        FROM sim_campaign_points point
        JOIN sim_campaigns campaign ON campaign.id = point.campaign_id
        WHERE point.result_id = ${candidate.id}
          AND point.derived_by_symmetry = false
          AND campaign.status IN ('active', 'attention', 'paused')
        ON CONFLICT (queue_id, campaign_id) DO UPDATE
          SET state = 'active', cancelled_at = NULL, "updatedAt" = now()
      `);
    }
    return created;
  });
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

/** Machine-wide verify gate: verify-queue items schedule ONLY when no campaign
 *  RANS/precalc work exists anywhere — no open campaign gap, no pending
 *  admin request-URANS item, and no in-flight non-verify campaign job. */
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
  const requestFidelityScope = includePrecalc
    ? sql``
    : sql`AND req.fidelity = 'full'`;
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
        SELECT count(*) FROM sim_urans_verify_queue_campaigns ownership
        JOIN sim_urans_verify_queue q ON q.id = ownership.queue_id
        WHERE ownership.campaign_id = ${campaignId}
          AND ownership.state = 'active'
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
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE p.campaign_id = ${campaignId} ${airfoilFilter}
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
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE p.campaign_id = ${campaignId}
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
    LEFT JOIN results r ON r.id = p.result_id
    LEFT JOIN result_classifications rc ON rc.result_id = p.result_id
    WHERE p.campaign_id = ANY(${sql`ARRAY[${sql.join(
      campaignIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    )}]`})
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
export interface PendingVerifyScope {
  /** Test-harness isolation for the shared dev DB. Production omits this and
   *  considers the global queue. */
  campaignIds?: string[];
  /** Test-only physical-item scope for background-owned rows, which have no
   * campaign association to isolate parallel files. Production omits this. */
  verifyIds?: string[];
}

export async function nextPendingVerifyItem(
  db: DB,
  scope: PendingVerifyScope = {},
): Promise<SimUransVerifyQueueItem | null> {
  const scopeSql =
    scope.campaignIds === undefined
      ? sql``
      : scope.campaignIds.length
        ? sql`AND EXISTS (
        SELECT 1 FROM sim_urans_verify_queue_campaigns scoped_owner
        WHERE scoped_owner.queue_id = q.id
          AND scoped_owner.state = 'active'
          AND scoped_owner.campaign_id = ANY(${sql`ARRAY[${sql.join(
            scope.campaignIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})
      )`
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
  const [candidate] = (await db.execute(sql`
    SELECT q.id
    FROM sim_urans_verify_queue q
    WHERE q.state = 'pending'
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
      AND (
        q.background_owner
        OR EXISTS (
          SELECT 1
          FROM sim_urans_verify_queue_campaigns ownership
          JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
          WHERE ownership.queue_id = q.id
            AND ownership.state = 'active'
            AND campaign.status IN ('active', 'attention')
        )
      )
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
          ? sql`AND EXISTS (
          SELECT 1 FROM sim_urans_verify_queue_campaigns scoped_owner
          WHERE scoped_owner.queue_id = q.id
            AND scoped_owner.state = 'active'
            AND scoped_owner.campaign_id = ANY(${sql`ARRAY[${sql.join(
              scope.campaignIds.map((id) => sql`${id}::uuid`),
              sql`, `,
            )}]`})
        )`
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
    const [candidate] = (await tx.execute(sql`
      SELECT q.id
      FROM sim_urans_verify_queue q
      WHERE q.state = 'pending'
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
        AND (
          q.background_owner
          OR EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_campaigns ownership
            JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
            WHERE ownership.queue_id = q.id
              AND ownership.state = 'active'
              AND campaign.status IN ('active', 'attention')
          )
        )
      ORDER BY q."createdAt" ASC
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;
    if (!candidate) return null;
    // Match campaign lifecycle's campaign-row lock order. Background-owned
    // work needs no campaign lock; shared work locks every currently-live
    // owner before the conditional state transition.
    await tx.execute(sql`
      SELECT campaign.id
      FROM sim_urans_verify_queue_campaigns ownership
      JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
      WHERE ownership.queue_id = ${candidate.id}
        AND ownership.state = 'active'
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
          sql`(
            ${simUransVerifyQueue.backgroundOwner}
            OR EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_campaigns ownership
              JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
              WHERE ownership.queue_id = ${simUransVerifyQueue.id}
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

/** Release a pre-submit verify claim after a transient engine connection
 *  failure. Paused work freezes as pending for resume; terminal campaign work
 *  becomes cancelled instead of being resurrected into a hidden pending row. */
const VERIFY_CLAIM_RELEASE_STATE_SQL = sql`CASE
  WHEN q.background_owner THEN 'pending'
  WHEN EXISTS (
    SELECT 1
    FROM sim_urans_verify_queue_campaigns ownership
    JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
    WHERE ownership.queue_id = q.id
      AND ownership.state = 'active'
      AND campaign.status IN ('active', 'attention', 'paused')
  ) THEN 'pending'
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
      AND NOT EXISTS (
        SELECT 1 FROM sim_ladder_submit_retries submit_retry
        WHERE submit_retry.urans_request_id = req.id
          AND (
            submit_retry.state = 'blocked'
            OR submit_retry.next_attempt_at > now()
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
        AND NOT EXISTS (
          SELECT 1 FROM sim_ladder_submit_retries submit_retry
          WHERE submit_retry.urans_request_id = req.id
            AND (
              submit_retry.state = 'blocked'
              OR submit_retry.next_attempt_at > now()
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
          sql`NOT EXISTS (
            SELECT 1 FROM sim_ladder_submit_retries submit_retry
            WHERE submit_retry.urans_request_id = ${simUransRequests.id}
              AND (
                submit_retry.state = 'blocked'
                OR submit_retry.next_attempt_at > now()
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
        ? sql`AND EXISTS (
        SELECT 1 FROM sim_urans_verify_queue_campaigns scoped_owner
        WHERE scoped_owner.queue_id = q.id
          AND scoped_owner.state = 'active'
          AND scoped_owner.campaign_id = ANY(${sql`ARRAY[${sql.join(
            scope.campaignIds.map((id) => sql`${id}::uuid`),
            sql`, `,
          )}]`})
      )`
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
        AND q.background_owner = false
        AND NOT EXISTS (
          SELECT 1
          FROM sim_urans_verify_queue_campaigns ownership
          JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
          WHERE ownership.queue_id = q.id
            AND ownership.state = 'active'
            AND campaign.status IN ('active', 'attention', 'paused')
        )
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
          AND q.background_owner = false
          AND NOT EXISTS (
            SELECT 1
            FROM sim_urans_verify_queue_campaigns ownership
            JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
            WHERE ownership.queue_id = q.id
              AND ownership.state = 'active'
              AND campaign.status IN ('active', 'attention', 'paused')
          )
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
    return ownerlessRows.length + terminalRows.length + rows.length;
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

/** The precalc coefficients a verify job compares against are captured at
 *  CONSUME time (the results row still holds the precalc solve — the verify
 *  ingest will overwrite the same natural-key row). */
export interface VerifyPrecalcSnapshot {
  cl: number | null;
  cd: number | null;
  cm: number | null;
}

export async function precalcSnapshotForVerifyItem(
  db: DB,
  item: SimUransVerifyQueueItem,
): Promise<VerifyPrecalcSnapshot | null> {
  const [row] = await db
    .select({
      cl: results.cl,
      cd: results.cd,
      cm: results.cm,
      status: results.status,
      fidelity: results.fidelity,
    })
    .from(results)
    .where(eq(results.id, item.precalcResultId))
    .limit(1);
  if (!row || row.status !== "done" || row.fidelity !== "urans_precalc")
    return null;
  return { cl: row.cl, cd: row.cd, cm: row.cm };
}
