import { sql, type SQL } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import { HistoryOperationError, SETTLED_REPORT_SIZE_LIMIT } from "@aerodb/core/point-history-protocol";

const MAX_BYTES = 32 * 1024 * 1024;

/** Only an acknowledged, owner-matched representation can establish a size
 * hold. Absence or ambiguity remains a source verification failure. */
function reportSizes(references: SQL) {
  return sql`SELECT ref.job,ref.sequence,ref.signature,
      CASE WHEN w.archived_at IS NOT NULL THEN m.report_byte_size
        ELSE coalesce(shared.byte_size,0)+octet_length(w.report::text) END AS report_bytes,
      CASE WHEN w.archived_at IS NOT NULL THEN b.stored_byte_size END AS packed_bytes
    FROM ${references} ref
    JOIN progressive_worker_reports w ON w.sim_job_id=ref.job AND w.sequence=ref.sequence
      AND w.content_signature=ref.signature AND w.acknowledged_at IS NOT NULL
    LEFT JOIN progressive_report_archive_bundles b ON b.id=w.archive_bundle_id
      AND b.source_kind='worker' AND b.sim_job_id=w.sim_job_id AND b.verified_at IS NOT NULL
    LEFT JOIN progressive_report_archive_members m ON m.bundle_id=b.id AND m.source_kind='worker'
      AND m.sim_job_id=w.sim_job_id AND m.sequence=w.sequence AND m.content_signature=w.content_signature AND m.member_kind='report'
    LEFT JOIN progressive_report_result_payloads shared ON shared.content_hash=w.result_payload_hash
    WHERE (w.archived_at IS NULL AND w.archive_bundle_id IS NULL
      AND (w.result_payload_hash IS NULL OR shared.content_hash IS NOT NULL))
      OR (w.archived_at IS NOT NULL AND m.report_byte_size>0 AND b.stored_byte_size>0)`;
}

/** Repeat at the read boundary in case a report was archived since selection. */
export async function requireBoundedSettledReport(db: DB, job: string, sequence: number, signature: string) {
  const key = sql`(SELECT ${job}::uuid AS job,${sequence}::bigint AS sequence,${signature}::text AS signature)`;
  const rows = await db.execute(reportSizes(key));
  const [r] = rows;
  if (rows.length !== 1 || !r || !(Number(r.report_bytes) > 0)) throw Error("Worker report lacks a bounded exact source");
  if (Number(r.report_bytes) > MAX_BYTES || Number(r.packed_bytes) > MAX_BYTES)
    throw new HistoryOperationError(SETTLED_REPORT_SIZE_LIMIT, "input");
}

/** A candidate page has at most 64 owners. Measure the shared signed point
 * and terminal reports once per distinct reference. Recheck the native scope
 * only for actual outliers, without fetching or hashing their report bodies. */
export async function limitSettledReportCandidates(db: DB, rows: Record<string, unknown>[]) {
  const ids = rows.filter(r => !r.archive && r.limiter === null).map(r => String(r.id));
  if (!ids.length) return rows;
  const tooLarge = await db.execute(sql`WITH wanted AS MATERIALIZED (
      SELECT value::uuid AS id FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)
    ), points AS MATERIALIZED (
      SELECT a.id,h.sim_job_id AS job,h.sequence,e.content_signature AS signature
      FROM wanted JOIN result_attempts a USING(id)
      JOIN progressive_worker_hub_receipts h ON h.result_attempt_id=a.id AND h.sim_job_id=a.sim_job_id
      JOIN progressive_worker_evidence_receipts e ON e.sim_job_id=h.sim_job_id AND e.sequence=h.sequence
    ), heads AS MATERIALIZED (
      SELECT jobs.job,w.sequence,w.content_signature AS signature FROM (SELECT DISTINCT job FROM points) jobs
      JOIN LATERAL (SELECT sequence,content_signature FROM progressive_worker_reports
        WHERE sim_job_id=jobs.job ORDER BY sequence DESC LIMIT 1) w ON true
    ), members AS MATERIALIZED (
      SELECT id,job,sequence,signature FROM points
      UNION SELECT p.id,h.job,h.sequence,h.signature FROM points p JOIN heads h USING(job)
    ), refs AS MATERIALIZED (SELECT DISTINCT job,sequence,signature FROM members),
    oversized AS MATERIALIZED (SELECT v.job,v.sequence,v.signature FROM (${reportSizes(sql`refs`)}) v
      WHERE v.report_bytes>${MAX_BYTES} OR v.packed_bytes>${MAX_BYTES}),
    held AS MATERIALIZED (SELECT m.id,m.job,m.sequence,m.signature,attempt_evidence_hz_settled_scope(m.id) AS scope
      FROM members m JOIN oversized USING(job,sequence,signature))
    SELECT DISTINCT id FROM held WHERE scope->>'job'=job::text AND
      ((scope->>'sequence'=sequence::text AND scope->>'report'=signature)
      OR (scope->>'stopSequence'=sequence::text AND scope->>'stopReport'=signature))`);
  const heldIds = new Set(tooLarge.map(r => r.id));
  return rows.map(r => heldIds.has(r.id) ? { ...r, limiter: SETTLED_REPORT_SIZE_LIMIT } : r);
}
