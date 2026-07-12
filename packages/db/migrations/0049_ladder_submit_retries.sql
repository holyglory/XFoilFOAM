-- Full-fidelity ladder submission failures are scheduling evidence, not CFD
-- evidence. Keep the bounded answered-HTTP retry policy separate from both
-- canonical results and the preliminary-URANS obligation ledger.

CREATE TABLE IF NOT EXISTS "sim_ladder_submit_retries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "urans_request_id" uuid
    REFERENCES "sim_urans_requests"("id") ON DELETE CASCADE,
  "verify_queue_id" uuid
    REFERENCES "sim_urans_verify_queue"("id") ON DELETE CASCADE,
  "state" text NOT NULL,
  -- One automatic retry may be consumed by an answered 5xx. Deterministic
  -- rejections block with zero consumed retries.
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone,
  "latest_sim_job_id" uuid
    REFERENCES "sim_jobs"("id") ON DELETE SET NULL,
  "last_http_status" integer,
  "last_error" text NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "sim_ladder_submit_retries_owner_xor_check"
    CHECK (("urans_request_id" IS NOT NULL) <> ("verify_queue_id" IS NOT NULL)),
  CONSTRAINT "sim_ladder_submit_retries_state_check"
    CHECK ("state" IN ('retry_wait', 'blocked')),
  CONSTRAINT "sim_ladder_submit_retries_attempt_check"
    CHECK ("attempt_count" BETWEEN 0 AND 1),
  CONSTRAINT "sim_ladder_submit_retries_state_shape_check"
    CHECK (
      ("state" = 'retry_wait' AND "attempt_count" = 1 AND "next_attempt_at" IS NOT NULL)
      OR ("state" = 'blocked' AND "next_attempt_at" IS NULL)
    )
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "sim_ladder_submit_retries_request_uq"
  ON "sim_ladder_submit_retries" ("urans_request_id")
  WHERE "urans_request_id" IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "sim_ladder_submit_retries_verify_uq"
  ON "sim_ladder_submit_retries" ("verify_queue_id")
  WHERE "verify_queue_id" IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sim_ladder_submit_retries_ready_idx"
  ON "sim_ladder_submit_retries" ("state", "next_attempt_at");
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sim_ladder_submit_retries_latest_job_idx"
  ON "sim_ladder_submit_retries" ("latest_sim_job_id");
