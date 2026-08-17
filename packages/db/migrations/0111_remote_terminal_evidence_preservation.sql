-- A terminal remote CFD job may have no result/attempt owner.  Keep its
-- preservation and reclaim proof in a job-level ledger instead of abusing the
-- canonical result-evidence broker or inventing an aerodynamic result.
CREATE TABLE "sync_remote_terminal_evidence_receipts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sim_job_id" uuid NOT NULL,
  "promise_id" uuid NOT NULL,
  "solver_id" uuid NOT NULL,
  "terminal_upload_id" uuid NOT NULL,
  "engine_job_id" text NOT NULL,
  "preservation_kind" text NOT NULL,
  -- This is a remote hub quarantine id, not a local FK: the remote solver
  -- must not pretend it owns the hub's quarantine or canonical result rows.
  "preservation_id" uuid NOT NULL,
  "bucket" text NOT NULL,
  "object_key" text NOT NULL,
  "generation" text NOT NULL,
  "stored_sha256" text NOT NULL,
  "stored_byte_size" bigint NOT NULL,
  "crc32c" text NOT NULL,
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
  CONSTRAINT "sync_remote_terminal_evidence_receipts_job_fk"
    FOREIGN KEY ("sim_job_id") REFERENCES "sim_jobs"("id") ON DELETE RESTRICT,
  CONSTRAINT "sync_remote_terminal_evidence_receipts_promise_fk"
    FOREIGN KEY ("promise_id") REFERENCES "sync_sweep_promises"("id") ON DELETE RESTRICT,
  CONSTRAINT "sync_remote_terminal_evidence_receipts_job_uq"
    UNIQUE ("sim_job_id"),
  CONSTRAINT "sync_remote_terminal_evidence_receipts_upload_uq"
    UNIQUE ("terminal_upload_id"),
  CONSTRAINT "sync_remote_terminal_evidence_receipts_shape_check" CHECK (
    btrim("receipt_canonical") <> ''
    AND "receipt_canonical"::jsonb = "receipt"
    AND jsonb_typeof("receipt") = 'object'
    AND "receipt" ?& ARRAY[
      'schemaVersion', 'kind', 'simJobId', 'promiseId', 'solverId',
      'terminalUploadId', 'engineJobId', 'terminalState',
      'preservationKind', 'preservationId', 'remote', 'preservedAt'
    ]
    AND jsonb_typeof("receipt" -> 'remote') = 'object'
    AND "receipt" -> 'remote' ?& ARRAY[
      'bucket', 'objectKey', 'generation', 'storedSha256',
      'storedSize', 'crc32c'
    ]
    AND "receipt_hmac" ~ '^[0-9a-f]{64}$'
    AND "receipt" ->> 'schemaVersion' = '1'
    AND "receipt" ->> 'kind' = 'hub-terminal-evidence-preservation'
    AND "receipt" ->> 'simJobId' = "sim_job_id"::text
    AND "receipt" ->> 'promiseId' = "promise_id"::text
    AND "receipt" ->> 'solverId' = "solver_id"::text
    AND "receipt" ->> 'terminalUploadId' = "terminal_upload_id"::text
    AND "receipt" ->> 'engineJobId' = "engine_job_id"
    AND "receipt" ->> 'preservationKind' = "preservation_kind"
    AND "receipt" ->> 'preservationId' = "preservation_id"::text
    AND "receipt" -> 'remote' ->> 'bucket' = "bucket"
    AND "receipt" -> 'remote' ->> 'objectKey' = "object_key"
    AND "receipt" -> 'remote' ->> 'generation' = "generation"
    AND "receipt" -> 'remote' ->> 'storedSha256' = "stored_sha256"
    AND ("receipt" -> 'remote' ->> 'storedSize')::bigint = "stored_byte_size"
    AND "receipt" -> 'remote' ->> 'crc32c' = "crc32c"
  ),
  CONSTRAINT "sync_remote_terminal_evidence_receipts_remote_identity_check" CHECK (
    "stored_sha256" ~ '^[0-9a-f]{64}$'
    AND "stored_byte_size" > 0
    AND "generation" ~ '^[1-9][0-9]{0,19}$'
    AND "generation"::numeric <= 18446744073709551615
    AND "crc32c" ~ '^[A-Za-z0-9+/]{6}==$'
    AND btrim("bucket") <> ''
    AND btrim("object_key") <> ''
    AND btrim("engine_job_id") <> ''
    AND "preservation_kind" IN ('complete', 'forensic')
  ),
  CONSTRAINT "sync_remote_terminal_evidence_receipts_reclaim_state_check" CHECK (
    "reclaim_state" IN ('pending', 'claiming', 'reclaimed')
    AND "reclaim_attempt_count" >= 0
    AND ("reclaimed_bytes" IS NULL OR "reclaimed_bytes" >= 0)
  ),
  CONSTRAINT "sync_remote_terminal_evidence_receipts_reclaim_claim_check" CHECK (
    ("reclaim_state" = 'claiming' AND "reclaim_claim_token" IS NOT NULL AND "reclaim_claim_expires_at" IS NOT NULL)
    OR ("reclaim_state" <> 'claiming' AND "reclaim_claim_token" IS NULL AND "reclaim_claim_expires_at" IS NULL)
  ),
  CONSTRAINT "sync_remote_terminal_evidence_receipts_reclaimed_check" CHECK (
    ("reclaim_state" = 'reclaimed' AND "reclaimed_at" IS NOT NULL AND "reclaimed_bytes" IS NOT NULL)
    OR ("reclaim_state" <> 'reclaimed' AND "reclaimed_at" IS NULL AND "reclaimed_bytes" IS NULL)
  )
);--> statement-breakpoint

CREATE INDEX "sync_remote_terminal_evidence_receipts_reclaim_ready_idx"
  ON "sync_remote_terminal_evidence_receipts" ("reclaim_state", "reclaim_next_attempt_at");--> statement-breakpoint
CREATE INDEX "sync_remote_terminal_evidence_receipts_source_idx"
  ON "sync_remote_terminal_evidence_receipts" ("engine_job_id", "generation");--> statement-breakpoint

-- The receipt identity and signed hub acknowledgement are permanently
-- immutable.  Reclaim scheduling fields remain mutable so a remote outage can
-- back off safely; a later callback cannot replace the archive that grants
-- deletion authority.
CREATE OR REPLACE FUNCTION prevent_remote_terminal_evidence_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."sim_job_id" IS DISTINCT FROM OLD."sim_job_id"
     OR NEW."promise_id" IS DISTINCT FROM OLD."promise_id"
     OR NEW."solver_id" IS DISTINCT FROM OLD."solver_id"
     OR NEW."terminal_upload_id" IS DISTINCT FROM OLD."terminal_upload_id"
     OR NEW."engine_job_id" IS DISTINCT FROM OLD."engine_job_id"
     OR NEW."preservation_kind" IS DISTINCT FROM OLD."preservation_kind"
     OR NEW."preservation_id" IS DISTINCT FROM OLD."preservation_id"
     OR NEW."bucket" IS DISTINCT FROM OLD."bucket"
     OR NEW."object_key" IS DISTINCT FROM OLD."object_key"
     OR NEW."generation" IS DISTINCT FROM OLD."generation"
     OR NEW."stored_sha256" IS DISTINCT FROM OLD."stored_sha256"
     OR NEW."stored_byte_size" IS DISTINCT FROM OLD."stored_byte_size"
     OR NEW."crc32c" IS DISTINCT FROM OLD."crc32c"
     OR NEW."receipt_canonical" IS DISTINCT FROM OLD."receipt_canonical"
     OR NEW."receipt" IS DISTINCT FROM OLD."receipt"
     OR NEW."receipt_hmac" IS DISTINCT FROM OLD."receipt_hmac"
     OR NEW."received_at" IS DISTINCT FROM OLD."received_at"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'terminal evidence preservation receipt identity and signed payload are immutable';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sync_remote_terminal_evidence_receipts_immutable"
BEFORE UPDATE ON "sync_remote_terminal_evidence_receipts"
FOR EACH ROW EXECUTE FUNCTION prevent_remote_terminal_evidence_receipt_mutation();
--> statement-breakpoint

-- Receipt rows are a terminal/no-publishable-result path only.  The trigger
-- ties the signed receipt to one local remote job and prevents an otherwise
-- valid-looking job-level receipt from bypassing the accepted-result broker.
CREATE OR REPLACE FUNCTION enforce_remote_terminal_evidence_receipt_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  job_row sim_jobs%ROWTYPE;
BEGIN
  SELECT * INTO job_row FROM sim_jobs WHERE id = NEW."sim_job_id";
  IF NOT FOUND
     OR job_row."engine_job_id" IS DISTINCT FROM NEW."engine_job_id"
     OR job_row."request_payload" ->> 'syncPromiseId' IS DISTINCT FROM NEW."promise_id"::text
     OR job_row."request_payload" ->> 'remoteSolver' IS DISTINCT FROM 'true'
     OR job_row."status" NOT IN ('done', 'failed', 'cancelled')
     OR NEW."receipt" ->> 'terminalState' IS DISTINCT FROM job_row."status"::text THEN
    RAISE EXCEPTION 'terminal preservation receipt is not scoped to its exact terminal remote job';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM results result_row
    JOIN result_attempts current_attempt
      ON current_attempt.id = result_row.current_result_attempt_id
     AND current_attempt.result_id = result_row.id
    JOIN result_classifications classification
      ON classification.result_attempt_id = current_attempt.id
     AND classification.state = 'accepted'
    WHERE result_row.sim_job_id = NEW."sim_job_id"
  ) THEN
    RAISE EXCEPTION 'terminal preservation receipt cannot replace accepted result evidence';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "sync_remote_terminal_evidence_receipts_scope_guard"
BEFORE INSERT OR UPDATE ON "sync_remote_terminal_evidence_receipts"
FOR EACH ROW EXECUTE FUNCTION enforce_remote_terminal_evidence_receipt_scope();
