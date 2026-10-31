import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const program = `
  import { db, closeDatabasePools } from "./apps/api/src/db.ts";
  import { sql } from "drizzle-orm";
  (async () => {
  const [row] = await db.execute(sql\`SELECT
    count(*)::int AS reports,
    count(*) FILTER (WHERE receipt.sim_job_id IS NULL OR inventory.sim_job_id IS NULL)::int AS unapplied,
    count(DISTINCT report.sim_job_id) FILTER (WHERE receipt.sim_job_id IS NULL OR inventory.sim_job_id IS NULL)::int AS affected_jobs,
    min(report.received_at) FILTER (WHERE receipt.sim_job_id IS NULL OR inventory.sim_job_id IS NULL) AS oldest_unapplied,
    max(report.received_at) FILTER (WHERE receipt.sim_job_id IS NULL OR inventory.sim_job_id IS NULL) AS newest_unapplied
  FROM progressive_remote_reports report
  LEFT JOIN progressive_remote_progress_receipts receipt
    ON receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence
  LEFT JOIN progressive_remote_report_inventories inventory
    ON inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence\`);
  console.log(JSON.stringify(row));
  await closeDatabasePools();
  })().catch((error) => { console.error(error); process.exitCode = 1; });
`;
const encoded = Buffer.from(program).toString("base64");
const output = execFileSync("ssh", ["airfoils.pro", "bash", "-s"], {
  input: `set -e\nprintf '%s' '${encoded}' | base64 -d | docker exec -i -w /app app-node-api-1 pnpm exec tsx -e \"$(cat)\"\n`,
  encoding: "utf8",
  timeout: 60000,
}).trim();
const row = JSON.parse(output);
assert(Number(row.reports) >= 0);
assert(Number(row.unapplied) >= 0);
console.log(JSON.stringify({
  reports: Number(row.reports),
  unapplied: Number(row.unapplied),
  affectedJobs: Number(row.affected_jobs),
  oldestUnapplied: row.oldest_unapplied ?? null,
  newestUnapplied: row.newest_unapplied ?? null,
  backpressureLimit: 2000,
  backpressureActive: Number(row.unapplied) >= 2000,
}));
