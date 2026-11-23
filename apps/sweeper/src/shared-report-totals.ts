import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import type { DB } from "@aerodb/db/client";
import type { StoppedCopyReceipt } from "./shared-stopped-report-custody";

/** Rebuild totals from independently verified cloud manifests and actual SQL
 * pointers. Re-running after a restart never adds an anticipated or replayed release. */
export async function sharedReportTotals(db: DB, root: string, job: string) {
  const rows =
    await db.execute(sql`SELECT b.stored_sha256 sha,b.generation,count(*)::int n,sum(pg_column_size(r.report))::text stored
   FROM progressive_report_archive_bundles b JOIN progressive_report_archive_members m ON m.bundle_id=b.id AND m.sim_job_id=b.sim_job_id AND m.source_kind=b.source_kind
   JOIN progressive_remote_reports r ON r.archive_bundle_id=b.id AND r.sim_job_id=m.sim_job_id AND r.sequence=m.sequence AND r.content_signature=m.content_signature
   WHERE b.source_kind='remote' AND b.sim_job_id=${job}::uuid AND b.archive_format='shared-result-v1' GROUP BY b.stored_sha256,b.generation`);
  const live = new Map(
    rows.map((r) => [String(r.sha) + "@" + r.generation, r]),
  );
  let referencesReleased = 0,
    protectedBytesReleased = 0,
    completeAccounting = 0;
  const generations = new Map<string, number>(),
    results = new Set<string>(),
    reports = new Set<string>();
  let cloudPages = 0,
    attached = 0,
    released = 0;
  const dir = join(root, "verified");
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    files = [];
  }
  for (const name of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const v = JSON.parse(
      await readFile(join(dir, name), "utf8"),
    ) as StoppedCopyReceipt;
    if (v.owner.executionId !== job || name !== v.object.sha256 + ".json")
      throw new Error("Shared report receipt belongs to another owner");
    cloudPages++;
    generations.set(
      v.bucket + "/" + v.object.key + "@" + v.object.generation,
      v.object.size,
    );
    for (const x of Object.values(v.results)) {
      const k = v.bucket + "/" + x.pin.key + "@" + x.pin.generation;
      results.add(k);
      generations.set(k, x.pin.size);
    }
    for (const m of v.members) reports.add(m.signature);
    const actual = live.get(v.object.sha256 + "@" + v.object.generation);
    if (actual) {
      if (Number(actual.n) !== v.members.length)
        throw new Error(
          "Partial SQL custody for a verified shared report page",
        );
      let commit: StoppedCopyReceipt | null = null;
      try {
        commit = JSON.parse(
          await readFile(join(root, "sql-releases", name), "utf8"),
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (commit) {
        if (
          commit.object.sha256 !== v.object.sha256 ||
          commit.object.generation !== v.object.generation ||
          commit.released !== Number(actual.n) ||
          commit.members.length !== v.members.length ||
          commit.storedReportFieldsAfter !== Number(actual.stored)
        )
          throw new Error(
            "SQL release accounting does not match its committed generation",
          );
        completeAccounting += commit.released;
        referencesReleased += commit.releasedReferenceBytes;
        protectedBytesReleased += commit.releasedProtectedResults.reduce(
          (n, r) => n + r.storedBytes,
          0,
        );
      }
      attached += Number(actual.n);
      released += v.storedReportFieldsBefore - Number(actual.stored);
    }
  }
  return {
    job,
    verifiedMembers: reports.size,
    verifiedManifestCount: cloudPages,
    uniqueResultGenerations: results.size,
    uniqueGenerationBytes: [...generations.values()].reduce((n, s) => n + s, 0),
    registeredSqlMembers: rows.reduce((n, r) => n + Number(r.n), 0),
    membersWithOriginalFieldMeasurement: attached,
    sqlReportFieldBytesReleased: released,
    membersWithCompleteAccounting: completeAccounting,
    referenceBytesReleased: referencesReleased,
    protectedResultBytesReleased: protectedBytesReleased,
    netSqlValueBytesReleased:
      completeAccounting === attached
        ? released + referencesReleased + protectedBytesReleased
        : null,
    currentRssBytes: process.memoryUsage.rss(),
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
  };
}
