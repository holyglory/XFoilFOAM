import { sql } from "drizzle-orm";

const PROGRESSIVE_REPORT_JOB_LIMIT = 64;
const PROGRESSIVE_ACTIVE_REPORT_JOB_HEADROOM = 6;
const PROGRESSIVE_SETTLEMENT_JOB_LIMIT = 128;
const PROGRESSIVE_NORMAL_SETTLEMENT_JOB_HEADROOM = 6;
const PROGRESSIVE_CLOSED_SETTLEMENT_JOB_RESERVE = 2;

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

const terminalReportJob = sql`(job.status NOT IN ('pending', 'submitted', 'running')
  OR EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
    WHERE stopped.sim_job_id = job.id
      AND stopped.engine_job_id = job.engine_job_id
      AND stopped.engine_job_id = job.id::text))`;

export function progressiveReportPressureSql(jobIds?: string[]) {
  return sql`WITH pending AS MATERIALIZED (
    SELECT report.sim_job_id, count(*)::integer AS reports, min(report.received_at) AS oldest
    FROM progressive_remote_reports report
    LEFT JOIN progressive_remote_progress_receipts receipt
      ON receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence
    LEFT JOIN progressive_remote_report_inventories inventory
      ON inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence
    WHERE receipt.sim_job_id IS NULL OR inventory.sim_job_id IS NULL
    GROUP BY report.sim_job_id
  ), eligible AS (
    SELECT pending.*, ${terminalReportJob} AS terminal_job
    FROM pending JOIN sim_jobs job ON job.id = pending.sim_job_id
    WHERE ${executionScope(jobIds)}
      AND EXISTS (SELECT 1 FROM progressive_remote_dispatches dispatch WHERE dispatch.sim_job_id = job.id)
  )
  SELECT coalesce(sum(reports), 0)::integer AS pending_reports,
    count(*) FILTER (WHERE terminal_job)::integer AS pending_terminal_jobs,
    coalesce(max(extract(epoch FROM (clock_timestamp() - oldest)) * 1000)
      FILTER (WHERE terminal_job), 0)::double precision AS oldest_terminal_age_ms
  FROM eligible`;
}

export function progressiveReportJobsSql(jobIds?: string[], reportBudget = 8) {
  if (!Number.isSafeInteger(reportBudget) || reportBudget < 8 || reportBudget > PROGRESSIVE_REPORT_JOB_LIMIT)
    throw new Error("Report drain budget must preserve live headroom within its selection bound");
  const terminalReserve = reportBudget - PROGRESSIVE_ACTIVE_REPORT_JOB_HEADROOM;
  return sql`WITH report_state AS MATERIALIZED (
      SELECT report.sim_job_id,
        min(report.received_at) FILTER (
          WHERE receipt.sim_job_id IS NULL OR inventory.sim_job_id IS NULL
        ) AS oldest_unapplied_report,
        bool_or(receipt.sim_job_id IS NULL OR inventory.sim_job_id IS NULL) AS has_unapplied,
        bool_or(receipt.sim_job_id IS NOT NULL AND inventory.sim_job_id IS NOT NULL) AS has_indexed
      FROM progressive_remote_reports report
      LEFT JOIN progressive_remote_progress_receipts receipt
        ON receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence
      LEFT JOIN progressive_remote_report_inventories inventory
        ON inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence
      GROUP BY report.sim_job_id
    ), eligible AS MATERIALIZED (
      SELECT job.id AS sim_job_id, job.campaign_id,
        state.has_unapplied, state.has_indexed, state.oldest_unapplied_report,
        -- An authenticated stop can arrive before its final report is applied.
        -- Keep that report in the reserved lane even while job.status lags.
        ${terminalReportJob} AS terminal_job,
        CASE WHEN state.has_unapplied THEN 0 ELSE 1 END AS report_priority,
        CASE WHEN job.status = 'pending' AND job.engine_job_id IS NOT NULL THEN 0
          WHEN job.status = 'pending' AND job.engine_job_id IS NULL THEN 1
          WHEN job.status IN ('submitted', 'running') THEN 2
          ELSE 3 END AS lifecycle_priority,
        coalesce(job."polledAt", job."updatedAt") AS last_polled_at
      FROM report_state state
      JOIN sim_jobs job ON job.id = state.sim_job_id
      WHERE ${executionScope(jobIds)}
        AND (state.has_unapplied OR (
          job.engine_job_id IS NULL AND job.status = 'pending' AND state.has_indexed
        ))
        AND EXISTS (SELECT 1 FROM progressive_remote_dispatches dispatch WHERE dispatch.sim_job_id = job.id)
    ), active_head AS MATERIALIZED (
      SELECT eligible.*
      FROM eligible
      WHERE NOT eligible.terminal_job
      ORDER BY eligible.report_priority, eligible.lifecycle_priority,
        eligible.oldest_unapplied_report NULLS LAST, eligible.last_polled_at,
        eligible.sim_job_id
      LIMIT ${PROGRESSIVE_ACTIVE_REPORT_JOB_HEADROOM}
    ), terminal_head AS MATERIALIZED (
      SELECT eligible.*
      FROM eligible
      WHERE eligible.terminal_job AND eligible.has_unapplied
      ORDER BY eligible.report_priority, eligible.oldest_unapplied_report NULLS LAST,
        eligible.last_polled_at, eligible.sim_job_id
      LIMIT ${terminalReserve}
    ), ordered AS (
      SELECT active_head.*, 0 AS lane FROM active_head
      UNION ALL
      SELECT terminal_head.*, 1 AS lane FROM terminal_head
      UNION ALL
      SELECT eligible.*, 2 AS lane
      FROM eligible
      WHERE NOT EXISTS (
        SELECT 1 FROM active_head selected
        WHERE selected.sim_job_id = eligible.sim_job_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM terminal_head selected
        WHERE selected.sim_job_id = eligible.sim_job_id
      )
    )
    SELECT sim_job_id, campaign_id
    FROM ordered
    ORDER BY lane, report_priority, lifecycle_priority,
      oldest_unapplied_report NULLS LAST, last_polled_at, sim_job_id
    LIMIT ${PROGRESSIVE_REPORT_JOB_LIMIT}`;
}

export function progressiveSettlementJobsSql(jobIds?: string[]) {
  return sql`WITH eligible AS MATERIALIZED (
    SELECT job.id AS sim_job_id, job.campaign_id, retained.ready_closed,
      coalesce(cohort_priority.priority, 1) AS cohort_priority,
      CASE WHEN campaign.status IN ('active', 'attention', 'paused') THEN 0 ELSE 1 END AS campaign_priority,
      CASE WHEN job.status = 'ingesting' AND job.engine_state IN ('completed', 'failed', 'cancelled')
        THEN 0 ELSE 1 END AS lifecycle_priority,
      coalesce(job."polledAt", job."updatedAt") AS last_polled_at
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
    CROSS JOIN LATERAL (
      SELECT coalesce((job.status IN ('done', 'failed', 'cancelled') AND job."ingestedAt" IS NULL
          AND (job.ingest_lease_expires_at <= clock_timestamp()
            OR (job.ingest_lease_token IS NULL AND job.ingest_lease_expires_at IS NULL))
          AND promise.status IN ('expired', 'cancelled', 'fulfilled')
          AND job.engine_job_id = job.id::text
          AND dispatch.envelope->>'solverId' = dispatch.solver_id::text
          AND dispatch.envelope->>'promiseId' = dispatch.promise_id::text
          AND dispatch.envelope#>>'{scope,executionId}' = job.id::text
          AND dispatch.envelope->'scope' = job.request_payload->'progressive'
          AND dispatch.envelope->'request' = job.request_payload->'engineRequest'
          AND EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
            WHERE stopped.sim_job_id = job.id AND stopped.engine_job_id = job.engine_job_id
              AND stopped.proof->>'job_id' = job.engine_job_id
              AND stopped.proof->>'execution_stopped' = 'true'
              AND stopped.proof->>'producer_stopped' = 'true'
              AND stopped.proof->>'namespace_verified' = 'true'
              AND stopped.proof->'remaining' = '[]'::jsonb)
          AND EXISTS (SELECT 1 FROM progressive_remote_evidence_receipts evidence
            WHERE evidence.sim_job_id = job.id AND evidence.storage_only)
          AND EXISTS (SELECT 1 FROM progressive_remote_report_sources source WHERE source.sim_job_id = job.id)
          AND NOT EXISTS (SELECT 1 FROM progressive_remote_report_sources source
            WHERE source.sim_job_id = job.id
              AND NOT EXISTS (SELECT 1 FROM progressive_remote_diagnostic_receipts diagnostic
                WHERE diagnostic.sim_job_id = source.sim_job_id
                  AND diagnostic.point_content_signature = source.point_content_signature)
              AND NOT EXISTS (SELECT 1 FROM progressive_remote_evidence_receipts evidence
                JOIN solver_evidence_archives archive ON archive.result_attempt_id = evidence.result_attempt_id AND archive.state = 'current'
                WHERE evidence.sim_job_id = source.sim_job_id
                  AND evidence.point_content_signature = source.point_content_signature))), false) AS ready_closed
    ) retained
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
        OR retained.ready_closed
        OR (job.status IN ('done', 'failed', 'cancelled')
          AND EXISTS (SELECT 1 FROM progressive_cfd_execution_stops stopped
            WHERE stopped.sim_job_id = job.id)
          AND EXISTS (SELECT 1 FROM progressive_remote_evidence_receipts evidence
            WHERE evidence.sim_job_id = job.id AND NOT evidence.storage_only)
          AND EXISTS (SELECT 1 FROM result_attempts raw
            WHERE raw.sim_job_id = job.id AND raw.status = 'done'))
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
    ), normal_head AS MATERIALIZED (
      SELECT eligible.* FROM eligible WHERE NOT ready_closed
      ORDER BY cohort_priority, campaign_priority, lifecycle_priority, last_polled_at, sim_job_id
      LIMIT ${PROGRESSIVE_NORMAL_SETTLEMENT_JOB_HEADROOM}
    ), closed_head AS MATERIALIZED (
      SELECT eligible.* FROM eligible WHERE ready_closed
      ORDER BY cohort_priority, campaign_priority, lifecycle_priority, last_polled_at, sim_job_id
      LIMIT ${PROGRESSIVE_CLOSED_SETTLEMENT_JOB_RESERVE}
    ), ordered AS (
      SELECT normal_head.*, 0 AS lane FROM normal_head
      UNION ALL
      SELECT closed_head.*, 1 AS lane FROM closed_head
      UNION ALL
      SELECT eligible.*, 2 AS lane FROM eligible
      WHERE NOT EXISTS (SELECT 1 FROM normal_head selected WHERE selected.sim_job_id = eligible.sim_job_id)
        AND NOT EXISTS (SELECT 1 FROM closed_head selected WHERE selected.sim_job_id = eligible.sim_job_id)
    )
    SELECT sim_job_id, campaign_id FROM ordered
    ORDER BY cohort_priority, campaign_priority, lane, lifecycle_priority, last_polled_at, sim_job_id
    LIMIT ${PROGRESSIVE_SETTLEMENT_JOB_LIMIT}`;
}
