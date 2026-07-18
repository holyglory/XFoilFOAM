-- A rare critical solver outcome is a global admission circuit breaker, not a
-- campaign pause and not a cancellation of work already accepted by OpenFOAM.
-- Keep current latch state plus the last exact trigger on the singleton so the
-- API can explain an automatic stop without reconstructing it from logs.
ALTER TABLE "sweeper_state"
  ADD COLUMN "admission_fence_active" boolean DEFAULT false NOT NULL,
  ADD COLUMN "last_admission_fence_at" timestamp with time zone,
  ADD COLUMN "last_admission_fence_reason" text,
  ADD COLUMN "last_admission_fence_trigger_key" text,
  ADD COLUMN "last_admission_fence_details" jsonb;
--> statement-breakpoint

ALTER TABLE "sweeper_state"
  ADD CONSTRAINT "sweeper_state_admission_fence_shape_check"
    CHECK (
      NOT "admission_fence_active"
      OR (
        "enabled" = false
        AND "max_concurrent_jobs" = 0
        AND "cpu_slots" = 0
        AND "last_admission_fence_at" IS NOT NULL
        AND btrim(COALESCE("last_admission_fence_reason", '')) <> ''
        AND btrim(COALESCE("last_admission_fence_trigger_key", '')) <> ''
        AND "last_admission_fence_details" IS NOT NULL
      )
    );
--> statement-breakpoint

-- Preserve the singleton invariant for populated upgrades that were prepared
-- without running the catalog seed.
INSERT INTO "sweeper_state" ("id")
VALUES (1)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint

-- The fallback hazard is intentionally rare. Keep the every-tick detector on
-- a tiny partial index rather than scanning one progress row per campaign cell.
CREATE INDEX "sim_campaign_progress_blocked_admission_idx"
  ON "sim_campaign_progress" ("campaign_id", "condition_id", "airfoil_id")
  WHERE "blocked" > 0;
--> statement-breakpoint

-- The submit-side permit holds sweeper_state(1) across the bounded engine
-- acceptance call. Every durable row which can newly satisfy the breaker
-- detector must take the same row lock before its transaction may commit.
--
-- Owner-row triggers are deliberately AFTER/transition-only: the owner is
-- already validated, ordinary pending/running/progress updates do not contend,
-- and an INSERT ... ON CONFLICT DO NOTHING replay does not acquire the lock.
-- Predicate tables added below lock only when they can make an existing owner
-- current; campaign-point set operations take one statement-level lock.
-- If engine acceptance owns the lock first, the terminal writer commits after
-- that already-accepted job. If the terminal writer commits first, the next
-- permit observes the hazard and never calls the engine.
CREATE OR REPLACE FUNCTION "sweeper_admission_hazard_transition_lock"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- The row is a singleton invariant, but populated-upgrade tests and a
  -- partially initialized installation may legitimately reach this trigger
  -- before the seed step. Re-establish the fail-closed default before locking
  -- it so hazard evidence can never fail to commit merely because setup has
  -- not inserted the singleton yet. Concurrent creators serialize through
  -- the unique key, then through the same FOR UPDATE permit.
  INSERT INTO sweeper_state (id)
  VALUES (1)
  ON CONFLICT (id) DO NOTHING;

  PERFORM state.id
  FROM sweeper_state state
  WHERE state.id = 1
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sweeper_state singleton is missing while committing an admission hazard';
  END IF;
  IF TG_LEVEL = 'STATEMENT' THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$function$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_solver_incidents_admission_hazard_insert" ON "sim_solver_incidents";
CREATE TRIGGER "sim_solver_incidents_admission_hazard_insert"
AFTER INSERT ON "sim_solver_incidents"
FOR EACH ROW
WHEN (NEW."severity" = 'critical' AND NEW."status" = 'open')
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_solver_incidents_admission_hazard_update" ON "sim_solver_incidents";
CREATE TRIGGER "sim_solver_incidents_admission_hazard_update"
AFTER UPDATE OF
  "severity",
  "status",
  "result_id",
  "precalc_obligation_id",
  "verify_queue_id",
  "urans_request_id"
ON "sim_solver_incidents"
FOR EACH ROW
WHEN (
  NEW."severity" = 'critical'
  AND NEW."status" = 'open'
  AND (
    NOT (OLD."severity" = 'critical' AND OLD."status" = 'open')
    OR OLD."result_id" IS DISTINCT FROM NEW."result_id"
    OR OLD."precalc_obligation_id" IS DISTINCT FROM NEW."precalc_obligation_id"
    OR OLD."verify_queue_id" IS DISTINCT FROM NEW."verify_queue_id"
    OR OLD."urans_request_id" IS DISTINCT FROM NEW."urans_request_id"
  )
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_precalc_obligations_admission_hazard_insert" ON "sim_precalc_obligations";
CREATE TRIGGER "sim_precalc_obligations_admission_hazard_insert"
AFTER INSERT ON "sim_precalc_obligations"
FOR EACH ROW
WHEN (NEW."state" = 'blocked')
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_precalc_obligations_admission_hazard_update" ON "sim_precalc_obligations";
CREATE TRIGGER "sim_precalc_obligations_admission_hazard_update"
AFTER UPDATE OF "state", "airfoil_id", "revision_id", "aoa_deg"
ON "sim_precalc_obligations"
FOR EACH ROW
WHEN (
  (NEW."state" = 'blocked' AND OLD."state" IS DISTINCT FROM 'blocked')
  OR OLD."airfoil_id" IS DISTINCT FROM NEW."airfoil_id"
  OR OLD."revision_id" IS DISTINCT FROM NEW."revision_id"
  OR OLD."aoa_deg" IS DISTINCT FROM NEW."aoa_deg"
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_urans_verify_queue_admission_hazard_insert" ON "sim_urans_verify_queue";
CREATE TRIGGER "sim_urans_verify_queue_admission_hazard_insert"
AFTER INSERT ON "sim_urans_verify_queue"
FOR EACH ROW
WHEN (NEW."state" = 'blocked')
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_urans_verify_queue_admission_hazard_update" ON "sim_urans_verify_queue";
CREATE TRIGGER "sim_urans_verify_queue_admission_hazard_update"
AFTER UPDATE OF
  "state",
  "airfoil_id",
  "revision_id",
  "aoa_deg",
  "precalc_result_attempt_id"
ON "sim_urans_verify_queue"
FOR EACH ROW
WHEN (
  (NEW."state" = 'blocked' AND OLD."state" IS DISTINCT FROM 'blocked')
  OR OLD."airfoil_id" IS DISTINCT FROM NEW."airfoil_id"
  OR OLD."revision_id" IS DISTINCT FROM NEW."revision_id"
  OR OLD."aoa_deg" IS DISTINCT FROM NEW."aoa_deg"
  OR OLD."precalc_result_attempt_id"
    IS DISTINCT FROM NEW."precalc_result_attempt_id"
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_urans_requests_admission_hazard_insert" ON "sim_urans_requests";
CREATE TRIGGER "sim_urans_requests_admission_hazard_insert"
AFTER INSERT ON "sim_urans_requests"
FOR EACH ROW
WHEN (NEW."state" = 'blocked')
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_urans_requests_admission_hazard_update" ON "sim_urans_requests";
CREATE TRIGGER "sim_urans_requests_admission_hazard_update"
AFTER UPDATE OF "state", "airfoil_id", "revision_id", "aoa_deg"
ON "sim_urans_requests"
FOR EACH ROW
WHEN (
  (NEW."state" = 'blocked' AND OLD."state" IS DISTINCT FROM 'blocked')
  OR OLD."airfoil_id" IS DISTINCT FROM NEW."airfoil_id"
  OR OLD."revision_id" IS DISTINCT FROM NEW."revision_id"
  OR OLD."aoa_deg" IS DISTINCT FROM NEW."aoa_deg"
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_campaign_progress_admission_hazard_insert" ON "sim_campaign_progress";
CREATE TRIGGER "sim_campaign_progress_admission_hazard_insert"
AFTER INSERT ON "sim_campaign_progress"
FOR EACH ROW
WHEN (NEW."blocked" > 0)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_campaign_progress_admission_hazard_update" ON "sim_campaign_progress";
CREATE TRIGGER "sim_campaign_progress_admission_hazard_update"
AFTER UPDATE OF "blocked", "campaign_id", "condition_id"
ON "sim_campaign_progress"
FOR EACH ROW
WHEN (
  NEW."blocked" > 0
  AND (
    OLD."blocked" <= 0
    OR OLD."campaign_id" IS DISTINCT FROM NEW."campaign_id"
    OR OLD."condition_id" IS DISTINCT FROM NEW."condition_id"
  )
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

-- A hazard owner can exist while its campaign is paused, belongs to an older
-- generation, lacks campaign attribution, or has no live point association.
-- Resuming/retargeting that surrounding predicate can make the already-stored
-- owner current without changing any of the five owner rows above. Serialize
-- every such predicate-enabling transition on the same singleton as the final
-- submit permit. These transitions are much rarer than progress ingestion, so
-- the conservative lock is preferable to admitting one solve past a safety
-- stop.
DROP TRIGGER IF EXISTS "sim_campaigns_admission_hazard_insert" ON "sim_campaigns";
CREATE TRIGGER "sim_campaigns_admission_hazard_insert"
AFTER INSERT ON "sim_campaigns"
FOR EACH ROW
WHEN (NEW."status" IN ('active', 'attention'))
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_campaigns_admission_hazard_update" ON "sim_campaigns";
CREATE TRIGGER "sim_campaigns_admission_hazard_update"
AFTER UPDATE OF "status", "current_condition_generation" ON "sim_campaigns"
FOR EACH ROW
WHEN (
  NEW."status" IN ('active', 'attention')
  AND (
    OLD."status" NOT IN ('active', 'attention')
    OR OLD."current_condition_generation"
      IS DISTINCT FROM NEW."current_condition_generation"
  )
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_campaign_conditions_admission_hazard_insert" ON "sim_campaign_conditions";
CREATE TRIGGER "sim_campaign_conditions_admission_hazard_insert"
AFTER INSERT ON "sim_campaign_conditions"
FOR EACH ROW
WHEN (NEW."status" IN ('active', 'kept'))
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_campaign_conditions_admission_hazard_update" ON "sim_campaign_conditions";
CREATE TRIGGER "sim_campaign_conditions_admission_hazard_update"
AFTER UPDATE OF "status", "generation", "campaign_id"
ON "sim_campaign_conditions"
FOR EACH ROW
WHEN (
  NEW."status" IN ('active', 'kept')
  AND (
    OLD."status" NOT IN ('active', 'kept')
    OR OLD."generation" IS DISTINCT FROM NEW."generation"
    OR OLD."campaign_id" IS DISTINCT FROM NEW."campaign_id"
  )
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_campaign_points_admission_hazard_insert" ON "sim_campaign_points";
CREATE TRIGGER "sim_campaign_points_admission_hazard_insert"
AFTER INSERT ON "sim_campaign_points"
-- Campaign launch and plan edits materialize points in set-based statements.
-- Take the singleton once per statement, not once per point.
FOR EACH STATEMENT
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_campaign_points_admission_hazard_update" ON "sim_campaign_points";
CREATE OR REPLACE FUNCTION "sweeper_admission_hazard_point_update_lock"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- Releasing or symmetry-deriving a point can only remove it from every
  -- hazard predicate, so it must remain available to pause/cancel while an
  -- engine acceptance call owns the permit. Lock only when this statement can
  -- make at least one point newly eligible or retarget its hazard identity.
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT
        campaign_id,
        condition_id,
        airfoil_id,
        aoa_deg,
        revision_id,
        result_id,
        result_attempt_id
      FROM new_points
      WHERE state <> 'released'
        AND derived_by_symmetry = false

      EXCEPT

      SELECT
        campaign_id,
        condition_id,
        airfoil_id,
        aoa_deg,
        revision_id,
        result_id,
        result_attempt_id
      FROM old_points
      WHERE state <> 'released'
        AND derived_by_symmetry = false
    ) newly_eligible
    LIMIT 1
  ) THEN
    INSERT INTO sweeper_state (id)
    VALUES (1)
    ON CONFLICT (id) DO NOTHING;

    PERFORM state.id
    FROM sweeper_state state
    WHERE state.id = 1
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'sweeper_state singleton is missing while committing an admission hazard';
    END IF;
  END IF;
  RETURN NULL;
END;
$function$;
--> statement-breakpoint

CREATE TRIGGER "sim_campaign_points_admission_hazard_update"
AFTER UPDATE ON "sim_campaign_points"
REFERENCING OLD TABLE AS old_points NEW TABLE AS new_points
FOR EACH STATEMENT
EXECUTE FUNCTION "sweeper_admission_hazard_point_update_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_solver_incident_campaigns_admission_hazard_insert" ON "sim_solver_incident_campaigns";
CREATE TRIGGER "sim_solver_incident_campaigns_admission_hazard_insert"
AFTER INSERT ON "sim_solver_incident_campaigns"
FOR EACH ROW
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_solver_incident_campaigns_admission_hazard_update" ON "sim_solver_incident_campaigns";
CREATE TRIGGER "sim_solver_incident_campaigns_admission_hazard_update"
AFTER UPDATE OF "incident_id", "campaign_id"
ON "sim_solver_incident_campaigns"
FOR EACH ROW
WHEN (
  OLD."incident_id" IS DISTINCT FROM NEW."incident_id"
  OR OLD."campaign_id" IS DISTINCT FROM NEW."campaign_id"
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_precalc_obligation_campaigns_admission_hazard_insert" ON "sim_precalc_obligation_campaigns";
CREATE TRIGGER "sim_precalc_obligation_campaigns_admission_hazard_insert"
AFTER INSERT ON "sim_precalc_obligation_campaigns"
FOR EACH ROW
WHEN (NEW."state" = 'active')
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_precalc_obligation_campaigns_admission_hazard_update" ON "sim_precalc_obligation_campaigns";
CREATE TRIGGER "sim_precalc_obligation_campaigns_admission_hazard_update"
AFTER UPDATE OF "state", "obligation_id", "campaign_id"
ON "sim_precalc_obligation_campaigns"
FOR EACH ROW
WHEN (
  NEW."state" = 'active'
  AND (
    OLD."state" IS DISTINCT FROM 'active'
    OR OLD."obligation_id" IS DISTINCT FROM NEW."obligation_id"
    OR OLD."campaign_id" IS DISTINCT FROM NEW."campaign_id"
  )
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_urans_verify_queue_campaigns_admission_hazard_insert" ON "sim_urans_verify_queue_campaigns";
CREATE TRIGGER "sim_urans_verify_queue_campaigns_admission_hazard_insert"
AFTER INSERT ON "sim_urans_verify_queue_campaigns"
FOR EACH ROW
WHEN (NEW."state" = 'active')
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_urans_verify_queue_campaigns_admission_hazard_update" ON "sim_urans_verify_queue_campaigns";
CREATE TRIGGER "sim_urans_verify_queue_campaigns_admission_hazard_update"
AFTER UPDATE OF "state", "queue_id", "campaign_id"
ON "sim_urans_verify_queue_campaigns"
FOR EACH ROW
WHEN (
  NEW."state" = 'active'
  AND (
    OLD."state" IS DISTINCT FROM 'active'
    OR OLD."queue_id" IS DISTINCT FROM NEW."queue_id"
    OR OLD."campaign_id" IS DISTINCT FROM NEW."campaign_id"
  )
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_urans_request_campaigns_admission_hazard_insert" ON "sim_urans_request_campaigns";
CREATE TRIGGER "sim_urans_request_campaigns_admission_hazard_insert"
AFTER INSERT ON "sim_urans_request_campaigns"
FOR EACH ROW
WHEN (NEW."state" = 'active')
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_urans_request_campaigns_admission_hazard_update" ON "sim_urans_request_campaigns";
CREATE TRIGGER "sim_urans_request_campaigns_admission_hazard_update"
AFTER UPDATE OF "state", "request_id", "campaign_id"
ON "sim_urans_request_campaigns"
FOR EACH ROW
WHEN (
  NEW."state" = 'active'
  AND (
    OLD."state" IS DISTINCT FROM 'active'
    OR OLD."request_id" IS DISTINCT FROM NEW."request_id"
    OR OLD."campaign_id" IS DISTINCT FROM NEW."campaign_id"
  )
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_urans_verify_queue_requests_admission_hazard_insert" ON "sim_urans_verify_queue_requests";
CREATE TRIGGER "sim_urans_verify_queue_requests_admission_hazard_insert"
AFTER INSERT ON "sim_urans_verify_queue_requests"
FOR EACH ROW
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
--> statement-breakpoint

DROP TRIGGER IF EXISTS "sim_urans_verify_queue_requests_admission_hazard_update" ON "sim_urans_verify_queue_requests";
CREATE TRIGGER "sim_urans_verify_queue_requests_admission_hazard_update"
AFTER UPDATE OF "queue_id", "request_id"
ON "sim_urans_verify_queue_requests"
FOR EACH ROW
WHEN (
  OLD."queue_id" IS DISTINCT FROM NEW."queue_id"
  OR OLD."request_id" IS DISTINCT FROM NEW."request_id"
)
EXECUTE FUNCTION "sweeper_admission_hazard_transition_lock"();
