-- Productive final-URANS trajectories may need more than one cross-job
-- continuation. Keep a consecutive no-progress circuit breaker instead of
-- bounding continuations by the number of fresh starts.
ALTER TABLE "sim_urans_verify_queue"
  ADD COLUMN IF NOT EXISTS "continuation_no_progress_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

ALTER TABLE "sim_urans_verify_queue"
  DROP CONSTRAINT IF EXISTS "sim_urans_verify_queue_continuation_attempt_count_check";
--> statement-breakpoint

ALTER TABLE "sim_urans_verify_queue"
  ADD CONSTRAINT "sim_urans_verify_queue_continuation_attempt_count_check"
    CHECK ("continuation_attempt_count" >= 0),
  ADD CONSTRAINT "sim_urans_verify_queue_continuation_no_progress_count_check"
    CHECK (
      "continuation_no_progress_count" >= 0
      AND "continuation_no_progress_count" <= "continuation_attempt_count"
    );
