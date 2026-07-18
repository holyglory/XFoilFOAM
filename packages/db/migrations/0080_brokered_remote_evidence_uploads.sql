ALTER TABLE "sync_api_settings"
  ADD COLUMN "remote_solver_auth_token" text DEFAULT '' NOT NULL;--> statement-breakpoint

ALTER TABLE "registered_remote_solvers"
  ADD COLUMN "auth_token_hash" text,
  ADD COLUMN "credential_version" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint

ALTER TABLE "registered_remote_solvers"
  ADD CONSTRAINT "registered_remote_solvers_auth_token_hash_check"
  CHECK ("auth_token_hash" IS NULL OR "auth_token_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "registered_remote_solvers_credential_version_check"
  CHECK ("credential_version" >= 0);--> statement-breakpoint

CREATE TABLE "sync_brokered_evidence_uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "idempotency_key" uuid NOT NULL,
  "promise_id" uuid NOT NULL,
  "promise_point_id" uuid NOT NULL,
  "solver_id" uuid NOT NULL,
  "source_instance_id" text NOT NULL,
  "remote_result_id" uuid NOT NULL,
  "remote_result_attempt_id" uuid NOT NULL,
  "aoa_deg" double precision NOT NULL,
  "engine_job_id" text NOT NULL,
  "engine_case_slug" text,
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
  "canonical_result_id" uuid,
  "canonical_result_attempt_id" uuid,
  "canonical_artifact_id" uuid,
  "bound_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sync_brokered_evidence_uploads_hash_check" CHECK (
    "stored_sha256" ~ '^[0-9a-f]{64}$'
    AND "tar_sha256" ~ '^[0-9a-f]{64}$'
    AND "manifest_sha256" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "sync_brokered_evidence_uploads_size_check" CHECK (
    "stored_byte_size" > 0
    AND "tar_byte_size" > 0
    AND "manifest_byte_size" > 0
    AND "bundled_file_count" > 0
    AND "zstd_level" BETWEEN 1 AND 22
  ),
  CONSTRAINT "sync_brokered_evidence_uploads_state_check" CHECK (
    "state" IN ('requested', 'issuing', 'issued', 'verifying', 'verified', 'bound', 'failed', 'revoked', 'expired')
  ),
  CONSTRAINT "sync_brokered_evidence_uploads_attempt_count_check" CHECK ("attempt_count" >= 0),
  CONSTRAINT "sync_brokered_evidence_uploads_claim_shape_check" CHECK (
    ("state" IN ('issuing', 'verifying') AND "claim_token" IS NOT NULL AND "claim_expires_at" IS NOT NULL)
    OR ("state" NOT IN ('issuing', 'verifying') AND "claim_token" IS NULL AND "claim_expires_at" IS NULL)
  ),
  CONSTRAINT "sync_brokered_evidence_uploads_issued_shape_check" CHECK (
    "state" NOT IN ('issued', 'verifying') OR ("upload_url" IS NOT NULL AND "upload_expires_at" IS NOT NULL)
  ),
  CONSTRAINT "sync_brokered_evidence_uploads_verified_shape_check" CHECK (
    "state" NOT IN ('verified', 'bound')
    OR ("generation" IS NOT NULL AND "crc32c" IS NOT NULL AND "verified_at" IS NOT NULL)
  ),
  CONSTRAINT "sync_brokered_evidence_uploads_remote_identity_check" CHECK (
    CASE
      WHEN "generation" IS NULL THEN TRUE
      WHEN "generation" ~ '^[1-9][0-9]{0,19}$'
        THEN "generation"::numeric <= 18446744073709551615
      ELSE FALSE
    END
    AND ("crc32c" IS NULL OR "crc32c" ~ '^[A-Za-z0-9+/]{6}==$')
  ),
  CONSTRAINT "sync_brokered_evidence_uploads_bound_shape_check" CHECK (
    ("state" = 'bound' AND "canonical_result_id" IS NOT NULL AND "canonical_result_attempt_id" IS NOT NULL AND "canonical_artifact_id" IS NOT NULL AND "bound_at" IS NOT NULL)
    OR ("state" <> 'bound' AND "canonical_result_id" IS NULL AND "canonical_result_attempt_id" IS NULL AND "canonical_artifact_id" IS NULL AND "bound_at" IS NULL)
  )
);--> statement-breakpoint

ALTER TABLE "sync_brokered_evidence_uploads"
  ADD CONSTRAINT "sync_brokered_evidence_uploads_promise_fk"
    FOREIGN KEY ("promise_id") REFERENCES "sync_sweep_promises"("id") ON DELETE restrict,
  ADD CONSTRAINT "sync_brokered_evidence_uploads_promise_point_fk"
    FOREIGN KEY ("promise_point_id") REFERENCES "sync_sweep_promise_points"("id") ON DELETE restrict,
  ADD CONSTRAINT "sync_brokered_evidence_uploads_solver_fk"
    FOREIGN KEY ("solver_id") REFERENCES "registered_remote_solvers"("id") ON DELETE restrict,
  ADD CONSTRAINT "sync_brokered_evidence_uploads_result_fk"
    FOREIGN KEY ("canonical_result_id") REFERENCES "results"("id") ON DELETE restrict,
  ADD CONSTRAINT "sync_brokered_evidence_uploads_attempt_fk"
    FOREIGN KEY ("canonical_result_attempt_id") REFERENCES "result_attempts"("id") ON DELETE restrict,
  ADD CONSTRAINT "sync_brokered_evidence_uploads_artifact_fk"
    FOREIGN KEY ("canonical_artifact_id") REFERENCES "solver_evidence_artifacts"("id") ON DELETE restrict,
  ADD CONSTRAINT "sync_brokered_evidence_uploads_canonical_attempt_owner_fk"
    FOREIGN KEY ("canonical_result_attempt_id", "canonical_result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE restrict;--> statement-breakpoint

CREATE UNIQUE INDEX "sync_brokered_evidence_uploads_idempotency_uq"
  ON "sync_brokered_evidence_uploads" ("solver_id", "idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_brokered_evidence_uploads_attempt_uq"
  ON "sync_brokered_evidence_uploads" ("promise_id", "solver_id", "remote_result_attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_brokered_evidence_uploads_canonical_artifact_uq"
  ON "sync_brokered_evidence_uploads" ("canonical_artifact_id")
  WHERE "canonical_artifact_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "sync_brokered_evidence_uploads_state_idx"
  ON "sync_brokered_evidence_uploads" ("state", "upload_expires_at");--> statement-breakpoint
CREATE INDEX "sync_brokered_evidence_uploads_promise_idx"
  ON "sync_brokered_evidence_uploads" ("promise_id", "promise_point_id");--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_brokered_evidence_upload_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  solver_row registered_remote_solvers%ROWTYPE;
  promise_row sync_sweep_promises%ROWTYPE;
  point_row sync_sweep_promise_points%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF ROW(
      NEW.idempotency_key, NEW.promise_id, NEW.promise_point_id, NEW.solver_id,
      NEW.source_instance_id, NEW.remote_result_id, NEW.remote_result_attempt_id,
      NEW.aoa_deg, NEW.engine_job_id, NEW.engine_case_slug, NEW.bucket, NEW.object_key,
      NEW.stored_sha256, NEW.stored_byte_size, NEW.tar_sha256, NEW.tar_byte_size,
      NEW.manifest_sha256, NEW.manifest_byte_size, NEW.zstd_level,
      NEW.bundled_file_count
    ) IS DISTINCT FROM ROW(
      OLD.idempotency_key, OLD.promise_id, OLD.promise_point_id, OLD.solver_id,
      OLD.source_instance_id, OLD.remote_result_id, OLD.remote_result_attempt_id,
      OLD.aoa_deg, OLD.engine_job_id, OLD.engine_case_slug, OLD.bucket, OLD.object_key,
      OLD.stored_sha256, OLD.stored_byte_size, OLD.tar_sha256, OLD.tar_byte_size,
      OLD.manifest_sha256, OLD.manifest_byte_size, OLD.zstd_level,
      OLD.bundled_file_count
    ) THEN
      RAISE EXCEPTION 'brokered evidence upload immutable identity cannot change';
    END IF;
    IF OLD.state = 'bound' AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound brokered evidence upload is immutable';
    END IF;
    IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NULL THEN
      RAISE EXCEPTION 'brokered evidence upload revocation cannot be cleared';
    END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state = 'requested' AND NEW.state IN ('issuing', 'revoked', 'expired'))
      OR (OLD.state = 'issuing' AND NEW.state IN ('issued', 'verified', 'failed', 'revoked', 'expired'))
      OR (OLD.state = 'issued' AND NEW.state IN ('issuing', 'verifying', 'revoked', 'expired'))
      OR (OLD.state = 'verifying' AND NEW.state IN ('verified', 'failed', 'revoked', 'expired'))
      OR (OLD.state = 'failed' AND NEW.state IN ('issuing', 'verifying', 'revoked', 'expired'))
      OR (OLD.state = 'verified' AND NEW.state IN ('bound', 'revoked'))
    ) THEN
      RAISE EXCEPTION 'illegal brokered evidence upload state transition: % -> %', OLD.state, NEW.state;
    END IF;
  END IF;

  SELECT * INTO solver_row
  FROM registered_remote_solvers
  WHERE id = NEW.solver_id;
  IF NOT FOUND OR solver_row.instance_id <> NEW.source_instance_id THEN
    RAISE EXCEPTION 'brokered evidence upload solver identity mismatch';
  END IF;
  IF TG_OP = 'INSERT' AND (solver_row.revoked_at IS NOT NULL OR solver_row.auth_token_hash IS NULL) THEN
    RAISE EXCEPTION 'brokered evidence upload solver credential is not active';
  END IF;

  SELECT * INTO promise_row
  FROM sync_sweep_promises
  WHERE id = NEW.promise_id;
  IF NOT FOUND
     OR promise_row.source_instance_id IS DISTINCT FROM NEW.source_instance_id
     OR promise_row.request_payload ->> 'solverId' IS DISTINCT FROM NEW.solver_id::text THEN
    RAISE EXCEPTION 'brokered evidence upload promise is not owned by this solver';
  END IF;
  IF TG_OP = 'INSERT' AND (
    promise_row.status <> 'active' OR promise_row."expiresAt" <= now()
  ) THEN
    RAISE EXCEPTION 'brokered evidence upload requires an active promise lease';
  END IF;

  SELECT * INTO point_row
  FROM sync_sweep_promise_points
  WHERE id = NEW.promise_point_id;
  IF NOT FOUND
     OR point_row.promise_id <> NEW.promise_id
     OR point_row.aoa_deg <> NEW.aoa_deg THEN
    RAISE EXCEPTION 'brokered evidence upload promise point mismatch';
  END IF;
  IF TG_OP = 'INSERT' AND point_row.status <> 'active' THEN
    RAISE EXCEPTION 'brokered evidence upload requires an active promise point';
  END IF;

  IF btrim(NEW.bucket) = '' THEN
    RAISE EXCEPTION 'brokered evidence upload bucket is required';
  END IF;
  IF NEW.object_key <> (
    'solver-evidence/v1/sha256/' || substr(NEW.stored_sha256, 1, 2) || '/' ||
    NEW.stored_sha256 || '.tar.zst'
  ) THEN
    RAISE EXCEPTION 'brokered evidence upload object key is not canonical';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sync_brokered_evidence_upload_scope_guard
BEFORE INSERT OR UPDATE ON sync_brokered_evidence_uploads
FOR EACH ROW EXECUTE FUNCTION enforce_brokered_evidence_upload_scope();--> statement-breakpoint

CREATE OR REPLACE FUNCTION fence_brokered_evidence_from_canary_cleanup()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.generation IS NULL OR NEW.state NOT IN ('verified', 'bound') THEN
    RETURN NEW;
  END IF;
  PERFORM lock_solver_canary_cleanup_identity(
    NEW.bucket,
    NEW.object_key,
    NEW.generation
  );
  IF EXISTS (
    SELECT 1 FROM solver_canary_object_cleanup_reservations reservation
    WHERE reservation.bucket = NEW.bucket
      AND reservation.object_key = NEW.object_key
      AND reservation.generation = NEW.generation
  ) THEN
    RAISE EXCEPTION 'brokered evidence generation is reserved for canary cleanup';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sync_brokered_evidence_canary_cleanup_fence
BEFORE INSERT OR UPDATE ON sync_brokered_evidence_uploads
FOR EACH ROW EXECUTE FUNCTION fence_brokered_evidence_from_canary_cleanup();--> statement-breakpoint

CREATE OR REPLACE FUNCTION fence_canary_cleanup_from_brokered_evidence()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM lock_solver_canary_cleanup_identity(
    NEW.bucket,
    NEW.object_key,
    NEW.generation
  );
  IF EXISTS (
    SELECT 1 FROM sync_brokered_evidence_uploads upload
    WHERE upload.bucket = NEW.bucket
      AND upload.object_key = NEW.object_key
      AND upload.generation = NEW.generation
      AND upload.state IN ('verified', 'bound')
  ) THEN
    RAISE EXCEPTION 'canary cleanup cannot reserve a canonical brokered evidence generation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER solver_canary_cleanup_brokered_evidence_fence
BEFORE INSERT OR UPDATE ON solver_canary_object_cleanup_reservations
FOR EACH ROW EXECUTE FUNCTION fence_canary_cleanup_from_brokered_evidence();--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_brokered_evidence_artifact_association()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  upload_row sync_brokered_evidence_uploads%ROWTYPE;
  upload_id uuid;
BEGIN
  IF NEW.metadata ->> 'remoteEvidenceUploadId' IS NULL THEN
    RETURN NEW;
  END IF;
  BEGIN
    upload_id := (NEW.metadata ->> 'remoteEvidenceUploadId')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'remoteEvidenceUploadId must be a UUID';
  END;
  SELECT * INTO upload_row
  FROM sync_brokered_evidence_uploads
  WHERE id = upload_id
  FOR KEY SHARE;
  IF NOT FOUND OR upload_row.state NOT IN ('verified', 'bound') THEN
    RAISE EXCEPTION 'brokered evidence artifact lacks a verified upload';
  END IF;
  IF NEW.kind <> 'engine_bundle'
     OR NEW.mime_type <> 'application/zstd'
     OR NEW.storage_key <> upload_row.object_key
     OR NEW.sha256 <> upload_row.stored_sha256
     OR NEW.byte_size <> upload_row.stored_byte_size
     OR NEW.metadata ->> 'storageBackend' IS DISTINCT FROM 'gcs'
     OR NEW.metadata ->> 'bucket' IS DISTINCT FROM upload_row.bucket
     OR NEW.metadata ->> 'objectKey' IS DISTINCT FROM upload_row.object_key
     OR NEW.metadata ->> 'generation' IS DISTINCT FROM upload_row.generation
     OR NEW.metadata ->> 'crc32c' IS DISTINCT FROM upload_row.crc32c
     OR NEW.metadata ->> 'tarSha256' IS DISTINCT FROM upload_row.tar_sha256
     OR NEW.metadata ->> 'tarByteSize' IS DISTINCT FROM upload_row.tar_byte_size::text
     OR NEW.metadata ->> 'manifestSha256' IS DISTINCT FROM upload_row.manifest_sha256
     OR NEW.metadata ->> 'manifestByteSize' IS DISTINCT FROM upload_row.manifest_byte_size::text THEN
    RAISE EXCEPTION 'brokered evidence artifact identity does not match verified upload';
  END IF;
  IF upload_row.state = 'bound' AND (
    NEW.id <> upload_row.canonical_artifact_id
    OR NEW.result_id <> upload_row.canonical_result_id
    OR NEW.result_attempt_id <> upload_row.canonical_result_attempt_id
  ) THEN
    RAISE EXCEPTION 'brokered evidence upload is already bound to another artifact owner';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER solver_evidence_artifacts_brokered_upload_guard
BEFORE INSERT OR UPDATE ON solver_evidence_artifacts
FOR EACH ROW EXECUTE FUNCTION enforce_brokered_evidence_artifact_association();--> statement-breakpoint

CREATE OR REPLACE FUNCTION enforce_brokered_evidence_binding()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  artifact_row solver_evidence_artifacts%ROWTYPE;
  promise_row sync_sweep_promises%ROWTYPE;
  point_row sync_sweep_promise_points%ROWTYPE;
BEGIN
  IF NEW.state <> 'bound' THEN
    RETURN NEW;
  END IF;
  SELECT * INTO artifact_row
  FROM solver_evidence_artifacts
  WHERE id = NEW.canonical_artifact_id;
  IF NOT FOUND
     OR artifact_row.result_id <> NEW.canonical_result_id
     OR artifact_row.result_attempt_id <> NEW.canonical_result_attempt_id
     OR artifact_row.kind <> 'engine_bundle'
     OR artifact_row.storage_key <> NEW.object_key
     OR artifact_row.sha256 <> NEW.stored_sha256
     OR artifact_row.byte_size <> NEW.stored_byte_size
     OR artifact_row.metadata ->> 'remoteEvidenceUploadId' IS DISTINCT FROM NEW.id::text THEN
    RAISE EXCEPTION 'brokered evidence upload canonical binding is invalid';
  END IF;
  SELECT * INTO promise_row FROM sync_sweep_promises
  WHERE id = NEW.promise_id FOR KEY SHARE;
  SELECT * INTO point_row FROM sync_sweep_promise_points
  WHERE id = NEW.promise_point_id FOR UPDATE;
  IF NOT FOUND
     OR promise_row.status <> 'active'
     OR promise_row."expiresAt" <= now()
     OR point_row.status <> 'active' THEN
    RAISE EXCEPTION 'brokered evidence binding requires the exact active promise lease';
  END IF;
  IF point_row.result_id IS NOT NULL OR point_row.result_attempt_id IS NOT NULL THEN
    IF point_row.result_id IS DISTINCT FROM NEW.canonical_result_id
       OR point_row.result_attempt_id IS DISTINCT FROM NEW.canonical_result_attempt_id THEN
      RAISE EXCEPTION 'promise point already owns a different fulfilled generation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER sync_brokered_evidence_upload_binding_guard
BEFORE INSERT OR UPDATE ON sync_brokered_evidence_uploads
FOR EACH ROW EXECUTE FUNCTION enforce_brokered_evidence_binding();
