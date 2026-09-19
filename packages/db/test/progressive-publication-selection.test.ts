import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import { progressivePublicationSelectionSql } from "../../../apps/sweeper/src/progressive-publication-selection";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("selects the oldest exact owned report without re-reading the whole pending backlog", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_jobs ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['eligible','cancelled','expired',
        'wrong-solver','wrong-report-solver','wrong-upstream','wrong-job-upstream','not-remote','acknowledged']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 AS id,false AS remote_solver_transfer_paused,'fixture-token'::text AS remote_solver_auth_token,
        'https://fixture.invalid'::text AS upstream_base_url,md5('solver')::uuid AS remote_solver_registered_id`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,jsonb_build_object('syncPromiseId',id::text,'remoteSolver',variant<>'not-remote',
        'upstreamBaseUrl',CASE WHEN variant='wrong-job-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END) AS request_payload FROM fixture_jobs`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_publication_jobs_idx ON sim_jobs(id)`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant='cancelled' THEN 'cancelled' ELSE 'active' END AS status,
        clock_timestamp()+CASE WHEN variant='expired' THEN interval '-1 day' ELSE interval '1 day' END AS "expiresAt",
        CASE WHEN variant='wrong-solver' THEN md5('foreign') ELSE md5('solver') END::uuid AS registered_solver_id,
        CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END AS source_base_url FROM fixture_jobs`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_publication_promises_idx ON sync_sweep_promises((id::text))`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,sequence,CASE WHEN variant='acknowledged' THEN clock_timestamp() ELSE NULL::timestamptz END AS acknowledged_at,
        jsonb_build_object('solverId',CASE WHEN variant='wrong-report-solver' THEN md5('foreign') ELSE md5('solver') END::uuid) AS report,
        timestamptz '2026-01-01T00:00:00Z' + sequence * interval '1 second' AS created_at
      FROM fixture_jobs CROSS JOIN generate_series(1,2) sequence`);
    await transaction.execute(
      sql`CREATE INDEX fixture_publication_order_idx ON progressive_worker_reports((report->>'solverId'),created_at,sim_job_id,sequence) WHERE acknowledged_at IS NULL`,
    );
    const [index] =
      await transaction.execute(sql`SELECT indisvalid FROM pg_index
      WHERE indexrelid='public.progressive_worker_reports_publication_order_idx'::regclass`);
    expect(index.indisvalid).toBe(true);
    const select = () =>
      transaction.execute(progressivePublicationSelectionSql());
    const legacy = () =>
      transaction.execute(sql`
      SELECT report.sim_job_id FROM progressive_worker_reports report
      JOIN sim_jobs job ON job.id=report.sim_job_id
      JOIN sync_sweep_promises promise ON promise.id::text=job.request_payload->>'syncPromiseId'
      JOIN sync_api_settings settings ON settings.id=1
      WHERE report.acknowledged_at IS NULL AND NOT settings.remote_solver_transfer_paused
        AND settings.remote_solver_auth_token<>'' AND settings.upstream_base_url IS NOT NULL
        AND promise.registered_solver_id=settings.remote_solver_registered_id
        AND report.report->>'solverId'=settings.remote_solver_registered_id::text
        AND promise.source_base_url=settings.upstream_base_url
        AND job.request_payload->>'upstreamBaseUrl'=settings.upstream_base_url
        AND job.request_payload->>'remoteSolver'='true'
      ORDER BY report.created_at,report.sim_job_id,report.sequence LIMIT 1`);
    const selectedJobs = new Set();
    for (let ordinal = 0; ordinal < 6; ordinal += 1) {
      const rows = await select();
      expect(rows).toEqual(await legacy());
      expect(rows).toHaveLength(1);
      selectedJobs.add(rows[0].sim_job_id);
      await transaction.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp()
        WHERE sim_job_id=${rows[0].sim_job_id}::uuid AND sequence=(SELECT min(sequence) FROM progressive_worker_reports WHERE sim_job_id=${rows[0].sim_job_id}::uuid AND acknowledged_at IS NULL)`);
    }
    expect(selectedJobs.size).toBe(3);
    expect(await select()).toEqual([]);
    await transaction.execute(
      sql`UPDATE progressive_worker_reports SET acknowledged_at=NULL WHERE sim_job_id=md5('eligible')::uuid`,
    );
    for (const statement of [
      sql`UPDATE sync_api_settings SET remote_solver_transfer_paused=true`,
      sql`UPDATE sync_api_settings SET remote_solver_auth_token=''`,
      sql`UPDATE sync_api_settings SET upstream_base_url=NULL`,
      sql`UPDATE sync_api_settings SET remote_solver_registered_id=md5('other')::uuid`,
    ]) {
      const rollback = new Error("isolated selection setting rollback");
      await expect(
        transaction.transaction(async (nested) => {
          await nested.execute(statement);
          expect(
            await nested.execute(progressivePublicationSelectionSql()),
          ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
    await transaction.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,acknowledged_at,report,created_at)
      SELECT md5('eligible')::uuid,sequence,CASE WHEN sequence<80000 THEN clock_timestamp() ELSE NULL::timestamptz END,
        jsonb_build_object('solverId',md5('solver')::uuid,'diagnostic',repeat(md5(sequence::text),100)),
        timestamptz '2026-01-02T00:00:00Z'+sequence*interval '1 second' FROM generate_series(3,84000) sequence`);
    await transaction.execute(
      sql`ANALYZE progressive_worker_reports,sim_jobs,sync_sweep_promises,sync_api_settings`,
    );
    console.info(
      JSON.stringify({
        publicationIndexes: await transaction.execute(
          sql`SELECT indexrelid::regclass::text AS name,indisvalid,indisready,pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid='progressive_worker_reports'::regclass`,
        ),
        planner: await transaction.execute(
          sql`SELECT name,setting FROM pg_settings WHERE name IN ('enable_indexscan','enable_bitmapscan','random_page_cost','plan_cache_mode')`,
        ),
      }),
    );
    const [explained] = await transaction.execute(
      sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${progressivePublicationSelectionSql()}`,
    );
    const plan = (explained["QUERY PLAN"] as Array<Record<string, unknown>>)[0];
    const nodes: Array<Record<string, unknown>> = [];
    const visit = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>)
        visit(child);
    };
    visit(plan.Plan as Record<string, unknown>);
    console.info(
      JSON.stringify({
        publicationPlan: nodes.map((node) => ({
          type: node["Node Type"],
          relation: node["Relation Name"],
          index: node["Index Name"],
          rows: node["Actual Rows"],
          loops: node["Actual Loops"],
          milliseconds: node["Actual Total Time"],
        })),
      }),
    );
    const scan = nodes.find(
      (node) => node["Index Name"] === "fixture_publication_order_idx",
    );
    expect(scan).toBeDefined();
    expect(
      Number(scan!["Actual Rows"]) +
        Number(scan!["Rows Removed by Filter"] ?? 0),
    ).toBeLessThan(32);
    expect(
      nodes.some(
        (node) =>
          node["Node Type"] === "Seq Scan" &&
          node["Relation Name"] === "progressive_worker_reports",
      ),
    ).toBe(false);
    expect(await select()).toEqual(await legacy());
    console.info(
      JSON.stringify({
        reportSelectionMs: plan["Execution Time"],
        storedReports: 84016,
        boundedPendingScan: true,
      }),
    );
  });
}, 120000);
