import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "../src/client";
import {
  progressiveStoppedStorageEligible,
  requeueStoppedProgressiveStorage,
} from "../../../apps/sweeper/src/progressive-stopped-storage";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("retries only authenticated stopped inactive-promise refusals once without changing evidence", async () => {
  await client.db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await transaction.execute(sql`CREATE TEMP TABLE fixture_jobs ON COMMIT DROP AS SELECT md5(variant)::uuid AS id,variant
      FROM unnest(ARRAY['eligible','active','expired','fulfilled','running','lease','wrong-solver','wrong-upstream','not-remote','unacknowledged',
        'not-stopped','wrong-signature','no-loss','review-conflict','storage-rejected','other-http']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS SELECT 1 AS id,
      md5('owner')::uuid AS remote_solver_registered_id,'https://fixture.invalid'::text AS upstream_base_url,
      'fixture-token'::text AS remote_solver_auth_token,false AS remote_solver_transfer_paused`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS SELECT id,
      CASE WHEN variant='wrong-solver' THEN md5('foreign')::uuid ELSE md5('owner')::uuid END AS registered_solver_id,
      CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END AS source_base_url,
      CASE WHEN variant IN ('active','expired','fulfilled') THEN variant ELSE 'cancelled' END AS status,
      jsonb_build_object('authoritativeLeaseLoss',variant<>'no-loss') AS response_payload FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS SELECT id,id::text AS engine_job_id,
      CASE WHEN variant='running' THEN 'running' ELSE 'failed' END AS status,
      CASE WHEN variant='lease' THEN md5('lease')::uuid END AS ingest_lease_token,
      CASE WHEN variant='lease' THEN clock_timestamp()+interval '1 day' END AS ingest_lease_expires_at,
      jsonb_build_object('remoteSolver',variant<>'not-remote','remoteProgressiveExecution','fixture','syncPromiseId',id::text,
        'upstreamBaseUrl','https://fixture.invalid') AS request_payload FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_submission_intents ON COMMIT DROP AS
      SELECT id AS sim_job_id,'signature'::text AS assignment_signature FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,CASE WHEN variant='wrong-signature' THEN 'foreign' ELSE 'signature' END AS assignment_signature,
      CASE WHEN variant<>'not-stopped' THEN id::text END AS stopped_engine_job_id,
      CASE WHEN variant<>'unacknowledged' THEN clock_timestamp() END AS acknowledged_at,'{"result":{}}'::jsonb AS report FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_delivery_failures ON COMMIT DROP AS SELECT id AS sim_job_id,
      md5(variant) AS point_content_signature,'conflict'::text AS state,NULL::timestamptz AS retry_after,
      CASE WHEN variant='other-http' THEN 500 ELSE 409 END AS last_http_status,
      CASE WHEN variant='storage-rejected' THEN 'Stopped progressive storage delivery failed (409)' ELSE 'Progressive evidence delivery failed (409)' END AS last_error,
      CASE WHEN variant='review-conflict' THEN '["review"]' ELSE '[]' END::jsonb AS remote_conflict_ids,
      clock_timestamp() AS updated_at FROM fixture_jobs`);
    const before =
      await transaction.execute(sql`SELECT to_jsonb(job) AS job,to_jsonb(promise) AS promise,to_jsonb(report) AS report
      FROM sim_jobs job JOIN sync_sweep_promises promise USING(id) JOIN progressive_worker_reports report ON report.sim_job_id=job.id ORDER BY job.id`);
    const [eligible] = await transaction.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant='eligible'`,
    );
    expect(
      await progressiveStoppedStorageEligible(connection, String(eligible.id)),
    ).toBe(true);
    const ordinary = await transaction.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant IN ('active','expired','fulfilled')`,
    );
    for (const row of ordinary)
      expect(
        await progressiveStoppedStorageEligible(connection, String(row.id)),
      ).toBe(false);
    expect(await requeueStoppedProgressiveStorage(connection)).toBe(1);
    expect(await requeueStoppedProgressiveStorage(connection)).toBe(0);
    const retries =
      await transaction.execute(sql`SELECT fixture.variant FROM progressive_worker_delivery_failures failure
      JOIN fixture_jobs fixture ON fixture.id=failure.sim_job_id WHERE state='retry'`);
    expect(retries).toEqual([{ variant: "eligible" }]);
    await transaction.execute(sql`UPDATE progressive_worker_delivery_failures SET state='conflict',last_error='Stopped progressive storage delivery failed (409)'
      WHERE sim_job_id=${eligible.id}::uuid`);
    expect(await requeueStoppedProgressiveStorage(connection)).toBe(0);
    expect(
      await transaction.execute(sql`SELECT to_jsonb(job) AS job,to_jsonb(promise) AS promise,to_jsonb(report) AS report
      FROM sim_jobs job JOIN sync_sweep_promises promise USING(id) JOIN progressive_worker_reports report ON report.sim_job_id=job.id ORDER BY job.id`),
    ).toEqual(before);
  });
});
