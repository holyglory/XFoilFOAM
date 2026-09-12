import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import { progressiveDeliverySelectionSql } from "../../../apps/sweeper/src/progressive-delivery-selection";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("preserves exact eligible deliveries, active priority, fallback and cumulative-report ordering", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_jobs ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['eligible-active','eligible-cancelled','eligible-expired',
        'future-retry','due-retry','conflict','wrong-solver','wrong-upstream','wrong-job-upstream','not-remote',
        'unacknowledged','already-delivered','wrong-attempt-job','wrong-engine','missing-result']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 AS id,false AS remote_solver_transfer_paused,'fixture-token'::text AS remote_solver_auth_token,
        'https://fixture.invalid'::text AS upstream_base_url,md5('solver')::uuid AS remote_solver_registered_id,
        md5('instance')::uuid AS instance_id,'fixture'::text AS instance_name`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,jsonb_build_object('syncPromiseId',id::text,'remoteSolver',variant<>'not-remote',
        'upstreamBaseUrl',CASE WHEN variant='wrong-job-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END) AS request_payload
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant='eligible-cancelled' THEN 'cancelled' ELSE 'active' END AS status,
        CASE WHEN variant='eligible-expired' THEN clock_timestamp()-interval '1 day' ELSE clock_timestamp()+interval '1 day' END AS "expiresAt",
        CASE WHEN variant='wrong-solver' THEN md5('foreign')::uuid ELSE md5('solver')::uuid END AS registered_solver_id,
        CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END AS source_base_url
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,sequence,CASE WHEN variant='unacknowledged' THEN NULL ELSE clock_timestamp() END AS acknowledged_at,
        '{"result":{}}'::jsonb AS report,md5(variant||sequence)::text AS content_signature,
        timestamptz '2026-01-01T00:00:00Z' + CASE WHEN variant='eligible-cancelled' THEN interval '0 seconds' ELSE interval '1 second' END AS created_at
      FROM fixture_jobs CROSS JOIN generate_series(1,2) sequence`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
      SELECT md5(variant||angle||replay)::uuid AS id,
        CASE WHEN variant='wrong-attempt-job' THEN md5('foreign')::uuid ELSE id END AS sim_job_id,
        CASE WHEN variant='wrong-engine' THEN md5('foreign')::text ELSE id::text END AS engine_job_id,
        CASE WHEN variant='missing-result' THEN NULL ELSE md5('result'||variant)::uuid END AS result_id,
        angle AS aoa_deg,'fixture-'||angle AS engine_case_slug,'{"realFixture":true}'::jsonb AS evidence_payload
      FROM fixture_jobs CROSS JOIN unnest(ARRAY[-2,3]) angle CROSS JOIN generate_series(1,2) replay`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_attempts ON COMMIT DROP AS
      SELECT fixture.id AS sim_job_id,sequence,md5(variant||angle||replay)::uuid AS result_attempt_id,
        md5('point'||variant||angle||replay)::text AS point_content_signature
      FROM fixture_jobs fixture CROSS JOIN generate_series(1,2) sequence CROSS JOIN unnest(ARRAY[-2,3]) angle CROSS JOIN generate_series(1,2) replay`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_hub_receipts ON COMMIT DROP AS
      SELECT source.sim_job_id,source.point_content_signature FROM progressive_worker_evidence_attempts source
      JOIN fixture_jobs fixture ON fixture.id=source.sim_job_id WHERE fixture.variant='already-delivered' GROUP BY 1,2`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_delivery_failures ON COMMIT DROP AS
      SELECT source.sim_job_id,source.point_content_signature,CASE WHEN variant='conflict' THEN 'conflict' ELSE 'retry' END AS state,
        CASE WHEN variant='future-retry' THEN clock_timestamp()+interval '1 day'
          WHEN variant='due-retry' THEN clock_timestamp()-interval '1 day' END AS retry_after
      FROM progressive_worker_evidence_attempts source JOIN fixture_jobs fixture ON fixture.id=source.sim_job_id
      WHERE variant IN ('future-retry','due-retry','conflict') GROUP BY 1,2,variant`);
    const selected = (active: boolean) =>
      transaction.execute(progressiveDeliverySelectionSql(active));
    const expected = (active: boolean) =>
      transaction.execute(sql`
      SELECT source.sim_job_id,source.sequence,source.result_attempt_id,source.point_content_signature,
        report.content_signature AS report_signature,report.report,attempt.result_id,attempt.aoa_deg,attempt.engine_case_slug,attempt.evidence_payload,
        job.request_payload,settings.upstream_base_url,settings.remote_solver_auth_token,settings.remote_solver_registered_id,
        settings.instance_id,settings.instance_name,promise.id AS promise_id
      FROM progressive_worker_evidence_attempts source
      JOIN fixture_jobs fixture ON fixture.id=source.sim_job_id
      JOIN progressive_worker_reports report ON report.sim_job_id=source.sim_job_id AND report.sequence=source.sequence
      JOIN result_attempts attempt ON attempt.id=source.result_attempt_id
      JOIN sim_jobs job ON job.id=source.sim_job_id JOIN sync_sweep_promises promise ON promise.id=job.id
      CROSS JOIN sync_api_settings settings
      WHERE fixture.variant IN ('eligible-active','eligible-cancelled','eligible-expired','due-retry')
        AND NOT EXISTS(SELECT 1 FROM progressive_worker_hub_receipts delivered
          WHERE delivered.sim_job_id=source.sim_job_id AND delivered.point_content_signature=source.point_content_signature)
      ORDER BY CASE WHEN ${active} AND promise.status='active' AND promise."expiresAt">clock_timestamp() THEN 0 ELSE 1 END,
        report.created_at,source.sim_job_id,source.sequence,attempt.aoa_deg,source.result_attempt_id LIMIT 1`);
    for (const active of [true, false]) {
      const rollback = new Error(
        "Rollback isolated complete delivery ordering",
      );
      await expect(
        transaction.transaction(async (nested) => {
          let count = 0;
          while (true) {
            const actual = await nested.execute(
              progressiveDeliverySelectionSql(active),
            );
            expect(actual).toEqual(await expected(active));
            if (!actual.length) break;
            const point = actual[0];
            expect(point.sequence).toBe(1);
            await nested.execute(sql`INSERT INTO progressive_worker_hub_receipts VALUES
            (${point.sim_job_id}::uuid,${point.point_content_signature})`);
            count += 1;
            expect(count).toBeLessThanOrEqual(16);
          }
          expect(count).toBe(16);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
    await transaction.execute(
      sql`UPDATE sync_sweep_promises SET status='cancelled'`,
    );
    expect(await selected(true)).toEqual(await expected(false));
    for (const statement of [
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true`,
      sql`UPDATE sync_api_settings SET remote_solver_auth_token=''`,
      sql`UPDATE sync_api_settings SET upstream_base_url=NULL`,
      sql`UPDATE sync_api_settings SET remote_solver_registered_id=md5('unregistered')::uuid`,
    ]) {
      const rollback = new Error("Rollback isolated delivery settings");
      await expect(
        transaction.transaction(async (nested) => {
          await nested.execute(statement);
          expect(
            await nested.execute(progressiveDeliverySelectionSql(true)),
          ).toEqual([]);
          expect(
            await nested.execute(progressiveDeliverySelectionSql(false)),
          ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
  });
});
