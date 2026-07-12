-- One physical URANS verification/continuation obligation can be referenced
-- by many campaigns. Ownership is normalized so pause/cancel of one campaign
-- cannot erase shared work, while background verification remains independent.

ALTER TABLE "sim_urans_verify_queue"
  ADD COLUMN IF NOT EXISTS "background_owner" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_urans_verify_queue_campaigns" (
  "queue_id" uuid NOT NULL REFERENCES "sim_urans_verify_queue"("id") ON DELETE CASCADE,
  "campaign_id" uuid NOT NULL REFERENCES "sim_campaigns"("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'active',
  "cancelled_at" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sim_urans_verify_queue_campaigns_pk" PRIMARY KEY ("queue_id", "campaign_id"),
  CONSTRAINT "sim_urans_verify_queue_campaigns_state_check" CHECK ("state" IN ('active', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_urans_verify_queue_campaigns_campaign_state_idx"
  ON "sim_urans_verify_queue_campaigns" ("campaign_id", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_urans_verify_queue_campaigns_queue_state_idx"
  ON "sim_urans_verify_queue_campaigns" ("queue_id", "state");
--> statement-breakpoint

-- Preserve the original scalar owner, then attach every additional campaign
-- that already references the same accepted precalc result. Terminal campaign
-- associations remain as cancelled history and never keep work schedulable.
INSERT INTO "sim_urans_verify_queue_campaigns" ("queue_id", "campaign_id", "state", "cancelled_at")
SELECT q.id, owner.id,
       CASE WHEN owner.status IN ('active', 'attention', 'paused') THEN 'active' ELSE 'cancelled' END,
       CASE WHEN owner.status IN ('active', 'attention', 'paused') THEN NULL ELSE now() END
FROM "sim_urans_verify_queue" q
JOIN "sim_campaigns" owner ON owner.id = q.campaign_id
ON CONFLICT ("queue_id", "campaign_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "sim_urans_verify_queue_campaigns" ("queue_id", "campaign_id", "state", "cancelled_at")
SELECT DISTINCT q.id, campaign.id,
       CASE WHEN campaign.status IN ('active', 'attention', 'paused') THEN 'active' ELSE 'cancelled' END,
       CASE WHEN campaign.status IN ('active', 'attention', 'paused') THEN NULL ELSE now() END
FROM "sim_urans_verify_queue" q
JOIN "sim_campaign_points" point ON point.result_id = q.precalc_result_id
JOIN "sim_campaigns" campaign ON campaign.id = point.campaign_id
ON CONFLICT ("queue_id", "campaign_id") DO NOTHING;
--> statement-breakpoint

-- Legacy NULL is ambiguous: it may be an originally-background item, or the
-- residue of campaign_id ON DELETE SET NULL after its campaign was deleted.
-- There is no trustworthy provenance bit in the pre-0043 row, so fail closed.
-- Exact active campaign associations above remain runnable; ambiguous NULL
-- rows stay non-background and the normal discovery path may recreate genuine
-- background verification later from immutable accepted evidence.
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "sim_urans_request_campaigns" (
  "request_id" uuid NOT NULL REFERENCES "sim_urans_requests"("id") ON DELETE CASCADE,
  "campaign_id" uuid NOT NULL REFERENCES "sim_campaigns"("id") ON DELETE CASCADE,
  "state" text NOT NULL DEFAULT 'active',
  "cancelled_at" timestamptz,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "sim_urans_request_campaigns_pk" PRIMARY KEY ("request_id", "campaign_id"),
  CONSTRAINT "sim_urans_request_campaigns_state_check" CHECK ("state" IN ('active', 'cancelled'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_urans_request_campaigns_campaign_state_idx"
  ON "sim_urans_request_campaigns" ("campaign_id", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sim_urans_request_campaigns_request_state_idx"
  ON "sim_urans_request_campaigns" ("request_id", "state");
--> statement-breakpoint

-- Source-result references recover all owners, including campaigns that lost
-- the old open-cell insert race and therefore never appeared in a scalar field.
INSERT INTO "sim_urans_request_campaigns" ("request_id", "campaign_id", "state", "cancelled_at")
SELECT DISTINCT req.id, campaign.id,
       CASE WHEN campaign.status IN ('active', 'attention', 'paused') THEN 'active' ELSE 'cancelled' END,
       CASE WHEN campaign.status IN ('active', 'attention', 'paused') THEN NULL ELSE now() END
FROM "sim_urans_requests" req
JOIN "sim_campaign_points" point ON point.result_id = req.continue_from_result_id
JOIN "sim_campaigns" campaign ON campaign.id = point.campaign_id
ON CONFLICT ("request_id", "campaign_id") DO NOTHING;
--> statement-breakpoint

-- Automatic fresh reused-RANS requests have no continue_from_result_id. Bind
-- them to every exact live campaign cell before migration 0046 applies its
-- ownerless-request fence; creator provenance alone is never ownership.
INSERT INTO "sim_urans_request_campaigns" ("request_id", "campaign_id", "state", "cancelled_at")
SELECT DISTINCT req.id, campaign.id, 'active', NULL::timestamptz
FROM "sim_urans_requests" req
JOIN "sim_campaign_points" point
  ON point."airfoil_id" = req."airfoil_id"
 AND point."revision_id" = req."revision_id"
 AND point."aoa_deg" = req."aoa_deg"
 AND point."derived_by_symmetry" = false
 AND point."state" <> 'released'
JOIN "sim_campaigns" campaign
  ON campaign.id = point."campaign_id"
 AND campaign.status IN ('active', 'attention', 'paused')
JOIN "sim_campaign_conditions" condition
  ON condition.id = point."condition_id"
 AND condition.status IN ('active', 'kept')
LEFT JOIN "results" result ON result.id = point."result_id"
LEFT JOIN "result_classifications" classification
  ON classification.result_id = result.id
WHERE req."requested_by" = 'system:precalc-continuation-v1'
  AND req."fidelity" = 'precalc'
  AND req."aoa_deg" IS NOT NULL
  AND req."continue_from_result_id" IS NULL
  AND (
    classification.state IN ('needs_urans', 'rejected')
    OR result.status = 'failed'
  )
ON CONFLICT ("request_id", "campaign_id") DO NOTHING;
--> statement-breakpoint

-- Some developer databases already applied the superseded, unshipped 0043
-- that added sim_urans_requests.campaign_id. Backfill it dynamically when it
-- exists, then remove the knowingly-wrong scalar owner idempotently.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'sim_urans_requests'
      AND column_name = 'campaign_id'
  ) THEN
    EXECUTE $sql$
      INSERT INTO sim_urans_request_campaigns (request_id, campaign_id, state, cancelled_at)
      SELECT req.id, campaign.id,
             CASE WHEN campaign.status IN ('active', 'attention', 'paused') THEN 'active' ELSE 'cancelled' END,
             CASE WHEN campaign.status IN ('active', 'attention', 'paused') THEN NULL ELSE now() END
      FROM sim_urans_requests req
      JOIN sim_campaigns campaign ON campaign.id = req.campaign_id
      ON CONFLICT (request_id, campaign_id) DO NOTHING
    $sql$;
  END IF;
END $$;
--> statement-breakpoint

DROP INDEX IF EXISTS "sim_urans_requests_campaign_idx";
--> statement-breakpoint
ALTER TABLE "sim_urans_requests" DROP COLUMN IF EXISTS "campaign_id";
--> statement-breakpoint

-- Pending verification with neither a background owner nor a live campaign
-- owner is terminal. Request cleanup follows migration 0046 after its explicit
-- background ownership column has been backfilled.
UPDATE "sim_urans_verify_queue" q
SET state = 'cancelled', "updatedAt" = now()
WHERE q.state = 'pending'
  AND q.background_owner = false
  AND NOT EXISTS (
    SELECT 1 FROM "sim_urans_verify_queue_campaigns" owner
    WHERE owner.queue_id = q.id AND owner.state = 'active'
  );
