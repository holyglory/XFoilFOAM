-- An archive id is part of the immutable reduction input.  The former
-- attempt/reducer/signature index merged two archive generations with equal
-- raw bytes, returning an interpretation causally bound to archive A when a
-- queue item for replacement archive B was selected.
--> statement-breakpoint

DROP INDEX IF EXISTS "result_interpretations_attempt_reducer_evidence_uq";
--> statement-breakpoint

-- PostgreSQL silently truncates identifiers longer than 63 bytes. Keep these
-- two provenance indexes explicitly below that limit so the migration,
-- schema metadata, preflight, and operational introspection agree on one
-- stable identity.
CREATE UNIQUE INDEX IF NOT EXISTS "result_interpretations_archive_attempt_reducer_src_evidence_uq"
  ON "result_interpretations" (
    "result_attempt_id", "reducer_version_id", "source_archive_id", "input_evidence_signature"
  )
  WHERE "source" = 'archive_backfill';
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "result_interpretations_nonarchive_attempt_reducer_evidence_uq"
  ON "result_interpretations" (
    "result_attempt_id", "reducer_version_id", "input_evidence_signature"
  )
  WHERE "source" <> 'archive_backfill';
