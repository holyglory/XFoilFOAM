import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { describe, expect, it } from "vitest";

import {
  engineMeshRecoveryVersion,
  engineUransRecoveryVersion,
  supportsDurableUransRecovery,
} from "../src/engine-capabilities";
import { remoteAdmissionDecisionForTick, submitOneBatch } from "../src/loop";

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

  it("holds the ordinary RANS admission boundary when the live capability is unknown", async () => {
    let submissions = 0;
    const engine = {
      submitPolar: async () => {
        submissions += 1;
        throw new Error("unknown capability must not reach the engine");
      },
    } as unknown as EngineClient;
    // The null check is intentionally before every DB/gap query. Besides
    // proving no engine call, the structural DB stub pins that fail-closed
    // boundary so null cannot be silently coerced back to legacy version 0.
    await expect(submitOneBatch({} as DB, engine, 0, null)).resolves.toBe(
      false,
    );
    expect(submissions).toBe(0);
  });
});

describe("engine durable URANS-recovery capability handshake", () => {
  it("accepts the version-2 recovery contract advertised by live health", async () => {
    const engine = {
      healthDetails: async () => ({
        status: "ok",
        version: "test",
        urans_recovery_version: 2,
      }),
    } as unknown as EngineClient;
    await expect(engineUransRecoveryVersion(engine)).resolves.toBe(2);
    expect(supportsDurableUransRecovery(2)).toBe(true);
  });

  it("parses version 1 but keeps version-2 continuation and corrective recovery closed", async () => {
    const engine = {
      healthDetails: async () => ({
        status: "ok",
        version: "cross-job-recovery-v1",
        urans_recovery_version: 1,
      }),
    } as unknown as EngineClient;
    await expect(engineUransRecoveryVersion(engine)).resolves.toBe(1);
    expect(supportsDurableUransRecovery(1)).toBe(false);
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
    expect(supportsDurableUransRecovery(null)).toBe(false);
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

describe("remote NEW-admission lane precedence", () => {
  const open = {
    admissionFenced: false,
    diskAllowed: true,
    fastUransSubmitted: false,
    sharedCapacityAvailable: true,
    engineHealthy: true,
    meshRecoveryVersion: 4,
  };

  it("keeps safety-stop provenance ahead of simultaneous storage pressure", () => {
    expect(
      remoteAdmissionDecisionForTick({
        ...open,
        admissionFenced: true,
        diskAllowed: false,
      }),
    ).toEqual({ kind: "hold", reason: "safety_stop" });
  });

  it("holds mirrored RANS after FAST consumes the one admission opportunity", () => {
    expect(
      remoteAdmissionDecisionForTick({
        ...open,
        fastUransSubmitted: true,
      }),
    ).toEqual({ kind: "hold", reason: "higher_priority_fast_urans" });
  });

  it("holds mixed-mode remote RANS while shared capacity is full", () => {
    expect(
      remoteAdmissionDecisionForTick({
        ...open,
        sharedCapacityAvailable: false,
      }),
    ).toEqual({ kind: "hold", reason: "shared_capacity_full" });
  });

  it("fails closed on unknown mesh capability but allows and preserves a known version", () => {
    expect(
      remoteAdmissionDecisionForTick({
        ...open,
        meshRecoveryVersion: null,
      }),
    ).toEqual({ kind: "hold", reason: "mesh_capability_unknown" });
    expect(remoteAdmissionDecisionForTick(open)).toEqual({
      kind: "allow",
      meshRecoveryVersion: 4,
    });
  });
});
