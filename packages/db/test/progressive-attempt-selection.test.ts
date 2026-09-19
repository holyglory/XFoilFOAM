import { afterAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createClient } from "../src/client";
import { progressiveCfdOrdinaryAttemptCountSql } from "../src/progressive-attempt-budget";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

it("counts only exact proven unstarted cancellations without scanning unrelated attempt history", async () => {
  await client.db.transaction(async (transaction) => {
    await transaction.execute(sql`CREATE TEMP TABLE fixture_units ON COMMIT DROP AS
      SELECT md5(variant)::uuid AS id,variant FROM unnest(ARRAY['fresh','valid-zero-work','missing-stop',
        'wrong-stop','had-time','has-evidence','failed','running','publication-correction','combined-correction']) variant`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_units ON COMMIT DROP AS
      SELECT id,CASE WHEN variant='fresh' THEN 0 ELSE 2 END AS attempts,0 AS ordinal FROM fixture_units`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_units_id_idx ON progressive_cfd_units(id)`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_attempts ON COMMIT DROP AS
      SELECT id AS token,id AS unit_id,id AS sim_job_id,
        CASE WHEN variant IN ('failed','running') THEN variant ELSE 'cancelled' END AS outcome,
        CASE WHEN variant='had-time' THEN 1 ELSE 0 END::double precision AS active_seconds
      FROM fixture_units WHERE variant NOT IN ('fresh','publication-correction')`);
    await transaction.execute(sql`CREATE UNIQUE INDEX fixture_attempt_job_unit_idx
      ON progressive_cfd_attempts(sim_job_id,unit_id) WHERE sim_job_id IS NOT NULL`);
    await transaction.execute(sql`CREATE UNIQUE INDEX fixture_attempt_running_idx
      ON progressive_cfd_attempts(unit_id) WHERE outcome='running'`);
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_execution_stops ON COMMIT DROP AS
      SELECT id AS sim_job_id,jsonb_build_object('ownership_basis',
        CASE WHEN variant='wrong-stop' THEN 'execution_lock' ELSE 'never_started_cancellation_fence' END) AS proof
      FROM fixture_units WHERE variant<>'missing-stop'`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_stops_idx ON progressive_cfd_execution_stops(sim_job_id)`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_cfd_evidence ON COMMIT DROP AS
      SELECT id AS attempt_token FROM fixture_units WHERE variant='has-evidence'`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_evidence_idx ON progressive_cfd_evidence(attempt_token)`,
    );
    await transaction.execute(sql`CREATE TEMP TABLE progressive_publication_recovery_claims ON COMMIT DROP AS
      SELECT id AS unit_id FROM fixture_units WHERE variant IN ('publication-correction','combined-correction')`);
    await transaction.execute(
      sql`CREATE UNIQUE INDEX fixture_publication_claims_idx ON progressive_publication_recovery_claims(unit_id)`,
    );
    const counts = () =>
      transaction.execute(sql`SELECT fixture.variant,${progressiveCfdOrdinaryAttemptCountSql()} AS ordinary
      FROM progressive_cfd_units unit JOIN fixture_units fixture ON fixture.id=unit.id ORDER BY fixture.variant`);
    const expected = [
      { variant: "combined-correction", ordinary: 0 },
      { variant: "failed", ordinary: 2 },
      { variant: "fresh", ordinary: 0 },
      { variant: "had-time", ordinary: 2 },
      { variant: "has-evidence", ordinary: 2 },
      { variant: "missing-stop", ordinary: 2 },
      { variant: "publication-correction", ordinary: 1 },
      { variant: "running", ordinary: 2 },
      { variant: "valid-zero-work", ordinary: 1 },
      { variant: "wrong-stop", ordinary: 2 },
    ];
    expect(await counts()).toEqual(expected);
    await transaction.execute(sql`INSERT INTO progressive_cfd_units(id,attempts,ordinal)
      SELECT md5('pending-'||ordinal)::uuid,0,0 FROM generate_series(1,64000) ordinal`);
    await transaction.execute(sql`INSERT INTO progressive_cfd_attempts(token,unit_id,sim_job_id,outcome,active_seconds)
      SELECT md5('history-'||ordinal)::uuid,md5('history-'||ordinal)::uuid,md5('job-'||ordinal)::uuid,
        CASE WHEN ordinal%3=0 THEN 'running' WHEN ordinal%3=1 THEN 'cancelled' ELSE 'failed' END,
        CASE WHEN ordinal%3=0 THEN 0 ELSE 1 END FROM generate_series(1,6000) ordinal`);
    await transaction.execute(sql`ANALYZE progressive_cfd_units,progressive_cfd_attempts,progressive_cfd_execution_stops,
      progressive_cfd_evidence,progressive_publication_recovery_claims,fixture_units`);
    const explain = async () => {
      const [explained] =
        await transaction.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
        SELECT unit.id FROM progressive_cfd_units unit WHERE ${progressiveCfdOrdinaryAttemptCountSql()}<2
        ORDER BY unit.ordinal,unit.id LIMIT 1`);
      return (explained["QUERY PLAN"] as Array<Record<string, unknown>>)[0];
    };
    const baseline = await explain();
    const [index] =
      await transaction.execute(sql`SELECT indisvalid,pg_get_indexdef(indexrelid) AS definition
      FROM pg_index WHERE indexrelid='public.progressive_cfd_attempts_unstarted_idx'::regclass`);
    expect(index.indisvalid).toBe(true);
    const definition = String(index.definition)
      .replace(
        "progressive_cfd_attempts_unstarted_idx",
        "fixture_unstarted_idx",
      )
      .replace("public.progressive_cfd_attempts", "progressive_cfd_attempts");
    await transaction.execute(sql.raw(definition));
    await transaction.execute(sql`ANALYZE progressive_cfd_attempts`);
    expect(await counts()).toEqual(expected);
    const indexed = await explain();
    const nodes: Array<Record<string, unknown>> = [];
    const visit = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>)
        visit(child);
    };
    visit(indexed.Plan as Record<string, unknown>);
    const lookup = nodes.find(
      (node) => node["Index Name"] === "fixture_unstarted_idx",
    );
    expect(lookup).toBeDefined();
    expect(
      nodes.some(
        (node) =>
          node["Relation Name"] === "progressive_cfd_attempts" &&
          node["Node Type"] === "Seq Scan",
      ),
    ).toBe(false);
    const baselineBuffers = Number(
      (baseline.Plan as Record<string, unknown>)["Local Hit Blocks"],
    );
    const indexedBuffers = Number(
      (indexed.Plan as Record<string, unknown>)["Local Hit Blocks"],
    );
    expect(indexedBuffers).toBeLessThan(baselineBuffers / 4);
    console.info(
      JSON.stringify({
        pendingUnits: 64010,
        storedAttempts: 6008,
        baselineMs: baseline["Execution Time"],
        indexedMs: indexed["Execution Time"],
        baselineBuffers,
        indexedBuffers,
        lookup: {
          type: lookup?.["Node Type"],
          rows: lookup?.["Actual Rows"],
          loops: lookup?.["Actual Loops"],
        },
      }),
    );
  });
}, 120000);
