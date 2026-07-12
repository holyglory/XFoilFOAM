-- Bind every durable default-media repair to one immutable result attempt.
-- The public current-generation pointer remains reserved for evidence already
-- classified accepted/needs_urans; missing presentation media is repaired from
-- attempt-owned raw evidence without publishing rejected coefficients first.
ALTER TABLE result_media_repairs
  ADD COLUMN result_attempt_id uuid;
--> statement-breakpoint

-- Verification publication needs the same normalized execution owner already
-- carried by explicit URANS requests.  A request_payload JSON id is descriptive
-- context, not authority: two historical jobs can contain the same id.
ALTER TABLE sim_urans_verify_queue
  ADD COLUMN sim_job_id uuid;
--> statement-breakpoint

-- Preserve one unambiguous in-flight owner during rolling deployment.  Any
-- ambiguous legacy row remains NULL and therefore fails closed until the queue
-- lifecycle reclaims it and writes a fresh owner.
WITH exact_running_owner AS (
  SELECT
    verify_item.id AS verify_queue_id,
    (min(job.id::text))::uuid AS sim_job_id
  FROM sim_urans_verify_queue verify_item
  JOIN sim_jobs job
    ON job.request_payload ->> 'verifyQueueItemId' = verify_item.id::text
   AND job.airfoil_id = verify_item.airfoil_id
   AND job.simulation_preset_revision_id = verify_item.revision_id
   AND job.status IN ('submitted', 'running', 'ingesting')
  WHERE verify_item.state = 'running'
  GROUP BY verify_item.id
  HAVING count(*) = 1
)
UPDATE sim_urans_verify_queue verify_item
SET sim_job_id = exact_running_owner.sim_job_id,
    "updatedAt" = now()
FROM exact_running_owner
WHERE verify_item.id = exact_running_owner.verify_queue_id;
--> statement-breakpoint

ALTER TABLE sim_urans_verify_queue
  ADD CONSTRAINT sim_urans_verify_queue_sim_job_fk
  FOREIGN KEY (sim_job_id)
  REFERENCES sim_jobs(id)
  ON DELETE SET NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX sim_urans_verify_queue_sim_job_uq
  ON sim_urans_verify_queue (sim_job_id)
  WHERE sim_job_id IS NOT NULL;
--> statement-breakpoint

-- Conservatively bind pre-0056 obligations only when their stored evidence
-- signature names exactly one valid attempt-owned manifest. Ambiguous mutable
-- scheduler rows are intentionally discarded below and can be rediscovered
-- from immutable attempt evidence by the new scanner.
WITH exact_matches AS (
  SELECT
    repair.id AS repair_id,
    attempt.id AS result_attempt_id,
    count(*) OVER (PARTITION BY repair.id) AS match_count
  FROM result_media_repairs repair
  JOIN result_attempts attempt ON attempt.result_id = repair.result_id
  JOIN LATERAL (
    SELECT min(artifact.sha256) AS sha256
    FROM solver_evidence_artifacts artifact
    WHERE artifact.result_id = repair.result_id
      AND artifact.result_attempt_id = attempt.id
      AND artifact.kind = 'manifest'
      AND artifact.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
      AND artifact.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
      AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
      AND artifact.byte_size > 0
      AND length(trim(artifact.storage_key)) > 0
      AND length(trim(artifact.mime_type)) > 0
    HAVING count(*) = 1
  ) manifest ON true
  WHERE repair.evidence_signature = concat_ws(':',
    COALESCE(attempt.engine_job_id, ''),
    COALESCE(attempt.engine_case_slug, ''),
    manifest.sha256
  )
)
UPDATE result_media_repairs repair
SET result_attempt_id = exact_matches.result_attempt_id
FROM exact_matches
WHERE repair.id = exact_matches.repair_id
  AND exact_matches.match_count = 1;
--> statement-breakpoint

-- A short-lived pre-0056 writer could have selected an otherwise-real URANS
-- attempt solely so the result-scoped repair scanner could find it. Capture
-- that output obligation on the exact attempt before removing the invalid
-- public pointer below.
WITH repairable AS (
  SELECT
    result.id AS result_id,
    attempt.id AS result_attempt_id,
    CASE
      WHEN producing_job.id IS NULL THEN true
      WHEN producing_job.campaign_id IS NOT NULL THEN false
      WHEN producing_job.request_payload ? 'verifyQueueItemId' THEN COALESCE((
        SELECT verify_item.background_owner
        FROM sim_urans_verify_queue verify_item
        WHERE verify_item.id::text = producing_job.request_payload ->> 'verifyQueueItemId'
      ), false)
      WHEN producing_job.request_payload ? 'uransRequestId' THEN COALESCE((
        SELECT request_item.background_owner
        FROM sim_urans_requests request_item
        WHERE request_item.id::text = producing_job.request_payload ->> 'uransRequestId'
      ), false)
      ELSE true
    END AS background_owner,
    concat_ws(':',
      COALESCE(attempt.engine_job_id, ''),
      COALESCE(attempt.engine_case_slug, ''),
      manifest.sha256
    ) AS evidence_signature
  FROM results result
  JOIN result_attempts attempt
    ON attempt.id = result.current_result_attempt_id
   AND attempt.result_id = result.id
  JOIN result_classifications classification
    ON classification.result_attempt_id = attempt.id
   AND classification.state = 'rejected'
   AND classification.reasons = ARRAY['missing-urans-video']::text[]
  JOIN LATERAL (
    SELECT min(artifact.sha256) AS sha256
    FROM solver_evidence_artifacts artifact
    WHERE artifact.result_id = result.id
      AND artifact.result_attempt_id = attempt.id
      AND artifact.kind = 'manifest'
      AND artifact.engine_job_id IS NOT DISTINCT FROM attempt.engine_job_id
      AND artifact.engine_case_slug IS NOT DISTINCT FROM attempt.engine_case_slug
      AND artifact.sha256 ~ '^[0-9a-fA-F]{64}$'
      AND artifact.byte_size > 0
      AND length(trim(artifact.storage_key)) > 0
      AND length(trim(artifact.mime_type)) > 0
    HAVING count(*) = 1
  ) manifest ON true
  LEFT JOIN sim_jobs producing_job ON producing_job.id = attempt.sim_job_id
  WHERE attempt.status = 'done'
    AND attempt.source = 'solved'
)
INSERT INTO result_media_repairs (
  result_id, result_attempt_id, state, evidence_signature, background_owner,
  attempt_count, max_attempts, next_attempt_at, last_error, claim_token,
  claimed_at, claim_expires_at, completed_at, downstream_finalized_at,
  "updatedAt"
)
SELECT
  repairable.result_id, repairable.result_attempt_id, 'pending',
  repairable.evidence_signature, repairable.background_owner,
  0, 3, now(), NULL, NULL, NULL, NULL, NULL, NULL, now()
FROM repairable
ON CONFLICT (result_id) DO UPDATE SET
  result_attempt_id = EXCLUDED.result_attempt_id,
  state = 'pending',
  evidence_signature = EXCLUDED.evidence_signature,
  background_owner = result_media_repairs.background_owner OR EXCLUDED.background_owner,
  attempt_count = 0,
  max_attempts = 3,
  next_attempt_at = now(),
  last_error = NULL,
  claim_token = NULL,
  claimed_at = NULL,
  claim_expires_at = NULL,
  completed_at = NULL,
  downstream_finalized_at = NULL,
  "updatedAt" = now();
--> statement-breakpoint

-- Scheduler metadata without one provable exact owner is safe to discard:
-- immutable attempts/artifacts remain intact and eligible work is rediscovered.
DELETE FROM result_media_repairs
WHERE result_attempt_id IS NULL;
--> statement-breakpoint

ALTER TABLE result_media_repairs
  ALTER COLUMN result_attempt_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE result_media_repairs
  ADD CONSTRAINT result_media_repairs_attempt_owner_fk
  FOREIGN KEY (result_attempt_id, result_id)
  REFERENCES result_attempts(id, result_id)
  ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX result_media_repairs_attempt_idx
  ON result_media_repairs (result_attempt_id);
--> statement-breakpoint

-- Restore the 0053 invariant fail-closed.  If even one invalid selected
-- pointer exists, retire every current fitted read model before clearing the
-- pointers.  Compatibility caches span revisions, so a narrower repair would
-- have to reconstruct value-level membership during migration; conservative
-- retirement is exact and the normal cache refresher rebuilds these lazily.
UPDATE polar_fit_sets fit
SET is_current = false,
    "updatedAt" = now()
WHERE fit.is_current = true
  AND EXISTS (
    SELECT 1
    FROM results result
    WHERE result.current_result_attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM result_classifications classification
        WHERE classification.result_attempt_id = result.current_result_attempt_id
          AND classification.state IN ('accepted', 'needs_urans')
      )
  );
--> statement-breakpoint

UPDATE polar_compatibility_fit_sets fit
SET is_current = false,
    "updatedAt" = now()
WHERE fit.is_current = true
  AND EXISTS (
    SELECT 1
    FROM results result
    WHERE result.current_result_attempt_id IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM result_classifications classification
        WHERE classification.result_attempt_id = result.current_result_attempt_id
          AND classification.state IN ('accepted', 'needs_urans')
      )
  );
--> statement-breakpoint

-- An exact generation without an accepted/provisional attempt verdict remains
-- immutable history/repair work only.
UPDATE results result
SET current_result_attempt_id = NULL
WHERE result.current_result_attempt_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM result_classifications classification
    WHERE classification.result_attempt_id = result.current_result_attempt_id
      AND classification.state IN ('accepted', 'needs_urans')
  );
