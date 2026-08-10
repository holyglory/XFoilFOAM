-- Production already applied different migrations at journal timestamps
-- 0091–0093 (remote promise TTL, result-media index, and immutable-attempt
-- ingest completion).  The unpublished interpretation ledger reused those
-- timestamps locally, so Drizzle correctly skips it on an upgraded production
-- database.  Migrations 0094/0095 are deliberately prerequisite-safe; this
-- later, append-only reconciliation installs the complete final ledger shape
-- after those two entries have been safely observed.
--
-- Every DDL operation below is idempotent.  It converges both an upgraded
-- production database (where the historical 0091–0093 entries already exist)
-- and an older developer database where the unpublished ledger happened to
-- run before the source lineage was corrected.  Fresh databases now receive
-- the exact historical 0091–0093 files before reaching this reconciliation.
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type type_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
    WHERE namespace_row.nspname = 'public'
      AND type_row.typname = 'result_interpretation_state'
  ) THEN
    EXECUTE 'CREATE TYPE "result_interpretation_state" AS ENUM (''accepted'', ''continuation_required'', ''terminal_failure'', ''legacy_uncertified'')';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type type_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
    WHERE namespace_row.nspname = 'public'
      AND type_row.typname = 'result_interpretation_regime'
  ) THEN
    EXECUTE 'CREATE TYPE "result_interpretation_regime" AS ENUM (''legacy_engine_reported'', ''rans_hold'', ''steady_equivalent'', ''periodic'', ''broadband_stationary'', ''trending_unresolved'')';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_type type_row
    JOIN pg_namespace namespace_row ON namespace_row.oid = type_row.typnamespace
    WHERE namespace_row.nspname = 'public'
      AND type_row.typname = 'result_interpretation_cycle_disposition'
  ) THEN
    EXECUTE 'CREATE TYPE "result_interpretation_cycle_disposition" AS ENUM (''selected'', ''startup'', ''hard_corrupt'', ''settling_outlier'', ''cadence_unresolved'', ''numerically_noisy'', ''insufficient_frames'')';
  END IF;
END $$;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "result_reducer_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reducer_key" text NOT NULL,
  "reducer_version" text NOT NULL,
  "build_id" text NOT NULL,
  "policy_sha256" text NOT NULL,
  "policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source" text DEFAULT 'application' NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_reducer_versions_policy_sha_check"
    CHECK ("policy_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "result_reducer_versions_text_shape_check"
    CHECK (
      btrim("reducer_key") <> ''
      AND btrim("reducer_version") <> ''
      AND btrim("build_id") <> ''
      AND btrim("source") <> ''
    ),
  CONSTRAINT "result_reducer_versions_policy_shape_check"
    CHECK (jsonb_typeof("policy") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "result_reducer_versions_identity_uq"
  ON "result_reducer_versions" (
    "reducer_key", "reducer_version", "build_id", "policy_sha256"
  );
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "result_attempt_mesh_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL REFERENCES "results"("id") ON DELETE CASCADE,
  "result_attempt_id" uuid NOT NULL,
  "fingerprint_version" integer NOT NULL,
  "content_sha256" text NOT NULL,
  "recipe_sha256" text NOT NULL,
  "resolved_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "source" text NOT NULL,
  "source_evidence_signature" text NOT NULL,
  "source_archive_id" uuid,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_attempt_mesh_identities_attempt_owner_fk"
    FOREIGN KEY ("result_attempt_id", "result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE CASCADE,
  CONSTRAINT "result_attempt_mesh_identities_archive_owner_fk"
    FOREIGN KEY ("source_archive_id", "result_attempt_id")
    REFERENCES "solver_evidence_archives"("id", "result_attempt_id")
    ON DELETE RESTRICT,
  CONSTRAINT "result_attempt_mesh_identities_fingerprint_version_check"
    CHECK ("fingerprint_version" > 0),
  CONSTRAINT "result_attempt_mesh_identities_sha_check"
    CHECK (
      "content_sha256" ~ '^[0-9a-f]{64}$'
      AND "recipe_sha256" ~ '^[0-9a-f]{64}$'
    ),
  CONSTRAINT "result_attempt_mesh_identities_resolved_params_check"
    CHECK (jsonb_typeof("resolved_params") = 'object'),
  CONSTRAINT "result_attempt_mesh_identities_source_check"
    CHECK (
      "source" IN ('engine_reported', 'archive_backfill')
      AND btrim("source_evidence_signature") <> ''
      AND (
        ("source" = 'archive_backfill' AND "source_archive_id" IS NOT NULL)
        OR ("source" = 'engine_reported' AND "source_archive_id" IS NULL)
      )
    ),
  CONSTRAINT "result_attempt_mesh_identities_id_attempt_uq"
    UNIQUE ("id", "result_attempt_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "result_attempt_mesh_identities_attempt_fingerprint_uq"
  ON "result_attempt_mesh_identities" ("result_attempt_id", "fingerprint_version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_attempt_mesh_identities_content_idx"
  ON "result_attempt_mesh_identities" ("fingerprint_version", "content_sha256");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_attempt_mesh_identities_result_idx"
  ON "result_attempt_mesh_identities" ("result_id", "createdAt");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "result_interpretations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL REFERENCES "results"("id") ON DELETE CASCADE,
  "result_attempt_id" uuid NOT NULL,
  "reducer_version_id" uuid NOT NULL
    REFERENCES "result_reducer_versions"("id") ON DELETE RESTRICT,
  "mesh_identity_id" uuid,
  "source_archive_id" uuid,
  "source" text NOT NULL,
  "input_evidence_signature" text NOT NULL,
  "state" "result_interpretation_state" NOT NULL,
  "regime" "result_interpretation_regime" NOT NULL,
  "continuation_reason" text,
  "terminal_reason" text,
  "selected_window" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "statistics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "diagnostics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "cl" double precision,
  "cd" double precision,
  "cm" double precision,
  "cl_cd" double precision,
  "cl_waveform_rms" double precision,
  "cd_waveform_rms" double precision,
  "cm_waveform_rms" double precision,
  "cl_standard_error" double precision,
  "cd_standard_error" double precision,
  "cm_standard_error" double precision,
  "cl_ci95_low" double precision,
  "cl_ci95_high" double precision,
  "cd_ci95_low" double precision,
  "cd_ci95_high" double precision,
  "cm_ci95_low" double precision,
  "cm_ci95_high" double precision,
  "cl_cd_ci95_low" double precision,
  "cl_cd_ci95_high" double precision,
  "cl_cd_interval_state" text DEFAULT 'unavailable' NOT NULL,
  "uncertainty_basis" text DEFAULT 'not_available' NOT NULL,
  "effective_blocks" integer,
  "max_iat_seconds" double precision,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_interpretations_attempt_owner_fk"
    FOREIGN KEY ("result_attempt_id", "result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE CASCADE,
  CONSTRAINT "result_interpretations_mesh_owner_fk"
    FOREIGN KEY ("mesh_identity_id", "result_attempt_id")
    REFERENCES "result_attempt_mesh_identities"("id", "result_attempt_id")
    ON DELETE RESTRICT,
  CONSTRAINT "result_interpretations_archive_owner_fk"
    FOREIGN KEY ("source_archive_id", "result_attempt_id")
    REFERENCES "solver_evidence_archives"("id", "result_attempt_id")
    ON DELETE RESTRICT,
  CONSTRAINT "result_interpretations_json_shape_check"
    CHECK (
      jsonb_typeof("selected_window") = 'object'
      AND jsonb_typeof("statistics") = 'object'
      AND jsonb_typeof("diagnostics") = 'object'
    ),
  CONSTRAINT "result_interpretations_source_check"
    CHECK (
      "source" IN (
        'engine_reported', 'archive_backfill', 'continuation', 'corrective_generation'
      )
      AND btrim("input_evidence_signature") <> ''
      AND (
        ("source" = 'archive_backfill' AND "source_archive_id" IS NOT NULL)
        OR "source" <> 'archive_backfill'
      )
    ),
  CONSTRAINT "result_interpretations_state_shape_check"
    CHECK (
      (
        "state" = 'accepted'
        AND "cl" IS NOT NULL
        AND "cd" IS NOT NULL
        AND "cm" IS NOT NULL
        AND "continuation_reason" IS NULL
        AND "terminal_reason" IS NULL
      ) OR (
        "state" = 'continuation_required'
        AND btrim(COALESCE("continuation_reason", '')) <> ''
        AND "terminal_reason" IS NULL
        AND "cl" IS NULL
        AND "cd" IS NULL
        AND "cm" IS NULL
        AND "cl_cd" IS NULL
      ) OR (
        "state" = 'terminal_failure'
        AND btrim(COALESCE("terminal_reason", '')) <> ''
        AND "continuation_reason" IS NULL
        AND "cl" IS NULL
        AND "cd" IS NULL
        AND "cm" IS NULL
        AND "cl_cd" IS NULL
      ) OR (
        "state" = 'legacy_uncertified'
        AND "regime" = 'legacy_engine_reported'
        AND "continuation_reason" IS NULL
        AND "terminal_reason" IS NULL
      )
    ),
  CONSTRAINT "result_interpretations_cl_cd_interval_state_check"
    CHECK ("cl_cd_interval_state" IN ('bounded', 'unbounded', 'unavailable')),
  CONSTRAINT "result_interpretations_uncertainty_basis_check"
    CHECK (
      "uncertainty_basis" IN (
        'paired_cycles', 'paired_blocks', 'stability_envelope',
        'numerical_plateau', 'legacy_engine_reported', 'not_available'
      )
    ),
  CONSTRAINT "result_interpretations_effective_blocks_check"
    CHECK ("effective_blocks" IS NULL OR "effective_blocks" >= 0),
  CONSTRAINT "result_interpretations_max_iat_check"
    CHECK ("max_iat_seconds" IS NULL OR "max_iat_seconds" >= 0),
  CONSTRAINT "result_interpretations_id_result_uq" UNIQUE ("id", "result_id"),
  CONSTRAINT "result_interpretations_id_attempt_result_uq"
    UNIQUE ("id", "result_attempt_id", "result_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "result_interpretations_attempt_reducer_evidence_uq"
  ON "result_interpretations" (
    "result_attempt_id", "reducer_version_id", "input_evidence_signature"
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretations_result_created_idx"
  ON "result_interpretations" ("result_id", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretations_attempt_created_idx"
  ON "result_interpretations" ("result_attempt_id", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretations_state_idx"
  ON "result_interpretations" ("state", "createdAt");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "result_interpretation_cycles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL REFERENCES "results"("id") ON DELETE CASCADE,
  "result_attempt_id" uuid NOT NULL,
  "result_interpretation_id" uuid NOT NULL,
  "cycle_index" integer NOT NULL,
  "start_time_s" double precision NOT NULL,
  "end_time_s" double precision NOT NULL,
  "period_s" double precision NOT NULL,
  "disposition" "result_interpretation_cycle_disposition" NOT NULL,
  "coefficient_sample_count" integer NOT NULL,
  "field_frame_count" integer NOT NULL,
  "phase_max_gap_fraction" double precision,
  "metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_interpretation_cycles_interpretation_owner_fk"
    FOREIGN KEY ("result_interpretation_id", "result_attempt_id", "result_id")
    REFERENCES "result_interpretations"("id", "result_attempt_id", "result_id")
    ON DELETE CASCADE,
  CONSTRAINT "result_interpretation_cycles_time_shape_check"
    CHECK (
      "cycle_index" >= 0
      AND "start_time_s" >= 0
      AND "end_time_s" > "start_time_s"
      AND "period_s" > 0
    ),
  CONSTRAINT "result_interpretation_cycles_count_check"
    CHECK ("coefficient_sample_count" >= 0 AND "field_frame_count" >= 0),
  CONSTRAINT "result_interpretation_cycles_gap_check"
    CHECK (
      "phase_max_gap_fraction" IS NULL
      OR ("phase_max_gap_fraction" >= 0 AND "phase_max_gap_fraction" <= 1)
    ),
  CONSTRAINT "result_interpretation_cycles_metrics_check"
    CHECK (jsonb_typeof("metrics") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "result_interpretation_cycles_interpretation_cycle_uq"
  ON "result_interpretation_cycles" ("result_interpretation_id", "cycle_index");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretation_cycles_attempt_idx"
  ON "result_interpretation_cycles" ("result_attempt_id", "cycle_index");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "result_interpretation_backfill_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reducer_version_id" uuid NOT NULL
    REFERENCES "result_reducer_versions"("id") ON DELETE RESTRICT,
  "state" text DEFAULT 'planned' NOT NULL,
  "scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "requested_by" text DEFAULT 'system' NOT NULL,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_interpretation_backfill_runs_state_check"
    CHECK ("state" IN ('planned', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT "result_interpretation_backfill_runs_json_shape_check"
    CHECK (jsonb_typeof("scope") = 'object' AND jsonb_typeof("summary") = 'object'),
  CONSTRAINT "result_interpretation_backfill_runs_requested_by_check"
    CHECK (btrim("requested_by") <> '')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretation_backfill_runs_reducer_idx"
  ON "result_interpretation_backfill_runs" ("reducer_version_id", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretation_backfill_runs_state_idx"
  ON "result_interpretation_backfill_runs" ("state", "createdAt");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "result_interpretation_backfill_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL
    REFERENCES "result_interpretation_backfill_runs"("id") ON DELETE CASCADE,
  "result_id" uuid NOT NULL REFERENCES "results"("id") ON DELETE CASCADE,
  "result_attempt_id" uuid NOT NULL,
  "source_archive_id" uuid,
  "state" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "claim_token" uuid,
  "claim_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_error" text,
  "result_interpretation_id" uuid,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_interpretation_backfill_items_attempt_owner_fk"
    FOREIGN KEY ("result_attempt_id", "result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE CASCADE,
  CONSTRAINT "result_interpretation_backfill_items_archive_owner_fk"
    FOREIGN KEY ("source_archive_id", "result_attempt_id")
    REFERENCES "solver_evidence_archives"("id", "result_attempt_id")
    ON DELETE RESTRICT,
  CONSTRAINT "result_interpretation_backfill_items_interpretation_owner_fk"
    FOREIGN KEY ("result_interpretation_id", "result_attempt_id", "result_id")
    REFERENCES "result_interpretations"("id", "result_attempt_id", "result_id")
    ON DELETE RESTRICT,
  CONSTRAINT "result_interpretation_backfill_items_state_check"
    CHECK (
      "state" IN (
        'pending', 'hydrating', 'reduced', 'missing_evidence',
        'continuation_required', 'rerun_required', 'terminal_failure', 'failed'
      )
    ),
  CONSTRAINT "result_interpretation_backfill_items_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "result_interpretation_backfill_items_lease_shape_check"
    CHECK (
      (
        "state" = 'hydrating'
        AND "claim_token" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL
      ) OR (
        "state" <> 'hydrating'
        AND "claim_token" IS NULL
        AND "claim_expires_at" IS NULL
      )
    ),
  CONSTRAINT "result_interpretation_backfill_items_reduced_shape_check"
    CHECK ("state" <> 'reduced' OR "result_interpretation_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "result_interpretation_backfill_items_run_attempt_uq"
  ON "result_interpretation_backfill_items" ("run_id", "result_attempt_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretation_backfill_items_ready_idx"
  ON "result_interpretation_backfill_items" ("state", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretation_backfill_items_lease_idx"
  ON "result_interpretation_backfill_items" ("state", "claim_expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretation_backfill_items_run_idx"
  ON "result_interpretation_backfill_items" ("run_id", "state");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "result_canonical_selections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL REFERENCES "results"("id") ON DELETE CASCADE,
  "result_attempt_id" uuid NOT NULL,
  "result_interpretation_id" uuid NOT NULL,
  "backfill_run_id" uuid
    REFERENCES "result_interpretation_backfill_runs"("id") ON DELETE RESTRICT,
  "selection_namespace" text NOT NULL,
  "reason" text NOT NULL,
  "actor" text DEFAULT 'system' NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_canonical_selections_attempt_owner_fk"
    FOREIGN KEY ("result_attempt_id", "result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE CASCADE,
  CONSTRAINT "result_canonical_selections_interpretation_owner_fk"
    FOREIGN KEY ("result_interpretation_id", "result_attempt_id", "result_id")
    REFERENCES "result_interpretations"("id", "result_attempt_id", "result_id")
    ON DELETE RESTRICT,
  CONSTRAINT "result_canonical_selections_id_result_uq"
    UNIQUE ("id", "result_id"),
  CONSTRAINT "result_canonical_selections_text_shape_check"
    CHECK (
      btrim("selection_namespace") <> ''
      AND btrim("reason") <> ''
      AND btrim("actor") <> ''
    )
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_canonical_selections_result_created_idx"
  ON "result_canonical_selections" ("result_id", "createdAt");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_canonical_selections_namespace_idx"
  ON "result_canonical_selections" ("selection_namespace", "createdAt");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "result_interpretation_recovery_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL REFERENCES "results"("id") ON DELETE CASCADE,
  "result_attempt_id" uuid NOT NULL,
  "source_archive_id" uuid NOT NULL,
  "input_evidence_signature" text NOT NULL,
  "fidelity" text NOT NULL,
  "requested_action" text NOT NULL,
  "corrective_tail_periods" integer,
  "state" text DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "claim_token" uuid,
  "claim_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "target_urans_request_id" uuid REFERENCES "sim_urans_requests"("id")
    ON DELETE RESTRICT,
  "target_verify_queue_id" uuid REFERENCES "sim_urans_verify_queue"("id")
    ON DELETE RESTRICT,
  "decision_reason" text,
  "last_error" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "result_interpretation_recovery_actions_attempt_owner_fk"
    FOREIGN KEY ("result_attempt_id", "result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE CASCADE,
  CONSTRAINT "result_interpretation_recovery_actions_archive_owner_fk"
    FOREIGN KEY ("source_archive_id", "result_attempt_id")
    REFERENCES "solver_evidence_archives"("id", "result_attempt_id")
    ON DELETE RESTRICT,
  CONSTRAINT "result_interpretation_recovery_actions_signature_check"
    CHECK ("input_evidence_signature" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "result_interpretation_recovery_actions_fidelity_check"
    CHECK ("fidelity" IN ('urans_precalc', 'urans_full')),
  CONSTRAINT "result_interpretation_recovery_actions_action_check"
    CHECK ("requested_action" IN (
      'continue_exact_case', 'verify_restart_proof_then_rerun'
    )),
  CONSTRAINT "ri_recovery_tail_periods_ck"
    CHECK (
      "corrective_tail_periods" IS NULL
      OR "corrective_tail_periods" BETWEEN 1 AND 3
    ),
  CONSTRAINT "result_interpretation_recovery_actions_state_check"
    CHECK ("state" IN (
      'pending', 'routing', 'waiting_for_precalc',
      'continuation_routed', 'fresh_rerun_routed',
      'satisfied', 'blocked', 'cancelled'
    )),
  CONSTRAINT "result_interpretation_recovery_actions_attempt_count_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "result_interpretation_recovery_actions_lease_shape_check"
    CHECK (
      ("state" = 'routing'
        AND "claim_token" IS NOT NULL
        AND "claim_expires_at" IS NOT NULL)
      OR
      ("state" <> 'routing'
        AND "claim_token" IS NULL
        AND "claim_expires_at" IS NULL)
    ),
  CONSTRAINT "result_interpretation_recovery_actions_target_shape_check"
    CHECK (NOT (
      "target_urans_request_id" IS NOT NULL
      AND "target_verify_queue_id" IS NOT NULL
    )),
  CONSTRAINT "result_interpretation_recovery_actions_routed_target_check"
    CHECK (
      "state" NOT IN (
        'waiting_for_precalc', 'continuation_routed', 'fresh_rerun_routed'
      )
      OR (
        "state" IN ('waiting_for_precalc', 'fresh_rerun_routed')
        AND "target_urans_request_id" IS NOT NULL
        AND "target_verify_queue_id" IS NULL
      )
      OR (
        "state" = 'continuation_routed'
        AND (
          ("target_urans_request_id" IS NOT NULL
            AND "target_verify_queue_id" IS NULL)
          OR ("target_urans_request_id" IS NULL
            AND "target_verify_queue_id" IS NOT NULL)
        )
      )
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "result_interpretation_recovery_actions_source_fidelity_uq"
  ON "result_interpretation_recovery_actions" (
    "result_attempt_id", "source_archive_id", "fidelity"
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretation_recovery_actions_ready_idx"
  ON "result_interpretation_recovery_actions" ("state", "next_attempt_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretation_recovery_actions_lease_idx"
  ON "result_interpretation_recovery_actions" ("state", "claim_expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretation_recovery_actions_request_idx"
  ON "result_interpretation_recovery_actions" ("target_urans_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_interpretation_recovery_actions_verify_idx"
  ON "result_interpretation_recovery_actions" ("target_verify_queue_id");
--> statement-breakpoint

ALTER TABLE "results"
  ADD COLUMN IF NOT EXISTS "current_result_interpretation_id" uuid;
--> statement-breakpoint
ALTER TABLE "results"
  ADD COLUMN IF NOT EXISTS "current_canonical_selection_id" uuid;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.results'::regclass
      AND conname = 'results_current_interpretation_owner_fk'
  ) THEN
    ALTER TABLE "results"
      ADD CONSTRAINT "results_current_interpretation_owner_fk"
      FOREIGN KEY ("current_result_interpretation_id", "id")
      REFERENCES "result_interpretations"("id", "result_id") ON DELETE NO ACTION;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.results'::regclass
      AND conname = 'results_current_canonical_selection_owner_fk'
  ) THEN
    ALTER TABLE "results"
      ADD CONSTRAINT "results_current_canonical_selection_owner_fk"
      FOREIGN KEY ("current_canonical_selection_id", "id")
      REFERENCES "result_canonical_selections"("id", "result_id") ON DELETE NO ACTION;
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "results_current_interpretation_idx"
  ON "results" ("current_result_interpretation_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "results_current_canonical_selection_idx"
  ON "results" ("current_canonical_selection_id");
--> statement-breakpoint

-- Reducers, fingerprints, interpretations, cycle audits, and selection
-- events are append-only.  Cascading parent cleanup remains allowed.
CREATE OR REPLACE FUNCTION "reject_result_interpretation_ledger_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_result_canonical_selection"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  interpretation_state "result_interpretation_state";
BEGIN
  SELECT "state"
  INTO interpretation_state
  FROM "result_interpretations"
  WHERE "id" = NEW."result_interpretation_id"
    AND "result_attempt_id" = NEW."result_attempt_id"
    AND "result_id" = NEW."result_id";

  IF NOT FOUND OR interpretation_state NOT IN ('accepted', 'legacy_uncertified') THEN
    RAISE EXCEPTION 'canonical selection requires an accepted or legacy interpretation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_result_interpretation_projection"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."current_result_interpretation_id" IS NULL
     AND NEW."current_canonical_selection_id" IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW."current_result_interpretation_id" IS NULL
     OR NEW."current_canonical_selection_id" IS NULL THEN
    RAISE EXCEPTION 'result current interpretation and selection pointers must be set or cleared together';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM "result_canonical_selections" selection
    WHERE selection."id" = NEW."current_canonical_selection_id"
      AND selection."result_id" = NEW."id"
      AND selection."result_interpretation_id" = NEW."current_result_interpretation_id"
  ) THEN
    RAISE EXCEPTION 'result current interpretation must match its canonical selection';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.result_reducer_versions'::regclass
      AND tgname = 'result_reducer_versions_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "result_reducer_versions_append_only"
    BEFORE UPDATE OR DELETE ON "result_reducer_versions"
    FOR EACH ROW EXECUTE FUNCTION "reject_result_interpretation_ledger_mutation"();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.result_attempt_mesh_identities'::regclass
      AND tgname = 'result_attempt_mesh_identities_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "result_attempt_mesh_identities_append_only"
    BEFORE UPDATE OR DELETE ON "result_attempt_mesh_identities"
    FOR EACH ROW EXECUTE FUNCTION "reject_result_interpretation_ledger_mutation"();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.result_interpretations'::regclass
      AND tgname = 'result_interpretations_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "result_interpretations_append_only"
    BEFORE UPDATE OR DELETE ON "result_interpretations"
    FOR EACH ROW EXECUTE FUNCTION "reject_result_interpretation_ledger_mutation"();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.result_interpretation_cycles'::regclass
      AND tgname = 'result_interpretation_cycles_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "result_interpretation_cycles_append_only"
    BEFORE UPDATE OR DELETE ON "result_interpretation_cycles"
    FOR EACH ROW EXECUTE FUNCTION "reject_result_interpretation_ledger_mutation"();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.result_canonical_selections'::regclass
      AND tgname = 'result_canonical_selections_append_only'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "result_canonical_selections_append_only"
    BEFORE UPDATE OR DELETE ON "result_canonical_selections"
    FOR EACH ROW EXECUTE FUNCTION "reject_result_interpretation_ledger_mutation"();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.result_canonical_selections'::regclass
      AND tgname = 'result_canonical_selections_validate_insert'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "result_canonical_selections_validate_insert"
    BEFORE INSERT ON "result_canonical_selections"
    FOR EACH ROW EXECUTE FUNCTION "validate_result_canonical_selection"();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.results'::regclass
      AND tgname = 'results_validate_interpretation_projection'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER "results_validate_interpretation_projection"
    BEFORE INSERT OR UPDATE OF
      "current_result_interpretation_id", "current_canonical_selection_id"
    ON "results"
    FOR EACH ROW EXECUTE FUNCTION "validate_result_interpretation_projection"();
  END IF;
END $$;
--> statement-breakpoint

-- 0095 must run after the recovery table exists.  Preserve the earliest live
-- receipt, terminalize only competing handoffs, then make the invariant
-- durable.  On fresh histories the unique indexes already exist and this is a
-- no-op except for the harmless duplicate scan.
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY target_urans_request_id
      ORDER BY "createdAt" ASC, id ASC
    ) AS ownership_rank
  FROM "result_interpretation_recovery_actions"
  WHERE "target_urans_request_id" IS NOT NULL
    AND "state" IN (
      'waiting_for_precalc', 'continuation_routed', 'fresh_rerun_routed'
    )
)
UPDATE "result_interpretation_recovery_actions" action
SET "state" = 'blocked',
    "claim_token" = NULL,
    "claim_expires_at" = NULL,
    "decision_reason" =
      'a prior archive recovery action already owns this active URANS request',
    "last_error" =
      'migration fenced a competing archive recovery action; the existing request owner remains authoritative',
    "next_attempt_at" = now(),
    "updatedAt" = now()
FROM ranked
WHERE action."id" = ranked.id
  AND ranked.ownership_rank > 1;
--> statement-breakpoint
WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY target_verify_queue_id
      ORDER BY "createdAt" ASC, id ASC
    ) AS ownership_rank
  FROM "result_interpretation_recovery_actions"
  WHERE "target_verify_queue_id" IS NOT NULL
    AND "state" = 'continuation_routed'
)
UPDATE "result_interpretation_recovery_actions" action
SET "state" = 'blocked',
    "claim_token" = NULL,
    "claim_expires_at" = NULL,
    "decision_reason" =
      'a prior archive recovery action already owns this active FINAL verify queue',
    "last_error" =
      'migration fenced a competing archive recovery action; the existing verify queue owner remains authoritative',
    "next_attempt_at" = now(),
    "updatedAt" = now()
FROM ranked
WHERE action."id" = ranked.id
  AND ranked.ownership_rank > 1;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ri_recovery_active_request_owner_uq"
  ON "result_interpretation_recovery_actions" ("target_urans_request_id")
  WHERE "target_urans_request_id" IS NOT NULL
    AND "state" IN (
      'waiting_for_precalc', 'continuation_routed', 'fresh_rerun_routed'
    );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ri_recovery_active_verify_owner_uq"
  ON "result_interpretation_recovery_actions" ("target_verify_queue_id")
  WHERE "target_verify_queue_id" IS NOT NULL
    AND "state" = 'continuation_routed';
