import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import {
  ProgressiveReportArchiveTimeout,
  readArchivedProgressiveReportText,
  type ProgressiveReportSourceKind,
} from "@aerodb/db/progressive-report-reader";

const scanRows = 128;
const pageReads = 8;
const readBudget = 1024 * 1024;

/** Use idle time; after a long archive overrun, allow fast members up to
 * one twenty-fifth of that overrun before the next ordinary poll. The current
 * member always retains its normal read deadline and write guard. */
export function statusReadWindowMs(untilNextArchivePollMs: number) {
  if (untilNextArchivePollMs >= 0) return untilNextArchivePollMs;
  return Math.min(1250, -untilNextArchivePollMs / 25);
}

interface Cursor {
  job: string;
  sequence: number;
}
export interface SettledStatusReportKey extends Cursor {
  signature: string;
  bundle: string;
}
interface Candidate extends SettledStatusReportKey {
  originalBytes: number;
  eligible: boolean;
}

const tableFor = (source: ProgressiveReportSourceKind) =>
  sql.identifier(
    source === "worker"
      ? "progressive_worker_reports"
      : "progressive_remote_reports",
  );

/** Reuse the ordinary exact reader outside write locks. CAS the original
 * archive member and let the database recheck ownership at the actual write. */
export async function compactSettledStatusHeader(
  db: DB,
  source: ProgressiveReportSourceKind,
  row: SettledStatusReportKey,
) {
  const [gate] =
    await db.execute(sql`SELECT public.progressive_status_header_settled(
    ${source},r.sim_job_id,r.sequence,r.content_signature,r.report) AS ready,pg_column_size(r.report) AS bytes
    FROM ${tableFor(source)} r JOIN public.progressive_report_archive_members m
    ON m.sim_job_id=r.sim_job_id AND m.sequence=r.sequence AND m.member_kind='report' AND m.source_kind=${source}
    AND m.bundle_id=r.archive_bundle_id AND m.content_signature=r.content_signature AND m.report_byte_size<=${readBudget}
    WHERE r.sim_job_id=${row.job}::uuid AND r.sequence=${row.sequence} AND r.content_signature=${row.signature}
    AND r.archive_bundle_id=${row.bundle}::uuid AND r.archived_at IS NOT NULL`);
  if (gate?.ready !== true) return null;
  const original = await readArchivedProgressiveReportText(db, {
    sourceKind: source,
    executionId: row.job,
    sequence: row.sequence,
    contentSignature: row.signature,
  });
  if (!original || original.bundleId !== row.bundle) return null;
  const [changed] = await db.transaction((tx) =>
    tx.execute(sql`
    WITH locked AS MATERIALIZED (
      SELECT r.sim_job_id,r.sequence FROM ${tableFor(source)} AS r
      WHERE r.sim_job_id=${row.job}::uuid AND r.sequence=${row.sequence} AND r.content_signature=${row.signature}
        AND r.archive_bundle_id=${row.bundle}::uuid AND r.archived_at IS NOT NULL AND r.result_payload_hash IS NULL
        AND public.progressive_settled_status_header(r.report) IS NOT NULL FOR UPDATE OF r SKIP LOCKED
    )
    UPDATE ${tableFor(source)} AS r SET report=jsonb_build_object(
      'statusHeaderOriginalText',${original.text}::text,'generation',${original.generation}::text,
      'storedSha256',${original.storedSha256}::text)
    FROM locked WHERE r.sim_job_id=locked.sim_job_id AND r.sequence=locked.sequence
    RETURNING pg_column_size(r.report) AS bytes`),
  );
  return changed ? Number(gate.bytes) - Number(changed.bytes) : null;
}

/** One discovery turn on the archive membership PK. The cursor measures only
 * discovery; unreadable and newly ineligible rows stay intact and are revisited
 * on the next sweep. Every successful reduction is independently idempotent. */
export async function advanceSettledStatusHeaders(
  db: DB,
  source: ProgressiveReportSourceKind,
  signal?: AbortSignal,
  yieldAt = Infinity,
) {
  const [position] =
    await db.execute(sql`SELECT sim_job_id::text AS job,sequence FROM public.progressive_status_header_cursors
    WHERE source_kind=${source}`);
  if (!position) throw new Error("Missing status-header discovery cursor");
  const start: Cursor | null = position.job
    ? { job: String(position.job), sequence: Number(position.sequence) }
    : null;
  const rows = await db.execute(sql`WITH page AS MATERIALIZED (
    SELECT m.sim_job_id,m.sequence,m.bundle_id,m.content_signature,m.report_byte_size
    FROM public.progressive_report_archive_members m WHERE m.source_kind=${source} AND m.member_kind='report'
      ${start ? sql`AND (m.sim_job_id,m.sequence)>(${start.job}::uuid,${start.sequence}::bigint)` : sql``}
    ORDER BY m.sim_job_id,m.sequence LIMIT ${scanRows}
  )
  SELECT m.sim_job_id::text AS job,m.sequence,m.content_signature AS signature,m.bundle_id::text AS bundle,
    m.report_byte_size AS original_bytes,
    (r.archived_at IS NOT NULL AND r.result_payload_hash IS NULL AND m.report_byte_size<=${readBudget}
       AND public.progressive_settled_status_header(r.report) IS NOT NULL) AS eligible
  FROM page m LEFT JOIN ${tableFor(source)} r ON r.sim_job_id=m.sim_job_id AND r.sequence=m.sequence
    AND r.content_signature=m.content_signature AND r.archive_bundle_id=m.bundle_id ORDER BY m.sim_job_id,m.sequence`);
  let examined = 0,
    candidates = 0,
    bytes = 0,
    reduced = 0,
    held = 0,
    fieldBytesRemoved = 0;
  let after = start;
  for (const item of rows) {
    if (signal?.aborted || (candidates > 0 && performance.now() >= yieldAt))
      break;
    const row: Candidate = {
      job: String(item.job),
      sequence: Number(item.sequence),
      signature: String(item.signature),
      bundle: String(item.bundle),
      originalBytes: Number(item.original_bytes),
      eligible: item.eligible === true,
    };
    if (row.eligible) {
      if (candidates === pageReads || bytes + row.originalBytes > readBudget)
        break;
      candidates++;
      bytes += row.originalBytes;
      try {
        const saved = await compactSettledStatusHeader(db, source, row);
        if (saved !== null) {
          reduced++;
          fieldBytesRemoved += saved;
        } else held++;
      } catch (error) {
        // Never substitute the stored header or treat a failed restore/guard
        // as a successful application. Other independent keys can still run.
        held++;
        console.warn(
          JSON.stringify({
            component: "settled-report-status",
            result: "retained",
            source,
            executionId: row.job,
            sequence: row.sequence,
            category:
              error instanceof ProgressiveReportArchiveTimeout
                ? "read_timeout"
                : "read_or_guard_failed",
          }),
        );
      }
    }
    examined++;
    after = { job: row.job, sequence: row.sequence };
  }
  const complete = examined === rows.length && rows.length < scanRows;
  const next = complete ? null : after;
  if (examined || (complete && start))
    await db.execute(sql`UPDATE public.progressive_status_header_cursors SET sim_job_id=${next?.job ?? null}::uuid,
       sequence=${next?.sequence ?? null}::bigint WHERE source_kind=${source}
       AND sim_job_id IS NOT DISTINCT FROM ${start?.job ?? null}::uuid
       AND sequence IS NOT DISTINCT FROM ${start?.sequence ?? null}::bigint`);
  return { examined, candidates, reduced, held, fieldBytesRemoved, complete };
}
