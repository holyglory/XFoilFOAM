import type { DB } from "../src/client";
import { sql } from "drizzle-orm";

// A temporary report table shadows the source in these selector fixtures.
// Bind the candidate view to the same test rows as the claim and receipt reads.
export const fixtureStagingCandidateView = sql`
  CREATE TEMP VIEW progressive_worker_staging_candidates AS
  SELECT * FROM pg_temp.progressive_worker_reports
  WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object'
`;

// Re-run the production selector on the same fixture and snapshot after
// replacing only its membership source and index layout.
export async function useFixtureStagingKeys(db: Pick<DB, "execute">) {
  await db.execute(sql`CREATE TEMP TABLE fixture_staging_keys ON COMMIT DROP AS
    SELECT sim_job_id,sequence,created_at,stopped_engine_job_id FROM pg_temp.progressive_worker_staging_candidates`);
  await db.execute(
    sql`ALTER TABLE fixture_staging_keys ADD PRIMARY KEY(sim_job_id,sequence)`,
  );
  await db.execute(
    sql`CREATE INDEX fixture_keys_order_idx ON fixture_staging_keys(created_at,sim_job_id,sequence)`,
  );
  await db.execute(
    sql`CREATE INDEX fixture_keys_job_idx ON fixture_staging_keys(sim_job_id,created_at,sequence)`,
  );
  await db.execute(sql`CREATE INDEX fixture_keys_terminal_idx ON fixture_staging_keys(created_at,sim_job_id,sequence)
    WHERE stopped_engine_job_id IS NOT NULL`);
  await db.execute(sql`ANALYZE fixture_staging_keys`);
  await db.execute(
    sql`DROP VIEW pg_temp.progressive_worker_staging_candidates`,
  );
  await db.execute(
    sql`CREATE TEMP VIEW progressive_worker_staging_candidates AS SELECT * FROM pg_temp.fixture_staging_keys`,
  );
}
