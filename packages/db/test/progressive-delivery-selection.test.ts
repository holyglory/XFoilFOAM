import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import { previousProgressiveSettlementJobsSql } from "../test-support/progressive-progress-selection-baseline";
import { selectProgressiveRemoteProgressJobs } from "../../../apps/sweeper/src/progressive-remote-progress";
import { progressiveDeliverySelectionSql } from "../../../apps/sweeper/src/progressive-delivery-selection";
import {
  progressiveReportJobsSql,
  progressiveSettlementJobsSql,
} from "../../../apps/sweeper/src/progressive-progress-selection";
import {
  nextProgressiveArchiveWakeAt,
  progressiveArchiveSelectionSql,
} from "../../../apps/sweeper/src/progressive-worker-archive-delivery";
import type { DB } from "../src/client";
import { reconcileCompletedProgressiveArchiveReclaims } from "../../../apps/sweeper/src/progressive-archive-reclaim";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

async function selectSettlementJobs(
  connection: Pick<DB, "execute" | "transaction">,
  jobIds?: string[],
) {
  const before = await connection.execute(sql`SHOW jit`);
  const { jobs, terminalJobs } = await selectProgressiveRemoteProgressJobs(
    connection as DB,
    jobIds,
  );
  expect(await connection.execute(sql`SHOW jit`)).toEqual(before);
  expect(jobs).toEqual(await connection.execute(progressiveReportJobsSql(jobIds)));
  expect(terminalJobs).toEqual(
    await connection.execute(previousProgressiveSettlementJobsSql(jobIds)),
  );
  return terminalJobs;
}

async function analyzeSelectionFixture(connection: Pick<DB, "execute">) {
  const tables = await connection.execute(sql`SELECT relname FROM pg_class
    WHERE relnamespace=pg_my_temp_schema() AND relkind='r'`);
  for (const table of tables)
    await connection.execute(sql`ANALYZE ${sql.identifier("pg_temp")}.${sql.identifier(String(table.relname))}`);
}

it("recognizes exact completed canonical cleanup without deleting again or double-counting bytes", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE reclaim_cases ON COMMIT DROP AS
      SELECT md5(variant)::uuid id,variant FROM unnest(ARRAY['exact','live-claim','pending','wrong-job','wrong-attempt-job',
        'wrong-result','wrong-upload','wrong-promise','wrong-source','wrong-generation','missing-remote','already-complete']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_archive_reclaims ON COMMIT DROP AS
      SELECT id AS sim_job_id,'signature'::text AS point_content_signature,
        CASE WHEN variant='already-complete' THEN timestamptz '2026-01-01' END AS completed_at,
        CASE WHEN variant='already-complete' THEN 123 ELSE 0 END::bigint AS reclaimed_bytes,
        CASE WHEN variant='live-claim' THEN md5('claim')::uuid END AS claim_token,
        CASE WHEN variant='live-claim' THEN clock_timestamp()+interval '1 day' END AS claim_expires_at,
        'stale failure'::text AS last_error FROM reclaim_cases`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_hub_receipts ON COMMIT DROP AS
      SELECT id AS sim_job_id,'signature'::text AS point_content_signature,id AS result_attempt_id FROM reclaim_cases`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
      SELECT id,id AS result_id,CASE WHEN variant='wrong-attempt-job' THEN md5('foreign')::uuid ELSE id END AS sim_job_id,
        id::text AS engine_job_id FROM reclaim_cases`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_archive_receipts ON COMMIT DROP AS
      SELECT id AS sim_job_id,'signature'::text AS point_content_signature,id AS brokered_upload_id,
        jsonb_build_object('receipt',jsonb_build_object('source',jsonb_build_object('promiseId',id::text),
          'remote',jsonb_build_object('generation','1','storedSha256','sha','storedByteSize',42))) AS receipt FROM reclaim_cases`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_remote_hub_binding_receipts ON COMMIT DROP AS
      SELECT id AS result_attempt_id,CASE WHEN variant='wrong-result' THEN md5('foreign')::uuid ELSE id END AS result_id,
        CASE WHEN variant='wrong-job' THEN md5('foreign')::uuid ELSE id END AS sim_job_id,
        CASE WHEN variant='wrong-upload' THEN md5('foreign')::uuid ELSE id END AS brokered_upload_id,
        CASE WHEN variant='wrong-promise' THEN md5('foreign')::uuid ELSE id END AS promise_id,
        CASE WHEN variant='pending' THEN 'pending' ELSE 'reclaimed' END AS reclaim_state,
        timestamptz '2026-01-01' AS reclaimed_at,42::bigint AS reclaimed_bytes,
        jsonb_build_object('engineJobId',CASE WHEN variant='wrong-source' THEN 'foreign' ELSE id::text END,
          'remote',CASE WHEN variant='missing-remote' THEN NULL::jsonb ELSE
          jsonb_build_object('generation',CASE WHEN variant='wrong-generation' THEN '2' ELSE '1' END,'storedSha256','sha','storedByteSize',42) END) AS receipt
      FROM reclaim_cases`);
    const before = await transaction.execute(
      sql`SELECT to_jsonb(receipt) AS value FROM sync_remote_hub_binding_receipts receipt ORDER BY result_attempt_id`,
    );
    expect(
      await reconcileCompletedProgressiveArchiveReclaims(
        transaction as unknown as DB,
      ),
    ).toBe(1);
    expect(
      await reconcileCompletedProgressiveArchiveReclaims(
        transaction as unknown as DB,
      ),
    ).toBe(0);
    const [settled] =
      await transaction.execute(sql`SELECT completed_at,reclaimed_bytes,claim_token,last_error
      FROM progressive_worker_archive_reclaims WHERE sim_job_id=md5('exact')::uuid`);
    expect(settled).toMatchObject({
      reclaimed_bytes: "0",
      claim_token: null,
      last_error: null,
    });
    expect(new Date(String(settled.completed_at)).toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(
      await transaction.execute(
        sql`SELECT to_jsonb(receipt) AS value FROM sync_remote_hub_binding_receipts receipt ORDER BY result_attempt_id`,
      ),
    ).toEqual(before);
    const [retained] = await transaction.execute(
      sql`SELECT count(*)::int AS count FROM progressive_worker_archive_reclaims WHERE completed_at IS NULL`,
    );
    expect(retained.count).toBe(10);
    const [original] = await transaction.execute(
      sql`SELECT reclaimed_bytes FROM progressive_worker_archive_reclaims WHERE sim_job_id=md5('already-complete')::uuid`,
    );
    expect(String(original.reclaimed_bytes)).toBe("123");
  });
});

it("keeps the oldest multi-report backlog selected after a bounded pass", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT md5('old-backlog')::uuid AS id,md5('campaign')::uuid AS campaign_id,
        NULL::text AS engine_job_id,'running'::text AS status,
        timestamptz '2026-10-01T02:00:00Z' AS "updatedAt",
        timestamptz '2026-10-01T01:00:00Z' AS "polledAt"
      UNION ALL
      SELECT md5('new-arrival-'||ordinal)::uuid,md5('campaign')::uuid,
        NULL::text,'running'::text,
        timestamptz '2026-10-01T02:00:00Z',timestamptz '2026-10-01T01:00:00Z'
      FROM generate_series(1,32) ordinal`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches ON COMMIT DROP AS
      SELECT id AS sim_job_id FROM sim_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_reports ON COMMIT DROP AS
      SELECT md5('old-backlog')::uuid AS sim_job_id,sequence,
        timestamptz '2026-10-01T00:00:00Z' + sequence * interval '1 second' AS received_at
      FROM generate_series(1,6) sequence
      UNION ALL
      SELECT md5('new-arrival-'||ordinal)::uuid,1,
        timestamptz '2026-10-02T00:00:00Z' + ordinal * interval '1 second'
      FROM generate_series(1,32) ordinal`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_progress_receipts (
      sim_job_id uuid,sequence bigint
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_report_inventories (
      sim_job_id uuid,sequence bigint
    ) ON COMMIT DROP`);
    const [oldJob] = await transaction.execute(
      sql`SELECT id FROM sim_jobs WHERE id=md5('old-backlog')::uuid`,
    );
    const first = await transaction.execute(progressiveReportJobsSql());
    expect(first).toHaveLength(33);
    expect(first[0].sim_job_id).toBe(oldJob.id);

    await transaction.execute(sql`INSERT INTO progressive_remote_progress_receipts
      SELECT md5('old-backlog')::uuid,sequence FROM generate_series(1,4) sequence`);
    await transaction.execute(sql`INSERT INTO progressive_remote_report_inventories
      SELECT md5('old-backlog')::uuid,sequence FROM generate_series(1,4) sequence`);
    await transaction.execute(sql`UPDATE sim_jobs SET "polledAt"=clock_timestamp()
      WHERE id=md5('old-backlog')::uuid`);

    const second = await transaction.execute(progressiveReportJobsSql());
    expect(second).toHaveLength(33);
    expect(second[0].sim_job_id).toBe(oldJob.id);
    expect(
      await transaction.execute(sql`SELECT min(received_at) AS received_at
        FROM progressive_remote_reports report
        WHERE report.sim_job_id=md5('old-backlog')::uuid
          AND NOT EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
            WHERE receipt.sim_job_id=report.sim_job_id AND receipt.sequence=report.sequence)
          AND NOT EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
            WHERE inventory.sim_job_id=report.sim_job_id AND inventory.sequence=report.sequence)`),
    ).toEqual([{ received_at: "2026-10-01 00:00:05+00" }]);
  });
});

it("prioritizes current unsubmitted remote reports before older running backlog", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT md5('old-running')::uuid AS id,md5('campaign')::uuid AS campaign_id,
        NULL::text AS engine_job_id,'running'::text AS status,
        timestamptz '2026-10-01T02:00:00Z' AS "updatedAt",
        timestamptz '2026-10-01T01:00:00Z' AS "polledAt"
      UNION ALL
      SELECT md5('new-pending')::uuid,md5('campaign')::uuid,
        NULL::text,'pending'::text,
        timestamptz '2026-10-02T02:00:00Z',timestamptz '2026-10-02T01:00:00Z'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches ON COMMIT DROP AS
      SELECT id AS sim_job_id FROM sim_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_reports ON COMMIT DROP AS
      SELECT md5('old-running')::uuid AS sim_job_id,1::bigint AS sequence,
        timestamptz '2026-10-01T00:00:00Z' AS received_at
      UNION ALL
      SELECT md5('new-pending')::uuid,1,
        timestamptz '2026-10-02T00:00:00Z'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_progress_receipts (
      sim_job_id uuid,sequence bigint
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_report_inventories (
      sim_job_id uuid,sequence bigint
    ) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO progressive_remote_progress_receipts
      VALUES (md5('retained')::uuid,1)`);
    await transaction.execute(sql`INSERT INTO progressive_remote_report_inventories
      VALUES (md5('retained')::uuid,1)`);

    const selected = await transaction.execute(progressiveReportJobsSql());

    expect(selected[0]?.sim_job_id).toBe(
      (
        await transaction.execute(
          sql`SELECT id FROM sim_jobs WHERE id=md5('new-pending')::uuid`,
        )
      )[0]?.id,
    );
  });
});

it("drains pending remote jobs carrying their own stopped execution identity first", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT md5('stopped-pending')::uuid AS id,md5('campaign')::uuid AS campaign_id,
        md5('stopped-pending')::text AS engine_job_id,'pending'::text AS status,
        timestamptz '2026-10-01T02:00:00Z' AS "updatedAt",
        timestamptz '2026-10-01T01:00:00Z' AS "polledAt"
      UNION ALL
      SELECT md5('active-running')::uuid,md5('campaign')::uuid,
        md5('active-running-engine')::text,'running'::text,
        timestamptz '2026-10-02T02:00:00Z',timestamptz '2026-10-02T01:00:00Z'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches ON COMMIT DROP AS
      SELECT id AS sim_job_id FROM sim_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_reports ON COMMIT DROP AS
      SELECT md5('stopped-pending')::uuid AS sim_job_id,1::bigint AS sequence,
        timestamptz '2026-10-01T00:00:00Z' AS received_at
      UNION ALL
      SELECT md5('active-running')::uuid,1,
        timestamptz '2026-10-02T00:00:00Z'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_progress_receipts (
      sim_job_id uuid,sequence bigint
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_report_inventories (
      sim_job_id uuid,sequence bigint
    ) ON COMMIT DROP`);

    const selected = await transaction.execute(progressiveReportJobsSql());

    expect(selected[0]?.sim_job_id).toBe(
      (
        await transaction.execute(
          sql`SELECT id FROM sim_jobs WHERE id=md5('stopped-pending')::uuid`,
        )
      )[0]?.id,
    );
  });
});

it("prioritizes active remote reports before terminal ingestion backlog", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT md5('old-terminal')::uuid AS id,md5('campaign')::uuid AS campaign_id,
        NULL::text AS engine_job_id,'ingesting'::text AS status,
        timestamptz '2026-10-01T02:00:00Z' AS "updatedAt",
        timestamptz '2026-10-01T01:00:00Z' AS "polledAt"
      UNION ALL
      SELECT md5('active-current')::uuid,md5('campaign')::uuid,
        md5('active-current-engine')::text,'running'::text,
        timestamptz '2026-10-02T02:00:00Z',timestamptz '2026-10-02T01:00:00Z'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches ON COMMIT DROP AS
      SELECT id AS sim_job_id FROM sim_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_reports ON COMMIT DROP AS
      SELECT md5('old-terminal')::uuid AS sim_job_id,1::bigint AS sequence,
        timestamptz '2026-10-01T00:00:00Z' AS received_at
      UNION ALL
      SELECT md5('active-current')::uuid,1,
        timestamptz '2026-10-02T00:00:00Z'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_progress_receipts (
      sim_job_id uuid,sequence bigint
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_report_inventories (
      sim_job_id uuid,sequence bigint
    ) ON COMMIT DROP`);

    const selected = await transaction.execute(progressiveReportJobsSql());

    expect(selected[0]?.sim_job_id).toBe(
      (
        await transaction.execute(
          sql`SELECT id FROM sim_jobs WHERE id=md5('active-current')::uuid`,
        )
      )[0]?.id,
    );
  });
});

it.each([
  { reportCount: 1, activeCount: 12 },
  { reportCount: 120, activeCount: 12 },
  { reportCount: 1, activeCount: 80 },
  { reportCount: 120, activeCount: 80 },
])("reserves a bounded terminal lane with $activeCount active jobs and $reportCount reports each", async ({ reportCount, activeCount }) => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT md5('active-' || ordinal)::uuid AS id, md5('campaign')::uuid AS campaign_id,
        md5('active-engine-' || ordinal)::text AS engine_job_id, 'running'::text AS status,
        clock_timestamp() AS "updatedAt", clock_timestamp() AS "polledAt",
        'running'::text AS engine_state
      FROM generate_series(1, ${activeCount}) ordinal
      UNION ALL
      SELECT md5('terminal-' || ordinal)::uuid, md5('campaign')::uuid,
        md5('terminal-' || ordinal)::text, 'cancelled'::text,
        clock_timestamp() - interval '1 hour', clock_timestamp() - interval '1 hour',
        'cancelled'::text
      FROM generate_series(1, 5) ordinal`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches ON COMMIT DROP AS
      SELECT id AS sim_job_id FROM sim_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_reports ON COMMIT DROP AS
      SELECT job.id AS sim_job_id, sequence, clock_timestamp() -
        CASE WHEN job.status = 'cancelled' THEN interval '1 hour' ELSE interval '1 minute' END AS received_at
      FROM sim_jobs job CROSS JOIN generate_series(1, ${reportCount}) sequence`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_progress_receipts (
      sim_job_id uuid, sequence bigint
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_report_inventories (
      sim_job_id uuid, sequence bigint
    ) ON COMMIT DROP`);

    const selected = await transaction.execute(progressiveReportJobsSql());
    const activeIds = new Set(
      (await transaction.execute(sql`SELECT id FROM sim_jobs WHERE status = 'running'`)).map(
        (row) => row.id,
      ),
    );
    const terminalIds = new Set(
      (await transaction.execute(sql`SELECT id FROM sim_jobs WHERE status = 'cancelled'`)).map(
        (row) => row.id,
      ),
    );

    expect(selected).toHaveLength(Math.min(activeCount + 5, 64));
    expect(selected.slice(0, 6).every((row) => activeIds.has(row.sim_job_id))).toBe(true);
    expect(selected.slice(6, 8).every((row) => terminalIds.has(row.sim_job_id))).toBe(true);
    expect(selected.slice(0, 8).some((row) => terminalIds.has(row.sim_job_id))).toBe(true);
    if (activeCount + 5 <= 64) expect(selected).toEqual(
      expect.arrayContaining(
        [...terminalIds].map((sim_job_id) => ({
          sim_job_id,
          campaign_id: selected[0].campaign_id,
        })),
      ),
    );
    await transaction.execute(sql`INSERT INTO progressive_remote_progress_receipts
      SELECT report.sim_job_id,report.sequence FROM progressive_remote_reports report
      JOIN sim_jobs job ON job.id=report.sim_job_id WHERE job.status='cancelled'`);
    await transaction.execute(sql`INSERT INTO progressive_remote_report_inventories
      SELECT report.sim_job_id,report.sequence FROM progressive_remote_reports report
      JOIN sim_jobs job ON job.id=report.sim_job_id WHERE job.status='cancelled'`);
    const activeOnly = await transaction.execute(progressiveReportJobsSql());
    expect(activeOnly).toHaveLength(Math.min(activeCount, 64));
    expect(activeOnly.slice(0, 8).every((row) => activeIds.has(row.sim_job_id))).toBe(true);
    expect(activeOnly.some((row) => terminalIds.has(row.sim_job_id))).toBe(false);
  });
});

it("selects closed terminal jobs with retained evidence for classification settlement", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_storage_jobs ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['retained','unretained','stored-closed',
        'stored-closed-2','stored-high','stored-inactive','stored-live-ingest','stored-indefinite-ingest',
        'stored-ingested','stored-pending','stored-running','stored-no-stop','stored-wrong-stop','stored-live-proof',
        'stored-unretained','stored-no-archive','stored-unapplied','stored-wrong-dispatch','stored-foreign-request']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_campaigns ON COMMIT DROP AS
      SELECT md5('campaign')::uuid AS id,'active'::text AS status`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,md5('campaign')::uuid AS campaign_id,id::text AS engine_job_id,
        CASE WHEN variant='stored-pending' THEN 'pending' WHEN variant='stored-running' THEN 'running'
          WHEN variant LIKE 'stored-%' THEN 'cancelled' ELSE 'done' END AS status,'completed'::text AS engine_state,
        CASE WHEN variant='stored-ingested' THEN clock_timestamp() END AS "ingestedAt",
        CASE WHEN variant IN ('stored-live-ingest','stored-indefinite-ingest') THEN 'current-ingestion-owner' END AS ingest_lease_token,
        CASE WHEN variant='stored-live-ingest' THEN clock_timestamp()+interval '1 hour' END AS ingest_lease_expires_at,
        jsonb_build_object('progressive',jsonb_build_object('executionId',id),'engineRequest','{}'::jsonb) AS request_payload,
        clock_timestamp()-interval '1 hour' AS "updatedAt",
        clock_timestamp()-interval '1 hour' AS "polledAt"
      FROM fixture_storage_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches ON COMMIT DROP AS
      SELECT id AS sim_job_id,id AS promise_id,id AS solver_id,
        jsonb_build_object('solverId',id,'promiseId',id,'scope',request_payload->'progressive','request','{}'::jsonb) AS envelope
      FROM sim_jobs`);
    await transaction.execute(sql`UPDATE progressive_remote_dispatches SET envelope=jsonb_set(envelope,'{solverId}','"foreign"'::jsonb)
      WHERE sim_job_id=md5('stored-wrong-dispatch')::uuid`);
    await transaction.execute(sql`UPDATE sim_jobs SET request_payload=jsonb_set(request_payload,'{engineRequest}','{"foreign":true}'::jsonb)
      WHERE id=md5('stored-foreign-request')::uuid`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,'expired'::text AS status FROM sim_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,1::bigint AS sequence,clock_timestamp() AS received_at FROM sim_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_progress_receipts (
      sim_job_id uuid,sequence bigint
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_report_inventories (
      sim_job_id uuid,sequence bigint
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_evidence_receipts (
      sim_job_id uuid,storage_only boolean,point_content_signature text,result_attempt_id uuid
    ) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO progressive_remote_progress_receipts
      SELECT id,1 FROM fixture_storage_jobs WHERE variant NOT IN ('unretained','stored-unapplied')`);
    await transaction.execute(sql`INSERT INTO progressive_remote_report_inventories
      SELECT id,1 FROM fixture_storage_jobs WHERE variant<>'unretained'`);
    await transaction.execute(sql`INSERT INTO progressive_remote_evidence_receipts
      SELECT id,variant LIKE 'stored-%','physical',md5(variant||'-attempt')::uuid
      FROM fixture_storage_jobs WHERE variant<>'unretained'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_report_sources ON COMMIT DROP AS
      SELECT id AS sim_job_id,'physical'::text AS point_content_signature FROM fixture_storage_jobs
      UNION ALL SELECT id,'diagnostic' FROM fixture_storage_jobs WHERE variant LIKE 'stored-%'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_diagnostic_receipts ON COMMIT DROP AS
      SELECT id AS sim_job_id,'diagnostic'::text AS point_content_signature FROM fixture_storage_jobs
      WHERE variant LIKE 'stored-%' AND variant<>'stored-unretained'`);
    await transaction.execute(sql`CREATE TEMP TABLE solver_evidence_archives ON COMMIT DROP AS
      SELECT md5(variant||'-attempt')::uuid AS result_attempt_id,'current'::text AS state
      FROM fixture_storage_jobs WHERE variant<>'stored-no-archive'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_stops (
      sim_job_id uuid,engine_job_id text,proof jsonb
    ) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_execution_stops
      SELECT id,id::text,jsonb_build_object('job_id',CASE WHEN variant='stored-wrong-stop' THEN 'foreign' ELSE id::text END,
        'execution_stopped',true,'producer_stopped',variant<>'stored-live-proof','namespace_verified',true,'remaining','[]'::jsonb)
      FROM fixture_storage_jobs WHERE variant<>'stored-no-stop'`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts (
      id uuid,result_id uuid,sim_job_id uuid,status text,valid_for_polar boolean
    ) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO result_attempts
      VALUES (md5('retained-attempt')::uuid,md5('retained-result')::uuid,md5('retained')::uuid,'done',true),
        (md5('unretained-attempt')::uuid,md5('unretained-result')::uuid,md5('unretained')::uuid,'done',true)`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_attempts (
      token uuid,sim_job_id uuid,outcome text,unit_id uuid,started_at timestamptz
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_units (
      id uuid,work_id uuid,state text,lease_token uuid,lease_until timestamptz
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_work (
      id uuid,generation_id uuid,target_id uuid
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_generation_cohort_targets (
      generation_id uuid,target_id uuid,cohort text
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE results (
      id uuid,current_result_attempt_id uuid,sim_job_id uuid
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE result_classifications (
      result_attempt_id uuid,state text
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE result_review_verdicts (
      id uuid,result_id uuid,verdict text,"revokedAt" timestamptz,"createdAt" timestamptz
    ) ON COMMIT DROP`);
    const beforePlan = await transaction.execute(sql`EXPLAIN (FORMAT JSON) ${progressiveSettlementJobsSql()}`);
    await analyzeSelectionFixture(transaction);
    const afterPlan = await transaction.execute(sql`EXPLAIN (FORMAT JSON) ${progressiveSettlementJobsSql()}`);
    console.info("settlement-fixture-plans", JSON.stringify([beforePlan,afterPlan].map((rows) => {
      const [plan] = rows[0]["QUERY PLAN"] as Array<{ Plan: { "Total Cost": number }; JIT?: unknown }>;
      return { cost: plan.Plan["Total Cost"], jit: plan.JIT ?? null };
    })));
    // Success restores both possible caller settings, including a nested
    // savepoint; a release of that savepoint alone would leak SET LOCAL.
    for (const jit of ["on", "off"]) {
      await transaction.execute(sql`SELECT set_config('jit', ${jit}, true)`);
      await selectSettlementJobs(transaction);
    }
    await transaction.execute(sql`SET LOCAL jit = on`);
    await transaction.execute(sql`ALTER TABLE pg_temp.sim_jobs RENAME COLUMN engine_state TO unavailable_column`);
    await expect(selectProgressiveRemoteProgressJobs(transaction as unknown as DB)).rejects.toThrow();
    expect(await transaction.execute(sql`SHOW jit`)).toMatchObject([{ jit: "on" }]);
    await transaction.execute(sql`ALTER TABLE pg_temp.sim_jobs RENAME COLUMN unavailable_column TO engine_state`);
    const selected = await selectSettlementJobs(transaction);
    const [{ id: retainedId }, { id: unretainedId }] =
      await transaction.execute(
        sql`SELECT md5('retained')::uuid AS id UNION ALL SELECT md5('unretained')::uuid AS id`,
      );
    expect(selected.map((row) => row.sim_job_id)).toContain(
      retainedId,
    );
    expect(selected.map((row) => row.sim_job_id)).not.toContain(
      unretainedId,
    );
    const variants = await transaction.execute(sql`SELECT variant FROM fixture_storage_jobs
      WHERE id IN (${sql.join(selected.map((row) => sql`${row.sim_job_id}::uuid`), sql`, `)}) ORDER BY variant`);
    expect(variants.map((row) => row.variant)).toEqual(["retained", "stored-closed", "stored-closed-2", "stored-high", "stored-inactive"]);
    await transaction.execute(sql`UPDATE sim_jobs SET "ingestedAt"=clock_timestamp() WHERE id=md5('stored-closed')::uuid`);
    const [closed] = await transaction.execute(sql`SELECT id FROM fixture_storage_jobs WHERE variant='stored-closed'`);
    expect(await selectSettlementJobs(transaction, [String(closed.id)])).toEqual([]);
    await transaction.execute(sql`UPDATE sim_jobs SET "ingestedAt"=NULL WHERE id=md5('stored-closed')::uuid`);
    await transaction.execute(sql`INSERT INTO sim_jobs(id,campaign_id,engine_job_id,status,engine_state,"updatedAt","polledAt",request_payload)
      SELECT md5('unfinished-'||ordinal)::uuid,md5('campaign')::uuid,md5('unfinished-'||ordinal),
        'ingesting','failed',timestamptz '2020-01-01',timestamptz '2020-01-01','{}'::jsonb
      FROM generate_series(1,160) ordinal`);
    await transaction.execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,envelope)
      SELECT id,id,id,'{}'::jsonb FROM sim_jobs WHERE status='ingesting'`);
    await transaction.execute(sql`INSERT INTO sync_sweep_promises SELECT id,'active' FROM sim_jobs WHERE status='ingesting'`);
    await transaction.execute(sql`INSERT INTO sim_campaigns VALUES (md5('inactive-campaign')::uuid,'complete')`);
    await transaction.execute(sql`UPDATE sim_jobs SET campaign_id=md5('inactive-campaign')::uuid WHERE id=md5('stored-inactive')::uuid`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_units(id,work_id) SELECT id,id FROM sim_jobs`);
    await transaction.execute(sql`INSERT INTO progressive_work SELECT id,md5('generation')::uuid,id FROM sim_jobs`);
    await transaction.execute(sql`INSERT INTO progressive_generation_cohort_targets
      SELECT md5('generation')::uuid,id,CASE WHEN id=md5('stored-high')::uuid THEN 'high' ELSE 'low' END FROM sim_jobs`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_attempts(token,sim_job_id,outcome,unit_id,started_at)
      SELECT id,id,'failed',id,timestamptz '2020-01-01' FROM sim_jobs`);
    await analyzeSelectionFixture(transaction);
    const readyRows = await transaction.execute(sql`SELECT id FROM fixture_storage_jobs WHERE variant IN ('stored-closed','stored-closed-2')`);
    const readyIds = readyRows.map((row) => String(row.id));
    const unfinishedRows = await transaction.execute(sql`SELECT id FROM sim_jobs WHERE status='ingesting' ORDER BY id`);
    const unfinishedIds = new Set(unfinishedRows.map((row) => String(row.id)));
    for (let pass = 0; pass < 2; pass += 1) {
      const selected = await selectSettlementJobs(transaction);
      const selectedIds = selected.map((row) => String(row.sim_job_id));
      expect(selected).toHaveLength(128);
      expect(new Set(selectedIds).size).toBe(128);
      expect(selectedIds.slice(0,6).every((id) => unfinishedIds.has(id))).toBe(true);
      expect(selectedIds.slice(6,8).sort()).toEqual([...readyIds].sort());
      expect(selectedIds.every((id) => unfinishedIds.has(id) || readyIds.includes(id))).toBe(true);
      expect(selectedIds.slice(0,32).filter((id) => readyIds.includes(id))).toHaveLength(2);
      await transaction.execute(sql`UPDATE sim_jobs SET "polledAt"=clock_timestamp()
        WHERE id IN (${sql.join(selectedIds.slice(0,8).map((id) => sql`${id}::uuid`),sql`,`)})`);
    }
    const [high] = await transaction.execute(sql`SELECT id FROM fixture_storage_jobs WHERE variant='stored-high'`);
    const lowerCohortIds = [...unfinishedIds].slice(0,9);
    const mixedCohorts = await selectSettlementJobs(transaction, [...lowerCohortIds,String(high.id)]);
    expect(mixedCohorts.slice(0,9).every((row) => lowerCohortIds.includes(String(row.sim_job_id)))).toBe(true);
    expect(mixedCohorts[9].sim_job_id).toBe(high.id);
    const [inactive] = await transaction.execute(sql`SELECT id FROM fixture_storage_jobs WHERE variant='stored-inactive'`);
    const mixedCampaigns = await selectSettlementJobs(transaction, [...lowerCohortIds,String(inactive.id)]);
    expect(mixedCampaigns.slice(0,9).every((row) => lowerCohortIds.includes(String(row.sim_job_id)))).toBe(true);
    expect(mixedCampaigns[9].sim_job_id).toBe(inactive.id);
    const oneReady = await selectSettlementJobs(transaction, [...unfinishedIds,readyIds[0]]);
    expect(oneReady.slice(0,8).filter((row) => row.sim_job_id===readyIds[0])).toHaveLength(1);
    expect(oneReady.slice(0,8).filter((row) => unfinishedIds.has(String(row.sim_job_id)))).toHaveLength(7);
    await transaction.execute(sql`UPDATE sim_jobs SET "ingestedAt"=clock_timestamp()
      WHERE id IN (${sql.join(readyIds.map((id) => sql`${id}::uuid`),sql`,`)})`);
    const noneReady = await selectSettlementJobs(transaction, [...unfinishedIds,...readyIds]);
    expect(noneReady).toHaveLength(128);
    expect(noneReady.every((row) => unfinishedIds.has(String(row.sim_job_id)))).toBe(true);
    await transaction.execute(sql`SET LOCAL jit = off`);
    // Closed history is not a bounded candidate prefix: new evidence can arrive
    // behind any number of older, already-ingested jobs.
    await transaction.execute(sql`INSERT INTO sim_jobs(id,campaign_id,engine_job_id,status,engine_state,
      "ingestedAt","updatedAt","polledAt",request_payload)
      SELECT md5('history-'||ordinal)::uuid,md5('campaign')::uuid,md5('history-'||ordinal),
        'done','completed',timestamptz '2020-01-01',timestamptz '2020-01-01',
        timestamptz '2020-01-01'+ordinal*interval '1 second','{}'::jsonb
      FROM generate_series(1,1024) ordinal`);
    await transaction.execute(sql`INSERT INTO progressive_remote_dispatches(sim_job_id,promise_id,solver_id,envelope)
      SELECT md5('history-'||ordinal)::uuid,md5('history-'||ordinal)::uuid,
        md5('history-'||ordinal)::uuid,'{}'::jsonb FROM generate_series(1,1024) ordinal`);
    await transaction.execute(sql`INSERT INTO sync_sweep_promises
      SELECT md5('history-'||ordinal)::uuid,'expired' FROM generate_series(1,1024) ordinal`);
    await analyzeSelectionFixture(transaction);
    const history =
      await transaction.execute(sql`SELECT md5('history-'||ordinal)::uuid AS id
      FROM generate_series(1,1024) ordinal`);
    const historyIds = history.map((row) => String(row.id));
    expect(await selectSettlementJobs(transaction, historyIds)).toEqual([]);
    const lateId = historyIds[1023];
    await transaction.execute(
      sql`INSERT INTO progressive_cfd_execution_stops(sim_job_id) VALUES (${lateId}::uuid)`,
    );
    await transaction.execute(sql`INSERT INTO result_attempts(id,result_id,sim_job_id,status,valid_for_polar)
      VALUES (md5('late-attempt')::uuid,md5('late-result')::uuid,${lateId}::uuid,'done',false)`);
    await transaction.execute(sql`INSERT INTO progressive_remote_evidence_receipts(sim_job_id,storage_only)
      VALUES (${lateId}::uuid,false)`);
    expect(await selectSettlementJobs(transaction, historyIds)).toEqual([
      { sim_job_id: lateId, campaign_id: String(selected[0].campaign_id) },
    ]);
    await transaction.execute(sql`INSERT INTO progressive_remote_reports(sim_job_id,sequence,received_at)
      VALUES (${lateId}::uuid,2,clock_timestamp()-interval '2 hours')`);
    expect(await selectSettlementJobs(transaction, historyIds)).toEqual([]);
    await transaction.execute(
      sql`INSERT INTO progressive_remote_progress_receipts VALUES (${lateId}::uuid,2)`,
    );
    expect(await selectSettlementJobs(transaction, historyIds)).toEqual([]);
    await transaction.execute(
      sql`INSERT INTO progressive_remote_report_inventories VALUES (${lateId}::uuid,2)`,
    );
    expect(
      (await selectSettlementJobs(transaction, historyIds)).map(
        (row) => row.sim_job_id,
      ),
    ).toEqual([lateId]);
  });
}, 30_000);

it("settles fulfilled and active jobs fairly while expired work keeps arriving", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_settlement_jobs ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['fulfilled','active','unapplied','unindexed','executing','not-dispatched',
        'stopped-running','stopped-terminal','done-active','done-closed','done-closed-pointer-gap','done-closed-evidence']) variant
      UNION ALL SELECT md5('expired-'||ordinal)::uuid,'expired-'||ordinal FROM generate_series(1,160) ordinal
      UNION ALL SELECT md5('report-unapplied-'||ordinal)::uuid,'report-unapplied-'||ordinal FROM generate_series(1,24) ordinal
      UNION ALL SELECT md5('report-unindexed-'||ordinal)::uuid,'report-unindexed-'||ordinal FROM generate_series(1,24) ordinal`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_campaigns ON COMMIT DROP AS
      SELECT md5('campaign')::uuid AS id,'active'::text AS status`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,md5('campaign')::uuid AS campaign_id,
        NULL::text AS engine_job_id,NULL::timestamptz AS "ingestedAt",'{}'::jsonb AS request_payload,
        NULL::text AS ingest_lease_token,NULL::timestamptz AS ingest_lease_expires_at,
        CASE WHEN variant IN ('executing','stopped-running') THEN 'running'
          WHEN variant IN ('stopped-terminal','done-active','done-closed','done-closed-pointer-gap','done-closed-evidence') THEN 'done' ELSE 'ingesting' END AS status,
        CASE WHEN variant IN ('executing','stopped-running') THEN 'running' ELSE 'completed' END AS engine_state,
        clock_timestamp()-interval '2 days' AS "updatedAt",
        CASE WHEN variant<>'report-unapplied-1' THEN clock_timestamp()-CASE WHEN variant='fulfilled' THEN interval '1 day' ELSE interval '1 hour' END END AS "polledAt"
      FROM fixture_settlement_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE results ON COMMIT DROP AS
      SELECT md5('result-'||variant)::uuid AS id,NULL::uuid AS current_result_attempt_id
      FROM fixture_settlement_jobs WHERE variant IN ('done-closed-pointer-gap','done-closed-evidence')`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
      SELECT md5('attempt-'||variant)::uuid AS id,md5('result-'||variant)::uuid AS result_id,
        id AS sim_job_id,'done'::text AS status,true AS valid_for_polar
      FROM fixture_settlement_jobs WHERE variant IN ('done-closed-pointer-gap','done-closed-evidence')`);
    await transaction.execute(sql`CREATE TEMP TABLE result_classifications ON COMMIT DROP AS
      SELECT md5('attempt-'||variant)::uuid AS result_attempt_id,'accepted'::text AS state
      FROM fixture_settlement_jobs WHERE variant IN ('done-closed-pointer-gap','done-closed-evidence')`);
    await transaction.execute(sql`CREATE TEMP TABLE result_review_verdicts (
      id uuid, result_id uuid, verdict text, "revokedAt" timestamptz, "createdAt" timestamptz
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches ON COMMIT DROP AS
      SELECT id AS sim_job_id,id AS promise_id,id AS solver_id,'{}'::jsonb AS envelope
      FROM fixture_settlement_jobs WHERE variant<>'not-dispatched'`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant LIKE 'expired-%' THEN 'expired'
        WHEN variant IN ('fulfilled','stopped-terminal','done-closed') THEN 'fulfilled'
        WHEN variant IN ('done-closed-pointer-gap','done-closed-evidence') THEN 'expired' ELSE 'active' END AS status
      FROM fixture_settlement_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,1 AS sequence,
        CASE WHEN variant='report-unapplied-1' THEN timestamptz '2026-01-01T00:00:00Z'
          WHEN variant LIKE 'report-unapplied-%' THEN timestamptz '2026-01-02T00:00:00Z'
          ELSE timestamptz '2026-01-03T00:00:00Z' END AS received_at
      FROM fixture_settlement_jobs`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_progress_receipts ON COMMIT DROP AS
      SELECT id AS sim_job_id,1 AS sequence FROM fixture_settlement_jobs
      WHERE variant NOT IN ('unapplied','not-dispatched') AND variant NOT LIKE 'report-unapplied-%'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_report_inventories ON COMMIT DROP AS
      SELECT id AS sim_job_id,1 AS sequence FROM fixture_settlement_jobs
      WHERE variant<>'unindexed' AND variant NOT LIKE 'report-unindexed-%'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_remote_evidence_receipts (
      sim_job_id uuid,sequence bigint,point_content_signature text,result_attempt_id uuid,
      remote_result_id uuid,remote_result_attempt_id uuid,received_at timestamptz,storage_only boolean
    ) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO progressive_remote_evidence_receipts
      SELECT md5('done-closed-evidence')::uuid,1,'signature',md5('attempt-done-closed-evidence')::uuid,
        md5('result-done-closed-evidence')::uuid,md5('attempt-done-closed-evidence')::uuid,clock_timestamp(),false`);
    await transaction.execute(
      sql`CREATE TEMP TABLE progressive_cfd_execution_stops (sim_job_id uuid,engine_job_id text,proof jsonb) ON COMMIT DROP`,
    );
    await transaction.execute(
      sql`CREATE TEMP TABLE progressive_cfd_units (id uuid,work_id uuid,state text,lease_token uuid,lease_until timestamptz) ON COMMIT DROP`,
    );
    await transaction.execute(
      sql`CREATE TEMP TABLE progressive_work (id uuid,generation_id uuid,target_id uuid) ON COMMIT DROP`,
    );
    await transaction.execute(
      sql`CREATE TEMP TABLE progressive_generation_cohort_targets (generation_id uuid,target_id uuid,cohort text) ON COMMIT DROP`,
    );
    await transaction.execute(
      sql`CREATE TEMP TABLE progressive_cfd_attempts (token uuid,sim_job_id uuid,outcome text,unit_id uuid,started_at timestamptz) ON COMMIT DROP`,
    );
    await transaction.execute(sql`INSERT INTO progressive_cfd_units
      SELECT id,id,
        CASE WHEN variant IN ('done-closed-pointer-gap','done-closed-evidence') THEN 'leased' END,
        CASE WHEN variant IN ('done-closed-pointer-gap','done-closed-evidence') THEN md5('attempt-'||variant)::uuid END,
        CASE WHEN variant IN ('done-closed-pointer-gap','done-closed-evidence') THEN clock_timestamp()-interval '1 hour' END
      FROM fixture_settlement_jobs`);
    await transaction.execute(sql`INSERT INTO progressive_work
      SELECT id,md5('generation')::uuid,id FROM fixture_settlement_jobs`);
    await transaction.execute(sql`INSERT INTO progressive_generation_cohort_targets
      SELECT md5('generation')::uuid,id,
        'high'
      FROM fixture_settlement_jobs`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_execution_stops
      SELECT id,NULL::text,NULL::jsonb FROM fixture_settlement_jobs WHERE variant IN ('stopped-running','stopped-terminal','done-closed-pointer-gap','done-closed-evidence')`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_attempts
      SELECT md5('attempt-'||variant)::uuid,id,
        CASE WHEN variant='stopped-terminal' THEN 'complete'
          WHEN variant IN ('done-closed-pointer-gap','done-closed-evidence') THEN 'cancelled' ELSE 'running' END,
        id,clock_timestamp()-interval '2 hours'
      FROM fixture_settlement_jobs
      WHERE variant IN ('executing','stopped-running','stopped-terminal','done-closed-pointer-gap','done-closed-evidence')`);
    const expectedReports = () =>
      transaction.execute(sql`SELECT job.id AS sim_job_id,job.campaign_id
        FROM sim_jobs job JOIN fixture_settlement_jobs fixture ON fixture.id=job.id
        LEFT JOIN LATERAL (
          SELECT min(report.received_at) AS received_at
          FROM progressive_remote_reports report
          WHERE report.sim_job_id = job.id
            AND (NOT EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
              WHERE receipt.sim_job_id = report.sim_job_id AND receipt.sequence = report.sequence)
              OR NOT EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
                WHERE inventory.sim_job_id = report.sim_job_id AND inventory.sequence = report.sequence))
        ) oldest ON true
        WHERE (fixture.variant IN ('unapplied','unindexed') OR fixture.variant LIKE 'report-%')
          AND (oldest.received_at IS NOT NULL OR (
            job.engine_job_id IS NULL AND job.status = 'pending'
            AND EXISTS (SELECT 1 FROM progressive_remote_reports indexed_report
              WHERE indexed_report.sim_job_id=job.id
                AND EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
                  WHERE receipt.sim_job_id=indexed_report.sim_job_id AND receipt.sequence=indexed_report.sequence)
                AND EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
                  WHERE inventory.sim_job_id=indexed_report.sim_job_id AND inventory.sequence=indexed_report.sequence))))
        ORDER BY oldest.received_at NULLS LAST, coalesce(job."polledAt",job."updatedAt"),job.id`);
    const expectedSettlements = () =>
      transaction.execute(sql`SELECT job.id AS sim_job_id,job.campaign_id
        FROM sim_jobs job JOIN fixture_settlement_jobs fixture ON fixture.id=job.id
        LEFT JOIN LATERAL (
          SELECT CASE WHEN bool_or(member.cohort = 'low') THEN 0 ELSE 1 END AS priority
          FROM progressive_cfd_attempts attempt
          JOIN progressive_cfd_units unit ON unit.id = attempt.unit_id
          JOIN progressive_work work ON work.id = unit.work_id
          JOIN progressive_generation_cohort_targets member
            ON member.generation_id = work.generation_id AND member.target_id = work.target_id
          WHERE attempt.sim_job_id = job.id
        ) cohort_priority ON true
        WHERE fixture.variant IN ('fulfilled','active','stopped-running','done-active','done-closed-pointer-gap','done-closed-evidence') OR fixture.variant LIKE 'expired-%'
        ORDER BY coalesce(cohort_priority.priority, 1),
          CASE WHEN fixture.variant IN ('stopped-running','done-active','done-closed-pointer-gap','done-closed-evidence') THEN 1 ELSE 0 END,
          coalesce(job."polledAt",job."updatedAt"),job.id`);
    const jobStates = await transaction.execute(
      sql`SELECT id,status,engine_state FROM sim_jobs ORDER BY id`,
    );
    const [fulfilled] = await transaction.execute(
      sql`SELECT id FROM fixture_settlement_jobs WHERE variant='fulfilled'`,
    );
    await analyzeSelectionFixture(transaction);
    const allReports = await expectedReports();
    const allSettlements = await expectedSettlements();
    expect(allReports).toHaveLength(50);
    expect(allSettlements).toHaveLength(166);
    const reports = await transaction.execute(progressiveReportJobsSql());
    expect(reports).toHaveLength(50);
    expect(reports).toEqual(allReports);
    const [oldestReport] = await transaction.execute(
      sql`SELECT id FROM fixture_settlement_jobs WHERE variant='report-unapplied-1'`,
    );
    expect(reports[0].sim_job_id).toBe(oldestReport.id);
    const first = await selectSettlementJobs(transaction);
    expect(first).toHaveLength(128);
    expect(first).toEqual(allSettlements.slice(0, 128));
    expect(first[0].sim_job_id).toBe(fulfilled.id);
    expect(
      first.some((row) =>
        reports.some((report) => report.sim_job_id === row.sim_job_id),
      ),
    ).toBe(false);
    const explicitRows =
      await transaction.execute(sql`SELECT id FROM fixture_settlement_jobs
      WHERE variant IN ('fulfilled','unapplied','unindexed','executing','not-dispatched',
        'stopped-running','stopped-terminal','done-active','done-closed','done-closed-pointer-gap','done-closed-evidence') ORDER BY id`);
    const explicitIds = explicitRows.map((row) => String(row.id));
    for (const [selector, eligible] of [
      [progressiveReportJobsSql, allReports],
      [progressiveSettlementJobsSql, allSettlements],
    ] as const) {
      expect(await transaction.execute(selector(explicitIds))).toEqual(
        eligible.filter((row) => explicitIds.includes(String(row.sim_job_id))),
      );
      if (selector === progressiveSettlementJobsSql) {
        await selectSettlementJobs(transaction, explicitIds);
        await selectSettlementJobs(transaction, []);
        await selectSettlementJobs(transaction, [
          "00000000-0000-4000-8000-000000000001",
        ]);
      }
      expect(await transaction.execute(selector([]))).toEqual([]);
      expect(
        await transaction.execute(
          selector(["00000000-0000-4000-8000-000000000001"]),
        ),
      ).toEqual([]);
    }
    for (const selected of [first, reports])
      await transaction.execute(sql`UPDATE sim_jobs SET "polledAt"=clock_timestamp()
        WHERE id IN (${sql.join(
          selected.map((row) => sql`${row.sim_job_id}::uuid`),
          sql`,`,
        )})`);
    for (const reportJob of reports) {
      await transaction.execute(sql`INSERT INTO progressive_remote_progress_receipts(sim_job_id,sequence)
        SELECT report.sim_job_id,report.sequence
        FROM progressive_remote_reports report
        WHERE report.sim_job_id=${reportJob.sim_job_id}::uuid
          AND report.sequence <= 4
          AND NOT EXISTS (SELECT 1 FROM progressive_remote_progress_receipts receipt
            WHERE receipt.sim_job_id=report.sim_job_id AND receipt.sequence=report.sequence)`);
      await transaction.execute(sql`INSERT INTO progressive_remote_report_inventories(sim_job_id,sequence)
        SELECT report.sim_job_id,report.sequence
        FROM progressive_remote_reports report
        WHERE report.sim_job_id=${reportJob.sim_job_id}::uuid
          AND report.sequence <= 4
          AND NOT EXISTS (SELECT 1 FROM progressive_remote_report_inventories inventory
            WHERE inventory.sim_job_id=report.sim_job_id AND inventory.sequence=report.sequence)`);
    }
    const second = await selectSettlementJobs(transaction);
    expect(second).toHaveLength(128);
    expect(second).toEqual((await expectedSettlements()).slice(0, 128));
    const visited = new Set([...first, ...second].map((row) => row.sim_job_id));
    const terminalRows =
      await transaction.execute(sql`SELECT id FROM fixture_settlement_jobs
      WHERE variant IN ('fulfilled','active') OR variant LIKE 'expired-%'`);
    expect([...visited].sort()).toEqual(
      terminalRows.map((row) => row.id).sort(),
    );
    expect(visited.size).toBe(162);
    const drained = new Error("Restore completed high-priority ingestion fixture");
    await transaction.transaction(async (nested) => {
      await nested.execute(sql`UPDATE sim_jobs job SET status='done'
        FROM fixture_settlement_jobs fixture WHERE fixture.id=job.id
          AND (fixture.variant IN ('fulfilled','active') OR fixture.variant LIKE 'expired-%')`);
      await nested.execute(sql`UPDATE sync_sweep_promises SET status='fulfilled' WHERE id=md5('active')::uuid`);
      const remaining = await selectSettlementJobs(nested);
      const expectedRemaining = await nested.execute(sql`SELECT id AS sim_job_id FROM fixture_settlement_jobs
        WHERE variant IN ('stopped-running','done-active','done-closed-pointer-gap','done-closed-evidence','unapplied','unindexed')
          OR variant LIKE 'report-%' ORDER BY id`);
      expect(remaining.map((row) => row.sim_job_id).sort()).toEqual(expectedRemaining.map((row) => row.sim_job_id));
      throw drained;
    }).catch((error) => { if (error !== drained) throw error; });
    const nextReports = await transaction.execute(progressiveReportJobsSql());
    expect(nextReports).toHaveLength(allReports.length - reports.length);
    expect(nextReports).toEqual(await expectedReports());
    const visitedReports = new Set(
      [...reports, ...nextReports].map((row) => row.sim_job_id),
    );
    expect([...visitedReports].sort()).toEqual(
      allReports.map((row) => row.sim_job_id).sort(),
    );
    const excluded =
      await transaction.execute(sql`SELECT id FROM fixture_settlement_jobs
      WHERE variant IN ('unapplied','unindexed','executing','not-dispatched','stopped-terminal','done-closed')
        OR variant LIKE 'report-%'`);
    for (const row of excluded) expect(visited.has(row.id)).toBe(false);
    expect(
      await transaction.execute(
        progressiveSettlementJobsSql([String(fulfilled.id)]),
      ),
    ).toEqual([
      { sim_job_id: fulfilled.id, campaign_id: first[0].campaign_id },
    ]);
    expect(
      await transaction.execute(
        progressiveReportJobsSql([String(fulfilled.id)]),
      ),
    ).toEqual([]);
    expect(
      await transaction.execute(
        sql`SELECT id,status,engine_state FROM sim_jobs ORDER BY id`,
      ),
    ).toEqual(jobStates);

    const [stopped] = await transaction.execute(
      sql`SELECT id FROM fixture_settlement_jobs WHERE variant='stopped-running'`,
    );
    for (const status of [
      "pending",
      "submitted",
      "running",
      "ingesting",
      "done",
      "failed",
      "cancelled",
    ]) {
      await transaction.execute(
        sql`UPDATE sim_jobs SET status=${status} WHERE id=${stopped.id}::uuid`,
      );
      expect(
        (await selectSettlementJobs(transaction, [String(stopped.id)])).map(
          (row) => row.sim_job_id,
        ),
      ).toEqual([stopped.id]);
    }

    // A newer attempt suppresses recovery of the old lease even across jobs.
    const [closed] = await transaction.execute(
      sql`SELECT id FROM fixture_settlement_jobs WHERE variant='done-closed'`,
    );
    await transaction.execute(sql`UPDATE progressive_cfd_units SET state='blocked',lease_token=NULL,lease_until=NULL
      WHERE id=${closed.id}::uuid`);
    await transaction.execute(
      sql`INSERT INTO progressive_cfd_execution_stops(sim_job_id) VALUES (${closed.id}::uuid)`,
    );
    await transaction.execute(sql`INSERT INTO progressive_cfd_attempts(token,sim_job_id,outcome,unit_id,started_at)
      VALUES (md5('original-closed')::uuid,${closed.id}::uuid,'cancelled',${closed.id}::uuid,timestamptz '2020-01-01')`);
    expect(
      await selectSettlementJobs(transaction, [String(closed.id)]),
    ).toHaveLength(1);
    await transaction.execute(sql`INSERT INTO progressive_cfd_attempts(token,sim_job_id,outcome,unit_id,started_at)
      VALUES (md5('new-owner')::uuid,${fulfilled.id}::uuid,'complete',${closed.id}::uuid,timestamptz '2020-01-02')`);
    expect(
      await selectSettlementJobs(transaction, [String(closed.id)]),
    ).toEqual([]);

    // Stage/epoch promotion must not hide old exact result identities awaiting publication.
    const [pointer] = await transaction.execute(
      sql`SELECT id FROM fixture_settlement_jobs WHERE variant='done-closed-pointer-gap'`,
    );
    await transaction.execute(sql`UPDATE progressive_cfd_units SET state='complete',lease_token=NULL,lease_until=NULL
      WHERE id=${pointer.id}::uuid`);
    await transaction.execute(sql`UPDATE sim_jobs SET "ingestedAt"=timestamptz '2020-01-01',
      request_payload='{"progressive":{"stage":1,"epoch":1}}'::jsonb WHERE id=${pointer.id}::uuid`);
    await transaction.execute(sql`UPDATE sim_campaigns SET status='complete'`);
    expect(
      await selectSettlementJobs(transaction, [String(pointer.id)]),
    ).toHaveLength(1);
    await transaction.execute(sql`INSERT INTO result_review_verdicts(id,result_id,verdict,"createdAt")
      VALUES (md5('defer-late')::uuid,md5('result-done-closed-pointer-gap')::uuid,'defer',timestamptz '2020-01-01')`);
    expect(
      await selectSettlementJobs(transaction, [String(pointer.id)]),
    ).toEqual([]);
    await transaction.execute(
      sql`UPDATE result_review_verdicts SET "revokedAt"=clock_timestamp()`,
    );
    expect(
      await selectSettlementJobs(transaction, [String(pointer.id)]),
    ).toHaveLength(1);
    await transaction.execute(sql`UPDATE results SET current_result_attempt_id=md5('attempt-done-closed-pointer-gap')::uuid
      WHERE id=md5('result-done-closed-pointer-gap')::uuid`);
    expect(
      await selectSettlementJobs(transaction, [String(pointer.id)]),
    ).toEqual([]);
  });
}, 30_000);

it("resumes due archive retries and expired claims before untouched work while preserving ownership and deadlines", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_archives ON COMMIT DROP AS
      SELECT md5(variant)::uuid id,variant,ordinal FROM unnest(ARRAY['ordinary','due-retry','expired-claim',
        'unselected-accepted','selected-accepted','storage-only-accepted-current','reconcilable-accepted-current','storage-only-wrong-kind','already-retained','future-retry','live-claim',
        'wrong-solver','wrong-upstream','wrong-job-upstream','not-remote','not-progressive',
        'wrong-attempt-job','wrong-engine','missing-result','missing-manifest','malformed-manifest'])
        WITH ORDINALITY AS variants(variant,ordinal)`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 id,false remote_solver_transfer_paused,'fixture-token'::text remote_solver_auth_token,
        'https://fixture.invalid'::text upstream_base_url,md5('solver')::uuid remote_solver_registered_id`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,jsonb_build_object('syncPromiseId',id::text,'remoteSolver',variant<>'not-remote',
        'upstreamBaseUrl',CASE WHEN variant='wrong-job-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END)
        || CASE WHEN variant='not-progressive' THEN '{}'::jsonb ELSE '{"remoteProgressiveExecution":{}}'::jsonb END request_payload
      FROM fixture_archives`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant='wrong-solver' THEN md5('foreign')::uuid ELSE md5('solver')::uuid END registered_solver_id,
        CASE WHEN variant='reconcilable-accepted-current' THEN 'expired' ELSE 'active' END status,
        CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END source_base_url
      FROM fixture_archives`);
    await transaction.execute(sql`CREATE TEMP TABLE result_attempts ON COMMIT DROP AS
      SELECT md5('attempt'||variant)::uuid id,
        CASE WHEN variant='wrong-attempt-job' THEN md5('foreign')::uuid ELSE id END sim_job_id,
        CASE WHEN variant='wrong-engine' THEN 'foreign' ELSE id::text END engine_job_id,
        CASE WHEN variant='missing-result' THEN NULL ELSE md5('result'||variant)::uuid END result_id,
        CASE WHEN variant='missing-manifest' THEN '{"evidence_artifacts":[{"kind":"log"}]}'::jsonb
          WHEN variant='malformed-manifest' THEN '{"evidence_artifacts":{"kind":"manifest"}}'::jsonb
          ELSE '{"evidence_artifacts":[{"kind":"manifest"}]}'::jsonb END evidence_payload
      FROM fixture_archives`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_hub_receipts ON COMMIT DROP AS
      SELECT id sim_job_id,md5(variant)::text point_content_signature,md5('attempt'||variant)::uuid result_attempt_id,
        CASE WHEN variant='storage-only-wrong-kind' THEN '{"kind":"other","storageOnly":true}'::jsonb
          ELSE jsonb_build_object('kind','retained-progressive-attempt','storageOnly',variant='storage-only-accepted-current') END receipt,
        timestamptz '2026-01-01' + ordinal * interval '1 second' delivered_at FROM fixture_archives`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_archive_receipts ON COMMIT DROP AS
      SELECT id sim_job_id,md5(variant)::text point_content_signature FROM fixture_archives WHERE variant='already-retained'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_archive_deliveries ON COMMIT DROP AS
      SELECT id sim_job_id,md5(variant)::text point_content_signature,
        CASE WHEN variant IN ('live-claim','expired-claim') THEN md5(variant||'claim')::uuid END claim_token,
        CASE WHEN variant IN ('future-retry','due-retry') THEN 1 ELSE 0 END attempt_count,
        CASE WHEN variant='live-claim' THEN clock_timestamp()+interval '2 days'
          WHEN variant='expired-claim' THEN clock_timestamp()-interval '1 day' END claim_expires_at,
        CASE WHEN variant='future-retry' THEN clock_timestamp()+interval '1 day'
          WHEN variant='due-retry' THEN clock_timestamp()-interval '1 minute' END retry_after
      FROM fixture_archives WHERE variant IN ('future-retry','due-retry','live-claim','expired-claim')`);
    await transaction.execute(sql`CREATE TEMP TABLE result_classifications ON COMMIT DROP AS
      SELECT md5('attempt'||variant)::uuid result_attempt_id,'accepted'::text state
      FROM fixture_archives WHERE variant IN ('selected-accepted','unselected-accepted','storage-only-accepted-current','reconcilable-accepted-current','storage-only-wrong-kind')`);
    await transaction.execute(sql`CREATE TEMP TABLE results ON COMMIT DROP AS
      SELECT md5('attempt'||variant)::uuid current_result_attempt_id FROM fixture_archives
      WHERE variant IN ('selected-accepted','storage-only-accepted-current','reconcilable-accepted-current','storage-only-wrong-kind')`);
    const connection = transaction as unknown as DB;
    for (const variant of [
      "expired-claim",
      "due-retry",
      "ordinary",
      "unselected-accepted",
      "selected-accepted",
      "storage-only-accepted-current",
      "reconcilable-accepted-current",
    ]) {
      const selected = await transaction.execute(
        progressiveArchiveSelectionSql(),
      );
      const expected =
        await transaction.execute(sql`SELECT id sim_job_id,md5(variant)::text point_content_signature,
        md5('attempt'||variant)::uuid result_attempt_id FROM fixture_archives WHERE variant=${variant}`);
      expect(selected).toEqual(expected);
      await transaction.execute(sql`INSERT INTO progressive_worker_archive_receipts VALUES
        (${selected[0].sim_job_id}::uuid,${selected[0].point_content_signature})`);
    }
    expect(await transaction.execute(progressiveArchiveSelectionSql())).toEqual(
      [],
    );
    const [deadline] =
      await transaction.execute(sql`SELECT retry_after FROM progressive_worker_archive_deliveries
      WHERE sim_job_id=(SELECT id FROM fixture_archives WHERE variant='future-retry')`);
    expect(
      (await nextProgressiveArchiveWakeAt(connection))?.toISOString(),
    ).toBe(new Date(String(deadline.retry_after)).toISOString());
    for (const statement of [
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true`,
      sql`UPDATE sync_api_settings SET remote_solver_auth_token=''`,
      sql`UPDATE sync_api_settings SET upstream_base_url=NULL`,
      sql`UPDATE sync_api_settings SET remote_solver_registered_id=md5('unregistered')::uuid`,
    ]) {
      const rollback = new Error("Rollback isolated archive settings");
      await expect(
        transaction.transaction(async (nested) => {
          await nested.execute(statement);
          expect(
            await nested.execute(progressiveArchiveSelectionSql()),
          ).toEqual([]);
          expect(
            await nextProgressiveArchiveWakeAt(nested as unknown as DB),
          ).toBeNull();
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
  });
});

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
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_report_conflicts ON COMMIT DROP AS
      SELECT id AS sim_job_id,sequence FROM fixture_jobs CROSS JOIN generate_series(1,2) sequence
      WHERE variant='conflict'`);
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
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_delivery_claims (
      sim_job_id uuid NOT NULL,
      sequence bigint NOT NULL,
      result_attempt_id uuid NOT NULL,
      point_content_signature text NOT NULL,
      claim_token uuid NOT NULL,
      claim_expires_at timestamptz NOT NULL,
      PRIMARY KEY (sim_job_id, point_content_signature)
    ) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_hub_receipts ON COMMIT DROP AS
      SELECT source.sim_job_id,source.point_content_signature FROM progressive_worker_evidence_attempts source
      JOIN fixture_jobs fixture ON fixture.id=source.sim_job_id WHERE fixture.variant='already-delivered' GROUP BY 1,2`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_delivery_failures ON COMMIT DROP AS
      SELECT source.sim_job_id,source.point_content_signature,CASE WHEN variant='conflict' THEN 'conflict' ELSE 'retry' END AS state,
        CASE WHEN variant='conflict' THEN 'requires conflict review' ELSE 'transient timeout' END AS last_error,
        CASE WHEN variant='conflict' THEN 409 ELSE 503 END AS last_http_status,'[]'::jsonb AS remote_conflict_ids,
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
      WHERE fixture.variant IN ('eligible-active','eligible-cancelled','eligible-expired','due-retry','conflict')
        AND NOT EXISTS(SELECT 1 FROM progressive_worker_hub_receipts delivered
          WHERE delivered.sim_job_id=source.sim_job_id AND delivered.point_content_signature=source.point_content_signature)
        AND NOT EXISTS(SELECT 1 FROM progressive_worker_report_conflicts conflict
          WHERE conflict.sim_job_id=source.sim_job_id AND conflict.sequence=source.sequence)
      ORDER BY CASE WHEN ${active} AND promise.status='active' AND promise."expiresAt">clock_timestamp() THEN 0 ELSE 1 END,
        CASE WHEN fixture.variant='due-retry' THEN 0 ELSE 1 END,
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
    const claimRollback = new Error("Rollback isolated delivery claim");
    await expect(
      transaction.transaction(async (nested) => {
        const first = await nested.execute(
          progressiveDeliverySelectionSql(
            true,
            "11111111-1111-4111-8111-111111111111",
          ),
        );
        expect(first).toHaveLength(1);
        const [storedClaim] = await nested.execute(
          sql`SELECT claim_token FROM progressive_worker_evidence_delivery_claims
            WHERE sim_job_id=${first[0].sim_job_id}::uuid
              AND point_content_signature=${first[0].point_content_signature}`,
        );
        expect(storedClaim.claim_token).toBe(
          "11111111-1111-4111-8111-111111111111",
        );
        const second = await nested.execute(
          progressiveDeliverySelectionSql(
            true,
            "22222222-2222-4222-8222-222222222222",
          ),
        );
        expect(second).toHaveLength(1);
        expect(second[0].point_content_signature).not.toBe(
          first[0].point_content_signature,
        );
        throw claimRollback;
      }),
    ).rejects.toBe(claimRollback);
    const [due] = await transaction.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant='due-retry'`,
    );
    await transaction.execute(sql`UPDATE progressive_worker_reports SET created_at=timestamptz '2020-01-01T00:00:00Z'
      WHERE sim_job_id IN (SELECT id FROM fixture_jobs WHERE variant IN ('eligible-active','eligible-cancelled','eligible-expired'))`);
    for (const active of [true, false])
      expect((await selected(active))[0].sim_job_id).toBe(due.id);
    await transaction.execute(sql`UPDATE progressive_worker_delivery_failures SET retry_after=clock_timestamp()+interval '1 day'
      WHERE sim_job_id=${due.id}::uuid`);
    for (const active of [true, false])
      expect((await selected(active))[0].sim_job_id).not.toBe(due.id);
    await transaction.execute(sql`UPDATE progressive_worker_delivery_failures SET retry_after=clock_timestamp()-interval '1 second'
      WHERE sim_job_id=${due.id}::uuid`);
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
