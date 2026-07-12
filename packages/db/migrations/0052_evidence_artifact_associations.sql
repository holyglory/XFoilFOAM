-- The storage key + checksum identifies immutable bytes, not their owner.
-- Continuous sweeps intentionally reuse mesh/dictionary blobs across AoAs,
-- and a later attempt of the same natural cell may reuse the same bytes. Keep
-- one association row per attempt (or per result for legacy/result-only
-- imports) while every row references the same content-addressed storage key.
DROP INDEX IF EXISTS solver_evidence_artifacts_storage_uq;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS solver_evidence_artifacts_blob_idx
  ON solver_evidence_artifacts (storage_key, sha256);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS solver_evidence_artifacts_attempt_content_uq
  ON solver_evidence_artifacts (
    result_attempt_id,
    kind,
    COALESCE(field, ''),
    COALESCE(role, ''),
    storage_key,
    sha256
  )
  WHERE result_attempt_id IS NOT NULL;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS solver_evidence_artifacts_result_content_uq
  ON solver_evidence_artifacts (
    result_id,
    kind,
    COALESCE(field, ''),
    COALESCE(role, ''),
    storage_key,
    sha256
  )
  WHERE result_attempt_id IS NULL AND result_id IS NOT NULL;
--> statement-breakpoint

-- Promise fulfillment must retain the exact imported attempt generation, not
-- rediscover "some" attempt later from a natural result identity.
ALTER TABLE sync_sweep_promise_points ADD COLUMN result_attempt_id uuid;
--> statement-breakpoint
ALTER TABLE sync_sweep_promise_points
  ADD CONSTRAINT sync_sweep_promise_points_result_attempt_id_fk
  FOREIGN KEY (result_attempt_id) REFERENCES result_attempts(id)
  ON DELETE set null;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sync_sweep_promise_points_attempt_idx
  ON sync_sweep_promise_points (result_attempt_id);
--> statement-breakpoint

UPDATE sync_sweep_promise_points point
SET result_attempt_id = (
      SELECT attempt.id
      FROM result_attempts attempt
      JOIN results result ON result.id = point.result_id
      JOIN result_classifications classification
        ON classification.result_attempt_id = attempt.id
       AND classification.state = 'accepted'
      WHERE attempt.result_id = point.result_id
        AND attempt.sim_job_id IS NULL
        AND attempt.engine_job_id LIKE 'sync:%'
        AND attempt.engine_job_id IS NOT DISTINCT FROM result.engine_job_id
        AND attempt.engine_case_slug IS NOT DISTINCT FROM result.engine_case_slug
        AND attempt.aoa_deg = point.aoa_deg
        AND attempt.regime IS NOT DISTINCT FROM result.regime
    ),
    "updatedAt" = now()
WHERE point.result_id IS NOT NULL
  AND point.result_attempt_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM result_classifications classification
    WHERE classification.result_id = point.result_id
      AND classification.state = 'accepted'
  )
  AND 1 = (
    SELECT count(*)
    FROM result_attempts attempt
    JOIN results result ON result.id = point.result_id
    JOIN result_classifications classification
      ON classification.result_attempt_id = attempt.id
     AND classification.state = 'accepted'
    WHERE attempt.result_id = point.result_id
      AND attempt.engine_job_id IS NOT DISTINCT FROM result.engine_job_id
      AND attempt.engine_case_slug IS NOT DISTINCT FROM result.engine_case_slug
      AND attempt.aoa_deg = point.aoa_deg
      AND attempt.regime IS NOT DISTINCT FROM result.regime
  );
--> statement-breakpoint

-- Remote result delivery is mutable execution policy, not CFD evidence. Keep
-- retry/lease/conflict state out of sim_jobs.request_payload and key one row
-- by promise + canonical result; a changed result_attempt_id/generation_key
-- reopens the same delivery without inventing a second physical result.
CREATE TABLE IF NOT EXISTS sync_remote_result_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  promise_id uuid NOT NULL,
  sim_job_id uuid NOT NULL,
  result_id uuid,
  result_attempt_id uuid,
  aoa_deg double precision,
  generation_key text NOT NULL,
  state text DEFAULT 'pending' NOT NULL,
  attempt_count integer DEFAULT 0 NOT NULL,
  next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
  claim_token uuid,
  claimed_at timestamp with time zone,
  claim_expires_at timestamp with time zone,
  last_http_status integer,
  last_error text,
  remote_conflict_ids jsonb DEFAULT '[]'::jsonb NOT NULL,
  delivered_at timestamp with time zone,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  "updatedAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT sync_remote_result_deliveries_shape_check CHECK (
    (result_id IS NULL AND result_attempt_id IS NULL AND aoa_deg IS NULL)
    OR (result_id IS NOT NULL AND result_attempt_id IS NOT NULL AND aoa_deg IS NOT NULL)
  ),
  CONSTRAINT sync_remote_result_deliveries_state_check CHECK (
    state IN ('pending', 'pushing', 'retry_wait', 'delivered', 'blocked', 'superseded')
  ),
  CONSTRAINT sync_remote_result_deliveries_attempt_count_check CHECK (
    attempt_count >= 0
  ),
  CONSTRAINT sync_remote_result_deliveries_claim_shape_check CHECK (
    (state = 'pushing' AND claim_token IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR (state <> 'pushing' AND claim_token IS NULL AND claim_expires_at IS NULL)
  )
);
--> statement-breakpoint

ALTER TABLE sync_remote_result_deliveries
  ADD CONSTRAINT sync_remote_result_deliveries_promise_id_fk
  FOREIGN KEY (promise_id) REFERENCES sync_sweep_promises(id)
  ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE sync_remote_result_deliveries
  ADD CONSTRAINT sync_remote_result_deliveries_sim_job_id_fk
  FOREIGN KEY (sim_job_id) REFERENCES sim_jobs(id)
  ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE sync_remote_result_deliveries
  ADD CONSTRAINT sync_remote_result_deliveries_result_id_fk
  FOREIGN KEY (result_id) REFERENCES results(id)
  ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE sync_remote_result_deliveries
  ADD CONSTRAINT sync_remote_result_deliveries_attempt_id_fk
  FOREIGN KEY (result_attempt_id) REFERENCES result_attempts(id)
  ON DELETE cascade;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS sync_remote_result_deliveries_result_uq
  ON sync_remote_result_deliveries (promise_id, result_id)
  WHERE result_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS sync_remote_result_deliveries_empty_job_uq
  ON sync_remote_result_deliveries (promise_id, sim_job_id)
  WHERE result_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sync_remote_result_deliveries_ready_idx
  ON sync_remote_result_deliveries (state, next_attempt_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sync_remote_result_deliveries_job_idx
  ON sync_remote_result_deliveries (sim_job_id, state);
--> statement-breakpoint

-- Preserve legacy requestPayload stamps as typed terminal delivery rows.
INSERT INTO sync_remote_result_deliveries (
  promise_id, sim_job_id, result_id, result_attempt_id, aoa_deg,
  generation_key, state, delivered_at, next_attempt_at
)
SELECT
  promise.id,
  job.id,
  result.id,
  attempt.id,
  result.aoa_deg,
  attempt.id::text,
  'delivered',
  (job.request_payload ->> 'remotePushedAt')::timestamptz,
  now()
FROM sim_jobs job
JOIN sync_sweep_promises promise
  ON promise.id::text = job.request_payload ->> 'syncPromiseId'
JOIN results result ON result.sim_job_id = job.id
JOIN LATERAL (
  SELECT candidate.id
  FROM result_attempts candidate
  WHERE candidate.result_id = result.id
    AND candidate.sim_job_id = job.id
    AND candidate.engine_job_id IS NOT DISTINCT FROM result.engine_job_id
    AND candidate.engine_case_slug IS NOT DISTINCT FROM result.engine_case_slug
    AND candidate.aoa_deg = result.aoa_deg
    AND candidate.regime IS NOT DISTINCT FROM result.regime
  ORDER BY candidate."createdAt" DESC, candidate.id DESC
  LIMIT 1
) attempt ON true
WHERE job.request_payload ? 'remotePushedAt'
  AND job.request_payload ->> 'remotePushedAt' IS NOT NULL
  AND pg_input_is_valid(
    job.request_payload ->> 'remotePushedAt',
    'timestamp with time zone'
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint

INSERT INTO sync_remote_result_deliveries (
  promise_id, sim_job_id, generation_key, state, delivered_at,
  next_attempt_at
)
SELECT
  promise.id,
  job.id,
  'legacy-job:' || job.id::text,
  'delivered',
  (job.request_payload ->> 'remotePushedAt')::timestamptz,
  now()
FROM sim_jobs job
JOIN sync_sweep_promises promise
  ON promise.id::text = job.request_payload ->> 'syncPromiseId'
WHERE job.request_payload ? 'remotePushedAt'
  AND job.request_payload ->> 'remotePushedAt' IS NOT NULL
  AND pg_input_is_valid(
    job.request_payload ->> 'remotePushedAt',
    'timestamp with time zone'
  )
  AND NOT EXISTS (
    SELECT 1 FROM results result WHERE result.sim_job_id = job.id
  )
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Idempotent review identity: preserve resolved audit rows, but permit only
-- one pending row for the same source/type/natural identity/incoming evidence.
ALTER TABLE sync_import_conflicts ADD COLUMN fingerprint text;
--> statement-breakpoint

UPDATE sync_import_conflicts
SET fingerprint = encode(sha256(convert_to(jsonb_build_object(
  'sourceInstanceId', source_instance_id,
  'dataType', data_type::text,
  'naturalKey', natural_key,
  'incomingPayload', incoming_payload,
  'artifactManifest', artifact_manifest
)::text, 'UTF8')), 'hex')
WHERE fingerprint IS NULL;
--> statement-breakpoint

WITH ranked AS (
  SELECT
    id,
    first_value(id) OVER (
      PARTITION BY fingerprint ORDER BY "createdAt", id
    ) AS keeper_id,
    row_number() OVER (
      PARTITION BY fingerprint ORDER BY "createdAt", id
    ) AS ordinal
  FROM sync_import_conflicts
  WHERE status = 'pending' AND fingerprint IS NOT NULL
)
UPDATE sync_import_conflicts conflict
SET status = 'archived',
    "resolvedAt" = now(),
    resolution_note = 'deduplicated by migration 0052; pending keeper ' || ranked.keeper_id::text,
    "updatedAt" = now()
FROM ranked
WHERE conflict.id = ranked.id AND ranked.ordinal > 1;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS sync_import_conflicts_pending_fingerprint_uq
  ON sync_import_conflicts (fingerprint)
  WHERE status = 'pending' AND fingerprint IS NOT NULL;
