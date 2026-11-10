import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { afterAll, expect, it } from "vitest";
import { OPENCFD_2606_ENGINE } from "../../engine-client/src/engine-identity";
import { selectPendingProgressiveRemoteReport } from "../../../apps/sweeper/src/progressive-remote-settlement";
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

async function fixture(db: DB) {
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
  for (const table of historyTables) {
    await db.execute(sql`CREATE TEMP TABLE ${sql.identifier(table)}
      (LIKE ${sql.identifier("public")}.${sql.identifier(table)} INCLUDING ALL) ON COMMIT DROP`);
    const constraints =
      await db.execute(sql`SELECT conname, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid=${`public.${table}`}::regclass AND contype='f'`);
    for (const constraint of constraints) {
      const definition = String(constraint.definition).replace(
        /REFERENCES (?:public\.)?(\w+)/g,
        "REFERENCES pg_temp.$1",
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
              error: "isolated unconverged protocol fixture",
            },
          ],
        },
      ],
    },
  };
  const terminal: ProgressiveRemoteReport = {
    ...partial,
    sequence: 4,
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
  const reports = [initial, partial, { ...partial, sequence: 3 }, terminal];
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
  return { executionId, campaignId, sender, reports, terminal };
}

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
