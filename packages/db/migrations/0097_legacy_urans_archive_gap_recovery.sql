-- A legacy URANS attempt without a current, verified GCS evidence archive
-- cannot be reinterpreted or continued safely.  Preserve that immutable
-- attempt and record one separately leased, bounded request for a *fresh*
-- FAST generation.  This ledger is intentionally distinct from
-- result_interpretation_recovery_actions: the latter requires an exact archive
-- and may authorize a same-case continuation; this table never can.
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "legacy_urans_archive_gap_recovery_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL REFERENCES "results"("id") ON DELETE CASCADE,
  "result_attempt_id" uuid NOT NULL,
  "source_condition" text NOT NULL DEFAULT 'missing_current_verified_gcs_archive',
  "fidelity" text NOT NULL DEFAULT 'urans_precalc',
  "state" text NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "claim_token" uuid,
  "claim_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "target_urans_request_id" uuid REFERENCES "sim_urans_requests"("id") ON DELETE RESTRICT,
  "decision_reason" text,
  "last_error" text,
  "created_by" text NOT NULL DEFAULT 'legacy-archive-gap-planner',
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "legacy_urans_archive_gap_recovery_attempt_owner_fk"
    FOREIGN KEY ("result_attempt_id", "result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE CASCADE,
  CONSTRAINT "legacy_urans_archive_gap_recovery_source_condition_check"
    CHECK ("source_condition" = 'missing_current_verified_gcs_archive'),
  CONSTRAINT "legacy_urans_archive_gap_recovery_fidelity_check"
    CHECK ("fidelity" = 'urans_precalc'),
  CONSTRAINT "legacy_urans_archive_gap_recovery_state_check"
    CHECK ("state" IN ('pending', 'routing', 'fresh_rerun_routed', 'satisfied', 'blocked', 'cancelled')),
  CONSTRAINT "legacy_urans_archive_gap_recovery_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "legacy_urans_archive_gap_recovery_lease_shape_check"
    CHECK ((
      "state" = 'routing'
      AND "claim_token" IS NOT NULL
      AND "claim_expires_at" IS NOT NULL
    ) OR (
      "state" <> 'routing'
      AND "claim_token" IS NULL
      AND "claim_expires_at" IS NULL
    )),
  CONSTRAINT "legacy_urans_archive_gap_recovery_routed_target_check"
    CHECK (
      "state" <> 'fresh_rerun_routed'
      OR "target_urans_request_id" IS NOT NULL
    ),
  CONSTRAINT "legacy_urans_archive_gap_recovery_created_by_check"
    CHECK (btrim("created_by") <> '')
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "legacy_urans_archive_gap_recovery_source_uq"
  ON "legacy_urans_archive_gap_recovery_actions" ("result_attempt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legacy_urans_archive_gap_recovery_ready_idx"
  ON "legacy_urans_archive_gap_recovery_actions" ("state", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legacy_urans_archive_gap_recovery_lease_idx"
  ON "legacy_urans_archive_gap_recovery_actions" ("state", "claim_expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "legacy_urans_archive_gap_recovery_request_idx"
  ON "legacy_urans_archive_gap_recovery_actions" ("target_urans_request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "legacy_urans_archive_gap_recovery_active_request_uq"
  ON "legacy_urans_archive_gap_recovery_actions" ("target_urans_request_id")
  WHERE "target_urans_request_id" IS NOT NULL
    AND "state" = 'fresh_rerun_routed';

