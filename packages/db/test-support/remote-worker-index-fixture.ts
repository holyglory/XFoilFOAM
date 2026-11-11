import { readFileSync } from "node:fs";
import { sql, type SQL } from "drizzle-orm";
import { expect } from "vitest";
import type { DB } from "../src/client";

const migration = readFileSync(
  new URL(
    "../migrations/0195_remote_worker_identity_index.sql",
    import.meta.url,
  ),
  "utf8",
);
const indexName = "sim_jobs_remote_worker_identity_idx";

export async function verifyRemoteWorkerIdentityIndex(
  db: DB,
  acknowledged: boolean,
  selectors: ReadonlyArray<{ name: string; query: (lane: number) => SQL }>,
) {
  await db.transaction(async (transaction) => {
    const [deployedIndex] =
      await transaction.execute(sql`SELECT indisvalid,indisready FROM pg_index
      WHERE indexrelid='public.sim_jobs_remote_worker_identity_idx'::regclass`);
    expect(deployedIndex).toEqual({ indisvalid: true, indisready: true });
    // A disabled worker may still drain its exact retained custody. Settings
    // alone therefore cannot tell these selectors that a HUB has no work.
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 id,false remote_solver_enabled,false remote_solver_transfer_paused,
        'fixture-token'::text remote_solver_auth_token,'https://worker-index.invalid'::text upstream_base_url,
        md5('worker-index-solver')::uuid remote_solver_registered_id`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs (
      id uuid PRIMARY KEY,status text,request_payload jsonb,ingest_lease_token text,ingest_lease_expires_at timestamptz
    ) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO sim_jobs(id,status,request_payload)
      SELECT md5('hub-index-'||ordinal)::uuid,'done',
        jsonb_build_object('syncPromiseId',md5('hub-index-'||ordinal)::uuid::text,
          'upstreamBaseUrl','https://worker-index.invalid',
          'retainedRequest', (SELECT string_agg(md5(ordinal::text||':'||chunk::text),'') FROM generate_series(1,256) chunk))
        || CASE WHEN ordinal%2=0 THEN '{"remoteSolver":false}'::jsonb ELSE '{}'::jsonb END
      FROM generate_series(1,12000) ordinal`);
    await transaction.execute(
      sql`CREATE INDEX fixture_worker_promise_idx ON sim_jobs((request_payload->>'syncPromiseId'))`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,'active'::text status,clock_timestamp()+interval '1 day' AS "expiresAt",
        md5('worker-index-solver')::uuid registered_solver_id,'https://worker-index.invalid'::text source_base_url
      FROM sim_jobs`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_worker_promises_idx ON sync_sweep_promises((id::text))`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports (
      sim_job_id uuid,sequence bigint,acknowledged_at timestamptz,report jsonb,stopped_engine_job_id text,
      created_at timestamptz,PRIMARY KEY(sim_job_id,sequence)
    ) ON COMMIT DROP`);
    await transaction.execute(sql`INSERT INTO progressive_worker_reports
      SELECT id,1,CASE WHEN ${acknowledged} THEN clock_timestamp() END,
        jsonb_build_object('solverId',md5('worker-index-solver')::uuid,'result','{}'::jsonb),id::text,
        timestamptz '2026-01-01' FROM sim_jobs`);
    await transaction.execute(sql`CREATE INDEX fixture_worker_pending_idx ON progressive_worker_reports(sim_job_id,sequence)
      WHERE acknowledged_at IS NULL`);
    await transaction.execute(sql`CREATE INDEX fixture_worker_staging_idx ON progressive_worker_reports(sim_job_id,created_at,sequence)
      WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_report_conflicts (
      sim_job_id uuid,sequence bigint,PRIMARY KEY(sim_job_id,sequence)) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_staging_failures (
      sim_job_id uuid,sequence bigint,retry_after timestamptz,PRIMARY KEY(sim_job_id,sequence)) ON COMMIT DROP`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_evidence_receipts (
      sim_job_id uuid,sequence bigint,PRIMARY KEY(sim_job_id,sequence)) ON COMMIT DROP`);
    const analyze = () =>
      transaction.execute(sql`ANALYZE sim_jobs,sync_sweep_promises,sync_api_settings,
      progressive_worker_reports,progressive_worker_report_conflicts,progressive_worker_staging_failures,progressive_worker_evidence_receipts`);
    await analyze();
    await transaction.execute(sql`SET LOCAL statement_timeout='20s'`);
    const explain = async (query: SQL) => {
      const [row] = await transaction.execute(
        sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`,
      );
      const plan = (row["QUERY PLAN"] as Array<Record<string, unknown>>)[0];
      const nodes: Array<Record<string, unknown>> = [];
      const visit = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Array<
          Record<string, unknown>
        >)
          visit(child);
      };
      visit(plan.Plan as Record<string, unknown>);
      return {
        plan,
        nodes,
        jobs: nodes.filter((node) => node["Relation Name"] === "sim_jobs"),
      };
    };
    const before = [];
    for (const selector of selectors) {
      expect(await transaction.execute(selector.query(0))).toEqual([]);
      before.push(await explain(selector.query(0)));
    }
    // Apply the actual migration to the shadow table, rather than reproducing
    // its DDL in a test or forcing a planner preference with enable_seqscan.
    await transaction.execute(sql.raw(migration));
    const [installed] =
      await transaction.execute(sql`SELECT indisvalid,indisready,
      pg_get_indexdef(indexrelid) AS definition,pg_get_expr(indpred,indrelid) AS predicate
      FROM pg_index WHERE indexrelid=${indexName}::regclass AND indrelid='pg_temp.sim_jobs'::regclass`);
    expect(installed).toMatchObject({ indisvalid: true, indisready: true });
    expect(installed.definition).toContain("upstreamBaseUrl");
    expect(installed.definition).toContain("syncPromiseId");
    expect(installed.predicate).toContain("remoteSolver");
    expect(installed.predicate).toContain("'true'::text");
    await analyze();
    for (const [position, selector] of selectors.entries()) {
      expect(await transaction.execute(selector.query(0))).toEqual([]);
      const after = await explain(selector.query(0));
      expect(after.jobs.some((node) => node["Node Type"] === "Seq Scan")).toBe(
        false,
      );
      expect(
        after.nodes.some(
          (node) =>
            node["Index Name"] === indexName &&
            Number(node["Actual Loops"]) > 0,
        ),
      ).toBe(true);
      const examined = after.jobs.reduce(
        (sum, node) =>
          sum +
          Number(node["Actual Loops"] ?? 0) *
            (Number(node["Actual Rows"] ?? 0) +
              Number(node["Rows Removed by Filter"] ?? 0)),
        0,
      );
      expect(examined).toBe(0);
      console.info(
        JSON.stringify({
          component: "remote-worker-identity-index",
          selector: selector.name,
          hubJobs: 12000,
          beforeMs: before[position].plan["Execution Time"],
          afterMs: after.plan["Execution Time"],
          beforeJobScanTypes: before[position].jobs.map(
            (node) => node["Node Type"],
          ),
          afterExaminedJobs: examined,
        }),
      );
    }
    // A retained worker job remains drainable even after worker mode and its
    // promise are inactive. Foreign ownership and pause still block it.
    const [worker] =
      await transaction.execute(sql`SELECT md5('retained-worker-index')::uuid id,
      mod((hashtext(md5('retained-worker-index')::uuid::text)::bigint & 2147483647),4)::integer lane`);
    await transaction.execute(sql`INSERT INTO sim_jobs(id,status,request_payload)
      VALUES(${worker.id}::uuid,'cancelled',jsonb_build_object('remoteSolver',true,'syncPromiseId',${String(worker.id)}::text,
        'upstreamBaseUrl','https://worker-index.invalid'))`);
    await transaction.execute(sql`INSERT INTO sync_sweep_promises
      VALUES(${worker.id}::uuid,'cancelled',clock_timestamp()-interval '1 hour',md5('worker-index-solver')::uuid,'https://worker-index.invalid')`);
    await transaction.execute(sql`INSERT INTO progressive_worker_reports
      VALUES(${worker.id}::uuid,1,CASE WHEN ${acknowledged} THEN clock_timestamp() END,
        jsonb_build_object('solverId',md5('worker-index-solver')::uuid,'result','{}'::jsonb),${String(worker.id)},clock_timestamp())`);
    for (const selector of selectors)
      expect(
        (await transaction.execute(selector.query(Number(worker.lane)))).map(
          (row) => row.sim_job_id,
        ),
      ).toEqual([worker.id]);
    await transaction.execute(
      sql`UPDATE sync_sweep_promises SET registered_solver_id=md5('foreign-worker-index')::uuid WHERE id=${worker.id}::uuid`,
    );
    for (const selector of selectors)
      expect(
        await transaction.execute(selector.query(Number(worker.lane))),
      ).toEqual([]);
    await transaction.execute(
      sql`UPDATE sync_sweep_promises SET registered_solver_id=md5('worker-index-solver')::uuid WHERE id=${worker.id}::uuid`,
    );
    await transaction.execute(
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true`,
    );
    for (const selector of selectors)
      expect(
        await transaction.execute(selector.query(Number(worker.lane))),
      ).toEqual([]);
  });
}
