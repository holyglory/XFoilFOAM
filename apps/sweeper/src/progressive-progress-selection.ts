import { sql } from "drizzle-orm";

const PROGRESSIVE_REPORT_JOB_LIMIT = 32;
const PROGRESSIVE_SETTLEMENT_JOB_LIMIT = 128;

const unappliedReports = sql`EXISTS (
  SELECT 1 FROM progressive_remote_reports report
  WHERE report.sim_job_id = job.id AND (
    NOT EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
      WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
    OR NOT EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
      WHERE inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence)))`;

function executionScope(jobIds?: string[]) {
  return jobIds
    ? jobIds.length
      ? sql`job.id IN (${sql.join(
          jobIds.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`
      : sql`false`
    : sql`true`;
}

export function progressiveReportJobsSql(jobIds?: string[]) {
  return sql`SELECT job.id AS sim_job_id, job.campaign_id
    FROM sim_jobs job
    WHERE ${executionScope(jobIds)} AND ${unappliedReports}
      AND EXISTS (SELECT 1 FROM progressive_remote_dispatches dispatch WHERE dispatch.sim_job_id = job.id)
    ORDER BY coalesce(job."polledAt", job."updatedAt"), job.id LIMIT ${PROGRESSIVE_REPORT_JOB_LIMIT}`;
}

export function progressiveSettlementJobsSql(jobIds?: string[]) {
  return sql`SELECT job.id AS sim_job_id, job.campaign_id
    FROM sim_jobs job
    LEFT JOIN sim_campaigns campaign ON campaign.id = job.campaign_id
    JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id = job.id
    LEFT JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN bool_or(member.cohort = 'low') THEN 0 ELSE 1 END AS priority
      FROM progressive_cfd_attempts attempt
      JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
      JOIN progressive_work work ON work.id = unit.work_id
      JOIN progressive_generation_cohort_targets member
        ON member.generation_id = work.generation_id AND member.target_id = work.target_id
      WHERE attempt.sim_job_id = job.id
    ) cohort_priority ON true
    WHERE ${executionScope(jobIds)} AND NOT ${unappliedReports}
      AND (
        (job.status = 'ingesting' AND job.engine_state IN ('completed', 'failed', 'cancelled'))
        OR (EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped WHERE stopped.sim_job_id = job.id)
          AND EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt
            WHERE attempt.sim_job_id = job.id AND attempt.outcome = 'running'))
        OR (job.status IN ('done', 'failed', 'cancelled')
          AND EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
            WHERE stopped.sim_job_id = job.id)
          AND EXISTS (SELECT 1
            FROM progressive_cfd_attempts attempt
            JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
            WHERE attempt.sim_job_id = job.id
              AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts newer
                WHERE newer.unit_id = unit.id
                  AND (newer.started_at, newer.token) > (attempt.started_at, attempt.token))
              AND ((unit.state = 'leased' AND unit.lease_token = attempt.token
                AND unit.lease_until <= clock_timestamp())
                OR (unit.state = 'blocked' AND unit.lease_token IS NULL
                  AND unit.lease_until IS NULL))))
        OR (job.status IN ('done', 'failed', 'cancelled') AND EXISTS (
          SELECT 1 FROM progressive_remote_dispatches dispatch JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
          WHERE dispatch.sim_job_id = job.id AND promise.status = 'active'))
        OR (job.status IN ('done', 'failed', 'cancelled')
          AND EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
            WHERE stopped.sim_job_id = job.id)
          AND EXISTS (SELECT 1
            FROM results result
            JOIN result_attempts raw ON raw.result_id = result.id
            JOIN result_classifications classification
              ON classification.result_attempt_id = raw.id
            WHERE raw.sim_job_id = job.id
              AND raw.status = 'done'
              AND raw.valid_for_polar
              AND classification.state = 'accepted'
              AND result.current_result_attempt_id IS NULL
              AND coalesce((SELECT review.verdict::text
                FROM result_review_verdicts review
                WHERE review.result_id = result.id AND review."revokedAt" IS NULL
                ORDER BY review."createdAt" DESC, review.id DESC LIMIT 1), '')
                NOT IN ('exclude', 'defer'))))
    ORDER BY coalesce(cohort_priority.priority, 1),
      CASE WHEN campaign.status IN ('active', 'attention', 'paused') THEN 0 ELSE 1 END,
      CASE WHEN job.status = 'ingesting'
      AND job.engine_state IN ('completed', 'failed', 'cancelled')
      THEN 0 ELSE 1 END,
      coalesce(job."polledAt", job."updatedAt"), job.id LIMIT ${PROGRESSIVE_SETTLEMENT_JOB_LIMIT}`;
}
