import { sql } from "drizzle-orm";
import type { DB } from "./client";

export const progressiveReportTables = [
  "progressive_worker_reports",
  "progressive_remote_reports",
] as const;
export type ProgressiveReportTable = (typeof progressiveReportTables)[number];
export interface ProgressiveReportCursor {
  executionId: string;
  sequence: number;
}

function tableName(table: ProgressiveReportTable) {
  if (!progressiveReportTables.includes(table))
    throw new Error("Invalid report table");
  return sql.identifier(table);
}

/** Canonical store only; a fixture cannot redirect payload writes with search_path. */
export async function setProgressiveReportNormalization(
  db: DB,
  input: { enabled: boolean; readersReady: boolean },
) {
  if (input.enabled && !input.readersReady)
    throw new Error(
      "Upgrade and verify all report readers before enabling normalization",
    );
  await db.execute(sql`UPDATE public.progressive_report_storage_policy
    SET normalization_enabled = ${input.enabled} WHERE id = 1`);
}

/**
 * One restart-safe transaction, bounded by scanned rows AND logical input bytes.
 * A locked row pins the continuation cursor so SKIP LOCKED never loses a hole.
 * Metadata, acknowledgements, sequence, signatures and inventories are untouched.
 */
export async function backfillProgressiveReportPayloads(
  db: DB,
  input: {
    table: ProgressiveReportTable;
    apply?: boolean;
    restoreInline?: boolean;
    after?: ProgressiveReportCursor | null;
    rows?: number;
    maxBytes?: number;
  },
) {
  const table = tableName(input.table);
  const rows = input.rows ?? 16;
  const maxBytes = input.maxBytes ?? 64 * 1024 * 1024;
  if (
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    rows > 128 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 512 * 1024 * 1024
  )
    throw new Error(
      "Backfill requires 1..128 rows and 1..536870912 logical bytes",
    );
  if (
    input.after &&
    (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
      input.after.executionId,
    ) ||
      !Number.isSafeInteger(input.after.sequence) ||
      input.after.sequence < 1)
  )
    throw new Error("Invalid report backfill cursor");
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await connection.execute(sql`SET LOCAL lock_timeout = '2s'`);
    await connection.execute(sql`SET LOCAL statement_timeout = '30s'`);
    const [policy] = await connection.execute(sql`SELECT normalization_enabled
      FROM public.progressive_report_storage_policy WHERE id = 1 FOR SHARE`);
    if (
      input.apply &&
      (input.restoreInline
        ? policy?.normalization_enabled !== false
        : policy?.normalization_enabled !== true)
    )
      throw new Error(
        input.restoreInline
          ? "Disable report normalization before restoring inline reports"
          : "Report normalization is disabled; verify upgraded readers before activation and backfill",
      );
    const logicalReport = input.restoreInline
      ? sql`public.resolve_progressive_report(report, result_payload_hash)`
      : sql`report`;
    // Select only primary keys first. Never scan/decompress historical bodies to
    // find a batch, and never infer completion from an empty SKIP LOCKED result.
    const candidates =
      await connection.execute(sql`SELECT sim_job_id, sequence FROM ${table}
      WHERE archived_at IS NULL
      ${input.after ? sql`AND (sim_job_id, sequence) > (${input.after.executionId}::uuid, ${input.after.sequence})` : sql``}
      ORDER BY sim_job_id, sequence LIMIT ${rows}`);
    let cursor: ProgressiveReportCursor | null = input.after ?? null;
    let pinned = false;
    let scanned = 0;
    let locked = 0;
    let normalized = 0;
    let restored = 0;
    let bytes = 0;
    const proofs: {
      executionId: string;
      sequence: number;
      contentSignature: string;
      digest: string;
    }[] = [];
    for (const candidate of candidates) {
      const [row] =
        await connection.execute(sql`SELECT jsonb_typeof(report->'result') AS result_type, result_payload_hash, content_signature,
        octet_length((${logicalReport})::text)::bigint AS logical_bytes,
        encode(sha256(convert_to((${logicalReport})::text, 'UTF8')), 'hex') AS digest
        FROM ${table} WHERE sim_job_id = ${candidate.sim_job_id}::uuid AND sequence = ${candidate.sequence}
        AND archived_at IS NULL FOR UPDATE SKIP LOCKED`);
      if (!row) {
        locked++;
        pinned = true;
        continue;
      }
      const size = Number(row.logical_bytes);
      if (bytes + size > maxBytes) {
        if (scanned === 0)
          throw new Error(
            `Report exceeds the ${maxBytes}-byte batch budget; raise --max-bytes explicitly`,
          );
        break;
      }
      scanned++;
      bytes += size;
      const next = {
        executionId: String(candidate.sim_job_id),
        sequence: Number(candidate.sequence),
      };
      if (
        input.restoreInline
          ? row.result_payload_hash !== null
          : row.result_payload_hash === null && row.result_type === "object"
      ) {
        if (input.apply) {
          // Keep JSONB in PostgreSQL: even integers beyond JavaScript's exact
          // range and unusual decimal representations retain their original value.
          const [proof] =
            await connection.execute(sql`WITH original AS MATERIALIZED (
              SELECT public.resolve_progressive_report(report,result_payload_hash) AS report FROM ${table} WHERE sim_job_id = ${next.executionId}::uuid AND sequence = ${next.sequence}
            ), updated AS (
              UPDATE ${table} SET
                result_payload_hash = ${input.restoreInline ? sql`NULL` : sql`public.store_progressive_report_result(report->'result')`},
                report = ${
                  input.restoreInline
                    ? sql`(SELECT report FROM original)`
                    : sql`jsonb_set(report, '{result}', public.progressive_report_result_header(report->'result'), false)`
                }
              WHERE sim_job_id = ${next.executionId}::uuid AND sequence = ${next.sequence}
                AND EXISTS (SELECT 1 FROM original)
              RETURNING report, result_payload_hash, content_signature
            ) SELECT updated.content_signature,
              public.resolve_progressive_report(updated.report, updated.result_payload_hash) = original.report AS identical,
              encode(sha256(convert_to(public.resolve_progressive_report(updated.report, updated.result_payload_hash)::text, 'UTF8')), 'hex') AS digest
            FROM updated CROSS JOIN original`);
          if (
            !proof ||
            proof.identical !== true ||
            proof.digest !== row.digest ||
            proof.content_signature !== row.content_signature
          )
            throw new Error(
              "Lossless report readback proof failed; batch rolled back",
            );
        }
        if (input.restoreInline) restored++;
        else normalized++;
        proofs.push({
          ...next,
          contentSignature: String(row.content_signature),
          digest: String(row.digest),
        });
      }
      if (!pinned) cursor = next;
    }
    return {
      table: input.table,
      applied: input.apply === true,
      scanned,
      locked,
      normalized,
      restored,
      restoreInline: input.restoreInline === true,
      logicalBytesRead: bytes,
      after: cursor,
      complete:
        candidates.length < rows &&
        scanned + locked === candidates.length &&
        locked === 0,
      proofs,
    };
  });
}

/** Bounded sample plus real physical relation sizes. Logical bytes are a sample,
 * not a claim of OS space reclaimed; compaction belongs to a separate operation. */
export async function progressiveReportStorageSample(
  db: DB,
  table: ProgressiveReportTable,
  input: { rows?: number; after?: ProgressiveReportCursor | null } = {},
) {
  const source = tableName(table);
  const rows = input.rows ?? 16;
  if (!Number.isSafeInteger(rows) || rows < 1 || rows > 128)
    throw new Error("Invalid sample row limit");
  const [sample] = await db.execute<{
    sampled_reports: number;
    normalized_reports: number;
    envelope_bytes: string;
    logical_report_bytes: string;
    logical_result_bytes: string;
    report_relation_bytes: string;
    shared_payload_relation_bytes: string;
  }>(sql`WITH selected AS MATERIALIZED (
    SELECT * FROM ${source}
    WHERE archived_at IS NULL
    ${input.after ? sql`AND (sim_job_id,sequence)>(${input.after.executionId}::uuid,${input.after.sequence})` : sql``}
    ORDER BY sim_job_id,sequence LIMIT ${rows}
  ) SELECT count(*)::integer AS sampled_reports,
    count(result_payload_hash)::integer AS normalized_reports,
    coalesce(sum(octet_length(report::text)),0)::text AS envelope_bytes,
    coalesce(sum(octet_length(public.resolve_progressive_report(report,result_payload_hash)::text)),0)::text AS logical_report_bytes,
    coalesce(sum(octet_length((public.resolve_progressive_report(report,result_payload_hash)->'result')::text)),0)::text AS logical_result_bytes,
    pg_total_relation_size(${table}::regclass)::text AS report_relation_bytes,
    pg_total_relation_size('public.progressive_report_result_payloads'::regclass)::text AS shared_payload_relation_bytes
    FROM selected`);
  return { table, ...sample };
}

/** Explicit operator-requested audit only. This reads every inline legacy body;
 * never call it from a poller or automatically as part of a backfill batch. */
export async function progressiveReportStorageTotals(
  db: DB,
  table: ProgressiveReportTable,
) {
  const source = tableName(table);
  const [totals] = await db.execute(sql`SELECT count(*)::text AS reports,
    count(report.result_payload_hash)::text AS normalized_reports,
    count(*) FILTER (WHERE report.result_payload_hash IS NULL AND jsonb_typeof(report.report->'result')='object')::text AS inline_result_reports,
    coalesce(sum(octet_length(report.report::text)),0)::text AS envelope_bytes,
    coalesce(sum(CASE WHEN report.result_payload_hash IS NULL
      THEN octet_length((report.report->'result')::text) ELSE payload.byte_size END),0)::text AS logical_result_bytes,
    coalesce(sum(octet_length(report.report::text) + CASE WHEN report.result_payload_hash IS NULL THEN 0
      ELSE payload.byte_size - octet_length((report.report->'result')::text) END),0)::text AS logical_report_bytes,
    pg_total_relation_size(${table}::regclass)::text AS report_relation_bytes,
    pg_total_relation_size('public.progressive_report_result_payloads'::regclass)::text AS shared_payload_relation_bytes
    FROM ${source} report LEFT JOIN public.progressive_report_result_payloads payload
      ON payload.content_hash = report.result_payload_hash WHERE report.archived_at IS NULL`);
  return { table, fullScan: true, ...totals };
}

/** A full metadata count, deliberately separate from polling and bounded samples.
 * Old readers are safe only when BOTH canonical tables are inline and writes
 * remain disabled. No payload is decompressed to produce this proof. */
export async function proveProgressiveReportsInline(db: DB) {
  return db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    const [policy] = await connection.execute(
      sql`SELECT normalization_enabled FROM public.progressive_report_storage_policy WHERE id=1 FOR SHARE`,
    );
    const counts = [];
    for (const table of progressiveReportTables) {
      const [row] =
        await connection.execute(sql`SELECT count(result_payload_hash)::text AS normalized_reports,
          count(archived_at)::text AS archived_reports FROM public.${sql.identifier(table)}
          WHERE result_payload_hash IS NOT NULL OR archived_at IS NOT NULL`);
      counts.push({ table, normalizedReports: String(row.normalized_reports), archivedReports: String(row.archived_reports) });
    }
    const [checked] = await connection.execute(
      sql`SELECT clock_timestamp()::text AS checked_at`,
    );
    return {
      checkedAt: String(checked.checked_at),
      normalizationEnabled: policy?.normalization_enabled ?? null,
      counts,
      oldReaderRollbackSafe:
        policy?.normalization_enabled === false &&
        counts.every((row) => row.normalizedReports === "0" && row.archivedReports === "0"),
    };
  });
}
