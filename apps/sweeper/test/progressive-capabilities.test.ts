import type { EngineClient } from "@aerodb/engine-client";
import { describe, expect, it } from "vitest";
import { engineProgressiveCapabilities } from "../src/engine-capabilities";

describe("progressive allocation capability", () => {
  it("reads unsteady and allocation contracts from one actual health observation", async () => {
    let calls = 0;
    const engine = {
      healthDetails: async () => {
        calls += 1;
        return {
          status: "ok",
          version: "test",
          urans_recovery_version: 14,
          solver_budget_version: 2,
        };
      },
    } as unknown as EngineClient;
    expect(await engineProgressiveCapabilities(engine)).toEqual({
      uransRecoveryVersion: 14,
      solverBudgetVersion: 2,
    });
    expect(calls).toBe(1);
  });

  it.each([null, "2", 2.5, -1, Infinity])(
    "does not accept malformed allocation capability %s",
    async (version) => {
      const engine = {
        healthDetails: async () => ({
          status: "ok",
          version: "test",
          solver_budget_version: version,
        }),
      } as unknown as EngineClient;
      expect(await engineProgressiveCapabilities(engine)).toEqual({
        uransRecoveryVersion: 0,
        solverBudgetVersion: null,
      });
    },
  );

  it("keeps missing capability legacy and failed observations unknown", async () => {
    expect(
      await engineProgressiveCapabilities({
        healthDetails: async () => ({ status: "ok", version: "old" }),
      } as unknown as EngineClient),
    ).toEqual({ uransRecoveryVersion: 0, solverBudgetVersion: 0 });
    expect(
      await engineProgressiveCapabilities({
        healthDetails: async () => {
          throw new Error("offline");
        },
      } as unknown as EngineClient),
    ).toEqual({ uransRecoveryVersion: null, solverBudgetVersion: null });
  });
});
