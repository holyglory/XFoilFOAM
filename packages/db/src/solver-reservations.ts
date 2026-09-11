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

export function solverCpuReservedJobIdsSql(): SQL {
  return sql`WITH reservation_cfd_jobs AS MATERIALIZED (
    SELECT DISTINCT sim_job_id FROM progressive_cfd_attempts
  ), reservation_worker_intents AS MATERIALIZED (
    SELECT sim_job_id,assignment_signature FROM progressive_worker_submission_intents
  )
  SELECT job.id FROM reservation_cfd_jobs owner JOIN sim_jobs job ON job.id=owner.sim_job_id
  WHERE NOT EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
    WHERE stopped.sim_job_id=job.id AND stopped.engine_job_id=job.engine_job_id)
  UNION ALL
  SELECT job.id FROM reservation_worker_intents owner JOIN sim_jobs job ON job.id=owner.sim_job_id
  WHERE NOT EXISTS (SELECT 1 FROM reservation_cfd_jobs cfd WHERE cfd.sim_job_id=job.id)
    AND ((job.engine_job_id IS NOT NULL AND job.engine_job_id<>job.id::text)
      OR NOT EXISTS (SELECT 1 FROM progressive_worker_reports report
        WHERE report.sim_job_id=job.id AND report.assignment_signature=owner.assignment_signature
          AND report.stopped_engine_job_id=job.id::text))
  UNION ALL
  SELECT job.id FROM sim_jobs job
  WHERE (job.status IN ('submitted','running','ingesting')
    OR (job.status='pending' AND job.engine_state IN ('submitting','submission_cancel_pending','submission_identity_conflict'))
    OR (job.status='cancelled' AND job.engine_state IN ('cancelling','cancel_pending')))
    AND NOT EXISTS (SELECT 1 FROM reservation_cfd_jobs owner WHERE owner.sim_job_id=job.id)
    AND NOT EXISTS (SELECT 1 FROM reservation_worker_intents owner WHERE owner.sim_job_id=job.id)`;
}
