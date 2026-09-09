import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENCFD_2606_ENGINE, type EngineClient } from "@aerodb/engine-client";
import type { DB } from "@aerodb/db";
import { parseProgressiveRemoteCapabilities } from "../src/progressive-remote-admission";
import {
  progressiveWorkerCapabilityMetadata,
  refreshProgressiveWorkerCapabilities,
  runProgressiveWorkerCapabilityService,
} from "../src/progressive-worker-capabilities";

vi.mock("node:timers/promises", () => ({
  setTimeout: (
    milliseconds: number,
    value: unknown,
    options: { signal: AbortSignal },
  ) =>
    new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", finish);
        if (options.signal.aborted) reject(new Error("aborted"));
        else resolve(value);
      };
      const timer = setTimeout(finish, milliseconds);
      options.signal.addEventListener("abort", finish, { once: true });
      if (options.signal.aborted) finish();
    }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function serviceFixture() {
  const execute = vi.fn().mockResolvedValue([{ remote_solver_enabled: true }]);
  const db = { execute } as unknown as DB;
  const healthDetails = vi.fn().mockResolvedValue({
    status: "ok",
    solver_budget_version: 2,
    mesh_recovery_version: 1,
    urans_recovery_version: 14,
    supported_engines: [OPENCFD_2606_ENGINE],
  });
  const inventory = vi.fn().mockResolvedValue({
    solver_budget_version: 2,
    default_engine: OPENCFD_2606_ENGINE,
    engines: [
      {
        engine: OPENCFD_2606_ENGINE,
        routing_key: "isolated-pool",
        analysis_methods: ["rans"],
        steady: true,
        transient: true,
        mesh_evidence: true,
        volume_fields: true,
        stored_media: true,
        custom_field_rendering: true,
        multi_element_geometry: false,
        supported_turbulence_models: ["kOmegaSST"],
        supported_image_fields: ["pressure"],
      },
    ],
  });
  return {
    db,
    execute,
    healthDetails,
    inventory,
    engine: {
      healthDetails,
      capabilities: inventory,
    } as unknown as EngineClient,
  };
}

it("refreshes remote eligibility beyond sixty seconds without a controller tick and stops cleanly", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const fixture = serviceFixture();
  const owner = new AbortController();
  const running = runProgressiveWorkerCapabilityService(
    fixture.db,
    fixture.engine,
    owner.signal,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(
    progressiveWorkerCapabilityMetadata(fixture.db).progressiveExecution,
  ).toEqual(capabilities());
  const first = progressiveWorkerCapabilityMetadata(
    fixture.db,
  ).progressiveExecutionObservedAt;
  await vi.advanceTimersByTimeAsync(70000);
  expect(fixture.healthDetails).toHaveBeenCalledTimes(3);
  expect(
    progressiveWorkerCapabilityMetadata(fixture.db).progressiveExecution,
  ).toEqual(capabilities());
  expect(
    progressiveWorkerCapabilityMetadata(fixture.db)
      .progressiveExecutionObservedAt,
  ).not.toBe(first);
  owner.abort();
  await running;
  await vi.advanceTimersByTimeAsync(60000);
  expect(fixture.healthDetails).toHaveBeenCalledTimes(3);
});

it("clears eligibility when the role is disabled without probing the engine", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const fixture = serviceFixture();
  await refreshProgressiveWorkerCapabilities(fixture.db, fixture.engine);
  fixture.execute.mockResolvedValue([{ remote_solver_enabled: false }]);
  const owner = new AbortController();
  const running = runProgressiveWorkerCapabilityService(
    fixture.db,
    fixture.engine,
    owner.signal,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(
    progressiveWorkerCapabilityMetadata(fixture.db).progressiveExecution,
  ).toBeNull();
  expect(fixture.healthDetails).toHaveBeenCalledOnce();
  owner.abort();
  await running;
});

it("bounds a slow observation, shares concurrent refreshes and ignores a late response", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const fixture = serviceFixture();
  await refreshProgressiveWorkerCapabilities(fixture.db, fixture.engine);
  await vi.advanceTimersByTimeAsync(30001);
  let release: (value: unknown) => void = () => {};
  fixture.healthDetails.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = refreshProgressiveWorkerCapabilities(
    fixture.db,
    fixture.engine,
  );
  const second = refreshProgressiveWorkerCapabilities(
    fixture.db,
    fixture.engine,
  );
  await vi.advanceTimersByTimeAsync(4999);
  expect(fixture.healthDetails).toHaveBeenCalledTimes(2);
  expect(
    progressiveWorkerCapabilityMetadata(fixture.db).progressiveExecution,
  ).not.toBeNull();
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all([first, second]);
  expect(
    progressiveWorkerCapabilityMetadata(fixture.db).progressiveExecution,
  ).toBeNull();
  release({
    status: "ok",
    solver_budget_version: 2,
    mesh_recovery_version: 1,
    urans_recovery_version: 14,
    supported_engines: [OPENCFD_2606_ENGINE],
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(
    progressiveWorkerCapabilityMetadata(fixture.db).progressiveExecution,
  ).toBeNull();
});
it("drains a bounded in-flight observation during shutdown without scheduling another probe", async () => {
  vi.useFakeTimers();
  vi.spyOn(performance, "now").mockImplementation(() => Date.now());
  const fixture = serviceFixture();
  fixture.healthDetails.mockImplementation(() => new Promise(() => {}));
  const owner = new AbortController();
  let finished = false;
  const running = runProgressiveWorkerCapabilityService(
    fixture.db,
    fixture.engine,
    owner.signal,
  ).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(1000);
  owner.abort();
  await vi.advanceTimersByTimeAsync(3999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await running;
  expect(finished).toBe(true);
  expect(
    progressiveWorkerCapabilityMetadata(fixture.db).progressiveExecution,
  ).toBeNull();
  await vi.advanceTimersByTimeAsync(60000);
  expect(fixture.healthDetails).toHaveBeenCalledOnce();
});

function capabilities() {
  return {
    version: 1,
    solverBudgetVersion: 2,
    meshRecoveryVersion: 1,
    uransRecoveryVersion: 14,
    engine: { ...OPENCFD_2606_ENGINE },
    executionPools: ["isolated-pool"],
  };
}

describe("remote progressive capability admission", () => {
  it("advertises only fresh observed gateway capabilities and clears them after a failed refresh", async () => {
    const db = {} as DB;
    let now = 1000;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const healthDetails = vi.fn(async () => ({
      status: "ok",
      version: "fixture",
      solver_budget_version: 2,
      mesh_recovery_version: 1,
      urans_recovery_version: 14,
      supported_engines: [OPENCFD_2606_ENGINE],
    }));
    const inventory = vi.fn(async () => ({
      solver_budget_version: 2,
      default_engine: OPENCFD_2606_ENGINE,
      engines: [
        {
          engine: OPENCFD_2606_ENGINE,
          routing_key: "isolated-pool",
          analysis_methods: ["rans"],
          steady: true,
          transient: true,
          mesh_evidence: true,
          volume_fields: true,
          stored_media: true,
          custom_field_rendering: true,
          multi_element_geometry: false,
          supported_turbulence_models: ["kOmegaSST"],
          supported_image_fields: ["pressure"],
        },
      ],
    }));
    const engine = {
      healthDetails,
      capabilities: inventory,
    } as unknown as EngineClient;
    try {
      expect(
        progressiveWorkerCapabilityMetadata(db).progressiveExecution,
      ).toBeNull();
      await Promise.all([
        refreshProgressiveWorkerCapabilities(db, engine),
        refreshProgressiveWorkerCapabilities(db, engine),
      ]);
      expect(healthDetails).toHaveBeenCalledTimes(1);
      expect(inventory).toHaveBeenCalledWith({ timeoutMs: 5000 });
      expect(
        progressiveWorkerCapabilityMetadata(db).progressiveExecution,
      ).toEqual(capabilities());
      const sampledAt =
        progressiveWorkerCapabilityMetadata(db).progressiveExecutionObservedAt;
      expect(Number.isFinite(Date.parse(sampledAt!))).toBe(true);
      now += 30001;
      healthDetails.mockRejectedValueOnce(
        new Error("isolated gateway unavailable"),
      );
      await refreshProgressiveWorkerCapabilities(db, engine);
      expect(
        progressiveWorkerCapabilityMetadata(db).progressiveExecution,
      ).toBeNull();
      now += 30001;
      await refreshProgressiveWorkerCapabilities(db, engine);
      expect(
        progressiveWorkerCapabilityMetadata(db).progressiveExecution,
      ).not.toBeNull();
      now += 60000;
      expect(progressiveWorkerCapabilityMetadata(db)).toEqual({
        progressiveExecution: null,
        progressiveExecutionObservedAt: null,
      });
    } finally {
      clock.mockRestore();
    }
  });
  it("retains exact advertised capabilities without fabricating unsteady support", () => {
    const source = capabilities();
    const parsed = parseProgressiveRemoteCapabilities(source);
    expect(parsed).toEqual(source);
    source.executionPools[0] = "changed";
    source.engine.version = "other";
    expect(parsed?.executionPools).toEqual(["isolated-pool"]);
    expect(parsed?.engine.version).toBe("2606");
    expect(
      parseProgressiveRemoteCapabilities({
        ...capabilities(),
        uransRecoveryVersion: null,
      })?.uransRecoveryVersion,
    ).toBeNull();
  });

  it.each([
    null,
    undefined,
    {},
    [],
    { ...capabilities(), version: 2 },
    { ...capabilities(), solverBudgetVersion: 1 },
    { ...capabilities(), solverBudgetVersion: "2" },
    { ...capabilities(), meshRecoveryVersion: null },
    { ...capabilities(), meshRecoveryVersion: -1 },
    { ...capabilities(), meshRecoveryVersion: 1.5 },
    { ...capabilities(), uransRecoveryVersion: undefined },
    { ...capabilities(), uransRecoveryVersion: Infinity },
    { ...capabilities(), engine: { version: "2606" } },
    { ...capabilities(), executionPools: [] },
    { ...capabilities(), executionPools: [""] },
    { ...capabilities(), executionPools: ["pool", "pool"] },
    { ...capabilities(), executionPools: [null] },
    {
      ...capabilities(),
      executionPools: Array.from({ length: 17 }, (_, index) => `pool-${index}`),
    },
  ])(
    "withholds admission for malformed or ambiguous capabilities %#",
    (value) => {
      expect(parseProgressiveRemoteCapabilities(value)).toBeNull();
    },
  );
});
