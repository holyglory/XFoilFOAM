import { sql } from "drizzle-orm";

export function progressiveCfdNeverStartedAttemptCountSql(alias = "unit") {
  const unit = sql.identifier(alias);
  return sql`(
    SELECT count(*)::int FROM progressive_cfd_attempts stopped_attempt
    JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = stopped_attempt.sim_job_id
    WHERE stopped_attempt.unit_id = ${unit}.id AND stopped_attempt.outcome = 'cancelled'
      AND stopped_attempt.active_seconds = 0
      AND stopped.proof->>'ownership_basis' = 'never_started_cancellation_fence'
      AND NOT EXISTS (SELECT 1 FROM progressive_cfd_evidence receipt
        WHERE receipt.attempt_token = stopped_attempt.token)
  )`;
}

export function progressiveCfdOrdinaryAttemptCountSql(alias = "unit") {
  const unit = sql.identifier(alias);
  return sql`(${unit}.attempts - CASE WHEN EXISTS (
    SELECT 1 FROM progressive_publication_recovery_claims correction WHERE correction.unit_id=${unit}.id
  ) THEN 1 ELSE 0 END - ${progressiveCfdNeverStartedAttemptCountSql(alias)})`;
}

export function progressiveCfdPreciseVerificationAvailableSql(
  alias = "unit",
  settlingAttemptAlias?: string,
) {
  const unit = sql.identifier(alias);
  const settlingToken = settlingAttemptAlias
    ? sql`${sql.identifier(settlingAttemptAlias)}.token`
    : sql`NULL::uuid`;
  return sql`EXISTS (
    SELECT 1 FROM progressive_cfd_recovery_plans recovery
    WHERE recovery.unit_id = ${unit}.id AND recovery.ordinal = 2
      AND NOT EXISTS (
        SELECT 1 FROM progressive_cfd_recovery_claims claimed
        JOIN progressive_cfd_attempts claimed_attempt ON claimed_attempt.token = claimed.attempt_token
        WHERE claimed.recovery_plan_id = recovery.id AND NOT (
          (claimed_attempt.outcome = 'cancelled' OR claimed_attempt.token IS NOT DISTINCT FROM ${settlingToken})
          AND claimed_attempt.active_seconds = 0
          AND EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
            WHERE stopped.sim_job_id = claimed_attempt.sim_job_id
              AND stopped.proof->>'ownership_basis' = 'never_started_cancellation_fence')
          AND NOT EXISTS (SELECT 1 FROM progressive_cfd_evidence evidence
            WHERE evidence.attempt_token = claimed_attempt.token)
        )
      )
  )`;
}
