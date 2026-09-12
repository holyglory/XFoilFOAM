import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "../src/client";
import { recordInactiveStoppedPromise } from "../../../apps/sweeper/src/progressive-inactive-promise";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());
const source = {
  executionId: "10000000-0000-4000-8000-000000000001",
  promiseId: "10000000-0000-4000-8000-000000000002",
  solverId: "10000000-0000-4000-8000-000000000003",
  upstreamBaseUrl: "https://fixture.invalid/api/sync/v1",
  token: "isolated-token",
};
const rejection = { status: 409, error: "promise is not active" };

it("records only authenticated terminal promise loss while preserving all execution evidence", async () => {
  await client.db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await transaction.execute(
      sql`CREATE TEMP TABLE sweeper_state(id integer) ON COMMIT DROP; INSERT INTO sweeper_state VALUES(1)`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS SELECT 1 AS id,
      ${source.solverId}::uuid AS remote_solver_registered_id,${source.upstreamBaseUrl}::text AS upstream_base_url,
      ${source.token}::text AS remote_solver_auth_token`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS SELECT ${source.promiseId}::uuid AS id,
      ${source.solverId}::uuid AS registered_solver_id,${source.upstreamBaseUrl}::text AS source_base_url,
      'active'::text AS status,NULL::timestamptz AS "cancelledAt",NULL::timestamptz AS "updatedAt",'{"original":true}'::jsonb AS response_payload`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promise_points ON COMMIT DROP AS
      SELECT ${source.promiseId}::uuid AS promise_id,status,NULL::timestamptz AS "updatedAt" FROM unnest(ARRAY['active','fulfilled']) status`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS SELECT ${source.executionId}::uuid AS id,
      ${source.executionId}::text AS engine_job_id,'done'::text AS status,'completed'::text AS engine_state,
      jsonb_build_object('syncPromiseId',${source.promiseId}::text,'upstreamBaseUrl',${source.upstreamBaseUrl}::text,'remoteSolver',true,'remoteProgressiveExecution',jsonb_build_object('fixture',true)) AS request_payload`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_submission_intents ON COMMIT DROP AS
      SELECT ${source.executionId}::uuid AS sim_job_id,'signature'::text AS assignment_signature`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT ${source.executionId}::uuid AS sim_job_id,'signature'::text AS assignment_signature,
        ${source.executionId}::text AS stopped_engine_job_id,clock_timestamp() AS acknowledged_at`);
    await transaction.execute(
      sql`CREATE TEMP TABLE progressive_cfd_attempts(sim_job_id uuid) ON COMMIT DROP`,
    );
    await transaction.execute(
      sql`CREATE TEMP TABLE progressive_cfd_execution_stops(sim_job_id uuid,engine_job_id text) ON COMMIT DROP`,
    );
    const jobs = await transaction.execute(sql`SELECT * FROM sim_jobs`);
    const reports = await transaction.execute(
      sql`SELECT * FROM progressive_worker_reports`,
    );
    const before = await transaction.execute(
      sql`SELECT * FROM sync_sweep_promises`,
    );
    for (const response of [
      { status: 409, error: "different conflict" },
      { status: 503, error: rejection.error },
      { status: 200, error: rejection.error },
    ])
      expect(
        await recordInactiveStoppedPromise(connection, source, response),
      ).toBe(false);
    for (const changed of [
      { ...source, token: "foreign" },
      { ...source, upstreamBaseUrl: "https://foreign.invalid" },
      { ...source, solverId: "10000000-0000-4000-8000-000000000004" },
    ])
      expect(
        await recordInactiveStoppedPromise(connection, changed, rejection),
      ).toBe(false);
    const rollback = new Error("Rollback isolated refusal fixture");
    for (const statement of [
      sql`UPDATE progressive_worker_reports SET acknowledged_at=NULL`,
      sql`UPDATE progressive_worker_reports SET assignment_signature='different'`,
      sql`UPDATE progressive_worker_reports SET stopped_engine_job_id='different'`,
      sql`UPDATE sim_jobs SET engine_job_id='different'`,
      sql`DELETE FROM progressive_worker_reports`,
      sql`DELETE FROM progressive_worker_submission_intents`,
      sql`UPDATE sim_jobs SET status='running',engine_state='running'; DELETE FROM progressive_worker_reports`,
      sql`UPDATE sync_sweep_promises SET status='fulfilled'`,
    ])
      await expect(
        transaction.transaction(async (nested) => {
          await nested.execute(statement);
          expect(
            await recordInactiveStoppedPromise(
              nested as unknown as DB,
              source,
              rejection,
            ),
          ).toBe(false);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    expect(
      await transaction.execute(sql`SELECT * FROM sync_sweep_promises`),
    ).toEqual(before);
    expect(
      await recordInactiveStoppedPromise(connection, source, rejection),
    ).toBe(true);
    expect(
      await recordInactiveStoppedPromise(connection, source, rejection),
    ).toBe(false);
    const [promise] = await transaction.execute(
      sql`SELECT status,response_payload,"cancelledAt" FROM sync_sweep_promises`,
    );
    expect(promise.status).toBe("cancelled");
    expect(promise.response_payload).toMatchObject({
      original: true,
      authoritativeLeaseLoss: true,
    });
    expect(promise.cancelledAt).not.toBeNull();
    const points = await transaction.execute(
      sql`SELECT status FROM sync_sweep_promise_points ORDER BY status`,
    );
    expect(points.map((row) => row.status)).toEqual(["cancelled", "fulfilled"]);
    expect(await transaction.execute(sql`SELECT * FROM sim_jobs`)).toEqual(
      jobs,
    );
    expect(
      await transaction.execute(sql`SELECT * FROM progressive_worker_reports`),
    ).toEqual(reports);
  });
});
