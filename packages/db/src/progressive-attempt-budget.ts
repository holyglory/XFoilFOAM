import { sql } from "drizzle-orm";

export function progressiveCfdOrdinaryAttemptCountSql(alias = "unit") {
  const unit = sql.identifier(alias);
  return sql`(${unit}.attempts - CASE WHEN EXISTS (
    SELECT 1 FROM progressive_publication_recovery_claims correction WHERE correction.unit_id=${unit}.id
  ) THEN 1 ELSE 0 END - (
    SELECT count(*) FROM progressive_cfd_attempts stopped_attempt
    JOIN progressive_cfd_execution_stops stopped ON stopped.sim_job_id = stopped_attempt.sim_job_id
    WHERE stopped_attempt.unit_id = ${unit}.id AND stopped_attempt.outcome = 'cancelled'
      AND stopped_attempt.active_seconds = 0
      AND stopped.proof->>'ownership_basis' = 'never_started_cancellation_fence'
      AND NOT EXISTS (SELECT 1 FROM progressive_cfd_evidence receipt
        WHERE receipt.attempt_token = stopped_attempt.token)
  ))`;
}
