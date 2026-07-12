-- Durable default-media repair obligations (2026-07-11).
--
-- This table is mutable execution/output metadata. It intentionally does not
-- alter results, attempts, or solver artifacts: those remain immutable CFD
-- evidence while a bounded renderer can rebuild missing presentation media.
CREATE TABLE IF NOT EXISTS "result_media_repairs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL
    REFERENCES "results"("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'pending',
  "evidence_signature" text NOT NULL,
  "background_owner" boolean NOT NULL DEFAULT false,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "max_attempts" integer NOT NULL DEFAULT 3,
  "claim_token" uuid,
  "claimed_at" timestamp with time zone,
  "claim_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone NOT NULL DEFAULT now(),
  "last_error" text,
  "completed_at" timestamp with time zone,
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "result_media_repairs_state_check"
    CHECK ("state" IN ('pending', 'running', 'retry_wait', 'done', 'blocked')),
  CONSTRAINT "result_media_repairs_attempt_check"
    CHECK (
      "attempt_count" >= 0
      AND "max_attempts" BETWEEN 1 AND 3
      AND "attempt_count" <= "max_attempts"
    )
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "result_media_repairs_result_uq"
  ON "result_media_repairs" ("result_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_media_repairs_ready_idx"
  ON "result_media_repairs" ("state", "next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_media_repairs_lease_idx"
  ON "result_media_repairs" ("state", "claim_expires_at");
