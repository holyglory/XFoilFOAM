import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createClient } from "../src/client";
import { databaseUrl } from "../src/env";
import { backfillWorkerStagingKeyPage, maintainWorkerStagingKeys } from "../src/worker-staging-key-maintenance";

const databaseName =
  "aerodb_worker_staging_keys_" + randomUUID().replaceAll("-", "");
const adminUrl = new URL(databaseUrl());
adminUrl.pathname = "/postgres";
const targetUrl = new URL(adminUrl);
targetUrl.pathname = "/" + databaseName;
const admin = createClient({ url: adminUrl.toString(), max: 1 });
const { sql } = createClient({
  url: targetUrl.toString(),
  max: 5,
  connection: { lock_timeout: "1200", statement_timeout: "8000" },
});
const migrationFile = (file: string) =>
  readFileSync(new URL("../migrations/" + file, import.meta.url), "utf8");
const migration = migrationFile("0218_worker_report_staging_keys.sql");
const instance = randomUUID();
const job = "41b4fe09-1254-43b8-961f-6d8a5e9b8e59";
const otherJob = "f7941109-6862-46ba-a5cd-274166566c9b";
const timestamp = "2026-01-01T00:00:00.123456Z";

async function report(
  sequence: number,
  body: object,
  acknowledged = true,
  owner = job,
) {
  await sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,created_at,acknowledged_at,report)
    VALUES(${owner},${sequence},${timestamp},${acknowledged ? timestamp : null},${JSON.stringify(body)}::text::jsonb)`;
}
async function backfill(limit: number) {
  const [row] = await sql.begin(
    "isolation level repeatable read",
    async (tx) =>
      tx`SELECT * FROM backfill_progressive_worker_staging_keys(${limit})`,
  );
  return row;
}
async function expectParity() {
  const [r] =
    await sql`WITH source AS (SELECT sim_job_id,sequence,created_at,stopped_engine_job_id
    FROM progressive_worker_reports WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object'),
    missing AS (TABLE source EXCEPT ALL TABLE progressive_worker_staging_keys),
    extra AS (TABLE progressive_worker_staging_keys EXCEPT ALL TABLE source)
    SELECT (SELECT count(*)::integer FROM missing) AS missing,(SELECT count(*)::integer FROM extra) AS extra`;
  expect(r).toEqual({ missing: 0, extra: 0 });
}

beforeAll(async () => {
  await admin.sql.unsafe('CREATE DATABASE "' + databaseName + '"');
  await sql`CREATE TABLE progressive_worker_reports (
    sim_job_id uuid NOT NULL,sequence bigint NOT NULL,created_at timestamptz NOT NULL,acknowledged_at timestamptz,
    report jsonb NOT NULL, result_payload_hash text, assignment_signature text GENERATED ALWAYS AS (report->>'assignmentSignature') STORED,
    stopped_engine_job_id text GENERATED ALWAYS AS (CASE WHEN report#>>'{stopProof,execution_stopped}'='true'
       THEN report#>>'{stopProof,job_id}' END) STORED, PRIMARY KEY(sim_job_id,sequence))`;
  for (const file of [
    "0146_progressive_staging_candidate_index.sql",
    "0150_progressive_staging_order.sql",
    "0160_progressive_terminal_staging_order.sql",
    "0189_progressive_worker_report_job_order.sql",
  ])
    await sql.unsafe(migrationFile(file));
  // Only the storage-header functions are needed in this independent database.
  for (const [file, signature] of [
    [
      "0198_progressive_report_result_payloads.sql",
      "CREATE FUNCTION progressive_report_result_header(",
    ],
    [
      "0202_report_archive_custody.sql",
      "CREATE OR REPLACE FUNCTION progressive_report_compact_header(",
    ],
  ]) {
    const content = migrationFile(file);
    const from = content.indexOf(signature);
    expect(from).toBeGreaterThanOrEqual(0);
    await sql.unsafe(content.slice(from, content.indexOf("$$;", from) + 3));
  }
  await sql`CREATE TABLE sync_api_settings(id integer primary key,instance_id uuid,remote_solver_enabled boolean,remote_solver_registered_id uuid)`;
  await sql`INSERT INTO sync_api_settings VALUES (1,${instance},true,${randomUUID()})`;
  await report(2, { result: {} });
  await report(3, { result: {} });
  await report(4, {
    result: { state: "completed" },
    stopProof: { execution_stopped: true, job_id: job },
  });
  await report(5, { result: {} }, false);
  await report(6, {
    result: null,
    stopProof: { execution_stopped: true, job_id: job },
  });
  await report(7, { status: { state: "running" } });
  await report(8, { result: [] });
  await report(9, { result: "pending" });
  await report(10, {
    result: {},
    stopProof: { execution_stopped: true, job_id: otherJob },
  });
  const existingFiles =
    () => sql`SELECT pg_relation_filenode(c.oid)::text heap,pg_relation_filenode(c.reltoastrelid)::text toast,
    (SELECT encode(sha256(convert_to(string_agg(report::text,'|' ORDER BY sim_job_id,sequence),'UTF8')),'hex') FROM progressive_worker_reports) AS source_hash
    FROM pg_class c WHERE c.oid='public.progressive_worker_reports'::regclass`;
  const before = await existingFiles();
  for (const statement of migration.split("--> statement-breakpoint"))
    await sql.unsafe(statement);
  expect(await existingFiles()).toEqual(before);
});

afterAll(async () => {
  await sql.end();
  try {
    await admin.sql.unsafe('DROP DATABASE IF EXISTS "' + databaseName + '"');
  } finally {
    await admin.sql.end();
  }
});

it("keeps the original read view until a lossless, restartable bootstrap and handles concurrent source changes", async () => {
  expect(
    (
      await sql`SELECT count(*)::int AS n FROM progressive_worker_staging_candidates`
    )[0].n,
  ).toBe(4);
  expect(
    (
      await sql`SELECT count(*)::int AS n FROM progressive_worker_staging_keys`
    )[0].n,
  ).toBe(0);
  await expect(
    sql`SELECT set_progressive_worker_staging_key_reads(true)`,
  ).rejects.toThrow(/Complete the staging key backfill/);
  await expect(
    sql`SELECT * FROM backfill_progressive_worker_staging_keys(1)`,
  ).rejects.toThrow(/repeatable-read/);
  await expect(backfill(513)).rejects.toThrow(/page size/);
  expect(
    (
      await sql`SELECT count(*)::int n FROM progressive_worker_staging_key_backfill`
    )[0].n,
  ).toBe(0);
  await expect(backfill(1)).rejects.toThrow(/Start staging key tracking/);
  await expect(
    maintainWorkerStagingKeys(sql, "start", { instance: otherJob }),
  ).rejects.toThrow(/exact registered worker instance/);
  const existingWriter = await sql.reserve();
  try {
    await existingWriter`BEGIN`;
    await existingWriter`UPDATE progressive_worker_reports SET acknowledged_at=acknowledged_at WHERE sequence=2`;
    await expect(
      maintainWorkerStagingKeys(sql, "start", { instance }),
    ).rejects.toMatchObject({ code: "55P03" });
    expect(
      (
        await sql`SELECT public.progressive_worker_staging_key_tracking_enabled() active`
      )[0].active,
    ).toBe(false);
    expect(
      (
        await sql`SELECT count(*)::int n FROM progressive_worker_staging_key_backfill`
      )[0].n,
    ).toBe(0);
  } finally {
    await existingWriter`ROLLBACK`;
    existingWriter.release();
  }
  await maintainWorkerStagingKeys(sql, "start", { instance });
  expect(await backfill(1)).toMatchObject({
    visited: 1,
    changed: 1,
    complete: false,
  });
  // An acknowledged source behind the cursor must enter through the insert trigger.
  await report(1, { result: { state: "running" } });

  const otherBackfill = await sql.reserve();
  try {
    await otherBackfill`BEGIN ISOLATION LEVEL REPEATABLE READ`;
    await otherBackfill`SELECT singleton FROM progressive_worker_staging_key_backfill FOR UPDATE`;
    await expect(backfill(1)).rejects.toMatchObject({ code: "55P03" });
    expect(await backfillWorkerStagingKeyPage(sql, 1, instance)).toEqual({
      busy: true, visited: 0, changed: 0, complete: false,
    });
    await otherBackfill`SELECT pg_advisory_xact_lock(218,1)`;
    for (const op of ["start", "enable", "disable", "stop", "restore", "retire"] as const) {
      await expect(maintainWorkerStagingKeys(sql, op, { instance, readersRevision: "ab".repeat(20) }))
        .rejects.toThrow("Another staging key maintenance is active");
    }
    expect(await backfillWorkerStagingKeyPage(sql, 1, instance)).toMatchObject({ busy: true, visited: 0 });
    const [cursor] = await sql`SELECT after_sequence::int AS seq,reads_enabled,index_phase
      FROM progressive_worker_staging_key_backfill`;
    expect(cursor).toEqual({ seq: 2, reads_enabled: false, index_phase: "present" });
  } finally {
    await otherBackfill`ROLLBACK`;
    otherBackfill.release();
  }

  const writer = await sql.reserve();
  try {
    await writer`BEGIN`;
    await writer`DELETE FROM progressive_worker_reports WHERE sim_job_id=${job} AND sequence=3`;
    await expect(backfill(3)).rejects.toMatchObject({ code: "55P03" });
    expect(
      (
        await sql`SELECT after_sequence::int AS n FROM progressive_worker_staging_key_backfill`
      )[0].n,
    ).toBe(2);
    await writer`COMMIT`;
  } catch (error) {
    await writer`ROLLBACK`;
    throw error;
  } finally {
    writer.release();
  }

  // Hold a prior snapshot, then commit a new representation before the locking read.
  const oldSnapshot = await sql.reserve();
  try {
    await oldSnapshot`BEGIN ISOLATION LEVEL REPEATABLE READ`;
    await oldSnapshot`SELECT after_sequence FROM progressive_worker_staging_key_backfill`;
    await sql`UPDATE progressive_worker_reports SET acknowledged_at=acknowledged_at
      WHERE sim_job_id=${job} AND sequence=4`;
    await expect(
      oldSnapshot`SELECT * FROM backfill_progressive_worker_staging_keys(3)`,
    ).rejects.toMatchObject({ code: "40001" });
  } finally {
    await oldSnapshot`ROLLBACK`;
    oldSnapshot.release();
  }
  await sql`UPDATE progressive_worker_reports SET acknowledged_at=created_at WHERE sim_job_id=${job} AND sequence=5`;
  expect(await backfill(2)).toMatchObject({ visited: 2, complete: false });
  expect(await backfill(2)).toMatchObject({ visited: 1, complete: false });
  expect(await backfill(2)).toEqual({ visited: 0, changed: 0, complete: true });
  expect(await backfill(2)).toEqual({ visited: 0, changed: 0, complete: true });
  await expectParity();

  const before =
    await sql`SELECT sequence::int seq,created_at::text at,stopped_engine_job_id stop
    FROM progressive_worker_staging_candidates ORDER BY created_at,sim_job_id,sequence`;
  await maintainWorkerStagingKeys(sql, "enable", { instance });
  const after =
    await sql`SELECT sequence::int seq,created_at::text at,stopped_engine_job_id stop
    FROM progressive_worker_staging_candidates ORDER BY created_at,sim_job_id,sequence`;
  expect(after).toEqual(before);
  expect(after.map((x) => x.seq)).toEqual([1, 2, 4, 5, 10]);
  expect(after.filter((x) => x.stop === job).map((x) => x.seq)).toEqual([4]);
  expect(after.filter((x) => x.stop !== null).map((x) => x.seq)).toEqual([
    4, 10,
  ]);
  await sql`UPDATE progressive_worker_reports SET report=jsonb_set(report,'{result}',public.progressive_report_result_header(report->'result'),false)
    WHERE sim_job_id=${job} AND sequence=4`;
  await sql`UPDATE progressive_worker_reports SET report=public.progressive_report_compact_header(report)
    WHERE sim_job_id=${job} AND sequence=4`;
  await expectParity();
  await expect(
    sql.begin(async (tx) => {
      await tx`DELETE FROM progressive_worker_reports WHERE sim_job_id=${job} AND sequence=2`;
      expect(
        (
          await tx`SELECT count(*)::int n FROM progressive_worker_staging_candidates WHERE sequence=2`
        )[0].n,
      ).toBe(0);
      throw Error("rollback source delete");
    }),
  ).rejects.toThrow(/rollback source delete/);
  // A conflicting replay leaves the original membership intact.
  await sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,created_at,acknowledged_at,report)
    VALUES(${job},2,${timestamp},${timestamp},'{"result":null}') ON CONFLICT DO NOTHING`;
  await expectParity();
  await sql`DELETE FROM progressive_worker_reports WHERE sim_job_id=${job} AND sequence=2`;
  await report(2, { result: null }, false);
  await expectParity();
  await maintainWorkerStagingKeys(sql, "disable", { instance });
  await expectParity();
  await verifyIndexRetirement();
});

async function verifyIndexRetirement() {
  const revision = "ab".repeat(20);
  const act = (operation: Parameters<typeof maintainWorkerStagingKeys>[1]) =>
    maintainWorkerStagingKeys(sql, operation, {
      instance,
      readersRevision: revision,
    });
  const definitions =
    () => sql`SELECT pg_get_indexdef(indexrelid) definition,indisvalid,indisready FROM pg_index
      WHERE indrelid='public.progressive_worker_reports'::regclass ORDER BY definition`;
  const initial = await definitions();
  await expect(
    maintainWorkerStagingKeys(sql, "enable", { instance: otherJob }),
  ).rejects.toThrow(/exact registered worker/);
  await act("enable");
  const [{ id }] =
    await sql`SELECT sim_job_id AS id FROM progressive_worker_staging_keys WHERE sequence=1`;
  await sql`UPDATE progressive_worker_staging_keys SET created_at=created_at+interval '1 microsecond' WHERE sim_job_id=${id} AND sequence=1`;
  await expect(act("retire")).rejects.toThrow(
    /membership, creation time or stop identity differs/,
  );
  expect(await definitions()).toEqual(initial);
  await sql`UPDATE progressive_worker_staging_keys SET created_at=${timestamp} WHERE sim_job_id=${id} AND sequence=1`;

  await sql`ALTER INDEX progressive_worker_reports_staging_job_order_idx RENAME TO fixture_expected`;
  await sql`CREATE INDEX progressive_worker_reports_staging_job_order_idx ON progressive_worker_reports(sequence)`;
  await expect(act("retire")).rejects.toThrow(/definition differs/);
  await sql`DROP INDEX progressive_worker_reports_staging_job_order_idx`;
  await sql`ALTER INDEX fixture_expected RENAME TO progressive_worker_reports_staging_job_order_idx`;

  // A real interruption after one DROP. The trigger lives only in this test's own database.
  await sql`CREATE FUNCTION fixture_interrupt_drop() RETURNS event_trigger LANGUAGE plpgsql AS $$
    BEGIN IF current_query() LIKE '%terminal_staging_order_idx%' THEN RAISE EXCEPTION 'Interrupted concurrent drop'; END IF; END $$`;
  await sql`CREATE EVENT TRIGGER fixture_interruption ON ddl_command_start WHEN TAG IN('DROP INDEX') EXECUTE FUNCTION fixture_interrupt_drop()`;
  await expect(act("retire")).rejects.toThrow(/Interrupted concurrent drop/);
  expect(await definitions()).toHaveLength(initial.length - 1);
  expect(await act("status")).toMatchObject({
    index_phase: "retiring",
    reads_enabled: true,
    retirement_revision: revision,
  });
  await expect(act("disable")).rejects.toThrow(
    /Restore source staging indexes/,
  );
  await expect(
    maintainWorkerStagingKeys(sql, "retire", {
      instance,
      readersRevision: "cd".repeat(20),
    }),
  ).rejects.toThrow(/different reader revision/);
  await sql`DROP EVENT TRIGGER fixture_interruption`;
  expect(await act("retire")).toMatchObject({ index_phase: "retired" });
  expect(await act("retire")).toMatchObject({ index_phase: "retired" });
  expect(await definitions()).toHaveLength(initial.length - 4);
  await expect(act("stop")).rejects.toThrow(
    /Restore source indexes and source-backed reads/,
  );
  await report(14, { result: { state: "running" } }, false);
  await sql`UPDATE progressive_worker_reports SET acknowledged_at=created_at WHERE sim_job_id=${job} AND sequence=14`;
  await report(15, { result: null });
  expect(
    (
      await sql`SELECT sequence::int AS n FROM progressive_worker_staging_candidates WHERE sequence IN(14,15)`
    ).map((x) => x.n),
  ).toEqual([14]);

  // AFTER row triggers must see all sources from a multi-row statement on
  // the post-retirement PK path, including unacknowledged and JSON-null rows.
  await sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,created_at,acknowledged_at,report)
    SELECT ${job}::uuid,n,${timestamp}::timestamptz,CASE WHEN n<18 THEN ${timestamp}::timestamptz END,
      CASE WHEN n%2=0 THEN '{"result":{}}'::jsonb ELSE '{"result":null}'::jsonb END FROM generate_series(16,19)n`;
  await sql`UPDATE progressive_worker_reports SET acknowledged_at=created_at WHERE sim_job_id=${job} AND sequence IN(18,19)`;
  expect(
    (
      await sql`SELECT sequence::int n FROM progressive_worker_staging_keys WHERE sequence BETWEEN 16 AND 19 ORDER BY sequence`
    ).map((r) => r.n),
  ).toEqual([16, 18]);
  await expectParity();
  expect(await act("restore")).toMatchObject({
    index_phase: "present",
    reads_enabled: true,
  });
  expect(await definitions()).toEqual(initial);
  expect(await act("disable")).toMatchObject({
    index_phase: "present",
    reads_enabled: false,
  });
  await sql`UPDATE sync_api_settings SET remote_solver_enabled=false WHERE id=1`;
  expect(await act("stop")).toMatchObject({
    tracking_instance_id: null,
    complete: false,
    reads_enabled: false,
  });
  expect(
    (await sql`SELECT count(*)::int n FROM progressive_worker_staging_keys`)[0]
      .n,
  ).toBe(0);
  await report(20, { result: {} });
  expect(
    (
      await sql`SELECT count(*)::int n FROM progressive_worker_staging_candidates WHERE sequence=20`
    )[0].n,
  ).toBe(1);
  expect(
    (await sql`SELECT count(*)::int n FROM progressive_worker_staging_keys`)[0]
      .n,
  ).toBe(0);
  await expect(act("start")).rejects.toThrow(/exact registered worker/);
  await sql`UPDATE sync_api_settings SET remote_solver_enabled=true WHERE id=1`;
  await act("start");
  while (!(await backfill(2)).complete) {
    /* each call commits one bounded page */
  }
  await expectParity();
}
