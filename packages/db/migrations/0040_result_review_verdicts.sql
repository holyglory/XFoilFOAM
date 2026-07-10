CREATE TABLE IF NOT EXISTS "result_review_verdicts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "result_id" uuid NOT NULL,
  "verdict" text NOT NULL,
  "note" text,
  "reviewer" text NOT NULL,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "revokedAt" timestamp with time zone,
  "revoked_by" text,
  CONSTRAINT "result_review_verdicts_result_id_results_id_fk"
    FOREIGN KEY ("result_id") REFERENCES "results"("id") ON DELETE CASCADE,
  CONSTRAINT "result_review_verdicts_verdict_check"
    CHECK ("verdict" IN ('waive', 'exclude', 'defer'))
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_review_verdicts_active_result_idx"
  ON "result_review_verdicts" ("result_id")
  WHERE "revokedAt" IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "result_review_verdicts_result_history_idx"
  ON "result_review_verdicts" ("result_id", "createdAt");
