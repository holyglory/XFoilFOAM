import { describe, expect, it, vi } from "vitest";
import { OPENCFD_2606_ENGINE, type EngineClient } from "@aerodb/engine-client";
import type { DB } from "@aerodb/db";
import { parseProgressiveRemoteCapabilities } from "../src/progressive-remote-admission";
import {
  progressiveWorkerCapabilityMetadata,
  refreshProgressiveWorkerCapabilities,
} from "../src/progressive-worker-capabilities";

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
