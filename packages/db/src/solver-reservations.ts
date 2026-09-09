import { sql, type SQL } from "drizzle-orm";

export function solverLocalExecutionSql(alias = "sim_jobs"): SQL {
  const job = sql.identifier(alias);
  return sql`NOT EXISTS (SELECT 1 FROM progressive_remote_dispatches remote_dispatch
    WHERE remote_dispatch.sim_job_id = ${job}.id)`;
}

export function solverDirectLifecycleSql(alias = "sim_jobs"): SQL {
  const job = sql.identifier(alias);
  return sql`(${solverLocalExecutionSql(alias)} AND NOT coalesce(${job}.request_payload ? 'remoteProgressiveExecution', false))`;
}

export function solverCpuReservationSql(alias = "sim_jobs"): SQL {
  const job = sql.identifier(alias);
  return sql`CASE WHEN EXISTS (
    SELECT 1 FROM progressive_cfd_attempts reserved_attempt
    WHERE reserved_attempt.sim_job_id = ${job}.id
  ) THEN NOT EXISTS (
    SELECT 1 FROM progressive_cfd_execution_stops stopped
    WHERE stopped.sim_job_id = ${job}.id
      AND stopped.engine_job_id = ${job}.engine_job_id
  ) WHEN EXISTS (
    SELECT 1 FROM progressive_worker_submission_intents intent WHERE intent.sim_job_id = ${job}.id
  ) THEN (
    (${job}.engine_job_id IS NOT NULL AND ${job}.engine_job_id <> ${job}.id::text)
    OR NOT EXISTS (
      SELECT 1 FROM progressive_worker_reports report
      JOIN progressive_worker_submission_intents intent ON intent.sim_job_id = report.sim_job_id
      WHERE report.sim_job_id = ${job}.id
        AND report.assignment_signature = intent.assignment_signature
        AND report.stopped_engine_job_id = ${job}.id::text
    )
  ) ELSE (
    ${job}.status IN ('submitted', 'running', 'ingesting')
    OR (${job}.status = 'pending' AND ${job}.engine_state IN (
      'submitting', 'submission_cancel_pending', 'submission_identity_conflict'
    ))
    OR (${job}.status = 'cancelled' AND ${job}.engine_state IN ('cancelling', 'cancel_pending'))
  ) END`;
}
