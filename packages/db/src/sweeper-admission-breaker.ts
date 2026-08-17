import { sql } from "drizzle-orm";

import type { DB } from "./client";
import {
  RANS_RECOVERY_REMEDIATION_VERSION,
  REPEATED_SOLVER_INCIDENT_THRESHOLD,
  URANS_RECOVERY_REMEDIATION_VERSION,
} from "./solver-incidents";

/**
 * A selected, current, accepted archive reduction is exact proof that this
 * physical PRECALC cell is publishable. The raw CFD attempt may remain
 * rejected: archive interpretation acceptance is the authority for this
 * recovery path. The normal publication path settles the matching obligation
 * in the same tick, but admission must not briefly re-fence in the small
 * post-selection/pre-settlement window. Require the same latest physical job
 * so a later failed generation cannot be hidden by an older archive pointer.
 */
const exactAcceptedArchivePrecalcSelectionSql = sql`
  EXISTS (
    SELECT 1
    FROM results accepted_result
    JOIN result_attempts accepted_attempt
      ON accepted_attempt.id = accepted_result.current_result_attempt_id
     AND accepted_attempt.result_id = accepted_result.id
     AND accepted_attempt.status = 'done'
     AND accepted_attempt.source = 'solved'
     AND accepted_attempt.evidence_payload ->> 'fidelity' = 'urans_precalc'
    JOIN result_canonical_selections accepted_selection
      ON accepted_selection.id = accepted_result.current_canonical_selection_id
     AND accepted_selection.result_id = accepted_result.id
     AND accepted_selection.result_attempt_id = accepted_attempt.id
    JOIN result_interpretations accepted_interpretation
      ON accepted_interpretation.id = accepted_selection.result_interpretation_id
     AND accepted_interpretation.id = accepted_result.current_result_interpretation_id
     AND accepted_interpretation.result_id = accepted_result.id
     AND accepted_interpretation.result_attempt_id = accepted_attempt.id
     AND accepted_interpretation.source = 'archive_backfill'
     AND accepted_interpretation.state = 'accepted'
    JOIN solver_evidence_archives accepted_archive
      ON accepted_archive.id = accepted_interpretation.source_archive_id
     AND accepted_archive.result_id = accepted_result.id
     AND accepted_archive.result_attempt_id = accepted_attempt.id
     AND accepted_archive.state = 'current'
    WHERE accepted_result.airfoil_id = obligation.airfoil_id
      AND accepted_result.simulation_preset_revision_id = obligation.revision_id
      AND accepted_result.aoa_deg = obligation.aoa_deg
      AND accepted_result.status = 'done'
      AND accepted_result.source = 'solved'
      AND accepted_result.fidelity = 'urans_precalc'
      AND accepted_attempt.sim_job_id = obligation.latest_sim_job_id
  )
`;

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
 * Close NEW solver admission only for a systemic current-generation incident:
 * repeated equal implementation/remediation/reason failures, or a direct
 * infrastructure/evidence-integrity loss. One isolated point remains a
 * durable critical record and receives its normal automated recovery, but
 * must not idle healthy local and remote capacity. The detector and singleton
 * update are one SQL statement, so concurrent sweeper ticks cannot admit work
 * between systemic observation and the durable fence. Campaign lifecycle and
 * already-submitted jobs are untouched.
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
          -- New incidents carry this stable classification directly. The
          -- structured compatibility arm recognizes the already-recorded v11
          -- clean-cycle cap outcomes without relying on their free-text error.
          'admissionScope', CASE
            WHEN (
              incident.metadata ->> 'admissionScope' = 'cell'
              AND incident.metadata ->> 'recoveryDisposition' IN (
                'urans_clean_cycle_cap_exhausted',
                'continuation_source_permanent'
              )
            ) OR (
              incident.stage = 'preliminary'
              AND incident.metadata ->> 'lastOutcome' IN (
                'failed_exhausted',
                'rejected_exhausted'
              )
              AND incident.metadata ->> 'failureDisposition' IN (
                'hard_solver',
                'none'
              )
              AND incident.metadata -> 'classificationReasons' @>
                '["insufficient-periods", "non-stationary", "uncertified-urans-cycles"]'::jsonb
            ) THEN 'cell'
            ELSE 'systemic'
          END,
          'recoveryDisposition', incident.metadata ->> 'recoveryDisposition',
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
          -- A bounded corrective generation has durable ownership and is
          -- already queued for normal submission.  Its historical incident
          -- remains immutable evidence, but must not re-trip the global fence
          -- while the recovery owner is queued or actively running.
          AND NOT (
            obligation.state IN ('pending', 'running')
            AND obligation.remediation_attempts_granted > 0
            OR ${exactAcceptedArchivePrecalcSelectionSql}
          )

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
        -- A correction changes the remediation contract. Older generations
        -- stay immutable and visible in the incident log, but cannot keep
        -- re-fencing a live controller after its replacement is deployed.
        AND (
          (incident.stage = 'rans'
            AND incident.remediation_version = ${RANS_RECOVERY_REMEDIATION_VERSION})
          OR (
            incident.stage IN ('preliminary', 'final')
            AND incident.remediation_version = ${URANS_RECOVERY_REMEDIATION_VERSION}
          )
        )

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
        -- A typed permanent continuation source is terminal only for this
        -- exact physical cell. Its incident remains durable and visible, but
        -- must not enter this raw blocked-owner fleet fence (the incident arm
        -- above independently accepts only its explicit cell scope).
        AND obligation.last_outcome IS DISTINCT FROM
          'continuation_permanent_failure'
        -- The selected archive result above has not yet been reconciled into
        -- this mutable owner. It is exact current evidence, not a new failure.
        AND NOT (${exactAcceptedArchivePrecalcSelectionSql})
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
        -- Match the PRECALC rule above: an exact permanent continuation source
        -- remains a critical cell outcome, never a generic final-URANS fleet
        -- outage. Every other blocked verification remains a global hazard.
        AND verification.last_outcome IS DISTINCT FROM
          'continuation_permanent_failure'
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
    systemic_hazards AS (
      SELECT *
      FROM hazards hazard
      WHERE hazard.reason = 'critical_solver_incident'
        AND (
          -- Infrastructure/evidence-integrity loss is systemic at first
          -- observation: accepting new work could compound the loss.
          hazard.details ->> 'reason' IN (
            'engine-infrastructure-failure',
            'engine-submit-rejected',
            'evidence-integrity-failure',
            'evidence-manifest-integrity-failure',
            'archive-pinned-continuation-proof-lost'
          )
          OR (
            -- Count only exact current campaign hazards already proven by the
            -- ownership joins above. Historical, released, cancelled, and
            -- unowned incident rows are durable audit evidence, not grounds
            -- to idle the live fleet. A typed clean-cycle recovery ceiling is
            -- critical for its one physical cell, not a fleet-wide recurring
            -- defect, so it is excluded from both the candidate and count.
            COALESCE(hazard.details ->> 'admissionScope', 'systemic') <> 'cell'
            AND (
            SELECT count(DISTINCT peer.trigger_key)
            FROM hazards peer
            WHERE peer.reason = 'critical_solver_incident'
              AND COALESCE(peer.details ->> 'admissionScope', 'systemic') <> 'cell'
              AND peer.details ->> 'stage' = hazard.details ->> 'stage'
              AND peer.details ->> 'reason' = hazard.details ->> 'reason'
              AND peer.details ->> 'solverImplementationId' =
                hazard.details ->> 'solverImplementationId'
              AND peer.details ->> 'remediationVersion' =
                hazard.details ->> 'remediationVersion'
            ) >= ${REPEATED_SOLVER_INCIDENT_THRESHOLD}
          )
        )
    ),
    selected AS (
      SELECT *
      FROM systemic_hazards
      ORDER BY priority, observed_at, trigger_key
      LIMIT 1
    ),
    fenced AS (
      UPDATE sweeper_state state
      SET enabled = false,
          max_concurrent_jobs = 0,
          cpu_slots = 0,
          admission_fence_active = true,
          maintenance_drain_token = NULL,
          maintenance_drain_started_at = NULL,
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
