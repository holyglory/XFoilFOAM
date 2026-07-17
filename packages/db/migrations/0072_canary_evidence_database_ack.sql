-- Direct engine canaries deliberately bypass normal sim-job/result ingestion
-- while the scheduler is stopped.  Persist their exact pre-cleanup receipt in
-- a separate immutable table so it can authorize local archive deletion
-- without masquerading as the successful attestation that enables a cutover.
CREATE TABLE "solver_engine_canary_evidence_registrations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "solver_implementation_id" uuid NOT NULL REFERENCES "solver_implementations"("id"),
  "solver_runtime_build_id" uuid NOT NULL REFERENCES "solver_runtime_builds"("id"),
  "solver_execution_pool_id" uuid NOT NULL REFERENCES "solver_execution_pools"("id"),
  "receipt_sha256" text NOT NULL UNIQUE,
  "receipt" jsonb NOT NULL,
  "registered_by" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_engine_canary_evidence_registrations_receipt_sha256_check"
    CHECK ("receipt_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_engine_canary_evidence_registrations_runtime_owner_fk"
    FOREIGN KEY ("solver_runtime_build_id", "solver_implementation_id")
    REFERENCES "solver_runtime_builds"("id", "solver_implementation_id"),
  CONSTRAINT "solver_engine_canary_evidence_registrations_pool_owner_fk"
    FOREIGN KEY ("solver_execution_pool_id", "solver_implementation_id")
    REFERENCES "solver_execution_pools"("id", "solver_implementation_id")
);
--> statement-breakpoint
CREATE INDEX "solver_engine_canary_evidence_registrations_implementation_created_idx"
  ON "solver_engine_canary_evidence_registrations" ("solver_implementation_id", "createdAt");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_solver_engine_canary_evidence_registration_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver engine canary evidence registrations are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_engine_canary_evidence_registrations_immutable"
BEFORE UPDATE OR DELETE ON "solver_engine_canary_evidence_registrations"
FOR EACH ROW EXECUTE FUNCTION reject_solver_engine_canary_evidence_registration_mutation();
--> statement-breakpoint
CREATE TABLE "solver_engine_canary_evidence_cleanup_proofs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "registration_id" uuid NOT NULL REFERENCES "solver_engine_canary_evidence_registrations"("id"),
  "job_id" text NOT NULL,
  "scenario" text NOT NULL,
  "aoa_deg" double precision NOT NULL,
  "case_slug" text NOT NULL,
  "evidence_base" text NOT NULL,
  "member_association_count" integer NOT NULL,
  "member_associations_sha256" text NOT NULL,
  "manifest_member_set_sha256" text NOT NULL,
  "verification" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "solver_engine_canary_evidence_cleanup_proofs_scenario_check"
    CHECK ("scenario" IN ('serial-rans', 'mpi-2-rans', 'forced-urans-precalc-no-shedding')),
  CONSTRAINT "solver_engine_canary_evidence_cleanup_proofs_count_check"
    CHECK ("member_association_count" > 0),
  CONSTRAINT "solver_engine_canary_evidence_cleanup_proofs_member_sha256_check"
    CHECK ("member_associations_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_engine_canary_evidence_cleanup_proofs_manifest_sha256_check"
    CHECK ("manifest_member_set_sha256" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "solver_engine_canary_evidence_cleanup_proofs_verification_check"
    CHECK ("verification" ~ '^archive\+manifest\+all-members-restore:[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "solver_engine_canary_evidence_cleanup_proofs_exact_base_idx"
  ON "solver_engine_canary_evidence_cleanup_proofs" ("registration_id", "job_id", "case_slug", "evidence_base");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_solver_engine_canary_evidence_cleanup_proof_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'solver engine canary evidence cleanup proofs are immutable';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "solver_engine_canary_evidence_cleanup_proofs_immutable"
BEFORE UPDATE OR DELETE ON "solver_engine_canary_evidence_cleanup_proofs"
FOR EACH ROW EXECUTE FUNCTION reject_solver_engine_canary_evidence_cleanup_proof_mutation();
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "solver_engine_canary_attestations") THEN
    RAISE EXCEPTION
      '0072 requires zero historical solver_engine_canary_attestations; immutable rows cannot be truthfully backfilled with a canary evidence registration';
  END IF;
END;
$$;
--> statement-breakpoint
ALTER TABLE "solver_engine_canary_attestations"
  ADD COLUMN "evidence_registration_id" uuid NOT NULL
  REFERENCES "solver_engine_canary_evidence_registrations"("id");
--> statement-breakpoint
CREATE UNIQUE INDEX "solver_engine_canary_attestations_evidence_registration_idx"
  ON "solver_engine_canary_attestations" ("evidence_registration_id");
