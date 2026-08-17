\set ON_ERROR_STOP on
\if :{?commit_reset}
\else
\set commit_reset false
\endif

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '0';
SELECT pg_advisory_xact_lock(hashtextextended('airfoils_pro_solver_domain_reset_v1', 0));

-- `sim_jobs` is an evidence parent, and PostgreSQL checks this FK once per job
-- during deletion. Build the missing lookup index once so a reset does not
-- rescan the full artifact relation for every historical job. The retained
-- empty index also makes future exact job retirement bounded.
CREATE INDEX IF NOT EXISTS solver_evidence_artifacts_sim_job_idx
  ON solver_evidence_artifacts (sim_job_id);

-- These exact tables are immutable during normal operation. This operator-only
-- whole-domain reset is the one deliberate exception: the user requested that
-- their obsolete solver evidence be removed rather than retained or audited.
-- Disable only the DELETE guards, keep every FK/validation trigger active, and
-- restore the guards before commit. Any error rolls the DDL and data changes
-- back together.
ALTER TABLE historical_archive_audit_decisions
  DISABLE TRIGGER historical_archive_audit_decisions_append_only;
ALTER TABLE result_canonical_selections
  DISABLE TRIGGER result_canonical_selections_append_only;
ALTER TABLE result_interpretation_cycles
  DISABLE TRIGGER result_interpretation_cycles_append_only;
ALTER TABLE result_interpretations
  DISABLE TRIGGER result_interpretations_append_only;
ALTER TABLE sync_brokered_evidence_uploads
  DISABLE TRIGGER sync_brokered_evidence_upload_bound_delete_guard;
DO $$
BEGIN
  IF to_regclass('public.solver_evidence_orphan_quarantines') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE solver_evidence_orphan_quarantines DISABLE TRIGGER solver_evidence_orphan_quarantines_immutable';
  END IF;
  IF to_regclass('public.solver_evidence_incomplete_quarantines') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE solver_evidence_incomplete_quarantines DISABLE TRIGGER solver_evidence_incomplete_quarantines_immutable';
  END IF;
  IF to_regclass('public.sync_brokered_terminal_evidence_uploads') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE sync_brokered_terminal_evidence_uploads DISABLE TRIGGER sync_brokered_terminal_evidence_uploads_no_verified_delete';
  END IF;
END
$$;

-- Point definitions and campaign/setup truth remain. Released source/cutover
-- cells stay released; every current physical cell becomes ordinary unsolved
-- work with no result ownership.
UPDATE sim_campaign_points
SET state = CASE WHEN state = 'released' THEN 'released' ELSE 'requested' END,
    result_id = NULL,
    result_attempt_id = NULL,
    derived_by_symmetry = false,
    "updatedAt" = now();

UPDATE results
SET current_result_attempt_id = NULL,
    current_result_interpretation_id = NULL,
    current_canonical_selection_id = NULL;

-- Remove mutable recovery/sync ownership before immutable result rows. This is
-- deliberately a flat reset, not an audit-to-restore state machine.
DELETE FROM result_interpretation_backfill_items;
DELETE FROM historical_archive_audit_decisions;
DELETE FROM legacy_urans_archive_gap_recovery_actions;
DELETE FROM result_interpretation_recovery_actions;
DELETE FROM result_archive_reduction_queue;
DELETE FROM result_canonical_selections;
DELETE FROM result_interpretation_cycles;
DELETE FROM result_interpretations;
DELETE FROM result_interpretation_backfill_runs;

DO $$
BEGIN
  IF to_regclass('public.sync_remote_terminal_evidence_receipts') IS NOT NULL THEN
    EXECUTE 'DELETE FROM sync_remote_terminal_evidence_receipts';
  END IF;
  IF to_regclass('public.sync_remote_terminal_evidence_uploads') IS NOT NULL THEN
    EXECUTE 'DELETE FROM sync_remote_terminal_evidence_uploads';
  END IF;
  IF to_regclass('public.sync_brokered_terminal_evidence_uploads') IS NOT NULL THEN
    EXECUTE 'DELETE FROM sync_brokered_terminal_evidence_uploads';
  END IF;
END
$$;
DELETE FROM sync_remote_hub_binding_receipts;
DELETE FROM sync_brokered_evidence_uploads;
DELETE FROM sync_remote_result_deliveries;
DELETE FROM sync_remote_promise_cancellations;
DELETE FROM sync_sweep_promise_points;
DELETE FROM sync_sweep_promises;
DELETE FROM sync_upload_capacity_reservations;
DELETE FROM remote_asset_references;

DELETE FROM sim_solver_incident_campaigns;
DELETE FROM sim_solver_incidents;
DELETE FROM sim_ladder_submit_retries;
DELETE FROM sim_precalc_obligation_requests;
DELETE FROM sim_precalc_obligation_remediations;
DELETE FROM sim_precalc_obligation_attempts;
DELETE FROM sim_precalc_obligation_campaigns;
DELETE FROM sim_rans_polar_promotion_points;
DELETE FROM sim_rans_polar_promotions;
DELETE FROM sim_urans_verify_queue_requests;
DELETE FROM sim_urans_verify_queue_campaigns;
DELETE FROM sim_urans_request_campaigns;
DELETE FROM sim_urans_verify_queue;
DELETE FROM sim_urans_requests;
DELETE FROM sim_precalc_obligations;
DELETE FROM sim_result_submit_retries;

DELETE FROM result_media_repairs;
DELETE FROM result_media;
DELETE FROM field_render_cache;
DELETE FROM force_history;
DELETE FROM result_attempt_ingest_completions;
DELETE FROM result_review_verdicts;
DELETE FROM result_classifications;
DELETE FROM result_evidence_field_inventory;
DELETE FROM result_field_extents;
DELETE FROM polar_compatibility_fit_members;
DELETE FROM polar_compatibility_fit_points;
DELETE FROM polar_compatibility_fit_sets;
DELETE FROM sim_campaign_lane_steps;
DELETE FROM polar_fit_points;
DELETE FROM polar_fit_sets;
DELETE FROM field_color_scales;

DO $$
BEGIN
  IF to_regclass('public.solver_evidence_incomplete_quarantines') IS NOT NULL THEN
    EXECUTE 'DELETE FROM solver_evidence_incomplete_quarantines';
  END IF;
  IF to_regclass('public.solver_evidence_orphan_quarantines') IS NOT NULL THEN
    EXECUTE 'DELETE FROM solver_evidence_orphan_quarantines';
  END IF;
END
$$;

-- This is the only very large child table that can be truncated independently.
-- Its archive/artifact parents are removed below after every restrictive owner
-- has been cleared.
TRUNCATE TABLE solver_evidence_artifact_members;
DELETE FROM solver_evidence_archives;
DELETE FROM solver_evidence_artifacts;
DELETE FROM solver_evidence_blobs;

DELETE FROM solver_cutover_continuation_checks;
DELETE FROM results;
DELETE FROM result_attempts;
DELETE FROM sim_jobs;

ALTER TABLE historical_archive_audit_decisions
  ENABLE TRIGGER historical_archive_audit_decisions_append_only;
ALTER TABLE result_canonical_selections
  ENABLE TRIGGER result_canonical_selections_append_only;
ALTER TABLE result_interpretation_cycles
  ENABLE TRIGGER result_interpretation_cycles_append_only;
ALTER TABLE result_interpretations
  ENABLE TRIGGER result_interpretations_append_only;
ALTER TABLE sync_brokered_evidence_uploads
  ENABLE TRIGGER sync_brokered_evidence_upload_bound_delete_guard;
DO $$
BEGIN
  IF to_regclass('public.solver_evidence_orphan_quarantines') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE solver_evidence_orphan_quarantines ENABLE TRIGGER solver_evidence_orphan_quarantines_immutable';
  END IF;
  IF to_regclass('public.solver_evidence_incomplete_quarantines') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE solver_evidence_incomplete_quarantines ENABLE TRIGGER solver_evidence_incomplete_quarantines_immutable';
  END IF;
  IF to_regclass('public.sync_brokered_terminal_evidence_uploads') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE sync_brokered_terminal_evidence_uploads ENABLE TRIGGER sync_brokered_terminal_evidence_uploads_no_verified_delete';
  END IF;
END
$$;

UPDATE sim_campaign_lanes
SET state = 'awaiting_seed',
    current_target_alpha = NULL,
    iteration_count = 0,
    witness_fit_set_id = NULL,
    extra_rounds_granted = 0,
    "updatedAt" = now();

DELETE FROM sim_campaign_progress;
INSERT INTO sim_campaign_progress (
  campaign_id,
  condition_id,
  airfoil_id,
  requested,
  solved,
  failed,
  running,
  superseded,
  derived,
  rejected,
  blocked,
  awaiting_archive_reduction,
  precalc_mesh_repairing,
  blocked_mesh_quality,
  blocked_precalc_exhausted,
  blocked_engine_submit,
  blocked_other
)
SELECT
  campaign_id,
  condition_id,
  airfoil_id,
  COUNT(*) FILTER (WHERE state <> 'released')::int,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
FROM sim_campaign_points
GROUP BY campaign_id, condition_id, airfoil_id;

UPDATE sim_campaigns
SET status = 'active',
    closed_with_failed_count = NULL,
    closed_with_rejected_count = NULL,
    "completedAt" = NULL,
    "updatedAt" = now()
WHERE status NOT IN ('cancelled', 'archived');

-- The operational canary tables, catalog, coordinates, setup/preset revisions,
-- solver identities, execution pools, and campaign/cutover definitions are not
-- touched by this reset.
DO $$
DECLARE
  remaining bigint;
  optional_remaining bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM results)
    + (SELECT count(*) FROM result_attempts)
    + (SELECT count(*) FROM solver_evidence_blobs)
    + (SELECT count(*) FROM solver_evidence_artifacts)
    + (SELECT count(*) FROM solver_evidence_archives)
    + (SELECT count(*) FROM sim_jobs)
    + (SELECT count(*) FROM sim_precalc_obligations)
    + (SELECT count(*) FROM sim_urans_requests)
    + (SELECT count(*) FROM sim_urans_verify_queue)
    + (SELECT count(*) FROM sync_sweep_promises)
    + (SELECT count(*) FROM sync_sweep_promise_points)
    + (SELECT count(*) FROM solver_cutover_continuation_checks)
  INTO remaining;
  IF to_regclass('public.solver_evidence_orphan_quarantines') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM solver_evidence_orphan_quarantines'
      INTO optional_remaining;
    remaining := remaining + optional_remaining;
  END IF;
  IF to_regclass('public.solver_evidence_incomplete_quarantines') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM solver_evidence_incomplete_quarantines'
      INTO optional_remaining;
    remaining := remaining + optional_remaining;
  END IF;
  IF to_regclass('public.sync_remote_terminal_evidence_receipts') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM sync_remote_terminal_evidence_receipts'
      INTO optional_remaining;
    remaining := remaining + optional_remaining;
  END IF;
  IF to_regclass('public.sync_remote_terminal_evidence_uploads') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM sync_remote_terminal_evidence_uploads'
      INTO optional_remaining;
    remaining := remaining + optional_remaining;
  END IF;
  IF to_regclass('public.sync_brokered_terminal_evidence_uploads') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM sync_brokered_terminal_evidence_uploads'
      INTO optional_remaining;
    remaining := remaining + optional_remaining;
  END IF;
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'solver-domain reset left % core rows', remaining;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM sim_campaign_points
    WHERE state <> 'released'
      AND (state <> 'requested' OR result_id IS NOT NULL OR result_attempt_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'solver-domain reset left a current campaign point owned or non-requested';
  END IF;
END
$$;

SELECT
  (SELECT count(*) FROM sim_campaign_points WHERE state = 'requested') AS requested_points,
  (SELECT count(*) FROM sim_campaign_points WHERE state = 'released') AS released_points,
  (SELECT coalesce(sum(requested), 0) FROM sim_campaign_progress) AS progress_requested,
  (SELECT count(*) FROM solver_engine_canary_attestations) AS retained_canary_attestations,
  (SELECT count(*) FROM solver_operational_canary_evidence_objects) AS retained_canary_objects;

\if :commit_reset
COMMIT;
\else
ROLLBACK;
\endif
