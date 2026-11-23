import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { DB } from "../src/client";

export const deliveryIndexMigration = readFileSync(
  new URL(
    "../migrations/0230_pending_worker_delivery_sources.sql",
    import.meta.url,
  ),
  "utf8",
);

export async function installDeliveryIndexFixture(
  connection: Pick<DB, "execute">,
  usesPublicJobs = false,
) {
  // The outbox replay fixture owns real sim_jobs and shadows only its outbox.
  // PostgreSQL requires both ends of a temporary foreign key to be temporary.
  if (usesPublicJobs) {
    await connection.execute(
      sql`CREATE TEMP TABLE delivery_fixture_job_keys(id uuid PRIMARY KEY) ON COMMIT DROP`,
    );
    await connection.execute(sql`INSERT INTO delivery_fixture_job_keys
      SELECT DISTINCT j.id FROM sim_jobs j JOIN progressive_worker_evidence_attempts s ON s.sim_job_id=j.id`);
  }
  const settings = () => connection.execute(sql`SELECT current_setting('work_mem') AS memory,
    current_setting('max_parallel_workers_per_gather') AS parallel`);
  const before = await settings();
  for (const statement of deliveryIndexMigration.split(
    "--> statement-breakpoint",
  )) {
    let local = statement
      .replaceAll("public.", "pg_temp.")
      .replaceAll(
        "search_path=pg_catalog,public",
        "search_path=pg_catalog,pg_temp",
      )
      .replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION");
    if (usesPublicJobs)
      local = local
        .replace(
          "REFERENCES pg_temp.sim_jobs(id)",
          "REFERENCES pg_temp.delivery_fixture_job_keys(id)",
        )
        .replaceAll("FROM pg_temp.sim_jobs j", "FROM public.sim_jobs j");
    if (local.includes("CREATE TABLE pg_temp."))
      local = local.replace(/\);\s*$/, ") ON COMMIT DROP;");
    await connection.execute(sql.raw(local));
  }
  const [after] = await settings();
  if (before[0].memory !== after.memory || before[0].parallel !== after.parallel)
    throw Error("Delivery-index bootstrap changed its caller's memory or parallel settings");
}
