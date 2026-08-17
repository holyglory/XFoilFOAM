-- Job-level terminal forensic preservation is deliberately separate from
-- canonical result evidence.  A failed/cancelled remote job may have no
-- result_attempt, therefore neither table below may grow an AoA/result FK.

CREATE TABLE "sync_remote_terminal_evidence_uploads" (
  "id" uuid PRIMARY KEY NOT NULL,
  "sim_job_id" uuid NOT NULL REFERENCES "sim_jobs"("id") ON DELETE RESTRICT,
  "promise_id" uuid NOT NULL REFERENCES "sync_sweep_promises"("id") ON DELETE RESTRICT,
  "solver_id" uuid NOT NULL,
  "engine_job_id" text NOT NULL,
  "terminal_state" text NOT NULL,
  "preservation_kind" text DEFAULT 'forensic' NOT NULL,
  "stored_sha256" text,
  "stored_byte_size" bigint,
  "tar_sha256" text,
  "tar_byte_size" bigint,
  "manifest_sha256" text,
  "manifest_byte_size" bigint,
  "zstd_level" integer,
  "bundled_file_count" integer,
  "local_archive_storage_key" text,
  "hub_upload_id" uuid,
  "state" text DEFAULT 'requested' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "claim_token" uuid,
  "claim_expires_at" timestamp with time zone,
  "upload_url" text,
  "upload_expires_at" timestamp with time zone,
  "generation" text,
  "crc32c" text,
  "verified_at" timestamp with time zone,
  "last_error" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sync_remote_terminal_evidence_uploads_job_uq" UNIQUE ("sim_job_id"),
  CONSTRAINT "sync_remote_terminal_evidence_uploads_terminal_state_check" CHECK (
    "terminal_state" IN ('done', 'failed', 'cancelled')
    AND "preservation_kind" IN ('complete', 'forensic')
    AND "state" IN ('requested', 'preparing', 'prepared', 'issuing', 'issued', 'verifying', 'verified', 'failed')
    AND "attempt_count" >= 0
  ),
  CONSTRAINT "sync_remote_terminal_evidence_uploads_identity_check" CHECK (
    (
      "stored_sha256" IS NULL
      OR (
        "stored_sha256" ~ '^[0-9a-f]{64}$'
        AND "stored_byte_size" > 0
        AND "tar_sha256" ~ '^[0-9a-f]{64}$'
        AND "tar_byte_size" > 0
        AND "manifest_sha256" ~ '^[0-9a-f]{64}$'
        AND "manifest_byte_size" > 0
        AND "zstd_level" BETWEEN 1 AND 22
        AND "bundled_file_count" > 0
        AND btrim("local_archive_storage_key") <> ''
      )
    )
    AND ("stored_sha256" IS NULL) = ("stored_byte_size" IS NULL)
    AND ("stored_sha256" IS NULL) = ("tar_sha256" IS NULL)
    AND ("stored_sha256" IS NULL) = ("tar_byte_size" IS NULL)
    AND ("stored_sha256" IS NULL) = ("manifest_sha256" IS NULL)
    AND ("stored_sha256" IS NULL) = ("manifest_byte_size" IS NULL)
    AND ("stored_sha256" IS NULL) = ("zstd_level" IS NULL)
    AND ("stored_sha256" IS NULL) = ("bundled_file_count" IS NULL)
    AND ("stored_sha256" IS NULL) = ("local_archive_storage_key" IS NULL)
  ),
  CONSTRAINT "sync_remote_terminal_evidence_uploads_claim_shape_check" CHECK (
    ("state" IN ('preparing', 'prepared', 'issued', 'issuing', 'verifying') AND "claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
    OR ("state" NOT IN ('preparing', 'prepared', 'issued', 'issuing', 'verifying') AND "claim_token" IS NULL AND "claim_expires_at" IS NULL)
  )
);--> statement-breakpoint
CREATE UNIQUE INDEX "sync_remote_terminal_evidence_uploads_hub_upload_uq"
  ON "sync_remote_terminal_evidence_uploads" ("hub_upload_id")
  WHERE "hub_upload_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sync_remote_terminal_evidence_uploads_ready_idx"
  ON "sync_remote_terminal_evidence_uploads" ("state", "updatedAt");--> statement-breakpoint

CREATE TABLE "sync_brokered_terminal_evidence_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "promise_id" uuid NOT NULL REFERENCES "sync_sweep_promises"("id") ON DELETE RESTRICT,
  "solver_id" uuid NOT NULL REFERENCES "registered_remote_solvers"("id") ON DELETE RESTRICT,
  "source_instance_id" text NOT NULL,
  "remote_sim_job_id" uuid NOT NULL,
  "remote_terminal_upload_id" uuid NOT NULL,
  "engine_job_id" text NOT NULL,
  "terminal_state" text NOT NULL,
  "preservation_kind" text NOT NULL,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "stored_sha256" text NOT NULL,
  "stored_byte_size" bigint NOT NULL,
  "tar_sha256" text NOT NULL,
  "tar_byte_size" bigint NOT NULL,
  "manifest_sha256" text NOT NULL,
  "manifest_byte_size" bigint NOT NULL,
  "zstd_level" integer NOT NULL,
  "bundled_file_count" integer NOT NULL,
  "state" text DEFAULT 'requested' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "claim_token" uuid,
  "claim_expires_at" timestamp with time zone,
  "upload_url" text,
  "upload_expires_at" timestamp with time zone,
  "generation" text,
  "crc32c" text,
  "verified_at" timestamp with time zone,
  "last_error" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sync_brokered_terminal_evidence_uploads_idempotency_uq" UNIQUE ("solver_id", "idempotency_key"),
  CONSTRAINT "sync_brokered_terminal_evidence_uploads_job_uq" UNIQUE ("solver_id", "remote_sim_job_id"),
  CONSTRAINT "sync_brokered_terminal_evidence_uploads_terminal_upload_uq" UNIQUE ("solver_id", "remote_terminal_upload_id"),
  CONSTRAINT "sync_brokered_terminal_evidence_uploads_hash_check" CHECK (
    "stored_sha256" ~ '^[0-9a-f]{64}$'
    AND "tar_sha256" ~ '^[0-9a-f]{64}$'
    AND "manifest_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "sync_brokered_terminal_evidence_uploads_size_check" CHECK (
    "stored_byte_size" > 0 AND "tar_byte_size" > 0
    AND "manifest_byte_size" > 0 AND "bundled_file_count" > 0
    AND "zstd_level" BETWEEN 1 AND 22
  ),
  CONSTRAINT "sync_brokered_terminal_evidence_uploads_state_check" CHECK (
    "terminal_state" IN ('done', 'failed', 'cancelled')
    AND "preservation_kind" IN ('complete', 'forensic')
    AND "state" IN ('requested', 'issuing', 'issued', 'verifying', 'verified', 'failed')
    AND "attempt_count" >= 0
  ),
  CONSTRAINT "sync_brokered_terminal_evidence_uploads_claim_shape_check" CHECK (
    ("state" IN ('issuing', 'verifying') AND "claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
    OR ("state" NOT IN ('issuing', 'verifying') AND "claim_token" IS NULL AND "claim_expires_at" IS NULL)
  ),
  CONSTRAINT "sync_brokered_terminal_evidence_uploads_issued_shape_check" CHECK (
    "state" NOT IN ('issued', 'verifying') OR ("upload_url" IS NOT NULL AND "upload_expires_at" IS NOT NULL)
  ),
  CONSTRAINT "sync_brokered_terminal_evidence_uploads_verified_shape_check" CHECK (
    "state" <> 'verified' OR ("generation" IS NOT NULL AND "crc32c" IS NOT NULL AND "verified_at" IS NOT NULL)
  )
);--> statement-breakpoint
CREATE INDEX "sync_brokered_terminal_evidence_uploads_state_idx"
  ON "sync_brokered_terminal_evidence_uploads" ("state", "upload_expires_at");
