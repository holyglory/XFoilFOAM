-- Two different URANS time steps may render byte-identical frame images.
-- Their physical content-addressed blob is intentionally shared, but each
-- frame index remains a distinct logical artifact association so the complete
-- time track is addressable and exact replays remain deterministic.
DROP INDEX IF EXISTS solver_evidence_artifacts_attempt_content_uq;
--> statement-breakpoint

CREATE UNIQUE INDEX solver_evidence_artifacts_attempt_content_uq
  ON solver_evidence_artifacts (
    result_attempt_id,
    kind,
    COALESCE(field, ''),
    COALESCE(role, ''),
    storage_key,
    sha256,
    COALESCE(metadata ->> 'frameIndex', '')
  )
  WHERE result_attempt_id IS NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS solver_evidence_artifacts_result_content_uq;
--> statement-breakpoint

CREATE UNIQUE INDEX solver_evidence_artifacts_result_content_uq
  ON solver_evidence_artifacts (
    result_id,
    kind,
    COALESCE(field, ''),
    COALESCE(role, ''),
    storage_key,
    sha256,
    COALESCE(metadata ->> 'frameIndex', '')
  )
  WHERE result_attempt_id IS NULL AND result_id IS NOT NULL;
