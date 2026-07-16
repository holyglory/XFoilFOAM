-- OpenCFD 2606 is a new immutable numerical implementation and a new
-- operational route. The 2406 rows remain addressable forever because
-- historical jobs/evidence reference them. The prepare stage disables and
-- retires old admission while already accepted jobs drain; it never deletes
-- or relabels those historical rows.
INSERT INTO "solver_implementations" (
  "id", "key", "family", "distribution", "release_version",
  "method_family", "adapter_contract_version", "numerics_revision",
  "capabilities", "upstream_url", "license_spdx"
) VALUES (
  '2f8bc764-09ae-4ff3-8fd2-260600000001',
  'openfoam:opencfd:2606:adapter-v1:numerics-v1',
  'openfoam', 'opencfd', '2606', 'finite_volume_rans_urans', 1, '1',
  '{"methodKeys":["openfoam.rans","openfoam.urans"],"dimensionality":["2d"],"evidence":["coefficients","mesh","fields","logs"]}'::jsonb,
  'https://gitlab.com/openfoam/core/openfoam/-/tree/OpenFOAM-v2606',
  'GPL-3.0-or-later'
);
--> statement-breakpoint
INSERT INTO "solver_execution_pools" (
  "id", "slug", "name", "solver_implementation_id", "routing_key",
  "capacity_kind", "capacity_limit", "enabled", "metadata"
) VALUES (
  '3f8bc764-09ae-4ff3-8fd2-260600000001',
  'openfoam-opencfd-2606', 'OpenFOAM OpenCFD 2606',
  '2f8bc764-09ae-4ff3-8fd2-260600000001',
  'openfoam-opencfd-2606', 'cpu_slots', NULL, false, '{}'::jsonb
);
--> statement-breakpoint

-- A machine-verifiable production canary receipt is immutable evidence about
-- one exact runtime/pool pair. Composite FKs prevent a receipt from pairing a
-- runtime or route owned by a different logical implementation.
CREATE TABLE "solver_engine_canary_attestations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "solver_implementation_id" uuid NOT NULL REFERENCES "solver_implementations"("id"),
  "solver_runtime_build_id" uuid NOT NULL REFERENCES "solver_runtime_builds"("id"),
  "solver_execution_pool_id" uuid NOT NULL REFERENCES "solver_execution_pools"("id"),
  "receipt_sha256" text NOT NULL UNIQUE,
  "receipt" jsonb NOT NULL,
  "attested_by" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_engine_canary_attestations_receipt_sha256_check"
    CHECK ("receipt_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_engine_canary_attestations_runtime_owner_fk"
    FOREIGN KEY ("solver_runtime_build_id", "solver_implementation_id")
    REFERENCES "solver_runtime_builds"("id", "solver_implementation_id"),
  CONSTRAINT "solver_engine_canary_attestations_pool_owner_fk"
    FOREIGN KEY ("solver_execution_pool_id", "solver_implementation_id")
    REFERENCES "solver_execution_pools"("id", "solver_implementation_id")
);
--> statement-breakpoint
CREATE INDEX "solver_engine_canary_attestations_implementation_created_idx"
  ON "solver_engine_canary_attestations" ("solver_implementation_id", "createdAt");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_solver_engine_canary_attestation_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver engine canary attestations are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_engine_canary_attestations_immutable"
BEFORE UPDATE OR DELETE ON "solver_engine_canary_attestations"
FOR EACH ROW EXECUTE FUNCTION reject_solver_engine_canary_attestation_mutation();
--> statement-breakpoint

-- New mutable profiles select 2606 by default. Existing rows are deliberately
-- migrated by the explicit prepare stage so admission closure, campaign pause,
-- and audit creation happen together rather than as an implicit DDL side
-- effect.
ALTER TABLE "solver_profiles"
  ALTER COLUMN "solver_implementation_id"
  SET DEFAULT '2f8bc764-09ae-4ff3-8fd2-260600000001';
--> statement-breakpoint

ALTER TABLE "sim_campaigns"
  ADD COLUMN "current_condition_generation" integer DEFAULT 1 NOT NULL,
  ADD CONSTRAINT "sim_campaigns_condition_generation_check"
    CHECK ("current_condition_generation" > 0);
--> statement-breakpoint

ALTER TABLE "sim_campaign_conditions"
  ADD COLUMN "generation" integer DEFAULT 1 NOT NULL,
  ADD COLUMN "supersedes_condition_id" uuid,
  ADD COLUMN "superseded_at" timestamp with time zone,
  ADD CONSTRAINT "sim_campaign_conditions_generation_check"
    CHECK ("generation" > 0),
  ADD CONSTRAINT "sim_campaign_conditions_supersession_shape_check"
    CHECK (
      ("status" = 'superseded' AND "superseded_at" IS NOT NULL)
      OR ("status" <> 'superseded' AND "superseded_at" IS NULL)
    ),
  ADD CONSTRAINT "sim_campaign_conditions_supersedes_condition_fk"
    FOREIGN KEY ("supersedes_condition_id")
    REFERENCES "sim_campaign_conditions"("id") ON DELETE SET NULL;
--> statement-breakpoint
DROP INDEX "sim_campaign_conditions_combo_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "sim_campaign_conditions_combo_uq"
  ON "sim_campaign_conditions" (
    "campaign_id", "flow_condition_id", "reference_geometry_profile_id",
    "generation"
  );
--> statement-breakpoint
CREATE INDEX "sim_campaign_conditions_campaign_generation_idx"
  ON "sim_campaign_conditions" ("campaign_id", "generation", "status");
--> statement-breakpoint
CREATE UNIQUE INDEX "sim_campaign_conditions_supersedes_uq"
  ON "sim_campaign_conditions" ("supersedes_condition_id")
  WHERE "supersedes_condition_id" IS NOT NULL;
--> statement-breakpoint

-- One append-only staged cutover record per successor campaign generation.
-- The source and target condition rows retain exact revision-level lineage;
-- this record captures the operational 2406 -> 2606 maintenance workflow.
CREATE TABLE "sim_campaign_solver_cutovers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "campaign_id" uuid NOT NULL REFERENCES "sim_campaigns"("id") ON DELETE CASCADE,
  "from_solver_implementation_id" uuid NOT NULL REFERENCES "solver_implementations"("id"),
  "to_solver_implementation_id" uuid NOT NULL REFERENCES "solver_implementations"("id"),
  "canary_attestation_id" uuid REFERENCES "solver_engine_canary_attestations"("id"),
  "source_plan_revision_id" uuid NOT NULL REFERENCES "sim_campaign_plan_revisions"("id"),
  "target_plan_revision_id" uuid REFERENCES "sim_campaign_plan_revisions"("id"),
  "source_generation" integer NOT NULL,
  "target_generation" integer NOT NULL,
  "prior_campaign_status" text NOT NULL,
  "status" text DEFAULT 'prepared' NOT NULL,
  "reason" text,
  "prepared_by" text,
  "finalized_by" text,
  "completed_by" text,
  "source_condition_count" integer DEFAULT 0 NOT NULL,
  "target_condition_count" integer DEFAULT 0 NOT NULL,
  "target_point_count" integer DEFAULT 0 NOT NULL,
  "prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finalized_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "sim_campaign_solver_cutovers_generation_check"
    CHECK ("source_generation" > 0 AND "target_generation" = "source_generation" + 1),
  CONSTRAINT "sim_campaign_solver_cutovers_status_check"
    CHECK ("status" IN ('prepared', 'finalized', 'completed')),
  CONSTRAINT "sim_campaign_solver_cutovers_prior_status_check"
    CHECK ("prior_campaign_status" IN ('active', 'paused', 'attention')),
  CONSTRAINT "sim_campaign_solver_cutovers_counts_check"
    CHECK (
      "source_condition_count" >= 0
      AND "target_condition_count" >= 0
      AND "target_point_count" >= 0
    ),
  CONSTRAINT "sim_campaign_solver_cutovers_distinct_implementation_check"
    CHECK ("from_solver_implementation_id" <> "to_solver_implementation_id"),
  CONSTRAINT "sim_campaign_solver_cutovers_stage_shape_check"
    CHECK (
      ("status" = 'prepared' AND "canary_attestation_id" IS NULL AND "target_plan_revision_id" IS NULL AND "finalized_at" IS NULL AND "completed_at" IS NULL)
      OR ("status" = 'finalized' AND "canary_attestation_id" IS NOT NULL AND "target_plan_revision_id" IS NOT NULL AND "finalized_at" IS NOT NULL AND "completed_at" IS NULL)
      OR ("status" = 'completed' AND "canary_attestation_id" IS NOT NULL AND "target_plan_revision_id" IS NOT NULL AND "finalized_at" IS NOT NULL AND "completed_at" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sim_campaign_solver_cutovers_campaign_target_generation_uq"
  ON "sim_campaign_solver_cutovers" ("campaign_id", "target_generation");
--> statement-breakpoint
CREATE INDEX "sim_campaign_solver_cutovers_status_idx"
  ON "sim_campaign_solver_cutovers" ("status", "campaign_id");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION reject_campaign_solver_cutover_regression()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(
    OLD."campaign_id", OLD."from_solver_implementation_id",
    OLD."to_solver_implementation_id", OLD."source_plan_revision_id",
    OLD."source_generation", OLD."target_generation",
    OLD."prior_campaign_status", OLD."reason", OLD."prepared_by",
    OLD."prepared_at"
  ) IS DISTINCT FROM ROW(
    NEW."campaign_id", NEW."from_solver_implementation_id",
    NEW."to_solver_implementation_id", NEW."source_plan_revision_id",
    NEW."source_generation", NEW."target_generation",
    NEW."prior_campaign_status", NEW."reason", NEW."prepared_by",
    NEW."prepared_at"
  ) THEN
    RAISE EXCEPTION 'campaign solver cutover identity is immutable';
  END IF;
  IF OLD."status" = 'completed' OR
     (OLD."status" = 'finalized' AND NEW."status" <> 'completed') OR
     (OLD."status" = 'prepared' AND NEW."status" NOT IN ('prepared', 'finalized')) THEN
    RAISE EXCEPTION 'campaign solver cutover stage cannot regress';
  END IF;
  IF OLD."canary_attestation_id" IS NOT NULL AND
     OLD."canary_attestation_id" IS DISTINCT FROM NEW."canary_attestation_id" THEN
    RAISE EXCEPTION 'campaign solver cutover canary attestation is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sim_campaign_solver_cutovers_no_regression"
BEFORE UPDATE ON "sim_campaign_solver_cutovers"
FOR EACH ROW EXECUTE FUNCTION reject_campaign_solver_cutover_regression();
--> statement-breakpoint

-- Immutable membership snapshot of the exact non-released source cells that
-- finalization cloned. This is captured before source points are released and
-- is the durable comparison set for post-resume continuation proof.
CREATE TABLE "sim_campaign_solver_cutover_points" (
  "cutover_id" uuid NOT NULL REFERENCES "sim_campaign_solver_cutovers"("id") ON DELETE CASCADE,
  "campaign_id" uuid NOT NULL REFERENCES "sim_campaigns"("id") ON DELETE CASCADE,
  "source_condition_id" uuid NOT NULL REFERENCES "sim_campaign_conditions"("id"),
  "target_condition_id" uuid NOT NULL REFERENCES "sim_campaign_conditions"("id"),
  "airfoil_id" uuid NOT NULL REFERENCES "airfoils"("id") ON DELETE CASCADE,
  "aoa_deg" double precision NOT NULL,
  "target_revision_id" uuid NOT NULL REFERENCES "simulation_preset_revisions"("id"),
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sim_campaign_solver_cutover_points_pk"
    PRIMARY KEY ("cutover_id", "source_condition_id", "airfoil_id", "aoa_deg")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sim_campaign_solver_cutover_points_target_cell_uq"
  ON "sim_campaign_solver_cutover_points" ("cutover_id", "target_condition_id", "airfoil_id", "aoa_deg");
--> statement-breakpoint
CREATE INDEX "sim_campaign_solver_cutover_points_campaign_idx"
  ON "sim_campaign_solver_cutover_points" ("campaign_id", "cutover_id");
--> statement-breakpoint

-- Created at finalization and advanced by authenticated continuation probes.
-- The record survives an interrupted deploy, so "campaigns resumed" cannot
-- be confused with proof that a successor job actually followed the new route.
CREATE TABLE "solver_cutover_continuation_checks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "canary_attestation_id" uuid NOT NULL UNIQUE
    REFERENCES "solver_engine_canary_attestations"("id"),
  "status" text DEFAULT 'pending' NOT NULL,
  "sim_job_id" uuid REFERENCES "sim_jobs"("id") ON DELETE SET NULL,
  "evidence_result_id" uuid REFERENCES "results"("id") ON DELETE SET NULL,
  "last_error" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "checkedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "routedAt" timestamp with time zone,
  "evidenceAt" timestamp with time zone,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_cutover_continuation_checks_status_check"
    CHECK ("status" IN ('pending', 'routed', 'evidence', 'not_required')),
  CONSTRAINT "solver_cutover_continuation_checks_stage_shape_check"
    CHECK (
      ("status" = 'pending' AND "sim_job_id" IS NULL AND "evidence_result_id" IS NULL AND "routedAt" IS NULL AND "evidenceAt" IS NULL)
      OR ("status" = 'routed' AND "sim_job_id" IS NOT NULL AND "evidence_result_id" IS NULL AND "routedAt" IS NOT NULL AND "evidenceAt" IS NULL)
      OR ("status" = 'evidence' AND "sim_job_id" IS NOT NULL AND "evidence_result_id" IS NOT NULL AND "routedAt" IS NOT NULL AND "evidenceAt" IS NOT NULL)
      OR ("status" = 'not_required' AND "sim_job_id" IS NULL AND "evidence_result_id" IS NULL AND "routedAt" IS NULL AND "evidenceAt" IS NULL)
    )
);
--> statement-breakpoint
CREATE INDEX "solver_cutover_continuation_checks_status_checked_idx"
  ON "solver_cutover_continuation_checks" ("status", "checkedAt");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_solver_cutover_continuation_regression()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."canary_attestation_id" IS DISTINCT FROM NEW."canary_attestation_id"
     OR OLD."createdAt" IS DISTINCT FROM NEW."createdAt" THEN
    RAISE EXCEPTION 'solver cutover continuation identity is immutable';
  END IF;
  IF (CASE OLD."status" WHEN 'pending' THEN 0 WHEN 'routed' THEN 1 ELSE 2 END)
     > (CASE NEW."status" WHEN 'pending' THEN 0 WHEN 'routed' THEN 1 ELSE 2 END) THEN
    RAISE EXCEPTION 'solver cutover continuation status cannot regress';
  END IF;
  IF OLD."status" = 'not_required' AND NEW."status" <> 'not_required' THEN
    RAISE EXCEPTION 'solver cutover continuation not-required status is terminal';
  END IF;
  IF OLD."status" = 'evidence' AND OLD."sim_job_id" IS DISTINCT FROM NEW."sim_job_id" THEN
    RAISE EXCEPTION 'solver cutover continuation job is immutable after evidence';
  END IF;
  IF OLD."evidence_result_id" IS NOT NULL AND
     OLD."evidence_result_id" IS DISTINCT FROM NEW."evidence_result_id" THEN
    RAISE EXCEPTION 'solver cutover continuation evidence is immutable once observed';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_cutover_continuation_checks_no_regression"
BEFORE UPDATE ON "solver_cutover_continuation_checks"
FOR EACH ROW EXECUTE FUNCTION reject_solver_cutover_continuation_regression();
