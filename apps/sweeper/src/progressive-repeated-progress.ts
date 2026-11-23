import { isDeepStrictEqual } from "node:util";
import { sql } from "drizzle-orm";
import {
  validateProgressiveRemoteReport,
  verifyProgressiveRemoteExecution,
  type DB,
  type ProgressiveRemoteExecutionEnvelope,
  type ProgressiveRemoteReport,
} from "@aerodb/db";
import {
  progressiveRepeatedReportSigner,
  sameLiveProgressStatus,
} from "@aerodb/db/progressive-report-publication-batch";

type Head = {
  sequence: number;
  signature: string;
  payload: string | null;
  header: ProgressiveRemoteReport | null;
};
type Verified = ReturnType<typeof validateProgressiveRemoteReport>;
type Anchor = {
  head: Head;
  envelope: ProgressiveRemoteExecutionEnvelope;
  verified: Verified;
  sign: ReturnType<typeof progressiveRepeatedReportSigner>;
};
export type ProgressPage = { anchor: Anchor; heads: Head[]; reports: Verified[] };

export async function hasProgressStorageColumns(db: DB) {
  const [row] = await db.execute(sql`SELECT count(*)=2 AS supported FROM pg_attribute
    WHERE attrelid=to_regclass('progressive_remote_reports') AND attname IN ('result_payload_hash','archived_at')
      AND attnum>0 AND NOT attisdropped`);
  return row?.supported === true;
}

// Look up the original incomplete prefix before applying any optimization.
// A missing inventory, archived row or stop is a boundary, not a row to skip.
async function pendingHeads(db: DB, job: string, limit: number): Promise<Head[]> {
  const rows = await db.execute(sql`
    SELECT r.sequence,r.content_signature,r.result_payload_hash,
      CASE WHEN p.sequence IS NULL AND i.report_content_signature=r.content_signature
        AND r.archived_at IS NULL AND r.report->'stopProof'='null'::jsonb AND r.report#>>'{status,state}'='running'
        AND ((r.result_payload_hash IS NOT NULL AND r.report->'result'='{"state":"running"}'::jsonb)
          OR (r.result_payload_hash IS NULL AND r.report->'result'='null'::jsonb))
      THEN r.report END AS header
    FROM progressive_remote_reports r
    LEFT JOIN progressive_remote_progress_receipts p ON p.sim_job_id=r.sim_job_id AND p.sequence=r.sequence
    LEFT JOIN progressive_remote_report_inventories i ON i.sim_job_id=r.sim_job_id AND i.sequence=r.sequence
    WHERE r.sim_job_id=${job}::uuid AND (p.sequence IS NULL OR i.sequence IS NULL)
    ORDER BY r.sequence LIMIT ${limit}`);
  return rows.map((r) => ({
    sequence: Number(r.sequence),
    signature: String(r.content_signature),
    payload: r.result_payload_hash == null ? null : String(r.result_payload_hash),
    header: r.header as ProgressiveRemoteReport | null,
  }));
}

function sameSource(a: Head, b: Head) {
  if (!a.header || !b.header || a.payload !== b.payload) return false;
  const { sequence: _a, status: first, ...original } = a.header;
  const { sequence: _b, status: next, ...following } = b.header;
  return isDeepStrictEqual(original, following) && sameLiveProgressStatus(first, next);
}

async function verifyAnchor(db: DB, job: string, head: Head): Promise<Anchor | undefined> {
  const [dispatch] = await db.execute(sql`SELECT envelope,solver_id,promise_id,content_signature
    FROM progressive_remote_dispatches WHERE sim_job_id=${job}::uuid`);
  if (!dispatch) return;
  const envelope = verifyProgressiveRemoteExecution(dispatch.envelope as ProgressiveRemoteExecutionEnvelope, {
    executionId: job,
    solverId: String(dispatch.solver_id),
    promiseId: String(dispatch.promise_id),
    contentSignature: String(dispatch.content_signature),
  });
  // Only a normalized running result needs the full, immutable PG object.
  // Resolve and verify it outside the campaign/job write transaction.
  let original: unknown = head.header;
  if (head.payload !== null) {
    const [row] =
      await db.execute(sql`SELECT resolve_progressive_report(r.report,r.result_payload_hash) AS original
      FROM progressive_remote_reports r WHERE r.sim_job_id=${job}::uuid AND r.sequence=${head.sequence}
        AND r.content_signature=${head.signature} AND r.result_payload_hash=${head.payload}
        AND r.archived_at IS NULL AND r.report=${JSON.stringify(head.header)}::jsonb`);
    if (!row) return;
    original = row.original;
  }
  const verified = validateProgressiveRemoteReport(original, envelope);
  if (verified.contentSignature !== head.signature)
    throw new Error("Remote progress bytes differ from their immutable receipt");
  return { head, envelope, verified, sign: progressiveRepeatedReportSigner(verified.report) };
}

export async function prepareProgressPage(
  db: DB,
  job: string,
  limit: number,
  previous?: Anchor,
): Promise<ProgressPage | undefined> {
  const rows = await pendingHeads(db, job, limit);
  if (rows.length < 2 || !sameSource(rows[0], rows[1])) return;
  const anchor =
    previous && sameSource(previous.head, rows[0]) ? previous : await verifyAnchor(db, job, rows[0]);
  if (!anchor) return;
  const heads: Head[] = [],
    reports: Verified[] = [];
  for (const row of rows) {
    if (
      !row.header ||
      row.sequence !== rows[0].sequence + heads.length ||
      row.header.sequence !== row.sequence ||
      !sameSource(anchor.head, row)
    )
      break;
    const checked =
      row.sequence === anchor.head.sequence && isDeepStrictEqual(row, anchor.head)
        ? anchor.verified
        : validateProgressiveRemoteReport({ ...row.header, result: null }, anchor.envelope);
    const signature =
      checked === anchor.verified || row.payload === null
        ? checked.contentSignature
        : anchor.sign(checked.report);
    if (signature !== row.signature)
      throw new Error("Remote progress bytes differ from their immutable receipt");
    heads.push(row);
    reports.push({
      report: { ...checked.report, result: anchor.verified.report.result },
      contentSignature: signature,
    });
  }
  return heads.length >= 2 ? { anchor, heads, reports } : undefined;
}

export async function pinsMatch(
  db: DB,
  job: string,
  page: ProgressPage,
  envelope: ProgressiveRemoteExecutionEnvelope,
) {
  return (
    envelope.contentSignature === page.anchor.envelope.contentSignature &&
    isDeepStrictEqual(await pendingHeads(db, job, page.heads.length), page.heads)
  );
}
