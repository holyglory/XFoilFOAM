import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { OPENCFD_2606_ENGINE } from "../../engine-client/src/engine-identity";
import { selectPendingProgressiveRemoteReport } from "../../../apps/sweeper/src/progressive-remote-settlement";
import {
  backfillProgressiveReportPayloads,
  progressiveReportStorageSample,
  setProgressiveReportNormalization,
} from "../src/progressive-report-payloads";
import { retainedSolverReportDownload } from "../src/retained-solver-reports";
import {
  readPendingProgressiveWorkerReport,
  acknowledgeProgressiveWorkerReport,
} from "../src/progressive-worker-reports";
import { analysisContentHash } from "../src/analysis-target";
import { createClient, type DB } from "../src/client";
import { sealProgressiveRemoteExecution } from "../src/progressive-remote-execution";
import type { ProgressiveRemoteReport } from "../src/progressive-remote-report";
import { storeProgressiveRemoteReport } from "../src/progressive-remote-reports";
import { readProgressiveRemoteRetention } from "../src/progressive-remote-retention";
import {
  PROGRESSIVE_REPORT_RETENTION_DISABLED,
  reclaimProgressiveReportHistory,
} from "../src/progressive-report-retention";

const client = createClient({ max: 1 });
afterAll(() => client.sql.end());

const historyTables = [
  "progressive_remote_reports",
  "progressive_remote_report_inventories",
  "progressive_remote_report_sources",
  "progressive_remote_progress_receipts",
  "progressive_remote_evidence_receipts",
  "progressive_remote_diagnostic_receipts",
] as const;

async function snapshot(db: DB) {
  const rows = [];
  for (const table of [
    ...historyTables,
    "sim_jobs",
    "result_attempts",
    "progressive_cfd_evidence",
  ]) {
    rows.push([
      table,
      [
        ...(await db.execute(sql`SELECT to_jsonb(item) AS value
      FROM ${sql.identifier(table)} item ORDER BY to_jsonb(item)::text`)),
      ],
    ]);
  }
  return rows;
}

async function fixture(
  db: DB,
  options: { payloadBytes?: number; repeats?: number } = {},
) {
  // Temporary ownership rows avoid campaigns, registries and other suites. The
  // report tables and their cascading foreign keys come from the migrated DB.
  await db.execute(sql`CREATE TEMP TABLE sim_jobs (id uuid PRIMARY KEY,
    campaign_id uuid NOT NULL, status text NOT NULL, engine_job_id text,
    "ingestedAt" timestamptz) ON COMMIT DROP`);
  await db.execute(sql`CREATE TEMP TABLE registered_remote_solvers
    (id uuid PRIMARY KEY, revoked_at timestamptz) ON COMMIT DROP`);
  await db.execute(sql`CREATE TEMP TABLE progressive_remote_dispatches
    (sim_job_id uuid PRIMARY KEY, solver_id uuid, promise_id uuid,
    content_signature text, envelope jsonb) ON COMMIT DROP`);
  await db.execute(sql`CREATE TEMP TABLE sync_sweep_promises
    (id uuid PRIMARY KEY, request_payload jsonb) ON COMMIT DROP`);
  await db.execute(sql`CREATE TEMP TABLE result_attempts
    (id uuid PRIMARY KEY, evidence_payload jsonb) ON COMMIT DROP`);
  await db.execute(sql`CREATE TEMP TABLE progressive_cfd_evidence
    (result_attempt_id uuid PRIMARY KEY, evidence_signature text) ON COMMIT DROP`);
  // The cloned report FKs below reference the local archive catalog too.
  await db.execute(sql`CREATE TEMP TABLE progressive_report_archive_bundles
    (LIKE public.progressive_report_archive_bundles INCLUDING ALL) ON COMMIT DROP`);
  for (const table of historyTables) {
    await db.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)}
      (LIKE ${sql.identifier("public")}.${sql.identifier(table)} INCLUDING ALL) ON COMMIT DROP`);
    const constraints =
      await db.execute(sql`SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid=${`public.${table}`}::regclass AND contype='f'`);
    for (const constraint of constraints) {
      // PostgreSQL prohibits TEMP -> permanent FKs. Canonical payload integrity
      // is enforced by the real function; the public FK is checked separately.
      if (
        String(constraint.definition).includes(
          "progressive_report_result_payloads",
        )
      )
        continue;
      const definition = String(constraint.definition).replace(
        /REFERENCES (?:public\.)?(\w+)/g,
        (_match, target: string) =>
          `REFERENCES ${target === "progressive_report_result_payloads" ? "public" : "pg_temp"}.${target}`,
      );
      await db.execute(sql`ALTER TABLE ${sql.identifier(table)} ADD CONSTRAINT
        ${sql.identifier(String(constraint.conname))} ${sql.raw(definition)}`);
    }
  }

  const executionId = randomUUID();
  const campaignId = randomUUID();
  const unit = {
    unitId: randomUUID(),
    token: randomUUID(),
    alpha: 0,
    activeBudgetSeconds: 900,
  };
  const envelope = sealProgressiveRemoteExecution({
    solverId: randomUUID(),
    promiseId: randomUUID(),
    scope: {
      executionContract: "progressive-cfd-v1",
      executionId,
      epochId: randomUUID(),
      generationId: randomUUID(),
      targetId: "a".repeat(64),
      recipeId: "b".repeat(64),
      stage: 2,
      tokens: [unit.token],
      units: [unit],
    },
    request: {
      execution_id: executionId,
      expected_engine: { ...OPENCFD_2606_ENGINE },
      expected_execution_pool: "retention-test",
      expected_solver_budget_version: 2,
      expected_mesh_recovery_version: 1,
      airfoil: { name: "retention-protocol-fixture" },
      chord_lengths: [1],
      speeds: [30],
      aoa: { angles: [0] },
      solver: { warm_start: true },
      resources: { case_concurrency: 1, case_solver_budget_seconds: 900 },
    },
  });
  await db.execute(sql`INSERT INTO sim_jobs VALUES (${executionId}::uuid,
    ${campaignId}::uuid, 'failed', ${executionId}, clock_timestamp())`);
  await db.execute(
    sql`INSERT INTO registered_remote_solvers VALUES (${envelope.solverId}::uuid, NULL)`,
  );
  await db.execute(sql`INSERT INTO progressive_remote_dispatches VALUES (${executionId}::uuid,
    ${envelope.solverId}::uuid, ${envelope.promiseId}::uuid, ${envelope.contentSignature},
    ${JSON.stringify(envelope)}::jsonb)`);
  await db.execute(sql`INSERT INTO sync_sweep_promises VALUES (${envelope.promiseId}::uuid,
    ${JSON.stringify(envelope)}::jsonb)`);
  const runtime = {
    ...OPENCFD_2606_ENGINE,
    build_id: "isolated-test-build",
    application_source_sha256: "c".repeat(64),
  };
  const initial: ProgressiveRemoteReport = {
    version: 1,
    solverId: envelope.solverId,
    promiseId: envelope.promiseId,
    executionId,
    assignmentSignature: envelope.contentSignature,
    sequence: 1,
    status: {
      job_id: executionId,
      state: "running",
      total_cases: 1,
      completed_cases: 0,
      engine: runtime,
    },
    result: null,
    stopProof: null,
  };
  const partial: ProgressiveRemoteReport = {
    ...initial,
    sequence: 2,
    status: { ...initial.status, completed_cases: 1 },
    result: {
      job_id: executionId,
      state: "running",
      engine: runtime,
      execution_pool: "retention-test",
      polars: [
        {
          chord: 1,
          speed: 30,
          reynolds: 2_000_000,
          points: [],
          attempts: [
            {
              aoa_deg: 0,
              cl: null,
              cd: null,
              cm: null,
              converged: false,
              unsteady: false,
              first_order_fallback: false,
              images: {},
              engine: runtime,
              solver_active_seconds: 48,
              failure_disposition: "hard_solver",
              error: options.payloadBytes
                ? "x".repeat(options.payloadBytes)
                : "isolated unconverged protocol fixture",
            },
          ],
        },
      ],
    },
  };
  const terminal: ProgressiveRemoteReport = {
    ...partial,
    sequence: (options.repeats ?? 2) + 2,
    status: { ...partial.status, state: "failed" },
    // The historical source remains relevant even when the final report omits it.
    result: { ...partial.result!, state: "failed", polars: [] },
    stopProof: {
      version: 1,
      job_id: executionId,
      execution_stopped: true,
      producer_stopped: true,
      namespace_verified: true,
      remaining: [],
      observed_at: "2026-11-10T13:00:00Z",
      error: null,
      fence: "terminal_result",
      ownership_basis: "recorded_execution_namespace",
    },
  };
  const sender = {
    executionId,
    solverId: envelope.solverId,
    promiseId: envelope.promiseId,
  };
  const reports = [
    initial,
    ...Array.from({ length: options.repeats ?? 2 }, (_, index) => ({
      ...partial,
      sequence: index + 2,
    })),
    terminal,
  ];
  for (const report of reports)
    await storeProgressiveRemoteReport(db, { ...sender, report });
  await db.execute(sql`INSERT INTO progressive_remote_progress_receipts
    (sim_job_id,sequence,content_signature) SELECT sim_job_id,sequence,content_signature
    FROM progressive_remote_reports`);
  const attemptId = randomUUID();
  const payload = { kind: "isolated-retention-protocol-fixture" };
  await db.execute(
    sql`INSERT INTO result_attempts VALUES (${attemptId}::uuid, ${JSON.stringify(payload)}::jsonb)`,
  );
  await db.execute(
    sql`INSERT INTO progressive_cfd_evidence VALUES (${attemptId}::uuid, ${analysisContentHash(payload)})`,
  );
  await db.execute(sql`INSERT INTO progressive_remote_evidence_receipts
    (sim_job_id,sequence,point_content_signature,result_attempt_id,remote_result_id,remote_result_attempt_id)
    SELECT sim_job_id,sequence,point_content_signature,${attemptId}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid
    FROM progressive_remote_report_sources WHERE sequence=2`);
  return { executionId, campaignId, sender, reports, terminal, envelope };
}

async function normalizedFixture(
  db: DB,
  options: { payloadBytes?: number; repeats?: number } = {},
) {
  const input = await fixture(db, options);
  await db.execute(sql`CREATE TEMP TABLE progressive_worker_reports
    (LIKE public.progressive_worker_reports INCLUDING ALL) ON COMMIT DROP`);
  await db.execute(
    sql`ALTER TABLE progressive_worker_reports ADD FOREIGN KEY (sim_job_id) REFERENCES sim_jobs(id)`,
  );
  for (const table of [
    "progressive_worker_reports",
    "progressive_remote_reports",
  ]) {
    await db.execute(sql`CREATE TRIGGER normalize_report BEFORE INSERT ON ${sql.identifier(table)}
      FOR EACH ROW EXECUTE FUNCTION public.normalize_progressive_report_insert()`);
    await db.execute(sql`CREATE TRIGGER immutable_report BEFORE UPDATE ON ${sql.identifier(table)}
      FOR EACH ROW EXECUTE FUNCTION ${sql.raw(
        table === "progressive_worker_reports"
          ? "public.protect_progressive_worker_report()"
          : "public.protect_progressive_remote_report()",
      )}`);
  }
  return input;
}

async function rolledBack(run: (db: DB) => Promise<void>) {
  const rollback = new Error(
    "Rollback immutable payload fixture, including policy and payload inserts",
  );
  await client.db
    .transaction(async (transaction) => {
      await run(transaction as unknown as DB);
      throw rollback;
    })
    .catch((error) => {
      if (error !== rollback) throw error;
    });
}

async function rejectsStatement(
  db: DB,
  statement: ReturnType<typeof sql>,
  message: string | RegExp,
) {
  await expect(
    db.transaction(async (transaction) => {
      await transaction.execute(statement);
    }),
  ).rejects.toThrow(message);
}

it("shares repeated large results losslessly across report history while preserving replay, inventories, evidence and downloads", async () => {
  await rolledBack(async (db) => {
    const input = await normalizedFixture(db, {
      payloadBytes: 256 * 1024,
      repeats: 16,
    });
    const before = await snapshot(db);
    const retained = await readProgressiveRemoteRetention(
      db,
      input.executionId,
    );
    // The schema upgrade leaves legacy INSERTs inline until explicit activation.
    const next = { ...input.terminal, sequence: input.terminal.sequence + 1 };
    await storeProgressiveRemoteReport(db, { ...input.sender, report: next });
    const [inline] = await db.execute(
      sql`SELECT result_payload_hash FROM progressive_remote_reports WHERE sequence=${next.sequence}`,
    );
    expect(inline.result_payload_hash).toBeNull();
    await expect(
      setProgressiveReportNormalization(db, {
        enabled: true,
        readersReady: false,
      }),
    ).rejects.toThrow("verify all report readers");
    await expect(
      backfillProgressiveReportPayloads(db, {
        table: "progressive_remote_reports",
        apply: true,
      }),
    ).rejects.toThrow("normalization is disabled");
    const dry = await backfillProgressiveReportPayloads(db, {
      table: "progressive_remote_reports",
      rows: 128,
    });
    expect(dry).toMatchObject({
      applied: false,
      normalized: 18,
      complete: true,
    });
    expect(
      (
        await db.execute(
          sql`SELECT count(*)::integer AS n FROM progressive_remote_reports WHERE result_payload_hash IS NOT NULL`,
        )
      )[0].n,
    ).toBe(0);
    await setProgressiveReportNormalization(db, {
      enabled: true,
      readersReady: true,
    });
    const final = { ...next, sequence: next.sequence + 1 };
    await storeProgressiveRemoteReport(db, { ...input.sender, report: final });
    // Compare the same nonempty retained-source classification before and
    // after compaction, including exact evidence receipt and inventory ownership.
    const retentionBeforeCompaction = await readProgressiveRemoteRetention(
      db,
      input.executionId,
    );
    expect(retentionBeforeCompaction).toEqual({ ...retained, report: final });
    const [normalized] = await db.execute(sql`SELECT report,result_payload_hash,
      public.resolve_progressive_report(to_jsonb(stored.*)) AS full FROM progressive_remote_reports stored WHERE sequence=${final.sequence}`);
    expect(normalized.report).toMatchObject({ result: { state: "failed" } });
    expect(normalized.full).toEqual(final);
    expect(normalized.result_payload_hash).toMatch(/^[a-f0-9]{64}$/);
    const sampleBefore = await progressiveReportStorageSample(
      db,
      "progressive_remote_reports",
      { rows: 128 },
    );
    const receipts = [];
    let after = null;
    for (let batch = 0; batch < 30; batch++) {
      const receipt = await backfillProgressiveReportPayloads(db, {
        table: "progressive_remote_reports",
        apply: true,
        rows: 3,
        maxBytes: 800_000,
        after,
      });
      expect(receipt.scanned).toBeLessThanOrEqual(3);
      expect(receipt.logicalBytesRead).toBeLessThanOrEqual(800_000);
      receipts.push(...receipt.proofs);
      after = receipt.after;
      if (receipt.complete) break;
    }
    expect(receipts).toHaveLength(18);
    expect(
      await backfillProgressiveReportPayloads(db, {
        table: "progressive_remote_reports",
        apply: true,
        rows: 128,
      }),
    ).toMatchObject({ normalized: 0, complete: true });
    const [storage] = await db.execute(sql`SELECT count(*)::integer AS reports,
      count(DISTINCT result_payload_hash)::integer AS payloads,
      bool_and(octet_length(report::text)<10000) AS compact FROM progressive_remote_reports`);
    expect(storage).toEqual({ reports: 20, payloads: 2, compact: true });
    const [large] =
      await db.execute(sql`SELECT count(*)::integer AS n FROM public.progressive_report_result_payloads
      WHERE result->>'job_id'=${input.executionId} AND byte_size>262144`);
    expect(large.n).toBe(1);
    const sampleAfter = await progressiveReportStorageSample(
      db,
      "progressive_remote_reports",
      { rows: 128 },
    );
    expect(sampleAfter.logical_report_bytes).toBe(
      sampleBefore.logical_report_bytes,
    );
    expect(Number(sampleAfter.envelope_bytes)).toBeLessThan(
      Number(sampleBefore.envelope_bytes) / 10,
    );
    // All original identities, timestamps, signatures, inventories and evidence
    // are equal after reconstructing representation-only report changes.
    for (const report of input.reports) {
      expect(
        await storeProgressiveRemoteReport(db, { ...input.sender, report }),
      ).toMatchObject({ replayed: true });
      const [stored] =
        await db.execute(sql`SELECT public.resolve_progressive_report(to_jsonb(stored.*)) AS report,
        content_signature FROM progressive_remote_reports stored WHERE sequence=${report.sequence}`);
      expect(stored.report).toEqual(report);
      expect(stored.content_signature).toBe(analysisContentHash(report));
    }
    const current = await snapshot(db);
    for (let index = 1; index < before.length; index++) {
      // Later writer inventories are expected additions; original rows remain exact.
      const oldRows = before[index][1] as unknown[];
      const newRows = current[index][1] as unknown[];
      expect(newRows).toEqual(expect.arrayContaining(oldRows));
    }
    expect(await readProgressiveRemoteRetention(db, input.executionId)).toEqual(
      retentionBeforeCompaction,
    );
    await db.execute(
      sql`CREATE TEMP TABLE airfoils(id uuid PRIMARY KEY,slug text) ON COMMIT DROP`,
    );
    await db.execute(
      sql`INSERT INTO airfoils VALUES (${input.executionId}::uuid,'payload-fixture')`,
    );
    await db.execute(sql`ALTER TABLE sim_jobs ADD COLUMN airfoil_id uuid`);
    await db.execute(
      sql`UPDATE sim_jobs SET airfoil_id=${input.executionId}::uuid`,
    );
    await db.execute(
      sql`CREATE TEMP TABLE progressive_cfd_execution_stops(sim_job_id uuid,engine_job_id text) ON COMMIT DROP`,
    );
    await db.execute(
      sql`INSERT INTO progressive_cfd_execution_stops VALUES (${input.executionId}::uuid,${input.executionId})`,
    );
    const download = await retainedSolverReportDownload(db, {
      executionId: input.executionId,
      sequence: 2,
      signature: analysisContentHash(input.reports[1]),
    });
    expect(JSON.parse(download.content)).toEqual(input.reports[1]);
    expect(download.signature).toBe(analysisContentHash(input.reports[1]));
    await expect(
      backfillProgressiveReportPayloads(db, {
        table: "progressive_remote_reports",
        apply: true,
        restoreInline: true,
      }),
    ).rejects.toThrow("Disable report normalization");
    await setProgressiveReportNormalization(db, {
      enabled: false,
      readersReady: true,
    });
    const payloadRowsBefore =
      await db.execute(sql`SELECT content_hash,byte_size FROM public.progressive_report_result_payloads
      WHERE result->>'job_id'=${input.executionId} ORDER BY content_hash`);
    let restoreAfter = null;
    let restored = 0;
    for (let batch = 0; batch < 30; batch++) {
      const receipt = await backfillProgressiveReportPayloads(db, {
        table: "progressive_remote_reports",
        apply: true,
        restoreInline: true,
        rows: 3,
        maxBytes: 800_000,
        after: restoreAfter,
      });
      restored += receipt.restored;
      restoreAfter = receipt.after;
      if (receipt.complete) break;
    }
    expect(restored).toBe(19);
    expect(
      (
        await progressiveReportStorageSample(db, "progressive_remote_reports", {
          rows: 128,
        })
      ).normalized_reports,
    ).toBe(0);
    expect(await readProgressiveRemoteRetention(db, input.executionId)).toEqual(
      retentionBeforeCompaction,
    );
    expect(
      await retainedSolverReportDownload(db, {
        executionId: input.executionId,
        sequence: 2,
        signature: analysisContentHash(input.reports[1]),
      }),
    ).toEqual(download);
    expect(
      await db.execute(sql`SELECT content_hash,byte_size FROM public.progressive_report_result_payloads
      WHERE result->>'job_id'=${input.executionId} ORDER BY content_hash`),
    ).toEqual(payloadRowsBefore);
    expect(
      await backfillProgressiveReportPayloads(db, {
        table: "progressive_remote_reports",
        apply: true,
        restoreInline: true,
        rows: 128,
      }),
    ).toMatchObject({ normalized: 0, restored: 0, complete: true });
  });
}, 120_000);

it("preserves JSONB integers, null versus absent, headers and immutable guards, including same-statement new payload visibility", async () => {
  await rolledBack(async (db) => {
    const input = await normalizedFixture(db);
    const legacy = input.terminal.sequence + 1;
    // An integer that cannot make a lossless round trip through JSON.parse.
    await db.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report)
      SELECT ${input.executionId}::uuid,${legacy},repeat('a',64),jsonb_build_object('version',1,'executionId',${input.executionId}::text,
        'sequence',${legacy}::integer,'result','{"state":"completed","polars":[],"n":9007199254740993123456789}'::jsonb)`);
    await db.execute(sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report)
      SELECT ${input.executionId}::uuid,n,repeat('b',64),jsonb_build_object('version',1,'executionId',${input.executionId}::text,'sequence',n)
        || CASE WHEN n=${legacy + 1} THEN '{"result":null}'::jsonb ELSE '{}'::jsonb END FROM generate_series(${legacy + 1}::integer,${legacy + 2}::integer) n`);
    await db.execute(
      sql`UPDATE progressive_worker_reports SET acknowledged_at=clock_timestamp() WHERE sequence=${legacy}`,
    );
    await db.execute(sql`SET LOCAL enable_seqscan=off`);
    const metadataQuery = sql`SELECT sim_job_id,sequence FROM progressive_worker_reports
      WHERE acknowledged_at IS NOT NULL AND jsonb_typeof(report->'result')='object'
      ORDER BY created_at,sim_job_id,sequence LIMIT 1`;
    const metadataBefore = await db.execute(metadataQuery);
    const planBefore = await db.execute(
      sql`EXPLAIN (VERBOSE, FORMAT JSON) ${metadataQuery}`,
    );
    await setProgressiveReportNormalization(db, {
      enabled: true,
      readersReady: true,
    });
    await backfillProgressiveReportPayloads(db, {
      table: "progressive_worker_reports",
      apply: true,
    });
    expect(await db.execute(metadataQuery)).toEqual(metadataBefore);
    const planAfter = await db.execute(
      sql`EXPLAIN (VERBOSE, FORMAT JSON) ${metadataQuery}`,
    );
    const indexes = (value: unknown) =>
      [...JSON.stringify(value).matchAll(/"Index Name":"([^"]+)"/g)].map(
        (match) => match[1],
      );
    expect(indexes(planBefore).length).toBeGreaterThan(0);
    expect(indexes(planAfter)).toEqual(indexes(planBefore));
    expect(JSON.stringify(planAfter)).not.toContain(
      "resolve_progressive_report",
    );
    const foreignKeys =
      await db.execute(sql`SELECT (SELECT relname FROM pg_class WHERE oid=conrelid) AS source,confdeltype
      FROM pg_constraint WHERE contype='f' AND confrelid='public.progressive_report_result_payloads'::regclass
        AND conrelid IN ('public.progressive_worker_reports'::regclass,'public.progressive_remote_reports'::regclass)
      ORDER BY source`);
    expect(foreignKeys).toEqual([
      { source: "progressive_remote_reports", confdeltype: "r" },
      { source: "progressive_worker_reports", confdeltype: "r" },
    ]);
    const values =
      await db.execute(sql`SELECT public.resolve_progressive_report(to_jsonb(stored.*)) ? 'result' AS present,
      jsonb_typeof(public.resolve_progressive_report(to_jsonb(stored.*))->'result') AS kind,
      public.resolve_progressive_report(to_jsonb(stored.*))#>>'{result,n}' AS exact_integer
      FROM progressive_worker_reports stored ORDER BY sequence`);
    expect(values).toEqual([
      {
        present: true,
        kind: "object",
        exact_integer: "9007199254740993123456789",
      },
      { present: true, kind: "null", exact_integer: null },
      { present: false, kind: null, exact_integer: null },
    ]);
    for (const report of input.reports)
      await db.execute(sql`INSERT INTO progressive_worker_reports
      (sim_job_id,sequence,content_signature,report) VALUES (${input.executionId}::uuid,${report.sequence},
        ${analysisContentHash(report)},${JSON.stringify(report)}::jsonb)`);
    const first = await readPendingProgressiveWorkerReport(db, {
      executionId: input.executionId,
      solverId: input.envelope.solverId,
    });
    expect(first?.report).toEqual(input.reports[0]);
    await acknowledgeProgressiveWorkerReport(db, {
      executionId: input.executionId,
      solverId: input.envelope.solverId,
      sequence: 1,
      contentSignature: analysisContentHash(input.reports[0]),
    });
    expect(
      (
        await readPendingProgressiveWorkerReport(db, {
          executionId: input.executionId,
          solverId: input.envelope.solverId,
        })
      )?.report,
    ).toEqual(input.reports[1]);
    await rejectsStatement(
      db,
      sql`UPDATE progressive_worker_reports SET acknowledged_at=NULL WHERE sequence=1`,
      /immutable/,
    );
    // A new payload and referenced INSERT are in the same statement: resolver
    // visibility cannot depend on a STABLE snapshot predating the payload insert.
    await db.execute(sql`WITH payload AS MATERIALIZED (
      SELECT public.store_progressive_report_result('{"state":"completed","polars":[],"sameStatement":true}'::jsonb) AS hash
    ) INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,result_payload_hash)
      SELECT ${input.executionId}::uuid,${legacy + 3},repeat('c',64),jsonb_build_object('version',1,'executionId',${input.executionId}::text,
        'sequence',${legacy + 3}::integer,'result','{"state":"completed"}'::jsonb),hash FROM payload`);
    const [row] =
      await db.execute(sql`SELECT public.resolve_progressive_report(to_jsonb(stored.*))#>>'{result,sameStatement}' AS value
      FROM progressive_worker_reports stored WHERE sequence=${legacy + 3}`);
    expect(row.value).toBe("true");
    await rejectsStatement(
      db,
      sql`UPDATE progressive_worker_reports SET report=jsonb_set(report,'{result,state}','"failed"') WHERE sequence=${legacy}`,
      /immutable/,
    );
    await rejectsStatement(
      db,
      sql`UPDATE progressive_worker_reports SET result_payload_hash=NULL WHERE sequence=${legacy}`,
      /immutable/,
    );
    await rejectsStatement(
      db,
      sql`UPDATE progressive_worker_reports SET content_signature=repeat('f',64) WHERE sequence=${legacy}`,
      /immutable/,
    );
    await rejectsStatement(
      db,
      sql`UPDATE progressive_remote_reports SET received_at=received_at+interval '1 second'`,
      /immutable/,
    );
    await rejectsStatement(
      db,
      sql`UPDATE public.progressive_report_result_payloads SET result='{}' WHERE content_hash IN (SELECT result_payload_hash FROM progressive_worker_reports)`,
      /immutable/,
    );
    await rejectsStatement(
      db,
      sql`DELETE FROM public.progressive_report_result_payloads WHERE content_hash IN (SELECT result_payload_hash FROM progressive_worker_reports)`,
      /immutable/,
    );
    await rejectsStatement(
      db,
      sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,result_payload_hash)
      SELECT sim_job_id,${legacy + 4},content_signature,jsonb_set(report,'{sequence}',to_jsonb(${legacy + 4}::integer)),repeat('0',64)
      FROM progressive_worker_reports WHERE sequence=${legacy}`,
      /Missing or inconsistent/,
    );
    await rejectsStatement(
      db,
      sql`INSERT INTO progressive_worker_reports(sim_job_id,sequence,content_signature,report,result_payload_hash)
      SELECT sim_job_id,${legacy + 4},content_signature,jsonb_set(jsonb_set(report,'{sequence}',to_jsonb(${legacy + 4}::integer)),
        '{result}','{"state":"failed","polars":[]}'::jsonb),result_payload_hash FROM progressive_worker_reports WHERE sequence=${legacy}`,
      /Missing or inconsistent/,
    );
    await rejectsStatement(
      db,
      sql`INSERT INTO public.progressive_report_result_payloads(content_hash,result,byte_size) VALUES(repeat('0',64),'{}',2)`,
      /check constraint/,
    );
    await db.execute(
      sql`CREATE TEMP TABLE progressive_report_result_payloads(content_hash text,result jsonb) ON COMMIT DROP`,
    );
    await db.execute(
      sql`INSERT INTO progressive_report_result_payloads SELECT result_payload_hash,'{"state":"failed"}' FROM progressive_worker_reports WHERE sequence=${legacy}`,
    );
    expect(
      (
        await db.execute(sql`SELECT public.resolve_progressive_report(to_jsonb(stored.*))#>>'{result,n}' AS n
      FROM progressive_worker_reports stored WHERE sequence=${legacy}`)
      )[0].n,
    ).toBe("9007199254740993123456789");
    const [eligibility] =
      await db.execute(sql`SELECT count(*)::integer AS n FROM progressive_worker_reports
      WHERE jsonb_typeof(report->'result')='object' AND report#>>'{result,state}'='completed'`);
    expect(eligibility.n).toBe(2);
  });
});

it("pins a bounded backfill cursor across SKIP LOCKED holes and resumes idempotently", async () => {
  // A second session cannot lock another session's TEMP table. Use one uniquely
  // named disposable schema in the graph's isolated PostgreSQL; roll back every
  // normalization/payload/policy write, then drop only that schema.
  const schema = `report_backfill_${randomUUID().replaceAll("-", "")}`;
  const table = sql`${sql.identifier(schema)}.progressive_worker_reports`;
  const locker = createClient({ max: 1 });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ready!: () => void;
  const acquired = new Promise<void>((resolve) => {
    ready = resolve;
  });
  let locking: Promise<unknown> | undefined;
  try {
    await client.db.execute(sql`CREATE SCHEMA ${sql.identifier(schema)}`);
    await client.db.execute(
      sql`CREATE TABLE ${table} (LIKE public.progressive_worker_reports INCLUDING ALL)`,
    );
    await client.db
      .execute(sql`CREATE TRIGGER immutable_report BEFORE UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION public.protect_progressive_worker_report()`);
    await client.db
      .execute(sql`INSERT INTO ${table}(sim_job_id,sequence,content_signature,report)
      SELECT md5(${schema}::text)::uuid,n,repeat('a',64),jsonb_build_object('version',1,'executionId',md5(${schema}::text)::uuid::text,
        'sequence',n,'result','{"state":"completed","polars":[]}'::jsonb) FROM generate_series(1,2) n`);
    locking = locker.db.transaction(async (transaction) => {
      await transaction.execute(
        sql`SELECT sequence FROM ${table} ORDER BY sim_job_id,sequence LIMIT 1 FOR UPDATE`,
      );
      ready();
      await gate;
    });
    await Promise.race([
      acquired,
      locking.then(() => {
        throw new Error("Lock fixture ended before acquiring its row");
      }),
    ]);
    await rolledBack(async (db) => {
      await db.execute(
        sql`SET LOCAL search_path = ${sql.identifier(schema)}, public`,
      );
      await setProgressiveReportNormalization(db, {
        enabled: true,
        readersReady: true,
      });
      const first = await backfillProgressiveReportPayloads(db, {
        table: "progressive_worker_reports",
        apply: true,
        rows: 3,
      });
      expect(first).toMatchObject({
        scanned: 1,
        locked: 1,
        normalized: 1,
        after: null,
        complete: false,
      });
      release();
      await locking;
      const resumed = await backfillProgressiveReportPayloads(db, {
        table: "progressive_worker_reports",
        apply: true,
        rows: 3,
        after: first.after,
      });
      expect(resumed).toMatchObject({
        scanned: 2,
        locked: 0,
        normalized: 1,
        complete: true,
      });
      expect(
        await backfillProgressiveReportPayloads(db, {
          table: "progressive_worker_reports",
          apply: true,
          rows: 3,
        }),
      ).toMatchObject({ normalized: 0, complete: true });
    });
  } finally {
    release();
    await locking;
    await locker.sql.end();
    await client.db.execute(
      sql`DROP SCHEMA IF EXISTS ${sql.identifier(schema)} CASCADE`,
    );
  }
}, 30_000);

it("refuses reclamation and preserves terminal ingested report history and exact replays", async () => {
  await client.db.transaction(async (transaction) => {
    const db = transaction as unknown as DB;
    const input = await fixture(db);
    const before = await snapshot(db);
    const retained = await readProgressiveRemoteRetention(
      db,
      input.executionId,
    );
    expect(retained).toMatchObject({
      kind: "retained",
      sources: [{ delivery: { progressiveEvidence: { sequence: 2 } } }],
    });
    for (const batchSize of [1, 50_000]) {
      await expect
        .soft(
          reclaimProgressiveReportHistory(db, {
            campaignId: input.campaignId,
            batchSize,
          }),
        )
        .rejects.toThrow(PROGRESSIVE_REPORT_RETENTION_DISABLED);
      expect.soft(await snapshot(db)).toEqual(before);
    }
    for (const report of input.reports) {
      await expect
        .soft(storeProgressiveRemoteReport(db, { ...input.sender, report }))
        .resolves.toMatchObject({ replayed: true, sequence: report.sequence });
    }
    await expect(
      storeProgressiveRemoteReport(db, {
        ...input.sender,
        report: {
          ...input.reports[0],
          status: { ...input.reports[0].status, message: "changed" },
        },
      }),
    ).rejects.toThrow("replay changed immutable content");
    expect(await snapshot(db)).toEqual(before);
    expect(await readProgressiveRemoteRetention(db, input.executionId)).toEqual(
      retained,
    );
    // Missing inventory on a surviving historical report still blocks retention;
    // exact replay repairs that index without changing report identity.
    await db.execute(
      sql`DELETE FROM progressive_remote_report_inventories WHERE sequence=1`,
    );
    expect(await readProgressiveRemoteRetention(db, input.executionId)).toEqual(
      { kind: "waiting", reason: "source_inventory" },
    );
    await storeProgressiveRemoteReport(db, {
      ...input.sender,
      report: input.reports[0],
    });
    expect(
      (await readProgressiveRemoteRetention(db, input.executionId)).kind,
    ).toBe("retained");
    await storeProgressiveRemoteReport(db, {
      ...input.sender,
      report: { ...input.terminal, sequence: 5 },
    });
    expect(
      (await selectPendingProgressiveRemoteReport(db, input.executionId)).map(
        (row) => Number(row.sequence),
      ),
    ).toEqual([5]);
  });
});

it("shows pruning loses replay identity without treating sparse receipts as a settlement deadlock", async () => {
  await client.db.transaction(async (transaction) => {
    const db = transaction as unknown as DB;
    const input = await fixture(db);
    const retained = await readProgressiveRemoteRetention(
      db,
      input.executionId,
    );
    expect(
      await selectPendingProgressiveRemoteReport(db, input.executionId),
    ).toEqual([]);
    // Reproduce only the old candidate deletions, inside disposable temp tables:
    // empty sequence 1 and duplicate-source sequence 3; receipt owner 2 and latest 4 survive.
    await db.execute(
      sql`DELETE FROM progressive_remote_reports WHERE sequence IN (1,3)`,
    );
    for (const table of historyTables.slice(0, 4)) {
      const rows = await db.execute(
        sql`SELECT DISTINCT sequence FROM ${sql.identifier(table)} ORDER BY sequence`,
      );
      expect(rows.map((row) => Number(row.sequence))).toEqual(
        table.endsWith("_sources") ? [2] : [2, 4],
      );
    }
    expect(await readProgressiveRemoteRetention(db, input.executionId)).toEqual(
      retained,
    );
    expect(
      await selectPendingProgressiveRemoteReport(db, input.executionId),
    ).toEqual([]);
    for (const index of [0, 2]) {
      await expect(
        storeProgressiveRemoteReport(db, {
          ...input.sender,
          report: input.reports[index],
        }),
      ).rejects.toThrow("durable publication order");
    }
    await expect(
      storeProgressiveRemoteReport(db, {
        ...input.sender,
        report: input.reports[1],
      }),
    ).resolves.toMatchObject({ replayed: true });
    const next = { ...input.terminal, sequence: 5 };
    await storeProgressiveRemoteReport(db, { ...input.sender, report: next });
    expect(
      (await selectPendingProgressiveRemoteReport(db, input.executionId)).map(
        (row) => Number(row.sequence),
      ),
    ).toEqual([5]);
    // Sparse history still finds an actual missing receipt for a surviving report.
    await db.execute(
      sql`DELETE FROM progressive_remote_progress_receipts WHERE sequence=2`,
    );
    expect(
      (await selectPendingProgressiveRemoteReport(db, input.executionId)).map(
        (row) => Number(row.sequence),
      ),
    ).toEqual([2]);
    expect(
      (await readProgressiveRemoteRetention(db, input.executionId)).kind,
    ).toBe("retained");
  });
});

it("refuses the legacy CLI before database configuration and removes the package export", () => {
  const cli = fileURLToPath(
    new URL("../src/reclaim-progressive-report-history.ts", import.meta.url),
  );
  try {
    execFileSync(
      process.execPath,
      ["--import", "tsx", cli, randomUUID(), "50000"],
      {
        env: {
          ...process.env,
          DATABASE_URL: "invalid://retention-must-not-connect",
        },
        stdio: "pipe",
        timeout: 10_000,
      },
    );
    expect.unreachable("The disabled CLI must fail");
  } catch (error) {
    expect(error).toMatchObject({ status: 1, stdout: Buffer.alloc(0) });
    expect(String((error as { stderr: Buffer }).stderr).trim()).toBe(
      PROGRESSIVE_REPORT_RETENTION_DISABLED,
    );
  }
  expect(
    readFileSync(new URL("../src/index.ts", import.meta.url), "utf8"),
  ).not.toContain('from "./progressive-report-retention"');
});
