import {
  LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID,
  RANS_RECOVERY_REMEDIATION_VERSION,
  type DB,
  enforceSweeperAdmissionFence,
  onResultIngested,
  probeCampaignCompletion,
  recordSolverIncidentInTransaction,
  recomputeProgressForCampaign,
  recordPrecalcObligationSubmitFailureInTransaction,
  refreshFullUransRequestStateInTransaction,
  refreshFullUransRequestsForVerifyQueueInTransaction,
  refreshPrecalcSettlementCampaigns,
  restartablePrecalcCheckpointSql,
  results,
  simLadderSubmitRetries,
  simJobs,
  simResultSubmitRetries,
  simUransRequests,
  simUransVerifyQueue,
  settlePrecalcObligationsForJobInTransaction,
} from "@aerodb/db";
import { releasedResultStatusSql } from "@aerodb/db/result-claim-lifecycle";
import {
  ENGINE_IDENTITY_MISMATCH_CODE,
  EngineError,
  MESH_RECOVERY_CAPABILITY_MISMATCH_CODE,
  type EngineClient,
  type JobStatus,
  type PolarRequest,
  URANS_RECOVERY_CAPABILITY_MISMATCH_CODE,
} from "@aerodb/engine-client";
import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";

import { isEngineConnectionFailure } from "./engine-backoff";
import { persistEngineRuntimeForJob } from "./engine-provenance";

export type GuardedSubmitOutcome =
  | { kind: "submitted"; status: JobStatus }
  | { kind: "submission_in_progress" }
  | {
      kind: "lifecycle_stopped";
      error: string;
      acceptedEngineJobId: string | null;
      engineCancelError: string | null;
    }
  | { kind: "connection_failure"; error: string }
  | { kind: "capability_mismatch"; error: string }
  | {
      kind: "submit_failed";
      error: string;
      httpStatus: number | null;
      ladderDisposition?: "retry_wait" | "blocked" | null;
    };

/** Exactly one full-fidelity ladder owner. Preliminary request jobs omit this
 * and use the 0047 physical-obligation ledger instead. */
export type LadderSubmitOwner =
  | { uransRequestId: string; verifyQueueId?: never }
  | { verifyQueueId: string; uransRequestId?: never };

/** The global scheduler switch owns locally scheduled work only. Dedicated
 * remote-solver deployments intentionally keep that switch off and admit
 * mirrored work through their independently configured remote CPU budget.
 *
 * `operator_canary` is the opposite, deliberately narrow maintenance lane:
 * the exact three-stage canary may submit only while the normal scheduler is
 * disabled and both durable capacity knobs are exactly zero. It still crosses
 * the same serialized hazard fence and is never inferred from job payloads. */
export type SubmissionAdmissionLane = "local" | "remote" | "operator_canary";

const SUBMITTING_ENGINE_STATE = "submitting";
const ANSWERED_SERVER_RETRY_BACKOFF_MS = 30_000;

function ladderOwnerId(owner: LadderSubmitOwner): string {
  return owner.uransRequestId ?? owner.verifyQueueId!;
}

/** Queue pressure seen by engine scheduling. The optional id scope exists
 * only for deterministic shared-DB verification; production always counts
 * the whole local queue. */
export async function solverQueuePressure(
  db: DB,
  opts: { jobIds?: string[] } = {},
): Promise<number> {
  const filters = [
    inArray(simJobs.status, ["pending", "submitted", "running", "ingesting"]),
  ];
  if (opts.jobIds?.length) filters.push(inArray(simJobs.id, opts.jobIds));
  const [row] = await db
    .select({ n: count() })
    .from(simJobs)
    .where(and(...filters));
  return Number(row?.n ?? 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pendingSubmitWhere(jobId: string, campaignId: string | null) {
  return and(
    eq(simJobs.id, jobId),
    eq(simJobs.status, "pending"),
    ...(campaignId
      ? [
          eq(simJobs.campaignId, campaignId),
          sql`EXISTS (
            SELECT 1 FROM sim_campaigns submit_campaign
            WHERE submit_campaign.id = ${campaignId}
              AND submit_campaign.status IN ('active', 'attention')
          )`,
        ]
      : [
          isNull(simJobs.campaignId),
          sql`CASE
            WHEN ${simJobs.requestPayload} ? 'precalcObligationIds' THEN (
              jsonb_typeof(${simJobs.requestPayload} -> 'precalcObligationIds') = 'array'
              AND jsonb_array_length(${simJobs.requestPayload} -> 'precalcObligationIds') > 0
              AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(
                  ${simJobs.requestPayload} -> 'precalcObligationIds'
                ) payload_obligation(id)
                LEFT JOIN sim_precalc_obligations obligation
                  ON obligation.id::text = payload_obligation.id
                WHERE obligation.id IS NULL
                   OR obligation.state NOT IN ('pending', 'running')
                   OR obligation.latest_sim_job_id IS DISTINCT FROM ${simJobs.id}
                   OR (
                     (
                       obligation.attempt_count >= obligation.max_attempts
                       OR ${simJobs.requestPayload} ? 'continueFromResultAttemptId'
                       OR ${simJobs.requestPayload} ? 'continueFromResultId'
                     )
                     AND NOT (
                       jsonb_array_length(
                         ${simJobs.requestPayload} -> 'precalcObligationIds'
                       ) = 1
                       AND jsonb_typeof(${simJobs.bcIds}) = 'array'
                       AND jsonb_array_length(${simJobs.bcIds}) = 1
                       AND (
                         NULLIF(
                           ${simJobs.requestPayload} ->> 'continueFromResultAttemptId',
                           ''
                         ) IS NOT NULL
                         AND NULLIF(
                           ${simJobs.requestPayload} ->> 'continueFromResultId',
                           ''
                         ) IS NOT NULL
                       )
                       AND ${restartablePrecalcCheckpointSql(
                         sql`obligation.id`,
                         {
                           targetSolverImplementationId: sql`${simJobs.solverImplementationId}`,
                           targetBoundaryConditionId: sql`${simJobs.bcIds} ->> 0`,
                           continuationResultAttemptId: sql`${simJobs.requestPayload} ->> 'continueFromResultAttemptId'`,
                           continuationResultId: sql`${simJobs.requestPayload} ->> 'continueFromResultId'`,
                         },
                       )}
                     )
                   )
                   OR obligation.next_submit_at > now()
                   OR NOT (
                     obligation.background_owner
                     OR EXISTS (
                       SELECT 1
                       FROM sim_precalc_obligation_campaigns ownership
                       JOIN sim_campaigns owner_campaign
                         ON owner_campaign.id = ownership.campaign_id
                       WHERE ownership.obligation_id = obligation.id
                         AND ownership.state = 'active'
                         AND owner_campaign.status IN ('active', 'attention')
                     )
                     OR EXISTS (
                       SELECT 1
                       FROM sim_precalc_obligation_requests coverage
                       JOIN sim_urans_requests request_owner
                         ON request_owner.id = coverage.request_id
                       WHERE coverage.obligation_id = obligation.id
                         AND request_owner.background_owner
                         AND request_owner.state IN ('pending', 'running')
                     )
                     OR EXISTS (
                       SELECT 1
                       FROM sync_sweep_promises remote_promise
                       JOIN sync_sweep_promise_points promise_point
                         ON promise_point.promise_id = remote_promise.id
                        AND promise_point.status = 'active'
                        AND promise_point.airfoil_id = obligation.airfoil_id
                        AND promise_point.simulation_preset_revision_id = obligation.revision_id
                        AND promise_point.aoa_deg = obligation.aoa_deg
                       WHERE remote_promise.id::text = ${simJobs.requestPayload} ->> 'syncPromiseId'
                         AND remote_promise.status = 'active'
                         AND remote_promise."expiresAt" > now()
                         AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
                         AND remote_promise.source_base_url = ${simJobs.requestPayload} ->> 'upstreamBaseUrl'
                         AND ${simJobs.requestPayload} ->> 'remoteSolver' = 'true'
                     )
                   )
              )
              AND (
                NOT (${simJobs.requestPayload} ? 'conditionalPromotionId')
                OR EXISTS (
                  SELECT 1
                  FROM sim_rans_polar_promotions promotion
                  JOIN sim_jobs promotion_parent
                    ON promotion_parent.id = promotion.parent_job_id
                  WHERE promotion.id::text = ${simJobs.requestPayload} ->> 'conditionalPromotionId'
                    AND promotion_parent.id::text = ${simJobs.requestPayload} ->> 'parentJobId'
                    AND promotion.airfoil_id = ${simJobs.airfoilId}
                    AND promotion.revision_id = ${simJobs.simulationPresetRevisionId}
                    AND promotion.condition_id IS NOT DISTINCT FROM CASE
                      WHEN ${simJobs.requestPayload} ->> 'conditionId' IS NULL THEN NULL
                      ELSE (${simJobs.requestPayload} ->> 'conditionId')::uuid
                    END
                    AND (
                      (
                        promotion.owner_kind = 'sync_promise'
                        AND promotion.sync_promise_id::text = ${simJobs.requestPayload} ->> 'syncPromiseId'
                      )
                      OR (
                        promotion.owner_kind IN ('campaign', 'background')
                        AND NOT (${simJobs.requestPayload} ? 'syncPromiseId')
                      )
                    )
                    AND (
                      promotion_parent.status IN ('done', 'failed', 'cancelled')
                      OR (
                        promotion_parent.status = 'ingesting'
                        AND (
                          promotion_parent.ingest_lease_expires_at IS NULL
                          OR promotion_parent.ingest_lease_expires_at <= now()
                        )
                      )
                    )
                    AND NOT (
                      promotion_parent.status = 'cancelled'
                      AND promotion.owner_kind = 'background'
                    )
                    AND NOT EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements_text(
                        CASE
                          WHEN jsonb_typeof(${simJobs.requestPayload} -> 'precalcObligationIds') = 'array'
                          THEN ${simJobs.requestPayload} -> 'precalcObligationIds'
                          ELSE '[]'::jsonb
                        END
                      ) payload_event_obligation(id)
                      LEFT JOIN sim_precalc_obligations event_obligation
                        ON event_obligation.id::text = payload_event_obligation.id
                      WHERE event_obligation.id IS NULL
                         OR NOT EXISTS (
                           SELECT 1
                           FROM sim_rans_polar_promotion_points event_point
                           WHERE event_point.promotion_id = promotion.id
                             AND event_point.obligation_id = event_obligation.id
                             AND event_point.aoa_deg = event_obligation.aoa_deg
                             AND event_obligation.airfoil_id = promotion.airfoil_id
                             AND event_obligation.revision_id = promotion.revision_id
                         )
                         OR NOT (
                           (
                             promotion.owner_kind = 'background'
                             AND event_obligation.background_owner
                           )
                           OR (
                             promotion.owner_kind = 'campaign'
                             AND EXISTS (
                               SELECT 1
                               FROM sim_precalc_obligation_campaigns exact_ownership
                               JOIN sim_campaigns exact_campaign
                                 ON exact_campaign.id = exact_ownership.campaign_id
                                AND exact_campaign.status IN ('active', 'attention')
                               WHERE exact_ownership.obligation_id = event_obligation.id
                                 AND exact_ownership.campaign_id = promotion.campaign_id
                                 AND exact_ownership.state = 'active'
                             )
                           )
                           OR (
                             promotion.owner_kind = 'sync_promise'
                             AND EXISTS (
                               SELECT 1
                               FROM sync_sweep_promise_points exact_point
                               JOIN sync_sweep_promises exact_promise
                                 ON exact_promise.id = exact_point.promise_id
                                AND exact_promise.status = 'active'
                                AND exact_promise."expiresAt" > now()
                                AND exact_promise.request_payload ->> 'remoteSolver' = 'true'
                               WHERE exact_promise.id = promotion.sync_promise_id
                                 AND exact_point.status = 'active'
                                 AND exact_point.airfoil_id = event_obligation.airfoil_id
                                 AND exact_point.simulation_preset_revision_id = event_obligation.revision_id
                                 AND exact_point.aoa_deg = event_obligation.aoa_deg
                             )
                           )
                         )
                    )
                )
              )
            )
            WHEN ${simJobs.requestPayload} ? 'verifyQueueItemId' THEN EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue verify_item
              WHERE verify_item.id::text = ${simJobs.requestPayload} ->> 'verifyQueueItemId'
                AND verify_item.state = 'running'
                AND verify_item.sim_job_id = ${simJobs.id}
                AND NOT EXISTS (
                  SELECT 1 FROM sim_ladder_submit_retries submit_retry
                  WHERE submit_retry.verify_queue_id = verify_item.id
                    AND submit_retry.latest_sim_job_id IS DISTINCT FROM ${simJobs.id}
                )
                AND (
                  verify_item.background_owner
                  OR EXISTS (
                    SELECT 1
                    FROM sim_urans_verify_queue_campaigns ownership
                    JOIN sim_campaigns owner_campaign ON owner_campaign.id = ownership.campaign_id
                    WHERE ownership.queue_id = verify_item.id
                      AND ownership.state = 'active'
                      AND owner_campaign.status IN ('active', 'attention')
                  )
                  OR EXISTS (
                    SELECT 1
                    FROM sim_urans_verify_queue_requests coverage
                    JOIN sim_urans_requests request_item
                      ON request_item.id = coverage.request_id
                    WHERE coverage.queue_id = verify_item.id
                      AND request_item.fidelity = 'full'
                      AND request_item.state IN ('pending', 'running')
                      AND (
                        request_item.background_owner
                        OR EXISTS (
                          SELECT 1
                          FROM sim_urans_request_campaigns request_ownership
                          JOIN sim_campaigns owner_campaign
                            ON owner_campaign.id = request_ownership.campaign_id
                          WHERE request_ownership.request_id = request_item.id
                            AND request_ownership.state = 'active'
                            AND owner_campaign.status IN ('active', 'attention')
                        )
                      )
                  )
                )
            )
            WHEN ${simJobs.requestPayload} ? 'uransRequestId' THEN EXISTS (
              SELECT 1
              FROM sim_urans_requests request_item
              WHERE request_item.id::text = ${simJobs.requestPayload} ->> 'uransRequestId'
                AND request_item.state = 'running'
                AND (
                  request_item.fidelity <> 'full'
                  OR (
                    request_item.sim_job_id = ${simJobs.id}
                    AND NOT EXISTS (
                      SELECT 1 FROM sim_ladder_submit_retries submit_retry
                      WHERE submit_retry.urans_request_id = request_item.id
                        AND submit_retry.latest_sim_job_id IS DISTINCT FROM ${simJobs.id}
                    )
                  )
                )
                AND (
                  request_item.background_owner
                  OR EXISTS (
                    SELECT 1
                    FROM sim_urans_request_campaigns ownership
                    JOIN sim_campaigns owner_campaign ON owner_campaign.id = ownership.campaign_id
                    WHERE ownership.request_id = request_item.id
                      AND ownership.state = 'active'
                      AND owner_campaign.status IN ('active', 'attention')
                  )
                )
            )
            ELSE true
          END
          AND CASE
            WHEN ${simJobs.requestPayload} ? 'syncPromiseId' THEN EXISTS (
              SELECT 1
              FROM sync_sweep_promises remote_promise
              WHERE remote_promise.id::text = ${simJobs.requestPayload} ->> 'syncPromiseId'
                AND remote_promise.status = 'active'
                AND remote_promise."expiresAt" > now()
                AND remote_promise.request_payload ->> 'remoteSolver' = 'true'
                AND ${simJobs.requestPayload} ->> 'remoteSolver' = 'true'
                AND remote_promise.source_base_url = ${simJobs.requestPayload} ->> 'upstreamBaseUrl'
                AND remote_promise.airfoil_id = ${simJobs.airfoilId}
                AND remote_promise.simulation_preset_revision_id = ${simJobs.simulationPresetRevisionId}
                AND jsonb_typeof(${simJobs.requestPayload} -> 'aoas') = 'array'
                AND jsonb_array_length(${simJobs.requestPayload} -> 'aoas') > 0
                AND NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements_text(
                    CASE
                      WHEN jsonb_typeof(${simJobs.requestPayload} -> 'aoas') = 'array'
                      THEN ${simJobs.requestPayload} -> 'aoas'
                      ELSE '[]'::jsonb
                    END
                  ) payload_angle(value)
                  WHERE payload_angle.value !~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
                     OR NOT EXISTS (
                       SELECT 1
                       FROM sync_sweep_promise_points promise_point
                       WHERE promise_point.promise_id = remote_promise.id
                         AND promise_point.status = 'active'
                         AND promise_point.airfoil_id = ${simJobs.airfoilId}
                         AND promise_point.simulation_preset_revision_id = ${simJobs.simulationPresetRevisionId}
                         AND promise_point.aoa_deg = CASE
                           WHEN payload_angle.value ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
                           THEN payload_angle.value::double precision
                           ELSE NULL
                         END
                         AND (
                           EXISTS (
                             SELECT 1
                             FROM results claimed_result
                             WHERE claimed_result.airfoil_id = promise_point.airfoil_id
                               AND claimed_result.simulation_preset_revision_id = promise_point.simulation_preset_revision_id
                               AND claimed_result.aoa_deg = promise_point.aoa_deg
                               AND claimed_result.sim_job_id = ${simJobs.id}
                               AND claimed_result.status IN ('queued', 'running')
                           )
                           OR EXISTS (
                             SELECT 1
                             FROM sim_precalc_obligations obligation
                             JOIN LATERAL jsonb_array_elements_text(
                               CASE
                                 WHEN jsonb_typeof(${simJobs.requestPayload} -> 'precalcObligationIds') = 'array'
                                 THEN ${simJobs.requestPayload} -> 'precalcObligationIds'
                                 ELSE '[]'::jsonb
                               END
                             ) payload_obligation(id)
                               ON obligation.id::text = payload_obligation.id
                             WHERE obligation.airfoil_id = promise_point.airfoil_id
                               AND obligation.revision_id = promise_point.simulation_preset_revision_id
                               AND obligation.aoa_deg = promise_point.aoa_deg
                               AND obligation.latest_sim_job_id = ${simJobs.id}
                               AND obligation.state IN ('pending', 'running')
                           )
                         )
                     )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM jsonb_array_elements_text(
                    CASE
                      WHEN jsonb_typeof(${simJobs.requestPayload} -> 'precalcObligationIds') = 'array'
                      THEN ${simJobs.requestPayload} -> 'precalcObligationIds'
                      ELSE '[]'::jsonb
                    END
                  ) payload_obligation(id)
                  LEFT JOIN sim_precalc_obligations obligation
                    ON obligation.id::text = payload_obligation.id
                  WHERE obligation.id IS NULL
                     OR obligation.latest_sim_job_id IS DISTINCT FROM ${simJobs.id}
                     OR obligation.airfoil_id IS DISTINCT FROM ${simJobs.airfoilId}
                     OR obligation.revision_id IS DISTINCT FROM ${simJobs.simulationPresetRevisionId}
                     OR NOT EXISTS (
                       SELECT 1
                       FROM sync_sweep_promise_points promise_point
                       JOIN LATERAL jsonb_array_elements_text(
                         CASE
                           WHEN jsonb_typeof(${simJobs.requestPayload} -> 'aoas') = 'array'
                           THEN ${simJobs.requestPayload} -> 'aoas'
                           ELSE '[]'::jsonb
                         END
                       ) payload_angle(value)
                         ON obligation.aoa_deg = CASE
                           WHEN payload_angle.value ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
                           THEN payload_angle.value::double precision
                           ELSE NULL
                         END
                       WHERE promise_point.promise_id = remote_promise.id
                         AND promise_point.status = 'active'
                         AND promise_point.airfoil_id = obligation.airfoil_id
                         AND promise_point.simulation_preset_revision_id = obligation.revision_id
                         AND promise_point.aoa_deg = obligation.aoa_deg
                     )
                )
                AND NOT EXISTS (
                  SELECT 1
                  FROM results claimed_result
                  WHERE claimed_result.sim_job_id = ${simJobs.id}
                    AND claimed_result.status IN ('queued', 'running')
                    AND NOT EXISTS (
                      SELECT 1
                      FROM sync_sweep_promise_points promise_point
                      JOIN LATERAL jsonb_array_elements_text(
                        CASE
                          WHEN jsonb_typeof(${simJobs.requestPayload} -> 'aoas') = 'array'
                          THEN ${simJobs.requestPayload} -> 'aoas'
                          ELSE '[]'::jsonb
                        END
                      ) payload_angle(value)
                        ON promise_point.aoa_deg = CASE
                          WHEN payload_angle.value ~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$'
                          THEN payload_angle.value::double precision
                          ELSE NULL
                        END
                      WHERE promise_point.promise_id = remote_promise.id
                        AND promise_point.status = 'active'
                        AND promise_point.airfoil_id = claimed_result.airfoil_id
                        AND promise_point.simulation_preset_revision_id = claimed_result.simulation_preset_revision_id
                        AND promise_point.aoa_deg = claimed_result.aoa_deg
                    )
                )
            )
            ELSE true
          END`,
        ]),
  );
}

/** Serialize submit-boundary decisions with every campaign lifecycle row that
 * can currently authorize a shared ladder job. Campaign pause/cancel takes an
 * UPDATE lock on the same row first; after either waiter wins, the guarded
 * predicate below is re-evaluated against the committed ownership state. */
async function withSubmitLifecycleLocks<T>(
  db: DB,
  jobId: string,
  campaignId: string | null,
  work: (tx: DB) => Promise<T>,
): Promise<T> {
  return db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    if (campaignId) {
      await tx.execute(sql`
        SELECT campaign.id
        FROM sim_campaigns campaign
        WHERE campaign.id = ${campaignId}
        ORDER BY campaign.id
        FOR SHARE OF campaign
      `);
    } else {
      // A global job can be a shared automatic continuation or verification.
      // Lock every campaign that can authorize a physical precalc payload.
      await tx.execute(sql`
        SELECT campaign.id
        FROM sim_jobs job
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(job.request_payload -> 'precalcObligationIds') = 'array'
            THEN job.request_payload -> 'precalcObligationIds'
            ELSE '[]'::jsonb
          END
        ) payload_obligation(id)
        JOIN sim_precalc_obligation_campaigns ownership
          ON ownership.obligation_id::text = payload_obligation.id
         AND ownership.state = 'active'
        JOIN sim_campaigns campaign
          ON campaign.id = ownership.campaign_id
         AND campaign.status IN ('active', 'attention')
        WHERE job.id = ${jobId}
        ORDER BY campaign.id
        FOR SHARE OF campaign
      `);
      // Remote jobs are authorized by the mirrored upstream promise rather
      // than a campaign. Share-lock that lease at every submit boundary so a
      // concurrent cancellation cannot race the predicate and resurrect work.
      await tx.execute(sql`
        SELECT remote_promise.id
        FROM sim_jobs job
        JOIN sync_sweep_promises remote_promise
          ON remote_promise.id::text = job.request_payload ->> 'syncPromiseId'
        WHERE job.id = ${jobId}
        FOR SHARE OF remote_promise
      `);
      // A recorded-promotion child also depends on its exact parent lifecycle.
      // Owner rows (campaign/remote promise) are locked first, then the parent,
      // matching the physical composer and avoiding parent↔remote inversion.
      await tx.execute(sql`
        SELECT promotion_parent.id
        FROM sim_jobs job
        JOIN sim_rans_polar_promotions promotion
          ON promotion.id::text = job.request_payload ->> 'conditionalPromotionId'
        JOIN sim_jobs promotion_parent
          ON promotion_parent.id = promotion.parent_job_id
        WHERE job.id = ${jobId}
        FOR SHARE OF promotion_parent
      `);
      // Lock the other shared association shapes defensively; a job contains
      // at most one request/verify id.
      await tx.execute(sql`
        SELECT campaign.id
        FROM sim_jobs job
        JOIN sim_urans_request_campaigns ownership
          ON ownership.request_id::text = job.request_payload ->> 'uransRequestId'
         AND ownership.state = 'active'
        JOIN sim_campaigns campaign
          ON campaign.id = ownership.campaign_id
         AND campaign.status IN ('active', 'attention')
        WHERE job.id = ${jobId}
        ORDER BY campaign.id
        FOR SHARE OF campaign
      `);
      await tx.execute(sql`
        SELECT campaign.id
        FROM sim_jobs job
        JOIN sim_campaigns campaign
          ON campaign.id IN (
            SELECT ownership.campaign_id
            FROM sim_urans_verify_queue_campaigns ownership
            WHERE ownership.queue_id::text =
                  job.request_payload ->> 'verifyQueueItemId'
              AND ownership.state = 'active'
            UNION
            SELECT request_ownership.campaign_id
            FROM sim_urans_verify_queue_requests coverage
            JOIN sim_urans_requests request_item
              ON request_item.id = coverage.request_id
            JOIN sim_urans_request_campaigns request_ownership
              ON request_ownership.request_id = request_item.id
            WHERE coverage.queue_id::text =
                  job.request_payload ->> 'verifyQueueItemId'
              AND request_item.fidelity = 'full'
              AND request_item.state IN ('pending', 'running')
              AND request_ownership.state = 'active'
          )
         AND campaign.status IN ('active', 'attention')
        WHERE job.id = ${jobId}
        ORDER BY campaign.id
        FOR SHARE OF campaign
      `);
      await tx.execute(sql`
        SELECT request_item.id
        FROM sim_jobs job
        JOIN sim_urans_verify_queue_requests coverage
          ON coverage.queue_id::text =
             job.request_payload ->> 'verifyQueueItemId'
        JOIN sim_urans_requests request_item
          ON request_item.id = coverage.request_id
         AND request_item.fidelity = 'full'
         AND request_item.state IN ('pending', 'running')
        WHERE job.id = ${jobId}
        ORDER BY request_item.id
        FOR SHARE OF request_item
      `);
    }
    return work(tx);
  });
}

type GlobalAdmissionSubmitResult =
  | { kind: "submitted"; status: JobStatus }
  | { kind: "denied"; error: string }
  | { kind: "engine_error"; error: unknown }
  | { kind: "check_failed"; error: string }
  | {
      kind: "accepted_gate_commit_failed";
      status: JobStatus;
      error: string;
    };

/** Last-moment global admission boundary shared by every local, ladder and
 * remote submit path. The singleton row lock is held until the bounded engine
 * acceptance call answers. Hazard-transition triggers take that same lock, so
 * either the engine acceptance is ordered first (and may continue) or the
 * durable hazard is ordered first (and the engine is never called).
 *
 * Engine exceptions are returned untouched for the existing submit-failure
 * policy. If the engine accepted but the permit transaction itself could not
 * commit, retain the exact engine id for compensating cancellation. */
async function submitWithGlobalAdmissionPermit(
  db: DB,
  jobId: string,
  admissionLane: SubmissionAdmissionLane | undefined,
  submit: () => Promise<JobStatus>,
): Promise<GlobalAdmissionSubmitResult> {
  let acceptedStatus: JobStatus | null = null;
  try {
    return await db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as DB;
      const [scheduler] = (await tx.execute(sql`
        SELECT id, enabled, max_concurrent_jobs, cpu_slots
        FROM sweeper_state
        WHERE id = 1
        FOR UPDATE /* submit lifecycle global admission permit */
      `)) as unknown as Array<{
        id: number;
        enabled: boolean;
        max_concurrent_jobs: number;
        cpu_slots: number;
      }>;
      if (!scheduler) {
        return {
          kind: "denied" as const,
          error: "global scheduler admission state is unavailable",
        };
      }
      let jobLane: { remote_solver: string | null } | undefined;
      if (!admissionLane) {
        [jobLane] = (await tx.execute(sql`
          SELECT request_payload ->> 'remoteSolver' AS remote_solver
          FROM sim_jobs
          WHERE id = ${jobId}
          LIMIT 1
        `)) as unknown as Array<{ remote_solver: string | null }>;
      }
      // Legacy/internal callers are classified from immutable job provenance;
      // an absent or malformed marker is always local/fail-closed. Explicit
      // source-lane declarations remain preferable at the primary call sites.
      const effectiveAdmissionLane =
        admissionLane ??
        (jobLane?.remote_solver === "true" ? "remote" : "local");
      if (effectiveAdmissionLane === "local" && !scheduler.enabled) {
        return {
          kind: "denied" as const,
          error: "global scheduler is paused",
        };
      }
      if (
        effectiveAdmissionLane === "operator_canary" &&
        (scheduler.enabled ||
          Number(scheduler.max_concurrent_jobs) !== 0 ||
          Number(scheduler.cpu_slots) !== 0)
      ) {
        return {
          kind: "denied" as const,
          error:
            "operator canary requires a paused scheduler with zero durable capacity",
        };
      }
      if (effectiveAdmissionLane === "remote" && scheduler.enabled) {
        const configuredMax = Number(scheduler.max_concurrent_jobs);
        const cpuSlots = Number(scheduler.cpu_slots);
        const workerBudget = Number(
          process.env.AIRFOILFOAM_WORKER_CPU_BUDGET ?? 2,
        );
        const sharedCapacity =
          Number.isInteger(configuredMax) && configuredMax > 0
            ? configuredMax
            : Number.isInteger(cpuSlots) && cpuSlots > 0
              ? cpuSlots
              : Number.isInteger(workerBudget) && workerBudget > 0
                ? workerBudget
                : 2;
        const [pressure] = (await tx.execute(sql`
          SELECT count(*)::integer AS count
          FROM sim_jobs job
          WHERE job.id <> ${jobId}
            AND (
              job.status IN ('submitted', 'running', 'ingesting')
              OR (
                job.status = 'pending'
                AND job.engine_state = ${SUBMITTING_ENGINE_STATE}
              )
            )
        `)) as unknown as Array<{ count: number }>;
        const reservedSlots = Number(pressure?.count ?? 0);
        if (reservedSlots >= sharedCapacity) {
          return {
            kind: "denied" as const,
            error: `shared scheduler capacity is full (${reservedSlots}/${sharedCapacity})`,
          };
        }
      }
      const fence = await enforceSweeperAdmissionFence(tx);
      if (fence.active || fence.hazardPresent) {
        return {
          kind: "denied" as const,
          error: `global admission safety stop (${fence.trigger?.reason ?? "latched critical solver outcome"})`,
        };
      }
      try {
        acceptedStatus = await submit();
        return { kind: "submitted" as const, status: acceptedStatus };
      } catch (error) {
        return { kind: "engine_error" as const, error };
      }
    });
  } catch (error) {
    const message = errorMessage(error);
    if (acceptedStatus) {
      return {
        kind: "accepted_gate_commit_failed",
        status: acceptedStatus,
        error: `global admission transaction failed after engine acceptance: ${message}`,
      };
    }
    console.error(
      "[sweeper] submit-boundary admission check failed; holding engine submission:",
      error,
    );
    return {
      kind: "check_failed",
      error: `global admission safety check unavailable: ${message}`,
    };
  }
}

async function stopBeforeEngineSubmit(
  db: DB,
  jobId: string,
  reason: string,
  ownedState: "unclaimed" | "submitting",
): Promise<void> {
  await db.transaction(async (tx) => {
    const [stopped] = await tx
      .update(simJobs)
      .set({
        status: "cancelled",
        engineState: "cancelled",
        error: reason,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(simJobs.id, jobId),
          eq(simJobs.status, "pending"),
          ownedState === "submitting"
            ? eq(simJobs.engineState, SUBMITTING_ENGINE_STATE)
            : isNull(simJobs.engineState),
        ),
      )
      .returning({ id: simJobs.id });
    if (!stopped) return;
    await tx
      .update(results)
      .set({
        status: releasedResultStatusSql(jobId),
        source: "queued",
        simJobId: null,
        engineJobId: null,
        engineCaseSlug: null,
      })
      .where(
        and(
          eq(results.simJobId, jobId),
          inArray(results.status, ["queued", "running"]),
        ),
      );
  });
}

/** Persist a compensating-cancel obligation before calling the engine cancel.
 *
 * Once this DB write succeeds, a later process death leaves the accepted
 * engine id addressable for the terminal-engine-task reconciler. The narrower
 * submitPolar-return → DB-write gap still needs future client-addressed or
 * idempotent engine submission; this helper does not claim to close it. */
async function recordAcceptedButStopped(
  db: DB,
  jobId: string,
  engineJobId: string,
  reason: string,
): Promise<void> {
  const settlement = await db.transaction(async (rawTx) => {
    const tx = rawTx as unknown as DB;
    // First try to win pending→cancelled. Only that winner owns and may release
    // the job's result claims. A concurrent submitter that already moved the
    // job to submitted must keep its claims intact.
    const [stopped] = await tx
      .update(simJobs)
      .set({
        status: "cancelled",
        engineJobId,
        engineState: "cancelling",
        error: reason,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(simJobs.id, jobId),
          eq(simJobs.status, "pending"),
          eq(simJobs.engineState, SUBMITTING_ENGINE_STATE),
          or(isNull(simJobs.engineJobId), eq(simJobs.engineJobId, engineJobId)),
        ),
      )
      .returning();
    if (stopped) {
      await tx
        .update(results)
        .set({
          status: releasedResultStatusSql(jobId),
          source: "queued",
          simJobId: null,
          engineJobId: null,
          engineCaseSlug: null,
        })
        .where(
          and(
            eq(results.simJobId, jobId),
            inArray(results.status, ["queued", "running"]),
          ),
        );
      return settlePrecalcObligationsForJobInTransaction(tx, stopped, {
        terminalError: reason,
        cancellation: "explicit",
      });
    }

    // Pause/cancel may already have won and released the claims. Attach the
    // accepted id to that terminal row so compensation remains retryable, but
    // never touch claims when this helper did not win their ownership.
    const [alreadyStopped] = await tx
      .update(simJobs)
      .set({
        engineJobId,
        engineState: "cancelling",
        error: reason,
      })
      .where(
        and(
          eq(simJobs.id, jobId),
          eq(simJobs.status, "cancelled"),
          or(isNull(simJobs.engineJobId), eq(simJobs.engineJobId, engineJobId)),
        ),
      )
      .returning();
    if (!alreadyStopped) return null;
    return settlePrecalcObligationsForJobInTransaction(tx, alreadyStopped, {
      terminalError: reason,
      cancellation: "explicit",
    });
  });
  if (settlement)
    await refreshPrecalcSettlementCampaigns(db, settlement.campaignIds);
}

/** Persist and execute compensation for an engine task which answered after
 * its owning lifecycle stopped. The durable engine id is written before the
 * cancel call so reconciliation can finish compensation after a process
 * interruption or a failed cancel response. */
async function compensateAcceptedEngineTask(
  db: DB,
  engine: EngineClient,
  jobId: string,
  engineJobId: string,
  reason: string,
): Promise<GuardedSubmitOutcome> {
  await recordAcceptedButStopped(db, jobId, engineJobId, reason);

  let engineCancelError: string | null = null;
  try {
    await engine.cancelJob(engineJobId);
  } catch (error) {
    engineCancelError = errorMessage(error);
  }
  await db
    .update(simJobs)
    .set({
      engineState: engineCancelError ? "cancel_pending" : "cancelled",
      error: engineCancelError
        ? `${reason}; compensating engine cancellation failed: ${engineCancelError}`
        : `${reason}; compensating engine cancellation confirmed`,
    })
    .where(
      and(
        eq(simJobs.id, jobId),
        eq(simJobs.status, "cancelled"),
        eq(simJobs.engineJobId, engineJobId),
      ),
    );
  return {
    kind: "lifecycle_stopped",
    error: reason,
    acceptedEngineJobId: engineJobId,
    engineCancelError,
  };
}

function ladderRetryWhere(owner: LadderSubmitOwner) {
  return owner.uransRequestId
    ? eq(simLadderSubmitRetries.uransRequestId, owner.uransRequestId)
    : eq(simLadderSubmitRetries.verifyQueueId, owner.verifyQueueId!);
}

async function clearLadderSubmitRetryInTransaction(
  tx: DB,
  owner: LadderSubmitOwner,
  jobId: string,
): Promise<void> {
  await tx
    .delete(simLadderSubmitRetries)
    .where(
      and(
        ladderRetryWhere(owner),
        or(
          isNull(simLadderSubmitRetries.latestSimJobId),
          eq(simLadderSubmitRetries.latestSimJobId, jobId),
        ),
      ),
    );
}

/** Return one full-fidelity owner to its truthful post-transport state. A live
 * or paused beneficiary preserves pending work; a terminal owner cannot be
 * resurrected. Existing answered-5xx budget remains unchanged. */
async function releaseLadderOwnerAfterTransportFailure(
  tx: DB,
  owner: LadderSubmitOwner,
  jobId: string,
  error: string,
): Promise<void> {
  if (owner.uransRequestId) {
    await tx.execute(sql`
      UPDATE sim_urans_requests request_item
      SET state = CASE
            WHEN request_item.background_owner THEN 'pending'
            WHEN EXISTS (
              SELECT 1
              FROM sim_urans_request_campaigns ownership
              JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
              WHERE ownership.request_id = request_item.id
                AND ownership.state = 'active'
                AND campaign.status IN ('active', 'attention', 'paused')
            ) THEN 'pending'
            ELSE 'cancelled'
          END,
          sim_job_id = NULL,
          "updatedAt" = now()
      WHERE request_item.id = ${owner.uransRequestId}
        AND request_item.fidelity = 'full'
        AND request_item.state = 'running'
        AND request_item.sim_job_id = ${jobId}
    `);
  } else {
    await tx.execute(sql`
      UPDATE sim_urans_verify_queue verify_item
      SET state = CASE
            WHEN verify_item.background_owner THEN 'pending'
            WHEN EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_campaigns ownership
              JOIN sim_campaigns campaign ON campaign.id = ownership.campaign_id
              WHERE ownership.queue_id = verify_item.id
                AND ownership.state = 'active'
                AND campaign.status IN ('active', 'attention', 'paused')
            ) THEN 'pending'
            WHEN EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_requests coverage
              JOIN sim_urans_requests request_item
                ON request_item.id = coverage.request_id
              WHERE coverage.queue_id = verify_item.id
                AND request_item.fidelity = 'full'
                AND request_item.state IN ('pending', 'running')
                AND (
                  request_item.background_owner
                  OR EXISTS (
                    SELECT 1
                    FROM sim_urans_request_campaigns request_ownership
                    JOIN sim_campaigns campaign
                      ON campaign.id = request_ownership.campaign_id
                    WHERE request_ownership.request_id = request_item.id
                      AND request_ownership.state = 'active'
                      AND campaign.status IN (
                        'active', 'attention', 'paused'
                      )
                  )
                )
            ) THEN 'pending'
            ELSE 'cancelled'
          END,
          sim_job_id = NULL,
          "updatedAt" = now()
      WHERE verify_item.id = ${owner.verifyQueueId}
        AND verify_item.state = 'running'
        AND verify_item.sim_job_id = ${jobId}
        AND NOT EXISTS (
          SELECT 1 FROM sim_ladder_submit_retries submit_retry
          WHERE submit_retry.verify_queue_id = verify_item.id
            AND submit_retry.latest_sim_job_id IS DISTINCT FROM ${jobId}
        )
    `);
    await refreshFullUransRequestsForVerifyQueueInTransaction(
      tx,
      owner.verifyQueueId!,
    );
  }
  // A transport failure consumes no answered-submit allowance. If this is a
  // retry after an earlier 5xx, retain its state/count/due boundary while
  // pointing the operational audit at the newest failed composition.
  await tx
    .update(simLadderSubmitRetries)
    .set({
      latestSimJobId: jobId,
      lastHttpStatus: null,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(
      and(
        ladderRetryWhere(owner),
        or(
          isNull(simLadderSubmitRetries.latestSimJobId),
          eq(simLadderSubmitRetries.latestSimJobId, jobId),
        ),
      ),
    );
}

/** Atomically settle an answered full-ladder submit failure with its physical
 * owner. First 5xx = one delayed retry; second 5xx or any other answered
 * rejection = terminal blocked. No results/attempt rows are involved. */
async function settleAnsweredLadderFailureInTransaction(
  tx: DB,
  owner: LadderSubmitOwner,
  jobId: string,
  error: string,
  httpStatus: number | null,
): Promise<"retry_wait" | "blocked" | null> {
  const ownerId = ladderOwnerId(owner);
  const [owned] = owner.uransRequestId
    ? ((await tx.execute(sql`
        SELECT request_item.id
        FROM sim_urans_requests request_item
        JOIN sim_jobs job ON job.id = ${jobId}
        WHERE request_item.id = ${owner.uransRequestId}
          AND request_item.fidelity = 'full'
          AND request_item.state = 'running'
          AND request_item.sim_job_id = job.id
          AND job.request_payload ->> 'uransRequestId' = request_item.id::text
        FOR UPDATE OF request_item
      `)) as unknown as Array<{ id: string }>)
    : ((await tx.execute(sql`
        SELECT verify_item.id
        FROM sim_urans_verify_queue verify_item
        JOIN sim_jobs job ON job.id = ${jobId}
        WHERE verify_item.id = ${owner.verifyQueueId}
          AND verify_item.state = 'running'
          AND verify_item.sim_job_id = job.id
          AND job.request_payload ->> 'verifyQueueItemId' = verify_item.id::text
        FOR UPDATE OF verify_item
      `)) as unknown as Array<{ id: string }>);
  if (!owned || owned.id !== ownerId) return null;

  const [existing] = await tx
    .select({
      attemptCount: simLadderSubmitRetries.attemptCount,
      latestSimJobId: simLadderSubmitRetries.latestSimJobId,
    })
    .from(simLadderSubmitRetries)
    .where(ladderRetryWhere(owner))
    .for("update")
    .limit(1);
  if (existing?.latestSimJobId && existing.latestSimJobId !== jobId)
    return null;
  const retryable5xx =
    httpStatus !== null && httpStatus >= 500 && httpStatus < 600;
  const priorCount = Number(existing?.attemptCount ?? 0);
  const disposition: "retry_wait" | "blocked" =
    retryable5xx && priorCount < 1 ? "retry_wait" : "blocked";
  const attemptCount = disposition === "retry_wait" ? 1 : priorCount;
  const nextAttemptAt =
    disposition === "retry_wait"
      ? new Date(Date.now() + ANSWERED_SERVER_RETRY_BACKOFF_MS).toISOString()
      : null;

  if (owner.uransRequestId) {
    await tx.execute(sql`
      INSERT INTO sim_ladder_submit_retries (
        urans_request_id, verify_queue_id, state, attempt_count,
        next_attempt_at, latest_sim_job_id, last_http_status, last_error
      ) VALUES (
        ${owner.uransRequestId}, NULL, ${disposition}, ${attemptCount},
        ${nextAttemptAt}, ${jobId}, ${httpStatus}, ${error}
      )
      ON CONFLICT (urans_request_id) WHERE urans_request_id IS NOT NULL
      DO UPDATE SET
        state = EXCLUDED.state,
        attempt_count = EXCLUDED.attempt_count,
        next_attempt_at = EXCLUDED.next_attempt_at,
        latest_sim_job_id = EXCLUDED.latest_sim_job_id,
        last_http_status = EXCLUDED.last_http_status,
        last_error = EXCLUDED.last_error,
        "updatedAt" = now()
    `);
    await tx
      .update(simUransRequests)
      .set({
        state: disposition === "retry_wait" ? "pending" : "blocked",
        simJobId: disposition === "retry_wait" ? null : jobId,
      })
      .where(
        and(
          eq(simUransRequests.id, owner.uransRequestId),
          eq(simUransRequests.state, "running"),
          eq(simUransRequests.fidelity, "full"),
        ),
      );
  } else {
    await tx.execute(sql`
      INSERT INTO sim_ladder_submit_retries (
        urans_request_id, verify_queue_id, state, attempt_count,
        next_attempt_at, latest_sim_job_id, last_http_status, last_error
      ) VALUES (
        NULL, ${owner.verifyQueueId}, ${disposition}, ${attemptCount},
        ${nextAttemptAt}, ${jobId}, ${httpStatus}, ${error}
      )
      ON CONFLICT (verify_queue_id) WHERE verify_queue_id IS NOT NULL
      DO UPDATE SET
        state = EXCLUDED.state,
        attempt_count = EXCLUDED.attempt_count,
        next_attempt_at = EXCLUDED.next_attempt_at,
        latest_sim_job_id = EXCLUDED.latest_sim_job_id,
        last_http_status = EXCLUDED.last_http_status,
        last_error = EXCLUDED.last_error,
        "updatedAt" = now()
    `);
    await tx
      .update(simUransVerifyQueue)
      .set({
        state: disposition === "retry_wait" ? "pending" : "blocked",
        simJobId: null,
      })
      .where(
        and(
          eq(simUransVerifyQueue.id, owner.verifyQueueId!),
          eq(simUransVerifyQueue.state, "running"),
          eq(simUransVerifyQueue.simJobId, jobId),
        ),
      );
    await refreshFullUransRequestsForVerifyQueueInTransaction(
      tx,
      owner.verifyQueueId!,
    );
  }
  return disposition;
}

/** A transport failure or a structured rolling-cutover capability mismatch
 * proves that this composition did not begin CFD execution. Release its claims
 * without consuming an engine-submit or PRECALC execution attempt. Connection
 * callers separately set global backoff; a capability mismatch is re-probed on
 * the next scheduler tick. */
async function recordUnexecutedTransientSubmitFailure(
  db: DB,
  jobId: string,
  error: string,
  campaignId: string | null,
  ladderOwner?: LadderSubmitOwner,
): Promise<void> {
  await withSubmitLifecycleLocks(db, jobId, campaignId, async (tx) => {
    const [stopped] = await tx
      .update(simJobs)
      .set({
        status: "cancelled",
        engineState: "cancelled",
        error,
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(simJobs.id, jobId),
          eq(simJobs.status, "pending"),
          eq(simJobs.engineState, SUBMITTING_ENGINE_STATE),
        ),
      )
      .returning({ id: simJobs.id });
    if (!stopped) return;
    if (ladderOwner) {
      await releaseLadderOwnerAfterTransportFailure(
        tx,
        ladderOwner,
        jobId,
        error,
      );
    }
    await tx
      .update(results)
      .set({
        status: releasedResultStatusSql(jobId),
        source: "queued",
        simJobId: null,
        engineJobId: null,
        engineCaseSlug: null,
      })
      .where(
        and(
          eq(results.simJobId, jobId),
          inArray(results.status, ["queued", "running"]),
        ),
      );
  });
}

interface SubmitFailureCell {
  id: string;
  airfoilId: string;
  revisionId: string | null;
  aoaDeg: number;
  attemptCount: number;
  solverImplementationId: string;
  wave: number;
  uransFidelity: string | null;
  hasExactPrecalcObligation: boolean;
}

/** An answered HTTP failure is not evidence that OpenFOAM ran. The retained
 * results rows remain execution/cell records only: deterministic 4xx (and
 * unknown answered rejections) terminalize them as failed/blocked with no
 * attempt or coefficient rows; a 5xx gets exactly one database-gated retry.
 * Result state, campaign terminal-linking, progress, and completion probing
 * commit as one transaction so no requested+failed orphan is observable. */
async function recordAnsweredSubmitFailure(
  db: DB,
  jobId: string,
  error: string,
  httpStatus: number | null,
  precalcObligationIds: string[],
  campaignId: string | null,
  ladderOwner?: LadderSubmitOwner,
): Promise<{
  retryScheduled: number;
  blocked: number;
  ladderDisposition: "retry_wait" | "blocked" | null;
}> {
  const retryableServerError =
    httpStatus !== null && httpStatus >= 500 && httpStatus < 600;
  const retryAfter = new Date(Date.now() + ANSWERED_SERVER_RETRY_BACKOFF_MS);
  const settled = await withSubmitLifecycleLocks(
    db,
    jobId,
    campaignId,
    async (tx) => {
      const [stopped] = await tx
        .update(simJobs)
        .set({
          status: "failed",
          engineState: "failed",
          error,
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(simJobs.id, jobId),
            eq(simJobs.status, "pending"),
            eq(simJobs.engineState, SUBMITTING_ENGINE_STATE),
          ),
        )
        .returning({
          id: simJobs.id,
          requestPayload: simJobs.requestPayload,
        });
      if (!stopped)
        return {
          retryScheduled: 0,
          blocked: 0,
          ladderDisposition: null,
          campaignIds: [] as string[],
        };

      const ladderDisposition = ladderOwner
        ? await settleAnsweredLadderFailureInTransaction(
            tx,
            ladderOwner,
            jobId,
            error,
            httpStatus,
          )
        : null;

      const precalcSettlement =
        await recordPrecalcObligationSubmitFailureInTransaction(
          tx,
          jobId,
          precalcObligationIds,
          error,
          httpStatus,
        );
      const requestId =
        stopped.requestPayload &&
        typeof stopped.requestPayload === "object" &&
        typeof (stopped.requestPayload as { uransRequestId?: unknown })
          .uransRequestId === "string"
          ? (stopped.requestPayload as { uransRequestId: string })
              .uransRequestId
          : null;
      if (requestId) {
        await refreshFullUransRequestStateInTransaction(tx, requestId);
      }

      const claimedRows = (await tx.execute(sql`
      SELECT r.id, r.airfoil_id, r.simulation_preset_revision_id,
             r.aoa_deg::float8 AS aoa_deg,
             COALESCE(retry.attempt_count, 0)::int AS attempt_count,
             COALESCE(
               r.solver_implementation_id,
               revision.solver_implementation_id,
               job.solver_implementation_id,
               ${LEGACY_UNKNOWN_SOLVER_IMPLEMENTATION_ID}::uuid
             ) AS solver_implementation_id,
             job.wave,
             job.request_payload ->> 'uransFidelity' AS urans_fidelity,
             EXISTS (
               SELECT 1
               FROM sim_precalc_obligations obligation
               WHERE obligation.airfoil_id = r.airfoil_id
                 AND obligation.revision_id = r.simulation_preset_revision_id
                 AND obligation.aoa_deg = r.aoa_deg
                 AND (
                   obligation.state <> 'cancelled'
                   OR obligation.attempt_count > 0
                 )
             ) AS has_exact_precalc_obligation
      FROM results r
      JOIN sim_jobs job ON job.id = r.sim_job_id
      LEFT JOIN simulation_preset_revisions revision
        ON revision.id = r.simulation_preset_revision_id
      LEFT JOIN sim_result_submit_retries retry ON retry.result_id = r.id
      WHERE r.sim_job_id = ${jobId}
        AND r.status IN ('queued', 'running')
      ORDER BY r.id
      FOR UPDATE OF r
    `)) as unknown as Array<{
        id: string;
        airfoil_id: string;
        simulation_preset_revision_id: string | null;
        aoa_deg: number;
        attempt_count: number;
        solver_implementation_id: string;
        wave: number;
        urans_fidelity: string | null;
        has_exact_precalc_obligation: boolean;
      }>;
      const cells: SubmitFailureCell[] = claimedRows.map((row) => ({
        id: row.id,
        airfoilId: row.airfoil_id,
        revisionId: row.simulation_preset_revision_id,
        aoaDeg: Number(row.aoa_deg),
        attemptCount: Number(row.attempt_count),
        solverImplementationId: row.solver_implementation_id,
        wave: Number(row.wave),
        uransFidelity: row.urans_fidelity,
        hasExactPrecalcObligation: row.has_exact_precalc_obligation,
      }));
      const retryRows = retryableServerError
        ? cells.filter((row) => row.attemptCount === 0)
        : [];
      const blockedRows = retryableServerError
        ? cells.filter((row) => row.attemptCount >= 1)
        : cells;

      if (retryRows.length) {
        await tx
          .update(results)
          .set({
            status: "pending",
            source: "queued",
            simJobId: null,
            engineJobId: null,
            engineCaseSlug: null,
            error,
          })
          .where(
            inArray(
              results.id,
              retryRows.map((row) => row.id),
            ),
          );
        await tx
          .insert(simResultSubmitRetries)
          .values(
            retryRows.map((row) => ({
              resultId: row.id,
              state: "retry_wait",
              attemptCount: 1,
              nextAttemptAt: retryAfter,
              lastHttpStatus: httpStatus,
              lastError: error,
            })),
          )
          .onConflictDoUpdate({
            target: simResultSubmitRetries.resultId,
            set: {
              state: "retry_wait",
              attemptCount: 1,
              nextAttemptAt: retryAfter,
              lastHttpStatus: httpStatus,
              lastError: error,
            },
          });
      }
      if (blockedRows.length) {
        await tx
          .update(results)
          .set({
            status: "failed",
            source: "queued",
            error,
          })
          .where(
            inArray(
              results.id,
              blockedRows.map((row) => row.id),
            ),
          );
        for (const row of blockedRows) {
          await tx
            .insert(simResultSubmitRetries)
            .values({
              resultId: row.id,
              state: "blocked",
              attemptCount: row.attemptCount >= 1 ? 1 : 0,
              nextAttemptAt: null,
              lastHttpStatus: httpStatus,
              lastError: error,
            })
            .onConflictDoUpdate({
              target: simResultSubmitRetries.resultId,
              set: {
                state: "blocked",
                attemptCount: row.attemptCount >= 1 ? 1 : 0,
                nextAttemptAt: null,
                lastHttpStatus: httpStatus,
                lastError: error,
              },
            });
        }
      }

      for (const row of retryRows) {
        await onResultIngested(tx, {
          airfoilId: row.airfoilId,
          revisionId: row.revisionId,
          aoaDeg: row.aoaDeg,
          resultId: row.id,
          status: "pending",
        });
      }
      for (const row of blockedRows) {
        await onResultIngested(tx, {
          airfoilId: row.airfoilId,
          revisionId: row.revisionId,
          aoaDeg: row.aoaDeg,
          resultId: row.id,
          status: "failed",
        });
      }
      if (!ladderOwner && precalcObligationIds.length === 0) {
        for (const row of blockedRows.filter(
          (cell) =>
            cell.wave === 1 &&
            cell.uransFidelity !== "precalc" &&
            cell.uransFidelity !== "full" &&
            !cell.hasExactPrecalcObligation,
        )) {
          await recordSolverIncidentInTransaction(tx, {
            stage: "rans",
            reason: "engine-submit-rejected",
            severity: "critical",
            owner: { resultId: row.id },
            solverImplementationId: row.solverImplementationId,
            occurrenceKey: `rans:${row.id}:${jobId}:engine-submit-blocked`,
            remediationVersion: RANS_RECOVERY_REMEDIATION_VERSION,
            simJobId: jobId,
            metadata: {
              airfoilId: row.airfoilId,
              revisionId: row.revisionId,
              aoaDeg: row.aoaDeg,
              error,
              httpStatus,
              recovery: "engine-submit-blocked",
            },
          });
        }
      }
      return {
        retryScheduled: retryRows.length,
        blocked: blockedRows.length,
        ladderDisposition,
        campaignIds: precalcSettlement.campaignIds,
      };
    },
  );
  for (const campaignId of settled.campaignIds) {
    await recomputeProgressForCampaign(db, campaignId);
    await probeCampaignCompletion(db, campaignId);
  }
  return settled;
}

/** Submit one already-composed pending job with a lifecycle-safe boundary.
 *
 * A campaign must be live both immediately before the external call and when
 * the accepted engine id is durably stamped. If pause/cancel wins either race,
 * the DB claim is released and an accepted engine task is compensating-
 * cancelled, with its id persisted before that cancel so later reconciliation
 * can retry the compensation. */
export async function submitPendingJobWithLifecycleGuard(opts: {
  db: DB;
  engine: EngineClient;
  jobId: string;
  admissionLane?: SubmissionAdmissionLane;
  campaignId?: string | null;
  request: PolarRequest;
  connectionErrorPrefix: string;
  submitErrorPrefix: string;
  /** Physical preliminary cells whose answered-submit policy must commit in
   * the same transaction as the failed sim_job. */
  precalcObligationIds?: string[];
  /** Full-fidelity request/verification owner whose retry/block transition
   * must commit atomically with the sim_job submit boundary. */
  ladderSubmitOwner?: LadderSubmitOwner;
}): Promise<GuardedSubmitOutcome> {
  const campaignId = opts.campaignId ?? null;
  if (opts.precalcObligationIds?.length && opts.ladderSubmitOwner) {
    throw new Error(
      "a submit cannot use both precalc-obligation and full-ladder retry ledgers",
    );
  }
  // Existing `engine_state` + `updatedAt` form a bounded pre-submit lease.
  // This conditional write happens BEFORE the external call; only its winner
  // may call submitPolar. The 60 s engine timeout is well inside the orphan
  // healer's five-minute stale threshold.
  const [claimed] = await withSubmitLifecycleLocks(
    opts.db,
    opts.jobId,
    campaignId,
    (tx) =>
      tx
        .update(simJobs)
        .set({
          engineState: SUBMITTING_ENGINE_STATE,
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            pendingSubmitWhere(opts.jobId, campaignId),
            isNull(simJobs.engineState),
          ),
        )
        .returning({ id: simJobs.id }),
  );
  if (!claimed) {
    const [current] = await opts.db
      .select({ status: simJobs.status, engineState: simJobs.engineState })
      .from(simJobs)
      .where(eq(simJobs.id, opts.jobId))
      .limit(1);
    if (
      current?.status === "pending" &&
      current.engineState === SUBMITTING_ENGINE_STATE
    ) {
      return { kind: "submission_in_progress" };
    }
    const reason = campaignId
      ? "campaign paused or cancelled before engine submission"
      : "job was no longer pending before engine submission";
    await stopBeforeEngineSubmit(opts.db, opts.jobId, reason, "unclaimed");
    return {
      kind: "lifecycle_stopped",
      error: reason,
      acceptedEngineJobId: null,
      engineCancelError: null,
    };
  }

  // Recheck immediately before the external side effect. Pause/cancel may
  // have committed after the lease was acquired; in that case only the owned
  // pending composition is settled and the engine is never called.
  const [ready] = await withSubmitLifecycleLocks(
    opts.db,
    opts.jobId,
    campaignId,
    (tx) =>
      tx
        .select({ id: simJobs.id })
        .from(simJobs)
        .where(
          and(
            pendingSubmitWhere(opts.jobId, campaignId),
            eq(simJobs.engineState, SUBMITTING_ENGINE_STATE),
          ),
        )
        .limit(1),
  );
  if (!ready) {
    const reason = campaignId
      ? "campaign paused or cancelled before engine submission"
      : "job was no longer pending before engine submission";
    await stopBeforeEngineSubmit(opts.db, opts.jobId, reason, "submitting");
    return {
      kind: "lifecycle_stopped",
      error: reason,
      acceptedEngineJobId: null,
      engineCancelError: null,
    };
  }

  // The tick-level checks keep ordinary scheduling cheap, but a critical
  // outcome can commit after those checks while a composed job is passing its
  // lifecycle guards. Every local and remote path converges here. Keep the
  // singleton lock through the bounded engine acceptance call so a terminal
  // writer cannot commit inside the former permit→submit gap.
  const admission = await submitWithGlobalAdmissionPermit(
    opts.db,
    opts.jobId,
    opts.admissionLane,
    () => opts.engine.submitPolar(opts.request),
  );
  if (admission.kind === "denied" || admission.kind === "check_failed") {
    const reason = `${admission.error} before engine submission`;
    await stopBeforeEngineSubmit(opts.db, opts.jobId, reason, "submitting");
    return {
      kind: "lifecycle_stopped",
      error: reason,
      acceptedEngineJobId: null,
      engineCancelError: null,
    };
  }
  if (admission.kind === "accepted_gate_commit_failed") {
    const reason = `${admission.error}; accepted engine task ${admission.status.job_id} did not cross the durable admission boundary`;
    return compensateAcceptedEngineTask(
      opts.db,
      opts.engine,
      opts.jobId,
      admission.status.job_id,
      reason,
    );
  }

  let status: JobStatus;
  try {
    if (admission.kind === "engine_error") throw admission.error;
    status = admission.status;
    await persistEngineRuntimeForJob(opts.db, opts.jobId, status.engine);
  } catch (error) {
    const message = errorMessage(error);
    if (isEngineConnectionFailure(error)) {
      await recordUnexecutedTransientSubmitFailure(
        opts.db,
        opts.jobId,
        opts.connectionErrorPrefix + message,
        campaignId,
        opts.ladderSubmitOwner,
      );
      return { kind: "connection_failure", error: message };
    }
    if (
      error instanceof EngineError &&
      error.code === ENGINE_IDENTITY_MISMATCH_CODE
    ) {
      await recordUnexecutedTransientSubmitFailure(
        opts.db,
        opts.jobId,
        `engine identity was not acknowledged before execution: ${message}`,
        campaignId,
        opts.ladderSubmitOwner,
      );
      // Reuse the non-executed capability-cutover outcome: callers restore
      // ownership without consuming solver/submit retry budgets. Unlike an
      // ordinary answered rejection, wrong-engine execution is never valid
      // failure evidence.
      return { kind: "capability_mismatch", error: message };
    }
    if (
      error instanceof EngineError &&
      error.status === 409 &&
      error.code === MESH_RECOVERY_CAPABILITY_MISMATCH_CODE &&
      (opts.precalcObligationIds?.length ?? 0) > 0
    ) {
      await recordUnexecutedTransientSubmitFailure(
        opts.db,
        opts.jobId,
        `engine capability changed before PRECALC execution: ${message}`,
        campaignId,
      );
      return { kind: "capability_mismatch", error: message };
    }
    if (
      error instanceof EngineError &&
      error.status === 409 &&
      error.code === URANS_RECOVERY_CAPABILITY_MISMATCH_CODE &&
      opts.request.expected_urans_recovery_version != null
    ) {
      await recordUnexecutedTransientSubmitFailure(
        opts.db,
        opts.jobId,
        `engine URANS-recovery capability changed before execution: ${message}`,
        campaignId,
        opts.ladderSubmitOwner,
      );
      return { kind: "capability_mismatch", error: message };
    }
    const httpStatus =
      error instanceof EngineError && typeof error.status === "number"
        ? error.status
        : null;
    const settled = await recordAnsweredSubmitFailure(
      opts.db,
      opts.jobId,
      opts.submitErrorPrefix + message,
      httpStatus,
      opts.precalcObligationIds ?? [],
      campaignId,
      opts.ladderSubmitOwner,
    );
    return {
      kind: "submit_failed",
      error: message,
      httpStatus,
      ladderDisposition: settled.ladderDisposition,
    };
  }

  // This conditional update is the durable submission boundary. PostgreSQL
  // rechecks the pending-row predicate after a concurrent cancellation update;
  // the campaign EXISTS guard additionally rejects a pause/cancel that already
  // committed before this statement began.
  const [submitted] = await withSubmitLifecycleLocks(
    opts.db,
    opts.jobId,
    campaignId,
    async (tx) => {
      const submittedRows = await tx
        .update(simJobs)
        .set({
          status: "submitted",
          engineJobId: status.job_id,
          submittedAt: new Date(),
          engineState: status.state,
          totalCases: status.total_cases,
        })
        .where(
          and(
            pendingSubmitWhere(opts.jobId, campaignId),
            eq(simJobs.engineState, SUBMITTING_ENGINE_STATE),
          ),
        )
        .returning({ id: simJobs.id });
      if (submittedRows.length) {
        // Engine acceptance closes the pre-submit failure sequence. A future
        // explicit/solver retry starts with a fresh one-5xx budget.
        await tx.delete(simResultSubmitRetries).where(
          sql`${simResultSubmitRetries.resultId} IN (
            SELECT accepted_result.id
            FROM results accepted_result
            WHERE accepted_result.sim_job_id = ${opts.jobId}
          )`,
        );
        await tx
          .update(results)
          .set({
            error: null,
          })
          .where(
            and(
              eq(results.simJobId, opts.jobId),
              inArray(results.status, ["queued", "running"]),
            ),
          );
        if (opts.ladderSubmitOwner) {
          await clearLadderSubmitRetryInTransaction(
            tx,
            opts.ladderSubmitOwner,
            opts.jobId,
          );
        }
      }
      return submittedRows;
    },
  );
  if (submitted) return { kind: "submitted", status };

  const reason = campaignId
    ? `campaign paused or cancelled before accepted engine task ${status.job_id} crossed the DB submission boundary`
    : `job stopped before accepted engine task ${status.job_id} crossed the DB submission boundary`;
  return compensateAcceptedEngineTask(
    opts.db,
    opts.engine,
    opts.jobId,
    status.job_id,
    reason,
  );
}
