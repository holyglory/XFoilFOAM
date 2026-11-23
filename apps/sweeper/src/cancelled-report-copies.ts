import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";

export interface ReportCopyCursor {
  executionId: string;
  sequence: number;
}

// The settlement controller leaves ingestedAt unset while raw evidence is missing.
export const cancelledReportOwner = sql`job.status='cancelled' AND job."ingestedAt" IS NULL
  AND job.error='Scheduling promise became inactive; evidence delivery remains unresolved'
  AND job.engine_job_id=job.id::text AND job.engine_state IN ('completed','failed','cancelled')
  AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
  AND promise.status IN ('cancelled','expired')
  AND EXISTS (SELECT 1 FROM progressive_cfd_execution_stops st WHERE st.sim_job_id=job.id
    AND st.engine_job_id=job.engine_job_id AND st.proof->>'job_id'=st.engine_job_id
    AND st.proof->>'execution_stopped'='true' AND st.proof->>'producer_stopped'='true'
    AND st.proof->>'namespace_verified'='true' AND st.proof->'remaining'='[]'::jsonb)
  AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts active
    WHERE active.sim_job_id=job.id AND active.outcome='running')`;

// Every source must have its own physical receipt and bound raw archive. The
// receipt-owning report stays inline. A single uncovered sibling holds this member.
export const scientificallyReceiptedReportCopy = sql`EXISTS (
  SELECT 1 FROM progressive_remote_report_inventories inventory
  JOIN progressive_remote_progress_receipts applied USING (sim_job_id,sequence)
  WHERE inventory.sim_job_id=r.sim_job_id AND inventory.sequence=r.sequence
    AND inventory.report_content_signature=r.content_signature AND applied.content_signature=r.content_signature
    AND inventory.source_count>0
    AND (SELECT count(*)=inventory.source_count AND bool_and(EXISTS (
      SELECT 1 FROM progressive_remote_evidence_receipts receipt
      JOIN progressive_remote_report_sources original USING (sim_job_id,sequence,point_content_signature)
      JOIN progressive_remote_reports anchor USING (sim_job_id,sequence)
      JOIN progressive_remote_report_inventories original_inventory USING (sim_job_id,sequence)
      JOIN result_attempts raw ON raw.id=receipt.result_attempt_id
      JOIN progressive_remote_dispatches d ON d.sim_job_id=receipt.sim_job_id
      JOIN sync_brokered_evidence_uploads u ON u.promise_id=d.promise_id AND u.solver_id=d.solver_id
        AND u.remote_result_attempt_id=receipt.remote_result_attempt_id AND u.remote_result_id=receipt.remote_result_id
      JOIN solver_evidence_archives a ON a.result_attempt_id=raw.id AND a.result_id=raw.result_id
        AND a.source_artifact_id=u.canonical_artifact_id AND a.state='current'
      WHERE receipt.sim_job_id=s.sim_job_id AND receipt.point_content_signature=s.point_content_signature
        AND receipt.sequence<s.sequence AND anchor.archived_at IS NULL AND anchor.archive_bundle_id IS NULL
        AND original_inventory.report_content_signature=anchor.content_signature
        AND original.aoa_deg=s.aoa_deg AND original.case_slug IS NOT DISTINCT FROM s.case_slug
        AND raw.engine_job_id=r.sim_job_id::text AND raw.aoa_deg=s.aoa_deg AND raw.engine_case_slug IS NOT DISTINCT FROM s.case_slug
        AND u.canonical_result_attempt_id=raw.id AND u.canonical_result_id=raw.result_id
        AND u.engine_job_id=raw.engine_job_id AND u.aoa_deg=raw.aoa_deg AND u.engine_case_slug IS NOT DISTINCT FROM raw.engine_case_slug
        AND u.state='bound' AND u.verified_at IS NOT NULL
    )) FROM progressive_remote_report_sources s WHERE s.sim_job_id=r.sim_job_id AND s.sequence=r.sequence)
) AND EXISTS (SELECT 1 FROM progressive_remote_reports later WHERE later.sim_job_id=r.sim_job_id AND later.sequence>r.sequence)`;

// The bundle is the immutable transport manifest. Every member is read back
// from its pinned object before the archive transaction checks this predicate
// again. Leave the first signed source for each point, actual receipt owners,
// and the final report available to the outstanding scientific workflow.
// No scientific or raw custody receipt is derived from this transport proof.
export const repeatedStoppedSource = sql`EXISTS (
  SELECT 1 FROM progressive_remote_report_inventories inv
  JOIN progressive_remote_progress_receipts applied USING (sim_job_id,sequence)
  WHERE inv.sim_job_id=r.sim_job_id AND inv.sequence=r.sequence
    AND inv.report_content_signature=r.content_signature AND applied.content_signature=r.content_signature
    AND inv.source_count>0 AND inv.source_count=(
      SELECT count(*) FROM progressive_remote_report_sources s
      WHERE s.sim_job_id=r.sim_job_id AND s.sequence=r.sequence AND EXISTS (
        SELECT FROM progressive_remote_report_sources earlier
        JOIN progressive_remote_reports warm USING (sim_job_id,sequence)
        JOIN progressive_remote_report_inventories origin USING (sim_job_id,sequence)
        JOIN progressive_remote_progress_receipts acknowledged USING (sim_job_id,sequence)
        WHERE earlier.sim_job_id=s.sim_job_id AND earlier.point_content_signature=s.point_content_signature
          AND earlier.sequence<s.sequence AND earlier.aoa_deg=s.aoa_deg
          AND earlier.case_slug IS NOT DISTINCT FROM s.case_slug
          AND warm.archived_at IS NULL AND warm.archive_bundle_id IS NULL
          AND origin.report_content_signature=warm.content_signature AND acknowledged.content_signature=warm.content_signature)))
  AND NOT EXISTS (SELECT FROM progressive_remote_evidence_receipts e WHERE e.sim_job_id=r.sim_job_id AND e.sequence=r.sequence)
  AND NOT EXISTS (SELECT FROM progressive_remote_diagnostic_receipts d WHERE d.sim_job_id=r.sim_job_id AND d.sequence=r.sequence)
  AND EXISTS (SELECT FROM progressive_remote_reports later WHERE later.sim_job_id=r.sim_job_id AND later.sequence>r.sequence)`;

// The original GCS worker retains its original scientific selection. Pending
// transport copies use the shared-result writer and separate read-through proof.
export const receiptedReportCopy = scientificallyReceiptedReportCopy;

/** Inspect a bounded page of the warm index. Only one job can own a bundle. */
export async function nextCancelledReportCopies(
  db: DB,
  after: ReportCopyCursor | null,
) {
  const rows = await db.execute<{
    sim_job_id: string;
    sequence: string;
    ready: boolean;
  }>(sql`
    WITH page AS MATERIALIZED (SELECT sim_job_id,sequence,content_signature FROM progressive_remote_reports
      WHERE archived_at IS NULL ${after ? sql`AND (sim_job_id,sequence)>(${after.executionId}::uuid,${after.sequence}::bigint)` : sql``}
      ORDER BY sim_job_id,sequence LIMIT 32),
    owners AS MATERIALIZED (SELECT job.id FROM (SELECT DISTINCT sim_job_id FROM page) p
      JOIN sim_jobs job ON job.id=p.sim_job_id JOIN progressive_remote_dispatches d ON d.sim_job_id=job.id
      JOIN sync_sweep_promises promise ON promise.id=d.promise_id WHERE ${cancelledReportOwner})
    SELECT r.sim_job_id,r.sequence,CASE WHEN o.id IS NOT NULL THEN ${receiptedReportCopy} ELSE false END AS ready
    FROM page r LEFT JOIN owners o ON o.id=r.sim_job_id ORDER BY r.sim_job_id,r.sequence`);
  const executionId = rows.find((row) => row.ready)?.sim_job_id;
  const page = executionId
    ? rows.filter((row) => row.sim_job_id === executionId)
    : rows;
  const last = page.at(-1);
  return {
    after: last
      ? { executionId: last.sim_job_id, sequence: Number(last.sequence) }
      : null,
    executionId,
    sequences: page
      .filter((row) => row.ready)
      .map((row) => Number(row.sequence)),
  };
}
