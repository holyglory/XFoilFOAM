import type { DB } from "@aerodb/db";
import { ColdReportWitnesses, type ReceiptPoint } from "./cold-report-witnesses";
import { STALE_HZ_RESET_REASON } from "@aerodb/db/progressive-remote-stale-recovery";
import { sql } from "drizzle-orm";

export interface ReportCopyCursor {
  executionId: string;
  sequence: number;
}

interface SignedCopyKey {
  sequence: number;
  signature: string;
  storedBytes: number;
}

interface SignedCopyPage {
  executionId: string;
  keys: readonly SignedCopyKey[];
  bytes: number;
}

/** Keep two signed offers from different owners. Bytes already selected by
 * the latest chronological scan add no priority. The offer remains usable
 * when it is the only one. */
export class CancelledReportCopyPriority {
  private readonly pages: SignedCopyPage[] = [];
  private lastExecutionId?: string;
  private chronologicalDue = false;
  private chronological?: { executionId: string; sequences: Set<number> };

  observeChronological(executionId: string | undefined, sequences: readonly number[]) {
    this.chronological = executionId && sequences.length ? { executionId, sequences: new Set(sequences) } : undefined;
    this.pages.sort((a, b) => this.compare(a, b));
  }

  private disjointBytes(page: SignedCopyPage) {
    const scan = this.chronological;
    if (!scan || scan.executionId !== page.executionId) return page.bytes;
    return page.keys.reduce((n, key) => n + (scan.sequences.has(key.sequence) ? 0 : key.storedBytes), 0);
  }

  private compare(a: SignedCopyPage, b: SignedCopyPage) {
    return this.disjointBytes(b) - this.disjointBytes(a) || b.bytes - a.bytes;
  }

  offer(executionId: string, keys: readonly SignedCopyKey[]) {
    if (!keys.length) return;
    const bytes = keys.reduce((n, k) => n + k.storedBytes, 0);
    const page = { executionId, keys, bytes };
    const prior = this.pages.findIndex(p => p.executionId === executionId);
    if (prior >= 0) {
      if (this.compare(this.pages[prior]!, page) <= 0) return;
      this.pages.splice(prior, 1);
    }
    this.pages.push(page);
    this.pages.sort((a, b) => this.compare(a, b));
    if (this.pages.length > 2) this.pages.pop();
  }

  take() {
    if (this.chronologicalDue) {
      this.chronologicalDue = false;
      return;
    }
    if (!this.pages.length) return;
    const alternate = this.pages[1];
    const index = alternate && this.pages[0]!.executionId === this.lastExecutionId && this.disjointBytes(alternate) > 0 ? 1 : 0;
    const [page] = this.pages.splice(index, 1);
    this.lastExecutionId = page!.executionId;
    this.chronologicalDue = true;
    return page;
  }
}

export async function selectCancelledReportCopyPage(
  db: DB, after: ReportCopyCursor | null, priority?: CancelledReportCopyPriority,
) {
  const preferred = priority?.take();
  if (!preferred) {
    const page = await nextCancelledReportCopies(db, after, true);
    priority?.observeChronological(page.executionId, page.sequences);
    return { ...page, preferred };
  }
  return { executionId: preferred.executionId, sequences: preferred.keys.map(k => k.sequence), after, preferred };
}

// The settlement controller leaves ingestedAt unset while raw evidence is missing.
export const cancelledReportOwner = sql`job.status='cancelled' AND job."ingestedAt" IS NULL
  AND (job.error='Scheduling promise became inactive; evidence delivery remains unresolved'
    OR (job.error=${STALE_HZ_RESET_REASON} AND promise.status='cancelled' AND promise."cancelledAt" IS NOT NULL
      AND promise.response_payload->'authoritativeLeaseLoss'='true'::jsonb
      AND promise.response_payload #>> '{remoteCancellation,disposition}'='operator_release'
      AND promise.response_payload #>> '{remoteCancellation,reason}'=job.error
      AND EXISTS(SELECT FROM progressive_remote_dispatches bound JOIN registered_remote_solvers peer ON peer.id=bound.solver_id
        WHERE bound.sim_job_id=job.id AND bound.promise_id=promise.id AND bound.solver_id=promise.registered_solver_id)
      AND NOT EXISTS(SELECT FROM sync_sweep_promise_points open_point WHERE open_point.promise_id=promise.id AND open_point.status='active')))
  AND job.engine_job_id=job.id::text AND job.engine_state IN ('completed','failed','cancelled')
  AND (job.ingest_lease_token IS NULL OR job.ingest_lease_expires_at<=clock_timestamp())
  AND promise.status IN ('cancelled','expired')
  AND EXISTS (SELECT 1 FROM progressive_cfd_execution_stops st WHERE st.sim_job_id=job.id
    AND st.engine_job_id=job.engine_job_id AND st.proof->>'job_id'=st.engine_job_id
    AND st.proof->>'execution_stopped'='true' AND st.proof->>'producer_stopped'='true'
    AND st.proof->>'namespace_verified'='true' AND st.proof->'remaining'='[]'::jsonb)
  AND NOT EXISTS (SELECT 1 FROM progressive_cfd_attempts active
    WHERE active.sim_job_id=job.id AND active.outcome='running')`;

function availableSource(alias:"anchor"|"warm"){
  const a=sql.identifier(alias);
  return sql`((${a}.archived_at IS NULL AND ${a}.archive_bundle_id IS NULL) OR
    (${a}.archived_at IS NOT NULL AND EXISTS(SELECT FROM progressive_report_archive_members orig_m
      JOIN progressive_report_archive_bundles orig_b ON orig_b.id=orig_m.bundle_id AND orig_b.sim_job_id=orig_m.sim_job_id AND orig_b.source_kind=orig_m.source_kind
      WHERE orig_m.bundle_id=${a}.archive_bundle_id AND orig_m.source_kind='remote' AND orig_m.member_kind='report'
        AND (orig_m.sim_job_id,orig_m.sequence,orig_m.content_signature)=(${a}.sim_job_id,${a}.sequence,${a}.content_signature)
        AND orig_b.verified_at IS NOT NULL AND orig_b.archive_format IN ('jsonl','shared-result-v1'))))`;
}

// The catalogue only identifies the stored scientific witness. Reopen a cold
// original outside the archive transaction before retiring any dependent copy.
export async function verifyColdReceiptSources(db:DB,job:string,sequences:readonly number[], witnesses = new ColdReportWitnesses()){
  const rows=await db.execute<ReceiptPoint>(sql`SELECT DISTINCT e.sequence::int seq,a.content_signature sig,s.point_content_signature point,s.aoa_deg aoa,s.case_slug slug
    FROM progressive_remote_report_sources s JOIN progressive_remote_evidence_receipts e ON e.sim_job_id=s.sim_job_id
      AND e.point_content_signature=s.point_content_signature AND e.sequence<s.sequence
    JOIN progressive_remote_reports a ON a.sim_job_id=e.sim_job_id AND a.sequence=e.sequence AND a.archived_at IS NOT NULL
    WHERE s.sim_job_id=${job}::uuid AND s.sequence IN (${sql.join(sequences.map(n=>sql`${n}::bigint`),sql`,`)})
    ORDER BY seq,point LIMIT 2049`);
  if(rows.length>2048)throw new Error("Cold receipt witnesses exceed the bounded source inventory");
  await witnesses.verify(db, job, rows);
}

// Every source must have its own physical receipt and bound raw archive. The
// receipt-owning report is independently authenticated. A single uncovered sibling holds this member.
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
        AND receipt.sequence<s.sequence AND ${availableSource("anchor")}
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
          AND ${availableSource("warm")}
          AND origin.report_content_signature=warm.content_signature AND acknowledged.content_signature=warm.content_signature)))
  AND NOT EXISTS (SELECT FROM progressive_remote_evidence_receipts e WHERE e.sim_job_id=r.sim_job_id AND e.sequence=r.sequence)
  AND NOT EXISTS (SELECT FROM progressive_remote_diagnostic_receipts d WHERE d.sim_job_id=r.sim_job_id AND d.sequence=r.sequence)
  AND EXISTS (SELECT FROM progressive_remote_reports later WHERE later.sim_job_id=r.sim_job_id AND later.sequence>r.sequence)`;

// The original GCS worker retains its original scientific selection. Pending
// transport copies use the shared-result writer and separate read-through proof.
export const receiptedReportCopy = scientificallyReceiptedReportCopy;

/** A source-less heartbeat can never satisfy the original scientific-receipt
 * predicate. Look ahead on bounded warm primary keys and inspect at most 32
 * actual scientific rows. Advance past the tail only when all sources in the
 * window were considered. A bundle still belongs to one job. */
export async function nextCancelledReportCopies(
  db: DB,
  after: ReportCopyCursor | null,
  requirePriorReceiptKeys = false,
) {
  // The writer needs an earlier receipt for every inventoried point. This
  // optional seek filter uses only those small indexed identities; the full
  // source, raw, receipt, and current-owner checks still decide publication.
  const candidates = requirePriorReceiptKeys
    ? sql`SELECT k.* FROM warm_keys k JOIN owners o ON o.id=k.sim_job_id
        JOIN progressive_remote_report_inventories i ON (i.sim_job_id,i.sequence,i.report_content_signature)
          =(k.sim_job_id,k.sequence,k.content_signature)
        WHERE i.source_count>0 AND NOT EXISTS(SELECT FROM progressive_remote_report_sources s
          WHERE s.sim_job_id=k.sim_job_id AND s.sequence=k.sequence AND NOT EXISTS(
            SELECT FROM progressive_remote_evidence_receipts e WHERE
              (e.sim_job_id,e.point_content_signature)=(s.sim_job_id,s.point_content_signature) AND e.sequence<k.sequence))`
    : sql`SELECT k.* FROM warm_keys k WHERE EXISTS(SELECT FROM progressive_remote_report_sources s
        WHERE s.sim_job_id=k.sim_job_id AND s.sequence=k.sequence)`;
  const rows = await db.execute<{
    sim_job_id: string;
    sequence: string;
    ready: boolean;
  }>(sql`
    WITH warm_keys AS MATERIALIZED (SELECT sim_job_id,sequence,content_signature FROM progressive_remote_reports
      WHERE archived_at IS NULL ${after ? sql`AND (sim_job_id,sequence)>(${after.executionId}::uuid,${after.sequence}::bigint)` : sql``}
      ORDER BY sim_job_id,sequence LIMIT 512),
    owners AS MATERIALIZED (SELECT job.id FROM (SELECT DISTINCT sim_job_id FROM warm_keys) p
      JOIN sim_jobs job ON job.id=p.sim_job_id JOIN progressive_remote_dispatches d ON d.sim_job_id=job.id
      JOIN sync_sweep_promises promise ON promise.id=d.promise_id WHERE ${cancelledReportOwner}
      AND EXISTS(SELECT FROM progressive_remote_evidence_receipts e WHERE e.sim_job_id=job.id)),
    sources AS MATERIALIZED (${candidates} ORDER BY k.sim_job_id,k.sequence LIMIT 32),
    page AS MATERIALIZED (SELECT s.*,true AS inspect FROM sources s UNION ALL
      SELECT last.*,false FROM (SELECT * FROM warm_keys ORDER BY sim_job_id DESC,sequence DESC LIMIT 1) last
      WHERE (SELECT count(*) FROM sources)<32 AND NOT EXISTS(
        SELECT FROM sources s WHERE (s.sim_job_id,s.sequence)=(last.sim_job_id,last.sequence)))
    SELECT r.sim_job_id,r.sequence,CASE WHEN r.inspect AND o.id IS NOT NULL THEN ${receiptedReportCopy} ELSE false END AS ready
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
