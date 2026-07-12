-- Answered engine submit failures are execution/scheduling policy, not solver
-- evidence. Keep their one-retry budget and due time in a dedicated table;
-- the canonical results row carries only the truthful cell disposition.

CREATE TABLE IF NOT EXISTS "sim_result_submit_retries" (
  "result_id" uuid PRIMARY KEY
    REFERENCES "results"("id") ON DELETE CASCADE,
  "state" text NOT NULL,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamp with time zone,
  "last_http_status" integer,
  "last_error" text NOT NULL,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "sim_result_submit_retries_state_check"
    CHECK ("state" IN ('retry_wait', 'blocked')),
  CONSTRAINT "sim_result_submit_retries_attempt_check"
    CHECK ("attempt_count" BETWEEN 0 AND 1),
  CONSTRAINT "sim_result_submit_retries_state_shape_check"
    CHECK (
      ("state" = 'retry_wait' AND "attempt_count" = 1 AND "next_attempt_at" IS NOT NULL)
      OR ("state" = 'blocked' AND "next_attempt_at" IS NULL)
    )
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sim_result_submit_retries_ready_idx"
  ON "sim_result_submit_retries" ("state", "next_attempt_at");
