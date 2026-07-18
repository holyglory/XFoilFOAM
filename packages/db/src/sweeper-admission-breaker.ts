import { sql } from "drizzle-orm";

import type { DB } from "./client";

export type SweeperAdmissionFenceReason =
  | "critical_solver_incident"
  | "blocked_preliminary_urans"
  | "blocked_final_urans"
  | "blocked_urans_request"
  | "campaign_progress_blocked";

export interface SweeperAdmissionFenceTrigger {
  reason: SweeperAdmissionFenceReason;
  triggerKey: string;
  campaignId: string;
  generation: number;
  details: Record<string, unknown>;
}

export interface SweeperAdmissionFenceResult {
  /** A current-generation hazard was observed by this exact query. */
  hazardPresent: boolean;
  /** This invocation changed the singleton from open to fenced. */
  fencedNow: boolean;
  /** The durable admission latch is closed after this invocation. */
  active: boolean;
  trigger: SweeperAdmissionFenceTrigger | null;
}

interface BreakerRow {
  active: boolean;
  fenced_now: boolean;
  reason: SweeperAdmissionFenceReason | null;
  trigger_key: string | null;
  campaign_id: string | null;
  generation: number | null;
  details: Record<string, unknown> | null;
}

/**
 * Close NEW solver admission when durable current-generation ledgers show a
 * critical outcome. The detector and singleton update are one SQL statement,
 * so concurrent sweeper ticks cannot admit work between observation and the
 * durable fence. Campaign lifecycle and already-submitted jobs are untouched.
 *
 * A fence is intentionally latched. Resolving the originating ledger does not
 * silently resume solver admission; an operator must explicitly re-enable the
 * sweeper after investigating the stored trigger provenance.
 */
export async function enforceSweeperAdmissionFence(
  db: DB,
): Promise<SweeperAdmissionFenceResult> {
  const [row] = (await db.execute(sql`
    WITH hazards AS (
      SELECT
        10::int AS priority,
        'critical_solver_incident'::text AS reason,
        'incident:' || incident.id::text AS trigger_key,
        campaign.id AS campaign_id,
        campaign.current_condition_generation::int AS generation,
        incident.occurred_at AS observed_at,
        jsonb_build_object(
          'incidentId', incident.id,
          'stage', incident.stage,
          'reason', incident.reason,
          'remediationVersion', incident.remediation_version,
          'solverImplementationId', incident.solver_implementation_id,
          'campaignId', campaign.id,
          'generation', campaign.current_condition_generation
        ) AS details
      FROM sim_solver_incidents incident
      JOIN sim_solver_incident_campaigns attribution
        ON attribution.incident_id = incident.id
      JOIN sim_campaigns campaign
        ON campaign.id = attribution.campaign_id
       AND campaign.status IN ('active', 'attention')
      JOIN LATERAL (
        SELECT 1
        FROM sim_campaign_points point
        JOIN sim_campaign_conditions condition
          ON condition.id = point.condition_id
         AND condition.campaign_id = campaign.id
         AND condition.generation = campaign.current_condition_generation
         AND condition.status IN ('active', 'kept')
        JOIN results point_result
          ON point_result.id = point.result_id
        WHERE incident.result_id IS NOT NULL
          AND point.result_id = incident.result_id
          AND (
            incident.result_attempt_id IS NULL
            OR COALESCE(
                 point.result_attempt_id,
                 point_result.current_result_attempt_id
               ) = incident.result_attempt_id
          )
          AND point.campaign_id = campaign.id
          AND point.state <> 'released'
          AND point.derived_by_symmetry = false

        UNION ALL

        SELECT 1
        FROM sim_precalc_obligations obligation
        JOIN sim_precalc_obligation_campaigns active_owner
          ON active_owner.obligation_id = obligation.id
         AND active_owner.campaign_id = campaign.id
         AND active_owner.state = 'active'
        JOIN sim_campaign_conditions condition
          ON condition.campaign_id = campaign.id
         AND condition.generation = campaign.current_condition_generation
         AND condition.status IN ('active', 'kept')
        JOIN sim_campaign_points point
          ON point.campaign_id = campaign.id
         AND point.condition_id = condition.id
         AND point.airfoil_id = obligation.airfoil_id
         AND point.aoa_deg = obligation.aoa_deg
         AND point.revision_id = obligation.revision_id
         AND point.state <> 'released'
         AND point.derived_by_symmetry = false
        WHERE incident.precalc_obligation_id IS NOT NULL
          AND obligation.id = incident.precalc_obligation_id

        UNION ALL

        SELECT 1
        FROM sim_urans_verify_queue verification
        JOIN sim_campaign_conditions condition
          ON condition.campaign_id = campaign.id
         AND condition.generation = campaign.current_condition_generation
         AND condition.status IN ('active', 'kept')
        JOIN sim_campaign_points point
          ON point.campaign_id = campaign.id
         AND point.condition_id = condition.id
         AND point.airfoil_id = verification.airfoil_id
         AND point.aoa_deg = verification.aoa_deg
         AND point.revision_id = verification.revision_id
         AND point.result_id = verification.precalc_result_id
         AND point.state <> 'released'
         AND point.derived_by_symmetry = false
        JOIN results point_result
          ON point_result.id = point.result_id
         AND COALESCE(
               point.result_attempt_id,
               point_result.current_result_attempt_id
             ) = verification.precalc_result_attempt_id
        WHERE incident.verify_queue_id IS NOT NULL
          AND verification.id = incident.verify_queue_id
          AND (
            EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_campaigns direct_owner
              WHERE direct_owner.queue_id = verification.id
                AND direct_owner.campaign_id = campaign.id
                AND direct_owner.state = 'active'
            )
            OR EXISTS (
              SELECT 1
              FROM sim_urans_verify_queue_requests coverage
              JOIN sim_urans_request_campaigns request_owner
                ON request_owner.request_id = coverage.request_id
               AND request_owner.campaign_id = campaign.id
               AND request_owner.state = 'active'
              WHERE coverage.queue_id = verification.id
            )
          )

        UNION ALL

        SELECT 1
        FROM sim_urans_requests request
        JOIN sim_urans_request_campaigns active_owner
          ON active_owner.request_id = request.id
         AND active_owner.campaign_id = campaign.id
         AND active_owner.state = 'active'
        JOIN sim_campaign_conditions condition
          ON condition.campaign_id = campaign.id
         AND condition.generation = campaign.current_condition_generation
         AND condition.status IN ('active', 'kept')
        JOIN sim_campaign_points point
          ON point.campaign_id = campaign.id
         AND point.condition_id = condition.id
         AND point.airfoil_id = request.airfoil_id
         AND point.revision_id = request.revision_id
         AND (request.aoa_deg IS NULL OR point.aoa_deg = request.aoa_deg)
         AND point.state <> 'released'
         AND point.derived_by_symmetry = false
        WHERE incident.urans_request_id IS NOT NULL
          AND request.id = incident.urans_request_id
        LIMIT 1
      ) current_owner ON true
      WHERE incident.status = 'open'
        AND incident.severity = 'critical'

      UNION ALL

      SELECT
        20::int,
        'blocked_preliminary_urans'::text,
        'precalc:' || obligation.id::text,
        campaign.id,
        campaign.current_condition_generation::int,
        obligation."updatedAt",
        jsonb_build_object(
          'obligationId', obligation.id,
          'lastOutcome', obligation.last_outcome,
          'lastError', obligation.last_error,
          'attemptCount', obligation.attempt_count,
          'maxAttempts', obligation.max_attempts,
          'campaignId', campaign.id,
          'generation', campaign.current_condition_generation
        )
      FROM sim_precalc_obligations obligation
      JOIN sim_precalc_obligation_campaigns owner
        ON owner.obligation_id = obligation.id
       AND owner.state = 'active'
      JOIN sim_campaigns campaign
        ON campaign.id = owner.campaign_id
       AND campaign.status IN ('active', 'attention')
      WHERE obligation.state = 'blocked'
        AND EXISTS (
          SELECT 1
          FROM sim_campaign_conditions condition
          JOIN sim_campaign_points point
            ON point.campaign_id = campaign.id
           AND point.condition_id = condition.id
          WHERE condition.campaign_id = campaign.id
            AND condition.generation = campaign.current_condition_generation
            AND condition.status IN ('active', 'kept')
            AND point.state <> 'released'
            AND point.derived_by_symmetry = false
            AND point.airfoil_id = obligation.airfoil_id
            AND point.revision_id = obligation.revision_id
            AND point.aoa_deg = obligation.aoa_deg
        )

      UNION ALL

      SELECT
        30::int,
        'blocked_final_urans'::text,
        'verify:' || verification.id::text,
        campaign.id,
        campaign.current_condition_generation::int,
        verification."updatedAt",
        jsonb_build_object(
          'verifyQueueId', verification.id,
          'lastOutcome', verification.last_outcome,
          'lastError', verification.last_error,
          'freshAttemptCount', verification.fresh_attempt_count,
          'maxFreshAttempts', verification.max_fresh_attempts,
          'campaignId', campaign.id,
          'generation', campaign.current_condition_generation
      )
      FROM sim_urans_verify_queue verification
      JOIN LATERAL (
        SELECT direct_owner.campaign_id
        FROM sim_urans_verify_queue_campaigns direct_owner
        WHERE direct_owner.queue_id = verification.id
          AND direct_owner.state = 'active'
        UNION
        SELECT request_owner.campaign_id
        FROM sim_urans_verify_queue_requests coverage
        JOIN sim_urans_request_campaigns request_owner
          ON request_owner.request_id = coverage.request_id
         AND request_owner.state = 'active'
        WHERE coverage.queue_id = verification.id
      ) owner ON true
      JOIN sim_campaigns campaign
        ON campaign.id = owner.campaign_id
       AND campaign.status IN ('active', 'attention')
      WHERE verification.state = 'blocked'
        AND EXISTS (
          SELECT 1
          FROM sim_campaign_conditions condition
          JOIN sim_campaign_points point
            ON point.campaign_id = campaign.id
           AND point.condition_id = condition.id
          JOIN results point_result
            ON point_result.id = point.result_id
          WHERE condition.campaign_id = campaign.id
            AND condition.generation = campaign.current_condition_generation
            AND condition.status IN ('active', 'kept')
            AND point.state <> 'released'
            AND point.derived_by_symmetry = false
            AND point.airfoil_id = verification.airfoil_id
            AND point.revision_id = verification.revision_id
            AND point.aoa_deg = verification.aoa_deg
            AND point.result_id = verification.precalc_result_id
            AND COALESCE(
                  point.result_attempt_id,
                  point_result.current_result_attempt_id
                ) = verification.precalc_result_attempt_id
        )

      UNION ALL

      SELECT
        40::int,
        'blocked_urans_request'::text,
        'request:' || request.id::text,
        campaign.id,
        campaign.current_condition_generation::int,
        request."updatedAt",
        jsonb_build_object(
          'requestId', request.id,
          'fidelity', request.fidelity,
          'aoaDeg', request.aoa_deg,
          'campaignId', campaign.id,
          'generation', campaign.current_condition_generation
        )
      FROM sim_urans_requests request
      JOIN sim_urans_request_campaigns owner
        ON owner.request_id = request.id
       AND owner.state = 'active'
      JOIN sim_campaigns campaign
        ON campaign.id = owner.campaign_id
       AND campaign.status IN ('active', 'attention')
      WHERE request.state = 'blocked'
        AND EXISTS (
          SELECT 1
          FROM sim_campaign_conditions condition
          JOIN sim_campaign_points point
            ON point.campaign_id = campaign.id
           AND point.condition_id = condition.id
          WHERE condition.campaign_id = campaign.id
            AND condition.generation = campaign.current_condition_generation
            AND condition.status IN ('active', 'kept')
            AND point.state <> 'released'
            AND point.derived_by_symmetry = false
            AND point.airfoil_id = request.airfoil_id
            AND point.revision_id = request.revision_id
            AND (request.aoa_deg IS NULL OR request.aoa_deg = point.aoa_deg)
        )

      UNION ALL

      SELECT
        50::int,
        'campaign_progress_blocked'::text,
        'progress:' || progress.campaign_id::text || ':' ||
          progress.condition_id::text || ':' || progress.airfoil_id::text,
        campaign.id,
        campaign.current_condition_generation::int,
        progress."updatedAt",
        jsonb_build_object(
          'conditionId', progress.condition_id,
          'airfoilId', progress.airfoil_id,
          'blocked', progress.blocked,
          'blockedMeshQuality', progress.blocked_mesh_quality,
          'blockedPrecalcExhausted', progress.blocked_precalc_exhausted,
          'blockedEngineSubmit', progress.blocked_engine_submit,
          'blockedOther', progress.blocked_other,
          'campaignId', campaign.id,
          'generation', campaign.current_condition_generation
        )
      FROM sim_campaign_progress progress
      JOIN sim_campaigns campaign
        ON campaign.id = progress.campaign_id
       AND campaign.status IN ('active', 'attention')
      JOIN sim_campaign_conditions condition
        ON condition.id = progress.condition_id
       AND condition.campaign_id = campaign.id
       AND condition.generation = campaign.current_condition_generation
       AND condition.status IN ('active', 'kept')
      WHERE progress.blocked > 0
    ),
    selected AS (
      SELECT *
      FROM hazards
      ORDER BY priority, observed_at, trigger_key
      LIMIT 1
    ),
    fenced AS (
      UPDATE sweeper_state state
      SET enabled = false,
          max_concurrent_jobs = 0,
          cpu_slots = 0,
          admission_fence_active = true,
          last_admission_fence_at = now(),
          last_admission_fence_reason = selected.reason,
          last_admission_fence_trigger_key = selected.trigger_key,
          last_admission_fence_details = selected.details || jsonb_build_object(
            'previousEnabled', state.enabled,
            'previousMaxConcurrentJobs', state.max_concurrent_jobs,
            'previousCpuSlots', state.cpu_slots
          ),
          "updatedAt" = now()
      FROM selected
      WHERE state.id = 1
        AND state.admission_fence_active = false
      RETURNING state.id
    )
    SELECT
      (state.admission_fence_active OR EXISTS (SELECT 1 FROM fenced)) AS active,
      EXISTS (SELECT 1 FROM fenced) AS fenced_now,
      selected.reason,
      selected.trigger_key,
      selected.campaign_id,
      selected.generation,
      selected.details
    FROM sweeper_state state
    LEFT JOIN selected ON true
    WHERE state.id = 1
  `)) as unknown as BreakerRow[];

  if (!row) {
    throw new Error("sweeper_state singleton is missing");
  }

  const trigger =
    row.reason &&
    row.trigger_key &&
    row.campaign_id &&
    row.generation != null &&
    row.details
      ? {
          reason: row.reason,
          triggerKey: row.trigger_key,
          campaignId: row.campaign_id,
          generation: Number(row.generation),
          details: row.details,
        }
      : null;

  return {
    hazardPresent: trigger !== null,
    fencedNow: row.fenced_now,
    active: row.active,
    trigger,
  };
}
