-- Cumulative engine-result payloads replay every previously completed point.
-- This marker belongs to the exact immutable attempt and is inserted only
-- after all point-owned child evidence has committed. No historical backfill
-- is safe: an old attempt without the marker must take one idempotent replay
-- so a crash-partial projection can fill its missing children.
CREATE TABLE IF NOT EXISTS result_attempt_ingest_completions (
  result_attempt_id uuid PRIMARY KEY NOT NULL,
  result_id uuid NOT NULL,
  projection_version integer NOT NULL,
  payload_signature text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT result_attempt_ingest_completions_attempt_owner_fk
    FOREIGN KEY (result_attempt_id, result_id)
    REFERENCES result_attempts(id, result_id)
    ON DELETE CASCADE,
  CONSTRAINT result_attempt_ingest_completions_projection_version_check
    CHECK (projection_version > 0),
  CONSTRAINT result_attempt_ingest_completions_payload_signature_check
    CHECK (payload_signature ~ '^[0-9a-f]{64}$')
);
