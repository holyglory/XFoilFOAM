import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, type DB } from "../src/client";
import { progressiveStagingSelectionSql } from "../../../apps/sweeper/src/progressive-staging-selection";
import { nextProgressiveEvidenceWakeAt } from "../../../apps/sweeper/src/progressive-evidence-service";
import {
  progressiveEvidenceWakeSql,
  type ProgressiveEvidenceWakeScope,
} from "../../../apps/sweeper/src/progressive-evidence-wake";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

async function withWakeFixture(
  scope: ProgressiveEvidenceWakeScope,
  run: (connection: DB) => Promise<void>,
) {
  await client.db.transaction(async (transaction) => {
    const connection = transaction as unknown as DB;
    await transaction.execute(sql`CREATE TEMP TABLE wake_cases ON COMMIT DROP AS
      SELECT md5('wake-'||variant)::uuid id,variant FROM unnest(ARRAY[
        'ready','future-retry','live-claim','retry-and-claim','retry-after-claim','expired-retry','expired-claim',
        'null-claim-expiry','wrong-owner','wrong-upstream','wrong-job-upstream','not-remote',
        'unacknowledged','null-result','already-finished','blocked','wrong-attempt-job','wrong-engine','missing-result-id']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 id,false remote_solver_transfer_paused,'fixture-token'::text remote_solver_auth_token,
        'https://wake.invalid'::text upstream_base_url,md5('unselected')::uuid remote_solver_registered_id`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs (
      id uuid PRIMARY KEY,request_payload jsonb,ingest_lease_token uuid,ingest_lease_expires_at timestamptz) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO sim_jobs
      SELECT id,jsonb_build_object('syncPromiseId',id::text,'remoteSolver',variant<>'not-remote',
        'upstreamBaseUrl',CASE WHEN variant='wrong-job-upstream' THEN 'https://foreign.invalid' ELSE 'https://wake.invalid' END),
        CASE WHEN variant IN ('live-claim','expired-claim','retry-and-claim','retry-after-claim','null-claim-expiry') THEN id END,
        CASE WHEN variant IN ('live-claim','retry-and-claim') THEN clock_timestamp()+interval '2 hours'
          WHEN variant='retry-after-claim' THEN clock_timestamp()+interval '1 hour'
          WHEN variant='expired-claim' THEN clock_timestamp()-interval '1 hour' END
      FROM wake_cases`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant='wrong-owner' THEN md5('foreign')::uuid ELSE id END registered_solver_id,
        CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://wake.invalid' END source_base_url
      FROM wake_cases`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX wake_promise_identity_idx ON sync_sweep_promises((id::text))`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports (
      sim_job_id uuid,sequence bigint,acknowledged_at timestamptz,report jsonb,created_at timestamptz,
      PRIMARY KEY(sim_job_id,sequence)) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO progressive_worker_reports
      SELECT id,1,CASE WHEN variant<>'unacknowledged' THEN clock_timestamp() END,
        CASE WHEN variant='null-result' THEN '{"result":null}'::jsonb ELSE '{"result":{}}'::jsonb END,
        timestamptz '2026-01-01' FROM wake_cases`);
    await transaction.execute(sql`CREATE INDEX wake_report_source_idx ON progressive_worker_reports(created_at,sim_job_id,sequence)
      WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_receipts (
      sim_job_id uuid,sequence bigint,PRIMARY KEY(sim_job_id,sequence)) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO progressive_worker_evidence_receipts
      SELECT id,1 FROM wake_cases WHERE ${scope === "delivery"} OR variant='already-finished'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_staging_failures (
      sim_job_id uuid,sequence bigint,retry_after timestamptz,PRIMARY KEY(sim_job_id,sequence)) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO progressive_worker_staging_failures
      SELECT id,1,clock_timestamp()+CASE WHEN variant='expired-retry' THEN interval '-1 hour'
        WHEN variant='retry-after-claim' THEN interval '3 hours' ELSE interval '1 hour' END
      FROM wake_cases WHERE variant IN ('future-retry','retry-and-claim','retry-after-claim','expired-retry')`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts (
      id uuid PRIMARY KEY,sim_job_id uuid,engine_job_id text,result_id uuid) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO result_attempts
      SELECT id,CASE WHEN variant='wrong-attempt-job' THEN md5('foreign')::uuid ELSE id END,
        CASE WHEN variant='wrong-engine' THEN 'foreign' ELSE id::text END,
        CASE WHEN variant<>'missing-result-id' THEN id END FROM wake_cases`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_attempts (
      sim_job_id uuid,sequence bigint,result_attempt_id uuid,point_content_signature text,
      PRIMARY KEY(sim_job_id,sequence,result_attempt_id)) ON COMMIT DROP`);
    await transaction.execute(
      sql`INSERT INTO progressive_worker_evidence_attempts SELECT id,1,id,id::text FROM wake_cases`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_hub_receipts (
      sim_job_id uuid,point_content_signature text,PRIMARY KEY(sim_job_id,point_content_signature)) ON COMMIT DROP`);
    await transaction.execute(
      sql`INSERT INTO progressive_worker_hub_receipts SELECT id,id::text FROM wake_cases WHERE variant='already-finished'`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_delivery_failures (
      sim_job_id uuid,point_content_signature text,state text,retry_after timestamptz,
      PRIMARY KEY(sim_job_id,point_content_signature)) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO progressive_worker_delivery_failures
      SELECT id,id::text,CASE WHEN variant='blocked' THEN 'blocked' ELSE 'retry' END,
        clock_timestamp()+CASE WHEN variant IN ('expired-retry','blocked') THEN interval '-1 hour'
          WHEN variant='retry-after-claim' THEN interval '3 hours' ELSE interval '1 hour' END
      FROM wake_cases WHERE variant IN ('future-retry','retry-and-claim','retry-after-claim','expired-retry','blocked')`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_delivery_claims (
      sim_job_id uuid,point_content_signature text,claim_token uuid,claim_expires_at timestamptz,
      PRIMARY KEY(sim_job_id,point_content_signature)) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO progressive_worker_evidence_delivery_claims
      SELECT id,id::text,ingest_lease_token,ingest_lease_expires_at FROM sim_jobs WHERE ingest_lease_token IS NOT NULL`);
    await run(connection);
  });
}

it.each(["staging", "delivery"] as const)(
  "wakes %s only for owned pending work after every claim and retry deadline",
  async (scope) => {
    await withWakeFixture(scope, async (connection) => {
      const selectVariant = async (variant: string) => {
        await connection.execute(sql`UPDATE sync_api_settings SET remote_solver_registered_id=
        (SELECT id FROM wake_cases WHERE variant=${variant})`);
      };
      for (const variant of ["ready", "expired-retry", "expired-claim"]) {
        await selectVariant(variant);
        const before = Date.now();
        const wake = await nextProgressiveEvidenceWakeAt(connection, scope);
        expect(wake?.getTime()).toBeGreaterThanOrEqual(before - 1000);
        expect(wake?.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      }
      for (const variant of [
        "future-retry",
        "live-claim",
        "retry-and-claim",
        "retry-after-claim",
      ]) {
        await selectVariant(variant);
        const [expected] = await connection.execute(
          scope === "staging"
            ? sql`SELECT greatest(failure.retry_after,job.ingest_lease_expires_at) deadline
          FROM wake_cases fixture JOIN sim_jobs job ON job.id=fixture.id
          LEFT JOIN progressive_worker_staging_failures failure ON failure.sim_job_id=fixture.id
          WHERE fixture.variant=${variant}`
            : sql`SELECT greatest(failure.retry_after,claim.claim_expires_at) deadline
          FROM wake_cases fixture
          LEFT JOIN progressive_worker_delivery_failures failure ON failure.sim_job_id=fixture.id
          LEFT JOIN progressive_worker_evidence_delivery_claims claim ON claim.sim_job_id=fixture.id
          WHERE fixture.variant=${variant}`,
        );
        const deadline =
          expected.deadline instanceof Date
            ? expected.deadline
            : new Date(String(expected.deadline));
        expect(
          (await nextProgressiveEvidenceWakeAt(connection, scope))?.getTime(),
        ).toBe(deadline.getTime());
      }
      for (const variant of [
        "wrong-owner",
        "wrong-upstream",
        "wrong-job-upstream",
        "not-remote",
        "unacknowledged",
        "null-result",
        "already-finished",
        "null-claim-expiry",
        ...(scope === "delivery"
          ? [
              "blocked",
              "wrong-attempt-job",
              "wrong-engine",
              "missing-result-id",
            ]
          : []),
      ]) {
        await selectVariant(variant);
        expect(
          await nextProgressiveEvidenceWakeAt(connection, scope),
          variant,
        ).toBeNull();
      }
      await selectVariant("ready");
      for (const statement of [
        sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true`,
        sql`UPDATE sync_api_settings SET remote_solver_auth_token=''`,
        sql`UPDATE sync_api_settings SET upstream_base_url=NULL`,
      ]) {
        const rollback = new Error("restore wake settings");
        await expect(
          connection.transaction(async (transaction) => {
            await transaction.execute(statement);
            expect(
              await nextProgressiveEvidenceWakeAt(
                transaction as unknown as DB,
                scope,
              ),
            ).toBeNull();
            throw rollback;
          }),
        ).rejects.toBe(rollback);
      }
      await connection.execute(
        sql`UPDATE sync_api_settings SET remote_solver_registered_id=md5('absent')::uuid`,
      );
      expect(await nextProgressiveEvidenceWakeAt(connection, scope)).toBeNull();
    });
  },
);

it.each(["staging", "delivery"] as const)(
  "keeps %s ownership probes bounded with forty thousand retained reports",
  async (scope) => {
    await withWakeFixture(scope, async (connection) => {
      await connection.execute(sql`CREATE TEMP TABLE retained_wake_jobs ON COMMIT DROP AS
      SELECT md5('retained-wake-'||ordinal)::uuid id FROM generate_series(1,40000) ordinal`);
      await connection.execute(sql`INSERT INTO sim_jobs SELECT id,jsonb_build_object(
      'syncPromiseId',id::text,'remoteSolver',true,'upstreamBaseUrl','https://wake.invalid',
      'retainedMetadata',repeat(md5(id::text),32)),NULL,NULL FROM retained_wake_jobs`);
      await connection.execute(
        sql`INSERT INTO sync_sweep_promises SELECT id,md5('wake-ready')::uuid,'https://wake.invalid' FROM retained_wake_jobs`,
      );
      await connection.execute(sql`INSERT INTO progressive_worker_reports SELECT id,1,clock_timestamp(),
      jsonb_build_object('result',jsonb_build_object('retainedMetadata',repeat(md5(id::text),32))),timestamptz '2025-01-01' FROM retained_wake_jobs`);
      await connection.execute(
        sql`INSERT INTO progressive_worker_evidence_receipts SELECT id,1 FROM retained_wake_jobs`,
      );
      await connection.execute(
        sql`INSERT INTO result_attempts SELECT id,id,id::text,id FROM retained_wake_jobs`,
      );
      await connection.execute(
        sql`INSERT INTO progressive_worker_evidence_attempts SELECT id,1,id,id::text FROM retained_wake_jobs`,
      );
      await connection.execute(
        sql`INSERT INTO progressive_worker_hub_receipts SELECT id,id::text FROM retained_wake_jobs`,
      );
      await connection.execute(sql`ANALYZE sim_jobs,sync_sweep_promises,progressive_worker_reports,progressive_worker_evidence_receipts,
      progressive_worker_evidence_attempts,progressive_worker_hub_receipts,progressive_worker_delivery_failures,
      progressive_worker_evidence_delivery_claims,progressive_worker_staging_failures,result_attempts,sync_api_settings`);
      await connection.execute(
        sql`UPDATE sync_api_settings SET remote_solver_registered_id=md5('wake-ready')::uuid`,
      );
      expect(
        await nextProgressiveEvidenceWakeAt(connection, scope),
      ).not.toBeNull();
      for (const ready of [true, false]) {
        const [measured] = await connection.execute(
          sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${progressiveEvidenceWakeSql(scope, ready)}`,
        );
        const result = (
          measured["QUERY PLAN"] as Array<Record<string, unknown>>
        )[0];
        const nodes: Array<Record<string, unknown>> = [];
        const visit = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans ?? []) as Array<
            Record<string, unknown>
          >)
            visit(child);
        };
        visit(result.Plan as Record<string, unknown>);
        const ownership = nodes.filter(
          (node) => node["Relation Name"] === "sim_jobs",
        );
        expect(
          ownership.every((node) => node["Node Type"] !== "Seq Scan"),
        ).toBe(true);
        const probes = ownership.reduce(
          (total, node) => total + Number(node["Actual Loops"]),
          0,
        );
        expect(probes).toBeLessThanOrEqual(32);
        expect(
          nodes.some((node) => node["Subplan Name"] === "CTE owned_reports"),
        ).toBe(false);
        console.info(
          JSON.stringify({
            scope,
            ready,
            retainedReports: 40000,
            ownershipProbes: probes,
            executionMs: result["Execution Time"],
          }),
        );
      }
      await connection.execute(
        sql`UPDATE sync_api_settings SET remote_solver_registered_id=md5('wake-live-claim')::uuid`,
      );
      expect(
        (await nextProgressiveEvidenceWakeAt(connection, scope))!.getTime(),
      ).toBeGreaterThan(Date.now() + 3600_000);
      await connection.execute(
        sql`UPDATE sync_api_settings SET remote_solver_registered_id=md5('wake-already-finished')::uuid`,
      );
      expect(await nextProgressiveEvidenceWakeAt(connection, scope)).toBeNull();
    });
  },
);

it("serves fresh active reports and FIFO backlog without changing eligibility", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_jobs ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['eligible-active','eligible-cancelled','eligible-expired','future-retry',
        'wrong-solver','wrong-upstream','wrong-job-upstream','not-remote','live-ingest','expired-ingest','unacknowledged','null-result','missing-result','already-staged']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 AS id,false AS remote_solver_transfer_paused,'fixture-token'::text AS remote_solver_auth_token,
        'https://fixture.invalid'::text AS upstream_base_url,md5('solver')::uuid AS remote_solver_registered_id`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,id AS campaign_id,jsonb_build_object('syncPromiseId',id::text,'remoteSolver',variant<>'not-remote',
        'upstreamBaseUrl',CASE WHEN variant='wrong-job-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END) AS request_payload,
        CASE WHEN variant IN ('live-ingest','expired-ingest') THEN md5(variant)::uuid END AS ingest_lease_token,
        CASE WHEN variant='live-ingest' THEN clock_timestamp()+interval '1 day' WHEN variant='expired-ingest' THEN clock_timestamp()-interval '1 day' END AS ingest_lease_expires_at
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant='eligible-cancelled' THEN 'cancelled' WHEN variant='eligible-expired' THEN 'expired' ELSE 'active' END AS status,
        CASE WHEN variant='eligible-expired' THEN '{"authoritativeLeaseLoss":true}'::jsonb ELSE NULL::jsonb END AS response_payload,
        CASE WHEN variant='eligible-expired' THEN '{"progressiveCampaignStatus":"active"}'::jsonb ELSE '{}'::jsonb END AS request_payload,
        CASE WHEN variant='eligible-expired' THEN clock_timestamp()-interval '1 day' ELSE clock_timestamp()+interval '1 day' END AS "expiresAt",
        CASE WHEN variant='wrong-solver' THEN md5('foreign')::uuid ELSE md5('solver')::uuid END AS registered_solver_id,
        CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END AS source_base_url
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,sequence,CASE WHEN variant='unacknowledged' THEN NULL ELSE clock_timestamp() END AS acknowledged_at,
        CASE WHEN variant='null-result' THEN '{"result":null}'::jsonb WHEN variant='missing-result' THEN '{}'::jsonb WHEN variant='eligible-expired' THEN '{"result":{},"stopProof":{"execution_stopped":"true"}}'::jsonb ELSE '{"result":{}}'::jsonb END AS report,
        CASE WHEN variant='eligible-expired' THEN id::text END AS stopped_engine_job_id,
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
      transaction.execute(sql`SELECT report.sim_job_id,report.sequence,report.created_at FROM progressive_worker_reports report
      JOIN fixture_jobs fixture ON fixture.id=report.sim_job_id JOIN sync_sweep_promises promise ON promise.id=fixture.id
      WHERE fixture.variant IN ('eligible-active','eligible-cancelled','eligible-expired','expired-ingest')
      ORDER BY CASE WHEN NOT ${active} AND fixture.variant='eligible-expired' THEN 0 ELSE 1 END,
        CASE WHEN ${active} AND promise.status='active' AND promise."expiresAt">clock_timestamp() THEN 0 ELSE 1 END,
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
    const terminalPriorityRollback = new Error(
      "Restore active terminal staging priority fixture",
    );
    await expect(
      transaction.transaction(async (nested) => {
        await nested.execute(sql`UPDATE progressive_worker_reports
          SET stopped_engine_job_id=sim_job_id::text,
            created_at=timestamptz '2024-01-01T00:00:00Z'
          WHERE sim_job_id=${fresh[0].sim_job_id} AND sequence=1`);
        const [selected] = await nested.execute(
          progressiveStagingSelectionSql(true),
        );
        expect(selected).toMatchObject({
          sim_job_id: fresh[0].sim_job_id,
          sequence: 1,
        });
        throw terminalPriorityRollback;
      }),
    ).rejects.toBe(terminalPriorityRollback);
    await transaction.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,acknowledged_at,report,created_at)
      SELECT id,sequence,clock_timestamp(),'{"result":{}}'::jsonb,
        timestamptz '2025-01-01T00:00:00Z' + sequence * interval '1 second'
      FROM fixture_jobs CROSS JOIN generate_series(3,15002) sequence WHERE variant='eligible-active'`);
    await transaction.execute(sql`ANALYZE progressive_worker_reports,progressive_worker_evidence_receipts,
      sim_jobs,sync_sweep_promises,progressive_worker_staging_failures,sync_api_settings`);
    expect(await select(true)).toEqual(fresh);
    const backlogHead = await select(false);
    expect(backlogHead[0].sequence).toBe(1);
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
    const retryRollback = new Error("Restore terminal retry fixture");
    await expect(
      transaction.transaction(async (nested) => {
        await nested.execute(sql`UPDATE progressive_worker_reports
        SET stopped_engine_job_id=sim_job_id::text,created_at=timestamptz '2024-01-01T00:00:00Z'
        WHERE sim_job_id=md5('future-retry')::uuid`);
        for (const active of [true, false]) {
          const [selected] = await nested.execute(
            progressiveStagingSelectionSql(active),
          );
          expect(selected.sim_job_id).not.toBe(
            (
              await nested.execute(sql`SELECT md5('future-retry')::uuid AS id`)
            )[0].id,
          );
        }
        await nested.execute(sql`UPDATE progressive_worker_staging_failures
        SET retry_after=clock_timestamp()-interval '1 second'
        WHERE sim_job_id=md5('future-retry')::uuid AND sequence=2`);
        for (const active of [true, false]) {
          const [selected] = await nested.execute(
            progressiveStagingSelectionSql(active),
          );
          expect(selected.sequence).toBe(2);
          expect(selected.sim_job_id).toBe(
            (
              await nested.execute(sql`SELECT md5('future-retry')::uuid AS id`)
            )[0].id,
          );
        }
        throw retryRollback;
      }),
    ).rejects.toBe(retryRollback);
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

it("prioritizes active terminal reports and keeps invalid reports in the fallback queue", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_jobs ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY[
        'active-terminal','active-non-terminal','active-invalid-terminal','ordinary']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 AS id,false AS remote_solver_transfer_paused,'fixture-token'::text AS remote_solver_auth_token,
        'https://fixture.invalid'::text AS upstream_base_url,md5('solver')::uuid AS remote_solver_registered_id`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,jsonb_build_object('syncPromiseId',id::text,'remoteSolver',true,
        'upstreamBaseUrl','https://fixture.invalid') AS request_payload,
        NULL::uuid AS ingest_lease_token,NULL::timestamptz AS ingest_lease_expires_at
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,'active'::text AS status,clock_timestamp()+interval '1 day' AS "expiresAt",
        md5('solver')::uuid AS registered_solver_id,'https://fixture.invalid'::text AS source_base_url
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,1::bigint AS sequence,clock_timestamp() AS acknowledged_at,
        CASE
          WHEN variant='active-terminal' THEN jsonb_build_object('result',jsonb_build_object(),
            'stopProof',jsonb_build_object('execution_stopped',true,'job_id',id::text))
          WHEN variant='active-invalid-terminal' THEN jsonb_build_object('result',jsonb_build_object(),
            'stopProof',jsonb_build_object('execution_stopped',true,'job_id',md5('foreign-stop')::text))
          ELSE '{"result":{}}'::jsonb
        END AS report,
        CASE WHEN variant='active-terminal' THEN id::text
          WHEN variant='active-invalid-terminal' THEN md5('foreign-stop')::text END AS stopped_engine_job_id,
        timestamptz '2026-01-01T00:00:00Z' + CASE
          WHEN variant='active-non-terminal' THEN interval '1 second'
          WHEN variant='active-invalid-terminal' THEN interval '2 seconds'
          WHEN variant='active-terminal' THEN interval '3 seconds'
          ELSE interval '4 seconds' END AS created_at
      FROM fixture_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_staging_failures(
      sim_job_id uuid,sequence bigint,retry_after timestamptz) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_receipts(
      sim_job_id uuid,sequence bigint) ON COMMIT DROP`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_job_idx ON sim_jobs(id)`,
    );
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_promise_idx ON sync_sweep_promises(id)`,
    );
    await transaction.execute(sql`CREATE UNIQUE INDEX fixture_report_idx
      ON progressive_worker_reports(sim_job_id,sequence)`);
    await transaction.execute(sql`CREATE UNIQUE INDEX fixture_receipt_idx
      ON progressive_worker_evidence_receipts(sim_job_id,sequence)`);

    const [activeTerminal] = await transaction.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant='active-terminal'`,
    );
    const [activeNonTerminal] = await transaction.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant='active-non-terminal'`,
    );
    const [ordinary] = await transaction.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant='ordinary'`,
    );
    const [invalidTerminal] = await transaction.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant='active-invalid-terminal'`,
    );

    for (const preferActive of [false, true]) {
      const [selectedTerminal] = await transaction.execute(
        progressiveStagingSelectionSql(preferActive),
      );
      expect(selectedTerminal).toMatchObject({
        sim_job_id: activeTerminal.id,
        sequence: "1",
      });
    }

    await transaction.execute(sql`INSERT INTO progressive_worker_evidence_receipts
      VALUES (${activeTerminal.id}::uuid,1)`);
    const expectedFallback = new Map([
      [false, activeNonTerminal.id],
      [true, ordinary.id],
    ]);
    for (const preferActive of [false, true]) {
      const [selectedFallback] = await transaction.execute(
        progressiveStagingSelectionSql(preferActive),
      );
      expect(selectedFallback).toMatchObject({
        sim_job_id: expectedFallback.get(preferActive),
        sequence: "1",
      });
      expect(selectedFallback.sim_job_id).not.toBe(invalidTerminal.id);
    }
  });
});
