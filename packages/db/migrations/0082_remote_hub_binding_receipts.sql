-- Migration 0080 creates both promise ownership constraints as RESTRICT from
-- the first committed schema state. Do not defer that audit-safety invariant
-- to this migration: interruption between 0080 and 0082 must never expose a
-- cascade-delete window for brokered evidence ownership.
ALTER TABLE "sync_brokered_evidence_uploads"
  ADD COLUMN "session_cancellation_acknowledged_at" timestamp with time zone;
--> statement-breakpoint

-- Migration 0080 deliberately has no transition out of expired: before this
-- acknowledgement column exists, the database cannot prove the old bearer
-- session was cancelled. Once 0082 is present, permit exactly one same-row
-- retry transition while keeping the evidence identity immutable and checking
-- current promise, point, and solver authority in the database transaction.
CREATE OR REPLACE FUNCTION enforce_brokered_evidence_upload_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  solver_row registered_remote_solvers%ROWTYPE;
  promise_row sync_sweep_promises%ROWTYPE;
  point_row sync_sweep_promise_points%ROWTYPE;
  expired_retry boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    expired_retry := OLD.state = 'expired' AND NEW.state = 'issuing';
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
      OR (
        expired_retry
        AND OLD.session_cancellation_acknowledged_at IS NOT NULL
        AND OLD.upload_url IS NULL
        AND OLD.upload_expires_at IS NULL
        AND OLD.revoked_at IS NULL
        AND NEW.upload_url IS NULL
        AND NEW.upload_expires_at IS NULL
        AND NEW.session_cancellation_acknowledged_at IS NULL
        AND NEW.revoked_at IS NULL
        AND NEW.attempt_count = OLD.attempt_count + 1
      )
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
  IF (TG_OP = 'INSERT' OR expired_retry)
     AND (solver_row.revoked_at IS NOT NULL OR solver_row.auth_token_hash IS NULL) THEN
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
  IF (TG_OP = 'INSERT' OR expired_retry) AND (
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
  IF (TG_OP = 'INSERT' OR expired_retry) AND point_row.status <> 'active' THEN
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
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_bound_brokered_evidence_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."state" = 'bound' THEN
    RAISE EXCEPTION 'bound brokered evidence upload audit ownership is immutable';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sync_brokered_evidence_upload_bound_delete_guard"
BEFORE DELETE ON "sync_brokered_evidence_uploads"
FOR EACH ROW EXECUTE FUNCTION prevent_bound_brokered_evidence_delete();
--> statement-breakpoint

-- A remote solver may reclaim its local packaged/raw CFD evidence only after
-- the hub returns an authenticated receipt proving that one exact uploaded
-- generation is both canonically bound and fulfilled for the promised point.
-- Receipts are append-only per result-attempt generation; delivery rows may be
-- reused by later generations and therefore cannot safely own this history.
CREATE TABLE "sync_remote_hub_binding_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "delivery_id" uuid NOT NULL
    REFERENCES "sync_remote_result_deliveries"("id") ON DELETE RESTRICT,
  "promise_id" uuid NOT NULL
    REFERENCES "sync_sweep_promises"("id") ON DELETE RESTRICT,
  "sim_job_id" uuid NOT NULL
    REFERENCES "sim_jobs"("id") ON DELETE RESTRICT,
  "result_id" uuid NOT NULL
    REFERENCES "results"("id") ON DELETE RESTRICT,
  "result_attempt_id" uuid NOT NULL
    REFERENCES "result_attempts"("id") ON DELETE RESTRICT,
  "aoa_deg" double precision NOT NULL,
  "brokered_upload_id" uuid NOT NULL,
  "receipt_canonical" text NOT NULL,
  "receipt" jsonb NOT NULL,
  "receipt_hmac" text NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reclaim_state" text DEFAULT 'pending' NOT NULL,
  "reclaim_attempt_count" integer DEFAULT 0 NOT NULL,
  "reclaim_next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reclaim_claim_token" uuid,
  "reclaim_claim_expires_at" timestamp with time zone,
  "reclaimed_at" timestamp with time zone,
  "reclaimed_bytes" bigint,
  "reclaim_last_error" text,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sync_remote_hub_binding_receipts_attempt_owner_fk"
    FOREIGN KEY ("result_attempt_id", "result_id")
    REFERENCES "result_attempts"("id", "result_id") ON DELETE RESTRICT,
  CONSTRAINT "sync_remote_hub_binding_receipts_attempt_uq"
    UNIQUE ("promise_id", "result_attempt_id"),
  CONSTRAINT "sync_remote_hub_binding_receipts_upload_uq"
    UNIQUE ("brokered_upload_id"),
  CONSTRAINT "sync_remote_hub_binding_receipts_shape_check" CHECK (
    btrim("receipt_canonical") <> ''
    AND "receipt_canonical"::jsonb = "receipt"
    AND jsonb_typeof("receipt") = 'object'
    AND "receipt_hmac" ~ '^[0-9a-f]{64}$'
    AND "receipt" ->> 'schemaVersion' = '1'
    AND "receipt" ->> 'kind' = 'hub-canonical-evidence-binding'
    AND "receipt" ->> 'promiseId' = "promise_id"::text
    AND "receipt" ->> 'remoteResultId' = "result_id"::text
    AND "receipt" ->> 'remoteResultAttemptId' = "result_attempt_id"::text
    AND "receipt" ->> 'brokeredUploadId' = "brokered_upload_id"::text
    AND ("receipt" ->> 'aoaDeg')::double precision = "aoa_deg"
    AND "receipt" ->> 'bindingState' = 'bound'
    AND "receipt" ->> 'promisePointState' = 'fulfilled'
  ),
  CONSTRAINT "sync_remote_hub_binding_receipts_reclaim_state_check" CHECK (
    "reclaim_state" IN ('pending', 'claiming', 'reclaimed')
    AND "reclaim_attempt_count" >= 0
    AND ("reclaimed_bytes" IS NULL OR "reclaimed_bytes" >= 0)
  ),
  CONSTRAINT "sync_remote_hub_binding_receipts_reclaim_claim_check" CHECK (
    (
      "reclaim_state" = 'claiming'
      AND "reclaim_claim_token" IS NOT NULL
      AND "reclaim_claim_expires_at" IS NOT NULL
    ) OR (
      "reclaim_state" <> 'claiming'
      AND "reclaim_claim_token" IS NULL
      AND "reclaim_claim_expires_at" IS NULL
    )
  ),
  CONSTRAINT "sync_remote_hub_binding_receipts_reclaimed_check" CHECK (
    (
      "reclaim_state" = 'reclaimed'
      AND "reclaimed_at" IS NOT NULL
      AND "reclaimed_bytes" IS NOT NULL
    ) OR (
      "reclaim_state" <> 'reclaimed'
      AND "reclaimed_at" IS NULL
      AND "reclaimed_bytes" IS NULL
    )
  )
);
--> statement-breakpoint
CREATE INDEX "sync_remote_hub_binding_receipts_reclaim_ready_idx"
  ON "sync_remote_hub_binding_receipts"
  ("reclaim_state", "reclaim_next_attempt_at");
--> statement-breakpoint
CREATE INDEX "sync_remote_hub_binding_receipts_delivery_idx"
  ON "sync_remote_hub_binding_receipts" ("delivery_id", "received_at");
--> statement-breakpoint

CREATE OR REPLACE FUNCTION prevent_remote_hub_binding_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."delivery_id" IS DISTINCT FROM OLD."delivery_id"
     OR NEW."promise_id" IS DISTINCT FROM OLD."promise_id"
     OR NEW."sim_job_id" IS DISTINCT FROM OLD."sim_job_id"
     OR NEW."result_id" IS DISTINCT FROM OLD."result_id"
     OR NEW."result_attempt_id" IS DISTINCT FROM OLD."result_attempt_id"
     OR NEW."aoa_deg" IS DISTINCT FROM OLD."aoa_deg"
     OR NEW."brokered_upload_id" IS DISTINCT FROM OLD."brokered_upload_id"
     OR NEW."receipt_canonical" IS DISTINCT FROM OLD."receipt_canonical"
     OR NEW."receipt" IS DISTINCT FROM OLD."receipt"
     OR NEW."receipt_hmac" IS DISTINCT FROM OLD."receipt_hmac"
     OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'hub binding receipt identity and signed payload are immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "sync_remote_hub_binding_receipts_immutable"
BEFORE UPDATE ON "sync_remote_hub_binding_receipts"
FOR EACH ROW EXECUTE FUNCTION prevent_remote_hub_binding_receipt_mutation();
--> statement-breakpoint
