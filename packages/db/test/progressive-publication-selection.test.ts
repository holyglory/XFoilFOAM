import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import {
  progressivePublicationBatchSelectionSql,
  progressivePublicationSelectionSql,
  type ProgressivePublicationPass,
} from "../../../apps/sweeper/src/progressive-publication-selection";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("prioritizes active exact-owned reports before stale pending backlog", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_jobs ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['eligible','cancelled','expired',
        'cancelled-job-active-promise','running-job-cancelled-promise','done-job-active-promise',
        'wrong-solver','wrong-report-solver','wrong-upstream','wrong-job-upstream','not-remote','acknowledged']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE sync_api_settings ON COMMIT DROP AS
      SELECT 1 AS id,false AS remote_solver_transfer_paused,'fixture-token'::text AS remote_solver_auth_token,
        'https://fixture.invalid'::text AS upstream_base_url,md5('solver')::uuid AS remote_solver_registered_id`);
    await transaction.execute(sql`CREATE TEMP TABLE sim_jobs ON COMMIT DROP AS
      SELECT id,jsonb_build_object('syncPromiseId',id::text,'remoteSolver',variant<>'not-remote',
        'upstreamBaseUrl',CASE WHEN variant='wrong-job-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END) AS request_payload,
        CASE WHEN variant IN ('cancelled','cancelled-job-active-promise') THEN 'cancelled'
          WHEN variant='done-job-active-promise' THEN 'done' ELSE 'running' END AS status FROM fixture_jobs`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_publication_jobs_idx ON sim_jobs(id)`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE sync_sweep_promises ON COMMIT DROP AS
      SELECT id,CASE WHEN variant IN ('cancelled','running-job-cancelled-promise') THEN 'cancelled' ELSE 'active' END AS status,
        clock_timestamp()+CASE WHEN variant='expired' THEN interval '-1 day' ELSE interval '1 day' END AS "expiresAt",
        CASE WHEN variant='wrong-solver' THEN md5('foreign') ELSE md5('solver') END::uuid AS registered_solver_id,
        CASE WHEN variant='wrong-upstream' THEN 'https://foreign.invalid' ELSE 'https://fixture.invalid' END AS source_base_url FROM fixture_jobs`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_publication_promises_idx ON sync_sweep_promises((id::text))`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_worker_reports ON COMMIT DROP AS
      SELECT id AS sim_job_id,sequence,CASE WHEN variant='acknowledged' THEN clock_timestamp() ELSE NULL::timestamptz END AS acknowledged_at,
        jsonb_build_object('solverId',CASE WHEN variant='wrong-report-solver' THEN md5('foreign') ELSE md5('solver') END::uuid) AS report,
        CASE WHEN variant='eligible' THEN timestamptz '2026-01-02T00:00:00Z'
          ELSE timestamptz '2026-01-01T00:00:00Z' END + sequence * interval '1 second' AS created_at
      FROM fixture_jobs CROSS JOIN generate_series(1,2) sequence`);
    await transaction.execute(
      sql`ALTER TABLE progressive_worker_reports ADD PRIMARY KEY (sim_job_id,sequence)`,
    );
    await transaction.execute(sql`CREATE INDEX fixture_publication_pending_idx
      ON progressive_worker_reports(sim_job_id,sequence) WHERE acknowledged_at IS NULL`);
    await transaction.execute(sql`CREATE INDEX fixture_publication_job_promise_idx
      ON sim_jobs((request_payload->>'syncPromiseId'))`);
    await transaction.execute(
      sql`CREATE INDEX fixture_publication_order_idx ON progressive_worker_reports((report->>'solverId'),created_at,sim_job_id,sequence) WHERE acknowledged_at IS NULL`,
    );
    const [index] =
      await transaction.execute(sql`SELECT indisvalid FROM pg_index
      WHERE indexrelid='public.progressive_worker_reports_publication_order_idx'::regclass`);
    expect(index.indisvalid).toBe(true);
    const [pendingIndex] =
      await transaction.execute(sql`SELECT indisvalid,indisready,pg_get_indexdef(indexrelid) AS definition
      FROM pg_index WHERE indexrelid='public.progressive_worker_reports_pending_idx'::regclass`);
    expect(pendingIndex.indisvalid).toBe(true);
    expect(pendingIndex.indisready).toBe(true);
    expect(pendingIndex.definition).toContain("(sim_job_id, sequence)");
    expect(pendingIndex.definition).toContain("acknowledged_at IS NULL");
    const select = () =>
      transaction.execute(progressivePublicationSelectionSql());
    const selectBatch = () =>
      transaction.execute(progressivePublicationBatchSelectionSql(6));
    const expected = (
      pass: ProgressivePublicationPass = "active",
      lane = 0,
      laneCount = 1,
    ) =>
      transaction.execute(sql`
      SELECT report.sim_job_id FROM progressive_worker_reports report
      JOIN sim_jobs job ON job.id=report.sim_job_id
      JOIN sync_sweep_promises promise ON promise.id::text=job.request_payload->>'syncPromiseId'
      JOIN sync_api_settings settings ON settings.id=1
      WHERE report.acknowledged_at IS NULL AND NOT settings.remote_solver_transfer_paused
        AND settings.remote_solver_auth_token<>'' AND settings.upstream_base_url IS NOT NULL
        AND promise.registered_solver_id=settings.remote_solver_registered_id
        AND report.report->>'solverId'=settings.remote_solver_registered_id::text
        AND NOT EXISTS (
          SELECT 1 FROM progressive_worker_reports earlier
          WHERE earlier.sim_job_id=report.sim_job_id AND earlier.acknowledged_at IS NULL
            AND earlier.sequence<report.sequence
        )
        AND promise.source_base_url=settings.upstream_base_url
        AND job.request_payload->>'upstreamBaseUrl'=settings.upstream_base_url
        AND job.request_payload->>'remoteSolver'='true'
        AND mod((hashtext(report.sim_job_id::text)::bigint & 2147483647), ${laneCount}) = ${lane}
      ORDER BY (${pass === "active"} AND promise.status = 'active' AND promise."expiresAt" > clock_timestamp()
        AND job.status IN ('pending', 'submitted', 'running', 'ingesting')) DESC,
        report.created_at,report.sim_job_id,report.sequence LIMIT 1`);
    const [eligible] = await transaction.execute(
      sql`SELECT id FROM fixture_jobs WHERE variant='eligible'`,
    );
    expect(await select()).toEqual([{ sim_job_id: eligible.id }]);
    expect(
      await transaction.execute(
        progressivePublicationSelectionSql(0, 1, "backlog"),
      ),
    ).toEqual(await expected("backlog"));
    const selectedJobs = new Set();
    for (let ordinal = 0; ordinal < 12; ordinal += 1) {
      const rows = await select();
      expect(rows).toEqual(await expected());
      expect(rows).toHaveLength(1);
      selectedJobs.add(rows[0].sim_job_id);
      await transaction.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp()
        WHERE sim_job_id=${rows[0].sim_job_id}::uuid AND sequence=(SELECT min(sequence) FROM progressive_worker_reports WHERE sim_job_id=${rows[0].sim_job_id}::uuid AND acknowledged_at IS NULL)`);
    }
    expect(selectedJobs.size).toBe(6);
    expect(await select()).toEqual([]);
    await transaction.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=NULL
      WHERE sim_job_id IN (md5('eligible')::uuid,md5('cancelled')::uuid,md5('expired')::uuid,
        md5('cancelled-job-active-promise')::uuid,md5('running-job-cancelled-promise')::uuid,md5('done-job-active-promise')::uuid)`);
    const batch = await selectBatch();
    expect(batch).toHaveLength(6);
    expect(new Set(batch.map((row) => row.sim_job_id)).size).toBe(6);
    expect(batch[0].sim_job_id).toBe(eligible.id);
    const ownedLanes = new Map<string, number>();
    const sequences = new Map<string, number[]>();
    for (let round = 0; round < 12; round += 1) {
      for (let lane = 0; lane < 4; lane += 1) {
        const pass = round % 2 === 0 ? "active" : "backlog";
        const rows = await transaction.execute(
          progressivePublicationSelectionSql(lane, 4, pass),
        );
        expect(rows).toEqual(await expected(pass, lane, 4));
        if (!rows.length) continue;
        const executionId = String(rows[0].sim_job_id);
        expect(ownedLanes.get(executionId) ?? lane).toBe(lane);
        ownedLanes.set(executionId, lane);
        const [acknowledged] =
          await transaction.execute(sql`UPDATE progressive_worker_reports
          SET acknowledged_at=clock_timestamp() WHERE sim_job_id=${executionId}::uuid
            AND sequence=(SELECT min(sequence) FROM progressive_worker_reports
              WHERE sim_job_id=${executionId}::uuid AND acknowledged_at IS NULL)
          RETURNING sequence`);
        sequences.set(executionId, [
          ...(sequences.get(executionId) ?? []),
          Number(acknowledged.sequence),
        ]);
      }
    }
    expect(sequences.size).toBe(6);
    for (const sequence of sequences.values()) expect(sequence).toEqual([1, 2]);
    expect(await select()).toEqual([]);
    await transaction.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=NULL
      WHERE sim_job_id IN (md5('eligible')::uuid,md5('cancelled')::uuid,md5('expired')::uuid,
        md5('cancelled-job-active-promise')::uuid,md5('running-job-cancelled-promise')::uuid,md5('done-job-active-promise')::uuid)`);
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
          for (const pass of ["active", "backlog"] as const)
            expect(
              await nested.execute(
                progressivePublicationSelectionSql(0, 1, pass),
              ),
            ).toEqual([]);
          throw rollback;
        }),
      ).rejects.toBe(rollback);
    }
    const corruptHeadRollback = new Error("restore corrupt head fixture");
    await expect(
      transaction.transaction(async (nested) => {
        await nested.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp()
        WHERE sim_job_id<>md5('wrong-report-solver')::uuid`);
        await nested.execute(sql`UPDATE progressive_worker_reports
        SET report=jsonb_build_object('solverId',md5('solver')::uuid)
        WHERE sim_job_id=md5('wrong-report-solver')::uuid AND sequence=2`);
        const [blocked] = await nested.execute(sql`SELECT id,
        mod((hashtext(id::text)::bigint & 2147483647),4)::int AS lane
        FROM fixture_jobs WHERE variant='wrong-report-solver'`);
        for (const laneCount of [1, 4]) {
          const lane = laneCount === 1 ? 0 : Number(blocked.lane);
          for (const pass of ["active", "backlog"] as const)
            expect(
              await nested.execute(
                progressivePublicationSelectionSql(lane, laneCount, pass),
              ),
            ).toEqual([]);
        }
        expect(
          await nested.execute(progressivePublicationBatchSelectionSql()),
        ).toEqual([]);
        const pending =
          await nested.execute(sql`SELECT sequence FROM progressive_worker_reports
        WHERE sim_job_id=${blocked.id}::uuid AND acknowledged_at IS NULL ORDER BY sequence`);
        expect(pending.map((row) => Number(row.sequence))).toEqual([1, 2]);
        await nested.execute(sql`UPDATE progressive_worker_reports
        SET report=jsonb_build_object('solverId',md5('solver')::uuid)
        WHERE sim_job_id=${blocked.id}::uuid AND sequence=1`);
        for (const laneCount of [1, 4]) {
          const lane = laneCount === 1 ? 0 : Number(blocked.lane);
          for (const pass of ["active", "backlog"] as const)
            expect(
              await nested.execute(
                progressivePublicationSelectionSql(lane, laneCount, pass),
              ),
            ).toEqual([{ sim_job_id: blocked.id }]);
        }
        throw corruptHeadRollback;
      }),
    ).rejects.toBe(corruptHeadRollback);
    await transaction.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,acknowledged_at,report,created_at)
      SELECT md5('eligible')::uuid,sequence,CASE WHEN sequence<80000 THEN clock_timestamp() ELSE NULL::timestamptz END,
        jsonb_build_object('solverId',md5('solver')::uuid,'diagnostic',repeat(md5(sequence::text),100)),
        timestamptz '2026-01-03T00:00:00Z'+sequence*interval '1 second' FROM generate_series(3,84000) sequence`);
    await transaction.execute(sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp()
      WHERE sim_job_id=md5('eligible')::uuid AND sequence<80000`);
    await transaction.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,acknowledged_at,report,created_at)
      SELECT md5('done-job-active-promise')::uuid,sequence,NULL::timestamptz,
        jsonb_build_object('solverId',md5('solver')::uuid),
        timestamptz '2026-01-01T00:00:00Z'+sequence*interval '1 second' FROM generate_series(3,4000) sequence`);
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
    const [eligibleLane] = await transaction.execute(sql`SELECT
      mod((hashtext(${eligible.id}::text)::bigint & 2147483647), 4)::int AS lane`);
    for (const laneCount of [1, 4]) {
      const lane = laneCount === 1 ? 0 : Number(eligibleLane.lane);
      for (const pass of ["active", "backlog"] as const) {
        const query = progressivePublicationSelectionSql(lane, laneCount, pass);
        const [explained] = await transaction.execute(
          sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`,
        );
        const plan = (
          explained["QUERY PLAN"] as Array<Record<string, unknown>>
        )[0];
        const nodes: Array<Record<string, unknown>> = [];
        const visit = (node: Record<string, unknown>) => {
          nodes.push(node);
          for (const child of (node.Plans ?? []) as Array<
            Record<string, unknown>
          >)
            visit(child);
        };
        visit(plan.Plan as Record<string, unknown>);
        const scans = nodes.filter(
          (node) => node["Relation Name"] === "progressive_worker_reports",
        );
        const scannedRows = scans.reduce(
          (total, node) =>
            total +
            Number(node["Actual Loops"]) *
              (Number(node["Actual Rows"]) +
                Number(node["Rows Removed by Filter"] ?? 0)),
          0,
        );
        console.info(
          JSON.stringify({
            pass,
            lane,
            laneCount,
            scannedRows,
            publicationPlan: scans,
            reportSelectionMs: plan["Execution Time"],
          }),
        );
        const expectedIndex =
          pass === "active" || laneCount > 1
            ? "fixture_publication_pending_idx"
            : "fixture_publication_order_idx";
        expect(
          scans.some(
            (node) =>
              node["Index Name"] === expectedIndex &&
              Number(node["Actual Loops"]) > 0,
          ),
        ).toBe(true);
        expect(scannedRows).toBeLessThan(32);
        expect(scans.some((node) => node["Node Type"] === "Seq Scan")).toBe(
          false,
        );
        expect(await transaction.execute(query)).toEqual(
          await expected(pass, lane, laneCount),
        );
      }
    }
  });
}, 120000);
