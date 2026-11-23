import { assertProgressiveReportArchiveIdentity, type ProgressiveReportArchiveStoredIdentity } from "@aerodb/db/progressive-report-archive";
import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ReportCopyCursor } from "./cancelled-report-copies";
import { syncDirectory } from "./legacy-report-storage-files";
import { readReceipt, writeReceipt } from "./stopped-report-receipt-files";

interface Publication {
  bundleId: string;
  object: ProgressiveReportArchiveStoredIdentity;
  signature: string;
  reportSha256: string;
  reportByteSize: number;
}

/** An optional seek hint for the chronological lane. Only the catalogue can
 * supply a resume key, from the last signed row of a committed hub page. */
export class CancelledReportScanCheckpoint {
  private readonly file: string;

  private readonly prefix: string;

  constructor(private readonly directory: string, private readonly bucket: string, prefix: string) {
    this.file = join(directory, "ordinary-chronological.json");
    this.prefix = prefix.replace(/^\/+|\/+$/g, "") + "/";
  }

  async resume(db: DB): Promise<ReportCopyCursor | null> {
    try {
      const pin = await readReceipt<Publication>(this.file);
      if (!pin) return null;
      assertProgressiveReportArchiveIdentity(pin.object);
      if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(pin.bundleId) ||
        pin.object.bucket !== this.bucket || !pin.object.objectKey.startsWith(this.prefix)) return null;
      const [row] = await db.execute<{executionId: string; sequence: string}>(sql`
        SELECT b.sim_job_id AS "executionId", m.sequence
        FROM progressive_report_archive_bundles b
        JOIN progressive_report_archive_members m ON m.bundle_id=b.id AND m.source_kind=b.source_kind
          AND m.sim_job_id=b.sim_job_id AND m.sequence=b.last_sequence AND m.member_kind='report'
        JOIN progressive_remote_reports r ON r.sim_job_id=m.sim_job_id AND r.sequence=m.sequence
          AND r.archive_bundle_id=b.id AND r.archived_at IS NOT NULL AND r.content_signature=m.content_signature
        WHERE b.id=${pin.bundleId}::uuid AND b.source_kind='remote' AND b.archive_format='jsonl'
          AND b.verified_at IS NOT NULL AND b.bucket=${this.bucket} AND b.object_key=${pin.object.objectKey}
          AND b.generation=${pin.object.generation} AND b.stored_sha256=${pin.object.storedSha256}
          AND b.stored_byte_size=${pin.object.storedByteSize} AND b.crc32c=${pin.object.crc32c}
          AND m.content_signature=${pin.signature} AND m.report_sha256=${pin.reportSha256}
          AND m.report_byte_size=${pin.reportByteSize}`);
      const sequence = Number(row?.sequence);
      return row && Number.isSafeInteger(sequence) && sequence > 0 ? { executionId: row.executionId, sequence } : null;
    } catch (error) {
      console.warn("[sweeper] reading chronological report checkpoint", error instanceof Error ? error.message : String(error));
      return null;
    }
  }

  async save(pin: Publication | null) {
    try {
      if (pin) await writeReceipt(this.file, pin);
      else {
        await unlink(this.file);
        await syncDirectory(this.directory);
      }
    } catch (error) {
      if (!pin && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      // PostgreSQL has already committed. A restart can repeat discovery.
      console.warn("[sweeper] writing chronological report checkpoint", error instanceof Error ? error.message : String(error));
    }
  }
}
