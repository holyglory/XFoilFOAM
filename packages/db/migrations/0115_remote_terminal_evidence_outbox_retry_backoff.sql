-- A terminal no-result package remains retryable until its exact immutable
-- receipt exists, but a failed local archive must yield the sequential worker
-- to later eligible jobs. This is scheduling metadata, never result evidence.
ALTER TABLE "sync_remote_terminal_evidence_uploads"
  ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint

DROP INDEX IF EXISTS "sync_remote_terminal_evidence_uploads_ready_idx";--> statement-breakpoint
CREATE INDEX "sync_remote_terminal_evidence_uploads_ready_idx"
  ON "sync_remote_terminal_evidence_uploads" ("state", "next_attempt_at", "updatedAt");
