import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import {
  progressiveRemoteActivePromiseCount,
  progressiveRemoteActivePromiseIdsSql,
  progressiveRemoteAdmissionReservedSlots,
  progressiveRemoteReservedSlots,
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

it("releases admission CPU after the producer stops while retaining remote custody", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      "expiresAt" timestamptz NOT NULL
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches (
      sim_job_id uuid PRIMARY KEY,
      promise_id uuid NOT NULL,
      solver_id uuid NOT NULL,
      cpu_slots integer NOT NULL
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_stops (
      sim_job_id uuid NOT NULL,
      engine_job_id text NOT NULL
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs (
      id uuid PRIMARY KEY,
      status text NOT NULL,
      engine_job_id text,
      engine_state text
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_attempts (
      sim_job_id uuid NOT NULL,
      outcome text NOT NULL,
      unit_id uuid NOT NULL
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_units (
      id uuid PRIMARY KEY,
      state text NOT NULL,
      lease_until timestamptz NOT NULL
    ) ON COMMIT DROP`);

    const solverId = "10000000-0000-4000-8000-000000000011";
    const promiseId = "10000000-0000-4000-8000-000000000012";
    const jobId = "10000000-0000-4000-8000-000000000013";
    const unitId = "10000000-0000-4000-8000-000000000014";
    await transaction.execute(sql`
      INSERT INTO sync_sweep_promises (id, status, "expiresAt")
      VALUES (${promiseId}::uuid, 'active', clock_timestamp() + interval '1 hour')
    `);
    await transaction.execute(sql`
      INSERT INTO progressive_remote_dispatches (sim_job_id, promise_id, solver_id, cpu_slots)
      VALUES (${jobId}::uuid, ${promiseId}::uuid, ${solverId}::uuid, 4)
    `);
    await transaction.execute(sql`
      INSERT INTO sim_jobs (id, status, engine_job_id, engine_state)
      VALUES (${jobId}::uuid, 'running', ${jobId}, 'running')
    `);
    await transaction.execute(sql`
      INSERT INTO progressive_cfd_units (id, state, lease_until)
      VALUES (${unitId}::uuid, 'leased', clock_timestamp() + interval '1 hour')
    `);
    await transaction.execute(sql`
      INSERT INTO progressive_cfd_attempts (sim_job_id, outcome, unit_id)
      VALUES (${jobId}::uuid, 'running', ${unitId}::uuid)
    `);

    const readReservations = async () => [
      await progressiveRemoteReservedSlots(transaction as unknown as DB, solverId),
      await progressiveRemoteAdmissionReservedSlots(
        transaction as unknown as DB,
        solverId,
      ),
    ];
    expect(await readReservations()).toEqual([4, 4]);

    await transaction.execute(sql`
      UPDATE sim_jobs SET status = 'ingesting', engine_state = 'completed'
      WHERE id = ${jobId}::uuid
    `);
    expect(await readReservations()).toEqual([4, 0]);

    await transaction.execute(sql`
      UPDATE sim_jobs SET status = 'cancelled', engine_state = 'cancel_pending'
      WHERE id = ${jobId}::uuid
    `);
    expect(await readReservations()).toEqual([4, 4]);

    await transaction.execute(sql`
      UPDATE sim_jobs SET status = 'cancelled', engine_state = 'running'
      WHERE id = ${jobId}::uuid
    `);
    expect(await readReservations()).toEqual([4, 4]);

    await transaction.execute(sql`
      UPDATE sim_jobs SET status = 'cancelled', engine_state = 'cancelled'
      WHERE id = ${jobId}::uuid
    `);
    expect(await readReservations()).toEqual([4, 0]);

    await transaction.execute(sql`
      UPDATE sim_jobs SET status = 'pending', engine_job_id = NULL, engine_state = NULL
      WHERE id = ${jobId}::uuid
    `);
    await transaction.execute(sql`
      UPDATE progressive_cfd_units SET lease_until = clock_timestamp() - interval '1 second'
      WHERE id = ${unitId}::uuid
    `);
    expect(await readReservations()).toEqual([0, 0]);
  });
});
