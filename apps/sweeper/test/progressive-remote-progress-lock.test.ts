import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, expect, it, vi } from "vitest";
import type { DB } from "@aerodb/db";

const hooks = vi.hoisted(() => ({
  verify: vi.fn(),
  settle: vi.fn(),
}));

vi.mock("@aerodb/db", async (original) => ({
  ...(await original<typeof import("@aerodb/db")>()),
  verifyProgressiveRemoteExecution: hooks.verify,
}));

vi.mock("../src/progressive-remote-settlement", async (original) => ({
  ...(await original<typeof import("../src/progressive-remote-settlement")>()),
  settleProgressiveRemoteJob: hooks.settle,
}));

import { applyProgressiveRemoteProgress, reconcileProgressiveRemoteProgress } from "../src/progressive-remote-progress";
import { selectPendingProgressiveRemoteReport } from "../src/progressive-remote-settlement";

afterEach(() => vi.resetAllMocks());

it("rotates failed closed-settlement polls without weakening their proof or blocking healthy siblings", async () => {
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"];
  const scope = { epochId: "44444444-4444-4444-8444-444444444444" };
  hooks.verify.mockReturnValue({ request: {}, scope });
  hooks.settle.mockImplementation(async (_db, id) => {
    if (id !== ids[2]) throw new Error("Diagnostic receipt differs from the latest stopped material-failure ownership");
    return { kind: "settled", counts: { complete: 0, retry: 0, gaps: 0, cancelled: 0, waiting: 0 } };
  });
  const selection = vi.fn().mockResolvedValueOnce([{ jit: "on" }]).mockResolvedValueOnce([])
    .mockResolvedValueOnce(ids.map((sim_job_id) => ({ sim_job_id, campaign_id: "campaign" }))).mockResolvedValue([]);
  const dialect = new PgDialect();
  const apply = vi.fn(async (query) => {
    const rendered = dialect.sqlToQuery(query);
    if (rendered.sql.includes("FROM progressive_remote_dispatches"))
      return [{ envelope: {}, content_signature: "immutable", solver_id: "solver", promise_id: "promise" }];
    if (rendered.sql.includes("FROM calculation_epochs")) return [{ id: scope.epochId }];
    if (rendered.sql.includes("FROM sim_campaigns")) return [{ id: "campaign" }];
    if (rendered.sql.includes("FROM sim_jobs")) return [{ engine_job_id: rendered.params[0], status: "done",
      engine_state: "completed", completed_cases: 2, request_payload: { engineRequest: {}, progressive: scope } }];
    return [];
  });
  const execute = vi.fn().mockResolvedValueOnce([{ pending_reports: 0 }]).mockResolvedValueOnce([]).mockResolvedValue([]);
  const transaction = vi.fn((run: (connection: DB) => Promise<unknown>) => run({ execute: apply } as unknown as DB))
    .mockImplementationOnce((run) => run({ execute: selection } as unknown as DB));
  const result = await reconcileProgressiveRemoteProgress({ execute, transaction } as unknown as DB);
  expect(result.settled).toBe(1);
  expect(result.errors).toEqual(ids.slice(0, 2).map((executionId) => ({ executionId,
    reason: "Diagnostic receipt differs from the latest stopped material-failure ownership" })));
  const polls = execute.mock.calls.map(([query]) => dialect.sqlToQuery(query))
    .filter((query) => query.sql.includes('UPDATE sim_jobs SET "polledAt"'));
  expect(polls.map((query) => query.params[0])).toEqual(ids);
  expect(polls.every((query) => !query.sql.includes("status =") && !query.sql.includes("ingestedAt"))).toBe(true);
  expect(hooks.settle).toHaveBeenCalledTimes(3);
});

it("locks the campaign before the job when projecting an immutable remote report", async () => {
  const executionId = "11111111-1111-4111-8111-111111111111";
  const epochId = "22222222-2222-4222-8222-222222222222";
  const campaignId = "33333333-3333-4333-8333-333333333333";
  const solverId = "44444444-4444-4444-8444-444444444444";
  const promiseId = "55555555-5555-4555-8555-555555555555";
  const scope = { epochId };
  const envelope = { request: {}, scope };
  hooks.verify.mockReturnValue(envelope);

  const execute = vi
    .fn()
    .mockResolvedValueOnce([
      {
        envelope,
        content_signature: "immutable-signature",
        solver_id: solverId,
        promise_id: promiseId,
      },
    ])
    .mockResolvedValueOnce([{ id: epochId }])
    .mockResolvedValueOnce([{ id: campaignId }])
    .mockResolvedValueOnce([
      {
        engine_job_id: null,
        status: "pending",
        engine_state: null,
        completed_cases: 0,
        request_payload: { engineRequest: {}, progressive: scope },
      },
    ])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([]);
  const db = {
    execute,
    transaction: (run: (connection: DB) => Promise<unknown>) =>
      run({ execute } as unknown as DB),
  } as unknown as DB;

  await expect(applyProgressiveRemoteProgress(db, executionId)).resolves.toEqual({
    kind: "idle",
  });

  const dialect = new PgDialect();
  const queries = execute.mock.calls.map(([query]) => dialect.sqlToQuery(query).sql);
  const epochIndex = queries.findIndex((query) => query.includes("FROM calculation_epochs"));
  const campaignIndex = queries.findIndex((query) => query.includes("FROM sim_campaigns"));
  const jobIndex = queries.findIndex((query) => query.includes("FROM sim_jobs"));
  expect(epochIndex).toBeGreaterThanOrEqual(0);
  expect(campaignIndex).toBeGreaterThan(epochIndex);
  expect(jobIndex).toBeGreaterThan(campaignIndex);
  expect(queries[epochIndex]).toContain("FOR SHARE");
  const campaignQuery = queries[campaignIndex];
  expect(campaignQuery).toContain("FOR UPDATE OF campaign");
  expect(campaignQuery).not.toContain("SKIP LOCKED");

  expect(queries[jobIndex]).toContain("FOR UPDATE");
});

it("uses a contiguous receipt prefix to bound retained report history", async () => {
  const executionId = "11111111-1111-4111-8111-111111111111";
  const execute = vi
    .fn()
    .mockResolvedValueOnce([
      { min_sequence: "1", max_sequence: "17535", receipt_count: "17535" },
    ])
    .mockResolvedValueOnce([{ sequence: "17536" }]);
  const db = { execute } as unknown as DB;

  await expect(
    selectPendingProgressiveRemoteReport(db, executionId),
  ).resolves.toEqual([{ sequence: "17536" }]);

  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(execute.mock.calls[1][0]).sql;
  expect(query).toContain(" > $2::bigint");
  expect(query).toContain("ORDER BY");
  expect(query).toContain("stopProof,execution_stopped");
  expect(query).not.toContain("NOT EXISTS");
});

it("falls back to the exact anti-join for a non-prefix receipt history", async () => {
  const executionId = "11111111-1111-4111-8111-111111111111";
  const execute = vi
    .fn()
    .mockResolvedValueOnce([
      { min_sequence: "1", max_sequence: "3", receipt_count: "2" },
    ])
    .mockResolvedValueOnce([{ sequence: "2" }]);
  const db = { execute } as unknown as DB;

  await expect(
    selectPendingProgressiveRemoteReport(db, executionId),
  ).resolves.toEqual([{ sequence: "2" }]);

  const dialect = new PgDialect();
  const query = dialect.sqlToQuery(execute.mock.calls[1][0]).sql;
  expect(query).toContain("NOT EXISTS");
  expect(query).toContain("ORDER BY");
  expect(query).toContain("stopProof,execution_stopped");
  expect(query).not.toContain(" > $2::bigint");
});
