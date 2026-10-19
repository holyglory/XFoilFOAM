import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, expect, it, vi } from "vitest";
import type { DB } from "@aerodb/db";

const hooks = vi.hoisted(() => ({
  verify: vi.fn(),
}));

vi.mock("@aerodb/db", async (original) => ({
  ...(await original<typeof import("@aerodb/db")>()),
  verifyProgressiveRemoteExecution: hooks.verify,
}));

import { applyProgressiveRemoteProgress } from "../src/progressive-remote-progress";

afterEach(() => vi.resetAllMocks());

it("projects an immutable remote report without taking the campaign lock", async () => {
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
  const campaignQuery = dialect.sqlToQuery(execute.mock.calls[2][0]).sql;
  expect(campaignQuery).toContain("FROM sim_campaigns");
  expect(campaignQuery).not.toContain("FOR UPDATE");
  expect(campaignQuery).not.toContain("SKIP LOCKED");

  const jobQuery = dialect.sqlToQuery(execute.mock.calls[3][0]).sql;
  expect(jobQuery).toContain("FROM sim_jobs");
  expect(jobQuery).toContain("FOR UPDATE");
});
