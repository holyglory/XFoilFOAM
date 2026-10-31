import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "../src/client";
import { retireSettledProgressivePromise } from "../../../apps/sweeper/src/progressive-remote-lease-retirement";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("retires active points when a cancelled promise already has a terminal stopped job", async () => {
  await client.db.transaction(async (transaction) => {
    const db = transaction as unknown as DB;
    await transaction.execute(sql`
      CREATE TEMP TABLE sync_sweep_promises(
        id uuid PRIMARY KEY, registered_solver_id uuid, status text,
        "cancelledAt" timestamptz, "updatedAt" timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE progressive_remote_dispatches(
        sim_job_id uuid, promise_id uuid, solver_id uuid
      ) ON COMMIT DROP;
      CREATE TEMP TABLE sim_jobs(
        id uuid, engine_job_id text, status text, "ingestedAt" timestamptz
      ) ON COMMIT DROP;
      CREATE TEMP TABLE progressive_cfd_execution_stops(
        sim_job_id uuid, engine_job_id text
      ) ON COMMIT DROP;
      CREATE TEMP TABLE sync_sweep_promise_points(
        promise_id uuid, status text, "updatedAt" timestamptz
      ) ON COMMIT DROP;
    `);
    await transaction.execute(sql`
      INSERT INTO sync_sweep_promises VALUES
        ('10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002', 'cancelled', NULL, NULL);
      INSERT INTO progressive_remote_dispatches VALUES
        ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000002');
      INSERT INTO sim_jobs VALUES
        ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003', 'cancelled', NULL);
      INSERT INTO progressive_cfd_execution_stops VALUES
        ('10000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003');
      INSERT INTO sync_sweep_promise_points VALUES
        ('10000000-0000-4000-8000-000000000001', 'active', NULL),
        ('10000000-0000-4000-8000-000000000001', 'fulfilled', NULL);
    `);

    expect(await retireSettledProgressivePromise(db, "10000000-0000-4000-8000-000000000003")).toBe(1);
    expect(await retireSettledProgressivePromise(db, "10000000-0000-4000-8000-000000000003")).toBe(1);
    expect(await transaction.execute(sql`SELECT status FROM sync_sweep_promise_points ORDER BY status`)).toEqual([
      { status: "cancelled" },
      { status: "fulfilled" },
    ]);
  });
});
