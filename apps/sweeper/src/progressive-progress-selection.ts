import { sql } from "drizzle-orm";

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
      ? sql`job.id IN (${sql.join(jobIds.map((id) => sql`${id}::uuid`), sql`, `)})`
      : sql`false`
    : sql`true`;
}

export function progressiveReportJobsSql(jobIds?: string[]) {
  return sql`SELECT job.id AS sim_job_id, job.campaign_id
    FROM sim_jobs job
    WHERE ${executionScope(jobIds)} AND ${unappliedReports}
      AND EXISTS (SELECT 1 FROM progressive_remote_dispatches dispatch WHERE dispatch.sim_job_id = job.id)
    ORDER BY coalesce(job."polledAt", job."updatedAt"), job.id LIMIT ${PROGRESSIVE_SETTLEMENT_JOB_LIMIT}`;
}

export function progressiveSettlementJobsSql(jobIds?: string[]) {
  return sql`SELECT job.id AS sim_job_id, job.campaign_id
    FROM sim_jobs job
    LEFT JOIN sim_campaigns campaign ON campaign.id = job.campaign_id
    JOIN progressive_remote_dispatches dispatch ON dispatch.sim_job_id = job.id
    LEFT JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
    WHERE ${executionScope(jobIds)} AND NOT ${unappliedReports}
      AND (
        (job.status = 'ingesting' AND job.engine_state IN ('completed', 'failed', 'cancelled'))
        OR (EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped WHERE stopped.sim_job_id = job.id)
          AND EXISTS (SELECT 1 FROM progressive_cfd_attempts attempt
            WHERE attempt.sim_job_id = job.id AND attempt.outcome = 'running'))
        OR (job.status IN ('done', 'failed', 'cancelled') AND EXISTS (
          SELECT 1 FROM progressive_remote_dispatches dispatch JOIN sync_sweep_promises promise ON promise.id = dispatch.promise_id
          WHERE dispatch.sim_job_id = job.id AND promise.status = 'active')))
    ORDER BY CASE WHEN campaign.status IN ('active', 'attention', 'paused') THEN 0 ELSE 1 END,
      CASE WHEN promise.status IN ('expired', 'cancelled')
        AND job.status = 'ingesting'
        AND job.engine_state IN ('completed', 'failed', 'cancelled')
        THEN 0 ELSE 1 END,
      CASE WHEN job.status = 'ingesting'
      AND job.engine_state IN ('completed', 'failed', 'cancelled')
      THEN 0 ELSE 1 END,
      job."updatedAt", job.id LIMIT 32`;
}
