import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import { progressiveStagingSelectionSql } from "../../../apps/sweeper/src/progressive-staging-selection";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("conserves eligible active-priority and FIFO selection across ownership, retries, leases and report states", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_jobs ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['eligible-active','eligible-cancelled','eligible-expired','future-retry',
        'wrong-solver','wrong-upstream','wrong-job-upstream','not-remote','live-ingest','expired-ingest','unacknowledged','null-result','missing-result','already-staged']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 AS id,false AS remote_solver_transfer_paused,'fixture-token'::text AS remote_solver_auth_token,
        'https://fixture.invalid'::text AS upstream_base_url,md5('solver')::uuid AS remote_solver_registered_id`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,jsonb_build_object('syncPromiseId',id::text,'remoteSolver',variant<>'not-remote',
        'upstreamBaseUrl',CASE WHEN variant='wrong-job-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END) AS request_payload,
        CASE WHEN variant IN ('live-ingest','expired-ingest') THEN md5(variant)::uuid END AS ingest_lease_token,
        CASE WHEN variant='live-ingest' THEN clock_timestamp()+interval '1 day' WHEN variant='expired-ingest' THEN clock_timestamp()-interval '1 day' END AS ingest_lease_expires_at
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant='eligible-cancelled' THEN 'cancelled' ELSE 'active' END AS status,
        CASE WHEN variant='eligible-expired' THEN clock_timestamp()-interval '1 day' ELSE clock_timestamp()+interval '1 day' END AS "expiresAt",
        CASE WHEN variant='wrong-solver' THEN md5('foreign')::uuid ELSE md5('solver')::uuid END AS registered_solver_id,
        CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END AS source_base_url
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,sequence,CASE WHEN variant='unacknowledged' THEN NULL ELSE clock_timestamp() END AS acknowledged_at,
        CASE WHEN variant='null-result' THEN '{"result":null}'::jsonb WHEN variant='missing-result' THEN '{}'::jsonb ELSE '{"result":{}}'::jsonb END AS report,
        timestamptz '2026-01-01T00:00:00Z' + CASE WHEN variant='eligible-cancelled' THEN interval '0 seconds' ELSE interval '1 second' END AS created_at
      FROM fixture_jobs CROSS JOIN generate_series(1,2) sequence`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_staging_failures ON COMMIT DROP AS
      SELECT id AS sim_job_id,sequence,clock_timestamp()+interval '1 day' AS retry_after
      FROM fixture_jobs CROSS JOIN generate_series(1,2) sequence WHERE variant='future-retry'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_receipts ON COMMIT DROP AS
      SELECT id AS sim_job_id,sequence FROM fixture_jobs CROSS JOIN generate_series(1,2) sequence WHERE variant='already-staged'`);
    const [index] = await transaction.execute(
      sql`SELECT indisvalid FROM pg_index WHERE indexrelid='public.progressive_worker_reports_staging_order_idx'::regclass`,
    );
    expect(index.indisvalid).toBe(true);
    const select = (active: boolean) =>
      transaction.execute(progressiveStagingSelectionSql(active));
    const expected = async (active: boolean) =>
      transaction.execute(sql`SELECT report.sim_job_id,report.sequence FROM progressive_worker_reports report
      JOIN fixture_jobs fixture ON fixture.id=report.sim_job_id JOIN sync_sweep_promises promise ON promise.id=fixture.id
      WHERE fixture.variant IN ('eligible-active','eligible-cancelled','eligible-expired','expired-ingest')
      ORDER BY CASE WHEN ${active} AND promise.status='active' AND promise."expiresAt">clock_timestamp() THEN 0 ELSE 1 END,
        report.created_at,report.sim_job_id,report.sequence LIMIT 1`);
    for (const active of [false, true])
      expect(await select(active)).toEqual(await expected(active));
    await transaction.execute(
      sql`UPDATE sync_sweep_promises SET status='cancelled'`,
    );
    expect(await select(true)).toEqual(await select(false));
    for (const statement of [
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true`,
      sql`UPDATE sync_api_settings SET remote_solver_auth_token=''`,
      sql`UPDATE sync_api_settings SET upstream_base_url=NULL`,
      sql`UPDATE sync_api_settings SET remote_solver_registered_id=md5('other')::uuid`,
    ]) {
      const rollback = new Error("Rollback isolated selector setting");
      await expect(
        transaction.transaction(async (nested) => {
          await nested.execute(statement);
          expect(
            await nested.execute(progressiveStagingSelectionSql(true)),
          ).toEqual([]);
          expect(
            await nested.execute(progressiveStagingSelectionSql(false)),
          ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
    const remaining =
      await transaction.execute(sql`SELECT sim_job_id,sequence FROM progressive_worker_reports
      WHERE (sim_job_id,sequence) NOT IN (SELECT sim_job_id,sequence FROM progressive_worker_evidence_receipts)`);
    expect(remaining.length).toBeGreaterThan(0);
    await transaction.execute(
      sql`INSERT INTO progressive_worker_evidence_receipts SELECT sim_job_id,sequence FROM progressive_worker_reports`,
    );
    expect(await select(true)).toEqual([]);
    expect(await select(false)).toEqual([]);
  });
});
