import type { EngineClient } from "@aerodb/engine-client";
import { describe, expect, it } from "vitest";

import {
  engineMeshRecoveryVersion,
  engineUransRecoveryVersion,
  supportsDurableUransRecovery,
} from "../src/engine-capabilities";

describe("engine mesh-recovery capability handshake", () => {
  it("accepts a monotonic non-negative integer advertised by live health", async () => {
    const engine = {
      healthDetails: async () => ({
        status: "ok",
        version: "test",
        mesh_recovery_version: 2,
      }),
    } as unknown as EngineClient;
    await expect(engineMeshRecoveryVersion(engine)).resolves.toBe(2);
  });

  it("treats a successful legacy health response as strategy version zero", async () => {
    const engine = {
      healthDetails: async () => ({ status: "ok", version: "legacy" }),
    } as unknown as EngineClient;
    await expect(engineMeshRecoveryVersion(engine)).resolves.toBe(0);
  });

  it("keeps structural test engines without healthDetails on legacy version zero", async () => {
    await expect(
      engineMeshRecoveryVersion({} as unknown as EngineClient),
    ).resolves.toBe(0);
  });

  it.each([-1, 1.5, Number.NaN, "1", null, 2_147_483_648])(
    "fails closed on malformed advertised version %p",
    async (meshRecoveryVersion) => {
      const engine = {
        healthDetails: async () => ({
          status: "ok",
          version: "malformed",
          mesh_recovery_version: meshRecoveryVersion,
        }),
      } as unknown as EngineClient;
      await expect(engineMeshRecoveryVersion(engine)).resolves.toBeNull();
    },
  );

  it.each([null, "ok", 1, [], { status: "ok" }, { version: "test" }])(
    "fails closed on malformed health response %p",
    async (health) => {
      const engine = {
        healthDetails: async () => health,
      } as unknown as EngineClient;
      await expect(engineMeshRecoveryVersion(engine)).resolves.toBeNull();
    },
  );

  it("returns unknown when the capability probe cannot answer", async () => {
    const engine = {
      healthDetails: async () => {
        throw new Error("health timeout");
      },
    } as unknown as EngineClient;
    await expect(engineMeshRecoveryVersion(engine)).resolves.toBeNull();
  });
});

describe("engine durable URANS-recovery capability handshake", () => {
  it("accepts the explicit recovery contract advertised by live health", async () => {
    const engine = {
      healthDetails: async () => ({
        status: "ok",
        version: "test",
        urans_recovery_version: 1,
      }),
    } as unknown as EngineClient;
    await expect(engineUransRecoveryVersion(engine)).resolves.toBe(1);
    expect(supportsDurableUransRecovery(1)).toBe(true);
  });

  it("treats the rolling-cutover legacy engine as version zero even when mesh recovery is v1", async () => {
    const engine = {
      healthDetails: async () => ({
        status: "ok",
        version: "legacy-2406",
        mesh_recovery_version: 1,
      }),
    } as unknown as EngineClient;
    await expect(engineMeshRecoveryVersion(engine)).resolves.toBe(1);
    await expect(engineUransRecoveryVersion(engine)).resolves.toBe(0);
    expect(supportsDurableUransRecovery(0)).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN, "1", null, 2_147_483_648])(
    "fails closed on malformed advertised recovery version %p",
    async (uransRecoveryVersion) => {
      const engine = {
        healthDetails: async () => ({
          status: "ok",
          version: "malformed",
          urans_recovery_version: uransRecoveryVersion,
        }),
      } as unknown as EngineClient;
      await expect(engineUransRecoveryVersion(engine)).resolves.toBeNull();
    },
  );
});
