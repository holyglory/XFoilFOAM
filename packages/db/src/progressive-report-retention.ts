import { sql } from "drizzle-orm";
import type { DB } from "./client";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export type ProgressiveReportRetentionResult = {
  selected: number;
  deleted: number;
  bytes: number;
};

/**
 * Remove only intermediate progress reports whose terminal job is already
 * ingested and whose source points are fully retained elsewhere. The latest
 * report, evidence-bearing reports, diagnostics, and reports with any
 * undelivered source remain immutable.
 */
export async function reclaimProgressiveReportHistory(
  db: DB,
  input: { campaignId: string; batchSize?: number },
): Promise<ProgressiveReportRetentionResult> {
  const batchSize = input.batchSize ?? 50000;
  if (
    !UUID.test(input.campaignId) ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 50000
  )
    throw new Error("Invalid bounded progressive report retention scope");

  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const deleted = await connection.execute(sql`
      WITH terminal AS MATERIALIZED (
        SELECT job.id
        FROM sim_jobs job
        WHERE job.campaign_id = ${input.campaignId}::uuid
          AND job.status IN ('done', 'failed', 'cancelled')
          AND job."ingestedAt" IS NOT NULL
          AND job.engine_job_id = job.id::text
      ), final_sequence AS MATERIALIZED (
        SELECT report.sim_job_id, max(report.sequence) AS sequence
        FROM progressive_remote_reports report
        JOIN terminal ON terminal.id = report.sim_job_id
        GROUP BY report.sim_job_id
      )
      candidates AS MATERIALIZED (
        SELECT report.sim_job_id, report.sequence,
          pg_column_size(report.report)::bigint AS report_bytes
      FROM progressive_remote_reports report
      JOIN terminal ON terminal.id = report.sim_job_id
      JOIN final_sequence final ON final.sim_job_id = report.sim_job_id
      WHERE report.sequence < final.sequence
        AND NOT EXISTS (
          SELECT 1 FROM progressive_remote_evidence_receipts evidence
          WHERE evidence.sim_job_id = report.sim_job_id
            AND evidence.sequence = report.sequence
        )
        AND NOT EXISTS (
          SELECT 1 FROM progressive_remote_diagnostic_receipts diagnostic
          WHERE diagnostic.sim_job_id = report.sim_job_id
            AND diagnostic.sequence = report.sequence
        )
        AND NOT EXISTS (
          SELECT 1
          FROM progressive_remote_report_sources source
          WHERE source.sim_job_id = report.sim_job_id
            AND source.sequence = report.sequence
            AND NOT EXISTS (
              SELECT 1 FROM progressive_remote_evidence_receipts evidence
              WHERE evidence.sim_job_id = source.sim_job_id
                AND evidence.point_content_signature = source.point_content_signature
            )
        )
      ORDER BY report.received_at, report.sim_job_id, report.sequence
      LIMIT ${batchSize}
      FOR UPDATE OF report SKIP LOCKED
      )
      DELETE FROM progressive_remote_reports report
      USING candidates
      WHERE report.sim_job_id = candidates.sim_job_id
        AND report.sequence = candidates.sequence
      RETURNING candidates.report_bytes
    `);
    return {
      selected: deleted.length,
      deleted: deleted.length,
      bytes: deleted.reduce(
        (total, row) => total + Number(row.report_bytes ?? 0),
        0,
      ),
    };
  });
}
