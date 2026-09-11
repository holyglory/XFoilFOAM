import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import {
  progressiveRemoteActivePromiseCount,
  progressiveRemoteActivePromiseIdsSql,
} from "../src/progressive-remote-dispatch";
import type { DB } from "../src/client";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());
const owner = "10000000-0000-4000-8000-000000000001";
const foreign = "10000000-0000-4000-8000-000000000002";

it("preserves exact active lease membership across ownership, expiry and physical-stop combinations", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT md5(concat_ws(':',state,expiry,owner_kind,dispatch_kind,proof))::uuid AS id,
        state AS status,expiry,owner_kind,dispatch_kind,proof,
        CASE owner_kind WHEN 'owned' THEN ${owner}::uuid WHEN 'foreign' THEN ${foreign}::uuid ELSE NULL END AS registered_solver_id,
        CASE expiry WHEN 'future' THEN clock_timestamp()+interval '1 day' WHEN 'past' THEN clock_timestamp()-interval '1 day' ELSE NULL END AS "expiresAt"
      FROM unnest(ARRAY['active','expired','cancelled','fulfilled']) state
      CROSS JOIN unnest(ARRAY['future','past','missing']) expiry
      CROSS JOIN unnest(ARRAY['owned','foreign','missing']) owner_kind
      CROSS JOIN unnest(ARRAY['none','owned','foreign']) dispatch_kind
      CROSS JOIN unnest(ARRAY['none','exact','wrong_engine','wrong_job']) proof`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches ON COMMIT DROP AS
      SELECT id AS promise_id,md5(id::text||':execution')::uuid AS sim_job_id,
        CASE dispatch_kind WHEN 'owned' THEN ${owner}::uuid ELSE ${foreign}::uuid END AS solver_id
      FROM sync_sweep_promises WHERE dispatch_kind<>'none'`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX ON progressive_remote_dispatches(promise_id)`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_stops ON COMMIT DROP AS
      SELECT CASE promise.proof WHEN 'wrong_job' THEN md5(dispatch.sim_job_id::text||':unrelated')::uuid ELSE dispatch.sim_job_id END AS sim_job_id,
        CASE promise.proof WHEN 'wrong_engine' THEN 'unrelated-engine' ELSE dispatch.sim_job_id::text END AS engine_job_id
      FROM progressive_remote_dispatches dispatch JOIN sync_sweep_promises promise ON promise.id=dispatch.promise_id
      WHERE promise.proof<>'none'`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX ON progressive_cfd_execution_stops(sim_job_id)`,
    );
    const rows = await transaction.execute(sql`SELECT promise.*,
      promise.id IN (${progressiveRemoteActivePromiseIdsSql(owner)}) AS candidate,
      (promise.registered_solver_id=${owner}::uuid AND promise.status='active' AND promise."expiresAt">clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM progressive_remote_dispatches dispatch JOIN progressive_cfd_execution_stops stopped
          ON stopped.sim_job_id=dispatch.sim_job_id AND stopped.engine_job_id=dispatch.sim_job_id::text
          WHERE dispatch.promise_id=promise.id AND dispatch.solver_id=promise.registered_solver_id)) AS original
      FROM sync_sweep_promises promise`);
    expect(rows).toHaveLength(432);
    let expectedCount = 0;
    for (const row of rows) {
      const expected =
        row.status === "active" &&
        row.expiry === "future" &&
        row.owner_kind === "owned" &&
        !(row.dispatch_kind === "owned" && row.proof === "exact");
      expect(row.original === true, JSON.stringify(row)).toBe(expected);
      expect(row.candidate === true, JSON.stringify(row)).toBe(expected);
      if (expected) expectedCount += 1;
    }
    expect(expectedCount).toBe(11);
    expect(
      await progressiveRemoteActivePromiseCount(
        transaction as unknown as DB,
        owner,
      ),
    ).toBe(expectedCount);
    const [unique] =
      await transaction.execute(sql`SELECT count(*)::int AS total,count(DISTINCT id)::int AS distinct_count
      FROM (${progressiveRemoteActivePromiseIdsSql(owner)}) selected`);
    expect(unique.total).toBe(unique.distinct_count);
    expect(
      await progressiveRemoteActivePromiseCount(
        transaction as unknown as DB,
        "10000000-0000-4000-8000-000000000003",
      ),
    ).toBe(0);
  });
});
