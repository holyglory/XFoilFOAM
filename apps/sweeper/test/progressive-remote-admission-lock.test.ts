import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, expect, it, vi } from "vitest";
import type { DB } from "@aerodb/db";
import { OPENCFD_2606_ENGINE } from "@aerodb/engine-client";

const hooks = vi.hoisted(() => ({
  bind: vi.fn(),
  claim: vi.fn(),
  compose: vi.fn(),
  reserved: vi.fn(),
  active: vi.fn(),
}));

vi.mock("@aerodb/db", async () => {
  const actual =
    await vi.importActual<typeof import("@aerodb/db")>("@aerodb/db");
  return {
    ...actual,
    bindProgressiveRemoteDispatch: hooks.bind,
    claimProgressiveCfdBatch: hooks.claim,
    progressiveRemoteAdmissionReservedSlots: hooks.reserved,
    progressiveRemoteActivePromiseCount: hooks.active,
  };
});

vi.mock("../src/progressive-cfd-jobs", () => ({
  composeProgressiveCfdJob: hooks.compose,
}));

import { prepareProgressiveRemoteDispatch } from "../src/progressive-remote-admission";

afterEach(() => vi.resetAllMocks());

it.each([
  ["55P03", "canceling statement due to lock timeout", "lock_timeout", true],
  ["55P03", "could not obtain lock on row", "lock_not_available", true],
  ["40P01", "deadlock detected", "deadlock", true],
  ["57014", "canceling statement due to statement timeout", "statement_timeout", false],
  ["57014", "canceling statement due to user request", "user_cancellation", false],
  ["57014", "sensitive driver detail", "query_cancellation", false],
] as const)("retains the safe PostgreSQL cause for %s %s", async (sqlstate, message, reason, retry) => {
  const pg = Object.assign(new Error(message), { code: sqlstate });
  const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: "epoch", backend_pid: 731 }])
    .mockRejectedValueOnce(new Error("sensitive bound SQL", { cause: pg }));
  const connection = { transaction: (run: (db: DB) => Promise<unknown>) => run({ execute } as unknown as DB) } as unknown as DB;
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const outcome = await prepareProgressiveRemoteDispatch(connection, "11111111-1111-4111-8111-111111111111");
    expect(outcome.kind).toBe("waiting");
    expect(outcome.kind === "waiting" && outcome.retryableContention === true).toBe(retry);
    expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({ sqlstate, reason, phase: "transaction setup", postgresBackendPid: 731 });
    expect(JSON.stringify([log.mock.calls, outcome])).not.toContain("sensitive");
  } finally {
    log.mockRestore();
  }
});

it("does not hold the solver row lock while a candidate claim is running", async () => {
  const solverId = "11111111-1111-4111-8111-111111111111";
  const epochId = "22222222-2222-4222-8222-222222222222";
  const airfoilId = "33333333-3333-4333-8333-333333333333";
  const revisionId = "44444444-4444-4444-8444-444444444444";
  const jobId = "55555555-5555-4555-8555-555555555555";
  const observedAt = new Date().toISOString();
  const capabilities = {
    version: 1,
    solverBudgetVersion: 2,
    meshRecoveryVersion: 1,
    uransRecoveryVersion: null,
    engine: { ...OPENCFD_2606_ENGINE },
    executionPools: ["progressive-pool"],
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: epochId }])
    .mockResolvedValueOnce([
      {
        enabled: true,
        admission_fence_active: false,
        disk_admission_blocked: false,
      },
    ])
    .mockResolvedValueOnce([{ enabled: true, remote_solver_enabled: false }])
    .mockResolvedValueOnce([{ can_fetch: true }])
    .mockResolvedValueOnce([
      {
        id: solverId,
        instance_id: "solver-instance",
        instance_name: "isolated solver",
        public_endpoint: "https://solver.example",
        cpu_capacity: 4,
        cpu_budget: 4,
        max_active_polar_promises: 4,
        metadata: {
          progressiveExecution: capabilities,
          progressiveExecutionObservedAt: observedAt,
        },
        checked_at: new Date(observedAt),
      },
    ])
    .mockResolvedValueOnce([
      { airfoil_id: airfoilId, simulation_preset_revision_id: revisionId },
    ])
    .mockResolvedValue([]);
  const db = {
    execute,
    transaction: (run: (connection: DB) => Promise<unknown>) =>
      run({ execute } as unknown as DB),
  } as unknown as DB;
  const lease = { alpha: 0 };
  let releaseClaim: () => void = () => {};
  let claimStarted: () => void = () => {};
  const claimReleased = new Promise<void>((resolve) => {
    releaseClaim = resolve;
  });
  const claimObserved = new Promise<void>((resolve) => {
    claimStarted = resolve;
  });
  hooks.active.mockResolvedValue(0);
  hooks.reserved.mockResolvedValue(0);
  hooks.claim.mockImplementation(async () => {
    claimStarted();
    await claimReleased;
    return [lease];
  });
  hooks.compose.mockResolvedValue({
    jobId,
    request: {
      expected_engine: { ...OPENCFD_2606_ENGINE },
      expected_execution_pool: "progressive-pool",
    },
  });
  const envelope = {} as never;
  hooks.bind.mockResolvedValue({ replayed: false, envelope });

  const running = prepareProgressiveRemoteDispatch(db, solverId);
  await claimObserved;

  const solverQuery = new PgDialect().sqlToQuery(execute.mock.calls[4][0]).sql;
  expect(solverQuery).not.toContain("FOR UPDATE");

  releaseClaim();
  await expect(running).resolves.toEqual({ kind: "prepared", envelope });
  expect(hooks.bind).toHaveBeenCalledOnce();
  expect(hooks.claim).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({ campaignLockMode: "skip" }),
  );
});

it("keeps the transaction bounds when a nonblocking campaign claim skips a busy row", async () => {
  const solverId = "11111111-1111-4111-8111-111111111111";
  const epochId = "22222222-2222-4222-8222-222222222222";
  const airfoilId = "33333333-3333-4333-8333-333333333333";
  const revisionId = "44444444-4444-4444-8444-444444444444";
  const jobId = "55555555-5555-4555-8555-555555555555";
  const observedAt = new Date().toISOString();
  const capabilities = {
    version: 1,
    solverBudgetVersion: 2,
    meshRecoveryVersion: 1,
    uransRecoveryVersion: null,
    engine: { ...OPENCFD_2606_ENGINE },
    executionPools: ["progressive-pool"],
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: epochId }])
    .mockResolvedValueOnce([
      { enabled: true, admission_fence_active: false, disk_admission_blocked: false },
    ])
    .mockResolvedValueOnce([{ enabled: true, remote_solver_enabled: false }])
    .mockResolvedValueOnce([{ can_fetch: true }])
    .mockResolvedValueOnce([
      {
        id: solverId,
        instance_id: "solver-instance",
        instance_name: "isolated solver",
        public_endpoint: "https://solver.example",
        cpu_capacity: 4,
        cpu_budget: 4,
        max_active_polar_promises: 4,
        metadata: { progressiveExecution: capabilities, progressiveExecutionObservedAt: observedAt },
        checked_at: new Date(observedAt),
      },
    ])
    .mockResolvedValueOnce([{ airfoil_id: airfoilId, simulation_preset_revision_id: revisionId }])
    .mockResolvedValue([]);
  const db = {
    execute,
    transaction: (run: (connection: DB) => Promise<unknown>) =>
      run({ execute } as unknown as DB),
  } as unknown as DB;
  const lease = { alpha: 0 };
  hooks.active.mockResolvedValue(0);
  hooks.reserved.mockResolvedValue(0);
  hooks.claim
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([lease]);
  hooks.compose.mockResolvedValue({
    jobId,
    request: {
      expected_engine: { ...OPENCFD_2606_ENGINE },
      expected_execution_pool: "progressive-pool",
    },
  });
  hooks.bind.mockResolvedValue({ replayed: false, envelope: {} as never });

  await expect(prepareProgressiveRemoteDispatch(db, solverId)).resolves.toMatchObject({
    kind: "prepared",
  });
  expect(hooks.claim).toHaveBeenNthCalledWith(
    1,
    expect.anything(),
    expect.objectContaining({ campaignLockMode: "skip" }),
  );
  expect(hooks.claim).toHaveBeenNthCalledWith(
    2,
    expect.anything(),
    expect.objectContaining({ campaignLockMode: "wait" }),
  );
  const timeouts = execute.mock.calls.map(([statement]) => new PgDialect().sqlToQuery(statement).sql)
    .filter((statement) => /lock_timeout|statement_timeout/.test(statement));
  expect(timeouts).toEqual(["SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'; SET LOCAL jit = off"]);
});

it("defers exact cells owned by another active promise before inserting a successor", async () => {
  const solverId = "11111111-1111-4111-8111-111111111111";
  const epochId = "22222222-2222-4222-8222-222222222222";
  const airfoilId = "33333333-3333-4333-8333-333333333333";
  const revisionId = "44444444-4444-4444-8444-444444444444";
  const jobId = "55555555-5555-4555-8555-555555555555";
  const observedAt = new Date().toISOString();
  const capabilities = {
    version: 1,
    solverBudgetVersion: 2,
    meshRecoveryVersion: 1,
    uransRecoveryVersion: null,
    engine: { ...OPENCFD_2606_ENGINE },
    executionPools: ["progressive-pool"],
  };
  const execute = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ id: epochId }])
    .mockResolvedValueOnce([
      { enabled: true, admission_fence_active: false, disk_admission_blocked: false },
    ])
    .mockResolvedValueOnce([{ enabled: true, remote_solver_enabled: false }])
    .mockResolvedValueOnce([{ can_fetch: true }])
    .mockResolvedValueOnce([
      {
        id: solverId,
        instance_id: "solver-instance",
        instance_name: "isolated solver",
        public_endpoint: "https://solver.example",
        cpu_capacity: 4,
        cpu_budget: 4,
        max_active_polar_promises: 4,
        metadata: {
          progressiveExecution: capabilities,
          progressiveExecutionObservedAt: observedAt,
        },
        checked_at: new Date(observedAt),
      },
    ])
    .mockResolvedValueOnce([
      { airfoil_id: airfoilId, simulation_preset_revision_id: revisionId },
    ])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ aoa_deg: 0 }])
    .mockResolvedValue([]);
  const db = {
    execute,
    transaction: (run: (connection: DB) => Promise<unknown>) =>
      run({ execute } as unknown as DB),
  } as unknown as DB;
  const lease = { alpha: 0 };
  hooks.active.mockResolvedValue(0);
  hooks.reserved.mockResolvedValue(0);
  hooks.claim.mockResolvedValue([lease]);
  hooks.compose.mockResolvedValue({
    jobId,
    request: {
      expected_engine: { ...OPENCFD_2606_ENGINE },
      expected_execution_pool: "progressive-pool",
    },
  });

  await expect(prepareProgressiveRemoteDispatch(db, solverId)).resolves.toEqual({
    kind: "waiting",
    reason: "Owned result cells deferred for another preparation opportunity",
    deferredUnits: 0,
  });
  expect(hooks.bind).not.toHaveBeenCalled();
  const statements = execute.mock.calls.map(([query]) =>
    new PgDialect().sqlToQuery(query).sql,
  );
  expect(statements.some((statement) => statement.includes("INSERT INTO sync_sweep_promises"))).toBe(false);
});
