import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql, type SQL } from "drizzle-orm";
import { createClient } from "../src/client";
import {
  attemptEvidenceArrayLengthSql,
  attemptEvidenceHasForceHistorySql,
} from "../src/attempt-evidence-consumers";

// Run only through test.attempt-inline-explain's dedicated PostgreSQL fixture.
// The migrated 0208 SQL functions run against temporary settled-row data.
const client = createClient({ max: 1 });
const reports: unknown[] = [];
const regressions: string[] = [];
const inputs = [
  "../src/attempt-evidence-consumers.ts",
  "../src/attempt-evidence-projection.ts",
  "../src/polar-cache.ts",
  "../src/precalc-obligations.ts",
  "../migrations/0208_attempt_history_readthrough.sql",
  "../migrations/0210_stopped_progressive_attempt_history.sql",
];
const sourceIdentity = async () =>
  Object.fromEntries(
    await Promise.all(
      inputs.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(new URL(file, import.meta.url)))
          .digest("hex"),
      ]),
    ),
  );
const inputDigests = await sourceIdentity();
const median = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
try {
  await client.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout='30s'`);
    await tx.execute(sql`SET LOCAL jit=off`);
    await tx.execute(sql`CREATE TEMP TABLE attempt_inline_fixture (
      id uuid PRIMARY KEY, evidence_archive_id uuid, evidence_payload jsonb NOT NULL,
      unrelated_payload jsonb NOT NULL, status text NOT NULL
    ) ON COMMIT DROP`);
    await tx.execute(sql`CREATE TEMP TABLE attempt_inline_projection (
      result_attempt_id uuid,archive_id uuid,projection jsonb,
      PRIMARY KEY(result_attempt_id,archive_id)
    ) ON COMMIT DROP`);
    await tx.execute(sql`WITH samples AS (
      SELECT jsonb_agg(i ORDER BY i) AS t, jsonb_agg((i::numeric/1700) ORDER BY i) AS cl,
        jsonb_agg((0.01+i::numeric/100000) ORDER BY i) AS cd FROM generate_series(1,1024) i
    ), frames AS (
      SELECT jsonb_agg(jsonb_build_object('i',i,'t',i::numeric/40,'cl',0.4,'cd',0.02,'cm',0.001) ORDER BY i) AS frames
      FROM generate_series(1,120) i
    ) INSERT INTO attempt_inline_fixture
      SELECT md5(g::text)::uuid,NULL,
        jsonb_build_object('fidelity','rans','mesh_recovery_version',1,'settled_fixture',g,
          'steady_history',jsonb_build_object('iterations',samples.t,'cl',samples.cl,'cd',samples.cd,'cm',samples.cd,'mean_stable',true))
          || CASE WHEN g % 16 = 0 THEN '{}'::jsonb ELSE jsonb_build_object(
            'force_history',jsonb_build_object('t',samples.t,'cl',samples.cl,'cd',samples.cd,'cm',NULL),
            'frame_track',jsonb_build_object('stationary',true,'periods_retained',5,'frames',frames.frames)) END,
        jsonb_build_object('unrelated_wide_column',samples.cl,'fixture',g),'done'
      FROM samples CROSS JOIN frames CROSS JOIN generate_series(1,512) g`);
    await tx.execute(sql`ANALYZE attempt_inline_fixture`);
    await tx.execute(sql`ANALYZE attempt_inline_projection`);
    const [fixture] = await tx.execute(sql`SELECT count(*)::int AS rows,
      min(pg_column_size(evidence_payload)) AS min_stored_payload_bytes,
      max(pg_column_size(evidence_payload)) AS max_stored_payload_bytes,
      min(octet_length(evidence_payload::text)) AS min_payload_text_bytes,
      max(octet_length(evidence_payload::text)) AS max_payload_text_bytes
      FROM attempt_inline_fixture`);
    console.info("ATTEMPT_INLINE_FIXTURE", JSON.stringify(fixture));
    const payload = sql`a.evidence_payload`;
    const normalized = sql`COALESCE(NULLIF(${payload}->'force_history','null'::jsonb),${payload}->'forceHistory')`;
    const oldForce = sql`(jsonb_typeof(${normalized})='object'
      AND jsonb_typeof((${normalized})->'t')='array' AND jsonb_typeof((${normalized})->'cl')='array'
      AND jsonb_typeof((${normalized})->'cd')='array' AND jsonb_array_length((${normalized})->'t')>0
      AND jsonb_array_length((${normalized})->'cl')>0 AND jsonb_array_length((${normalized})->'cd')>0)`;
    const oldLength = (
      path: string[],
    ) => sql`CASE WHEN jsonb_typeof(a.evidence_payload -> ${path[0]}::text -> ${path[1]}::text)='array'
      THEN jsonb_array_length(a.evidence_payload -> ${path[0]}::text -> ${path[1]}::text) END`;
    const queryCases = (
      baselineTable: SQL,
      mode: string,
    ): Array<{ name: string; before: SQL; after: SQL }> => [
      {
        name: `${mode}/classifier-force-presence`,
        before: sql`SELECT count(*) FILTER(WHERE ${oldForce}) AS present FROM ${baselineTable} a WHERE a.status='done'`,
        after: sql`SELECT count(*) FILTER(WHERE ${attemptEvidenceHasForceHistorySql(payload, sql`a`, sql`p.projection`)}) AS present
          FROM attempt_inline_fixture a LEFT JOIN attempt_inline_projection p
            ON p.result_attempt_id=a.id AND p.archive_id=a.evidence_archive_id WHERE a.status='done'`,
      },
      {
        name: `${mode}/evidence-array-counts`,
        before: sql`SELECT sum(${oldLength(["force_history", "t"])}) AS samples,sum(${oldLength(["frame_track", "frames"])}) AS frames FROM ${baselineTable} a WHERE a.status='done'`,
        after: sql`SELECT sum(${attemptEvidenceArrayLengthSql(sql`a`, ["force_history", "t"], sql`p.projection`)}) AS samples,
          sum(${attemptEvidenceArrayLengthSql(sql`a`, ["frame_track", "frames"], sql`p.projection`)}) AS frames
          FROM attempt_inline_fixture a LEFT JOIN attempt_inline_projection p
            ON p.result_attempt_id=a.id AND p.archive_id=a.evidence_archive_id WHERE a.status='done'`,
      },
    ];
    const measure = async (entry: {
      name: string;
      before: SQL;
      after: SQL;
    }) => {
      const original = [...(await tx.execute(entry.before))];
      assert.deepEqual([...(await tx.execute(entry.after))], original);
      if (entry.name.endsWith("classifier-force-presence")) {
        assert.equal(Number(original[0].present), 480);
      } else {
        assert.equal(Number(original[0].samples), 480 * 1024);
        assert.equal(Number(original[0].frames), 480 * 120);
      }
      const before: number[] = [],
        after: number[] = [];
      const buffers = { before: [] as number[], after: [] as number[] };
      const plans: Array<{ variant: string; plan: unknown }> = [];
      for (let repeat = 0; repeat < 5; repeat++) {
        const variants =
          repeat % 2
            ? ([
                ["after", entry.after],
                ["before", entry.before],
              ] as const)
            : ([
                ["before", entry.before],
                ["after", entry.after],
              ] as const);
        for (const [variant, query] of variants) {
          const [result] = await tx.execute(
            sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`,
          );
          const raw = result["QUERY PLAN"];
          const plan = (
            typeof raw === "string" ? JSON.parse(raw) : raw
          )[0] as Record<string, unknown>;
          (variant === "before" ? before : after).push(
            Number(plan["Execution Time"]),
          );
          const root = plan.Plan as Record<string, unknown>;
          buffers[variant].push(
            [
              "Shared Hit Blocks",
              "Shared Read Blocks",
              "Local Hit Blocks",
              "Local Read Blocks",
            ].reduce((sum, key) => sum + Number(root[key] ?? 0), 0),
          );
          plans.push({ variant, plan });
        }
      }
      const baselineMs = median(before),
        candidateMs = median(after);
      const summary = {
        name: entry.name,
        baselineMs,
        candidateMs,
        ratio: candidateMs / baselineMs,
        allowedMs: baselineMs * 1.15 + 2,
        repeats: 5,
        rows: 512,
        medianBlockAccesses: {
          baseline: median(buffers.before),
          candidate: median(buffers.after),
        },
      };
      reports.push({ summary, before, after, plans });
      console.info("ATTEMPT_INLINE_EXPLAIN", JSON.stringify(summary));
      if (candidateMs > summary.allowedMs)
        regressions.push(`${entry.name}: ${candidateMs}ms vs ${baselineMs}ms`);
    };
    for (const entry of queryCases(sql`attempt_inline_fixture`, "inline"))
      await measure(entry);
    // Retain originals only in this disposable benchmark. Mix real 0208 cold
    // projections with inline rows to measure the actual joined-facts branch.
    await tx.execute(
      sql`CREATE TEMP TABLE attempt_inline_original ON COMMIT DROP AS SELECT * FROM attempt_inline_fixture`,
    );
    await tx.execute(sql`INSERT INTO attempt_inline_projection(result_attempt_id,archive_id,projection)
      SELECT id,id,attempt_evidence_make_projection(evidence_payload,id,id) FROM attempt_inline_fixture WHERE NOT (evidence_payload ? 'force_history')`);
    await tx.execute(sql`UPDATE attempt_inline_fixture a SET evidence_payload=attempt_evidence_compact(a.evidence_payload),evidence_archive_id=p.archive_id
      FROM attempt_inline_projection p WHERE p.result_attempt_id=a.id`);
    await tx.execute(sql`ANALYZE attempt_inline_fixture`);
    const [cohort] = await tx.execute(
      sql`SELECT count(*)::int AS n FROM attempt_inline_fixture WHERE evidence_archive_id IS NOT NULL`,
    );
    assert.equal(cohort.n, 32);
    await tx.execute(sql`ANALYZE attempt_inline_projection`);
    await tx.execute(sql`ANALYZE attempt_inline_original`);
    for (const entry of queryCases(
      sql`attempt_inline_original`,
      "mixed-32-cold",
    ))
      await measure(entry);
    // Exercise the migrated recovery index on synthetic recipe rows.
    await tx.execute(sql`CREATE TEMP TABLE attempt_recovery_cost
      (LIKE progressive_cfd_recovery_plans INCLUDING DEFAULTS INCLUDING INDEXES) ON COMMIT DROP`);
    await tx.execute(sql`INSERT INTO attempt_recovery_cost(unit_id,ordinal,parent_attempt_token,parent_job_id,
      diagnostic_attempt_id,diagnostic_signature,scope,reason,recipe) SELECT gen_random_uuid(),1,gen_random_uuid(),gen_random_uuid(),
      gen_random_uuid(),repeat('a',64),'targeted','needs_urans',jsonb_build_object('padding',repeat('x',1400))
      FROM generate_series(1,32768)`);
    await tx.execute(sql`ANALYZE attempt_recovery_cost`);
    const [summary] = await tx.execute(sql`SELECT idx.oid::regclass::text AS name
      FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_am am ON am.oid=idx.relam
      WHERE i.indrelid='attempt_recovery_cost'::regclass AND am.amname='brin'`);
    await tx.execute(sql`SELECT brin_summarize_new_values(${summary.name}::regclass)`);
    const [size] = await tx.execute(sql`SELECT pg_relation_size(${summary.name}::regclass)::integer AS bytes`);
    const missingDiagnostic = sql`SELECT 1 FROM attempt_recovery_cost
      WHERE diagnostic_attempt_id='00000000-0000-0000-0000-000000000000'::uuid`;
    const [lookup] = await tx.execute(sql`SELECT proconfig FROM pg_proc
      WHERE oid='attempt_evidence_has_recovery_plan(uuid)'::regprocedure`);
    assert.ok((lookup.proconfig as string[]).includes("enable_seqscan=off"));
    for (const indexed of [false, true]) {
      if (indexed) {
        // Match the worker's single-ID lookup settings for this EXPLAIN.
        await tx.execute(sql`SET LOCAL enable_seqscan=off`);
        await tx.execute(sql`SET LOCAL enable_indexscan=on`);
        await tx.execute(sql`SET LOCAL enable_bitmapscan=on`);
      } else {
        await tx.execute(sql`SET LOCAL enable_indexscan=off`);
        await tx.execute(sql`SET LOCAL enable_bitmapscan=off`);
      }
      const [row] = await tx.execute(sql`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${missingDiagnostic}`);
      const raw = row["QUERY PLAN"];
      const plan = (typeof raw === "string" ? JSON.parse(raw) : raw)[0];
      const root = plan.Plan;
      assert.equal(root["Actual Rows"], 0);
      assert.match(root["Node Type"], indexed ? /Index|Bitmap/ : /Seq Scan/);
      const timing = { indexed, indexBytes: size.bytes, node: root["Node Type"], executionMs: plan["Execution Time"],
        blocks: root["Local Hit Blocks"] + root["Local Read Blocks"] };
      if (indexed) assert.ok(timing.blocks < 300 && Number(size.bytes) < 262144);
      console.info("STOPPED_DIAGNOSTIC_LOOKUP", JSON.stringify(timing));
      reports.push({ name: "stopped-diagnostic-lookup", ...timing, plan });
    }
    assert.deepEqual(
      regressions,
      [],
      "query cost increased beyond 15% plus 2ms noise allowance",
    );
    assert.deepEqual(
      await sourceIdentity(),
      inputDigests,
      "performance inputs changed during measurement",
    );
    console.info("ATTEMPT_QUERY_INPUTS", JSON.stringify(inputDigests));
  });
} finally {
  const directory = process.env.DEVCOORDINATOR_DIAGNOSTICS_DIR;
  if (directory) {
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "attempt-inline-explain.json"),
      JSON.stringify({ inputDigests, reports }, null, 2),
    );
  }
  await client.sql.end();
}
