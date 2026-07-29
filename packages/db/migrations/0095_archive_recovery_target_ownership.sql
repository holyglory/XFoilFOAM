-- An archive recovery target is an immutable ownership receipt. Older
-- migrations protected the source archive but allowed two replacement/archive
-- actions to point at the same active request or FINAL verify queue. Keep the
-- earliest active receipt as the historical owner and terminalize competing
-- handoffs before making that invariant durable. No solver evidence or target
-- work is deleted by this repair.
--
-- See 0094 for the ordered reconciliation path: this migration deliberately
-- defers its work to 0096 until the recovery-action ledger exists.
DO $$
BEGIN
  IF to_regclass('public.result_interpretation_recovery_actions') IS NULL THEN
    RETURN;
  END IF;

  WITH ranked AS (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY target_urans_request_id
        ORDER BY "createdAt" ASC, id ASC
      ) AS ownership_rank
    FROM result_interpretation_recovery_actions
    WHERE target_urans_request_id IS NOT NULL
      AND state IN (
        'waiting_for_precalc', 'continuation_routed', 'fresh_rerun_routed'
      )
  )
  UPDATE result_interpretation_recovery_actions action
  SET state = 'blocked',
      claim_token = NULL,
      claim_expires_at = NULL,
      decision_reason =
        'a prior archive recovery action already owns this active URANS request',
      last_error =
        'migration fenced a competing archive recovery action; the existing request owner remains authoritative',
      next_attempt_at = now(),
      "updatedAt" = now()
  FROM ranked
  WHERE action.id = ranked.id
    AND ranked.ownership_rank > 1;

  WITH ranked AS (
    SELECT
      id,
      row_number() OVER (
        PARTITION BY target_verify_queue_id
        ORDER BY "createdAt" ASC, id ASC
      ) AS ownership_rank
    FROM result_interpretation_recovery_actions
    WHERE target_verify_queue_id IS NOT NULL
      AND state = 'continuation_routed'
  )
  UPDATE result_interpretation_recovery_actions action
  SET state = 'blocked',
      claim_token = NULL,
      claim_expires_at = NULL,
      decision_reason =
        'a prior archive recovery action already owns this active FINAL verify queue',
      last_error =
        'migration fenced a competing archive recovery action; the existing verify queue owner remains authoritative',
      next_attempt_at = now(),
      "updatedAt" = now()
  FROM ranked
  WHERE action.id = ranked.id
    AND ranked.ownership_rank > 1;

  IF to_regclass('public.ri_recovery_active_request_owner_uq') IS NULL THEN
    EXECUTE '
      CREATE UNIQUE INDEX "ri_recovery_active_request_owner_uq"
        ON "result_interpretation_recovery_actions" ("target_urans_request_id")
        WHERE "target_urans_request_id" IS NOT NULL
          AND "state" IN (
            ''waiting_for_precalc'', ''continuation_routed'', ''fresh_rerun_routed''
          )
    ';
  END IF;

  IF to_regclass('public.ri_recovery_active_verify_owner_uq') IS NULL THEN
    EXECUTE '
      CREATE UNIQUE INDEX "ri_recovery_active_verify_owner_uq"
        ON "result_interpretation_recovery_actions" ("target_verify_queue_id")
        WHERE "target_verify_queue_id" IS NOT NULL
          AND "state" = ''continuation_routed''
    ';
  END IF;
END $$;

