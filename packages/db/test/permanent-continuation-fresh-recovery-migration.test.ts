import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { databaseUrl } from "../src/env";

const here = fileURLToPath(new URL(".", import.meta.url));
const initialMigration = readFileSync(
  resolve(here, "../migrations/0118_permanent_continuation_fresh_recovery.sql"),
  "utf8",
);
const batchedLineageMigration = readFileSync(
  resolve(
    here,
    "../migrations/0119_permanent_continuation_batched_lineage_recovery.sql",
  ),
  "utf8",
);
const journal = JSON.parse(
  readFileSync(resolve(here, "../migrations/meta/_journal.json"), "utf8"),
) as { entries: Array<{ idx: number; tag: string }> };

const fixtureDbName = `aerodb_0119_continuation_recovery_${process.pid}_${Date.now()}`;
const baseUrl = new URL(databaseUrl());
const adminUrl = new URL(baseUrl);
adminUrl.pathname = "/postgres";
const fixtureUrl = new URL(baseUrl);
fixtureUrl.pathname = `/${fixtureDbName}`;

let admin: ReturnType<typeof postgres> | null = null;
let client: ReturnType<typeof postgres> | null = null;

function fixtureId(value: number): string {
  return `11800000-0000-0000-0000-${value.toString(16).padStart(12, "0")}`;
}

async function insertRecoveryFixture(
  slot: number,
  options: {
    malformedAoaPayload?: boolean;
    malformedSourceBoundaryIds?: boolean;
    malformedTerminalBoundaryIds?: boolean;
    mismatchedBoundaryCondition?: boolean;
    mismatchedSourceJobBoundaryCondition?: boolean;
    mismatchedSourceSolverImplementation?: boolean;
    mismatchedSourceEngineAndCase?: boolean;
    legacyBatchedResultEngine?: boolean;
    legacyBatchedResultCaseMismatch?: boolean;
    legacyBatchedMissingOwnership?: boolean;
    legacyBatchedMissingAoa?: boolean;
    legacyBatchedWrongFidelity?: boolean;
    mismatchedSourceResultSolverImplementation?: boolean;
  } = {},
): Promise<void> {
  if (!client) throw new Error("migration fixture database is unavailable");

  const sourceJob = fixtureId(slot * 10 + 1);
  const sourceResult = fixtureId(slot * 10 + 2);
  const sourceAttempt = fixtureId(slot * 10 + 3);
  const terminalJob = fixtureId(slot * 10 + 4);
  const obligation = fixtureId(slot * 10 + 5);
  const submission = fixtureId(slot * 10 + 6);
  const request = fixtureId(slot * 10 + 7);
  const sourceJobEngine = `source-job-${slot}`;
  const sourceAttemptEngine = options.mismatchedSourceEngineAndCase
    ? `source-receipt-${slot}`
    : sourceJobEngine;
  const sourceResultEngine = options.legacyBatchedResultEngine
    ? `source-child-${slot}`
    : sourceAttemptEngine;
  const sourceAttemptCase = options.mismatchedSourceEngineAndCase
    ? `source-attempt-${slot}`
    : `source-case-${slot}`;
  const sourceResultCase =
    options.mismatchedSourceEngineAndCase ||
    options.legacyBatchedResultCaseMismatch
      ? `source-result-${slot}`
      : sourceAttemptCase;
  const sourceResultBoundary = options.mismatchedBoundaryCondition
    ? fixtureId(4)
    : fixtureId(3);
  const sourceJobBoundary = options.mismatchedSourceJobBoundaryCondition
    ? fixtureId(4)
    : fixtureId(3);
  const sourceJobBoundaryIds = options.malformedSourceBoundaryIds
    ? '"not-an-array"'
    : JSON.stringify([sourceJobBoundary]);
  const terminalBoundaryIds = options.malformedTerminalBoundaryIds
    ? '"not-an-array"'
    : JSON.stringify([fixtureId(3)]);
  const targetSolverImplementation = fixtureId(6);
  const sourceSolverImplementation =
    options.mismatchedSourceSolverImplementation
      ? fixtureId(7)
      : targetSolverImplementation;
  const sourceResultSolverImplementation =
    options.mismatchedSourceResultSolverImplementation
      ? fixtureId(7)
      : sourceSolverImplementation;
  const terminalPayload = JSON.stringify({
    aoas: options.malformedAoaPayload ? "3.5" : [3.5],
    uransFidelity: "precalc",
    precalcObligationIds: [obligation],
    uransRequestId: request,
    continueFromResultId: sourceResult,
    continueFromResultAttemptId: sourceAttempt,
  });
  const sourcePayload = JSON.stringify(
    options.legacyBatchedResultEngine
      ? {
          uransFidelity: options.legacyBatchedWrongFidelity
            ? "full"
            : "precalc",
          aoas: options.legacyBatchedMissingAoa ? [4.5] : [3.5, 4.5],
          precalcObligationIds: options.legacyBatchedMissingOwnership
            ? []
            : [obligation, fixtureId(slot * 10 + 8)],
        }
      : {},
  );

  await client.unsafe(`
    INSERT INTO "sim_jobs"
      ("id", "engine_job_id", "solver_implementation_id", "airfoil_id", "bc_ids", "simulation_preset_revision_id", "status", "request_payload")
    VALUES
      ('${sourceJob}', '${sourceJobEngine}', '${sourceSolverImplementation}', '${fixtureId(1)}', '${sourceJobBoundaryIds}'::jsonb, '${fixtureId(2)}', 'done', '${sourcePayload}'::jsonb),
      ('${terminalJob}', 'terminal-${slot}', '${targetSolverImplementation}', '${fixtureId(1)}', '${terminalBoundaryIds}'::jsonb, '${fixtureId(2)}', 'failed', '${terminalPayload}'::jsonb);

    INSERT INTO "results"
      ("id", "airfoil_id", "bc_id", "simulation_preset_revision_id", "aoa_deg", "engine_job_id", "engine_case_slug", "solver_implementation_id")
    VALUES
      ('${sourceResult}', '${fixtureId(1)}', '${sourceResultBoundary}', '${fixtureId(2)}', 3.5,
       '${sourceResultEngine}', '${sourceResultCase}', '${sourceResultSolverImplementation}');

    INSERT INTO "result_attempts"
      ("id", "result_id", "airfoil_id", "bc_id", "simulation_preset_revision_id", "aoa_deg", "sim_job_id", "engine_job_id", "engine_case_slug", "solver_implementation_id")
    VALUES
      ('${sourceAttempt}', '${sourceResult}', '${fixtureId(1)}', '${fixtureId(3)}', '${fixtureId(2)}', 3.5,
       '${sourceJob}', '${sourceAttemptEngine}', '${sourceAttemptCase}', '${sourceSolverImplementation}');

    INSERT INTO "sim_precalc_obligations"
      ("id", "airfoil_id", "revision_id", "aoa_deg", "state", "attempt_count", "max_attempts",
       "latest_sim_job_id", "background_owner", "last_outcome")
    VALUES
      ('${obligation}', '${fixtureId(1)}', '${fixtureId(2)}', 3.5, 'blocked', 1, 2,
       '${terminalJob}', false, 'continuation_permanent_failure');

    INSERT INTO "sim_precalc_obligation_attempts"
      ("id", "obligation_id", "sim_job_id", "state", "outcome", "consumes_solver_attempt")
    VALUES
      ('${submission}', '${obligation}', '${terminalJob}', 'failed',
       'continuation_permanent_failure', false);

    INSERT INTO "sim_urans_requests"
      ("id", "airfoil_id", "revision_id", "aoa_deg", "fidelity", "state", "sim_job_id",
       "continue_from_result_id", "continue_from_result_attempt_id", "background_owner")
    VALUES
      ('${request}', '${fixtureId(1)}', '${fixtureId(2)}', 3.5, 'precalc', 'running', '${terminalJob}',
       '${sourceResult}', '${sourceAttempt}', true);

    INSERT INTO "sim_precalc_obligation_requests" ("obligation_id", "request_id")
    VALUES ('${obligation}', '${request}');
  `);
}

beforeAll(async () => {
  admin = postgres(adminUrl.toString(), { max: 1 });
  await admin.unsafe(`CREATE DATABASE "${fixtureDbName}"`);
  client = postgres(fixtureUrl.toString(), { max: 1 });
  await client.unsafe(`
    CREATE TABLE "sim_jobs" (
      "id" uuid PRIMARY KEY,
      "engine_job_id" text,
      "solver_implementation_id" uuid,
      "airfoil_id" uuid NOT NULL,
      "bc_ids" jsonb NOT NULL,
      "simulation_preset_revision_id" uuid NOT NULL,
      "status" text NOT NULL,
      "request_payload" jsonb NOT NULL
    );
    CREATE TABLE "results" (
      "id" uuid PRIMARY KEY,
      "airfoil_id" uuid NOT NULL,
      "bc_id" uuid NOT NULL,
      "simulation_preset_revision_id" uuid NOT NULL,
      "aoa_deg" numeric NOT NULL,
      "engine_job_id" text,
      "engine_case_slug" text,
      "solver_implementation_id" uuid
    );
    CREATE TABLE "result_attempts" (
      "id" uuid PRIMARY KEY,
      "result_id" uuid NOT NULL,
      "airfoil_id" uuid NOT NULL,
      "bc_id" uuid NOT NULL,
      "simulation_preset_revision_id" uuid NOT NULL,
      "aoa_deg" numeric NOT NULL,
      "sim_job_id" uuid NOT NULL,
      "engine_job_id" text,
      "engine_case_slug" text,
      "solver_implementation_id" uuid
    );
    CREATE TABLE "sim_precalc_obligations" (
      "id" uuid PRIMARY KEY,
      "airfoil_id" uuid NOT NULL,
      "revision_id" uuid NOT NULL,
      "aoa_deg" numeric NOT NULL,
      "state" text NOT NULL,
      "attempt_count" integer NOT NULL,
      "max_attempts" integer NOT NULL,
      "latest_sim_job_id" uuid,
      "background_owner" boolean NOT NULL,
      "last_outcome" text,
      "submit_failure_count" integer NOT NULL DEFAULT 0,
      "next_submit_at" timestamptz,
      "completed_at" timestamptz,
      "updatedAt" timestamptz
    );
    CREATE TABLE "sim_precalc_obligation_attempts" (
      "id" uuid PRIMARY KEY,
      "obligation_id" uuid NOT NULL,
      "sim_job_id" uuid NOT NULL,
      "state" text NOT NULL,
      "outcome" text,
      "consumes_solver_attempt" boolean NOT NULL
    );
    CREATE TABLE "sim_urans_requests" (
      "id" uuid PRIMARY KEY,
      "airfoil_id" uuid NOT NULL,
      "revision_id" uuid NOT NULL,
      "aoa_deg" numeric,
      "fidelity" text NOT NULL,
      "state" text NOT NULL,
      "sim_job_id" uuid,
      "continue_from_result_id" uuid,
      "continue_from_result_attempt_id" uuid,
      "budget_override_s" integer,
      "corrective_tail_periods" integer,
      "clean_cycle_recovery_policy_version" text,
      "background_owner" boolean NOT NULL,
      "updatedAt" timestamptz
    );
    CREATE TABLE "sim_precalc_obligation_requests" (
      "obligation_id" uuid NOT NULL,
      "request_id" uuid NOT NULL
    );
    CREATE TABLE "sim_precalc_obligation_campaigns" (
      "obligation_id" uuid NOT NULL,
      "campaign_id" uuid NOT NULL,
      "state" text NOT NULL
    );
    CREATE TABLE "sim_campaigns" ("id" uuid PRIMARY KEY, "status" text NOT NULL);
    CREATE TABLE "sync_sweep_promise_points" (
      "promise_id" uuid NOT NULL,
      "airfoil_id" uuid NOT NULL,
      "simulation_preset_revision_id" uuid NOT NULL,
      "aoa_deg" numeric NOT NULL,
      "status" text NOT NULL
    );
    CREATE TABLE "sync_sweep_promises" (
      "id" uuid PRIMARY KEY,
      "status" text NOT NULL,
      "expiresAt" timestamptz NOT NULL,
      "request_payload" jsonb NOT NULL
    );
    CREATE TABLE "simulation_presets" (
      "id" uuid PRIMARY KEY,
      "legacy_boundary_condition_id" uuid
    );
    CREATE TABLE "simulation_preset_revisions" (
      "id" uuid PRIMARY KEY,
      "preset_id" uuid NOT NULL,
      "solver_implementation_id" uuid NOT NULL,
      "snapshot" jsonb NOT NULL
    );

    INSERT INTO "simulation_presets" ("id", "legacy_boundary_condition_id")
    VALUES ('${fixtureId(5)}', '${fixtureId(3)}');
    INSERT INTO "simulation_preset_revisions"
      ("id", "preset_id", "solver_implementation_id", "snapshot")
    VALUES
      ('${fixtureId(2)}', '${fixtureId(5)}', '${fixtureId(6)}',
       '{"preset":{"legacyBoundaryConditionId":"${fixtureId(3)}"}}'::jsonb);
  `);
  await insertRecoveryFixture(1);
  await insertRecoveryFixture(2, { mismatchedSourceEngineAndCase: true });
  await insertRecoveryFixture(3, { malformedAoaPayload: true });
  await insertRecoveryFixture(4, { mismatchedBoundaryCondition: true });
  await insertRecoveryFixture(5, {
    mismatchedSourceJobBoundaryCondition: true,
  });
  await insertRecoveryFixture(6, { malformedSourceBoundaryIds: true });
  await insertRecoveryFixture(7, { malformedTerminalBoundaryIds: true });
  await insertRecoveryFixture(8, {
    mismatchedSourceSolverImplementation: true,
  });
  await insertRecoveryFixture(9, { legacyBatchedResultEngine: true });
  await insertRecoveryFixture(10, {
    legacyBatchedResultEngine: true,
    legacyBatchedResultCaseMismatch: true,
  });
  await insertRecoveryFixture(11, {
    legacyBatchedResultEngine: true,
    legacyBatchedMissingOwnership: true,
  });
  await insertRecoveryFixture(12, {
    legacyBatchedResultEngine: true,
    legacyBatchedMissingAoa: true,
  });
  await insertRecoveryFixture(13, {
    legacyBatchedResultEngine: true,
    legacyBatchedWrongFidelity: true,
  });
  await insertRecoveryFixture(14, {
    legacyBatchedResultEngine: true,
    mismatchedSourceResultSolverImplementation: true,
  });
}, 60_000);

afterAll(async () => {
  await client?.end();
  if (admin) {
    await admin.unsafe(
      `DROP DATABASE IF EXISTS "${fixtureDbName}" WITH (FORCE)`,
    );
    await admin.end();
  }
});

describe("0118 permanent continuation fresh recovery migration", () => {
  it("reopens only live, budgeted cells with an immutable non-consuming permanent continuation audit", () => {
    expect(initialMigration).toContain("obligation.\"state\" = 'blocked'");
    expect(initialMigration).toContain(
      "obligation.\"last_outcome\" = 'continuation_permanent_failure'",
    );
    expect(initialMigration).toContain(
      'obligation."attempt_count" < obligation."max_attempts"',
    );
    expect(initialMigration).toContain(
      "terminal_submission.\"outcome\" = 'continuation_permanent_failure'",
    );
    expect(initialMigration).toContain(
      'NOT terminal_submission."consumes_solver_attempt"',
    );
    expect(initialMigration).toContain(
      'obligation."latest_sim_job_id" = terminal_job."id"',
    );
    expect(initialMigration).toContain(
      'terminal_job."airfoil_id" = obligation."airfoil_id"',
    );
    expect(initialMigration).toContain(
      'terminal_job."simulation_preset_revision_id" = obligation."revision_id"',
    );
    expect(initialMigration).toContain(
      "WHEN jsonb_typeof(terminal_job.\"request_payload\" -> 'aoas') = 'array'",
    );
    expect(initialMigration).toContain(
      "THEN jsonb_array_length(terminal_job.\"request_payload\" -> 'aoas') = 1",
    );
    expect(initialMigration).toContain(
      'jsonb_build_array(obligation."aoa_deg")',
    );
    expect(initialMigration).toContain(
      'continuation_source_attempt."id"::text =',
    );
    expect(initialMigration).toContain(
      'continuation_source_result."id" = continuation_source_attempt."result_id"',
    );
    expect(initialMigration).toContain(
      'continuation_source_job."id" = continuation_source_attempt."sim_job_id"',
    );
    expect(initialMigration).toContain(
      'continuation_source_result."bc_id" = continuation_source_attempt."bc_id"',
    );
    expect(initialMigration).toContain(
      'terminal_job."bc_ids" @> jsonb_build_array(continuation_source_attempt."bc_id")',
    );
    expect(initialMigration).toContain('continuation_source_job."bc_ids" @>');
    expect(initialMigration).toContain(
      'continuation_source_attempt."engine_job_id" =',
    );
    expect(initialMigration).toContain(
      'continuation_source_result."engine_job_id" =',
    );
    expect(initialMigration).toContain(
      'continuation_source_result."engine_case_slug" =',
    );
    expect(initialMigration).toContain(
      'continuation_source_attempt."aoa_deg" = obligation."aoa_deg"',
    );
    expect(initialMigration).toContain(
      'continuation_source_result."simulation_preset_revision_id" =',
    );
    expect(initialMigration).toContain('obligation."background_owner"');
    expect(initialMigration).toContain('promise."expiresAt" > now()');
    expect(initialMigration).toContain(
      'FROM "sim_precalc_obligation_requests" coverage',
    );
    expect(initialMigration).toContain("'fresh_recovery_pending'");
    expect(initialMigration).toContain('"next_submit_at" = now()');
  });

  it("clears a continuation request only when its terminal job and exact source pair own the same reopened cell", () => {
    expect(initialMigration).toContain("request.\"fidelity\" = 'precalc'");
    expect(initialMigration).toContain(
      'request."aoa_deg" IS NOT DISTINCT FROM obligation."aoa_deg"',
    );
    expect(initialMigration).toContain(
      'request."sim_job_id" = terminal_job."id"',
    );
    expect(initialMigration).toContain(
      'terminal_job."request_payload" ->> \'uransRequestId\' = request."id"::text',
    );
    expect(initialMigration).toContain(
      "terminal_job.\"request_payload\" ->> 'continueFromResultId' =",
    );
    expect(initialMigration).toContain(
      "terminal_job.\"request_payload\" ->> 'continueFromResultAttemptId' =",
    );
    expect(initialMigration).toContain('"continue_from_result_id" = NULL');
    expect(initialMigration).toContain(
      '"continue_from_result_attempt_id" = NULL',
    );
  });
});

describe("0119 permanent continuation batched-lineage recovery migration", () => {
  it("accepts only the documented parent-attempt / child-result representation", () => {
    expect(batchedLineageMigration).toContain(
      'continuation_source_result."engine_job_id" <>',
    );
    expect(batchedLineageMigration).toContain(
      'continuation_source_result."engine_case_slug" =',
    );
    expect(batchedLineageMigration).toContain(
      'continuation_source_attempt."engine_case_slug"',
    );
    expect(batchedLineageMigration).toContain(
      "continuation_source_job.\"request_payload\" ->> 'uransFidelity' = 'precalc'",
    );
    expect(batchedLineageMigration).toContain("'precalcObligationIds'");
    expect(batchedLineageMigration).toContain(
      'jsonb_build_array(obligation."id"::text)',
    );
    expect(batchedLineageMigration).toContain(
      "continuation_source_job.\"request_payload\" -> 'aoas'",
    );
    expect(batchedLineageMigration).toContain(
      'jsonb_build_array(continuation_source_attempt."aoa_deg")',
    );
    expect(batchedLineageMigration).toContain(
      'continuation_source_attempt."engine_job_id" =',
    );
    expect(batchedLineageMigration).toContain(
      'continuation_source_job."engine_job_id"',
    );
    expect(batchedLineageMigration).toContain(
      'continuation_source_result."id" = continuation_source_attempt."result_id"',
    );
    expect(batchedLineageMigration).toContain(
      'continuation_source_result."solver_implementation_id"',
    );
    expect(batchedLineageMigration).toContain(
      'NOT terminal_submission."consumes_solver_attempt"',
    );
    expect(batchedLineageMigration).toContain("FROM reopened");
  });

  it("is the latest ordered migration", () => {
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 119,
      tag: "0119_permanent_continuation_batched_lineage_recovery",
    });
  });
});

describe("0118/0119 permanent continuation recovery migration fixtures", () => {
  it("reopens exact conventional and documented batched lineages once, without altering source evidence", async () => {
    if (!client) throw new Error("migration fixture database is unavailable");

    const [{ attemptsBefore }] = await client.unsafe<
      Array<{ attemptsBefore: number }>
    >(`SELECT count(*)::int AS "attemptsBefore" FROM result_attempts`);
    const [{ resultsBefore }] = await client.unsafe<
      Array<{ resultsBefore: number }>
    >(`SELECT count(*)::int AS "resultsBefore" FROM results`);

    await client.unsafe(initialMigration);
    const initialReopened = await client.unsafe<Array<{ id: string }>>(`
      SELECT id::text AS id
      FROM sim_precalc_obligations
      WHERE state = 'pending' AND last_outcome = 'fresh_recovery_pending'
      ORDER BY id
    `);
    expect(initialReopened).toEqual([{ id: fixtureId(15) }]);

    await client.unsafe(batchedLineageMigration);
    const reopened = await client.unsafe<Array<{ id: string }>>(`
      SELECT id::text AS id
      FROM sim_precalc_obligations
      WHERE state = 'pending' AND last_outcome = 'fresh_recovery_pending'
      ORDER BY id
    `);
    expect(reopened).toEqual([{ id: fixtureId(15) }, { id: fixtureId(95) }]);

    const resetRequests = await client.unsafe<
      Array<{
        id: string;
        state: string;
        simJobId: string | null;
        resultId: string | null;
        attemptId: string | null;
      }>
    >(`
      SELECT
        id::text AS id,
        state,
        sim_job_id::text AS "simJobId",
        continue_from_result_id::text AS "resultId",
        continue_from_result_attempt_id::text AS "attemptId"
      FROM sim_urans_requests
      WHERE id IN ('${fixtureId(17)}', '${fixtureId(97)}')
      ORDER BY id
    `);
    expect(resetRequests).toEqual([
      {
        id: fixtureId(17),
        state: "pending",
        simJobId: null,
        resultId: null,
        attemptId: null,
      },
      {
        id: fixtureId(97),
        state: "pending",
        simJobId: null,
        resultId: null,
        attemptId: null,
      },
    ]);

    const retainedLegacyRequests = await client.unsafe<
      Array<{
        id: string;
        state: string;
        simJobId: string | null;
        resultId: string | null;
        attemptId: string | null;
      }>
    >(`
      SELECT
        id::text AS id,
        state,
        sim_job_id::text AS "simJobId",
        continue_from_result_id::text AS "resultId",
        continue_from_result_attempt_id::text AS "attemptId"
      FROM sim_urans_requests
      WHERE id IN ('${fixtureId(107)}', '${fixtureId(117)}', '${fixtureId(127)}', '${fixtureId(137)}', '${fixtureId(147)}')
      ORDER BY id
    `);
    expect(retainedLegacyRequests).toEqual([
      {
        id: fixtureId(107),
        state: "running",
        simJobId: fixtureId(104),
        resultId: fixtureId(102),
        attemptId: fixtureId(103),
      },
      {
        id: fixtureId(117),
        state: "running",
        simJobId: fixtureId(114),
        resultId: fixtureId(112),
        attemptId: fixtureId(113),
      },
      {
        id: fixtureId(127),
        state: "running",
        simJobId: fixtureId(124),
        resultId: fixtureId(122),
        attemptId: fixtureId(123),
      },
      {
        id: fixtureId(137),
        state: "running",
        simJobId: fixtureId(134),
        resultId: fixtureId(132),
        attemptId: fixtureId(133),
      },
      {
        id: fixtureId(147),
        state: "running",
        simJobId: fixtureId(144),
        resultId: fixtureId(142),
        attemptId: fixtureId(143),
      },
    ]);

    const [{ attemptsAfter }] = await client.unsafe<
      Array<{ attemptsAfter: number }>
    >(`SELECT count(*)::int AS "attemptsAfter" FROM result_attempts`);
    const [{ resultsAfter }] = await client.unsafe<
      Array<{ resultsAfter: number }>
    >(`SELECT count(*)::int AS "resultsAfter" FROM results`);
    expect({ attemptsAfter, resultsAfter }).toEqual({
      attemptsAfter: attemptsBefore,
      resultsAfter: resultsBefore,
    });

    await client.unsafe(batchedLineageMigration);
    const [{ reopenedAfterRetry }] = await client.unsafe<
      Array<{ reopenedAfterRetry: number }>
    >(`
      SELECT count(*)::int AS "reopenedAfterRetry"
      FROM sim_precalc_obligations
      WHERE state = 'pending' AND last_outcome = 'fresh_recovery_pending'
    `);
    expect(reopenedAfterRetry).toBe(2);
  });
});
