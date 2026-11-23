import type { DB } from "@aerodb/db/client";
import { sql } from "drizzle-orm";
import {
  canonicalReportJson,
  reportTextIdentity,
  splitProgressiveReportText,
} from "@aerodb/db/progressive-report-archive";
import { retainedReportInventory } from "@aerodb/db/retained-solver-reports";
import {
  writeSharedReportPage,
  SHARED_REPORT_FORMAT,
} from "../src/shared-report-archive";
import type { ReportObjects } from "../src/shared-report-objects";

/** A migrated, rollback-scoped fixture authenticates its existing real reports
 * through the actual codec. Neither a scientific receipt nor a new point is created. */
export async function sharedAnchorReaderFixture(
  db: DB,
  objects: ReportObjects,
  job: string,
  sequences: number[],
) {
  const [d] = await db.execute(
    sql`SELECT solver_id::text solver,promise_id::text promise,content_signature assignment FROM progressive_remote_dispatches WHERE sim_job_id=${job}::uuid`,
  );
  const rows =
    await db.execute(sql`SELECT r.sequence::int s,r.content_signature sig,i.inventory_signature inventory,i.source_count n,
    public.resolve_progressive_report(r.report,r.result_payload_hash)::text raw FROM progressive_remote_reports r
    JOIN progressive_remote_report_inventories i ON (r.sim_job_id,r.sequence,r.content_signature)=(i.sim_job_id,i.sequence,i.report_content_signature)
    WHERE r.sim_job_id=${job}::uuid AND r.sequence IN (${sql.join(
      sequences.map((s) => sql`${s}::bigint`),
      sql`,`,
    )}) AND r.archived_at IS NULL ORDER BY r.sequence`);
  if (rows.length !== sequences.length)
    throw Error("Missing original shared-report fixture member");
  const members = rows.map((row) => {
    const text = String(row.raw),
      sig = String(row.sig),
      cut = splitProgressiveReportText(text),
      raw = reportTextIdentity(text),
      inventory = retainedReportInventory(cut.report, sig);
    if (
      reportTextIdentity(canonicalReportJson(cut.report)).sha256 !== sig ||
      inventory.signature !== row.inventory
    )
      throw Error("Signed fixture source changed");
    return {
      sequence: Number(row.s),
      signature: sig,
      reportSha256: raw.sha256,
      reportByteSize: raw.byteSize,
      inventorySignature: inventory.signature,
      sourceCount: inventory.sourceCount,
      sourceListSha256: reportTextIdentity(
        canonicalReportJson(inventory.sources),
      ).sha256,
      prefix: cut.prefix,
      suffix: cut.suffix,
      resultHash: cut.result ? reportTextIdentity(cut.result).sha256 : null,
      resultSize: cut.result ? Buffer.byteLength(cut.result) : undefined,
      loadResult: async () => cut.result!,
    };
  });
  const page = await writeSharedReportPage(
    objects,
    {
      executionId: job,
      solverId: String(d.solver),
      promiseId: String(d.promise),
      assignmentSignature: String(d.assignment),
    },
    members,
  );
  const p = page.pin,
    [b] =
      await db.execute(sql`INSERT INTO progressive_report_archive_bundles(source_kind,sim_job_id,bucket,object_key,generation,mime_type,compression,archive_format,stored_sha256,stored_byte_size,crc32c,member_count,first_sequence,last_sequence,verified_at)
    VALUES('remote',${job}::uuid,${objects.bucket},${p.key},${p.generation},'application/gzip','gzip',${SHARED_REPORT_FORMAT},${p.sha256},${p.size},${p.crc32c},${members.length},${members[0].sequence},${members.at(-1)!.sequence},now()) RETURNING id`);
  for (const m of members) {
    await db.execute(sql`INSERT INTO progressive_report_archive_members(bundle_id,source_kind,sim_job_id,sequence,member_kind,content_signature,report_sha256,report_byte_size)
      VALUES(${b.id}::uuid,'remote',${job}::uuid,${m.sequence},'report',${m.signature},${m.reportSha256},${m.reportByteSize})`);
    await db.execute(sql`UPDATE progressive_remote_reports SET archive_bundle_id=${b.id}::uuid,archived_at=now(),report=progressive_report_compact_header(report),result_payload_hash=NULL
      WHERE sim_job_id=${job}::uuid AND sequence=${m.sequence} AND content_signature=${m.signature}`);
  }
  return page;
}
