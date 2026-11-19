import type { DB } from "@aerodb/db";
import { sql } from "drizzle-orm";
import { setTimeout as delay } from "node:timers/promises";

export async function runDuplicateReportCleanup(
  db: DB,
  signal: AbortSignal,
): Promise<void> {
  let cursor: { job: string; sequence: number } | undefined;
  while (!signal.aborted) {
    let pause = 60_000;
    try {
      const [page] = await db.execute(sql`
        WITH selected AS MATERIALIZED (
          SELECT c.sim_job_id,c.sequence FROM progressive_worker_report_conflicts c
          WHERE c.body_source_sequence IS NULL AND c.archived_at IS NULL
            ${cursor ? sql`AND (c.sim_job_id,c.sequence)>(${cursor.job}::uuid,${cursor.sequence})` : sql``}
          ORDER BY c.sim_job_id,c.sequence LIMIT 12 FOR UPDATE SKIP LOCKED
        ), changed AS (
          UPDATE progressive_worker_report_conflicts c SET body_source_sequence=c.sequence
          FROM selected WHERE c.sim_job_id=selected.sim_job_id AND c.sequence=selected.sequence
            AND c.body_source_sequence IS NULL AND c.archived_at IS NULL RETURNING c.sequence
        )
        SELECT selected.sim_job_id,selected.sequence,(SELECT count(*) FROM changed) AS linked
        FROM selected ORDER BY selected.sim_job_id DESC,selected.sequence DESC LIMIT 1
      `);
      if (page) {
        cursor = {
          job: String(page.sim_job_id),
          sequence: Number(page.sequence),
        };
        pause = 100;
        if (Number(page.linked))
          console.info(
            JSON.stringify({
              component: "progressive-duplicate-reports",
              linked: Number(page.linked),
            }),
          );
      } else cursor = undefined;
    } catch (error) {
      console.error(
        "[sweeper] duplicate report cleanup failed:",
        error instanceof Error ? error.message : String(error),
      );
    }
    try {
      await delay(pause, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
}
