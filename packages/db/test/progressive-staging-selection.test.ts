import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import { progressiveStagingSelectionSql } from "../../../apps/sweeper/src/progressive-staging-selection";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("serves fresh active reports and FIFO backlog without changing eligibility", async () => {
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
    await transaction.execute(sql`CREATE UNIQUE INDEX fixture_staged_report_idx
      ON progressive_worker_evidence_receipts(sim_job_id,sequence)`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_job_idx ON sim_jobs(id)`,
    );
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_promise_idx ON sync_sweep_promises(id)`,
    );
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_retry_idx ON progressive_worker_staging_failures(sim_job_id,sequence)`,
    );
    await transaction.execute(sql`CREATE INDEX fixture_report_order_idx ON progressive_worker_reports(created_at,sim_job_id,sequence)
      WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object'`);
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
        CASE WHEN ${active} AND promise.status='active' AND promise."expiresAt">clock_timestamp() THEN report.created_at END DESC,
        CASE WHEN ${active} AND promise.status='active' AND promise."expiresAt">clock_timestamp() THEN report.sim_job_id END DESC,
        CASE WHEN ${active} AND promise.status='active' AND promise."expiresAt">clock_timestamp() THEN report.sequence END DESC,
        report.created_at,report.sim_job_id,report.sequence LIMIT 1`);
    for (const active of [false, true])
      expect(await select(active)).toEqual(await expected(active));
    const fresh = await select(true);
    const oldest = await select(false);
    expect(fresh[0].sequence).toBe(2);
    expect(oldest[0].sequence).toBe(1);
    expect(fresh).not.toEqual(oldest);
    await transaction.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,acknowledged_at,report,created_at)
      SELECT id,sequence,clock_timestamp(),'{"result":{}}'::jsonb,
        timestamptz '2025-01-01T00:00:00Z' + sequence * interval '1 second'
      FROM fixture_jobs CROSS JOIN generate_series(3,15002) sequence WHERE variant='eligible-active'`);
    await transaction.execute(sql`ANALYZE progressive_worker_reports,progressive_worker_evidence_receipts,
      sim_jobs,sync_sweep_promises,progressive_worker_staging_failures,sync_api_settings`);
    expect(await select(true)).toEqual(fresh);
    const backlogHead = await select(false);
    expect(backlogHead[0].sequence).toBe(3);
    for (const active of [true, false]) {
      const [measured] = await transaction.execute(
        sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${progressiveStagingSelectionSql(active)}`,
      );
      const result = (
        measured["QUERY PLAN"] as Array<Record<string, unknown>>
      )[0];
      const nodes: Array<Record<string, unknown>> = [];
      function visit(node: Record<string, unknown>) {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Array<
          Record<string, unknown>
        >)
          visit(child);
      }
      visit(result.Plan as Record<string, unknown>);
      expect(
        nodes.some((node) => node["Index Name"] === "fixture_report_order_idx"),
      ).toBe(true);
      expect(
        nodes.some(
          (node) =>
            node["Relation Name"] === "progressive_worker_reports" &&
            node["Node Type"] === "Seq Scan",
        ),
      ).toBe(false);
      console.info(
        JSON.stringify({
          freshPriority: active,
          backlogReports: 15000,
          executionMs: result["Execution Time"],
        }),
      );
    }
    await transaction.execute(sql`INSERT INTO progressive_worker_evidence_receipts(sim_job_id,sequence)
      VALUES(${fresh[0].sim_job_id},${fresh[0].sequence})`);
    expect(await select(true)).not.toEqual(fresh);
    expect(await select(false)).toEqual(backlogHead);
    await transaction.execute(sql`DELETE FROM progressive_worker_evidence_receipts
      WHERE sim_job_id=${fresh[0].sim_job_id} AND sequence=${fresh[0].sequence}`);
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
      sql`INSERT INTO progressive_worker_evidence_receipts SELECT sim_job_id,sequence FROM progressive_worker_reports ON CONFLICT DO NOTHING`,
    );
    expect(await select(true)).toEqual([]);
    expect(await select(false)).toEqual([]);
  });
});
