import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DB } from "../src/client";
import { reportTextIdentity } from "../src/progressive-report-archive";
import type { ProgressiveReportSourceKind } from "../src/progressive-report-reader";

/** Isolated DB custody fixture; the caller supplies the exact-text transport stub.
 * Refuses canonical report tables. Catalog rows must be rolled back; their immutable guards stay enabled. */
export async function archiveReportFixture(
  db: DB,
  sourceKind: ProgressiveReportSourceKind,
  executionId: string,
  sequence: number,
  options: { memberText?: (text: string) => string; omitMember?: boolean } = {},
) {
  const name = sourceKind === "remote" ? "progressive_remote_reports" : "progressive_worker_reports";
  const table = sql.identifier(name);
  const [scope] = await db.execute(sql`SELECT relnamespace=pg_my_temp_schema() AS temporary
    FROM pg_class WHERE oid=${name}::regclass`);
  if (scope?.temporary !== true) throw new Error("Archive fixture requires an isolated temporary report table");
  const [original] = await db.execute(sql`SELECT public.resolve_progressive_report(to_jsonb(report.*))::text AS text,
    content_signature FROM ${table} report WHERE sim_job_id=${executionId}::uuid AND sequence=${sequence}`);
  if (!original) throw new Error("Archive fixture report is missing");
  const text = String(original.text);
  const memberText = options.memberText?.(text) ?? text;
  const proof = reportTextIdentity(memberText);
  const bundleId = randomUUID();
  await db.execute(sql`INSERT INTO public.progressive_report_archive_bundles
    (id,source_kind,sim_job_id,bucket,object_key,generation,stored_sha256,stored_byte_size,crc32c,
      member_count,first_sequence,last_sequence,verified_at)
    VALUES (${bundleId}::uuid,${sourceKind},${executionId}::uuid,'report-reader-test',${`test/${bundleId}.gz`},
      '7',${"b".repeat(64)},23,'AAAAAA==',1,${sequence},${sequence},clock_timestamp())`);
  if (!options.omitMember) await db.execute(sql`INSERT INTO public.progressive_report_archive_members
    (bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
    VALUES (${bundleId}::uuid,${sourceKind},${executionId}::uuid,${sequence},'report',${original.content_signature},
      ${proof.sha256},${proof.byteSize})`);
  await db.execute(sql`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS archive_bundle_id uuid`);
  await db.execute(sql`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS archived_at timestamptz`);
  await db.execute(sql`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS result_payload_hash text`);
  await db.execute(sql`UPDATE ${table} report SET report=public.progressive_report_compact_header(
      public.resolve_progressive_report(to_jsonb(report.*))),
      archive_bundle_id=${bundleId}::uuid,archived_at=clock_timestamp(),result_payload_hash=NULL
    WHERE sim_job_id=${executionId}::uuid AND sequence=${sequence}`);
  return { text, memberText, proof, bundleId, contentSignature: String(original.content_signature) };
}
