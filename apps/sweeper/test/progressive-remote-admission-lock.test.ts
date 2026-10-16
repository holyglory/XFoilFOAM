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
    .mockResolvedValueOnce([{ acquired: true }])
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
    expect.objectContaining({ campaignLockMode: "wait" }),
  );
});
