// URANS fidelity-ladder tick (pinned contracts 4–6, spec: single existing
// priority scale — no second scale). Runs INSIDE the submit-capacity branch of
// the sweeper tick, and only when the RANS branch (submitOneBatch) submitted
// nothing this tick — so RANS work always outranks precalc-rank work by
// construction, and verify work additionally requires zero campaign
// RANS/precalc work machine-wide. At most ONE submission per tick (the same
// one-winner-per-tick discipline as the RANS branch).
//
// Tier 2 (precalc rank):
//   a) gated campaign wave-2 URANS retries — parents whose inline retry was
//      deferred because their campaign still had open RANS gaps;
//   b) admin request-URANS work items (contract 6).
// Tier 3 (global lowest): verify-queue items (contract 4) — one cell re-solved
//   at FULL fidelity; deltas recorded at ingest (reconcile settle path).

import {
  airfoils,
  activeCampaignOwnersForUransRequest,
  campaignHasOpenRansGaps,
  claimNextPendingUransRequest,
  claimNextPendingVerifyItem,
  type DB,
  hasOpenCampaignLadderWork,
  healOrphanedUransRequests,
  healOrphanedVerifyItems,
  ensurePrecalcObligations,
  precalcContinuationsForObligations,
  precalcRequestStateFromObligations,
  precalcSnapshotForVerifyItem,
  releaseClaimedUransRequest,
  releaseClaimedVerifyItem,
  recordPrecalcObligationSubmission,
  results,
  simCampaigns,
  simJobs,
  simLadderSubmitRetries,
  simulationPresetRevisions,
  simulationPresets,
  simUransRequests,
  simUransVerifyQueue,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { snapshotAoas } from "@aerodb/db/simulation-setup";
import type { EngineClient, UransFidelity } from "@aerodb/engine-client";
import {
  and,
  eq,
  inArray,
  isNotNull,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { buildPolarRequest } from "./build-request";
import { recordEngineUnreachable } from "./engine-backoff";
import { touchHeartbeat } from "./heartbeat";
import { composePhysicalPrecalcJob } from "./precalc-composition";
import { submitUransRetryForJob } from "./reconcile";
import {
  solverQueuePressure,
  submitPendingJobWithLifecycleGuard,
} from "./submit-lifecycle";

/** Parents whose gated retry was already re-attempted this process lifetime —
 *  a parent whose retry plan is empty must not be re-planned every tick
 *  forever. In-memory on purpose (a restart simply rescans; no payload
 *  mutation, no deadlock). Tests reset via resetUransLadderMemory(). */
const settledGatedParents = new Set<string>();

export function resetUransLadderMemory(): void {
  settledGatedParents.clear();
}

const GATED_PARENTS_PER_TICK = 3;
const PROMOTION_RECOVERIES_PER_TICK = 16;

function promotionRecoveryScopeSql(opts: {
  campaignIds?: string[];
  parentJobIds?: string[];
  promotionIds?: string[];
}) {
  // An exact promotion scope is the strongest test/recovery fence. Otherwise
  // reuse the existing parent/campaign closed-world scopes. Production passes
  // none and therefore scans the complete durable promotion ledger.
  if (opts.promotionIds !== undefined) {
    return opts.promotionIds.length
      ? sql`promotion.id = ANY(${sql`ARRAY[${sql.join(
          opts.promotionIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})`
      : sql`false`;
  }
  if (opts.parentJobIds !== undefined) {
    return opts.parentJobIds.length
      ? sql`parent.id = ANY(${sql`ARRAY[${sql.join(
          opts.parentJobIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})`
      : sql`false`;
  }
  if (opts.campaignIds !== undefined) {
    return opts.campaignIds.length
      ? sql`promotion.campaign_id = ANY(${sql`ARRAY[${sql.join(
          opts.campaignIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )}]`})`
      : sql`false`;
  }
  return sql`true`;
}

interface RecordedPromotionPoint {
  promotionId: string;
  parentJobId: string;
  airfoilId: string;
  revisionId: string;
  conditionId: string | null;
  ownerKind: "campaign" | "background" | "sync_promise";
  ownerCampaignId: string | null;
  syncPromiseId: string | null;
  aoaDeg: number;
  obligationId: string;
  state: string;
  attemptCount: number;
  maxAttempts: number;
  nextSubmitAt: Date | string | null;
}

async function recordedPromotionPoints(
  db: DB,
  promotionId: string,
  parentJobId: string,
): Promise<RecordedPromotionPoint[]> {
  const rows = (await db.execute(sql`
    SELECT promotion.id AS promotion_id,
           promotion.parent_job_id,
           promotion.airfoil_id,
           promotion.revision_id,
           promotion.condition_id,
           promotion.owner_kind,
           promotion.campaign_id AS owner_campaign_id,
           promotion.sync_promise_id,
           point.aoa_deg::float8 AS aoa_deg,
           point.obligation_id,
           obligation.state,
           obligation.attempt_count,
           obligation.max_attempts,
           obligation.next_submit_at
    FROM sim_rans_polar_promotions promotion
    JOIN sim_jobs parent ON parent.id = promotion.parent_job_id
    JOIN sim_rans_polar_promotion_points point
      ON point.promotion_id = promotion.id
    JOIN sim_precalc_obligations obligation
      ON obligation.id = point.obligation_id
     AND obligation.airfoil_id = promotion.airfoil_id
     AND obligation.revision_id = promotion.revision_id
     AND obligation.aoa_deg = point.aoa_deg
    WHERE promotion.id = ${promotionId}
      AND promotion.parent_job_id = ${parentJobId}
    ORDER BY point.aoa_deg, point.obligation_id
  `)) as unknown as Array<{
    promotion_id: string;
    parent_job_id: string;
    airfoil_id: string;
    revision_id: string;
    condition_id: string | null;
    owner_kind: "campaign" | "background" | "sync_promise";
    owner_campaign_id: string | null;
    sync_promise_id: string | null;
    aoa_deg: number;
    obligation_id: string;
    state: string;
    attempt_count: number;
    max_attempts: number;
    next_submit_at: Date | string | null;
  }>;
  return rows.map((row) => ({
    promotionId: row.promotion_id,
    parentJobId: row.parent_job_id,
    airfoilId: row.airfoil_id,
    revisionId: row.revision_id,
    conditionId: row.condition_id,
    ownerKind: row.owner_kind,
    ownerCampaignId: row.owner_campaign_id,
    syncPromiseId: row.sync_promise_id,
    aoaDeg: Number(row.aoa_deg),
    obligationId: row.obligation_id,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextSubmitAt: row.next_submit_at,
  }));
}

async function recordedPromotionHasDeterministicMeshBlocker(
  db: DB,
  event: Pick<
    RecordedPromotionPoint,
    "promotionId" | "parentJobId" | "revisionId" | "conditionId"
  >,
): Promise<boolean> {
  const conditionSql = event.conditionId
    ? sql`child.request_payload ->> 'conditionId' = ${event.conditionId}`
    : sql`child.request_payload ->> 'conditionId' IS NULL`;
  const rows = (await db.execute(sql`
    SELECT 1
    WHERE EXISTS (
      SELECT 1
      FROM sim_rans_polar_promotion_points point
      JOIN sim_precalc_obligations obligation
        ON obligation.id = point.obligation_id
      WHERE point.promotion_id = ${event.promotionId}
        AND obligation.last_outcome = 'deterministic_failure'
    ) OR EXISTS (
      SELECT 1
      FROM sim_jobs child
      CROSS JOIN LATERAL (
        SELECT attempt.error
        FROM result_attempts attempt
        WHERE attempt.sim_job_id = child.id
        UNION ALL
        SELECT canonical.error
        FROM results canonical
        WHERE canonical.sim_job_id = child.id
      ) evidence
      WHERE child.parent_job_id = ${event.parentJobId}
        AND child.wave = 2
        AND child.simulation_preset_revision_id = ${event.revisionId}
        AND (${conditionSql})
        AND child.request_payload ->> 'uransFidelity' = 'precalc'
        AND position('mesh degenerate at this fidelity tier' in lower(COALESCE(evidence.error, ''))) > 0
        AND position('max non-orthogonality' in lower(COALESCE(evidence.error, ''))) > 0
    )
    LIMIT 1
  `)) as unknown as unknown[];
  if (!rows.length) return false;
  console.error(
    `[sweeper] recorded whole-polar promotion ${event.promotionId} remains blocked by deterministic shared-mesh evidence; exact obligation coverage is retained and unchanged mesh is not resubmitted`,
  );
  return true;
}

type PromotionRemoteProvenance =
  | { required: false }
  | {
      required: true;
      syncPromiseId: string;
      remoteSolver: true;
      upstreamBaseUrl: string;
    }
  | { required: true; unavailable: true };

/** Resolve execution ownership from the exact physical obligations, never
 * from mutable parent request JSON. A remote recovery must use one still-live
 * promise covering every selected obligation because the guarded submit
 * boundary validates the same complete payload scope. */
async function remoteProvenanceForPromotionObligations(
  db: DB,
  obligationIds: string[],
  event: Pick<RecordedPromotionPoint, "ownerKind" | "syncPromiseId">,
): Promise<PromotionRemoteProvenance> {
  const idArray = sql`ARRAY[${sql.join(
    obligationIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;
  // Owner kind and remote promise id are immutable event provenance. Never
  // infer either from mutable shared-obligation owners: a later campaign or a
  // replacement promise may benefit from the same physical solve, but cannot
  // adopt this event's submit authority.
  if (event.ownerKind !== "sync_promise") return { required: false };
  if (!event.syncPromiseId) return { required: true, unavailable: true };
  const [promise] = (await db.execute(sql`
    SELECT remote_promise.id, remote_promise.source_base_url
    FROM sync_sweep_promises remote_promise
    WHERE remote_promise.id = ${event.syncPromiseId}
      AND remote_promise.status = 'active'
      AND remote_promise."expiresAt" > now()
      AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
      AND remote_promise.source_base_url IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM sim_precalc_obligations obligation
        WHERE obligation.id = ANY(${idArray})
          AND NOT EXISTS (
            SELECT 1
            FROM sync_sweep_promise_points promise_point
            WHERE promise_point.promise_id = remote_promise.id
              AND promise_point.status = 'active'
              AND promise_point.airfoil_id = obligation.airfoil_id
              AND promise_point.simulation_preset_revision_id = obligation.revision_id
              AND promise_point.aoa_deg = obligation.aoa_deg
          )
      )
    LIMIT 1
  `)) as unknown as Array<{ id: string; source_base_url: string }>;
  if (!promise) return { required: true, unavailable: true };
  return {
    required: true,
    syncPromiseId: promise.id,
    remoteSolver: true,
    upstreamBaseUrl: promise.source_base_url,
  };
}

/** Recover a normalized conditional-promotion event whose transaction
 * committed before its wave-2 child was composed. The immutable event points
 * and their exact physical-obligation ids are the sole scope authority; this
 * path does not re-read mutable parent transport JSON or re-run classification.
 *
 * A still-live ingest lease is deliberately excluded: the ingest owner that
 * recorded the event gets the first chance to compose. A crashed owner becomes
 * eligible after lease expiry, while a terminal parent is immediately safe to
 * recover. A recorded conditional whole-polar promotion bypasses the normal
 * campaign-wide RANS gate: its exact parent, condition, and original angle
 * list are already immutable in the promotion ledger, so unrelated campaign
 * cells must not delay its preliminary replacement. */
async function submitRecordedPromotionRecovery(
  db: DB,
  engine: EngineClient,
  cpuSlots: number,
  opts: {
    campaignIds?: string[];
    parentJobIds?: string[];
    promotionIds?: string[];
  },
): Promise<boolean> {
  const scope = promotionRecoveryScopeSql(opts);
  const candidates = (await db.execute(sql`
    SELECT promotion.id AS promotion_id, parent.id AS parent_job_id
    FROM sim_rans_polar_promotions promotion
    JOIN sim_jobs parent ON parent.id = promotion.parent_job_id
    WHERE (${scope})
      AND (
        parent.status IN ('done', 'failed', 'cancelled')
        OR (
          parent.status = 'ingesting'
          AND (
            parent.ingest_lease_expires_at IS NULL
            OR parent.ingest_lease_expires_at <= now()
          )
        )
      )
      AND NOT (
        parent.status = 'cancelled'
        AND promotion.owner_kind = 'background'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_rans_polar_promotion_points blocked_point
        JOIN sim_precalc_obligations blocked_obligation
          ON blocked_obligation.id = blocked_point.obligation_id
        WHERE blocked_point.promotion_id = promotion.id
          AND blocked_obligation.last_outcome = 'deterministic_failure'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_jobs blocked_child
        CROSS JOIN LATERAL (
          SELECT attempt.error
          FROM result_attempts attempt
          WHERE attempt.sim_job_id = blocked_child.id
          UNION ALL
          SELECT canonical.error
          FROM results canonical
          WHERE canonical.sim_job_id = blocked_child.id
        ) blocked_evidence
        WHERE blocked_child.parent_job_id = parent.id
          AND blocked_child.wave = 2
          AND blocked_child.simulation_preset_revision_id = promotion.revision_id
          AND (
            (promotion.condition_id IS NULL AND blocked_child.request_payload ->> 'conditionId' IS NULL)
            OR blocked_child.request_payload ->> 'conditionId' = promotion.condition_id::text
          )
          AND blocked_child.request_payload ->> 'uransFidelity' = 'precalc'
          AND position('mesh degenerate at this fidelity tier' in lower(COALESCE(blocked_evidence.error, ''))) > 0
          AND position('max non-orthogonality' in lower(COALESCE(blocked_evidence.error, ''))) > 0
      )
      AND EXISTS (
        SELECT 1
        FROM sim_rans_polar_promotion_points point
        JOIN sim_precalc_obligations obligation
          ON obligation.id = point.obligation_id
        WHERE point.promotion_id = promotion.id
          AND obligation.state = 'pending'
          AND obligation.attempt_count < obligation.max_attempts
          AND (
            obligation.next_submit_at IS NULL
            OR obligation.next_submit_at <= now()
          )
          AND (
            (
              promotion.owner_kind = 'background'
              AND obligation.background_owner
            )
            OR (
              promotion.owner_kind = 'campaign'
              AND EXISTS (
              SELECT 1
              FROM sim_precalc_obligation_campaigns ownership
              JOIN sim_campaigns owner_campaign
                ON owner_campaign.id = ownership.campaign_id
               AND owner_campaign.status IN ('active', 'attention')
              WHERE ownership.obligation_id = obligation.id
                AND ownership.state = 'active'
                AND ownership.campaign_id = promotion.campaign_id
              )
            )
            OR (
              promotion.owner_kind = 'sync_promise'
              AND EXISTS (
              SELECT 1
              FROM sync_sweep_promise_points promise_point
              JOIN sync_sweep_promises promise
                ON promise.id = promise_point.promise_id
               AND promise.status = 'active'
               AND promise."expiresAt" > now()
               AND promise.request_payload ->> 'remoteSolver' = 'true'
              WHERE promise_point.airfoil_id = obligation.airfoil_id
                AND promise_point.simulation_preset_revision_id = obligation.revision_id
                AND promise_point.aoa_deg = obligation.aoa_deg
                AND promise_point.status = 'active'
                AND promise.id = promotion.sync_promise_id
              )
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_rans_polar_promotion_points unowned_point
        JOIN sim_precalc_obligations unowned_obligation
          ON unowned_obligation.id = unowned_point.obligation_id
        WHERE unowned_point.promotion_id = promotion.id
          AND unowned_obligation.state = 'pending'
          AND unowned_obligation.attempt_count < unowned_obligation.max_attempts
          AND (
            unowned_obligation.next_submit_at IS NULL
            OR unowned_obligation.next_submit_at <= now()
          )
          AND NOT (
            (
              promotion.owner_kind = 'background'
              AND unowned_obligation.background_owner
            )
            OR (
              promotion.owner_kind = 'campaign'
              AND EXISTS (
              SELECT 1
              FROM sim_precalc_obligation_campaigns ownership
              JOIN sim_campaigns owner_campaign
                ON owner_campaign.id = ownership.campaign_id
               AND owner_campaign.status IN ('active', 'attention')
              WHERE ownership.obligation_id = unowned_obligation.id
                AND ownership.state = 'active'
                AND ownership.campaign_id = promotion.campaign_id
              )
            )
            OR (
              promotion.owner_kind = 'sync_promise'
              AND EXISTS (
              SELECT 1
              FROM sync_sweep_promise_points promise_point
              JOIN sync_sweep_promises promise
                ON promise.id = promise_point.promise_id
               AND promise.status = 'active'
               AND promise."expiresAt" > now()
               AND promise.request_payload ->> 'remoteSolver' = 'true'
              WHERE promise_point.airfoil_id = unowned_obligation.airfoil_id
                AND promise_point.simulation_preset_revision_id = unowned_obligation.revision_id
                AND promise_point.aoa_deg = unowned_obligation.aoa_deg
                AND promise_point.status = 'active'
                AND promise.id = promotion.sync_promise_id
              )
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM sim_jobs live_child
        WHERE live_child.parent_job_id = parent.id
          AND live_child.wave = 2
          AND live_child.status IN ('pending', 'submitted', 'running', 'ingesting')
      )
    ORDER BY promotion."createdAt", promotion.id
    LIMIT ${PROMOTION_RECOVERIES_PER_TICK}
  `)) as unknown as Array<{
    promotion_id: string;
    parent_job_id: string;
  }>;

  for (const candidate of candidates) {
    await touchHeartbeat(db);
    const points = await recordedPromotionPoints(
      db,
      candidate.promotion_id,
      candidate.parent_job_id,
    );
    const event = points[0];
    if (!event || points.length <= 1) continue;
    if (
      await recordedPromotionHasDeterministicMeshBlocker(db, {
        promotionId: event.promotionId,
        parentJobId: event.parentJobId,
        revisionId: event.revisionId,
        conditionId: event.conditionId,
      })
    )
      continue;
    const now = Date.now();
    let schedulable = points.filter(
      (point) =>
        point.state === "pending" &&
        point.attemptCount < point.maxAttempts &&
        (!point.nextSubmitAt || new Date(point.nextSubmitAt).getTime() <= now),
    );
    if (!schedulable.length) continue;
    let obligationIds = schedulable.map((point) => point.obligationId);
    const [continuation] = await precalcContinuationsForObligations(
      db,
      obligationIds,
    );
    let continueFrom: { engineJobId: string; caseSlug: string } | null = null;
    let budgetOverrideS: number | null = null;
    let continuationResultAttemptId: string | null = null;
    if (continuation) {
      schedulable = schedulable.filter(
        (point) => point.obligationId === continuation.obligationId,
      );
      obligationIds = [continuation.obligationId];
      continueFrom = {
        engineJobId: continuation.engineJobId,
        caseSlug: continuation.engineCaseSlug,
      };
      budgetOverrideS = continuation.budgetOverrideS;
      continuationResultAttemptId = continuation.resultAttemptId;
    }
    const remote = await remoteProvenanceForPromotionObligations(
      db,
      obligationIds,
      event,
    );
    if (remote.required && "unavailable" in remote) continue;
    const target = await resolveTarget(db, event.airfoilId, event.revisionId);
    if (!target) continue;
    const aoas = schedulable.map((point) => point.aoaDeg);
    const outcome = await submitLadderJob(db, engine, {
      target,
      aoas,
      fidelity: "precalc",
      jobKind: "targeted",
      campaignId: null,
      payloadExtras: {
        ...(remote.required
          ? {
              syncPromiseId: remote.syncPromiseId,
              remoteSolver: remote.remoteSolver,
              upstreamBaseUrl: remote.upstreamBaseUrl,
            }
          : {}),
        conditionalPromotionId: event.promotionId,
        parentJobId: event.parentJobId,
        conditionId: event.conditionId,
        precalcObligationIds: obligationIds,
        retryMode: "whole-polar-urans",
        promotionRequestedAoas: points.map((point) => point.aoaDeg),
        ...(continuationResultAttemptId
          ? {
              continueFromResultAttemptId: continuationResultAttemptId,
              budgetOverrideS,
            }
          : {}),
      },
      cpuSlots,
      continueFrom,
      budgetOverrideS,
      recordedPromotion: {
        promotionId: event.promotionId,
        parentJobId: event.parentJobId,
        conditionId: event.conditionId,
        obligationIds,
      },
    });
    if (outcome.submitted) {
      await recordPrecalcObligationSubmission(db, outcome.jobId, obligationIds);
      console.log(
        `[sweeper] recovered conditional whole-polar promotion ${event.promotionId} directly from its durable ledger through wave-2 child ${outcome.jobId} (parent ${event.parentJobId}, angles [${aoas.join(", ")}])`,
      );
      return true;
    }
    if (outcome.submissionInProgress) return true;
  }
  return false;
}

/** Tier-2a: re-attempt gated campaign wave-2 retries for campaigns whose RANS
 *  gaps have hit zero. Returns true when a submission happened. */
async function submitGatedCampaignRetries(
  db: DB,
  engine: EngineClient,
  campaignIds?: string[],
  parentJobIds?: string[],
): Promise<boolean> {
  const statusFilter = inArray(simCampaigns.status, ["active", "attention"]);
  const campaigns = await db
    .select({ id: simCampaigns.id })
    .from(simCampaigns)
    .where(
      campaignIds?.length
        ? and(statusFilter, inArray(simCampaigns.id, campaignIds))
        : statusFilter,
    );
  for (const campaign of campaigns) {
    if (await campaignHasOpenRansGaps(db, campaign.id)) continue;
    // STARVATION GUARD (adversarial review 2026-07-07): parents whose retry
    // plan is empty never grow a wave-2 child, so they never leave the
    // NOT-EXISTS filter. They MUST also be excluded from the SQL window —
    // skipping them only in memory left the finishedAt-ordered LIMIT window
    // permanently occupied by the first N no-retry parents, and parents
    // ranked past the window (typically the needs_urans ones, which finish
    // last because the gate stays closed until the final RANS gap) were never
    // fetched → precalc_open stuck > 0, campaign never completed. With the
    // exclusion the window slides forward every tick; a restart clears the
    // set and simply re-settles from the front at 3 parents/tick — bounded
    // progress, no re-block. MUST-CATCH: urans-ladder.test.ts starvation test.
    const settledIds = [...settledGatedParents];
    const child = alias(simJobs, "settled_wave2_child");
    const parents = await db
      .select()
      .from(simJobs)
      .where(
        and(
          eq(simJobs.campaignId, campaign.id),
          eq(simJobs.wave, 1),
          ...(parentJobIds ? [inArray(simJobs.id, parentJobIds)] : []),
          // A cancelled wave-1 parent may already have ingested truthful RANS
          // evidence before its remaining engine work was stopped.  Its
          // rejected cells still owe the campaign a durable precalc attempt;
          // excluding cancelled-but-ingested parents stranded those cells
          // forever (prod campaign 20260710: 21 awaiting-URANS cells).
          or(
            and(
              inArray(simJobs.status, ["done", "failed"]),
              isNotNull(simJobs.ingestedAt),
            ),
            and(
              eq(simJobs.status, "cancelled"),
              or(
                isNotNull(simJobs.ingestedAt),
                // Running-partial ingestion stores immutable attempt evidence
                // but intentionally leaves the terminal-ingest timestamp null.
                // A later admin cancellation must not hide that evidence.
                sql`EXISTS (SELECT 1 FROM result_attempts partial_attempt WHERE partial_attempt.sim_job_id = ${simJobs.id})`,
              ),
            ),
          ),
          ...(settledIds.length ? [notInArray(simJobs.id, settledIds)] : []),
          // Only an actually live child blocks this parent. Terminal children
          // are immutable attempt history; a pending sibling obligation must
          // be allowed to drain through the next sequential child.
          notExists(
            db
              .select({ id: child.id })
              .from(child)
              .where(
                and(
                  eq(child.parentJobId, simJobs.id),
                  eq(child.wave, 2),
                  inArray(child.status, [
                    "pending",
                    "submitted",
                    "running",
                    "ingesting",
                  ]),
                ),
              ),
          ),
        ),
      )
      .orderBy(simJobs.finishedAt)
      .limit(GATED_PARENTS_PER_TICK);
    let attempted = 0;
    for (const parent of parents) {
      if (settledGatedParents.has(parent.id)) continue;
      if (attempted >= GATED_PARENTS_PER_TICK) break;
      attempted += 1;
      await touchHeartbeat(db);
      const before = await db
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
      await submitUransRetryForJob(db, engine, parent);
      const [campaignAfterSubmit] = parent.campaignId
        ? await db
            .select({ status: simCampaigns.status })
            .from(simCampaigns)
            .where(eq(simCampaigns.id, parent.campaignId))
            .limit(1)
        : [];
      if (campaignAfterSubmit?.status === "paused") {
        // Pause may win after composition but before/while engine submission.
        // Its cancelled child is deliberately NOT a settled obligation: the
        // queued/no-owner rows must be reconsidered after explicit resume in
        // this same process, not only after a restart clears memory.
        settledGatedParents.delete(parent.id);
        continue;
      }
      const beforeIds = new Set(before.map((row) => row.id));
      const after = await db
        .select({ id: simJobs.id, status: simJobs.status })
        .from(simJobs)
        .where(and(eq(simJobs.parentJobId, parent.id), eq(simJobs.wave, 2)));
      const created = after.filter((row) => !beforeIds.has(row.id));
      if (!created.length) {
        const [openObligation] = (await db.execute(sql`
          SELECT 1 AS present
          WHERE EXISTS (
            SELECT 1
            FROM sim_jobs sibling_child
            CROSS JOIN LATERAL jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(sibling_child.request_payload -> 'precalcObligationIds') = 'array'
                THEN sibling_child.request_payload -> 'precalcObligationIds'
                ELSE '[]'::jsonb
              END
            ) payload_obligation(id)
            JOIN sim_precalc_obligations obligation
              ON obligation.id = payload_obligation.id::uuid
            WHERE sibling_child.parent_job_id = ${parent.id}
              AND obligation.state IN ('pending', 'running')
          ) OR EXISTS (
            -- Covers a crash/failure after ensure but before the child insert.
            -- Scope that durable cell back to THIS parent's rejected RANS
            -- evidence. An unrelated open PRECALC obligation on the same
            -- campaign/revision must not keep every childless no-plan parent
            -- in the first scan window forever.
            SELECT 1
            FROM sim_precalc_obligations obligation
            JOIN sim_precalc_obligation_campaigns ownership
              ON ownership.obligation_id = obligation.id
             AND ownership.state = 'active'
            WHERE ownership.campaign_id = ${parent.campaignId}
              AND obligation.airfoil_id = ${parent.airfoilId}
              AND obligation.revision_id = ${parent.simulationPresetRevisionId}
              AND obligation.state IN ('pending', 'running')
              AND (
                EXISTS (
                  SELECT 1
                  FROM result_attempts parent_attempt
                  JOIN result_classifications classification
                    ON classification.result_attempt_id = parent_attempt.id
                  WHERE parent_attempt.sim_job_id = ${parent.id}
                    AND parent_attempt.regime = 'rans'
                    AND parent_attempt.airfoil_id = obligation.airfoil_id
                    AND parent_attempt.simulation_preset_revision_id = obligation.revision_id
                    AND parent_attempt.aoa_deg = obligation.aoa_deg
                    AND classification.state IN ('rejected', 'needs_urans')
                )
                OR EXISTS (
                  SELECT 1
                  FROM results parent_result
                  JOIN result_classifications classification
                    ON classification.result_id = parent_result.id
                  WHERE parent_result.sim_job_id = ${parent.id}
                    AND parent_result.regime = 'rans'
                    AND parent_result.airfoil_id = obligation.airfoil_id
                    AND parent_result.simulation_preset_revision_id = obligation.revision_id
                    AND parent_result.aoa_deg = obligation.aoa_deg
                    AND classification.state IN ('rejected', 'needs_urans')
                )
              )
          )
          LIMIT 1
        `)) as unknown as Array<{ present: number }>;
        // A retry-wait obligation intentionally produces no child until its
        // due time. It is not a no-plan parent and must remain reachable in
        // this process. Memoize only when all known physical cells settled.
        if (openObligation) settledGatedParents.delete(parent.id);
        else settledGatedParents.add(parent.id);
        continue;
      }
      if (
        created.some((row) =>
          ["pending", "submitted", "running", "ingesting"].includes(row.status),
        )
      ) {
        // The live child itself is the durable duplicate barrier. Do not memo
        // the parent: once this child settles, another physical obligation on
        // the same parent may need a continuation in this same process.
        settledGatedParents.delete(parent.id);
        return true;
      }
      // Even a synchronously-terminal child may have left another cell or its
      // one continuation pending. Re-scan next tick; memoization is reserved
      // for the genuine no-plan branch above.
      settledGatedParents.delete(parent.id);
    }
  }
  return false;
}

interface ComposedTarget {
  airfoilId: string;
  revisionId: string;
  snapshot: SimulationSetupSnapshot;
  bcId: string;
}

/** Resolve airfoil + pinned revision snapshot + bc for a ladder job (snapshot
 *  legacy bc first, live preset fallback — the resolveCampaignEntries rule). */
async function resolveTarget(
  db: DB,
  airfoilId: string,
  revisionId: string,
): Promise<ComposedTarget | null> {
  const [revision] = await db
    .select()
    .from(simulationPresetRevisions)
    .where(eq(simulationPresetRevisions.id, revisionId))
    .limit(1);
  if (!revision) return null;
  const snapshot = revision.snapshot as unknown as SimulationSetupSnapshot;
  let bcId = snapshot.preset.legacyBoundaryConditionId ?? null;
  if (!bcId) {
    const [preset] = await db
      .select({
        legacyBoundaryConditionId: simulationPresets.legacyBoundaryConditionId,
      })
      .from(simulationPresets)
      .where(eq(simulationPresets.id, revision.presetId))
      .limit(1);
    bcId = preset?.legacyBoundaryConditionId ?? null;
  }
  if (!bcId) return null;
  return { airfoilId, revisionId, snapshot, bcId };
}

/** Compose + submit one wave-2 URANS ladder job (admin request or verify
 *  item). NO claim flips: existing done rows keep their evidence — a failed
 *  ladder solve must never destroy previously-good coefficients; success
 *  overwrites via the natural-key upsert at ingest. */
async function submitLadderJob(
  db: DB,
  engine: EngineClient,
  opts: {
    target: ComposedTarget;
    aoas: number[];
    fidelity: UransFidelity;
    jobKind: "targeted" | "verify";
    campaignId?: string | null;
    payloadExtras: Record<string, unknown>;
    cpuSlots: number;
    /** Continuation (amendment C): resume the transient of a saved engine case
     *  instead of a fresh solve. Composed into the request as
     *  { continue_from: { engine_job_id, case_slug } }. */
    continueFrom?: { engineJobId: string; caseSlug: string } | null;
    /** Continuation budget override [s] — replaces the tier-derived budget. */
    budgetOverrideS?: number | null;
    /** Claimed admin request linked to the composed job before submit. */
    uransRequestId?: string;
    /** Claimed automatic full-verification item. */
    verifyQueueId?: string;
    /** Crash recovery for one normalized whole-polar event. The exact event
     * and selected obligation ids are revalidated by the child composer in
     * the same transaction as insertion. */
    recordedPromotion?: {
      promotionId: string;
      parentJobId: string;
      conditionId: string | null;
      obligationIds: string[];
    };
  },
): Promise<{
  jobId: string;
  submitted: boolean;
  connectionFailure: boolean;
  lifecycleStopped: boolean;
  submissionInProgress: boolean;
  error?: string;
  httpStatus?: number | null;
  ladderDisposition?: "retry_wait" | "blocked" | null;
}> {
  const {
    target,
    aoas,
    fidelity,
    jobKind,
    campaignId,
    payloadExtras,
    cpuSlots,
  } = opts;
  const [a] = await db
    .select()
    .from(airfoils)
    .where(eq(airfoils.id, target.airfoilId))
    .limit(1);
  if (!a) {
    return {
      jobId: "",
      submitted: false,
      connectionFailure: false,
      lifecycleStopped: false,
      submissionInProgress: false,
      error: `airfoil ${target.airfoilId} not found`,
    };
  }
  const { request, speed } = buildPolarRequest({
    airfoil: a,
    setup: target.snapshot,
    aoaList: aoas,
    wave: 2,
    uransFidelity: fidelity,
    queuePressure: await solverQueuePressure(db),
    cpuSlots,
  });
  // Ladder jobs are URANS-BY-DEFINITION: the in-job steady stage is only the
  // designed warm-start init, never the reported result. Pin the transient
  // flags locally instead of relying on buildPolarRequest's wave-2 inference —
  // a ladder request shipped without solver.force_transient runs URANS on the
  // FULL mesh at this tier's budget (the engine's half-mesh derivation,
  // src/airfoilfoam/models.py effective_mesh_params, requires
  // force_transient && precalc), which structurally guarantees
  // insufficient-periods (budget) rejections (prod job e89be2bb).
  // MUST-CATCH payload-shape pins: urans-ladder.test.ts.
  request.solver = {
    ...request.solver,
    transient_fallback: true,
    force_transient: true,
    urans_fidelity: fidelity,
  };
  if (opts.continueFrom) {
    // Amendment C: the engine copies/links the saved case dir into the new
    // job and restarts the transient from latestTime, merging coefficient
    // history (the existing restart-segment machinery, across jobs).
    // MUST-CATCH payload-shape pin: urans-ladder-continuation test.
    request.continue_from = {
      engine_job_id: opts.continueFrom.engineJobId,
      case_slug: opts.continueFrom.caseSlug,
    };
    if (opts.budgetOverrideS != null)
      request.budget_override_s = opts.budgetOverrideS;
  }
  const jobValues: typeof simJobs.$inferInsert = {
    parentJobId: opts.recordedPromotion?.parentJobId ?? null,
    airfoilId: a.id,
    bcIds: [target.bcId],
    simulationPresetRevisionId: target.revisionId,
    campaignId: campaignId ?? null,
    jobKind,
    referenceChordM: target.snapshot.referenceGeometry.referenceLengthM,
    wave: 2,
    status: "pending",
    totalCases: aoas.length,
    requestPayload: {
      speedMap: [
        {
          speed,
          bcId: target.bcId,
          presetRevisionId: target.revisionId,
          mach: target.snapshot.flowState.mach,
        },
      ],
      aoas,
      uransFidelity: fidelity,
      resources: request.resources,
      setupSnapshot: target.snapshot,
      ...payloadExtras,
    },
  };
  const payloadObligationIds = Array.isArray(
    (payloadExtras as { precalcObligationIds?: unknown }).precalcObligationIds,
  )
    ? (
        payloadExtras as { precalcObligationIds: unknown[] }
      ).precalcObligationIds.filter(
        (id): id is string => typeof id === "string",
      )
    : [];
  if (
    opts.recordedPromotion &&
    ([...payloadObligationIds].sort().join(",") !==
      [...opts.recordedPromotion.obligationIds].sort().join(",") ||
      payloadObligationIds.length !==
        opts.recordedPromotion.obligationIds.length)
  ) {
    throw new Error(
      "recorded promotion recovery payload does not match its selected obligation ids",
    );
  }
  const job = payloadObligationIds.length
    ? await composePhysicalPrecalcJob(db, {
        obligationIds: payloadObligationIds,
        job: jobValues,
        ...(opts.recordedPromotion
          ? {
              directParent: {
                parentJobId: opts.recordedPromotion.parentJobId,
                revisionId: target.revisionId,
                conditionId: opts.recordedPromotion.conditionId ?? undefined,
                recordedPromotionId: opts.recordedPromotion.promotionId,
              },
            }
          : {}),
      })
    : (
        await db.insert(simJobs).values(jobValues).returning({ id: simJobs.id })
      )[0];
  if (!job) {
    return {
      jobId: "",
      submitted: false,
      connectionFailure: false,
      lifecycleStopped: true,
      submissionInProgress: false,
      error:
        "physical precalc obligation is already claimed or no longer runnable",
    };
  }
  if (opts.uransRequestId || opts.verifyQueueId) {
    const ownerBound = await db.transaction(async (tx) => {
      let bound = false;
      if (opts.uransRequestId) {
        const rows = await tx
          .update(simUransRequests)
          .set({ simJobId: job.id })
          .where(
            and(
              eq(simUransRequests.id, opts.uransRequestId),
              eq(simUransRequests.state, "running"),
            ),
          )
          .returning({ id: simUransRequests.id });
        bound = rows.length === 1;
      }
      if (opts.verifyQueueId) {
        const rows = await tx
          .update(simUransVerifyQueue)
          .set({ simJobId: job.id })
          .where(
            and(
              eq(simUransVerifyQueue.id, opts.verifyQueueId),
              eq(simUransVerifyQueue.state, "running"),
            ),
          )
          .returning({ id: simUransVerifyQueue.id });
        bound = rows.length === 1;
      }
      if (bound && fidelity === "full") {
        await tx
          .update(simLadderSubmitRetries)
          .set({ latestSimJobId: job.id })
          .where(
            and(
              eq(simLadderSubmitRetries.state, "retry_wait"),
              opts.uransRequestId
                ? and(
                    eq(
                      simLadderSubmitRetries.uransRequestId,
                      opts.uransRequestId,
                    ),
                    sql`EXISTS (
                      SELECT 1 FROM sim_urans_requests current_request
                      WHERE current_request.id = ${opts.uransRequestId}
                        AND current_request.state = 'running'
                        AND current_request.sim_job_id = ${job.id}
                    )`,
                  )
                : and(
                    eq(
                      simLadderSubmitRetries.verifyQueueId,
                      opts.verifyQueueId!,
                    ),
                    sql`EXISTS (
                      SELECT 1 FROM sim_urans_verify_queue current_verify
                      WHERE current_verify.id = ${opts.verifyQueueId!}
                        AND current_verify.state = 'running'
                        AND current_verify.sim_job_id = ${job.id}
                    )`,
                  ),
            ),
          );
      }
      return bound;
    });
    if (!ownerBound) {
      await db
        .update(simJobs)
        .set({
          status: "cancelled",
          engineState: "cancelled",
          error: "ladder owner changed before job binding",
          finishedAt: new Date(),
        })
        .where(and(eq(simJobs.id, job.id), eq(simJobs.status, "pending")));
      return {
        jobId: job.id,
        submitted: false,
        connectionFailure: false,
        lifecycleStopped: true,
        submissionInProgress: false,
        error: "ladder owner changed before job binding",
      };
    }
  }
  const submit = await submitPendingJobWithLifecycleGuard({
    db,
    engine,
    jobId: job.id,
    campaignId: campaignId ?? null,
    request,
    connectionErrorPrefix: "engine unreachable at ladder submit: ",
    submitErrorPrefix: "ladder submit failed: ",
    precalcObligationIds: payloadObligationIds,
    ...(fidelity === "full" && opts.uransRequestId
      ? { ladderSubmitOwner: { uransRequestId: opts.uransRequestId } }
      : fidelity === "full" && opts.verifyQueueId
        ? { ladderSubmitOwner: { verifyQueueId: opts.verifyQueueId } }
        : {}),
  });
  if (submit.kind === "submitted") {
    return {
      jobId: job.id,
      submitted: true,
      connectionFailure: false,
      lifecycleStopped: false,
      submissionInProgress: false,
    };
  }
  if (submit.kind === "connection_failure") {
    await recordEngineUnreachable(db);
    return {
      jobId: job.id,
      submitted: false,
      connectionFailure: true,
      lifecycleStopped: false,
      submissionInProgress: false,
      error: submit.error,
    };
  }
  if (submit.kind === "lifecycle_stopped") {
    return {
      jobId: job.id,
      submitted: false,
      connectionFailure: false,
      lifecycleStopped: true,
      submissionInProgress: false,
      error: submit.error,
    };
  }
  if (submit.kind === "submission_in_progress") {
    return {
      jobId: job.id,
      submitted: false,
      connectionFailure: false,
      lifecycleStopped: false,
      submissionInProgress: true,
    };
  }
  return {
    jobId: job.id,
    submitted: false,
    connectionFailure: false,
    lifecycleStopped: false,
    submissionInProgress: false,
    error: submit.error,
    httpStatus: submit.httpStatus,
    ladderDisposition: submit.ladderDisposition,
  };
}

/** Tier-2b: consume ONE pending admin request-URANS item (contract 6).
 *  aoaDeg NULL = whole polar (the pinned revision's sweep angle grid). */
async function consumeUransRequest(
  db: DB,
  engine: EngineClient,
  cpuSlots: number,
  requestIds?: string[],
): Promise<boolean> {
  const request = await claimNextPendingUransRequest(db, { requestIds });
  if (!request) return false;
  const fidelity: UransFidelity =
    request.fidelity === "full" ? "full" : "precalc";
  const target = await resolveTarget(db, request.airfoilId, request.revisionId);
  if (!target) {
    console.error(
      `[sweeper] URANS request ${request.id} cancelled: revision ${request.revisionId} unresolvable (missing revision or bc)`,
    );
    await db
      .update(simUransRequests)
      .set({ state: "cancelled" })
      .where(eq(simUransRequests.id, request.id));
    return false;
  }
  // Continuation (amendment C): the request pins the SOURCE results row whose
  // saved engine case the resumed transient restarts from. The source row must
  // still carry its engine addressing (engine_job_id + engine_case_slug) —
  // without it there is no case state to resume, so the item cancels loudly
  // instead of pretending a fresh solve is a continuation.
  let continueFrom: { engineJobId: string; caseSlug: string } | null = null;
  let effectiveBudgetOverrideS = request.budgetOverrideS ?? null;
  let aoas: number[];
  if (request.continueFromResultId) {
    const [source] = await db
      .select({
        aoaDeg: results.aoaDeg,
        engineJobId: results.engineJobId,
        engineCaseSlug: results.engineCaseSlug,
      })
      .from(results)
      .where(eq(results.id, request.continueFromResultId))
      .limit(1);
    if (!source || !source.engineJobId || !source.engineCaseSlug) {
      console.error(
        `[sweeper] URANS request ${request.id} cancelled: continuation source ${request.continueFromResultId} has no saved case state (row missing or engine ids absent)`,
      );
      await db
        .update(simUransRequests)
        .set({ state: "cancelled" })
        .where(eq(simUransRequests.id, request.id));
      return false;
    }
    continueFrom = {
      engineJobId: source.engineJobId,
      caseSlug: source.engineCaseSlug,
    };
    aoas = [request.aoaDeg ?? source.aoaDeg];
  } else {
    aoas =
      request.aoaDeg != null ? [request.aoaDeg] : snapshotAoas(target.snapshot);
  }
  if (!aoas.length) {
    console.error(
      `[sweeper] URANS request ${request.id} cancelled: no angles derivable from the pinned revision sweep`,
    );
    await db
      .update(simUransRequests)
      .set({ state: "cancelled" })
      .where(eq(simUransRequests.id, request.id));
    return false;
  }
  let obligationIds: string[] = [];
  let obligationContinuationResultAttemptId: string | null = null;
  if (fidelity === "precalc") {
    const campaignIds = await activeCampaignOwnersForUransRequest(
      db,
      request.id,
    );
    const obligations = await ensurePrecalcObligations(
      db,
      aoas.map((aoaDeg) => ({
        airfoilId: request.airfoilId,
        revisionId: request.revisionId,
        aoaDeg,
        sourceResultId: request.continueFromResultId,
      })),
      { campaignIds, requestIds: [request.id] },
    );
    const schedulable = obligations.filter(
      (obligation) =>
        obligation.state === "pending" &&
        obligation.attemptCount < obligation.maxAttempts &&
        (!obligation.nextSubmitAt ||
          new Date(obligation.nextSubmitAt).getTime() <= Date.now()),
    );
    if (!schedulable.length) {
      if (
        obligations.some(
          (obligation) =>
            obligation.state === "pending" &&
            obligation.attemptCount < obligation.maxAttempts,
        )
      ) {
        // A first answered 5xx owns one durable backoff. Keep the request
        // claimable, but do not spin a new engine composition before it is due.
        await releaseClaimedUransRequest(db, request.id);
        return false;
      }
      const requestState = await precalcRequestStateFromObligations(
        db,
        request.id,
      );
      await db
        .update(simUransRequests)
        .set({ state: requestState, simJobId: null })
        .where(eq(simUransRequests.id, request.id));
      return false;
    }
    const schedulableAoas = new Set(
      schedulable.map((obligation) => obligation.aoaDeg),
    );
    aoas = aoas.filter((aoa) => schedulableAoas.has(aoa));
    obligationIds = schedulable.map((obligation) => obligation.id);
    const [latestContinuation] = await precalcContinuationsForObligations(
      db,
      obligationIds,
    );
    if (latestContinuation) {
      aoas = [latestContinuation.aoaDeg];
      obligationIds = [latestContinuation.obligationId];
      continueFrom = {
        engineJobId: latestContinuation.engineJobId,
        caseSlug: latestContinuation.engineCaseSlug,
      };
      obligationContinuationResultAttemptId =
        latestContinuation.resultAttemptId;
      effectiveBudgetOverrideS = latestContinuation.budgetOverrideS;
    }
  }
  const outcome = await submitLadderJob(db, engine, {
    target,
    aoas,
    fidelity,
    jobKind: "targeted",
    // Physical continuation work is global; campaign ownership stays on the
    // request association rows so one campaign cannot cancel shared evidence.
    campaignId: null,
    payloadExtras: {
      uransRequestId: request.id,
      ...(obligationIds.length ? { precalcObligationIds: obligationIds } : {}),
      ...(obligationContinuationResultAttemptId
        ? {
            continueFromResultAttemptId: obligationContinuationResultAttemptId,
            budgetOverrideS: effectiveBudgetOverrideS,
          }
        : {}),
      ...(request.continueFromResultId
        ? {
            continueFromResultId: request.continueFromResultId,
            budgetOverrideS: request.budgetOverrideS ?? null,
          }
        : {}),
    },
    cpuSlots,
    continueFrom,
    budgetOverrideS: effectiveBudgetOverrideS,
    uransRequestId: request.id,
  });
  if (outcome.submitted) {
    if (obligationIds.length) {
      await recordPrecalcObligationSubmission(db, outcome.jobId, obligationIds);
    }
    await db
      .update(simUransRequests)
      .set({ state: "running", simJobId: outcome.jobId })
      .where(eq(simUransRequests.id, request.id));
    console.log(
      `[sweeper] URANS request ${request.id} submitted (${fidelity}, ${aoas.length} angle(s), job ${outcome.jobId}${
        continueFrom
          ? `, CONTINUATION of engine ${continueFrom.engineJobId}/${continueFrom.caseSlug}${request.budgetOverrideS ? ` with budget override ${request.budgetOverrideS}s` : ""}`
          : ""
      })`,
    );
    return true;
  }
  if (outcome.submissionInProgress) return true;
  if (outcome.connectionFailure || outcome.lifecycleStopped) {
    await releaseClaimedUransRequest(db, request.id);
    return false;
  }
  if (obligationIds.length) {
    const requestState = await precalcRequestStateFromObligations(
      db,
      request.id,
    );
    await db
      .update(simUransRequests)
      .set({ state: requestState, simJobId: null })
      .where(eq(simUransRequests.id, request.id));
    return false;
  }
  console.error(
    `[sweeper] URANS request ${request.id} ${outcome.ladderDisposition === "retry_wait" ? "waiting for its one automatic submit retry" : "blocked"}: engine rejected the submit (${outcome.error})`,
  );
  // Full-request owner + durable retry ledger were settled atomically with the
  // failed sim_job. Never rewrite accepted result evidence or downgrade this
  // machine-terminal outcome into a review/cancel placeholder here.
  return false;
}

/** Tier-3: consume ONE pending verify-queue item (contract 4) — ONLY when no
 *  campaign RANS/precalc work exists machine-wide (checked by the caller). */
async function consumeVerifyItem(
  db: DB,
  engine: EngineClient,
  cpuSlots: number,
  scope: { campaignIds?: string[]; verifyIds?: string[] } = {},
): Promise<boolean> {
  const item = await claimNextPendingVerifyItem(db, scope);
  if (!item) return false;
  const precalc = await precalcSnapshotForVerifyItem(db, item);
  if (!precalc) {
    // The precalc row is gone / no longer a done precalc solve (re-solved,
    // failed, or already verified) — the item is stale, not verifiable.
    console.error(
      `[sweeper] verify item ${item.id} cancelled: precalc result ${item.precalcResultId} is no longer a done urans_precalc row`,
    );
    await db
      .update(simUransVerifyQueue)
      .set({ state: "cancelled", simJobId: null })
      .where(eq(simUransVerifyQueue.id, item.id));
    return false;
  }
  const target = await resolveTarget(db, item.airfoilId, item.revisionId);
  if (!target) {
    console.error(
      `[sweeper] verify item ${item.id} cancelled: revision ${item.revisionId} unresolvable (missing revision or bc)`,
    );
    await db
      .update(simUransVerifyQueue)
      .set({ state: "cancelled", simJobId: null })
      .where(eq(simUransVerifyQueue.id, item.id));
    return false;
  }
  const outcome = await submitLadderJob(db, engine, {
    target,
    aoas: [item.aoaDeg],
    fidelity: "full",
    jobKind: "verify",
    // One physical verification job serves every associated campaign and/or
    // the background owner. Never stamp an arbitrary campaign on the job.
    campaignId: null,
    payloadExtras: { verifyQueueItemId: item.id, verifyPrecalc: precalc },
    cpuSlots,
    verifyQueueId: item.id,
  });
  if (outcome.submitted) {
    console.log(
      `[sweeper] verify item ${item.id} submitted (aoa ${item.aoaDeg}, full fidelity, job ${outcome.jobId})`,
    );
    return true;
  }
  if (outcome.connectionFailure || outcome.lifecycleStopped) {
    await releaseClaimedVerifyItem(db, item.id);
    return false; // pending for a live/paused campaign; backoff/compensation recorded
  }
  if (outcome.submissionInProgress) return true;
  console.error(
    `[sweeper] verify item ${item.id} ${outcome.ladderDisposition === "retry_wait" ? "waiting for its one automatic submit retry" : "blocked"}: engine rejected the submit (${outcome.error})`,
  );
  // The submit boundary owns the retry/blocked transition. The accepted
  // preliminary result remains untouched and visible while verification is
  // terminally unavailable.
  return false;
}

/** One ladder pass: heal orphans, then submit AT MOST one piece of work in
 *  tier order (gated campaign retries → admin requests → verify queue). The
 *  caller (loop.tick) invokes this only when the RANS branch submitted nothing
 *  and in-flight capacity remains. Exported cpuSlots plumbed from
 *  sweeper_state like the RANS branch. */
export async function uransLadderTick(
  db: DB,
  engine: EngineClient,
  cpuSlots = 0,
  /** Test-harness scoping for parallel files sharing one dev DB. Production
   *  passes nothing and therefore keeps the machine-wide scheduler semantics.
   *  Tests must scope every physical queue they may claim; campaignIds alone
   *  cannot stop an admin request from another file winning tier 2b. */
  opts: {
    campaignIds?: string[];
    /** Test-only closed world for tier-2a's finished-parent window. */
    parentJobIds?: string[];
    /** Test-only closed world for normalized conditional-promotion recovery. */
    promotionIds?: string[];
    requestIds?: string[];
    verifyIds?: string[];
  } = {},
): Promise<boolean> {
  const healedItems = await healOrphanedVerifyItems(db, {
    campaignIds: opts.campaignIds,
    verifyIds: opts.verifyIds,
  });
  if (healedItems > 0)
    console.log(
      `[sweeper] verify queue: ${healedItems} orphaned running item(s) settled by current campaign lifecycle`,
    );
  const healedRequests = await healOrphanedUransRequests(db, {
    requestIds: opts.requestIds,
  });
  if (healedRequests > 0)
    console.log(
      `[sweeper] URANS requests: ${healedRequests} orphaned running request(s) returned to pending`,
    );

  if (await submitRecordedPromotionRecovery(db, engine, cpuSlots, opts))
    return true;
  if (
    await submitGatedCampaignRetries(
      db,
      engine,
      opts.campaignIds,
      opts.parentJobIds,
    )
  )
    return true;
  if (await consumeUransRequest(db, engine, cpuSlots, opts.requestIds))
    return true;
  // Verify tier is the GLOBAL LOWEST rank (contract 5): only when no campaign
  // RANS/precalc work exists machine-wide. A supplied requestIds list is a
  // test-only closed world; production never supplies it.
  if (
    await hasOpenCampaignLadderWork(db, {
      requestIds: opts.requestIds,
      campaignIds: opts.campaignIds,
    })
  )
    return false;
  return consumeVerifyItem(db, engine, cpuSlots, {
    campaignIds: opts.campaignIds,
    verifyIds: opts.verifyIds,
  });
}
