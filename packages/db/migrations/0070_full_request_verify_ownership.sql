-- Explicit admin full-fidelity requests are orchestration owners of the
-- ordinary per-point final-verification queue. They must not bypass the
-- preliminary -> final recovery ledgers with a one-shot targeted full job.
ALTER TABLE "sim_urans_verify_queue"
  ADD COLUMN "continuation_budget_override_s" integer;
--> statement-breakpoint

ALTER TABLE "sim_urans_verify_queue"
  ADD CONSTRAINT "sim_urans_verify_queue_continuation_budget_override_check"
  CHECK (
    "continuation_budget_override_s" IS NULL
    OR "continuation_budget_override_s" > 0
  );
--> statement-breakpoint

-- Rolling deploy fence: a pre-0070 sweeper must fail closed instead of
-- directly submitting a full request after the schema cutover. NOT VALID
-- preserves immutable historical direct-full jobs while enforcing the check
-- for every new/updated row.
ALTER TABLE "sim_jobs"
  ADD CONSTRAINT "sim_jobs_no_direct_full_request_check"
  CHECK (
    "request_payload" IS NULL
    OR NOT (
      "request_payload" ? 'uransRequestId'
      AND "request_payload" ->> 'uransFidelity' = 'full'
      AND NOT ("request_payload" ? 'verifyQueueItemId')
    )
  ) NOT VALID;
--> statement-breakpoint

CREATE TABLE "sim_urans_verify_queue_requests" (
  "queue_id" uuid NOT NULL
    REFERENCES "sim_urans_verify_queue"("id") ON DELETE CASCADE,
  "request_id" uuid NOT NULL
    REFERENCES "sim_urans_requests"("id") ON DELETE CASCADE,
  "createdAt" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sim_urans_verify_queue_requests_queue_id_request_id_pk"
    PRIMARY KEY ("queue_id", "request_id")
);
--> statement-breakpoint

CREATE INDEX "sim_urans_verify_queue_requests_request_idx"
  ON "sim_urans_verify_queue_requests" ("request_id");
--> statement-breakpoint

-- Preserve ownership for open exact/whole-polar full requests wherever the
-- automatic final queue already exists. Missing preliminary coverage is
-- materialized by the sweeper from the immutable request scope.
INSERT INTO "sim_urans_verify_queue_requests" (
  "queue_id",
  "request_id"
)
SELECT DISTINCT ON (request.id, queue.aoa_deg)
  queue.id,
  request.id
FROM "sim_urans_requests" request
JOIN "sim_urans_verify_queue" queue
  ON queue.airfoil_id = request.airfoil_id
 AND queue.revision_id = request.revision_id
 AND (request.aoa_deg IS NULL OR queue.aoa_deg = request.aoa_deg)
WHERE request.fidelity = 'full'
  AND request.state IN ('pending', 'running')
  AND queue.state IN ('pending', 'running', 'done', 'disagreed', 'blocked')
ORDER BY
  request.id,
  queue.aoa_deg,
  CASE queue.state
    WHEN 'done' THEN 0
    WHEN 'disagreed' THEN 1
    WHEN 'pending' THEN 2
    WHEN 'running' THEN 3
    WHEN 'blocked' THEN 4
    ELSE 5
  END,
  queue."updatedAt" DESC,
  queue.id
ON CONFLICT DO NOTHING;
--> statement-breakpoint

-- Direct-full submit retry rows belonged to the removed bypass. Real jobs and
-- immutable result attempts remain untouched; aggregate requests now inherit
-- retry/terminal truth from their preliminary and final child ledgers.
DELETE FROM "sim_ladder_submit_retries" retry
USING "sim_urans_requests" request
WHERE retry.urans_request_id = request.id
  AND request.fidelity = 'full';
