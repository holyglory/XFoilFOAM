import { sql } from "drizzle-orm";

const PROGRESSIVE_BOUNDED_NO_EVIDENCE_RECOVERY_REASONS = [
  "terminal execution has no measured case evidence",
  "Stale HZ remote execution released during disposable solver reset",
  "obsolete execution physically stopped",
  "unstarted submission retry budget exhausted or history incomplete",
] as const;
const PROGRESSIVE_BOUNDED_NO_EVIDENCE_RECOVERY_REASONS_SQL = sql`(${sql.join(
  PROGRESSIVE_BOUNDED_NO_EVIDENCE_RECOVERY_REASONS.map((reason) => sql`${reason}`),
  sql`, `,
)})`;

export function progressiveCfdNoAcceptedHistoryAndSettledSql(alias = "unit") {
  const unit = sql.identifier(alias);
  return sql`(
    NOT EXISTS (
      SELECT 1
      FROM progressive_cfd_attempts history
      JOIN progressive_cfd_evidence evidence
        ON evidence.attempt_token = history.token
      JOIN result_attempts raw
        ON raw.id = evidence.result_attempt_id
      LEFT JOIN result_classifications accepted_attempt
        ON accepted_attempt.result_attempt_id = raw.id
      LEFT JOIN result_classifications accepted_result
        ON accepted_result.result_id = raw.result_id
      WHERE history.unit_id = ${unit}.id
        AND (
          accepted_attempt.state = 'accepted'
          OR accepted_result.state = 'accepted'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM progressive_cfd_attempts history
      LEFT JOIN sim_jobs history_job
        ON history_job.id = history.sim_job_id
      LEFT JOIN progressive_cfd_execution_stops history_stop
        ON history_stop.sim_job_id = history.sim_job_id
        AND history_stop.engine_job_id = history_job.engine_job_id
      WHERE history.unit_id = ${unit}.id
        AND history.sim_job_id IS NOT NULL
        AND (
          history.outcome = 'running'
          OR (
            history_stop.sim_job_id IS NULL
            AND NOT (
              history.error = 'Stale HZ remote execution released during disposable solver reset'
              AND history_job.status = 'cancelled'
              AND history_job.engine_state = 'cancelled'
              AND history_job.engine_job_id IS NULL
              AND NOT EXISTS (
                SELECT 1
                FROM progressive_remote_dispatches dispatch
                JOIN sync_sweep_promises promise
                  ON promise.id = dispatch.promise_id
                WHERE dispatch.sim_job_id = history.sim_job_id
                  AND promise.status = 'active'
              )
            )
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM progressive_cfd_attempts history
      JOIN progressive_remote_dispatches dispatch
        ON dispatch.sim_job_id = history.sim_job_id
      JOIN sync_sweep_promises promise
        ON promise.id = dispatch.promise_id
      WHERE history.unit_id = ${unit}.id
        AND promise.status = 'active'
    )
  )`;
}

export function progressiveCfdBoundedNoEvidenceRecoveryAvailableSql(
  alias = "unit",
) {
  const unit = sql.identifier(alias);
  return sql`(
    ${unit}.attempts = 3
    AND ${unit}.active_seconds < ${unit}.active_budget_seconds
    AND ${unit}.error IN ${PROGRESSIVE_BOUNDED_NO_EVIDENCE_RECOVERY_REASONS_SQL}
    AND ${progressiveCfdNoAcceptedHistoryAndSettledSql(alias)}
  )`;
}

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

export function progressiveCfdCompletionRetryAvailableSql(
  unitAlias = "unit",
  workAlias = "work",
) {
  const unit = sql.identifier(unitAlias);
  const work = sql.identifier(workAlias);
  return sql`(
    ${unit}.attempts = 2
    AND ${unit}.active_seconds < ${unit}.active_budget_seconds
    AND (
      (${work}.stage = 2 AND ${unit}.error IN (
        'terminal execution has no measured case evidence',
        'fast pass has no informative accepted evidence'
      ))
      OR (${work}.stage = 3 AND ${unit}.error IN (
        'terminal execution has no measured case evidence',
        'precise evidence remains unresolved'
      ))
    )
  )`;
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

export function progressiveCfdMaterialDomainRecoveryAvailableSql(
  alias = "unit",
  settlingAttemptAlias?: string,
) {
  const unit = sql.identifier(alias);
  const settlingToken = settlingAttemptAlias
    ? sql`${sql.identifier(settlingAttemptAlias)}.token`
    : sql`NULL::uuid`;
  return sql`EXISTS (
    SELECT 1 FROM progressive_cfd_recovery_plans recovery
    WHERE recovery.unit_id = ${unit}.id
      AND recovery.ordinal = 1
      AND recovery.reason = 'material_domain'
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
