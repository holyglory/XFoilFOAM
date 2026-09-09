import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { PgDialect } from "drizzle-orm/pg-core";

const hooks = vi.hoisted(() => ({ submit: vi.fn(), observe: vi.fn() }));
vi.mock("../src/progressive-remote-submission", () => ({
  submitProgressiveRemoteJob: hooks.submit,
}));
vi.mock("../src/progressive-remote-observation", () => ({
  observeProgressiveRemoteJob: hooks.observe,
}));
vi.mock("../src/engine-backoff", () => ({
  engineBackoffActive: () => false,
  clearEngineUnreachable: vi.fn(),
  recordEngineUnreachable: vi.fn(),
}));

import { admitRemoteSolverTick } from "../src/remote-solver";

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "");
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_REMOTE_ONLY", "false");
  vi.stubEnv(
    "ENGINE_CONTROL_PLANE_TOKEN",
    "parallel-admission-isolated-fixture-token",
  );
  vi.stubEnv("SWEEPER_ACTIVE_RECONCILE_CONCURRENCY", "4");
});
afterEach(() => vi.unstubAllEnvs());

function fixture(reserved = 0) {
  const settings = {
    id: 1,
    remoteSolverEnabled: true,
    upstreamBaseUrl: "https://hub.example/api/sync/v1",
    remoteSolverRegisteredId: randomUUID(),
    remoteSolverAuthToken: "fixture",
    remoteSolverCpuBudget: 4,
  };
  const jobs = Array.from({ length: 4 }, () => ({ id: randomUUID() }));
  const expectedIds = jobs.map((job) => job.id);
  const updates: Record<string, unknown>[] = [];
  const dialect = new PgDialect();
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [settings] }) }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: async () => [] };
      },
    }),
    execute: async (statement: Parameters<DB["execute"]>[0]) => {
      const query = dialect.sqlToQuery(
        statement as Parameters<PgDialect["sqlToQuery"]>[0],
      );
      if (query.sql.includes("SUM(GREATEST(job.admission_cpu_slots"))
        return [{ slots: Math.max(reserved, hooks.submit.mock.calls.length) }];
      if (query.sql.includes("SELECT job.id FROM sim_jobs job")) {
        const limit = Number(query.params.at(-1));
        expect(limit).toBeGreaterThan(0);
        expect(limit).toBeLessThanOrEqual(8);
        return jobs.splice(0, limit);
      }
      throw new Error("Unexpected admission query in isolated fixture");
    },
  } as unknown as DB;
  return { db, expectedIds, updates, engine: {} as EngineClient };
}

it("starts independent authorization requests without waiting for the first slow response", async () => {
  const scope = fixture();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  hooks.submit.mockImplementation(async () => {
    await gate;
    return { kind: "submitted" };
  });
  const running = admitRemoteSolverTick(scope.db, scope.engine, {
    kind: "allow",
    meshRecoveryVersion: 1,
  });
  try {
    await vi.waitFor(() => expect(hooks.submit).toHaveBeenCalledTimes(4));
  } finally {
    release();
    await running;
  }
  expect(hooks.submit.mock.calls.map((call) => call[2])).toEqual(
    scope.expectedIds,
  );
  expect(hooks.observe).not.toHaveBeenCalled();
});

it("honors the existing configured single-request concurrency", async () => {
  vi.stubEnv("SWEEPER_ACTIVE_RECONCILE_CONCURRENCY", "1");
  const scope = fixture();
  let active = 0;
  let maximum = 0;
  hooks.submit.mockImplementation(async () => {
    active += 1;
    maximum = Math.max(maximum, active);
    await Promise.resolve();
    active -= 1;
    return { kind: "submitted" };
  });
  expect(
    await admitRemoteSolverTick(scope.db, scope.engine, {
      kind: "allow",
      meshRecoveryVersion: 1,
    }),
  ).toBe(true);
  expect(maximum).toBe(1);
  expect(hooks.submit.mock.calls.map((call) => call[2])).toEqual(
    scope.expectedIds,
  );
});

it("retains full-capacity and safety holds before issuing any request", async () => {
  const full = fixture(4);
  expect(
    await admitRemoteSolverTick(full.db, full.engine, {
      kind: "allow",
      meshRecoveryVersion: 1,
    }),
  ).toBe(false);
  const held = fixture();
  expect(
    await admitRemoteSolverTick(held.db, held.engine, {
      kind: "hold",
      reason: "safety_stop",
    }),
  ).toBe(false);
  expect(hooks.submit).not.toHaveBeenCalled();
});

it("queues rejected starts without waiting for a blocked stop endpoint or claiming stop proof", async () => {
  const scope = fixture();
  hooks.submit.mockResolvedValue({
    kind: "stop_required",
    reason: "expired exact authorization",
  });
  hooks.observe.mockImplementation(() => new Promise(() => {}));
  expect(
    await admitRemoteSolverTick(scope.db, scope.engine, {
      kind: "allow",
      meshRecoveryVersion: 1,
    }),
  ).toBe(false);
  expect(hooks.observe).not.toHaveBeenCalled();
  expect(
    scope.updates.filter((update) => update.engineState === "cancel_pending"),
  ).toHaveLength(4);
  expect(
    scope.updates.filter((update) => update.engineState === "cancelled"),
  ).toHaveLength(0);
  expect(new Set(hooks.submit.mock.calls.map((call) => call[2])).size).toBe(4);
});
