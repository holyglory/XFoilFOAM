ALTER TABLE "sim_urans_requests"
  ADD COLUMN IF NOT EXISTS "continue_from_result_attempt_id" uuid;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sim_urans_requests_continuation_attempt_owner_fk'
  ) THEN
    ALTER TABLE "sim_urans_requests"
      ADD CONSTRAINT "sim_urans_requests_continuation_attempt_owner_fk"
      FOREIGN KEY (
        "continue_from_result_attempt_id",
        "continue_from_result_id"
      )
      REFERENCES "result_attempts" ("id", "result_id")
      ON DELETE SET NULL;
  END IF;
END $$;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'sim_urans_requests_continuation_attempt_shape_check'
  ) THEN
    ALTER TABLE "sim_urans_requests"
      ADD CONSTRAINT "sim_urans_requests_continuation_attempt_shape_check"
      CHECK (
        "continue_from_result_attempt_id" IS NULL
        OR "continue_from_result_id" IS NOT NULL
      );
  END IF;
END $$;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "sim_urans_requests_continuation_attempt_idx"
  ON "sim_urans_requests" ("continue_from_result_attempt_id");
--> statement-breakpoint
